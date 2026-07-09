import * as admin from "firebase-admin";
import { quickComplete } from "../utils/openaiClient";
import { unwrapJson } from "../utils/jsonUtils";
import { canChargeBundledMvr, canChargeStandaloneMvr, mvrPriceId } from "../mvrConfig";
import { createCheckrInvitation } from "../checkrApi";
import Stripe from "stripe";
import { recordCommitment, resolveCommitment } from "./commitmentTracker";
import { sendMessage, signalThinking, AgentSession } from "../linq/client";
import {
  classifyEmotionalContext,
  classifyEmotionalTopic,
  blendEmotionalContext,
  buildEmotionalContextDirective,
  StoredEmotionalContext,
} from "./emotionalContext";
import { generateToken } from "./tokenService";
import { getCapabilityExamples } from "./capabilityDiscovery";
import { notifyAdminNewClientSignup, notifyAdminNewCaregiverSignup } from "../notifications";
import { claimWebhookEvent, settleWebhookEvent, STRIPE_EVENTS_COLLECTION } from "../utils/webhookLedger";
import { initializeMemoryFiles, writeMemoryFile } from "../memory/memoryFiles";
import { pushOnboardingDataToZep, addBusinessDataToZep, getZepUserId } from "../memory/zepClient";
import { buildAndSaveJobPost } from "./buildJobPost";
import { paymentMethodLabel } from "../billing/paymentMethods";
import { generateCaraMessage } from "../utils/caraMessage";
import { generateOtp, verifyOtp, formatOtpForDisplay, OtpState } from "../utils/phoneVerification";
import { languageFromSession, t as tr } from "../utils/language";
import { SharedLocation } from "../utils/locationShare";
import { WAITLISTED_STEP } from "./serviceAreaGate";
import { downloadMedia, storeInboundMedia, InboundMediaPart } from "../utils/mediaIntake";
import { addKnownNames } from "../utils/knownNames";
import { verifyProfilePhoto, verifyDocument } from "../utils/visionVerify";
import { getAppUrl } from "../config/appUrl";
// conversationStep + onboardingSteps.client are KEPT: the loop-only cut deleted
// the scripted CONVERSATIONAL collection handlers, but the post-collection intake
// steps (client_ask_start/preferences/budget/confirm_intake) still run on this
// table-driven runner. (onboardingSteps.caregiver + onboardingDispatcher were
// deleted — caregiver has no runStep-based kept steps and the dispatcher only
// ever sequenced scripted client collection.)
import { runStep, RunStepContext, StepDeps } from "./conversationStep";
import { isQuestionOrOther as stepIsQuestionOrOther } from "./stepHandler";
import { buildClientSteps } from "./onboardingSteps.client";
import { isOnboardingDryRun, recordSideEffect, guardSideEffect } from "./onboardingDryRun";
import { runGetCaregiverPreviewAction } from "./actions/getCaregiverPreviewAction";
import { deriveWeeklyAvailability } from "./caregiverAvailability";
import { recipientPlanKey, householdSeniorDocId, normalizeAdditionalRecipients, allCareRecipients } from "./careRecipients";
import { collectionStepsForRole, missingRequiredFields, firstGateStep } from "./onboardingContract";

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
  // NOTE: only a one-time dropped PIN (➕ → Location → "Send My Current Location")
  // reaches us with coordinates. Apple's "Share My Location" (continuous live
  // share) does NOT deliver coordinates to the webhook, so don't promise it —
  // typing the city/zip is the reliable path.
  return isRichService(service)
    ? `${base}\n\n(Or tap ➕ → Location → "Send My Current Location" to drop a pin.)`
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
  // U10: in a dry-run, never touch Stripe — return a synthetic client that
  // records each call and yields placeholder ids/urls so downstream parity
  // logic still flows. Production (not dry-run) always gets the real client,
  // so the live path is unchanged.
  if (isOnboardingDryRun()) return DRY_RUN_STRIPE;
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", { apiVersion: "2023-10-16" as any });
  return _stripe;
}

// Synthetic Stripe used only under dry-run. Covers exactly the surface this file
// calls (identity sessions, price reads, checkout sessions, Connect accounts +
// account links). Each mutating call is recorded; reads return inert shapes.
const DRY_RUN_STRIPE = {
  identity: {
    verificationSessions: {
      create: async () => { recordSideEffect("stripe.identity.verificationSessions.create"); return { id: "vs_dryrun", url: "https://dryrun.local/identity" }; },
    },
  },
  prices: {
    retrieve: async () => ({ id: "price_dryrun", unit_amount: 0, recurring: null }),
  },
  checkout: {
    sessions: {
      create: async () => { recordSideEffect("stripe.checkout.sessions.create"); return { id: "cs_dryrun", url: "https://dryrun.local/checkout" }; },
    },
  },
  accounts: {
    create: async () => { recordSideEffect("stripe.accounts.create"); return { id: "acct_dryrun" }; },
  },
  accountLinks: {
    create: async () => { recordSideEffect("stripe.accountLinks.create"); return { url: "https://dryrun.local/connect-onboarding" }; },
  },
} as unknown as Stripe;

const APP_URL = getAppUrl();

// Work location for Checkr candidates/invitations (Checkr requires
// work_locations for US checks). The service-area gate (config/serviceArea.ts)
// only admits Santa Clara County signups today, so CA is exact — update this
// when the service area widens past California.
const CHECKR_WORK_STATE = "CA";

async function alertOnboardingLinkFailure(phone: string, step: string, err: unknown): Promise<void> {
  await db.collection("admin_alerts").add({
    type:      "onboarding_link_generation_failed",
    severity:  "high",
    phone,
    step,
    error:     err instanceof Error ? err.message : String(err),
    createdAt: new Date().toISOString(),
    resolved:  false,
  }).catch((alertErr) => console.error("onboarding link failure alert write failed", {
    phone,
    step,
    err: alertErr instanceof Error ? alertErr.message : String(alertErr),
  }));
}

async function sendOnboardingLinkFailureMessage(
  phone: string,
  chatId: string,
  session: AgentSession,
  kind: "background-check" | "payout setup" | "background-check renewal",
): Promise<void> {
  // "I'll text you the moment it's ready" is a tracked promise, not vibes:
  // record a `link` commitment BEFORE sending the copy, so the sweep re-attempts
  // the send in ~5 minutes and escalates to a human if it fails again. Before
  // this, the sentence had no mechanism behind it — the caregiver's signup
  // silently dead-ended here (2026-07-07 live test).
  const linkType: OnboardingLinkType =
    kind === "payout setup" ? "caregiver_payouts" : "caregiver_background_check";
  await recordCommitment({
    phone,
    chatId,
    kind:        "link",
    promiseText: `onboarding ${kind} link failed to generate — retry the send`,
    linkType,
    userType:    "caregiver",
    source:      "onboardingConversation:link_failure",
    dueInMs:     5 * 60_000,
  });
  await sendMessage(chatId, await generateCaraMessage({
    audience: "caregiver",
    language: session.preferredLanguage === "es" ? "es" : "en",
    context: `A caregiver needs a ${kind} link, but Evia could not generate the real external link. Be honest, warm, and brief. Say you are on it and will text the link once it is ready. Do not include any URL.`,
    fallback: `I hit a snag pulling up your ${kind} link — I'm on it and I'll text you the moment it's ready.`,
    maxTokens: 70,
  }));
}

// (isExplicitBioSkip removed with the scripted caregiver_ask_bio handler — the
// bio-skip classification now lives in save_onboarding_field's bio branch.)

// ── Helpers ───────────────────────────────────────────────────────────────────

async function updateSession(phone: string, updates: Record<string, unknown>): Promise<void> {
  // U10: in a shadow/dry-run, never mutate the live session doc — that would
  // clobber the legacy machine's state mid-flow. Record the would-be write.
  if (isOnboardingDryRun()) {
    recordSideEffect("firestore.update:agent_sessions", { phone, keys: Object.keys(updates) });
    return;
  }
  await db.collection("agent_sessions").doc(phone).update(updates);
}

async function mergeOnboardingData(phone: string, data: Record<string, unknown>): Promise<void> {
  if (isOnboardingDryRun()) {
    recordSideEffect("firestore.update:agent_sessions.onboardingData", { phone, keys: Object.keys(data) });
    return;
  }
  const snap = await db.collection("agent_sessions").doc(phone).get();
  const sess     = (snap.data() ?? {}) as Record<string, unknown>;
  const existing = (sess.onboardingData ?? {}) as Record<string, unknown>;
  const merged   = { ...existing, ...data };
  await db.collection("agent_sessions").doc(phone).update({
    onboardingData: merged,
  });

  // Incremental profile persistence: once the uid-keyed caregivers doc exists
  // (created at the gate handoff / bg-check pre-create), keep it in sync with
  // every onboarding merge. Before this, the FULL profile was written only at
  // the final Stripe Connect step — a caregiver who stalled anywhere mid-flow
  // had an empty webapp account. Non-fatal: profile mirroring must never break
  // the conversation turn. Visibility gates are untouched (status /
  // onboardingStatus stay wherever the step machinery put them).
  const caregiverId = sess.caregiverId as string | undefined;
  if (caregiverId && sess.userType === "caregiver") {
    const mirror = buildCaregiverProfileMirror(merged);
    if (Object.keys(mirror).length > 0) {
      await db.collection("caregivers").doc(caregiverId)
        .set(mirror, { merge: true })
        .catch((err) => console.error("mergeOnboardingData: caregiver profile mirror failed (non-fatal):", err));
    }
  }
}

// The caregiver-doc field mapping for everything collected over SMS — shared by
// the incremental mirror above, the gate-handoff doc creation, and the final
// Stripe Connect finalization, so the three can never drift apart again (the
// firstName-vs-name class of bug). Only DEFINED values are included: a merge
// with this object can never blank a field another path already set. The
// gating fields (status, onboardingStatus, verificationStatus,
// membershipSubscriptionId) are deliberately NOT here — they belong to the
// step machinery exclusively.
export function buildCaregiverProfileMirror(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const copy = (key: string, v: unknown): void => {
    if (v !== undefined && v !== null && v !== "") out[key] = v;
  };

  copy("name",    d.name);
  copy("city",    d.city);
  copy("zipCode", d.zipCode);
  // Raw coords (present only when the caregiver shared a location pin) — let
  // aiMatching use true haversine distance instead of the city/zip proxy.
  if (typeof d.lat === "number" && typeof d.lng === "number") {
    out.lat = d.lat;
    out.lng = d.lng;
    out.location = { lat: d.lat, lng: d.lng };
  }
  // Profile photo + uploaded credentials (web upload OR texted to Evia).
  if (d.profilePhoto) {
    out.profilePhoto = d.profilePhoto;
    out.photoURL     = d.profilePhoto;
  }
  if (Array.isArray(d.documents) && d.documents.length) out.documents = d.documents;
  copy("yearsExperience", d.yearsExperience);
  // Web parity aliases — the client-facing cards/modal and aiMatching read
  // these exact names (types.ts Caregiver): experience, hasTransportation,
  // skills. Without them Evia-onboarded caregivers render with blank
  // experience/skills and no transportation badge.
  copy("experience", d.yearsExperience);
  if (Array.isArray(d.certifications) && d.certifications.length) out.certifications = d.certifications;
  if (Array.isArray(d.specialties)   && d.specialties.length)     out.specialties   = d.specialties;
  const skills = Array.from(new Set([
    ...(Array.isArray(d.skills)      ? d.skills      as string[] : []),
    ...(Array.isArray(d.specialties) ? d.specialties as string[] : []),
  ]));
  if (skills.length) out.skills = skills;
  copy("availability", d.availability);
  // Structured map read by ai/scoring.ts availabilityOverlap and the web
  // profile modal. Missing map scores as 0% available — derive it.
  const weekly = deriveWeeklyAvailability(d.availability);
  if (weekly) out.weeklyAvailability = weekly;
  copy("hourlyRate", d.hourlyRate);
  copy("email",      d.email);
  copy("bio",        d.bio);
  copy("jobType",    d.jobType);
  copy("gender",     d.gender);
  if (Array.isArray(d.languages) && d.languages.length) out.languages = d.languages;
  if (d.canDrive !== undefined && d.canDrive !== null) {
    out.canDrive          = d.canDrive;
    out.hasTransportation = d.canDrive;
  }
  copy("stripeAccountId", d.stripeAccountId);
  return out;
}

// Create the uid-keyed caregivers/{uid} doc the moment collection completes
// (called from the webhooks.ts gate handoff), instead of waiting for the
// bg-check pre-create / final Stripe step. status "onboarding" is invisible to
// matching (matchingAgent queries status in ["active","pending_review"]) and
// to FindCaregivers (requires onboardingStatus "profile_complete") — but the
// caregiver's own webapp login shows their profile from this point on, and
// every subsequent mergeOnboardingData keeps it fresh.
export async function ensureCaregiverDocForOnboarding(phone: string): Promise<string | null> {
  if (isOnboardingDryRun()) {
    recordSideEffect("firestore.set:caregivers.gate_pre_create", { phone });
    return null;
  }
  const snap = await db.collection("agent_sessions").doc(phone).get();
  const sess = (snap.data() ?? {}) as Record<string, unknown>;
  if (sess.caregiverId) return sess.caregiverId as string;

  const d = (sess.onboardingData ?? {}) as Record<string, unknown>;
  const authUid = await createFirebaseAuthAccount(phone, (d.name ?? "") as string).catch(() => null);
  // No random-ID fallback here: without a uid the bg-check pre-create and the
  // finalization migration still cover doc creation later, on their own terms.
  if (!authUid) return null;

  const docRef  = db.collection("caregivers").doc(authUid);
  const docSnap = await docRef.get();
  // Never demote a doc that already progressed (recovery / re-onboarding edge).
  const keepStatus = docSnap.exists &&
    ["active", "pending_review"].includes((docSnap.data()?.status as string) ?? "");
  await docRef.set({
    phone,
    uid: authUid,
    ...(keepStatus ? {} : { status: "onboarding", onboardingStatus: "in_progress" }),
    ...(docSnap.exists ? {} : { createdAt: new Date().toISOString() }),
    ...buildCaregiverProfileMirror(d),
  }, { merge: true });
  await db.collection("agent_sessions").doc(phone).update({ caregiverId: authUid });
  return authUid;
}

