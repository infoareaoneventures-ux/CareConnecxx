import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { traceable } from "langsmith/traceable";
import { claimWebhookEvent, settleWebhookEvent, LINQ_EVENTS_COLLECTION } from "../utils/webhookLedger";
import { sendMessage, startTyping, stopTyping, shareContactCard, checkCapability, markChatRead, AgentSession, LinqService } from "./client";
import { routeCaregiverMessage } from "./routeCaregiver";
import { routeClientStateMachines } from "./routeClient";
import { routeIntentAndRespond } from "./routeIntent";
import { handleRecurringConfirm } from "./inboundHelpers";
import { handleTaskApproval } from "../agents/taskApprovalHandler";
import { getAllPending } from "../agents/pendingActions";
import { handlePendingApprovals } from "../agents/approvalHandler";
import { optOutPhoneNumber, optInPhoneNumber, setupCaraContactCard } from "../sms";
import { buildHelpSmsReply, DiscoveryRole } from "../agents/capabilityDiscovery";
import { loadCaraOperationalContext } from "../agents/operationalContext";
import {
  handleOnboardingStep,
} from "../agents/onboardingConversation";
import { runQaAgent } from "../agents/qaAgent";
import {
  shouldRouteOnboardingToLoop,
  missingRequiredFields,
  firstGateStep,
  CLIENT_COLLECTION_STEPS,
} from "../agents/onboardingContract";
import {
  handleClientPermissionsReply,
  handleCaregiverPermissionsReply,
} from "../agents/permissionsConversation";
import { detectCrisis, isLikelyRealCrisis, classifyCrisisMultilingual } from "../safety/crisisDetector";
import { cancelTriggerIfUserReplied } from "../triggers/triggerEngine";
import { logCrisisDetected } from "../observability/auditLog";
import { createCaraOpsAlert } from "../observability/caraOpsAlerts";
import { isBereavementTrigger, activateBereavementMode } from "../agents/bereavement";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import {
  classifyCompleteness,
  classifyOfferReply,
  markOfferAccepted,
  markOfferDeclined,
  sendOnboardingOffer,
  shouldReoffer,
} from "../agents/profileCompleteness";
import { STATE_MACHINE_FLAGS, clearAllStateFlags, claimInboundProcessing, releaseInboundProcessing } from "../utils/sessionState";
import { generateCaraMessage } from "../utils/caraMessage";
import { writeFeedbackSignal } from "../ai/feedback";
import {
  initializeZepOnFirstContact,
  addUserMessageToZep,
  addBusinessDataToZep,
  getZepUserId,
} from "../memory/zepClient";
import { quickComplete } from "../utils/openaiClient";
import { extractVoiceMemoPart, transcribeVoiceMemo } from "../utils/voiceTranscription";
import { extractLocationPart, reverseGeocode, SharedLocation } from "../utils/locationShare";
import { extractMediaPart, downloadMedia, storeInboundMedia, InboundMediaPart } from "../utils/mediaIntake";
import { classifyMedia } from "../utils/visionVerify";
import { detectPersonaShift } from "../utils/personaShiftDetector";
import { collectKnownNames } from "../utils/knownNames";
import { detectLanguage, languageFromSession, t as tr, flowLabel, type Language } from "../utils/language";

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

  const [seniorSnap, journalSnap, apptSnap, historySnap] = await Promise.all([
    db.collection("senior_profiles").doc(seniorId).get(),
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

  if (!seniorSnap) return;

  await db.collection("agent_prefetch").doc(phone).set({
    seniorProfile:       seniorSnap.exists ? seniorSnap.data() : null,
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
    message:  "Possible medical emergency reported over SMS — Cara directed the user to call 911.",
    context:  { textPreview: text.slice(0, 200) },
  }).catch(() => {});
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

async function handleVisitFeedback(params: {
  phone:         string;
  chatId:        string;
  text:          string;
  caregiverId:   string;
  clientId:      string;
  appointmentId: string;
  triggerId:     string;
}): Promise<void> {
  const sentiment = await classifyFeedbackSentiment(params.text);
  const numericRating = sentiment === "positive" ? 5 : sentiment === "negative" ? 2 : 3;

  if (sentiment !== "neutral" && params.clientId && params.caregiverId) {
    await writeFeedbackSignal({
      clientId:      params.clientId,
      caregiverId:   params.caregiverId,
      signal:        sentiment === "positive" ? 1 : -1,
      source:        "post_visit_feedback",
      appointmentId: params.appointmentId,
      rawText:       params.text,
    }).catch((err) => console.error("writeFeedbackSignal error:", err));
  }

  // Write to post_visit_feedback collection for rating aggregation
  if (params.caregiverId && params.clientId) {
    await db.collection("post_visit_feedback").add({
      caregiverId:   params.caregiverId,
      clientId:      params.clientId,
      appointmentId: params.appointmentId,
      rating:        numericRating,
      sentiment,
      rawText:       params.text.slice(0, 500),
      status:        "submitted",
      createdAt:     new Date().toISOString(),
    }).catch(() => {});

    // Aggregate ratings back into the caregiver doc
    const { onFeedbackSubmitted } = await import("../agents/feedbackAggregator");
    onFeedbackSubmitted(params.caregiverId, numericRating, params.appointmentId, params.clientId)
      .catch((err) => console.error("onFeedbackSubmitted error:", err));
  }

  await db.collection("proactive_triggers").doc(params.triggerId)
    .update({ feedbackReceived: new Date().toISOString() })
    .catch(() => {});

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
export async function handleInbound(event: unknown): Promise<void> {
  const phone = (event as any)?.data?.sender_handle?.handle as string | undefined;
  // No phone → nothing to serialize on; inner will drop it.
  if (!phone) return handleInboundInner(event);

  // Wait briefly for an in-flight message from the same phone to finish. SMS
  // bursts arrive within a few seconds, so a short window catches the common
  // race.
  let acquired = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await claimInboundProcessing(phone, db)) { acquired = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!acquired) {
    // Fail closed: proceeding without the lock would let two handlers for the
    // same phone run concurrently and clobber each other's session writes — the
    // exact race this lock exists to prevent. Throw so the webhook settles the
    // event "failed" and Linq's at-least-once retry re-drives the turn once the
    // (TTL-bounded) lock frees, rather than processing unserialized.
    throw new Error(`handleInbound: per-phone lock unavailable after retries for ${phone}`);
  }

  try {
    await handleInboundInner(event);
  } finally {
    await releaseInboundProcessing(phone, db);
  }
}

// One LangSmith trace per inbound message ("turn"). Every nested LLM call
// (intent classification, the QA agent tool loop, supervisor, etc.) attaches to
// this parent run automatically via the wrapped Anthropic/OpenAI clients, so a
// turn shows up as a single tree instead of scattered calls. processInputs
// strips the raw Linq payload down to a readable summary for the trace input.
// No-op overhead when LANGSMITH_TRACING is unset.
const handleInboundInner = traceable(
  async function handleInboundTurn(event: unknown): Promise<void> {
  const ev      = event as any;
  const phone   = ev.data?.sender_handle?.handle as string | undefined;
  const chatId  = ev.data?.chat?.id as string | undefined;
  const service = (ev.data?.service ?? ev.data?.chat?.service ?? "SMS") as string;

  if (!phone || !chatId) return;

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
  // it and fall through to normal text processing so the rest of Cara doesn't
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
  // Caregivers text a headshot or a CNA/CPR card instead of using the web upload
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
    const update: Record<string, unknown> = { lastInboundAt: new Date().toISOString() };
    if (stored.chatId && stored.chatId !== chatId) {
      update.chatId  = chatId;
      update.service = service;
    }
    await db.collection("agent_sessions").doc(phone).update(update).catch(() => {});

    // Mirror the user's inbound message into the web chat inbox so the Cara
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
      .limit(1)
      .get();
    if (!groupSnap.empty) {
      primarySession = groupSnap.docs[0].data() as AgentSession;
      primaryPhone   = groupSnap.docs[0].id;
    } else {
      // Fallback: look up the collection-based membership record (MCP-added members).
      const memberSnap = await db.collection("family_group_members")
        .where("memberPhone", "==", phone)
        .limit(1)
        .get();
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

      // Detect messaging capability so session reflects real service (SMS vs iMessage vs RCS)
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

      // Create a lightweight session for this member pointing to the primary
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

      // Start Zep memory for this secondary member too — awaited so zepThreadId lands before
      // their first message is processed.
      await initializeZepOnFirstContact(phone).catch((err) =>
        console.error("Zep init failed (secondary member):", err)
      );

      await sendMessage(chatId,
        `Hi, I'm Cara — the care assistant for ${(primarySession as any).onboardingData?.seniorName ?? "your family"}. ` +
        `I've added you to the care group. You'll get the same updates and can ask me anything.`
      );
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
      // onboardingData and route to the confirm step so Cara greets by name and asks
      // them to confirm — instead of asking "What's your name?" from scratch.
      const webName = (webSessionData.name as string | undefined)?.trim() || "";
      const firstStep = webName
        ? (webRole === "caregiver" ? "caregiver_confirm_name" : "client_confirm_name")
        : (webRole === "caregiver" ? "caregiver_ask_name" : "client_ask_name");
      // Caregiver flow keys the name as `name`; client flow keys it as `firstName`
      // (matches the fields the respective ask-name handlers write).
      const seededOnboardingData = webName
        ? (webRole === "caregiver" ? { name: webName } : { firstName: webName })
        : undefined;

      // Returning user — phone already linked to an account. Skip re-onboarding;
      // restore their account context and greet them as a known user. Without
      // this, a returning user who re-verified on /start would be walked through
      // onboarding from scratch.
      const userQuery = await db.collection("users").where("phone", "==", phone).limit(1).get();
      const isReturning = !userQuery.empty;

      if (isReturning) {
        const userDoc   = userQuery.docs[0];
        const userData  = userDoc.data();
        const seniorIds = (userData.seniorIds as string[] | undefined) ?? [];
        const seniorId  = (userData.seniorId  as string | undefined) ?? seniorIds[0] ?? "";

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

      await initializeZepOnFirstContact(phone).catch((err) =>
        console.error("Zep init failed (web bridge):", err)
      );

      if (service === "iMessage") await startTyping(chatId).catch(() => {});

      // First impressions matter most — route the opening message through Cara's
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
            ? "¡Hola otra vez! Soy Cara. Me alegra verte de nuevo — ¿en qué te puedo ayudar hoy?"
            : "Welcome back. It's Cara - good to hear from you again. What should we handle first?",
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
              `Introduce yourself warmly as Cara, mention that setting up their profile takes about 5 minutes and happens right here by text, ` +
              `and naturally check that "${webName}" is the name they go by — woven into a sentence, NOT as a parenthetical instruction. Sound like a real person, not a form.`
            : `You're meeting ${webName} for the very first time over text. They're looking for care for a loved one. ` +
              `Introduce yourself warmly as Cara, their care coordinator, ` +
              `and naturally check that "${webName}" is the name they go by — woven into a sentence, NOT as a parenthetical instruction. Sound like a real person, not a form.`,
          fallback: webRole === "caregiver"
            ? (preferredLanguage === "es"
                ? `¡Hola ${webName}! Soy Cara — tu asistente para encontrar trabajo de cuidado. Configurar tu perfil toma unos 5 minutos y todo pasa aquí por mensaje.\n\n¿Te llamo ${webName}, verdad?`
                : `Hi ${webName}! I'm Cara — your assistant for finding caregiving work. Setting up your profile takes about 5 minutes and it all happens right here. Do you go by ${webName}?`)
            : (preferredLanguage === "es"
                ? `¡Hola ${webName}! Soy Cara, tu coordinadora de cuidados. ¿Te llamo ${webName}, verdad?`
                : `Hi ${webName}, I'm Cara — I'll be your care coordinator. Do you go by ${webName}?`),
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
              "Introduce yourself warmly as Cara, mention that setting up their profile takes about 5 minutes and happens right here, and ask their name. Sound like a real person, not a form."
            : "You're meeting someone for the very first time over text who's looking for care for a loved one. " +
              "Introduce yourself warmly as Cara, their care coordinator, and ask their name. Sound like a real person, not a form.",
          fallback: webRole === "caregiver"
            ? (preferredLanguage === "es"
                ? "¡Hola! Soy Cara — tu asistente para encontrar trabajo de cuidado. Configurar tu perfil toma unos 5 minutos y todo pasa aquí por mensaje.\n\n¿Cómo te llamas?"
                : "Hi! I'm Cara — your assistant for finding caregiving work. Setting up your profile takes about 5 minutes and everything happens right here.\n\nWhat's your name?")
            : (preferredLanguage === "es"
                ? "¡Hola! Soy Cara, tu coordinadora de cuidados. ¿Cómo te llamas?"
                : "Hi! I'm Cara — I'll be your care coordinator. What's your name?"),
          maxTokens: 90,
        });
      }
      await sendMessage(chatId, welcome);

      if (service === "iMessage") shareContactCard(chatId).catch(() => {/* non-critical */});
      return;
    }

    // No web session and no prior history — a cold inbound. Phone verification
    // happens on the WEBSITE (Firebase Phone Auth) before createWebOnboardingSession,
    // not over SMS — so we do NOT gate the thread behind an OTP. Lead with a proper
    // Cara intro and start onboarding right here in the thread; the inbound number
    // is the conversation identity.
    await db.collection("agent_sessions").doc(phone).set({
      chatId,
      phone,
      service,
      userType:       null,
      onboardingStep: "ask_role",
      optedIn:        true,
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
    const coldIntro = preferredLanguage === "es"
      ? "¡Hola! Soy Cara, tu coordinadora de cuidados con IA. Ayudo a las familias a encontrar cuidadores de " +
        "confianza con verificación de antecedentes — y a los cuidadores a encontrar trabajo — todo aquí por mensaje.\n\n" +
        "¿Buscas cuidado para un ser querido, o eres un cuidador?\n\n" +
        "1️⃣  Necesito cuidado para alguien\n" +
        "2️⃣  Soy cuidador buscando trabajo"
      : "Hi — I'm Cara, your AI care coordinator. I help families find trusted, background-checked caregivers — " +
        "and help caregivers find work — all right here by text.\n\n" +
        "Are you looking for care for a loved one, or are you a caregiver?\n\n" +
        "1️⃣  I need care for someone\n" +
        "2️⃣  I'm a caregiver looking for work";
    await sendMessage(chatId, coldIntro);
    // Share contact card AFTER the first outbound message — Linq requires at least
    // one outbound message in history before the share endpoint accepts the call.
    if (service === "iMessage") shareContactCard(chatId).catch(() => {/* non-critical */});
    return;
  }

  const session  = sessionSnap.data() as AgentSession;
  const norm     = text.trim().toUpperCase();
  const stopWords = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "END", "OPTOUT"]);

  // ── Chat health gate — honour OPTED_OUT; do NOT mute direct replies ───────────
  // We only hard-stop on OPTED_OUT (a real user opt-out we must respect). CRITICAL
  // health reflects line/deliverability risk that matters for PROACTIVE/bulk sends
  // (reminders, digests) — those are already gated by the global circuit breaker and
  // sendIfNotDND. Suppressing a direct reply to a user who just texted in makes Cara
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
    // Route these through Cara's voice rather than frozen templates. (The old
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
          "Starting fresh! Are you looking for care for someone, or are you a caregiver?\n\n" +
          "1️⃣  I need care for someone\n" +
          "2️⃣  I'm a caregiver"
        );
      } else {
        // Resume: restore checkpoint data and re-ask the current step's question
        await db.collection("agent_sessions").doc(phone).update({
          onboardingStep: checkpoint.step,
          onboardingData: checkpoint.onboardingData,
          stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        const resumedSession = { ...session, onboardingStep: checkpoint.step, onboardingData: checkpoint.onboardingData } as AgentSession;
        await sendMessage(chatId, "Picking up where we left off!");
        await handleOnboardingStep(phone, chatId, "__RESUME__", resumedSession);
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
      const ctx = await loadCaraOperationalContext({ phone, userId: session.userId });
      if (ctx.pendingActions[0]?.preview) {
        leadWith = `You've got something waiting on your reply: ${ctx.pendingActions[0].preview}.`;
      } else if (role === "client" && ctx.clientState?.nextAppointment) {
        leadWith = `Your next visit is on the books.`;
      } else if (role === "caregiver" && ctx.caregiverState?.pendingShiftHours) {
        leadWith = `You've got shift hours in review.`;
      }
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
        "Your Cara membership needs attention — there was an issue with your payment.\n\n" +
        "To keep your care coordination active, please update your billing at cara.app/billing. Reply SUPPORT and I'll connect you with our team.",
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
          `Cara asked: "Is this still about ${pending.seniorName ?? "the person on file"}?" ` +
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
            `Just to be sure — is this message about ${pending.seniorName ?? "the person on file"}? Reply YES or NO.`,
          );
          return;
        }
      } catch {
        await sendMessage(chatId,
          `Just to be sure — is this message about ${pending.seniorName ?? "the person on file"}? Reply YES or NO.`,
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
  if (session.onboardingStep === "complete" && session.userType === "client" && !personaResolvedThisTurn) {
    const sessionSeniorName =
      ((session as any).onboardingData?.seniorName as string | undefined) ??
      ((session as any).seniorName as string | undefined);
    const shift = await detectPersonaShift({
      text,
      sessionSenior: sessionSeniorName,
      sessionRole:   session.userType,
      // Names Cara already expects on this account (client, recipients, family,
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
            `Is this still about ${sessionSeniorName}? Reply YES to continue, or NO if it's a different family member.`
          : `Quick check — your message sounds like it might be about someone other than the person I have on file for this phone. ` +
            `Is this for the same person? Reply YES or NO.`,
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
        context: "Family asked to exit bereavement support mode. Cara is gently transitioning back to normal and offering help.",
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
          context: "30-day bereavement check-in — Cara is gently reaching out to see if the family is ready to think about care again. Tone should be warm and not pushy.",
          fallback: "I'm here with you. 💙 Whenever you're ready to arrange care again, just let me know.",
          maxTokens: 80,
        });
        await sendMessage(chatId, bereavementCheckinMsg);
      } else {
        const bereavementSupportMsg = await generateCaraMessage({
          audience: "family",
          context: "Family is in bereavement mode and has messaged. Cara is being supportive and not rushing them.",
          fallback: "I'm here with you. 💙 Take all the time you need.",
          maxTokens: 60,
        });
        await sendMessage(chatId, bereavementSupportMsg);
      }
    }
    return;
  }

  // ── Zep lazy-init — backfill for users onboarded before Zep was added ──────
  if (!(session as any).zepThreadId && session.onboardingStep === "complete") {
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
      const seniorIds = (userData.seniorIds as string[] | undefined) ?? [];
      const seniorId  = (userData.seniorId  as string | undefined) ?? seniorIds[0] ?? "";
      await db.collection("agent_sessions").doc(phone).update({
        userId,
        seniorId,
        onboardingStep: "complete",
      });
      // Reload the session so downstream code sees the updated fields
      session.userId         = userId;
      (session as any).seniorId      = seniorId;
      session.onboardingStep = "complete";
    } else if (!session.onboardingStep) {
      // Genuinely stepless and no account — start onboarding from the beginning.
      await db.collection("agent_sessions").doc(phone).update({ onboardingStep: "ask_role" });
      session.onboardingStep = "ask_role";
    } else if (session.onboardingStep !== "complete") {
      // Mid-onboarding with no account yet — this is NORMAL. A client/caregiver
      // session has no userId until the account is created (at payment), so the
      // absence of userId here is expected, not corruption. Do NOT reset to
      // ask_role: that wiped collection progress on every inbound and made Cara
      // re-greet from the top forever (and the agent-native collection loop could
      // never be reached, since its steps are client_ask_*). Leave the in-progress
      // step intact and let onboarding continue from where the user was.
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
            "Great — let's get you set up.\n\n" +
            "Are you looking for care for a loved one, or are you a caregiver?\n\n" +
            "1️⃣  I need care for someone\n" +
            "2️⃣  I'm a caregiver looking for work"
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
    // Soft-resume ack — when a user comes back mid-onboarding after a notable
    // gap (>=10 min, but inside the 30-min state-expiry window), prepend a
    // one-liner so they know we picked up where they left off instead of
    // continuing mid-question as if nothing happened. Skipped for verify_phone
    // because the OTP context speaks for itself.
    const previousInboundAt = (session as any).lastInboundAt as string | undefined;
    if (previousInboundAt && step !== "verify_phone") {
      const gapMs = Date.now() - new Date(previousInboundAt).getTime();
      if (gapMs >= 10 * 60 * 1000 && gapMs <= 30 * 60 * 1000) {
        const lang = languageFromSession(session as unknown as Record<string, unknown>);
        await sendMessage(chatId, tr.welcome_back(lang));
      }
    }

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

    // Permissions steps
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
    // U4: agent-native onboarding collapse (client-first). For a client in the
    // conversational collection phase, run the turn inside the qaAgent loop
    // instead of the scripted step runner — Cara leads collection as one agent
    // (no re-greet, no double-send). Gated OFF by default. Only plain-text turns
    // route here; media/location stay on the legacy handlers, and transactional /
    // gate steps (not in CLIENT_STEP_ORDER) are never affected.
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

    if (shouldRouteOnboardingToLoop({
      role:        session.userType,
      step,
      hasText:     text.trim() !== "",
      hasMedia:    !!inboundMedia,
      hasLocation: !!inboundLocation,
      phone,
    })) {
      try {
        await runQaAgent({
          text,
          phone,
          chatId,
          userId:      (session as any).userId ?? "",
          seniorId:    (session as any).seniorId ?? "",
          userType:    "client",
          zepThreadId: onboardingZepThreadId,
          session:     session as unknown as Record<string, unknown>,
          onboardingMode: true,
          onboardingRole: "client",
          intent:      null,
        });
        // Stuck-signup net: the cursor only advances when the model calls
        // complete_collection. If collection is actually complete but the model
        // didn't call it, advance to the gate so the user is never trapped on a
        // collection step.
        const after     = (await db.collection("agent_sessions").doc(phone).get()).data() ?? {};
        const curStep   = (after.onboardingStep as string) ?? step;
        const curData   = (after.onboardingData ?? {}) as Record<string, unknown>;
        if (CLIENT_COLLECTION_STEPS.includes(curStep) && missingRequiredFields("client", curData).length === 0) {
          await db.collection("agent_sessions").doc(phone).update({ onboardingStep: firstGateStep("client") });
          console.info("webhooks: stuck-signup net advanced cursor to gate", { phone, from: curStep });
        }
        await pushOnboardingStepToZep(step);
        return;
      } catch (err) {
        // RLB-001/005: the loop is Sonnet on the signup happy path. If it throws
        // (API outage/timeout/Firestore), do NOT wedge the user — fall through to
        // the deterministic scripted runner so collection still advances.
        console.error(
          "webhooks: onboarding agent-loop failed — falling back to scripted runner",
          err instanceof Error ? err.message : err,
        );
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
      const meta       = triggerDoc.data().metadata ?? {};
      await handleVisitFeedback({
        phone,
        chatId,
        text,
        caregiverId:   meta.caregiverId ?? "",
        clientId:      meta.clientId ?? session.userId ?? "",
        appointmentId: meta.appointmentId ?? "",
        triggerId:     triggerDoc.id,
      });
      return;
    }
  }

  // ── Pending irreversible-action approval — runtime-enforced HITL gate ──────
  // When Cara proposed a high-risk action (cancel_appointment, cancel_subscription,
  // remove_family_member, etc.) on a prior turn, the MCP gate stored a
  // pending_action doc and Cara texted the family for confirmation. This block
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
      // of approving/declining. Let the normal flow run so Cara can answer it;
      // the pending action stays awaiting until they answer YES/NO or it expires.
    }
  }

  // ── Caregiver keyword handling ──────────────────────────────────────────────
  if (session.userType === "caregiver") {
    if (await routeCaregiverMessage({ phone, chatId, text, norm, session }) === "handled") return;
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
    await routeIntentAndRespond({ phone, chatId, text, norm, session });
  } catch (err) {
    console.error("handleInbound error:", err);
    await stopTyping(chatId).catch(() => {});
    // Don't broadcast brokenness. Send a warm, natural deflection and route
    // the error to the admin alert table so the team can follow up.
    await sendMessage(chatId, "Give me a moment on that — I'll come back to you shortly.").catch(() => {});

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
}

