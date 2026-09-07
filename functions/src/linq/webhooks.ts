import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { traceable } from "langsmith/traceable";
import { claimWebhookEvent, settleWebhookEvent, LINQ_EVENTS_COLLECTION } from "../utils/webhookLedger";
import { appLink } from "../config/appUrl";
import { sendMessage, startTyping, stopTyping, shareContactCard, checkCapability, markChatRead, AgentSession, LinqService } from "./client";
import { applyProviderReceipt, applyProviderEdit } from "./providerMessageIndex";
import { routeCaregiverMessage } from "./routeCaregiver";
import { routeClientStateMachines } from "./routeClient";
import { routeIntentAndRespond } from "./routeIntent";
import { handleRecurringConfirm } from "./inboundHelpers";
import { handleTaskApproval } from "../agents/taskApprovalHandler";
import { getAllPending } from "../agents/pendingActions";
import { handlePendingApprovals } from "../agents/approvalHandler";
import { optOutPhoneNumber, optInPhoneNumber, setupCaraContactCard } from "../sms";
import { buildHelpSmsReply, DiscoveryRole } from "../agents/capabilityDiscovery";
import { buildOperationalRecipeLead, loadCaraOperationalContext } from "../agents/operationalContext";
import {
  handleOnboardingStep,
  continueAfterClientCollection,
  absorbClientFields,
  drivePostCollectionHandoff,
  createFirebaseAuthAccount,
} from "../agents/onboardingConversation";
import { absorbCaregiverFields } from "../agents/caregiverFieldAbsorber";
import { runQaAgent } from "../agents/qaAgent";
import {
  shouldRouteOnboardingToLoop,
  missingRequiredFields,
  firstGateStep,
  collectionStepsForRole,
  type OnboardingRole,
} from "../agents/onboardingContract";
import {
  handleClientPermissionsReply,
  handleCaregiverPermissionsReply,
} from "../agents/permissionsConversation";
import { detectCrisis, isLikelyRealCrisis, classifyCrisisMultilingual } from "../safety/crisisDetector";
import { isPhoneAllowed } from "../config/phoneAllowlist";
import { cancelTriggerIfUserReplied } from "../triggers/triggerEngine";
import { logCrisisDetected } from "../observability/auditLog";
import { createCaraOpsAlert } from "../observability/caraOpsAlerts";
import { isBereavementTrigger, activateBereavementMode } from "../agents/bereavement";
import { describeWhoIsWho } from "../agents/careRecipients";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import {
  classifyCompleteness,
  classifyOfferReply,
  markOfferAccepted,
  markOfferDeclined,
  sendOnboardingOffer,
  shouldReoffer,
} from "../agents/profileCompleteness";
import { STATE_MACHINE_FLAGS, clearAllStateFlags, claimInboundProcessing, releaseInboundProcessing, isJobInviteStale } from "../utils/sessionState";
import { generateCaraMessage } from "../utils/caraMessage";
import { writeFeedbackSignal } from "../ai/feedback";
import {
  initializeZepOnFirstContact,
  addUserMessageToZep,
  addBusinessDataToZep,
  getZepUserId,
} from "../memory/zepClient";
import { sessionActivityFields } from "../memory/conversationMemory";
import { MEMORY_FINGERPRINT_KEY_NAME, MEMORY_FINGERPRINT_KEY_SECRET } from "../memory/fingerprintKey";
import { getSeniorProfileWithSource } from "../data/seniorProfileRepository";
import { quickComplete } from "../utils/openaiClient";
import { extractVoiceMemoPart, transcribeVoiceMemo } from "../utils/voiceTranscription";
import { extractLocationPart, reverseGeocode, SharedLocation } from "../utils/locationShare";
import { extractMediaPart, downloadMedia, storeInboundMedia, InboundMediaPart } from "../utils/mediaIntake";
import { classifyMedia } from "../utils/visionVerify";
import { detectPersonaShift } from "../utils/personaShiftDetector";
import { collectKnownNames } from "../utils/knownNames";
import { detectLanguage, languageFromSession, t as tr, flowLabel, type Language } from "../utils/language";
import { recordApprovalNoticeProviderStatus } from "../billing/approvalNoticeDispatcher";

const db = admin.firestore();

// ── Signature verification ────────────────────────────────────────────────────

function verifySignature(
  rawBody:   Buffer,
  timestamp: string,
  signature: string,
  secret:    string
): boolean {
  // Signature is HMAC-SHA256 over `{timestamp}.{payload}` (per Linq docs).
  const payload = Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);

  // Linq's docs don't pin down the secret's encoding or the signature's output
  // encoding, so derive the HMAC key both ways and compare the signature against
  // every common digest encoding. A match in any pair proves the sender holds the
  // secret (which is the whole point); the extra candidates don't weaken anything
  // since each still requires knowing the secret.
  const keyCandidates: Buffer[] = [
    Buffer.from(secret, "utf8"),    // secret used as a raw string key (Stripe-style; most providers)
    Buffer.from(secret, "base64"),  // secret used as base64-encoded key bytes
  ];

  const safeEqual = (a: string, b: string): boolean => {
    if (a.length !== b.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
  };

  for (const key of keyCandidates) {
    const hmac = crypto.createHmac("sha256", key).update(payload).digest();
    const expectedB64    = hmac.toString("base64");
    const expectedB64Url = hmac.toString("base64url");
    const expectedHex    = hmac.toString("hex");
    if (safeEqual(expectedB64,    signature) ||
        safeEqual(expectedB64Url, signature) ||
        safeEqual(expectedHex,    signature)) {
      return true;
    }
  }
  return false;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

// Per-phone hourly rate limit — only triggers on runaway scripts / abuse,
// not legitimate active conversations. A normal care/onboarding flow can
// easily run 30+ messages in an hour. Linq's per-pair rate limit (28 msgs
// per 60s in client.ts) handles outbound spam separately.
// A users doc alone does NOT prove a finished account: createWebOnboardingSession
// (index.ts) seeds users/{uid} at /start OTP time — seconds BEFORE the first
// inbound text. Treating "doc exists" as "returning user" marked every fresh web
// signup onboardingStep:"complete" and skipped onboarding entirely (2026-07-08
// live bug: brand-new caregiver greeted "Good to hear from you again!", the
// caregiver flow never started). Real progress = client finished intake
// (seniorId/seniorIds are written only at the payment step) or a caregivers/{uid}
// profile doc exists (created at the bg-check gate).
export async function userHasRealOnboardingProgress(
  userId: string,
  userData: Record<string, unknown>,
): Promise<boolean> {
  const seniorIds = (userData.seniorIds as string[] | undefined) ?? [];
  if ((userData.seniorId as string | undefined) || seniorIds.length > 0) return true;
  const cg = await db.collection("caregivers").doc(userId).get().catch(() => null);
  if (cg?.exists) return true;
  // A client who finished the website wizard has jobPostingCompleted:true
  // (services/api.ts's createJobPosting) with no seniorId/seniorIds set for
  // the PRIMARY recipient (only additional household recipients append to
  // seniorIds) — without this check, texting Evia for the first time after
  // finishing the wizard looked identical to a brand-new signup, and Evia
  // restarted the entire onboarding conversation, re-collecting (and
  // overwriting) data the website already saved. persistClientCareRecords
  // (the SMS-side equivalent) sets the exact same flag at the same moment.
  return userData.jobPostingCompleted === true;
}

// Resolves the primary care recipient's seniorId for a returning client.
// getSeniorProfile("") returns null with zero context, so this must never
// resolve to an empty string for a client userHasRealOnboardingProgress
// already confirmed has real progress. A client who only finished the
// website wizard (jobPostingCompleted:true) has neither seniorId nor
// seniorIds set for their PRIMARY recipient — the wizard's own
// senior_profiles write uses the client's own uid as the doc id (the "old
// 1:1 model" services/api.ts's getSeniorProfile already falls back to), so
// that's the correct id to resolve to here too.
export function resolvePrimarySeniorId(userId: string, userData: Record<string, unknown>): string {
  const seniorIds = (userData.seniorIds as string[] | undefined) ?? [];
  return (userData.seniorId as string | undefined)
    || seniorIds[0]
    || (userData.jobPostingCompleted === true ? userId : "");
}

async function isRateLimited(phone: string): Promise<boolean> {
  const rateRef = db.collection("agent_rate").doc(phone);
  const snap    = await rateRef.get();
  const now     = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const calls   = ((snap.data()?.calls ?? []) as number[]).filter((t) => t > hourAgo);
  if (calls.length >= 120) return true; // ~2 msgs/min sustained for an hour = clearly automated
  await rateRef.set({ calls: [...calls, now] });
  return false;
}

// ── Opt-in for existing (non-onboarding) users ────────────────────────────────

// ── Typing indicator — pre-fetch context so Claude responds faster ─────────────

async function handleTypingStarted(event: unknown): Promise<void> {
  const ev    = event as any;
  const phone  = ev.data?.sender_handle?.handle as string | undefined;
  const chatId = ev.data?.chat?.id as string | undefined;
  if (!phone || !chatId) return;

  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
  if (!sessionSnap.exists) return;

  const session = sessionSnap.data() as AgentSession;
  if (session.optedOut || session.optedIn === false) return;

  const seniorId = session.seniorId ?? session.userId ?? "";
  const userId   = session.userId ?? "";
  const now      = new Date().toISOString();

  // U6 (R17): the cached seniorProfile uses the same canonical-first repository
  // order as qaAgent's own read — a prefetch HIT and a prefetch MISS must see
  // the identical senior (previously this cached canonical-only while the MISS
  // path read legacy `seniors`, a per-turn split brain).
  const [seniorProfileRead, journalSnap, apptSnap, historySnap] = await Promise.all([
    getSeniorProfileWithSource(seniorId, db),
    db.collection("care_journal")
      .where("seniorId", "==", seniorId)
      .orderBy("timestamp", "desc").limit(3).get(),
    db.collection("appointments")
      .where("clientId", "==", userId)
      .where("isoDate",  ">=", now.slice(0, 10))
      .where("status",   "in", ["confirmed", "pending_caregiver_confirmation"])
      .orderBy("isoDate", "asc").limit(1).get(),
    db.collection("agent_conversations").doc(phone)
      .collection("messages").orderBy("timestamp", "desc").limit(10).get(),
  ]).catch(() => [null, null, null, null]);

  if (!seniorProfileRead) return;

  await db.collection("agent_prefetch").doc(phone).set({
    seniorProfile:       seniorProfileRead.profile,
    recentJournal:       journalSnap ? journalSnap.docs.map((d) => d.data()) : [],
    nextAppointment:     apptSnap && !apptSnap.empty ? apptSnap.docs[0].data() : null,
    conversationHistory: historySnap
      ? historySnap.docs.map((d) => d.data()).reverse()
      : [],
    cachedAt:  now,
    expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
  });
}

// User replied "NOTIFY" after a crisis message. Alert the care team:
// a guaranteed critical admin alert, plus best-effort SMS to family-group members
// and the senior's assigned caregiver(s). Copy is tailored by crisis `kind`:
// medical emergencies say "call 911"; emotional crises use supportive,
// non-clinical wording (the person opted in to this escalation).
async function handleCrisisNotify(
  phone:   string,
  chatId:  string,
  session: AgentSession,
  pending: { text?: string; detectedAt?: string; kind?: "medical" | "emotional" },
): Promise<void> {
  // Clear the armed flag first so a repeat NOTIFY doesn't double-fire.
  await db.collection("agent_sessions").doc(phone).update({
    pendingCrisisNotify: admin.firestore.FieldValue.delete(),
  }).catch(() => {});

  const lang       = languageFromSession(session as unknown as Record<string, unknown>);
  const userId     = session.userId ?? phone;
  const kind       = pending?.kind ?? "medical";
  const seniorName = (session as any).seniorName
    ?? (session as any).onboardingData?.seniorName
    ?? "your loved one";

  const familyMsg = kind === "emotional"
    ? `💙 Someone in your care circle reached out for emotional support and asked me to let you know. Please check in with them when you can. If you believe they're in immediate danger, call 988 or 911.`
    : `⚠️ A medical emergency was just reported for ${seniorName}. If you can help, please reach out now. Call 911 if it's life-threatening.`;
  const caregiverMsg = kind === "emotional"
    ? `💙 Your care client reached out for emotional support and asked us to notify their care circle. A gentle check-in would mean a lot. Call 988 or 911 if there's immediate danger.`
    : `⚠️ A medical emergency was just reported for ${seniorName}, your care client. Please check in if you're able. Call 911 if it's life-threatening.`;

  // 1) GUARANTEED: critical admin alert so support staff is paged.
  await db.collection("admin_alerts").add({
    type:       "crisis_notify_requested",
    severity:   "critical",
    crisisKind: kind,
    phone,
    userId,
    seniorName,
    crisisText: pending?.text ?? "",
    createdAt:  new Date().toISOString(),
  }).catch((err) => console.error("[handleCrisisNotify] admin_alert write failed:", err));

  // 2) BEST-EFFORT: alert family-group members.
  try {
    const membersSnap = await db.collection("family_group_members")
      .where("primaryPhone", "==", phone).get();
    await Promise.all(membersSnap.docs.map((d) => {
      const mPhone = d.data().memberPhone as string | undefined;
      if (!mPhone) return Promise.resolve();
      return sendViaInteractionAgent(mPhone, {
        content:     familyMsg,
        urgency:     "immediate",
        sourceAgent: "crisis_notify",
        canDrop:     false,
      }).catch(() => {});
    }));
  } catch (err) {
    console.error("[handleCrisisNotify] family notify failed:", err);
  }

  // 3) BEST-EFFORT: alert the assigned caregiver(s) on the senior's active appointments.
  try {
    const apptSnap = await db.collection("appointments")
      .where("clientId", "==", userId)
      .where("status", "in", ["confirmed", "in-progress", "pending_caregiver_confirmation"])
      .limit(5).get();
    const caregiverPhones = new Set<string>();
    for (const doc of apptSnap.docs) {
      const cgId = doc.data().caregiverId as string | undefined;
      if (!cgId) continue;
      const cgSnap = await db.collection("caregivers").doc(cgId).get();
      const cgPhone = cgSnap.data()?.phone as string | undefined;
      if (cgPhone) caregiverPhones.add(cgPhone);
    }
    await Promise.all([...caregiverPhones].map((cgPhone) =>
      sendViaInteractionAgent(cgPhone, {
        content:     caregiverMsg,
        urgency:     "immediate",
        sourceAgent: "crisis_notify",
        canDrop:     false,
      }).catch(() => {})
    ));
  } catch (err) {
    console.error("[handleCrisisNotify] caregiver notify failed:", err);
  }

  // 4) Confirm to the user.
  await sendMessage(chatId, kind === "emotional"
    ? tr.crisis_emotional_notify_sent(lang)
    : tr.crisis_notify_sent(lang));
}

// Respond to a confirmed emotional crisis: send the 988 message, log it, then
// OFFER (consent-aware) to notify the care circle and arm the NOTIFY follow-up
// so a "NOTIFY" reply routes through handleCrisisNotify with emotional copy.
// Unlike medical, we never auto-page anyone — escalation is opt-in.
async function sendEmotionalCrisisResponse(
  phone:   string,
  chatId:  string,
  lang:    Language,
  text:    string,
): Promise<void> {
  await sendMessage(chatId, tr.crisis_emotional(lang));
  await sendMessage(chatId, tr.crisis_emotional_notify_offer(lang));
  logCrisisDetected(phone, "emotional", text).catch(() => {});
  await db.collection("agent_sessions").doc(phone).update({
    pendingCrisisNotify: { text: text.slice(0, 500), detectedAt: new Date().toISOString(), kind: "emotional" },
  }).catch(() => {});
}

// Raise an admin-visible safety alert for a confirmed MEDICAL emergency (R7).
// This is the admin_alerts surface (Control Room) — distinct from the HIPAA
// audit-log entry (logCrisisDetected → agent_audit_log). Best-effort and
// non-blocking: a failed alert must never delay or replace the 911 guidance,
// and we NEVER attempt a healthcare action on this path. PHI-minimized: only a
// short, truncated text preview goes into the alert, like the audit log.
function raiseMedicalCrisisAlert(phone: string, text: string): void {
  void createCaraOpsAlert({
    type:     "cara_medical_emergency",
    severity: "critical",
    phone,
    source:   "crisisDetector",
    message:  "Possible medical emergency reported over SMS — Evia directed the user to call 911.",
    context:  { textPreview: text.slice(0, 200) },
  }).catch(() => {});
}

// ── Multi-care-group disambiguation (U8) ──────────────────────────────────────
// A phone that matches 2+ care groups can't be auto-attached — we ask which
// senior the message is about and persist the candidates so the ANSWER has
// somewhere to land. Without this marker, the next inbound re-hits
// `!sessionSnap.exists` (a disambiguation reply creates no session on its own)
// and re-asks the same question forever.
interface GroupDisambiguationCandidate {
  primaryPhone: string;
  seniorName:   string;
}

// Create the lightweight secondary-member session pointing at the primary
// account, exactly as the single-match path does, then greet. Shared by both
// the single-match fast path and the resolved-disambiguation path so the two
// never drift.
async function createSecondaryMemberSession(
  phone:          string,
  chatId:         string,
  primarySession: AgentSession,
  primaryPhone:   string,
): Promise<void> {
  const secondaryCap = await checkCapability(phone);
  const secondaryService: LinqService = secondaryCap.iMessage ? "iMessage" : secondaryCap.RCS ? "RCS" : "SMS";

  let groupChatId = (primarySession as any).groupChatId as string | undefined;
  if (!groupChatId && primaryPhone) {
    const groupForPrimary = await db.collection("family_groups")
      .where("phones", "array-contains", primaryPhone)
      .limit(1)
      .get()
      .catch(() => null);
    groupChatId = groupForPrimary && !groupForPrimary.empty
      ? (groupForPrimary.docs[0].data().chatId as string | undefined)
      : undefined;
  }

  await db.collection("agent_sessions").doc(phone).set({
    chatId,
    phone,
    service:        secondaryService,
    userType:       "client",
    onboardingStep: "complete",
    optedIn:        true,
    optedOut:       false,
    userId:         primarySession.userId,
    seniorId:       primarySession.seniorId,
    primaryPhone,
    isSecondaryMember: true,
    createdAt:      new Date().toISOString(),
    ...(groupChatId ? { groupChatId } : {}),
  });

  await initializeZepOnFirstContact(phone).catch((err) =>
    console.error("Zep init failed (secondary member):", err)
  );

  await sendMessage(chatId,
    `Hi, I'm Evia — the care coordinator for ${(primarySession as any).onboardingData?.seniorName ?? "your family"}. ` +
    `I've added you to the care group. You'll get the same updates and can ask me anything.`
  );
}

// ── Pending TCPA consent reply (session seeded by onUserCreated) ─────────────
// The web-signup auth trigger (triggers/userCreated.ts) texts the consent ask
// and creates agent_sessions/{phone} with optedIn:false BEFORE the user's
// first inbound — which means the no-session web bridge above never runs for
// them. This handler owns that first reply: it is the consent answer, and
// nothing may be recorded as consented until it's an explicit agreement
// (founder policy: consent decisions are explicit-binary). On YES it records
// consent and hands the user off to the same conversational flow the web
// bridge provides (returning-user greeting or name-first onboarding).
// Shared explicit-binary consent classification (STOP always wins; otherwise
// yes/no/other via LLM per CLAUDE.md — no keyword intent matching). Used by
// both handlePendingConsentReply (web-signup) and handleColdConsentReply
// (cold-inbound), which differ only in what happens AFTER a "yes".
async function classifyConsentReply(text: string): Promise<"stop" | "yes" | "no" | "other"> {
  const norm = text.trim().toUpperCase();
  const stopWords = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "END", "OPTOUT"]);
  if (stopWords.has(norm)) return "stop";

  try {
    const { parseWithClaude } = await import("../utils/parseWithClaude");
    const raw = await parseWithClaude(
      "The person was asked to reply YES to continue and consent to text messages. " +
      "Classify their reply. Clear agreement (\"yes\", \"yes please\", \"sure\", \"ok\", \"sounds good\", \"sí\") → yes. " +
      "Clear refusal (\"no\", \"no thanks\", \"don't text me\") → no. " +
      "Anything else — a question, a name, an unrelated message — → other. " +
      "Reply with exactly one word: yes, no, or other.",
      text,
    );
    const v = String(raw ?? "").trim().toLowerCase();
    return v === "yes" || v === "no" ? v : "other";
  } catch {
    return (norm === "YES" || norm === "SI" || norm === "SÍ") ? "yes" : "other";
  }
}