// ── Native location request (1:1 iMessage) ────────────────────────────────────
// Marker persisted on the session when EVIA fires Linq's native location prompt.
// The scheduled nudge job (scheduled/locationRequestNudge.ts) reads it; the
// onboarding location handlers clear it once a pin OR a typed city/zip arrives.
export interface PendingLocationRequest {
  source:    "onboarding" | "mcp";
  sentAt:    string;   // ISO — when the prompt was fired
  nudgeSent: boolean;  // true once the single follow-up nudge has gone out
  reason?:   string;
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
// Context-aware question/off-topic detector — the shared stepHandler version.
// The old local copy here classified the text WITHOUT knowing what question was
// asked, so direct answers like "yes" or "Anahi is fine" were routinely
// misread as small talk, answered with a free-form reply, and the step's
// question re-asked in a loop (launch bug, 2026-07-06). The shared version
// takes the current question as context; `stepDeps` also passes each table
// step's re-ask through automatically now that the signature accepts it.
const isQuestionOrOther = stepIsQuestionOrOther;

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
// uid — the canonical doc ID for caregivers/{uid} and users/{uid} (Evia/web
// data contract: Evia must write where the web reads, and the web is uid-keyed).
async function createFirebaseAuthAccount(phone: string, displayName: string): Promise<string | null> {
  // U10: account creation is irreversible — never create a real Auth user in a
  // dry-run. Return a synthetic uid so downstream parity logic still flows.
  if (isOnboardingDryRun()) {
    recordSideEffect("auth.createUser", { phone });
    return "dryrun-uid";
  }
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

// Ensures the webapp account exists the moment a signup becomes real (client:
// intake confirmed; caregiver: collection complete) instead of waiting for the
// payment/bg-check webhooks: creates/finds the phone-keyed Auth user, seeds the
// users/{uid} doc the web reads (uid + userType drive services/api.ts getUser
// role resolution), and stamps session.userId so every later gate reuses the
// same uid. Failures page ops via admin_alerts — a silent miss here is exactly
// the "finished onboarding but no webapp account" bug.
async function ensureWebAccount(
  phone: string,
  role: "client" | "caregiver",
  displayName: string,
): Promise<string | null> {
  if (isOnboardingDryRun()) {
    recordSideEffect("ensureWebAccount", { phone, role });
    return "dryrun-uid";
  }
  try {
    const uid = await createFirebaseAuthAccount(phone, displayName);
    if (!uid) throw new Error("no auth uid resolvable for phone");
    const ref  = db.collection("users").doc(uid);
    const snap = await ref.get();
    await ref.set({
      uid,
      phone,
      // Seed the role only when absent — never flip an existing userType
      // (an admin's phone must not become a client account).
      ...(snap.data()?.userType ? {} : { userType: role }),
      ...(displayName
        ? (role === "client" ? { firstName: displayName } : { name: displayName })
        : {}),
      ...(snap.exists ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await updateSession(phone, { userId: uid });
    return uid;
  } catch (err) {
    console.error(`[ensureWebAccount] failed for ${phone} (${role}):`, err);
    await db.collection("admin_alerts").add({
      type:      "auth_account_create_failed",
      severity:  "high",
      phone,
      role,
      error:     String((err as Error)?.message ?? err),
      createdAt: new Date().toISOString(),
      resolved:  false,
    }).catch((alertErr) => console.error("[ensureWebAccount] alert write failed:", alertErr));
    return null;
  }
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

// The step the client flow continues to once conversational collection completes
// and the agent loop hands back to the deterministic gate machine. Kept (read by
// finalization + the post-collection handoff); mirrors onboardingContract's
// CLIENT_POST_COLLECTION_STEP.
export const CLIENT_POST_COLLECTION_STEP = "client_ask_start";

export function isFieldFilled(value: unknown): boolean {
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
export async function absorbClientFields(text: string, existing: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = await parseWithClaude(
    "You are extracting onboarding details from one message a family sent to Evia. " +
      "Return JSON only with the fields you can confidently extract. Omit fields not present. " +
      "Schema: " +
      `{"firstName":"family member first name (the person texting, not the senior)",` +
      `"seniorName":"senior's first name (the FIRST care recipient if more than one)",` +
      `"relationship":"family relationship to senior (mother, father, etc.)",` +
      `"additionalRecipients":[{"name":"...","relationship":"...","age":number}] — ` +
      `ONLY when care is for MORE THAN ONE person (e.g. "both mom and dad"); every person after the first goes here,` +
      `"age":number (the FIRST care recipient's age),` +
      `"careNeeds":["short need phrase"],` +
      `"conditions":["short condition phrase"],` +
      `"city":"city name",` +
      `"zipCode":"5-digit US zip code",` +
      `"daysPerWeek":number of days per week care is needed,` +
      `"timeOfDay":"morning/afternoon/evening/all-day",` +
      `"hoursPerDay":number of hours per day,` +
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

// True when the message is ONLY a greeting/pleasantry — no answer, name, question,
// or substantive content. LLM-judged (no keyword matching), per Evia's rules.
async function isGreetingOnly(text: string): Promise<boolean> {
  const r = await parseWithClaude(
    "Reply with exactly GREETING or OTHER. " +
    'GREETING = the message is ONLY a greeting or pleasantry with no real content ' +
    '(e.g. "hey cara", "hi", "hello", "good morning", "you there?", "yo", "hey"). ' +
    "OTHER = it contains any answer, a name, a question, a number, or any substantive info.",
    text
  ).catch(() => "OTHER");
  return r.trim().toUpperCase().startsWith("GREET");
}

// Plain-words version of the question Evia should pick back up on for the current
// onboarding step — used when a user greets mid-flow so the pickup matches the real
// prompt instead of resetting. Reuses each step's own reask() text where possible.
function currentStepQuestion(step: string, session: AgentSession): string {
  if (step === "ask_role") return "are you looking for care for a loved one, or are you a caregiver looking for work?";
  if (step === "client_confirm_name" || step === "caregiver_confirm_name") return "confirming the name I should call you";
  // Post-collection client steps (start/preferences/budget/confirm_intake) still
  // run on CLIENT_STEPS. Conversational collection steps are owned by the agent
  // loop and never reach this scripted helper.
  const c = CLIENT_STEPS[step]; if (c?.reask) return c.reask(session);
  const awaiting: Record<string, string> = {
    client_send_payment:           "finishing your payment setup with the link I sent",
    client_awaiting_payment:       "finishing your payment setup with the link I sent",
    client_awaiting_identity:      "the quick identity check with the link I sent",
    caregiver_send_photo:          "adding your profile photo with the link I sent",
    caregiver_awaiting_photo:      "adding your profile photo with the link I sent",
    caregiver_send_documents:      "uploading your certifications (or reply SKIP)",
    caregiver_awaiting_documents:  "uploading your certifications (or reply SKIP)",
    caregiver_send_membership:     "activating your membership with the link I sent",
    caregiver_awaiting_membership: "activating your membership with the link I sent",
    caregiver_send_bgcheck:        "your background check with the link I sent",
    caregiver_awaiting_bgcheck:    "your background check results (usually 1–3 days)",
    caregiver_send_stripe_connect: "setting up your payout account with the link I sent",
    caregiver_awaiting_stripe:     "setting up your payout account with the link I sent",
  };
  return awaiting[step] ?? "right where we left off";
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

  // Out-of-area waitlist parking (Santa Clara County gate). A waitlisted signup
  // that keeps texting gets a calm acknowledgement, not a re-collect loop. "START
  // OVER" lets them retry (e.g. if they mistyped their location).
  if (step === WAITLISTED_STEP) {
    // Exact-match fast path (the reminder tells them to reply START OVER), then
    // fall back to LLM classification so natural phrasings ("can I try again?",
    // "let me redo this") also escape the waitlist dead-end (CLAUDE.md: no
    // keyword-only intent parsing of free-form text).
    let wantsRestart = norm === "START OVER" || norm === "RESTART";
    if (!wantsRestart) {
      const cls = await parseWithClaude(
        'The user is on a signup waitlist because they appear to be outside the service area. ' +
        'Does the user want to restart signup or try again (e.g. because their location was wrong)? ' +
        'Reply exactly "restart" if they want to retry/start over, otherwise reply exactly "other".',
        text
      );
      wantsRestart = cls.trim().toLowerCase() === "restart";
    }
    if (wantsRestart) {
      // bgcheckInviteUrl must not survive a restart: the reuse guard in
      // handleCaregiverSendBgcheck would resend the OLD invitation (old legal
      // name/package) instead of minting one for the corrected details.
      await updateSession(phone, { onboardingStep: "ask_role", waitlisted: false, userType: null, onboardingData: {}, bgcheckInviteUrl: null });
      step = "ask_role";
      session.onboardingStep = "ask_role";
      (session as any).userType = null;
      session.onboardingData = {};
    } else {
      await sendMessage(chatId,
        "You're on our waitlist for when Evia expands to your area — I'll reach out the moment we do. " +
        "If you're actually in Santa Clara County and I got that wrong, reply START OVER and we'll try again. 💙"
      );
      return;
    }
  }

  // ── Self-heal a desynced cursor parked at ask_role (loop-only) ──────────────
  // Cursor stuck at ask_role but the role is ALREADY decided → the "Evia forgot
  // me" bug (it would re-ask role/name forever). The agent loop owns collection
  // now, so set the cursor to the role's first collection step and hand THIS turn
  // to the loop (its directive figures out the first missing field and never
  // re-asks a known one). START OVER / RESTART are handled just below, so let
  // those through untouched; a bare media turn falls to the media guard.
  if (step === "ask_role" && session.userType && norm !== "START OVER" && norm !== "RESTART"
      && !(inboundMedia && text === "")) {
    const role = session.userType === "caregiver" ? "caregiver" : "client";
    const firstStep = role === "caregiver" ? "caregiver_ask_name" : "client_ask_name";
    await updateSession(phone, { onboardingStep: firstStep });
    session.onboardingStep = firstStep;
    return dispatchOnboardingToLoop(phone, chatId, text, session, role);
  }

  // ── Inbound image / document (vision-gated) ─────────────────────────────────
  // A texted photo/document with no text. Route by the current step before any
  // text-based detectors run (they'd misfire on empty text). The handler decides
  // whether the media fits this step; if not, it nudges the user back on track.
  if (inboundMedia && text === "") {
    return handleInboundMedia(phone, chatId, session, inboundMedia, step);
  }

  // Global: "start over" resets
  if (norm === "START OVER" || norm === "RESTART") {
    // Clear userType + waitlisted too (mirrors the WAITLISTED_STEP reset). Leaving
    // userType set would trip the ask_role self-heal above on the NEXT inbound,
    // jumping past the role question — so a user who restarts to switch roles
    // would be silently kept in their old role. bgcheckInviteUrl is cleared so a
    // restarted signup mints a fresh Checkr invitation (corrected name/package)
    // instead of the reuse guard resending the old one.
    await updateSession(phone, { onboardingStep: "ask_role", onboardingData: {}, userType: null, waitlisted: false, bgcheckInviteUrl: null });
    await sendMessage(chatId,
      "No problem, let's start fresh.\n\n" +
      "Are you looking for care for a loved one, or are you a caregiver looking for work?"
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

  // ── Bare greeting mid-onboarding ("hey cara") ───────────────────────────────
  // A user who just says hi partway through signup is NOT answering or starting
  // over — they expect Evia to know where they are. Without this, "hey cara" at
  // ask_role falls through to a robotic role menu, which reads as Evia forgetting
  // them. Detect a greeting-only message, then warmly pick up at the CURRENT step
  // (by name when known) instead of re-asking from scratch or resetting.
  if (step && step !== "verify_phone" && step !== "complete"
      && text !== "__RESUME__" && text.trim() !== "" && !inboundMedia) {
    if (await isGreetingOnly(text)) {
      const data      = (session.onboardingData ?? {}) as Record<string, unknown>;
      const firstName = ((data.firstName ?? data.name) as string | undefined)?.trim() ?? "";
      const audience: "caregiver" | "family" = session.userType === "caregiver" ? "caregiver" : "family";
      const question  = currentStepQuestion(step, session);
      const msg = await generateCaraMessage({
        audience,
        language: session.preferredLanguage === "es" ? "es" : "en",
        context:
          `${firstName ? `${firstName} ` : "Someone you're already helping "}just said hi while you're partway through getting them set up. ` +
          `You are NOT starting over and you already know them — do NOT re-introduce yourself or ask their name again unless that's literally the current step. ` +
          `Warmly greet them back${firstName ? ` by name (${firstName})` : ""}, briefly signal you remember right where you two left off, then gently pick back up with this: "${question}".`,
        fallback: firstName
          ? `Hey ${firstName}! We were right here — ${question}`
          : `Hey! Picking up right where we left off — ${question}`,
        maxTokens: 90,
        emotionalDirective: (session as any)._emotionalDirective,
      });
      await sendMessage(chatId, msg);
      return;
    }
  }

  // NOTE (loop-only): the client multi-field absorption + auto-skip preamble that
  // used to live here is gone — the agent loop owns conversational collection and
  // runs its own pre-turn absorber (webhooks Fix 1). handleOnboardingStep now only
  // ever sees KEPT steps (ask_role, gates/awaiting, confirm-name, post-collection,
  // job_*), so there is no client_ask_* collection step to front-load into.

  // Mid-flow role switch: "wait I'm actually a caregiver" / "no I need care, not a job".
  // Previously the only escape hatch was START OVER which wiped all progress.
  // Now: detect the intent, confirm before flipping role, and reset onboardingData
  // (different role = different fields, so previous answers don't transfer).
  if (step !== "ask_role" && step !== "verify_phone" && !step.endsWith("_send_payment")
      && !step.endsWith("_awaiting_payment") && !step.endsWith("_awaiting_stripe")
      && !step.endsWith("_awaiting_bgcheck") && !step.endsWith("_awaiting_membership")
      && !step.endsWith("_awaiting_documents") && !step.endsWith("_awaiting_photo")
      // Confirm-name steps own their own yes/correction parsing. A bare "yes" here
      // must NOT be misread as a role switch — that would wipe onboardingData (the
      // name we just greeted them with) and dump them back to ask_role.
      && step !== "client_confirm_name"
      && step !== "caregiver_confirm_name") {
    const switchTo = await detectRoleSwitch(text, session.userType ?? null);
    if (switchTo) {
      await updateSession(phone, {
        onboardingStep: "ask_role",
        userType:        null,
        onboardingData:  {},
      });
      await sendMessage(chatId,
        switchTo === "caregiver"
          ? "Got it, let's switch you over. Just to be sure I've got it right — are you a caregiver looking for work, or did you mean you need care for a loved one?"
          : "Got it, let's switch you over. Just to be sure I've got it right — do you need care for a loved one, or did you mean you're a caregiver looking for work?"
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
      // Name-confirmation steps own their own yes/correction parsing — don't let the
      // generic mid-flow correction detector pre-empt the confirm handler.
      && step !== "client_confirm_name"
      && step !== "caregiver_confirm_name"
      && !step.startsWith("job_")) {
    const correction = await detectCorrection(text);
    if (correction) {
      // Caregivers store their name in `name`; clients in `firstName`. The
      // detector only emits `firstName`, so remap it for caregivers — otherwise
      // the corrected name lands on a field the caregiver doc never reads and is
      // silently lost.
      const correctionField =
        correction.field === "firstName" && step.startsWith("caregiver_")
          ? "name"
          : correction.field;
      // Numeric fields must be stored as numbers to match the normal parse path
      // (caregivers.hourlyRate / yearsExperience are written straight through).
      let correctionValue: string | number = correction.value;
      if (correctionField === "hourlyRate" || correctionField === "yearsExperience") {
        const n = Number(correction.value);
        if (Number.isFinite(n)) correctionValue = n;
      }
      await mergeOnboardingData(phone, { [correctionField]: correctionValue });
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
    case "ask_role":              return handleAskRole(phone, chatId, text, session);
    case "client_confirm_name":   return handleClientConfirmName(phone, chatId, text, session);
    // client_ask_name/senior/needs/location/schedule: deleted (loop-only) — the
    // agent loop owns client collection. A collection-step cursor never reaches
    // this switch (webhook routes it to the loop); the defensive default below
    // covers any stray cursor.
    case "client_ask_start":        return handleClientAskStart(phone, chatId, text, session);
    case "client_ask_preferences":  return handleClientAskPreferences(phone, chatId, text, session);
    case "client_ask_budget":       return handleClientAskBudget(phone, chatId, text, session);
    case "client_confirm_intake":   return handleClientConfirmIntake(phone, chatId, text, session);
    case "client_ask_plan":       return handleClientPlanReply(phone, chatId, text, session);
    case "client_send_payment":   return handleClientSendPayment(phone, chatId, session);
    case "client_awaiting_identity": {
      const msgIdentity = await generateCaraMessage({
        audience: "family",
        context: "A family member texted Evia while their identity verification is still in progress. Reassure them it's still being verified and that Evia will send their caregiver options as soon as it clears.",
        fallback: "Still verifying — I'll send your caregiver options as soon as it clears.",
        maxTokens: 80,
      });
      await sendMessage(chatId, msgIdentity);
      return;
    }
    case "client_awaiting_payment":
      await sendMessage(chatId, await generateCaraMessage({
        audience: "family",
        language: session.preferredLanguage === "es" ? "es" : "en",
        context: "The family hasn't finished their payment setup yet. Warmly nudge them to tap the link you already sent to finish up — it only takes about 30 seconds.",
        fallback: "I'm still waiting for your payment setup to complete. Tap the link I sent to finish up — it only takes 30 seconds! 💳",
        maxTokens: 70,
      }));
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
    case "caregiver_confirm_name":    return handleCaregiverConfirmName(phone, chatId, text, session, service);
    // caregiver_ask_name … caregiver_ask_bio: deleted (loop-only) — the agent loop
    // owns caregiver collection. These cursors never reach this switch (webhook
    // routes them to the loop); the defensive default below covers strays. The
    // gate steps below (send_photo onward) are KEPT — the loop hands off to them.
    case "caregiver_send_photo":       return handleCaregiverSendPhoto(phone, chatId, session);
    case "caregiver_awaiting_photo":
      await sendMessage(chatId, await generateCaraMessage({
        audience: "caregiver",
        language: session.preferredLanguage === "es" ? "es" : "en",
        context: "The caregiver hasn't uploaded their profile photo yet. Warmly nudge them to tap the upload link you already sent.",
        fallback: "Still waiting for your photo! Tap the upload link I sent 📷",
        maxTokens: 60,
      }));
      return;
    case "caregiver_send_documents":  return handleCaregiverSendDocuments(phone, chatId, session);
    case "caregiver_awaiting_documents": {
      // "SKIP" fast path kept (zero latency, old links/copy said it) — but the
      // ask is phrased naturally now, so also understand free-form skips
      // ("don't have any", "no certs", "nope") and answer questions instead of
      // nudging past them.
      let docIntent: string = norm === "SKIP" ? "skip" : "";
      if (!docIntent) {
        const parsed = await parseWithClaude(
          "The caregiver was asked to upload certifications (CNA license, CPR card, etc.) via a link, and told it's fine to say so if they don't have any. Classify the reply: " +
          "wants to skip / has none / will add later (\"skip\", \"don't have any\", \"no certs\", \"nope\", \"not yet\") → skip. " +
          "Asked a question (what counts, is it required, link not working) → question. " +
          "Says they HAVE certs or will upload (\"yes I have my CNA\", \"one sec\", \"uploading now\") or anything else → other. " +
          "Reply with exactly one word: skip, question, or other.",
          text
        );
        const v = (parsed ?? "").trim().toLowerCase();
        docIntent = v === "skip" || v === "question" ? v : "other";
      }
      if (docIntent === "skip") {
        await updateSession(phone, { onboardingStep: "caregiver_ask_mvr" });
        return handleCaregiverAskMvr(phone, chatId, session);
      }
      if (docIntent === "question") {
        await sendMessage(chatId, await answerQuestionMidFlow(text, session));
        await sendMessage(chatId, await generateCaraMessage({
          audience: "caregiver",
          language: session.preferredLanguage === "es" ? "es" : "en",
          context: "You just answered the caregiver's question at the certifications step. In ONE short natural line: whenever they're ready they can tap the upload link you sent, or just tell you to skip it.",
          fallback: "Whenever you're ready — tap the link to upload, or just tell me to skip it.",
          maxTokens: 50,
        }));
        return;
      }
      await sendMessage(chatId, await generateCaraMessage({
        audience: "caregiver",
        language: session.preferredLanguage === "es" ? "es" : "en",
        context: "The caregiver is at the certifications step. Warmly nudge them to tap the upload link you already sent, and weave in naturally that they can also just tell you to skip it if they don't have certifications.",
        fallback: "Tap the link I sent to upload your certifications — or if you don't have any, just tell me to skip it.",
        maxTokens: 70,
      }));
      return;
    }
    case "caregiver_ask_mvr":          return handleCaregiverAskMvr(phone, chatId, text, session);
    case "caregiver_send_membership":  return handleCaregiverSendMembership(phone, chatId, session);
    case "caregiver_awaiting_membership":
      await handleCaregiverResendMembership(phone, chatId, session, text);
      return;
    case "caregiver_send_mvr":         return handleCaregiverSendMvr(phone, chatId, session);
    case "caregiver_awaiting_mvr":
      await handleCaregiverResendMvr(phone, chatId, session, text);
      return;
    case "caregiver_send_bgcheck":    return handleCaregiverSendBgcheck(phone, chatId, session);
    case "caregiver_awaiting_bgcheck": {
      const msgBgcheck = await generateCaraMessage({
        audience: "caregiver",
        context: "A caregiver texted Evia while their background check is still processing. Let them know it's still in progress, that it usually takes 1–3 days, and that Evia will text them the moment results are in.",
        fallback: "Your background check is still processing — usually 1–3 days. I'll text you the moment results are in.",
        maxTokens: 80,
      });
      await sendMessage(chatId, msgBgcheck);
      return;
    }
    case "caregiver_send_stripe_connect": return handleCaregiverSendStripeConnect(phone, chatId, session);
    case "caregiver_awaiting_stripe":
      await sendMessage(chatId, await generateCaraMessage({
        audience: "caregiver",
        language: session.preferredLanguage === "es" ? "es" : "en",
        context: "The caregiver still needs to set up their payout account. Warmly nudge them to tap the link you already sent so they can get paid after each visit.",
        fallback: "Tap the link I sent to set up your payout account so you can get paid after each visit.",
        maxTokens: 70,
      }));
      return;
    default:
      // Loop-only defensive default (2c): a conversational collection-step cursor
      // (*_ask_* other than the KEPT client_ask_start/preferences/budget and
      // caregiver_ask_mvr, which have explicit cases above) should never reach the
      // scripted runner — the webhook routes those turns to the agent loop. If one
      // strays in, nudge gently and LEAVE the cursor so the next inbound routes to
      // the loop; never wipe their progress with a START OVER.
      if (step.includes("_ask_")) {
        await sendMessage(chatId, await generateCaraMessage({
          audience: session.userType === "caregiver" ? "caregiver" : "family",
          language: session.preferredLanguage === "es" ? "es" : "en",
          context: "You're mid-signup with this person and just need them to keep going. In ONE short, warm line, ask them to send that again or type it out — do NOT restart and do NOT ask them to start over.",
          fallback: "Sorry, I lost that for a second — mind sending it again?",
          maxTokens: 60,
        }));
        return;
      }
      await sendMessage(chatId, await generateCaraMessage({
        audience: session.userType === "caregiver" ? "caregiver" : "family",
        language: session.preferredLanguage === "es" ? "es" : "en",
        context: "Something got into an unexpected state in the conversation. Warmly and lightly let them know, and ask them to reply START OVER to begin fresh. You MUST include the literal keyword \"START OVER\".",
        fallback: "I think something went sideways. Reply START OVER to begin fresh.",
        maxTokens: 60,
      }));
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
  if (!looksLikeCode && norm !== "RESEND" && norm !== "START OVER" && norm !== "RESTART" && await isQuestionOrOther(text, "Please reply with the 6-digit verification code I just texted you.")) {
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

async function handleAskRole(phone: string, chatId: string, text: string, session?: AgentSession): Promise<void> {
  const raw = await parseWithClaude(
    'The user was just asked: "Are you looking for care for a loved one, or are you a caregiver yourself?" ' +
    'client = they need care for a LOVED ONE (someone else): "1", "family", "need care", "looking for care", ' +
    '"care for my mom/dad/parent/wife/husband", "for my loved one". ' +
    'self = they need care for THEMSELVES: "for myself", "for me", "I need help at home", "I\'m 78 and need a hand", ' +
    '"it\'s for me". ' +
    'caregiver = they PROVIDE care professionally and want work: "2", "I\'m a caregiver", "CNA", "HHA", "nurse", ' +
    '"looking for work", "looking for a job", "I want to work". ' +
    'CRITICAL: "looking for care" or "need care" means they NEED care → client (or self if clearly for themselves). ' +
    'Only "looking for WORK" or "looking for a JOB" means caregiver. ' +
    'Reply with exactly one word: client, self, or caregiver. If truly unclear, reply: unclear',
    text
  );
  const emotionalDirective = (session as any)?._emotionalDirective as string | undefined;
  if (raw === "self") {
    // Senior seeking care for THEMSELVES — the texter IS the care recipient.
    // Pre-fill relationship (and senior name when known) so no step ever asks
    // "who are you caring for", and every reply speaks to them directly.
    const knownName = (session?.onboardingData?.firstName as string | undefined)?.trim();
    await mergeOnboardingData(phone, {
      relationship: "self",
      ...(knownName ? { seniorName: knownName } : {}),
    });
    if (knownName) {
      await updateSession(phone, { onboardingStep: "client_ask_needs", userType: "client" });
      const msgSelf = await generateCaraMessage({
        audience: "family",
        context: `${knownName} just said they're looking for care for THEMSELVES. You ALREADY introduced yourself — ` +
          `never re-introduce. Speak to them directly ("you", never "your loved one" or third person). Warmly ` +
          `acknowledge them BY NAME and ask how old they are and what kind of help would make day-to-day easier.`,
        fallback: `Thanks, ${knownName} — I'd love to help you directly. How old are you, and what would you like a hand with day to day?`,
        maxTokens: 90,
        emotionalDirective,
      });
      await sendMessage(chatId, msgSelf);
      return;
    }
    await updateSession(phone, { onboardingStep: "client_ask_name", userType: "client" });
    const msgSelfName = await generateCaraMessage({
      audience: "family",
      context: "Someone just said they're looking for care for THEMSELVES. You ALREADY introduced yourself in the " +
        "previous message — do NOT say your name or re-introduce yourself. Speak to them directly and warmly ask " +
        "their name. Mention — once, casually — that a voice memo works instead of typing if that's easier.",
      fallback: "I'd be glad to help you directly. What's your name? And anytime typing feels like a pain, just send me a voice memo — I'll listen.",
      maxTokens: 100,
      emotionalDirective,
    });
    await sendMessage(chatId, msgSelfName);
    return;
  }
  if (raw === "client") {
    // If we already captured their name earlier (e.g. it rode in from the web form
    // or was given before the role was clear), NEVER ask for it again — that's the
    // "she doesn't know me" moment. Greet by name and move straight to the senior
    // question, the next step in the client flow.
    const knownName = (session?.onboardingData?.firstName as string | undefined)?.trim();
    if (knownName) {
      await updateSession(phone, { onboardingStep: "client_ask_senior", userType: "client" });
      const msgKnown = await generateCaraMessage({
        audience: "family",
        context: `${knownName} just said they're looking for care for a loved one, and you already know their name is ${knownName}. ` +
          `You ALREADY introduced yourself — never say "I'm Evia" or re-introduce yourself. ` +
          `Warmly acknowledge them BY NAME — do NOT ask their name again — then ask who they're looking for care for ` +
          `(the person's name and their relationship, e.g. "my mom Dorothy"). Mention — once, casually — that they ` +
          `can also just send a voice memo instead of typing, and you'll listen.`,
        fallback: `Thanks, ${knownName}. Who are we caring for — their name and your relationship? (And if typing it all out is a pain, just send me a voice memo — I'll listen.)`,
        maxTokens: 80,
        emotionalDirective,
      });
      await sendMessage(chatId, msgKnown);
      return;
    }
    await updateSession(phone, { onboardingStep: "client_ask_name", userType: "client" });
    const msg1 = await generateCaraMessage({
      audience: "family",
      context: "A new family member just said they're looking for care for a loved one. You ALREADY introduced " +
        "yourself in the previous message — do NOT say your name or re-introduce yourself. Warmly ask for " +
        "their name, and mention — once, casually — that if typing it all out ever feels like a pain, they can " +
        "just send you a voice memo and you'll listen.",
      fallback: "I'd love to help. What's your name? And anytime typing feels like a pain, just send me a voice memo — I'll listen.",
      maxTokens: 100,
      emotionalDirective,
    });
    await sendMessage(chatId, msg1);
    return;
  }
  if (raw === "caregiver") {
    // Same guard for the caregiver flow — if the name is already known, skip the
    // name question and go straight to the next step (location).
    const knownName = (session?.onboardingData?.name as string | undefined)?.trim();
    if (knownName) {
      await updateSession(phone, { onboardingStep: "caregiver_ask_location", userType: "caregiver" });
      const msgKnownCg = await generateCaraMessage({
        audience: "caregiver",
        context: `${knownName} just said they're a caregiver looking for work, and you already know their name is ${knownName}. ` +
          `You ALREADY introduced yourself — never say "I'm Evia" or re-introduce yourself. ` +
          `Warmly acknowledge them BY NAME — do NOT ask their name again — let them know setup takes about 5 minutes right here, ` +
          `then ask what city and zip code they're based in.`,
        fallback: `Great, ${knownName}! Setup takes about 5 minutes, all right here. What city and zip code are you based in?`,
        maxTokens: 90,
        emotionalDirective,
      });
      await sendMessage(chatId, msgKnownCg);
      return;
    }
    await updateSession(phone, { onboardingStep: "caregiver_ask_name", userType: "caregiver" });
    const msg2 = await generateCaraMessage({
      audience: "caregiver",
      context: "A new caregiver just said they're looking for work. You ALREADY introduced yourself in the previous " +
        "message — do NOT say your name or re-introduce yourself. Let them know profile setup takes about 5 minutes " +
        "and everything happens right here over text. Then ask for their name.",
      fallback: "Great — let's get your profile set up. Takes about 5 minutes and everything happens right here.\n\nWhat's your name?",
      maxTokens: 80,
      emotionalDirective,
    });
    await sendMessage(chatId, msg2);
    return;
  }
  await sendMessage(chatId,
    "Just so I point you the right way, are you looking for care for a loved one, or are you a caregiver looking for work?"
  );
}

// ── Loop-only re-dispatch (2e / 2f) ───────────────────────────────────────────
// The agent loop now owns ALL conversational collection. When a KEPT scripted
// handler (confirm-name; the resume path) finds the user jumped ahead with
// substantive info, it must NOT call a (deleted) collection handler — it hands
// the SAME turn to the loop. Absorb whatever the message contained first (mirrors
// the webhook's pre-turn net) so nothing is lost, then run one onboarding loop
// turn. Dynamic imports avoid a static import cycle with qaAgent /
// caregiverFieldAbsorber.
async function dispatchOnboardingToLoop(
  phone:   string,
  chatId:  string,
  text:    string,
  session: AgentSession,
  role:    "client" | "caregiver",
): Promise<void> {
  const existing = (session.onboardingData ?? {}) as Record<string, unknown>;
  const absorbed = role === "caregiver"
    ? await (await import("./caregiverFieldAbsorber")).absorbCaregiverFields(text, existing).catch(() => ({}))
    : await absorbClientFields(text, existing).catch(() => ({}));
  if (Object.keys(absorbed).length > 0) {
    await mergeOnboardingData(phone, absorbed);
    session.onboardingData = { ...existing, ...absorbed };
  }
  const { runQaAgent } = await import("./qaAgent");
  await runQaAgent({
    text,
    phone,
    chatId,
    userId:      (session as any).userId ?? "",
    seniorId:    (session as any).seniorId ?? "",
    userType:    role,
    zepThreadId: (session as any).zepThreadId as string | undefined,
    session:     session as unknown as Record<string, unknown>,
    onboardingMode: true,
    onboardingRole: role,
    intent:      null,
  });
  // Collection may have completed on this handed-off turn — e.g. the user
  // front-loaded every remaining field in the same message that also confirmed
  // their name. Drive the post-collection handoff so the next phase actually
  // fires; otherwise the loop's closing line ("here's your photo link" / "let me
  // show you caregivers") is a promise with nothing behind it until the user
  // happens to text again.
  await drivePostCollectionHandoff(phone, chatId, role);
}

// ── Post-collection handoff (loop-only) ───────────────────────────────────────
// Canonical "conversational collection just finished → drive the next phase"
// step, shared by the cold loop-entry paths: dispatchOnboardingToLoop (the
// confirm-name / ask_role re-dispatch) and the webhook's 2f checkpoint-resume.
// The hot webhook main-path keeps an INLINE copy of this same logic (the
// stuck-signup-net + proactive-handoff block in webhooks.ts) — keep the two in
// sync.
//
// Re-reads the session from Firestore so it sees whatever the loop (and any
// persistence net) just wrote, then:
//   1. Stuck-signup net: if the cursor is still on a collection step but every
//      required field is present, advance it to the role's first gate step (the
//      model may have collected everything without calling complete_collection).
//   2. If (and only if) the cursor now sits at that first gate step, DRIVE the
//      next phase — client → matches/paywall (continueAfterClientCollection);
//      caregiver → the scripted photo-upload gate via the "__RESUME__" sentinel,
//      pre-creating the uid-keyed caregivers doc first. Webhook-passive gates
//      never prompt on their own, so without this Evia goes silent right after
//      "that's everything I need".
// Idempotent and non-fatal: a no-op unless collection is (now) complete, and any
// handoff failure is logged, never thrown.
export async function drivePostCollectionHandoff(
  phone: string,
  chatId: string,
  role: "client" | "caregiver",
): Promise<void> {
  const after   = (await db.collection("agent_sessions").doc(phone).get()).data() ?? {};
  let   curStep = (after.onboardingStep as string) ?? "";
  const curData = (after.onboardingData ?? {}) as Record<string, unknown>;

  if (collectionStepsForRole(role).includes(curStep) && missingRequiredFields(role, curData).length === 0) {
    await db.collection("agent_sessions").doc(phone).update({ onboardingStep: firstGateStep(role) });
    curStep = firstGateStep(role);
    console.info("onboarding: stuck-signup net advanced cursor to gate", { phone, role });
  }

  if (curStep !== firstGateStep(role)) return;

  try {
    if (role === "caregiver") {
      const ensuredId = await ensureCaregiverDocForOnboarding(phone).catch((err) => {
        console.error("onboarding: caregiver doc pre-create at gate failed", err);
        return null;
      });
      const resumeSession = {
        ...(after as unknown as AgentSession),
        onboardingStep: curStep,
        onboardingData: curData,
        chatId,
      } as AgentSession;
      if (ensuredId) (resumeSession as unknown as Record<string, unknown>).caregiverId = ensuredId;
      await handleOnboardingStep(phone, chatId, "__RESUME__", resumeSession);
    } else {
      await continueAfterClientCollection(phone, chatId);
    }
  } catch (err) {
    console.error("onboarding: post-collection handoff failed", err instanceof Error ? err.message : err);
  }
}

// ── CLIENT FLOW ───────────────────────────────────────────────────────────────

// Web-onboarding entry point: the client already typed their name on /start, so it's
// pre-seeded in onboardingData.firstName and Evia opened by greeting + asking them to
// confirm it. This handler resolves that confirmation: a "yes" advances to the senior
// question; a different name is captured as a correction; a bare "no" routes back to
// the normal ask-name step. Only reached when a name rode in on the web bridge.
async function handleClientConfirmName(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const seeded = (session.onboardingData?.firstName as string | undefined) ?? "";

  // Parse the confirmation FIRST. The old order ran the question-detector
  // before parsing, so direct answers like "yes" or "Anahi is fine" were
  // misread as small talk and the name question re-asked forever.
  const kind = await parseNameConfirmation(seeded, text);

  if (kind.kind === "corrected") {
    const correctedName = kind.correctedName;
    await mergeOnboardingData(phone, { firstName: correctedName });
    await updateSession(phone, { onboardingStep: "client_ask_senior" });
    const msg = await generateCaraMessage({
      audience: "family",
      context: `Evia just corrected the client's name to ${correctedName}. Briefly acknowledge the fix, then ask who they're looking for care for (name and relationship, e.g. "my mom Dorothy").`,
      fallback: `Got it — thanks, ${correctedName}. Who are we caring for?`,
      maxTokens: 80,
    });
    await sendMessage(chatId, msg);
    return;
  }

  if (kind.kind === "denied" || !seeded) {
    // Denied without offering a name (or nothing seeded to confirm) — fall
    // back to the standard ask-name step.
    await updateSession(phone, { onboardingStep: "client_ask_name" });
    await sendMessage(chatId, "No problem — what name should I use?");
    return;
  }

  if (kind.kind === "confirmed") {
    // Confirmed — keep the seeded name and move to the senior question.
    await updateSession(phone, { onboardingStep: "client_ask_senior" });
    const msg = await generateCaraMessage({
      audience: "family",
      context: `The client confirmed their name is ${seeded}. Greet them warmly by name and ask who they're looking for care for (name and relationship, e.g. "my mom Dorothy").`,
      fallback: `Lovely to meet you, ${seeded}. Who are we caring for?`,
      maxTokens: 80,
    });
    await sendMessage(chatId, msg);
    return;
  }

  // "other" — their message wasn't about the name at all. NEVER loop on the
  // name: a question gets answered with at most ONE confirm re-ask; anything
  // else accepts the seeded name and moves the flow forward.
  const confirmQuestion = `Evia asked: "Is ${seeded} the name you go by, or do you prefer something else?"`;
  const attempts = (session.onboardingData?.confirmNameAttempts as number | undefined) ?? 0;
  if (await isQuestionOrOther(text, confirmQuestion)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    if (attempts < 1) {
      await mergeOnboardingData(phone, { confirmNameAttempts: attempts + 1 });
      await sendMessage(chatId, `So I get it right — do you go by ${seeded}?`);
      return;
    }
    // Already re-asked once — accept the seeded name and continue.
    await updateSession(phone, { onboardingStep: "client_ask_senior" });
    const msg = await generateCaraMessage({
      audience: "family",
      context: `Evia is moving on with the name ${seeded}. Ask who they're looking for care for (name and relationship, e.g. "my mom Dorothy"). One short sentence.`,
      fallback: `Now — who are we caring for?`,
      maxTokens: 80,
    });
    await sendMessage(chatId, msg);
    return;
  }
  // Substantive non-name message (e.g. they jumped ahead and described who
  // needs care). Accept the seeded name and hand this turn to the agent loop —
  // it owns collection now — so nothing they typed is lost or re-asked (2e).
  await updateSession(phone, { onboardingStep: "client_ask_senior" });
  return dispatchOnboardingToLoop(phone, chatId, text,
    { ...session, onboardingStep: "client_ask_senior" } as AgentSession, "client");
}

// Shared confirm-name classifier for both roles. Parses the user's reply to
// "is <seeded> what you go by?" into one of four shapes. Parse failures fall to
// "other", whose handling is loop-proof (the old code re-asked on failure).
async function parseNameConfirmation(
  seeded: string,
  text: string,
): Promise<{ kind: "confirmed" | "corrected" | "denied" | "other"; correctedName: string | null }> {
  const raw = await parseWithClaude(
    `Evia greeted the user by the name "${seeded}" and asked if that's the name they go by. Classify their reply. ` +
      'Reply ONLY JSON: {"kind": "confirmed" | "corrected" | "denied" | "other", "correctedName": "<first name>" or null}. ' +
      `"confirmed" — any affirmation of that name (yes, yep, correct, that's right, that's me, "${seeded || "that"} is fine", "you can call me ${seeded || "that"}"). ` +
      '"corrected" — they give a DIFFERENT name to go by (with or without a "no"); put it in correctedName. ' +
      '"denied" — no/nope/wrong WITHOUT offering another name. ' +
      '"other" — anything else: a question, or a message about something other than their name (e.g. describing care needs, work, or location).',
    text
  );
  try {
    const parsed = JSON.parse(unwrapJson(raw, "object"));
    const kind = ["confirmed", "corrected", "denied", "other"].includes(parsed.kind) ? parsed.kind : "other";
    const correctedName = typeof parsed.correctedName === "string" && parsed.correctedName.trim()
      ? parsed.correctedName.trim() : null;
    if (kind === "corrected" && !correctedName) return { kind: "denied", correctedName: null };
    return { kind, correctedName: kind === "corrected" ? correctedName : null };
  } catch {
    return { kind: "other", correctedName: null };
  }
}

// The linear client question steps, expressed as data and driven by `runStep`
// (see conversationStep.ts). Every user-visible string lives in
// onboardingSteps.client.ts, copied verbatim from the former handlers. The
// helpers each step needs are injected here so the table file stays free of an
// import cycle. (`locationPrompt` and `buildIntakeSummary` are hoisted function
// declarations, so referencing them at module-init time is safe.)
const CLIENT_STEPS = buildClientSteps({
  generateCaraMessage,
  locationPrompt,
  buildIntakeSummary,
});

// Production side effects for `runStep`: the real mid-flow helpers plus an
// ATOMIC merge+advance — one Firestore `.update()` using dotted field paths, so
// a failure can't leave a user half-advanced (the old code did two writes).
const stepDeps: StepDeps = {
  isQuestionOrOther,
  answerQuestionMidFlow,
  parseWithClaude,
  sendMessage,
  async mergeAndAdvance(phone, fields, nextStep) {
    // Dotted paths update individual onboardingData keys without overwriting
    // siblings, so this preserves everything collected on earlier steps.
    const update: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) update[`onboardingData.${k}`] = v;
    if (nextStep) update.onboardingStep = nextStep;
    await db.collection("agent_sessions").doc(phone).update(update);
  },
};

function clientStepCtx(phone: string, chatId: string, text: string, session: AgentSession): RunStepContext {
  return { phone, chatId, text, session };
}

// ── New intake steps: start date → preferences → budget → playback confirm ─────

async function handleClientAskStart(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  return runStep(CLIENT_STEPS.client_ask_start, clientStepCtx(phone, chatId, text, session), stepDeps);
}

async function handleClientAskPreferences(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  return runStep(CLIENT_STEPS.client_ask_preferences, clientStepCtx(phone, chatId, text, session), stepDeps);
}

async function handleClientAskBudget(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  // runStep advances to client_confirm_intake and sends the intake summary via
  // the step's nextQuestion (buildIntakeSummary over the merged in-memory data).
  return runStep(CLIENT_STEPS.client_ask_budget, clientStepCtx(phone, chatId, text, session), stepDeps);
}

// Plain-text playback of everything Evia captured — a confirmation gate before
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

  const pieces: string[] = [];
  // Multi-recipient household: name everyone so the family can catch a missed
  // person at the confirmation gate.
  const extraRecipients = normalizeAdditionalRecipients(d.additionalRecipients);
  const recipientLabel = extraRecipients.length
    ? [
        `${seniorName}${age ? ` (${age})` : ""}`,
        ...extraRecipients.map((r) => (r.age ? `${r.name} (${r.age})` : r.name)),
      ].join(" and ")
    : `${seniorName}${age || conditions ? ` (${[age, conditions].filter(Boolean).join(", ")})` : ""}`;
  pieces.push(`care for ${recipientLabel}${extraRecipients.length && conditions ? ` — ${conditions}` : ""}`);
  if (loc) pieces.push(`in ${loc}`);
  if (sched) pieces.push(sched);
  if (start) pieces.push(`starting ${start}`);
  if (prefBits.length) pieces.push(`preference: ${prefBits.join(", ")}`);
  if (budget) pieces.push(`budget ${budget}`);

  return `Here's what I've got: ${pieces.join("; ")}. Did I get that right? Say yes and I'll show you who can help, or tell me what to fix.`;
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
    await sendMessage(chatId, "No problem — tell me what to change and I'll fix it. If it looks right, just say yes and I'll show you who can help.");
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

  // Intake is confirmed — this family is a real lead. Create their webapp
  // account NOW (Auth user + users/{uid} seed), not at the payment webhook, so
  // even a paywall drop-off can log into the web app with phone OTP.
  if (!session.userId) {
    const uid = await ensureWebAccount(phone, "client", (d.firstName as string) ?? "");
    if (uid) (session as any).userId = uid;
  }

  let preview: Awaited<ReturnType<typeof runGetCaregiverPreviewAction>>;
  try {
    preview = await runGetCaregiverPreviewAction(
      { city, seniorName, careNeeds },
      { caller: "sms_agent", role: "client", phone, chatId },
    );
  } catch (err) {
    // A transient action failure must not wedge the turn in silence — tell the
    // family honestly and leave the session on the current step so their next
    // inbound genuinely retries this handoff (no unbacked "I'll text you" promise,
    // no stalled-work copy — voice contract R1).
    console.error("[handleClientShowCaregivers] caregiver preview failed:", err);
    await sendMessage(chatId,
      `My system hiccuped pulling up caregivers for ${seniorName} — that's on me. Text me "ready" in a minute and I'll show you the matches.`
    );
    return;
  }

  if (!preview.available) {
    // No supply at all: don't take payment for something we can't deliver.
    await updateSession(phone, { onboardingStep: "complete", awaitingSupply: true });
    await sendMessage(chatId, preview.message);
    return;
  }

  await sendMessage(chatId, preview.message);

  // Value first (real caregivers shown above), then price, THEN identity, THEN
  // payment, so a family never has to scan a government ID before they even
  // know what Evia costs. handleClientPresentPlan sets up the price.
  await updateSession(phone, { onboardingStep: "client_ask_plan" });
  await handleClientPresentPlan(phone, chatId, session);
}

// Proactive post-collection handoff for the agent loop. When the loop calls
// complete_collection it only advances the cursor to the first gate step — the
// next phase (show caregivers → paywall, or the honest no-supply hold) is
// webhook-passive and would otherwise wait for an inbound that never comes (the
// family was just told their part is done). The webhook calls this the moment
// collection completes so Evia continues in the SAME turn instead of going silent.
export async function continueAfterClientCollection(phone: string, chatId: string): Promise<void> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  if (!snap.exists) return;
  await handleClientShowCaregivers(phone, chatId, snap.data() as AgentSession);
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
  await mergeOnboardingData(phone, { selectedPlan: "Evia", selectedPlanPriceId: priceId });
  const priceLabel = await describeClientPrice(priceId);

  const msg = await generateCaraMessage({
    audience: "family",
    context:
      `Evia just showed a family real local caregivers for ${seniorName}. State the price in one warm, simple ` +
      `message: Evia is ${priceLabel || "a simple monthly membership"}, and for that Evia coordinates ` +
      `everything for ${seniorName} — scheduling, weekly summaries, and keeping the whole family in the loop. ` +
      `2-3 sentences, no bullet lists, no pressure. End by saying you are sending the quick identity-check link now.`,
    fallback:
      `Evia is ${priceLabel || "one simple monthly membership"} — I coordinate everything for ${seniorName}: ` +
      `scheduling, weekly summaries, and keeping your whole family in the loop. I'll send the quick identity-check link now so we can keep moving.`,
    emotionalDirective: (session as any)._emotionalDirective,
    maxTokens: 130,
  });
  await sendMessage(chatId, msg);

  await signalThinking(chatId, session.service);
  let identityUrl: string;
  try {
    identityUrl = await createClientIdentitySession(phone);
  } catch (err) {
    console.error("handleClientPresentPlan createClientIdentitySession error — falling back to payment:", err);
    // Identity verification was skipped (not completed) — persist that flag so
    // ops can see who bypassed the identity check, and raise an admin_alerts
    // doc so it's visible in the Control Room instead of only in logs.
    await mergeOnboardingData(phone, {
      needsIdentityVerification: true,
      identityGateSkippedAt: new Date().toISOString(),
    });
    await db.collection("admin_alerts").add({
      type:      "identity_gate_skipped",
      phone,
      error:     String(err),
      createdAt: new Date().toISOString(),
      resolved:  false,
      severity:  "high",
    }).catch(() => {});
    await updateSession(phone, { onboardingStep: "client_send_payment" });
    await handleClientSendPayment(phone, chatId, session);
    return;
  }
  await sendMessage(chatId, "Start here with the quick identity check. It usually takes about 30 seconds:");
  await sendMessage(chatId, { parts: [{ type: "link", value: identityUrl }] });
  await updateSession(phone, { onboardingStep: "client_awaiting_identity" });
}

async function handleClientPlanReply(
  phone: string,
  chatId: string,
  text:   string,
  session: AgentSession
): Promise<void> {
  // Mid-flow question (e.g. "is it monthly?") — answer, then re-offer.
  if (await isQuestionOrOther(text, "Are you ready to go ahead with setup? (a yes gets the setup link)")) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "When you're ready, say yes and I'll send the setup link again.");
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
      "if you ever want them. If you want to keep going, say yes and I'll send the setup link again."
    );
    return;
  }
  if (intent !== "confirm") {
    await sendMessage(chatId, "When you're ready, say yes and I'll get you connected with caregivers — happy to answer anything first.");
    return;
  }

  // Confirmed → ensure a price is stored, then send the identity link.
  const d = session.onboardingData ?? {};
  let priceId = (d.selectedPlanPriceId as string) ?? "";
  if (!priceId) {
    priceId = resolveClientPriceId();
    await mergeOnboardingData(phone, { selectedPlan: "Evia", selectedPlanPriceId: priceId });
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
    // Stripe checkout failed — the app-URL fallback below still goes out (the
    // transport delivers it inline as text, not a blank card), but a failure
    // at the PAYMENT step is a conversion-killer: page ops instead of only
    // console-logging into the void.
    console.error("handleClientSendPayment stripe error:", err);
    await db.collection("admin_alerts").add({
      type:      "stripe_checkout_create_failed",
      phone,
      task:      "client_payment_setup",
      error:     err instanceof Error ? err.message : String(err),
      severity:  "high",
      resolved:  false,
      createdAt: new Date().toISOString(),
    }).catch(() => {});
  }

  await updateSession(phone, { onboardingStep: "client_awaiting_payment" });
  const msg7 = await generateCaraMessage({
    audience: "family",
    context: `Evia has collected everything needed to start finding caregivers for ${d.seniorName ?? "a loved one"}. Let the family know warmly, then tell them the last step is to start their membership so Evia can begin coordinating care, and that it takes about 30 seconds.`,
    fallback: `Perfect — I have everything I need to start finding caregivers for ${d.seniorName ?? "your loved one"}.\n\nLast step: start your membership so I can begin coordinating care.\nTakes about 30 seconds:`,
    maxTokens: 100,
  });
  await sendMessage(chatId, msg7);
  await sendMessage(chatId, { parts: [{ type: "link", value: checkoutUrl }] });
  await sendMessage(chatId, await generateCaraMessage({
    audience: "family",
    language: session.preferredLanguage === "es" ? "es" : "en",
    context: "You just sent the family their payment setup link. Warmly reassure them that you'll start searching for caregivers while they set that up. One short line.",
    fallback: "I'll start searching while you set that up.",
    maxTokens: 60,
  }));
}

// ── CAREGIVER FLOW ────────────────────────────────────────────────────────────

// Caregiver counterpart to handleClientConfirmName. The caregiver typed their name on
// /start (seeded in onboardingData.name); Evia greeted + asked to confirm. A "yes"
// advances to the location question; a different name is a correction; a bare "no"
// routes back to the standard ask-name step. Only reached when a name rode in on the bridge.
async function handleCaregiverConfirmName(phone: string, chatId: string, text: string, session?: AgentSession, service?: string): Promise<void> {
  const sess = session ?? ({ onboardingData: {} } as AgentSession);
  const seeded = (sess.onboardingData?.name as string | undefined) ?? "";

  // Parse the confirmation FIRST — same ordering fix as handleClientConfirmName.
  const kind = await parseNameConfirmation(seeded, text);

  if (kind.kind === "corrected") {
    const correctedName = kind.correctedName;
    await mergeOnboardingData(phone, { name: correctedName });
    await updateSession(phone, { onboardingStep: "caregiver_ask_location" });
    const msg = await generateCaraMessage({
      audience: "caregiver",
      context: `Evia just corrected the caregiver's name to ${correctedName}. Briefly acknowledge the fix, then ask what city and zip code they work in.`,
      fallback: `Got it — thanks, ${correctedName}. What city and zip code do you work in?`,
      maxTokens: 80,
    });
    await sendMessage(chatId, locationPrompt(msg, service));
    return;
  }

  if (kind.kind === "denied" || !seeded) {
    await updateSession(phone, { onboardingStep: "caregiver_ask_name" });
    await sendMessage(chatId, "No problem — what name should I use?");
    return;
  }

  if (kind.kind === "confirmed") {
    await updateSession(phone, { onboardingStep: "caregiver_ask_location" });
    const msg = await generateCaraMessage({
      audience: "caregiver",
      context: `The caregiver confirmed their name is ${seeded}. Greet them by name and ask what city and zip code they work in.`,
      fallback: `Great to meet you, ${seeded}. What city and zip code do you work in?`,
      maxTokens: 80,
    });
    await sendMessage(chatId, locationPrompt(msg, service));
    return;
  }

  // "other" — not about the name. NEVER loop on the name: a question gets
  // answered with at most ONE confirm re-ask; anything else accepts the
  // seeded name and moves the flow forward.
  const confirmQuestion = `Evia asked: "Is ${seeded} the name you go by, or do you prefer something else?"`;
  const attempts = (sess.onboardingData?.confirmNameAttempts as number | undefined) ?? 0;
  if (await isQuestionOrOther(text, confirmQuestion)) {
    const answer = await answerQuestionMidFlow(text, sess);
    await sendMessage(chatId, answer);
    if (attempts < 1) {
      await mergeOnboardingData(phone, { confirmNameAttempts: attempts + 1 });
      await sendMessage(chatId, `So I get it right — do you go by ${seeded}?`);
      return;
    }
    // Already re-asked once — accept the seeded name and continue.
    await updateSession(phone, { onboardingStep: "caregiver_ask_location" });
    const msg = await generateCaraMessage({
      audience: "caregiver",
      context: `Evia is moving on with the name ${seeded}. Ask what city and zip code they work in. One short sentence.`,
      fallback: `Now — what city and zip code do you work in?`,
      maxTokens: 80,
    });
    await sendMessage(chatId, locationPrompt(msg, service));
    return;
  }
  // Substantive non-name message (e.g. they jumped ahead with the work they
  // want or the areas they cover). Accept the seeded name and hand this turn to
  // the agent loop — it owns collection now — so nothing is lost or re-asked (2e).
  await updateSession(phone, { onboardingStep: "caregiver_ask_location" });
  return dispatchOnboardingToLoop(phone, chatId, text,
    { ...sess, onboardingStep: "caregiver_ask_location" } as AgentSession, "caregiver");
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

// Called immediately after doc upload — ask before building the checkout so MVR can be bundled
async function handleCaregiverAskMvr(phone: string, chatId: string, textOrSession: string | AgentSession, session?: AgentSession): Promise<void> {
  // When called as a switch case, textOrSession is the user's reply text
  // When called programmatically (no reply yet), textOrSession is the session object
  if (typeof textOrSession !== "string") {
    // First visit — ask the question
    await updateSession(phone, { onboardingStep: "caregiver_ask_mvr" });
    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: textOrSession.preferredLanguage === "es" ? "es" : "en",
      context:
        "Mid-signup, ask the caregiver whether they ever drive clients to appointments or errands. " +
        "If they do, there's an optional Motor Vehicle Record check they can bundle with their membership — it puts a verified-driver badge on their profile that families who need a driver look for. " +
        "Weave the choice in naturally, like a person would ('want me to add it? totally fine to leave it off') — do NOT write a stiff 'Reply YES or NO' instruction. Do NOT include any URL or price.",
      fallback:
        "Do you ever drive clients to appointments or errands? If so, I can add a Motor Vehicle Record check to your membership — it gives you a verified-driver badge families look for. Want me to add it, or leave it off?",
      maxTokens: 120,
    }));
    return;
  }

  // User has replied — classify the answer with the LLM (the ask is phrased
  // naturally, so replies are free-form: "yeah sure", "nah I don't drive",
  // "how much is it?"). Strict YES/NO stays as a zero-latency fast path.
  const raw  = (textOrSession as string).trim();
  const norm = raw.toUpperCase();
  let verdict: "yes" | "no" | "question" | "unclear";
  if (norm === "YES" || norm === "Y") verdict = "yes";
  else if (norm === "NO" || norm === "N") verdict = "no";
  else {
    const parsed = await parseWithClaude(
      "The caregiver was just asked whether they want an optional Motor Vehicle Record (driving) check added to their profile. " +
      "Clear agreement (\"yes\", \"sure\", \"yeah add it\", \"sounds good\", \"I do drive so yes\") → yes. " +
      "Clear decline (\"no\", \"nah\", \"skip\", \"not now\", \"I don't drive\") → no. " +
      "They asked a question (what it costs, what it is, how long it takes) → question. " +
      "Anything else or ambiguous → unclear. Reply with exactly one word: yes, no, question, or unclear.",
      raw
    );
    const v = (parsed ?? "").trim().toLowerCase();
    verdict = v === "yes" || v === "no" || v === "question" ? (v as "yes" | "no" | "question") : "unclear";
  }

  if (verdict === "question") {
    await sendMessage(chatId, await answerQuestionMidFlow(raw, session!));
    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: session?.preferredLanguage === "es" ? "es" : "en",
      context: "You just answered the caregiver's question about the optional driving-record check. In ONE short, natural line ask whether they'd like it added or left off.",
      fallback: "So — want me to add the driving check, or leave it off for now?",
      maxTokens: 50,
    }));
    return; // stay at caregiver_ask_mvr for their answer
  }

  if (verdict === "unclear") {
    const attempts = (((session?.onboardingData ?? {}).mvrAskAttempts as number | undefined) ?? 0);
    if (attempts < 1) {
      await mergeOnboardingData(phone, { mvrAskAttempts: attempts + 1 });
      await sendMessage(chatId, await generateCaraMessage({
        audience: "caregiver",
        language: session?.preferredLanguage === "es" ? "es" : "en",
        context: "The caregiver's reply didn't clearly say whether they want the optional driving-record check. In ONE warm line, ask again simply — add it or leave it off.",
        fallback: "No rush — should I add the driving check to your profile, or leave it off for now?",
        maxTokens: 60,
      }));
      return;
    }
    // Second unclear reply — don't loop. Default to no, say so gracefully, move on.
    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: session?.preferredLanguage === "es" ? "es" : "en",
      context: "You couldn't get a clear answer on the optional driving check, so you're leaving it off — tell them warmly it's off for now and they can add it any time later, then move on.",
      fallback: "I'll leave the driving check off for now — you can add it anytime by texting me. Moving on!",
      maxTokens: 60,
    }));
    verdict = "no";
  }

  await mergeOnboardingData(phone, { wantsMvr: verdict === "yes" });
  await updateSession(phone, { onboardingStep: "caregiver_send_membership" });
  await handleCaregiverSendMembership(phone, chatId, session!);
}

async function handleCaregiverSendMembership(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const d       = session.onboardingData ?? {};
  const wantsMvr = (d.wantsMvr as boolean | undefined) ?? false;
  const token   = generateToken({ phone, task: "caregiver_membership" });
  let checkoutUrl = `${APP_URL}/done?task=caregiver_membership&t=${token}`;

  // MVR is charged only when it can BOTH be charged (price) AND run (bundled
  // package) — and `includeMVR` is derived from THIS, never from wantsMvr alone.
  // Old bug: includeMVR was set from wantsMvr regardless of whether the line item
  // was added, so a missing price flagged mvrPaid downstream with no charge.
  const mvrCharged = wantsMvr && canChargeBundledMvr();
  if (wantsMvr && !mvrCharged) {
    console.error("Caregiver opted into MVR but it is not configured (price/package); proceeding membership-only.");
    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: session.preferredLanguage === "es" ? "es" : "en",
      context: "The caregiver asked to include the optional driving-record MVR add-on, but it is not configured. Warmly explain that Evia will continue with the standard background check and the team can follow up about adding the driving check later.",
      fallback: "Heads up � I couldn't add the driving-record check to your membership right now, so I'm setting you up with the standard background check. Our team can follow up if you'd like to add it later.",
      maxTokens: 90,
    }));
    await db.collection("admin_alerts").add({
      type:      "mvr_signup_misconfigured",
      phone,
      createdAt: new Date().toISOString(),
      resolved:  false,
      severity:  "high",
    }).catch(() => {});
  }

