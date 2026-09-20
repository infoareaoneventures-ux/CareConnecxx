import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { Resend } from "resend";
import { getAppUrl } from "./config/appUrl";

const resendApiKey = process.env.RESEND_API_KEY || functions.config().resend?.api_key;
const resend = resendApiKey ? new Resend(resendApiKey) : null;

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "support@eviacares.com";
const FROM_NAME = process.env.RESEND_FROM_NAME || "Evia";
const APP_URL = getAppUrl();

// In-memory rate limiter (resets on cold start)
const rateLimiter = new Map<string, number>();
const RATE_LIMIT_MS = 60000;

function isRateLimited(key: string): boolean {
  const last = rateLimiter.get(key);
  if (last && Date.now() - last < RATE_LIMIT_MS) return true;
  rateLimiter.set(key, Date.now());
  return false;
}

// ─── Shared email chrome ────────────────────────────────────────────────────

function emailWrapper(bodyContent: string, footerContent = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;">
    <tr>
      <td align="center" style="padding:40px 16px;">

        <!-- Logo bar -->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
          <tr>
            <td style="padding-bottom:24px;text-align:center;">
              <span style="display:inline-block;background:linear-gradient(135deg,#0d9488,#14b8a6);border-radius:12px;padding:10px 14px;">
                <span style="color:white;font-size:20px;font-weight:800;letter-spacing:-0.5px;">Evia</span>
              </span>
            </td>
          </tr>
        </table>

        <!-- Card -->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0"
               style="max-width:600px;width:100%;background:#ffffff;border-radius:20px;
                      box-shadow:0 4px 24px rgba(0,0,0,0.08);overflow:hidden;">
          <tr><td style="padding:48px 48px 40px;">
            ${bodyContent}
          </td></tr>
        </table>

        <!-- Footer -->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;margin-top:24px;">
          <tr>
            <td style="text-align:center;color:#94a3b8;font-size:12px;line-height:1.8;">
              ${footerContent}
              <p style="margin:8px 0 0;">
                <a href="${APP_URL}/privacy" style="color:#64748b;text-decoration:none;">Privacy Policy</a>
                &nbsp;·&nbsp;
                <a href="${APP_URL}/terms" style="color:#64748b;text-decoration:none;">Terms of Service</a>
                &nbsp;·&nbsp;
                <a href="${APP_URL}" style="color:#64748b;text-decoration:none;">eviacares.com</a>
              </p>
              <p style="margin:4px 0 0;">&copy; ${new Date().getFullYear()} Evia. All rights reserved.</p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

function ctaButton(label: string, url: string, color = "#0d9488"): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:32px auto;">
    <tr>
      <td style="border-radius:10px;background:${color};">
        <a href="${url}"
           style="display:inline-block;padding:16px 36px;color:#ffffff;font-size:16px;
                  font-weight:700;text-decoration:none;border-radius:10px;
                  letter-spacing:0.2px;">
          ${label}
        </a>
      </td>
    </tr>
  </table>`;
}

function stepsList(steps: { icon: string; text: string }[]): string {
  const items = steps
    .map(
      (s) => `<tr>
        <td width="36" valign="top" style="padding-right:12px;">
          <span style="display:inline-block;width:32px;height:32px;border-radius:50%;
                       background:#f0fdf4;text-align:center;line-height:32px;font-size:16px;">
            ${s.icon}
          </span>
        </td>
        <td style="color:#374151;font-size:15px;line-height:1.5;padding-top:4px;">
          ${s.text}
        </td>
      </tr>`
    )
    .join("<tr><td colspan='2' style='height:12px;'></td></tr>");

  return `<table role="presentation" cellpadding="0" cellspacing="0"
           style="background:#f8fafc;border-radius:12px;padding:20px 24px;width:100%;
                  box-sizing:border-box;margin:24px 0;">
    <tr><td>
      <p style="margin:0 0 16px;font-size:14px;font-weight:700;color:#0f172a;
                text-transform:uppercase;letter-spacing:0.8px;">Your next steps</p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
        ${items}
      </table>
    </td></tr>
  </table>`;
}

// ─── Welcome email HTML builders ────────────────────────────────────────────

function clientWelcomeHtml(name: string): string {
  const body = `
    <!-- Hero accent bar -->
    <div style="height:4px;background:linear-gradient(90deg,#0d9488,#14b8a6,#06b6d4);
                border-radius:4px;margin-bottom:36px;"></div>

    <h1 style="margin:0 0 8px;font-size:28px;font-weight:800;color:#0f172a;
               line-height:1.2;">Welcome to Evia, ${name}!</h1>
    <p style="margin:0 0 24px;font-size:16px;color:#64748b;line-height:1.6;">
      You're one step closer to finding trusted, vetted care for your loved ones.
    </p>

    ${stepsList([
      { icon: "👤", text: "<strong>Complete your profile</strong> — Tell us about the person who needs care so we can find the best match." },
      { icon: "🔍", text: "<strong>Browse caregivers</strong> — Search by availability, distance, certifications, and ratings." },
      { icon: "📅", text: "<strong>Book your first visit</strong> — Schedule a meet-and-greet or a full care session." },
    ])}

    <p style="font-size:15px;color:#475569;line-height:1.6;margin:0 0 8px;">
      Every caregiver on Evia is background-checked and reviewed by our Trust &amp; Safety team —
      so you can focus on what matters most.
    </p>

    ${ctaButton("Browse Caregivers", `${APP_URL}/client`)}

    <p style="margin:24px 0 0;font-size:13px;color:#94a3b8;text-align:center;line-height:1.6;">
      Questions? Reply to this email or reach us at
      <a href="mailto:support@eviacares.com" style="color:#0d9488;text-decoration:none;">support@eviacares.com</a>
    </p>
  `;

  return emailWrapper(body, `<p style="margin:0;">You're receiving this because you created an Evia family account.</p>`);
}