async function handlePendingConsentReply(
  phone:   string,
  chatId:  string,
  session: AgentSession,
  text:    string,
): Promise<void> {
  const lang: "en" | "es" = (session as any).preferredLanguage === "es" ? "es" : "en";
  const verdict = await classifyConsentReply(text);

  // Carrier STOP protocol always wins.
  if (verdict === "stop" || verdict === "no") {
    await optOutPhoneNumber(phone);
    // TCPA opt-out confirmation must land reliably — force SMS, never iMessage.
    await sendMessage(chatId, tr.opt_out_confirmation(lang), { preferredService: "SMS" });
    return;
  }

  if (verdict === "other") {
    // Max ONE re-ask, then go quiet (deny-by-default). A later YES or STOP
    // still lands back in this handler, so the door stays open.
    const reasks = ((session as any).consentReaskCount as number | undefined) ?? 0;
    if (reasks >= 1) return;
    await db.collection("agent_sessions").doc(phone)
      .update({ consentReaskCount: reasks + 1 }).catch(() => {});
    const reask = await generateCaraMessage({
      audience: "family",
      language: lang,
      context:
        `You asked a new client to reply YES to get care updates by text, and they replied "${text}" instead. ` +
        "Warmly acknowledge them in one short sentence, then ask them to reply YES if they'd like the updates so you can help with the rest. Do not answer anything else yet.",
      fallback: lang === "es"
        ? "¡Con gusto te ayudo! Primero responde SÍ si quieres recibir novedades del cuidado por mensaje — y seguimos de ahí."
        : "Happy to help! First, just reply YES if you'd like me to text you care updates — then we'll dive right in.",
      maxTokens: 80,
    });
    await sendMessage(chatId, reask);
    return;
  }

  // ── YES: record consent, then hand off to the conversational flow ──────────
  const now = new Date().toISOString();
  const userSnap = session.userId
    ? await db.collection("users").doc(session.userId).get().catch(() => null)
    : null;
  const userData = (userSnap?.exists ? userSnap.data() : {}) as Record<string, unknown>;
  const isReturning = session.userId
    ? await userHasRealOnboardingProgress(session.userId, userData)
    : false;
  const firstName =
    String(userData.firstName ?? userData.name ?? "").trim().split(/\s+/)[0] || "";

  // seniorId: the auth trigger seeds it as the client's own uid — correct it to
  // the real senior for returning users, and clear it for fresh onboarding
  // (matches the session shapes the web bridge writes).
  const seniorId  = resolvePrimarySeniorId(session.userId as string, userData);
  await db.collection("agent_sessions").doc(phone).update({
    optedIn:   true,
    optedInAt: now,
    optedOut:  false,
    userType:  (userData.userType as string | undefined) ?? "client",
    onboardingStep: isReturning
      ? "complete"
      : (firstName ? "client_confirm_name" : "client_ask_name"),
    ...(isReturning
      ? { seniorId }
      : { seniorId: admin.firestore.FieldValue.delete() }),
    ...(!isReturning && firstName ? { onboardingData: { firstName } } : {}),
  });

  // Flip the /start web tab to its success state if it's still waiting.
  const webRef  = db.collection("web_onboarding_sessions").doc(phone);
  const webSnap = await webRef.get().catch(() => null);
  if (webSnap?.exists && webSnap.data()?.status === "awaiting_inbound") {
    await webRef.update({
      status:      "connected",
      connectedAt: admin.firestore.Timestamp.now(),
      chatId,
    }).catch(() => {/* non-critical */});
  }
  // Mark the user as LINQ-connected so the client gate lets them in
  if (session.userId) {
    await db.collection("users").doc(session.userId).set(
      { eviaConnected: true, eviaConnectedAt: admin.firestore.Timestamp.now() },
      { merge: true }
    ).catch(() => {/* non-critical */});
  }

  await initializeZepOnFirstContact(phone).catch((err) =>
    console.error("Zep init failed (pending consent opt-in):", err)
  );

  // First impressions matter — route the handoff through Evia's actual voice,
  // mirroring the web bridge's welcome (frozen fallbacks if the LLM fails).
  const welcome = await generateCaraMessage({
    audience: "family",
    language: lang,
    context: isReturning
      ? `${firstName || "The client"} just replied YES to receiving care updates by text. Thank them warmly in one sentence and let them know you'll keep them posted after visits — and that they can text you anytime to book care or ask anything.`
      : firstName
        ? `${firstName} just replied YES to receiving care updates, and you're meeting them over text for the first time. Thank them briefly, then naturally check that "${firstName}" is the name they go by — woven into a sentence, NOT as a parenthetical instruction. Sound like a real person, not a form.`
        : "A new client just replied YES to receiving care updates, and you're meeting them over text for the first time. Thank them briefly, introduce yourself as Evia, their care coordinator, and ask their name. Sound like a real person, not a form.",
    fallback: isReturning
      ? (lang === "es"
          ? "¡Perfecto! Te mantendré al tanto después de cada visita. Y escríbeme cuando necesites algo — aquí estoy."
          : "Perfect — you're all set. I'll keep you posted after every visit, and you can text me anytime to book care or ask anything.")
      : firstName
        ? (lang === "es"
            ? `¡Perfecto! Soy Evia, tu coordinadora de cuidados. ¿Te llamo ${firstName}, verdad?`
            : `Perfect — thanks! I'm Evia, your care coordinator. Do you go by ${firstName}?`)
        : (lang === "es"
            ? "¡Perfecto! Soy Evia, tu coordinadora de cuidados. ¿Cómo te llamas?"
            : "Perfect — thanks! I'm Evia, your care coordinator. What's your name?"),
    maxTokens: 120,
  });
  await sendMessage(chatId, welcome);
}

// ── Pending cold-inbound consent reply ───────────────────────────────────────
// The cold-inbound branch below gates behind an explicit YES (Terms/Privacy +
// SMS consent) before creating anything — mirroring the website, which
// requires the "I agree to the terms" checkbox before Firebase Phone Auth
// ever runs. Unlike handlePendingConsentReply (web-signup — role and uid
// already known), role isn't known yet here, so YES only creates a BARE
// Firebase Auth account (no users/{uid} doc) and hands off to the existing
// ask_role question; the name-confirm handlers attach role/name to that same
// account a few turns later (onboardingConversation.ts).
async function handleColdConsentReply(
  phone:   string,
  chatId:  string,
  session: AgentSession,
  text:    string,
  service: LinqService,
  lang:    "en" | "es",
): Promise<void> {
  const verdict = await classifyConsentReply(text);

  if (verdict === "stop" || verdict === "no") {
    await optOutPhoneNumber(phone);
    await sendMessage(chatId, tr.opt_out_confirmation(lang), { preferredService: "SMS" });
    return;
  }

  if (verdict === "other") {
    // Max ONE re-ask, then go quiet (deny-by-default) — same policy as the
    // web-signup consent gate.
    const reasks = ((session as any).consentReaskCount as number | undefined) ?? 0;
    if (reasks >= 1) return;
    await db.collection("agent_sessions").doc(phone)
      .update({ consentReaskCount: reasks + 1 }).catch(() => {});
    await sendMessage(chatId, lang === "es"
      ? "Antes de continuar, responde SÍ para aceptar los Términos y la Política de Privacidad de Evia en eviacares.com — o STOP para cancelar."
      : "Before we continue, reply YES to agree to Evia's Terms and Privacy Policy at eviacares.com — or STOP to opt out.");
    return;
  }

  // ── YES: bare account first, then the same role question cold-inbound
  // already asks today. No users/{uid} doc yet — role and name are unknown.
  const uid = await createFirebaseAuthAccount(phone, "").catch(() => null);
  await db.collection("agent_sessions").doc(phone).update({
    optedIn:        true,
    optedInAt:      new Date().toISOString(),
    optedOut:       false,
    onboardingStep: "ask_role",
    ...(uid ? { userId: uid } : {}),
  });

  await initializeZepOnFirstContact(phone).catch((err) =>
    console.error("Zep init failed (cold consent opt-in):", err)
  );

  if (service === "iMessage") await startTyping(chatId).catch(() => {});
  const roleQuestion = lang === "es"
    ? "¿Buscas cuidado para un ser querido, o eres cuidador?"
    : "Are you looking for care for a loved one, or are you a caregiver yourself?";
  await sendMessage(chatId, roleQuestion);
}

// Ask which senior the phone is texting about, naming the actual candidates.
async function askGroupDisambiguation(
  chatId:     string,
  candidates: GroupDisambiguationCandidate[],
): Promise<void> {
  const names = candidates.map((c) => c.seniorName).join(" or ");
  await sendMessage(
    chatId,
    `I see your number in more than one care group — for ${names}. Which one are you texting about?`,
  );
}

// The reply to the disambiguation question. Resolves via parseWithClaude (per
// CLAUDE.md — no keyword/regex intent parsing) against the candidate senior
// names. Match → create that candidate's secondary session and clear the
// marker. No match, first attempt → re-ask with names, increment attempts.
// No match, second attempt → give up looping: fall back to the FIRST
// candidate and raise an admin_alerts event so support can reconcile it.
async function handleGroupDisambiguationReply(
  phone:   string,
  chatId:  string,
  text:    string,
  pending: { candidates: GroupDisambiguationCandidate[]; askedAt: string; attempts: number },
): Promise<void> {
  const { parseWithClaude } = await import("../utils/parseWithClaude");
  const candidates = pending.candidates ?? [];

  if (candidates.length === 0) {
    // Nothing to resolve against — clear the marker so we don't loop forever.
    await db.collection("agent_sessions").doc(phone).update({
      pendingGroupDisambiguation: admin.firestore.FieldValue.delete(),
    }).catch(() => {});
    return;
  }

  // CLAUDE.md handler checklist: answer a mid-flow question first, then re-ask
  // the current question — without burning one of the two match attempts.
  const { isQuestionOrOther } = await import("../agents/stepHandler");
  if (await isQuestionOrOther(text)) {
    const { answerHumanQuestionOnly } = await import("../agents/humanReply");
    const answer = await answerHumanQuestionOnly({
      text,
      situation:
        "The user's phone number appears in more than one care group, and Evia just asked which senior they are texting about. Answer their question briefly.",
    }).catch(() => "");
    if (answer) await sendMessage(chatId, answer);
    await askGroupDisambiguation(chatId, candidates);
    return;
  }

  const namesList = candidates
    .map((c, i) => `${i}: ${c.seniorName}`)
    .join("; ");
  const raw = await parseWithClaude(
    `The user was asked which senior's care group they're texting about. Candidates (index: name): ${namesList}. ` +
    `Reply with ONLY the matching index number if the user's message clearly names one of these seniors. ` +
    `Reply "none" if it doesn't clearly match any of them.`,
    text,
  );

  const matchedIndex = /^\d+$/.test(raw.trim()) ? parseInt(raw.trim(), 10) : -1;
  const matched = matchedIndex >= 0 && matchedIndex < candidates.length
    ? candidates[matchedIndex]
    : null;

  if (matched) {
    await db.collection("agent_sessions").doc(phone).update({
      pendingGroupDisambiguation: admin.firestore.FieldValue.delete(),
    }).catch(() => {});
    const primarySnap = await db.collection("agent_sessions").doc(matched.primaryPhone).get();
    if (primarySnap.exists) {
      await createSecondaryMemberSession(phone, chatId, primarySnap.data() as AgentSession, matched.primaryPhone);
    } else {
      // Primary session vanished between the ask and the answer — fail safe
      // with an alert rather than crashing the turn.
      await db.collection("admin_alerts").add({
        type:      "group_disambiguation_primary_missing",
        phone,
        primaryPhone: matched.primaryPhone,
        severity:  "medium",
        createdAt: new Date().toISOString(),
        resolved:  false,
      }).catch(() => {});
      await sendMessage(chatId, "Something went wrong linking that care group — I've flagged it for our team to fix.");
    }
    return;
  }

  if (pending.attempts < 2) {
    await db.collection("agent_sessions").doc(phone).update({
      pendingGroupDisambiguation: {
        candidates,
        askedAt:  new Date().toISOString(),
        attempts: pending.attempts + 1,
      },
    }).catch(() => {});
    await askGroupDisambiguation(chatId, candidates);
    return;
  }

  // Two unresolved attempts — stop looping. Fall back to the first candidate
  // and raise an alert so support can reconcile the account manually.
  await db.collection("agent_sessions").doc(phone).update({
    pendingGroupDisambiguation: admin.firestore.FieldValue.delete(),
  }).catch(() => {});
  const fallback = candidates[0];
  await db.collection("admin_alerts").add({
    type:      "group_disambiguation_unresolved",
    phone,
    candidates,
    severity:  "medium",
    createdAt: new Date().toISOString(),
    resolved:  false,
  }).catch(() => {});
  const primarySnap = await db.collection("agent_sessions").doc(fallback.primaryPhone).get();
  if (primarySnap.exists) {
    await createSecondaryMemberSession(phone, chatId, primarySnap.data() as AgentSession, fallback.primaryPhone);
  } else {
    await sendMessage(chatId, "Something went wrong linking that care group — I've flagged it for our team to fix.");
  }
}

// ── Post-visit feedback sentiment classifier ──────────────────────────────────

async function classifyFeedbackSentiment(
  text: string
): Promise<"positive" | "negative" | "neutral"> {
  try {
    const raw = await quickComplete(
      "Classify this feedback about a home care visit as positive, negative, or neutral. " +
        "Consider tone, context, and nuance — not just keywords. " +
        "Reply with one word: POSITIVE, NEGATIVE, or NEUTRAL.",
      text,
      { maxTokens: 10 },
    );
    const label = raw.trim().toUpperCase();
    if (label === "POSITIVE") return "positive";
    if (label === "NEGATIVE") return "negative";
  } catch (err) {
    console.error("classifyFeedbackSentiment error:", err);
  }
  return "neutral";
}

// ── Family satisfaction check-in reply — sentiment routing ────────────────────
// sendFamilySatisfactionCheckins (scheduled/familySatisfactionCheckin.ts) sets
// awaitingSatisfactionReply when it asks "how has care been going overall" —
// its own comment promised a negative reply gets "flagged for follow-up", but
// nothing ever read the flag (found 2026-09-06: it was write-only, dead code).
// Unlike post-visit feedback (a narrow single-purpose ask that fully owns the
// reply), this check-in's phrasing invites open-ended replies that may also
// carry a real question or request — so this is a side effect only: classify
// + log + escalate + clear the flag, and let the normal qaAgent turn still
// run and answer whatever was actually said, rather than swallowing the reply.
async function classifySatisfactionSentiment(
  text: string
): Promise<"positive" | "negative" | "neutral"> {
  try {
    const raw = await quickComplete(
      "Classify this family's reply to a general \"how has care been going overall\" check-in as " +
        "positive, negative, or neutral. Consider tone and substance, not just keywords — a reply that " +
        "raises a complaint, problem, or frustration with their care is negative even if worded politely. " +
        "Reply with one word: POSITIVE, NEGATIVE, or NEUTRAL.",
      text,
      { maxTokens: 10 },
    );
    const label = raw.trim().toUpperCase();
    if (label === "POSITIVE") return "positive";
    if (label === "NEGATIVE") return "negative";
  } catch (err) {
    console.error("classifySatisfactionSentiment error:", err);
  }
  return "neutral";
}

async function handleSatisfactionCheckinReply(params: {
  phone:    string;
  clientId: string;
  text:     string;
}): Promise<void> {
  const sentiment = await classifySatisfactionSentiment(params.text);
  const nowIso = new Date().toISOString();
  await db.collection("family_satisfaction_replies").add({
    clientId:  params.clientId,
    phone:     params.phone,
    sentiment,
    rawText:   params.text.slice(0, 500),
    createdAt: nowIso,
  });
  if (sentiment === "negative") {
    await createCaraOpsAlert({
      type:     "family_dissatisfaction_signal",
      severity: "high",
      phone:    params.phone,
      userId:   params.clientId,
      role:     "client",
      source:   "familySatisfactionCheckin",
      message:  "A family's reply to the satisfaction check-in read as negative — needs a human follow-up.",
      context:  { textPreview: params.text.slice(0, 200) },
    }).catch(() => {});
  }
  // Clear regardless of sentiment — this check-in only expects one reply, and
  // an unrelated later message must never be misread as answering it.
  await db.collection("agent_sessions").doc(params.phone).update({
    awaitingSatisfactionReply: admin.firestore.FieldValue.delete(),
  }).catch(() => {});
}

type FeedbackClaimResult = "claimed" | "busy" | "done" | "expired" | "not_ready";

async function claimVisitFeedback(triggerId: string, leaseOwner: string): Promise<FeedbackClaimResult> {
  const ref = db.collection("proactive_triggers").doc(triggerId);
  return db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return "done";

    const data = snap.data() ?? {};
    if (data.feedbackReceived != null) return "done";
    if (!data.firedAt) return "not_ready";

    const now = new Date();
    const expiresAtMs = typeof data.expiresAt === "string" ? Date.parse(data.expiresAt) : NaN;
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= now.getTime()) {
      const nowIso = now.toISOString();
      transaction.update(ref, {
        feedbackReceived: nowIso,
        feedbackStatus: "expired",
        cancelledAt: data.cancelledAt ?? nowIso,
      });
      return "expired";
    }

    const leaseUntilMs = typeof data.feedbackLeaseUntil === "string"
      ? Date.parse(data.feedbackLeaseUntil)
      : NaN;
    if (Number.isFinite(leaseUntilMs) && leaseUntilMs > now.getTime()) return "busy";

    transaction.update(ref, {
      feedbackStatus: "processing",
      feedbackLeaseOwner: leaseOwner,
      feedbackLeaseUntil: new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
    });
    return "claimed";
  });
}

async function releaseVisitFeedbackClaim(triggerId: string, leaseOwner: string): Promise<void> {
  const ref = db.collection("proactive_triggers").doc(triggerId);
  await db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return;
    const data = snap.data() ?? {};
    if (data.feedbackReceived != null || data.feedbackLeaseOwner !== leaseOwner) return;
    transaction.update(ref, {
      feedbackStatus: "pending",
      feedbackLeaseOwner: null,
      feedbackLeaseUntil: null,
    });
  });
}