  await signalThinking(chatId, session.service);
  try {
    const membershipPriceId = process.env.STRIPE_CAREGIVER_ANNUAL_PRICE_ID ?? process.env.STRIPE_CAREGIVER_ANNUAL ?? process.env.VITE_STRIPE_CAREGIVER_ANNUAL ?? "";

    if (membershipPriceId) {
      const lineItems: { price: string; quantity: number }[] = [
        { price: membershipPriceId, quantity: 1 },
      ];
      if (mvrCharged) {
        lineItems.push({ price: mvrPriceId(), quantity: 1 });
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
        metadata:             { phone, task: "caregiver_membership", includeMVR: mvrCharged ? "true" : "false" },
        subscription_data:    { metadata: { phone, kind: "caregiver_membership" } },
      });
      checkoutUrl = stripeSession.url ?? checkoutUrl;
    }
  } catch (err) {
    // Same class as handleClientSendPayment: the fallback URL still goes out
    // (inline text via the transport's card-safety rule), but ops must know a
    // membership checkout failed to build.
    console.error("handleCaregiverSendMembership stripe error:", err);
    await db.collection("admin_alerts").add({
      type:      "stripe_checkout_create_failed",
      phone,
      task:      "caregiver_membership",
      error:     err instanceof Error ? err.message : String(err),
      severity:  "high",
      resolved:  false,
      createdAt: new Date().toISOString(),
    }).catch(() => {});
  }

  // Re-cite the live local demand the caregiver saw at the location step — fresh
  // at the moment of payment — so the ask is anchored to concrete, current jobs
  // rather than a generic "jobs near you". Honest if supply has since dried up.
  const city = (d.city as string | undefined) ?? "";
  const { count: openJobCount } = await getLocalJobTeaser(city);

  // Store URL on session so we can resend it
  await updateSession(phone, {
    onboardingStep:        "caregiver_awaiting_membership",
    membershipCheckoutUrl: checkoutUrl,
  });
  await sendMessage(chatId, await generateCaraMessage({
    audience: "caregiver",
    language: session.preferredLanguage === "es" ? "es" : "en",
    context:
      "The caregiver's profile is done — the last stretch is activating their membership. Facts you MUST convey, woven in naturally (not as a list): " +
      "it's $66.49/year, it unlocks applying to jobs, getting booked, and Evia's scheduling + payout tools" +
      (mvrCharged ? ", and their order also includes the driving-record (MVR) check they asked for" : "") +
      (openJobCount > 0
        ? `. Anchor it to the real demand: there ${openJobCount === 1 ? "is" : "are"} currently ${openJobCount} open care ${openJobCount === 1 ? "job" : "jobs"} near ${city} waiting`
        : "") +
      ". End leading into the activation link you're sending right after this message. Do NOT include any URL.",
    fallback:
      `${openJobCount > 0 ? `The ${openJobCount} open care ${openJobCount === 1 ? "job" : "jobs"} near ${city} ${openJobCount === 1 ? "is" : "are"} still waiting — ` : ""}you're almost ready to apply! ` +
      `Activate your membership ($66.49/year) to unlock applying to jobs near you, getting booked, and my scheduling + payout tools.` +
      `${mvrCharged ? " Your order includes the membership + MVR driver check." : ""} Tap to activate:`,
    maxTokens: 140,
  }));
  await sendMessage(chatId, { parts: [{ type: "link", value: checkoutUrl }] });
}

