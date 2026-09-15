import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendToPhone } from "../linq/client";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { scheduleTrigger } from "./triggerEngine";
import { parseScheduledTimeMs, formatDateForDisplay, formatHHMMForDisplay } from "../utils/scheduledTime";

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
  if (snap.exists) {
    await roomRef.update({ deletedAt: admin.firestore.FieldValue.delete() });
    return;
  }
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

async function getCaregiverPhone(caregiverId: string): Promise<string | null> {
  const snap = await db.collection("caregivers").doc(caregiverId).get();
  return (snap.data() as any)?.phone ?? null;
}

// ── Main trigger ──────────────────────────────────────────────────────────────

export const onAppointmentUpdated = functions.firestore
  .document("appointments/{appointmentId}")
  .onUpdate(async (change, context) => {
    try {
      const before = change.before.data();
      const after  = change.after.data();

      if (!after.clientId) return;

      const statusChanged = before.status !== after.status;
      if (!statusChanged) return;

      // U3: in-app booking-confirmed notification runs BEFORE the phone guard —
      // it needs only clientId, and a phone-less web client must still get it.
      // Keyed by the recurring group so N per-appointment firings dedupe to one
      // notification (create-if-absent; eventId '' makes the id group-stable).
      // Replaces the removed confirmRecurringGroup browser peer-write.
      if (after.status === "confirmed" && before.status !== "confirmed") {
        try {
          const { writeUserNotification } = await import("../notifications/userNotification");
          const groupKey = after.recurringGroupId || after.recurringScheduleId;
          await writeUserNotification({
            sourcePath: groupKey ? `recurring_groups/${groupKey}` : `appointments/${change.after.id}`,
            // Groups: '' makes the id group-stable so N per-appointment firings
            // dedupe to one notification. Singles: the trigger eventId bounds
            // dedup to this confirmation episode (a later re-confirm notifies).
            eventId: groupKey ? "" : context.eventId,
            recipientId: after.clientId,
            transitionType: "booking_confirmed",
            type: "booking",
            title: "Booking Confirmed!",
            body: `${after.caregiverName || "Your caregiver"} accepted your booking request.`,
            data: groupKey ? { recurringGroupId: groupKey } : { appointmentId: change.after.id },
          });
        } catch (err) {
          console.error("[appointmentUpdated] client confirm notification failed:", (err as Error)?.name ?? "Error");
        }
      }

      const phone = await getClientPhone(after.clientId);
      if (!phone) return;

      // ── Arrival / in-progress ────────────────────────────────────────────
      if (after.status === "in-progress" && before.status !== "in-progress") {
        const msg = `${after.caregiverName ?? "Your caregiver"} has arrived for your ${formatHHMMForDisplay(after.time)} visit.`;
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
      // (The client's in-app confirm notification is written above the phone
      // guard so phone-less clients still receive it.)
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
            `${formatDateForDisplay(after.date)} at ${formatHHMMForDisplay(after.time)}\n` +
            (after.clientName  ? `${after.clientName}\n`  : "") +
            (after.address     ? `${after.address}`       : "");
          await sendToPhone(caregiverPhone, msg);
        }

        if (phone && after.date && after.time) {
          try {
            // Pacific wall-clock parse (naive Date read PT as UTC → the
            // "1h-before" reminder and "2h-before" check-in fired ~8h early).
            const visitMs  = parseScheduledTimeMs(`${after.date}T${after.time.slice(0, 5)}:00`);
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
                  `Just a heads up — ${cgName} is confirmed for your ${formatHHMMForDisplay(after.time)} visit today. ` +
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
      throw err;
    }
  });

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
