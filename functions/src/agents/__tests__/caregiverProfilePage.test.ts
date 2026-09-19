// The caregiver profile page as data — same merge, same fallbacks, same
// sections, same billed rates, same buttons as components/ClientCaregiverProfile.tsx.
import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => ({ firestore: () => ({ collection: () => ({ doc: () => ({ collection: () => ({}) }) }) }) }));
vi.mock("../../config/appUrl", () => ({ getAppUrl: () => "https://eviacares.com" }));

import {
  weeklySlotsToBlocks, mapRawToProfileRecord, shapeCaregiverProfilePage, deriveProfileActions, billedHourly, formatExperience, NO_RELATIONSHIP,
} from "../caregiverProfilePage";

describe("weeklySlotsToBlocks (ported from services/availabilityService.ts)", () => {
  it("keeps block ids, maps time slots onto blocks, and handles a cross-midnight slot", () => {
    expect(weeklySlotsToBlocks({ monday: ["morning", "bogus", "afternoon"] })).toEqual({ monday: ["morning", "afternoon"] });
    expect(weeklySlotsToBlocks({ tuesday: [{ start: "06:00", end: "18:00" }] })).toEqual({ tuesday: ["morning", "afternoon"] });
    expect(weeklySlotsToBlocks({ friday: [{ start: "23:00", end: "06:00" }] })).toEqual({ friday: ["overnight"] });
    expect(weeklySlotsToBlocks(null)).toEqual({});
  });
});

describe("mapRawToProfileRecord (the page's mapRawToProfile)", () => {
  it("applies the page's fallback chains", () => {
    const rec = mapRawToProfileRecord("cg1", {
      name: "Alice Ng", rating: 4.7, totalReviews: 12, hourlyRate: 30, rateForTwo: 40, rateForThree: 50,
      location: "Seattle", experience: 6, about: "Kind and patient", services: ["Companionship", "Transportation"],
      weeklyAvailability: { monday: ["morning"] },
    });
    expect(rec).toMatchObject({
      firstName: "Alice", lastName: "Ng", rating: 4.7, reviewCount: 12, hourlyRate: 30, rateFor2Seniors: 40, rateFor3Seniors: 50,
      city: "Seattle", experience: "6", bio: "Kind and patient", languages: ["English"], skills: ["Companionship", "Transportation"],
      hasTransportation: false, serviceRadius: 25, weeklyAvailability: { monday: ["morning"] },
    });
  });
  it("defaults like the page when the record is thin", () => {
    const rec = mapRawToProfileRecord("cg2", {});
    expect(rec).toMatchObject({ firstName: "Caregiver", lastName: "", rating: 5, reviewCount: 0, hourlyRate: 25, city: "Nearby", bio: "", skills: [] });
  });
});

