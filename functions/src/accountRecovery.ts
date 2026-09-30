import * as admin from "firebase-admin";
import * as crypto from "crypto";
import {
  sendTransactionalEmail,
  phoneChangeRequestHtml,
  phoneChangeConfirmedHtml,
  emailChangeConfirmHtml,
  emailChangeApprovalHtml,
  emailChangedNoticeHtml,
} from "./email";
import { sendSMS } from "./sms";
import { appLink } from "./config/appUrl";
import { generateOtp, verifyOtp, OtpState } from "./utils/phoneVerification";

// Account phone-number change/recovery, gated by the email already on file.
// Login here is phone-OTP only, so this email round-trip is the only recovery
// path when the phone itself is lost, and (for a logged-in change too) the
// thing standing between "I have UI access right now" and actually taking
// over someone's login number.
//
// These are plain functions, not Cloud Functions themselves — careconnex-d4c8b
// has a GCP org policy that blocks granting public invoker IAM to brand-new
// Cloud Functions (see project memory: the same wall broke the original
// password-gate callable, worked around there via processAdminAdvanceQueue's
// Firestore-trigger pattern). The website reaches these by writing a request
// doc to account_action_requests/{id} (functions/src/triggers/accountActionQueue.ts
// is the one new Firestore-triggered function that calls them — triggers don't
// need public HTTP invoker IAM at all). Evia's MCP tools call them directly,
// in-process, since they already run inside an already-deployed function.
//
// Phone flow:
//   requestPhoneChangeByEmail     — email in, verification email out (always
//                                    resolves, never reveals whether the email
//                                    matched an account)
//   startPhoneChangeVerification  — token + new phone in, OTP texted to the
//                                    new number (typo-catch, not the security
//                                    boundary — the email step already gated
//                                    access)
//   confirmPhoneChange            — token + code in, does the actual swap
//
// Email: confirmed at first entry, changes approved from the confirmed address
// first (see the "Recovery email" section below):
//   sendEmailConfirmation         — one confirmation link to one inbox
//   requestEmailChangeSelf        — approval link to the OLD address (or straight
//                                    to the new inbox when nothing is confirmed)
//   approveEmailChange / *Fallback — old-address link, phone code, or APPROVE text
//   confirmEmailChange            — the new inbox's link does the swap

const db = () => admin.firestore();

const REQUEST_TTL_MS = 30 * 60 * 1000; // 30 min
const RATE_LIMIT_MS = 60 * 1000;

export type Role = "client" | "caregiver";

function randomToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Firestore-backed rate limiting (the existing in-memory Map in email.ts
// resets on cold start and is too weak for a security-sensitive flow).
async function isRateLimited(collection: string, key: string): Promise<boolean> {
  const ref = db().collection(collection).doc(encodeURIComponent(key));
  const snap = await ref.get();
  const last = snap.data()?.lastRequestAt as number | undefined;
  if (last && Date.now() - last < RATE_LIMIT_MS) return true;
  await ref.set({ lastRequestAt: Date.now() }, { merge: true });
  return false;
}

interface AccountMatch { uid: string; role: Role; name: string }

// users/{uid}.email and caregivers/{uid}.email are free text, never
// normalized on write — try the string as typed, then lowercased.
async function findAccountByEmail(email: string): Promise<AccountMatch | null> {
  for (const candidate of [email, email.toLowerCase()]) {
    const usersSnap = await db().collection("users").where("email", "==", candidate).limit(1).get();
    if (!usersSnap.empty) {
      const doc = usersSnap.docs[0];
      const d = doc.data();
      return { uid: doc.id, role: "client", name: (d.displayName || d.firstName || d.name || "there").split(" ")[0] };
    }
    const caregiversSnap = await db().collection("caregivers").where("email", "==", candidate).limit(1).get();
    if (!caregiversSnap.empty) {
      const doc = caregiversSnap.docs[0];
      const d = doc.data();
      return { uid: doc.id, role: "caregiver", name: (d.firstName || d.name || "there").split(" ")[0] };
    }
  }
  return null;
}

// Core logic shared by the website's request flow (looks the account up by
// email) and Evia's request_phone_number_change path (the account is already
// known, so it hands the email straight through). Both converge here so
// there is exactly one place that creates the request doc and sends the email.
export async function requestPhoneChangeForAccount(account: AccountMatch, email: string): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  await db().collection("phone_change_requests").doc(token).set({
    uid: account.uid,
    role: account.role,
    email,
    name: account.name,
    requestedAt: now,
    expiresAt: now + REQUEST_TTL_MS,
    status: "pending",
    newPhone: null,
    otp: null,
  });

  const verifyUrl = appLink(`/verify-phone-change?token=${token}`);
  await sendTransactionalEmail({
    to: email,
    subject: "Verify it's you — change your Evia phone number",
    html: phoneChangeRequestHtml(account.name, verifyUrl),
  });
}

