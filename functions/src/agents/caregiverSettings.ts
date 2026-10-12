// The caregiver Account Settings page, texted
// (components/caregiver/CaregiverAccountSettings.tsx — Account Basics,
// Membership & verification, Blocked Users, Pause, Delete).
//
// Same reads as the page: the merged profile (users + caregivers, the caregiver
// doc wins — dbService.getUser), users.blockedUsers + blockedUserProfiles,
// pausedUntil. (The Transportation Documents section was retired 2026-10-06:
// Transportation = the service + the driving record, shown under Membership &
// verification.)
// Same buttons through the same server paths: Resend confirmation link =
// accountRecovery.resendEmailConfirmation (the page's queue action), Pause /
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

export interface SettingsPage {
  memberSince: string | null;
  firstName: string; lastName: string;
  dob: string | null;
  gender: string | null;
  email: string | null; emailVerified: boolean;
  phone: string | null;
  address: { street: string; zip: string; city: string; state: string } | null;
  hasTransportation: boolean;
  blocked: string[];
  pausedUntil: string | null; isPaused: boolean;
  /** Membership & verification (AccountStandingSection) — the same loader the MEMBERSHIP keyword uses. */
  standing: import("./caregiverMembership").MembershipTab;
}

/** The page's toLocaleDateString() (en-US numeric). */
const numericDate = (d: Date) => new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric", year: "numeric", timeZone: DEFAULT_TZ }).format(d);
const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  if (v instanceof Date) return v;
  const t = v as { toDate?: () => Date; seconds?: number };
  if (typeof t.toDate === "function") return t.toDate();
  if (typeof t.seconds === "number") return new Date(t.seconds * 1000);
  const ms = Date.parse(String(v)); return Number.isFinite(ms) ? new Date(ms) : null;
};
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

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
    blocked: blockedIds.map((id) => blockedProfiles[id]?.name || "Blocked User"),
    pausedUntil,
    isPaused: !!pausedUntil && pausedUntil > new Date().toISOString(),
    standing,
  };
}

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

/**
 * The page's Reactivate button — the same shared write its queue action calls, the page's toast.
 * (Pause parks the confirm flow — see handleSettingsKeyword.) The line below is this door's own
 * confirmation, so the write stamps the session (phone) and the lifecycle notice keeps the bell only (B7).
 */
export async function reactivateFromSettings(chatId: string, caregiverId: string, phone?: string): Promise<boolean> {
  const { reactivateCaregiver } = await import("./pauseAccount");
  await reactivateCaregiver(caregiverId, { phone });
  await sendMessage(chatId, "You're active again — you'll start showing up for new matches.");
  return true;
}

// ── Keywords (routeCaregiver): SETTINGS · RESEND EMAIL LINK · PAUSE [date] · REACTIVATE ──
export async function handleSettingsKeyword(phone: string, chatId: string, caregiverId: string, text: string): Promise<"handled" | "passthrough"> {
  const upper = text.trim().toUpperCase().replace(/\s+/g, " ");
  if (["SETTINGS", "MY SETTINGS", "ACCOUNT", "MY ACCOUNT", "ACCOUNT SETTINGS"].includes(upper)) { await sendCaregiverSettings(chatId, caregiverId); return "handled"; }
  if (["RESEND EMAIL LINK", "RESEND EMAIL", "RESEND CONFIRMATION"].includes(upper)) { await sendResendEmailLink(chatId, caregiverId); return "handled"; }
  // PAUSE never writes on the keyword alone (caregiver sweep A6, 2026-10-11):
  // it parks the SAME pause flow the tool/intent path uses (caregiverProfileHandler
  // handlePauseAccount) — bare PAUSE asks until when, PAUSE <date> asks YES/NO —
  // so every door confirms before pauseCaregiver writes. REACTIVATE stays
  // immediate (nothing is lost by reactivating).
  const pause = /^PAUSE(?: ACCOUNT)?(?: (\d{4}-\d{2}-\d{2}))?$/.exec(upper);
  if (pause) {
    const until = pause[1];
    if (until && until < new Date().toISOString().slice(0, 10)) { await sendMessage(chatId, "That date has already passed — give me a future date (YYYY-MM-DD), or reply PAUSE to pause until you reactivate."); return "handled"; }
    const stateExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    if (!until) {
      await db.collection("agent_sessions").doc(phone).update({ profileUpdateStep: "collect", profileUpdateField: "pause", stateExpiresAt });
      await sendMessage(chatId, "When would you like to pause until? (e.g. \"until July 12\", \"for two weeks\", \"indefinitely\")");
      return "handled";
    }
    await db.collection("agent_sessions").doc(phone).update({ profileUpdateStep: "confirm", profileUpdateField: "pause", profileUpdateValue: until, stateExpiresAt });
    await sendMessage(chatId, `Pause your account until ${until}? You won't receive job matches during this time. Reply YES to pause, or NO to cancel.`);
    return "handled";
  }
  if (upper === "REACTIVATE" || upper === "REACTIVATE ACCOUNT" || upper === "UNPAUSE") { await reactivateFromSettings(chatId, caregiverId, phone); return "handled"; }
  return "passthrough";
}
