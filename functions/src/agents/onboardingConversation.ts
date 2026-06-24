import * as admin from "firebase-admin";
import { quickComplete } from "../utils/openaiClient";
import { unwrapJson } from "../utils/jsonUtils";
import axios from "axios";
import Stripe from "stripe";
import { sendMessage, signalThinking, AgentSession } from "../linq/client";
import {
  classifyEmotionalContext,
  classifyEmotionalTopic,
  blendEmotionalContext,
  buildEmotionalContextDirective,
  StoredEmotionalContext,
} from "./emotionalContext";
import { generateToken } from "./tokenService";
import { notifyAdminNewClientSignup, notifyAdminNewCaregiverSignup } from "../notifications";
import { initializeMemoryFiles, writeMemoryFile } from "../memory/memoryFiles";
import { pushOnboardingDataToZep, addBusinessDataToZep, getZepUserId } from "../memory/zepClient";
import { buildAndSaveJobPost } from "./buildJobPost";
import { generateCaraMessage } from "../utils/caraMessage";
import { generateOtp, verifyOtp, formatOtpForDisplay, OtpState } from "../utils/phoneVerification";
import { languageFromSession, t as tr } from "../utils/language";
import { reverseGeocode, SharedLocation } from "../utils/locationShare";
import { downloadMedia, storeInboundMedia, InboundMediaPart } from "../utils/mediaIntake";
import { addKnownNames } from "../utils/knownNames";
import { verifyProfilePhoto, verifyDocument } from "../utils/visionVerify";
import { getAppUrl } from "../config/appUrl";

/** iMessage/RCS can share a location pin; plain SMS cannot. */
function isRichService(service?: string): boolean {
  const s = (service ?? "").toLowerCase();
  return s === "imessage" || s === "rcs";
}

/**
 * The "where are you" question. On iMessage/RCS, invite the one-tap location
 * share; on SMS keep the plain typed prompt (location-sharing is impossible there).
 */
function locationPrompt(base: string, service?: string): string {
  return isRichService(service)
    ? `${base}\n\nOr just tap ➕ and share your location — one tap, no typing.`
    : base;
}

/** Options threaded from the inbound webhook into the onboarding dispatcher. */
export interface OnboardingStepOptions {
  service?:         string;
  inboundLocation?: SharedLocation;
  inboundMedia?:    InboundMediaPart;
}

const db = admin.firestore();

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", { apiVersion: "2023-10-16" as any });
  return _stripe;
}

const APP_URL = getAppUrl();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function updateSession(phone: string, updates: Record<string, unknown>): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update(updates);
}

async function mergeOnboardingData(phone: string, data: Record<string, unknown>): Promise<void> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  const existing = (snap.data()?.onboardingData ?? {}) as Record<string, unknown>;
  await db.collection("agent_sessions").doc(phone).update({
    onboardingData: { ...existing, ...data },
  });
}

// Local single-shot parser used by onboarding step handlers. Powered by
// gpt-4o-mini under the hood for speed and lower rate-limit pressure.
// Strips markdown code fences from the response so JSON.parse callers don't
// fail when the model wraps the answer in ```json … ```.
async function parseWithClaude(prompt: string, userText: string): Promise<string> {
  try {
    const raw = await quickComplete(prompt, userText, { maxTokens: 200 });
    // Strip fences only — leaves plain-text answers untouched but cleans
    // up wrapped JSON. Callers that JSON.parse() the return value get a
    // clean string.
    return raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  } catch {
    return "__parse_error__";
  }
}
// Use unwrapJson where a JSON-shaped answer is needed and prose may sneak in
void unwrapJson;

async function isQuestionOrOther(text: string): Promise<boolean> {
  const result = await parseWithClaude(
    'Reply YES if this is a general question or off-topic comment. Reply NO if it is an answer to the question asked. Only reply YES or NO.',
    text
  );
  return result.toUpperCase().startsWith("Y");
}

// ── Mid-flow role-switch detector ────────────────────────────────────────────
// Catches the case where someone realized halfway through onboarding that they
// picked the wrong role ("wait, I'm actually a caregiver", "no I'm looking for
// care for my mom"). Returns the role they want to switch TO, or null.

async function detectRoleSwitch(
  text:        string,
  currentRole: "client" | "caregiver" | null,
): Promise<"client" | "caregiver" | null> {
  if (!currentRole) return null;
  if (text.trim().length < 6) return null; // too short to be a switch
  const raw = await parseWithClaude(
    `The user is mid-onboarding as a ${currentRole}. Reply with JSON: ` +
    "{\"switchTo\": \"client\" | \"caregiver\" | \"none\"}. " +
    "Use \"client\" if they are clearly saying they need care for a loved one (not their own job). " +
    "Use \"caregiver\" if they are clearly saying they are a caregiver looking for work. " +
    `Use \"none\" if their message is just answering the current question or is ambiguous. ` +
    "Only flag clear role-switch intent; do NOT flag a client mentioning they have a caregiver background, " +
    "or a caregiver mentioning their own elderly parent in passing.",
    text,
  );
  if (raw === "__parse_error__" || !raw.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw) as { switchTo?: string };
    if (parsed.switchTo === "client" && currentRole !== "client") return "client";
    if (parsed.switchTo === "caregiver" && currentRole !== "caregiver") return "caregiver";
    return null;
  } catch {
    return null;
  }
}

// ── Mid-flow correction detector ─────────────────────────────────────────────

async function detectCorrection(text: string): Promise<{ field: string; value: string } | null> {
  const raw = await parseWithClaude(
    "The user is in a conversational onboarding flow. Detect if they are correcting previously " +
    "given information (e.g. 'actually my name is X', 'wait, I meant Y', 'sorry, it's Z'). " +
    "If yes, reply with JSON: {\"field\": \"<fieldName>\", \"value\": \"<newValue>\"}. " +
    "Valid fields: firstName, seniorName, city, zipCode, hourlyRate, yearsExperience, email. " +
    "If this is NOT a correction, reply with the literal word: null",
    text
  );
  if (raw === "__parse_error__" || raw === "null" || !raw.startsWith("{")) return null;
  try {
    return JSON.parse(raw) as { field: string; value: string };
  } catch {
    return null;
  }
}

// ── Silent Firebase Auth account creation ────────────────────────────────────

// Creates (or finds) the Firebase Auth account for this phone and returns its
// uid — the canonical doc ID for caregivers/{uid} and users/{uid} (Cara/web
// data contract: Cara must write where the web reads, and the web is uid-keyed).
async function createFirebaseAuthAccount(phone: string, displayName: string): Promise<string | null> {
  try {
    const user = await admin.auth().createUser({ phoneNumber: phone, displayName });
    return user.uid;
  } catch (err: any) {
    if (err.code !== "auth/phone-number-already-exists") throw err;
    try {
      return (await admin.auth().getUserByPhoneNumber(phone)).uid;
    } catch {
      return null;
    }
  }
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

// Ordered step flow for client onboarding — used by the auto-skip logic so
// any step whose target field is already in onboardingData is silently
// advanced past instead of re-asking the user. Stops at client_ask_schedule
// because what follows is identity verification + plan selection — those have
// side effects (Stripe identity session, plan display) that can't be skipped
// based on cached fields. Caregiver flow has document uploads + payment
// redirects that can't be skipped, so we don't auto-skip caregiver steps either.
const CLIENT_STEP_ORDER = [
  "client_ask_name",
  "client_ask_senior",
  "client_ask_needs",
  "client_ask_location",
  "client_ask_schedule",
];

// Maps a client step to the onboardingData field(s) it collects. If the
// field is already present and non-empty, the step is skipped.
const CLIENT_STEP_FIELD: Record<string, string> = {
  client_ask_name:     "firstName",
  client_ask_senior:   "seniorName",
  client_ask_needs:    "age",
  client_ask_location: "city",
  client_ask_schedule: "schedule",
};

// Ordered caregiver steps the story step (idea #5) can auto-skip once its
// narrative has satisfied them. Story extraction fills experience/specialties
// in one turn; the story handler walks this order and lands on the first step
// whose field is still empty (or `caregiver_ask_profile` if the story covered
// both). Only these two are absorbable — everything after profile has prompts
// (availability, rate, email) or side effects (uploads, payment) that the story
// can't supply, so they are not in this list.
const CAREGIVER_STORY_STEP_ORDER = [
  "caregiver_ask_experience",
  "caregiver_ask_specialties",
  "caregiver_ask_profile",
];

// Maps an absorbable caregiver step to the onboardingData field it collects.
// `caregiver_ask_profile` is intentionally absent — it's only the landing step
// once both absorbable fields are filled, never itself skipped by the story.
const CAREGIVER_STORY_STEP_FIELD: Record<string, string> = {
  caregiver_ask_experience:  "yearsExperience",
  caregiver_ask_specialties: "specialties",
};

function isFieldFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string")  return value.trim().length > 0;
  if (typeof value === "number")  return value > 0;
  if (Array.isArray(value))       return value.length > 0;
  if (typeof value === "object")  return Object.keys(value as object).length > 0;
  return true;
}

/**
 * Scan an inbound message for ANY client onboarding fields and return only
 * the ones not already saved. Lets a family say "Mom Dorothy, 82, dementia,
 * 3 mornings/week in Atlanta 30301" once and have all fields captured in
 * a single turn — instead of being asked five questions.
 *
 * Conservative: returns `{}` on parse error so the regular step handlers
 * still run and ask explicitly.
 */
async function absorbClientFields(text: string, existing: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = await parseWithClaude(
    "You are extracting onboarding details from one message a family sent to Cara. " +
      "Return JSON only with the fields you can confidently extract. Omit fields not present. " +
      "Schema: " +
      `{"firstName":"family member first name (the person texting, not the senior)",` +
      `"seniorName":"senior's first name",` +
      `"relationship":"family relationship to senior (mother, father, etc.)",` +
      `"age":number,` +
      `"careNeeds":["short need phrase"],` +
      `"conditions":["short condition phrase"],` +
      `"city":"city name",` +
      `"zipCode":"5-digit US zip code",` +
      `"schedule":"plain-English schedule like '3 mornings a week'"}. ` +
      "Be conservative — only include a field if it is unambiguously stated. Reply with raw JSON, no markdown.",
    text,
  ).catch(() => "{}");
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw); } catch { return {}; }

  // Only return fields that are actually new
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!isFieldFilled(v)) continue;
    if (isFieldFilled(existing[k])) continue;
    out[k] = v;
  }
  return out;
}

export async function handleOnboardingStep(
  phone:   string,
  chatId:  string,
  text:    string,
  session: AgentSession,
  opts:    OnboardingStepOptions = {}
): Promise<void> {
  let step = session.onboardingStep ?? "";
  const norm = text.trim().toUpperCase();
  const { service, inboundLocation, inboundMedia } = opts;

  // ── Inbound image / document (vision-gated) ─────────────────────────────────
  // A texted photo/document with no text. Route by the current step before any
  // text-based detectors run (they'd misfire on empty text). The handler decides
  // whether the media fits this step; if not, it nudges the user back on track.
  if (inboundMedia && text === "") {
    return handleInboundMedia(phone, chatId, session, inboundMedia, step);
  }

  // Global: "start over" resets
  if (norm === "START OVER" || norm === "RESTART") {
    await updateSession(phone, { onboardingStep: "ask_role", onboardingData: {} });
    await sendMessage(chatId,
      "No problem — let's start fresh.\n\n" +
      "Are you looking for care for a loved one, or are you a caregiver?\n\n" +
      "1️⃣  I need care for someone\n" +
      "2️⃣  I'm a caregiver looking for work"
    );
    return;
  }

  // ── Emotional context (both flows) ──────────────────────────────────────────
  // Onboarding is where families first say the hard things ("Mom has Alzheimer's
  // and I'm scared"). Classify the posture once per turn, blend with any 12h-TTL
  // stored posture (reuses the same engine + session field as the QA agent), and
  // stash the directive on the session so step handlers can reflect the feeling
  // before logistics. Skipped for the OTP step and the RESUME sentinel — no
  // emotional content there, and it saves a model call. Also skipped for a bare
  // location pin (no text → no sentiment to classify).
  if (step !== "verify_phone" && text !== "__RESUME__" && !(inboundLocation && text === "")) {
    const current = await classifyEmotionalContext(text).catch(() => "calm" as const);
    const stored  = (session as any).emotionalContext as StoredEmotionalContext | undefined;
    const blended = blendEmotionalContext(stored, current);
    if (blended.persist) {
      await updateSession(phone, { emotionalContext: blended.persist }).catch(() => {});
    }
    (session as any)._emotionalDirective =
      buildEmotionalContextDirective(blended.value, classifyEmotionalTopic(text));
  }

  // ── Multi-field absorption (client flow only) ───────────────────────────────
  // For any client step, scan the user's message for ALL fields present, save
  // them, and auto-skip any subsequent steps whose target field is already
  // collected. Lets users front-load their answers without being re-asked.
  // Skipped fields are filled in onboardingData; the dispatcher lands on the
  // first still-unfilled step.
  const isClientStep = step === "ask_role" || step.startsWith("client_ask_");
  if (isClientStep && step !== "ask_role" && session.userType !== "caregiver") {
    const existing = (session.onboardingData ?? {}) as Record<string, unknown>;
    const absorbed = await absorbClientFields(text, existing).catch(() => ({}));
    if (Object.keys(absorbed).length > 0) {
      await mergeOnboardingData(phone, absorbed);
      session.onboardingData = { ...existing, ...absorbed };
    }

    // Auto-advance past any client step whose target field is now filled.
    while (CLIENT_STEP_FIELD[step]) {
      const field = CLIENT_STEP_FIELD[step];
      const value = (session.onboardingData as Record<string, unknown> | undefined)?.[field];
      if (!isFieldFilled(value)) break;
      const idx = CLIENT_STEP_ORDER.indexOf(step);
      const nextStep = idx >= 0 && idx < CLIENT_STEP_ORDER.length - 1
        ? CLIENT_STEP_ORDER[idx + 1]
        : null;
      if (!nextStep) break;
      step = nextStep;
    }

    if (step !== session.onboardingStep) {
      await updateSession(phone, { onboardingStep: step });
      session.onboardingStep = step;
    }
  }

  // Mid-flow role switch: "wait I'm actually a caregiver" / "no I need care, not a job".
  // Previously the only escape hatch was START OVER which wiped all progress.
  // Now: detect the intent, confirm before flipping role, and reset onboardingData
  // (different role = different fields, so previous answers don't transfer).
  if (step !== "ask_role" && step !== "verify_phone" && !step.endsWith("_send_payment")
      && !step.endsWith("_awaiting_payment") && !step.endsWith("_awaiting_stripe")
      && !step.endsWith("_awaiting_bgcheck") && !step.endsWith("_awaiting_membership")
      && !step.endsWith("_awaiting_documents") && !step.endsWith("_awaiting_photo")) {
    const switchTo = await detectRoleSwitch(text, session.userType ?? null);
    if (switchTo) {
      await updateSession(phone, {
        onboardingStep: "ask_role",
        userType:        null,
        onboardingData:  {},
      });
      await sendMessage(chatId,
        switchTo === "caregiver"
          ? "Got it — switching you over. You're a caregiver looking for work, right? Reply 2 to confirm, or 1 if you actually meant client."
          : "Got it — switching you over. You need care for someone, right? Reply 1 to confirm, or 2 if you actually meant caregiver."
      );
      return;
    }
  }

  // Mid-flow correction: "actually my name is X", "sorry, my city is Y"
  // Only applies once user has started answering (not on ask_role)
  if (step !== "ask_role" && !step.endsWith("_send_payment") && !step.endsWith("_awaiting_payment")
      && !step.endsWith("_send_photo") && !step.endsWith("_awaiting_photo")
      && !step.endsWith("_send_documents") && !step.endsWith("_awaiting_documents")
      && !step.endsWith("_send_bgcheck") && !step.endsWith("_awaiting_bgcheck")
      && !step.endsWith("_send_stripe_connect") && !step.endsWith("_awaiting_stripe")
      && !step.endsWith("_send_membership") && !step.endsWith("_awaiting_membership")
      && step !== "client_confirm_intake"
      && !step.startsWith("job_")) {
    const correction = await detectCorrection(text);
    if (correction) {
      await mergeOnboardingData(phone, { [correction.field]: correction.value });
      // Re-ask the current question
      const stepMessages: Record<string, string> = {
        client_ask_name:       "What's your name?",
        client_ask_senior:     "Who are you looking for care for? (Their name and your relationship)",
        client_ask_needs:      "What kind of help do they need, and how old are they?",
        client_ask_location:   "What city and zip code are you in?",
        client_ask_schedule:   "How many days a week and what hours do you need care?",
        caregiver_ask_name:    "What's your name?",
        caregiver_ask_location:"What city and zip code are you based in?",
        caregiver_ask_experience: "How many years of caregiving experience do you have?",
        caregiver_ask_specialties: "What types of care do you specialize in?",
        caregiver_ask_availability: "What days and hours are you available to work?",
        caregiver_ask_job_type: "Are you looking for occasional, part-time, or full-time work?",
        caregiver_ask_rate:    "What's your hourly rate?",
        caregiver_ask_email:   "What's your email address?",
      };
      let repeat = stepMessages[step] ?? "Could you continue where we left off?";
      if (step === "client_ask_location" || step === "caregiver_ask_location") {
        repeat = locationPrompt(repeat, service);
      }
      await sendMessage(chatId, `Got it — updated.\n\n${repeat}`);
      return;
    }
  }

  // Route to the appropriate step handler
  switch (step) {
    case "verify_phone":          return handleVerifyPhone(phone, chatId, text, session);
    case "ask_role":              return handleAskRole(phone, chatId, text);
    case "client_ask_name":       return handleClientAskName(phone, chatId, text, session);
    case "client_ask_senior":     return handleClientAskSenior(phone, chatId, text, session);
    case "client_ask_needs":      return handleClientAskNeeds(phone, chatId, text, session, service);
    case "client_ask_location":   return handleClientAskLocation(phone, chatId, text, session, opts);
    case "client_ask_schedule":   return handleClientAskSchedule(phone, chatId, text, session);
    case "client_ask_start":        return handleClientAskStart(phone, chatId, text, session);
    case "client_ask_preferences":  return handleClientAskPreferences(phone, chatId, text, session);
    case "client_ask_budget":       return handleClientAskBudget(phone, chatId, text, session);
    case "client_confirm_intake":   return handleClientConfirmIntake(phone, chatId, text, session);
    case "client_ask_plan":       return handleClientPlanReply(phone, chatId, text, session);
    case "client_send_payment":   return handleClientSendPayment(phone, chatId, session);
    case "client_awaiting_identity": {
      const msgIdentity = await generateCaraMessage({
        audience: "family",
        context: "A family member texted Cara while their identity verification is still in progress. Reassure them it's still being verified and that Cara will send their caregiver options as soon as it clears.",
        fallback: "Still verifying — I'll send your caregiver options as soon as it clears.",
        maxTokens: 80,
      });
      await sendMessage(chatId, msgIdentity);
      return;
    }
    case "client_awaiting_payment":
      await sendMessage(chatId, "I'm still waiting for your payment setup to complete. Tap the link I sent to finish up — it only takes 30 seconds! 💳");
      return;
    case "job_confirm_prefill":  return handleJobConfirmPrefill(phone, chatId, text, session);
    case "job_ask_start":        return handleJobAskStart(phone, chatId, text, session);
    case "job_ask_frequency":    return handleJobAskFrequency(phone, chatId, text, session);
    case "job_ask_days":         return handleJobAskDays(phone, chatId, text, session);
    case "job_ask_time":         return handleJobAskTime(phone, chatId, text, session);
    case "job_ask_care_needs":   return handleJobAskCareNeeds(phone, chatId, text, session);
    case "job_ask_care_level":   return handleJobAskCareLevel(phone, chatId, text, session);
    case "job_ask_environment":  return handleJobAskEnvironment(phone, chatId, text, session);
    case "job_ask_rate":         return handleJobAskRate(phone, chatId, text, session);
    case "job_ask_pay_method":   return handleJobAskPayMethod(phone, chatId, text, session);
    case "job_ask_description":  return handleJobAskDescription(phone, chatId, text, session);
    case "job_confirm_post":     return handleJobConfirmPost(phone, chatId, text, session);
    case "caregiver_ask_name":        return handleCaregiverAskName(phone, chatId, text, session, service);
    case "caregiver_ask_location":    return handleCaregiverAskLocation(phone, chatId, text, session, opts);
    case "caregiver_ask_story":       return handleCaregiverAskStory(phone, chatId, text, session);
    case "caregiver_ask_experience":  return handleCaregiverAskExperience(phone, chatId, text, session);
    case "caregiver_ask_specialties": return handleCaregiverAskSpecialties(phone, chatId, text, session);
    case "caregiver_ask_profile":      return handleCaregiverAskProfile(phone, chatId, text, session);
    case "caregiver_ask_availability": return handleCaregiverAskAvailability(phone, chatId, text, session);
    case "caregiver_ask_job_type":     return handleCaregiverAskJobType(phone, chatId, text, session);
    case "caregiver_ask_rate":         return handleCaregiverAskRate(phone, chatId, text, session);
    case "caregiver_ask_email":        return handleCaregiverAskEmail(phone, chatId, text, session);
    case "caregiver_ask_bio":          return handleCaregiverAskBio(phone, chatId, text, session);
    case "caregiver_send_photo":       return handleCaregiverSendPhoto(phone, chatId, session);
    case "caregiver_awaiting_photo":
      await sendMessage(chatId, "Still waiting for your photo! Tap the upload link I sent 📷");
      return;
    case "caregiver_send_documents":  return handleCaregiverSendDocuments(phone, chatId, session);
    case "caregiver_awaiting_documents":
      if (norm === "SKIP") {
        await updateSession(phone, { onboardingStep: "caregiver_ask_mvr" });
        return handleCaregiverAskMvr(phone, chatId, session);
      }
      await sendMessage(chatId, "Tap the link I sent to upload your certifications, or reply SKIP to continue without them.");
      return;
    case "caregiver_ask_mvr":          return handleCaregiverAskMvr(phone, chatId, text, session);
    case "caregiver_send_membership":  return handleCaregiverSendMembership(phone, chatId, session);
    case "caregiver_awaiting_membership":
      await handleCaregiverResendMembership(phone, chatId, session, text);
      return;
    case "caregiver_send_bgcheck":    return handleCaregiverSendBgcheck(phone, chatId, session);
    case "caregiver_awaiting_bgcheck": {
      const msgBgcheck = await generateCaraMessage({
        audience: "caregiver",
        context: "A caregiver texted Cara while their background check is still processing. Let them know it's still in progress, that it usually takes 1–3 days, and that Cara will text them the moment results are in.",
        fallback: "Your background check is still processing — usually 1–3 days. I'll text you the moment results are in.",
        maxTokens: 80,
      });
      await sendMessage(chatId, msgBgcheck);
      return;
    }
    case "caregiver_send_stripe_connect": return handleCaregiverSendStripeConnect(phone, chatId, session);
    case "caregiver_awaiting_stripe":
      await sendMessage(chatId, "Tap the link I sent to set up your payout account so you can get paid after each visit.");
      return;
    default:
      await sendMessage(chatId, "I think something went sideways. Reply START OVER to begin fresh.");
  }
}

