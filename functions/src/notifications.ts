
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { Resend } from "resend";
import { sendSMSToUser, SMS_TEMPLATES } from "./sms";
import { parseScheduledTimeMs } from "./utils/scheduledTime";

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
}) {
    try {
        await db.collection('users').doc(userId).collection('notifications').add({
            ...notification,
            isRead: false,
            createdAt: new Date().toISOString()
        });
        if (process.env.NODE_ENV !== 'production') {
            console.log(`Notification created for user ${userId}: ${notification.title}`);
        }
    } catch (error) {
        if (process.env.NODE_ENV !== 'production') {
            console.error(`Failed to create notification for user ${userId}:`, error);
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

/**
 * Trigger when a video interview is scheduled
 * Notifies both the client and caregiver via in-app + SMS
 */
export const onInterviewScheduled = functions.firestore
    .document('videoInterviews/{interviewId}')
    .onCreate(async (snap, context) => {
        const interview = snap.data();

        try {
            const scheduledDate = new Date(interview.scheduledTime).toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });

            // Notify client
            if (interview.clientId) {
                await createNotification(interview.clientId, {
                    title: '📹 Interview Scheduled',
                    body: `Interview with ${interview.caregiverName} on ${scheduledDate}`,
                    type: 'system'
                });

                await sendSMSToUser(
                    interview.clientId,
                    SMS_TEMPLATES.interviewScheduled(interview.caregiverName, scheduledDate)
                );
            }

            // Notify caregiver
            if (interview.caregiverId) {
                await createNotification(interview.caregiverId, {
                    title: '📹 Interview Request',
                    body: `${interview.clientName} wants to interview you on ${scheduledDate}`,
                    type: 'system'
                });

                await sendSMSToUser(
                    interview.caregiverId,
                    SMS_TEMPLATES.interviewScheduled(interview.clientName, scheduledDate)
                );
            }
        } catch (error) {
            console.error('Error in onInterviewScheduled:', error);
        }
    });

/**
 * Trigger when appointment status changes to 'cancelled'
 * Notifies the other party via in-app + SMS
 */
export const onAppointmentCancelled = functions.firestore
    .document('appointments/{appointmentId}')
    .onUpdate(async (change: functions.Change<functions.firestore.DocumentSnapshot>, context: functions.EventContext) => {
        const before = change.before.data();
        const after = change.after.data();

        // Check if status changed to cancelled
        if (before && after && before.status !== 'cancelled' && after.status === 'cancelled') {
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
                } else if (cancelledBy === 'caregiver' && after.clientId) {
                    await createNotification(after.clientId, {
                        title: '❌ Appointment Cancelled',
                        body: `${after.caregiverName} cancelled the appointment on ${after.date}. Reason: ${reason}`,
                        type: 'alert'
                    });

                    await sendSMSToUser(
                        after.clientId,
                        SMS_TEMPLATES.bookingCancelled(after.caregiverName, after.date, reason)
                    );
                }
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
                .where('reminderSent', '!=', true)
                .get();

            for (const doc of appointmentsSnapshot.docs) {
                const appointment = doc.data();

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
                    // Send reminder to caregiver
                    if (appointment.caregiverId) {
                        await sendSMSToUser(
                            appointment.caregiverId.toString(),
                            SMS_TEMPLATES.shiftReminder(appointment.clientName, appointment.time)
                        );
                    }

                    // Mark as reminded
                    await doc.ref.update({ reminderSent: true });
                    console.log(`Shift reminder sent for appointment ${doc.id}`);
                }
            }
        } catch (error) {
            console.error('Error in sendShiftReminders:', error);
        }
    });

// ── Admin notification helpers ────────────────────────────────────────────────
// Each writes to admin_alerts and optionally emails/texts the support line.

const ADMIN_EMAIL   = process.env.ADMIN_EMAIL         || "admin@eviacares.com";
const SUPPORT_PHONE = process.env.VITE_SUPPORT_PHONE  || process.env.SUPPORT_PHONE || "";
const RESEND_FROM   = process.env.RESEND_FROM_EMAIL   || "noreply@eviacares.com";

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