async function handleCaregiverResendMembership(phone: string, chatId: string, session: AgentSession, text?: string): Promise<void> {
  // If the caregiver replied with a question while waiting on Stripe, answer it
  // before resending the link.
  if (text && await isQuestionOrOther(text, "Finish your membership payment via the link Evia sent.")) {
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

// ── Add-MVR-later (standalone "Approved Driver" upgrade over SMS) ─────────────
// Bespoke handler (NOT a data-driven ConversationStep) because it creates a
// one-time Stripe payment and triggers a side effect — mirrors
// handleCaregiverSendMembership. On payment the webhook (task: 'mvr_payment')
// initiates an MVR-only Checkr check whose result only affects the driver badge.
async function handleCaregiverSendMvr(phone: string, chatId: string, session: AgentSession): Promise<void> {
  // Only offer when the add-on can be both charged and run, so a caregiver is
  // never charged for an MVR that can't actually run (and vice versa).
  if (!canChargeStandaloneMvr()) {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: session.preferredLanguage === "es" ? "es" : "en",
      context: "The optional Approved Driver (Motor Vehicle Record) add-on can't be run right now. Warmly apologize, let them know it's temporarily unavailable, and that you've flagged it to your team.",
      fallback: "Sorry — the Approved Driver add-on isn't available right now. I've let our team know.",
      maxTokens: 70,
    }));
    await db.collection("admin_alerts").add({
      type: "mvr_addon_unavailable", phone, createdAt: new Date().toISOString(), resolved: false, severity: "medium",
    }).catch(() => {});
    return;
  }

  const token = generateToken({ phone, task: "mvr_payment" });
  let checkoutUrl = `${APP_URL}/done?task=mvr_payment&t=${token}`;
  await signalThinking(chatId, session.service);
  try {
    const stripeSession = await getStripe().checkout.sessions.create({
      mode:                "payment", // one-time, separate from the membership subscription
      line_items:          [{ price: mvrPriceId(), quantity: 1 }],
      success_url:         `${APP_URL}/done?task=mvr_payment&t=${token}`,
      cancel_url:          `${APP_URL}/start`,
      metadata:            { phone, task: "mvr_payment" },
      payment_intent_data: { metadata: { phone, task: "mvr_payment" } },
    });
    checkoutUrl = stripeSession.url ?? checkoutUrl;
  } catch (err) {
    console.error("handleCaregiverSendMvr stripe error:", err);
    await db.collection("admin_alerts").add({
      type:      "stripe_checkout_create_failed",
      phone,
      task:      "mvr_payment",
      error:     err instanceof Error ? err.message : String(err),
      severity:  "high",
      resolved:  false,
      createdAt: new Date().toISOString(),
    }).catch(() => {});
  }

  // Save the prior step — an already-onboarded caregiver returns to it after payment.
  await updateSession(phone, {
    onboardingStep: "caregiver_awaiting_mvr",
    mvrCheckoutUrl: checkoutUrl,
    mvrPriorStep:   session.onboardingStep ?? null,
  });
  await sendMessage(chatId, await generateCaraMessage({
    audience: "caregiver",
    language: session.preferredLanguage === "es" ? "es" : "en",
    context:
      "The caregiver wants the Approved Driver add-on. Naturally explain: it adds a Motor Vehicle Record (driving) check to their profile, families who need a driver see a verified-driver badge, it's a one-time add-on, and it doesn't change their annual membership. The payment link comes right below. Do NOT include any URL.",
    fallback: "Becoming an Approved Driver adds a Motor Vehicle Record check to your profile — families who need a driver see your verified-driver badge. One-time add-on, doesn't change your membership. Tap to add it:",
    maxTokens: 110,
  }));
  await sendMessage(chatId, { parts: [{ type: "link", value: checkoutUrl }] });
}

