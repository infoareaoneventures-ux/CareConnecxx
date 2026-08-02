// ── The childcare caregiver funnel TURN (front door Stage 2, deliverable 5) ───
//
// One inbound text on a caregiver childcare session, start to finish. This is
// what replaces Stage 1's `childcare_caregiver_hold` deterministic stub.
//
// ORDERING (preserved from Stage 1, binding):
//   1. deterministic incident classification    ← childcare/signupIngress.ts
//   2. childcare flags (flags-off = waitlist)   ← childcare/signupIngress.ts
//   3. THE FUNNEL                               ← here
// The first two stay in the ingress on purpose: an incident escalation must not
// depend on a model, and a disabled vertical must not reach a collection turn.
//
// STATE lives in ONE session field — `childcareCaregiverFunnel` — never in
// `onboardingData` and never in `onboardingStep` alone. That is what lets a
// COMPLETED senior caregiver add childcare (R-FD6 dual-vertical ADDITION)
// without their senior session being disturbed: their `onboardingStep` stays
// "complete", their senior state is untouched, and the childcare funnel runs
// alongside it in its own namespace.
//
// FAIL-OPEN DISCIPLINE: every model call has a deterministic fallback. With the
// model down the funnel still asks the right question, still refuses deferred
// categories, still enrolls, and still refuses to approve anybody.

import * as admin from "firebase-admin";
import {
  CHILDCARE_CAREGIVER_FUNNEL_FIELD,
  CHILDCARE_CAREGIVER_STEP_ENROLL,
  CHILDCARE_CAREGIVER_STEP_REVIEW,
  CHILDCARE_CAREGIVER_STEP_SCREENING_CONSENT,
  absorbChildcareCaregiverFields,
  buildChildcareCaregiverDirective,
  buildDeferredRefusal,
  childcareCaregiverQuestion,
  classifyExplicitYesNo,
  computeChildcareCaregiverPlan,
  seedFromVerifiedBaseProfile,
  type ChildcareCaregiverPlan,
  type ParseFn,
} from "./childcareCaregiverFunnel";
import {
  ensureChildcareCaregiverBaseDoc,
  startChildcareCaregiverScreening,
  upsertChildcareCaregiverProfileFromFunnel,
  type ChildcareProfileUpsertResult,
  type ChildcareScreeningStartResult,
} from "./childcareCaregiverEnrollment";
import { loadChildcareVerticalProfile } from "../childcare/providerEligibility";

type Db = admin.firestore.Firestore;
type SendMessageFn = (chatId: string, text: string, opts?: Record<string, unknown>) => Promise<unknown>;

/** Terminal state for a caregiver who cannot be enrolled (e.g. under 18). */
export const CHILDCARE_CAREGIVER_STEP_INELIGIBLE = "childcare_caregiver_ineligible";

/** Max re-asks on the screening-consent binary before it is parked (deny by default). */
export const CHILDCARE_CONSENT_MAX_ASKS = 2;

export interface ChildcareCaregiverFunnelState {
  step: string;
  data: Record<string, unknown>;
  asks?: number;
  startedAt?: string;
  /** Machine-stable reason a terminal state was reached. Never narrative. */
  outcome?: string;
}

export interface ChildcareCaregiverTurnParams {
  phone: string;
  chatId: string;
  text: string;
  session: Record<string, unknown>;
  sendMessage: SendMessageFn;
  db?: Db;
  now?: Date;
  executionContext?: unknown;
  /**
   * Static opening line the CALLER owns (it carries the secure caregiver link,
   * which the model output guard would strip). Prefixed to the first question so
   * a caregiver always knows both routes exist: finish here over text, or in
   * their account.
   */
  openingLine?: string;
  // ── Injectable seams (all default to the real implementations) ─────────────
  parse?: ParseFn;
  generate?: (opts: { context: string; fallback: string; maxTokens?: number; language?: "en" | "es" }) => Promise<string>;
  upsertProfile?: typeof upsertChildcareCaregiverProfileFromFunnel;
  startScreening?: typeof startChildcareCaregiverScreening;
  ensureBaseDoc?: typeof ensureChildcareCaregiverBaseDoc;
  loadVerticalProfile?: (uid: string, db: Db) => Promise<Record<string, unknown> | null>;
}

