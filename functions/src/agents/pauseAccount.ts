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

/** Resolve a caller-supplied `until` ("indefinite" or an ISO date) to the stored value. */
export function resolvePausedUntil(until: string): string {
  return until === "indefinite" ? INDEFINITE_PAUSE_UNTIL : until;
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
