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
const loadAvailableJobs = vi.fn(async (_cg: string, _opts?: unknown) => hoisted.page);
const setJobHidden = vi.fn(async () => undefined);
vi.mock("../jobBoardPage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../jobBoardPage")>();
  return {
    ...actual,
    loadAvailableJobs: (...a: any[]) => (loadAvailableJobs as any)(...a),
    loadJobDetails: vi.fn(async () => hoisted.details),
    setJobHidden: (...a: any[]) => (setJobHidden as any)(...a),
  };
});
// The quick-tier extractor (B3): the test decides what the model "read".
const parseWithClaude = vi.fn(async (_prompt: string, _text: string) => "NONE");
vi.mock("../../utils/parseWithClaude", () => ({ parseWithClaude: (...a: any[]) => (parseWithClaude as any)(...a) }));
const startApplyFlow = vi.fn(async () => ({ started: true }));
vi.mock("../caregiverJobFlows", () => ({ startApplyFlow: (...a: any[]) => (startApplyFlow as any)(...a) }));

import {
  jobListText, jobDetailsText, resolveJobRef, sendJobList, sendJobDetails, LIST_FOOTER, listFooter,
  extractJobBoardFilters, jobListIsLatest, handleJobsKeyword, handleJobsFilterFollowUp, JOB_LIST_FOLLOW_UP_WINDOW_MS,
} from "../jobBoardText";
import type { JobCard } from "../jobBoardPage";

const card = (over: Partial<JobCard> = {}): JobCard => ({
  jobId: "job1", title: "Senior care in San Jose", location: "San Jose, CA, 95134", distanceMiles: 5.7, rate: "$10/hr",
  paymentMethod: "via credit", frequency: "Part-time", day: true, night: false, seniors: null, kind: null, ageRanges: [], transportation: false,
  date: "Sep 27, 2026", hours: "Morning", careTypes: ["Companionship"], daysOfWeek: ["Mon"], action: "Apply Now", ...over,
});

beforeEach(() => {
  hoisted.sent.length = 0; hoisted.sessionWrites.length = 0; hoisted.page = null; hoisted.details = null; hoisted.session = {};
  parseWithClaude.mockClear(); loadAvailableJobs.mockClear(); setJobHidden.mockClear(); startApplyFlow.mockClear();
});

