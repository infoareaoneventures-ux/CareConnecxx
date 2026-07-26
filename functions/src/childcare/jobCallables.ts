// ── Childcare job / application / interview callables (plan 2026-07-22-002, U6) ──
//
// v1 callables (deployed as v1-<name> via the firebase.json prefix):
//   createChildcareJobPost, updateChildcareJobPost, closeChildcareJobPost,
//   listMyChildcareJobs, applyToChildcareJob, listEligibleChildcareJobs,
//   requestChildcareInterview
//
// Every callable stacks the R21 controls in the U2/U3 order: requireAppCheck →
// Auth → Firestore-resident childcare flags (R61) → fail-closed rate limits →
// input bounds + idempotency → object-level authorization → enumeration-safe
// errors.
//
// STRUCTURAL CONTRACTS:
//   • R32: childcare jobs are auto-ID job_posts docs (deterministic
//     create-once IDs derived from clientId+idempotencyKey — never the legacy
//     singleton job_postings/{clientUid}, which this module NEVER writes; the
//     mirror writers carry their own reject guard, see jobPostContract.ts).
//   • R33/AE12: the stored childcare job doc IS the safe public projection —
//     age bands, approximate area (server-side geocode, coords rounded),
//     schedule, rate, requirements, safe abstractions only. Child linkage
//     (childIds/householdId) lives in job_posts/{id}/private/children, which
//     has NO rules match block → deny-all catch-all → server-only.
//   • R34/KTD11: hard eligibility (recheckChildcareProviderEligibility +
//     matchingEligibility fit) runs BEFORE discovery results, application
//     writes, notification fan-out, and interview creation. The browser never
//     receives an ineligible candidate set — candidate retrieval is entirely
//     server-side.
//   • R35: interviews are adult-to-adult video_interviews docs, vertical-
//     stamped, gated on family identity + per-child schedule authority +
//     provider eligibility (context "interview") + disclosure policy; the doc
//     carries NO child-sensitive data (assertChildSafeOutboundPayload).
//   • Deferred categories (overnight/medication/infant/specialized) are
//     hard-blocked at job creation; an infant-age-band child requires the
//     deferred infant_care package and is blocked the same way.
//   • Childcare jobs use status CHILDCARE_JOB_OPEN_STATUS ("open_childcare"),
//     never "open" — every senior sweep/board/nudge selects status=="open",
//     so senior consumers structurally cannot pick up childcare demand.

import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { createHash } from "crypto";
import { checkRateLimit, type RateLimitConfig } from "../rateLimit";
import { getChildcareFlags } from "../config/featureFlags";
import { logAudit } from "../observability/auditLog";
import { childcareOnCall } from "./appCheckPolicy";
import { checkAuthority, GuardianAuthorityError } from "./guardianAuthority";
import { getChildProfile, ChildProfileError } from "../data/childProfileRepository";
import {
  assertEnableableChildcareCategory,
  evaluatePolicyReadiness,
  loadJurisdictionPolicy,
  normalizeStateCode,
} from "./jurisdictionPolicy";
import {
  recheckChildcareProviderEligibility,
  type EligibilityRecheckContext,
} from "./providerEligibility";
import {
  CHILDCARE_JOB_OPEN_STATUS,
  CHILDCARE_JOB_CLOSED_STATUS,
  assertChildSafeOutboundPayload,
  evaluateChildcareJobFit,
  filterEligibleChildcareCandidates,
  projectChildcareJobPublic,
  projectChildcareApplicationPublic,
  type ChildcareJobFitTarget,
  CHILDCARE_MATCHING_VERSION,
} from "./matchingEligibility";
import { CHILDCARE_IDENTITY_SESSIONS_COLLECTION } from "./identityCallables";
import { familyChildcareObjectiveId } from "./signupIngress";
import { geocodeZip, geocodeCity } from "../utils/geocode";

// ── Shared guard helpers (U2/U3 middleware idiom) ────────────────────────────

const CHILDCARE_JOB_MUTATION_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: "rl:childcare:job:mut:",
};
const CHILDCARE_JOB_READ_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 60,
  keyPrefix: "rl:childcare:job:read:",
};

type FirestoreLike = Pick<admin.firestore.Firestore, "collection">;

function requireAuth(context: functions.https.CallableContext): string {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  return context.auth.uid;
}

async function requireChildcareFlags(kind: "read" | "write" | "discovery"): Promise<void> {
  const flags = await getChildcareFlags();
  const ok =
    kind === "write" ? flags.writesEnabled :
    kind === "discovery" ? flags.discoveryEnabled :
    flags.enabled;
  if (!ok) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Childcare features are not available yet.",
      { code: "childcare_disabled" },
    );
  }
}

