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
    expect(d).toContain("the senior's age");
    expect(d).toContain("what kind of help the senior needs");
    expect(d).toContain("how many days a week");
    // firstName is known → shown as known, not as still-needed
    expect(d).toMatch(/already have it[\s\S]*first name|first name[\s\S]*already have it/i);
  });

  it("client with everything collected instructs complete_collection, not more asking", () => {
    const d = buildOnboardingDirective("client", {
      firstName: "Imran", seniorName: "Dorothy", age: 82, careNeeds: ["bathing"],
      city: "Austin", daysPerWeek: 5, timeOfDay: "mornings",
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
    expect(d).toContain("once per conversation");
    expect(d).toContain("never repeat it");
  });

  it("handles self-seekers: senior = sender, direct address, never asks who they're caring for", () => {
    const d = buildOnboardingDirective("client", {}).toLowerCase();
    expect(d).toContain("self-care");
    expect(d).toContain("themselves");
    expect(d).toContain('relationship as "self"');
    expect(d).toContain("never ask who they're caring for");
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