describe("jobListText — the Available Jobs tab as one text, 2 at a time", () => {
  it("numbers every card line and ends with how to answer", () => {
    const { text: t } = jobListText({ jobs: [card(), card({ jobId: "job2", title: "Care for Rosy", rate: "$26/hr", action: "Activate Membership" })], total: 2, hiddenCount: 0, radiusMiles: 25, hasCoords: true });
    expect(t.startsWith("Here's what's open right now:\n1. Senior care in San Jose · San Jose, CA, 95134 (5.7 mi away) · $10/hr · Part-time · Daytime · Sep 27, 2026 · Morning\n2. Care for Rosy")).toBe(true);
    expect(t).toContain("— Activate Membership"); // the gate button the card shows instead of Apply Now
    // The footer follows the list (2026-10-07): the apply example is job 1 (the applicable one), hide = the first shown, and the gated job gets the modal's line.
    expect(t.endsWith(`Want details on one, or want me to apply for you? Just say the number. For job 2 you'd need to activate membership first. If one's not for you, say hide and the number.`)).toBe(true);
  });
  it("uses the page's two empty states", () => {
    const empty = { jobs: [], total: 0, hiddenCount: 0, radiusMiles: 0, hasCoords: false };
    expect(jobListText(empty).text).toBe("Nothing's open near you right now. I'll let you know as soon as something new comes in.");
    expect(jobListText(empty, { filtered: true }).text).toBe("Nothing matches those filters right now. Tell me to show everything and I'll clear them.");
  });
  // Founder (2026-09-27): "show the latest ... and give the option to show more" — two per page.
  it("pages 2 at a time with MORE, numbering continuing, then says that's all", () => {
    const jobs = [1, 2, 3, 4, 5].map((n) => card({ jobId: `job${n}`, title: `Job ${n}` }));
    const page = { jobs, total: 5, hiddenCount: 0, radiusMiles: 25, hasCoords: true };
    const p1 = jobListText(page);
    expect(p1.text.startsWith("Here's what's open right now:\n1. Job 1")).toBe(true);
    expect(p1.text).toContain("\n2. Job 2");
    expect(p1.text).not.toContain("3. Job 3");
    expect(p1.text.endsWith(`Want details on one, or want me to apply for you? Just say the number. If one's not for you, say hide and the number. There are more too, just say more and I'll show the next two.`)).toBe(true);
    expect(p1.remaining).toBe(3);
    const p2 = jobListText(page, { from: 2 });
    expect(p2.text.startsWith("Here are the next ones:\n3. Job 3 ·")).toBe(true);
    expect(p2.text).toContain("\n4. Job 4 ·");
    expect(p2.text.endsWith(`Want details on one, or want me to apply for you? Just say the number. If one's not for you, say hide and the number. There are more too, just say more and I'll show the next two.`)).toBe(true); // numbering continues across pages
    const p3 = jobListText(page, { from: 4 });
    expect(p3.text.startsWith("Here are the next ones:\n5. Job 5 ·")).toBe(true);
    expect(p3.text.endsWith(`Want details on one, or want me to apply for you? Just say the number. If one's not for you, say hide and the number.`)).toBe(true);
    // A one-job list whose only job is gated offers no "apply" (the founder's live screenshot, 2026-10-07).
    expect(listFooter([{ action: "Set Up Transportation" }])).toBe(`Want details on one? Just say the number. For job 1 you'd need to set up transportation first. If one's not for you, say hide and the number.`);
    expect(LIST_FOOTER).toBe(`Want details on one, or want me to apply for you? Just say the number. If one's not for you, say hide and the number.`);
    expect(jobListText(page, { from: 5 }).text).toBe("That's everything that's open right now. Want details on any of them? Just say the number.");
  });
  it("the dashboard's nearest-4 (an explicit limit) is not paged", () => {
    const jobs = [1, 2, 3, 4].map((n) => card({ jobId: `job${n}` }));
    const { text } = jobListText({ jobs, total: 9, hiddenCount: 0, radiusMiles: 25, hasCoords: true }, { limited: true });
    expect(text.startsWith("Here's what's open near you:")).toBe(true);
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
    expect(t.endsWith(`Want me to apply for you? Or say another number and I'll pull that one up.`)).toBe(true);
  });
  it("shows exactly one footer: interview status, else application status, else the gate", () => {
    expect(jobDetailsText({ ...details, interviewStatus: "Interview Confirmed", applicationStatus: "Application Pending" }).endsWith("Interview Confirmed")).toBe(true);
    expect(jobDetailsText({ ...details, applicationStatus: "Application Pending" }).endsWith("Application Pending")).toBe(true);
    expect(jobDetailsText({ ...details, action: "Complete Verification" }).endsWith("To apply for this one you'd need to complete verification first.")).toBe(true);
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
    expect(hoisted.sent[0].startsWith("Here are the next ones:\n4. Job 4")).toBe(true);
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
    expect(hoisted.sent[0]).toBe("That job isn't open anymore.");
  });
});

// ── B3 (2026-10-11): the sidebar over text ───────────────────────────────────
const PAGE = (n = 3) => ({ jobs: Array.from({ length: n }, (_, i) => card({ jobId: `job${i + 1}`, title: `Job ${i + 1}` })), total: n, hiddenCount: 0, radiusMiles: 25, hasCoords: true });
const SESSION = { caregiverId: "cg1", chatId: "chat" };
const recentList = (filters?: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  lastJobList: { at: new Date().toISOString(), items: [{ number: 1, jobId: "job1", title: "Job 1" }, { number: 2, jobId: "job2", title: "Job 2" }], offset: 2, total: 3, ...(filters ? { filters } : {}) },
  ...extra,
});

