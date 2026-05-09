import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { sendMessage, startTyping, stopTyping, shareContactCard, AgentSession } from "./client";
import { classifyIntent } from "../agents/intentClassifier";
import { runQaAgent } from "../agents/qaAgent";
import { handleTaskApproval } from "../agents/taskApprovalHandler";
import { optOutPhoneNumber } from "../sms";

const db = admin.firestore();

// ── Signature verification ────────────────────────────────────────────────────

function verifySignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string
): boolean {
  const payload  = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

async function isRateLimited(phone: string): Promise<boolean> {
  const rateRef = db.collection("agent_rate").doc(phone);
  const snap    = await rateRef.get();
  const now     = Date.now();
  const hourAgo = now - 60 * 60 * 1000;

  const calls: number[] = ((snap.data()?.calls ?? []) as number[]).filter(t => t > hourAgo);
  if (calls.length >= 10) return true;

  await rateRef.set({ calls: [...calls, now] });
  return false;
}

// ── Opt-in confirmation handler ───────────────────────────────────────────────

async function handleOptIn(phone: string, chatId: string, session: AgentSession): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({ optedIn: true });

  // Load first name for personalised welcome
  let firstName = "there";
  if (session.userId) {
    const userDoc = await db.collection("users").doc(session.userId).get();
    firstName = userDoc.data()?.firstName ?? userDoc.data()?.name?.split(" ")[0] ?? "there";
  }

  await sendMessage(
    chatId,
    `You're all set, ${firstName}! 🎉\n\n` +
    `I'll send you real-time updates after every care visit — mood, meals, meds, and more.\n\n` +
    `Here's what you can ask me anytime:\n` +
    `· "How is [name] doing?"\n` +
    `· "When is the next visit?"\n` +
    `· "What did she eat today?"\n` +
    `· "Show me this week's updates"\n\n` +
    `Reply STOP anytime to unsubscribe.`
  );

  // Share CareConnecxx as a saved contact now that they've opted in
  await shareContactCard(chatId).catch(() => {/* non-critical */});
}

// ── Typing indicator — pre-fetch context so Claude responds faster ────────────

async function handleTypingStarted(event: any): Promise<void> {
  const phone  = event.data?.sender_handle?.value as string | undefined;
  const chatId = event.data?.chat?.id as string | undefined;
  if (!phone || !chatId) return;

  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
  if (!sessionSnap.exists) return;

  const session = sessionSnap.data() as AgentSession;
  if (session.optedOut || session.optedIn === false) return;

  const seniorId = session.seniorId ?? session.userId ?? "";
  const userId   = session.userId ?? "";

  // Pre-fetch in parallel — same reads qaAgent will need
  const now = new Date().toISOString();

  const [seniorSnap, journalSnap, apptSnap, historySnap] = await Promise.all([
    db.collection("senior_profiles").doc(seniorId).get(),
    db.collection("care_journal")
      .where("seniorId", "==", seniorId)
      .orderBy("timestamp", "desc")
      .limit(3)
      .get(),
    db.collection("appointments")
      .where("clientId", "==", userId)
      .where("isoDate", ">=", now.slice(0, 10))
      .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
      .orderBy("isoDate", "asc")
      .limit(1)
      .get(),
    db.collection("agent_conversations")
      .doc(phone)
      .collection("messages")
      .orderBy("timestamp", "desc")
      .limit(10)
      .get(),
  ]).catch(() => [null, null, null, null]);

  if (!seniorSnap) return;

  const prefetch = {
    seniorProfile:       seniorSnap.exists ? seniorSnap.data() : null,
    recentJournal:       journalSnap ? journalSnap.docs.map(d => d.data()) : [],
    nextAppointment:     apptSnap && !apptSnap.empty ? apptSnap.docs[0].data() : null,
    conversationHistory: historySnap
      ? historySnap.docs.map(d => d.data()).reverse()
      : [],
    cachedAt:  now,
    expiresAt: new Date(Date.now() + 60 * 1000).toISOString(), // 60s TTL
  };

  await db.collection("agent_prefetch").doc(phone).set(prefetch);
}

// ── Inbound message handler ───────────────────────────────────────────────────

