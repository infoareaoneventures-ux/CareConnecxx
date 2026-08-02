// ── Childcare payment policy (plan 2026-07-22-002, U8 / R39-R40, R57) ────────
//
// Pure-ish policy module for childcare money: pricing resolution, platform-fee
// math, cancellation/refund policy evaluation, and the child-PII-free Stripe
// metadata contract. NO Stripe calls and NO booking mutations happen here —
// childcare/shiftPayments.ts owns orchestration.
//
// STRUCTURAL CONTRACTS:
//   • R40 FAIL CLOSED: childcare pricing comes ONLY from the jurisdiction
//     policy's pricing refs (jurisdiction_care_policies/{STATE}.pricing.*Ref)
//     resolved against server-only childcare_pricing_configs docs. Any unset
//     ref, missing config doc, or malformed value throws
//     ChildcarePaymentPolicyError — childcare amounts are NEVER derived from
//     the senior defaults (SHIFT_PLATFORM_FEE_RATE et al. are deliberately
//     not imported here).
//   • R57: Stripe metadata for childcare objects carries opaque IDs only
//     (booking/household/shift IDs). The exact key sets are exported consts
//     pinned by tests; assertChildSafeStripeMetadata rejects any drift.
//   • Percentages/windows for cancellation and refunds are policy-resolved
//     configuration, never hardcoded business numbers.

import * as admin from "firebase-admin";
import {
  loadJurisdictionPolicy,
  CHILDCARE_PRICING_REF_KEYS,
  type ChildcarePricingRefKey,
  type JurisdictionCarePolicy,
} from "./jurisdictionPolicy";

export const CHILDCARE_PRICING_CONFIGS_COLLECTION = "childcare_pricing_configs";

// ── Errors ───────────────────────────────────────────────────────────────────

export type ChildcarePaymentPolicyErrorCode =
  | "policy_unavailable"
  | "pricing_unset"
  | "pricing_config_missing"
  | "pricing_config_invalid"
  | "metadata_contract_violation";

export class ChildcarePaymentPolicyError extends Error {
  code: ChildcarePaymentPolicyErrorCode;
  constructor(code: ChildcarePaymentPolicyErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ChildcarePaymentPolicyError";
    this.code = code;
  }
}

// ── Pricing snapshot (frozen on the booking at payment setup) ────────────────

export interface ChildcareCancellationWindow {
  /** Window boundary: applies when cancellation happens >= this many hours before start. */
  hoursBeforeStart: number;
  /** Percent of any already-collected occurrence charge refundable in this window (0-100). */
  refundPercent: number;
}

export interface ChildcarePricingSnapshot {
  /** jurisdiction_care_policies policyVersion this snapshot was resolved under. */
  policyVersion: string;
  currency: "usd";
  /** Platform fee charged ON TOP of the caregiver's gross (rate of gross). */
  platformFeeRate: number;
  /** Platform fee floor in cents. */
  platformFeeMinCents: number;
  cancellation: {
    /** Sorted descending by hoursBeforeStart; evaluation picks the first match. */
    windows: ChildcareCancellationWindow[];
    /** Refund percent applied when the PROVIDER no-shows (0-100). */
    providerNoShowRefundPercent: number;
  };
  refund: {
    /** Family-initiated refund request window after checkout, in hours. */
    windowHours: number;
    allowPartial: boolean;
    /** Max percent of a charged occurrence refundable via self-service (0-100). */
    maxPercent: number;
  };
  /** The refs this snapshot was resolved from (audit trail — opaque IDs). */
  refs: Record<ChildcarePricingRefKey, string>;
  resolvedAt: string;
}

type FirestoreLike = Pick<admin.firestore.Firestore, "collection">;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function requirePercent(v: unknown, field: string): number {
  if (!isFiniteNumber(v) || v < 0 || v > 100) {
    throw new ChildcarePaymentPolicyError(
      "pricing_config_invalid",
      `${field} must be a number between 0 and 100`,
    );
  }
  return v;
}

