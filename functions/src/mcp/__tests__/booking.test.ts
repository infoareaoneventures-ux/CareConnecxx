import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("../../agents/caregiverSearch", () => ({
  presentCaregiverSearch: vi.fn(async () => ({ status: "shown", total: 0, shown: [], offset: 0, hasMore: false })),
  searchCaregivers: vi.fn(async () => ({ total: 0, caregivers: [], hasLocation: false, filters: {} })),
}));

const trySend = vi.fn().mockResolvedValue({ sent: true });
vi.mock("../../utils/toolNotify", () => ({
  trySend:        (...args: unknown[]) => trySend(...args),
  trySendViaCara: vi.fn().mockResolvedValue({ sent: true }),
}));

// Stub the Linq transport so server.ts's module graph loads.
const sendMessage = vi.fn().mockResolvedValue({ message_id: "m1" });
vi.mock("../../linq/client", () => ({
  sendMessage:        (...args: unknown[]) => sendMessage(...args),
  getOrCreateSession: vi.fn().mockResolvedValue({ chatId: "chat-cg" }),
  sendToPhone:        vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async ({ fallback }: { fallback: string }) => fallback),
}));

// Control the idempotency ledger so we can assert the handleToolCall wiring (U6)
// without a real Firestore round-trip. `claimToolExecution` returning {cached}
// short-circuits before executeToolCall, so no tool body runs.
const ledger = vi.hoisted(() => ({
  claimToolExecution: vi.fn(async (_key: string) => ({ cached: false as const })),
  settleToolExecution: vi.fn(async () => {}),
  toolExecutionKey: (id: string, name: string) => `${id}:${name}:hash`,
}));
vi.mock("../toolExecutionLedger", () => ledger);

// Make the confirmation gate accept our _confirmedActionId so the confirmed path
// (where idempotency applies) is reached.
vi.mock("../../agents/pendingActions", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    getPendingActionById: vi.fn(async () => ({ status: "awaiting", toolName: "any", phone: "+15125550123" })),
    isConfirmedActionValid: vi.fn(() => true),
  };
});

import { handleToolCall } from "../server";
import { setCaraActionExecutionStoreForTest } from "../../agents/actionNative/actionExecutionLedger";

// Pass-through duplicate-protection store: request_booking is failClosed, so
// an unavailable ledger (this file's firestore mock) would refuse to run at
// all. These suites test domain behavior, so the store never caches.
setCaraActionExecutionStoreForTest({
  async claim() {
    return { cached: false };
  },
  async settle() { /* no-op */ },
});

