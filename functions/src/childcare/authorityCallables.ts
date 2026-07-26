// ── Household + guardian-authority callables (plan 2026-07-22-002, U2) ────────
//
// v1 callables (deployed as v1-<name> via the firebase.json prefix):
//   createHousehold, inviteHouseholdAdult, acceptHouseholdInvite,
//   grantGuardianAuthority, updateAuthorityScopes, revokeGuardianAuthority,
//   getMyHouseholdState
//
// Every callable stacks the R21 controls in order:
//   1. requireAppCheck (KTD22 — monitor/enforce via CHILDCARE_APPCHECK_MODE)
//   2. Firebase Auth (context.auth)
//   3. Childcare runtime flags (R61 — Firestore-resident; mutations need
//      writesEnabled, reads need enabled; everything dark until launch)
//   4. Rate limiting (functions/src/rateLimit.ts checkRateLimit — fail-closed)
//   5. Recent authentication on HIGH-RISK ops, verified from the ID token's
//      server-checked `auth_time` claim (R18 as amended) — NEVER a
//      client-supplied or Firestore-stored timestamp.
//   6. Input bounds + idempotency keys
//   7. Object-level authorization inside guardianAuthority/householdRepository
//      transactions
//   8. Enumeration-safe errors: not-found and not-authorized are the SAME
//      generic permission-denied; invite failures (expired/replayed/wrong
//      contact/unknown) are one indistinguishable error.
//
// Browser writes to households/household_memberships/guardian_authorities/
// childcare_invite_tokens are denied by firestore.rules — these callables are
// the only mutation path (R11/KTD6).

import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { createHash, randomBytes } from "crypto";
import { checkRateLimit, type RateLimitConfig } from "../rateLimit";
import { getChildcareFlags } from "../config/featureFlags";
import { logAudit } from "../observability/auditLog";
import { childcareOnCall } from "./appCheckPolicy";
import {
  createHouseholdWithPrimaryMembership,
  getActiveMembership,
  getHousehold,
  listMembershipsForAdult,
  membershipDocId,
  HouseholdError,
  HOUSEHOLD_MEMBERSHIPS_COLLECTION,
  type HouseholdMembershipDoc,
} from "./householdRepository";
import {
  checkAuthority,
  grantGuardianAuthority as grantAuthorityTx,
  updateAuthorityScopes as updateScopesTx,
  revokeGuardianAuthority as revokeAuthorityTx,
  listAuthoritiesForAdult,
  normalizeScopes,
  GuardianAuthorityError,
  CHILDCARE_INVITE_TOKENS_COLLECTION,
  type GuardianScope,
} from "./guardianAuthority";

// ── Shared guard helpers ─────────────────────────────────────────────────────

const E164 = /^\+\d{10,15}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** Default recent-auth window for high-risk authority ops (R18): 10 minutes. */
export const RECENT_AUTH_MAX_AGE_SECONDS_DEFAULT = 600;

export function recentAuthMaxAgeSeconds(): number {
  const v = parseInt(process.env.CHILDCARE_RECENT_AUTH_MAX_AGE_SECONDS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : RECENT_AUTH_MAX_AGE_SECONDS_DEFAULT;
}

/**
 * R18 recent authentication: verified EXCLUSIVELY from the ID token's
 * server-checked `auth_time` claim (seconds since epoch, stamped by Firebase
 * Auth at sign-in and cryptographically bound to the token). A missing or
 * stale claim fails closed. Client payloads and Firestore timestamps are
 * NEVER consulted.
 */
export function requireRecentAuth(
  context: functions.https.CallableContext,
  opts: { maxAgeSeconds?: number; now?: Date } = {},
): void {
  const maxAge = opts.maxAgeSeconds ?? recentAuthMaxAgeSeconds();
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const authTime = Number((context.auth?.token as Record<string, unknown> | undefined)?.auth_time);
  if (!Number.isFinite(authTime) || authTime <= 0 || nowSeconds - authTime > maxAge) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Recent sign-in required. Please sign in again and retry this action.",
      { code: "recent_auth_required" },
    );
  }
}

function requireAuth(context: functions.https.CallableContext): string {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  return context.auth.uid;
}

const CHILDCARE_MUTATION_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: "rl:childcare:mut:",
};
const CHILDCARE_READ_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 60,
  keyPrefix: "rl:childcare:read:",
};

