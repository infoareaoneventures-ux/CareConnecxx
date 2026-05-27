import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { quickComplete } from "../utils/openaiClient";
import { sendViaInteractionAgent } from "./caraAgent";

const db = admin.firestore();

interface PendingClientShiftConfirm {
  appointmentId:      string;
  appointmentDate:    string;
  appointmentDisplay?: string;
  caregiverId:        string;
  caregiverName:      string;
  seniorName:         string;
  startTime:          string;
  sentAt:             string;
}

// Classify the family's reply to the day-before reminder. Returns CONFIRM, CANCEL,
// or QUESTION. Conservative defaults: anything ambiguous falls to QUESTION (we
// answer + re-prompt) rather than acting destructively.
async function classifyReply(text: string): Promise<"CONFIRM" | "CANCEL" | "QUESTION"> {
  try {
    const raw = await quickComplete(
      "Cara just sent a family member a day-before reminder for a care visit. The user just replied. " +
      "Classify their intent:\n" +
      "- CONFIRM if they're acknowledging the visit is still on (\"yes\", \"sounds good\", \"we'll be here\", \"confirmed\", thumbs-up)\n" +
      "- CANCEL if they want to cancel the visit (\"cancel\", \"can't make it\", \"need to reschedule\", \"something came up\")\n" +
      "- QUESTION if they're asking something or unclear\n" +
      "Reply with only CONFIRM, CANCEL, or QUESTION.",
      text,
      { maxTokens: 5 },
    );
    const v = raw.trim().toUpperCase();
    if (v.startsWith("CONFIRM") || v === "C") return "CONFIRM";
    if (v.startsWith("CANCEL")) return "CANCEL";
    return "QUESTION";
  } catch {
    return "QUESTION";
  }
}

export async function handleClientShiftConfirm(
  phone:   string,
  chatId:  string,
  text:    string,
  session: Record<string, unknown>,
): Promise<void> {
  const info = session.pendingClientShiftConfirm as PendingClientShiftConfirm | undefined;
  if (!info) return;

  const verdict = await classifyReply(text);

  if (verdict === "CONFIRM") {
    await db.collection("agent_sessions").doc(phone).update({
      pendingClientShiftConfirm: admin.firestore.FieldValue.delete(),
      stateExpiresAt:            admin.firestore.FieldValue.delete(),
    });
    await db.collection("appointments").doc(info.appointmentId).update({
      clientConfirmedAt: new Date().toISOString(),
    }).catch(() => {});
    await sendMessage(chatId,
      `Got it — ${info.caregiverName.split(" ")[0]} will see you ${info.appointmentDisplay ?? "tomorrow"}` +
      `${info.startTime ? " at " + info.startTime : ""}. 💙`
    );
    return;
  }

  if (verdict === "CANCEL") {
    // Mark the request and clear state. We don't auto-refund here — finance ops
    // handles that downstream from the client_cancel_requests collection.
    const requestRef = await db.collection("client_cancel_requests").add({
      clientPhone:    phone,
      appointmentId:  info.appointmentId,
      caregiverId:    info.caregiverId,
      caregiverName:  info.caregiverName,
      seniorName:     info.seniorName,
      appointmentDate: info.appointmentDate,
      startTime:      info.startTime,
      requestedAt:    new Date().toISOString(),
      status:         "pending_review",
      source:         "day_before_reminder",
    });

    await db.collection("appointments").doc(info.appointmentId).update({
      status:                 "client_cancel_requested",
      clientCancelRequestedAt: new Date().toISOString(),
      clientCancelRequestId:   requestRef.id,
    }).catch(() => {});

    // Notify the caregiver via Cara so they know not to show up
    const cgSnap = await db.collection("caregivers").doc(info.caregiverId).get();
    const cgPhone = cgSnap.data()?.phone as string | undefined;
    if (cgPhone) {
      await sendViaInteractionAgent(cgPhone, {
        content:
          `Heads up — ${info.seniorName}'s family just cancelled tomorrow's visit ` +
          `${info.startTime ? "at " + info.startTime : ""}. You don't need to head over. ` +
          `I'll follow up if there's a reschedule.`,
        urgency:     "immediate",
        sourceAgent: "client_cancel_notify",
        canDrop:     false,
      }).catch(() => {/* non-critical — ops will follow up */});
    }

    // Alert ops so a human can handle refund + replacement
    await db.collection("admin_alerts").add({
      type:        "client_cancel_request",
      phone,
      appointmentId:  info.appointmentId,
      caregiverName:  info.caregiverName,
      seniorName:     info.seniorName,
      appointmentDate: info.appointmentDate,
      severity:    "medium",
      resolved:    false,
      createdAt:   new Date().toISOString(),
    }).catch(() => {});

    await db.collection("agent_sessions").doc(phone).update({
      pendingClientShiftConfirm: admin.firestore.FieldValue.delete(),
      stateExpiresAt:            admin.firestore.FieldValue.delete(),
    });

    await sendMessage(chatId,
      `Okay — I've cancelled ${info.appointmentDisplay ?? "tomorrow"}'s visit and let ${info.caregiverName.split(" ")[0]} know. ` +
      `Want me to find a replacement caregiver for another day, or are you all set?`
    );
    return;
  }

  // QUESTION — answer it, then re-prompt
  let answer = "";
  try {
    answer = await quickComplete(
      "You are Cara, an AI care assistant. A family member was just sent a day-before reminder for " +
      `${info.seniorName}'s visit tomorrow${info.startTime ? " at " + info.startTime : ""} with ` +
      `${info.caregiverName}. Instead of CONFIRM or CANCEL, they asked a question. Answer briefly ` +
      "(1–2 sentences). Do NOT ask them to confirm or cancel — that prompt comes next.",
      text,
      { maxTokens: 180 },
    );
  } catch {
    answer = "Let me check on that. In the meantime —";
  }
  await sendMessage(chatId, answer);
  await sendMessage(chatId,
    `So — ${info.caregiverName.split(" ")[0]} is still set for ${info.appointmentDisplay ?? "tomorrow"}` +
    `${info.startTime ? " at " + info.startTime : ""}. ` +
    `You don't need to do anything; reply CANCEL only if something's changed.`
  );
}
