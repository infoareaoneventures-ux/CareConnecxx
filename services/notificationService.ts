import { validators } from '../utils/validation';

/**
 * Notification Service
 * Handles SMS, push, and email notifications for families
 * 
 * HIPAA COMPLIANT: No PHI in external communications
 * All sensitive data linked via secure dashboard URLs only
 */

// Rate limiters
const smsRateLimiter = new Map<string, number>();
const emailRateLimiter = new Map<string, number>();
const RATE_LIMIT_MS = 60000; // 1 minute between notifications to same recipient
const MAX_SMS_PER_HOUR = 10;
const smsHourlyCount = new Map<string, { count: number; resetTime: number }>();

export interface NotificationPayload {
  type: 'caregiver_check_in' | 'caregiver_arrived' | 'caregiver_departed' | 'weekly_digest' | 'anomaly_alert';
  seniorId: string;
  seniorName: string;
  caregiverName: string;
  message: string;
  data?: Record<string, any>;
}

/**
 * Check rate limit for recipient
 */
function checkRateLimiter(limiter: Map<string, number>, key: string): boolean {
  const lastSent = limiter.get(key);
  if (lastSent && Date.now() - lastSent < RATE_LIMIT_MS) {
    console.warn(`Rate limit hit for ${key}`);
    return false;
  }
  limiter.set(key, Date.now());
  return true;
}

/**
 * Check hourly SMS limit
 */
function checkHourlySMSLimit(phoneNumber: string): boolean {
  const now = Date.now();
  const record = smsHourlyCount.get(phoneNumber);
  
  if (!record || now > record.resetTime) {
    // Reset or create new record
    smsHourlyCount.set(phoneNumber, { count: 1, resetTime: now + 3600000 });
    return true;
  }
  
  if (record.count >= MAX_SMS_PER_HOUR) {
    console.warn(`Hourly SMS limit exceeded for ${phoneNumber}`);
    return false;
  }
  
  record.count++;
  return true;
}

/**
 * Send SMS notification via Twilio
 * HIPAA: No PHI in SMS - only generic messages with secure links
 */
export async function sendSMS(phoneNumber: string, message: string): Promise<boolean> {
  // Rate limiting
  if (!checkRateLimiter(smsRateLimiter, phoneNumber)) {
    return false;
  }
  
  if (!checkHourlySMSLimit(phoneNumber)) {
    return false;
  }

  // Validate phone number
  const phoneValidation = validators.phone(phoneNumber);
  if (phoneValidation) {
    console.error('Invalid phone number:', phoneValidation);
    return false;
  }

  // Sanitize message (prevent injection)
  const sanitizedMessage = message.replace(/[<>\"']/g, '');

  try {
    // In production, call Firebase Cloud Function
    // const sendSMSFunction = firebase.functions().httpsCallable('sendSMS');
    // await sendSMSFunction({ phoneNumber, message: sanitizedMessage });

    console.log('📱 [SMS] To:', await validators.hashForLogging(phoneNumber), 'Length:', sanitizedMessage.length);
    return true;
  } catch (error) {
    console.error('Failed to send SMS:', error);
    return false;
  }
}

/**
 * Send push notification via Firebase Cloud Messaging
 * HIPAA: No PHI in push notifications
 */
export async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, any>
): Promise<boolean> {
  if (!checkRateLimiter(new Map(), userId)) {
    return false;
  }

  // Sanitize inputs
  const sanitizedTitle = title.replace(/[<>\"']/g, '').substring(0, 100);
  const sanitizedBody = body.replace(/[<>\"']/g, '').substring(0, 200);

  try {
    // In production, call Firebase Cloud Function
    // const sendPushFunction = firebase.functions().httpsCallable('sendPushNotification');
    // await sendPushFunction({ userId, title: sanitizedTitle, body: sanitizedBody, data });

    console.log('🔔 [PUSH] To:', userId, 'Title:', sanitizedTitle);
    return true;
  } catch (error) {
    console.error('Failed to send push notification:', error);
    return false;
  }
}

/**
 * Send email notification
 * HIPAA: No PHI in email body - only generic info with secure dashboard links
 */
export async function sendEmail(
  email: string,
  subject: string,
  htmlBody: string,
  textBody: string
): Promise<boolean> {
  if (!checkRateLimiter(emailRateLimiter, email)) {
    return false;
  }

  // Validate email
  const emailValidation = validators.email(email);
  if (emailValidation) {
    console.error('Invalid email:', emailValidation);
    return false;
  }

  try {
    // In production, call Firebase Cloud Function with SendGrid
    // const sendEmailFunction = firebase.functions().httpsCallable('sendEmail');
    // await sendEmailFunction({ email, subject, htmlBody, textBody });

    console.log('📧 [EMAIL] To:', await validators.hashForLogging(email), 'Subject:', subject);
    return true;
  } catch (error) {
    console.error('Failed to send email:', error);
    return false;
  }
}

/**
 * Generate secure dashboard link for viewing sensitive details
 */
function generateSecureLink(entryId: string, baseUrl: string): string {
  // In production, generate signed URL with expiration
  return `${baseUrl}/client?entry=${entryId}&utm_source=notification`;
}

/**
 * Send weekly digest email
 * HIPAA COMPLIANT: Only aggregate statistics, no individual visit details
 */
export async function sendWeeklyDigest(
  email: string,
  seniorId: string,
  weekData: {
    visitsCount: number;
    totalHours: number;
    avgMood: string;
    highlights: string[];
    photosCount: number;
  }
): Promise<void> {
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://eviacares.com';
  const subject = 'Weekly Care Summary';
  
  // HIPAA-compliant: Only aggregate data, no specific dates/times/activities
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
      <h2 style="color: #0d9488;">Weekly Care Summary</h2>
      <p>Here's a summary of this week's care visits:</p>
      
      <div style="display: flex; gap: 20px; margin: 20px 0;">
        <div style="flex: 1; background: #f0fdf4; padding: 20px; border-radius: 8px; text-align: center;">
          <div style="font-size: 36px; font-weight: bold; color: #047857;">${weekData.visitsCount}</div>
          <div style="color: #666;">Visits</div>
        </div>
        <div style="flex: 1; background: #eff6ff; padding: 20px; border-radius: 8px; text-align: center;">
          <div style="font-size: 36px; font-weight: bold; color: #1d4ed8;">${weekData.totalHours}</div>
          <div style="color: #666;">Hours</div>
        </div>
        <div style="flex: 1; background: #fef3c7; padding: 20px; border-radius: 8px; text-align: center;">
          <div style="font-size: 36px; font-weight: bold; color: #b45309;">${weekData.photosCount}</div>
          <div style="color: #666;">Photos</div>
        </div>
      </div>
      
      <a href="${baseUrl}/client" 
         style="display: inline-block; background: #0d9488; color: white; padding: 14px 28px; 
                text-decoration: none; border-radius: 8px; margin-top: 20px; font-weight: bold;">
        View Full Details in Dashboard
      </a>
      
      <p style="color: #94a3b8; margin-top: 30px; font-size: 12px;">
        This is your weekly summary from Evia.<br>
        <a href="${baseUrl}/settings/notifications" style="color: #64748b;">Update notification preferences</a>
      </p>
    </div>
  `;

  await sendEmail(email, subject, html, `Weekly summary: ${weekData.visitsCount} visits, ${weekData.totalHours} hours.`);
}
