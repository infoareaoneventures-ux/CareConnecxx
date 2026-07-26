// ── Childcare family-facing READ callables (plan 2026-07-22-002, U11 seam) ───
//
// v1 callables (deployed as v1-<name> via the firebase.json prefix):
//   listMyChildcareBookings, getChildcareBooking, listChildcareJobApplications,
//   listHouseholdMembers
//
// These are the four READ seams U11's UI wired but that were not yet exported.
// Each is a THIN, authorization-correct read that reuses the U2-U9 server logic
// (guardian authority as THE primitive, household membership records, the
// booking doc shape, the U6 public application projection + eligibility gate).
//
// Every callable stacks the R21 controls in the U2/U3/U7 order:
//   requireAppCheck → Auth → Firestore-resident childcare flags (R61, read) →
//   fail-closed rate limits → input bounds → object-level authorization
//   (checkAuthority / active-membership; NEVER a derived cache) →
//   enumeration-safe errors (not-found and not-authorized are indistinguishable).
//
// PRIVACY (binding U11 rules):
//   • Booking summaries carry the age-band-safe DISPLAY LABEL only — never DOB,
//     never an exact address (both live behind the assigned-caregiver-only
//     getChildcareBookingSafety / getChildcareBookingCoordination surfaces).
//     Projecting from the booking doc is address/DOB-free by construction.
//   • Application listings return the SAME safe public projection U6 exposes
//     (projectChildcareApplicationPublic) — never raw screening/PII — and drop
//     ineligible candidates per the U6 hard-filter posture (R34/KTD11).
//   • listHouseholdMembers enumerates the OTHER adults' per-child authorities.
//     This is the enumeration getMyHouseholdState deliberately omits, so it
//     carries its OWN gate (see AUTHZ note on the callable). Adult display
//     names are adult data (not child data) — the childSafe outbound assertion
//     is keyed for child payloads and is NOT applied to member rows.
//
// All four are equality-only queries + in-memory vertical filter/sort: no new
// composite index is required (audit:indexes stays green with no contract
// changes). Queries mirror the existing childcare read patterns
// (findChildcareBookingConflict, getMyHouseholdState, listMyChildcareJobs).

import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { checkRateLimit, type RateLimitConfig } from "../rateLimit";
import { getChildcareFlags } from "../config/featureFlags";
import { logAudit } from "../observability/auditLog";
import { childcareOnCall } from "./appCheckPolicy";
import {
  checkAuthority,
  getAuthority,
  listAuthoritiesForAdult,
  GuardianAuthorityError,
  GUARDIAN_AUTHORITIES_COLLECTION,
  type GuardianAuthorityDoc,
  type GuardianScope,
} from "./guardianAuthority";
import {
  getHousehold,
  getActiveMembership,
  listHouseholdMemberships,
  type HouseholdMembershipDoc,
} from "./householdRepository";
import {
  describeChildcareBookingStatus,
  type ChildcareBookingDoc,
} from "./bookingPolicy";
import { projectChildcareApplicationPublic } from "./matchingEligibility";
import { recheckChildcareProviderEligibility } from "./providerEligibility";

// ── Shared guard helpers (U2/U3/U7 middleware idiom) ─────────────────────────

const READ_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 60,
  keyPrefix: "rl:childcare:familyread:",
};

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

function defaultDb(): Db {
  return admin.firestore();
}

function requireAuth(context: functions.https.CallableContext): string {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  return context.auth.uid;
}

async function requireChildcareFlags(): Promise<void> {
  const flags = await getChildcareFlags();
  if (!flags.enabled) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Childcare features are not available yet.",
      { code: "childcare_disabled" },
    );
  }
}

