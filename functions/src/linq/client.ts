import axios, { AxiosError } from "axios";
import * as admin from "firebase-admin";
import { v4 as uuidv4 } from "uuid";
import { supervise, SuperviseContext } from "../safety/supervisor";
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
        { headers: headers() }
      ),
      axios.post(
        `${cfg().baseUrl}/capability/check_rcs`,
        body,
        { headers: headers() }
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

export async function createChat(
  phone: string,
  message: LinqMessage
): Promise<{ chat_id: string; service: LinqService }> {
  const res = await withRetry(() =>
    axios.post(
      `${cfg().baseUrl}/chats`,
      {
        from:    cfg().phoneNumber,
        to:      [phone],
        message: { ...message, idempotency_key: message.idempotency_key ?? uuidv4() },
      },
      { headers: headers() }
    )
  );
  const traceId = res.headers["x-trace-id"] as string | undefined;
  if (traceId) console.info("Linq createChat trace_id:", traceId);
  return { chat_id: res.data.chat_id ?? res.data.id, service: res.data.service ?? "SMS" };
}

export async function sendMessage(
  chatId: string,
  textOrMessage: string | LinqMessage
): Promise<{ message_id: string }> {
  const message: LinqMessage =
    typeof textOrMessage === "string"
      ? { parts: [{ type: "text", value: textOrMessage }] }
      : textOrMessage;

  const res = await withRetry(() =>
    axios.post(
      `${cfg().baseUrl}/chats/${chatId}/messages`,
      { ...message, idempotency_key: message.idempotency_key ?? uuidv4() },
      { headers: headers() }
    )
  );
  const traceId = res.headers["x-trace-id"] as string | undefined;
  if (traceId) console.info("Linq sendMessage trace_id:", traceId, "chatId:", chatId);
  return { message_id: res.data.id ?? res.data.message_id ?? "" };
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
  await axios
    .post(`${cfg().baseUrl}/chats/${chatId}/mark_as_read`, {}, { headers: headers() })
    .catch(() => {/* non-critical */});
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
  const ref  = db.collection("agent_sessions").doc(phone);
  const snap = await ref.get();

  if (snap.exists) {
    return snap.data() as AgentSession;
  }

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
}

// ── safeSend — lints + supervises then sends ─────────────────────────────────

export async function safeSend(
  chatId: string,
  message: string | LinqMessage,
  context: SuperviseContext
): Promise<void> {
  let finalText = "";

  if (typeof message === "string") {
    const safe = await supervise(message, context).catch(() => message);
    finalText  = safe;
    await sendMessage(chatId, safe);
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
    await sendMessage(chatId, { ...message, parts: safeParts });
  }

  // Append-only audit log entry for every outbound message (non-blocking)
  if (context.phone) {
    logMessageSent(context.phone, context.phone, chatId, finalText || "[structured message]").catch(() => {});
  }
}

// ── High-level helper: send to a phone number ────────────────────────────────

export async function sendToPhone(
  phone: string,
  textOrMessage: string | LinqMessage
): Promise<void> {
  const ref  = db.collection("agent_sessions").doc(phone);
  const snap = await ref.get();

  if (snap.exists) {
    const session = snap.data() as AgentSession;
    if (session.optedOut || session.optedIn === false) return;
    await sendMessage(session.chatId, textOrMessage);
    return;
  }

  // No session yet — create chat with this message as the opener
  const message: LinqMessage =
    typeof textOrMessage === "string"
      ? { parts: [{ type: "text", value: textOrMessage }] }
      : textOrMessage;

  const capability = await checkCapability(phone);
  const service: LinqService = capability.iMessage ? "iMessage" : capability.RCS ? "RCS" : "SMS";

  try {
    const { chat_id } = await createChat(phone, message);
    const newSession: AgentSession = {
      chatId:    chat_id,
      service,
      optedOut:  false,
      createdAt: new Date().toISOString(),
      phone,
    };
    await ref.set(newSession);

    // Best-practice: share contact card after first outbound on iMessage (non-blocking)
    if (service === "iMessage") {
      shareContactCard(chat_id).catch(() => {});
    }
  } catch (err) {
    const e = err as AxiosError;
    console.error("Linq sendToPhone error:", e.response?.data ?? e.message);
    throw err;
  }
}
