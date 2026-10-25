// ── Name binding: the profile name is the verified legal name (2026-10-24) ─────
//
// Founder: Imran's background check cleared against the legal name he typed on
// the consent page while his profile had no last name at all — nothing ever
// compared the two. Same gap on the family side with the Stripe identity check.
//
// The rule, both sides, like every marketplace that verifies people:
//   1. the verified legal name (Checkr candidate / Stripe ID document) is
//      compared with the account name when the result comes back;
//   2. a match flips the status as before and LOCKS the name (nameLocked);
//   3. a mismatch HOLDS the approval: nameReview on the record, an admin alert,
//      a text + bell to the person; the admin decides from the person's page —
//      "Use the verified name" (the profile name becomes the legal name) or
//      "Keep the account name" (with a reason) — and the held approval is then
//      applied exactly as the webhook would have.
// Evia and the site both read the lock: a locked name is never edited by the
// person (firestore.rules + the API seam); only an admin, with an audit entry.
import * as admin from "firebase-admin";
import { logAudit } from "./observability/auditLog";
import { readCaregiverBackgroundPII } from "./caregiverPrivate";
import { sendToPhone } from "./linq/client";
import { writeUserNotification } from "./notifications/userNotification";

const db = admin.firestore();

export type NameSource = "checkr" | "stripe_identity";
export interface NameReview {
  status: "mismatch" | "resolved";
  source: NameSource;
  accountName: string;
  verifiedFirst: string;
  verifiedLast: string;
  at: string;
  resolvedAt?: string;
  resolvedBy?: { uid: string; name: string };
  decision?: "use_verified" | "keep_account";
  reason?: string;
}

/** Lower-case, accents and punctuation stripped, spaces collapsed — "O'Neil-Smith " and "oneil smith" compare equal. */
export function normalizeName(s: unknown): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