async function handleVisitFeedback(params: {
  phone:         string;
  text:          string;
  caregiverId:   string;
  clientId:      string;
  appointmentId: string;
  triggerId:     string;
  leaseOwner:    string;
}): Promise<void> {
  if (!params.clientId || !params.caregiverId || !params.appointmentId) {
    throw new Error("Post-visit feedback trigger is missing ownership metadata");
  }

  const sentiment = await classifyFeedbackSentiment(params.text);
  const numericRating = sentiment === "positive" ? 5 : sentiment === "negative" ? 2 : 3;

  const feedbackId = params.appointmentId.replace(/\//g, "%2F");
  const nowIso = new Date().toISOString();
  await db.collection("post_visit_feedback").doc(feedbackId).set({
    caregiverId:   params.caregiverId,
    clientId:      params.clientId,
    appointmentId: params.appointmentId,
    rating:        numericRating,
    sentiment,
    rawText:       params.text.slice(0, 500),
    status:        "submitted",
    createdAt:     nowIso,
    updatedAt:     nowIso,
  }, { merge: true });

  if (sentiment !== "neutral") {
    await writeFeedbackSignal({
      clientId:      params.clientId,
      caregiverId:   params.caregiverId,
      signal:        sentiment === "positive" ? 1 : -1,
      source:        "post_visit_feedback",
      appointmentId: params.appointmentId,
      rawText:       params.text,
      idempotencyKey: `post-visit:${params.appointmentId}`,
    });
  }

  const { onFeedbackSubmitted } = await import("../agents/feedbackAggregator");
  await onFeedbackSubmitted(params.caregiverId, numericRating, params.appointmentId, params.clientId);

  const triggerRef = db.collection("proactive_triggers").doc(params.triggerId);
  await db.runTransaction(async transaction => {
    const snap = await transaction.get(triggerRef);
    if (!snap.exists || snap.data()?.feedbackLeaseOwner !== params.leaseOwner) {
      throw new Error("Post-visit feedback lease was lost before completion");
    }
    transaction.update(triggerRef, {
      feedbackReceived: nowIso,
      feedbackStatus: "completed",
      feedbackLeaseOwner: null,
      feedbackLeaseUntil: null,
    });
  });

  const response =
    sentiment === "positive"
      ? "Glad to hear it — I'll keep that in mind for future matches. 💙"
      : sentiment === "negative"
      ? "Thank you for letting me know. I'll take that into account and make sure future caregivers are a better fit."
      : "Got it — noted.";

  await sendViaInteractionAgent(params.phone, {
    content:     response,
    urgency:     "standard",
    sourceAgent: "feedback",
    canDrop:     false,
  });
}

// ── Main inbound handler ──────────────────────────────────────────────────────

// Exported for the routing characterization tests (__tests__/handleInbound.routing.test.ts),
// which pin the guard ORDER below — the order IS the product behavior.
// Public entry point. Serializes processing per phone so a user's rapid-fire
// messages (or Linq at-least-once redelivery of distinct messages) can't run
// concurrently and clobber each other's session writes. Acquires a per-phone
// lock (bounded wait), then delegates to handleInboundInner; releases in a
// finally so every internal return path still frees the lock.
// Serialize a unit of work against all other inbound processing for the same
// phone (messages AND reactions). SMS bursts + iMessage tapbacks arrive within a
// few seconds, so a short retry window catches the common race. Shared by
// handleInbound and the reaction.added dispatch so a 👍 and a "yes" text can't
// run concurrently against the same awaiting_approval agent_task (double-book /
// double-charge). Throws if the lock can't be acquired so the caller decides
// whether to retry (message path → 500/retry) or drop (reaction → logged).
export async function runSerializedByPhone(phone: string, fn: () => Promise<void>): Promise<void> {
  let acquired = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await claimInboundProcessing(phone, db)) { acquired = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!acquired) {
    throw new Error(`runSerializedByPhone: per-phone lock unavailable after retries for ${phone}`);
  }
  try {
    await fn();
  } finally {
    await releaseInboundProcessing(phone, db);
  }
}

// sourceEventId: the wrapper's deduplicated Linq event key (event_id /
// message_id / synthetic hash). Threaded to routeIntentAndRespond as the
// stable source-turn key for completed-turn memory persistence (memory
// grounding plan U3, R9). Optional so agent/test callers stay compatible.
export async function handleInbound(event: unknown, sourceEventId?: string): Promise<void> {
  const phone = (event as any)?.data?.sender_handle?.handle as string | undefined;
  // No phone → nothing to serialize on; inner will drop it.
  if (!phone) return handleInboundInner(event, sourceEventId);
  return runSerializedByPhone(phone, () => handleInboundInner(event, sourceEventId));
}

