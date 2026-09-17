// bookingSend.ts — the website's own Send Booking write, server-side
// (2026-09-17). Pins that Evia's fresh booking produces EXACTLY the site's
// booking_requests doc + side effects (PostsPage.tsx handleSendBooking), with
// no agent_tasks staging and no shift offer — and that the site's own
// duplicate guard and the bookable-caregiver gate refuse before any write.
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const adds: Array<{ path: string; data: any; id: string }> = [];
  let addSeq = 0;
  const resolve = (base: any, k: string, v: any) => {
    if (v && typeof v === "object" && v.__delete) delete base[k];
    else base[k] = v;
  };
  const makeDocRef = (coll: string, id: string): any => {
    const path = `${coll}/${id}`;
    return {
      id, path,
      get: async () => ({ exists: docState.has(path), id, data: () => docState.get(path), ref: makeDocRef(coll, id) }),
      update: async (data: any) => {
        const cur = { ...(docState.get(path) ?? {}) };
        for (const [k, v] of Object.entries(data)) resolve(cur, k, v);
        docState.set(path, cur);
      },
      set: async (data: any) => { docState.set(path, { ...data }); },
    };
  };
  const makeQuery = (coll: string, conds: Array<[string, string, any]>, lim?: number): any => ({
    where: (f: string, op: string, v: any) => makeQuery(coll, [...conds, [f, op, v]], lim),
    limit: (n: number) => makeQuery(coll, conds, n),
    get: async () => {
      const prefix = `${coll}/`;
      let docs = [...docState.entries()]
        .filter(([p]) => p.startsWith(prefix))
        .filter(([, d]) => conds.every(([f, , v]) => d?.[f] === v))
        .map(([p, d]) => { const id = p.slice(prefix.length); return { id, data: () => d, ref: makeDocRef(coll, id) }; });
      if (lim) docs = docs.slice(0, lim);
      return { empty: docs.length === 0, docs, size: docs.length };
    },
  });
  const makeColl = (coll: string): any => ({
    doc: (id: string) => makeDocRef(coll, id),
    where: (f: string, op: string, v: any) => makeQuery(coll, [[f, op, v]]),
    add: async (data: any) => {
      const id = `${coll}-${++addSeq}`;
      docState.set(`${coll}/${id}`, { ...data });
      adds.push({ path: coll, data, id });
      return makeDocRef(coll, id);
    },
  });
  return {
    docState, adds,
    collectionMock: vi.fn((c: string) => makeColl(c)),
    reset: () => { docState.clear(); adds.length = 0; addSeq = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: () => ({ __delete: true }), serverTimestamp: () => ({ __serverTimestamp: true }) },
  });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});
const logAudit = vi.fn(async () => {});
vi.mock("../../observability/auditLog", () => ({ logAudit: (...a: unknown[]) => (logAudit as any)(...a) }));

import { sendBookingRequest, findBlockingBookingRequest } from "../bookingSend";

const BOOKABLE_CG = {
  name: "Basra Yousuf", photo: "https://cdn/basra.jpg",
  status: "active", onboardingStatus: "profile_complete", verificationStatus: "approved",
  backgroundCheckStatus: "clear",
};

function baseInput(overrides: Record<string, unknown> = {}): any {
  return {
    clientId: "c1", caregiverId: "cg1", caregiverName: "Basra Yousuf",
    jobId: "job-1", jobTitle: "Senior care in San Jose", interviewId: "iv-1",
    address: "4746 Campbell Ave, San Jose, CA 95130", rate: 33,
    careNeeds: ["Companionship"], careRecipients: [{ name: "Samira", relationship: "Mother", age: 82 }],
    lifestylePreferences: ["Pets in home"], emergencyContact: { name: "Jane Doe", phone: "+15551234567", relationship: "Daughter" },
    schedule: { days: ["Tue", "Wed"], startDate: "2026-09-22", endDate: null, ongoing: true,
      dayShiftTimes: { Tue: [{ start: "10:00", end: "15:00" }], Wed: [{ start: "11:00", end: "13:00" }] } },
    notes: "please come in through the side door",
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.reset();
  logAudit.mockClear();
  hoisted.docState.set("caregivers/cg1", BOOKABLE_CG);
  hoisted.docState.set("users/c1", { firstName: "Hamse", lastName: "Warfa", photoURL: "https://cdn/hamse.jpg" });
});

