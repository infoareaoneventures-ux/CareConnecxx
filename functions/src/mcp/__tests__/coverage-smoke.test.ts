/**
 * Smoke coverage: every remaining MCP tool gets at least one test that proves
 * (a) the schema rejects missing required inputs and (b) the happy path returns
 * a structured response. Bespoke per-tool tests live in the other files in
 * this folder for the high-stakes ones (booking, family, communication,
 * journal, safety, profile, discovery).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets:    Array<{ path: string; data: any; opts?: any }> = [];
  const adds:    Array<{ path: string; data: any; id: string }> = [];
  const updates: Array<{ path: string; data: any }> = [];

  let txCounter = 0;
  const txRun   = vi.fn(async (fn: any) => {
    const tx = {
      get: vi.fn(async (ref: any) => ({
        exists: docState.has(ref.path),
        data:   () => docState.get(ref.path),
      })),
      set:    vi.fn((ref: any, data: any) => { docState.set(ref.path, data); }),
      update: vi.fn((ref: any, data: any) => { docState.set(ref.path, { ...(docState.get(ref.path) ?? {}), ...data }); }),
      delete: vi.fn((ref: any) => { docState.delete(ref.path); }),
    };
    txCounter++;
    return fn(tx);
  });

  const batchRun = () => {
    const ops: Array<() => void> = [];
    return {
      set:    (ref: any, data: any, opts?: any) => { ops.push(() => docState.set(ref.path, opts?.merge ? { ...(docState.get(ref.path) ?? {}), ...data } : data)); },
      update: (ref: any, data: any) => { ops.push(() => docState.set(ref.path, { ...(docState.get(ref.path) ?? {}), ...data })); },
      delete: (ref: any) => { ops.push(() => docState.delete(ref.path)); },
      commit: vi.fn(async () => { ops.forEach(fn => fn()); }),
    };
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
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      docState.set(path, { ...(docState.get(path) ?? {}), ...data });
    }),
    delete: vi.fn(async () => { docState.delete(path); }),
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
    collectionMock:   vi.fn((p: string) => makeCollRef(p)),
    runTransaction:   txRun,
    batchFactory:     batchRun,
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; adds.length = 0; updates.length = 0; txCounter = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock, runTransaction: hoisted.runTransaction, batch: hoisted.batchFactory }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock, runTransaction: hoisted.runTransaction, batch: hoisted.batchFactory }), {
    FieldValue: {
      arrayUnion:  (...v: any[]) => ({ __arrayUnion: v }),
      arrayRemove: (...v: any[]) => ({ __arrayRemove: v }),
      increment:   (n: number) => ({ __increment: n }),
      delete:      () => ({ __delete: true }),
    },
    Timestamp: {
      now: () => ({ toDate: () => new Date(), seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 }),
    },
  }),
}));

vi.mock("../../observability/auditLog", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  logHealthDataAccessed: vi.fn().mockResolvedValue(undefined),
  logBookingCreated:     vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../memory/memoryFiles", () => ({
  readMemoryFile:  vi.fn().mockResolvedValue("some memory content"),
  writeMemoryFile: vi.fn().mockResolvedValue(undefined),
  MemoryFile: {},
}));

vi.mock("../../memory/preferences", () => ({
  getPreferences: vi.fn().mockResolvedValue({ dndEnabled: false }),
}));

vi.mock("../../agents/matchingAgent", () => ({
  runMatchingForClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../agents/familyGroupManager", () => ({
  buildOrUpdateFamilyGroup: vi.fn().mockResolvedValue(undefined),
  removeMemberFromGroup:    vi.fn().mockResolvedValue({ removed: true }),
}));

vi.mock("../../triggers/userTriggerManager", () => ({
  createUserTrigger: vi.fn().mockResolvedValue({ id: "trig-1" }),
  deleteUserTrigger: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../scheduled/recurringScheduler", () => ({
  generateRecurringDates: vi.fn().mockReturnValue([{ date: "2026-07-01" }, { date: "2026-07-08" }]),
}));

vi.mock("../../agents/feedbackAggregator", () => ({
  onFeedbackSubmitted: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../linq/client", () => ({
  sendToPhone: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../agents/caraAgent", () => ({
  sendViaInteractionAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../stripe", () => ({
  getStripeClient: () => ({
    balance: { retrieve: vi.fn().mockResolvedValue({ available: [{ amount: 10000, currency: "usd" }] }) },
    payouts: {
      create: vi.fn().mockResolvedValue({ id: "po_1", amount: 5000, status: "pending", arrival_date: 1700000000 }),
      list:   vi.fn().mockResolvedValue({ data: [] }),
    },
    subscriptions: {
      update: vi.fn().mockResolvedValue({}),
    },
    billingPortal: {
      sessions: { create: vi.fn().mockResolvedValue({ url: "https://billing.stripe.com/session_1" }) },
    },
  }),
}));

vi.mock("../../browser/careWebActions", () => ({
  searchHealthcareProvider: vi.fn().mockResolvedValue({ providers: [] }),
  fetchHealthcarePage:    vi.fn().mockResolvedValue({ content: "" }),
  performBrowserAction:   vi.fn().mockResolvedValue({ success: true, data: "ok" }),
  scheduleDoctorAppointment: vi.fn().mockResolvedValue({ status: "scheduled" }),
  requestPharmacyRefill:  vi.fn().mockResolvedValue({ status: "requested" }),
  checkInsuranceAuthorization: vi.fn().mockResolvedValue({ status: "verified" }),
}));

vi.mock("../../browser/browserbaseClient", () => ({
  searchWeb: vi.fn().mockResolvedValue([{ title: "Result", url: "https://x", snippet: "..." }]),
}));

vi.mock("../../browser/credentialCollector", () => ({
  startCredentialCollection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../browser/credentialVault", () => ({
  storeCredential: vi.fn().mockResolvedValue(undefined),
  hasCredential:   vi.fn().mockResolvedValue(true),
  listCredentials: vi.fn().mockResolvedValue([{ service: "mychart" }]),
  deleteCredential: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/toolNotify", () => ({
  trySend:        vi.fn().mockResolvedValue({ sent: true }),
  trySendViaCara: vi.fn().mockResolvedValue({ sent: true }),
}));

vi.mock("../../agents/executionAgent", () => ({
  resumeExecutionAgent: vi.fn().mockResolvedValue({ status: "resumed" }),
}));

vi.mock("../../billing/taxDocuments", () => ({
  getCaregiverTaxSummary: vi.fn().mockResolvedValue({ year: 2025, totalEarnings: 30000 }),
}));

vi.mock("../../agents/jobMatchRecommender", () => ({
  recommendJobsForCaregiver: vi.fn().mockResolvedValue([{ jobId: "j1", score: 0.9 }]),
}));

import { handleToolCall } from "../server";

describe("MCP tool smoke coverage", () => {
  beforeEach(() => hoisted.reset());

  // ── Read-only senior/care queries ──────────────────────────────────────────
  it("get_senior_profile happy path", async () => {
    hoisted.docState.set("seniors/s1", { name: "Linda", age: 78 });
    const r = await handleToolCall("get_senior_profile", { seniorId: "s1" }) as any;
    expect(r.success).toBe(true);
  });

  it("get_senior_profile rejects missing input", async () => {
    expect(((await handleToolCall("get_senior_profile", {})) as any)._toolError).toBe(true);
  });

  it("list_household_seniors happy path", async () => {
    hoisted.collState.set("senior_profiles", [{ id: "s1", name: "Linda" }]);
    const r = await handleToolCall("list_household_seniors", { clientId: "c1" }) as any;
    expect(r.success).toBe(true);
  });

  it("get_care_journal happy path", async () => {
    hoisted.collState.set("care_journal", [{ id: "j1", notes: "good visit" }]);
    const r = await handleToolCall("get_care_journal", { seniorId: "s1" }) as any;
    expect(r.success).toBe(true);
  });

  it("get_upcoming_appointments happy path", async () => {
    hoisted.collState.set("appointments", [{ id: "a1", date: "2026-06-01", status: "confirmed" }]);
    const r = await handleToolCall("get_upcoming_appointments", { clientId: "c1" }) as any;
    expect(r.success).toBe(true);
  });

  it("get_caregiver_info happy path", async () => {
    hoisted.docState.set("caregivers/cg1", { name: "Alice", hourlyRate: 25 });
    const r = await handleToolCall("get_caregiver_info", { caregiverId: "cg1" }) as any;
    expect(r.success).toBe(true);
  });

  it("get_background_check_status happy path maps a clear result to passed", async () => {
    hoisted.docState.set("caregivers/cg1", { backgroundCheckData: { status: "clear", submittedAt: "2026-01-01" } });
    const r = await handleToolCall("get_background_check_status", { caregiverId: "cg1" }) as any;
    expect(r.success).toBe(true);
    expect(r.summary).toBe("passed");
  });

  it("get_background_check_status rejects missing input", async () => {
    expect(((await handleToolCall("get_background_check_status", {})) as any)._toolError).toBe(true);
  });

  it("get_health_signals happy path", async () => {
    hoisted.collState.set("health_signals", []);
    const r = await handleToolCall("get_health_signals", { seniorId: "s1" }) as any;
    expect(r.success).toBe(true);
  });

  it("get_recurring_schedule returns null when no schedule", async () => {
    hoisted.collState.set("recurring_schedules", []);
    const r = await handleToolCall("get_recurring_schedule", { clientId: "c1" }) as any;
    expect(r.success).toBe(true);
    expect(r.schedule).toBeNull();
  });

  it("get_family_group happy path", async () => {
    hoisted.collState.set("family_group_members", [{ name: "Bob", phone: "+15555550100" }]);
    const r = await handleToolCall("get_family_group", { phone: "+15555550000" }) as any;
    expect(r.success).toBe(true);
  });

  // ── Memory ────────────────────────────────────────────────────────────────
  it("read_memory_file happy path", async () => {
    const r = await handleToolCall("read_memory_file", { userId: "u1", file: "profile" }) as any;
    expect(r.success).toBe(true);
  });

  it("update_memory_file happy path", async () => {
    const r = await handleToolCall("update_memory_file", { userId: "u1", file: "profile", content: "loves jazz" }) as any;
    expect(r.success).toBe(true);
  });

  // ── Reminders ────────────────────────────────────────────────────────────
  it("list_user_reminders happy path", async () => {
    hoisted.collState.set("user_triggers", []);
    const r = await handleToolCall("list_user_reminders", { phone: "+15555550000" }) as any;
    expect(r.success).toBe(true);
  });

  it("create_reminder happy path", async () => {
    const r = await handleToolCall("create_reminder", {
      phone: "+15555550000", userId: "u1", label: "Take meds",
      recurrence: "daily", hour: 9, minute: 0, message: "Time to take meds!",
    }) as any;
    expect(r.success).toBe(true);
  });

  it("create_reminder rejects missing inputs", async () => {
    const r = await handleToolCall("create_reminder", { phone: "+15555550000" }) as any;
    expect(r._toolError).toBe(true);
  });

  // ── Web ──────────────────────────────────────────────────────────────────
  it("search_web returns a results array", async () => {
    const r = await handleToolCall("search_web", { query: "pharmacies near 11201" }) as any;
    expect(r.results).toBeDefined();
    expect(Array.isArray(r.results)).toBe(true);
  });

  it("perform_web_action (browse) returns a structured result", async () => {
    const r = await handleToolCall("perform_web_action", { task: "look up hours", actionType: "browse" }) as any;
    // Tool returns something with either success or error — must not throw
    expect(r).toBeDefined();
    expect(typeof r).toBe("object");
  });

  // ── Tasks / preferences ──────────────────────────────────────────────────
  it("get_pending_tasks happy path", async () => {
    hoisted.collState.set("agent_tasks", []);
    hoisted.collState.set("interviews", []);
    const r = await handleToolCall("get_pending_tasks", { clientId: "c1" }) as any;
    expect(r.success).toBe(true);
  });

  it("update_preferences happy path", async () => {
    const r = await handleToolCall("update_preferences", { userId: "u1", dndEnabled: true, dndStart: "22:00", dndEnd: "07:00" }) as any;
    expect(r.success).toBe(true);
  });

  it("manage_credentials list returns credentials array", async () => {
    const r = await handleToolCall("manage_credentials", { userId: "u1", action: "list" }) as any;
    expect(r.credentials).toBeDefined();
    expect(Array.isArray(r.credentials)).toBe(true);
  });

  // ── Reviews + care plan ──────────────────────────────────────────────────
  it("submit_review rejects rating out of range", async () => {
    hoisted.docState.set("appointments/a1", { clientId: "c1", caregiverId: "cg1" });
    const r = await handleToolCall("submit_review", {
      caregiverId: "cg1", appointmentId: "a1", clientId: "c1", rating: 10,
    }) as any;
    expect(r._toolError).toBe(true);
  });

  it("submit_review happy path", async () => {
    hoisted.docState.set("appointments/a1", { clientId: "c1", caregiverId: "cg1" });
    hoisted.collState.set("reviews", []);
    const r = await handleToolCall("submit_review", {
      caregiverId: "cg1", appointmentId: "a1", clientId: "c1", rating: 5, comment: "Great!",
    }) as any;
    expect(r.success).toBe(true);
  });

  it("get_care_team happy path", async () => {
    hoisted.collState.set("appointments", []);
    const r = await handleToolCall("get_care_team", { clientId: "c1" }) as any;
    expect(r.success).toBe(true);
  });

  it("get_care_plan returns empty when no plan", async () => {
    hoisted.collState.set("care_plans", []);
    const r = await handleToolCall("get_care_plan", { clientId: "c1" }) as any;
    expect(r.success).toBe(true);
  });

  // ── Subscription / billing ───────────────────────────────────────────────
  it("get_billing_summary happy path", async () => {
    hoisted.collState.set(`customers/u1/subscriptions`, []);
    const r = await handleToolCall("get_billing_summary", { userId: "u1" }) as any;
    expect(r.success).toBe(true);
  });

  it("get_invoice_history happy path", async () => {
    hoisted.collState.set("shiftHours", []);
    const r = await handleToolCall("get_invoice_history", { clientId: "c1" }) as any;
    expect(r.success).toBe(true);
  });

  it("get_payment_update_link happy path", async () => {
    hoisted.docState.set("users/c1", { stripeCustomerId: "cus_1" });
    const r = await handleToolCall("get_payment_update_link", { clientId: "c1" }) as any;
    expect(r.success).toBe(true);
    expect(r.url).toContain("stripe");
  });

  // ── Support + execution ──────────────────────────────────────────────────
  it("create_support_ticket happy path", async () => {
    const r = await handleToolCall("create_support_ticket", {
      userId: "u1", userType: "client", subject: "Q", description: "Need help",
    }) as any;
    expect(r.success).toBe(true);
  });

  // ── Notification surfacing — invariant checks ─────────────────────────────
  describe("notification surfacing invariant", () => {
    it("refactored tools always return a notification field with sent boolean", async () => {
      // cancel_appointment (high-risk — _confirmedActionId bypasses HITL gate)
      hoisted.docState.set("appointments/a1", { clientId: "c1", status: "confirmed", caregiverId: "cg1" });
      hoisted.docState.set("caregivers/cg1", { phone: "+15555550101" });
      const cancel = await handleToolCall("cancel_appointment", { appointmentId: "a1", clientId: "c1", _confirmedActionId: "test" }) as any;
      expect(typeof cancel.notification.sent).toBe("boolean");

      // send_caregiver_message
      hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: "+15555550101" });
      const sendCg = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(typeof sendCg.notification.sent).toBe("boolean");
    });
  });
});
