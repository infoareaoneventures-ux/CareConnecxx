// interviewsTab.ts — Care Requests > Interviews tab as one read (2026-09-17).
// Pins the page's status normalisation, sort, job banner join, booking line
// labels and the exact button conditions from PostsPage.tsx.
import { describe, it, expect, vi, beforeEach } from "vitest";

// The first Intl timezone format in a fresh worker can take several seconds
// under a loaded full-suite run — not a logic timeout.
vi.setConfig({ testTimeout: 20000 });

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeQuery = (coll: string, conds: Array<[string, string, any]>): any => ({
    where: (f: string, op: string, v: any) => makeQuery(coll, [...conds, [f, op, v]]),
    get: async () => {
      const prefix = `${coll}/`;
      const docs = [...docState.entries()]
        .filter(([p]) => p.startsWith(prefix))
        .filter(([, d]) => conds.every(([f, op, v]) => op === "in" ? (v as any[]).includes(d?.[f]) : d?.[f] === v))
        .map(([p, d]) => ({ id: p.slice(prefix.length), data: () => d }));
      return { empty: docs.length === 0, docs };
    },
  });
  return {
    docState,
    collectionMock: vi.fn((c: string) => ({ where: (f: string, op: string, v: any) => makeQuery(c, [[f, op, v]]) })),
    reset: () => docState.clear(),
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock }), { FieldValue: {} });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});

import { listClientInterviews, storedStatusesForFilter } from "../interviewsTab";

const C = "c1";
const NOW = Date.parse("2026-09-17T20:00:00.000Z");
const iv = (id: string, over: Record<string, unknown>) =>
  hoisted.docState.set(`video_interviews/${id}`, { clientId: C, caregiverId: "cg1", caregiverName: "Basra Yousuf", interviewType: "video", ...over });

beforeEach(() => hoisted.reset());

describe("storedStatusesForFilter (the page's filter pills)", () => {
  it("maps the page's pending pill onto the stored 'requested' status", () => {
    expect(storedStatusesForFilter("pending")).toEqual(["requested", "scheduled", "pending"]);
    expect(storedStatusesForFilter("accepted")).toEqual(["accepted", "confirmed"]);
    expect(storedStatusesForFilter("cancelled")).toEqual(["cancelled"]);
    expect(storedStatusesForFilter(undefined)).toBeNull();
    expect(storedStatusesForFilter("all")).toBeNull();
  });
});

