import { describe, it, expect, vi, beforeEach } from "vitest";

// Caregiver sweep C8 (2026-10-11): a visit released by the renewal lock /
// membership cancel goes through the page's cancel write with cancelledBy
// 'system' (triggers/caregiverAccountEvents.ts releaseUpcomingVisitsOnLock).
// The FAMILY is told (released, a replacement offered, the reason never stated);
// the caregiver is NOT texted "a client cancelled… sorry". Plus the lockstep rule
// (C11): every bell here is written only after its text went.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
    set: async (d: any) => docState.set(path, { ...(docState.get(path) ?? {}), ...d }),
    update: async (d: any) => docState.set(path, { ...(docState.get(path) ?? {}), ...d }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });
  const makeCollRef = (path: string): any => ({
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    where: () => ({ where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }), limit: () => ({ get: async () => ({ empty: true, docs: [] }) }), get: async () => ({ empty: true, docs: [] }) }),
  });
  const dbMock = { collection: (p: string) => makeCollRef(p) };
  return { docState, dbMock, reset: () => docState.clear() };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => hoisted.dbMock },
  firestore: Object.assign(() => hoisted.dbMock, { FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }), delete: () => ({ __delete: true }) } }),
}));
vi.mock("firebase-functions/v1", () => {
  const builder: any = { firestore: { document: () => ({ onWrite: (h: any) => h, onUpdate: (h: any) => h, onCreate: (h: any) => h }) } };
  return { __esModule: true, ...builder, default: builder };
});

const sendViaInteractionAgent = vi.fn().mockResolvedValue(true);
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendViaInteractionAgent(...a) }));
const sendToPhone = vi.fn().mockResolvedValue("sent");
vi.mock("../../linq/client", () => ({ sendToPhone: (...a: unknown[]) => sendToPhone(...a) }));
const writeUserNotification = vi.fn().mockResolvedValue(true);
vi.mock("../../notifications/userNotification", () => ({ writeUserNotification: (...a: unknown[]) => writeUserNotification(...a) }));
vi.mock("../../agents/shiftReplacement", () => ({ findReplacementCandidates: vi.fn(async () => []) }));

import { onShiftStatusChanged, onBookingRequestWrite, onBookingAmendmentWrite } from "../notificationTriggers";

const CAREGIVER = "cg1";
const CLIENT = "client1";
const CG_PHONE = "+15550001111";
const CL_PHONE = "+15550002222";

function change(before: any, afterId: string, after: any) {
  return {
    before: { exists: before !== null, data: () => before },
    after: { exists: after !== null, id: afterId, data: () => after, ref: { update: async () => {} } },
  };
}
const ctx = (shiftId = "s1") => ({ params: { shiftId, bookingId: "br1", amendmentId: "am1" }, eventId: "evt-1" });
const textsTo = (phone: string) => sendViaInteractionAgent.mock.calls.filter((c) => c[0] === phone).map((c) => (c[1] as any).content as string);
const bellsFor = (uid: string) => writeUserNotification.mock.calls.map((c) => c[0] as any).filter((b) => b.recipientId === uid);

beforeEach(() => {
  hoisted.reset();
  sendViaInteractionAgent.mockClear().mockResolvedValue(true);
  sendToPhone.mockClear();
  writeUserNotification.mockClear().mockResolvedValue(true);
  hoisted.docState.set(`caregivers/${CAREGIVER}`, { phone: CG_PHONE });
  hoisted.docState.set(`users/${CLIENT}`, { phone: CL_PHONE });
  hoisted.docState.set(`agent_sessions/${CG_PHONE}`, { caregiverId: CAREGIVER });
  hoisted.docState.set(`agent_sessions/${CL_PHONE}`, { userId: CLIENT });
});

