// Action evidence receipts and postcondition verification (plan
// 2026-07-18-001 U5, R23-R26, KTD8/KTD9).
//
// A consequential write may only support a user-facing completion claim when
// an authoritative postcondition backs it: a fresh canonical read or a
// provider receipt — handler success or schema-valid output alone is NOT
// completion evidence (R24/AE6). Every verification produces an
// EvidenceReceipt with a safe-claim code that tells the response layer what
// may truthfully be said.
//
// Live-at-ship semantics (founder directive 2026-07-22): verification runs
// live wherever an action declares a postcondition. Fail-OPEN on verifier
// infrastructure errors ("unverifiable" — the action result stands, the gap
// is logged); fail-HONEST on real mismatches ("mismatch" — the response
// layer must not claim completion, per AE6).

import * as admin from "firebase-admin";

export type EvidenceKind = "fresh_read" | "provider_receipt" | "handler_output";

export type EvidenceStatus =
  | "verified"      // postcondition observed true against authoritative state
  | "mismatch"      // authoritative state CONTRADICTS the handler's claim
  | "unverifiable"; // verifier errored/timed out — truth unknown, action stands

/** What the response layer may truthfully claim, keyed by evidence status. */
export type SafeClaimCode =
  | "completed_verified"      // verified → may state completion as fact
  | "completed_unconfirmed"   // unverifiable → state action taken, confirmation pending
  | "not_confirmed";          // mismatch → must NOT claim completion (AE6)

export interface EvidenceReceipt {
  actionName: string;
  kind: EvidenceKind;
  status: EvidenceStatus;
  safeClaimCode: SafeClaimCode;
  /** Firestore path or provider object ref that was checked — never payload. */
  targetRef?: string;
  /** Short structured summary of the observed postcondition (no free text). */
  observed?: Record<string, string | number | boolean | null>;
  verifiedAt: string;
  /** How long this evidence may back a claim before a fresh read is needed. */
  freshUntilMs: number;
  idempotencyKey?: string;
}

export interface PostconditionContext {
  db: admin.firestore.Firestore;
  now: Date;
}

export interface PostconditionSpec<TInput = unknown, TOutput = unknown> {
  kind: Exclude<EvidenceKind, "handler_output">;
  /** e.g. "appointments/{id} exists with status pending_caregiver_confirmation" */
  description: string;
  /** Firestore path / provider ref being checked, for the receipt. */
  targetRef: (input: TInput, output: TOutput) => string | undefined;
  /**
   * Reads AUTHORITATIVE state (fresh read or provider receipt) and reports
   * whether it matches the handler's claim. Must never trust `output` as
   * evidence of itself. Throwing = unverifiable (fail-open).
   */
  verify: (
    input: TInput,
    output: TOutput,
    ctx: PostconditionContext,
  ) => Promise<{ ok: boolean; observed?: EvidenceReceipt["observed"] }>;
}

export const EVIDENCE_FRESHNESS_MS = 5 * 60 * 1000;

const CLAIM_BY_STATUS: Record<EvidenceStatus, SafeClaimCode> = {
  verified: "completed_verified",
  unverifiable: "completed_unconfirmed",
  mismatch: "not_confirmed",
};

/** Receipt for actions with no declared postcondition yet (migration state). */
export function handlerOutputReceipt(actionName: string, idempotencyKey?: string, now: Date = new Date()): EvidenceReceipt {
  return {
    actionName,
    kind: "handler_output",
    status: "unverifiable",
    safeClaimCode: "completed_unconfirmed",
    verifiedAt: now.toISOString(),
    freshUntilMs: now.getTime() + EVIDENCE_FRESHNESS_MS,
    idempotencyKey,
  };
}

export async function verifyPostcondition<TInput, TOutput>(
  actionName: string,
  spec: PostconditionSpec<TInput, TOutput>,
  input: TInput,
  output: TOutput,
  opts?: { db?: admin.firestore.Firestore; now?: Date; idempotencyKey?: string },
): Promise<EvidenceReceipt> {
  const now = opts?.now ?? new Date();
  const base = {
    actionName,
    kind: spec.kind,
    targetRef: safeTargetRef(spec, input, output),
    verifiedAt: now.toISOString(),
    freshUntilMs: now.getTime() + EVIDENCE_FRESHNESS_MS,
    idempotencyKey: opts?.idempotencyKey,
  };
  try {
    const result = await spec.verify(input, output, { db: opts?.db ?? admin.firestore(), now });
    const status: EvidenceStatus = result.ok ? "verified" : "mismatch";
    return { ...base, status, safeClaimCode: CLAIM_BY_STATUS[status], observed: result.observed };
  } catch (err) {
    // Fail-open on verifier infrastructure errors: the action stands, the
    // claim downgrades to unconfirmed, and the gap is observable (R24).
    console.warn("actionEvidence: verifier error — receipt unverifiable", {
      actionName,
      reason: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
    return { ...base, status: "unverifiable", safeClaimCode: CLAIM_BY_STATUS.unverifiable };
  }
}

function safeTargetRef<TInput, TOutput>(
  spec: PostconditionSpec<TInput, TOutput>,
  input: TInput,
  output: TOutput,
): string | undefined {
  try {
    return spec.targetRef(input, output);
  } catch {
    return undefined;
  }
}
