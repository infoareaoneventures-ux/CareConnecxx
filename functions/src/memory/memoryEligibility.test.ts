// Memory eligibility precursor (plan 2026-07-22-002 U4; grows in U10).
//
// The critical assertions here are the SENIOR PARITY rows: every session
// shape the live senior paths produce must stay eligible, or wiring the
// predicate into webhooks.ts would silently strip senior memory.

import { describe, it, expect } from "vitest";
import {
  decideMemoryEligibility,
  isMemoryEligible,
  logMemoryDenial,
  buildMemoryExclusionStamp,
  isMemoryExcludedRow,
  MEMORY_ELIGIBILITY_POLICY_VERSION,
} from "./memoryEligibility";

describe("decideMemoryEligibility — senior parity (must stay eligible)", () => {
  it("web-bridge client session (classified at creation) is eligible", () => {
    const d = decideMemoryEligibility({
      userType: "client",
    });
    expect(d.eligible).toBe(true);
    expect(d.reason).toBe("senior_default_legacy");
    expect(d.policyVersion).toBe(MEMORY_ELIGIBILITY_POLICY_VERSION);
  });

  it("web-bridge caregiver session is eligible", () => {
    expect(isMemoryEligible({ userType: "caregiver" })).toBe(true);
  });

  it("secondary family-member session (userType client) is eligible", () => {
    expect(isMemoryEligible({ userType: "client" })).toBe(true);
  });

  it("pending-consent opt-in session (userType restored from users doc) is eligible", () => {
    expect(isMemoryEligible({ userType: "client", verticalIntent: null })).toBe(true);
  });

  it("explicit senior vertical stamp is eligible with senior_classified", () => {
    const d = decideMemoryEligibility({ userType: "client", careVertical: "senior" });
    expect(d).toMatchObject({ eligible: true, reason: "senior_classified" });
  });

  it("legacy admin-typed session (Hamse anomaly shape) stays eligible — classified role", () => {
    expect(isMemoryEligible({ userType: "admin" })).toBe(true);
  });

  it("extra unknown session fields are ignored (full session objects can be passed)", () => {
    expect(isMemoryEligible({
      userType: "client",
      onboardingStep: "complete",
      zepThreadId: "t1",
      chatId: "c1",
    } as never)).toBe(true);
  });
});

describe("decideMemoryEligibility — denials", () => {
  it("childcare vertical stamp is denied even with a classified role", () => {
    const d = decideMemoryEligibility({ userType: "client", careVertical: "child" });
    expect(d).toMatchObject({ eligible: false, reason: "childcare_vertical" });
  });

  it("childcare typed intent (verticalIntent) is denied", () => {
    const d = decideMemoryEligibility({ userType: "client", verticalIntent: "child" });
    expect(d).toMatchObject({ eligible: false, reason: "childcare_vertical" });
  });

  it("pending classification is denied", () => {
    const d = decideMemoryEligibility({ userType: "client", verticalIntent: "pending" });
    expect(d).toMatchObject({ eligible: false, reason: "pending_classification" });
  });

  it("unclassified cold-inbound session (userType null, no vertical) is denied", () => {
    const d = decideMemoryEligibility({ userType: null });
    expect(d).toMatchObject({ eligible: false, reason: "unclassified_session" });
  });

  it("empty session object is denied as unclassified", () => {
    expect(isMemoryEligible({})).toBe(false);
  });

  it("null / undefined session is denied with no_session", () => {
    expect(decideMemoryEligibility(null).reason).toBe("no_session");
    expect(decideMemoryEligibility(undefined).reason).toBe("no_session");
  });

  it("whitespace-only userType does not count as a classified role", () => {
    expect(isMemoryEligible({ userType: "  " })).toBe(false);
  });

  it("childcare stamp wins over senior stamp contradiction (fail closed)", () => {
    // Contradictory stamps should never be memory-eligible.
    const d = decideMemoryEligibility({ careVertical: "senior", verticalIntent: "child" });
    expect(d.eligible).toBe(false);
    expect(d.reason).toBe("childcare_vertical");
  });
});

