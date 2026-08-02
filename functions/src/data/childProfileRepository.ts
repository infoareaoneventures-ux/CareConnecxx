// ── Child profile repository (childcare marketplace plan 2026-07-22-002, U3) ──
//
// Canonical child data zones (R9-R16, KTD7):
//
//   • `child_profiles/{childId}` — OPERATIONAL SUMMARY only: display label,
//     age BAND (never exact DOB), household, broad care categories, state,
//     derived authority projection, retention policy version. No exact birth
//     date, no address, no health detail, and STRUCTURALLY no child contact
//     fields — a child never has an email, phone, or Firebase Auth uid (R9/A9;
//     assertNoChildIdentityContactFields below enforces it at every write).
//
//   • `child_profiles/{childId}/private/safety` (pointer) +
//     `child_profiles/{childId}/private/safety/versions/{version}` — the
//     RESTRICTED zone: immutable safety versions carrying the exact birth
//     date, adult emergency contacts, health/pickup/custody detail, and change
//     provenance. Server-only; firestore.rules denies every browser read.
//     Restricted file records live as sibling docs in the same private
//     collection (`private/file_{fileId}` — childcare/childFileAccess.ts).
//
//   • `authorizedViewerUids` on the operational doc is a TRANSACTIONALLY
//     MAINTAINED DERIVED CACHE (R6/KTD3), version-stamped from
//     guardian_authorities. It exists ONLY so Firestore Rules can authorize a
//     browser READ of the operational summary (Rules cannot call
//     checkAuthority). It NEVER grants authority: every server path re-checks
//     checkAuthority, and a cache/authority mismatch always resolves in the
//     authority's favor (stale cache entries deny at the server).
//
//   • Exact birth date is stored ONCE, in the private zone. Age-band
//     recalculation runs server-side (scheduled/childcareLifecycleWorker.ts)
//     and stamps only the band on the operational doc. Reaching the adult age
//     produces an EXPLICIT aged_out state transition with an operator alert —
//     never a silent adult-account conversion (R16). No code in this module
//     touches Firebase Auth.
//
// All writes are server-side (Admin SDK); firestore.rules denies every browser
// write (R11/KTD6). Deletion flows exclusively through the tracked lifecycle
// state machine in privacy/dataLifecycle.ts (R15).

import * as admin from "firebase-admin";
import { createHash } from "crypto";
import { logAudit } from "../observability/auditLog";
import { assertEnableableChildcareCategory } from "../childcare/jurisdictionPolicy";
import {
  checkAuthority,
  bootstrapPrimaryGuardianAuthority,
  GUARDIAN_AUTHORITIES_COLLECTION,
  GuardianAuthorityError,
  type GuardianAuthorityDoc,
} from "../childcare/guardianAuthority";
import {
  HOUSEHOLDS_COLLECTION,
  HOUSEHOLD_MEMBERSHIPS_COLLECTION,
  membershipDocId,
  type HouseholdDoc,
  type HouseholdMembershipDoc,
} from "../childcare/householdRepository";

export const CHILD_PROFILES_COLLECTION = "child_profiles";
export const CHILD_PRIVATE_SUBCOLLECTION = "private";
export const CHILD_SAFETY_DOC_ID = "safety";
export const CHILD_SAFETY_VERSIONS_SUBCOLLECTION = "versions";
/** Restricted file records are `private/file_{fileId}` sibling docs. */
export const CHILD_FILE_RECORD_DOC_PREFIX = "file_";

/** R16: reaching this age produces the explicit aged_out transition. */
export const CHILD_AGE_OUT_YEARS = 18;

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

function defaultDb(): Db {
  return admin.firestore();
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type ChildProfileErrorCode =
  | "invalid_input"
  | "not_authorized"
  | "household_not_found"
  | "child_not_found"
  | "child_deleted"
  | "already_adult" // creation guard: an 18+ recipient is never a child profile
  | "immutable_version"
  | "legal_hold_active"
  | "concurrent_change";

export class ChildProfileError extends Error {
  code: ChildProfileErrorCode;
  constructor(code: ChildProfileErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ChildProfileError";
    this.code = code;
  }
}

// ── Structural no-child-contact guard (R9/AE2) ──────────────────────────────
//
// A child is a care recipient, never a platform actor: no Firebase Auth
// account, no phone, no email, no notification target. This guard rejects any
// payload that tries to smuggle a contact/identity field onto a child record.
// The ONLY sanctioned phone fields are ADULT emergency contacts inside the
// private zone's typed emergencyContacts list (R10), which is skipped by key.

const FORBIDDEN_CHILD_IDENTITY_KEYS = new Set([
  "uid",
  "authuid",
  "firebaseuid",
  "userid",
  "email",
  "childemail",
  "phone",
  "childphone",
  "phonenumber",
  "fcmtoken",
  "devicetoken",
  "pushtoken",
  "username",
  "authaccount",
]);

/** Keys whose SUBTREE is a typed adult-contact structure (allowed phone). */
const ADULT_CONTACT_SUBTREE_KEYS = new Set(["emergencycontacts"]);

export function assertNoChildIdentityContactFields(input: unknown, path = ""): void {
  if (input === null || input === undefined || typeof input !== "object") return;
  if (Array.isArray(input)) {
    for (const item of input) assertNoChildIdentityContactFields(item, path);
    return;
  }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    if (ADULT_CONTACT_SUBTREE_KEYS.has(normalized)) continue; // typed adult contacts (validated separately)
    if (FORBIDDEN_CHILD_IDENTITY_KEYS.has(normalized)) {
      throw new ChildProfileError(
        "invalid_input",
        `Child records never carry a contact/identity field ("${key}"${path ? ` at ${path}` : ""}) — R9.`,
      );
    }
    assertNoChildIdentityContactFields(value, path ? `${path}.${key}` : key);
  }
}

