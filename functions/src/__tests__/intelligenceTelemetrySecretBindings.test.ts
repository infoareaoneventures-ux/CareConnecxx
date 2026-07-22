import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

// Binding manifest test (U0/KTD24): every source file that computes an
// intelligence telemetry pseudonym must bind the dedicated secret on its
// deployed function(s) via runWith({ secrets: [INTELLIGENCE_TELEMETRY_KEY_SECRET] })
// or be a declared library module whose exported deployed consumers are listed
// here. A consumer that forgets the binding gets an unbound key at runtime,
// which fails closed — this test catches it at build time instead of by
// dropping telemetry in production.

const SRC_ROOT = path.resolve(__dirname, "..");

// Library modules that call the pseudonym helpers but are not themselves
// deployed functions. Each entry must name the deployed consumer(s) that
// carry the secret binding on its behalf. Keep this list SHORT and reviewed.
const LIBRARY_ALLOWLIST: Record<string, string[]> = {
  // U9 intake library. Deployed consumers listed here MUST bind
  // INTELLIGENCE_TELEMETRY_KEY_SECRET via runWith({ secrets: [...] }).
  "evals/evalCandidateQueue.ts": [
    "admin/reviewProactiveDraft.ts (v1-reviewProactiveDraft — binds the secret; rejection path submits candidates)",
  ],
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "lib") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("intelligence telemetry secret bindings (U0/KTD24)", () => {
  const files = walk(SRC_ROOT);

  const consumers = files.filter((f) => {
    const rel = path.relative(SRC_ROOT, f).replace(/\\/g, "/");
    if (rel === "observability/intelligencePseudonym.ts") return false; // the module itself
    const content = fs.readFileSync(f, "utf8");
    return /\b(intelligencePseudonym|tryIntelligencePseudonym)\s*\(/.test(content);
  });

  it("every pseudonym consumer binds INTELLIGENCE_TELEMETRY_KEY_SECRET or is an allowlisted library", () => {
    const unbound: string[] = [];
    for (const f of consumers) {
      const rel = path.relative(SRC_ROOT, f).replace(/\\/g, "/");
      const content = fs.readFileSync(f, "utf8");
      const binds = content.includes("INTELLIGENCE_TELEMETRY_KEY_SECRET");
      if (!binds && !(rel in LIBRARY_ALLOWLIST)) unbound.push(rel);
    }
    expect(unbound, `Consumers missing the secret binding (add runWith({ secrets: [INTELLIGENCE_TELEMETRY_KEY_SECRET] }) or an allowlist entry with its bound deployed consumer): ${unbound.join(", ")}`).toEqual([]);
  });

  it("allowlist entries are real files that still consume the helper", () => {
    for (const rel of Object.keys(LIBRARY_ALLOWLIST)) {
      const full = path.join(SRC_ROOT, rel);
      expect(fs.existsSync(full), `${rel} in LIBRARY_ALLOWLIST no longer exists`).toBe(true);
      const content = fs.readFileSync(full, "utf8");
      expect(
        /\b(intelligencePseudonym|tryIntelligencePseudonym)\s*\(/.test(content),
        `${rel} no longer consumes the pseudonym helper — remove it from LIBRARY_ALLOWLIST`,
      ).toBe(true);
    }
  });

  it("the dedicated key is never computed with the memory fingerprint secret", () => {
    for (const f of consumers) {
      const content = fs.readFileSync(f, "utf8");
      expect(
        content.includes("MEMORY_FINGERPRINT_KEY"),
        `${path.relative(SRC_ROOT, f)} mixes memory fingerprint key material into intelligence telemetry (KTD24)`,
      ).toBe(false);
    }
  });
});
