import { describe, it, expect, vi, beforeEach } from "vitest";

// The family's applicant notice (2026-10-07): "Reply VIEW for their profile, INTERVIEW to request an interview, or
// DECLINE" — parked like every other decision notice, so a one-word reply runs the post's own applicant-row action.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  updates: [] as Array<{ path: string; d: any }>,
  sessionSets: [] as any[],
  sent: [] as string[],
  quick: vi.fn(async () => "OTHER"),
  startInterview: vi.fn(async () => ({ started: true })),
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({ doc: (id: string) => ({
      get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), data: () => hoisted.docs.get(`${name}/${id}`) })),
      update: vi.fn(async (d: any) => { hoisted.updates.push({ path: `${name}/${id}`, d }); hoisted.docs.set(`${name}/${id}`, { ...hoisted.docs.get(`${name}/${id}`), ...d }); }),
      set: vi.fn(async (d: any) => { if (name === "agent_sessions") hoisted.sessionSets.push(d); }),
    }) }),
  }), { FieldValue: { delete: () => "__delete__", serverTimestamp: () => "__ts__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => (hoisted.quick as any)(...a) }));
vi.mock("../interviewFlow", () => ({ startInterviewFlow: (...a: any[]) => (hoisted.startInterview as any)(...a) }));
vi.mock("../../config/appUrl", () => ({ getAppUrl: () => "https://eviacares.com" }));

import { handlePendingDecisionReply, parkedDecision } from "../decisionNotices";

const APP = { clientId: "fam1", caregiverId: "cg-imran", caregiverName: "Imran Ali", jobId: "job1", jobTitle: "Senior care in San Jose", status: "pending" };
const pd = () => parkedDecision("job_application", "app1", "Imran Ali's application to \"Senior care in San Jose\"", "client", Date.now(), "Imran Ali");
const session = (p: any) => ({ userId: "fam1", chatId: "chat", pendingDecision: p }) as any;

beforeEach(() => { hoisted.docs.clear(); hoisted.updates.length = 0; hoisted.sessionSets.length = 0; hoisted.sent.length = 0; hoisted.quick.mockClear(); hoisted.startInterview.mockClear(); hoisted.docs.set("job_applications/app1", { ...APP }); });

describe("applicant notice → VIEW / INTERVIEW / DECLINE", () => {
  it("VIEW texts the profile link and keeps the decision parked", async () => {
    expect(await handlePendingDecisionReply("+1", "chat", "VIEW", session(pd()))).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe("Tap to view Imran's profile: https://eviacares.com/p/cg-imran\n\nReply INTERVIEW to request an interview, or DECLINE.");
    expect(hoisted.updates.filter((u) => u.path.startsWith("job_applications/"))).toEqual([]);
  });
  it("INTERVIEW starts the site's interview flow for that caregiver, linked to the application", async () => {
    expect(await handlePendingDecisionReply("+1", "chat", "interview", session(pd()))).toBe("handled");
    expect(hoisted.startInterview).toHaveBeenCalledWith("+1", "chat", expect.anything(), { caregiverId: "cg-imran", applicationId: "app1" });
  });
  it("DECLINE names the caregiver and asks YES/NO; YES runs the page's Decline write and texts its toast — the caregiver is not messaged", async () => {
    expect(await handlePendingDecisionReply("+1", "chat", "Decline", session(pd()))).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe('Decline Imran\'s application to "Senior care in San Jose"? Reply YES or NO.');
    const parked = hoisted.sessionSets.at(-1).pendingDecision;
    expect(parked).toMatchObject({ kind: "job_application_decline", recordId: "app1", options: ["YES", "NO"], party: "Imran Ali" });
    expect(await handlePendingDecisionReply("+1", "chat", "yes", session(parked))).toBe("handled");
    expect(hoisted.updates.filter((u) => u.path.startsWith("job_applications/"))).toEqual([{ path: "job_applications/app1", d: { status: "rejected", declinedAt: "__ts__" } }]);
    expect(hoisted.sent.at(-1)).toBe("Applicant declined");
  });
  it("NO keeps the application; an already-decided application is reported, not rewritten", async () => {
    const parked = parkedDecision("job_application_decline", "app1", "declining it", "client", Date.now(), "Imran Ali");
    expect(await handlePendingDecisionReply("+1", "chat", "NO", session(parked))).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe("Okay — Imran's application stays as it is.");
    hoisted.docs.set("job_applications/app1", { ...APP, status: "rejected" });
    expect(await handlePendingDecisionReply("+1", "chat", "YES", session(parked))).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe("Imran's application is already rejected.");
    expect(hoisted.updates.filter((u) => u.path.startsWith("job_applications/"))).toEqual([]);
  });
  it("a question falls through to the agent with the decision still parked", async () => {
    expect(await handlePendingDecisionReply("+1", "chat", "how many years has he worked", session(pd()))).toBe("passthrough");
    expect(hoisted.sent).toEqual([]);
  });
});