// ── requestPhoneChangeByEmail (website's logged-out/logged-in entry point) ───
// Anti-enumeration: always resolves, never throws — the caller can never tell
// whether the email matched an account, was rate limited, or the send failed.
// Only the pending-request side effects differ.
export async function requestPhoneChangeByEmail(rawEmail: string): Promise<void> {
  const email = rawEmail.trim();
  if (!email || !isValidEmail(email)) return;
  if (await isRateLimited("phone_change_rate_limits", email.toLowerCase())) return;

  try {
    const account = await findAccountByEmail(email);
    if (!account) return;
    // The recovery email is the anchor for this flow — an unconfirmed one proves
    // nothing, so it is never used (the logged-in pages explain and offer Resend;
    // this logged-out path stays silent by design).
    if (!(await emailVerifiedForAccount(account.uid, account.role))) {
      console.info("requestPhoneChangeByEmail: recovery email not confirmed, no link sent", { uid: account.uid });
      return;
    }
    await requestPhoneChangeForAccount(account, email);
  } catch (err) {
    console.error("requestPhoneChangeByEmail:", err);
  }
}

// ── startPhoneChangeVerification ────────────────────────────────────────────
export async function startPhoneChangeVerification(token: string, newPhone: string): Promise<void> {
  if (!token) throw new Error("Missing token");
  if (!/^\+1\d{10}$/.test(newPhone)) {
    throw new Error("Phone must be in E.164 format (+1XXXXXXXXXX)");
  }

  const ref = db().collection("phone_change_requests").doc(token);
  const snap = await ref.get();
  const reqData = snap.data();
  if (!snap.exists || !reqData || reqData.status !== "pending" || (reqData.expiresAt as number) < Date.now()) {
    throw new Error("This link is invalid or has expired.");
  }

  const otp = generateOtp();
  await ref.update({ newPhone, otp });

  const smsResult = await sendSMS({
    to: newPhone,
    message: `Your Evia verification code is ${otp.code}. It expires in 15 minutes.`,
  });
  if (!smsResult.success) {
    // An opted-out number (STOP / END texted to Evia earlier) can't receive the
    // code — say what to do instead of surfacing the raw send error (2026-09-29).
    if (/opted out/i.test(smsResult.error ?? "")) {
      throw new Error("That number has texts from Evia turned off. Text START to Evia from that phone, then try again — or change your number from Account Settings on the site.");
    }
    throw new Error(smsResult.error || "Could not send a verification code to that number.");
  }
}