// ── Age bands (R10/R16) ──────────────────────────────────────────────────────

export type AgeBand =
  | "infant" // < 1
  | "toddler" // 1-2
  | "preschool" // 3-4
  | "school_age" // 5-9
  | "preteen" // 10-12
  | "teen" // 13-17
  | "aged_out"; // >= CHILD_AGE_OUT_YEARS

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function computeAgeYears(dateOfBirth: string, now: Date = new Date()): number {
  if (!ISO_DATE.test(dateOfBirth)) throw new ChildProfileError("invalid_input", "dateOfBirth must be YYYY-MM-DD");
  const dob = new Date(`${dateOfBirth}T00:00:00.000Z`);
  if (!Number.isFinite(dob.getTime()) || dob.getTime() > now.getTime()) {
    throw new ChildProfileError("invalid_input", "dateOfBirth must be a valid past date");
  }
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

export function computeAgeBand(dateOfBirth: string, now: Date = new Date()): AgeBand {
  const age = computeAgeYears(dateOfBirth, now);
  if (age >= CHILD_AGE_OUT_YEARS) return "aged_out";
  if (age >= 13) return "teen";
  if (age >= 10) return "preteen";
  if (age >= 5) return "school_age";
  if (age >= 3) return "preschool";
  if (age >= 1) return "toddler";
  return "infant";
}

// ── Document shapes ──────────────────────────────────────────────────────────

export type ChildProfileState = "active" | "aged_out" | "deleted";

export interface ChildLegalHold {
  active: boolean;
  reason: string;
  placedByUid: string;
  placedAt: string;
  clearedAt?: string | null;
  clearedByUid?: string | null;
}

/** Version-stamped derived viewer cache (R6 — display read only, never authority). */
export interface AuthorityViewerProjection {
  viewerUids: string[];
  /** adultUid → guardian_authorities accessVersion the projection saw. */
  sourceAuthorityVersions: Record<string, number>;
  /** Monotonic: sum of ALL authority accessVersions for the child. */
  projectionVersion: number;
  computedAt: string;
}

export interface ChildProfileDoc {
  childId: string;
  householdId: string;
  careVertical: "child"; // R1 — always stamped, fail-closed elsewhere
  /** Preferred display label (first name / nickname). Never a legal full name requirement. */
  displayLabel: string;
  /** Derived band only — exact DOB lives ONLY in the private zone (R10). */
  ageBand: AgeBand;
  ageBandComputedAt: string;
  /** Broad approved care categories (jurisdictionPolicy enableable list). */
  careCategories: string[];
  state: ChildProfileState;
  /**
   * DERIVED CACHE (R6): uids allowed to browser-READ this operational summary.
   * Mirror of authorityProjection.viewerUids so Rules can do a membership
   * check. Grants display read only — never authority.
   */
  authorizedViewerUids: string[];
  authorityProjection: AuthorityViewerProjection | null;
  /**
   * Bumped on every access-relevant change (authority recompute, safety
   * version append, legal-hold change, lifecycle revocation). File-access
   * grants pin it; a mismatch at grant/confirm time denies.
   */
  accessVersion: number;
  legalHold: ChildLegalHold | null;
  /** docs/policies/childcare-data-retention.md version in force (R13). */
  retentionPolicyVersion: string | null;
  policyVersion: string | null;
  /** Mirror of the private safety pointer's currentVersion (0 = none). */
  safetyCurrentVersion: number;
  createdByUid: string;
  lastOperationKey?: string | null;
  agedOutAt?: string | null;
  deletedAt?: string | null;
  lifecycleRequestId?: string | null;
  tombstone?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Adult emergency contact — the ONLY sanctioned phone shape near a child record. */
export interface ChildEmergencyContact {
  name: string;
  relationship: string;
  /** E.164 ADULT phone. Never a child's number (children have none — R9). */
  phone: string;
}

export interface ChildSafetyData {
  /** Exact birth date — stored ONCE, here, in the private zone only. */
  dateOfBirth: string;
  emergencyContacts: ChildEmergencyContact[];
  healthNotes: string | null;
  allergiesNote: string | null;
  pickupNotes: string | null;
  custodyNotes: string | null;
  addressDetail: string | null;
}

export interface ChildSafetyVersionDoc {
  childId: string;
  version: number;
  data: ChildSafetyData;
  /** Change provenance (R10/KTD13-adjacent): who, when, why. */
  provenance: {
    changedByUid: string;
    changeReason: string | null;
    source: "profile_create" | "safety_append" | "lifecycle_redaction";
  };
  immutable: true;
  createdAt: string;
}

export interface ChildSafetyPointerDoc {
  childId: string;
  currentVersion: number;
  /** Bumped with every append — safety grants pin it (revocation check). */
  accessVersion: number;
  redacted?: boolean;
  lastOperationKey?: string | null;
  updatedByUid: string;
  updatedAt: string;
}

// ── Path helpers ─────────────────────────────────────────────────────────────

export function childProfileDocId(householdId: string, idempotencyKey: string): string {
  if (!householdId || !idempotencyKey) {
    throw new ChildProfileError("invalid_input", "householdId and idempotencyKey are required");
  }
  return `child_${sha256Hex(`${householdId}:${idempotencyKey}`).slice(0, 40)}`;
}

function childRef(db: Db, childId: string) {
  return db.collection(CHILD_PROFILES_COLLECTION).doc(childId);
}

function privateCollection(db: Db, childId: string) {
  return childRef(db, childId).collection(CHILD_PRIVATE_SUBCOLLECTION);
}

export function safetyPointerRef(db: Db, childId: string) {
  return privateCollection(db, childId).doc(CHILD_SAFETY_DOC_ID);
}

export function safetyVersionRef(db: Db, childId: string, version: number) {
  return safetyPointerRef(db, childId)
    .collection(CHILD_SAFETY_VERSIONS_SUBCOLLECTION)
    .doc(String(version));
}

// ── Input normalization ──────────────────────────────────────────────────────

const E164 = /^\+\d{10,15}$/;

function normalizeDisplayLabel(raw: unknown): string {
  const label = String(raw ?? "").trim();
  if (!label || label.length > 80) {
    throw new ChildProfileError("invalid_input", "displayLabel must be 1-80 characters");
  }
  // A display label is a name, never a contact handle (R9 structural posture).
  if (label.includes("@") || /\d{7,}/.test(label)) {
    throw new ChildProfileError("invalid_input", "displayLabel must not contain an email or phone number");
  }
  return label;
}

function normalizeCareCategories(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) {
    throw new ChildProfileError("invalid_input", "careCategories must list 1-8 approved categories");
  }
  const out = new Set<string>();
  for (const category of raw) {
    const c = String(category ?? "").trim();
    try {
      assertEnableableChildcareCategory(c); // deferred/unknown categories fail closed
    } catch (err) {
      throw new ChildProfileError("invalid_input", err instanceof Error ? err.message : "invalid category");
    }
    out.add(c);
  }
  return [...out].sort();
}

function boundedNote(raw: unknown, field: string, max = 2000): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const s = String(raw).trim();
  if (s.length > max) throw new ChildProfileError("invalid_input", `${field} exceeds ${max} characters`);
  return s || null;
}

