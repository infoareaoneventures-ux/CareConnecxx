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
      serverTimestamp: () => ({ __serverTimestamp: true }),
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
  isTransientToolFile: vi.fn().mockReturnValue(false),
  MemoryFile: {},
}));

vi.mock("../../memory/memoryOperations", () => ({
  getMemoryReconciliationState: vi.fn().mockResolvedValue({
    pending: false,
    storageMasked: false,
    zepMasked: false,
    pendingOperationIds: [],
  }),
}));

// update_memory_file's R23 tombstone guard dynamically imports learnedFacts —
// mocked so this smoke suite never loads the real embeddings/OpenAI graph.
vi.mock("../../memory/learnedFacts", () => ({
  findTombstonedRestatement: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../memory/preferences", () => ({
  getPreferences: vi.fn().mockResolvedValue({ dndEnabled: false }),
}));

vi.mock("../../agents/caregiverSearch", () => ({
  presentCaregiverSearch: vi.fn(async () => ({ status: "shown", total: 0, shown: [], offset: 0, hasMore: false })),
  searchCaregivers: vi.fn(async () => ({ total: 0, caregivers: [], hasLocation: false, filters: {} })),
}));

vi.mock("../../agents/familyGroupManager", () => ({
  buildOrUpdateFamilyGroup: vi.fn().mockResolvedValue(undefined),
  removeMemberFromGroup:    vi.fn().mockResolvedValue({ removed: true }),
}));

