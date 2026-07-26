// ── Childcare Stripe Identity gate (plan 2026-07-22-002, U4 / R17, R22) ──────
//
// Adult identity evidence for childcare enrollment. Follows the existing
// Stripe Identity integration in functions/src/stripe.ts (same session type,
// same webhook events) with the U4 hardening:
//
//   • ONE verification session per objective, idempotent: repeat calls reuse
//     the stored session; only a CANCELED session (terminal, unreusable per
//     Stripe semantics) is replaced, with the replaced ID retained on the
//     mirror doc for audit.
//   • Callback state (R22): a one-time nonce doc binding the AUTHENTICATED
//     adult + objective + expected Stripe session + expiry + one-time
//     consumption. URL params never grant authority or select a child — the
//     consume callable re-verifies everything server-side and reads the LIVE
//     Stripe status, never a URL-claimed one.
//   • NO child PII in Stripe metadata (R57): exactly two opaque fields —
//     firebaseUID (the adult) and childcareObjectiveId. Never a phone (the
//     phone-metadata branch of the senior webhook sends onboarding SMS),
//     never a child name/DOB/household detail.
//   • Identity is evidence, not authority (R17): a verified session marks the
//     objective's identity STEP done; guardian authority, consent, and
//     recipient permission remain separate gates.
//
// Callables stack the U2/U3 middleware order: App Check → Auth → Firestore-
// resident flags → rate limit → input bounds → object-level authorization →
// enumeration-safe errors.

import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { randomUUID } from "crypto";
import type Stripe from "stripe";
import { checkRateLimit, type RateLimitConfig } from "../rateLimit";
import { getChildcareFlags } from "../config/featureFlags";
import { appLink } from "../config/appUrl";
import { logAudit } from "../observability/auditLog";
import { childcareOnCall } from "./appCheckPolicy";
import { CHILDCARE_PROFILE_PATH } from "./signupIngress";
import { OBJECTIVES_COLLECTION, TERMINAL_STATUSES, type AgentObjective, type ObjectiveStatus } from "../agents/objectiveLedger";

export const CHILDCARE_IDENTITY_SESSIONS_COLLECTION = "childcare_identity_sessions";
export const CHILDCARE_IDENTITY_CALLBACKS_COLLECTION = "childcare_identity_callbacks";

/** Callback-state lifetime (R22 expiry). */
export const CALLBACK_STATE_TTL_MS = 30 * 60 * 1000;

export type ChildcareIdentityStatus =
  | "created"
  | "processing"
  | "requires_input"
  | "verified"
  | "canceled";

export interface ChildcareIdentitySessionDoc {
  objectiveId: string;
  adultUid: string;
  stripeSessionId: string;
  status: ChildcareIdentityStatus;
  createdAt: string;
  updatedAt: string;
  /** Canceled sessions replaced by a new one are retained here (audit). */
  supersededSessionIds?: string[];
}

