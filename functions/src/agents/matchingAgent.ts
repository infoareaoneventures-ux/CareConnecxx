import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import {
  spawnExecutionAgent,
  getActiveAgentForUser,
  runExecutionAgentTurn,
  updateExecutionAgentContext,
} from "./executionAgent";
import { getRelevantFacts } from "../memory/learnedFacts";
import {
  buildMatchingSystemPrompt,
  scoreWithClaude,
  computeSkillsCoverage,
  detectDementiaCert,
  detectMedicalCred,
  CandidateSignals,
  ClaudeScoredMatch,
} from "../ai/claudeMatching";
import { getOutcomePatternSummary } from "../ai/outcomeAnalytics";
import { getReputationBoosts } from "../ai/caregiverReputation";
import { computeConfidenceScoreFromFields } from "./confidenceScore";
import { getAppUrl } from "../config/appUrl";
import { isSeededCaregiver } from "./actions/getCaregiverPreviewAction";

const db = admin.firestore();

interface CaregiverCandidate {
  id:                       string;
  name:                     string;
  rating?:                  number;
  hourlyRate:               number;
  specialties:              string[];
  city:                     string;
  yearsExperience:          number;
  availability?:            { days: string[]; hours: string };
  pendingBackgroundCheck?:  boolean;
  genderPreference?:        string;
  gender?:                  string;
  languages?:               string[];
  canDrive?:                boolean;
  backgroundCheckStatus?:   string;   // "clear" | "pending" | "consider" | "suspended"
  certifications?:          string[];
}

interface ScoreBreakdown {
  skillsMatch:        number;
  availabilityMatch:  number;
  personalityMatch:   number;
  distanceScore:      number;
  ratingScore:        number;
  rebookingRate:      number;
}

interface MatchScoreResult {
  overallScore: number;
  breakdown:    ScoreBreakdown;
  reasoning:    string[];
  confidence:   "high" | "medium" | "low";
}

/**
 * U7 — a caregiver is temporarily unavailable when they've paused their account
 * (vacation / break) or opted out. The SMS matching flow matches on weekly
 * pattern, not specific dates, so date-level conflicts are resolved downstream
 * at interview/booking time; this filter just stops a paused or opted-out
 * caregiver from being presented as if freshly available. Mirrors the same
 * pausedUntil skip used by the job-notification fan-out.
 */
export function isTemporarilyUnavailable(
  caregiver: { pausedUntil?: string; optedOut?: boolean },
  nowIso: string = new Date().toISOString(),
): boolean {
  if (caregiver.optedOut === true) return true;
  const pausedUntil = caregiver.pausedUntil;
  return !!pausedUntil && pausedUntil > nowIso;
}

