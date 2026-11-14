import { describe, it, expect } from "vitest";
import { normalizeRoleAnswer } from "../roleAnswer";

describe("normalizeRoleAnswer", () => {
  it("'care provider' (the word the prompt asks for since the Oct 12 rename) is the internal caregiver role", () => {
    for (const a of ["care provider", "Care Provider", " care provider.", "caregiver", "care-provider", "provider"]) {
      expect(normalizeRoleAnswer(a)).toBe("caregiver");
    }
  });
  it("client, self and unclear pass through", () => {
    expect(normalizeRoleAnswer("client")).toBe("client");
    expect(normalizeRoleAnswer("Self")).toBe("self");
    expect(normalizeRoleAnswer("unclear")).toBe("unclear");
    expect(normalizeRoleAnswer("__parse_error__")).toBe("__parse_error__");
  });
});