async function enforceRateLimit(
  op: string,
  uid: string,
  config: RateLimitConfig,
): Promise<void> {
  const result = await checkRateLimit(`${op}:${uid}`, config); // fail-closed util
  if (!result.allowed) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Too many requests. Please wait a moment and try again.",
    );
  }
}

/** Mutations require CHILDCARE_WRITES_ENABLED; reads require CHILDCARE_ENABLED (R61). */
async function requireChildcareFlags(kind: "read" | "write"): Promise<void> {
  const flags = await getChildcareFlags();
  const ok = kind === "write" ? flags.writesEnabled : flags.enabled;
  if (!ok) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Childcare features are not available yet.",
      { code: "childcare_disabled" },
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

/** ONE indistinguishable error for every invalid-invite shape (R21/AE4). */
function invalidInvite(): functions.https.HttpsError {
  return new functions.https.HttpsError(
    "permission-denied",
    "This invitation is not valid. Ask the household owner to send a new one.",
  );
}

/** Map internal typed errors to enumeration-safe HttpsErrors. */
function mapAuthorityError(err: unknown): never {
  if (err instanceof functions.https.HttpsError) throw err;
  if (err instanceof GuardianAuthorityError) {
    if (err.code === "invalid_input") {
      throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
    }
    if (err.code === "concurrent_change") {
      throw new functions.https.HttpsError(
        "aborted",
        "This authority changed while you were editing. Reload and try again.",
        { code: "concurrent_change" },
      );
    }
    if (err.code === "authority_on_hold") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This authority is under review and cannot be changed right now.",
        { code: "authority_on_hold" },
      );
    }
    // household_not_found / granter_not_member / target_not_member /
    // target_not_authenticated / not_authorized / authority_not_found /
    // authority_already_bootstrapped — all deliberately indistinguishable.
    throw permissionDenied();
  }
  if (err instanceof HouseholdError) {
    if (err.code === "invalid_input") {
      throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
    }
    throw permissionDenied();
  }
  console.error("[authorityCallables] unexpected error:", err instanceof Error ? err.name : "Error");
  throw new functions.https.HttpsError("internal", "Something went wrong. Please try again.");
}

/**
 * U3 hook: refresh the child's derived viewer cache (authorizedViewerUids on
 * child_profiles — R6 display-read cache, never authority) after an authority
 * change. Best-effort here; reduce/revoke paths ALSO converge durably through
 * the derived_access_invalidation outbox effect. Lazy import keeps the module
 * graph acyclic (the repository imports guardianAuthority).
 */
async function refreshViewerProjection(childId: string): Promise<void> {
  try {
    const { recomputeAuthorizedViewerProjection } = await import("../data/childProfileRepository");
    await recomputeAuthorizedViewerProjection(childId);
  } catch {
    // Fail-soft: a stale cache can only under- or over-show the operational
    // SUMMARY read; every server decision re-checks checkAuthority.
  }
}

// ── Invite token helpers ─────────────────────────────────────────────────────

export type InviteContactChannel = "sms" | "email";

export interface InviteIntendedContact {
  channel: InviteContactChannel;
  /** Normalized E.164 phone or lowercased email. Adult contact, never child data. */
  value: string;
}

async function verifySynchronousAuthorityDenial(
  householdId: string,
  childId: string,
  adultUid: string,
  authority: { state: string; scopes: GuardianScope[] },
): Promise<void> {
  const db = admin.firestore();
  const deniesAll = authority.state !== "active";
  if (deniesAll || !authority.scopes.includes("view")) {
    const profile = await db.collection("child_profiles").doc(childId).get();
    const viewers = (profile.data() ?? {}).authorizedViewerUids;
    if (profile.exists && Array.isArray(viewers) && viewers.includes(adultUid)) {
      throw new Error("synchronous_revocation_postcondition: operational summary still readable");
    }
  }
  if (deniesAll || !authority.scopes.includes("message")) {
    const rooms = await db
      .collection("chatRooms")
      .where("careVertical", "==", "child")
      .where("participants", "array-contains", adultUid)
      .get();
    const stillReadable = rooms.docs.some((doc) => {
      const room = doc.data() ?? {};
      if (room.householdId !== householdId) return false;
      return !Array.isArray(room.childIds) || room.childIds.includes(childId);
    });
    if (stillReadable) {
      throw new Error("synchronous_revocation_postcondition: childcare room still readable");
    }
  }
}

export type InviteTokenStatus = "pending" | "accepted" | "revoked" | "expired";