async function enforceRateLimit(op: string, uid: string): Promise<void> {
  const result = await checkRateLimit(`${op}:${uid}`, READ_RATE);
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

function mapReadError(err: unknown): never {
  if (err instanceof functions.https.HttpsError) throw err;
  if (err instanceof GuardianAuthorityError) {
    if (err.code === "invalid_input") throw invalidArgument();
    throw permissionDenied();
  }
  console.error(
    "[familyReadCallables] unexpected error:",
    err instanceof Error ? err.name : "Error",
  );
  throw new functions.https.HttpsError("internal", "Something went wrong. Please try again.");
}

// ── Authority liveness helpers (scope-agnostic mirror of checkAuthority) ─────
//
// checkAuthority is scope-SPECIFIC. For the "holds any live authority on this
// child" reading (bookings visibility), we evaluate the SAME active / effective
// / expiry gates checkAuthority applies, scope-agnostic. This never reads a
// derived cache — only the authority record itself (R6).

function authorityIsLive(a: Partial<GuardianAuthorityDoc>, now: Date): boolean {
  if (a.state !== "active") return false;
  if (typeof a.effectiveAt === "string" && Date.parse(a.effectiveAt) > now.getTime()) return false;
  if (typeof a.expiresAt === "string" && a.expiresAt && Date.parse(a.expiresAt) <= now.getTime()) {
    return false;
  }
  return Array.isArray(a.scopes) && a.scopes.length > 0;
}

function authorityHasScopeLive(
  a: Partial<GuardianAuthorityDoc>,
  scope: GuardianScope,
  now: Date,
): boolean {
  return authorityIsLive(a, now) && Array.isArray(a.scopes) && a.scopes.includes(scope);
}

// ── Family-safe booking projection ───────────────────────────────────────────
//
// Age-band-safe DISPLAY LABEL only — never DOB, never an exact address (the
// booking doc carries neither; those live behind the assigned-caregiver-only
// safety/coordination reads). Field names match the U11 childcareAccess.ts
// ChildcareBookingSummary seam type exactly.

function projectFamilySafeBooking(b: ChildcareBookingDoc): Record<string, unknown> {
  const paymentState = b.paymentAuthorization?.state ?? "none";
  return {
    bookingId: b.bookingId,
    status: b.status,
    statusDescription: describeChildcareBookingStatus(b.status, b.paymentAuthorization?.state),
    stateVersion: typeof b.stateVersion === "number" ? b.stateVersion : null,
    caregiverId: b.caregiverId ?? null,
    caregiverName: b.caregiverName ?? null,
    recipientLabel: b.recipientLabel ?? null,
    childIds: Array.isArray(b.childIds) ? b.childIds : [],
    schedule: b.schedule ?? null,
    hourlyRate: typeof b.hourlyRate === "number" ? b.hourlyRate : null,
    paymentAuthorization: { state: paymentState },
    safetyAccessVersion: b.safetyAccessVersion ?? null,
    pendingChange: b.pendingChange ?? null,
  };
}

function bookingCreatedAtMs(b: ChildcareBookingDoc): number {
  const t = Date.parse(String(b.createdAt ?? ""));
  return Number.isFinite(t) ? t : 0;
}

// ── 1. listMyChildcareBookings ({ role: 'family' | 'provider' }) ─────────────
//
// family:   bookings where the caller holds LIVE authority (ANY scope) on at
//           least one child of the booking — sibling/co-guardian aware (AE1/AE4).
// provider: bookings where the caller is the assigned/requested caregiver.
//
// Both branches are equality-only queries + in-memory filter/sort (no composite
// index). Family reads by householdId (from the caller's own live authorities),
// then keeps only bookings touching a child the caller is authorized for.

export const listMyChildcareBookings = childcareOnCall("listMyChildcareBookings", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags();
  await enforceRateLimit("listMyChildcareBookings", uid);

  const role = data?.role === "provider" ? "provider" : data?.role === "family" ? "family" : null;
  if (!role) throw invalidArgument();

  try {
    const db = defaultDb();
    const now = new Date();

    if (role === "provider") {
      // Assigned/requested caregiver view (same query shape as the conflict
      // check: careVertical + caregiverId, equality-only).
      const snap = await db
        .collection("booking_requests")
        .where("careVertical", "==", "child")
        .where("caregiverId", "==", uid)
        .get();
      const bookings = snap.docs
        .map((d) => (d.data() ?? {}) as ChildcareBookingDoc)
        .sort((a, b) => bookingCreatedAtMs(b) - bookingCreatedAtMs(a))
        .map(projectFamilySafeBooking);
      return { success: true, role, bookings };
    }

    // Family view: the caller's LIVE authorities give both the childIds they
    // may see and the households to query (a booking's householdId always
    // equals its children's household).
    const authorities = await listAuthoritiesForAdult(uid, db);
    const authorizedChildIds = new Set<string>();
    const householdIds = new Set<string>();
    for (const a of authorities) {
      if (!authorityIsLive(a, now)) continue;
      if (a.childId) authorizedChildIds.add(a.childId);
      if (a.householdId) householdIds.add(a.householdId);
    }
    if (authorizedChildIds.size === 0) return { success: true, role, bookings: [] };

    const seen = new Set<string>();
    const collected: ChildcareBookingDoc[] = [];
    for (const householdId of householdIds) {
      const snap = await db
        .collection("booking_requests")
        .where("careVertical", "==", "child")
        .where("householdId", "==", householdId)
        .get();
      for (const doc of snap.docs) {
        if (seen.has(doc.id)) continue;
        const booking = (doc.data() ?? {}) as ChildcareBookingDoc;
        const childIds = Array.isArray(booking.childIds) ? booking.childIds : [];
        if (!childIds.some((c) => authorizedChildIds.has(c))) continue;
        seen.add(doc.id);
        collected.push(booking);
      }
    }
    const bookings = collected
      .sort((a, b) => bookingCreatedAtMs(b) - bookingCreatedAtMs(a))
      .map(projectFamilySafeBooking);
    return { success: true, role, bookings };
  } catch (err) {
    mapReadError(err);
  }
});

