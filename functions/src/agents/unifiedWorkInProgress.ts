// Unified work-in-progress aggregate (plan 2026-07-18-001 U3, R15).
//
// ONE contract for "what is currently in flight for this user": ledger
// objectives plus the legacy activeGoal (as a read-only projection), with the
// deterministic foreground marked. Wave 1 ships this dark — get_work_in_
// progress and the prompts keep their current sources until the objective_
// ledger capability enables, at which point they consume THIS aggregate so
// there is exactly one user-visible definition of in-flight work (R15).
//
// Legacy stores remain authoritative (KTD5): this module never writes; a
// stale legacy goal is excluded here exactly as resumeActiveGoal would
// expire it, so the aggregate and the legacy behavior can't disagree.

import * as admin from "firebase-admin";
import { loadOpenObjectives, selectForegroundObjective, type AgentObjective } from "./objectiveLedger";
import { projectActiveGoal, isLegacyGoalStale, type LegacyActiveGoal } from "./objectiveAdapters";

export interface UnifiedWorkInProgress {
  /** Nonterminal work items, ledger docs and legacy projections alike. */
  items: AgentObjective[];
  /** objectiveId of the deterministic foreground item, or null. */
  foregroundId: string | null;
  /** Content-free source accounting for shadow/parity telemetry. */
  sources: { ledger: number; legacyGoal: "none" | "live" | "stale" };
}

export async function loadUnifiedWorkInProgress(params: {
  userId: string;
  phone: string;
  role: AgentObjective["role"];
  channel: AgentObjective["channel"];
  seniorId?: string;
  /** The already-loaded agent_sessions doc — its activeGoal is read in-hand, no extra fetch. */
  session?: Record<string, unknown> | null;
  db?: admin.firestore.Firestore;
  now?: Date;
}): Promise<UnifiedWorkInProgress> {
  const now = params.now ?? new Date();
  const items: AgentObjective[] = [];

  const legacyGoal = (params.session as { activeGoal?: LegacyActiveGoal } | null | undefined)?.activeGoal;
  let legacyState: UnifiedWorkInProgress["sources"]["legacyGoal"] = "none";
  if (legacyGoal) {
    if (isLegacyGoalStale(legacyGoal, now)) {
      // Mirror resumeActiveGoal: a stale goal is expired context, not WIP.
      legacyState = "stale";
    } else {
      legacyState = "live";
      items.push(projectActiveGoal(legacyGoal, {
        phone: params.phone,
        userId: params.userId,
        seniorId: params.seniorId,
        role: params.role,
        channel: params.channel,
      }, now));
    }
  }

  const ledgerObjectives = await loadOpenObjectives(params.userId, { db: params.db, limit: 10 });
  items.push(...ledgerObjectives);

  const foreground = selectForegroundObjective(items);
  return {
    items,
    foregroundId: foreground?.objectiveId ?? null,
    sources: { ledger: ledgerObjectives.length, legacyGoal: legacyState },
  };
}
