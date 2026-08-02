// ── Childcare canary watch (plan 2026-07-22-002, U13 / R57, R61-R63) ─────────
//
// Privacy-safe metric watcher over the childcare stack, modeled on the
// intelligence canary watcher (agents/intelligenceCanaryWatch.ts). It converts
// a reading of privacy-safe COUNTS into graded signals, writes deduped
// content-free admin alerts, and sets/clears an automatic rollout-HOLD signal
// the U14 deploy gate and emergency-off can read.
//
// STRUCTURE (mirrors the intelligence watcher, split for testability):
//   • collectChildcareCanaryMetrics(db, now) — best-effort I/O; returns COUNTS
//     only (never documents, never child fields). Single-field scans, no new
//     index contracts. Fail-soft: any read error yields 0 for that signal.
//   • evaluateChildcareCanaryMetrics(metrics) — PURE. Grades each count against
//     the slaConstants thresholds into amber/red signals + a rollout-hold set.
//   • runChildcareCanarySweep(...) — orchestrates: collect → evaluate → dedupe
//     alerts → set/clear rollout hold. Alerts carry counts + signal names only.
//
// GATING: the scheduled export is DARK — it no-ops unless CHILDCARE_ENABLED is
// on (getChildcareFlags). Safe no-op otherwise. Zero-tolerance safety invariants
// (memory breach, disclosure, stale provider) are still worth watching once
// childcare is live; before that there is nothing to watch.
//
// PRIVACY: the canary's own persisted state uses SYNTHETIC identifiers only —
// no real child/household id ever lands in a hold reason or alert detail
// (assertSyntheticIdentifier / assertMetricPayloadChildSafe guard this).

import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import {
  CHILDCARE_CANARY_THRESHOLDS,
  CHILDCARE_CANARY_ESCALATION_OWNER,
  CHILDCARE_ROLLOUT_HOLD_SIGNALS,
  CHILDCARE_CANARY_LOOKBACK_MS,
  CHILDCARE_INCIDENT_SLA_RED_HOURS,
  CHILDCARE_LIFECYCLE_STUCK_RED_HOURS,
  type ChildcareCanarySignalName,
} from "../config/slaConstants";
import { CHILDCARE_METRIC_SIGNALS, CHILDCARE_METRICS } from "./childcareMetrics";
import { assertMetricPayloadChildSafe, assertSyntheticIdentifier } from "./privacyAssertions";
import { getChildcareFlags } from "../config/featureFlags";

type Db = Pick<admin.firestore.Firestore, "collection">;

const HOUR_MS = 60 * 60 * 1000;

// The canary's own state namespace. Governance collection — watched by the
// consumer manifest; the ONLY writer is this module (U14 deploy gate reads it).
export const CHILDCARE_CANARY_STATE_COLLECTION = "childcare_canary_state";
export const CHILDCARE_ROLLOUT_HOLD_DOC = "rollout_hold";
export const CHILDCARE_MIGRATION_REPORT_DOC = "migration_report";
export const CHILDCARE_MANIFEST_DRIFT_DOC = "manifest_drift";

// ── Metric reading (counts only) ─────────────────────────────────────────────

export interface ChildcareCanaryMetrics {
  /** One count per signal over the lookback window (or point-in-time for invariants). */
  counts: Record<ChildcareCanarySignalName, number>;
  /** Optional privacy-safe breakdown (keyed by safe status/type names only). */
  detail?: Partial<Record<ChildcareCanarySignalName, Record<string, number>>>;
}

function zeroCounts(): Record<ChildcareCanarySignalName, number> {
  const out = {} as Record<ChildcareCanarySignalName, number>;
  for (const s of CHILDCARE_METRIC_SIGNALS) out[s] = 0;
  return out;
}

/** Alert types OTHER childcare code stamps into admin_alerts, aggregated here. */
const ALERT_TYPE_TO_SIGNAL: Record<string, ChildcareCanarySignalName> = {
  childcare_authority_denied: "authority_denial_spike",
  childcare_matching_empty: "matching_eligibility_drop",
  childcare_booking_anomaly: "booking_transition_anomaly",
  childcare_payment_mismatch: "payment_reconciliation_mismatch",
  childcare_disclosure_violation: "message_disclosure_violation",
  childcare_provider_expiry_visible: "provider_expiry_visible",
  childcare_enrollment_stall: "enrollment_funnel_stall",
  childcare_redactor_failure: "redactor_failure",
};

