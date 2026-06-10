import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { guardOutbound } from "./outboundGuard";

// Silence the redaction warning during tests while letting us assert on it.
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe("guardOutbound — PII redaction", () => {
  it("redacts SSNs", async () => {
    const got = await guardOutbound("Her SSN is 123-45-6789 for the form.");
    expect(got.ok).toBe(true);
    expect(got.text).not.toContain("123-45-6789");
    expect(got.text).toContain("[redacted]");
    expect(got.redactions).toContain("ssn");
  });

  it("redacts Luhn-valid card numbers (spaced and dashed)", async () => {
    const spaced = await guardOutbound("The card on file is 4242 4242 4242 4242.");
    expect(spaced.text).not.toContain("4242 4242 4242 4242");
    expect(spaced.text).toContain("[redacted]");
    expect(spaced.redactions).toContain("card_number");

    const dashed = await guardOutbound("Use 4111-1111-1111-1111 at checkout.");
    expect(dashed.text).not.toContain("4111-1111-1111-1111");
    expect(dashed.redactions).toContain("card_number");
  });

  it("leaves Luhn-INVALID 16-digit runs alone (booking/order ids)", async () => {
    // 1234567890123456 fails the Luhn checksum — must not be mangled.
    const got = await guardOutbound("Your confirmation code is 1234 5678 9012 3456.");
    expect(got.text).toContain("1234 5678 9012 3456");
    expect(got.redactions).toEqual([]);
  });

  it("leaves short digit runs alone — phone numbers, 911, booking refs", async () => {
    const got = await guardOutbound(
      "If it's urgent call 911. Otherwise Maria at (555) 123-4567 — booking ref 1234567890, Thursday at 3pm.",
    );
    expect(got.ok).toBe(true);
    expect(got.text).toContain("911");
    expect(got.text).toContain("(555) 123-4567");
    expect(got.text).toContain("1234567890");
    expect(got.redactions).toEqual([]);
  });

  it("redacts non-careconnex email addresses but keeps careconnex ones", async () => {
    const got = await guardOutbound(
      "You can reach support@careconnex.com, or the doctor at dr.lee@gmailclinic.com.",
    );
    expect(got.text).toContain("support@careconnex.com");
    expect(got.text).not.toContain("dr.lee@gmailclinic.com");
    expect(got.redactions).toEqual(["email"]);
  });

  it("logs a count-only warning when redacting (never the values)", async () => {
    await guardOutbound("SSN 123-45-6789 and card 4242 4242 4242 4242.");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedArgs = JSON.stringify(warnSpy.mock.calls[0]);
    expect(loggedArgs).not.toContain("123-45-6789");
    expect(loggedArgs).not.toContain("4242");
  });
});

describe("guardOutbound — fail open for ordinary text", () => {
  it("passes clean text through unchanged with ok:true", async () => {
    const text = "Hey! Maria's coming Thursday at 3pm. Anything you want me to pass along?";
    const got = await guardOutbound(text, { audience: "family" });
    expect(got).toEqual({ ok: true, text, redactions: [] });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("never returns ok:false, even when everything was redacted", async () => {
    const got = await guardOutbound("123-45-6789");
    expect(got.ok).toBe(true);
    expect(got.text).toBe("[redacted]");
  });
});

describe("guardOutbound — lint pass", () => {
  it("strips banned phrases via the shared linter", async () => {
    const got = await guardOutbound("I cannot pull that up right now, rest assured it will be fine.");
    expect(got.ok).toBe(true);
    expect(got.text).not.toContain("I cannot");
    expect(got.text).not.toContain("rest assured");
    // Lint changes are voice fixes, not PII redactions.
    expect(got.redactions).toEqual([]);
  });
});
