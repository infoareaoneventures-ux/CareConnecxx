import { describe, it, expect } from "vitest";
import { withToolsCacheControl } from "./toolCache";

describe("withToolsCacheControl", () => {
  it("adds an ephemeral cache breakpoint to the LAST tool only", () => {
    const tools = [{ name: "a" }, { name: "b" }, { name: "c" }];
    const out = withToolsCacheControl(tools);
    expect((out[0] as any).cache_control).toBeUndefined();
    expect((out[1] as any).cache_control).toBeUndefined();
    expect((out[2] as any).cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not mutate the input array or its objects", () => {
    const tools = [{ name: "a" }, { name: "b" }];
    const out = withToolsCacheControl(tools);
    expect((tools[1] as any).cache_control).toBeUndefined();
    expect(out).not.toBe(tools);
  });

  it("returns the input unchanged when empty", () => {
    const empty: Record<string, unknown>[] = [];
    expect(withToolsCacheControl(empty)).toBe(empty);
  });
});
