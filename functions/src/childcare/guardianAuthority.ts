// ── Guardian authority model (childcare marketplace plan 2026-07-22-002, U2) ──
//
// R6/KTD3: `guardian_authorities` is THE authority source. Any guardian list
// embedded on a child/household document is a versioned derived cache and can
// never independently grant access. `checkAuthority(actorUid, childId, scope)`
// below is THE permission primitive for every child-sensitive action — it
// consults ONLY the authority record. It never reads users/{uid}, so broad
// `isAdmin` can never satisfy it (R55/AE18: operator access is separate,
// least-privilege U12 work, not guardian authority).
//
// R18 (as amended 2026-07-22): removing or reducing ANOTHER adult's existing
// authority requires (a) durable notice to the affected adult, (b) a
// dispute-hold state, and (c) an operator review path — no adult can silently
// lock out another adult who holds current authority. Implementation: the
// change takes effect as `dispute_hold` (access is SUSPENDED fail-closed while
// the hold is open — child safety beats continuity), the notice + derived-
// access invalidation are durable outbox effects created in the SAME
// transaction (KTD23, pattern: billing/approvalNoticeDispatcher.ts), and an
// admin_alerts row opens the operator review. resolveAuthorityDispute()
// applies or restores.
//
// Revocation fan-out (KTD23): one transactional accessVersion bump on the
// authority (+ the household), plus durable guardianAuthorityOutbox effects
// (co-guardian notice, pending invite invalidation) drained by the
// dispatchGuardianAuthorityOutbox scheduler with claim/lease/retry/terminal
// semantics.
//
// All writes are server-side (Admin SDK); firestore.rules denies every browser
// write and keeps the outbox fully server-only.

import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import { logAudit } from "../observability/auditLog";
import {
  HOUSEHOLDS_COLLECTION,
  HOUSEHOLD_MEMBERSHIPS_COLLECTION,
  membershipDocId,
  type HouseholdDoc,
  type HouseholdMembershipDoc,
} from "./householdRepository";

export const GUARDIAN_AUTHORITIES_COLLECTION = "guardian_authorities";
export const GUARDIAN_AUTHORITY_OUTBOX_COLLECTION = "guardianAuthorityOutbox";
export const CHILDCARE_INVITE_TOKENS_COLLECTION = "childcare_invite_tokens";
const CHILD_PROFILES_COLLECTION = "child_profiles";

// ── Scopes ───────────────────────────────────────────────────────────────────
//
// R7/A2: every permission is an explicit recipient-scoped grant, independently
// revocable. Payer authority may differ from guardian/scheduling authority
// (A3) — `payment` is just another scope, never implied by the others.

export const GUARDIAN_SCOPES = [
  "view",
  "schedule",
  "message",
  "pickup",
  "emergency",
  "cancellation",
  "payment",
  "management",
] as const;
export type GuardianScope = (typeof GUARDIAN_SCOPES)[number];

export function isGuardianScope(v: unknown): v is GuardianScope {
  return typeof v === "string" && (GUARDIAN_SCOPES as readonly string[]).includes(v);
}

export function normalizeScopes(raw: unknown): GuardianScope[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out = new Set<GuardianScope>();
  for (const s of raw) {
    if (!isGuardianScope(s)) return null;
    out.add(s);
  }
  return [...out].sort();
}

// ── Document shape ───────────────────────────────────────────────────────────

export type GuardianAuthorityState = "active" | "dispute_hold" | "revoked" | "expired";
export type GuardianAuthoritySource =
  | "bootstrap_primary_guardian"
  | "explicit_grant"
  | "invite_acceptance";

export interface GuardianAuthorityDisputeHold {
  pendingAction: "revoke" | "reduce_scopes";
  /** For reduce_scopes: the reduced scope set that applies if the hold is upheld. */
  pendingScopes?: GuardianScope[];
  openedAt: string;
  openedByUid: string;
  reason: string | null;
  /** Outbox doc ID of the durable co-guardian notice (R18). */
  noticeOutboxId: string;
  resolvedAt?: string | null;
  resolvedByUid?: string | null;
  resolution?: "applied" | "restored" | null;
}

export interface GuardianAuthorityDoc {
  authorityId: string;
  householdId: string;
  childId: string;
  /** The adult holding this authority. Always a real Firebase Auth uid. */
  adultUid: string;
  careVertical: "child";
  scopes: GuardianScope[];
  state: GuardianAuthorityState;
  source: GuardianAuthoritySource;
  grantedByUid: string;
  effectiveAt: string;
  expiresAt: string | null;
  revokedAt?: string | null;
  revokedByUid?: string | null;
  /** Bumped in EVERY state/scope transaction — derived projections pin it. */
  accessVersion: number;
  /** Idempotency: the last mutation's operation key (retries converge). */
  lastOperationKey?: string | null;
  policyVersion?: string | null;
  disputeHold?: GuardianAuthorityDisputeHold | null;
  createdAt: string;
  updatedAt: string;
}

export function authorityDocId(childId: string, adultUid: string): string {
  if (!childId || !adultUid) throw new Error("authorityDocId: childId and adultUid are required");
  return `${childId}__${adultUid}`;
}

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

