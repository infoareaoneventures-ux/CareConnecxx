// Objective expiry sweeper (plan 2026-07-18-001 U3, retention matrix).
//
// Hourly: nonterminal objectives whose expiresAt has passed are TRANSITIONED
// to `expired` through the ledger's optimistic-concurrency path — never
// deleted, never bulk-updated around the transition matrix. A version
// conflict (someone advanced the objective mid-sweep) is skipped and retried
// next pass, which is exactly the safe behavior.
//
// Query contract Q29: agent_objectives (status ASC, expiresAt ASC). The `in`
// filter over nonterminal statuses fans out per status value on the same
// composite. Content-free logging only (R52).

import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import {
  OBJECTIVES_COLLECTION,
  transitionObjective,
  isExpiryEligible,
  type AgentObjective,
} from "../agents/objectiveLedger";

const db = admin.firestore();

const SWEEP_LIMIT = 50;

export async function runObjectiveExpirySweep(now: Date = new Date()): Promise<{
  scanned: number; expired: number; conflicts: number; errors: number;
}> {
  const stats = { scanned: 0, expired: 0, conflicts: 0, errors: 0 };

  const snap = await db.collection(OBJECTIVES_COLLECTION)
    .where("status", "in", ["active", "waiting_user", "waiting_external", "blocked", "paused"])
    .where("expiresAt", "<=", now.toISOString())
    .orderBy("expiresAt", "asc")
    .limit(SWEEP_LIMIT)
    .get();

  for (const doc of snap.docs) {
    const objective = doc.data() as AgentObjective;
    stats.scanned++;
    // Belt-and-braces: the query already filters, but the pure check keeps a
    // malformed doc (bad expiresAt type) from being force-expired.
    if (!isExpiryEligible(objective, now)) continue;
    try {
      await transitionObjective(objective.objectiveId, "expired", objective.version, {
        reason: "expiry_sweep",
        now,
      });
      stats.expired++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("version conflict")) stats.conflicts++;
      else {
        stats.errors++;
        console.warn("objectiveExpirySweep: transition failed", { objectiveId: objective.objectiveId });
      }
    }
  }

  console.info("objectiveExpirySweep.pass", stats);
  return stats;
}

export const sweepExpiredObjectives = functions.pubsub
  .schedule("30 * * * *") // hourly at :30, offset from the reflection pass
  .timeZone("UTC")
  .onRun(() => runObjectiveExpirySweep());
