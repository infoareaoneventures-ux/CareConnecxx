import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  realWorldHealthcareActionsEnabled,
  timesheetAutoApprovalEnabled,
  isRoutingShadowEnabled,
  isConvergenceFlipped,
  caraOutputGuardEnabled,
  outboundHistoryRecordEnabled,
  getChildcareFlags,
  getChildcareAppCheckConfig,
  bustChildcareFlagsCache,
  CHILDCARE_FLAGS_CACHE_TTL_MS,
} from "./featureFlags";

describe("realWorldHealthcareActionsEnabled (H-U9)", () => {
  afterEach(() => { delete process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS; });

  it("defaults OFF when the env var is unset", () => {
    delete process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS;
    expect(realWorldHealthcareActionsEnabled()).toBe(false);
  });
  it("is ON only when exactly 'true'", () => {
    process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS = "true";
    expect(realWorldHealthcareActionsEnabled()).toBe(true);
  });
  it("treats other values as OFF", () => {
    process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS = "1";
    expect(realWorldHealthcareActionsEnabled()).toBe(false);
    process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS = "yes";
    expect(realWorldHealthcareActionsEnabled()).toBe(false);
  });
});

describe("getChildcareAppCheckConfig", () => {
  beforeEach(() => {
    bustChildcareFlagsCache();
    delete process.env.CHILDCARE_APPCHECK_MODE;
  });
  afterEach(() => {
    bustChildcareFlagsCache();
    delete process.env.CHILDCARE_APPCHECK_MODE;
  });

  it("defaults to monitor and does not invent rollout proof", async () => {
    const { db } = makeFlagsDb({});
    await expect(getChildcareAppCheckConfig({ db })).resolves.toEqual({
      mode: "monitor",
      source: "default",
      transitionRecorded: false,
      transitionAt: null,
      providerRegistrationVerified: false,
      debugTokensAllowed: false,
      verifiedDomains: [],
    });
  });

  it("reads recorded enforcement state and normalizes Hosting domains", async () => {
    const { db } = makeFlagsDb({
      "childcare_flags/global": {
        CHILDCARE_APPCHECK_MODE: "enforce",
        CHILDCARE_APPCHECK_TRANSITION_AT: "2026-07-25T00:00:00.000Z",
        CHILDCARE_APPCHECK_PROVIDER_VERIFIED: true,
        CHILDCARE_APPCHECK_DEBUG_TOKENS_ALLOWED: false,
        CHILDCARE_APPCHECK_VERIFIED_DOMAINS: [
          " CareConnex-D4C8B.WEB.APP ",
          "careconnex-d4c8b.firebaseapp.com",
        ],
      },
    });
    await expect(getChildcareAppCheckConfig({ db })).resolves.toMatchObject({
      mode: "enforce",
      source: "firestore",
      transitionRecorded: true,
      providerRegistrationVerified: true,
      verifiedDomains: [
        "careconnex-d4c8b.web.app",
        "careconnex-d4c8b.firebaseapp.com",
      ],
    });
  });
});

describe("timesheetAutoApprovalEnabled", () => {
  afterEach(() => { delete process.env.TIMESHEET_AUTO_APPROVAL_ENABLED; });

  it("defaults OFF when the env var is unset", () => {
    delete process.env.TIMESHEET_AUTO_APPROVAL_ENABLED;
    expect(timesheetAutoApprovalEnabled()).toBe(false);
  });

  it("is ON only when exactly 'true'", () => {
    process.env.TIMESHEET_AUTO_APPROVAL_ENABLED = "true";
    expect(timesheetAutoApprovalEnabled()).toBe(true);
    process.env.TIMESHEET_AUTO_APPROVAL_ENABLED = "1";
    expect(timesheetAutoApprovalEnabled()).toBe(false);
  });
});

describe("routing convergence flags (U6/U10)", () => {
  afterEach(() => { delete process.env.ROUTING_CONVERGENCE_SHADOW; delete process.env.CONVERGENCE_FLIPPED; });

  it("shadow is off for every flow by default", () => {
    expect(isRoutingShadowEnabled("reminder_management")).toBe(false);
  });
  it("shadow is on only for flows listed (comma-separated, per-flow)", () => {
    process.env.ROUTING_CONVERGENCE_SHADOW = "reminder_management, modify_schedule";
    expect(isRoutingShadowEnabled("reminder_management")).toBe(true);
    expect(isRoutingShadowEnabled("modify_schedule")).toBe(true);
    expect(isRoutingShadowEnabled("refund")).toBe(false);
  });
  it("flip is off by default and on only for listed flows", () => {
    expect(isConvergenceFlipped("reminder_management")).toBe(false);
    process.env.CONVERGENCE_FLIPPED = "reminder_management";
    expect(isConvergenceFlipped("reminder_management")).toBe(true);
    expect(isConvergenceFlipped("refund")).toBe(false);
  });
});