function defaultDb(): Db {
  return admin.firestore();
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type GuardianAuthorityErrorCode =
  | "invalid_input"
  | "household_not_found"
  | "granter_not_member"
  | "target_not_member"
  | "target_not_authenticated" // provisional phone-only member — zero grantable scopes
  | "not_authorized"
  | "authority_not_found"
  | "authority_on_hold"
  | "authority_already_bootstrapped"
  | "concurrent_change" // expectedAccessVersion mismatch
  | "not_in_dispute";

export class GuardianAuthorityError extends Error {
  code: GuardianAuthorityErrorCode;
  constructor(code: GuardianAuthorityErrorCode, message?: string) {
    super(message ?? code);
    this.name = "GuardianAuthorityError";
    this.code = code;
  }
}

// ── checkAuthority — THE permission primitive ────────────────────────────────

export type AuthorityDenialReason =
  | "no_authority"
  | "revoked"
  | "dispute_hold"
  | "expired"
  | "not_yet_effective"
  | "scope_not_granted"
  | "malformed";

export interface AuthorityDecision {
  allowed: boolean;
  reason: "granted" | AuthorityDenialReason;
  accessVersion: number | null;
  authorityId: string;
}

/**
 * Object-level permission check: does `actorUid` hold `scope` for `childId`
 * RIGHT NOW? Reads exactly one authority record. Deliberately never consults
 * users/{uid}, admin flags, memberships, or derived caches — an admin without
 * an explicit authority record is denied like any stranger (R55/AE18), and a
 * household member without a grant gets nothing (AE4).
 *
 * Deny-by-default: unknown state, malformed doc, expiry, pre-effective window,
 * and dispute-hold all deny. Dispute-hold denies FAIL-CLOSED — the affected
 * adult has notice + a dispute path (R18), never silent, but access stays
 * suspended while an operator reviews.
 */
export async function checkAuthority(
  actorUid: string,
  childId: string,
  scope: GuardianScope,
  opts: { db?: Db; now?: Date } = {},
): Promise<AuthorityDecision> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const cleanActor = String(actorUid ?? "").trim();
  const cleanChild = String(childId ?? "").trim();
  if (!cleanActor || !cleanChild || !isGuardianScope(scope)) {
    return { allowed: false, reason: "malformed", accessVersion: null, authorityId: "" };
  }

  const authorityId = authorityDocId(cleanChild, cleanActor);
  const snap = await db.collection(GUARDIAN_AUTHORITIES_COLLECTION).doc(authorityId).get();
  if (!snap.exists) {
    return { allowed: false, reason: "no_authority", accessVersion: null, authorityId };
  }
  const doc = (snap.data() ?? {}) as Partial<GuardianAuthorityDoc>;
  const accessVersion = Number.isFinite(Number(doc.accessVersion)) ? Number(doc.accessVersion) : null;
  const deny = (reason: AuthorityDenialReason): AuthorityDecision => ({
    allowed: false,
    reason,
    accessVersion,
    authorityId,
  });

  // Cross-child / cross-household safety: the record must be about exactly
  // this child and this adult (a mis-keyed or tampered doc denies).
  if (doc.childId !== cleanChild || doc.adultUid !== cleanActor) return deny("malformed");

  if (doc.state === "revoked") return deny("revoked");
  if (doc.state === "dispute_hold") return deny("dispute_hold");
  if (doc.state === "expired") return deny("expired");
  if (doc.state !== "active") return deny("malformed"); // unknown state ⇒ fail closed

  if (typeof doc.effectiveAt === "string" && Date.parse(doc.effectiveAt) > now.getTime()) {
    return deny("not_yet_effective");
  }
  if (typeof doc.expiresAt === "string" && doc.expiresAt && Date.parse(doc.expiresAt) <= now.getTime()) {
    return deny("expired");
  }

  const scopes = Array.isArray(doc.scopes) ? doc.scopes : [];
  if (!scopes.includes(scope)) return deny("scope_not_granted");

  return { allowed: true, reason: "granted", accessVersion, authorityId };
}

// ── Transaction helpers ──────────────────────────────────────────────────────

interface TxContext {
  tx: admin.firestore.Transaction;
  db: Db;
  ts: string;
}

async function loadHouseholdInTx(ctx: TxContext, householdId: string): Promise<HouseholdDoc> {
  const snap = await ctx.tx.get(ctx.db.collection(HOUSEHOLDS_COLLECTION).doc(householdId));
  if (!snap.exists) throw new GuardianAuthorityError("household_not_found");
  const household = (snap.data() ?? {}) as HouseholdDoc;
  if (household.status !== "active") throw new GuardianAuthorityError("household_not_found");
  return household;
}

async function loadActiveMembershipInTx(
  ctx: TxContext,
  householdId: string,
  adultUid: string,
  code: GuardianAuthorityErrorCode,
): Promise<HouseholdMembershipDoc> {
  const snap = await ctx.tx.get(
    ctx.db.collection(HOUSEHOLD_MEMBERSHIPS_COLLECTION).doc(membershipDocId(householdId, adultUid)),
  );
  if (!snap.exists) throw new GuardianAuthorityError(code);
  const membership = (snap.data() ?? {}) as HouseholdMembershipDoc;
  if (membership.status === "provisional" || membership.adultUid === null) {
    // Phone-only members hold ZERO grantable scopes until they authenticate.
    throw new GuardianAuthorityError("target_not_authenticated");
  }
  if (membership.status !== "active") throw new GuardianAuthorityError(code);
  return membership;
}

/** Actor must hold ACTIVE, unexpired `management` for the child (in-tx read). */
async function assertManagementInTx(
  ctx: TxContext,
  childId: string,
  actorUid: string,
  now: Date,
): Promise<GuardianAuthorityDoc> {
  const snap = await ctx.tx.get(
    ctx.db.collection(GUARDIAN_AUTHORITIES_COLLECTION).doc(authorityDocId(childId, actorUid)),
  );
  if (!snap.exists) throw new GuardianAuthorityError("not_authorized");
  const doc = (snap.data() ?? {}) as GuardianAuthorityDoc;
  const expired =
    typeof doc.expiresAt === "string" && doc.expiresAt && Date.parse(doc.expiresAt) <= now.getTime();
  if (
    doc.state !== "active" ||
    expired ||
    !Array.isArray(doc.scopes) ||
    !doc.scopes.includes("management")
  ) {
    throw new GuardianAuthorityError("not_authorized");
  }
  return doc;
}

function bumpHouseholdAccessVersionInTx(ctx: TxContext, household: HouseholdDoc): void {
  ctx.tx.set(
    ctx.db.collection(HOUSEHOLDS_COLLECTION).doc(household.householdId),
    {
      ...household,
      accessVersion: Number(household.accessVersion ?? 0) + 1,
      updatedAt: ctx.ts,
    },
  );
}

// ── Outbox effects (durable, deterministic IDs, created inside the tx) ───────

interface OperationalViewerProjection {
  viewerUids?: string[];
  sourceAuthorityVersions?: Record<string, number>;
  projectionVersion?: number;
}

interface OperationalChildProfile {
  authorizedViewerUids?: string[];
  authorityProjection?: OperationalViewerProjection | null;
  accessVersion?: number;
}

async function loadOperationalChildProfileInTx(
  ctx: TxContext,
  childId: string,
): Promise<{ ref: admin.firestore.DocumentReference; profile: OperationalChildProfile } | null> {
  const ref = ctx.db.collection(CHILD_PROFILES_COLLECTION).doc(childId);
  const snap = await ctx.tx.get(ref);
  if (!snap.exists) return null;
  return { ref, profile: (snap.data() ?? {}) as OperationalChildProfile };
}

/**
 * Remove the adult from the Rules-backed operational-summary cache inside the
 * authority transaction. Full projection recomputation remains defense in
 * depth; this is the minimum synchronous browser denial boundary.
 */