function caregiverWelcomeHtml(name: string): string {
  const body = `
    <!-- Hero accent bar -->
    <div style="height:4px;background:linear-gradient(90deg,#8b5cf6,#a78bfa,#6366f1);
                border-radius:4px;margin-bottom:36px;"></div>

    <h1 style="margin:0 0 8px;font-size:28px;font-weight:800;color:#0f172a;
               line-height:1.2;">Welcome aboard, ${name}!</h1>
    <p style="margin:0 0 24px;font-size:16px;color:#64748b;line-height:1.6;">
      Families in your area are already looking for someone like you. Let's get your profile live.
    </p>

    ${stepsList([
      { icon: "📝", text: "<strong>Finish your profile</strong> — Add your photo, bio, certifications, and availability." },
      { icon: "✅", text: "<strong>Pass your background check</strong> — Required to go live. Powered by Checkr, fast results." },
      { icon: "💰", text: "<strong>Connect your payout account</strong> — Set up Stripe to get paid directly after every visit." },
    ])}

    <p style="font-size:15px;color:#475569;line-height:1.6;margin:0 0 8px;">
      Once your profile is complete and verified, you'll appear in family searches and start receiving
      booking requests.
    </p>

    ${ctaButton("Complete Your Profile", `${APP_URL}/caregiver`, "#7c3aed")}

    <p style="margin:24px 0 0;font-size:13px;color:#94a3b8;text-align:center;line-height:1.6;">
      Questions? Reply to this email or reach us at
      <a href="mailto:support@eviacares.com" style="color:#7c3aed;text-decoration:none;">support@eviacares.com</a>
    </p>
  `;

  return emailWrapper(body, `<p style="margin:0;">You're receiving this because you created an Evia caregiver account.</p>`);
}

