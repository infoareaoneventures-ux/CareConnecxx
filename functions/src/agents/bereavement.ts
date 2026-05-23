import * as admin from "firebase-admin";
import { quickComplete } from "../utils/openaiClient";
import { sendMessage } from "../linq/client";
import { generateCareMemoryKeepsake } from "./careMemory";
import { logAudit } from "../observability/auditLog";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

// Fast-path keywords for obvious signals — Claude handles the nuanced cases
const OBVIOUS_BEREAVEMENT = ["passed away", "passed on", "she died", "he died", "they died",
  "funeral", "obituary", "died today", "died last night"];

export async function isBereavementTrigger(text: string): Promise<boolean> {
  const lower = text.toLowerCase();
  if (OBVIOUS_BEREAVEMENT.some((kw) => lower.includes(kw))) return true;
  try {
    const raw = await quickComplete(
      "You are reading an SMS from a family using a care platform. " +
        "Reply YES if this message is informing us that their care recipient has died or passed away. " +
        "Reply NO otherwise. Reply with only YES or NO.",
      text,
      { maxTokens: 5 },
    );
    return raw.trim().toUpperCase().startsWith("Y");
  } catch {
    return false;
  }
}

export async function activateBereavementMode(
  userId:     string,
  chatId:     string,
  phone:      string,
  seniorName: string
): Promise<void> {
  // 1. Set bereavementMode with activation timestamp
  await db.collection("agent_sessions").doc(phone).update({
    bereavementMode:         true,
    bereavementActivatedAt:  new Date().toISOString(),
  });

  // 2. Cancel all pending proactive triggers
  const triggerSnap = await db
    .collection("proactive_triggers")
    .where("userId", "==", userId)
    .where("firedAt",     "==", null)
    .where("cancelledAt", "==", null)
    .get();

  if (!triggerSnap.empty) {
    const batch = db.batch();
    const now   = new Date().toISOString();
    for (const doc of triggerSnap.docs) {
      batch.update(doc.ref, { cancelledAt: now, cancelReason: "bereavement" });
    }
    await batch.commit().catch(() => {});
  }

  // 3. Send compassionate opening message
  const condolenceMsg = await generateCaraMessage({
    audience: "family",
    context: `Cara just learned that ${seniorName} has passed away. Send heartfelt condolences to the family. The tone should be warm, gentle, and compassionate — not clinical. Cara may use a heart emoji (💙) if appropriate.`,
    fallback: `I'm so sorry for the loss of ${seniorName}. 💙\n\nPlease take all the time you need. I'm here whenever you're ready.`,
    maxTokens: 100,
  });
  await sendMessage(chatId, condolenceMsg);

  // 4. Generate care memory keepsake (non-blocking — takes a moment)
  const seniorSnap = await db.collection("users").doc(userId).get();
  const seniorId   = seniorSnap.data()?.seniorId ?? userId;

  generateCareMemoryKeepsake(seniorId, userId)
    .then(async (url) => {
      if (!url) {
        // Keepsake generation failed — send a compassionate fallback so family isn't left in silence.
        const keepsakePromiseMsg = await generateCaraMessage({
          audience: "family",
          context: `Cara is promising to create a care memory keepsake for ${seniorName} — a record of their journey and all the love that surrounded them. The tone should be warm, gentle, and compassionate — not clinical. Cara may use a heart emoji (💙) if appropriate.`,
          fallback: `I'll put together a care memory for ${seniorName} — a record of their journey and all the love that surrounded them. I'll send it to you shortly. 💙`,
          maxTokens: 100,
        });
        await sendMessage(chatId, keepsakePromiseMsg).catch(() => {});
        return;
      }
      const keepsakeDeliveryMsg = await generateCaraMessage({
        audience: "family",
        context: `Cara is delivering the care memory keepsake for ${seniorName} — a record of their journey and all the love that surrounded them. The tone should be warm, gentle, and compassionate — not clinical. Cara may use a heart emoji (💙) if appropriate.`,
        fallback: `I've put together a care memory for you — a record of ${seniorName}'s journey and all the love that surrounded them. 💙`,
        maxTokens: 100,
      });
      await sendMessage(chatId, keepsakeDeliveryMsg);
      await sendMessage(chatId, { parts: [{ type: "link" as const, value: url }] } as any);
    })
    .catch((err) => console.error("bereavement keepsake error:", err));

  // 5. Audit log
  logAudit({
    eventType: "session_created",
    userId,
    phone,
    data: { event: "bereavement_mode_activated", seniorName },
  }).catch(() => {});
}
