import { describe, expect, it } from "vitest";

import { selectToolPack, MIN_PACK_SIZE } from "./toolPackSelector";
import { CORE_TOOL_NAMES, TOOL_CAPABILITIES } from "./toolCapabilities";

// Build a realistic surface from the REAL registry: all core tools plus a
// spread of capability-tagged tools, so the test breaks if the registry moves.
const tagged = Object.keys(TOOL_CAPABILITIES);
const surface = [...CORE_TOOL_NAMES, ...tagged].map((name) => ({ name }));

describe("selectToolPack (U6/R28-R29 — fail-open narrowing)", () => {
  it("narrows a broad turn using the foreground objective's intent", () => {
    const pack = selectToolPack(surface, { intent: "QUESTION" as never, foregroundIntent: "legacy.booking" });
    expect(pack).not.toBeNull();
    expect(pack!.packName).toBe("objective:legacy.booking");
    expect(pack!.tools.length).toBeGreaterThanOrEqual(MIN_PACK_SIZE);
    expect(pack!.tools.length).toBeLessThan(surface.length);
    // Core tools always survive.
    for (const core of CORE_TOOL_NAMES) {
      expect(pack!.tools.some((t) => t.name === core)).toBe(true);
    }
    // A billing-only tool is excluded from a booking pack.
    const billingOnly = tagged.find((n) => {
      const caps = TOOL_CAPABILITIES[n];
      return caps.length === 1 && caps[0] === "billing";
    });
    if (billingOnly) expect(pack!.tools.some((t) => t.name === billingOnly)).toBe(false);
  });

  it("returns null for specific intents — the legacy filter owns those", () => {
    expect(selectToolPack(surface, { intent: "REBOOK_REQUEST" as never, foregroundIntent: "legacy.booking" })).toBeNull();
  });

  it("returns null with no foreground objective or an unknown objective intent", () => {
    expect(selectToolPack(surface, { intent: null, foregroundIntent: null })).toBeNull();
    expect(selectToolPack(surface, { intent: null, foregroundIntent: "mystery.thing" })).toBeNull();
  });

  it("fails open when the pack would be suspiciously small", () => {
    const tiny = [...CORE_TOOL_NAMES].slice(0, 3).map((name) => ({ name }));
    expect(selectToolPack(tiny, { intent: null, foregroundIntent: "legacy.booking" })).toBeNull();
  });

  it("unmapped tools are safely included (KTD12 fail-closed gate comes later)", () => {
    const withUnmapped = [...surface, { name: "some_future_unmapped_tool" }];
    const pack = selectToolPack(withUnmapped, { intent: null, foregroundIntent: "legacy.booking" });
    expect(pack!.tools.some((t) => t.name === "some_future_unmapped_tool")).toBe(true);
  });
});