export function normalizeChildSafetyData(
  raw: unknown,
  opts: { previous?: ChildSafetyData | null; now?: Date } = {},
): ChildSafetyData {
  if (!raw || typeof raw !== "object") throw new ChildProfileError("invalid_input", "safety data required");
  assertNoChildIdentityContactFields(raw);
  const r = raw as Record<string, unknown>;

  const dob = r.dateOfBirth !== undefined ? String(r.dateOfBirth) : opts.previous?.dateOfBirth;
  if (!dob) throw new ChildProfileError("invalid_input", "dateOfBirth is required");
  computeAgeYears(dob, opts.now ?? new Date()); // validates format + past date

  const rawContacts = r.emergencyContacts ?? opts.previous?.emergencyContacts ?? [];
  if (!Array.isArray(rawContacts) || rawContacts.length > 5) {
    throw new ChildProfileError("invalid_input", "emergencyContacts must be a list of at most 5 adult contacts");
  }
  const emergencyContacts: ChildEmergencyContact[] = rawContacts.map((c) => {
    const contact = (c ?? {}) as Record<string, unknown>;
    const name = String(contact.name ?? "").trim();
    const relationship = String(contact.relationship ?? "").trim();
    const phone = String(contact.phone ?? "").trim();
    if (!name || name.length > 100 || !relationship || relationship.length > 100 || !E164.test(phone)) {
      throw new ChildProfileError(
        "invalid_input",
        "each emergency contact needs a name, relationship, and E.164 adult phone",
      );
    }
    return { name, relationship, phone };
  });

  return {
    dateOfBirth: dob,
    emergencyContacts,
    healthNotes: boundedNote(r.healthNotes ?? opts.previous?.healthNotes, "healthNotes"),
    allergiesNote: boundedNote(r.allergiesNote ?? opts.previous?.allergiesNote, "allergiesNote"),
    pickupNotes: boundedNote(r.pickupNotes ?? opts.previous?.pickupNotes, "pickupNotes"),
    custodyNotes: boundedNote(r.custodyNotes ?? opts.previous?.custodyNotes, "custodyNotes"),
    addressDetail: boundedNote(r.addressDetail ?? opts.previous?.addressDetail, "addressDetail", 500),
  };
}

// ── Derived viewer projection (R6 — transactionally maintained, versioned) ──

