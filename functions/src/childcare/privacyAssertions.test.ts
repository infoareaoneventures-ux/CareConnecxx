// U13 privacy-assertion tests (plan 2026-07-22-002, R57).
//
// Pure module — no firebase-admin, no Firestore. Covers the recursive key
// scanner, string-value scanner, every surface wrapper, the log-redaction copy
// (incl. redactor-failure handling), and the synthetic-identifier guard.

import { describe, it, expect } from "vitest";
import {
  assertNoChildPii,
  assertNoChildPiiInString,
  assertLogPayloadChildSafe,
  assertMetricPayloadChildSafe,
  assertProviderMetadataChildSafe,
  assertPromptChildSafe,
  assertOutboundTemplateChildSafe,
  redactChildFieldsForLog,
  isSyntheticIdentifier,
  assertSyntheticIdentifier,
  ChildPrivacyAssertionError,
  PROHIBITED_CHILD_FIELD_KEYS,
  SAFE_TELEMETRY_FIELD_KEYS,
} from "./privacyAssertions";

describe("assertNoChildPii — recursive key scan", () => {
  it("rejects a prohibited key at the top level, nested, and inside arrays", () => {
    expect(() => assertNoChildPii({ dob: "2016-01-01" }, "t")).toThrow(/prohibited key/);
    expect(() => assertNoChildPii({ a: { b: { childName: "Mia" } } }, "t")).toThrow(/prohibited key/);
    expect(() => assertNoChildPii([{ ok: 1 }, { address: "x" }], "t")).toThrow(/prohibited key/);
  });

  it("rejects the U13 additions (identity image refs + screening narrative)", () => {
    for (const key of ["identityImage", "screeningNarrative", "adjudicationNotes", "incidentDetail"]) {
      expect(() => assertNoChildPii({ [key]: "x" }, "t"), key).toThrow(/prohibited key/);
    }
  });

  it("passes safe opaque-id / age-band / area payloads", () => {
    expect(() =>
      assertNoChildPii(
        { bookingId: "b1", householdId: "h1", ageBands: ["3-5"], areaLabel: "San Jose", count: 2 },
        "t",
      ),
    ).not.toThrow();
  });

  it("throws a typed ChildPrivacyAssertionError carrying the offending key + context", () => {
    try {
      assertNoChildPii({ ssn: "x" }, "myctx");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ChildPrivacyAssertionError);
      expect((err as ChildPrivacyAssertionError).offendingKey).toBe("ssn");
      expect((err as ChildPrivacyAssertionError).context).toBe("myctx");
    }
  });

  it("the prohibited set is a strict superset of the historical U6 outbound keys", () => {
    for (const k of ["childname", "dob", "address", "custody", "allergies", "displaylabel"]) {
      expect(PROHIBITED_CHILD_FIELD_KEYS.has(k)).toBe(true);
    }
  });
});

describe("assertNoChildPiiInString — value shapes", () => {
  it("rejects embedded DOB (both formats), SSN, and street address", () => {
    expect(() => assertNoChildPiiInString("born 03/04/2016", "t")).toThrow(/date of birth/);
    expect(() => assertNoChildPiiInString("dob 2016-03-04", "t")).toThrow(/date of birth/);
    expect(() => assertNoChildPiiInString("ssn 123-45-6789", "t")).toThrow(/SSN/);
    expect(() => assertNoChildPiiInString("lives at 123 Main Street", "t")).toThrow(/street address/);
  });

  it("passes generic notification copy and times", () => {
    expect(() => assertNoChildPiiInString("You have a new booking update. Open the app.", "t")).not.toThrow();
    expect(() => assertNoChildPiiInString("Your visit starts at 3:30pm", "t")).not.toThrow();
  });
});

describe("surface wrappers", () => {
  it("log/provider/prompt wrappers reject prohibited keys", () => {
    expect(() => assertLogPayloadChildSafe({ healthNotes: "x" }, "s")).toThrow(/prohibited key/);
    expect(() => assertProviderMetadataChildSafe({ dateOfBirth: "x" }, "s")).toThrow(/prohibited key/);
    expect(() => assertPromptChildSafe({ pickupNotes: "x" }, "s")).toThrow(/prohibited key/);
  });

  it("prompt wrapper also rejects an embedded value shape", () => {
    expect(() => assertPromptChildSafe("child born 01/02/2015", "s")).toThrow(/date of birth/);
  });

  it("metric wrapper rejects a non-allowlisted ENVELOPE key even if not prohibited", () => {
    // `foo` is neither prohibited nor a safe telemetry field.
    expect(() => assertMetricPayloadChildSafe({ signal: "x", foo: 1 }, "s")).toThrow(/non-allowlisted/);
  });

  it("metric wrapper passes a valid safe envelope with a dynamic detail map", () => {
    expect(() =>
      assertMetricPayloadChildSafe(
        { signal: "booking_transition_anomaly", severity: "medium", count: 3, threshold: 5, detail: { accepted: 2, declined: 1 } },
        "s",
      ),
    ).not.toThrow();
  });

  it("outbound-template wrapper rejects both a prohibited key and an embedded DOB string", () => {
    expect(() => assertOutboundTemplateChildSafe({ childName: "Mia" }, "s")).toThrow(/prohibited key/);
    expect(() => assertOutboundTemplateChildSafe({ body: "DOB 05/06/2017" }, "s")).toThrow(/date of birth/);
  });

  it("every safe telemetry key is lowercase (contract for the recursive lowercased match)", () => {
    for (const k of SAFE_TELEMETRY_FIELD_KEYS) expect(k).toBe(k.toLowerCase());
  });
});

describe("redactChildFieldsForLog — never throws", () => {
  it("drops prohibited keys and scrubs DOB/SSN in string values", () => {
    const out = redactChildFieldsForLog({
      bookingId: "b1",
      childName: "Mia",
      note: "born 03/04/2016 ssn 123-45-6789",
    });
    const flat = JSON.stringify(out.value);
    expect(flat).not.toContain("Mia");
    expect(flat).not.toContain("03/04/2016");
    expect(flat).not.toContain("123-45-6789");
    expect(flat).toContain("b1"); // opaque id preserved
    expect(out.redactedKeys).toContain("childName");
    expect(out.redactorFailed).toBe(false);
  });

  it("handles arrays and primitives without throwing", () => {
    expect(() => redactChildFieldsForLog([{ dob: "x" }, "plain"])).not.toThrow();
    expect(() => redactChildFieldsForLog("just a string")).not.toThrow();
  });
});

describe("synthetic-identifier guard (canary state, R63)", () => {
  it("accepts marked synthetic ids and rejects real-looking ids", () => {
    expect(isSyntheticIdentifier("synthetic-household-1")).toBe(true);
    expect(isSyntheticIdentifier("canary_child_42")).toBe(true);
    expect(isSyntheticIdentifier("Xk29ffLmReal")).toBe(false);
    expect(() => assertSyntheticIdentifier("synthetic-1", "canary")).not.toThrow();
    expect(() => assertSyntheticIdentifier("realDocId123", "canary")).toThrow(/SYNTHETIC/);
  });
});
