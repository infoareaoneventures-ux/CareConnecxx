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
// redeliveries. A "running" claim left by a crashed handler becomes reclaimable
// after STALE_CLAIM_MS so a later replay is never permanently blocked. Ledger
// infrastructure errors fail OPEN (run anyway): at-least-once beats dropping a
// confirmed action the user explicitly approved.

export const TOOL_EXECUTION_COLLECTION = "tool_execution_ledger";
// Firebase Function v1 max execution is 9 min; 10 min is safely above that so
// any live claim older than this must be from a crashed handler.
const STALE_CLAIM_MS = 10 * 60 * 1000;

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

/** Stable JSON (sorted keys recursively) → short sha1 hex. */
function stableHash(input: unknown): string {
  const sorted = sortObject(input);
  return createHash("sha1").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

function sortObject(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return obj;
  }
  return Object.keys(obj)
    .sort()
    .reduce((acc, key) => {
      acc[key] = sortObject((obj as Record<string, unknown>)[key]);
      return acc;
    }, {} as Record<string, unknown>);
}

export type ToolClaim =
  | { cached: true;  result: unknown }
  | { cached: false };

export interface ToolExecutionBinding {
  operationId: string;
  careVertical: "senior" | "child";
  principalId: string;
  objectType: string;
  objectId: string;
  actionName: string;
  sourceTurnKey: string;
  expiresAt: string;
}

export async function claimToolExecution(
  key: string,
  opts: { strict?: boolean; binding?: ToolExecutionBinding } = {},
): Promise<ToolClaim> {
  try {
    const ref = admin.firestore().collection(TOOL_EXECUTION_COLLECTION).doc(key);
    try {
      await ref.create({
        status: "running",
        claimedAtMs: Date.now(),
        ...(opts.binding ? { binding: opts.binding } : {}),
      });
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
        if (
          opts.binding &&
          (!data.binding ||
            data.binding.operationId !== opts.binding.operationId ||
            data.binding.careVertical !== opts.binding.careVertical ||
            data.binding.principalId !== opts.binding.principalId ||
            data.binding.objectType !== opts.binding.objectType ||
            data.binding.objectId !== opts.binding.objectId ||
            data.binding.actionName !== opts.binding.actionName ||
            data.binding.sourceTurnKey !== opts.binding.sourceTurnKey ||
            data.binding.expiresAt !== opts.binding.expiresAt)
        ) {
          throw new Error("toolExecutionLedger: immutable operation binding mismatch");
        }
        if (data.status === "done") {
          return { cached: true, result: data.result ?? null };
        }
        // status "running": a prior run crashed before settling (or an extremely
        // unlikely true concurrent call). The per-phone inbound lock prevents
        // real concurrency, so any "running" claim past STALE_CLAIM_MS is a crash.
        // Within the window, fail open anyway — at-least-once beats blocking.
        const claimedAtMs = typeof data.claimedAtMs === "number" ? data.claimedAtMs : 0;
        const isStale = Date.now() - claimedAtMs > STALE_CLAIM_MS;
        tx.update(ref, {
          status: "running",
          claimedAtMs: Date.now(),
          reclaimed: true,
          ...(isStale && { staleClaim: true }),
        });
        return { cached: false };
      });
    }
  } catch (err) {
    if (opts.strict) throw err;
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
