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
      id:     path.split("/").pop(),
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
vi.mock("../../agents/caregiverSearch", () => ({
  presentCaregiverSearch: vi.fn(async () => ({ status: "shown", total: 0, shown: [], offset: 0, hasMore: false })),
  searchCaregivers: vi.fn(async () => ({ total: 0, caregivers: [], hasLocation: false, filters: {} })),
}));

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

  // 2026-09-16: the site's EditJobPostModal payload, field for field, with its rules.
  it("accepts every field the site's edit modal writes, with its rules (flexible → rate 0, ongoing → endDate '')", async () => {
    hoisted.docState.set(`job_posts/${JOB_ID}`, { clientId: CLIENT, status: "open", rate: 25, careTypes: ["Companionship"] });
    const r = await handleToolCall("edit_job_post", {
      jobId: JOB_ID, clientId: CLIENT, rateFlexible: true, jobFrequency: "part-time", ongoing: true, endDate: "2099-12-31",
      careTypes: ["Personal Care", "Companionship"], petsInHome: true, smokingHousehold: false, caregiversNeeded: 2, recipientsCount: 1,
    }) as any;
    expect(r.success).toBe(true);
    const upd = hoisted.updates.find(u => u.path === `job_posts/${JOB_ID}`)?.data;
    expect(upd).toMatchObject({
      rateFlexible: true, rate: 0, jobFrequency: "part-time", ongoing: true, endDate: "",
      careTypes: ["Personal Care", "Companionship"], petsInHome: true, smokingHousehold: false, caregiversNeeded: 2, recipientsCount: 1,
    });
  });

  it("refuses to empty the care types, like the modal", async () => {
    hoisted.docState.set(`job_posts/${JOB_ID}`, { clientId: CLIENT, status: "open", careTypes: ["Companionship"] });
    const r = await handleToolCall("edit_job_post", { jobId: JOB_ID, clientId: CLIENT, careTypes: [] }) as any;
    expect(r._toolError).toBe(true);
    expect(hoisted.updates.find(u => u.path === `job_posts/${JOB_ID}`)).toBeUndefined();
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

  // 2026-09-16: everything the Posts-tab card shows, incl. "X of Y hired".
  it("returns the card's fields — type, dates, location, care types, recipients, caregivers needed, hired count", async () => {
    hoisted.collState.set("job_posts", [{
      id: JOB_ID, clientId: CLIENT, status: "open", title: "Senior care in San Jose", jobFrequency: "part-time", rate: 23,
      startDate: "2026-09-15", city: "San Jose", zipCode: "95130", daysOfWeek: ["Monday", "Tuesday"], timeOfDay: ["morning"],
      careTypes: ["Personal Care"], recipientsCount: 1, caregiversNeeded: 1,
    }]);
    hoisted.collState.set("booking_requests", [{ id: "br1", jobId: JOB_ID, clientId: CLIENT, status: "accepted" }]);
    hoisted.collState.set("job_applications", [{ id: "a1", jobId: JOB_ID, clientId: CLIENT, status: "pending" }]);
    const r = await handleToolCall("list_client_jobs", { clientId: CLIENT, status: "open" }) as any;
    expect(r.jobs[0]).toMatchObject({
      title: "Senior care in San Jose", jobFrequency: "part-time", rate: 23, rateFlexible: false, startDate: "2026-09-15", startDayOfWeek: "Tuesday",
      location: "San Jose, 95130", careTypes: ["Personal Care"], recipientsCount: 1, caregiversNeeded: 1, hiredCount: 1, pendingApplicantCount: 1, ongoing: true,
    });
  });

  it("status 'closed' is the site's Closed pill — anything not open", async () => {
    hoisted.collState.set("job_posts", [
      { id: "j-open", clientId: CLIENT, status: "open", title: "Open one" },
      { id: "j-cancelled", clientId: CLIENT, status: "cancelled", title: "Cancelled one" },
      { id: "j-filled", clientId: CLIENT, status: "filled", title: "Filled one" },
    ]);
    const r = await handleToolCall("list_client_jobs", { clientId: CLIENT, status: "closed" }) as any;
    expect(r.jobs.map((j: any) => j.id).sort()).toEqual(["j-cancelled", "j-filled"]);
  });
});

