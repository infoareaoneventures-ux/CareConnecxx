import axios, { AxiosError, AxiosResponse } from "axios";
import * as admin from "firebase-admin";
import { randomUUID } from "crypto";
import { supervise, SuperviseContext } from "../safety/supervisor";
import { lintPreservingLayout } from "../safety/linter";
import { redactPii } from "../safety/redactPii";
import { logMessageSent } from "../observability/auditLog";

const db = admin.firestore();

// ── Config ────────────────────────────────────────────────────────────────────

function cfg() {
  return {
    apiKey:      process.env.LINQ_API_KEY      ?? "",
    phoneNumber: process.env.LINQ_PHONE_NUMBER ?? "",
    baseUrl:     process.env.LINQ_BASE_URL     ?? "https://api.linqapp.com/api/partner/v3",
  };
}

function headers() {
  return {
    Authorization: `Bearer ${cfg().apiKey}`,
    "Content-Type": "application/json",
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type LinqService = "iMessage" | "RCS" | "SMS";

export type LinqChatHealth = "HEALTHY" | "AT_RISK" | "CRITICAL" | "OPTED_OUT";
export type LinqPhoneHealth = "HEALTHY" | "AT_RISK" | "CRITICAL";
export type LinqPhoneStatus = "ACTIVE" | "FLAGGED";

export type LinqReactionType =
  | "love" | "like" | "dislike" | "laugh" | "emphasize" | "question" | "custom";

export type LinqTextDecoration = {
  range: [number, number];
  style?: "bold" | "italic" | "strikethrough" | "underline";
  animation?: "big" | "small" | "shake" | "nod" | "explode" | "ripple" | "bloom" | "jitter";
};

export interface LinqMessagePart {
  type:              "text" | "media" | "link";
  value?:            string;
  url?:              string;
  attachment_id?:    string;
  text_decorations?: LinqTextDecoration[];
}

export type LinqScreenEffect =
  | "confetti" | "fireworks" | "lasers" | "sparkles" | "celebration"
  | "hearts"   | "love"      | "balloons" | "happy_birthday" | "echo" | "spotlight";

export type LinqBubbleEffect = "slam" | "loud" | "gentle" | "invisible";

export type LinqEffect =
  | { type: "screen"; name: LinqScreenEffect }
  | { type: "bubble"; name: LinqBubbleEffect };

export interface LinqReplyTo {
  message_id:  string;
  part_index?: number;
}

export interface LinqMessage {
  parts:              LinqMessagePart[];
  effect?:            LinqEffect;
  preferred_service?: LinqService;
  reply_to?:          LinqReplyTo;
  idempotency_key?:   string;
}

export interface AgentSession {
  chatId:           string;
  userId?:          string;
  seniorId?:        string;
  caregiverId?:     string;
  groupChatId?:     string;
  service:          LinqService;
  optedOut:         boolean;
  // TCPA: undefined = transactional (no opt-in required); false = pending confirmation; true = confirmed
  optedIn?:         boolean;
  createdAt:        string;
  phone?:           string;
  // Onboarding state machine
  onboardingStep?:  string;
  userType?:        "client" | "caregiver";
  onboardingData?:  Record<string, unknown>;
}

export interface LinqPhoneNumber {
  phone_number:   string;
  status:         LinqPhoneStatus;
  health_status:  { status: LinqPhoneHealth; updated_at: string };
}

export interface LinqContactCard {
  phone_number: string;
  first_name:   string;
  last_name?:   string;
  image_url?:   string;
  is_active:    boolean;
}

// ── Retry helper — exponential backoff for 5xx and 3xxx transient errors ──────

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as AxiosError)?.response?.status;
      const code   = (err as AxiosError<{ code?: number }>)?.response?.data?.code;
      // Retry on server errors and transient 3xxx codes; respect Retry-After for 429
      if (status === 429) {
        const retryAfter = parseInt(
          (err as AxiosError)?.response?.headers?.["retry-after"] ?? "5",
          10
        );
        if (i < attempts - 1) {
          await new Promise<void>((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }
      }
      // Never retry on ETIMEDOUT — the Linq API is not responding; fail fast.
      if ((err as NodeJS.ErrnoException)?.code === "ETIMEDOUT" ||
          (err as NodeJS.ErrnoException)?.code === "ECONNABORTED") throw err;
      const isTransient = (status === 500 || status === 503 || status === 504) ||
                          (typeof code === "number" && code >= 3000 && code < 4000);
      if (!isTransient || i === attempts - 1) throw err;
      await new Promise<void>((r) => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
  throw lastErr;
}

// ── Capability check ──────────────────────────────────────────────────────────
// Docs: use `address` field (not `handle`) per /guides/chats/capability-checks/

export async function checkCapability(
  phone: string,
  from?: string
): Promise<{ iMessage: boolean; RCS: boolean }> {
  try {
    const body = { address: phone, ...(from ? { from } : {}) };
    const [imsgRes, rcsRes] = await Promise.allSettled([
      axios.post(
        `${cfg().baseUrl}/capability/check_imessage`,
        body,
        { headers: headers(), timeout: 10000 }
      ),
      axios.post(
        `${cfg().baseUrl}/capability/check_rcs`,
        body,
        { headers: headers(), timeout: 10000 }
      ),
    ]);
    const iMessage = imsgRes.status === "fulfilled" ? !!imsgRes.value.data?.available : false;
    const RCS      = rcsRes.status  === "fulfilled" ? !!rcsRes.value.data?.available  : false;
    return { iMessage, RCS };
  } catch {
    return { iMessage: false, RCS: false };
  }
}

// ── Core send ─────────────────────────────────────────────────────────────────

// Canonicalize message parts to the shapes Linq's API actually accepts.
// A `link` part accepts ONLY `{ type, value }` where `value` IS the URL
// (URI format) — there is no `url` field and no label field. A long-standing
// bug shipped `{ type:"link", url:<URL>, value:"📷 Label →" }`, which Linq
// rejects/drops (value isn't a URI). This repairs that shape — pulling the real
// http(s) URL out of `url`/`value` and discarding the label — so every send site
// is safe even if a caller copies the old pattern.
const HTTP_URL_RE = /^https?:\/\//i;

function normalizeParts(parts: LinqMessagePart[]): LinqMessagePart[] {
  if (!Array.isArray(parts)) return parts;
  return parts.map((p) => {
    // Strip robotic tone (em-dashes → commas, banned phrases) from every
    // outgoing text part. This is the single chokepoint both createChat and
    // sendOneMessage funnel through, so scripted/hardcoded sends — which call
    // sendMessage directly and never hit safeSend/supervise — get the same
    // voice cleanup the QA-agent path already gets. Layout-preserving so
    // multi-line messages (timesheets, OTP codes) keep their paragraph breaks.
    // Falls back to the original if linting somehow empties the part (Linq
    // rejects a message with no content).
    if (p.type === "text" && typeof p.value === "string") {
      // Voice cleanup AND PII redaction at the one chokepoint every send
      // crosses (U10), so scripted sends and sendToPhone-initiated chats are
      // scrubbed of SSNs / card numbers / cross-user emails too — not just the
      // runQuickReply path the old outboundGuard covered. Fail open.
      const cleaned = redactPii(lintPreservingLayout(p.value)).text;
      return { ...p, value: cleaned || p.value };
    }
    if (p.type !== "link") return p;
    const url =
      p.url && HTTP_URL_RE.test(p.url)     ? p.url   :
      p.value && HTTP_URL_RE.test(p.value) ? p.value :
      p.url ?? p.value;
    return { type: "link", value: url };
  });
}

export async function createChat(
  phone: string,
  message: LinqMessage
): Promise<{ chat_id: string; service: LinqService }> {
  // Build the body ONCE (outside withRetry) so the idempotency_key is stable
  // across retry attempts — a regenerated key on retry would defeat dedup and
  // could create a duplicate chat if the first attempt reached Linq.
  const body = {
    from:    cfg().phoneNumber,
    to:      [phone],
    message: {
      ...message,
      parts:           normalizeParts(message.parts),
      idempotency_key: message.idempotency_key ?? randomUUID(),
    },
  };
  const res = await withRetry(() =>
    axios.post(`${cfg().baseUrl}/chats`, body, { headers: headers(), timeout: 15000 })
  );
  const traceId = res.headers["x-trace-id"] as string | undefined;
  if (traceId) console.info("Linq createChat trace_id:", traceId);
  return {
    chat_id: res.data.chat_id ?? res.data.id ?? res.data.chat?.id,
    service:  res.data.service ?? res.data.chat?.service ?? "SMS",
  };
}

// URLs in plain-text messages — both explicit https:// and bare hostnames
// the LLM sometimes drops the scheme on. iMessage/RCS only auto-link when
// the scheme is present. Per Linq docs, `link` parts cannot be mixed with
// `text` parts in one message (returns error 1004), so URL-bearing strings
// are split into a text-only message followed by one dedicated link-part
// message per URL — iMessage/RCS then render each as a rich preview card.
const FULL_URL_RE =
  /\b(?:https?:\/\/[^\s<>"'`)\]]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|app|net|org|io|co|us|web\.app|dev|ai)(?:\/[^\s<>"'`)\]]*)?)/gi;

const URL_TRAILING_PUNCT = /[.,;:!?)\]}>'"]+$/;

interface UrlSplit {
  textOnly: string;
  urls:     string[];
}

/**
 * Strip URLs out of plain text and return them separately so callers can
 * send them as dedicated `link`-part messages (which render as rich preview
 * cards on iMessage/RCS). Adjacent separator characters left behind by the
 * strip ("Name → URL" → "Name → ") are trimmed back to "Name".
 */
function splitTextAndUrls(text: string): UrlSplit {
  const urls: string[] = [];
  // Replace URL plus any preceding separator (→ - : space) so the leftover
  // text stays readable. Trailing punctuation on the URL itself moves OUT of
  // the URL (it almost always belongs to the surrounding sentence).
  const stripped = text.replace(
    new RegExp(`(?:[ \\t]*[\\-→:,][ \\t]*)?${FULL_URL_RE.source}`, "gi"),
    (raw) => {
      const m = raw.match(FULL_URL_RE);
      if (!m) return "";
      let url = m[0];
      const trim = url.match(URL_TRAILING_PUNCT);
      if (trim) url = url.slice(0, url.length - trim[0].length);
      if (!url) return "";
      const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      urls.push(normalized);
      // Preserve trailing sentence punctuation that was attached to the URL.
      return trim ? trim[0] : "";
    }
  );

  // Cleanup: collapse 2+ spaces, drop empty lines, trim leading/trailing punct
  const textOnly = stripped
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").replace(/^[\s\-→:,]+|[\s\-→:,]+$/g, "").trim())
    .filter((l) => l.length > 0)
    .join("\n")
    .trim();

  return { textOnly, urls };
}

// Lowest-level send — one shot, no URL-splitting. Used by sendMessage's
// internal multi-message orchestration below and not exported.
async function sendOneMessage(
  chatId: string,
  message: LinqMessage
): Promise<{ message_id: string }> {
  // Linq v3 POST /chats/{id}/messages requires the message nested under a "message" key.
  // Top-level parts (without the wrapper) returns error 1005 "at least one part required".
  const body = {
    message: {
      ...message,
      parts:           normalizeParts(message.parts),
      idempotency_key: message.idempotency_key ?? randomUUID(),
    },
  };

  let res: AxiosResponse<{ id?: string; message_id?: string }>;
  try {
    res = await withRetry(() =>
      axios.post(
        `${cfg().baseUrl}/chats/${chatId}/messages`,
        body,
        { headers: headers(), timeout: 15000 }
      )
    );
  } catch (err) {
    const axErr = err as AxiosError;
    console.error("Linq sendMessage failed", {
      chatId,
      status: axErr?.response?.status,
      data:   JSON.stringify(axErr?.response?.data ?? {}),
    });
    try {
      const adminMod = await import("firebase-admin");
      const minuteBucket = new Date().toISOString().slice(0, 16);
      await adminMod.firestore().collection("admin_alerts").add({
        type:        "linq_send_failure",
        chatId,
        status:      axErr?.response?.status ?? null,
        errorBody:   JSON.stringify(axErr?.response?.data ?? {}).slice(0, 1000),
        dedupeKey:   `linq_send_failure:${minuteBucket}`,
        severity:    "high",
        resolved:    false,
        createdAt:   new Date().toISOString(),
      });
    } catch {/* non-critical */}
    throw err;
  }
  const traceId = res.headers["x-trace-id"] as string | undefined;
  if (traceId) console.info("Linq sendMessage trace_id:", traceId, "chatId:", chatId);
  return { message_id: res.data.id ?? res.data.message_id ?? "" };
}

export interface SendOptions {
  /**
   * Linq protocol selection. Omitted = automatic iMessage → RCS → SMS fallback.
   * "iMessage" = iMessage only, NO fallback (fails if recipient is not on iMessage).
   * "RCS"/"SMS" = RCS if supported else SMS, never iMessage.
   * Docs: /guides/messaging/protocol-selection/
   */
  preferredService?: LinqService;
}

export async function sendMessage(
  chatId: string,
  textOrMessage: string | LinqMessage,
  opts: SendOptions = {}
): Promise<{ message_id: string }> {
  const { preferredService } = opts;
  // Apply the requested protocol to every outgoing part-message below. For
  // structured callers that already set their own preferred_service, theirs wins.
  const svc = preferredService ? { preferred_service: preferredService } : {};

  // Mirror Cara's outbound message into the web chat inbox (threads/{id}/messages).
  // Fire-and-forget — mirroring must never delay or block SMS delivery.
  try {
    const { mirrorToWebThread, extractMirrorText } = await import("./threadMirror");
    // Mirror the cleaned text so the web inbox matches what actually went out
    // over SMS/iMessage. normalizeParts applies BOTH lintPreservingLayout AND
    // redactPii to every sent part, so the mirror must apply both too — otherwise
    // the web inbox would show SSNs / card numbers / cross-user emails that were
    // redacted before sending.
    const rawMirror = typeof textOrMessage === "string"
      ? lintPreservingLayout(textOrMessage)
      : extractMirrorText(textOrMessage);
    const mirrorText = redactPii(rawMirror).text;
    void mirrorToWebThread({ chatId, direction: "outbound", text: mirrorText });
  } catch { /* non-critical */ }

  // Structured callers (already LinqMessage) send as-is. Plain strings may
  // contain URLs — split them into text + per-URL link messages so iMessage/
  // RCS clients render rich preview cards instead of bare URLs.
  if (typeof textOrMessage !== "string") {
    const merged: LinqMessage =
      preferredService && !textOrMessage.preferred_service
        ? { ...textOrMessage, preferred_service: preferredService }
        : textOrMessage;
    const r = await sendOneMessage(chatId, merged);
    await trackForcedIMessage(r.message_id, chatId, merged);
    return r;
  }

  const { textOnly, urls } = splitTextAndUrls(textOrMessage);

  if (urls.length === 0) {
    const msg: LinqMessage = { parts: [{ type: "text", value: textOrMessage }], ...svc };
    const r = await sendOneMessage(chatId, msg);
    await trackForcedIMessage(r.message_id, chatId, msg);
    return r;
  }

  let firstId = "";

  // 1. Send the narrative text first (if anything remains after URL strip)
  if (textOnly) {
    const msg: LinqMessage = { parts: [{ type: "text", value: textOnly }], ...svc };
    const r = await sendOneMessage(chatId, msg);
    firstId = r.message_id;
    await trackForcedIMessage(r.message_id, chatId, msg);
    // Small delay so the link cards arrive AFTER the text bubble, not raced
    // ahead of it by Linq's pipeline.
    await new Promise<void>((res) => setTimeout(res, 600));
  }

  // 2. One dedicated link-part message per URL — Linq fetches OG metadata
  // and renders each as a rich preview card on iMessage/RCS, plain URL on SMS.
  // preferred_service is propagated to every follow-up so a forced protocol is
  // not silently dropped after the first bubble.
  for (let i = 0; i < urls.length; i++) {
    if (i > 0) await new Promise<void>((res) => setTimeout(res, 600));
    const msg: LinqMessage = { parts: [{ type: "link", value: urls[i] }], ...svc };
    const r = await sendOneMessage(chatId, msg);
    await trackForcedIMessage(r.message_id, chatId, msg);
    if (!firstId) firstId = r.message_id;
  }

  return { message_id: firstId };
}

// ── Forced-iMessage retry tracking ───────────────────────────────────────────
// Forced iMessage has NO fallback, so a delivery failure is otherwise silent.
// We record each forced-iMessage send keyed by its message_id; the
// message.failed webhook resolves the record and re-sends over SMS. Records
// auto-expire via a Firestore TTL policy on `ttl` (see auditLog.ts pattern) and
// are deleted on the message.delivered / message.sent success webhooks.
const IMESSAGE_RETRY_TTL_MS = 6 * 60 * 60 * 1000; // 6h

async function trackForcedIMessage(
  messageId: string,
  chatId: string,
  message: LinqMessage
): Promise<void> {
  if (!messageId || message.preferred_service !== "iMessage") return;
  try {
    await db.collection("agent_imessage_retry").doc(messageId).set({
      chatId,
      // Store the parts so the retry can re-send identical content over SMS.
      parts:     message.parts,
      effect:    message.effect ?? null,
      retried:   false,
      createdAt: new Date().toISOString(),
      ttl:       admin.firestore.Timestamp.fromMillis(Date.now() + IMESSAGE_RETRY_TTL_MS),
    });
  } catch {
    // Non-critical — retry resilience is best-effort.
  }
}

// ── Message retrieval + editing + deletion ───────────────────────────────────

export async function getMessage(messageId: string): Promise<Record<string, unknown>> {
  const res = await withRetry(() =>
    axios.get(`${cfg().baseUrl}/messages/${messageId}`, { headers: headers() })
  );
  return res.data as Record<string, unknown>;
}

export async function listMessages(params: {
  messageId: string;
  cursor?:   string;
  limit?:    number;
  order?:    "asc" | "desc";
}): Promise<{ messages: unknown[]; next_cursor: string | null }> {
  const query = new URLSearchParams();
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit)  query.set("limit",  String(Math.min(params.limit, 100)));
  if (params.order)  query.set("order",  params.order);
  const res = await withRetry(() =>
    axios.get(
      `${cfg().baseUrl}/messages/${params.messageId}/thread?${query}`,
      { headers: headers() }
    )
  );
  return { messages: res.data.messages ?? [], next_cursor: res.data.next_cursor ?? null };
}

export async function editMessage(
  messageId: string,
  newText:   string
): Promise<void> {
  await withRetry(() =>
    axios.post(
      `${cfg().baseUrl}/messages/${messageId}/update`,
      { text: newText },
      { headers: headers() }
    )
  );
}

export async function deleteMessage(messageId: string): Promise<void> {
  await withRetry(() =>
    axios.post(
      `${cfg().baseUrl}/messages/${messageId}/delete`,
      {},
      { headers: headers() }
    )
  );
}

// ── Reactions ─────────────────────────────────────────────────────────────────

export async function addReaction(params: {
  messageId:    string;
  type:         LinqReactionType;
  customEmoji?: string;
  partIndex?:   number;
}): Promise<void> {
  await withRetry(() =>
    axios.post(
      `${cfg().baseUrl}/messages/${params.messageId}/reactions`,
      {
        operation:    "add",
        type:         params.type,
        ...(params.customEmoji ? { custom_emoji: params.customEmoji } : {}),
        ...(params.partIndex !== undefined ? { part_index: params.partIndex } : {}),
      },
      { headers: headers() }
    )
  );
}

export async function removeReaction(params: {
  messageId:    string;
  type:         LinqReactionType;
  customEmoji?: string;
  partIndex?:   number;
}): Promise<void> {
  await withRetry(() =>
    axios.post(
      `${cfg().baseUrl}/messages/${params.messageId}/reactions`,
      {
        operation:    "remove",
        type:         params.type,
        ...(params.customEmoji ? { custom_emoji: params.customEmoji } : {}),
        ...(params.partIndex !== undefined ? { part_index: params.partIndex } : {}),
      },
      { headers: headers() }
    )
  );
}

// ── Typing indicators ─────────────────────────────────────────────────────────

export async function startTyping(chatId: string): Promise<void> {
  await axios
    .post(`${cfg().baseUrl}/chats/${chatId}/typing`, {}, { headers: headers() })
    .catch(() => {/* best-effort */});
}

export async function stopTyping(chatId: string): Promise<void> {
  await axios
    .delete(`${cfg().baseUrl}/chats/${chatId}/typing`, { headers: headers() })
    .catch(() => {/* non-critical */});
}

// Signal that Cara is working on something, before a slow operation (Stripe
// checkout/identity/Connect creation, Checkr invitation). iMessage gets the
// native typing bubble; SMS/RCS have no typing indicator, so they get a short
// interim line instead of dead silence during the multi-second wait.
export async function signalThinking(chatId: string, service: LinqService): Promise<void> {
  if (service === "iMessage") {
    await startTyping(chatId);
    return;
  }
  await sendMessage(chatId, "On it — one sec…").catch(() => {/* best-effort */});
}

// ── Voice memos ───────────────────────────────────────────────────────────────

export async function sendVoiceMemo(
  chatId: string,
  source: { url: string } | { attachment_id: string }
): Promise<void> {
  const body = "url" in source
    ? { voice_memo_url: source.url }
    : { attachment_id: source.attachment_id };
  await withRetry(() =>
    axios.post(`${cfg().baseUrl}/chats/${chatId}/voicememo`, body, { headers: headers() })
  );
}

// ── Contact card ──────────────────────────────────────────────────────────────
// Docs schema: first_name, last_name?, image_url? (not display_name/profile_photo_url)

export async function createOrUpdateContactCard(params: {
  phone_number: string;
  first_name:   string;
  last_name?:   string;
  image_url?:   string;
}): Promise<void> {
  // Try create first; if 2014 (already exists) fall back to PATCH update
  try {
    await withRetry(() =>
      axios.post(`${cfg().baseUrl}/contact_card`, params, { headers: headers() })
    );
  } catch (err) {
    const code = (err as AxiosError<{ code?: number }>)?.response?.data?.code;
    if (code === 2014) {
      await withRetry(() =>
        axios.patch(`${cfg().baseUrl}/contact_card`, params, { headers: headers() })
      ).catch(() => {/* non-critical */});
    }
    // Other errors are non-critical for brand identity
  }
}

export async function getContactCard(): Promise<LinqContactCard | null> {
  try {
    const res = await withRetry(() =>
      axios.get(`${cfg().baseUrl}/contact_card`, { headers: headers() })
    );
    return res.data as LinqContactCard;
  } catch {
    return null;
  }
}

/** @deprecated Use createOrUpdateContactCard — this alias kept for backward compat */
export async function setContactCard(params: {
  phone_number:       string;
  display_name:       string;
  profile_photo_url?: string;
}): Promise<void> {
  const [first_name, ...rest] = params.display_name.split(" ");
  await createOrUpdateContactCard({
    phone_number: params.phone_number,
    first_name:   first_name ?? params.display_name,
    last_name:    rest.join(" ") || undefined,
    image_url:    params.profile_photo_url,
  });
}

export async function shareContactCard(chatId: string): Promise<void> {
  await axios
    .post(`${cfg().baseUrl}/chats/${chatId}/share_contact_card`, {}, { headers: headers() })
    .catch(() => {/* non-critical */});
}

// ── Phone numbers ─────────────────────────────────────────────────────────────

export async function listPhoneNumbers(): Promise<LinqPhoneNumber[]> {
  try {
    const res = await withRetry(() =>
      axios.get(`${cfg().baseUrl}/phone_numbers`, { headers: headers() })
    );
    return (res.data?.phone_numbers ?? res.data ?? []) as LinqPhoneNumber[];
  } catch {
    return [];
  }
}

// ── Chat management ───────────────────────────────────────────────────────────

export async function updateChatName(chatId: string, displayName: string): Promise<void> {
  await axios
    .put(`${cfg().baseUrl}/chats/${chatId}`, { display_name: displayName }, { headers: headers() })
    .catch(() => {/* non-critical */});
}

export async function updateChatIcon(chatId: string, iconUrl: string): Promise<void> {
  await axios
    .put(`${cfg().baseUrl}/chats/${chatId}`, { group_chat_icon: iconUrl }, { headers: headers() })
    .catch(() => {/* non-critical */});
}

export async function markChatRead(chatId: string): Promise<void> {
  // Linq API path is /chats/{id}/read (returns 204 No Content).
  // Docs page slug says "mark_as_read" but the actual endpoint is /read.
  try {
    await axios.post(
      `${cfg().baseUrl}/chats/${chatId}/read`,
      {},
      { headers: headers(), timeout: 5000 }
    );
  } catch (err) {
    const e = err as AxiosError;
    console.warn("markChatRead failed", {
      chatId,
      status: e.response?.status,
      msg:    e.message,
    });
  }
}

export async function addParticipant(chatId: string, phone: string): Promise<void> {
  await withRetry(() =>
    axios.post(
      `${cfg().baseUrl}/chats/${chatId}/participants`,
      { handle: phone },
      { headers: headers() }
    )
  );
}

export async function removeParticipant(chatId: string, phone: string): Promise<void> {
  await withRetry(() =>
    axios.delete(
      `${cfg().baseUrl}/chats/${chatId}/participants/${encodeURIComponent(phone)}`,
      { headers: headers() }
    )
  );
}

// ── Session management (get-or-create) ───────────────────────────────────────

export async function getOrCreateSession(
  phone: string,
  meta?: Partial<Omit<AgentSession, "chatId" | "service" | "optedOut" | "createdAt">>
): Promise<AgentSession> {
  const ref = db.collection("agent_sessions").doc(phone);

  // Atomically claim the creation slot so concurrent calls don't each create a separate Linq chat.
  let isCreator = false;
  let existingSession: AgentSession | null = null;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data()!;
      if (data.chatId) {
        existingSession = data as AgentSession;
      }
      // else: _creating sentinel is present — another invocation owns creation
    } else {
      tx.set(ref, { _creating: true, phone, createdAt: new Date().toISOString() });
      isCreator = true;
    }
  });

  if (existingSession) return existingSession;

  if (!isCreator) {
    // Another concurrent invocation is creating the session — wait briefly for it to finish
    await new Promise<void>((r) => setTimeout(r, 2000));
    const retry = (await ref.get()).data() as AgentSession | undefined;
    if (retry?.chatId) return retry;
    throw new Error(`getOrCreateSession: concurrent creation timed out for ${phone}`);
  }

  // We won the race — make external API calls outside the transaction
  try {
    const capability = await checkCapability(phone);
    const service: LinqService = capability.iMessage ? "iMessage" : capability.RCS ? "RCS" : "SMS";

    // First message is a silent thread-opener; real content comes from the caller.
    // Per best-practices: no links or media in first message.
    const { chat_id } = await createChat(phone, {
      parts: [{ type: "text", value: "Hi! I'm Cara — your care assistant. I'm here whenever you need me." }],
    });

    const session: AgentSession = {
      chatId:    chat_id,
      service,
      optedOut:  false,
      createdAt: new Date().toISOString(),
      phone,
      ...meta,
    };

    await ref.set(session);

    // Best-practice: share contact card once after first outbound (non-blocking)
    if (service === "iMessage") {
      shareContactCard(chat_id).catch(() => {});
    }

    return session;
  } catch (err) {
    // Remove sentinel so the next call can retry rather than hanging
    await ref.delete().catch(() => {});
    throw err;
  }
}

