// Lifecycle phase checkpoints keyed by the server-derived source-turn key
// (plan 2026-07-18-001 U4, R20-R21, Data Changes "agent_turn_checkpoints").
//
// Coexists with the legacy post-loop rescue in turnCheckpoint.ts: that path
// keeps its phone-keyed docs untouched (rollout safety — the old rescue must
// keep working while this ships), while phase checkpoints use derived 32-hex
// document IDs from turnSourceKey, a disjoint key space in the same
// collection. Documents hold structured lifecycle state and binding hashes
// only — no raw tool payloads, no transcript copies, no reasoning (R22).
//
// Wave status: SHADOW — qaAgent writes phase checkpoints (behind the
// fail-closed `turn_lifecycle` capability) and validates loads, but never
// RESUMES from them. Resume lands with U4's replay-test slice.

import * as admin from "firebase-admin";
import {
  deriveSourceTurnKey,
  deriveLegacySourceTurnKey,
  deriveBindings,
  validateSourceTurn,
  type SourceTurnIdentity,
  type SourceTurnBindings,
} from "./turnSourceKey";

export const TURN_LIFECYCLE_CAPABILITY = "turn_lifecycle";

// Shared with the legacy rescue docs (phone-keyed) — derived 32-hex ids can
// never collide with an E.164 phone string.
export const PHASE_CHECKPOINT_COLLECTION = "agent_turn_checkpoints";

// Waiting/recovery window per the plan's retention matrix.
export const PHASE_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

export type LifecyclePhase =
  | "hydrated"   // context + situation loaded, before any model call
  | "planned"    // structured steps exist, before any side effect
  | "acted"      // a committing action ran (completedActionKeys updated)
  | "verified"   // postconditions read back
  | "responded"; // user-facing reply delivered

export interface PhaseCheckpointDoc {
  schema: "phase-v1";
  phase: LifecyclePhase;
  bindings: SourceTurnBindings;
  objectiveId?: string;
  objectiveVersion: number;
  /** Deterministic action keys already committed this turn (replay guard). */
  completedActionKeys: string[];
  /**
   * Typed vertical stamp (childcare U10/KTD18): a checkpoint written on a
   * childcare turn records "child" so a resumed/retried turn can never be
   * re-driven under the wrong vertical. Optional/additive — legacy senior
   * checkpoints have no stamp. Never recipient content (R57).
   */
  careVertical: "senior" | "child";
  updatedAt: string;
  expiresAt: string; // ISO; load treats past-expiry as absent
}

export async function writePhaseCheckpoint(
  identity: SourceTurnIdentity,
  phase: LifecyclePhase,
  opts?: {
    objectiveId?: string;
    completedActionKeys?: string[];
    /** Deprecated compatibility input. Must match identity.careVertical. */
    careVertical?: "senior" | "child";
    db?: admin.firestore.Firestore;
    now?: Date;
  },
): Promise<{ key: string }> {
  const db = opts?.db ?? admin.firestore();
  const now = opts?.now ?? new Date();
  if (opts?.careVertical && opts.careVertical !== identity.careVertical) {
    throw new Error("phase checkpoint vertical does not match turn identity");
  }
  const key = deriveSourceTurnKey(identity);
  const doc: PhaseCheckpointDoc = {
    schema: "phase-v1",
    phase,
    bindings: deriveBindings(identity),
    objectiveVersion: identity.objectiveVersion,
    completedActionKeys: opts?.completedActionKeys ?? [],
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PHASE_CHECKPOINT_TTL_MS).toISOString(),
    ...(opts?.objectiveId ? { objectiveId: opts.objectiveId } : {}),
    careVertical: identity.careVertical,
  };
  await db.collection(PHASE_CHECKPOINT_COLLECTION).doc(key).set(doc);
  return { key };
}

/**
 * Load for resume: null unless the document exists, is unexpired, is a
 * phase-v1 doc, AND the caller's freshly-verified identity reproduces both
 * the document key and every stored binding hash (R21). Any mismatch means
 * "no checkpoint" — the caller runs a fresh turn, never a replay.
 */
export async function loadPhaseCheckpoint(
  identity: SourceTurnIdentity,
  opts?: { db?: admin.firestore.Firestore; now?: Date },
): Promise<PhaseCheckpointDoc | null> {
  const db = opts?.db ?? admin.firestore();
  const now = opts?.now ?? new Date();

  let key: string;
  try {
    key = deriveSourceTurnKey(identity);
  } catch {
    return null; // incomplete identity can never load state
  }

  let snap = await db.collection(PHASE_CHECKPOINT_COLLECTION).doc(key).get();
  let legacySenior = false;
  if (!snap.exists && identity.careVertical === "senior") {
    key = deriveLegacySourceTurnKey(identity);
    snap = await db.collection(PHASE_CHECKPOINT_COLLECTION).doc(key).get();
    legacySenior = snap.exists;
  }
  if (!snap.exists) return null;
  const doc = snap.data() as PhaseCheckpointDoc | undefined;
  if (!doc || doc.schema !== "phase-v1") return null; // legacy rescue doc shape — not ours
  if (doc.careVertical && doc.careVertical !== identity.careVertical) return null;
  if (!doc.careVertical && !legacySenior) return null;
  if (!doc.expiresAt || Date.parse(doc.expiresAt) <= now.getTime()) return null;
  if (legacySenior) {
    const fresh = deriveBindings(identity);
    if (
      doc.bindings.principalHash !== fresh.principalHash
      || doc.bindings.channelBindingHash !== fresh.channelBindingHash
    ) return null;
  } else if (!validateSourceTurn(identity, { key, bindings: doc.bindings })) {
    return null;
  }
  return doc;
}

/**
 * Model-facing directive for a RETRIED turn whose checkpoint shows committed
 * side effects (R21: post-write resume goes to VERIFY, never act). Empty when
 * the checkpoint carries nothing actionable. Action keys are deterministic
 * name+input hashes — safe for the prompt, no payload content.
 */
export function buildResumeDirective(cp: PhaseCheckpointDoc | null): string {
  if (!cp) return "";
  if (cp.phase !== "acted" && cp.phase !== "verified" && cp.phase !== "responded") return "";
  if (cp.completedActionKeys.length === 0) return "";
  return [
    "RETRY NOTICE: this exact inbound message was already partially processed on a previous attempt.",
    `State-changing actions that ALREADY COMPLETED (do NOT run these tools again for the same purpose): ${cp.completedActionKeys.join(", ")}.`,
    "Use read tools to verify the current state if needed, then respond to the user from verified state. If the work is already done, confirm it — never repeat a completed side effect.",
  ].join(" ");
}
