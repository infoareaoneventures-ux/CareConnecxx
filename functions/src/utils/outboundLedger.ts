import * as admin from "firebase-admin";
import { createHash } from "crypto";

// Outbound idempotency. Linq inbound is at-least-once and isn't idempotency-keyed
// the way Stripe is, so a redelivered inbound can drive an IDENTICAL outbound
// message (a doubled crisis/booking text). This ledger suppresses an exact
// duplicate message to the same chat within a short window — across all
// urgencies, since a true duplicate critical message is a redelivery artifact,
// not two intentional sends. Distinct content, or the same content sent later
// than the window, still goes out.

const db = admin.firestore();
const DEDUP_WINDOW_MS = 60_000;

function contentKey(chatId: string, content: string): string {
  return createHash("sha1").update(`${chatId}|${content}`).digest("hex").slice(0, 32);
}

/**
 * Claim the right to send `content` to `chatId` for `phone`. Returns true if this
 * is the first send within the window (caller should send), false if an identical
 * message was just sent (caller should suppress). Fails OPEN (true) on error —
 * sending a rare duplicate beats silently dropping a message.
 */
export async function claimOutboundSend(
  phone: string,
  chatId: string,
  content: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const ref = db.collection("agent_outbound_dedup").doc(`${phone}_${contentKey(chatId, content)}`);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const sentAt = (snap.data() as { sentAt?: number } | undefined)?.sentAt ?? 0;
      if (snap.exists && nowMs - sentAt < DEDUP_WINDOW_MS) return false;
      tx.set(ref, { sentAt: nowMs });
      return true;
    });
  } catch {
    return true;
  }
}
