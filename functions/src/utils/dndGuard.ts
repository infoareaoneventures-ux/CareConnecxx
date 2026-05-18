import * as admin from "firebase-admin";
import { sendViaInteractionAgent, AgentOutput } from "../agents/caraAgent";
import { getPreferences, isInDND } from "../memory/preferences";

const db = admin.firestore();

export type DndUrgency = "critical" | "high" | "normal";

export async function sendIfNotDND(
  phone: string,
  output: AgentOutput,
  urgency: DndUrgency = "normal"
): Promise<void> {
  // critical always bypasses DND (crisis, 911, emergency)
  if (urgency === "critical") {
    return sendViaInteractionAgent(phone, output);
  }

  const prefs = await getPreferences(phone).catch(() => null);
  if (!prefs || !isInDND(prefs)) {
    return sendViaInteractionAgent(phone, output);
  }

  // In DND — compute when DND window ends and queue
  const dndEnd: string = (prefs as any).dndEnd ?? "08:00";
  const timezone: string = (prefs as any).timezone ?? "America/New_York";
  const sendAfter = computeDndEndTime(dndEnd, timezone);

  await db.collection("agent_dnd_queue").add({
    phone,
    content:     output.content,
    urgency:     output.urgency,
    sourceAgent: output.sourceAgent,
    canDrop:     output.canDrop ?? true,
    queuedAt:    new Date().toISOString(),
    sendAfter,
    sentAt:      null,
    dndUrgency:  urgency,
  });
}

function computeDndEndTime(dndEnd: string, timezone: string): string {
  const [h, m] = dndEnd.split(":").map(Number);
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone,
    }).formatToParts(now);
    const localH = parseInt(parts.find(p => p.type === "hour")?.value ?? "0");
    const localM = parseInt(parts.find(p => p.type === "minute")?.value ?? "0");
    const localMinutes = localH * 60 + localM;
    const targetMinutes = h * 60 + m;
    const minutesUntilEnd = targetMinutes > localMinutes
      ? targetMinutes - localMinutes
      : 1440 - localMinutes + targetMinutes;
    return new Date(now.getTime() + minutesUntilEnd * 60 * 1000).toISOString();
  } catch {
    // Fallback: 8 hours from now
    return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();
  }
}