async function enforceRateLimit(op: string, uid: string, config: RateLimitConfig): Promise<void> {
  const result = await checkRateLimit(`${op}:${uid}`, config);
  if (!result.allowed) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Too many requests. Please wait a moment and try again.",
    );
  }
}

/** ONE generic error for every not-found/not-authorized shape (enumeration-safe). */
function permissionDenied(): functions.https.HttpsError {
  return new functions.https.HttpsError(
    "permission-denied",
    "You do not have permission to perform this action.",
  );
}

function invalidArgument(): functions.https.HttpsError {
  return new functions.https.HttpsError("invalid-argument", "Invalid request.");
}

function mapJobError(err: unknown): never {
  if (err instanceof functions.https.HttpsError) throw err;
  if (err instanceof GuardianAuthorityError || err instanceof ChildProfileError) {
    if ((err as { code?: string }).code === "invalid_input") throw invalidArgument();
    throw permissionDenied();
  }
  console.error("[jobCallables] unexpected error:", err instanceof Error ? err.name : "Error");
  throw new functions.https.HttpsError("internal", "Something went wrong. Please try again.");
}

// ── Doc IDs (deterministic create-once — auto-ID semantics, R32/AE15) ────────

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

/** One job per (client, idempotencyKey) — NEVER the legacy job_postings/{uid} singleton. */
export function childcareJobDocId(clientUid: string, idempotencyKey: string): string {
  return `cjob_${sha1(`${clientUid}|${idempotencyKey}`)}`;
}

/** One application per (job, caregiver) — the duplicate-application guard. */
export function childcareApplicationDocId(jobId: string, caregiverUid: string): string {
  return `capp_${sha1(`${jobId}|${caregiverUid}`)}`;
}

/** One interview request per (job, caregiver) — duplicate-request guard. */
export function childcareInterviewDocId(jobId: string, caregiverUid: string): string {
  return `cint_${sha1(`${jobId}|${caregiverUid}`)}`;
}

// ── Input normalization ──────────────────────────────────────────────────────

const MAX_CHILDREN_PER_JOB = 6;
const MAX_LIST = 20;
const MAX_STR = 200;
const VALID_DAYS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);
const VALID_TIME_BLOCKS = new Set(["morning", "afternoon", "evening"]);

function cleanStringList(raw: unknown, allow?: (v: string) => boolean): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_LIST) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!t || t.length > MAX_STR) return null;
    if (allow && !allow(t)) return null;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

interface CleanSchedule {
  startDate: string | null;
  days: string[];
  timeOfDay: string[];
  daysPerWeek: number;
  frequency: string | null;
}

function cleanSchedule(raw: unknown): CleanSchedule | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r !== "object" || Array.isArray(r)) return null;
  const days = cleanStringList(r.days, (v) => VALID_DAYS.has(v.toLowerCase()));
  const timeOfDay = cleanStringList(r.timeOfDay, (v) => VALID_TIME_BLOCKS.has(v.toLowerCase()));
  if (days === null || timeOfDay === null) return null;
  // NOTE: "overnight" is intentionally NOT a valid childcare time block —
  // overnight care is a deferred category (scope boundary).
  const startDate = typeof r.startDate === "string" && r.startDate.trim()
    ? r.startDate.trim().slice(0, 64)
    : null;
  const frequency = typeof r.frequency === "string" && r.frequency.trim()
    ? r.frequency.trim().slice(0, 32)
    : null;
  return {
    startDate,
    days: days.map((d) => d.toLowerCase()),
    timeOfDay: timeOfDay.map((t) => t.toLowerCase()),
    daysPerWeek: days.length,
    frequency,
  };
}

// ── Approximate area (R33 — computed server-side, existing geocode patterns) ─

/** Coordinate rounding for the public listing: 2 decimals ≈ a ~1 mile cell. */
export function approximateCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface ApproximateArea {
  areaLabel: string;
  approxLat: number | null;
  approxLng: number | null;
}

/**
 * Server-side approximate area: geocode the adult-provided city/zip (never a
 * street address — the input surface has no address field), round coords to a
 * coarse cell, and label with "City, ST" only.
 */
export async function computeApproximateArea(params: {
  city: string;
  state: string;
  zipCode?: string | null;
}): Promise<ApproximateArea> {
  const areaLabel = `${params.city}, ${params.state}`;
  let coords: { lat: number; lng: number } | null = null;
  if (params.zipCode) coords = await geocodeZip(params.zipCode).catch(() => null);
  if (!coords) coords = await geocodeCity(params.city, params.state).catch(() => null);
  return {
    areaLabel,
    approxLat: coords ? approximateCoord(coords.lat) : null,
    approxLng: coords ? approximateCoord(coords.lng) : null,
  };
}