async function loadPricingConfig(
  db: FirestoreLike,
  refId: string,
  expectedKind: string,
): Promise<Record<string, unknown>> {
  const snap = await db.collection(CHILDCARE_PRICING_CONFIGS_COLLECTION).doc(refId).get();
  if (!snap.exists) {
    throw new ChildcarePaymentPolicyError(
      "pricing_config_missing",
      `childcare_pricing_configs/${refId} does not exist`,
    );
  }
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  if (data.kind !== expectedKind) {
    throw new ChildcarePaymentPolicyError(
      "pricing_config_invalid",
      `childcare_pricing_configs/${refId} kind "${String(data.kind)}" != "${expectedKind}"`,
    );
  }
  return data;
}

/** Unpopulated = null/undefined/empty/FILL_IN-prefixed (jurisdictionPolicy convention). */
function isUnpopulatedRef(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v !== "string") return true;
  const t = v.trim();
  return t.length === 0 || t.startsWith("FILL_IN");
}

/**
 * THE childcare pricing gate (R40). Resolves the jurisdiction policy's pricing
 * refs into a concrete, validated snapshot. FAIL CLOSED: every one of the six
 * refs must be populated (mirroring evaluatePolicyReadiness), and the three
 * money-bearing configs (caregiver fee, cancellation policy, refund policy)
 * must exist and validate. No senior fallback exists on any path.
 */
export async function resolveChildcarePricingSnapshot(opts: {
  state: string;
  db?: FirestoreLike;
  now?: Date;
  /** Injectable pre-loaded policy (tests / callers that already loaded it). */
  policy?: Partial<JurisdictionCarePolicy> | null;
}): Promise<ChildcarePricingSnapshot> {
  const db = opts.db ?? admin.firestore();
  const now = opts.now ?? new Date();
  const policy = opts.policy !== undefined
    ? opts.policy
    : await loadJurisdictionPolicy(opts.state, db);
  if (!policy) {
    throw new ChildcarePaymentPolicyError(
      "policy_unavailable",
      `No jurisdiction policy for "${opts.state}" — childcare payment setup refuses`,
    );
  }

  const refs = {} as Record<ChildcarePricingRefKey, string>;
  for (const key of CHILDCARE_PRICING_REF_KEYS) {
    const ref = policy.pricing?.[key];
    if (isUnpopulatedRef(ref)) {
      throw new ChildcarePaymentPolicyError(
        "pricing_unset",
        `pricing.${key} is unset — unset pricing refs refuse payment setup (R40)`,
      );
    }
    refs[key] = String(ref);
  }

  const [feeConfig, cancellationConfig, refundConfig] = await Promise.all([
    loadPricingConfig(db, refs.caregiverFeeRef, "caregiver_fee"),
    loadPricingConfig(db, refs.cancellationPolicyRef, "cancellation_policy"),
    loadPricingConfig(db, refs.refundPolicyRef, "refund_policy"),
  ]);

  const platformFeeRate = feeConfig.platformFeeRate;
  if (!isFiniteNumber(platformFeeRate) || platformFeeRate < 0 || platformFeeRate > 0.5) {
    throw new ChildcarePaymentPolicyError(
      "pricing_config_invalid",
      "caregiver_fee.platformFeeRate must be a number in [0, 0.5]",
    );
  }
  const platformFeeMinCents = feeConfig.platformFeeMinCents;
  if (!Number.isInteger(platformFeeMinCents) || (platformFeeMinCents as number) < 0) {
    throw new ChildcarePaymentPolicyError(
      "pricing_config_invalid",
      "caregiver_fee.platformFeeMinCents must be a non-negative integer",
    );
  }
  if (feeConfig.currency !== "usd") {
    throw new ChildcarePaymentPolicyError(
      "pricing_config_invalid",
      "caregiver_fee.currency must be 'usd' (international is out of scope)",
    );
  }

  const rawWindows = Array.isArray(cancellationConfig.windows) ? cancellationConfig.windows : null;
  if (!rawWindows || rawWindows.length === 0) {
    throw new ChildcarePaymentPolicyError(
      "pricing_config_invalid",
      "cancellation_policy.windows must be a non-empty array",
    );
  }
  const windows: ChildcareCancellationWindow[] = rawWindows
    .map((w: unknown) => {
      const r = (w ?? {}) as Record<string, unknown>;
      if (!isFiniteNumber(r.hoursBeforeStart) || r.hoursBeforeStart < 0) {
        throw new ChildcarePaymentPolicyError(
          "pricing_config_invalid",
          "cancellation_policy window hoursBeforeStart must be a non-negative number",
        );
      }
      return {
        hoursBeforeStart: r.hoursBeforeStart,
        refundPercent: requirePercent(r.refundPercent, "cancellation window refundPercent"),
      };
    })
    .sort((a, b) => b.hoursBeforeStart - a.hoursBeforeStart);

  const snapshot: ChildcarePricingSnapshot = {
    policyVersion: String(policy.policyVersion ?? ""),
    currency: "usd",
    platformFeeRate,
    platformFeeMinCents: platformFeeMinCents as number,
    cancellation: {
      windows,
      providerNoShowRefundPercent: requirePercent(
        cancellationConfig.providerNoShowRefundPercent,
        "cancellation_policy.providerNoShowRefundPercent",
      ),
    },
    refund: {
      windowHours: (() => {
        if (!isFiniteNumber(refundConfig.windowHours) || refundConfig.windowHours <= 0) {
          throw new ChildcarePaymentPolicyError(
            "pricing_config_invalid",
            "refund_policy.windowHours must be a positive number",
          );
        }
        return refundConfig.windowHours;
      })(),
      allowPartial: refundConfig.allowPartial === true,
      maxPercent: requirePercent(refundConfig.maxPercent, "refund_policy.maxPercent"),
    },
    refs,
    resolvedAt: now.toISOString(),
  };
  return snapshot;
}

