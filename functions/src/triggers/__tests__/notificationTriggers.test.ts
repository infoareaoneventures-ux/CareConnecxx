import { describe, it, expect, vi, beforeEach } from "vitest";

// Booking-pipeline SMS parity (2026-08-30): the website's own booking_requests/
// shifts/booking_amendments/video_interviews/job_applications triggers only
// ever wrote an in-app notification — no text went out, even for a pure
// website-only action, unlike the legacy appointments pipeline's
// onAppointmentUpdated (which already texts). These tests lock in the new
// texts, and — just as importantly — confirm the ones that must NOT fire
// because an existing, richer Evia-side message already covers that case
// (agentTaskId-gated bookings, and Evia's own manual notifies that were
// removed in favor of this single source of truth).

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const addMock = vi.fn(async (path: string, data: any) => { docState.set(`${path}/auto`, data); });

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });
  const makeCollRef = (path: string): any => ({
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    add: (data: any) => addMock(path, data),
  });

  const dbMock = { collection: (p: string) => makeCollRef(p) };

  return { docState, addMock, dbMock, reset: () => { docState.clear(); addMock.mockClear(); } };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => hoisted.dbMock },
  firestore: Object.assign(() => hoisted.dbMock, {
    FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
  }),
}));

// Builder mock: functions.firestore.document(path).onWrite/onUpdate/onCreate(handler) → handler
vi.mock("firebase-functions/v1", () => {
  const builder: any = {
    firestore: { document: () => ({ onWrite: (h: any) => h, onUpdate: (h: any) => h, onCreate: (h: any) => h }) },
  };
  return { __esModule: true, ...builder, default: builder };
});

const sendViaInteractionAgent = vi.fn().mockResolvedValue(true);
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendViaInteractionAgent(...a) }));

const sendToPhone = vi.fn().mockResolvedValue(undefined);
vi.mock("../../linq/client", () => ({ sendToPhone: (...a: unknown[]) => sendToPhone(...a) }));

const writeUserNotification = vi.fn().mockResolvedValue(true);
vi.mock("../../notifications/userNotification", () => ({ writeUserNotification: (...a: unknown[]) => writeUserNotification(...a) }));

import {
  onBookingRequestWrite,
  onBookingAmendmentWrite,
  onShiftStatusChanged,
  onJobApplicationCreate,
  onVideoInterviewWrite,
} from "../notificationTriggers";

const CAREGIVER = "cg1";
const CLIENT = "client1";

function change(before: any, afterId: string, after: any) {
  return {
    before: { exists: before !== null, data: () => before },
    after: { exists: after !== null, id: afterId, data: () => after },
  };
}

beforeEach(() => {
  hoisted.reset();
  sendViaInteractionAgent.mockClear();
  sendToPhone.mockClear();
  writeUserNotification.mockClear();
  hoisted.docState.set(`caregivers/${CAREGIVER}`, { phone: "+15550001111" });
  hoisted.docState.set(`users/${CLIENT}`, { phone: "+15550002222" });
});