// ── createChildcareJobPost ───────────────────────────────────────────────────

export const createChildcareJobPost = childcareOnCall("createChildcareJobPost", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("createChildcareJobPost", uid, CHILDCARE_JOB_MUTATION_RATE);

  const idempotencyKey = String(data?.idempotencyKey ?? "").trim();
  const rawChildIds = Array.isArray(data?.childIds) ? data.childIds : null;
  if (!idempotencyKey || idempotencyKey.length > 128) throw invalidArgument();
  if (!rawChildIds || rawChildIds.length < 1 || rawChildIds.length > MAX_CHILDREN_PER_JOB) {
    throw invalidArgument();
  }
  const childIds: string[] = [];
  for (const raw of rawChildIds) {
    const id = String(raw ?? "").trim();
    if (!id || id.length > 128) throw invalidArgument();
    if (!childIds.includes(id)) childIds.push(id);
  }

  const schedule = cleanSchedule(data?.schedule);
  if (!schedule) throw invalidArgument();
  const hourlyRate = Number(data?.hourlyRate);
  if (!Number.isFinite(hourlyRate) || hourlyRate < 0 || hourlyRate > 500) throw invalidArgument();
  const transportRequired = data?.transportRequired === true;
  const city = String(data?.city ?? "").trim().slice(0, 80);
  const state = normalizeStateCode(String(data?.state ?? ""));
  const zipCode = typeof data?.zipCode === "string" ? data.zipCode.trim().slice(0, 10) : null;
  if (!city || !state) throw invalidArgument();

  const requestedCategories = cleanStringList(data?.serviceCategories);
  if (requestedCategories === null || requestedCategories.length === 0) throw invalidArgument();

  try {
    const db = admin.firestore();

    // 1. Guardian authority: the actor must hold LIVE 'schedule' scope for
    //    EVERY selected child (R6/AE1 — denial is enumeration-safe).
    for (const childId of childIds) {
      const decision = await checkAuthority(uid, childId, "schedule", { db });
      if (!decision.allowed) throw permissionDenied();
    }

    // 2. Privacy-safe requirement projection from the child OPERATIONAL docs:
    //    age bands + broad care categories ONLY (R33/AE12). Never names,
    //    DOB, address, health, custody, pickup, or emergency data.
    const ageBands: string[] = [];
    let householdId: string | null = null;
    for (const childId of childIds) {
      const profile = await getChildProfile(childId, db);
      if (!profile || profile.state !== "active") throw permissionDenied();
      if (householdId && profile.householdId !== householdId) throw permissionDenied();
      householdId = profile.householdId;
      if (profile.ageBand === "infant") {
        // Infant care is a DEFERRED category (no approved credential/policy
        // package) — an infant-band child cannot be posted (scope boundary).
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Care for this age group is not available yet.",
          { code: "deferred_category" },
        );
      }
      if (!ageBands.includes(profile.ageBand)) ageBands.push(profile.ageBand);
    }

    // 3. Deferred-category hard block + jurisdiction approval (R40/U1).
    for (const category of requestedCategories) {
      try {
        assertEnableableChildcareCategory(category);
      } catch {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "One of the requested care types is not available yet.",
          { code: "deferred_category" },
        );
      }
    }
    const policy = await loadJurisdictionPolicy(state, db);
    const policyIssues = evaluatePolicyReadiness(policy, { expectedState: state });
    if (policyIssues.length > 0) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Childcare is not available in this area yet.",
        { code: "jurisdiction_not_ready" },
      );
    }
    const approved = new Set((policy?.approvedServiceCategories ?? []).map((c) => String(c)));
    for (const category of requestedCategories) {
      if (!approved.has(category)) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "One of the requested care types is not available in this area yet.",
          { code: "category_not_approved" },
        );
      }
    }
    if (transportRequired && policy?.transport?.enabled !== true) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Transport is not available in this area yet.",
        { code: "transport_not_available" },
      );
    }

    // 4. Approximate area — server-side, coarse (R33).
    const area = await computeApproximateArea({ city, state, zipCode });

    // 5. Required credentials come from POLICY (server-derived), never client input.
    const requiredCredentials = Array.isArray(policy?.credentialRules?.requiredCredentials)
      ? (policy!.credentialRules!.requiredCredentials as string[])
      : [];

    const nowIso = new Date().toISOString();
    const jobId = childcareJobDocId(uid, idempotencyKey);
    const jobRef = db.collection("job_posts").doc(jobId);

    const jobDoc: Record<string, unknown> = {
      careVertical: "child",
      clientId: uid,
      source: "childcare_callable",
      title: `Childcare for ${childIds.length} ${childIds.length === 1 ? "child" : "children"}`,
      status: CHILDCARE_JOB_OPEN_STATUS,
      disclosurePhase: "public_listing",
      childRequirements: {
        childCount: childIds.length,
        ageBands: [...ageBands].sort(),
        serviceCategories: requestedCategories,
        requiredCredentials,
        transportRequired,
      },
      schedule: {
        startDate: schedule.startDate,
        days: schedule.days,
        timeOfDay: schedule.timeOfDay,
        daysPerWeek: schedule.daysPerWeek,
        frequency: schedule.frequency,
      },
      rate: hourlyRate,
      rateFlexible: hourlyRate === 0,
      areaLabel: area.areaLabel,
      approxLat: area.approxLat,
      approxLng: area.approxLng,
      jurisdictionState: state,
      policyVersion: policy?.policyVersion ?? null,
      matchingVersion: CHILDCARE_MATCHING_VERSION,
      applicantCount: 0,
      notifiedCount: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    // The stored doc IS the public surface — prove it carries nothing sensitive.
    assertChildSafeOutboundPayload(jobDoc, "createChildcareJobPost.jobDoc");

    // Create-once (idempotent): a duplicate call returns the existing job.
    const created = await db.runTransaction(async (tx) => {
      const existing = await tx.get(jobRef);
      if (existing.exists) return false;
      tx.set(jobRef, jobDoc);
      // Child linkage is SERVER-ONLY (no rules match block → deny-all).
      tx.set(jobRef.collection("private").doc("children"), {
        childIds,
        householdId,
        createdByUid: uid,
        idempotencyKey,
        createdAt: nowIso,
      });
      return true;
    });

    let notifiedCount = 0;
    if (created) {
      notifiedCount = await notifyEligibleChildcareProviders(jobId, jobDoc, db).catch((err) => {
        console.error("[createChildcareJobPost] notify fan-out failed:", err instanceof Error ? err.message : err);
        return 0;
      });
      await logAudit({
        eventType: "childcare_job_created",
        userId: uid,
        data: { jobId, childCount: childIds.length, state, notifiedCount },
      }).catch(() => {});
    }

    return {
      success: true,
      jobId,
      created,
      notifiedCount,
      job: projectChildcareJobPublic(jobId, created ? jobDoc : ((await jobRef.get()).data() ?? {})),
    };
  } catch (err) {
    mapJobError(err);
  }
});

