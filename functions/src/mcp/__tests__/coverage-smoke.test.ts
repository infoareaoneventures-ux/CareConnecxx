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
      fromMillis: (ms: number) => ({ toMillis: () => ms, seconds: Math.floor(ms / 1000), nanoseconds: 0 }),
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
  runMatchingForClient: vi.fn().mockResolvedValue("no_match"),
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
  findAppointmentSlots:   vi.fn().mockResolvedValue({ slots: [] }),
  bookAppointmentSlot:    vi.fn().mockResolvedValue({ status: "scheduled" }),
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

vi.mock("../checkrMcpClient", () => ({
  isCheckrMcpConfigured:   vi.fn().mockReturnValue(true),
  initializeCheckrSession: vi.fn().mockResolvedValue("mcp-sess-1"),
  callCheckrTool: vi.fn().mockResolvedValue({
    isError: false,
    text:    JSON.stringify({ status: "complete", result: "clear" }),
    data:    { status: "complete", result: "clear" },
  }),
  CheckrMcpError: class CheckrMcpError extends Error {
    constructor(message: string, public readonly status?: number, public readonly sessionExpired = false) {
      super(message);
      this.name = "CheckrMcpError";
    }
  },
}));

import { handleToolCall } from "../server";

describe("MCP tool smoke coverage", () => {
  beforeEach(() => hoisted.reset());

  // ── Read-only senior/care queries ──────────────────────────────────────────
  it("get_senior_profile happy path", async () => {
    hoisted.docState.set("senior_profiles/s1", { userId: "c1" });
    hoisted.docState.set("seniors/s1", { name: "Linda", age: 78 });
    const r = await handleToolCall("get_senior_profile", { seniorId: "s1", clientId: "c1" }) as any;
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
    hoisted.docState.set("senior_profiles/s1", { userId: "c1" });
    hoisted.collState.set("care_journal", [{ id: "j1", notes: "good visit" }]);
    const r = await handleToolCall("get_care_journal", { seniorId: "s1", clientId: "c1" }) as any;
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

  it("get_payout_status maps enabled payouts to active", async () => {
    hoisted.docState.set("caregivers/cg1", { payoutsEnabled: true, stripeOnboardingComplete: true, stripeAccountId: "acct_1" });
    const r = await handleToolCall("get_payout_status", { caregiverId: "cg1" }) as any;
    expect(r.success).toBe(true);
    expect(r.summary).toBe("active");
  });

  it("get_payout_status reports incomplete when the account exists but the form is unfinished", async () => {
    hoisted.docState.set("caregivers/cg1", { stripeAccountId: "acct_1", payoutsEnabled: false, stripeOnboardingComplete: false, detailsSubmitted: false });
    const r = await handleToolCall("get_payout_status", { caregiverId: "cg1" }) as any;
    expect(r.success).toBe(true);
    expect(r.summary).toBe("incomplete");
    expect(r.payoutsEnabled).toBe(false);
  });

  it("get_payout_status rejects missing input", async () => {
    expect(((await handleToolCall("get_payout_status", {})) as any)._toolError).toBe(true);
  });

  it("get_signup_completeness reports a fully-set-up caregiver as complete", async () => {
    hoisted.docState.set("caregivers/cg1", {
      name: "Alice", city: "San Jose", hourlyRate: 28, yearsExperience: 5,
      skills: ["Companionship"], availability: "weekday mornings", jobType: "part_time",
      email: "a@x.com", bio: "hi", photo: "https://x/p.jpg",
      membershipPaid: true,
      backgroundCheckData: { status: "clear" },
      payoutsEnabled: true, stripeOnboardingComplete: true, stripeAccountId: "acct_1",
      onboardingStatus: "profile_complete", status: "active",
    });
    const r = await handleToolCall("get_signup_completeness", { caregiverId: "cg1" }) as any;
    expect(r.success).toBe(true);
    expect(r.role).toBe("caregiver");
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("get_signup_completeness surfaces caregiver gaps (photo, payouts, bg check)", async () => {
    hoisted.docState.set("caregivers/cg1", {
      name: "Alice", city: "San Jose", hourlyRate: 28, yearsExperience: 5,
      skills: ["Companionship"], availability: "weekday mornings", jobType: "part_time",
      email: "a@x.com", bio: "hi",
      membershipPaid: true,
      stripeAccountId: "acct_1", payoutsEnabled: false, stripeOnboardingComplete: false,
      onboardingStatus: "profile_complete", status: "active",
    });
    const r = await handleToolCall("get_signup_completeness", { caregiverId: "cg1" }) as any;
    expect(r.success).toBe(true);
    expect(r.complete).toBe(false);
    const items = r.missing.map((m: any) => m.item);
    expect(items).toContain("profile photo");
    expect(items).toContain("payout setup");
    expect(items).toContain("background check");
  });

  it("get_signup_completeness surfaces client gaps (membership, care recipient)", async () => {
    hoisted.docState.set("users/c1", { name: "Fam", subscriptionActive: false });
    const r = await handleToolCall("get_signup_completeness", { clientId: "c1" }) as any;
    expect(r.success).toBe(true);
    expect(r.role).toBe("client");
    expect(r.complete).toBe(false);
    const items = r.missing.map((m: any) => m.item);
    expect(items).toContain("membership payment");
    expect(items).toContain("care recipient profile");
  });

  it("get_signup_completeness rejects missing input", async () => {
    expect(((await handleToolCall("get_signup_completeness", {})) as any)._toolError).toBe(true);
  });

  // ── Checkr Candidate MCP bridge ────────────────────────────────────────────
  it("request_checkr_verification happy path opens a session and persists it", async () => {
    const r = await handleToolCall("request_checkr_verification", { caregiverId: "cg1", email: "cg@example.com" }) as any;
    expect(r.success).toBe(true);
    const sess = hoisted.docState.get("checkr_mcp_sessions/cg1");
    expect(sess?.sessionId).toBe("mcp-sess-1");
    expect(sess?.verified).toBe(false);
  });

  it("request_checkr_verification rejects missing input", async () => {
    expect(((await handleToolCall("request_checkr_verification", {})) as any)._toolError).toBe(true);
    expect(((await handleToolCall("request_checkr_verification", { caregiverId: "cg1", email: "not-an-email" })) as any)._toolError).toBe(true);
  });

  it("verify_checkr_otp happy path marks the session verified", async () => {
    hoisted.docState.set("checkr_mcp_sessions/cg1", {
      sessionId: "mcp-sess-1", email: "cg@example.com", verified: false,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const r = await handleToolCall("verify_checkr_otp", { caregiverId: "cg1", code: "123456" }) as any;
    expect(r.success).toBe(true);
    expect(hoisted.docState.get("checkr_mcp_sessions/cg1")?.verified).toBe(true);
  });

  it("verify_checkr_otp rejects missing input and missing session", async () => {
    expect(((await handleToolCall("verify_checkr_otp", {})) as any)._toolError).toBe(true);
    expect(((await handleToolCall("verify_checkr_otp", { caregiverId: "cg-none", code: "123456" })) as any)._toolError).toBe(true);
  });

  it("get_checkr_report happy path returns the report on a verified session", async () => {
    hoisted.docState.set("checkr_mcp_sessions/cg1", {
      sessionId: "mcp-sess-1", email: "cg@example.com", verified: true,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const r = await handleToolCall("get_checkr_report", { caregiverId: "cg1" }) as any;
    expect(r.success).toBe(true);
    expect(r.report).toEqual({ status: "complete", result: "clear" });
  });

  it("get_checkr_report rejects missing input and an unverified session", async () => {
    expect(((await handleToolCall("get_checkr_report", {})) as any)._toolError).toBe(true);
    hoisted.docState.set("checkr_mcp_sessions/cg1", {
      sessionId: "mcp-sess-1", email: "cg@example.com", verified: false,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(((await handleToolCall("get_checkr_report", { caregiverId: "cg1" })) as any)._toolError).toBe(true);
  });

  it("get_health_signals happy path", async () => {
    hoisted.docState.set("senior_profiles/s1", { userId: "c1" });
    hoisted.collState.set("health_signals", []);
    const r = await handleToolCall("get_health_signals", { seniorId: "s1", clientId: "c1" }) as any;
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
  describe("CRUD-gap tools (U15)", () => {
    it("delete_comment removes the author's comment", async () => {
      hoisted.docState.set("care_journal/e1/comments/c1", { userId: "u1", comment: "hi" });
      const r = await handleToolCall("delete_comment", { userId: "u1", entryId: "e1", commentId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.deleted).toBe(true);
    });

    it("delete_comment refuses a non-author", async () => {
      hoisted.docState.set("care_journal/e1/comments/c1", { userId: "u1" });
      const r = await handleToolCall("delete_comment", { userId: "other", entryId: "e1", commentId: "c1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("edit_review updates the author's review", async () => {
      hoisted.docState.set("reviews/r1", { clientId: "c1", rating: 3 });
      const r = await handleToolCall("edit_review", { clientId: "c1", reviewId: "r1", rating: 5 }) as any;
      expect(r.success).toBe(true);
      expect(r.updated).toBe(true);
    });

    it("edit_review rejects an out-of-range rating", async () => {
      hoisted.docState.set("reviews/r1", { clientId: "c1", rating: 3 });
      const r = await handleToolCall("edit_review", { clientId: "c1", reviewId: "r1", rating: 9 }) as any;
      expect(r._toolError).toBe(true);
    });

    it("edit_review refuses a non-author", async () => {
      hoisted.docState.set("reviews/r1", { clientId: "c1" });
      const r = await handleToolCall("edit_review", { clientId: "other", reviewId: "r1", comment: "x" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("cancel_followup deletes the owner's scheduled follow-up", async () => {
      hoisted.docState.set("proactive_triggers/t1", { userId: "u1", message: "check in" });
      const r = await handleToolCall("cancel_followup", { triggerId: "t1", userId: "u1" }) as any;
      expect(r.success).toBe(true);
      expect(r.cancelled).toBe(true);
    });

    it("cancel_followup returns NOT_FOUND for a missing follow-up", async () => {
      const r = await handleToolCall("cancel_followup", { triggerId: "nope", userId: "u1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
    });
  });

  describe("find_replacement_caregivers filters (U17) + one-voice contract (double-send fix 2026-07-06)", () => {
    it("accepts optional filters and echoes them back", async () => {
      hoisted.docState.set("agent_sessions/+15555550000", { zipCode: "10001" });
      hoisted.docState.set("users/c1", { name: "Fam" });
      const r = await handleToolCall("find_replacement_caregivers", {
        phone: "+15555550000", chatId: "chat1", clientId: "c1",
        needs: "dementia care", nearZip: "95020", availabilityWindow: "weekday mornings", radiusMiles: 15,
      }) as any;
      expect(r.success).toBe(true);
      expect(r.filtersApplied).toMatchObject({ needs: "dementia care", nearZip: "95020", availabilityWindow: "weekday mornings", radiusMiles: 15 });
    });

    it("still works with no filters (defaults preserved)", async () => {
      hoisted.docState.set("agent_sessions/+15555550000", { zipCode: "10001" });
      hoisted.docState.set("users/c1", { name: "Fam" });
      const r = await handleToolCall("find_replacement_caregivers", { phone: "+15555550000", chatId: "chat1", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.filtersApplied).toMatchObject({ needs: null, nearZip: null });
    });

    it("suppresses matching's own conversational sends — the agent turn is the voice", async () => {
      const { runMatchingForClient } = await import("../../agents/matchingAgent");
      hoisted.docState.set("agent_sessions/+15555550000", { zipCode: "10001" });
      hoisted.docState.set("users/c1", { name: "Fam" });
      await handleToolCall("find_replacement_caregivers", { phone: "+15555550000", chatId: "chat1", clientId: "c1" });
      const call = vi.mocked(runMatchingForClient).mock.calls.at(-1)!;
      expect(call[4]).toMatchObject({ suppressConversationalSends: true });
    });

    it("no_match: reports the real outcome + an honest one-message instruction (never 'triggered: true')", async () => {
      const { runMatchingForClient } = await import("../../agents/matchingAgent");
      vi.mocked(runMatchingForClient).mockResolvedValueOnce("no_match");
      hoisted.docState.set("agent_sessions/+15555550000", { zipCode: "10001" });
      hoisted.docState.set("users/c1", { name: "Fam" });
      const r = await handleToolCall("find_replacement_caregivers", { phone: "+15555550000", chatId: "chat1", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.outcome).toBe("no_match");
      expect(r.matchesFound).toBe(0);
      expect(r.sent).toBeUndefined();          // nothing was texted — agent's reply is the only message
      expect(r.instruction).toMatch(/ONE short warm message/i);
      expect(r.triggered).toBeUndefined();     // old blind shape must not come back
    });

    it("matched: flags the already-sent gallery (sent:true) and forbids repeating it", async () => {
      const { runMatchingForClient } = await import("../../agents/matchingAgent");
      vi.mocked(runMatchingForClient).mockResolvedValueOnce("matched");
      hoisted.docState.set("agent_sessions/+15555550000", {
        zipCode: "10001",
        pendingMatches: [{ id: "cg1", name: "Maria", rate: 28 }, { id: "cg2", name: "James", rate: 25 }],
      });
      hoisted.docState.set("users/c1", { name: "Fam" });
      const r = await handleToolCall("find_replacement_caregivers", { phone: "+15555550000", chatId: "chat1", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.outcome).toBe("matched");
      expect(r.sent).toBe(true);               // hooks qaAgent's deliveredToUser guard
      expect(r.matchesPresented).toEqual([
        { name: "Maria", hourlyRate: 28 },
        { name: "James", hourlyRate: 25 },
      ]);
      expect(r.instruction).toMatch(/Do NOT repeat/i);
    });

    it("failed: honest failure with follow-up note, not a fake success", async () => {
      const { runMatchingForClient } = await import("../../agents/matchingAgent");
      vi.mocked(runMatchingForClient).mockResolvedValueOnce("failed");
      hoisted.docState.set("agent_sessions/+15555550000", { zipCode: "10001" });
      hoisted.docState.set("users/c1", { name: "Fam" });
      const r = await handleToolCall("find_replacement_caregivers", { phone: "+15555550000", chatId: "chat1", clientId: "c1" }) as any;
      expect(r.success).toBe(false);
      expect(r.outcome).toBe("failed");
      expect(r._toolError).toBeUndefined();    // a failed search is not a tool error — no recovery loop
      expect(r.instruction).toMatch(/NOTHING has been texted/i);
    });
  });

  describe("notification surfacing invariant", () => {
    it("refactored tools always return a notification field with sent boolean", async () => {
      // cancel_appointment (high-risk — _confirmedActionId bypasses HITL gate;
      // U12 validates it against a real pending doc, so seed one).
      hoisted.docState.set("pending_actions/test", { toolName: "cancel_appointment", status: "awaiting", expiresAt: "2999-01-01T00:00:00.000Z" });
      hoisted.docState.set("appointments/a1", { clientId: "c1", status: "confirmed", caregiverId: "cg1" });
      hoisted.docState.set("caregivers/cg1", { phone: "+15555550101" });
      const cancel = await handleToolCall("cancel_appointment", { appointmentId: "a1", clientId: "c1", _confirmedActionId: "test" }) as any;
      expect(typeof cancel.notification.sent).toBe("boolean");

      // send_caregiver_message
      hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: "+15555550101" });
      const sendCg = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(typeof sendCg.notification.sent).toBe("boolean");
    });

    it("rejects a _confirmedActionId pointing at an already-resolved pending action", async () => {
      // U12 hardened gate: a _confirmedActionId must reference a still-valid
      // (awaiting/approved, unexpired) pending doc. An "executed" doc is already
      // resolved, so the gate must refuse with PERMISSION_DENIED rather than
      // re-running the irreversible action.
      hoisted.docState.set("pending_actions/done", { toolName: "cancel_appointment", status: "executed", expiresAt: "2999-01-01T00:00:00.000Z" });
      hoisted.docState.set("appointments/a1", { clientId: "c1", status: "confirmed", caregiverId: "cg1" });
      const r = await handleToolCall("cancel_appointment", { appointmentId: "a1", clientId: "c1", _confirmedActionId: "done" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });
  });

  describe("consequential tool ledger", () => {
    it("records proposed and executed ledger entries for non-read-only tools", async () => {
      hoisted.docState.set("proactive_triggers/t1", { userId: "u1", message: "check in" });
      const r = await handleToolCall("cancel_followup", {
        triggerId: "t1",
        userId: "u1",
        phone: "+15555550000",
        sourceMessageId: "msg-1",
      }) as any;

      expect(r.success).toBe(true);
      await vi.waitFor(() => {
        const ledgerAdds = hoisted.adds.filter((row) => row.path === "agent_action_ledger");
        expect(ledgerAdds).toEqual(expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              actionType: "mcp_tool",
              status: "proposed",
              toolName: "cancel_followup",
              phone: "+15555550000",
              sourceMessageId: "msg-1",
            }),
          }),
          expect.objectContaining({
            data: expect.objectContaining({
              actionType: "mcp_tool",
              status: "executed",
              toolName: "cancel_followup",
              phone: "+15555550000",
              sourceMessageId: "msg-1",
            }),
          }),
        ]));
      });
    });
  });
});