export interface ChildcareIdentityCallbackDoc {
  nonce: string;
  adultUid: string;
  objectiveId: string;
  stripeSessionId: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

type Db = admin.firestore.Firestore;

/** The minimal Stripe surface this module uses (injectable for tests). */
export interface StripeIdentityLike {
  identity: {
    verificationSessions: {
      create(params: Record<string, unknown>): Promise<Stripe.Identity.VerificationSession>;
      retrieve(id: string): Promise<Stripe.Identity.VerificationSession>;
    };
  };
}

async function defaultStripe(): Promise<StripeIdentityLike> {
  const { getStripeClient } = await import("../stripe");
  return getStripeClient() as unknown as StripeIdentityLike;
}

// ── Typed errors (mapped to enumeration-safe HttpsErrors at the boundary) ───

export type ChildcareIdentityErrorCode =
  | "invalid_input"
  | "not_authorized"     // missing objective / wrong user / wrong vertical — indistinguishable
  | "objective_terminal"
  | "callback_expired"
  | "callback_replayed"
  | "provider_error";

export class ChildcareIdentityError extends Error {
  constructor(public readonly code: ChildcareIdentityErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ChildcareIdentityError";
  }
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

async function loadAuthorizedObjective(
  db: Db,
  uid: string,
  objectiveId: string,
): Promise<AgentObjective> {
  const snap = await db.collection(OBJECTIVES_COLLECTION).doc(objectiveId).get();
  // Missing, foreign, and wrong-vertical are deliberately the same error.
  if (!snap.exists) throw new ChildcareIdentityError("not_authorized");
  const objective = snap.data() as AgentObjective;
  if (objective.userId !== uid) throw new ChildcareIdentityError("not_authorized");
  if (objective.careVertical !== "child") throw new ChildcareIdentityError("not_authorized");
  if (TERMINAL_STATUSES.has(objective.status as ObjectiveStatus)) {
    throw new ChildcareIdentityError("objective_terminal");
  }
  return objective;
}

/** Mark an objective step done (server-only ledger write; version bump). */
async function markObjectiveStepDone(
  db: Db,
  objectiveId: string,
  stepId: string,
  now?: Date,
): Promise<void> {
  const ref = db.collection(OBJECTIVES_COLLECTION).doc(objectiveId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const objective = snap.data() as AgentObjective;
    const steps = Array.isArray(objective.steps) ? objective.steps : [];
    const idx = steps.findIndex((s) => s.id === stepId);
    if (idx === -1 || steps[idx].status === "done") return;
    const nextSteps = steps.map((s, i) => (i === idx ? { ...s, status: "done" as const } : s));
    tx.update(ref, {
      steps: nextSteps,
      version: (objective.version ?? 0) + 1,
      updatedAt: nowIso(now),
    });
  });
}

function mapStripeStatus(raw: string): ChildcareIdentityStatus {
  if (raw === "verified" || raw === "processing" || raw === "requires_input" || raw === "canceled") return raw;
  return "created";
}

// ── ensureChildcareIdentitySession (core, injectable) ───────────────────────

export interface EnsureIdentitySessionParams {
  uid: string;
  objectiveId: string;
  db?: Db;
  stripe?: StripeIdentityLike;
  now?: Date;
}

export interface EnsureIdentitySessionResult {
  stripeSessionId: string;
  status: ChildcareIdentityStatus;
  /** Hosted verification URL (null once the session no longer serves one). */
  url: string | null;
  /** True when an existing session was reused instead of created. */
  reused: boolean;
  /** One-time callback state nonce bound to this adult+objective+session. */
  callbackState: string;
}

export async function ensureChildcareIdentitySession(
  params: EnsureIdentitySessionParams,
): Promise<EnsureIdentitySessionResult> {
  const db = params.db ?? admin.firestore();
  const stripe = params.stripe ?? (await defaultStripe());
  const now = params.now ?? new Date();
  const { uid, objectiveId } = params;

  await loadAuthorizedObjective(db, uid, objectiveId);

  const mirrorRef = db.collection(CHILDCARE_IDENTITY_SESSIONS_COLLECTION).doc(objectiveId);
  const mirrorSnap = await mirrorRef.get();
  const existing = mirrorSnap.exists ? (mirrorSnap.data() as ChildcareIdentitySessionDoc) : null;

  let stripeSessionId = "";
  let status: ChildcareIdentityStatus = "created";
  let url: string | null = null;
  let reused = false;
  let superseded: string[] = existing?.supersededSessionIds ?? [];

  if (existing && existing.adultUid !== uid) {
    // Objective ownership already verified; a mirror bound to another adult
    // means data drift — fail closed rather than leak the session.
    throw new ChildcareIdentityError("not_authorized");
  }

  if (existing) {
    // Reuse path: read the LIVE status from Stripe (never trust the mirror).
    let live: Stripe.Identity.VerificationSession;
    try {
      live = await stripe.identity.verificationSessions.retrieve(existing.stripeSessionId);
    } catch {
      throw new ChildcareIdentityError("provider_error");
    }
    const liveStatus = mapStripeStatus(String(live.status));
    if (liveStatus !== "canceled") {
      stripeSessionId = existing.stripeSessionId;
      status = liveStatus;
      url = (live.url as string | null) ?? null;
      reused = true;
    } else {
      // Terminal canceled — the ONLY state that mints a replacement.
      superseded = [...superseded, existing.stripeSessionId];
    }
  }

  // Callback state nonce is minted for BOTH paths — every link handed out is
  // one-time and expiring (R22), even when the Stripe session is reused.
  const nonce = randomUUID().replace(/-/g, "");

  if (!reused) {
    let created: Stripe.Identity.VerificationSession;
    try {
      created = await stripe.identity.verificationSessions.create({
        type: "id_number",
        // R57: exactly these two opaque fields. NEVER phone (the senior
        // webhook's phone branch sends SMS), NEVER child PII.
        metadata: { firebaseUID: uid, childcareObjectiveId: objectiveId },
        // R22: the return URL carries NO state and grants nothing — the
        // one-time callback nonce is returned to the authenticated client
        // (callable response) and presented back via the consume callable,
        // which re-verifies user+objective+session+expiry server-side.
        return_url: appLink(`${CHILDCARE_PROFILE_PATH}?identity=return`),
      });
    } catch {
      throw new ChildcareIdentityError("provider_error");
    }
    stripeSessionId = created.id;
    status = mapStripeStatus(String(created.status ?? "created"));
    url = (created.url as string | null) ?? null;
  }

  const mirror: ChildcareIdentitySessionDoc = {
    objectiveId,
    adultUid: uid,
    stripeSessionId,
    status,
    createdAt: existing?.createdAt ?? nowIso(now),
    updatedAt: nowIso(now),
    ...(superseded.length > 0 ? { supersededSessionIds: superseded } : {}),
  };
  await mirrorRef.set(mirror);

  const callback: ChildcareIdentityCallbackDoc = {
    nonce,
    adultUid: uid,
    objectiveId,
    stripeSessionId,
    createdAt: nowIso(now),
    expiresAt: new Date(now.getTime() + CALLBACK_STATE_TTL_MS).toISOString(),
    consumedAt: null,
  };
  await db.collection(CHILDCARE_IDENTITY_CALLBACKS_COLLECTION).doc(nonce).set(callback);

  await logAudit({
    eventType: reused ? "childcare_identity_session_reused" : "childcare_identity_session_created",
    userId: uid,
    data: { objectiveId, status }, // IDs/status only — no nonce, no URL (R57)
  }).catch(() => {});

  return { stripeSessionId, status, url, reused, callbackState: nonce };
}

// ── consumeChildcareIdentityCallbackState (core, injectable) ────────────────

export interface ConsumeCallbackParams {
  uid: string;
  state: string;
  db?: Db;
  stripe?: StripeIdentityLike;
  now?: Date;
}

export interface ConsumeCallbackResult {
  objectiveId: string;
  status: ChildcareIdentityStatus;
}

export async function consumeChildcareIdentityCallbackState(
  params: ConsumeCallbackParams,
): Promise<ConsumeCallbackResult> {
  const db = params.db ?? admin.firestore();
  const stripe = params.stripe ?? (await defaultStripe());
  const now = params.now ?? new Date();
  const state = String(params.state ?? "").trim();
  if (!state || state.length > 128 || !/^[A-Za-z0-9_-]+$/.test(state)) {
    throw new ChildcareIdentityError("invalid_input");
  }

  const ref = db.collection(CHILDCARE_IDENTITY_CALLBACKS_COLLECTION).doc(state);

  // One-time consumption is decided INSIDE the transaction (a concurrent
  // replay loses deterministically).
  const callback = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    // Missing and wrong-user are the SAME error (enumeration safety): a
    // stranger probing nonces learns nothing.
    if (!snap.exists) throw new ChildcareIdentityError("not_authorized");
    const doc = snap.data() as ChildcareIdentityCallbackDoc;
    if (doc.adultUid !== params.uid) throw new ChildcareIdentityError("not_authorized");
    // Only AFTER the user matched do expiry/replay get distinct codes.
    if (doc.consumedAt) throw new ChildcareIdentityError("callback_replayed");
    if (Date.parse(doc.expiresAt) <= now.getTime()) throw new ChildcareIdentityError("callback_expired");
    tx.update(ref, { consumedAt: nowIso(now) });
    return doc;
  });

  // Authoritative status comes from Stripe LIVE — never from URL params.
  let live: Stripe.Identity.VerificationSession;
  try {
    live = await stripe.identity.verificationSessions.retrieve(callback.stripeSessionId);
  } catch {
    throw new ChildcareIdentityError("provider_error");
  }
  const status = mapStripeStatus(String(live.status));

  await db.collection(CHILDCARE_IDENTITY_SESSIONS_COLLECTION).doc(callback.objectiveId)
    .set({ status, updatedAt: nowIso(now) }, { merge: true });

  if (status === "verified") {
    await markObjectiveStepDone(db, callback.objectiveId, "identity", now);
  }

  await logAudit({
    eventType: "childcare_identity_callback_consumed",
    userId: params.uid,
    data: { objectiveId: callback.objectiveId, status },
  }).catch(() => {});

  return { objectiveId: callback.objectiveId, status };
}

