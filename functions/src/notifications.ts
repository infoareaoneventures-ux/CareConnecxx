
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { Resend } from "resend";
import { sendSMSToUser, SMS_TEMPLATES } from "./sms";
import { resolveSupportRouting, alertTeamAboutSupportMessage, SUPPORT_AGENT_NAME } from "./utils/supportRoom";
import { externalOperationDocId } from "./operations/externalSideEffect";

// Initialize Firebase Admin if not already done
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();

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

/**
 * Trigger when a new message is sent in a real caregiver<->client chatRooms
 * conversation (services/chatService.ts / InboxView.tsx). Notifies the
 * recipient (not the sender) via in-app + SMS.
 *
 * Was previously bound to `threads/{threadId}/messages`, which is only the
 * Evia-assistant chat-widget mirror (threads/cara_{uid}) — real human
 * conversations live in `chatRooms`, so this trigger fired on every Evia-chat
 * message and immediately no-opped (the cara-prefix guard below), and never
 * fired for a real website message at all. Messages/Inbox parity audit,
 * 2026-08-31.
 */
export const onMessageSent = functions.firestore
    .document('chatRooms/{chatRoomId}/messages/{messageId}')
    .onCreate(async (snap, context) => {
        const message = snap.data();
        const chatRoomId = context.params.chatRoomId;

        try {
            if (message.type === 'system') {
                return;
            }

            const chatRoomDoc = await db.collection('chatRooms').doc(chatRoomId).get();
            const chatRoom = chatRoomDoc.data();

            // The website's "Message our team" room (isSupport). Before 2026-09-19 a
            // family's message here "notified" the support account — a uid nobody
            // reads — and reached no one. Now: the person wrote → the team is alerted
            // (admin panel + the founder's phone); the team replied → the person is
            // texted like any Inbox message, from "Evia team".
            const routing = resolveSupportRouting(chatRoom, message);
            if (routing.kind === 'skip') return;
            if (routing.kind === 'alert_team') {
                await alertTeamAboutSupportMessage({ userId: routing.userId, roomId: chatRoomId, preview: String(message.text ?? ''), source: 'support_room_message' });
                return;
            }

            if (chatRoom && chatRoom.participants && Array.isArray(chatRoom.participants)) {
                // Find the recipient (not the sender) — in a support room, the person.
                const recipient = routing.kind === 'relay_to_user' ? routing.userId : chatRoom.participants.find((p: string) => p !== message.senderId);

                if (recipient) {
                    const senderName = routing.kind === 'relay_to_user' ? SUPPORT_AGENT_NAME : (message.senderName || 'Someone');

                    // In-app notification
                    await createNotification(recipient, {
                        title: `💬 New Message from ${senderName}`,
                        body: message.text.substring(0, 100) + (message.text.length > 100 ? '...' : ''),
                        type: 'message'
                    });

                    // Everything reaches people over Evia's text as it happens: the
                    // message itself, every time — not a throttled "open the app"
                    // notice (2026-09-17, Inbox parity). Both directions: a caregiver
                    // typing in the website Inbox reaches the family this way, and a
                    // message Evia posted for either side reaches the other the same way.
                    await sendSMSToUser(recipient, SMS_TEMPLATES.newMessage(senderName, String(message.text ?? '')));
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
