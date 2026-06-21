import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// U14 — the "deletion test" for the matching stack, resolved by verification.
//
// The 2026-06-21 architecture review SUSPECTED mlMatchScoring was dead code and
// that dbService.getMatches referenced a non-existent ./server/matchingEngine.
// Both were wrong: this guard pins the real wiring so the modules can't be
// deleted on a stale "looks unused" hunch, and so they can't silently lose
// their last consumer without a red test.

const ROOT = path.resolve(__dirname, "..");

function sources(dirs: string[]): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if ((e.name.endsWith(".ts") || e.name.endsWith(".tsx")) && !e.name.includes(".test.")) {
        out.push({ file: path.relative(ROOT, full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  dirs.forEach((d) => walk(path.join(ROOT, d)));
  return out;
}

describe("matching stack is wired (not dead code)", () => {
  const all = sources(["services", "components", "hooks"]);
  const importsOf = (mod: string) =>
    all.filter((s) => !s.file.endsWith(`${mod}.ts`) && new RegExp(`from ['"][^'"]*${mod}['"]`).test(s.text));

  it("mlMatchScoring has at least one real consumer", () => {
    // ClientDashboard.calculateMLMatchScore + trainingSimulation re-exports.
    expect(importsOf("mlMatchScoring").map((s) => s.file).length).toBeGreaterThan(0);
  });

  it("matchService and aiMatchingService each have real consumers", () => {
    expect(importsOf("matchService").length).toBeGreaterThan(0);
    expect(importsOf("aiMatchingService").length).toBeGreaterThan(0);
  });

  it("dbService.getMatches resolves to a real matchingEngine module", () => {
    expect(fs.existsSync(path.join(ROOT, "services/server/matchingEngine.ts"))).toBe(true);
    // and getMatches is actually consumed (useSmartMatch).
    const callers = all.filter((s) => /\.getMatches\(/.test(s.text) && !s.file.endsWith("api.ts"));
    expect(callers.length).toBeGreaterThan(0);
  });
});