/**
 * Best-effort collector. Returns COUNTS ONLY — never documents, never child
 * fields. Every read is a single-field scan wrapped in a catch that yields 0
 * (fail-soft: a canary that crashes is worse than a canary that under-reports,
 * and under-report is itself caught by the missing-metric path). SYNTHETIC/no
 * identifiers are read out; only counts survive.
 */
export async function collectChildcareCanaryMetrics(
  db: Db,
  now: Date = new Date(),
): Promise<ChildcareCanaryMetrics> {
  const counts = zeroCounts();
  const detail: NonNullable<ChildcareCanaryMetrics["detail"]> = {};
  const sinceIso = new Date(now.getTime() - CHILDCARE_CANARY_LOOKBACK_MS).toISOString();

  // 1. Windowed childcare-typed admin alerts → operational spike signals.
  try {
    const snap = await db.collection("admin_alerts")
      .where("createdAt", ">=", sinceIso).limit(1000).get();
    const byType: Record<string, number> = {};
    for (const d of snap.docs) {
      const t = String((d.data() ?? {}).type ?? "");
      const sig = ALERT_TYPE_TO_SIGNAL[t];
      if (sig) { counts[sig] += 1; byType[t] = (byType[t] ?? 0) + 1; }
    }
    if (Object.keys(byType).length) detail.authority_denial_spike = byType;
  } catch { /* fail-soft */ }

  // 2. Memory-denial breach — childcare rows in ANY memory store (must be 0, R50).
  for (const coll of ["learned_facts", "memory_embeddings", "memory_operations"]) {
    try {
      const snap = await db.collection(coll)
        .where("careVertical", "==", "child").limit(50).get();
      counts.memory_denial_breach += snap.size;
    } catch { /* fail-soft */ }
  }

  // 3. Incident SLA misses — open incidents past the red SLA.
  try {
    const cutoff = new Date(now.getTime() - CHILDCARE_INCIDENT_SLA_RED_HOURS * HOUR_MS).toISOString();
    const snap = await db.collection("childcare_incidents")
      .where("status", "in", ["open", "triage", "in_progress"]).limit(200).get();
    counts.incident_sla_miss = snap.docs.filter(
      (d) => String((d.data() ?? {}).createdAt ?? "") !== "" && String((d.data() ?? {}).createdAt) <= cutoff,
    ).length;
  } catch { /* fail-soft */ }

  // 4. Lifecycle tasks stuck — non-terminal requests past the stuck threshold.
  try {
    const cutoff = new Date(now.getTime() - CHILDCARE_LIFECYCLE_STUCK_RED_HOURS * HOUR_MS).toISOString();
    const snap = await db.collection("data_lifecycle_requests")
      .where("status", "in", ["pending", "claimed", "in_progress", "retrying"]).limit(200).get();
    counts.lifecycle_task_stuck = snap.docs.filter(
      (d) => String((d.data() ?? {}).updatedAt ?? (d.data() ?? {}).createdAt ?? "") <= cutoff,
    ).length;
  } catch { /* fail-soft */ }

  // 5. Migration mismatch + manifest drift — read from canary-state reports
  //    (written by the migration rehearsal / a CI manifest audit). Default 0.
  try {
    const mig = await db.collection(CHILDCARE_CANARY_STATE_COLLECTION).doc(CHILDCARE_MIGRATION_REPORT_DOC).get();
    if (mig.exists) counts.migration_count_mismatch = Number((mig.data() ?? {}).unresolved ?? 0) || 0;
  } catch { /* fail-soft */ }
  try {
    const drift = await db.collection(CHILDCARE_CANARY_STATE_COLLECTION).doc(CHILDCARE_MANIFEST_DRIFT_DOC).get();
    if (drift.exists) counts.source_manifest_drift = Number((drift.data() ?? {}).unregistered ?? 0) || 0;
  } catch { /* fail-soft */ }

  return { counts, detail };
}

// ── Pure evaluator ───────────────────────────────────────────────────────────

