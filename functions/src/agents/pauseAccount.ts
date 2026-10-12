import * as admin from "firebase-admin";

const db = admin.firestore();

/**
 * Shared pause/reactivate write logic for a caregiver account.
 *
 * Used by BOTH the conversational state-machine handler
 * (`caregiverProfileHandler.handlePauseAccount`/`handleReactivate`), the
 * SETTINGS keywords (`caregiverSettings.ts`), the agent-loop MCP tools
 * (`pause_account`/`reactivate_account`) and the site's queue action
 * (`triggers/accountActionQueue.ts set_caregiver_pause_status`) so the doors
 * can never drift. See plan U1 / KTD-2.
 *
 * The record of the event (caregiver sweep B7, 2026-10-11): the `pausedUntil`
 * transition is picked up by triggers/caregiverAccountEvents.ts → ONE bell +
 * text ("account_paused" / "account_reactivated", notifications/
 * caregiverAccountEvents.ts). Every Evia door texts its own confirmation line
 * the moment it writes, so for those the lifecycle text stands down and only
 * the bell is written — the door stamps `accountNoticeTexted` on the phone-keyed
 * session BEFORE the record flips (the same seam as `membershipRecordedAt`).
 * The site's Settings page only toasts, so its queue action passes
 * `door: "site"` and the lifecycle text goes.
 */

/** Sentinel stored for an open-ended ("indefinite") pause. */
export const INDEFINITE_PAUSE_UNTIL = "2099-12-31";

export interface PauseWriteOptions {
  /**
   * Which door is writing. "evia" (default — every text path, incl. the MCP
   * tools) texts its own confirmation, so the lifecycle text stands down;
   * "site" (the Settings page's queue action) only toasts, so it does not.
   */
  door?: "site" | "evia";
  /** The caregiver's phone (the session key) when the caller already has it; resolved otherwise. */
  phone?: string;
}

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

/**
 * An Evia door is about to text its own confirmation: stamp the session so the
 * lifecycle notice (bell + text) keeps the bell and stands its text down.
 * Best effort — a missing session or phone just means the lifecycle text goes.
 */
async function stampNoticeOwnedByDoor(caregiverId: string, kind: "account_paused" | "account_reactivated", opts: PauseWriteOptions): Promise<void> {
  if (opts.door === "site") return;
  try {
    let phone = opts.phone;
    if (!phone) {
      const { resolveCaregiverPhone } = await import("../utils/caregiverPhone");
      phone = await resolveCaregiverPhone(caregiverId);
    }
    if (!phone) return;
    // update, not set: never create a stray phone-keyed session just for the stamp.
    await db.collection("agent_sessions").doc(phone).update({ accountNoticeTexted: { kind, at: new Date().toISOString() } });
  } catch (err) {
    console.warn(`[pauseAccount] notice stamp (${kind}) skipped for ${caregiverId}:`, err instanceof Error ? err.message : err);
  }
}

/** Pause a caregiver until the given date (or indefinitely). Caller enforces ownership. */
export async function pauseCaregiver(caregiverId: string, until: string, opts: PauseWriteOptions = {}): Promise<void> {
  const pausedUntil = resolvePausedUntil(until); // validate before any side effect
  await stampNoticeOwnedByDoor(caregiverId, "account_paused", opts);
  await db.collection("caregivers").doc(caregiverId).update({
    pausedUntil,
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
export async function reactivateCaregiver(caregiverId: string, opts: PauseWriteOptions = {}): Promise<void> {
  await stampNoticeOwnedByDoor(caregiverId, "account_reactivated", opts);
  await db.collection("caregivers").doc(caregiverId).update({
    pausedUntil:   admin.firestore.FieldValue.delete(),
    pausedAt:      admin.firestore.FieldValue.delete(),
    reactivatedAt: new Date().toISOString(),
  });
}