function denyOperationalSummaryInTx(
  ctx: TxContext,
  loaded: { ref: admin.firestore.DocumentReference; profile: OperationalChildProfile } | null,
  adultUid: string,
  authorityAccessVersion: number,
): boolean {
  if (!loaded) return false;
  const { ref, profile } = loaded;
  const currentViewers = Array.isArray(profile.authorizedViewerUids)
    ? profile.authorizedViewerUids
    : [];
  const currentProjection = profile.authorityProjection ?? null;
  const projectedViewers = Array.isArray(currentProjection?.viewerUids)
    ? currentProjection.viewerUids
    : currentViewers;
  const nextViewers = currentViewers.filter((uid) => uid !== adultUid);
  const nextProjectedViewers = projectedViewers.filter((uid) => uid !== adultUid);

  if (
    nextViewers.length === currentViewers.length &&
    nextProjectedViewers.length === projectedViewers.length
  ) {
    return false;
  }

  const priorSourceVersion = Number(
    currentProjection?.sourceAuthorityVersions?.[adultUid] ?? 0,
  );
  const priorProjectionVersion = Number(currentProjection?.projectionVersion ?? 0);
  ctx.tx.update(ref, {
    authorizedViewerUids: nextViewers,
    authorityProjection: {
      viewerUids: nextProjectedViewers,
      sourceAuthorityVersions: {
        ...(currentProjection?.sourceAuthorityVersions ?? {}),
        [adultUid]: authorityAccessVersion,
      },
      projectionVersion: Math.max(
        priorProjectionVersion,
        priorProjectionVersion - priorSourceVersion + authorityAccessVersion,
      ),
      computedAt: ctx.ts,
    },
    accessVersion: Number(profile.accessVersion ?? 0) + 1,
    updatedAt: ctx.ts,
  });
  return true;
}

interface ChildcareRoomForRevocation {
  ref: admin.firestore.DocumentReference;
  data: {
    householdId?: string;
    childIds?: string[];
    participants?: string[];
    participantNames?: string[];
    participantAvatars?: string[];
    unreadCount?: Record<string, number>;
    state?: string;
    accessVersion?: number;
    revokedReason?: string | null;
  };
}

async function loadChildcareRoomsForRevocationInTx(
  ctx: TxContext,
  householdId: string,
  childId: string,
  adultUid: string,
): Promise<ChildcareRoomForRevocation[]> {
  const query = ctx.db
    .collection("chatRooms")
    .where("careVertical", "==", "child")
    .where("participants", "array-contains", adultUid);
  const snap = await ctx.tx.get(query);
  return snap.docs
    .map((doc) => ({
      ref: doc.ref,
      data: (doc.data() ?? {}) as ChildcareRoomForRevocation["data"],
    }))
    .filter(({ data }) => {
      if (data.householdId !== householdId) return false;
      // New rooms carry childIds. Legacy rooms are revoked conservatively
      // because leaving one readable is worse than requiring a new room.
      return !Array.isArray(data.childIds) || data.childIds.includes(childId);
    });
}

function denyChildcareRoomsInTx(
  ctx: TxContext,
  rooms: ChildcareRoomForRevocation[],
  adultUid: string,
): number {
  let denied = 0;
  for (const { ref, data } of rooms) {
    const participants = Array.isArray(data.participants) ? data.participants : [];
    const index = participants.indexOf(adultUid);
    if (index < 0) continue;
    const nextParticipants = participants.filter((uid) => uid !== adultUid);
    const unreadCount = { ...(data.unreadCount ?? {}) };
    delete unreadCount[adultUid];
    ctx.tx.update(ref, {
      participants: nextParticipants,
      participantNames: (data.participantNames ?? []).filter((_, i) => i !== index),
      participantAvatars: (data.participantAvatars ?? []).filter((_, i) => i !== index),
      unreadCount,
      accessVersion: Number(data.accessVersion ?? 0) + 1,
      state: nextParticipants.length < 2 ? "revoked" : data.state ?? "active",
      revokedReason:
        nextParticipants.length < 2
          ? "authority_change"
          : data.revokedReason ?? null,
      updatedAt: ctx.ts,
    });
    denied++;
  }
  return denied;
}

export type AuthorityOutboxKind = "co_guardian_notice" | "derived_access_invalidation";
export type AuthorityOutboxState =
  | "pending"
  | "retry"
  | "processing"
  | "completed"
  | "requires_admin_review";

export interface AuthorityOutboxRecord {
  outboxId: string;
  kind: AuthorityOutboxKind;
  authorityId: string;
  householdId: string;
  childId: string;
  /** The adult whose authority changed (notice recipient). Never child data. */
  affectedAdultUid: string;
  actionByUid: string;
  action: "revoke" | "reduce_scopes";
  authorityAccessVersion: number;
  state: AuthorityOutboxState;
  attemptCount: number;
  nextAttemptAt: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  lastErrorCode?: string | null;
  providerMessageId?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

function outboxDocId(authorityId: string, accessVersion: number, kind: AuthorityOutboxKind): string {
  return `${authorityId}_v${accessVersion}_${kind}`;
}

function enqueueOutboxInTx(
  ctx: TxContext,
  record: Omit<
    AuthorityOutboxRecord,
    "outboxId" | "state" | "attemptCount" | "nextAttemptAt" | "createdAt" | "updatedAt"
  >,
): string {
  const outboxId = outboxDocId(record.authorityId, record.authorityAccessVersion, record.kind);
  const full: AuthorityOutboxRecord = {
    ...record,
    outboxId,
    state: "pending",
    attemptCount: 0,
    nextAttemptAt: ctx.ts,
    createdAt: ctx.ts,
    updatedAt: ctx.ts,
  };
  // set() (not create): a transaction retry overwrites the same deterministic
  // doc — duplicate effects converge to one.
  ctx.tx.set(ctx.db.collection(GUARDIAN_AUTHORITY_OUTBOX_COLLECTION).doc(outboxId), full);
  return outboxId;
}

function openOperatorReviewInTx(
  ctx: TxContext,
  authority: GuardianAuthorityDoc,
  actionByUid: string,
  action: "revoke" | "reduce_scopes",
  reason: string | null,
): void {
  // Operator review path (R18). IDs only — no child names, no free text from
  // the acting adult beyond a bounded reason (R57).
  const alertRef = ctx.db.collection("admin_alerts").doc(
    `guardian_dispute_${authority.authorityId}_v${authority.accessVersion + 1}`,
  );
  ctx.tx.set(alertRef, {
    type: "guardian_authority_dispute_hold",
    severity: "high",
    authorityId: authority.authorityId,
    householdId: authority.householdId,
    childId: authority.childId,
    affectedAdultUid: authority.adultUid,
    actionByUid,
    action,
    reason: reason ? String(reason).slice(0, 300) : null,
    createdAt: ctx.ts,
    resolved: false,
  });
}

// ── Grant ────────────────────────────────────────────────────────────────────

export interface GrantAuthorityParams {
  granterUid: string;
  householdId: string;
  childId: string;
  targetAdultUid: string;
  scopes: GuardianScope[];
  expiresAt?: string | null;
  effectiveAt?: string | null;
  idempotencyKey?: string | null;
  source?: GuardianAuthoritySource;
  policyVersion?: string | null;
}

/**
 * Grant (or widen) authority for a child to an authenticated household adult.
 * The granter must hold active `management` for that child. Granting is
 * additive — reducing another adult's authority goes through
 * updateAuthorityScopes/revokeGuardianAuthority and their R18 dispute-hold
 * contract; this function refuses to shrink an active co-guardian's scopes.
 */
export async function grantGuardianAuthority(
  params: GrantAuthorityParams,
  opts: { db?: Db; now?: Date } = {},
): Promise<GuardianAuthorityDoc> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ts = nowIso(now);
  const scopes = normalizeScopes(params.scopes);
  if (!scopes) throw new GuardianAuthorityError("invalid_input", "scopes must be a non-empty list of known scopes");
  const { granterUid, householdId, childId, targetAdultUid } = params;
  if (!granterUid || !householdId || !childId || !targetAdultUid) {
    throw new GuardianAuthorityError("invalid_input");
  }

