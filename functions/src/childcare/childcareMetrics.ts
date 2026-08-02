// ── Childcare metric contract (plan 2026-07-22-002, U13 / R57, R61-R63) ──────
//
// The privacy-safe metric REGISTRY: the exact set of signals childcareCanaryWatch
// emits, each with a stable name, its canary signal, an escalation owner, and an
// exemplar envelope SHAPE. Metrics can NEVER carry child PII — the accompanying
// test (childcareMetrics.test.ts) asserts every shape here passes
// privacyAssertions.assertMetricPayloadChildSafe. This registry is the contract
// the dashboard slices and the canary evaluator share, so a new signal cannot be
// added without also declaring a privacy-safe shape.

import {
  CHILDCARE_CANARY_THRESHOLDS,
  CHILDCARE_CANARY_ESCALATION_OWNER,
  CHILDCARE_ROLLOUT_HOLD_SIGNALS,
  type ChildcareCanarySignalName,
} from "../config/slaConstants";
import * as admin from "firebase-admin";
import { createHash } from "crypto";
import { assertChildcareTelemetryPayloadSafe } from "./childcareTelemetryScan";

export interface ChildcareMetricSpec {
  /** Stable, privacy-safe metric name (dashboard + alert `signal`). */
  readonly signal: ChildcareCanarySignalName;
  /** Human-readable metric family this signal belongs to. */
  readonly family:
    | "funnel" | "denials" | "expiry" | "matching" | "booking" | "payment"
    | "disclosure" | "memory" | "incident" | "lifecycle" | "migration" | "manifest"
    | "observability";
  readonly description: string;
  /** True = any nonzero count is RED (zero-tolerance invariant). */
  readonly zeroTolerance: boolean;
  /** Escalation owner (operator scope) paged on breach. */
  readonly owner: string;
  /** RED forces an automatic rollout HOLD the U14 deploy gate reads. */
  readonly holdsRollout: boolean;
  /**
   * Exemplar alert envelope — ONLY safe telemetry shapes. Pinned by the test to
   * pass assertMetricPayloadChildSafe. `detail` sub-maps key by safe
   * status/tool/collection names only, never by any child identifier.
   */
  readonly shape: Record<string, unknown>;
}

const owner = (s: ChildcareCanarySignalName): string => CHILDCARE_CANARY_ESCALATION_OWNER[s];
const holds = (s: ChildcareCanarySignalName): boolean => CHILDCARE_ROLLOUT_HOLD_SIGNALS.has(s);