// ── Circuit breaker — checked before every supervised send ───────────────────
// State is written by handlePhoneNumberStatusUpdated when the line is FLAGGED or CRITICAL.
// Cached in-process for 60s to avoid a Firestore read on every message.

let _cbCache: { open: boolean; cachedAt: number } = { open: false, cachedAt: 0 };

async function isCircuitOpen(): Promise<boolean> {
  if (Date.now() - _cbCache.cachedAt < 60_000) return _cbCache.open;
  try {
    const snap = await db.collection("system_config").doc("linq_circuit_breaker").get();
    const open = snap.exists && snap.data()?.status === "open";
    _cbCache = { open, cachedAt: Date.now() };
    return open;
  } catch {
    return false; // fail open — don't block sends on Firestore errors
  }
}

// ── Per-pair rate limiter (Linq cap: 30 messages per 60s per sender-recipient) ─

async function checkPairRateLimit(chatId: string): Promise<boolean> {
  const windowMs  = 60_000;
  const maxPerMin = 28; // stay under Linq's 30 hard cap with a 2-message buffer
  const now       = Date.now();
  const windowKey = Math.floor(now / windowMs);
  const ref       = db.collection("linq_pair_rate").doc(`${chatId}:${windowKey}`);

  try {
    const count = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur  = (snap.data()?.count as number) ?? 0;
      if (cur >= maxPerMin) return cur;
      tx.set(ref, { count: cur + 1, expiresAt: now + windowMs * 2 }, { merge: true });
      return cur + 1;
    });
    return count <= maxPerMin;
  } catch {
    return true; // fail open — don't block sends on Firestore errors
  }
}