/** Compute rule-based signals as a pre-filter before calling Claude. */
function computeRuleSignals(
  caregiver: CaregiverCandidate,
  intake: Record<string, unknown>
): { ruleScore: number; signals: CandidateSignals } {
  const needs       = (intake.careNeeds ?? []) as string[];
  const intakeCity  = ((intake.city  ?? "") as string).toLowerCase();
  const intakeZip   = ((intake.zipCode ?? "") as string);
  const intakeDays  = (intake.daysPerWeek ?? 0) as number;
  const intakeTod   = ((intake.timeOfDay ?? "") as string).toLowerCase();

  const allSkills = [
    ...(caregiver.specialties  ?? []),
    ...(caregiver.certifications ?? []),
  ];

  const skillsCoverage = computeSkillsCoverage(allSkills, needs);

  // Simple distance proxy from city/zip (no lat/lng in this flow)
  const cgCity = (caregiver.city ?? "").toLowerCase();
  const cgZip  = ((caregiver as any).zipCode ?? "") as string;
  let distanceMiles: number | undefined;
  if (cgCity === intakeCity) distanceMiles = 2;
  else if (intakeZip && cgZip && intakeZip.slice(0, 3) === cgZip.slice(0, 3)) distanceMiles = 12;
  else distanceMiles = 22;

  const cgHours = (caregiver.availability?.hours ?? "").toLowerCase();
  let scheduleOverlap = 60;
  if (cgHours.includes(intakeTod) || intakeTod === "") scheduleOverlap = 90;
  if (intakeDays > 5 && !cgHours.includes("weekend")) scheduleOverlap = Math.min(scheduleOverlap, 70);

  // Quick rule-based score for pre-filtering only (not the final score)
  let ruleScore = Math.round(
    skillsCoverage                             * 0.35 +
    (distanceMiles <= 5 ? 100 : distanceMiles <= 15 ? 70 : 30) * 0.20 +
    Math.min(Math.round((caregiver.rating ?? 3.5) / 5 * 100), 100) * 0.20 +
    scheduleOverlap                            * 0.15 +
    75                                         * 0.10  // personality placeholder
  );

  // Soft preference penalties — keep mismatches IN the pool (so we never dead-end
  // a family with no matches) but push them down so better-fitting caregivers
  // surface first. Claude does the nuanced scoring; this just orders the top 15.
  const budgetMax  = Number(intake.budgetMax ?? 0);
  const genderPref = ((intake.genderPreference ?? "") as string).toLowerCase();
  if (budgetMax > 0 && caregiver.hourlyRate > budgetMax) ruleScore -= 20;
  if (genderPref && caregiver.gender && caregiver.gender.toLowerCase() !== genderPref) ruleScore -= 15;
  if (intake.needsDriving === true && caregiver.canDrive === false) ruleScore -= 10;
  ruleScore = Math.max(0, ruleScore);

  const signals: CandidateSignals = {
    caregiverId:           caregiver.id,
    name:                  caregiver.name,
    distanceMiles,
    skillsCoveragePercent: skillsCoverage,
    scheduleOverlapPercent: scheduleOverlap,
    rating:                caregiver.rating,
    yearsExperience:       caregiver.yearsExperience,
    isVerified:            !caregiver.pendingBackgroundCheck,
    certifications:        caregiver.certifications,
    languages:             caregiver.languages,
    gender:                caregiver.gender,
    canDrive:              caregiver.canDrive,
    personalityTags:       [],
    hourlyRate:            caregiver.hourlyRate,
    hasDementiaCert:       detectDementiaCert(allSkills),
    hasMedicalCred:        detectMedicalCred(allSkills),
    feedbackSummary:       "no prior history with this family",
    ruleScore,
  };

  return { ruleScore, signals };
}

