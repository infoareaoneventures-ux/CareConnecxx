import { describe, it, expect, vi, beforeEach } from "vitest";

// The Jobs page texted by the tools themselves (jobBoardText.ts). 2026-09-27
// live: the model's numbered list was rewritten away by the SMS formatter and
// the caregiver saw "I found a few options — which one?" with no jobs.

const hoisted = vi.hoisted(() => ({
  sent: [] as string[],
  sessionWrites: [] as Array<{ phone: string; data: Record<string, unknown> }>,
  page: null as any,
  details: null as any,
  session: {} as Record<string, unknown>,
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        set: vi.fn(async (d: Record<string, unknown>) => { if (name === "agent_sessions") hoisted.sessionWrites.push({ phone: id, data: d }); }),
        get: vi.fn(async () => ({ exists: true, data: () => hoisted.session })),
      }),
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

beforeEach(() => { hoisted.sent.length = 0; hoisted.sessionWrites.length = 0; hoisted.page = null; hoisted.details = null; hoisted.session = {}; });

describe("jobListText — the Available Jobs tab as one text, 2 at a time", () => {
  it("numbers every card line and ends with how to answer", () => {
    const { text: t } = jobListText({ jobs: [card(), card({ jobId: "job2", title: "Care for Rosy", rate: "$26/hr", action: "Activate Membership" })], total: 2, hiddenCount: 0, radiusMiles: 25, hasCoords: true });
    expect(t.startsWith("Jobs found:\n1. Senior care in San Jose · San Jose, CA, 95134 (5.7 mi away) · $10/hr · Part-time · Daytime · Sep 27, 2026 · Morning\n2. Care for Rosy")).toBe(true);
    expect(t).toContain("— Activate Membership"); // the gate button the card shows instead of Apply Now
    expect(t.endsWith(LIST_FOOTER)).toBe(true);
  });
  it("uses the page's two empty states", () => {
    const empty = { jobs: [], total: 0, hiddenCount: 0, radiusMiles: 0, hasCoords: false };
    expect(jobListText(empty).text).toBe("No open jobs right now.");
    expect(jobListText(empty, { filtered: true }).text).toBe("No jobs match your filters.");
  });
  // Founder (2026-09-27): "show the latest ... and give the option to show more" — two per page.
  it("pages 2 at a time with MORE, numbering continuing, then says that's all", () => {
    const jobs = [1, 2, 3, 4, 5].map((n) => card({ jobId: `job${n}`, title: `Job ${n}` }));
    const page = { jobs, total: 5, hiddenCount: 0, radiusMiles: 25, hasCoords: true };
    const p1 = jobListText(page);
    expect(p1.text.startsWith("Jobs found:\n1. Job 1")).toBe(true);
    expect(p1.text).toContain("\n2. Job 2");
    expect(p1.text).not.toContain("3. Job 3");
    expect(p1.text.endsWith(`${LIST_FOOTER} Reply MORE to see more.`)).toBe(true);
    expect(p1.remaining).toBe(3);
    const p2 = jobListText(page, { from: 2 });
    expect(p2.text.startsWith("More jobs:\n3. Job 3 ·")).toBe(true);
    expect(p2.text).toContain("\n4. Job 4 ·");
    expect(p2.text.endsWith(`${LIST_FOOTER} Reply MORE to see more.`)).toBe(true);
    const p3 = jobListText(page, { from: 4 });
    expect(p3.text.startsWith("More jobs:\n5. Job 5 ·")).toBe(true);
    expect(p3.text.endsWith(LIST_FOOTER)).toBe(true);
    expect(jobListText(page, { from: 5 }).text).toBe("That's all the open jobs right now — reply with a number for the details.");
  });
  it("the dashboard's nearest-4 (an explicit limit) is not paged", () => {
    const jobs = [1, 2, 3, 4].map((n) => card({ jobId: `job${n}` }));
    const { text } = jobListText({ jobs, total: 9, hiddenCount: 0, radiusMiles: 25, hasCoords: true }, { limited: true });
    expect(text.startsWith("Jobs near you:")).toBe(true);
    expect(text).toContain("4. ");
    expect(text).not.toContain("MORE");
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
  const T = (m: number) => new Date(1_700_000_000_000 + m * 60_000).toISOString();
  const session = { lastJobList: { at: T(0), items: [{ number: 1, jobId: "a" }, { number: 2, jobId: "b" }] }, lastJobDetailsJobId: "shown", lastJobDetailsAt: T(5), lastNoticedJobId: "noticed", lastNoticedJobAt: T(3) };
  it("explicit id wins; a number maps through the last list; unknown number → null", () => {
    expect(resolveJobRef(session, { jobId: "z" })).toBe("z");
    expect(resolveJobRef(session, { number: 2 })).toBe("b");
    expect(resolveJobRef(session, { number: "1" })).toBe("a");
    expect(resolveJobRef(session, { number: 7 })).toBeNull();
  });
  // 2026-09-27 live: "can you provide details" right after a new-job notice
  // showed a job whose details they had read EARLIER. Most recent wins.
  it("no reference → whichever job was put in front of them most recently: details read, notice sent, or a one-job list", () => {
    expect(resolveJobRef(session, {})).toBe("shown"); // details (T5) newer than the notice (T3)
    expect(resolveJobRef({ ...session, lastNoticedJobAt: T(9) }, {})).toBe("noticed"); // a newer notice wins
    expect(resolveJobRef({ ...session, lastJobList: { at: T(20), items: [{ number: 1, jobId: "only" }] } }, {})).toBe("only");
    expect(resolveJobRef({ ...session, lastJobList: { at: T(20), items: session.lastJobList.items } }, {})).toBeNull(); // a newer multi-job list → ask by number
    expect(resolveJobRef({ lastNoticedJobId: "noticed" }, {})).toBe("noticed");
    expect(resolveJobRef({}, {})).toBeNull();
  });
});

describe("sendJobList / sendJobDetails — the tools text and remember", () => {
  it("texts the list and stores the number → id map on the session", async () => {
    hoisted.page = { jobs: [card(), card({ jobId: "job2", title: "Care for Rosy" })], total: 2, hiddenCount: 0, radiusMiles: 25, hasCoords: true };
    const r = await sendJobList("+1555", "chat", "cg1");
    expect(r).toMatchObject({ sent: true, count: 2, total: 2, remaining: 0 });
    expect(hoisted.sent[0]).toContain("1. Senior care in San Jose");
    expect(hoisted.sessionWrites[0]).toEqual({ phone: "+1555", data: { lastJobList: { at: expect.any(String), items: [{ number: 1, jobId: "job1", title: "Senior care in San Jose" }, { number: 2, jobId: "job2", title: "Care for Rosy" }], offset: 2, total: 2 } } });
  });
  it("MORE continues where the last list left off and keeps the earlier numbers valid", async () => {
    hoisted.page = { jobs: [1, 2, 3, 4, 5].map((n) => card({ jobId: `job${n}`, title: `Job ${n}` })), total: 5, hiddenCount: 0, radiusMiles: 25, hasCoords: true };
    hoisted.session = { lastJobList: { at: "x", items: [{ number: 1, jobId: "job1", title: "Job 1" }, { number: 2, jobId: "job2", title: "Job 2" }, { number: 3, jobId: "job3", title: "Job 3" }], offset: 3, total: 5 } };
    const r = await sendJobList("+1555", "chat", "cg1", { more: true });
    expect(r).toMatchObject({ count: 2, remaining: 0 });
    expect(hoisted.sent[0].startsWith("More jobs:\n4. Job 4")).toBe(true);
    const stored = hoisted.sessionWrites[0].data.lastJobList as any;
    expect(stored.items.map((i: any) => i.number)).toEqual([1, 2, 3, 4, 5]);
    expect(stored.offset).toBe(5);
  });
  it("texts the details and remembers which job, so 'apply' needs no number", async () => {
    hoisted.details = { ok: true, details: { ...card(), postedBy: null, startingDate: null, time: null, hoursPerWeek: null, description: null, interviewStatus: null, applicationStatus: null } };
    const r = await sendJobDetails("+1555", "chat", "cg1", "job1");
    expect(r).toEqual({ sent: true, ok: true });
    expect(hoisted.sent[0].startsWith("Senior care in San Jose")).toBe(true);
    expect(hoisted.sessionWrites[0].data).toEqual({ lastJobDetailsJobId: "job1", lastJobDetailsAt: expect.any(String) });
  });
  it("an unavailable job is said plainly", async () => {
    hoisted.details = { ok: false, reason: "unavailable" };
    const r = await sendJobDetails("+1555", "chat", "cg1", "gone");
    expect(r.ok).toBe(false);
    expect(hoisted.sent[0]).toBe("That job is no longer available.");
  });
});