async function handleCaregiverResendMvr(phone: string, chatId: string, session: AgentSession, text?: string): Promise<void> {
  if (text && await isQuestionOrOther(text, "Add your Approved Driver check via the link Evia sent.")) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
  }
  const url = (session as any).mvrCheckoutUrl as string | undefined;
  if (url) {
    await sendMessage(chatId, "Tap the link below to add your Approved Driver check:");
    await sendMessage(chatId, { parts: [{ type: "link", value: url }] });
  } else {
    await handleCaregiverSendMvr(phone, chatId, session);
  }
}

async function handleCaregiverSendPhoto(phone: string, chatId: string, session: AgentSession): Promise<void> {
  // Collection is complete — create the caregiver's webapp account NOW (Auth
  // user + users/{uid} seed) instead of waiting for the bg-check/Stripe gates,
  // so a caregiver who stalls at uploads can still log into the web app.
  if (!session.userId) {
    const uid = await ensureWebAccount(phone, "caregiver", ((session.onboardingData ?? {}).name as string) ?? "");
    if (uid) (session as any).userId = uid;
  }

  const token   = generateToken({ phone, task: "photo_upload" });
  const photoUrl = `${APP_URL}/upload/photo?t=${token}`;

  await updateSession(phone, { onboardingStep: "caregiver_awaiting_photo" });
  const d = session.onboardingData ?? {};
  const firstName = (((d.name ?? "") as string).split(" ")[0]) || "";
  const ask = await generateCaraMessage({
    audience: "caregiver",
    language: session.preferredLanguage === "es" ? "es" : "en",
    context:
      `The caregiver${firstName ? ` (first name ${firstName})` : ""} just finished sharing their background and experience — their profile is coming together. ` +
      "Naturally ask them to add a profile photo next: families want to see who they're trusting, and a clear friendly headshot makes a real difference in getting booked. " +
      "Tell them you're dropping the upload link right below. Do NOT include any URL — the link is appended after your text.",
    fallback:
      `Almost there${firstName ? `, ${firstName}` : ""}! One more thing — families want to see who they're trusting, and a clear friendly headshot makes a big difference. Tap here to add your photo:`,
    maxTokens: 110,
  });
  // Send the upload URL INLINE as plain text (one structured text part), NOT as a
  // standalone `link` part. A link part renders as a rich preview CARD that needs
  // fetchable OG metadata; the token-gated /upload/photo page has none (unlike the
  // /p/ profile links, which got a dedicated OG rewrite, and Stripe checkout URLs,
  // which carry their own), so the card arrived BLANK — "message arrives but no
  // link". A plain-text https URL is tappable on both iMessage and SMS regardless
  // of OG, and a structured text part bypasses sendMessage's URL→link-card splitter
  // (only plain-string sends are split). The JWT token is base64url with dots, so
  // redactPii (SSN/card/email formats) never mangles it.
  await sendMessage(chatId, { parts: [{ type: "text", value: `${ask}\n${photoUrl}` }] });
}

