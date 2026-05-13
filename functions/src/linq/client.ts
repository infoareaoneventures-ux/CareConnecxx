import axios, { AxiosError } from "axios";
import * as admin from "firebase-admin";
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

export interface LinqMessagePart {
  type: "text" | "media" | "link";
  value?: string;
  url?:   string;
}

export interface LinqEffect {
  type: "screen";
  name: "confetti" | "hearts" | "fireworks" | "balloons" | "lasers" | "shooting_star";
}

export interface LinqMessage {
  parts:   LinqMessagePart[];
  effect?: LinqEffect;
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

// ── Capability check ──────────────────────────────────────────────────────────

export async function checkCapability(
  phone: string
): Promise<{ iMessage: boolean; RCS: boolean }> {
  try {
    const { data } = await axios.post(
      `${cfg().baseUrl}/capability_checks`,
      { handles: [phone] },
      { headers: headers() }
    );
    const result = data?.handles?.[phone] ?? {};
    return { iMessage: !!result.iMessage, RCS: !!result.RCS };
  } catch {
    return { iMessage: false, RCS: false };
  }
}

// ── Core send ─────────────────────────────────────────────────────────────────

export async function createChat(
  phone: string,
  message: LinqMessage
): Promise<{ chat_id: string; service: LinqService }> {
  const { data } = await axios.post(
    `${cfg().baseUrl}/chats`,
    { from: cfg().phoneNumber, to: [phone], message },
    { headers: headers() }
  );
  return { chat_id: data.chat_id ?? data.id, service: data.service ?? "SMS" };
}

export async function sendMessage(
  chatId: string,
  textOrMessage: string | LinqMessage
): Promise<void> {
  const message: LinqMessage =
    typeof textOrMessage === "string"
      ? { parts: [{ type: "text", value: textOrMessage }] }
      : textOrMessage;

  await axios.post(
    `${cfg().baseUrl}/chats/${chatId}/messages`,
    message,
    { headers: headers() }
  );
}

export async function startTyping(chatId: string): Promise<void> {
  await axios.post(`${cfg().baseUrl}/chats/${chatId}/typing`, {}, { headers: headers() });
}

export async function stopTyping(chatId: string): Promise<void> {
  await axios
    .delete(`${cfg().baseUrl}/chats/${chatId}/typing`, { headers: headers() })
    .catch(() => {/* non-critical */});
}

export async function sendVoiceMemo(chatId: string, voiceMemoUrl: string): Promise<void> {
  await axios.post(
    `${cfg().baseUrl}/chats/${chatId}/voicememo`,
    { voice_memo_url: voiceMemoUrl },
    { headers: headers() }
  );
}

export async function shareContactCard(chatId: string): Promise<void> {
  await axios
    .post(`${cfg().baseUrl}/chats/${chatId}/share_contact_card`, {}, { headers: headers() })
    .catch(() => {/* non-critical */});
}

export async function setContactCard(params: {
  phone_number:       string;
  display_name:       string;
  profile_photo_url?: string;
}): Promise<void> {
  await axios
    .post(`${cfg().baseUrl}/contact_card`, params, { headers: headers() })
    .catch(() => {/* non-critical */});
}

export async function updateChatName(chatId: string, displayName: string): Promise<void> {
  await axios
    .put(`${cfg().baseUrl}/chats/${chatId}`, { display_name: displayName }, { headers: headers() })
    .catch(() => {/* non-critical */});
}

export async function addParticipant(chatId: string, phone: string): Promise<void> {
  await axios.post(
    `${cfg().baseUrl}/chats/${chatId}/participants`,
    { handle: phone },
    { headers: headers() }
  );
}

// ── Session management (get-or-create) ───────────────────────────────────────

export async function getOrCreateSession(
  phone: string,
  meta?: Partial<Omit<AgentSession, "chatId" | "service" | "optedOut" | "createdAt">>
): Promise<AgentSession> {
  const ref = db.collection("agent_sessions").doc(phone);
  const snap = await ref.get();

  if (snap.exists) {
    return snap.data() as AgentSession;
  }

  const capability = await checkCapability(phone);
  const service: LinqService = capability.iMessage ? "iMessage" : capability.RCS ? "RCS" : "SMS";

  // First message is a silent thread-opener; real content comes from the caller
  const { chat_id } = await createChat(phone, {
    parts: [{ type: "text", value: "Hi! I'm Cara — your care assistant. I'm here whenever you need me." }],
  });

  const session: AgentSession = {
    chatId:    chat_id,
    service,
    optedOut:  false,
    createdAt: new Date().toISOString(),
    ...meta,
  };

  await ref.set(session);
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
  const ref = db.collection("agent_sessions").doc(phone);
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
    await ref.set({
      chatId:    chat_id,
      service,
      optedOut:  false,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    const e = err as AxiosError;
    console.error("Linq sendToPhone error:", e.response?.data ?? e.message);
    throw err;
  }
}
