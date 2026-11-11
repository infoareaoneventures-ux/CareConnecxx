import { describe, it, expect, vi, beforeEach } from "vitest";

// Wave 2 (2026-11-09): cancelling one visit must not end an ongoing booking. The next visits are
// created from the furthest visit in ANY state (a cancelled date is never re-created), and
// extendBookingShifts makes them right away when the last scheduled visit ends.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const batchSets: any[] = [];
  const logs: string[] = [];
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(), path,
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
    set: async (d: any) => docState.set(path, d),
    update: async (d: any) => docState.set(path, { ...(docState.get(path) ?? {}), ...d }),
  });
  const makeCollRef = (path: string, filters: Array<[string, string, any]> = []): any => ({
    doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto${batchSets.length}`}`),
    where: (f: string, op: string, v: any) => makeCollRef(path, [...filters, [f, op, v]]),
    orderBy: () => makeCollRef(path, filters),
    limit: () => makeCollRef(path, filters),
    get: async () => {
      const prefix = `${path}/`;
      const docs = [...docState.entries()]
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .filter(([, d]) => filters.every(([f, op, v]) => (op === "==" ? d?.[f] === v : op === "in" ? v.includes(d?.[f]) : true)))
        .map(([k, d]) => ({ id: k.slice(prefix.length), data: () => d, ref: makeDocRef(k) }));
      return { empty: docs.length === 0, docs };
    },
  });
  const dbMock = {
    collection: (p: string) => makeCollRef(p),
    batch: () => ({ set: (ref: any, d: any) => batchSets.push({ path: ref.path, data: d }), delete: () => {}, commit: async () => {} }),
  };
  return { docState, batchSets, logs, dbMock, reset: () => { docState.clear(); batchSets.length = 0; logs.length = 0; } };
});
vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => hoisted.dbMock },
  firestore: Object.assign(() => hoisted.dbMock, { FieldValue: { serverTimestamp: () => ({ __ts: true }), delete: () => ({ __delete: true }) }, Timestamp: { fromMillis: (ms: number) => ({ seconds: Math.floor(ms / 1000) }) } }),
}));
vi.mock("firebase-functions/v1", () => {
  const builder: any = { firestore: { document: () => ({ onWrite: (h: any) => h, onUpdate: (h: any) => h }) }, pubsub: { schedule: () => ({ onRun: (h: any) => h }) } };
  return { __esModule: true, ...builder, default: builder };
});
vi.mock("../../billing/membershipLapse", () => ({ applyMembershipLapse: vi.fn(async () => "ok") }));

import { generateRollingShifts, extendBookingShifts, latestShiftDate, nextVisitWindow, addDays } from "../shiftGenerator";
import { businessTodayStr, DEFAULT_TZ } from "../../utils/scheduledTime";

const ACTIVE = { membershipStatus: "active", backgroundCheckStatus: "clear" };
const ongoingBooking = (extra: Record<string, unknown> = {}) => ({
  status: "accepted", clientId: "fam1", caregiverId: "alice", caregiverName: "Alice", clientName: "The Nguyens",
  schedule: { ongoing: true, dayShiftTimes: { Mon: [{ start: "09:00", end: "12:00" }], Thu: [{ start: "09:00", end: "12:00" }] } },
  ...extra,
});
const today = () => businessTodayStr(DEFAULT_TZ);
const visit = (id: string, date: string, status: string, bookingRequestId = "br1") =>
  hoisted.docState.set(`shifts/${id}`, { bookingRequestId, date, status });

