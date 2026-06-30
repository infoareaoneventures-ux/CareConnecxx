import * as admin from "firebase-admin";
import { createHash } from "crypto";

export const CARA_ACTION_EXECUTION_COLLECTION = "cara_action_execution_ledger";

export type CaraActionExecutionClaim =
  | { cached: true; result: unknown }
  | { cached: false };

export interface CaraActionExecutionStore {
  claim(key: string): Promise<CaraActionExecutionClaim>;
  settle(key: string, outcome: { ok: true; result: unknown } | { ok: false }): Promise<void>;
}

let storeOverride: CaraActionExecutionStore | null = null;

export function setCaraActionExecutionStoreForTest(store: CaraActionExecutionStore | null): void {
  storeOverride = store;
}

export async function claimCaraActionExecution(key: string): Promise<CaraActionExecutionClaim> {
  if (storeOverride) return storeOverride.claim(key);

  try {
    const docKey = keyToDocId(key);
    const ref = admin.firestore().collection(CARA_ACTION_EXECUTION_COLLECTION).doc(docKey);
    try {
      await ref.create({
        key,
        status: "running",
        claimedAt: new Date().toISOString(),
      });
      return { cached: false };
    } catch {
      return await admin.firestore().runTransaction<CaraActionExecutionClaim>(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) {
          tx.set(ref, { key, status: "running", claimedAt: new Date().toISOString() });
          return { cached: false };
        }

        const data = snap.data() ?? {};
        if (data.status === "done") {
          return { cached: true, result: data.result ?? null };
        }

        tx.set(ref, {
          key,
          status: "running",
          claimedAt: new Date().toISOString(),
          reclaimed: true,
        }, { merge: true });
        return { cached: false };
      });
    }
  } catch {
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
      }, { merge: true });
    } else {
      await ref.delete();
    }
  } catch {
    // Best effort only. A missed settlement risks one retry, but must not block
    // the user-facing action that already completed.
  }
}

function keyToDocId(key: string): string {
  return createHash("sha1").update(key).digest("hex");
}
