import { describe, it, expect } from "vitest";
import { lintMessage, lintPreservingLayout } from "./linter";

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
});
