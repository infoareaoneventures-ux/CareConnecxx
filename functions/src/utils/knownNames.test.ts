import { describe, it, expect, vi } from "vitest";

// 2026-09-07 (live-caught): collectKnownNames read onboardingData.recipients,
// a field nothing in the codebase ever writes — the real field is
// additionalRecipients (careRecipients.ts's CareRecipient[] shape). This
// silently made the "already known" allowlist for the persona-shift detector
// always empty for that source, so mentioning a second, already-added
// household member still tripped a false "different person" alarm every time.

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({}), { FieldValue: { arrayUnion: (...vals: unknown[]) => ({ __arrayUnion: vals }) } });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});

import { collectKnownNames, firstNameToken } from "./knownNames";

describe("collectKnownNames", () => {
  it("includes additionalRecipients names (the real onboardingData field)", () => {
    const names = collectKnownNames({
      onboardingData: {
        seniorName: "Rosie Alvarez",
        additionalRecipients: [{ name: "David Alvarez", relationship: "father" }],
      },
    });
    expect(names).toEqual(expect.arrayContaining(["rosie", "david"]));
  });

  it("ignores onboardingData.recipients — that field is never written anywhere", () => {
    const names = collectKnownNames({
      onboardingData: { seniorName: "Rosie", recipients: [{ name: "Ghost Person" }] },
    });
    expect(names).not.toContain("ghost");
  });

  it("includes anyone already selected in an in-progress job-posting who/where step", () => {
    const names = collectKnownNames({
      onboardingData: { seniorName: "Rosie" },
      jobPostingData: { careRecipients: [{ firstName: "David", lastName: "Alvarez", relationship: "Parent", isSelf: false }] },
    });
    expect(names).toEqual(expect.arrayContaining(["rosie", "david"]));
  });
});

describe("firstNameToken", () => {
  it("drops known placeholders instead of treating them as real names", () => {
    expect(firstNameToken("your loved one")).toBe("");
    expect(firstNameToken("__parse_error__")).toBe("");
  });

  it("reduces a full name to its lowercased first-name token", () => {
    expect(firstNameToken("David Alvarez")).toBe("david");
  });
});
