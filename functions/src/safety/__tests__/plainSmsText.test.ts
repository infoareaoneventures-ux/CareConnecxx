import { describe, it, expect } from "vitest";
import { plainSmsText, lintMessage } from "../linter";

describe("plainSmsText (founders 2026-11-24/25: asterisks and ACCEPT/DECLINE showing in a model reply)", () => {
  it("drops markdown bold and lowers command words, leaving everything else alone", () => {
    expect(plainSmsText("It shows **Hamse Client, Nov 23**: **2:07:40** at **$25/hr**.")).toBe("It shows Hamse Client, Nov 23: 2:07:40 at $25/hr.");
    expect(plainSmsText("You can ACCEPT to follow the new schedule or DECLINE to keep it.")).toBe("You can accept to follow the new schedule or decline to keep it.");
    expect(plainSmsText("Reply STOP to opt out. OK, 9:00 AM.")).toBe("Reply STOP to opt out. OK, 9:00 AM.");
  });
  it("is part of the model-reply lint", () => {
    expect(lintMessage("Say **SUBMIT** when ready")).toBe("Say submit when ready");
  });
});