function passwordResetHtml(name: string, resetUrl: string): string {
  const body = `
    <!-- Hero accent bar -->
    <div style="height:4px;background:linear-gradient(90deg,#f59e0b,#fbbf24);
                border-radius:4px;margin-bottom:36px;"></div>

    <!-- Lock icon -->
    <div style="text-align:center;margin-bottom:28px;">
      <span style="display:inline-block;width:64px;height:64px;border-radius:50%;
                   background:#fef3c7;line-height:64px;font-size:30px;">🔐</span>
    </div>

    <h1 style="margin:0 0 8px;font-size:26px;font-weight:800;color:#0f172a;
               text-align:center;">Reset your password</h1>
    <p style="margin:0 0 24px;font-size:16px;color:#64748b;line-height:1.6;text-align:center;">
      Hi ${name} — we received a request to reset your Evia password.
    </p>

    ${ctaButton("Reset Password", resetUrl, "#0d9488")}

    <!-- Fallback link -->
    <p style="font-size:13px;color:#94a3b8;text-align:center;line-height:1.6;
              margin:0 0 24px;word-break:break-all;">
      Or paste this link into your browser:<br>
      <a href="${resetUrl}" style="color:#0d9488;text-decoration:underline;">${resetUrl}</a>
    </p>

    <!-- Security notice -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;
                   padding:16px 20px;">
          <p style="margin:0;font-size:13px;color:#92400e;line-height:1.6;">
            <strong>Security notice:</strong> This link expires in <strong>1 hour</strong>.
            If you didn't request a password reset, you can safely ignore this email —
            your account remains secure.
          </p>
        </td>
      </tr>
    </table>
  `;

  return emailWrapper(body, `<p style="margin:0;">You're receiving this because a password reset was requested for your Evia account.</p>`);
}

// Account recovery / phone-and-email-change emails (functions/src/accountRecovery.ts).
// Login here is phone-OTP only — this email link is the recovery credential
// when the phone itself is lost, and the gate before any phone/email swap.
export function phoneChangeRequestHtml(name: string, verifyUrl: string): string {
  const body = `
    <div style="height:4px;background:linear-gradient(90deg,#0d9488,#14b8a6,#06b6d4);
                border-radius:4px;margin-bottom:36px;"></div>

    <div style="text-align:center;margin-bottom:28px;">
      <span style="display:inline-block;width:64px;height:64px;border-radius:50%;
                   background:#f0fdfa;line-height:64px;font-size:30px;">📱</span>
    </div>

    <h1 style="margin:0 0 8px;font-size:26px;font-weight:800;color:#0f172a;
               text-align:center;">Confirm your phone number change</h1>
    <p style="margin:0 0 24px;font-size:16px;color:#64748b;line-height:1.6;text-align:center;">
      Hi ${name} — we received a request to change the phone number on your Evia account.
    </p>

    ${ctaButton("Continue", verifyUrl, "#0d9488")}

    <p style="font-size:13px;color:#94a3b8;text-align:center;line-height:1.6;
              margin:0 0 24px;word-break:break-all;">
      Or paste this link into your browser:<br>
      <a href="${verifyUrl}" style="color:#0d9488;text-decoration:underline;">${verifyUrl}</a>
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;
                   padding:16px 20px;">
          <p style="margin:0;font-size:13px;color:#92400e;line-height:1.6;">
            <strong>Security notice:</strong> This link expires in <strong>30 minutes</strong>.
            If you didn't request this, you can safely ignore this email — your phone number
            will not be changed.
          </p>
        </td>
      </tr>
    </table>
  `;
  return emailWrapper(body, `<p style="margin:0;">You're receiving this because a phone number change was requested for your Evia account.</p>`);
}

export function phoneChangeConfirmedHtml(newPhoneLast4: string): string {
  const body = `
    <div style="text-align:center;margin-bottom:28px;">
      <span style="display:inline-block;width:64px;height:64px;border-radius:50%;
                   background:#f0fdf4;line-height:64px;font-size:30px;">✅</span>
    </div>
    <h1 style="margin:0 0 8px;font-size:26px;font-weight:800;color:#0f172a;
               text-align:center;">Your phone number was changed</h1>
    <p style="margin:0;font-size:16px;color:#64748b;line-height:1.6;text-align:center;">
      Your Evia account's phone number was just changed to one ending in <strong>${newPhoneLast4}</strong>.
      If this wasn't you, contact support right away.
    </p>
  `;
  return emailWrapper(body);
}

