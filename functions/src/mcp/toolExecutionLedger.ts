import * as admin from "firebase-admin";
import { createHash } from "crypto";

// Exactly-once guard for CONFIRMED high-risk tool actions (U5).
//
// A confirmed action can be re-driven: the family's "YES" arrives twice, Linq
// redelivers the inbound, or approvalHandler re-invokes the tool. Before U5,
// re-execution was only safe if each handler happened to be idempotent — fine
// for "set status = cancelled" twice, a real hazard the day a tool moves money
// (a second Stripe charge, a second payout). This ledger makes confirmed actions
// idempotent BY CONSTRUCTION:
//
//   claimToolExecution(key)  — if this key already completed, returns the cached
//                              result (caller must NOT re-run); otherwise claims
//                              it and returns {cached:false} (caller runs).
//   settleToolExecution(key) — records the result so a later replay returns it;
//                              a failed run deletes the claim so a retry can
//                              re-drive (a claim must never outlive a failed run).
//
// Concurrency is already prevented upstream by the per-phone inbound lock
// (sessionState.claimInboundProcessing), so the only races here are sequential
// redeliveries. Ledger infrastructure errors fail OPEN (run anyway): at-least-
// once beats dropping a confirmed action the user explicitly approved.

export const TOOL_EXECUTION_COLLECTION = "tool_execution_ledger";

/**
 * Deterministic idempotency key for a confirmed action: the confirmation id, the
 * tool name, and a stable hash of the (injected) input. Two genuinely different
 * inputs under the same confirmation id get different keys and both run; an exact
 * replay collides and returns the cached result.
 */
export function toolExecutionKey(
  confirmedActionId: string,
  toolName: string,
  input: Record<string, unknown>,
): string {
  return `${confirmedActionId}:${toolName}:${stableHash(input)}`;
}

/** Stable JSON (sorted keys) → short sha1 hex, so key order in the input never matters. */
function stableHash(input: Record<string, unknown>): string {
  const json = JSON.stringify(input, Object.keys(flatten(input)).sort());
  return createHash("sha1").update(json).digest("hex").slice(0, 16);
}

// JSON.stringify's replacer-array only sees top-level keys; flatten gathers all
// nested keys so the sorted-key stringify is deterministic across re-orderings.
function flatten(obj: unknown, prefix = "", acc: Record<string, true> = {}): Record<string, true> {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const k of Object.keys(obj as Record<string, unknown>)) {
      acc[k] = true;
      flatten((obj as Record<string, unknown>)[k], `${prefix}${k}.`, acc);
    }
  }
  return acc;
}

export type ToolClaim =
  | { cached: true;  result: unknown }
  | { cached: false };

export async function claimToolExecution(key: string): Promise<ToolClaim> {
  try {
    const ref = admin.firestore().collection(TOOL_EXECUTION_COLLECTION).doc(key);
    try {
      await ref.create({ status: "running", claimedAtMs: Date.now() });
      return { cached: false };
    } catch {
      // ALREADY_EXISTS (or rare infra). Resolve in a transaction.
      return await admin.firestore().runTransaction<ToolClaim>(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) {
          tx.set(ref, { status: "running", claimedAtMs: Date.now() });
          return { cached: false };
        }
        const data = snap.data() ?? {};
        if (data.status === "done") {
          return { cached: true, result: data.result ?? null };
        }
        // status "running": a prior run crashed before settling, or the same turn
        // is re-driving. The per-phone inbound lock rules out true concurrency, so
        // reclaim and re-run safely under a fresh claim.
        tx.update(ref, { status: "running", claimedAtMs: Date.now(), reclaimed: true });
        return { cached: false };
      });
    }
  } catch (err) {
    console.error(`toolExecutionLedger: claim failed open for ${key}:`, err);
    return { cached: false }; // fail open — run the confirmed action (at-least-once)
  }
}

export async function settleToolExecution(
  key: string,
  outcome: { ok: true; result: unknown } | { ok: false },
): Promise<void> {
  try {
    const ref = admin.firestore().collection(TOOL_EXECUTION_COLLECTION).doc(key);
    if (outcome.ok) {
      // Strip undefined (Firestore rejects it) via a JSON round-trip.
      const safe = JSON.parse(JSON.stringify(outcome.result ?? null));
      await ref.set({ status: "done", result: safe, settledAt: new Date().toISOString() }, { merge: true });
    } else {
      await ref.delete();
    }
  } catch (err) {
    // Non-fatal: an unsettled "running" claim expires via STALE_CLAIM_MS, and a
    // missed "done" stamp only risks one replay re-running.
    console.error(`toolExecutionLedger: settle failed for ${key}:`, err);
  }
}