// One LangSmith trace per inbound message ("turn"). Every nested LLM call
// (intent classification, the QA agent tool loop, supervisor, etc.) attaches to
// this parent run automatically via the wrapped Anthropic/OpenAI clients, so a
// turn shows up as a single tree instead of scattered calls. processInputs
// strips the raw Linq payload down to a readable summary for the trace input.
// No-op overhead when LANGSMITH_TRACING is unset.
const handleInboundInner = traceable(
  async function handleInboundTurn(event: unknown, sourceEventId?: string): Promise<void> {
  const ev      = event as any;
  const phone   = ev.data?.sender_handle?.handle as string | undefined;
  const chatId  = ev.data?.chat?.id as string | undefined;
  const service = (ev.data?.service ?? ev.data?.chat?.service ?? "SMS") as string;

  if (!phone || !chatId) return;

  // ALLOWLIST: remove before public launch
  if (!isPhoneAllowed(phone)) return;

  // Collect text from all text-type parts (handles multi-part messages).
  // Non-text parts (sticker, audio, media) have no value — detect media-only messages.
  const inboundParts = (ev.data?.parts ?? []) as Array<Record<string, unknown>>;
  let text = inboundParts
    .filter((p) => p.type === "text" && p.value)
    .map((p) => String(p.value))
    .join(" ")
    .trim();
  let isMediaOnly = text === "" && inboundParts.length > 0;

  // Mark the inbound as read so iMessage shows the "Read" receipt immediately —
  // this is what surfaces the blue "Read" indicator under the user's bubble.
  markChatRead(chatId).catch(() => {/* non-critical */});

  // Fire typing indicator immediately — before any async work — so the family
  // never sees silence during the ~200ms session load + routing decisions.
  // For voice memos this matters even more: Whisper takes a few seconds.
  if (service === "iMessage") startTyping(chatId).catch(() => {});

  // ── Voice memo → Whisper transcription ─────────────────────────────────────
  // Users who can't easily type tap-and-hold to send a voice memo. Transcribe
  // it and fall through to normal text processing so the rest of Evia doesn't
  // need to care that the input was spoken.
  if (text === "") {
    const voicePart = extractVoiceMemoPart(inboundParts);
    if (voicePart) {
      try {
        const transcript = await transcribeVoiceMemo(voicePart);
        if (transcript) {
          text = transcript;
          isMediaOnly = false;
          // Re-mark read now that the audio attachment is fully committed on
          // Linq's side. The initial markChatRead at t=0 races with audio
          // ingestion, so a voice memo otherwise shows "Delivered" but not
          // "Read" (unlike text, which is committed before the webhook fires).
          markChatRead(chatId).catch(() => {/* non-critical */});
          console.info("voiceMemo transcribed", {
            phone,
            chatId,
            chars: transcript.length,
            duration_ms: voicePart.duration_ms,
          });
        }
      } catch (err) {
        console.error("voiceMemo transcription failed", {
          phone,
          chatId,
          err: (err as Error)?.message,
        });
      }
    }
  }

  // ── Shared location pin (iMessage / RCS) ───────────────────────────────────
  // Users can tap ➕ → Share Location instead of typing an address. Linq delivers
  // the pin as a non-text part. Extract it once here; onboarding location steps
  // use the raw coords directly, and the QA/anytime path gets a synthesized text
  // line so the agent can reason about it (e.g. update an address) with its tools.
  let inboundLocation: SharedLocation | null = null;
  if (text === "") {
    inboundLocation = extractLocationPart(inboundParts);
    if (inboundLocation) {
      isMediaOnly = false;
      // Re-mark read now the attachment is committed on Linq's side (same race
      // fix as voice memos — the t=0 markChatRead can land before ingestion).
      markChatRead(chatId).catch(() => {/* non-critical */});
      console.info("locationShare received", {
        phone, chatId, lat: inboundLocation.lat, lng: inboundLocation.lng,
      });
    }
  }

  // ── Shared image / document (iMessage / RCS) ───────────────────────────────
  // Caregivers text a headshot or a CNA/HHA card instead of using the web upload
  // link. Detect it once here; onboarding photo/doc/identity steps consume it
  // directly (vision-gated), and the completed-session "anytime" path below
  // classifies + smart-routes it. (Voice memos / location pins already claimed
  // their parts above, so text is still "" only for true image/doc media.)
  let inboundMedia: InboundMediaPart | null = null;
  if (text === "" && !inboundLocation) {
    inboundMedia = extractMediaPart(inboundParts);
    if (inboundMedia) {
      isMediaOnly = false;
      markChatRead(chatId).catch(() => {/* non-critical */});
      console.info("inboundMedia received", {
        phone, chatId, kind: inboundMedia.kind, content_type: inboundMedia.content_type,
      });
    }
  }

  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();

  // Track last-inbound time so the silence detector (scheduled function) can
  // find users who haven't messaged in 3+ days and send a gentle check-in.
  // Also keep session chatId in sync with the actual Linq thread (Linq webhook
  // delivers on the chat where the user replied, which may differ from the
  // chatId we created — replying to a stale chatId returns 400).
  if (sessionSnap.exists) {
    const stored = sessionSnap.data() as AgentSession & { chatId?: string };
    const update: Record<string, unknown> = {
      lastInboundAt: new Date().toISOString(),
    };
    // Remember the Linq message id so react_to_message can tapback this message.
    // Tolerant field chain — same shapes the other event handlers accept.
    const inboundMessageId = (ev.data?.id ?? ev.data?.message_id ?? ev.data?.message?.id) as string | undefined;
    if (inboundMessageId) update.lastInboundMessageId = inboundMessageId;
    // Always refresh service from the live event: sessions created via the web
    // bridge (or before Linq reported capability) default to "SMS" and used to
    // keep it forever, so iMessage users got the SMS "On it, one sec…" filler
    // instead of the native typing bubble (signalThinking branches on this).
    if (stored.service !== service) update.service = service;
    if (stored.chatId && stored.chatId !== chatId) {
      update.chatId = chatId;
    }
    await db.collection("agent_sessions").doc(phone).update(update).catch(() => {});

    // Mirror the user's inbound message into the web chat inbox so the Evia
    // conversation shows up in Chat/ChatInbox. Best-effort, never blocks.
    if (text && stored.userId) {
      const { mirrorToWebThread } = await import("./threadMirror");
      void mirrorToWebThread({ userId: stored.userId, direction: "inbound", text });
    }
  }

  // ── New user — texted first (MO consent) ────────────────────────────────────
  if (!sessionSnap.exists) {
    // Check if this phone belongs to a secondary family group member.
    // Two sources must be reconciled: the SMS-keyword path writes the primary
    // session's `groupMembers` array, while the MCP `add_family_member` tool path
    // writes the `family_group_members` collection. Check BOTH or an MCP-added
    // member ("add my sister") would fall through to fresh onboarding and create a
    // DUPLICATE account.
    let primarySession: AgentSession | null = null;
    let primaryPhone = "";

    const groupSnap = await db.collection("agent_sessions")
      .where("groupMembers", "array-contains", phone)
      .limit(2)
      .get();
    if (groupSnap.size > 1) {
      const candidates: GroupDisambiguationCandidate[] = groupSnap.docs.map((d) => ({
        primaryPhone: d.id,
        seniorName:   ((d.data() as AgentSession as any).onboardingData?.seniorName as string | undefined)
          ?? "your family member",
      }));
      await db.collection("agent_sessions").doc(phone).set({
        chatId,
        phone,
        pendingGroupDisambiguation: {
          candidates,
          askedAt:  new Date().toISOString(),
          attempts: 1,
        },
        createdAt: new Date().toISOString(),
      });
      await askGroupDisambiguation(chatId, candidates);
      return;
    }
    if (!groupSnap.empty) {
      primarySession = groupSnap.docs[0].data() as AgentSession;
      primaryPhone   = groupSnap.docs[0].id;
    } else {
      // Fallback: look up the collection-based membership record (MCP-added members).
      const memberSnap = await db.collection("family_group_members")
        .where("memberPhone", "==", phone)
        .limit(2)
        .get();
      if (memberSnap.size > 1) {
        // Resolve each membership record to its primary session so we can name
        // the actual seniors in the disambiguation question.
        const candidatePairs = await Promise.all(memberSnap.docs.map(async (d) => {
          const pPhone = d.data().primaryPhone as string | undefined;
          if (!pPhone) return null;
          const pSnap = await db.collection("agent_sessions").doc(pPhone).get().catch(() => null);
          const seniorName = pSnap && pSnap.exists
            ? (((pSnap.data() as AgentSession as any).onboardingData?.seniorName as string | undefined) ?? "your family member")
            : "your family member";
          return { primaryPhone: pPhone, seniorName } as GroupDisambiguationCandidate;
        }));
        const candidates = candidatePairs.filter((c): c is GroupDisambiguationCandidate => c !== null);
        if (candidates.length > 0) {
          await db.collection("agent_sessions").doc(phone).set({
            chatId,
            phone,
            pendingGroupDisambiguation: {
              candidates,
              askedAt:  new Date().toISOString(),
              attempts: 1,
            },
            createdAt: new Date().toISOString(),
          });
          await askGroupDisambiguation(chatId, candidates);
          return;
        }
        // Every membership row was missing primaryPhone (data drift) — don't
        // ask an unanswerable question. Alert and fall through to the
        // single-member handling below, which tolerates a missing primary.
        await db.collection("admin_alerts").add({
          type:      "group_disambiguation_no_candidates",
          phone,
          severity:  "medium",
          createdAt: new Date().toISOString(),
          resolved:  false,
        }).catch(() => {});
      }
      if (!memberSnap.empty) {
        const pPhone = memberSnap.docs[0].data().primaryPhone as string | undefined;
        if (pPhone) {
          const pSnap = await db.collection("agent_sessions").doc(pPhone).get();
          if (pSnap.exists) {
            primarySession = pSnap.data() as AgentSession;
            primaryPhone   = pPhone;
          }
        }
      }
    }

    if (primarySession) {
      await createSecondaryMemberSession(phone, chatId, primarySession, primaryPhone);
      return;
    }

    const capability = await checkCapability(phone);
    const service: LinqService = capability.iMessage ? "iMessage" : capability.RCS ? "RCS" : "SMS";

    await setupCaraContactCard().catch(() => {/* non-critical */});

    // Detect language from the first message so OTP + onboarding speak the
    // family's language from the start.
    const detected = await detectLanguage(text).catch(() => null);
    const preferredLanguage = detected ?? "en";

    // ── Web-onboarding bridge ──────────────────────────────────────────────────
    // If this phone just verified through Firebase Phone Auth on the web and is
    // awaiting their first inbound, skip the SMS-side OTP entirely — phone
    // possession is already proven by the Firebase token they presented when
    // calling createWebOnboardingSession. Route them straight into the role's
    // first onboarding step.
    const webSessionRef  = db.collection("web_onboarding_sessions").doc(phone);
    const webSessionSnap = await webSessionRef.get();
    if (webSessionSnap.exists && webSessionSnap.data()?.status === "awaiting_inbound") {
      const webSessionData = webSessionSnap.data() ?? {};
      const webRole  = (webSessionData.role as string | undefined) === "caregiver" ? "caregiver" : "client";
      const referralId = webRole === "caregiver" ? (webSessionData.referralId as string | undefined) : undefined;
      // Name typed on the /start web form (if any). When present, we pre-seed it into
      // onboardingData and route to the confirm step so Evia greets by name and asks
      // them to confirm — instead of asking "What's your name?" from scratch.
      const webName      = (webSessionData.name      as string | undefined)?.trim() || "";
      const webFirstName = (webSessionData.firstName as string | undefined)?.trim() || "";
      const webLastName  = (webSessionData.lastName  as string | undefined)?.trim() || "";
      // 2026-09-06: the /start web wizard now collects a recovery email
      // up front (parity with Evia's SMS loop, which already requires one
      // for both roles — onboardingContract.ts's CLIENT/CAREGIVER_REQUIRED_
      // FIELDS). Seeding it here means the loop sees it as already collected
      // and never asks again over text.
      const webEmail     = (webSessionData.email    as string | undefined)?.trim() || "";
      const firstStep = webName
        ? (webRole === "caregiver" ? "caregiver_confirm_name" : "client_confirm_name")
        : (webRole === "caregiver" ? "caregiver_ask_name" : "client_ask_name");
      // Caregiver flow keys the name as `name`; client flow keys firstName (and
      // lastName when present) — matches the fields the ask-name handlers write.
      const seededOnboardingData = (webName || webEmail)
        ? {
            ...(webName
              ? (webRole === "caregiver"
                  ? { name: webName }
                  : { firstName: webFirstName || webName, ...(webLastName ? { lastName: webLastName } : {}) })
              : {}),
            ...(webEmail ? { email: webEmail } : {}),
          }
        : undefined;

      // Returning user — phone already linked to an account WITH real onboarding
      // progress. Skip re-onboarding; restore their account context and greet them
      // as a known user. NOTE: mere users-doc existence is NOT enough —
      // createWebOnboardingSession seeds users/{uid} moments before this inbound,
      // so that check marked every fresh web signup "complete" and skipped
      // onboarding (see userHasRealOnboardingProgress).
      const userQuery = await db.collection("users").where("phone", "==", phone).limit(1).get();
      const isReturning = !userQuery.empty &&
        await userHasRealOnboardingProgress(userQuery.docs[0].id, userQuery.docs[0].data());

      if (isReturning) {
        const userDoc   = userQuery.docs[0];
        const userData  = userDoc.data();
        const seniorId  = resolvePrimarySeniorId(userDoc.id, userData);

        await db.collection("agent_sessions").doc(phone).set({
          chatId,
          phone,
          service,
          userType:       (userData.userType as string | undefined) ?? webRole,
          userId:         userDoc.id,
          seniorId,
          onboardingStep: "complete",
          optedIn:        true,
          optedOut:       false,
          preferredLanguage,
          createdAt:      new Date().toISOString(),
          webOnboardingUid: webSessionData.uid ?? null,
          ...(referralId ? { referralId } : {}),
        });
      } else {
        await db.collection("agent_sessions").doc(phone).set({
          chatId,
          phone,
          service,
          userType:       webRole,
          onboardingStep: firstStep,
          optedIn:        true,
          optedOut:       false,
          preferredLanguage,
          createdAt:      new Date().toISOString(),
          webOnboardingUid: webSessionData.uid ?? null,
          ...(seededOnboardingData ? { onboardingData: seededOnboardingData } : {}),
          ...(referralId ? { referralId } : {}),
        });
      }

      // Mark the web bridge as connected so the desktop/mobile tab can flip to
      // the success state via its onSnapshot listener.
      await webSessionRef.update({
        status:      "connected",
        connectedAt: admin.firestore.Timestamp.now(),
        chatId,
      }).catch(() => {/* non-critical */});
      // Mark the user as LINQ-connected so the client gate lets them in
      const webUid = webSessionData.uid ?? null;
      if (webUid) {
        await db.collection("users").doc(webUid).set(
          { eviaConnected: true, eviaConnectedAt: admin.firestore.Timestamp.now() },
          { merge: true }
        ).catch(() => {/* non-critical */});
      }

      await initializeZepOnFirstContact(phone).catch((err) =>
        console.error("Zep init failed (web bridge):", err)
      );

      if (service === "iMessage") await startTyping(chatId).catch(() => {});

      // First impressions matter most — route the opening message through Evia's
      // actual voice (generateCaraMessage) instead of a frozen template, so the
      // very first thing the user reads sounds like her, not a chatbot. The old
      // hardcoded strings stay as fallbacks if the LLM call fails. The follow-up
      // confirm/ask-name handlers parse replies via parseWithClaude, so we don't
      // need a "(Reply yes...)" instruction in the copy.
      const welcomeAudience: "caregiver" | "family" = webRole === "caregiver" ? "caregiver" : "family";
      const welcomeLanguage: "en" | "es" = preferredLanguage === "es" ? "es" : "en";
      let welcome: string;
      if (isReturning) {
        welcome = await generateCaraMessage({
          audience: welcomeAudience,
          language: welcomeLanguage,
          context:
            "Someone you've helped before just reconnected by text (they only said a quick hello). " +
            "Warmly welcome them back, and ask what they'd like to handle first. One or two sentences, no lists.",
          fallback: preferredLanguage === "es"
            ? "¡Hola otra vez! Soy Evia. Me alegra verte de nuevo — ¿en qué te puedo ayudar hoy?"
            : "Welcome back. It's Evia - good to hear from you again. What should we handle first?",
          maxTokens: 90,
        });
      } else if (webName) {
        // Name came in from the web form — greet by name and naturally check it's
        // right (the confirm step handler resolves yes / correction via Claude).
        welcome = await generateCaraMessage({
          audience: welcomeAudience,
          language: welcomeLanguage,
          context: welcomeAudience === "caregiver"
            ? `You're meeting ${webName} for the very first time over text. They just signed up to find caregiving work. ` +
              `Introduce yourself warmly as Evia, mention that setting up their profile takes about 5 minutes and happens right here by text, ` +
              `and naturally check that "${webName}" is the name they go by — woven into a sentence, NOT as a parenthetical instruction. Sound like a real person, not a form.`
            : `You're meeting ${webName} for the very first time over text. They're looking for care for a loved one. ` +
              `Introduce yourself warmly as Evia, their care coordinator, ` +
              `and naturally check that "${webName}" is the name they go by — woven into a sentence, NOT as a parenthetical instruction. Sound like a real person, not a form.`,
          fallback: webRole === "caregiver"
            ? (preferredLanguage === "es"
                ? `¡Hola ${webName}! Soy Evia — tu asistente para encontrar trabajo de cuidado. Configurar tu perfil toma unos 5 minutos y todo pasa aquí por mensaje.\n\n¿Te llamo ${webName}, verdad?`
                : `Hi ${webName}! I'm Evia — your assistant for finding caregiving work. Setting up your profile takes about 5 minutes and it all happens right here. Do you go by ${webName}?`)
            : (preferredLanguage === "es"
                ? `¡Hola ${webName}! Soy Evia, tu coordinadora de cuidados. ¿Te llamo ${webName}, verdad?`
                : `Hi ${webName}, I'm Evia — I'll be your care coordinator. Do you go by ${webName}?`),
          maxTokens: 120,
        });
      } else {
        // Role-aware welcome — mirrors what handleAskRole sends so the user
        // experiences the same conversational onboarding from message #1.
        welcome = await generateCaraMessage({
          audience: welcomeAudience,
          language: welcomeLanguage,
          context: welcomeAudience === "caregiver"
            ? "You're meeting someone for the very first time over text who just signed up to find caregiving work. " +
              "Introduce yourself warmly as Evia, mention that setting up their profile takes about 5 minutes and happens right here, and ask their name. Sound like a real person, not a form."
            : "You're meeting someone for the very first time over text who's looking for care for a loved one. " +
              "Introduce yourself warmly as Evia, their care coordinator, and ask their name. Sound like a real person, not a form.",
          fallback: webRole === "caregiver"
            ? (preferredLanguage === "es"
                ? "¡Hola! Soy Evia — tu asistente para encontrar trabajo de cuidado. Configurar tu perfil toma unos 5 minutos y todo pasa aquí por mensaje.\n\n¿Cómo te llamas?"
                : "Hi! I'm Evia — your assistant for finding caregiving work. Setting up your profile takes about 5 minutes and everything happens right here.\n\nWhat's your name?")
            : (preferredLanguage === "es"
                ? "¡Hola! Soy Evia, tu coordinadora de cuidados. ¿Cómo te llamas?"
                : "Hi! I'm Evia — I'll be your care coordinator. What's your name?"),
          maxTokens: 90,
        });
      }
      await sendMessage(chatId, welcome);

      if (service === "iMessage") shareContactCard(chatId).catch(() => {/* non-critical */});
      return;
    }

    // No web session and no prior history — a cold inbound. Phone verification
    // happens on the WEBSITE (Firebase Phone Auth) before createWebOnboardingSession,
    // not over SMS — so we do NOT gate the thread behind an OTP. We DO gate it
    // behind explicit consent, though (Hamse, 2026-08-23): the website requires
    // the "I agree to the terms" checkbox before anything happens, and a cold
    // text was previously treated as implied consent with no Terms/Privacy
    // link ever shown. handleColdConsentReply owns the actual role/name
    // handoff once they reply YES.
    await db.collection("agent_sessions").doc(phone).set({
      chatId,
      phone,
      service,
      userType:       null,
      onboardingStep: "cold_awaiting_consent",
      optedIn:        false,
      optedOut:       false,
      preferredLanguage,
      createdAt:      new Date().toISOString(),
    });

    // Start Zep memory immediately — awaited so zepThreadId is written before
    // the next message arrives (fast: ~200ms HTTP call).
    await initializeZepOnFirstContact(phone).catch((err) =>
      console.error("Zep init failed (first contact):", err)
    );

    if (service === "iMessage") await startTyping(chatId).catch(() => {});
    const consentAsk = preferredLanguage === "es"
      ? "Hola — soy Evia, tu coordinadora de cuidado.\n\n" +
        "Responde SÍ para continuar — al responder, aceptas los Términos y la Política de Privacidad de Evia en eviacares.com. " +
        "Pueden aplicar tarifas de mensajes y datos. Responde STOP para cancelar."
      : "Hi — I'm Evia, your care coordinator.\n\n" +
        "Reply YES to continue — by texting back you agree to Evia's Terms and Privacy Policy at eviacares.com. " +
        "Msg & data rates may apply. Reply STOP to opt out.";
    await sendMessage(chatId, consentAsk);
    // Share contact card AFTER the first outbound message — Linq requires at least
    // one outbound message in history before the share endpoint accepts the call.
    if (service === "iMessage") shareContactCard(chatId).catch(() => {/* non-critical */});
    return;
  }

  const session  = sessionSnap.data() as AgentSession;
  // Keep the in-memory session's service in sync with the live event too — the
  // Firestore refresh above only helps NEXT turn; handlers on THIS turn (e.g.
  // signalThinking's typing-bubble-vs-filler branch) read this object.
  (session as { service?: string }).service = service;
  const norm     = text.trim().toUpperCase();
  const stopWords = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "END", "OPTOUT"]);

  // ── Multi-care-group disambiguation answer (U8) ─────────────────────────────
  // Runs before every other guard: this session exists ONLY because we asked
  // "which senior?" last turn and had to persist somewhere for the answer to
  // land. Route the reply to the resolver before normal routing so it isn't
  // swallowed by the opt-out/crisis/onboarding gates below (this session has
  // no onboardingStep, userType, etc. yet — those guards would misbehave).
  {
    const pendingGroupDis = (session as any).pendingGroupDisambiguation as {
      candidates: Array<{ primaryPhone: string; seniorName: string }>;
      askedAt:    string;
      attempts:   number;
    } | undefined;
    if (pendingGroupDis && text.trim() !== "") {
      if (stopWords.has(norm)) {
        // SMS carrier protocol: STOP must always work, even mid-disambiguation.
        // Clear the marker and fall through to the standard opt-out handling.
        await db.collection("agent_sessions").doc(phone).update({
          pendingGroupDisambiguation: admin.firestore.FieldValue.delete(),
        }).catch(() => {});
      } else if (norm === "HELP" || norm === "AYUDA") {
        // Carrier HELP keyword must also always work — fall through to the
        // standard HELP handler below WITHOUT consuming the reply as a
        // disambiguation answer. Keep the marker so the next reply can still
        // resolve which care group they meant.
      } else if (!pendingGroupDis.candidates?.length) {
        // Malformed marker (no resolvable candidates) — clear it and let normal
        // routing take over rather than dead-ending the user in silence.
        await db.collection("agent_sessions").doc(phone).update({
          pendingGroupDisambiguation: admin.firestore.FieldValue.delete(),
        }).catch(() => {});
      } else {
        await handleGroupDisambiguationReply(phone, chatId, text, pendingGroupDis);
        return;
      }
    }
  }

  // ── Chat health gate — honour OPTED_OUT; do NOT mute direct replies ───────────
  // We only hard-stop on OPTED_OUT (a real user opt-out we must respect). CRITICAL
  // health reflects line/deliverability risk that matters for PROACTIVE/bulk sends
  // (reminders, digests) — those are already gated by the global circuit breaker and
  // sendIfNotDND. Suppressing a direct reply to a user who just texted in makes Evia
  // look broken, so we log CRITICAL for observability but still respond. If Linq
  // genuinely rejects the send, sendMessage surfaces that downstream.
  const chatHealth = (ev.data?.chat?.health_status?.status ?? "HEALTHY") as string;
  if (chatHealth === "OPTED_OUT" && !session.optedOut) {
    await db.collection("agent_sessions").doc(phone).update({ optedOut: true }).catch(() => {});
    return;
  }
  if (chatHealth === "CRITICAL") {
    console.warn("handleInbound: chat health CRITICAL — replying anyway (active inbound)", { phone, chatId });
  }

  // START — opt back in (must run BEFORE the opted-out early return, otherwise
  // opted-out users can never reach this handler).
  if (session.optedOut) {
    const startWords = new Set(["START", "UNSTOP", "RESUBSCRIBE", "YES", "SI", "SÍ"]);
    if (startWords.has(norm)) {
      await optInPhoneNumber(phone);
      const lang = languageFromSession(session as unknown as Record<string, unknown>);
      // TCPA opt-in confirmation must land reliably — force SMS, never iMessage.
      await sendMessage(chatId, tr.opt_in_welcome_back(lang), { preferredService: "SMS" });
      return;
    }
    return;
  }

  // ── Pending cold-inbound consent (this session's own consent gate) ─────────
  // Distinguished from the web-signup case below by onboardingStep — the
  // auth-trigger-seeded session never sets one. The reply IS the consent
  // answer; role isn't known yet, so this hands off to ask_role on YES rather
  // than assuming "client" the way the web-signup handler does.
  if (session.optedIn === false && session.onboardingStep === "cold_awaiting_consent") {
    await stopTyping(chatId).catch(() => {});
    const coldLang = languageFromSession(session as unknown as Record<string, unknown>);
    await handleColdConsentReply(phone, chatId, session, text, service as LinqService, coldLang);
    return;
  }

  // ── Pending TCPA consent (web-signup auth trigger seeded optedIn:false) ─────
  // This session exists only because onUserCreated sent the consent ask, so the
  // no-session web bridge above was skipped. The reply IS the consent answer —
  // record it (and hand off to the conversational flow) before any other
  // routing, or optedIn stays false forever and every proactive sender skips
  // this user. Media-only replies fall through as "other" (empty text → one
  // gentle re-ask), and STOP is honoured inside the handler.
  if (session.optedIn === false) {
    await stopTyping(chatId).catch(() => {});
    await handlePendingConsentReply(phone, chatId, session, text);
    return;
  }

  // ── Sticker / voice memo / media-only — no text to process ──────────────────
  // Stickers are inbound-only (API doesn't support sending them). Voice memos
  // are transcribed above; if that failed we still land here. Other media
  // parts have no value field — react warmly and exit before the intent
  // classifier receives an empty string.
  if (isMediaOnly) {
    await stopTyping(chatId).catch(() => {});
    // Re-mark read now the media attachment is fully committed on Linq's side.
    // The initial markChatRead at t=0 races with attachment ingestion, so
    // media (stickers, voice memos, images) otherwise shows "Delivered" but
    // not "Read" (unlike text, which is committed before the webhook fires).
    markChatRead(chatId).catch(() => {/* non-critical */});
    const partTypes = inboundParts.map((p) => String(p.type ?? "").toLowerCase());
    const hasVoiceMemo = extractVoiceMemoPart(inboundParts) !== null;
    // Route these through Evia's voice rather than frozen templates. (The old
    // sticker reply hardcoded "for Mom" — a wrong assumption about who the user
    // cares for; the relationship-neutral fallback below avoids that.)
    const mediaAudience: "caregiver" | "family" =
      (session as any).userType === "caregiver" ? "caregiver" : "family";
    const mediaLang: "en" | "es" = (session as any).preferredLanguage === "es" ? "es" : "en";
    if (partTypes.includes("sticker")) {
      const msg = await generateCaraMessage({
        audience: mediaAudience,
        language: mediaLang,
        context: "The person just sent a sticker or tapback reaction — no words. React warmly in one short line and let them know you're here if they need anything. Do NOT assume who they care for or use any specific name.",
        fallback: "Love it! 😊 I'm right here whenever you need me.",
        maxTokens: 60,
      });
      await sendMessage(chatId, msg);
    } else if (hasVoiceMemo) {
      const msg = await generateCaraMessage({
        audience: mediaAudience,
        language: mediaLang,
        context: "The person sent a voice memo but it couldn't be transcribed. Warmly let them know you couldn't quite make it out, and ask them to resend it or type what they need. Short and reassuring.",
        fallback: "I got your voice memo but couldn't quite make it out — could you send it again, or type what you need? I'm here either way.",
        maxTokens: 70,
      });
      await sendMessage(chatId, msg);
    } else {
      const msg = await generateCaraMessage({
        audience: mediaAudience,
        language: mediaLang,
        context: "The person sent a photo or attachment with no text. Warmly acknowledge you got it and invite them to tell you what they need. Keep it short.",
        fallback: "Got your message! If you have a question or need help, just type it out.",
        maxTokens: 60,
      });
      await sendMessage(chatId, msg);
    }
    return;
  }

  // ── Expired state machine — save checkpoint for onboarding, clear otherwise ─
  {
    const stateExpiresAt = (session as any).stateExpiresAt as string | undefined;
    const hasStateFlag   = STATE_MACHINE_FLAGS.filter(f => f !== "stateExpiresAt")
                             .some(f => !!(session as any)[f]);
    if (hasStateFlag && stateExpiresAt && new Date(stateExpiresAt) < new Date()) {
      // If mid-onboarding, save a checkpoint so the user can resume instead of restarting
      const isOnboarding = session.onboardingStep && session.onboardingStep !== "complete";
      if (isOnboarding) {
        await db.collection("agent_sessions").doc(phone).update({
          onboardingCheckpoint: {
            step:          session.onboardingStep,
            onboardingData: (session as any).onboardingData ?? {},
            savedAt:       new Date().toISOString(),
          },
        }).catch(() => {});
      }

      // Identify which non-onboarding flow was active so the user gets a
      // contextual timeout message instead of the generic "session timed out".
      // Names track the state-flag families defined in utils/sessionState.ts.
      const flowKey: string | null =
        (session as any).jobPostingStep        ? "job_posting"      :
        (session as any).refundStep            ? "refund"           :
        (session as any).modifyScheduleStep    ? "modify_schedule"  :
        (session as any).clientSwapStep        ? "client_swap"      :
        (session as any).healthcareFlowStep    ? "healthcare"       :
        (session as any).collectingCredential  ? "credential"       :
        (session as any).hireMode              ? "hire"             :
        (session as any).pendingMatches        ? "matches"          :
        (session as any).pendingTaskConfirm    ? "booking_confirm"  :
        null;

      const lang = languageFromSession(session as unknown as Record<string, unknown>);
      await clearAllStateFlags(phone, db);
      if (isOnboarding) {
        await sendMessage(chatId, tr.session_timeout_onboarding(lang));
      } else if (flowKey) {
        await sendMessage(chatId, tr.session_timeout_flow(flowLabel(flowKey, lang), lang));
      } else {
        await sendMessage(chatId, tr.session_timeout_generic(lang));
      }
      return;
    }
  }

  // ── Onboarding resume from checkpoint ────────────────────────────────────────
  {
    const checkpoint = (session as any).onboardingCheckpoint as {
      step: string; onboardingData: Record<string, unknown>; savedAt: string;
    } | undefined;
    const isResumeCommand = norm === "RESUME" || norm === "CONTINUE" || norm === "PICK UP WHERE I LEFT OFF";
    const isStartOver     = norm === "START OVER" || norm === "RESTART" || norm === "BEGIN AGAIN";

    if (checkpoint && (isResumeCommand || isStartOver)) {
      await db.collection("agent_sessions").doc(phone).update({
        onboardingCheckpoint: admin.firestore.FieldValue.delete(),
      });
      if (isStartOver) {
        await db.collection("agent_sessions").doc(phone).update({ onboardingStep: "ask_role", onboardingData: {} });
        await sendMessage(chatId,
          "Starting fresh! Are you looking for care for someone, or are you a caregiver yourself?"
        );
      } else {
        // Resume: restore checkpoint data and re-ask the current step's question
        await db.collection("agent_sessions").doc(phone).update({
          onboardingStep: checkpoint.step,
          onboardingData: checkpoint.onboardingData,
          stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        const resumedSession = { ...session, onboardingStep: checkpoint.step, onboardingData: checkpoint.onboardingData } as AgentSession;
        // 2f (loop-only): the agent loop owns conversational collection, so for a
        // collection-step checkpoint do NOT call the scripted runner (its
        // collection cases are gone) — compose a short "here's what's left" nudge
        // from the contract and leave the cursor on the collection step so the
        // next inbound routes to the loop. Gate/awaiting checkpoints (e.g. the
        // caregiver_send_photo gate) still resume through the scripted runner.
        const cpRole: OnboardingRole = resumedSession.userType === "caregiver" ? "caregiver" : "client";
        if (collectionStepsForRole(cpRole).includes(checkpoint.step)) {
          const missing = missingRequiredFields(cpRole, checkpoint.onboardingData);
          if (missing.length === 0) {
            // Everything's already collected. Don't just promise to "take it from
            // here" and leave the cursor parked on a collection step the
            // webhook-passive gate phase won't advance — advance to the gate and
            // DRIVE the next phase now (matches/paywall or the photo gate), the
            // same handoff the main loop path runs when collection completes.
            await drivePostCollectionHandoff(phone, chatId, cpRole);
          } else {
            const nudge = await generateCaraMessage({
              audience: cpRole === "caregiver" ? "caregiver" : "family",
              context: "You're picking a signup back up with someone who paused midway; you already have some of their details. " +
                `You still need: ${missing.join(", ")}. In ONE short, warm line, welcome them back and ask for the FIRST missing item only — no list, no re-introduction.`,
              fallback: "Welcome back! Let's pick up right where we left off.",
              maxTokens: 90,
            });
            await sendMessage(chatId, nudge);
          }
        } else {
          await sendMessage(chatId, "Picking up where we left off!");
          await handleOnboardingStep(phone, chatId, "__RESUME__", resumedSession);
        }
      }
      return;
    }

    // If checkpoint exists but user sent a normal message (not resume/start-over),
    // nudge them to choose before processing normally
    if (checkpoint && session.onboardingStep !== "complete") {
      await sendMessage(chatId,
        "You have a saved onboarding session. Reply RESUME to continue, or START OVER to begin fresh."
      );
      return;
    }
  }

  // STOP — works at any stage (CANCEL is NOT here — it cancels a visit, not the account)
  if (stopWords.has(norm)) {
    await optOutPhoneNumber(phone);
    const lang = languageFromSession(session as unknown as Record<string, unknown>);
    // TCPA opt-out confirmation must land reliably — force SMS, never iMessage.
    await sendMessage(chatId, tr.opt_out_confirmation(lang), { preferredService: "SMS" });
    return;
  }

  // HELP — standard SMS carrier keyword (allowed as a literal keyword fast-path,
  // per the SMS opt-out/HELP carrier protocol). This is NOT intent parsing: a
  // natural-language "what can you do?" is understood by the LLM (capability hint
  // injected into the qaAgent system prompt), never matched here as a keyword.
  // U7 / R13: reply with a SHORT, warm, role-aware capability reply. When there's
  // live context worth leading with, surface ONE relevant action instead of a list.
  if (norm === "HELP" || norm === "AYUDA") {
    const role: DiscoveryRole = session.userType === "caregiver"
      ? "caregiver"
      : (session as any).isSecondaryMember
        ? "family-secondary"
        : "client";

    // Pull one contextual lead from the live operations context (best-effort —
    // falls back to the no-context list reply if it fails or is empty).
    let leadWith: string | undefined;
    try {
      const ctx = await loadCaraOperationalContext({
        phone,
        userId: session.userId,
        caregiverId: (session as any).caregiverId,
      });
      leadWith = buildOperationalRecipeLead(ctx, role);
    } catch {
      // best-effort — fall through to the no-context list reply.
    }

    await sendMessage(chatId, buildHelpSmsReply(role, leadWith));
    return;
  }

  // ── Subscription lapse — graceful degradation for clients with lapsed billing ─
  if (session.userType === "client" && session.onboardingStep === "complete") {
    const userId = session.userId ?? phone;
    const userSnap = await db.collection("users").doc(userId).get().catch(() => null);
    const subStatus = userSnap?.data()?.subscriptionStatus as string | undefined;
    if (subStatus === "past_due" || subStatus === "canceled" || subStatus === "unpaid") {
      await sendMessage(chatId,
        "Your Evia membership needs attention — there was an issue with your payment.\n\n" +
        `To keep your care coordination active, please update your billing at ${appLink("/client/membership")}. Reply SUPPORT and I'll connect you with our team.`,
        { preferredService: "SMS" } // billing/legal notice — force SMS, never iMessage
      );
      return;
    }
  }

  // ── Twin-trigger cancel — user replied, cancel any pending proactive nudges ─
  cancelTriggerIfUserReplied(session.userId ?? phone, phone).catch(() => {});

  // ── Crisis detection — checked before everything else ──────────────────────
  // Keyword fast-path identifies POTENTIAL crisis (sub-millisecond). For real
  // hits we then run a 1.2s LLM verification to filter out quotes/jokes/
  // hypotheticals — fail-safe to crisis on timeout/error.
  // ── Crisis "NOTIFY" follow-up ───────────────────────────────────────────────
  // The medical-crisis message tells the family "reply NOTIFY" to alert the care
  // team. Catch that reply here (strict keyword protocol — allowed without an LLM)
  // before crisis re-detection, so it isn't routed to the generic QA agent.
  {
    const pendingNotify = (session as any).pendingCrisisNotify as { text?: string; detectedAt?: string; kind?: "medical" | "emotional" } | undefined;
    const normNotify = text.trim().toUpperCase();
    // Word-START match, not substring: the crisis message instructs "reply
    // NOTIFY", so this matches "NOTIFY" / "NOTIFY THEM" but NOT "do not notify
    // anyone" (which a substring .includes("NOTIFY") wrongly paged the team on).
    const isNotifyKeyword =
      normNotify === "NOTIFY" || normNotify.startsWith("NOTIFY ") ||
      normNotify === "NOTIFICAR" || normNotify.startsWith("NOTIFICAR ");
    if (pendingNotify && isNotifyKeyword) {
      await handleCrisisNotify(phone, chatId, session, pendingNotify);
      return;
    }
  }

  // ── Caregiver "RENEW" — re-issue an expired/expiring background check link ───
  // The bg-check expiry nudge tells caregivers to "reply RENEW". Strict keyword
  // protocol (allowed without an LLM), gated to caregiver sessions.
  {
    const normRenew = text.trim().toUpperCase();
    if (session.userType === "caregiver" && (normRenew === "RENEW" || normRenew === "RENOVAR")) {
      const { sendBgCheckRenewalLink } = await import("../agents/onboardingConversation");
      await sendBgCheckRenewalLink(phone, chatId, session);
      return;
    }
  }

  const crisis = detectCrisis(text);
  const sessionLang = languageFromSession(session as unknown as Record<string, unknown>);
  if (crisis === "medical") {
    if (await isLikelyRealCrisis(text, "medical")) {
      await sendMessage(chatId, tr.crisis_medical(sessionLang));
      logCrisisDetected(phone, "medical", text).catch(() => {});
      raiseMedicalCrisisAlert(phone, text); // R7: admin-visible safety alert
      // Arm the NOTIFY follow-up so the family's "NOTIFY" reply reaches the care team.
      await db.collection("agent_sessions").doc(phone).update({
        pendingCrisisNotify: { text: text.slice(0, 500), detectedAt: new Date().toISOString(), kind: "medical" },
      }).catch(() => {});
      return;
    }
    console.info("crisisDetector: medical keyword matched but LLM judged as non-crisis — proceeding normally", { phone });
  }
  if (crisis === "emotional") {
    if (await isLikelyRealCrisis(text, "emotional")) {
      await sendEmotionalCrisisResponse(phone, chatId, sessionLang, text);
      return;
    }
    console.info("crisisDetector: emotional keyword matched but LLM judged as non-crisis — proceeding normally", { phone });
  }

  // No crisis keyword fired. For messages that look non-English (Spanish is a
  // supported language), run a multilingual LLM crisis classify to catch
  // paraphrased or code-switched crisis text the keyword lists can't enumerate.
  // Gated to likely-non-English to avoid adding an LLM call to every English
  // message — see the launch-readiness plan's open question (every-message vs
  // non-English). The classifier already judges genuineness, so a positive
  // result routes straight to the crisis response (no second verify call).
  if (crisis === null) {
    const looksNonEnglish = sessionLang === "es" || /[ñ¿¡áéíóúü]/i.test(text);
    if (looksNonEnglish) {
      const llmCrisis = await classifyCrisisMultilingual(text);
      if (llmCrisis === "medical") {
        await sendMessage(chatId, tr.crisis_medical(sessionLang));
        logCrisisDetected(phone, "medical", text).catch(() => {});
        raiseMedicalCrisisAlert(phone, text); // R7: admin-visible safety alert
        await db.collection("agent_sessions").doc(phone).update({
          pendingCrisisNotify: { text: text.slice(0, 500), detectedAt: new Date().toISOString(), kind: "medical" },
        }).catch(() => {});
        return;
      }
      if (llmCrisis === "emotional") {
        await sendEmotionalCrisisResponse(phone, chatId, sessionLang, text);
        return;
      }
    }
  }

  // ── Persona-shift resolution ────────────────────────────────────────────────
  // If we previously asked "is this still about [seniorName]?", interpret
  // this inbound as the answer and either resume or block the original action.
  // Tracks whether we resolved a pending persona check on THIS turn — without it,
  // a confirmed "YES" restores the original text and falls straight back into the
  // detector below, which re-flags the same name and re-asks forever (infinite loop).
  let personaResolvedThisTurn = false;
  {
    const pending = (session as any).pendingPersonaResolve as {
      originalText: string;
      seniorName?:  string;
      detectedAt:   string;
    } | undefined;
    if (pending) {
      // Quick yes/no classify — was the user confirming the session person or not?
      let isSame = false;
      try {
        const verdict = await quickComplete(
          `Evia asked: "Is this still about ${pending.seniorName ?? "the person on file"}?" ` +
          "Reply YES if the user confirms it is still about them. " +
          "Reply NO if the user says it is a different person or family. " +
          "Reply UNCLEAR if you cannot tell. Only reply one word.",
          text,
          { maxTokens: 5 },
        );
        const v = verdict.trim().toUpperCase();
        isSame = v.startsWith("Y");
        if (v.startsWith("U")) {
          await sendMessage(chatId,
            `Just to be sure — is this message about ${pending.seniorName ?? "the person on file"}? A quick yes or no helps me keep things straight.`,
          );
          return;
        }
      } catch {
        await sendMessage(chatId,
          `Just to be sure — is this message about ${pending.seniorName ?? "the person on file"}? A quick yes or no helps me keep things straight.`,
        );
        return;
      }

      await db.collection("agent_sessions").doc(phone).update({
        pendingPersonaResolve: admin.firestore.FieldValue.delete(),
      }).catch(() => {});

      if (!isSame) {
        await sendMessage(chatId,
          `Got it — different person. I keep one care plan per phone number, so I can't mix them up.\n\n` +
          `If you want a separate setup, the person you're asking about needs to text me from their own phone. ` +
          `Or ask whoever set this up for ${pending.seniorName ?? "the person on file"} to add you as a family member, ` +
          `which lets you get care updates without overwriting their plan.`,
        );
        return;
      }
      // isSame === true → fall through and process the ORIGINAL text as if just received.
      // Mark resolved so the detector below doesn't re-flag the same name this turn.
      text = pending.originalText;
      personaResolvedThisTurn = true;
    }
  }

  // ── Persona shift detection — flag and pause when a different person seems to be texting ─
  // Only relevant for complete client sessions; onboarding flows already self-reset via START OVER.
  // Also skipped mid "post a new job" who/where collection (jp_ask_recipients /
  // jp_ask_recipient_relationship) — naming a brand-new person there is the
  // expected, desired action (the site itself supports multiple care
  // recipients per account), and jobPostingFlow.ts's own numbered-list +
  // explicit-relationship capture already handles it deliberately and safely.
  // Without this, this check unconditionally blocked adding a second recipient
  // over SMS at all (live-caught 2026-09-07) — a real feature gap relative to
  // the website's own wizard, not a security fix for that specific case.
  const JOB_POSTING_WHO_STEPS = new Set(["jp_ask_recipients", "jp_ask_recipient_relationship"]);
  const inJobPostingWhoStep = JOB_POSTING_WHO_STEPS.has((session as any).jobPostingStep as string);
  if (session.onboardingStep === "complete" && session.userType === "client" && !personaResolvedThisTurn && !inJobPostingWhoStep) {
    const sessionSeniorName =
      ((session as any).onboardingData?.seniorName as string | undefined) ??
      ((session as any).seniorName as string | undefined);
    const shift = await detectPersonaShift({
      text,
      sessionSenior: sessionSeniorName,
      sessionRole:   session.userType,
      // Names Evia already expects on this account (client, recipients, family,
      // caregivers) so a known name or caregiver-logistics question never trips it.
      knownNames:    collectKnownNames(session as unknown as Record<string, unknown>),
    }).catch(() => null);

    if (shift) {
      await db.collection("agent_sessions").doc(phone).update({
        pendingPersonaResolve: {
          originalText: text,
          seniorName:   sessionSeniorName ?? "",
          detectedAt:   new Date().toISOString(),
        },
      }).catch(() => {});
      await sendMessage(chatId,
        sessionSeniorName
          ? `I see this phone is set up for ${sessionSeniorName}'s care plan, but your message sounds like it's about someone else. ` +
            `Is this still about ${sessionSeniorName}, or a different family member?`
          : `Quick check — your message sounds like it might be about someone other than the person I have on file for this phone. ` +
            `Is this for the same person? A quick yes or no helps me keep things straight.`,
      );
      return;
    }
  }

  // ── Bereavement detection — before intent classification ───────────────────
  if (await isBereavementTrigger(text) && !(session as any).bereavementMode) {
    const seniorName = (session as any).seniorName ?? "your loved one";
    await activateBereavementMode(session.userId ?? phone, chatId, phone, seniorName as string);
    return;
  }
  // If already in bereavement mode — allow explicit exit or send gentle acknowledgment
  if ((session as any).bereavementMode) {
    let isExit = false;
    try {
      const raw = await quickComplete(
        "The user is in bereavement mode after losing a loved one. " +
          "Reply YES if they are clearly expressing that they are ready to resume normal service " +
          "(e.g. they need a caregiver, want to continue, are ready). " +
          "Reply NO if they are still grieving or just checking in. " +
          "Reply with only YES or NO.",
        text,
        { maxTokens: 5 },
      );
      isExit = raw.trim().toUpperCase().startsWith("Y");
    } catch {
      isExit = false;
    }
    if (isExit) {
      await db.collection("agent_sessions").doc(phone).update({ bereavementMode: admin.firestore.FieldValue.delete() });
      const bereavementExitMsg = await generateCaraMessage({
        audience: "family",
        context: "Family asked to exit bereavement support mode. Evia is gently transitioning back to normal and offering help.",
        fallback: "Of course. I'm here whenever you need me. What can I help you with?",
        maxTokens: 80,
      });
      await sendMessage(chatId, bereavementExitMsg);
    } else {
      // After 30 days, gently offer to resume — don't trap them forever
      const activatedAt = (session as any).bereavementActivatedAt as string | undefined;
      const daysSince = activatedAt
        ? (Date.now() - new Date(activatedAt).getTime()) / (1000 * 60 * 60 * 24)
        : 0;
      if (daysSince > 30) {
        const bereavementCheckinMsg = await generateCaraMessage({
          audience: "family",
          context: "30-day bereavement check-in — Evia is gently reaching out to see if the family is ready to think about care again. Tone should be warm and not pushy.",
          fallback: "I'm here with you. 💙 Whenever you're ready to arrange care again, just let me know.",
          maxTokens: 80,
        });
        await sendMessage(chatId, bereavementCheckinMsg);
      } else {
        const bereavementSupportMsg = await generateCaraMessage({
          audience: "family",
          context: "Family is in bereavement mode and has messaged. Evia is being supportive and not rushing them.",
          fallback: "I'm here with you. 💙 Take all the time you need.",
          maxTokens: 60,
        });
        await sendMessage(chatId, bereavementSupportMsg);
      }
    }
    return;
  }

  // ── Zep lazy-init / self-heal — ANY session without a thread ──────────────
  // Was gated to onboardingStep === "complete" (backfill for pre-Zep users),
  // which left MID-onboarding sessions that skipped first-contact init with no
  // thread at all — their entire signup never reached long-term memory (seen
  // live 07-14: caregiver session with zero zepThreadId). Idempotent; runs
  // once per gap, never blocks the reply.
  if (!(session as any).zepThreadId) {
    initializeZepOnFirstContact(phone).catch((err) =>
      console.error("Zep lazy-init error:", err)
    );
  }

  // ── ONBOARDING gate — route to state machine if not complete ─────────────
  // If the session exists but has no onboardingStep (e.g. created by an old
  // initiateCara that only stored chatId/userType), try to recover account data
  // from the users collection before routing. Without userId/seniorId the QA agent
  // will crash with an invalid Firestore path.
  // Recovers corrupted sessions: any missing userId triggers a users-collection
  // lookup. Previously only ran when step !== "complete" — but "complete with
  // no userId" is also corrupt (e.g. signup completed then user account write
  // failed) and was producing downstream crashes when qaAgent tried to load
  // senior context from an empty seniorId.
  if (!session.userId) {
    const userQuery = await db.collection("users").where("phone", "==", phone).limit(1).get();
    if (!userQuery.empty) {
      const userDoc   = userQuery.docs[0];
      const userData  = userDoc.data();
      const userId    = userDoc.id;
      if (await userHasRealOnboardingProgress(userId, userData)) {
        const seniorId  = resolvePrimarySeniorId(userId, userData);
        await db.collection("agent_sessions").doc(phone).update({
          userId,
          seniorId,
          onboardingStep: "complete",
        });
        // Reload the session so downstream code sees the updated fields
        session.userId         = userId;
        (session as any).seniorId      = seniorId;
        session.onboardingStep = "complete";
      } else {
        // Seeded-but-unfinished account: the users doc came from the /start OTP
        // seed (createWebOnboardingSession) or a signup that never finished —
        // NOT a completed account. Link the uid so downstream writes land on it,
        // but do NOT mark complete: keep a mid-flow step where it is, otherwise
        // route into the role's onboarding start (name-confirm when the web form
        // captured a name — mirrors the web-onboarding bridge).
        const role = (userData.userType as string | undefined) === "caregiver" ? "caregiver" : "client";
        const seededName = ((role === "caregiver" ? userData.name : userData.firstName) as string | undefined)?.trim() || "";
        const midFlow = !!session.onboardingStep && session.onboardingStep !== "complete";
        const firstStep = midFlow
          ? session.onboardingStep
          : seededName
            ? (role === "caregiver" ? "caregiver_confirm_name" : "client_confirm_name")
            : (role === "caregiver" ? "caregiver_ask_name" : "client_ask_name");
        const nameKey  = role === "caregiver" ? "name" : "firstName";
        const mergedOnboardingData = seededName && !midFlow
          ? { ...((session.onboardingData as Record<string, unknown> | undefined) ?? {}), [nameKey]: seededName }
          : undefined;
        await db.collection("agent_sessions").doc(phone).update({
          userId,
          userType:       role,
          onboardingStep: firstStep,
          ...(mergedOnboardingData ? { onboardingData: mergedOnboardingData } : {}),
        });
        session.userId         = userId;
        session.userType       = role as AgentSession["userType"];
        session.onboardingStep = firstStep;
        if (mergedOnboardingData) (session as any).onboardingData = mergedOnboardingData;
      }
    } else if (!session.onboardingStep) {
      // Genuinely stepless and no account — start onboarding from the beginning.
      await db.collection("agent_sessions").doc(phone).update({ onboardingStep: "ask_role" });
      session.onboardingStep = "ask_role";
    } else if (session.onboardingStep !== "complete") {
      // Mid-onboarding with no account yet — this is NORMAL. A client/caregiver
      // session has no userId until the account is created (at payment), so the
      // absence of userId here is expected, not corruption. Do NOT reset to
      // ask_role: that wiped collection progress on every inbound and made Evia
      // re-greet from the top forever (and the agent-native collection loop could
      // never be reached, since its steps are client_ask_*). Leave the in-progress
      // step intact and let onboarding continue from where the user was.
    } else if ((session as any).awaitingSupply) {
      // Supply-hold: onboarding completed WITHOUT payment by design — no
      // caregivers were available in their area ("no charge until then"), so
      // there is no user record yet. Not an orphan. Answer their message with
      // the hold context so Evia stays honest about where things stand.
      const d = (session.onboardingData ?? {}) as Record<string, unknown>;
      const seniorName = (d.seniorName as string) || "your loved one";
      const city       = (d.city as string) || "your area";
      // R11: ground who's who — the reader is the account holder; the care is
      // for the recipient, never for the reader.
      const whoIsWho = describeWhoIsWho(d);
      const holdReply = await generateCaraMessage({
        audience: "family",
        context:
          (whoIsWho ? whoIsWho + " " : "") +
          `This family finished setup for ${seniorName} in ${city}, but no caregivers were available there ` +
          `yet, so they're on the waitlist — everything is saved, they have NOT been charged, and Evia will ` +
          `text them the moment a caregiver in their area becomes available. They just sent: ` +
          `"${text.slice(0, 300)}". Answer their message honestly with that status. If they ask about a ` +
          `nearby city, say you'll include it in the search and reach out as soon as someone is available. ` +
          `Never promise a specific timeframe, never re-ask intake questions, never suggest starting over.`,
        fallback:
          `Not yet — you're first in line for ${seniorName} in ${city}. Everything's saved and there's no ` +
          `charge until I have the right caregiver for you. I'll text you the moment that changes.`,
        maxTokens: 120,
      });
      await sendMessage(chatId, holdReply);
      return;
    } else {
      // Complete but no user record and no users-collection match — session
      // is orphaned. Tell the user something went wrong and offer a restart
      // rather than crashing through qaAgent.
      await sendMessage(chatId,
        "Something's off with this account — I can't find your details. " +
        "Reply START OVER and I'll get you set up again."
      );
      console.error("handleInbound: complete session with no userId and no users record", { phone });
      return;
    }
  }

  // ── Profile completeness gate ────────────────────────────────────────────
  // Catches "phone is in the system but onboarding never completed" — sandbox→
  // live migrations and old-format stubs that carry a chatId but no real
  // account. Runs AFTER the recovery block above so that recoverable sessions
  // (no userId in the session, but a users-collection record exists) have
  // already been restored to ONBOARDED and are NOT mis-offered re-setup.
  // classifyCompleteness treats any session with a linked userId/caregiverId +
  // step "complete" as ONBOARDED regardless of onboardingData, so real clients
  // whose name lives in the users/seniors docs are never false-flagged.
  // Skipped entirely when the user is actively mid-onboarding.
  {
    const inOnboardingFlow = session.onboardingStep && session.onboardingStep !== "complete";
    if (!inOnboardingFlow && classifyCompleteness(session) === "PARTIAL") {
      const offerState = (session as any).onboardingOfferState as "pending" | "declined" | undefined;

      if (offerState === "pending") {
        const reply = await classifyOfferReply(text);
        if (reply === "accept") {
          await markOfferAccepted(phone);
          await sendMessage(chatId,
            "Great — let's get you set up. Are you looking for care for a loved one, or are you a caregiver yourself?"
          );
          return;
        }
        if (reply === "decline") {
          await markOfferDeclined(phone);
          await sendMessage(chatId,
            "No problem — we can do it whenever you're ready. What can I help with right now?"
          );
          return;
        }
        // QUESTION → fall through to QA (cross-entity context suppressed below),
        // leaving offerState=pending so the offer stays implicitly on the table.
        (session as any).__unconfirmedIdentity = true;
      } else if (!offerState || shouldReoffer(session)) {
        await sendOnboardingOffer(phone, chatId, session);
        return;
      } else {
        // offerState === "declined" and not yet time to re-offer → answer freely
        // but with cross-entity context suppressed.
        (session as any).__unconfirmedIdentity = true;
      }
    }
  }

  const step = session.onboardingStep ?? "";
  if (step && step !== "complete") {
    // Soft-resume ack REMOVED (founder, 2026-07-14): the old 10–30-min-gap
    // "Welcome back — picking up where we left off." line fired absurdly —
    // mid-onboarding gaps are almost always the user doing a task Evia HERSELF
    // sent them to (Stripe checkout, bg-check page, photo upload), so from
    // their side they never left. Genuine long-absence welcomes still exist:
    // the returning-user greeting and the explicit RESUME checkpoint nudge.

    // Log every onboarding message to Zep — this is where names, conditions,
    // and care needs are shared, so Zep starts building the knowledge graph now
    const onboardingZepThreadId = (session as any).zepThreadId as string | undefined;
    if (onboardingZepThreadId) {
      addUserMessageToZep({
        threadId: onboardingZepThreadId,
        content:  text,
        userName: (session as any).onboardingData?.firstName ?? "User",
        sentAt:   new Date(),
      }).catch(console.error);
    }
    // (No else: a missing thread is self-healed by the widened Zep lazy-init
    // earlier in handleInbound — one call site, no double-create race.)

    // Permissions steps
    const atPermissionsStep =
      step === "client_permissions_contact" || step === "client_permissions_booking" ||
      step === "client_permissions_autobook" ||
      step === "caregiver_permissions_decline" || step === "caregiver_permissions_arrival";

    // Job-alert replies take precedence over a parked permissions question.
    // notifyAreaCaregivers targets ACTIVE caregivers, and an active caregiver
    // can still be parked at these optional yes/no steps — where the router
    // used to consume their reply as the (days-old) permissions answer instead
    // of the job alert Evia JUST sent (seen live 07-14: job text delivered to a
    // caregiver at caregiver_permissions_arrival, whose "yes" would have
    // toggled arrival notifications). The job question is always the most
    // recent ask when these flags are set, so it owns the reply; the
    // permissions step stays parked and re-nudges / auto-defaults later.
    // Staleness gate mirrors routeCaregiverMessage: a stale/unstamped invite
    // must not consume the permissions answer — clear it and let the
    // permissions step own the reply.
    if (atPermissionsStep && isJobInviteStale(session as unknown as Record<string, unknown>)) {
      const { JOB_INVITE_FLAGS } = await import("../utils/sessionState");
      await db.collection("agent_sessions").doc(phone).update(
        Object.fromEntries(JOB_INVITE_FLAGS.map((f) => [f, admin.firestore.FieldValue.delete()])),
      ).catch(() => {});
      for (const f of JOB_INVITE_FLAGS) (session as any)[f] = undefined;
    }
    if (atPermissionsStep && (session as any).awaitingJobResponse === true) {
      const { handleJobResponse } = await import("../triggers/jobNotifications");
      await handleJobResponse(phone, text, chatId, session as any);
      return;
    }
    if (atPermissionsStep && (session as any).awaitingAvailabilityConfirmation === true) {
      const { handleAvailabilityConfirmation } = await import("../triggers/jobNotifications");
      await handleAvailabilityConfirmation(phone, text, chatId, session as any);
      return;
    }

    if (step === "client_permissions_contact" || step === "client_permissions_booking" || step === "client_permissions_autobook") {
      const userId = session.userId ?? phone;
      await handleClientPermissionsReply(phone, chatId, text, session, userId);
      return;
    }
    if (step === "caregiver_permissions_decline" || step === "caregiver_permissions_arrival") {
      const caregiverId = session.caregiverId ?? phone;
      await handleCaregiverPermissionsReply(phone, chatId, text, session, caregiverId);
      return;
    }
    // U4: agent-native onboarding collapse (loop-only as of 2026-07-08). For a
    // user in the conversational collection phase, the turn runs inside the
    // qaAgent loop instead of the (now-deleted) scripted step runner — Evia leads
    // collection as one agent (no re-greet, no double-send). Routing is
    // unconditional: any plain-text turn at a collection step routes here (no
    // feature flag — loop-only must not be revertable-by-config to a path that no
    // longer exists). Media/location are converted to text or handled above, and
    // transactional / gate steps (not in that role's collection list) never route.
    // Shared structured-Zep push (knowledge-graph capture of names/conditions/
    // care needs). Called by BOTH the agent-loop path and the scripted runner so
    // the graph stays populated regardless of which handled the turn.
    const pushOnboardingStepToZep = async (completedStep: string) => {
      if (!onboardingZepThreadId) return;
      const afterSnap = await db.collection("agent_sessions").doc(phone).get();
      const afterData = afterSnap.data() ?? {};
      const oData     = (afterData.onboardingData ?? {}) as Record<string, unknown>;
      await addBusinessDataToZep({
        userId: getZepUserId(phone),
        data: {
          event_type:         "onboarding_step",
          step_completed:     completedStep,
          step_next:          afterData.onboardingStep ?? completedStep,
          user_type:          afterData.userType ?? "unknown",
          user_name:          (oData.firstName as string) ?? (oData.name as string) ?? "",
          senior_name:        (oData.seniorName as string) ?? "",
          senior_age:         oData.age ?? null,
          senior_conditions:  oData.conditions ?? [],
          senior_care_needs:  oData.careNeeds ?? [],
          senior_city:        (oData.city as string) ?? "",
          timestamp:          new Date().toISOString(),
        },
      }).catch((err) => console.error("onboarding Zep push error:", err));
    };

    // Which role's loop this turn belongs to. Only meaningful inside the routed
    // branch below (shouldRouteOnboardingToLoop already verified the role is
    // "client" or "caregiver" and the step is in that role's collection list).
    const loopRole: OnboardingRole = session.userType === "caregiver" ? "caregiver" : "client";

    // 2a (loop-only): a location PIN at a collection step is handled by the loop,
    // not the bespoke scripted location handler. Reverse-geocode it to a text line
    // ("San Jose, 95112") BEFORE the routing predicate and treat the turn as text,
    // so the pre-turn service-area gate + absorber consume it — this works at ANY
    // collection step, not just the location step, so it's strictly better than
    // the scripted path. Only convert when the turn would actually route to the
    // loop (role enabled, in cohort, collection step); otherwise the scripted
    // fallback handlers still need the raw pin, so it is left untouched.
    if (inboundLocation && text.trim() === "" && shouldRouteOnboardingToLoop({
      role: session.userType, step, hasText: true, hasMedia: false,
    })) {
      const { lat, lng } = inboundLocation;
      const rev = await reverseGeocode(lat, lng).catch(() => null);
      text = rev && (rev.city || rev.zipCode)
        ? [rev.city, rev.zipCode].filter(Boolean).join(", ")
        : `[The user shared their location: ${lat}, ${lng}]`;
      inboundLocation = null; // now a text turn — hasLocation is false below
      console.info("webhooks: converted onboarding location pin to text for loop", { phone, step });
    }

    // 2a-media (loop-only): a photo/document that arrives WITH a text caption at a
    // collection step (e.g. a caregiver sends a selfie captioned "hi, I'm John, 5
    // years experience"). Collection steps only ever want text fields — the upload
    // gates are separate, non-collection steps — so route the CAPTION to the loop
    // and set the attachment aside, rather than letting the turn fall through to
    // the media handler and drop the caption on the floor (the pre-deletion
    // scripted path discarded it via the defensive "I lost that" nudge). Only when
    // the turn would otherwise route to the loop as text; media at a GATE step is
    // untouched, so handleInboundMedia still owns the actual upload gates.
    if (inboundMedia && text.trim() !== "" && shouldRouteOnboardingToLoop({
      role: session.userType, step, hasText: true, hasMedia: false,
    })) {
      inboundMedia = null; // now a text turn — hasMedia is false below
      console.info("webhooks: collection-step media had a caption — routing caption to loop, media set aside", { phone, step });
    }

    // 2c (loop-only): a truly empty turn at a collection step — no text, no media,
    // no location pin, no inbound parts. Stickers and failed voice transcriptions
    // are already caught by the isMediaOnly nudge above (they carry parts) and
    // voice memos are transcribed to text pre-routing, so this only covers the
    // residual empty-webhook case. There is no field to extract; nudge to type it.
    // After Phase 4 removes the scripted collection handlers this is the sole
    // handler for the case (mirrored by handleOnboardingStep's defensive default).
    // Gated to the loop-routable case so media/location turns and the scripted
    // fallback stay untouched.
    if (text.trim() === "" && !inboundMedia && !inboundLocation && shouldRouteOnboardingToLoop({
      role: session.userType, step, hasText: true, hasMedia: false,
    })) {
      await stopTyping(chatId).catch(() => {});
      await sendMessage(chatId, "Sorry — I couldn't read that. Mind typing it out for me?");
      return;
    }

    if (shouldRouteOnboardingToLoop({
      role:        session.userType,
      step,
      hasText:     text.trim() !== "",
      hasMedia:    !!inboundMedia,
    })) {
      // U9: runQaAgent sends its own reply internally. Once that resolves, the
      // turn has already replied — any failure in the post-send writes below
      // (persistence net, cursor update, Zep push) must NEVER fall through to
      // handleOnboardingStep, which would send a second, stale-context reply
      // on top of the one the loop already sent.
      // ── Pre-turn field absorption (Fix 1, 2026-07-08) ───────────────────────
      // Run the role-matched deterministic extractor ONCE per turn, BEFORE the
      // model turn, and merge what it finds into session.onboardingData. The
      // onboarding directive is built from that in-memory object
      // (qaAgent.ts:1730-1733), so even when the model never calls
      // save_onboarding_field the just-answered field already shows as
      // "✓ already have it" and the reply advances to the NEXT item instead of
      // re-asking it (the job-type double-ask). This is the same pre-turn
      // technique the service-area gate below already relied on — now a single
      // absorber run feeds both the gate and the session merge.
      //
      // Safe by construction: the absorbers return {} unless a field is
      // unambiguous and only ever return not-already-filled fields, so a mid-flow
      // question produces no spurious save and a model-saved field is never
      // double-written. The post-turn persistence net (below) stays as the
      // backstop for anything this pass missed (incl. step-scoped bio capture).
      const preData = (session.onboardingData ?? {}) as Record<string, unknown>;
      const preAbsorbed: Record<string, unknown> = text.trim() !== ""
        ? (loopRole === "caregiver"
            ? await absorbCaregiverFields(text, preData).catch(() => ({}))
            : await absorbClientFields(text, preData).catch(() => ({})))
        : {};

      // Pre-turn service-area gate (bug-audit §0.2): on the location step,
      // evaluate the service area BEFORE the model turn. Otherwise the model
      // freely composes "Great, San Francisco works — next question…" and sends
      // it, and only the post-turn gate fires the decline — the user sees a
      // contradictory pair ("SF works" then "we're not in your area"). Gating
      // first means the model never acknowledges an out-of-area location. Reuses
      // the single absorber run above.
      if ((step === "caregiver_ask_location" || step === "client_ask_location") && text.trim() !== "") {
        const gateCity = (preAbsorbed.city ?? preData.city) as string | undefined;
        const gateZip  = (preAbsorbed.zipCode ?? preData.zipCode) as string | undefined;
        if (gateCity || gateZip) {
          const { evaluateServiceArea } = await import("../config/serviceArea");
          const sa = evaluateServiceArea({ city: gateCity as string, zip: (gateZip as string) || (gateCity as string) });
          if (sa === "out") {
            const mergedData = { ...preData, ...preAbsorbed };
            const { parkOutOfArea } = await import("../agents/serviceAreaGate");
            await parkOutOfArea({
              phone, role: loopRole,
              city: (gateCity as string) ?? "", zipCode: (gateZip as string) ?? "",
              name: ((mergedData.firstName ?? mergedData.name) as string) ?? "",
              onboardingData: mergedData,
            });
            await sendMessage(chatId, "I'm so sorry — we're not in your area just yet. I've added you to our waitlist and I'll reach out the moment we expand there. 💙");
            await pushOnboardingStepToZep(step);
            return;
          }
          if (sa === "need_zip" && preAbsorbed.city && !gateZip) {
            // Persist the city so the follow-up ZIP reply (same step) has context.
            await db.collection("agent_sessions").doc(phone).set({ onboardingData: preAbsorbed }, { merge: true });
            const { askForZipMessage } = await import("../agents/serviceAreaGate");
            await sendMessage(chatId, askForZipMessage());
            await pushOnboardingStepToZep(step);
            return;
          }
          // sa === "in": fall through to the normal loop turn.
        }
      }

      // Persist the pre-turn absorption so the directive sees just-answered
      // fields. Merge to Firestore AND mutate the in-memory session (the directive
      // reads session.onboardingData). Skipped when nothing new was extracted so a
      // pure question-turn writes nothing.
      if (Object.keys(preAbsorbed).length > 0) {
        await db.collection("agent_sessions").doc(phone)
          .set({ onboardingData: preAbsorbed }, { merge: true });
        (session as any).onboardingData = { ...preData, ...preAbsorbed };
        console.info("webhooks: pre-turn absorber captured fields before loop", { phone, fields: Object.keys(preAbsorbed) });
      }

      let loopReplied = false;
      try {
        await runQaAgent({
          text,
          phone,
          chatId,
          userId:      (session as any).userId ?? "",
          seniorId:    (session as any).seniorId ?? "",
          userType:    loopRole,
          zepThreadId: onboardingZepThreadId,
          session:     session as unknown as Record<string, unknown>,
          onboardingMode: true,
          onboardingRole: loopRole,
          intent:      null,
          // U4: Linq turn identity for lifecycle checkpoints.
          ...(sourceEventId ? { sourceTurn: { conversationId: chatId, messageId: sourceEventId } } : {}),
        });
        loopReplied = true;
        // Stuck-signup net: the cursor only advances when the model calls
        // complete_collection. If collection is actually complete but the model
        // didn't call it, advance to the gate so the user is never trapped on a
        // collection step.
        const after     = (await db.collection("agent_sessions").doc(phone).get()).data() ?? {};
        let   curStep   = (after.onboardingStep as string) ?? step;
        let   curData   = (after.onboardingData ?? {}) as Record<string, unknown>;

        // Persistence safety net: the agent loop depends on the MODEL calling
        // save_onboarding_field. When it chats an answer but skips the tool — OR
        // saves only SOME of the fields present in the message (a front-loaded
        // answer like "Sarah, my mom Dorothy, 82" where the model only calls the
        // tool for one of the three) — the rest are lost and the cursor never
        // moves (user perceives Evia as stuck / regressing, or gets re-asked
        // something they already answered). Run the deterministic extractor —
        // the same parser the scripted runner trusts — whenever required fields
        // are STILL missing after the turn, not only when the model saved zero
        // keys. The absorbers only ever return fields not already in curData,
        // so a field the model DID save can never be double-written or
        // overwritten by the net. Role-matched: caregiver turns use the
        // caregiver extractor.
        if (missingRequiredFields(loopRole, curData).length > 0 && text.trim() !== "") {
          const absorbed: Record<string, unknown> = loopRole === "caregiver"
            ? await absorbCaregiverFields(text, curData).catch(() => ({}))
            : await absorbClientFields(text, curData).catch(() => ({}));
          // Step-scoped bio capture (bug-audit §0.1): the caregiver absorber
          // deliberately never guesses `bio` (any message could be misread, and a
          // wrong bio is family-visible). But AT the caregiver_ask_bio step the
          // user's message IS their bio answer. When the model acknowledges it
          // ("lovely — next I'll send your photo step") but skips
          // save_onboarding_field, bio stays missing, the cursor never reaches
          // caregiver_send_photo, and the promised photo-upload link is never
          // sent — signup dead-ends. Capture it here as the safety-net fallback
          // (length + not-"skip" gated so a short ack isn't stored as a bio).
          if (loopRole === "caregiver" && step === "caregiver_ask_bio" && !curData.bio) {
            const bioText = text.trim();
            if (bioText.length >= 20 && bioText.toLowerCase() !== "skip") {
              absorbed.bio = bioText.slice(0, 1000);
            }
          }
          if (Object.keys(absorbed).length > 0) {
            await db.collection("agent_sessions").doc(phone)
              .set({ onboardingData: absorbed }, { merge: true });
            curData = { ...curData, ...absorbed };
            console.info("webhooks: persistence net captured fields the loop skipped", { phone, fields: Object.keys(absorbed) });

            // Preserve the Santa Clara County service-area gate when the net just
            // captured a location (mirrors save_onboarding_field's gate so the
            // tool-skip path can't bypass it).
            if (absorbed.city || absorbed.zipCode) {
              const { evaluateServiceArea } = await import("../config/serviceArea");
              const sa = evaluateServiceArea({ city: curData.city as string, zip: (curData.zipCode as string) || (curData.city as string) });
              if (sa === "out") {
                const { parkOutOfArea } = await import("../agents/serviceAreaGate");
                await parkOutOfArea({ phone, role: loopRole, city: (curData.city as string) ?? "", zipCode: (curData.zipCode as string) ?? "", name: ((curData.firstName ?? curData.name) as string) ?? "", onboardingData: curData });
                await sendMessage(chatId, "I'm so sorry — we're not in your area just yet. I've added you to our waitlist and I'll reach out the moment we expand there. 💙");
                await pushOnboardingStepToZep(step);
                return;
              }
              // need_zip: mirror save_onboarding_field's mcp/server.ts handling —
              // city saved but not recognized, no zip yet. Ask for the ZIP and
              // return BEFORE the stuck-signup net below can advance the cursor
              // past collection on an unconfirmed service area (the review-
              // validated asymmetry: the net previously only special-cased "out").
              if (sa === "need_zip" && absorbed.city && !curData.zipCode) {
                const { askForZipMessage } = await import("../agents/serviceAreaGate");
                await sendMessage(chatId, askForZipMessage());
                await pushOnboardingStepToZep(step);
                return;
              }
            }
          }
        }

        if (collectionStepsForRole(loopRole).includes(curStep) && missingRequiredFields(loopRole, curData).length === 0) {
          await db.collection("agent_sessions").doc(phone).update({ onboardingStep: firstGateStep(loopRole) });
          curStep = firstGateStep(loopRole);
          console.info("webhooks: stuck-signup net advanced cursor to gate", { phone, from: step });
        }
        // Proactive post-collection handoff: collection just finished this turn
        // (cursor sits at the first gate step). The loop already sent its closing
        // line, but the next phase is webhook-passive and would otherwise wait
        // for an inbound that never comes. Drive it now so Evia doesn't go
        // silent right after "that's everything I need".
        //   client    → matches → paywall (or the honest no-supply hold)
        //   caregiver → the scripted photo-upload gate (caregiver_send_photo),
        //               driven through the legacy runner with the "__RESUME__"
        //               sentinel (the established no-user-text drive; the send
        //               handler ignores inbound text)
        if (curStep === firstGateStep(loopRole)) {
          try {
            if (loopRole === "caregiver") {
              // Collection just completed — create the uid-keyed caregivers doc
              // NOW (status "onboarding": invisible to matching/FindCaregivers)
              // so the webapp account carries the profile from this point on and
              // every later mergeOnboardingData keeps it in sync. Previously the
              // doc only appeared at bg-check success / the final Stripe step,
              // so a caregiver who stalled mid-gates had an EMPTY webapp account.
              // Non-fatal: the gate links must still go out if this fails.
              const { ensureCaregiverDocForOnboarding } = await import("../agents/onboardingConversation");
              const ensuredId = await ensureCaregiverDocForOnboarding(phone).catch((err) => {
                console.error("webhooks: caregiver doc pre-create at gate failed", err);
                return null;
              });
              if (ensuredId) (after as Record<string, unknown>).caregiverId = ensuredId;
              await handleOnboardingStep(phone, chatId, "__RESUME__", {
                ...(after as unknown as AgentSession),
                onboardingStep: curStep,
                onboardingData: curData,
                chatId,
              } as AgentSession);
            } else {
              await continueAfterClientCollection(phone, chatId);
            }
          } catch (err) {
            console.error(
              "webhooks: post-collection handoff failed",
              err instanceof Error ? err.message : err,
            );
          }
        }
        await pushOnboardingStepToZep(step);
        return;
      } catch (err) {
        if (loopReplied) {
          // The loop already sent its reply — this failure is a POST-send write
          // (persistence net / cursor update / Zep push), not a reason to run
          // the scripted runner too. Falling through here is exactly the U9
          // double-reply bug: handleOnboardingStep would send a second,
          // contradictory message from stale pre-turn session state. Record
          // the failure and stop; the user already has a valid reply for this turn.
          console.error(
            "webhooks: onboarding agent-loop post-send write failed after reply was sent — not double-sending",
            err instanceof Error ? err.message : err,
          );
          await db.collection("admin_alerts").add({
            type:      "onboarding_loop_post_send_write_failed",
            phone,
            step,
            error:     err instanceof Error ? err.message : String(err),
            errorClass: err instanceof Error ? err.name : "unknown",
            severity:  "medium",
            createdAt: new Date().toISOString(),
            resolved:  false,
          }).catch(() => {});
          return;
        }
        // 2d (loop-only): the loop is the SOLE collection path — there is no
        // scripted collection handler left to fall back to. It threw BEFORE
        // replying (API outage/timeout/Firestore). Retry ONCE; if that also
        // throws, send a short apology and page ops. Never leave the turn silent,
        // and never fall through to handleOnboardingStep (its collection cases
        // are gone — that would hit the defensive default, not real collection).
        console.error(
          "webhooks: onboarding agent-loop threw before replying — retrying once",
          err instanceof Error ? err.message : err,
        );
        try {
          await runQaAgent({
            text, phone, chatId,
            userId:      (session as any).userId ?? "",
            seniorId:    (session as any).seniorId ?? "",
            userType:    loopRole,
            zepThreadId: onboardingZepThreadId,
            session:     session as unknown as Record<string, unknown>,
            onboardingMode: true,
            onboardingRole: loopRole,
            intent:      null,
            isRetry:     true,
            // U4: same source-turn identity on the retry — the derived key is
            // identical, so the retried turn shares the original's checkpoint.
            ...(sourceEventId ? { sourceTurn: { conversationId: chatId, messageId: sourceEventId } } : {}),
          });
          await pushOnboardingStepToZep(step);
          return;
        } catch (retryErr) {
          console.error(
            "webhooks: onboarding agent-loop retry also threw — apologizing + paging ops",
            retryErr instanceof Error ? retryErr.message : retryErr,
          );
          await sendMessage(chatId,
            "Sorry — I hit a snag on my end just now. Mind sending that again in a moment? I've saved everything so far.",
          ).catch(() => {});
          await db.collection("admin_alerts").add({
            type:       "onboarding_loop_failed_after_retry",
            phone,
            step,
            error:      retryErr instanceof Error ? retryErr.message : String(retryErr),
            errorClass: retryErr instanceof Error ? retryErr.name : "unknown",
            severity:   "high",
            createdAt:  new Date().toISOString(),
            resolved:   false,
          }).catch(() => {});
          return;
        }
      }
    }

    await handleOnboardingStep(phone, chatId, text, session, {
      service,
      inboundLocation: inboundLocation ?? undefined,
      inboundMedia:    inboundMedia ?? undefined,
    });

    await pushOnboardingStepToZep(step);
    return;
  }

  // Rate limit — only triggers on actual abuse (120+ msgs/hr from one phone).
  // Drop silently instead of sending a "broken" reply to the user. Log so we
  // can see if a real user ever hits it.
  if (await isRateLimited(phone)) {
    console.warn("handleInbound: phone exceeded 120 msgs/hr rate limit — dropping silently", { phone });
    return;
  }

  // The webhook signature has been verified by the public handler, and the
  // accepted-session path has passed its rejection guards. Stamp activity
  // before model work so an agent failure cannot make a real inbound turn look
  // inactive to the nightly memory selector.
  if (sessionSnap.exists) {
    await db.collection("agent_sessions").doc(phone).update(sessionActivityFields()).catch(() => {});
  }

  // ── Shared location (anytime / completed session) ──────────────────────────
  // A pin arrived but we're past onboarding. Persist the raw coords so MCP tools
  // can read them, then synthesize a text line so the QA agent reasons about it
  // (e.g. "update my address") through normal routing — no special-case branch.
  if (inboundLocation && text === "") {
    const rev = await reverseGeocode(inboundLocation.lat, inboundLocation.lng);
    await db.collection("agent_sessions").doc(phone).update({
      lastSharedLocation: {
        lat: inboundLocation.lat,
        lng: inboundLocation.lng,
        ...(rev ? { city: rev.city, zipCode: rev.zipCode, region: rev.region ?? "" } : {}),
        at:  new Date().toISOString(),
      },
    }).catch(() => {/* non-critical */});
    text = `[The user shared their location: ${inboundLocation.lat}, ${inboundLocation.lng}` +
      (rev ? ` — ${rev.city}, ${rev.region ?? ""} ${rev.zipCode}`.replace(/\s+/g, " ").trimEnd() : "") +
      `]`;
  }

  // ── Shared image / document (anytime / completed session) ──────────────────
  // A photo/document arrived past onboarding. Classify it with gpt-4o vision and
  // smart-route: a new credential → attach to the caregiver profile for review;
  // anything else → store it, synthesize a descriptive line, and hand to the QA
  // agent so it can act with its tools (no special-case branch needed).
  if (inboundMedia && text === "") {
    try {
      await stopTyping(chatId).catch(() => {});
      const dl  = await downloadMedia(inboundMedia);
      const url = await storeInboundMedia({
        phone, kind: inboundMedia.kind, buffer: dl.buffer,
        content_type: dl.content_type, ext: dl.ext,
      });
      const cls = await classifyMedia(dl.buffer, dl.content_type);

      await db.collection("agent_sessions").doc(phone).update({
        lastSharedMedia: {
          url, kind: inboundMedia.kind, category: cls.category,
          description: cls.description, details: cls.details ?? "",
          at: new Date().toISOString(),
        },
      }).catch(() => {/* non-critical */});

      const caregiverId = (session as any).caregiverId as string | undefined;
      if (cls.category === "credential" && caregiverId) {
        // New credential from an active caregiver → queue on their profile for
        // the team to verify, and confirm conversationally. (Additive: never
        // overwrites verified credentials.)
        await db.collection("caregivers").doc(caregiverId).update({
          pendingDocuments: admin.firestore.FieldValue.arrayUnion({
            url, source: "sms", description: cls.description,
            details: cls.details ?? "", at: new Date().toISOString(),
          }),
        }).catch((err) => console.error("anytime credential attach failed", err));
        await sendMessage(chatId,
          "Got it — I've added that to your profile and flagged it for our team to verify. Thank you! 📄"
        );
        return;
      }

      // Everything else → let the QA agent reason about it via normal routing.
      text = `[The user sent ${inboundMedia.kind === "image" ? "a photo" : "a document"}: ` +
        `${cls.description}${cls.details ? ` (${cls.details})` : ""}. ` +
        `It has been saved at ${url}.]`;
    } catch (err) {
      console.error("anytime media handling failed", { phone, chatId, err: (err as Error)?.message });
      await sendMessage(chatId,
        "I got your file but had trouble opening it — could you try sending it again, or tell me what it is?"
      );
      return;
    }
  }

  // ── Universal state-machine escape hatch ──────────────────────────────────────
  {
    const ESCAPE_WORDS = new Set(["NEVERMIND", "QUIT", "EXIT", "BACK", "START OVER", "RESET", "FORGET IT"]);
    const hasStateFlagEscape = STATE_MACHINE_FLAGS.filter(f => f !== "stateExpiresAt")
                                 .some(f => !!(session as any)[f]);
    if (hasStateFlagEscape &&
        (ESCAPE_WORDS.has(norm) ||
         norm.startsWith("NEVER MIND") ||
         norm.startsWith("FORGET IT"))) {
      await clearAllStateFlags(phone, db);
      await sendMessage(chatId, "No problem, starting fresh. What can I help you with?");
      return;
    }
  }

  // ── Post-visit feedback reply — check before general routing ──────────────
  {
    const pendingFeedback = await db.collection("proactive_triggers")
      .where("phone",            "==", phone)
      .where("type",             "==", "post_visit_feedback")
      .where("feedbackReceived", "==", null)
      .orderBy("firedAt", "desc")
      .limit(1)
      .get();

    if (!pendingFeedback.empty) {
      const triggerDoc = pendingFeedback.docs[0];
      const trigger    = triggerDoc.data();
      const meta       = trigger.metadata ?? {};
      const authenticatedClientId = typeof session.userId === "string" ? session.userId : "";

      if (trigger.firedAt && authenticatedClientId && meta.clientId === authenticatedClientId) {
        const leaseOwner = crypto.randomUUID();
        const claim = await claimVisitFeedback(triggerDoc.id, leaseOwner);
        if (claim === "expired") {
          await sendMessage(chatId, "That feedback window has expired, but you can still tell me about the visit anytime.");
          return;
        }
        if (claim === "busy") {
          await sendMessage(chatId, "I'm already saving that feedback. I'll confirm as soon as it's recorded.");
          return;
        }
        if (claim === "claimed") {
          try {
            await handleVisitFeedback({
              phone,
              text,
              caregiverId:   meta.caregiverId ?? "",
              clientId:      meta.clientId,
              appointmentId: meta.appointmentId ?? "",
              triggerId:     triggerDoc.id,
              leaseOwner,
            });
          } catch (err) {
            console.error("handleVisitFeedback error:", err);
            await releaseVisitFeedbackClaim(triggerDoc.id, leaseOwner).catch(() => {});
            await sendMessage(chatId, "I couldn't save that feedback just now. Please send it again in a moment.");
          }
          return;
        }
      } else if (trigger.firedAt && meta.clientId !== authenticatedClientId) {
        console.warn("Rejected post-visit feedback from non-owner session", {
          triggerId: triggerDoc.id,
          sessionUserId: authenticatedClientId || null,
        });
      }
    }
  }

  // ── Family satisfaction check-in reply — sentiment routing (side effect only) ──
  // No `return` here, unlike post-visit feedback above — deliberately, see
  // handleSatisfactionCheckinReply's comment.
  if ((session as any).awaitingSatisfactionReply && typeof session.userId === "string") {
    await handleSatisfactionCheckinReply({
      phone, clientId: session.userId, text,
    }).catch((err) => console.error("handleSatisfactionCheckinReply error:", err));
  }

  // ── Pending irreversible-action approval — runtime-enforced HITL gate ──────
  // When Evia proposed a high-risk action (cancel_appointment, cancel_subscription,
  // remove_family_member, etc.) on a prior turn, the MCP gate stored a
  // pending_action doc and Evia texted the family for confirmation. This block
  // intercepts the family's reply BEFORE intent classification so we catch
  // natural-language YES/NO ("yeah", "go ahead", "actually no") that the
  // generalist 50-intent classifier would misroute. See pendingActions.ts +
  // approvalHandler.ts for the full design.
  {
    // getAllPending so MULTIPLE awaiting actions get a combined numbered
    // confirmation (YES approves all, NO rejects all) instead of a bare
    // "yes" silently resolving only the most recent one. With a single
    // pending action handlePendingApprovals behaves exactly like the old
    // handlePendingApproval path.
    const pendings = await getAllPending(phone).catch((err) => {
      console.error("handleInbound: getAllPending failed", err);
      return [];
    });
    if (pendings.length > 0) {
      const result = await handlePendingApprovals({
        phone,
        chatId,
        text,
        userId:   session.userId,
        userType: session.userType === "caregiver" ? "caregiver" : "client",
        pendings,
      });
      if (result.outcome === "handled") return;
      // result.outcome === "fallthrough" — the family asked a question instead
      // of approving/declining. Let the normal flow run so Evia can answer it;
      // the pending action stays awaiting until they answer YES/NO or it expires.
    }
  }

  // Dropped-turn watchdog: this inbound now owes the user a reply. Every
  // outbound send to this chat clears the marker (linq/client.ts sendMessage);
  // if it survives past dueAt, the commitment sweep converts it into a tracked
  // qa_answer commitment — re-answered or honestly escalated, never silence.
  db.collection("turn_watch").doc(chatId).set({
    phone,
    chatId,
    text:      text.slice(0, 500),
    userId:    (session.userId as string | undefined) ?? null,
    userType:  session.userType === "caregiver" ? "caregiver" : "client",
    inboundAt: new Date().toISOString(),
    dueAt:     new Date(Date.now() + 10 * 60_000).toISOString(),
  }).catch(() => {/* non-critical */});

  // ── LLM spend guardrails ────────────────────────────────────────────────────
  // Per-user daily turn cap + global daily kill-switch. Placed AFTER the
  // crisis fast-path (safety messages always get through) and both fail open.
  try {
    const { checkDailyTurnCap, checkGlobalDailyTurnBudget } = await import("../rateLimit");
    const [userCap, globalCap] = await Promise.all([
      checkDailyTurnCap(phone),
      checkGlobalDailyTurnBudget(),
    ]);
    if (!globalCap.allowed) {
      // Platform-wide budget exhausted: flip degraded mode (clears on the
      // first successful turn after the counter resets at midnight) and give
      // each user one honest notice per hour instead of silence.
      const { setSystemDegraded, degradedFailureNotice } = await import("../observability/systemStatus");
      if (globalCap.justBreached) {
        await setSystemDegraded("global daily LLM turn budget exhausted").catch(() => {});
      }
      const notice = await degradedFailureNotice(
        phone, session as unknown as Record<string, unknown>,
        "I've hit my processing limit for today — I'll pick this back up as soon as I'm running normally, and our team has been alerted.",
      ).catch(() => null);
      if (notice) await sendMessage(chatId, notice).catch(() => {});
      return;
    }
    if (!userCap.allowed) {
      if (userCap.justBreached) {
        await sendMessage(chatId,
          "We've traded a lot of messages today and I've hit my daily limit for this conversation — " +
          "I'll pick things back up tomorrow morning. Anything safety-related still gets through right away."
        ).catch(() => {});
      }
      return;
    }
  } catch (capErr) {
    console.error("handleInbound: spend guardrail check failed (fail-open):", capErr);
  }

  // ── Caregiver keyword handling ──────────────────────────────────────────────
  if (session.userType === "caregiver") {
    if (await routeCaregiverMessage({ phone, chatId, text, norm, session }) === "handled") return;
  }

  // ── Praise loop (fire-and-forget side effect, never consumes the message) ───
  // A family text landing shortly after an in-shift update gets sentiment-judged
  // async; genuine warmth relays to the caregiver. Normal routing still answers
  // the message below regardless.
  if (session.userType !== "caregiver" && (session as any).lastInShiftUpdate) {
    import("./inShiftPraise")
      .then(({ maybeRelayPraiseFromText }) =>
        maybeRelayPraiseFromText(phone, session as unknown as Record<string, unknown>, text))
      .catch((err) => console.error("linqWebhook: praise-loop check failed:", err));
  }

  // ── Client-side pre-intent state machines (extracted to routeClient.ts) ──────
  // Covers: awaitingPreShiftUpdate, awaitingEmergencyContactUpdate,
  // pendingShiftApproval, pendingDisputeDetail, collectingCredential,
  // jobPostingStep, modifyScheduleStep, healthcareFlowStep, refundStep,
  // timesheetStep, availabilityStep, clientSwapStep. Deliberately NOT wrapped
  // in a userType check — some blocks run for caregivers too.
  if (await routeClientStateMachines({ phone, chatId, text, norm, session }) === "handled") return;

  // ── pendingRematch + pendingTask + intent routing + QA fallback ─────────────
  // Extracted verbatim to routeIntent.ts (routeIntentAndRespond). The
  // try/catch/finally error boundary stays here at the top level: the catch
  // writes agent_error_log + admin_alerts and sends the deflection message;
  // the finally stops typing.
  try {
    await routeIntentAndRespond({ phone, chatId, text, norm, session, eventId: sourceEventId });
  } catch (err) {
    console.error("handleInbound error:", err);
    await stopTyping(chatId).catch(() => {});
    await db.collection("agent_error_log").add({
      phone, error: String(err), text, createdAt: new Date().toISOString(),
    }).catch(() => {/* non-critical */});
    await db.collection("admin_alerts").add({
      type:      "handle_inbound_failure",
      phone,
      error:     String(err),
      text:      text.slice(0, 300),
      severity:  "medium",
      createdAt: new Date().toISOString(),
      resolved:  false,
    }).catch(() => {});
    // Acknowledge only after the failure is actually recorded.
    await sendMessage(chatId, "I hit a snag on that, and I flagged it so it does not get lost.").catch(() => {});
    // Back the "does not get lost" promise: the commitment sweep re-answers
    // the turn or escalates to a human — the user always hears back.
    try {
      const { recordCommitment } = await import("../agents/commitmentTracker");
      await recordCommitment({
        phone, chatId, kind: "qa_answer",
        promiseText: "I hit a snag on that, and I flagged it so it does not get lost.",
        question:    text.slice(0, 500),
        userId:      (session.userId as string | undefined),
        seniorId:    (session.seniorId as string | undefined),
        userType:    session.userType === "caregiver" ? "caregiver" : "client",
        source:      "webhooks:handleInbound_catch",
        dueInMs:     10 * 60_000,
      });
    } catch (commitErr) {
      console.error("handleInbound: recordCommitment failed:", commitErr);
    }
  } finally {
    await stopTyping(chatId).catch(() => {});
  }
  },
  {
    name: "cara_turn",
    run_type: "chain",
    // Trace input = a compact, readable summary of the inbound turn rather than
    // the full Linq webhook payload. The single object arg is passed straight to
    // processInputs (see langsmith input-capture rules).
    processInputs: (event: any) => {
      const data = event?.data ?? {};
      const text = (data?.parts ?? [])
        .filter((p: any) => p?.type === "text" && p?.value)
        .map((p: any) => String(p.value))
        .join(" ")
        .trim();
      return {
        phone:   data?.sender_handle?.handle,
        chatId:  data?.chat?.id,
        service: data?.service ?? data?.chat?.service ?? "SMS",
        text:    text || "(non-text/media message)",
      };
    },
  },
);