// Hallucination hardening U1: KILL switch (default ON), not a launch gate —
// off only when the env var is exactly "false".
describe("caraOutputGuardEnabled (hallucination U1)", () => {
  afterEach(() => { delete process.env.CARA_OUTPUT_GUARD_ENABLED; });

  it("defaults ON when the env var is unset", () => {
    delete process.env.CARA_OUTPUT_GUARD_ENABLED;
    expect(caraOutputGuardEnabled()).toBe(true);
  });
  it("is OFF only when exactly 'false'", () => {
    process.env.CARA_OUTPUT_GUARD_ENABLED = "false";
    expect(caraOutputGuardEnabled()).toBe(false);
  });
  it("stays ON for any other value", () => {
    process.env.CARA_OUTPUT_GUARD_ENABLED = "true";
    expect(caraOutputGuardEnabled()).toBe(true);
    process.env.CARA_OUTPUT_GUARD_ENABLED = "0";
    expect(caraOutputGuardEnabled()).toBe(true);
  });
});

// Hallucination hardening U3: KILL switch (default ON), not a launch gate —
// off only when the env var is exactly "false".
describe("outboundHistoryRecordEnabled (hallucination U3)", () => {
  afterEach(() => { delete process.env.OUTBOUND_HISTORY_RECORD_ENABLED; });

  it("defaults ON when the env var is unset", () => {
    delete process.env.OUTBOUND_HISTORY_RECORD_ENABLED;
    expect(outboundHistoryRecordEnabled()).toBe(true);
  });
  it("is OFF only when exactly 'false'", () => {
    process.env.OUTBOUND_HISTORY_RECORD_ENABLED = "false";
    expect(outboundHistoryRecordEnabled()).toBe(false);
  });
  it("stays ON for any other value", () => {
    process.env.OUTBOUND_HISTORY_RECORD_ENABLED = "true";
    expect(outboundHistoryRecordEnabled()).toBe(true);
    process.env.OUTBOUND_HISTORY_RECORD_ENABLED = "0";
    expect(outboundHistoryRecordEnabled()).toBe(true);
  });
});

// NOTE: the ONBOARDING_AGENT_LOOP* canary-cohort tests were removed on 2026-07-08
// when the agent loop became the sole onboarding collection path (loop-only) and
// those flags were deleted. Routing is now unconditional — see
// onboardingContract.test.ts › shouldRouteOnboardingToLoop.

// U13 flip POLICY. Safety-critical assertion: onboarding (sole signup path)
// stays DARK by default — only job_posting / modify_schedule cut over by default.
describe("convergence flip policy (U13 default-flipped + kill switch)", () => {
  afterEach(() => { delete process.env.CONVERGENCE_FLIPPED; delete process.env.CONVERGENCE_UNFLIPPED; });

  it("flips job_posting and modify_schedule ON by default, holds onboarding DARK", () => {
    expect(isConvergenceFlipped("job_posting")).toBe(true);
    expect(isConvergenceFlipped("modify_schedule")).toBe(true);
    // onboarding stays DARK by default in the cara-100 ↔ caregiver-mvr merge:
    // combined-code parity isn't established and the KTD-6 eval was never run, so
    // the proven legacy step flow ships. Still flippable per-flow once re-validated.
    expect(isConvergenceFlipped("onboarding")).toBe(false);
    process.env.CONVERGENCE_FLIPPED = "onboarding";
    expect(isConvergenceFlipped("onboarding")).toBe(true);
    delete process.env.CONVERGENCE_FLIPPED;
  });
  it("CONVERGENCE_UNFLIPPED rolls back onboarding (and any default-on flow)", () => {
    process.env.CONVERGENCE_UNFLIPPED = "onboarding";
    expect(isConvergenceFlipped("onboarding")).toBe(false);     // rolled back
    expect(isConvergenceFlipped("job_posting")).toBe(true);     // others unaffected
  });
  it("CONVERGENCE_UNFLIPPED is a reversible kill switch for default-on flows", () => {
    process.env.CONVERGENCE_UNFLIPPED = "job_posting";
    expect(isConvergenceFlipped("job_posting")).toBe(false);
    expect(isConvergenceFlipped("modify_schedule")).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Childcare flags (childcare marketplace plan 2026-07-22-002, U1 / R61):
// Firestore-resident, runtime-flippable, FAIL-CLOSED (opt-in — the opposite
// default from the senior kill switches above). Absent doc/flag ⇒ OFF;
// emergencyOff force-falses everything without a redeploy; 60s TTL cache with
// an explicit bust hook.
// ═════════════════════════════════════════════════════════════════════════════

// Minimal injectable Firestore fake that counts reads (cache assertions).
function makeFlagsDb(docs: Record<string, Record<string, unknown>>) {
  const reads: string[] = [];
  const db = {
    collection: (coll: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const p = `${coll}/${id}`;
          reads.push(p);
          if (docs[p] instanceof Error) throw docs[p];
          return { exists: p in docs, data: () => docs[p] };
        },
      }),
    }),
  } as any;
  return { db, reads };
}

