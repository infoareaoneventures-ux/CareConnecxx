import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * markAppointmentsCompleted computes when a shift ends from the stored
 * Pacific wall-clock `isoDate` + `time`. Parsing that wall-clock as UTC
 * ("...T17:00:00Z") lands 7-8h EARLY — the cron then flips a 5pm shift to
 * `completed` around 12:30pm, hours before the caregiver arrives, which
 * unblocks submitShiftHours pre-shift. These tests pin the schedule-end
 * math to the business timezone (America/Los_Angeles).
 *
 * Childcare U8 (plan 2026-07-22-002): the sweep additionally has a guarded
 * childcare branch — childcare visits are NEVER wall-clock auto-completed
 * (completion feeds capture); they route to the overdue policy-state handler
 * instead. Senior behavior is characterized before/after in the same suite.
 */

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    update: async (data: any) => {
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
  });
  const matches = (doc: any, f: { field: string; op: string; value: any }): boolean => {
    const v = doc[f.field];
    if (f.op === "==") return v === f.value;
    if (f.op === "in") return Array.isArray(f.value) && f.value.includes(v);
    if (f.op === "<=") return typeof v === "string" && v <= f.value;
    return false;
  };
  const makeQuery = (collPath: string, filters: any[] = []): any => ({
    where: (field: string, op: string, value: any) =>
      makeQuery(collPath, [...filters, { field, op, value }]),
    limit: () => makeQuery(collPath, filters),
    get: async () => {
      const rows = [...docs.entries()]
        .filter(([p]) => p.startsWith(`${collPath}/`))
        .map(([p, d]) => ({ id: p.split("/").pop()!, data: () => d, ref: makeDocRef(p), _raw: d }))
        .filter((r) => filters.every((f) => matches(r._raw, f)));
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });
  const db = {
    collection: (p: string) => ({ ...makeQuery(p), doc: (id: string) => makeDocRef(`${p}/${id}`) }),
  };
  return { docs, db, reset: () => docs.clear() };
});

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => hoisted.db, {
    FieldValue: { serverTimestamp: () => ({ __ts: true }) },
  });
  const stub = { apps: [], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("firebase-functions/v1", () => ({
  pubsub: { schedule: () => ({ onRun: (fn: any) => fn }) },
}));

const overdueMock = vi.hoisted(() => vi.fn(async () => "missed_visit_review"));
vi.mock("./childcare/shiftPayments", () => ({
  handleOverdueChildcareVisit: overdueMock,
}));

import { computeScheduledEndMs, markAppointmentsCompleted } from "./appointmentCompletion";

/* eslint-disable @typescript-eslint/no-explicit-any */
const runSweep = markAppointmentsCompleted as any;

describe("computeScheduledEndMs — business-timezone schedule math", () => {
  it("treats a 12h-clock time as Pacific wall-clock, not UTC", () => {
    // 5:00 PM PDT on 2026-07-11 + 2h → ends 7pm PDT = 2026-07-12T02:00:00Z
    const end = computeScheduledEndMs("2026-07-11", "5:00 PM", 2);
    expect(end).toBe(Date.parse("2026-07-12T02:00:00Z"));
  });

  it("treats a 24h-clock time as Pacific wall-clock, not UTC", () => {
    // 09:30 PDT on 2026-07-11 + 1h → ends 10:30 PDT = 17:30Z
    const end = computeScheduledEndMs("2026-07-11", "09:30", 1);
    expect(end).toBe(Date.parse("2026-07-11T17:30:00Z"));
  });

  it("respects PST (winter) offsets, not a hardcoded -7", () => {
    // 3:00 PM PST on 2026-01-15 + 1h → ends 4pm PST = 2026-01-16T00:00:00Z
    const end = computeScheduledEndMs("2026-01-15", "3:00 PM", 1);
    expect(end).toBe(Date.parse("2026-01-16T00:00:00Z"));
  });

  it("defaults duration to 1h when missing", () => {
    const end = computeScheduledEndMs("2026-07-11", "10:00 AM", undefined);
    expect(end).toBe(Date.parse("2026-07-11T18:00:00Z"));
  });

  it("returns null on unparseable inputs", () => {
    expect(computeScheduledEndMs(undefined, "10:00 AM", 1)).toBeNull();
    expect(computeScheduledEndMs("2026-07-11", "sometime", 1)).toBeNull();
  });

  it("accepts canonical date/time/duration values used by new writers", () => {
    const end = computeScheduledEndMs("2026-07-11", "17:00", 2.5);
    expect(end).toBe(Date.parse("2026-07-12T02:30:00Z"));
  });
});

describe("markAppointmentsCompleted — childcare guarded branch (U8)", () => {
  beforeEach(() => {
    hoisted.reset();
    overdueMock.mockClear();
  });

  // A long-past date guarantees end + grace has elapsed regardless of clock.
  const PAST = { date: "2020-01-06", startTime: "09:00", durationHours: 2 };

  it("SENIOR appointments keep the exact pre-U8 behavior (wall-clock completion)", async () => {
    hoisted.docs.set("appointments/sa1", { ...PAST, status: "confirmed", clientId: "c1" });
    await runSweep();
    expect(hoisted.docs.get("appointments/sa1").status).toBe("completed");
    expect(hoisted.docs.get("appointments/sa1").completedAt).toBeTruthy();
    expect(overdueMock).not.toHaveBeenCalled();
  });

  it("CHILDCARE appointments are never wall-clock completed — they route to the overdue handler", async () => {
    hoisted.docs.set("appointments/ca1", {
      ...PAST,
      status: "confirmed",
      careVertical: "child",
      childcareBookingId: "cbook_1",
      clientId: "family-1",
    });
    await runSweep();
    expect(hoisted.docs.get("appointments/ca1").status).toBe("confirmed"); // untouched here
    expect(hoisted.docs.get("appointments/ca1").completedAt).toBeUndefined();
    expect(overdueMock).toHaveBeenCalledTimes(1);
    expect((overdueMock.mock.calls[0] as unknown[])[0]).toBe("ca1");
  });

  it("a childcare handler failure never breaks the senior sweep", async () => {
    overdueMock.mockRejectedValueOnce(new Error("boom"));
    hoisted.docs.set("appointments/ca1", {
      ...PAST, status: "confirmed", careVertical: "child", clientId: "f1",
    });
    hoisted.docs.set("appointments/sa1", { ...PAST, status: "confirmed", clientId: "c1" });
    await runSweep();
    expect(hoisted.docs.get("appointments/sa1").status).toBe("completed");
    expect(hoisted.docs.get("appointments/ca1").status).toBe("confirmed");
  });

  it("a still-running visit (either vertical) is left alone", async () => {
    const today = new Date();
    const iso = today.toISOString().split("T")[0];
    hoisted.docs.set("appointments/future1", {
      date: iso, startTime: "23:59", durationHours: 1, status: "confirmed", careVertical: "child",
    });
    await runSweep();
    expect(overdueMock).not.toHaveBeenCalled();
  });
});
