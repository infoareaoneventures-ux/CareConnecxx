import { describe, it, expect } from "vitest";
import { buildOnboardingDirective } from "../onboardingDirective";

const BANNED = [
  "i'm here to help",
  "how can i help you today",
  "specific questions or concerns",
  "ai assistant",
  "ai care assistant",
];

describe("buildOnboardingDirective", () => {
  it("client mid-collection lists only the unfilled fields and instructs save_onboarding_field", () => {
    const d = buildOnboardingDirective("client", { firstName: "Imran" });
    expect(d).toContain("save_onboarding_field");
    expect(d).toContain("the first and last name of the person who needs care");
    expect(d).toContain("what kind of help is needed day to day");
    expect(d).toContain("which days of the week");
    // firstName is known → shown as known, not as still-needed
    expect(d).toMatch(/already have it[\s\S]*first name|first name[\s\S]*already have it/i);
  });

  it("client with everything collected instructs complete_collection, not more asking", () => {
    const d = buildOnboardingDirective("client", {
      firstName: "Imran", seniorName: "Dorothy", age: 82, careNeeds: ["bathing"],
      homeZipCode: "78701", sameAsHomeAddress: true,
      city: "Austin", zipCode: "78701", daysPerWeek: 5, timeOfDay: "mornings",
      careFrequency: "part_time", startDate: "2026-08-01", selectedDays: ["Mon", "Wed", "Fri"],
      relationship: "daughter", emergencyContactName: "Jane Doe", emergencyContactPhone: "+15551230000",
      rate: 25,
    });
    expect(d).toContain("complete_collection");
    expect(d).toContain("all required fields collected");
  });

  it("caregiver role uses the caregiver checklist, not the client one", () => {
    const d = buildOnboardingDirective("caregiver", { name: "Maria" });
    expect(d).toContain("hourly rate");
    expect(d).toContain("years of caregiving experience");
    expect(d).not.toContain("the senior's age");
  });

  it("never re-greets / never re-introduces (the double-Hi fix)", () => {
    const d = buildOnboardingDirective("client", {}).toLowerCase();
    expect(d).toContain("never greet again");
    expect(d).toContain("never re-introduce");
  });

  it("offers the voice-memo option once, never repeated", () => {
    const d = buildOnboardingDirective("client", {}).toLowerCase();
    expect(d).toContain("voice memo");
    expect(d).toContain("offer once");
    expect(d).toContain("never repeat the offer");
  });

  it("handles self-seekers: senior = sender, direct address, never asks who they're caring for", () => {
    const d = buildOnboardingDirective("client", {}).toLowerCase();
    expect(d).toContain("self-care");
    expect(d).toContain("themselves");
    expect(d).toContain('relationship as "self"');
    expect(d).toContain("never ask who they're caring for");
  });

  it("handles multi-recipient households: first person as senior, everyone else in additionalRecipients", () => {
    const d = buildOnboardingDirective("client", {}).toLowerCase();
    expect(d).toContain("multiple loved ones");
    expect(d).toContain("additionalrecipients");
    expect(d).toContain("everyone else");
  });

  it("contains no chatbot phrasing except inside a 'never say' prohibition", () => {
    const lines = buildOnboardingDirective("client", {}).toLowerCase().split("\n");
    for (const phrase of BANNED) {
      for (const line of lines) {
        // Any line that mentions a banned phrase must be a prohibition line.
        if (line.includes(phrase)) expect(line).toContain("never");
      }
    }
  });

  it("instructs one-question-at-a-time, no forms", () => {
    const d = buildOnboardingDirective("client", {}).toLowerCase();
    expect(d).toContain("one question per message");
    expect(d).toContain("never send a numbered list");
  });
});
