// ── Childcare matching eligibility gate (plan 2026-07-22-002, U6) ───────────
//
// THE hard-eligibility seam for childcare demand (R34/KTD11): every candidate
// set for a childcare job is filtered HERE — server-side — before any scoring,
// ranking, notification, application, or interview. The browser never receives
// an ineligible full candidate set; AI ranking receives only eligible
// candidates and approved features (ai/scoring.scoreChildcareCandidate).
//
// Layers, in order (all fail closed):
//   1. recheckChildcareProviderEligibility(uid, {context}) — the R28/R29
//      provider gate (screening, credentials, manual approval, policy
//      acceptance, jurisdiction, suspension, membership).
//   2. Capability fit: age-band coverage, service-category coverage, transport
//      evidence when the job requires transport (AE13).
//   3. Logistics fit: distance to the job's APPROXIMATE area and
//      availability-conflict checks.
//
// PRIVACY (R33/AE12): the public projections and outbound payload assertion in
// this module define the EXACT field surface childcare jobs/applications may
// expose — age bands, approximate area, schedule, rate, requirements, safe
// abstractions only. Child names, exact address, custody, pickup, emergency
// contacts, and health details are structurally excluded and rejected by
// assertChildSafeOutboundPayload. Match explanations pass through the scoring
// allowlist (sanitized by construction) — never raw evidence or internal
// eligibility reasons (R30).

import * as admin from "firebase-admin";
import {
  recheckChildcareProviderEligibility,
  loadChildcareVerticalProfile,
  type ChildcareEligibilityResult,
  type EligibilityRecheckContext,
} from "./providerEligibility";
import {
  haversineMiles,
  availabilityOverlap,
  scoreChildcareCandidate,
  type ChildcareScoredMatch,
  type ScoredMatch,
} from "../ai/scoring";
import { assertNoChildPii } from "./privacyAssertions";

export const CHILDCARE_MATCHING_VERSION = "childcare-matching-2026-07-23.1";

/**
 * Childcare jobs are NEVER status "open" — every senior sweep, board query,
 * nudge, and notifier selects on status == "open", so the distinct open status
 * is a structural guarantee that senior consumers cannot pick up childcare
 * demand by accident (senior paths stay byte-identical, zero query changes).
 * Childcare discovery selects on this status explicitly.
 */
export const CHILDCARE_JOB_OPEN_STATUS = "open_childcare";
export const CHILDCARE_JOB_CLOSED_STATUS = "closed";

export const MAX_CHILDCARE_MATCH_DISTANCE_MILES = 25;

export type MatchingSourceContract =
  | { careVertical: "child"; collection: "job_posts" | "clientIntakes"; id: string }
  | { careVertical: "senior"; collection: "clientIntakes"; id: string }
  | { careVertical: "senior"; legacyLatest: true };

/**
 * Bind matching to the assignment's declared vertical and source. Child
 * assignments never use account-level "latest intake" fallback. Existing
 * senior assignments may retain that fallback only when explicitly compatible.
 */
export function resolveMatchingSourceContract(
  assignment: Record<string, unknown>,
): MatchingSourceContract | null {
  const vertical = assignment.careVertical === "child" ? "child" : "senior";
  const sourceRef = typeof assignment.sourceRef === "string"
    ? assignment.sourceRef.trim()
    : "";
  if (sourceRef) {
    const match = /^(job_posts|clientIntakes)\/([A-Za-z0-9._-]{1,200})$/.exec(sourceRef);
    if (!match) return null;
    if (vertical === "senior" && match[1] !== "clientIntakes") return null;
    if (vertical === "senior") {
      return { careVertical: "senior", collection: "clientIntakes", id: match[2] };
    }
    return {
      careVertical: "child",
      collection: match[1] as "job_posts" | "clientIntakes",
      id: match[2],
    };
  }

  const intakeId = typeof assignment.intakeId === "string"
    ? assignment.intakeId.trim()
    : "";
  if (intakeId && vertical === "senior" && /^[A-Za-z0-9._-]{1,200}$/.test(intakeId)) {
    return { careVertical: "senior", collection: "clientIntakes", id: intakeId };
  }
  if (vertical === "senior" && assignment.seniorCompatible !== false) {
    return { careVertical: "senior", legacyLatest: true };
  }
  return null;
}

export function matchingSourceBelongsToAssignment(
  contract: MatchingSourceContract,
  source: Record<string, unknown>,
  clientId: string,
): boolean {
  const sourceOwner = String(source.clientId ?? source.userId ?? "").trim();
  if (sourceOwner !== clientId) return false;
  if (contract.careVertical === "child") return source.careVertical === "child";
  return source.careVertical === undefined || source.careVertical === null || source.careVertical === "senior";
}