// ── 2. getChildcareBooking ({ bookingId }) ───────────────────────────────────
//
// Family-facing single booking. The caller must hold LIVE authority (ANY scope)
// on at least one child of the booking. Returns the family-safe summary only —
// NO safety projection payload (that is the caregiver-only
// getChildcareBookingSafety), NO exact address. Enumeration-safe: a wrong
// bookingId and a no-authority booking both raise the SAME permission error.

export const getChildcareBooking = childcareOnCall("getChildcareBooking", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags();
  await enforceRateLimit("getChildcareBooking", uid);

  const bookingId = String(data?.bookingId ?? "").trim();
  if (!bookingId || bookingId.length > 128) throw invalidArgument();

  try {
    const db = defaultDb();
    const now = new Date();
    const snap = await db.collection("booking_requests").doc(bookingId).get();
    if (!snap.exists) throw permissionDenied();
    const booking = (snap.data() ?? {}) as ChildcareBookingDoc;
    if (booking.careVertical !== "child") throw permissionDenied();

    // LIVE per-child authority (ANY scope) on at least one child — the derived
    // viewer cache is NEVER consulted (R6). A booking the caller has no live
    // authority for is indistinguishable from a missing one.
    const childIds = Array.isArray(booking.childIds) ? booking.childIds : [];
    let allowed = false;
    for (const childId of childIds) {
      const authority = await getAuthority(childId, uid, db);
      if (authority && authorityIsLive(authority, now)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) throw permissionDenied();

    return { success: true, booking: projectFamilySafeBooking(booking) };
  } catch (err) {
    mapReadError(err);
  }
});

// ── 3. listChildcareJobApplications ({ jobId }) ──────────────────────────────
//
// Family-facing. The caller must hold LIVE `schedule` authority on EVERY child
// of the job (the same per-child gate acceptChildcareApplication /
// createChildcareInterviewGated apply — a co-guardian who can schedule can see
// the applicant pool). Returns the U6 public application projection ONLY
// (projectChildcareApplicationPublic — never raw screening/PII) and drops
// ineligible pending candidates per the U6 hard-filter posture (R34/KTD11).