/**
 * Recompute the authorizedViewerUids cache from guardian_authorities. The
 * projection is stamped with every source authority's accessVersion plus a
 * monotonic projectionVersion (sum of all accessVersions — any authority
 * change strictly increases it, so staleness is always detectable).
 *
 * Grants READ DISPLAY only (Rules membership check) — never authority. Server
 * paths always call checkAuthority; when the cache and the authority disagree,
 * the authority wins.
 *
 * Returns null (no-op) when the child profile does not exist or is deleted —
 * invites may reference children that were never created.
 */
export async function recomputeAuthorizedViewerProjection(
  childId: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<AuthorityViewerProjection | null> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const cleanChildId = String(childId ?? "").trim();
  if (!cleanChildId) return null;

  const authoritySnap = await db
    .collection(GUARDIAN_AUTHORITIES_COLLECTION)
    .where("childId", "==", cleanChildId)
    .get();

  const sourceAuthorityVersions: Record<string, number> = {};
  const viewerUids: string[] = [];
  let projectionVersion = 0;
  for (const doc of authoritySnap.docs) {
    const authority = (doc.data() ?? {}) as Partial<GuardianAuthorityDoc>;
    const adultUid = String(authority.adultUid ?? "");
    const accessVersion = Number(authority.accessVersion ?? 0);
    if (!adultUid) continue;
    sourceAuthorityVersions[adultUid] = accessVersion;
    projectionVersion += accessVersion;
    const expired =
      typeof authority.expiresAt === "string" &&
      authority.expiresAt &&
      Date.parse(authority.expiresAt) <= now.getTime();
    if (
      authority.state === "active" &&
      !expired &&
      Array.isArray(authority.scopes) &&
      authority.scopes.includes("view")
    ) {
      viewerUids.push(adultUid);
    }
  }
  viewerUids.sort();

  const projection: AuthorityViewerProjection = {
    viewerUids,
    sourceAuthorityVersions,
    projectionVersion,
    computedAt: nowIso(now),
  };

  const applied = await db.runTransaction(async (tx) => {
    const snap = await tx.get(childRef(db, cleanChildId));
    if (!snap.exists) return false;
    const profile = (snap.data() ?? {}) as ChildProfileDoc;
    if (profile.state === "deleted") return false;
    // Monotonic guard: never let an older recompute overwrite a newer one.
    if (
      profile.authorityProjection &&
      Number(profile.authorityProjection.projectionVersion) > projectionVersion
    ) {
      return false;
    }
    tx.set(
      childRef(db, cleanChildId),
      {
        ...profile,
        authorizedViewerUids: projection.viewerUids,
        authorityProjection: projection,
        accessVersion: Number(profile.accessVersion ?? 0) + 1,
        updatedAt: projection.computedAt,
      },
    );
    return true;
  });

  return applied ? projection : null;
}

// ── Create (bootstraps the primary guardian authority) ──────────────────────

export interface CreateChildProfileParams {
  householdId: string;
  createdByUid: string;
  displayLabel: string;
  careCategories: string[];
  safety: unknown; // raw — normalized here (exact DOB lands ONLY in the private zone)
  idempotencyKey: string;
  policyVersion?: string | null;
  retentionPolicyVersion?: string | null;
}

export interface CreateChildProfileResult {
  profile: ChildProfileDoc;
  authority: GuardianAuthorityDoc;
  created: boolean;
}

/**
 * Create the child profile zones + bootstrap the FIRST guardian authority
 * (guardianAuthority.bootstrapPrimaryGuardianAuthority — the U2 first-authority
 * seam; only the household primary adult may create) + recompute the viewer
 * projection. Idempotent end to end: the childId is deterministic from
 * (householdId, idempotencyKey), every leg converges on retry.
 */
