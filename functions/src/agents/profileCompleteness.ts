import * as admin from "firebase-admin";
import { AgentSession, sendMessage } from "../linq/client";
import { quickComplete } from "../utils/openaiClient";

const db = admin.firestore();

// ── Profile completeness classifier ──────────────────────────────────────────
// Returns where this phone sits in the onboarding lifecycle. A single source
// of truth — used by webhooks routing AND qaAgent context gating so they
// never disagree about whether the speaker is known.
//
//   NEW       — no agent_sessions doc; first contact
//   PARTIAL   — phone is in the system (session exists, possibly with stale
//               linkage to other people's appointments) but onboarding is not
//               complete: no userType, missing name, or onboardingStep != complete.
//               This catches sandbox→live migrations, admin-added stubs, and
//               abandoned mid-flow drop-offs.
//   ONBOARDED — onboardingStep === "complete" AND has userType AND has a name
//               in onboardingData (covers the corrupt "complete-but-empty" cases).

export type ProfileCompleteness = "NEW" | "PARTIAL" | "ONBOARDED";

export function classifyCompleteness(session: AgentSession | null | undefined): ProfileCompleteness {
  if (!session) return "NEW";

  const step    = session.onboardingStep;
  const role    = session.userType;
  const data    = (session.onboardingData ?? {}) as Record<string, unknown>;
  const hasName = typeof data.firstName === "string" && (data.firstName as string).trim().length > 0;

  if (step === "complete" && role && hasName) return "ONBOARDED";
  return "PARTIAL";
}

// ── Onboarding offer state — tracked per session ─────────────────────────────
// `onboardingOfferState`:
//   "pending"  → we sent the offer; the next inbound is the answer
//   "declined" → user said no; we answer freely but suppress cross-entity data
//   (undefined) → never offered, or offer was accepted (now in onboardingStep flow)
//
// `onboardingOfferedAt` (ISO string) — used to re-offer once per fresh session
// (>12h since last inbound).

const REOFFER_AFTER_MS = 12 * 60 * 60 * 1000;

export function shouldReoffer(session: AgentSession | null | undefined): boolean {
  if (!session) return false;
  const state = (session as any).onboardingOfferState as string | undefined;
  if (state !== "declined") return false;
  const lastInboundAt = (session as any).lastInboundAt as string | undefined;
  if (!lastInboundAt) return true;
  return Date.now() - new Date(lastInboundAt).getTime() > REOFFER_AFTER_MS;
}

// ── Send the PARTIAL-state opener ────────────────────────────────────────────
// Direct + transparent wording. Acknowledges the gap, names what's missing,
// asks a single YES/NO question, and pins the session into a "pending" offer
// state so the next inbound is interpreted as the answer.

export async function sendOnboardingOffer(
  phone:   string,
  chatId:  string,
  session: AgentSession,
): Promise<void> {
  const data         = (session.onboardingData ?? {}) as Record<string, unknown>;
  const knownName    = data.firstName as string | undefined;
  const migrated     = !!(session as any).migratedFromSandbox;
  const hasMissedFromSandbox =
    migrated || !session.userType || (!knownName && !session.userId);

  const opener = hasMissedFromSandbox
    ? "You're right — we never finished setting up your account. I have your number on file but not your name or what you're looking for. " +
      "Want to do that now? Takes about 2 minutes over text — just reply YES and we'll go."
    : "Looks like we never finished setting up your account properly. " +
      "Want to do that now? Takes about 2 minutes over text — just reply YES and we'll go.";

  await sendMessage(chatId, opener);
  await db.collection("agent_sessions").doc(phone).update({
    onboardingOfferState: "pending",
    onboardingOfferedAt:  new Date().toISOString(),
  });
}

// ── Interpret the user's reply to the offer ──────────────────────────────────
// Returns:
//   "accept"   → user wants to onboard (YES, "sure", "go ahead", etc.)
//   "decline"  → user said no, not now, etc.
//   "question" → they asked something else; answer it and re-show the offer
//
// Uses gpt-4o-mini per CLAUDE.md (no regex/keyword parsing of intent).

export async function classifyOfferReply(text: string): Promise<"accept" | "decline" | "question"> {
  const norm = text.trim().toUpperCase();
  if (norm === "YES" || norm === "Y") return "accept";
  if (norm === "NO"  || norm === "N") return "decline";

  try {
    const raw = await quickComplete(
      "Cara just asked the user 'Want to set up your account now? Reply YES to go.' " +
      "Classify their reply. Reply with exactly one word:\n" +
      "ACCEPT — they want to do it (yes, sure, ok, let's go, fine, whatever)\n" +
      "DECLINE — they refuse or defer (no, not now, later, busy, skip)\n" +
      "QUESTION — they asked something else or want clarification first",
      text,
      { maxTokens: 5 },
    );
    const v = raw.trim().toUpperCase();
    if (v.startsWith("A")) return "accept";
    if (v.startsWith("D")) return "decline";
    return "question";
  } catch {
    return "question";
  }
}

export async function markOfferAccepted(phone: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    onboardingOfferState: admin.firestore.FieldValue.delete(),
    onboardingStep:       "ask_role",
    onboardingData:       {},
    stateExpiresAt:       new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
}

export async function markOfferDeclined(phone: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    onboardingOfferState: "declined",
  });
}
