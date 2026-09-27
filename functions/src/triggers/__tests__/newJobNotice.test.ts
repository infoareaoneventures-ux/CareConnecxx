import { describe, it, expect, vi, beforeEach } from "vitest";

// New-job notice (founder, 2026-09-27): a family posts → the caregivers whose
// dashboard would show the job in Nearby Jobs get ONE text (the card's lines +
// the Jobs page link) and a bell entry; caregivers with an active family, out
// of radius, paused/opted-out, or who blocked the client are skipped. No
// yes/no reply flow, no skills filter, membership not required.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const sent: Array<{ chatId: string; text: string }> = [];
  const bells: any[] = [];
  const makeQuery = (coll: string, filters: Array<[string, string, any]>): any => ({
    where: (f: string, op: string, v: any) => makeQuery(coll, [...filters, [f, op, v]]),
    orderBy: () => makeQuery(coll, filters),
    limit: () => makeQuery(coll, filters),
    get: vi.fn(async () => {
      let items = Array.from(docState.entries())
        .filter(([p]) => p.startsWith(`${coll}/`) && p.split("/").length === 2)
        .map(([p, d]) => ({ id: p.split("/")[1], data: () => d }));
      for (const [f, op, v] of filters) {
        items = items.filter((it) => (op === "==" ? it.data()[f] === v : op === "in" ? v.includes(it.data()[f]) : true));
      }
      return { empty: items.length === 0, docs: items };
    }),
  });
  const makeCollRef = (coll: string): any => ({
    doc: (id: string) => ({
      id,
      get: vi.fn(async () => ({ exists: docState.has(`${coll}/${id}`), data: () => docState.get(`${coll}/${id}`) })),
      update: vi.fn(async (d: any) => docState.set(`${coll}/${id}`, { ...(docState.get(`${coll}/${id}`) ?? {}), ...d })),
    }),
    ...makeQuery(coll, []),
  });
  return { docState, sent, bells, collectionMock: vi.fn((c: string) => makeCollRef(c)), reset: () => { docState.clear(); sent.length = 0; bells.length = 0; } };
});

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: hoisted.collectionMock }), { FieldValue: {} });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("firebase-functions/v1", () => ({
  firestore: { document: () => ({ onCreate: (fn: unknown) => fn }) },
  config: () => ({}),
}));
vi.mock("../../ai/scoring", async (importOriginal) => {
  // Only the pure distance helper is needed; the module's other imports pull in
  // embeddings/config wiring that has no place in this unit test.
  const R = 3959;
  return {
    haversineMiles: (lat1?: number, lon1?: number, lat2?: number, lon2?: number) => {
      if ([lat1, lon1, lat2, lon2].some((v) => v === undefined)) return undefined;
      const dLat = ((lat2! - lat1!) * Math.PI) / 180, dLon = ((lon2! - lon1!) * Math.PI) / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1! * Math.PI) / 180) * Math.cos((lat2! * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    },
    __importOriginal: importOriginal,
  };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (chatId: string, text: string) => { hoisted.sent.push({ chatId, text }); return { message_id: "m" }; }) }));
vi.mock("../../notifications/userNotification", () => ({ writeUserNotification: vi.fn(async (n: any) => { hoisted.bells.push(n); return true; }) }));
vi.mock("../../config/appUrl", () => ({ appLink: (p: string) => `https://eviacares.com${p}` }));

import { sendNewJobNotices, caregiverHasActiveFamilies } from "../newJobNotice";

const JOB = { status: "open", clientId: "fam1", title: "Care for Rosy", location: "Santa Clara", lat: 37.3541, lng: -121.9552, rate: 26, jobFrequency: "part-time", timeOfDay: ["morning"], date: "ASAP", paymentMethod: "credit" };
const cg = (id: string, extra: Record<string, unknown> = {}) =>
  hoisted.docState.set(`caregivers/${id}`, { onboardingStatus: "profile_complete", phone: `+1${id}`, lat: 37.3382, lng: -121.8863, serviceRadius: 25, ...extra });
const session = (id: string) => hoisted.docState.set(`agent_sessions/+1${id}`, { chatId: `chat-${id}`, caregiverId: id });