// ── Eligibility-gated provider notification fan-out (R34: gate BEFORE notify) ─
//
// Generic, child-safe content only (R43/AE17): area label + care types. No
// child facts, no names, no exact location. In-app notification rows only —
// proactive childcare SMS is deferred to the classified U10 sources.

const NOTIFY_FANOUT_LIMIT = 50;

async function notifyEligibleChildcareProviders(
  jobId: string,
  jobDoc: Record<string, unknown>,
  db: FirestoreLike,
): Promise<number> {
  const flags = await getChildcareFlags();
  if (!flags.discoveryEnabled) return 0;

  const req = (jobDoc.childRequirements ?? {}) as Record<string, unknown>;
  const jobFit: ChildcareJobFitTarget = {
    ageBands: (req.ageBands as string[]) ?? [],
    serviceCategories: (req.serviceCategories as string[]) ?? [],
    transportRequired: req.transportRequired === true,
    approxLat: (jobDoc.approxLat as number | null) ?? null,
    approxLng: (jobDoc.approxLng as number | null) ?? null,
    schedule: (jobDoc.schedule as { days?: string[]; timeOfDay?: string[] }) ?? null,
  };

  // Derived-visibility pre-filter; the authoritative gate is the per-candidate
  // recheck inside filterEligibleChildcareCandidates (context "discovery").
  const snap = await db
    .collection("caregivers")
    .where("childcareProvider.visible", "==", true)
    .limit(200)
    .get();

  const { eligible } = await filterEligibleChildcareCandidates({
    jobFit,
    candidateUids: snap.docs.map((d) => d.id),
    context: "discovery",
    db,
  });

  const careText = jobFit.serviceCategories.length
    ? jobFit.serviceCategories.join(", ").replace(/_/g, " ")
    : "childcare";
  let notified = 0;
  for (const candidate of eligible.slice(0, NOTIFY_FANOUT_LIMIT)) {
    const payload = {
      title: "New childcare job near you",
      body:
        `A new childcare job (${careText}) in ${jobDoc.areaLabel ?? "your area"} matches ` +
        `your childcare profile. Sign in to view the details and apply.`,
      type: "childcare_job_match",
      jobId,
      isRead: false,
      createdAt: new Date().toISOString(),
    };
    assertChildSafeOutboundPayload(payload, "notifyEligibleChildcareProviders");
    await db
      .collection("users")
      .doc(candidate.caregiverUid)
      .collection("notifications")
      .add(payload)
      .then(() => { notified++; })
      .catch(() => {});
  }
  return notified;
}