// ── message.failed handler ────────────────────────────────────────────────────

async function handleMessageFailed(event: unknown): Promise<void> {
  const ev        = event as any;
  const chatId    = ev.data?.chat_id    as string | undefined;
  const messageId = ev.data?.message_id as string | undefined;
  const errorCode = ev.data?.error_code as number | undefined;
  const reason    = ev.data?.reason     as string | undefined;
  const now       = new Date().toISOString();

  await db.collection("agent_error_log").add({
    type:      "message.failed",
    chatId,
    messageId,
    errorCode,
    reason,
    failedAt:  ev.data?.failed_at ?? now,
    createdAt: now,
  }).catch(() => {});

  if (messageId) {
    await recordApprovalNoticeProviderStatus(messageId, "failed", String(errorCode ?? reason ?? "provider_failed"))
      .catch((err) => console.error("billing approval failure receipt update failed", err));
  }

  // ── Forced-iMessage → SMS retry ─────────────────────────────────────────────
  // Forced iMessage has no automatic fallback, so a failure here means the
  // recipient isn't reachable on iMessage. If this message was a tracked
  // forced-iMessage send, re-send the identical content over SMS instead of
  // paging ops. (Records are written by trackForcedIMessage in client.ts.)
  if (messageId) {
    const retryRef  = db.collection("agent_imessage_retry").doc(messageId);
    const retrySnap = await retryRef.get().catch(() => null);
    if (retrySnap?.exists) {
      const rec = retrySnap.data() as { chatId?: string; parts?: unknown[]; retried?: boolean };
      if (!rec.retried) {
        // Resolve phone via the session that owns this chat to honour opt-out.
        const sessSnap = await db.collection("agent_sessions")
          .where("chatId", "==", rec.chatId ?? chatId)
          .limit(1)
          .get()
          .catch(() => null);
        const sess = sessSnap?.docs[0]?.data() as AgentSession | undefined;

        await retryRef.update({ retried: true, retriedAt: now }).catch(() => {});

        if (sess?.optedOut || sess?.optedIn === false) {
          console.warn("message.failed: forced-iMessage failed but recipient opted out — no SMS retry", { chatId, messageId });
          await retryRef.delete().catch(() => {});
        } else {
          try {
            await sendMessage(
              rec.chatId ?? chatId!,
              { parts: (rec.parts ?? []) as any },
              { preferredService: "SMS" }
            );
            await db.collection("agent_error_log").add({
              type:      "message.failed.retried_sms",
              chatId:    rec.chatId ?? chatId,
              messageId,
              errorCode,
              reason,
              createdAt: now,
            }).catch(() => {});
            await retryRef.delete().catch(() => {});
            console.info("message.failed: forced-iMessage failed, re-sent over SMS", { chatId, messageId });
            return; // recovered — skip the high-severity admin alert below
          } catch (retryErr) {
            console.error("message.failed: SMS retry failed", { chatId, messageId, retryErr });
            await db.collection("admin_alerts").add({
              type:      "linq_imessage_sms_retry_failed",
              chatId:    rec.chatId ?? chatId,
              messageId,
              errorCode,
              reason,
              severity:  "high",
              createdAt: now,
              resolved:  false,
            }).catch(() => {});
            console.warn("linqWebhook: message.failed", { chatId, messageId, errorCode, reason });
            return;
          }
        }
      }
    }
  }

  await db.collection("admin_alerts").add({
    type:      "linq_message_failed",
    chatId,
    messageId,
    errorCode,
    reason,
    severity:  (errorCode === 4001 || errorCode === 4002) ? "high" : "medium",
    createdAt: now,
    resolved:  false,
  }).catch(() => {});

  console.warn("linqWebhook: message.failed", { chatId, messageId, errorCode, reason });
}