describe("sendJobList with filters — the header names the sidebar set; MORE and refine keep it", () => {
  beforeEach(() => { parseWithClaude.mockResolvedValue("NONE"); });

  it("a filtered list says which filters (in the sidebar's order), no count, and stores them with the list", async () => {
    hoisted.page = PAGE();
    const r = await sendJobList("+1555", "chat", "cg1", { filters: { timeOfDay: ["morning"], payMin: 25, days: ["Sat", "Sun"] } });
    expect(hoisted.sent[0].startsWith("Here's what's open right now ($25+/hr, Morning, Sat, Sun):\n1. Job 1")).toBe(true);
    expect(hoisted.sent[0]).not.toMatch(/\d+ (matches|jobs found)/);
    expect(r.filters).toEqual({ payMin: 25, timeOfDay: ["morning"], days: ["Sat", "Sun"] });
    expect(r.filtersLabel).toBe("$25+/hr, Morning, Sat, Sun");
    expect(loadAvailableJobs).toHaveBeenCalledWith("cg1", { filters: { payMin: 25, timeOfDay: ["morning"], days: ["Sat", "Sun"] }, sort: undefined, limit: undefined });
    expect((hoisted.sessionWrites[0].data.lastJobList as any).filters).toEqual({ payMin: 25, timeOfDay: ["morning"], days: ["Sat", "Sun"] });
  });
  it("junk filter values are dropped (the sidebar's option sets only) and a junk-only set is the default view with no claim", async () => {
    hoisted.page = PAGE();
    await sendJobList("+1555", "chat", "cg1", { filters: { radiusMiles: 5, timeOfDay: ["dawn"] } as any });
    expect(hoisted.sent[0].startsWith("Here's what's open right now:\n")).toBe(true);
    expect(loadAvailableJobs).toHaveBeenCalledWith("cg1", { filters: {}, sort: undefined, limit: undefined });
    expect((hoisted.sessionWrites[0].data.lastJobList as any).filters).toBeUndefined();
  });
  it("the empty state is the page's 'Nothing matches those filters right now. Tell me to show everything and I'll clear them.' when a filter is set", async () => {
    hoisted.page = PAGE(0);
    await sendJobList("+1555", "chat", "cg1", { filters: { payMin: 99 } });
    expect(hoisted.sent[0]).toBe("Nothing matches those filters right now. Tell me to show everything and I'll clear them.");
  });
  it("MORE pages the SAME filtered list (filters carried from the session, numbering continues, header keeps the label)", async () => {
    hoisted.page = PAGE(3);
    hoisted.session = recentList({ timeOfDay: ["morning"] });
    const r = await sendJobList("+1555", "chat", "cg1", { more: true });
    expect(loadAvailableJobs).toHaveBeenCalledWith("cg1", { filters: { timeOfDay: ["morning"] }, sort: undefined, limit: undefined });
    expect(hoisted.sent[0].startsWith("Here are the next ones (Morning):\n3. Job 3")).toBe(true);
    expect(r.items.map((i) => i.number)).toEqual([1, 2, 3]);
    expect((hoisted.sessionWrites[0].data.lastJobList as any).filters).toEqual({ timeOfDay: ["morning"] });
  });
  it("refine merges the new control over the last set (\"only weekends\" keeps the mornings)", async () => {
    hoisted.page = PAGE(3);
    hoisted.session = recentList({ timeOfDay: ["morning"], payMin: 25 });
    await sendJobList("+1555", "chat", "cg1", { filters: { days: ["Sat", "Sun"] }, refine: true });
    expect(loadAvailableJobs).toHaveBeenCalledWith("cg1", { filters: { timeOfDay: ["morning"], payMin: 25, days: ["Sat", "Sun"] }, sort: undefined, limit: undefined });
    expect(hoisted.sent[0].startsWith("Here's what's open right now ($25+/hr, Morning, Sat, Sun):\n1. Job 1")).toBe(true); // a refined list starts the numbers over
  });
});

describe("extractJobBoardFilters — the quick model reads the words, the page's option sets validate", () => {
  it("JSON from the model → validated filters; prose around the JSON is tolerated; a distance is dropped", async () => {
    parseWithClaude.mockResolvedValueOnce('Here you go: {"timeOfDay":["morning"],"payMin":25,"days":["Sat","Sun"],"radiusMiles":5,"careTypes":["Hair"]}');
    expect(await extractJobBoardFilters("morning shifts over $25 on weekends within 5 miles")).toEqual({ filters: { payMin: 25, timeOfDay: ["morning"], days: ["Sat", "Sun"] }, clear: false });
    expect(parseWithClaude.mock.calls[0][1]).toBe("morning shifts over $25 on weekends within 5 miles");
    expect(parseWithClaude.mock.calls[0][0]).toContain("NO distance control");
  });
  it("NONE / parse errors / invalid JSON / empty words → no filters; clear:true is passed through", async () => {
    parseWithClaude.mockResolvedValueOnce("NONE");
    expect(await extractJobBoardFilters("hello there")).toEqual({ filters: {}, clear: false });
    parseWithClaude.mockResolvedValueOnce("__parse_error__");
    expect(await extractJobBoardFilters("mornings")).toEqual({ filters: {}, clear: false });
    parseWithClaude.mockResolvedValueOnce("{not json");
    expect(await extractJobBoardFilters("mornings")).toEqual({ filters: {}, clear: false });
    parseWithClaude.mockRejectedValueOnce(new Error("down"));
    expect(await extractJobBoardFilters("mornings")).toEqual({ filters: {}, clear: false });
    expect(await extractJobBoardFilters("   ")).toEqual({ filters: {}, clear: false });
    expect(parseWithClaude).toHaveBeenCalledTimes(4); // blank words never call the model
    parseWithClaude.mockResolvedValueOnce('{"clear":true}');
    expect(await extractJobBoardFilters("show everything", "refine")).toEqual({ filters: {}, clear: true });
    expect(parseWithClaude.mock.calls[4][0]).toContain("reply NONE");
  });
});