export function splitAccountName(name: unknown): { first: string; last: string } {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** First AND last must match after normalization; a missing or initial-only last name never matches. */
export function namesMatch(account: { first: string; last: string }, verified: { first: string; last: string }): boolean {
  const af = normalizeName(account.first), al = normalizeName(account.last);
  const vf = normalizeName(verified.first), vl = normalizeName(verified.last);
  if (!af || !al || !vf || !vl) return false;
  if (al.replace(/ /g, "").length < 2) return false;
  return af === vf && al === vl;
}

export function fullName(first: string, last: string): string {
  return [first, last].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
}

/** The legal name the care provider typed at consent (caregivers/{uid}/private/background). */
export async function caregiverVerifiedName(uid: string): Promise<{ first: string; last: string } | null> {
  const pii = await readCaregiverBackgroundPII(uid).catch(() => ({} as Record<string, unknown>));
  const first = String((pii as Record<string, unknown>).legalFirstName ?? "").trim();
  const last = String((pii as Record<string, unknown>).legalLastName ?? "").trim();
  return first || last ? { first, last } : null;
}

const HOLD_TEXT = (role: "caregiver" | "client", verified: string, account: string) =>
  `Your ${role === "caregiver" ? "background check" : "ID check"} came back. One thing before ${role === "caregiver" ? "you're live" : "you're all set"}: the name on it (${verified}) doesn't match the name on your account (${account}). Our team is checking and will text you — nothing to do right now.`;

/** Hold the approval and tell everyone: the record, the team, the person. */
export async function holdNameMismatch(input: {
  uid: string; role: "caregiver" | "client"; source: NameSource; phone?: string;
  accountName: string; verifiedFirst: string; verifiedLast: string;
}): Promise<NameReview> {
  const now = new Date().toISOString();
  const review: NameReview = { status: "mismatch", source: input.source, accountName: input.accountName, verifiedFirst: input.verifiedFirst, verifiedLast: input.verifiedLast, at: now };
  const col = input.role === "caregiver" ? "caregivers" : "users";
  await db.collection(col).doc(input.uid).set({ nameReview: review }, { merge: true });
  if (input.role === "caregiver") await db.collection("users").doc(input.uid).set({ nameReview: review }, { merge: true }).catch(() => {});
  const verified = fullName(input.verifiedFirst, input.verifiedLast);
  await db.collection("admin_alerts").add({
    type: "name_mismatch", severity: "high", priority: "high",
    userId: input.uid, role: input.role, phone: input.phone ?? null,
    message: `${input.accountName || "An account with no name"} (${input.role === "caregiver" ? "care provider" : "client"}): the ${input.source === "checkr" ? "background check" : "ID check"} cleared as "${verified}" but the account says "${input.accountName || "—"}". Approval is on hold — decide from their admin page.`,
    source: "name_binding", createdAt: now, resolved: false,
  }).catch((err) => console.warn("name_mismatch alert failed", err instanceof Error ? err.message : err));
  await writeUserNotification({
    sourcePath: `${col}/${input.uid}`, eventId: `name_mismatch_${now}`, recipientId: input.uid, transitionType: "name_mismatch",
    type: "account", title: "One thing before you're approved", body: `The name on your ${input.source === "checkr" ? "background check" : "ID"} (${verified}) doesn't match your account (${input.accountName || "no name"}). Our team is checking.`,
  }).catch(() => {});
  if (input.phone) await sendToPhone(input.phone, HOLD_TEXT(input.role, verified, input.accountName || "no name on file")).catch(() => {});
  await logAudit({ eventType: "name_mismatch_held", userId: input.uid, ...(input.phone ? { phone: input.phone } : {}), data: { source: input.source, accountName: input.accountName, verifiedName: verified } });
  return review;
}

/** The webhook's own clear fields for a care provider, applied later by the admin's decision. */
export async function finishCaregiverClear(uid: string): Promise<void> {
  const now = new Date().toISOString();
  const cg = (await db.collection("caregivers").doc(uid).get()).data() ?? {};
  const updates: Record<string, unknown> = {
    verified: true, verificationStatus: "approved", status: "active", approvedAt: now,
    backgroundCheckStatus: "clear", backgroundCheckComplete: true, "backgroundCheckData.checkrClearedAt": now,
  };
  if ((cg.renewalRefresh as Record<string, unknown> | undefined)?.status === "running") updates["renewalRefresh.status"] = "cleared";
  if (cg.mvrPaid === true) { updates.isApprovedDriver = true; updates.mvrStatus = "clear"; updates.mvrClearedAt = now; }
  await db.collection("caregivers").doc(uid).update(updates);
  const phone = typeof cg.phone === "string" ? cg.phone : undefined;
  if (phone) {
    try {
      const { advanceOnboardingStep } = await import("./agents/onboardingConversation");
      await advanceOnboardingStep(phone, "background_check", "");
      await db.collection("agent_sessions").doc(phone).update({ pendingBgCheckAck: "clear", pendingBgCheckAckSetAt: now }).catch(() => {});
    } catch (err) { console.error("finishCaregiverClear: session advance failed", err instanceof Error ? err.message : err); }
  }
}

/** The identity webhook's own verified fields for a family, applied later by the admin's decision. */
export async function finishClientIdentityVerified(uid: string): Promise<void> {
  await db.collection("users").doc(uid).set({ identityCheckStatus: "verified", identityVerifiedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  try {
    const { advanceEviaSessionForUid } = await import("./stripe");
    await advanceEviaSessionForUid(uid, "client_awaiting_identity", "identity", "");
  } catch (err) { console.error("finishClientIdentityVerified: session advance failed", err instanceof Error ? err.message : err); }
}

/** The admin's decision on a held name: the profile name becomes the legal name, or the account name is kept with a reason. */
export async function applyNameDecision(input: {
  uid: string; role: "caregiver" | "client"; decision: "use_verified" | "keep_account"; reason?: string; adminUid: string; adminName: string;
}): Promise<void> {
  const col = input.role === "caregiver" ? "caregivers" : "users";
  const doc = (await db.collection(col).doc(input.uid).get()).data() ?? {};
  const review = doc.nameReview as NameReview | undefined;
  if (!review || review.status !== "mismatch") throw new Error("Nothing is waiting on a name decision for this account");
  if (input.decision === "keep_account" && !String(input.reason ?? "").trim()) throw new Error("A reason is required to keep the account name");
  const now = new Date().toISOString();
  const resolved: NameReview = { ...review, status: "resolved", resolvedAt: now, resolvedBy: { uid: input.adminUid, name: input.adminName }, decision: input.decision, ...(input.reason ? { reason: input.reason.trim() } : {}) };
  const legal = fullName(review.verifiedFirst, review.verifiedLast);
  const nameFields: Record<string, unknown> = input.decision === "use_verified"
    ? (input.role === "caregiver" ? { name: legal } : { firstName: review.verifiedFirst, lastName: review.verifiedLast, name: legal, displayName: legal })
    : {};
  await db.collection(col).doc(input.uid).set({ ...nameFields, nameLocked: true, verifiedLegalName: legal, nameReview: resolved }, { merge: true });
  if (input.role === "caregiver") await db.collection("users").doc(input.uid).set({ ...(input.decision === "use_verified" ? { name: legal, displayName: legal } : {}), nameLocked: true, verifiedLegalName: legal, nameReview: resolved }, { merge: true }).catch(() => {});
  if (input.decision === "use_verified") await admin.auth().updateUser(input.uid, { displayName: legal }).catch(() => {});
  const phone = typeof doc.phone === "string" ? doc.phone : undefined;
  const text = input.decision === "use_verified"
    ? `Your name on file is now ${legal}, matching your ${review.source === "checkr" ? "background check" : "ID"}. You're all set on that.`
    : `Our team confirmed the name on your account (${review.accountName}). You're all set on that.`;
  if (phone) await sendToPhone(phone, text).catch(() => {});
  await writeUserNotification({ sourcePath: `${col}/${input.uid}`, eventId: `name_decided_${now}`, recipientId: input.uid, transitionType: "name_decided", type: "account", title: "Your name on file", body: text }).catch(() => {});
  await logAudit({ eventType: "name_decided", userId: input.uid, ...(phone ? { phone } : {}), data: { decision: input.decision, reason: input.reason ?? null, legalName: legal, accountName: review.accountName, adminUid: input.adminUid, adminName: input.adminName, source: review.source } });
  // Now the held approval, exactly as the webhook would have applied it.
  if (review.source === "checkr") await finishCaregiverClear(input.uid);
  else await finishClientIdentityVerified(input.uid);
}