vi.mock("../../triggers/userTriggerManager", () => ({
  createUserTrigger: vi.fn().mockResolvedValue({ id: "trig-1" }),
  deleteUserTrigger: vi.fn().mockResolvedValue(undefined),
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
    hoisted.collState.set("shifts", [{ id: "s1", clientId: "c1", date: "2026-06-01", status: "scheduled" }]);
    const r = await handleToolCall("get_upcoming_appointments", { clientId: "c1" }) as any;
    expect(r.success).toBe(true);
  });

  // 2026-09-14 (live-caught): a cancelled-by-caregiver visit was invisible here,
  // and results carried no id — so the agent could never hand a shiftId to
  // get_callout_backups and fell back to the general search instead.
  it("get_upcoming_appointments returns each visit's id and includes a needs_replacement visit", async () => {
    hoisted.collState.set("shifts", [
      { id: "s1", clientId: "c1", date: "2026-09-15", status: "needs_replacement", startTime: "11:00" },
      { id: "s2", clientId: "c1", date: "2026-09-16", status: "scheduled", startTime: "11:00" },
    ]);
    const r = await handleToolCall("get_upcoming_appointments", { clientId: "c1" }) as any;
    expect(r.success).toBe(true);
    expect(r.results.map((x: any) => x.id)).toEqual(["s1", "s2"]);
    expect(r.results[0].status).toBe("needs_replacement");
  });

  it("get_caregiver_info happy path", async () => {
    hoisted.docState.set("publicCaregiverProfiles/cg1", { name: "Alice", hourlyRate: 25 });
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

  it("get_active_bookings returns an empty tab when the client has no active shifts", async () => {
    hoisted.collState.set("shifts", []);
    const r = await handleToolCall("get_active_bookings", { clientId: "c1" }) as any;
    expect(r.success).toBe(true);
    expect(r.bookings).toEqual([]);
  });

  it("get_active_bookings groups active shifts per booking like the Active Bookings tab", async () => {
    hoisted.collState.set("shifts", [
      { id: "s1", clientId: "c1", bookingRequestId: "br1", caregiverId: "cg1", caregiverName: "Sam", status: "scheduled", date: "2099-09-22", startTime: "14:00", endTime: "15:00",
        schedule: { ongoing: true, startDate: "2099-09-16", dayShiftTimes: { Tue: [{ start: "14:00", end: "15:00" }] } }, rate: 5, paymentMethod: "credit" },
      { id: "s2", clientId: "c1", bookingRequestId: "br1", caregiverId: "cg1", caregiverName: "Sam", status: "scheduled", date: "2099-09-29", startTime: "14:00", endTime: "15:00",
        schedule: { ongoing: true, startDate: "2099-09-16", dayShiftTimes: { Tue: [{ start: "14:00", end: "15:00" }] } }, rate: 5, paymentMethod: "credit" },
    ]);
    const r = await handleToolCall("get_active_bookings", { clientId: "c1" }) as any;
    expect(r.success).toBe(true);
    expect(r.bookings).toHaveLength(1);
    expect(r.bookings[0]).toMatchObject({ bookingRequestId: "br1", caregiverName: "Sam", ongoing: true, weeklyHours: "1h", paymentLabel: "Card" });
    expect(r.bookings[0].upcomingShifts.map((x: any) => x.id)).toEqual(["s1", "s2"]);
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
    // R11: memory mutations require the verified session identity (phone →
    // agent_sessions.userId must match the model-supplied userId).
    hoisted.docState.set("agent_sessions/+15555550777", { userId: "u1" });
    const r = await handleToolCall("update_memory_file", { userId: "u1", file: "profile", content: "loves jazz", phone: "+15555550777" }) as any;
    expect(r.success).toBe(true);
  });

  // ── Tasks / preferences ──────────────────────────────────────────────────
  it("get_pending_tasks happy path (reads only the site's collections)", async () => {
    const r = await handleToolCall("get_pending_tasks", { clientId: "c1" }) as any;
    expect(r.success).toBe(true);
    expect(r.total).toBe(0);
    expect(r.summary).toBe("Nothing pending");
  });

  it("update_preferences happy path", async () => {
    const r = await handleToolCall("update_preferences", { userId: "u1", dndEnabled: true, dndStart: "22:00", dndEnd: "07:00" }) as any;
    expect(r.success).toBe(true);
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
    const r = await handleToolCall("get_care_plan", { clientId: "c1" }) as any;
    expect(r.success).toBe(true);
    expect(r.carePlan).toBeNull();
  });

  // ── Subscription / billing ───────────────────────────────────────────────
  it("get_membership_page happy path (no record → Select a plan)", async () => {
    hoisted.collState.set(`customers/u1/subscriptions`, []);
    const r = await handleToolCall("get_membership_page", { userId: "u1" }) as any;
    expect(r.success).toBe(true);
    expect(r.actions).toEqual(["select_plan"]);
  });

  it("get_pending_timesheets history tab happy path (the page's History pill)", async () => {
    hoisted.collState.set("shiftHours", []);
    const r = await handleToolCall("get_pending_timesheets", { clientId: "c1", tab: "history" }) as any;
    expect(r.success).toBe(true);
    expect(r.tab).toBe("history");
    expect(r.report).toMatchObject({ shifts: 0 });
  });

  it("get_payment_update_link happy path", async () => {
    hoisted.docState.set("customers/c1", { stripeCustomerId: "cus_1" });
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

  // find_replacement_caregivers (the Evia-only general matching search) was
  // removed 2026-09-14: the website has no such process — its only
  // "replacement" is the per-shift Find Replacement modal, which
  // get_callout_backups/select_callout_backup mirror. Its describe block
  // (filters echo + one-voice contract) went with it.

  describe("notification surfacing invariant", () => {
    it("refactored tools always return a notification field with sent boolean", async () => {
      // send_caregiver_message
      hoisted.docState.set("users/c1", { identityCheckStatus: "verified", membershipStatus: "active" });
      hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: "+15555550101" });
      const sendCg = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(typeof sendCg.notification.sent).toBe("boolean");
    });

    it("rejects a _confirmedActionId pointing at an already-resolved pending action", async () => {
      // U12 hardened gate: a _confirmedActionId must reference a still-valid
      // (awaiting/approved, unexpired) pending doc. An "executed" doc is already
      // resolved, so the gate must refuse with PERMISSION_DENIED rather than
      // re-running the irreversible action.
      hoisted.docState.set("pending_actions/done", { toolName: "remove_family_member", status: "executed", expiresAt: "2999-01-01T00:00:00.000Z" });
      hoisted.docState.set("senior_profiles/s1", { userId: "c1", familyMembers: [] });
      const r = await handleToolCall("remove_family_member", { seniorId: "s1", clientId: "c1", memberPhone: "+15551234567", _confirmedActionId: "done" }) as any;
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
