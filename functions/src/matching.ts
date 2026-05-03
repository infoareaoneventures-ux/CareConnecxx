import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { Resend } from "resend";
import twilio from "twilio";

// Initialize email service
const resendApiKey = process.env.RESEND_API_KEY || functions.config().resend?.api_key;
const resend = resendApiKey ? new Resend(resendApiKey) : null;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "noreply@careconnex.com";

// Initialize Twilio for SMS
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID || functions.config().twilio?.account_sid;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || functions.config().twilio?.auth_token;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER || functions.config().twilio?.phone_number;
const twilioClient = (twilioAccountSid && twilioAuthToken) ? twilio(twilioAccountSid, twilioAuthToken) : null;

/**
 * Cloud Function: Create Match Assignment on Intake Completion
 * 
 * Triggered when a client completes the intake form.
 * Creates a MatchAssignment document for the care coordinator to review.
 */
export const onIntakeCompleted = functions.firestore
    .document('clientIntakes/{intakeId}')
    .onCreate(async (snap, context) => {
        const intakeData = snap.data();
        const intakeId = context.params.intakeId;
        
        console.log(`[onIntakeCompleted] New intake created: ${intakeId}`);
        
        try {
            // Extract care needs from intake data
            const careNeeds = extractCareNeeds(intakeData);
            
            // Determine priority based on urgency signals
            const priority = determinePriority(intakeData);
            
            // Create MatchAssignment
            const matchAssignmentRef = admin.firestore().collection('match_assignments').doc();
            await matchAssignmentRef.set({
                id: matchAssignmentRef.id,
                clientId: intakeData.userId,
                seniorId: intakeData.userId, // Using userId as seniorId for now
                coordinatorId: null, // Will be assigned by admin
                status: 'pending_review',
                aiSuggestedMatches: [],
                approvedMatches: [],
                rejectedMatches: [],
                careNeeds: careNeeds,
                priority: priority,
                notes: `Intake completed on ${new Date().toLocaleDateString()}. Care types: ${intakeData.careTypes?.join(', ') || 'Not specified'}`,
                intakeId: intakeId,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                reviewedAt: null,
                sentToClientAt: null
            });
            
            console.log(`[onIntakeCompleted] MatchAssignment created: ${matchAssignmentRef.id}`);
            
            // Send notification to admin/coordinators
            await notifyCoordinators(intakeData, matchAssignmentRef.id, priority);
            
            // Send email notification to coordinators
            await sendIntakeNotificationEmail(intakeData, matchAssignmentRef.id, priority);
            
            return { success: true, matchAssignmentId: matchAssignmentRef.id };
        } catch (error) {
            console.error('[onIntakeCompleted] Error:', error);
            throw error;
        }
    });

/**
 * Extract structured care needs from intake data
 */
function extractCareNeeds(intakeData: any): any[] {
    const careNeeds = [];
    
    // Map care types to structured needs
    const careTypeMap: Record<string, { category: string; description: string }> = {
        'personal_care': { category: 'personal_care', description: 'Bathing, dressing, grooming assistance' },
        'medication': { category: 'medical', description: 'Medication reminders and management' },
        'mobility': { category: 'mobility', description: 'Transfer assistance, walking support' },
        'meal_prep': { category: 'household', description: 'Meal preparation and feeding assistance' },
        'transportation': { category: 'mobility', description: 'Transportation to appointments' },
        'companionship': { category: 'companionship', description: 'Social interaction and engagement' },
        'housekeeping': { category: 'household', description: 'Light housekeeping and laundry' },
        'dementia': { category: 'cognitive', description: 'Dementia and memory care support' }
    };
    
    if (intakeData.careTypes && Array.isArray(intakeData.careTypes)) {
        intakeData.careTypes.forEach((type: string) => {
            const mapped = careTypeMap[type] || { category: 'personal_care', description: type };
            careNeeds.push({
                category: mapped.category,
                description: mapped.description,
                frequency: 'daily', // Default, could be extracted from schedule
                priority: 'required'
            });
        });
    }
    
    // If no care types specified, add a generic need
    if (careNeeds.length === 0) {
        careNeeds.push({
            category: 'companionship',
            description: 'General care and companionship',
            frequency: 'daily',
            priority: 'required'
        });
    }
    
    return careNeeds;
}

