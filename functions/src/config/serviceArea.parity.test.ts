import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SANTA_CLARA_COUNTY_CITIES, SANTA_CLARA_COUNTY_ZIPS } from "./serviceArea";

// The site's wizard now enforces the same Santa Clara County check Evia's
// onboarding does (2026-09-23). The site cannot import functions code, so
// utils/serviceArea.ts is a hand-kept mirror — this test keeps the two sets equal.
describe("service area — site mirror matches the backend", () => {
  const siteSrc = readFileSync(resolve(__dirname, "../../../utils/serviceArea.ts"), "utf8");
  const quoted = (block: string) => new Set(Array.from(block.matchAll(/'([^']+)'/g)).map((m) => m[1]));
  const section = (name: string) => {
    const start = siteSrc.indexOf(`export const ${name}`);
    const end = siteSrc.indexOf("]);", start);
    return siteSrc.slice(start, end);
  };

  it("ZIP codes are identical", () => {
    expect(quoted(section("SANTA_CLARA_COUNTY_ZIPS"))).toEqual(new Set(SANTA_CLARA_COUNTY_ZIPS));
  });

  it("city names are identical", () => {
    expect(quoted(section("SANTA_CLARA_COUNTY_CITIES"))).toEqual(new Set(SANTA_CLARA_COUNTY_CITIES));
  });
});