export function emailChangeConfirmHtml(verifyUrl: string): string {
  const body = `
    <div style="height:4px;background:linear-gradient(90deg,#0d9488,#14b8a6,#06b6d4);
                border-radius:4px;margin-bottom:36px;"></div>

    <div style="text-align:center;margin-bottom:28px;">
      <span style="display:inline-block;width:64px;height:64px;border-radius:50%;
                   background:#f0fdfa;line-height:64px;font-size:30px;">✉️</span>
    </div>

    <h1 style="margin:0 0 8px;font-size:26px;font-weight:800;color:#0f172a;
               text-align:center;">Confirm this email address</h1>
    <p style="margin:0 0 24px;font-size:16px;color:#64748b;line-height:1.6;text-align:center;">
      Someone requested to use this address as the recovery email for an Evia account.
      Confirm it's you to finish the change.
    </p>

    ${ctaButton("Confirm email", verifyUrl, "#0d9488")}

    <p style="font-size:13px;color:#94a3b8;text-align:center;line-height:1.6;
              margin:0 0 24px;word-break:break-all;">
      Or paste this link into your browser:<br>
      <a href="${verifyUrl}" style="color:#0d9488;text-decoration:underline;">${verifyUrl}</a>
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;
                   padding:16px 20px;">
          <p style="margin:0;font-size:13px;color:#92400e;line-height:1.6;">
            <strong>Security notice:</strong> This link expires in <strong>30 minutes</strong>.
            If you didn't request this, you can safely ignore this email.
          </p>
        </td>
      </tr>
    </table>
  `;
  return emailWrapper(body, `<p style="margin:0;">You're receiving this because this address was entered as a new recovery email on Evia.</p>`);
}

// ─── Reusable server-side send helper ────────────────────────────────────────

/**
 * Send a transactional email from server-side code (other Cloud Functions).
 * Throws if Resend is not configured or the provider rejects the send.
 */
export async function sendTransactionalEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  fromName?: string;
}): Promise<{ id?: string }> {
  if (!resend) {
    throw new Error("Email service not configured (RESEND_API_KEY missing)");
  }

  const { data, error } = await resend.emails.send({
    from: `${opts.fromName || FROM_NAME} <${opts.from || FROM_EMAIL}>`,
    to: [opts.to],
    subject: opts.subject.replace(/[<>"']/g, "").substring(0, 200),
    html: opts.html?.substring(0, 50000),
    text: opts.text?.substring(0, 10000),
  });

  if (error) throw new Error(error.message);
  return { id: data?.id };
}

// ─── Cloud Functions ─────────────────────────────────────────────────────────

/**
 * Callable: send a transactional email (requires auth)
 */
export const sendEmail = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Authentication required");
  }
  if (!resend) {
    throw new functions.https.HttpsError("failed-precondition", "Email service not configured");
  }

  const caller = await admin.firestore().collection("users").doc(context.auth.uid).get();
  if (context.auth.token.admin !== true && caller.data()?.role !== "admin" && caller.data()?.isAdmin !== true) {
    throw new functions.https.HttpsError("permission-denied", "Admins only");
  }

  const { to, subject, html, text, replyTo } = data;

  if (!to || !subject || (!html && !text)) {
    throw new functions.https.HttpsError("invalid-argument", "Missing required fields: to, subject, and html or text");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid email address");
  }

  if (isRateLimited(to)) {
    throw new functions.https.HttpsError("resource-exhausted", "Rate limit exceeded for this recipient");
  }

  try {
    const { data: emailData, error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject: subject.replace(/[<>"']/g, "").substring(0, 200),
      html: html?.substring(0, 50000),
      text: text?.substring(0, 10000),
      reply_to: replyTo,
    });

    if (error) throw new Error(error.message);

    const hashedEmail = Buffer.from(to).toString("base64").substring(0, 16);
    console.log(`Email sent to ${hashedEmail}`, { id: emailData?.id, uid: context.auth.uid });

    return { success: true, id: emailData?.id };
  } catch (err: any) {
    console.error("sendEmail error:", err);
    throw new functions.https.HttpsError("internal", err.message || "Failed to send email");
  }
});

/**
 * Callable: send bulk email (admin only)
 */
