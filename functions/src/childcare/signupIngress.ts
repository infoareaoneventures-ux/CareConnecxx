// ── Childcare family-signup ingress (plan 2026-07-22-002, U4 / R47-R48) ──────
//
// The narrow seam linq/webhooks.ts calls when a web_onboarding_sessions bridge
// doc carries the typed childcare vertical (careVertical === "child"), and for
// every subsequent inbound on a childcare-stamped agent session. Keeping the
// logic HERE (not inline in webhooks.ts) keeps the live senior ingress file's
// churn to two guarded, typed-intent-only branches.
//
// Contract:
//   • The childcare branch is entered ONLY when the typed vertical is present;
//     the senior default path is untouched (release-gate senior parity).
//   • Runtime flags are re-checked at inbound time (they can flip between
//     /start and the first text — emergency-off must fail closed, R61).
//   • NO Zep/memory initialization ever happens here (R50/KTD17) — the
//     memoryEligibility decision for these sessions is always a denial, and
//     webhooks.ts call sites are gated on the same predicate.
//   • ONE family childcare objective per adult (deterministic ID, AE15) —
//     created on the first authoritative childcare inbound, vertical-stamped.
//   • SMS carries routing/status/links ONLY (R33/implementation defaults):
//     child details are collected exclusively in the authenticated web form
//     (components/client/childcare/ChildProfileFlow.tsx). Messages here are
//     STATIC templates — no LLM, no interpolated user text, no child PII.

import * as admin from "firebase-admin";
import { getChildcareFlags } from "../config/featureFlags";
import { appLink } from "../config/appUrl";
import { logAudit } from "../observability/auditLog";
import { ensureObjective, type AgentObjective } from "../agents/objectiveLedger";
import { decideMemoryEligibility, logMemoryDenial } from "../memory/memoryEligibility";
import { writeChildcareConsentReceipts } from "./consentReceipts";
import {
  classifyChildcareIncidentSignal,
  escalateChildcareIncident,
  CHILDCARE_INCIDENT_ACK,
} from "./incidentSignal";
import { listAuthoritiesForAdult } from "./guardianAuthority";
import {
  createVerticalExecutionContext,
  type VerticalExecutionContext,
} from "../agents/turnSourceKey";
import type { PendingAction } from "../agents/pendingActions";
import type { ApprovalResult } from "../agents/approvalHandler";
// Front door Stage 2 (deliverable 6a). STATIC on purpose: this runs on the hot
// path of every childcare inbound, so paying a cold module-graph load INSIDE a
// live turn is the wrong trade — and the detector's own deterministic pre-pass
// already makes the call itself free unless the text carries a senior signal.
// No cycle: nothing in that graph imports this module.
import { handleChildcareToSeniorSwitchTurn } from "../agents/childcareVerticalSwitch";

// Pilot jurisdiction whose policy supplies consent versions at signup time.
// Signup does not yet know the family's address; the CA pilot (Santa Clara
// service area) is the only configured jurisdiction. Revisit when a second
// state launches (U14 records the per-state rollout).
export const CHILDCARE_PILOT_STATE = "CA";

/** Session steps owned by the childcare ingress (never the senior state machine). */
export const CHILDCARE_STEP_WEB_PROFILE = "childcare_web_profile";
export const CHILDCARE_STEP_UNAVAILABLE = "childcare_unavailable";
/**
 * Front-door Stage 1 steps.
 *
 * CHILDCARE_STEP_COLD_SIGNUP — a childcare intent classified from a COLD text
 * (no web signup, so no Firebase uid and no account). Nothing can be enrolled
 * yet: the deterministic responder sends the secure signup link and holds here.
 *
 * CHILDCARE_STEP_CAREGIVER_HOLD — a caregiver whose vertical resolved to child.
 * Stage 1 stamps and routes them deterministically to the authenticated
 * childcare vertical-profile page; the conversational caregiver childcare
 * funnel is Stage 2 (docs/architecture/childcare-front-door-design.md).
 */
export const CHILDCARE_STEP_COLD_SIGNUP = "childcare_cold_signup";
export const CHILDCARE_STEP_CAREGIVER_HOLD = "childcare_caregiver_hold";

/**
 * Front-door STAGE 2. `CHILDCARE_STEP_CAREGIVER_HOLD` is no longer a dead end:
 * an inbound on a caregiver childcare session now runs the real conversational
 * funnel (agents/childcareCaregiverFunnelTurn.ts). The step constant is KEPT —
 * it remains the session's routing state and the flags-off→on upgrade target —
 * but the turn behind it is a funnel, not a status line.
 *
 * ORDER IS BINDING and unchanged from Stage 1:
 *   1. deterministic incident classification (pre-flags, pre-model, R53);
 *   2. childcare flags (off ⇒ the waitlist state, R-FD8);
 *   3. the funnel.
 * This module stays STATIC-TEMPLATE only. Every model-shaped judgement — field
 * extraction, the next question, child→senior switch detection — lives in
 * agents/**, which is why the funnel and the switch detector are imported
 * lazily rather than inlined here.
 */
