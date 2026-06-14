import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendToPhone, AgentSession } from "../linq/client";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { scoreReplacements } from "../agents/replacementScorer";
import { scheduleTrigger } from "./triggerEngine";

function hoursUntil(date: string, time: string): number {
  const apptMs = new Date(`${date}T${time.slice(0, 5)}:00`).getTime();
  return (apptMs - Date.now()) / (1000 * 60 * 60);
}

const db = admin.firestore();

// ── Chat room auto-creation ───────────────────────────────────────────────────

async function ensureChatRoom(
  clientId: string,
  clientName: string,
  caregiverId: string,
  caregiverName: string
): Promise<void> {
  if (!clientId || !caregiverId) return;
  const sorted = [clientId, caregiverId].sort();
  const roomId = sorted.join('_');
  const roomRef = db.collection('chatRooms').doc(roomId);
  const snap = await roomRef.get();
  if (snap.exists) return;
  const names = sorted.map(id => id === clientId ? clientName : caregiverName);
  await roomRef.set({
    participants: sorted,
    participantNames: names,
    participantAvatars: ['', ''],
    lastMessage: '',
    lastMessageTime: '',
    lastMessageTimestamp: null,
    unreadCount: { [clientId]: 0, [caregiverId]: 0 },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

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
        const msg = `${after.caregiverName ?? "Your caregiver"} has arrived for your ${after.time} visit.`;
        await sendViaInteractionAgent(phone, {
          content: msg, urgency: "immediate", sourceAgent: "arrival_notification", canDrop: false,
        }).catch(() => sendToPhone(phone, msg));

        await db.collection("agent_alerts_log").add({
          type: "caregiver_arrived", clientId: after.clientId, phone,
          appointmentId: change.after.id, sentAt: new Date().toISOString(),
        });
        return;
      }

      // ── Booking confirmed → ensure chat room exists + notify caregiver ──────
      if (after.status === "confirmed" && before.status !== "confirmed" && after.caregiverId) {
        await ensureChatRoom(
          after.clientId,
          after.clientName ?? 'Client',
          after.caregiverId,
          after.caregiverName ?? 'Caregiver'
        ).catch(err => console.error('[appointmentUpdated] ensureChatRoom failed:', err));

        const caregiverPhone = await getCaregiverPhone(after.caregiverId);
        if (caregiverPhone) {
          const msg =
            `Booking confirmed.\n` +
            `${after.date} at ${after.time}\n` +
            (after.clientName  ? `${after.clientName}\n`  : "") +
            (after.address     ? `${after.address}`       : "");
          await sendToPhone(caregiverPhone, msg);
        }

        if (phone && after.date && after.time) {
          try {
            const visitMs  = new Date(`${after.date}T${after.time.slice(0, 5)}:00`).getTime();
            const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
            const clientId    = sessionSnap.data()?.userId ?? after.clientId ?? "";
            const cgName      = after.caregiverName ?? "Your caregiver";

            // Schedule 1h-before family reminder
            const remindMs = visitMs - 60 * 60 * 1000;
            if (remindMs > Date.now()) {
              await scheduleTrigger({
                userId:      clientId,
                phone,
                type:        "appointment_reminder",
                scheduledAt: new Date(remindMs).toISOString(),
                message:
                  `Just a heads up — ${cgName} is confirmed for your ${after.time} visit today. ` +
                  `Reply CANCEL if plans change and I'll handle it.`,
              });
            }

            // Schedule 2h-before caregiver check-in
            if (caregiverPhone && after.caregiverId) {
              const checkInMs = visitMs - 2 * 60 * 60 * 1000;
              if (checkInMs > Date.now()) {
                const cgSessionSnap = await db.collection("agent_sessions").doc(caregiverPhone).get();
                const cgUserId      = cgSessionSnap.data()?.userId ?? after.caregiverId ?? "";
                await scheduleTrigger({
                  userId:      cgUserId,
                  phone:       caregiverPhone,
                  type:        "custom",
                  scheduledAt: new Date(checkInMs).toISOString(),
                  message:     `caregiver_checkin:${change.after.id}`,
                });
              }
            }
          } catch (err) {
            console.error("[appointmentUpdated] trigger scheduling failed:", err);
          }
        }
        return;
      }

      // ── Visit completed ──────────────────────────────────────────────────
      if (after.status === "completed" && before.status !== "completed") {
        const msg =
          `${after.caregiverName ?? "Your caregiver"}'s visit is complete. ` +
          `A care journal entry will be posted shortly.`;
        await sendViaInteractionAgent(phone, {
          content: msg, urgency: "standard", sourceAgent: "visit_summary", canDrop: true,
        }).catch(() => sendToPhone(phone, msg));

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
  await getSession(phone);

  const hours = hoursUntil(appt.date ?? "", appt.time ?? "00:00");

  // Future cancellation (> 24h out) — give family the choice
  if (hours > 24) {
    const taskRef = await db.collection("agent_tasks").add({
      type:          "replacement_or_skip",
      appointmentId,
      clientId:      appt.clientId,
      clientPhone:   phone,
      status:        "awaiting_replace_or_skip",
      expiresAt:     new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      createdAt:     new Date().toISOString(),
    });

    const daysOut = Math.round(hours / 24);
    const futureMsg =
      `${appt.caregiverName ?? "Your caregiver"} cancelled the ${appt.time} visit on ${appt.date} ` +
      `(${daysOut} day${daysOut !== 1 ? "s" : ""} away).\n\n` +
      `Reply REPLACE and I'll find a replacement, or SKIP to cancel the visit.`;

    await sendViaInteractionAgent(phone, {
      content: futureMsg, urgency: "standard", sourceAgent: "emergency_replacement", canDrop: false,
    }).catch(() => sendToPhone(phone, futureMsg));

    await db.collection("agent_alerts_log").add({
      type: "caregiver_cancelled_future", clientId: appt.clientId, phone,
      appointmentId, taskId: taskRef.id, sentAt: new Date().toISOString(),
    });
    return;
  }

  // Same-day / imminent (≤ 24h) — immediate replacement search
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
    await sendViaInteractionAgent(phone, {
      content: noMatchMsg, urgency: "immediate", sourceAgent: "emergency_replacement", canDrop: false,
    }).catch(() => sendToPhone(phone, noMatchMsg));
    return;
  }

  // Generate a confirmation token for the QuickConfirm page
  const confirmToken = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min
  const taskRef = await db.collection("agent_tasks").add({
    type:          "replacement",
    appointmentId,
    clientId:      appt.clientId,
    clientPhone:   phone,
    options,
    confirmToken,
    status:        "awaiting_approval",
    expiresAt,
    createdAt:     new Date().toISOString(),
  });

  // Schedule auto-book fallback at the 30-min expiry mark
  await scheduleTrigger({
    userId:      appt.clientId,
    phone,
    type:        "custom",
    scheduledAt: expiresAt,
    message:     `replacement_task:${taskRef.id}`,
  }).catch(err => console.error("[handleCaregiverCancellation] scheduleTrigger failed:", err));

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

  await sendViaInteractionAgent(phone, {
    content: cancelMsg, urgency: "immediate", sourceAgent: "emergency_replacement", canDrop: false,
  }).catch(() => sendToPhone(phone, cancelMsg));

  await db.collection("agent_alerts_log").add({
    type: "caregiver_cancelled", clientId: appt.clientId, phone,
    appointmentId, taskId: taskRef.id, sentAt: new Date().toISOString(),
  });
}

// ── onCreate: create chat room when a booking request is sent (interview tab) ─

export const onBookingRequestCreated = functions.firestore
  .document("booking_requests/{bookingId}")
  .onCreate(async (snap) => {
    const data = snap.data();
    if (!data?.clientId || !data?.caregiverId) return;
    await ensureChatRoom(
      data.clientId,
      data.clientName ?? 'Client',
      data.caregiverId,
      data.caregiverName ?? 'Caregiver'
    ).catch(err => console.error('[onBookingRequestCreated] ensureChatRoom failed:', err));
  });
