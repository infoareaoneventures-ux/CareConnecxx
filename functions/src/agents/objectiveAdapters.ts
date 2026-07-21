// Read-through projection adapters: legacy in-flight-work stores → the
// canonical objective shape (plan 2026-07-18-001 U3, R15, KTD5).
//
// KTD5's bridge discipline: legacy stores stay AUTHORITATIVE until each flow
// crosses an atomic bridge with drain proof. Until then, adapters project
// legacy records into AgentObjective-shaped READ-ONLY views so foreground
// selection, WIP aggregation, and shadow comparison can treat all in-flight
// work uniformly. Projections are never persisted to agent_objectives —
// `version: 0` marks a view; the ledger's optimistic-concurrency writes start
// at version 1, so a projection can never be transitioned by mistake
// (applyTransition on it is fine in memory, but transitionObjective requires
// a stored doc).
//
// Wave 1 consumer: the qaAgent objective_ledger shadow compare (log-only).

import type { AgentObjective } from "./objectiveLedger";
import { sanitizePromptContext } from "./promptContext";

// Structural shape of qaAgent's legacy ActiveGoal — duck-typed here instead of
// importing qaAgent (the adapter must stay a leaf module; qaAgent imports us).
export interface LegacyActiveGoal {
  type: "booking" | "matching" | "qa_multi_step";
  description: string;
  startedAt: string;
  turnsRemaining: number;
  context: Record<string, unknown>;
  expiresAt?: string;
}

const LEGACY_DEFAULT_HORIZON_MS = 24 * 60 * 60 * 1000;

/** Mirrors qaAgent.resumeActiveGoal's staleness rule exactly (parity!). */
export function isLegacyGoalStale(goal: LegacyActiveGoal, now: Date = new Date()): boolean {
  const age = goal.startedAt ? now.getTime() - new Date(goal.startedAt).getTime() : Infinity;
  const pastHorizon = goal.expiresAt
    ? goal.expiresAt < now.toISOString()
    : age > LEGACY_DEFAULT_HORIZON_MS;
  return goal.turnsRemaining <= 0 || pastHorizon;
}

/**
 * Project a legacy activeGoal into a read-only AgentObjective view. Statuses:
 * stale → expired (terminal view), otherwise active. The context map is NOT
 * copied into the projection — it may hold free text; the shadow consumer
 * only needs presence/status, and later consumers read context from the
 * authoritative legacy store itself.
 */
export function projectActiveGoal(
  goal: LegacyActiveGoal,
  ids: { phone: string; userId: string; seniorId?: string; role: AgentObjective["role"]; channel: AgentObjective["channel"] },
  now: Date = new Date(),
): AgentObjective {
  const stale = isLegacyGoalStale(goal, now);
  return {
    objectiveId: `legacy-activegoal:${ids.phone}`,
    userId: ids.userId,
    seniorId: ids.seniorId,
    role: ids.role,
    channel: ids.channel,
    intent: `legacy.${goal.type}`,
    description: sanitizePromptContext(goal.description, 200) || undefined,
    status: stale ? "expired" : "active",
    steps: [],
    missingInputs: [],
    version: 0, // projection marker — never a persisted ledger version
    createdAt: goal.startedAt,
    updatedAt: goal.startedAt,
    expiresAt: goal.expiresAt
      ?? (goal.startedAt ? new Date(new Date(goal.startedAt).getTime() + LEGACY_DEFAULT_HORIZON_MS).toISOString() : undefined),
    terminalReason: stale ? "legacy_goal_stale" : undefined,
  };
}

/** True when an objective is a read-only legacy projection, not a ledger doc. */
export function isProjection(objective: AgentObjective): boolean {
  return objective.version === 0;
}
