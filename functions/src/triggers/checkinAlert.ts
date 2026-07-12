import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";

const db = admin.firestore();

const STATUS_EMOJI: Record<string, string> = {
  all_good:         "✅",
  needs_attention:  "⚠️",
  medication_given: "💊",
  meal_prepared:    "🍽️",
};

export const onCheckinCreated = functions.firestore
  .document("shift_checkins/{checkinId}")
  .onCreate(async (snap) => {
    const data = snap.data();
    const { clientId, caregiverName, status, notes } = data;
    // Writers (gpsCheckin, mcp record_checkin) stamp `checkinAt` — the old
    // `timestamp` destructure was always undefined, so the family SMS said
    // "check-in at Invalid Date". Render in PT (UTC otherwise).
    const checkinAt = data.checkinAt ?? data.timestamp;

    if (!clientId) return;

    const sessionSnap = await db
      .collection("agent_sessions")
      .where("userId", "==", clientId)
      .limit(1)
      .get();

    if (sessionSnap.empty) return;

    const phone = sessionSnap.docs[0].id;
    const checkinMs = Date.parse(String(checkinAt ?? ""));
    const time = new Date(Number.isFinite(checkinMs) ? checkinMs : Date.now()).toLocaleTimeString("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      minute: "2-digit",
    });

    const emoji = STATUS_EMOJI[status as string] ?? "📋";
    const label = (status as string).replace(/_/g, " ");
    const noteText = notes ? `\n"${notes}"` : "";

    await sendViaInteractionAgent(phone, {
      content: `${emoji} ${caregiverName} check-in at ${time}: ${label}${noteText}`,
      urgency: "standard",
      sourceAgent: "arrival_notification",
      canDrop: false,
    });
  });