export interface ChildcareCaregiverTurnResult {
  handled: boolean;
  step: string;
  reply: string;
  /** Machine-stable outcome, safe to log (never message content). */
  outcome: string;
}

function readState(session: Record<string, unknown>): ChildcareCaregiverFunnelState | null {
  const raw = session[CHILDCARE_CAREGIVER_FUNNEL_FIELD];
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const step = typeof s.step === "string" && s.step ? s.step : null;
  if (!step) return null;
  return {
    step,
    data: (s.data && typeof s.data === "object" ? s.data : {}) as Record<string, unknown>,
    asks: Number.isFinite(Number(s.asks)) ? Number(s.asks) : 0,
    ...(typeof s.startedAt === "string" ? { startedAt: s.startedAt } : {}),
    ...(typeof s.outcome === "string" ? { outcome: s.outcome } : {}),
  };
}

async function writeState(
  db: Db,
  phone: string,
  session: Record<string, unknown>,
  state: ChildcareCaregiverFunnelState,
): Promise<void> {
  session[CHILDCARE_CAREGIVER_FUNNEL_FIELD] = state;
  await db.collection("agent_sessions").doc(phone)
    .set({ [CHILDCARE_CAREGIVER_FUNNEL_FIELD]: state }, { merge: true })
    .catch((err) => {
      console.error("[childcareCaregiverFunnel] state write failed:", err instanceof Error ? err.message : err);
    });
}

function uidOf(session: Record<string, unknown>): string {
  return String(session.caregiverId ?? session.userId ?? session.webOnboardingUid ?? "").trim();
}

/** Ask the next question in Evia's voice; ALWAYS falls back to the scripted line. */
async function askNext(
  plan: ChildcareCaregiverPlan,
  text: string,
  ack: string,
  params: ChildcareCaregiverTurnParams,
): Promise<string> {
  const scripted = childcareCaregiverQuestion(plan.step);
  const fallback = ack ? `${ack} ${scripted}` : scripted;
  const generate = params.generate ?? (async (opts) => {
    const { generateCaraMessage } = await import("../utils/caraMessage");
    return generateCaraMessage({ audience: "caregiver", ...opts });
  });
  const language = params.session.preferredLanguage === "es" ? ("es" as const) : ("en" as const);
  return generate({
    context:
      `${buildChildcareCaregiverDirective(plan)}\n\n` +
      `The caregiver just texted: "${text}".` +
      (ack ? `\n\nYou MUST include this exact correction, in your own flow, before the question: "${ack}"` : "") +
      `\n\nReply with ONE short message: brief acknowledgment, then the single next question.`,
    fallback,
    maxTokens: 160,
    language,
  }).then((out) => (out && out.trim() ? out.trim() : fallback)).catch(() => fallback);
}

/**
 * Run one funnel turn. Returns `handled: true` whenever a reply was sent — the
 * caller returns immediately (a childcare turn must never fall through into any
 * senior path).
 */
