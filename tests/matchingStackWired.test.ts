import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// U14 — the "deletion test" for the matching stack.
//
// History: the 2026-06-21 architecture review suspected mlMatchScoring was dead
// code; a consumer was found (components/ClientDashboard.tsx) and the wiring was
// pinned here. The 2026-07-02 entry-point reachability audit showed that consumer
// was itself unreachable (App routes to components/client/ClientDashboard, not the
// top-level file), so mlMatchScoring and its dead consumer chain were removed —
// see docs/dead-code-removal-2026-07-02.md. This guard now pins the live wiring
// (matchService, aiMatchingService, matchingEngine via api.ts) and tombstones the
// removed module: if mlMatchScoring is ever reintroduced it must arrive with a
// real, reachable consumer.

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

  it("mlMatchScoring stays deleted unless it gains a real consumer (tombstone)", () => {
    const exists = fs.existsSync(path.join(ROOT, "services/mlMatchScoring.ts"));
    if (exists) {
      expect(importsOf("mlMatchScoring").map((s) => s.file).length).toBeGreaterThan(0);
    } else {
      expect(importsOf("mlMatchScoring").length).toBe(0);
    }
  });

  it("matchService and aiMatchingService each have real consumers", () => {
    expect(importsOf("matchService").length).toBeGreaterThan(0);
    expect(importsOf("aiMatchingService").length).toBeGreaterThan(0);
  });

  it("dbService.getMatches resolves to a real matchingEngine module", () => {
    expect(fs.existsSync(path.join(ROOT, "services/server/matchingEngine.ts"))).toBe(true);
    // matchingEngine is consumed via the dynamic import in api.ts (getMatches).
    // Its former external caller (useSmartMatch) was removed 2026-07-02 as
    // unreachable; api.ts itself is the pinned consumer now.
    const apiText = all.find((s) => s.file.endsWith("api.ts"))?.text ?? "";
    expect(apiText).toMatch(/import\(['"]\.\/server\/matchingEngine['"]\)/);
  });
});
