import { describe, it, expect } from "vitest";
import { enforceCareProviderTerm, lintMessage, lintPreservingLayout } from "./linter";

describe("lintMessage", () => {
  it("replaces em-dashes with commas", () => {
    expect(lintMessage("Got it — updated")).toBe("Got it, updated");
  });

  it("strips banned phrases", () => {
    expect(lintMessage("Absolutely! It's done")).toBe("It's done");
  });

  it("collapses blank lines (its documented behavior)", () => {
    expect(lintMessage("first\n\nsecond")).toBe("first\nsecond");
  });

  it("leaves en-dash time ranges alone", () => {
    expect(lintMessage("9:00 AM – 1:00 PM")).toBe("9:00 AM – 1:00 PM");
  });

  it.each([
    "I'm not able to set up care in Austin just yet.",
    "I cannot give medical advice, but here is what I can do.",
    "I am unable to book Tuesday.",
    "I don't have the ability to change that.",
  ])("keeps negations: %p", (text) => {
    expect(lintMessage(text)).toBe(text);
    expect(lintPreservingLayout(text)).toBe(text);
  });
});

describe("lintPreservingLayout", () => {
  it("replaces em-dashes with commas", () => {
    expect(lintPreservingLayout("Got it — updated")).toBe("Got it, updated");
  });

  it("preserves intentional blank lines between paragraphs", () => {
    const input =
      "Maria submitted her hours for today:\n\n" +
      "Caregiver: Maria R.\nAmount: $96.00\n\n" +
      "Reply APPROVE to confirm.";
    expect(lintPreservingLayout(input)).toBe(input);
  });

  it("does not touch en-dashes in time ranges", () => {
    expect(lintPreservingLayout("9:00 AM – 1:00 PM")).toBe("9:00 AM – 1:00 PM");
  });

  it("collapses 3+ consecutive newlines to a single blank line", () => {
    expect(lintPreservingLayout("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("is idempotent", () => {
    const once = lintPreservingLayout("Hi — there — friend");
    expect(lintPreservingLayout(once)).toBe(once);
  });

  it("strips banned phrases while keeping layout", () => {
    expect(lintPreservingLayout("Absolutely! Here you go:\n\nDone")).toBe(
      "Here you go:\n\nDone",
    );
  });

  it("rewrites chatbot framing into Evia's care-coordinator voice", () => {
    expect(lintPreservingLayout("I'm Evia, an AI care assistant for Mom.")).toBe(
      "I'm Evia, care coordinator for Mom.",
    );
    expect(lintPreservingLayout("This chatbot can help.")).toBe("This Evia can help.");
  });

  it("rewrites generic helper and support-punt copy", () => {
    expect(lintPreservingLayout("How can I help today?")).toBe("What should I check first?");
    expect(lintPreservingLayout("Our team will follow up within 24 hours.")).toBe("I flagged this for review.");
    expect(lintPreservingLayout("Please contact support.")).toBe("Text me what happened and I can handle the next step here.");
  });

  it("strips stalled-promise phrasing (unscheduled future work)", () => {
    expect(lintMessage("I'll get back to you soon.")).toBe("soon.");
    expect(lintMessage("Let me find an alternative — I'll get back to you shortly.")).toBe(
      "Let me find an alternative, shortly.",
    );
    expect(lintPreservingLayout("I'll get back to you shortly.")).toBe("shortly.");
  });
});

// Founder 2026-10-12: model-written replies say "care provider", never "caregiver".
describe("enforceCareProviderTerm (model-written text only)", () => {
  it("rewrites the word in running text, keeping case and plural", () => {
    expect(enforceCareProviderTerm("Your caregiver is on the way.")).toBe("Your care provider is on the way.");
    expect(enforceCareProviderTerm("Caregivers near you: 3. CAREGIVER SEARCH done.")).toBe("Care providers near you: 3. CARE PROVIDER SEARCH done.");
    expect(enforceCareProviderTerm("the caregiver's rate")).toBe("the care provider's rate");
  });
  it("never touches a URL or path token", () => {
    expect(enforceCareProviderTerm("Open https://eviacares.com/caregiver/jobs to apply")).toBe("Open https://eviacares.com/caregiver/jobs to apply");
    expect(enforceCareProviderTerm("It's at /caregiver/settings now")).toBe("It's at /caregiver/settings now");
  });
  it("leaves identifiers and text without the word alone", () => {
    expect(enforceCareProviderTerm("caregiverId stays; publicCaregiverProfiles too")).toBe("caregiverId stays; publicCaregiverProfiles too");
    expect(enforceCareProviderTerm("Nothing to change here.")).toBe("Nothing to change here.");
  });
});