export async function runChildcareCaregiverFunnelTurn(
  params: ChildcareCaregiverTurnParams,
): Promise<ChildcareCaregiverTurnResult> {
  const db = params.db ?? admin.firestore();
  const now = params.now ?? new Date();
  const send = params.sendMessage;
  const sendOpts = params.executionContext ? { executionContext: params.executionContext } : undefined;
  const text = String(params.text ?? "");
  const uid = uidOf(params.session);

  const loadVertical = params.loadVerticalProfile ??
    (async (u: string, d: Db) => (await loadChildcareVerticalProfile(u, d)) as Record<string, unknown> | null);

  const caregiverDoc = uid
    ? ((await db.collection("caregivers").doc(uid).get().catch(() => null))?.data() ?? null)
    : null;
  const verticalProfile = uid ? await loadVertical(uid, db).catch(() => null) : null;

  const existing = readState(params.session);

  // ── Terminal states: status only, never a re-run of the enrollment ──────────
  if (existing?.step === CHILDCARE_CAREGIVER_STEP_REVIEW) {
    const reply = childcareCaregiverQuestion(CHILDCARE_CAREGIVER_STEP_REVIEW);
    await send(params.chatId, reply, sendOpts);
    return { handled: true, step: existing.step, reply, outcome: "awaiting_manual_review" };
  }
  if (existing?.step === CHILDCARE_CAREGIVER_STEP_INELIGIBLE) {
    const reply =
      "I'm sorry — Evia's childcare work is only open to caregivers 18 and older, so I can't set up a profile. " +
      "If something changed, email support@eviacares.com and a person will take a look.";
    await send(params.chatId, reply, sendOpts);
    return { handled: true, step: existing.step, reply, outcome: "ineligible" };
  }

  // ── The screening-consent binary (consent-first, explicit yes/no) ───────────
  if (existing?.step === CHILDCARE_CAREGIVER_STEP_SCREENING_CONSENT) {
    // "START CHECK" is the funnel's resume path — every awaiting step in this
    // repo needs one, and a parked or declined consent is exactly the wedge it
    // exists to unstick.
    const answer = isStartCheckCommand(text) ? "yes" : classifyExplicitYesNo(text);
    if (answer === "unclear") {
      const asks = (existing.asks ?? 1) + 1;
      if (asks > CHILDCARE_CONSENT_MAX_ASKS) {
        // Deny by default: no consent means NO background check, and no check
        // means no bookings. Park honestly instead of nagging.
        await writeState(db, params.phone, params.session, {
          ...existing, asks, outcome: "screening_consent_parked",
        });
        const reply =
          "No problem — I'll leave the background check for now. Nothing else moves until it's done, " +
          "so just text me START CHECK whenever you're ready.";
        await send(params.chatId, reply, sendOpts);
        return { handled: true, step: existing.step, reply, outcome: "screening_consent_parked" };
      }
      await writeState(db, params.phone, params.session, { ...existing, asks });
      const reply =
        "Sorry, I need a clear answer on this one: should I start your background check? Reply YES or NO.";
      await send(params.chatId, reply, sendOpts);
      return { handled: true, step: existing.step, reply, outcome: "screening_consent_reask" };
    }
    if (answer === "no") {
      await writeState(db, params.phone, params.session, {
        ...existing, outcome: "screening_consent_declined",
      });
      const reply =
        "Understood, and that's your call. Every Evia childcare caregiver needs the check before a family can " +
        "book them, so your profile stays on hold until then. Text me START CHECK anytime and I'll kick it off.";
      await send(params.chatId, reply, sendOpts);
      return { handled: true, step: existing.step, reply, outcome: "screening_consent_declined" };
    }
    const startScreening = params.startScreening ?? startChildcareCaregiverScreening;
    const screening: ChildcareScreeningStartResult = await startScreening({
      uid, screeningConsent: true, db, now,
    });
    await writeState(db, params.phone, params.session, {
      ...existing,
      step: CHILDCARE_CAREGIVER_STEP_REVIEW,
      outcome: screening.ok ? `screening_${screening.mode}` : `screening_failed_${screening.mode}`,
    });
    const reply = buildScreeningStartedReply(screening);
    await send(params.chatId, reply, sendOpts);
    return {
      handled: true,
      step: CHILDCARE_CAREGIVER_STEP_REVIEW,
      reply,
      outcome: screening.ok ? `screening_${screening.mode}` : `screening_failed_${screening.mode}`,
    };
  }

  // ── Collection ─────────────────────────────────────────────────────────────
  //
  // First funnel turn: the opening is DETERMINISTIC. It is the one message that
  // must carry the secure caregiver link (the model output guard strips URLs),
  // and it tells them both routes are open — finish here over text, or in their
  // account.
  if (!existing) {
    const plan = computeChildcareCaregiverPlan({
      caregiverDoc: caregiverDoc as Record<string, unknown> | null,
      verticalProfile,
      collected: {},
    });
    await writeState(db, params.phone, params.session, {
      step: plan.step,
      data: seedFromPlan(plan, caregiverDoc as Record<string, unknown> | null, verticalProfile),
      asks: 0,
      startedAt: now.toISOString(),
    });
    if (plan.collectionComplete) {
      return finishCollection(plan, "", params, db, now, uid, caregiverDoc as Record<string, unknown> | null, verticalProfile);
    }
    const reply = [params.openingLine, childcareCaregiverQuestion(plan.step)]
      .filter(Boolean).join("\n\n");
    await send(params.chatId, reply, sendOpts);
    return {
      handled: true,
      step: plan.step,
      reply,
      outcome: plan.deltaOnly ? "funnel_started_delta" : "funnel_started_full",
    };
  }

  // Subsequent collection turn: extract → refuse deferred → recompute → ask.
  const absorbed = await absorbChildcareCaregiverFields(text, existing.data, { parse: params.parse })
    .catch(() => ({ fields: {} as Record<string, unknown>, refusedCategories: [] as string[] }));

  const merged: Record<string, unknown> = { ...existing.data, ...absorbed.fields };

  // A stated MINOR is a hard refusal, not a missing field.
  if (absorbed.fields.adultAgeAttested === false) {
    await writeState(db, params.phone, params.session, {
      ...existing, step: CHILDCARE_CAREGIVER_STEP_INELIGIBLE, data: merged, outcome: "under_18",
    });
    const reply =
      "Thanks for being straight with me. Evia's childcare work is only open to caregivers 18 and older, " +
      "so I can't set up a profile right now — but please come back when you are.";
    await send(params.chatId, reply, sendOpts);
    return { handled: true, step: CHILDCARE_CAREGIVER_STEP_INELIGIBLE, reply, outcome: "under_18" };
  }

  const ack = buildDeferredRefusal(absorbed.refusedCategories);
  const plan = computeChildcareCaregiverPlan({
    caregiverDoc: caregiverDoc as Record<string, unknown> | null,
    verticalProfile,
    collected: merged,
  });

  if (plan.collectionComplete) {
    await writeState(db, params.phone, params.session, { ...existing, step: plan.step, data: merged });
    return finishCollection(
      plan, ack, params, db, now, uid, caregiverDoc as Record<string, unknown> | null, verticalProfile, merged,
    );
  }

  await writeState(db, params.phone, params.session, { ...existing, step: plan.step, data: merged });
  const reply = await askNext(plan, text, ack, params);
  await send(params.chatId, reply, sendOpts);
  return {
    handled: true,
    step: plan.step,
    reply,
    outcome: absorbed.refusedCategories.length ? "collected_with_refusal" : "collected",
  };
}

