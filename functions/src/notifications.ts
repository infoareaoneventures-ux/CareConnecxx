
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { Resend } from "resend";
import { sendSMSToUser, SMS_TEMPLATES } from "./sms";
import { businessTodayStr, businessTomorrowStr, parseScheduledTimeMs } from "./utils/scheduledTime";
import {
    claimExternalSideEffectOperation,
    completeExternalSideEffectOperation,
    externalOperationDocId,
    failExternalSideEffectOperation,
} from "./operations/externalSideEffect";

// Initialize Firebase Admin if not already done
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();

async function ensureChatRoom(
  clientId: string, clientName: string, caregiverId: string, caregiverName: string
): Promise<void> {
  if (!clientId || !caregiverId) return;
  const sorted = [clientId, caregiverId].sort();
  const roomId = sorted.join('_');
  const roomRef = db.collection('chatRooms').doc(roomId);
  const snap = await roomRef.get();
  if (snap.exists) {
    // Reset deletedAt so both parties see a fresh conversation on new booking
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

/**
 * Helper function to create a notification in Firestore
 */
async function createNotification(userId: string, notification: {
    title: string;
    body: string;
    type: 'booking' | 'message' | 'system' | 'alert';
}, notificationId?: string) {
    try {
        const collection = db.collection('users').doc(userId).collection('notifications');
        const ref = notificationId ? collection.doc(externalOperationDocId(notificationId)) : collection.doc();
        await ref.set({
            ...notification,
            isRead: false,
            createdAt: new Date().toISOString()
        }, { merge: true });
        if (process.env.NODE_ENV !== 'production') {
            console.log(`Notification created for user ${userId}: ${notification.title}`);
        }
    } catch (error) {
        if (process.env.NODE_ENV !== 'production') {
            console.error(`Failed to create notification for user ${userId}:`, error);
        }
    }
}

async function notifyRecurringAppointmentSummary(appointment: Record<string, any>): Promise<void> {
    const groupId = String(appointment.recurringGroupId ?? appointment.recurringNotificationTaskId ?? "");
    if (!groupId) return;
    const groupField = appointment.recurringGroupId ? "recurringGroupId" : "recurringNotificationTaskId";
    const groupSnap = await db.collection("appointments").where(groupField, "==", groupId).get();
    const visits = groupSnap.docs.map(doc => doc.data()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (visits.length === 0) return;
    const first = visits[0];
    const pending = visits.some(visit => visit.status === "pending_caregiver_confirmation");
    const summary = `${visits.length} visit${visits.length === 1 ? "" : "s"} starting ${first.date} at ${first.time ?? first.startTime}`;
    const parties = [
        appointment.caregiverId ? {
            party: "caregiver",
            userId: String(appointment.caregiverId),
            title: pending ? "New Recurring Booking Request" : "Recurring Care Scheduled",
            body: pending
                ? `${appointment.clientName ?? "A client"} requested ${summary}.`
                : `You are scheduled for ${summary} with ${appointment.clientName ?? "a client"}.`,
        } : null,
        appointment.clientId ? {
            party: "client",
            userId: String(appointment.clientId),
            title: pending ? "Recurring Booking Request Sent" : "Recurring Care Scheduled",
            body: pending
                ? `Your request for ${summary} with ${appointment.caregiverName ?? "your caregiver"} was sent for approval.`
                : `${appointment.caregiverName ?? "Your caregiver"} is confirmed for ${summary}.`,
        } : null,
    ].filter(Boolean) as Array<{ party: string; userId: string; title: string; body: string }>;

    for (const party of parties) {
        const operationKey = `recurring-summary:${groupId}:${party.party}`;
        const claim = await claimExternalSideEffectOperation({
            operationKey,
            operationType: "recurring_summary",
            targetId: groupId,
        });
        if (!claim) continue;
        try {
            await createNotification(party.userId, {
                title: party.title,
                body: party.body,
                type: "booking",
            }, operationKey);
            await sendSMSToUser(party.userId, party.body);
            await completeExternalSideEffectOperation(operationKey, claim.leaseOwner);
        } catch (error) {
            await failExternalSideEffectOperation(operationKey, claim.leaseOwner, error);
            throw error;
        }
    }
}

/**
 * Trigger when a new appointment is created
 * Notifies both the client and caregiver via in-app + SMS
 */
export const onAppointmentCreated = functions.firestore
    .document('appointments/{appointmentId}')
    .onCreate(async (snap, context) => {
        const appointment = snap.data();

        // Childcare U9 (plan 2026-07-22-002, R41/R43/KTD14): childcare
        // appointments NEVER enter this senior path. ensureChatRoom below
        // creates a PAIRWISE room keyed on the participant pair alone — the
        // exact pattern R41 replaces for childcare (context-keyed server
        // rooms via childcare/conversationPolicy). Childcare booking
        // notifications are the generic child-safe registry rows written by
        // childcare/bookingCallables at each transition. Senior path
        // byte-identical.
        if (appointment.careVertical === 'child') return;

        try {
            // Ensure chat room exists between client and caregiver
            if (appointment.clientId && appointment.caregiverId) {
                await ensureChatRoom(
                    appointment.clientId,
                    appointment.clientName ?? 'Client',
                    appointment.caregiverId,
                    appointment.caregiverName ?? 'Caregiver'
                ).catch(err => console.error('[onAppointmentCreated] ensureChatRoom failed:', err));
            }

            // The agent booking executor owns pending shift offers and family
            // confirmation. Generic create notices would send one request per
            // appointment and tell the family it was confirmed too early.
            if (appointment.createdByAgent && appointment.status === 'pending_caregiver_confirmation') return;

            if (appointment.recurringGroupId || appointment.recurringNotificationTaskId) {
                await notifyRecurringAppointmentSummary(appointment);
                return;
            }

            // Notify caregiver
            if (appointment.caregiverId) {
                const caregiverId = appointment.caregiverId.toString();
                
                // In-app notification
                await createNotification(caregiverId, {
                    title: '🎉 New Booking Request',
                    body: `${appointment.clientName || 'A client'} booked you for ${appointment.date} at ${appointment.time}`,
                    type: 'booking'
                });

                // SMS notification
                await sendSMSToUser(
                    caregiverId,
                    SMS_TEMPLATES.newBookingRequest(
                        appointment.clientName || 'A client',
                        appointment.date,
                        appointment.time
                    )
                );
            }

            // Notify client
            if (appointment.clientId) {
                // In-app notification
                await createNotification(appointment.clientId, {
                    title: '✅ Booking Confirmed',
                    body: `Your appointment with ${appointment.caregiverName} is confirmed for ${appointment.date}`,
                    type: 'booking'
                });

                // SMS notification
                await sendSMSToUser(
                    appointment.clientId,
                    SMS_TEMPLATES.bookingConfirmed(
                        appointment.caregiverName || 'your caregiver',
                        appointment.date,
                        appointment.time
                    )
                );
            }
        } catch (error) {
            if (process.env.NODE_ENV !== 'production') {
                console.error('Error in onAppointmentCreated:', error);
            }
        }
    });

/**
 * Trigger when a new message is sent in a thread
 * Notifies the recipient (not the sender) via in-app + SMS
 */
export const onMessageSent = functions.firestore
    .document('threads/{threadId}/messages/{messageId}')
    .onCreate(async (snap, context) => {
        const message = snap.data();
        const threadId = context.params.threadId;

        try {
            // Evia threads are mirrors of an SMS/iMessage conversation the user
            // already received on their phone — texting "New message from Evia.
            // Open the app to reply." on top of Evia's own reply double-messages
            // them, and the web-inbox unread badge is already maintained by the
            // mirror (threadMirror.ts). Skip these threads entirely.
            if (message.senderId === 'cara' || threadId.startsWith('cara_')) {
                return;
            }

            // Get thread to find participants
            const threadDoc = await db.collection('threads').doc(threadId).get();
            const thread = threadDoc.data();

            if (thread && thread.isCaraThread) {
                return;
            }

            if (thread && thread.participants && Array.isArray(thread.participants)) {
                // Find the recipient (not the sender)
                const recipient = thread.participants.find((p: string) => p !== message.senderId);

                if (recipient) {
                    // Get sender name from thread data
                    const senderName = thread.contactName || 'Someone';

                    // In-app notification
                    await createNotification(recipient, {
                        title: `💬 New Message from ${senderName}`,
                        body: message.text.substring(0, 100) + (message.text.length > 100 ? '...' : ''),
                        type: 'message'
                    });

                    // SMS notification (only for first message in a burst - check last message time)
                    const lastSMSKey = `lastMessageSMS_${threadId}_${recipient}`;
                    const lastSMSDoc = await db.collection('smsThrottles').doc(lastSMSKey).get();
                    const lastSMSTime = lastSMSDoc.exists ? lastSMSDoc.data()?.timestamp?.toMillis() : 0;
                    const now = Date.now();
                    
                    // Only send SMS if last one was more than 5 minutes ago (avoid spam)
                    if (now - lastSMSTime > 5 * 60 * 1000) {
                        await sendSMSToUser(recipient, SMS_TEMPLATES.newMessage(senderName));
                        await db.collection('smsThrottles').doc(lastSMSKey).set({ timestamp: admin.firestore.FieldValue.serverTimestamp() });
                    }
                }
            }
        } catch (error) {
            if (process.env.NODE_ENV !== 'production') {
                console.error('Error in onMessageSent:', error);
            }
        }
    });

// U4 (2026-07-20): the obsolete onInterviewScheduled trigger on the camelCase
// `videoInterviews` collection was removed. The canonical collection is
// `video_interviews` (snake_case), owned by onVideoInterviewWrite in
// functions/src/triggers/notificationTriggers.ts, which notifies on new
// request / accept / decline / cancel. No writer targets `videoInterviews`
// (zero production documents), so this trigger could never fire.

/**
 * Trigger when appointment status changes to 'cancelled'
 * Notifies the other party via in-app + SMS
 */
export const onAppointmentCancelled = functions.firestore
    .document('appointments/{appointmentId}')
    .onUpdate(async (change: functions.Change<functions.firestore.DocumentSnapshot>, context: functions.EventContext) => {
        const before = change.before.data();
        const after = change.after.data();

        // Childcare U9 (R43): childcare cancellations notify through the
        // generic child-safe registry rows written by the childcare cancel
        // callable — this senior trigger (clientName/date copy) never fires
        // for a childcare doc. Senior path byte-identical.
        if (after?.careVertical === 'child' || before?.careVertical === 'child') return;

        // Check if status changed to cancelled
        if (before && after && before.status !== 'cancelled' && after.status === 'cancelled') {
            // U3 fix: caregiver cancellations previously produced NO in-app client
            // notification anywhere — appointmentUpdated (the SMS owner below) only
            // sends the REPLACE/SKIP text, and this trigger early-returned. Write
            // the in-app note here, keyed by recurringGroupId when present so a
            // batch decline of an N-appointment group collapses to ONE notification
            // (deterministic id + create-if-absent). Wording distinguishes a
            // declined request (never accepted) from a cancelled confirmed booking.
            if (after.cancelledBy === 'caregiver' && after.clientId) {
                try {
                    const { writeUserNotification } = await import('./notifications/userNotification');
                    const groupKey = after.recurringGroupId || after.recurringScheduleId;
                    const declinedRequest = before.status === 'pending_caregiver_confirmation';
                    await writeUserNotification({
                        sourcePath: groupKey ? `recurring_groups/${groupKey}` : `appointments/${context.params.appointmentId}`,
                        eventId: groupKey ? '' : context.eventId, // group-stable id dedupes the batch
                        recipientId: after.clientId,
                        transitionType: declinedRequest ? 'booking_declined' : 'shift_cancelled_by_caregiver',
                        type: 'alert',
                        title: declinedRequest ? 'Booking Declined' : 'Appointment Cancelled',
                        body: declinedRequest
                            ? `${after.caregiverName || 'The caregiver'} is unable to accept your booking request. You can search for another caregiver.`
                            : `${after.caregiverName || 'Your caregiver'} cancelled the appointment on ${after.date}.`,
                        data: groupKey ? { recurringGroupId: groupKey } : { appointmentId: context.params.appointmentId },
                    });
                } catch (err) {
                    console.error('[onAppointmentCancelled] caregiver-cancel client notification failed:', (err as Error)?.name ?? 'Error');
                }
            }
            // appointmentUpdated owns the caregiver-cancellation SMS/replacement
            // flow. This sibling handles the remaining client/admin notifications.
            if (after.cancelledBy === 'caregiver') return;
            try {
                const cancelledBy = after.cancelledBy;
                const reason = after.cancellationReason || 'No reason provided';

                // Notify the other party
                if (cancelledBy === 'client' && after.caregiverId) {
                    const caregiverId = after.caregiverId.toString();
                    
                    await createNotification(caregiverId, {
                        title: '❌ Appointment Cancelled',
                        body: `${after.clientName} cancelled the appointment on ${after.date}. Reason: ${reason}`,
                        type: 'alert'
                    });

                    await sendSMSToUser(
                        caregiverId,
                        SMS_TEMPLATES.bookingCancelled(after.clientName, after.date, reason)
                    );
                }
                // (No caregiver branch here — the early-return above routes
                // caregiver cancellations to the in-app note + appointmentUpdated's
                // SMS/replacement flow. The old branch was unreachable dead code.)
            } catch (error) {
                console.error('Error in onAppointmentCancelled:', error);
            }
        }
    });

/**
 * Scheduled function: Send shift reminders 1 hour before
 * Runs every 15 minutes to check for upcoming shifts
 */
export const sendShiftReminders = functions.pubsub
    .schedule('every 15 minutes')
    .onRun(async (context) => {
        const now = new Date();
        const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
        const fifteenMinutesFromNow = new Date(now.getTime() + 15 * 60 * 1000);

        try {
            // Query appointments starting in the next hour that haven't been reminded
            const appointmentsSnapshot = await db.collection('appointments')
                .where('status', '==', 'confirmed')
                .where('date', '>=', businessTodayStr())
                .where('date', '<=', businessTomorrowStr())
                .get();

            for (const doc of appointmentsSnapshot.docs) {
                const appointment = doc.data();
                // Childcare U9 (R43/R54): childcare appointments are skipped —
                // this reminder interpolates clientName into SMS copy, and
                // childcare proactive messaging is flag-gated and deferred
                // (approved child-safe templates are U10/U1 work).
                if (appointment.careVertical === 'child') continue;
                if (appointment.reminderSent === true) continue;

                // Parse appointment datetime as PACIFIC wall-clock. The old
                // `new Date("YYYY-MM-DD HH:mm")` read PT times as server-local
                // UTC, matching the reminder window ~8h before the real start
                // (and stamping reminderSent so nothing fired at the right
                // time). Handles both "14:00" and "2:00 PM" shapes.
                const tm = String(appointment.time ?? "").trim().toUpperCase()
                    .match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
                if (!tm || !appointment.date) continue;
                let apptHour = parseInt(tm[1], 10);
                if (tm[3] === 'PM' && apptHour < 12) apptHour += 12;
                if (tm[3] === 'AM' && apptHour === 12) apptHour = 0;
                const appointmentDateTime = new Date(parseScheduledTimeMs(
                    `${appointment.date}T${String(apptHour).padStart(2, '0')}:${tm[2]}:00`
                ));

                // Check if appointment is between 15 min and 1 hour from now
                if (appointmentDateTime >= fifteenMinutesFromNow && appointmentDateTime <= oneHourFromNow) {
                    const operationKey = `appointment-reminder:${doc.id}:one-hour`;
                    const claim = await claimExternalSideEffectOperation({
                        operationKey,
                        operationType: 'appointment_reminder',
                        targetId: doc.id,
                    });
                    if (!claim) continue;
                    try {
                    // Send reminder to caregiver
                    if (appointment.caregiverId) {
                        await sendSMSToUser(
                            appointment.caregiverId.toString(),
                            SMS_TEMPLATES.shiftReminder(appointment.clientName, appointment.time)
                        );
                    }

                    // Mark as reminded
                    await doc.ref.update({ reminderSent: true });
                    await completeExternalSideEffectOperation(operationKey, claim.leaseOwner);
                    console.log(`Shift reminder sent for appointment ${doc.id}`);
                    } catch (error) {
                        await failExternalSideEffectOperation(operationKey, claim.leaseOwner, error);
                        throw error;
                    }
                }
            }
        } catch (error) {
            console.error('Error in sendShiftReminders:', error);
        }
    });

// ── Admin notification helpers ────────────────────────────────────────────────
// Each writes to admin_alerts and optionally emails/texts the support line.

const ADMIN_EMAIL   = process.env.ADMIN_EMAIL         || "support@eviacares.com";
const SUPPORT_PHONE = process.env.VITE_SUPPORT_PHONE  || process.env.SUPPORT_PHONE || "";
const RESEND_FROM   = process.env.RESEND_FROM_EMAIL   || "support@eviacares.com";

function getResend(): Resend | null {
    const key = process.env.RESEND_API_KEY;
    return key ? new Resend(key) : null;
}

async function sendAdminEmail(subject: string, html: string): Promise<void> {
    try {
        const resend = getResend();
        if (!resend) return;
        await resend.emails.send({ from: RESEND_FROM, to: ADMIN_EMAIL, subject, html });
    } catch (err) {
        console.error("sendAdminEmail error:", err);
    }
}

async function textAdmin(body: string): Promise<void> {
    if (!SUPPORT_PHONE) return;
    try {
        await sendSMSToUser(SUPPORT_PHONE, body);
    } catch (err) {
        console.error("textAdmin error:", err);
    }
}

export async function notifyAdminNewCaregiverSignup(params: {
    caregiverId: string;
    name:        string;
    phone:       string;
    city:        string;
}): Promise<void> {
    await db.collection("admin_alerts").add({
        type:        "new_caregiver_signup",
        ...params,
        createdAt:   new Date().toISOString(),
        resolved:    false,
        severity:    "low",
    });
    await sendAdminEmail(
        `New caregiver signup: ${params.name}`,
        `<p>A new caregiver just signed up via Evia iMessage.</p>` +
        `<p><strong>Name:</strong> ${params.name}<br>` +
        `<strong>Phone:</strong> ${params.phone}<br>` +
        `<strong>City:</strong> ${params.city}</p>`
    );
}

export async function notifyAdminNewClientSignup(params: {
    clientId:   string;
    firstName:  string;
    seniorName: string;
    phone:      string;
    city:       string;
}): Promise<void> {
    await db.collection("admin_alerts").add({
        type:      "new_client_signup",
        ...params,
        createdAt: new Date().toISOString(),
        resolved:  false,
        severity:  "low",
    });
    await sendAdminEmail(
        `New client signup: ${params.firstName}`,
        `<p>A new family just joined via Evia iMessage.</p>` +
        `<p><strong>Name:</strong> ${params.firstName}<br>` +
        `<strong>Senior:</strong> ${params.seniorName}<br>` +
        `<strong>Phone:</strong> ${params.phone}<br>` +
        `<strong>City:</strong> ${params.city}</p>`
    );
}

export async function notifyAdminInterviewScheduled(params: {
    interviewId:   string;
    caregiverName: string;
    clientPhone:   string;
    scheduledTime: string;
}): Promise<void> {
    await db.collection("admin_alerts").add({
        type:      "interview_scheduled",
        ...params,
        createdAt: new Date().toISOString(),
        resolved:  false,
        severity:  "low",
    });
    await sendAdminEmail(
        `Interview scheduled: ${params.caregiverName}`,
        `<p>An interview was scheduled via Evia.</p>` +
        `<p><strong>Caregiver:</strong> ${params.caregiverName}<br>` +
        `<strong>Time:</strong> ${params.scheduledTime}</p>`
    );
}

export async function notifyAdminBookingConfirmed(params: {
    taskId:        string;
    caregiverName: string;
    clientPhone:   string;
    appointmentCount: number;
    totalCost:     number;
}): Promise<void> {
    await db.collection("admin_alerts").add({
        type:      "booking_confirmed",
        ...params,
        createdAt: new Date().toISOString(),
        resolved:  false,
        severity:  "low",
    });
    await sendAdminEmail(
        `Booking confirmed: ${params.appointmentCount} appts with ${params.caregiverName}`,
        `<p>A booking was confirmed via Evia.</p>` +
        `<p><strong>Caregiver:</strong> ${params.caregiverName}<br>` +
        `<strong>Appointments:</strong> ${params.appointmentCount}<br>` +
        `<strong>Total:</strong> $${params.totalCost.toFixed(2)}</p>`
    );
}

export async function notifyAdminHealthFlag(params: {
    clientId:    string;
    seniorName:  string;
    signal:      string;
    journalId:   string;
}): Promise<void> {
    await db.collection("admin_alerts").add({
        type:      "health_flag",
        ...params,
        createdAt: new Date().toISOString(),
        resolved:  false,
        severity:  "high",
    });
    await sendAdminEmail(
        `Health alert: ${params.seniorName}`,
        `<p><strong>Alert:</strong> ${params.signal}</p>` +
        `<p>Senior: ${params.seniorName} (clientId: ${params.clientId})</p>`
    );
    await textAdmin(`[Evia] Health alert for ${params.seniorName}: ${params.signal}`);
}

export async function notifyAdminCaregiverIssue(params: {
    caregiverId:   string;
    caregiverName: string;
    appointmentId: string;
    description:   string;
}): Promise<void> {
    await db.collection("admin_alerts").add({
        type:      "caregiver_issue",
        ...params,
        createdAt: new Date().toISOString(),
        resolved:  false,
        severity:  "high",
    });
    await sendAdminEmail(
        `Caregiver issue reported: ${params.caregiverName}`,
        `<p><strong>Description:</strong> ${params.description}</p>` +
        `<p>Caregiver: ${params.caregiverName} (${params.caregiverId})<br>` +
        `Appointment: ${params.appointmentId}</p>`
    );
    await textAdmin(`[Evia] Issue from caregiver ${params.caregiverName}: ${params.description}`);
}
