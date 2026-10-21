import { CARE_PROVIDER_TERM_RULE } from "./terminology";
import * as admin from "firebase-admin";
import { quickComplete } from "../utils/openaiClient";
import { isMvrCheckConfigured } from "../mvrConfig";
import { cancelCheckrInvitationsForCandidate } from "../checkrApi";
import { authorizeBackgroundCheck } from "../backgroundCheckConsent";
import Stripe from "stripe";
import { recordCommitment, resolveCommitment } from "./commitmentTracker";
import { sendMessage, signalThinking, AgentSession } from "../linq/client";
import { createBrandedLink } from "../utils/linkRedirects";
import {
  classifyEmotionalContext,
  classifyEmotionalTopic,
  blendEmotionalContext,
  buildEmotionalContextDirective,
  StoredEmotionalContext,
} from "./emotionalContext";
import { generateToken } from "./tokenService";
import { buildHelpSmsReply } from "./capabilityDiscovery";
import { notifyAdminNewClientSignup, notifyAdminNewCaregiverSignup } from "../notifications";
import { claimWebhookEvent, settleWebhookEvent, STRIPE_EVENTS_COLLECTION } from "../utils/webhookLedger";
import { initializeMemoryFiles, writeMemoryFile } from "../memory/memoryFiles";
import { pushOnboardingDataToZep, addBusinessDataToZep, getZepUserId } from "../memory/zepClient";
import { buildAndSaveJobPost, jobLiveMessage } from "./buildJobPost";
import { geocodeAddress, GeoPrecision } from "../utils/geocode";
import { paymentMethodLabel } from "../billing/paymentMethods";
import { generateCaraMessage } from "../utils/caraMessage";
import { getMarketRateText } from "../utils/marketRateRange";
import { generateOtp, verifyOtp, formatOtpForDisplay, OtpState } from "../utils/phoneVerification";
import { languageFromSession, t as tr } from "../utils/language";
import { SharedLocation } from "../utils/locationShare";
import { WAITLISTED_STEP, parkOutOfArea } from "./serviceAreaGate";
import { evaluateServiceArea } from "../config/serviceArea";
import { lookupZipPlace } from "../utils/geocode";
import { isMedicationInstruction as isMedicationInstructionText, MEDICATION_INSTRUCTION_MESSAGE as MEDICATION_INSTRUCTION_TEXT } from "../utils/medicationInstruction";
import {
  runFamilyIntakeTurn, nextFamilyStep, familyQuestion, effectiveFamilyData, isFamilyScriptStep,
  readRoster, dataFromRoster, rosterFromData, describeRoster, type FamilyIntakeDeps,
} from "./familyIntakeScript";
import { LEGACY_CLIENT_COLLECTION_STEPS } from "./onboardingContract";
import { downloadMedia, storeInboundMedia, InboundMediaPart } from "../utils/mediaIntake";
import { addKnownNames } from "../utils/knownNames";
import { getAppUrl } from "../config/appUrl";
import { caregiverAnnualDisplay, caregiverAnnualAmount, clientMonthlyDisplay } from "../config/pricing";
// onboardingSteps.client is KEPT only for its reask() text (currentStepQuestion
// below). The loop-only cut deleted the scripted CONVERSATIONAL collection
// handlers, and the legacy post-collection steps (client_ask_start/preferences/
// budget) were removed too — the site's wizard never collected a start-date
// preference, caregiver preferences or a budget — so complete_collection now
// hands straight to client_confirm_intake and nothing runs on the table-driven
// runner anymore.
import { isQuestionOrOther as stepIsQuestionOrOther, classifyAwaitingReply } from "./stepHandler";
import { buildClientSteps } from "./onboardingSteps.client";
import { isOnboardingDryRun, recordSideEffect, guardSideEffect } from "./onboardingDryRun";
import { runGetCaregiverPreviewAction } from "./actions/getCaregiverPreviewAction";
import { recipientPlanKeyForFullName, normalizeAdditionalRecipients, allCareRecipients, describeWhoIsWho } from "./careRecipients";
import {
  buildClientDraftMirror, buildJobPostingsDoc, mapJobPostingsDocToOnboardingData, mapUsersDocToOnboardingData, buildCarePlanLocationEntry, buildSeniorProfileWizardFields,
  upsertCarePlanLocationPool, formatWizardPhone, normalizeStartDateToISO, deriveCareLevel,
} from "./clientJobPostingContract";
import { coerceClientRate } from "./onboardingContract";
import { businessTodayStr, formatDateForDisplay } from "../utils/scheduledTime";
import { canonicalizeCareNeeds, describeCareNeeds, isCanonicalCareNeeds } from "./careNeedsTaxonomy";
import { careKindsFromWords, ageRangeFromWords, stageOf, rosterCareKinds, serviceListsForKinds, serviceLabel as careServiceLabel, recipientCareKind, AGE_RANGES } from "./caregiverServiceLabels";
import { collectionStepsForRole, missingRequiredFields, firstGateStep, isNumericOnboardingField, coerceNumericOnboardingField, normalizeOnboardingFieldValue, offersTransportation } from "./onboardingContract";
import { LIVE_GATE_FACT_BUILDERS, buildLiveBgcheckFact } from "./liveGateFacts";
import { isCaregiverMembershipActive } from "./caregiverAccessGate";
import { consentAlreadyRequested } from "./caregiverSiteSync";
import { describeSharedProfile } from "./profileBriefing";
import { getSeniorProfileWithSource } from "../data/seniorProfileRepository";
import {
  GATE_LINK_KEYWORD_TARGETS,
  gateLinkBypassConsumed,
  gateLinkBypassSpentCopy,
  gateLinkCooldownMinutes,
  gateLinkCooldownResetMinutes,
  gateLinkInCooldownReplyCopy,
  isGateLinkKeywordStep,
  stampGateLinkBypassUsed,
  stampGateLinkResent,
} from "./gateLinkCooldown";

/**
 * The "where are you" question. The site has no location-pin/GPS affordance
 * anywhere (every address form is plain typed fields) — Evia must not offer
 * one either (2026-09-26: dropped the ➕ → Location invite, which also could
 * never satisfy the caregiver's required street field anyway; `service` is
 * kept as a param only for call-site compatibility).
 */
