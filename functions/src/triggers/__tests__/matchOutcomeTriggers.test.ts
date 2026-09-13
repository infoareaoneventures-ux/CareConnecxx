import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal in-memory Firestore fake: records set() calls by doc path,
// supports nested subcollections (users/{id}/match_history/{cgId}).
const hoisted = vi.hoisted(() => {
  const sets = new Map<string, any>();
  const makeDocRef = (path: string): any => ({
    path,
    set: async (data: any, _opts?: any) => {
      sets.set(path, { ...(sets.get(path) ?? {}), ...data });
    },
    collection: (name: string) => makeCollRef(`${path}/${name}`),
  });
  const makeCollRef = (path: string): any => ({
    doc: (id: string) => makeDocRef(`${path}/${id}`),
  });
  const dbMock = { collection: (p: string) => makeCollRef(p) };
  return { sets, dbMock, reset: () => sets.clear() };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => hoisted.dbMock },
  firestore: () => hoisted.dbMock,
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    serverTimestamp: () => "__server_ts__",
    increment: (n: number) => ({ __inc: n }),
  },
}));
// Builder mock: firestore.document().onUpdate/onWrite/onCreate(handler) → handler
vi.mock("firebase-functions/v1", () => {
  const builder: any = {
    runWith: () => builder,
    firestore: {
      document: () => ({
        onWrite: (h: any) => h,
        onUpdate: (h: any) => h,
        onCreate: (h: any) => h,
      }),
    },
    pubsub: { schedule: () => ({ timeZone: () => ({ onRun: (h: any) => h }) }) },
  };
  return { __esModule: true, ...builder, default: builder };
});
// aiMatchTriggers side imports not under test
vi.mock("../../ai/matchJob", () => ({
  ensureCaregiverEmbedding: vi.fn(),
  runMatchingForIntake: vi.fn(),
}));
vi.mock("../../ai/embeddings", () => ({
  composeCaregiverText: vi.fn(() => ""),
  hashText: vi.fn(() => "h"),
}));
vi.mock("../jobNotifications", () => ({
  createJobPost: vi.fn(),
  notifyAreaCaregivers: vi.fn(),
}));

import { writeMatchOutcome } from "../../ai/matchOutcomes";
import {
  onJobApplicationOutcome,
  onVideoInterviewClientDecline,
} from "../aiMatchTriggers";

type Handler = (change: any, context: any) => Promise<any>;
const jobAppHandler = onJobApplicationOutcome as unknown as Handler;
const ivDeclineHandler = onVideoInterviewClientDecline as unknown as Handler;

function change(before: any | null, after: any | null) {
  return {
    before: { exists: before !== null, data: () => before },
    after: { exists: after !== null, data: () => after },
  };
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
});

describe("writeMatchOutcome", () => {
  it("upserts a deterministic doc with the reader-facing shape", async () => {
    await writeMatchOutcome({
      clientId: "cl1", caregiverId: "cg1", outcome: "hired",
      source: "job_application", refId: "app1",
    });
    const doc = hoisted.sets.get("match_outcomes/job_application_app1");
    expect(doc).toMatchObject({
      clientId: "cl1", caregiverId: "cg1", outcome: "hired",
      source: "job_application", refId: "app1",
    });
    expect(typeof doc.timestamp).toBe("string"); // ISO string — readers orderBy("timestamp")
  });

  it("skips silently when clientId or caregiverId is missing", async () => {
    await writeMatchOutcome({
      clientId: undefined, caregiverId: "cg1", outcome: "rejected",
      source: "job_application", refId: "r1",
    });
    expect(hoisted.sets.size).toBe(0);
  });
});

describe("onJobApplicationOutcome", () => {
  const base = { clientId: "cl1", caregiverId: "cg1", jobId: "j1" };

  it("records hired on pending → accepted", async () => {
    await jobAppHandler(
      change({ ...base, status: "pending" }, { ...base, status: "accepted" }),
      { params: { applicationId: "app1" } }
    );
    expect(hoisted.sets.get("match_outcomes/job_application_app1")).toMatchObject({
      outcome: "hired", clientId: "cl1", caregiverId: "cg1",
    });
  });

  it("records rejected on pending → rejected", async () => {
    await jobAppHandler(
      change({ ...base, status: "pending" }, { ...base, status: "rejected" }),
      { params: { applicationId: "app2" } }
    );
    expect(hoisted.sets.get("match_outcomes/job_application_app2")).toMatchObject({
      outcome: "rejected",
    });
  });

  it("ignores non-decision statuses and no-op status writes", async () => {
    await jobAppHandler(
      change({ ...base, status: "pending" }, { ...base, status: "interview_scheduled" }),
      { params: { applicationId: "app3" } }
    );
    await jobAppHandler(
      change({ ...base, status: "accepted" }, { ...base, status: "accepted" }),
      { params: { applicationId: "app4" } }
    );
    expect(hoisted.sets.size).toBe(0);
  });
});

describe("onVideoInterviewClientDecline", () => {
  const base = { clientId: "cl1", caregiverId: "cg1" };

  it("records rejected only when the CLIENT declines", async () => {
    await ivDeclineHandler(
      change({ ...base, status: "scheduled" }, { ...base, status: "declined", declinedBy: "client" }),
      { params: { interviewId: "iv1" } }
    );
    expect(hoisted.sets.get("match_outcomes/video_interview_iv1")).toMatchObject({
      outcome: "rejected", source: "video_interview",
    });
  });

  it("ignores caregiver-side declines", async () => {
    await ivDeclineHandler(
      change({ ...base, status: "scheduled" }, { ...base, status: "declined", declinedBy: "caregiver" }),
      { params: { interviewId: "iv2" } }
    );
    expect(hoisted.sets.has("match_outcomes/video_interview_iv2")).toBe(false);
  });
});