// ── safeSend — lints + supervises then sends ─────────────────────────────────

export async function safeSend(
  chatId: string,
  message: string | LinqMessage,
  context: SuperviseContext,
  opts: SendOptions = {}
): Promise<void> {
  if (await isCircuitOpen()) {
    console.warn("safeSend: circuit breaker open (line FLAGGED/CRITICAL), dropping message", { chatId });
    return;
  }
  if (!(await checkPairRateLimit(chatId))) {
    console.warn("safeSend: per-pair rate limit reached, dropping message", { chatId });
    return;
  }

  let finalText = "";

  if (typeof message === "string") {
    const safe = await supervise(message, context).catch(() => message);
    finalText  = safe;
    await sendMessage(chatId, safe, opts);
  } else {
    // For structured messages (media, links), only lint text parts
    const parts = message.parts ?? [];
    const safeParts = await Promise.all(
      parts.map(async (p) => {
        if (p.type === "text" && p.value) {
          const safe = await supervise(p.value, context).catch(() => p.value ?? "");
          if (!finalText) finalText = safe;
          return { ...p, value: safe };
        }
        return p;
      })
    );
    await sendMessage(chatId, { ...message, parts: safeParts }, opts);
  }

  // Append-only audit log entry for every outbound message (non-blocking)
  if (context.phone) {
    logMessageSent(context.phone, context.phone, chatId, finalText || "[structured message]").catch(() => {});
  }
}