export interface ChildcareInviteTokenDoc {
  tokenId: string;
  householdId: string;
  invitedByUid: string;
  intendedContact: InviteIntendedContact;
  /** Scopes the invited adult will consent to at acceptance — per child. */
  proposedScopes: Array<{ childId: string; scopes: GuardianScope[] }>;
  /** sha256 hex of the single-use nonce; the raw nonce lives only in the link. */
  nonceHash: string;
  status: InviteTokenStatus;
  expiresAt: string;
  usedByUid?: string | null;
  usedAt?: string | null;
  revokedReason?: string | null;
  revokedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const INVITE_TTL_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000; // 7 days

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function inviteTokenDocId(householdId: string, idempotencyKey: string): string {
  return `inv_${sha256Hex(`${householdId}:${idempotencyKey}`).slice(0, 40)}`;
}

/** Opaque single-use invite credential: `<tokenId>.<nonce>`. */
export function encodeInviteToken(tokenId: string, nonce: string): string {
  return `${tokenId}.${nonce}`;
}

export function decodeInviteToken(raw: unknown): { tokenId: string; nonce: string } | null {
  if (typeof raw !== "string") return null;
  const m = /^(inv_[a-f0-9]{40})\.([a-f0-9]{32,64})$/.exec(raw.trim());
  return m ? { tokenId: m[1], nonce: m[2] } : null;
}

function normalizeIntendedContact(raw: unknown): InviteIntendedContact | null {
  if (!raw || typeof raw !== "object") return null;
  const channel = (raw as Record<string, unknown>).channel;
  const value = String((raw as Record<string, unknown>).value ?? "").trim();
  if (channel === "sms") {
    return E164.test(value) ? { channel: "sms", value } : null;
  }
  if (channel === "email") {
    const email = value.toLowerCase();
    return EMAIL.test(email) ? { channel: "email", value: email } : null;
  }
  return null;
}

function normalizeProposedScopes(
  raw: unknown,
): Array<{ childId: string; scopes: GuardianScope[] }> | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 10) return null;
  const out: Array<{ childId: string; scopes: GuardianScope[] }> = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const childId = String((entry as Record<string, unknown>).childId ?? "").trim();
    if (!childId || childId.length > 128 || seen.has(childId)) return null;
    const scopes = normalizeScopes((entry as Record<string, unknown>).scopes);
    if (!scopes) return null;
    seen.add(childId);
    out.push({ childId, scopes });
  }
  return out;
}

/**
 * Wrong-contact check: the accepting adult's OWN verified token claims must
 * match the invite's intended contact. token.phone_number is set by Firebase
 * Phone Auth; email requires email_verified. Client payloads prove nothing.
 */
function callerMatchesIntendedContact(
  context: functions.https.CallableContext,
  contact: InviteIntendedContact,
): boolean {
  const token = (context.auth?.token ?? {}) as Record<string, unknown>;
  if (contact.channel === "sms") {
    return typeof token.phone_number === "string" && token.phone_number === contact.value;
  }
  return (
    typeof token.email === "string" &&
    token.email.toLowerCase() === contact.value &&
    token.email_verified === true
  );
}

// ── createHousehold ──────────────────────────────────────────────────────────

export const createHousehold = childcareOnCall("createHousehold", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("createHousehold", uid, CHILDCARE_MUTATION_RATE);

  try {
    const result = await createHouseholdWithPrimaryMembership(uid);
    await logAudit({
      eventType: "household_created",
      userId: uid,
      data: { householdId: result.household.householdId, created: result.created },
    }).catch(() => {});
    return {
      success: true,
      householdId: result.household.householdId,
      created: result.created,
    };
  } catch (err) {
    mapAuthorityError(err);
  }
});

// ── inviteHouseholdAdult ─────────────────────────────────────────────────────

