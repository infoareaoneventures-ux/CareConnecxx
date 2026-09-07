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
// U7 (R36/KTD14): outcomeAnalytics deliberately not imported — hired/rejected
// aggregates are funnel/offline evidence only, never ranking input.
import { getReputationBoosts } from "../ai/caregiverReputation";
import { computeConfidenceScoreFromFields } from "./confidenceScore";
import { getAppUrl } from "../config/appUrl";
import { isSeededCaregiver } from "./actions/getCaregiverPreviewAction";
import { recordCommitment, resolveCommitment } from "./commitmentTracker";
import { haversineDistanceMiles } from "./caregiverMatchScoring";
import { isCaregiverBookable } from "../utils/caregiverEligibility";
import { geocodeCityOrZip } from "../utils/geocode";

const db = admin.firestore();

export interface CaregiverCandidate {
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

// 2026-09-07: a live "matching_run_failed" alert ("...toLowerCase is not a
// function") traced to computeRuleSignals assuming every one of these fields
// is always a plain string. publicCaregiverProfiles passes several of them
// through verbatim from whatever the raw caregiver doc actually has — and the
// website's OWN scoring (caregiverMatchScoring.ts) already treats
// availability as `unknown`, preferring weeklyAvailability over the
// `{days,hours}` shape this file's CaregiverCandidate type assumes. A truthy
// non-string value (e.g. availability.hours not actually being a string on
// some real docs) crashed the whole matching pass instead of just scoring
// that one signal as neutral. asStr() makes every .toLowerCase() call site
// fail soft instead of throwing, regardless of which field is malformed.
function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Compute rule-based signals as a pre-filter before calling Claude. */
export function computeRuleSignals(
  caregiver: CaregiverCandidate,
  intake: Record<string, unknown>
): { ruleScore: number; signals: CandidateSignals } {
  const needs       = (intake.careNeeds ?? []) as string[];
  const intakeCity  = asStr(intake.city).toLowerCase();
  const intakeZip   = asStr(intake.zipCode);
  const intakeDays  = (intake.daysPerWeek ?? 0) as number;
  const intakeTod   = asStr(intake.timeOfDay).toLowerCase();

  const allSkills = [
    ...(caregiver.specialties  ?? []),
    ...(caregiver.certifications ?? []),
  ];

  const skillsCoverage = computeSkillsCoverage(allSkills, needs);

  // Real haversine distance when both sides have coordinates — mirrors
  // caregiverMatchScoring.ts (the website's own "Nearby Caregivers" logic,
  // ported byte-identical for backend use elsewhere in this file's sibling
  // getCaregiverPreviewAction.ts). Found 2026-08-31: this used to be a
  // city-string/zip-prefix guess ("no lat/lng in this flow") that could rank
  // — or entirely miss — a real nearby caregiver the website's own distance
  // math would have surfaced correctly. Falls back to the old city/zip proxy
  // only when a coordinate is genuinely missing (e.g. geocoding failed).
  const clientLat = intake.__clientLat as number | undefined;
  const clientLng = intake.__clientLng as number | undefined;
  const cgLat = ((caregiver as any).lat ?? (caregiver as any).latitude ?? (caregiver as any).location?.lat) as number | undefined;
  const cgLng = ((caregiver as any).lng ?? (caregiver as any).longitude ?? (caregiver as any).location?.lng) as number | undefined;
  const cgCity = asStr(caregiver.city).toLowerCase();
  const cgZip  = asStr((caregiver as any).zipCode);
  let distanceMiles: number | undefined;
  if (clientLat != null && clientLng != null && cgLat != null && cgLng != null) {
    distanceMiles = Math.round(haversineDistanceMiles(clientLat, clientLng, cgLat, cgLng) * 10) / 10;
  } else if (cgCity === intakeCity) distanceMiles = 2;
  else if (intakeZip && cgZip && intakeZip.slice(0, 3) === cgZip.slice(0, 3)) distanceMiles = 12;
  else distanceMiles = 22;

  const cgHours = asStr(caregiver.availability?.hours).toLowerCase();
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
  const genderPref = asStr(intake.genderPreference).toLowerCase();
  if (budgetMax > 0 && caregiver.hourlyRate > budgetMax) ruleScore -= 20;
  if (genderPref && caregiver.gender && asStr(caregiver.gender).toLowerCase() !== genderPref) ruleScore -= 15;
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

/**
 * Outcome of a matching pass. "matched" and "no_match" both messaged the
 * family; "failed" means the catch path ran — the family got a promise of
 * matches "within the hour", backed by a tracked commitment the sweep in
 * commitmentTracker.ts fulfills or escalates. Existing callers that ignore
 * the return value are unaffected.
 */
export type MatchRunResult = "matched" | "no_match" | "failed";

/**
 * suppressConversationalSends: set by callers that are themselves about to
 * speak to the family in the same turn (the QA agent's find_replacement_caregivers
 * tool). With it on, matching still does all its work (interview requests,
 * failure counters, admin alerts, commitments, pendingMatches) and still sends
 * the artifacts only it can send (intro line + photo gallery on a match), but
 * SKIPS the pure-status texts — the no-match update, the "Which ones would you
 * like to meet?" closer, and the catch-path stall copy — so the family hears
 * ONE voice per turn instead of the tool and the agent both texting.
 * Direct callers (routeIntent, commitmentTracker sweep, caraAgent dispatch)
 * have no agent reply behind them and must leave this off.
 */
export interface MatchRunOptions {
  suppressConversationalSends?: boolean;
}

// This family's OWN match history, as a prompt block for the scorer. Global
// outcome patterns say what families in general hire; this says what THIS
// family has already passed on or hired. Names only — the scorer sees each
// candidate's full signals and can reason about resemblance itself. No
// orderBy (avoids composite indexes); recency isn't load-bearing here.
async function buildFamilyMatchHistory(phone: string, userId?: string): Promise<string> {
  const [reqSnap, outcomeSnap] = await Promise.all([
    db.collection("interview_requests")
      .where("clientPhone", "==", phone)
      .limit(25)
      .get()
      .catch(() => null),
    userId
      ? db.collection("match_outcomes")
          .where("clientId", "==", userId)
          .limit(25)
          .get()
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const passed  = new Set<string>();
  const met     = new Set<string>();
  for (const d of reqSnap?.docs ?? []) {
    const r = d.data();
    const name = (r.caregiverName as string) || "";
    if (!name) continue;
    if (r.status === "client_declined" || r.status === "declined") passed.add(name);
    else if (r.status === "scheduled") met.add(name);
  }
  let hiredCount = 0, passedCount = 0;
  for (const d of outcomeSnap?.docs ?? []) {
    const o = d.data();
    if (o.outcome === "hired") hiredCount++;
    else passedCount++;
  }

  if (passed.size === 0 && met.size === 0 && hiredCount === 0 && passedCount === 0) return "";

  const lines: string[] = ["THIS FAMILY'S OWN HISTORY:"];
  if (passed.size > 0) lines.push(`- Previously passed on: ${[...passed].slice(0, 8).join(", ")}`);
  if (met.size > 0)    lines.push(`- Interviewed: ${[...met].slice(0, 8).join(", ")}`);
  if (hiredCount || passedCount) lines.push(`- Web match outcomes: ${hiredCount} hired, ${passedCount} passed`);
  lines.push(
    "Weigh what their passes have in common (rate, experience level, specialty mix) " +
    "and avoid re-offering the same shape of mismatch; if a candidate closely resembles " +
    "someone they passed on, say so in the reasoning."
  );
  return lines.join("\n");
}

export async function runMatchingForClient(
  phone:   string,
  chatId:  string,
  intake:  Record<string, unknown>,
  session?: Record<string, unknown>,
  opts?:   MatchRunOptions
): Promise<MatchRunResult> {
  const suppressSends = !!opts?.suppressConversationalSends;
  try {
    // Matching starting = the family is actively trying to hire. Record a
    // DURABLE goal (7-day horizon, generous turn budget) so Evia carries the
    // hiring context across days — not the legacy 3-turn/24h decay. Cleared
    // explicitly when a booking confirms (bookingExecutor). Dynamic import:
    // a static one would close the mcp/server → matchingAgent → qaAgent cycle.
    await import("./qaAgent")
      .then((m) => m.setActiveGoal(
        phone,
        "matching",
        `Find and hire a caregiver for ${(intake.seniorName as string) || "their loved one"}`,
        {
          seniorName: (intake.seniorName as string) ?? null,
          careNeeds:  (intake.careNeeds as string[]) ?? [],
          zipCode:    (intake.zipCode as string) ?? null,
        },
        50,
        7 * 24 * 60 * 60 * 1000,
      ))
      .catch(() => { /* goal is context sugar — never block matching on it */ });
    // 2026-09-04: `intake` is frequently a raw agent_sessions doc — most
    // callers pass sessionData straight through (routeIntent.ts, bookingExecutor,
    // shiftOffer, triggerEngine, commitmentTracker, replacementAgent) — and
    // AgentSession has NO top-level city/zipCode; those only ever live nested
    // under onboardingData or the live senior_profiles/users docs. Every one
    // of those callers was silently matching with an empty city/zip, which
    // starved the haversine path below and fell back to a proxy that either
    // over- or under-matched. Fill the gap once, here, for every caller —
    // same fix already applied to find_replacement_caregivers /
    // find_nearby_caregivers (functions/src/mcp/server.ts) — rather than
    // patching each call site. Never overwrites data intake already had.
    if (!intake.city && !intake.zipCode) {
      const liveUserId = ((session as any)?.userId ?? intake.userId) as string | undefined;
      if (liveUserId) {
        const live = await import("./onboardingConversation")
          .then((m) => m.loadLiveClientLocation(liveUserId))
          .catch(() => null);
        if (live) Object.assign(intake, live);
      }
    }

    const zip    = asStr(intake.zipCode);
    const city   = asStr(intake.city);

    // Real coordinates for real distance math (haversine), matching the
    // website's own "Nearby Caregivers" logic (caregiverMatchScoring.ts) —
    // found 2026-08-31: this flow used to guess proximity from a city-string/
    // zip-prefix match, which could miss (or wrongly rank) a caregiver the
    // website's real distance calculation would have surfaced correctly.
    // Stashed on `intake` under a double-underscore key so computeRuleSignals
    // (which takes the same loosely-typed intake object) can read it without
    // a signature change; failure is non-fatal — falls back to the old
    // city/zip proxy for this one request rather than blocking matching.
    // Prefer coordinates already resolved above (senior_profiles.latitude/
    // longitude, the most precise source) over re-geocoding a city/zip string.
    const clientLoc = (typeof intake.lat === "number" && typeof intake.lng === "number")
      ? { lat: intake.lat as number, lng: intake.lng as number }
      : await geocodeCityOrZip(city, zip).catch(() => null);
    if (clientLoc) {
      intake.__clientLat = clientLoc.lat;
      intake.__clientLng = clientLoc.lng;
    }

    // Exclude caregivers the family has already declined
    const rejectedIds: string[] = (session?.rejectedCaregiverIds ?? []) as string[];
    let shownIds: string[] = (session?.shownCaregiverIds ?? []) as string[];
    let fetchedSessionUserId: string | undefined;
    if (!session) {
      const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
      if (sessionSnap.exists) {
        rejectedIds.push(...((sessionSnap.data()?.rejectedCaregiverIds ?? []) as string[]));
        shownIds = (sessionSnap.data()?.shownCaregiverIds ?? []) as string[];
        // Found 2026-09-06 (via matchingAgentRepeat.test.ts): a caller that
        // omits `session` (relying on this fallback fetch) got the fetch's
        // rejectedIds/shownIds but NOT its userId — clientIdForExclusions
        // below fell through to intake.userId, which is frequently absent,
        // silently skipping the hire_decisions lookup and letting an already-
        // hired caregiver resurface for exactly the callers this fallback
        // exists for.
        fetchedSessionUserId = sessionSnap.data()?.userId as string | undefined;
      }
    }

    // Found 2026-09-06 (live bug): a family asking "is there more caregivers"
    // kept getting the exact same names back, and a caregiver they'd already
    // interviewed and made a hire/decline decision on (hire_decisions) could
    // resurface as if new. rejectedIds alone only covers an explicit
    // "not interested" rejection — it never tracked "already shown, no
    // decision yet" (that's what find_nearby_caregivers's shownCaregiverIds
    // is for, but this older intent-routed FIND_CAREGIVER path never read or
    // wrote it) or "already interviewed/decided" at all. excludeIds unifies
    // all three so repeated "show more" calls — through EITHER path — never
    // re-surface someone the family has already seen or decided on.
    //
    // Correction (Hamse, 2026-09-06): a DECLINE is not permanent — the family
    // may reconsider later, same as a plain rejectedCaregiverIds entry
    // (already re-surfaced on pool exhaustion below). Only a HIRE is a real,
    // standing relationship that should never be undone by pool exhaustion —
    // hiredIds is therefore kept out of the trimmable set entirely.
    const clientIdForExclusions = ((session as any)?.userId ?? fetchedSessionUserId ?? intake.userId) as string | undefined;
    const decisionDocs = clientIdForExclusions
      ? (await db.collection("hire_decisions").where("clientId", "==", clientIdForExclusions).limit(200).get()).docs
      : [];
    const hiredIds: string[] = decisionDocs
      .filter((d) => d.data().decision === "hire")
      .map((d) => d.data().caregiverId as string).filter(Boolean);
    const declinedIds: string[] = decisionDocs
      .filter((d) => d.data().decision === "decline")
      .map((d) => d.data().caregiverId as string).filter(Boolean);
    shownIds = Array.from(new Set([...shownIds, ...declinedIds]));
    const excludeIds = Array.from(new Set([...rejectedIds, ...shownIds, ...hiredIds]));

    // 2026-09-06: reads publicCaregiverProfiles instead of the raw caregivers
    // collection — the same pool the site's own Dashboard widget, Browse
    // Caregivers page, and find_nearby_caregivers already read. Before this,
    // Evia's SMS "find a caregiver" was the only surface reading the raw
    // collection directly, an unnecessary structural difference from
    // everything else even though the eligibility rule (isCaregiverBookable,
    // below) was already identical — a stale or not-yet-projected raw doc
    // could theoretically diverge from what the family would see on the site
    // for the exact same request.
    // (Pre-filter on onboardingStatus for index efficiency — was `status in
    // [...]` until 2026-09-04, dropped for the same reason documented then:
    // `status` is not part of the bookability contract; the post-filter
    // below enforces the full contract regardless of this pre-filter.)
    const snap = await db.collection("publicCaregiverProfiles")
      .where("onboardingStatus", "==", "profile_complete")
      .limit(100)
      .get();

    const nowIso = new Date().toISOString();
    // Same bookability rule the website uses everywhere else (onboarding
    // complete + verification approved).
    const eligible = (d: FirebaseFirestore.QueryDocumentSnapshot) => isCaregiverBookable(d.data() as any);
    const withinRadius = (c: CaregiverCandidate, miles: number): boolean => {
      const lat = (c as any).lat ?? (c as any).latitude ?? (c as any).location?.lat;
      const lng = (c as any).lng ?? (c as any).longitude ?? (c as any).location?.lng;
      if (clientLoc && lat != null && lng != null) {
        return haversineDistanceMiles(clientLoc.lat, clientLoc.lng, lat, lng) <= miles;
      }
      // No coordinates on one side (geocoding failed, or the caregiver doc
      // predates geocoding) — fall back to the old proxy rather than
      // silently excluding a candidate we have no real distance for.
      return asStr(c.city).toLowerCase() === asStr(city).toLowerCase() ||
        asStr((c as any).zipCode).startsWith(zip.slice(0, 3));
    };
    let caregivers: CaregiverCandidate[] = snap.docs
      .filter(eligible)
      .map((d) => ({
        id:                     d.id,
        // publicCaregiverProfiles carries backgroundCheckStatus flat (never
        // the raw caregivers doc's nested backgroundCheckData.status, and no
        // `status` field at all — see publicCaregiverProfile.ts's pick list).
        pendingBackgroundCheck: d.data().backgroundCheckStatus === "pending",
        backgroundCheckStatus:  d.data().backgroundCheckStatus as string | undefined,
        certifications:         d.data().certifications as string[] | undefined,
        ...d.data(),
      } as CaregiverCandidate))
      .filter((c) =>
        !isSeededCaregiver(c as unknown as Record<string, unknown>) &&
        !excludeIds.includes(c.id) &&
        !isTemporarilyUnavailable(c as any, nowIso) &&
        withinRadius(c, 25)
      );

    if (caregivers.length === 0) {
      // Broader search if local returns nothing (still respecting rejections,
      // bookability, and the paused/opted-out availability filter)
      caregivers = snap.docs
        .filter(eligible)
        .map((d) => ({ id: d.id, ...d.data() } as CaregiverCandidate))
        .filter((c) =>
          !isSeededCaregiver(c as unknown as Record<string, unknown>) &&
          !excludeIds.includes(c.id) &&
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

    // Step 3: Claude Sonnet scores all top candidates holistically using THIS
    // family's own history — a family that has passed on two caregivers is
    // telling us something; the scorer weighs what those passes have in common.
    // U7 (R36/KTD14): platform-wide hired/rejected aggregates are NO LONGER
    // injected — hire selection is not care-quality evidence, and feeding the
    // platform's own selection bias back into ranking amplifies it. The
    // family's own feedback is authority-safe (R37) and stays.
    const familyHistory   = await buildFamilyMatchHistory(phone, (session as any)?.userId as string | undefined)
      .catch(() => "");
    const systemPrompt = buildMatchingSystemPrompt(familyHistory);

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
      // 2026-09-07: distinguish "genuinely nobody nearby" from "real, eligible
      // people exist — they were just already shown/declined before". The
      // exclusion list exists so a text conversation doesn't repeat the exact
      // same pitch verbatim on every "show me more" — it was never meant to
      // make Evia claim zero availability when that's false (found live: a
      // family's own area had 3 real caregivers, 2 already shown, and Evia
      // told them nobody was available at all). hiredIds and seeded test data
      // stay excluded here regardless — a hire is permanent, seed data was
      // never real — only the shown/rejected reason gets a second look.
      const reofferable = snap.docs
        .filter(eligible)
        .map((d) => ({ id: d.id, ...d.data() } as CaregiverCandidate))
        .filter((c) =>
          !isSeededCaregiver(c as unknown as Record<string, unknown>) &&
          !hiredIds.includes(c.id) &&
          !isTemporarilyUnavailable(c as any, nowIso) &&
          excludeIds.includes(c.id)
        )
        .slice(0, 3);
      if (reofferable.length > 0) {
        await db.collection("agent_sessions").doc(phone).update({
          reofferableCaregivers: reofferable.map((c) => ({ id: c.id, name: c.name, hourlyRate: c.hourlyRate })),
        }).catch(() => {});
      }
      const reofferNames = reofferable.map((c) => c.name).filter(Boolean);
      const reofferLine = reofferNames.length > 0
        ? `The closest matches near you are still ${reofferNames.length === 1 ? reofferNames[0] : `${reofferNames.slice(0, -1).join(", ")} and ${reofferNames[reofferNames.length - 1]}`} — I'd already sent their info before. Want me to send their profiles again, or should I keep looking for someone new?`
        : null;

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
        reofferable:    reofferNames,
        createdAt:      new Date().toISOString(),
        resolved:       false,
        severity,
      });

      if (failureCount >= 2) {
        // Pool is repeatedly exhausted — escalate urgently and keep searching.
        // suppressSends: the agent turn that invoked us delivers this update
        // itself (tool result carries the facts) — texting it here too gave
        // the family two back-to-back, contradictory messages.
        if (!suppressSends) {
          await sendMessage(chatId, reofferLine ??
            "I haven't been able to find the right match yet, but I'm still actively searching. " +
            "Our team has also been notified and will personally reach out to you shortly — we won't let you wait."
          );
        }
        // Auto-trigger a broader rematch on the next cycle by clearing rejected list
        // only if all local + broader search is exhausted
        if (rejectedIds.length > 0 || shownIds.length > 0) {
          // Widen the pool: keep only the last 3 rejections/shown, same
          // trim-and-retry escalation find_nearby_caregivers already uses for
          // its own shownCaregiverIds — a genuinely small local market
          // shouldn't perma-lock a family out just because everyone nearby
          // has already been shown or declined once (declinedIds lives
          // inside shownIds, so it's eligible for exactly this same
          // widening). hiredIds is deliberately NOT trimmed here: a
          // caregiver the family actually hired should never resurface, no
          // matter how thin the pool gets.
          const trimmedRejections = rejectedIds.slice(-3);
          const trimmedShown      = shownIds.slice(-3);
          await db.collection("agent_sessions").doc(phone).update({
            rejectedCaregiverIds: trimmedRejections,
            shownCaregiverIds:    trimmedShown,
          });
        }
      } else if (!suppressSends) {
        await sendMessage(chatId, reofferLine ??
          "I don't have anyone available in your area right now, but I've flagged your request " +
          "and our team will reach out within 24 hours to find the right match."
        );
      }
      // The family got an honest update (with the team paged via admin_alerts)
      // — any earlier "I'll pull matches" promise has been answered. Under
      // suppressSends the invoking agent turn delivers that update (its tool
      // result instructs it to), so the promise is equally answered.
      await resolveCommitment(phone, "matching", "no_match_handled");
      return "no_match";
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

    // Surface remembered client preferences so Evia can reference them naturally
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
        // /p/{id} is the canonical share path — hosting rewrites it through
        // v1-caregiverProfileMeta so the texted link previews with this
        // caregiver's name + photo instead of the generic marketing card.
        profileUrl:   `${appUrl}/p/${c.id}`,
        // Headshot (persisted from web upload OR a photo texted to Evia). Sent as
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
      `You are Evia's matching agent. You found these caregivers for ${seniorName}:\n\n` +
      `${matchSummary}\n\n` +
      `Care needs: ${needs.join(", ") || "general"}` +
      factsContext +
      `\n\nYour job:\n` +
      `- First turn: write ONE warm, specific opening line letting the family know you found ${matchData.length} caregiver${matchData.length > 1 ? "s" : ""} for ${seniorName} near them. Do NOT list them, do NOT include any URLs — each caregiver's profile card (photo + tappable link) is sent right after your message.\n` +
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

    // Per-caregiver gallery: a factual caption with the tappable profile link.
    // sendMessage auto-splits the URL into a rich link card on iMessage/RCS —
    // and that card already carries the caregiver's photo via the /p/{id} OG
    // tags, so the old separate headshot bubble showed the same face twice
    // (founder, 2026-07-12: one image per caregiver). SMS gets the caption +
    // plain tappable URL.
    for (const m of matchData) {
      try {
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

    // suppressSends: the invoking agent turn asks this itself as its one
    // closing line (tool result instructs it), landing AFTER the gallery —
    // sending it here too would double the question.
    if (!suppressSends) {
      await sendMessage(chatId, "Which ones would you like to meet? Just reply with a name or number.");
    }

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
      // Shared with find_nearby_caregivers (mcp/server.ts) so "show more
      // caregivers" never repeats a name, regardless of which of the two
      // caregiver-search paths a given turn happens to route through.
      shownCaregiverIds: admin.firestore.FieldValue.arrayUnion(...top3.map((c) => c.id)),
    });

    // Register these caregivers' names so the persona-shift detector never
    // mistakes "send me <caregiver>'s profile" for a different care recipient.
    const { addKnownNames } = await import("../utils/knownNames");
    await addKnownNames(phone, top3.map((c) => c.name));

    // Matches delivered — any open "I'll pull matches" promise is kept.
    await resolveCommitment(phone, "matching", "matches_sent");
    return "matched";
  } catch (err) {
    console.error("runMatchingForClient error:", err);
    db.collection("admin_alerts").add({
      type:        "matching_run_failed",
      clientPhone: phone,
      error:       err instanceof Error ? err.message : String(err),
      severity:    "high",
      createdAt:   new Date().toISOString(),
      resolved:    false,
    }).catch(() => {});
    // Only promise "within the hour" when the commitment sweep is actually
    // tracking it (it retries the match pass, then escalates to a human).
    // If even the commitment write fails, be honest instead of promising.
    const tracked = await recordCommitment({
      phone, chatId, kind: "matching",
      promiseText: "I'll text you top matches within the hour.",
      userId:      (session?.userId as string | undefined),
      source:      "matchingAgent:catch",
      dueInMs:     30 * 60_000,
    });
    // suppressSends: the invoking agent turn tells the family (tool result
    // instructs it) — the commitment + admin alert above are already recorded.
    if (!suppressSends) {
      await sendMessage(chatId, tracked
        ? "I'm searching for caregivers — I'll text you top matches within the hour."
        : "I'm having trouble pulling up matches right now. I've alerted our care team so a real person follows up with you."
      ).catch(() => {});
    }
    return "failed";
  }
}