// ── High-level helper: send to a phone number ────────────────────────────────

export async function sendToPhone(
  phone: string,
  textOrMessage: string | LinqMessage,
  opts: SendOptions = {}
): Promise<void> {
  if (await isCircuitOpen()) {
    console.warn("sendToPhone: circuit breaker open, dropping message", { phone });
    return;
  }

  const ref  = db.collection("agent_sessions").doc(phone);
  const snap = await ref.get();

  if (snap.exists) {
    const session = snap.data() as AgentSession;
    if (session.optedOut || session.optedIn === false) return;
    await sendMessage(session.chatId, textOrMessage, opts);
    return;
  }

  // No session yet — create chat with this message as the opener
  const baseMessage: LinqMessage =
    typeof textOrMessage === "string"
      ? { parts: [{ type: "text", value: textOrMessage }] }
      : textOrMessage;
  // Forced protocol applies at chat creation (the documented place for it).
  const message: LinqMessage =
    opts.preferredService && !baseMessage.preferred_service
      ? { ...baseMessage, preferred_service: opts.preferredService }
      : baseMessage;

  const capability = await checkCapability(phone);
  const service: LinqService = capability.iMessage ? "iMessage" : capability.RCS ? "RCS" : "SMS";

  try {
    const created = await createChat(phone, message);
    const { chat_id } = created;
    const newSession: AgentSession = {
      chatId:    chat_id,
      // When a protocol was explicitly requested, trust Linq's response `service`
      // (what was actually used) over the capability-derived guess.
      service:   opts.preferredService ? created.service : service,
      optedOut:  false,
      createdAt: new Date().toISOString(),
      phone,
    };
    await ref.set(newSession);

    // Best-practice: share contact card after first outbound on iMessage (non-blocking)
    if (newSession.service === "iMessage") {
      shareContactCard(chat_id).catch(() => {});
    }
  } catch (err) {
    const e = err as AxiosError;
    console.error("Linq sendToPhone error:", e.response?.data ?? e.message);
    throw err;
  }
}
