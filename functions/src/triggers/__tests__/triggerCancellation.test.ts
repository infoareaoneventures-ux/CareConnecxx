import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory proactive_triggers fake supporting where().get() and batch updates.
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const makeQuery = (filters: Array<[string, any]>): any => ({
    where: (field: string, _op: string, value: any) => makeQuery([...filters, [field, value]]),
    get: async () => {
      const matched = [...docs.entries()].filter(([, d]) =>
        filters.every(([f, v]) => (d[f] ?? null) === v)
      );
      return {
        empty: matched.length === 0,
        docs: matched.map(([id, d]) => ({
          id,
          data: () => d,
          ref: { id, update: async (u: any) => docs.set(id, { ...docs.get(id), ...u }) },
        })),
      };
    },
  });
  const dbMock = {
    collection: (name: string) => ({
      ...makeQuery([]),
      doc: (id: string) => ({
        get: async () => ({ exists: docs.has(id), data: () => docs.get(id) }),
        update: async (u: any) => docs.set(id, { ...docs.get(id), ...u }),
      }),
      add: async (d: any) => {
        const id = `t${docs.size + 1}`;
        docs.set(id, d);
        return { id };
      },
    }),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        update: (ref: any, u: any) => ops.push(() => docs.set(ref.id, { ...docs.get(ref.id), ...u })),
        commit: async () => ops.forEach((f) => f()),
      };
    },
  };
  return { docs, dbMock, reset: () => docs.clear() };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => hoisted.dbMock },
  firestore: () => hoisted.dbMock,
}));
vi.mock("firebase-functions/v1", () => {
  const builder: any = {
    runWith: () => builder,
    firestore: { document: () => ({ onWrite: (h: any) => h, onUpdate: (h: any) => h, onCreate: (h: any) => h }) },
    pubsub: { schedule: () => ({ timeZone: () => ({ onRun: (h: any) => h }), onRun: (h: any) => h }) },
  };
  return { __esModule: true, ...builder, default: builder };
});
// Claude client mock upgraded for the U2 generation tests below — existing
// cancellation tests never touch it.
const claudeHoisted = vi.hoisted(() => ({ messagesCreate: vi.fn() }));
vi.mock("../../utils/claudeClient", () => ({
  getSharedClient: () => ({
    messages: { create: (...args: unknown[]) => claudeHoisted.messagesCreate(...args) },
  }),
}));
// Output guard: real implementation by default; a test can force a verdict via
// `guardHoisted.override` (needed for shouldFireTrigger, whose exact "NO" reply
// can never trip the real guard).
const guardHoisted = vi.hoisted(() => ({ override: null as null | { ok: boolean; reason?: "meta_response" | "url" } }));
vi.mock("../../safety/outputGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../safety/outputGuard")>();
  return {
    ...actual,
    guardModelOutput: (text: string) => guardHoisted.override ?? actual.guardModelOutput(text),
  };
});
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn() }));
vi.mock("../../linq/client", () => ({ sendToPhone: vi.fn() }));

import {
  isReplyExempt,
  cancelTriggersByRef,
  cancelTriggerIfUserReplied,
  generateTriggerMessage,
  shouldFireTrigger,
} from "../triggerEngine";
import { ANTI_INVENTION_CLAUSE } from "../../utils/caraMessage";

beforeEach(() => {
  hoisted.reset();
  claudeHoisted.messagesCreate.mockReset();
  guardHoisted.override = null;
  delete process.env.CARA_OUTPUT_GUARD_ENABLED;
});

describe("isReplyExempt", () => {
  it("exempts time-critical reminder types", () => {
    expect(isReplyExempt({ type: "appointment_reminder", message: "Interview in an hour" })).toBe(true);
  });

  it("exempts system-directive messages", () => {
    expect(isReplyExempt({ type: "custom", message: "issue_escalation:il1" })).toBe(true);
    expect(isReplyExempt({ type: "custom", message: "issue_escalation_final:il1" })).toBe(true);
    expect(isReplyExempt({ type: "custom", message: "issue_followup:il1" })).toBe(true);
  });

  it("keeps nudges and qa_retry reply-cancellable (twin-trigger + commitment tracker semantics)", () => {
    expect(isReplyExempt({ type: "custom", message: "How was the week?" })).toBe(false);
    expect(isReplyExempt({ type: "custom", message: "Just checking in about caregivers" })).toBe(false);
    expect(isReplyExempt({ type: "qa_retry", message: "qa_retry:{}" })).toBe(false);
  });
});

