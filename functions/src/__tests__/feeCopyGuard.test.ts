// Source-scan guard for money claims (founder, 2026-09-19): every page and every
// Evia text must describe the fees as they are — a 9% service fee (min $1) paid
// by the family, caregivers keep 100% of their rate, daily payouts free, instant
// payouts carry Stripe's 1% fee. The phrases below were each live on the site at
// some point and each was wrong; none may come back.
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const REPO = path.resolve(__dirname, "../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (name !== "node_modules" && name !== "lib" && name !== "dist") walk(p, out); }
    else if (/\.(tsx?|md)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

// Code comments may explain history ("was 1.5%", "free before that"); the guard
// reads only what can reach a person: everything except // and * comment lines.
function visibleText(file: string): string {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [/nominal (platform |service )?fee/i, "the fee is 9%, not 'nominal'"],
  [/no hidden fees/i, "state the fee instead"],
  [/free instant payout|instant payouts? (is|are) free|instant cash-out: free|also free\b/i, "instant payouts carry Stripe's 1% fee"],
  [/keep 100% of every booking|we never take a cut/i, "families pay the fee; say 'keep 100% of your rate'"],
  [/GPS (shift |time )?(verification|tracking|monitoring)/i, "no shift location capture yet"],
  [/premium membership|pay-as-you-go/i, "one plan only"],
  [/7-day support|24\/7 (customer |dedicated |emergency )?support\b/i, "no one is on call — 'Evia text support, 24/7'"],
  [/protection fee|premium protection/i, "it is a service fee — no refunds or insurance implied"],
  [/fully refunded|full refund|50% refund/i, "nothing is charged for a visit that did not happen; no refunds"],
  [/1\.5% platform fee|\$0\.50 minimum service/i, "the old rate"],
];

const SCOPES = [
  path.join(REPO, "components"),
  path.join(REPO, "functions", "src", "agents"),
  path.join(REPO, "functions", "src", "mcp"),
  path.join(REPO, "functions", "src", "billing"),
  path.join(REPO, "functions", "src", "linq"),
];

describe("money claims match what is charged (source scan)", () => {
  const files = SCOPES.flatMap((d) => (fs.existsSync(d) ? walk(d) : []))
    // The admin panel is internal; legacy docs are dated records.
    .filter((f) => !f.includes(`${path.sep}components${path.sep}admin${path.sep}`));
  it("scans a real set of files", () => {
    expect(files.length).toBeGreaterThan(50);
  });
  for (const [re, why] of FORBIDDEN) {
    it(`no visible text matches ${re}`, () => {
      const hits = files.filter((f) => re.test(visibleText(f))).map((f) => path.relative(REPO, f));
      expect(hits, `${why}: ${hits.join(", ")}`).toEqual([]);
    });
  }
});
