import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * U8 (hallucination hardening 2026-07-17, R11) — representative behavior test
 * for the proactive scheduled-nudge group: every family-facing briefing that
 * interpolates a senior/client name must carry describeWhoIsWho grounding so
 * the model can never attribute the care to the ACCOUNT HOLDER (the
 * "book Anahi's first visits" conflation when the care is for her mom Rosie).
 *
 * Self-signup sentinel: relationship === "self" means the person texting IS
 * the care recipient — the "family member coordinating care" disambiguation
 * must NOT appear.
 */

// ── In-memory Firestore: agent_sessions query + doc update ───────────────────
const store = {
  sessions: new Map<string, any>(),
  updates:  new Map<string, any>(),
};

vi.mock("firebase-admin", () => {
  const makeSessionDocRef = (id: string) => ({
    id,
    get:    async () => ({ exists: store.sessions.has(id), data: () => store.sessions.get(id) }),
    update: vi.fn(async (data: any) => { store.updates.set(id, data); }),
  });
  const collection = (_name: string) => {
    const ref: any = {
      where: () => ref,
      limit: () => ref,
      get:   async () => ({
        size: store.sessions.size,
        docs: [...store.sessions.entries()].map(([id, data]) => ({
          id, data: () => data, ref: makeSessionDocRef(id),
        })),
      }),
      doc: (id: string) => makeSessionDocRef(id),
    };
    return ref;
  };
  const firestore = Object.assign(() => ({ collection }), {
    FieldValue: { increment: (n: number) => ({ __inc: n }) },
  });
  const stub = { apps: [], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("firebase-functions/v1", () => ({
  pubsub: {
    schedule: () => ({
      onRun:    (fn: any) => fn,
      timeZone: () => ({ onRun: (fn: any) => fn }),
    }),
  },
}));

const genCalls: Array<{ context: string; fallback: string }> = [];
vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async (opts: any) => { genCalls.push(opts); return opts.fallback; }),
}));

const sendSpy = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendSpy(...a) }));

import { familySilenceCheckinJob } from "../familySilenceCheckin";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function seedEligibleSession(id: string, onboardingData: Record<string, unknown>) {
  store.sessions.set(id, {
    chatId:        `chat-${id}`,
    optedOut:      false,
    createdAt:     daysAgo(10),   // account old enough (> 7 days)
    lastInboundAt: daysAgo(5),    // silent 3–30 days
    onboardingData,
  });
}

beforeEach(() => {
  store.sessions.clear();
  store.updates.clear();
  genCalls.length = 0;
  sendSpy.mockClear();
});

describe("familySilenceCheckin — who-is-who grounding (R11)", () => {
  it("family-coordinator signup: nudge context carries the WHO'S WHO line naming the care recipient", async () => {
    seedEligibleSession("+15550001111", {
      firstName:    "Anahi",
      seniorName:   "Rosie",
      relationship: "mother",
    });

    await (familySilenceCheckinJob as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(genCalls).toHaveLength(1);
    const ctx = genCalls[0].context;
    expect(ctx).toContain("WHO'S WHO");
    expect(ctx).toContain("Rosie");
    // The disambiguation: the reader coordinates the care, they don't receive it.
    expect(ctx).toContain("NOT the one receiving it");
    // Grounding rides in the SAME context as the senior-name interpolation.
    expect(ctx).toContain("and Rosie");
  });

  it("self-signup (relationship === 'self'): no 'coordinating' disambiguation — reader IS the recipient", async () => {
    seedEligibleSession("+15550002222", {
      firstName:    "Gloria",
      seniorName:   "Gloria",
      relationship: "self",
    });

    await (familySilenceCheckinJob as any)();

    expect(genCalls).toHaveLength(1);
    const ctx = genCalls[0].context;
    expect(ctx).toContain("THEMSELVES");
    expect(ctx).not.toContain("NOT the one receiving it");
    expect(ctx).not.toContain("family member coordinating care");
  });
});
