// ── Versioned booking safety projection (plan 2026-07-22-002, U7 / KTD13, R38) ──
//
// `childcare_booking_safety/{bookingId}` is the pointer (current version +
// participant-access version + assigned caregiver); immutable minimum
// projections live at `childcare_booking_safety/{bookingId}/versions/{n}`.
// Both are FULLY server-only in firestore.rules — the assigned caregiver reads
// exclusively through v1-getChildcareBookingSafety.
//
// REVOKE-BEFORE-REPLACE BY CONSTRUCTION (AE6): the ONLY way to write a new
// version is createSafetyProjectionVersion(), whose single transaction bumps
// the pointer accessVersion FIRST-AND-ATOMICALLY with the new version write —
// every previously issued version is dead the instant a new one exists, and
// there is no API that grants without revoking. Substitution goes further:
// bookingCallables commits an explicit revoke (separate write) BEFORE
// validating the replacement, so the intermediate revoked-with-no-grant state
// is real and observable (the plan's substitution ordering test pins it).
//
// MINIMUM PROJECTION (R38/R10): built from the child's PRIVATE safety data via
// an explicit field allowlist — pickup rules, emergency contacts, care notes,
// plus the age-band-safe display label. Exact birth date, custody notes, and
// exact address are NEVER projected (custody/DOB are guardian-only zones;
// address handling is a U8/U9 coordination concern, deliberately outside this
// projection).
//
// STALENESS (R19/AE20): every version pins the child safety-source versions it
// was built from. Reads compare them to the child's CURRENT safety version —
// a pickup/safety change after projection denies with "stale_projection"
// (fail closed, live check). Authority changes additionally re-version
// through the U2 revocation fan-out (guardianAuthority outbox →
// reprojectActiveBookingSafetyForChild), so both paths converge.

import * as admin from "firebase-admin";
import {
  getChildProfile,
  getCurrentChildSafetyVersion,
  type ChildProfileDoc,
  type ChildSafetyVersionDoc,
} from "../data/childProfileRepository";
import {
  SAFETY_ACCESS_STATUSES,
  type ChildcareBookingDoc,
  type ChildcareBookingStatus,
} from "./bookingPolicy";
import type { AssignedProviderEligibilitySource } from "./childFileAccess";
import { logAudit } from "../observability/auditLog";

export const CHILDCARE_BOOKING_SAFETY_COLLECTION = "childcare_booking_safety";
export const CHILDCARE_BOOKING_SAFETY_VERSIONS_SUBCOLLECTION = "versions";

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

