import { describe, it, expect, vi, beforeEach } from "vitest";

// U2 — caregiver action-parity tools:
//   withdraw_job_application, respond_to_booking_request, start_shift,
//   complete_shift, update_shift_task, submit_media_update,
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

vi.mock("../../agents/matchingAgent", () => ({
  runMatchingForClient: vi.fn().mockResolvedValue(undefined),
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
  describe("respond_to_booking_request", () => {
    it("accept confirms the appointment in shared Firestore (web reads confirmed)", async () => {
      hoisted.docState.set("appointments/a1", { caregiverId: "cg1", clientId: "c1", status: "pending_caregiver_confirmation" });
      const r = await handleToolCall("respond_to_booking_request", { caregiverId: "cg1", appointmentId: "a1", decision: "accept" }) as any;
      expect(r.success).toBe(true);
      expect(r.status).toBe("confirmed");
      const appt = hoisted.docState.get("appointments/a1");
      expect(appt.status).toBe("confirmed");
      expect(appt.caregiverConfirmed).toBe(true);
    });

    it("decline marks the appointment declined_by_caregiver", async () => {
      hoisted.docState.set("appointments/a1", { caregiverId: "cg1", clientId: "c1", status: "pending_caregiver_confirmation" });
      const r = await handleToolCall("respond_to_booking_request", { caregiverId: "cg1", appointmentId: "a1", decision: "decline" }) as any;
      expect(r.success).toBe(true);
      expect(r.status).toBe("declined_by_caregiver");
      expect(hoisted.docState.get("appointments/a1").status).toBe("declined_by_caregiver");
    });

    it("denies responding to another caregiver's appointment", async () => {
      hoisted.docState.set("appointments/a1", { caregiverId: "OTHER", status: "pending_caregiver_confirmation" });
      const r = await handleToolCall("respond_to_booking_request", { caregiverId: "cg1", appointmentId: "a1", decision: "accept" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });

    it("accepting an already-confirmed appointment is an idempotent no-op", async () => {
      hoisted.docState.set("appointments/a1", { caregiverId: "cg1", clientId: "c1", status: "confirmed", caregiverConfirmed: true });
      const r = await handleToolCall("respond_to_booking_request", { caregiverId: "cg1", appointmentId: "a1", decision: "accept" }) as any;
      expect(r.success).toBe(true);
      expect(r.alreadyResponded).toBe(true);
    });
  });

  // ── start_shift / complete_shift ───────────────────────────────────────────
  describe("start_shift", () => {
    it("marks an appointment in_progress and records startedAt", async () => {
      hoisted.docState.set("appointments/a1", { caregiverId: "cg1", clientId: "c1", status: "confirmed" });
      const r = await handleToolCall("start_shift", { caregiverId: "cg1", appointmentId: "a1" }) as any;
      expect(r.success).toBe(true);
      expect(hoisted.docState.get("appointments/a1").status).toBe("in_progress");
      expect(hoisted.docState.get("appointments/a1").startedAt).toBeTruthy();
    });

    it("marks a shifts doc in-progress (web dashboard shape)", async () => {
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", status: "scheduled" });
      const r = await handleToolCall("start_shift", { caregiverId: "cg1", shiftId: "s1" }) as any;
      expect(r.success).toBe(true);
      expect(hoisted.docState.get("shifts/s1").status).toBe("in-progress");
    });

    it("is idempotent — starting an in-progress visit returns alreadyStarted", async () => {
      hoisted.docState.set("appointments/a1", { caregiverId: "cg1", status: "in_progress", startedAt: "2026-06-20T09:00:00Z" });
      const r = await handleToolCall("start_shift", { caregiverId: "cg1", appointmentId: "a1" }) as any;
      expect(r.success).toBe(true);
      expect(r.alreadyStarted).toBe(true);
    });
  });

  describe("complete_shift (AE7 idempotency)", () => {
    it("completes an in-progress appointment", async () => {
      hoisted.docState.set("appointments/a1", { caregiverId: "cg1", status: "in_progress" });
      const r = await handleToolCall("complete_shift", { caregiverId: "cg1", appointmentId: "a1" }) as any;
      expect(r.success).toBe(true);
      expect(hoisted.docState.get("appointments/a1").status).toBe("completed");
    });

    it("called twice does NOT create a second billable shiftHours record", async () => {
      hoisted.docState.set("appointments/a1", { caregiverId: "cg1", clientId: "c1", status: "in_progress" });
      // First completion → appointment marked completed. No shiftHours yet (submitted separately).
      const r1 = await handleToolCall("complete_shift", { caregiverId: "cg1", appointmentId: "a1" }) as any;
      expect(r1.success).toBe(true);
      // Simulate the shiftHours record being created (e.g. by submit_shift_hours).
      hoisted.docState.set("shiftHours/a1", { appointmentId: "a1", caregiverId: "cg1", clientId: "c1", status: "pending_client_review", amountCents: 4400 });
      // SMS retry: complete again — must be a no-op acknowledging the existing billable record.
      const r2 = await handleToolCall("complete_shift", { caregiverId: "cg1", appointmentId: "a1" }) as any;
      expect(r2.success).toBe(true);
      expect(r2.alreadyCompleted).toBe(true);
      expect(r2.billableRecordExists).toBe(true);
      // No NEW shiftHours doc was added.
      expect(hoisted.adds.filter((a) => a.path === "shiftHours").length).toBe(0);
      // The existing record is untouched (still one).
      expect(hoisted.docState.get("shiftHours/a1").amountCents).toBe(4400);
    });

    it("denies completing another caregiver's visit", async () => {
      hoisted.docState.set("appointments/a1", { caregiverId: "OTHER", status: "in_progress" });
      const r = await handleToolCall("complete_shift", { caregiverId: "cg1", appointmentId: "a1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });
  });

  // ── update_shift_task ──────────────────────────────────────────────────────
  describe("update_shift_task", () => {
    it("toggles a task complete and the web-read tasksCompleted array reflects it", async () => {
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", tasksCompleted: [] });
      const r = await handleToolCall("update_shift_task", { caregiverId: "cg1", shiftId: "s1", taskKey: "0_Medication" }) as any;
      expect(r.success).toBe(true);
      expect(r.completed).toBe(true);
      expect(hoisted.docState.get("shifts/s1").tasksCompleted).toContain("0_Medication");
    });

    it("undoes a task (completed=false) removing it from the array", async () => {
      hoisted.docState.set("shifts/s1", { caregiverId: "cg1", tasksCompleted: ["0_Medication"] });
      const r = await handleToolCall("update_shift_task", { caregiverId: "cg1", shiftId: "s1", taskKey: "0_Medication", completed: false }) as any;
      expect(r.success).toBe(true);
      expect(hoisted.docState.get("shifts/s1").tasksCompleted).not.toContain("0_Medication");
    });

    it("denies toggling tasks on another caregiver's shift", async () => {
      hoisted.docState.set("shifts/s1", { caregiverId: "OTHER", tasksCompleted: [] });
      const r = await handleToolCall("update_shift_task", { caregiverId: "cg1", shiftId: "s1", taskKey: "0_Medication" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });
  });

  // ── submit_media_update ────────────────────────────────────────────────────
  describe("submit_media_update", () => {
    it("creates a care_journal media entry the family feed reads", async () => {
      hoisted.docState.set("appointments/a1", { caregiverId: "cg1", clientId: "c1", seniorId: "s1" });
      const r = await handleToolCall("submit_media_update", { caregiverId: "cg1", appointmentId: "a1", mediaUrl: "https://x/p.jpg", caption: "Lunch in the garden" }) as any;
      expect(r.success).toBe(true);
      const entry = hoisted.adds.find((a) => a.path === "care_journal");
      expect(entry).toBeTruthy();
      expect(entry!.data.entryType).toBe("media");
      expect(entry!.data.mediaUrl).toBe("https://x/p.jpg");
      expect(entry!.data.seniorId).toBe("s1");
    });

    it("denies posting media to another caregiver's appointment", async () => {
      hoisted.docState.set("appointments/a1", { caregiverId: "OTHER", clientId: "c1" });
      const r = await handleToolCall("submit_media_update", { caregiverId: "cg1", appointmentId: "a1", mediaUrl: "https://x/p.jpg" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
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

    it("pushback disputes the hours and raises an admin alert", async () => {
      hoisted.docState.set("shiftHours/a1", { caregiverId: "cg1", clientId: "c1", status: "correction_requested", correctedHours: 4 });
      const r = await handleToolCall("respond_to_shift_hour_correction", { caregiverId: "cg1", appointmentId: "a1", decision: "pushback", message: "I was there 5h" }) as any;
      expect(r.success).toBe(true);
      expect(r.status).toBe("disputed");
      expect(hoisted.docState.get("shiftHours/a1").status).toBe("disputed");
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
    it("request_instant_payout delegates to the shared executeInstantPayout and reports free payout", async () => {
      payoutCommonMock.executeInstantPayout.mockResolvedValueOnce({
        payoutDocId: "p1", stripePayoutId: "po_1", amountCents: 5000, status: "pending", arrivalDate: null,
      });
      const r = await handleToolCall("request_instant_payout", { caregiverId: "cg1" }) as any;
      expect(payoutCommonMock.executeInstantPayout).toHaveBeenCalledWith(
        expect.objectContaining({ caregiverId: "cg1", source: "mcp" }),
      );
      expect(r.success).toBe(true);
      expect(r.fee).toBe(0);
      expect(r.amountCents).toBe(5000);
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
    trySend.mockClear(); trySend.mockResolvedValue({ sent: true });
    sendToPhone.mockClear(); sendToPhone.mockResolvedValue(undefined);
    payoutCreate.mockClear(); payoutCreate.mockResolvedValue({ id: "po_1", amount: 5000, status: "pending" });
    balanceRetrieve.mockClear(); balanceRetrieve.mockResolvedValue({ available: [{ amount: 10000, currency: "usd" }] });
  });

  // Scenario 1 — a client may only review (approve/reject) shift hours they own.
  describe("review_shift_hours auth + idempotency", () => {
    it("denies a client reviewing another client's shift hours (PERMISSION_DENIED)", async () => {
      hoisted.docState.set("shiftHours/a1", { clientId: "OTHER", caregiverId: "cg1", status: "pending_client_review" });
      const r = await handleToolCall("review_shift_hours", { clientId: "c1", appointmentId: "a1", decision: "approve" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
      // Status untouched — no approval, no charge can be triggered downstream.
      expect(hoisted.docState.get("shiftHours/a1").status).toBe("pending_client_review");
    });

    it("approves shift hours the client owns", async () => {
      hoisted.docState.set("shiftHours/a1", { clientId: "c1", caregiverId: "cg1", status: "pending_client_review" });
      const r = await handleToolCall("review_shift_hours", { clientId: "c1", appointmentId: "a1", decision: "approve" }) as any;
      expect(r.success).toBe(true);
      expect(hoisted.docState.get("shiftHours/a1").status).toBe("approved");
    });

    it("duplicate approval is rejected — already-approved hours cannot be re-approved (no second charge)", async () => {
      hoisted.docState.set("shiftHours/a1", { clientId: "c1", caregiverId: "cg1", status: "approved" });
      const r = await handleToolCall("review_shift_hours", { clientId: "c1", appointmentId: "a1", decision: "approve" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.message).toMatch(/already reviewed/i);
      // Still 'approved' — the second approval is a no-op, so onShiftHoursApproved
      // (which fires only on the pending→approved transition) cannot re-run.
      expect(hoisted.docState.get("shiftHours/a1").status).toBe("approved");
    });
  });

  // Scenario 5 — a refund request creates admin-visible state and never auto-refunds.
  describe("create_refund_request", () => {
    it("writes a pending_review refundRequests record and does NOT auto-refund", async () => {
      const r = await handleToolCall("create_refund_request", {
        clientId: "c1", appointmentId: "a1", reason: "Visit was cut short",
      }) as any;
      expect(r.success).toBe(true);
      expect(r.requestId).toBeTruthy();
      const req = hoisted.adds.find((a) => a.path === "refundRequests");
      expect(req).toBeTruthy();
      expect(req!.data.status).toBe("pending_review");
      expect(req!.data.clientId).toBe("c1");
      // No Stripe refund was issued — admin review is required first.
      expect(payoutCreate).not.toHaveBeenCalled();
    });

    it("requires clientId and appointmentId", async () => {
      const r = await handleToolCall("create_refund_request", { clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });
  });
});