export const sendBulkEmail = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Authentication required");
  }

  const userDoc = await admin.firestore().collection("users").doc(context.auth.uid).get();
  if (userDoc.data()?.role !== "admin") {
    throw new functions.https.HttpsError("permission-denied", "Admins only");
  }
  if (!resend) {
    throw new functions.https.HttpsError("failed-precondition", "Email service not configured");
  }

  const { recipients, subject, html, text } = data;
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new functions.https.HttpsError("invalid-argument", "Recipients array required");
  }
  if (recipients.length > 100) {
    throw new functions.https.HttpsError("invalid-argument", "Maximum 100 recipients per batch");
  }

  const results: any[] = [];
  const errors: any[] = [];

  for (let i = 0; i < recipients.length; i++) {
    const to = recipients[i];
    try {
      const { data: emailData, error } = await resend.emails.send({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: [to],
        subject: subject.substring(0, 200),
        html,
        text,
      });
      if (error) errors.push({ email: to, error: error.message });
      else results.push({ email: to, id: emailData?.id });
    } catch (err: any) {
      errors.push({ email: to, error: err.message });
    }
    if (i < recipients.length - 1) await new Promise((r) => setTimeout(r, 100));
  }

  return { success: errors.length === 0, sent: results.length, failed: errors.length, results, errors: errors.slice(0, 10) };
});

/**
 * Callable: generate a branded password reset email via Resend.
 * Does NOT require auth (user is locked out). Always returns success
 * to avoid revealing whether an email is registered.
 */
export const sendPasswordResetEmail = functions.https.onCall(async (data) => {
  const { email } = data;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new functions.https.HttpsError("invalid-argument", "Valid email required");
  }

  // Always return success after this point — never reveal user existence
  if (!resend) {
    console.warn("Resend not configured, skipping password reset email");
    return { success: true };
  }

  if (isRateLimited(`reset_${email.toLowerCase()}`)) {
    return { success: true };
  }

  try {
    const resetLink = await admin.auth().generatePasswordResetLink(email);

    // Best-effort name lookup
    let name = "there";
    try {
      const userRecord = await admin.auth().getUserByEmail(email);
      const userDoc = await admin.firestore().collection("users").doc(userRecord.uid).get();
      const userData = userDoc.data();
      const fullName = userData?.name || userRecord.displayName || "";
      name = fullName.split(" ")[0] || "there";
    } catch {
      // User not found — still send nothing but return success
      return { success: true };
    }

    const { error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [email],
      subject: "Reset your Evia password",
      html: passwordResetHtml(name, resetLink),
      text: `Hi ${name},\n\nWe received a request to reset your Evia password.\n\nReset your password: ${resetLink}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.\n\n— The Evia Team`,
    });

    if (error) console.error("Password reset email error:", error);

    return { success: true };
  } catch (err: any) {
    // auth/user-not-found and similar — swallow silently
    console.error("sendPasswordResetEmail:", err.code || err.message);
    return { success: true };
  }
});

/**
 * Firestore trigger: send role-specific welcome email when a user doc is created.
 * Handles email/password signup AND Google sign-in (both create a users/ doc).
 */
export const sendWelcomeEmail = functions.firestore
  .document("users/{userId}")
  .onCreate(async (snap) => {
    if (!resend) {
      console.log("Resend not configured, skipping welcome email");
      return null;
    }

    const userData = snap.data();
    const email = userData?.email;
    const userType: "client" | "caregiver" = userData?.userType === "caregiver" ? "caregiver" : "client";

    if (!email) {
      console.log("No email on user doc, skipping welcome email");
      return null;
    }

    const fullName: string = userData?.name || userData?.displayName || userData?.firstName || "";
    const firstName = fullName.split(" ")[0] || "there";

    const subject = userType === "caregiver"
      ? `Welcome to Evia, ${firstName}!`
      : `Welcome to Evia!`;

    const html = userType === "caregiver"
      ? caregiverWelcomeHtml(firstName)
      : clientWelcomeHtml(firstName);

    const textClient = `Welcome to Evia, ${firstName}!\n\nYou're one step closer to finding trusted care for your loved ones.\n\nNext steps:\n1. Complete your profile\n2. Browse caregivers\n3. Book your first visit\n\nGet started: ${APP_URL}/client\n\n— The Evia Team`;
    const textCaregiver = `Welcome aboard, ${firstName}!\n\nFamilies in your area are looking for someone like you.\n\nNext steps:\n1. Complete your profile\n2. Pass your background check\n3. Connect your payout account\n\nGet started: ${APP_URL}/caregiver\n\n— The Evia Team`;

    try {
      const { error } = await resend.emails.send({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: [email],
        subject,
        html,
        text: userType === "caregiver" ? textCaregiver : textClient,
      });

      if (error) {
        console.error("Welcome email send error:", error);
        return { success: false, error: error.message };
      }

      console.log(`Welcome email (${userType}) sent for user ${snap.id}`);
      return { success: true };
    } catch (err: any) {
      console.error("Welcome email exception:", err);
      return { success: false, error: err.message };
    }
  });

