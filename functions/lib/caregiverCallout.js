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
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBackupCaregiverOptions = exports.requestCalloutRefund = exports.selectBackupCaregiver = exports.onCaregiverCallout = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const sms_1 = require("./sms");
const resend_1 = require("resend");
// Initialize Firebase Admin if not already done
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();
// Initialize Resend for email notifications
const resendApiKey = process.env.RESEND_API_KEY || ((_a = functions.config().resend) === null || _a === void 0 ? void 0 : _a.api_key);
const resend = resendApiKey ? new resend_1.Resend(resendApiKey) : null;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "noreply@careconnex.com";
const FROM_NAME = process.env.RESEND_FROM_NAME || "CareConnex";
/**
 * Helper: Create notification in Firestore
 */
async function createNotification(userId, notification) {
    try {
        await db.collection('users').doc(userId).collection('notifications').add(Object.assign(Object.assign({}, notification), { isRead: false, createdAt: admin.firestore.FieldValue.serverTimestamp() }));
    }
    catch (error) {
        console.error(`Failed to create notification for user ${userId}:`, error);
    }
}
/**
 * Helper: Send email notification
 */
async function sendEmailToUser(userId, subject, htmlContent, textContent) {
    if (!resend) {
        console.log('Resend not configured, skipping email');
        return;
    }
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        const userData = userDoc.data();
        const email = userData === null || userData === void 0 ? void 0 : userData.email;
        if (!email) {
            console.log(`No email for user ${userId}`);
            return;
        }
        const { error } = await resend.emails.send({
            from: `${FROM_NAME} <${FROM_EMAIL}>`,
            to: [email],
            subject: subject,
            html: htmlContent,
            text: textContent
        });
        if (error) {
            console.error('Failed to send email:', error);
        }
        else {
            console.log(`Email sent to user ${userId}`);
        }
    }
    catch (error) {
        console.error('Error sending email:', error);
    }
}
/**
 * Helper: Send push notification via FCM
 */
async function sendPushNotification(userId, title, body, data) {
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        const userData = userDoc.data();
        const fcmTokens = (userData === null || userData === void 0 ? void 0 : userData.fcmTokens) || [];
        if (fcmTokens.length === 0)
            return;
        const sendPromises = fcmTokens.map(async (token) => {
            try {
                await admin.messaging().send({
                    token,
                    notification: {
                        title,
                        body
                    },
                    data: data || {},
                    android: { priority: 'high', notification: { icon: 'ic_notification' } },
                    apns: { payload: { aps: { sound: 'default', badge: 1 } } }
                });
            }
            catch (error) {
                if (error.code === 'messaging/invalid-registration-token') {
                    // Remove invalid token
                    const updatedTokens = fcmTokens.filter((t) => t !== token);
                    await db.collection('users').doc(userId).update({ fcmTokens: updatedTokens });
                }
            }
        });
        await Promise.all(sendPromises);
    }
    catch (error) {
        console.error('Error sending push notification:', error);
    }
}
/**
 * Find backup caregivers when primary calls out
 */
async function findBackupCaregivers(appointment, originalCaregiverId) {
    var _a;
    try {
        // Get appointment requirements
        const { date, time, serviceType } = appointment;
        // Query caregivers who:
        // 1. Are not the original caregiver
        // 2. Are available at that date/time
        // 3. Have the required skills
        // 4. Are verified and active
        // 5. Are within reasonable distance
        const caregiversRef = db.collection('caregivers');
        // Base query: verified, active, not the cancelled caregiver
        let query = caregiversRef
            .where('verified', '==', true)
            .where('isActive', '==', true)
            .where('status', '==', 'approved');
        const snapshot = await query.get();
        const potentialCaregivers = [];
        // Process caregivers one by one to handle async checks
        const caregiverDocs = snapshot.docs.filter(doc => doc.id !== originalCaregiverId);
        for (const doc of caregiverDocs) {
            const data = doc.data();
            data.id = doc.id;
            // Check if caregiver has the required skills
            const hasRequiredSkills = serviceType ?
                (_a = data.skills) === null || _a === void 0 ? void 0 : _a.some(skill => serviceType.toLowerCase().includes(skill.toLowerCase())) :
                true;
            if (!hasRequiredSkills)
                continue;
            // Check availability (simplified - would need more complex logic)
            const isAvailable = checkAvailability(data.availability, date, time);
            if (!isAvailable)
                continue;
            // Check if already booked at that time
            const isBooked = await checkIfBooked(data.id, date, time);
            if (isBooked)
                continue;
            potentialCaregivers.push(data);
        }
        // Sort by rating (highest first) and take top 3
        return potentialCaregivers
            .sort((a, b) => (b.rating || 0) - (a.rating || 0))
            .slice(0, 3);
    }
    catch (error) {
        console.error('Error finding backup caregivers:', error);
        return [];
    }
}
/**
 * Check if caregiver is available at specific date/time
 */
