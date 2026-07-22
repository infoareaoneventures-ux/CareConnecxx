// Server-derived source-turn key for lifecycle checkpoints (plan
// 2026-07-18-001 U4, R21/KTD10/AE21).
//
// A checkpoint document ID must be derivable ONLY server-side from the full
// verified identity of a turn — never accepted raw from a client or provider.
// Two users submitting the same client-provided message ID on different
// channels or accounts therefore get different keys, and neither can load or
// resume the other's state (AE21); resume-time validation additionally
// recomputes the binding hashes stored on the checkpoint.
//
// Pattern mirrors memoryOperations.hashSourceTurnKey (KTD10): versioned
// purpose-prefixed sha256, raw provider identifiers never stored. The purpose
// prefix ("evia-checkpoint:v1") is distinct from the memory operation's
// ("evia-turn:v1"), so the two key spaces can never alias.
//
// Wave 1 status: DARK library — turnCheckpoint.ts still uses its legacy
// phone-keyed doc for the post-loop rescue. U4's integration slices migrate
// each ingress to pass a SourceTurnIdentity through to the agent loop.

import { createHash } from "crypto";

const KEY_PREFIX = "evia-checkpoint:v1";

export interface SourceTurnIdentity {
  channel: "linq" | "web";
  /** Verified principal: E.164 phone for Linq, Firebase uid for web. */
  principal: string;
  /** Provider conversation identifier (Linq chatId / web thread id). */
  conversationId: string;
  /** Provider message identifier (Linq eventId / web clientMessageId). */
  messageId: string;
  /** Objective version bound at checkpoint time; 0 when no objective exists. */
  objectiveVersion: number;
}

function assertComplete(id: SourceTurnIdentity): void {
  const missing = (["channel", "principal", "conversationId", "messageId"] as const)
    .filter((f) => !id[f] || typeof id[f] !== "string");
  if (missing.length > 0) {
    // Fail closed: a checkpoint keyed on partial identity is exactly the
    // cross-account collision AE21 forbids.
    throw new Error(`turnSourceKey: incomplete turn identity (missing ${missing.join(", ")})`);
  }
  if (!Number.isInteger(id.objectiveVersion) || id.objectiveVersion < 0) {
    throw new Error("turnSourceKey: objectiveVersion must be a non-negative integer");
  }
}

/** Deterministic 32-hex checkpoint document key from the FULL turn identity. */
export function deriveSourceTurnKey(id: SourceTurnIdentity): string {
  assertComplete(id);
  return createHash("sha256")
    .update(`${KEY_PREFIX}:${id.channel}:${id.principal}:${id.conversationId}:${id.messageId}:${id.objectiveVersion}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Binding hashes persisted WITH the checkpoint (Data Changes,
 * agent_turn_checkpoints). Resume validates each independently, so a
 * mismatched actor, channel, or conversation refuses resume even if an
 * attacker somehow guessed the document key. Raw values are never stored.
 */
export interface SourceTurnBindings {
  principalHash: string;
  channelBindingHash: string; // channel + conversation together
}

export function deriveBindings(id: SourceTurnIdentity): SourceTurnBindings {
  assertComplete(id);
  const h = (purpose: string, value: string) =>
    createHash("sha256").update(`${KEY_PREFIX}:${purpose}:${value}`).digest("hex").slice(0, 32);
  return {
    principalHash: h("principal", id.principal),
    channelBindingHash: h("channel-conversation", `${id.channel}:${id.conversationId}`),
  };
}

/**
 * Resume-time validation (R21): the caller's freshly-verified identity must
 * reproduce BOTH the document key and every stored binding hash. Any mismatch
 * → refuse resume; the caller falls back to a fresh turn, never a replay.
 */
export function validateSourceTurn(
  id: SourceTurnIdentity,
  stored: { key: string; bindings: SourceTurnBindings },
): boolean {
  try {
    if (deriveSourceTurnKey(id) !== stored.key) return false;
    const fresh = deriveBindings(id);
    return fresh.principalHash === stored.bindings.principalHash
      && fresh.channelBindingHash === stored.bindings.channelBindingHash;
  } catch {
    return false; // incomplete identity can never validate
  }
}