// ── Fee math (pure) ──────────────────────────────────────────────────────────

/**
 * Childcare platform fee in cents, from the booking's FROZEN pricing snapshot.
 * Never reads senior fee constants. Throws when the fee fields are absent or
 * malformed (fail closed — a childcare charge without childcare pricing is a
 * bug, not a fallback opportunity).
 */
export function childcarePlatformFeeCents(
  grossCents: number,
  fee: { platformFeeRate?: unknown; platformFeeMinCents?: unknown } | null | undefined,
): number {
  if (!Number.isInteger(grossCents) || grossCents <= 0) {
    throw new ChildcarePaymentPolicyError("pricing_config_invalid", "grossCents must be a positive integer");
  }
  const rate = fee?.platformFeeRate;
  const minCents = fee?.platformFeeMinCents;
  if (!isFiniteNumber(rate) || rate < 0 || rate > 0.5 || !Number.isInteger(minCents) || (minCents as number) < 0) {
    throw new ChildcarePaymentPolicyError(
      "pricing_config_invalid",
      "childcare fee snapshot missing/invalid — childcare charges fail closed without policy pricing (R40)",
    );
  }
  return Math.max(Math.round(grossCents * rate), minCents as number);
}

/**
 * The processShiftPayment seam: fee for a childcare shiftHours doc from its
 * stamped `childcarePricing` snapshot. Senior docs never reach this function.
 */
export function childcareFeeCentsForShift(
  shift: { careVertical?: unknown; childcarePricing?: unknown },
  grossCents: number,
): number {
  if (shift.careVertical !== "child") {
    throw new ChildcarePaymentPolicyError(
      "pricing_config_invalid",
      "childcareFeeCentsForShift called for a non-childcare shift",
    );
  }
  const pricing = (shift.childcarePricing ?? null) as
    | { platformFeeRate?: unknown; platformFeeMinCents?: unknown }
    | null;
  return childcarePlatformFeeCents(grossCents, pricing);
}

// ── Cancellation / refund policy evaluation (pure) ───────────────────────────

export interface CancellationEvaluation {
  /** Hours between the cancellation moment and the next occurrence start. */
  hoursBeforeStart: number;
  /** Policy refund percent for already-collected charges in this window. */
  refundPercent: number;
  /** The matched window (null = inside the smallest window → its percent). */
  matchedWindowHours: number | null;
}

/**
 * Evaluate the cancellation policy for a cancellation happening `nowMs`
 * against an occurrence starting `occurrenceStartMs`. Windows are sorted
 * descending; the first window whose boundary is met wins. Cancelling with
 * LESS notice than every window falls to the last (smallest) window's percent.
 */
export function evaluateChildcareCancellation(
  snapshot: Pick<ChildcarePricingSnapshot, "cancellation">,
  occurrenceStartMs: number,
  nowMs: number,
): CancellationEvaluation {
  const hoursBeforeStart = Math.max(0, (occurrenceStartMs - nowMs) / (60 * 60 * 1000));
  const windows = snapshot.cancellation.windows;
  for (const w of windows) {
    if (hoursBeforeStart >= w.hoursBeforeStart) {
      return { hoursBeforeStart, refundPercent: w.refundPercent, matchedWindowHours: w.hoursBeforeStart };
    }
  }
  const last = windows[windows.length - 1];
  return { hoursBeforeStart, refundPercent: last?.refundPercent ?? 0, matchedWindowHours: null };
}