beforeEach(() => hoisted.reset());

describe("sendNewJobNotices", () => {
  it("texts + bells the caregivers whose Nearby Jobs would show the job, with the card's own line, no link", async () => {
    cg("a"); session("a");
    const res = await sendNewJobNotices("job1", JOB, "evt1");
    expect(res.notified).toEqual(["a"]);
    expect(hoisted.sent).toHaveLength(1);
    expect(hoisted.sent[0].chatId).toBe("chat-a");
    expect(hoisted.sent[0].text).toContain("New job near you: Care for Rosy · Santa Clara (3.9 mi away) · $26/hr · Part-time · Day · ASAP · Morning.");
    expect(hoisted.sent[0].text).not.toContain("http"); // Evia gives the details herself
    expect(hoisted.sent[0].text).not.toMatch(/yes or no/i);
    expect(hoisted.bells[0]).toMatchObject({ recipientId: "a", type: "new_job", transitionType: "new_job_posted", sourcePath: "job_posts/job1", eventId: "evt1", data: { jobId: "job1", link: "/caregiver/jobs?job=job1" } });
  });

  it("bell only when the caregiver has no Evia session; membership is NOT required", async () => {
    cg("b", { membershipPaid: false });
    const res = await sendNewJobNotices("job1", JOB, "evt1");
    expect(res.bellOnly).toEqual(["b"]);
    expect(hoisted.sent).toHaveLength(0);
    expect(hoisted.bells).toHaveLength(1);
  });

  it("skips: out of radius, paused, opted out, unfinished profile, blocked the client, active family", async () => {
    cg("far", { lat: 38.5816, lng: -121.4944 });
    cg("paused", { pausedUntil: "2999-01-01T00:00:00Z" });
    cg("out", { optedOut: true });
    hoisted.docState.set("caregivers/mid", { onboardingStatus: "in_progress", phone: "+1mid", lat: 37.3382, lng: -121.8863 });
    cg("blocker"); hoisted.docState.set("users/blocker", { blockedUsers: ["fam1"] });
    cg("busy");
    hoisted.docState.set("booking_requests/br1", { caregiverId: "busy", status: "accepted" });
    hoisted.docState.set("shifts/s1", { caregiverId: "busy", status: "scheduled", bookingRequestId: "br1" });
    const res = await sendNewJobNotices("job1", JOB, "evt1");
    expect(res.notified).toEqual([]);
    expect(res.bellOnly).toEqual([]);
    expect(res.skipped).toBe(5); // 'mid' never enters the candidate query
    expect(hoisted.bells).toHaveLength(0);
  });

  it("a caregiver with no travel distance is told about every open job, like their board", async () => {
    cg("nolimit", { serviceRadius: 0 });
    const res = await sendNewJobNotices("job1", { ...JOB, lat: 38.5816, lng: -121.4944 }, "evt1");
    expect(res.bellOnly).toEqual(["nolimit"]);
  });

  it("does nothing for a job that is not open or whose client is deactivated", async () => {
    cg("a"); session("a");
    expect((await sendNewJobNotices("job1", { ...JOB, status: "filled" }, "e")).notified).toEqual([]);
    expect((await sendNewJobNotices("job1", { ...JOB, clientActive: false }, "e")).notified).toEqual([]);
    expect(hoisted.sent).toHaveLength(0);
  });
});

describe("caregiverHasActiveFamilies — the dashboard's rule", () => {
  it("needs an accepted booking request AND a live shift for it", async () => {
    hoisted.docState.set("booking_requests/br1", { caregiverId: "c", status: "accepted" });
    expect(await caregiverHasActiveFamilies("c")).toBe(false);
    hoisted.docState.set("shifts/s1", { caregiverId: "c", status: "completed", bookingRequestId: "br1" });
    expect(await caregiverHasActiveFamilies("c")).toBe(false);
    hoisted.docState.set("shifts/s2", { caregiverId: "c", status: "in-progress", bookingRequestId: "br1" });
    expect(await caregiverHasActiveFamilies("c")).toBe(true);
  });
});
