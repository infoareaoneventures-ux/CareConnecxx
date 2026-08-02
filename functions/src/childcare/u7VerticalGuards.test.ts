// U7 vertical guards on LIVE senior files (plan 2026-07-22-002, R46/AE16).
//
// Two layers:
//   1. DIRECT unit tests where the module graph is light enough to import
//      (inboundHelpers.handleRecurringConfirm, shiftTimeChange,
//      recurringScheduler.extendRecurringScheduleById, gpsCheckin delegation).
//   2. SOURCE-SCAN characterization for the trigger/scheduler wiring
//      (shiftGenerator, notificationTriggers, appointmentUpdated, routeIntent,
//      shiftOffer, modifyScheduleFlow, bookingExecutor, mcp/server): the
//      childcare guard exists, sits BEFORE the senior logic, and the senior
//      logic itself is still present verbatim — SMS-driven appointment
//      mutations cannot touch childcare bookings in this unit.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ── Shared in-memory Firestore mock ──────────────────────────────────────────
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const updates: Array<{ path: string; data: any }> = [];
  const sets: Array<{ path: string; data: any }> = [];

  const valueAt = (doc: any, p: string): unknown =>
    p.split(".").reduce<any>((acc, part) => (acc == null ? undefined : acc[part]), doc);

  const matches = (doc: any, f: { field: string; op: string; value: any }): boolean => {
    const v = valueAt(doc, f.field);
    if (f.op === "==") return v === f.value;
    if (f.op === "in") return Array.isArray(f.value) && f.value.includes(v);
    if (f.op === ">") return typeof v === "string" && v > f.value;
    return false;
  };

  const makeDocRef = (p: string): any => ({
    id: p.split("/").pop(),
    path: p,
    get: async () => ({ exists: docs.has(p), id: p.split("/").pop(), data: () => docs.get(p), ref: makeDocRef(p) }),
    set: async (data: any, opts?: any) => {
      sets.push({ path: p, data });
      docs.set(p, opts?.merge ? { ...(docs.get(p) ?? {}), ...data } : { ...data });
    },
    update: async (data: any) => {
      if (!docs.has(p)) throw Object.assign(new Error(`5 NOT_FOUND: ${p}`), { code: 5 });
      updates.push({ path: p, data });
      docs.set(p, { ...(docs.get(p) ?? {}), ...data });
    },
    collection: (sub: string) => makeCollRef(`${p}/${sub}`),
  });

  const makeQuery = (collPath: string, filters: any[] = [], lim?: number): any => ({
    where: (field: string, op: string, value: any) => makeQuery(collPath, [...filters, { field, op, value }], lim),
    orderBy: () => makeQuery(collPath, filters, lim),
    limit: (n: number) => makeQuery(collPath, filters, n),
    get: async () => {
      let rows = [...docs.entries()]
        .filter(([p]) => p.startsWith(`${collPath}/`) && p.split("/").length === collPath.split("/").length + 1)
        .map(([p, d]) => ({ id: p.split("/").pop()!, data: () => d, ref: makeDocRef(p), _raw: d }))
        .filter((r) => filters.every((f) => matches(r._raw, f)));
      if (lim !== undefined) rows = rows.slice(0, lim);
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });

  const batchOps: Array<{ op: string; path: string; data?: any }> = [];
  const makeCollRef = (p: string): any => {
    const q = makeQuery(p);
    return {
      doc: (id?: string) => makeDocRef(`${p}/${id ?? `auto-${docs.size}`}`),
      add: async (data: any) => {
        const ref = makeDocRef(`${p}/auto-${docs.size}`);
        await ref.set(data);
        return ref;
      },
      where: q.where,
      limit: q.limit,
      get: q.get,
    };
  };

  return {
    docs, updates, sets, batchOps,
    db: {
      collection: (p: string) => makeCollRef(p),
      runTransaction: async (fn: any) =>
        fn({
          get: (ref: any) => ref.get(),
          set: (ref: any, data: any, opts?: any) => void ref.set(data, opts),
          update: (ref: any, data: any) => { docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data }); },
        }),
      batch: () => {
        const ops: Array<() => Promise<void>> = [];
        return {
          set: (ref: any, data: any) => ops.push(() => ref.set(data)),
          update: (ref: any, data: any) => ops.push(() => ref.update(data)),
          delete: () => {},
          commit: async () => { for (const op of ops) await op(); },
        };
      },
    },
    reset: () => { docs.clear(); updates.length = 0; sets.length = 0; batchOps.length = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const firestore: any = Object.assign(() => hoisted.db, {
    FieldValue: {
      delete: () => ({ __delete: true }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
      arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
    },
  });
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});

