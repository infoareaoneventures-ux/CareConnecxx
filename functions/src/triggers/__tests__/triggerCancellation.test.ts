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
vi.mock("../../utils/claudeClient", () => ({ getSharedClient: vi.fn() }));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn() }));
vi.mock("../../linq/client", () => ({ sendToPhone: vi.fn() }));

import { isReplyExempt, cancelTriggersByRef, cancelTriggerIfUserReplied } from "../triggerEngine";

beforeEach(() => hoisted.reset());

describe("isReplyExempt", () => {
  it("exempts time-critical reminder types", () => {
    expect(isReplyExempt({ type: "appointment_reminder", message: "Interview in an hour" })).toBe(true);
    expect(isReplyExempt({ type: "medication_reminder", message: "meds" })).toBe(true);
  });

  it("exempts system-directive messages", () => {
    expect(isReplyExempt({ type: "custom", message: "interview_followup:iv1" })).toBe(true);
    expect(isReplyExempt({ type: "custom", message: "caregiver_checkin:appt1" })).toBe(true);
    expect(isReplyExempt({ type: "custom", message: "health_escalation:s1:a1" })).toBe(true);
  });

  it("keeps nudges and qa_retry reply-cancellable (twin-trigger + commitment tracker semantics)", () => {
    expect(isReplyExempt({ type: "weekly_checkin", message: "How was the week?" })).toBe(false);
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
      userId: "u1", phone: "+1", type: "weekly_checkin", message: "check in",
      cancelledAt: null, firedAt: null,
    });
    hoisted.docs.set("reminder", {
      userId: "u1", phone: "+1", type: "appointment_reminder", message: "Interview in an hour",
      cancelledAt: null, firedAt: null,
    });
    hoisted.docs.set("directive", {
      userId: "u1", phone: "+1", type: "custom", message: "caregiver_checkin:appt1",
      cancelledAt: null, firedAt: null,
    });
    await cancelTriggerIfUserReplied("u1", "+1");
    expect(hoisted.docs.get("nudge").cancelledAt).toBeTruthy();
    expect(hoisted.docs.get("reminder").cancelledAt).toBeNull();
    expect(hoisted.docs.get("directive").cancelledAt).toBeNull();
  });
});