// ── Webhook mirror hook (called from functions/src/stripe.ts, additive) ─────

/**
 * Mirror a Stripe Identity webhook event for a childcare session. The webhook
 * remains the authoritative status writer; stale/foreign session IDs are
 * ignored (out-of-order webhook safety — the mirror only accepts events for
 * its CURRENT stripeSessionId).
 */
export async function mirrorChildcareIdentityEvent(
  stripeSessionId: string,
  objectiveId: string,
  status: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<void> {
  const db = opts.db ?? admin.firestore();
  const mapped = mapStripeStatus(status);
  const ref = db.collection(CHILDCARE_IDENTITY_SESSIONS_COLLECTION).doc(objectiveId);
  const snap = await ref.get();
  if (!snap.exists) return; // unknown objective — nothing to mirror
  const doc = snap.data() as ChildcareIdentitySessionDoc;
  if (doc.stripeSessionId !== stripeSessionId) return; // superseded/foreign session
  await ref.set({ status: mapped, updatedAt: nowIso(opts.now) }, { merge: true });
  if (mapped === "verified") {
    await markObjectiveStepDone(db, objectiveId, "identity", opts.now);
  }
  await logAudit({
    eventType: "childcare_identity_status_mirrored",
    userId: doc.adultUid,
    data: { objectiveId, status: mapped },
  }).catch(() => {});
}

// ── Callables (U2/U3 middleware stack) ──────────────────────────────────────

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

function requireAuth(context: functions.https.CallableContext): string {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  return context.auth.uid;
}

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

async function enforceRateLimit(op: string, uid: string, config: RateLimitConfig): Promise<void> {
  const result = await checkRateLimit(`${op}:${uid}`, config);
  if (!result.allowed) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Too many requests. Please wait a moment and try again.",
    );
  }
}

