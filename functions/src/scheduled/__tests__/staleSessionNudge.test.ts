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
  sessions:   new Map<string, any>(),   // id → session data (drives the "!=" nudge query)
  stuck:      new Map<string, any>(),   // id → session data (drives the "in" stuck-recovery query)
  caregivers: new Map<string, any>(),   // id → caregiver data (backgroundCheckData etc.)
  users:      new Map<string, any>(),   // id → users doc (the live-progress check reads this)
  updates:    [] as Array<{ id: string; data: any }>, // every .update() payload, in order
};

vi.mock("firebase-admin", () => {
  const makeSessionDocRef = (id: string) => ({
    id,
    get:    async () => ({ exists: store.sessions.has(id) || store.stuck.has(id), data: () => store.sessions.get(id) ?? store.stuck.get(id) }),
    update: vi.fn(async (data: any) => { store.updates.push({ id, data }); }),
  });
  const collection = (name: string) => {
    if (name === "caregivers") {
      return { doc: (id: string) => ({ get: async () => ({ exists: store.caregivers.has(id), data: () => store.caregivers.get(id) }) }) };
    }
    if (name === "users") {
      return { doc: (id: string) => ({ get: async () => ({ exists: store.users.has(id), data: () => store.users.get(id) }) }) };
    }
    // agent_sessions
    let lastOp = "";
    let lastValues: string[] = [];
    const ref: any = {
      where: (_f: string, op: string, values: any) => { lastOp = op; lastValues = Array.isArray(values) ? values : []; return ref; },
      get:   async () => {
        // The "in" queries are the 7-day stuck-recovery sweep (WEBHOOK_AWAITING_STEPS)
        // and the permissions auto-complete sweep (PERMISSION_STEPS) — filter the
        // stuck store by the step list so each sweep only sees its own sessions.
        if (lastOp === "in") {
          const docs = [...store.stuck.entries()]
            .filter(([, data]) => lastValues.includes(data.onboardingStep))
            .map(([id, data]) => ({ id, data: () => data, ref: makeSessionDocRef(id) }));
          return { docs };
        }
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

const sendSpy = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendSpy(...a) }));

// The stuck-recovery sweep dynamically imports resendStuckStep — mock it so the
// tests control whether a link actually went out (true) or not (false), without
// loading the whole onboarding machine.
const resendStuckStep = vi.fn(async (..._a: unknown[]) => true);
vi.mock("../../agents/onboardingConversation", () => ({
  resendStuckStep: (...a: unknown[]) => resendStuckStep(...a),
}));

// The real userHasRealOnboardingProgress does its own "caregivers" doc read —
// mocked here so these tests control the verdict directly via the seeded
// "users" doc's jobPostingCompleted flag, without pulling in all of webhooks.ts.
vi.mock("../../linq/webhooks", () => ({
  userHasRealOnboardingProgress: vi.fn(async (_userId: string, userData: Record<string, unknown>) =>
    Boolean(userData.jobPostingCompleted)),
}));

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
  store.stuck.clear();
  store.caregivers.clear();
  store.users.clear();
  store.updates.length = 0;
  genCalls.length = 0;
  sendSpy.mockClear();
  resendStuckStep.mockClear();
  resendStuckStep.mockResolvedValue(true);
});

const EIGHT_DAYS_AGO = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

function seedStuckSession(id: string, step: string, data: Record<string, unknown> = {}) {
  store.stuck.set(id, {
    chatId: `chat-${id}`, optedOut: false,
    createdAt: EIGHT_DAYS_AGO, updatedAt: EIGHT_DAYS_AGO,
    onboardingStep: step,
    ...data,
  });
}