describe("booking tools", () => {
  beforeEach(() => {
    hoisted.reset(); trySend.mockClear(); trySend.mockResolvedValue({ sent: true });
    // Default client c1 to verified+active so the booking-domain tests below
    // exercise booking logic, not the identity/membership gate.
    hoisted.docState.set("users/c1", { identityCheckStatus: "verified", membershipStatus: "active" });
  });

  // ── U9b: read-only booking primitives extracted from request_booking ─────────
  // These must NEVER write — the whole point is that Evia can look up a rate and
  // quote a cost without committing. Each test asserts no booking task is created.
  describe("get_caregiver_booking_rate (U9b)", () => {
    it("returns the caregiver's name + hourly rate, writing nothing", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 25 });
      const r = await handleToolCall("get_caregiver_booking_rate", { caregiverId: "cg1", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.caregiverName).toBe("Maria");
      expect(r.hourlyRate).toBe(25);
      // Pure read — no agent_tasks / booking writes.
      expect(hoisted.adds.length).toBe(0);
    });

    // U6 (hallucination hardening 2026-07-17, R9): the old silent $20 fallback
    // is GONE — a missing rate is a structured RATE_UNKNOWN error telling the
    // agent to confirm the real rate, never a fabricated number.
    it("returns RATE_UNKNOWN (not a fabricated $20) when the caregiver has no rate on file", async () => {
      hoisted.docState.set("caregivers/cg2", { name: "Sam" });
      const r = await handleToolCall("get_caregiver_booking_rate", { caregiverId: "cg2" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("RATE_UNKNOWN");
      expect(r.message).toMatch(/confirm/i);
      // Escalation guidance: the agent is pointed at create_support_ticket so
      // a family who needs it resolved now has a real path.
      expect(r.message).toContain("create_support_ticket");
      expect(JSON.stringify(r)).not.toContain("20");
    });

    // Legacy prod docs can carry hourlyRate as a STRING ("25", "$25") — the
    // onboarding correction path stored raw user text whenever Number() failed.
    // Strict plain-numeric strings (optional leading "$") coerce and flow like
    // numbers; anything else stays RATE_UNKNOWN (never a guessed rate).
    it('coerces a legacy string rate "25" and returns the number 25', async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: "25" });
      const r = await handleToolCall("get_caregiver_booking_rate", { caregiverId: "cg1", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.hourlyRate).toBe(25);
      expect(hoisted.adds.length).toBe(0); // still a pure read
    });

    it('coerces a legacy "$27.50" string rate to 27.5 (leading $ stripped)', async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: "$27.50" });
      const r = await handleToolCall("get_caregiver_booking_rate", { caregiverId: "cg1", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.hourlyRate).toBe(27.5);
    });

    it("keeps RATE_UNKNOWN for junk, empty, negative, zero, and unit-suffixed rates", async () => {
      for (const bad of ["abc", "", "-5", 0, "25/hr", "Infinity", "1e3"]) {
        hoisted.docState.set("caregivers/cgbad", { name: "Pat", hourlyRate: bad });
        const r = await handleToolCall("get_caregiver_booking_rate", { caregiverId: "cgbad" }) as any;
        expect(r._toolError, `hourlyRate=${JSON.stringify(bad)}`).toBe(true);
        expect(r.code, `hourlyRate=${JSON.stringify(bad)}`).toBe("RATE_UNKNOWN");
      }
    });

    it("returns NOT_FOUND for an unknown caregiver", async () => {
      const r = await handleToolCall("get_caregiver_booking_rate", { caregiverId: "ghost" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
    });

    it("requires caregiverId", async () => {
      const r = await handleToolCall("get_caregiver_booking_rate", {}) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });
  });

  // ── U9b: request_booking's own rate/schedule resolution ───────────────────────
  describe("trigger_emergency_alert", () => {
    it("writes an active emergency_alerts doc and advises 911", async () => {
      const r = await handleToolCall("trigger_emergency_alert", { clientId: "c1", note: "Dad fell" }) as any;
      expect(r.success).toBe(true);
      expect(r.status).toBe("active");
      expect(r.advise911).toBe(true);
      expect(hoisted.adds.some((a) => a.path === "emergency_alerts")).toBe(true);
    });
    it("requires session clientId", async () => {
      const r = await handleToolCall("trigger_emergency_alert", {}) as any;
      expect(r._toolError).toBe(true);
    });
  });

  // 2026-09-14 (Hamse's call): rebuilt against the real `shifts` collection —
  // the old tools queried `appointments`, a legacy model no current visit
  // (site or Evia) writes to anymore, so they never actually worked.
  describe("shift-replacement tools (get_callout_backups / select_callout_backup)", () => {
    const PHONE = "+15550001000";

    // 2026-09-14 (Hamse's call): also sends each candidate's real profile
    // card (same tappable photo-preview link the initial matching gallery
    // sends) and writes pendingMatches, so a later "send me Maria's profile
    // again" resolves via resend_caregiver_profile like any other caregiver
    // search — this flow had neither before.
    it("get_callout_backups texts a profile card per candidate and writes pendingMatches", async () => {
      hoisted.docState.set("shifts/sh1", {
        clientId: "c1", caregiverId: "cg1", status: "needs_replacement",
        careRecipients: [{ careNeeds: ["Meal Preparation"] }],
      });
      hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: "chat-1" });
      hoisted.collState.set("booking_requests", [
        { id: "br1", clientId: "c1", caregiverId: "cg2", caregiverName: "Sam", caregiverPhotoURL: null, rate: 22, status: "accepted", updatedAt: { seconds: 100 } },
      ]);
      const r = await handleToolCall("get_callout_backups", { clientId: "c1", shiftId: "sh1", phone: PHONE }) as any;
      expect(r.success).toBe(true);
      expect(r.count).toBe(1);
      expect(r.caregivers[0]).toMatchObject({ caregiverId: "cg2", name: "Sam", source: "care_team" });
      const sentMsg = sendMessage.mock.calls.find((c: any[]) => c[0] === "chat-1")?.[1] as string;
      expect(sentMsg).toContain("Sam");
      expect(sentMsg).toContain("Tap to view Sam's profile");
      expect(hoisted.updates.find((u) => u.path === `agent_sessions/${PHONE}`)?.data.pendingMatches).toEqual([
        { id: "cg2", name: "Sam", rate: 22 },
      ]);
    });

    it("get_callout_backups requires phone", async () => {
      hoisted.docState.set("shifts/sh1", { clientId: "c1", status: "needs_replacement" });
      const r = await handleToolCall("get_callout_backups", { clientId: "c1", shiftId: "sh1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    it("get_callout_backups rejects a non-owner (IDOR)", async () => {
      hoisted.docState.set("shifts/sh1", { clientId: "OTHER", status: "needs_replacement" });
      const r = await handleToolCall("get_callout_backups", { clientId: "c1", shiftId: "sh1", phone: PHONE }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });

    it("get_callout_backups refuses a shift that isn't awaiting a replacement", async () => {
      hoisted.docState.set("shifts/sh1", { clientId: "c1", status: "scheduled" });
      const r = await handleToolCall("get_callout_backups", { clientId: "c1", shiftId: "sh1", phone: PHONE }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    // Matches the website's own handleConfirmReplacement EXACTLY: a real NEW
    // booking_requests doc (the candidate gets the normal accept/decline
    // text), NOT an outright reassignment of the original visit.
    it("select_callout_backup sends a new booking request, defaulting to the original visit's own date/time", async () => {
      hoisted.docState.set("shifts/sh1", {
        clientId: "c1", caregiverId: "cg1", status: "needs_replacement",
        date: "2026-09-15", startTime: "09:00", endTime: "13:00", address: "123 Main St", clientName: "The Family",
      });
      hoisted.docState.set("caregivers/cg2", { name: "Sam", hourlyRate: 24 });
      const r = await handleToolCall("select_callout_backup", { clientId: "c1", shiftId: "sh1", backupCaregiverId: "cg2" }) as any;
      expect(r.success).toBe(true);
      expect(r.status).toBe("pending");
      const bookingSet = hoisted.sets.find((s) => s.path.startsWith("booking_requests/"));
      expect(bookingSet?.data).toMatchObject({
        clientId: "c1", caregiverId: "cg2", caregiverName: "Sam",
        isShiftReplacement: true, replacementForShiftId: "sh1", status: "pending",
        schedule: { startDate: "2026-09-15", endDate: "2026-09-15", ongoing: false },
      });
      const newBookingId = bookingSet!.path.split("/").pop();
      expect(hoisted.updates.find((u) => u.path === "shifts/sh1")?.data).toMatchObject({
        replacementRequestId: newBookingId,
        replacementCaregiverName: "Sam",
      });
    });

    it("select_callout_backup honors an explicit different date/time for the replacement", async () => {
      hoisted.docState.set("shifts/sh1", {
        clientId: "c1", status: "needs_replacement", date: "2026-09-15", startTime: "09:00", endTime: "13:00",
      });
      hoisted.docState.set("caregivers/cg2", { name: "Sam" });
      const r = await handleToolCall("select_callout_backup", {
        clientId: "c1", shiftId: "sh1", backupCaregiverId: "cg2", date: "2026-09-16", startTime: "10:00", endTime: "12:00",
      }) as any;
      expect(r.success).toBe(true);
      const bookingSet = hoisted.sets.find((s) => s.path.startsWith("booking_requests/"));
      expect(bookingSet?.data.schedule).toMatchObject({ startDate: "2026-09-16", endDate: "2026-09-16" });
    });

    it("select_callout_backup rejects a non-owner shift", async () => {
      hoisted.docState.set("shifts/sh1", { clientId: "OTHER", status: "needs_replacement" });
      const r = await handleToolCall("select_callout_backup", { clientId: "c1", shiftId: "sh1", backupCaregiverId: "cg2" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });
  });

  describe("referral tools", () => {
    it("send_referral generates a code, persists it, and files a referral", async () => {
      hoisted.docState.set("users/u1", { userType: "client" });
      const r = await handleToolCall("send_referral", { userId: "u1", email: "friend@example.com" }) as any;
      expect(r.success).toBe(true);
      expect(r.referralCode).toMatch(/^[A-Z0-9]{6}$/);
      expect(hoisted.docState.get("users/u1").referralCode).toBe(r.referralCode); // persisted
      expect(hoisted.adds.some((a) => a.path === "referrals")).toBe(true);
    });
    it("send_referral rejects an invalid email", async () => {
      const r = await handleToolCall("send_referral", { userId: "u1", email: "not-an-email" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });
  });
});