export interface RefundEvaluation {
  allowed: boolean;
  reasonCode: "ok" | "refund_window_closed" | "partial_not_allowed" | "exceeds_policy_max";
  /** Max refundable cents under policy for this occurrence. */
  maxRefundableCents: number;
}

/**
 * Family-initiated refund request policy for one CHARGED occurrence.
 * `checkoutMs` is when the occurrence completed (checkout); requests after the
 * policy window fail closed (admin can still act through the existing
 * refundRequests review machinery).
 */
export function evaluateChildcareRefundRequest(
  snapshot: Pick<ChildcarePricingSnapshot, "refund">,
  params: { chargedCents: number; requestedCents: number | null; checkoutMs: number; nowMs: number },
): RefundEvaluation {
  const { refund } = snapshot;
  const maxRefundableCents = Math.floor((params.chargedCents * refund.maxPercent) / 100);
  const windowMs = refund.windowHours * 60 * 60 * 1000;
  if (params.nowMs - params.checkoutMs > windowMs) {
    return { allowed: false, reasonCode: "refund_window_closed", maxRefundableCents };
  }
  if (params.requestedCents !== null) {
    if (params.requestedCents > maxRefundableCents) {
      return { allowed: false, reasonCode: "exceeds_policy_max", maxRefundableCents };
    }
    if (!refund.allowPartial && params.requestedCents !== maxRefundableCents) {
      return { allowed: false, reasonCode: "partial_not_allowed", maxRefundableCents };
    }
  }
  return { allowed: true, reasonCode: "ok", maxRefundableCents };
}

// ── Stripe metadata contract (R57 — opaque IDs only, exact key sets) ─────────

/** Exact metadata keys on the childcare payment-setup SetupIntent. */
export const CHILDCARE_SETUP_METADATA_KEYS = ["childcareBookingId", "householdId"] as const;

/**
 * Exact metadata keys on a childcare occurrence CHARGE PaymentIntent — the
 * senior trio (appointmentId/shiftHoursId/paymentGeneration, kept so every
 * existing webhook/reconcile path correlates identically) plus the childcare
 * ledger correlation (R39).
 */
export const CHILDCARE_CHARGE_METADATA_KEYS = [
  "appointmentId",
  "shiftHoursId",
  "paymentGeneration",
  "careVertical",
  "childcareBookingId",
  "childcareShiftId",
] as const;

/** Exact metadata keys on a childcare refund. */
export const CHILDCARE_REFUND_METADATA_KEYS = [
  "requestId",
  "clientId",
  "appointmentId",
  "paymentGeneration",
  "careVertical",
  "childcareBookingId",
] as const;

/**
 * Assert a childcare Stripe metadata object matches its pinned key set
 * EXACTLY and every value is a bounded opaque string. Throws on drift — a new
 * key (which could smuggle child data into Stripe) fails closed at the send
 * site, not in review.
 */
export function assertChildSafeStripeMetadata(
  metadata: Record<string, unknown>,
  allowedKeys: readonly string[],
  site: string,
): void {
  const keys = Object.keys(metadata).sort();
  const expected = [...allowedKeys].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new ChildcarePaymentPolicyError(
      "metadata_contract_violation",
      `${site}: childcare Stripe metadata keys [${keys.join(",")}] != pinned [${expected.join(",")}]`,
    );
  }
  for (const [k, v] of Object.entries(metadata)) {
    if (typeof v !== "string" || v.length === 0 || v.length > 256) {
      throw new ChildcarePaymentPolicyError(
        "metadata_contract_violation",
        `${site}: metadata "${k}" must be a non-empty string <= 256 chars (opaque ID)`,
      );
    }
  }
}

export function childcareSetupMetadata(bookingId: string, householdId: string): Record<string, string> {
  const metadata = { childcareBookingId: bookingId, householdId };
  assertChildSafeStripeMetadata(metadata, CHILDCARE_SETUP_METADATA_KEYS, "childcareSetupMetadata");
  return metadata;
}
