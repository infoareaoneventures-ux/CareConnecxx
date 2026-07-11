import * as admin from "firebase-admin";
import { quickComplete } from "../utils/openaiClient";
import { generateCaraMessage } from "../utils/caraMessage";
import { sendViaInteractionAgent } from "../agents/caraAgent";

const db = admin.firestore();

/**
 * Praise loop for in-shift updates: when a family responds warmly to a
 * mid-visit update — a tapback on it, or an appreciative text right after —
 * Evia relays that warmth to the caregiver ("Dorothy's daughter loved your
 * update"). The emotional paycheck this workforce almost never gets.
 *
 * Both entry points are fire-and-forget side effects: they never consume the
 * family's message (normal routing still answers it) and never throw into the
 * caller. The window is deliberately short and the relay one-shot per update
 * (praiseRelayed flag, flipped before sending) so a chatty family can't turn
 * the caregiver's phone into a praise firehose.
 */

export const PRAISE_WINDOW_MS = 60 * 60 * 1000; // family reaction within 1h of the update

export interface LastInShiftUpdate {
  caregiverId:   string;
  seniorName:    string;
  sentAt:        string;
  praiseRelayed: boolean;
}

// Shared eligibility guard: a fresh, not-yet-praised update stamp.
function eligibleStamp(session: Record<string, unknown> | undefined | null): LastInShiftUpdate | null {
  const stamp = session?.lastInShiftUpdate as LastInShiftUpdate | undefined;
  if (!stamp || stamp.praiseRelayed || !stamp.caregiverId) return null;
  const sentMs = Date.parse(stamp.sentAt ?? "");
  if (Number.isNaN(sentMs) || Date.now() - sentMs > PRAISE_WINDOW_MS) return null;
  return stamp;
}

async function relayPraise(
  clientPhone: string,
  stamp:       LastInShiftUpdate,
  howExpressed: string, // e.g. 'reacted with a heart' / a short quote of what they said
): Promise<void> {
  // One-shot claim, transactional and keyed on sentAt: a concurrent text +
  // tapback can't double-praise (second claimer sees praiseRelayed), and a
  // NEWER update stamped between our read and this write aborts the claim
  // instead of mis-attributing praise / suppressing the new update's praise.
  // A lost send after the claim is fine — praise is a nicety, never a retry.
  const sessionRef = db.collection("agent_sessions").doc(clientPhone);
  const claimed = await db.runTransaction(async (t) => {
    const snap = await t.get(sessionRef);
    const live = snap.data()?.lastInShiftUpdate as LastInShiftUpdate | undefined;
    if (!live || live.praiseRelayed || live.sentAt !== stamp.sentAt) return false;
    t.update(sessionRef, { "lastInShiftUpdate.praiseRelayed": true });
    return true;
  });
  if (!claimed) return;

  const cgSnap  = await db.collection("caregivers").doc(stamp.caregiverId).get();
  const cgPhone = cgSnap.data()?.phone as string | undefined;
  if (!cgPhone) return;
  const cgFirstName = ((cgSnap.data()?.name ?? "") as string).split(" ")[0] || "there";

  const content = await generateCaraMessage({
    audience: "caregiver",
    context:
      `${stamp.seniorName}'s family just responded warmly to the mid-visit update you passed along for ${cgFirstName} ` +
      `(they ${howExpressed}). Relay that warmth in ONE short sentence — make ${cgFirstName} feel seen. No emoji spam, no ask.`,
    fallback: `${stamp.seniorName}'s family loved your update — just wanted you to know.`,
    maxTokens: 60,
  });

  await sendViaInteractionAgent(cgPhone, {
    content,
    urgency:     "low",
    sourceAgent: "in_shift_praise",
    canDrop:     true,
  });
}

/** A positive tapback from the family shortly after an in-shift update. */
export async function maybeRelayPraiseFromReaction(
  clientPhone: string,
  session:     Record<string, unknown>,
  reaction:    string,
): Promise<void> {
  try {
    const stamp = eligibleStamp(session);
    if (!stamp) return;
    await relayPraise(clientPhone, stamp, `reacted with ${reaction}`);
  } catch (err) {
    console.error("[inShiftPraise] reaction relay failed:", err);
  }
}

/**
 * A family text arriving shortly after an in-shift update. LLM-judged (never
 * keyword-matched): only genuine appreciation of the update relays; questions,
 * instructions, or unrelated chatter don't.
 */
export async function maybeRelayPraiseFromText(
  clientPhone: string,
  session:     Record<string, unknown>,
  text:        string,
): Promise<void> {
  try {
    const stamp = eligibleStamp(session);
    if (!stamp) return;
    if (!text || text.trim().length < 2 || text.trim().length > 240) return;

    const verdict = await quickComplete(
      "A family member just received a mid-visit care update about their elderly loved one. " +
        "Does this reply express appreciation, warmth, or delight about that update (e.g. thanks, 'that made my day', " +
        "'so glad to hear')? Reply YES only for genuine warmth/appreciation. Reply NO for questions, instructions, " +
        "concerns, neutral acknowledgments ('ok'), or anything else. Only YES or NO.",
      text,
      { maxTokens: 5 },
    ).catch(() => "NO");
    if (!verdict.trim().toUpperCase().startsWith("Y")) return;

    await relayPraise(clientPhone, stamp, `said: "${text.trim().slice(0, 120)}"`);
  } catch (err) {
    console.error("[inShiftPraise] text relay failed:", err);
  }
}