// ── phone_number.status_updated handler ───────────────────────────────────────

async function handlePhoneNumberStatusUpdated(event: unknown): Promise<void> {
  const ev          = event as any;
  const phoneNumber = ev.data?.phone_number          as string | undefined;
  const newStatus   = (ev.data?.new_status           as string | undefined)?.toUpperCase();
  const newHealth   = (ev.data?.new_health_status    as string | undefined)?.toLowerCase();
  const prevHealth  = (ev.data?.previous_health_status as string | undefined)?.toLowerCase();
  const now         = new Date().toISOString();

  if (!phoneNumber) return;

  await db.collection("linq_phone_health").doc(phoneNumber).set({
    phoneNumber,
    status:       newStatus,
    healthStatus: newHealth,
    updatedAt:    now,
  }, { merge: true }).catch(() => {});

  // ── FLAGGED: line is actively degraded — open circuit breaker immediately ────
  if (newStatus === "FLAGGED") {
    await db.collection("system_config").doc("linq_circuit_breaker").set({
      status:    "open",
      reason:    `Linq line ${phoneNumber} status FLAGGED`,
      openedAt:  now,
      phone:     phoneNumber,
    }, { merge: true }).catch(() => {});
    await db.collection("admin_alerts").add({
      type:      "linq_line_flagged",
      phoneNumber,
      severity:  "critical",
      message:   `Linq line ${phoneNumber} is FLAGGED — message delivery degraded. Halting outbound sends.`,
      createdAt: now,
      resolved:  false,
    }).catch(() => {});
    console.error("linqWebhook: circuit breaker OPENED — Linq line FLAGGED", { phoneNumber });
    return;
  }

  // ── ACTIVE restored: close circuit breaker if it was opened for this line ────
  if (newStatus === "ACTIVE") {
    const cb = await db.collection("system_config").doc("linq_circuit_breaker").get().catch(() => null);
    if (cb?.data()?.phone === phoneNumber && cb?.data()?.status === "open") {
      await db.collection("system_config").doc("linq_circuit_breaker").set({
        status: "closed", closedAt: now,
      }, { merge: true }).catch(() => {});
      console.info("linqWebhook: circuit breaker CLOSED — Linq line restored ACTIVE", { phoneNumber });
    }
  }

  // ── Health status degraded ────────────────────────────────────────────────────
  const degraded = newHealth === "at_risk" || newHealth === "critical";
  if (degraded) {
    await db.collection("admin_alerts").add({
      type:      "linq_phone_health_degraded",
      phoneNumber,
      prevHealth,
      newHealth,
      severity:  newHealth === "critical" ? "critical" : "high",
      message:   `Linq line ${phoneNumber} health: ${prevHealth ?? "unknown"} → ${newHealth}. ${newHealth === "critical" ? "Pause outbound messaging immediately." : "Reduce send volume."}`,
      createdAt: now,
      resolved:  false,
    }).catch(() => {});
    console.error("linqWebhook: phone number health degraded", { phoneNumber, prevHealth, newHealth });

    if (newHealth === "critical") {
      await db.collection("system_config").doc("linq_circuit_breaker").set({
        status:   "open",
        reason:   `Linq line ${phoneNumber} health went critical`,
        openedAt: now,
        phone:    phoneNumber,
      }, { merge: true }).catch(() => {});
      console.error("linqWebhook: circuit breaker OPENED — Linq line health critical", { phoneNumber });
    }
  }
}

