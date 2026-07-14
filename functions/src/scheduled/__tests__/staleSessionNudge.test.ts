import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The daily stale-session nudge composes a per-step re-engagement text. Its
 * branches used to bake in state assertions the cron never checked — the
 * bg-check branch asserted "hasn't finished Checkr's form yet" even after the
 * check had CLEARED (spec 2026-07-09-002). These tests prove the nudge context
 * is now grounded in live Firestore state via LIVE_GATE_FACT_BUILDERS, and that
 * grounding didn't change WHICH sessions get nudged (cadence unchanged).
 */

// ── In-memory Firestore: agent_sessions (where + doc) and caregivers (doc) ─────
const store = {
  sessions:   new Map<string, any>(),   // id → session data (also drives the nudge query)
  caregivers: new Map<string, any>(),   // id → caregiver data (backgroundCheckData etc.)
  updates:    new Map<string, any>(),   // id → last .update() payload
};

vi.mock("firebase-admin", () => {
  const makeSessionDocRef = (id: string) => ({
    id,
    get:    async () => ({ exists: store.sessions.has(id), data: () => store.sessions.get(id) }),
    update: vi.fn(async (data: any) => { store.updates.set(id, data); }),
  });
  const collection = (name: string) => {
    if (name === "caregivers") {
      return { doc: (id: string) => ({ get: async () => ({ exists: store.caregivers.has(id), data: () => store.caregivers.get(id) }) }) };
    }
    // agent_sessions
    let lastOp = "";
    const ref: any = {
      where: (_f: string, op: string) => { lastOp = op; return ref; },
      get:   async () => {
        // The "in" query is the 7-day stuck-recovery sweep — keep it empty so the
        // dynamic resendStuckStep import never runs in this unit test.
        if (lastOp === "in") return { docs: [] };
        // The "!=" query is the nudge sweep.
        const docs = [...store.sessions.entries()].map(([id, data]) => ({
          id, data: () => data, ref: makeSessionDocRef(id),
        }));
        return { docs };
      },
      doc: (id: string) => makeSessionDocRef(id),
    };
    return ref;
  };
  const firestore = Object.assign(() => ({ collection }), {
    FieldValue: { increment: (n: number) => ({ __inc: n }), serverTimestamp: () => ({ __ts: true }), delete: () => ({ __del: true }) },
  });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

// Capture the pubsub handler so we can invoke it directly.
vi.mock("firebase-functions/v1", () => ({
  pubsub: { schedule: () => ({ onRun: (fn: any) => fn }) },
}));

const genCalls: Array<{ context: string; fallback: string }> = [];
vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async (opts: any) => { genCalls.push(opts); return opts.fallback; }),
}));

const sendSpy = vi.fn(async () => {});
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendSpy(...a) }));

import { sendStaleSessionNudges } from "../staleSessionNudge";

const OLD = new Date(Date.now() - 60 * 60 * 60 * 1000).toISOString(); // 60h ago (> 48h stale)

function seedSession(id: string, data: Record<string, unknown>) {
  store.sessions.set(id, {
    chatId: `chat-${id}`, optedOut: false, createdAt: OLD,
    ...data,
  });
}

beforeEach(() => {
  store.sessions.clear();
  store.caregivers.clear();
  store.updates.clear();
  genCalls.length = 0;
  sendSpy.mockClear();
});

describe("staleSessionNudge grounding", () => {
  it("bg-check nudge for a CLEARED check is grounded — never asserts 'hasn't finished the form'", async () => {
    seedSession("+15550001111", {
      onboardingStep: "caregiver_awaiting_bgcheck", userType: "caregiver", caregiverId: "cg1",
      onboardingData: { name: "Sam" },
    });
    store.caregivers.set("cg1", { backgroundCheckData: { status: "clear", checkrCandidateId: "cand-1" } });

    await (sendStaleSessionNudges as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1); // still nudged — cadence unchanged
    const ctx = genCalls[0].context;
    expect(ctx).toContain("LIVE STATUS RIGHT NOW");
    expect(ctx).toContain("CLEARED");
    // The ungrounded "hasn't finished Checkr's form yet" assertion must be
    // overridden by the live-first instruction (it can still appear as the stale
    // branch copy, but the live fact + never-contradict directive precede it).
    expect(ctx.indexOf("LIVE STATUS")).toBeLessThan(ctx.indexOf("hasn't finished"));
  });

  it("bg-check nudge for an unfinished check still nudges, grounded in the in-progress fact", async () => {
    seedSession("+15550002222", {
      onboardingStep: "caregiver_awaiting_bgcheck", userType: "caregiver", caregiverId: "cg2",
      onboardingData: { name: "Lee" },
    });
    store.caregivers.set("cg2", { backgroundCheckData: { checkrCandidateId: "cand-2", submittedAt: "2026-07-08T00:00:00Z", invitationStatus: "completed" } });

    await (sendStaleSessionNudges as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(genCalls[0].context).toContain("Checkr HAS their finished form");
  });

  it("fails soft: no caregiver doc → nudge still ships with the original (ungrounded) context", async () => {
    seedSession("+15550003333", {
      onboardingStep: "caregiver_awaiting_bgcheck", userType: "caregiver", // no caregiverId
      onboardingData: { name: "Kai" },
    });

    await (sendStaleSessionNudges as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(genCalls[0].context).not.toContain("LIVE STATUS RIGHT NOW");
  });

  it("does not nudge a session that is not yet stale (cadence unchanged)", async () => {
    seedSession("+15550004444", {
      onboardingStep: "caregiver_awaiting_bgcheck", userType: "caregiver", caregiverId: "cg4",
      createdAt: new Date().toISOString(), // fresh — inside the 48h window
      onboardingData: { name: "Ana" },
    });
    store.caregivers.set("cg4", { backgroundCheckData: { status: "clear" } });

    await (sendStaleSessionNudges as any)();

    expect(sendSpy).not.toHaveBeenCalled();
  });
});