// ── verify_phone ──────────────────────────────────────────────────────────────
// Phone-possession check. The session was created with an OTP that we texted
// to the FROM number; only the real owner of that number receives it. We block
// progression past this step until they reply with the code.

async function handleVerifyPhone(
  phone:   string,
  chatId:  string,
  text:    string,
  session: AgentSession,
): Promise<void> {
  const norm = text.trim().toUpperCase();
  const otp  = (session as unknown as { otp?: OtpState }).otp;
  const lang = languageFromSession(session as unknown as Record<string, unknown>);

  // If the message looks more like a question than an OTP code or RESEND/STOP keyword,
  // answer it and re-prompt instead of failing the OTP attempt.
  const looksLikeCode = /^\s*\d{4,6}\s*$/.test(text);
  if (!looksLikeCode && norm !== "RESEND" && norm !== "START OVER" && norm !== "RESTART" && await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "Please reply with the 6-digit verification code I just texted you. (Reply RESEND if you didn't get it.)");
    return;
  }

  // RESEND — issue a new code (rate-limited to once per 30s by checking issuedAt)
  if (norm === "RESEND") {
    const issuedMs = otp?.issuedAt ? new Date(otp.issuedAt).getTime() : 0;
    if (Date.now() - issuedMs < 30_000) {
      await sendMessage(chatId, tr.otp_resend_too_soon(lang));
      return;
    }
    const fresh = generateOtp();
    await updateSession(phone, { otp: fresh });
    await sendMessage(chatId, tr.otp_resend_new_code(formatOtpForDisplay(fresh.code), lang));
    return;
  }

  const result = verifyOtp(text, otp);
  if (result.status === "ok") {
    await updateSession(phone, {
      onboardingStep: "ask_role",
      otp:            null,
    });
    await sendMessage(chatId, tr.otp_verified_role_question(lang));
    return;
  }
  if (result.status === "expired" || result.status === "locked" || result.status === "no_state") {
    const fresh = generateOtp();
    await updateSession(phone, { otp: fresh });
    await sendMessage(chatId, tr.otp_fresh_code_after_expiry(formatOtpForDisplay(fresh.code), lang));
    return;
  }
  // wrong — increment attempts, prompt again
  const attempts = (otp?.attempts ?? 0) + 1;
  await updateSession(phone, { otp: { ...otp!, attempts } });
  await sendMessage(chatId, tr.otp_wrong(result.attemptsLeft, lang));
}

// ── ask_role ──────────────────────────────────────────────────────────────────

async function handleAskRole(phone: string, chatId: string, text: string): Promise<void> {
  const raw = await parseWithClaude(
    'The user is choosing between two options: (1) they need care for a loved one (family/client) or ' +
    '(2) they are a caregiver looking for work. ' +
    '"1", "family", "need care", "mom", "dad", "parent", "loved one" → client. ' +
    '"2", "caregiver", "CNA", "HHA", "nurse", "work", "job", "looking for work" → caregiver. ' +
    'Reply with exactly one word: client or caregiver. If truly unclear, reply: unclear',
    text
  );
  if (raw === "client") {
    await updateSession(phone, { onboardingStep: "client_ask_name", userType: "client" });
    const msg1 = await generateCaraMessage({
      audience: "family",
      context: "Cara is greeting a new family member who just said they're looking for care for a loved one. Ask for their name warmly.",
      fallback: "I'd love to help. What's your name?",
      maxTokens: 80,
    });
    await sendMessage(chatId, msg1);
    return;
  }
  if (raw === "caregiver") {
    await updateSession(phone, { onboardingStep: "caregiver_ask_name", userType: "caregiver" });
    const msg2 = await generateCaraMessage({
      audience: "caregiver",
      context: "Cara is greeting a new caregiver who just said they're looking for work. Let them know profile setup takes about 5 minutes and everything happens right here over text. Then ask for their name.",
      fallback: "Great — let's get your profile set up. Takes about 5 minutes and everything happens right here.\n\nWhat's your name?",
      maxTokens: 80,
    });
    await sendMessage(chatId, msg2);
    return;
  }
  await sendMessage(chatId,
    "I want to make sure I help you with the right thing!\n\n" +
    "Reply 1 if you need care for a loved one, or 2 if you're a caregiver looking for work."
  );
}

// ── CLIENT FLOW ───────────────────────────────────────────────────────────────

async function handleClientAskName(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "What's your name?");
    return;
  }
  const firstName = await parseWithClaude(
    "Extract only the first name from this message. Reply with just the first name, nothing else. If you cannot find a name, reply: unknown",
    text
  );
  const safeName = (!firstName || firstName === "__parse_error__" || firstName === "unknown") ? "there" : firstName;
  if (safeName === "there") {
    await sendMessage(chatId, "I didn't catch your name — could you share it?");
    return;
  }
  await mergeOnboardingData(phone, { firstName: safeName });
  await updateSession(phone, { onboardingStep: "client_ask_senior" });
  const msg3 = await generateCaraMessage({
    audience: "family",
    context: `Cara just learned the client's name is ${safeName}. Greet them warmly by name and ask who they're looking for care for (name and relationship to them, e.g. "my mom Dorothy").`,
    fallback: `Nice to meet you, ${safeName}. Who are we caring for?`,
    maxTokens: 80,
  });
  await sendMessage(chatId, msg3);
}

async function handleClientAskSenior(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "Now, who are you looking for care for? (Their name and your relationship, e.g. 'my mom Dorothy')");
    return;
  }
  const raw = await parseWithClaude(
    'Extract the senior\'s first name and the user\'s relationship to them from this message. Reply in JSON format: {"seniorName":"...","relationship":"..."}',
    text
  );
  let seniorName = "your loved one", relationship = "family member";
  try {
    const parsed = JSON.parse(raw);
    seniorName   = parsed.seniorName   || seniorName;
    relationship = parsed.relationship || relationship;
  } catch { /* keep defaults */ }

  await mergeOnboardingData(phone, { seniorName, relationship });
  await updateSession(phone, { onboardingStep: "client_ask_needs" });
  const msg4 = await generateCaraMessage({
    audience: "family",
    context: `Cara is onboarding a family. They just said they're looking for care for ${seniorName} (their ${relationship}). Ask how old ${seniorName} is and what kind of help they need these days.`,
    fallback: `Got it. How old is ${seniorName}, and what do they need help with these days?`,
    maxTokens: 80,
  });
  await sendMessage(chatId, msg4);
}

async function handleClientAskNeeds(phone: string, chatId: string, text: string, session: AgentSession, service?: string): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    const d = session.onboardingData ?? {};
    await sendMessage(chatId, `How old is ${d.seniorName ?? "your loved one"}, and what kind of help do they need?`);
    return;
  }
  const raw = await parseWithClaude(
    'Extract age (as number), careNeeds (array of strings), and conditions (array of strings) from this message. Reply in JSON: {"age":0,"careNeeds":[],"conditions":[]}',
    text
  );
  let age = 0;
  let careNeeds: string[] = [];
  let conditions: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    age        = parsed.age        ?? 0;
    careNeeds  = parsed.careNeeds  ?? [];
    conditions = parsed.conditions ?? [];
  } catch { /* keep defaults */ }

  await mergeOnboardingData(phone, { age, careNeeds, conditions });
  await updateSession(phone, { onboardingStep: "client_ask_location" });
  const seniorName = session.onboardingData?.seniorName;
  const condLabel = conditions.length > 0 ? conditions.join(", ") : (careNeeds.length > 0 ? careNeeds.join(", ") : "");
  const msg5 = await generateCaraMessage({
    audience: "family",
    context:
      `Cara is collecting onboarding info for a family caring for ${seniorName ?? "their loved one"}. ` +
      `They just shared the care situation${condLabel ? ` (${condLabel})` : ""}. ` +
      `If the situation is emotionally heavy (memory care, a serious diagnosis, or the family sounds worried), ` +
      `acknowledge that weight warmly in one short sentence first — no platitudes, no clinical hedging. ` +
      `Then ask what city and zip code ${seniorName ?? "they"} lives in so you can find specialists nearby.`,
    fallback: `And where does ${seniorName ?? "they"} live?`,
    emotionalDirective: (session as any)._emotionalDirective,
    maxTokens: 120,
  });
  await sendMessage(chatId, locationPrompt(msg5, service));
}

async function handleClientAskLocation(phone: string, chatId: string, text: string, session: AgentSession, opts: OnboardingStepOptions = {}): Promise<void> {
  const { service, inboundLocation } = opts;

  // One-tap location pin (iMessage/RCS): use the coords directly, reverse-geocode
  // to backfill city/zip for the rest of the city-centric flow, and store raw
  // lat/lng for true haversine matching. No parseWithClaude needed.
  if (inboundLocation) {
    const rev = await reverseGeocode(inboundLocation.lat, inboundLocation.lng);
    const city = rev?.city ?? "", zipCode = rev?.zipCode ?? "";
    await mergeOnboardingData(phone, { city, zipCode, lat: inboundLocation.lat, lng: inboundLocation.lng });
    await updateSession(phone, { onboardingStep: "client_ask_schedule" });
    const d = session.onboardingData ?? {};
    const ack = city
      ? `Got it — pinned you to ${city}${zipCode ? ` ${zipCode}` : ""}. `
      : "Got your location, thanks! ";
    const msgPin = await generateCaraMessage({
      audience: "family",
      context: `Cara just received the family's shared location${city ? ` (${city})` : ""}. Acknowledge it warmly in one short line, then ask how often ${d.seniorName ?? "their loved one"} needs a caregiver and what times of day work best.`,
      fallback: `${ack}How often does ${d.seniorName ?? "they"} need someone, and what times of day work best?`,
      maxTokens: 90,
    });
    await sendMessage(chatId, msgPin);
    return;
  }

  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, locationPrompt("What city and zip code are you in? (e.g. \"Austin, TX 78701\")", service));
    return;
  }
  const raw = await parseWithClaude(
    'Extract city and zipCode from this address text. Reply in JSON: {"city":"...","zipCode":"..."}',
    text
  );
  let city = "", zipCode = "";
  try {
    if (raw !== "__parse_error__") {
      const parsed = JSON.parse(raw);
      city    = parsed.city    ?? "";
      zipCode = parsed.zipCode ?? "";
    }
  } catch { /* keep defaults */ }

  if (!city && !zipCode) {
    await sendMessage(chatId, locationPrompt("Hmm, I didn't catch that. Could you share your city and zip code? (e.g. \"Austin, TX 78701\")", service));
    return;
  }

  await mergeOnboardingData(phone, { city, zipCode });
  await updateSession(phone, { onboardingStep: "client_ask_schedule" });
  const d = session.onboardingData ?? {};
  const msg6 = await generateCaraMessage({
    audience: "family",
    context: `Cara is onboarding a family. They just gave the location where ${d.seniorName ?? "their loved one"} lives. Ask how often ${d.seniorName ?? "they"} needs a caregiver and what times of day work best.`,
    fallback: `How often does ${d.seniorName ?? "they"} need someone, and what times of day work best?`,
    maxTokens: 80,
  });
  await sendMessage(chatId, msg6);
}

async function handleClientAskSchedule(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    const d = session.onboardingData ?? {};
    await sendMessage(chatId, `How often does ${d.seniorName ?? "they"} need someone, and what times of day work best?`);
    return;
  }
  const raw = await parseWithClaude(
    'Extract daysPerWeek (number), timeOfDay (morning/afternoon/evening/all-day), and hoursPerDay (number) from this message. Reply in JSON: {"daysPerWeek":0,"timeOfDay":"","hoursPerDay":0}',
    text
  );
  if (raw === "__parse_error__") {
    await sendMessage(chatId, "Hmm, I didn't catch that. What days and hours do you need care? (e.g. \"Mon–Fri, 9am to 3pm\" or \"3 days a week, mornings\")");
    return;
  }
  let daysPerWeek = 3, timeOfDay = "mornings", hoursPerDay = 4;
  try {
    const parsed = JSON.parse(raw);
    daysPerWeek = parsed.daysPerWeek ?? daysPerWeek;
    timeOfDay   = parsed.timeOfDay   ?? timeOfDay;
    hoursPerDay = parsed.hoursPerDay ?? hoursPerDay;
  } catch { /* keep defaults */ }

  await mergeOnboardingData(phone, { daysPerWeek, timeOfDay, hoursPerDay });
  await updateSession(phone, { onboardingStep: "client_ask_start" });
  const dSched = session.onboardingData ?? {};
  const seniorSched = (dSched.seniorName as string) ?? "your loved one";
  const startMsg = await generateCaraMessage({
    audience: "family",
    context: `Cara is onboarding a family for ${seniorSched}. They just gave their schedule. Acknowledge it in one short line, then ask when they'd like care to start — right away, or a specific date.`,
    fallback: `Got it. And when would you like care to start for ${seniorSched} — right away, or a specific date?`,
    emotionalDirective: (session as any)._emotionalDirective,
    maxTokens: 90,
  });
  await sendMessage(chatId, startMsg);
}