const sendMessageMock = vi.hoisted(() => vi.fn(async () => ({ message_id: "m1" })));
vi.mock("../linq/client", () => ({
  sendMessage: sendMessageMock,
  getOrCreateSession: vi.fn(async () => ({ chatId: "chat-x" })),
  sendToPhone: vi.fn(async () => {}),
}));
vi.mock("../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async ({ fallback }: { fallback: string }) => fallback),
}));
vi.mock("../agents/shiftOffer", () => ({ createShiftOffer: vi.fn(async () => "offer-1") }));
vi.mock("../billing/createValidatedShiftHours", () => ({ BILLING_AUTHORITY_VERSION: "test" }));

const checkInCoreMock = vi.hoisted(() => vi.fn(async () => ({ bookingId: "cbook_1", status: "in_progress" })));
vi.mock("./bookingCallables", () => ({
  checkInChildcareBookingCore: checkInCoreMock,
  handleChildcareBookingRequestWrite: vi.fn(async () => {}),
  ensureChildcareRollingShifts: vi.fn(async () => 0),
  sweepChildcareRollingShifts: vi.fn(async () => 0),
}));

import { handleRecurringConfirm } from "../linq/inboundHelpers";
import { requestShiftTimeChange } from "../agents/shiftTimeChange";
import { extendRecurringScheduleById } from "../scheduled/recurringScheduler";
import { submitGpsCheckin } from "../agents/gpsCheckin";

/* eslint-disable @typescript-eslint/no-explicit-any */
const gpsCheckin = submitGpsCheckin as any;

const ROOT = path.resolve(__dirname, "..", "..", "..");
const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

beforeEach(() => {
  hoisted.reset();
  sendMessageMock.mockClear();
  checkInCoreMock.mockClear();
});

// ── 1. Direct unit tests ─────────────────────────────────────────────────────

describe("inboundHelpers.handleRecurringConfirm (SMS mutations skip childcare)", () => {
  it("a childcare-vertical session writes NO appointments/recurring_schedules and redirects to the web", async () => {
    hoisted.docs.set("agent_sessions/+15550001111", { careVertical: "child" });
    await handleRecurringConfirm("+15550001111", "chat-1", {
      careVertical: "child",
      pendingRecurringSchedule: {
        caregiverId: "cg-1", caregiverName: "Pat", days: ["Mon"],
        startTime: "09:00", endTime: "12:00", durationHours: 3, hourlyRate: 25,
      },
    } as never);
    const written = [...hoisted.docs.keys()].filter(
      (p) => p.startsWith("appointments/") || p.startsWith("recurring_schedules/"),
    );
    expect(written).toHaveLength(0);
    expect(sendMessageMock).toHaveBeenCalledWith("chat-1", expect.stringContaining("web"));
  });

  it("senior sessions keep the exact pre-U7 behavior (appointments + schedule written)", async () => {
    hoisted.docs.set("agent_sessions/+15550002222", { userId: "client-1" });
    await handleRecurringConfirm("+15550002222", "chat-2", {
      userId: "client-1",
      pendingRecurringSchedule: {
        caregiverId: "cg-1", caregiverName: "Pat", days: ["Mon"],
        startTime: "09:00", endTime: "12:00", durationHours: 3, hourlyRate: 25,
        seniorName: "Rose",
      },
    } as never);
    const appts = [...hoisted.docs.entries()].filter(([p]) => p.startsWith("appointments/"));
    expect(appts.length).toBeGreaterThan(0);
    expect(appts[0][1].seniorName).toBe("Rose");
    expect(appts[0][1].billingAuthority).toBe("test");
    const schedules = [...hoisted.docs.keys()].filter((p) => p.startsWith("recurring_schedules/"));
    expect(schedules).toHaveLength(1);
  });
});

