import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { storeCredential, PortalService } from "./credentialVault";

const db = admin.firestore();

// Human-readable names and login URLs for each portal service
export const PORTAL_CONFIG: Record<PortalService, { name: string; url: string; usernameLabel: string }> = {
  mychart:           { name: "MyChart",          url: "https://mychart.com",                           usernameLabel: "MyChart username or email" },
  athenahealth:      { name: "athenahealth",      url: "https://www.athenahealth.com/patients",         usernameLabel: "athenahealth username or email" },
  followmyhealth:    { name: "FollowMyHealth",    url: "https://www.followmyhealth.com",                usernameLabel: "FollowMyHealth email" },
  cvs:               { name: "CVS",               url: "https://www.cvs.com/account/login",             usernameLabel: "CVS.com email" },
  walgreens:         { name: "Walgreens",         url: "https://www.walgreens.com/login",               usernameLabel: "Walgreens email" },
  riteaid:           { name: "Rite Aid",          url: "https://www.riteaid.com/account/login",         usernameLabel: "Rite Aid email" },
  caremark:          { name: "CVS Caremark",      url: "https://www.caremark.com",                      usernameLabel: "Caremark username or email" },
  express_scripts:   { name: "Express Scripts",   url: "https://www.express-scripts.com",               usernameLabel: "Express Scripts username" },
  aetna:             { name: "Aetna",             url: "https://www.aetna.com/individuals-families/member-login.html", usernameLabel: "Aetna member username or email" },
  unitedhealthcare:  { name: "UnitedHealthcare",  url: "https://www.uhc.com/member-login",              usernameLabel: "UHC member username or email" },
  humana:            { name: "Humana",            url: "https://www.humana.com/member/login",           usernameLabel: "Humana member username or email" },
  cigna:             { name: "Cigna",             url: "https://my.cigna.com/web/public/guest",         usernameLabel: "myCigna username or email" },
  medicare:          { name: "Medicare",          url: "https://www.medicare.gov/account/login",        usernameLabel: "Medicare.gov username or email" },
  medicaid:          { name: "Medicaid",          url: "https://www.medicaid.gov",                      usernameLabel: "State Medicaid portal username or email" },
};

// ── Start collecting credentials via iMessage ─────────────────────────────────

export async function startCredentialCollection(params: {
  phone:   string;
  userId:  string;
  service: PortalService;
  reason:  string;
}): Promise<void> {
  const config = PORTAL_CONFIG[params.service];

  await sendViaInteractionAgent(params.phone, {
    content:
      `To ${params.reason}, I'll need your ${config.name} login.\n\n` +
      `I encrypt and store it securely — you only need to do this once.\n\n` +
      `What's your ${config.usernameLabel}?`,
    urgency:     "standard",
    sourceAgent: "credential_collector",
    canDrop:     false,
  });

  await db.collection("agent_sessions").doc(params.phone).update({
    collectingCredential:        true,
    collectingCredentialService: params.service,
    collectingCredentialStep:    "username",
    collectingCredentialReason:  params.reason,
  });
}

// ── Handle credential replies from the family ─────────────────────────────────
// Returns true if the message was a credential reply and was handled.
// Call this BEFORE intent classification in webhooks.ts.

export async function handleCredentialReply(params: {
  phone:   string;
  userId:  string;
  text:    string;
  session: Record<string, unknown>;
}): Promise<boolean> {
  const { phone, userId, text, session } = params;

  if (!session.collectingCredential) return false;

  const service = session.collectingCredentialService as PortalService;
  const step    = session.collectingCredentialStep    as string;
  const config  = PORTAL_CONFIG[service];

  if (step === "username") {
    await db.collection("agent_sessions").doc(phone).update({
      collectingCredentialUsername: text.trim(),
      collectingCredentialStep:     "password",
    });

    await sendViaInteractionAgent(phone, {
      content:
        `Got it. Now what's your ${config.name} password?\n\n` +
        `I'll encrypt it immediately.`,
      urgency:     "standard",
      sourceAgent: "credential_collector",
      canDrop:     false,
    });
    return true;
  }

  if (step === "password") {
    const username = (session.collectingCredentialUsername as string | undefined)?.trim() ?? "";
    const password = text.trim();

    // Encrypt and store — username is never persisted in plaintext after this point
    await storeCredential(userId, service, username, password);

    // Clear ALL credential collection state from session immediately
    await db.collection("agent_sessions").doc(phone).update({
      collectingCredential:         false,
      collectingCredentialService:  null,
      collectingCredentialStep:     null,
      collectingCredentialUsername: null,
      collectingCredentialReason:   null,
    });

    await sendViaInteractionAgent(phone, {
      content:
        `Done — your ${config.name} login is saved securely.\n\n` +
        `I'll use it whenever you ask me to take action on ${config.name}. ` +
        `Reply "remove my ${config.name} login" anytime to delete it.`,
      urgency:     "standard",
      sourceAgent: "credential_collector",
      canDrop:     false,
    });
    return true;
  }

  return false;
}
