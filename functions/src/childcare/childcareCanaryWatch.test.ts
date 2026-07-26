// U13 canary-watch tests (plan 2026-07-22-002, R57/R61-R63).
//
// Required scenarios: authority-denial spike → amber/red; stale provider still
// visible → red (zero-tolerance); duplicate charge → red; memory-write breach
// → red; incident SLA miss; lifecycle task stuck; migration mismatch; canary
// duplicate dedupe; missing metric; false-positive correction (clear); alert
// delivery path; rollout-hold set/clear; synthetic-identifier-only canary state.

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({});
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("firebase-functions/v1", () => {
  const chain: any = { schedule: () => chain, timeZone: () => chain, onRun: (fn: any) => fn };
  return { __esModule: true, pubsub: chain };
});

import {
  evaluateChildcareCanaryMetrics,
  runChildcareCanarySweep,
  collectChildcareCanaryMetrics,
  isChildcareRolloutHeld,
  CHILDCARE_CANARY_STATE_COLLECTION,
  CHILDCARE_ROLLOUT_HOLD_DOC,
  type ChildcareCanaryMetrics,
} from "./childcareCanaryWatch";
import { CHILDCARE_METRIC_SIGNALS } from "./childcareMetrics";
import type { ChildcareCanarySignalName } from "../config/slaConstants";

// ── Minimal in-memory Firestore (doc + where/limit) ──────────────────────────
function makeDb() {
  const store = new Map<string, Record<string, unknown>>();
  const docRef = (path: string): any => ({
    path,
    get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
    set: async (data: Record<string, unknown>) => { store.set(path, data); },
  });
  const makeQuery = (coll: string, filters: Array<{ f: string; op: string; v: any }>): any => ({
    where: (f: string, op: string, v: any) => makeQuery(coll, [...filters, { f, op, v }]),
    limit: () => makeQuery(coll, filters),
    get: async () => {
      const rows = [...store.entries()]
        .filter(([p]) => p.startsWith(`${coll}/`) && p.split("/").length === 2)
        .map(([p, d]) => ({ id: p.split("/")[1], data: () => d, _d: d }))
        .filter((r) => filters.every((f) => {
          const val = (r._d as Record<string, unknown>)[f.f];
          if (f.op === "==") return val === f.v;
          if (f.op === "in") return Array.isArray(f.v) && f.v.includes(val);
          if (f.op === ">=") return String(val ?? "") >= f.v;
          return true;
        }));
      return { docs: rows, size: rows.length, empty: rows.length === 0 };
    },
  });
  const db: any = {
    collection: (coll: string) => ({
      doc: (id: string) => docRef(`${coll}/${id}`),
      where: (f: string, op: string, v: any) => makeQuery(coll, [{ f, op, v }]),
      limit: () => makeQuery(coll, []),
      get: () => makeQuery(coll, []).get(),
    }),
  };
  return { db, store };
}

function metricsWith(overrides: Partial<Record<ChildcareCanarySignalName, number>>): ChildcareCanaryMetrics {
  const counts = {} as Record<ChildcareCanarySignalName, number>;
  for (const s of CHILDCARE_METRIC_SIGNALS) counts[s] = 0;
  return { counts: { ...counts, ...overrides } };
}

const NOW = new Date("2026-07-24T12:00:00Z");

describe("evaluateChildcareCanaryMetrics (pure grading)", () => {
  it("no breaches when every count is 0", () => {
    const r = evaluateChildcareCanaryMetrics(metricsWith({}));
    expect(r.signals).toHaveLength(0);
    expect(r.holdSignals).toHaveLength(0);
    expect(r.missingMetrics).toHaveLength(0);
  });

  it("authority-denial spike grades amber then red", () => {
    expect(evaluateChildcareCanaryMetrics(metricsWith({ authority_denial_spike: 25 })).signals[0])
      .toMatchObject({ signal: "authority_denial_spike", level: "amber", severity: "medium" });
    const red = evaluateChildcareCanaryMetrics(metricsWith({ authority_denial_spike: 80 })).signals[0];
    expect(red).toMatchObject({ signal: "authority_denial_spike", level: "red", severity: "high" });
  });

  it("zero-tolerance: a single stale provider visible is RED and holds rollout", () => {
    const r = evaluateChildcareCanaryMetrics(metricsWith({ provider_expiry_visible: 1 }));
    expect(r.signals[0]).toMatchObject({ signal: "provider_expiry_visible", level: "red", holdsRollout: true });
    expect(r.holdSignals).toContain("provider_expiry_visible");
  });

  it("zero-tolerance: duplicate charge (payment mismatch) and memory breach are RED + hold", () => {
    const r = evaluateChildcareCanaryMetrics(metricsWith({ payment_reconciliation_mismatch: 1, memory_denial_breach: 1 }));
    expect(r.holdSignals).toEqual(expect.arrayContaining(["payment_reconciliation_mismatch", "memory_denial_breach"]));
  });

  it("incident SLA miss and lifecycle stuck grade correctly", () => {
    const r = evaluateChildcareCanaryMetrics(metricsWith({ incident_sla_miss: 1, lifecycle_task_stuck: 4 }));
    const byName = Object.fromEntries(r.signals.map((s) => [s.signal, s]));
    expect(byName.incident_sla_miss.level).toBe("amber"); // amber:1, red:2
    expect(byName.lifecycle_task_stuck.level).toBe("amber"); // amber:3, red:10
  });

  it("migration mismatch flags a MISSING metric when its count is absent (R63)", () => {
    const m = metricsWith({});
    delete (m.counts as Record<string, number>).migration_count_mismatch;
    const r = evaluateChildcareCanaryMetrics(m);
    expect(r.missingMetrics).toContain("migration_count_mismatch");
  });
});