function defaultDb(): Db {
  return admin.firestore();
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type SafetyProjectionErrorCode =
  | "invalid_input"
  | "not_authorized"
  | "no_projection"
  | "revoked"
  | "stale_projection"
  | "booking_not_active"
  | "immutable_version";

export class SafetyProjectionError extends Error {
  code: SafetyProjectionErrorCode;
  constructor(code: SafetyProjectionErrorCode, message?: string) {
    super(message ?? code);
    this.name = "SafetyProjectionError";
    this.code = code;
  }
}

// ── The minimum projection (explicit allowlist — R38/R10) ────────────────────

/**
 * EXACT per-child field set of a booking safety projection. Anything not on
 * this list structurally cannot reach the assigned caregiver through this
 * module — the allowlist test asserts the exact set. Deliberately EXCLUDED:
 * dateOfBirth (R10 — band only), custodyNotes (guardian/operator zone),
 * addressDetail (not part of the minimum projection; see module header).
 */
export const CHILD_SAFETY_PROJECTION_FIELDS = [
  "childId",
  "displayLabel",
  "ageBand",
  "pickupNotes",
  "emergencyContacts",
  "healthNotes",
  "allergiesNote",
  "sourceSafetyVersion",
] as const;

export interface ChildSafetyProjection {
  childId: string;
  /** Age-band-safe display label from the operational doc. */
  displayLabel: string;
  ageBand: string;
  pickupNotes: string | null;
  emergencyContacts: Array<{ name: string; relationship: string; phone: string }>;
  healthNotes: string | null;
  allergiesNote: string | null;
  /** The private safety version this projection was built from. */
  sourceSafetyVersion: number;
}

// ── U9 coordination projection (assigned-caregiver exact-address delivery) ───
//
// Deferred from U7, landed in U9: the exact address + arrival notes the
// ASSIGNED caregiver needs to show up. Lives INSIDE the same immutable version
// doc as the safety projection (the "cleaner fit" the plan offers) so U7's
// revoke-first machinery — accessVersion bump on every revoke/replace,
// grantAccessVersion match on read — revokes address access IDENTICALLY on
// substitution/cancellation/authority change. Deliberately a SEPARATE section
// with a SEPARATE gated read (readBookingCoordination): coordination requires
// a confirmed/in_progress booking, while the safety read is available from
// acceptance. The address NEVER appears in chat messages, notifications, or
// logs (audit rows carry booking/version IDs only — R57).

/** EXACT per-child field set of the coordination projection (pinned by tests). */
export const CHILD_COORDINATION_PROJECTION_FIELDS = [
  "childId",
  "addressDetail",
  "arrivalNotes",
  "sourceSafetyVersion",
] as const;

export interface ChildCoordinationProjection {
  childId: string;
  /** Exact address from the child/household private zone (R38 minimum). */
  addressDetail: string | null;
  /** Arrival/pickup coordination notes from the private zone. */
  arrivalNotes: string | null;
  sourceSafetyVersion: number;
}

/** Coordination (exact address) requires an ACTIVE confirmed visit — tighter
 *  than SAFETY_ACCESS_STATUSES (which includes "accepted"). */
export const COORDINATION_ACCESS_STATUSES: readonly ChildcareBookingStatus[] = [
  "confirmed",
  "in_progress",
];

export interface BookingSafetyPointerDoc {
  bookingId: string;
  childIds: string[];
  assignedCaregiverUid: string | null;
  currentVersion: number;
  /** Participant-access version — bumped on EVERY revoke/replace (KTD13). */
  accessVersion: number;
  state: "active" | "revoked";
  revokedReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BookingSafetyVersionDoc {
  bookingId: string;
  version: number;
  /** The pointer accessVersion this version was granted under — reads require
   *  an exact match, so a revoke kills every outstanding version. */
  grantAccessVersion: number;
  children: ChildSafetyProjection[];
  /** U9 coordination section (exact address + arrival notes) — served ONLY by
   *  readBookingCoordination, never by the safety read. Versions created
   *  before U9 lack it; the coordination read denies them (re-projection on
   *  the next acceptance/authority-change produces a complete version). */
  coordination?: ChildCoordinationProjection[];
  createdByUid: string;
  immutable: true;
  createdAt: string;
}

export function bookingSafetyPointerRef(db: Db, bookingId: string) {
  return db.collection(CHILDCARE_BOOKING_SAFETY_COLLECTION).doc(bookingId);
}

export function bookingSafetyVersionRef(db: Db, bookingId: string, version: number) {
  return bookingSafetyPointerRef(db, bookingId)
    .collection(CHILDCARE_BOOKING_SAFETY_VERSIONS_SUBCOLLECTION)
    .doc(String(version));
}

// ── Builder (pure over loaded docs) ──────────────────────────────────────────

export function buildChildSafetyProjection(
  profile: Pick<ChildProfileDoc, "childId" | "displayLabel" | "ageBand">,
  safetyVersion: ChildSafetyVersionDoc | null,
): ChildSafetyProjection {
  const data = safetyVersion?.data;
  const rawContacts = Array.isArray(data?.emergencyContacts) ? data?.emergencyContacts ?? [] : [];
  return {
    childId: profile.childId,
    displayLabel: String(profile.displayLabel ?? "").slice(0, 80),
    ageBand: String(profile.ageBand ?? ""),
    pickupNotes: data?.pickupNotes ?? null,
    emergencyContacts: rawContacts.map((c) => ({
      name: String(c.name ?? ""),
      relationship: String(c.relationship ?? ""),
      phone: String(c.phone ?? ""),
    })),
    healthNotes: data?.healthNotes ?? null,
    allergiesNote: data?.allergiesNote ?? null,
    sourceSafetyVersion: Number(safetyVersion?.version ?? 0),
  };
}

/** U9: coordination sibling of buildChildSafetyProjection — exact allowlist. */
export function buildChildCoordinationProjection(
  profile: Pick<ChildProfileDoc, "childId">,
  safetyVersion: ChildSafetyVersionDoc | null,
): ChildCoordinationProjection {
  const data = safetyVersion?.data;
  return {
    childId: profile.childId,
    addressDetail: data?.addressDetail ?? null,
    arrivalNotes: data?.pickupNotes ?? null,
    sourceSafetyVersion: Number(safetyVersion?.version ?? 0),
  };
}

async function loadProjectionsForChildren(
  childIds: string[],
  db: Db,
): Promise<{ children: ChildSafetyProjection[]; coordination: ChildCoordinationProjection[] }> {
  const children: ChildSafetyProjection[] = [];
  const coordination: ChildCoordinationProjection[] = [];
  for (const childId of childIds) {
    const profile = await getChildProfile(childId, db);
    if (!profile || profile.state === "deleted") {
      throw new SafetyProjectionError("invalid_input", `child ${childId} is not projectable`);
    }
    const safetyVersion = await getCurrentChildSafetyVersion(childId, db);
    children.push(buildChildSafetyProjection(profile, safetyVersion));
    coordination.push(buildChildCoordinationProjection(profile, safetyVersion));
  }
  return { children, coordination };
}

// ── Create / replace (revoke-first by construction) ──────────────────────────

export interface CreateSafetyVersionParams {
  bookingId: string;
  childIds: string[];
  assignedCaregiverUid: string;
  createdByUid: string;
}

export interface CreateSafetyVersionResult {
  pointer: BookingSafetyPointerDoc;
  version: BookingSafetyVersionDoc;
}

/**
 * Create the next immutable safety version for a booking and (re)grant the
 * assigned caregiver. ONE transaction: accessVersion bump (revoking every
 * prior version) + immutable version write + pointer advance — there is no
 * grant-without-revoke path (AE6 by construction).
 */
export async function createSafetyProjectionVersion(
  params: CreateSafetyVersionParams,
  opts: { db?: Db; now?: Date } = {},
): Promise<CreateSafetyVersionResult> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ts = now.toISOString();
  const bookingId = String(params.bookingId ?? "").trim();
  const assignedCaregiverUid = String(params.assignedCaregiverUid ?? "").trim();
  const childIds = (params.childIds ?? []).map((c) => String(c).trim()).filter(Boolean);
  if (!bookingId || !assignedCaregiverUid || childIds.length === 0) {
    throw new SafetyProjectionError("invalid_input");
  }

  // Projections load OUTSIDE the transaction (reads of other docs), the
  // version/pointer write is transactional.
  const { children, coordination } = await loadProjectionsForChildren(childIds, db);

  const result = await db.runTransaction(async (tx) => {
    const pointerSnap = await tx.get(bookingSafetyPointerRef(db, bookingId));
    const prior = pointerSnap.exists
      ? ((pointerSnap.data() ?? {}) as BookingSafetyPointerDoc)
      : null;

    const nextVersion = Number(prior?.currentVersion ?? 0) + 1;
    // Revoke-before-replace: the accessVersion ALWAYS advances — outstanding
    // versions (grantAccessVersion < new) are dead the instant this commits.
    const nextAccessVersion = Number(prior?.accessVersion ?? 0) + 1;

    const versionRef = bookingSafetyVersionRef(db, bookingId, nextVersion);
    const versionSnap = await tx.get(versionRef);
    if (versionSnap.exists) {
      throw new SafetyProjectionError("immutable_version", `version ${nextVersion} already exists`);
    }

    const version: BookingSafetyVersionDoc = {
      bookingId,
      version: nextVersion,
      grantAccessVersion: nextAccessVersion,
      children,
      coordination,
      createdByUid: params.createdByUid,
      immutable: true,
      createdAt: ts,
    };
    const pointer: BookingSafetyPointerDoc = {
      bookingId,
      childIds,
      assignedCaregiverUid,
      currentVersion: nextVersion,
      accessVersion: nextAccessVersion,
      state: "active",
      revokedReason: null,
      createdAt: prior?.createdAt ?? ts,
      updatedAt: ts,
    };
    tx.set(versionRef, version);
    tx.set(bookingSafetyPointerRef(db, bookingId), pointer);
    return { pointer, version };
  });

  await logAudit({
    eventType: "childcare_safety_projection_created",
    userId: params.createdByUid,
    data: { bookingId, version: result.version.version, accessVersion: result.pointer.accessVersion },
  }).catch(() => {});
  return result;
}

/**
 * Revoke ALL safety access for a booking (cancellation, substitution step 1,
 * incident hold). Bumps the accessVersion and clears the assignment WITHOUT
 * creating a replacement version — the observable revoked-with-no-grant state.
 * Idempotent per reason: re-revoking an already revoked pointer only advances
 * the accessVersion (monotonic, still denies everything).
 */
export async function revokeSafetyProjectionAccess(
  bookingId: string,
  opts: { db?: Db; now?: Date; reason: string; byUid: string },
): Promise<BookingSafetyPointerDoc | null> {
  const db = opts.db ?? defaultDb();
  const ts = (opts.now ?? new Date()).toISOString();
  const cleanId = String(bookingId ?? "").trim();
  if (!cleanId) throw new SafetyProjectionError("invalid_input");

  const pointer = await db.runTransaction(async (tx) => {
    const snap = await tx.get(bookingSafetyPointerRef(db, cleanId));
    if (!snap.exists) return null; // nothing was ever granted — nothing to revoke
    const prior = (snap.data() ?? {}) as BookingSafetyPointerDoc;
    const next: BookingSafetyPointerDoc = {
      ...prior,
      assignedCaregiverUid: null,
      accessVersion: Number(prior.accessVersion ?? 0) + 1,
      state: "revoked",
      revokedReason: String(opts.reason ?? "").slice(0, 100) || "revoked",
      updatedAt: ts,
    };
    tx.set(bookingSafetyPointerRef(db, cleanId), next);
    return next;
  });

  if (pointer) {
    await logAudit({
      eventType: "childcare_safety_projection_revoked",
      userId: opts.byUid,
      data: { bookingId: cleanId, accessVersion: pointer.accessVersion, reason: pointer.revokedReason },
    }).catch(() => {});
  }
  return pointer;
}

// ── Gated read (assigned caregiver, current version only) ────────────────────

export interface ReadSafetyProjectionParams {
  bookingId: string;
  callerUid: string;
}

export interface ReadSafetyProjectionResult {
  bookingId: string;
  version: number;
  accessVersion: number;
  children: ChildSafetyProjection[];
}

type ProviderRecheck = (
  caregiverUid: string,
  opts: { context: "safety_read"; db?: Db },
) => Promise<{ eligible: boolean }>;

async function defaultProviderRecheck(
  caregiverUid: string,
  opts: { context: "safety_read"; db?: Db },
): Promise<{ eligible: boolean }> {
  const { recheckChildcareProviderEligibility } = await import("./providerEligibility");
  return recheckChildcareProviderEligibility(caregiverUid, {
    context: "safety_read",
    db: opts.db as never,
  });
}

/**
 * The R38 gated read: caller must be the CURRENT assigned caregiver, the
 * pointer active, the booking in a safety-access status, provider eligibility
 * current (context "safety_read"), the version's grantAccessVersion equal to
 * the pointer accessVersion, AND the projection not stale against the child's
 * live safety versions. Every failure is the SAME error class so unassigned /
 * revoked / stale probes are indistinguishable to the caller (R21 handled at
 * the callable layer).
 */
export async function readSafetyProjectionForCaregiver(
  params: ReadSafetyProjectionParams,
  opts: { db?: Db; now?: Date; providerRecheck?: ProviderRecheck } = {},
): Promise<ReadSafetyProjectionResult> {
  const db = opts.db ?? defaultDb();
  const bookingId = String(params.bookingId ?? "").trim();
  const callerUid = String(params.callerUid ?? "").trim();
  if (!bookingId || !callerUid) throw new SafetyProjectionError("invalid_input");

  const pointerSnap = await bookingSafetyPointerRef(db, bookingId).get();
  if (!pointerSnap.exists) throw new SafetyProjectionError("no_projection");
  const pointer = (pointerSnap.data() ?? {}) as BookingSafetyPointerDoc;
  if (pointer.state !== "active") throw new SafetyProjectionError("revoked");
  if (pointer.assignedCaregiverUid !== callerUid) throw new SafetyProjectionError("not_authorized");

  // Current booking state gate.
  const bookingSnap = await db.collection("booking_requests").doc(bookingId).get();
  const booking = (bookingSnap.data() ?? {}) as Partial<ChildcareBookingDoc>;
  if (
    !bookingSnap.exists ||
    booking.careVertical !== "child" ||
    booking.caregiverId !== callerUid ||
    !SAFETY_ACCESS_STATUSES.includes(booking.status as never)
  ) {
    throw new SafetyProjectionError("booking_not_active");
  }

  // Provider eligibility recheck (R29, context "safety_read" — fail closed).
  const recheck = opts.providerRecheck ?? defaultProviderRecheck;
  const eligibility = await recheck(callerUid, { context: "safety_read", db });
  if (!eligibility.eligible) throw new SafetyProjectionError("not_authorized");

  const versionSnap = await bookingSafetyVersionRef(db, bookingId, pointer.currentVersion).get();
  if (!versionSnap.exists) throw new SafetyProjectionError("no_projection");
  const version = (versionSnap.data() ?? {}) as BookingSafetyVersionDoc;

  // Access-version match: a revoke (or replace) since this version was minted
  // makes it dead, even if a stale pointer read raced.
  if (Number(version.grantAccessVersion) !== Number(pointer.accessVersion)) {
    throw new SafetyProjectionError("revoked");
  }

  // Live staleness check (R19/AE20): the projection must match the child's
  // CURRENT safety version — a pickup/safety change denies until reprojection.
  for (const child of version.children ?? []) {
    const profile = await getChildProfile(child.childId, db);
    if (!profile || profile.state === "deleted") throw new SafetyProjectionError("stale_projection");
    if (Number(profile.safetyCurrentVersion ?? 0) !== Number(child.sourceSafetyVersion ?? 0)) {
      throw new SafetyProjectionError("stale_projection");
    }
  }

  return {
    bookingId,
    version: version.version,
    accessVersion: pointer.accessVersion,
    children: version.children ?? [],
  };
}

// ── U9 gated coordination read (exact address — assigned caregiver / family) ─

export interface ReadBookingCoordinationParams {
  bookingId: string;
  callerUid: string;
  /** "provider" = assigned-caregiver gates; "family" = booking owner (the
   *  callable layer additionally requires checkAuthority 'view' per child). */
  callerRole: "provider" | "family";
}

export interface ReadBookingCoordinationResult {
  bookingId: string;
  version: number;
  accessVersion: number;
  coordination: ChildCoordinationProjection[];
}

/**
 * THE exact-address read (plan U9, deferred from U7). Provider path: current
 * assigned caregiver + ACTIVE pointer + booking in confirmed/in_progress +
 * R29 "safety_read" eligibility recheck + grantAccessVersion match + live
 * staleness check — identical revoke-first machinery as the safety read, so
 * substitution/cancellation/authority change kills address access the same
 * instant. Family path: the booking's family adult (clientId), same status
 * gate and version/staleness checks (no eligibility/assignment gates — the
 * address is their own household data; checkAuthority 'view' per child is
 * enforced by the callable). Every failure shape is the SAME error class —
 * enumeration-safe at the callable layer. Callers audit-log successful reads.
 */
export async function readBookingCoordination(
  params: ReadBookingCoordinationParams,
  opts: { db?: Db; now?: Date; providerRecheck?: ProviderRecheck } = {},
): Promise<ReadBookingCoordinationResult> {
  const db = opts.db ?? defaultDb();
  const bookingId = String(params.bookingId ?? "").trim();
  const callerUid = String(params.callerUid ?? "").trim();
  if (!bookingId || !callerUid) throw new SafetyProjectionError("invalid_input");

  const pointerSnap = await bookingSafetyPointerRef(db, bookingId).get();
  if (!pointerSnap.exists) throw new SafetyProjectionError("no_projection");
  const pointer = (pointerSnap.data() ?? {}) as BookingSafetyPointerDoc;
  if (pointer.state !== "active") throw new SafetyProjectionError("revoked");

  // Booking-state gate: confirmed/in_progress ONLY (tighter than safety read).
  const bookingSnap = await db.collection("booking_requests").doc(bookingId).get();
  const booking = (bookingSnap.data() ?? {}) as Partial<ChildcareBookingDoc>;
  if (
    !bookingSnap.exists ||
    booking.careVertical !== "child" ||
    !COORDINATION_ACCESS_STATUSES.includes(booking.status as never)
  ) {
    throw new SafetyProjectionError("booking_not_active");
  }

  if (params.callerRole === "provider") {
    if (pointer.assignedCaregiverUid !== callerUid || booking.caregiverId !== callerUid) {
      throw new SafetyProjectionError("not_authorized");
    }
    // Provider eligibility recheck (R29, context "safety_read" — fail closed).
    const recheck = opts.providerRecheck ?? defaultProviderRecheck;
    const eligibility = await recheck(callerUid, { context: "safety_read", db });
    if (!eligibility.eligible) throw new SafetyProjectionError("not_authorized");
  } else {
    if (booking.clientId !== callerUid) throw new SafetyProjectionError("not_authorized");
  }

  const versionSnap = await bookingSafetyVersionRef(db, bookingId, pointer.currentVersion).get();
  if (!versionSnap.exists) throw new SafetyProjectionError("no_projection");
  const version = (versionSnap.data() ?? {}) as BookingSafetyVersionDoc;
  if (Number(version.grantAccessVersion) !== Number(pointer.accessVersion)) {
    throw new SafetyProjectionError("revoked");
  }
  // Pre-U9 versions carry no coordination section — deny until re-projection.
  if (!Array.isArray(version.coordination) || version.coordination.length === 0) {
    throw new SafetyProjectionError("no_projection");
  }

  // Live staleness (R19/AE20): an address/pickup change denies until
  // re-projection — same contract as the safety read.
  for (const child of version.coordination) {
    const profile = await getChildProfile(child.childId, db);
    if (!profile || profile.state === "deleted") throw new SafetyProjectionError("stale_projection");
    if (Number(profile.safetyCurrentVersion ?? 0) !== Number(child.sourceSafetyVersion ?? 0)) {
      throw new SafetyProjectionError("stale_projection");
    }
  }

  return {
    bookingId,
    version: version.version,
    accessVersion: pointer.accessVersion,
    coordination: version.coordination,
  };
}

// ── Authority-change fan-out (wired into the U2 outbox effect) ───────────────

/**
 * Re-version every ACTIVE booking safety projection touching `childId`
 * (revoke-then-replace in one atomic step per booking; the assigned caregiver
 * keeps their assignment but every outstanding version dies and a fresh
 * projection replaces it). Called durably from guardianAuthority's
 * derived_access_invalidation outbox effect (R19/AE20) — an authority or
 * pickup change can never leave a stale projection readable.
 */
export async function reprojectActiveBookingSafetyForChild(
  childId: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<{ reprojected: number; revokedOnly: number }> {
  const db = opts.db ?? defaultDb();
  const cleanChildId = String(childId ?? "").trim();
  const result = { reprojected: 0, revokedOnly: 0 };
  if (!cleanChildId) return result;

  const snap = await db
    .collection(CHILDCARE_BOOKING_SAFETY_COLLECTION)
    .where("state", "==", "active")
    .where("childIds", "array-contains", cleanChildId)
    .get();

  for (const doc of snap.docs) {
    const pointer = (doc.data() ?? {}) as BookingSafetyPointerDoc;
    const assigned = pointer.assignedCaregiverUid;
    try {
      if (!assigned) {
        await revokeSafetyProjectionAccess(pointer.bookingId, {
          db,
          now: opts.now,
          reason: "authority_change",
          byUid: "system",
        });
        result.revokedOnly++;
        continue;
      }
      await createSafetyProjectionVersion(
        {
          bookingId: pointer.bookingId,
          childIds: pointer.childIds,
          assignedCaregiverUid: assigned,
          createdByUid: "system:authority_change",
        },
        { db, now: opts.now },
      );
      result.reprojected++;
    } catch (err) {
      // Fail SAFE: if the fresh projection cannot be built (child deleted,
      // legal hold), revoke instead of leaving the old version live.
      await revokeSafetyProjectionAccess(pointer.bookingId, {
        db,
        now: opts.now,
        reason: "authority_change_reprojection_failed",
        byUid: "system",
      }).catch(() => {});
      result.revokedOnly++;
      console.error(
        "[safetyProjection] reprojection failed — revoked instead (fail safe):",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
}

// ── The REAL assigned-provider eligibility source (replaces the U3 dark stub) ─

/**
 * U3 seam, now live: a provider is file-grant-eligible for a child iff they
 * are the CURRENT assigned caregiver on an ACTIVE booking safety pointer that
 * covers the child (assigned + current access version), the booking is in a
 * safety-access status, and provider eligibility is current. Fail closed on
 * every error.
 */
export function createBookingAssignedProviderSource(
  opts: { db?: Db; providerRecheck?: ProviderRecheck } = {},
): AssignedProviderEligibilitySource {
  return {
    async isAssignedProviderEligible(providerUid: string, childId: string) {
      try {
        const db = opts.db ?? defaultDb();
        const snap = await db
          .collection(CHILDCARE_BOOKING_SAFETY_COLLECTION)
          .where("assignedCaregiverUid", "==", providerUid)
          .where("state", "==", "active")
          .get();
        const pointers = snap.docs
          .map((d) => (d.data() ?? {}) as BookingSafetyPointerDoc)
          .filter((p) => Array.isArray(p.childIds) && p.childIds.includes(childId));
        for (const pointer of pointers) {
          const bookingSnap = await db.collection("booking_requests").doc(pointer.bookingId).get();
          const booking = (bookingSnap.data() ?? {}) as Partial<ChildcareBookingDoc>;
          if (
            !bookingSnap.exists ||
            booking.careVertical !== "child" ||
            booking.caregiverId !== providerUid ||
            !SAFETY_ACCESS_STATUSES.includes(booking.status as never)
          ) {
            continue;
          }
          const recheck = opts.providerRecheck ?? defaultProviderRecheck;
          const eligibility = await recheck(providerUid, { context: "safety_read", db });
          if (!eligibility.eligible) continue;
          return { eligible: true, bookingId: pointer.bookingId, reason: "assigned_current_booking" };
        }
        return { eligible: false, bookingId: null, reason: "no_active_assignment" };
      } catch (err) {
        console.error(
          "[safetyProjection] assigned-provider source error (fail closed):",
          err instanceof Error ? err.message : err,
        );
        return { eligible: false, bookingId: null, reason: "source_error_fail_closed" };
      }
    },
  };
}
