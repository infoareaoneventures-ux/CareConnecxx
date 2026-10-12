import { describe, it, expect, vi, beforeEach } from "vitest";

// Bell ⇄ text in lockstep (caregiver sweep C11, 2026-10-11) for the trigger
// engine's reminders (the 1h interview reminder carries a `bell` copy): the
// bell is written ONLY when the send layer actually delivered the text. A
// dropped text (opted out / DND / cap / dedup / blocked) → no bell, and the
// trigger is recorded as suppressed, truthfully.

const hoisted = vi.hoisted(() => ({
  triggers: new Map<string, any>(),
  sessions: new Map<string, any>(),
  bells: [] as any[],
  order: [] as string[],
  sendResult: true as boolean,
  sends: [] as any[],
}));

vi.mock("firebase-admin", () => {
  const triggerDocs = () => [...hoisted.triggers.entries()].map(([id, d]) => ({
    id, data: () => d,
    ref: { id, update: async (u: any) => { hoisted.triggers.set(id, { ...hoisted.triggers.get(id), ...u }); } },
  }));
  const query = (): any => ({ where: query, orderBy: query, limit: query, get: async () => {
    const docs = triggerDocs().filter((d) => !d.data().firedAt && !d.data().cancelledAt);
    return { empty: docs.length === 0, docs };
  } });
  const emptyQuery = (): any => ({ where: emptyQuery, orderBy: emptyQuery, limit: emptyQuery, get: async () => ({ empty: true, docs: [] }) });
  const collection = (name: string): any => {
    if (name === "proactive_triggers") return { ...query() };
    if (name === "agent_sessions") return {
      ...emptyQuery(),
      doc: (id: string) => ({ get: async () => ({ exists: hoisted.sessions.has(id), data: () => hoisted.sessions.get(id) }), update: async () => {} }),
    };
    return { ...emptyQuery(), doc: () => ({ get: async () => ({ exists: false, data: () => undefined }), collection: () => emptyQuery(), update: async () => {} }), add: async () => ({ id: "x" }) };
  };
  const firestore = Object.assign(() => ({ collection, batch: () => ({ update: () => {}, commit: async () => {} }) }), {
    FieldValue: { serverTimestamp: () => "__ts__", delete: () => "__del__" },
    Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("firebase-functions/v1", () => {
  const builder: any = {
    runWith: () => builder,
    firestore: { document: () => ({ onWrite: (h: any) => h, onUpdate: (h: any) => h, onCreate: (h: any) => h }) },
    pubsub: { schedule: () => ({ timeZone: () => ({ onRun: (h: any) => h }), onRun: (h: any) => h }) },
  };
  return { __esModule: true, ...builder, default: builder };
});
vi.mock("../../utils/claudeClient", () => ({ getSharedClient: () => ({ messages: { create: vi.fn() } }) }));
vi.mock("../../linq/client", () => ({ sendToPhone: vi.fn() }));
vi.mock("../../agents/caraAgent", () => ({
  sendViaInteractionAgent: vi.fn(async (phone: string, out: any) => { hoisted.sends.push({ phone, out }); hoisted.order.push("text"); return hoisted.sendResult; }),
}));
vi.mock("../../notifications/userNotification", () => ({
  writeUserNotification: vi.fn(async (n: any) => { hoisted.bells.push(n); hoisted.order.push("bell"); return true; }),
}));
vi.mock("../proactiveTriggerClaim", () => ({
  claimProactiveTrigger: vi.fn(async (_db: any, ref: any, now: string) => { await ref.update({ firedAt: now, deliveryState: "firing" }); return true; }),
  settleProactiveTriggerDelivery: vi.fn(async (ref: any, now: string, err?: unknown) => { await ref.update({ deliveryState: err ? "failed_ambiguous" : "delivered", deliveryCompletedAt: now }); }),
}));
vi.mock("../../observability/systemStatus", () => ({ isSystemDegraded: async () => false }));
vi.mock("../../scheduled/engineGate", () => ({ gateOptionalSend: vi.fn(async () => ({ allowed: true, disposition: "send", reason: "ok" })) }));
vi.mock("../../agents/commitmentTracker", () => ({ sweepOverdueCommitments: async () => {}, sweepDroppedTurns: async () => {} }));

import { runTriggerEngine } from "../triggerEngine";

function seedReminder(id: string, extra: Record<string, unknown> = {}) {
  hoisted.triggers.set(id, {
    userId: "cg-1", phone: "+15550001111", type: "appointment_reminder",
    scheduledAt: new Date(Date.now() - 60_000).toISOString(), // due a minute ago — not stale
    message: "Interview in an hour with Basra Yousuf — https://meet.example. Reply if you need to reschedule.",
    firedAt: null, cancelledAt: null, createdAt: new Date(Date.now() - 3600_000).toISOString(),
    bell: { recipientId: "cg-1", type: "interview_reminder", title: "Interview in an hour", body: "Interview in an hour with Basra Yousuf.", data: { interviewId: "iv-1" } },
    ...extra,
  });
}

beforeEach(() => {
  hoisted.triggers.clear();
  hoisted.sessions.clear();
  hoisted.bells.length = 0;
  hoisted.order.length = 0;
  hoisted.sends.length = 0;
  hoisted.sendResult = true;
  hoisted.sessions.set("+15550001111", { chatId: "c1", optedOut: false, createdAt: "2026-01-01T00:00:00.000Z" });
});

describe("runTriggerEngine — bell ⇄ text in lockstep", () => {
  it("text sent → the bell copy follows it (idempotent on the trigger doc) and the trigger settles delivered", async () => {
    seedReminder("t1");

    await (runTriggerEngine as any)();

    expect(hoisted.sends).toHaveLength(1);
    expect(hoisted.sends[0].out).toMatchObject({ canDrop: false, urgency: "standard", sourceAgent: "trigger_engine" });
    expect(hoisted.order).toEqual(["text", "bell"]);
    expect(hoisted.bells).toEqual([expect.objectContaining({
      sourcePath: "proactive_triggers/t1", eventId: "t1", recipientId: "cg-1", transitionType: "appointment_reminder",
      type: "interview_reminder", title: "Interview in an hour", body: "Interview in an hour with Basra Yousuf.", data: { interviewId: "iv-1" },
    })]);
    expect(hoisted.triggers.get("t1").deliveryState).toBe("delivered");
  });

  it("text dropped by the send layer → no bell, trigger recorded as suppressed", async () => {
    hoisted.sendResult = false;
    seedReminder("t2");

    await (runTriggerEngine as any)();

    expect(hoisted.sends).toHaveLength(1);
    expect(hoisted.bells).toHaveLength(0);
    expect(hoisted.triggers.get("t2")).toMatchObject({ deliveryState: "suppressed", suppressionReason: "send_layer_dropped" });
  });

  it("a recipient who texted STOP: the engine cancels the trigger before sending — no text, no bell", async () => {
    hoisted.sessions.set("+15550001111", { chatId: "c1", optedOut: true, createdAt: "2026-01-01T00:00:00.000Z" });
    seedReminder("t3");

    await (runTriggerEngine as any)();

    expect(hoisted.sends).toHaveLength(0);
    expect(hoisted.bells).toHaveLength(0);
    expect(hoisted.triggers.get("t3").cancelledAt).toBeTruthy();
  });
});
