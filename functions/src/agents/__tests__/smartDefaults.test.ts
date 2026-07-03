import { describe, it, expect } from "vitest";
import { SMART_DEFAULTS_DIRECTIVE } from "../smartDefaults";

// The "don't play twenty questions" directive lets Evia default low-stakes
// details instead of interrogating. Its HARD LIMIT is safety-critical — it keeps
// that behavior away from money/booking/care. These guard the boundary so a
// future prompt edit can't silently widen "default-and-go" into dangerous
// territory.

describe("SMART_DEFAULTS_DIRECTIVE", () => {
  it("tells Evia to default low-stakes details instead of interrogating", () => {
    expect(SMART_DEFAULTS_DIRECTIVE).toContain("DON'T PLAY TWENTY QUESTIONS");
    expect(SMART_DEFAULTS_DIRECTIVE.toLowerCase()).toContain("low-stakes only");
  });

  it("carries a HARD LIMIT that excludes the irreversible/high-stakes surface", () => {
    const lower = SMART_DEFAULTS_DIRECTIVE.toLowerCase();
    expect(lower).toContain("hard limit");
    // The dangerous surfaces must be named so defaults never reach them.
    for (const surface of ["money", "booking", "cancellation", "medication", "irreversible"]) {
      expect(lower).toContain(surface);
    }
  });

  it("still requires confirmation before acting on the high-stakes surface", () => {
    expect(SMART_DEFAULTS_DIRECTIVE.toLowerCase()).toContain("confirm");
  });

  it("preserves one-thing-at-a-time when info genuinely must be collected", () => {
    expect(SMART_DEFAULTS_DIRECTIVE.toLowerCase()).toContain("one thing at a time");
  });
});
