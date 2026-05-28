import * as admin from "firebase-admin";

// Turn checkpointing — Sprint 8 (post-process phase only).
//
// Problem: runQaAgent's tool loop can produce a fully-formed reply, then crash
// or hang in the post-process phase (grounding/format rewrites, the supervisor
// Haiku call, or the Linq send). When that happens the process dies, the family
// gets silence, and the next inbound restarts the ENTIRE turn from scratch —
// re-running every tool call (re-booking, re-messaging) with side effects.
//
// This module lets us checkpoint the turn AFTER the tool loop completes (raw
// reply in hand) so a retry can resume from that point: re-run the safety
// supervisor and send, WITHOUT re-invoking Claude or any tool. That rescues the
// exact crash window (post-loop) with zero tool-replay risk.
//
// Scope (Sprint 8): only the "loop_complete" phase. Mid-loop resume (which
// would need per-tool idempotency tagging) is deliberately out of scope.
//
// Storage: agent_turn_checkpoints/{phone}, one doc per phone, 5-minute TTL.
// The doc is keyed by a hash of the inbound text so we only resume for the
// SAME message — a different inbound from the same phone never resumes.
//
// Gated by the CARA_CHECKPOINT_RESUME env flag. When unset/false, all functions
// are no-ops (writes skipped, loads return null) so the feature can ship dark
// and flip on after one clean deploy.

const db = admin.firestore();

const CHECKPOINT_TTL_MS = 5 * 60 * 1000;
const COLLECTION = "agent_turn_checkpoints";

export type CheckpointPhase = "loop_complete";

export interface TurnCheckpoint {
  textHash:  string;
  phase:     CheckpointPhase;
  reply:     string;       // the raw reply produced by the tool loop
  createdAt: string;       // ISO
  expiresAt: number;       // ms epoch
}

export function isCheckpointResumeEnabled(): boolean {
  return process.env.CARA_CHECKPOINT_RESUME === "true";
}

// FNV-1a 32-bit — same hash used by promptExperiments. Deterministic, no deps.
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  const s = (text ?? "").trim();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}

/**
 * Persist a checkpoint for a phone. Fire-and-forget friendly — callers should
 * not await on the hot path (use `.catch(() => {})`). No-op when the resume
 * flag is off.
 */
export async function writeCheckpoint(
  phone:    string,
  phase:    CheckpointPhase,
  textHash: string,
  reply:    string,
): Promise<void> {
  if (!isCheckpointResumeEnabled()) return;
  if (!phone || !reply) return;
  const now = Date.now();
  const checkpoint: TurnCheckpoint = {
    textHash,
    phase,
    reply,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + CHECKPOINT_TTL_MS,
  };
  await db.collection(COLLECTION).doc(phone).set(checkpoint);
}

/**
 * Load a resumable checkpoint for (phone, inbound text). Returns null when:
 *   - the resume flag is off
 *   - no checkpoint exists
 *   - the checkpoint is expired (also deletes it)
 *   - the stored textHash doesn't match this inbound (different message)
 */
export async function loadCheckpoint(
  phone: string,
  text:  string,
): Promise<TurnCheckpoint | null> {
  if (!isCheckpointResumeEnabled()) return null;
  if (!phone) return null;

  const snap = await db.collection(COLLECTION).doc(phone).get().catch(() => null);
  if (!snap || !snap.exists) return null;

  const cp = snap.data() as TurnCheckpoint | undefined;
  if (!cp) return null;

  if (cp.expiresAt < Date.now()) {
    await snap.ref.delete().catch(() => {});
    return null;
  }
  if (cp.textHash !== hashText(text)) return null;

  return cp;
}

/** Delete a phone's checkpoint. Called on successful send (turn finished). */
export async function clearCheckpoint(phone: string): Promise<void> {
  if (!phone) return;
  await db.collection(COLLECTION).doc(phone).delete().catch(() => {});
}
