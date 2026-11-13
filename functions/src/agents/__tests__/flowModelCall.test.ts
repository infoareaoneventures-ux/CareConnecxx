import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Wave 2 (2026-11-09): the eight scripted flows share ONE model path (OpenAI first, Anthropic backup).
// This guard fails if a flow goes back to calling a single provider directly.

const quick = vi.hoisted(() => ({ fn: vi.fn(async (..._a: any[]) => "ok") }));
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => quick.fn(...a) }));
vi.mock("../../config/caraModels", () => ({ resolveCaraModelConfig: (tier: string) => ({ model: `model-for-${tier}`, provider: "openai" }) }));

import { flowParseCall, flowAnswerCall } from "../flowModelCall";

describe("flowModelCall", () => {
  it("parse calls go through quickComplete with the caller's allowance (router tier by default)", async () => {
    await flowParseCall("sys", "hello", 200);
    expect(quick.fn).toHaveBeenLastCalledWith("sys", "hello", { maxTokens: 200 });
  });

  it("answer calls use the quick-tier model", async () => {
    await flowAnswerCall("sys", "hello", 100);
    expect(quick.fn).toHaveBeenLastCalledWith("sys", "hello", { maxTokens: 100, model: "model-for-quick" });
  });
});

describe("no scripted flow calls a single provider directly", () => {
  const FLOWS = ["bookingFlow", "cancelFlow", "rescheduleFlow", "correctionFlow", "interviewFlow", "replacementFlow", "visitRequestFlow", "jobPostingFlow"];
  it.each(FLOWS)("%s.ts has no getSharedClient / messages.create call and uses the shared helper", (name) => {
    const src = fs.readFileSync(path.resolve(__dirname, `../${name}.ts`), "utf8");
    expect(src).not.toMatch(/getSharedClient\s*\(/);
    expect(src).not.toMatch(/\.messages\.create\s*\(/);
    expect(src).toMatch(/flowModelCall/);
  });
});
