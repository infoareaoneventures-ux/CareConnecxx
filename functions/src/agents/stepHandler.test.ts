import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/parseWithClaude", () => ({ parseWithClaude: vi.fn() }));
vi.mock("../utils/openaiClient", () => ({ quickComplete: vi.fn() }));

import { runStep, isQuestionOrOther, classifyAwaitingReply } from "./stepHandler";
import { parseWithClaude } from "../utils/parseWithClaude";
import { quickComplete } from "../utils/openaiClient";

const mockParse = parseWithClaude as unknown as ReturnType<typeof vi.fn>;
const mockQuick = quickComplete as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => { mockParse.mockReset(); mockQuick.mockReset(); });

describe("isQuestionOrOther", () => {
  it("detects a mid-flow question", async () => {
    mockParse.mockResolvedValue("YES");
    expect(await isQuestionOrOther("what does that mean?", "What's your rate?")).toBe(true);
  });
  it("treats a direct answer as not-a-question", async () => {
    mockParse.mockResolvedValue("NO");
    expect(await isQuestionOrOther("$25/hr", "What's your rate?")).toBe(false);
  });
  it("fails toward answer (NO) when the classifier errors", async () => {
    mockParse.mockRejectedValueOnce(new Error("down"));
    expect(await isQuestionOrOther("$25/hr")).toBe(false);
  });
});

describe("classifyAwaitingReply", () => {
  // Regression: "Sounds good thank you" at caregiver_awaiting_bgcheck got the
  // whole Checkr flow re-explained (founder screenshot, 2026-07-09). A pure
  // acknowledgment must classify as "ack" so awaiting-step handlers reply with
  // one brief line instead of re-explaining or re-sending the link.
  it("maps a pure acknowledgment to ack", async () => {
    mockParse.mockResolvedValue("ack");
    expect(await classifyAwaitingReply("Sounds good thank you", "finish the Checkr form")).toBe("ack");
  });
  it("maps a question to question", async () => {
    mockParse.mockResolvedValue("question");
    expect(await classifyAwaitingReply("how long does it take?", "finish the Checkr form")).toBe("question");
  });
  it("maps anything else to other", async () => {
    mockParse.mockResolvedValue("other");
    expect(await classifyAwaitingReply("can you send the link again", "finish the Checkr form")).toBe("other");
  });
  it("falls back to other on an unexpected classifier reply", async () => {
    mockParse.mockResolvedValue("banana");
    expect(await classifyAwaitingReply("hm", "finish the Checkr form")).toBe("other");
  });
  it("falls back to other when the classifier errors", async () => {
    mockParse.mockRejectedValueOnce(new Error("down"));
    expect(await classifyAwaitingReply("thanks", "finish the Checkr form")).toBe("other");
  });
});

describe("runStep", () => {
  it("answers a mid-flow question and re-asks WITHOUT parsing", async () => {
    mockParse.mockResolvedValue("YES");           // isQuestionOrOther → question
    mockQuick.mockResolvedValue("Your rate is what families pay you per hour.");
    const parse = vi.fn();
    const res = await runStep({
      text: "what's a rate?",
      currentQuestion: "What's your hourly rate?",
      reAsk: "So — what's your hourly rate?",
      parse,
      ack: () => "unused",
    });
    expect(res.status).toBe("question");
    expect(parse).not.toHaveBeenCalled();
    expect(res.reply).toContain("So — what's your hourly rate?");
  });

  it("parses + acknowledges a direct answer", async () => {
    mockParse.mockResolvedValue("NO");            // isQuestionOrOther → answer
    const res = await runStep({
      text: "$25",
      currentQuestion: "What's your hourly rate?",
      parse: (t) => Number(t.replace(/\D/g, "")),
      ack: (v) => `Got it — $${v}/hr.`,
    });
    expect(res.status).toBe("answered");
    if (res.status === "answered") {
      expect(res.value).toBe(25);
      expect(res.reply).toBe("Got it — $25/hr.");
    }
  });
});