describe("onBookingRequestWrite — SMS parity", () => {
  it("a pure website-created booking (no agentTaskId) texts the caregiver", async () => {
    const after = { status: "pending", clientId: CLIENT, caregiverId: CAREGIVER, clientName: "A Family" };
    await (onBookingRequestWrite as any)(change(null, "br1", after), { params: { bookingId: "br1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: expect.stringContaining("booking request") }));
  });

  it("an Evia-negotiated booking (agentTaskId set) does NOT get a duplicate generic text", async () => {
    const after = { status: "pending", clientId: CLIENT, caregiverId: CAREGIVER, clientName: "A Family", agentTaskId: "task1" };
    await (onBookingRequestWrite as any)(change(null, "br1", after), { params: { bookingId: "br1" } });
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
    expect(sendToPhone).not.toHaveBeenCalled();
  });

  it("cancelled always texts the caregiver, Evia-negotiated or not", async () => {
    const before = { status: "accepted", clientId: CLIENT, caregiverId: CAREGIVER, agentTaskId: "task1" };
    const after  = { ...before, status: "cancelled" };
    await (onBookingRequestWrite as any)(change(before, "br1", after), { params: { bookingId: "br1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: expect.stringContaining("cancelled") }));
  });

  it("a declined Evia-negotiated booking does NOT get a duplicate generic text", async () => {
    const before = { status: "pending", clientId: CLIENT, caregiverId: CAREGIVER, agentTaskId: "task1" };
    const after  = { ...before, status: "declined" };
    await (onBookingRequestWrite as any)(change(before, "br1", after), { params: { bookingId: "br1" } });
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
  });

  it("a declined pure website booking DOES text the client", async () => {
    const before = { status: "pending", clientId: CLIENT, caregiverId: CAREGIVER, caregiverName: "Alice" };
    const after  = { ...before, status: "declined" };
    await (onBookingRequestWrite as any)(change(before, "br1", after), { params: { bookingId: "br1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("Alice") }));
  });
});

describe("onBookingAmendmentWrite — SMS parity", () => {
  it("a new amendment texts the caregiver (single source of truth — request_schedule_amendment no longer sends this itself)", async () => {
    const after = { caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", newDays: { Mon: [{ start: "09:00", end: "12:00" }] }, ongoing: true };
    await (onBookingAmendmentWrite as any)(change(null, "am1", after), { params: { amendmentId: "am1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: expect.stringContaining("Mon") }));
  });

  it("accepted texts the client", async () => {
    const before = { caregiverId: CAREGIVER, clientId: CLIENT, status: "pending", newDays: { Mon: [{}] } };
    const after  = { ...before, status: "accepted", caregiverName: "Alice" };
    await (onBookingAmendmentWrite as any)(change(before, "am1", after), { params: { amendmentId: "am1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("Alice") }));
  });

  it("declined texts the client", async () => {
    const before = { caregiverId: CAREGIVER, clientId: CLIENT, status: "pending" };
    const after  = { ...before, status: "declined", caregiverName: "Alice" };
    await (onBookingAmendmentWrite as any)(change(before, "am1", after), { params: { amendmentId: "am1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("isn't able") }));
  });

  it("cancelled texts the caregiver", async () => {
    const before = { caregiverId: CAREGIVER, clientId: CLIENT, status: "pending", clientName: "A Family" };
    const after  = { ...before, status: "cancelled" };
    await (onBookingAmendmentWrite as any)(change(before, "am1", after), { params: { amendmentId: "am1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: expect.stringContaining("withdrew") }));
  });
});

describe("onShiftStatusChanged — SMS parity", () => {
  it("in-progress (shift started) texts the client — parity with onAppointmentUpdated's arrival ping", async () => {
    const before = { status: "scheduled", clientId: CLIENT, caregiverId: CAREGIVER };
    const after  = { ...before, status: "in-progress", caregiverName: "Alice" };
    await (onShiftStatusChanged as any)(change(before, "s1", after), { params: { shiftId: "s1" }, eventId: "e1" });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("arrived") }));
  });

  it("completed texts the client", async () => {
    const before = { status: "in-progress", clientId: CLIENT, caregiverId: CAREGIVER };
    const after  = { ...before, status: "completed", caregiverName: "Alice" };
    await (onShiftStatusChanged as any)(change(before, "s1", after), { params: { shiftId: "s1" }, eventId: "e1" });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("complete") }));
  });

  it("client-cancelled texts the caregiver", async () => {
    const before = { status: "scheduled", clientId: CLIENT, caregiverId: CAREGIVER };
    const after  = { ...before, status: "cancelled", clientName: "A Family" };
    await (onShiftStatusChanged as any)(change(before, "s1", after), { params: { shiftId: "s1" }, eventId: "e1" });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: expect.stringContaining("cancelled") }));
  });

  it("caregiver-cancelled does NOT text the client here — onShiftUpdated's replacement flow owns that message", async () => {
    const before = { status: "scheduled", clientId: CLIENT, caregiverId: CAREGIVER };
    const after  = { ...before, status: "cancelled", cancelledBy: "caregiver" };
    await (onShiftStatusChanged as any)(change(before, "s1", after), { params: { shiftId: "s1" }, eventId: "e1" });
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
  });

  it("a bulk-cancelled shift (whole-booking cancel) sends no per-shift text — onBookingRequestWrite already sent one consolidated text", async () => {
    const before = { status: "scheduled", clientId: CLIENT, caregiverId: CAREGIVER };
    const after  = { ...before, status: "cancelled", bulkCancelled: true };
    await (onShiftStatusChanged as any)(change(before, "s1", after), { params: { shiftId: "s1" }, eventId: "e1" });
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
  });
});

describe("onJobApplicationCreate — SMS parity", () => {
  it("texts the client (single source of truth — apply_to_job no longer sends this itself)", async () => {
    const data = { clientId: CLIENT, caregiverName: "Alice", jobTitle: "Weekend care" };
    await (onJobApplicationCreate as any)({ data: () => data }, { params: { applicationId: "app1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("applied") }));
  });
});

describe("onVideoInterviewWrite — SMS parity", () => {
  it("a new interview request texts the caregiver", async () => {
    const after = { status: "requested", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", scheduledTime: new Date().toISOString() };
    await (onVideoInterviewWrite as any)(change(null, "iv1", after), { params: { interviewId: "iv1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: expect.stringContaining("interview") }));
  });
});
