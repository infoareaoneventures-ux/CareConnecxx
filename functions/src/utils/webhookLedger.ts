import * as admin from "firebase-admin";

// Exactly-once guard for webhook handlers (Stripe, Checkr).
//
// Providers redeliver webhooks as normal operation (timeouts, 5xx, dashboard
// "resend"), so every handler must be idempotent. The contract here:
//
//   claimWebhookEvent()  — atomically claim the event id BEFORE any side
//                          effects; a duplicate delivery gets "duplicate" and
//                          must be acked without processing.
//   settleWebhookEvent() — "processed" stamps the claim permanent;
//                          "failed" deletes it so the provider's retry can
//                          reprocess (a claim must never outlive a failed run,
//                          or the event is silently lost forever).
//
// A claim left in "processing" (handler crashed before settling) becomes
// reclaimable after STALE_CLAIM_MS, so a later redelivery still gets through.
// Ledger infrastructure errors fail OPEN (process anyway): at-least-once is
// the provider's own baseline and beats dropping an event.

const STALE_CLAIM_MS = 10 * 60 * 1000;

export const STRIPE_EVENTS_COLLECTION = "processed_stripe_events";
export const CHECKR_EVENTS_COLLECTION = "processed_checkr_events";

export type WebhookClaim = "claimed" | "duplicate";

export async function claimWebhookEvent(
  collection: string,
  eventId: string,
): Promise<WebhookClaim> {
  try {
    const ref = admin.firestore().collection(collection).doc(eventId);
    try {
      await ref.create({ status: "processing", claimedAtMs: Date.now() });
      return "claimed";
    } catch {
      // create() failed — almost always ALREADY_EXISTS. Resolve in a transaction
      // so two stale-claim takeovers can't both win.
      const tookOver = await admin.firestore().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) {
          // create() failed for an infra reason, not a duplicate — claim now.
          tx.set(ref, { status: "processing", claimedAtMs: Date.now() });
          return true;
        }
        const data = snap.data() ?? {};
        // Legacy ledger docs (pre-claim era) carry only processedAt — settled.
        if (data.status !== "processing") return false;
        const claimedAtMs = typeof data.claimedAtMs === "number" ? data.claimedAtMs : 0;
        if (Date.now() - claimedAtMs < STALE_CLAIM_MS) return false; // in-flight duplicate
        tx.update(ref, { status: "processing", claimedAtMs: Date.now(), reclaimed: true });
        return true;
      });
      return tookOver ? "claimed" : "duplicate";
    }
  } catch (err) {
    console.error(`webhookLedger: claim failed open for ${collection}/${eventId}:`, err);
    return "claimed";
  }
}

export async function settleWebhookEvent(
  collection: string,
  eventId: string,
  outcome: "processed" | "failed",
): Promise<void> {
  try {
    const ref = admin.firestore().collection(collection).doc(eventId);
    if (outcome === "processed") {
      await ref.set(
        { status: "processed", processedAt: new Date().toISOString() },
        { merge: true },
      );
    } else {
      await ref.delete();
    }
  } catch (err) {
    // Non-fatal either way: an unsettled "processing" claim expires via
    // STALE_CLAIM_MS, and a missed "processed" stamp only risks one replay.
    console.error(`webhookLedger: settle(${outcome}) failed for ${collection}/${eventId}:`, err);
  }
}