function checkAvailability(availability, date, time) {
    var _a, _b;
    if (!availability)
        return true; // Assume available if no availability set
    // Parse date to get day of week
    const dateObj = new Date(date);
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayOfWeek = days[dateObj.getDay()];
    // Check if caregiver works that day
    const dayAvailability = availability[dayOfWeek];
    if (!dayAvailability || !dayAvailability.available)
        return false;
    // Check if time falls within availability window
    const [hour] = time.split(':');
    const appointmentHour = parseInt(hour);
    const startHour = parseInt(((_a = dayAvailability.startTime) === null || _a === void 0 ? void 0 : _a.split(':')[0]) || '0');
    const endHour = parseInt(((_b = dayAvailability.endTime) === null || _b === void 0 ? void 0 : _b.split(':')[0]) || '23');
    return appointmentHour >= startHour && appointmentHour < endHour;
}
/**
 * Check if caregiver is already booked at that time
 */
async function checkIfBooked(caregiverId, date, time) {
    try {
        const appointmentsSnapshot = await db.collection('appointments')
            .where('caregiverId', '==', caregiverId)
            .where('date', '==', date)
            .where('time', '==', time)
            .where('status', 'in', ['confirmed', 'pending'])
            .get();
        return !appointmentsSnapshot.empty;
    }
    catch (error) {
        console.error('Error checking if caregiver is booked:', error);
        return true; // Assume booked if error
    }
}
/**
 * Cloud Function: Handle caregiver callout/cancellation
 * Triggered when caregiver updates appointment status to 'cancelled' or 'called_out'
 */
exports.onCaregiverCallout = functions.firestore
    .document('appointments/{appointmentId}')
    .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    const appointmentId = context.params.appointmentId;
    // Check if this is a caregiver cancellation
    const wasNotCancelled = before.status !== 'cancelled' && before.status !== 'caregiver_cancelled' && before.status !== 'called_out';
    const isNowCancelled = after.status === 'cancelled' || after.status === 'caregiver_cancelled' || after.status === 'called_out';
    const cancelledByCaregiver = after.cancelledBy === 'caregiver' || after.status === 'caregiver_cancelled' || after.status === 'called_out';
    if (!wasNotCancelled || !isNowCancelled || !cancelledByCaregiver) {
        return null;
    }
    console.log(`Caregiver ${after.caregiverId} called out for appointment ${appointmentId}`);
    try {
        // Update appointment with callout status
        await change.after.ref.update({
            status: 'caregiver_called_out',
            caregiverCalledOutAt: admin.firestore.FieldValue.serverTimestamp(),
            needsBackup: true
        });
        // Find backup caregivers
        const backupCaregivers = await findBackupCaregivers(after, after.caregiverId);
        // Store backup options in the appointment
        await change.after.ref.update({
            backupCaregiverOptions: backupCaregivers.map(c => ({
                caregiverId: c.id,
                caregiverName: `${c.firstName} ${c.lastName}`,
                rating: c.rating,
                hourlyRate: c.hourlyRate,
                photoURL: c.photoURL,
                matchScore: calculateMatchScore(c, after)
            }))
        });
        // Notify client
        await notifyClientOfCallout(after, backupCaregivers);
        return { success: true, backupCount: backupCaregivers.length };
    }
    catch (error) {
        console.error('Error handling caregiver callout:', error);
        return { success: false, error: (error === null || error === void 0 ? void 0 : error.message) || 'Unknown error' };
    }
});
/**
 * Generate HTML email for caregiver callout
 */