export const CHILDCARE_CAREGIVER_FUNNEL_ENABLED_STEPS: readonly string[] = [
  CHILDCARE_STEP_CAREGIVER_HOLD,
  CHILDCARE_STEP_COLD_SIGNUP,
];

/** Authenticated web route where child profiles are completed (U4/U11). */
export const CHILDCARE_PROFILE_PATH = "/childcare/children";

/** Authenticated caregiver childcare vertical-profile page (U11). */
export const CHILDCARE_CAREGIVER_PATH = "/caregiver/childcare";

/** Secure signup entries that carry the typed vertical (never child detail). */
export const CHILDCARE_CLIENT_SIGNUP_PATH = "/start?vertical=child";
export const CHILDCARE_CAREGIVER_SIGNUP_PATH = "/start?role=caregiver&vertical=child";

/** Deterministic family-enrollment objective ID — one per adult (AE15). */
export function familyChildcareObjectiveId(uid: string): string {
  return `childcare-family-signup_${uid.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80)}`;
}

export const CHILDCARE_FAMILY_ENROLLMENT_INTENT = "childcare.family_enrollment";

/** Consent receipt types recorded at signup (deliverable: terms/privacy/communication/guardian attestation). */
export const SIGNUP_CONSENT_TYPES = [
  "terms",
  "privacy",
  "communicationConsent",
  "guardianAttestation",
] as const;

type Db = admin.firestore.Firestore;
type SendMessageFn = (chatId: string, text: string, opts?: Record<string, unknown>) => Promise<unknown>;

function childExecutionContext(params: {
  phone: string;
  chatId: string;
  userId?: string;
  messageId?: string;
}): VerticalExecutionContext {
  const principal = params.userId?.trim() || params.phone;
  return createVerticalExecutionContext({
    principal,
    careVertical: "child",
    channel: "linq",
    conversationPartition: `child:${principal}`,
    sourceTurn: {
      conversationId: params.chatId,
      messageId: params.messageId?.trim() || `childcare:${Date.now()}`,
    },
  });
}

async function defaultSendMessage(chatId: string, text: string, opts?: Record<string, unknown>): Promise<unknown> {
  const { sendMessage } = await import("../linq/client");
  return sendMessage(chatId, text, opts as never);
}

/**
 * Create (or converge on) the family childcare enrollment objective —
 * vertical-stamped per the U0 contract, steps mirror the F1 flow.
 */
export async function ensureFamilyChildcareObjective(
  uid: string,
  opts: { db?: Db; now?: Date; channel?: "linq" | "web" } = {},
): Promise<{ objective: AgentObjective; created: boolean }> {
  const result = await ensureObjective(
    {
      objectiveId: familyChildcareObjectiveId(uid),
      userId: uid,
      role: "client",
      channel: opts.channel ?? "linq",
      intent: CHILDCARE_FAMILY_ENROLLMENT_INTENT,
      description: "Set up childcare for your family",
      careVertical: "child",
      steps: [
        { id: "consent", label: "Record consent receipts", status: "pending" },
        { id: "identity", label: "Verify your identity", status: "pending" },
        { id: "child_profile", label: "Complete the secure child profile", status: "pending" },
      ],
      missingInputs: [],
    },
    { db: opts.db, now: opts.now },
  );
  if (result.created) {
    await logAudit({
      eventType: "childcare_objective_created",
      userId: uid,
      data: { objectiveId: result.objective.objectiveId, intent: CHILDCARE_FAMILY_ENROLLMENT_INTENT },
    }).catch(() => {});
  }
  return result;
}

// ── Static message templates (no LLM, no user text, no child PII) ───────────

function welcomeMessage(): string {
  return (
    "Welcome to Evia childcare! To keep your family's details private, " +
    "the next steps happen in your secure account — not over text.\n\n" +
    `Finish setting up here: ${appLink(CHILDCARE_PROFILE_PATH)}\n\n` +
    "I'll text you status updates along the way. Reply STOP anytime to opt out."
  );
}

function statusMessage(): string {
  return (
    "Your childcare setup continues in your secure account — child details " +
    "stay out of text messages to protect your family's privacy.\n\n" +
    `Pick up where you left off: ${appLink(CHILDCARE_PROFILE_PATH)}`
  );
}

function unavailableMessage(): string {
  return (
    "Thanks for your interest in childcare with Evia! Childcare isn't " +
    "available in your area quite yet — your spot is saved, and I'll text " +
    "you the moment it opens up. Reply STOP anytime to opt out."
  );
}

