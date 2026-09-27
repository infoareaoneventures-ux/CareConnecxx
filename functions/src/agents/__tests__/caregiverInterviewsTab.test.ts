import { describe, it, expect, vi, beforeEach } from "vitest";

// The caregiver Interviews tab as data — every rule pinned here is copied from
// components/caregiver/JobBoard.tsx (statuses, order, chips, card fields, Join
// rule, the exact buttons per row, gate, empty state).

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeQuery = (coll: string, filters: Array<[string, string, any]>): any => ({
    where: (f: string, op: string, v: any) => makeQuery(coll, [...filters, [f, op, v]]),
    orderBy: () => makeQuery(coll, filters),
    limit: () => makeQuery(coll, filters),
    get: vi.fn(async () => {
      let items = Array.from(docState.entries())
        .filter(([p]) => p.startsWith(`${coll}/`) && p.split("/").length === 2)
        .map(([p, d]) => ({ id: p.split("/")[1], data: () => d }));
      for (const [f, op, v] of filters) items = items.filter((it) => (op === "==" ? it.data()[f] === v : true));
      return { empty: items.length === 0, docs: items };
    }),
  });
  const makeCollRef = (coll: string): any => ({
    doc: (id: string) => ({ id, get: vi.fn(async () => ({ exists: docState.has(`${coll}/${id}`), data: () => docState.get(`${coll}/${id}`) })) }),
    ...makeQuery(coll, []),
  });
  return { docState, collectionMock: vi.fn((c: string) => makeCollRef(c)), reset: () => docState.clear() };
});
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: hoisted.collectionMock }), { FieldValue: { delete: () => ({ __delete: true }), serverTimestamp: () => ({ __ts: true }) } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../ai/scoring", () => ({ haversineMiles: () => undefined }));

import {
  displayInterviewStatus, interviewTimeIso, joinVideoCallUrl, interviewActions, listCaregiverInterviews, isSiteInterviewSlot, interviewTypeLabel,
} from "../caregiverInterviewsTab";

const CG = "cg1";
const cleared = { membershipStatus: "active", verified: true };
const iv = (id: string, d: Record<string, unknown>) => hoisted.docState.set(`video_interviews/${id}`, { caregiverId: CG, clientId: "fam1", clientName: "A Family", ...d });

beforeEach(() => { hoisted.reset(); hoisted.docState.set(`caregivers/${CG}`, cleared); });

describe("pure rules", () => {
  it("requested / scheduled read as pending; time falls back like the page", () => {
    expect(displayInterviewStatus("requested")).toBe("pending");
    expect(displayInterviewStatus("scheduled")).toBe("pending");
    expect(displayInterviewStatus("confirmed")).toBe("confirmed");
    expect(displayInterviewStatus(undefined)).toBe("pending");
    expect(interviewTimeIso({ scheduledAt: "2026-10-01T17:00:00.000Z" })).toBe("2026-10-01T17:00:00.000Z");
    expect(interviewTimeIso({ scheduledDateTime: { toDate: () => new Date("2026-10-02T17:00:00.000Z") } })).toBe("2026-10-02T17:00:00.000Z");
    expect(interviewTimeIso({})).toBeNull();
    expect(interviewTypeLabel({ interviewType: "in-person" })).toBe("In Person");
    expect(interviewTypeLabel({})).toBe("Video");
  });
  it("Join video call: a Meet link, only while pending / accepted / confirmed", () => {
    expect(joinVideoCallUrl({ callUrl: "https://meet.google.com/abc" }, "pending")).toBe("https://meet.google.com/abc");
    expect(joinVideoCallUrl({ callUrl: "https://meet.google.com/abc" }, "completed")).toBeNull();
    expect(joinVideoCallUrl({ callUrl: "https://zoom.us/j/1" }, "accepted")).toBeNull();
  });
  it("buttons per row, exactly as the page renders them", () => {
    expect(interviewActions("pending", null, null, null)).toEqual(["Details", "Propose new time", "Decline", "Accept"]);
    expect(interviewActions("pending", null, "membership", null)).toEqual(["Details", "Decline", "Activate Membership"]);
    expect(interviewActions("pending", null, "background", null)).toEqual(["Details", "Decline", "Complete Verification"]);
    expect(interviewActions("pending", { by: "caregiver" }, null, null)).toEqual(["Details", "Decline"]);
    expect(interviewActions("pending", { by: "client" }, null, null)).toEqual(["Details", "Propose different time", "Decline", "Accept new time"]);
    expect(interviewActions("accepted", null, null, "https://meet.google.com/x")).toEqual(["Details", "Join video call", "Reschedule", "Cancel"]);
    expect(interviewActions("accepted", { by: "caregiver" }, null, null)).toEqual(["Details", "Cancel"]);
    expect(interviewActions("accepted", { by: "client" }, "membership", null)).toEqual(["Details", "Propose different time", "Cancel", "Accept new time"]); // accepted rows aren't gated
    expect(interviewActions("completed", null, null, null)).toEqual(["Details"]);
    expect(interviewActions("declined", null, null, null)).toEqual(["Details"]);
  });
  it("the site's picker: 9:00–18:00 on the hour or half hour", () => {
    expect(isSiteInterviewSlot("09:00")).toBe(true);
    expect(isSiteInterviewSlot("14:30")).toBe(true);
    expect(isSiteInterviewSlot("18:00")).toBe(true);
    expect(isSiteInterviewSlot("18:30")).toBe(false);
    expect(isSiteInterviewSlot("08:30")).toBe(false);
    expect(isSiteInterviewSlot("10:15")).toBe(false);
    expect(isSiteInterviewSlot("nope")).toBe(false);
  });
});

describe("listCaregiverInterviews — the tab", () => {
  it("sorts pending → accepted → confirmed → completed → declined → cancelled then by time, drops blocked families, joins the application", async () => {
    iv("late",     { status: "requested", scheduledTime: "2026-10-05T17:00:00.000Z", jobId: "j1", jobTitle: "Weekend care" });
    iv("early",    { status: "scheduled", scheduledTime: "2026-10-01T17:00:00.000Z" });
    iv("acc",      { status: "accepted",  scheduledTime: "2026-09-30T17:00:00.000Z", callUrl: "https://meet.google.com/abc", notes: "bring ID" });
    iv("done",     { status: "completed", scheduledTime: "2026-09-01T17:00:00.000Z" });
    iv("blocked",  { status: "requested", scheduledTime: "2026-10-01T17:00:00.000Z", clientId: "bad" });
    hoisted.docState.set(`users/${CG}`, { blockedUsers: ["bad"] });
    hoisted.docState.set("job_applications/a1", { caregiverId: CG, jobId: "j1", jobLocation: "San Jose, CA", jobRate: 26 });
    const tab = await listCaregiverInterviews(CG);
    expect(tab.interviews.map((r) => r.interviewId)).toEqual(["early", "late", "acc", "done"]);
    expect(tab.count).toBe(4);
    expect(tab.emptyText).toBeUndefined();
    const late = tab.interviews[1];
    expect(late.status).toBe("pending");
    expect(late.jobTitle).toBe("Weekend care");
    expect(late.jobLocation).toBe("San Jose, CA");
    expect(late.rate).toBe("$26/hr");
    expect(late.actions).toEqual(["Details", "Propose new time", "Decline", "Accept"]);
    const early = tab.interviews[0];
    expect(early.jobTitle).toBe("Interview");
    expect(early.rate).toBeNull();
    const acc = tab.interviews[2];
    expect(acc.joinVideoCall).toBe("https://meet.google.com/abc");
    expect(acc.notes).toBe("bring ID");
    expect(acc.actions).toEqual(["Details", "Join video call", "Reschedule", "Cancel"]);
    expect(acc.scheduledTimeLocal).toBe("Wednesday, September 30 at 10:00 AM");
  });

  it("chips filter by display status; 'requested' rows show under pending", async () => {
    iv("a", { status: "requested", scheduledTime: "2026-10-01T17:00:00.000Z" });
    iv("b", { status: "cancelled", scheduledTime: "2026-10-01T17:00:00.000Z" });
    expect((await listCaregiverInterviews(CG, "pending")).interviews.map((r) => r.interviewId)).toEqual(["a"]);
    expect((await listCaregiverInterviews(CG, "cancelled")).interviews.map((r) => r.interviewId)).toEqual(["b"]);
    expect((await listCaregiverInterviews(CG, "bogus")).count).toBe(2); // unknown chip = All
  });

  it("a gated caregiver's pending row keeps Decline and swaps Accept for the gate button", async () => {
    hoisted.docState.set(`caregivers/${CG}`, { membershipPaid: false });
    iv("a", { status: "requested", scheduledTime: "2026-10-01T17:00:00.000Z" });
    const tab = await listCaregiverInterviews(CG);
    expect(tab.interviews[0].actions).toEqual(["Details", "Decline", "Activate Membership"]);
  });

  it("the family's pending proposal shows the banner and Accept new time", async () => {
    iv("a", { status: "accepted", scheduledTime: "2026-10-01T17:00:00.000Z", reschedulePendingTime: "2026-10-03T17:00:00.000Z", rescheduledBy: "client" });
    const row = (await listCaregiverInterviews(CG)).interviews[0];
    expect(row.proposal?.by).toBe("client");
    expect(row.proposal?.banner).toContain("A Family proposed a new time: Saturday, October 3 at 10:00 AM");
    expect(row.actions).toEqual(["Details", "Propose different time", "Cancel", "Accept new time"]);
  });

  it("empty state is the tab's own words", async () => {
    const tab = await listCaregiverInterviews(CG);
    expect(tab).toMatchObject({ interviews: [], count: 0, emptyText: "No interviews yet." });
  });
});