function generateCalloutEmailHtml(caregiverName, date, time, backupCaregivers) {
    const caregiverList = backupCaregivers.map((c, i) => {
        var _a;
        return `
        <div style="border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin: 12px 0; background: white;">
            <div style="display: flex; align-items: center; gap: 12px;">
                <div style="width: 48px; height: 48px; background: #0d9488; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold;">
                    ${c.firstName[0]}${c.lastName[0]}
                </div>
                <div style="flex: 1;">
                    <div style="font-weight: 600; color: #0f172a;">${c.firstName} ${c.lastName} ${i === 0 ? '<span style="background: #0d9488; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px;">Best Match</span>' : ''}</div>
                    <div style="color: #64748b; font-size: 14px;">⭐ ${((_a = c.rating) === null || _a === void 0 ? void 0 : _a.toFixed(1)) || '4.5'} • $${c.hourlyRate}/hr</div>
                </div>
            </div>
            ${c.skills ? `<div style="margin-top: 8px;">${c.skills.slice(0, 3).map(s => `<span style="background: #f1f5f9; padding: 4px 8px; border-radius: 4px; font-size: 12px; margin-right: 4px;">${s}</span>`).join('')}</div>` : ''}
        </div>
    `;
    }).join('');
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc;">
            <table role="presentation" style="width: 100%; border-collapse: collapse;">
                <tr>
                    <td align="center" style="padding: 40px 20px;">
                        <table role="presentation" style="width: 600px; border-collapse: collapse; background: white; border-radius: 16px; overflow: hidden;">
                            <tr>
                                <td style="background: #fef2f2; padding: 24px; border-bottom: 1px solid #fecaca;">
                                    <div style="display: flex; align-items: center; gap: 12px;">
                                        <div style="background: #dc2626; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">⚠️</div>
                                        <div>
                                            <h1 style="color: #7f1d1d; font-size: 20px; margin: 0;">Caregiver Cancellation Notice</h1>
                                            <p style="color: #991b1b; margin: 4px 0 0 0; font-size: 14px;">${caregiverName} cancelled your appointment</p>
                                        </div>
                                    </div>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding: 32px;">
                                    <p style="color: #475569; font-size: 16px; line-height: 1.6;">
                                        We're sorry to inform you that <strong>${caregiverName}</strong> has cancelled their appointment scheduled for <strong>${date} at ${time}</strong>.
                                    </p>
                                    
                                    <div style="background: #f0fdfa; border-left: 4px solid #0d9488; padding: 16px; margin: 24px 0;">
                                        <h3 style="color: #0f766e; margin: 0 0 8px 0; font-size: 16px;">✅ Good News: We Found Backup Options!</h3>
                                        <p style="color: #115e59; margin: 0; font-size: 14px;">We've identified ${backupCaregivers.length} qualified caregiver${backupCaregivers.length !== 1 ? 's' : ''} who can take this shift.</p>
                                    </div>

                                    <h3 style="color: #0f172a; font-size: 18px; margin: 24px 0 16px 0;">Available Backup Caregivers</h3>
                                    ${caregiverList}

                                    <div style="text-align: center; margin: 32px 0;">
                                        <a href="https://careconnex-d4c8b.web.app/client/dashboard" 
                                           style="display: inline-block; background: #0d9488; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600;">
                                            Select Backup Caregiver
                                        </a>
                                    </div>

                                    <div style="border-top: 1px solid #e2e8f0; padding-top: 24px; margin-top: 32px;">
                                        <p style="color: #64748b; font-size: 14px; margin: 0;">
                                            <strong>Prefer a refund?</strong> If none of these caregivers work for you, you can request a full refund from your dashboard.
                                        </p>
                                    </div>
                                </td>
                            </tr>
                            <tr>
                                <td style="background: #f8fafc; padding: 24px; text-align: center;">
                                    <p style="color: #64748b; font-size: 13px; margin: 0;">
                                        Need help? Contact us at <a href="mailto:support@careconnex.com" style="color: #0d9488;">support@careconnex.com</a>
                                    </p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </body>
        </html>
    `;
}
/**
 * Generate plain text email for caregiver callout
 */
function generateCalloutEmailText(caregiverName, date, time, backupCaregivers) {
    const caregiverList = backupCaregivers.map((c, i) => {
        var _a, _b;
        return `${i + 1}. ${c.firstName} ${c.lastName}${i === 0 ? ' (Best Match)' : ''}
   Rating: ${((_a = c.rating) === null || _a === void 0 ? void 0 : _a.toFixed(1)) || '4.5'} | Rate: $${c.hourlyRate}/hr
   Skills: ${((_b = c.skills) === null || _b === void 0 ? void 0 : _b.slice(0, 3).join(', ')) || 'General Care'}`;
    }).join('\n\n');
    return `CAREGIVER CANCELLATION NOTICE

We're sorry to inform you that ${caregiverName} has cancelled their appointment scheduled for ${date} at ${time}.

GOOD NEWS: We Found Backup Options!
We've identified ${backupCaregivers.length} qualified caregiver${backupCaregivers.length !== 1 ? 's' : ''} who can take this shift.

AVAILABLE BACKUP CAREGIVERS:

${caregiverList}

To select a backup caregiver, visit:
https://careconnex-d4c8b.web.app/client/dashboard

PREFER A REFUND?
If none of these caregivers work for you, you can request a full refund from your dashboard.

Need help? Contact us at support@careconnex.com

---
CareConnex - Care that feels like family
`;
}
/**
 * Calculate match score for backup caregiver
 */
function calculateMatchScore(caregiver, appointment) {
    var _a;
    let score = 0;
    // Rating (0-5 points)
    score += (caregiver.rating || 4) * 1;
    // Has required skills (5 points)
    if (appointment.serviceType && ((_a = caregiver.skills) === null || _a === void 0 ? void 0 : _a.some(s => appointment.serviceType.toLowerCase().includes(s.toLowerCase())))) {
        score += 5;
    }
    // Competitive rate (3 points if under $30/hr)
    if (caregiver.hourlyRate < 30)
        score += 3;
    return score;
}
/**
 * Notify client of caregiver callout with backup options
 */
async function notifyClientOfCallout(appointment, backupCaregivers) {
    const clientId = appointment.clientId;
    const caregiverName = appointment.caregiverName || 'Your caregiver';
    const date = appointment.date;
    const time = appointment.time;
    // Notification title and body
    const title = '⚠️ Caregiver Cancelled - Backup Options Available';
    const body = `${caregiverName} cancelled your ${date} at ${time} appointment. ${backupCaregivers.length} backup caregivers are available. Tap to view options.`;
    try {
        // 1. In-app notification
        await createNotification(clientId, {
            title,
            body,
            type: 'callout',
            data: {
                appointmentId: appointment.id,
                backupCaregivers: backupCaregivers.map(c => ({
                    id: c.id,
                    name: `${c.firstName} ${c.lastName}`,
                    rating: c.rating,
                    hourlyRate: c.hourlyRate,
                    photoURL: c.photoURL
                })),
                action: 'select_backup_caregiver'
            }
        });
        // 2. Push notification
        await sendPushNotification(clientId, title, body, {
            appointmentId: appointment.id,
            type: 'caregiver_callout',
            action: 'view_backup_options'
        });
        // 3. SMS notification
        const backupNames = backupCaregivers.map(c => `${c.firstName} ${c.lastName}`).join(', ');
        const smsMessage = sms_1.SMS_TEMPLATES.caregiverCallout(caregiverName, date, time, backupCaregivers.length, backupNames);
        await (0, sms_1.sendSMSToUser)(clientId, smsMessage);
        // 4. Email notification
        const emailHtml = generateCalloutEmailHtml(caregiverName, date, time, backupCaregivers);
        const emailText = generateCalloutEmailText(caregiverName, date, time, backupCaregivers);
        await sendEmailToUser(clientId, title, emailHtml, emailText);
        console.log(`Client ${clientId} notified of caregiver callout with ${backupCaregivers.length} backup options via push, SMS, and email`);
    }
    catch (error) {
        console.error('Error notifying client of callout:', error);
    }
}
/**
 * Cloud Function: Client selects backup caregiver
 * Triggered when client chooses a replacement caregiver
 */
exports.selectBackupCaregiver = functions.https.onCall(async (data, context) => {
    var _a;
    // Verify authentication
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { appointmentId, backupCaregiverId } = data;
    if (!appointmentId || !backupCaregiverId) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing appointmentId or backupCaregiverId');
    }
    try {
        // Get appointment
        const appointmentRef = db.collection('appointments').doc(appointmentId);
        const appointmentDoc = await appointmentRef.get();
        if (!appointmentDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Appointment not found');
        }
        const appointment = appointmentDoc.data();
        // Verify this is the client who owns the appointment
        if (appointment.clientId !== context.auth.uid) {
            throw new functions.https.HttpsError('permission-denied', 'Not authorized to modify this appointment');
        }
        // Get new caregiver details
        const caregiverDoc = await db.collection('caregivers').doc(backupCaregiverId).get();
        if (!caregiverDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Caregiver not found');
        }
        const caregiverData = caregiverDoc.data();
        const caregiverName = `${caregiverData === null || caregiverData === void 0 ? void 0 : caregiverData.firstName} ${caregiverData === null || caregiverData === void 0 ? void 0 : caregiverData.lastName}`;
        // Update appointment with new caregiver
        await appointmentRef.update({
            caregiverId: backupCaregiverId,
            caregiverName: caregiverName,
            status: 'confirmed',
            previousCaregiverId: appointment.caregiverId,
            caregiverSwitchedAt: admin.firestore.FieldValue.serverTimestamp(),
            needsBackup: false,
            backupCaregiverOptions: admin.firestore.FieldValue.delete()
        });
        // Notify new caregiver
        await createNotification(backupCaregiverId, {
            title: '🎉 You\'ve Been Assigned a New Client!',
            body: `You've been assigned to care for ${appointment.clientName} on ${appointment.date} at ${appointment.time}. Previous caregiver called out.`,
            type: 'booking'
        });
        await (0, sms_1.sendSMSToUser)(backupCaregiverId, sms_1.SMS_TEMPLATES.backupCaregiverAssigned(appointment.clientName || 'a client', appointment.date, appointment.time, (_a = appointment.location) === null || _a === void 0 ? void 0 : _a.address));
        // Notify client
        await createNotification(appointment.clientId, {
            title: '✅ Backup Caregiver Confirmed',
            body: `${caregiverName} has been assigned to your ${appointment.date} appointment.`,
            type: 'booking'
        });
        return {
            success: true,
            message: `Backup caregiver ${caregiverName} assigned successfully`,
            appointmentId,
            caregiverId: backupCaregiverId,
            caregiverName
        };
    }
    catch (error) {
        console.error('Error selecting backup caregiver:', error);
        throw new functions.https.HttpsError('internal', error.message);
    }
});
/**
 * Cloud Function: Client requests refund when no backup is available
 */
