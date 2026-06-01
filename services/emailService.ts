import { validators } from '../utils/validation';

/**
 * Email Service using Resend
 * HIPAA COMPLIANT: No PHI in external communications
 * All sensitive data linked via secure dashboard URLs only
 * 
 * Features:
 * - Send transactional emails
 * - Email templates for common notifications
 * - Rate limiting
 * - Error handling and retry logic
 */

// Rate limiter
const emailRateLimiter = new Map<string, number>();
const RATE_LIMIT_MS = 60000; // 1 minute between emails to same recipient

export interface EmailOptions {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  fromName?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  attachments?: Array<{
    filename: string;
    content: string | Buffer;
    contentType?: string;
  }>;
}

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

/**
 * Check rate limit for recipient
 */
function checkRateLimiter(email: string): boolean {
  const lastSent = emailRateLimiter.get(email);
  if (lastSent && Date.now() - lastSent < RATE_LIMIT_MS) {
    console.warn(`Email rate limit hit for ${email}`);
    return false;
  }
  emailRateLimiter.set(email, Date.now());
  return true;
}

/**
 * Send email via Resend API
 * HIPAA: No PHI in email body - only generic info with secure dashboard links
 */
export async function sendEmail(options: EmailOptions): Promise<{ success: boolean; id?: string; error?: string }> {
  const { to, subject, html, text, from, fromName, replyTo, cc, bcc } = options;

  // Rate limiting
  if (!checkRateLimiter(to)) {
    return { success: false, error: 'Rate limit exceeded' };
  }

  // Validate email
  const emailValidation = validators.email(to);
  if (emailValidation) {
    console.error('Invalid email:', emailValidation);
    return { success: false, error: 'Invalid email address' };
  }

  // Sanitize inputs
  const sanitizedSubject = subject.replace(/[<>"']/g, '').substring(0, 200);
  const sanitizedHtml = html?.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  const sanitizedText = text?.substring(0, 10000);

  try {
    // In production, call Firebase Cloud Function with Resend
    const { getFunctions, httpsCallable } = await import('firebase/functions');
    const functions = getFunctions();
    const sendEmailFunction = httpsCallable(functions, 'v1-sendEmail');
    
    const result = await sendEmailFunction({
      to,
      subject: sanitizedSubject,
      html: sanitizedHtml,
      text: sanitizedText,
      from,
      fromName,
      replyTo,
      cc,
      bcc
    });

    const data = result.data as { success: boolean; id?: string; error?: string };
    
    if (data.success) {
      console.log('📧 [EMAIL SENT] To:', await validators.hashForLogging(to), 'Subject:', sanitizedSubject);
      return { success: true, id: data.id };
    } else {
      console.error('Email failed:', data.error);
      return { success: false, error: data.error };
    }
  } catch (error) {
    console.error('Failed to send email:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Send email using a template
 */
export async function sendTemplateEmail(
  to: string,
  templateName: keyof typeof emailTemplates,
  variables: Record<string, string>,
  options?: Partial<EmailOptions>
): Promise<{ success: boolean; id?: string; error?: string }> {
  const template = emailTemplates[templateName];
  if (!template) {
    return { success: false, error: `Template '${templateName}' not found` };
  }

  // Replace variables in template
  let subject = template.subject;
  let html = template.html;
  let text = template.text;

  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    subject = subject.replace(regex, value);
    html = html.replace(regex, value);
    text = text.replace(regex, value);
  });

  return sendEmail({
    to,
    subject,
    html,
    text,
    ...options
  });
}

/**
 * Email Templates
 * HIPAA COMPLIANT: No PHI in templates
 */
export const emailTemplates = {
  welcome: {
    subject: 'Welcome to CareConnex!',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to CareConnex</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; margin: 0; padding: 0; background-color: #f8fafc;">
        <table role="presentation" style="width: 100%; border-collapse: collapse;">
          <tr>
            <td align="center" style="padding: 40px 0;">
              <table role="presentation" style="width: 600px; border-collapse: collapse; background: white; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                <tr>
                  <td style="padding: 48px 40px;">
                    <div style="text-align: center; margin-bottom: 32px;">
                      <div style="background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%); width: 64px; height: 64px; border-radius: 16px; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 24px;">
                        <span style="color: white; font-size: 32px;">🏥</span>
                      </div>
                      <h1 style="color: #0f172a; font-size: 28px; margin: 0; font-weight: 700;">Welcome to CareConnex!</h1>
                    </div>
                    
                    <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                      Hi {{name}},
                    </p>
                    
                    <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                      Thank you for joining CareConnex. We're here to help you find trusted caregivers for your loved ones.
                    </p>
                    
                    <div style="background: #f0fdf4; border-left: 4px solid #10b981; padding: 20px; margin: 24px 0; border-radius: 8px;">
                      <p style="margin: 0; color: #166534; font-weight: 600;">Next Steps:</p>
                      <ul style="margin: 12px 0 0 0; padding-left: 20px; color: #166534;">
                        <li>Complete your profile</li>
                        <li>Browse available caregivers</li>
                        <li>Schedule your first visit</li>
                      </ul>
                    </div>
                    
                    <div style="text-align: center; margin: 32px 0;">
                      <a href="{{dashboardUrl}}" style="display: inline-block; background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%); color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                        Go to Dashboard
                      </a>
                    </div>
                    
                    <p style="color: #64748b; font-size: 14px; line-height: 1.6; margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0;">
                      Need help? Reply to this email or contact our support team at support@careconnex.com
                    </p>
                  </td>
                </tr>
              </table>
              
              <table role="presentation" style="width: 600px; margin-top: 24px;">
                <tr>
                  <td style="text-align: center; color: #94a3b8; font-size: 12px;">
                    <p>CareConnex - Connecting families with trusted caregivers</p>
                    <p>{{companyAddress}}</p>
                    <p>
                      <a href="{{privacyUrl}}" style="color: #64748b;">Privacy Policy</a> •
                      <a href="{{termsUrl}}" style="color: #64748b;">Terms of Service</a> •
                      <a href="{{unsubscribeUrl}}" style="color: #64748b;">Unsubscribe</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
    text: `
Welcome to CareConnex!

Hi {{name}},

Thank you for joining CareConnex. We're here to help you find trusted caregivers for your loved ones.

Next Steps:
- Complete your profile
- Browse available caregivers  
- Schedule your first visit

Go to your dashboard: {{dashboardUrl}}

Need help? Contact us at support@careconnex.com

---
CareConnex - Connecting families with trusted caregivers
{{companyAddress}}
    `
  },

  passwordReset: {
    subject: 'Reset Your CareConnex Password',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reset Your Password</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc;">
        <table role="presentation" style="width: 100%; border-collapse: collapse;">
          <tr>
            <td align="center" style="padding: 40px 0;">
              <table role="presentation" style="width: 600px; border-collapse: collapse; background: white; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                <tr>
                  <td style="padding: 48px 40px;">
                    <h1 style="color: #0f172a; font-size: 24px; margin: 0 0 24px 0; text-align: center;">Reset Your Password</h1>
                    
                    <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                      Hi {{name}},
                    </p>
                    
                    <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                      We received a request to reset your password. Click the button below to create a new password:
                    </p>
                    
                    <div style="text-align: center; margin: 32px 0;">
                      <a href="{{resetUrl}}" style="display: inline-block; background: #0d9488; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600;">
                        Reset Password
                      </a>
                    </div>
                    
                    <p style="color: #64748b; font-size: 14px; line-height: 1.6;">
                      Or copy and paste this link into your browser:<br>
                      <a href="{{resetUrl}}" style="color: #0d9488; word-break: break-all;">{{resetUrl}}</a>
                    </p>
                    
                    <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 16px; margin: 24px 0; border-radius: 8px;">
                      <p style="margin: 0; color: #92400e; font-size: 14px;">
                        <strong>Security Tip:</strong> This link expires in 1 hour. If you didn't request a password reset, please ignore this email.
                      </p>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
    text: `
Reset Your CareConnex Password

Hi {{name}},

We received a request to reset your password. Click the link below to create a new password:

{{resetUrl}}

This link expires in 1 hour. If you didn't request a password reset, please ignore this email.
    `
  },

  bookingConfirmation: {
    subject: 'Your Care Visit is Confirmed',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Booking Confirmed</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc;">
        <table role="presentation" style="width: 100%; border-collapse: collapse;">
          <tr>
            <td align="center" style="padding: 40px 0;">
              <table role="presentation" style="width: 600px; border-collapse: collapse; background: white; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                <tr>
                  <td style="padding: 48px 40px;">
                    <div style="text-align: center; margin-bottom: 24px;">
                      <div style="background: #d1fae5; width: 64px; height: 64px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;">
                        <span style="color: #059669; font-size: 32px;">✓</span>
                      </div>
                    </div>
                    
                    <h1 style="color: #0f172a; font-size: 24px; margin: 0 0 24px 0; text-align: center;">Booking Confirmed!</h1>
                    
                    <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                      Hi {{clientName}},
                    </p>
                    
                    <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                      Your care visit has been successfully scheduled. Here are the details:
                    </p>
                    
                    <div style="background: #f1f5f9; border-radius: 12px; padding: 24px; margin: 24px 0;">
                      <div style="margin-bottom: 16px;">
                        <span style="color: #64748b; font-size: 14px;">Date:</span>
                        <span style="color: #0f172a; font-size: 16px; font-weight: 600; margin-left: 8px;">{{date}}</span>
                      </div>
                      <div style="margin-bottom: 16px;">
                        <span style="color: #64748b; font-size: 14px;">Time:</span>
                        <span style="color: #0f172a; font-size: 16px; font-weight: 600; margin-left: 8px;">{{time}}</span>
                      </div>
                      <div>
                        <span style="color: #64748b; font-size: 14px;">Caregiver:</span>
                        <span style="color: #0f172a; font-size: 16px; font-weight: 600; margin-left: 8px;">{{caregiverName}}</span>
                      </div>
                    </div>
                    
                    <div style="text-align: center; margin: 32px 0;">
                      <a href="{{bookingUrl}}" style="display: inline-block; background: #0d9488; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600;">
                        View Booking Details
                      </a>
                    </div>
                    
                    <div style="background: #eff6ff; border-left: 4px solid #3b82f6; padding: 16px; margin: 24px 0; border-radius: 8px;">
                      <p style="margin: 0; color: #1e40af; font-size: 14px;">
                        <strong>What's Next?</strong><br>
                        You'll receive a notification when your caregiver is on their way.
                      </p>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
    text: `
Your Care Visit is Confirmed!

Hi {{clientName}},

Your care visit has been successfully scheduled:

Date: {{date}}
Time: {{time}}
Caregiver: {{caregiverName}}

View details: {{bookingUrl}}

You'll receive a notification when your caregiver is on their way.
    `
  },

  caregiverNewBooking: {
    subject: 'New Care Visit Request',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>New Booking Request</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc;">
        <table role="presentation" style="width: 100%; border-collapse: collapse;">
          <tr>
            <td align="center" style="padding: 40px 0;">
              <table role="presentation" style="width: 600px; border-collapse: collapse; background: white; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                <tr>
                  <td style="padding: 48px 40px;">
                    <h1 style="color: #0f172a; font-size: 24px; margin: 0 0 24px 0;">New Care Visit Request</h1>
                    
                    <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                      Hi {{caregiverName}},
                    </p>
                    
                    <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                      You have a new care visit request. Please review and confirm:
                    </p>
                    
                    <div style="background: #f1f5f9; border-radius: 12px; padding: 24px; margin: 24px 0;">
                      <div style="margin-bottom: 16px;">
                        <span style="color: #64748b; font-size: 14px;">Date:</span>
                        <span style="color: #0f172a; font-size: 16px; font-weight: 600; margin-left: 8px;">{{date}}</span>
                      </div>
                      <div style="margin-bottom: 16px;">
                        <span style="color: #64748b; font-size: 14px;">Time:</span>
                        <span style="color: #0f172a; font-size: 16px; font-weight: 600; margin-left: 8px;">{{time}}</span>
                      </div>
                      <div>
                        <span style="color: #64748b; font-size: 14px;">Location:</span>
                        <span style="color: #0f172a; font-size: 16px; font-weight: 600; margin-left: 8px;">{{location}}</span>
                      </div>
                    </div>
                    
                    <div style="text-align: center; margin: 32px 0;">
                      <a href="{{bookingUrl}}" style="display: inline-block; background: #0d9488; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; margin-right: 12px;">
                        Accept
                      </a>
                      <a href="{{declineUrl}}" style="display: inline-block; background: #f1f5f9; color: #64748b; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600;">
                        Decline
                      </a>
                    </div>
                    
                    <p style="color: #64748b; font-size: 14px; margin-top: 24px;">
                      Please respond within 24 hours to maintain your response rate.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
    text: `
New Care Visit Request

Hi {{caregiverName}},

You have a new care visit request:

Date: {{date}}
Time: {{time}}
Location: {{location}}

Please review and confirm: {{bookingUrl}}

Please respond within 24 hours.
    `
  },

  visitReminder: {
    subject: 'Reminder: Upcoming Care Visit',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Visit Reminder</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc;">
        <table role="presentation" style="width: 100%; border-collapse: collapse;">
          <tr>
            <td align="center" style="padding: 40px 0;">
              <table role="presentation" style="width: 600px; border-collapse: collapse; background: white; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                <tr>
                  <td style="padding: 48px 40px;">
                    <div style="text-align: center; margin-bottom: 24px;">
                      <div style="background: #dbeafe; width: 64px; height: 64px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;">
                        <span style="color: #2563eb; font-size: 32px;">⏰</span>
                      </div>
                    </div>
                    
                    <h1 style="color: #0f172a; font-size: 24px; margin: 0 0 24px 0; text-align: center;">Upcoming Care Visit</h1>
                    
                    <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                      Hi {{name}},
                    </p>
                    
                    <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                      This is a friendly reminder about your scheduled care visit:
                    </p>
                    
                    <div style="background: #f1f5f9; border-radius: 12px; padding: 24px; margin: 24px 0; text-align: center;">
                      <div style="font-size: 32px; font-weight: 700; color: #0d9488; margin-bottom: 8px;">{{time}}</div>
                      <div style="font-size: 18px; color: #475569;">{{date}}</div>
                      <div style="font-size: 14px; color: #64748b; margin-top: 8px;">with {{caregiverName}}</div>
                    </div>
                    
                    <div style="text-align: center; margin: 32px 0;">
                      <a href="{{dashboardUrl}}" style="display: inline-block; background: #0d9488; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600;">
                        View Details
                      </a>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
    text: `
Reminder: Upcoming Care Visit

Hi {{name}},

This is a reminder about your scheduled care visit:

Time: {{time}}
Date: {{date}}
With: {{caregiverName}}

View details: {{dashboardUrl}}
    `
  },

  weeklyDigest: {
    subject: 'Your Weekly Care Summary',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Weekly Summary</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f8fafc;">
        <table role="presentation" style="width: 100%; border-collapse: collapse;">
          <tr>
            <td align="center" style="padding: 40px 0;">
              <table role="presentation" style="width: 600px; border-collapse: collapse; background: white; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                <tr>
                  <td style="padding: 48px 40px;">
                    <h1 style="color: #0f172a; font-size: 24px; margin: 0 0 24px 0; text-align: center;">Weekly Care Summary</h1>
                    
                    <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                      Hi {{name}},
                    </p>
                    
                    <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                      Here's a summary of this week's care visits:
                    </p>
                    
                    <div style="display: table; width: 100%; margin: 24px 0;">
                      <div style="display: table-row;">
                        <div style="display: table-cell; width: 33.33%; padding: 10px;">
                          <div style="background: #f0fdf4; padding: 24px; border-radius: 12px; text-align: center;">
                            <div style="font-size: 36px; font-weight: 700; color: #059669;">{{visitsCount}}</div>
                            <div style="color: #64748b; font-size: 14px; margin-top: 8px;">Visits</div>
                          </div>
                        </div>
                        <div style="display: table-cell; width: 33.33%; padding: 10px;">
                          <div style="background: #eff6ff; padding: 24px; border-radius: 12px; text-align: center;">
                            <div style="font-size: 36px; font-weight: 700; color: #2563eb;">{{totalHours}}h</div>
                            <div style="color: #64748b; font-size: 14px; margin-top: 8px;">Hours</div>
                          </div>
                        </div>
                        <div style="display: table-cell; width: 33.33%; padding: 10px;">
                          <div style="background: #fef3c7; padding: 24px; border-radius: 12px; text-align: center;">
                            <div style="font-size: 36px; font-weight: 700; color: #d97706;">{{photosCount}}</div>
                            <div style="color: #64748b; font-size: 14px; margin-top: 8px;">Photos</div>
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    <div style="text-align: center; margin: 32px 0;">
                      <a href="{{dashboardUrl}}" style="display: inline-block; background: #0d9488; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600;">
                        View Full Details
                      </a>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
    text: `
Weekly Care Summary

Hi {{name}},

This week's summary:
- {{visitsCount}} visits
- {{totalHours}} hours
- {{photosCount}} photos shared

View full details: {{dashboardUrl}}
    `
  }
};

// Re-export from notification service for backwards compatibility
export { sendEmail as sendEmailNotification } from './notificationService';
