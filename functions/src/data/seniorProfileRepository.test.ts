// U6 (R17/KTD12): canonical-first senior profile read order — senior_profiles
// wins whenever it exists; legacy `seniors` is consulted only when canonical is
// absent; neither → {null, "none"}. Plus a source scan pinning that every
// Evia senior-context read site (qaAgent full/quick, Linq prefetch writer, MCP
// get_senior_profile) routes through this repository instead of hand-rolling
// its own read order.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { getSeniorProfileWithSource } from "./seniorProfileRepository";

// Minimal injectable Firestore fake — records every doc read so tests can
// assert canonical-first ordering (legacy is not even fetched on a canonical hit).
function makeDb(docs: Record<string, Record<string, unknown>>) {
  const reads: string[] = [];
  const db = {
    collection: (coll: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const p = `${coll}/${id}`;
          reads.push(p);
          return { exists: p in docs, data: () => docs[p] };
        },
      }),
    }),
  } as any;
  return { db, reads };
}

describe("getSeniorProfileWithSource — read order", () => {
  it("returns canonical data with source senior_profiles when only canonical exists", async () => {
    const { db } = makeDb({ "senior_profiles/s1": { name: "Mary", location: "San Jose" } });
    const r = await getSeniorProfileWithSource("s1", db);
    expect(r.source).toBe("senior_profiles");
    expect(r.profile?.name).toBe("Mary");
  });

  it("falls back to legacy seniors with source seniors when canonical is absent", async () => {
    const { db, reads } = makeDb({ "seniors/s1": { name: "Mary", primaryDoctor: "Dr. Patel" } });
    const r = await getSeniorProfileWithSource("s1", db);
    expect(r.source).toBe("seniors");
    expect(r.profile?.primaryDoctor).toBe("Dr. Patel");
    // Canonical was still checked first.
    expect(reads).toEqual(["senior_profiles/s1", "seniors/s1"]);
  });

  it("canonical wins when both exist and conflict — legacy is not even read", async () => {
    const { db, reads } = makeDb({
      "senior_profiles/s1": { name: "Mary", location: "Sacramento", age: 82 },
      "seniors/s1":         { name: "Mary", location: "San Jose",   age: 78 },
    });
    const r = await getSeniorProfileWithSource("s1", db);
    expect(r.source).toBe("senior_profiles");
    expect(r.profile?.location).toBe("Sacramento");
    expect(r.profile?.age).toBe(82);
    expect(reads).toEqual(["senior_profiles/s1"]);
  });

  it("returns {null, none} when neither store has the senior", async () => {
    const { db, reads } = makeDb({});
    const r = await getSeniorProfileWithSource("ghost", db);
    expect(r.profile).toBeNull();
    expect(r.source).toBe("none");
    expect(reads).toEqual(["senior_profiles/ghost", "seniors/ghost"]);
  });

  it("returns {null, none} for an empty seniorId without touching Firestore", async () => {
    const { db, reads } = makeDb({ "senior_profiles/": { name: "never" } });
    const r = await getSeniorProfileWithSource("", db);
    expect(r.profile).toBeNull();
    expect(r.source).toBe("none");
    expect(reads).toEqual([]);
  });

  it("resolves a migrated household senior stored under a random canonical doc ID", async () => {
    // migrateSeniorsToHousehold mints random-ID senior_profiles docs with a
    // clientId back-reference and no matching legacy `seniors` doc. (Cross-
    // household DENIAL for such IDs stays with the caller's authorization
    // boundary — pinned by mcp/__tests__/seniorIsolation.test.ts.)
    const { db } = makeDb({ "senior_profiles/random-id": { clientId: "c1", name: "Mary" } });
    const r = await getSeniorProfileWithSource("random-id", db);
    expect(r.source).toBe("senior_profiles");
    expect(r.profile?.clientId).toBe("c1");
  });
});

// ── Call-site source scan (R17) ───────────────────────────────────────────────
// qaAgent (full + quick + prefetch-miss), the Linq prefetch WRITER, and MCP's
// get_senior_profile must all share this repository's read order. A direct
// `collection("seniors")` read creeping back into any of these files would
// silently reintroduce the prefetch-HIT/MISS split-brain this unit fixed.
describe("U6 source scan — one read order for Evia senior context", () => {
  const SRC_ROOT = path.resolve(__dirname, "..");
  const read = (rel: string) => fs.readFileSync(path.join(SRC_ROOT, rel), "utf8");

  it("qaAgent routes its senior reads through the repository (no direct seniors/senior_profiles doc reads)", () => {
    const src = read("agents/qaAgent.ts");
    expect(src).toMatch(/import\s*\{[^}]*\bgetSeniorProfileWithSource\b[^}]*\}\s*from\s*"\.\.\/data\/seniorProfileRepository"/);
    expect([...src.matchAll(/\bgetSeniorProfileWithSource\s*\(/g)].length).toBeGreaterThanOrEqual(1);
    expect(src).not.toMatch(/collection\(\s*["']seniors["']\s*\)/);
    // Both the full path and the quick path load the profile via getSeniorProfile.
    expect([...src.matchAll(/\bgetSeniorProfile\s*\(/g)].length).toBeGreaterThanOrEqual(3); // def + full + quick
  });

  it("quick path pins the signup snapshot beneath the canonical profile, for both roles", () => {
    const src = read("agents/qaAgent.ts");
    // describeSharedProfile must receive the canonical profile so the signup
    // snapshot cannot contradict newer canonical fields (KTD12 / authority
    // order) — seniorProfile on the client side, cgProfile (a live
    // caregivers/{id} read) on the caregiver side. Bounded, non-greedy match
    // to the call's closing paren so this doesn't accidentally match unrelated
    // later code.
    const call = src.match(/describeSharedProfile\(\s*session[\s\S]*?\);/);
    expect(call).toBeTruthy();
    expect(call![0]).toMatch(/\bseniorProfile\b/);
    expect(call![0]).toMatch(/\bcgProfile\b/);
  });

  it("Linq prefetch writer caches the repository read (canonical-first with legacy fallback)", () => {
    const src = read("linq/webhooks.ts");
    expect(src).toMatch(/import\s*\{[^}]*\bgetSeniorProfileWithSource\b[^}]*\}\s*from\s*"\.\.\/data\/seniorProfileRepository"/);
    expect([...src.matchAll(/\bgetSeniorProfileWithSource\s*\(/g)].length).toBeGreaterThanOrEqual(1);
  });

  it("MCP get_senior_profile uses the repository behind its authorization gate", () => {
    const src = read("mcp/server.ts");
    expect(src).toMatch(/import\s*\{[^}]*\bgetSeniorProfileWithSource\b[^}]*\}\s*from\s*"\.\.\/data\/seniorProfileRepository"/);
    expect([...src.matchAll(/\bgetSeniorProfileWithSource\s*\(/g)].length).toBeGreaterThanOrEqual(1);
    // No hand-rolled canonical/legacy fallback chain left in the tool body.
    expect(src).not.toMatch(/collection\(\s*["']seniors["']\s*\)/);
  });
});
