import { describe, it, expect, beforeEach, vi } from "vitest";

// bookingResolution.ts was extracted 2026-09-13 from mcp/server.ts's
// request_booking case (~450 lines of inline resolution logic) so it has
// exactly one home instead of being duplicated between the MCP tool and the
// new scripted bookingFlow.ts. These tests pin the extracted behavior.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
  });
  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`);
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
  return { __esModule: true, default: { firestore: firestoreFn }, firestore: firestoreFn };
});

const multiRecipientScopingEnabled = vi.fn(() => true);
vi.mock("../../config/featureFlags", () => ({
  multiRecipientScopingEnabled: () => multiRecipientScopingEnabled(),
}));

import {
  resolveBookingRate, resolveCareLocation, formatCareLocationOptions, resolveInterviewLinkage,
  resolveRecipientAttribution, resolveEmergencyContact, NO_RATE_MESSAGE, bookingTimeToMinutes,
  parseBookingDateRange,
} from "../bookingResolution";

beforeEach(() => {
  hoisted.reset();
  multiRecipientScopingEnabled.mockReturnValue(true);
});

describe("resolveBookingRate", () => {
  it("prefers an explicit agreedRate over the job post's rate", () => {
    expect(resolveBookingRate(30, 20)).toEqual({ ok: true, hourlyRate: 30 });
  });
  it("falls back to the job post's rate when no agreedRate is given", () => {
    expect(resolveBookingRate(undefined, 22)).toEqual({ ok: true, hourlyRate: 22 });
  });
  it("refuses rather than guessing when neither is set", () => {
    const res = resolveBookingRate(undefined, undefined);
    expect(res.ok).toBe(false);
    expect((res as any).reason).toBe(NO_RATE_MESSAGE);
  });
});

describe("resolveCareLocation", () => {
  it("uses the explicit careLocation when given, without a lookup", async () => {
    const res = await resolveCareLocation("client1", "123 Main St, Springfield, CA 90000");
    expect(res).toEqual({ ok: true, location: "123 Main St, Springfield, CA 90000" });
  });

  it("auto-uses a single saved address", async () => {
    hoisted.docState.set("carePlans/client1", {
      locationPool: [{ street: "1 Elm St", city: "Springfield", state: "CA", zipCode: "90000" }],
    });
    const res = await resolveCareLocation("client1", undefined);
    expect(res).toEqual({ ok: true, location: "1 Elm St, Springfield, CA, 90000" });
  });

  it("returns ambiguous options when 2+ addresses are on file", async () => {
    hoisted.docState.set("carePlans/client1", {
      locationPool: [
        { street: "1 Elm St", city: "Springfield", state: "CA", zipCode: "90000" },
        { street: "2 Oak Ave", city: "Springfield", state: "CA", zipCode: "90000", smokingHousehold: true },
      ],
    });
    const res = await resolveCareLocation("client1", undefined);
    expect(res.ok).toBe(false);
    expect((res as any).ambiguous).toBe(true);
    expect((res as any).options).toHaveLength(2);
    expect(formatCareLocationOptions((res as any).options)).toContain("smoking household");
  });

  it("falls back to the client's on-file address when the pool is empty", async () => {
    hoisted.docState.set("carePlans/client1", { locationPool: [] });
    hoisted.docState.set("users/client1", { street: "9 Pine Rd", city: "Springfield", state: "CA", zipCode: "90000" });
    const res = await resolveCareLocation("client1", undefined);
    expect(res).toEqual({ ok: true, location: "9 Pine Rd, Springfield, CA, 90000" });
  });

  it("refuses when nothing is on file at all", async () => {
    const res = await resolveCareLocation("client1", undefined);
    expect(res.ok).toBe(false);
    expect((res as any).ambiguous).toBe(false);
    expect((res as any).reason).toContain("No care location is on file");
  });
});

describe("resolveInterviewLinkage", () => {
  it("returns nothing when no interviewId is given", async () => {
    expect(await resolveInterviewLinkage("client1", "cg1", undefined)).toEqual({});
  });

  it("returns nothing when the interview doesn't match the client/caregiver", async () => {
    hoisted.docState.set("video_interviews/iv1", { clientId: "other", caregiverId: "cg1" });
    expect(await resolveInterviewLinkage("client1", "cg1", "iv1")).toEqual({});
  });

  it("resolves jobId/jobTitle/jobPostRate/jobPostSchedule from the linked job post", async () => {
    hoisted.docState.set("video_interviews/iv1", { clientId: "client1", caregiverId: "cg1", applicationId: "app1" });
    hoisted.docState.set("job_applications/app1", { jobId: "job1" });
    hoisted.docState.set("job_posts/job1", {
      title: "Senior care in Springfield", daysOfWeek: ["Monday", "Wednesday"], startDate: "2026-09-15", rate: "25",
    });
    const res = await resolveInterviewLinkage("client1", "cg1", "iv1");
    expect(res).toEqual({
      applicationId: "app1", jobId: "job1", jobTitle: "Senior care in Springfield",
      jobPostSchedule: { daysOfWeek: ["Monday", "Wednesday"], startDate: "2026-09-15" },
      jobPostRate: 25,
    });
  });

  it("an interview requested against a job post (jobId on the interview, no application) links the job — the Interviews card keys bookings by it", async () => {
    hoisted.docState.set("video_interviews/iv2", { clientId: "client1", caregiverId: "cg1", jobId: "job2", jobTitle: "Senior care in San Jose" });
    hoisted.docState.set("job_posts/job2", { title: "Senior care in San Jose", rate: 26 });
    expect(await resolveInterviewLinkage("client1", "cg1", "iv2")).toEqual({ jobId: "job2", jobTitle: "Senior care in San Jose", jobPostRate: 26 });
  });

  it("falls back to the interview's own title when the job post is gone", async () => {
    hoisted.docState.set("video_interviews/iv3", { clientId: "client1", caregiverId: "cg1", jobId: "job-gone", jobTitle: "Weekend help" });
    expect(await resolveInterviewLinkage("client1", "cg1", "iv3")).toEqual({ jobId: "job-gone", jobTitle: "Weekend help" });
  });
});

describe("resolveRecipientAttribution", () => {
  it("does nothing when multi-recipient scoping is disabled", async () => {
    multiRecipientScopingEnabled.mockReturnValue(false);
    hoisted.docState.set("carePlans/client1", { recipientPlans: { a_b: {}, c_d: {} } });
    expect(await resolveRecipientAttribution("client1", undefined, undefined)).toEqual({});
  });

  it("populates careRecipients (not just recipientName/Key) for a single-recipient household", async () => {
    hoisted.docState.set("carePlans/client1", {
      recipientPlans: { samira_m: { name: "Samira M", careNeeds: ["Meal Preparation"], lifestyle: { prefersQuiet: true } } },
    });
    const res = await resolveRecipientAttribution("client1", undefined, undefined);
    expect(res.recipientKey).toBe("samira_m");
    expect(res.recipientName).toBe("Samira M");
    expect(res.careRecipients).toEqual([
      expect.objectContaining({ name: "Samira M", careNeeds: ["Meal Preparation"], lifestyle: { prefersQuiet: true } }),
    ]);
  });

  it("defaults to EVERY recipient (matching the site's pre-selected-all default) when the household has 2+ and none is named", async () => {
    hoisted.docState.set("carePlans/client1", {
      recipientPlans: {
        samira_m: { name: "Samira M", careNeeds: ["Meal Preparation"] },
        imran_mohammed: { name: "Imran Mohammed", careNeeds: ["Bathing"] },
      },
    });
    const res = await resolveRecipientAttribution("client1", undefined, undefined);
    expect(res.recipientResolved).toBe("defaulted_all");
    expect(res.recipientName).toBeUndefined();
    expect(res.careRecipients?.map((r) => r.name)).toEqual(["Samira M", "Imran Mohammed"]);
  });

  it("still populates careRecipients when exactly one recipient is explicitly named among several", async () => {
    hoisted.docState.set("carePlans/client1", {
      recipientPlans: {
        samira_m: { name: "Samira M", careNeeds: ["Meal Preparation"] },
        imran_mohammed: { name: "Imran Mohammed", careNeeds: ["Bathing"] },
      },
    });
    const res = await resolveRecipientAttribution("client1", "Samira", undefined);
    expect(res.recipientResolved).toBe("named");
    expect(res.recipientKey).toBe("samira_m");
    expect(res.careRecipients?.map((r) => r.name)).toEqual(["Samira M"]);
  });

  it("resolves multiple named recipients for one booking", async () => {
    hoisted.docState.set("carePlans/client1", {
      recipientPlans: {
        samira_m: { name: "Samira M", careNeeds: ["Meal Preparation"] },
        imran_mohammed: { name: "Imran Mohammed", careNeeds: ["Bathing"] },
      },
    });
    const res = await resolveRecipientAttribution("client1", undefined, ["Samira", "Imran"]);
    expect(res.recipientResolved).toBe("named");
    expect(res.careRecipients?.map((r) => r.name)).toEqual(["Samira M", "Imran Mohammed"]);
  });

  // 2026-09-13 (live-caught): carePlans.recipientPlans is additive-only — the
  // website's own "delete recipient" action (CarePlan.tsx deleteRecipient)
  // only removes someone from job_postings/{uid}'s roster, never from
  // carePlans, so a deleted household member's plan entry sits there orphaned
  // forever. A booking defaulted a caregiver interview to a recipient deleted
  // three days earlier because this function iterated recipientPlans keys
  // with no cross-check against the roster at all.
  it("excludes a recipientPlans entry no longer on the job_postings roster (deleted household member)", async () => {
    hoisted.docState.set("carePlans/client1", {
      recipientPlans: {
        samira_m: { name: "Samira M", careNeeds: ["Meal Preparation"] },
        imran_mohammed: { name: "Imran Mohammed", careNeeds: ["Bathing"] },
        hamse_noname: { name: "Hamse", careNeeds: ["Companionship"] },
      },
    });
    hoisted.docState.set("job_postings/client1", {
      careRecipientFirstName: "Samira",
      careRecipientLastName: "M",
      additionalRecipients: [{ firstName: "Imran", lastName: "Mohammed" }],
      // "Hamse" was removed here; carePlans never got the memo.
      deletedRecipients: [{ firstName: "Hamse", lastName: "", relationship: "myself" }],
    });
    const res = await resolveRecipientAttribution("client1", undefined, undefined);
    expect(res.recipientResolved).toBe("defaulted_all");
    expect(res.careRecipients?.map((r) => r.name)).toEqual(["Samira M", "Imran Mohammed"]);
  });

  it("does not filter at all when there's no roster doc to check against (fail-soft)", async () => {
    hoisted.docState.set("carePlans/client1", {
      recipientPlans: {
        samira_m: { name: "Samira M", careNeeds: ["Meal Preparation"] },
        imran_mohammed: { name: "Imran Mohammed", careNeeds: ["Bathing"] },
      },
    });
    const res = await resolveRecipientAttribution("client1", undefined, undefined);
    expect(res.careRecipients?.map((r) => r.name)).toEqual(["Samira M", "Imran Mohammed"]);
  });
});

describe("resolveEmergencyContact", () => {
  it("prefers the primary contact", async () => {
    hoisted.docState.set("carePlans/client1", {
      emergencyContacts: [
        { name: "Alex", phone: "111", isPrimary: false },
        { name: "Bo", phone: "222", isPrimary: true, relationship: "Daughter" },
      ],
    });
    expect(await resolveEmergencyContact("client1")).toEqual({ name: "Bo", phone: "222", relationship: "Daughter" });
  });

  it("returns undefined when none is on file", async () => {
    expect(await resolveEmergencyContact("client1")).toBeUndefined();
  });
});

describe("bookingTimeToMinutes / parseBookingDateRange (moved verbatim from mcp/server.ts)", () => {
  it("parses HH:MM into minutes since midnight", () => {
    expect(bookingTimeToMinutes("09:30")).toBe(570);
    expect(bookingTimeToMinutes("not-a-time")).toBeNull();
  });

  it("requires dates/startTime/endTime and end after start", () => {
    expect(parseBookingDateRange({ dates: ["2026-09-15"], startTime: "09:00", endTime: "12:00" }))
      .toEqual({ ok: true, dateList: ["2026-09-15"], durationHours: 3 });
    expect(parseBookingDateRange({ dates: ["2026-09-15"], startTime: "12:00", endTime: "09:00" }).ok).toBe(false);
    expect(parseBookingDateRange({}).ok).toBe(false);
  });
});