export async function createChildProfileWithBootstrap(
  params: CreateChildProfileParams,
  opts: { db?: Db; now?: Date } = {},
): Promise<CreateChildProfileResult> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ts = nowIso(now);

  const householdId = String(params.householdId ?? "").trim();
  const createdByUid = String(params.createdByUid ?? "").trim();
  const idempotencyKey = String(params.idempotencyKey ?? "").trim();
  if (!householdId || !createdByUid || !idempotencyKey || idempotencyKey.length > 128) {
    throw new ChildProfileError("invalid_input");
  }
  assertNoChildIdentityContactFields({
    displayLabel: params.displayLabel,
    careCategories: params.careCategories,
  });
  const displayLabel = normalizeDisplayLabel(params.displayLabel);
  const careCategories = normalizeCareCategories(params.careCategories);
  const safety = normalizeChildSafetyData(params.safety, { now });

  const ageBand = computeAgeBand(safety.dateOfBirth, now);
  if (ageBand === "aged_out") {
    // An 18+ recipient is an adult, never a child profile (R16 at the front door).
    throw new ChildProfileError("already_adult", "This person is an adult — child profiles are for minors only.");
  }

  const childId = childProfileDocId(householdId, idempotencyKey);

  const txResult = await db.runTransaction(async (tx) => {
    const [householdSnap, membershipSnap, childSnap, pointerSnap] = await Promise.all([
      tx.get(db.collection(HOUSEHOLDS_COLLECTION).doc(householdId)),
      tx.get(db.collection(HOUSEHOLD_MEMBERSHIPS_COLLECTION).doc(membershipDocId(householdId, createdByUid))),
      tx.get(childRef(db, childId)),
      tx.get(safetyPointerRef(db, childId)),
    ]);

    if (!householdSnap.exists) throw new ChildProfileError("household_not_found");
    const household = (householdSnap.data() ?? {}) as HouseholdDoc;
    if (household.status !== "active") throw new ChildProfileError("household_not_found");
    // Bootstrap contract (U2): the FIRST authority is the primary adult's
    // self-grant — creation is therefore primary-adult-only. Additional adults
    // gain access through explicit grants afterwards.
    if (household.primaryAdultUid !== createdByUid) throw new ChildProfileError("not_authorized");
    if (!membershipSnap.exists) throw new ChildProfileError("not_authorized");
    const membership = (membershipSnap.data() ?? {}) as HouseholdMembershipDoc;
    if (membership.status !== "active" || membership.adultUid !== createdByUid) {
      throw new ChildProfileError("not_authorized");
    }

    if (childSnap.exists) {
      const existing = (childSnap.data() ?? {}) as ChildProfileDoc;
      if (existing.state === "deleted") throw new ChildProfileError("child_deleted");
      if (existing.lastOperationKey === idempotencyKey) {
        return { profile: existing, created: false }; // retry — converge
      }
      // Deterministic ID means a different operation cannot collide here.
      throw new ChildProfileError("concurrent_change");
    }

    const profile: ChildProfileDoc = {
      childId,
      householdId,
      careVertical: "child",
      displayLabel,
      ageBand,
      ageBandComputedAt: ts,
      careCategories,
      state: "active",
      authorizedViewerUids: [],
      authorityProjection: null,
      accessVersion: 1,
      legalHold: null,
      retentionPolicyVersion: params.retentionPolicyVersion ?? null,
      policyVersion: params.policyVersion ?? null,
      safetyCurrentVersion: 1,
      createdByUid,
      lastOperationKey: idempotencyKey,
      agedOutAt: null,
      deletedAt: null,
      lifecycleRequestId: null,
      createdAt: ts,
      updatedAt: ts,
    };
    tx.set(childRef(db, childId), profile);

    const version: ChildSafetyVersionDoc = {
      childId,
      version: 1,
      data: safety,
      provenance: { changedByUid: createdByUid, changeReason: "initial profile", source: "profile_create" },
      immutable: true,
      createdAt: ts,
    };
    tx.set(safetyVersionRef(db, childId, 1), version);

    const pointer: ChildSafetyPointerDoc = {
      childId,
      currentVersion: 1,
      accessVersion: 1,
      lastOperationKey: idempotencyKey,
      updatedByUid: createdByUid,
      updatedAt: ts,
    };
    if (!pointerSnap.exists) tx.set(safetyPointerRef(db, childId), pointer);

    return { profile, created: true };
  });

  // Bootstrap the first authority (its own idempotent transaction — U2 seam).
  let authority: GuardianAuthorityDoc;
  try {
    authority = await bootstrapPrimaryGuardianAuthority(
      { householdId, childId, adultUid: createdByUid, idempotencyKey, policyVersion: params.policyVersion ?? null },
      { db, now },
    );
  } catch (err) {
    if (err instanceof GuardianAuthorityError && err.code === "authority_already_bootstrapped") {
      // Retry after a partial earlier run: the creator's own bootstrap exists.
      const snap = await db
        .collection(GUARDIAN_AUTHORITIES_COLLECTION)
        .doc(`${childId}__${createdByUid}`)
        .get();
      if (!snap.exists) throw err;
      authority = (snap.data() ?? {}) as GuardianAuthorityDoc;
    } else {
      throw err;
    }
  }

  await recomputeAuthorizedViewerProjection(childId, { db, now });
  const profileSnap = await childRef(db, childId).get();
  const profile = (profileSnap.data() ?? txResult.profile) as ChildProfileDoc;

  await logAudit({
    eventType: "child_profile_created",
    userId: createdByUid,
    data: { childId, householdId, ageBand, created: txResult.created },
  }).catch(() => {});

  return { profile, authority, created: txResult.created };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getChildProfile(childId: string, db: Db = defaultDb()): Promise<ChildProfileDoc | null> {
  if (!childId) return null;
  const snap = await childRef(db, childId).get();
  return snap.exists ? ((snap.data() ?? {}) as ChildProfileDoc) : null;
}

/** Server-only: the current restricted safety version (exact DOB lives here). */
export async function getCurrentChildSafetyVersion(
  childId: string,
  db: Db = defaultDb(),
): Promise<ChildSafetyVersionDoc | null> {
  const pointerSnap = await safetyPointerRef(db, childId).get();
  if (!pointerSnap.exists) return null;
  const pointer = (pointerSnap.data() ?? {}) as ChildSafetyPointerDoc;
  if (!pointer.currentVersion) return null;
  const versionSnap = await safetyVersionRef(db, childId, pointer.currentVersion).get();
  return versionSnap.exists ? ((versionSnap.data() ?? {}) as ChildSafetyVersionDoc) : null;
}

export async function listChildSafetyVersions(
  childId: string,
  db: Db = defaultDb(),
): Promise<ChildSafetyVersionDoc[]> {
  const snap = await safetyPointerRef(db, childId).collection(CHILD_SAFETY_VERSIONS_SUBCOLLECTION).get();
  return snap.docs
    .map((d) => (d.data() ?? {}) as ChildSafetyVersionDoc)
    .sort((a, b) => Number(a.version) - Number(b.version));
}

