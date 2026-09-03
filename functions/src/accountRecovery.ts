import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
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

// Account phone-number change/recovery, gated by the email already on file —
// see docs context for the full design. Login here is phone-OTP only, so this
// email round-trip is the only recovery path when the phone itself is lost,
// and (for a logged-in change too) the thing standing between "I have UI
// access right now" and actually taking over someone's login number.
//
// Three callables carry the phone flow:
//   requestPhoneChange            — email in, verification email out (always
//                                    responds success, never reveals whether
//                                    the email matched an account)
//   startPhoneChangeVerification  — token + new phone in, OTP texted to the
//                                    new number (typo-catch, not the security
//                                    boundary — the email step already gated
//                                    access)
//   confirmPhoneChange            — token + code in, does the actual swap
//
// Email-change on Account Settings is gated the same way, one step shorter
// (no OTP — clicking the link IS the proof of owning the new inbox):
//   requestEmailChange (auth'd)   — new email in, confirmation email out
//   confirmEmailChange            — token in, writes the new email

const db = () => admin.firestore();

const REQUEST_TTL_MS = 30 * 60 * 1000; // 30 min
const RATE_LIMIT_MS = 60 * 1000;

type Role = "client" | "caregiver";

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

// Core logic shared by the website's requestPhoneChange callable (looks the
// account up by email) and Evia's request_phone_number_change MCP tool (the
// account is already known, so it hands the email straight through). Both
// paths converge here so there is exactly one place that creates the request
// doc and sends the email.
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

// ── requestPhoneChange ───────────────────────────────────────────────────────
export const requestPhoneChange = functions.https.onCall(async (data) => {
  const email = typeof data?.email === "string" ? data.email.trim() : "";
  if (!email || !isValidEmail(email)) {
    throw new functions.https.HttpsError("invalid-argument", "Valid email required");
  }

  // Anti-enumeration: this callable always resolves {success:true} — the
  // caller can never tell whether the email matched an account, was rate
  // limited, or the send failed. Only the pending-request side effects differ.
  if (await isRateLimited("phone_change_rate_limits", email.toLowerCase())) {
    return { success: true };
  }

  try {
    const account = await findAccountByEmail(email);
    if (!account) return { success: true };
    await requestPhoneChangeForAccount(account, email);
  } catch (err) {
    console.error("requestPhoneChange:", err);
  }

  return { success: true };
});

// ── startPhoneChangeVerification ────────────────────────────────────────────
export const startPhoneChangeVerification = functions.https.onCall(async (data) => {
  const token = typeof data?.token === "string" ? data.token : "";
  const newPhone = typeof data?.newPhone === "string" ? data.newPhone : "";
  if (!token) throw new functions.https.HttpsError("invalid-argument", "Missing token");
  if (!/^\+1\d{10}$/.test(newPhone)) {
    throw new functions.https.HttpsError("invalid-argument", "Phone must be in E.164 format (+1XXXXXXXXXX)");
  }

  const ref = db().collection("phone_change_requests").doc(token);
  const snap = await ref.get();
  const reqData = snap.data();
  if (!snap.exists || !reqData || reqData.status !== "pending" || (reqData.expiresAt as number) < Date.now()) {
    throw new functions.https.HttpsError("failed-precondition", "This link is invalid or has expired.");
  }

  const otp = generateOtp();
  await ref.update({ newPhone, otp });

  const smsResult = await sendSMS({
    to: newPhone,
    message: `Your Evia verification code is ${otp.code}. It expires in 15 minutes.`,
  });
  if (!smsResult.success) {
    throw new functions.https.HttpsError("internal", smsResult.error || "Could not send a verification code to that number.");
  }

  return { success: true };
});

// ── confirmPhoneChange ───────────────────────────────────────────────────────
export const confirmPhoneChange = functions.https.onCall(async (data) => {
  const token = typeof data?.token === "string" ? data.token : "";
  const code = typeof data?.code === "string" ? data.code : "";
  if (!token || !code) throw new functions.https.HttpsError("invalid-argument", "Missing token or code");

  const ref = db().collection("phone_change_requests").doc(token);
  const snap = await ref.get();
  const reqData = snap.data();
  if (!snap.exists || !reqData || reqData.status !== "pending" || (reqData.expiresAt as number) < Date.now() || !reqData.newPhone) {
    throw new functions.https.HttpsError("failed-precondition", "This link is invalid or has expired.");
  }

  const otpState = reqData.otp as OtpState | undefined;
  const result = verifyOtp(code, otpState);
  if (result.status !== "ok") {
    if (otpState) {
      await ref.update({ otp: { ...otpState, attempts: (otpState.attempts ?? 0) + 1 } });
    }
    const message = result.status === "wrong"
      ? "Incorrect code. Please try again."
      : "That code expired or too many attempts were made. Request a new one.";
    throw new functions.https.HttpsError("invalid-argument", message);
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

  return { success: true };
});

// Core logic shared by the website's requestEmailChange callable and Evia's
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

// ── requestEmailChange (auth required — only reachable from Account Settings) ─
export const requestEmailChange = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }
  const newEmail = typeof data?.newEmail === "string" ? data.newEmail.trim() : "";
  if (!newEmail || !isValidEmail(newEmail)) {
    throw new functions.https.HttpsError("invalid-argument", "Valid email required");
  }

  const uid = context.auth.uid;
  if (await isRateLimited("email_change_rate_limits", uid)) {
    return { success: true };
  }

  const caregiverSnap = await db().collection("caregivers").doc(uid).get();
  const role: Role = caregiverSnap.exists ? "caregiver" : "client";
  await requestEmailChangeForAccount(uid, role, newEmail);

  return { success: true };
});

// ── confirmEmailChange ───────────────────────────────────────────────────────
export const confirmEmailChange = functions.https.onCall(async (data) => {
  const token = typeof data?.token === "string" ? data.token : "";
  if (!token) throw new functions.https.HttpsError("invalid-argument", "Missing token");

  const ref = db().collection("email_change_requests").doc(token);
  const snap = await ref.get();
  const reqData = snap.data();
  if (!snap.exists || !reqData || reqData.status !== "pending" || (reqData.expiresAt as number) < Date.now()) {
    throw new functions.https.HttpsError("failed-precondition", "This link is invalid or has expired.");
  }

  const { uid, role, newEmail } = reqData as { uid: string; role: Role; newEmail: string };
  const collection = role === "caregiver" ? "caregivers" : "users";
  await db().collection(collection).doc(uid).set({ email: newEmail }, { merge: true });
  await ref.update({ status: "consumed" });

  return { success: true };
});

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