/** The complete childcare metric contract, keyed by signal name. */
export const CHILDCARE_METRICS: Record<ChildcareCanarySignalName, ChildcareMetricSpec> = {
  enrollment_funnel_stall: {
    signal: "enrollment_funnel_stall",
    family: "funnel",
    description: "Child-profile enrollment funnel counts (created → identity-ready → job → matched → booked) stalling at a stage.",
    zeroTolerance: false,
    owner: owner("enrollment_funnel_stall"),
    holdsRollout: holds("enrollment_funnel_stall"),
    shape: { metric: "enrollment_funnel_stall", signal: "enrollment_funnel_stall", severity: "medium", count: 0, threshold: 5, window: "24h", detail: {} },
  },
  authority_denial_spike: {
    signal: "authority_denial_spike",
    family: "denials",
    description: "Guardian-authority denials per window; a spike means scope/authority breakage or an attack.",
    zeroTolerance: false,
    owner: owner("authority_denial_spike"),
    holdsRollout: holds("authority_denial_spike"),
    shape: { metric: "authority_denial_spike", signal: "authority_denial_spike", severity: "high", count: 0, threshold: 20, window: "24h", detail: {} },
  },
  provider_expiry_visible: {
    signal: "provider_expiry_visible",
    family: "expiry",
    description: "Providers with an EXPIRED screening/credential still visible in discovery — must be zero.",
    zeroTolerance: true,
    owner: owner("provider_expiry_visible"),
    holdsRollout: holds("provider_expiry_visible"),
    shape: { metric: "provider_expiry_visible", signal: "provider_expiry_visible", severity: "high", count: 0, threshold: 1, window: "24h", detail: {} },
  },
  matching_eligibility_drop: {
    signal: "matching_eligibility_drop",
    family: "matching",
    description: "Eligible-candidate sets collapsing to empty at a rate suggesting an eligibility-gate regression.",
    zeroTolerance: false,
    owner: owner("matching_eligibility_drop"),
    holdsRollout: holds("matching_eligibility_drop"),
    shape: { metric: "matching_eligibility_drop", signal: "matching_eligibility_drop", severity: "medium", count: 0, threshold: 10, window: "24h", detail: {} },
  },
  booking_transition_anomaly: {
    signal: "booking_transition_anomaly",
    family: "booking",
    description: "Booking state-transition anomalies (illegal transitions, stuck states).",
    zeroTolerance: false,
    owner: owner("booking_transition_anomaly"),
    holdsRollout: holds("booking_transition_anomaly"),
    shape: { metric: "booking_transition_anomaly", signal: "booking_transition_anomaly", severity: "medium", count: 0, threshold: 5, window: "24h", detail: {} },
  },
  payment_reconciliation_mismatch: {
    signal: "payment_reconciliation_mismatch",
    family: "payment",
    description: "Charge/transfer/refund events not converging one-per-booking (duplicate or missing) — must be zero.",
    zeroTolerance: true,
    owner: owner("payment_reconciliation_mismatch"),
    holdsRollout: holds("payment_reconciliation_mismatch"),
    shape: { metric: "payment_reconciliation_mismatch", signal: "payment_reconciliation_mismatch", severity: "high", count: 0, threshold: 1, window: "24h", detail: {} },
  },
  message_disclosure_violation: {
    signal: "message_disclosure_violation",
    family: "disclosure",
    description: "Outbound message/notification that disclosed child-sensitive detail — must be zero.",
    zeroTolerance: true,
    owner: owner("message_disclosure_violation"),
    holdsRollout: holds("message_disclosure_violation"),
    shape: { metric: "message_disclosure_violation", signal: "message_disclosure_violation", severity: "high", count: 0, threshold: 1, window: "24h", detail: {} },
  },
  memory_denial_breach: {
    signal: "memory_denial_breach",
    family: "memory",
    description: "Childcare-vertical rows found in ANY AI memory store (learned_facts/embeddings/operations) — must be zero (R50).",
    zeroTolerance: true,
    owner: owner("memory_denial_breach"),
    holdsRollout: holds("memory_denial_breach"),
    shape: { metric: "memory_denial_breach", signal: "memory_denial_breach", severity: "high", count: 0, threshold: 1, window: "24h", detail: {} },
  },
  incident_sla_miss: {
    signal: "incident_sla_miss",
    family: "incident",
    description: "Open incident cases past the operator-response SLA.",
    zeroTolerance: false,
    owner: owner("incident_sla_miss"),
    holdsRollout: holds("incident_sla_miss"),
    shape: { metric: "incident_sla_miss", signal: "incident_sla_miss", severity: "high", count: 0, threshold: 1, window: "24h", detail: {} },
  },
  lifecycle_task_stuck: {
    signal: "lifecycle_task_stuck",
    family: "lifecycle",
    description: "Export/delete/redact/age-out lifecycle tasks stuck past their stuck threshold.",
    zeroTolerance: false,
    owner: owner("lifecycle_task_stuck"),
    holdsRollout: holds("lifecycle_task_stuck"),
    shape: { metric: "lifecycle_task_stuck", signal: "lifecycle_task_stuck", severity: "medium", count: 0, threshold: 3, window: "24h", detail: {} },
  },
  migration_count_mismatch: {
    signal: "migration_count_mismatch",
    family: "migration",
    description: "Migration reconciliation shows unresolved records (old + migrated + rejected != total) — must be zero (AE27).",
    zeroTolerance: true,
    owner: owner("migration_count_mismatch"),
    holdsRollout: holds("migration_count_mismatch"),
    shape: { metric: "migration_count_mismatch", signal: "migration_count_mismatch", severity: "high", count: 0, threshold: 1, window: "24h", detail: {} },
  },
  source_manifest_drift: {
    signal: "source_manifest_drift",
    family: "manifest",
    description: "A shared-collection consumer is unregistered in the childcare consumer manifest (AE25) — must be zero.",
    zeroTolerance: true,
    owner: owner("source_manifest_drift"),
    holdsRollout: holds("source_manifest_drift"),
    shape: { metric: "source_manifest_drift", signal: "source_manifest_drift", severity: "high", count: 0, threshold: 1, window: "24h", detail: {} },
  },
  redactor_failure: {
    signal: "redactor_failure",
    family: "observability",
    description: "The child-sensitive log redactor threw internally — a telemetry surface may be leaking; must be zero.",
    zeroTolerance: true,
    owner: owner("redactor_failure"),
    holdsRollout: holds("redactor_failure"),
    shape: { metric: "redactor_failure", signal: "redactor_failure", severity: "high", count: 0, threshold: 1, window: "24h", detail: {} },
  },
};

