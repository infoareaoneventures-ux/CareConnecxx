// The caregiver Account Settings page, texted
// (components/caregiver/CaregiverAccountSettings.tsx — Account Basics,
// Membership & verification, Transportation Documents, Blocked Users, Pause, Delete).
//
// Same reads as the page: the merged profile (users + caregivers, the caregiver
// doc wins — dbService.getUser), the `documents.{type}` map with the page's own
// status rule (approved / expired by expirationDate / rejected / under review /
// not uploaded), users.blockedUsers + blockedUserProfiles, pausedUntil.
// Same buttons through the same server paths: Resend confirmation link =
// accountRecovery.resendEmailConfirmation (the page's queue action), Upload =
// the tokened /upload/transport page (writes the same documents map), Pause /
// Reactivate = pauseAccount.pauseCaregiver / reactivateCaregiver (the page's
// queue action), phone change / email change / gender / address / unblock /
// delete = the existing caregiver tools (update_caregiver_profile,
// request_email_change, set_block_status, delete_account).
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { DEFAULT_TZ } from "../utils/scheduledTime";
import { membershipSectionLines } from "./caregiverMembership";

const db = admin.firestore();

export const GENDER_OPTIONS = ["Male", "Female", "Non-binary", "Prefer not to say"];
export const TRANSPORT_DOCS: Array<{ type: "driversLicense" | "insurance" | "registration"; label: string }> = [
  { type: "driversLicense", label: "Driver's License" },
  { type: "insurance", label: "Vehicle Insurance" },
  { type: "registration", label: "Vehicle Registration" },
];
export type DocStatus = "idle" | "done" | "approved" | "expired" | "rejected";

export interface SettingsPage {
  memberSince: string | null;
  firstName: string; lastName: string;
  dob: string | null;
  gender: string | null;
  email: string | null; emailVerified: boolean;
  phone: string | null;
  address: { street: string; zip: string; city: string; state: string } | null;
  hasTransportation: boolean;
  documents: Array<{ type: string; label: string; status: DocStatus; expires: string | null; notes: string | null; renewal: "pending" | "rejected" | null; renewalNotes: string | null }>;
  blocked: string[];
  pausedUntil: string | null; isPaused: boolean;
  /** Membership & verification (AccountStandingSection) — the same loader the MEMBERSHIP keyword uses. */
  standing: import("./caregiverMembership").MembershipTab;
}

/** The page's toLocaleDateString() (en-US numeric). */
const numericDate = (d: Date) => new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric", year: "numeric", timeZone: DEFAULT_TZ }).format(d);
const ymdToLocal = (ymd: string): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return `${m}/${d}/${y}`;
};
const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  if (v instanceof Date) return v;
  const t = v as { toDate?: () => Date; seconds?: number };
  if (typeof t.toDate === "function") return t.toDate();
  if (typeof t.seconds === "number") return new Date(t.seconds * 1000);
  const ms = Date.parse(String(v)); return Number.isFinite(ms) ? new Date(ms) : null;
};
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The page's resolveDocStatus, verbatim. */
export function resolveDocStatus(doc: Record<string, unknown> | undefined | null, today = new Date()): DocStatus {
  if (!doc?.url) return "idle";
  if (doc.status === "approved") {
    const exp = str(doc.expirationDate);
    if (exp) {
      const [y, m, d] = exp.split("-").map(Number);
      const t = new Date(today); t.setHours(0, 0, 0, 0);
      if (new Date(y, m - 1, d) < t) return "expired";
    }
    return "approved";
  }
  if (doc.status === "rejected") return "rejected";
  return "done"; // uploaded, pending review
}

