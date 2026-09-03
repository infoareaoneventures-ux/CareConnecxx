import * as admin from "firebase-admin";
import * as crypto from "crypto";
import {
  sendTransactionalEmail,
  phoneChangeRequestHtml,
  phoneChangeConfirmedHtml,
  emailChangeConfirmHtml,
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
// Email-change is gated the same way, one step shorter (no OTP — clicking the
// link IS the proof of owning the new inbox):
//   requestEmailChangeSelf (auth'd) — new email in, confirmation email out
//   confirmEmailChange              — token in, writes the new email

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

async function updateFamilyGroupPhoneReferences(oldPhone: string, newPhone: string): Promise<void> {
  // Best-effort — a family group's roster is a convenience index, not the
  // source of truth, so a failure here must never block the phone change.
  try {
    const groupsSnap = await db().collection("family_group_members")
      .where("phones", "array-contains", oldPhone).get();
    for (const doc of groupsSnap.docs) {
      await doc.ref.update({
        phones: admin.firestore.FieldValue.arrayRemove(oldPhone),
      });
      await doc.ref.update({
        phones: admin.firestore.FieldValue.arrayUnion(newPhone),
      });
    }
    const membersSnap = await db().collection("family_group_members")
      .where("phone", "==", oldPhone).get();
    for (const doc of membersSnap.docs) {
      await doc.ref.update({ phone: newPhone });
    }
  } catch (err) {
    console.error("updateFamilyGroupPhoneReferences:", err);
  }
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
    await updateFamilyGroupPhoneReferences(oldPhone, newPhone);
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

// Core logic shared by the website's email-change request flow and Evia's
// request_email_change MCP tool — one place creates the request doc and
// sends the confirmation email. Callers are responsible for auth/ownership
// checks and any duplicate-email validation before calling this.
export async function requestEmailChangeForAccount(uid: string, role: Role, newEmail: string): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  await db().collection("email_change_requests").doc(token).set({
    uid, role, newEmail,
    requestedAt: now,
    expiresAt: now + REQUEST_TTL_MS,
    status: "pending",
  });

  const verifyUrl = appLink(`/verify-email-change?token=${token}`);
  await sendTransactionalEmail({
    to: newEmail,
    subject: "Confirm your new Evia email address",
    html: emailChangeConfirmHtml(verifyUrl),
  });
}

// ── requestEmailChangeSelf (website's Account Settings entry point, auth'd) ──
export async function requestEmailChangeSelf(uid: string, rawNewEmail: string): Promise<void> {
  const newEmail = rawNewEmail.trim();
  if (!newEmail || !isValidEmail(newEmail)) throw new Error("Valid email required");
  if (await isRateLimited("email_change_rate_limits", uid)) return;

  const caregiverSnap = await db().collection("caregivers").doc(uid).get();
  const role: Role = caregiverSnap.exists ? "caregiver" : "client";
  await requestEmailChangeForAccount(uid, role, newEmail);
}

// ── confirmEmailChange ───────────────────────────────────────────────────────
export async function confirmEmailChange(token: string): Promise<void> {
  if (!token) throw new Error("Missing token");

  const ref = db().collection("email_change_requests").doc(token);
  const snap = await ref.get();
  const reqData = snap.data();
  if (!snap.exists || !reqData || reqData.status !== "pending" || (reqData.expiresAt as number) < Date.now()) {
    throw new Error("This link is invalid or has expired.");
  }

  const { uid, role, newEmail } = reqData as { uid: string; role: Role; newEmail: string };
  const collection = role === "caregiver" ? "caregivers" : "users";
  await db().collection(collection).doc(uid).set({ email: newEmail }, { merge: true });
  await ref.update({ status: "consumed" });
}

// ── Expiry sweep ─────────────────────────────────────────────────────────────
// Same convention as the other short-lived-record sweepers (shiftOfferExpiry,
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
