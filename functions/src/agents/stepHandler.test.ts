import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/parseWithClaude", () => ({ parseWithClaude: vi.fn() }));
vi.mock("../utils/openaiClient", () => ({ quickComplete: vi.fn() }));

import { runStep, isQuestionOrOther } from "./stepHandler";
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