// ── updateChildcareJobPost ───────────────────────────────────────────────────
//
// Owner-only, safe fields only: schedule, rate, transportRequired. There is NO
// free-text surface on a childcare job (R33/AE19 — nothing a client types can
// reach the public listing). Requirement projection (bands/categories) changes
// require a new post — children selection is bound at creation.

export const updateChildcareJobPost = childcareOnCall("updateChildcareJobPost", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("updateChildcareJobPost", uid, CHILDCARE_JOB_MUTATION_RATE);

  const jobId = String(data?.jobId ?? "").trim();
  if (!jobId || jobId.length > 128) throw invalidArgument();

  try {
    const db = admin.firestore();
    const jobRef = db.collection("job_posts").doc(jobId);
    const snap = await jobRef.get();
    if (!snap.exists) throw permissionDenied();
    const job = (snap.data() ?? {}) as Record<string, unknown>;
    if (job.careVertical !== "child" || job.clientId !== uid) throw permissionDenied();
    if (job.status !== CHILDCARE_JOB_OPEN_STATUS) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This job is no longer open.",
        { code: "job_not_open" },
      );
    }

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (data?.schedule !== undefined) {
      const schedule = cleanSchedule(data.schedule);
      if (!schedule) throw invalidArgument();
      updates.schedule = {
        startDate: schedule.startDate,
        days: schedule.days,
        timeOfDay: schedule.timeOfDay,
        daysPerWeek: schedule.daysPerWeek,
        frequency: schedule.frequency,
      };
    }
    if (data?.hourlyRate !== undefined) {
      const rate = Number(data.hourlyRate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 500) throw invalidArgument();
      updates.rate = rate;
      updates.rateFlexible = rate === 0;
    }
    if (data?.transportRequired !== undefined) {
      const req = { ...((job.childRequirements ?? {}) as Record<string, unknown>) };
      req.transportRequired = data.transportRequired === true;
      updates.childRequirements = req;
    }
    assertChildSafeOutboundPayload(updates, "updateChildcareJobPost.updates");
    await jobRef.update(updates);
    const after = ((await jobRef.get()).data() ?? {}) as Record<string, unknown>;
    return { success: true, job: projectChildcareJobPublic(jobId, after) };
  } catch (err) {
    mapJobError(err);
  }
});

// ── closeChildcareJobPost ────────────────────────────────────────────────────