describe("listClientInterviews", () => {
  it("normalises statuses like the page and sorts pending → accepted → completed → declined → cancelled, active soonest first, resolved most recent first", async () => {
    iv("a", { status: "accepted",  scheduledTime: "2026-09-20T21:00:00.000Z" });
    iv("p2", { status: "requested", scheduledTime: "2026-09-22T23:00:00.000Z" });
    iv("p1", { status: "requested", scheduledTime: "2026-09-19T23:00:00.000Z" });
    iv("c1", { status: "completed", scheduledTime: "2026-09-13T21:00:00.000Z" });
    iv("c2", { status: "completed", scheduledTime: "2026-09-14T01:30:00.000Z" });
    iv("x", { status: "cancelled", scheduledTime: "2026-09-13T04:10:00.000Z" });
    const rows = await listClientInterviews(C, undefined, NOW);
    expect(rows.map((r) => r.interviewId)).toEqual(["p1", "p2", "a", "c2", "c1", "x"]);
    expect(rows[0].displayStatus).toBe("pending");
    expect(rows[0].status).toBe("requested");
    expect(rows[0].scheduledTimeLocal).toBe("Saturday, September 19 at 4:00 PM");
  });

  it("applies the filter pill using stored statuses", async () => {
    iv("p", { status: "requested", scheduledTime: "2026-09-19T23:00:00.000Z" });
    iv("a", { status: "accepted", scheduledTime: "2026-09-20T21:00:00.000Z" });
    expect((await listClientInterviews(C, "pending", NOW)).map((r) => r.interviewId)).toEqual(["p"]);
    expect((await listClientInterviews(C, "accepted", NOW)).map((r) => r.interviewId)).toEqual(["a"]);
  });

  it("joins the linked job post banner (title, location, rate, frequency, care types)", async () => {
    hoisted.docState.set("job_posts/job1", { clientId: C, title: "Senior care in San Jose", city: "San Jose", zipCode: "95130", rate: 31, jobFrequency: "full-time", careTypes: ["Companionship"] });
    iv("a", { status: "accepted", jobId: "job1", scheduledTime: "2026-09-20T21:00:00.000Z" });
    const [row] = await listClientInterviews(C, undefined, NOW);
    expect(row.job).toEqual({ title: "Senior care in San Jose", location: "San Jose, 95130", rate: 31, frequency: "full time", careTypes: ["Companionship"] });
    expect(row.jobTitle).toBe("Senior care in San Jose");
  });

  it("pending/accepted rows: Join (meet link only), Message, Propose/Reschedule, Cancel; Mark as Completed only once the time has passed", async () => {
    iv("future", { status: "accepted", callUrl: "https://meet.google.com/abc-defg-hij", scheduledTime: "2026-09-20T21:00:00.000Z", notes: "2pm" });
    iv("past", { status: "accepted", callUrl: "https://zoom.us/x", scheduledTime: "2026-09-13T21:00:00.000Z" });
    iv("req", { status: "requested", scheduledTime: "2026-09-21T21:00:00.000Z" });
    const byId = Object.fromEntries((await listClientInterviews(C, undefined, NOW)).map((r) => [r.interviewId, r]));
    expect(byId.future.actions).toEqual(["join_video_call", "message", "propose_time", "cancel"]);
    expect(byId.future.notes).toBe("2pm");
    expect(byId.past.actions).toEqual(["message", "propose_time", "cancel", "mark_completed"]);
    expect(byId.req.actions).toEqual(["message", "propose_time", "cancel"]);
  });

  it("a pending reschedule proposal: the caregiver's adds Accept new time (and a counter-proposal); the family's own hides Propose and shows only Cancel", async () => {
    iv("theirs", { status: "accepted", scheduledTime: "2026-09-20T21:00:00.000Z", reschedulePendingTime: "2026-09-21T21:00:00.000Z", rescheduledBy: "caregiver" });
    iv("mine",   { status: "accepted", scheduledTime: "2026-09-22T21:00:00.000Z", reschedulePendingTime: "2026-09-23T21:00:00.000Z", rescheduledBy: "client" });
    const byId = Object.fromEntries((await listClientInterviews(C, undefined, NOW)).map((r) => [r.interviewId, r]));
    expect(byId.theirs.actions).toEqual(["message", "accept_new_time", "propose_time", "cancel"]);
    expect(byId.theirs.rescheduleWaitingOn).toBe("you");
    expect(byId.theirs.reschedulePendingTimeLocal).toBe("Monday, September 21 at 2:00 PM");
    expect(byId.mine.actions).toEqual(["message", "cancel"]);
    expect(byId.mine.rescheduleWaitingOn).toBe("caregiver");
  });

  it("completed rows carry the page's booking line and buttons: sent → Cancel; accepted with shifts → label only; finished → Re-book; declined/cancelled → Resend; none → Not Selected + Send Booking", async () => {
    iv("sent",     { status: "completed", jobId: "job1", scheduledTime: "2026-09-10T21:00:00.000Z" });
    iv("active",   { status: "completed", jobId: "job2", scheduledTime: "2026-09-11T21:00:00.000Z" });
    iv("finished", { status: "completed", jobId: "job3", scheduledTime: "2026-09-12T21:00:00.000Z" });
    iv("cancel",   { status: "completed", scheduledTime: "2026-09-13T04:10:00.000Z" });
    iv("fresh",    { status: "completed", scheduledTime: "2026-09-13T21:00:00.000Z" });
    hoisted.docState.set("booking_requests/b1", { clientId: C, caregiverId: "cg1", jobId: "job1", status: "pending" });
    hoisted.docState.set("booking_requests/b2", { clientId: C, caregiverId: "cg1", jobId: "job2", status: "accepted" });
    hoisted.docState.set("booking_requests/b3", { clientId: C, caregiverId: "cg1", jobId: "job3", status: "accepted" });
    // Same pairing, older declined doc — the page keeps the higher-priority status.
    hoisted.docState.set("booking_requests/b3old", { clientId: C, caregiverId: "cg1", jobId: "job3", status: "declined" });
    hoisted.docState.set("booking_requests/b4", { clientId: C, caregiverId: "cg1", interviewId: "cancel", status: "cancelled" });
    hoisted.docState.set("shifts/s1", { clientId: C, bookingRequestId: "b2", status: "scheduled" });
    const byId = Object.fromEntries((await listClientInterviews(C, undefined, NOW)).map((r) => [r.interviewId, r]));
    expect(byId.sent.booking).toMatchObject({ id: "b1", status: "pending", label: "Booking sent · Awaiting response" });
    expect(byId.sent.actions).toEqual(["cancel_pending_booking"]);
    expect(byId.active.booking).toMatchObject({ status: "accepted", label: "Booking accepted", hasActiveShifts: true });
    expect(byId.active.actions).toEqual([]);
    expect(byId.finished.booking).toMatchObject({ id: "b3", status: "accepted", hasActiveShifts: false });
    expect(byId.finished.actions).toEqual(["rebook"]);
    expect(byId.cancel.booking).toMatchObject({ status: "cancelled", label: "Visit cancelled" });
    expect(byId.cancel.actions).toEqual(["resend"]);
    expect(byId.fresh.booking).toBeNull();
    expect(byId.fresh.actions).toEqual(["not_selected", "send_booking"]);
  });

  it("declined rows: Not Selected shows nothing; a caregiver decline with a job offers View Other Applicants; a counter-proposed time offers Accept / Propose another", async () => {
    iv("ns",   { status: "declined", declinedBy: "client", jobId: "job1", scheduledTime: "2026-09-10T21:00:00.000Z" });
    iv("cgd",  { status: "declined", jobId: "job1", scheduledTime: "2026-09-11T21:00:00.000Z" });
    iv("prop", { status: "declined", scheduledTime: "2026-09-12T21:00:00.000Z", proposedTime: "2026-09-25T21:00:00.000Z" });
    const byId = Object.fromEntries((await listClientInterviews(C, undefined, NOW)).map((r) => [r.interviewId, r]));
    expect(byId.ns).toMatchObject({ notSelected: true, actions: [] });
    expect(byId.cgd.actions).toEqual(["view_other_applicants"]);
    expect(byId.prop.actions).toEqual(["accept_proposed_time", "propose_another_time"]);
    expect(byId.prop.proposedTimeLocal).toBe("Friday, September 25 at 2:00 PM");
  });

  it("never reads another client's interviews", async () => {
    iv("mine", { status: "accepted", scheduledTime: "2026-09-20T21:00:00.000Z" });
    hoisted.docState.set("video_interviews/other", { clientId: "c2", caregiverId: "cg9", status: "accepted", scheduledTime: "2026-09-20T21:00:00.000Z" });
    expect((await listClientInterviews(C, undefined, NOW)).map((r) => r.interviewId)).toEqual(["mine"]);
  });
});
