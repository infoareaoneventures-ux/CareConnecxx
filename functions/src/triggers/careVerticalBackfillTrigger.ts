// ── careVertical interim backfill trigger (plan 2026-07-22-002, U14 / amended R2) ──
//
// The amended R2 fail-closed transition for the four browser-writable shared
// collections (appointments, chatRooms, reviews, booking_requests): the
// Rules-level `careVertical` requirement activates only AFTER a recorded
// Hosting bake window, so live pre-deploy senior SPA sessions (which write
// without a vertical) don't break the instant Rules tighten. During that bake
// window this interim onCreate trigger stamps `careVertical:"senior"` on any
// browser-created doc that lands WITHOUT a vertical — so no browser write
// silently stays unlabeled, and none is ever inferred as "child".
//
// DARK BY DEFAULT — the trigger no-ops unless CARE_VERTICAL_INTERIM_BACKFILL_ENABLED
// is exactly "true". This is a deploy-window env switch (reversible by clearing
// the var; the whole trigger is retired once the bake window closes and Rules
// enforce the requirement), NOT a childcare feature flag.
//
// SAFETY: never overwrites an existing vertical, never stamps "child", and only
// touches docs missing the field. Server writers already stamp their vertical,
// so this only ever catches raw browser SENIOR writes during the window.

import * as functions from "firebase-functions/v1";

/** The four browser-writable shared collections (amended R2). */
export const INTERIM_BACKFILL_COLLECTIONS = ["appointments", "chatRooms", "reviews", "booking_requests"] as const;

export function isInterimBackfillEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CARE_VERTICAL_INTERIM_BACKFILL_ENABLED === "true";
}

/**
 * PURE decision: stamp "senior" ONLY when the doc has no careVertical at all.
 * A present value (senior/child/anything) is left untouched — never overwritten,
 * and "child" is never inferred from content.
 */
export function shouldInterimBackfillSenior(data: Record<string, unknown> | undefined | null): boolean {
  if (!data) return false;
  const v = (data as { careVertical?: unknown }).careVertical;
  return v === undefined || v === null;
}

function makeTrigger(collection: string) {
  return functions.firestore.document(`${collection}/{docId}`).onCreate(async (snap) => {
    if (!isInterimBackfillEnabled()) return null; // DARK by default
    const data = snap.data() as Record<string, unknown> | undefined;
    if (!shouldInterimBackfillSenior(data)) return null;
    try {
      await snap.ref.set(
        {
          careVertical: "senior",
          careVerticalInterimBackfilledAt: new Date().toISOString(),
        },
        { merge: true },
      );
    } catch (err) {
      console.error(`[careVerticalInterimBackfill] ${collection} stamp failed`, err instanceof Error ? err.name : "Error");
    }
    return null;
  });
}

// One onCreate trigger per browser-writable collection. Exported for index.ts;
// dark until CARE_VERTICAL_INTERIM_BACKFILL_ENABLED=true during the bake window.
export const interimBackfillAppointmentVertical = makeTrigger("appointments");
export const interimBackfillChatRoomVertical = makeTrigger("chatRooms");
export const interimBackfillReviewVertical = makeTrigger("reviews");
export const interimBackfillBookingRequestVertical = makeTrigger("booking_requests");
