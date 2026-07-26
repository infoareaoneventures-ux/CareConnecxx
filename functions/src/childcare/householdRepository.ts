// ── Canonical household repository (childcare marketplace plan 2026-07-22-002, U2) ──
//
// R3: ONE canonical `households/{householdId}` record owns recipient membership
// and adult relationships. The primary adult UID may SEED the document ID (an
// idempotency scheme for creation), but phone, surname, payment method, family
// group, or shared address NEVER proves membership — and Firestore Rules never
// authorize from an ID derivable from the caller's UID; they get() the
// membership record (see firestore.rules).
//
// R7 / AE4 (the central invariant of this module): HOUSEHOLD MEMBERSHIP GRANTS
// NOTHING BY ITSELF. Every recipient permission is an explicit, independently
// revocable grant in `guardian_authorities` (childcare/guardianAuthority.ts).
// A membership row only says "this adult belongs to this household"; readers
// must never treat it as view/schedule/pickup/payment/anything authority.
//
// Phone-only family members (SMS-joined, no Firebase Auth) map to
// `provisional` memberships with ZERO grantable scopes until they authenticate
// (recordProvisionalPhoneMembership / promoteProvisionalMembership). No
// child-vertical data may EVER flow through the legacy phone-keyed
// family_groups readers (agents/familyGroupManager.ts — classified
// legacy-compat in the consumer manifest): a recycled phone number satisfies
// the phone-in-list rule there, which is exactly the risk this collection
// replaces.
//
// All writes are server-side (Admin SDK) — firestore.rules denies every
// browser write to households / household_memberships.

import * as admin from "firebase-admin";
import { createHash } from "crypto";
import type { CareVertical } from "../data/contract";

export const HOUSEHOLDS_COLLECTION = "households";
export const HOUSEHOLD_MEMBERSHIPS_COLLECTION = "household_memberships";

export type HouseholdStatus = "active" | "closed";
export type HouseholdMembershipRole = "primary" | "adult";
export type HouseholdMembershipStatus = "active" | "provisional" | "revoked" | "superseded";
export type HouseholdMembershipSource = "household_create" | "invite" | "sms_join" | "promotion";

export interface HouseholdDerivedSummary {
  /** Count of active, authenticated adult memberships. */
  activeAdultCount: number;
  /** Count of provisional (phone-only, unauthenticated) memberships. */
  provisionalMemberCount: number;
  /**
   * DERIVED CACHE (KTD3/R6): child IDs that currently have at least one active
   * guardian authority in this household. NEVER independently authorizing —
   * `guardian_authorities` is the only authority source; this list exists for
   * display/summary surfaces and carries a version so staleness is detectable.
   */
  childIdsWithActiveAuthority: string[];
  /** Care verticals represented in the household (children via authorities). */
  careVerticals: CareVertical[];
  /** Monotonic version of this summary (bumped on every recompute). */
  summaryVersion: number;
  computedAt: string;
}

export interface HouseholdDoc {
  householdId: string;
  primaryAdultUid: string;
  status: HouseholdStatus;
  /** Policy version in force when the household was created/last touched. */
  policyVersion: string | null;
  /**
   * Bumped transactionally whenever household-scoped access changes (authority
   * revocation fan-out, membership revocation). Derived projections carry the
   * accessVersion they were computed at; a mismatch means "stale, re-resolve".
   */
  accessVersion: number;
  derivedSummary?: HouseholdDerivedSummary;
  createdAt: string;
  updatedAt: string;
}

export interface HouseholdMembershipDoc {
  membershipId: string;
  householdId: string;
  /** Firebase Auth uid — null ONLY for provisional phone-only members. */
  adultUid: string | null;
  role: HouseholdMembershipRole;
  status: HouseholdMembershipStatus;
  /** sha256 hex of the E.164 phone (provisional memberships only — no raw phone). */
  provisionalPhoneHash?: string;
  source: HouseholdMembershipSource;
  invitedByUid?: string | null;
  /** Consent receipt version accepted at join (R23) — null until accepted. */
  consentVersion?: string | null;
  joinedAt: string | null;
  revokedAt?: string | null;
  revokedByUid?: string | null;
  createdAt: string;
  updatedAt: string;
}

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

