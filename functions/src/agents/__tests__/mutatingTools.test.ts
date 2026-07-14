import { describe, it, expect } from "vitest";
import { isHighStakesMutation, HIGH_STAKES_MUTATIONS } from "../toolCapabilities";

// U3 — high-stakes mutation classification. When one of these tools errors, the
// agent loop must surface an is_error result so Evia never reports a failed
// state-changing action as success. Read-only lookups keep the soft path.

describe("isHighStakesMutation (U3)", () => {
  it("flags the destructive/committing actions a false success would harm", () => {
    for (const tool of [
      "cancel_appointment",
      "request_booking",
      "request_instant_payout",
      "cancel_subscription",
      "remove_family_member",
      "update_care_plan",
      "send_caregiver_message",
    ]) {
      expect(isHighStakesMutation(tool), `${tool} should be high-stakes`).toBe(true);
    }
  });

  it("does NOT flag read-only lookups", () => {
    for (const tool of [
      "get_senior_profile",
      "get_upcoming_appointments",
      "browse_job_board",
      "search_memory",
      "get_billing_summary",
      "list_job_applicants",
    ]) {
      expect(isHighStakesMutation(tool), `${tool} should not be high-stakes`).toBe(false);
    }
  });

  it("excludes intentionally low-stakes writes (echoed or cosmetic)", () => {
    // Evia already echoes memory notes back; journal social actions are cosmetic.
    for (const tool of ["update_memory_file", "like_journal_entry", "comment_on_journal_entry"]) {
      expect(isHighStakesMutation(tool), `${tool} should be excluded`).toBe(false);
    }
  });

  it("returns false for unknown tool names", () => {
    expect(isHighStakesMutation("nonexistent_tool")).toBe(false);
    expect(isHighStakesMutation("")).toBe(false);
  });

  it("every entry is a non-empty string (guards against typos collapsing the set)", () => {
    for (const name of HIGH_STAKES_MUTATIONS) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
