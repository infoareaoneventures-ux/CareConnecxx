// Tests for the childcare go-live seeders (scripts/seed-childcare-flags.mjs).
//
// WHY THESE MATTER: verifyPrerequisites is the ONLY thing standing between a
// fumbled command and a childcare signup funnel that families can enter but not
// complete — enabled flags with no pricing means a family onboards, gets matched,
// and then cannot pay. Every case below is a way that guard could wrongly pass.
//
// The guard must fail CLOSED: any doubt about pricing or the jurisdiction policy
// means refuse to enable.

import { describe, it, expect } from "vitest";
import {
  parseOn,
  verifyPrerequisites,
  FlagArgError,
  ALL_FLAGS,
  FLAG_BY_ALIAS,
} from "../scripts/seed-childcare-flags.mjs";

const PRICING_REF_KEYS = [
  "familyEntitlementRef",
  "caregiverFeeRef",
  "screeningFeeRef",
  "siblingPolicyRef",
  "cancellationPolicyRef",
  "refundPolicyRef",
];

function completePricing(): Record<string, string> {
  return Object.fromEntries(PRICING_REF_KEYS.map((k) => [k, `ca-${k}-v1`]));
}

function goodPolicy(overrides: Record<string, unknown> = {}) {
  return {
    state: "CA",
    status: "configured",
    policyVersion: "CA-2026-07-22.1",
    approvedServiceCategories: ["babysitting", "nanny_care"],
    pricing: completePricing(),
    ...overrides,
  };
}

/**
 * Minimal Firestore stand-in. `docs` maps "collection/id" → data (absent key ⇒
 * the document does not exist), mirroring the real snapshot contract.
 */
function fakeDb(docs: Record<string, unknown>) {
  return {
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            async get() {
              const key = `${name}/${id}`;
              const data = docs[key];
              return { exists: data !== undefined, data: () => data };
            },
          };
        },
      };
    },
  };
}

/** A world where every prerequisite is satisfied. */
function healthyDocs(policy = goodPolicy()) {
  const docs: Record<string, unknown> = { "jurisdiction_care_policies/CA": policy };
  for (const id of Object.values(completePricing())) {
    docs[`childcare_pricing_configs/${id}`] = { kind: "x" };
  }
  return docs;
}

const ENABLING = ["CHILDCARE_ENABLED", "CHILDCARE_WRITES_ENABLED"];

describe("parseOn", () => {
  it("maps friendly aliases to real flag names", () => {
    expect(parseOn(["--on=enabled,writes"])).toEqual([
      "CHILDCARE_ENABLED",
      "CHILDCARE_WRITES_ENABLED",
    ]);
  });

  it("accepts full flag names too", () => {
    expect(parseOn(["--on=CHILDCARE_ENABLED"])).toEqual(["CHILDCARE_ENABLED"]);
  });

  it("'all' expands to every flag", () => {
    expect(parseOn(["--on=all"]).sort()).toEqual([...ALL_FLAGS].sort());
  });

  it("returns nothing when --on is absent (so a bare run enables nothing)", () => {
    expect(parseOn([])).toEqual([]);
    expect(parseOn(["--apply"])).toEqual([]);
  });

  it("throws on an unknown flag rather than silently dropping it", () => {
    // Silently ignoring a typo would enable LESS than intended, which reads as
    // "it didn't work" — or, worse in a longer list, MORE than reviewed.
    expect(() => parseOn(["--on=enabled,wrytes"])).toThrow(FlagArgError);
  });

  it("tolerates whitespace and empty segments", () => {
    expect(parseOn(["--on= enabled , writes ,"])).toEqual([
      "CHILDCARE_ENABLED",
      "CHILDCARE_WRITES_ENABLED",
    ]);
  });

  it("proactive is never implied — it must be asked for by name", () => {
    // Proactive outbound SMS is the one irreversible surface; a delivered text
    // cannot be recalled. It must never come along for the ride.
    for (const spec of ["enabled", "enabled,writes", "enabled,writes,discovery"]) {
      expect(parseOn([`--on=${spec}`])).not.toContain(FLAG_BY_ALIAS.proactive);
    }
    expect(parseOn(["--on=all"])).toContain(FLAG_BY_ALIAS.proactive);
  });
});

