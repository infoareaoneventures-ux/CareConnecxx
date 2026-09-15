import { describe, it, expect, beforeEach, vi } from "vitest";

// 2026-09-07: buildAndSaveJobPost (Evia's job-posting finalizer) never wrote
// a recipient's `notes` field into carePlans — the website's own
// PostJobFlow.tsx / mirrorJobPostRecipientsToWeb writes it directly on every
// post, but Evia's path relied entirely on the Care Plan page's frontend
// fallback to job_postings.jobDescription instead of a first-class write.
// A live test found a family's typed "describe a typical day" answer never
// showed up under Care Plan > Notes. These tests lock in the direct write.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeDocRef = (path: string): any => {
    const ref: any = {
      id: path.split("/").pop(),
      path,
      set: async (data: Record<string, any>, opts?: { merge?: boolean }) => {
        const existing = docState.get(path) ?? {};
        docState.set(path, opts?.merge ? { ...existing, ...data } : data);
      },
      update: async (data: Record<string, any>) => {
        docState.set(path, { ...(docState.get(path) ?? {}), ...data });
      },
    };
    ref.get = async () => ({ exists: docState.has(path), data: () => docState.get(path), ref });
    return ref;
  };
  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? `auto_${Math.random().toString(36).slice(2)}`}`);
    ref.where = () => ref;
    ref.limit = () => ref;
    ref.get = async () => ({ docs: [] });
    return ref;
  };
  return {
    docState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => docState.clear(),
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn: any = () => ({ collection: hoisted.collectionMock });
  firestoreFn.FieldValue = { serverTimestamp: () => ({ __serverTimestamp: true }) };
  firestoreFn.Timestamp = { now: () => ({ toDate: () => new Date() }) };
  return { __esModule: true, default: { firestore: firestoreFn }, firestore: firestoreFn };
});

vi.mock("../../triggers/jobNotifications", () => ({
  notifyAreaCaregivers: vi.fn().mockResolvedValue(0),
}));

vi.mock("../../utils/geocode", () => ({
  geocodeZip: vi.fn().mockResolvedValue(null),
  geocodeCity: vi.fn().mockResolvedValue(null),
}));

import { buildAndSaveJobPost } from "../buildJobPost";

beforeEach(() => {
  hoisted.reset();
});

const BASE_ONBOARDING = {
  seniorName: "Samira M",
  relationship: "Parent",
  city: "San Jose",
  zipCode: "95130",
  age: 82,
};

const BASE_JOB_DATA = {
  jobCareNeeds: ["bathing", "medication reminders"],
  jobCareLevel: "moderate",
  jobStartDate: "ASAP",
  jobFrequency: "occasional",
  jobDays: ["Thu", "Fri"],
  jobTimeOfDay: ["afternoon"],
  jobHourlyRate: 22,
  jobDescription: "Mom loves gardening and needs reminders to take her afternoon medication.",
};

describe("buildAndSaveJobPost — carePlans notes parity with the website wizard", () => {
  it("writes the collected jobDescription directly into recipientPlans.{key}.notes", async () => {
    await buildAndSaveJobPost({
      uid: "client1",
      phone: "+15550001111",
      onboardingData: BASE_ONBOARDING,
      jobData: BASE_JOB_DATA,
    });

    const plan = hoisted.docState.get("carePlans/client1");
    const key = Object.keys(plan.recipientPlans)[0];
    expect(plan.recipientPlans[key].notes).toBe(BASE_JOB_DATA.jobDescription);
  });

  // 2026-09-14 (live-caught): recipientPlans only ever carried the parent
  // category (careNeeds) — the website's own two-level model (CarePlan.tsx's
  // careNeeds + careNeedDetails) also tracks which specific sub-task chip
  // within that category was named, and this was never being written at all.
  it("writes jobCareNeedDetails through into recipientPlans.{key}.careNeedDetails", async () => {
    await buildAndSaveJobPost({
      uid: "client1b",
      phone: "+15550001112",
      onboardingData: BASE_ONBOARDING,
      jobData: { ...BASE_JOB_DATA, jobCareNeedDetails: { "Personal Care": ["Bathing"] } },
    });

    const plan = hoisted.docState.get("carePlans/client1b");
    const key = Object.keys(plan.recipientPlans)[0];
    expect(plan.recipientPlans[key].careNeedDetails).toEqual({ "Personal Care": ["Bathing"] });
  });

  it("writes an empty string (not undefined) when no description was collected, matching the website's own unconditional write", async () => {
    await buildAndSaveJobPost({
      uid: "client2",
      phone: "+15550002222",
      onboardingData: BASE_ONBOARDING,
      jobData: { ...BASE_JOB_DATA, jobDescription: undefined },
    });

    const plan = hoisted.docState.get("carePlans/client2");
    const key = Object.keys(plan.recipientPlans)[0];
    expect(plan.recipientPlans[key].notes).toBe("");
  });

  it("shares the same notes across every recipient in a multi-recipient household", async () => {
    await buildAndSaveJobPost({
      uid: "client3",
      phone: "+15550003333",
      onboardingData: {
        ...BASE_ONBOARDING,
        additionalRecipients: [{ name: "Frank M", relationship: "Parent", age: 80 }],
      },
      jobData: BASE_JOB_DATA,
    });

    const plan = hoisted.docState.get("carePlans/client3");
    const notesValues = Object.values(plan.recipientPlans).map((r: any) => r.notes);
    expect(notesValues).toHaveLength(2);
    expect(notesValues.every((n) => n === BASE_JOB_DATA.jobDescription)).toBe(true);
  });
});

// 2026-09-09 live incident: this function is called for BOTH the client's
// first-ever job post (onboarding) and every later "post another job"
// request — but job_posts/{uid} keying is only safe for the first, to
// converge with the clientIntakes onCreate trigger. A family's second job
// posted over SMS silently overwrote their first post's Firestore document
// (applicants and all) instead of creating a new one.
describe("buildAndSaveJobPost — job_posts keying (2026-09-09 overwrite fix)", () => {
  it("keys the first-ever job post by uid (converges with the intake trigger)", async () => {
    const { jobId } = await buildAndSaveJobPost({
      uid: "client4",
      phone: "+15550004444",
      onboardingData: BASE_ONBOARDING,
      jobData: BASE_JOB_DATA,
    });

    expect(jobId).toBe("client4");
    expect(hoisted.docState.get("job_posts/client4")).toBeTruthy();
  });

  it("gives a SECOND job post a fresh id instead of overwriting the first", async () => {
    await buildAndSaveJobPost({
      uid: "client5",
      phone: "+15550005555",
      onboardingData: BASE_ONBOARDING,
      jobData: { ...BASE_JOB_DATA, jobTitle: "First job" },
    });
    const firstPost = hoisted.docState.get("job_posts/client5");
    expect(firstPost).toBeTruthy();

    const { jobId: secondJobId } = await buildAndSaveJobPost({
      uid: "client5",
      phone: "+15550005555",
      onboardingData: BASE_ONBOARDING,
      jobData: { ...BASE_JOB_DATA, jobTitle: "Second job" },
    });

    expect(secondJobId).not.toBe("client5");
    // The first post is still exactly as it was — never touched.
    expect(hoisted.docState.get("job_posts/client5")).toEqual(firstPost);
    // The second post lives at its own new id.
    const secondPost = hoisted.docState.get(`job_posts/${secondJobId}`);
    expect(secondPost).toBeTruthy();
    expect(secondPost.title).toBe("Second job");
  });

  it("a THIRD job post also gets its own fresh id, distinct from the second", async () => {
    await buildAndSaveJobPost({
      uid: "client6", phone: "+15550006666",
      onboardingData: BASE_ONBOARDING, jobData: { ...BASE_JOB_DATA, jobTitle: "First" },
    });
    const { jobId: second } = await buildAndSaveJobPost({
      uid: "client6", phone: "+15550006666",
      onboardingData: BASE_ONBOARDING, jobData: { ...BASE_JOB_DATA, jobTitle: "Second" },
    });
    const { jobId: third } = await buildAndSaveJobPost({
      uid: "client6", phone: "+15550006666",
      onboardingData: BASE_ONBOARDING, jobData: { ...BASE_JOB_DATA, jobTitle: "Third" },
    });

    expect(new Set(["client6", second, third]).size).toBe(3);
    expect(hoisted.docState.get(`job_posts/${second}`).title).toBe("Second");
    expect(hoisted.docState.get(`job_posts/${third}`).title).toBe("Third");
  });
});