// ── iMessage emoji reaction → task confirmation ───────────────────────────────
// Positive emojis (👍 ❤️ 😍 🎉 ✅ 👏 💙) → YES / confirm pending task
// Negative emojis (👎 ✖️) → NO / decline pending task

const POSITIVE_REACTIONS = new Set(["thumbsup", "love", "ha", "emphasize", "like", "heart", "👍", "❤️", "😍", "🎉", "✅", "👏", "💙", "🙌"]);
const NEGATIVE_REACTIONS = new Set(["thumbsdown", "dislike", "👎", "✖️", "❌"]);

async function handleReactionAdded(event: any): Promise<void> {
  const phone    = event.data?.sender_handle?.handle as string | undefined;
  const reaction = (event.data?.reaction ?? "") as string;
  const chatId   = event.data?.chat?.id     as string | undefined;
  const now      = new Date().toISOString();

  // Audit log regardless
  await db.collection("agent_reactions").add({
    chatId,
    messageId: event.data?.message_id,
    reaction,
    phone,
    reactedAt: now,
  }).catch(() => {});

  if (!phone || !chatId) return;

  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
  if (!sessionSnap.exists) return;
  const session = sessionSnap.data() as AgentSession;
  if (session.optedOut) return;

  const isYes = POSITIVE_REACTIONS.has(reaction);
  const isNo  = NEGATIVE_REACTIONS.has(reaction);
  if (!isYes && !isNo) return;

  // Check for a pending agent_task awaiting approval
  const taskSnap = await db
    .collection("agent_tasks")
    .where("clientPhone", "==", phone)
    .where("status",      "==", "awaiting_approval")
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();

  if (!taskSnap.empty && isYes) {
    const taskDoc = taskSnap.docs[0];
    if (taskDoc.data().type === "booking_confirmation") {
      const { executeBookings } = await import("../agents/bookingExecutor");
      await executeBookings(taskDoc.id, phone).catch(err =>
        console.error("handleReactionAdded: executeBookings failed:", err)
      );
    } else {
      // Generic approval for other task types (e.g. replacement selection)
      await handleTaskApproval(taskDoc, "1", session, chatId);
    }
    return;
  }

  if (!taskSnap.empty && isNo) {
    const taskDoc = taskSnap.docs[0];
    await taskDoc.ref.update({ status: "declined_by_reaction", declinedAt: now });
    await sendViaInteractionAgent(phone, {
      content:     "Got it — I'll leave it for now. Let me know if you'd like a different option.",
      urgency:     "immediate",
      sourceAgent: "reaction_handler",
      canDrop:     false,
    }).catch(() => {});
    return;
  }

  // No pending task — check if there's a pending recurring schedule confirmation in session
  if (isYes && (session as any).awaitingRecurringConfirmation) {
    const setAt = (session as any).pendingRecurringConfirmationSetAt as string | undefined;
    if (setAt && Date.now() - new Date(setAt).getTime() > 2 * 60 * 60 * 1000) {
      // Confirmation window expired — clear state
      await db.collection("agent_sessions").doc(phone).update({
        awaitingRecurringConfirmation: admin.firestore.FieldValue.delete(),
        pendingRecurringSchedule:      admin.firestore.FieldValue.delete(),
      }).catch(() => {});
      return;
    }
    await handleRecurringConfirm(phone, chatId, session);
    return;
  }

  // Praise loop: a positive tapback with nothing pending, landing shortly after
  // an in-shift update, is the family loving the update — relay it to the
  // caregiver (one-shot per update; see inShiftPraise.ts).
  if (isYes) {
    const { maybeRelayPraiseFromReaction } = await import("./inShiftPraise");
    await maybeRelayPraiseFromReaction(phone, session as unknown as Record<string, unknown>, reaction);
  }
}

