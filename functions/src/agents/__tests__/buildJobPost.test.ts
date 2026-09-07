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