  const result = await db.runTransaction(async (tx) => {
    const ctx: TxContext = { tx, db, ts };
    await loadHouseholdInTx(ctx, householdId);
    await loadActiveMembershipInTx(ctx, householdId, granterUid, "granter_not_member");
    await loadActiveMembershipInTx(ctx, householdId, targetAdultUid, "target_not_member");
    await assertManagementInTx(ctx, childId, granterUid, now);

    const authorityId = authorityDocId(childId, targetAdultUid);
    const ref = db.collection(GUARDIAN_AUTHORITIES_COLLECTION).doc(authorityId);
    const snap = await tx.get(ref);

    if (snap.exists) {
      const existing = (snap.data() ?? {}) as GuardianAuthorityDoc;
      if (params.idempotencyKey && existing.lastOperationKey === params.idempotencyKey) {
        return existing; // retry of the same operation — converge, no re-bump
      }
      if (existing.state === "dispute_hold") throw new GuardianAuthorityError("authority_on_hold");
      const merged = normalizeScopes([...(existing.state === "active" ? existing.scopes : []), ...scopes])!;
      const updated: GuardianAuthorityDoc = {
        ...existing,
        householdId,
        childId,
        adultUid: targetAdultUid,
        careVertical: "child",
        scopes: merged,
        state: "active",
        grantedByUid: granterUid,
        effectiveAt: params.effectiveAt ?? existing.effectiveAt ?? ts,
        expiresAt: params.expiresAt !== undefined ? params.expiresAt : existing.expiresAt ?? null,
        revokedAt: null,
        revokedByUid: null,
        accessVersion: Number(existing.accessVersion ?? 0) + 1,
        lastOperationKey: params.idempotencyKey ?? null,
        disputeHold: null,
        updatedAt: ts,
      };
      tx.set(ref, updated);
      return updated;
    }

    const doc: GuardianAuthorityDoc = {
      authorityId,
      householdId,
      childId,
      adultUid: targetAdultUid,
      careVertical: "child",
      scopes,
      state: "active",
      source: params.source ?? "explicit_grant",
      grantedByUid: granterUid,
      effectiveAt: params.effectiveAt ?? ts,
      expiresAt: params.expiresAt ?? null,
      accessVersion: 1,
      lastOperationKey: params.idempotencyKey ?? null,
      policyVersion: params.policyVersion ?? null,
      disputeHold: null,
      createdAt: ts,
      updatedAt: ts,
    };
    tx.set(ref, doc);
    return doc;
  });

  await logAudit({
    eventType: "guardian_authority_granted",
    userId: granterUid,
    data: {
      authorityId: result.authorityId,
      householdId,
      childId,
      targetAdultUid,
      scopes: result.scopes,
      accessVersion: result.accessVersion,
    },
  }).catch(() => {});
  return result;
}

/**
 * Bootstrap the FIRST authority for a child: the household primary adult
 * self-grants full scopes at child-profile creation (U3 calls this server-side
 * with a verified guardian attestation). Refuses when ANY authority already
 * exists for the child — after bootstrap, only management-holders grant.
 */
export async function bootstrapPrimaryGuardianAuthority(
  params: {
    householdId: string;
    childId: string;
    adultUid: string;
    idempotencyKey?: string | null;
    policyVersion?: string | null;
  },
  opts: { db?: Db; now?: Date } = {},
): Promise<GuardianAuthorityDoc> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ts = nowIso(now);
  const { householdId, childId, adultUid } = params;
  if (!householdId || !childId || !adultUid) throw new GuardianAuthorityError("invalid_input");

  // Pre-transaction guard: any existing authority for this child means the
  // bootstrap window is closed (idempotent re-run for the same adult returns
  // the existing doc instead).
  const existingSnap = await db
    .collection(GUARDIAN_AUTHORITIES_COLLECTION)
    .where("childId", "==", childId)
    .get();
  if (!existingSnap.empty) {
    const own = existingSnap.docs
      .map((d) => (d.data() ?? {}) as GuardianAuthorityDoc)
      .find((a) => a.adultUid === adultUid);
    if (
      own &&
      params.idempotencyKey &&
      own.lastOperationKey === params.idempotencyKey &&
      own.source === "bootstrap_primary_guardian"
    ) {
      return own;
    }
    throw new GuardianAuthorityError("authority_already_bootstrapped");
  }

  const result = await db.runTransaction(async (tx) => {
    const ctx: TxContext = { tx, db, ts };
    const household = await loadHouseholdInTx(ctx, householdId);
    if (household.primaryAdultUid !== adultUid) throw new GuardianAuthorityError("not_authorized");
    await loadActiveMembershipInTx(ctx, householdId, adultUid, "granter_not_member");

    const authorityId = authorityDocId(childId, adultUid);
    const ref = db.collection(GUARDIAN_AUTHORITIES_COLLECTION).doc(authorityId);
    const snap = await tx.get(ref);
    if (snap.exists) return (snap.data() ?? {}) as GuardianAuthorityDoc; // retry convergence

    const doc: GuardianAuthorityDoc = {
      authorityId,
      householdId,
      childId,
      adultUid,
      careVertical: "child",
      scopes: [...GUARDIAN_SCOPES],
      state: "active",
      source: "bootstrap_primary_guardian",
      grantedByUid: adultUid,
      effectiveAt: ts,
      expiresAt: null,
      accessVersion: 1,
      lastOperationKey: params.idempotencyKey ?? null,
      policyVersion: params.policyVersion ?? null,
      disputeHold: null,
      createdAt: ts,
      updatedAt: ts,
    };
    tx.set(ref, doc);
    return doc;
  });

  await logAudit({
    eventType: "guardian_authority_granted",
    userId: adultUid,
    data: {
      authorityId: result.authorityId,
      householdId,
      childId,
      targetAdultUid: adultUid,
      scopes: result.scopes,
      accessVersion: result.accessVersion,
      bootstrap: true,
    },
  }).catch(() => {});
  return result;
}