async function handleCaregiverSendDocuments(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const token  = generateToken({ phone, task: "doc_upload" });
  const docUrl = `${APP_URL}/upload/document?t=${token}`;

  await updateSession(phone, { onboardingStep: "caregiver_awaiting_documents" });
  const ask = await generateCaraMessage({
    audience: "caregiver",
    language: session.preferredLanguage === "es" ? "es" : "en",
    context:
      "The caregiver just added their profile photo. Next, ask naturally whether they have any certifications — CNA license, CPR card, anything like that — because certs make their profile stand out to families. " +
      "Tell them you're dropping an upload link right below this message, and weave in naturally that it's totally fine if they don't have any — they can just say so and you'll move on. " +
      "Do NOT write a stiff 'reply SKIP' instruction, do NOT include any URL — the link is appended after your text.",
    fallback:
      "Nice — photo's in! Do you have any certifications, like a CNA license or CPR card? They really make your profile stand out. Here's an upload link — and if you don't have any, just say so and we'll keep moving:",
    maxTokens: 120,
  });
  // Inline URL as text, same reason as the photo gate: the token-gated
  // /upload/document page has no OG metadata, so a link-part card renders blank.
  await sendMessage(chatId, { parts: [{ type: "text", value: `${ask}\n${docUrl}` }] });
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
  // Re-send path (resendStuckStep / repeat webhook): if we already minted a
  // Checkr invitation for this caregiver, resend THAT link instead of POSTing a
  // new /v1/invitations — a second candidate would split webhook state (the
  // pre-created caregiver doc tracks only the FIRST checkrCandidateId) and can
  // double-bill. Guard on caregiverId too (means the pre-create + candidate
  // tracking succeeded); if the first attempt failed entirely, fall through to a
  // fresh POST — that's the retry working as designed.
  // TODO expiry: Checkr invitations expire (~7 days). If a reuse is stale, this
  // will resend a dead link; a future pass can fall through to a fresh POST past
  // ~6 days and overwrite bgcheckInviteUrl + backgroundCheckData.checkrCandidateId.
  const cachedUrl = (session as any).bgcheckInviteUrl as string | undefined;
  if (cachedUrl && session.caregiverId) {
    await updateSession(phone, { onboardingStep: "caregiver_awaiting_bgcheck" });
    await sendMessage(chatId, "Here's your background-check link again — takes about 5 minutes:");
    await sendMessage(chatId, { parts: [{ type: "link", value: cachedUrl }] });
    resolveCommitment(phone, "link", "link_sent").catch(() => {});
    return;
  }

  let inviteUrl: string | null = null;
  let linkError: unknown = null;
  await signalThinking(chatId, session.service);
  try {
    const d = session.onboardingData ?? {};
    const nameParts = ((d.name ?? "") as string).split(" ");

    // Use MVR package if caregiver paid for it; flag is set on session by stripe.ts webhook
    const mvrPaid      = (session as any).mvrPaid === true;
    const checkrPkg    = mvrPaid
      ? (process.env.CHECKR_PACKAGE_MVR || "checkrdirect_essential_criminal")
      : (process.env.CHECKR_PACKAGE     || "checkrdirect_essential_criminal");

    // Candidate-first (Checkr's contract): POST /candidates with the email
    // collected at caregiver_ask_email, THEN /invitations with candidate_id.
    // An invitation without a candidate_id is rejected — this malformed call
    // was the launch-blocking "can't generate your background check link" bug.
    const inv = await guardSideEffect(
      "checkr.invitation.create",
      () => createCheckrInvitation({
        firstName:   nameParts[0] ?? "",
        lastName:    nameParts.slice(1).join(" "),
        email:       (d.email ?? "") as string,
        zipCode:     (d.zipCode || undefined) as string | undefined,
        workState:   CHECKR_WORK_STATE,
        workCity:    (d.city || undefined) as string | undefined,
        packageSlug: checkrPkg,
      }),
      { invitationUrl: "https://dryrun.local/checkr", candidateId: "cand_dryrun" },
    );
    inviteUrl = inv.invitationUrl;
    // Cache the real Checkr link so a later "send me the link" request resends
    // THIS invitation instead of minting a duplicate (see sendOnboardingLink).
    await updateSession(phone, { bgcheckInviteUrl: inviteUrl });

    // Pre-create the caregivers doc so the Checkr webhook can find this caregiver
    // by checkrCandidateId when the report comes back. Keyed by the Firebase Auth
    // uid so Evia writes land where the web reads (uid-keyed caregivers/{uid}).
    const candidateId = inv.candidateId as string | undefined;
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
    } else if (candidateId && session.caregiverId) {
      // Fresh invitation for an already pre-created doc (restart cleared the
      // cache, invitation.expired deleted it, or the doc was created at the
      // gate handoff with status "onboarding"): re-point the doc at the NEW
      // candidate so the Checkr webhook — which matches on checkrCandidateId —
      // follows the invitation the caregiver will actually complete. Mirrors
      // sendBgCheckRenewalLink's idiom. Also move status to "pending_review"
      // (the value this step has always stamped): matchingAgent treats it as
      // matchable-with-pending-check, unlike the gate-created "onboarding".
      await db.collection("caregivers").doc(session.caregiverId).update({
        "status":                                "pending_review",
        "backgroundCheckData.checkrCandidateId": candidateId,
        "backgroundCheckData.status":            "pending",
        "backgroundCheckData.submittedAt":       new Date().toISOString(),
        "backgroundCheckData.mvrIncluded":       mvrPaid,
      }).catch(() => {});
    }
  } catch (err) {
    linkError = err;
    console.error("Checkr invitation error:", err);
  }

  await updateSession(phone, { onboardingStep: "caregiver_awaiting_bgcheck" });
  if (!inviteUrl) {
    await alertOnboardingLinkFailure(phone, "caregiver_send_bgcheck", linkError ?? "missing Checkr invitation URL");
    await sendOnboardingLinkFailureMessage(phone, chatId, session, "background-check");
    return;
  }
  await sendMessage(chatId, await generateCaraMessage({
    audience: "caregiver",
    language: session.preferredLanguage === "es" ? "es" : "en",
    context:
      "The caregiver just paid their membership — they're nearly done. Naturally let them know the last big step is the background check every caregiver completes (it's what lets families trust the platform), it usually takes about 5 minutes, and the link is coming right below. Do NOT include any URL.",
    fallback: "Almost done! Last big step: the background check every caregiver completes — usually about 5 minutes. Tap to get started:",
    maxTokens: 100,
  }));
  await sendMessage(chatId, { parts: [{ type: "link", value: inviteUrl }] });
  resolveCommitment(phone, "link", "link_sent").catch(() => {});
  await sendMessage(chatId, await generateCaraMessage({
    audience: "caregiver",
    language: session.preferredLanguage === "es" ? "es" : "en",
    context: "You just sent the caregiver their background-check link. Warmly reassure them you'll text them when the results come in, usually within 1–3 days. One short line.",
    fallback: "I'll text you when results come in (usually 1–3 days).",
    maxTokens: 60,
  }));
}