const ALL_ON = {
  CHILDCARE_ENABLED: true,
  CHILDCARE_DISCOVERY_ENABLED: true,
  CHILDCARE_WRITES_ENABLED: true,
  CHILDCARE_PROACTIVE_ENABLED: true,
};

describe("getChildcareFlags — fail-closed defaults (R61)", () => {
  beforeEach(() => bustChildcareFlagsCache());
  afterEach(() => bustChildcareFlagsCache());

  it("absent global doc ⇒ everything OFF", async () => {
    const { db } = makeFlagsDb({});
    expect(await getChildcareFlags({ db })).toEqual({
      enabled: false,
      discoveryEnabled: false,
      writesEnabled: false,
      proactiveEnabled: false,
      emergencyOff: false,
    });
  });

  it("absent flag fields ⇒ OFF (empty doc is not consent)", async () => {
    const { db } = makeFlagsDb({ "childcare_flags/global": {} });
    const f = await getChildcareFlags({ db });
    expect(f.enabled).toBe(false);
    expect(f.writesEnabled).toBe(false);
  });

  it("only exactly-true booleans count — truthy strings/numbers stay OFF", async () => {
    const { db } = makeFlagsDb({
      "childcare_flags/global": { CHILDCARE_ENABLED: "true", CHILDCARE_WRITES_ENABLED: 1 },
    });
    const f = await getChildcareFlags({ db });
    expect(f.enabled).toBe(false);
    expect(f.writesEnabled).toBe(false);
  });

  it("sub-capabilities are gated on the master flag", async () => {
    const { db } = makeFlagsDb({
      "childcare_flags/global": { CHILDCARE_ENABLED: false, CHILDCARE_DISCOVERY_ENABLED: true },
    });
    const f = await getChildcareFlags({ db });
    expect(f.enabled).toBe(false);
    expect(f.discoveryEnabled).toBe(false); // discovery true alone means nothing
  });

  it("global true flags turn the global scope on", async () => {
    const { db } = makeFlagsDb({ "childcare_flags/global": { ...ALL_ON } });
    expect(await getChildcareFlags({ db })).toEqual({
      enabled: true,
      discoveryEnabled: true,
      writesEnabled: true,
      proactiveEnabled: true,
      emergencyOff: false,
    });
  });

  it("a Firestore read error fails closed (all OFF) and is not cached", async () => {
    const boom: any = new Error("unavailable");
    const docs: Record<string, any> = { "childcare_flags/global": boom };
    const { db, reads } = makeFlagsDb(docs);
    expect((await getChildcareFlags({ db })).enabled).toBe(false);
    // Error was not cached: replacing the doc is visible on the very next call.
    docs["childcare_flags/global"] = { ...ALL_ON };
    expect((await getChildcareFlags({ db })).enabled).toBe(true);
    expect(reads.length).toBe(2);
  });
});

