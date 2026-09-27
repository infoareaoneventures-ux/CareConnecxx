import { describe, it, expect, vi, beforeEach } from "vitest";

// The Jobs page texted by the tools themselves (jobBoardText.ts). 2026-09-27
// live: the model's numbered list was rewritten away by the SMS formatter and
// the caregiver saw "I found a few options — which one?" with no jobs.

const hoisted = vi.hoisted(() => ({
  sent: [] as string[],
  sessionWrites: [] as Array<{ phone: string; data: Record<string, unknown> }>,
  page: null as any,
  details: null as any,
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({
      doc: (id: string) => ({ set: vi.fn(async (d: Record<string, unknown>) => { if (name === "agent_sessions") hoisted.sessionWrites.push({ phone: id, data: d }); }) }),
    }),
  }), { FieldValue: { serverTimestamp: () => ({}), delete: () => ({}) } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));
vi.mock("../jobBoardPage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../jobBoardPage")>();
  return {
    ...actual,
    loadAvailableJobs: vi.fn(async () => hoisted.page),
    loadJobDetails: vi.fn(async () => hoisted.details),
  };
});

import { jobListText, jobDetailsText, resolveJobRef, sendJobList, sendJobDetails, LIST_FOOTER } from "../jobBoardText";

const card = (over: Record<string, unknown> = {}) => ({
  jobId: "job1", title: "Senior care in San Jose", location: "San Jose, CA, 95134", distanceMiles: 5.7, rate: "$10/hr",
  paymentMethod: "via credit", frequency: "Part-time", day: true, night: false, seniors: null, transportation: false,
  date: "Sep 27, 2026", hours: "Morning", careTypes: ["Companionship"], daysOfWeek: ["Mon"], action: "Apply Now", ...over,
});

beforeEach(() => { hoisted.sent.length = 0; hoisted.sessionWrites.length = 0; hoisted.page = null; hoisted.details = null; });

describe("jobListText — the Available Jobs tab as one text", () => {
  it("numbers every card line and ends with how to answer", () => {
    const t = jobListText({ jobs: [card(), card({ jobId: "job2", title: "Care for Rosy", rate: "$26/hr", action: "Activate Membership" })], total: 2, hiddenCount: 0, radiusMiles: 25, hasCoords: true });
    expect(t.startsWith("2 jobs found:\n1. Senior care in San Jose · San Jose, CA, 95134 (5.7 mi away) · $10/hr · Part-time · Day · Sep 27, 2026 · Morning\n2. Care for Rosy")).toBe(true);
    expect(t).toContain("— Activate Membership"); // the gate button the card shows instead of Apply Now
    expect(t.endsWith(LIST_FOOTER)).toBe(true);
  });
  it("uses the page's two empty states", () => {
    const empty = { jobs: [], total: 0, hiddenCount: 0, radiusMiles: 0, hasCoords: false };
    expect(jobListText(empty)).toBe("No open jobs right now.");
    expect(jobListText(empty, { filtered: true })).toBe("No jobs match your filters.");
  });
});

describe("jobDetailsText — the Job Details modal", () => {
  const details = { ...card(), postedBy: null, startingDate: "Sep 27, 2026", time: "Morning", hoursPerWeek: "20+ hrs", description: "Help mom with mornings.", interviewStatus: null, applicationStatus: null } as any;
  it("shows the modal's fields, hides Posted by until accepted, and ends with the apply prompt", () => {
    const t = jobDetailsText(details);
    expect(t).not.toContain("Posted by");
    expect(t).toContain("San Jose, CA, 95134 (5.7 mi away)");
    expect(t).toContain("$10/hr (via credit)");
    expect(t).toContain("Starting: Sep 27, 2026");
    expect(t).toContain("Hours/week: 20+ hrs");
    expect(t).toContain("Help mom with mornings.");
    expect(t.endsWith(`Reply "apply" to apply, or a number for another job.`)).toBe(true);
  });
  it("shows exactly one footer: interview status, else application status, else the gate", () => {
    expect(jobDetailsText({ ...details, interviewStatus: "Interview Confirmed", applicationStatus: "Application Pending" }).endsWith("Interview Confirmed")).toBe(true);
    expect(jobDetailsText({ ...details, applicationStatus: "Application Pending" }).endsWith("Application Pending")).toBe(true);
    expect(jobDetailsText({ ...details, action: "Complete Verification" }).endsWith("To apply you'll need to: Complete Verification.")).toBe(true);
    expect(jobDetailsText({ ...details, postedBy: "Basra" })).toContain("Posted by Basra");
  });
});

describe("resolveJobRef — numbers, not guessed ids", () => {
  const session = { lastJobList: { at: "x", items: [{ number: 1, jobId: "a" }, { number: 2, jobId: "b" }] }, lastJobDetailsJobId: "shown", lastNoticedJobId: "noticed" };
  it("explicit id wins; a number maps through the last list; unknown number → null", () => {
    expect(resolveJobRef(session, { jobId: "z" })).toBe("z");
    expect(resolveJobRef(session, { number: 2 })).toBe("b");
    expect(resolveJobRef(session, { number: "1" })).toBe("a");
    expect(resolveJobRef(session, { number: 7 })).toBeNull();
  });
  it("no reference → the job whose details were just shown, else the job just noticed", () => {
    expect(resolveJobRef(session, {})).toBe("shown");
    expect(resolveJobRef({ lastNoticedJobId: "noticed" }, {})).toBe("noticed");
    expect(resolveJobRef({}, {})).toBeNull();
  });
});

describe("sendJobList / sendJobDetails — the tools text and remember", () => {
  it("texts the list and stores the number → id map on the session", async () => {
    hoisted.page = { jobs: [card(), card({ jobId: "job2", title: "Care for Rosy" })], total: 2, hiddenCount: 0, radiusMiles: 25, hasCoords: true };
    const r = await sendJobList("+1555", "chat", "cg1");
    expect(r).toMatchObject({ sent: true, count: 2, total: 2 });
    expect(hoisted.sent[0]).toContain("1. Senior care in San Jose");
    expect(hoisted.sessionWrites[0]).toEqual({ phone: "+1555", data: { lastJobList: { at: expect.any(String), items: [{ number: 1, jobId: "job1", title: "Senior care in San Jose" }, { number: 2, jobId: "job2", title: "Care for Rosy" }] } } });
  });
  it("texts the details and remembers which job, so 'apply' needs no number", async () => {
    hoisted.details = { ok: true, details: { ...card(), postedBy: null, startingDate: null, time: null, hoursPerWeek: null, description: null, interviewStatus: null, applicationStatus: null } };
    const r = await sendJobDetails("+1555", "chat", "cg1", "job1");
    expect(r).toEqual({ sent: true, ok: true });
    expect(hoisted.sent[0].startsWith("Senior care in San Jose")).toBe(true);
    expect(hoisted.sessionWrites[0].data).toEqual({ lastJobDetailsJobId: "job1" });
  });
  it("an unavailable job is said plainly", async () => {
    hoisted.details = { ok: false, reason: "unavailable" };
    const r = await sendJobDetails("+1555", "chat", "cg1", "gone");
    expect(r.ok).toBe(false);
    expect(hoisted.sent[0]).toBe("That job is no longer available.");
  });
});