/** Restricted file records (childcare/childFileAccess.ts) in the private zone. */
export async function listChildFileRecords(
  childId: string,
  db: Db = defaultDb(),
): Promise<Array<Record<string, unknown>>> {
  const snap = await privateCollection(db, childId).get();
  return snap.docs
    .filter((d) => d.id.startsWith(CHILD_FILE_RECORD_DOC_PREFIX))
    .map((d) => (d.data() ?? {}) as Record<string, unknown>);
}

// ── Update (operational summary fields only) ─────────────────────────────────

export interface UpdateChildProfileParams {
  actorUid: string;
  childId: string;
  updates: { displayLabel?: unknown; careCategories?: unknown };
  idempotencyKey?: string | null;
}

/** Update whitelisted operational fields. Requires ACTIVE `management` authority. */
export async function updateChildProfile(
  params: UpdateChildProfileParams,
  opts: { db?: Db; now?: Date } = {},
): Promise<ChildProfileDoc> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ts = nowIso(now);
  const { actorUid, childId } = params;
  if (!actorUid || !childId) throw new ChildProfileError("invalid_input");
  assertNoChildIdentityContactFields(params.updates);

  const decision = await checkAuthority(actorUid, childId, "management", { db, now });
  if (!decision.allowed) throw new ChildProfileError("not_authorized");

  const displayLabel =
    params.updates.displayLabel !== undefined ? normalizeDisplayLabel(params.updates.displayLabel) : undefined;
  const careCategories =
    params.updates.careCategories !== undefined ? normalizeCareCategories(params.updates.careCategories) : undefined;
  if (displayLabel === undefined && careCategories === undefined) {
    throw new ChildProfileError("invalid_input", "no supported fields to update");
  }

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(childRef(db, childId));
    if (!snap.exists) throw new ChildProfileError("child_not_found");
    const profile = (snap.data() ?? {}) as ChildProfileDoc;
    if (profile.state === "deleted") throw new ChildProfileError("child_deleted");
    if (params.idempotencyKey && profile.lastOperationKey === params.idempotencyKey) return profile;

    const updated: ChildProfileDoc = {
      ...profile,
      ...(displayLabel !== undefined ? { displayLabel } : {}),
      ...(careCategories !== undefined ? { careCategories } : {}),
      lastOperationKey: params.idempotencyKey ?? null,
      updatedAt: ts,
    };
    tx.set(childRef(db, childId), updated);
    return updated;
  });
}

// ── Safety-version append (immutable versions + current pointer) ─────────────

export interface AppendSafetyVersionParams {
  actorUid: string;
  childId: string;
  safety: unknown;
  changeReason?: string | null;
  idempotencyKey?: string | null;
}

export interface AppendSafetyVersionResult {
  version: ChildSafetyVersionDoc;
  pointer: ChildSafetyPointerDoc;
  appended: boolean;
}

/**
 * Append a NEW immutable safety version and advance the current pointer.
 * Versions are never edited in place (immutable + provenance); the child's
 * accessVersion bumps so outstanding file/safety grants pinned to the old
 * version deny (R19-adjacent revocation of stale projections).
 */
export async function appendChildSafetyVersion(
  params: AppendSafetyVersionParams,
  opts: { db?: Db; now?: Date } = {},
): Promise<AppendSafetyVersionResult> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ts = nowIso(now);
  const { actorUid, childId } = params;
  if (!actorUid || !childId) throw new ChildProfileError("invalid_input");

  const decision = await checkAuthority(actorUid, childId, "management", { db, now });
  if (!decision.allowed) throw new ChildProfileError("not_authorized");

  const previous = await getCurrentChildSafetyVersion(childId, db);
  const safety = normalizeChildSafetyData(params.safety, { previous: previous?.data ?? null, now });

  const result = await db.runTransaction(async (tx) => {
    const [childSnap, pointerSnap] = await Promise.all([
      tx.get(childRef(db, childId)),
      tx.get(safetyPointerRef(db, childId)),
    ]);
    if (!childSnap.exists) throw new ChildProfileError("child_not_found");
    const profile = (childSnap.data() ?? {}) as ChildProfileDoc;
    if (profile.state === "deleted") throw new ChildProfileError("child_deleted");
    if (profile.legalHold?.active) {
      // Holds freeze the record set under review — no new versions while held.
      throw new ChildProfileError("legal_hold_active");
    }

    const pointer = pointerSnap.exists
      ? ((pointerSnap.data() ?? {}) as ChildSafetyPointerDoc)
      : ({ childId, currentVersion: 0, accessVersion: 0, updatedByUid: actorUid, updatedAt: ts } as ChildSafetyPointerDoc);

    if (params.idempotencyKey && pointer.lastOperationKey === params.idempotencyKey) {
      const currentSnap = await tx.get(safetyVersionRef(db, childId, pointer.currentVersion));
      return {
        version: (currentSnap.data() ?? {}) as ChildSafetyVersionDoc,
        pointer,
        appended: false,
      };
    }

    const nextVersion = Number(pointer.currentVersion ?? 0) + 1;
    const nextRef = safetyVersionRef(db, childId, nextVersion);
    const nextSnap = await tx.get(nextRef);
    if (nextSnap.exists) {
      // Immutability: a version doc is written exactly once, never overwritten.
      throw new ChildProfileError("immutable_version");
    }

    const version: ChildSafetyVersionDoc = {
      childId,
      version: nextVersion,
      data: safety,
      provenance: {
        changedByUid: actorUid,
        changeReason: params.changeReason ? String(params.changeReason).slice(0, 300) : null,
        source: "safety_append",
      },
      immutable: true,
      createdAt: ts,
    };
    tx.set(nextRef, version);

    const updatedPointer: ChildSafetyPointerDoc = {
      childId,
      currentVersion: nextVersion,
      accessVersion: Number(pointer.accessVersion ?? 0) + 1,
      lastOperationKey: params.idempotencyKey ?? null,
      updatedByUid: actorUid,
      updatedAt: ts,
    };
    tx.set(safetyPointerRef(db, childId), updatedPointer);

    // Band may change with a DOB correction; stamp band ONLY (never the DOB).
    const ageBand = computeAgeBand(safety.dateOfBirth, now);
    tx.set(
      childRef(db, childId),
      {
        ...profile,
        ageBand: ageBand === "aged_out" ? profile.ageBand : ageBand, // age-out only via the explicit transition
        ageBandComputedAt: ts,
        safetyCurrentVersion: nextVersion,
        accessVersion: Number(profile.accessVersion ?? 0) + 1,
        updatedAt: ts,
      },
    );

    return { version, pointer: updatedPointer, appended: true };
  });

  await logAudit({
    eventType: "child_safety_version_appended",
    userId: actorUid,
    data: { childId, version: result.version.version, appended: result.appended },
  }).catch(() => {});
  return result;
}

