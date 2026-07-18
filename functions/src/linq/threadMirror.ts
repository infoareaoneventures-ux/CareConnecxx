// Mirrors Evia SMS/iMessage conversations into the web chat model
// (threads/{threadId}/messages) so families and caregivers see their Evia
// history in the web inbox (Chat.tsx / ChatInbox.tsx read threads where
// participants array-contains their uid).
//
// Thread doc ID is deterministic: `cara_{userId}`. Mirroring is strictly
// best-effort: failures are logged and never block message delivery.

import * as admin from "firebase-admin";
import { outboundHistoryRecordEnabled } from "../config/featureFlags";

const db = admin.firestore();

export const CARA_SENDER_ID = "cara";

// Inline SVG so the web inbox renders an avatar without external requests.
const CARA_AVATAR =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='50' fill='%237c3aed'/%3E%3Ctext x='50' y='62' font-size='40' font-family='sans-serif' fill='white' text-anchor='middle'%3EC%3C/text%3E%3C/svg%3E";

// chatId/groupChatId -> userId lookups are hot, so memoize per instance. The
// cache is TTL'd so a newly added family-group member is discovered within the
// window instead of being invisible until the instance recycles.
const CHAT_USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Mirror every member of a family group, bounded by a generous cap far above
// realistic family size to avoid an unbounded scan. Shared by both resolvers.
const GROUP_MIRROR_LIMIT = 50;

// One entry per resolved chatId, namespaced by lookup type ("direct:"/"group:").
type SessionValueCache<T> = Map<string, { values: T[]; cachedAt: number }>;

// Minimal structural view of a query doc — satisfied by the real
// QueryDocumentSnapshot and by the test doubles.
interface SessionDoc {
  id: string;
  data: () => Record<string, unknown>;
}

// Shared chatId -> session-value resolution used by both resolveUserIds
// (session `userId` FIELD, a Firebase uid) and resolvePhones (agent_sessions
// DOC ID, the phone number). Resolves the direct lookup first; only falls back
// to group fan-out when no direct session matches. Cache keys are namespaced
// by lookup type ("direct:" vs "group:") so a chatId that happens to equal
// some other session's groupChatId can never return the wrong branch's cached
// values. Each caller supplies its OWN cache map — the uid and phone caches
// must never be shared, or history would be recorded under the wrong key.
async function resolveSessionValues<T>(params: {
  chatId: string;
  cache: SessionValueCache<T>;
  pickFromDoc: (doc: SessionDoc) => T | undefined;
  /** Over-cap console.warn text (the two callers name different consequences). */
  overCapWarning: (chatId: string) => string;
  /** Lookup label for the failure warn, e.g. "chatId->userId". */
  failureLabel: string;
}): Promise<T[]> {
  const { chatId, cache, pickFromDoc } = params;
  try {
    const directKey = `direct:${chatId}`;
    const directCached = cache.get(directKey);
    if (directCached && Date.now() - directCached.cachedAt < CHAT_USER_CACHE_TTL_MS) {
      return directCached.values;
    }
    if (directCached) cache.delete(directKey); // expired — re-query below

    const directSnap = await db.collection("agent_sessions")
      .where("chatId", "==", chatId)
      .limit(1)
      .get();

    if (!directSnap.empty) {
      const value = pickFromDoc(directSnap.docs[0]);
      const values = value ? [value] : [];
      cache.set(directKey, { values, cachedAt: Date.now() });
      return values;
    }

    const groupKey = `group:${chatId}`;
    const groupCached = cache.get(groupKey);
    if (groupCached && Date.now() - groupCached.cachedAt < CHAT_USER_CACHE_TTL_MS) {
      return groupCached.values;
    }
    if (groupCached) cache.delete(groupKey); // expired — re-query below

    // We query for one more than the cap so we can tell "exactly at cap"
    // (complete) from "over cap" (truly truncated) and only warn — rather than
    // silently dropping members — in the latter case.
    const groupSnap = await db.collection("agent_sessions")
      .where("groupChatId", "==", chatId)
      .limit(GROUP_MIRROR_LIMIT + 1)
      .get();
    if (groupSnap.docs.length > GROUP_MIRROR_LIMIT) {
      console.warn(params.overCapWarning(chatId));
    }
    const values = [...new Set(groupSnap.docs
      .slice(0, GROUP_MIRROR_LIMIT)
      .map((doc) => pickFromDoc(doc))
      .filter((v): v is T => !!v))];
    cache.set(groupKey, { values, cachedAt: Date.now() });
    return values;
  } catch (err) {
    console.warn(`threadMirror: ${params.failureLabel} lookup failed`, err);
    return [];
  }
}

const chatUserCache: SessionValueCache<string> = new Map();