// ── Webhook HTTPS function ────────────────────────────────────────────────────

export const linqWebhook = functions
  .runWith({
    memory: "1GB",
    timeoutSeconds: 180,
    secrets: [
      "BROWSERBASE_API_KEY",
      "BROWSERBASE_PROJECT_ID",
      "CREDENTIAL_VAULT_KEY",
      MEMORY_FINGERPRINT_KEY_SECRET?.name ?? MEMORY_FINGERPRINT_KEY_NAME,
    ],
  })
  .https.onRequest(async (req, res) => {
  // IMPORTANT: do NOT call res.send before the work — Cloud Functions Gen 1
  // throttles CPU after the HTTP response is sent, which causes every async
  // call (Firestore, Claude, OpenAI, Linq) to take 60–90s instead of milliseconds.
  // We respond 200 at the end so the function gets full CPU during processing.
  // Linq's webhook timeout is generous (≥10s); for slower turns the dedup
  // logic skips Linq's retry delivery.

  if (req.method !== "POST") { res.status(405).send("method not allowed"); return; }

  // Single deferred response — fires at the end no matter which branch ran.
  let sent = false;
  const sendOk = () => { if (!sent) { sent = true; res.status(200).send("ok"); } };

  try {
    const webhookSecret = process.env.LINQ_WEBHOOK_SECRET;
    if (!webhookSecret) {
      // Fail closed. If the secret is unset, we cannot verify any inbound event,
      // which means replays, spoofed senders, and signature tampering are all
      // accepted as authentic. A missing secret is a deploy-time misconfig, not
      // a runtime condition we degrade through. Return 500 so Linq retries until
      // an operator notices and the secret is restored.
      console.error("linqWebhook: LINQ_WEBHOOK_SECRET is not set — rejecting all inbound until configured");
      res.status(500).send("webhook secret not configured");
      sent = true;
      return;
    }

    const timestamp = req.headers["x-webhook-timestamp"] as string ?? "";
    const signature = req.headers["x-webhook-signature"] as string ?? "";
    const rawBody   = (req as any).rawBody as Buffer ?? Buffer.from(JSON.stringify(req.body));
    if (!verifySignature(rawBody, timestamp, signature, webhookSecret)) {
      console.warn("linqWebhook: invalid signature — ignoring");
      sendOk();
      return;
    }
    // Reject stale events (replay attack protection). Enforced regardless of
    // signature outcome above — both must pass.
    const tsNum = parseInt(timestamp, 10);
    if (!isNaN(tsNum) && Math.abs(Date.now() / 1000 - tsNum) > 300) {
      console.warn("linqWebhook: stale timestamp — ignoring");
      sendOk();
      return;
    }

    const event = req.body;
    // Linq v3 envelope uses event_type; fall back to X-Webhook-Event header for safety
    const eventType: string = event.event_type ?? (req.headers["x-webhook-event"] as string) ?? "";
    // Dedup key: prefer the explicit event id, then the message id (redeliveries
    // usually carry a stable message_id even when event_id is absent), then — so
    // dedup is NEVER silently skipped — a synthetic key hashed from the signed
    // timestamp + raw body. Without this last fallback, an id-less redelivery
    // re-drives the whole turn (duplicate reply + duplicate side effects).
    const eventId: string =
      event.event_id ??
      event.id ??
      event.data?.message_id ??
      `syn_${crypto.createHash("sha256").update(`${timestamp}:`).update(rawBody).digest("hex").slice(0, 32)}`;

    // message.received uses claim-BEFORE-process / settle-AFTER semantics: a
    // handler throw settles "failed" (deletes the claim) so Linq's at-least-once
    // retry re-drives the turn, instead of the old write-before-process dedup
    // that left a failed turn permanently suppressed (user wedged, no recovery).
    if (eventType === "message.received") {
      if (eventId && (await claimWebhookEvent(LINQ_EVENTS_COLLECTION, eventId)) === "duplicate") {
        sendOk();
        return;
      }
      try {
        await handleInbound(event, eventId);
        if (eventId) await settleWebhookEvent(LINQ_EVENTS_COLLECTION, eventId, "processed");
        sendOk();
      } catch (err) {
        console.error("linqWebhook handleInbound:", err);
        // Settling "failed" deletes the claim so Linq's at-least-once retry can
        // re-drive the turn — but that only happens if we DON'T ack 200 here.
        // Return 500 so the provider retries instead of treating the failed
        // turn as delivered (which would wedge the user with no recovery).
        if (eventId) await settleWebhookEvent(LINQ_EVENTS_COLLECTION, eventId, "failed");
        if (!sent) { sent = true; res.status(500).send("processing failed"); }
      }
      return;
    }

    // Deduplicate the remaining (idempotent / non-critical) event types by
    // event_id. Transaction makes the check-and-write atomic so concurrent
    // deliveries don't both pass.
    if (eventId) {
      const logRef = db.collection("agent_event_log").doc(eventId);
      let alreadyProcessed = false;
      await db.runTransaction(async (tx) => {
        const existing = await tx.get(logRef);
        if (existing.exists) { alreadyProcessed = true; return; }
        tx.set(logRef, { type: eventType, processedAt: new Date().toISOString() });
      });
      if (alreadyProcessed) { sendOk(); return; }
    }

  switch (eventType) {
    case "message.received":
      // Handled above with claim/settle + retry-on-failure; unreachable here.
      break;

    case "message.read":
      await db.collection("agent_read_receipts").add({
        chatId:    event.data?.chat?.id,
        messageId: event.data?.message_id,
        phone:     event.data?.sender_handle?.handle,
        readAt:    new Date().toISOString(),
      }).catch(() => {/* non-critical */});
      break;

    case "reaction.added": {
      // Serialize against message processing for the same phone — a 👍 and a
      // "yes" text arriving together must not both execute the pending booking/
      // approval (double-charge). On lock contention the reaction is dropped
      // (logged), not retried: the user's text reply still confirms, and the
      // awaiting_approval status check makes a redelivered reaction a no-op.
      const rPhone = (event as any).data?.sender_handle?.handle as string | undefined;
      const runReaction = () => handleReactionAdded(event as any);
      await (rPhone ? runSerializedByPhone(rPhone, runReaction) : runReaction())
        .catch((err) => console.error("linqWebhook handleReactionAdded:", err));
      break;
    }

    case "chat.typing_indicator.started":
      await handleTypingStarted(event).catch((err) =>
        console.error("linqWebhook handleTypingStarted:", err)
      );
      break;

    case "message.delivered": {
      const delivMsgId = event.data?.message_id ?? event.data?.id ?? event.data?.message?.id;
      if (!delivMsgId) break;
      // U2: resolve the provider id through the hashed provider-message map
      // (direct O(1) lookup) instead of the old root agent_conversations query,
      // which never matched (canonical rows live in the messages subcollection).
      await applyProviderReceipt(delivMsgId, "delivered", event.data?.delivered_at ?? new Date().toISOString())
        .catch(() => {/* non-critical */});
      // Delivered = the forced-iMessage send succeeded; drop its retry record.
      // (Stragglers without a delivered/failed event auto-expire via TTL.)
      await db.collection("agent_imessage_retry").doc(delivMsgId).delete().catch(() => {/* non-critical */});
      await recordApprovalNoticeProviderStatus(delivMsgId, "delivered")
        .catch((err) => console.error("billing approval delivery receipt update failed", err));
      break;
    }

    case "message.failed": {
      // U2: stamp failedAt on the referenced canonical row via the map, so a
      // sent-looking row doesn't stay sent-looking after a carrier failure.
      const failedMsgId = event.data?.message_id ?? event.data?.id ?? event.data?.message?.id;
      if (failedMsgId) {
        await applyProviderReceipt(failedMsgId, "failed", event.data?.failed_at ?? new Date().toISOString())
          .catch(() => {/* non-critical */});
      }
      await handleMessageFailed(event).catch((err) =>
        console.error("linqWebhook handleMessageFailed:", err)
      );
      break;
    }

    case "phone_number.status_updated":
      await handlePhoneNumberStatusUpdated(event).catch((err) =>
        console.error("linqWebhook handlePhoneNumberStatusUpdated:", err)
      );
      break;

    case "message.sent": {
      const sentMsgId  = event.data?.id ?? event.data?.message_id ?? event.data?.message?.id;
      if (!sentMsgId) break;
      // U2: mark the referenced canonical row sent via the hashed map. The old
      // "latest outbound row by chatId" query is gone — send.sent no longer
      // guesses which row it belongs to; the provider id resolves it directly.
      await applyProviderReceipt(sentMsgId, "sent", event.data?.sent_at ?? new Date().toISOString())
        .catch(() => {/* non-critical */});
      break;
    }

    case "message.edited": {
      const editMsgId = event.data?.id ?? event.data?.message_id ?? event.data?.message?.id;
      if (!editMsgId) break;
      // U2: apply the edit to the referenced canonical row via the hashed map.
      await applyProviderEdit(editMsgId, event.data?.part?.text, event.data?.edited_at ?? new Date().toISOString())
        .catch(() => {/* non-critical */});
      break;
    }

    case "reaction.removed":
      await db.collection("agent_reactions").add({
        chatId:    event.data?.chat_id,
        messageId: event.data?.message_id,
        reaction:  event.data?.reaction_type ?? event.data?.reaction,
        phone:     event.data?.from,
        operation: "removed",
        reactedAt: event.data?.reacted_at ?? new Date().toISOString(),
      }).catch(() => {/* non-critical */});
      break;

    case "chat.created":
      // Log new chat creation; check chat health on first contact
      await db.collection("agent_event_log").doc(eventId ?? crypto.randomUUID()).set({
        type:      "chat.created",
        chatId:    event.data?.id,
        service:   event.data?.service,
        isGroup:   event.data?.is_group ?? false,
        createdAt: event.data?.created_at ?? new Date().toISOString(),
      }, { merge: true }).catch(() => {});
      break;

    case "chat.typing_indicator.stopped":
      // No action needed — started is used for prefetch; stopped is informational
      break;

    case "participant.added":
      await db.collection("agent_group_events").add({
        type:      "participant.added",
        chatId:    event.data?.chat_id,
        handle:    event.data?.handle,
        joinedAt:  event.data?.added_at ?? new Date().toISOString(),
      }).catch(() => {/* non-critical */});
      break;

    case "participant.removed":
      await db.collection("agent_group_events").add({
        type:      "participant.removed",
        chatId:    event.data?.chat_id,
        handle:    event.data?.handle,
        leftAt:    event.data?.removed_at ?? new Date().toISOString(),
      }).catch(() => {/* non-critical */});
      break;

    case "chat.group_name_updated":
    case "chat.group_icon_updated":
      await db.collection("agent_group_events").add({
        type:      eventType,
        chatId:    event.data?.chat_id,
        oldValue:  event.data?.old_value,
        newValue:  event.data?.new_value,
        updatedAt: event.data?.updated_at ?? new Date().toISOString(),
      }).catch(() => {/* non-critical */});
      break;

    case "chat.group_name_update_failed":
    case "chat.group_icon_update_failed":
      console.warn(`linqWebhook: ${eventType}`, {
        chatId:    event.data?.chat_id,
        errorCode: event.data?.error_code,
      });
      break;

    default:
      console.warn(`linqWebhook: unhandled event type "${eventType || "unknown"}"`);
      break;
    }
  } catch (err) {
    console.error("linqWebhook: top-level error", err);
  } finally {
    sendOk();
  }
});