// ── Update scopes (R18 reduction contract) ───────────────────────────────────

export interface UpdateAuthorityScopesParams {
  actorUid: string;
  householdId: string;
  childId: string;
  targetAdultUid: string;
  newScopes: GuardianScope[];
  reason?: string | null;
  idempotencyKey?: string | null;
  /** Optimistic concurrency: mismatch throws concurrent_change. */
  expectedAccessVersion?: number | null;
}

export interface AuthorityChangeResult {
  authority: GuardianAuthorityDoc;
  /** True when the change entered R18 dispute-hold instead of applying directly. */
  disputeHold: boolean;
}

/**
 * Change an authority's scope set.
 *   • Self-reduction, or a pure WIDENING of another adult (a superset of the
 *     current scopes), applies directly with an accessVersion bump.
 *   • REDUCING another adult's active scopes triggers the R18 contract:
 *     dispute-hold state (access suspended fail-closed), durable notice +
 *     invalidation outbox effects, and an operator review alert. Nothing is
 *     silent.
 */
export async function updateAuthorityScopes(
  params: UpdateAuthorityScopesParams,
  opts: { db?: Db; now?: Date } = {},
): Promise<AuthorityChangeResult> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ts = nowIso(now);
  const newScopes = normalizeScopes(params.newScopes);
  if (!newScopes) throw new GuardianAuthorityError("invalid_input", "newScopes must be a non-empty list of known scopes");
  const { actorUid, householdId, childId, targetAdultUid } = params;
  if (!actorUid || !householdId || !childId || !targetAdultUid) {
    throw new GuardianAuthorityError("invalid_input");
  }
  const selfChange = actorUid === targetAdultUid;

  const result = await db.runTransaction(async (tx) => {
    const ctx: TxContext = { tx, db, ts };
    const household = await loadHouseholdInTx(ctx, householdId);
    await loadActiveMembershipInTx(ctx, householdId, actorUid, "granter_not_member");
    if (!selfChange) await assertManagementInTx(ctx, childId, actorUid, now);

    const authorityId = authorityDocId(childId, targetAdultUid);
    const ref = db.collection(GUARDIAN_AUTHORITIES_COLLECTION).doc(authorityId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new GuardianAuthorityError("authority_not_found");
    const existing = (snap.data() ?? {}) as GuardianAuthorityDoc;
    if (existing.householdId !== householdId) throw new GuardianAuthorityError("authority_not_found");

    if (params.idempotencyKey && existing.lastOperationKey === params.idempotencyKey) {
      const denyViewer = existing.state !== "active" || !existing.scopes?.includes("view");
      const denyMessaging = existing.state !== "active" || !existing.scopes?.includes("message");
      const profile = denyViewer
        ? await loadOperationalChildProfileInTx(ctx, childId)
        : null;
      const rooms = denyMessaging
        ? await loadChildcareRoomsForRevocationInTx(
            ctx,
            householdId,
            childId,
            targetAdultUid,
          )
        : [];
      if (denyViewer) {
        denyOperationalSummaryInTx(ctx, profile, targetAdultUid, existing.accessVersion);
      }
      if (denyMessaging) denyChildcareRoomsInTx(ctx, rooms, targetAdultUid);
      return { authority: existing, disputeHold: existing.state === "dispute_hold" };
    }
    if (
      params.expectedAccessVersion !== undefined &&
      params.expectedAccessVersion !== null &&
      Number(existing.accessVersion) !== Number(params.expectedAccessVersion)
    ) {
      throw new GuardianAuthorityError("concurrent_change");
    }
    if (existing.state === "dispute_hold") throw new GuardianAuthorityError("authority_on_hold");
    if (existing.state !== "active") throw new GuardianAuthorityError("authority_not_found");

    const current = new Set(existing.scopes ?? []);
    const isReduction = [...current].some((s) => !newScopes.includes(s));
    const nextVersion = Number(existing.accessVersion ?? 0) + 1;
    const mustDenyOperationalSummary =
      isReduction && (!selfChange || !newScopes.includes("view"));
    const mustDenyMessaging =
      isReduction && (!selfChange || !newScopes.includes("message"));
    const operationalProfile = mustDenyOperationalSummary
      ? await loadOperationalChildProfileInTx(ctx, childId)
      : null;
    const childcareRooms = mustDenyMessaging
      ? await loadChildcareRoomsForRevocationInTx(
          ctx,
          householdId,
          childId,
          targetAdultUid,
        )
      : [];

    if (!isReduction || selfChange) {
      const updated: GuardianAuthorityDoc = {
        ...existing,
        scopes: newScopes,
        accessVersion: nextVersion,
        lastOperationKey: params.idempotencyKey ?? null,
        updatedAt: ts,
      };
      tx.set(ref, updated);
      if (mustDenyOperationalSummary) {
        denyOperationalSummaryInTx(ctx, operationalProfile, targetAdultUid, nextVersion);
      }
      if (mustDenyMessaging) denyChildcareRoomsInTx(ctx, childcareRooms, targetAdultUid);
      if (isReduction) bumpHouseholdAccessVersionInTx(ctx, household); // self-reduction still invalidates projections
      return { authority: updated, disputeHold: false };
    }

    // R18: reducing ANOTHER adult's active authority → dispute-hold + notice +
    // invalidation + operator review, all durable, all in this transaction.
    const noticeOutboxId = enqueueOutboxInTx(ctx, {
      kind: "co_guardian_notice",
      authorityId,
      householdId,
      childId,
      affectedAdultUid: targetAdultUid,
      actionByUid: actorUid,
      action: "reduce_scopes",
      authorityAccessVersion: nextVersion,
    });
    enqueueOutboxInTx(ctx, {
      kind: "derived_access_invalidation",
      authorityId,
      householdId,
      childId,
      affectedAdultUid: targetAdultUid,
      actionByUid: actorUid,
      action: "reduce_scopes",
      authorityAccessVersion: nextVersion,
    });
    openOperatorReviewInTx(ctx, existing, actorUid, "reduce_scopes", params.reason ?? null);
    bumpHouseholdAccessVersionInTx(ctx, household);

    const held: GuardianAuthorityDoc = {
      ...existing,
      state: "dispute_hold",
      accessVersion: nextVersion,
      lastOperationKey: params.idempotencyKey ?? null,
      disputeHold: {
        pendingAction: "reduce_scopes",
        pendingScopes: newScopes,
        openedAt: ts,
        openedByUid: actorUid,
        reason: params.reason ? String(params.reason).slice(0, 300) : null,
        noticeOutboxId,
        resolvedAt: null,
        resolvedByUid: null,
        resolution: null,
      },
      updatedAt: ts,
    };
    tx.set(ref, held);
    denyOperationalSummaryInTx(ctx, operationalProfile, targetAdultUid, nextVersion);
    denyChildcareRoomsInTx(ctx, childcareRooms, targetAdultUid);
    return { authority: held, disputeHold: true };
  });

  await logAudit({
    eventType: result.disputeHold ? "guardian_authority_dispute_hold" : "guardian_authority_updated",
    userId: actorUid,
    data: {
      authorityId: result.authority.authorityId,
      householdId,
      childId,
      targetAdultUid,
      newScopes,
      accessVersion: result.authority.accessVersion,
      disputeHold: result.disputeHold,
    },
  }).catch(() => {});
  return result;
}