// Re-issue a Checkr background-check link for an already-onboarded caregiver whose
// check expired / is expiring (they replied "RENEW" to the expiry nudge). Mirrors the
// onboarding invitation logic but updates the EXISTING caregiver doc instead of creating one.
export async function sendBgCheckRenewalLink(phone: string, chatId: string, session: AgentSession): Promise<void> {
  let inviteUrl: string | null = null;
  let linkError: unknown = null;
  try {
    // Resolve name/email/candidate: prefer the caregivers doc, fall back to session.
    let firstName = "";
    let lastName  = "";
    let docEmail: string | undefined;
    let existingCandidateId: string | undefined;
    const caregiverId = session.caregiverId;
    if (caregiverId) {
      const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
      const cg = cgSnap.data() ?? {};
      const parts = ((cg.name ?? "") as string).split(" ");
      firstName = parts[0] ?? "";
      lastName  = parts.slice(1).join(" ");
      docEmail  = (cg.email || undefined) as string | undefined;
      existingCandidateId = cg.backgroundCheckData?.checkrCandidateId as string | undefined;
    }
    const d = session.onboardingData ?? {};
    if (!firstName) {
      const parts = ((d.name ?? "") as string).split(" ");
      firstName = parts[0] ?? "";
      lastName  = parts.slice(1).join(" ");
    }

    const checkrPkg = process.env.CHECKR_PACKAGE || "checkrdirect_essential_criminal";
    // Renewal: reuse the existing Checkr candidate when we have one (mirrors the
    // web renewal path) — a fresh candidate would orphan the caregiver's history.
    // Candidate-first otherwise; email required for candidate creation.
    const inv = await guardSideEffect(
      "checkr.invitation.create",
      () => createCheckrInvitation({
        firstName,
        lastName,
        email:       docEmail ?? ((d.email ?? "") as string),
        candidateId: existingCandidateId,
        workState:   CHECKR_WORK_STATE,
        packageSlug: checkrPkg,
        ...(caregiverId ? { customId: caregiverId } : {}),
      }),
      { invitationUrl: "https://dryrun.local/checkr", candidateId: "cand_dryrun" },
    );
    inviteUrl = inv.invitationUrl;
    await updateSession(phone, { bgcheckInviteUrl: inviteUrl });

    const candidateId = inv.candidateId as string | undefined;
    if (caregiverId) {
      await db.collection("caregivers").doc(caregiverId).update({
        "backgroundCheckData.checkrCandidateId": candidateId ?? null,
        "backgroundCheckData.status":            "pending",
        "backgroundCheckData.submittedAt":       new Date().toISOString(),
      }).catch(() => {});
    }
  } catch (err) {
    linkError = err;
    console.error("[sendBgCheckRenewalLink] Checkr invitation error:", err);
  }

  if (!inviteUrl) {
    await alertOnboardingLinkFailure(phone, "background_check_renewal", linkError ?? "missing Checkr renewal invitation URL");
    await sendOnboardingLinkFailureMessage(phone, chatId, session, "background-check renewal");
    return;
  }

  await sendMessage(chatId, "Here's your background check renewal link - usually about 5 minutes:");
  await sendMessage(chatId, { parts: [{ type: "link", value: inviteUrl }] });
  resolveCommitment(phone, "link", "link_sent").catch(() => {});
  await sendMessage(chatId, "I'll text you the moment results come in (usually 1–3 days). Bookings stay paused until it clears.");
}

async function handleCaregiverSendStripeConnect(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const token = generateToken({ phone, task: "stripe_connect" });
  let connectUrl: string | null = null;
  let linkError: unknown = null;

  await signalThinking(chatId, session.service);
  try {
    const d = session.onboardingData ?? {};
    // Reuse a previously created Express account — this handler is re-entered by
    // resendStuckStep and repeat bg-check webhooks, and each accounts.create call
    // would otherwise orphan the prior account (same reuse rule as
    // sendOnboardingLink's caregiver_payouts branch).
    let accountId = d.stripeAccountId as string | undefined;
    if (!accountId) {
      const account = await getStripe().accounts.create({
        type:    "express",
        country: "US",
        email:   (d.email ?? "") as string,
        metadata: { phone, caregiverName: (d.name ?? "") as string },
      });
      accountId = account.id;
      await mergeOnboardingData(phone, { stripeAccountId: accountId });
    }

    // Mirror the Express account id onto the caregiver doc so the Connect
    // webhook (account.updated → charges+payouts enabled) can MATCH this
    // caregiver and finalize onboarding server-side — the browser returning to
    // /done is no longer the only activation trigger. Idempotent set+merge on a
    // doc that already exists (pre-created by handleCaregiverSendBgcheck).
    // Re-read caregiverId fresh: `session` may be a stale snapshot (this handler
    // is re-entered by resendStuckStep with a session read before the merge).
    try {
      const freshSnap = await db.collection("agent_sessions").doc(phone).get();
      const caregiverId = (freshSnap.data() as AgentSession | undefined)?.caregiverId ?? session.caregiverId;
      if (caregiverId) {
        await guardSideEffect(
          "firestore.set:caregivers.stripeAccountId",
          async () => {
            await db.collection("caregivers").doc(caregiverId)
              .set({ stripeAccountId: accountId, phone }, { merge: true });
          },
          undefined,
          { phone },
        );
      }
    } catch (mergeErr) {
      console.error("stripeAccountId merge onto caregiver doc failed (non-fatal):", mergeErr);
    }

    const link = await getStripe().accountLinks.create({
      account:     accountId,
      type:        "account_onboarding",
      return_url:  `${APP_URL}/done?task=stripe_connect&t=${token}`,
      refresh_url: `${APP_URL}/done?task=stripe_connect&t=${token}`,
    });
    connectUrl = link.url;
  } catch (err) {
    linkError = err;
    console.error("Stripe Connect error:", err);
  }

  await updateSession(phone, { onboardingStep: "caregiver_awaiting_stripe" });
  if (!connectUrl) {
    await alertOnboardingLinkFailure(phone, "caregiver_send_stripe_connect", linkError ?? "missing Stripe Connect account link");
    await sendOnboardingLinkFailureMessage(phone, chatId, session, "payout setup");
    return;
  }
  await sendMessage(chatId, await generateCaraMessage({
    audience: "caregiver",
    language: session.preferredLanguage === "es" ? "es" : "en",
    context:
      "The caregiver's background check just cleared — this is the very last step of signup. Naturally tell them to set up their payout account via the link below so they get paid after every visit. Keep it celebratory but brief. Do NOT include any URL.",
    fallback: "Last step — set up your payout account so you can get paid after every visit:",
    maxTokens: 90,
  }));
  await sendMessage(chatId, { parts: [{ type: "link", value: connectUrl }] });
  resolveCommitment(phone, "link", "link_sent").catch(() => {});
}