// ── New intake steps: start date → preferences → budget → playback confirm ─────

async function handleClientAskStart(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "When would you like care to start — right away, or a specific date?");
    return;
  }
  const parsed = await parseWithClaude(
    "Extract when the family wants care to start. Reply with a short phrase: \"asap\" if they want it right away/" +
    "urgently, the specific date in their own words if they gave one, or \"flexible\" if they're unsure. Just the phrase.",
    text
  );
  const startDate = (!parsed || parsed === "__parse_error__") ? "flexible" : parsed;
  await mergeOnboardingData(phone, { startDate });
  await updateSession(phone, { onboardingStep: "client_ask_preferences" });
  const prefMsg = await generateCaraMessage({
    audience: "family",
    context: `Cara is onboarding a family; care should start "${startDate}". Acknowledge briefly, then ask if they have any preferences for the caregiver — gender, language, or whether they need someone who can drive. Make clear it's optional and they can just say "no preference".`,
    fallback: "Any preferences for the caregiver — gender, language, or someone who can drive? Totally optional — just say \"no preference\" if not.",
    emotionalDirective: (session as any)._emotionalDirective,
    maxTokens: 90,
  });
  await sendMessage(chatId, prefMsg);
}

async function handleClientAskPreferences(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "Any preferences for the caregiver — gender, language, driving? (or \"no preference\")");
    return;
  }
  const raw = await parseWithClaude(
    "Extract caregiver preferences. Reply in JSON: {\"gender\":\"\",\"language\":\"\",\"driving\":false,\"other\":\"\"}. " +
    "gender: \"female\"/\"male\" or \"\" if none. language: a language name or \"\". driving: true only if they need " +
    "someone who can drive. other: any other preference (pets, smoking, non-smoker, etc.) or \"\". If they say no " +
    "preference, return all empty/false.",
    text
  );
  let prefs: { gender?: string; language?: string; driving?: boolean; other?: string } = {};
  try { prefs = JSON.parse(raw); } catch { /* none */ }
  await mergeOnboardingData(phone, {
    caregiverPreferences: prefs,
    // Top-level keys the matching engine reads directly (matchingAgent + claudeMatching).
    genderPreference:   prefs.gender   ?? "",
    languagePreference: prefs.language ?? "",
    needsDriving:       prefs.driving === true,
    otherPreference:    prefs.other    ?? "",
  });
  await updateSession(phone, { onboardingStep: "client_ask_budget" });
  const d = session.onboardingData ?? {};
  const city = (d.city as string) ?? "";
  const rangeHint = city ? `Caregivers near ${city} typically run $18–28/hr` : "Caregivers typically run $18–28/hr";
  const budgetMsg = await generateCaraMessage({
    audience: "family",
    context: `Cara is onboarding a family. They just shared caregiver preferences. Now ask about budget. In one line make clear the caregiver's hourly pay is SEPARATE from the CareConnex membership, include this hint verbatim: "${rangeHint}", and ask if they have an hourly budget in mind (they can say "not sure"). Warm and brief.`,
    fallback: `One more — caregivers are paid hourly, separate from your CareConnex membership. ${rangeHint}. Do you have an hourly budget in mind? ("not sure" is totally fine)`,
    maxTokens: 110,
  });
  await sendMessage(chatId, budgetMsg);
}

async function handleClientAskBudget(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "Do you have an hourly budget in mind? (\"not sure\" is fine)");
    return;
  }
  const raw = await parseWithClaude(
    "Extract the family's hourly budget. Reply in JSON: {\"min\":0,\"max\":0}. If one number, set both to it. " +
    "If a range, set min and max. If they're not sure / no budget, return {\"min\":0,\"max\":0}.",
    text
  );
  let budget = { min: 0, max: 0 };
  try { const p = JSON.parse(raw); budget = { min: Number(p.min) || 0, max: Number(p.max) || 0 }; } catch { /* none */ }
  // Store budgetMax top-level too — the matching engine reads it directly.
  await mergeOnboardingData(phone, { budget, budgetMin: budget.min, budgetMax: budget.max });
  await updateSession(phone, { onboardingStep: "client_confirm_intake" });
  const refreshed = await db.collection("agent_sessions").doc(phone).get();
  const rs = refreshed.data() as AgentSession;
  await sendClientIntakeSummary(chatId, rs);
}

// Plain-text playback of everything Cara captured — a confirmation gate before
// the paywall so a parse error can't slip through unnoticed.
function buildIntakeSummary(d: Record<string, unknown>): string {
  const seniorName = (d.seniorName as string) || "your loved one";
  const age        = d.age ? `${d.age}` : "";
  const conditions = Array.isArray(d.conditions) && d.conditions.length
    ? (d.conditions as string[]).join(", ")
    : Array.isArray(d.careNeeds) && (d.careNeeds as string[]).length
      ? (d.careNeeds as string[]).join(", ")
      : "";
  const loc   = [d.city, d.zipCode].filter(Boolean).join(" ");
  const days  = d.daysPerWeek ? `${d.daysPerWeek} day${Number(d.daysPerWeek) === 1 ? "" : "s"}/week` : "";
  const tod   = (d.timeOfDay as string) || "";
  const sched = [days, tod].filter(Boolean).join(", ");
  const start = (d.startDate as string) || "";
  const prefs = (d.caregiverPreferences as Record<string, unknown> | undefined) ?? {};
  const prefBits: string[] = [];
  if (prefs.gender)   prefBits.push(String(prefs.gender));
  if (prefs.language) prefBits.push(`${prefs.language}-speaking`);
  if (prefs.driving)  prefBits.push("can drive");
  if (prefs.other)    prefBits.push(String(prefs.other));
  const b = (d.budget as { min?: number; max?: number } | undefined) ?? {};
  const budget = (b.min || b.max)
    ? (b.min === b.max ? `$${b.max}/hr` : `$${b.min}–${b.max}/hr`)
    : "";

  const lines = ["Here's what I've got:"];
  lines.push(`• Care for ${seniorName}${age || conditions ? ` (${[age, conditions].filter(Boolean).join(", ")})` : ""}`);
  if (loc)            lines.push(`• In ${loc}`);
  if (sched)          lines.push(`• ${sched}`);
  if (start)          lines.push(`• Starting: ${start}`);
  if (prefBits.length) lines.push(`• Preference: ${prefBits.join(", ")}`);
  if (budget)         lines.push(`• Budget: ${budget}`);
  lines.push("", "Did I get that right? Reply YES to see your matches, or tell me what to fix.");
  return lines.join("\n");
}

async function sendClientIntakeSummary(chatId: string, session: AgentSession): Promise<void> {
  await sendMessage(chatId, buildIntakeSummary(session.onboardingData ?? {}));
}

// Pull any corrected intake fields out of a free-text edit at the confirm step.
async function extractIntakeCorrections(text: string): Promise<Record<string, unknown>> {
  const raw = await parseWithClaude(
    "The family is correcting their care intake. Extract ONLY the fields they're changing; omit the rest. " +
    "Return raw JSON with any of: {\"seniorName\":\"\",\"age\":0,\"careNeeds\":[],\"conditions\":[],\"city\":\"\"," +
    "\"zipCode\":\"\",\"daysPerWeek\":0,\"timeOfDay\":\"\",\"hoursPerDay\":0,\"startDate\":\"\",\"budget\":{\"min\":0,\"max\":0}}. " +
    "Only include a field if they clearly changed it.",
    text
  ).catch(() => "{}");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      if (typeof v === "number" && v === 0) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (k === "budget") {
        const bv = v as { min?: number; max?: number };
        if (!bv.min && !bv.max) continue;
      }
      out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function handleClientConfirmIntake(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const intent = await parseWithClaude(
    '"yes", "yep", "correct", "looks good", "that\'s right", "go", "perfect" → confirm. ' +
    'Anything that corrects/changes a detail, or says no → edit. Reply with exactly one word: confirm or edit.',
    text
  );
  if (intent === "confirm") {
    const refreshed = await db.collection("agent_sessions").doc(phone).get();
    const rs = refreshed.data() as AgentSession;
    (rs as any)._emotionalDirective = (session as any)._emotionalDirective;
    await handleClientShowCaregivers(phone, chatId, rs);
    return;
  }
  const corrections = await extractIntakeCorrections(text);
  if (Object.keys(corrections).length > 0) {
    await mergeOnboardingData(phone, corrections);
    const refreshed = await db.collection("agent_sessions").doc(phone).get();
    await sendMessage(chatId, "Got it — updated.");
    await sendClientIntakeSummary(chatId, refreshed.data() as AgentSession);
  } else {
    await sendMessage(chatId, "No problem — tell me what to change and I'll fix it. Or reply YES to go ahead.");
  }
}

async function createClientIdentitySession(phone: string): Promise<string> {
  const caraPhone = encodeURIComponent(process.env.LINQ_PHONE_NUMBER ?? "");
  const session = await getStripe().identity.verificationSessions.create({
    type: "document",
    metadata: { phone },
    return_url: `${APP_URL}/client/identity-callback?source=cara&caraPhone=${caraPhone}`,
  });
  await db.collection("agent_sessions").doc(phone).update({ identitySessionId: session.id });
  return session.url!;
}

async function handleClientShowCaregivers(
  phone: string,
  chatId: string,
  session: AgentSession
): Promise<void> {
  const d          = (session as any).onboardingData ?? {};
  const city       = (d.city       as string) ?? "";
  const seniorName = (d.seniorName as string) ?? "your loved one";
  const careNeeds: string[] = Array.isArray(d.careNeeds) ? d.careNeeds : [];

  // Query caregivers in their city first. If none, WIDEN to any active caregiver
  // (nearest available) rather than dead-ending — and only if there's truly zero
  // supply anywhere do we honestly hold and skip the paywall.
  const localSnap = await db
    .collection("caregivers")
    .where("status", "==", "active")
    .where("city",   "==", city)
    .limit(5)
    .get();

  let docs: FirebaseFirestore.DocumentData[];
  let total: number;
  let widened = false;

  if (!localSnap.empty) {
    docs  = localSnap.docs.map(doc => doc.data());
    total = localSnap.size;
  } else {
    const widerSnap = await db.collection("caregivers").where("status", "==", "active").limit(5).get();
    if (widerSnap.empty) {
      // No supply at all — don't take payment for something we can't deliver.
      await updateSession(phone, { onboardingStep: "complete", awaitingSupply: true });
      await sendMessage(chatId,
        `I don't have caregivers available in ${city || "your area"} just yet — but I've saved everything about ` +
        `${seniorName}'s care, and I'll text you the moment the right person is available. No charge until then. 💙`
      );
      return;
    }
    docs    = widerSnap.docs.map(doc => doc.data());
    total   = widerSnap.size;
    widened = true;
  }

  const preview = docs.slice(0, 3).map(c => {
    const name  = (c.name ?? "Caregiver") as string;
    const exp   = c.yearsExperience ?? c.experience ?? "";
    const spec  = Array.isArray(c.specialties)
      ? c.specialties[0]
      : (c.primaryServices?.[0]?.name ?? "");
    return `• ${name}${exp ? ` — ${exp} yrs exp` : ""}${spec ? `, ${spec}` : ""}`;
  }).join("\n");

  const locationLabel = city || "your area";
  const needsLabel    = careNeeds.length > 0
    ? careNeeds.slice(0, 2).join(" & ")
    : "care";

  const caregiverMsg = widened
    ? `I don't have caregivers right in ${locationLabel} yet, but here are the nearest ones available:\n\n${preview}\n\n` +
      `Here's how I'd get ${seniorName} connected with one:`
    : `I found ${total > 5 ? "6+" : total} caregiver${total !== 1 ? "s" : ""} near ${locationLabel} ` +
      `who can help with ${needsLabel}:\n\n${preview}\n\n` +
      `Here's how I'd get ${seniorName} connected with them:`;

  await sendMessage(chatId, caregiverMsg);

  // Value first (real caregivers shown above), then price, THEN identity, THEN
  // payment — so a family never has to scan a government ID before they even
  // know what CareConnex costs. handleClientPresentPlan sets up the price.
  await updateSession(phone, { onboardingStep: "client_ask_plan" });
  await handleClientPresentPlan(phone, chatId, session);
}

// When a caregiver activates, re-engage families we honestly held (awaitingSupply)
// in that city: clear the flag, tell them care is now available, and drop them
// back into the show-caregivers → price flow (which now has real supply).
async function notifyWaitlistedFamilies(caregiverCity: string): Promise<void> {
  if (!caregiverCity) return;
  const cityLower = caregiverCity.toLowerCase();
  const snap = await db.collection("agent_sessions").where("awaitingSupply", "==", true).get();
  for (const doc of snap.docs) {
    try {
      const s      = doc.data() as AgentSession;
      const famCity = ((s.onboardingData?.city as string) ?? "").toLowerCase();
      if (!famCity || famCity !== cityLower) continue;
      const chatId = s.chatId;
      if (!chatId) continue;
      const seniorName = (s.onboardingData?.seniorName as string) ?? "your loved one";
      await db.collection("agent_sessions").doc(doc.id).update({ awaitingSupply: false }).catch(() => {});
      await sendMessage(chatId,
        `Good news — a caregiver just became available near ${caregiverCity}! Let me show you who can help ${seniorName}.`
      );
      await handleClientShowCaregivers(doc.id, chatId, s);
    } catch (err) {
      console.error("[notifyWaitlistedFamilies] error for", doc.id, err);
    }
  }
}

// Resolve the single configured client price. The 3-tier STRIPE_PLAN_*_PRICE_ID
// vars are not set in prod — only one monthly price exists — so picking a tier
// used to hand Stripe an empty priceId. Lead with the one real price.
function resolveClientPriceId(): string {
  return process.env.STRIPE_MEMBERSHIP_PRICE_ID
    ?? process.env.STRIPE_PRICE_MONTHLY
    ?? process.env.STRIPE_PLAN_FAMILY_PRICE_ID
    ?? "";
}

// Single source of truth for the displayed price: read the amount straight from
// the live Stripe price object so the copy can never drift from what the family
// is actually charged. Returns "" on any error (copy degrades to generic).
async function describeClientPrice(priceId: string): Promise<string> {
  try {
    if (!priceId) return "";
    const price = await getStripe().prices.retrieve(priceId);
    if (price.unit_amount == null) return "";
    const dollars = price.unit_amount / 100;
    const amount  = Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
    const interval = price.recurring?.interval;
    return interval ? `${amount}/${interval === "month" ? "mo" : interval}` : amount;
  } catch (err) {
    console.error("describeClientPrice error:", err);
    return "";
  }
}

async function handleClientPresentPlan(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const d          = session.onboardingData ?? {};
  const seniorName = (d.seniorName as string) ?? "your loved one";
  const priceId    = resolveClientPriceId();
  await mergeOnboardingData(phone, { selectedPlan: "CareConnex", selectedPlanPriceId: priceId });
  const priceLabel = await describeClientPrice(priceId);

  const msg = await generateCaraMessage({
    audience: "family",
    context:
      `Cara just showed a family real local caregivers for ${seniorName}. Now state the price in one warm, simple ` +
      `message: CareConnex is ${priceLabel || "a simple monthly membership"}, and for that Cara coordinates ` +
      `everything for ${seniorName} — scheduling, weekly summaries, and keeping the whole family in the loop. ` +
      `2-3 sentences, no bullet lists, no pressure. End by asking if they'd like you to set them up (they can reply YES, or ask about options).`,
    fallback:
      `CareConnex is ${priceLabel || "one simple monthly membership"} — I coordinate everything for ${seniorName}: ` +
      `scheduling, weekly summaries, and keeping your whole family in the loop. Want me to set you up? (reply YES)`,
    emotionalDirective: (session as any)._emotionalDirective,
    maxTokens: 130,
  });
  await sendMessage(chatId, msg);
}

async function handleClientPlanReply(
  phone: string,
  chatId: string,
  text:   string,
  session: AgentSession
): Promise<void> {
  // Mid-flow question (e.g. "is it monthly?") — answer, then re-offer.
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "Want me to set you up? Reply YES and I'll get you verified and your matches connected.");
    return;
  }

  const intent = await parseWithClaude(
    '"yes", "ok", "sure", "1", "sounds good", "let\'s do it", "sign me up" → confirm. ' +
    '"what are my options", "other plans", "cheaper", "more expensive", "upgrade", "tiers", "premium", "basic" → options. ' +
    'Anything unclear → unclear. Reply with exactly one word: confirm, options, or unclear.',
    text
  );

  if (intent === "options") {
    await sendMessage(chatId,
      "Right now everyone starts on the same simple membership — it covers me coordinating care, weekly summaries, " +
      "and family updates. Once you're set up, I can add things like 24/7 urgent response or a dedicated coordinator " +
      "if you ever want them. Want me to set you up? (reply YES)"
    );
    return;
  }
  if (intent !== "confirm") {
    await sendMessage(chatId, "Just reply YES when you're ready and I'll get you connected with caregivers — happy to answer anything first.");
    return;
  }

  // Confirmed → ensure a price is stored, then send the identity link.
  const d = session.onboardingData ?? {};
  let priceId = (d.selectedPlanPriceId as string) ?? "";
  if (!priceId) {
    priceId = resolveClientPriceId();
    await mergeOnboardingData(phone, { selectedPlan: "CareConnex", selectedPlanPriceId: priceId });
  }

  await signalThinking(chatId, session.service);
  let identityUrl: string;
  try {
    identityUrl = await createClientIdentitySession(phone);
  } catch (err) {
    console.error("createClientIdentitySession error — falling back to payment:", err);
    await updateSession(phone, { onboardingStep: "client_send_payment" });
    await handleClientSendPayment(phone, chatId, session);
    return;
  }
  await sendMessage(chatId,
    "Perfect. Quick 30-second identity check first — it's how I keep every family on the platform real and safe:"
  );
  await sendMessage(chatId, { parts: [{ type: "link", value: identityUrl }] });
  await updateSession(phone, { onboardingStep: "client_awaiting_identity" });
}

