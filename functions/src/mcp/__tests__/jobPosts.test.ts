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
    return ref;
  };

  return {
    docState, collState, sets, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      arrayUnion:      (...v: any[]) => ({ __arrayUnion: v }),
      arrayRemove:     (...v: any[]) => ({ __arrayRemove: v }),
      increment:       (n: number) => ({ __increment: n }),
      delete:          () => ({ __delete: true }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
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

import { handleToolCall } from "../server";

const CLIENT = "client_1";
const JOB_ID = "job_1";

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
    hoisted.docState.set("caregivers/cg1", { name: "Alice" });

    const r = await handleToolCall("respond_to_job_application", {
      applicationId: "app_1", clientId: CLIENT, decision: "accept",
      preferredDate: "2026-09-01", preferredTime: "14:00",
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
      preferredDate: "2026-09-01", preferredTime: "14:00",
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