// ── Revoke (R18 co-guardian contract) ────────────────────────────────────────

export interface RevokeAuthorityParams {
  actorUid: string;
  householdId: string;
  childId: string;
  targetAdultUid: string;
  reason?: string | null;
  idempotencyKey?: string | null;
  expectedAccessVersion?: number | null;
}

/**
 * Revoke an authority.
 *   • Self-revocation applies immediately (revoked) with invalidation fan-out.
 *   • Revoking ANOTHER adult's active authority requires `management` and
 *     enters R18 dispute-hold (access suspended fail-closed) with a durable
 *     co-guardian notice, derived-access invalidation, and an operator review
 *     alert — no silent lockout.
 */
export async function revokeGuardianAuthority(
  params: RevokeAuthorityParams,
  opts: { db?: Db; now?: Date } = {},
): Promise<AuthorityChangeResult> {
  const db = opts.db ?? defaultDb();
  const now = opts.now ?? new Date();
  const ts = nowIso(now);
  const { actorUid, householdId, childId, targetAdultUid } = params;
  if (!actorUid || !householdId || !childId || !targetAdultUid) {
    throw new GuardianAuthorityError("invalid_input");
  }
  const selfRevoke = actorUid === targetAdultUid;

  const result = await db.runTransaction(async (tx) => {
    const ctx: TxContext = { tx, db, ts };
    const household = await loadHouseholdInTx(ctx, householdId);
    await loadActiveMembershipInTx(ctx, householdId, actorUid, "granter_not_member");
    if (!selfRevoke) await assertManagementInTx(ctx, childId, actorUid, now);

    const authorityId = authorityDocId(childId, targetAdultUid);
    const ref = db.collection(GUARDIAN_AUTHORITIES_COLLECTION).doc(authorityId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new GuardianAuthorityError("authority_not_found");
    const existing = (snap.data() ?? {}) as GuardianAuthorityDoc;
    if (existing.householdId !== householdId) throw new GuardianAuthorityError("authority_not_found");

    if (params.idempotencyKey && existing.lastOperationKey === params.idempotencyKey) {
      if (existing.state !== "active") {
        const profile = await loadOperationalChildProfileInTx(ctx, childId);
        const rooms = await loadChildcareRoomsForRevocationInTx(
          ctx,
          householdId,
          childId,
          targetAdultUid,
        );
        denyOperationalSummaryInTx(ctx, profile, targetAdultUid, existing.accessVersion);
        denyChildcareRoomsInTx(ctx, rooms, targetAdultUid);
      }
      return { authority: existing, disputeHold: existing.state === "dispute_hold" };
    }
    if (existing.state === "revoked") {
      const profile = await loadOperationalChildProfileInTx(ctx, childId);
      const rooms = await loadChildcareRoomsForRevocationInTx(
        ctx,
        householdId,
        childId,
        targetAdultUid,
      );
      denyOperationalSummaryInTx(ctx, profile, targetAdultUid, existing.accessVersion);
      denyChildcareRoomsInTx(ctx, rooms, targetAdultUid);
      return { authority: existing, disputeHold: false };
    }
    if (
      params.expectedAccessVersion !== undefined &&
      params.expectedAccessVersion !== null &&
      Number(existing.accessVersion) !== Number(params.expectedAccessVersion)
    ) {
      throw new GuardianAuthorityError("concurrent_change");
    }
    if (existing.state === "dispute_hold") throw new GuardianAuthorityError("authority_on_hold");

    const nextVersion = Number(existing.accessVersion ?? 0) + 1;
    const operationalProfile = await loadOperationalChildProfileInTx(ctx, childId);
    const childcareRooms = await loadChildcareRoomsForRevocationInTx(
      ctx,
      householdId,
      childId,
      targetAdultUid,
    );

    if (selfRevoke) {
      enqueueOutboxInTx(ctx, {
        kind: "derived_access_invalidation",
        authorityId,
        householdId,
        childId,
        affectedAdultUid: targetAdultUid,
        actionByUid: actorUid,
        action: "revoke",
        authorityAccessVersion: nextVersion,
      });
      bumpHouseholdAccessVersionInTx(ctx, household);
      const revoked: GuardianAuthorityDoc = {
        ...existing,
        state: "revoked",
        revokedAt: ts,
        revokedByUid: actorUid,
        accessVersion: nextVersion,
        lastOperationKey: params.idempotencyKey ?? null,
        disputeHold: null,
        updatedAt: ts,
      };
      tx.set(ref, revoked);
      denyOperationalSummaryInTx(ctx, operationalProfile, targetAdultUid, nextVersion);
      denyChildcareRoomsInTx(ctx, childcareRooms, targetAdultUid);
      return { authority: revoked, disputeHold: false };
    }

    // Co-guardian revocation → R18 dispute-hold.
    const noticeOutboxId = enqueueOutboxInTx(ctx, {
      kind: "co_guardian_notice",
      authorityId,
      householdId,
      childId,
      affectedAdultUid: targetAdultUid,
      actionByUid: actorUid,
      action: "revoke",
      authorityAccessVersion: nextVersion,
    });
    enqueueOutboxInTx(ctx, {
      kind: "derived_access_invalidation",
      authorityId,
      householdId,
      childId,
      affectedAdultUid: targetAdultUid,
      actionByUid: actorUid,
      action: "revoke",
      authorityAccessVersion: nextVersion,
    });
    openOperatorReviewInTx(ctx, existing, actorUid, "revoke", params.reason ?? null);
    bumpHouseholdAccessVersionInTx(ctx, household);

    const held: GuardianAuthorityDoc = {
      ...existing,
      state: "dispute_hold",
      accessVersion: nextVersion,
      lastOperationKey: params.idempotencyKey ?? null,
      disputeHold: {
        pendingAction: "revoke",
        openedAt: ts,
        openedByUid: actorUid,
        reason: params.reason ? String(params.reason).slice(0, 300) : null,
        noticeOutboxId,
        resolvedAt: null,
        resolvedByUid: null,
        resolution: null,
      },
      updatedAt: ts,
    };
    tx.set(ref, held);
    denyOperationalSummaryInTx(ctx, operationalProfile, targetAdultUid, nextVersion);
    denyChildcareRoomsInTx(ctx, childcareRooms, targetAdultUid);
    return { authority: held, disputeHold: true };
  });

  await logAudit({
    eventType: result.disputeHold ? "guardian_authority_dispute_hold" : "guardian_authority_revoked",
    userId: actorUid,
    data: {
      authorityId: result.authority.authorityId,
      householdId,
      childId,
      targetAdultUid,
      accessVersion: result.authority.accessVersion,
      disputeHold: result.disputeHold,
    },
  }).catch(() => {});
  return result;
}

// ── Operator dispute resolution (R18 review path; U12 wires the operator UI) ─

export async function resolveAuthorityDispute(
  params: {
    operatorUid: string;
    childId: string;
    targetAdultUid: string;
    resolution: "applied" | "restored";
  },
  opts: { db?: Db; now?: Date } = {},
): Promise<GuardianAuthorityDoc> {
  const db = opts.db ?? defaultDb();
  const ts = nowIso(opts.now);
  const authorityId = authorityDocId(params.childId, params.targetAdultUid);
  const ref = db.collection(GUARDIAN_AUTHORITIES_COLLECTION).doc(authorityId);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new GuardianAuthorityError("authority_not_found");
    const existing = (snap.data() ?? {}) as GuardianAuthorityDoc;
    if (existing.state !== "dispute_hold" || !existing.disputeHold) {
      throw new GuardianAuthorityError("not_in_dispute");
    }
    const hold = existing.disputeHold;
    const nextVersion = Number(existing.accessVersion ?? 0) + 1;
    const resolvedHold: GuardianAuthorityDisputeHold = {
      ...hold,
      resolvedAt: ts,
      resolvedByUid: params.operatorUid,
      resolution: params.resolution,
    };

    let updated: GuardianAuthorityDoc;
    if (params.resolution === "restored") {
      updated = {
        ...existing,
        state: "active",
        accessVersion: nextVersion,
        disputeHold: resolvedHold,
        updatedAt: ts,
      };
    } else if (hold.pendingAction === "reduce_scopes") {
      updated = {
        ...existing,
        state: "active",
        scopes: hold.pendingScopes ?? existing.scopes,
        accessVersion: nextVersion,
        disputeHold: resolvedHold,
        updatedAt: ts,
      };
    } else {
      updated = {
        ...existing,
        state: "revoked",
        revokedAt: ts,
        revokedByUid: hold.openedByUid,
        accessVersion: nextVersion,
        disputeHold: resolvedHold,
        updatedAt: ts,
      };
    }
    tx.set(ref, updated);
    return updated;
  });

  await logAudit({
    eventType: "guardian_authority_dispute_resolved",
    userId: params.operatorUid,
    data: {
      authorityId: result.authorityId,
      resolution: params.resolution,
      state: result.state,
      accessVersion: result.accessVersion,
    },
  }).catch(() => {});
  return result;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getAuthority(
  childId: string,
  adultUid: string,
  db: Db = defaultDb(),
): Promise<GuardianAuthorityDoc | null> {
  if (!childId || !adultUid) return null;
  const snap = await db
    .collection(GUARDIAN_AUTHORITIES_COLLECTION)
    .doc(authorityDocId(childId, adultUid))
    .get();
  return snap.exists ? ((snap.data() ?? {}) as GuardianAuthorityDoc) : null;
}