function locationPrompt(base: string, _service?: string): string {
  return base;
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
  customers: {
    create: async () => { recordSideEffect("stripe.customers.create"); return { id: "cus_dryrun" }; },
  },
  checkout: {
    sessions: {
      create: async () => { recordSideEffect("stripe.checkout.sessions.create"); return { id: "cs_dryrun", url: "https://dryrun.local/checkout" }; },
    },
  },
  accounts: {
    create: async () => { recordSideEffect("stripe.accounts.create"); return { id: "acct_dryrun" }; },
    retrieve: async () => ({ id: "acct_dryrun", charges_enabled: true, payouts_enabled: true, details_submitted: true }),
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
  kind: "background-check" | "payout setup" | "background-check renewal" | "client-payment",
): Promise<void> {
  // "I'll text you the moment it's ready" is a tracked promise, not vibes:
  // record a `link` commitment BEFORE sending the copy, so the sweep re-attempts
  // the send in ~5 minutes and escalates to a human if it fails again. Before
  // this, the sentence had no mechanism behind it — the caregiver's signup
  // silently dead-ended here (2026-07-07 live test).
  const linkType: OnboardingLinkType =
    kind === "payout setup"     ? "caregiver_payouts"
    : kind === "client-payment" ? "client_payment"
    : "caregiver_background_check";
  // The membership-checkout failure addresses the FAMILY; every caregiver link
  // failure addresses the caregiver. Parameterize audience/userType so the copy
  // and the tracked commitment name the right person (was hardcoded caregiver).
  const isClient = kind === "client-payment";
  const audience: "family" | "caregiver" = isClient ? "family" : "caregiver";
  const userType: "client" | "caregiver" = isClient ? "client" : "caregiver";
  // Human phrase for the copy — "client-payment" would read wrong to the family.
  const linkLabel = isClient ? "membership setup" : kind;
  await recordCommitment({
    phone,
    chatId,
    kind:        "link",
    promiseText: `onboarding ${kind} link failed to generate — retry the send`,
    linkType,
    userType,
    source:      "onboardingConversation:link_failure",
    dueInMs:     5 * 60_000,
  });
  await sendMessage(chatId, await generateCaraMessage({
    audience,
    language: session.preferredLanguage === "es" ? "es" : "en",
    context: `A ${isClient ? "family" : "care provider"} needs a ${linkLabel} link, but Evia could not generate the real external link. Be honest, warm, and brief. Say you are on it and will text the link once it is ready. Do not include any URL.`,
    fallback: `I hit a snag pulling up your ${linkLabel} link — I'm on it and I'll text you the moment it's ready.`,
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

export async function mergeOnboardingData(phone: string, data: Record<string, unknown>): Promise<void> {
  if (isOnboardingDryRun()) {
    recordSideEffect("firestore.update:agent_sessions.onboardingData", { phone, keys: Object.keys(data) });
    return;
  }
  // Atomic per field (2026-10-21): this used to read the whole draft, merge in memory and write
  // the whole map back — two turns in flight at once (a redelivered inbound while a slow turn is
  // still running) could each write a stale map and erase the other's answers (live: the care
  // address answer vanished between turns). Dotted-path updates touch only the keys given.
  const dotted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) dotted[`onboardingData.${k}`] = v === undefined ? null : v;
  if (Object.keys(dotted).length) {
    await db.collection("agent_sessions").doc(phone).update(dotted).catch(async (err) => {
      // A session with no onboardingData map yet (or none at all): fall back to a merge-set.
      console.warn("mergeOnboardingData: dotted update failed, falling back to merge-set:", err instanceof Error ? err.message : err);
      await db.collection("agent_sessions").doc(phone).set({ onboardingData: data }, { merge: true });
    });
  }
  const snap = await db.collection("agent_sessions").doc(phone).get();
  const sess     = (snap.data() ?? {}) as Record<string, unknown>;
  const merged   = (sess.onboardingData ?? {}) as Record<string, unknown>;

  // Incremental profile persistence: once the uid-keyed caregivers doc exists
  // (created at /start's OTP or the gate handoff), every onboarding merge lands
  // on it the way the site's wizard saves each step — ONLY the fields this save
  // collected are rewritten; anything else the record holds (a later site edit)
  // is left alone, and missing fields are filled (caregiverProfileMirror.ts,
  // sweep C3/C4 2026-10-11). Non-fatal: mirroring must never break the turn.
  // Visibility gates are untouched (status / onboardingStatus stay wherever the
  // step machinery put them).
  const caregiverId = sess.caregiverId as string | undefined;
  if (caregiverId && sess.userType === "caregiver") {
    const { mirrorCaregiverDraftToRecord } = await import("./caregiverProfileMirror");
    await mirrorCaregiverDraftToRecord(caregiverId, merged, Object.keys(data));
  }

  // 2026-09-20 (founder: one questionnaire, two doors): a FAMILY's answers land on
  // job_postings/{uid} as they are given — the same doc, same field names the site
  // wizard saves per step and reads back — so the wizard resumes where the text
  // left off, and vice versa (qaAgent already merges that doc into this draft).
  // Only fields actually answered; status is left to the submit paths.
  const clientUid = sess.userId as string | undefined;
  if (clientUid && sess.userType !== "caregiver" && Object.keys(data).length > 0) {
    const draft = buildClientDraftMirror(clientUid, phone, merged);
    if (Object.keys(draft).length > 0) {
      await db.collection("job_postings").doc(clientUid)
        .set({ ...draft, clientId: clientUid, draftUpdatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true })
        .catch((err) => console.error("mergeOnboardingData: client draft mirror failed (non-fatal):", err));
    }
  }
}

// The caregiver record mirror (buildCaregiverProfileMirror, wizardStepForDraft,
// profileMirrorForExisting) lives in ./caregiverProfileMirror — a leaf the MCP
// save tool and the inbound absorber share, so every field saved by text lands
// on caregivers/{uid} the moment it is saved (caregiver sweep C3/C4, 2026-10-11).
// Re-exported here for the callers and tests that import them from this file.
import { buildCaregiverProfileMirror, wizardStepForDraft, profileMirrorForExisting } from "./caregiverProfileMirror";
export { buildCaregiverProfileMirror, wizardStepForDraft, profileMirrorForExisting };

// Caregiver coords have ONE owner (2026-10-11): triggers/caregiverGeocode.ts
// geocodes the full street address (street first, ZIP/city fallback) on every
// caregivers/{uid} write that changes the address or lacks coords, and stamps
// `geoPrecision`. The text draft no longer geocodes the ZIP into
// onboardingData.lat/lng (the former ensureCaregiverCoords) and the record
// mirror writes no coords — the site's wizard/Settings street-level write and
// Evia's address mirror both end in that same trigger.

// SMS clients type a street + zip and (unlike a shared pin) never had
// coordinates persisted anywhere, so carePlans.locationPool and the
// caregiver-preview scoring had no real distance to work with. Geocodes the
// CARE address (falls back to the home address) once — street first, like the
// site's wizard (services/api.ts createJobPosting), then ZIP — persists it on
// the session with its `geoPrecision`, so both the care-plan write and the
// caregiver preview downstream use the same street-level point.
async function ensureClientCoords(
  phone: string, d: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof d.lat === "number" && typeof d.lng === "number") return d;
  const street  = (d.street as string | undefined)   || (d.homeStreet as string | undefined);
  const city    = (d.city as string | undefined)    || (d.homeCity as string | undefined);
  const zipCode = (d.zipCode as string | undefined)  || (d.homeZipCode as string | undefined);
  const state   = (d.state as string | undefined)    || (d.homeState as string | undefined);
  const point = await geocodeAddress({ street, city, zipCode, state }).catch(() => null);
  if (!point) return d;
  await db.collection("agent_sessions").doc(phone).update({
    "onboardingData.lat": point.lat,
    "onboardingData.lng": point.lng,
    "onboardingData.geoPrecision": point.geoPrecision,
  }).catch((err) => console.error("ensureClientCoords: session persist failed (non-fatal):", err));
  return { ...d, lat: point.lat, lng: point.lng, geoPrecision: point.geoPrecision };
}

// Live current location for an established client, read the same way the
// site's own matching does (senior_profiles.latitude/longitude/zipCode/city,
// falling back to users' flat address fields) — never the one-time
// onboardingData snapshot captured at signup. Returns only the fields that
// were actually found, so a caller merging this in never blanks out an
// existing (even if imperfect) value with an absent one.
export async function loadLiveClientLocation(
  userId: string,
): Promise<Record<string, unknown> | null> {
  const out: Record<string, unknown> = {};

  const seniorSnap = await db.collection("senior_profiles").doc(userId).get().catch(() => null);
  const senior = seniorSnap?.exists ? seniorSnap.data() as Record<string, unknown> : null;
  if (typeof senior?.latitude === "number" && typeof senior?.longitude === "number") {
    out.lat = senior.latitude;
    out.lng = senior.longitude;
  }
  if (senior?.zipCode) out.zipCode = senior.zipCode;

  const userSnap = await db.collection("users").doc(userId).get().catch(() => null);
  const user = userSnap?.exists ? userSnap.data() as Record<string, unknown> : null;
  if (user?.city) out.city = user.city;
  if (user?.state) out.state = user.state;
  if (out.lat == null && typeof user?.lat === "number" && typeof user?.lng === "number") {
    out.lat = user.lat;
    out.lng = user.lng;
  }
  // geocodeClientIntake (triggers/clientIntakeGeocode.ts) writes users/{uid}
  // as `latitude`/`longitude`, not `lat`/`lng` — a phone-only client (never
  // opened the website, so senior_profiles.latitude/longitude was never
  // geocoded either) had no path that ever surfaced real coordinates here,
  // even though this trigger had already written them (2026-09-06 live bug).
  if (out.lat == null && typeof user?.latitude === "number" && typeof user?.longitude === "number") {
    out.lat = user.latitude;
    out.lng = user.longitude;
  }
  // job_postings.lat/lng — the wizard's own geocode of the care address
  // (createJobPosting), which FindCaregivers.tsx reads first for distance;
  // Evia's persistClientCareRecords writes the same field now too.
  if (out.lat == null) {
    const jpSnap = await db.collection("job_postings").doc(userId).get().catch(() => null);
    const jp = jpSnap?.exists ? jpSnap.data() as Record<string, unknown> : null;
    if (typeof jp?.lat === "number" && typeof jp?.lng === "number") {
      out.lat = jp.lat;
      out.lng = jp.lng;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

// ── Gate-step profile updates (2026-07-15) ────────────────────────────────────
// A caregiver parked at an awaiting/gate step who volunteers new profile info
// ("I can do transportation as well") used to get a context-free re-nudge and
// the info was silently dropped (seen live 07-14, Hamse @ awaiting_photo —
// the reply read like Evia forgot the whole conversation). Absorb-first: save
// the update (session + live caregiver doc), acknowledge the SPECIFIC thing
// they added, then remind them of the one thing still pending. Returns true
// when it handled the turn; false → caller runs its normal step behavior.
async function tryAbsorbGateProfileUpdate(
  phone:          string,
  chatId:         string,
  text:           string,
  session:        AgentSession,
  stillWaitingOn: string,
): Promise<boolean> {
  if (session.userType !== "caregiver") return false;
  if (!text || text.trim().length < 8) return false; // too short to carry a profile fact
  const d = (session.onboardingData ?? {}) as Record<string, unknown>;
  const { absorbCaregiverProfileUpdate } = await import("./caregiverFieldAbsorber");
  const updates = await absorbCaregiverProfileUpdate(text, d).catch(() => ({} as Record<string, unknown>));
  const keys = Object.keys(updates);
  if (!keys.length) return false;

  // mergeOnboardingData mirrors the update onto caregivers/{uid} itself (merge,
  // never blanks, wizard cursor left alone once the questionnaire is finished)
  // — no second direct write here.
  await mergeOnboardingData(phone, updates);

  const human = keys
    .filter((k) => k !== "skills" && k !== "services") // derived enums — not conversational
    .map((k) => {
      const v = updates[k];
      const shown = Array.isArray(v) ? (v as unknown[]).join(", ")
        : typeof v === "object" ? JSON.stringify(v) : String(v);
      return `${k} → ${shown}`;
    }).join("; ");

  await sendMessage(chatId, await generateCaraMessage({
    audience: "caregiver",
    language: session.preferredLanguage === "es" ? "es" : "en",
    context:
      `Mid-signup, the care provider just texted: "${text}". You saved what they volunteered to their profile (${human}). ` +
      `In 1-2 short sentences: acknowledge the SPECIFIC thing they added — families will see it on their profile — ` +
      `then remind them of the one thing you're still waiting on: ${stillWaitingOn}.`,
    fallback: `Got it — added to your profile! And whenever you're ready: ${stillWaitingOn}.`,
    maxTokens: 90,
  }));
  return true;
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

  // No coords here: the caregivers/{uid} write below carries the street
  // fields and triggers/caregiverGeocode.ts derives the point from them.
  const d = (sess.onboardingData ?? {}) as Record<string, unknown>;
  const authUid = await createFirebaseAuthAccount(phone, (d.name ?? "") as string).catch(() => null);
  // No random-ID fallback here: without a uid the bg-check pre-create and the
  // finalization migration still cover doc creation later, on their own terms.
  if (!authUid) return null;

  const docRef  = db.collection("caregivers").doc(authUid);
  const docSnap = await docRef.get();
  const existing = (docSnap.exists ? docSnap.data() : undefined) ?? {};
  // Never demote a record that already progressed. `status` (visibility: only
  // the Checkr webhook writes 'active') and `onboardingStatus` (the website's
  // "questionnaire finished" flag — CaregiverRoute re-opens the wizard whenever
  // it isn't 'profile_complete') are seeded ONLY on a brand-new record. Before
  // 2026-09-26 every re-link of an existing record (a re-created session, the
  // bg-check consent submit, an upload) rewrote onboardingStatus 'in_progress'
  // and the site showed the setup wizard to a caregiver who had finished it.
  const seedStatus = !docSnap.exists || !existing.status;
  const seedOnboardingStatus = !docSnap.exists || !existing.onboardingStatus;
  await docRef.set({
    phone,
    uid: authUid,
    ...(seedStatus ? { status: "onboarding" } : {}),
    ...(seedOnboardingStatus ? { onboardingStatus: "in_progress" } : {}),
    ...(docSnap.exists ? {} : { createdAt: new Date().toISOString() }),
    ...profileMirrorForExisting(buildCaregiverProfileMirror(d), existing),
  }, { merge: true });
  await db.collection("agent_sessions").doc(phone).update({ caregiverId: authUid });
  return authUid;
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

// Brief warm reply to a pure acknowledgment ("thanks", "sounds good") at an
// awaiting/gate step. Never re-explains the step or resends the link — the user
// already understood; re-explaining reads as not listening (see
// classifyAwaitingReply in stepHandler.ts).
async function sendAwaitingAck(
  chatId:   string,
  session:  AgentSession,
  context:  string,
  fallback: string,
): Promise<void> {
  await sendMessage(chatId, await generateCaraMessage({
    audience: session.userType === "caregiver" ? "caregiver" : "family",
    language: session.preferredLanguage === "es" ? "es" : "en",
    context: `${context} Reply with ONE brief warm line. Do NOT re-explain anything, do NOT mention any link.`,
    fallback,
    maxTokens: 40,
  }));
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
    "{\"switchTo\": \"client\" | \"care provider\" | \"none\"}. " +
    "Use \"client\" if they are clearly saying they need care for a loved one (not their own job). " +
    "Use \"care provider\" if they are clearly saying they are a care provider looking for work. " +
    `Use \"none\" if their message is just answering the current question or is ambiguous. ` +
    "Only flag clear role-switch intent; do NOT flag a client mentioning they have a care provider background, " +
    "or a care provider mentioning their own elderly parent in passing. The word \"care provider\" appearing in the " +
    "message is NOT enough by itself — a client asking about care provider MATCHES (e.g. \"any more care providers?\", " +
    "\"are there more care providers in my area?\") is asking about candidates for their loved one, not declaring " +
    "themselves a care provider — that is \"none\", never \"care provider\".",
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
export async function createFirebaseAuthAccount(phone: string, displayName: string): Promise<string | null> {
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
      const existing = await admin.auth().getUserByPhoneNumber(phone);
      // The /start OTP web entry creates the Auth user with NO displayName, so
      // this already-exists branch is the common path — backfill it or the
      // webapp greets the family by email prefix forever (it renders Auth
      // displayName, not the Firestore firstName).
      if (displayName && !existing.displayName) {
        await admin.auth().updateUser(existing.uid, { displayName }).catch((updErr) =>
          console.error(`[createFirebaseAuthAccount] displayName backfill failed for ${phone}:`, updErr));
      }
      return existing.uid;
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
  lastName?: string,
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
      // lastName is a real client field (web /start parity) — caregivers stay
      // on a single `name` string, matching how the rest of the app reads them.
      ...(role === "client" && lastName ? { lastName } : {}),
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
export const CLIENT_POST_COLLECTION_STEP = "client_confirm_intake";

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
      `"relationship":"family relationship to the care recipient (mother, father, son, daughter, etc.; a GROWN son or daughter is 'adult child')",` +
      `"careKind":"ONLY when the relationship is other: 'senior' (an adult) or 'child'",` +
      `"ageRange":"ONLY for a child, the child's stage by name: ${AGE_RANGES.map((a) => a.label).join(", ")}",` +
      `"additionalRecipients":[{"name":"...","relationship":"...","ageRange":"a child's stage by name, only when stated"}] — ` +
      `ONLY when care is for MORE THAN ONE person (e.g. "both mom and dad"); every person after the first goes here,` +
      `"careNeeds":["short need phrase — the KIND of day-to-day help (bathing, meals, rides, medication reminders, company); never a diagnosis, and NEVER a frequency word like occasional/part-time/full-time — how often is not a care need"],` +
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
    // Numeric fields: keep only values that coerce to an in-range number. The
    // extractor once hallucinated daysPerWeek: "santa clara" from a city answer —
    // prose must never land in a numeric field.
    if (isNumericOnboardingField(k)) {
      const n = coerceNumericOnboardingField(k, v);
      if (n === null) continue;
      out[k] = n;
      continue;
    }
    // careNeeds must land as the Care Plan's category names or not at all —
    // live 2026-09-26 the frequency answer "Occasional" was absorbed here as
    // the care need "occasional help", which marked the field answered, so
    // the "what kind of help" question was never asked. Same canonicalizer
    // save_onboarding_field and persistClientCareRecords use; an answer that
    // maps to no category is not a care need and is dropped.
    if (k === "careNeeds") {
      const canon = await canonicalAbsorbedCareNeeds(v);
      if (canon) { out.careNeeds = canon.careNeeds; out.careNeedDetails = canon.careNeedDetails; }
      continue;
    }
    // Child care (2026-10-18): constrained answers, canonicalized or dropped — never a raw word.
    if (k === "ageRanges" || k === "ageRange") { const id = ageRangeFromWords(v); if (id) out.ageRange = id; continue; }
    if (k === "careKind") { const kinds = careKindsFromWords(v); if (kinds && kinds.length === 1) out.careKind = kinds[0]; continue; }
    out[k] = v;
  }
  return out;
}

/** Absorbed care-need terms → site categories (+ sub-tasks), or null when none map. */
async function canonicalAbsorbedCareNeeds(v: unknown): Promise<{ careNeeds: string[]; careNeedDetails: Record<string, string[]> } | null> {
  const terms = (Array.isArray(v) ? v : [v]).map((t) => String(t ?? "").trim()).filter(Boolean);
  if (!terms.length) return null;
  const canon = await canonicalizeCareNeeds(terms).catch(() => null);
  if (!canon || !canon.careNeeds.length) return null;
  return { careNeeds: canon.careNeeds, careNeedDetails: canon.careNeedDetails };
}

// Update-mode client absorber (2026-07-15): additive merge for list-shaped
// care fields, so "mom also needs help with bathing" volunteered at a gate
// EXTENDS careNeeds instead of being dropped (absorbClientFields has
// collection semantics — it refuses to touch a filled field). Scalars still
// fill only when empty via the first pass.
export async function absorbClientProfileUpdate(
  text: string,
  existing: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fresh = await absorbClientFields(text, existing);
  const out: Record<string, unknown> = { ...fresh };

  const raw = await parseWithClaude(
    "A family member already signing up with Evia texted a message. Extract ONLY care details they are " +
      "adding about their loved one in THIS message. Return JSON only; omit anything not present. Schema: " +
      `{"careNeeds":["short need phrase like 'bathing' or 'meal prep' — day-to-day help, never a diagnosis"]}. ` +
      "Be conservative — only include what is unambiguously stated. Reply with raw JSON, no markdown.",
    text,
  ).catch(() => "{}");
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(raw); } catch { /* keep {} */ }

  const cleanArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()) : [];
  for (const key of ["careNeeds"] as const) {
    if (out[key]) continue; // first pass already handled the empty-field case
    const added = cleanArr(parsed[key]);
    if (!added.length) continue;
    const base = cleanArr(existing[key]);
    // Canonicalize the additions the same way collection does (category
    // names only); anything that maps to no category is not a care need.
    const canon = await canonicalAbsorbedCareNeeds(added);
    if (!canon) continue;
    const seen = new Set(base.map((s) => s.toLowerCase()));
    const freshItems = canon.careNeeds.filter((s) => !seen.has(s.toLowerCase()));
    if (freshItems.length) {
      out[key] = [...base, ...freshItems];
      const baseDetails = (existing.careNeedDetails as Record<string, string[]> | undefined) ?? {};
      out.careNeedDetails = { ...baseDetails, ...canon.careNeedDetails };
    }
  }
  return out;
}

// Client twin of tryAbsorbGateProfileUpdate (caregiver side, 2026-07-15): a
// family member parked at the identity/payment gate who volunteers a care
// detail gets it SAVED to the session onboardingData (the payment webhook's
// persistClientCareRecords re-run lands it on the real records) and
// specifically acknowledged, instead of a context-free nudge that silently
// drops it. Returns true when it handled the turn.
async function tryAbsorbClientGateUpdate(
  phone:          string,
  chatId:         string,
  text:           string,
  session:        AgentSession,
  stillWaitingOn: string,
): Promise<boolean> {
  if (session.userType === "caregiver") return false;
  if (!text || text.trim().length < 8) return false;
  const d = (session.onboardingData ?? {}) as Record<string, unknown>;
  const updates = await absorbClientProfileUpdate(text, d).catch(() => ({} as Record<string, unknown>));
  // Never write a texter's name into senior-name fields from a gate detour —
  // profile.name on client docs is the SENIOR's name (2026-07-10 learning).
  delete (updates as Record<string, unknown>).firstName;
  const keys = Object.keys(updates);
  if (!keys.length) return false;

  await mergeOnboardingData(phone, updates);

  const human = keys.map((k) => {
    const v = updates[k];
    return `${k} → ${Array.isArray(v) ? (v as unknown[]).join(", ") : String(v)}`;
  }).join("; ");
  await sendMessage(chatId, await generateCaraMessage({
    audience: "family",
    language: session.preferredLanguage === "es" ? "es" : "en",
    context:
      `Mid-signup, the family member just texted: "${text}". You saved the care detail(s) they volunteered (${human}) — ` +
      `these will shape the care provider match. In 1-2 short sentences: acknowledge the SPECIFIC detail, ` +
      `then remind them of the one thing you're still waiting on: ${stillWaitingOn}.`,
    fallback: `Got it — I've added that to the care plan. And whenever you're ready: ${stillWaitingOn}.`,
    maxTokens: 90,
  }));
  return true;
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
  if (step === "ask_role") return "are you looking for care for a loved one, or are you a care provider looking for work?";
  // Post-collection client steps (start/preferences/budget/confirm_intake) still
  // run on CLIENT_STEPS. Conversational collection steps are owned by the agent
  // loop and never reach this scripted helper.
  const c = CLIENT_STEPS[step]; if (c?.reask) return c.reask(session);
  const awaiting: Record<string, string> = {
    client_send_payment:           "finishing your payment setup with the link I sent",
    client_awaiting_payment:       "finishing your payment setup with the link I sent",
    client_awaiting_identity:      "the quick identity check with the link I sent",
    caregiver_send_membership:     "activating your membership with the link I sent",
    caregiver_awaiting_membership: "activating your membership with the link I sent",
    caregiver_send_bgcheck:        "authorizing your background check with the link I sent",
    caregiver_awaiting_bgcheck_consent: "authorizing your background check with the link I sent",
    caregiver_awaiting_bgcheck:    "finishing your background check (Checkr emailed you a secure link)",
    caregiver_send_stripe_connect: "setting up your payout account with the link I sent",
    caregiver_awaiting_stripe:     "setting up your payout account with the link I sent",
  };
  return awaiting[step] ?? "right where we left off";
}

// ── The family intake script (2026-10-20): deps + entry points ─────────────────
// One process that follows the site — agents/familyIntakeScript.ts. Every side
// effect it needs is wired here from the same helpers the rest of this file uses.
function familyIntakeDeps(): FamilyIntakeDeps {
  return {
    parseWithClaude: (prompt, text) => parseWithClaude(prompt, text),
    isQuestionOrOther: (text, q) => isQuestionOrOther(text, q),
    answerQuestionMidFlow: (text, session, phone) => answerQuestionMidFlow(text, session as AgentSession, phone),
    canonicalizeCareNeeds: async (terms) => { const c = await canonicalizeCareNeeds(terms); return { careNeeds: c.careNeeds, medical: c.medical, unmapped: c.unmapped }; },
    lookupZipPlace: async (zip) => { const p = await lookupZipPlace(zip); return p ? { city: p.city, state: p.state } : null; },
    evaluateServiceArea: (args) => evaluateServiceArea(args),
    parkOutOfArea: (args) => parkOutOfArea(args),
    loadSiteData: async (session) => {
      const uid = (session?.userId ?? session?.webOnboardingUid) as string | undefined;
      if (!uid) return {};
      const [jp, u] = await Promise.all([
        db.collection("job_postings").doc(uid).get().catch(() => null),
        db.collection("users").doc(uid).get().catch(() => null),
      ]);
      return {
        ...mapJobPostingsDocToOnboardingData(jp?.exists ? jp.data() : undefined),
        ...mapUsersDocToOnboardingData(u?.exists ? u.data() : undefined),
      };
    },
    mergeOnboardingData: (phone, fields) => mergeOnboardingData(phone, fields),
    updateSession: (phone, updates) => updateSession(phone, updates),
    sendMessage: (chatId, text) => sendMessage(chatId, text),
    sendRecap: async (phone, chatId, prefix) => {
      await updateSession(phone, { onboardingStep: "client_confirm_intake" });
      const snap = await db.collection("agent_sessions").doc(phone).get();
      const summary = buildIntakeSummary(((snap.data() ?? {}) as AgentSession).onboardingData ?? {});
      await sendMessage(chatId, prefix ? `${prefix}\n\n${summary}` : summary);
    },
    isMedicationInstruction: (t) => isMedicationInstructionText(t),
    medicationMessage: MEDICATION_INSTRUCTION_TEXT,
    today: () => ({ iso: businessTodayStr(), weekday: new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long" }) }),
  };
}

/** Run one family-intake turn (text, or "__RESUME__" to re-ask the current question). */
export async function runFamilyIntake(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  return runFamilyIntakeTurn(familyIntakeDeps(), { phone, chatId, text, session });
}

/** The first thing to ask a family — the first step the site record and the draft leave unanswered; null when nothing is left. */
export async function familyFirstQuestion(session: AgentSession): Promise<string | null> {
  const deps = familyIntakeDeps();
  const d = await effectiveFamilyData(deps, session);
  const step = nextFamilyStep(d);
  return step ? familyQuestion(step, d) : null;
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
  const { inboundLocation, inboundMedia } = opts; // opts.service: only the deleted correction re-ask read it (2026-10-11)

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
      await updateSession(phone, { onboardingStep: "ask_role", waitlisted: false, userType: null, onboardingData: {}, bgcheckInviteUrl: null, bgcheckInviteSentAt: null });
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
    await updateSession(phone, { onboardingStep: "ask_role", onboardingData: {}, userType: null, waitlisted: false, bgcheckInviteUrl: null, bgcheckInviteSentAt: null });
    await sendMessage(chatId,
      "No problem, let's start fresh.\n\n" +
      "Are you looking for care for a loved one, or are you a care provider looking for work?"
    );
    return;
  }

  // ── Strict LINK keyword at a parked awaiting step (U9) ──────────────────────
  // The resend-cooldown copy promises "reply LINK and I'll resend it" — honor
  // it deterministically, BEFORE any LLM classification ("send it again"
  // classifies `other`, and classifier failure DEFAULTS to `other`, so during
  // a cooldown the escape hatch must not depend on a model call). Scoped to
  // the gate-parked awaiting steps only; anywhere else "LINK" flows through
  // normal handling.
  if (norm === "LINK" && isGateLinkKeywordStep(step)) {
    if (await handleGateLinkKeyword(phone, chatId, step, session)) return;
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

  // ── The family intake script (2026-10-20): every family collection turn ─────
  // One process that follows the site. A legacy loop cursor (client_ask_*) is
  // routed here too — the script recomputes the next unanswered step itself.
  if (session.userType !== "caregiver" && (isFamilyScriptStep(step) || LEGACY_CLIENT_COLLECTION_STEPS.includes(step))
      && !(inboundMedia && text === "")) {
    return runFamilyIntake(phone, chatId, text, session);
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
      && !step.endsWith("_awaiting_identity") && !step.endsWith("_awaiting_mvr")
      // Post-collection browsing (matches shown, deciding on membership) — a
      // family asking "any more caregivers?" here was live-caught getting
      // misread as "I'm a caregiver looking for work," wiping their whole
      // intake and dumping them back to ask_role (2026-09-06). Established
      // accounts past intake-confirm never need role-switch detection.
      && step !== "client_ask_plan") {
    const switchTo = await detectRoleSwitch(text, session.userType ?? null);
    if (switchTo) {
      await updateSession(phone, {
        onboardingStep: "ask_role",
        userType:        null,
        onboardingData:  {},
      });
      await sendMessage(chatId,
        switchTo === "caregiver"
          ? "Got it, let's switch you over. Just to be sure I've got it right — are you a care provider looking for work, or did you mean you need care for a loved one?"
          : "Got it, let's switch you over. Just to be sure I've got it right — do you need care for a loved one, or did you mean you're a care provider looking for work?"
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
      // Re-ask: the per-step question map that used to sit here (client_ask_* /
      // caregiver_ask_* re-asks) was unreachable — every collection-step turn is
      // routed to the agent loop by shouldRouteOnboardingToLoop before
      // handleOnboardingStep runs (loop-only, 2026-07-08), so this block only
      // ever sees the KEPT steps (verify_phone, client_ask_plan, the awaiting
      // steps not excluded above), none of which had an entry. Deleted
      // 2026-10-11; the generic line is what those steps always got.
      await sendMessage(chatId, "Got it — updated.\n\nCould you continue where we left off?");
      return;
    }
  }

  // Route to the appropriate step handler
  switch (step) {
    case "verify_phone":          return handleVerifyPhone(phone, chatId, text, session);
    case "ask_role":              return handleAskRole(phone, chatId, text, session);
    // client_ask_name/senior/needs/location/schedule: deleted (loop-only) — the
    // agent loop owns client collection. A collection-step cursor never reaches
    // this switch (webhook routes it to the loop); the defensive default below
    // covers any stray cursor.
    // client_ask_start/preferences/budget: removed — the site's wizard never
    // collected them; complete_collection hands straight to client_confirm_intake.
    case "client_confirm_intake":   return handleClientConfirmIntake(phone, chatId, text, session);
    case "client_ask_plan":       return handleClientPlanReply(phone, chatId, text, session);
    case "client_send_payment":   return handleClientSendPayment(phone, chatId, session);
    // caregiver_awaiting_identity: REMOVED (U12, R17) — the step was retired and
    // both of its handlers only forwarded to caregiver_send_bgcheck. A stale
    // prod session still parked on the string falls through to the defensive
    // default below (absorber path), which never crashes and never wipes state.
    case "client_awaiting_identity": {
      // Check the LIVE fact FIRST, before ANYTHING else — including the
      // "show me more caregivers" branch, whose reminder text otherwise
      // unconditionally claims identity still isn't done even when it
      // genuinely already cleared (2026-09-06 live bug: "do you have more
      // caregivers" hit that branch and got told to finish a gate that had
      // already cleared). Nothing in this case should ever run before this
      // check — a genuinely already-cleared gate (webhook missed) must
      // never be followed by a resend or a "still verifying"/"finish this
      // first" nudge, regardless of what the reply says.
      const liveIdentityFact = await LIVE_GATE_FACT_BUILDERS.client_awaiting_identity(phone, session);
      if (liveIdentityFact.includes("VERIFIED")) {
        // Identity cleared but step never advanced (webhook missed or admin override
        // callable unreachable). Drive the same path as the Stripe Identity webhook.
        await advanceOnboardingStep(phone, "identity", "");
        return;
      }
      if (await wantsMoreCaregivers(text)) {
        await sendMoreCaregiversDuringGate(phone, chatId, session,
          "you'll still need to finish that quick identity check before we can move forward with anyone");
        return;
      }
      const idReplyKind = await classifyAwaitingReply(text, "wait for their identity verification to clear");
      if (idReplyKind === "ack") {
        await sendAwaitingAck(chatId, session,
          "The family member just acknowledged your last message (a thanks or 'sounds good') while their identity verification is in progress — you'll send their care provider options as soon as it clears.",
          "You're welcome! I'll send your care provider options as soon as it clears.");
        return;
      }
      if (idReplyKind === "question") {
        // Identity links expire and only the 7-day stale nudge could re-mint
        // one — a "link doesn't work / never got it" report earns a fresh
        // link right now. Status questions ("how long?") stay answer-only:
        // they may have already submitted and just be waiting on Stripe.
        const idAnswer = await answerQuestionMidFlow(text, session, phone);
        await sendMessage(chatId, idAnswer);
        if (await wantsGateLinkResend(text)) {
          if (await resendGateLink(phone, chatId, "client_awaiting_identity", "client_identity",
            "Here's a fresh link for the quick 30-second identity check:")) return;
        }
        await runGateLinkNet(phone, chatId, session, idAnswer);
        return;
      }
      if (await tryAbsorbClientGateUpdate(phone, chatId, text, session,
        "the quick identity check — I'll send your care provider options as soon as it clears")) return;
      if (await wantsGateLinkResend(text)) {
        if (await resendGateLink(phone, chatId, "client_awaiting_identity", "client_identity",
          "Here's a fresh link for the quick 30-second identity check:", { throttled: true })) return;
      }
      const msgIdentity = await generateCaraMessage({
        audience: "family",
        context: `The family member just texted: "${text}". ` +
          "Reassure them it's still being verified and that Evia will send their care provider options as soon as it clears.",
        fallback: "Still verifying — I'll send your care provider options as soon as it clears.",
        maxTokens: 80,
      });
      await sendMessage(chatId, msgIdentity);
      await runGateLinkNet(phone, chatId, session, msgIdentity);
      return;
    }
    case "client_awaiting_payment": {
      // Check the LIVE fact FIRST, before ANYTHING else — including the
      // "show me more caregivers" branch, whose reminder text otherwise
      // unconditionally claims membership still isn't done even when it
      // genuinely already cleared (2026-09-06 live bug: "do you have more
      // caregivers available" hit that branch and got told to finish
      // membership that had already gone through — confirmed live on the
      // website's own dashboard). Nothing in this case should ever run
      // before this check — a genuinely already-cleared gate (webhook
      // missed) must never be followed by a resend or a "still waiting"/
      // "finish this first" nudge, regardless of what the reply says.
      const liveClientPayFact = await LIVE_GATE_FACT_BUILDERS.client_awaiting_payment(phone, session);
      if (liveClientPayFact.includes("WENT THROUGH")) {
        // Payment landed but step never advanced (webhook missed or admin override
        // callable unreachable). Drive the same path as the Stripe webhook.
        const subId = (session as any).stripeSubscriptionId as string | undefined;
        if (subId) {
          await advanceOnboardingStep(phone, "payment", subId);
        } else {
          await advanceOnboardingStep(phone, "admin_payment_override", "");
        }
        return;
      }
      if (await wantsMoreCaregivers(text)) {
        await sendMoreCaregiversDuringGate(phone, chatId, session,
          "you'll still need to finish your membership setup via the link I sent before we can move forward with anyone");
        return;
      }
      const payReplyKind = await classifyAwaitingReply(text, "finish their payment setup via the link Evia sent");
      if (payReplyKind === "ack") {
        await sendAwaitingAck(chatId, session,
          "The family member just acknowledged your payment-setup ask (a thanks or 'will do') — you're here when it's done.",
          "Sounds good — I'm here when it's done!");
        return;
      }
      if (payReplyKind === "question") {
        const payAnswer = await answerQuestionMidFlow(text, session, phone);
        await sendMessage(chatId, payAnswer);
        // Only resend the link if they're actually asking for it again
        // ("doesn't work", "never got it") — a plain status question just
        // answered must never be followed by resending the very link the
        // answer said isn't needed.
        if (await wantsGateLinkResend(text)) {
          if (await resendGateLink(phone, chatId, "client_awaiting_payment", "client_payment",
            "Here's your membership link again — it takes about 30 seconds:")) return;
        }
        await runGateLinkNet(phone, chatId, session, payAnswer);
        return;
      }
      if (await tryAbsorbClientGateUpdate(phone, chatId, text, session,
        "finishing your membership setup via the link I sent — it takes about 30 seconds")) return;
      if (await resendGateLink(phone, chatId, "client_awaiting_payment", "client_payment",
        "Here's your membership link again — it takes about 30 seconds:", { throttled: true })) return;
      const clientPayNudge = await generateCaraMessage({
        audience: "family",
        language: session.preferredLanguage === "es" ? "es" : "en",
        context: `The family member just texted: "${text}". ` +
          "Warmly nudge them to tap the link you already sent to finish up (it only takes about 30 seconds).",
        fallback: "I'm still waiting for your payment setup to complete. Tap the link I sent to finish up — it only takes 30 seconds! 💳",
        maxTokens: 70,
      });
      await sendMessage(chatId, clientPayNudge);
      await runGateLinkNet(phone, chatId, session, clientPayNudge);
      return;
    }
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
    case "job_confirm_post":     return handleJobConfirmPost(phone, chatId, text, session);
    // caregiver_ask_name … caregiver_ask_bio: deleted (loop-only) — the agent loop
    // owns caregiver collection. These cursors never reach this switch (webhook
    // routes them to the loop); the defensive default below covers strays. The
    // gate steps below (send_photo onward) are KEPT — the loop hands off to them.
    case "caregiver_send_membership":  return handleCaregiverSendMembership(phone, chatId, session);
    case "caregiver_awaiting_membership":
      await handleCaregiverResendMembership(phone, chatId, session, text);
      return;
    case "caregiver_send_bgcheck":    return handleCaregiverSendBgcheck(phone, chatId, session, text);
    case "caregiver_awaiting_bgcheck_consent":
      await handleCaregiverResendBgcheckConsent(phone, chatId, session, text);
      return;
    case "caregiver_awaiting_bgcheck": {
      // A plain "thanks / sounds good" is NOT a status inquiry — re-explaining
      // the Checkr flow at someone who just acknowledged it reads as not
      // listening (founder report, 2026-07-09).
      const bgReplyKind = await classifyAwaitingReply(text, "finish the background-check form Checkr emailed them (Evia texts them the moment results are in)");
      if (bgReplyKind === "ack") {
        await sendAwaitingAck(chatId, session,
          "The care provider just acknowledged your last message (a thanks or 'sounds good') while their background check is with Checkr — you'll text them the moment results are in.",
          "Anytime! I'll text you the moment your results are in.");
        return;
      }
      // Live fact next: a check that cleared while the step never advanced
      // (Checkr webhook missed / admin override unreachable) drives the same
      // path as the Checkr webhook — before any reply is composed.
      const liveBgFact = await buildLiveBgcheckFact(session);
      if (liveBgFact.includes("CLEARED")) {
        await advanceOnboardingStep(phone, "background_check", "clear");
        return;
      }
      // The step's own copy promises "I can text the link too — just ask" —
      // honor it: a link ask or a missing/broken-link report gets the stored
      // Checkr invitation (or the consent page pre-authorization) for real.
      if (await wantsGateLinkResend(text)) {
        if (await resendGateLink(phone, chatId, "caregiver_awaiting_bgcheck", "caregiver_background_check",
          "Here's your background-check link:", bgReplyKind === "question" ? {} : { throttled: true })) return;
      }
      if (bgReplyKind !== "question" && await tryAbsorbGateProfileUpdate(phone, chatId, text, session,
        "finishing the background-check form Checkr emailed you")) return;
      // Site parity (2026-09-26): everything else runs the real agent with its
      // tools — the website lets them browse jobs and ask anything while Checkr
      // works; the live status rides along in the gate context.
      await dispatchGateTurnToQaAgent(phone, chatId, text, session, "caregiver_awaiting_bgcheck");
      return;
    }
    case "caregiver_send_stripe_connect": return handleCaregiverSendStripeConnect(phone, chatId, session);
    case "caregiver_awaiting_stripe": {
      const stripeReplyKind = await classifyAwaitingReply(text, "set up their payout account via the link Evia sent");
      if (stripeReplyKind === "ack") {
        await sendAwaitingAck(chatId, session,
          "The care provider just acknowledged your payout-setup ask (a thanks or 'will do') — you're here when it's done.",
          "Sounds good — I'm here when it's done!");
        return;
      }
      // Connect links expire fast — a "link doesn't work / never got it"
      // report earns a re-minted link right now (sendOnboardingLink re-mints;
      // expired links must never strand a caregiver until the 7-day nudge).
      if (await wantsGateLinkResend(text)) {
        if (await resendGateLink(phone, chatId, "caregiver_awaiting_stripe", "caregiver_payouts",
          "Here's a fresh payout-setup link:", stripeReplyKind === "question" ? {} : { throttled: true })) return;
      }
      if (stripeReplyKind !== "question" && await tryAbsorbGateProfileUpdate(phone, chatId, text, session,
        "setting up your payout account via the link I sent")) return;
      // Site parity (2026-09-26): everything else runs the real agent with its
      // tools; the live payout status (LIVE / Stripe reviewing / not started)
      // rides along in the gate context so the reply is grounded.
      await dispatchGateTurnToQaAgent(phone, chatId, text, session, "caregiver_awaiting_stripe");
      return;
    }
    default:
      // Loop-only defensive default (2c): a conversational collection-step cursor
      // (*_ask_* other than caregiver_ask_mvr, which has an explicit case
      // above) should never reach the
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
    const answer = await answerQuestionMidFlow(text, session, phone);
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

// One phone, one role, locked at whichever role was picked first — the same
// "never overwrite an existing userType" rule already used by ensureWebAccount
// and createWebOnboardingSession. This check catches a conflict at the very
// first question instead of only at the very end of a full caregiver setup
// (see the users/{uid} parity write guard a few hundred lines down for the
// defense-in-depth version of the same rule).
async function findConflictingRoleAccount(
  phone: string,
  claimedRole: "client" | "caregiver",
): Promise<{ userId: string; role: "client" | "caregiver" } | null> {
  const snap = await db.collection("users").where("phone", "==", phone).limit(5).get();
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (data.userType !== "client" && data.userType !== "caregiver") continue;
    const role = data.userType as "client" | "caregiver";
    if (role === claimedRole) continue;
    // Same "real client progress" test as userHasRealOnboardingProgress
    // (linq/webhooks.ts): a legacy seniorId/seniorIds, OR the wizard's own
    // jobPostingCompleted flag — which is also what Evia's
    // persistClientCareRecords sets (it no longer writes seniorIds).
    const seniorIds = (data.seniorIds as string[] | undefined) ?? [];
    const hasSeniorProgress = !!(data.seniorId as string | undefined) || seniorIds.length > 0
      || data.jobPostingCompleted === true;
    const cgDoc = role === "caregiver" ? await db.collection("caregivers").doc(doc.id).get().catch(() => null) : null;
    const hasRealProgress = role === "client" ? hasSeniorProgress : !!cgDoc?.exists;
    if (hasRealProgress) return { userId: doc.id, role };
  }
  return null;
}

async function handleAskRole(phone: string, chatId: string, text: string, session?: AgentSession): Promise<void> {
  const raw = await parseWithClaude(
    'The user was just asked: "Are you looking for care for a loved one, or are you a care provider yourself?" ' +
    'client = they need care for a LOVED ONE (someone else): "1", "family", "need care", "looking for care", ' +
    '"care for my mom/dad/parent/wife/husband", "for my loved one". ' +
    'self = they need care for THEMSELVES: "for myself", "for me", "I need help at home", "I\'m 78 and need a hand", ' +
    '"it\'s for me". ' +
    'care provider = they PROVIDE care professionally and want work: "2", "I\'m a care provider", "CNA", "HHA", "nurse", ' +
    '"looking for work", "looking for a job", "I want to work". ' +
    'CRITICAL: "looking for care" or "need care" means they NEED care → client (or self if clearly for themselves). ' +
    'Only "looking for WORK" or "looking for a JOB" means care provider. ' +
    'Reply with exactly one word: client, self, or care provider. If truly unclear, reply: unclear',
    text
  );
  const emotionalDirective = (session as any)?._emotionalDirective as string | undefined;

  const claimedRole: "client" | "caregiver" | null =
    raw === "caregiver" ? "caregiver" : (raw === "client" || raw === "self") ? "client" : null;
  if (claimedRole) {
    const conflict = await findConflictingRoleAccount(phone, claimedRole);
    if (conflict) {
      await updateSession(phone, {
        userId:         conflict.userId,
        userType:       conflict.role,
        onboardingStep: "complete",
      });
      const msgConflict = await generateCaraMessage({
        audience: conflict.role === "caregiver" ? "caregiver" : "family",
        context: `This phone number is already registered with us as a ${conflict.role} account, but they just said ` +
          `they're looking for ${claimedRole === "caregiver" ? "care provider work" : "care for a loved one or themselves"} ` +
          `instead — a mismatch with the existing account. Warmly clarify that this number is already set up as a ` +
          `${conflict.role}, and ask what they'd like help with using that existing account. Do NOT start a new signup ` +
          `or ask any onboarding questions.`,
        fallback: conflict.role === "caregiver"
          ? "Looks like this number's already set up with us as a care provider — want help with that account instead of starting a new signup?"
          : "Looks like this number's already set up with us as a family/client account — want help with that account instead of starting a new signup?",
        maxTokens: 90,
        emotionalDirective,
      });
      await sendMessage(chatId, msgConflict);
      return;
    }
    // Cold-SMS parity with /start (createWebOnboardingSession): the site seeds
    // users/{uid} {uid, phone, userType} the moment the phone is verified, so
    // the app can resolve a role on login. The SMS path minted the Auth account
    // at consent but wrote no users doc until much later — a caregiver who
    // signed in mid-onboarding hit "Account connection problem" (live
    // 2026-09-20). Texting Evia IS the connection, so eviaConnected is set too
    // (the web bridge sets it on the first inbound for /start accounts).
    const seededUid = await ensureWebAccount(phone, claimedRole, "");
    if (seededUid) {
      await db.collection("users").doc(seededUid).set(
        { eviaConnected: true, eviaConnectedAt: admin.firestore.Timestamp.now() },
        { merge: true },
      ).catch(() => {/* non-critical */});
    }
    // Same site-signup parity as the web path (webhooks.ts handlePendingConsentReply):
    // the moment role resolves to caregiver, their own caregivers/{uid} record needs
    // to exist so the site's dual-channel wizard has something to load and its
    // "still incomplete" gate can find (2026-09-23). Idempotent; safe this early —
    // onboardingData is still empty, and every mirrored field is copy-if-present.
    if (claimedRole === "caregiver") {
      await ensureCaregiverDocForOnboarding(phone).catch((err) =>
        console.error("handleAskRole: caregiver doc pre-create failed", err));
    }
  }

  if (raw === "self") {
    // Senior seeking care for THEMSELVES — the texter IS the care recipient.
    // Pre-fill relationship (and senior name when known) so no step ever asks
    // "who are you caring for", and every reply speaks to them directly.
    const knownName = (session?.onboardingData?.firstName as string | undefined)?.trim();
    // "self" is Evia's OWN internal sentinel (checked throughout
    // onboardingSteps.client.ts/qaAgent.ts/careRecipients.ts for self-referential
    // voice/logic) — NOT the same value space as the website's relationship enum
    // (myself/parent/spouse/other). The translation to "myself" happens at the
    // website-facing write boundary (clientJobPostingContract.ts), not here.
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
          `acknowledge them BY NAME and ask what kind of help would make day-to-day easier (never their age).`,
        fallback: `Thanks, ${knownName} — I'd love to help you directly. What would you like a hand with day to day?`,
        maxTokens: 90,
        emotionalDirective,
      });
      await sendMessage(chatId, msgSelf);
      return;
    }
    await updateSession(phone, { onboardingStep: "family_ask_name", userType: "client" });
    const msgSelfName = await generateCaraMessage({
      audience: "family",
      context: "Someone just said they're looking for care for THEMSELVES. You ALREADY introduced yourself in the " +
        "previous message — do NOT say your name or re-introduce yourself. Speak to them directly and warmly ask " +
        "their name. Mention — once, casually — that a voice memo works instead of typing if that's easier.",
      fallback: "I'd be glad to help you directly. What's your first and last name? And anytime typing feels like a pain, just send me a voice memo — I'll listen.",
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
      await updateSession(phone, { onboardingStep: "family_ask_frequency", userType: "client" });
      // The first question is the site's first step (fixed text), never model prose (2026-10-20).
      const firstQ = await familyFirstQuestion({ ...session, userType: "client" } as AgentSession);
      await sendMessage(chatId, `Thanks, ${knownName}. ${firstQ ?? "How often do you need care — occasional, part-time, or full-time?"}`);
      return;
      // (unreachable — kept so the surrounding block's shape is unchanged)
      const msgKnown = await generateCaraMessage({
        audience: "family",
        context: `${knownName} just said they're looking for care for a loved one, and you already know their name is ${knownName}. ` +
          `You ALREADY introduced yourself — never say "I'm Evia" or re-introduce yourself. ` +
          `Warmly acknowledge them BY NAME — do NOT ask their name again — then ask the wizard's first question: how often ` +
          `they need care — occasional, part-time, or full-time. Mention — once, casually — that they ` +
          `can also just send a voice memo instead of typing, and you'll listen.`,
        fallback: `Thanks, ${knownName}. How often do you need care — occasional, part-time, or full-time? (And if typing it all out is a pain, just send me a voice memo — I'll listen.)`,
        maxTokens: 80,
        emotionalDirective,
      });
      await sendMessage(chatId, msgKnown);
      return;
    }
    await updateSession(phone, { onboardingStep: "family_ask_name", userType: "client" });
    const msg1 = await generateCaraMessage({
      audience: "family",
      context: "A new family member just said they're looking for care for a loved one. You ALREADY introduced " +
        "yourself in the previous message — do NOT say your name or re-introduce yourself. Warmly ask for " +
        "their name, and mention — once, casually — that if typing it all out ever feels like a pain, they can " +
        "just send you a voice memo and you'll listen.",
      fallback: "I'd love to help. What's your first and last name? And anytime typing feels like a pain, just send me a voice memo — I'll listen.",
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
        context: `${knownName} just said they're a care provider looking for work, and you already know their name is ${knownName}. ` +
          `You ALREADY introduced yourself — never say "I'm Evia" or re-introduce yourself. ` +
          `Warmly acknowledge them BY NAME — do NOT ask their name again — let them know setup takes about 3 minutes right here, ` +
          `then ask the first question — their street address, city, and zip code (families only ever see the city).`,
        fallback: `Great, ${knownName}! Setup takes about 3 minutes, all right here. What's your street address, city, and zip code? (Families only ever see the city.)`,
        maxTokens: 90,
        emotionalDirective,
      });
      await sendMessage(chatId, msgKnownCg);
      return;
    }
    await updateSession(phone, { onboardingStep: "caregiver_ask_name", userType: "caregiver" });
    const msg2 = await generateCaraMessage({
      audience: "caregiver",
      context: "A new care provider just said they're looking for work. You ALREADY introduced yourself in the previous " +
        "message — do NOT say your name or re-introduce yourself. Let them know profile setup takes about 3 minutes " +
        "and everything happens right here over text. Then ask their first and last name (once).",
      fallback: "Great — let's get your profile set up. Takes about 3 minutes and everything happens right here.\n\nWhat's your first and last name?",
      maxTokens: 80,
      emotionalDirective,
    });
    await sendMessage(chatId, msg2);
    return;
  }
  await sendMessage(chatId,
    "Just so I point you the right way, are you looking for care for a loved one, or are you a care provider looking for work?"
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
  opts:    { absorb?: boolean } = {},
): Promise<void> {
  const existing = (session.onboardingData ?? {}) as Record<string, unknown>;
  // A synthetic system note (upload resume) carries no caregiver answer — skip
  // the absorber so nothing in the note can be misread as a field.
  const absorbed = opts.absorb === false
    ? {}
    : role === "caregiver"
      ? await (await import("./caregiverFieldAbsorber")).absorbCaregiverFields(text, existing).catch(() => ({}))
      : await absorbClientFields(text, existing).catch(() => ({}));
  if (Object.keys(absorbed).length > 0) {
    await mergeOnboardingData(phone, absorbed);
    session.onboardingData = { ...existing, ...absorbed };
  }
  const { runQaAgent } = await import("./qaAgent");
  const toolCalls: string[] = [];
  await runQaAgent({
    text,
    phone,
    chatId,
    _toolCallsOut: toolCalls,
    userId:      (session as any).userId ?? "",
    seniorId:    (session as any).seniorId ?? "",
    userType:    role,
    zepThreadId: (session as any).zepThreadId as string | undefined,
    session:     session as unknown as Record<string, unknown>,
    onboardingMode: true,
    onboardingRole: role,
    intent:      null,
  });
  if (role === "caregiver") {
    const afterData = ((await db.collection("agent_sessions").doc(phone).get()).data()?.onboardingData ?? {}) as Record<string, unknown>;
    await sendUploadLinkIfBlocked(phone, chatId, afterData, { toolCallsThisTurn: toolCalls })
      .catch((err) => console.error("dispatchOnboardingToLoop: upload backstop failed", err instanceof Error ? err.message : err));
  }
  // Collection may have completed on this handed-off turn — e.g. the user
  // front-loaded every remaining field in the same message that also confirmed
  // their name. Drive the post-collection handoff so the next phase actually
  // fires; otherwise the loop's closing line ("here's your photo link" / "let me
  // show you caregivers") is a promise with nothing behind it until the user
  // happens to text again.
  await drivePostCollectionHandoff(phone, chatId, role);
}

// ── Profile-complete stamp — the site wizard's bio-save moment, as data ────────
// ONE writer for what the website writes when its wizard finishes:
// onboardingStatus 'profile_complete' + wizardStep 'done' (+ verificationStatus
// 'profile_complete' unless a terminal state is already recorded). The website
// shows the setup wizard whenever onboardingStatus !== 'profile_complete'
// (App.tsx CaregiverRoute), so every path that ends Evia's collection must
// write this — complete_collection did, but the stuck-signup nets (the model
// collected everything and never called complete_collection) only moved the
// session cursor, leaving the record on 'in_progress' and the website re-opening
// the wizard for a caregiver who had finished by text (founder, 2026-09-26).
export async function stampCaregiverProfileComplete(caregiverId: string | undefined | null): Promise<void> {
  if (!caregiverId) return;
  if (isOnboardingDryRun()) {
    recordSideEffect("firestore.set:caregivers.profile_complete", { caregiverId });
    return;
  }
  const cgRef = db.collection("caregivers").doc(caregiverId);
  const currentV = (await cgRef.get()).data()?.verificationStatus as string | undefined;
  const TERMINAL = ["submitted", "approved", "rejected", "pre_adverse_action", "checkr_clear", "pending", "info_requested"];
  await cgRef.set({
    onboardingStep: 2,
    onboardingStatus: "profile_complete",
    wizardStep: "done",
    ...(!currentV || !TERMINAL.includes(currentV) ? { verificationStatus: "profile_complete" } : {}),
  }, { merge: true }).catch((err) => console.error("stampCaregiverProfileComplete: write failed (non-fatal):", err));
}

// ── Gate-step turn → the normal tool-bearing agent ────────────────────────────
// "Evia acts like the site" (founder, 2026-09-26): the website lets a caregiver
// whose membership / background check / payouts are still pending browse
// EVERYTHING (Nearby Jobs, the Jobs board, applications, profile) and blocks
// only actions, via hooks/useCaregiverGate.tsx. Before this, a caregiver parked
// at a gate step got tool-less canned answers ("I'll match you once your
// payment goes through") and the gate link re-blasted on every question. Now
// anything that isn't an ack / a LINK ask / a profile addition runs the real
// agent with its tools; the caregiver action tools enforce the site's gate
// themselves (caregiverAccessGate.ts) and text the modal copy + link on a block.
async function dispatchGateTurnToQaAgent(
  phone:   string,
  chatId:  string,
  text:    string,
  session: AgentSession,
  step:    string,
): Promise<void> {
  const liveBuilder = LIVE_GATE_FACT_BUILDERS[step];
  const liveFact = liveBuilder ? await liveBuilder(phone, session).catch(() => "") : "";
  const staticFacts = STEP_QUESTION_FACTS[step] ?? "";
  const cgId = ((session as any).caregiverId ?? session.userId) as string | undefined;
  let canonicalProfile: Record<string, unknown> | null = null;
  if (cgId) {
    try {
      const cgDoc = await db.collection("caregivers").doc(cgId).get();
      canonicalProfile = cgDoc.exists ? (cgDoc.data() as Record<string, unknown>) : null;
    } catch { /* fail-soft — the session snapshot still grounds the reply */ }
  }
  const shared = describeSharedProfile(session, canonicalProfile);
  (session as any).__gateContext = [
    `CARE PROVIDER MID-SETUP (${step}). Their profile is done; what's left is the website dashboard's three cards, in order: ` +
      `membership → background check → payouts. Exactly like the website, they can browse and ask about anything right now — ` +
      `nearby jobs, their applications, their profile, how things work — so use your tools. The actions the website blocks until ` +
      `setup is done (applying, accepting an interview or booking, starting or logging a shift, messaging a family) are blocked ` +
      `by the tools themselves: when a tool returns MEMBERSHIP_REQUIRED / BACKGROUND_REQUIRED / TRANSPORT_REQUIRED, ` +
      `Evia has ALREADY texted them that step and its link — add nothing about it.`,
    liveFact    ? `LIVE STATUS RIGHT NOW: ${liveFact}` : "",
    staticFacts ? `HOW THIS STEP WORKS: ${staticFacts}` : "",
    shared,
    `Never say a link is coming or that you'll send one — if they want their setup link, call send_onboarding_link ` +
      `(caregiver_membership / caregiver_background_check / caregiver_payouts) and then confirm. ` +
      `Don't nag about the pending step unless they ask about it or try something it blocks.`,
  ].filter(Boolean).join("\n");
  const { runQaAgent } = await import("./qaAgent");
  await runQaAgent({
    text,
    phone,
    chatId,
    userId:      cgId ?? "",
    seniorId:    "",
    userType:    "caregiver",
    caregiverId: cgId,
    zepThreadId: (session as any).zepThreadId as string | undefined,
    session:     session as unknown as Record<string, unknown>,
    intent:      null,
  });
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

// The profile photo landed while the caregiver is
// mid-collection: pick the conversation back up with the next question.
//
// 2026-09-26: this used to re-enter the scripted runner with the "__RESUME__"
// sentinel — but collection steps have no scripted handler any more (loop-only),
// so every upload fell into the runner's defensive default and texted "I didn't
// catch that last part, can you send it again?" instead of continuing. The loop
// owns collection, so hand it the turn directly with a system note (never
// absorbed as an answer); its directive sees the upload as ✓ and asks the next
// STILL NEEDED item.
export async function resumeCaregiverCollection(
  phone: string,
  chatId: string,
): Promise<void> {
  try {
    const fresh = (await db.collection("agent_sessions").doc(phone).get()).data() as AgentSession | undefined;
    if (!fresh) return;
    const note = "[System note — this is NOT a message from the care provider: they just uploaded their profile photo through the secure link and it is saved. In ONE short warm line say the photo is in, then ask the next STILL NEEDED item. Never ask them to resend or repeat anything.]";
    await dispatchOnboardingToLoop(phone, chatId, note, { ...fresh, chatId } as AgentSession, "caregiver", { absorb: false });
  } catch (err) {
    console.error("resumeCaregiverCollection failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Deterministic upload-link backstop. profilePhoto is "never typed" — while it
 * is the next missing item, the ONLY correct action is to (re)send its upload
 * link. The agent-tier model was live-caught (2026-09-26)
 * declaring the tool "unavailable in this chat" or narrating "using the secure
 * link" without ever calling send_onboarding_link, so the link is sent here
 * whenever the model didn't send it this turn. Reuses the gate-link cooldown:
 * a repeat ping resends at most once per window. Returns true when it acted.
 */
export async function sendUploadLinkIfBlocked(
  phone: string,
  chatId: string,
  data: Record<string, unknown>,
  opts: { toolCallsThisTurn?: string[] } = {},
): Promise<boolean> {
  const next = missingRequiredFields("caregiver", data)[0];
  if (next !== "profilePhoto") return false;
  if (opts.toolCallsThisTurn?.includes("send_onboarding_link")) return false;
  const linkType = "caregiver_photo" as const;
  const { runSendOnboardingLinkAction } = await import("./actions/sendOnboardingLinkAction");
  const result = await runSendOnboardingLinkAction(
    { phone, linkType },
    { caller: "webhook", role: "caregiver", phone },
  ).catch((err) => {
    console.error("sendUploadLinkIfBlocked: send failed", err instanceof Error ? err.message : err);
    return null;
  });
  if (!result) return false;
  if (result.throttled) {
    const mins = result.minutesSinceLastSend ?? 1;
    await sendMessage(chatId, `That link already went out about ${mins} minute${mins === 1 ? "" : "s"} ago — give it a moment to arrive. Still nothing? Just say so and I'll resend it.`);
  } else if (result.sent) {
    await sendMessage(chatId, "Here's your secure upload link — tap it to add a photo, that helps families choose you.");
  }
  return true;
}

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
    // The website's wizard-finished stamp, same as complete_collection writes.
    if (role === "caregiver") {
      await stampCaregiverProfileComplete((after.caregiverId ?? after.userId) as string | undefined);
    }
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
// The client step table (onboardingSteps.client.ts) is kept ONLY for its
// reask() text, used by currentStepQuestion above when a family greets mid-flow.
// Nothing runs on the table-driven runner anymore: the loop owns collection and
// the legacy post-collection steps were removed (see the import note at the top).
const CLIENT_STEPS = buildClientSteps({
  generateCaraMessage,
  locationPrompt,
});

// Plain-text playback of everything Evia captured — a confirmation gate before
// the paywall so a parse error can't slip through unnoticed.
function buildIntakeSummary(d: Record<string, unknown>): string {
  const seniorName = (d.seniorName as string) || "your loved one";
  // Care needs only — diagnoses/conditions are never collected (non-medical scope).
  const conditions = Array.isArray(d.careNeeds) && (d.careNeeds as string[]).length
    ? describeCareNeeds(d.careNeeds as string[])
    : "";
  // Full street address (2026-08-24), not just city+zip — a wrong house number
  // or street name is a real, consequential mistake (a caregiver can't find
  // the door), unlike city/zip alone confirming just the general area.
  const loc   = [d.street as string | undefined, [d.city, d.zipCode].filter(Boolean).join(" ")]
    .filter(Boolean).join(", ");
  // selectedDays (array, e.g. ['MON','WED','FRI']) is the current loop field —
  // daysPerWeek is a legacy/caregiver-side field that the client loop no
  // longer writes, so reading only daysPerWeek silently dropped schedule info
  // from this summary for every loop-collected signup.
  const days  = Array.isArray(d.selectedDays) && (d.selectedDays as string[]).length
    ? (d.selectedDays as string[]).join("/") + (d.daysFlexible === true ? " (flexible)" : "")
    : d.daysFlexible === true
      ? "flexible days"
      : d.daysPerWeek ? `${d.daysPerWeek} day${Number(d.daysPerWeek) === 1 ? "" : "s"}/week` : "";
  const tod   = Array.isArray(d.timeOfDay) ? (d.timeOfDay as string[]).join("/") : (d.timeOfDay as string) || "";
  const sched = [days, tod].filter(Boolean).join(", ");
  // startDate is stored as the wizard's ISO yyyy-mm-dd — read it back in
  // family words: today → "as soon as possible", otherwise "September 30, 2026".
  const startIso = normalizeStartDateToISO(d.startDate);
  const start = startIso
    ? (startIso === businessTodayStr() ? "as soon as possible" : formatDateForDisplay(startIso))
    : "";
  // rate is always a number (the wizard has no "flexible" option).
  const rateNum = coerceClientRate(d.rate);
  const budget = rateNum !== null
    ? `$${rateNum}/hr ($${(Math.round(rateNum * 1.09 * 100) / 100).toFixed(2)}/hr billed incl. the 9% service fee)`
    : "";

  const pieces: string[] = [];
  // Multi-recipient household: name everyone so the family can catch a missed
  // person at the confirmation gate.
  // Everyone on the roster, with relationship and a child's stage (2026-10-20); the
  // care types are the post's one list, after the people.
  const extraRecipients = normalizeAdditionalRecipients(d.additionalRecipients);
  const recipientLabel = rosterFromData(d).length ? describeRoster(d) : seniorName;
  pieces.push(`care for ${recipientLabel}${conditions ? ` — ${conditions}` : ""}`);
  void extraRecipients;
  if (loc) pieces.push(`in ${loc}`);
  if (sched) pieces.push(sched);
  if (start) pieces.push(`starting ${start}`);
  if (budget) pieces.push(`budget ${budget}`);
  // The wizard's "What would you like caregivers to know" answer — the Care Plan
  // page shows it as the recipient's Notes, so the family sees it here too.
  if (typeof d.jobDescription === "string" && d.jobDescription.trim()) pieces.push(`note for care providers: "${d.jobDescription.trim()}"`);

  return `Here's what I've got: ${pieces.join("; ")}. Did I get that right? Say yes and I'll show you who can help, or tell me what to fix.`;
}

async function sendClientIntakeSummary(chatId: string, session: AgentSession): Promise<void> {
  await sendMessage(chatId, buildIntakeSummary(session.onboardingData ?? {}));
}

// Pull any corrected intake fields out of a free-text edit at the confirm step.
async function extractIntakeCorrections(text: string): Promise<Record<string, unknown>> {
  // Anchor relative dates to the real business-date "today" so "next Monday"
  // resolves correctly (same technique as jobPostingFlow's start-date step).
  const todayIso = businessTodayStr();
  const todayDow = new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long" });
  const raw = await parseWithClaude(
    `Today is ${todayDow}, ${todayIso}. The family is correcting their care intake. Extract ONLY the fields they're changing; omit the rest. ` +
    "Return raw JSON with any of: {\"seniorName\":\"\",\"careNeeds\":[],\"ageRange\":\"\",\"city\":\"\"," +
    "\"zipCode\":\"\",\"selectedDays\":[],\"daysFlexible\":false,\"timeOfDay\":\"\",\"startDate\":\"\",\"rate\":0,\"relationship\":\"\"," +
    "\"emergencyContactName\":\"\",\"emergencyContactPhone\":\"\",\"firstName\":\"\"," +
    "\"daysPerWeek\":0,\"hoursPerDay\":0}. " +
    "selectedDays is an array of uppercase 3-letter day codes e.g. ['MON','WED','FRI']. rate is a NUMBER of dollars per hour " +
    "(never a word). startDate is YYYY-MM-DD relative to today, or \"ASAP\" if they want it right away. " +
    "relationship is one of: myself, parent, spouse, adult child (a grown son or daughter), child, other. " +
    `ageRange (a child only) is one of: ${AGE_RANGES.map((a) => a.label).join(", ")}. ` +
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
      // Same value rules save_onboarding_field enforces: rate must be a
      // positive number; startDate must canonicalize to the wizard's ISO date;
      // the emergency phone takes the wizard's (555) 000-0000 shape (≥10 digits).
      if (k === "rate") {
        const n = coerceClientRate(v);
        if (n !== null) out.rate = n;
        continue;
      }
      if (k === "startDate") {
        const iso = normalizeStartDateToISO(v);
        if (iso) out.startDate = iso;
        continue;
      }
      if (k === "emergencyContactPhone") {
        const formatted = formatWizardPhone(v);
        if (formatted) out.emergencyContactPhone = formatted;
        continue;
      }
      // relationship must go through the same canonicalization
      // save_onboarding_field applies (daughter/son/child/mother/etc. →
      // parent, wife/husband/partner → spouse) — this edit path writes
      // directly via mergeOnboardingData, bypassing that tool entirely.
      out[k] = (k === "relationship" || k === "ageRanges" || k === "ageRange") ? normalizeOnboardingFieldValue(k, v) : v;
    }
    return out;
  } catch {
    return {};
  }
}

/** "fix the note" with the new text in the same message → that text; a bare ask → null; "remove it" → "". */
async function noteReplacementFromReply(text: string): Promise<string | null> {
  const raw = await parseWithClaude(
    'The family asked to change the short note care providers read about the job. If their message CONTAINS the new note text (e.g. "change the note to: mom needs help mornings", "the note should say …"), return ONLY that text, verbatim, nothing else. ' +
    'If they want the note removed, return exactly NONE. If they only asked to change it without giving the new text, return exactly EMPTY.',
    text,
  ).catch(() => "EMPTY");
  const t = raw.trim();
  if (!t || t.toUpperCase() === "EMPTY") return null;
  if (t.toUpperCase() === "NONE") return "";
  return t.slice(0, 2500);
}

async function handleClientConfirmIntake(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  if ((session as unknown as Record<string, unknown>).clientIntakeAwaitingNote === true) {
    const clear = () => db.collection("agent_sessions").doc(phone).update({ clientIntakeAwaitingNote: admin.firestore.FieldValue.delete() }).catch(() => {});
    const norm = text.trim().toUpperCase();
    const isNone = norm === "NONE" || norm === "REMOVE" || norm === "REMOVE IT";
    if (!isNone && await isQuestionOrOther(text, "What should the note say instead?")) {
      // A question mid-step is answered; the note question stays parked.
      const answer = await answerQuestionMidFlow(text, session, phone);
      await sendMessage(chatId, `${answer}\n\nWhat should the note say instead? (Reply NONE to remove it.)`);
      return;
    }
    await clear();
    const note = isNone ? "" : text.trim().slice(0, 2500);
    await mergeOnboardingData(phone, { jobDescription: note });
    const refreshed = await db.collection("agent_sessions").doc(phone).get();
    await sendMessage(chatId, note ? "Got it — the note is updated." : "Got it — the note is removed.");
    await sendClientIntakeSummary(chatId, refreshed.data() as AgentSession);
    return;
  }
  // "Can I add one more person?" → "Sure — who?" was asked; this reply names them (2026-10-21).
  if ((session as unknown as Record<string, unknown>).confirmRosterAddPending === true) {
    const dAdd = (session.onboardingData ?? {}) as Record<string, unknown>;
    const nameAdd = { first: String(dAdd.firstName ?? "").trim(), last: String(dAdd.lastName ?? "").trim() };
    const clearAdd = () => db.collection("agent_sessions").doc(phone).update({ confirmRosterAddPending: admin.firestore.FieldValue.delete() }).catch(() => {});
    const who = await readRoster(familyIntakeDeps(), text, nameAdd).catch(() => null);
    if (!who) {
      if (await isQuestionOrOther(text, "Who else needs care?")) {
        const answer = await answerQuestionMidFlow(text, session, phone);
        await sendMessage(chatId, `${answer}\n\nWho else needs care? Your relationship to them (Myself, Parent, Spouse or Partner, Adult child, Child, or Other) and their name.`);
        return;
      }
      await sendMessage(chatId, "Sorry, I didn't catch that. Who else needs care? Your relationship to them (Myself, Parent, Spouse or Partner, Adult child, Child, or Other) and their name.");
      return;
    }
    await clearAdd();
    const existing = rosterFromData(dAdd);
    const added = who.roster.filter((x) => !(x.relationship === "self" && existing.some((q) => q.relationship === "self")));
    const merged = [...existing, ...added].slice(0, 4);
    await mergeOnboardingData(phone, { ...dataFromRoster(merged), rosterCountConfirmed: true });
    const refreshedAdd = await db.collection("agent_sessions").doc(phone).get();
    // The script finishes the new person (name / adult-or-child / stage) and offers their care list
    // if it was never shown, then sends the recap itself when nothing is left.
    await sendMessage(chatId, "Got it — added.");
    await runFamilyIntake(phone, chatId, "__RESUME__", refreshedAdd.data() as AgentSession);
    return;
  }
  // One classification for the reply to "Did I get that right?" — every outcome below is handled
  // deterministically (2026-10-21: "who the care is for" and "I want to add additional person" were
  // classed as edits with nothing to extract and fell to the generic fallback twice).
  const kind = await parseWithClaude(
    'Evia sent the family a summary of their care request and asked "Did I get that right?". Classify their reply with exactly one word: ' +
    'confirm — yes / correct / looks good / go ahead. ' +
    'add_person — they want to ADD another person who needs care ("can I add one more person", "I want to add an additional person", "also my dad"), whether or not they say who. ' +
    'change_people — they want to change WHO the care is for without saying who ("who the care is for", "the care recipient needs to be updated", "change the person"). ' +
    'edit — they correct or change a detail that is IN the summary (a day, time, rate, name, address, care need), or RESTATE who the care is for with the people named ("it\'s for me and my child"). ' +
    'fix_note — they want the note / description for care providers changed, rewritten, replaced or removed ("fix the note", "change the note to …", "remove the note"), with or without giving the new text. ' +
    'note — they ADD something for the care providers to know rather than correcting anything (e.g. "my son is amazing", "she loves gardening", "please be patient with him", "he is hard of hearing"). ' +
    'question — they ask something, or say something unrelated. Reply with one word: confirm, add_person, change_people, edit, fix_note, note, or question.',
    text,
  );
  if (kind === "add_person") {
    // If they named the person already, add them now; otherwise ask who.
    const dAddNow = (session.onboardingData ?? {}) as Record<string, unknown>;
    const nameAddNow = { first: String(dAddNow.firstName ?? "").trim(), last: String(dAddNow.lastName ?? "").trim() };
    const whoNow = await readRoster(familyIntakeDeps(), text, nameAddNow).catch(() => null);
    if (whoNow) {
      const existingNow = rosterFromData(dAddNow);
      const addedNow = whoNow.roster.filter((x) => !(x.relationship === "self" && existingNow.some((q) => q.relationship === "self")));
      await mergeOnboardingData(phone, { ...dataFromRoster([...existingNow, ...addedNow].slice(0, 4)), rosterCountConfirmed: true });
      const refreshedNow = await db.collection("agent_sessions").doc(phone).get();
      await sendMessage(chatId, "Got it — added.");
      await runFamilyIntake(phone, chatId, "__RESUME__", refreshedNow.data() as AgentSession);
      return;
    }
    await db.collection("agent_sessions").doc(phone).set({ confirmRosterAddPending: true }, { merge: true }).catch(() => {});
    await sendMessage(chatId, "Sure — who else needs care? Your relationship to them (Myself, Parent, Spouse or Partner, Adult child, Child, or Other) and their name.");
    return;
  }
  if (kind === "change_people") {
    await mergeOnboardingData(phone, { relationship: null, seniorName: null, careKind: null, ageRange: null, primaryKindUnknown: null, additionalRecipients: [], rosterCountConfirmed: null });
    await updateSession(phone, { onboardingStep: "family_ask_recipients" });
    await sendMessage(chatId, "Sure. What is your relationship to the person needing care? Myself, Parent, Spouse or Partner, Adult child, Child, or Other. (If care is for more than one person, you can name them all.)");
    return;
  }
  if (kind === "question") {
    const answer = await answerQuestionMidFlow(text, session, phone);
    await sendMessage(chatId, `${answer}\n\nDoes that all look right? Say yes and I'll show you who can help, or tell me what to fix.`);
    return;
  }
  if (kind === "fix_note") {
    // Live 2026-10-09: "Can you fix the note" was read as a question, the mid-flow answer improvised a
    // "paste the text and tell me the tone" step, and a later "did you fix it" was answered "yes" — nothing had
    // changed. The note is REPLACED (never appended), then the full recap is sent again like any other edit.
    const given = await noteReplacementFromReply(text);
    if (given === null) {
      await db.collection("agent_sessions").doc(phone).set({ clientIntakeAwaitingNote: true }, { merge: true }).catch(() => {});
      await sendMessage(chatId, "Sure — what should the note say instead? Care Providers browsing jobs can read it, so leave out contact info, medical details and addresses. (Reply NONE to remove it.)");
      return;
    }
    await mergeOnboardingData(phone, { jobDescription: given });
    const refreshed = await db.collection("agent_sessions").doc(phone).get();
    await sendMessage(chatId, given ? "Got it — the note is updated." : "Got it — the note is removed.");
    await sendClientIntakeSummary(chatId, refreshed.data() as AgentSession);
    return;
  }
  if (kind === "note") {
    const prev = ((session.onboardingData?.jobDescription as string | undefined) ?? "").trim();
    const note = [prev, text.trim()].filter(Boolean).join(" ").slice(0, 2500);
    await mergeOnboardingData(phone, { jobDescription: note });
    const refreshed = await db.collection("agent_sessions").doc(phone).get();
    await sendMessage(chatId, "Lovely — I'll make sure care providers see that.");
    await sendClientIntakeSummary(chatId, refreshed.data() as AgentSession);
    return;
  }
  const intent = kind === "confirm" ? "confirm" : "edit";
  if (intent === "confirm") {
    const refreshed = await db.collection("agent_sessions").doc(phone).get();
    const rs = refreshed.data() as AgentSession;
    (rs as any)._emotionalDirective = (session as any)._emotionalDirective;
    await handleClientShowCaregivers(phone, chatId, rs);
    return;
  }
  const corrections = await extractIntakeCorrections(text);
  // WHO the care is for goes through the same roster reader the intake uses
  // (2026-10-20): "it's for me and my child" replaces the roster; a child without
  // a name or stage is then asked for, by name, before the recap comes back.
  const d0 = (session.onboardingData ?? {}) as Record<string, unknown>;
  const accountName = { first: String(d0.firstName ?? "").trim(), last: String(d0.lastName ?? "").trim() };
  const rosterRead = await readRoster(familyIntakeDeps(), text, accountName).catch(() => null);
  if (rosterRead) {
    for (const k of ["seniorName", "relationship", "ageRange"]) delete corrections[k];
    // "It's for me and my child" restates the roster (replace); "add my dad" / "myself too" adds to it.
    const mode = await parseWithClaude(
      "The family was shown a summary of their care request and named people. Did they RESTATE who the care is for (reply REPLACE), or ADD someone to the people already listed (reply ADD)? Words like add / also / too / as well mean ADD.",
      text,
    ).catch(() => "REPLACE");
    if (mode.trim().toUpperCase() === "ADD") {
      const existing = rosterFromData(d0);
      const added = rosterRead.roster.filter((x) => !(x.relationship === "self" && existing.some((q) => q.relationship === "self")));
      Object.assign(corrections, dataFromRoster([...existing, ...added].slice(0, 4)), { rosterCountConfirmed: true });
    } else {
      Object.assign(corrections, dataFromRoster(rosterRead.roster), { rosterCountConfirmed: rosterRead.roster.length > 1 ? true : null });
    }
  }
  if (Object.keys(corrections).length > 0) {
    await mergeOnboardingData(phone, corrections);
    const refreshed = await db.collection("agent_sessions").doc(phone).get();
    if (rosterRead) {
      // Finish the roster first (name / adult-or-child / stage, and a newly needed care list), then the recap.
      await sendMessage(chatId, "Got it — updated.");
      await runFamilyIntake(phone, chatId, "__RESUME__", refreshed.data() as AgentSession);
      return;
    }
    await sendMessage(chatId, "Got it — updated.");
    await sendClientIntakeSummary(chatId, refreshed.data() as AgentSession);
    return;
  }
  await sendMessage(chatId, "No problem — tell me what to change (the days, time of day, start date, address, rate, a care need, who the care is for, or say \"add a person\") and I'll fix it. If it looks right, just say yes and I'll show you who can help.");
}

async function createClientIdentitySession(phone: string): Promise<string> {
  const caraPhone = encodeURIComponent(process.env.LINQ_PHONE_NUMBER ?? "");
  // 2026-09-19 (Account Settings parity): a signed-in family asking Evia for the
  // identity check used to get a session keyed by phone only, so the webhook
  // never wrote users.identityCheckStatus — the site's "Identity check" row and
  // the client gate stayed unverified forever. Now the session also carries
  // firebaseUID (what the site's callable sets) and the same "processing" write.
  const sessSnap = await db.collection("agent_sessions").doc(phone).get().catch(() => null);
  const uid = (sessSnap?.data()?.userId as string | undefined) || undefined;
  const session = await getStripe().identity.verificationSessions.create({
    type: "document",
    metadata: { phone, ...(uid ? { firebaseUID: uid } : {}) },
    return_url: `${APP_URL}/client/identity-callback?source=cara&caraPhone=${caraPhone}`,
  });
  await db.collection("agent_sessions").doc(phone).update({ identitySessionId: session.id });
  if (uid) {
    await db.collection("users").doc(uid).set({
      identityCheckStatus: "processing",
      stripeIdentityVerificationId: session.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch((err) => console.warn("identity processing write failed (non-fatal)", err instanceof Error ? err.message : err));
  }
  // Branded wrapper: the texted link unfurls as an Evia card (/verify/{id} →
  // v1-linkRedirect) instead of raw verify.stripe.com. Fail-open to the raw URL.
  return createBrandedLink("verify", session.url!, phone);
}

// Persist the confirmed client intake as REAL care records — exactly the records
// the website wizard's createJobPosting (services/api.ts) writes, and nothing
// more: job_postings/{uid}, carePlans/{uid} (recipientPlans + one upserted
// locationPool entry + emergencyContacts), senior_profiles/{uid} (the wizard's
// profileUpdate shape), users/{uid} (address/email/photo/jobPostingCompleted).
// No clientIntakes doc, no per-recipient household senior_profiles docs, no
// users.seniorIds, no careLevel, no diagnoses — the wizard writes none of them.
// Called at intake-confirm (handleClientShowCaregivers) so the webapp account
// reflects the care recipient even if the family stalls at the paywall, and
// re-run by the payment webhook so anything volunteered at a gate lands.
// Every write is a merge — safe to run repeatedly. Same fix class as the
// caregiver doc pre-create at the gate handoff (a client who onboarded but
// didn't pay used to leave NO care record at all).
export async function persistClientCareRecords(
  uid: string | undefined,
  phone: string,
  d: Record<string, unknown>,
): Promise<void> {
  // Geocoded care-address coords (ensureClientCoords / a shared location pin)
  // — written onto job_postings.lat/lng and the locationPool entry the same
  // way createJobPosting geocodes once at wizard completion.
  const lat = typeof d.lat === "number" ? d.lat as number : undefined;
  const lng = typeof d.lng === "number" ? d.lng as number : undefined;
  const hasCoords = lat !== undefined && lng !== undefined;
  const geoPrecision = (d.geoPrecision === "street" || d.geoPrecision === "zip" || d.geoPrecision === "city")
    ? d.geoPrecision as GeoPrecision : undefined;

  const city         = (d.city         ?? "") as string;
  const zipCode      = (d.zipCode      ?? "") as string;
  const street       = (d.street       ?? "") as string;
  const state        = (d.state        ?? "") as string;
  const rawCareNeeds = (d.careNeeds    ?? []) as string[];
  // Site taxonomy (careNeedsTaxonomy.ts): recipientPlans[key].careNeeds holds the
  // page's CATEGORY names — the eight, nothing underneath (2026-10-04). Written
  // back onto the draft so the job_postings mirror and the summary use the same
  // names. When the taxonomy ran and placed nothing, the draft held no real care
  // need (live 2026-09-26: "occasional help") — write NO pills rather than the
  // raw words. Raw is kept only when the canonicalizer itself failed.
  const canon = rawCareNeeds.length ? await canonicalizeCareNeeds(rawCareNeeds).catch(() => null) : null;
  const careNeeds = canon ? canon.careNeeds : rawCareNeeds;
  const careNeedDetails: Record<string, string[]> = {};
  if (canon && (!isCanonicalCareNeeds(rawCareNeeds) || JSON.stringify(careNeeds) !== JSON.stringify(rawCareNeeds))) {
    d = { ...d, careNeeds, careNeedDetails };
    await mergeOnboardingData(phone, { careNeeds, careNeedDetails }).catch(() => {});
  }
  // The job description is NOT copied into the care plan's Notes (founder, 2026-10-09): it is the public
  // post's text; care-plan Notes are the family's private per-person field, added later on the Care Plan
  // page or through update_care_plan, and carried onto visits from there.
  // Home address (account holder) — may differ from care address
  const homeStreet   = (d.homeStreet  as string | undefined) || street;
  const homeCity     = (d.homeCity    as string | undefined) || city;
  const homeZipCode  = (d.homeZipCode as string | undefined) || zipCode;
  const homeState    = (d.homeState   as string | undefined) || state;

  if (!uid) return;

  // One plan entry per care recipient (primary + any additional — "both
  // mom and dad"). Keys MUST equal the web CarePlan.tsx getKey(firstName,
  // lastName) for the roster entry the job_postings mirror writes for the same
  // person (recipientPlanKeyForFullName splits the name the same way), or the
  // web tabs can't find Evia's plan data and auto-seed an empty one instead.
  // Care needs are shared across recipients at signup — same behavior as the
  // web PostJob flow; per-person details are edited later in the CarePlan tabs.
  const recipients = allCareRecipients(d);
  // Child care (2026-10-18): ONE stage per child rides on that child's plan (`ageRange`); never on the post.
  const intakeStage = stageOf(d as { ageRange?: unknown; ageRanges?: unknown });
  // The relationship decides each person's kind; "other" carries its own adult-or-child answer (2026-10-19).
  // The chips land only on a child's plan.
  const recipientPlans: Record<string, unknown> = {};
  for (const r of recipients) {
    const kind = recipientCareKind(r.relationship, r.careKind);
    const isPrimary = recipientPlanKeyForFullName(r.name) === recipientPlanKeyForFullName(String(d.seniorName ?? ""));
    const ageRange = kind === "child" ? (r.ageRange ?? (isPrimary ? intakeStage : null)) : null;
    recipientPlans[recipientPlanKeyForFullName(r.name)] = {
      name:         r.name,
      relationship: r.relationship ?? "",
      careNeeds,
      careNeedDetails,
      ...(ageRange ? { ageRange } : {}),
      // Provenance for multi-recipient households: these needs are a
      // signup-time COPY shared across everyone — the care-plan interview
      // confirms them per person rather than trusting them as individual.
      ...(recipients.length > 1 ? { sharedAtSignup: true } : {}),
      updatedAt:    new Date().toISOString(),
    };
  }
  // Emergency contact — the exact entry createJobPosting writes: id 'wizard',
  // phone in the wizard's (555) 000-0000 shape (>=10 digits, else omitted).
  const ecName  = (d.emergencyContactName  as string | undefined) ?? "";
  const ecPhone = formatWizardPhone(d.emergencyContactPhone) ?? "";
  const ecRel   = (d.emergencyContactRelationship as string | undefined) ?? "";
  const emergencyContacts = (ecName || ecPhone)
    ? [{ id: "wizard", name: ecName, relation: ecRel, phone: ecPhone, isPrimary: true }]
    : undefined;

  // locationPool: upsert ONE entry (match on street+zip, only when a street is
  // present) exactly like createJobPosting's locationPoolUpdate — never
  // replace the pool. lat/lng ride along: the site reads
  // carePlans.locationPool[].lat/lng for distance.
  const cpRef  = db.collection("carePlans").doc(uid);
  const cpSnap = await cpRef.get().catch(() => null);
  const existingPool = cpSnap?.exists ? (cpSnap.data() as Record<string, unknown>).locationPool : undefined;
  const locationPool = upsertCarePlanLocationPool(
    existingPool,
    buildCarePlanLocationEntry(d, hasCoords ? { lat: lat as number, lng: lng as number, geoPrecision } : undefined),
  );

  await cpRef.set({
    clientId: uid,
    phone,
    recipientPlans,
    ...(locationPool ? { locationPool } : {}),
    ...(emergencyContacts ? { emergencyContacts } : {}),
    // Same review marker the website's "Looks good" button sets on
    // CarePlan.tsx. The wizard's version is a single end-of-form glance;
    // over SMS the family already confirmed every field conversationally,
    // one at a time, as they answered — that IS the review, so it's stamped
    // here automatically rather than adding a redundant extra "does this
    // look right?" turn right after they just finished answering everything.
    carePlanReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  // Write home address to users/{uid} — same as wizard step 3 writes.
  // homeCity/homeZipCode are the account holder's address; care address may differ.
  if (homeCity || homeZipCode) {
    await db.collection("users").doc(uid).set({
      city:    homeCity,
      zipCode: homeZipCode,
      ...(homeStreet ? { street: homeStreet } : {}),
      ...(homeState  ? { state:  homeState  } : {}),
    }, { merge: true }).catch((err) => console.error("persistClientCareRecords: users address write failed (non-fatal):", err));
  }

  // Recovery email — required field (onboardingContract.ts), written to
  // users/{uid} the same place AccountSettings.tsx reads it from. Loosely
  // validated (matches caregiverFieldAbsorber.ts's own EMAIL_RE) rather than
  // trusted blindly — this is the sole recovery channel if the phone is lost.
  const email = (d.email as string | undefined)?.trim();
  if (email && /^\S+@\S+\.\S+$/.test(email)) {
    await db.collection("users").doc(uid).set({ email: email.toLowerCase() }, { merge: true })
      .catch((err) => console.error("persistClientCareRecords: users email write failed (non-fatal):", err));
  }

  // Signup-time photo is the ACCOUNT HOLDER's own photo — same semantics as
  // AccountSettings.tsx's "your photo", not automatically the care
  // recipient's (Hamse, 2026-08-23). Mirrored here regardless of who the
  // care is for; buildJobPostingsDoc separately mirrors it onto the
  // recipient-facing careRecipientPhotoURL field only when relationship is
  // "myself" (self-care) — see clientJobPostingContract.ts.
  const acctPhotoURL = (d.careRecipientPhotoURL as string | undefined) || undefined;
  if (acctPhotoURL) {
    await db.collection("users").doc(uid).set({ photoURL: acctPhotoURL }, { merge: true })
      .catch((err) => console.error("persistClientCareRecords: users photo write failed (non-fatal):", err));
    await admin.auth().updateUser(uid, { photoURL: acctPhotoURL }).catch(() => { /* best effort, matches AccountSettings.tsx */ });
  }

  // jobPostingCompleted — same flag + same TIMING the wizard's own "Submit"
  // sets it (before Identity/Membership, not after payment). This function
  // runs at intake-confirm, the true equivalent moment to the wizard's
  // Submit; App.tsx's ClientRoute checks this flag before showing the
  // ClientJobPostingWizard overlay, so an SMS client mid-flow shouldn't see
  // it once they've reached this point. It is also what the backend's
  // "real client progress" checks read (resolvePrimarySeniorId /
  // userHasRealOnboardingProgress / findConflictingRoleAccount) now that
  // users.seniorIds is no longer written.
  await db.collection("users").doc(uid).set({
    jobPostingCompleted: true,
  }, { merge: true }).catch((err) =>
    console.error("persistClientCareRecords: jobPostingCompleted write failed (non-fatal):", err));

  // job_postings/{uid} full parity write — same shape the web wizard writes
  // (clientJobPostingContract.ts is the single definition both channels use)
  // so SMS-onboarded clients see a complete job post when they log in.
  try {
    const jpRef  = db.collection("job_postings").doc(uid);
    const jpSnap = await jpRef.get();
    const jpData = (jpSnap.exists ? jpSnap.data() : {}) as Record<string, unknown>;
    const jpWrite: Record<string, unknown> = {
      ...buildJobPostingsDoc(uid, phone, d),
      // createJobPosting's final write: geocoded care-address coords, and the
      // per-step draft cursor cleared now that the questionnaire is complete.
      ...(hasCoords ? { lat, lng, ...(geoPrecision ? { geoPrecision } : {}) } : {}),
      draftStep:      admin.firestore.FieldValue.delete(),
      draftUpdatedAt: admin.firestore.FieldValue.delete(),
    };
    if (!jpData.createdAt) {
      jpWrite.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }
    // The recipient roster is only ever ADDED to here, never replaced — same
    // guarantee buildJobPost.ts and the website's own PostJobFlow give
    // (2026-09-15: a wholesale additionalRecipients write could drop
    // recipients the family had added on the Care Plan page). An existing
    // primary is sticky; the SMS primary, if a different person, joins the
    // additional list instead of displacing them.
    const rosterKey = (first: unknown, last: unknown) =>
      `${String(first ?? "").trim().toLowerCase()}_${(String(last ?? "").trim() || "noname").toLowerCase()}`.replace(/\s+/g, "_");
    const existingAdditional = Array.isArray(jpData.additionalRecipients)
      ? (jpData.additionalRecipients as Array<Record<string, unknown>>)
      : [];
    const incomingAdditional = Array.isArray(jpWrite.additionalRecipients)
      ? (jpWrite.additionalRecipients as Array<Record<string, unknown>>)
      : [];
    const merged: Array<Record<string, unknown>> = [...existingAdditional];
    const have = new Set<string>(existingAdditional.map((r) => rosterKey(r.firstName, r.lastName)));
    if (jpData.careRecipientFirstName) {
      have.add(rosterKey(jpData.careRecipientFirstName, jpData.careRecipientLastName));
      // Primary already on file — keep it; fold the SMS primary in as an
      // additional recipient when it's someone else.
      const smsPrimaryKey = rosterKey(jpWrite.careRecipientFirstName, jpWrite.careRecipientLastName);
      if (jpWrite.careRecipientFirstName && !have.has(smsPrimaryKey)) {
        merged.push({
          firstName: jpWrite.careRecipientFirstName, lastName: jpWrite.careRecipientLastName ?? "",
          relationship: jpWrite.relationship ?? "",
        });
        have.add(smsPrimaryKey);
      }
      delete jpWrite.careRecipientFirstName;
      delete jpWrite.careRecipientLastName;
      delete jpWrite.careRecipientAge;
      delete jpWrite.relationship;
      delete jpWrite.careRecipientPhotoURL;
    }
    for (const r of incomingAdditional) {
      const k = rosterKey(r.firstName, r.lastName);
      if (!have.has(k)) { merged.push(r); have.add(k); }
    }
    jpWrite.additionalRecipients = merged;
    jpWrite.adultsCount = 1 + merged.length;
    await jpRef.set(jpWrite, { merge: true });
  } catch (err) {
    console.error("persistClientCareRecords: job_postings full write failed (non-fatal):", err);
  }

  // senior_profiles/{uid} — the wizard's profileUpdate, field for field
  // (buildSeniorProfileWizardFields): careNeeds/needs/scheduleNeeded/zipCode,
  // name/firstName/lastName/adultsCount, location "City, ST", age,
  // relationship. userId/clientId are kept so services/api.ts's
  // getSeniorsForClient (where clientId == uid) keeps finding this doc.
  await db.collection("senior_profiles").doc(uid).set({
    userId:    uid,
    clientId:  uid,
    ...buildSeniorProfileWizardFields(d),
    updatedAt: new Date().toISOString(),
  }, { merge: true }).catch((err) => console.error("senior_profiles parity write error:", err));
}

async function handleClientShowCaregivers(
  phone: string,
  chatId: string,
  session: AgentSession,
  opts: { withIntro?: boolean } = {},
): Promise<void> {
  let d            = (session as any).onboardingData ?? {};

  // For an account with a real, established senior_profiles doc — this step
  // can fire again long after the original onboarding conversation (a stuck
  // onboardingStep re-plays it, or a family re-triggers it another way) — the
  // frozen city/lat/lng captured back at signup can go stale (a move, a typo
  // that was never corrected, geocoding drift). The site's own matching
  // (FindCaregivers.tsx, useNearbyCaregiversWithScores) always reads the LIVE
  // senior_profiles/users location, never a one-time snapshot; mirror that
  // here instead of trusting session.onboardingData for an established client.
  if (session.userId) {
    const liveLocation = await loadLiveClientLocation(session.userId as string).catch(() => null);
    if (liveLocation) {
      d = { ...d, ...liveLocation };
      // A live city with no matching live coords means the frozen lat/lng (if
      // any) describe a DIFFERENT place than the city we just overwrote —
      // drop them so ensureClientCoords below re-geocodes against the fresh
      // city instead of silently pairing a new city with stale coordinates.
      if (liveLocation.city && liveLocation.lat == null) {
        delete (d as Record<string, unknown>).lat;
        delete (d as Record<string, unknown>).lng;
      }
    }
  }

  const city       = (d.city       as string) ?? "";
  const seniorName = (d.seniorName as string) ?? "your loved one";
  const careNeeds: string[] = Array.isArray(d.careNeeds) ? d.careNeeds : [];
  const needsTransportation = careNeeds.some((t) => /transport/i.test(t));

  // Intake is confirmed — this family is a real lead. Create their webapp
  // account NOW (Auth user + users/{uid} seed), not at the payment webhook, so
  // even a paywall drop-off can log into the web app with phone OTP.
  if (!session.userId) {
    const uid = await ensureWebAccount(phone, "client", (d.firstName as string) ?? "", d.lastName as string | undefined);
    if (uid) (session as any).userId = uid;
  }

  // Geocode BEFORE persisting so both carePlans.locationPool and the
  // caregiver-preview scoring below get real coordinates — SMS clients type a
  // city/zip and (unlike a shared pin) never had coordinates persisted
  // anywhere, so proximity-based preview scoring had nothing to work with.
  d = await ensureClientCoords(phone, d).catch(() => d);

  // …and persist the confirmed intake as real care records NOW (job_postings,
  // carePlans, senior_profiles) so the webapp shows the care recipient
  // even if the family never completes checkout. All merges; the payment
  // webhook re-runs this with the final budget/preferences. Non-fatal: the
  // caregiver preview below must still go out if a write hiccups.
  await persistClientCareRecords(
    (session as any).userId as string | undefined, phone, d,
  ).catch((err) => console.error("[handleClientShowCaregivers] care-record persist failed (non-fatal):", err));

  let preview: Awaited<ReturnType<typeof runGetCaregiverPreviewAction>>;
  try {
    preview = await runGetCaregiverPreviewAction(
      {
        city, seniorName, careNeeds, needsTransportation,
        ...(typeof d.lat === "number" && typeof d.lng === "number" ? { lat: d.lat as number, lng: d.lng as number } : {}),
        ...(Array.isArray(d.selectedDays) && d.selectedDays.length ? { schedule: d.selectedDays as string[] } : {}),
      },
      { caller: "sms_agent", role: "client", phone, chatId },
    );
  } catch (err) {
    // A transient action failure must not wedge the turn in silence — tell the
    // family honestly and leave the session on the current step so their next
    // inbound genuinely retries this handoff (no unbacked "I'll text you" promise,
    // no stalled-work copy — voice contract R1).
    console.error("[handleClientShowCaregivers] caregiver preview failed:", err);
    await sendMessage(chatId,
      `My system hiccuped pulling up care providers for ${seniorName} — that's on me. Text me "ready" in a minute and I'll show you the matches.`
    );
    return;
  }

  if (!preview.available) {
    // No supply at all: don't take payment for something we can't deliver.
    await updateSession(phone, { onboardingStep: "complete", awaitingSupply: true });
    await sendMessage(chatId, preview.message);
    return;
  }

  // Rich card gallery (match-presentation parity, 2026-07-12): instead of one
  // prose blob of names, each previewed caregiver gets their headshot as an
  // image bubble + a caption with the tappable /p/{id} profile link (which
  // unfurls as a branded card via v1-caregiverProfileMeta). Real faces and
  // verifiable profiles are the strongest pre-paywall signup evidence we have.
  // withIntro=false when the agent loop's own closing line already announced
  // the matches (continueAfterClientCollection) — a second header would stack.
  if (opts.withIntro !== false) {
    const introLabel = preview.locationLabel || "you";
    await sendMessage(chatId,
      preview.widened
        ? `I don't have care providers right in ${introLabel} yet, but here's who's nearby for ${seniorName} 👇`
        : `Here's who's available near ${introLabel} for ${seniorName} 👇`
    );
  }
  // One image per caregiver (founder, 2026-07-12): the /p/{id} link unfurls as
  // a rich card that ALREADY carries the caregiver's photo (caregiverProfileMeta
  // OG tags), so a separate photo bubble showed the same face twice. Send only
  // the caption + profile link; the card below it is the visual.
  for (const item of preview.items) {
    try {
      const caption =
        `${item.name}${item.yearsExperience ? ` — ${item.yearsExperience} yrs experience` : ""}` +
        `${item.strongestFit ? `, strongest fit for ${item.strongestFit}` : ""}` +
        (item.id ? `\nTap to view ${item.name.split(" ")[0]}'s profile: ${APP_URL}/p/${item.id}` : "");
      await sendMessage(chatId, caption);
      await new Promise<void>((r) => setTimeout(r, 400));
    } catch (err) {
      console.warn("[handleClientShowCaregivers] gallery send failed for caregiver", {
        phone, id: item.id, err: (err as Error)?.message,
      });
    }
  }

  // Site order (2026-09-06 fix): Care Plan → Identity → Membership, matching
  // the website's own onboarding tracker exactly. Identity goes out now, with
  // no price mentioned yet — the membership pitch (handleClientPresentPlan)
  // only fires once identity actually clears (see the "identity" case in
  // advanceOnboardingStep). Previously this pitched the price FIRST and only
  // sent Identity after a yes — backwards from the site, where price is never
  // shown until after Identity.
  await sendIdentityCheckLink(phone, chatId, session);
}

// Proactive post-collection handoff for the agent loop. When the loop calls
// complete_collection it only advances the cursor to the first gate step — the
// next phase (a plain-text summary confirmation, matching the website's Care
// Plan review step, which happens before Identity/Membership there too) is
// webhook-passive and would otherwise wait for an inbound that never comes (the
// family was just told their part is done). The webhook calls this the moment
// collection completes so Evia continues in the SAME turn instead of going silent.
// The reply to this summary is handled by handleClientConfirmIntake (routed at
// step client_confirm_intake), which only calls handleClientShowCaregivers —
// and stamps carePlans.carePlanReviewedAt, inside persistClientCareRecords —
// once the family has explicitly confirmed, not the instant collection ends.
export async function continueAfterClientCollection(phone: string, chatId: string): Promise<void> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  if (!snap.exists) return;
  const session = snap.data() as AgentSession;
  await updateSession(phone, { onboardingStep: "client_confirm_intake" });
  await sendClientIntakeSummary(chatId, session);
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
        `Good news — a care provider just became available near ${caregiverCity}! Let me show you who can help ${seniorName}.`
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

// 2026-08-31 (Membership page audit): a Checkout session created here never
// used to set `customer:` or touch `customers/{uid}.stripeCustomerId` at all
// — only the LATER webhook wrote `users/{uid}.stripeCustomerId` on success.
// The website's own createCheckoutSession (functions/src/stripe.ts) looks up
// that SAME `customers/{uid}` doc first and reuses the existing Stripe
// customer if one exists. Since the two checkout paths never shared that
// lookup, a family who signed up over SMS and later clicked "Change plan" on
// the website would get a brand-new Stripe customer + a SECOND parallel
// subscription — a real double-billing risk. When userId is already known at
// this point in onboarding (it usually is — see handleClientSendPayment's own
// already-active check just above this function's call sites), get-or-create
// the customer the exact same way the website does, so both entry points
// always land on the same one.
async function getOrCreateStripeCustomerForUser(userId: string, phone: string): Promise<string | undefined> {
  const custRef = db.collection("customers").doc(userId);
  const custSnap = await custRef.get();
  const existing = custSnap.data()?.stripeCustomerId as string | undefined;
  if (existing) return existing;
  try {
    const userSnap = await db.collection("users").doc(userId).get();
    const email = userSnap.data()?.email as string | undefined;
    const customer = await getStripe().customers.create({
      ...(email ? { email } : {}),
      phone,
      metadata: { firebaseUID: userId },
    });
    await custRef.set({ stripeCustomerId: customer.id, createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return customer.id;
  } catch (err) {
    // Non-fatal — fall back to the phone-only Checkout session below rather
    // than block a family from paying at all over one Stripe API hiccup.
    console.error("getOrCreateStripeCustomerForUser error:", err);
    return undefined;
  }
}

async function createClientMembershipCheckout(
  phone: string,
  caraPhone: string,
  selectedPriceId?: string,
  userId?: string,
): Promise<Stripe.Checkout.Session> {
  const priceId = (selectedPriceId || resolveClientPriceId()).trim();
  const customerId = userId ? await getOrCreateStripeCustomerForUser(userId, phone) : undefined;
  const common = {
    payment_method_types: ["card"] as Stripe.Checkout.SessionCreateParams.PaymentMethodType[],
    success_url: `${APP_URL}/payment/success?source=cara&caraPhone=${caraPhone}`,
    cancel_url: `${APP_URL}/start`,
    metadata: { phone, task: "client_payment_setup", ...(userId ? { firebaseUID: userId } : {}) },
    ...(customerId ? { customer: customerId } : {}),
  };

  if (!priceId) {
    return getStripe().checkout.sessions.create({
      ...common,
      mode: "setup",
    });
  }

  return getStripe().checkout.sessions.create({
    ...common,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { metadata: { phone, kind: "client_membership", ...(userId ? { firebaseUID: userId } : {}) } },
  });
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

  // Pitch + explicit consent ask, then STOP (consent gate, 2026-07-12). This
  // is a money moment — the actual membership checkout link goes out only
  // after the family says yes (handleClientPlanReply owns the reply), never
  // unrequested. One message, one job: price + what it covers + a clear
  // yes/no question. Runs AFTER identity clears (site order, 2026-09-06) —
  // the caregiver matches were shown earlier, with the identity check now
  // sitting in between, so the context below says "already showed," not
  // "just showed."
  //
  // R12 (hallucination hardening 2026-07-17): when the live Stripe price lookup
  // fails (priceLabel === ""), the briefing must NOT ask the model to "state
  // the price" — an ungrounded ask invites an invented dollar amount. The
  // no-price branch forbids any specific number instead.
  const pricePart = priceLabel
    ? `Now state the price in one warm, simple message: Evia is ${priceLabel}, `
    : `Do NOT state a specific dollar amount — say 'a simple monthly membership'. ` +
      `In one warm, simple message: Evia is a simple monthly membership, `;
  const msg = await generateCaraMessage({
    audience: "family",
    context:
      `Evia already showed this family real local care providers for ${seniorName} (photos + profiles, sent earlier ` +
      `in this conversation). The FAMILY MEMBER texting just finished their own identity check — Evia already told them ` +
      `"you're verified" one message ago, so do NOT repeat or rephrase that. It was NOT a background check and it is not about ${seniorName} ` +
      `(${seniorName} is the person receiving care); never use the words "background check" here. ` +
      pricePart +
      `plus a 9% service fee on each visit (the care provider keeps 100% of their rate), and for that Evia coordinates everything for ${seniorName} — ` +
      `scheduling and live visit updates. State both the membership price and the 9% fee. 2-3 sentences, no bullet lists, no pressure, do NOT claim anything is ` +
      `already set up, and do NOT mention sending any link. Membership is what lets the family actually message ` +
      `and book one of the care providers just shown — do NOT say or imply that matching only starts once membership ` +
      `is active, that would contradict the real matches you just sent them. END with one clear yes/no question ` +
      `asking if they'd like to get set up (e.g. "Want me to get you set up?").`,
    fallback:
      `Evia is ${priceLabel || "one simple monthly membership"} plus a 9% service fee on each visit — the care provider keeps 100% of their rate. ` +
      `I coordinate everything for ${seniorName}: scheduling and live visit updates. Want me to get you set up?`,
    emotionalDirective: (session as any)._emotionalDirective,
    maxTokens: 130,
  });
  await sendMessage(chatId, msg);
  // Step stays client_ask_plan (set by the caller) — handleClientPlanReply
  // parses the yes/no and sends the identity link on an explicit yes.
}

// Site-order fix (2026-09-06): the website's own onboarding tracker shows
// Care Plan → Identity → Membership, in that order — Identity is never
// mentioned as gated behind price, and no dollar amount is shown until after
// it. Evia used to pitch the membership PRICE immediately after showing
// caregiver matches, get a yes, THEN send the Identity link — so the very
// first thing raised was money, backwards from what the site itself shows
// and asks for. This is now called directly from handleClientShowCaregivers,
// with no price pitch first — the price pitch (handleClientPresentPlan) now
// runs only once identity actually clears (see the "identity" webhook case
// in advanceOnboardingStep below).
async function sendIdentityCheckLink(phone: string, chatId: string, session: AgentSession): Promise<void> {
  // Live check: skip a redundant Identity link if the client already
  // verified — most likely via the website, which Evia otherwise has no way
  // to know about before unconditionally minting a brand-new Stripe Identity
  // session and asking them to redo a check they already passed. Already
  // verified means Identity is done — go straight to the price pitch, same
  // as the webhook path below does once a fresh check clears.
  if (session.userId) {
    const identitySnap = await db.collection("users").doc(session.userId as string).get().catch(() => null);
    if (identitySnap?.exists && identitySnap.data()?.identityCheckStatus === "verified") {
      await updateSession(phone, { onboardingStep: "client_ask_plan" });
      await handleClientPresentPlan(phone, chatId, session);
      return;
    }
  }

  await signalThinking(chatId, session.service);
  let identityUrl: string;
  try {
    identityUrl = await createClientIdentitySession(phone);
  } catch (err) {
    console.error("createClientIdentitySession error — falling back to price pitch:", err);
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
    await updateSession(phone, { onboardingStep: "client_ask_plan" });
    await handleClientPresentPlan(phone, chatId, session);
    return;
  }
  await sendMessage(chatId,
    "Quick 30-second identity check first — it's how I keep every family on the platform real and safe:"
  );
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
    const answer = await answerQuestionMidFlow(text, session, phone);
    // One message: two back-to-back texts were delivered in the wrong order live
    // (2026-09-20 — the re-ask showed above the answer).
    await sendMessage(chatId, `${answer}\n\nWhen you're ready, say yes and I'll send the setup link again.`);
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
      "Right now there's one simple membership — it covers me coordinating care, matching and interviews, and keeping " +
      "you updated on every visit, and you can text me any time. If you want to keep going, say yes and I'll send the setup link again."
    );
    return;
  }
  if (intent !== "confirm") {
    await sendMessage(chatId, "When you're ready, say yes and I'll get you connected with care providers — happy to answer anything first.");
    return;
  }

  // By the time this step is reached, Identity has already cleared (this
  // step only fires after the "identity" webhook case pitches the price) —
  // confirmed intent goes straight to the actual membership checkout.
  await updateSession(phone, { onboardingStep: "client_send_payment" });
  await handleClientSendPayment(phone, chatId, session);
}

export async function handleClientSendPayment(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const d    = session.onboardingData ?? {};

  // Live check: skip a redundant/duplicate Stripe Checkout session if the
  // client is already an active member — most likely paid via the website,
  // which Evia otherwise has no way to know about before unconditionally
  // sending a second checkout link (real risk of a second subscription/charge).
  // Matches the website's own gate (hooks/useAccessGates.tsx): active OR trialing.
  if (session.userId) {
    const memberSnap = await db.collection("users").doc(session.userId as string).get().catch(() => null);
    const md = memberSnap?.exists ? memberSnap.data() : null;
    const alreadyActive = md?.subscriptionActive === true || md?.membershipStatus === "active" || md?.membershipStatus === "trialing";
    if (alreadyActive) {
      await updateSession(phone, { onboardingStep: "complete" });
      await sendMessage(chatId, "Looks like your membership is already active — you're all set! I'll keep finding great care provider matches for you.");
      return;
    }
  }

  const caraPhone = encodeURIComponent(process.env.LINQ_PHONE_NUMBER ?? "");
  const priceId   = ((d.selectedPlanPriceId as string) || resolveClientPriceId()).trim();
  let checkoutUrl: string;
  await signalThinking(chatId, session.service);
  try {
    // Real recurring membership — mode "subscription" actually starts billing.
    // (Falls back to setup/card-on-file only if no price is configured, so the
    // flow never hard-fails — but with STRIPE_MEMBERSHIP_PRICE_ID set this bills.)
    const stripeSession = await createClientMembershipCheckout(phone, caraPhone, priceId, session.userId as string | undefined);
    if (!stripeSession.url) throw new Error("Stripe checkout session created without a URL");
    // Branded wrapper (/pay/{id} → v1-linkRedirect): the texted link unfurls
    // as an Evia membership card instead of raw checkout.stripe.com.
    checkoutUrl = await createBrandedLink("pay", stripeSession.url, phone);
  } catch (err) {
    // Stripe checkout failed. NEVER fall through to the /payment/success page:
    // that page is for AFTER a real charge, so texting it here would strand the
    // family on a "success" screen with no subscription (R7). A failure at the
    // PAYMENT step is a conversion-killer — page ops, then hand off to the
    // shared apology/retry path: it records a `link` commitment (the retry sweep
    // re-attempts the send) and sends grounded copy with NO URL.
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
    await sendOnboardingLinkFailureMessage(phone, chatId, session, "client-payment");
    return;
  }

  await updateSession(phone, { onboardingStep: "client_awaiting_payment" });
  // R11 (hallucination hardening 2026-07-17): pre-checkout briefing — the
  // caregivers are for the care recipient, never for the account holder.
  const whoIsWho = describeWhoIsWho(d as Record<string, unknown>);
  const msg7 = await generateCaraMessage({
    audience: "family",
    context: (whoIsWho ? whoIsWho + " " : "") + `Evia has collected everything needed to start finding care providers for ${d.seniorName ?? "a loved one"}. Let the family know warmly, then tell them the last step is to start their membership so Evia can begin coordinating care, and that it takes about 30 seconds.`,
    fallback: `Perfect — I have everything I need to start finding care providers for ${d.seniorName ?? "your loved one"}.\n\nLast step: start your membership so I can begin coordinating care.\nTakes about 30 seconds:`,
    maxTokens: 100,
  });
  await sendMessage(chatId, msg7);
  await sendMessage(chatId, { parts: [{ type: "link", value: checkoutUrl }] });
  await sendMessage(chatId, await generateCaraMessage({
    audience: "family",
    language: session.preferredLanguage === "es" ? "es" : "en",
    context: (whoIsWho ? whoIsWho + " " : "") + `You just sent the family their payment setup link. Warmly reassure them that the moment it's active they can message, interview and book the care providers they've seen${d.seniorName ? ` for ${d.seniorName}` : ""} — you'll be right here. One short line. Never promise that you are searching or finding care providers in the meantime. ${d.seniorName ? `The ONLY care-recipient name you may use is "${d.seniorName}" — never invent or substitute any other name.` : `You do NOT know the care recipient's name — refer to them only as "your loved one" and NEVER invent a name.`}`,
    fallback: `As soon as it's active you can message, interview and book the care providers you've seen${d.seniorName ? ` for ${d.seniorName}` : ""} — I'll be right here.`,
    maxTokens: 60,
  }));
}

// ── CAREGIVER FLOW ────────────────────────────────────────────────────────────

/**
 * Live local-demand snapshot for a caregiver's city. Returns the count of open
 * jobs and up to 3 formatted lines (care type · rate). Used both at the location
 * step (early "this is legit" proof) and re-cited at the membership ask so the
 * value is fresh and concrete at the moment we ask for payment. Never fabricates
 * — an empty result means there genuinely are no open jobs in that city.
 */
async function handleCaregiverSendMembership(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const d       = session.onboardingData ?? {};
  // Flat membership: the MVR rides along whenever their services include
  // Transportation — the same rule the site's payment webhook applies.
  const wantsMvr = offersTransportation(d as Record<string, unknown>);
  const token   = generateToken({ phone, task: "caregiver_membership" });
  let checkoutUrl = `${APP_URL}/done?task=caregiver_membership&t=${token}`;

  // Flat membership (founder, 2026-09-25): the annual fee covers the MVR, so
  // there is NO separate line item any more — `includeMVR` only tells the
  // webhook to run the bundled criminal+MVR package, and that needs the
  // bundled package to be configured.
  const mvrCharged = wantsMvr && isMvrCheckConfigured("bundled");
  if (wantsMvr && !mvrCharged) {
    console.error("Caregiver opted into MVR but the bundled package is not configured; proceeding membership-only.");
    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: session.preferredLanguage === "es" ? "es" : "en",
      context: "The care provider asked to include the optional driving-record MVR add-on, but it is not configured. Warmly explain that Evia will continue with the standard background check and the team can follow up about adding the driving check later.",
      fallback: "Heads up - I couldn't add the driving-record check to your membership right now, so I'm setting you up with the standard background check. Our team can follow up if you'd like to add it later.",
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
    // The site's Activate Membership checkout, shared (caregiverMembershipBilling.
    // createCaregiverMembershipCheckout): the customer reused from customers/{uid}
    // once the record exists, the server-picked flat annual price, metadata for
    // both the text session (phone) and the record (firebaseUID). Checkout keeps
    // automatic payment methods (Apple Pay / Google Pay / Link for mobile-first
    // caregivers); the texted link returns to the text channel's /done page.
    const { createCaregiverMembershipCheckout } = await import("../caregiverMembershipBilling");
    const stripeSession = await createCaregiverMembershipCheckout(getStripe() as any, {
      uid: (session.caregiverId ?? session.userId) as string | undefined,
      phone,
      successUrl: `${APP_URL}/done?task=caregiver_membership&t=${token}`,
      cancelUrl: `${APP_URL}/start`,
      includeMVR: mvrCharged,
    });
    checkoutUrl = stripeSession.url ?? checkoutUrl;
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

  // Store URL on session so we can resend it
  await updateSession(phone, {
    onboardingStep:        "caregiver_awaiting_membership",
    membershipCheckoutUrl: checkoutUrl,
    membershipCheckoutCreatedAt: new Date().toISOString(),
  });
  await sendMessage(chatId, await generateCaraMessage({
    audience: "caregiver",
    language: session.preferredLanguage === "es" ? "es" : "en",
    context:
      "The care provider's profile is done — the last stretch is activating their membership. Facts you MUST convey, woven in naturally (not as a list): " +
      `it's ${caregiverAnnualDisplay()}, it INCLUDES the background check every care provider completes (the next step right after payment — no separate charge for it), ` +
      "and it unlocks applying to jobs, getting booked, and Evia's scheduling + payout tools. Once their background check comes back clear, they're approved to care for clients" +
      (mvrCharged ? ". Their order also includes the driving-record (MVR) check they asked for" : "") +
      ". End leading into the activation link you're sending right after this message. Do NOT include any URL.",
    fallback:
      `You're almost ready to apply! ` +
      `Activate your membership (${caregiverAnnualDisplay()}) — it includes your background check and unlocks applying to jobs near you, getting booked, and my scheduling + payout tools. ` +
      `Once your background check clears, you're approved to care for clients.` +
      `${mvrCharged ? " Your order includes the membership + MVR driver check." : ""} Tap to activate:`,
    maxTokens: 160,
  }));
  await sendMessage(chatId, { parts: [{ type: "link", value: checkoutUrl }] });
}

// ── Gate-link resend cooldown (U9, R13 — 2026-07-17) ─────────────────────────
// The cooldown STATE machinery (constants, window math, deterministic copy,
// per-step stamps, keyword-step set) lives in ./gateLinkCooldown so the
// stale-session nudge cron and the MCP send_onboarding_link tool share the
// SAME per-step window as the scripted resend paths below. Only the
// orchestrating send paths (handleGateLinkKeyword, resendGateLink) stay here.

// A bare "LINK" at a parked awaiting step — the deterministic escape hatch the
// in-cooldown copy promises. Runs BEFORE classifyAwaitingReply (strict keyword,
// CLAUDE.md binary-protocol carve-out; no LLM between the promise and the
// resend). Once per window: the first LINK inside a cooldown resends for real
// and consumes the bypass; a second LINK in the same window gets the
// deterministic copy. Outside any cooldown it's just a normal first resend
// (opens the window). Returns false only when the step advanced under us — the
// caller falls through to normal routing.
async function handleGateLinkKeyword(phone: string, chatId: string, step: string, session: AgentSession): Promise<boolean> {
  let fresh: Record<string, unknown> | undefined;
  try {
    fresh = (await db.collection("agent_sessions").doc(phone).get()).data() as Record<string, unknown> | undefined;
  } catch { /* fail-open: no cooldown state → plain resend below */ }
  const mins        = gateLinkCooldownMinutes(fresh, step);
  const inCooldown  = mins !== null;
  const bypassSpent = inCooldown && gateLinkBypassConsumed(fresh, step);
  if (step === "caregiver_awaiting_membership") {
    // No text → no classification. The handler's paid short-circuit must win
    // over ANY cooldown copy — a paid user must get the paid confirmation,
    // never "I sent that link" — so bypassSpent is passed DOWN instead of
    // early-returning here. The handler reports whether a link actually went
    // out; the cooldown/bypass stamps are written only on a REAL send
    // (mirrors resendGateLink's stamp-only-on-real-send rule).
    const sent = await handleCaregiverResendMembership(phone, chatId, session, undefined, { bypassSpent });
    if (sent) {
      if (inCooldown) await stampGateLinkBypassUsed(phone, step);
      else await stampGateLinkResent(phone, step);
    }
    return true;
  }
  if (bypassSpent) {
    // This window's bypass is spent — truthful deterministic copy (never a
    // fresh-send claim, never a re-promise of an immediate LINK resend).
    await sendMessage(chatId, gateLinkBypassSpentCopy(mins ?? 1, gateLinkCooldownResetMinutes(fresh, step)));
    return true;
  }
  const target = GATE_LINK_KEYWORD_TARGETS[step];
  if (!target) return false;
  if (inCooldown) {
    // Once-per-window bypass: resend for real (unthrottled), consume the bypass.
    const handled = await resendGateLink(phone, chatId, step, target.linkType, target.intro);
    if (handled) await stampGateLinkBypassUsed(phone, step);
    return handled;
  }
  // Not in cooldown — a normal throttled resend that opens the window.
  return resendGateLink(phone, chatId, step, target.linkType, target.intro, { throttled: true });
}

// ── Gate-step link resend (2026-07-16) ────────────────────────────────────────
// Six parked steps (photo, documents, client payment, client identity, Stripe
// Connect, bgcheck-wait) could TALK about their link but had no code path that
// could actually resend it — the LLM nudge then improvised "just resent it to
// your thread" (a false claim; live bug, Hamse 2026-07-15) or hallucinated a
// dead URL. Every awaiting step now owes a real resend. The fresh re-read
// mirrors handleCaregiverResendMembership: a webhook may have advanced the step
// between the inbound and this reply, and re-blasting a link at someone who
// already finished reads as not listening — on a moved-on step the caller falls
// through to its live-fact-grounded reply instead. Delivery goes through
// sendOnboardingLink, so the link arrives as the same rich preview card as the
// original send (isCardSafeUrl chokepoint in linq/client.ts).
// `throttled: true` marks an `other`-branch resend: it is gated by the U9
// cooldown above and stamps the window on a successful send. Question-path
// callers stay unthrottled — a reported problem always earns the real link.
async function resendGateLink(
  phone:      string,
  chatId:     string,
  parkedStep: string,
  linkType:   OnboardingLinkType,
  intro:      string,
  opts:       { throttled?: boolean } = {},
): Promise<boolean> {
  const fresh = (await db.collection("agent_sessions").doc(phone).get().catch(() => null))?.data() as AgentSession | undefined;
  if (fresh && (fresh.onboardingStep ?? parkedStep) !== parkedStep) return false;
  if (opts.throttled) {
    const mins = gateLinkCooldownMinutes(fresh as Record<string, unknown> | undefined, parkedStep);
    if (mins !== null) {
      // In-cooldown: deterministic copy IS the reply (handled → caller must
      // not stack an LLM nudge on top, which could falsely claim a send).
      // State-aware: once the LINK bypass is spent, the "reply LINK" promise
      // would be untruthful, so the bypass-spent variant is sent instead.
      await sendMessage(chatId, gateLinkInCooldownReplyCopy(fresh as Record<string, unknown> | undefined, parkedStep, mins));
      return true;
    }
  }
  await sendMessage(chatId, intro);
  try {
    const result = await sendOnboardingLink(phone, linkType);
    // Open the cooldown window only on a REAL send — a failed send must not
    // start a cooldown that mutes its own retry.
    if (result.success && opts.throttled) await stampGateLinkResent(phone, parkedStep);
    // client_payment reports success:false AFTER already sending the grounded
    // apology/retry message itself (checkout-create failure, R7) — treat as
    // handled so the caller doesn't stack a second reply on top.
    if (linkType === "client_payment" || result.success) return true;
  } catch (err) {
    console.error("resendGateLink: delivery failed", { phone, parkedStep, linkType, err: (err as Error)?.message });
  }
  // The intro just promised a link that didn't go out — that is exactly the
  // silent-broken-promise class this wave kills. Track it so the commitment
  // sweep retries in ~5 minutes and escalates to a human on a second failure.
  await recordCommitment({
    phone, chatId,
    kind:        "link",
    promiseText: intro.slice(0, 300),
    linkType,
    userType:    (fresh?.userType === "caregiver" ? "caregiver" : "client"),
    source:      "resendGateLink:delivery_failed",
    dueInMs:     5 * 60_000,
  }).catch(() => {});
  return true; // the promise is tracked — don't stack another reply on top
}

// Narrow resend-intent gate for the steps where the user may have ALREADY done
// their part and be waiting on a third party (identity verification clearing,
// Stripe reviewing the Connect account, Checkr's emailed form): a blind resend
// on every text would re-push a link at someone mid-wait, so only a reply that
// asks for the link or reports it missing/broken/expired earns one.
async function wantsGateLinkResend(text: string): Promise<boolean> {
  const raw = await parseWithClaude(
    "The user is mid-signup and was previously sent a secure link to tap. Classify their message: " +
      "asks for the link or for it to be (re)sent/texted, or reports it never arrived, isn't showing up, " +
      "doesn't work, won't open, or expired → YES. Anything else (status questions, thanks, unrelated chat, " +
      "saying they already finished) → NO. Reply with exactly one word: YES or NO.",
    text,
  ).catch(() => "NO");
  return raw.trim().toUpperCase().startsWith("Y");
}

// The website never gated BROWSING on identity verification or membership —
// only messaging, booking, and interview requests (find_nearby_caregivers's
// own contract in mcp/server.ts). But client_awaiting_identity/_payment are
// handled by this file's scripted gate runner, not the general qaAgent tool
// loop, so an off-topic "any more caregivers?" asked mid-gate had nowhere to
// go — classifyAwaitingReply's ack/question/other split has no bucket for it,
// and none of those branches ever call a caregiver-search tool. Checked FIRST,
// before that classification, so it can't be misread as a question about the
// gate itself (the same class of misclassification risk as the role-switch
// bug this session already fixed).
async function wantsMoreCaregivers(text: string): Promise<boolean> {
  const raw = await parseWithClaude(
    "The user is texting Evia, a care coordinator, mid-signup. Is their message asking to see " +
      "(more) care providers, care provider options, or matches — e.g. \"any more care providers\", \"show me other " +
      "options\", \"who else is available\", \"can I see more care providers\", \"any other care providers nearby\"? " +
      "Reply YES only for that. Reply NO for a plain acknowledgment, a question about payment/identity/the " +
      "process itself, or anything else. Reply with exactly one word: YES or NO.",
    text,
  ).catch(() => "NO");
  return raw.trim().toUpperCase().startsWith("Y");
}

// Surfaces real caregiver matches for a "show me more" ask that arrives while
// a gate (identity check, membership) is still pending, then reminds the
// family the gate itself still needs finishing. Reuses find_nearby_caregivers
// (mcp/server.ts) rather than re-querying here, so this shares its
// shownCaregiverIds exclusion/exhaustion-trim logic — the family never gets
// re-shown someone already sent, whether "more" is asked from here or from
// ordinary post-onboarding chat.
async function sendMoreCaregiversDuringGate(
  phone: string, chatId: string, session: AgentSession, gateReminder: string,
): Promise<void> {
  const clientId = session.userId as string | undefined;
  if (!clientId) {
    await sendMessage(chatId, `I'll pull up more options for you shortly — ${gateReminder}.`);
    return;
  }
  const { handleToolCall } = await import("../mcp/server");
  const result = await handleToolCall("find_nearby_caregivers", { clientId, phone })
    .catch(() => null) as { available?: boolean; message?: string; _toolError?: boolean } | null;
  const base = (result && !result._toolError && result.message)
    ? result.message
    : "I don't have any new options to show just yet, but I'm still looking.";
  await sendMessage(chatId, `${base} And don't forget — ${gateReminder}.`);
}

// Belt-and-suspenders for gate-step replies that end in PROSE with no
// deterministic link following: if the model narrated an incoming link anyway
// (despite the voice-level ban in caraMessage.ts), the link-promise net
// delivers it for real — same net the qaAgent loop runs after onboarding turns.
async function runGateLinkNet(phone: string, chatId: string, session: AgentSession, reply: string): Promise<void> {
  if (!reply.trim()) return;
  const { fulfillNarratedLinkPromise } = await import("./linkPromiseNet");
  await fulfillNarratedLinkPromise({
    phone, chatId, reply,
    userType: session.userType === "caregiver" ? "caregiver" : "client",
  }).catch((err) => console.error("gate-step link-promise net failed", err));
}

// Returns true only when a checkout link ACTUALLY went out this turn — the
// paid short-circuit, ack, absorb, and in-cooldown branches all send words but
// no link, and the LINK-keyword caller must never stamp a cooldown/bypass for
// a send that didn't happen (a paid user's next LINK would then get cooldown
// copy claiming "I sent that link").
async function handleCaregiverResendMembership(
  phone:   string,
  chatId:  string,
  session: AgentSession,
  text?:   string,
  opts:    { bypassSpent?: boolean } = {},
): Promise<boolean> {
  // A webhook may have processed the payment between the inbound and this reply —
  // re-blasting the checkout link at someone who already paid reads as not
  // listening. Fresh-read the completion flag FIRST, before any reply
  // classification; if it's paid, confirm instead.
  let membershipPaid = false;
  let freshMembershipData: Record<string, unknown> | undefined;
  try {
    const snap = await db.collection("agent_sessions").doc(phone).get();
    freshMembershipData = snap.data() as Record<string, unknown> | undefined;
    membershipPaid = !!((freshMembershipData as any)?.caregiverSubscriptionId);
    // A membership paid on the SITE never stamps the session's subscription id
    // — the record carries it (the ONE rule, caregiverAccessGate; sweep C5).
    if (!membershipPaid) {
      const cgId = ((freshMembershipData as any)?.caregiverId ?? (freshMembershipData as any)?.userId ?? session.caregiverId ?? session.userId) as string | undefined;
      if (cgId) {
        const cg = (await db.collection("caregivers").doc(cgId).get().catch(() => null))?.data() as Record<string, unknown> | undefined;
        membershipPaid = isCaregiverMembershipActive(cg);
      }
    }
  } catch { /* fail-soft: treat as not paid → resend link as before */ }
  if (membershipPaid) {
    // Payment landed — confirm it, never re-blast the checkout link or jump
    // straight to the next gate's link in the same breath (U9: "do NOT ask
    // them to pay or tap any link again"). If the step itself never advanced
    // (webhook missed), that's a stuck-session repair for the admin override
    // path (adminAdvanceQueue → advanceOnboardingStep), not something this
    // reply should trigger silently.
    const liveFact = await LIVE_GATE_FACT_BUILDERS.caregiver_awaiting_membership(phone, session);
    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: session.preferredLanguage === "es" ? "es" : "en",
      context: (liveFact ? `${liveFact} ` : "") +
        "Their membership payment already went through. Warmly confirm it's done and that you'll take it from here — do NOT ask them to pay or tap any link again.",
      fallback: "Good news — your membership payment already came through! You're all set on that; I'll take it from here.",
      maxTokens: 80,
    }));
    return false;
  }
  // An inbound text at the gate (not paid yet). A pure "thanks / sounds good"
  // gets a brief ack WITHOUT re-blasting the link; a profile addition is
  // absorbed; everything else — questions, requests, browsing — runs the real
  // agent with its tools, exactly like the website, which lets an unpaid
  // caregiver look at everything and only blocks actions (the action tools
  // enforce that gate and text the membership step themselves). The checkout
  // link is never re-blasted at a question any more (2026-09-26); the LINK
  // keyword, the stale-session nudge and a broken-link report still resend it.
  if (text) {
    const kind = await classifyAwaitingReply(text, "finish their membership payment via the link Evia sent");
    if (kind === "ack") {
      await sendAwaitingAck(chatId, session,
        "The care provider just acknowledged your membership-payment ask (a thanks or 'will do') — you're here when it's done.",
        "Sounds good — I'm here when it's done!");
      return false;
    }
    if (await wantsGateLinkResend(text)) {
      const askedUrl = (session as any).membershipCheckoutUrl as string | undefined;
      if (askedUrl) {
        await sendMessage(chatId, "Tap the link below to complete your membership payment:");
        await sendMessage(chatId, { parts: [{ type: "link", value: askedUrl }] });
      } else {
        await handleCaregiverSendMembership(phone, chatId, session);
      }
      await stampGateLinkResent(phone, "caregiver_awaiting_membership");
      return true;
    }
    if (kind !== "question" && await tryAbsorbGateProfileUpdate(phone, chatId, text, session,
      "finishing your membership payment via the link I sent")) {
      return false;
    }
    await dispatchGateTurnToQaAgent(phone, chatId, text, session, "caregiver_awaiting_membership");
    return false;
  }
  // LINK-keyword caller with this window's bypass already spent (checked AFTER
  // the paid short-circuit above so a paid user never sees cooldown copy):
  // truthful deterministic copy, no resend.
  if (opts.bypassSpent) {
    const mins = gateLinkCooldownMinutes(freshMembershipData, "caregiver_awaiting_membership") ?? 1;
    await sendMessage(chatId, gateLinkBypassSpentCopy(mins, gateLinkCooldownResetMinutes(freshMembershipData, "caregiver_awaiting_membership")));
    return false;
  }
  // No text: the LINK keyword / stale-session nudge re-deliver the checkout link.
  const url = (session as any).membershipCheckoutUrl as string | undefined;
  if (url) {
    await sendMessage(chatId, "Tap the link below to complete your membership payment:");
    await sendMessage(chatId, { parts: [{ type: "link", value: url }] });
  } else {
    // Re-generate if URL was lost
    await handleCaregiverSendMembership(phone, chatId, session);
  }
  return true;
}

// ── Inbound media during onboarding (texted photo / document) ─────────────────
// A caregiver snaps a headshot or a CNA/HHA card and texts it instead of using
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
  // ONE path for the profile photo (founder, 2026-09-25): the upload page —
  // the same write the site's wizard makes. A picture texted to Evia is not
  // saved; she points them at the link (re-sent right here so it's at hand).
  if (session.userType === "caregiver" && collectionStepsForRole("caregiver").includes(step)) {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: session.preferredLanguage === "es" ? "es" : "en",
      context: "The care provider texted a picture during signup. Warmly explain that photos are saved through the secure upload link (so they land on their profile correctly), and that you're sending the link again right below. Do NOT include any URL.",
      fallback: "Thanks for sending that! Photos are saved through the secure upload link so they land on your profile — here it is again:",
      maxTokens: 70,
    }));
    await sendOnboardingLink(phone, "caregiver_photo");
    return;
  }
  if (collectionStepsForRole("client").includes(step)) {
    await handleInboundClientRecipientPhoto(phone, chatId, media);
    // Continue the script: the photo step is answered, ask the next question.
    const snap = await db.collection("agent_sessions").doc(phone).get().catch(() => null);
    return runFamilyIntake(phone, chatId, "__RESUME__", (snap?.data() ?? session) as AgentSession);
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

// Client onboarding, step 8 of the wizard equivalent — the ACCOUNT HOLDER's
// own photo (same as AccountSettings.tsx's "your photo"), not the care
// recipient's, unless they're the same person (see persistClientCareRecords
// above) — completely optional either way. Unlike the caregiver's identity
// photo, there's no face/quality gate here — any image they send is accepted
// as-is, same as the wizard's AvatarUpload having no verification step either.
async function handleInboundClientRecipientPhoto(
  phone:  string,
  chatId: string,
  media:  InboundMediaPart
): Promise<void> {
  try {
    const dl  = await downloadMedia(media);
    const url = await storeInboundMedia({
      phone, kind: "image", buffer: dl.buffer,
      content_type: dl.content_type, ext: dl.ext,
    });
    await mergeOnboardingData(phone, { careRecipientPhotoURL: url });
    await sendMessage(chatId, "Got it — that's a lovely photo, thank you! 📸");
  } catch (err) {
    console.error("handleInboundClientRecipientPhoto failed", { phone, err: (err as Error)?.message });
    await sendMessage(chatId,
      `I had trouble opening that photo — no worries, it's optional. You can text it again any time, or add it from Account Settings here: ${APP_URL}/client/account`
    );
  }
}

// Checkr invitations die 7 days after mint (docs.checkr.com). Reuse a cached
// invite only while it is still LIVE — buffer under 7 days so a link handed to
// the caregiver near the edge still opens.
const BGCHECK_INVITE_STALE_MS = 6.5 * 24 * 60 * 60 * 1000;

// Is the cached bgcheckInviteUrl too old (or webhook-expired) to reuse? Reads
// the live caregiver doc for the webhook-set invitationStatus and the mint
// timestamp used as the age fallback when the session predates bgcheckInviteSentAt.
async function isBgcheckInviteStale(session: AgentSession): Promise<boolean> {
  let invitationStatus: string | undefined;
  let submittedAt:      string | undefined;
  if (session.caregiverId) {
    const snap = await db.collection("caregivers").doc(session.caregiverId).get();
    const bg = ((snap.data()?.backgroundCheckData ?? {}) as Record<string, unknown>);
    invitationStatus = bg.invitationStatus as string | undefined;
    submittedAt      = bg.submittedAt as string | undefined;
  }
  // The invitation.expired webhook already records this and deletes invitationUrl.
  if (invitationStatus === "expired") return true;
  // Prefer the explicit mint stamp; pre-fix sessions fall back to the caregiver
  // doc's submittedAt (stamped at mint). BOTH absent → treat as stale (we cannot
  // prove the invite is live). A present stamp/submittedAt guards a genuinely
  // recent invite from being force-re-minted.
  const sentAt = (session as any).bgcheckInviteSentAt as string | undefined;
  const ageSource = sentAt ?? submittedAt;
  if (!ageSource) return true;
  const ageMs = Date.now() - new Date(ageSource).getTime();
  if (Number.isNaN(ageMs)) return true;
  return ageMs > BGCHECK_INVITE_STALE_MS;
}

// Cancel the caregiver's OLD Checkr invitation(s) before a re-mint so two live
// invitations never race to the webhook (matched by checkrCandidateId). Best
// effort + dry-run-guarded — a failed cancel must not block re-minting.
async function cancelStaleBgcheckInvitation(session: AgentSession): Promise<void> {
  if (!session.caregiverId) return;
  try {
    const snap = await db.collection("caregivers").doc(session.caregiverId).get();
    const candidateId = (snap.data()?.backgroundCheckData?.checkrCandidateId) as string | undefined;
    if (!candidateId) return;
    await guardSideEffect(
      "checkr.invitation.cancel",
      () => cancelCheckrInvitationsForCandidate(candidateId),
      0,
      { candidateId },
    );
  } catch (err) {
    console.error("cancelStaleBgcheckInvitation error (non-fatal):", err);
  }
}

async function handleCaregiverSendBgcheck(phone: string, chatId: string, session: AgentSession, text?: string): Promise<void> {
  // An inbound TEXT at this cursor (sweep C5, 2026-10-11): the site sync moved
  // the cursor here after a membership paid on the SITE, or the webhook send
  // already ran. If the consent ask is already out — the site's payment
  // webhook parked the record on "authorize your background check" and the
  // membership_paid notice carried the link, or Evia texted it inside the
  // cooldown window — the caregiver's words are READ like at every other gate
  // (ack / question / profile addition / the agent), never met with a second
  // consent link blindly. Only when no ask is out yet is the link still owed.
  if (text) {
    let fresh: Record<string, unknown> | undefined;
    try { fresh = (await db.collection("agent_sessions").doc(phone).get()).data() as Record<string, unknown> | undefined; } catch { /* fail-open */ }
    const inCooldown = gateLinkCooldownMinutes(fresh, "caregiver_awaiting_bgcheck_consent") !== null;
    let askedOnRecord = false;
    const cgId = (session.caregiverId ?? session.userId) as string | undefined;
    if (cgId) {
      const cg = (await db.collection("caregivers").doc(cgId).get().catch(() => null))?.data() as Record<string, unknown> | undefined;
      askedOnRecord = consentAlreadyRequested(cg);
    }
    if (inCooldown || askedOnRecord) {
      await updateSession(phone, { onboardingStep: "caregiver_awaiting_bgcheck_consent" });
      await handleCaregiverResendBgcheckConsent(phone, chatId, { ...session, onboardingStep: "caregiver_awaiting_bgcheck_consent" } as AgentSession, text);
      return;
    }
    // No ask out yet: a question is answered first (with the step's facts and
    // tools), then the owed link follows below; an ack / anything else just
    // gets the link.
    const kind = await classifyAwaitingReply(text, "review and authorize their background check via the link Evia is about to send");
    if (kind === "question") {
      await dispatchGateTurnToQaAgent(phone, chatId, text, session, "caregiver_send_bgcheck");
    }
  }
  // Re-send path (resendStuckStep / repeat webhook): the caregiver already
  // authorized on the consent page and a Checkr invitation exists — resend THAT
  // link instead of POSTing a new /v1/invitations (a second candidate would
  // split webhook state and can double-bill). The same link is also in their
  // email from Checkr, which re-sends daily reminders.
  const cachedUrl = (session as any).bgcheckInviteUrl as string | undefined;
  if (cachedUrl && session.caregiverId) {
    if (!(await isBgcheckInviteStale(session))) {
      // Still live → reuse the cached invitation, no new Checkr resource.
      await updateSession(phone, { onboardingStep: "caregiver_awaiting_bgcheck" });
      await sendMessage(chatId, "Here's your background-check link again — takes about 5 minutes. It's also in your email from Checkr:");
      await sendMessage(chatId, { parts: [{ type: "link", value: cachedUrl }] });
      resolveCommitment(phone, "link", "link_sent").catch(() => {});
      return;
    }
    // Stale / webhook-expired: resending would hand out a dead link. Cancel the
    // OLD Checkr invitation so it can't co-exist with the replacement, drop the
    // cached URL, and fall through to the /bgcheck consent page. Re-authorizing
    // there re-mints a fresh invitation via confirmBgcheckConsent, whose re-point
    // branch updates checkrCandidateId so the webhook follows the new candidate.
    // We never mint here — the fresh invite needs the legal name from the consent
    // form, and consent-first stays intact (Checkr is only ever called post-consent).
    await cancelStaleBgcheckInvitation(session);
    await updateSession(phone, { bgcheckInviteUrl: null });
    // fall through to the consent-link flow below.
  }

  // Webapp parity (founder, 2026-07-08): NOTHING touches Checkr until the
  // caregiver reviews the FCRA disclosure and authorizes the check on OUR
  // /bgcheck page — the same disclosure + written consent the webapp's
  // BackgroundCheckModal collects (and it asks for their LEGAL name, which is
  // what records are actually searched against). The page's token callable
  // (v1-confirmBgcheckOnboarding → confirmBgcheckConsent below) then creates
  // the Checkr candidate + invitation server-side, and Checkr EMAILS the
  // caregiver the secure link to enter SSN/DOB directly with Checkr.
  const token      = generateToken({ phone, task: "bgcheck_consent" });
  const consentUrl = `${APP_URL}/bgcheck?t=${token}`;
  await updateSession(phone, { onboardingStep: "caregiver_awaiting_bgcheck_consent" });
  await sendMessage(chatId, await generateCaraMessage({
    audience: "caregiver",
    language: session.preferredLanguage === "es" ? "es" : "en",
    context:
      "The care provider just paid their membership — they're nearly done. Naturally explain: the last big step is the background check every care provider completes, and it's already included in the membership they just paid (no extra charge). The link coming right below opens Evia's secure page where they review the disclosure and authorize the check — takes about a minute. After they authorize, Checkr emails them a secure link to finish; their SSN and date of birth are entered directly with Checkr, never with Evia. Evia texts them the moment results come back clear — then they're approved and families can book them. Never promise a specific turnaround time. Do NOT include any URL.",
    fallback:
      "Almost done! Last big step: your background check — it's already included in your membership, no extra charge. " +
      "Tap the link below to review and authorize it (about a minute). Checkr will then email you a secure link to finish — your SSN and date of birth go directly to Checkr, never to me. " +
      "I'll text you the moment it clears — then you're approved and families can book you.",
    maxTokens: 150,
  }));
  // Rich preview card (2026-07-12): /bgcheck is served through the
  // v1-uploadPageMeta OG rewrite, so a link part renders a branded
  // "Authorize your background check — Evia" card instead of the raw token URL.
  await sendMessage(chatId, { parts: [{ type: "link", value: consentUrl }] });
  // Opens the consent step's resend window (gateLinkCooldown): the next text
  // inside it is read, not answered with the link again (sweep C5).
  await stampGateLinkResent(phone, "caregiver_awaiting_bgcheck_consent").catch(() => {});
  resolveCommitment(phone, "link", "link_sent").catch(() => {});
}

// The caregiver texted while sitting at the consent-page link. Answer any
// question first (with step facts), then re-send a FRESH consent link (tokens
// expire after 2h — a fresh mint is always safe, the page is stateless).
async function handleCaregiverResendBgcheckConsent(phone: string, chatId: string, session: AgentSession, text?: string): Promise<void> {
  if (text) {
    const kind = await classifyAwaitingReply(text, "review and authorize their background check via the link Evia sent");
    if (kind === "ack") {
      await sendAwaitingAck(chatId, session,
        "The care provider just acknowledged your background-check authorization ask (a thanks or 'will do') — you're here when it's done.",
        "Sounds good — I'm here when it's done!");
      return;
    }
    // An explicit "link doesn't work / send it again" gets the consent page
    // again — under the same resend window every other gate step keeps
    // (gateLinkCooldown, sweep C5): inside it the deterministic in-cooldown
    // copy IS the reply, outside it a real resend opens the window.
    if (await wantsGateLinkResend(text)) {
      let fresh: Record<string, unknown> | undefined;
      try { fresh = (await db.collection("agent_sessions").doc(phone).get()).data() as Record<string, unknown> | undefined; } catch { /* fail-open */ }
      const mins = gateLinkCooldownMinutes(fresh, "caregiver_awaiting_bgcheck_consent");
      if (mins !== null) {
        // Truthful deterministic copy — no "reply LINK" promise here (the consent
        // step has no LINK hatch; the bare word is not announced for it).
        await sendMessage(chatId, gateLinkBypassSpentCopy(mins, gateLinkCooldownResetMinutes(fresh, "caregiver_awaiting_bgcheck_consent")));
        return;
      }
      const token      = generateToken({ phone, task: "bgcheck_consent" });
      const consentUrl = `${APP_URL}/bgcheck?t=${token}`;
      await sendMessage(chatId, "Review & authorize your background check here:");
      await sendMessage(chatId, { parts: [{ type: "link", value: consentUrl }] });
      await stampGateLinkResent(phone, "caregiver_awaiting_bgcheck_consent").catch(() => {});
      return;
    }
    if (kind !== "question" && await tryAbsorbGateProfileUpdate(phone, chatId, text, session,
      "reviewing and authorizing your background check via the link I sent")) {
      return;
    }
    // Site parity (2026-09-26): anything else runs the real agent — browsing
    // and questions work exactly as on the website while the check is pending.
    await dispatchGateTurnToQaAgent(phone, chatId, text, session, "caregiver_awaiting_bgcheck_consent");
    return;
  }
  // No text: the stale-session nudge / LINK keyword re-deliver the consent page.
  const token      = generateToken({ phone, task: "bgcheck_consent" });
  const consentUrl = `${APP_URL}/bgcheck?t=${token}`;
  await sendMessage(chatId, "Review & authorize your background check here:");
  await sendMessage(chatId, { parts: [{ type: "link", value: consentUrl }] });
}

// ── Background-check consent confirm (v1-confirmBgcheckOnboarding) ───────────
// Runs when the caregiver submits the FCRA authorization on the /bgcheck page.
// Only NOW does Checkr get involved: candidate-first invitation (Checkr's
// contract) using the LEGAL name from the form, consent recorded on the
// caregiver doc in the same shape the webapp's initiateCheckrCandidate stamps,
// then Evia texts "Checkr just emailed you". Mirrors the webapp flow exactly.
export interface BgcheckConsentForm {
  legalFirstName: string;
  legalLastName:  string;
  zipCode:        string;
  state:          string;
}

export async function confirmBgcheckConsent(
  phone: string,
  form: BgcheckConsentForm
): Promise<{ status: "ok" | "already" }> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  if (!snap.exists) throw new Error(`confirmBgcheckConsent: no session for ${phone}`);
  const session = snap.data() as AgentSession;
  const chatId  = session.chatId;
  const d       = session.onboardingData ?? {};

  // ONE path for both consent surfaces (2026-09-25): the same function the
  // site's dashboard modal calls (checkr.ts initiateCheckrCandidate) — package
  // by profile, candidate reuse on renewal, consent stamp in the site's shape,
  // PII to the private subcollection, the Checkr link texted, the session parked.
  let uid = session.caregiverId ?? await ensureCaregiverDocForOnboarding(phone);
  if (!uid && isOnboardingDryRun()) {
    // Dry-run: the account mint is recorded, never executed (same as before the
    // consent path was unified).
    recordSideEffect("auth.createUser", { phone });
    uid = "dryrun-uid";
  }
  if (!uid) throw new Error(`confirmBgcheckConsent: no care provider account for ${phone}`);
  const cgSnap = await db.collection("caregivers").doc(uid).get();
  const cgData = (cgSnap.data() ?? {}) as Record<string, any>;
  const email = (((cgData.email as string | undefined) || (d.email as string | undefined)) ?? "").trim();

  // Idempotent double-tap: a cached live invitation on the session means the
  // page was already submitted — don't mint a second candidate. Unless the
  // record is waiting on a (re-)consent (yearly renewal), which always proceeds.
  const bgNow = (cgData.backgroundCheckData ?? {}) as Record<string, any>;
  const awaitingReconsent = bgNow.consentRequired === true || bgNow.invitationStatus === "awaiting_consent";
  if ((session as any).bgcheckInviteUrl && session.caregiverId && !awaitingReconsent) {
    return { status: "already" };
  }

  let result: { status: "ok" | "already"; candidateId: string; invitationUrl: string | null };
  try {
    result = await guardSideEffect(
      "checkr.invitation.create",
      () => authorizeBackgroundCheck({
        uid, email, phone,
        // Reaching this page from Evia's link IS the re-authorization (restart /
        // expired invite cleared the cache) — mint a fresh invitation on the
        // existing candidate rather than short-circuiting on the old one.
        reconsent: true,
        form: {
          legalFirstName: form.legalFirstName,
          legalLastName:  form.legalLastName,
          zipCode:        form.zipCode || ((d.zipCode as string | undefined) ?? ""),
          state:          (form.state || CHECKR_WORK_STATE).toUpperCase(),
        },
      }),
      { status: "ok" as const, candidateId: "cand_dryrun", invitationUrl: "https://dryrun.local/checkr" },
    );
  } catch (err) {
    // The caregiver is looking at the page — it shows the retry state — but ops
    // must know, and the SMS failure note covers them closing the tab.
    console.error("confirmBgcheckConsent Checkr invitation error:", err);
    await alertOnboardingLinkFailure(phone, "bgcheck_consent_confirm", err);
    // The LINK was fine — the SUBMISSION failed (live 2026-10-07: Checkr 400 on the MVR invitation).
    // sendOnboardingLinkFailureMessage promised "I'll text the link once it's ready" and queued a link
    // resend, which was wrong here; say what happened and what to do, nothing more.
    if (chatId) {
      await sendMessage(chatId, "Your authorization didn't go through on our side just now. Please tap Submit again on that page, or reply AUTHORIZE for a fresh link, and I'll get it sorted.").catch(() => {});
    }
    throw err;
  }
  if (result.status === "already") return { status: "already" };

  if (!session.caregiverId) await updateSession(phone, { caregiverId: uid });
  // Park the text session on "awaiting the check" ONLY while she is still
  // onboarding. A completed caregiver authorizing the YEARLY refresh (membership
  // renewal / rejoin) keeps her finished session — otherwise the clear report
  // would re-run the onboarding gates (payout link, "you're approved" welcome)
  // on someone who finished a year ago (2026-10-03).
  if (session.onboardingStep !== "complete") {
    await updateSession(phone, { onboardingStep: "caregiver_awaiting_bgcheck" });
  }
  return { status: "ok" };
}


/** Find-or-create the caregiver's Express account EXACTLY the way the site's Setup
 *  Payouts button does (connectAccount.ensureConnectAccount): the RECORD
 *  (caregivers/{id}/private/payout, parent fallback) is the only source of the
 *  account id, so a bank connected on the site is reused, never replaced; a new
 *  account is created with the site's parameters and dual-written onto the record.
 *  The SMS draft's id is only a last resort for sessions older than the record
 *  mirror. Returns null when the session has no caregiver record yet. */
async function ensureCaregiverConnectAccount(phone: string, session: AgentSession): Promise<string | null> {
  // Re-read caregiverId fresh: `session` may be a stale snapshot (these handlers
  // are re-entered by resendStuckStep with a session read before the merge).
  const freshSnap = await db.collection("agent_sessions").doc(phone).get();
  const fresh = freshSnap.exists ? (freshSnap.data() as AgentSession | undefined) : undefined;
  const caregiverId = (fresh?.caregiverId ?? session.caregiverId) as string | undefined;
  if (!caregiverId) return null;
  const d = (fresh?.onboardingData ?? session.onboardingData ?? {}) as Record<string, unknown>;
  const { ensureConnectAccount, persistNewConnectAccount } = await import("../connectAccount");
  const { accountId } = await ensureConnectAccount(getStripe(), caregiverId, {
    email: typeof d.email === "string" && d.email ? d.email : undefined,
    knownAccountId: typeof d.stripeAccountId === "string" ? d.stripeAccountId : null,
    // `phone` rides along on the parent doc so the Connect webhook can match this
    // caregiver even before the gate handoff wrote it.
    persist: (id, created) => guardSideEffect(
      "firestore.set:caregivers.stripeAccountId",
      () => persistNewConnectAccount(caregiverId, id, created, { phone }),
      undefined,
      { phone },
    ),
  });
  // Keep the SMS draft in step with the record (profile mirror / legacy readers).
  if (d.stripeAccountId !== accountId) await mergeOnboardingData(phone, { stripeAccountId: accountId });
  return accountId;
}

async function handleCaregiverSendStripeConnect(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const token = generateToken({ phone, task: "stripe_connect" });
  let connectUrl: string | null = null;
  let linkError: unknown = null;

  await signalThinking(chatId, session.service);
  try {
    // The site's find-or-create path; the record (not the SMS draft) is the source
    // of the account id, and the id lands on the caregiver doc so the Connect
    // webhook (account.updated → charges+payouts enabled) can MATCH this caregiver
    // and finalize onboarding server-side.
    const accountId = await ensureCaregiverConnectAccount(phone, session);
    if (!accountId) throw new Error("no care provider record on this session yet — cannot set up payouts");

    const link = await getStripe().accountLinks.create({
      account:     accountId,
      type:        "account_onboarding",
      return_url:  `${APP_URL}/done?task=stripe_connect&t=${token}`,
      // Stripe sends expired/already-visited account links here — it must mint
      // a FRESH link, never the success page (account links are single-use and
      // iMessage preview fetches can consume them; pointing refresh at /done
      // showed "Payout account ready!" to caregivers who never onboarded).
      refresh_url: `${APP_URL}/stripe-refresh?t=${token}`,
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
      "The care provider's background check just cleared — this is the very last step of signup. Naturally tell them to set up their payout account via the link below so they get paid after every visit. Keep it celebratory but brief. Do NOT include any URL.",
    fallback: "Last step — set up your payout account so you can get paid after every visit:",
    maxTokens: 90,
  }));
  await sendMessage(chatId, { parts: [{ type: "link", value: connectUrl }] });
  resolveCommitment(phone, "link", "link_sent").catch(() => {});
}

// ── Stripe Connect: fresh-link mint + real-state verification ────────────────
// Account links are single-use and expire; Stripe redirects any dead link to
// the refresh_url, and the return_url fires on flow EXIT — completed or not
// (Stripe docs: return_url does not signal completion). Both facts mean the
// only trustworthy completion signal is the account's own charges/payouts
// flags — read here on the /done path and by the Connect webhook.

/** Mint a fresh Connect onboarding link, reusing (or creating) the caregiver's
 *  Express account. Used by the v1-stripeConnectRefresh redirect endpoint and
 *  by the /done page when verification finds the setup unfinished. */
export async function mintStripeConnectAccountLink(phone: string): Promise<string | null> {
  try {
    const snap = await db.collection("agent_sessions").doc(phone).get();
    if (!snap.exists) return null;
    const session = snap.data() as AgentSession;
    // The site's find-or-create path (record first — see ensureCaregiverConnectAccount).
    const accountId = await ensureCaregiverConnectAccount(phone, session);
    if (!accountId) return null;
    const token = generateToken({ phone, task: "stripe_connect" });
    const link = await getStripe().accountLinks.create({
      account:     accountId,
      type:        "account_onboarding",
      return_url:  `${APP_URL}/done?task=stripe_connect&t=${token}`,
      refresh_url: `${APP_URL}/stripe-refresh?t=${token}`,
    });
    return link.url;
  } catch (err) {
    console.error("mintStripeConnectAccountLink error:", err);
    return null;
  }
}

export type StripeConnectVerification =
  | { status: "complete" }
  | { status: "incomplete"; finishUrl: string | null }
  | { status: "unverified" };

/** Ask Stripe whether this caregiver's Connect onboarding actually finished.
 *  "complete" mirrors the Connect webhook's bar (charges + payouts enabled).
 *  Fails CLOSED ("unverified") on Stripe API errors — a lost advancement is
 *  recoverable via the webhook; a false activation is not. */
export async function verifyStripeConnectComplete(phone: string): Promise<StripeConnectVerification> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  const session = snap.exists ? (snap.data() as AgentSession) : undefined;
  // The record is the source of the account id (the site may have connected the
  // bank); the SMS draft only covers sessions older than the record mirror.
  let accountId: string | undefined;
  if (session?.caregiverId) {
    const { getCaregiverPayoutFields } = await import("../caregiverPrivate");
    const onRecord = (await getCaregiverPayoutFields(session.caregiverId as string)).stripeAccountId;
    if (typeof onRecord === "string" && onRecord) accountId = onRecord;
  }
  if (!accountId) accountId = (session?.onboardingData as Record<string, unknown> | undefined)?.stripeAccountId as string | undefined;
  if (!accountId) {
    // No Express account was ever created for them — nothing can be complete.
    return { status: "incomplete", finishUrl: await mintStripeConnectAccountLink(phone) };
  }
  let account: Stripe.Account;
  try {
    account = await getStripe().accounts.retrieve(accountId);
  } catch (err) {
    console.error("verifyStripeConnectComplete accounts.retrieve error:", err);
    return { status: "unverified" };
  }
  const complete = !!account.charges_enabled && !!account.payouts_enabled;
  if (!complete) {
    return { status: "incomplete", finishUrl: await mintStripeConnectAccountLink(phone) };
  }
  // Stamp the caregiver doc with the same fields the Connect webhook writes so
  // the webapp reflects reality even if account.updated delivery lags.
  if (session?.caregiverId) {
    const connectStamp = {
      chargesEnabled:              true,
      payoutsEnabled:              true,
      detailsSubmitted:            !!account.details_submitted,
      stripeOnboardingComplete:    true,
      stripeOnboardingCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await db.collection("caregivers").doc(session.caregiverId as string)
      .set(connectStamp, { merge: true })
      .catch((err) => console.error("verifyStripeConnectComplete caregiver stamp failed (non-fatal):", err));
    const { writeCaregiverPayoutPrivate } = await import("../caregiverPrivate");
    await writeCaregiverPayoutPrivate(session.caregiverId as string, connectStamp);
  }
  return { status: "complete" };
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
      const selectedPriceId = d.selectedPlanPriceId as string | undefined;
      try {
        const stripeSession = await createClientMembershipCheckout(phone, caraPhone, selectedPriceId, session.userId as string | undefined);
        if (!stripeSession.url) throw new Error("Stripe checkout session created without a URL");
        url = await createBrandedLink("pay", stripeSession.url, phone);
      } catch (err) {
        // Same guarantee as handleClientSendPayment: a checkout-create failure
        // must NEVER fall through to /payment/success (post-charge page, R7).
        // Alert ops + route through the shared apology/retry path (commitment
        // recorded, grounded copy, no URL) and stop — do not send a link.
        console.error("sendOnboardingLink client_payment stripe error:", err);
        await alertOnboardingLinkFailure(phone, "client_payment", err);
        await sendOnboardingLinkFailureMessage(phone, chatId, session, "client-payment");
        return { success: false, linkType };
      }
      break;
    }

    case "caregiver_membership": {
      // Reuse the cached Checkout link only while Stripe still honors it —
      // Checkout sessions expire after 24 h. A lapsed member replying ACTIVATE
      // months later used to get the dead link ("You're all done here…");
      // sessions from before the stamp count as stale (2026-10-03).
      const stored = session.membershipCheckoutUrl as string | undefined;
      const storedAtMs = Date.parse(String((session as any).membershipCheckoutCreatedAt ?? ""));
      const storedFresh = !!stored && Number.isFinite(storedAtMs) && Date.now() - storedAtMs < 23 * 60 * 60 * 1000;
      if (storedFresh) { url = stored as string; break; }
      const token = generateToken({ phone, task: "caregiver_membership" });
      url = `${APP_URL}/done?task=caregiver_membership&t=${token}`;
      {
        const wantsMvr   = offersTransportation(d as Record<string, unknown>);
        // Flat fee: includeMVR only selects the bundled Checkr package — see handleCaregiverSendMembership.
        const mvrCharged = wantsMvr && isMvrCheckConfigured("bundled");
        // The site's checkout path (caregiverMembershipBilling.ts) — same as the onboarding step.
        const { createCaregiverMembershipCheckout } = await import("../caregiverMembershipBilling");
        const stripeSession = await createCaregiverMembershipCheckout(getStripe() as any, {
          uid: (session.caregiverId ?? session.userId) as string | undefined,
          phone,
          successUrl: `${APP_URL}/done?task=caregiver_membership&t=${token}`,
          cancelUrl: `${APP_URL}/start`,
          includeMVR: mvrCharged,
        });
        url = stripeSession.url ?? url;
      }
      await updateSession(phone, { membershipCheckoutUrl: url, membershipCheckoutCreatedAt: new Date().toISOString() });
      break;
    }

    case "caregiver_photo": {
      url = `${APP_URL}/upload/photo?t=${generateToken({ phone, task: "photo_upload" })}`;
      break;
    }

    case "caregiver_background_check": {
      const stored = session.bgcheckInviteUrl as string | undefined;
      if (stored) { url = stored; break; }
      // No invitation yet = the caregiver hasn't authorized the check on the
      // /bgcheck consent page (webapp parity, 2026-07-08: FCRA disclosure +
      // written authorization BEFORE any Checkr call — the invitation is
      // created by v1-confirmBgcheckOnboarding when they submit, and Checkr
      // then emails them the secure completion link). Sending the consent link
      // here means the agent tool can never bypass consent.
      url = `${APP_URL}/bgcheck?t=${generateToken({ phone, task: "bgcheck_consent" })}`;
      break;
    }

    case "caregiver_payouts": {
      const token = generateToken({ phone, task: "stripe_connect" });
      // The site's Setup Payouts path (find-or-create on the RECORD) — the same
      // account whether the caregiver taps the button or texts SETUP. Safe even
      // mid-flow: advanceOnboardingStep's stripe_connect step guard refuses to
      // finalize unless the session is at the Connect step.
      const accountId = await ensureCaregiverConnectAccount(phone, session);
      if (!accountId) throw new Error("sendOnboardingLink caregiver_payouts: no care provider record on this session yet");
      const link = await getStripe().accountLinks.create({
        account:     accountId,
        type:        "account_onboarding",
        return_url:  `${APP_URL}/done?task=stripe_connect&t=${token}`,
        // Expired/used links must re-mint, never land on the success page
        // (see handleCaregiverSendStripeConnect).
        refresh_url: `${APP_URL}/stripe-refresh?t=${token}`,
      });
      url = link.url;
      break;
    }

    default:
      throw new Error(`sendOnboardingLink: unknown linkType ${linkType as string}`);
  }

  // Every onboarding link renders as a rich preview card: app-hosted token
  // pages (/upload/**, /bgcheck) are served through the v1-uploadPageMeta OG
  // rewrite (2026-07-12), and external provider URLs (Stripe checkout/Connect,
  // Checkr) carry their own OG. isCardSafeUrl in linq/client.ts remains the
  // chokepoint that downgrades any no-OG URL to tappable plain text.
  await sendMessage(chatId, { parts: [{ type: "link", value: url }] });
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
    case "caregiver_awaiting_bgcheck_consent":
    case "caregiver_awaiting_bgcheck":
    case "caregiver_send_bgcheck": {
      // Pre-consent → fresh /bgcheck authorization link; post-consent (cached
      // invitation) → the Checkr link again. handleCaregiverSendBgcheck routes.
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
      if (!taskData) {
        console.error(`advanceOnboardingStep(payment): refusing activation without subscription id for phone=${phone}`);
        return;
      }

      // Mark task processed before any writes to prevent race on retry
      await db.collection("agent_sessions").doc(phone).update({
        processedWebhookTasks: admin.firestore.FieldValue.arrayUnion(task),
      });

      const d = session.onboardingData ?? {};

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
      // stripe.ts stamps the Stripe customer id on the agent session BEFORE
      // calling advanceOnboardingStep — mirror it onto users/{uid} and
      // customers/{uid}: the client Payments page reads
      // customers/{uid}.stripeCustomerId to show "Manage payment method", and
      // the shared billing-portal callable resolves the customer from that
      // same doc (identical fix to the caregiver membership case).
      const clientCustId = (session as any).stripeCustomerId as string | undefined;
      if (uid) {
        await db.collection("users").doc(uid).set({
          // uid must live IN the doc too — services/api.ts getUser gates the
          // client role resolution on data.uid being present.
          uid,
          membershipStatus:   "active",
          subscriptionActive: true,
          // Same field name the site's Stripe webhook writes (stripe.ts
          // `subscriptionId: subscription.id`) — not an Evia-only alias.
          subscriptionId:     taskData,
          ...(clientCustId ? { stripeCustomerId: clientCustId } : {}),
          phone,
          firstName:          (d.firstName ?? "") as string,
          updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        if (clientCustId) {
          await db.collection("customers").doc(uid).set({
            stripeCustomerId: clientCustId,
          }, { merge: true }).catch((err) =>
            console.error("advanceOnboardingStep(payment): customers/{uid} mirror failed:", err));
        }

      }

      // Care records (job_postings, carePlans, senior_profiles) were already
      // persisted at intake-confirm (handleClientShowCaregivers →
      // persistClientCareRecords); re-run the same merge-writes here so
      // anything volunteered at a gate lands.
      await persistClientCareRecords(uid, phone, d);

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
        careNeeds:   Array.isArray(d.careNeeds)  ? d.careNeeds  as string[] : undefined,
        city:        d.city         as string | undefined,
        relationship: d.relationship as string | undefined,
        daysPerWeek: d.daysPerWeek  ? Number(d.daysPerWeek) : undefined,
        timeOfDay:   d.timeOfDay    as string | undefined,
      }).catch((err) => console.error("pushOnboardingDataToZep error:", err));

      // "Your membership is active" — once per account, same moment the site's
      // Membership page flips (client-notified rule; live 2026-09-20 nothing was sent).
      if (uid) {
        const { notifyClientMembershipActivatedOnce } = await import("../membershipNotify");
        await notifyClientMembershipActivatedOnce(uid).catch((err) => console.warn("membership notice failed", err instanceof Error ? err.message : err));
      }
      // We already collected schedule, care needs, and budget during intake —
      // don't make them re-answer it all. Pre-fill the job post and ask for a
      // single confirmation (they can still choose to edit, which drops into the
      // full step-by-step flow).
      await presentPrefilledJobPost(phone, chatId, session);
      break;
    }

    case "photo_upload": {
      // The wizard's photo step lives INSIDE the collection loop (2026-09-25):
      // the URL (upload page OR a texted headshot) is saved as profilePhoto —
      // mergeOnboardingData mirrors it to caregivers/{uid}.photo — and, when the
      // caregiver is mid-collection, the loop resumes with the next question.
      if (taskData) await mergeOnboardingData(phone, { profilePhoto: taskData });
      const photoStep = session.onboardingStep ?? "";
      if (collectionStepsForRole("caregiver").includes(photoStep)) {
        await resumeCaregiverCollection(phone, chatId);
      } else {
        // Post-onboarding photo UPDATE (caregiverProfileHandler's UPDATE_PHOTO
        // flow reuses this token task) — confirm, never re-enter onboarding.
        await sendMessage(chatId, await generateCaraMessage({
          audience: "caregiver",
          language: session.preferredLanguage === "es" ? "es" : "en",
          context: "The care provider just uploaded a new profile photo (an update to their existing profile — they are NOT in onboarding). ONE short warm line confirming the new photo is saved on their profile.",
          fallback: "Got it — your new profile photo is saved on your profile.",
          maxTokens: 40,
        }));
      }
      break;
    }

    case "membership": {
      await db.collection("agent_sessions").doc(phone).update({
        processedWebhookTasks: admin.firestore.FieldValue.arrayUnion(task),
      });

      // The record gets the SAME writes the site's payment webhook makes
      // (caregiverMembershipBilling.markCaregiverMembershipPaid): membershipPaid,
      // verificationStatus 'submitted' (admin queue), mvrPaid when Transportation
      // is offered, users/{uid} membership fields, customers/{uid} (the Manage
      // button's customer), then parked on "authorize your background check".
      // Non-fatal: the conversation must advance even if the mirror write fails.
      try {
        let uid = (session.userId ?? session.caregiverId) as string | undefined;
        if (!uid) {
          uid = await admin.auth().getUserByPhoneNumber(phone)
            .then((u) => u.uid).catch(() => undefined);
        }
        if (uid && (session as any).membershipRecordedAt) {
          // The Stripe webhook already wrote the record for this payment (stripe.ts).
        } else if (uid) {
          const { markCaregiverMembershipPaid } = await import("../caregiverMembershipBilling");
          await markCaregiverMembershipPaid(uid, {
            subscriptionId: (session as any).caregiverSubscriptionId as string | undefined,
            customerId:     (session as any).stripeCustomerId as string | undefined,
            phone,
          });
        } else {
          // No auth uid yet (cold-SMS path before doc creation) — the Stripe
          // Connect finalization mirrors membershipPaid from
          // caregiverSubscriptionId when it creates the doc.
          console.warn(`advanceOnboardingStep(membership): no uid resolvable for phone=${phone} — membership mirror deferred to finalization`);
        }
      } catch (err) {
        console.error("advanceOnboardingStep(membership): membership mirror failed (non-fatal):", err);
      }

      await updateSession(phone, { onboardingStep: "caregiver_send_bgcheck" });
      // The "membership active" notice itself (bell + text) comes from
      // onCaregiverAccountChange when membershipPaid flips above; this step
      // only delivers the next thing the dashboard card offers — the consent link.
      await handleCaregiverSendBgcheck(phone, chatId, session);
      break;
    }

    case "background_check": {
      await db.collection("agent_sessions").doc(phone).update({
        processedWebhookTasks: admin.firestore.FieldValue.arrayUnion(task),
      });
      // The "background check approved" notice (bell + text) comes from
      // onCaregiverAccountChange. This step only moves a session that is
      // actually waiting on the check to the next dashboard card — payouts —
      // and sends that link. A finished or unrelated session is left alone
      // (2026-09-27: this used to rewind any session to the Connect step).
      const bgStepNow = (session.onboardingStep ?? "") as string;
      if (!["caregiver_awaiting_bgcheck", "caregiver_send_bgcheck", "caregiver_awaiting_bgcheck_consent"].includes(bgStepNow)) {
        console.info(`advanceOnboardingStep: ignoring background_check at step="${bgStepNow}" for phone=${phone}`);
        break;
      }
      await updateSession(phone, { onboardingStep: "caregiver_send_stripe_connect" });
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

        // Explicitly close the loop on the identity check FIRST. The family was
        // told (on the verification page) that Evia would let them know when it
        // cleared; folding that straight into a payment ask read as "no
        // confirmation ever came." One short, unambiguous line, then payment.
        // Deterministic (never generateCaraMessage) — this is a precise status
        // confirmation that must never fail-open to a hallucinated status line.
        await sendMessage(chatId,
          session.preferredLanguage === "es"
            ? "¡Tu verificación de identidad se aprobó — estás verificado! ✅"
            : "Your identity check just cleared — you're verified! ✅"
        );

        // Site order (2026-09-06 fix): Identity clears BEFORE any price is
        // mentioned, matching the website's own tracker (Care Plan → Identity
        // → Membership) — pitch the membership price now; handleClientPlanReply
        // sends the actual Stripe checkout link once the family confirms.
        await updateSession(phone, { onboardingStep: "client_ask_plan" });
        await handleClientPresentPlan(phone, chatId, session);
      }
      // (caregiver_awaiting_identity forwarding removed — U12, R17: the retired
      // step no longer exists; caregivers never receive an identity task.)
      break;
    }

    // Admin manually approved identity — same as the Stripe webhook path but
    // without requiring a verification session ID.
    //
    // 2026-09-03 fix: this used to gate the ENTIRE thing — including the
    // users/{uid}.identityCheckStatus write — behind the session being
    // exactly at client_awaiting_identity. If it wasn't (e.g. already stuck
    // on an earlier step from the same root cause the resync fix elsewhere
    // in this file addresses), the admin's approval silently did nothing at
    // all: no error, no fields written, no sign anything was wrong. An
    // admin's "approve this person's identity" is a fact about their
    // ACCOUNT, not something that should depend on where their SMS
    // conversation happens to be parked — so the data write now always
    // happens; only the conversational follow-up (announce it, advance the
    // session to the next gate) stays conditional on the session actually
    // being at the moment expecting it.
    case "admin_identity_override": {
      await db.collection("agent_sessions").doc(phone).update({
        processedWebhookTasks: admin.firestore.FieldValue.arrayUnion("identity"),
      });
      let uid = session.userId as string | undefined;
      if (!uid) {
        uid = await admin.auth().getUserByPhoneNumber(phone).then(u => u.uid).catch(() => undefined);
        if (uid) await updateSession(phone, { userId: uid });
      }
      if (uid) {
        await db.collection("users").doc(uid).set({
          uid,
          identityCheckStatus: "verified",
          identityVerifiedAt:  admin.firestore.FieldValue.serverTimestamp(),
          phone,
          updatedAt:           admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } else {
        console.error(`admin_identity_override: no uid resolvable for phone=${phone} — identityCheckStatus NOT written.`);
      }
      const step = session.onboardingStep ?? "";
      if (step === "client_awaiting_identity") {
        await sendMessage(chatId,
          session.preferredLanguage === "es"
            ? "¡Tu verificación de identidad se aprobó — estás verificado! ✅"
            : "Your identity check just cleared — you're verified! ✅"
        );
        // Site order (2026-09-06 fix): pitch the membership price now that
        // identity is clear, matching the Stripe webhook path above.
        await updateSession(phone, { onboardingStep: "client_ask_plan" });
        await handleClientPresentPlan(phone, chatId, session);
      } else {
        console.info(`admin_identity_override: identity approved for uid=${uid ?? "unknown"}, but session step="${step}" wasn't awaiting it — data updated, no SMS follow-up sent.`);
      }
      break;
    }

    // Admin manually approved membership — advances without a Stripe subscription ID.
    // Same 2026-09-03 fix as admin_identity_override above: the users/{uid}
    // membership write now always happens; only the SMS follow-up (job-post
    // prefill message) stays conditional on the session being at the right step.
    case "admin_payment_override": {
      await db.collection("agent_sessions").doc(phone).update({
        processedWebhookTasks: admin.firestore.FieldValue.arrayUnion("payment"),
      });
      let uid = session.userId as string | undefined;
      if (!uid) {
        uid = await admin.auth().getUserByPhoneNumber(phone).then(u => u.uid).catch(() => undefined);
        if (uid) await updateSession(phone, { userId: uid });
      }
      if (uid) {
        await db.collection("users").doc(uid).set({
          uid,
          membershipStatus:   "active",
          subscriptionActive: true,
          phone,
          updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        const d = session.onboardingData ?? {};
        await persistClientCareRecords(uid, phone, d);
      } else {
        console.error(`admin_payment_override: no uid resolvable for phone=${phone} — membershipStatus NOT written.`);
      }
      const payStep = session.onboardingStep ?? "";
      if (payStep === "client_send_payment" || payStep === "client_awaiting_payment") {
        await presentPrefilledJobPost(phone, chatId, session);
      } else {
        console.info(`admin_payment_override: membership approved for uid=${uid ?? "unknown"}, but session step="${payStep}" wasn't awaiting it — data updated, no SMS follow-up sent.`);
      }
      break;
    }

    // Admin manually approved caregiver membership — advances without Stripe subscription.
    case "admin_caregiver_membership_override": {
      await db.collection("agent_sessions").doc(phone).update({
        processedWebhookTasks: admin.firestore.FieldValue.arrayUnion("membership"),
      });
      const memStep = session.onboardingStep ?? "";
      if (memStep === "caregiver_send_membership" || memStep === "caregiver_awaiting_membership") {
        let uid = (session.userId ?? session.caregiverId) as string | undefined;
        if (!uid) {
          uid = await admin.auth().getUserByPhoneNumber(phone).then(u => u.uid).catch(() => undefined);
        }
        if (uid) {
          await db.collection("caregivers").doc(uid).set({ uid, phone, membershipPaid: true }, { merge: true });
          await db.collection("users").doc(uid).set({ membershipStatus: "active", subscriptionActive: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        }
        await updateSession(phone, { onboardingStep: "caregiver_send_bgcheck" });
        // The "membership active" notice comes from onCaregiverAccountChange.
        await handleCaregiverSendBgcheck(phone, chatId, session);
      }
      break;
    }

    // Admin manually approved caregiver background check — advances without Checkr webhook.
    case "admin_caregiver_bgcheck_override": {
      await db.collection("agent_sessions").doc(phone).update({
        processedWebhookTasks: admin.firestore.FieldValue.arrayUnion("background_check"),
      });
      const bgStep = session.onboardingStep ?? "";
      if (bgStep === "caregiver_awaiting_bgcheck" || bgStep === "caregiver_send_bgcheck" || bgStep === "caregiver_awaiting_bgcheck_consent") {
        await updateSession(phone, { onboardingStep: "caregiver_send_stripe_connect" });
        // The "background check approved" notice comes from onCaregiverAccountChange.
        await handleCaregiverSendStripeConnect(phone, chatId, session);
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
      // No coords safety net here (2026-10-11): the record's address fields
      // go through triggers/caregiverGeocode.ts, the one owner of caregiver
      // lat/lng (street-level), which also fills a record that lacks them.
      const d = (session.onboardingData ?? {}) as Record<string, unknown>;
      const profileData = {
        phone,
        ...buildCaregiverProfileMirror(d),
        membershipSubscriptionId: (session as any).caregiverSubscriptionId ?? null,
        // Webapp parity: the dashboard's membership step reads membershipPaid.
        // Normally the "membership" webhook task mirrored this already; this
        // covers sessions where no uid was resolvable at payment time.
        ...((session as any).caregiverSubscriptionId ? { membershipPaid: true } : {}),
        // onboardingStatus 'profile_complete' is stamped when collection
        // completes (complete_collection — the wizard's bio-save moment), and
        // `status: 'active'` is the Checkr webhook's to write on a clear check,
        // exactly as on the site. Neither belongs here (2026-09-25).
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
        const existingData = existingSnap.data() ?? {};
        const currentVStatus = existingData.verificationStatus as string | undefined;
        const vStatusPatch = (!currentVStatus || !TERMINAL_VSTATUSES.includes(currentVStatus))
          ? { verificationStatus: "submitted" }
          : {};
        // The questionnaire finished long before payouts — never move the site
        // wizard's cursor back here, and MERGE: with no changed keys the mirror is
        // fill-only, so a field the caregiver edited on the site since (bio, rate,
        // availability grid…) is never overwritten by the older text draft
        // (sweep C4, 2026-10-11). Only the gating fields are finalization's own.
        const finalizeData = profileMirrorForExisting(profileData, existingData);
        if (authUid && session.caregiverId !== authUid) {
          // Legacy random-ID doc (pre-created before uid-keying landed) — migrate
          // everything onto caregivers/{uid} and drop the orphan. The Checkr webhook
          // looks caregivers up by backgroundCheckData.checkrCandidateId (a query,
          // not a doc ID), so the lookup survives the move.
          const oldData = existingSnap.exists ? existingData : {};
          await db.collection("caregivers").doc(authUid).set(
            { ...oldData, ...finalizeData, ...vStatusPatch, uid: authUid },
            { merge: true }
          );
          if (existingSnap.exists) await existingSnap.ref.delete().catch(() => {});
          caregiverId = authUid;
        } else {
          // Doc was pre-created earlier — fill what it lacks (never an empty update: Firestore rejects it).
          const finalizePatch = { ...finalizeData, ...vStatusPatch };
          if (Object.keys(finalizePatch).length > 0) {
            await db.collection("caregivers").doc(session.caregiverId).set(finalizePatch, { merge: true });
          }
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
      // Never flip an existing role: if this uid already has a client account
      // with real progress (a seniorId on file), this same phone finishing a
      // caregiver setup must not silently overwrite userType to "caregiver" —
      // that's what corrupted the account into "confused which role" bugs.
      // (ensureWebAccount and createWebOnboardingSession already guard this the
      // same way; this write site was the one unconditional exception.)
      if (authUid) {
        const existingUserSnap = await db.collection("users").doc(authUid).get().catch(() => null);
        const existingUserData = existingUserSnap?.data() as Record<string, unknown> | undefined;
        const existingSeniorIds = (existingUserData?.seniorIds as string[] | undefined) ?? [];
        const hasConflictingClientProgress =
          existingUserData?.userType === "client" &&
          (!!(existingUserData?.seniorId as string | undefined) || existingSeniorIds.length > 0
            // jobPostingCompleted is the wizard's own flag and what Evia's
            // persistClientCareRecords sets (users.seniorIds is no longer written).
            || existingUserData?.jobPostingCompleted === true);
        if (hasConflictingClientProgress) {
          console.error(
            `caregiver finalize: refusing to overwrite users/${authUid}.userType — ` +
            `already a client account with real progress for phone ${phone}`
          );
        }
        await db.collection("users").doc(authUid).set({
          uid:        authUid,
          ...(hasConflictingClientProgress ? {} : { userType: "caregiver" }),
          name:       (d.name ?? null) as string | null,
          phone,
          email:      (d.email ?? null) as string | null,
          caregiverId,
          // Membership parity (MCP tools + winback read users.membershipStatus) —
          // only when the membership webhook actually recorded a subscription.
          ...((session as any).caregiverSubscriptionId ? {
            membershipStatus:   "active",
            subscriptionActive: true,
            subscriptionId:     (session as any).caregiverSubscriptionId,
          } : {}),
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

      // Setup is finished here, exactly where the website's progress bar
      // completes. Nothing is announced from this step (2026-09-27: the old
      // "you're approved" celebration, money note and capability note were
      // Evia-only) — "Payouts set up" and, once bookable, "You're all set"
      // reach the caregiver as bell + text from onCaregiverAccountChange, the
      // same way every other progress-bar change does.
      await db.collection("agent_sessions").doc(phone).update({
        onboardingStep: "complete",
        optedIn:        true,
      });
      await db.collection("admin_alerts").add({
        type:        "caregiver_onboarding_complete",
        caregiverId,
        name:        d.name,
        phone,
        note:        "Care Provider completed onboarding — profile is live and ready to match.",
        createdAt:   new Date().toISOString(),
        resolved:    false,
      });
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
  // Care needs only — conditions/diagnoses are never collected (non-medical
  // scope). jobCareLevel is the Post-a-Job flow's own field (job_posts), the
  // same derivation jobPostingFlow.ts uses.
  const careNeeds   = (Array.isArray(d.careNeeds)  ? d.careNeeds  : []) as string[];
  const careLevel   = deriveCareLevel([], careNeeds);

  // careFrequency from wizard/SMS takes precedence over derived-from-count
  const careFrequency = d.careFrequency as string | undefined;
  const selectedDays  = Array.isArray(d.selectedDays) ? d.selectedDays as string[] : [];
  const daysPerWeek   = selectedDays.length || Number(d.daysPerWeek ?? 0);
  const frequency     = careFrequency ?? (daysPerWeek >= 5 ? "full_time" : daysPerWeek >= 3 ? "part_time" : "occasional");

  // The onboarding rate is always a number (wizard parity); "flexible" here is
  // the later Post-a-Job flow's own rateFlexible convention, not a signup value.
  const rateNum = coerceClientRate(d.rate);
  const hourlyRate: number | string = rateNum !== null ? rateNum : "flexible";

  return {
    jobStartDate:     (d.startDate as string) || "ASAP",
    jobFrequency:     frequency,
    jobDays:          selectedDays.length ? selectedDays : [],
    jobDaysPerWeek:   daysPerWeek,
    jobTimeOfDay:     mapTimeOfDayToSlots((d.timeOfDay as string) ?? ""),
    jobCareNeeds:     careNeeds,
    jobCareLevel:     careLevel,
    jobHourlyRate:    hourlyRate,
    jobPaymentMethod: (d.paymentMethod as string) || "card",
    jobDescription:   (d.jobDescription as string) || "",
    petsInHome:       d.petsInHome === true,
    smokingHousehold: d.smokingHousehold === true,
  };
}

async function presentPrefilledJobPost(phone: string, chatId: string, session: AgentSession): Promise<void> {
  // Site parity (2026-10-04): the dashboard's What's Next card posts the job the
  // first time it loads with identity + membership both done — silently, after
  // checking that no post exists for this family yet (components/client/
  // WhatsNext.tsx). Same here: no question, one post per family, one line.
  // (The old "post it as-is? YES" review step was Evia-only; handleJobConfirmPrefill
  // stays only for sessions already parked on it.)
  const d       = session.onboardingData ?? {};
  const jobData = deriveJobDataFromIntake(d);
  await mergeOnboardingData(phone, jobData);
  const uid = session.userId as string | undefined;
  if (!uid) {
    // No account yet (legacy) — the step-by-step post collects what it needs.
    await updateSession(phone, { onboardingStep: "job_ask_start" });
    await handleJobAskStart(phone, chatId, "", session);
    return;
  }
  // The site's own check: is there already a post for this family (paid on the
  // site → the dashboard posted it)? Then nothing to post, just say so.
  const existing = await db.collection("job_posts").where("clientId", "==", uid).limit(1).get().catch(() => null);
  if (existing && !existing.empty) {
    await updateSession(phone, { onboardingStep: "complete", optedIn: true });
    await sendMessage(chatId, "Your care request is already live — care providers nearby can apply, and I'll reach out as applications come in.");
    return;
  }
  try {
    const refreshed  = await db.collection("agent_sessions").doc(phone).get();
    const onboarding = (refreshed.data()?.onboardingData ?? {}) as Record<string, unknown>;
    const { jobId } = await buildAndSaveJobPost({ uid, phone, onboardingData: onboarding, jobData: onboarding });
    await updateSession(phone, { onboardingStep: "complete", optedIn: true });
    await sendMessage(chatId, jobLiveMessage);
    await sendMessage(chatId, buildHelpSmsReply("client", undefined, languageFromSession(session as unknown as Record<string, unknown>)));
    const { presentCaregiverSearch } = await import("./caregiverSearch");
    presentCaregiverSearch({ phone, chatId, source: "post_job_prefill" }).catch((err) =>
      console.error("presentCaregiverSearch error:", err));
    console.log(`[presentPrefilledJobPost] Job posted: ${jobId} for uid=${uid}`);
  } catch (err) {
    console.error("[presentPrefilledJobPost] buildAndSaveJobPost error:", err);
    await sendMessage(chatId, "There was a problem posting your request — our team has been notified. You can also post it at " + APP_URL + "/client/post-job");
  }
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
  const already = await db.collection("job_posts").where("clientId", "==", uid).limit(1).get().catch(() => null);
  if (already && !already.empty) {
    await updateSession(phone, { onboardingStep: "complete", optedIn: true });
    await sendMessage(chatId, "Your care request is already live — care providers nearby can apply, and I'll reach out as applications come in.");
    return;
  }
  try {
    const refreshed  = await db.collection("agent_sessions").doc(phone).get();
    const onboarding = (refreshed.data()?.onboardingData ?? {}) as Record<string, unknown>;
    const { jobId } = await buildAndSaveJobPost({ uid, phone, onboardingData: onboarding, jobData: onboarding });
    // Site parity (2026-09-23): the site posts the request and lands on the
    // dashboard / Find Caregivers — no follow-up permission questions.
    await updateSession(phone, { onboardingStep: "complete", optedIn: true });
    await sendMessage(chatId, jobLiveMessage);
    await sendMessage(chatId, buildHelpSmsReply("client", undefined, languageFromSession(session as unknown as Record<string, unknown>)));
    const { presentCaregiverSearch } = await import("./caregiverSearch");
    presentCaregiverSearch({ phone, chatId, source: "post_job_prefill" }).catch((err) =>
      console.error("presentCaregiverSearch error:", err));
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
    `Your membership is active! 🎉 Let's find the perfect care provider for ${(d.seniorName as string) ?? "your loved one"}.\n\n` +
    `When would you like care to start? (e.g. "next Monday", "ASAP", "June 1")`
  );
  await updateSession(phone, { onboardingStep: "job_ask_frequency" });
}

async function handleJobAskFrequency(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const startDate = await parseWithClaude(
    `Today's date is ${today}. Extract a start date from this message. If the user says 'ASAP' or similar, return 'ASAP'. ` +
    "If they say a relative date like 'tomorrow', 'next Monday', 'in 2 weeks', resolve it to an actual date. " +
    "Return the date in YYYY-MM-DD format. Reply with just the date value, nothing else.",
    text
  );
  await mergeOnboardingData(phone, { jobStartDate: startDate !== "__parse_error__" ? startDate : text.trim() });
  await updateSession(phone, { onboardingStep: "job_ask_days" });
  await sendMessage(chatId,
    "How often do you need help — just occasional (a day or two a week), part-time (3–4 days), or full-time (5+ days)?"
  );
}

async function handleJobAskDays(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text, "How often do you need help? Occasional, part-time, or full-time")) {
    const answer = await answerQuestionMidFlow(text, session, phone);
    await sendMessage(chatId, answer);
    await sendMessage(chatId,
      "So — how often do you need help? Occasional (1–2 days a week), part-time (3–4 days), or full-time (5+)?"
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
    const answer = await answerQuestionMidFlow(text, session, phone);
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
    `${days.length === 7 ? "Every day" : days.join(", ")} — perfect! What time of day works best — ` +
    `mornings, afternoons, evenings, overnight, or a mix?`
  );
}

async function handleJobAskCareNeeds(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text, "What time of day works best? Morning, Afternoon, Evening, or Overnight")) {
    const answer = await answerQuestionMidFlow(text, session, phone);
    await sendMessage(chatId, answer);
    await sendMessage(chatId,
      "So — what time of day works best? Mornings, afternoons, evenings, overnight, or a mix?"
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
    `Got it — ${timeOfDay.join(" & ")}! What kind of help does ${(d.seniorName as string) ?? "your loved one"} need? ` +
    `Just tell me in your own words — things like mobility, memory care, medications, personal care ` +
    `(bathing, dressing), meals, rides, light housekeeping, or companionship. Whatever applies.`
  );
}

async function handleJobAskCareLevel(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text, "What kind of help does your loved one need? (mobility, memory care, meals, etc.)")) {
    const answer = await answerQuestionMidFlow(text, session, phone);
    await sendMessage(chatId, answer);
    const d2 = session.onboardingData ?? {};
    await sendMessage(chatId,
      `So — what kind of help does ${(d2.seniorName as string) ?? "your loved one"} need? ` +
      `Mobility, memory care, medications, personal care, meals, rides, housekeeping, companionship — whatever applies.`
    );
    return;
  }
  // Values match CARE_TYPES (components/client/postJob/types.ts) exactly —
  // these feed into the same careNeeds field the web wizard writes, which
  // CarePlan.tsx renders as parent categories and caregiver skill-matching
  // searches on; a near-miss variant here never matches (see careNeedCategories.ts).
  // The numbered menu covers the list(s) for who the care is for — derived from the people named (2026-10-19), nobody yet = senior.
  const intakeKinds = rosterCareKinds(allCareRecipients((session.onboardingData ?? {}) as Record<string, unknown>));
  const menuNames = serviceListsForKinds(intakeKinds.length ? intakeKinds : ["senior"]).flatMap((l) => l.services).filter((s, i, a) => a.indexOf(s) === i);
  const NEEDS_MAP: Record<string, string> = Object.fromEntries(menuNames.map((s, i) => [String(i + 1), s]));
  const raw = await parseWithClaude(
    'Return a JSON array of care need numbers that match the user\'s message. ' +
    menuNames.map((s, i) => `${i + 1}=${careServiceLabel(s)}`).join(", ") + ". " +
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
    `Noted — ${careNeeds.join(", ")}. How much support does ${(d.seniorName as string) ?? "your loved one"} need overall — ` +
    `pretty light (mostly supervision and companionship), moderate (hands-on help with some tasks), ` +
    `or intensive (full assistance with most things)?`
  );
}

async function handleJobAskEnvironment(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text, "How much support is needed? Light, Moderate, or Intensive")) {
    const answer = await answerQuestionMidFlow(text, session, phone);
    await sendMessage(chatId, answer);
    await sendMessage(chatId,
      "So — how much support is needed? Light, moderate, or intensive?"
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
    const answer = await answerQuestionMidFlow(text, session, phone);
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
  const rateText = await getMarketRateText(); // live SCC caregiver rates, fail-soft static
  await sendMessage(chatId,
    `Got it — ${petsLabel}, ${smokeLabel}. What hourly rate are you hoping to pay?\n\n` +
    (city
      ? `Most families in ${city} pay ${rateText}. Reply with a number or "flexible".`
      : `Most families pay ${rateText}. Reply with a number or "flexible".`)
  );
}

async function handleJobAskPayMethod(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text, "What hourly rate are you hoping to pay? (or \"flexible\")")) {
    const answer = await answerQuestionMidFlow(text, session, phone);
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
  const d = session.onboardingData ?? {};
  // Cash/Venmo/Zelle removed platform-wide (Hamse, 2026-08-23) — every job is
  // paid by card now, so this no longer asks; jobPaymentMethod is kept at its
  // "card" default (see deriveJobDataFromIntake) purely for downstream code
  // that still reads the field (buildAndSaveJobPost/paymentMethodLabel), not
  // because there's a real choice. Skips straight to the description
  // question — job_ask_description (which used to ask "how will you pay"
  // and parse the answer) is gone; nothing else referenced that step name.
  await mergeOnboardingData(phone, { jobHourlyRate: hourlyRate });
  await updateSession(phone, { onboardingStep: "job_confirm_post" });
  await sendMessage(chatId,
    `${rateLabel} — sounds good! Last step: in 1–3 sentences, describe a typical day of care for ` +
    `${(d.seniorName as string) ?? "your loved one"}. What should a care provider know?`
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
      await sendMessage(chatId, "Something went wrong. Reply and we'll pick up where we left off.");
      return;
    }

    try {
      const refreshed = await db.collection("agent_sessions").doc(phone).get();
      const jobData   = (refreshed.data()?.onboardingData ?? {}) as Record<string, unknown>;
      const onboarding = jobData; // same object holds both

      const { jobId } = await buildAndSaveJobPost({ uid, phone, onboardingData: onboarding, jobData: onboarding });

      // Site parity (2026-09-23): the site posts the request and lands on the
      // dashboard / Find Caregivers — no follow-up permission questions.
      await updateSession(phone, { onboardingStep: "complete", optedIn: true });
      await sendMessage(chatId,
        `${jobLiveMessage}\n\n` +
        `You can also browse care providers and manage everything at ${APP_URL}/client/dashboard`
      );
      await sendMessage(chatId, buildHelpSmsReply("client", undefined, languageFromSession(session as unknown as Record<string, unknown>)));
      const { presentCaregiverSearch } = await import("./caregiverSearch");
      presentCaregiverSearch({ phone, chatId, source: "post_job_prefill" }).catch((err) =>
        console.error("presentCaregiverSearch error:", err));

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

// Grounded facts per gate step so mid-flow questions ("what am I being charged
// for?", "why do you need my SSN?") get ACCURATE answers instead of the
// fact-free deflection rule (4) below. Keyed by onboardingStep; steps without
// an entry fall back to the generic prompt. Money/compliance facts only — keep
// each entry short, the model weaves in what's relevant.
const MEMBERSHIP_STEP_FACTS =
  `The ${caregiverAnnualDisplay()} care provider membership INCLUDES their required background check (no separate charge) and unlocks applying to jobs, ` +
  "getting booked, and Evia's scheduling + payout tools. It renews yearly. Right after payment comes the background-check step; " +
  `Evia texts them the moment it clears — then they're approved and families can book them (never promise a specific turnaround time). ` +
  `It is ONE flat fee (${caregiverAnnualAmount()} a year): if they offer transportation, the driving-record (MVR) check is included in the same background check at no extra charge.`;
const BGCHECK_CONSENT_STEP_FACTS =
  "Their background check is already paid for — included in the membership, no extra charge. The link Evia sent opens Evia's secure page to review " +
  "the FCRA disclosure and authorize the check (it asks for their LEGAL name because records are searched against it). After they authorize, Checkr — " +
  "the background-check company — emails them a secure link to finish; SSN and date of birth are entered directly with Checkr and never stored by Evia. " +
  "Evia texts them the moment results clear — then they're approved and families can book them (never promise a specific turnaround time).";
const BGCHECK_WAIT_STEP_FACTS =
  "Their background check is with Checkr now, already paid for via the membership. If they haven't finished Checkr's form, the secure link is in their " +
  "email from Checkr (re-sent daily; Evia can text it again too). Evia texts them the moment it clears — " +
  "then they're approved and families can book them (never promise a specific turnaround time).";
const PAYOUTS_STEP_FACTS =
  "Their background check cleared — they're approved on Evia. The payout link sets up their Stripe account so they get paid after each visit: " +
  "earnings pay out daily automatically (free); an optional instant payout carries Stripe's 1% fee (min $0.50).";
const CLIENT_PAYMENT_STEP_FACTS =
  `The family membership is ${clientMonthlyDisplay()} — it's what lets Evia coordinate care: finding, vetting, and matching care providers plus scheduling and secure payments. ` +
  "It's a recurring monthly membership and setup takes about 30 seconds. Once it's active, you can message, interview and book the care providers you've seen.";
const CLIENT_IDENTITY_STEP_FACTS =
  "Before payment, Evia runs a quick one-time identity check through Stripe Identity — it's secure, takes about 30 seconds, and keeps every family on the platform " +
  "real and safe. Their details go directly to Stripe, never stored by Evia. Once it clears, the next step is starting the membership.";
const STEP_QUESTION_FACTS: Record<string, string> = {
  caregiver_send_membership:          MEMBERSHIP_STEP_FACTS,
  caregiver_awaiting_membership:      MEMBERSHIP_STEP_FACTS,
  caregiver_send_bgcheck:             BGCHECK_CONSENT_STEP_FACTS,
  caregiver_awaiting_bgcheck_consent: BGCHECK_CONSENT_STEP_FACTS,
  caregiver_awaiting_bgcheck:         BGCHECK_WAIT_STEP_FACTS,
  caregiver_send_stripe_connect:      PAYOUTS_STEP_FACTS,
  caregiver_awaiting_stripe:          PAYOUTS_STEP_FACTS,
  client_send_payment:                CLIENT_PAYMENT_STEP_FACTS,
  client_awaiting_payment:            CLIENT_PAYMENT_STEP_FACTS,
  client_awaiting_identity:           CLIENT_IDENTITY_STEP_FACTS,
};

async function answerQuestionMidFlow(text: string, session: AgentSession, phone: string): Promise<string> {
  const d = session.onboardingData ?? {};
  const name = (d.name ?? d.firstName ?? "") as string;
  const step = (session.onboardingStep ?? "") as string;
  // Everything they've already told us — without this, a recall question
  // ("what zip did I share?") hits the anti-invention rules with an empty
  // context and produces a grounded-sounding denial (Hamse, 2026-07-17).
  // Canonical-wins (U6): once an account exists, the signup snapshot above can
  // be stale — edited later on the website or by an admin — so a live read of
  // the real profile takes precedence, same rule the main qaAgent loop already
  // follows for its own context-building. Fail-soft: a lookup error just
  // leaves the snapshot as the only source, same as before this fix.
  let canonicalProfile: Record<string, unknown> | null = null;
  if (session.userId) {
    try {
      if (session.userType === "caregiver") {
        const cgDoc = await db.collection("caregivers").doc(session.userId).get();
        canonicalProfile = cgDoc.exists ? (cgDoc.data() as Record<string, unknown>) : null;
      } else {
        // senior_profiles is keyed by session.seniorId when one has been
        // assigned (multi-recipient households), otherwise by the client's
        // own uid — persistClientCareRecords writes the primary recipient's
        // doc at senior_profiles/{clientUid}.
        const seniorId = ((session as any).seniorId as string | undefined) || session.userId;
        const { profile } = await getSeniorProfileWithSource(seniorId, db);
        canonicalProfile = profile;
      }
    } catch { /* fail-soft — snapshot facts still apply */ }
  }
  const sharedProfile = describeSharedProfile(session, canonicalProfile);
  let stepFacts = STEP_QUESTION_FACTS[step];
  // The static STEP_QUESTION_FACTS describe the PROCESS; without the user's
  // actual live state a status question ("did my payment go through?", "where's
  // my check?") got a hedged, fact-free non-answer (founder report, 2026-07-09).
  // Every gate/awaiting step with a registered builder gets its live fact
  // prepended; fail-soft ("" → static facts stand alone).
  const liveBuilder = LIVE_GATE_FACT_BUILDERS[step];
  if (liveBuilder) {
    const live = await liveBuilder(phone, session);
    if (live) stepFacts = `${live} ${stepFacts ?? ""}`.trim();
  }
  return (await quickComplete(
    CARE_PROVIDER_TERM_RULE + " " + "You are Evia, a warm human-feeling care coordinator at Evia. You help people entirely over text — " +
      "YOU do the work for them: you find and match care providers and set everything up through this conversation. " +
      `The person you're texting is ${session.userType === "caregiver" ? "a care provider looking for work" : "a family member looking for care for a loved one"}` +
      `${name ? ` named ${name}` : ""}, and they're in the middle of signing up with you. They just said something — it may be a question, or just a comment. ` +
      "Reply in ONE warm, specific sentence. " +
      "HARD RULES: " +
      "(1) Everything can be done right here by text — you handle the searching and matching yourself, so never send them off to go search or fill something in. They also have an account on the Evia website with the same information; if they ask about it, say so plainly, but never invent features, filters, or tools you don't know exist. " +
      "(2) If they named a place or a need (e.g. 'I'm looking for care providers in San Jose'), reassure them you'll handle finding care providers there — do NOT tell them to search. " +
      // LAUNCH: wording pending counsel review (R15)
      "(3) Never VOLUNTEER a robotic self-label (e.g. describing yourself as an assistant powered by AI, or as a chatbot) and never refer to yourself in the third person. But if directly asked whether you are an AI, a bot, or a human, answer honestly and warmly — never deny it or dodge the question. Also never use phrases like 'I'm here to help' or 'let me know if you need further assistance'. " +
      "(4) If you don't actually know the answer, say you'll get it sorted — never make up a feature or process. " +
      (stepFacts ? `FACTS about exactly where they are in signup — ground your answer in these when the question touches them, never contradict them: ${stepFacts} ` : "") +
      (sharedProfile ? `${sharedProfile} ` : "") +
      "(5) Ask NO question of your own — none. The signup question is re-asked automatically right after your reply, so a question from you would leave the user answering two different things at once. " +
      "(6) Speak TO the person, never ABOUT them in the third person, and never narrate progress or process (no \"I'll keep her on track\", \"I'll get everything set for the next step\" — that reads like an internal status report). " +
      "(7) If they ask for an email or contact address, the only one that exists is support@eviacares.com — never invent any other address. " +
      "(8) NEVER write out a URL or web address — a URL you compose will be wrong and dead — and never claim you just sent, " +
      "resent, or will send a link: real links are delivered by the system as separate tappable messages, not by you. " +
      "(9) NEVER say you changed, updated, saved, fixed or removed anything — you cannot change their answers in this reply. " +
      "If they want something changed, say they can tell you exactly what to change and it will be updated. " +
      "(10) Never describe care providers as vetted, verified, approved, trusted, screened or reliable; if it comes up, state the requirement — every care provider completes a Checkr background check before families can book them.",
    text,
    { maxTokens: 90 },
  )).trim();
}

// ── The questionnaire finished ON THE SITE (2026-10-19) ──────────────────────
// Called by triggers/siteWizardCompletion.ts when the site's wizard finished
// while the text cursor still sat on a collection step. The dashboard shows the
// next card at once; by text the person hears the same thing as it happens —
// ONE text, through the same gate senders Evia's own flow uses, parked where
// Evia's flow would park it.
export async function advanceClientAfterSiteWizard(phone: string, chatId: string, session: AgentSession): Promise<void> {
  const uid = session.userId as string | undefined;
  let identityVerified = false;
  if (uid) {
    const u = await db.collection("users").doc(uid).get().catch(() => null);
    identityVerified = u?.data()?.identityCheckStatus === "verified";
  }
  await sendMessage(chatId, "Your care plan is saved — nice work.");
  if (identityVerified) {
    // Identity already done on the site: the next card is the membership.
    await updateSession(phone, { onboardingStep: "client_ask_plan" });
    await handleClientPresentPlan(phone, chatId, session);
    return;
  }
  await sendIdentityCheckLink(phone, chatId, session); // texts the link, parks client_awaiting_identity
}

export async function advanceCaregiverAfterSiteWizard(phone: string, chatId: string, session: AgentSession): Promise<void> {
  await updateSession(phone, { onboardingStep: "caregiver_send_membership" });
  // handleCaregiverSendMembership says the profile is set up and texts the membership link, then parks awaiting_membership.
  await handleCaregiverSendMembership(phone, chatId, session);
}
