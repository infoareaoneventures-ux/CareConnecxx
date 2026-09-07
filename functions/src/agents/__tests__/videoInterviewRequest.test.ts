import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared implementation (2026-09-06) behind BOTH the website's
// ScheduleInterviewModal (via createVideoInterviewRequest.ts) and Evia's
// schedule_interview / respond_to_job_application MCP tools. Before this,
// Evia had its own independent write with no caregiver-eligibility check and
// no rate limit — these tests lock in parity with the site's real rules.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      const prev = docState.get(path) ?? {};
      docState.set(path, opts?.merge ? { ...prev, ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      const prev = docState.get(path) ?? {};
      docState.set(path, { ...prev, ...data });
    }),
  });
  const makeCollRef = (path: string): any => ({
    doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto_${Math.random().toString(36).slice(2)}`}`),
  });

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
    docState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    runTransactionMock,
    reset: () => docState.clear(),
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(
    () => ({ collection: hoisted.collectionMock, runTransaction: hoisted.runTransactionMock }),
    {
      Timestamp: {
        now: () => {
          const ms = Date.now();
          return { toMillis: () => ms, toDate: () => new Date(ms) };
        },
      },
    },
  );
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { requestVideoInterview, VideoInterviewRequestError } from "../videoInterviewRequest";

const CLIENT = "client_1";
const CAREGIVER = "cg_1";
const FUTURE_ISO = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const PAST_ISO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

beforeEach(() => {
  hoisted.reset();
  hoisted.docState.set(`publicCaregiverProfiles/${CAREGIVER}`, { name: "Alice Rivera", photoURL: "https://x/alice.jpg" });
  hoisted.docState.set(`users/${CLIENT}`, { name: "A Family", photoURL: "https://x/family.jpg" });
});