describe("U10 full decision — per-subsystem map (R50/KTD17)", () => {
  it("eligible senior sessions are eligible for EVERY subsystem", () => {
    const d = decideMemoryEligibility({ userType: "client" });
    expect(d.subsystems).toEqual({
      zep: true,
      learnedFacts: true,
      conversationMemory: true,
      memoryFiles: true,
      summaries: true,
      evalCapture: true,
    });
  });

  it("childcare sessions are denied for EVERY subsystem — no partial capture", () => {
    const d = decideMemoryEligibility({ userType: "client", careVertical: "child" });
    expect(Object.values(d.subsystems).some(Boolean)).toBe(false);
  });

  it("unclassified sessions are denied for every subsystem (AE23)", () => {
    const d = decideMemoryEligibility({});
    expect(Object.values(d.subsystems).some(Boolean)).toBe(false);
  });

  it("AE22: caregiver session with active childcare context is fully denied", () => {
    const d = decideMemoryEligibility({ userType: "caregiver", childcareContextActive: true });
    expect(d.eligible).toBe(false);
    expect(d.reason).toBe("caregiver_childcare_context");
    expect(d.subsystems.learnedFacts).toBe(false);
    expect(d.subsystems.evalCapture).toBe(false);
    expect(d.subsystems.zep).toBe(false);
  });

  it("AE22 parity: caregiver session WITHOUT childcare context stays eligible", () => {
    const d = decideMemoryEligibility({ userType: "caregiver" });
    expect(d.eligible).toBe(true);
    // false/absent flag values never deny
    expect(isMemoryEligible({ userType: "caregiver", childcareContextActive: false })).toBe(true);
    expect(isMemoryEligible({ userType: "caregiver", childcareContextActive: null })).toBe(true);
  });

  it("childcare vertical outranks the caregiver context reason (deny-first ordering)", () => {
    const d = decideMemoryEligibility({
      userType: "caregiver",
      careVertical: "child",
      childcareContextActive: true,
    });
    expect(d.reason).toBe("childcare_vertical");
  });
});

describe("U10 exclusion stamp (immutable metadata on denied rows)", () => {
  it("builds the immutable stamp shape from a denial", () => {
    const d = decideMemoryEligibility({ careVertical: "child", userType: "client" });
    const now = new Date("2026-07-23T00:00:00.000Z");
    expect(buildMemoryExclusionStamp(d, now)).toEqual({
      memoryExcluded: true,
      reason: "childcare_vertical",
      policyVersion: MEMORY_ELIGIBILITY_POLICY_VERSION,
      decidedAt: "2026-07-23T00:00:00.000Z",
    });
  });

  it("isMemoryExcludedRow keys strictly on the boolean stamp", () => {
    expect(isMemoryExcludedRow({ memoryExcluded: true })).toBe(true);
    expect(isMemoryExcludedRow({ memoryExcluded: "true" })).toBe(false);
    expect(isMemoryExcludedRow({})).toBe(false);
    expect(isMemoryExcludedRow(null)).toBe(false);
  });

  it("retroactive-sync prohibition: a stamped row stays excluded even when the session reclassifies senior", () => {
    // The row-level stamp is the durable truth — a later senior-classified
    // session must not make old childcare rows eligible for backfill.
    const stamp = buildMemoryExclusionStamp(
      decideMemoryEligibility({ careVertical: "child", userType: "client" }),
    );
    const row = { role: "user", content: "x", ...stamp };
    const laterSession = { userType: "client", careVertical: "senior" };
    expect(decideMemoryEligibility(laterSession).eligible).toBe(true);
    expect(isMemoryExcludedRow(row)).toBe(true); // row exclusion is immutable
  });
});

describe("logMemoryDenial", () => {
  it("no-ops for eligible decisions", () => {
    // Must not throw and must not log — assert via spy-free smoke (no throw).
    logMemoryDenial("test_site", decideMemoryEligibility({ userType: "client" }));
  });

  it("emits a PII-free structured line for denials", () => {
    const lines: string[] = [];
    const orig = console.info;
    console.info = (msg?: unknown) => { lines.push(String(msg)); };
    try {
      logMemoryDenial("first_contact", decideMemoryEligibility({}));
    } finally {
      console.info = orig;
    }
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual({
      memory_denied: true,
      site: "first_contact",
      reason: "unclassified_session",
      policyVersion: MEMORY_ELIGIBILITY_POLICY_VERSION,
    });
  });
});
