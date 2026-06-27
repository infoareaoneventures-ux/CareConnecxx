import * as admin from "firebase-admin";

const db = admin.firestore();

/**
 * Shared pause/reactivate write logic for a caregiver account.
 *
 * Used by BOTH the conversational state-machine handler
 * (`caregiverProfileHandler.handlePauseAccount`/`handleReactivate`) and the
 * agent-loop MCP tools (`pause_account`/`reactivate_account`) so the two paths
 * can never drift. See plan U1 / KTD-2.
 */

/** Sentinel stored for an open-ended ("indefinite") pause. */
export const INDEFINITE_PAUSE_UNTIL = "2099-12-31";

/**
 * Strict ISO 8601: a date-only `YYYY-MM-DD`, or a full datetime that MUST carry
 * a timezone (`Z` or `±HH:MM`). `Date.parse()` alone is too lenient — it accepts
 * "July 12, 2026" and timezone-less partials — which would let ambiguous values
 * be persisted and break downstream date comparisons.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** Resolve a caller-supplied `until` ("indefinite" or an ISO date) to the stored value. */
export function resolvePausedUntil(until: string): string {
  if (until === "indefinite") return INDEFINITE_PAUSE_UNTIL;
  // Defensive: reject anything that isn't a strict ISO date so an invalid value
  // (e.g. an LLM-supplied "next Tuesday" or "July 12, 2026") can never be
  // persisted to Firestore. The regex enforces the format; Date.parse rejects
  // impossible calendar dates (e.g. "2026-13-45") that match the shape.
  if (!ISO_DATE_RE.test(until) || Number.isNaN(Date.parse(until))) {
    throw new Error(`resolvePausedUntil: invalid date "${until}" (expected an ISO date or "indefinite")`);
  }
  return until;
}

/** Pause a caregiver until the given date (or indefinitely). Caller enforces ownership. */
export async function pauseCaregiver(caregiverId: string, until: string): Promise<void> {
  await db.collection("caregivers").doc(caregiverId).update({
    pausedUntil: resolvePausedUntil(until),
    pausedAt:    new Date().toISOString(),
  });
}

/**
 * Reactivate a paused caregiver. Caller enforces ownership.
 *
 * Clears BOTH `pausedUntil` and `pausedAt` (the legacy state-machine handler
 * left `pausedAt` set on reactivate — a latent gap fixed here) and stamps
 * `reactivatedAt`.
 */
export async function reactivateCaregiver(caregiverId: string): Promise<void> {
  await db.collection("caregivers").doc(caregiverId).update({
    pausedUntil:   admin.firestore.FieldValue.delete(),
    pausedAt:      admin.firestore.FieldValue.delete(),
    reactivatedAt: new Date().toISOString(),
  });
}
