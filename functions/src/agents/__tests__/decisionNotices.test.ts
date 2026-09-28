import { describe, it, expect, vi, beforeEach } from "vitest";

// Decision notices → deterministic replies (decisionNotices.ts): the notice parks
// the expected decision; the reply is matched before the agent and runs the
// page's own write.

const hoisted = vi.hoisted(() => ({
  sent: [] as string[],
  sessionUpdates: [] as any[],
  sessionSets: [] as any[],
  quick: vi.fn(async (_p: string, t: string) => (/confirm|sounds good|yes/i.test(t) ? "CONFIRM" : /can'?t|pass/i.test(t) ? "DECLINE" : "OTHER")),
  respondInterview: vi.fn(async () => ({ status: "accepted", interviewId: "iv1", callUrl: null })),
  respondBooking: vi.fn(async (_c: string, _id: string, d: string) => ({ ok: true, status: d === "accept" ? "accepted" : "declined", toast: d === "accept" ? "Booking request accepted!" : "Request declined", clientName: "Fam" })),
  acceptAmendment: vi.fn(async () => ({ ok: true, status: "accepted", shiftsCreated: 2, toast: "Schedule updated — new visits added." })),
  declineAmendment: vi.fn(async () => ({ ok: true, status: "declined", shiftsCreated: 0, toast: "Declined." })),
  loadBookingRequestFor: vi.fn(async () => ({ ok: true, req: { id: "br1", clientName: "Fam", status: "pending", schedule: {}, careRecipients: [] } })),
  startApply: vi.fn(async () => ({ started: true })),
  startReschedule: vi.fn(async () => ({ started: true })),
  sendJobDetails: vi.fn(async () => ({ sent: true, ok: true })),
  handleToolCall: vi.fn(async () => ({ success: true })),
  access: { ok: true } as any,
  gateTexts: [] as string[],
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: () => ({ doc: (id: string) => ({
      update: vi.fn(async (d: any) => { hoisted.sessionUpdates.push({ id, d }); }),
      set: vi.fn(async (d: any) => { hoisted.sessionSets.push({ id, d }); }),
    }) }),
  }), { FieldValue: { delete: () => "__delete__", serverTimestamp: () => "__ts__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => (hoisted.quick as any)(...a) }));
vi.mock("../interviewResponse", () => ({ respondToInterviewRequest: (...a: any[]) => (hoisted.respondInterview as any)(...a), InterviewResponseError: class extends Error {} }));
vi.mock("../caregiverBookingRequests", () => ({
  respondToBookingRequest: (...a: any[]) => (hoisted.respondBooking as any)(...a),
  acceptAmendment: (...a: any[]) => (hoisted.acceptAmendment as any)(...a),
  declineAmendment: (...a: any[]) => (hoisted.declineAmendment as any)(...a),
  loadBookingRequestFor: (...a: any[]) => (hoisted.loadBookingRequestFor as any)(...a),
  requestListText: () => ({ text: "Booking requests:\n\n1. Fam", shown: [], remaining: 0 }),
}));
vi.mock("../caregiverJobFlows", () => ({ startApplyFlow: (...a: any[]) => (hoisted.startApply as any)(...a), startInterviewRescheduleFlow: (...a: any[]) => (hoisted.startReschedule as any)(...a) }));
vi.mock("../jobBoardText", () => ({ sendJobDetails: (...a: any[]) => (hoisted.sendJobDetails as any)(...a) }));
vi.mock("../../mcp/server", () => ({ handleToolCall: (...a: any[]) => (hoisted.handleToolCall as any)(...a) }));
vi.mock("../caregiverAccessGate", () => ({
  checkCaregiverAccess: vi.fn(async () => hoisted.access),
  textCaregiverGateBlock: vi.fn(async (_p: string, _c: string, reason: string) => { hoisted.gateTexts.push(reason); }),
}));

import { matchDecisionWord, parkedDecision, handlePendingDecisionReply, isExpired, OPTIONS, DECISION_TTL_MS } from "../decisionNotices";

const session = (pd: any, extra: Record<string, unknown> = {}) => ({ caregiverId: "cg1", userId: "u1", chatId: "chat", pendingDecision: pd, ...extra }) as any;

beforeEach(() => {
  hoisted.sent.length = 0; hoisted.sessionUpdates.length = 0; hoisted.sessionSets.length = 0; hoisted.gateTexts.length = 0;
  hoisted.access = { ok: true };
  for (const f of [hoisted.quick, hoisted.respondInterview, hoisted.respondBooking, hoisted.acceptAmendment, hoisted.declineAmendment, hoisted.startApply, hoisted.startReschedule, hoisted.sendJobDetails, hoisted.handleToolCall]) f.mockClear();
});

describe("matching — the exact words the notice asked for, no LLM", () => {
  it("matches the offered word alone; a bare yes/no only where YES/NO were offered", () => {
    expect(matchDecisionWord("Accept!", OPTIONS.interview_request)).toBe("ACCEPT");
    expect(matchDecisionWord(" decline ", OPTIONS.booking_request)).toBe("DECLINE");
    expect(matchDecisionWord("please decline the booking request", OPTIONS.booking_request)).toBeNull(); // a sentence → the classifier, never a keyword scan
    // 2026-09-28: a bare "yes" must never accept a booking — the agent may have asked its own yes/no question.
    expect(matchDecisionWord("yes", OPTIONS.booking_request)).toBeNull();
    expect(matchDecisionWord("yes", OPTIONS.interview_proposal)).toBeNull();
    expect(matchDecisionWord("no", OPTIONS.amendment)).toBeNull();
    expect(matchDecisionWord("yes", OPTIONS.booking_request_decline)).toBe("YES");
    expect(matchDecisionWord("no", OPTIONS.booking_request_decline)).toBe("NO");
    expect(matchDecisionWord("what time is it?", OPTIONS.interview_request)).toBeNull();
  });
  it("parks with the kind's options and a 3-day expiry", () => {
    const pd = parkedDecision("booking_request", "br1", "a booking request from Fam", "caregiver", 1_000_000);
    expect(pd.options).toEqual(["ACCEPT", "DECLINE", "DETAILS"]);
    expect(Date.parse(pd.expiresAt) - Date.parse(pd.parkedAt)).toBe(DECISION_TTL_MS);
    expect(isExpired(pd, 1_000_000 + DECISION_TTL_MS + 1)).toBe(true);
    expect(isExpired(pd, 1_000_000 + 5)).toBe(false);
  });
});

describe("handlePendingDecisionReply — the reply runs the page's write, or falls through", () => {
  it("no parked decision, an expired one, or an unrelated message → passthrough (the agent takes it)", async () => {
    expect(await handlePendingDecisionReply("+1", "chat", "accept", session(undefined))).toBe("passthrough");
    const old = parkedDecision("interview_request", "iv1", "x", "caregiver", Date.now() - DECISION_TTL_MS - 5000);
    expect(await handlePendingDecisionReply("+1", "chat", "accept", session(old))).toBe("passthrough");
    expect(hoisted.sessionUpdates.at(-1)?.d).toEqual({ pendingDecision: "__delete__" }); // expired → cleared
    hoisted.sessionUpdates.length = 0;
    expect(await handlePendingDecisionReply("+1", "chat", "what jobs are near me?", session(parkedDecision("interview_request", "iv1", "x", "caregiver")))).toBe("passthrough");
    expect(hoisted.sessionUpdates).toHaveLength(0); // still parked
    expect(hoisted.respondInterview).not.toHaveBeenCalled();
    // 2026-09-28: a bare "yes" while a booking request is parked never reaches the classifier (it may answer the agent's own question)
    hoisted.quick.mockClear();
    expect(await handlePendingDecisionReply("+1", "chat", "Yes", session(parkedDecision("booking_request", "br1", "x", "caregiver")))).toBe("passthrough");
    expect(hoisted.quick).not.toHaveBeenCalled();
    expect(hoisted.respondBooking).not.toHaveBeenCalled();
  });

  it("interview request: ACCEPT runs the site's accept and texts its toast; DECLINE declines; PROPOSE opens the reschedule flow", async () => {
    const pd = parkedDecision("interview_request", "iv1", "an interview request from Fam", "caregiver");
    expect(await handlePendingDecisionReply("+1", "chat", "accept", session(pd))).toBe("handled");
    expect(hoisted.respondInterview).toHaveBeenCalledWith({ caregiverId: "cg1", interviewId: "iv1", decision: "accept", source: "decision_notice" });
    expect(hoisted.sent).toEqual(["Interview accepted"]);
    expect(hoisted.sessionUpdates.at(-1)?.d).toEqual({ pendingDecision: "__delete__" });
    await handlePendingDecisionReply("+1", "chat", "I can't make that", session(pd));
    expect(hoisted.respondInterview).toHaveBeenLastCalledWith(expect.objectContaining({ decision: "decline" }));
    await handlePendingDecisionReply("+1", "chat", "propose", session(pd));
    expect(hoisted.startReschedule).toHaveBeenCalledWith("+1", "chat", expect.anything(), { caregiverId: "cg1", interviewId: "iv1" });
  });

  it("interview request ACCEPT is gated like the page (Decline never is)", async () => {
    hoisted.access = { ok: false, block: "membership", caregiver: {} };
    const pd = parkedDecision("interview_request", "iv1", "x", "caregiver");
    await handlePendingDecisionReply("+1", "chat", "accept", session(pd));
    expect(hoisted.gateTexts).toEqual(["membership"]);
    expect(hoisted.respondInterview).not.toHaveBeenCalled();
    await handlePendingDecisionReply("+1", "chat", "decline", session(pd));
    expect(hoisted.respondInterview).toHaveBeenCalledWith(expect.objectContaining({ decision: "decline" }));
  });

  it("proposed time: 'Yes confirm' from the family runs accept_interview_reschedule for the client and texts 'Interview time confirmed'", async () => {
    const pd = parkedDecision("interview_proposal", "iv1", "a new interview time Mahad proposed", "client");
    expect(await handlePendingDecisionReply("+1", "chat", "Yes confirm", session(pd))).toBe("handled");
    expect(hoisted.handleToolCall).toHaveBeenCalledWith("accept_interview_reschedule", { interviewId: "iv1", phone: "+1", clientId: "u1", userId: "u1" });
    expect(hoisted.sent).toEqual(["Interview time confirmed"]);
  });

  it("booking request: DETAILS texts the request whole and stays parked; DECLINE asks the page's confirm; YES then declines", async () => {
    const pd = parkedDecision("booking_request", "br1", "a booking request from Fam", "caregiver", Date.now(), "Basra Yousuf");
    await handlePendingDecisionReply("+1", "chat", "details", session(pd));
    expect(hoisted.sent[0]).toContain("Booking requests:");
    expect(hoisted.sessionUpdates).toHaveLength(0); // still parked
    await handlePendingDecisionReply("+1", "chat", "decline", session(pd));
    expect(hoisted.sent.at(-1)).toBe("Decline Basra Yousuf's booking request? Reply YES or NO."); // names the family (2026-09-28)
    const confirm = hoisted.sessionSets.at(-1)?.d.pendingDecision;
    expect(confirm).toMatchObject({ kind: "booking_request_decline", recordId: "br1", options: ["YES", "NO"], party: "Basra Yousuf" });
    await handlePendingDecisionReply("+1", "chat", "yes", session(confirm));
    expect(hoisted.respondBooking).toHaveBeenCalledWith("cg1", "br1", "decline");
    expect(hoisted.sent.at(-1)).toBe("Request declined");
  });

  it("booking request ACCEPT runs the page's accept (gated) and texts its toast", async () => {
    const pd = parkedDecision("booking_request", "br1", "x", "caregiver");
    await handlePendingDecisionReply("+1", "chat", "ACCEPT", session(pd));
    expect(hoisted.respondBooking).toHaveBeenCalledWith("cg1", "br1", "accept");
    expect(hoisted.sent).toEqual(["Booking request accepted!"]);
  });

  it("schedule change: ACCEPT / DECLINE run the page's handlers", async () => {
    const pd = parkedDecision("amendment", "am1", "x", "caregiver");
    await handlePendingDecisionReply("+1", "chat", "accept", session(pd));
    expect(hoisted.acceptAmendment).toHaveBeenCalledWith("cg1", "am1");
    expect(hoisted.sent).toEqual(["Schedule updated — new visits added."]);
    await handlePendingDecisionReply("+1", "chat", "decline", session(pd));
    expect(hoisted.declineAmendment).toHaveBeenCalledWith("cg1", "am1");
  });

  it("new job: APPLY opens the apply flow for that job; DETAILS texts the job and stays parked", async () => {
    const pd = parkedDecision("new_job", "job1", "a new job near you", "caregiver");
    await handlePendingDecisionReply("+1", "chat", "details", session(pd));
    expect(hoisted.sendJobDetails).toHaveBeenCalledWith("+1", "chat", "cg1", "job1");
    expect(hoisted.sessionUpdates).toHaveLength(0);
    await handlePendingDecisionReply("+1", "chat", "apply", session(pd));
    expect(hoisted.startApply).toHaveBeenCalledWith("+1", "chat", expect.anything(), { caregiverId: "cg1", jobId: "job1" });
  });
});