describe("shiftTimeChange (SMS time changes skip childcare)", () => {
  it("fails closed on a childcare appointment (no write, no offer)", async () => {
    hoisted.docs.set("appointments/ca1", {
      careVertical: "child", caregiverId: "cg-1", clientId: "family-1",
      date: "2026-08-10", startTime: "09:00", endTime: "13:00", status: "confirmed",
    });
    const result = await requestShiftTimeChange({
      appointmentId: "ca1", clientId: "family-1",
      newDate: "2026-08-12", newStartTime: "10:00", newEndTime: "14:00",
    });
    expect(result).toEqual({ ok: false, status: "failed", reason: "childcare_web_only" });
    expect(hoisted.docs.get("appointments/ca1").pendingTimeChange).toBeUndefined();
    expect(hoisted.docs.get("appointments/ca1").date).toBe("2026-08-10");
  });

  it("senior appointments keep the exact pre-U7 pendingTimeChange flow", async () => {
    hoisted.docs.set("appointments/sa1", {
      caregiverId: "cg-1", clientId: "client-1", caregiverName: "Pat",
      date: "2026-08-10", startTime: "09:00", endTime: "13:00", status: "confirmed",
    });
    hoisted.docs.set("caregivers/cg-1", { phone: "+15559990000", name: "Pat" });
    hoisted.docs.set("agent_sessions/+15551112222", { userId: "client-1" });
    const result = await requestShiftTimeChange({
      appointmentId: "sa1", clientId: "client-1", clientPhone: "+15551112222",
      newDate: "2026-08-12", newStartTime: "10:00", newEndTime: "14:00",
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("pending_caregiver_confirmation");
    expect(hoisted.docs.get("appointments/sa1").pendingTimeChange).toBeDefined();
  });
});

describe("recurringScheduler.extendSchedule (childcare-stamped schedule doc skipped)", () => {
  it("a childcare-stamped recurring_schedules doc is never extended into senior appointments", async () => {
    hoisted.docs.set("recurring_schedules/rs-child", {
      careVertical: "child",
      clientId: "family-1", caregiverId: "cg-1", caregiverName: "Pat",
      days: ["Mon"], startTime: "09:00", endTime: "12:00", durationHours: 3,
      hourlyRate: 25, status: "active", seniorName: "",
    });
    // A confirmed appointment exists so a senior schedule WOULD extend.
    hoisted.docs.set("appointments/a-old", {
      recurringScheduleId: "rs-child", status: "confirmed", date: "2026-07-20",
    });
    await extendRecurringScheduleById("rs-child");
    const created = [...hoisted.docs.keys()].filter((p) => p.startsWith("appointments/") && p !== "appointments/a-old");
    expect(created).toHaveLength(0);
  });
});

describe("gpsCheckin (childcare branch delegates; no location data)", () => {
  const ctx = { auth: { uid: "cg-1" } };

  it("a childcare appointment routes through checkInChildcareBookingCore and stores NO coordinates", async () => {
    hoisted.docs.set("appointments/ca1", {
      careVertical: "child", caregiverId: "cg-1", clientId: "family-1",
      childcareBookingId: "cbook_1", date: "2026-08-10",
    });
    const result = await gpsCheckin(
      { caregiverId: "cg-1", appointmentId: "ca1", latitude: 37.3, longitude: -121.9 },
      ctx,
    );
    expect(checkInCoreMock).toHaveBeenCalledWith({ bookingId: "cbook_1", callerUid: "cg-1" });
    expect(result.validated).toBe(false);
    const checkins = [...hoisted.docs.entries()].filter(([p]) => p.startsWith("shift_checkins/"));
    expect(checkins).toHaveLength(1);
    const row = checkins[0][1];
    expect(row.careVertical).toBe("child");
    // NO child location data: coordinates and distance are never stored (R57).
    expect(row.caregiverLat).toBeUndefined();
    expect(row.caregiverLon).toBeUndefined();
    expect(row.distanceMeters).toBeUndefined();
    expect(row.gpsProvided).toBe(false);
  });

  it("senior appointments keep the exact pre-U7 GPS validation path", async () => {
    hoisted.docs.set("appointments/sa1", {
      caregiverId: "cg-1", clientId: "client-1", caregiverName: "Pat",
    });
    hoisted.docs.set("senior_profiles/client-1", { latitude: 37.3, longitude: -121.9, name: "Rose" });
    hoisted.docs.set("users/client-1", {});
    const result = await gpsCheckin(
      { caregiverId: "cg-1", appointmentId: "sa1", latitude: 37.3, longitude: -121.9 },
      ctx,
    );
    expect(checkInCoreMock).not.toHaveBeenCalled();
    expect(result.validated).toBe(true);
    const checkins = [...hoisted.docs.values()].filter((d) => d.appointmentId === "sa1");
    expect(checkins[0].gpsValidated).toBe(true);
    expect(checkins[0].caregiverLat).toBe(37.3); // senior behavior unchanged
  });
});

// ── 2. Source-scan characterization (guards wired BEFORE senior logic) ───────

describe("source characterization: childcare guards sit before senior logic", () => {
  it("shiftGenerator.onBookingAccepted branches childcare BEFORE the senior accepted check", () => {
    const s = src("functions/src/scheduled/shiftGenerator.ts");
    const guard = s.indexOf("after.careVertical === 'child'");
    const seniorCheck = s.indexOf("after.status !== 'accepted'");
    expect(guard).toBeGreaterThan(-1);
    expect(seniorCheck).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(seniorCheck);
    expect(s).toContain("handleChildcareBookingRequestWrite");
    // Rolling sweep: childcare skip + flag-gated sweep.
    expect(s).toContain("booking.careVertical === 'child'");
    expect(s).toContain("sweepChildcareRollingShifts");
    // Senior shiftBase unchanged (characterization).
    expect(s).toContain("careNeeds:            booking.careNeeds || []");
    expect(s).toContain("emergencyContact:     booking.emergencyContact || null");
  });

  it("notificationTriggers skips childcare on booking, amendment, AND shift handlers", () => {
    const s = src("functions/src/triggers/notificationTriggers.ts");
    const occurrences = s.match(/careVertical === 'child'/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
    // Guard precedes each handler's first senior notification write.
    const bookingHandler = s.slice(s.indexOf("onBookingRequestWrite"), s.indexOf("onBookingAmendmentWrite"));
    expect(bookingHandler.indexOf("careVertical === 'child'")).toBeLessThan(bookingHandler.indexOf("statusAfter === 'pending'"));
  });

  it("appointmentUpdated returns before any senior flow for childcare docs", () => {
    const s = src("functions/src/triggers/appointmentUpdated.ts");
    const guard = s.indexOf('after.careVertical === "child"');
    const firstSenior = s.indexOf("statusChanged");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstSenior);
  });

  it("routeIntent's cancel-confirm writers skip childcare docs at BOTH sites", () => {
    const s = src("functions/src/linq/routeIntent.ts");
    const skips = s.match(/careVertical === "child"/g) ?? [];
    expect(skips.length).toBeGreaterThanOrEqual(3); // two cancel sites + recurring batch
    expect(s).toContain("Childcare bookings are managed on the web");
  });

  it("shiftOffer skips childcare offers in reply handling AND the expiry sweep", () => {
    const s = src("functions/src/agents/shiftOffer.ts");
    const skips = s.match(/careVertical === "child"/g) ?? [];
    expect(skips.length).toBeGreaterThanOrEqual(2);
  });

  it("bookingExecutor guards childcare tasks and exports the shared conflict gate", () => {
    const s = src("functions/src/agents/bookingExecutor.ts");
    expect(s).toContain('careVertical === "child"');
    expect(s).toContain("childcare_task_in_senior_pipeline");
    expect(s).toContain("export async function hasConflict");
  });

  it("modifyScheduleFlow skips childcare docs in its cancellation loop", () => {
    const s = src("functions/src/agents/modifyScheduleFlow.ts");
    expect(s).toContain('careVertical === "child"');
  });

  it("mcp/server refuses childcare on all four booking tools (CHILDCARE_NOT_SUPPORTED)", () => {
    const s = src("functions/src/mcp/server.ts");
    const refusals = s.match(/CHILDCARE_NOT_SUPPORTED/g) ?? [];
    // 1 type-union entry + 4 tool guards.
    expect(refusals.length).toBeGreaterThanOrEqual(5);
  });

  it("childFileAccess defaults to the REAL booking-based provider source (U3 stub replaced)", () => {
    const s = src("functions/src/childcare/childFileAccess.ts");
    expect(s).toContain("createBookingAssignedProviderSource");
    expect(s).toContain("defaultAssignedProviderEligibility(db)");
  });

  it("guardianAuthority's outbox effect re-versions booking safety (the U2→U7 fan-out wire)", () => {
    const s = src("functions/src/childcare/guardianAuthority.ts");
    expect(s).toContain("reprojectActiveBookingSafetyForChild");
  });
});