describe("shapeCaregiverProfilePage", () => {
  const rec = mapRawToProfileRecord("cg1", {
    firstName: "Alice", lastName: "Ng", rating: 4.7, reviewCount: 12, hourlyRate: 25, rateFor2Seniors: 35, city: "Seattle",
    bio: "Kind and patient", languages: ["English", "Somali"], skills: ["Companionship", "Transportation"], hasValidTransportDocs: true,
    yearsExperience: "5+ years", education: "CNA", serviceRadius: 15, weeklyAvailability: { monday: ["morning", "afternoon"], sunday: [] },
  });

  it("header, rates (billed = rate + 9%, no per-hour minimum), sections in the page's order, default buttons", () => {
    const page = shapeCaregiverProfilePage(rec, [], NO_RELATIONSHIP);
    expect(page.name).toBe("Alice Ng");
    expect(page.ratingLabel).toBe("4.7 (12 reviews)");
    expect(page.profileUrl).toBe("https://eviacares.com/p/cg1");
    expect(page.billedHourlyRate).toBe(27.25);
    expect(page.rateLine).toBe("$25/hr · $27.25/hr billed");
    expect(page.published).toBe(true);
    expect(page.rates).toEqual([
      { label: "1 Person", rate: 25, billed: 27.25 },
      { label: "2 People", rate: 35, billed: 38.15 },
    ]);
    expect(page.ratesNote).toBe("Billed includes Evia's 9% service fee. The caregiver keeps 100% of their rate.");
    expect(page.careServices).toEqual(["Companionship", "Transportation"]); // badge earned → Transportation shown
    expect(page.badges.transportation).toBe(true);
    expect(page.weeklyAvailability).toEqual([{ day: "monday", blocks: ["morning", "afternoon"] }]);
    expect(page.background).toBe("CNA");
    expect(page.experience).toBe("5+ years experience");
    expect(page.summary).toContain("5+ years experience.");
    expect(page.location).toEqual({ city: "Seattle", serviceRadiusMiles: 15 });
    expect(page.actions).toEqual({ primary: "request_interview", message: true, review: null });
    expect(page.summary).toContain("$25/hr ($27.25/hr billed)");
    expect(page.summary).toContain("Request Interview; Message.");
  });

  it("hides Transportation from Care Services until the badge is earned, and says No reviews yet with zero reviews", () => {
    const thin = mapRawToProfileRecord("cg3", { firstName: "Bo", skills: ["Transportation", "Meal prep"], hasValidTransportDocs: false, reviewCount: 0, rating: 4.9 });
    const page = shapeCaregiverProfilePage(thin, [], NO_RELATIONSHIP);
    expect(page.careServices).toEqual(["Meal prep"]);
    expect(page.rating).toBeNull();
    expect(page.ratingLabel).toBe("No reviews yet");
  });

  it("reviews are quoted with the reviewer's name, like the page's cards", () => {
    const page = shapeCaregiverProfilePage(rec, [{ reviewerName: "Hamse M", rating: 5, comment: "Great with my dad", dateIso: "2026-05-01", wouldRecommend: true }], NO_RELATIONSHIP, { hasMoreReviews: true });
    expect(page.reviews).toHaveLength(1);
    expect(page.hasMoreReviews).toBe(true);
    expect(page.summary).toContain('Hamse M 5★ "Great with my dad"');
  });
});

describe("deriveProfileActions — the page's button ladder", () => {
  const base = { ...NO_RELATIONSHIP };
  it("live shift → Active Booking; past booking + completed interview → Re-book; active interview → Interview Requested; else Request Interview", () => {
    expect(deriveProfileActions({ ...base, isBooked: true, hasPastBooking: true }).primary).toBe("active_booking");
    expect(deriveProfileActions({ ...base, hasPastBooking: true, hasCompletedInterview: true }).primary).toBe("rebook");
    expect(deriveProfileActions({ ...base, hasPastBooking: true, isRequested: true }).primary).toBe("interview_requested"); // no completed interview → not Re-book
    expect(deriveProfileActions({ ...base, isRequested: true }).primary).toBe("interview_requested");
    expect(deriveProfileActions(base).primary).toBe("request_interview");
  });
  it("Leave a Review only after a completed shift and before their own review exists", () => {
    expect(deriveProfileActions({ ...base, hasCompletedShift: true }).review).toBe("leave_review");
    expect(deriveProfileActions({ ...base, hasCompletedShift: true, hasReviewed: true }).review).toBe("reviewed");
    expect(deriveProfileActions(base).review).toBeNull();
  });
});

describe("formatExperience (mirror of utils/experience.ts)", () => {
  it("words a bare number, passes a phrase through, hides nothing/zero", () => {
    expect(formatExperience("8")).toBe("8 years experience");
    expect(formatExperience(1)).toBe("1 year experience");
    expect(formatExperience("5+ years")).toBe("5+ years experience");
    expect(formatExperience("10 years experience")).toBe("10 years experience");
    expect(formatExperience("")).toBe("");
    expect(formatExperience(0)).toBe("");
  });
});

describe("billedHourly matches the site's billedHourlyRate", () => {
  it("rounds to cents, no minimum", () => {
    expect(billedHourly(25)).toBe(27.25);
    expect(billedHourly(22.5)).toBe(24.53);
    expect(billedHourly(0)).toBe(0);
  });
});