/** Typed-vertical guard used by senior consumers for their explicit skips. */
export function isChildcareVerticalDoc(
  doc: Record<string, unknown> | null | undefined,
): boolean {
  return doc?.careVertical === "child";
}

// ── R33/AE12 public field surface ────────────────────────────────────────────

/**
 * EXACT public projection of a childcare job (discovery + family list
 * callables return these keys and nothing else — pinned by tests).
 */
export const CHILDCARE_JOB_PUBLIC_FIELDS = [
  "jobId",
  "careVertical",
  "title",
  "status",
  "disclosurePhase",
  "childCount",
  "ageBands",
  "serviceCategories",
  "requiredCredentials",
  "transportRequired",
  "schedule",
  "rate",
  "rateFlexible",
  "areaLabel",
  "approxLat",
  "approxLng",
  "jurisdictionState",
  "applicantCount",
  "createdAt",
] as const;

/** EXACT public projection of a childcare application (pinned by tests). */
export const CHILDCARE_APPLICATION_PUBLIC_FIELDS = [
  "applicationId",
  "careVertical",
  "jobId",
  "caregiverId",
  "status",
  "disclosurePhase",
  "appliedAt",
  "jobTitle",
  "areaLabel",
  "rate",
  "rateFlexible",
] as const;

/**
 * Reject any childcare-outbound payload carrying a child-sensitive key,
 * recursively. Throws — callers must build payloads that pass by construction.
 *
 * U13: this now DELEGATES to the canonical childcare/privacyAssertions library
 * (assertNoChildPii + PROHIBITED_CHILD_FIELD_KEYS) so the prohibited-key set has
 * a single source of truth across every R57 surface. Behavior is a superset of
 * the former U6 set (which is fully contained), and the thrown message still
 * contains the "prohibited key" substring the callers' tests pin.
 */
export function assertChildSafeOutboundPayload(payload: unknown, site: string): void {
  assertNoChildPii(payload, `outbound payload at ${site}`);
}

/** Public projection of a stored childcare job doc — exactly the public fields. */
export function projectChildcareJobPublic(
  jobId: string,
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const req = (doc.childRequirements ?? {}) as Record<string, unknown>;
  const projection: Record<string, unknown> = {
    jobId,
    careVertical: "child",
    title: doc.title ?? "Childcare",
    status: doc.status ?? null,
    disclosurePhase: doc.disclosurePhase ?? "public_listing",
    childCount: req.childCount ?? null,
    ageBands: Array.isArray(req.ageBands) ? req.ageBands : [],
    serviceCategories: Array.isArray(req.serviceCategories) ? req.serviceCategories : [],
    requiredCredentials: Array.isArray(req.requiredCredentials) ? req.requiredCredentials : [],
    transportRequired: req.transportRequired === true,
    schedule: doc.schedule ?? null,
    rate: doc.rate ?? null,
    rateFlexible: doc.rateFlexible === true,
    areaLabel: doc.areaLabel ?? null,
    approxLat: doc.approxLat ?? null,
    approxLng: doc.approxLng ?? null,
    jurisdictionState: doc.jurisdictionState ?? null,
    applicantCount: doc.applicantCount ?? 0,
    createdAt: doc.createdAt ?? null,
  };
  assertChildSafeOutboundPayload(projection, "projectChildcareJobPublic");
  return projection;
}

/** Public projection of a stored childcare application doc. */
export function projectChildcareApplicationPublic(
  applicationId: string,
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const projection: Record<string, unknown> = {
    applicationId,
    careVertical: "child",
    jobId: doc.jobId ?? null,
    caregiverId: doc.caregiverId ?? null,
    status: doc.status ?? null,
    disclosurePhase: doc.disclosurePhase ?? "application",
    appliedAt: doc.appliedAt ?? null,
    jobTitle: doc.jobTitle ?? "Childcare",
    areaLabel: doc.areaLabel ?? null,
    rate: doc.rate ?? null,
    rateFlexible: doc.rateFlexible === true,
  };
  assertChildSafeOutboundPayload(projection, "projectChildcareApplicationPublic");
  return projection;
}

// ── Fit evaluation (pure) ────────────────────────────────────────────────────

export type ChildcareFitIssue =
  | "age_band_uncovered"
  | "category_uncovered"
  | "transport_capability_missing"
  | "distance_exceeded"
  | "availability_conflict";