beforeEach(() => {
  hoisted.reset();
  hoisted.docState.set("_meta/shiftsCleanedUp", { cleanedAt: "x" });
  hoisted.docState.set("caregivers/alice", ACTIVE);
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("nextVisitWindow / latestShiftDate", () => {
  it("starts after the furthest visit, never in the past, two weeks wide", () => {
    expect(nextVisitWindow("2026-11-20", "2026-11-09")).toEqual({ generateFrom: "2026-11-21", generateTo: "2026-12-04", maxShiftDate: "2026-11-20" });
    expect(nextVisitWindow("2026-10-01", "2026-11-09").generateFrom).toBe("2026-11-09"); // a stalled booking restarts today, not in October
    expect(nextVisitWindow(null, "2026-11-09").generateFrom).toBe("2026-11-09");
  });

  it("looks at every state: a cancelled or completed visit counts as the furthest date", async () => {
    visit("a", "2026-11-12", "completed"); visit("b", "2026-11-30", "cancelled"); visit("c", "2026-11-20", "scheduled");
    visit("x", "2027-01-01", "scheduled", "other-booking");
    expect(await latestShiftDate("br1")).toBe("2026-11-30");
    expect(await latestShiftDate("nobody")).toBeNull();
  });
});

describe("extendBookingShifts — the next visits exist even when the last scheduled one was cancelled", () => {
  it("creates new visits for an ongoing booking whose only upcoming visit was cancelled, and does NOT re-create the cancelled date", async () => {
    const cancelledDate = addDays(today(), 3);
    visit("v1", cancelledDate, "cancelled");
    const res = await extendBookingShifts("br1", ongoingBooking());
    expect(res.created).toBeGreaterThan(0);
    const dates = hoisted.batchSets.map((s) => s.data.date as string);
    expect(dates.every((d) => d > cancelledDate)).toBe(true);
    expect(dates).not.toContain(cancelledDate);
    expect(hoisted.batchSets.every((s) => s.data.status === "scheduled" && s.data.bookingRequestId === "br1")).toBe(true);
  });

  it("makes nothing for a locked care provider, and says why", async () => {
    hoisted.docState.set("caregivers/alice", { membershipStatus: "canceled", backgroundCheckStatus: "clear" });
    const res = await extendBookingShifts("br1", ongoingBooking());
    expect(res).toEqual({ created: 0, skipped: "caregiver_not_eligible" });
    expect(hoisted.batchSets).toHaveLength(0);
  });

  it("a dated booking past its end date has nothing more to create (so the caller may complete it)", async () => {
    visit("v1", addDays(today(), -10), "completed");
    const res = await extendBookingShifts("br1", ongoingBooking({ schedule: { ongoing: false, endDate: addDays(today(), -5), dayShiftTimes: { Mon: [{ start: "09:00", end: "12:00" }] } } }));
    expect(res.created).toBe(0);
    expect(res.skipped).toBeUndefined();
  });
});

describe("generateRollingShifts does not bring a cancelled visit back", () => {
  it("with the only upcoming visit cancelled, the daily job continues AFTER that date", async () => {
    const cancelledDate = addDays(today(), 3);
    visit("v1", cancelledDate, "cancelled");
    hoisted.docState.set("booking_requests/br1", ongoingBooking());
    await (generateRollingShifts as any)();
    const dates = hoisted.batchSets.map((s) => s.data.date as string);
    expect(dates.length).toBeGreaterThan(0);
    expect(dates).not.toContain(cancelledDate);
    expect(dates.every((d) => d > cancelledDate)).toBe(true);
  });
});


describe("all U.S. zones (2026-11-09): visits carry their care location's zone", () => {
  it("a Chicago booking's generated visits are stamped America/Chicago; an unzoned booking reads Pacific", async () => {
    await extendBookingShifts("brC", ongoingBooking({ address: "100 Main St, Austin, TX 78701" }));
    expect(hoisted.batchSets.length).toBeGreaterThan(0);
    expect(hoisted.batchSets.every((s) => s.data.timeZone === "America/Chicago")).toBe(true);
    hoisted.batchSets.length = 0;
    await extendBookingShifts("brP", ongoingBooking({ address: "4746 Campbell Ave, San Jose, CA 95130" }));
    expect(hoisted.batchSets.every((s) => s.data.timeZone === "America/Los_Angeles")).toBe(true);
    hoisted.batchSets.length = 0;
    await extendBookingShifts("brX", ongoingBooking());
    expect(hoisted.batchSets.every((s) => s.data.timeZone === "America/Los_Angeles")).toBe(true);
  });

  it("an explicit timeZone on the booking wins over the address", async () => {
    await extendBookingShifts("brE", ongoingBooking({ timeZone: "America/New_York", address: "1 Main St, Chicago, IL 60601" }));
    expect(hoisted.batchSets.every((s) => s.data.timeZone === "America/New_York")).toBe(true);
  });
});
