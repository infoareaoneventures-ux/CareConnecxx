// The website's Account Settings page (components/client/AccountSettings.tsx,
// /client/account) as data — the Account Basics rows in the page's order
// (Profile photo, Name + Joined, Membership plan, Identity check, Recovery
// email, Mobile phone, Location), Blocked Users, and Delete account — read
// from the same places the page reads them: Firebase Auth (name, email,
// creation time, Google link) over the users doc, the Membership page's own
// subscription record, and users.blockedUsers / blockedUserProfiles. Each row
// names the Evia tool that is the page's Edit for it.
// Built 2026-09-19 (Account Settings parity).
import * as admin from "firebase-admin";
import { readMembershipPage, MembershipPage } from "./membershipPage";

export interface AccountSettingsInput {
  uid: string;
  auth: { displayName?: string | null; email?: string | null; creationTime?: string | null; photoURL?: string | null; googleEmail?: string | null } | null;
  doc: Record<string, unknown>;
  membership: MembershipPage;
}

export interface AccountSettingsPage {
  photoURL: string | null;
  name: string;
  joined: string | null;           // MM/DD/YYYY as the page prints it
  membership: { label: string; actions: MembershipPage["actions"] };
  identity: { status: "verified" | "processing" | "pending" | "requires_input" | "canceled" | "not_started"; label: string };
  recoveryEmail: string | null;
  googleEmail: string | null;
  phone: string | null;
  location: { street: string; city: string; state: string; zip: string; label: string } | null;
  blockedUsers: Array<{ id: string; name: string }>;
  /** The page's controls, each with the Evia tool that is that control. */
  actions: Array<{ id: string; label: string; tool: string; note?: string }>;
  summary: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const isPhotoUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v.trim());