function defaultDb(): Db {
  return admin.firestore();
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

// ── Deterministic document IDs ───────────────────────────────────────────────

/**
 * Household doc ID seeded from the primary adult's uid (R3: "the primary adult
 * UID may seed the ID"). Seeding is an idempotency scheme for creation only —
 * ownership is stable across primary transfer (the ID never re-keys), and
 * Rules NEVER derive access from this shape (membership get() only).
 */
export function householdDocId(primaryAdultUid: string): string {
  const uid = String(primaryAdultUid ?? "").trim();
  if (!uid) throw new Error("householdDocId: primaryAdultUid is required");
  return `hh_${uid}`;
}

export function membershipDocId(householdId: string, adultUid: string): string {
  if (!householdId || !adultUid) throw new Error("membershipDocId: householdId and adultUid are required");
  return `${householdId}__${adultUid}`;
}

/** sha256 hex of a normalized E.164 phone — provisional rows never store the raw phone. */
export function membershipPhoneHash(phone: string): string {
  return createHash("sha256").update(String(phone ?? "").trim()).digest("hex");
}

export function provisionalMembershipDocId(householdId: string, phone: string): string {
  if (!householdId || !String(phone ?? "").trim()) {
    throw new Error("provisionalMembershipDocId: householdId and phone are required");
  }
  return `${householdId}__prov_${membershipPhoneHash(phone).slice(0, 16)}`;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type HouseholdErrorCode =
  | "household_not_found"
  | "household_closed"
  | "household_owned_by_other"
  | "membership_not_found"
  | "membership_not_active"
  | "primary_membership_immutable"
  | "invalid_input";

export class HouseholdError extends Error {
  code: HouseholdErrorCode;
  constructor(code: HouseholdErrorCode, message?: string) {
    super(message ?? code);
    this.name = "HouseholdError";
    this.code = code;
  }
}

// ── Creation (idempotent, stable ownership) ─────────────────────────────────

export interface CreateHouseholdResult {
  household: HouseholdDoc;
  membership: HouseholdMembershipDoc;
  created: boolean;
}

/**
 * Create the canonical household for a primary adult plus their `primary`
 * membership, transactionally. Idempotent: re-running for the same uid returns
 * the existing household. A household doc whose primaryAdultUid does not match
 * the caller (ownership was transferred — the ID seed is NOT ownership) fails
 * closed with household_owned_by_other.
 */
export async function createHouseholdWithPrimaryMembership(
  primaryAdultUid: string,
  opts: { db?: Db; now?: Date; policyVersion?: string | null } = {},
): Promise<CreateHouseholdResult> {
  const db = opts.db ?? defaultDb();
  const uid = String(primaryAdultUid ?? "").trim();
  if (!uid) throw new HouseholdError("invalid_input", "primaryAdultUid is required");

  const householdId = householdDocId(uid);
  const householdRef = db.collection(HOUSEHOLDS_COLLECTION).doc(householdId);
  const membershipId = membershipDocId(householdId, uid);
  const membershipRef = db.collection(HOUSEHOLD_MEMBERSHIPS_COLLECTION).doc(membershipId);
  const ts = nowIso(opts.now);

  return db.runTransaction(async (tx) => {
    const [householdSnap, membershipSnap] = await Promise.all([
      tx.get(householdRef),
      tx.get(membershipRef),
    ]);

    if (householdSnap.exists) {
      const existing = (householdSnap.data() ?? {}) as HouseholdDoc;
      if (existing.primaryAdultUid !== uid) {
        // Ownership transferred off the seeding uid — the seed proves nothing.
        throw new HouseholdError("household_owned_by_other");
      }
      const membership = membershipSnap.exists
        ? ((membershipSnap.data() ?? {}) as HouseholdMembershipDoc)
        : buildPrimaryMembership(householdId, membershipId, uid, ts);
      if (!membershipSnap.exists) tx.set(membershipRef, membership);
      return { household: existing, membership, created: false };
    }

    const household: HouseholdDoc = {
      householdId,
      primaryAdultUid: uid,
      status: "active",
      policyVersion: opts.policyVersion ?? null,
      accessVersion: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    const membership = buildPrimaryMembership(householdId, membershipId, uid, ts);
    tx.set(householdRef, household);
    tx.set(membershipRef, membership);
    return { household, membership, created: true };
  });
}

function buildPrimaryMembership(
  householdId: string,
  membershipId: string,
  adultUid: string,
  ts: string,
): HouseholdMembershipDoc {
  return {
    membershipId,
    householdId,
    adultUid,
    role: "primary",
    status: "active",
    source: "household_create",
    invitedByUid: null,
    consentVersion: null,
    joinedAt: ts,
    createdAt: ts,
    updatedAt: ts,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getHousehold(
  householdId: string,
  db: Db = defaultDb(),
): Promise<HouseholdDoc | null> {
  if (!householdId) return null;
  const snap = await db.collection(HOUSEHOLDS_COLLECTION).doc(householdId).get();
  return snap.exists ? ((snap.data() ?? {}) as HouseholdDoc) : null;
}

export async function getMembership(
  householdId: string,
  adultUid: string,
  db: Db = defaultDb(),
): Promise<HouseholdMembershipDoc | null> {
  if (!householdId || !adultUid) return null;
  const snap = await db
    .collection(HOUSEHOLD_MEMBERSHIPS_COLLECTION)
    .doc(membershipDocId(householdId, adultUid))
    .get();
  return snap.exists ? ((snap.data() ?? {}) as HouseholdMembershipDoc) : null;
}

/** Active, authenticated (non-provisional) membership or null. */
export async function getActiveMembership(
  householdId: string,
  adultUid: string,
  db: Db = defaultDb(),
): Promise<HouseholdMembershipDoc | null> {
  const m = await getMembership(householdId, adultUid, db);
  return m && m.status === "active" && m.adultUid === adultUid ? m : null;
}

/** All membership rows of one household (equality-only query — no composite index). */
export async function listHouseholdMemberships(
  householdId: string,
  db: Db = defaultDb(),
): Promise<HouseholdMembershipDoc[]> {
  const snap = await db
    .collection(HOUSEHOLD_MEMBERSHIPS_COLLECTION)
    .where("householdId", "==", householdId)
    .get();
  return snap.docs.map((d) => (d.data() ?? {}) as HouseholdMembershipDoc);
}

/** All membership rows of one adult across households (equality-only query). */
export async function listMembershipsForAdult(
  adultUid: string,
  db: Db = defaultDb(),
): Promise<HouseholdMembershipDoc[]> {
  const snap = await db
    .collection(HOUSEHOLD_MEMBERSHIPS_COLLECTION)
    .where("adultUid", "==", adultUid)
    .get();
  return snap.docs.map((d) => (d.data() ?? {}) as HouseholdMembershipDoc);
}

// ── Provisional phone-only members (SMS-joined, no Firebase Auth) ────────────

/**
 * Record an SMS-joined family member as a PROVISIONAL membership: no adultUid,
 * ZERO grantable scopes, and structurally incapable of holding guardian
 * authority (guardianAuthority.ts requires an active authenticated membership
 * before any grant). Idempotent by deterministic doc ID. The raw phone is
 * never stored — only its sha256 hash (recycled-number risk: the hash is a
 * join hint, never an identity).
 */
export async function recordProvisionalPhoneMembership(
  householdId: string,
  phone: string,
  opts: { db?: Db; now?: Date; invitedByUid?: string | null } = {},
): Promise<HouseholdMembershipDoc> {
  const db = opts.db ?? defaultDb();
  const cleanPhone = String(phone ?? "").trim();
  if (!householdId || !cleanPhone) throw new HouseholdError("invalid_input");

  const membershipId = provisionalMembershipDocId(householdId, cleanPhone);
  const ref = db.collection(HOUSEHOLD_MEMBERSHIPS_COLLECTION).doc(membershipId);
  const ts = nowIso(opts.now);

  return db.runTransaction(async (tx) => {
    const householdSnap = await tx.get(db.collection(HOUSEHOLDS_COLLECTION).doc(householdId));
    if (!householdSnap.exists) throw new HouseholdError("household_not_found");
    const snap = await tx.get(ref);
    if (snap.exists) return (snap.data() ?? {}) as HouseholdMembershipDoc;

    const membership: HouseholdMembershipDoc = {
      membershipId,
      householdId,
      adultUid: null, // no Firebase Auth — provisional until authenticated
      role: "adult",
      status: "provisional",
      provisionalPhoneHash: membershipPhoneHash(cleanPhone),
      source: "sms_join",
      invitedByUid: opts.invitedByUid ?? null,
      consentVersion: null,
      joinedAt: null, // joins for real only on promotion
      createdAt: ts,
      updatedAt: ts,
    };
    tx.set(ref, membership);
    return membership;
  });
}

/**
 * Promote a provisional phone-only membership to a real authenticated one once
 * the adult signs in with Firebase Phone Auth and their verified token phone
 * matches (the CALLER must have verified token.phone_number === phone —
 * this repository trusts server-side callers, per the U4 wiring contract).
 * Grants still start at ZERO — promotion creates membership, never authority.
 */
export async function promoteProvisionalMembership(
  householdId: string,
  phone: string,
  adultUid: string,
  opts: { db?: Db; now?: Date; consentVersion?: string | null } = {},
): Promise<HouseholdMembershipDoc> {
  const db = opts.db ?? defaultDb();
  const cleanPhone = String(phone ?? "").trim();
  const uid = String(adultUid ?? "").trim();
  if (!householdId || !cleanPhone || !uid) throw new HouseholdError("invalid_input");

  const provisionalRef = db
    .collection(HOUSEHOLD_MEMBERSHIPS_COLLECTION)
    .doc(provisionalMembershipDocId(householdId, cleanPhone));
  const realRef = db
    .collection(HOUSEHOLD_MEMBERSHIPS_COLLECTION)
    .doc(membershipDocId(householdId, uid));
  const ts = nowIso(opts.now);

  return db.runTransaction(async (tx) => {
    const [provisionalSnap, realSnap] = await Promise.all([tx.get(provisionalRef), tx.get(realRef)]);
    if (!provisionalSnap.exists) throw new HouseholdError("membership_not_found");
    const provisional = (provisionalSnap.data() ?? {}) as HouseholdMembershipDoc;
    if (provisional.status !== "provisional") throw new HouseholdError("membership_not_active");

    if (realSnap.exists) {
      // Already promoted (retry) — converge.
      tx.set(provisionalRef, { ...provisional, status: "superseded", updatedAt: ts });
      return (realSnap.data() ?? {}) as HouseholdMembershipDoc;
    }

    const membership: HouseholdMembershipDoc = {
      membershipId: membershipDocId(householdId, uid),
      householdId,
      adultUid: uid,
      role: "adult",
      status: "active",
      source: "promotion",
      invitedByUid: provisional.invitedByUid ?? null,
      consentVersion: opts.consentVersion ?? null,
      joinedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    };
    tx.set(realRef, membership);
    tx.set(provisionalRef, { ...provisional, status: "superseded", updatedAt: ts });
    return membership;
  });
}

// ── Revocation ───────────────────────────────────────────────────────────────

/**
 * Revoke a membership row and bump the household accessVersion in the same
 * transaction. NOTE: revoking membership does NOT touch guardian authorities —
 * callers that intend a full lockout must also run the authority revocation
 * (guardianAuthority.revokeGuardianAuthority) which carries the R18 co-guardian
 * notice/dispute-hold contract. The primary membership is immutable here
 * (ownership transfer is an explicit future workflow, R16).
 */
export async function revokeMembership(
  householdId: string,
  adultUid: string,
  revokedByUid: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<HouseholdMembershipDoc> {
  const db = opts.db ?? defaultDb();
  const ref = db.collection(HOUSEHOLD_MEMBERSHIPS_COLLECTION).doc(membershipDocId(householdId, adultUid));
  const householdRef = db.collection(HOUSEHOLDS_COLLECTION).doc(householdId);
  const ts = nowIso(opts.now);

  return db.runTransaction(async (tx) => {
    const [snap, householdSnap] = await Promise.all([tx.get(ref), tx.get(householdRef)]);
    if (!snap.exists) throw new HouseholdError("membership_not_found");
    if (!householdSnap.exists) throw new HouseholdError("household_not_found");
    const membership = (snap.data() ?? {}) as HouseholdMembershipDoc;
    if (membership.role === "primary") throw new HouseholdError("primary_membership_immutable");
    if (membership.status === "revoked") return membership; // idempotent

    const updated: HouseholdMembershipDoc = {
      ...membership,
      status: "revoked",
      revokedAt: ts,
      revokedByUid,
      updatedAt: ts,
    };
    tx.set(ref, updated);
    const household = (householdSnap.data() ?? {}) as HouseholdDoc;
    tx.set(householdRef, {
      ...household,
      accessVersion: Number(household.accessVersion ?? 0) + 1,
      updatedAt: ts,
    });
    return updated;
  });
}

// ── Derived recipient/vertical summary (versioned cache, never authorizing) ──

/**
 * Recompute the household's derived summary from memberships + ACTIVE guardian
 * authorities. The result is a versioned display cache stored on the household
 * doc; it can never grant access (KTD3/R6 — guardian_authorities is the only
 * authority source). Queries are equality-only (no composite index).
 */
export async function recomputeHouseholdDerivedSummary(
  householdId: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<HouseholdDerivedSummary> {
  const db = opts.db ?? defaultDb();
  const householdRef = db.collection(HOUSEHOLDS_COLLECTION).doc(householdId);
  const householdSnap = await householdRef.get();
  if (!householdSnap.exists) throw new HouseholdError("household_not_found");

  const [memberSnap, authoritySnap] = await Promise.all([
    db.collection(HOUSEHOLD_MEMBERSHIPS_COLLECTION).where("householdId", "==", householdId).get(),
    db
      .collection("guardian_authorities")
      .where("householdId", "==", householdId)
      .where("state", "==", "active")
      .get(),
  ]);

  const memberships = memberSnap.docs.map((d) => (d.data() ?? {}) as HouseholdMembershipDoc);
  const childIds = [
    ...new Set(
      authoritySnap.docs
        .map((d) => String((d.data() ?? {}).childId ?? ""))
        .filter(Boolean),
    ),
  ].sort();

  const previous = ((householdSnap.data() ?? {}) as HouseholdDoc).derivedSummary;
  const summary: HouseholdDerivedSummary = {
    activeAdultCount: memberships.filter((m) => m.status === "active").length,
    provisionalMemberCount: memberships.filter((m) => m.status === "provisional").length,
    childIdsWithActiveAuthority: childIds,
    careVerticals: childIds.length > 0 ? ["child"] : [],
    summaryVersion: Number(previous?.summaryVersion ?? 0) + 1,
    computedAt: nowIso(opts.now),
  };

  await householdRef.set(
    { derivedSummary: summary, updatedAt: summary.computedAt },
    { merge: true },
  );
  return summary;
}