async function handleClientSendPayment(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const d    = session.onboardingData ?? {};

  const caraPhone = encodeURIComponent(process.env.LINQ_PHONE_NUMBER ?? "");
  const priceId   = ((d.selectedPlanPriceId as string) || resolveClientPriceId()).trim();
  let checkoutUrl = `${APP_URL}/payment/success?source=cara&caraPhone=${caraPhone}`;
  await signalThinking(chatId, session.service);
  try {
    // Real recurring membership — mode "subscription" actually starts billing.
    // (Falls back to setup/card-on-file only if no price is configured, so the
    // flow never hard-fails — but with STRIPE_MEMBERSHIP_PRICE_ID set this bills.)
    const stripeSession = priceId
      ? await getStripe().checkout.sessions.create({
          mode:                 "subscription",
          payment_method_types: ["card"],
          line_items:           [{ price: priceId, quantity: 1 }],
          success_url:          `${APP_URL}/payment/success?source=cara&caraPhone=${caraPhone}`,
          cancel_url:           `${APP_URL}/start`,
          metadata:             { phone, task: "client_payment_setup" },
          subscription_data:    { metadata: { phone } },
        })
      : await getStripe().checkout.sessions.create({
          mode:                 "setup",
          payment_method_types: ["card"],
          success_url:          `${APP_URL}/payment/success?source=cara&caraPhone=${caraPhone}`,
          cancel_url:           `${APP_URL}/start`,
          metadata:             { phone, task: "client_payment_setup" },
        });
    checkoutUrl = stripeSession.url ?? checkoutUrl;
  } catch (err) {
    console.error("handleClientSendPayment stripe error:", err);
  }

  await updateSession(phone, { onboardingStep: "client_awaiting_payment" });
  const msg7 = await generateCaraMessage({
    audience: "family",
    context: `Cara has collected everything needed to start finding caregivers for ${d.seniorName ?? "a loved one"}. Let the family know warmly, then tell them the last step is to start their membership so Cara can begin coordinating care, and that it takes about 30 seconds.`,
    fallback: `Perfect — I have everything I need to start finding caregivers for ${d.seniorName ?? "your loved one"}.\n\nLast step: start your membership so I can begin coordinating care.\nTakes about 30 seconds:`,
    maxTokens: 100,
  });
  await sendMessage(chatId, msg7);
  await sendMessage(chatId, { parts: [{ type: "link", value: checkoutUrl }] });
  await sendMessage(chatId, "I'll start searching while you set that up.");
}

// ── CAREGIVER FLOW ────────────────────────────────────────────────────────────

async function handleCaregiverAskName(phone: string, chatId: string, text: string, session?: AgentSession, service?: string): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session ?? ({ onboardingData: {} } as AgentSession));
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "What's your name?");
    return;
  }
  const name = await parseWithClaude(
    "Extract the full name from this message. Reply with just the name, nothing else.",
    text
  );
  if (name === "__parse_error__" || !name) {
    await sendMessage(chatId, "I didn't catch your name — could you share it?");
    return;
  }
  await mergeOnboardingData(phone, { name });
  await updateSession(phone, { onboardingStep: "caregiver_ask_location" });
  const msg9 = await generateCaraMessage({
    audience: "caregiver",
    context: `Cara just learned the caregiver's name is ${name}. Greet them by name and ask what city and zip code they work in.`,
    fallback: `Hi ${name} — what city and zip code do you work in?`,
    maxTokens: 80,
  });
  await sendMessage(chatId, locationPrompt(msg9, service));
}

/**
 * Live local-demand snapshot for a caregiver's city. Returns the count of open
 * jobs and up to 3 formatted lines (care type · rate). Used both at the location
 * step (early "this is legit" proof) and re-cited at the membership ask so the
 * value is fresh and concrete at the moment we ask for payment. Never fabricates
 * — an empty result means there genuinely are no open jobs in that city.
 */
async function getLocalJobTeaser(city: string): Promise<{ count: number; lines: string }> {
  if (!city) return { count: 0, lines: "" };
  try {
    const openSnap = await db.collection("job_posts").where("status", "==", "open").limit(50).get();
    const cityLower = city.toLowerCase();
    const localJobs = openSnap.docs.filter((doc) => {
      const c = doc.data().location?.city;
      return c && String(c).toLowerCase() === cityLower;
    }).slice(0, 3);

    const lines = localJobs.map((doc, i) => {
      const j = doc.data();
      const needs = (j.careTypes ?? []).join(", ") || "general care";
      const rate  = j.hourlyRate ? ` · $${j.hourlyRate}/hr` : "";
      return `${i + 1}. ${needs}${rate}`;
    }).join("\n");

    return { count: localJobs.length, lines };
  } catch (err) {
    console.error("[getLocalJobTeaser] failed:", err);
    return { count: 0, lines: "" };
  }
}

async function handleCaregiverAskLocation(phone: string, chatId: string, text: string, session: AgentSession, opts: OnboardingStepOptions = {}): Promise<void> {
  const { service, inboundLocation } = opts;
  let city = "", zipCode = "";
  let coords: { lat: number; lng: number } | undefined;

  if (inboundLocation) {
    // One-tap location pin: reverse-geocode to backfill city/zip (keeps the
    // city-keyed local-job teaser working) and keep raw coords for matching.
    const rev = await reverseGeocode(inboundLocation.lat, inboundLocation.lng);
    city = rev?.city ?? ""; zipCode = rev?.zipCode ?? "";
    coords = { lat: inboundLocation.lat, lng: inboundLocation.lng };
  } else {
    if (await isQuestionOrOther(text)) {
      const answer = await answerQuestionMidFlow(text, session);
      await sendMessage(chatId, answer);
      await sendMessage(chatId, locationPrompt("What city and zip code do you work in?", service));
      return;
    }
    const raw = await parseWithClaude(
      'Extract city and zipCode from this message. Reply in JSON: {"city":"...","zipCode":"..."}',
      text
    );
    try { const p = JSON.parse(raw); city = p.city ?? ""; zipCode = p.zipCode ?? ""; } catch { /* keep defaults */ }
  }

  await mergeOnboardingData(phone, { city, zipCode, ...(coords ? { lat: coords.lat, lng: coords.lng } : {}) });

  // Value hook (founder direction): the moment a caregiver shares their location,
  // show REAL local demand so the platform proves it's legit before we ask for
  // anything. Honest empty state when nothing is open yet — no fabricated jobs.
  if (city) {
    const { count, lines } = await getLocalJobTeaser(city);
    if (count > 0) {
      await sendMessage(chatId,
        `Good news — there ${count === 1 ? "is" : "are"} ${count} open care ` +
        `${count === 1 ? "job" : "jobs"} near ${city} right now:\n\n${lines}\n\n` +
        `Finish your quick profile and you'll be able to apply.`
      );
    } else {
      await sendMessage(chatId,
        `I don't have open jobs in ${city} this minute — new ones post daily and I'll text you ` +
        `the moment one matches your skills. Let's finish your profile so you're ready to apply.`
      );
    }
  }

  await updateSession(phone, { onboardingStep: "caregiver_ask_story" });
  const d = session.onboardingData ?? {};
  const msgStoryIntro = await generateCaraMessage({
    audience: "caregiver",
    context: `Cara is onboarding caregiver ${d.name ?? ""}. They just shared their city and zip code. Instead of asking separate checkbox questions, invite them to tell their caregiving story in their own words — how long they've been doing it, the kinds of clients and conditions they've cared for, any certifications, and what they're good at. Keep it warm and encouraging.`,
    fallback: `Great, ${d.name ?? ""}! Tell me a bit about your caregiving experience in your own words — how long you've been doing it, the kinds of clients you've worked with, any certifications, and what you're best at.`,
    maxTokens: 100,
  });
  await sendMessage(chatId,
    `${msgStoryIntro}\n\nFor example: "I've cared for seniors for about 6 years, mostly dementia clients. I'm a CNA and CPR-certified and I'm great with mobility assistance."`
  );
}

/**
 * Story-based caregiver onboarding (idea #5). Instead of separate checkbox-style
 * questions for experience, certifications, and specialties, the caregiver tells
 * their story once and a single multi-field extraction pulls out everything we'd
 * otherwise ask for across several steps. Mirrors the client flow's
 * `absorbClientFields` technique.
 *
 * After extracting, we store the fields and auto-advance past any of the
 * downstream experience/specialties steps the story already satisfied — landing
 * on the first still-unfilled step (or the profile step if the story covered
 * everything). Conservative: a missing field is left empty and its step still
 * gets asked rather than fabricated.
 */
async function handleCaregiverAskStory(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  // 1. Mid-flow question guard — answer, then re-ask the story prompt; never store.
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId,
      "Tell me a bit about your caregiving experience in your own words — how long you've been doing it, " +
      "the kinds of clients you've worked with, any certifications, and what you're best at."
    );
    return;
  }

  // 2. One multi-field extraction from the narrative. Conservative: omit anything
  //    not clearly stated so we never invent a certification or a year count.
  const raw = await parseWithClaude(
    "A caregiver just described their caregiving experience in one free-form message. " +
      "Extract structured fields from their story. Reply with raw JSON only, no markdown. " +
      "Schema: " +
      `{"yearsExperience":number,` +
      `"specialties":["short care specialty like 'dementia' or 'mobility assistance'"],` +
      `"certifications":["certification name like 'CNA' or 'CPR'"],` +
      `"skills":["short skill phrase"]}. ` +
      "Only include a field if it is clearly stated. Use 0 for yearsExperience if no duration is mentioned, " +
      "and empty arrays for anything not mentioned. Do NOT guess or fabricate.",
    text,
  );

  // 3. Validate / default — malformed output yields safe empties, never a crash.
  let yearsExperience = 0;
  let specialties: string[] = [];
  let certifications: string[] = [];
  let skills: string[] = [];
  try {
    const p = JSON.parse(raw);
    yearsExperience = typeof p.yearsExperience === "number" && p.yearsExperience > 0 ? p.yearsExperience : 0;
    specialties     = Array.isArray(p.specialties) ? p.specialties.filter((s: unknown) => typeof s === "string" && s.trim()) : [];
    certifications  = Array.isArray(p.certifications) ? p.certifications.filter((s: unknown) => typeof s === "string" && s.trim()) : [];
    skills          = Array.isArray(p.skills) ? p.skills.filter((s: unknown) => typeof s === "string" && s.trim()) : [];
  } catch { /* keep safe defaults; downstream steps will ask explicitly */ }

  // Persist whatever we confidently extracted.
  const extracted: Record<string, unknown> = {};
  if (yearsExperience > 0)        extracted.yearsExperience = yearsExperience;
  if (specialties.length)         extracted.specialties = specialties;
  if (certifications.length)      extracted.certifications = certifications;
  if (skills.length)              extracted.skills = skills;
  if (Object.keys(extracted).length > 0) {
    await mergeOnboardingData(phone, extracted);
  }
  // Keep the in-memory session in sync so the auto-advance below sees the writes.
  const merged = { ...(session.onboardingData ?? {}), ...extracted } as Record<string, unknown>;
  session.onboardingData = merged;

  // 4. Conversational acknowledgment of what they shared.
  const ackBits: string[] = [];
  if (yearsExperience > 0)   ackBits.push(`${yearsExperience} year${yearsExperience === 1 ? "" : "s"} of experience`);
  if (specialties.length)    ackBits.push(`specializing in ${specialties.join(", ")}`);
  if (certifications.length) ackBits.push(`certified in ${certifications.join(", ")}`);
  const ack = await generateCaraMessage({
    audience: "caregiver",
    context:
      `Cara is onboarding a caregiver who just told her their caregiving story` +
      `${ackBits.length ? ` (${ackBits.join("; ")})` : ""}. ` +
      `Acknowledge what they shared warmly in one short, genuine line (not flattery clichés).`,
    fallback: "Thank you for sharing that — it really helps me match you well.",
    maxTokens: 80,
  });

  // 5. Auto-advance past any experience/specialties step the story already
  //    satisfied. CAREGIVER_STORY_STEP_FIELD maps each absorbable step to the
  //    field it would otherwise collect; we stop on the first unfilled one and
  //    ask only that. If the story covered both, we land on the profile step.
  let nextStep = "caregiver_ask_experience";
  while (CAREGIVER_STORY_STEP_FIELD[nextStep]) {
    const field = CAREGIVER_STORY_STEP_FIELD[nextStep];
    if (!isFieldFilled(merged[field])) break;
    const idx = CAREGIVER_STORY_STEP_ORDER.indexOf(nextStep);
    const after = idx >= 0 && idx < CAREGIVER_STORY_STEP_ORDER.length - 1
      ? CAREGIVER_STORY_STEP_ORDER[idx + 1]
      : null;
    if (!after) break;
    nextStep = after;
  }

  await updateSession(phone, { onboardingStep: nextStep });
  session.onboardingStep = nextStep;

  // Ask the landed step's question (mirrors each step's own outbound prompt),
  // prefixed with the acknowledgment so the caregiver always gets a warm reply.
  if (nextStep === "caregiver_ask_experience") {
    await sendMessage(chatId,
      `${ack}\n\nHow many years of caregiving experience do you have, and do you hold any certifications?\n\n` +
      `For example: "5 years, CNA and CPR" or "2 years, no certifications".`
    );
  } else if (nextStep === "caregiver_ask_specialties") {
    await sendMessage(chatId,
      `${ack}\n\nWhat types of care do you specialize in?\n\n` +
      `For example: dementia, Alzheimer's, mobility assistance, post-surgery, companionship, medication management...`
    );
  } else {
    // Both experience and specialties satisfied — go straight to the profile step.
    const msgProfile = await generateCaraMessage({
      audience: "caregiver",
      context:
        `Cara just heard a caregiver's full story and has their experience and specialties. ` +
        `In one short line, ask three quick profile details families use when matching: ` +
        `whether they're male or female (some families have a preference), what languages they speak, and whether they can ` +
        `drive clients to appointments. Keep it light and quick.`,
      fallback: "A few quick details families use to match — are you male or female, what languages do you speak, and can you drive clients to appointments?",
      maxTokens: 100,
    });
    await sendMessage(chatId, `${ack}\n\n${msgProfile}`);
  }
}

async function handleCaregiverAskExperience(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "How many years of caregiving experience do you have, and do you hold any certifications?");
    return;
  }
  const raw = await parseWithClaude(
    'Extract yearsExperience (number) and certifications (array of strings) from this message. Reply in JSON: {"yearsExperience":0,"certifications":[]}',
    text
  );
  let yearsExperience = 0, certifications: string[] = [];
  try { const p = JSON.parse(raw); yearsExperience = p.yearsExperience ?? 0; certifications = p.certifications ?? []; } catch { /* keep defaults */ }

  await mergeOnboardingData(phone, { yearsExperience, certifications });
  await updateSession(phone, { onboardingStep: "caregiver_ask_specialties" });
  const msg11intro = await generateCaraMessage({
    audience: "caregiver",
    context:
      `Cara is onboarding a caregiver who just told her they have ${yearsExperience || "some"} years of experience` +
      `${certifications.length ? ` and these certifications: ${certifications.join(", ")}` : ""}. ` +
      `Acknowledge that warmly in one short line (genuine, not flattery clichés), then ask what types of care they specialize in.`,
    fallback: "What types of care do you specialize in?",
    maxTokens: 80,
  });
  await sendMessage(chatId,
    `${msg11intro}\n\nFor example: dementia, Alzheimer's, mobility assistance, post-surgery, companionship, medication management...`
  );
}

async function handleCaregiverAskSpecialties(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "What types of care do you specialize in? (e.g. dementia, mobility, post-surgery, companionship)");
    return;
  }
  const raw = await parseWithClaude(
    "Extract a list of care specialties from this message. Reply in JSON: {\"specialties\":[\"...\",\"...\"]}",
    text
  );
  let specialties: string[] = [];
  try { const p = JSON.parse(raw); specialties = p.specialties ?? []; } catch { /* keep defaults */ }

  await mergeOnboardingData(phone, { specialties });
  await updateSession(phone, { onboardingStep: "caregiver_ask_profile" });
  const msgProfile = await generateCaraMessage({
    audience: "caregiver",
    context:
      `Cara is onboarding a caregiver who just shared their specialties${specialties.length ? `: ${specialties.join(", ")}` : ""}. ` +
      `Acknowledge it warmly in one short line, then ask three quick profile details families use when matching: ` +
      `whether they're male or female (some families have a preference), what languages they speak, and whether they can ` +
      `drive clients to appointments. Keep it light and quick.`,
    fallback: "A few quick details families use to match — are you male or female, what languages do you speak, and can you drive clients to appointments?",
    maxTokens: 100,
  });
  await sendMessage(chatId, msgProfile);
}

async function handleCaregiverAskProfile(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "Are you male or female, what languages do you speak, and can you drive clients to appointments?");
    return;
  }
  const raw = await parseWithClaude(
    "Extract the caregiver's gender, the languages they speak, and whether they can drive clients. " +
    "Reply in JSON: {\"gender\":\"\",\"languages\":[],\"canDrive\":false}. " +
    "gender: \"female\"/\"male\"/\"other\" or \"\" if not stated. languages: array of language names; if they're writing " +
    "in English and didn't specify, include \"English\". canDrive: true if they say they can drive / have a car or " +
    "license, false otherwise.",
    text
  );
  let gender = "";
  let languages: string[] = [];
  let canDrive = false;
  try {
    const p = JSON.parse(raw);
    gender    = p.gender ?? "";
    languages = Array.isArray(p.languages) ? p.languages : [];
    canDrive  = p.canDrive === true;
  } catch { /* none */ }
  await mergeOnboardingData(phone, { gender, languages, canDrive });
  await updateSession(phone, { onboardingStep: "caregiver_ask_availability" });
  const msg12 = await generateCaraMessage({
    audience: "caregiver",
    context: "Cara is onboarding a caregiver who just shared a couple profile details. Acknowledge briefly, then ask what days and hours they're generally available to work.",
    fallback: "What days and hours are you generally available to work?",
    maxTokens: 80,
  });
  await sendMessage(chatId, msg12);
}