// ── confirmPhoneChange ───────────────────────────────────────────────────────
export async function confirmPhoneChange(token: string, code: string): Promise<void> {
  if (!token || !code) throw new Error("Missing token or code");

  const ref = db().collection("phone_change_requests").doc(token);
  const snap = await ref.get();
  const reqData = snap.data();
  if (!snap.exists || !reqData || reqData.status !== "pending" || (reqData.expiresAt as number) < Date.now() || !reqData.newPhone) {
    throw new Error("This link is invalid or has expired.");
  }

  const otpState = reqData.otp as OtpState | undefined;
  const result = verifyOtp(code, otpState);
  if (result.status !== "ok") {
    if (otpState) {
      await ref.update({ otp: { ...otpState, attempts: (otpState.attempts ?? 0) + 1 } });
    }
    throw new Error(
      result.status === "wrong"
        ? "Incorrect code. Please try again."
        : "That code expired or too many attempts were made. Request a new one.",
    );
  }

  const { uid, role, newPhone, email } = reqData as { uid: string; role: Role; newPhone: string; email: string };
  const collection = role === "caregiver" ? "caregivers" : "users";
  const profileRef = db().collection(collection).doc(uid);
  const profileSnap = await profileRef.get();
  const oldPhone = profileSnap.data()?.phone as string | undefined;

  await admin.auth().updateUser(uid, { phoneNumber: newPhone });
  await profileRef.set({ phone: newPhone }, { merge: true });

  if (oldPhone && oldPhone !== newPhone) {
    await db().collection("agent_sessions").doc(oldPhone).delete().catch(() => {});
  }

  await ref.update({ status: "consumed" });

  const last4 = newPhone.slice(-4);
  await Promise.allSettled([
    oldPhone
      ? sendSMS({ to: oldPhone, message: `Evia: your account's phone number was just changed to end in ${last4}. If this wasn't you, contact support immediately.` })
      : Promise.resolve(),
    sendSMS({ to: newPhone, message: "Evia: this number is now linked to your account." }),
    email
      ? sendTransactionalEmail({ to: email, subject: "Your Evia phone number was changed", html: phoneChangeConfirmedHtml(last4) })
      : Promise.resolve(),
  ]);
}

// ── Recovery email: confirmed at first entry, changes approved from the old ──
// address (founder decision 2026-09-20). The recovery email is the phone-change
// flow's trust anchor, so:
//   1. Every address is CONFIRMED when first entered — from the signup page or
//      Evia's onboarding alike. triggers/emailConfirmation.ts watches
//      users/{uid}.email and caregivers/{uid}.email and calls
//      sendEmailConfirmation; no surface has to remember to do it.
//   2. Changing a CONFIRMED address is approved FROM that address first (an
//      approval link), and only then does the new inbox get its confirmation
//      link. Fallback when the old inbox is gone: a code texted to the phone on
//      file (the site's "Text me a code"); over SMS, replying APPROVE from that
//      same phone is the identical proof.
//   3. Phone changes refuse an unconfirmed email (emailVerifiedForAccount).
// Profile fields (users for clients, caregivers for caregivers — a caregiver's
// users doc mirrors them): email, emailVerified, emailVerifiedAt,
// emailVerifiedFor (the exact address the flag is for), emailConfirmSentFor
// (the trigger's idempotency marker).

export type EmailRequestKind  = "initial" | "change";
export type EmailRequestStage = "awaiting_old_approval" | "awaiting_new_confirm";
export type EmailApprovalVia  = "old_email" | "phone_code" | "phone_reply";

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

export function profileCollectionFor(role: Role): "users" | "caregivers" {
  return role === "caregiver" ? "caregivers" : "users";
}

export async function resolveRole(uid: string): Promise<Role> {
  const cg = await db().collection("caregivers").doc(uid).get();
  return cg.exists ? "caregiver" : "client";
}

/** True only when the flag was set for the address currently on file. */
export function isEmailVerified(d: Record<string, unknown> | undefined | null): boolean {
  if (!d || d.emailVerified !== true) return false;
  const email = typeof d.email === "string" ? d.email.trim().toLowerCase() : "";
  const forEmail = typeof d.emailVerifiedFor === "string" ? d.emailVerifiedFor.trim().toLowerCase() : "";
  return !!email && email === forEmail;
}

export async function emailVerifiedForAccount(uid: string, role: Role): Promise<boolean> {
  const snap = await db().collection(profileCollectionFor(role)).doc(uid).get();
  return isEmailVerified(snap.data());
}

async function phoneForAccount(uid: string, role: Role): Promise<string | null> {
  const snap = await db().collection(profileCollectionFor(role)).doc(uid).get();
  const p = snap.data()?.phone;
  if (typeof p === "string" && p) return p;
  if (role === "caregiver") {
    const u = await db().collection("users").doc(uid).get();
    const up = u.data()?.phone;
    if (typeof up === "string" && up) return up;
  }
  return null;
}

