import * as admin from "firebase-admin";
import { quickComplete } from "../utils/openaiClient";
import { EMAIL_CHANGE_ANCHOR_TTL_MS, maskEmail } from "../accountRecovery";

// The reply to Evia's "A request was just made to change your recovery email…
// Reply APPROVE to use this phone as your proof, or NO if this wasn't you."
// (accountRecovery.ts requestEmailChangeSelf sets the session anchor). Texting
// from the phone on file is the same proof as the site's "Text me a code"
// fallback, so APPROVE completes the old-address approval step and the new
// inbox gets its confirmation link. Same anchor pattern as reviewPrompt.ts:
// fresh for 30 minutes, LLM-classified, anything else is not ours.

export function freshEmailChangeToken(session: Record<string, unknown> | null | undefined, nowMs = Date.now()): string | null {
  const token = session?.pendingEmailChangeToken;
  if (typeof token !== "string" || !token) return null;
  const setAt = session?.pendingEmailChangeSetAt;
  if (typeof setAt === "string" && setAt && Date.parse(setAt) < nowMs - EMAIL_CHANGE_ANCHOR_TTL_MS) return null;
  return token;
}

export type EmailChangeReply = { kind: "approve" } | { kind: "cancel" } | { kind: "other" };

export async function classifyEmailChangeReply(
  text: string,
  complete: (system: string, user: string) => Promise<string> = (s, u) => quickComplete(s, u, { maxTokens: 20 }),
): Promise<EmailChangeReply> {
  const raw = (await complete(
    "Evia just texted an account holder: a request was made to change their recovery email; reply APPROVE to approve it from this phone, or NO if it wasn't them. " +
    "Classify their reply. Reply with exactly one word: approve (they approve / confirm / yes / go ahead / it was me), " +
    "cancel (no / not me / stop / cancel / wasn't me), or other (a question, an unrelated message, or unclear).",
    text,
  ).catch(() => "other")).trim().toLowerCase();
  if (raw.startsWith("approve")) return { kind: "approve" };
  if (raw.startsWith("cancel")) return { kind: "cancel" };
  return { kind: "other" };
}

export interface EmailChangeReplyDeps {
  approve: (token: string) => Promise<{ sentTo: string }>;
  cancel: (token: string) => Promise<void>;
  sendMessage: (chatId: string, text: string) => Promise<unknown>;
  classify: (text: string) => Promise<EmailChangeReply>;
  clearAnchor: (phone: string) => Promise<void>;
}

async function defaultDeps(): Promise<EmailChangeReplyDeps> {
  const { approveEmailChange, cancelEmailChange } = await import("../accountRecovery");
  const { sendMessage } = await import("../linq/client");
  return {
    approve: (token) => approveEmailChange(token, "phone_reply"),
    cancel: (token) => cancelEmailChange(token),
    sendMessage: (chatId, text) => sendMessage(chatId, text),
    classify: (text) => classifyEmailChangeReply(text),
    clearAnchor: async (phone) => {
      await admin.firestore().collection("agent_sessions").doc(phone).update({
        pendingEmailChangeToken: admin.firestore.FieldValue.delete(),
        pendingEmailChangeSetAt: admin.firestore.FieldValue.delete(),
      }).catch(() => {});
    },
  };
}

/**
 * Returns true when this turn was consumed (approved or cancelled); false →
 * not ours, routing continues as normal.
 */
export async function handleEmailChangeReply(
  params: { phone: string; chatId: string; text: string; session: Record<string, unknown> | null | undefined; nowMs?: number },
  deps?: EmailChangeReplyDeps,
): Promise<boolean> {
  const token = freshEmailChangeToken(params.session, params.nowMs);
  if (!token) return false;
  const d = deps ?? await defaultDeps();
  const verdict = await d.classify(params.text);
  if (verdict.kind === "other") return false;
  if (verdict.kind === "cancel") {
    try { await d.cancel(token); } catch { /* already consumed or expired — the anchor is stale either way */ }
    await d.clearAnchor(params.phone);
    await d.sendMessage(params.chatId, "Cancelled — your recovery email stays exactly as it is. If you didn't start this, tell me and we'll lock things down.");
    return true;
  }
  try {
    const { sentTo } = await d.approve(token);
    await d.sendMessage(params.chatId, `Approved. I sent the confirmation link to ${maskEmail(sentTo)} — tap it from that inbox and the change is done.`);
  } catch {
    await d.clearAnchor(params.phone);
    await d.sendMessage(params.chatId, "That request has expired, so nothing changed. Start the email change again from Account Settings (or tell me the new address) and I'll send a fresh one.");
  }
  return true;
}