/**
 * Determine priority based on intake signals
 */
function determinePriority(intakeData: any): 'low' | 'medium' | 'high' | 'urgent' {
    // Check for urgent signals
    const urgentSignals = [
        'urgent',
        'emergency',
        'hospital',
        'fall',
        'immediate',
        'asap'
    ];
    
    const textToCheck = JSON.stringify(intakeData).toLowerCase();
    
    if (urgentSignals.some(signal => textToCheck.includes(signal))) {
        return 'urgent';
    }
    
    // Check start date urgency
    if (intakeData.startDate) {
        const startDate = new Date(intakeData.startDate);
        const daysUntilStart = Math.ceil((startDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        
        if (daysUntilStart <= 3) return 'urgent';
        if (daysUntilStart <= 7) return 'high';
    }
    
    // Default based on care complexity
    if (intakeData.careTypes?.length > 3) return 'high';
    if (intakeData.careTypes?.length > 1) return 'medium';
    
    return 'medium';
}

/**
 * Notify coordinators of new intake
 */
async function notifyCoordinators(intakeData: any, matchAssignmentId: string, priority: string): Promise<void> {
    const db = admin.firestore();
    
    // Get all admin/coordinator users
    const adminsSnapshot = await db.collection('users')
        .where('userType', 'in', ['admin', 'coordinator'])
        .get();
    
    const notifications = adminsSnapshot.docs.map(async (adminDoc) => {
        const notificationRef = db.collection('users').doc(adminDoc.id).collection('notifications').doc();
        
        return notificationRef.set({
            id: notificationRef.id,
            type: 'new_intake',
            title: priority === 'urgent' ? '🚨 Urgent: New Intake' : 'New Client Intake',
            message: `${intakeData.contactName || 'A new client'} completed intake for ${intakeData.recipientName || 'care services'}. Priority: ${priority}`,
            matchAssignmentId: matchAssignmentId,
            intakeId: intakeData.userId,
            priority: priority,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
    });
    
    await Promise.all(notifications);
    console.log(`[onIntakeCompleted] Notifications sent to ${notifications.length} coordinators`);
}

/**
 * Cloud Function: Notify caregiver of hire request
 * 
 * Triggered when a hire request is approved by coordinator
 */
export const onHireRequestApproved = functions.firestore
    .document('hire_requests/{requestId}')
    .onUpdate(async (change, context) => {
        const newData = change.after.data();
        const oldData = change.before.data();
        
        // Only trigger when status changes to coordinator_approved
        if (newData.status !== 'coordinator_approved' || oldData.status === 'coordinator_approved') {
            return null;
        }
        
        console.log(`[onHireRequestApproved] Hire request approved: ${context.params.requestId}`);
        
        try {
            // Notify caregiver
            const caregiverNotificationRef = admin.firestore()
                .collection('users')
                .doc(newData.caregiverId)
                .collection('notifications')
                .doc();
            
            await caregiverNotificationRef.set({
                id: caregiverNotificationRef.id,
                type: 'hire_offer',
                title: '🎉 You\'ve Been Selected!',
                message: `A client wants to hire you as their caregiver. Review the details and accept or decline.`,
                hireRequestId: context.params.requestId,
                clientId: newData.clientId,
                read: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // Send email notification (if email function exists)
            // await sendHireOfferEmail(newData.caregiverId, newData);
            
            console.log(`[onHireRequestApproved] Caregiver notified: ${newData.caregiverId}`);
            
            // Send email and SMS to caregiver
            await Promise.all([
                sendHireOfferEmail(newData.caregiverId, newData),
                sendHireOfferSMS(newData.caregiverId, newData)
            ]);
            
            return { success: true };
        } catch (error) {
            console.error('[onHireRequestApproved] Error:', error);
            throw error;
        }
    });

/**
 * Cloud Function: Notify client when caregiver accepts
 */
export const onCaregiverAcceptsHire = functions.firestore
    .document('hire_requests/{requestId}')
    .onUpdate(async (change, context) => {
        const newData = change.after.data();
        const oldData = change.before.data();
        
        // Only trigger when status changes to caregiver_accepted
        if (newData.status !== 'caregiver_accepted' || oldData.status === 'caregiver_accepted') {
            return null;
        }
        
        console.log(`[onCaregiverAcceptsHire] Caregiver accepted: ${context.params.requestId}`);
        
        try {
            // Notify client
            const clientNotificationRef = admin.firestore()
                .collection('users')
                .doc(newData.clientId)
                .collection('notifications')
                .doc();
            
            await clientNotificationRef.set({
                id: clientNotificationRef.id,
                type: 'caregiver_accepted',
                title: '✅ Caregiver Accepted!',
                message: `Great news! Your selected caregiver has accepted. Your coordinator will finalize the schedule.`,
                hireRequestId: context.params.requestId,
                caregiverId: newData.caregiverId,
                read: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // Create the actual booking/appointment
            await createBookingFromHireRequest(newData, context.params.requestId);
            
            console.log(`[onCaregiverAcceptsHire] Client notified and booking created`);
            
            // Get caregiver name for the email
            const db = admin.firestore();
            const caregiverDoc = await db.collection('caregivers').doc(newData.caregiverId).get();
            const caregiverName = caregiverDoc.exists ? caregiverDoc.data()?.name : 'Your Caregiver';
            
            // Send email to client
            const bookingData = {
                schedule: newData.proposedSchedule,
                dates: generateRecurringDates(newData.proposedStartDate, newData.proposedSchedule.days, 4)
            };
            await sendCaregiverAcceptedEmail(newData.clientId, caregiverName, bookingData);
            
            return { success: true };
        } catch (error) {
            console.error('[onCaregiverAcceptsHire] Error:', error);
            throw error;
        }
    });

/**
 * Create booking from approved hire request
 */
async function createBookingFromHireRequest(hireData: any, hireRequestId: string): Promise<void> {
    const db = admin.firestore();
    
    // Create appointment
    const appointmentRef = db.collection('appointments').doc();
    
    // Generate recurring dates based on schedule
    const dates = generateRecurringDates(
        hireData.proposedStartDate,
        hireData.proposedSchedule.days,
        4 // Next 4 weeks
    );
    
    await appointmentRef.set({
        id: appointmentRef.id,
        clientId: hireData.clientId,
        caregiverId: hireData.caregiverId,
        hireRequestId: hireRequestId,
        status: 'confirmed',
        dates: dates,
        schedule: hireData.proposedSchedule,
        serviceType: hireData.serviceType,
        notes: hireData.clientNotes,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Update hire request with booking ID
    await db.collection('hire_requests').doc(hireRequestId).update({
        status: 'booking_created',
        bookingId: appointmentRef.id
    });
}

/**
 * Generate recurring dates for appointments
 */
function generateRecurringDates(startDate: string, days: string[], weeks: number): Array<{date: string; status: string}> {
    const dates: Array<{date: string; status: string}> = [];
    const dayMap: Record<string, number> = {
        'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6
    };
    
    const start = new Date(startDate);
    
    for (let week = 0; week < weeks; week++) {
        days.forEach(day => {
            const date = new Date(start);
            const targetDay = dayMap[day];
            const currentDay = date.getDay();
            const diff = targetDay - currentDay + (week * 7);
            date.setDate(date.getDate() + diff);
            
            dates.push({
                date: date.toISOString().split('T')[0],
                status: 'scheduled'
            });
        });
    }
    
    return dates;
}

// ==========================================
// EMAIL NOTIFICATIONS
// ==========================================

/**
 * Send email notification to coordinators when new intake arrives
 */
async function sendIntakeNotificationEmail(intakeData: any, matchAssignmentId: string, priority: string): Promise<void> {
    if (!resend) {
        console.log('[sendIntakeNotificationEmail] Resend not configured, skipping email');
        return;
    }
    
    try {
        const db = admin.firestore();
        
        // Get all coordinator emails
        const coordinatorsSnapshot = await db.collection('users')
            .where('userType', 'in', ['admin', 'coordinator'])
            .get();
        
        const coordinatorEmails = coordinatorsSnapshot.docs
            .map(doc => doc.data().email)
            .filter(email => email);
        
        if (coordinatorEmails.length === 0) {
            console.log('[sendIntakeNotificationEmail] No coordinator emails found');
            return;
        }
        
        const priorityEmoji = priority === 'urgent' ? '🚨' : priority === 'high' ? '⚠️' : '📋';
        const subject = `${priorityEmoji} New Client Intake - ${intakeData.contactName || 'New Client'}`;
        
        const html = `
            <h2>New Client Intake Submitted</h2>
            <p><strong>Priority:</strong> ${priority.toUpperCase()}</p>
            <p><strong>Client:</strong> ${intakeData.contactName}</p>
            <p><strong>Email:</strong> ${intakeData.email}</p>
            <p><strong>Phone:</strong> ${intakeData.phone}</p>
            <p><strong>Care Recipient:</strong> ${intakeData.recipientName} (${intakeData.relationship})</p>
            <p><strong>Care Types:</strong> ${intakeData.careTypes?.join(', ') || 'Not specified'}</p>
            <p><strong>Schedule:</strong> ${intakeData.schedule}</p>
            <p><strong>Start Date:</strong> ${intakeData.startDate}</p>
            <p><strong>Location:</strong> ${intakeData.city}, ${intakeData.state} ${intakeData.zipCode}</p>
            ${intakeData.additionalComments ? `<p><strong>Notes:</strong> ${intakeData.additionalComments}</p>` : ''}
            <hr>
            <p><a href="https://careconnex-d4c8b.web.app/admin" style="background-color: #0ea5e9; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Review in Dashboard</a></p>
            <p>Match Assignment ID: ${matchAssignmentId}</p>
        `;
        
        await resend.emails.send({
            from: `CareConnex <${FROM_EMAIL}>`,
            to: coordinatorEmails,
            subject: subject,
            html: html,
            text: `New client intake from ${intakeData.contactName}. Priority: ${priority}. Review at https://careconnex-d4c8b.web.app/admin`
        });
        
        console.log(`[sendIntakeNotificationEmail] Sent to ${coordinatorEmails.length} coordinators`);
    } catch (error) {
        console.error('[sendIntakeNotificationEmail] Error:', error);
    }
}

/**
 * Send SMS to caregiver when hired
 */
async function sendHireOfferSMS(caregiverId: string, hireRequestData: any): Promise<void> {
    if (!twilioClient || !twilioPhoneNumber) {
        console.log('[sendHireOfferSMS] Twilio not configured, skipping SMS');
        return;
    }
    
    try {
        const db = admin.firestore();
        
        // Get caregiver phone number
        const caregiverDoc = await db.collection('caregivers').doc(caregiverId).get();
        if (!caregiverDoc.exists) {
            console.log('[sendHireOfferSMS] Caregiver not found');
            return;
        }
        
        const caregiverData = caregiverDoc.data();
        const phone = caregiverData?.phone;
        
        if (!phone) {
            console.log('[sendHireOfferSMS] Caregiver has no phone number');
            return;
        }
        
        const message = `🎉 Great news! You've been selected by a client on CareConnex! 

A family wants to hire you as their caregiver. 

Schedule: ${hireRequestData.proposedSchedule.days.join(', ')} ${hireRequestData.proposedSchedule.startTime}-${hireRequestData.proposedSchedule.endTime}
Start Date: ${hireRequestData.proposedStartDate}

Log in to accept or decline: https://careconnex-d4c8b.web.app/caregiver`;
        
        await twilioClient.messages.create({
            body: message,
            from: twilioPhoneNumber,
            to: phone
        });
        
        console.log(`[sendHireOfferSMS] Sent to caregiver ${caregiverId}`);
    } catch (error) {
        console.error('[sendHireOfferSMS] Error:', error);
    }
}

/**
 * Send email to caregiver when hired
 */
async function sendHireOfferEmail(caregiverId: string, hireRequestData: any): Promise<void> {
    if (!resend) {
        console.log('[sendHireOfferEmail] Resend not configured, skipping email');
        return;
    }
    
    try {
        const db = admin.firestore();
        
        // Get caregiver data
        const caregiverDoc = await db.collection('caregivers').doc(caregiverId).get();
        if (!caregiverDoc.exists) {
            console.log('[sendHireOfferEmail] Caregiver not found');
            return;
        }
        
        const caregiverData = caregiverDoc.data();
        const email = caregiverData?.email;
        const name = caregiverData?.name;
        
        if (!email) {
            console.log('[sendHireOfferEmail] Caregiver has no email');
            return;
        }
        
        const html = `
            <h2>🎉 You've Been Selected!</h2>
            <p>Hi ${name},</p>
            <p>Great news! A client on CareConnex wants to hire you as their caregiver.</p>
            <h3>Job Details:</h3>
            <ul>
                <li><strong>Schedule:</strong> ${hireRequestData.proposedSchedule.days.join(', ')}</li>
                <li><strong>Hours:</strong> ${hireRequestData.proposedSchedule.startTime} - ${hireRequestData.proposedSchedule.endTime}</li>
                <li><strong>Start Date:</strong> ${hireRequestData.proposedStartDate}</li>
                <li><strong>Service Type:</strong> ${hireRequestData.serviceType}</li>
            </ul>
            ${hireRequestData.clientNotes ? `<p><strong>Client Notes:</strong> ${hireRequestData.clientNotes}</p>` : ''}
            <hr>
            <p><a href="https://careconnex-d4c8b.web.app/caregiver" style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin-right: 10px;">Accept Offer</a></p>
            <p>Please respond within 24 hours to secure this opportunity.</p>
            <p>Questions? Reply to this email or call us at (555) 123-4567.</p>
        `;
        
        await resend.emails.send({
            from: `CareConnex <${FROM_EMAIL}>`,
            to: email,
            subject: '🎉 You\'ve Been Hired on CareConnex!',
            html: html,
            text: `Hi ${name}, You've been selected by a client on CareConnex! Log in to view details and accept: https://careconnex-d4c8b.web.app/caregiver`
        });
        
        console.log(`[sendHireOfferEmail] Sent to caregiver ${caregiverId}`);
    } catch (error) {
        console.error('[sendHireOfferEmail] Error:', error);
    }
}

/**
 * Send email to client when caregiver accepts
 */
async function sendCaregiverAcceptedEmail(clientId: string, caregiverName: string, bookingData: any): Promise<void> {
    if (!resend) {
        console.log('[sendCaregiverAcceptedEmail] Resend not configured, skipping email');
        return;
    }
    
    try {
        const db = admin.firestore();
        
        // Get client data
        const clientDoc = await db.collection('users').doc(clientId).get();
        if (!clientDoc.exists) {
            console.log('[sendCaregiverAcceptedEmail] Client not found');
            return;
        }
        
        const clientData = clientDoc.data();
        const email = clientData?.email;
        const name = clientData?.displayName || 'Client';
        
        if (!email) {
            console.log('[sendCaregiverAcceptedEmail] Client has no email');
            return;
        }
        
        const html = `
            <h2>✅ Your Caregiver Has Accepted!</h2>
            <p>Hi ${name},</p>
            <p>Great news! <strong>${caregiverName}</strong> has accepted your hire request and is excited to start caring for your loved one.</p>
            <h3>Confirmed Schedule:</h3>
            <ul>
                <li><strong>Caregiver:</strong> ${caregiverName}</li>
                <li><strong>Days:</strong> ${bookingData.schedule.days.join(', ')}</li>
                <li><strong>Hours:</strong> ${bookingData.schedule.startTime} - ${bookingData.schedule.endTime}</li>
                <li><strong>Start Date:</strong> ${bookingData.dates[0]?.date}</li>
            </ul>
            <p>Your care coordinator will reach out within 24 hours to finalize the first visit details.</p>
            <hr>
            <p><a href="https://careconnex-d4c8b.web.app/client" style="background-color: #0ea5e9; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">View in Dashboard</a></p>
            <p>Questions? Contact your care coordinator or reply to this email.</p>
        `;
        
        await resend.emails.send({
            from: `CareConnex <${FROM_EMAIL}>`,
            to: email,
            subject: '✅ Your Caregiver Has Accepted!',
            html: html,
            text: `Hi ${name}, ${caregiverName} has accepted your hire request! View details: https://careconnex-d4c8b.web.app/client`
        });
        
        console.log(`[sendCaregiverAcceptedEmail] Sent to client ${clientId}`);
    } catch (error) {
        console.error('[sendCaregiverAcceptedEmail] Error:', error);
    }
}
