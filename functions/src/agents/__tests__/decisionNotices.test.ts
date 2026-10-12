import { describe, it, expect, vi, beforeEach } from "vitest";

// Decision notices → deterministic replies (decisionNotices.ts): the notice parks
// the expected decision; the reply is matched before the agent and runs the
// page's own write.

const hoisted = vi.hoisted(() => ({
  sent: [] as string[],
  sessionUpdates: [] as any[],
  sessionSets: [] as any[],
  docs: new Map<string, any>(),
  acceptShiftProposal: vi.fn(async () => ({ ok: true, shiftId: "s1", clientName: "Basra Yousuf", from: { date: "2099-10-05", startTime: "11:00", endTime: "14:00" }, to: { date: "2099-10-06", startTime: "12:00", endTime: "15:00" } })),
  declineShiftProposal: vi.fn(async () => ({ ok: true, shiftId: "s1", clientName: "Basra Yousuf", from: { date: "2099-10-05", startTime: "11:00", endTime: "14:00" }, to: null })),
  quick: vi.fn(async (_p: string, t: string): Promise<string> => (/confirm|sounds good|yes/i.test(t) ? "CONFIRM" : /can'?t|pass/i.test(t) ? "DECLINE" : "OTHER")),
  respondInterview: vi.fn(async () => ({ status: "accepted", interviewId: "iv1", callUrl: null })),
  respondBooking: vi.fn(async (_c: string, _id: string, d: string) => ({ ok: true, status: d === "accept" ? "accepted" : "declined", toast: d === "accept" ? "Booking request accepted!" : "Request declined", clientName: "Fam" })),
  acceptAmendment: vi.fn(async () => ({ ok: true, status: "accepted", toast: "Schedule updated — new visits added." })),
  declineAmendment: vi.fn(async () => ({ ok: true, status: "declined", toast: "Declined." })),
  loadBookingRequestFor: vi.fn(async () => ({ ok: true, req: { id: "br1", clientName: "Fam", status: "pending", schedule: {}, careRecipients: [] } })),
  startApply: vi.fn(async () => ({ started: true })),
  startReschedule: vi.fn(async () => ({ started: true })),
  sendJobDetails: vi.fn(async () => ({ sent: true, ok: true })),
  handleToolCall: vi.fn(async () => ({ success: true })),
  keepInterviewTime: vi.fn(async (): Promise<any> => ({ ok: true, interviewId: "iv1", keptBy: "caregiver", clientName: "The Nguyen Family", caregiverName: "Alice Mahad", scheduledTime: "2099-10-05T18:00:00.000Z", scheduledTimeLocal: "Monday, October 5 at 11:00 AM" })),
  access: { ok: true } as any,
  gateTexts: [] as string[],
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => {
      const filters: Array<[string, unknown]> = [];
      const q: any = {
        where: (f: string, _op: string, v: unknown) => { filters.push([f, v]); return q; },
        get: async () => ({ docs: [...hoisted.docs.entries()].filter(([k, d]) => k.startsWith(`${name}/`) && filters.every(([f, v]) => d?.[f] === v)).map(([k, d]) => ({ id: k.slice(name.length + 1), data: () => d })) }),
      };
      return { where: q.where, doc: (id: string) => ({
        get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), data: () => hoisted.docs.get(`${name}/${id}`) })),
        update: vi.fn(async (d: any) => { hoisted.sessionUpdates.push({ id, d }); }),
        set: vi.fn(async (d: any) => { hoisted.sessionSets.push({ id, d }); }),
      }) };
    },
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
vi.mock("../caregiverShiftProposal", () => ({
  acceptFamilyShiftProposal: (...a: any[]) => (hoisted.acceptShiftProposal as any)(...a),
  declineFamilyShiftProposal: (...a: any[]) => (hoisted.declineShiftProposal as any)(...a),
  visitWhen: (v: any) => `${v.date}, ${v.startTime} – ${v.endTime}`,
  proposalWhen: (s: any) => `${s.reschedulePendingDate}, ${s.reschedulePendingStartTime} – ${s.reschedulePendingEndTime}`,
}));
vi.mock("../../mcp/server", () => ({ handleToolCall: (...a: any[]) => (hoisted.handleToolCall as any)(...a) }));
// The real keptInterviewLine (the confirm wording is asserted); only the write is mocked.
vi.mock("../interviewProposal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../interviewProposal")>()),
  keepInterviewTime: (...a: any[]) => (hoisted.keepInterviewTime as any)(...a),
}));
vi.mock("../caregiverAccessGate", () => ({
  checkCaregiverAccess: vi.fn(async () => hoisted.access),
  textCaregiverGateBlock: vi.fn(async (_p: string, _c: string, reason: string) => { hoisted.gateTexts.push(reason); }),
}));

