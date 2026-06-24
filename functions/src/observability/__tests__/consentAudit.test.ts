import { describe, it, expect } from "vitest";
import { buildConsentAuditRecord } from "../consentAudit";

const AT = "2026-06-23T18:00:00.000Z";

describe("buildConsentAuditRecord (U6)", () => {
  it("records a sent message with the consent state at send time", () => {
    const r = buildConsentAuditRecord(
      "+15551234567",
      "next_day_feedback",
      "sent",
      { optedOut: false, optedInAt: "2026-06-01T00:00:00.000Z" },
      AT,
    );
    expect(r).toEqual({
      phone: "+15551234567",
      campaign: "next_day_feedback",
      decision: "sent",
      optedOut: false,
      optedInAt: "2026-06-01T00:00:00.000Z",
      at: AT,
    });
  });

  it("records a suppressed send for an opted-out recipient", () => {
    const r = buildConsentAuditRecord("+15550000000", "payment_reminder", "suppressed_opted_out", { optedOut: true }, AT);
    expect(r.decision).toBe("suppressed_opted_out");
    expect(r.optedOut).toBe(true);
    expect(r.optedInAt).toBeNull(); // no opt-in on file
  });

  it("defaults a missing campaign and coerces optedOut to a boolean", () => {
    const r = buildConsentAuditRecord("+1555", "", "sent", {}, AT);
    expect(r.campaign).toBe("unknown");
    expect(r.optedOut).toBe(false);
    expect(r.optedInAt).toBeNull();
  });
});