// Text the account holder as Evia — but only once they've opted in (TCPA): a
// brand-new /start signup has an email on file before their first text.
async function textAccount(uid: string, role: Role, message: string): Promise<void> {
  try {
    const phone = await phoneForAccount(uid, role);
    if (!phone) return;
    const sess = await db().collection("agent_sessions").doc(phone).get();
    if (!sess.exists || sess.data()?.optedIn !== true) return;
    await sendSMS({ to: phone, message: `Evia: ${message}` });
  } catch (err) {
    console.warn("accountRecovery: account text failed", err instanceof Error ? err.message : err);
  }
}

async function bell(uid: string, type: string, title: string, body: string): Promise<void> {
  await db().collection("users").doc(uid).collection("notifications").add({
    userId: uid, type, title, body, data: {}, isRead: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});
}

// Session anchor so the family/caregiver can answer Evia's "reply APPROVE / NO"
// text (agents/emailChangeReply.ts reads it; 30 min like the request itself).
export const EMAIL_CHANGE_ANCHOR_TTL_MS = REQUEST_TTL_MS;
async function setEmailChangeAnchor(uid: string, role: Role, token: string): Promise<void> {
  const phone = await phoneForAccount(uid, role);
  if (!phone) return;
  await db().collection("agent_sessions").doc(phone).set({
    pendingEmailChangeToken: token,
    pendingEmailChangeSetAt: new Date().toISOString(),
  }, { merge: true }).catch(() => {});
}
export async function clearEmailChangeAnchor(uid: string, role: Role): Promise<void> {
  const phone = await phoneForAccount(uid, role);
  if (!phone) return;
  await db().collection("agent_sessions").doc(phone).update({
    pendingEmailChangeToken: admin.firestore.FieldValue.delete(),
    pendingEmailChangeSetAt: admin.firestore.FieldValue.delete(),
  }).catch(() => {});
}

async function loadPendingEmailRequest(token: string) {
  if (!token) throw new Error("Missing token");
  const ref = db().collection("email_change_requests").doc(token);
  const snap = await ref.get();
  const data = snap.data() as Record<string, unknown> | undefined;
  if (!snap.exists || !data || data.status !== "pending" || (data.expiresAt as number) < Date.now()) {
    throw new Error("This link is invalid or has expired.");
  }
  return { ref, data: data as { uid: string; role: Role; newEmail: string; oldEmail?: string | null; kind?: EmailRequestKind; stage?: EmailRequestStage; fallbackOtp?: OtpState | null } };
}

// One confirmation link to ONE inbox. Used for first entry (trigger), for a
// change whose old address was never confirmed, and as the second step of an
// approved change. Returns the token.
export async function sendEmailConfirmation(
  uid: string, role: Role, email: string, kind: EmailRequestKind,
  opts: { oldEmail?: string | null; approvedVia?: EmailApprovalVia | null } = {},
): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await db().collection("email_change_requests").doc(token).set({
    uid, role, newEmail: email, kind, stage: "awaiting_new_confirm",
    oldEmail: opts.oldEmail ?? null, approvedVia: opts.approvedVia ?? null,
    requestedAt: now, expiresAt: now + REQUEST_TTL_MS, status: "pending",
  });
  // Idempotency marker for the trigger; first entry also stamps the flag false
  // so the site can show "Not confirmed yet" (a change leaves the OLD address's
  // flag alone until the swap actually happens).
  await db().collection(profileCollectionFor(role)).doc(uid).set(
    { emailConfirmSentFor: email, ...(kind === "initial" ? { emailVerified: false } : {}) },
    { merge: true },
  );
  const verifyUrl = appLink(`/verify-email-change?token=${token}`);
  await sendTransactionalEmail({
    to: email,
    subject: kind === "initial" ? "Confirm your Evia recovery email" : "Confirm your new Evia email address",
    html: emailChangeConfirmHtml(verifyUrl),
  });
  await textAccount(uid, role, kind === "initial"
    ? `I sent a confirmation link to ${maskEmail(email)} — tap it when you can so your recovery email is confirmed. (Check Junk if it isn't there.)`
    : `I sent the confirmation link to ${maskEmail(email)}. Your recovery email changes the moment it's tapped.`);
  return token;
}

