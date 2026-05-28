import { describe, it, expect, vi } from "vitest";
import { runAugmenters, type AugmenterContext, type PromptAugmenter } from "./promptAugmenters";
import { createTurnMetrics } from "./turnMetrics";

const baseCtx = (over: Partial<AugmenterContext> = {}): AugmenterContext => ({
  text:      "hi",
  phone:     "+15555550100",
  userId:    "u-1",
  seniorId:  "s-1",
  userType:  "client",
  turnCount: 0,
  metrics:   createTurnMetrics({ phone: "+15555550100", userType: "client", pathway: "qa" }),
  ...over,
});

describe("runAugmenters", () => {
  it("returns the base prompt unchanged when no augmenters fire", async () => {
    const result = await runAugmenters("BASE", [], baseCtx());
    expect(result.systemPrompt).toBe("BASE");
    expect(result.applied).toEqual([]);
  });

  it("appends directive blocks separated by double newlines, in order", async () => {
    const a: PromptAugmenter = { name: "a", augment: () => "first" };
    const b: PromptAugmenter = { name: "b", augment: () => "second" };
    const result = await runAugmenters("BASE", [a, b], baseCtx());
    expect(result.systemPrompt).toBe("BASE\n\nfirst\n\nsecond");
    expect(result.applied).toEqual(["a", "b"]);
  });

  it("skips augmenters whose predicate returns false", async () => {
    const a: PromptAugmenter = { name: "a", predicate: () => false, augment: () => "first" };
    const b: PromptAugmenter = { name: "b", augment: () => "second" };
    const result = await runAugmenters("BASE", [a, b], baseCtx());
    expect(result.systemPrompt).toBe("BASE\n\nsecond");
    expect(result.applied).toEqual(["b"]);
  });

  it("treats null / empty return as 'no directive'", async () => {
    const a: PromptAugmenter = { name: "a", augment: () => null };
    const b: PromptAugmenter = { name: "b", augment: () => "" };
    const c: PromptAugmenter = { name: "c", augment: () => "   " };
    const d: PromptAugmenter = { name: "d", augment: () => "real" };
    const result = await runAugmenters("BASE", [a, b, c, d], baseCtx());
    expect(result.systemPrompt).toBe("BASE\n\nreal");
    expect(result.applied).toEqual(["d"]);
  });

  it("supports async augmenters", async () => {
    const a: PromptAugmenter = { name: "a", augment: async () => "async" };
    const result = await runAugmenters("BASE", [a], baseCtx());
    expect(result.systemPrompt).toBe("BASE\n\nasync");
    expect(result.applied).toEqual(["a"]);
  });

  it("isolates a throwing predicate — pipeline continues", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a: PromptAugmenter = { name: "boom", predicate: () => { throw new Error("nope"); }, augment: () => "x" };
    const b: PromptAugmenter = { name: "b", augment: () => "ok" };
    const result = await runAugmenters("BASE", [a, b], baseCtx());
    expect(result.systemPrompt).toBe("BASE\n\nok");
    expect(result.applied).toEqual(["b"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("isolates a throwing augment — pipeline continues", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a: PromptAugmenter = { name: "boom", augment: () => { throw new Error("nope"); } };
    const b: PromptAugmenter = { name: "b", augment: () => "ok" };
    const result = await runAugmenters("BASE", [a, b], baseCtx());
    expect(result.systemPrompt).toBe("BASE\n\nok");
    expect(result.applied).toEqual(["b"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("trims leading / trailing whitespace from directives", async () => {
    const a: PromptAugmenter = { name: "a", augment: () => "\n  padded  \n\n" };
    const result = await runAugmenters("BASE", [a], baseCtx());
    expect(result.systemPrompt).toBe("BASE\n\npadded");
  });

  it("passes the context to each augmenter so they can branch on it", async () => {
    const seen: Array<{ name: string; userId: string; userType: string }> = [];
    const a: PromptAugmenter = {
      name: "client-only",
      predicate: (c) => c.userType === "client",
      augment: (c) => { seen.push({ name: "a", userId: c.userId, userType: c.userType }); return "X"; },
    };
    const b: PromptAugmenter = {
      name: "caregiver-only",
      predicate: (c) => c.userType === "caregiver",
      augment: (c) => { seen.push({ name: "b", userId: c.userId, userType: c.userType }); return "Y"; },
    };
    const result = await runAugmenters("BASE", [a, b], baseCtx({ userId: "u-9" }));
    expect(result.applied).toEqual(["client-only"]);
    expect(seen).toEqual([{ name: "a", userId: "u-9", userType: "client" }]);
  });
});
