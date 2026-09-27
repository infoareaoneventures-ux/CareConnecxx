import { describe, it, expect, vi } from "vitest";

// The engine's hand-off to the send layer. 2026-09-27 live: the 1h interview
// reminder reached the family but the caregiver's was silently dropped (LLM
// SEND/WAIT judge or the 3/day proactive cap) — the two sides didn't match.
// Transactional reminders must never be droppable, like the shift reminders.

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: () => ({}) }), {
    FieldValue: { serverTimestamp: () => ({}), delete: () => ({}) },
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
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn() }));

import { triggerSendOptions } from "../triggerEngine";

describe("triggerSendOptions — transactional reminders are never droppable", () => {
  it("the 1h interview reminder (appointment_reminder) sends with canDrop: false for BOTH sides", () => {
    const family = triggerSendOptions({ type: "appointment_reminder", message: "Your interview with Mahad is in an hour — https://meet…" });
    const caregiver = triggerSendOptions({ type: "appointment_reminder", message: "Interview in an hour with Basra Yousuf — https://meet… Reply if you need to reschedule." });
    expect(family).toEqual({ urgency: "standard", canDrop: false });
    expect(caregiver).toEqual(family);
  });

  it("issue escalation directives are reply-exempt and not droppable", () => {
    expect(triggerSendOptions({ type: "custom", message: "issue_followup:abc" }).canDrop).toBe(false);
  });

  it("discretionary nudges stay droppable (judge + daily cap still apply)", () => {
    expect(triggerSendOptions({ type: "custom", message: "Following up on the caregiver search" })).toEqual({ urgency: "standard", canDrop: true });
  });
});