async function handleCaregiverAskAvailability(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "What days and hours are you generally available to work?");
    return;
  }
  const raw = await parseWithClaude(
    "Extract availability days (array of strings) and hours (string) from this message. Reply in JSON: {\"days\":[\"Monday\",\"Tuesday\"],\"hours\":\"9am-5pm\"}",
    text
  );
  let days: string[] = [], hours = "";
  try { const p = JSON.parse(raw); days = p.days ?? []; hours = p.hours ?? ""; } catch { /* keep defaults */ }

  await mergeOnboardingData(phone, { availability: { days, hours } });
  await updateSession(phone, { onboardingStep: "caregiver_ask_job_type" });
  const availIntro = await generateCaraMessage({
    audience: "caregiver",
    context:
      `Cara is onboarding a caregiver who just shared their availability${hours ? ` (${hours})` : ""}. ` +
      `Acknowledge it warmly in one short line, then lead into asking whether they want occasional, part-time, or ` +
      `full-time work. Do NOT list the numbered options yourself — Cara appends those on the next line.`,
    fallback: "Got it, thanks!",
    maxTokens: 60,
  });
  await sendMessage(chatId,
    `${availIntro}\n\nAre you looking for occasional fill-in shifts, part-time (less than 25 hrs/week), or full-time work?\n\n` +
    "Reply 1 for Occasional, 2 for Part-time, or 3 for Full-time."
  );
}

async function handleCaregiverAskRate(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "What's your hourly rate? Just a number works (e.g. \"22\").");
    return;
  }
  const raw = await parseWithClaude(
    "Extract the hourly rate as a number from this message. Reply with just the number (e.g. 22). No dollar sign.",
    text
  );
  if (raw === "__parse_error__") {
    await sendMessage(chatId, "Hmm, I didn't catch that. What's your hourly rate? Just a number works (e.g. \"22\")");
    return;
  }
  const hourlyRate = parseFloat(raw);
  if (isNaN(hourlyRate) || hourlyRate < 5 || hourlyRate > 200) {
    await sendMessage(chatId, "Could you share your hourly rate as a number between $5 and $200? (e.g. \"22\")");
    return;
  }

  await mergeOnboardingData(phone, { hourlyRate });
  await updateSession(phone, { onboardingStep: "caregiver_ask_email" });
  const rateIntro = await generateCaraMessage({
    audience: "caregiver",
    context:
      `Cara is onboarding a caregiver who just set their rate at $${hourlyRate}/hr. Acknowledge it in one short, ` +
      `genuine line (no flattery clichés), then ask for their email address, mentioning it's used to set up their payout account.`,
    fallback: `$${hourlyRate}/hr works. What's your email address? I'll use it to set up your payout account.`,
    maxTokens: 70,
  });
  await sendMessage(chatId, rateIntro);
}

async function handleCaregiverAskJobType(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "Are you looking for occasional, part-time, or full-time work? Reply 1, 2, or 3.");
    return;
  }
  const raw = await parseWithClaude(
    '"1", occasional, fill-in, as-needed, flexible, sometimes → occasional. ' +
    '"2", part-time, part time, a few days, some days → part_time. ' +
    '"3", full-time, full time, every day, all week → full_time. ' +
    'Reply with exactly one of: occasional, part_time, full_time',
    text
  );
  const jobType = ["occasional", "part_time", "full_time"].includes(raw) ? raw : "part_time";
  const jobTypeLabel: Record<string, string> = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
  await mergeOnboardingData(phone, { jobType });
  await updateSession(phone, { onboardingStep: "caregiver_ask_rate" });
  const d = session.onboardingData ?? {};
  const city = (d.city as string) ?? "";
  await sendMessage(chatId,
    `${jobTypeLabel[jobType] ?? "Got it"}! What's your hourly rate?\n\n` +
    (city ? `(Most caregivers in ${city} charge $18–28/hr)` : "(Most caregivers charge $18–28/hr)")
  );
}

async function handleCaregiverAskEmail(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  // For email, only treat as question if it doesn't even look like an email attempt —
  // skip the isQuestionOrOther LLM hop when there's a "@" in the trimmed text.
  const email = text.trim().toLowerCase();
  if (!email.includes("@") && await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "What's your email address?");
    return;
  }
  if (!/\S+@\S+\.\S+/.test(email)) {
    await sendMessage(chatId, "That doesn't look like a valid email. Could you double-check? (e.g. name@example.com)");
    return;
  }
  await mergeOnboardingData(phone, { email });
  await updateSession(phone, { onboardingStep: "caregiver_ask_bio" });
  await sendMessage(chatId,
    "Got it, thank you. Last question before your photo — tell me about your approach to care in a sentence or two. Families will see this on your profile."
  );
}

async function handleCaregiverAskBio(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  // Only treat as question if the message is short (< 60 chars) — a bio that's
  // also a question is unlikely at this stage.
  if (text.trim().length < 60 && text.trim().toLowerCase() !== "skip" && await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "Tell me about your approach to care in a sentence or two — or reply SKIP.");
    return;
  }
  const bio = text.trim().toLowerCase() === "skip" || text.trim().length < 10 ? "" : text.trim();
  await mergeOnboardingData(phone, { bio });
  await updateSession(phone, { onboardingStep: "caregiver_send_photo" });
  await handleCaregiverSendPhoto(phone, chatId, session);
}

// Called immediately after doc upload — ask before building the checkout so MVR can be bundled
async function handleCaregiverAskMvr(phone: string, chatId: string, textOrSession: string | AgentSession, session?: AgentSession): Promise<void> {
  // When called as a switch case, textOrSession is the user's reply text
  // When called programmatically (no reply yet), textOrSession is the session object
  if (typeof textOrSession !== "string") {
    // First visit — ask the question
    await updateSession(phone, { onboardingStep: "caregiver_ask_mvr" });
    await sendMessage(chatId,
      "Do you transport clients to appointments or errands?\n\n" +
      "Adding a Motor Vehicle Record check to your profile shows families you're a verified driver. " +
      "It's an optional add-on you can include with your membership.\n\n" +
      "Reply YES to add it, or NO to skip."
    );
    return;
  }

  // User has replied — process their answer
  const norm = (textOrSession as string).trim().toUpperCase();
  const wantsMvr = norm === "YES" || norm === "Y";
  await mergeOnboardingData(phone, { wantsMvr });
  await updateSession(phone, { onboardingStep: "caregiver_send_membership" });
  await handleCaregiverSendMembership(phone, chatId, session!);
}

async function handleCaregiverSendMembership(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const d       = session.onboardingData ?? {};
  const wantsMvr = (d.wantsMvr as boolean | undefined) ?? false;
  const token   = generateToken({ phone, task: "caregiver_membership" });
  let checkoutUrl = `${APP_URL}/done?task=caregiver_membership&t=${token}`;

  await signalThinking(chatId, session.service);
  try {
    const membershipPriceId = process.env.STRIPE_CAREGIVER_ANNUAL_PRICE_ID ?? process.env.STRIPE_CAREGIVER_ANNUAL ?? process.env.VITE_STRIPE_CAREGIVER_ANNUAL ?? "";
    const mvrPriceId        = (process.env.STRIPE_MVR_PRICE_ID ?? "").trim();

    if (membershipPriceId) {
      const lineItems: { price: string; quantity: number }[] = [
        { price: membershipPriceId, quantity: 1 },
      ];
      if (wantsMvr && mvrPriceId && !mvrPriceId.startsWith("FILL_IN")) {
        lineItems.push({ price: mvrPriceId, quantity: 1 });
      }

      // Recurring annual membership (mode "subscription" → renews yearly).
      // NOTE: STRIPE_CAREGIVER_ANNUAL must be a *recurring* annual price in Stripe.
      // The optional MVR add-on is a one-time price, added to the first invoice.
      // We intentionally omit payment_method_types so Checkout uses the account's
      // automatic payment methods — this surfaces Apple Pay / Google Pay / Link
      // (caregivers are mobile-first over SMS), which an explicit ["card"] list suppresses.
      const stripeSession = await getStripe().checkout.sessions.create({
        mode:                 "subscription",
        line_items:           lineItems,
        success_url:          `${APP_URL}/done?task=caregiver_membership&t=${token}`,
        cancel_url:           `${APP_URL}/start`,
        metadata:             { phone, task: "caregiver_membership", includeMVR: wantsMvr ? "true" : "false" },
        subscription_data:    { metadata: { phone, kind: "caregiver_membership" } },
      });
      checkoutUrl = stripeSession.url ?? checkoutUrl;
    }
  } catch (err) {
    console.error("handleCaregiverSendMembership stripe error:", err);
  }

  const mvrLine = wantsMvr
    ? "\n\nYour order includes the $24.95/yr membership + MVR driver check."
    : "";

  // Re-cite the live local demand the caregiver saw at the location step — fresh
  // at the moment of payment — so the ask is anchored to concrete, current jobs
  // rather than a generic "jobs near you". Honest if supply has since dried up.
  const city = (d.city as string | undefined) ?? "";
  const { count: openJobCount } = await getLocalJobTeaser(city);
  const demandLine = openJobCount > 0
    ? `The ${openJobCount} open care ${openJobCount === 1 ? "job" : "jobs"} near ${city} ${openJobCount === 1 ? "is" : "are"} still waiting — `
    : "";

  // Store URL on session so we can resend it
  await updateSession(phone, {
    onboardingStep:        "caregiver_awaiting_membership",
    membershipCheckoutUrl: checkoutUrl,
  });
  await sendMessage(chatId,
    `${demandLine}You're almost ready to apply! Activate your membership ($24.95/year) to unlock applying to the ` +
    `jobs near you, getting booked, and Cara's scheduling + payout tools.${mvrLine}\n\nTap to activate:`
  );
  await sendMessage(chatId, { parts: [{ type: "link", value: checkoutUrl }] });
}

async function handleCaregiverResendMembership(phone: string, chatId: string, session: AgentSession, text?: string): Promise<void> {
  // If the caregiver replied with a question while waiting on Stripe, answer it
  // before resending the link.
  if (text && await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
  }
  const url = (session as any).membershipCheckoutUrl as string | undefined;
  if (url) {
    await sendMessage(chatId, "Tap the link below to complete your membership payment:");
    await sendMessage(chatId, { parts: [{ type: "link", value: url }] });
  } else {
    // Re-generate if URL was lost
    await handleCaregiverSendMembership(phone, chatId, session);
  }
}

async function handleCaregiverSendPhoto(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const token   = generateToken({ phone, task: "photo_upload" });
  const photoUrl = `${APP_URL}/upload/photo?t=${token}`;

  await updateSession(phone, { onboardingStep: "caregiver_awaiting_photo" });
  const d = session.onboardingData ?? {};
  await sendMessage(chatId,
    `Almost there${d.name ? `, ${d.name}` : ""}. One more thing — families want to see who they're trusting.\n\n` +
    `Tap to add your profile photo:`
  );
  await sendMessage(chatId, { parts: [{ type: "link", value: photoUrl }] });
}

async function handleCaregiverSendDocuments(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const token  = generateToken({ phone, task: "doc_upload" });
  const docUrl = `${APP_URL}/upload/document?t=${token}`;

  await updateSession(phone, { onboardingStep: "caregiver_awaiting_documents" });
  await sendMessage(chatId, "Do you have certifications to upload? (CNA license, CPR card, etc.)\n\nTap to upload, or reply SKIP:");
  await sendMessage(chatId, { parts: [{ type: "link", value: docUrl }] });
}

// ── Inbound media during onboarding (texted photo / document) ─────────────────
// A caregiver snaps a headshot or a CNA/CPR card and texts it instead of using
// the web upload link. Route by the current step; gate with gpt-4o vision and
// warmly re-ask on a bad shot rather than advancing. Anything sent at a step
// that isn't expecting a file gets a gentle nudge back on track.
async function handleInboundMedia(
  phone:   string,
  chatId:  string,
  session: AgentSession,
  media:   InboundMediaPart,
  step:    string
): Promise<void> {
  if (step === "caregiver_send_photo" || step === "caregiver_awaiting_photo") {
    return handleInboundProfilePhoto(phone, chatId, media);
  }
  if (step === "caregiver_send_documents" || step === "caregiver_awaiting_documents") {
    return handleInboundDocument(phone, chatId, media);
  }
  // Not a file-collecting step. Acknowledge warmly and steer back to the task.
  if (step === "client_awaiting_identity") {
    await sendMessage(chatId,
      "Thanks for sending that! For your security, identity verification has to go " +
      "through the secure link I sent — a texted photo can't complete it. Tap that " +
      "link when you're ready and I'll take it from there."
    );
    return;
  }
  await sendMessage(chatId,
    "Got your file, thank you! I'm not at that step just yet — let's finish what we " +
    "were on and I'll ask for anything I need. What were you going to say?"
  );
}

async function handleInboundProfilePhoto(
  phone:  string,
  chatId: string,
  media:  InboundMediaPart
): Promise<void> {
  try {
    const dl = await downloadMedia(media);
    const verdict = await verifyProfilePhoto(dl.buffer, dl.content_type);
    if (!verdict.ok) {
      // Keep them at the photo step and warmly ask for a better shot.
      const why = verdict.reason ? ` (${verdict.reason})` : "";
      await sendMessage(chatId,
        `Thanks${why ? "" : "!"} That photo didn't quite work for your profile${why}. ` +
        `Could you send one clear, well-lit photo of your face? You can also tap the upload link I sent.`
      );
      return;
    }
    const url = await storeInboundMedia({
      phone, kind: "image", buffer: dl.buffer,
      content_type: dl.content_type, ext: dl.ext,
    });
    await sendMessage(chatId, "Perfect — got your photo! 📸");
    // Reuse the canonical upload-complete path so downstream behavior (advance to
    // documents) is identical to the web upload flow.
    await advanceOnboardingStep(phone, "photo_upload", url);
  } catch (err) {
    console.error("handleInboundProfilePhoto failed", { phone, err: (err as Error)?.message });
    await sendMessage(chatId,
      "I had trouble opening that photo — could you try sending it again, or tap the upload link I sent?"
    );
  }
}

async function handleInboundDocument(
  phone:  string,
  chatId: string,
  media:  InboundMediaPart
): Promise<void> {
  try {
    const dl = await downloadMedia(media);
    const verdict = await verifyDocument(dl.buffer, dl.content_type);
    if (!verdict.ok) {
      const why = verdict.reason ? ` ${verdict.reason}` : "";
      await sendMessage(chatId,
        `Thanks for that!${why} Could you resend a clear photo of your certification ` +
        `(CNA license, CPR card, etc.)? Or reply SKIP to move on — you can always add it later.`
      );
      return;
    }
    const url = await storeInboundMedia({
      phone, kind: "document", buffer: dl.buffer,
      content_type: dl.content_type, ext: dl.ext,
    });
    const label = verdict.docType && verdict.docType !== "document" && verdict.docType !== "unknown"
      ? `your ${verdict.docType}`
      : "your certification";
    await sendMessage(chatId, `Got ${label} — saved. ✅`);
    await advanceOnboardingStep(phone, "doc_upload", url);
  } catch (err) {
    console.error("handleInboundDocument failed", { phone, err: (err as Error)?.message });
    await sendMessage(chatId,
      "I had trouble opening that document — could you try again, or reply SKIP to continue?"
    );
  }
}

async function handleCaregiverSendBgcheck(phone: string, chatId: string, session: AgentSession): Promise<void> {
  let inviteUrl = `${APP_URL}/done?task=background_check`;
  await signalThinking(chatId, session.service);
  try {
    const d = session.onboardingData ?? {};
    const nameParts = ((d.name ?? "") as string).split(" ");

    // Use MVR package if caregiver paid for it; flag is set on session by stripe.ts webhook
    const mvrPaid      = (session as any).mvrPaid === true;
    const checkrPkg    = mvrPaid
      ? (process.env.CHECKR_PACKAGE_MVR ?? "tasker_standard")
      : (process.env.CHECKR_PACKAGE     ?? "tasker_standard");

    const resp = await axios.post(
      "https://api.checkr.com/v1/invitations",
      {
        package:    checkrPkg,
        first_name: nameParts[0] ?? "",
        last_name:  nameParts.slice(1).join(" ") ?? "",
      },
      { auth: { username: process.env.CHECKR_API_KEY ?? "", password: "" } }
    );
    inviteUrl = resp.data?.invitation_url ?? inviteUrl;

    // Pre-create the caregivers doc so the Checkr webhook can find this caregiver
    // by checkrCandidateId when the report comes back. Keyed by the Firebase Auth
    // uid so Cara writes land where the web reads (uid-keyed caregivers/{uid}).
    const candidateId = (resp.data?.candidate_id ?? resp.data?.id) as string | undefined;
    if (candidateId && !session.caregiverId) {
      const docData = {
        phone,
        status:    "pending_review",
        createdAt: new Date().toISOString(),
        backgroundCheckData: {
          checkrCandidateId: candidateId,
          status:            "pending",
          submittedAt:       new Date().toISOString(),
          mvrIncluded:       mvrPaid,
        },
        ...(mvrPaid && { mvrPaid: true }),
      };
      const authUid = await createFirebaseAuthAccount(phone, (d.name ?? "") as string).catch(() => null);
      let caregiverDocId: string;
      if (authUid) {
        await db.collection("caregivers").doc(authUid).set({ ...docData, uid: authUid }, { merge: true });
        caregiverDocId = authUid;
      } else {
        caregiverDocId = (await db.collection("caregivers").add(docData)).id;
      }
      await updateSession(phone, { caregiverId: caregiverDocId });
    }
  } catch (err) {
    console.error("Checkr invitation error:", err);
  }

  await updateSession(phone, { onboardingStep: "caregiver_awaiting_bgcheck" });
  await sendMessage(chatId,
    "Almost done! A background check is required for all caregivers.\n\n" +
    "Tap to get started — usually takes about 5 minutes:"
  );
  await sendMessage(chatId, { parts: [{ type: "link", value: inviteUrl }] });
  await sendMessage(chatId, "I'll text you when results come in (usually 1–3 days).");
}

