// U5 — source-scan guard for display-price and bg-check-timing literals (R7, R8).
//
// Mirrors the parity.test.ts technique: read the source text directly so a
// re-typed "$54.99" or a resurrected "1–3 days" promise fails the build
// instead of drifting silently into a prompt. Display prices come ONLY from
// config/pricing.ts; background-check timing is never promised ("Evia texts
// you the moment it clears" is the sanctioned shape).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

const SRC_ROOT = resolve(__dirname, "..");

// Files the 2026-07-17 audit found hand-typed price literals in — must stay at
// zero hits (comments included; comments are where the next literal gets
// copy-pasted from).
const PRICE_GUARDED_FILES = [
  "agents/onboardingConversation.ts",
  "agents/caregiverOnboardingDirective.ts",
  "mcp/server.ts",
  "scheduled/staleSessionNudge.ts",
];
const PRICE_LITERALS = ["$29.95", "$54.99", "$11.50"];

// Both hyphen forms, built by join so this file never matches its own scan.
const TIMING_PHRASES = [
  ["1", "3 days"].join("–"), // en dash: 1–3 days
  ["1", "3 days"].join("-"),      // plain hyphen: 1-3 days
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "lib") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|md)$/.test(name)) out.push(full);
  }
  return out;
}

describe("display-price literals live only in config/pricing.ts (R7)", () => {
  for (const rel of PRICE_GUARDED_FILES) {
    it(`${rel} contains no hand-typed display price`, () => {
      const text = readFileSync(join(SRC_ROOT, rel), "utf8");
      for (const literal of PRICE_LITERALS) {
        expect(text.includes(literal), `${rel} contains "${literal}" — interpolate from config/pricing.ts instead`).toBe(false);
      }
    });
  }

  it("config/pricing.ts itself still owns the three canonical amounts", () => {
    const text = readFileSync(join(SRC_ROOT, "config/pricing.ts"), "utf8");
    for (const literal of PRICE_LITERALS) {
      expect(text.includes(literal), `pricing.ts lost "${literal}"`).toBe(true);
    }
  });
});

describe("no background-check timing promise anywhere in functions/src (R8)", () => {
  it('contains no "1–3 days" / "1-3 days" in any source, prompt, or doc file', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (resolve(file) === resolve(__filename)) continue; // this guard describes the phrases
      const text = readFileSync(file, "utf8");
      if (TIMING_PHRASES.some((p) => text.includes(p))) offenders.push(file);
    }
    expect(offenders, `bg-check timing promises found in: ${offenders.join(", ")} — say "Evia texts you the moment it clears" instead`).toEqual([]);
  });
});
