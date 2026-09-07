import { describe, it, expect, vi, beforeEach } from "vitest";

// Verifies parity fixes between Evia's job-post tools and the website's own
// job_posts / job_postings / job_applications writers (services/api.ts's
// createJobPost/cancelJobPost) — edit_job_post/cancel_job_post used to write
// field names and status values the site never reads. respond_to_job_application
// (2026-08-30) used to copy useJobApplications.ts's acceptApplication, which is
// DEAD CODE never called from any live component — the real site path from
// "applied" to "hired" is schedule an interview → interview completes → the
// client sends a booking (PostsPage.tsx's handleSendBooking).

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets:    Array<{ path: string; data: any; opts?: any }> = [];
  const updates: Array<{ path: string; data: any }> = [];

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
      const prev = docState.get(path) ?? {};
      docState.set(path, opts?.merge ? { ...prev, ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      const prev = docState.get(path) ?? {};
      docState.set(path, { ...prev, ...data });
    }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  let autoId = 0;
  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`);
    ref.where   = (..._a: any[]) => ref;
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit   = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return { empty: items.length === 0, size: items.length, docs: items.map((d: any, i: number) => ({ id: d.id ?? `doc-${i}`, data: () => d, ref: makeDocRef(`${path}/${d.id ?? `doc-${i}`}`) })) };
    });
    // proposePendingAction (pendingActions.ts) uses collection().add() —
    // needed for the real confirmation round-trip test below.
    ref.add = vi.fn(async (data: any) => {
      const id = `auto-${autoId++}`;
      docState.set(`${path}/${id}`, data);
      return makeDocRef(`${path}/${id}`);
    });
    return ref;
  };

  // requestVideoInterview (agents/videoInterviewRequest.ts, shared with the
  // site's createVideoInterviewRequest callable) uses a transaction for the
  // daily rate-limit check + interview create — a plain sequential shim
  // against the same in-memory docState is enough for these tests.
  const runTransactionMock = async (fn: (t: any) => Promise<any>) => {
    const t = {
      get:    (ref: any) => ref.get(),
      set:    (ref: any, data: any, opts?: any) => ref.set(data, opts),
      update: (ref: any, data: any) => ref.update(data),
      create: (ref: any, data: any) => ref.set(data),
    };
    return fn(t);
  };

  return {
    docState, collState, sets, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    runTransactionMock,
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock, runTransaction: hoisted.runTransactionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock, runTransaction: hoisted.runTransactionMock }), {
    FieldValue: {
      arrayUnion:      (...v: any[]) => ({ __arrayUnion: v }),
      arrayRemove:     (...v: any[]) => ({ __arrayRemove: v }),
      increment:       (n: number) => ({ __increment: n }),
      delete:          () => ({ __delete: true }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
    Timestamp: {
      now: () => {
        const ms = Date.now();
        return { toMillis: () => ms, toDate: () => new Date(ms) };
      },
    },
  }),
}));

vi.mock("../../observability/auditLog", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  logHealthDataAccessed: vi.fn().mockResolvedValue(undefined),
  logBookingCreated: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../agents/matchingAgent", () => ({ runMatchingForClient: vi.fn().mockResolvedValue(undefined) }));

const trySend = vi.fn().mockResolvedValue({ sent: true });
vi.mock("../../utils/toolNotify", () => ({
  trySend:        (...args: unknown[]) => trySend(...args),
  trySendViaCara: vi.fn().mockResolvedValue({ sent: true }),
}));

const sendMessage = vi.fn().mockResolvedValue(undefined);
vi.mock("../../linq/client", () => ({
  sendMessage: (...args: unknown[]) => sendMessage(...args),
  sendToPhone: vi.fn().mockResolvedValue(undefined),
}));

import { handleToolCall } from "../server";

const CLIENT = "client_1";
const JOB_ID = "job_1";
// requestVideoInterview (shared with the site) refuses a scheduledTime in the
// past — compute a date safely ahead of "now" instead of a fixed string that
// would eventually fall behind.
const FUTURE_DATE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

describe("edit_job_post", () => {
  beforeEach(() => hoisted.reset());

  it("writes job_posts flat (rate/daysOfWeek/timeOfDay), not nested schedule.*", async () => {
    hoisted.docState.set(`job_posts/${JOB_ID}`, { clientId: CLIENT, status: "open" });
    const r = await handleToolCall("edit_job_post", {
      jobId: JOB_ID, clientId: CLIENT, rate: 30, description: "Overnight care", daysOfWeek: ["Mon", "Wed"], timeOfDay: ["morning"],
    }) as any;
    expect(r.success).toBe(true);
    const update = hoisted.updates.find(u => u.path === `job_posts/${JOB_ID}`);
    expect(update?.data).toMatchObject({ rate: 30, description: "Overnight care", daysOfWeek: ["Mon", "Wed"], timeOfDay: ["morning"] });
    expect(update?.data.hourlyRate).toBeUndefined();
    expect(update?.data["schedule.days"]).toBeUndefined();
  });

  it("mirrors to job_postings using ITS OWN field names (jobDescription/selectedDays)", async () => {
    hoisted.docState.set(`job_posts/${JOB_ID}`, { clientId: CLIENT, status: "open" });
    const r = await handleToolCall("edit_job_post", {
      jobId: JOB_ID, clientId: CLIENT, description: "Overnight care", daysOfWeek: ["Mon", "Wed"],
    }) as any;
    expect(r.success).toBe(true);
    const postingsSet = hoisted.sets.find(s => s.path === `job_postings/${CLIENT}`);
    expect(postingsSet?.data.jobDescription).toBe("Overnight care");
    expect(postingsSet?.data.selectedDays).toEqual(["Mon", "Wed"]);
    expect(postingsSet?.data.description).toBeUndefined();
    expect(postingsSet?.data.daysOfWeek).toBeUndefined();
  });

  it("refuses to edit a job post that isn't open", async () => {
    hoisted.docState.set(`job_posts/${JOB_ID}`, { clientId: CLIENT, status: "filled" });
    const r = await handleToolCall("edit_job_post", { jobId: JOB_ID, clientId: CLIENT, rate: 30 }) as any;
    expect(r._toolError).toBe(true);
  });
});

describe("cancel_job_post", () => {
  beforeEach(() => hoisted.reset());

  // cancel_job_post is high-risk (pendingActions.ts) — bypass the HITL gate
  // the same way safety.test.ts does, via a pre-approved pending_actions doc.
  beforeEach(() => hoisted.docState.set("pending_actions/test", { toolName: "cancel_job_post", status: "awaiting", expiresAt: "2999-01-01T00:00:00.000Z" }));

  it("sets status to cancelled (matches services/api.ts's cancelJobPost, not 'closed')", async () => {
    hoisted.docState.set(`job_posts/${JOB_ID}`, { clientId: CLIENT, status: "open" });
    const r = await handleToolCall("cancel_job_post", { jobId: JOB_ID, clientId: CLIENT, _confirmedActionId: "test" }) as any;
    expect(r.success).toBe(true);
    const update = hoisted.updates.find(u => u.path === `job_posts/${JOB_ID}`);
    expect(update?.data.status).toBe("cancelled");
  });

  it("refuses to cancel a job post that's already filled", async () => {
    hoisted.docState.set(`job_posts/${JOB_ID}`, { clientId: CLIENT, status: "filled" });
    const r = await handleToolCall("cancel_job_post", { jobId: JOB_ID, clientId: CLIENT, _confirmedActionId: "test" }) as any;
    expect(r._toolError).toBe(true);
  });

  it("refuses to double-cancel", async () => {
    hoisted.docState.set(`job_posts/${JOB_ID}`, { clientId: CLIENT, status: "cancelled" });
    const r = await handleToolCall("cancel_job_post", { jobId: JOB_ID, clientId: CLIENT, _confirmedActionId: "test" }) as any;
    expect(r._toolError).toBe(true);
  });
});

describe("cancel_job_post — real confirmation round-trip (propose → confirm → execute)", () => {
  // 2026-09-06: every OTHER test in this suite (and every test in
  // approvalHandler.test.ts / pendingActions.confirm.test.ts) exercises only
  // ONE half of the real confirmation flow in isolation — either a hand-seeded
  // "awaiting" pending doc calling handleToolCall directly (this file, above),
  // or a fully-mocked handleToolCall inside approvalHandler.test.ts. Neither
  // ever wires the REAL sequence: approvalHandler.executeConfirmedAction
  // claims the pending doc (awaiting → executing) BEFORE dispatching to the
  // real MCP gate with _confirmedActionId. A live test (family confirmed
  // declining a job applicant) found that real sequence ALWAYS failed with
  // PERMISSION_DENIED — isConfirmedActionValid rejected "executing", a status
  // the confirmed re-run always has by the time it's checked. This test uses
  // the REAL (unmocked) pendingActions.ts + approvalHandler.ts + handleToolCall
  // gate together, so a regression here can never again hide behind two
  // passing unit tests with a false shared assumption between them.
  beforeEach(() => hoisted.reset());

  it("a real 'yes' after a real proposal actually cancels the job post, not PERMISSION_DENIED", async () => {
    hoisted.docState.set(`job_posts/${JOB_ID}`, { clientId: CLIENT, status: "open" });
    const { handlePendingApproval } = await import("../../agents/approvalHandler");
    const { proposePendingAction } = await import("../../agents/pendingActions");

    const phone = "+15550001234";
    const proposed = await proposePendingAction({
      phone, userId: CLIENT, toolName: "cancel_job_post", toolInput: { jobId: JOB_ID, clientId: CLIENT },
    });

    const result = await handlePendingApproval({
      phone, chatId: phone, text: "yes", userId: CLIENT,
      pending: proposed as any,
    });

    expect(result).toEqual({ outcome: "handled" });
    // The real, previously-always-failing symptom: a hardcoded "didn't go
    // through" ack instead of "Done." — assert the ack the family actually got.
    expect(sendMessage).toHaveBeenCalledWith(phone, "Done.");
    const update = hoisted.updates.find(u => u.path === `job_posts/${JOB_ID}`);
    expect(update?.data.status).toBe("cancelled");
    const resolvedDoc = hoisted.docState.get(`pending_actions/${proposed.id}`);
    expect(resolvedDoc?.status).toBe("executed");
  });
});

describe("list_client_jobs", () => {
  beforeEach(() => hoisted.reset());

  it("returns daysOfWeek/timeOfDay (not a nonexistent nested schedule field)", async () => {
    hoisted.collState.set("job_posts", [{ id: JOB_ID, clientId: CLIENT, status: "open", daysOfWeek: ["Mon"], timeOfDay: ["morning"] }]);
    const r = await handleToolCall("list_client_jobs", { clientId: CLIENT }) as any;
    expect(r.success).toBe(true);
    expect(r.jobs[0]).toMatchObject({ daysOfWeek: ["Mon"], timeOfDay: ["morning"] });
    expect(r.jobs[0].schedule).toBeUndefined();
  });
});

describe("respond_to_job_application", () => {
  beforeEach(() => hoisted.reset());

  // 2026-08-30 fix: the website has NO direct "accept this applicant" action —
  // useJobApplications.ts's acceptApplication (mark filled + reject others) is
  // DEAD CODE, never called from any live component. The only real path from
  // "applied" to "hired" is schedule an interview → interview completes →
  // client sends a booking (PostsPage.tsx's handleSendBooking). "Accept" now
  // requests an interview instead of short-circuiting to filled.
  it("on accept: requests an interview (video_interviews at status 'requested') instead of marking the job filled", async () => {
    hoisted.docState.set("job_applications/app_1", { clientId: CLIENT, jobId: JOB_ID, caregiverId: "cg1", status: "pending" });
    hoisted.docState.set("job_posts/" + JOB_ID, { clientId: CLIENT, status: "open" });
    hoisted.docState.set(`users/${CLIENT}`, { identityCheckStatus: "verified", subscriptionActive: true, name: "A Family" });
    // Caregiver eligibility (requestVideoInterview) reads publicCaregiverProfiles
    // — the same bookability-gated projection the site's own interview request checks.
    hoisted.docState.set("publicCaregiverProfiles/cg1", { name: "Alice" });

    const r = await handleToolCall("respond_to_job_application", {
      applicationId: "app_1", clientId: CLIENT, decision: "accept",
      preferredDate: FUTURE_DATE, preferredTime: "14:00",
    }) as any;
    expect(r.success).toBe(true);
    expect(r.interviewId).toBeTruthy();

    // job_posts is untouched at accept-time — it only ever closes later,
    // when a booking is actually accepted (site-side onBookingAccepted).
    expect(hoisted.updates.find(u => u.path === `job_posts/${JOB_ID}`)).toBeUndefined();

    // job_applications keeps status:'pending' — only linking the interview —
    // so the applicant doesn't vanish from the website's Applicants panel,
    // which filters on status=='pending'.
    const appUpdate = hoisted.updates.find(u => u.path === "job_applications/app_1");
    expect(appUpdate?.data.status).toBeUndefined();
    expect(appUpdate?.data.interviewId).toBe(r.interviewId);

    const ivSet = hoisted.sets.find(s => s.path === `video_interviews/${r.interviewId}`);
    expect(ivSet?.data).toMatchObject({ clientId: CLIENT, caregiverId: "cg1", applicationId: "app_1", status: "requested" });
    expect(ivSet?.data.callUrl).toBeUndefined();
    // 2026-09-06: the job this interview relates to is linked automatically
    // from the application (app.jobId) — the model never needs to supply it.
    expect(ivSet?.data.jobId).toBe(JOB_ID);
  });

  it("on accept: requires preferredDate/preferredTime", async () => {
    hoisted.docState.set("job_applications/app_1", { clientId: CLIENT, jobId: JOB_ID, caregiverId: "cg1", status: "pending" });
    const r = await handleToolCall("respond_to_job_application", { applicationId: "app_1", clientId: CLIENT, decision: "accept" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("on accept: blocked by the same identity/membership gate as schedule_interview", async () => {
    hoisted.docState.set("job_applications/app_1", { clientId: CLIENT, jobId: JOB_ID, caregiverId: "cg1", status: "pending" });
    hoisted.docState.set(`users/${CLIENT}`, {}); // no identity, no membership
    const r = await handleToolCall("respond_to_job_application", {
      applicationId: "app_1", clientId: CLIENT, decision: "accept",
      preferredDate: FUTURE_DATE, preferredTime: "14:00",
    }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("IDENTITY_REQUIRED");
  });

  it("on reject: does not touch the job post or other applications", async () => {
    // Only the reject branch is high-risk (pendingActions.ts) — bypass via the
    // same pre-approved pending_actions doc pattern as safety.test.ts.
    hoisted.docState.set("pending_actions/test", { toolName: "respond_to_job_application", status: "awaiting", expiresAt: "2999-01-01T00:00:00.000Z" });
    hoisted.docState.set("job_applications/app_1", { clientId: CLIENT, jobId: JOB_ID, caregiverId: "cg1", status: "pending" });
    const r = await handleToolCall("respond_to_job_application", { applicationId: "app_1", clientId: CLIENT, decision: "reject", _confirmedActionId: "test" }) as any;
    expect(r.success).toBe(true);
    expect(hoisted.updates.find(u => u.path === `job_posts/${JOB_ID}`)).toBeUndefined();
  });
});
