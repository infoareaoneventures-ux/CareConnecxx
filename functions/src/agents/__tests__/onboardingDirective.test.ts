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
    expect(d).toContain("what type of care is needed");
    expect(d).toContain("which days of the week");
    // firstName is known → shown as known, not as still-needed
    expect(d).toMatch(/already have it[\s\S]*first name|first name[\s\S]*already have it/i);
  });

  it("client with everything collected instructs complete_collection, not more asking", () => {
    const d = buildOnboardingDirective("client", {
      firstName: "Imran", seniorName: "Dorothy", age: 82, careNeeds: ["bathing"], careKinds: ["senior"],
      homeStreet: "1 Main St", homeZipCode: "78701", sameAsHomeAddress: true,
      city: "Austin", zipCode: "78701", daysPerWeek: 5, timeOfDay: "mornings",
      careFrequency: "part_time", startDate: "2026-08-01", selectedDays: ["Mon", "Wed", "Fri"],
      relationship: "daughter", emergencyContactName: "Jane Doe", emergencyContactPhone: "+15551230000",
      rate: 25, email: "imran@example.com",
      // "everything collected" now means every wizard item, required AND
      // optional (see the combined CLIENT_WIZARD_FIELD_ORDER fix) — not just
      // the required subset.
      additionalRecipients: [], careRecipientPhotoURL: "x", ongoing: true, caregiversNeeded: 1,
      petsInHome: false, smokingHousehold: false, jobDescription: "x",
      emergencyContactRelationship: "friend", daysFlexible: false,
    });
    expect(d).toContain("complete_collection");
    expect(d).toContain("all items collected");
  });

  // 2026-08-24 fix: additionalRecipients had a label but was never in the
  // tracked optional-items list, so it had zero nudge to ever be asked —
  // unlike the website wizard, which always shows this question (Step 10,
  // right before "how many caregivers needed").
  it("nudges additionalRecipients before finishing, ordered right before caregiversNeeded", () => {
    const d = buildOnboardingDirective("client", {
      firstName: "Imran", seniorName: "Dorothy", careNeeds: ["bathing"], careKinds: ["senior"],
      homeStreet: "1 Main St", homeZipCode: "78701", sameAsHomeAddress: true,
      city: "Austin", zipCode: "78701", timeOfDay: "mornings",
      careFrequency: "part_time", startDate: "2026-08-01", selectedDays: ["Mon", "Wed", "Fri"],
      relationship: "daughter", emergencyContactName: "Jane Doe", emergencyContactPhone: "+15551230000",
      rate: 25, email: "imran@example.com",
      // caregiversNeeded already answered, but additionalRecipients isn't —
      // should still be nudged even though a LATER optional item is done.
      caregiversNeeded: 1,
    });
    expect(d).toContain("every OTHER person needing care");
    expect(d).toContain("not yet gotten a value for");
  });

  it("stops nudging additionalRecipients once it's been answered", () => {
    const d = buildOnboardingDirective("client", {
      firstName: "Imran", seniorName: "Dorothy", careNeeds: ["bathing"], careKinds: ["senior"],
      homeStreet: "1 Main St", homeZipCode: "78701", sameAsHomeAddress: true,
      city: "Austin", zipCode: "78701", timeOfDay: "mornings",
      careFrequency: "part_time", startDate: "2026-08-01", selectedDays: ["Mon", "Wed", "Fri"],
      relationship: "daughter", emergencyContactName: "Jane Doe", emergencyContactPhone: "+15551230000",
      rate: 25,
      additionalRecipients: [], careRecipientPhotoURL: "x", ongoing: true, caregiversNeeded: 1,
      petsInHome: false, smokingHousehold: false, jobDescription: "x",
      age: 82, emergencyContactRelationship: "friend", daysFlexible: false,
    });
    expect(d).not.toContain("every OTHER person needing care");
    expect(d).not.toContain("not yet gotten a value for");
  });

  // 2026-08-24: age, emergencyContactRelationship, and daysFlexible had labels
  // but were never in the tracked list, so they had zero nudge to ever be asked.
  it("nudges emergencyContactRelationship and daysFlexible before finishing — and never age (2026-10-17)", () => {
    const d = buildOnboardingDirective("client", {
      firstName: "Imran", seniorName: "Dorothy", careNeeds: ["bathing"], careKinds: ["senior"],
      homeStreet: "1 Main St", homeZipCode: "78701", sameAsHomeAddress: true,
      city: "Austin", zipCode: "78701", timeOfDay: "mornings",
      careFrequency: "part_time", startDate: "2026-08-01", selectedDays: ["Mon", "Wed", "Fri"],
      relationship: "daughter", emergencyContactName: "Jane Doe", emergencyContactPhone: "+15551230000",
      rate: 25, email: "imran@example.com",
      additionalRecipients: [], careRecipientPhotoURL: "x", ongoing: true, caregiversNeeded: 1,
      petsInHome: false, smokingHousehold: false, jobDescription: "x",
      // age/emergencyContactRelationship/daysFlexible deliberately left unset
    });
    expect(d).toContain("not yet gotten a value for");
    expect(d).not.toContain("their age");
    expect(d).toContain("Never ask anyone's age");
    expect(d).toContain("how the emergency contact is related");
    expect(d).toContain("whether their days are flexible");
  });

  it("care provider role uses the care provider checklist, not the client one", () => {
    const d = buildOnboardingDirective("caregiver", { name: "Maria" });
    expect(d).toContain("hourly rate");
    expect(d).toContain("years of care experience");
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

  it("care types = the website's eight by name, only those, read back, medical never a need, no sweep; the description carries the public-post warning (2026-10-04)", () => {
    const d = buildOnboardingDirective("client", { firstName: "Imran", seniorName: "Dorothy" }).toLowerCase();
    expect(d).toContain("mobility assistance\ndementia / memory care\nmedication reminders only\npersonal care\ncompanionship\ntransportation\nmeal preparation\nlight housekeeping");
    expect(d).toContain("read back");
    expect(d).toContain("is not saved");
    expect(d).toContain("reminding when it's time, not giving them");
    expect(d).toContain("never suggest they put medical details anywhere else");
    expect(d).toContain("no follow-up sweep");
    expect(d).toContain("care providers browsing jobs can read it");
    // 2026-10-09: the description is asked with the website's own step wording, is the job POST's only (not the care plan), and the site's example may be offered once if asked.
    expect(d).toContain("what else should care providers know about this job or your loved one?");
    expect(d).toContain("not the care plan");
    expect(d).toContain("never add to or rewrite them");
    expect(d).not.toContain("weave two or three natural examples");
  });
});

