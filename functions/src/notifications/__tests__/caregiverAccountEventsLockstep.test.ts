import { describe, it, expect, vi, beforeEach } from "vitest";

// Caregiver sweep C11 (2026-10-11): the lifecycle notice's bell is the
// idempotency claim; when the text does NOT actually go, the claim is taken
// back so the site never shows an event the caregiver was never told. Kept as
// bell-only on purpose: a text the gate step is about to send itself, and a
// caregiver who texted STOP (the site is then her only channel).

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const sent: any[] = [];
  const bells: any[] = [];
  const rolledBack: any[] = [];
  const makeDoc = (path: string): any => ({
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    collection: (sub: string) => makeColl(`${path}/${sub}`),
  });
  const makeColl = (coll: string): any => ({
    doc: (id: string) => makeDoc(`${coll}/${id}`),
    where: () => ({ limit: () => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) }) }),
    add: vi.fn(async () => ({ id: "a" })),
  });
  return { docState, sent, bells, rolledBack, collectionMock: vi.fn((c: string) => makeColl(c)), sendResult: { value: true as boolean }, reset: () => { docState.clear(); sent.length = 0; bells.length = 0; rolledBack.length = 0; } };
});
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: hoisted.collectionMock }), { FieldValue: { serverTimestamp: () => ({ __ts: true }) } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../userNotification", () => ({
  writeUserNotification: vi.fn(async (n: any) => { hoisted.bells.push(n); return true; }),
  deleteUserNotification: vi.fn(async (sourcePath: string, eventId: string, recipientId: string, transitionType: string) => { hoisted.rolledBack.push({ sourcePath, eventId, recipientId, transitionType }); return true; }),
}));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async (phone: string, m: any) => { hoisted.sent.push({ phone, m }); return hoisted.sendResult.value; }) }));
vi.mock("../../linq/client", () => ({ sendToPhone: vi.fn(async (phone: string, content: string) => { hoisted.sent.push({ phone, m: { content } }); return "dropped"; }) }));
vi.mock("../../config/appUrl", () => ({ appLink: (p: string) => `https://eviacares.com${p}` }));
vi.mock("../../utils/caregiverPhone", () => ({ resolveCaregiverPhone: vi.fn(async (uid: string) => (uid === "nophone" ? undefined : "+15551112222")) }));

import { notifyCaregiverAccountEvent } from "../caregiverAccountEvents";

beforeEach(() => { hoisted.reset(); hoisted.sendResult.value = true; });

describe("notifyCaregiverAccountEvent — bell ⇄ text", () => {
  it("text went → bell stays; the text is a fixed string (block-only review, never rephrased — C12)", async () => {
    hoisted.docState.set("agent_sessions/+15551112222", { caregiverId: "cg1" });
    expect(await notifyCaregiverAccountEvent("cg1", "payouts_enabled", { eventId: "e1" })).toEqual({ bell: true, text: true });
    expect(hoisted.sent[0].m).toMatchObject({ fixedString: true, canDrop: false, urgency: "immediate" });
    expect(hoisted.rolledBack).toHaveLength(0);
  });

  it("the send layer dropped / blocked the text → the bell is taken back", async () => {
    hoisted.docState.set("agent_sessions/+15551112222", { caregiverId: "cg1" });
    hoisted.sendResult.value = false;
    expect(await notifyCaregiverAccountEvent("cg1", "payouts_enabled", { eventId: "e2" })).toEqual({ bell: false, text: false });
    expect(hoisted.bells).toHaveLength(1); // the claim was made…
    expect(hoisted.rolledBack).toEqual([{ sourcePath: "caregivers/cg1", eventId: "e2", recipientId: "cg1", transitionType: "payouts_enabled" }]); // …and taken back
  });

  it("no phone on file → no text, bell taken back; no session and the raw send dropped → taken back too", async () => {
    expect(await notifyCaregiverAccountEvent("nophone", "payouts_enabled", { eventId: "e3" })).toEqual({ bell: false, text: false });
    expect(hoisted.rolledBack.at(-1)).toMatchObject({ recipientId: "nophone" });
    expect(await notifyCaregiverAccountEvent("cg2", "payouts_enabled", { eventId: "e4" })).toEqual({ bell: false, text: false }); // sendToPhone → "dropped"
    expect(hoisted.rolledBack.at(-1)).toMatchObject({ recipientId: "cg2", eventId: "e4" });
  });

  it("opted out (STOP) keeps the bell — the site is her channel; the gate-owned text keeps the bell — the step sends it", async () => {
    hoisted.docState.set("agent_sessions/+15551112222", { caregiverId: "cg1", optedOut: true });
    expect(await notifyCaregiverAccountEvent("cg1", "payouts_enabled", { eventId: "e5" })).toEqual({ bell: true, text: false });
    hoisted.docState.set("agent_sessions/+15551112222", { caregiverId: "cg1", onboardingStep: "caregiver_awaiting_bgcheck" });
    expect(await notifyCaregiverAccountEvent("cg1", "bgcheck_clear", { eventId: "e6" })).toEqual({ bell: true, text: false });
    expect(hoisted.rolledBack).toHaveLength(0);
  });

  it("a bell-only kind (transport_badge_lost) never sends and never rolls back", async () => {
    expect(await notifyCaregiverAccountEvent("cg1", "transport_badge_lost", { eventId: "e7", ctx: { reason: "services" } })).toEqual({ bell: true, text: false });
    expect(hoisted.sent).toHaveLength(0);
    expect(hoisted.rolledBack).toHaveLength(0);
  });
});
