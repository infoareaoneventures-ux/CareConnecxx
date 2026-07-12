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

    // /start web signups text Evia themselves moments after this trigger fires
    // (MO consent) — the webhook's web bridge owns that first touch with Evia's
    // real voice, and a session created here would block the bridge entirely
    // (it only runs when no agent_sessions doc exists). Only reach out first
    // for accounts with no pending web handoff (e.g. admin-created clients).
    const webSession = await db.collection("web_onboarding_sessions").doc(phone).get();
    const webStatus = webSession.exists ? (webSession.data()?.status as string | undefined) : undefined;
    if (webStatus === "awaiting_inbound" || webStatus === "connected") return;

    const capability = await checkCapability(phone);
    const service: LinqService = capability.iMessage
      ? "iMessage"
      : capability.RCS
      ? "RCS"
      : "SMS";

    // firstName may hold a full name — always take the first word
    const firstName: string = (data.firstName ?? data.name ?? "there").trim().split(/\s+/)[0] || "there";

    // TCPA: first message must request consent — no care data sent until user replies YES.
    // Keep this a template (never LLM-generated): consent language must be exact and auditable.
    const optInText =
      `Hi ${firstName} — I'm Evia, your care coordinator.\n\n` +
      `Reply YES and I'll text you real-time care updates and a summary after every visit — ` +
      `and I can help you find background-checked caregivers, set up interviews, and ` +
      `schedule visits, all right here over text.\n\n` +
      `Reply STOP anytime to opt out. Msg & data rates may apply.`;

    const chat = await createChat(phone, {
      parts: [{ type: "text", value: optInText }],
    });

    // Register Evia as a named contact so users see "Evia" not a raw number
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