// ── On-demand onboarding link (re)send ────────────────────────────────────────
// Called by the QA agent's `send_onboarding_link` MCP tool so Evia can fulfil
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
        // includeMVR derived from the actual charge, not wantsMvr — see handleCaregiverSendMembership.
        const mvrCharged = wantsMvr && canChargeBundledMvr();
        const lineItems: { price: string; quantity: number }[] = [{ price: membershipPriceId, quantity: 1 }];
        if (mvrCharged) lineItems.push({ price: mvrPriceId(), quantity: 1 });
        const stripeSession = await getStripe().checkout.sessions.create({
          mode:                 "subscription",
          payment_method_types: ["card"],
          line_items:           lineItems,
          success_url:          `${APP_URL}/done?task=caregiver_membership&t=${token}`,
          cancel_url:           `${APP_URL}/start`,
          metadata:             { phone, task: "caregiver_membership", includeMVR: mvrCharged ? "true" : "false" },
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
      const nameParts = ((d.name ?? "") as string).split(" ");
      const mvrPaid   = (session.mvrPaid as boolean | undefined) === true;
      const checkrPkg = mvrPaid
        ? (process.env.CHECKR_PACKAGE_MVR || "checkrdirect_essential_criminal")
        : (process.env.CHECKR_PACKAGE     || "checkrdirect_essential_criminal");
      // Candidate-first (Checkr's contract) — same shape as
      // handleCaregiverSendBgcheck; see the comment there.
      let inv: { invitationUrl: string; candidateId: string };
      try {
        inv = await guardSideEffect(
          "checkr.invitation.create",
          () => createCheckrInvitation({
            firstName:   nameParts[0] ?? "",
            lastName:    nameParts.slice(1).join(" "),
            email:       (d.email ?? "") as string,
            zipCode:     (d.zipCode || undefined) as string | undefined,
            workState:   CHECKR_WORK_STATE,
            workCity:    (d.city || undefined) as string | undefined,
            packageSlug: checkrPkg,
          }),
          { invitationUrl: "https://dryrun.local/checkr", candidateId: "cand_dryrun" },
        );
      } catch (err) {
        await alertOnboardingLinkFailure(phone, "send_onboarding_link_background_check", err);
        await sendOnboardingLinkFailureMessage(phone, chatId, session, "background-check");
        return { success: false, linkType };
      }
      url = inv.invitationUrl;
      await updateSession(phone, { bgcheckInviteUrl: url });
      // A fresh invitation means a fresh candidate — keep the caregiver doc's
      // checkrCandidateId pointing at the invitation the caregiver will actually
      // complete, or the report webhook can't match (split-state bug).
      const freshCandidateId = inv.candidateId as string | undefined;
      if (freshCandidateId && session.caregiverId) {
        await db.collection("caregivers").doc(session.caregiverId as string).update({
          "backgroundCheckData.checkrCandidateId": freshCandidateId,
          "backgroundCheckData.status":            "pending",
          "backgroundCheckData.submittedAt":       new Date().toISOString(),
          "backgroundCheckData.mvrIncluded":       mvrPaid,
        }).catch(() => {});
      }
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
      // Mirror onto the caregiver doc so the Connect webhook can match this
      // caregiver even when the link is (re)sent via the agent tool — same
      // activation-independence fix as handleCaregiverSendStripeConnect.
      // (Safe even mid-flow: advanceOnboardingStep's stripe_connect step guard
      // refuses to finalize unless the session is at the Connect step, so an
      // early payout link can't prematurely activate the caregiver.)
      if (session.caregiverId) {
        const linkCaregiverId = session.caregiverId as string;
        await guardSideEffect(
          "firestore.set:caregivers.stripeAccountId",
          async () => {
            await db.collection("caregivers").doc(linkCaregiverId)
              .set({ stripeAccountId: accountId, phone }, { merge: true })
              .catch((mergeErr) => console.error("stripeAccountId merge onto caregiver doc failed (non-fatal):", mergeErr));
          },
          undefined,
          { phone },
        );
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

  // Token-gated /upload pages have no OG metadata, so a `link` part renders as a
  // BLANK preview card (the "message arrives but no link" bug). Send those inline
  // as plain text — tappable on iMessage and SMS regardless of OG. External
  // provider URLs (Stripe checkout/Connect, Checkr) carry their own OG and render
  // as proper cards, so they stay `link` parts.
  const inlineAsText = linkType === "caregiver_photo" || linkType === "caregiver_documents";
  if (inlineAsText) {
    await sendMessage(chatId, { parts: [{ type: "text", value: `Tap to upload:\n${url}` }] });
  } else {
    await sendMessage(chatId, { parts: [{ type: "link", value: url }] });
  }
  // A link just landed in the chat — any open "I'll text you the link" promise
  // is now fulfilled (recorded by sendOnboardingLinkFailureMessage / the
  // link-promise net). Harmless no-op when none is open.
  resolveCommitment(phone, "link", "link_sent").catch(() => {});
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
            const newUser = await guardSideEffect(
              "auth.createUser",
              () => admin.auth().createUser({ phoneNumber: phone, displayName: (d.firstName ?? "") as string }),
              { uid: "dryrun-uid" } as any,
            );
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
          // uid must live IN the doc too — services/api.ts getUser gates the
          // client role resolution on data.uid being present.
          uid,
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
        const relationship = (d.relationship ?? "") as string;
        const city         = (d.city         ?? "") as string;
        const zipCode      = (d.zipCode      ?? "") as string;
        const conditions   = (d.conditions   ?? []) as string[];
        const careNeeds    = (d.careNeeds    ?? []) as string[];
        const seniorAge    = d.age as number | undefined;

        // One plan entry per care recipient (primary + any additional — "both
        // mom and dad"). Keys MUST use the web CarePlan.tsx getKey format
        // (recipientPlanKey) or the web tabs can't find Evia's plan data.
        // Care needs/conditions are shared across recipients at signup — same
        // behavior as the web PostJob flow; per-person details are edited later
        // in the CarePlan tabs.
        const recipients = allCareRecipients(d);
        const recipientPlans: Record<string, unknown> = {};
        for (const r of recipients) {
          recipientPlans[recipientPlanKey(r.name.split(" ")[0] || r.name)] = {
            name:         r.name,
            age:          r.age ?? (recipientPlanKey(r.name) === recipientPlanKey(seniorName) ? seniorAge : undefined),
            relationship: r.relationship ?? "",
            careNeeds,
            conditions,
            updatedAt:    new Date().toISOString(),
          };
        }
        await db.collection("carePlans").doc(uid).set({
          clientId: uid,
          phone,
          recipientPlans,
          locationPool: [{ city, zipCode, primary: true, ...(hasCoords ? { lat, lng } : {}) }],
          updatedAt: new Date().toISOString(),
        }, { merge: true });

        // senior_profiles/{uid} parity write for the PRIMARY recipient —
        // CarePlan, matching, and the family dashboard read this doc (web
        // signup creates it; Evia must too). The account holder's identity
        // stays on users/{uid}; this doc is the care recipient's.
        await db.collection("senior_profiles").doc(uid).set({
          userId:    uid,
          clientId:  uid,
          name:      seniorName,
          ...(seniorAge !== undefined ? { age: seniorAge } : {}),
          ...(relationship ? { relationship } : {}),
          needs:     careNeeds,
          diagnoses: conditions,
          // Web Senior type requires location (city string); preference fields
          // feed the matching engine and the family dashboard.
          location:  city || "",
          zipCode:   zipCode || null,
          genderPreference:   (d.genderPreference   ?? "") as string,
          languagePreference: (d.languagePreference ?? "") as string,
          updatedAt: new Date().toISOString(),
        }, { merge: true }).catch((err) => console.error("senior_profiles parity write error:", err));

        // Additional recipients get their own household senior_profiles docs
        // (deterministic IDs — webhook retries must not mint duplicates) plus
        // users/{uid}.seniorIds back-refs, so the MCP list_household_seniors
        // tool and household-aware readers see every person Evia cares for.
        const extraRecipients = normalizeAdditionalRecipients(d.additionalRecipients);
        for (const r of extraRecipients) {
          const seniorDocId = householdSeniorDocId(uid, r.name);
          await db.collection("senior_profiles").doc(seniorDocId).set({
            userId:    uid,
            clientId:  uid,
            name:      r.name,
            ...(r.age !== undefined ? { age: r.age } : {}),
            ...(r.relationship ? { relationship: r.relationship } : {}),
            needs:     careNeeds,
            diagnoses: conditions,
            location:  city || "",
            zipCode:   zipCode || null,
            updatedAt: new Date().toISOString(),
          }, { merge: true }).catch((err) => console.error("household senior_profiles write error:", err));
          await db.collection("users").doc(uid).set({
            seniorIds: admin.firestore.FieldValue.arrayUnion(seniorDocId),
          }, { merge: true }).catch((err) => console.error("users.seniorIds write error:", err));
        }
      }

      // Write intake — uid-keyed so the web app (ClientIntakeFlowV2, matching
      // hooks) reads the same doc Evia writes. Random-ID fallback only when no
      // auth uid could be resolved.
      // Human-readable schedule string — the web ClientIntakeData contract and
      // the matching prompt both read intake.schedule; built from the structured
      // fields (or the absorbed free-text schedule when that's all we have).
      const scheduleText = [
        d.daysPerWeek ? `${d.daysPerWeek} days/week` : "",
        (d.timeOfDay as string) ?? "",
        d.hoursPerDay ? `${d.hoursPerDay} hrs/day` : "",
      ].filter(Boolean).join(", ") || ((d.schedule as string) ?? "");

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
        // Web-contract aliases (types.ts ClientIntakeData) — the client profile
        // dashboard reads recipientName/careTypes/contactName/schedule and shows
        // blanks without them.
        recipientName:      (d.seniorName ?? "") as string,
        recipientFirstName: (((d.seniorName ?? "") as string).split(" ")[0]) || (d.seniorName ?? ""),
        careTypes:          d.careNeeds ?? [],
        contactName:        (d.firstName ?? "") as string,
        schedule:           scheduleText,
        // Collected during intake but previously dropped at finalization:
        startDate:          (d.startDate ?? null) as string | null,
        budgetMin:          (d.budgetMin ?? null) as number | null,
        budgetMax:          (d.budgetMax ?? null) as number | null,
        caregiverPreferences: d.caregiverPreferences ?? {},
        genderPreference:     (d.genderPreference   ?? "") as string,
        languagePreference:   (d.languagePreference ?? "") as string,
        needsDriving:         d.needsDriving === true,
        otherPreference:      (d.otherPreference ?? "") as string,
        // Multi-recipient household ("both mom and dad"): everyone after the
        // primary, plus the count the web PostJob flow also records.
        additionalRecipients: normalizeAdditionalRecipients(d.additionalRecipients)
          .map((r) => ({ firstName: r.name, lastName: "", name: r.name, relationship: r.relationship ?? "", ...(r.age !== undefined ? { age: String(r.age) } : {}) })),
        recipientsCount:      1 + normalizeAdditionalRecipients(d.additionalRecipients).length,
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

      // Seed the known-names registry with the client + every care recipient so
      // the persona-shift detector recognizes the whole household from day one.
      await addKnownNames(phone, [
        d.firstName as string,
        d.seniorName as string,
        ...normalizeAdditionalRecipients(d.additionalRecipients).map((r) => r.name),
      ]);

      // Initialize memory files with onboarding data. Loud on failure with phone
      // context — this is the completion-time bootstrap; a silent miss here means
      // the client's profile/health memory files never exist and every later
      // qaAgent turn falls through to the lazy re-bootstrap (or worse, stays empty
      // if that also fails), with nobody paged either time.
      initializeMemoryFiles(uid ?? phone, {
        // Household signups: name every care recipient so Evia's memory knows
        // who the care is for from day one (account holder stays clientName).
        seniorName:   [
          d.seniorName as string | undefined,
          ...normalizeAdditionalRecipients(d.additionalRecipients).map((r) => r.name),
        ].filter(Boolean).join(" and ") || undefined,
        seniorAge:    d.age          as string | undefined,
        conditions:   d.conditions   as string | string[] | undefined,
        careNeeds:    d.careNeeds    as string | string[] | undefined,
        city:         d.city         as string | undefined,
        clientName:   d.firstName    as string | undefined,
        relationship: d.relationship as string | undefined,
      }).catch((err) => console.error("initializeMemoryFiles error:", {
        phone, uid: uid ?? null, error: err instanceof Error ? err.message : String(err),
      }));

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
      // Short thank-you only — handleCaregiverSendBgcheck composes the
      // background-check intro itself (avoids two stacked intros).
      await sendMessage(chatId, await generateCaraMessage({
        audience: "caregiver",
        language: session.preferredLanguage === "es" ? "es" : "en",
        context: "The caregiver's membership payment just went through. ONE short warm line acknowledging it — you're about to send the background-check step right after, so don't explain it here.",
        fallback: "Payment received — thank you!",
        maxTokens: 40,
      }));
      await handleCaregiverSendBgcheck(phone, chatId, session);
      break;
    }

    case "mvr_payment": {
      await db.collection("agent_sessions").doc(phone).update({
        processedWebhookTasks: admin.firestore.FieldValue.arrayUnion(task),
      });
      // Caregiver was already onboarded — restore their prior step so later
      // messages route normally; the MVR-only check runs server-side.
      const priorStep = (session as any).mvrPriorStep as string | undefined;
      if (priorStep) await updateSession(phone, { onboardingStep: priorStep }).catch(() => {});
      await sendMessage(chatId, await generateCaraMessage({
        audience: "caregiver",
        language: session.preferredLanguage === "es" ? "es" : "en",
        context: "The caregiver just paid for the Approved Driver add-on. Naturally confirm: payment received, their driving-record (MVR) check is underway, you'll text them the moment their verified-driver badge is active, and it doesn't affect their existing caregiver approval.",
        fallback: "Payment received — your driving record check is underway. I'll text you the moment your Approved Driver badge is active. This doesn't change your existing caregiver approval.",
        maxTokens: 90,
      }));
      break;
    }

    case "background_check": {
      await db.collection("agent_sessions").doc(phone).update({
        processedWebhookTasks: admin.firestore.FieldValue.arrayUnion(task),
      });
      // Checkr came back clear → congratulate, then advance to Stripe Connect
      await updateSession(phone, { onboardingStep: "caregiver_send_stripe_connect" });
      const clearFirstName = (((session.onboardingData ?? {}).name ?? "") as string).split(" ")[0];
      await sendMessage(chatId,
        `🎉 Great news${clearFirstName ? `, ${clearFirstName}` : ""} — your background check came back clear. ` +
        `You're officially approved to be on Evia, and families can now book you!`
      );
      await handleCaregiverSendStripeConnect(phone, chatId, session);
      break;
    }

    case "identity": {
      // Mark processed first to prevent a duplicate identity webhook from
      // re-running the send below (a second Stripe Checkout session + duplicate
      // payment link). Mirrors every other task branch; identity was the one
      // case missing this guard.
      await db.collection("agent_sessions").doc(phone).update({
        processedWebhookTasks: admin.firestore.FieldValue.arrayUnion(task),
      });

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
              const newUser = await guardSideEffect(
                "auth.createUser",
                () => admin.auth().createUser({ phoneNumber: phone, displayName: (d.firstName ?? "") as string }),
                { uid: "dryrun-uid" } as any,
              );
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
            uid,
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
      // Step guard: only finalize when the session is actually parked at the
      // Connect step. Without this, ANY completed Connect account would activate
      // the caregiver — e.g. an early payout link minted by the agent tool while
      // the background check is still pending would send a "background check
      // came back clear" celebration prematurely. Blocked completions recover
      // when the flow reaches the Connect step: the reused account's link is
      // re-sent and /done (or the next account.updated) re-fires this task.
      const stepNow = (session as any).onboardingStep as string | undefined;
      if (stepNow !== "caregiver_awaiting_stripe" && stepNow !== "caregiver_send_stripe_connect") {
        console.info(`advanceOnboardingStep: ignoring stripe_connect at step="${stepNow}" for phone=${phone}`);
        return;
      }

      // Atomic claim: with stripeAccountId mirrored onto the caregiver doc, BOTH
      // the Connect webhook and the /done callable fire for the same completion —
      // often inside the read window of the processedWebhookTasks guard above
      // (read-then-arrayUnion, not atomic). claimWebhookEvent's create() is
      // atomic, so exactly one caller finalizes; it fails OPEN on ledger infra
      // errors (losing an activation is worse than a rare duplicate celebration).
      const claimId = `advance_stripe_connect_${phone}`;
      if (await claimWebhookEvent(STRIPE_EVENTS_COLLECTION, claimId) === "duplicate") {
        console.info(`advanceOnboardingStep: stripe_connect already claimed for phone=${phone}`);
        return;
      }

      // Mark processed first to prevent duplicate caregiver doc creation on retry
      await db.collection("agent_sessions").doc(phone).update({
        processedWebhookTasks: admin.firestore.FieldValue.arrayUnion(task),
      });
      // The arrayUnion is now durable — the top-of-function guard owns dedupe
      // from here, so stamp the claim settled (a crash BEFORE this line leaves
      // the claim to expire in 10 min, letting a webhook redelivery retry).
      await settleWebhookEvent(STRIPE_EVENTS_COLLECTION, claimId, "processed");

      // Caregiver Stripe Connect complete → finalize caregiver doc. The field
      // mapping lives in buildCaregiverProfileMirror (shared with the
      // incremental mirror in mergeOnboardingData and the gate-handoff doc
      // creation) — only the gating fields are finalization-specific. The
      // mirror omits absent fields instead of writing nulls, so this merge can
      // never blank a field another path already set.
      const d = session.onboardingData ?? {};
      const profileData = {
        phone,
        ...buildCaregiverProfileMirror(d),
        membershipSubscriptionId: (session as any).caregiverSubscriptionId ?? null,
        status:          "active",
        // Visibility gate: families' FindCaregivers query only loads caregivers
        // where onboardingStatus === 'profile_complete'. Evia is the canonical
        // onboarding path, so it must set this too (the web wizard already does).
        onboardingStatus: "profile_complete",
      };

      // Admin verification queue reads verificationStatus === 'submitted' (the value
      // stripe.ts sets for the web path). Set it here so Evia caregivers also enter the
      // queue — but never clobber a terminal status the Checkr webhook may have already set.
      const TERMINAL_VSTATUSES = ["approved", "rejected", "pre_adverse_action", "checkr_clear"];

      // Resolve the Firebase Auth uid first — the canonical caregivers/{uid} doc ID
      // (Evia/web data contract). Also enables the users/{uid} parity write below.
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
        // userId keeps the web-thread mirror working for caregivers: the
        // threadMirror resolves sessions by userId, and phone-OTP web login
        // signs into this same auth uid (U3, cara-web-chat plan).
        ...(authUid ? { userId: authUid } : {}),
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

      // Warm "you're approved" milestone message before handing off to permissions.
      // Capability tour (R13): close onboarding with 2-3 concrete care recipes
      // drawn from the shipped-parity registry (capabilityDiscovery/careRecipes)
      // instead of a generic welcome, so the caregiver's first impression of
      // Evia is what they can actually text her for - woven into prose, never a
      // feature list or menu (voice contract).
      const firstName = ((d.name ?? "") as string).split(" ")[0] || "you";
      const specialties = Array.isArray(d.specialties) ? (d.specialties as string[]).join(", ") : "";
      // Drop dual-role phrases written from the family's point of view ("ask
      // the caregiver...") - they read wrong addressed TO a caregiver.
      const recipePhrases = getCapabilityExamples("caregiver", 4)
        .filter((phrase) => !phrase.toLowerCase().includes("the caregiver"))
        .slice(0, 3);
      const recipeList = recipePhrases.length > 1
        ? `${recipePhrases.slice(0, -1).join(", ")}, or ${recipePhrases[recipePhrases.length - 1]}`
        : recipePhrases[0] ?? "handle your schedule, visit notes, and pay";
      const activationMsg = await generateCaraMessage({
        audience: "caregiver",
        context:
          `Caregiver first name: ${firstName}. ` +
          `Their background check came back clear and they just finished setting up payouts — they're now fully approved and active. ` +
          `${specialties ? `Their specialties: ${specialties}. ` : ""}` +
          `Write a warm 3-4 sentence "you're approved" celebration message. Reassure them their profile is live, ` +
          `mention they'll start getting matched with families soon, and that I'll text them as new jobs come in. ` +
          `Then, in one natural closing sentence (plain prose - no list, no menu, no numbering), let them know ` +
          `they can text me anytime to ${recipeList}. ` +
          `Sound genuinely happy for them.`,
        fallback:
          `🎉 You're approved, ${firstName}! Your profile is live and I'll start matching you with families that need help. ` +
          `Watch for job alerts here — reply YES to any that interest you. ` +
          `And I'm your coordinator from here on: text me anytime to ${recipeList}. Welcome to Evia!`,
        maxTokens: 220,
      });
      await sendMessage(chatId, activationMsg);

      // How-you-get-paid facts (2026-07-06 money model): automatic daily payouts
      // are the standard rail and instant payouts are free. Sent once, here, so
      // every caregiver leaves onboarding knowing how money reaches them.
      await sendMessage(chatId,
        `Quick money note: payouts are automatic — your earnings land in your bank about 2 business days after each visit is paid, no action needed. ` +
        `Need it sooner? Just text me PAYOUT for a free instant payout. ` +
        `You can see your balance and payment history anytime at ${APP_URL}/caregiver/payments`
      );

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
    // Intake collects a days-per-week COUNT, not named days — jobDays stays
    // empty, so pass the count through or job_posts ships daysPerWeek: 0.
    jobDaysPerWeek:   daysPerWeek,
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
  if (await isQuestionOrOther(text, "How often do you need help? 1 Occasional, 2 Part-time, 3 Full-time")) {
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
  if (await isQuestionOrOther(text, "Which days work best?")) {
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
  if (await isQuestionOrOther(text, "What time of day works best? Morning, Afternoon, Evening, or Overnight")) {
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
  if (await isQuestionOrOther(text, "What kind of help does your loved one need? (reply with the numbers)")) {
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
  if (await isQuestionOrOther(text, "How much support is needed? Light, Moderate, or Intensive")) {
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
  if (await isQuestionOrOther(text, "Are there pets in the home? Is it a smoking household?")) {
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
  if (await isQuestionOrOther(text, "What hourly rate are you hoping to pay? (or \"flexible\")")) {
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
    "1️⃣  Credit/debit card (through the platform)\n" +
    "2️⃣  Cash directly\n" +
    "3️⃣  Venmo\n" +
    "4️⃣  Zelle"
  );
}

async function handleJobAskDescription(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text, "How will you pay the caregiver? Card, Cash, Venmo, or Zelle")) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "How will you pay the caregiver?\n1️⃣ Card  2️⃣ Cash  3️⃣ Venmo  4️⃣ Zelle");
    return;
  }
  const raw = await parseWithClaude(
    '"1", card, credit, debit, stripe = card. "2", cash, direct, hand = cash. ' +
    '"3", venmo = venmo. "4", zelle = zelle. ' +
    'Reply with exactly one of: card, cash, venmo, zelle',
    text
  );
  const paymentMethod = ["cash", "venmo", "zelle"].includes(raw) ? raw : "card";
  const payLabel = paymentMethod === "card" ? "Card" : paymentMethod === "cash" ? "Cash" : paymentMethod === "venmo" ? "Venmo" : "Zelle";
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
    const payLabel      = paymentMethodLabel(rd.jobPaymentMethod);
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
  const name = (d.name ?? d.firstName ?? "") as string;
  return (await quickComplete(
    "You are Evia, a warm human-feeling care coordinator at Evia. You help people entirely over text — " +
      "YOU do the work for them: you find, vet, and match caregivers and set everything up through this conversation. " +
      `The person you're texting is ${session.userType === "caregiver" ? "a caregiver looking for work" : "a family member looking for care for a loved one"}` +
      `${name ? ` named ${name}` : ""}, and they're in the middle of signing up with you. They just said something — it may be a question, or just a comment. ` +
      "Reply in ONE warm, specific sentence. " +
      "HARD RULES: " +
      "(1) NEVER invent or refer to a website, app, dashboard, 'platform', 'search function', filters, or any self-serve tool — none exist; the user only ever texts you, and you handle the searching and matching yourself. " +
      "(2) If they named a place or a need (e.g. 'I'm looking for caregivers in San Jose'), reassure them you'll handle finding caregivers there — do NOT tell them to search. " +
      // LAUNCH: wording pending counsel review (R15)
      "(3) Never VOLUNTEER a robotic self-label (e.g. describing yourself as an assistant powered by AI, or as a chatbot) and never refer to yourself in the third person. But if directly asked whether you are an AI, a bot, or a human, answer honestly and warmly — never deny it or dodge the question. Also never use phrases like 'I'm here to help' or 'let me know if you need further assistance'. " +
      "(4) If you don't actually know the answer, say you'll get it sorted — never make up a feature or process. " +
      "(5) Ask NO question of your own — none. The signup question is re-asked automatically right after your reply, so a question from you would leave the user answering two different things at once. " +
      "(6) Speak TO the person, never ABOUT them in the third person, and never narrate progress or process (no \"I'll keep her on track\", \"I'll get everything set for the next step\" — that reads like an internal status report).",
    text,
    { maxTokens: 90 },
  )).trim();
}