export async function loadSettingsPage(caregiverId: string): Promise<SettingsPage> {
  const [cgSnap, userSnap] = await Promise.all([
    db.collection("caregivers").doc(caregiverId).get(),
    db.collection("users").doc(caregiverId).get(),
  ]);
  const user = (userSnap.data() ?? {}) as Record<string, unknown>;
  const cg = (cgSnap.data() ?? {}) as Record<string, unknown>;
  const p = { ...user, ...cg } as Record<string, unknown>; // dbService.getUser: caregiver doc wins
  const name = str(p.name);
  // Member since = the account's creation (users/{uid}.createdAt, written at signup), then the
  // caregiver record's — the site's Settings reads the same (dbService.getUser accountCreatedAt). 2026-10-04.
  const created = toDate(user.createdAt) ?? toDate(cg.createdAt);
  const { isEmailVerified } = await import("../accountRecovery");
  const docs = (p.documents ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const services = (Array.isArray(p.skills) ? p.skills : Array.isArray(p.services) ? p.services : []) as string[];
  const blockedIds: string[] = Array.isArray(user.blockedUsers) ? (user.blockedUsers as string[]) : [];
  const blockedProfiles = (user.blockedUserProfiles ?? {}) as Record<string, { name?: string }>;
  const pausedUntil = str(p.pausedUntil) || null;
  const { loadMembershipTab } = await import("./caregiverMembership");
  const standing = await loadMembershipTab(caregiverId);
  const street = str(p.street) || str(p.streetAddress) || str(p.address);
  const zip = str(p.zipCode) || str(p.zip);
  const city = str(p.city); const state = str(p.state);
  return {
    memberSince: created ? numericDate(created) : null,
    firstName: str(p.firstName) || name.split(" ")[0] || "",
    lastName: str(p.lastName) || name.split(" ").slice(1).join(" ") || "",
    dob: str(p.dateOfBirth) || str(p.dob) || null,
    gender: str(p.gender) || null,
    email: str(p.email) || null,
    emailVerified: isEmailVerified(p),
    phone: str(p.phone) || null,
    address: street || zip || city || state ? { street, zip, city, state } : null,
    hasTransportation: services.includes("Transportation"),
    documents: TRANSPORT_DOCS.map(({ type, label }) => ({
      type, label, status: resolveDocStatus(docs[type]), expires: str(docs[type]?.expirationDate) || null, notes: str(docs[type]?.notes) || null,
      // Renewal slot (2026-10-05): a new file waiting beside the live approved document.
      renewal: ((docs[type]?.renewal as Record<string, unknown> | undefined)?.status === "pending" || (docs[type]?.renewal as Record<string, unknown> | undefined)?.status === "rejected")
        ? ((docs[type]?.renewal as Record<string, unknown>).status as "pending" | "rejected") : null,
      renewalNotes: str((docs[type]?.renewal as Record<string, unknown> | undefined)?.notes) || null,
    })),
    blocked: blockedIds.map((id) => blockedProfiles[id]?.name || "Blocked User"),
    pausedUntil,
    isPaused: !!pausedUntil && pausedUntil > new Date().toISOString(),
    standing,
  };
}

export const DOC_STATUS_TEXT: Record<DocStatus, string> = {
  approved: "Approved", expired: "Expired (re-upload)", rejected: "Rejected (re-upload)", done: "Under Review", idle: "Not uploaded",
};

export function settingsPageText(page: SettingsPage): string {
  // "not set", never "—": the send filter rewrites every em dash to a comma (safety/linter.ts), which turned "Last name: —" into "Last name:," (founder, 2026-10-04).
  const dash = (v: string | null | undefined) => (v && v.trim()) || "not set";
  const lines: string[] = ["Account Settings", ""];
  lines.push(`Account Basics · Member since ${dash(page.memberSince)}`);
  lines.push(`First name: ${dash(page.firstName)}`, `Last name: ${dash(page.lastName)}`, `Date of birth: ${dash(page.dob)}`);
  lines.push(`Gender: ${dash(page.gender)} (tell me to set it: ${GENDER_OPTIONS.join(", ")})`);
  lines.push(page.email
    ? `Recovery email: ${page.email} (${page.emailVerified ? "Confirmed" : "Not confirmed yet, reply RESEND EMAIL LINK"})`
    : "Recovery email: not set (tell me an email to add one)");
  lines.push(`Phone number: ${dash(page.phone)} (to change it, tell me, and a secure link goes to your recovery email)`);
  const a = page.address;
  const addr = a ? [a.street, [a.city, a.state].filter(Boolean).join(", "), a.zip].filter(Boolean).join(", ") : "";
  lines.push(`Address: ${dash(addr)} (tell me a new address to update it)`);
  // Membership & verification — moved here from Payments › Membership (2026-10-04).
  lines.push("", "Membership & verification", ...membershipSectionLines(page.standing));
  if (page.hasTransportation) {
    lines.push("", "Transportation Documents: required to offer Transportation. Keep these up to date.");
    const recordNotApproved = page.standing.driver === "not_approved";
    // The page's why-line when the driving record is Not approved (documents stay on file, no action asked).
    if (recordNotApproved) lines.push("Your driving record check didn't meet the requirement for Transportation jobs, so Transportation is off your profile. Your documents stay on file.");
    for (const d of page.documents) {
      const reason = d.status === "rejected" && d.notes ? ` (reason: ${d.notes})` : "";
      // Status only while the record is Not approved — no "(re-upload)" ask, same as the page.
      const statusText = (s: DocStatus, quiet: boolean) => (quiet ? DOC_STATUS_TEXT[s].replace(" (re-upload)", "") : DOC_STATUS_TEXT[s]);
      const renewalNote = d.status === "approved" && d.renewal === "pending" ? " · renewal under review, you stay on Transportation meanwhile"
        : d.status === "approved" && d.renewal === "rejected" ? ` · renewal rejected${d.renewalNotes ? ` (reason: ${d.renewalNotes})` : ""}, your current document stays on file until it expires` : "";
      lines.push(`${d.label}: ${statusText(d.status, recordNotApproved)}${reason}${d.expires && (d.status === "approved" || d.status === "expired") ? ` · Expires ${ymdToLocal(d.expires)}` : ""}${renewalNote}`);
    }
    if (!recordNotApproved) {
      if (page.documents.filter((d) => d.status === "done" || d.status === "approved").length < 3) {
        lines.push("All three documents are required to offer Transportation.");
      }
      lines.push("Reply DOCUMENTS for your upload link — a renewal uploaded over an approved document waits beside it, so you stay on Transportation while we review it.");
    }
  }
  lines.push("", page.blocked.length ? `Blocked Users: ${page.blocked.join(", ")} (tell me to unblock someone)` : "Blocked Users: You haven't blocked anyone.");
  lines.push("");
  if (page.isPaused) {
    const dated = page.pausedUntil && page.pausedUntil !== "2099-12-31";
    lines.push(`Your account is paused. ${dated ? `You'll automatically become active again on ${page.pausedUntil}. Reactivate sooner anytime.` : "You won't show up for new matches until you reactivate. Fully reversible anytime."} Reply REACTIVATE.`);
  } else {
    lines.push("Pause your account: taking a break? Stop showing up for new matches without deleting your profile. Reversible anytime. Reply PAUSE, or PAUSE 2026-11-01 to resume on a date.");
  }
  lines.push("", "Deleting your account is permanent and cannot be undone. To delete it, tell me and I'll confirm with you first.");
  return lines.join("\n");
}

export async function sendCaregiverSettings(chatId: string, caregiverId: string) {
  const page = await loadSettingsPage(caregiverId);
  // keepPii: the recovery email on this page is the caregiver's own — the send filter's
  // cross-user email redaction would strip its domain ("hamse143@", founder 2026-10-04).
  await sendMessage(chatId, { parts: [{ type: "text", value: settingsPageText(page), keepPii: true }] });
  return { sent: true, emailVerified: page.emailVerified, hasTransportation: page.hasTransportation, isPaused: page.isPaused, blockedCount: page.blocked.length };
}

/** The page's "Resend confirmation link" — the same server function its queue action calls. */
export async function sendResendEmailLink(chatId: string, caregiverId: string): Promise<boolean> {
  try {
    const { resendEmailConfirmation, maskEmail } = await import("../accountRecovery");
    const r = await resendEmailConfirmation(caregiverId);
    if (r.sentTo) { await sendMessage(chatId, `Confirmation link re-sent to ${maskEmail(r.sentTo)} — tap it from that inbox (check Junk too).`); return true; }
    await sendMessage(chatId, "Your recovery email is already confirmed — nothing to resend.");
    return false;
  } catch (err) {
    console.error("[caregiverSettings] resend email link failed:", err);
    await sendMessage(chatId, "I couldn't resend the confirmation link right now — reply RESEND EMAIL LINK again in a moment.");
    return false;
  }
}

/** The page's Upload buttons — the tokened upload page that writes the same documents map. Shown only when Transportation is offered, like the section. */
export async function sendDocumentsUploadLink(phone: string, chatId: string, caregiverId: string): Promise<boolean> {
  const page = await loadSettingsPage(caregiverId);
  if (!page.hasTransportation) {
    await sendMessage(chatId, "Transportation documents only apply when Transportation is one of your services — add it to your services first and I'll send the upload link.");
    return false;
  }
  try {
    const { runSendOnboardingLinkAction } = await import("./actions/sendOnboardingLinkAction");
    const r = await runSendOnboardingLinkAction({ phone, linkType: "caregiver_transport_docs" }, { caller: "sms_agent", role: "caregiver", phone });
    if (r.sent) return true;
    if (r.throttled) { await sendMessage(chatId, `Your upload link went out about ${r.minutesSinceLastSend ?? "a few"} minutes ago — tap that one, or reply LINK and I'll resend it.`); return false; }
  } catch (err) { console.error("[caregiverSettings] documents link failed:", err); }
  await sendMessage(chatId, "I couldn't generate your upload link right now — reply DOCUMENTS again in a moment.");
  return false;
}

/** The page's Pause account / Reactivate buttons — the same shared writes its queue action calls, the page's toasts. */
export async function pauseFromSettings(chatId: string, caregiverId: string, until?: string): Promise<boolean> {
  const { pauseCaregiver } = await import("./pauseAccount");
  await pauseCaregiver(caregiverId, until ?? "indefinite");
  await sendMessage(chatId, until
    ? `Account paused — you'll automatically become active again on ${until}.`
    : "Account paused — you won't be shown for new matches until you reactivate.");
  return true;
}
export async function reactivateFromSettings(chatId: string, caregiverId: string): Promise<boolean> {
  const { reactivateCaregiver } = await import("./pauseAccount");
  await reactivateCaregiver(caregiverId);
  await sendMessage(chatId, "You're active again — you'll start showing up for new matches.");
  return true;
}

// ── Keywords (routeCaregiver): SETTINGS · RESEND EMAIL LINK · DOCUMENTS · PAUSE [date] · REACTIVATE ──
export async function handleSettingsKeyword(phone: string, chatId: string, caregiverId: string, text: string): Promise<"handled" | "passthrough"> {
  const upper = text.trim().toUpperCase().replace(/\s+/g, " ");
  if (["SETTINGS", "MY SETTINGS", "ACCOUNT", "MY ACCOUNT", "ACCOUNT SETTINGS"].includes(upper)) { await sendCaregiverSettings(chatId, caregiverId); return "handled"; }
  if (["RESEND EMAIL LINK", "RESEND EMAIL", "RESEND CONFIRMATION"].includes(upper)) { await sendResendEmailLink(chatId, caregiverId); return "handled"; }
  if (["DOCUMENTS", "MY DOCUMENTS", "UPLOAD DOCUMENTS", "UPLOAD"].includes(upper)) { await sendDocumentsUploadLink(phone, chatId, caregiverId); return "handled"; }
  const pause = /^PAUSE(?: ACCOUNT)?(?: (\d{4}-\d{2}-\d{2}))?$/.exec(upper);
  if (pause) {
    const until = pause[1];
    if (until && until < new Date().toISOString().slice(0, 10)) { await sendMessage(chatId, "That date has already passed — give me a future date (YYYY-MM-DD), or reply PAUSE to pause until you reactivate."); return "handled"; }
    await pauseFromSettings(chatId, caregiverId, until); return "handled";
  }
  if (upper === "REACTIVATE" || upper === "REACTIVATE ACCOUNT" || upper === "UNPAUSE") { await reactivateFromSettings(chatId, caregiverId); return "handled"; }
  return "passthrough";
}
