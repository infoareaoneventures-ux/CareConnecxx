import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 2026-08-30 fix: this job shares staleSessionNudge.ts's bug — it trusted
 * agent_sessions.onboardingStep alone to decide someone stalled, with no
 * check of whether the client already finished the real thing via the
 * website. These tests prove the live check skips (and self-heals) a client
 * session whose website progress is already real, without changing cadence
 * for anyone else.
 */

const store = {
  sessions: new Map<string, any>(),
  users:    new Map<string, any>(),
  updates:  [] as Array<{ id: string; data: any }>,
};

vi.mock("firebase-admin", () => {
  const collection = (name: string) => {
    if (name === "users") {
      return { doc: (id: string) => ({ get: async () => ({ exists: store.users.has(id), data: () => store.users.get(id) }) }) };
    }
    // agent_sessions
    return {
      get: async () => ({
        empty: store.sessions.size === 0,
        docs: [...store.sessions.entries()].map(([id, data]) => ({
          id, data: () => data,
          ref: { update: vi.fn(async (upd: any) => { store.updates.push({ id, data: upd }); }) },
        })),
      }),
      doc: (id: string) => ({
        get: async () => ({ exists: store.sessions.has(id), data: () => store.sessions.get(id) }),
        update: vi.fn(async (upd: any) => { store.updates.push({ id, data: upd }); }),
      }),
    };
  };
  const firestore = Object.assign(() => ({ collection }), {
    FieldValue: { increment: (n: number) => ({ __inc: n }), serverTimestamp: () => ({ __ts: true }), delete: () => ({ __del: true }) },
  });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("firebase-functions/v1", () => ({
  pubsub: { schedule: () => ({ timeZone: () => ({ onRun: (fn: any) => fn }) }) },
}));

vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async (opts: any) => opts.fallback),
}));

const sendSpy = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendSpy(...a) }));

vi.mock("../../linq/webhooks", () => ({
  userHasRealOnboardingProgress: vi.fn(async (_userId: string, userData: Record<string, unknown>) =>
    Boolean(userData.jobPostingCompleted)),
}));

import { sendOnboardingReengagement } from "../onboardingReengagement";

const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

function seedSession(id: string, data: Record<string, unknown>) {
  store.sessions.set(id, {
    chatId: `chat-${id}`, optedOut: false, lastInboundAt: TWO_DAYS_AGO,
    onboardingStep: "client_ask_senior",
    ...data,
  });
}

beforeEach(() => {
  store.sessions.clear();
  store.users.clear();
  store.updates.length = 0;
  sendSpy.mockClear();
});

describe("sendOnboardingReengagement", () => {
  it("nudges a stalled client session with no website progress", async () => {
    seedSession("+15551110000", { userType: "client", userId: "client-1", onboardingData: { firstName: "Dana" } });
    store.users.set("client-1", { jobPostingCompleted: false });

    await (sendOnboardingReengagement as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("skips and self-heals a client session whose website progress is already real", async () => {
    seedSession("+15551110001", { userType: "client", userId: "client-2", onboardingData: { firstName: "Hamse" } });
    store.users.set("client-2", { jobPostingCompleted: true });

    await (sendOnboardingReengagement as any)();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(store.updates).toContainEqual({ id: "+15551110001", data: { onboardingStep: "complete" } });
  });

  it("still nudges a caregiver session (SMS-only onboarding — no website path to check)", async () => {
    seedSession("+15551110002", { userType: "caregiver", caregiverId: "cg1", onboardingStep: "caregiver_ask_rate", onboardingData: { name: "Sam" } });

    await (sendOnboardingReengagement as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("fails soft and still nudges when the client has no users doc at all", async () => {
    seedSession("+15551110003", { userType: "client", userId: "client-missing", onboardingData: { firstName: "Kim" } });

    await (sendOnboardingReengagement as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
