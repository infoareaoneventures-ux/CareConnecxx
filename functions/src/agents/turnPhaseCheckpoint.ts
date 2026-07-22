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
  updatedAt: string;
  expiresAt: string; // ISO; load treats past-expiry as absent
}

export async function writePhaseCheckpoint(
  identity: SourceTurnIdentity,
  phase: LifecyclePhase,
  opts?: {
    objectiveId?: string;
    completedActionKeys?: string[];
    db?: admin.firestore.Firestore;
    now?: Date;
  },
): Promise<{ key: string }> {
  const db = opts?.db ?? admin.firestore();
  const now = opts?.now ?? new Date();
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

  const snap = await db.collection(PHASE_CHECKPOINT_COLLECTION).doc(key).get();
  if (!snap.exists) return null;
  const doc = snap.data() as PhaseCheckpointDoc | undefined;
  if (!doc || doc.schema !== "phase-v1") return null; // legacy rescue doc shape — not ours
  if (!doc.expiresAt || Date.parse(doc.expiresAt) <= now.getTime()) return null;
  if (!validateSourceTurn(identity, { key, bindings: doc.bindings })) return null;
  return doc;
}