// The settings page's "Resend link" (and Evia's request_email_change resend).
export async function resendEmailConfirmation(uid: string): Promise<{ sentTo: string | null }> {
  const role = await resolveRole(uid);
  const snap = await db().collection(profileCollectionFor(role)).doc(uid).get();
  const d = (snap.data() ?? {}) as Record<string, unknown>;
  const email = typeof d.email === "string" ? d.email.trim() : "";
  if (!email) throw new Error("No recovery email on file");
  if (isEmailVerified(d)) return { sentTo: null };
  if (await isRateLimited("email_change_rate_limits", uid)) throw new Error("Please wait a minute before requesting another link.");
  await sendEmailConfirmation(uid, role, email, "initial");
  return { sentTo: email };
}

export interface EmailChangeStart { stage: EmailRequestStage; token: string; sentTo: string; oldEmail: string | null }

// ── requestEmailChangeSelf (Account Settings + Evia's request_email_change) ──
export async function requestEmailChangeSelf(uid: string, rawNewEmail: string): Promise<EmailChangeStart> {
  const newEmail = rawNewEmail.trim();
  if (!newEmail || !isValidEmail(newEmail)) throw new Error("Valid email required");
  if (await isRateLimited("email_change_rate_limits", uid)) throw new Error("Please wait a minute before requesting another link.");

  const role = await resolveRole(uid);
  const snap = await db().collection(profileCollectionFor(role)).doc(uid).get();
  const d = (snap.data() ?? {}) as Record<string, unknown>;
  const current = typeof d.email === "string" ? d.email.trim() : "";

  if (current && isEmailVerified(d) && current.toLowerCase() !== newEmail.toLowerCase()) {
    // Confirmed address on file → it approves first.
    const token = randomToken();
    const now = Date.now();
    await db().collection("email_change_requests").doc(token).set({
      uid, role, newEmail, oldEmail: current, kind: "change", stage: "awaiting_old_approval",
      approvedVia: null, fallbackOtp: null,
      requestedAt: now, expiresAt: now + REQUEST_TTL_MS, status: "pending",
    });
    const approveUrl = appLink(`/approve-email-change?token=${token}`);
    await sendTransactionalEmail({
      to: current,
      subject: "Approve a change to your Evia recovery email",
      html: emailChangeApprovalHtml(maskEmail(newEmail), approveUrl),
    });
    await textAccount(uid, role,
      `A request was just made to change your recovery email to ${maskEmail(newEmail)}. I emailed ${maskEmail(current)} to approve it. ` +
      `Can't open that inbox? Reply APPROVE and I'll use this phone as your proof instead. Wasn't you? Reply NO.`);
    await setEmailChangeAnchor(uid, role, token);
    return { stage: "awaiting_old_approval", token, sentTo: current, oldEmail: current };
  }

  // Nothing confirmed to anchor to → the new inbox's own link is the proof.
  const token = await sendEmailConfirmation(uid, role, newEmail, "change", { oldEmail: current || null, approvedVia: null });
  return { stage: "awaiting_new_confirm", token, sentTo: newEmail, oldEmail: current || null };
}

// Approval from the OLD address (link) or the phone (code / APPROVE reply):
// consumes the approval token and sends the new inbox its confirmation link.
export async function approveEmailChange(token: string, via: EmailApprovalVia = "old_email"): Promise<{ sentTo: string }> {
  const { ref, data } = await loadPendingEmailRequest(token);
  if (data.stage !== "awaiting_old_approval") throw new Error("This link is invalid or has expired.");
  await ref.update({ status: "consumed", approvedVia: via, approvedAt: Date.now() });
  await sendEmailConfirmation(data.uid, data.role, data.newEmail, "change", { oldEmail: data.oldEmail ?? null, approvedVia: via });
  await clearEmailChangeAnchor(data.uid, data.role);
  return { sentTo: data.newEmail };
}

