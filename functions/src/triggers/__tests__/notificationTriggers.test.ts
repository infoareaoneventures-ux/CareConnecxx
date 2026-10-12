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
    // The session stamp (a parked decision) and the expiry clear write here.
    set: async (data: any, opts?: any) => { docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data); },
    update: async (data: any) => {
      const next = { ...(docState.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) { if ((v as any)?.__delete) delete next[k]; else next[k] = v; }
      docState.set(path, next);
    },
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
    FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }), delete: () => ({ __delete: true }) },
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

// The caregiver's phone for the expiry clear (B6) — users/{uid}.phone, as resolveCaregiverPhone reads it.
vi.mock("../../utils/caregiverPhone", () => ({ resolveCaregiverPhone: vi.fn(async (id: string) => (id === "cg1" ? "+15550001111" : undefined)) }));
// Decision notices: the real park shape (asserted below), the expiry take-down spied.
const expireParkedDecision = vi.fn(async (..._a: any[]) => ({ wasParked: true }));
vi.mock("../../agents/decisionNotices", () => ({
  parkDecision: (pd: any) => ({ pendingDecision: pd }),
  parkedDecision: (kind: string, recordId: string, label: string, role: string, _now?: number, party?: string) => ({ kind, recordId, label, role, ...(party ? { party } : {}), options: kind === "shift_proposal" ? ["ACCEPT", "DECLINE", "PROPOSE"] : ["ACCEPT", "DECLINE"] }),
  expireParkedDecision: (...a: any[]) => expireParkedDecision(...a),
}));

import {
  onBookingRequestWrite,
  onBookingAmendmentWrite,
  onShiftStatusChanged,
  onJobApplicationCreate,
  onJobApplicationStatusChange,
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
  expireParkedDecision.mockClear();
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
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("started the visit") }));
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

  it("a visit closed out because a REPLACEMENT was accepted (supersededByBookingId) sends nothing — the family already heard the new caregiver accepted (live 2026-09-28)", async () => {
    const before = { status: "needs_replacement", clientId: CLIENT, caregiverId: CAREGIVER, caregiverName: "Alice" };
    const after  = { ...before, status: "cancelled", cancelledBy: "caregiver", supersededByBookingId: "br-repl" };
    await (onShiftStatusChanged as any)(change(before, "s1", after), { params: { shiftId: "s1" }, eventId: "e1" });
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
  });

  it("the family SKIPS a Needs Replacement visit (the caregiver had cancelled it) → nobody is texted (live 2026-10-07: the caregiver was told the family cancelled his own cancellation)", async () => {
    const before = { status: "needs_replacement", clientId: CLIENT, caregiverId: CAREGIVER, caregiverName: "Alice", cancelledBy: "caregiver" };
    const after  = { ...before, status: "cancelled", cancelledBy: "client" };
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
  it("texts the client (single source of truth — the Apply flow never sends this itself)", async () => {
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

describe("onJobApplicationStatusChange — the caregiver hears the outcome (bell + text, no details)", () => {
  const base = { caregiverId: CAREGIVER, clientId: CLIENT, jobId: "job1", jobTitle: "Weekend care" };
  it("declined by the family → bell + text with the tab's words", async () => {
    await (onJobApplicationStatusChange as any)(change({ ...base, status: "pending" }, "app1", { ...base, status: "rejected" }), { params: { applicationId: "app1" } });
    expect(writeUserNotification).toHaveBeenCalledWith(expect.objectContaining({ recipientId: CAREGIVER, type: "job_application_declined", title: "Application declined", body: 'Your application for "Weekend care" was declined by the family.' }));
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: 'Your application for "Weekend care" was declined by the family.', urgency: "immediate" }));
  });
  it("accepted (the family sent a booking) → bell + text", async () => {
    await (onJobApplicationStatusChange as any)(change({ ...base, status: "pending" }, "app1", { ...base, status: "accepted" }), { params: { applicationId: "app1" } });
    expect(writeUserNotification).toHaveBeenCalledWith(expect.objectContaining({ recipientId: CAREGIVER, type: "job_application_accepted", title: "Application accepted" }));
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: 'Your application for "Weekend care" was accepted.' }));
  });
  it("the caregiver's own withdraw, and a write with no status change, are silent", async () => {
    await (onJobApplicationStatusChange as any)(change({ ...base, status: "pending" }, "app1", { ...base, status: "withdrawn" }), { params: { applicationId: "app1" } });
    await (onJobApplicationStatusChange as any)(change({ ...base, status: "rejected" }, "app1", { ...base, status: "rejected", updatedAt: 1 }), { params: { applicationId: "app1" } });
    expect(writeUserNotification).not.toHaveBeenCalled();
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
  });
});

