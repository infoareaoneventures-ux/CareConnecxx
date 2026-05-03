"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendShiftReminders = exports.onAppointmentCancelled = exports.onInterviewScheduled = exports.onMessageSent = exports.onAppointmentCreated = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const sms_1 = require("./sms");
// Initialize Firebase Admin if not already done
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();
/**
 * Helper function to create a notification in Firestore
 */
async function createNotification(userId, notification) {
    try {
        await db.collection('users').doc(userId).collection('notifications').add(Object.assign(Object.assign({}, notification), { isRead: false, createdAt: new Date().toISOString() }));
        if (process.env.NODE_ENV !== 'production') {
            console.log(`Notification created for user ${userId}: ${notification.title}`);
        }
    }
    catch (error) {
        if (process.env.NODE_ENV !== 'production') {
            console.error(`Failed to create notification for user ${userId}:`, error);
        }
    }
}
/**
 * Trigger when a new appointment is created
 * Notifies both the client and caregiver via in-app + SMS
 */
exports.onAppointmentCreated = functions.firestore
    .document('appointments/{appointmentId}')
    .onCreate(async (snap, context) => {
    const appointment = snap.data();
    try {
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
            await (0, sms_1.sendSMSToUser)(caregiverId, sms_1.SMS_TEMPLATES.newBookingRequest(appointment.clientName || 'A client', appointment.date, appointment.time));
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
            await (0, sms_1.sendSMSToUser)(appointment.clientId, sms_1.SMS_TEMPLATES.bookingConfirmed(appointment.caregiverName || 'your caregiver', appointment.date, appointment.time));
        }
    }
    catch (error) {
        if (process.env.NODE_ENV !== 'production') {
            console.error('Error in onAppointmentCreated:', error);
        }
    }
});
/**
 * Trigger when a new message is sent in a thread
 * Notifies the recipient (not the sender) via in-app + SMS
 */
exports.onMessageSent = functions.firestore
    .document('threads/{threadId}/messages/{messageId}')
    .onCreate(async (snap, context) => {
    var _a, _b;
    const message = snap.data();
    const threadId = context.params.threadId;
    try {
        // Get thread to find participants
        const threadDoc = await db.collection('threads').doc(threadId).get();
        const thread = threadDoc.data();
        if (thread && thread.participants && Array.isArray(thread.participants)) {
            // Find the recipient (not the sender)
            const recipient = thread.participants.find((p) => p !== message.senderId);
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
                const lastSMSTime = lastSMSDoc.exists ? (_b = (_a = lastSMSDoc.data()) === null || _a === void 0 ? void 0 : _a.timestamp) === null || _b === void 0 ? void 0 : _b.toMillis() : 0;
                const now = Date.now();
                // Only send SMS if last one was more than 5 minutes ago (avoid spam)
                if (now - lastSMSTime > 5 * 60 * 1000) {
                    await (0, sms_1.sendSMSToUser)(recipient, sms_1.SMS_TEMPLATES.newMessage(senderName));
                    await db.collection('smsThrottles').doc(lastSMSKey).set({ timestamp: admin.firestore.FieldValue.serverTimestamp() });
                }
            }
        }
    }
    catch (error) {
        if (process.env.NODE_ENV !== 'production') {
            console.error('Error in onMessageSent:', error);
        }
    }
});
/**
 * Trigger when a video interview is scheduled
 * Notifies both the client and caregiver via in-app + SMS
 */
exports.onInterviewScheduled = functions.firestore
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
            await (0, sms_1.sendSMSToUser)(interview.clientId, sms_1.SMS_TEMPLATES.interviewScheduled(interview.caregiverName, scheduledDate));
        }
        // Notify caregiver
        if (interview.caregiverId) {
            await createNotification(interview.caregiverId, {
                title: '📹 Interview Request',
                body: `${interview.clientName} wants to interview you on ${scheduledDate}`,
                type: 'system'
            });
            await (0, sms_1.sendSMSToUser)(interview.caregiverId, sms_1.SMS_TEMPLATES.interviewScheduled(interview.clientName, scheduledDate));
        }
    }
    catch (error) {
        console.error('Error in onInterviewScheduled:', error);
    }
});
/**
 * Trigger when appointment status changes to 'cancelled'
 * Notifies the other party via in-app + SMS
 */
exports.onAppointmentCancelled = functions.firestore
    .document('appointments/{appointmentId}')
    .onUpdate(async (change, context) => {
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
                await (0, sms_1.sendSMSToUser)(caregiverId, sms_1.SMS_TEMPLATES.bookingCancelled(after.clientName, after.date, reason));
            }
            else if (cancelledBy === 'caregiver' && after.clientId) {
                await createNotification(after.clientId, {
                    title: '❌ Appointment Cancelled',
                    body: `${after.caregiverName} cancelled the appointment on ${after.date}. Reason: ${reason}`,
                    type: 'alert'
                });
                await (0, sms_1.sendSMSToUser)(after.clientId, sms_1.SMS_TEMPLATES.bookingCancelled(after.caregiverName, after.date, reason));
            }
        }
        catch (error) {
            console.error('Error in onAppointmentCancelled:', error);
        }
    }
});
/**
 * Scheduled function: Send shift reminders 1 hour before
 * Runs every 15 minutes to check for upcoming shifts
 */
exports.sendShiftReminders = functions.pubsub
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
            // Parse appointment datetime
            const appointmentDateTime = new Date(`${appointment.date} ${appointment.time}`);
            // Check if appointment is between 15 min and 1 hour from now
            if (appointmentDateTime >= fifteenMinutesFromNow && appointmentDateTime <= oneHourFromNow) {
                // Send reminder to caregiver
                if (appointment.caregiverId) {
                    await (0, sms_1.sendSMSToUser)(appointment.caregiverId.toString(), sms_1.SMS_TEMPLATES.shiftReminder(appointment.clientName, appointment.time));
                }
                // Mark as reminded
                await doc.ref.update({ reminderSent: true });
                console.log(`Shift reminder sent for appointment ${doc.id}`);
            }
        }
    }
    catch (error) {
        console.error('Error in sendShiftReminders:', error);
    }
});
//# sourceMappingURL=notifications.js.map