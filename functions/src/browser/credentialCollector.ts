import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { storeCredential, PortalService } from "./credentialVault";
import { isFlowStale, CREDENTIAL_FLOW_TTL_MS } from "../utils/sessionState";

// A stored password must look like a real credential — at least 6 chars and no
// internal whitespace (a sentence/question would have spaces and was already
// filtered upstream). Rejecting garbage here prevents a broken login later.
export function isPlausiblePassword(pw: string): boolean {
  const t = (pw ?? "").trim();
  return t.length >= 6 && !/\s/.test(t);
}
import { quickComplete } from "../utils/openaiClient";

const db = admin.firestore();

// Conservative classifier for credential capture. If the user replies with a
// question or worry instead of a credential, we MUST NOT store the text — a
// password field is the worst possible place to accidentally write "is this
// safe?". When in doubt, treat as a question; the cost of a false positive is
// re-asking the credential, but a false negative leaks PII into the vault.
async function isCredentialReply(text: string, step: "username" | "password", portalName: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Question-mark or interrogative opener — never a credential.
  if (trimmed.endsWith("?")) return false;
  if (/^\s*(why|how|what|is\s+(this|that|it)|are\s+you|can\s+you|do\s+you|will\s+you|should\s+i|where|when|who)\b/i.test(trimmed)) {
    return false;
  }
  // Multi-sentence input is almost certainly a question or worry, not a credential.
  if (/[.?!]\s+\S/.test(trimmed)) return false;

  try {
    const result = await quickComplete(
      `The user was just asked for their ${portalName} ${step}. Reply YES if their message looks like a ` +
      `${step} (a plausible username/email or a password — single token, no sentences). ` +
      "Reply NO if it is a question, a worry, a refusal, a request to cancel, or any conversational sentence. " +
      "When in doubt, reply NO.",
      trimmed,
      { maxTokens: 5 },
    );
    return result.trim().toUpperCase().startsWith("Y");
  } catch {
    // Fail closed — treat as not-a-credential. Re-asking is safe; storing junk is not.
    return false;
  }
}

async function answerCredentialQuestion(text: string, portalName: string): Promise<string> {
  try {
    return await quickComplete(
      `You are Evia, a care coordinator. A family member was just asked for their ${portalName} login ` +
      "so you can take an action on their behalf. They asked a question or expressed hesitation instead. " +
      "Answer briefly (1–2 sentences). Reassure them that the credential is encrypted at rest, only used " +
      "for the action they requested, and can be deleted anytime by replying " +
      `"remove my ${portalName} login". Do NOT ask for the credential — that prompt comes separately.`,
      text,
      { maxTokens: 180 },
    );
  } catch {
    return `Your ${portalName} login is encrypted and only used when you ask me to do something on that site. ` +
           `You can remove it anytime by saying "remove my ${portalName} login".`;
  }
}

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
    // Freshness stamp — an abandoned credential flow must never sit armed
    // forever treating future texts as username/password candidates.
    collectingCredentialSetAt:   new Date().toISOString(),
  });
}

// Every credential-flow field, for the staleness clear and START OVER.
const CREDENTIAL_FIELDS = [
  "collectingCredential", "collectingCredentialService", "collectingCredentialStep",
  "collectingCredentialUsername", "collectingCredentialReason", "collectingCredentialSetAt",
] as const;

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

  // Staleness gate (30 min, or unstamped legacy state): clear the whole flow
  // silently and hand the text back to normal routing — the most sensitive
  // state in the app must not be immortal.
  if (isFlowStale(session, "collectingCredential", "collectingCredentialSetAt", CREDENTIAL_FLOW_TTL_MS)) {
    await db.collection("agent_sessions").doc(phone).update(
      Object.fromEntries(CREDENTIAL_FIELDS.map((f) => [f, admin.firestore.FieldValue.delete()])),
    ).catch(() => {});
    return false;
  }

  const service = session.collectingCredentialService as PortalService;
  const step    = session.collectingCredentialStep    as string;
  const config  = PORTAL_CONFIG[service];

  if (step === "username") {
    if (!(await isCredentialReply(text, "username", config.name))) {
      const answer = await answerCredentialQuestion(text, config.name);
      await sendViaInteractionAgent(phone, {
        content:     answer,
        urgency:     "standard",
        sourceAgent: "credential_collector",
        canDrop:     false,
      });
      await sendViaInteractionAgent(phone, {
        content:     `When you're ready — what's your ${config.usernameLabel}?`,
        urgency:     "standard",
        sourceAgent: "credential_collector",
        canDrop:     false,
      });
      return true;
    }

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
    if (!(await isCredentialReply(text, "password", config.name))) {
      const answer = await answerCredentialQuestion(text, config.name);
      await sendViaInteractionAgent(phone, {
        content:     answer,
        urgency:     "standard",
        sourceAgent: "credential_collector",
        canDrop:     false,
      });
      await sendViaInteractionAgent(phone, {
        content:     `When you're ready — what's your ${config.name} password?`,
        urgency:     "standard",
        sourceAgent: "credential_collector",
        canDrop:     false,
      });
      return true;
    }

    const username = (session.collectingCredentialUsername as string | undefined)?.trim() ?? "";
    const password = text.trim();

    // H-U7: reject an obviously-wrong password BEFORE storing — a garbage value
    // silently breaks every future portal login. (isCredentialReply already
    // filtered questions/sentences; this is a final sanity gate.)
    if (!isPlausiblePassword(password)) {
      await sendViaInteractionAgent(phone, {
        content:     `That doesn't look like a complete ${config.name} password. When you're ready, send just your password.`,
        urgency:     "standard",
        sourceAgent: "credential_collector",
        canDrop:     false,
      });
      return true; // stay on the password step
    }

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