describe("runChildcareCanarySweep (alerts + hold + dedupe)", () => {
  it("writes one deduped content-free alert per signal per day; hold is set", async () => {
    const { db, store } = makeDb();
    const metrics = metricsWith({ provider_expiry_visible: 1 });
    const first = await runChildcareCanarySweep({ db, now: NOW, metrics });
    expect(first.alertsWritten).toBe(1);
    expect(first.holdSet).toBe(true);

    const alert = store.get(`admin_alerts/childcare_canary_provider_expiry_visible_2026-07-24`);
    expect(alert).toBeTruthy();
    expect(JSON.stringify(alert)).not.toMatch(/childName|address|\bdob\b|allergy/i);

    // Replay same day → no new alert (dedupe).
    const replay = await runChildcareCanarySweep({ db, now: NOW, metrics });
    expect(replay.alertsWritten).toBe(0);
  });

  it("rollout-hold SET then CLEARED (false-positive correction) is readable by the deploy gate", async () => {
    const { db } = makeDb();
    await runChildcareCanarySweep({ db, now: NOW, metrics: metricsWith({ memory_denial_breach: 1 }) });
    expect((await isChildcareRolloutHeld(db)).held).toBe(true);
    expect((await isChildcareRolloutHeld(db)).reasons).toContain("memory_denial_breach");

    // Next sweep is clean → hold clears.
    await runChildcareCanarySweep({ db, now: NOW, metrics: metricsWith({}) });
    const state = await isChildcareRolloutHeld(db);
    expect(state.held).toBe(false);
    expect(state.reasons).toHaveLength(0);
  });

  it("amber-only signals alert but do NOT hold rollout", async () => {
    const { db } = makeDb();
    const r = await runChildcareCanarySweep({ db, now: NOW, metrics: metricsWith({ matching_eligibility_drop: 12 }) });
    expect(r.holdSet).toBe(false);
    expect((await isChildcareRolloutHeld(db)).held).toBe(false);
  });

  it("missing metric raises its own alert (R63)", async () => {
    const { db, store } = makeDb();
    const m = metricsWith({});
    delete (m.counts as Record<string, number>).source_manifest_drift;
    await runChildcareCanarySweep({ db, now: NOW, metrics: m });
    expect(store.get(`admin_alerts/childcare_canary_missing_metric_2026-07-24`)).toBeTruthy();
  });

  it("canary rollout-hold state is SYNTHETIC-only (no identifiers, marked syntheticOnly)", async () => {
    const { db, store } = makeDb();
    await runChildcareCanarySweep({ db, now: NOW, metrics: metricsWith({ migration_count_mismatch: 1 }) });
    const state = store.get(`${CHILDCARE_CANARY_STATE_COLLECTION}/${CHILDCARE_ROLLOUT_HOLD_DOC}`) as Record<string, unknown>;
    expect(state.syntheticOnly).toBe(true);
    // reasons are signal NAMES only — never a child/household id.
    for (const r of state.reasons as string[]) expect(r).toMatch(/^[a-z_]+$/);
  });

  it("isChildcareRolloutHeld fails SAFE (assume held) when state is unreadable", async () => {
    const brokenDb: any = { collection: () => ({ doc: () => ({ get: async () => { throw new Error("boom"); } }) }) };
    const state = await isChildcareRolloutHeld(brokenDb);
    expect(state.held).toBe(true);
  });
});

describe("collectChildcareCanaryMetrics (fail-soft I/O)", () => {
  it("counts a childcare row found in a memory store (breach) and stays 0 elsewhere", async () => {
    const { db, store } = makeDb();
    store.set("learned_facts/f1", { careVertical: "child", value: "x" });
    const m = await collectChildcareCanaryMetrics(db, NOW);
    expect(m.counts.memory_denial_breach).toBe(1);
    expect(m.counts.authority_denial_spike).toBe(0);
  });

  it("aggregates windowed childcare admin alerts into their signals", async () => {
    const { db, store } = makeDb();
    store.set("admin_alerts/a1", { type: "childcare_authority_denied", createdAt: "2026-07-24T11:00:00Z" });
    store.set("admin_alerts/a2", { type: "childcare_payment_mismatch", createdAt: "2026-07-24T11:30:00Z" });
    const m = await collectChildcareCanaryMetrics(db, NOW);
    expect(m.counts.authority_denial_spike).toBe(1);
    expect(m.counts.payment_reconciliation_mismatch).toBe(1);
  });

  it("never throws on a broken db (fail-soft → all zero)", async () => {
    const brokenDb: any = { collection: () => { throw new Error("db down"); } };
    const m = await collectChildcareCanaryMetrics(brokenDb, NOW);
    expect(Object.values(m.counts).every((c) => c === 0)).toBe(true);
  });
});