describe("verifyPrerequisites", () => {
  it("passes when policy + all six pricing refs + all config docs exist", async () => {
    expect(await verifyPrerequisites(fakeDb(healthyDocs()), ENABLING)).toEqual([]);
  });

  it("skips entirely when CHILDCARE_ENABLED is not being turned on", async () => {
    // Without the master flag nothing is reachable, so there is nothing to guard.
    const problems = await verifyPrerequisites(fakeDb({}), ["CHILDCARE_WRITES_ENABLED"]);
    expect(problems).toEqual([]);
  });

  it("refuses when the jurisdiction policy does not exist", async () => {
    const problems = await verifyPrerequisites(fakeDb({}), ENABLING);
    expect(problems.join(" ")).toMatch(/jurisdiction_care_policies\/CA does not exist/);
  });

  it("refuses a status other than 'configured'", async () => {
    for (const status of ["disabled", "active", "pending", ""]) {
      const problems = await verifyPrerequisites(
        fakeDb(healthyDocs(goodPolicy({ status }))),
        ENABLING,
      );
      expect(problems.join(" "), `status=${status}`).toMatch(/status/);
    }
  });

  it("refuses a missing policyVersion (caregivers could never accept the policy)", async () => {
    const policy = goodPolicy();
    delete (policy as Record<string, unknown>).policyVersion;
    const problems = await verifyPrerequisites(fakeDb(healthyDocs(policy)), ENABLING);
    expect(problems.join(" ")).toMatch(/policyVersion/);
  });

  it("refuses empty or non-array approvedServiceCategories", async () => {
    for (const categories of [[], undefined, "babysitting"]) {
      const problems = await verifyPrerequisites(
        fakeDb(healthyDocs(goodPolicy({ approvedServiceCategories: categories }))),
        ENABLING,
      );
      expect(problems.join(" "), `categories=${JSON.stringify(categories)}`)
        .toMatch(/approvedServiceCategories/);
    }
  });

  it("refuses when pricing is absent entirely", async () => {
    const policy = goodPolicy();
    delete (policy as Record<string, unknown>).pricing;
    const problems = await verifyPrerequisites(fakeDb(healthyDocs(policy)), ENABLING);
    expect(problems.join(" ")).toMatch(/pricing refs unset/);
  });

  it("names every individually missing pricing ref", async () => {
    for (const key of PRICING_REF_KEYS) {
      const pricing = completePricing();
      delete pricing[key];
      const problems = await verifyPrerequisites(
        fakeDb(healthyDocs(goodPolicy({ pricing }))),
        ENABLING,
      );
      expect(problems.join(" "), `missing ${key}`).toContain(key);
    }
  });

  it("treats null and whitespace-only refs as unset, not as present", async () => {
    for (const bad of [null, "", "   "]) {
      const problems = await verifyPrerequisites(
        fakeDb(healthyDocs(goodPolicy({ pricing: { ...completePricing(), refundPolicyRef: bad } }))),
        ENABLING,
      );
      expect(problems.join(" "), `ref=${JSON.stringify(bad)}`).toMatch(/refundPolicyRef/);
    }
  });

  it("refuses a DANGLING ref — set, but pointing at a config doc that doesn't exist", async () => {
    // The failure the dotted-key bug in seed-childcare-pricing.mjs would have
    // produced: refs look populated while the documents behind them are absent.
    const docs = healthyDocs();
    delete docs["childcare_pricing_configs/ca-cancellationPolicyRef-v1"];
    const problems = await verifyPrerequisites(fakeDb(docs), ENABLING);
    expect(problems.join(" ")).toMatch(/missing childcare_pricing_configs docs/);
    expect(problems.join(" ")).toContain("ca-cancellationPolicyRef-v1");
  });

  it("reports multiple independent problems in one pass", async () => {
    const problems = await verifyPrerequisites(
      fakeDb(healthyDocs(goodPolicy({ status: "disabled", approvedServiceCategories: [] }))),
      ENABLING,
    );
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});