describe("sendBookingRequest — the site's handleSendBooking write", () => {
  it("adds ONE booking_requests doc in the site's exact shape (status pending, isResend false, createdAt), no agent_tasks, no shift_offers", async () => {
    const res = await sendBookingRequest(baseInput(), { source: "bookingFlow" });
    expect(res).toEqual({ ok: true, bookingRequestId: "booking_requests-1" });

    const br = hoisted.adds.filter((a) => a.path === "booking_requests");
    expect(br).toHaveLength(1);
    expect(br[0].data).toEqual({
      clientId: "c1", clientName: "Hamse Warfa", clientPhotoURL: "https://cdn/hamse.jpg",
      caregiverId: "cg1", caregiverName: "Basra Yousuf", caregiverPhotoURL: "https://cdn/basra.jpg",
      jobId: "job-1", jobTitle: "Senior care in San Jose",
      address: "4746 Campbell Ave, San Jose, CA 95130", rate: 33, paymentMethod: "credit",
      careNeeds: ["Companionship"], careRecipients: [{ name: "Samira", relationship: "Mother", age: 82 }],
      lifestylePreferences: ["Pets in home"],
      emergencyContact: { name: "Jane Doe", phone: "+15551234567", relationship: "Daughter" },
      schedule: { days: ["Tue", "Wed"], startDate: "2026-09-22", endDate: null, ongoing: true,
        dayShiftTimes: { Tue: [{ start: "10:00", end: "15:00" }], Wed: [{ start: "11:00", end: "13:00" }] } },
      notes: "please come in through the side door", interviewId: "iv-1",
      status: "pending", isResend: false, createdAt: { __serverTimestamp: true },
    });
    // The retired pipeline's fingerprints must never come back.
    expect(br[0].data.agentTaskId).toBeUndefined();
    expect(hoisted.adds.some((a) => a.path === "agent_tasks")).toBe(false);
    expect(hoisted.adds.some((a) => a.path === "shift_offers")).toBe(false);
  });

  it("records the site's hire_decisions row and marks the caregiver's job application accepted (by caregiverId + jobId)", async () => {
    hoisted.docState.set("job_applications/app-1", { caregiverId: "cg1", jobId: "job-1", status: "pending" });
    hoisted.docState.set("job_applications/app-other", { caregiverId: "cg2", jobId: "job-1", status: "pending" });

    await sendBookingRequest(baseInput(), { source: "bookingFlow" });

    const hd = hoisted.adds.find((a) => a.path === "hire_decisions")!;
    expect(hd.data).toEqual({
      clientId: "c1", clientName: "Hamse Warfa", caregiverId: "cg1", caregiverName: "Basra Yousuf",
      decision: "hire", createdAt: { __serverTimestamp: true },
    });
    expect(hoisted.docState.get("job_applications/app-1")).toMatchObject({ status: "accepted", acceptedAt: { __serverTimestamp: true } });
    expect(hoisted.docState.get("job_applications/app-other").status).toBe("pending");
  });

  it("with no jobId, falls back to the known applicationId; blank notes are stored as null like the site", async () => {
    hoisted.docState.set("job_applications/app-9", { caregiverId: "cg1", status: "pending" });
    await sendBookingRequest(baseInput({ jobId: null, applicationId: "app-9", notes: "   " }), { source: "bookingFlow" });
    expect(hoisted.docState.get("job_applications/app-9").status).toBe("accepted");
    const br = hoisted.adds.find((a) => a.path === "booking_requests")!;
    expect(br.data.jobId).toBeNull();
    expect(br.data.notes).toBeNull();
  });

  it("prefers a web client's displayName for clientName, and writes null photos when none are on file", async () => {
    hoisted.docState.set("users/c1", { displayName: "The Warfa Family", firstName: "Hamse" });
    hoisted.docState.set("caregivers/cg1", { ...BOOKABLE_CG, photo: undefined });
    await sendBookingRequest(baseInput(), { source: "bookingFlow" });
    const br = hoisted.adds.find((a) => a.path === "booking_requests")!;
    expect(br.data.clientName).toBe("The Warfa Family");
    expect(br.data.clientPhotoURL).toBeNull();
    expect(br.data.caregiverPhotoURL).toBeNull();
  });

  it("refuses an unbookable caregiver (background check still in review) BEFORE any write", async () => {
    // 2 days 23h ago → Math.ceil lands on 3 regardless of the milliseconds the test takes.
    const submittedAt = new Date(Date.now() - (3 * 24 - 1) * 60 * 60 * 1000).toISOString();
    hoisted.docState.set("caregivers/cg1", { ...BOOKABLE_CG, verificationStatus: "submitted", backgroundCheckStatus: "pending", backgroundCheckData: { submittedAt } });
    const res = await sendBookingRequest(baseInput(), { source: "bookingFlow" });
    expect(res).toEqual({ ok: false, reason: "caregiver_not_bookable", daysInReview: 3 });
    expect(hoisted.adds).toHaveLength(0);
  });

  it("the site's duplicate guard: a pending request for the same caregiver + job pairing blocks a second doc", async () => {
    hoisted.docState.set("booking_requests/br-old", { clientId: "c1", caregiverId: "cg1", jobId: "job-1", status: "pending", createdAt: "2026-09-10T00:00:00Z" });
    const res = await sendBookingRequest(baseInput(), { source: "bookingFlow" });
    expect(res).toEqual({ ok: false, reason: "already_pending", bookingRequestId: "br-old" });
    expect(hoisted.adds).toHaveLength(0);
  });

  it("an accepted request blocks only while it still has a scheduled shift; once every visit is done a fresh request is allowed", async () => {
    hoisted.docState.set("booking_requests/br-acc", { clientId: "c1", caregiverId: "cg1", jobId: "job-1", status: "accepted", createdAt: "2026-09-01T00:00:00Z" });
    hoisted.docState.set("shifts/s1", { bookingRequestId: "br-acc", status: "scheduled" });
    expect(await findBlockingBookingRequest("c1", "cg1", "job-1", "iv-1")).toEqual({ reason: "already_active", bookingRequestId: "br-acc" });

    hoisted.docState.set("shifts/s1", { bookingRequestId: "br-acc", status: "completed" });
    expect(await findBlockingBookingRequest("c1", "cg1", "job-1", "iv-1")).toBeNull();
    const res = await sendBookingRequest(baseInput(), { source: "bookingFlow" });
    expect(res.ok).toBe(true);
  });

  it("a declined or cancelled prior request never blocks, and a different job pairing with the same caregiver is independent", async () => {
    hoisted.docState.set("booking_requests/br-dec", { clientId: "c1", caregiverId: "cg1", jobId: "job-1", status: "declined", createdAt: "2026-09-05T00:00:00Z" });
    hoisted.docState.set("booking_requests/br-other-job", { clientId: "c1", caregiverId: "cg1", jobId: "job-2", status: "pending", createdAt: "2026-09-12T00:00:00Z" });
    expect(await findBlockingBookingRequest("c1", "cg1", "job-1", "iv-1")).toBeNull();
  });

  it("uses the LATEST request for the pairing (a newer declined one un-blocks an older pending one)", async () => {
    hoisted.docState.set("booking_requests/br-1", { clientId: "c1", caregiverId: "cg1", interviewId: "iv-1", status: "pending", createdAt: "2026-09-01T00:00:00Z" });
    hoisted.docState.set("booking_requests/br-2", { clientId: "c1", caregiverId: "cg1", interviewId: "iv-1", status: "declined", createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z" });
    expect(await findBlockingBookingRequest("c1", "cg1", null, "iv-1")).toBeNull();
  });
});
