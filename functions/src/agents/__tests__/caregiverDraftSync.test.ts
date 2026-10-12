import { describe, it, expect } from "vitest";
import { mapCaregiversDocToOnboardingData } from "../caregiverDraftSync";

// The caregiver-side counterpart to clientJobPostingContract.ts's
// mapJobPostingsDocToOnboardingData — reads caregivers/{uid} (written by both
// the site wizard and Evia's own buildCaregiverProfileMirror) back into Evia's
// onboardingData shape, so the two channels never re-ask each other's answers.

describe("mapCaregiversDocToOnboardingData", () => {
  it("returns nothing for an empty or missing doc", () => {
    expect(mapCaregiversDocToOnboardingData(undefined)).toEqual({});
    expect(mapCaregiversDocToOnboardingData({})).toEqual({});
  });

  it("carries straight-through fields the wizard and Evia already share", () => {
    const out = mapCaregiversDocToOnboardingData({
      name: "Basra Yousuf", city: "San Jose", zipCode: "95134", street: "1 Main St", state: "CA",
      email: "basra@example.com", bio: "I love caring for seniors.", gender: "female",
      hourlyRate: 26, yearsExperience: 6, languages: ["English", "Somali"], canDrive: true,
    });
    // gender / languages / canDrive are not wizard fields → never read back (2026-09-25).
    expect(out).toEqual({
      name: "Basra Yousuf", city: "San Jose", zipCode: "95134", street: "1 Main St", state: "CA",
      email: "basra@example.com", bio: "I love caring for seniors.",
      hourlyRate: 26, yearsExperience: "5-10 years",
    });
  });

  it("buckets experience into the wizard's labels, preferring yearsExperience over the legacy experience field", () => {
    expect(mapCaregiversDocToOnboardingData({ yearsExperience: 6, experience: "12" }).yearsExperience).toBe("5-10 years");
    expect(mapCaregiversDocToOnboardingData({ experience: "6" }).yearsExperience).toBe("5-10 years");
    expect(mapCaregiversDocToOnboardingData({ yearsExperience: "10+ years" }).yearsExperience).toBe("10+ years");
  });

  it("serviceRadius straight through; a legacy documents map is ignored (transport documents retired 2026-10-06)", () => {
    const out = mapCaregiversDocToOnboardingData({
      serviceRadius: 15,
      documents: { driversLicense: { url: "https://x/dl", status: "pending" }, insurance: { url: "https://x/ins" }, profilePhoto: { url: "https://x/p" } },
    });
    expect(out.serviceRadius).toBe(15);
    expect(out.transportDocs).toBeUndefined();
  });

  it("maps the wizard's photo field onto Evia's profilePhoto, preferring an already-Evia-shaped value", () => {
    expect(mapCaregiversDocToOnboardingData({ photo: "https://x/photo.jpg" }).profilePhoto).toBe("https://x/photo.jpg");
    expect(mapCaregiversDocToOnboardingData({ profilePhoto: "https://x/p2.jpg" }).profilePhoto).toBe("https://x/p2.jpg");
  });

  it("maps skills/services (canonical) onto Evia's specialties field", () => {
    expect(mapCaregiversDocToOnboardingData({ skills: ["Personal Care", "Transportation"] }).specialties)
      .toEqual(["Personal Care", "Transportation"]);
    expect(mapCaregiversDocToOnboardingData({ services: ["Companionship"] }).specialties).toEqual(["Companionship"]);
    // Canonical skills win over a stale services array from before canonicalization.
    expect(mapCaregiversDocToOnboardingData({ skills: ["Companionship"], services: ["old raw text"] }).specialties)
      .toEqual(["Companionship"]);
  });

  it("maps jobTypes (the wizard's multi-select, hyphenated) onto jobType (Evia, underscored — one id or the list)", () => {
    expect(mapCaregiversDocToOnboardingData({ jobTypes: ["part-time"] }).jobType).toBe("part_time");
    expect(mapCaregiversDocToOnboardingData({ jobTypes: ["full-time"] }).jobType).toBe("full_time");
    expect(mapCaregiversDocToOnboardingData({ jobTypes: ["occasional"] }).jobType).toBe("occasional");
    expect(mapCaregiversDocToOnboardingData({ jobTypes: ["occasional", "part-time"] }).jobType).toEqual(["occasional", "part_time"]);
    expect(mapCaregiversDocToOnboardingData({ jobTypes: [] }).jobType).toBeUndefined();
    expect(mapCaregiversDocToOnboardingData({ jobTypes: ["not-a-real-id"] }).jobType).toBeUndefined();
  });

  it("reads the rates step's optional inputs back under the profile page's names (2026-10-11)", () => {
    expect(mapCaregiversDocToOnboardingData({ rateFor2Seniors: 30, rateFor3PlusSeniors: 35, maxClients: "3+" }))
      .toMatchObject({ rateFor2Seniors: 30, rateFor3PlusSeniors: 35, maxClients: "3+" });
  });

  it("maps weeklyAvailability (wizard's block grid) onto availability ({days, hours}), best-effort", () => {
    const out = mapCaregiversDocToOnboardingData({
      weeklyAvailability: {
        monday:    [{ start: "06:00", end: "12:00" }],
        wednesday: [{ start: "06:00", end: "12:00" }],
      },
    });
    expect(out.availability).toEqual({ days: ["Monday", "Wednesday"], hours: "Monday, Wednesday mornings" });
  });

  it("skips availability entirely when weeklyAvailability is empty or every day has no slots", () => {
    expect(mapCaregiversDocToOnboardingData({ weeklyAvailability: {} })).not.toHaveProperty("availability");
    expect(mapCaregiversDocToOnboardingData({ weeklyAvailability: { monday: [] } })).not.toHaveProperty("availability");
  });

  it("round-trips back into Evia's own field names cleanly for a realistic wizard-collected doc", () => {
    const out = mapCaregiversDocToOnboardingData({
      name: "Hamse Testing", city: "San Jose", zipCode: "95134",
      photo: "https://x/p.jpg", skills: ["Transportation"], services: ["Transportation"],
      hourlyRate: 26, jobTypes: ["part-time"],
      weeklyAvailability: { tuesday: [{ start: "12:00", end: "18:00" }] },
      bio: "Experienced and caring.",
    });
    expect(out).toMatchObject({
      name: "Hamse Testing", city: "San Jose", zipCode: "95134",
      profilePhoto: "https://x/p.jpg", specialties: ["Transportation"],
      hourlyRate: 26, jobType: "part_time",
      availability: { days: ["Tuesday"], hours: "Tuesday afternoons" },
      bio: "Experienced and caring.",
    });
  });
});
