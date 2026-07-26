// AE22 caregiver memory-context RESTORE (plan 2026-07-22-002, U10 + 2026-07-25).
//
// `markCaregiverChildcareContext` denies a caregiver's general memory while they
// hold a live childcare engagement. This is its counterpart: eligibility returns
// once no engagement remains. The load-bearing property under test is FAIL-CLOSED
// — every uncertain path must RETAIN the denial, because clearing on doubt is the
// only outcome that could leak childcare context into general memory.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore: any = () => {
    throw new Error("admin.firestore() must not be called when a db is injected");
  };
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});

import { clearCaregiverChildcareContextIfIdle } from "./memoryEligibility";

const CG = "cg-1";
const PHONE = "+15550002222";

interface Booking { careVertical: string; caregiverId: string; status: string }

/** Minimal Firestore double: equality `where` chains + doc get/set. */
function makeDb(opts: {
  bookings?: Booking[];
  caregiverPhone?: string | null;
  session?: Record<string, unknown> | null;
  failBookings?: boolean;
}) {
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
  const bookings = opts.bookings ?? [];
  let session = opts.session === undefined ? { childcareContextActive: true } : opts.session;

  const makeQuery = (filters: Array<[string, unknown]>): any => ({
    where: (field: string, _op: string, value: unknown) => makeQuery([...filters, [field, value]]),
    get: async () => {
      if (opts.failBookings) throw new Error("firestore unavailable");
      const rows = bookings.filter((b) =>
        filters.every(([f, v]) => (b as unknown as Record<string, unknown>)[f] === v));
      return { docs: rows.map((b) => ({ data: () => b })) };
    },
  });

  const db = {
    collection: (name: string) => {
      if (name === "booking_requests") return makeQuery([]);
      return {
        doc: (id: string) => ({
          get: async () => {
            if (name === "caregivers" && id === CG) {
              const phone = opts.caregiverPhone === undefined ? PHONE : opts.caregiverPhone;
              return { exists: !!phone, data: () => (phone ? { phone } : {}) };
            }
            if (name === "agent_sessions" && id === PHONE) {
              return { exists: session !== null, data: () => session ?? {} };
            }
            return { exists: false, data: () => ({}) };
          },
          set: async (data: Record<string, unknown>) => {
            writes.push({ path: `${name}/${id}`, data });
            session = { ...(session ?? {}), ...data };
          },
        }),
      };
    },
  };
  return { db: db as any, writes, currentSession: () => session };
}

const engaged = (status: string): Booking => ({ careVertical: "child", caregiverId: CG, status });

beforeEach(() => vi.clearAllMocks());

describe("clears the denial once no engagement remains", () => {
  it("clears when every childcare booking is terminal", async () => {
    const { db, writes, currentSession } = makeDb({
      bookings: [engaged("completed"), engaged("canceled"), engaged("declined")],
    });
    expect(await clearCaregiverChildcareContextIfIdle(CG, { db })).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(`agent_sessions/${PHONE}`);
    expect(currentSession()).toMatchObject({ childcareContextActive: false });
    expect(writes[0].data).toHaveProperty("childcareContextClearedAt");
  });

  it("clears when the caregiver has no childcare bookings at all", async () => {
    const { db, writes } = makeDb({ bookings: [] });
    expect(await clearCaregiverChildcareContextIfIdle(CG, { db })).toBe(true);
    expect(writes).toHaveLength(1);
  });
});

describe("FAIL-CLOSED: retains the denial on any live engagement or doubt", () => {
  for (const status of ["requested", "accepted", "confirmed", "in_progress"]) {
    it(`retains while a "${status}" childcare booking exists — no write`, async () => {
      const { db, writes } = makeDb({ bookings: [engaged("completed"), engaged(status)] });
      expect(await clearCaregiverChildcareContextIfIdle(CG, { db })).toBe(false);
      expect(writes).toEqual([]);
    });
  }

  it("retains when the booking read THROWS (never clears on error)", async () => {
    const { db, writes } = makeDb({ failBookings: true });
    expect(await clearCaregiverChildcareContextIfIdle(CG, { db })).toBe(false);
    expect(writes).toEqual([]);
  });

  it("retains when no caregiver phone can be resolved", async () => {
    const { db, writes } = makeDb({ bookings: [], caregiverPhone: null });
    expect(await clearCaregiverChildcareContextIfIdle(CG, { db })).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe("scoping and write economy", () => {
  it("ignores OTHER caregivers' live childcare bookings", async () => {
    const { db, writes } = makeDb({
      bookings: [{ careVertical: "child", caregiverId: "cg-other", status: "confirmed" }],
    });
    expect(await clearCaregiverChildcareContextIfIdle(CG, { db })).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it("ignores this caregiver's live SENIOR bookings (vertical-scoped)", async () => {
    const { db, writes } = makeDb({
      bookings: [{ careVertical: "senior", caregiverId: CG, status: "in_progress" }],
    });
    expect(await clearCaregiverChildcareContextIfIdle(CG, { db })).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it("writes nothing when the stamp was never set (no pointless write per completion)", async () => {
    const { db, writes } = makeDb({ bookings: [], session: { userType: "caregiver" } });
    expect(await clearCaregiverChildcareContextIfIdle(CG, { db })).toBe(false);
    expect(writes).toEqual([]);
  });

  it("writes nothing when the caregiver has no session doc", async () => {
    const { db, writes } = makeDb({ bookings: [], session: null });
    expect(await clearCaregiverChildcareContextIfIdle(CG, { db })).toBe(false);
    expect(writes).toEqual([]);
  });
});