async function resolveUserIds(params: { userId?: string; chatId?: string }): Promise<string[]> {
  if (params.userId) return [params.userId];
  if (!params.chatId) return [];
  return resolveSessionValues({
    chatId:      params.chatId,
    cache:       chatUserCache,
    pickFromDoc: (doc) => doc.data().userId as string | undefined,
    overCapWarning: (chatId) =>
      `threadMirror: group ${chatId} exceeded the ${GROUP_MIRROR_LIMIT}-member mirror cap — some members may be missing from web-inbox mirroring; investigate.`,
    failureLabel: "chatId->userId",
  });
}

// chatId -> PHONE resolution for the outbound-history recorder (hallucination
// hardening U3). Deliberately a SIBLING of resolveUserIds with its own cache:
// resolveUserIds returns/caches the session's `userId` FIELD (a Firebase uid),
// but agent_conversations is keyed by PHONE — which is the agent_sessions DOC
// ID. Reusing the uid cache here would record history under the wrong key.
const chatPhoneCache: SessionValueCache<string> = new Map();

export async function resolvePhones(chatId: string): Promise<string[]> {
  if (!chatId) return [];
  return resolveSessionValues({
    chatId,
    cache:       chatPhoneCache,
    // The agent_sessions doc id IS the phone number.
    pickFromDoc: (doc) => doc.id,
    overCapWarning: (cid) =>
      `threadMirror: group ${cid} exceeded the ${GROUP_MIRROR_LIMIT}-member phone-resolution cap — some members may be missing from outbound history; investigate.`,
    failureLabel: "chatId->phone",
  });
}

// ── History URL neutralization ───────────────────────────────────────────────
// The web-inbox mirror keeps literal URLs (users tap them there), but the
// agent-history row must NOT: texted links are frequently tokenized bearer
// URLs (Stripe checkout, /bgcheck consent, /upload token pages), and history
// text is interpolated into LLM prompts — a literal URL there both leaks the
// token into every downstream prompt and invites the model to re-compose URLs,
// which the voice rules forbid. The agent only needs to know a link was sent,
// so every URL (http(s)://… and scheme-less www.…) becomes "[link]".
const HISTORY_URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/gi;

/** Pure: replace every URL in history-bound text with "[link]". Applied only
 *  to agent_conversations history rows — never to the web-inbox mirror text. */
export function neutralizeUrlsForHistory(text: string): string {
  return text.replace(HISTORY_URL_RE, "[link]");
}

// ── Transport-row prune (nudge-only history growth) ─────────────────────────
// maybeRollUpHistory folds agent_conversations history ONLY on qaAgent turns,
// so a phone that never converses (pure nudge/gate recipients) accumulates
// transport-recorded rows without bound. This deterministic, LLM-free sweep
// keeps the newest TRANSPORT_ROWS_KEPT source == "outbound_transport" rows per
// phone and deletes older ones. Only rows carrying the transport source tag
// can ever match the query — real user/assistant turns and the summary row
// have no `source` field and are untouchable here.
export const TRANSPORT_ROWS_KEPT = 60;

// Throttle: run the prune on every Nth recorded write via a module-level
// counter. Tradeoff (deliberate): the counter resets on cold start and is
// per-instance, so the cadence is approximate — fine for a hygiene sweep,
// because each run trims ALL excess rows for that phone, so a missed trigger
// only delays cleanup, never loses it. Chosen over time-derived triggers
// (timestamp minute % N) because a burst of writes inside one qualifying
// minute would prune on every write; the counter is deterministic (no
// Math.random) and amortizes to exactly 1-in-N.
export const TRANSPORT_PRUNE_EVERY_N = 20;
let transportWriteCounter = 0;

/** Test hook — the throttle counter is module state and tests need a known start. */
export function resetTransportPruneCounterForTests(): void {
  transportWriteCounter = 0;
}

/**
 * Delete the oldest transport-recorded rows beyond TRANSPORT_ROWS_KEPT for one
 * phone. Fail-soft: never throws (it runs inside the send path via
 * recordOutboundHistory). Deletes are capped at 100 per run — the next
 * triggered run picks up any remainder. Requires the composite index
 * messages(source ASC, timestamp DESC) in firestore.indexes.json.
 * Returns the number of rows deleted (0 on failure).
 */
