import { describe, it, expect, vi, beforeEach } from "vitest";

// The stale-applicant nudge follows up with families who haven't reviewed
// caregivers waiting on their job post. The pure guard is tested below; the
// run-level block drives the job against an in-memory Firestore for the
// bell ⇄ text rule (C11, 2026-10-11).

const store = {
  jobs:         new Map<string, any>(),
  applications: new Map<string, any>(),
  sessions:     new Map<string, any>(),
  jobUpdates:   [] as Array<{ id: string; data: any }>,
};

function makeQueryCollection(map: Map<string, any>, updatesSink: Array<{ id: string; data: any }> | null) {
  const query = (filters: Array<[string, string, any]>): any => ({
    where: (field: string, op: string, value: any) => query([...filters, [field, op, value]]),
    orderBy: () => query(filters),
    limit: (_n: number) => query(filters),
    get: async () => {
      const matches = [...map.entries()].filter(([, data]) => filters.every(([f, op, v]) => (op === ">" ? data[f] > v : data[f] === v)));
      return {
        empty: matches.length === 0,
        docs: matches.map(([id, data]) => ({
          id,
          data: () => data,
          ...(updatesSink ? { ref: { update: vi.fn(async (upd: any) => { updatesSink.push({ id, data: upd }); }) } } : {}),
        })),
      };
    },
  });
  return query([]);
}

vi.mock("firebase-admin", () => {
  const collection = (name: string) => {
    if (name === "job_posts")        return makeQueryCollection(store.jobs, store.jobUpdates);
    if (name === "job_applications") return makeQueryCollection(store.applications, null);
    if (name === "agent_sessions")   return makeQueryCollection(store.sessions, null);
    return { where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }), doc: () => ({}), add: () => {} };
  };
  const firestore = () => ({ collection });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("firebase-functions/v1", () => ({
  pubsub: { schedule: () => ({ onRun: (fn: any) => fn }) },
}));

vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async (opts: any) => opts.fallback),
}));

vi.mock("../engineGate", () => ({
  gateOptionalSend: vi.fn(async () => ({ allowed: true, disposition: "send", reason: "ok" })),
}));

const order: string[] = [];
const sendSpy = vi.fn(async (..._a: unknown[]) => { order.push("text"); return true; });
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendSpy(...a) }));

const bells: any[] = [];
vi.mock("../../notifications/userNotification", () => ({
  writeUserNotification: vi.fn(async (n: any) => { bells.push(n); order.push("bell"); return true; }),
}));

import { sendStaleApplicantNudges, shouldNudgeStaleApplicants, MIN_AGE_MS, COOLDOWN_MS } from "../staleApplicantNudge";

// These guard the two boundaries that keep it from being annoying: don't fire
// before the initial alert had its window (MIN_AGE_MS), and never nag more than
// once per COOLDOWN_MS.

const NOW = 1_000_000_000_000; // fixed clock for deterministic tests

describe("shouldNudgeStaleApplicants", () => {
  it("does not nudge when there are no pending applicants", () => {
    expect(shouldNudgeStaleApplicants({
      pendingCount: 0, oldestPendingMs: NOW - MIN_AGE_MS - 1, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("does not nudge while the applicant is still fresh (initial alert owns that window)", () => {
    expect(shouldNudgeStaleApplicants({
      pendingCount: 2, oldestPendingMs: NOW - (MIN_AGE_MS - 1), lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });

  it("nudges once the oldest pending applicant is past the freshness window", () => {
    expect(shouldNudgeStaleApplicants({
      pendingCount: 2, oldestPendingMs: NOW - (MIN_AGE_MS + 1), lastNudgedMs: null, nowMs: NOW,
    })).toBe(true);
  });

  it("respects the cooldown — no second nudge within COOLDOWN_MS", () => {
    expect(shouldNudgeStaleApplicants({
      pendingCount: 3,
      oldestPendingMs: NOW - (MIN_AGE_MS + 1),
      lastNudgedMs: NOW - (COOLDOWN_MS - 1),
      nowMs: NOW,
    })).toBe(false);
  });

  it("nudges again once the cooldown has elapsed", () => {
    expect(shouldNudgeStaleApplicants({
      pendingCount: 3,
      oldestPendingMs: NOW - (MIN_AGE_MS + 1),
      lastNudgedMs: NOW - (COOLDOWN_MS + 1),
      nowMs: NOW,
    })).toBe(true);
  });

  it("does not nudge when the oldest-pending timestamp is unknown", () => {
    expect(shouldNudgeStaleApplicants({
      pendingCount: 2, oldestPendingMs: null, lastNudgedMs: null, nowMs: NOW,
    })).toBe(false);
  });
});

// Bell ⇄ text in lockstep (C11, 2026-10-11): the text goes first; the family's
// website bell (Posts page words, typed like the applicant alert so it opens
// the Posts page) is written only when it actually went.
describe("sendStaleApplicantNudges — bell ⇄ text", () => {
  beforeEach(() => {
    store.jobs.clear();
    store.applications.clear();
    store.sessions.clear();
    store.jobUpdates.length = 0;
    bells.length = 0;
    order.length = 0;
    sendSpy.mockReset();
    sendSpy.mockImplementation(async () => { order.push("text"); return true; });
    store.jobs.set("job-1", { status: "open", clientId: "client-1", applicantCount: 2, summary: "Senior care in San Jose" });
    store.applications.set("app-1", { jobId: "job-1", status: "pending", appliedAt: new Date(Date.now() - MIN_AGE_MS - 60_000).toISOString() });
    store.applications.set("app-2", { jobId: "job-1", status: "pending", appliedAt: new Date(Date.now() - MIN_AGE_MS - 30_000).toISOString() });
    store.sessions.set("+15550000001", { userId: "client-1", optedOut: false, onboardingStep: "complete", phone: "+15550000001" });
  });

  it("text dropped → no bell", async () => {
    sendSpy.mockResolvedValueOnce(false);

    await (sendStaleApplicantNudges as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(bells).toHaveLength(0);
    // A dropped text leaves NO cooldown stamp — the next run retries (2026-10-11).
    expect(store.jobUpdates).toHaveLength(0);
  });

  it("text sent → the bell follows it, in the Posts page's words, keyed per job per day", async () => {
    await (sendStaleApplicantNudges as any)();

    expect(order).toEqual(["text", "bell"]);
    expect(bells).toEqual([expect.objectContaining({
      sourcePath: "job_posts/job-1", eventId: expect.stringMatching(/^stale-applicant-nudge-\d{4}-\d{2}-\d{2}$/), recipientId: "client-1",
      transitionType: "stale_applicant_nudge", type: "job_application", title: "Caregivers waiting to hear back",
      body: "2 caregivers are still waiting to hear back on your Senior care in San Jose post. Review them on your Posts page.",
      data: { jobId: "job-1" },
    })]);
  });

  it("a family who texted STOP is skipped entirely — no text, no bell", async () => {
    store.sessions.set("+15550000001", { userId: "client-1", optedOut: true, onboardingStep: "complete", phone: "+15550000001" });

    await (sendStaleApplicantNudges as any)();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(bells).toHaveLength(0);
  });
});