/** Every declared metric signal — the canary evaluator iterates this list. */
export const CHILDCARE_METRIC_SIGNALS = Object.keys(CHILDCARE_METRICS) as ChildcareCanarySignalName[];

/** True when the registry declares a metric for every canary threshold (no orphans either way). */
export function metricContractCoversAllThresholds(): boolean {
  const thresholdSignals = Object.keys(CHILDCARE_CANARY_THRESHOLDS).sort();
  const metricSignals = CHILDCARE_METRIC_SIGNALS.slice().sort();
  return (
    thresholdSignals.length === metricSignals.length &&
    thresholdSignals.every((s, i) => s === metricSignals[i])
  );
}

export const CHILDCARE_QUALITY_EVENTS_COLLECTION = "childcare_quality_events";
export const CHILDCARE_QUALITY_SCHEMA_VERSION = "childcare-quality-v1";

export type ChildcareQualityEventCode =
  | "format_revision"
  | "grounding_revision"
  | "confidence_claim"
  | "conversation_repair"
  | "human_handoff"
  | "promise_without_tool"
  | "supervisor_failure"
  | "turn_failure";

const SAFE_QUALITY_METADATA_KEYS = new Set([
  "action",
  "claimCategories",
  "claimRisk",
  "errorClass",
  "latencyMs",
  "pathway",
  "reasonCodes",
  "rewriteApplied",
  "toolCount",
  "verdict",
]);

function pseudonymize(value: string): string {
  return createHash("sha256").update(`childcare-quality:${value}`).digest("hex").slice(0, 32);
}

function normalizeQualityMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!SAFE_QUALITY_METADATA_KEYS.has(key)) {
      throw new Error(`childcare quality telemetry rejected metadata key: ${key}`);
    }
    if (typeof raw === "boolean") {
      out[key] = raw;
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = Math.max(-1_000_000, Math.min(1_000_000, raw));
    } else if (typeof raw === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(raw)) {
      out[key] = raw;
    } else if (
      Array.isArray(raw) &&
      raw.length <= 20 &&
      raw.every((value) => typeof value === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(value))
    ) {
      out[key] = raw;
    } else if (raw !== undefined && raw !== null) {
      throw new Error(`childcare quality telemetry rejected metadata value: ${key}`);
    }
  }
  return out;
}

export interface ChildcareQualityEventInput {
  principalId: string;
  correlationId: string;
  eventCode: ChildcareQualityEventCode;
  metadata?: Record<string, unknown>;
  now?: Date;
  db?: Pick<admin.firestore.Firestore, "collection">;
}

/**
 * The only sanctioned quality/uncertainty writer for child turns. It stores
 * hashes, enums, booleans, and bounded numbers; raw text and direct identifiers
 * are structurally absent.
 */
export async function recordChildcareQualityEvent(
  input: ChildcareQualityEventInput,
): Promise<void> {
  if (!input.principalId || !input.correlationId) {
    throw new Error("childcare quality telemetry requires principal and correlation identifiers");
  }
  const now = input.now ?? new Date();
  const db = input.db ?? admin.firestore();
  const event = {
    schemaVersion: CHILDCARE_QUALITY_SCHEMA_VERSION,
    careVertical: "child",
    eventCode: input.eventCode,
    principalHash: pseudonymize(input.principalId),
    correlationHash: pseudonymize(input.correlationId),
    metadata: normalizeQualityMetadata(input.metadata ?? {}),
    occurredAt: now.toISOString(),
  };
  assertChildcareTelemetryPayloadSafe(event);
  await db.collection(CHILDCARE_QUALITY_EVENTS_COLLECTION).add({
    ...event,
    ttl: admin.firestore.Timestamp.fromMillis(now.getTime() + 90 * 24 * 60 * 60 * 1000),
  });
}