// Sent to the CURRENT (confirmed) recovery email when a change is requested —
// that address approves the change before the new one is ever contacted.
export function emailChangeApprovalHtml(newEmailMasked: string, approveUrl: string): string {
  const body = `
    <div style="height:4px;background:linear-gradient(90deg,#0d9488,#14b8a6,#06b6d4);
                border-radius:4px;margin-bottom:36px;"></div>

    <div style="text-align:center;margin-bottom:28px;">
      <span style="display:inline-block;width:64px;height:64px;border-radius:50%;
                   background:#f0fdfa;line-height:64px;font-size:30px;">🔐</span>
    </div>

    <h1 style="margin:0 0 8px;font-size:26px;font-weight:800;color:#0f172a;
               text-align:center;">Approve this email change?</h1>
    <p style="margin:0 0 24px;font-size:16px;color:#64748b;line-height:1.6;text-align:center;">
      Someone signed in to your Evia account asked to change its recovery email to
      <strong style="color:#0f172a;">${newEmailMasked}</strong>. Because this address is the one on file,
      it has to approve the change first. If that was you, tap below — the new address will then get its own
      confirmation link, and nothing changes until it's opened.
    </p>

    ${ctaButton("Approve the change", approveUrl, "#0d9488")}

    <p style="font-size:13px;color:#94a3b8;text-align:center;line-height:1.6;
              margin:0 0 24px;word-break:break-all;">
      Or paste this link into your browser:<br>
      <a href="${approveUrl}" style="color:#0d9488;text-decoration:underline;">${approveUrl}</a>
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;
                   padding:16px 20px;">
          <p style="margin:0;font-size:13px;color:#92400e;line-height:1.6;">
            <strong>Didn't ask for this?</strong> Ignore this email and nothing will change. This link expires in
            <strong>30 minutes</strong>. If you think someone else has access to your account, text Evia and
            we'll help you lock it down.
          </p>
        </td>
      </tr>
    </table>
  `;
  return emailWrapper(body, `<p style="margin:0;">You're receiving this because this address is the recovery email on an Evia account.</p>`);
}

// Sent to the OLD address once a change has fully gone through.
export function emailChangedNoticeHtml(newEmailMasked: string): string {
  const body = `
    <div style="height:4px;background:linear-gradient(90deg,#0d9488,#14b8a6,#06b6d4);
                border-radius:4px;margin-bottom:36px;"></div>

    <h1 style="margin:0 0 8px;font-size:26px;font-weight:800;color:#0f172a;
               text-align:center;">Your recovery email was changed</h1>
    <p style="margin:0 0 24px;font-size:16px;color:#64748b;line-height:1.6;text-align:center;">
      The recovery email on your Evia account is now <strong style="color:#0f172a;">${newEmailMasked}</strong>.
      This address no longer receives account security links.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;
                   padding:16px 20px;">
          <p style="margin:0;font-size:13px;color:#92400e;line-height:1.6;">
            <strong>Wasn't you?</strong> Text Evia right away from the phone on your account and we'll help you secure it.
          </p>
        </td>
      </tr>
    </table>
  `;
  return emailWrapper(body, `<p style="margin:0;">You're receiving this because this address was the recovery email on an Evia account.</p>`);
}