export const closeChildcareJobPost = childcareOnCall("closeChildcareJobPost", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("closeChildcareJobPost", uid, CHILDCARE_JOB_MUTATION_RATE);

  const jobId = String(data?.jobId ?? "").trim();
  if (!jobId || jobId.length > 128) throw invalidArgument();

  try {
    const db = admin.firestore();
    const jobRef = db.collection("job_posts").doc(jobId);
    const snap = await jobRef.get();
    if (!snap.exists) throw permissionDenied();
    const job = (snap.data() ?? {}) as Record<string, unknown>;
    if (job.careVertical !== "child" || job.clientId !== uid) throw permissionDenied();

    if (job.status !== CHILDCARE_JOB_CLOSED_STATUS) {
      await jobRef.update({
        status: CHILDCARE_JOB_CLOSED_STATUS,
        closedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await logAudit({
        eventType: "childcare_job_closed",
        userId: uid,
        data: { jobId },
      }).catch(() => {});
    }
    return { success: true, jobId, status: CHILDCARE_JOB_CLOSED_STATUS };
  } catch (err) {
    mapJobError(err);
  }
});

// ── listMyChildcareJobs ──────────────────────────────────────────────────────

export const listMyChildcareJobs = childcareOnCall("listMyChildcareJobs", async (_data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("read");
  await enforceRateLimit("listMyChildcareJobs", uid, CHILDCARE_JOB_READ_RATE);

  try {
    const db = admin.firestore();
    // Query contract Q32 (clientId ASC, careVertical ASC, createdAt DESC).
    const snap = await db
      .collection("job_posts")
      .where("clientId", "==", uid)
      .where("careVertical", "==", "child")
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    const jobs = snap.docs.map((d) => projectChildcareJobPublic(d.id, d.data() ?? {}));
    return { success: true, jobs };
  } catch (err) {
    mapJobError(err);
  }
});

// ── listEligibleChildcareJobs (provider discovery — R29 context "discovery") ─

export const listEligibleChildcareJobs = childcareOnCall("listEligibleChildcareJobs", async (_data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("discovery");
  await enforceRateLimit("listEligibleChildcareJobs", uid, CHILDCARE_JOB_READ_RATE);

  try {
    const db = admin.firestore();

    // Hard eligibility BEFORE any job data leaves the server (R34/KTD11).
    // An ineligible provider gets an EMPTY result with their own remediation
    // codes (R30: own-view remediation is allowed; never someone else's).
    const eligibility = await recheckChildcareProviderEligibility(uid, {
      context: "discovery",
      db,
    });
    if (!eligibility.eligible) {
      return {
        success: true,
        eligible: false,
        remediation: eligibility.issues.map((i) => i.code),
        jobs: [],
      };
    }

    // Query contract Q33 (careVertical ASC, status ASC, createdAt DESC).
    const snap = await db
      .collection("job_posts")
      .where("careVertical", "==", "child")
      .where("status", "==", CHILDCARE_JOB_OPEN_STATUS)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    // Per-job capability/logistics fit — only jobs this provider can actually
    // serve (approved age bands / categories / transport / area) are returned.
    const facts = await loadProviderFacts(uid, db);
    const jobs: Array<Record<string, unknown>> = [];
    for (const doc of snap.docs) {
      const job = (doc.data() ?? {}) as Record<string, unknown>;
      const req = (job.childRequirements ?? {}) as Record<string, unknown>;
      const fit = evaluateChildcareJobFit(
        {
          ageBands: (req.ageBands as string[]) ?? [],
          serviceCategories: (req.serviceCategories as string[]) ?? [],
          transportRequired: req.transportRequired === true,
          approxLat: (job.approxLat as number | null) ?? null,
          approxLng: (job.approxLng as number | null) ?? null,
          schedule: (job.schedule as { days?: string[]; timeOfDay?: string[] }) ?? null,
        },
        { ...facts, transportCapable: eligibility.capabilities.transport === true },
      );
      if (fit.fits) jobs.push(projectChildcareJobPublic(doc.id, job));
    }

    return { success: true, eligible: true, jobs };
  } catch (err) {
    mapJobError(err);
  }
});

async function loadProviderFacts(
  caregiverUid: string,
  db: FirestoreLike,
): Promise<{
  caregiverUid: string;
  ageBands: string[];
  services: string[];
  transportCapable: boolean;
  lat?: number;
  lng?: number;
  weeklyAvailability?: unknown;
  yearsChildcareExperience?: number | null;
}> {
  const [cgSnap, profileSnap] = await Promise.all([
    db.collection("caregivers").doc(caregiverUid).get(),
    db.collection("caregivers").doc(caregiverUid).collection("vertical_profiles").doc("child").get(),
  ]);
  const cg = (cgSnap.data() ?? {}) as Record<string, unknown>;
  const profile = (profileSnap.data() ?? {}) as Record<string, unknown>;
  const loc = (cg.location ?? {}) as Record<string, unknown>;
  const lat = (cg.latitude ?? loc.latitude ?? loc.lat) as number | undefined;
  const lng = (cg.longitude ?? loc.longitude ?? loc.lng) as number | undefined;
  return {
    caregiverUid,
    ageBands: Array.isArray(profile.ageBands) ? (profile.ageBands as string[]) : [],
    services: Array.isArray(profile.services) ? (profile.services as string[]) : [],
    transportCapable: false,
    ...(typeof lat === "number" ? { lat } : {}),
    ...(typeof lng === "number" ? { lng } : {}),
    weeklyAvailability: cg.weeklyAvailability,
    yearsChildcareExperience:
      typeof profile.yearsChildcareExperience === "number"
        ? (profile.yearsChildcareExperience as number)
        : null,
  };
}

// ── applyToChildcareJob (provider side — R29 context "application") ──────────

export const applyToChildcareJob = childcareOnCall("applyToChildcareJob", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("applyToChildcareJob", uid, CHILDCARE_JOB_MUTATION_RATE);

  const jobId = String(data?.jobId ?? "").trim();
  if (!jobId || jobId.length > 128) throw invalidArgument();

  try {
    const db = admin.firestore();
    const jobRef = db.collection("job_posts").doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) throw permissionDenied();
    const job = (jobSnap.data() ?? {}) as Record<string, unknown>;
    if (job.careVertical !== "child") throw permissionDenied();
    if (job.status !== CHILDCARE_JOB_OPEN_STATUS) {
      // Withdrawn/closed job — explicit state, not an enumeration probe:
      // the job's existence is already public via discovery.
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This job is no longer accepting applications.",
        { code: "job_not_open" },
      );
    }

    // Hard eligibility at the APPLICATION transition (R29/R34) — a provider
    // whose screening expired or whose policy version drifted since discovery
    // fails HERE, before any write.
    const eligibility = await recheckChildcareProviderEligibility(uid, {
      context: "application",
      db,
    });
    if (!eligibility.eligible) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Your childcare profile is not currently eligible to apply.",
        { code: "provider_not_eligible" },
      );
    }

    // Capability/logistics fit — an eligible provider still can't apply to a
    // job whose requirements they don't meet (KTD11).
    const req = (job.childRequirements ?? {}) as Record<string, unknown>;
    const facts = await loadProviderFacts(uid, db);
    const fit = evaluateChildcareJobFit(
      {
        ageBands: (req.ageBands as string[]) ?? [],
        serviceCategories: (req.serviceCategories as string[]) ?? [],
        transportRequired: req.transportRequired === true,
        approxLat: (job.approxLat as number | null) ?? null,
        approxLng: (job.approxLng as number | null) ?? null,
        schedule: (job.schedule as { days?: string[]; timeOfDay?: string[] }) ?? null,
      },
      { ...facts, transportCapable: eligibility.capabilities.transport === true },
    );
    if (!fit.fits) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This job's requirements don't match your childcare profile.",
        { code: "job_requirements_not_met" },
      );
    }

    // Duplicate-application idempotency: one application per (job, caregiver).
    const applicationId = childcareApplicationDocId(jobId, uid);
    const appRef = db.collection("job_applications").doc(applicationId);
    const nowIso = new Date().toISOString();
    const appDoc: Record<string, unknown> = {
      careVertical: "child",
      jobId,
      caregiverId: uid,
      clientId: job.clientId,
      status: "pending",
      disclosurePhase: "application",
      appliedAt: nowIso,
      source: "childcare_callable",
      eligibilityVersion: eligibility.eligibilityVersion,
      evidenceVersion: eligibility.evidenceVersion,
      // Safe job snapshot (R33 abstractions only — no child facts, no phone).
      jobTitle: job.title ?? "Childcare",
      areaLabel: job.areaLabel ?? null,
      rate: job.rate ?? null,
      rateFlexible: job.rateFlexible === true,
    };
    assertChildSafeOutboundPayload(appDoc, "applyToChildcareJob.appDoc");

    const created = await db.runTransaction(async (tx) => {
      const existing = await tx.get(appRef);
      if (existing.exists) return false;
      tx.set(appRef, appDoc);
      return true;
    });

    if (created) {
      await logAudit({
        eventType: "childcare_application_created",
        userId: uid,
        data: { jobId, applicationId },
      }).catch(() => {});
    }

    return {
      success: true,
      applicationId,
      created,
      application: projectChildcareApplicationPublic(
        applicationId,
        created ? appDoc : (((await appRef.get()).data() ?? {}) as Record<string, unknown>),
      ),
    };
  } catch (err) {
    mapJobError(err);
  }
});