import { matchDecisionWord, parkedDecision, handlePendingDecisionReply, isExpired, OPTIONS, DECISION_TTL_MS, expireParkedDecision, EXPIRED_DECISION_TTL_MS } from "../decisionNotices";

const session = (pd: any, extra: Record<string, unknown> = {}) => ({ caregiverId: "cg1", userId: "u1", chatId: "chat", pendingDecision: pd, ...extra }) as any;

beforeEach(() => {
  hoisted.sent.length = 0; hoisted.sessionUpdates.length = 0; hoisted.sessionSets.length = 0; hoisted.gateTexts.length = 0; hoisted.docs.clear();
  hoisted.acceptShiftProposal.mockClear(); hoisted.declineShiftProposal.mockClear();
  hoisted.access = { ok: true };
  for (const f of [hoisted.quick, hoisted.respondInterview, hoisted.respondBooking, hoisted.acceptAmendment, hoisted.declineAmendment, hoisted.startApply, hoisted.startReschedule, hoisted.sendJobDetails, hoisted.handleToolCall, hoisted.keepInterviewTime]) f.mockClear();
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

  // Keep current time (B5, 2026-10-11): the third word on a proposal notice, both roles — the page's own
  // write via interviewProposal.ts, never gated, the confirm names the other side and the time that stands.
  describe("proposed time: KEEP is the page's Keep current time on both doors", () => {
    it("the notice offers CONFIRM / KEEP / PROPOSE", () => {
      expect(OPTIONS.interview_proposal).toEqual(["CONFIRM", "KEEP", "PROPOSE"]);
      expect(matchDecisionWord("keep", OPTIONS.interview_proposal)).toBe("KEEP");
      expect(matchDecisionWord("Keep.", OPTIONS.interview_proposal)).toBe("KEEP");
    });

    it("care provider KEEP runs keepInterviewTime as the care provider and texts the kept line; the decision is cleared; no gate, no tool", async () => {
      hoisted.access = { ok: false, block: "membership", caregiver: {} }; // would block an accept — never a keep
      const pd = parkedDecision("interview_proposal", "iv1", "a new interview time The Nguyen Family proposed", "caregiver", Date.now(), "The Nguyen Family");
      expect(await handlePendingDecisionReply("+1", "chat", "KEEP", session(pd))).toBe("handled");
      expect(hoisted.keepInterviewTime).toHaveBeenCalledWith({ by: "caregiver", userId: "cg1", interviewId: "iv1", source: "decision_notice" });
      expect(hoisted.handleToolCall).not.toHaveBeenCalled();
      expect(hoisted.gateTexts).toEqual([]);
      expect(hoisted.sent).toEqual(["Kept the current time — your interview with The Nguyen Family stays at Monday, October 5 at 11:00 AM."]);
      expect(hoisted.sessionUpdates.at(-1)?.d).toEqual({ pendingDecision: "__delete__" });
    });

    it("family KEEP runs keepInterviewTime as the client (users/{uid}) and names the care provider", async () => {
      hoisted.keepInterviewTime.mockResolvedValueOnce({ ok: true, interviewId: "iv1", keptBy: "client", clientName: "The Nguyen Family", caregiverName: "Alice Mahad", scheduledTime: "2099-10-05T18:00:00.000Z", scheduledTimeLocal: "Monday, October 5 at 11:00 AM" });
      const pd = parkedDecision("interview_proposal", "iv1", "a new interview time Alice Mahad proposed", "client", Date.now(), "Alice Mahad");
      expect(await handlePendingDecisionReply("+1", "chat", "keep", session(pd))).toBe("handled");
      expect(hoisted.keepInterviewTime).toHaveBeenCalledWith({ by: "client", userId: "u1", interviewId: "iv1", source: "decision_notice" });
      expect(hoisted.sent).toEqual(["Kept the current time — your interview with Alice Mahad stays at Monday, October 5 at 11:00 AM."]);
    });

    it("a proposal that is no longer pending gets one factual line, no write claimed", async () => {
      hoisted.keepInterviewTime.mockResolvedValueOnce({ ok: false, code: "INVALID_INPUT", message: "There is no pending reschedule proposal on this interview" });
      const pd = parkedDecision("interview_proposal", "iv1", "x", "caregiver", Date.now(), "The Nguyen Family");
      await handlePendingDecisionReply("+1", "chat", "keep", session(pd));
      expect(hoisted.sent).toEqual(["That proposal isn't pending any more — your interview with The Nguyen Family stays as it is."]);
    });

    it("a phrasing goes through the classifier: 'the original time is fine' → KEEP", async () => {
      hoisted.quick.mockResolvedValueOnce("KEEP");
      const pd = parkedDecision("interview_proposal", "iv1", "x", "caregiver", Date.now(), "The Nguyen Family");
      expect(await handlePendingDecisionReply("+1", "chat", "the original time is fine for me", session(pd))).toBe("handled");
      expect(hoisted.quick.mock.calls[0][0]).toContain("CONFIRM, KEEP, PROPOSE");
      expect(hoisted.keepInterviewTime).toHaveBeenCalledTimes(1);
    });
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

// Founder 2026-10-11: a question about a parked notice is answered from the notice itself (what it showed, what each
// reply does) and the expected reply re-stated — before this it reached the agent with nothing about the pending notice.
describe("a question while a notice is parked", () => {
  it("about the notice → answered from it, audience by role, decision still parked, expected reply re-stated; nothing runs", async () => {
    const pd = parkedDecision("interview_request", "iv1", "an interview request from The Nguyen Family", "caregiver", Date.now(), "The Nguyen Family");
    (hoisted.quick as any).mockResolvedValueOnce("QUESTION").mockResolvedValueOnce("It is a video interview — accepting sends you both the Meet link.");
    expect(await handlePendingDecisionReply("+1", "chat", "is it a video call?", session(pd))).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe("It is a video interview — accepting sends you both the Meet link.\n\nReply ACCEPT, DECLINE or PROPOSE for an interview request from The Nguyen Family.");
    const classifier = hoisted.quick.mock.calls.at(-2)![0] as string;
    expect(classifier).toContain("A question ABOUT this same item");
    const briefing = hoisted.quick.mock.calls.at(-1)![0] as string;
    expect(briefing).toContain("Audience: care provider");
    expect(briefing).toContain("Reply ACCEPT, DECLINE or PROPOSE for an interview request from The Nguyen Family.");
    expect(briefing).toContain("Evia's notice was about an interview request from The Nguyen Family (The Nguyen Family)."); // no record in this fixture → the label grounds it
    expect(briefing).toContain("ACCEPT accepts the interview (the Jobs page's Accept");
    expect(briefing).toContain("nothing has been accepted, declined, confirmed or sent");
    expect(briefing).toContain("NEVER say you changed, updated, saved, fixed, cancelled, sent or removed anything");
    expect(hoisted.sessionUpdates).toHaveLength(0); // still parked
    expect(hoisted.respondInterview).not.toHaveBeenCalled();
    expect(hoisted.startReschedule).not.toHaveBeenCalled();
  });
  it("a family's notice is answered to the family audience; a question about something else still goes to the agent", async () => {
    const pd = parkedDecision("job_application", "app1", "Maria Garcia's application to \"Weekend help\"", "client", Date.now(), "Maria Garcia");
    (hoisted.quick as any).mockResolvedValueOnce("QUESTION").mockResolvedValueOnce("Declining is confirmed first, and Maria is not told.");
    expect(await handlePendingDecisionReply("+1", "chat", "what happens if I decline?", session(pd))).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe("Declining is confirmed first, and Maria is not told.\n\nReply VIEW, INTERVIEW or DECLINE for Maria Garcia's application to \"Weekend help\".");
    const briefing = hoisted.quick.mock.calls.at(-1)![0] as string;
    expect(briefing).toContain("Audience: family");
    expect(briefing).toContain("DECLINE declines the application (a YES/NO confirm follows first)");
    hoisted.quick.mockClear();
    expect(await handlePendingDecisionReply("+1", "chat", "what jobs did I post?", session(pd))).toBe("passthrough"); // the default mock → OTHER
    expect(hoisted.quick).toHaveBeenCalledTimes(1);
    expect(hoisted.sessionUpdates).toHaveLength(0);
  });
});

// ── 2026-10-12 live: "Can you decline Imran" while Mahad's application was parked declined MAHAD, and "Yes and Imran"
// at the confirm was taken as a bare YES. A reply about someone else never acts on the parked person.
describe("a reply that names someone else than the parked notice's person", () => {
  const mahad = () => parkedDecision("job_application", "appM", "Mahad's application to \"Senior care in San Jose\"", "client", Date.now(), "Mahad");
  beforeEach(() => {
    hoisted.docs.set("job_applications/appM", { jobId: "j1", caregiverId: "cgM", caregiverName: "Mahad", status: "pending", jobTitle: "Senior care in San Jose" });
    hoisted.docs.set("job_applications/appI", { jobId: "j1", caregiverId: "cgI", caregiverName: "Imran", status: "pending", jobTitle: "Senior care in San Jose" });
    hoisted.docs.set("job_applications/appZ", { jobId: "j2", caregiverId: "cgZ", caregiverName: "Imran", status: "pending", jobTitle: "Other post" }); // a different post — never matched
  });
  it("the classifier is told who the item is with, and SOMEONE_ELSE on a named applicant resolves to THAT application on the same post", async () => {
    (hoisted.quick as any).mockResolvedValueOnce("SOMEONE_ELSE").mockResolvedValueOnce("Imran").mockResolvedValueOnce("DECLINE");
    expect(await handlePendingDecisionReply("+1", "chat", "Can you decline Imran", session(mahad()))).toBe("handled");
    expect(hoisted.quick.mock.calls[0][0]).toContain("This item is with Mahad.");
    expect(hoisted.quick.mock.calls[0][0]).toContain("SOMEONE_ELSE");
    // The confirm names IMRAN, and the parked decline is for Imran's application — Mahad's row untouched.
    expect(hoisted.sent.at(-1)).toBe('Decline Imran\'s application to "Senior care in San Jose"? Reply YES or NO.');
    const parked = hoisted.sessionSets.map((x) => x.d.pendingDecision).filter(Boolean);
    expect(parked.at(-1)).toMatchObject({ kind: "job_application_decline", recordId: "appI", party: "Imran" });
    expect(hoisted.sessionUpdates.filter((u) => u.id === "appM")).toHaveLength(0);
  });
  it("a YES that also names someone else at a confirm step never acts — re-asked, nothing written", async () => {
    const confirm = parkedDecision("job_application_decline", "appM", "declining Mahad's application to \"Senior care in San Jose\"", "client", Date.now(), "Mahad");
    (hoisted.quick as any).mockResolvedValueOnce("SOMEONE_ELSE");
    expect(await handlePendingDecisionReply("+1", "chat", "Yes and Imran", session(confirm))).toBe("handled");
    expect(hoisted.sessionUpdates).toHaveLength(0); // no status: rejected write
    expect(hoisted.sent.at(-1)).toContain("I haven't changed anything for Mahad");
    expect(hoisted.sent.at(-1)).toContain("reply YES or NO");
  });
  it("a name that matches no pending applicant on the post goes to the agent; the parked decision is left alone", async () => {
    (hoisted.quick as any).mockResolvedValueOnce("SOMEONE_ELSE").mockResolvedValueOnce("Zoe");
    expect(await handlePendingDecisionReply("+1", "chat", "decline Zoe please", session(mahad()))).toBe("passthrough");
    expect(hoisted.sent).toHaveLength(0);
    expect(hoisted.sessionSets).toHaveLength(0);
  });
});

// ── Caregiver sweep B1 (2026-10-11): the family's proposed visit time — the Active Bookings strip's buttons by text ──
describe("shift proposal — ACCEPT / DECLINE run the strip's Accept new time / Decline; PROPOSE hands the new time to the agent", () => {
  const pd = () => parkedDecision("shift_proposal", "s1", "a new visit time Basra Yousuf proposed (Tue, Oct 6, 2099, 12:00 PM – 3:00 PM)", "caregiver", Date.now(), "Basra Yousuf");
  it("ACCEPT = the page's accept (caregiverShiftProposal.acceptFamilyShiftProposal), confirm names the family and the new time, park cleared", async () => {
    expect(await handlePendingDecisionReply("+1", "chat", "ACCEPT", session(pd()))).toBe("handled");
    expect(hoisted.acceptShiftProposal).toHaveBeenCalledWith("cg1", "s1", expect.any(String), "decision_notice");
    expect(hoisted.sent).toEqual(["New time confirmed — your visit with Basra Yousuf is now 2099-10-06, 12:00 – 15:00."]);
    expect(hoisted.sessionUpdates.at(-1)?.d).toEqual({ pendingDecision: "__delete__" });
  });
  it("DECLINE = the page's Decline (the confirmed time stands), named; 'I can't do that time' classifies to DECLINE too", async () => {
    expect(await handlePendingDecisionReply("+1", "chat", "decline", session(pd()))).toBe("handled");
    expect(hoisted.declineShiftProposal).toHaveBeenCalledWith("cg1", "s1", "decision_notice");
    expect(hoisted.sent).toEqual(["Declined — your visit with Basra Yousuf stays at 2099-10-05, 11:00 – 14:00."]);
    hoisted.sent.length = 0;
    await handlePendingDecisionReply("+1", "chat", "I can't do that time", session(pd()));
    expect(hoisted.declineShiftProposal).toHaveBeenCalledTimes(2);
    expect(hoisted.acceptShiftProposal).not.toHaveBeenCalled();
  });
  it("a conflict with another visit of yours → the page's alert verbatim, nothing moves, still parked (DECLINE / PROPOSE offered)", async () => {
    hoisted.acceptShiftProposal.mockResolvedValueOnce({ ok: false, code: "CONFLICT", message: "You already have another shift at 12:30 PM–2:00 PM that day — choose a different time.", conflict: { startTime: "12:30", endTime: "14:00" } } as any);
    expect(await handlePendingDecisionReply("+1", "chat", "accept", session(pd()))).toBe("handled");
    expect(hoisted.sent).toEqual(["You already have another shift at 12:30 PM–2:00 PM that day — choose a different time. Reply DECLINE to keep the current time, or PROPOSE a different one."]);
    expect(hoisted.sessionUpdates).toHaveLength(0); // still parked
  });
  it("PROPOSE stamps the visit on the session and asks for the day/time — the agent then runs manage_shift_reschedule propose on it; the park stays", async () => {
    expect(await handlePendingDecisionReply("+1", "chat", "PROPOSE", session(pd()))).toBe("handled");
    expect(hoisted.sessionSets.at(-1)).toEqual({ id: "+1", d: { lastNoticedShiftId: "s1" } });
    expect(hoisted.sent).toEqual(["Sure — what day and time would you like for your visit with Basra Yousuf instead?"]);
    expect(hoisted.sessionUpdates).toHaveLength(0);
    expect(hoisted.acceptShiftProposal).not.toHaveBeenCalled();
    expect(hoisted.declineShiftProposal).not.toHaveBeenCalled();
  });
  it("a bare 'yes' never accepts a visit time; a proposal no longer pending is reported and the park cleared", async () => {
    hoisted.quick.mockClear();
    expect(await handlePendingDecisionReply("+1", "chat", "yes", session(pd()))).toBe("passthrough");
    expect(hoisted.quick).not.toHaveBeenCalled();
    hoisted.acceptShiftProposal.mockResolvedValueOnce({ ok: false, code: "INVALID_INPUT", message: "There's no pending reschedule proposal on this visit" } as any);
    expect(await handlePendingDecisionReply("+1", "chat", "accept", session(pd()))).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe("That proposal isn't pending any more — your visit with Basra Yousuf stays as it is.");
    expect(hoisted.sessionUpdates.at(-1)?.d).toEqual({ pendingDecision: "__delete__" });
  });
  it("a question while parked is answered from the visit record (current time, proposed time, who proposed) — nothing decided", async () => {
    hoisted.docs.set("shifts/s1", { clientName: "Basra Yousuf", address: "20 Descanso Dr", date: "2099-10-05", startTime: "11:00", endTime: "14:00", reschedulePendingDate: "2099-10-06", reschedulePendingStartTime: "12:00", reschedulePendingEndTime: "15:00", rescheduledBy: "client", status: "scheduled" });
    (hoisted.quick as any).mockResolvedValueOnce("QUESTION").mockResolvedValueOnce("The family wants Tuesday noon to 3 instead of Monday 11 to 2.");
    expect(await handlePendingDecisionReply("+1", "chat", "what time was it before?", session(pd()))).toBe("handled");
    const briefing = hoisted.quick.mock.calls.at(-1)![0] as string;
    expect(briefing).toContain("Visit with Basra Yousuf at 20 Descanso Dr");
    expect(briefing).toContain("Current (confirmed) time: 2099-10-05, 11:00 – 14:00");
    expect(briefing).toContain("Proposed new time: 2099-10-06, 12:00 – 15:00 (proposed by the family)");
    expect(briefing).toContain("ACCEPT is the page's Accept new time");
    expect(hoisted.sent.at(-1)).toBe("The family wants Tuesday noon to 3 instead of Monday 11 to 2.\n\nReply ACCEPT, DECLINE or PROPOSE for a new visit time Basra Yousuf proposed (Tue, Oct 6, 2099, 12:00 PM – 3:00 PM).");
    expect(hoisted.sessionUpdates).toHaveLength(0);
  });
});

// ── Caregiver sweep B6 (2026-10-11): a replacement request that expired before the reply ──
describe("an expired notice — the park comes down, a late reply gets one line, never a write", () => {
  it("expireParkedDecision takes down the park for THAT record only and leaves the expired marker", async () => {
    hoisted.docs.set("agent_sessions/+1", { pendingDecision: parkedDecision("booking_request", "rep1", "a replacement request from Fam", "caregiver", Date.now(), "Fam") });
    const r = await expireParkedDecision("+1", "rep1", { kind: "booking_request", line: "Fam's replacement request has expired — nothing was sent." }, 1_000_000);
    expect(r).toEqual({ wasParked: true });
    expect(hoisted.sessionUpdates.at(-1)?.d).toEqual({ pendingDecision: "__delete__", expiredDecision: { kind: "booking_request", recordId: "rep1", options: ["ACCEPT", "DECLINE", "DETAILS"], line: "Fam's replacement request has expired — nothing was sent.", expiredAt: new Date(1_000_000).toISOString(), until: new Date(1_000_000 + EXPIRED_DECISION_TTL_MS).toISOString() } });
    // A different decision parked → untouched; only the marker is written.
    hoisted.docs.set("agent_sessions/+1", { pendingDecision: parkedDecision("interview_request", "iv9", "x", "caregiver") });
    expect(await expireParkedDecision("+1", "rep1", { kind: "booking_request", line: "l" })).toEqual({ wasParked: false });
    expect(hoisted.sessionUpdates.at(-1)?.d.pendingDecision).toBeUndefined();
    expect(hoisted.sessionUpdates.at(-1)?.d.expiredDecision).toMatchObject({ recordId: "rep1", kind: "booking_request" });
  });
  it("a late ACCEPT on the marker → the one line, marker cleared, no write; other text passes through; a stale marker is dropped", async () => {
    const marker = { kind: "booking_request", recordId: "rep1", options: ["ACCEPT", "DECLINE", "DETAILS"], line: "Fam's replacement request has expired — nothing was sent.", expiredAt: new Date().toISOString(), until: new Date(Date.now() + 60_000).toISOString() };
    expect(await handlePendingDecisionReply("+1", "chat", "ACCEPT", session(undefined, { expiredDecision: marker }))).toBe("handled");
    expect(hoisted.sent).toEqual(["Fam's replacement request has expired — nothing was sent."]);
    expect(hoisted.respondBooking).not.toHaveBeenCalled();
    expect(hoisted.sessionUpdates.at(-1)?.d).toEqual({ expiredDecision: "__delete__" });
    hoisted.sessionUpdates.length = 0; hoisted.quick.mockClear();
    expect(await handlePendingDecisionReply("+1", "chat", "what jobs are near me?", session(undefined, { expiredDecision: marker }))).toBe("passthrough");
    expect(hoisted.quick).not.toHaveBeenCalled(); // no classifier on a dead notice
    expect(hoisted.sessionUpdates).toHaveLength(0);
    const stale = { ...marker, until: new Date(Date.now() - 1000).toISOString() };
    expect(await handlePendingDecisionReply("+1", "chat", "ACCEPT", session(undefined, { expiredDecision: stale }))).toBe("passthrough");
    expect(hoisted.sessionUpdates.at(-1)?.d).toEqual({ expiredDecision: "__delete__" });
  });
  it("ACCEPT while the park is still up but the request already expired → the expired line, no write", async () => {
    hoisted.respondBooking.mockResolvedValueOnce({ ok: false, reason: "not_pending", status: "expired" } as any);
    const pd = parkedDecision("booking_request", "rep1", "a replacement request from Fam", "caregiver", Date.now(), "Fam");
    expect(await handlePendingDecisionReply("+1", "chat", "ACCEPT", session(pd))).toBe("handled");
    expect(hoisted.sent).toEqual(["Fam's replacement request has expired — nothing was sent."]);
  });
});
