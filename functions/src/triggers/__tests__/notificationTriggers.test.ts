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
  // sendTransactionalText (2026-09-06 fix, second pass) only calls
  // sendViaInteractionAgent when an agent_sessions doc exists for the phone —
  // seed both by default so the existing assertions below (which all expect
  // the interaction-agent path) keep exercising that path; the no-session
  // fallback is covered separately below.
  hoisted.docState.set("agent_sessions/+15550001111", { userId: CAREGIVER });
  hoisted.docState.set("agent_sessions/+15550002222", { userId: CLIENT });
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

  // Live-caught 2026-09-14: a website-button accept wrote the in-app bell
  // (onBookingAccepted) but no text ever reached the family's phone.
  it("a website-button accept (no agentTaskId) texts the client", async () => {
    const before = { status: "pending", clientId: CLIENT, caregiverId: CAREGIVER, caregiverName: "Alice" };
    const after  = { ...before, status: "accepted" };
    await (onBookingRequestWrite as any)(change(before, "br1", after), { params: { bookingId: "br1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("Alice accepted") }));
  });

  it("an Evia-negotiated accept (agentTaskId set) does NOT double-text — shiftOffer.ts already did", async () => {
    const before = { status: "pending", clientId: CLIENT, caregiverId: CAREGIVER, caregiverName: "Alice", agentTaskId: "task1" };
    const after  = { ...before, status: "accepted" };
    await (onBookingRequestWrite as any)(change(before, "br1", after), { params: { bookingId: "br1" } });
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

  // 2026-09-16: the site's Resend updates the existing doc (cancelled/declined
  // → pending, isResend) — the caregiver was never told before this branch.
  it("a resent request (cancelled → pending, isResend) texts the caregiver", async () => {
    const before = { status: "cancelled", clientId: CLIENT, caregiverId: CAREGIVER, clientName: "A Family" };
    const after  = { ...before, status: "pending", isResend: true };
    await (onBookingRequestWrite as any)(change(before, "br1", after), { params: { bookingId: "br1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: expect.stringContaining("resent their booking request") }));
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

  it("caregiver-cancelled (no urgency, > 24h out) texts the client a plain heads-up", async () => {
    const before = { status: "scheduled", clientId: CLIENT, caregiverId: CAREGIVER };
    const after  = { ...before, status: "cancelled", cancelledBy: "caregiver", caregiverName: "Alice" };
    await (onShiftStatusChanged as any)(change(before, "s1", after), { params: { shiftId: "s1" }, eventId: "e1" });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("cancelled") }));
  });

  it("needs_replacement (caregiver cancelled within 24h) texts the client pointing at the replacement flow", async () => {
    const before = { status: "scheduled", clientId: CLIENT, caregiverId: CAREGIVER };
    const after  = { ...before, status: "needs_replacement", caregiverName: "Alice" };
    await (onShiftStatusChanged as any)(change(before, "s1", after), { params: { shiftId: "s1" }, eventId: "e1" });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("replacement") }));
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

  // 2026-09-06 fix: this text used to go out at urgency:'standard', which
  // routes through shouldSend's LLM "is now a good time?" gate and fails
  // CLOSED (silently drops, no retry) on any timeout/error — confirmed live,
  // the notification never arrived for a real applicant. 'immediate'
  // bypasses that gate and the daily proactive cap so this transactional,
  // one-time notification can never be silently lost.
  it("sends at urgency 'immediate' so the notification can never be silently dropped", async () => {
    const data = { clientId: CLIENT, caregiverName: "Alice", jobTitle: "Weekend care" };
    await (onJobApplicationCreate as any)({ data: () => data }, { params: { applicationId: "app1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ urgency: "immediate" }));
  });
});

describe("onVideoInterviewWrite — SMS parity", () => {
  it("a new interview request texts the caregiver", async () => {
    const after = { status: "requested", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", scheduledTime: new Date().toISOString() };
    await (onVideoInterviewWrite as any)(change(null, "iv1", after), { params: { interviewId: "iv1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: expect.stringContaining("interview") }));
  });

  it("a website-cancelled interview (no cancelledViaAgent marker) texts the caregiver", async () => {
    const before = { status: "confirmed", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family" };
    const after  = { ...before, status: "cancelled", cancelledBy: "client" };
    await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({
      content: expect.stringContaining("cancelled"),
      // 2026-09-06 fix: same silent-drop risk as the job-application text —
      // 'immediate' guarantees this transactional notification is never
      // dropped by shouldSend's LLM judgment gate or the daily proactive cap.
      urgency: "immediate",
    }));
  });

  it("an Evia-cancelled interview (cancelledViaAgent set by cancel_interview) does NOT get a duplicate text", async () => {
    const before = { status: "confirmed", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family" };
    const after  = { ...before, status: "cancelled", cancelledBy: "client", cancelledViaAgent: true };
    await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
  });

  it("a website-cancelled interview, caregiver-cancelled direction, texts the client", async () => {
    const before = { status: "confirmed", caregiverId: CAREGIVER, clientId: CLIENT, caregiverName: "Alice" };
    const after  = { ...before, status: "cancelled", cancelledBy: "caregiver" };
    await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("Alice") }));
  });

  // 2026-09-06 fix: a website-button decline used to leave the client with
  // only an in-app bell notification — no text at all, unlike accept
  // (interviewLinkTrigger) and cancel (above).
  it("a website-declined interview (no respondedViaAgent marker) texts the client", async () => {
    const before = { status: "requested", caregiverId: CAREGIVER, clientId: CLIENT, caregiverName: "Alice" };
    const after  = { ...before, status: "declined" };
    await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("Alice") }));
  });

  it("an Evia-declined interview (respondedViaAgent set by respond_to_interview_request) does NOT get a duplicate text", async () => {
    const before = { status: "requested", caregiverId: CAREGIVER, clientId: CLIENT, caregiverName: "Alice" };
    const after  = { ...before, status: "declined", respondedViaAgent: true };
    await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
  });

  // 2026-09-06 fix: a client 'not selected' decision (website button or
  // Evia's submit_interview_feedback fitLevel:'no') used to leave the
  // caregiver with only an in-app bell notification — no text, unlike the
  // 'strong' path which already texts the caregiver directly.
  it("a client 'not selected' decline texts the caregiver, not the client", async () => {
    const before = { status: "completed", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family" };
    const after  = { ...before, status: "declined", declinedBy: "client" };
    await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: expect.stringContaining("A Family") }));
    expect(sendViaInteractionAgent).not.toHaveBeenCalledWith("+15550002222", expect.anything());
  });

  // 2026-09-09 (new site feature, redesigned mid-session after a live-caught
  // bug): the Reschedule/Propose new time actions on both PostsPage.tsx and
  // JobBoard.tsx write a PROPOSAL (reschedulePendingTime) — the real
  // scheduledTime/status are deliberately left untouched until the other
  // party actually accepts, so the confirmed meeting (and Decline/Cancel on
  // it) never changes just from someone proposing a new time.
  describe("reschedule proposed — same interview, notifies the OTHER party, confirmed time untouched", () => {
    it("the caregiver proposing a new time on an accepted interview texts the client, without changing scheduledTime/status", async () => {
      const before = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, caregiverName: "Alice", scheduledTime: "2026-09-10T17:00:00.000Z" };
      const after  = { ...before, rescheduledBy: "caregiver", reschedulePendingTime: "2026-09-14T18:00:00.000Z" };
      await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
      expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("Alice") }));
      expect(sendViaInteractionAgent).not.toHaveBeenCalledWith("+15550001111", expect.anything());
    });

    it("the client proposing a new time on an accepted interview texts the caregiver, without changing scheduledTime/status", async () => {
      const before = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", scheduledTime: "2026-09-10T17:00:00.000Z" };
      const after  = { ...before, rescheduledBy: "client", reschedulePendingTime: "2026-09-14T18:00:00.000Z" };
      await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
      expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: expect.stringContaining("A Family") }));
      expect(sendViaInteractionAgent).not.toHaveBeenCalledWith("+15550002222", expect.anything());
    });

    it("still fires on a still-pending (requested) interview — proposals aren't limited to accepted ones", async () => {
      const before = { status: "requested", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", scheduledTime: "2026-09-10T17:00:00.000Z" };
      const after  = { ...before, rescheduledBy: "client", reschedulePendingTime: "2026-09-14T18:00:00.000Z" };
      await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
      expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: expect.stringContaining("A Family") }));
    });

    it("fires again when an already-pending proposal is CHANGED to a different time", async () => {
      const before = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, caregiverName: "Alice", scheduledTime: "2026-09-10T17:00:00.000Z", rescheduledBy: "caregiver", reschedulePendingTime: "2026-09-14T18:00:00.000Z" };
      const after  = { ...before, reschedulePendingTime: "2026-09-15T19:00:00.000Z" };
      await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
      expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("Alice") }));
    });

    it("does NOT fire when nothing about the proposal changed (an unrelated field update)", async () => {
      const before = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, scheduledTime: "2026-09-10T17:00:00.000Z", rescheduledBy: "caregiver", reschedulePendingTime: "2026-09-14T18:00:00.000Z" };
      const after  = { ...before, notes: "updated notes" };
      await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
      expect(sendViaInteractionAgent).not.toHaveBeenCalled();
    });

    it("does NOT fire on a plain accept with no reschedule proposal involved", async () => {
      const before = { status: "requested", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", scheduledTime: "2026-09-10T17:00:00.000Z" };
      const after  = { ...before, status: "accepted" };
      await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
      // The existing "accepted → notify client" branch only ever writes an
      // in-app notification (no text) — so no text firing at all confirms
      // the new reschedule branch didn't misfire here.
      expect(sendViaInteractionAgent).not.toHaveBeenCalled();
      expect(sendToPhone).not.toHaveBeenCalled();
    });
  });

  describe("reschedule ACCEPTED — the real scheduledTime finally moves, notifies whoever originally proposed it", () => {
    it("the family accepting the caregiver's proposed time texts the caregiver back", async () => {
      const before = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", scheduledTime: "2026-09-10T17:00:00.000Z", rescheduledBy: "caregiver", reschedulePendingTime: "2026-09-14T18:00:00.000Z" };
      const after  = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", scheduledTime: "2026-09-14T18:00:00.000Z" };
      await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
      expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: expect.stringContaining("A Family") }));
      expect(sendViaInteractionAgent).not.toHaveBeenCalledWith("+15550002222", expect.anything());
    });

    it("the caregiver accepting the family's proposed time texts the client back", async () => {
      const before = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, caregiverName: "Alice", scheduledTime: "2026-09-10T17:00:00.000Z", rescheduledBy: "client", reschedulePendingTime: "2026-09-14T18:00:00.000Z" };
      const after  = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, caregiverName: "Alice", scheduledTime: "2026-09-14T18:00:00.000Z" };
      await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
      expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("Alice") }));
      expect(sendViaInteractionAgent).not.toHaveBeenCalledWith("+15550001111", expect.anything());
    });

    it("does NOT fire when declining clears the proposal instead of accepting it (scheduledTime never changed)", async () => {
      const before = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, scheduledTime: "2026-09-10T17:00:00.000Z", rescheduledBy: "caregiver", reschedulePendingTime: "2026-09-14T18:00:00.000Z" };
      const after  = { status: "declined", caregiverId: CAREGIVER, clientId: CLIENT, scheduledTime: "2026-09-10T17:00:00.000Z" };
      await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
      // Falls through to the existing decline-direction branch instead — not
      // a reschedule-accepted event, since scheduledTime never moved.
      expect(sendViaInteractionAgent).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ content: expect.stringContaining("confirmed the new interview time") }));
    });
  });
});

