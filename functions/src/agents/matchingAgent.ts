import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import {
  spawnExecutionAgent,
  getActiveAgentForUser,
  runExecutionAgentTurn,
  updateExecutionAgentContext,
} from "./executionAgent";
import { getRelevantFacts } from "../memory/learnedFacts";

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

function computeMatchScore(
  caregiver: CaregiverCandidate,
  intake: Record<string, unknown>
): MatchScoreResult {
  const needs          = (intake.careNeeds ?? []) as string[];
  const intakeCity     = ((intake.city ?? "") as string).toLowerCase();
  const intakeZip      = ((intake.zipCode ?? "") as string);
  const intakeDays     = (intake.daysPerWeek ?? 0) as number;
  const intakeTimeOfDay = ((intake.timeOfDay ?? "") as string).toLowerCase();
  const genderPref     = ((intake.genderPreference ?? "") as string).toLowerCase();

  // Skills match (0-100): % of care needs matched by specialties
  const matchedNeeds = needs.filter((n) =>
    caregiver.specialties?.some((s) => s.toLowerCase().includes(n.toLowerCase()))
  );
  const skillsMatch = needs.length > 0
    ? Math.round((matchedNeeds.length / needs.length) * 100)
    : 70;

  // Distance score (0-100): exact city = 100, zip prefix match = 70, no match = 30
  const cgCity = (caregiver.city ?? "").toLowerCase();
  const cgZip  = ((caregiver as any).zipCode ?? "") as string;
  let distanceScore = 30;
  if (cgCity === intakeCity) distanceScore = 100;
  else if (intakeZip && cgZip && intakeZip.slice(0, 3) === cgZip.slice(0, 3)) distanceScore = 70;

  // Availability match (0-100): simplified — overlap on time of day
  const cgHours = (caregiver.availability?.hours ?? "").toLowerCase();
  let availabilityMatch = 60;
  if (cgHours.includes(intakeTimeOfDay) || intakeTimeOfDay === "") availabilityMatch = 90;
  if (intakeDays > 5 && !cgHours.includes("weekend")) availabilityMatch = Math.min(availabilityMatch, 70);

  // Rating score (0-100): 5-star → 100
  const ratingScore = Math.min(Math.round((caregiver.rating ?? 3.5) / 5 * 100), 100);

  // Personality / gender preference (0-100)
  let personalityMatch = 75;
  if (genderPref && caregiver.gender) {
    personalityMatch = caregiver.gender.toLowerCase() === genderPref ? 95 : 55;
  }

  // Experience-weighted rebooking proxy (0-100)
  const rebookingRate = Math.min(
    Math.round(50 + (caregiver.yearsExperience ?? 0) * 5 + (caregiver.rating ?? 3) * 5),
    100
  );

  // Weighted average: skills 35%, distance 20%, rating 20%, availability 15%, personality 10%
  const overallScore = Math.round(
    skillsMatch       * 0.35 +
    distanceScore     * 0.20 +
    ratingScore       * 0.20 +
    availabilityMatch * 0.15 +
    personalityMatch  * 0.10
  );

  // Build reasoning list
  const reasoning: string[] = [];
  if (matchedNeeds.length > 0) reasoning.push(`Specializes in ${matchedNeeds.slice(0, 2).join(" and ")}`);
  if (distanceScore === 100) reasoning.push(`Located in ${intake.city}`);
  if ((caregiver.rating ?? 0) >= 4.8) reasoning.push("Top-rated by families");
  if ((caregiver.yearsExperience ?? 0) >= 5) reasoning.push(`${caregiver.yearsExperience} years of experience`);
  if (availabilityMatch >= 90) reasoning.push("Available at your preferred times");
  if (reasoning.length === 0) reasoning.push("Available and local");

  const confidence: "high" | "medium" | "low" =
    overallScore >= 80 ? "high" : overallScore >= 65 ? "medium" : "low";

  return {
    overallScore,
    breakdown: { skillsMatch, availabilityMatch, personalityMatch, distanceScore, ratingScore, rebookingRate },
    reasoning,
    confidence,
  };
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

    let caregivers: CaregiverCandidate[] = snap.docs
      .map((d) => ({
        id:                     d.id,
        pendingBackgroundCheck: d.data().status === "pending_review",
        backgroundCheckStatus:  d.data().backgroundCheckData?.status as string | undefined,
        certifications:         d.data().certifications as string[] | undefined,
        ...d.data(),
      } as CaregiverCandidate))
      .filter((c) =>
        !rejectedIds.includes(c.id) && (
          c.city?.toLowerCase() === city.toLowerCase() ||
          (c as any).zipCode?.startsWith(zip.slice(0, 3))
        )
      );

    if (caregivers.length === 0) {
      // Broader search if local returns nothing (still respecting rejections)
      caregivers = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as CaregiverCandidate))
        .filter((c) => !rejectedIds.includes(c.id));
    }

    const scoredCaregivers = caregivers
      .map((c) => ({ c, matchScore: computeMatchScore(c, intake) }))
      .sort((a, b) => b.matchScore.overallScore - a.matchScore.overallScore);

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
    const needs      = (intake.careNeeds ?? []) as string[];
    const appUrl     = process.env.APP_URL ?? "https://cara.app";
    const userId     = (session as any)?.userId ?? phone;

    // Surface remembered client preferences so Cara can reference them naturally
    const learnedFacts = await getRelevantFacts(userId).catch(() => [] as Awaited<ReturnType<typeof getRelevantFacts>>);
    const factsContext = learnedFacts.length > 0
      ? `\n\n🧠 KNOWN PREFERENCES (learned from past conversations):\n${learnedFacts.map(f => `- ${f.fact}`).join("\n")}\nIf the top match aligns with a known preference, mention it naturally (e.g. "You mentioned preferring female caregivers — Maria fits that perfectly.").`
      : "";

    // Compute a simple trust score (0-100) for each caregiver
    function caregiversTrustScore(c: CaregiverCandidate): number {
      let s = 0;
      const bgStatus = (c as any).backgroundCheckStatus ?? (c.pendingBackgroundCheck ? "pending" : "clear");
      if (bgStatus === "clear") s += 30;
      const approvedAt = (c as any).approvedAt as string | undefined;
      if (approvedAt) {
        const months = Math.floor((Date.now() - new Date(approvedAt).getTime()) / (30 * 24 * 60 * 60 * 1000));
        s += Math.min(months, 12) / 12 * 20;
      }
      if (c.rating != null) s += (c.rating / 5) * 20;
      const vStatus = (c as any).verificationStatus as string | undefined;
      if (vStatus === "approved" || vStatus === "checkr_clear") s += 15;
      s += (Math.min(c.certifications?.length ?? 0, 3) / 3) * 15;
      return Math.round(s);
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
      `- First turn: write a warm, specific intro message presenting these caregivers\n` +
      `- Follow-up turns: answer questions about the specific caregivers from the details above\n` +
      `- If asked about a caregiver not in this list, say you only have details for the ones you presented\n\n` +
      `Rules: plain text only, no bullet points, no headers. Warm, direct, specific. ` +
      `Under 300 characters per message when possible. End the intro with "Which ones would you like to meet?"`;

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

    // First agent turn generates the intro message — route through interaction agent
    // so it gets supervisor lint, DND respect, and proper chunking.
    const introMessage = await runExecutionAgentTurn(agentId, "Introduce these caregivers to the family now.");
    const { sendViaInteractionAgent } = await import("./caraAgent");
    await sendViaInteractionAgent(phone, {
      content:     introMessage || `Here are ${top3.length} caregivers I found for ${seniorName}. Which would you like to meet?`,
      urgency:     "immediate",
      sourceAgent: "matching",
      canDrop:     false,
    });

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
    });
  } catch (err) {
    console.error("runMatchingForClient error:", err);
    await sendMessage(chatId,
      "I'm searching for caregivers — I'll text you top matches within the hour."
    );
  }
}
