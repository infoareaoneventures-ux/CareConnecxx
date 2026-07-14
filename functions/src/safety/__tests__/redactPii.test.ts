import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { redactPii } from "../redactPii";

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { warnSpy.mockRestore(); });

describe("redactPii", () => {
  it("redacts SSNs", () => {
    const got = redactPii("Her SSN is 123-45-6789 for the form.");
    expect(got.text).not.toContain("123-45-6789");
    expect(got.text).toContain("[redacted]");
    expect(got.redactions).toContain("ssn");
  });

  it("redacts Luhn-valid card numbers (spaced and dashed)", () => {
    const spaced = redactPii("The card on file is 4242 4242 4242 4242.");
    expect(spaced.text).not.toContain("4242 4242 4242 4242");
    expect(spaced.redactions).toContain("card_number");

    const dashed = redactPii("Use 4111-1111-1111-1111 at checkout.");
    expect(dashed.text).not.toContain("4111-1111-1111-1111");
    expect(dashed.redactions).toContain("card_number");
  });

  it("leaves Luhn-INVALID 16-digit runs alone (booking/order ids)", () => {
    const got = redactPii("Your confirmation code is 1234 5678 9012 3456.");
    expect(got.text).toContain("1234 5678 9012 3456");
    expect(got.redactions).toEqual([]);
  });

  it("leaves short digit runs alone — phone numbers, 911, booking refs", () => {
    const got = redactPii(
      "If it's urgent call 911. Otherwise Maria at (555) 123-4567 — booking ref 1234567890, Thursday at 3pm.",
    );
    expect(got.text).toContain("911");
    expect(got.text).toContain("(555) 123-4567");
    expect(got.text).toContain("1234567890");
    expect(got.redactions).toEqual([]);
  });

  it("redacts non-careconnex emails but keeps careconnex ones", () => {
    const got = redactPii("You can reach support@eviacares.com, or the doctor at dr.lee@gmailclinic.com.");
    expect(got.text).toContain("support@eviacares.com");
    expect(got.text).not.toContain("dr.lee@gmailclinic.com");
    expect(got.redactions).toEqual(["email"]);
  });

  it("logs a count-only warning when redacting (never the values)", () => {
    redactPii("SSN 123-45-6789 and card 4242 4242 4242 4242.");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedArgs = JSON.stringify(warnSpy.mock.calls[0]);
    expect(loggedArgs).not.toContain("123-45-6789");
    expect(loggedArgs).not.toContain("4242");
  });

  it("passes clean text through unchanged", () => {
    const text = "Hey! Maria's coming Thursday at 3pm. Anything you want me to pass along?";
    const got = redactPii(text);
    expect(got).toEqual({ text, redactions: [] });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("is idempotent — redacting already-redacted text is a no-op", () => {
    const once = redactPii("SSN 123-45-6789").text;
    const twice = redactPii(once);
    expect(twice.text).toBe(once);
    expect(twice.redactions).toEqual([]);
  });
});