describe("onVideoInterviewWrite — SMS parity", () => {
  it("a new interview request texts the caregiver the card's details — job, time, type and the family's note", async () => {
    const after = { status: "requested", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", scheduledTime: new Date().toISOString(), jobTitle: "Senior care in San Jose", interviewType: "video", notes: "requesting interview" };
    await (onVideoInterviewWrite as any)(change(null, "iv1", after), { params: { interviewId: "iv1" } });
    const call = sendViaInteractionAgent.mock.calls.find((c) => c[0] === "+15550001111")!;
    const content = (call[1] as any).content as string;
    expect(content).toContain('A Family requested an interview with you for "Senior care in San Jose" on');
    expect(content).toContain("(Video). Note: \"requesting interview\"");
    expect(content).toContain("Reply ACCEPT or DECLINE, or PROPOSE a different time.");
    // The bell carries the same details.
    expect(writeUserNotification).toHaveBeenCalledWith(expect.objectContaining({ recipientId: CAREGIVER, type: "interview_request", body: expect.stringContaining('Note: "requesting interview"') }));
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

    it("a plain accept writes the family's bell but sends NO text here — the confirmed-time + Meet link message (interviewLinkTrigger) is the one text (2026-09-23: it used to arrive two or three times)", async () => {
      const before = { status: "requested", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", caregiverName: "Alice", scheduledTime: "2026-09-10T17:00:00.000Z" };
      const after  = { ...before, status: "accepted" };
      await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" } });
      expect(sendViaInteractionAgent).not.toHaveBeenCalledWith("+15550002222", expect.anything());
      expect(sendViaInteractionAgent).not.toHaveBeenCalledWith("+15550001111", expect.anything());
      // The reschedule branch must not misfire on a plain accept.
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

    // Keep current time (caregiver sweep B5, 2026-10-11): the proposal cleared,
    // status and scheduledTime untouched — the write both Interviews tabs, Evia's
    // KEEP reply and the tool's action:"keep" produce (agents/interviewProposal.ts).
    // The proposer gets ONE bell + ONE text here; nothing else texts for it.
    describe("Keep current time — the proposal cleared, same status, same time → the proposer is told once", () => {
      const keep = (doc: any) => { const { reschedulePendingTime: _p, rescheduledBy: _b, rescheduledViaAgent: _v, ...rest } = doc; return rest; };

      it("the family keeps the time against the caregiver's proposal → the caregiver's bell + text, nothing to the family", async () => {
        const before = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", caregiverName: "Alice", scheduledTime: "2026-09-10T17:00:00.000Z", rescheduledBy: "caregiver", reschedulePendingTime: "2026-09-14T18:00:00.000Z", rescheduledViaAgent: true };
        await (onVideoInterviewWrite as any)(change(before, "iv1", keep(before)), { params: { interviewId: "iv1" } });
        const line = "A Family isn't able to move the interview — it's staying at Thu, Sep 10, 10:00 AM.";
        expect(sendViaInteractionAgent).toHaveBeenCalledTimes(1);
        expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: line }));
        expect(writeUserNotification).toHaveBeenCalledTimes(1);
        expect(writeUserNotification).toHaveBeenCalledWith(expect.objectContaining({ recipientId: CAREGIVER, type: "interview_rescheduled", title: "Time Change Declined", body: line }));
        expect(sendToPhone).not.toHaveBeenCalled();
      });

      it("the caregiver keeps the time against the family's proposal → the family's bell + text, nothing to the caregiver", async () => {
        const before = { status: "requested", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", caregiverName: "Alice", scheduledTime: "2026-09-10T17:00:00.000Z", rescheduledBy: "client", reschedulePendingTime: "2026-09-14T18:00:00.000Z" };
        await (onVideoInterviewWrite as any)(change(before, "iv1", keep(before)), { params: { interviewId: "iv1" } });
        const line = "Alice isn't able to move the interview — it's staying at Thu, Sep 10, 10:00 AM.";
        expect(sendViaInteractionAgent).toHaveBeenCalledTimes(1);
        expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: line }));
        expect(writeUserNotification).toHaveBeenCalledWith(expect.objectContaining({ recipientId: CLIENT, type: "interview_rescheduled", title: "Time Change Declined", body: line }));
        // Not the accept branch, not the proposal branch.
        expect(sendViaInteractionAgent).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ content: expect.stringContaining("confirmed the new interview time") }));
        expect(sendViaInteractionAgent).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ content: expect.stringContaining("proposed a new interview time") }));
      });

      it("the proposal notices name KEEP and park CONFIRM / KEEP / PROPOSE with the other side's name", async () => {
        const before = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", caregiverName: "Alice", scheduledTime: "2026-09-10T17:00:00.000Z" };
        await (onVideoInterviewWrite as any)(change(before, "iv1", { ...before, rescheduledBy: "client", reschedulePendingTime: "2026-09-14T18:00:00.000Z" }), { params: { interviewId: "iv1" } });
        expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: expect.stringContaining("Reply CONFIRM, KEEP to keep the current time, or PROPOSE another time.") }));
        expect(hoisted.docState.get("agent_sessions/+15550001111").pendingDecision).toMatchObject({ kind: "interview_proposal", recordId: "iv1", role: "caregiver", party: "A Family" });
        sendViaInteractionAgent.mockClear();
        await (onVideoInterviewWrite as any)(change(before, "iv1", { ...before, rescheduledBy: "caregiver", reschedulePendingTime: "2026-09-14T18:00:00.000Z" }), { params: { interviewId: "iv1" } });
        expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringContaining("Reply CONFIRM, KEEP to keep the current time, or suggest another time.") }));
        expect(hoisted.docState.get("agent_sessions/+15550002222").pendingDecision).toMatchObject({ kind: "interview_proposal", recordId: "iv1", role: "client", party: "Alice" });
      });

      it("a proposal written by Evia's reschedule_interview tool (rescheduledViaAgent) sends no second text but STILL parks the reply + noticed record on the recipient's session (2026-10-11)", async () => {
        const before = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", caregiverName: "Alice", scheduledTime: "2026-09-10T17:00:00.000Z" };
        await (onVideoInterviewWrite as any)(change(before, "iv1", { ...before, rescheduledBy: "client", reschedulePendingTime: "2026-09-14T18:00:00.000Z", rescheduledViaAgent: true }), { params: { interviewId: "iv1" } });
        expect(sendViaInteractionAgent).not.toHaveBeenCalled(); // the tool already texted the same sentence
        expect(writeUserNotification).toHaveBeenCalledWith(expect.objectContaining({ recipientId: CAREGIVER, type: "interview_rescheduled" })); // the bell still belongs beside it
        const sess = hoisted.docState.get("agent_sessions/+15550001111");
        expect(sess.pendingDecision).toMatchObject({ kind: "interview_proposal", recordId: "iv1", role: "caregiver", party: "A Family" });
        expect(sess.lastNoticedInterviewId).toBe("iv1");
      });
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