describe("jobListIsLatest — the job list owns MORE / picks / follow-ups only while it is the newest list, inside the window", () => {
  it("newest wins; another list texted later, no list, or a stale list → false", () => {
    const now = Date.now();
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();
    expect(jobListIsLatest({ lastJobList: { at: at(1000), items: [] } }, now)).toBe(true);
    expect(jobListIsLatest({ lastJobList: { at: at(1000), items: [] }, lastCalendarList: { at: at(500) } }, now)).toBe(false);
    expect(jobListIsLatest({ lastJobList: { at: at(1000), items: [] }, lastTimesheetList: { at: at(5000) } }, now)).toBe(true);
    expect(jobListIsLatest({}, now)).toBe(false);
    expect(jobListIsLatest({ lastJobList: { at: at(JOB_LIST_FOLLOW_UP_WINDOW_MS + 1), items: [] } }, now)).toBe(false);
  });
});

describe("handleJobsKeyword — JOBS · JOBS <words> · MORE · JOB n · HIDE n · APPLY TO n", () => {
  beforeEach(() => { hoisted.page = PAGE(3); parseWithClaude.mockResolvedValue("NONE"); });

  it("JOBS alone = the page as it opens (no model call, no filters)", async () => {
    expect(await handleJobsKeyword("+1555", "chat", "cg1", " jobs ", SESSION)).toBe("handled");
    expect(parseWithClaude).not.toHaveBeenCalled();
    expect(hoisted.sent[0].startsWith("Here's what's open right now:\n1. Job 1")).toBe(true);
    expect(await handleJobsKeyword("+1555", "chat", "cg1", "Available jobs", SESSION)).toBe("handled");
  });
  it("JOBS <words> → the extractor's filters, validated, named in the header", async () => {
    parseWithClaude.mockResolvedValueOnce('{"timeOfDay":["morning"],"payMin":25}');
    expect(await handleJobsKeyword("+1555", "chat", "cg1", "JOBS morning shifts over $25 within 5 miles", SESSION)).toBe("handled");
    expect(parseWithClaude.mock.calls[0][1]).toBe("morning shifts over $25 within 5 miles");
    expect(hoisted.sent[0].startsWith("Here's what's open right now ($25+/hr, Morning):\n1. Job 1")).toBe(true);
    expect(loadAvailableJobs).toHaveBeenCalledWith("cg1", { filters: { payMin: 25, timeOfDay: ["morning"] }, sort: undefined, limit: undefined });
  });
  it("JOBS <words> the sidebar can't do → the default view, no claim; 'clear' words → the default view too", async () => {
    parseWithClaude.mockResolvedValueOnce("NONE");
    await handleJobsKeyword("+1555", "chat", "cg1", "JOBS please", SESSION);
    expect(hoisted.sent[0].startsWith("Here's what's open right now:\n")).toBe(true);
    parseWithClaude.mockResolvedValueOnce('{"clear":true,"days":["Mon"]}');
    await handleJobsKeyword("+1555", "chat", "cg1", "JOBS clear the filters", SESSION);
    expect(hoisted.sent[1].startsWith("Here's what's open right now:\n")).toBe(true);
    expect(loadAvailableJobs).toHaveBeenLastCalledWith("cg1", { filters: {}, sort: undefined, limit: undefined });
  });
  it("MORE / JOB n / HIDE n / APPLY TO n index the list that was texted — only while it is the newest list", async () => {
    hoisted.session = recentList({ days: ["Sat"] });
    const session = { ...SESSION, ...hoisted.session };
    expect(await handleJobsKeyword("+1555", "chat", "cg1", "MORE", session)).toBe("handled");
    expect(hoisted.sent[0].startsWith("Here are the next ones (Sat):\n3. Job 3")).toBe(true);
    hoisted.details = { ok: true, details: { ...card({ jobId: "job2", title: "Job 2" }), postedBy: null, startingDate: null, time: null, hoursPerWeek: null, description: null, interviewStatus: null, applicationStatus: null } };
    expect(await handleJobsKeyword("+1555", "chat", "cg1", "job 2", session)).toBe("handled");
    expect(hoisted.sent[1].startsWith("Job 2")).toBe(true);
    expect(await handleJobsKeyword("+1555", "chat", "cg1", "hide 1", session)).toBe("handled");
    expect(setJobHidden).toHaveBeenCalledWith("cg1", "job1", true);
    expect(hoisted.sent[2]).toBe("Done, that one's hidden.");
    expect(await handleJobsKeyword("+1555", "chat", "cg1", "apply to 2", session)).toBe("handled");
    expect(startApplyFlow).toHaveBeenCalledWith("+1555", "chat", expect.objectContaining({ caregiverId: "cg1" }), { caregiverId: "cg1", jobId: "job2" });
    expect(await handleJobsKeyword("+1555", "chat", "cg1", "JOB 7", session)).toBe("handled");
    expect(hoisted.sent[3]).toBe("I don't see a job 7 on the list I sent. Say jobs and I'll send it again.");
    // Another page's list is newer → none of these are the job list's (they route on).
    const stale = { ...session, lastCalendarList: { at: new Date(Date.now() + 1000).toISOString() } };
    expect(await handleJobsKeyword("+1555", "chat", "cg1", "MORE", stale)).toBe("passthrough");
    expect(await handleJobsKeyword("+1555", "chat", "cg1", "hide 1", stale)).toBe("passthrough");
    expect(await handleJobsKeyword("+1555", "chat", "cg1", "what's new", session)).toBe("passthrough");
  });
});