// 2026-09-16: the View Applicants panel — pending only, with its lock labels.
describe("list_job_applicants — the panel's pending list and lock labels", () => {
  beforeEach(() => hoisted.reset());

  it("lists pending applicants only by default, labelled Hired / Booking Sent / Interviewed / Interview Sent like the panel", async () => {
    hoisted.docState.set(`job_posts/${JOB_ID}`, { clientId: CLIENT, status: "open" });
    hoisted.collState.set("job_applications", [
      { id: "a-hired", jobId: JOB_ID, clientId: CLIENT, caregiverId: "cg-hired", caregiverName: "Hired One", status: "pending" },
      { id: "a-sent", jobId: JOB_ID, clientId: CLIENT, caregiverId: "cg-sent", caregiverName: "Sent One", status: "pending" },
      { id: "a-done", jobId: JOB_ID, clientId: CLIENT, caregiverId: "cg-done", caregiverName: "Done One", status: "pending" },
      { id: "a-ivreq", jobId: JOB_ID, clientId: CLIENT, caregiverId: "cg-ivreq", caregiverName: "Requested One", status: "pending" },
      { id: "a-free", jobId: JOB_ID, clientId: CLIENT, caregiverId: "cg-free", caregiverName: "Free One", status: "pending" },
      { id: "a-rej", jobId: JOB_ID, clientId: CLIENT, caregiverId: "cg-rej", caregiverName: "Rejected One", status: "rejected" },
    ]);
    hoisted.collState.set("booking_requests", [
      { id: "br-h", clientId: CLIENT, caregiverId: "cg-hired", jobId: JOB_ID, status: "accepted", createdAt: "2026-09-01T00:00:00.000Z" },
      { id: "br-s", clientId: CLIENT, caregiverId: "cg-sent", jobId: JOB_ID, status: "pending", createdAt: "2026-09-01T00:00:00.000Z" },
    ]);
    hoisted.collState.set("video_interviews", [
      { id: "iv-d", clientId: CLIENT, caregiverId: "cg-done", jobId: JOB_ID, status: "completed" },
      { id: "iv-r", clientId: CLIENT, caregiverId: "cg-ivreq", status: "requested" },
    ]);
    const r = await handleToolCall("list_job_applicants", { jobId: JOB_ID, clientId: CLIENT }) as any;
    expect(r.success).toBe(true);
    const byId = Object.fromEntries(r.applicants.map((a: any) => [a.applicationId, a]));
    expect(Object.keys(byId).sort()).toEqual(["a-done", "a-free", "a-hired", "a-ivreq", "a-sent"]);
    expect(byId["a-hired"]).toMatchObject({ locked: true, label: "Hired" });
    expect(byId["a-sent"]).toMatchObject({ locked: true, label: "Booking Sent" });
    expect(byId["a-done"]).toMatchObject({ locked: true, label: "Interviewed" });
    expect(byId["a-ivreq"]).toMatchObject({ locked: true, label: "Interview Sent" });
    expect(byId["a-free"]).toMatchObject({ locked: false, label: null });
  });

  it("includeDecided:true also returns rejected applications", async () => {
    hoisted.docState.set(`job_posts/${JOB_ID}`, { clientId: CLIENT, status: "open" });
    hoisted.collState.set("job_applications", [
      { id: "a-rej", jobId: JOB_ID, clientId: CLIENT, caregiverId: "cg-rej", status: "rejected" },
    ]);
    const r = await handleToolCall("list_job_applicants", { jobId: JOB_ID, clientId: CLIENT, includeDecided: true }) as any;
    expect(r.applicants.map((a: any) => a.applicationId)).toEqual(["a-rej"]);
  });
});

describe("list_job_applicants — cover letter field parity", () => {
  beforeEach(() => hoisted.reset());

  // 2026-09-07: apply_to_job writes BOTH coverLetter (canonical — what the
  // website's apply flow also writes) and coverNote (a compat alias kept
  // only for older SMS-side readers). This handler used to read ONLY
  // coverNote, so any application submitted through the website's own apply
  // flow (which never sets coverNote at all) always came back with
  // coverNote: null even though a real cover letter existed — found live via
  // a real applicant ("i'm hard worker") Evia denied having on file for.
  it("reads coverLetter when coverNote was never set (a web-submitted application)", async () => {
    hoisted.docState.set(`job_posts/${JOB_ID}`, { clientId: CLIENT, status: "open" });
    hoisted.collState.set("job_applications", [
      { id: "app1", jobId: JOB_ID, caregiverId: "cg1", coverLetter: "i'm hard worker " },
    ]);
    hoisted.docState.set("caregivers/cg1", { name: "Basra Yousuf" });
    const r = await handleToolCall("list_job_applicants", { jobId: JOB_ID, clientId: CLIENT }) as any;
    expect(r.success).toBe(true);
    expect(r.applicants[0].coverNote).toBe("i'm hard worker ");
  });

  it("still falls back to the legacy coverNote field for an older SMS-submitted application", async () => {
    hoisted.docState.set(`job_posts/${JOB_ID}`, { clientId: CLIENT, status: "open" });
    hoisted.collState.set("job_applications", [
      { id: "app1", jobId: JOB_ID, caregiverId: "cg1", coverNote: "legacy note" },
    ]);
    hoisted.docState.set("caregivers/cg1", { name: "Basra Yousuf" });
    const r = await handleToolCall("list_job_applicants", { jobId: JOB_ID, clientId: CLIENT }) as any;
    expect(r.applicants[0].coverNote).toBe("legacy note");
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

  // 2026-09-16: the site's Decline button writes rejected + declinedAt and
  // sends the caregiver nothing — Evia now does exactly that.
  it("on reject: writes the site's fields (rejected + declinedAt) and does not message the caregiver", async () => {
    hoisted.docState.set("pending_actions/test", { toolName: "respond_to_job_application", status: "awaiting", expiresAt: "2999-01-01T00:00:00.000Z" });
    hoisted.docState.set("job_applications/app_1", { clientId: CLIENT, jobId: JOB_ID, caregiverId: "cg1", status: "pending" });
    hoisted.collState.set("agent_sessions", [{ id: "+15550001111", userId: "cg1", chatId: "chat-cg" }]);
    const r = await handleToolCall("respond_to_job_application", { applicationId: "app_1", clientId: CLIENT, decision: "reject", _confirmedActionId: "test" }) as any;
    expect(r.success).toBe(true);
    expect(r.notification).toBeUndefined();
    const upd = hoisted.updates.find(u => u.path === "job_applications/app_1")?.data;
    expect(upd).toEqual({ status: "rejected", declinedAt: { __serverTimestamp: true } });
  });
});