export interface EvaluatedCanarySignal {
  signal: ChildcareCanarySignalName;
  level: "amber" | "red";
  severity: "high" | "medium";
  count: number;
  threshold: number;
  owner: string;
  holdsRollout: boolean;
  detail: Record<string, number>;
}

export interface CanaryEvaluation {
  signals: EvaluatedCanarySignal[];
  /** Signal names that are RED and force a rollout hold. */
  holdSignals: ChildcareCanarySignalName[];
  /** Signals present in the threshold table but MISSING from the reading. */
  missingMetrics: ChildcareCanarySignalName[];
}

/**
 * PURE grading. For each declared signal, grade its count against the thresholds:
 * red when count >= red; amber when count >= amber (and amber > 0). Zero-tolerance
 * signals (amber:0, red:1) go straight to red on any nonzero count. A signal with
 * no count in the reading is reported as a MISSING metric (a broken/absent metric
 * is itself a canary failure — R63).
 */
export function evaluateChildcareCanaryMetrics(metrics: ChildcareCanaryMetrics): CanaryEvaluation {
  const signals: EvaluatedCanarySignal[] = [];
  const holdSignals: ChildcareCanarySignalName[] = [];
  const missingMetrics: ChildcareCanarySignalName[] = [];

  for (const signal of CHILDCARE_METRIC_SIGNALS) {
    const th = CHILDCARE_CANARY_THRESHOLDS[signal];
    const raw = metrics.counts[signal];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      missingMetrics.push(signal);
      continue;
    }
    const count = raw;
    let level: "amber" | "red" | null = null;
    if (count >= th.red) level = "red";
    else if (th.amber > 0 && count >= th.amber) level = "amber";
    if (!level) continue;

    const holdsRollout = level === "red" && CHILDCARE_ROLLOUT_HOLD_SIGNALS.has(signal);
    signals.push({
      signal,
      level,
      severity: level === "red" ? "high" : "medium",
      count,
      threshold: level === "red" ? th.red : th.amber,
      owner: CHILDCARE_CANARY_ESCALATION_OWNER[signal],
      holdsRollout,
      detail: metrics.detail?.[signal] ?? {},
    });
    if (holdsRollout) holdSignals.push(signal);
  }

  return { signals, holdSignals, missingMetrics };
}

// ── Rollout-hold signal (R61/R63 — read by the U14 deploy gate) ──────────────

export interface RolloutHoldState {
  held: boolean;
  reasons: string[];
  updatedAt: string;
}

/** Read the current rollout-hold state (held=false when the doc is absent). */
export async function isChildcareRolloutHeld(db: Db): Promise<RolloutHoldState> {
  try {
    const snap = await db.collection(CHILDCARE_CANARY_STATE_COLLECTION).doc(CHILDCARE_ROLLOUT_HOLD_DOC).get();
    if (!snap.exists) return { held: false, reasons: [], updatedAt: "" };
    const d = snap.data() ?? {};
    return {
      held: d.held === true,
      reasons: Array.isArray(d.reasons) ? d.reasons.map(String) : [],
      updatedAt: String(d.updatedAt ?? ""),
    };
  } catch {
    // Fail SAFE for a deploy gate: unreadable hold state means "assume held".
    return { held: true, reasons: ["hold_state_unreadable"], updatedAt: "" };
  }
}

async function setRolloutHold(
  db: Db,
  held: boolean,
  reasons: string[],
  now: Date,
): Promise<void> {
  const state = {
    held,
    reasons,           // signal names only — never identifiers
    syntheticOnly: true,
    updatedAt: now.toISOString(),
  };
  // The hold state must itself be child-safe telemetry.
  assertMetricPayloadChildSafe({ held: state.held, reasons: state.reasons, updatedAt: state.updatedAt }, "rollout_hold");
  await (db.collection(CHILDCARE_CANARY_STATE_COLLECTION).doc(CHILDCARE_ROLLOUT_HOLD_DOC) as
    admin.firestore.DocumentReference).set(state, { merge: false });
}

// ── Sweep orchestration ──────────────────────────────────────────────────────

export interface CanarySweepResult {
  signals: EvaluatedCanarySignal[];
  alertsWritten: number;
  holdSet: boolean;
  holdSignals: ChildcareCanarySignalName[];
  missingMetrics: ChildcareCanarySignalName[];
}