describe("handleJobsFilterFollowUp — \"only weekends\" right after the list narrows it", () => {
  beforeEach(() => { hoisted.page = PAGE(3); parseWithClaude.mockResolvedValue("NONE"); });

  it("refines the last filters when the model reads a filter change; the header names the merged set", async () => {
    hoisted.session = recentList({ timeOfDay: ["morning"] });
    const session = { ...SESSION, ...hoisted.session };
    parseWithClaude.mockResolvedValueOnce('{"days":["Sat","Sun"]}');
    expect(await handleJobsFilterFollowUp("+1555", "chat", "cg1", "only weekends", session)).toBe("handled");
    expect(parseWithClaude.mock.calls[0][1]).toBe("only weekends");
    expect(loadAvailableJobs).toHaveBeenCalledWith("cg1", { filters: { timeOfDay: ["morning"], days: ["Sat", "Sun"] }, sort: undefined, limit: undefined });
    expect(hoisted.sent[0].startsWith("Here's what's open right now (Morning, Sat, Sun):\n1. Job 1")).toBe(true);
  });
  it("NONE → passthrough (the agent gets the text); a bare number never asks the model; no recent job list → passthrough", async () => {
    hoisted.session = recentList();
    const session = { ...SESSION, ...hoisted.session };
    expect(await handleJobsFilterFollowUp("+1555", "chat", "cg1", "can I apply to both?", session)).toBe("passthrough");
    expect(parseWithClaude).toHaveBeenCalledTimes(1);
    expect(await handleJobsFilterFollowUp("+1555", "chat", "cg1", "2", session)).toBe("passthrough");
    expect(parseWithClaude).toHaveBeenCalledTimes(1);
    expect(await handleJobsFilterFollowUp("+1555", "chat", "cg1", "only weekends", SESSION)).toBe("passthrough");
    expect(parseWithClaude).toHaveBeenCalledTimes(1);
    expect(hoisted.sent).toEqual([]);
  });
  it("\"show everything\" (clear) → the default view", async () => {
    hoisted.session = recentList({ payMin: 30 });
    const session = { ...SESSION, ...hoisted.session };
    parseWithClaude.mockResolvedValueOnce('{"clear":true}');
    expect(await handleJobsFilterFollowUp("+1555", "chat", "cg1", "never mind, show everything", session)).toBe("handled");
    expect(hoisted.sent[0].startsWith("Here's what's open right now:\n1. Job 1")).toBe(true);
  });
});