describe("C8 — a 'system' release (care provider locked) tells the FAMILY, never the care provider", () => {
  const base = { clientId: CLIENT, caregiverId: CAREGIVER, caregiverName: "Alice", clientName: "The Nguyens", date: "2099-03-04" };

  it("> 24h out (status cancelled): the family hears the visit is released and is offered another care provider; the reason is never stated; the care provider gets nothing", async () => {
    await (onShiftStatusChanged as any)(change({ ...base, status: "scheduled" }, "s1", { ...base, status: "cancelled", cancelledBy: "system" }), ctx());
    expect(textsTo(CG_PHONE)).toEqual([]);
    expect(bellsFor(CAREGIVER)).toEqual([]);
    const family = textsTo(CL_PHONE);
    expect(family).toHaveLength(1);
    expect(family[0]).toBe("Alice isn't available for the visit on Wed, Mar 4, so it's been released. Text me to find another care provider for that day, or to skip it.");
    expect(family[0]).not.toMatch(/membership|background|locked|cancelled the visit/i);
    expect(bellsFor(CLIENT)[0]).toMatchObject({ type: "shift_cancelled", title: "Visit Released", sourcePath: "shifts/s1", eventId: "evt-1", body: "Alice isn't available for the visit on Wed, Mar 4 — it's been released. Book another care provider or skip it." });
  });

  it("within 24h (status needs_replacement): the family gets the replacement offer in the released wording; the care provider is not told anything", async () => {
    await (onShiftStatusChanged as any)(change({ ...base, status: "scheduled" }, "s1", { ...base, status: "needs_replacement", cancelledBy: "system" }), ctx());
    expect(textsTo(CG_PHONE)).toEqual([]);
    expect(textsTo(CL_PHONE)).toEqual(["Alice isn't available for the visit on Wed, Mar 4. Text me to find a replacement, or to skip that visit."]);
    expect(bellsFor(CLIENT)[0]).toMatchObject({ type: "shift_needs_replacement", body: "Alice isn't available for the visit on Wed, Mar 4 — find a replacement or skip it." });
  });

  it("the care provider's own cancellation and the family's own cancellation keep their directions", async () => {
    await (onShiftStatusChanged as any)(change({ ...base, status: "scheduled" }, "s1", { ...base, status: "cancelled", cancelledBy: "caregiver" }), ctx());
    expect(textsTo(CL_PHONE)).toEqual(["Alice cancelled the visit on Wed, Mar 4."]);
    expect(textsTo(CG_PHONE)).toEqual([]);
    sendViaInteractionAgent.mockClear();
    await (onShiftStatusChanged as any)(change({ ...base, status: "scheduled" }, "s2", { ...base, status: "cancelled", cancelledBy: "client" }), ctx("s2"));
    expect(textsTo(CG_PHONE)).toEqual(["The Nguyens cancelled the visit on Wed, Mar 4. Sorry for the inconvenience."]);
    expect(textsTo(CL_PHONE)).toEqual([]);
    // Legacy docs with no cancelledBy still read as the family's cancellation (unchanged), never as a system release.
    sendViaInteractionAgent.mockClear();
    await (onShiftStatusChanged as any)(change({ ...base, status: "scheduled" }, "s3", { ...base, status: "cancelled" }), ctx("s3"));
    expect(textsTo(CG_PHONE)).toHaveLength(1);
  });
});

describe("C11 — bell ⇄ text in lockstep on the booking pipeline", () => {
  it("the care provider's bell is written only after the text went; a dropped text writes no bell", async () => {
    const after = { status: "pending", clientId: CLIENT, caregiverId: CAREGIVER, clientName: "A Family" };
    await (onBookingRequestWrite as any)(change(null, "br1", after), ctx());
    expect(bellsFor(CAREGIVER)).toHaveLength(1);
    expect(bellsFor(CAREGIVER)[0]).toMatchObject({ type: "booking_request", sourcePath: "booking_requests/br1", eventId: "evt-1", transitionType: "booking_request_created" });
    // The send layer dropped it (blocked / suppressed) → no bell.
    writeUserNotification.mockClear();
    sendViaInteractionAgent.mockResolvedValueOnce(false);
    await (onBookingRequestWrite as any)(change(null, "br2", after), { params: { bookingId: "br2" }, eventId: "evt-2" });
    expect(bellsFor(CAREGIVER)).toHaveLength(0);
    // No phone on the record → no text → no bell.
    hoisted.docState.set(`caregivers/${CAREGIVER}`, {});
    await (onBookingRequestWrite as any)(change(null, "br3", after), { params: { bookingId: "br3" }, eventId: "evt-3" });
    expect(bellsFor(CAREGIVER)).toHaveLength(0);
  });

  it("a legacy Evia-pipeline request (agentTaskId) gets no text and therefore no bell", async () => {
    const after = { status: "pending", clientId: CLIENT, caregiverId: CAREGIVER, clientName: "A Family", agentTaskId: "task1" };
    await (onBookingRequestWrite as any)(change(null, "br1", after), ctx());
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
    expect(writeUserNotification).not.toHaveBeenCalled();
  });

  it("the family's bell beside a text another sender owns is still written (the text did go, through that sender)", async () => {
    const before = { status: "requested", caregiverId: CAREGIVER, clientId: CLIENT, caregiverName: "Alice" };
    const after = { ...before, status: "declined", respondedViaAgent: true };
    const { onVideoInterviewWrite } = await import("../notificationTriggers");
    await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" }, eventId: "evt-9" });
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
    expect(bellsFor(CLIENT)[0]).toMatchObject({ type: "interview_declined", sourcePath: "video_interviews/iv1" });
  });

  it("every text through this file is a fixed string (reviewed for a block, never rephrased — C12) at immediate urgency", async () => {
    const after = { status: "pending", clientId: CLIENT, caregiverId: CAREGIVER, clientName: "A Family" };
    await (onBookingRequestWrite as any)(change(null, "br1", after), ctx());
    expect(sendViaInteractionAgent).toHaveBeenCalledWith(CG_PHONE, expect.objectContaining({ fixedString: true, urgency: "immediate", canDrop: false }));
  });

  it("C18: the withdrawn schedule-change request is ONE sentence for the bell and the text", async () => {
    const before = { caregiverId: CAREGIVER, clientId: CLIENT, status: "pending", clientName: "The Nguyens" };
    await (onBookingAmendmentWrite as any)(change(before, "am1", { ...before, status: "cancelled" }), ctx());
    const sentence = "The Nguyens withdrew their schedule change request — no need to respond.";
    expect(textsTo(CG_PHONE)).toEqual([sentence]);
    expect(bellsFor(CAREGIVER)[0]).toMatchObject({ type: "amendment_cancelled", body: sentence });
  });
});