// ── Legal hold (server-only; operator UI lands in U12) ──────────────────────

export async function setChildLegalHold(
  childId: string,
  hold: { active: boolean; reason: string; placedByUid: string } | null,
  opts: { db?: Db; now?: Date } = {},
): Promise<ChildProfileDoc> {
  const db = opts.db ?? defaultDb();
  const ts = nowIso(opts.now);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(childRef(db, childId));
    if (!snap.exists) throw new ChildProfileError("child_not_found");
    const profile = (snap.data() ?? {}) as ChildProfileDoc;
    const legalHold: ChildLegalHold | null = hold
      ? {
          active: hold.active,
          reason: String(hold.reason).slice(0, 300),
          placedByUid: hold.placedByUid,
          placedAt: ts,
          clearedAt: null,
          clearedByUid: null,
        }
      : profile.legalHold
        ? { ...profile.legalHold, active: false, clearedAt: ts }
        : null;
    const updated: ChildProfileDoc = {
      ...profile,
      legalHold,
      accessVersion: Number(profile.accessVersion ?? 0) + 1,
      updatedAt: ts,
    };
    tx.set(childRef(db, childId), updated);
    return updated;
  });
}

// ── Age-band recalculation + explicit age-out transition (R16) ───────────────

export interface AgeBandRecalcResult {
  childId: string;
  band: AgeBand | null;
  changed: boolean;
  agedOut: boolean;
}

/**
 * Server-side recalculation: read the exact DOB from the PRIVATE zone, stamp
 * only the band on the operational doc. Crossing the adult threshold produces
 * the EXPLICIT aged_out transition — state change + operator alert + audit —
 * never a silent adult conversion and never a Firebase Auth account (R16).
 */
export async function recalcChildAgeBand(
  childId: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<AgeBandRecalcResult> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ts = nowIso(now);

  const current = await getCurrentChildSafetyVersion(childId, db);
  if (!current) return { childId, band: null, changed: false, agedOut: false };
  const band = computeAgeBand(current.data.dateOfBirth, now);

  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(childRef(db, childId));
    if (!snap.exists) return { changed: false, agedOut: false };
    const profile = (snap.data() ?? {}) as ChildProfileDoc;
    if (profile.state === "deleted") return { changed: false, agedOut: false };

    if (band === "aged_out") {
      if (profile.state === "aged_out") return { changed: false, agedOut: false }; // already transitioned
      tx.set(
        childRef(db, childId),
        {
          ...profile,
          state: "aged_out",
          ageBand: "aged_out",
          ageBandComputedAt: ts,
          agedOutAt: ts,
          accessVersion: Number(profile.accessVersion ?? 0) + 1,
          updatedAt: ts,
        },
      );
      // Explicit operator-visible transition (R16) — IDs only, no child PII.
      tx.set(db.collection("admin_alerts").doc(`child_aged_out_${childId}`), {
        type: "child_profile_aged_out",
        severity: "medium",
        childId,
        householdId: profile.householdId,
        createdAt: ts,
        resolved: false,
      });
      return { changed: true, agedOut: true };
    }

    if (profile.ageBand === band) return { changed: false, agedOut: false };
    tx.set(
      childRef(db, childId),
      { ...profile, ageBand: band, ageBandComputedAt: ts, updatedAt: ts },
    );
    return { changed: true, agedOut: false };
  });

  if (outcome.agedOut) {
    await logAudit({
      eventType: "child_profile_aged_out",
      userId: "system",
      data: { childId },
    }).catch(() => {});
  }
  return { childId, band, ...outcome };
}

