import { describe, it, expect } from "vitest";
import { redactText, redactValue } from "../logRedaction";

// Phone numbers and emails never reach the function logs in clear text (2026-10-07).
describe("log redaction", () => {
  it("masks E.164 and US phone numbers, keeping the last 4 digits", () => {
    expect(redactText("phone: '+14087261330'")).toBe("phone: '+1••••••1330'");
    expect(redactText("call (408) 726-1330 today")).toBe("call •••-•••-1330 today");
    expect(redactText("408.726.1330")).toBe("•••-•••-1330");
  });
  it("masks emails but keeps the domain", () => {
    expect(redactText("to hamse143@gmail.com now")).toBe("to ha***@gmail.com now");
  });
  it("leaves ordinary numbers and ids alone", () => {
    expect(redactText("uid NdqUXibmLLUkvW4MRqvrkiFQbPN2 took 7028 ms, 61452 tokens")).toBe("uid NdqUXibmLLUkvW4MRqvrkiFQbPN2 took 7028 ms, 61452 tokens");
    expect(redactText("2026-10-07T15:50:45.174Z")).toBe("2026-10-07T15:50:45.174Z");
  });
  it("walks plain objects and arrays (the shape console.log receives)", () => {
    expect(redactValue({ phone: "+14087261330", nested: { email: "a.b@x.io", list: ["+15550001111", 42] }, ok: true }))
      .toEqual({ phone: "+1••••••1330", nested: { email: "a.***@x.io", list: ["+1••••••1111", 42] }, ok: true });
  });
  it("leaves Error objects intact so stacks still print", () => {
    const err = new Error("boom");
    expect(redactValue(err)).toBe(err);
  });
});
