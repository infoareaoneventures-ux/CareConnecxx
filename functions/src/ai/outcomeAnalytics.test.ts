import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

// U7 guard (plan 2026-07-18-001, R36/KTD14): hired|rejected outcome aggregates
// are funnel/offline evidence ONLY. This source-scan makes the restriction a
// build invariant: no user-facing ranking module may import outcomeAnalytics.

const SRC = path.resolve(__dirname, "..");

const RANKING_MODULES = [
  "aiMatching.ts",
  "agents/matchingAgent.ts",
  "ai/matchJob.ts",
];

describe("outcome-label boundary (U7/R36/KTD14)", () => {
  it("no user-facing ranking module imports outcomeAnalytics", () => {
    for (const rel of RANKING_MODULES) {
      const full = path.join(SRC, rel);
      if (!fs.existsSync(full)) continue;
      const content = fs.readFileSync(full, "utf8");
      const imports = content.split("\n").filter((l) =>
        /^\s*import\b.*outcomeAnalytics/.test(l) || /await import\(.*outcomeAnalytics/.test(l));
      expect(imports, `${rel} imports outcomeAnalytics — hired/rejected may not feed ranking`).toEqual([]);
    }
  });

  it("getMatchPatterns callable returns no outcome data to frontend prompts", () => {
    const content = fs.readFileSync(path.join(SRC, "index.ts"), "utf8");
    const start = content.indexOf("export const getMatchPatterns");
    expect(start).toBeGreaterThan(-1);
    const body = content.slice(start, content.indexOf("});", start));
    expect(body).not.toContain("getOutcomePatternSummary");
    expect(body).toContain('patterns: ""');
  });

  it("the summary API demands an explicit offline_funnel purpose literal", () => {
    const content = fs.readFileSync(path.join(SRC, "ai/outcomeAnalytics.ts"), "utf8");
    expect(content).toContain('purpose: "offline_funnel"');
  });
});
