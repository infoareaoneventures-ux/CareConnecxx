import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { generateCareMemoryKeepsake } from "./careMemory";
import { logAudit } from "../observability/auditLog";

const db = admin.firestore();

const BEREAVEMENT_KEYWORDS = [
  "passed away",
  "passed on",
  "she passed",
  "he passed",
  "they passed",
  "she died",
  "he died",
  "she's gone",
  "he's gone",
  "she has died",
  "he has died",
  "died today",
  "died last night",
  "funeral",
  "obituary",
  "rest in peace",
  "no longer with us",
  "we lost her",
  "we lost him",
  "gone to heaven",
];

export function isBereavementTrigger(text: string): boolean {
  const lower = text.toLowerCase();
  return BEREAVEMENT_KEYWORDS.some((kw) => lower.includes(kw));
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
