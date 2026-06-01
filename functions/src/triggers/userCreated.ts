import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import {
  checkCapability,
  createChat,
  shareContactCard,
  AgentSession,
  LinqService,
} from "../linq/client";
import { setupCaraContactCard } from "../sms";

const db = admin.firestore();

export const onUserCreated = functions.auth.user().onCreate(async (user) => {
  try {
    // Load user profile — clients write to 'users', caregivers to 'caregivers'
    const userDoc = await db.collection("users").doc(user.uid).get();
    const data = userDoc.data();

    // Only create iMessage threads for clients with a phone number
    if (!data?.phone || data?.userType !== "client") return;

    const phone: string = data.phone;

    // Don't create duplicate sessions
    const existing = await db.collection("agent_sessions").doc(phone).get();
    if (existing.exists) return;

    const capability = await checkCapability(phone);
    const service: LinqService = capability.iMessage
      ? "iMessage"
      : capability.RCS
      ? "RCS"
      : "SMS";

    const firstName: string = data.firstName ?? data.name?.split(" ")[0] ?? "there";

    // TCPA: first message must request consent — no care data sent until user replies YES
    const optInText =
      `Hi ${firstName} — I'm Cara, your AI care assistant.\n\n` +
      `Reply YES to receive real-time care updates — visit summaries, wellness alerts, ` +
      `and health signals for your loved one.\n\n` +
      `Reply STOP anytime to opt out. Msg & data rates may apply.`;

    const chat = await createChat(phone, {
      parts: [{ type: "text", value: optInText }],
    });

    // Register Cara as a named contact so users see "Cara" not a raw number
    await setupCaraContactCard();
    await shareContactCard(chat.chat_id).catch(() => {/* non-critical */});

    const session: AgentSession = {
      chatId:    chat.chat_id,
      userId:    user.uid,
      seniorId:  user.uid, // seniorId === clientId for single-senior households
      service,
      optedOut:  false,
      optedIn:   false,  // pending — wait for YES reply
      createdAt: new Date().toISOString(),
    };

    await db.collection("agent_sessions").doc(phone).set(session);

    console.log(`agent_sessions created for ${user.uid} (${service})`);
  } catch (err) {
    // Never throw from auth triggers — it blocks user creation
    console.error("onUserCreated Linq error:", err);
  }
});