// ── Caregiver sweep B1 / B5 / B6 (2026-10-11) ────────────────────────────────
describe("B1 — the family's proposed visit time parks the strip's reply words on the caregiver", () => {
  it("names the visit and the proposed time, offers ACCEPT / DECLINE / PROPOSE, parks shift_proposal + lastNoticedShiftId; the bell follows the text", async () => {
    const before = { status: "scheduled", clientId: CLIENT, caregiverId: CAREGIVER, clientName: "The Nguyen Family", date: "2099-10-05", startTime: "11:00", endTime: "14:00" };
    const after  = { ...before, reschedulePendingDate: "2099-10-06", reschedulePendingStartTime: "12:00", reschedulePendingEndTime: "15:00", rescheduledBy: "client" };
    await (onShiftStatusChanged as any)(change(before, "s1", after), { params: { shiftId: "s1" }, eventId: "e1" });
    const call = sendViaInteractionAgent.mock.calls.find((c) => c[0] === "+15550001111");
    expect(call?.[1].content).toBe("The Nguyen Family proposed moving your visit on Mon, Oct 5, 11:00 AM–2:00 PM to Tue, Oct 6, 12:00 PM–3:00 PM. Reply ACCEPT or DECLINE, or PROPOSE a different time.");
    const sess = hoisted.docState.get("agent_sessions/+15550001111");
    expect(sess.lastNoticedShiftId).toBe("s1");
    expect(sess.pendingDecision).toMatchObject({ kind: "shift_proposal", recordId: "s1", role: "caregiver", party: "The Nguyen Family", options: ["ACCEPT", "DECLINE", "PROPOSE"] });
    expect(writeUserNotification).toHaveBeenCalledWith(expect.objectContaining({ recipientId: CAREGIVER, type: "shift_rescheduled", title: "New Time Proposed", data: { shiftId: "s1" } }));
    expect(sendViaInteractionAgent).not.toHaveBeenCalledWith("+15550002222", expect.anything());
  });
});

