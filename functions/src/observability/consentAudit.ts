/**
 * Per-send consent audit trail (U6 — plan 2026-06-23-001).
 *
 * TCPA liability is per-message and strict; demonstrating consent in a dispute
 * requires a record of the consent state *at the moment each proactive message
 * was sent or suppressed*. This builds that record. The pure builder is kept
 * separate from the Firestore write so it is directly unit-testable.
 */

export type ConsentDecision = "sent" | "suppressed_opted_out";

export interface ConsentSnapshot {
  optedOut?: boolean;
  optedInAt?: string;
}

export interface ConsentAuditRecord {
  phone: string;
  /** The proactive source/campaign (e.g. next_day_feedback, payment_reminder). */
  campaign: string;
  decision: ConsentDecision;
  optedOut: boolean;
  optedInAt: string | null;
  at: string;
}

export function buildConsentAuditRecord(
  phone: string,
  campaign: string,
  decision: ConsentDecision,
  snapshot: ConsentSnapshot,
  at: string,
): ConsentAuditRecord {
  return {
    phone,
    campaign: campaign || "unknown",
    decision,
    optedOut: !!snapshot.optedOut,
    optedInAt: snapshot.optedInAt ?? null,
    at,
  };
}