function fmtJoined(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

export function shapeAccountSettingsPage(input: AccountSettingsInput): AccountSettingsPage {
  const { auth, doc, membership } = input;
  // Name: Auth displayName, else the doc (displayName → firstName → name), as the page falls back.
  const docName = str(doc.displayName) || str(doc.firstName) || str(doc.name) || "";
  const docFull = str(doc.displayName) || [str(doc.firstName), str(doc.lastName)].filter(Boolean).join(" ") || docName;
  const name = (str(auth?.displayName) || docFull || "—").trim();
  const photoURL = [auth?.photoURL, doc.photoURL, doc.photo, doc.profilePhoto].find(isPhotoUrl) ?? null;
  // Recovery email: Auth email (Google/email signups), else users.email (phone-OTP signups — 2026-09-19 fix).
  const recoveryEmail = str(auth?.email) || str(doc.email);
  const phone = str(doc.phone);
  const flatStreet = str(doc.street), flatZip = str(doc.zipCode), flatCity = str(doc.city), flatState = str(doc.state);
  const legacy = (doc.careLocation ?? null) as Record<string, unknown> | null;
  const loc = (flatStreet || flatZip || flatCity || flatState)
    ? { street: flatStreet ?? "", zip: flatZip ?? "", city: flatCity ?? "", state: flatState ?? "" }
    : legacy ? { street: str(legacy.address) ?? "", zip: str(legacy.zip) ?? "", city: str(legacy.city) ?? "", state: str(legacy.state) ?? "" } : null;
  const location = loc && (loc.street || loc.city || loc.zip)
    ? { ...loc, label: [loc.street, [loc.city, loc.state].filter(Boolean).join(", ") + (loc.zip ? ` ${loc.zip}` : "")].filter(Boolean).join(", ") }
    : null;

  const rawIdentity = str(doc.identityCheckStatus) ?? "not_started";
  const identityStatus = (["verified", "processing", "pending", "requires_input", "canceled"].includes(rawIdentity) ? rawIdentity : "not_started") as AccountSettingsPage["identity"]["status"];
  const identityLabel = identityStatus === "verified" ? "Identity Verified"
    : identityStatus === "processing" || identityStatus === "pending" ? "Verification in progress"
      : "Complete an identity check";

  const blockedIds = Array.isArray(doc.blockedUsers) ? (doc.blockedUsers as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const profiles = (doc.blockedUserProfiles ?? {}) as Record<string, { name?: string }>;
  const blockedUsers = blockedIds.map((id) => ({ id, name: str(profiles[id]?.name) ?? "Blocked User" }));

  const membershipLabel = membership.isActive
    ? `${membership.plan.name} · ${membership.cancelScheduled ? "ends" : "renews"} ${membership.periodEnd ?? "—"}`
    : "None";

  const actions: AccountSettingsPage["actions"] = [
    { id: "upload_photo", label: "Upload photo", tool: "update_user_profile", note: "photoFromMessage: true with the photo they attached" },
    membership.isActive
      ? { id: "manage_membership", label: "Manage", tool: "get_membership_page", note: "cancel/reactivate = set_subscription_status; card = get_payment_update_link" }
      : { id: "add_plan", label: "Add a plan", tool: "send_onboarding_link", note: "linkType client_payment" },
    ...(identityStatus === "verified" ? [] : [{ id: "identity_check", label: identityLabel, tool: "send_onboarding_link", note: "linkType client_identity" }]),
    { id: "edit_email", label: "Edit recovery email", tool: "request_email_change", note: "sends a confirmation link to the NEW address; nothing changes until it is clicked" },
    { id: "edit_phone", label: "Edit mobile phone", tool: "update_user_profile", note: recoveryEmail ? "requestPhoneChange: true — a secure link goes to the recovery email" : "blocked: set a recovery email first (the page says the same)" },
    { id: "edit_location", label: "Edit location", tool: "update_user_profile", note: "address / city / state / zip" },
    ...(blockedUsers.length ? [{ id: "unblock", label: "Unblock", tool: "set_block_status", note: "action unblock with the blocked user's id" }] : []),
    { id: "delete_account", label: "Delete account", tool: "delete_account", note: "permanent; confirm explicitly first" },
  ];

  const parts = [
    `Name: ${name}${input.auth?.creationTime ? ` (joined ${fmtJoined(input.auth.creationTime)})` : ""}.`,
    `Profile photo: ${photoURL ? "set" : "none"}.`,
    `Membership plan: ${membershipLabel}.`,
    `Identity check: ${identityLabel}.`,
    `Recovery email: ${recoveryEmail ?? "Not set"}.`,
    `Mobile phone: ${phone ?? "Not set"}.`,
    `Location: ${location?.label ?? "Not set"}.`,
    `Blocked users: ${blockedUsers.length ? blockedUsers.map((b) => b.name).join(", ") : "none"}.`,
  ];

  return {
    photoURL,
    name,
    joined: fmtJoined(input.auth?.creationTime),
    membership: { label: membershipLabel, actions: membership.actions },
    identity: { status: identityStatus, label: identityLabel },
    recoveryEmail,
    googleEmail: str(auth?.googleEmail),
    phone,
    location,
    blockedUsers,
    actions,
    summary: parts.join(" "),
  };
}

/** The page's own reads: Auth user + users doc + the Membership page's record. */
export async function readAccountSettingsPage(uid: string): Promise<AccountSettingsPage | null> {
  const db = admin.firestore();
  const [authUser, docSnap, membership] = await Promise.all([
    admin.auth().getUser(uid).catch(() => null),
    db.collection("users").doc(uid).get().catch(() => null),
    readMembershipPage(uid, "client"),
  ]);
  if (!authUser && !docSnap?.exists) return null;
  const google = authUser?.providerData?.find((p) => p.providerId === "google.com");
  return shapeAccountSettingsPage({
    uid,
    auth: authUser ? {
      displayName: authUser.displayName ?? null,
      email: authUser.email ?? null,
      creationTime: authUser.metadata?.creationTime ?? null,
      photoURL: authUser.photoURL ?? null,
      googleEmail: google?.email ?? null,
    } : null,
    doc: (docSnap?.data() ?? {}) as Record<string, unknown>,
    membership,
  });
}