describe("B5 — an interview proposal declined/withdrawn outright (same status, same scheduledTime) tells whoever proposed it", () => {
  const kept = "2099-09-10T17:00:00.000Z";
  it("the family clears the caregiver's proposal → the caregiver is told the time stands (bell + text, Jobs › Interviews)", async () => {
    const before = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "The Nguyen Family", scheduledTime: kept, rescheduledBy: "caregiver", reschedulePendingTime: "2099-09-14T18:00:00.000Z" };
    const after  = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "The Nguyen Family", scheduledTime: kept };
    await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" }, eventId: "e1" });
    const call = sendViaInteractionAgent.mock.calls.find((c) => c[0] === "+15550001111");
    expect(call?.[1].content).toMatch(/^The Nguyen Family isn't able to move the interview — it's staying at Thu, Sep 10, 10:00 AM\.$/);
    expect(writeUserNotification).toHaveBeenCalledWith(expect.objectContaining({ recipientId: CAREGIVER, type: "interview_rescheduled", title: "Time Change Declined", body: call?.[1].content, transitionType: "interview_time_declined:2099-09-14T18:00:00.000Z" }));
    expect(sendViaInteractionAgent).not.toHaveBeenCalledWith("+15550002222", expect.anything());
  });
  it("the mirror: the caregiver clears the family's proposal → the family is told", async () => {
    const before = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, caregiverName: "Alice", scheduledTime: kept, rescheduledBy: "client", reschedulePendingTime: "2099-09-14T18:00:00.000Z" };
    const after  = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, caregiverName: "Alice", scheduledTime: kept };
    await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" }, eventId: "e1" });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: expect.stringMatching(/^Alice isn't able to move the interview — it's staying at /) }));
    expect(writeUserNotification).toHaveBeenCalledWith(expect.objectContaining({ recipientId: CLIENT, type: "interview_rescheduled", title: "Time Change Declined" }));
    expect(sendViaInteractionAgent).not.toHaveBeenCalledWith("+15550001111", expect.anything());
  });
  it("does NOT fire when the proposal clears as part of a decline / cancel / complete of the whole interview (those branches own that)", async () => {
    const before = { status: "accepted", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", scheduledTime: kept, rescheduledBy: "caregiver", reschedulePendingTime: "2099-09-14T18:00:00.000Z" };
    const after  = { status: "cancelled", cancelledBy: "client", caregiverId: CAREGIVER, clientId: CLIENT, clientName: "A Family", scheduledTime: kept };
    await (onVideoInterviewWrite as any)(change(before, "iv1", after), { params: { interviewId: "iv1" }, eventId: "e1" });
    expect(sendViaInteractionAgent).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ content: expect.stringContaining("move the interview") }));
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: expect.stringContaining("cancelled") }));
  });
});

