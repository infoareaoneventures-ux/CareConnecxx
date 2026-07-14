import { beforeEach, describe, expect, it, vi } from "vitest";

const quickComplete = vi.fn();
vi.mock("../utils/openaiClient", () => ({
  quickComplete: (...args: unknown[]) => quickComplete(...args),
}));

import {
  HUMAN_MIDFLOW_FALLBACK,
  answerHumanMidFlow,
  answerHumanQuestionOnly,
  appendReAsk,
} from "./humanReply";

describe("humanReply", () => {
  beforeEach(() => {
    quickComplete.mockReset();
  });

  it("answers a mid-flow question and appends the current workflow prompt", async () => {
    quickComplete.mockResolvedValue("Yes, the visit can still happen if someone is home.");

    const reply = await answerHumanMidFlow({
      audience: "family",
      situation: "family is confirming tomorrow's visit",
      text: "can my sister let her in?",
      reAsk: "So - should I keep the visit on the schedule?",
    });

    expect(reply).toBe(
      "Yes, the visit can still happen if someone is home.\n\nSo - should I keep the visit on the schedule?",
    );
    expect(String(quickComplete.mock.calls[0][0])).toContain("care coordinator");
    expect(String(quickComplete.mock.calls[0][0]).toLowerCase()).not.toContain("ai care assistant");
    expect(String(quickComplete.mock.calls[0][0]).toLowerCase()).not.toContain("chatbot");
  });

  it("uses a non-stalling fallback when the model fails", async () => {
    quickComplete.mockRejectedValue(new Error("down"));

    await expect(answerHumanQuestionOnly({
      audience: "caregiver",
      situation: "caregiver is choosing a shift",
      text: "will I still be paid?",
    })).resolves.toBe(HUMAN_MIDFLOW_FALLBACK);
  });

  it("does not append an empty re-ask", () => {
    expect(appendReAsk("I can check that.", "")).toBe("I can check that.");
  });
});