function mapIdentityError(err: unknown): never {
  if (err instanceof functions.https.HttpsError) throw err;
  if (err instanceof ChildcareIdentityError) {
    if (err.code === "invalid_input") {
      throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
    }
    if (err.code === "callback_expired") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This link has expired. Request a fresh one and try again.",
        { code: "callback_expired" },
      );
    }
    if (err.code === "callback_replayed") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This link was already used. Request a fresh one if you still need it.",
        { code: "callback_replayed" },
      );
    }
    if (err.code === "objective_terminal") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This setup is no longer active.",
        { code: "objective_terminal" },
      );
    }
    if (err.code === "provider_error") {
      throw new functions.https.HttpsError("unavailable", "Verification is temporarily unavailable. Please try again.");
    }
    // not_authorized — enumeration-safe generic denial.
    throw new functions.https.HttpsError(
      "permission-denied",
      "You do not have permission to perform this action.",
    );
  }
  console.error("[childcareIdentity] unexpected error:", err instanceof Error ? err.name : "Error");
  throw new functions.https.HttpsError("internal", "Something went wrong. Please try again.");
}

export const createChildcareIdentitySession = childcareOnCall("createChildcareIdentitySession", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("write");
  await enforceRateLimit("createChildcareIdentitySession", uid, CHILDCARE_MUTATION_RATE);

  let objectiveId = String(data?.objectiveId ?? "").trim();
  if (objectiveId.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid request.");
  }

  try {
    if (!objectiveId) {
      // Web-first enrollment: no objectiveId means "my own family enrollment
      // objective" — ensured server-side (deterministic per-adult ID, AE15).
      // A caller can NEVER select someone else's objective this way, and an
      // explicit objectiveId is still ownership-checked inside ensure.
      const { ensureFamilyChildcareObjective } = await import("./signupIngress");
      const ensured = await ensureFamilyChildcareObjective(uid, { channel: "web" });
      objectiveId = ensured.objective.objectiveId;
    }
    const result = await ensureChildcareIdentitySession({ uid, objectiveId });
    // The Stripe session id stays server-side; the browser gets the hosted
    // URL + status + the one-time callback state it must hold onto (session
    // storage) and present to v1-consumeChildcareIdentityCallback on return.
    return {
      success: true,
      status: result.status,
      url: result.url,
      reused: result.reused,
      callbackState: result.callbackState,
    };
  } catch (err) {
    mapIdentityError(err);
  }
});

export const consumeChildcareIdentityCallback = childcareOnCall("consumeChildcareIdentityCallback", async (data, context) => {
  const uid = requireAuth(context);
  await requireChildcareFlags("read");
  await enforceRateLimit("consumeChildcareIdentityCallback", uid, CHILDCARE_READ_RATE);

  try {
    const result = await consumeChildcareIdentityCallbackState({ uid, state: data?.state });
    return { success: true, objectiveId: result.objectiveId, status: result.status };
  } catch (err) {
    mapIdentityError(err);
  }
});