describe("B6 — a replacement request that expired (30 minutes, nobody answered)", () => {
  const rep = { isShiftReplacement: true, replacementForShiftId: "shift-9", caregiverId: CAREGIVER, caregiverName: "Alice", clientId: CLIENT, clientName: "The Nguyen Family", schedule: { startDate: "2099-10-06", dayShiftTimes: { Tue: [{ start: "12:00", end: "15:00" }] } } };
  it("the caregiver gets ONE factual sentence (text, then the bell) and her parked ACCEPT is taken down with the expired line", async () => {
    await (onBookingRequestWrite as any)(change({ ...rep, status: "pending" }, "rep1", { ...rep, status: "expired" }), { params: { bookingId: "rep1" }, eventId: "e1" });
    const line = "The Nguyen Family's replacement request for the visit on October 6, 2099 at 12:00 PM has expired — no reply came in time, so nothing was sent.";
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: line, urgency: "immediate", canDrop: false }));
    expect(writeUserNotification).toHaveBeenCalledWith(expect.objectContaining({ recipientId: CAREGIVER, type: "booking_request_expired", title: "Replacement Request Expired", body: line, data: { bookingId: "rep1" }, transitionType: "booking_request_expired" }));
    expect(expireParkedDecision).toHaveBeenCalledWith("+15550001111", "rep1", { kind: "booking_request", line: "The Nguyen Family's replacement request has expired — nothing was sent." });
    // The park comes down before the text (the record IS expired, whatever the send does).
    expect(expireParkedDecision.mock.invocationCallOrder[0]).toBeLessThan(sendViaInteractionAgent.mock.invocationCallOrder[0]);
  });
  it("the family hears it as it happens — find another replacement or skip — routed to the visit", async () => {
    await (onBookingRequestWrite as any)(change({ ...rep, status: "pending" }, "rep1", { ...rep, status: "expired" }), { params: { bookingId: "rep1" }, eventId: "e1" });
    const line = "Alice didn't respond to the replacement request on October 6, 2099 at 12:00 PM in time — find another replacement or skip that visit.";
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550002222", expect.objectContaining({ content: line }));
    expect(writeUserNotification).toHaveBeenCalledWith(expect.objectContaining({ recipientId: CLIENT, type: "booking_request_expired", body: line, data: { bookingId: "rep1", shiftId: "shift-9" } }));
  });
  it("a plain (non-replacement) request never expires through this branch, and a dropped text writes no bell", async () => {
    await (onBookingRequestWrite as any)(change({ caregiverId: CAREGIVER, clientId: CLIENT, status: "pending" }, "br1", { caregiverId: CAREGIVER, clientId: CLIENT, status: "expired" }), { params: { bookingId: "br1" }, eventId: "e1" });
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
    expect(expireParkedDecision).not.toHaveBeenCalled();
    sendViaInteractionAgent.mockResolvedValueOnce(false);
    await (onBookingRequestWrite as any)(change({ ...rep, clientId: undefined, status: "pending" }, "rep2", { ...rep, clientId: undefined, status: "expired" }), { params: { bookingId: "rep2" }, eventId: "e2" });
    expect(writeUserNotification).not.toHaveBeenCalled();
  });
  it("the replacement notice itself tells the caregiver the 30-minute clock", async () => {
    await (onBookingRequestWrite as any)(change(null, "rep1", { ...rep, status: "pending" }), { params: { bookingId: "rep1" }, eventId: "e1" });
    const call = sendViaInteractionAgent.mock.calls.find((c) => c[0] === "+15550001111");
    expect(call?.[1].content.endsWith("Reply ACCEPT or DECLINE. This request expires in 30 minutes.")).toBe(true);
  });
});