describe("buildOnboardingDirective — the care-type question, the six relationships and a child's stage (2026-10-18 late)", () => {
  it("asks the care type as its OWN required question, word for word, before the relationship; Other's follow-up is the contract line; a child's stage by name, never 'age range'", () => {
    const d = buildOnboardingDirective("client", { firstName: "Imran" });
    expect(d).toContain("8. The kind of care they need — its OWN question, word for word: \"What kind of care do you need — senior care, child care, or both?\"");
    expect(d).toContain("9. Their relationship to the person needing care (parent, spouse or partner, adult child, child, myself, or other)");
    expect(d).toContain("Is this person an adult or a child?");
    expect(d).toContain("Which stage is Mahad at — Infant, Toddler, Preschooler, School-age, or Teen?");
    expect(d).toContain("STAGE (ageRange)");
    expect(d.toLowerCase()).not.toContain("older adult");
    expect(d.toLowerCase()).not.toContain("age range");
    expect(d).not.toContain("Ages 3");
    // careKinds is STILL NEEDED and listed before the relationship
    expect(d.indexOf("the kind of care they need")).toBeLessThan(d.indexOf("the family member's relationship"));
  });
  it("the stage is still-needed only for a child recipient; a senior household is never nagged for it", () => {
    const base = { firstName: "Imran", careKinds: ["senior", "child"], seniorName: "Mahad" };
    expect(buildOnboardingDirective("client", { ...base, relationship: "child" })).toMatch(/STILL NEEDED[\s\S]*ONLY when the person needing care is a child/);
    expect(buildOnboardingDirective("client", { ...base, relationship: "parent" })).not.toMatch(/STILL NEEDED[\s\S]*ONLY when the person needing care is a child/);
    // 'other' follows a one-kind household: senior-only → an adult → no stage.
    expect(buildOnboardingDirective("client", { firstName: "Imran", careKinds: ["senior"], relationship: "other" })).not.toMatch(/STILL NEEDED[\s\S]*ONLY when the person needing care is a child/);
  });
});

describe("buildOnboardingDirective — fields captured from the current message (client)", () => {
  it("names the just-answered field and forbids re-filing the same text elsewhere", () => {
    const d = buildOnboardingDirective("client", { firstName: "Imran" }, undefined, ["firstName"]);
    expect(d).toContain("Their LAST message answered:");
    expect(d).toContain("Do NOT save its text into any other field");
  });
  it("ignores captured fields that are not actually known", () => {
    const d = buildOnboardingDirective("client", {}, undefined, ["firstName"]);
    expect(d).not.toContain("Their LAST message answered");
  });
});

describe("buildOnboardingDirective — wizard-parity requirements (2026-09-23)", () => {
  it("asks for the home STREET as a required item, in step-3 position, and never mentions conditions/diagnoses", () => {
    const d = buildOnboardingDirective("client", { careFrequency: "part_time" });
    const still = d.slice(d.indexOf("STILL NEEDED"), d.indexOf("WIZARD QUESTION ORDER"));
    const streetIdx = still.indexOf("the account holder's home street address");
    const zipIdx    = still.indexOf("the account holder's home zip code");
    expect(streetIdx).toBeGreaterThan(-1);
    expect(streetIdx).toBeLessThan(zipIdx);
    expect(still.slice(streetIdx, still.indexOf("\n", streetIdx))).not.toContain("optional");
    expect(d.toLowerCase()).not.toContain("diagnoses");
  });

  it("marks timeOfDay as optional for the family to skip", () => {
    const d = buildOnboardingDirective("client", {});
    const line = d.split("\n").find((l) => l.includes("what time of day")) ?? "";
    expect(line).toContain("optional for THEM to skip");
  });

  it("tells the model the rate is a number with no 'flexible' option", () => {
    const d = buildOnboardingDirective("client", {});
    expect(d).toContain('never save the word "flexible"');
    expect(d).not.toContain('or "flexible" if they say that');
  });
});