/** Seed the funnel's stored data from verified prior work so it is never re-asked. */
function seedFromPlan(
  plan: ChildcareCaregiverPlan,
  caregiverDoc: Record<string, unknown> | null,
  verticalProfile: Record<string, unknown> | null,
): Record<string, unknown> {
  // computeChildcareCaregiverPlan already resolved reuse; re-run the same seed so
  // the STORED data carries it (one definition, applied once).
  const { seeded } = seedFromVerifiedBaseProfile(caregiverDoc, {});
  if (verticalProfile) {
    if (Array.isArray(verticalProfile.ageBands) && verticalProfile.ageBands.length) {
      seeded.childcareAgeBands = verticalProfile.ageBands;
    }
    if (Array.isArray(verticalProfile.services) && verticalProfile.services.length) {
      seeded.childcareServices = verticalProfile.services;
    }
    if (typeof verticalProfile.yearsChildcareExperience === "number") {
      seeded.yearsChildcareExperience = verticalProfile.yearsChildcareExperience;
    }
    if (typeof verticalProfile.hourlyRate === "number") seeded.hourlyRate = verticalProfile.hourlyRate;
    if (verticalProfile.adultAgeAttested === true) seeded.adultAgeAttested = true;
  }
  void plan;
  return seeded;
}

/**
 * Collection is done: create the base account if this caregiver arrived through
 * childcare, upsert the vertical profile + policy acceptance, then ASK for
 * screening consent. The Checkr call never happens on this turn — consent-first.
 */
