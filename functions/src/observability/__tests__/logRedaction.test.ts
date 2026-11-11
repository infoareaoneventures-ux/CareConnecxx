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


// 2026-11-11 (Wave 4): message text is logged as a length only; an Error's message is masked too.
describe("message text and errors", () => {
  it("fields that hold what a person wrote become a length", () => {
    const o = redactValue({ phone: "+14087261330", text: "my mom fell and is not breathing", body: "hi", other: "keep me" }) as Record<string, unknown>;
    expect(o.text).toBe("[32 chars]");
    expect(o.body).toBe("[2 chars]");
    expect(o.other).toBe("keep me");
    expect(String(o.phone)).not.toContain("4087261330");
  });
  it("reaches nested fields and arrays but leaves class instances alone", () => {
    const when = new Date(0);
    const o = redactValue({ a: { b: { content: "secret words" } }, list: [{ text: "x" }], when }) as any;
    expect(o.a.b.content).toBe("[12 chars]");
    expect(o.list[0].text).toBe("[1 chars]");
    expect(o.when).toBe(when);
  });
  it("an Error with a number in its message is masked and stays an Error", () => {
    const e = redactValue(new Error("send failed for +15551234567")) as Error;
    expect(e).toBeInstanceOf(Error);
    expect(e.message).not.toContain("15551234567");
    const plain = new Error("nothing private");
    expect(redactValue(plain)).toBe(plain);
  });
});
