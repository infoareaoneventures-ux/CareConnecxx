import { describe, it, expect, vi } from "vitest";
import { repairUnsupportedDraft, GROUNDING_REPAIR_SYSTEM_PROMPT } from "../groundingRepair";
import { GROUNDING_REASK_COPY } from "../humanHandoff";

const input = {
  draft: "Imran's shift ends at 4:00 PM.",
  userText: "When does the shift end?",
  systemContext: "context",
  history: [],
  toolObservations: "visit: in-progress, 9:00 AM - 1:00 PM",
};

describe("repairing an unbacked draft instead of sending a canned line (live 2026-11-23)", () => {
  it("sends the rewrite when it states no facts of its own", async () => {
    const complete = vi.fn().mockResolvedValueOnce("Sorry, I couldn't find that just now.");
    const r = await repairUnsupportedDraft(input, { complete });
    expect(r).toEqual({ reply: "Sorry, I couldn't find that just now.", outcome: "repaired" });
    expect(complete).toHaveBeenCalledTimes(1); // nothing to re-check
    expect(complete.mock.calls[0][0]).toBe(GROUNDING_REPAIR_SYSTEM_PROMPT);
  });

  it("re-checks a rewrite that still states a time or date, and sends it only if the checker backs it", async () => {
    const backed = vi.fn().mockResolvedValueOnce("Imran's visit runs 9:00 AM to 1:00 PM.").mockResolvedValueOnce("SUPPORTED");
    expect((await repairUnsupportedDraft(input, { complete: backed })).outcome).toBe("repaired");
    expect(backed).toHaveBeenCalledTimes(2);

    const notBacked = vi.fn().mockResolvedValueOnce("Imran's visit ends at 4:00 PM.").mockResolvedValueOnce("UNSUPPORTED");
    const r = await repairUnsupportedDraft(input, { complete: notBacked });
    expect(r).toEqual({ reply: GROUNDING_REASK_COPY, outcome: "fallback", reason: "rejected" });
  });

  it("falls back to the neutral line when the model fails, times out or returns nothing", async () => {
    expect(await repairUnsupportedDraft(input, { complete: vi.fn().mockRejectedValue(new Error("down")) })).toMatchObject({ outcome: "fallback", reason: "error" });
    expect(await repairUnsupportedDraft(input, { complete: vi.fn().mockResolvedValue("   ") })).toMatchObject({ outcome: "fallback", reason: "empty" });
    // an unreadable verdict is not "supported"
    const garbled = vi.fn().mockResolvedValueOnce("Visit ends at 4:00 PM.").mockResolvedValueOnce("hmm");
    expect((await repairUnsupportedDraft(input, { complete: garbled })).outcome).toBe("fallback");
  });

  it("tells the model to keep backed facts, drop guesses, and never invent offers", () => {
    expect(GROUNDING_REPAIR_SYSTEM_PROMPT).toMatch(/ONLY facts that appear/);
    expect(GROUNDING_REPAIR_SYSTEM_PROMPT).toMatch(/never guess/i);
    expect(GROUNDING_REPAIR_SYSTEM_PROMPT).toMatch(/Do not add offers/);
  });
});