/** The job side of a fit check — built from the typed requirement projection. */
export interface ChildcareJobFitTarget {
  ageBands: string[];
  serviceCategories: string[];
  transportRequired: boolean;
  approxLat?: number | null;
  approxLng?: number | null;
  /** { days: string[], timeOfDay: string[] } — the job's coarse schedule. */
  schedule?: { days?: string[]; timeOfDay?: string[] } | null;
}

/** The candidate side — provider capability facts, never child data. */
export interface ChildcareCandidateFacts {
  caregiverUid: string;
  ageBands: string[];
  services: string[];
  /** Derived transport capability (providerEligibility — MVR-gated, AE13). */
  transportCapable: boolean;
  lat?: number;
  lng?: number;
  weeklyAvailability?: unknown;
  yearsChildcareExperience?: number | null;
  /** Per-vertical childcare rating (U8 reputation projection) — NEVER the
   *  senior caregivers.rating (R45). Absent until a childcare review exists. */
  childcareRatingAvg?: number | null;
}

function normSet(values: string[]): Set<string> {
  return new Set(values.map((v) => String(v).toLowerCase().trim()));
}

/** Build the scoring-shape client schedule from a job's coarse days/timeOfDay. */
export function jobScheduleToOverlapShape(
  schedule: { days?: string[]; timeOfDay?: string[] } | null | undefined,
): Record<string, string[]> | null {
  const days = Array.isArray(schedule?.days) ? schedule!.days! : [];
  const blocks = Array.isArray(schedule?.timeOfDay) ? schedule!.timeOfDay! : [];
  if (!days.length || !blocks.length) return null;
  const out: Record<string, string[]> = {};
  for (const day of days) {
    const key = String(day).toLowerCase().trim();
    if (key) out[key] = blocks.map((b) => String(b).toLowerCase().trim());
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Pure capability + logistics fit for one candidate against one childcare job.
 * Every issue is a machine-stable code; an empty list means the candidate fits.
 * Missing optional data (no coords, no schedule) never fabricates a conflict —
 * but a stated requirement (band/category/transport) is always enforced.
 */
export function evaluateChildcareJobFit(
  job: ChildcareJobFitTarget,
  candidate: ChildcareCandidateFacts,
  opts: { maxDistanceMiles?: number } = {},
): { fits: boolean; issues: ChildcareFitIssue[]; distanceMiles?: number; availabilityOverlap?: number } {
  const issues: ChildcareFitIssue[] = [];

  const providerBands = normSet(candidate.ageBands ?? []);
  for (const band of job.ageBands ?? []) {
    if (!providerBands.has(String(band).toLowerCase().trim())) {
      issues.push("age_band_uncovered");
      break;
    }
  }

  const providerServices = normSet(candidate.services ?? []);
  for (const cat of job.serviceCategories ?? []) {
    if (!providerServices.has(String(cat).toLowerCase().trim())) {
      issues.push("category_uncovered");
      break;
    }
  }

  if (job.transportRequired && candidate.transportCapable !== true) {
    issues.push("transport_capability_missing");
  }

  let distanceMiles: number | undefined;
  if (
    typeof job.approxLat === "number" && typeof job.approxLng === "number" &&
    typeof candidate.lat === "number" && typeof candidate.lng === "number"
  ) {
    distanceMiles = haversineMiles(job.approxLat, job.approxLng, candidate.lat, candidate.lng);
    const max = opts.maxDistanceMiles ?? MAX_CHILDCARE_MATCH_DISTANCE_MILES;
    if (distanceMiles !== undefined && distanceMiles > max) {
      issues.push("distance_exceeded");
    }
  }

  let overlap: number | undefined;
  const scheduleShape = jobScheduleToOverlapShape(job.schedule);
  if (scheduleShape && candidate.weeklyAvailability) {
    overlap = availabilityOverlap(candidate.weeklyAvailability, scheduleShape);
    if (overlap !== undefined && overlap <= 0) {
      issues.push("availability_conflict");
    }
  }

  return { fits: issues.length === 0, issues, distanceMiles, availabilityOverlap: overlap };
}

// ── Hard filter + ranking (the seam senior matching delegates to) ────────────

type FirestoreLike = Pick<admin.firestore.Firestore, "collection">;

export interface EligibleChildcareCandidate {
  caregiverUid: string;
  eligibility: ChildcareEligibilityResult;
  facts: ChildcareCandidateFacts;
  distanceMiles?: number;
  availabilityOverlap?: number;
}

export interface ChildcareCandidateFilterResult {
  eligible: EligibleChildcareCandidate[];
  /** Count only — exclusion REASONS never leave the server (R30). */
  excludedCount: number;
}

/** Default facts loader: caregiver doc coords + childcare vertical profile. */
async function loadCandidateFacts(
  caregiverUid: string,
  db: FirestoreLike,
): Promise<ChildcareCandidateFacts | null> {
  const [cgSnap, profile] = await Promise.all([
    db.collection("caregivers").doc(caregiverUid).get(),
    loadChildcareVerticalProfile(caregiverUid, db),
  ]);
  if (!cgSnap.exists || !profile) return null;
  const cg = (cgSnap.data() ?? {}) as Record<string, unknown>;
  const loc = (cg.location ?? {}) as Record<string, unknown>;
  const lat = (cg.latitude ?? loc.latitude ?? loc.lat) as number | undefined;
  const lng = (cg.longitude ?? loc.longitude ?? loc.lng) as number | undefined;
  return {
    caregiverUid,
    ageBands: Array.isArray(profile.ageBands) ? (profile.ageBands as string[]) : [],
    services: Array.isArray(profile.services) ? (profile.services as string[]) : [],
    transportCapable: false, // authoritative value comes from the eligibility result
    ...(typeof lat === "number" ? { lat } : {}),
    ...(typeof lng === "number" ? { lng } : {}),
    weeklyAvailability: cg.weeklyAvailability,
    yearsChildcareExperience:
      typeof profile.yearsChildcareExperience === "number" ? profile.yearsChildcareExperience : null,
    // U8 per-vertical reputation (R45): read ONLY the childcare summary —
    // the senior cg.rating field is deliberately not consulted here.
    childcareRatingAvg: (() => {
      const rep = cg.childcareReputationSummary as Record<string, unknown> | undefined;
      return rep && typeof rep.ratingAvg === "number" && (rep.ratingCount as number) > 0
        ? rep.ratingAvg
        : null;
    })(),
  };
}

export interface FilterEligibleChildcareCandidatesParams {
  jobFit: ChildcareJobFitTarget;
  candidateUids: string[];
  /** R29 recheck context: discovery | contact | application | interview | … */
  context: EligibilityRecheckContext;
  db?: FirestoreLike;
  now?: Date;
  /** Injectable for tests; defaults to the live R29 seam. */
  recheck?: typeof recheckChildcareProviderEligibility;
  /** Injectable for tests; defaults to the caregiver-doc + vertical-profile loader. */
  loadFacts?: (uid: string, db: FirestoreLike) => Promise<ChildcareCandidateFacts | null>;
}

/**
 * THE candidate hard filter (KTD11): provider eligibility recheck first, then
 * capability/logistics fit — BEFORE any scoring or notification. Fails closed
 * per candidate: a recheck error, missing profile, or missing facts excludes.
 */
export async function filterEligibleChildcareCandidates(
  params: FilterEligibleChildcareCandidatesParams,
): Promise<ChildcareCandidateFilterResult> {
  const db = params.db ?? admin.firestore();
  const recheck = params.recheck ?? recheckChildcareProviderEligibility;
  const loadFacts = params.loadFacts ?? loadCandidateFacts;

  const eligible: EligibleChildcareCandidate[] = [];
  let excludedCount = 0;

  for (const caregiverUid of params.candidateUids) {
    try {
      const eligibility = await recheck(caregiverUid, {
        context: params.context,
        db,
        now: params.now,
      });
      if (!eligibility.eligible) {
        excludedCount++;
        continue;
      }
      const facts = await loadFacts(caregiverUid, db);
      if (!facts) {
        excludedCount++;
        continue;
      }
      // Transport capability is authoritative from the eligibility result
      // (MVR-evidence-gated — AE13), never a self-declared profile flag.
      facts.transportCapable = eligibility.capabilities.transport === true;

      const fit = evaluateChildcareJobFit(params.jobFit, facts);
      if (!fit.fits) {
        excludedCount++;
        continue;
      }
      eligible.push({
        caregiverUid,
        eligibility,
        facts,
        distanceMiles: fit.distanceMiles,
        availabilityOverlap: fit.availabilityOverlap,
      });
    } catch (err) {
      // Fail closed per candidate — an error can never admit a provider.
      console.error(
        `[matchingEligibility] candidate ${caregiverUid} failed closed:`,
        err instanceof Error ? err.message : err,
      );
      excludedCount++;
    }
  }

  return { eligible, excludedCount };
}

/**
 * Rank ALREADY hard-filtered candidates with the childcare scorer (approved
 * features only — no cross-vertical reputation, R45). Returns sanitized
 * explanations by construction (the scorer emits allowlisted phrases only).
 */
export function rankEligibleChildcareCandidates(
  jobFit: ChildcareJobFitTarget,
  candidates: EligibleChildcareCandidate[],
): ChildcareScoredMatch[] {
  return candidates
    .map((c) =>
      scoreChildcareCandidate({
        caregiverId: c.caregiverUid,
        jobAgeBands: jobFit.ageBands,
        providerAgeBands: c.facts.ageBands,
        jobCategories: jobFit.serviceCategories,
        providerServices: c.facts.services,
        distanceMiles: c.distanceMiles,
        availabilityOverlap: c.availabilityOverlap,
        yearsChildcareExperience: c.facts.yearsChildcareExperience ?? undefined,
        // U8: the per-vertical childcare rating (the only reputation input the
        // childcare scorer accepts — R45).
        childcareRating: c.facts.childcareRatingAvg ?? undefined,
      }),
    )
    .sort((a, b) => b.score - a.score);
}

// ── Guarded branch target for the senior matching stack ─────────────────────
//
// matchJob.computeMatchesForIntake / aiMatching.runAiMatching delegate here
// when (and only when) the intake/assignment is typed careVertical:"child".
// Candidate retrieval, hard eligibility, and scoring all happen server-side;
// the result is mapped into the senior ScoredMatch shape so downstream
// writers (clientMatches, match_assignments) keep working unchanged.

function jobFitFromIntake(intakeData: Record<string, unknown>): ChildcareJobFitTarget {
  const req = (intakeData.childRequirements ?? {}) as Record<string, unknown>;
  const schedule = (intakeData.schedule ?? {}) as Record<string, unknown>;
  return {
    ageBands: Array.isArray(req.ageBands) ? (req.ageBands as string[]) : [],
    serviceCategories: Array.isArray(req.serviceCategories)
      ? (req.serviceCategories as string[])
      : [],
    transportRequired: req.transportRequired === true,
    approxLat: typeof intakeData.approxLat === "number" ? (intakeData.approxLat as number) : null,
    approxLng: typeof intakeData.approxLng === "number" ? (intakeData.approxLng as number) : null,
    schedule: {
      days: Array.isArray(schedule.days) ? (schedule.days as string[]) : [],
      timeOfDay: Array.isArray(schedule.timeOfDay) ? (schedule.timeOfDay as string[]) : [],
    },
  };
}

const CHILDCARE_INTAKE_CANDIDATE_LIMIT = 200;
const CHILDCARE_INTAKE_TOP_N = 20;

/**
 * Compute childcare matches for a typed-childcare intake. Pre-filters via the
 * derived visibility summary (server-owned), then hard-filters through the
 * R29 discovery recheck, then scores with approved features only. Output is
 * the senior ScoredMatch shape with sanitized reasons and zero senior-derived
 * fields (semanticScore 0 — childcare never consumes senior embeddings).
 */
export async function computeChildcareMatchesForIntake(
  intakeId: string,
  intakeData: Record<string, unknown>,
  opts: { db?: FirestoreLike; now?: Date } = {},
): Promise<ScoredMatch[]> {
  const db = opts.db ?? admin.firestore();
  const jobFit = jobFitFromIntake(intakeData);

  // Candidate retrieval is server-side: derived-visibility pre-filter only —
  // the authoritative gate is the per-candidate recheck below.
  const snap = await db
    .collection("caregivers")
    .where("childcareProvider.visible", "==", true)
    .limit(CHILDCARE_INTAKE_CANDIDATE_LIMIT)
    .get();

  const { eligible } = await filterEligibleChildcareCandidates({
    jobFit,
    candidateUids: snap.docs.map((d) => d.id),
    context: "discovery",
    db,
    now: opts.now,
  });

  const ranked = rankEligibleChildcareCandidates(jobFit, eligible);
  return ranked.slice(0, CHILDCARE_INTAKE_TOP_N).map((m) => ({
    caregiverId: m.caregiverId,
    score: m.score,
    reasons: m.reasons,
    redFlags: [],
    confidence: m.confidence,
    source: "fallback" as const,
    semanticScore: 0,
    hardSkillsScore: m.coverageScore,
    distanceScore: m.distanceScore,
    availabilityScore: m.availabilityScore,
    ratingScore: m.ratingScore,
    experienceScore: m.experienceScore,
  }));
}