describe("getChildcareFlags — per-state overlay", () => {
  beforeEach(() => bustChildcareFlagsCache());
  afterEach(() => bustChildcareFlagsCache());

  it("state scope requires BOTH global and the state overlay (absent overlay ⇒ OFF)", async () => {
    const { db } = makeFlagsDb({ "childcare_flags/global": { ...ALL_ON } });
    const f = await getChildcareFlags({ db, state: "CA" });
    expect(f.enabled).toBe(false); // no CA overlay doc — the state is not on by implication
  });

  it("state overlay can only narrow global, never widen it", async () => {
    const { db } = makeFlagsDb({
      "childcare_flags/global": { CHILDCARE_ENABLED: true, CHILDCARE_WRITES_ENABLED: false },
      "childcare_flags/CA": { ...ALL_ON },
    });
    const f = await getChildcareFlags({ db, state: "ca" }); // state code is normalized
    expect(f.enabled).toBe(true);
    expect(f.writesEnabled).toBe(false); // global false wins even though CA says true
  });

  it("both scopes true ⇒ state scope on", async () => {
    const { db } = makeFlagsDb({
      "childcare_flags/global": { ...ALL_ON },
      "childcare_flags/CA": { CHILDCARE_ENABLED: true, CHILDCARE_DISCOVERY_ENABLED: true },
    });
    const f = await getChildcareFlags({ db, state: "CA" });
    expect(f.enabled).toBe(true);
    expect(f.discoveryEnabled).toBe(true);
    expect(f.writesEnabled).toBe(false); // CA overlay never set writes
  });
});

describe("getChildcareFlags — emergencyOff force-false (no redeploy)", () => {
  beforeEach(() => bustChildcareFlagsCache());
  afterEach(() => bustChildcareFlagsCache());

  it("global emergencyOff forces everything false even when all flags are true", async () => {
    const { db } = makeFlagsDb({
      "childcare_flags/global": { ...ALL_ON, emergencyOff: true },
      "childcare_flags/CA": { ...ALL_ON },
    });
    for (const scope of [{}, { state: "CA" }]) {
      const f = await getChildcareFlags({ db, ...scope });
      expect(f).toEqual({
        enabled: false,
        discoveryEnabled: false,
        writesEnabled: false,
        proactiveEnabled: false,
        emergencyOff: true,
      });
    }
  });

  it("state emergencyOff kills that state while the global scope stays on", async () => {
    const { db } = makeFlagsDb({
      "childcare_flags/global": { ...ALL_ON },
      "childcare_flags/CA": { ...ALL_ON, emergencyOff: true },
    });
    expect((await getChildcareFlags({ db, state: "CA" })).emergencyOff).toBe(true);
    expect((await getChildcareFlags({ db, state: "CA" })).enabled).toBe(false);
    const globalScope = await getChildcareFlags({ db });
    expect(globalScope.enabled).toBe(true);
    expect(globalScope.emergencyOff).toBe(false);
  });
});

describe("getChildcareFlags — cache TTL and bust hook", () => {
  beforeEach(() => {
    bustChildcareFlagsCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    bustChildcareFlagsCache();
  });

  it("caches doc reads within the TTL and re-reads after it elapses", async () => {
    const { db, reads } = makeFlagsDb({ "childcare_flags/global": { ...ALL_ON } });
    await getChildcareFlags({ db });
    await getChildcareFlags({ db });
    expect(reads.length).toBe(1); // second call served from cache

    vi.advanceTimersByTime(CHILDCARE_FLAGS_CACHE_TTL_MS - 1);
    await getChildcareFlags({ db });
    expect(reads.length).toBe(1); // still within TTL

    vi.advanceTimersByTime(2);
    await getChildcareFlags({ db });
    expect(reads.length).toBe(2); // TTL elapsed — fresh read
  });

  it("caches doc ABSENCE too (absent stays cheap), and bust forces a re-read", async () => {
    const docs: Record<string, Record<string, unknown>> = {};
    const { db, reads } = makeFlagsDb(docs);
    expect((await getChildcareFlags({ db })).enabled).toBe(false);
    expect((await getChildcareFlags({ db })).enabled).toBe(false);
    expect(reads.length).toBe(1);

    // Flag flipped in Firestore: visible immediately after an explicit bust.
    docs["childcare_flags/global"] = { ...ALL_ON };
    bustChildcareFlagsCache();
    expect((await getChildcareFlags({ db })).enabled).toBe(true);
    expect(reads.length).toBe(2);
  });

  it("emergency-off becomes effective within one TTL without any redeploy", async () => {
    const docs: Record<string, Record<string, unknown>> = {
      "childcare_flags/global": { ...ALL_ON },
    };
    const { db } = makeFlagsDb(docs);
    expect((await getChildcareFlags({ db })).enabled).toBe(true);

    docs["childcare_flags/global"] = { ...ALL_ON, emergencyOff: true };
    // Still cached…
    expect((await getChildcareFlags({ db })).enabled).toBe(true);
    // …but after the TTL the kill takes effect with zero deploys.
    vi.advanceTimersByTime(CHILDCARE_FLAGS_CACHE_TTL_MS + 1);
    const f = await getChildcareFlags({ db });
    expect(f.emergencyOff).toBe(true);
    expect(f.enabled).toBe(false);
  });
});