async function finishCollection(
  plan: ChildcareCaregiverPlan,
  ack: string,
  params: ChildcareCaregiverTurnParams,
  db: Db,
  now: Date,
  uid: string,
  caregiverDoc: Record<string, unknown> | null,
  verticalProfile: Record<string, unknown> | null,
  collected?: Record<string, unknown>,
): Promise<ChildcareCaregiverTurnResult> {
  const send = params.sendMessage;
  const sendOpts = params.executionContext ? { executionContext: params.executionContext } : undefined;
  const state = readState(params.session);
  const data = collected ?? state?.data ?? {};

  let resolvedUid = uid;
  if (!caregiverDoc || !resolvedUid) {
    const ensure = params.ensureBaseDoc ?? ensureChildcareCaregiverBaseDoc;
    const ensured = await ensure({
      phone: params.phone,
      collected: data,
      existingUid: resolvedUid || null,
      db,
      now,
    }).catch(() => ({ uid: null, created: false, reason: "ensure_failed" as string }));
    if (ensured.uid) {
      resolvedUid = ensured.uid;
      await db.collection("agent_sessions").doc(params.phone)
        .set({ caregiverId: ensured.uid, userId: ensured.uid }, { merge: true }).catch(() => {});
      params.session.caregiverId = ensured.uid;
    }
  }

  const upsert = params.upsertProfile ?? upsertChildcareCaregiverProfileFromFunnel;
  const result: ChildcareProfileUpsertResult = await upsert({
    uid: resolvedUid, collected: data, db, now,
  }).catch(() => ({
    ok: false, reason: "upsert_failed", profileVersion: 0,
    reusedBaseFields: [], missingBaseFields: [], missingChildcareFields: [],
    refusedCategories: [], approvalPending: true as const, acceptedPolicyVersion: null,
  }));

  if (!result.ok) {
    // Fail CLOSED and honestly. The collected answers are already persisted on
    // the session, so nothing the caregiver typed is lost.
    const reply = [
      ack,
      "I've got everything you told me saved. I hit a snag finishing your childcare profile on my side — " +
      "our team has been notified and I'll pick this straight back up. Nothing you sent is lost.",
    ].filter(Boolean).join(" ");
    await send(params.chatId, reply, sendOpts);
    return { handled: true, step: CHILDCARE_CAREGIVER_STEP_ENROLL, reply, outcome: `enroll_failed_${result.reason}` };
  }

  await writeState(db, params.phone, params.session, {
    step: CHILDCARE_CAREGIVER_STEP_SCREENING_CONSENT,
    data,
    asks: 1,
    ...(state?.startedAt ? { startedAt: state.startedAt } : { startedAt: now.toISOString() }),
    outcome: "profile_upserted",
  });

  const reply = [
    ack,
    plan.deltaOnly
      ? "That's your childcare profile built — and it's separate from your senior-care one, so your rate, " +
        "availability, and reviews on that side stay exactly as they are."
      : "That's your childcare profile built.",
    childcareCaregiverQuestion(CHILDCARE_CAREGIVER_STEP_SCREENING_CONSENT),
  ].filter(Boolean).join(" ");
  await send(params.chatId, reply, sendOpts);
  void verticalProfile;
  return {
    handled: true,
    step: CHILDCARE_CAREGIVER_STEP_SCREENING_CONSENT,
    reply,
    outcome: plan.deltaOnly ? "profile_upserted_delta" : "profile_upserted_full",
  };
}

/**
 * The reply after a screening start. NEVER says approved, cleared, or matched —
 * a clear report is evidence and a person still reviews every application
 * (R27/R28). The invitation URL is the caregiver's OWN apply link, the same
 * exposure class as the senior flow's invitationUrl.
 */
export function buildScreeningStartedReply(screening: ChildcareScreeningStartResult): string {
  const review =
    "A person on our team reviews every childcare profile before families can book — I'll text you the moment there's a decision.";
  if (!screening.ok) {
    return (
      "I couldn't get your background check started just now — that's on my side, not yours. " +
      "Our team has been notified and I'll come back to you on it. " + review
    );
  }
  switch (screening.mode) {
    case "base_evidence_adopted":
      return (
        "Good news — your current Evia background check already covers what childcare needs, so there's " +
        "nothing new for you to fill out. " + review
      );
    case "already_current":
      return "Your childcare background check is already current — nothing more needed from you. " + review;
    case "invitation_outstanding":
      return (
        "Your background check invitation is already out — finish it from the email Checkr sent you. " + review
      );
    default:
      return (
        "Started — Checkr will email you a short form to complete. That's the background check; " +
        "it's the same one every Evia caregiver does. " + review +
        (screening.invitationUrl ? `\n\nYou can also start it here: ${screening.invitationUrl}` : "")
      );
  }
}

/**
 * "START CHECK" — the resend/restart path for a parked or declined consent.
 * Every awaiting step in this repo needs a real resume path; this is the funnel's.
 */
export function isStartCheckCommand(text: string): boolean {
  return /^\s*start\s*check\s*$/i.test(String(text ?? ""));
}