export const inviteHouseholdAdult = childcareOnCall("inviteHouseholdAdult", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("inviteHouseholdAdult", uid, CHILDCARE_MUTATION_RATE);
  requireRecentAuth(context); // proposing authority scopes is high-risk (R18)

  const householdId = String(data?.householdId ?? "").trim();
  const contact = normalizeIntendedContact(data?.intendedContact);
  const proposedScopes = normalizeProposedScopes(data?.proposedScopes);
  const idempotencyKey = String(data?.idempotencyKey ?? "").trim();
  if (
    !householdId ||
    householdId.length > 200 ||
    !contact ||
    proposedScopes === null ||
    !idempotencyKey ||
    idempotencyKey.length > 128
  ) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }

  try {
    const db = admin.firestore();
    const [household, membership] = await Promise.all([
      getHousehold(householdId, db),
      getActiveMembership(householdId, uid, db),
    ]);
    if (!household || household.status !== "active" || !membership) throw permissionDenied();

    // Who may invite: the primary adult always; another active member only when
    // they hold `management` for EVERY child whose scopes the invite proposes
    // (and management-holders cannot invite scope-free adults — that household
    // shaping stays with the primary).
    const isPrimary = household.primaryAdultUid === uid;
    if (!isPrimary) {
      if (proposedScopes.length === 0) throw permissionDenied();
      for (const p of proposedScopes) {
        const decision = await checkAuthority(uid, p.childId, "management", { db });
        if (!decision.allowed) throw permissionDenied();
      }
    } else {
      // Primary must still hold management for children they delegate on —
      // unless no authority exists yet for that child (pre-U3 bootstrap gap
      // closes when child profiles land; a proposal for an unknown child is
      // simply carried and re-verified at acceptance).
      for (const p of proposedScopes) {
        const decision = await checkAuthority(uid, p.childId, "management", { db });
        if (!decision.allowed && decision.reason !== "no_authority") throw permissionDenied();
      }
    }

    const tokenId = inviteTokenDocId(householdId, idempotencyKey);
    const nonce = randomBytes(24).toString("hex");
    const now = new Date();
    const ref = db.collection(CHILDCARE_INVITE_TOKENS_COLLECTION).doc(tokenId);
    const existing = await ref.get();
    if (existing.exists) {
      // Idempotent retry: the nonce was already minted and returned once; a
      // replayed create call cannot re-read it (single-use secrecy), so the
      // caller gets the token status only.
      const doc = (existing.data() ?? {}) as ChildcareInviteTokenDoc;
      return { success: true, tokenId, status: doc.status, alreadyExisted: true };
    }

    const doc: ChildcareInviteTokenDoc = {
      tokenId,
      householdId,
      invitedByUid: uid,
      intendedContact: contact,
      proposedScopes,
      nonceHash: sha256Hex(nonce),
      status: "pending",
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS_DEFAULT).toISOString(),
      usedByUid: null,
      usedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await ref.set(doc);

    await logAudit({
      eventType: "household_invite_created",
      userId: uid,
      data: {
        householdId,
        tokenId,
        contactChannel: contact.channel,
        proposedChildCount: proposedScopes.length,
      },
    }).catch(() => {});

    // The raw token is returned ONCE; delivery to the invited adult's verified
    // contact is the caller's (U4/U11) responsibility. It is never stored.
    return {
      success: true,
      tokenId,
      inviteToken: encodeInviteToken(tokenId, nonce),
      expiresAt: doc.expiresAt,
      alreadyExisted: false,
    };
  } catch (err) {
    mapAuthorityError(err);
  }
});

// ── acceptHouseholdInvite ────────────────────────────────────────────────────