export async function runMatchingForClient(
  phone:   string,
  chatId:  string,
  intake:  Record<string, unknown>,
  session?: Record<string, unknown>
): Promise<void> {
  try {
    const zip    = (intake.zipCode ?? "") as string;
    const city   = (intake.city    ?? "") as string;

    // Exclude caregivers the family has already declined
    const rejectedIds: string[] = (session?.rejectedCaregiverIds ?? []) as string[];
    if (!session) {
      const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
      if (sessionSnap.exists) {
        rejectedIds.push(...((sessionSnap.data()?.rejectedCaregiverIds ?? []) as string[]));
      }
    }

    // Pull active + pending_review caregivers in a broad radius
    const snap = await db.collection("caregivers")
      .where("status", "in", ["active", "pending_review"])
      .limit(50)
      .get();

    const nowIso = new Date().toISOString();
    let caregivers: CaregiverCandidate[] = snap.docs
      .map((d) => ({
        id:                     d.id,
        pendingBackgroundCheck: d.data().status === "pending_review",
        backgroundCheckStatus:  d.data().backgroundCheckData?.status as string | undefined,
        certifications:         d.data().certifications as string[] | undefined,
        ...d.data(),
      } as CaregiverCandidate))
      .filter((c) =>
        !isSeededCaregiver(c as unknown as Record<string, unknown>) &&
        !rejectedIds.includes(c.id) &&
        !isTemporarilyUnavailable(c as any, nowIso) && (
          c.city?.toLowerCase() === city.toLowerCase() ||
          (c as any).zipCode?.startsWith(zip.slice(0, 3))
        )
      );

    if (caregivers.length === 0) {
      // Broader search if local returns nothing (still respecting rejections
      // and the paused/opted-out availability filter)
      caregivers = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as CaregiverCandidate))
        .filter((c) =>
          !isSeededCaregiver(c as unknown as Record<string, unknown>) &&
          !rejectedIds.includes(c.id) &&
          !isTemporarilyUnavailable(c as any, nowIso)
        );
    }

    // Step 1: compute rule-based signals for pre-filtering
    const withSignals = caregivers.map(c => ({
      c,
      ...computeRuleSignals(c, intake),
    }));

    // Step 2: take the strongest candidates by rule score, then fold in
    // platform reputation (U6) as a bounded tie-breaker before the final
    // top-15 cut. Pull a slightly wider pool so a strong-reputation caregiver
    // can be promoted INTO the cut, not merely reordered within it. Reputation
    // is capped so it tilts ties without overriding skills/proximity, and a
    // caregiver with no outcomes scores neutral (boost 0).
    const prelim = withSignals
      .sort((a, b) => b.ruleScore - a.ruleScore)
      .slice(0, 20);
    const repBoosts = await getReputationBoosts(db, prelim.map(x => x.c.id))
      .catch(() => new Map<string, number>());
    for (const cand of prelim) {
      const boost = repBoosts.get(cand.c.id) ?? 0;
      if (boost === 0) continue;
      cand.ruleScore = Math.max(0, cand.ruleScore + boost);
      cand.signals.ruleScore = cand.ruleScore;
      cand.signals.reputationNote = boost > 0
        ? `platform reputation: positive — families across the platform tend to hire (+${boost.toFixed(1)})`
        : `platform reputation: caution — families have tended to pass (${boost.toFixed(1)})`;
    }
    const topCandidates = prelim
      .sort((a, b) => b.ruleScore - a.ruleScore)
      .slice(0, 15);

    // Step 3: Claude Sonnet scores all top candidates holistically
    const outcomePatterns = await getOutcomePatternSummary(db).catch(() => "");
    const systemPrompt = buildMatchingSystemPrompt(outcomePatterns);

    const needs = (intake.careNeeds ?? []) as string[];
    const senior = {
      needs,
      genderPreference:   (intake.genderPreference ?? "") as string,
      languagePreference: (intake.languagePreference ?? "") as string,
      budgetMax:          Number(intake.budgetMax ?? 0) || undefined,
      needsDriving:       intake.needsDriving === true,
      personality:        (intake.seniorPersonality ?? "") as string,
      name:               (intake.seniorName ?? "") as string,
    };

    let claudeScores: Map<string, ClaudeScoredMatch>;
    try {
      claudeScores = await scoreWithClaude(
        topCandidates.map(x => x.signals),
        senior,
        systemPrompt,
        3000
      );
    } catch (err) {
      console.warn("[matchingAgent] Claude scoring failed, falling back to rule scores:", err);
      // Fallback: convert rule signals to MatchScoreResult shape
      claudeScores = new Map(topCandidates.map(x => [x.c.id, {
        caregiverId:  x.c.id,
        overallScore: x.ruleScore,
        confidence:   x.ruleScore >= 80 ? "high" as const : x.ruleScore >= 65 ? "medium" as const : "low" as const,
        reasoning:    [
          (x.signals.skillsCoveragePercent ?? 0) > 60
            ? `Covers ${x.signals.skillsCoveragePercent}% of care needs` : "Available caregiver",
        ],
        redFlags: [],
        factors:  {
          skillsMatch:    x.signals.skillsCoveragePercent ?? 50,
          availability:   x.signals.scheduleOverlapPercent ?? 60,
          distance:       x.signals.distanceMiles != null
            ? Math.max(0, 100 - x.signals.distanceMiles * 3) : 50,
          experience:     Math.min(100, (x.signals.yearsExperience ?? 0) * 10),
          personalityFit: 75,
          languageMatch:  75,
        },
      }]));
    }

    // Step 4: build MatchScoreResult objects from Claude output
    const scoredCaregivers = topCandidates
      .map(({ c }) => {
        const claude = claudeScores.get(c.id);
        if (!claude) return null;
        const ms: MatchScoreResult = {
          overallScore: claude.overallScore,
          confidence:   claude.confidence,
          reasoning:    claude.reasoning,
          breakdown: {
            skillsMatch:       claude.factors.skillsMatch,
            availabilityMatch: claude.factors.availability,
            personalityMatch:  claude.factors.personalityFit,
            distanceScore:     claude.factors.distance,
            ratingScore:       claude.factors.experience,
            rebookingRate:     70,
          },
        };
        return { c, matchScore: ms };
      })
      .filter(Boolean)
      .sort((a, b) => b!.matchScore.overallScore - a!.matchScore.overallScore) as Array<{ c: CaregiverCandidate; matchScore: MatchScoreResult }>;

    const top3 = scoredCaregivers.slice(0, 3).map((x) => x.c);
    const top3Scores = scoredCaregivers.slice(0, 3).map((x) => x.matchScore);

    if (top3.length === 0) {
      // Read and increment the failure counter on the client's session
      const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
      const prevFailures = (sessionSnap.data()?.consecutiveMatchFailures ?? 0) as number;
      const failureCount = prevFailures + 1;
      await db.collection("agent_sessions").doc(phone).update({ consecutiveMatchFailures: failureCount });

      const intakeCareNeeds = (intake.careNeeds ?? []) as string[];
      const severity = failureCount >= 2 ? "urgent" : "high";

      await db.collection("admin_alerts").add({
        type:           "no_match_found",
        clientPhone:    phone,
        city:           (intake.city    ?? "") as string,
        zipCode:        (intake.zipCode ?? "") as string,
        careNeeds:      intakeCareNeeds,
        failureCount,
        createdAt:      new Date().toISOString(),
        resolved:       false,
        severity,
      });

      if (failureCount >= 2) {
        // Pool is repeatedly exhausted — escalate urgently and keep searching
        await sendMessage(chatId,
          "I haven't been able to find the right match yet, but I'm still actively searching. " +
          "Our team has also been notified and will personally reach out to you shortly — we won't let you wait."
        );
        // Auto-trigger a broader rematch on the next cycle by clearing rejected list
        // only if all local + broader search is exhausted
        if (rejectedIds.length > 0) {
          // Widen the pool: keep only the last 3 rejections to allow re-presentation after escalation
          const trimmedRejections = rejectedIds.slice(-3);
          await db.collection("agent_sessions").doc(phone).update({
            rejectedCaregiverIds: trimmedRejections,
          });
        }
      } else {
        await sendMessage(chatId,
          "I don't have anyone available in your area right now, but I've flagged your request " +
          "and our team will reach out within 24 hours to find the right match."
        );
      }
      return;
    }

    // Successful match — reset the failure counter
    await db.collection("agent_sessions").doc(phone).update({ consecutiveMatchFailures: 0 }).catch(() => {});

    // Write pending interview requests (and caregiver_interest tasks for pending-bg-check caregivers)
    for (let i = 0; i < top3.length; i++) {
      const c = top3[i];
      const ms = top3Scores[i];
      await db.collection("interview_requests").add({
        clientPhone:  phone,
        caregiverId:  c.id,
        caregiverName: c.name,
        status:       "pending_presentation",
        createdAt:    new Date().toISOString(),
        matchScore: {
          overallScore: ms.overallScore,
          breakdown:    ms.breakdown,
          reasoning:    ms.reasoning,
          confidence:   ms.confidence,
        },
      });

      if ((c as any).pendingBackgroundCheck) {
        await db.collection("agent_tasks").add({
          type:          "caregiver_interest",
          caregiverId:   c.id,
          caregiverName: c.name,
          clientPhone:   phone,
          clientId:      (session as any)?.userId ?? phone,
          status:        "pending_bg_clear",
          createdAt:     new Date().toISOString(),
        });
      }
    }

    const seniorName = (intake.seniorName ?? "your loved one") as string;
    const appUrl     = getAppUrl();
    const userId     = (session as any)?.userId ?? phone;

    // Surface remembered client preferences so Cara can reference them naturally
    const learnedFacts = await getRelevantFacts(userId).catch(() => [] as Awaited<ReturnType<typeof getRelevantFacts>>);
    const factsContext = learnedFacts.length > 0
      ? `\n\n🧠 KNOWN PREFERENCES (learned from past conversations):\n${learnedFacts.map(f => `- ${f.fact}`).join("\n")}\nIf the top match aligns with a known preference, mention it naturally (e.g. "You mentioned preferring female caregivers — Maria fits that perfectly.").`
      : "";

    // Confidence/trust score (0-100). Delegates to the shared bounded-additive
    // scorer (U2) so the live match path stays aligned with the persisted
    // `confidenceScore`. References are not a signal; MVR is driver-gated.
    function caregiversTrustScore(c: CaregiverCandidate): number {
      return computeConfidenceScoreFromFields({
        backgroundCheckStatus: (c as any).backgroundCheckStatus,
        pendingBackgroundCheck: c.pendingBackgroundCheck,
        approvedAt: (c as any).approvedAt,
        rating: c.rating,
        verificationStatus: (c as any).verificationStatus,
        certifications: c.certifications,
        isApprovedDriver: (c as any).isApprovedDriver,
        backgroundCheckData: (c as any).backgroundCheckData,
      }).score;
    }

    // Build structured match data for the execution agent's context
    const matchData = top3.map((c, i) => {
      const ms          = top3Scores[i];
      const bgStatus    = (c as any).backgroundCheckStatus ?? (c.pendingBackgroundCheck ? "pending" : "clear");
      const trustLines: string[] = [];
      if (bgStatus === "clear")       trustLines.push("background check cleared");
      if (c.certifications?.length)   trustLines.push(c.certifications.slice(0, 2).join(", "));
      return {
        index:        i + 1,
        id:           c.id,
        name:         c.name,
        hourlyRate:   c.hourlyRate,
        rating:       c.rating ?? null,
        bgStatus,
        trustSignals: trustLines,
        trustScore:   caregiversTrustScore(c),
        pendingBg:    !!c.pendingBackgroundCheck,
        topReason:    ms.reasoning[0] ?? "available and local",
        allReasons:   ms.reasoning,
        overallScore: ms.overallScore,
        profileUrl:   `${appUrl}/caregiver/${c.id}`,
        // Headshot (persisted from web upload OR a photo texted to Cara). Sent as
        // an image bubble before each caregiver's profile link so families see a
        // face, not a generic preview card. Null for legacy caregivers w/o a photo.
        photo:        ((c as any).profilePhoto ?? (c as any).photoURL ?? null) as string | null,
        specialties:  c.specialties ?? [],
        yearsExp:     c.yearsExperience ?? null,
        city:         c.city ?? "",
      };
    });

    // Build the matching agent system prompt with full caregiver context baked in
    const matchSummary = matchData
      .map(m =>
        `${m.index}. ${m.name} — ${m.topReason}. $${m.hourlyRate}/hr` +
        (m.trustScore >= 60 ? ` · ${m.trustScore}⭐ Trust` : "") +
        (m.trustSignals.length ? `\n   ✓ ${m.trustSignals.join(" · ")}` : "") +
        (m.pendingBg ? `\n   ⏳ Background check in progress` : "") +
        `\n   Profile: ${m.profileUrl}` +
        `\n   Specialties: ${m.specialties.join(", ") || "general care"}` +
        (m.yearsExp ? `\n   Experience: ${m.yearsExp} years` : "")
      )
      .join("\n\n");

    const agentSystemPrompt =
      `You are Cara's matching agent. You found these caregivers for ${seniorName}:\n\n` +
      `${matchSummary}\n\n` +
      `Care needs: ${needs.join(", ") || "general"}` +
      factsContext +
      `\n\nYour job:\n` +
      `- First turn: write ONE warm, specific opening line letting the family know you found ${matchData.length} caregiver${matchData.length > 1 ? "s" : ""} for ${seniorName} near them. Do NOT list them, do NOT include any URLs — a photo of each caregiver with their profile link is sent right after your message.\n` +
      `- Follow-up turns: answer questions about the specific caregivers from the details above\n` +
      `- If asked about a caregiver not in this list, say you only have details for the ones you presented\n\n` +
      `Rules: plain text only, no bullet points, no headers. Warm, direct, specific. ` +
      `Under 220 characters for the opening line. ` +
      `When you reference a Profile link, copy the URL EXACTLY as shown above including the https:// prefix — never shorten, paraphrase, or drop the scheme (clients need to be able to tap it).`;

    // Roster check — reuse existing agent if one is active for this user
    const existingAgent = await getActiveAgentForUser(phone, "matching");
    let agentId: string;

    if (existingAgent) {
      // Keep history so the family can reference previous caregivers discussed;
      // only update the system prompt + context with the fresh match data.
      await updateExecutionAgentContext(existingAgent.id, { matchData, seniorName, careNeeds: needs }, agentSystemPrompt, false);
      agentId = existingAgent.id;
    } else {
      agentId = await spawnExecutionAgent({
        type:         "matching",
        ownerId:      userId,
        ownerPhone:   phone,
        systemPrompt: agentSystemPrompt,
        context:      { matchData, seniorName, careNeeds: needs },
      });
    }

    // First agent turn generates the warm opening line — route through interaction
    // agent so it gets supervisor lint, DND respect, and proper chunking. The
    // per-caregiver photo gallery (below) carries the names + tappable links.
    const introMessage = await runExecutionAgentTurn(agentId, "Write the warm opening line now.");

    // Deterministic fallback header if the LLM line comes back empty — a family
    // must never get silence. (Names + links are guaranteed by the gallery below.)
    const headerLine = (introMessage ?? "").trim() ||
      `I found ${matchData.length} caregiver${matchData.length > 1 ? "s" : ""} for ${seniorName} near you 👇`;

    const { sendViaInteractionAgent } = await import("./caraAgent");
    await sendViaInteractionAgent(phone, {
      content:     headerLine,
      urgency:     "immediate",
      sourceAgent: "matching",
      canDrop:     false,
    });

    // Per-caregiver gallery: for each match send their headshot (if we have one)
    // as an image bubble, then a factual caption with the tappable profile link.
    // sendMessage auto-splits the URL into a rich link card on iMessage/RCS and
    // leaves it as a plain tappable URL on SMS. Photo bubble is skipped for legacy
    // caregivers without a stored photo — they still get the caption + link.
    for (const m of matchData) {
      try {
        if (m.photo) {
          await sendMessage(chatId, { parts: [{ type: "media", url: m.photo }] });
          await new Promise<void>((r) => setTimeout(r, 400));
        }
        const trust    = m.trustScore >= 60 ? ` · ${m.trustScore}⭐ Trust` : "";
        const specs     = m.specialties.length ? `\n${m.specialties.slice(0, 3).join(", ")}` : "";
        const bgPending = m.pendingBg ? `\n⏳ Background check in progress` : "";
        await sendMessage(chatId,
          `${m.index}. ${m.name} — $${m.hourlyRate}/hr${trust}${specs}${bgPending}\n` +
          `Tap to view ${m.name.split(" ")[0]}'s profile: ${m.profileUrl}`
        );
        await new Promise<void>((r) => setTimeout(r, 400));
      } catch (err) {
        console.warn("[matchingAgent] gallery send failed for caregiver", { phone, id: m.id, err: (err as Error)?.message });
      }
    }

    await sendMessage(chatId, "Which ones would you like to meet? Just reply with a name or number.");

    // Store match list in session for follow-up; embed active goal context so
    // interview selection can pre-populate booking dates without re-prompting the family
    const sessionSnap2 = await db.collection("agent_sessions").doc(phone).get();
    const goalContext = (sessionSnap2.data() as any)?.activeGoal?.type === "booking"
      ? (sessionSnap2.data() as any).activeGoal.context
      : null;

    await db.collection("agent_sessions").doc(phone).update({
      pendingMatches: top3.map((c, i) => ({
        id:          c.id,
        name:        c.name,
        rate:        c.hourlyRate,
        matchScore:  top3Scores[i],
        agentId,
        ...(goalContext ? { goalContext } : {}),
      })),
      // Used by webhooks.ts to detect stale state — selection prompts older
      // than 2 hours are treated as expired and cleared on next inbound.
      pendingMatchesSetAt: new Date().toISOString(),
    });

    // Register these caregivers' names so the persona-shift detector never
    // mistakes "send me <caregiver>'s profile" for a different care recipient.
    const { addKnownNames } = await import("../utils/knownNames");
    await addKnownNames(phone, top3.map((c) => c.name));
  } catch (err) {
    console.error("runMatchingForClient error:", err);
    await sendMessage(chatId,
      "I'm searching for caregivers — I'll text you top matches within the hour."
    );
  }
}
