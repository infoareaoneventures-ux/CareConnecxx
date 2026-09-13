import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { Resend } from "resend";
import { appLink } from "./config/appUrl";
// Initialize email service
const resendApiKey = process.env.RESEND_API_KEY || functions.config().resend?.api_key;
const resend = resendApiKey ? new Resend(resendApiKey) : null;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "support@eviacares.com";

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
            // `body`/`isRead` are the canonical fields the notification UI reads
            // (types.ts Notification, NotificationDropdown); `message`/`read` kept for legacy readers.
            body: `${intakeData.contactName || 'A new client'} completed intake for ${intakeData.recipientName || 'care services'}. Priority: ${priority}`,
            message: `${intakeData.contactName || 'A new client'} completed intake for ${intakeData.recipientName || 'care services'}. Priority: ${priority}`,
            matchAssignmentId: matchAssignmentId,
            intakeId: intakeData.userId,
            priority: priority,
            isRead: false,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
    });
    
    await Promise.all(notifications);
    console.log(`[onIntakeCompleted] Notifications sent to ${notifications.length} coordinators`);
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
            <p><a href="${appLink("/admin")}" style="background-color: #0ea5e9; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Review in Dashboard</a></p>
            <p>Match Assignment ID: ${matchAssignmentId}</p>
        `;
        
        await resend.emails.send({
            from: `Evia <${FROM_EMAIL}>`,
            to: coordinatorEmails,
            subject: subject,
            html: html,
            text: `New client intake from ${intakeData.contactName}. Priority: ${priority}. Review at ${appLink("/admin")}`
        });
        
        console.log(`[sendIntakeNotificationEmail] Sent to ${coordinatorEmails.length} coordinators`);
    } catch (error) {
        console.error('[sendIntakeNotificationEmail] Error:', error);
    }
}