export const acceptHouseholdInvite = childcareOnCall("acceptHouseholdInvite", async (data, context) => {
  const uid = requireAuth(context); // R17: the invited adult's OWN authentication
  await requireChildcareFlags("write");
  await enforceRateLimit("acceptHouseholdInvite", uid, CHILDCARE_MUTATION_RATE);

  const decoded = decodeInviteToken(data?.inviteToken);
  const consentVersion = String(data?.consentVersion ?? "").trim();
  if (!decoded || !consentVersion || consentVersion.length > 64) {
    // Malformed token/consent — same error as every other invalid-invite shape.
    throw invalidInvite();
  }

  const db = admin.firestore();
  const now = new Date();
  const ts = now.toISOString();

  try {
    const result = await db.runTransaction(async (tx) => {
      const tokenRef = db.collection(CHILDCARE_INVITE_TOKENS_COLLECTION).doc(decoded.tokenId);
      const tokenSnap = await tx.get(tokenRef);
      if (!tokenSnap.exists) throw invalidInvite();
      const token = (tokenSnap.data() ?? {}) as ChildcareInviteTokenDoc;

      // Replay (already used/revoked), expiry, nonce mismatch, and wrong
      // contact ALL produce the identical error — nothing is enumerable.
      if (token.status !== "pending") throw invalidInvite();
      if (Date.parse(token.expiresAt) <= now.getTime()) throw invalidInvite();
      if (token.nonceHash !== sha256Hex(decoded.nonce)) throw invalidInvite();
      if (!callerMatchesIntendedContact(context, token.intendedContact)) throw invalidInvite();

      const membershipRef = db
        .collection(HOUSEHOLD_MEMBERSHIPS_COLLECTION)
        .doc(membershipDocId(token.householdId, uid));
      const membershipSnap = await tx.get(membershipRef);
      const existingMembership = membershipSnap.exists
        ? ((membershipSnap.data() ?? {}) as HouseholdMembershipDoc)
        : null;

      // ALL transaction reads happen before any write (Firestore contract):
      // pre-read every authority ref the proposals may create.
      const proposals = Array.isArray(token.proposedScopes) ? token.proposedScopes : [];
      const authorityRefs = proposals.map((p) =>
        db.collection("guardian_authorities").doc(`${p.childId}__${uid}`),
      );
      const authoritySnaps = await Promise.all(authorityRefs.map((r) => tx.get(r)));

      // Single-use consumption + membership + (consented) authorities — one tx.
      tx.set(tokenRef, {
        ...token,
        status: "accepted",
        usedByUid: uid,
        usedAt: ts,
        updatedAt: ts,
      });

      const membership: HouseholdMembershipDoc = {
        membershipId: membershipDocId(token.householdId, uid),
        householdId: token.householdId,
        adultUid: uid,
        role: existingMembership?.role === "primary" ? "primary" : "adult",
        status: "active",
        source: "invite",
        invitedByUid: token.invitedByUid,
        consentVersion, // R23: the invited adult's own consent receipt version
        joinedAt: existingMembership?.joinedAt ?? ts,
        createdAt: existingMembership?.createdAt ?? ts,
        updatedAt: ts,
      };
      tx.set(membershipRef, membership);

      // Proposed scopes become explicit authority records ONLY here — with the
      // invited adult authenticated and consenting (F2). Membership alone would
      // have granted nothing (AE4).
      const grantedChildIds: string[] = [];
      for (let i = 0; i < proposals.length; i++) {
        const proposal = proposals[i];
        const authorityId = `${proposal.childId}__${uid}`;
        const authorityRef = authorityRefs[i];
        if (authoritySnaps[i].exists) continue; // never silently widen an existing record
        tx.set(authorityRef, {
          authorityId,
          householdId: token.householdId,
          childId: proposal.childId,
          adultUid: uid,
          careVertical: "child",
          scopes: proposal.scopes,
          state: "active",
          source: "invite_acceptance",
          grantedByUid: token.invitedByUid,
          effectiveAt: ts,
          expiresAt: null,
          accessVersion: 1,
          lastOperationKey: `invite:${token.tokenId}`,
          policyVersion: null,
          disputeHold: null,
          createdAt: ts,
          updatedAt: ts,
        });
        grantedChildIds.push(proposal.childId);
      }

      return { householdId: token.householdId, grantedChildIds };
    });

    for (const grantedChildId of result.grantedChildIds) {
      await refreshViewerProjection(grantedChildId);
    }

    await logAudit({
      eventType: "household_invite_accepted",
      userId: uid,
      data: {
        householdId: result.householdId,
        tokenId: decoded.tokenId,
        grantedChildCount: result.grantedChildIds.length,
      },
    }).catch(() => {});

    return { success: true, householdId: result.householdId };
  } catch (err) {
    if (err instanceof functions.https.HttpsError) throw err;
    mapAuthorityError(err);
  }
});

// ── grantGuardianAuthority ───────────────────────────────────────────────────

export const grantGuardianAuthority = childcareOnCall("grantGuardianAuthority", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("grantGuardianAuthority", uid, CHILDCARE_MUTATION_RATE);
  requireRecentAuth(context); // high-risk (R18)

  const householdId = String(data?.householdId ?? "").trim();
  const childId = String(data?.childId ?? "").trim();
  const targetAdultUid = String(data?.targetAdultUid ?? "").trim();
  const scopes = normalizeScopes(data?.scopes);
  const idempotencyKey = String(data?.idempotencyKey ?? "").trim() || null;
  const expiresAt = typeof data?.expiresAt === "string" ? data.expiresAt : null;
  if (!householdId || !childId || !targetAdultUid || !scopes || childId.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }

  try {
    const authority = await grantAuthorityTx({
      granterUid: uid,
      householdId,
      childId,
      targetAdultUid,
      scopes,
      expiresAt,
      idempotencyKey,
    });
    await refreshViewerProjection(childId);
    return {
      success: true,
      authorityId: authority.authorityId,
      scopes: authority.scopes,
      accessVersion: authority.accessVersion,
    };
  } catch (err) {
    mapAuthorityError(err);
  }
});