async function handleInbound(event: any): Promise<void> {
  const phone  = event.data?.sender_handle?.value as string | undefined;
  const text   = (event.data?.parts?.[0]?.value ?? "") as string;
  const chatId = event.data?.chat?.id as string | undefined;

  if (!phone || !chatId) return;

  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
  if (!sessionSnap.exists) return;

  const session = sessionSnap.data() as AgentSession;

  const stopWords = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "CANCEL", "END"]);
  const normalized = text.trim().toUpperCase();

  if (session.optedOut) return;

  // STOP — opt out immediately, works at any stage
  if (stopWords.has(normalized)) {
    await optOutPhoneNumber(phone);
    await sendMessage(chatId, "You've been unsubscribed from CareConnecxx messages. Reply START anytime to reactivate.");
    return;
  }

  // TCPA opt-in gate — session exists but user hasn't confirmed yet
  if (session.optedIn === false) {
    if (normalized === "YES" || normalized === "START") {
      await handleOptIn(phone, chatId, session);
    } else {
      await sendMessage(chatId, "Reply YES to activate care updates, or STOP to opt out.");
    }
    return;
  }

  // Rate limit — max 10 Claude calls per phone per hour
  if (await isRateLimited(phone)) {
    await sendMessage(chatId, "I'm getting a lot of messages right now — try again in a bit! 😊");
    return;
  }

  // Check for pending task (emergency replacement flow)
  const taskSnap = await db
    .collection("agent_tasks")
    .where("clientPhone", "==", phone)
    .where("status", "==", "awaiting_approval")
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();

  const pendingTask = taskSnap.empty ? null : taskSnap.docs[0];

  // Show typing indicator — family sees "..." while Claude thinks
  await startTyping(chatId).catch(() => {/* non-critical */});

  try {
    const intent = await classifyIntent(text, !!pendingTask);

    if (intent === "TASK_REPLY" && pendingTask && ["1", "2", "3"].includes(text.trim())) {
      await handleTaskApproval(pendingTask, text.trim(), session, chatId);
      return; // handleTaskApproval sends its own messages
    }

    const reply = await runQaAgent({
      text,
      phone,
      userId:   session.userId   ?? "",
      seniorId: session.seniorId ?? session.userId ?? "",
    });

    await sendMessage(chatId, reply);
  } catch (err) {
    console.error("handleInbound error:", err);
    await stopTyping(chatId);
    await sendMessage(chatId, "I'm having trouble right now. For urgent concerns, please call 911.");
  }
}

// ── Webhook HTTPS function ────────────────────────────────────────────────────

export const linqWebhook = functions.https.onRequest(async (req, res) => {
  // Always return 200 immediately — Linq expects a fast ack
  res.status(200).send("ok");

  if (req.method !== "POST") return;

  // Signature verification (skip if no secret configured — dev mode)
  const webhookSecret = process.env.LINQ_WEBHOOK_SECRET;
  if (webhookSecret) {
    const timestamp = req.headers["x-webhook-timestamp"] as string ?? "";
    const signature = req.headers["x-webhook-signature"] as string ?? "";
    const rawBody   = JSON.stringify(req.body);

    if (!verifySignature(rawBody, timestamp, signature, webhookSecret)) {
      console.warn("linqWebhook: invalid signature — ignoring");
      return;
    }
  }

  const event = req.body;

  // Route by event type
  switch (event.type) {
    case "message.received":
      await handleInbound(event).catch((err) =>
        console.error("linqWebhook handleInbound:", err)
      );
      break;

    case "message.read":
      // Log read receipts for engagement tracking (Sprint 4)
      await db.collection("agent_read_receipts").add({
        chatId:    event.data?.chat?.id,
        messageId: event.data?.message_id,
        phone:     event.data?.sender_handle?.value,
        readAt:    new Date().toISOString(),
      }).catch(() => {/* non-critical */});
      break;

    case "reaction.added":
      await db.collection("agent_reactions").add({
        chatId:    event.data?.chat?.id,
        messageId: event.data?.message_id,
        reaction:  event.data?.reaction,
        phone:     event.data?.sender_handle?.value,
        reactedAt: new Date().toISOString(),
      }).catch(() => {/* non-critical */});
      break;

    case "chat.typing_indicator.started":
      await handleTypingStarted(event).catch((err) =>
        console.error("linqWebhook handleTypingStarted:", err)
      );
      break;

    default:
      break;
  }
});