/** Active children for the scheduled band sweep (equality-only query). */
export async function listActiveChildProfiles(
  db: Db = defaultDb(),
  limit = 200,
): Promise<ChildProfileDoc[]> {
  const snap = await db
    .collection(CHILD_PROFILES_COLLECTION)
    .where("state", "==", "active")
    .limit(limit)
    .get();
  return snap.docs.map((d) => (d.data() ?? {}) as ChildProfileDoc);
}

// ── Lifecycle deletion support (called ONLY by privacy/dataLifecycle.ts) ─────

export interface TombstoneResult {
  hadProfile: boolean;
  deletedPrivateDocs: number;
}

/**
 * Tombstone the operational doc and purge the private zone. The tombstone
 * keeps ONLY non-identifying lifecycle proof fields (R14/R15): ids, state,
 * timestamps, retention version — no display label, no categories, no viewers.
 * Idempotent: re-running on a tombstone deletes any private stragglers and
 * returns converged counts.
 */
export async function tombstoneChildProfileForDeletion(
  childId: string,
  lifecycleRequestId: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<TombstoneResult> {
  const db = opts.db ?? defaultDb();
  const ts = nowIso(opts.now);

  const snap = await childRef(db, childId).get();
  if (!snap.exists) return { hadProfile: false, deletedPrivateDocs: 0 };
  const profile = (snap.data() ?? {}) as ChildProfileDoc;
  if (profile.legalHold?.active) throw new ChildProfileError("legal_hold_active");

  // Purge the private zone: safety versions, pointer, file records.
  let deleted = 0;
  const versionSnap = await safetyPointerRef(db, childId)
    .collection(CHILD_SAFETY_VERSIONS_SUBCOLLECTION)
    .get();
  for (const doc of versionSnap.docs) {
    await doc.ref.delete();
    deleted += 1;
  }
  const privateSnap = await privateCollection(db, childId).get();
  for (const doc of privateSnap.docs) {
    await doc.ref.delete();
    deleted += 1;
  }

  const tombstone: Partial<ChildProfileDoc> = {
    childId,
    householdId: profile.householdId,
    careVertical: "child",
    state: "deleted",
    tombstone: true,
    authorizedViewerUids: [],
    authorityProjection: null,
    accessVersion: Number(profile.accessVersion ?? 0) + 1,
    legalHold: profile.legalHold ?? null,
    retentionPolicyVersion: profile.retentionPolicyVersion ?? null,
    safetyCurrentVersion: 0,
    deletedAt: profile.deletedAt ?? ts,
    lifecycleRequestId,
    createdAt: profile.createdAt,
    updatedAt: ts,
  } as Partial<ChildProfileDoc>;
  await childRef(db, childId).set(tombstone as Record<string, unknown>);

  return { hadProfile: profile.state !== "deleted", deletedPrivateDocs: deleted };
}

/** Purge safety VERSIONS only (redact scope) — pointer kept with a redacted flag. */
export async function redactChildSafetyVersions(
  childId: string,
  lifecycleRequestId: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<{ deletedVersions: number }> {
  const db = opts.db ?? defaultDb();
  const ts = nowIso(opts.now);
  const pointerSnap = await safetyPointerRef(db, childId).get();
  if (!pointerSnap.exists) return { deletedVersions: 0 };
  const pointer = (pointerSnap.data() ?? {}) as ChildSafetyPointerDoc;

  let deleted = 0;
  const versionSnap = await safetyPointerRef(db, childId)
    .collection(CHILD_SAFETY_VERSIONS_SUBCOLLECTION)
    .get();
  for (const doc of versionSnap.docs) {
    await doc.ref.delete();
    deleted += 1;
  }
  await safetyPointerRef(db, childId).set({
    ...pointer,
    currentVersion: 0,
    accessVersion: Number(pointer.accessVersion ?? 0) + 1,
    redacted: true,
    lastOperationKey: `lifecycle:${lifecycleRequestId}`,
    updatedByUid: "system",
    updatedAt: ts,
  });

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(childRef(db, childId));
    if (!snap.exists) return;
    const profile = (snap.data() ?? {}) as ChildProfileDoc;
    tx.set(
      childRef(db, childId),
      {
        ...profile,
        safetyCurrentVersion: 0,
        accessVersion: Number(profile.accessVersion ?? 0) + 1,
        updatedAt: ts,
      },
    );
  });

  return { deletedVersions: deleted };
}

/** Immediate viewer revocation (first destructive lifecycle task). */
export async function revokeAllChildViewerAccess(
  childId: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<boolean> {
  const db = opts.db ?? defaultDb();
  const ts = nowIso(opts.now);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(childRef(db, childId));
    if (!snap.exists) return false;
    const profile = (snap.data() ?? {}) as ChildProfileDoc;
    tx.set(
      childRef(db, childId),
      {
        ...profile,
        authorizedViewerUids: [],
        accessVersion: Number(profile.accessVersion ?? 0) + 1,
        updatedAt: ts,
      },
    );
    return true;
  });
}