/**
 * Cold-text childcare intent, family side. There is no account yet, so the ONLY
 * next step is the secure signup entry that carries the typed vertical. Static
 * template — no LLM, no user text, no child detail (R33/R57).
 */
function coldClientSignupMessage(): string {
  return (
    "Got it — childcare for your family. To keep your kids' details private, " +
    "setup happens in your secure account rather than over text.\n\n" +
    `Start here: ${appLink(CHILDCARE_CLIENT_SIGNUP_PATH)}\n\n` +
    "I'll text you status updates along the way. Reply STOP anytime to opt out."
  );
}

/**
 * Cold-text childcare intent, caregiver side (Stage 1). Stamped and routed
 * deterministically — a childcare-stamped caregiver must NEVER enter the senior
 * caregiver collection loop (R-FD5/R-FD6 re-keying is Stage 2).
 */
function coldCaregiverSignupMessage(): string {
  return (
    "Got it — you're looking for childcare work. Childcare profiles are set up " +
    "in your secure Evia account, not over text.\n\n" +
    `Start here: ${appLink(CHILDCARE_CAREGIVER_SIGNUP_PATH)}\n\n` +
    "I'll text you as soon as there's something to review. Reply STOP anytime to opt out."
  );
}

/**
 * Childcare resolved, role did not. The neutral entry renders the web role
 * picker, so the person chooses instead of Evia guessing (R-FD1).
 */
function coldNeutralSignupMessage(): string {
  return (
    "Got it — childcare. Setup happens in your secure Evia account rather than " +
    "over text, and the first screen asks whether you're a family looking for " +
    "care or a caregiver looking for work.\n\n" +
    `Start here: ${appLink(CHILDCARE_CLIENT_SIGNUP_PATH)}\n\n` +
    "Reply STOP anytime to opt out."
  );
}

/** Caregiver childcare welcome after a web signup carried the typed vertical. */
function caregiverWelcomeMessage(): string {
  return (
    "Welcome to Evia childcare! Childcare work has its own profile and its own " +
    "screening, so those steps happen in your secure account rather than over text.\n\n" +
    `Set it up here: ${appLink(CHILDCARE_CAREGIVER_PATH)}\n\n` +
    "I'll text you when there's an update. Reply STOP anytime to opt out."
  );
}

/** Deterministic status line for any later inbound on a caregiver childcare session. */
function caregiverStatusMessage(): string {
  return (
    "Your childcare profile continues in your secure account — that's where " +
    "approval and screening live.\n\n" +
    `Pick up where you left off: ${appLink(CHILDCARE_CAREGIVER_PATH)}`
  );
}

/**
 * Stage 2 funnel OPENING. Static template, and the one message in the funnel
 * that carries a URL — the model output guard strips composed links, so the
 * caregiver's alternative route has to be stated deterministically here. It says
 * both routes plainly: finish over text, or in the account.
 */
export function caregiverFunnelOpeningMessage(): string {
  return (
    "Let's get your childcare profile set up — childcare has its own profile and its own screening. " +
    "I can walk you through it right here over text, or you can fill it in your account: " +
    `${appLink(CHILDCARE_CAREGIVER_PATH)}`
  );
}

// ── First inbound (web-bridge doc carries careVertical === "child") ─────────

export interface ChildcareBridgeInboundParams {
  phone: string;
  chatId: string;
  service: string;
  preferredLanguage: string;
  webSessionData: Record<string, unknown>;
  db?: Db;
  sendMessage?: SendMessageFn;
  now?: Date;
}

/**
 * Handle the FIRST inbound of a childcare-intent web signup. Returns true when
 * the turn was handled (webhooks.ts returns immediately); never returns false
 * — a typed childcare bridge doc is never allowed to fall through into senior
 * onboarding (fail closed, R48).
 */