export const listChildcareJobApplications = childcareOnCall("listChildcareJobApplications", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags();
  await enforceRateLimit("listChildcareJobApplications", uid);

  const jobId = String(data?.jobId ?? "").trim();
  if (!jobId || jobId.length > 128) throw invalidArgument();

  try {
    const db = defaultDb();

    const jobSnap = await db.collection("job_posts").doc(jobId).get();
    if (!jobSnap.exists) throw permissionDenied();
    const job = (jobSnap.data() ?? {}) as Record<string, unknown>;
    if (job.careVertical !== "child") throw permissionDenied();

    // LIVE per-child `schedule` authority on EVERY child of the job (children
    // live in the server-only private/children doc). Enumeration-safe.
    const privSnap = await db
      .collection("job_posts")
      .doc(jobId)
      .collection("private")
      .doc("children")
      .get();
    const childIds = ((privSnap.data() ?? {}).childIds ?? []) as string[];
    if (!Array.isArray(childIds) || childIds.length === 0) throw permissionDenied();
    for (const childId of childIds) {
      const decision = await checkAuthority(uid, childId, "schedule", { db });
      if (!decision.allowed) throw permissionDenied();
    }

    // Applications for this job (equality-only; careVertical + jobId).
    const snap = await db
      .collection("job_applications")
      .where("careVertical", "==", "child")
      .where("jobId", "==", jobId)
      .get();

    const applications: Array<Record<string, unknown>> = [];
    for (const doc of snap.docs) {
      const appDoc = (doc.data() ?? {}) as Record<string, unknown>;
      const status = String(appDoc.status ?? "");
      const caregiverId = String(appDoc.caregiverId ?? "").trim();
      // U6 hard-filter posture: a PENDING candidate the family could act on must
      // be currently eligible — the browser never receives an ineligible
      // candidate (R34). Already-decided rows (accepted/rejected/withdrawn) are
      // historical state and stay visible regardless.
      if (status === "pending" && caregiverId) {
        const eligibility = await recheckChildcareProviderEligibility(caregiverId, {
          context: "application",
          db,
        });
        if (!eligibility.eligible) continue;
      }
      applications.push(projectChildcareApplicationPublic(doc.id, appDoc));
    }

    return { success: true, jobId, applications };
  } catch (err) {
    mapReadError(err);
  }
});

// ── 4. listHouseholdMembers ({ householdId }) ────────────────────────────────
//
// The OTHER adults in the household with their per-child authorities — the
// enumeration getMyHouseholdState deliberately omits (that callable returns the
// caller's OWN records only).
//
// AUTHZ (stricter correct reading of R7/R18 — documented):
//   R7/AE4 — household membership grants NOTHING by itself; authority is always
//   explicit. Enumerating who else holds authority over a household's children
//   is itself sensitive (it reveals the co-guardian graph), so it is NOT a plain
//   member capability. Only a MANAGER may enumerate other adults:
//     • the household primary adult, OR
//     • an active member holding LIVE `management` authority on ≥1 child.
//   A non-manager ACTIVE member gets their OWN record only (never a view of
//   other adults) — the stricter reading, returned gracefully (no scary error;
//   they already have their own record via getMyHouseholdState). A NON-member
//   gets the generic enumeration-safe permission error.
//
// Server-only read; the caller's own row is excluded from `members` (the panel
// shows "other adults" — the caller's own access renders from
// getMyHouseholdState). Provisional (phone-only) members hold zero authority and
// are omitted. Adult display names are adult data — the childSafe outbound
// assertion (keyed for CHILD payloads) is intentionally NOT applied here.

const MEMBER_VISIBLE_AUTHORITY_STATES = new Set<string>(["active", "dispute_hold"]);