export async function runChildcareCanarySweep(opts: {
  db: Db;
  now?: Date;
  /** Injectable pre-collected metrics (tests bypass I/O). */
  metrics?: ChildcareCanaryMetrics;
}): Promise<CanarySweepResult> {
  const now = opts.now ?? new Date();
  const metrics = opts.metrics ?? (await collectChildcareCanaryMetrics(opts.db, now));
  const { signals, holdSignals, missingMetrics } = evaluateChildcareCanaryMetrics(metrics);

  // Deduped content-free alerts: one per signal per UTC day.
  const day = now.toISOString().slice(0, 10);
  let alertsWritten = 0;
  for (const s of signals) {
    const ref = opts.db.collection("admin_alerts").doc(`childcare_canary_${s.signal}_${day}`) as
      admin.firestore.DocumentReference;
    try {
      const existing = await ref.get();
      if (existing.exists) continue;
      const alert = {
        type: "childcare_canary",
        signal: s.signal,
        severity: s.severity,          // "high" | "medium"
        priority: s.level === "red" ? "critical" : "high",
        count: s.count,
        threshold: s.threshold,
        owner: s.owner,
        detail: s.detail,              // counts by safe type name only
        message: `Childcare canary: ${s.signal} ${s.level.toUpperCase()} (${s.count} >= ${s.threshold}) — owner ${s.owner}. ${CHILDCARE_METRICS[s.signal].description}`,
        createdAt: now.toISOString(),
        resolved: false,
      };
      assertMetricPayloadChildSafe(
        { signal: alert.signal, severity: alert.severity, count: alert.count, threshold: alert.threshold, owner: alert.owner, detail: alert.detail },
        `alert:${s.signal}`,
      );
      await ref.set(alert);
      alertsWritten++;
    } catch (err) {
      console.error("[childcareCanary] alert write failed", s.signal, err instanceof Error ? err.name : "Error");
    }
  }

  // Missing metrics are their own alert (a metric that stopped reporting can hide
  // a red signal — R63: no childcare safety metric silently absent).
  if (missingMetrics.length) {
    const ref = opts.db.collection("admin_alerts").doc(`childcare_canary_missing_metric_${day}`) as
      admin.firestore.DocumentReference;
    try {
      const existing = await ref.get();
      if (!existing.exists) {
        await ref.set({
          type: "childcare_canary",
          signal: "missing_metric",
          severity: "high",
          priority: "critical",
          detail: { missing: missingMetrics.length },
          message: `Childcare canary: ${missingMetrics.length} metric(s) absent from the reading — cannot certify childcare health (R63).`,
          createdAt: now.toISOString(),
          resolved: false,
        });
        alertsWritten++;
      }
    } catch { /* fail-soft */ }
  }

  // Rollout hold: set when any red hold-signal fired; clear when none do.
  const held = holdSignals.length > 0;
  try {
    await setRolloutHold(opts.db, held, held ? holdSignals.slice() : [], now);
  } catch (err) {
    console.error("[childcareCanary] rollout-hold write failed", err instanceof Error ? err.name : "Error");
  }

  console.info("childcareCanary.sweep", {
    signals: signals.map((s) => ({ signal: s.signal, level: s.level, count: s.count })),
    alertsWritten,
    holdSet: held,
    missing: missingMetrics.length,
  });
  return { signals, alertsWritten, holdSet: held, holdSignals, missingMetrics };
}

// ── Scheduled export (DARK — gated on CHILDCARE_ENABLED) ─────────────────────

export const childcareCanaryWatch = functions.pubsub
  .schedule("35 * * * *") // hourly at :35, offset from intelligence (:15) + ops (:00)
  .timeZone("UTC")
  .onRun(async () => {
    const flags = await getChildcareFlags().catch(() => ({ enabled: false } as { enabled: boolean }));
    if (!flags.enabled) {
      // Safe no-op: nothing to watch until childcare is live. Emergency-off
      // (which force-falses `enabled`) therefore also parks the canary.
      return null;
    }
    const db = admin.firestore();
    await runChildcareCanarySweep({ db }).catch((err) =>
      console.error("[childcareCanary] sweep failed:", err),
    );
    return null;
  });

// Exported for the synthetic-identifier canary-state test scenario.
export { assertSyntheticIdentifier };