// Re-issue a Checkr background-check link for an already-onboarded caregiver whose
// check expired / is expiring (they replied "RENEW" to the expiry nudge). Mirrors the
// onboarding invitation logic but updates the EXISTING caregiver doc instead of creating one.
export async function sendBgCheckRenewalLink(phone: string, chatId: string, session: AgentSession): Promise<void> {
  let inviteUrl = `${APP_URL}/done?task=background_check`;
  try {
    // Resolve the caregiver's name: prefer the caregivers doc, fall back to session.
    let firstName = "";
    let lastName  = "";
    const caregiverId = session.caregiverId;
    if (caregiverId) {
      const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
      const parts = ((cgSnap.data()?.name ?? "") as string).split(" ");
      firstName = parts[0] ?? "";
      lastName  = parts.slice(1).join(" ");
    }
    if (!firstName) {
      const parts = (((session.onboardingData ?? {}).name ?? "") as string).split(" ");
      firstName = parts[0] ?? "";
      lastName  = parts.slice(1).join(" ");
    }

    const checkrPkg = process.env.CHECKR_PACKAGE ?? "tasker_standard";
    const resp = await axios.post(
      "https://api.checkr.com/v1/invitations",
      { package: checkrPkg, first_name: firstName, last_name: lastName },
      { auth: { username: process.env.CHECKR_API_KEY ?? "", password: "" } }
    );
    inviteUrl = resp.data?.invitation_url ?? inviteUrl;

    const candidateId = (resp.data?.candidate_id ?? resp.data?.id) as string | undefined;
    if (caregiverId) {
      await db.collection("caregivers").doc(caregiverId).update({
        "backgroundCheckData.checkrCandidateId": candidateId ?? null,
        "backgroundCheckData.status":            "pending",
        "backgroundCheckData.submittedAt":       new Date().toISOString(),
      }).catch(() => {});
    }
  } catch (err) {
    console.error("[sendBgCheckRenewalLink] Checkr invitation error:", err);
  }

  await sendMessage(chatId, "Here's your background check renewal link — usually about 5 minutes:");
  await sendMessage(chatId, { parts: [{ type: "link", value: inviteUrl }] });
  await sendMessage(chatId, "I'll text you the moment results come in (usually 1–3 days). Bookings stay paused until it clears.");
}

async function handleCaregiverSendStripeConnect(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const token = generateToken({ phone, task: "stripe_connect" });
  let connectUrl = `${APP_URL}/done?task=stripe_connect&t=${token}`;

  await signalThinking(chatId, session.service);
  try {
    const d = session.onboardingData ?? {};
    const account = await getStripe().accounts.create({
      type:    "express",
      country: "US",
      email:   (d.email ?? "") as string,
      metadata: { phone, caregiverName: (d.name ?? "") as string },
    });
    const link = await getStripe().accountLinks.create({
      account:     account.id,
      type:        "account_onboarding",
      return_url:  `${APP_URL}/done?task=stripe_connect&t=${token}`,
      refresh_url: `${APP_URL}/done?task=stripe_connect&t=${token}`,
    });
    connectUrl = link.url;
    await mergeOnboardingData(phone, { stripeAccountId: account.id });
  } catch (err) {
    console.error("Stripe Connect error:", err);
  }

  await updateSession(phone, { onboardingStep: "caregiver_awaiting_stripe" });
  await sendMessage(chatId,
    "Last step — set up your payout account so you can get paid after every visit:\n"
  );
  await sendMessage(chatId, { parts: [{ type: "link", value: connectUrl }] });
}

// ── On-demand onboarding link (re)send ────────────────────────────────────────
// Called by the QA agent's `send_onboarding_link` MCP tool so Cara can fulfil
// "send me the subscription/identity/photo/… link" requests directly instead of
// deflecting to a support ticket or promising a link it never sends.
//
// Unlike the onboarding step handlers above, this sends ONLY the tappable link
// part (the agent supplies the surrounding context in its reply) and does NOT
// advance onboarding state. Resource-creating links (membership, background
// check, payouts) reuse a stored URL/account when present so repeat requests
// don't create duplicate Stripe/Checkr resources.

export type OnboardingLinkType =
  | "client_payment"
  | "client_identity"
  | "caregiver_membership"
  | "caregiver_photo"
  | "caregiver_documents"
  | "caregiver_background_check"
  | "caregiver_payouts";

export async function sendOnboardingLink(
  phone: string,
  linkType: OnboardingLinkType
): Promise<{ success: boolean; linkType: OnboardingLinkType }> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  if (!snap.exists) throw new Error(`sendOnboardingLink: no session for ${phone}`);
  const session   = snap.data() as AgentSession & Record<string, unknown>;
  const chatId    = session.chatId;
  if (!chatId) throw new Error(`sendOnboardingLink: no chatId for ${phone}`);
  const d         = (session.onboardingData ?? {}) as Record<string, unknown>;
  const caraPhone = encodeURIComponent(process.env.LINQ_PHONE_NUMBER ?? "");

  let url: string;

  switch (linkType) {
    case "client_identity": {
      url = await createClientIdentitySession(phone);
      break;
    }

    case "client_payment": {
      url = `${APP_URL}/payment/success?source=cara&caraPhone=${caraPhone}`;
      const stripeSession = await getStripe().checkout.sessions.create({
        mode:                 "setup",
        payment_method_types: ["card"],
        success_url:          `${APP_URL}/payment/success?source=cara&caraPhone=${caraPhone}`,
        cancel_url:           `${APP_URL}/start`,
        metadata:             { phone, task: "client_payment_setup" },
      });
      url = stripeSession.url ?? url;
      break;
    }

    case "caregiver_membership": {
      const stored = session.membershipCheckoutUrl as string | undefined;
      if (stored) { url = stored; break; }
      const token = generateToken({ phone, task: "caregiver_membership" });
      url = `${APP_URL}/done?task=caregiver_membership&t=${token}`;
      const membershipPriceId = process.env.STRIPE_CAREGIVER_ANNUAL_PRICE_ID ?? process.env.STRIPE_CAREGIVER_ANNUAL ?? process.env.VITE_STRIPE_CAREGIVER_ANNUAL ?? "";
      if (membershipPriceId) {
        const wantsMvr   = (d.wantsMvr as boolean | undefined) ?? false;
        const mvrPriceId = (process.env.STRIPE_MVR_PRICE_ID ?? "").trim();
        const lineItems: { price: string; quantity: number }[] = [{ price: membershipPriceId, quantity: 1 }];
        if (wantsMvr && mvrPriceId && !mvrPriceId.startsWith("FILL_IN")) lineItems.push({ price: mvrPriceId, quantity: 1 });
        const stripeSession = await getStripe().checkout.sessions.create({
          mode:                 "subscription",
          payment_method_types: ["card"],
          line_items:           lineItems,
          success_url:          `${APP_URL}/done?task=caregiver_membership&t=${token}`,
          cancel_url:           `${APP_URL}/start`,
          metadata:             { phone, task: "caregiver_membership", includeMVR: wantsMvr ? "true" : "false" },
          subscription_data:    { metadata: { phone, kind: "caregiver_membership" } },
        });
        url = stripeSession.url ?? url;
      }
      await updateSession(phone, { membershipCheckoutUrl: url });
      break;
    }

    case "caregiver_photo": {
      url = `${APP_URL}/upload/photo?t=${generateToken({ phone, task: "photo_upload" })}`;
      break;
    }

    case "caregiver_documents": {
      url = `${APP_URL}/upload/document?t=${generateToken({ phone, task: "doc_upload" })}`;
      break;
    }

    case "caregiver_background_check": {
      const stored = session.bgcheckInviteUrl as string | undefined;
      if (stored) { url = stored; break; }
      url = `${APP_URL}/done?task=background_check`;
      const nameParts = ((d.name ?? "") as string).split(" ");
      const mvrPaid   = (session.mvrPaid as boolean | undefined) === true;
      const checkrPkg = mvrPaid
        ? (process.env.CHECKR_PACKAGE_MVR ?? "tasker_standard")
        : (process.env.CHECKR_PACKAGE     ?? "tasker_standard");
      const resp = await axios.post(
        "https://api.checkr.com/v1/invitations",
        { package: checkrPkg, first_name: nameParts[0] ?? "", last_name: nameParts.slice(1).join(" ") ?? "" },
        { auth: { username: process.env.CHECKR_API_KEY ?? "", password: "" } }
      );
      url = resp.data?.invitation_url ?? url;
      await updateSession(phone, { bgcheckInviteUrl: url });
      break;
    }

    case "caregiver_payouts": {
      const token = generateToken({ phone, task: "stripe_connect" });
      let accountId = d.stripeAccountId as string | undefined;
      if (!accountId) {
        const account = await getStripe().accounts.create({
          type:     "express",
          country:  "US",
          email:    (d.email ?? "") as string,
          metadata: { phone, caregiverName: (d.name ?? "") as string },
        });
        accountId = account.id;
        await mergeOnboardingData(phone, { stripeAccountId: accountId });
      }
      const link = await getStripe().accountLinks.create({
        account:     accountId,
        type:        "account_onboarding",
        return_url:  `${APP_URL}/done?task=stripe_connect&t=${token}`,
        refresh_url: `${APP_URL}/done?task=stripe_connect&t=${token}`,
      });
      url = link.url;
      break;
    }

    default:
      throw new Error(`sendOnboardingLink: unknown linkType ${linkType as string}`);
  }

  await sendMessage(chatId, { parts: [{ type: "link", value: url }] });
  return { success: true, linkType };
}

// ── Resend a stuck onboarding link (called by stale-session nudge after 7 days) ─

export async function resendStuckStep(phone: string): Promise<boolean> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  if (!snap.exists) return false;
  const session = snap.data() as AgentSession;
  const chatId  = session.chatId;
  const step    = (session as any).onboardingStep as string | undefined;
  if (!chatId || !step) return false;

  switch (step) {
    case "caregiver_awaiting_bgcheck":
    case "caregiver_send_bgcheck": {
      // Re-send the Checkr invite link
      await updateSession(phone, { onboardingStep: "caregiver_send_bgcheck" });
      await handleCaregiverSendBgcheck(phone, chatId, session);
      return true;
    }
    case "caregiver_awaiting_stripe":
    case "caregiver_send_stripe_connect": {
      // Re-generate Stripe Connect link (creates new account if needed)
      await updateSession(phone, { onboardingStep: "caregiver_send_stripe_connect" });
      await handleCaregiverSendStripeConnect(phone, chatId, session);
      return true;
    }
    case "client_awaiting_payment":
    case "client_send_payment": {
      // Re-generate Stripe Checkout session
      await handleClientSendPayment(phone, chatId, session);
      return true;
    }
    case "client_awaiting_identity": {
      // Re-issue a fresh Stripe Identity link. Mirror handleClientPlanReply's
      // inline send; fall back to payment if Identity can't be created.
      await signalThinking(chatId, session.service);
      let identityUrl: string;
      try {
        identityUrl = await createClientIdentitySession(phone);
      } catch (err) {
        console.error("resendStuckStep(identity) createClientIdentitySession error:", err);
        await updateSession(phone, { onboardingStep: "client_send_payment" });
        await handleClientSendPayment(phone, chatId, session);
        return true;
      }
      await sendMessage(chatId,
        "Picking up where we left off — here's a fresh link for the quick 30-second identity check:"
      );
      await sendMessage(chatId, { parts: [{ type: "link", value: identityUrl }] });
      return true;
    }
    case "caregiver_awaiting_membership":
    case "caregiver_send_membership": {
      // Prefer the stored checkout URL; regenerate if it was lost.
      await handleCaregiverResendMembership(phone, chatId, session);
      return true;
    }
    case "caregiver_awaiting_photo":
    case "caregiver_send_photo": {
      // Re-send a fresh photo-upload link
      await handleCaregiverSendPhoto(phone, chatId, session);
      return true;
    }
    case "caregiver_awaiting_documents":
    case "caregiver_send_documents": {
      // Re-send a fresh document-upload link
      await handleCaregiverSendDocuments(phone, chatId, session);
      return true;
    }
    default:
      return false;
  }
}

// ── Webhook-triggered step advancement ───────────────────────────────────────
// Called from stripe.ts and checkr.ts when webhooks fire