// ── requestChildcareInterview (family side — R35, both-sides gates) ──────────

export interface CreateChildcareInterviewParams {
  actorUid: string;
  jobId: string;
  caregiverId: string;
  caregiverName?: string | null;
  scheduledMs: number;
  db?: TxFirestoreLike;
}

type TxFirestoreLike = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

/**
 * The R35 both-sides interview gate, shared by v1-requestChildcareInterview
 * and the additive childcare branch of the legacy createVideoInterviewRequest
 * callable. Throws HttpsError; callers own middleware (auth/flags/rate).
 */
export async function createChildcareInterviewGated(
  params: CreateChildcareInterviewParams,
): Promise<{ interviewId: string; created: boolean; scheduledTime: string }> {
  const db = params.db ?? admin.firestore();
  const { actorUid: uid, jobId, caregiverId, scheduledMs } = params;

  // Family gate 1: job ownership + open state.
  const jobRef = db.collection("job_posts").doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) throw permissionDenied();
    const job = (jobSnap.data() ?? {}) as Record<string, unknown>;
    if (job.careVertical !== "child" || job.clientId !== uid) throw permissionDenied();
    if (job.status !== CHILDCARE_JOB_OPEN_STATUS) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This job is no longer open.",
        { code: "job_not_open" },
      );
    }

    // Family gate 2: identity (R35/R17 — verified acting adult). The childcare
    // identity session is keyed by the deterministic family objective ID.
    const identitySnap = await db
      .collection(CHILDCARE_IDENTITY_SESSIONS_COLLECTION)
      .doc(familyChildcareObjectiveId(uid))
      .get();
    if ((identitySnap.data() ?? {}).status !== "verified") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Identity verification is required before scheduling interviews.",
        { code: "identity_required" },
      );
    }

    // Family gate 3: LIVE per-child schedule authority — authority may have
    // been revoked or disputed since the job was posted (R19/AE20).
    const privSnap = await jobRef.collection("private").doc("children").get();
    const childIds = (privSnap.data()?.childIds ?? []) as string[];
    if (!childIds.length) throw permissionDenied();
    for (const childId of childIds) {
      const decision = await checkAuthority(uid, childId, "schedule", { db });
      if (!decision.allowed) throw permissionDenied();
    }

    // Provider gates: an application must exist (adult-to-adult context is
    // established through the gated application) AND the provider must pass
    // the R29 "interview" recheck RIGHT NOW — an expired/suspended/policy-
    // drifted provider fails here even with a pending application.
    const appSnap = await db
      .collection("job_applications")
      .doc(childcareApplicationDocId(jobId, caregiverId))
      .get();
    const application = (appSnap.data() ?? {}) as Record<string, unknown>;
    if (!appSnap.exists || application.status === "withdrawn" || application.status === "rejected") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This caregiver does not have an active application for this job.",
        { code: "no_active_application" },
      );
    }
    const eligibility = await recheckChildcareProviderEligibility(caregiverId, {
      context: "interview",
      db,
    });
    if (!eligibility.eligible) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This caregiver is not currently available for childcare interviews.",
        { code: "provider_not_eligible" },
      );
    }

    // Adult-to-adult interview doc (R35): vertical-stamped, disclosure-safe.
    // NO child-sensitive data, NO free-text notes, GENERIC display names —
    // the calendar/email/SMS content downstream (interviewLinkTrigger) uses
    // fully generic childcare titles/bodies.
    const interviewId = childcareInterviewDocId(jobId, caregiverId);
    const interviewRef = db.collection("video_interviews").doc(interviewId);
    const nowIso = new Date().toISOString();
    const interviewDoc: Record<string, unknown> = {
      careVertical: "child",
      clientId: uid,
      caregiverId,
      jobId,
      clientName: "An Evia family",
      caregiverName: String(params.caregiverName ?? "").trim().slice(0, 80) || "Caregiver",
      scheduledTime: new Date(scheduledMs).toISOString(),
      status: "requested",
      interviewType: "video",
      disclosurePhase: "interview",
      eligibilityVersion: eligibility.eligibilityVersion,
      createdAt: nowIso,
    };
    assertChildSafeOutboundPayload(interviewDoc, "createChildcareInterviewGated.interviewDoc");

    const created = await db.runTransaction(async (tx) => {
      const existing = await tx.get(interviewRef);
      if (existing.exists) return false;
      tx.set(interviewRef, interviewDoc);
      return true;
    });

    if (created) {
      await logAudit({
        eventType: "childcare_interview_requested",
        userId: uid,
        data: { jobId, interviewId, caregiverId },
      }).catch(() => {});
    }

    return {
      interviewId,
      created,
      scheduledTime: interviewDoc.scheduledTime as string,
    };
}

export const requestChildcareInterview = childcareOnCall("requestChildcareInterview", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("requestChildcareInterview", uid, CHILDCARE_JOB_MUTATION_RATE);

  const jobId = String(data?.jobId ?? "").trim();
  const caregiverId = String(data?.caregiverId ?? "").trim();
  const scheduledTime = String(data?.scheduledTime ?? "").trim();
  if (!jobId || jobId.length > 128 || !caregiverId || caregiverId.length > 128) throw invalidArgument();
  const scheduledMs = Date.parse(scheduledTime);
  if (!Number.isFinite(scheduledMs) || scheduledMs < Date.now() - 5 * 60 * 1000) throw invalidArgument();

  try {
    const result = await createChildcareInterviewGated({
      actorUid: uid,
      jobId,
      caregiverId,
      caregiverName: typeof data?.caregiverName === "string" ? data.caregiverName : null,
      scheduledMs,
    });
    return { success: true, ...result };
  } catch (err) {
    mapJobError(err);
  }
});

// Re-exported so the R29 seam contexts used here are visible to tests.
export type { EligibilityRecheckContext };
