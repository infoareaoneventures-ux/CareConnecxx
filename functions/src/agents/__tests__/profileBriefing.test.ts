// Shared recall-grounding briefing (Hamse bug, 2026-07-17): every LLM reply
// path that answers free-form questions must be able to answer "what zip/city/
// rate did I share?" from the session instead of denying knowledge.
import { describe, it, expect } from "vitest";
import { describeSharedProfile, describeLocation } from "../profileBriefing";

const HAMSE = {
  userType: "caregiver",
  onboardingData: {
    name: "Hamse mahad",
    city: "95130",            // live data quirk: city holds a bare ZIP
    zipCode: "95130",
    yearsExperience: 4,
    specialties: ["Companionship", "dementia", "medication reminders", "transportation"],
    availability: { days: ["Monday", "Tuesday"], hours: "morning and afternoon" },
    jobType: "part_time",
    hourlyRate: 27,
    email: "Hamse@angelicare.com",
    languages: "English",
    gender: "prefer_not_to_answer",
    canDrive: "prefer_not_to_answer",
    bio: "",
    bioSkipped: true,
  },
};

describe("describeLocation", () => {
  it("presents a numeric city as a ZIP, once — never 'city 95130'", () => {
    expect(describeLocation({ city: "95130", zipCode: "95130" })).toBe("ZIP 95130");
    expect(describeLocation({ city: "95130" })).toBe("ZIP 95130");
  });
  it("combines a real city with its zip", () => {
    expect(describeLocation({ city: "San Jose", zipCode: "95110" })).toBe("San Jose (ZIP 95110)");
  });
  it("handles city-only, zip-only, and neither", () => {
    expect(describeLocation({ city: "San Jose" })).toBe("San Jose");
    expect(describeLocation({ zipCode: "95110" })).toBe("ZIP 95110");
    expect(describeLocation({})).toBe("");
  });
});

describe("describeSharedProfile — caregiver", () => {
  it("carries every recall-worthy fact Hamse actually shared", () => {
    const brief = describeSharedProfile(HAMSE);
    expect(brief).toContain("THEY'VE ALREADY SHARED");
    expect(brief).toContain("name: Hamse mahad");
    expect(brief).toContain("ZIP 95130");
    expect(brief).toContain("experience: 4 years");
    expect(brief).toContain("Companionship");
    expect(brief).toContain("Monday, Tuesday (morning and afternoon)");
    expect(brief).toContain("work type: part-time");
    expect(brief).toContain("rate: $27/hr");
    expect(brief).toContain("email: Hamse@angelicare.com");
    expect(brief).toContain("languages: English");
    expect(brief).not.toContain("undefined");
  });

  it("omits declined answers (prefer_not_to_answer) and empty fields", () => {
    const brief = describeSharedProfile(HAMSE);
    expect(brief).not.toContain("prefer_not_to_answer");
    expect(brief).not.toContain("can drive");
    expect(brief).not.toContain("gender");
  });

  it("returns empty string when nothing has been shared yet", () => {
    expect(describeSharedProfile({ userType: "caregiver", onboardingData: {} })).toBe("");
    expect(describeSharedProfile({ userType: "caregiver" })).toBe("");
    expect(describeSharedProfile(undefined)).toBe("");
  });
});

describe("describeSharedProfile — client", () => {
  it("includes WHO'S WHO plus the shared intake facts", () => {
    const brief = describeSharedProfile({
      userType: "client",
      onboardingData: {
        firstName: "Anahi",
        seniorName: "Rosie",
        relationship: "mother",
        city: "San Jose",
        zipCode: "95112",
        careNeeds: ["companionship", "meal prep"],
        daysPerWeek: ["Monday", "Wednesday"],
        timeOfDay: "mornings",
      },
    });
    expect(brief).toContain("WHO'S WHO");
    expect(brief).toContain("Rosie");
    expect(brief).toContain("San Jose (ZIP 95112)");
    expect(brief).toContain("care needs: companionship, meal prep");
    expect(brief).toContain("days per week: Monday, Wednesday");
    expect(brief).toContain("time of day: mornings");
    expect(brief).toContain("THEY'VE ALREADY SHARED");
  });

  it("self-signup keeps the self WHO'S WHO framing", () => {
    const brief = describeSharedProfile({
      userType: "client",
      onboardingData: { firstName: "Anahi", relationship: "self", city: "San Jose" },
    });
    expect(brief).toContain("arranging care for THEMSELVES");
    expect(brief).toContain("San Jose");
  });

  it("returns empty for a blank client session", () => {
    expect(describeSharedProfile({ userType: "client", onboardingData: {} })).toBe("");
  });
});