export async function pruneTransportRows(phone: string): Promise<number> {
  try {
    const snap = await db.collection("agent_conversations").doc(phone).collection("messages")
      .where("source", "==", "outbound_transport")
      .orderBy("timestamp", "desc")
      .limit(TRANSPORT_ROWS_KEPT + 100) // batch deletes ≤ 100 per run
      .get();
    const stale = snap.docs.slice(TRANSPORT_ROWS_KEPT);
    if (stale.length === 0) return 0;
    const batch = db.batch();
    for (const doc of stale) batch.delete(doc.ref);
    await batch.commit();
    return stale.length;
  } catch (err) {
    // Counts/keys only — never log message text.
    console.warn("threadMirror: transport-row prune failed (non-blocking)", {
      phone,
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

// Record an outbound send as an assistant turn in the QA agent's history
// (agent_conversations/{phone}/messages) so scripted/scheduled/trigger sends
// are visible to it afterward — the "who is Marcus" denial class (R4).
// Fail-soft: never throws, and a recording failure never blocks delivery.
// Callers AWAIT it (Gen-1 functions can tear down post-return background work
// before a fire-and-forget write lands). URLs are neutralized to "[link]"
// before the write — see neutralizeUrlsForHistory above. Schema matches
// qaAgent's saveConversationTurn ({ role, content, timestamp: Date.now() });
// the extra `source` tag marks transport-recorded rows so the history window
// composer can shed them before user turns (getConversationHistory reads only
// role/content, so the field is inert there).
export async function recordOutboundHistory(params: {
  chatId: string;
  text:   string;
}): Promise<void> {
  try {
    if (!outboundHistoryRecordEnabled()) return;

    const text = neutralizeUrlsForHistory((params.text ?? "").trim());
    if (!text) return;
    // Attachment-only sends carry no conversational content worth recording —
    // extractMirrorText renders media parts as "[attachment]".
    if (!text.replace(/\[attachment\]/g, "").trim()) return;

    const phones = await resolvePhones(params.chatId);
    if (phones.length === 0) return; // pre-session send: nothing to key by

    const timestamp = Date.now();
    await Promise.all(phones.map((phone) =>
      db.collection("agent_conversations").doc(phone).collection("messages").add({
        role:      "assistant",
        content:   text,
        timestamp,
        source:    "outbound_transport",
      })
    ));

    // Hygiene sweep AFTER the row write, throttled to 1-in-N writes so it is
    // not a per-write cost. AWAITED (same Gen-1 teardown reasoning as the
    // recording itself) but internally fail-soft — a prune failure can never
    // fail the send, and the surrounding catch absorbs anything unexpected.
    transportWriteCounter += 1;
    if (transportWriteCounter % TRANSPORT_PRUNE_EVERY_N === 0) {
      await Promise.all(phones.map((phone) => pruneTransportRows(phone)));
    }
  } catch (err) {
    // Counts/keys only — never log message text.
    console.warn("threadMirror: outbound history record failed (non-blocking)", {
      chatId: params.chatId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function mirrorToWebThread(params: {
  userId?:   string;
  chatId?:   string;
  direction: "inbound" | "outbound"; // inbound = user -> Evia, outbound = Evia -> user
  text:      string;
  /** Message origin ("cara_sms" default; "cara_web" for web-chat turns). */
  source?:   string;
  /** Client-generated id from the web composer, used to reconcile optimistic
   *  bubbles and to keep retries from duplicating the message. */
  clientMessageId?: string;
}): Promise<void> {
  try {
    const text = (params.text ?? "").trim();
    if (!text) return;

    const userIds = await resolveUserIds(params);
    if (userIds.length === 0) return; // pre-onboarding: nothing to mirror to

    const preview = text.substring(0, 100);

    // Mirror to each member's thread concurrently — they're independent docs
    // (cara_{userId}), so parallelizing avoids 2N sequential round-trips on the
    // message-delivery path.
    await Promise.all(userIds.map(async (userId) => {
      const threadId  = `cara_${userId}`;
      const threadRef = db.collection("threads").doc(threadId);

      await threadRef.set({
        id:            threadId,
        participants:  [userId, CARA_SENDER_ID],
        contactName:   "Evia",
        contactAvatar: CARA_AVATAR,
        isCaraThread:  true,
        lastMessage:   preview,
        lastMessageTime: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        // Only Evia's outbound replies add to the web-inbox unread badge. For
        // inbound (user -> Evia) we OMIT unreadCount entirely so merge:true
        // preserves any existing unread from earlier Evia replies the user
        // hasn't opened in the web inbox — writing 0 here would wipe it.
        ...(params.direction === "outbound"
          ? { unreadCount: admin.firestore.FieldValue.increment(1) }
          : {}),
      }, { merge: true });

      await threadRef.collection("messages").add({
        text,
        senderId:  params.direction === "inbound" ? userId : CARA_SENDER_ID,
        isRead:    params.direction === "inbound",
        source:    params.source ?? "cara_sms",
        ...(params.clientMessageId ? { clientMessageId: params.clientMessageId } : {}),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }));
  } catch (err) {
    console.warn("threadMirror: mirror failed (non-blocking)", err);
  }
}

// Extracts mirrorable plain text from a structured Linq message. Text and link
// parts are included; media parts are summarized.
export function extractMirrorText(message: { parts?: Array<{ type: string; value?: string }> }): string {
  if (!message.parts?.length) return "";
  return message.parts
    .map((p) => {
      if (p.type === "text" || p.type === "link") return p.value ?? "";
      return p.type === "media" ? "[attachment]" : "";
    })
    .filter(Boolean)
    .join("\n");
}
