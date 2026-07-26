// Childcare U4 (plan 2026-07-22-002): Stripe Identity gate.
//
// Pins: ONE verification session per objective with idempotent reuse (only a
// CANCELED session is replaced); processing/requires_input/canceled/verified
// status handling; callback state binding (wrong user / replay / expiry /
// one-time consumption — R22); NO child PII in Stripe metadata (exact field
// set); URL params grant nothing (the return_url carries no state); webhook
// mirror ignores stale/foreign session ids; a verified outcome marks the
// objective's identity STEP done (evidence, not authority — R17).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./observability/auditLog", () => ({
  logAudit: vi.fn(async () => {}),
}));

// rateLimit.ts calls admin.firestore() at module load — stub it (the callable
// wrappers are not under test here; the core functions take injected deps).
vi.mock("./rateLimit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

import { makeFakeDb, type FakeDb } from "./childcare/__tests__/fakeFirestore";
import { OBJECTIVES_COLLECTION } from "./agents/objectiveLedger";
import {
  CALLBACK_STATE_TTL_MS,
  CHILDCARE_IDENTITY_CALLBACKS_COLLECTION,
  CHILDCARE_IDENTITY_SESSIONS_COLLECTION,
  ChildcareIdentityError,
  consumeChildcareIdentityCallbackState,
  ensureChildcareIdentitySession,
  mirrorChildcareIdentityEvent,
  type StripeIdentityLike,
} from "./childcare/identityCallables";
import { CHILDCARE_PROFILE_PATH } from "./childcare/signupIngress";

const NOW = new Date("2026-07-22T12:00:00.000Z");
const UID = "adult-1";
const OBJECTIVE_ID = "childcare-family-signup_adult-1";

function objectiveDoc(overrides: Record<string, unknown> = {}) {
  return {
    objectiveId: OBJECTIVE_ID,
    userId: UID,
    role: "client",
    channel: "web",
    intent: "childcare.family_enrollment",
    careVertical: "child",
    status: "active",
    steps: [
      { id: "consent", label: "Record consent receipts", status: "pending" },
      { id: "identity", label: "Verify your identity", status: "pending" },
      { id: "child_profile", label: "Complete the secure child profile", status: "pending" },
    ],
    missingInputs: [],
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

interface FakeStripe extends StripeIdentityLike {
  created: Array<Record<string, unknown>>;
  sessions: Map<string, { id: string; status: string; url: string | null }>;
}

function makeFakeStripe(): FakeStripe {
  const sessions = new Map<string, { id: string; status: string; url: string | null }>();
  const created: Array<Record<string, unknown>> = [];
  let counter = 0;
  return {
    created,
    sessions,
    identity: {
      verificationSessions: {
        create: async (params: Record<string, unknown>) => {
          created.push(params);
          const id = `vs_${++counter}`;
          const session = { id, status: "requires_input", url: `https://verify.stripe.test/${id}` };
          sessions.set(id, session);
          return session as never;
        },
        retrieve: async (id: string) => {
          const session = sessions.get(id);
          if (!session) throw new Error("no such session");
          return session as never;
        },
      },
    },
  };
}

function armedDb(overrides: Record<string, unknown> = {}): FakeDb {
  return makeFakeDb({ [`${OBJECTIVES_COLLECTION}/${OBJECTIVE_ID}`]: objectiveDoc(overrides) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureChildcareIdentitySession — creation", () => {
  it("creates ONE session with EXACTLY {firebaseUID, childcareObjectiveId} metadata (no child PII, no phone)", async () => {
    const fake = armedDb();
    const stripe = makeFakeStripe();
    const result = await ensureChildcareIdentitySession({ uid: UID, objectiveId: OBJECTIVE_ID, db: fake.db, stripe, now: NOW });
    expect(result.reused).toBe(false);
    expect(stripe.created).toHaveLength(1);
    const metadata = stripe.created[0].metadata as Record<string, string>;
    expect(Object.keys(metadata).sort()).toEqual(["childcareObjectiveId", "firebaseUID"]);
    expect(metadata.firebaseUID).toBe(UID);
    expect(metadata.childcareObjectiveId).toBe(OBJECTIVE_ID);
    expect("phone" in metadata).toBe(false);
  });

  it("the return_url carries NO state/nonce/child data — URL params grant nothing (R22)", async () => {
    const fake = armedDb();
    const stripe = makeFakeStripe();
    const result = await ensureChildcareIdentitySession({ uid: UID, objectiveId: OBJECTIVE_ID, db: fake.db, stripe, now: NOW });
    const returnUrl = String(stripe.created[0].return_url);
    expect(returnUrl).toContain(CHILDCARE_PROFILE_PATH);
    expect(returnUrl).not.toContain(result.callbackState);
    expect(returnUrl).not.toMatch(/state=/);
  });

  it("writes the mirror doc and a one-time callback state bound to adult+objective+session+expiry", async () => {
    const fake = armedDb();
    const stripe = makeFakeStripe();
    const result = await ensureChildcareIdentitySession({ uid: UID, objectiveId: OBJECTIVE_ID, db: fake.db, stripe, now: NOW });
    expect(fake.get(`${CHILDCARE_IDENTITY_SESSIONS_COLLECTION}/${OBJECTIVE_ID}`)).toMatchObject({
      adultUid: UID,
      stripeSessionId: result.stripeSessionId,
      status: "requires_input",
    });
    const callback = fake.get(`${CHILDCARE_IDENTITY_CALLBACKS_COLLECTION}/${result.callbackState}`);
    expect(callback).toMatchObject({
      adultUid: UID,
      objectiveId: OBJECTIVE_ID,
      stripeSessionId: result.stripeSessionId,
      consumedAt: null,
    });
    expect(Date.parse(String(callback?.expiresAt))).toBe(NOW.getTime() + CALLBACK_STATE_TTL_MS);
  });

  it("denies a wrong user, a senior-vertical objective, and a missing objective identically", async () => {
    const stripe = makeFakeStripe();
    await expect(
      ensureChildcareIdentitySession({ uid: "someone-else", objectiveId: OBJECTIVE_ID, db: armedDb().db, stripe }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    await expect(
      ensureChildcareIdentitySession({ uid: UID, objectiveId: OBJECTIVE_ID, db: armedDb({ careVertical: undefined }).db, stripe }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    await expect(
      ensureChildcareIdentitySession({ uid: UID, objectiveId: "does-not-exist", db: makeFakeDb().db, stripe }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    expect(stripe.created).toHaveLength(0);
  });

  it("rejects a terminal objective (no session for finished/cancelled work)", async () => {
    const stripe = makeFakeStripe();
    await expect(
      ensureChildcareIdentitySession({ uid: UID, objectiveId: OBJECTIVE_ID, db: armedDb({ status: "cancelled" }).db, stripe }),
    ).rejects.toMatchObject({ code: "objective_terminal" });
  });
});

describe("ensureChildcareIdentitySession — reuse (one session per objective)", () => {
  it("a second call REUSES the session (same id, fresh one-time state, live status)", async () => {
    const fake = armedDb();
    const stripe = makeFakeStripe();
    const first = await ensureChildcareIdentitySession({ uid: UID, objectiveId: OBJECTIVE_ID, db: fake.db, stripe, now: NOW });
    stripe.sessions.get(first.stripeSessionId)!.status = "processing";
    const second = await ensureChildcareIdentitySession({ uid: UID, objectiveId: OBJECTIVE_ID, db: fake.db, stripe, now: NOW });
    expect(second.reused).toBe(true);
    expect(second.stripeSessionId).toBe(first.stripeSessionId);
    expect(second.status).toBe("processing");
    expect(second.callbackState).not.toBe(first.callbackState); // every link is one-time
    expect(stripe.created).toHaveLength(1); // NO second Stripe session
  });

  it("verified sessions are reused too — never re-verify a verified adult", async () => {
    const fake = armedDb();
    const stripe = makeFakeStripe();
    const first = await ensureChildcareIdentitySession({ uid: UID, objectiveId: OBJECTIVE_ID, db: fake.db, stripe, now: NOW });
    stripe.sessions.get(first.stripeSessionId)!.status = "verified";
    const second = await ensureChildcareIdentitySession({ uid: UID, objectiveId: OBJECTIVE_ID, db: fake.db, stripe, now: NOW });
    expect(second.reused).toBe(true);
    expect(second.status).toBe("verified");
  });

  it("only a CANCELED session is replaced, retaining the superseded id", async () => {
    const fake = armedDb();
    const stripe = makeFakeStripe();
    const first = await ensureChildcareIdentitySession({ uid: UID, objectiveId: OBJECTIVE_ID, db: fake.db, stripe, now: NOW });
    stripe.sessions.get(first.stripeSessionId)!.status = "canceled";
    const second = await ensureChildcareIdentitySession({ uid: UID, objectiveId: OBJECTIVE_ID, db: fake.db, stripe, now: NOW });
    expect(second.reused).toBe(false);
    expect(second.stripeSessionId).not.toBe(first.stripeSessionId);
    expect(stripe.created).toHaveLength(2);
    expect(fake.get(`${CHILDCARE_IDENTITY_SESSIONS_COLLECTION}/${OBJECTIVE_ID}`)?.supersededSessionIds)
      .toEqual([first.stripeSessionId]);
  });

  it("a mirror bound to a DIFFERENT adult fails closed (data drift)", async () => {
    const fake = armedDb();
    fake.seed(`${CHILDCARE_IDENTITY_SESSIONS_COLLECTION}/${OBJECTIVE_ID}`, {
      objectiveId: OBJECTIVE_ID, adultUid: "someone-else", stripeSessionId: "vs_x", status: "processing",
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    await expect(
      ensureChildcareIdentitySession({ uid: UID, objectiveId: OBJECTIVE_ID, db: fake.db, stripe: makeFakeStripe() }),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });
});

describe("consumeChildcareIdentityCallbackState — R22 one-time consumption", () => {
  async function armed(): Promise<{ fake: FakeDb; stripe: FakeStripe; state: string; sessionId: string }> {
    const fake = armedDb();
    const stripe = makeFakeStripe();
    const result = await ensureChildcareIdentitySession({ uid: UID, objectiveId: OBJECTIVE_ID, db: fake.db, stripe, now: NOW });
    return { fake, stripe, state: result.callbackState, sessionId: result.stripeSessionId };
  }

  it("verified: consumes once, mirrors status, marks the objective identity step done", async () => {
    const { fake, stripe, state, sessionId } = await armed();
    stripe.sessions.get(sessionId)!.status = "verified";
    const result = await consumeChildcareIdentityCallbackState({ uid: UID, state, db: fake.db, stripe, now: NOW });
    expect(result).toEqual({ objectiveId: OBJECTIVE_ID, status: "verified" });
    expect(fake.get(`${CHILDCARE_IDENTITY_CALLBACKS_COLLECTION}/${state}`)?.consumedAt).toBe(NOW.toISOString());
    const objective = fake.get(`${OBJECTIVES_COLLECTION}/${OBJECTIVE_ID}`)!;
    const identityStep = (objective.steps as Array<{ id: string; status: string }>).find((s) => s.id === "identity");
    expect(identityStep?.status).toBe("done");
    expect(objective.version).toBe(2);
  });

  it.each(["processing", "requires_input", "canceled"] as const)(
    "%s: status passes through and the identity step stays pending",
    async (status) => {
      const { fake, stripe, state, sessionId } = await armed();
      stripe.sessions.get(sessionId)!.status = status;
      const result = await consumeChildcareIdentityCallbackState({ uid: UID, state, db: fake.db, stripe, now: NOW });
      expect(result.status).toBe(status);
      const objective = fake.get(`${OBJECTIVES_COLLECTION}/${OBJECTIVE_ID}`)!;
      const identityStep = (objective.steps as Array<{ id: string; status: string }>).find((s) => s.id === "identity");
      expect(identityStep?.status).toBe("pending");
    },
  );

  it("wrong user gets the SAME generic denial as a missing state (enumeration safety)", async () => {
    const { fake, stripe, state } = await armed();
    await expect(
      consumeChildcareIdentityCallbackState({ uid: "attacker", state, db: fake.db, stripe, now: NOW }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    await expect(
      consumeChildcareIdentityCallbackState({ uid: UID, state: "nonexistent", db: fake.db, stripe, now: NOW }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    // Neither attempt consumed the state.
    expect(fake.get(`${CHILDCARE_IDENTITY_CALLBACKS_COLLECTION}/${state}`)?.consumedAt).toBeNull();
  });

  it("replay: the second consumption fails with callback_replayed", async () => {
    const { fake, stripe, state, sessionId } = await armed();
    stripe.sessions.get(sessionId)!.status = "verified";
    await consumeChildcareIdentityCallbackState({ uid: UID, state, db: fake.db, stripe, now: NOW });
    await expect(
      consumeChildcareIdentityCallbackState({ uid: UID, state, db: fake.db, stripe, now: NOW }),
    ).rejects.toMatchObject({ code: "callback_replayed" });
  });

  it("expiry: a state past its TTL fails with callback_expired and is not consumed", async () => {
    const { fake, stripe, state } = await armed();
    const late = new Date(NOW.getTime() + CALLBACK_STATE_TTL_MS + 1);
    await expect(
      consumeChildcareIdentityCallbackState({ uid: UID, state, db: fake.db, stripe, now: late }),
    ).rejects.toMatchObject({ code: "callback_expired" });
    expect(fake.get(`${CHILDCARE_IDENTITY_CALLBACKS_COLLECTION}/${state}`)?.consumedAt).toBeNull();
  });

  it("malformed state strings are rejected as invalid input", async () => {
    await expect(
      consumeChildcareIdentityCallbackState({ uid: UID, state: "../evil", db: makeFakeDb().db, stripe: makeFakeStripe() }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("mirrorChildcareIdentityEvent (webhook hook)", () => {
  it("mirrors the status for the CURRENT session and marks the step done on verified", async () => {
    const fake = armedDb();
    const stripe = makeFakeStripe();
    const created = await ensureChildcareIdentitySession({ uid: UID, objectiveId: OBJECTIVE_ID, db: fake.db, stripe, now: NOW });
    await mirrorChildcareIdentityEvent(created.stripeSessionId, OBJECTIVE_ID, "verified", { db: fake.db, now: NOW });
    expect(fake.get(`${CHILDCARE_IDENTITY_SESSIONS_COLLECTION}/${OBJECTIVE_ID}`)?.status).toBe("verified");
    const objective = fake.get(`${OBJECTIVES_COLLECTION}/${OBJECTIVE_ID}`)!;
    const identityStep = (objective.steps as Array<{ id: string; status: string }>).find((s) => s.id === "identity");
    expect(identityStep?.status).toBe("done");
  });

  it("ignores stale/foreign session ids (out-of-order webhook safety)", async () => {
    const fake = armedDb();
    const stripe = makeFakeStripe();
    await ensureChildcareIdentitySession({ uid: UID, objectiveId: OBJECTIVE_ID, db: fake.db, stripe, now: NOW });
    await mirrorChildcareIdentityEvent("vs_stale", OBJECTIVE_ID, "verified", { db: fake.db, now: NOW });
    expect(fake.get(`${CHILDCARE_IDENTITY_SESSIONS_COLLECTION}/${OBJECTIVE_ID}`)?.status).toBe("requires_input");
  });

  it("no-ops for an unknown objective", async () => {
    const fake = makeFakeDb();
    await mirrorChildcareIdentityEvent("vs_1", "unknown-objective", "verified", { db: fake.db });
    expect(fake.docs.size).toBe(0);
  });
});

describe("ChildcareIdentityError", () => {
  it("is a typed error with a machine-stable code", () => {
    const err = new ChildcareIdentityError("callback_expired");
    expect(err.name).toBe("ChildcareIdentityError");
    expect(err.code).toBe("callback_expired");
  });
});