exports.requestCalloutRefund = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { appointmentId, reason } = data;
    try {
        const appointmentRef = db.collection('appointments').doc(appointmentId);
        const appointmentDoc = await appointmentRef.get();
        if (!appointmentDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Appointment not found');
        }
        const appointment = appointmentDoc.data();
        if (appointment.clientId !== context.auth.uid) {
            throw new functions.https.HttpsError('permission-denied', 'Not authorized');
        }
        // Update appointment
        await appointmentRef.update({
            status: 'cancelled_refund_requested',
            refundRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
            refundReason: reason || 'Caregiver called out, no suitable backup available',
            needsBackup: false
        });
        // Create refund request in admin queue
        await db.collection('refundRequests').add({
            appointmentId,
            clientId: appointment.clientId,
            amount: appointment.amount || 0,
            reason: reason || 'Caregiver called out',
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        // Notify admin
        await db.collection('adminNotifications').add({
            type: 'refund_request',
            title: 'New Refund Request - Caregiver Callout',
            body: `Client ${appointment.clientId} requested refund for ${appointment.date} appointment due to caregiver callout.`,
            appointmentId,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return { success: true, message: 'Refund request submitted' };
    }
    catch (error) {
        console.error('Error requesting refund:', error);
        throw new functions.https.HttpsError('internal', error.message);
    }
});
/**
 * Cloud Function: Get backup caregiver options for an appointment
 */
exports.getBackupCaregiverOptions = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { appointmentId } = data;
    try {
        const appointmentDoc = await db.collection('appointments').doc(appointmentId).get();
        if (!appointmentDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Appointment not found');
        }
        const appointment = appointmentDoc.data();
        // Verify ownership
        if (appointment.clientId !== context.auth.uid) {
            throw new functions.https.HttpsError('permission-denied', 'Not authorized');
        }
        // If we already have backup options stored, return those
        if (appointment.backupCaregiverOptions && appointment.backupCaregiverOptions.length > 0) {
            return {
                success: true,
                caregivers: appointment.backupCaregiverOptions,
                appointmentId
            };
        }
        // Otherwise, find new options
        const backupCaregivers = await findBackupCaregivers(appointment, appointment.caregiverId);
        return {
            success: true,
            caregivers: backupCaregivers.map(c => ({
                id: c.id,
                name: `${c.firstName} ${c.lastName}`,
                rating: c.rating,
                hourlyRate: c.hourlyRate,
                photoURL: c.photoURL,
                skills: c.skills,
                matchScore: calculateMatchScore(c, appointment)
            })),
            appointmentId
        };
    }
    catch (error) {
        console.error('Error getting backup options:', error);
        throw new functions.https.HttpsError('internal', error.message);
    }
});
//# sourceMappingURL=caregiverCallout.js.map