export async function advanceOnboardingStep(phone: string, task: string, taskData: string): Promise<void> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  if (!snap.exists) return;
  const session = snap.data() as AgentSession;
  const chatId  = session.chatId;
  if (!chatId) { console.error(`advanceOnboardingStep: missing chatId for phone=${phone}`); return; }

  // Idempotency: skip if this task was already processed for this session
  const processedTasks: string[] = (session as any).processedWebhookTasks ?? [];
  if (processedTasks.includes(task)) {
    console.info(`advanceOnboardingStep: skipping duplicate webhook task="${task}" for phone=${phone}`);
    return;
  }

  switch (task) {
    case "payment": {
      // Mark task processed before any writes to prevent race on retry
      await db.collection("agent_sessions").doc(phone).update({
        processedWebhookTasks: admin.firestore.FieldValue.arrayUnion(task),
      });

      const d = session.onboardingData ?? {};
      // Raw coords (present only when the family shared a location pin) — unlock
      // true haversine distance in aiMatching instead of city/zip proxy buckets.
      const lat = typeof d.lat === "number" ? d.lat as number : undefined;
      const lng = typeof d.lng === "number" ? d.lng as number : undefined;
      const hasCoords = lat !== undefined && lng !== undefined;

      // Get or create Firebase Auth UID (may already exist from identity step)
      let uid = session.userId as string | undefined;
      if (!uid) {
        try {
          const userRecord = await admin.auth().getUserByPhoneNumber(phone);
          uid = userRecord.uid;
        } catch {
          try {
            const newUser = await admin.auth().createUser({
              phoneNumber: phone,
              displayName: (d.firstName ?? "") as string,
            });
            uid = newUser.uid;
          } catch (err) {
            console.error("advanceOnboardingStep(payment) createUser error:", err);
          }
        }
        if (uid) await updateSession(phone, { userId: uid });
      }

      // Write subscription status to users/{uid} so web app shows membership as active
      if (uid) {
        await db.collection("users").doc(uid).set({
          membershipStatus:   "active",
          subscriptionActive: true,
          ...(taskData ? { stripeSubscriptionId: taskData } : {}),
          phone,
          firstName:          (d.firstName ?? "") as string,
          updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
          onboardingProgress: {
            identityVerified: true,
            membershipActive: true,
          },
        }, { merge: true });

        // Write initial carePlans/{uid} with what we know so far
        const seniorName   = (d.seniorName   ?? "") as string;
        const firstName    = seniorName.split(" ")[0] || seniorName;
        const relationship = (d.relationship ?? "") as string;
        const city         = (d.city         ?? "") as string;
        const zipCode      = (d.zipCode      ?? "") as string;
        const conditions   = (d.conditions   ?? []) as string[];
        const careNeeds    = (d.careNeeds    ?? []) as string[];
        const seniorAge    = d.age as number | undefined;

        const recipientKey = `recipient_${firstName.toLowerCase().replace(/[^a-z0-9]/g, "_") || "primary"}`;
        await db.collection("carePlans").doc(uid).set({
          clientId: uid,
          phone,
          recipientPlans: {
            [recipientKey]: {
              name:        seniorName,
              age:         seniorAge,
              relationship,
              careNeeds,
              conditions,
              updatedAt:   new Date().toISOString(),
            },
          },
          locationPool: [{ city, zipCode, primary: true, ...(hasCoords ? { lat, lng } : {}) }],
          updatedAt: new Date().toISOString(),
        }, { merge: true });

        // senior_profiles/{uid} parity write — CarePlan, matching, and the
        // family dashboard read this doc (web signup creates it; Cara must too).
        await db.collection("senior_profiles").doc(uid).set({
          userId:    uid,
          name:      seniorName,
          ...(seniorAge !== undefined ? { age: seniorAge } : {}),
          needs:     careNeeds,
          diagnoses: conditions,
          zipCode:   zipCode || null,
          updatedAt: new Date().toISOString(),
        }, { merge: true }).catch((err) => console.error("senior_profiles parity write error:", err));
      }

      // Write intake — uid-keyed so the web app (ClientIntakeFlowV2, matching
      // hooks) reads the same doc Cara writes. Random-ID fallback only when no
      // auth uid could be resolved.
      const intakeData = {
        phone,
        userId:      uid ?? null,
        firstName:   d.firstName,
        seniorName:  d.seniorName,
        relationship: d.relationship,
        age:         d.age,
        careNeeds:   d.careNeeds,
        conditions:  d.conditions,
        city:        d.city,
        zipCode:     d.zipCode,
        ...(hasCoords ? { lat, lng, location: { lat, lng } } : {}),
        daysPerWeek: d.daysPerWeek,
        timeOfDay:   d.timeOfDay,
        hoursPerDay: d.hoursPerDay,
        status:      "pending",
        createdAt:   new Date().toISOString(),
      };
      if (uid) {
        await db.collection("clientIntakes").doc(uid).set(intakeData, { merge: true });
      } else {
        await db.collection("clientIntakes").add(intakeData);
      }

      // Notify admin of new client signup
      notifyAdminNewClientSignup({
        clientId:   uid ?? phone,
        firstName:  (d.firstName  ?? "") as string,
        seniorName: (d.seniorName ?? "") as string,
        phone,
        city:       (d.city ?? "") as string,
      }).catch((err) => console.error("notifyAdminNewClientSignup error:", err));

      // Seed the known-names registry with the client + care recipient so the
      // persona-shift detector recognizes both from day one.
      await addKnownNames(phone, [d.firstName as string, d.seniorName as string]);

      // Initialize memory files with onboarding data
      initializeMemoryFiles(uid ?? phone, {
        seniorName:   d.seniorName   as string | undefined,
        seniorAge:    d.age          as string | undefined,
        conditions:   d.conditions   as string | string[] | undefined,
        careNeeds:    d.careNeeds    as string | string[] | undefined,
        city:         d.city         as string | undefined,
        clientName:   d.firstName    as string | undefined,
        relationship: d.relationship as string | undefined,
      }).catch((err) => console.error("initializeMemoryFiles error:", err));

      Promise.all([
        writeMemoryFile(uid ?? phone, "recent_episodes", `# Recent Episodes\n`),
        writeMemoryFile(uid ?? phone, "procedural",      `# Procedural Notes\n`),
      ]).catch((err) => console.error("initializeExtraMemoryFiles error:", err));

      pushOnboardingDataToZep({
        phone,
        firstName:   (d.firstName    ?? "") as string,
        seniorName:  (d.seniorName   ?? "") as string,
        seniorAge:   d.age ? Number(d.age) : undefined,
        conditions:  Array.isArray(d.conditions) ? d.conditions as string[] : undefined,
        careNeeds:   Array.isArray(d.careNeeds)  ? d.careNeeds  as string[] : undefined,
        city:        d.city         as string | undefined,
        relationship: d.relationship as string | undefined,
        daysPerWeek: d.daysPerWeek  ? Number(d.daysPerWeek) : undefined,
        timeOfDay:   d.timeOfDay    as string | undefined,
      }).catch((err) => console.error("pushOnboardingDataToZep error:", err));

      // We already collected schedule, care needs, and budget during intake —
      // don't make them re-answer it all. Pre-fill the job post and ask for a
      // single confirmation (they can still choose to edit, which drops into the
      // full step-by-step flow).
      await presentPrefilledJobPost(phone, chatId, session);
      break;
    }

    case "photo_upload": {
      // Persist the uploaded photo URL so it lands on the caregiver doc at
      // finalization (taskData is the Storage URL — from the web upload page OR
      // a texted headshot). Previously this URL was dropped on the floor.
      if (taskData) await mergeOnboardingData(phone, { profilePhoto: taskData });
      await updateSession(phone, { onboardingStep: "caregiver_send_documents" });
      await handleCaregiverSendDocuments(phone, chatId, session);
      break;
    }

    case "doc_upload": {
      // Append the document URL to onboardingData.documents (web upload OR texted
      // certification) so it carries onto the caregiver doc at finalization.
      if (taskData) {
        const existingDocs = Array.isArray((session.onboardingData ?? {}).documents)
          ? ((session.onboardingData ?? {}).documents as string[])
          : [];
        await mergeOnboardingData(phone, { documents: [...existingDocs, taskData] });
      }
      await updateSession(phone, { onboardingStep: "caregiver_ask_mvr" });
      await handleCaregiverAskMvr(phone, chatId, session);
      break;
    }

    case "membership": {
      await db.collection("agent_sessions").doc(phone).update({
        processedWebhookTasks: admin.firestore.FieldValue.arrayUnion(task),
      });
      await updateSession(phone, { onboardingStep: "caregiver_send_bgcheck" });
      await sendMessage(chatId,
        "Payment received — thank you! Now for the final step: a background check is required for all caregivers.\n\n" +
        "Tap to get started — usually takes about 5 minutes:"
      );
      await handleCaregiverSendBgcheck(phone, chatId, session);
      break;
    }

    case "background_check": {
      await db.collection("agent_sessions").doc(phone).update({
        processedWebhookTasks: admin.firestore.FieldValue.arrayUnion(task),
      });
      // Checkr came back clear → advance to Stripe Connect
      await updateSession(phone, { onboardingStep: "caregiver_send_stripe_connect" });
      await sendMessage(chatId,
        "Your background check came back clear.\n\n" +
        "One last step: set up your payout account so you can get paid after every visit."
      );
      await handleCaregiverSendStripeConnect(phone, chatId, session);
      break;
    }

    case "identity": {
      const step = session.onboardingStep ?? "";
      if (step === "client_awaiting_identity") {
        // Ensure Firebase Auth account exists and get UID so we can write to users/{uid}
        let uid = session.userId as string | undefined;
        if (!uid) {
          try {
            const userRecord = await admin.auth().getUserByPhoneNumber(phone);
            uid = userRecord.uid;
          } catch {
            try {
              const d = session.onboardingData ?? {} as any;
              const newUser = await admin.auth().createUser({
                phoneNumber:  phone,
                displayName:  (d.firstName ?? "") as string,
              });
              uid = newUser.uid;
            } catch (err) {
              console.error("advanceOnboardingStep(identity) createUser error:", err);
            }
          }
          if (uid) await updateSession(phone, { userId: uid });
        }

        // Write identityCheckStatus to the web app's users doc
        if (uid) {
          await db.collection("users").doc(uid).set({
            identityCheckStatus:  "verified",
            identityVerifiedAt:   admin.firestore.FieldValue.serverTimestamp(),
            phone,
            updatedAt:            admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }

        // New order: plan/price was accepted before identity, so once identity
        // clears we go straight to collecting payment (card on file).
        await updateSession(phone, { onboardingStep: "client_send_payment" });
        await handleClientSendPayment(phone, chatId, session);
      } else if (step === "caregiver_awaiting_identity") {
        await updateSession(phone, { onboardingStep: "caregiver_send_bgcheck" });
        await handleCaregiverSendBgcheck(phone, chatId, session);
      }
      break;
    }

    case "stripe_connect": {
      // Mark processed first to prevent duplicate caregiver doc creation on retry
      await db.collection("agent_sessions").doc(phone).update({
        processedWebhookTasks: admin.firestore.FieldValue.arrayUnion(task),
      });

      // Caregiver Stripe Connect complete → finalize caregiver doc
      const d = session.onboardingData ?? {};
      // Raw coords (present only when the caregiver shared a location pin) — let
      // aiMatching use true haversine distance instead of the city/zip proxy.
      const cgLat = typeof d.lat === "number" ? d.lat as number : undefined;
      const cgLng = typeof d.lng === "number" ? d.lng as number : undefined;
      const cgHasCoords = cgLat !== undefined && cgLng !== undefined;
      const profileData = {
        phone,
        name:            d.name,
        city:            d.city,
        zipCode:         d.zipCode,
        ...(cgHasCoords ? { lat: cgLat, lng: cgLng, location: { lat: cgLat, lng: cgLng } } : {}),
        // Profile photo + uploaded credentials (web upload OR texted to Cara).
        ...(d.profilePhoto ? { profilePhoto: d.profilePhoto, photoURL: d.profilePhoto } : {}),
        ...(Array.isArray(d.documents) && d.documents.length ? { documents: d.documents } : {}),
        yearsExperience: d.yearsExperience,
        certifications:  d.certifications,
        specialties:     d.specialties,
        availability:    d.availability,
        hourlyRate:      d.hourlyRate,
        stripeAccountId: d.stripeAccountId,
        email:           d.email   ?? null,
        bio:             d.bio     ?? null,
        jobType:         d.jobType ?? null,
        gender:          d.gender    ?? null,
        languages:       Array.isArray(d.languages) ? d.languages : [],
        canDrive:        d.canDrive ?? null,
        membershipSubscriptionId: (session as any).caregiverSubscriptionId ?? null,
        status:          "active",
        // Visibility gate: families' FindCaregivers query only loads caregivers
        // where onboardingStatus === 'profile_complete'. Cara is the canonical
        // onboarding path, so it must set this too (the web wizard already does).
        onboardingStatus: "profile_complete",
      };

      // Admin verification queue reads verificationStatus === 'submitted' (the value
      // stripe.ts sets for the web path). Set it here so Cara caregivers also enter the
      // queue — but never clobber a terminal status the Checkr webhook may have already set.
      const TERMINAL_VSTATUSES = ["approved", "rejected", "pre_adverse_action", "checkr_clear"];

      // Resolve the Firebase Auth uid first — the canonical caregivers/{uid} doc ID
      // (Cara/web data contract). Also enables the users/{uid} parity write below.
      const authUid = await createFirebaseAuthAccount(phone, (d.name ?? "") as string).catch((err) => {
        console.error("createFirebaseAuthAccount error:", err);
        return null;
      });

      let caregiverId: string;
      if (session.caregiverId) {
        const existingSnap = await db.collection("caregivers").doc(session.caregiverId).get();
        const currentVStatus = existingSnap.data()?.verificationStatus as string | undefined;
        const vStatusPatch = (!currentVStatus || !TERMINAL_VSTATUSES.includes(currentVStatus))
          ? { verificationStatus: "submitted" }
          : {};
        if (authUid && session.caregiverId !== authUid) {
          // Legacy random-ID doc (pre-created before uid-keying landed) — migrate
          // everything onto caregivers/{uid} and drop the orphan. The Checkr webhook
          // looks caregivers up by backgroundCheckData.checkrCandidateId (a query,
          // not a doc ID), so the lookup survives the move.
          const oldData = existingSnap.exists ? existingSnap.data()! : {};
          await db.collection("caregivers").doc(authUid).set(
            { ...oldData, ...profileData, ...vStatusPatch, uid: authUid },
            { merge: true }
          );
          if (existingSnap.exists) await existingSnap.ref.delete().catch(() => {});
          caregiverId = authUid;
        } else {
          // Doc was pre-created during bg check — update it with full profile.
          await db.collection("caregivers").doc(session.caregiverId).update({ ...profileData, ...vStatusPatch });
          caregiverId = session.caregiverId;
        }
      } else if (authUid) {
        await db.collection("caregivers").doc(authUid).set({
          ...profileData,
          uid: authUid,
          verificationStatus: "submitted",
          createdAt: new Date().toISOString(),
        }, { merge: true });
        caregiverId = authUid;
      } else {
        // No auth uid resolvable — random-ID fallback (legacy identity model).
        const caregiverRef = await db.collection("caregivers").add({
          ...profileData,
          verificationStatus: "submitted",
          createdAt: new Date().toISOString(),
        });
        caregiverId = caregiverRef.id;
      }

      // users/{uid} parity write — the web dashboard, admin tools, and booking
      // flows read users/{uid} (userType, name, phone) for caregivers too.
      if (authUid) {
        await db.collection("users").doc(authUid).set({
          uid:        authUid,
          userType:   "caregiver",
          name:       (d.name ?? null) as string | null,
          phone,
          email:      (d.email ?? null) as string | null,
          caregiverId,
          updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }).catch((err) => console.error("caregiver users/{uid} parity write error:", err));
      }

      await updateSession(phone, {
        caregiverId,
        onboardingStep: "caregiver_ask_permissions",
      });

      // Waitlist trigger: a new active caregiver just landed. Notify any families
      // we honestly held (awaitingSupply) in this caregiver's city that care is
      // now available, and clear the flag so they're not pinged twice.
      notifyWaitlistedFamilies((d.city as string) ?? "").catch((err) =>
        console.error("notifyWaitlistedFamilies error:", err)
      );

      // U10 — reverse of the job→caregiver fan-out: a newly active caregiver
      // should immediately hear about open jobs that already fit them, not just
      // future ones. Fire-and-forget; invites the single best-fit open job.
      import("../triggers/caregiverJobMatch")
        .then((m) => m.notifyNewCaregiverOfJobs(caregiverId))
        .catch((err) => console.error("notifyNewCaregiverOfJobs error:", err));

      // Notify admin
      notifyAdminNewCaregiverSignup({
        caregiverId,
        name:        (d.name ?? "") as string,
        phone,
        city:        (d.city ?? "") as string,
      }).catch((err) => console.error("notifyAdminNewCaregiverSignup error:", err));

      await db.collection("admin_alerts").add({
        type:        "new_caregiver_signup",
        caregiverId,
        name:        d.name,
        phone,
        createdAt:   new Date().toISOString(),
        resolved:    false,
      });

      // Push caregiver profile to Zep knowledge graph
      addBusinessDataToZep({
        userId: getZepUserId(phone),
        data: {
          user_type:                    "caregiver",
          user_name:                    (d.name ?? "") as string,
          caregiver_city:               d.city,
          caregiver_years_experience:   d.yearsExperience,
          caregiver_specialties:        Array.isArray(d.specialties) ? d.specialties : [],
          caregiver_availability:       d.availability,
          caregiver_hourly_rate:        d.hourlyRate,
          caregiver_certifications:     Array.isArray(d.certifications) ? d.certifications : [],
          data_source:                  "cara_caregiver_onboarding",
          timestamp:                    new Date().toISOString(),
        },
      }).catch((err) => console.error("addBusinessDataToZep caregiver error:", err));

      // Warm "you're approved" milestone message before handing off to permissions
      const firstName = ((d.name ?? "") as string).split(" ")[0] || "you";
      const specialties = Array.isArray(d.specialties) ? (d.specialties as string[]).join(", ") : "";
      const activationMsg = await generateCaraMessage({
        audience: "caregiver",
        context:
          `Caregiver first name: ${firstName}. ` +
          `Their background check came back clear and they just finished setting up payouts — they're now fully approved and active. ` +
          `${specialties ? `Their specialties: ${specialties}. ` : ""}` +
          `Write a warm 2-3 sentence "you're approved" celebration message. Reassure them their profile is live, ` +
          `mention they'll start getting matched with families soon, and that I'll text them as new jobs come in. ` +
          `Sound genuinely happy for them.`,
        fallback:
          `🎉 You're approved, ${firstName}! Your profile is live and I'll start matching you with families that need help. ` +
          `Watch for job alerts here — reply YES to any that interest you. Welcome to CareConnex!`,
        maxTokens: 180,
      });
      await sendMessage(chatId, activationMsg);

      const { sendCaregiverPermissionsFlow } = await import("./permissionsConversation");
      await sendCaregiverPermissionsFlow(phone, chatId, session, d.name as string);
      break;
    }
  }
}

// ── JOB POSTING FLOW ──────────────────────────────────────────────────────────
// Triggered after client pays membership. Mirrors the 6-step PostJobFlow web
// form and writes to the same Firestore collections so the web dashboard syncs.

// Map an intake time-of-day phrase to the job post's slot enum.
function mapTimeOfDayToSlots(tod: string): string[] {
  const t = (tod || "").toLowerCase();
  if (t.includes("all") || t.includes("any")) return ["Morning", "Afternoon", "Evening"];
  const slots: string[] = [];
  if (t.includes("morning") || t.includes("am"))                       slots.push("Morning");
  if (t.includes("afternoon") || t.includes("noon"))                   slots.push("Afternoon");
  if (t.includes("evening") || t.includes("night") || t.includes("pm")) slots.push("Evening");
  if (t.includes("overnight") || t.includes("24"))                     slots.push("Overnight");
  return slots.length ? slots : ["Morning"];
}

// Derive a ready-to-post job draft from the intake we ALREADY collected, so the
// client confirms once instead of re-answering schedule/needs/budget after paying.
function deriveJobDataFromIntake(d: Record<string, unknown>): Record<string, unknown> {
  const daysPerWeek = Number(d.daysPerWeek ?? 0);
  const frequency   = daysPerWeek >= 5 ? "full_time" : daysPerWeek >= 3 ? "part_time" : "occasional";
  const conditions  = (Array.isArray(d.conditions) ? d.conditions : []) as string[];
  const careNeeds   = (Array.isArray(d.careNeeds)  ? d.careNeeds  : []) as string[];
  const heavy       = [...conditions, ...careNeeds].join(" ").toLowerCase();
  const careLevel   = /dementia|alzheimer|medical|wound|catheter|feeding|insulin/.test(heavy)
    ? "intensive"
    : (careNeeds.length || conditions.length) ? "moderate" : "light";
  const budgetMax   = Number(d.budgetMax ?? 0);
  const budgetMin   = Number(d.budgetMin ?? 0);
  const hourlyRate: number | string = budgetMax || budgetMin || "flexible";
  return {
    jobStartDate:     (d.startDate as string) || "ASAP",
    jobFrequency:     frequency,
    jobDays:          [],
    jobTimeOfDay:     mapTimeOfDayToSlots((d.timeOfDay as string) ?? ""),
    jobCareNeeds:     careNeeds.length ? careNeeds : conditions,
    jobCareLevel:     careLevel,
    jobHourlyRate:    hourlyRate,
    jobPaymentMethod: "card",
    petsInHome:       false,
    smokingHousehold: false,
  };
}

async function presentPrefilledJobPost(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const d       = session.onboardingData ?? {};
  const jobData = deriveJobDataFromIntake(d);
  await mergeOnboardingData(phone, jobData);
  await updateSession(phone, { onboardingStep: "job_confirm_prefill" });

  const seniorName = (d.seniorName as string) ?? "your loved one";
  const freqMap: Record<string, string> = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
  const rateLabel  = jobData.jobHourlyRate === "flexible" ? "flexible rate" : `$${jobData.jobHourlyRate}/hr`;
  const needs      = (jobData.jobCareNeeds as string[]).join(", ") || "general care";

  await sendMessage(chatId,
    `Membership active — thank you! I'll post ${seniorName}'s care request using what you already told me:\n\n` +
    `📅 Start ${jobData.jobStartDate} · ${freqMap[jobData.jobFrequency as string]} · ${(jobData.jobTimeOfDay as string[]).join(", ")}\n` +
    `💛 ${needs}\n` +
    `💰 ${rateLabel}\n\n` +
    `Want me to post it as-is? Reply YES, or tell me what to change.`
  );
}

async function handleJobConfirmPrefill(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const intent = await parseWithClaude(
    '"yes","yep","post it","go","looks good","sounds good","sure","ok","perfect" → confirm. ' +
    'Anything that asks to change/edit a detail, or says no → edit. Reply with exactly one word: confirm or edit.',
    text
  );

  if (intent !== "confirm") {
    // Let them adjust everything via the detailed step-by-step flow.
    await updateSession(phone, { onboardingStep: "job_ask_start" });
    await sendMessage(chatId, "No problem — let's set it up together.");
    await handleJobAskStart(phone, chatId, "", session);
    return;
  }

  const uid = session.userId as string | undefined;
  if (!uid) {
    await updateSession(phone, { onboardingStep: "job_ask_start" });
    await handleJobAskStart(phone, chatId, "", session);
    return;
  }
  try {
    const refreshed  = await db.collection("agent_sessions").doc(phone).get();
    const onboarding = (refreshed.data()?.onboardingData ?? {}) as Record<string, unknown>;
    const jobId = await buildAndSaveJobPost({ uid, phone, onboardingData: onboarding, jobData: onboarding });
    const city  = (onboarding.city as string) ?? "your area";
    await updateSession(phone, { onboardingStep: "client_ask_permissions" });
    await sendMessage(chatId,
      `Your care request is live! 🎉 I've notified caregivers within 25 miles of ${city} and I'll message you the moment someone applies.`
    );
    const { sendClientPermissionsFlow } = await import("./permissionsConversation");
    const freshSnap = await db.collection("agent_sessions").doc(phone).get();
    await sendClientPermissionsFlow(phone, chatId, freshSnap.data() as AgentSession);
    console.log(`[handleJobConfirmPrefill] Job posted: ${jobId} for uid=${uid}`);
  } catch (err) {
    console.error("[handleJobConfirmPrefill] buildAndSaveJobPost error:", err);
    await sendMessage(chatId, "There was a problem posting your request — our team has been notified. You can also post it at " + APP_URL + "/client/post-job");
  }
}

async function handleJobAskStart(
  phone: string, chatId: string, _text: string, session: AgentSession
): Promise<void> {
  const d = session.onboardingData ?? {};
  await sendMessage(chatId,
    `Your membership is active! 🎉 Let's find the perfect caregiver for ${(d.seniorName as string) ?? "your loved one"}.\n\n` +
    `When would you like care to start? (e.g. "next Monday", "ASAP", "June 1")`
  );
  await updateSession(phone, { onboardingStep: "job_ask_frequency" });
}

async function handleJobAskFrequency(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const startDate = await parseWithClaude(
    "Extract a start date from this message. If the user says 'ASAP' or similar, return 'ASAP'. " +
    "Otherwise return the date in YYYY-MM-DD format if possible, or a plain text description. Reply with just the date value.",
    text
  );
  await mergeOnboardingData(phone, { jobStartDate: startDate !== "__parse_error__" ? startDate : text.trim() });
  await updateSession(phone, { onboardingStep: "job_ask_days" });
  await sendMessage(chatId,
    "How often do you need help?\n\n" +
    "1️⃣  Occasional (1–2 days/week)\n" +
    "2️⃣  Part-time (3–4 days/week)\n" +
    "3️⃣  Full-time (5+ days/week)"
  );
}

async function handleJobAskDays(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId,
      "How often do you need help?\n\n" +
      "1️⃣  Occasional (1–2 days/week)\n" +
      "2️⃣  Part-time (3–4 days/week)\n" +
      "3️⃣  Full-time (5+ days/week)"
    );
    return;
  }
  const raw = await parseWithClaude(
    'Classify the care frequency. "1", occasional, 1-2 days = occasional. ' +
    '"2", part-time, part time, 3-4 days = part_time. ' +
    '"3", full-time, full time, every day, 5+ days = full_time. ' +
    'Reply with exactly one of: occasional, part_time, full_time',
    text
  );
  const frequency = ["occasional", "part_time", "full_time"].includes(raw) ? raw : "occasional";
  const freqLabel: Record<string, string> = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
  await mergeOnboardingData(phone, { jobFrequency: frequency });
  await updateSession(phone, { onboardingStep: "job_ask_time" });
  await sendMessage(chatId,
    `${freqLabel[frequency] ?? "Got it"}! Which days work best?\n\n(e.g. "Mon, Wed, Fri" or "weekdays" or "every day")`
  );
}

