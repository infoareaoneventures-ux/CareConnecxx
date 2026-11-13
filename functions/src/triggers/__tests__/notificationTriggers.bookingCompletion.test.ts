import { describe, it, expect, vi, beforeEach } from "vitest";

// Wave 2 (2026-11-09): "Cancelling one visit ends the whole ongoing booking". When a booking's last
// SCHEDULED visit is cancelled or completed, an ONGOING booking stays accepted and its next visits are
// created at once; only a dated booking with nothing left to create is completed.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
    set: async (d: any) => docState.set(path, { ...(docState.get(path) ?? {}), ...d }),
    update: async (d: any) => docState.set(path, { ...(docState.get(path) ?? {}), ...d }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });
  const makeCollRef = (path: string, filters: Array<[string, any]> = []): any => ({
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    where: (f: string, _op: string, v: any) => makeCollRef(path, [...filters, [f, v]]),
    limit: () => makeCollRef(path, filters),
    get: async () => {
      const prefix = `${path}/`;
      const docs = [...docState.entries()]
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .filter(([, d]) => filters.every(([f, v]) => d?.[f] === v))
        .map(([k, d]) => ({ id: k.slice(prefix.length), data: () => d, ref: makeDocRef(k) }));
      return { empty: docs.length === 0, docs };
    },
  });
  return { docState, dbMock: { collection: (p: string) => makeCollRef(p) }, reset: () => docState.clear() };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => hoisted.dbMock },
  firestore: Object.assign(() => hoisted.dbMock, { FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }), delete: () => ({ __delete: true }) } }),
}));
vi.mock("firebase-functions/v1", () => {
  const builder: any = { firestore: { document: () => ({ onWrite: (h: any) => h, onUpdate: (h: any) => h, onCreate: (h: any) => h }) } };
  return { __esModule: true, ...builder, default: builder };
});
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn().mockResolvedValue(true) }));
vi.mock("../../linq/client", () => ({ sendToPhone: vi.fn().mockResolvedValue("sent") }));
vi.mock("../../notifications/userNotification", () => ({ writeUserNotification: vi.fn().mockResolvedValue(true) }));
vi.mock("../../agents/shiftReplacement", () => ({ findReplacementCandidates: vi.fn(async () => []) }));
const extendBookingShifts = vi.fn();
vi.mock("../../scheduled/shiftGenerator", () => ({ extendBookingShifts: (...a: unknown[]) => extendBookingShifts(...a) }));

import { onShiftStatusChanged } from "../notificationTriggers";

const base = { clientId: "c1", caregiverId: "cg1", caregiverName: "Alice", clientName: "The Nguyens", date: "2099-03-04", bookingRequestId: "br1" };
const change = (before: any, after: any) => ({
  before: { exists: true, data: () => before },
  after: { exists: true, id: "s1", data: () => after, ref: { update: async () => {} } },
});
const ctx = () => ({ params: { shiftId: "s1" }, eventId: "evt-1" });
const bookingStatus = () => hoisted.docState.get("booking_requests/br1")?.status;

beforeEach(() => {
  hoisted.reset();
  extendBookingShifts.mockReset();
  hoisted.docState.set("caregivers/cg1", { phone: "+15550001111" });
  hoisted.docState.set("users/c1", { phone: "+15550002222" });
});

describe("booking completion when the last scheduled visit ends", () => {
  it("an ONGOING booking stays accepted — the next visits are created, nothing is completed", async () => {
    hoisted.docState.set("booking_requests/br1", { status: "accepted", schedule: { ongoing: true } });
    extendBookingShifts.mockResolvedValue({ created: 6 });
    await (onShiftStatusChanged as any)(change({ ...base, status: "scheduled" }, { ...base, status: "cancelled", cancelledBy: "client" }), ctx());
    expect(extendBookingShifts).toHaveBeenCalledTimes(1);
    expect(bookingStatus()).toBe("accepted");
  });

  it("an ongoing booking stays accepted even when no visit could be created (the generator will try again)", async () => {
    hoisted.docState.set("booking_requests/br1", { status: "accepted", schedule: { ongoing: true } });
    extendBookingShifts.mockResolvedValue({ created: 0 });
    await (onShiftStatusChanged as any)(change({ ...base, status: "scheduled" }, { ...base, status: "completed" }), ctx());
    expect(bookingStatus()).toBe("accepted");
  });

  it("a dated booking with more visits still to create is not completed", async () => {
    hoisted.docState.set("booking_requests/br1", { status: "accepted", schedule: { ongoing: false, endDate: "2099-04-01" } });
    extendBookingShifts.mockResolvedValue({ created: 2 });
    await (onShiftStatusChanged as any)(change({ ...base, status: "scheduled" }, { ...base, status: "completed" }), ctx());
    expect(bookingStatus()).toBe("accepted");
  });

  it("a dated booking with nothing left to create IS completed", async () => {
    hoisted.docState.set("booking_requests/br1", { status: "accepted", schedule: { ongoing: false, endDate: "2099-03-04" } });
    extendBookingShifts.mockResolvedValue({ created: 0 });
    await (onShiftStatusChanged as any)(change({ ...base, status: "scheduled" }, { ...base, status: "completed" }), ctx());
    expect(bookingStatus()).toBe("completed");
  });

  it("when visits cannot be created (frozen membership / locked care provider) the booking is left as it is", async () => {
    hoisted.docState.set("booking_requests/br1", { status: "accepted", schedule: { ongoing: false, endDate: "2099-04-01" } });
    extendBookingShifts.mockResolvedValue({ created: 0, skipped: "caregiver_not_eligible" });
    await (onShiftStatusChanged as any)(change({ ...base, status: "scheduled" }, { ...base, status: "cancelled", cancelledBy: "client" }), ctx());
    expect(bookingStatus()).toBe("accepted");
  });

  it("another visit still scheduled → nothing is generated or completed", async () => {
    hoisted.docState.set("booking_requests/br1", { status: "accepted", schedule: { ongoing: true } });
    hoisted.docState.set("shifts/other", { bookingRequestId: "br1", status: "scheduled", date: "2099-03-11" });
    await (onShiftStatusChanged as any)(change({ ...base, status: "scheduled" }, { ...base, status: "completed" }), ctx());
    expect(extendBookingShifts).not.toHaveBeenCalled();
    expect(bookingStatus()).toBe("accepted");
  });
});