// ── updateAuthorityScopes ────────────────────────────────────────────────────

export const updateAuthorityScopes = childcareOnCall("updateAuthorityScopes", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("updateAuthorityScopes", uid, CHILDCARE_MUTATION_RATE);
  requireRecentAuth(context); // high-risk (R18)

  const householdId = String(data?.householdId ?? "").trim();
  const childId = String(data?.childId ?? "").trim();
  const targetAdultUid = String(data?.targetAdultUid ?? "").trim();
  const newScopes = normalizeScopes(data?.newScopes);
  const idempotencyKey = String(data?.idempotencyKey ?? "").trim() || null;
  const expectedAccessVersion =
    data?.expectedAccessVersion === undefined || data?.expectedAccessVersion === null
      ? null
      : Number(data.expectedAccessVersion);
  if (!householdId || !childId || !targetAdultUid || !newScopes) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }

  try {
    const result = await updateScopesTx({
      actorUid: uid,
      householdId,
      childId,
      targetAdultUid,
      newScopes,
      reason: typeof data?.reason === "string" ? data.reason : null,
      idempotencyKey,
      expectedAccessVersion,
    });
    await verifySynchronousAuthorityDenial(
      householdId,
      childId,
      targetAdultUid,
      result.authority,
    );
    await refreshViewerProjection(childId);
    return {
      success: true,
      authorityId: result.authority.authorityId,
      state: result.authority.state,
      disputeHold: result.disputeHold,
      accessVersion: result.authority.accessVersion,
    };
  } catch (err) {
    mapAuthorityError(err);
  }
});

// ── revokeGuardianAuthority ──────────────────────────────────────────────────

export const revokeGuardianAuthority = childcareOnCall("revokeGuardianAuthority", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("revokeGuardianAuthority", uid, CHILDCARE_MUTATION_RATE);
  requireRecentAuth(context); // high-risk (R18)

  const householdId = String(data?.householdId ?? "").trim();
  const childId = String(data?.childId ?? "").trim();
  const targetAdultUid = String(data?.targetAdultUid ?? "").trim();
  const idempotencyKey = String(data?.idempotencyKey ?? "").trim() || null;
  const expectedAccessVersion =
    data?.expectedAccessVersion === undefined || data?.expectedAccessVersion === null
      ? null
      : Number(data.expectedAccessVersion);
  if (!householdId || !childId || !targetAdultUid) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }

  try {
    const result = await revokeAuthorityTx({
      actorUid: uid,
      householdId,
      childId,
      targetAdultUid,
      reason: typeof data?.reason === "string" ? data.reason : null,
      idempotencyKey,
      expectedAccessVersion,
    });
    await verifySynchronousAuthorityDenial(
      householdId,
      childId,
      targetAdultUid,
      result.authority,
    );
    await refreshViewerProjection(childId);
    return {
      success: true,
      authorityId: result.authority.authorityId,
      state: result.authority.state,
      disputeHold: result.disputeHold,
      accessVersion: result.authority.accessVersion,
    };
  } catch (err) {
    mapAuthorityError(err);
  }
});

// ── getMyHouseholdState ──────────────────────────────────────────────────────

export const getMyHouseholdState = childcareOnCall("getMyHouseholdState", async (_data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("read");
  await enforceRateLimit("getMyHouseholdState", uid, CHILDCARE_READ_RATE);

  try {
    const db = admin.firestore();
    const [memberships, authorities] = await Promise.all([
      listMembershipsForAdult(uid, db),
      listAuthoritiesForAdult(uid, db),
    ]);

    const households: Array<Record<string, unknown>> = [];
    for (const m of memberships) {
      const household = await getHousehold(m.householdId, db);
      if (!household) continue;
      households.push({
        householdId: household.householdId,
        status: household.status,
        isPrimary: household.primaryAdultUid === uid,
        membershipStatus: m.status,
        membershipRole: m.role,
        derivedSummary: household.derivedSummary ?? null,
      });
    }

    return {
      success: true,
      households,
      // Own authority records only — scopes/state/version, never other adults'.
      authorities: authorities.map((a) => ({
        authorityId: a.authorityId,
        householdId: a.householdId,
        childId: a.childId,
        scopes: a.scopes,
        state: a.state,
        expiresAt: a.expiresAt ?? null,
        accessVersion: a.accessVersion,
      })),
    };
  } catch (err) {
    mapAuthorityError(err);
  }
});