async function handleJobAskTime(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "Which days work best? (e.g. \"Mon, Wed, Fri\" or \"weekdays\")");
    return;
  }
  const raw = await parseWithClaude(
    'Extract days of the week as a JSON array using full names (Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday). ' +
    '"weekdays" or "mon-fri" = ["Monday","Tuesday","Wednesday","Thursday","Friday"]. ' +
    '"weekends" = ["Saturday","Sunday"]. ' +
    '"every day" or "daily" = all 7 days. ' +
    'Return only a JSON array, nothing else.',
    text
  );
  let days: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) days = parsed;
  } catch { /**/ }
  if (days.length === 0) days = ["Monday", "Wednesday", "Friday"];
  await mergeOnboardingData(phone, { jobDays: days });
  await updateSession(phone, { onboardingStep: "job_ask_care_needs" });
  await sendMessage(chatId,
    `${days.length === 7 ? "Every day" : days.join(", ")} — perfect! What time of day works best?\n\n` +
    "Reply with one or more numbers:\n\n" +
    "1️⃣  Morning (6am–noon)\n" +
    "2️⃣  Afternoon (noon–6pm)\n" +
    "3️⃣  Evening (6pm–10pm)\n" +
    "4️⃣  Overnight"
  );
}

async function handleJobAskCareNeeds(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId,
      "What time of day works best?\n\n" +
      "1️⃣  Morning  2️⃣  Afternoon  3️⃣  Evening  4️⃣  Overnight"
    );
    return;
  }
  const raw = await parseWithClaude(
    'Extract the times of day as a JSON array. Valid values: "Morning", "Afternoon", "Evening", "Overnight". ' +
    '"1" or "morning" or "am" → Morning. "2" or "afternoon" or "noon" → Afternoon. ' +
    '"3" or "evening" or "night" or "pm" → Evening. "4" or "overnight" or "24" → Overnight. ' +
    'Return only a JSON array of matching values.',
    text
  );
  let timeOfDay: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) timeOfDay = parsed;
  } catch { /**/ }
  if (timeOfDay.length === 0) timeOfDay = ["Morning"];
  const d = session.onboardingData ?? {};
  await mergeOnboardingData(phone, { jobTimeOfDay: timeOfDay });
  await updateSession(phone, { onboardingStep: "job_ask_care_level" });
  await sendMessage(chatId,
    `Got it — ${timeOfDay.join(" & ")}! What kind of help does ${(d.seniorName as string) ?? "your loved one"} need?\n\n` +
    "Reply with numbers (pick all that apply):\n\n" +
    "1️⃣  Mobility & Movement\n" +
    "2️⃣  Memory Care / Dementia\n" +
    "3️⃣  Medications\n" +
    "4️⃣  Personal Care (bathing, dressing)\n" +
    "5️⃣  Meals & Nutrition\n" +
    "6️⃣  Transportation\n" +
    "7️⃣  Light Housekeeping\n" +
    "8️⃣  Companionship"
  );
}

async function handleJobAskCareLevel(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    const d2 = session.onboardingData ?? {};
    await sendMessage(chatId,
      `What kind of help does ${(d2.seniorName as string) ?? "your loved one"} need? Reply with numbers.`
    );
    return;
  }
  const NEEDS_MAP: Record<string, string> = {
    "1": "Mobility & Movement", "2": "Memory Care / Dementia",
    "3": "Medications", "4": "Personal Care",
    "5": "Meals & Nutrition", "6": "Transportation",
    "7": "Light Housekeeping", "8": "Companionship",
  };
  const raw = await parseWithClaude(
    'Return a JSON array of care need numbers that match the user\'s message. ' +
    '1=Mobility, 2=Memory Care/Dementia, 3=Medications, 4=Personal Care (bathing/dressing), ' +
    '5=Meals/Nutrition, 6=Transportation, 7=Housekeeping, 8=Companionship. ' +
    'Match by number or keyword. Return only a JSON array of number strings like ["1","3"].',
    text
  );
  let careNeeds: string[] = [];
  try {
    const nums = JSON.parse(raw) as string[];
    if (Array.isArray(nums)) careNeeds = nums.map(n => NEEDS_MAP[n]).filter(Boolean);
  } catch { /**/ }
  if (careNeeds.length === 0) careNeeds = ["Companionship"];
  const d = session.onboardingData ?? {};
  await mergeOnboardingData(phone, { jobCareNeeds: careNeeds });
  await updateSession(phone, { onboardingStep: "job_ask_environment" });
  await sendMessage(chatId,
    `Noted — ${careNeeds.join(", ")}. How much support does ${(d.seniorName as string) ?? "your loved one"} need overall?\n\n` +
    "1️⃣  Light — mostly supervision & companionship\n" +
    "2️⃣  Moderate — hands-on help with some tasks\n" +
    "3️⃣  Intensive — full assistance with most tasks"
  );
}

async function handleJobAskEnvironment(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId,
      "How much support is needed?\n1️⃣ Light  2️⃣ Moderate  3️⃣ Intensive"
    );
    return;
  }
  const raw = await parseWithClaude(
    '"1", light, supervision, minimal, companion = light. ' +
    '"2", moderate, some help, hands-on = moderate. ' +
    '"3", intensive, full assist, full help, a lot = intensive. ' +
    'Reply with exactly one of: light, moderate, intensive',
    text
  );
  const careLevel = ["light", "moderate", "intensive"].includes(raw) ? raw : "moderate";
  const levelLabel: Record<string, string> = { light: "Light", moderate: "Moderate", intensive: "Intensive" };
  await mergeOnboardingData(phone, { jobCareLevel: careLevel });
  await updateSession(phone, { onboardingStep: "job_ask_rate" });
  await sendMessage(chatId,
    `${levelLabel[careLevel] ?? "Got it"}. Two quick things about the home: Are there pets? Is it a smoking household?\n\n` +
    `(e.g. "dog, non-smoking" or "no pets, non-smoking")`
  );
}

async function handleJobAskRate(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "Are there pets in the home? Is it a smoking household?");
    return;
  }
  const rawPets = await parseWithClaude(
    'Does the user mention pets (dog, cat, pet, bird, animal) in a positive sense (not "no pet")? Reply yes or no.',
    text
  );
  const rawSmoke = await parseWithClaude(
    'Does the user mention smoking in a positive sense (not "non-smoking", "no smoking")? Reply yes or no.',
    text
  );
  const petsInHome = rawPets.toLowerCase().startsWith("yes");
  const smokingHousehold = rawSmoke.toLowerCase().startsWith("yes");
  const petsLabel = petsInHome ? "pets in home" : "no pets";
  const smokeLabel = smokingHousehold ? "smoking household" : "non-smoking";
  const d = session.onboardingData ?? {};
  const city = (d.city as string) ?? "";
  await mergeOnboardingData(phone, { petsInHome, smokingHousehold });
  await updateSession(phone, { onboardingStep: "job_ask_pay_method" });
  await sendMessage(chatId,
    `Got it — ${petsLabel}, ${smokeLabel}. What hourly rate are you hoping to pay?\n\n` +
    (city
      ? `Most families in ${city} pay $18–$28/hr. Reply with a number or "flexible".`
      : `Most families pay $18–$28/hr. Reply with a number or "flexible".`)
  );
}

async function handleJobAskPayMethod(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "What hourly rate are you hoping to pay? (or \"flexible\")");
    return;
  }
  const raw = await parseWithClaude(
    'Extract an hourly pay rate. If the user says flexible, open, negotiable, or similar, return "flexible". ' +
    'Otherwise extract just the number (e.g. 20, 22.50). Return only the number or the word flexible.',
    text
  );
  let hourlyRate: number | "flexible" = "flexible";
  if (raw !== "flexible") {
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 5 && n <= 200) hourlyRate = n;
  }
  const rateLabel = hourlyRate === "flexible" ? "flexible rate" : `$${hourlyRate}/hr`;
  await mergeOnboardingData(phone, { jobHourlyRate: hourlyRate });
  await updateSession(phone, { onboardingStep: "job_ask_description" });
  await sendMessage(chatId,
    `${rateLabel} — sounds good! How will you pay the caregiver?\n\n` +
    "1️⃣  Credit/debit card\n" +
    "2️⃣  Cash directly"
  );
}

async function handleJobAskDescription(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "How will you pay the caregiver?\n1️⃣ Card  2️⃣ Cash");
    return;
  }
  const raw = await parseWithClaude(
    '"1", card, credit, debit, stripe = card. "2", cash, direct, hand = cash. ' +
    'Reply with exactly one of: card, cash',
    text
  );
  const paymentMethod = raw === "cash" ? "cash" : "card";
  const payLabel = paymentMethod === "cash" ? "Cash" : "Card";
  const d = session.onboardingData ?? {};
  await mergeOnboardingData(phone, { jobPaymentMethod: paymentMethod });
  await updateSession(phone, { onboardingStep: "job_confirm_post" });
  await sendMessage(chatId,
    `${payLabel} — perfect! Last step: in 1–3 sentences, describe a typical day of care for ` +
    `${(d.seniorName as string) ?? "your loved one"}. What should a caregiver know?`
  );
}

async function handleJobConfirmPost(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const norm = text.trim().toUpperCase();

  // If this is the first time we're here, store description and show summary
  const d = session.onboardingData ?? {};
  if (!(d as any).jobDescription) {
    await mergeOnboardingData(phone, { jobDescription: text.trim() });

    // Refresh onboarding data after merge
    const refreshed = await db.collection("agent_sessions").doc(phone).get();
    const rd = (refreshed.data()?.onboardingData ?? {}) as Record<string, unknown>;

    const rateLabel     = rd.jobHourlyRate === "flexible" ? "flexible rate" : `$${rd.jobHourlyRate}/hr`;
    const payLabel      = rd.jobPaymentMethod === "cash" ? "cash" : "card";
    const daysArr       = Array.isArray(rd.jobDays)       ? (rd.jobDays as string[]).join(", ") : "—";
    const timeArr       = Array.isArray(rd.jobTimeOfDay)  ? (rd.jobTimeOfDay as string[]).join(", ") : "—";
    const needsArr      = Array.isArray(rd.jobCareNeeds)  ? (rd.jobCareNeeds as string[]).join(", ") : "—";
    const levelLabel    = (rd.jobCareLevel as string) ?? "moderate";
    const startLabel    = (rd.jobStartDate as string) ?? "ASAP";
    const frequencyMap: Record<string, string> = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
    const freqLabel     = frequencyMap[(rd.jobFrequency as string) ?? "occasional"] ?? "Occasional";

    await sendMessage(chatId,
      `Here's your care request:\n\n` +
      `📅 Starting ${startLabel} · ${freqLabel} · ${daysArr} · ${timeArr}\n` +
      `🏠 ${(rd.city as string) ?? "—"}, ${(rd.zipCode as string) ?? ""}\n` +
      `💛 ${needsArr}\n` +
      `📊 ${levelLabel.charAt(0).toUpperCase() + levelLabel.slice(1)} care\n` +
      `💰 ${rateLabel} · ${payLabel}\n\n` +
      `Shall I post this? Reply YES to go live, or NO to make a change.`
    );
    return;
  }

  // User replied YES/NO to the confirmation
  if (norm === "YES" || norm === "Y" || norm === "YEP" || norm === "SURE" || norm === "OK" || norm === "OKAY") {
    const uid = session.userId as string | undefined;
    if (!uid) {
      await sendMessage(chatId, "Something went wrong — please try again or head to the app to complete your care request.");
      return;
    }

    try {
      const refreshed = await db.collection("agent_sessions").doc(phone).get();
      const jobData   = (refreshed.data()?.onboardingData ?? {}) as Record<string, unknown>;
      const onboarding = jobData; // same object holds both

      const jobId = await buildAndSaveJobPost({ uid, phone, onboardingData: onboarding, jobData: onboarding });

      const city = (onboarding.city as string) ?? "your area";
      await updateSession(phone, { onboardingStep: "client_ask_permissions" });
      await sendMessage(chatId,
        `Your care request is live! 🎉\n\n` +
        `I've notified caregivers within 25 miles of ${city}. ` +
        `I'll message you as soon as someone applies!\n\n` +
        `You can also browse caregivers and manage everything at ${APP_URL}/client/dashboard`
      );

      // Move to permissions after a short pause
      const { sendClientPermissionsFlow } = await import("./permissionsConversation");
      const freshSnap = await db.collection("agent_sessions").doc(phone).get();
      await sendClientPermissionsFlow(phone, chatId, freshSnap.data() as AgentSession);

      console.log(`[handleJobConfirmPost] Job posted: ${jobId} for uid=${uid}`);
    } catch (err) {
      console.error("[handleJobConfirmPost] buildAndSaveJobPost error:", err);
      await sendMessage(chatId, "There was a problem posting your request — our team has been notified. Try again or visit " + APP_URL + "/client/post-job");
    }
  } else if (norm === "NO" || norm === "N" || norm === "NOPE") {
    // Clear description so the summary won't re-fire and restart from the top
    await db.collection("agent_sessions").doc(phone).update({
      "onboardingData.jobDescription": admin.firestore.FieldValue.delete(),
      onboardingStep: "job_ask_start",
    });
    await sendMessage(chatId,
      "No problem! Let's go through it again. When would you like care to start?"
    );
  } else {
    await sendMessage(chatId, "Just reply YES to post or NO to make a change.");
  }
}

// ── Mid-flow question answering ───────────────────────────────────────────────

async function answerQuestionMidFlow(text: string, session: AgentSession): Promise<string> {
  const d = session.onboardingData ?? {};
  return (await quickComplete(
    "You are Cara, an AI care assistant. " +
      "A user is in the middle of signing up and has a question. " +
      `Context: they are ${session.userType === "caregiver" ? "a caregiver looking for work" : "a family member looking for care"}. ` +
      `Name: ${(d.name ?? d.firstName ?? "") as string}. ` +
      "Answer briefly (1–2 sentences). Be warm and helpful.",
    text,
    { maxTokens: 100 },
  )).trim();
}
