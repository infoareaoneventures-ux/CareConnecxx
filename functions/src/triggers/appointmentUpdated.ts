import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { sendMessage, sendToPhone, AgentSession } from "../linq/client";
import { scoreReplacements } from "../agents/replacementScorer";

const db = admin.firestore();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getClientPhone(clientId: string): Promise<string | null> {
  const snap = await db.collection("users").doc(clientId).get();
  return (snap.data() as any)?.phone ?? null;
}

async function getSession(phone: string): Promise<AgentSession | null> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  if (!snap.exists) return null;
  const s = snap.data() as AgentSession;
  return (s.optedOut || s.optedIn === false) ? null : s;
}

async function getCaregiverPhone(caregiverId: string): Promise<string | null> {
  const snap = await db.collection("caregivers").doc(caregiverId).get();
  return (snap.data() as any)?.phone ?? null;
}

// ── Main trigger ──────────────────────────────────────────────────────────────

export const onAppointmentUpdated = functions.firestore
  .document("appointments/{appointmentId}")
  .onUpdate(async (change) => {
    try {
      const before = change.before.data();
      const after  = change.after.data();

      if (!after.clientId) return;

      const statusChanged = before.status !== after.status;
      if (!statusChanged) return;

      const phone = await getClientPhone(after.clientId);
      if (!phone) return;

      // ── Caregiver cancellation → emergency replacement flow ───────────────
      if (
        after.status === "cancelled" &&
        after.cancelledBy === "caregiver"
      ) {
        await handleCaregiverCancellation(change.after.id, after, phone);
        return;
      }

      // ── Arrival / in-progress ────────────────────────────────────────────
      if (after.status === "in-progress" && before.status !== "in-progress") {
        const session = await getSession(phone);
        const msg = `${after.caregiverName ?? "Your caregiver"} has arrived for your ${after.time} visit. ✅`;
        if (session) {
          await sendMessage(session.chatId, msg);
        } else {
          await sendToPhone(phone, msg);
        }

        await db.collection("agent_alerts_log").add({
          type: "caregiver_arrived", clientId: after.clientId, phone,
          appointmentId: change.after.id, sentAt: new Date().toISOString(),
        });
        return;
      }

      // ── Booking confirmed → notify caregiver ────────────────────────────
      if (after.status === "confirmed" && before.status !== "confirmed" && after.caregiverId) {
        const caregiverPhone = await getCaregiverPhone(after.caregiverId);
        if (caregiverPhone) {
          const msg =
            `✅ Booking confirmed!\n` +
            `📅 ${after.date} at ${after.time}\n` +
            (after.clientName  ? `👤 ${after.clientName}\n`  : "") +
            (after.address     ? `📍 ${after.address}`       : "");
          await sendToPhone(caregiverPhone, msg);
        }
        return;
      }

      // ── Visit completed ──────────────────────────────────────────────────
      if (after.status === "completed" && before.status !== "completed") {
        const session = await getSession(phone);
        const msg =
          `${after.caregiverName ?? "Your caregiver"}'s visit is complete. ` +
          `A care journal entry will be posted shortly.`;
        if (session) {
          await sendMessage(session.chatId, msg);
        } else {
          await sendToPhone(phone, msg);
        }

        await db.collection("agent_alerts_log").add({
          type: "visit_completed", clientId: after.clientId, phone,
          appointmentId: change.after.id, sentAt: new Date().toISOString(),
        });
        return;
      }
    } catch (err) {
      console.error("onAppointmentUpdated error:", err);
    }
  });

// ── Emergency replacement flow ────────────────────────────────────────────────

async function handleCaregiverCancellation(
  appointmentId: string,
  appt: any,
  phone: string
): Promise<void> {
  const session = await getSession(phone);

  // Get top 3 replacement caregivers
  const options = await scoreReplacements({
    clientId:      appt.clientId,
    appointmentId,
    date:          appt.date,
    time:          appt.time,
    excludeId:     appt.caregiverId,
  });

  if (options.length === 0) {
    const noMatchMsg =
      `${appt.caregiverName ?? "Your caregiver"} had to cancel today's ${appt.time} visit. ` +
      `I wasn't able to find available replacements right now. ` +
      `Please open the app or contact support to reschedule.`;
    if (session) await sendMessage(session.chatId, noMatchMsg);
    else await sendToPhone(phone, noMatchMsg);
    return;
  }

  // Generate a confirmation token for the QuickConfirm page
  const confirmToken = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const taskRef = await db.collection("agent_tasks").add({
    type:          "replacement",
    appointmentId,
    clientId:      appt.clientId,
    clientPhone:   phone,
    options,
    confirmToken,
    status:        "awaiting_approval",
    expiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min
    createdAt:     new Date().toISOString(),
  });

  const numberEmojis = ["1️⃣", "2️⃣", "3️⃣"];
  const optionLines = options
    .slice(0, 3)
    .map((o: any, i: number) => {
      const rebookedNote = o.previouslyBooked ? " · booked before" : "";
      return `${numberEmojis[i]} ${o.name} · ${o.rating}⭐ · $${o.hourlyRate}/hr${rebookedNote}`;
    })
    .join("\n");

  const cancelMsg =
    `${appt.caregiverName ?? "Your caregiver"} had to cancel today's ${appt.time} visit.\n\n` +
    `I found ${options.length} available caregiver${options.length > 1 ? "s" : ""}:\n\n` +
    `${optionLines}\n\n` +
    `Reply 1, 2, or 3. Nothing is booked until you confirm.`;

  if (session) {
    await sendMessage(session.chatId, cancelMsg);
  } else {
    await sendToPhone(phone, cancelMsg);
  }

  await db.collection("agent_alerts_log").add({
    type: "caregiver_cancelled", clientId: appt.clientId, phone,
    appointmentId, taskId: taskRef.id, sentAt: new Date().toISOString(),
  });
}