describe("requestVideoInterview", () => {
  it("creates a video_interviews doc with resolved names/photos, status requested", async () => {
    const result = await requestVideoInterview({
      clientId: CLIENT, caregiverId: CAREGIVER, scheduledTime: FUTURE_ISO, source: "test",
    });
    expect(result.status).toBe("requested");
    expect(result.clientId).toBe(CLIENT);
    expect(result.caregiverId).toBe(CAREGIVER);
    expect(result.caregiverName).toBe("Alice Rivera");
    expect(result.clientName).toBe("A Family");
    expect(result.caregiverPhoto).toBe("https://x/alice.jpg");
    expect(result.clientPhotoURL).toBe("https://x/family.jpg");
    const stored = hoisted.docState.get(`video_interviews/${result.id}`);
    expect(stored).toMatchObject({ status: "requested", clientId: CLIENT, caregiverId: CAREGIVER });
  });

  it("rejects a caregiver who isn't in publicCaregiverProfiles (not bookable) — the site's own eligibility gate", async () => {
    await expect(requestVideoInterview({
      clientId: CLIENT, caregiverId: "not_bookable", scheduledTime: FUTURE_ISO, source: "test",
    })).rejects.toMatchObject({ code: "failed-precondition" } satisfies Partial<VideoInterviewRequestError>);
  });

  it("rejects a scheduledTime in the past", async () => {
    await expect(requestVideoInterview({
      clientId: CLIENT, caregiverId: CAREGIVER, scheduledTime: PAST_ISO, source: "test",
    })).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("rejects a jobId that doesn't belong to this client", async () => {
    hoisted.docState.set("job_posts/job_1", { clientId: "someone_else" });
    await expect(requestVideoInterview({
      clientId: CLIENT, caregiverId: CAREGIVER, scheduledTime: FUTURE_ISO, jobId: "job_1", source: "test",
    })).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("accepts a jobId that does belong to this client, and falls back to a caller-supplied jobTitle when the job doc has none", async () => {
    hoisted.docState.set("job_posts/job_1", { clientId: CLIENT });
    const result = await requestVideoInterview({
      clientId: CLIENT, caregiverId: CAREGIVER, scheduledTime: FUTURE_ISO,
      jobId: "job_1", jobTitle: "Overnight care", source: "test",
    });
    expect(result.jobId).toBe("job_1");
    expect(result.jobTitle).toBe("Overnight care");
  });

  // 2026-09-06: Evia's schedule_interview tool only ever has a jobId to work
  // with, no reason to already know the post's title — auto-deriving from
  // the job doc itself means the tool doesn't need a redundant jobTitle input.
  it("derives jobTitle from the job doc itself when present, overriding any caller-supplied value", async () => {
    hoisted.docState.set("job_posts/job_1", { clientId: CLIENT, title: "Senior care in San Jose" });
    const result = await requestVideoInterview({
      clientId: CLIENT, caregiverId: CAREGIVER, scheduledTime: FUTURE_ISO,
      jobId: "job_1", jobTitle: "stale caller-supplied title", source: "test",
    });
    expect(result.jobTitle).toBe("Senior care in San Jose");
  });

  it("stores notes when provided", async () => {
    const result = await requestVideoInterview({
      clientId: CLIENT, caregiverId: CAREGIVER, scheduledTime: FUTURE_ISO,
      notes: "Ask about weekend availability", source: "test",
    });
    expect(result.notes).toBe("Ask about weekend availability");
  });

  it("links applicationId to job_applications (Evia's job-application-accept flow) without touching the site's clientName/caregiverName resolution", async () => {
    hoisted.docState.set("job_applications/app_1", { status: "pending" });
    const result = await requestVideoInterview({
      clientId: CLIENT, caregiverId: CAREGIVER, scheduledTime: FUTURE_ISO,
      applicationId: "app_1", source: "test",
    });
    expect(hoisted.docState.get("job_applications/app_1")).toMatchObject({ interviewId: result.id });
  });

  it("enforces the same 5-per-day cap the site's callable enforces, across 5 DIFFERENT caregivers", async () => {
    for (let i = 0; i < 5; i++) {
      hoisted.docState.set(`publicCaregiverProfiles/cg_new_${i}`, { name: `New Caregiver ${i}` });
      await requestVideoInterview({ clientId: CLIENT, caregiverId: `cg_new_${i}`, scheduledTime: FUTURE_ISO, source: "test" });
    }
    hoisted.docState.set("publicCaregiverProfiles/cg_new_6", { name: "One Too Many" });
    await expect(requestVideoInterview({
      clientId: CLIENT, caregiverId: "cg_new_6", scheduledTime: FUTURE_ISO, source: "test",
    })).rejects.toMatchObject({ code: "resource-exhausted" });
  });

  // 2026-09-06 (Hamse): the cap is meant to stop spamming many DIFFERENT
  // caregivers in one day, not to cap legitimate back-and-forth scheduling
  // with a caregiver the family is already talking to (e.g. Evia relaying a
  // counter-proposed time and re-submitting once they agree) — every round of
  // that negotiation used to burn the same daily quota as contacting a
  // stranger.
  it("does NOT cap repeated requests to the SAME caregiver (rescheduling/counter-proposal negotiation)", async () => {
    for (let i = 0; i < 8; i++) {
      await requestVideoInterview({ clientId: CLIENT, caregiverId: CAREGIVER, scheduledTime: FUTURE_ISO, source: "test" });
    }
    await expect(requestVideoInterview({
      clientId: CLIENT, caregiverId: CAREGIVER, scheduledTime: FUTURE_ISO, source: "test",
    })).resolves.toMatchObject({ caregiverId: CAREGIVER });
  });

  it("still caps at 5 distinct caregivers even when some requests are repeats of an already-contacted one", async () => {
    // Contact CAREGIVER (already-seeded) 3 times, then 4 NEW distinct caregivers —
    // 5 distinct caregivers total, the repeats to CAREGIVER shouldn't count.
    for (let i = 0; i < 3; i++) {
      await requestVideoInterview({ clientId: CLIENT, caregiverId: CAREGIVER, scheduledTime: FUTURE_ISO, source: "test" });
    }
    for (let i = 0; i < 4; i++) {
      hoisted.docState.set(`publicCaregiverProfiles/cg_extra_${i}`, { name: `Extra ${i}` });
      await requestVideoInterview({ clientId: CLIENT, caregiverId: `cg_extra_${i}`, scheduledTime: FUTURE_ISO, source: "test" });
    }
    hoisted.docState.set("publicCaregiverProfiles/cg_extra_5", { name: "Sixth Distinct" });
    await expect(requestVideoInterview({
      clientId: CLIENT, caregiverId: "cg_extra_5", scheduledTime: FUTURE_ISO, source: "test",
    })).rejects.toMatchObject({ code: "resource-exhausted" });
  });

  it("does not cap a DIFFERENT client's requests", async () => {
    hoisted.docState.set("users/client_2", { name: "Another Family" });
    for (let i = 0; i < 5; i++) {
      hoisted.docState.set(`publicCaregiverProfiles/cg_c1_${i}`, { name: `Caregiver ${i}` });
      await requestVideoInterview({ clientId: CLIENT, caregiverId: `cg_c1_${i}`, scheduledTime: FUTURE_ISO, source: "test" });
    }
    await expect(requestVideoInterview({
      clientId: "client_2", caregiverId: CAREGIVER, scheduledTime: FUTURE_ISO, source: "test",
    })).resolves.toMatchObject({ clientId: "client_2" });
  });
});
