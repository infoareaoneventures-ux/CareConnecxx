import { describe, it, expect, vi, beforeEach } from "vitest";

// Mirrors the in-memory Firestore harness used by journal.test.ts: docState backs
// .doc().get(), collState backs .where()...get() (where/orderBy/limit are no-ops
// that return the same ref, so the query path stays the base collection name).
const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets:    Array<{ path: string; data: any; opts?: any }> = [];
  const adds:    Array<{ path: string; data: any; id: string }> = [];
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string) => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({
      exists: docState.has(path),
      data:   () => docState.get(path),
      ref:    makeDocRef(path),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data, opts });
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      docState.set(path, { ...(docState.get(path) ?? {}), ...data });
    }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? `auto-${adds.length}`}`);
    ref.where   = (..._a: any[]) => ref;
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit   = (..._a: any[]) => ref;
    ref.add = vi.fn(async (data: any) => {
      const id = `auto-${adds.length}`;
      adds.push({ path, data, id });
      docState.set(`${path}/${id}`, data);
      return { id };
    });
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return { empty: items.length === 0, size: items.length, docs: items.map((d: any, i: number) => ({ id: d.id ?? `doc-${i}`, data: () => d, ref: makeDocRef(`${path}/${d.id ?? `doc-${i}`}`) })) };
    });
    return ref;
  };

  return {
    docState, collState, sets, adds, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; adds.length = 0; updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      arrayUnion:  (...v: any[]) => ({ __arrayUnion: v }),
      arrayRemove: (...v: any[]) => ({ __arrayRemove: v }),
      increment:   (n: number) => ({ __increment: n }),
      delete:      () => ({ __delete: true }),
    },
  }),
}));

vi.mock("../../observability/auditLog", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  logHealthDataAccessed: vi.fn().mockResolvedValue(undefined),
  logBookingCreated:     vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../memory/memoryFiles", () => ({
  readMemoryFile:  vi.fn().mockResolvedValue(""),
  writeMemoryFile: vi.fn().mockResolvedValue(undefined),
  MemoryFile: {},
}));

vi.mock("../../memory/preferences", () => ({
  getPreferences: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../agents/matchingAgent", () => ({
  runMatchingForClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/toolNotify", () => ({
  trySend:        vi.fn().mockResolvedValue({ sent: true }),
  trySendViaCara: vi.fn().mockResolvedValue({ sent: true }),
}));

import { handleToolCall } from "../server";

describe("missing CRUD tools", () => {
  beforeEach(() => { hoisted.reset(); });

  describe("get_support_tickets", () => {
    it("requires userId", async () => {
      const r = await handleToolCall("get_support_tickets", {}) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    it("returns only open tickets by default, newest first", async () => {
      hoisted.collState.set("support_tickets", [
        { id: "old", userId: "u1", subject: "A", status: "open", resolved: false, createdAt: "2026-01-01" },
        { id: "new", userId: "u1", subject: "B", status: "open", resolved: false, createdAt: "2026-03-01" },
        { id: "done", userId: "u1", subject: "C", status: "resolved", resolved: true, createdAt: "2026-02-01" },
      ]);
      const r = await handleToolCall("get_support_tickets", { userId: "u1" }) as any;
      expect(r.success).toBe(true);
      expect(r.count).toBe(2);
      expect(r.tickets.map((t: any) => t.id)).toEqual(["new", "old"]);
    });

    it("includes resolved tickets when includeResolved is set", async () => {
      hoisted.collState.set("support_tickets", [
        { id: "open1", userId: "u1", status: "open", resolved: false, createdAt: "2026-01-01" },
        { id: "done1", userId: "u1", status: "resolved", resolved: true, createdAt: "2026-02-01" },
      ]);
      const r = await handleToolCall("get_support_tickets", { userId: "u1", includeResolved: true }) as any;
      expect(r.count).toBe(2);
    });
  });

  describe("get_refund_requests", () => {
    it("requires clientId", async () => {
      const r = await handleToolCall("get_refund_requests", {}) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns requests newest first", async () => {
      hoisted.collState.set("refundRequests", [
        { id: "r1", clientId: "c1", status: "pending_review", requestedAt: "2026-01-01" },
        { id: "r2", clientId: "c1", status: "approved", requestedAt: "2026-04-01" },
      ]);
      const r = await handleToolCall("get_refund_requests", { clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.requests.map((x: any) => x.id)).toEqual(["r2", "r1"]);
    });
  });

  describe("get_shifts", () => {
    it("requires caregiverId or clientId", async () => {
      const r = await handleToolCall("get_shifts", {}) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    it("returns mapped shifts with dollar formatting, newest first", async () => {
      hoisted.collState.set("shiftHours", [
        { id: "a1", caregiverId: "cg1", status: "paid", date: "2026-02-01", durationHours: 4, amountCents: 8800, clockInTime: "09:00", clockOutTime: "13:00" },
        { id: "a2", caregiverId: "cg1", status: "pending_client_review", date: "2026-05-01", durationHours: 2, amountCents: 4400 },
      ]);
      const r = await handleToolCall("get_shifts", { caregiverId: "cg1" }) as any;
      expect(r.success).toBe(true);
      expect(r.shifts.map((s: any) => s.appointmentId)).toEqual(["a2", "a1"]);
      expect(r.shifts.find((s: any) => s.appointmentId === "a1").amountDollars).toBe("$88.00");
    });

    it("filters by status when provided", async () => {
      hoisted.collState.set("shiftHours", [
        { id: "a1", caregiverId: "cg1", status: "paid", date: "2026-02-01", amountCents: 100 },
        { id: "a2", caregiverId: "cg1", status: "pending_client_review", date: "2026-05-01", amountCents: 100 },
      ]);
      const r = await handleToolCall("get_shifts", { caregiverId: "cg1", status: "pending_client_review" }) as any;
      expect(r.count).toBe(1);
      expect(r.shifts[0].appointmentId).toBe("a2");
    });
  });

  describe("get_caregiver_availability", () => {
    it("requires caregiverId", async () => {
      const r = await handleToolCall("get_caregiver_availability", {}) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns NOT_FOUND for missing caregiver", async () => {
      const r = await handleToolCall("get_caregiver_availability", { caregiverId: "ghost" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
    });

    it("returns availability, weekly map, and preferred time", async () => {
      hoisted.docState.set("caregivers/cg1", {
        availability: ["monday", "tuesday"],
        weeklyAvailability: { monday: [{ start: "08:00", end: "12:00" }] },
        preferredTimeOfDay: "morning",
      });
      const r = await handleToolCall("get_caregiver_availability", { caregiverId: "cg1" }) as any;
      expect(r.success).toBe(true);
      expect(r.availability).toEqual(["monday", "tuesday"]);
      expect(r.weeklyAvailability.monday).toHaveLength(1);
      expect(r.preferredTimeOfDay).toBe("morning");
    });

    it("defaults missing fields to empty values", async () => {
      hoisted.docState.set("caregivers/cg2", { name: "Maria" });
      const r = await handleToolCall("get_caregiver_availability", { caregiverId: "cg2" }) as any;
      expect(r.availability).toEqual([]);
      expect(r.weeklyAvailability).toEqual({});
      expect(r.preferredTimeOfDay).toBeNull();
    });
  });

  describe("update_reminder", () => {
    it("requires phone and triggerId", async () => {
      const r = await handleToolCall("update_reminder", { phone: "+15555550001" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("requires at least one field to update", async () => {
      const r = await handleToolCall("update_reminder", { phone: "+15555550001", triggerId: "t1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    it("returns NOT_FOUND when the reminder belongs to another phone", async () => {
      hoisted.docState.set("user_triggers/t1", { phone: "+15550009999", recurrence: "daily", hour: 8, minute: 0 });
      const r = await handleToolCall("update_reminder", { phone: "+15555550001", triggerId: "t1", hour: 9 }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
    });

    it("updates the field and recomputes nextFireAt when the schedule changes", async () => {
      hoisted.docState.set("user_triggers/t1", { phone: "+15555550001", recurrence: "daily", hour: 8, minute: 0, nextFireAt: "2026-01-01T08:00:00.000Z" });
      const r = await handleToolCall("update_reminder", { phone: "+15555550001", triggerId: "t1", hour: 9 }) as any;
      expect(r.success).toBe(true);
      expect(r.updated).toBe(true);
      const upd = hoisted.updates.find(u => u.path === "user_triggers/t1");
      expect(upd?.data.hour).toBe(9);
      expect(upd?.data.nextFireAt).toBeDefined();
    });

    it("does not recompute nextFireAt for a label-only change", async () => {
      hoisted.docState.set("user_triggers/t1", { phone: "+15555550001", recurrence: "daily", hour: 8, minute: 0 });
      await handleToolCall("update_reminder", { phone: "+15555550001", triggerId: "t1", label: "new label" });
      const upd = hoisted.updates.find(u => u.path === "user_triggers/t1");
      expect(upd?.data.label).toBe("new label");
      expect(upd?.data.nextFireAt).toBeUndefined();
    });
  });

  describe("update_care_journal_entry", () => {
    it("requires caregiverId and entryId", async () => {
      const r = await handleToolCall("update_care_journal_entry", { caregiverId: "cg1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns NOT_FOUND for a missing entry", async () => {
      const r = await handleToolCall("update_care_journal_entry", { caregiverId: "cg1", entryId: "ghost", notes: "x" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
    });

    it("rejects edits from a caregiver who did not author the entry", async () => {
      hoisted.docState.set("care_journal/e1", { caregiverId: "other", notes: "..." });
      const r = await handleToolCall("update_care_journal_entry", { caregiverId: "cg1", entryId: "e1", notes: "x" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });

    it("requires at least one field beyond identifiers", async () => {
      hoisted.docState.set("care_journal/e1", { caregiverId: "cg1", notes: "..." });
      const r = await handleToolCall("update_care_journal_entry", { caregiverId: "cg1", entryId: "e1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    it("updates provided fields and stamps updatedAt", async () => {
      hoisted.docState.set("care_journal/e1", { caregiverId: "cg1", notes: "old" });
      const r = await handleToolCall("update_care_journal_entry", { caregiverId: "cg1", entryId: "e1", notes: "corrected", mood: "calm" }) as any;
      expect(r.success).toBe(true);
      const upd = hoisted.updates.find(u => u.path === "care_journal/e1");
      expect(upd?.data.notes).toBe("corrected");
      expect(upd?.data.mood).toBe("calm");
      expect(upd?.data.updatedAt).toBeDefined();
    });
  });
});

// Fix 3 (loop-only): the model saves jobType in whatever casing it extracted
// ("Full time", "FT", "part-time"); the caregiver doc + matching expect the
// canonical occasional|part_time|full_time enum. save_onboarding_field must
// canonicalize AT the persist site — this exercises the real wiring end-to-end
// (not just the pure normalizeOnboardingFieldValue unit), so a future edit that
// drops the normalize call (persists raw fieldValue) is caught.
describe("save_onboarding_field jobType canonicalization (Fix 3)", () => {
  const PHONE = "+15555550001";
  beforeEach(() => { hoisted.reset(); });

  const persistedJobType = () =>
    hoisted.docState.get(`agent_sessions/${PHONE}`)?.onboardingData?.jobType;

  it.each([
    ["Full time", "full_time"],
    ["FT", "full_time"],
    ["part-time", "part_time"],
    ["Occasionally", "occasional"],
  ])("normalizes %o to %o at the save site", async (raw, canonical) => {
    const r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "caregiver", fieldName: "jobType", fieldValue: raw,
    }) as any;
    expect(r.saved).toBe(true);
    expect(persistedJobType()).toBe(canonical);
  });

  it("passes an unknown jobType through unchanged (never silently dropped)", async () => {
    const r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "caregiver", fieldName: "jobType", fieldValue: "seasonal-ish",
    }) as any;
    expect(r.saved).toBe(true);
    expect(persistedJobType()).toBe("seasonal-ish");
  });
});