// Site fallback when the old inbox is gone: a code to the phone on file.
export async function startEmailChangeFallback(token: string): Promise<void> {
  const { ref, data } = await loadPendingEmailRequest(token);
  if (data.stage !== "awaiting_old_approval") throw new Error("This link is invalid or has expired.");
  const phone = await phoneForAccount(data.uid, data.role);
  if (!phone) throw new Error("No phone number on file");
  const otp = generateOtp();
  await ref.update({ fallbackOtp: otp });
  const r = await sendSMS({ to: phone, message: `Evia: your code to approve the recovery email change is ${otp.code}. It expires in 15 minutes. If you didn't request this, reply NO.` });
  if (!r.success) throw new Error(r.error || "Could not text a code to the phone on file.");
}

export async function confirmEmailChangeFallback(token: string, code: string): Promise<{ sentTo: string }> {
  if (!code) throw new Error("Missing code");
  const { ref, data } = await loadPendingEmailRequest(token);
  if (data.stage !== "awaiting_old_approval" || !data.fallbackOtp) throw new Error("This link is invalid or has expired.");
  const result = verifyOtp(code, data.fallbackOtp);
  if (result.status !== "ok") {
    await ref.update({ fallbackOtp: { ...data.fallbackOtp, attempts: (data.fallbackOtp.attempts ?? 0) + 1 } });
    throw new Error(result.status === "wrong"
      ? "Incorrect code. Please try again."
      : "That code expired or too many attempts were made. Request a new one.");
  }
  return approveEmailChange(token, "phone_code");
}

// "NO" from the phone, or Cancel on the page: nothing changes.
export async function cancelEmailChange(token: string): Promise<void> {
  const { ref, data } = await loadPendingEmailRequest(token);
  await ref.update({ status: "cancelled", cancelledAt: Date.now() });
  await clearEmailChangeAnchor(data.uid, data.role);
}

// ── confirmEmailChange (the new inbox's link) ────────────────────────────────
export async function confirmEmailChange(token: string): Promise<void> {
  const { ref, data } = await loadPendingEmailRequest(token);
  // Legacy request docs (pre-2026-09-20) have no stage; anything staged must be
  // the new-inbox step — an approval token can never confirm an address.
  if (data.stage && data.stage !== "awaiting_new_confirm") throw new Error("This link is invalid or has expired.");

  const { uid, role, newEmail } = data;
  const kind: EmailRequestKind = data.kind ?? "change";
  const oldEmail = data.oldEmail ?? null;
  const verified = {
    email: newEmail,
    emailVerified: true,
    emailVerifiedAt: new Date().toISOString(),
    emailVerifiedFor: newEmail,
    emailConfirmSentFor: newEmail,
  };
  await db().collection(profileCollectionFor(role)).doc(uid).set(verified, { merge: true });
  if (role === "caregiver") await db().collection("users").doc(uid).set(verified, { merge: true }).catch(() => {});
  await ref.update({ status: "consumed" });

  const changed = kind === "change" && !!oldEmail && oldEmail.toLowerCase() !== newEmail.toLowerCase();
  await bell(uid, "account_email_confirmed",
    changed ? "Recovery email updated" : "Recovery email confirmed",
    `${newEmail} is now the confirmed recovery email on your account.`);
  await textAccount(uid, role, changed
    ? `Done — your recovery email is now ${maskEmail(newEmail)}.`
    : `Your recovery email ${maskEmail(newEmail)} is confirmed. Thanks!`);
  if (changed && oldEmail) {
    await sendTransactionalEmail({
      to: oldEmail,
      subject: "Your Evia recovery email was changed",
      html: emailChangedNoticeHtml(maskEmail(newEmail)),
    }).catch(() => {});
  }
}

// ── Expiry sweep ─────────────────────────────────────────────────────────────
// Same convention as the other short-lived-record sweepers (accountRecoveryExpiry,
// feedbackExpiry, objectiveExpirySweeper) — these tokens have no side effects
// to roll back on expiry (unlike a shift offer), so a stale one is just
// deleted rather than marked "expired" and kept.
export async function sweepExpiredAccountRecoveryRequests(): Promise<{ deleted: number }> {
  const now = Date.now();
  let deleted = 0;
  for (const collection of ["phone_change_requests", "email_change_requests"] as const) {
    const snap = await db().collection(collection).where("expiresAt", "<", now).get();
    for (const doc of snap.docs) {
      await doc.ref.delete().catch(() => {});
      deleted++;
    }
  }
  return { deleted };
}