/** All authority rows for one adult (equality-only query — no composite index). */
export async function listAuthoritiesForAdult(
  adultUid: string,
  db: Db = defaultDb(),
): Promise<GuardianAuthorityDoc[]> {
  const snap = await db
    .collection(GUARDIAN_AUTHORITIES_COLLECTION)
    .where("adultUid", "==", adultUid)
    .get();
  return snap.docs.map((d) => (d.data() ?? {}) as GuardianAuthorityDoc);
}

// ── Outbox dispatcher (claim/lease/retry/terminal — approvalNoticeDispatcher) ─

const LEASE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function retryAt(attemptCount: number, nowMs = Date.now()): string {
  const delaysMinutes = [1, 5, 15, 60, 240];
  const delay = delaysMinutes[Math.min(Math.max(attemptCount - 1, 0), delaysMinutes.length - 1)];
  return new Date(nowMs + delay * 60 * 1000).toISOString();
}

async function claimAuthorityOutbox(
  db: Db,
  outboxId: string,
  workerId: string,
): Promise<AuthorityOutboxRecord | null> {
  const ref = db.collection(GUARDIAN_AUTHORITY_OUTBOX_COLLECTION).doc(outboxId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const record = (snap.data() ?? {}) as AuthorityOutboxRecord;
    const now = Date.now();
    const nextAttempt = record.nextAttemptAt ? Date.parse(record.nextAttemptAt) : 0;
    const leaseExpiry = record.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) : 0;
    const claimable = record.state === "pending" || record.state === "retry";
    if (!claimable || nextAttempt > now || leaseExpiry > now) return null;

    const attemptCount = Number(record.attemptCount ?? 0) + 1;
    tx.update(ref, {
      state: "processing",
      attemptCount,
      leaseOwner: workerId,
      leaseExpiresAt: new Date(now + LEASE_MS).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    return { ...record, state: "processing", attemptCount };
  });
}

async function moveOutboxToRetryOrReview(db: Db, outboxId: string, errorCode: string): Promise<void> {
  const ref = db.collection(GUARDIAN_AUTHORITY_OUTBOX_COLLECTION).doc(outboxId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const record = (snap.data() ?? {}) as AuthorityOutboxRecord;
    if (record.state === "completed") return;
    const attemptCount = Number(record.attemptCount ?? 0);
    const terminal = attemptCount >= MAX_ATTEMPTS;
    const now = new Date().toISOString();
    tx.update(ref, {
      state: terminal ? "requires_admin_review" : "retry",
      nextAttemptAt: terminal ? null : retryAt(attemptCount),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: String(errorCode).slice(0, 100),
      updatedAt: now,
    });
    if (terminal) {
      tx.set(
        db.collection("admin_alerts").doc(`guardian_outbox_stuck_${outboxId}`),
        {
          type: "guardian_authority_outbox_stuck",
          severity: "high",
          outboxId,
          authorityId: record.authorityId,
          kind: record.kind,
          lastErrorCode: String(errorCode).slice(0, 100),
          createdAt: now,
          resolved: false,
        },
      );
    }
  });
}

