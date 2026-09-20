import * as functions from "firebase-functions/v1";

// Recovery-email confirmation at first entry (founder decision 2026-09-20).
// The address reaches the profile from several surfaces — the /start signup
// page (createWebOnboardingSession), Evia's client onboarding
// (persistClientCareRecords), Evia's caregiver finalize, both Account Settings
// pages' confirmed changes — so the ONE place that decides "this address has
// not been confirmed yet, send the link" is this write trigger, not each
// writer. accountRecovery.ts's sendEmailConfirmation does the actual work
// (token doc + email + Evia text once the phone has opted in) and stamps
// emailConfirmSentFor, which is what makes the re-fire on its own write a no-op.
//
// Canonical doc per role: users/{uid} for clients, caregivers/{uid} for
// caregivers (a caregiver's users doc only mirrors, so the users trigger skips
// userType === "caregiver").

type Role = "client" | "caregiver";

const lc = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** The address that still needs a confirmation link, or null. */
export function emailNeedingConfirmation(after: Record<string, unknown>): string | null {
  const email = typeof after.email === "string" ? after.email.trim() : "";
  if (!email) return null;
  const key = email.toLowerCase();
  if (after.emailVerified === true && lc(after.emailVerifiedFor) === key) return null; // confirmed for this exact address
  if (lc(after.emailConfirmSentFor) === key) return null;                              // link already out for it
  return email;
}

/** Nothing this trigger cares about changed between the two snapshots. */
export function emailStateUnchanged(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return lc(before.email) === lc(after.email)
    && before.emailVerified === after.emailVerified
    && lc(before.emailVerifiedFor) === lc(after.emailVerifiedFor)
    && lc(before.emailConfirmSentFor) === lc(after.emailConfirmSentFor);
}

async function handleProfileWrite(role: Role, change: functions.Change<functions.firestore.DocumentSnapshot>): Promise<void> {
  if (!change.after.exists) return;
  const after = (change.after.data() ?? {}) as Record<string, unknown>;
  const before = change.before.exists ? ((change.before.data() ?? {}) as Record<string, unknown>) : {};
  if (role === "client" && after.userType === "caregiver") return;
  const email = emailNeedingConfirmation(after);
  if (!email) return;
  if (change.before.exists && emailStateUnchanged(before, after)) return;
  const uid = change.after.id;
  try {
    const { sendEmailConfirmation } = await import("../accountRecovery");
    await sendEmailConfirmation(uid, role, email, "initial");
    console.info("emailConfirmation: confirmation link sent", { uid, role });
  } catch (err) {
    console.error("emailConfirmation: send failed", { uid, role, err: err instanceof Error ? err.message : String(err) });
  }
}

export const onUserEmailWrite = functions.firestore
  .document("users/{uid}")
  .onWrite((change) => handleProfileWrite("client", change));

export const onCaregiverEmailWrite = functions.firestore
  .document("caregivers/{uid}")
  .onWrite((change) => handleProfileWrite("caregiver", change));