describe("cancelTriggersByRef", () => {
  it("cancels only pending triggers with the refId", async () => {
    hoisted.docs.set("a", { refId: "video_interview_iv1", type: "appointment_reminder", message: "m" });
    hoisted.docs.set("b", { refId: "video_interview_iv1", type: "appointment_reminder", message: "m", firedAt: "x" });
    hoisted.docs.set("c", { refId: "video_interview_OTHER", type: "appointment_reminder", message: "m" });
    const n = await cancelTriggersByRef("video_interview_iv1");
    expect(n).toBe(1);
    expect(hoisted.docs.get("a").cancelledAt).toBeTruthy();
    expect(hoisted.docs.get("b").cancelledAt).toBeUndefined(); // already fired
    expect(hoisted.docs.get("c").cancelledAt).toBeUndefined(); // different ref
  });
});

describe("cancelTriggerIfUserReplied", () => {
  it("cancels nudges but spares exempt reminders/directives", async () => {
    // NOTE: the pending-triggers query matches `== null`, mirroring prod docs
    // that carry explicit nulls; the fake treats missing as null too.
    hoisted.docs.set("nudge", {
      userId: "u1", phone: "+1", type: "custom", message: "check in",
      cancelledAt: null, firedAt: null,
    });
    hoisted.docs.set("reminder", {
      userId: "u1", phone: "+1", type: "appointment_reminder", message: "Interview in an hour",
      cancelledAt: null, firedAt: null,
    });
    hoisted.docs.set("directive", {
      userId: "u1", phone: "+1", type: "custom", message: "issue_escalation:il1",
      cancelledAt: null, firedAt: null,
    });
    await cancelTriggerIfUserReplied("u1", "+1");
    expect(hoisted.docs.get("nudge").cancelledAt).toBeTruthy();
    expect(hoisted.docs.get("reminder").cancelledAt).toBeNull();
    expect(hoisted.docs.get("directive").cancelledAt).toBeNull();
  });
});

// ── U2 — anti-invention clause + output guard on the two model calls ─────────

const baseTrigger: any = {
  userId: "u1",
  phone: "+15550001111",
  type: "custom",
  scheduledAt: "2026-07-17T09:00:00.000Z",
  createdAt: "2026-07-16T09:00:00.000Z",
  message: "Checking in — how did the first visit go?",
  source: "claude",
  intent: "post-first-visit check-in",
};

// The exact leaked-incident shape: the model replies to the briefing author.
const META_OUTPUT =
  "Got it, but I need the briefing context to write this message, " +
  "who's the caregiver, what shift/client situation are we talking about...";

const modelReturns = (text: string) => {
  claudeHoisted.messagesCreate.mockResolvedValue({ content: [{ type: "text", text }] });
};

describe("generateTriggerMessage (U2)", () => {
  it("carries ANTI_INVENTION_CLAUSE in its system prompt", async () => {
    modelReturns("How did the first visit go yesterday?");
    await generateTriggerMessage(baseTrigger, "care context here");
    const params = claudeHoisted.messagesCreate.mock.calls[0][0] as { system: string };
    expect(params.system).toContain(ANTI_INVENTION_CLAUSE);
  });

  it("returns valid regenerated text unchanged", async () => {
    modelReturns("How did the first visit go yesterday?");
    await expect(generateTriggerMessage(baseTrigger, "ctx"))
      .resolves.toBe("How did the first visit go yesterday?");
  });

  it("falls back to the stored trigger.message when the output is guard-rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    modelReturns(META_OUTPUT);
    await expect(generateTriggerMessage(baseTrigger, "ctx")).resolves.toBe(baseTrigger.message);
    warn.mockRestore();
  });
});

describe("shouldFireTrigger (U2)", () => {
  const recent = [{ role: "user", content: "thanks, the visit went great" }];

  it("carries ANTI_INVENTION_CLAUSE in its system prompt, one-word directive last", async () => {
    modelReturns("YES");
    await shouldFireTrigger(baseTrigger, recent);
    const system = (claudeHoisted.messagesCreate.mock.calls[0][0] as { system: string }).system;
    expect(system).toContain(ANTI_INVENTION_CLAUSE);
    expect(system.indexOf("One word only: YES or NO.")).toBeGreaterThan(system.indexOf(ANTI_INVENTION_CLAUSE));
  });

  it("suppresses on a clean NO verdict", async () => {
    modelReturns("NO");
    await expect(shouldFireTrigger(baseTrigger, recent)).resolves.toBe(false);
  });

  it("defaults open (fires) when the verdict is guard-rejected — same as the catch path", async () => {
    modelReturns("NO");
    guardHoisted.override = { ok: false, reason: "meta_response" };
    await expect(shouldFireTrigger(baseTrigger, recent)).resolves.toBe(true);
  });
});
