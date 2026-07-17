import { describe, it, expect } from "vitest";
import {
  recipientPlanKey,
  householdSeniorDocId,
  resolveRecipientKey,
  normalizeAdditionalRecipients,
  allCareRecipients,
  describeWhoIsWho,
} from "./careRecipients";

describe("recipientPlanKey", () => {
  it("matches the web CarePlan.tsx getKey format byte-for-byte", () => {
    // Mirror of components/CarePlan.tsx getKey — if this drifts, Evia-written
    // plans become invisible in the web tabs.
    const webGetKey = (firstName: string, lastName: string) =>
      `${firstName.toLowerCase()}_${(lastName || "noname").toLowerCase()}`
        .replace(/\s+/g, "_")
        .replace(/[~*/[\].]/g, "");
    expect(recipientPlanKey("Mary")).toBe(webGetKey("Mary", ""));
    expect(recipientPlanKey("Mary", "O'Neil")).toBe(webGetKey("Mary", "O'Neil"));
    expect(recipientPlanKey("Ana Maria", "de la Cruz")).toBe(webGetKey("Ana Maria", "de la Cruz"));
    expect(recipientPlanKey("J.R.", "[Smith]")).toBe(webGetKey("J.R.", "[Smith]"));
  });

  it("defaults missing last name to noname", () => {
    expect(recipientPlanKey("Bob")).toBe("bob_noname");
  });
});

describe("resolveRecipientKey", () => {
  const keys = ["mary_noname", "john_noname"];

  it("resolves an exact first-name match", () => {
    expect(resolveRecipientKey(keys, "Mary")).toEqual({ ok: true, key: "mary_noname", named: true });
  });

  it("resolves a full name by its first token", () => {
    expect(resolveRecipientKey(keys, "Mary Johnson")).toEqual({ ok: true, key: "mary_noname", named: true });
  });

  it("prefix-matches against keys with real last names", () => {
    expect(resolveRecipientKey(["mary_smith", "john_smith"], "Mary")).toEqual({ ok: true, key: "mary_smith", named: true });
  });

  it("mints a fresh key for an unknown name (new recipient is a valid outcome)", () => {
    expect(resolveRecipientKey(keys, "Alice")).toEqual({ ok: true, key: "alice_noname", named: true });
  });

  it("unnamed with a sole plan resolves to it", () => {
    expect(resolveRecipientKey(["mary_noname"])).toEqual({ ok: true, key: "mary_noname", named: false });
  });

  it("unnamed with 2+ plans is ambiguous", () => {
    expect(resolveRecipientKey(keys)).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("unnamed with no plans cannot resolve", () => {
    expect(resolveRecipientKey([])).toEqual({ ok: false, reason: "none_on_file" });
    expect(resolveRecipientKey([], "   ")).toEqual({ ok: false, reason: "none_on_file" });
  });
});

describe("householdSeniorDocId", () => {
  it("is deterministic (webhook retries must not mint duplicates)", () => {
    expect(householdSeniorDocId("uid1", "John")).toBe("uid1_john_noname");
    expect(householdSeniorDocId("uid1", "John")).toBe(householdSeniorDocId("uid1", "John"));
  });
});

describe("allCareRecipients / normalizeAdditionalRecipients", () => {
  it("primary first, additional after, deduped by key", () => {
    const out = allCareRecipients({
      seniorName: "Mary",
      relationship: "mother",
      age: 82,
      additionalRecipients: [
        { name: "John", relationship: "father", age: 84 },
        { name: "mary" }, // dup of primary — dropped
        { name: "" },     // invalid — dropped
      ],
    });
    expect(out.map((r) => r.name)).toEqual(["Mary", "John"]);
  });

  it("tolerates garbage additionalRecipients shapes", () => {
    expect(normalizeAdditionalRecipients(undefined)).toEqual([]);
    expect(normalizeAdditionalRecipients("not an array")).toEqual([]);
    expect(normalizeAdditionalRecipients([null, 42, { age: 90 }])).toEqual([]);
  });
});

describe("describeWhoIsWho", () => {
  it("names the recipient and forbids attributing care to the account holder", () => {
    const line = describeWhoIsWho({
      firstName: "Anahi",
      seniorName: "Rosie",
      relationship: "mother",
    });
    expect(line).toContain("the person texting is Anahi");
    expect(line).toContain("Rosie (their mother)");
    expect(line).toContain("never for Anahi");
    expect(line).toContain("\"Anahi's visits\"");
  });

  it("lists every recipient in a multi-recipient household", () => {
    const line = describeWhoIsWho({
      firstName: "Anahi",
      seniorName: "Rosie",
      relationship: "mother",
      additionalRecipients: [{ name: "Frank", relationship: "father" }],
    });
    expect(line).toContain("Rosie (their mother) and Frank (their father)");
    expect(line).toContain("recipients are");
  });

  it("self signups say the person texting IS the recipient", () => {
    const line = describeWhoIsWho({
      firstName: "Rosa",
      seniorName: "Rosa",
      relationship: "self",
    });
    expect(line).toContain("Rosa is arranging care for THEMSELVES");
    expect(line).toContain("IS the care recipient");
    expect(line).not.toContain("the family member coordinating care");
  });

  it("no recipient on file yet: still warns care is not for the account holder", () => {
    const line = describeWhoIsWho({ firstName: "Anahi" });
    expect(line).toContain("recipient's name not on file yet");
    expect(line).toContain("Never assume the care is for Anahi");
  });

  it("returns empty when nothing is known", () => {
    expect(describeWhoIsWho({})).toBe("");
  });

  it("recipient matching the account holder's name is not double-listed", () => {
    // seniorName equal to the texter without relationship=self (legacy shape):
    // fall through to the loved-one-unknown line rather than "Anahi's care is
    // for Anahi, never for Anahi".
    const line = describeWhoIsWho({ firstName: "Anahi", seniorName: "Anahi" });
    expect(line).toContain("Never assume the care is for Anahi");
  });
});
