// Shared engine gate for OPTIONAL proactive sources (plan 2026-07-18-001 U8,
// KTD15/R40/R43).
//
// Per the frozen source manifest (docs/evia-proactive-source-manifest.md),
// every optional discretionary source must submit its send as a PolicyCandidate
// instead of sending directly. This module is the one seam those sources call:
// it loads real recipient state, runs the pure decision policy, persists an
// explicit disposition record, and answers "may this send proceed?".
//
// Layering (deliberate — no double-blocking):
//   - THIS GATE owns: cross-source intent dedupe, category muting, the
//     deterministic-evidence rule for health candidates, and the ≤1-optional-
//     send-per-recipient-per-day budget (R43).
//   - THE DELIVERY LAYER (sendViaInteractionAgent) keeps owning: opt-out,
//     quiet-hours/DND judgment (shouldSend), the global 3/day proactive cap,
//     content-hash dedupe, and the supervisor. `inDnd` is therefore always
//     false here — deferring at the gate for DND would silently DROP the
//     send, while the delivery layer can queue it politely.
//
// Failure posture: infra errors FAIL OPEN (the send proceeds as it did before
// migration — a rare extra nudge beats a silently dark source). Policy
// decisions (suppressed / deferred / duplicate) are honored strictly — they
// are the point of the gate. Health-evidence gating lives inside the pure
// policy, which cannot throw.

import * as admin from "firebase-admin";
import { createHash } from "crypto";
import {
  decideForRecipient,
  type CandidateDecision,
  type CandidateCategory,
  type PolicyCandidate,
} from "./proactiveDecisionEngine";
import type { ProactiveTally } from "../agents/proactiveCap";

export const PROACTIVE_DECISIONS_COLLECTION = "proactive_decisions";

/** Default candidate lifetime — one daily-job cycle. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface GateCandidateInput {
  /** Manifest source id, e.g. "wowMomentsJob". */
  source: string;
  category: CandidateCategory;
  urgency: 0 | 1 | 2 | 3;
  /** Deterministic evidence items backing it (careInsights etc.). */
  evidenceCount: number;
  /**
   * Intent key — same-intent candidates across sources collapse (R43).
   * Free-form; hashed before storage so it may embed context safely.
   */
  dedupeKey: string;
  ttlMs?: number;
}

export interface GateResult {
  allowed: boolean;
  disposition: CandidateDecision["disposition"] | "error_fail_open";
  reason: string;
}

/** Doc id for a decision record: hash of the intent key (no raw context in ids). */
export function decisionDocId(dedupeKey: string): string {
  return createHash("sha256").update(`evia-proactive-intent:v1:${dedupeKey}`).digest("hex");
}

/**
 * Gate one optional proactive send for one recipient. Sources call this
 * INSTEAD of deciding to send on their own; on `allowed: false` they log the
 * disposition and skip (deferred candidates re-enter naturally on the source's
 * next scheduled pass — every optional source is a recurring job).
 */
export async function gateOptionalSend(opts: {
  phone: string;
  candidate: GateCandidateInput;
  db?: admin.firestore.Firestore;
  now?: Date;
}): Promise<GateResult> {
  const db = opts.db ?? admin.firestore();
  const now = opts.now ?? new Date();
  const c = opts.candidate;

  try {
    const docId = decisionDocId(c.dedupeKey);
    const decisionRef = db.collection(PROACTIVE_DECISIONS_COLLECTION).doc(docId);

    // Cross-source intent dedupe (R43): if this intent already won a pass and
    // is still live, an identical candidate from ANY source is a duplicate.
    const prior = await decisionRef.get();
    if (prior.exists) {
      const p = prior.data() as { disposition?: string; expiresAt?: string };
      const live = p.expiresAt ? Date.parse(p.expiresAt) > now.getTime() : false;
      if (live && (p.disposition === "send" || p.disposition === "review_first")) {
        return { allowed: false, disposition: "suppressed", reason: "duplicate_intent_cross_source" };
      }
    }

    // Real recipient state. optionalSendsToday reuses the delivery layer's
    // daily proactive tally (agent_sessions.proactiveSentToday) — it counts a
    // superset of optional sends, which errs in the QUIETER direction. Muted
    // categories come from user preferences when present (R44).
    const sessionSnap = await db.collection("agent_sessions").doc(opts.phone).get();
    const session = (sessionSnap.data() ?? {}) as Record<string, unknown>;
    const tally = session.proactiveSentToday as ProactiveTally | undefined;
    const today = now.toISOString().slice(0, 10);
    const optionalSendsToday = tally && tally.date === today ? tally.count : 0;
    const prefs = (session.preferences ?? {}) as Record<string, unknown>;
    const mutedCategories = Array.isArray(prefs.mutedProactiveCategories)
      ? (prefs.mutedProactiveCategories as CandidateCategory[])
      : undefined;

    const candidate: PolicyCandidate = {
      source: c.source,
      category: c.category,
      urgency: c.urgency,
      evidenceCount: c.evidenceCount,
      dedupeKey: c.dedupeKey,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (c.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    };
    const decision = decideForRecipient(
      [candidate],
      { optionalSendsToday, inDnd: false, mutedCategories },
      now,
    )[0];

    // Persist the explicit disposition (R43) — enums/counts only, no text.
    await decisionRef.set({
      source: c.source,
      category: c.category,
      urgency: c.urgency,
      evidenceCount: c.evidenceCount,
      phone: opts.phone,
      disposition: decision.disposition,
      reason: decision.reason,
      ...(decision.nextEligibleAt ? { nextEligibleAt: decision.nextEligibleAt } : {}),
      createdAt: candidate.createdAt,
      expiresAt: candidate.expiresAt,
    }).catch((err) => console.warn("engineGate: decision record write failed (non-fatal)", err));

    const allowed = decision.disposition === "send";
    return { allowed, disposition: decision.disposition, reason: decision.reason };
  } catch (err) {
    // Infra failure — fail open so a Firestore blip can't dark a source.
    console.error("engineGate: gate errored, failing open", c.source, err instanceof Error ? err.message : String(err));
    return { allowed: true, disposition: "error_fail_open", reason: "gate_error_fail_open" };
  }
}
