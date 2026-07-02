import * as admin from "firebase-admin";
import { createHash } from "crypto";

export const CARA_ACTION_EXECUTION_COLLECTION = "cara_action_execution_ledger";
// Reclaim window for a claim stuck "running" (crashed before settling).
// 2x the 180s function ceiling — nothing legitimately runs longer.
const STALE_ACTION_CLAIM_MS = 6 * 60 * 1000;
// How long a settled ("done") result blocks re-execution. Long enough to absorb
// in-turn duplicates and webhook redeliveries; short enough that a legitimate
// repeat (resend link, re-add member) actually re-runs instead of replaying a
// stale cached result forever.
export const DONE_RESULT_TTL_MS = 15 * 60 * 1000;

export class CaraActionClaimUnavailableError extends Error {
  constructor(key: string) {
    super(`action execution ledger unavailable — refusing to run fail-closed action for key ${key}`);
    this.name = "CaraActionClaimUnavailableError";
  }
}

export type CaraActionExecutionClaim =
  | { cached: true; result: unknown }
  | { cached: false }
  | { inProgress: true };

export interface CaraActionExecutionStore {
  claim(key: string): Promise<CaraActionExecutionClaim>;
  settle(key: string, outcome: { ok: true; result: unknown } | { ok: false }): Promise<void>;
}

let storeOverride: CaraActionExecutionStore | null = null;

export function setCaraActionExecutionStoreForTest(store: CaraActionExecutionStore | null): void {
  storeOverride = store;
}

export async function claimCaraActionExecution(
  key: string,
  opts?: { failClosed?: boolean },
): Promise<CaraActionExecutionClaim> {
  if (storeOverride) return storeOverride.claim(key);

  try {
    const docKey = keyToDocId(key);
    const ref = admin.firestore().collection(CARA_ACTION_EXECUTION_COLLECTION).doc(docKey);
    try {
      await ref.create({
        key,
        status: "running",
        claimedAt: new Date().toISOString(),
        claimedAtMs: Date.now(),
      });
      return { cached: false };
    } catch {
      return await admin.firestore().runTransaction<CaraActionExecutionClaim>(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) {
          tx.set(ref, {
            key,
            status: "running",
            claimedAt: new Date().toISOString(),
            claimedAtMs: Date.now(),
          });
          return { cached: false };
        }

        const data = snap.data() ?? {};
        if (data.status === "done") {
          const settledAtMs = typeof data.settledAtMs === "number"
            ? data.settledAtMs
            : Date.parse(String(data.settledAt ?? "")) || 0;
          const doneExpired = Date.now() - settledAtMs > DONE_RESULT_TTL_MS;
          if (!doneExpired) {
            return { cached: true, result: data.result ?? null };
          }
          // Settled result is past its duplicate-protection window — a repeat
          // request (resend link, re-add member) is legitimate. Reclaim and re-run.
          tx.set(ref, {
            key,
            status: "running",
            claimedAt: new Date().toISOString(),
            claimedAtMs: Date.now(),
            reclaimed: true,
          }, { merge: true });
          return { cached: false };
        }

        const claimedAtMs = typeof data.claimedAtMs === "number"
          ? data.claimedAtMs
          : Date.parse(String(data.claimedAt ?? "")) || 0;
        const isStale = Date.now() - claimedAtMs > STALE_ACTION_CLAIM_MS;
        if (!isStale) {
          return { inProgress: true };
        }

        tx.set(ref, {
          key,
          status: "running",
          claimedAt: new Date().toISOString(),
          claimedAtMs: Date.now(),
          reclaimed: true,
        }, { merge: true });
        return { cached: false };
      });
    }
  } catch (err) {
    if (err instanceof CaraActionClaimUnavailableError) throw err;
    if (opts?.failClosed) {
      // Money-adjacent actions must not execute when duplicate protection is
      // unverifiable — refusing beats a possible double charge/booking.
      console.error("actionExecutionLedger: claim failed closed — refusing fail-closed action", { key, error: String(err) });
      throw new CaraActionClaimUnavailableError(key);
    }
    // Fail-open: duplicate protection is offline for this call. Loud so
    // incident review can see the dedupe was degraded (cf. webhookLedger).
    console.error("actionExecutionLedger: claim failed open — duplicate protection offline for this call", { key, error: String(err) });
    return { cached: false };
  }
}

export async function settleCaraActionExecution(
  key: string,
  outcome: { ok: true; result: unknown } | { ok: false },
): Promise<void> {
  if (storeOverride) {
    await storeOverride.settle(key, outcome);
    return;
  }

  try {
    const ref = admin.firestore().collection(CARA_ACTION_EXECUTION_COLLECTION).doc(keyToDocId(key));
    if (outcome.ok) {
      const safe = JSON.parse(JSON.stringify(outcome.result ?? null));
      await ref.set({
        status: "done",
        result: safe,
        settledAt: new Date().toISOString(),
        settledAtMs: Date.now(),
      }, { merge: true });
    } else {
      await ref.delete();
    }
  } catch (err) {
    // Best effort only. A missed settlement risks one retry, but must not block
    // the user-facing action that already completed.
    console.error("actionExecutionLedger: settle failed — claim may be stranded until stale-reclaim", { key, ok: outcome.ok, error: String(err) });
  }
}

// Remove a settled claim so a logically-inverse action (remove after add,
// add after remove) can execute inside the done-TTL window instead of
// replaying the stale cached result. Best-effort — a missed clear degrades
// to the TTL expiry, never to a wrong result.
export async function clearCaraActionExecution(key: string): Promise<void> {
  if (storeOverride) {
    await storeOverride.settle(key, { ok: false });
    return;
  }
  try {
    await admin.firestore().collection(CARA_ACTION_EXECUTION_COLLECTION).doc(keyToDocId(key)).delete();
  } catch (err) {
    console.error("actionExecutionLedger: clear failed — inverse action may be blocked until TTL", { key, error: String(err) });
  }
}

function keyToDocId(key: string): string {
  return createHash("sha1").update(key).digest("hex");
}