export const listHouseholdMembers = childcareOnCall("listHouseholdMembers", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags();
  await enforceRateLimit("listHouseholdMembers", uid);

  const householdId = String(data?.householdId ?? "").trim();
  if (!householdId || householdId.length > 200) throw invalidArgument();

  try {
    const db = defaultDb();
    const now = new Date();

    // The caller must be an ACTIVE, authenticated member — enumeration-safe
    // (a non-member cannot distinguish "not a member" from "no such household").
    const household = await getHousehold(householdId, db);
    if (!household || household.status !== "active") throw permissionDenied();
    const callerMembership = await getActiveMembership(householdId, uid, db);
    if (!callerMembership) throw permissionDenied();

    // All authorities in the household (equality-only), grouped by adult.
    const authoritySnap = await db
      .collection(GUARDIAN_AUTHORITIES_COLLECTION)
      .where("householdId", "==", householdId)
      .get();
    const authoritiesByAdult = new Map<string, GuardianAuthorityDoc[]>();
    for (const doc of authoritySnap.docs) {
      const a = (doc.data() ?? {}) as GuardianAuthorityDoc;
      if (!a.adultUid) continue;
      const list = authoritiesByAdult.get(a.adultUid) ?? [];
      list.push(a);
      authoritiesByAdult.set(a.adultUid, list);
    }

    // Manager? primary adult, or a live `management` holder on any child.
    const isPrimary = household.primaryAdultUid === uid;
    const isManager =
      isPrimary ||
      (authoritiesByAdult.get(uid) ?? []).some((a) => authorityHasScopeLive(a, "management", now));

    const memberships = await listHouseholdMemberships(householdId, db);

    const buildRow = async (m: HouseholdMembershipDoc): Promise<Record<string, unknown>> => {
      const adultUid = m.adultUid as string;
      const auths = (authoritiesByAdult.get(adultUid) ?? [])
        .filter((a) => MEMBER_VISIBLE_AUTHORITY_STATES.has(String(a.state)))
        .map((a) => ({
          childId: a.childId,
          scopes: Array.isArray(a.scopes) ? a.scopes : [],
          state: a.state,
          expiresAt: a.expiresAt ?? null,
          accessVersion: typeof a.accessVersion === "number" ? a.accessVersion : null,
        }));
      // Adult display name (adult data — NOT child data). Best-effort.
      let displayLabel: string | null = null;
      try {
        const userSnap = await db.collection("users").doc(adultUid).get();
        const u = (userSnap.data() ?? {}) as Record<string, unknown>;
        const name = u.name ?? u.displayName ?? u.firstName ?? null;
        displayLabel = typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : null;
      } catch {
        displayLabel = null;
      }
      return {
        adultUid,
        displayLabel,
        role: m.role,
        membershipStatus: m.status,
        authorities: auths,
      };
    };

    // Non-manager active member: OWN record only (stricter R7/R18 reading).
    if (!isManager) {
      const own = memberships.find(
        (m) => m.adultUid === uid && m.status === "active",
      );
      const members = own ? [await buildRow(own)] : [];
      await logAudit({
        eventType: "childcare_household_members_listed",
        userId: uid,
        data: { householdId, scope: "self_only", count: members.length },
      }).catch(() => {});
      return { success: true, householdId, isManager: false, members };
    }

    // Manager: every OTHER active authenticated adult (self excluded — the
    // caller's own access renders from getMyHouseholdState; provisional
    // phone-only members hold no authority and are omitted).
    const rows: Array<Record<string, unknown>> = [];
    for (const m of memberships) {
      if (!m.adultUid || m.adultUid === uid) continue;
      if (m.status !== "active") continue;
      rows.push(await buildRow(m));
    }
    await logAudit({
      eventType: "childcare_household_members_listed",
      userId: uid,
      data: { householdId, scope: "manager", count: rows.length },
    }).catch(() => {});
    return { success: true, householdId, isManager: true, members: rows };
  } catch (err) {
    mapReadError(err);
  }
});
