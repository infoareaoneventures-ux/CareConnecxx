import { describe, it, expect } from "vitest";
import { GROUNDING_REASK_COPY, buildHandoffGroundingPayload } from "../humanHandoff";
import { classifyGroundingClaims } from "../groundingClaims";

describe("grounding gate — the re-ask and the evidence the checker sees (live 2026-11-23)", () => {
  it("the re-ask reads right for a question, not only an edit, and is never itself a claim", () => {
    expect(GROUNDING_REASK_COPY).not.toMatch(/what you'd like me to change/i);
    expect(GROUNDING_REASK_COPY).toMatch(/couldn't confirm/i);
    expect(classifyGroundingClaims(GROUNDING_REASK_COPY)).toEqual([]);
  });

  it("a visit deep inside a long tool result still reaches the checker", () => {
    // 20,000 characters of earlier visits, then the in-progress one: under the old 8,000-character cap it was cut.
    const filler = "Tuesday visit scheduled with Imran Mohammed 9:00 AM - 1:00 PM. ".repeat(320);
    const tools = `${filler}\nIN-PROGRESS: Imran Mohammed ends 3:00 PM today`;
    const payload = buildHandoffGroundingPayload("context", [], "Imran's shift ends at 3:00 PM.", tools, "When does the shift end?");
    expect(payload).toContain("IN-PROGRESS: Imran Mohammed ends 3:00 PM today");
  });
});