// ── Webhook HTTPS function ────────────────────────────────────────────────────

export const linqWebhook = functions
  .runWith({
    memory: "1GB",
    timeoutSeconds: 180,
    secrets: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "CREDENTIAL_VAULT_KEY"],
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
    const eventId: string | undefined = event.event_id ?? event.id;

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
        await handleInbound(event);
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

    case "reaction.added":
      await handleReactionAdded(event as any).catch((err) =>
        console.error("linqWebhook handleReactionAdded:", err)
      );
      break;

    case "chat.typing_indicator.started":
      await handleTypingStarted(event).catch((err) =>
        console.error("linqWebhook handleTypingStarted:", err)
      );
      break;

    case "message.delivered": {
      const delivMsgId = event.data?.message_id ?? event.data?.id ?? event.data?.message?.id;
      if (!delivMsgId) break;
      await db.collection("agent_conversations")
        .where("messageId", "==", delivMsgId)
        .limit(1)
        .get()
        .then(async (snap) => {
          if (!snap.empty) {
            await snap.docs[0].ref.update({ deliveredAt: event.data?.delivered_at ?? new Date().toISOString() });
          }
        })
        .catch(() => {/* non-critical */});
      // Delivered = the forced-iMessage send succeeded; drop its retry record.
      // (Stragglers without a delivered/failed event auto-expire via TTL.)
      await db.collection("agent_imessage_retry").doc(delivMsgId).delete().catch(() => {/* non-critical */});
      break;
    }

    case "message.failed":
      await handleMessageFailed(event).catch((err) =>
        console.error("linqWebhook handleMessageFailed:", err)
      );
      break;

    case "phone_number.status_updated":
      await handlePhoneNumberStatusUpdated(event).catch((err) =>
        console.error("linqWebhook handlePhoneNumberStatusUpdated:", err)
      );
      break;

    case "message.sent": {
      // Linq message.sent event shape can vary — log it once so we know the structure
      const sentChatId = event.data?.chat?.id ?? event.data?.chat_id ?? event.data?.message?.chat_id;
      const sentMsgId  = event.data?.id ?? event.data?.message_id ?? event.data?.message?.id;
      console.info("linqWebhook message.sent data keys:", Object.keys(event.data ?? {}), "chatId:", sentChatId, "msgId:", sentMsgId);
      if (!sentChatId) break;
      await db.collection("agent_conversations")
        .where("chatId",    "==", sentChatId)
        .where("direction", "==", "outbound")
        .orderBy("createdAt", "desc")
        .limit(1)
        .get()
        .then(async (snap) => {
          if (!snap.empty) {
            await snap.docs[0].ref.update({
              messageId: sentMsgId,
              service:   event.data?.service,
              sentAt:    event.data?.sent_at ?? new Date().toISOString(),
            });
          }
        })
        .catch(() => {/* non-critical */});
      break;
    }

    case "message.edited": {
      // Store latest text for the edited part
      const editMsgId = event.data?.id ?? event.data?.message_id ?? event.data?.message?.id;
      if (!editMsgId) break;
      await db.collection("agent_conversations")
        .where("messageId", "==", editMsgId)
        .limit(1)
        .get()
        .then(async (snap) => {
          if (!snap.empty) {
            await snap.docs[0].ref.update({
              editedText: event.data?.part?.text,
              editedAt:   event.data?.edited_at ?? new Date().toISOString(),
            });
          }
        })
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