async function markOutboxCompleted(
  db: Db,
  outboxId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date().toISOString();
  const ref = db.collection(GUARDIAN_AUTHORITY_OUTBOX_COLLECTION).doc(outboxId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || (snap.data() ?? {}).state !== "processing") return;
    tx.update(ref, {
      state: "completed",
      completedAt: now,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      updatedAt: now,
      ...extra,
    });
  });
}

/**
 * Co-guardian notice (R18). Adult-generic wording: never a child name, exact
 * address, or custody detail (R57) — detail lives behind authenticated views.
 */
async function handleCoGuardianNotice(db: Db, record: AuthorityOutboxRecord): Promise<boolean> {
  const userSnap = await db.collection("users").doc(record.affectedAdultUid).get();
  const phone = userSnap.exists ? (userSnap.data() ?? {}).phone : undefined;
  if (typeof phone !== "string" || !phone) {
    await moveOutboxToRetryOrReview(db, record.outboxId, "affected_adult_phone_not_found");
    return false;
  }

  const providerMessageIds: string[] = [];
  try {
    // Lazy import keeps this module's test graph free of the full agent stack.
    const { sendViaInteractionAgent } = await import("../agents/caraAgent");
    const sent = await sendViaInteractionAgent(phone, {
      content:
        "A change was made to your care coordination access for your household on Evia. " +
        "If you did not expect this, reply DISPUTE and a reviewer will look into it, " +
        "or contact support@eviacares.com.",
      urgency: "standard",
      sourceAgent: "guardian_authority_notice",
      canDrop: false,
      preferredService: "SMS",
      onTransportReceipt: (messageId: string) => {
        providerMessageIds.push(messageId);
      },
    });
    if (!sent || providerMessageIds.length === 0) {
      await moveOutboxToRetryOrReview(
        db,
        record.outboxId,
        sent ? "missing_provider_receipt" : "message_suppressed",
      );
      return false;
    }
    await markOutboxCompleted(db, record.outboxId, { providerMessageId: providerMessageIds[0] });
    return true;
  } catch (err) {
    await moveOutboxToRetryOrReview(
      db,
      record.outboxId,
      err instanceof Error ? err.name : "send_failed",
    );
    return false;
  }
}

/**
 * Derived-access invalidation fan-out: revoke every PENDING invite token of the
 * household (fail-closed — re-inviting is cheap; a stale scope proposal
 * surviving an authority change is not). Later units hook their own
 * invalidations (safety projections U7, chat access U9) onto this effect kind.
 */
async function handleDerivedAccessInvalidation(
  db: Db,
  record: AuthorityOutboxRecord,
): Promise<boolean> {
  try {
    const pending = await db
      .collection(CHILDCARE_INVITE_TOKENS_COLLECTION)
      .where("householdId", "==", record.householdId)
      .where("status", "==", "pending")
      .get();
    const now = new Date().toISOString();
    for (const doc of pending.docs) {
      await doc.ref.update({
        status: "revoked",
        revokedReason: "authority_change",
        revokedAt: now,
        updatedAt: now,
      });
    }
    // U3 hook: refresh the child's derived viewer cache (authorizedViewerUids
    // on child_profiles — display-read cache, R6). Durable here so a missed
    // best-effort refresh in the callable still converges. Lazy import keeps
    // the module graphs acyclic (repository imports this module).
    const { recomputeAuthorizedViewerProjection } = await import("../data/childProfileRepository");
    await recomputeAuthorizedViewerProjection(record.childId, { db });
    // U7 hook (R19/AE20/KTD13): an authority change re-versions every ACTIVE
    // booking safety projection touching this child — revoke-then-replace, so
    // no stale projection survives a pickup/authority change. Durable here
    // (outbox retry) like the viewer-cache refresh above.
    const { reprojectActiveBookingSafetyForChild } = await import("./safetyProjection");
    const reprojection = await reprojectActiveBookingSafetyForChild(record.childId, { db });
    // U9 hook (R42/AE20): when the affected adult no longer holds LIVE
    // `message` scope for this child, they drop off every childcare
    // conversation of the household (read+write die — participants array is
    // the rules key) with an accessVersion bump. Rechecked live so a scope
    // reduction that KEPT `message` removes nothing.
    let conversationsRevoked = 0;
    const messageDecision = await checkAuthority(record.affectedAdultUid, record.childId, "message", {
      db,
    });
    if (!messageDecision.allowed) {
      const { revokeChildcareConversationsForAdultInHousehold } = await import(
        "./conversationPolicy"
      );
      conversationsRevoked = await revokeChildcareConversationsForAdultInHousehold(
        record.householdId,
        record.affectedAdultUid,
        { db, reason: "authority_change" },
      );
    }
    await markOutboxCompleted(db, record.outboxId, {
      invalidatedInviteCount: pending.size,
      safetyReprojectedCount: reprojection.reprojected,
      safetyRevokedOnlyCount: reprojection.revokedOnly,
      conversationsRevokedCount: conversationsRevoked,
    });
    return true;
  } catch (err) {
    await moveOutboxToRetryOrReview(
      db,
      record.outboxId,
      err instanceof Error ? err.name : "invalidation_failed",
    );
    return false;
  }
}

export async function dispatchAuthorityOutboxRecord(
  outboxId: string,
  workerId: string,
  db: Db = defaultDb(),
): Promise<boolean> {
  const record = await claimAuthorityOutbox(db, outboxId, workerId);
  if (!record) return false;
  if (record.kind === "co_guardian_notice") return handleCoGuardianNotice(db, record);
  if (record.kind === "derived_access_invalidation") return handleDerivedAccessInvalidation(db, record);
  await moveOutboxToRetryOrReview(db, outboxId, "unknown_effect_kind");
  return false;
}

export async function processGuardianAuthorityOutbox(
  db: Db = defaultDb(),
): Promise<{ attempted: number; completed: number }> {
  const now = new Date().toISOString();
  const workerId = `guardian-authority-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Query contract Q30 (firestore.query-contracts.json): state + nextAttemptAt.
  const ready = await db
    .collection(GUARDIAN_AUTHORITY_OUTBOX_COLLECTION)
    .where("state", "in", ["pending", "retry"])
    .where("nextAttemptAt", "<=", now)
    .orderBy("nextAttemptAt", "asc")
    .limit(20)
    .get();

  let completed = 0;
  for (const doc of ready.docs) {
    if (await dispatchAuthorityOutboxRecord(doc.id, workerId, db)) completed += 1;
  }
  return { attempted: ready.size, completed };
}

export const dispatchGuardianAuthorityOutbox = functions.pubsub
  .schedule("every 1 minutes")
  .timeZone("UTC")
  .onRun(async () => {
    await processGuardianAuthorityOutbox();
  });
