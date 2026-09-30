import { describe, it, expect, vi, beforeEach } from "vitest";

// U2 — caregiver action-parity tools:
//   withdraw_job_application, respond_to_booking_request, start_shift,
//   complete_shift, update_shift_task, add_visit_note,
//   respond_to_shift_hour_correction, request_instant_payout (delegation).
//
// Same firebase-admin mock shape as booking.test.ts: docState backs .doc().get(),
// collState backs .where().get() (filters are ignored — seed the queried path).

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets:    Array<{ path: string; data: any; opts?: any }> = [];
  const adds:    Array<{ path: string; data: any; id: string }> = [];
  const updates: Array<{ path: string; data: any }> = [];

  const applyFieldValue = (existing: any, data: any) => {
    const out = { ...(existing ?? {}) };
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "__arrayUnion" in (v as any)) {
        const cur: any[] = Array.isArray(out[k]) ? out[k] : [];
        out[k] = [...cur, ...((v as any).__arrayUnion).filter((x: any) => !cur.includes(x))];
      } else if (v && typeof v === "object" && "__arrayRemove" in (v as any)) {
        const cur: any[] = Array.isArray(out[k]) ? out[k] : [];
        out[k] = cur.filter((x) => !((v as any).__arrayRemove).includes(x));
      } else {
        out[k] = v;
      }
    }
    return out;
  };

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({
      exists: docState.has(path),
      data:   () => docState.get(path),
      ref:    makeDocRef(path),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data, opts });
      docState.set(path, opts?.merge ? applyFieldValue(docState.get(path), data) : data);
    }),
    create: vi.fn(async (data: any) => {
      if (docState.has(path)) throw Object.assign(new Error("already exists"), { code: 6 });
      sets.push({ path, data });
      docState.set(path, data);
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      docState.set(path, applyFieldValue(docState.get(path), data));
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
    // WriteBatch shim for notifyAdmins (billing/reviewShiftHours.ts).
    batch: () => ({ set: (ref: any, data: any) => { ref.set(data); }, update: (ref: any, data: any) => { ref.update(data); }, commit: async () => undefined }),
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; adds.length = 0; updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock, batch: hoisted.batch }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock, batch: hoisted.batch }), {
    FieldValue: {
      arrayUnion:  (...v: any[]) => ({ __arrayUnion: v }),
      arrayRemove: (...v: any[]) => ({ __arrayRemove: v }),
      increment:   (n: number) => ({ __increment: n }),
      delete:      () => ({ __delete: true }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
    Timestamp: {
      fromMillis: (ms: number) => ({ __timestampMillis: ms }),
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

const sendToPhone = vi.fn().mockResolvedValue(undefined);
vi.mock("../../linq/client", () => ({
  sendMessage:        vi.fn().mockResolvedValue({ message_id: "m1" }),
  getOrCreateSession: vi.fn().mockResolvedValue({ chatId: "chat-cg" }),
  sendToPhone:        (...args: unknown[]) => sendToPhone(...args),
}));

vi.mock("../../agents/caraAgent", () => ({
  sendViaInteractionAgent: vi.fn().mockResolvedValue(undefined),
}));

// Stripe — track payout calls so we can assert method + that it was actually called.
const payoutCreate = vi.fn().mockResolvedValue({ id: "po_1", amount: 5000, status: "pending" });
const balanceRetrieve = vi.fn().mockResolvedValue({ available: [{ amount: 10000, currency: "usd" }] });
vi.mock("../../stripe", () => ({
  getStripeClient: () => ({
    balance: { retrieve: balanceRetrieve },
    payouts: { create: payoutCreate },
  }),
}));

// Shared payout implementation — request_instant_payout must delegate here.
const payoutCommonMock = vi.hoisted(() => {
  class InstantPayoutError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = "InstantPayoutError";
    }
  }
  return { executeInstantPayout: vi.fn(), InstantPayoutError };
});
vi.mock("../../payoutCommon", () => ({
  executeInstantPayout: (...args: unknown[]) => payoutCommonMock.executeInstantPayout(...args),
  InstantPayoutError: payoutCommonMock.InstantPayoutError,
}));

const notifyAdmins = vi.fn().mockResolvedValue(undefined);
vi.mock("../../shiftHours", () => ({
  notifyAdmins: (...args: unknown[]) => notifyAdmins(...args),
}));

// These tests target the tools' own payment-safety logic (ownership, no
// double-charge, pending_review). The runtime confirmation gate cara-100 added
// to handleToolCall (ALWAYS_CONFIRM / CONDITIONAL_CONFIRM) has its own suite, so
// bypass just isHighRisk here to reach the underlying handlers; keep every other
// real export intact.
vi.mock("../../agents/pendingActions", async (importActual) => ({
  ...(await importActual<typeof import("../../agents/pendingActions")>()),
  isHighRisk: () => false,
}));

import { handleToolCall } from "../server";
import { setCaraActionExecutionStoreForTest } from "../../agents/actionNative/actionExecutionLedger";

// Pass-through duplicate-protection store: submit/review_shift_hours are
// failClosed, so an unavailable ledger (this file's firestore mock) would
// refuse to run. These suites test the DOMAIN idempotency guards (status
// preconditions), so the store never caches — every call reaches the handler.
setCaraActionExecutionStoreForTest({
  async claim() {
    return { cached: false };
  },
  async settle() { /* no-op */ },
});

describe("U2 caregiver action tools", () => {
  beforeEach(() => {
    hoisted.reset();
    // The acting caregiver is fully cleared — the website's action gate
    // (membership → background check) now runs inside these tools too.
    hoisted.docState.set("caregivers/cg1", { name: "Test Caregiver", membershipStatus: "active", verified: true });
    trySend.mockClear(); trySend.mockResolvedValue({ sent: true });
    sendToPhone.mockClear(); sendToPhone.mockResolvedValue(undefined);
    payoutCreate.mockClear(); payoutCreate.mockResolvedValue({ id: "po_1", amount: 5000, status: "pending" });
    balanceRetrieve.mockClear(); balanceRetrieve.mockResolvedValue({ available: [{ amount: 10000, currency: "usd" }] });
    payoutCommonMock.executeInstantPayout.mockReset();
  });

  // ── withdraw_job_application ───────────────────────────────────────────────
  describe("withdraw_job_application", () => {
    it("withdraws a pending application owned by the caregiver", async () => {
      hoisted.docState.set("job_applications/app1", { caregiverId: "cg1", clientId: "c1", jobId: "j1", status: "pending" });
      const r = await handleToolCall("withdraw_job_application", { caregiverId: "cg1", applicationId: "app1" }) as any;
      expect(r.success).toBe(true);
      expect(r.status).toBe("withdrawn");
      expect(hoisted.docState.get("job_applications/app1").status).toBe("withdrawn");
    });

    it("denies withdrawing another caregiver's application (PERMISSION_DENIED)", async () => {
      hoisted.docState.set("job_applications/app1", { caregiverId: "OTHER", status: "pending" });
      const r = await handleToolCall("withdraw_job_application", { caregiverId: "cg1", applicationId: "app1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });

    it("rejects withdrawing an already-decided application", async () => {
      hoisted.docState.set("job_applications/app1", { caregiverId: "cg1", status: "accepted" });
      const r = await handleToolCall("withdraw_job_application", { caregiverId: "cg1", applicationId: "app1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("is idempotent — withdrawing twice succeeds without error", async () => {
      hoisted.docState.set("job_applications/app1", { caregiverId: "cg1", status: "withdrawn" });
      const r = await handleToolCall("withdraw_job_application", { caregiverId: "cg1", applicationId: "app1" }) as any;
      expect(r.success).toBe(true);
      expect(r.alreadyWithdrawn).toBe(true);
    });
  });

  // ── respond_to_booking_request (AE1) ───────────────────────────────────────
  // 2026-09-27: rebuilt to the Bookings page's Requests tab. It used to read/write
  // the retired `appointments` collection — a caregiver could not accept a real
  // booking_requests doc through Evia at all.
  describe("respond_to_booking_request", () => {
    const pending = () => ({ caregiverId: "cg1", clientId: "c1", clientName: "The Doe Family", status: "pending", createdAt: "2026-09-27T00:00:00Z" });

    it("accept writes the page's exact patch on booking_requests: {status:'accepted', updatedAt}", async () => {
      hoisted.docState.set("booking_requests/br1", pending());
      const r = await handleToolCall("respond_to_booking_request", { caregiverId: "cg1", bookingRequestId: "br1", decision: "accept" }) as any;
      expect(r.success).toBe(true);
      expect(r.status).toBe("accepted");
      const doc = hoisted.docState.get("booking_requests/br1");
      expect(doc.status).toBe("accepted");
      expect(doc.updatedAt).toEqual({ __serverTimestamp: true });
      expect(Object.keys(doc).sort()).toEqual([...Object.keys(pending()), "updatedAt"].sort()); // nothing else written
    });

    it("decline writes {status:'declined', updatedAt}", async () => {
      hoisted.docState.set("booking_requests/br1", pending());
      const r = await handleToolCall("respond_to_booking_request", { caregiverId: "cg1", bookingRequestId: "br1", decision: "decline" }) as any;
      expect(r.success).toBe(true);
      expect(r.status).toBe("declined");
      expect(hoisted.docState.get("booking_requests/br1").status).toBe("declined");
    });

    it("refuses another caregiver's request", async () => {
      hoisted.docState.set("booking_requests/br1", { ...pending(), caregiverId: "OTHER" });
      const r = await handleToolCall("respond_to_booking_request", { caregiverId: "cg1", bookingRequestId: "br1", decision: "accept" }) as any;
      expect(r._toolError).toBe(true);
      expect(hoisted.docState.get("booking_requests/br1").status).toBe("pending");
    });

    it("a request that is no longer pending is refused, not re-written", async () => {
      hoisted.docState.set("booking_requests/br1", { ...pending(), status: "accepted" });
      const r = await handleToolCall("respond_to_booking_request", { caregiverId: "cg1", bookingRequestId: "br1", decision: "decline" }) as any;
      expect(r._toolError).toBe(true);
      expect(String(r.message)).toContain("already accepted");
    });
  });

  // ── start_shift / complete_shift ───────────────────────────────────────────
  // The Bookings page's per-visit buttons (agents/inShift.ts, 2026-09-28):
  // shifts only, the page's conditions, the page's writes.
  const la = (d: Date) => { const p: Record<string, string> = {}; for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d)) p[x.type] = x.value; return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` }; };
  const RECIPIENTS = [{ name: "Mai", careNeeds: ["Companionship", "Mobility Assistance"], careNeedDetails: { "Mobility Assistance": ["Transfer Assist", "Walking"] } }];

  describe("start_shift", () => {
    it("starts a scheduled visit inside the 15-minute window with the page's write and returns the numbered tasks", async () => {
      const { date, time } = la(new Date(Date.now() + 10 * 60 * 1000));
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", clientId: "c1", clientName: "Fam", status: "scheduled", date, startTime: time, endTime: "23:59", careRecipients: RECIPIENTS });
      const r = await handleToolCall("start_shift", { caregiverId: "cg1", shiftId: "s1" }) as any;
      expect(r.success).toBe(true);
      expect(hoisted.docState.get("shifts/s1")).toMatchObject({ status: "in-progress", startedAt: { __serverTimestamp: true }, updatedAt: { __serverTimestamp: true } });
      expect(r.tasks.map((t: any) => t.label)).toEqual(["Companionship", "Mobility Assistance — Transfer Assist", "Mobility Assistance — Walking"]);
    });

    it("refuses the page's hidden cases: too early, overdue, not scheduled", async () => {
      const { date, time } = la(new Date(Date.now() + 3 * 60 * 60 * 1000));
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", status: "scheduled", date, startTime: time, endTime: "23:59" });
      let r = await handleToolCall("start_shift", { caregiverId: "cg1", shiftId: "s1" }) as any;
      expect(r.success).toBe(false); expect(r.reason).toBe("too_early");
      expect(hoisted.docState.get("shifts/s1").status).toBe("scheduled");
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", status: "scheduled", date: "2000-01-01", startTime: "09:00", endTime: "10:00" });
      r = await handleToolCall("start_shift", { caregiverId: "cg1", shiftId: "s1" }) as any;
      expect(r.reason).toBe("overdue");
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", status: "completed", date: "2099-01-01", startTime: "09:00" });
      r = await handleToolCall("start_shift", { caregiverId: "cg1", shiftId: "s1" }) as any;
      expect(r.reason).toBe("not_scheduled");
    });

    it("is idempotent — starting an in-progress visit returns alreadyStarted; another caregiver's visit is denied", async () => {
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", status: "in-progress", date: "2099-01-01", startTime: "09:00", startedAt: "2026-06-20T09:00:00Z" });
      let r = await handleToolCall("start_shift", { caregiverId: "cg1", shiftId: "s1" }) as any;
      expect(r.success).toBe(true); expect(r.alreadyStarted).toBe(true);
      hoisted.docState.set("shifts/s1", { caregiverId: "OTHER", status: "scheduled", date: "2099-01-01", startTime: "09:00" });
      r = await handleToolCall("start_shift", { caregiverId: "cg1", shiftId: "s1" }) as any;
      expect(r._toolError).toBe(true); expect(r.code).toBe("PERMISSION_DENIED");
    });
  });

  describe("complete_shift", () => {
    it("ends the visit in progress with the page's write, incl. the closing note", async () => {
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", clientId: "c1", status: "in-progress", date: "2099-01-01", startTime: "09:00", endTime: "12:00" });
      const r = await handleToolCall("complete_shift", { caregiverId: "cg1", shiftId: "s1", notes: "Mai was cheerful." }) as any;
      expect(r.success).toBe(true);
      expect(hoisted.docState.get("shifts/s1")).toMatchObject({ status: "completed", completedAt: { __serverTimestamp: true }, updatedAt: { __serverTimestamp: true }, completionNotes: "Mai was cheerful." });
    });

    it("is idempotent — a completed visit returns alreadyCompleted; a scheduled (never started) visit can't be ended", async () => {
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", status: "in-progress", date: "2099-01-01", startTime: "09:00" });
      const r1 = await handleToolCall("complete_shift", { caregiverId: "cg1", shiftId: "s1" }) as any;
      expect(r1.success).toBe(true);
      const r2 = await handleToolCall("complete_shift", { caregiverId: "cg1", shiftId: "s1" }) as any;
      expect(r2.success).toBe(true); expect(r2.alreadyCompleted).toBe(true);
      hoisted.docState.set("shifts/s2", { caregiverId: "cg1", status: "scheduled", date: "2099-01-01", startTime: "09:00" });
      const r3 = await handleToolCall("complete_shift", { caregiverId: "cg1", shiftId: "s2" }) as any;
      expect(r3.success).toBe(false); expect(r3.reason).toBe("not_in_progress");
      expect(hoisted.docState.get("shifts/s2").status).toBe("scheduled");
    });

    it("denies completing another caregiver's visit", async () => {
      hoisted.docState.set("shifts/s1", { caregiverId: "OTHER", status: "in-progress", date: "2099-01-01" });
      const r = await handleToolCall("complete_shift", { caregiverId: "cg1", shiftId: "s1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });
  });

  // ── update_shift_task ──────────────────────────────────────────────────────
  describe("update_shift_task", () => {
    it("checks off tasks by the texted numbers and writes the full array like the page", async () => {
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", status: "in-progress", date: "2099-01-01", startTime: "09:00", careRecipients: RECIPIENTS, tasksCompleted: [] });
      const r = await handleToolCall("update_shift_task", { caregiverId: "cg1", shiftId: "s1", numbers: [1, 3] }) as any;
      expect(r.success).toBe(true);
      expect(hoisted.docState.get("shifts/s1").tasksCompleted).toEqual(["0_Companionship", "0_Mobility Assistance_Walking"]);
    });

    it("completed=false unchecks; omitted completed always checks off — a repeated call never un-checks (live 2026-09-28)", async () => {
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", status: "in-progress", date: "2099-01-01", startTime: "09:00", careRecipients: RECIPIENTS, tasksCompleted: ["0_Companionship"] });
      let r = await handleToolCall("update_shift_task", { caregiverId: "cg1", shiftId: "s1", taskKey: "0_Companionship", completed: false }) as any;
      expect(r.success).toBe(true);
      expect(hoisted.docState.get("shifts/s1").tasksCompleted).toEqual([]);
      r = await handleToolCall("update_shift_task", { caregiverId: "cg1", shiftId: "s1", taskKeys: ["0_Mobility Assistance_Transfer Assist", "0_Mobility Assistance_Walking"] }) as any;
      expect(hoisted.docState.get("shifts/s1").tasksCompleted).toEqual(["0_Mobility Assistance_Transfer Assist", "0_Mobility Assistance_Walking"]);
      r = await handleToolCall("update_shift_task", { caregiverId: "cg1", shiftId: "s1", numbers: [3] }) as any; // already done → stays done
      expect(hoisted.docState.get("shifts/s1").tasksCompleted).toEqual(["0_Mobility Assistance_Transfer Assist", "0_Mobility Assistance_Walking"]);
    });

    it("only while the visit is in progress; another caregiver's shift is denied", async () => {
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", status: "scheduled", date: "2099-01-01", startTime: "09:00", careRecipients: RECIPIENTS, tasksCompleted: [] });
      let r = await handleToolCall("update_shift_task", { caregiverId: "cg1", shiftId: "s1", numbers: [1] }) as any;
      expect(r.success).toBe(false); expect(r.reason).toBe("not_in_progress");
      hoisted.docState.set("shifts/s1", { caregiverId: "OTHER", status: "in-progress", date: "2099-01-01", tasksCompleted: [] });
      r = await handleToolCall("update_shift_task", { caregiverId: "cg1", shiftId: "s1", numbers: [1] }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });
  });

  // ── add_visit_note ─────────────────────────────────────────────────────────
  describe("add_visit_note", () => {
    it("appends the page's {at, text, by:'caregiver'} line to notesLog while in progress", async () => {
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", status: "in-progress", date: "2099-01-01", startTime: "09:00" });
      const r = await handleToolCall("add_visit_note", { caregiverId: "cg1", shiftId: "s1", text: "She ate a full lunch." }) as any;
      expect(r.success).toBe(true);
      const notesLog = hoisted.docState.get("shifts/s1").notesLog;
      expect(notesLog).toHaveLength(1);
      expect(notesLog[0]).toMatchObject({ text: "She ate a full lunch.", by: "caregiver" });
      expect(typeof notesLog[0].at).toBe("string");
    });
    it("refuses when the visit is not in progress or the note is empty", async () => {
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", status: "scheduled", date: "2099-01-01", startTime: "09:00" });
      let r = await handleToolCall("add_visit_note", { caregiverId: "cg1", shiftId: "s1", text: "hi" }) as any;
      expect(r.success).toBe(false); expect(r.reason).toBe("not_in_progress");
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", status: "in-progress", date: "2099-01-01", startTime: "09:00" });
      r = await handleToolCall("add_visit_note", { caregiverId: "cg1", shiftId: "s1", text: "   " }) as any;
      expect(r.reason).toBe("empty");
    });
  });

  // ── respond_to_shift_hour_correction ───────────────────────────────────────
  describe("respond_to_shift_hour_correction", () => {
    it("accept adopts corrected hours and re-enters client review", async () => {
      hoisted.docState.set("shiftHours/a1", { caregiverId: "cg1", clientId: "c1", status: "correction_requested", correctedHours: 4, hourlyRate: 25 });
      const r = await handleToolCall("respond_to_shift_hour_correction", { caregiverId: "cg1", appointmentId: "a1", decision: "accept" }) as any;
      expect(r.success).toBe(true);
      expect(r.status).toBe("pending_client_review");
      const sh = hoisted.docState.get("shiftHours/a1");
      expect(sh.status).toBe("pending_client_review");
      expect(sh.durationHours).toBe(4);
      expect(sh.amountCents).toBe(10000);
    });

    it("pushback sends the hours to admin review and raises an alert", async () => {
      hoisted.docState.set("shiftHours/a1", { caregiverId: "cg1", clientId: "c1", status: "correction_proposed", correctedHours: 4 });
      const r = await handleToolCall("respond_to_shift_hour_correction", { caregiverId: "cg1", appointmentId: "a1", decision: "pushback", message: "I was there 5h" }) as any;
      expect(r.success).toBe(true);
      expect(r.status).toBe("disputed_admin_review");
      expect(hoisted.docState.get("shiftHours/a1").status).toBe("disputed_admin_review");
      expect(hoisted.adds.some((a) => a.path === "admin_alerts" && a.data.type === "shift_hour_dispute")).toBe(true);
    });

    it("rejects responding when shift hours are not awaiting a correction", async () => {
      hoisted.docState.set("shiftHours/a1", { caregiverId: "cg1", status: "approved" });
      const r = await handleToolCall("respond_to_shift_hour_correction", { caregiverId: "cg1", appointmentId: "a1", decision: "accept" }) as any;
      expect(r._toolError).toBe(true);
    });
  });

  // ── payouts ─────────────────────────────────────────────────────────────────
  // Eligibility/idempotency logic lives in payoutCommon.executeInstantPayout
  // (unit-tested in payoutCommon.test.ts). Here we verify the MCP dispatcher's
  // wiring: delegation, error surfacing, and that the removed standard-payout
  // tool stays removed.
  describe("payouts", () => {
    it("request_instant_payout delegates to the shared executeInstantPayout and reports the fee", async () => {
      payoutCommonMock.executeInstantPayout.mockResolvedValueOnce({
        payoutDocId: "p1", stripePayoutId: "po_1", amountCents: 4950, grossCents: 5000, feeCents: 50, status: "pending", arrivalDate: null,
      });
      const r = await handleToolCall("request_instant_payout", { caregiverId: "cg1" }) as any;
      expect(payoutCommonMock.executeInstantPayout).toHaveBeenCalledWith(
        expect.objectContaining({ caregiverId: "cg1", source: "mcp" }),
      );
      expect(r.success).toBe(true);
      expect(r.fee).toBe(0.5);
      expect(r.amountCents).toBe(4950);
    });

    it("request_instant_payout surfaces payout preconditions as tool errors (no silent success)", async () => {
      payoutCommonMock.executeInstantPayout.mockRejectedValueOnce(
        new payoutCommonMock.InstantPayoutError("NO_BALANCE", "No funds are instantly available right now."),
      );
      const r = await handleToolCall("request_instant_payout", { caregiverId: "cg1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.success).not.toBe(true);
    });

    // U11 scenario 6 — a payout that fails unexpectedly must be ledgered and
    // raise an admin_alert so it surfaces in the Evia Control Room (never a
    // silent false success). An unexpected throw routes through the MCP
    // dispatcher's catch, which writes admin_alerts via createCaraOpsAlert.
    it("ledgers + admin-alerts an unexpected payout failure (Control Room visibility)", async () => {
      payoutCommonMock.executeInstantPayout.mockRejectedValueOnce(new Error("stripe exploded"));
      const r = await handleToolCall("request_instant_payout", { caregiverId: "cg1" }) as any;
      expect(r.success).not.toBe(true);
      expect(r._toolError).toBe(true);
      const alert = hoisted.adds.find(
        (a) => a.path === "admin_alerts" && a.data.toolName === "request_instant_payout",
      );
      expect(alert).toBeTruthy();
      expect(alert!.data.resolved).toBe(false);
    });

    // Removed 2026-07-06: standard payouts are automatic (Stripe daily
    // schedule); Stripe rejects manual standard payouts on automatic schedules.
    it("request_standard_payout no longer exists as a tool", async () => {
      const r = await handleToolCall("request_standard_payout", { caregiverId: "cg1" }) as any;
      expect(r._toolError).toBe(true);
      expect(payoutCreate).not.toHaveBeenCalled();
    });
  });

  describe("create_caregiver_referral", () => {
    it("requires structured referral fields", async () => {
      const r = await handleToolCall("create_caregiver_referral", { caregiverId: "cg1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    it("writes a non-bookable referral, texts the referred caregiver, and returns delivery status", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Jane Referrer" });

      const r = await handleToolCall("create_caregiver_referral", {
        caregiverId: "cg1",
        phone: "+15551110000",
        referredName: "Maria Lopez",
        referredPhone: "555-222-3333",
      }) as any;

      expect(r.success).toBe(true);
      expect(r.deliveryStatus).toBe("sent");
      expect(r.bookable).toBe(false);
      expect(r.eligibilityRequired).toMatchObject({
        onboardingStatus: "profile_complete",
        verificationStatus: "approved",
        checkrResult: "clear",
      });
      expect(sendToPhone).toHaveBeenCalledWith(
        "+15552223333",
        expect.stringContaining("/start?role=caregiver&ref="),
        { preferredService: "SMS" },
      );
      const referral = [...hoisted.docState.entries()].find(([path]) => path.startsWith("referrals/"));
      expect(referral?.[1]).toMatchObject({
        referrerUserId: "cg1",
        referrerRole: "caregiver",
        referredRole: "caregiver",
        referredName: "Maria Lopez",
        referredPhone: "+15552223333",
        source: "cara_sms",
        status: "invited",
        bookable: false,
        deliveryStatus: "sent",
      });
    });

    it("keeps a failed invite admin-visible without making the referred caregiver bookable", async () => {
      sendToPhone.mockRejectedValueOnce(new Error("linq down"));
      const r = await handleToolCall("create_caregiver_referral", {
        caregiverId: "cg1",
        phone: "+15551110000",
        referredName: "Maria Lopez",
        referredPhone: "+15552223333",
      }) as any;

      expect(r.success).toBe(false);
      expect(r.deliveryStatus).toBe("failed");
      expect(r.bookable).toBe(false);
      const alert = hoisted.adds.find((a) => a.path === "admin_alerts" && a.data.type === "caregiver_referral_invite_failed");
      expect(alert).toBeTruthy();
      const referral = [...hoisted.docState.entries()].find(([path]) => path.startsWith("referrals/"));
      expect(referral?.[1]).toMatchObject({
        deliveryStatus: "failed",
        bookable: false,
      });
    });
  });
});

// ── U11 — money-movement auditing / auth / idempotency / refund visibility ───
describe("U11 payment auditing & safety", () => {
  beforeEach(() => {
    hoisted.reset();
    // The acting caregiver is fully cleared — the website's action gate
    // (membership → background check) now runs inside these tools too.
    hoisted.docState.set("caregivers/cg1", { name: "Test Caregiver", membershipStatus: "active", verified: true });
    trySend.mockClear(); trySend.mockResolvedValue({ sent: true });
    sendToPhone.mockClear(); sendToPhone.mockResolvedValue(undefined);
    payoutCreate.mockClear(); payoutCreate.mockResolvedValue({ id: "po_1", amount: 5000, status: "pending" });
    balanceRetrieve.mockClear(); balanceRetrieve.mockResolvedValue({ available: [{ amount: 10000, currency: "usd" }] });
  });

  // Scenario 1 — a client may only review (approve/reject) shift hours they own.
  // 2026-08-31 (Payments/Timesheets audit): rewrote from decision/correctedHours
  // to action/proposedStartTime+proposedEndTime, matching reviewShiftHours
  // (shiftHours.ts) exactly — a correction can fix start OR end independently,
  // not just total hours — and added accept_counter/escalate, which this tool
  // previously had no equivalent for at all (a caregiver's counter-proposal
  // had no resolution path over SMS).
  describe("review_shift_hours auth + idempotency", () => {
    beforeEach(() => notifyAdmins.mockClear());

    it("denies a client reviewing another client's shift hours (PERMISSION_DENIED)", async () => {
      hoisted.docState.set("shiftHours/a1", { clientId: "OTHER", caregiverId: "cg1", status: "pending_client_review" });
      const r = await handleToolCall("review_shift_hours", { clientId: "c1", appointmentId: "a1", action: "approve" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
      // Status untouched — no approval, no charge can be triggered downstream.
      expect(hoisted.docState.get("shiftHours/a1").status).toBe("pending_client_review");
    });

    it("approves shift hours the client owns", async () => {
      hoisted.docState.set("shiftHours/a1", {
        clientId: "c1",
        caregiverId: "cg1",
        status: "pending_client_review",
        submittedStartTime: "2026-07-13T09:00:00.000Z",
        submittedEndTime: "2026-07-13T13:00:00.000Z",
        payRate: 30,
        lineItems: [],
      });
      const r = await handleToolCall("review_shift_hours", { clientId: "c1", appointmentId: "a1", action: "approve" }) as any;
      expect(r.success).toBe(true);
      const shift = hoisted.docState.get("shiftHours/a1");
      expect(shift.status).toBe("approved");
      expect(shift.resolvedBy).toBe("client");
      expect(shift.correctionHistory).toEqual([expect.objectContaining({ by: "client", action: "accepted" })]);
    });

    it("writes a complete correction proposal with independent start/end times for a disputed shift", async () => {
      hoisted.docState.set("shiftHours/a1", {
        clientId: "c1",
        caregiverId: "cg1",
        status: "pending_client_review",
        submittedStartTime: "2026-07-13T09:00:00.000Z",
        submittedEndTime: "2026-07-13T13:30:00.000Z",
        payRate: 30,
        lineItems: [],
      });

      const r = await handleToolCall("review_shift_hours", {
        clientId: "c1",
        appointmentId: "a1",
        action: "propose_correction",
        proposedStartTime: "2026-07-13T09:00:00.000Z",
        proposedEndTime: "2026-07-13T13:00:00.000Z",
        proposalReason: "Left early",
      }) as any;

      expect(r.success).toBe(true);
      expect(hoisted.docState.get("shiftHours/a1")).toMatchObject({
        status: "correction_proposed",
        proposedStartTime: "2026-07-13T09:00:00.000Z",
        proposedEndTime: "2026-07-13T13:00:00.000Z",
        proposedTotalHours: 4,
        proposedGrossPay: 120,
        proposedLineItems: [],
        proposedLineItemsTotal: 0,
        correctionRespondByAt: expect.any(String),
        proposalReason: "Left early",
      });
    });

    it("rejects propose_correction missing either time (can't guess the other one)", async () => {
      hoisted.docState.set("shiftHours/a1", { clientId: "c1", caregiverId: "cg1", status: "pending_client_review", payRate: 30 });
      const r = await handleToolCall("review_shift_hours", {
        clientId: "c1", appointmentId: "a1", action: "propose_correction", proposedStartTime: "2026-07-13T09:00:00.000Z",
      }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    it("duplicate approval is rejected — already-approved hours cannot be re-approved (no second charge)", async () => {
      hoisted.docState.set("shiftHours/a1", { clientId: "c1", caregiverId: "cg1", status: "approved" });
      const r = await handleToolCall("review_shift_hours", { clientId: "c1", appointmentId: "a1", action: "approve" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.message).toMatch(/already reviewed/i);
      // Still 'approved' — the second approval is a no-op, so onShiftHoursApproved
      // (which fires only on the pending→approved transition) cannot re-run.
      expect(hoisted.docState.get("shiftHours/a1").status).toBe("approved");
    });

    it("accepts a caregiver's counter-proposal and finalizes off the counter's own times", async () => {
      hoisted.docState.set("shiftHours/a1", {
        clientId: "c1",
        caregiverId: "cg1",
        status: "caregiver_counter_proposed",
        counterStartTime: "2026-07-13T09:30:00.000Z",
        counterEndTime: "2026-07-13T13:00:00.000Z",
        counterLineItems: [],
        payRate: 30,
      });
      const r = await handleToolCall("review_shift_hours", { clientId: "c1", appointmentId: "a1", action: "accept_counter" }) as any;
      expect(r.success).toBe(true);
      const shift = hoisted.docState.get("shiftHours/a1");
      expect(shift.status).toBe("approved");
      expect(shift.finalStartTime).toBe("2026-07-13T09:30:00.000Z");
      expect(shift.finalEndTime).toBe("2026-07-13T13:00:00.000Z");
    });

    it("rejects accept_counter/escalate when there's no counter-proposal to respond to", async () => {
      hoisted.docState.set("shiftHours/a1", { clientId: "c1", caregiverId: "cg1", status: "pending_client_review" });
      const r = await handleToolCall("review_shift_hours", { clientId: "c1", appointmentId: "a1", action: "accept_counter" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    it("escalates a dispute to admin mediation and notifies admins", async () => {
      hoisted.collState.set("users", [{ id: "admin1", userType: "admin" }]);
      hoisted.docState.set("shiftHours/a1", {
        clientId: "c1", caregiverId: "cg1", status: "caregiver_counter_proposed",
        clientName: "A Family", caregiverName: "Alice",
      });
      const r = await handleToolCall("review_shift_hours", { clientId: "c1", appointmentId: "a1", action: "escalate" }) as any;
      expect(r.success).toBe(true);
      const shift = hoisted.docState.get("shiftHours/a1");
      expect(shift.status).toBe("disputed_admin_review");
      expect(shift.correctionHistory).toEqual([expect.objectContaining({ by: "client", action: "escalated" })]);
      // The callable's own notifyAdmins ran (billing/reviewShiftHours.ts): one in-app notification per admin.
      const adminNote = hoisted.sets.find((x) => x.path.startsWith("users/admin1/notifications/"));
      expect(adminNote?.data).toMatchObject({ type: "shift_hours_admin_review", data: { appointmentId: "a1" } });
      expect(String(adminNote?.data.body)).toContain("A Family");
    });
  });

});