describe("sendTransactionalText — reliability fix (2026-09-06, second pass)", () => {
  // Live bug: a client requested an interview from the site and the
  // caregiver never got a text through Evia. Root cause: canDrop:true still
  // ran the send through shouldSend's judgment gate, AND sendViaInteractionAgent
  // resolves false (rather than rejecting) for a missing agent_sessions doc —
  // exactly the case for a caregiver who has never texted Evia — so the old
  // `.catch(() => sendToPhone(...))` fallback never fired.

  it("a new interview request uses canDrop:false so shouldSend's judgment gate can never suppress it", async () => {
    const after = { status: "requested", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", scheduledTime: new Date().toISOString() };
    await (onVideoInterviewWrite as any)(change(null, "iv1", after), { params: { interviewId: "iv1" } });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ canDrop: false, urgency: "immediate" }));
  });

  it("falls back to a plain text when the caregiver has no agent_sessions doc yet (never texted Evia)", async () => {
    hoisted.docState.delete("agent_sessions/+15550001111");
    const after = { status: "requested", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", scheduledTime: new Date().toISOString() };
    await (onVideoInterviewWrite as any)(change(null, "iv1", after), { params: { interviewId: "iv1" } });
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
    expect(sendToPhone).toHaveBeenCalledWith("+15550001111", expect.stringContaining("interview"));
  });

  it("falls back to a plain text for a session-less client too", async () => {
    hoisted.docState.delete("agent_sessions/+15550002222");
    const data = { clientId: CLIENT, caregiverName: "Alice", jobTitle: "Weekend care" };
    await (onJobApplicationCreate as any)({ data: () => data }, { params: { applicationId: "app1" } });
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
    expect(sendToPhone).toHaveBeenCalledWith("+15550002222", expect.stringContaining("applied"));
  });
});