export async function handleChildcareWebBridgeInbound(
  params: ChildcareBridgeInboundParams,
): Promise<boolean> {
  const db = params.db ?? admin.firestore();
  const send = params.sendMessage ?? defaultSendMessage;
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const uid = String(params.webSessionData.uid ?? "").trim();
  const flags = await getChildcareFlags({ db });
  const executionContext = childExecutionContext({
    phone: params.phone,
    chatId: params.chatId,
    userId: uid,
    messageId: `bridge:${params.phone}`,
  });

  const sessionBase: Record<string, unknown> = {
    chatId: params.chatId,
    phone: params.phone,
    service: params.service,
    userType: "client",
    careVertical: "child",
    verticalIntent: "child",
    optedIn: true,
    optedOut: false,
    preferredLanguage: params.preferredLanguage,
    createdAt: nowIso,
    ...(uid ? { userId: uid, webOnboardingUid: uid } : {}),
  };

  // Flags re-check (R61): emergency-off / disabled between /start and the
  // first text fails CLOSED — never senior onboarding, never child collection.
  if (!flags.enabled || !uid) {
    await db.collection("agent_sessions").doc(params.phone).set({
      ...sessionBase,
      onboardingStep: CHILDCARE_STEP_UNAVAILABLE,
    });
    logMemoryDenial("childcare_web_bridge", decideMemoryEligibility(sessionBase));
    await db.collection("web_onboarding_sessions").doc(params.phone).update({
      status: "connected",
      connectedAt: admin.firestore.Timestamp.fromDate(now),
      chatId: params.chatId,
    }).catch(() => {/* non-critical */});
    await send(params.chatId, unavailableMessage(), { executionContext });
    await logAudit({
      eventType: "childcare_signup_ingress",
      userId: uid || params.phone,
      data: { outcome: "unavailable", flagsEnabled: flags.enabled, hasUid: Boolean(uid) },
    }).catch(() => {});
    return true;
  }

  // Authoritative childcare first inbound: stamp the typed session, create the
  // one enrollment objective, record consent receipts — NO memory init.
  await db.collection("agent_sessions").doc(params.phone).set({
    ...sessionBase,
    onboardingStep: CHILDCARE_STEP_WEB_PROFILE,
  });
  logMemoryDenial("childcare_web_bridge", decideMemoryEligibility(sessionBase));

  const { objective, created } = await ensureFamilyChildcareObjective(uid, { db, now, channel: "linq" });

  // Versioned consent receipts (R23). Unpopulated policy versions land as
  // pending-policy-version — recorded for dark-mode testing, while activation
  // stays blocked by the U1 readiness evaluator's consent_version_missing.
  await writeChildcareConsentReceipts({
    adultUid: uid,
    jurisdictionState: CHILDCARE_PILOT_STATE,
    channel: "web", // consent text was accepted on the authenticated /start form
    source: "childcare_family_signup",
    policyTypes: SIGNUP_CONSENT_TYPES,
    db,
    now,
  }).catch((err) => {
    console.error("childcare ingress: consent receipt write failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  });

  await db.collection("web_onboarding_sessions").doc(params.phone).update({
    status: "connected",
    connectedAt: admin.firestore.Timestamp.fromDate(now),
    chatId: params.chatId,
    childcareObjectiveId: objective.objectiveId,
  }).catch(() => {/* non-critical */});

  await send(params.chatId, welcomeMessage(), { executionContext });
  await logAudit({
    eventType: "childcare_signup_ingress",
    userId: uid,
    data: { outcome: "started", objectiveId: objective.objectiveId, objectiveCreated: created },
  }).catch(() => {});
  return true;
}

// ── Caregiver childcare bridge inbound (front door Stage 1) ─────────────────
//
// U5 shipped fail-closed stubs on the assumption that a CAREGIVER could never
// carry a childcare stamp (the only stamp origin was gated on
// `role === "client"`). Stage 1 removes that gate, so this is the branch those
// stubs were missing: a childcare caregiver is stamped and answered
// deterministically instead of falling into the senior caregiver loop — or,
// worse, silently dropping. Stage 2 replaces this hold with the real
// conversational childcare caregiver funnel.

export interface ChildcareCaregiverBridgeInboundParams {
  phone: string;
  chatId: string;
  service: string;
  preferredLanguage: string;
  webSessionData: Record<string, unknown>;
  db?: Db;
  sendMessage?: SendMessageFn;
  now?: Date;
}

export async function handleChildcareCaregiverBridgeInbound(
  params: ChildcareCaregiverBridgeInboundParams,
): Promise<boolean> {
  const db = params.db ?? admin.firestore();
  const send = params.sendMessage ?? defaultSendMessage;
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const uid = String(params.webSessionData.uid ?? "").trim();
  const flags = await getChildcareFlags({ db });
  const executionContext = childExecutionContext({
    phone: params.phone,
    chatId: params.chatId,
    userId: uid,
    messageId: `bridge:${params.phone}`,
  });

  const sessionBase: Record<string, unknown> = {
    chatId: params.chatId,
    phone: params.phone,
    service: params.service,
    userType: "caregiver",
    careVertical: "child",
    verticalIntent: "child",
    optedIn: true,
    optedOut: false,
    preferredLanguage: params.preferredLanguage,
    createdAt: nowIso,
    ...(uid ? { userId: uid, webOnboardingUid: uid } : {}),
  };

  const available = flags.enabled && Boolean(uid);
  await db.collection("agent_sessions").doc(params.phone).set({
    ...sessionBase,
    onboardingStep: available ? CHILDCARE_STEP_CAREGIVER_HOLD : CHILDCARE_STEP_UNAVAILABLE,
  });
  // NO memory init on any childcare path (R50/KTD17) — the decision is always a
  // denial, logged for the audit trail.
  logMemoryDenial("childcare_caregiver_bridge", decideMemoryEligibility(sessionBase));

  await db.collection("web_onboarding_sessions").doc(params.phone).update({
    status: "connected",
    connectedAt: admin.firestore.Timestamp.fromDate(now),
    chatId: params.chatId,
  }).catch(() => {/* non-critical */});

  await send(
    params.chatId,
    available ? caregiverWelcomeMessage() : unavailableMessage(),
    { executionContext },
  );
  await logAudit({
    eventType: "childcare_signup_ingress",
    userId: uid || params.phone,
    data: {
      role: "caregiver",
      outcome: available ? "caregiver_hold" : "unavailable",
      flagsEnabled: flags.enabled,
      hasUid: Boolean(uid),
    },
  }).catch(() => {});
  return true;
}

/**
 * Every later inbound on a CAREGIVER childcare session.
 *
 * Stage 1 answered every one of these with a status line. STAGE 2 runs the real
 * conversational childcare caregiver funnel here, with Stage 1's ordering
 * preserved exactly: incident escalation FIRST (a caregiver can report one, and
 * it must not depend on a model or on flags), then the flags gate (off ⇒ the
 * waitlist state), then the funnel. No senior tools, no senior loop, no memory.
 *
 * The funnel is fail-open: any funnel failure falls back to the Stage 1
 * deterministic status line rather than leaving the caregiver unanswered.
 */
export async function routeChildcareCaregiverInbound(params: {
  phone: string;
  chatId: string;
  text: string;
  session: Record<string, unknown>;
  eventId?: string;
  db?: Db;
  sendMessage?: SendMessageFn;
  now?: Date;
  /** Test seam — defaults to the real Stage 2 funnel turn. */
  runFunnel?: (p: Record<string, unknown>) => Promise<{ handled: boolean; step: string; reply: string; outcome: string }>;
}): Promise<boolean> {
  const db = params.db ?? admin.firestore();
  const send = params.sendMessage ?? defaultSendMessage;
  const uid = String(params.session.userId ?? params.session.webOnboardingUid ?? "").trim();
  const executionContext = childExecutionContext({
    phone: params.phone,
    chatId: params.chatId,
    userId: uid,
    messageId: params.eventId,
  });

  logMemoryDenial("childcare_caregiver_inbound", decideMemoryEligibility(params.session));

  // Incident signal FIRST (R53) — deterministic, pre-flags, pre-LLM.
  const signal = classifyChildcareIncidentSignal(params.text);
  if (signal.incident && signal.category) {
    await escalateChildcareIncident({
      phone: params.phone,
      userId: uid || undefined,
      category: signal.category,
      channel: "linq",
      db,
      now: params.now,
    }).catch((err) => {
      console.error("childcare caregiver incident escalation failed (ack still sent):", err);
      return { held: false, alerted: false };
    });
    await send(params.chatId, CHILDCARE_INCIDENT_ACK, { executionContext });
    return true;
  }

  const flags = await getChildcareFlags({ db }).catch(() => null);
  if (!flags?.enabled) {
    await send(params.chatId, unavailableMessage(), { executionContext });
    return true;
  }

  const step = String(params.session.onboardingStep ?? "");
  if (step === CHILDCARE_STEP_UNAVAILABLE) {
    // Flags turned ON since the waitlist message — upgrade and welcome. The
    // funnel starts on their NEXT turn, so the upgrade reads as a welcome rather
    // than an interrogation that begins mid-sentence.
    await db.collection("agent_sessions").doc(params.phone).update({
      onboardingStep: CHILDCARE_STEP_CAREGIVER_HOLD,
    }).catch(() => {});
    await send(params.chatId, caregiverWelcomeMessage(), { executionContext });
    return true;
  }

  // ── STAGE 2: the real funnel (this replaces the Stage 1 hold stub) ──────────
  const runFunnel = params.runFunnel ?? (async (p: Record<string, unknown>) => {
    const { runChildcareCaregiverFunnelTurn } = await import("../agents/childcareCaregiverFunnelTurn");
    return runChildcareCaregiverFunnelTurn(p as never);
  });
  const funnelResult = await runFunnel({
    phone: params.phone,
    chatId: params.chatId,
    text: params.text,
    session: params.session,
    sendMessage: send,
    db,
    ...(params.now ? { now: params.now } : {}),
    executionContext,
    openingLine: caregiverFunnelOpeningMessage(),
  }).catch((err) => {
    console.error("childcare caregiver funnel turn failed (deterministic fallback sent):", err);
    return null;
  });
  if (funnelResult?.handled) {
    // Keep the session's routing step aligned with the funnel's own state so the
    // Stage 1 constants stay meaningful for observability and the flags-off
    // upgrade path.
    if (step !== CHILDCARE_STEP_CAREGIVER_HOLD) {
      await db.collection("agent_sessions").doc(params.phone)
        .set({ onboardingStep: CHILDCARE_STEP_CAREGIVER_HOLD }, { merge: true })
        .catch(() => {});
    }
    return true;
  }

  await send(params.chatId, caregiverStatusMessage(), { executionContext });
  return true;
}

// ── Cold-text childcare intent (no web signup, no account) ──────────────────

export interface ChildcareColdInboundParams {
  phone: string;
  chatId: string;
  service: string;
  preferredLanguage: string;
  /**
   * Resolved role, or null when the vertical resolved but the role did not.
   * A null role is NOT guessed: the neutral signup entry (`/start?vertical=child`
   * with no role param) renders the web role picker, so the person chooses.
   */
  role: "client" | "caregiver" | null;
  /** Extra session fields the front door decided to stamp (closed field set). */
  sessionPatch?: Record<string, unknown>;
  /**
   * MERGE instead of replacing the session doc. Used by the mid-flow vertical
   * switch (R-FD7), where an existing session's identity fields (userId,
   * already-cleaned onboardingData) must survive the re-stamp. A cold inbound
   * leaves this false — a fresh session is a full write.
   */
  mergeSession?: boolean;
  db?: Db;
  sendMessage?: SendMessageFn;
  now?: Date;
}

/**
 * A cold inbound whose vertical classified as CHILD. There is no Firebase uid
 * and no account, so nothing can be enrolled: stamp the session, send the
 * secure signup entry, and hold. Flags off → the waitlist state (R-FD8) — never
 * a senior fallthrough, never a bypass.
 */
export async function handleChildcareColdInbound(
  params: ChildcareColdInboundParams,
): Promise<boolean> {
  const db = params.db ?? admin.firestore();
  const send = params.sendMessage ?? defaultSendMessage;
  const now = params.now ?? new Date();
  const flags = await getChildcareFlags({ db }).catch(() => null);
  const enabled = flags?.enabled === true;
  const executionContext = childExecutionContext({
    phone: params.phone,
    chatId: params.chatId,
    messageId: `cold:${params.phone}`,
  });

  const sessionDoc: Record<string, unknown> = {
    chatId: params.chatId,
    phone: params.phone,
    service: params.service,
    // Only a RESOLVED role is stamped — an unresolved role stays unresolved
    // rather than being guessed into an account type (R-FD1/R-FD2).
    ...(params.role ? { userType: params.role } : { userType: null }),
    careVertical: "child",
    verticalIntent: "child",
    optedIn: true,
    optedOut: false,
    preferredLanguage: params.preferredLanguage,
    // A merge re-stamp must not reset the conversation's creation time.
    ...(params.mergeSession ? {} : { createdAt: now.toISOString() }),
    ...(params.sessionPatch ?? {}),
    onboardingStep: enabled ? CHILDCARE_STEP_COLD_SIGNUP : CHILDCARE_STEP_UNAVAILABLE,
  };

  const sessionRef = db.collection("agent_sessions").doc(params.phone);
  if (params.mergeSession) await sessionRef.set(sessionDoc, { merge: true });
  else await sessionRef.set(sessionDoc);
  logMemoryDenial("childcare_cold_inbound", decideMemoryEligibility(sessionDoc));

  const message = !enabled
    ? unavailableMessage()
    : params.role === "caregiver"
      ? coldCaregiverSignupMessage()
      : params.role === "client"
        ? coldClientSignupMessage()
        : coldNeutralSignupMessage();
  await send(params.chatId, message, { executionContext });

  await logAudit({
    eventType: "childcare_signup_ingress",
    userId: params.phone,
    data: {
      role: params.role,
      outcome: enabled ? "cold_signup_link" : "unavailable",
      channel: "linq_cold",
      flagsEnabled: enabled,
    },
  }).catch(() => {});
  return true;
}

// ── Subsequent inbounds on a childcare-stamped session ──────────────────────

export interface ChildcareSessionInboundParams {
  phone: string;
  chatId: string;
  session: Record<string, unknown>;
  db?: Db;
  sendMessage?: SendMessageFn;
}

/**
 * Deterministic responder for inbound texts on a childcare session. STOP /
 * HELP / crisis are handled UPSTREAM by the shared carrier-protocol handlers
 * (they must keep working); everything else lands here — status + secure
 * resume link, no agent loop, no tools, no memory (AE23/R48/R51 fail-closed
 * posture until U10 ships the childcare tool pack).
 */
// ── U10 routing upgrade: classified childcare sessions → the REAL agent loop ─
//
// Order (binding, R51/R53):
//   1. Deterministic incident classification FIRST — before flags, before the
//      LLM — so model text (and emergency-off) can never suppress a
//      serious-incident escalation.
//   2. Flags / enrollment fallbacks → the U4 deterministic responder
//      (handleChildcareSessionInbound below) — it remains the flags-off /
//      emergency / enrollment path.
//   3. Families with at least one LIVE child authority run the real agent
//      loop; qaAgent's childcare branch owns envelope, prompt, tool pack, and
//      memory denial. Any loop failure falls closed to the static status
//      message — never senior routing.

export interface ChildcareInboundRouteParams {
  phone: string;
  chatId: string;
  text: string;
  session: Record<string, unknown>;
  /** Linq event id — threads the source-turn key into the loop (retry safety). */
  eventId?: string;
  db?: Db;
  sendMessage?: SendMessageFn;
  /** Test seam — defaults to the real runQaAgent (lazy import). */
  runAgent?: (params: Record<string, unknown>) => Promise<string>;
  /** Test seams for the vertical-bound pending-action approval lifecycle. */
  getPendingActions?: (phone: string, vertical: "child") => Promise<PendingAction[]>;
  handleApprovals?: (params: {
    phone: string;
    chatId: string;
    text: string;
    userId?: string;
    userType: "client";
    pendings: PendingAction[];
  }) => Promise<ApprovalResult>;
  now?: Date;
}

export async function routeChildcareSessionInbound(
  params: ChildcareInboundRouteParams,
): Promise<boolean> {
  const db = params.db ?? admin.firestore();
  const send = params.sendMessage ?? defaultSendMessage;
  const uid = String(params.session.userId ?? params.session.webOnboardingUid ?? "").trim();
  const executionContext = childExecutionContext({
    phone: params.phone,
    chatId: params.chatId,
    userId: uid,
    messageId: params.eventId,
  });

  // 1. Incident signal (R53) — deterministic, pre-LLM, unaffected by flags.
  const signal = classifyChildcareIncidentSignal(params.text);
  if (signal.incident && signal.category) {
    await escalateChildcareIncident({
      phone: params.phone,
      userId: uid || undefined,
      category: signal.category,
      channel: "linq",
      db,
      now: params.now,
    }).catch((err) => {
      console.error("childcare incident escalation failed (ack still sent):", err);
      return { held: false, alerted: false };
    });
    await send(params.chatId, CHILDCARE_INCIDENT_ACK, { executionContext });
    return true;
  }

  // 1a. CHILD → SENIOR vertical switch (front door Stage 2, deliverable 6a).
  //
  // Stage 1 wired only senior → child, because the senior detector lives on the
  // senior onboarding turn. This is the other direction's owner, and it sits
  // here — immediately after the incident classifier (escalation stays first,
  // R53) and BEFORE the role split — so ONE site covers both roles.
  //
  // The detector itself lives in agents/childcareVerticalSwitch.ts because this
  // module's contract is static templates with no LLM; it costs nothing unless
  // the text actually carries a senior signal, and R-FD7 still holds (detection
  // parks a hold and asks; only an explicit confirmation re-stamps).
  const switched = await handleChildcareToSeniorSwitchTurn({
    phone: params.phone,
    chatId: params.chatId,
    text: params.text,
    session: params.session,
    db,
    sendMessage: send,
    executionContext,
    ...(params.now ? { now: params.now } : {}),
  }).catch((err) => {
    console.error("childcare → senior switch detection failed (turn continues):", err);
    return { handled: false, outcome: "error" };
  });
  if (switched.handled) return true;

  // 1b. CAREGIVER childcare sessions (front door Stage 1). The family branches
  // below (enrollment objective, guardian authority, family tool pack) are all
  // client-shaped — a caregiver falling through them would be answered with
  // family copy and pointed at a family-only route. Split here, immediately
  // after the incident classifier so escalation stays first (R53). Stage 2 owns
  // the caregiver childcare loop and its own tool pack.
  if (params.session.userType === "caregiver") {
    return routeChildcareCaregiverInbound({
      phone: params.phone,
      chatId: params.chatId,
      text: params.text,
      session: params.session,
      ...(params.eventId ? { eventId: params.eventId } : {}),
      db,
      ...(params.sendMessage ? { sendMessage: params.sendMessage } : {}),
      ...(params.now ? { now: params.now } : {}),
    });
  }

  // 2. Approval interception is vertical-bound and precedes the agent loop.
  // Child sessions return from webhooks before the senior approval gate, so
  // this router owns the child-only lookup and exact-operation resolution.
  try {
    const getPendingActions = params.getPendingActions ??
      (await import("../agents/pendingActions")).getAllPending;
    const pendings = await getPendingActions(params.phone, "child");
    if (pendings.length > 0) {
      const handleApprovals = params.handleApprovals ??
        (await import("../agents/approvalHandler")).handlePendingApprovals;
      const result = await handleApprovals({
        phone: params.phone,
        chatId: params.chatId,
        text: params.text,
        ...(uid ? { userId: uid } : {}),
        userType: "client",
        pendings,
      });
      if (result.outcome === "handled") return true;
    }
  } catch (err) {
    console.error("childcare pending approval gate failed closed:", err);
    await send(params.chatId, statusMessage(), { executionContext }).catch(() => {});
    return true;
  }

  // 3. Flags-off / no-account / enrollment steps → deterministic responder.
  // CHILDCARE_STEP_COLD_SIGNUP is included by construction (no uid yet): a cold
  // childcare inbound has no account, so it keeps getting the secure signup
  // link until they finish /start?vertical=child.
  const flags = await getChildcareFlags({ db });
  const step = String(params.session.onboardingStep ?? "");
  if (!flags.enabled || !uid || step === CHILDCARE_STEP_UNAVAILABLE) {
    return handleChildcareSessionInbound({
      phone: params.phone,
      chatId: params.chatId,
      session: params.session,
      db,
      sendMessage: params.sendMessage,
    });
  }

  // 4. Authoritative enrollment check: the agent loop requires at least one
  //    LIVE child authority; until then the deterministic enrollment responder
  //    keeps pointing at the secure web profile flow.
  let hasChild = false;
  try {
    const authorities = await listAuthoritiesForAdult(uid, db);
    hasChild = authorities.some((a) => a?.state === "active");
  } catch {
    hasChild = false; // fail closed → deterministic responder
  }
  if (!hasChild) {
    return handleChildcareSessionInbound({
      phone: params.phone,
      chatId: params.chatId,
      session: params.session,
      db,
      sendMessage: params.sendMessage,
    });
  }

  // 5. Real agent loop (U10). No zepThreadId is ever passed (R50); the
  //    childcare branch inside runQaAgent re-checks flags and fails closed.
  try {
    const runAgent = params.runAgent ?? (async (p: Record<string, unknown>) => {
      const { runQaAgent } = await import("../agents/qaAgent");
      return runQaAgent(p as never);
    });
    await runAgent({
      text: params.text,
      phone: params.phone,
      chatId: params.chatId,
      userId: uid,
      seniorId: "",
      userType: "client",
      session: params.session,
      intent: null,
      executionContext,
      ...(params.eventId
        ? { sourceTurn: { conversationId: params.chatId, messageId: params.eventId } }
        : {}),
    });
    return true;
  } catch (err) {
    console.error("childcare agent loop failed — falling back to deterministic responder:", err);
    await send(params.chatId, statusMessage(), { executionContext }).catch(() => {});
    return true;
  }
}

export async function handleChildcareSessionInbound(
  params: ChildcareSessionInboundParams,
): Promise<boolean> {
  const db = params.db ?? admin.firestore();
  const send = params.sendMessage ?? defaultSendMessage;
  const step = String(params.session.onboardingStep ?? "");
  const flags = await getChildcareFlags({ db });
  const executionContext = childExecutionContext({
    phone: params.phone,
    chatId: params.chatId,
    userId: String(params.session.userId ?? params.session.webOnboardingUid ?? "").trim(),
  });

  logMemoryDenial("childcare_session_inbound", decideMemoryEligibility(params.session));

  if (!flags.enabled) {
    // Emergency-off / disabled: stay dark — status only, no links to disabled surfaces.
    await send(params.chatId, unavailableMessage(), { executionContext });
    return true;
  }

  if (step === CHILDCARE_STEP_UNAVAILABLE) {
    // Flags turned ON since the waitlist message: upgrade the session and
    // start enrollment (resume from canonical state, F1).
    const uid = String(params.session.userId ?? params.session.webOnboardingUid ?? "").trim();
    if (uid) {
      await db.collection("agent_sessions").doc(params.phone).update({
        onboardingStep: CHILDCARE_STEP_WEB_PROFILE,
      }).catch(() => {});
      await ensureFamilyChildcareObjective(uid, { db, channel: "linq" });
      await send(params.chatId, welcomeMessage(), { executionContext });
      return true;
    }
    await send(params.chatId, unavailableMessage(), { executionContext });
    return true;
  }

  // Cold-classified family with no account yet: the secure SIGNUP entry is the
  // right link, not the authenticated child-profile route (which would bounce
  // them to a login wall).
  if (step === CHILDCARE_STEP_COLD_SIGNUP) {
    await send(params.chatId, coldClientSignupMessage(), { executionContext });
    return true;
  }

  await send(params.chatId, statusMessage(), { executionContext });
  return true;
}
