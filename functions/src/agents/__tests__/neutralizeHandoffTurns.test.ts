import { describe, it, expect } from "vitest";
import { neutralizeHandoffTurns, CLOSED_HANDOFF_MARKER, HUMAN_HANDOFF_COPY } from "../humanHandoff";

describe("neutralizeHandoffTurns", () => {
  it("swaps Evia's hand-off replies for a neutral marker and keeps everything else", () => {
    const out = neutralizeHandoffTurns([
      { role: "user", content: "Set up an interview with Test Provider" },
      { role: "assistant", content: HUMAN_HANDOFF_COPY },
      { role: "user", content: "Test Provider" },
      { role: "assistant", content: "I've got this to a person, and they'll reply here by text." },
      { role: "user", content: "again please" },
      { role: "assistant", content: "I've passed that along, and the team will reply here by text." },
      { role: "assistant", content: "I'm looping in a teammate to double-check." },
      { role: "assistant", content: "I've got your message to the team, and they'll reply here by text." },
      { role: "assistant", content: "Here are two care providers near you." },
    ]);
    expect(out.map((m) => m.content === CLOSED_HANDOFF_MARKER)).toEqual([false, true, false, true, false, true, true, true, false]);
    expect(out[0].content).toBe("Set up an interview with Test Provider");
    expect(out[8].content).toBe("Here are two care providers near you.");
  });
  it("never touches a user message that happens to mention the team", () => {
    const out = neutralizeHandoffTurns([{ role: "user", content: "the team will reply here by text?" }]);
    expect(out[0].content).toBe("the team will reply here by text?");
  });
});