/** All gateLinkResentAt.* stamp writes recorded for a session id. */
const stampWrites = (id: string) => store.updates.filter(
  (u) => u.id === id && Object.keys(u.data).some((k) => k.startsWith("gateLinkResentAt.")),
);

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

  it("stuck-recovery link resend stamps gateLinkResentAt for the parked step (shared cooldown window)", async () => {
    // FIX 2 (2026-07-17): the 7-day recovery re-delivers the gate link but never
    // opened the resend cooldown — an inbound `other` reply right after the
    // nudge delivered a SECOND link card within a minute.
    seedStuckSession("+15550005555", "caregiver_awaiting_photo", { userType: "caregiver" });

    await (sendStaleSessionNudges as any)();

    expect(resendStuckStep).toHaveBeenCalledWith("+15550005555");
    const stamps = stampWrites("+15550005555");
    expect(stamps).toHaveLength(1);
    const stampValue = stamps[0].data["gateLinkResentAt.caregiver_awaiting_photo"];
    expect(typeof stampValue).toBe("string");
    expect(isNaN(Date.parse(stampValue))).toBe(false);
    // The recovery bookkeeping still happened too.
    expect(store.updates.some((u) => u.id === "+15550005555" && typeof u.data.stuckRecoverySentAt === "string")).toBe(true);
  });

  it("stuck-recovery that could NOT resend (resendStuckStep false) writes no stamp", async () => {
    seedStuckSession("+15550006666", "caregiver_awaiting_photo", { userType: "caregiver" });
    resendStuckStep.mockResolvedValue(false);

    await (sendStaleSessionNudges as any)();

    expect(stampWrites("+15550006666")).toHaveLength(0);
  });

  it("stuck-recovery at a non-cooldown step (bgcheck consent) sends but never stamps", async () => {
    // caregiver_awaiting_bgcheck_consent has no `other`-branch resend cooldown —
    // a stamp there would be dead state.
    seedStuckSession("+15550007777", "caregiver_awaiting_bgcheck_consent", { userType: "caregiver" });

    await (sendStaleSessionNudges as any)();

    expect(resendStuckStep).toHaveBeenCalledWith("+15550007777");
    expect(stampWrites("+15550007777")).toHaveLength(0);
  });

  it("text-only 48h nudge (no link delivered) writes no gateLinkResentAt stamp", async () => {
    // The regular nudge sweep sends prose via sendViaInteractionAgent — its copy
    // says "reply here and I'll send the link again", it never sends the link
    // itself, so it must NOT open the cooldown window.
    seedSession("+15550008888", {
      onboardingStep: "caregiver_awaiting_photo", userType: "caregiver",
      onboardingData: { name: "Ana" },
    });

    await (sendStaleSessionNudges as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1); // the text nudge went out
    expect(resendStuckStep).not.toHaveBeenCalled();
    expect(stampWrites("+15550008888")).toHaveLength(0);
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

  // 2026-08-30 fix: a client who already finished via the WEBSITE still had a
  // stale, incomplete onboardingStep on this session doc forever — this job
  // wrongly nudged "you're almost there, just tell us who needs care" for
  // someone who'd already finished days earlier.
  it("skips and self-heals a CLIENT session whose website progress is already real", async () => {
    seedSession("+15550009999", {
      onboardingStep: "client_ask_senior", userType: "client", userId: "client-1",
      onboardingData: { firstName: "Hamse" },
    });
    store.users.set("client-1", { jobPostingCompleted: true });

    await (sendStaleSessionNudges as any)();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(store.updates).toContainEqual({ id: "+15550009999", data: { onboardingStep: "complete" } });
  });

  it("still nudges a CLIENT session with no real website progress", async () => {
    seedSession("+15550010000", {
      onboardingStep: "client_ask_senior", userType: "client", userId: "client-2",
      onboardingData: { firstName: "Dana" },
    });
    store.users.set("client-2", { jobPostingCompleted: false });

    await (sendStaleSessionNudges as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(store.updates.some((u) => u.id === "+15550010000" && u.data.onboardingStep === "complete")).toBe(false);
  });

  it("still nudges a CLIENT session with no users doc at all (fail-soft)", async () => {
    seedSession("+15550011111", {
      onboardingStep: "client_ask_senior", userType: "client", userId: "client-missing",
      onboardingData: { firstName: "Kim" },
    });

    await (sendStaleSessionNudges as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
