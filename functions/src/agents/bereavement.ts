import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import { sendMessage } from "../linq/client";
import { generateCareMemoryKeepsake } from "./careMemory";
import { logAudit } from "../observability/auditLog";

const db = admin.firestore();

let _claude: Anthropic | null = null;
function getClaude(): Anthropic {
  if (!_claude) _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

// Fast-path keywords for obvious signals — Claude handles the nuanced cases
const OBVIOUS_BEREAVEMENT = ["passed away", "passed on", "she died", "he died", "they died",
  "funeral", "obituary", "died today", "died last night"];

export async function isBereavementTrigger(text: string): Promise<boolean> {
  const lower = text.toLowerCase();
  if (OBVIOUS_BEREAVEMENT.some((kw) => lower.includes(kw))) return true;
  try {
    const res = await getClaude().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 5,
      system:
        "You are reading an SMS from a family using a care platform. " +
        "Reply YES if this message is informing us that their care recipient has died or passed away. " +
        "Reply NO otherwise. Reply with only YES or NO.",
      messages: [{ role: "user", content: text }],
    });
    return ((res.content[0] as { text: string }).text ?? "").trim().toUpperCase().startsWith("Y");
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
  await sendMessage(chatId,
    `I'm so sorry for the loss of ${seniorName}. 💙\n\n` +
    `Please take all the time you need. I'm here whenever you're ready.`
  );

  // 4. Generate care memory keepsake (non-blocking — takes a moment)
  const seniorSnap = await db.collection("users").doc(userId).get();
  const seniorId   = seniorSnap.data()?.seniorId ?? userId;

  generateCareMemoryKeepsake(seniorId, userId)
    .then(async (url) => {
      if (!url) return;
      await sendMessage(chatId,
        `I've put together a care memory for you — a record of ${seniorName}'s journey and all the love that surrounded them. 💙`
      );
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
