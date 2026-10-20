import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { parseWithClaude } from "../utils/parseWithClaude";
import { generateCaraMessage } from "../utils/caraMessage";
import { generateToken } from "./tokenService";
import { getAppUrl } from "../config/appUrl";
import { pauseCaregiver, reactivateCaregiver } from "./pauseAccount";
import { isQuestionOrOther, isBackOutRequest, answerMidFlow as answerMidFlowShared } from "./stepHandler";
import { businessTodayStr } from "../utils/scheduledTime";
import { mapCaregiverServices, orderedCanonicalServices, serviceLabels, SERVICE_LABELS, serviceMenuText } from "./caregiverServices";
import { CHILD_SERVICE_LABELS, careKindsFromWords, kindsOfServices, serviceListsForKinds, CareKind, CARE_KINDS } from "./caregiverServiceLabels";
import { RATE_EXAMPLE, RATE_RULE_TEXT, EXPERIENCE_BUCKETS, BIO_MAX_CHARS, toExperienceBucket, toServiceRadius } from "./onboardingContract";
import { LANGUAGE_OPTIONS, JOB_TYPE_OPTIONS, MAX_CLIENTS_OPTIONS, TRAVEL_OPTIONS, jobTypeLabel } from "./caregiverMyProfile";

const db = admin.firestore();

const APP_URL = getAppUrl();

/**
 * Caregiver profile update flow — covers rate, skills, bio, photo, pause, reactivate.
 *
 * Two-step state machine per field:
 *   collect (the value, if not already supplied) → confirm (YES/NO)
 *
 * Triggered by intents: UPDATE_RATE, UPDATE_SKILLS, UPDATE_BIO, UPDATE_PHOTO,
 *                       PAUSE_ACCOUNT, REACTIVATE
 *
 * Sub-handlers each follow: detect intent → parse value → propose → YES/NO confirm → write.
 */

export type ProfileUpdateField =
  | "rates"       // My Profile › Rates › Edit (1 / 2 / 3+ people, experience, max clients — one save, like the page)
  | "skills"      // My Profile › Care Services › Edit
  | "bio"         // My Profile › About › Edit (bio)
  | "languages"   // My Profile › About › Edit (languages)
  | "jobtype"     // My Profile › Weekly Availability › Looking for
  | "travel"      // My Profile › Location & Travel › Edit (serviceRadius)
  | "photo"
  | "pause"
  | "reactivate";

const FLOW_TTL = () => new Date(Date.now() + 30 * 60 * 1000).toISOString();

/** Legacy sessions parked as "rate" (before 2026-10-04) continue in the rates flow. */
function normalizeField(v: unknown): ProfileUpdateField | undefined {
  if (v === "rate") return "rates";
  return typeof v === "string" ? (v as ProfileUpdateField) : undefined;
}

// A mid-flow question is answered FROM what is on the caregiver's screen (founder 2026-10-11): the step's own
// question / recap is the briefing (stepHandler.answerMidFlow), plus the section's real facts below — never a
// static sentence, and never a claim that anything was changed. The re-ask follows the answer.
const answerMidFlow = (text: string, reAsk: string, facts: string) => answerMidFlowShared(text, reAsk, { audience: "caregiver", facts });

// The My Profile page's facts, section by section — what each editor saves and the page's own rules.
const SAVE_RULE = "Nothing is saved until the care provider replies YES to the recap; NO leaves the profile as it is.";
export const RATES_FACTS = (current: RatesDraft) =>
  `${RATE_RULE_TEXT} — any amount above $0 is fine, there is no floor and no ceiling; $${RATE_EXAMPLE} is only an example. ` +
  `The Rates section holds the hourly rate for 1 person, 2 people and 3+ people (2 and 3+ may be left unset), the years of experience ` +
  `(${EXPERIENCE_BUCKETS.join(", ")}) and how many clients at once (${MAX_CLIENTS_OPTIONS.join(", ")}); YES saves the whole section together, like the page's Save. ` +
  `The Rates section currently reads:\n${ratesRecap(current)}\n${SAVE_RULE}`;
export const SKILLS_FACTS =
  `The Care Services editor offers exactly these services, tick any from either list — senior care: ${SERVICE_LABELS.join(", ")}; child care: ${CHILD_SERVICE_LABELS.join(", ")} — nothing else can be added. ` +
  "Medication Reminders Only means reminding when it is time, never giving medication; care providers here do not give medication or medical treatment. " +
  `Families see the saved services on the care provider's profile and in matching. ${SAVE_RULE}`;
export const LANGUAGES_FACTS =
  `The languages are chosen from this list only: ${LANGUAGE_OPTIONS.join(", ")}; at least one language stays on the profile. Families see them under About. ${SAVE_RULE}`;
export const JOB_TYPE_FACTS =
  `Looking for is ONE choice from: ${JOB_TYPE_OPTIONS.map((j) => j.label).join(", ")}; it shows under Weekly Availability on the profile. ${SAVE_RULE}`;
export const TRAVEL_FACTS =
  `The travel distance is one of ${TRAVEL_OPTIONS.join(", ")} miles, measured from the address in Account Settings; families further away are not matched. ${SAVE_RULE}`;
export const BIO_FACTS =
  `The bio is what families see on the profile, in the care provider's own words. There is no minimum length on either door (founder, 2026-10-19) and a cap of ${BIO_MAX_CHARS.toLocaleString("en-US")} characters; ` +
  `the new bio replaces the old one. ${SAVE_RULE}`;
// The Account Settings page's own words: "Stop showing up for new matches without deleting your profile. Reversible anytime."
export const PAUSE_FACTS =
  "Pausing stops the care provider showing up for new matches without deleting the profile. It does NOT cancel anything that already exists — " +
  "upcoming visits, accepted bookings, interviews and messages all stay exactly as they are, and the care provider is still expected at them. " +
  "Fully reversible anytime: text REACTIVATE, or use the Reactivate button on the Account Settings page. With an end date, the account becomes " +
  "active again on that date automatically; with no date, it stays paused until reactivated. Nothing is paused until the care provider replies YES.";


// The same sentence the router sends for a bare CANCEL (routeCaregiver PARKED_FLOW_CANCEL_LINE).
export const PROFILE_BACKED_OUT = "No problem — your profile wasn't changed.";

/** The question the care provider is looking at, for the back-out classifier's context (per editor and step). */
function profileFlowQuestion(field: ProfileUpdateField, step: string, session: Record<string, unknown>): string {
  if (step === "confirm") {
    if (field === "pause") return `Pause your account ${(session.profileUpdateValue as string) === "indefinite" || !session.profileUpdateValue ? "indefinitely" : `until ${session.profileUpdateValue}`}? Reply YES to pause, or NO to cancel.`;
    return "Reply YES to save this change to your profile, NO to leave it as it is, or tell me another change.";
  }
  switch (field) {
    case "rates":     return RATES_Q;
    case "skills":    return `Which services would you like to add or remove? The list is: ${SERVICE_LABELS.join(", ")}.`;
    case "bio":       return BIO_Q;
    case "languages": return LANGUAGES_Q;
    case "jobtype":   return JOB_TYPE_Q;
    case "travel":    return TRAVEL_Q;
    case "pause":     return "When would you like to pause until? (e.g. \"until July 12\", \"for two weeks\", \"indefinitely\")";
    default:          return "What would you like to change?";
  }
}

async function clearProfileFlow(phone: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    profileUpdateStep:  admin.firestore.FieldValue.delete(),
    profileUpdateField: admin.firestore.FieldValue.delete(),
    profileUpdateValue: admin.firestore.FieldValue.delete(),
    stateExpiresAt:     admin.firestore.FieldValue.delete(),
  }).catch(() => {});
}

/** The My Profile page's Edit buttons (caregiverMyProfile.ts keywords): park the flow and ask its first question. */
export async function startProfileFlow(
  field: ProfileUpdateField, caregiverId: string, phone: string, chatId: string, session: Record<string, unknown>,
): Promise<void> {
  if (field === "photo") return handlePhotoUpdate(caregiverId, phone, "", session, chatId);
  await db.collection("agent_sessions").doc(phone).update({ profileUpdateStep: "collect", profileUpdateField: field, stateExpiresAt: FLOW_TTL() });
  const q: Record<string, string> = {
    rates: RATES_Q,
    skills: `Which services would you like to add or remove? Senior care: ${SERVICE_LABELS.join(", ")}. Child care: ${CHILD_SERVICE_LABELS.join(", ")}. (For example "add Personal Care", "add child care — Supervision and Homework", or "remove Transportation".)`,
    bio: BIO_Q,
    languages: LANGUAGES_Q,
    jobtype: JOB_TYPE_Q,
    travel: TRAVEL_Q,
  };
  await sendMessage(chatId, q[field] ?? "What would you like to change?");
}

/**
 * Entry point — call when a profile-update intent (or active profileUpdateStep) is detected.
 * Routes to the correct sub-handler based on `field`.
 *
 * For pure-entry intents that may include the value inline (e.g. "change my rate to $28"),
 * pass `field` from intent classification. Otherwise the existing session.profileUpdateField is used.
 */
export async function handleCaregiverProfileUpdate(
  caregiverId:    string,
  caregiverPhone: string,
  text:           string,
  session:        Record<string, unknown>,
  chatId:         string,
  field?:         ProfileUpdateField,
): Promise<void> {
  const activeField = normalizeField(field ?? session.profileUpdateField);
  if (!activeField) {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: (session.preferredLanguage as string) === "es" ? "es" : "en",
      context: "The care provider wants to update their profile but you couldn't tell which part. Warmly ask them to clarify, and give a couple of concrete examples like \"change my rate to $25\" or \"add dementia care to my skills\". You MUST include those example phrasings.",
      fallback: "I'm not sure what you wanted to update. Try something like \"change my rate to $25\" or \"add dementia care to my skills\".",
      maxTokens: 80,
    }));
    return;
  }

  // ── Back-out (2026-10-17) ─────────────────────────────────────────────────
  // A parked editor (collect or confirm) is the page's modal: "never mind" /
  // "forget it" closes it, whichever editor and step — one check for all of
  // them, before any sub-handler re-asks its question. Only once a step is
  // parked: the entry text ("change my rate to $28") is never a back-out, and
  // the YES/NO confirms keep their own strict words (a bare NO is not this).
  const parkedStep = session.profileUpdateStep as string | undefined;
  if (parkedStep && text.trim() && activeField !== "photo" && activeField !== "reactivate"
      && await isBackOutRequest(text, profileFlowQuestion(activeField, parkedStep, session))) {
    await clearProfileFlow(caregiverPhone);
    await sendMessage(chatId, PROFILE_BACKED_OUT);
    return;
  }

  // ── Inbound MMS media detection (photo path uses this) ─────────────────────
  // The webhooks router passes `text` as the joined text, so MMS-only messages
  // come through as "". The photo handler relies on session.pendingPhotoUrl
  // (set by the router when it sees a media part) — see webhooks.ts wiring.

  switch (activeField) {
    case "rates":      return handleRatesUpdate(caregiverId, caregiverPhone, text, session, chatId);
    case "skills":     return handleSkillsUpdate(caregiverId, caregiverPhone, text, session, chatId);
    case "languages":  return handleLanguagesUpdate(caregiverId, caregiverPhone, text, session, chatId);
    case "jobtype":    return handleJobTypeUpdate(caregiverId, caregiverPhone, text, session, chatId);
    case "travel":     return handleTravelUpdate(caregiverId, caregiverPhone, text, session, chatId);
    case "bio":        return handleBioUpdate(caregiverId, caregiverPhone, text, session, chatId);
    case "photo":      return handlePhotoUpdate(caregiverId, caregiverPhone, text, session, chatId);
    case "pause":      return handlePauseAccount(caregiverId, caregiverPhone, text, session, chatId);
    case "reactivate": return handleReactivate(caregiverId, caregiverPhone, session, chatId);
  }
}

// ── RATES ───────────────────────────────────────────────────────────────────
// The page's Rates › Edit: 1 Person / 2 People / 3+ People ($15–$200), years of
// experience (the five buckets) and max clients at once (1 / 2 / 3+), saved
// TOGETHER by one Save — hourlyRate, rateFor2Seniors, rateFor3PlusSeniors,
// yearsExperience + experience, maxClients. Over text: say what changes, see the
// whole section read back, YES saves all six fields exactly like the page.

export interface RatesDraft { hourlyRate: number; rateFor2: number; rateFor3: number; experience: string; maxClients: string }

export const RATES_Q =
  `What would you like to change — your rate for 1 person, 2 people or 3+ people (e.g. $${RATE_EXAMPLE} an hour — the number is yours), ` +
  `your years of experience (${EXPERIENCE_BUCKETS.join(", ")}), or how many clients at once (${MAX_CLIENTS_OPTIONS.join(", ")})?`;

export function ratesFromRecord(cg: Record<string, unknown>): RatesDraft {
  const n = (v: unknown) => { const x = typeof v === "number" ? v : Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };
  return {
    hourlyRate: n(cg.hourlyRate),
    rateFor2: n(cg.rateFor2Seniors) || n(cg.rateForTwo),
    rateFor3: n(cg.rateFor3PlusSeniors) || n(cg.rateForThree),
    experience: typeof cg.yearsExperience === "string" ? cg.yearsExperience : typeof cg.experience === "string" ? cg.experience : "",
    maxClients: typeof cg.maxClients === "string" && cg.maxClients ? cg.maxClients : "1",
  };
}

/** The Rates section as the page shows it. */
export function ratesRecap(d: RatesDraft): string {
  const lines: string[] = [];
  if (d.hourlyRate > 0) lines.push(`1 Person: $${d.hourlyRate}/hr`);
  if (d.rateFor2 > 0) lines.push(`2 People: $${d.rateFor2}/hr`);
  if (d.rateFor3 > 0) lines.push(`3+ People: $${d.rateFor3}/hr`);
  if (!lines.length) lines.push("No rate set yet.");
  const bits = [d.experience ? `${d.experience} experience` : "", `Up to ${d.maxClients} client${d.maxClients !== "1" ? "s" : ""} at once`].filter(Boolean);
  lines.push(bits.join(" · "));
  return lines.join("\n");
}

async function handleRatesUpdate(
  caregiverId: string, phone: string, text: string,
  session: Record<string, unknown>, chatId: string,
): Promise<void> {
  const step = (session.profileUpdateStep as string) ?? "collect";
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
  const current = ratesFromRecord((cgSnap.data() ?? {}) as Record<string, unknown>);
  let draft: RatesDraft = current;
  if (step === "confirm") {
    try { draft = { ...current, ...(JSON.parse((session.profileUpdateValue as string) ?? "{}") as Partial<RatesDraft>) }; } catch { /* keep current */ }
  }
  const confirmLine = `Your Rates section would read:\n${ratesRecap(draft)}\n\nReply YES to save, NO to leave it as it is, or tell me another change.`;
  const reAsk = step === "confirm" ? confirmLine : RATES_Q;
  if (await isQuestionOrOther(text, reAsk)) {
    await sendMessage(chatId, await answerMidFlow(text, reAsk, RATES_FACTS(current)));
    return;
  }
  if (step === "confirm") {
    const decision = await parseWithClaude(
      '"yes", "save", "confirm", "do it" → YES. "no", "cancel", "wait", "never mind" → NO. Anything describing a rate, years of experience or a number of clients → CHANGE. Reply exactly YES, NO or CHANGE.',
      text, 8,
    );
    // A failed parse re-asks the recap — it never saves, clears or re-interprets the reply (2026-10-11).
    if (decision === "__parse_error__") { await sendMessage(chatId, confirmLine); return; }
    if (decision.toUpperCase().startsWith("YES")) {
      await clearProfileFlow(phone);
      // The page's Save, field for field (CaregiverProfile.tsx Rates › onSave).
      await db.collection("caregivers").doc(caregiverId).update({
        hourlyRate:          draft.hourlyRate || 0,
        rateFor2Seniors:     draft.rateFor2 || 0,
        rateFor3PlusSeniors: draft.rateFor3 || 0,
        yearsExperience:     draft.experience,
        experience:          draft.experience,
        maxClients:          draft.maxClients,
      });
      await sendMessage(chatId, `Done — your Rates section now reads:\n${ratesRecap(draft)}`);
      return;
    }
    if (decision.toUpperCase().startsWith("NO")) {
      await clearProfileFlow(phone);
      await sendMessage(chatId, "No problem — your rates weren't changed.");
      return;
    }
    // CHANGE → fall through and parse the new values onto the draft
  }
  const raw = await parseWithClaude(
    "Extract the care provider's requested changes to her Rates section. Reply with raw JSON only: " +
      '{"hourlyRate": number or null, "rateFor2": number or null, "rateFor3": number or null, ' +
      `"experience": one of [${EXPERIENCE_BUCKETS.map((b) => `"${b}"`).join(", ")}] or null, "maxClients": "1" | "2" | "3+" or null}. ` +
      'hourlyRate is the rate for ONE person ("my rate", "$28", "28 an hour"). rateFor2 is for 2 people, rateFor3 for 3 or more; ' +
      '"same as one person" means the one-person number. A number of years ("6 years") maps onto the bucket it falls in. ' +
      "Only include what they clearly stated; everything else null.",
    text,
    120,
  );
  let changes: Partial<RatesDraft> = {};
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const n = (v: unknown): number | undefined => { if (v === null || v === undefined || v === "") return undefined; const x = Number(v); return Number.isFinite(x) ? x : undefined; };
    const r1 = n(p.hourlyRate), r2 = n(p.rateFor2), r3 = n(p.rateFor3);
    if (r1 !== undefined) changes.hourlyRate = r1;
    if (r2 !== undefined) changes.rateFor2 = r2;
    if (r3 !== undefined) changes.rateFor3 = r3;
    if (typeof p.experience === "string" && p.experience) { const b = toExperienceBucket(p.experience); if (b) changes.experience = b; }
    if (typeof p.maxClients === "string" && MAX_CLIENTS_OPTIONS.includes(p.maxClients)) changes.maxClients = p.maxClients;
  } catch { changes = {}; }
  if (!Object.keys(changes).length) {
    await db.collection("agent_sessions").doc(phone).update({ profileUpdateStep: step, profileUpdateField: "rates", stateExpiresAt: FLOW_TTL() });
    await sendMessage(chatId, `I didn't catch a change in that. ${RATES_Q}`);
    return;
  }
  // The page's one rule: the 1-person rate is more than $0; 2 / 3+ people may be 0 (not offered), never negative.
  if ((changes.hourlyRate !== undefined && changes.hourlyRate <= 0) || (changes.rateFor2 !== undefined && changes.rateFor2 < 0) || (changes.rateFor3 !== undefined && changes.rateFor3 < 0)) {
    await sendMessage(chatId, `${RATE_RULE_TEXT}. What rate would you like?`);
    return;
  }
  const next: RatesDraft = { ...draft, ...changes };
  await db.collection("agent_sessions").doc(phone).update({
    profileUpdateStep:  "confirm",
    profileUpdateField: "rates",
    profileUpdateValue: JSON.stringify(next),
    stateExpiresAt:     FLOW_TTL(),
  });
  await sendMessage(chatId, `Your Rates section would read:\n${ratesRecap(next)}\n\nReply YES to save, NO to leave it as it is, or tell me another change.`);
}

// ── SKILLS ──────────────────────────────────────────────────────────────────

async function handleSkillsUpdate(
  caregiverId: string, phone: string, text: string,
  session: Record<string, unknown>, chatId: string,
): Promise<void> {
  // The profile page's Care Services editor (CaregiverProfile.tsx): the eight
  // PRIMARY_SERVICES as checkboxes, saved to services + skills (specialties is
  // the same list). Over text: add / remove / replace by name or in her own
  // words, mapped onto the eight (founder 2026-10-04: only those, ever), read
  // back by the shown names, confirmed, written to all three fields. Adding
  // Transportation needs the three documents on the record first — the same
  // rule the page enforces before Save.
  const step = (session.profileUpdateStep as string) ?? "collect";
  const menu = `Senior care: ${SERVICE_LABELS.join(", ")}. Child care: ${CHILD_SERVICE_LABELS.join(", ")}`;

  if (step === "collect") {
    const reAsk = `Which services would you like to add or remove? ${menu}. (For example "add Personal Care", "add child care — Supervision and Homework", or "remove Transportation".)`;
    if (await isQuestionOrOther(text, reAsk)) {
      await sendMessage(chatId, await answerMidFlow(text, reAsk, SKILLS_FACTS));
      return;
    }
    const raw = await parseWithClaude(
      "Parse the care provider's request to change the care services on her profile. Reply JSON: " +
        '{"action":"add"|"remove"|"replace","skills":["each SERVICE she named, in her words — NOT the words senior care / child care themselves"],"careKinds":"senior | child | both — ONLY when she names a whole list rather than services: \"remove child care\" / \"drop the child care ones\" → child with action remove; \"senior care only\" / \"just the senior services\" → senior with action replace; \"add child care\" → child with action add; omit when she names only services"}. ' +
        "If she hasn't said yet, reply: __none__.",
      text,
      150,
    );
    if (raw === "__none__" || raw === "__parse_error__") {
      await db.collection("agent_sessions").doc(phone).update({
        profileUpdateStep:  "collect",
        profileUpdateField: "skills",
        stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      await sendMessage(chatId, reAsk);
      return;
    }
    let action: "add" | "remove" | "replace" = "add";
    let words: string[] = [];
    let kindsSaid: CareKind[] | null = null;
    try {
      const parsed = JSON.parse(raw);
      action = ["add", "remove", "replace"].includes(parsed.action) ? parsed.action : "add";
      words = Array.isArray(parsed.skills) ? parsed.skills.map((s: unknown) => String(s).trim()).filter(Boolean) : [];
      kindsSaid = careKindsFromWords(parsed.careKinds);
    } catch { /* fall through */ }

    const mapping = words.length ? await mapCaregiverServices(words) : { matched: [], medical: [], unmapped: [], unresolved: [] };
    const notes: string[] = [];
    if (mapping.medical.length) notes.push(`Care Providers here don't administer medication or give medical treatment, so "${mapping.medical.join('", "')}" isn't a service I can add — the closest one on the list is Medication Reminders Only (reminding when it's time, not giving them).`);
    if (mapping.unmapped.length) notes.push(`"${mapping.unmapped.join('", "')}" isn't one of the services on the list, so I've left it off.`);
    if (mapping.unresolved.length) notes.push(`I couldn't place "${mapping.unresolved.join('", "')}" — which of the list did you mean?`);
    const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
    const cg = (cgSnap.data() ?? {}) as Record<string, unknown>;
    const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
    const current = orderedCanonicalServices([...arr(cg.skills), ...arr(cg.services), ...arr(cg.specialties)]);

    if (mapping.matched.length === 0 && !kindsSaid) {
      await db.collection("agent_sessions").doc(phone).update({
        profileUpdateStep:  "collect",
        profileUpdateField: "skills",
        stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      await sendMessage(chatId, `${notes.join(" ")}${notes.length ? " " : ""}Pick from these:\n${serviceMenuText(["senior", "child"])}`);
      return;
    }

    // No care-type setting exists (founder 2026-10-19): the page's editor is the two lists, tick anything.
    // A whole list named by its kind ("remove child care", "senior care only") acts on THAT list's services:
    // remove = untick the services only that list holds (Transportation sits on both and stays); replace =
    // keep only that list's services; "add child care" with no service named = show that list and ask.
    const listServices = (kinds: readonly CareKind[]): Set<string> => new Set(serviceListsForKinds(kinds).flatMap((l) => l.services as readonly string[]));
    const onlyOn = (kinds: readonly CareKind[]): Set<string> => {
      const others = listServices(CARE_KINDS.filter((k) => !kinds.includes(k)));
      return new Set([...listServices(kinds)].filter((s) => !others.has(s)));
    };
    if (kindsSaid && action === "add" && mapping.matched.length === 0) {
      await db.collection("agent_sessions").doc(phone).update({
        profileUpdateStep:  "collect",
        profileUpdateField: "skills",
        stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      await sendMessage(chatId, `${notes.join(" ")}${notes.length ? " " : ""}Which of these would you like to add?\n${serviceMenuText(kindsSaid)}`);
      return;
    }
    let proposed: string[];
    if (action === "add") proposed = orderedCanonicalServices([...current, ...mapping.matched]);
    else if (action === "remove") { const drop = kindsSaid ? onlyOn(kindsSaid) : new Set<string>(); proposed = current.filter((s) => !mapping.matched.includes(s) && !drop.has(s)); }
    else if (kindsSaid && mapping.matched.length === 0) { const keep = listServices(kindsSaid); proposed = current.filter((s) => keep.has(s)); }
    else proposed = mapping.matched.length ? mapping.matched : current;
    // careKinds stays DERIVED from the services (the site's kindsOfProvider rule; Transportation alone = both).
    const proposedKinds = kindsOfServices(proposed, CARE_KINDS);

    if (proposed.join("|") === current.join("|")) {
      await clearProfileFlow(phone);
      await sendMessage(chatId, `${notes.join(" ")}${notes.length ? " " : ""}Your services already read: ${serviceLabels(current).join(", ") || "(none)"} — nothing to change.`);
      return;
    }

    await db.collection("agent_sessions").doc(phone).update({
      profileUpdateStep:  "confirm",
      profileUpdateField: "skills",
      profileUpdateValue: JSON.stringify({ services: proposed, careKinds: proposedKinds }),
      stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    await sendMessage(chatId,
      `${notes.join(" ")}${notes.length ? " " : ""}Your services will be: ${serviceLabels(proposed).join(", ") || "(none)"}.\n\n` +
      `Reply YES to save that, or NO to leave them as they are.`,
    );
    return;
  }

  // confirm — the parked value is {services, careKinds} (careKinds derived from the services); an older parked array still reads.
  const parked = (() => {
    try { return JSON.parse((session.profileUpdateValue as string) ?? "[]") as unknown; } catch { return []; }
  })();
  const proposed = orderedCanonicalServices(Array.isArray(parked) ? parked : ((parked as { services?: unknown[] })?.services ?? []));
  const parkedKinds = Array.isArray(parked) ? kindsOfServices(proposed, CARE_KINDS) : kindsOfServices(proposed, CARE_KINDS);
  const reAskConfirm = `So — save these services: ${serviceLabels(proposed).join(", ") || "(none)"}? Reply YES or NO.`;
  if (await isQuestionOrOther(text, reAskConfirm)) {
    await sendMessage(chatId, await answerMidFlow(text, reAskConfirm, SKILLS_FACTS));
    return;
  }
  const decision = await yesNo(text);
  if (decision === "OTHER") { await sendMessage(chatId, reAskConfirm); return; } // a failed parse re-asks, never acts
  await clearProfileFlow(phone);
  if (decision === "YES") {
    // The page's write: services + skills — only the eight, nothing else.
    await db.collection("caregivers").doc(caregiverId).update({
      services:           proposed,
      skills:             proposed,
      careKinds:          parkedKinds, // derived from the services, never asked (2026-10-19)
    });
    await sendMessage(chatId, `Done — your services now read: ${serviceLabels(proposed).join(", ") || "(none)"}.`);
  } else {
    await sendMessage(chatId, "No problem — your services weren't changed.");
  }
}

// ── LANGUAGES — About › Edit, the six language pills (CaregiverProfile.tsx LANGUAGES) ──
export const BIO_Q = "What would you like your bio to say? This is what families see on your profile — your own words.";
export const LANGUAGES_Q = `Which languages do you speak? ${LANGUAGE_OPTIONS.join(", ")} — name as many as apply.`;
export const JOB_TYPE_Q = `What are you looking for — ${JOB_TYPE_OPTIONS.map((j) => j.label).join(", ")}? (One choice.)`;
export const TRAVEL_Q = `How far are you willing to travel for a visit — ${TRAVEL_OPTIONS.join(", ")} miles?`;

async function yesNo(text: string): Promise<"YES" | "NO" | "OTHER"> {
  const d = await parseWithClaude('"yes", "save", "confirm" → YES. "no", "cancel", "wait" → NO. Anything else → OTHER. Reply exactly YES, NO or OTHER.', text, 6);
  const u = d.toUpperCase();
  return u.startsWith("YES") ? "YES" : u.startsWith("NO") ? "NO" : "OTHER";
}

async function handleLanguagesUpdate(
  caregiverId: string, phone: string, text: string,
  session: Record<string, unknown>, chatId: string,
): Promise<void> {
  const step = (session.profileUpdateStep as string) ?? "collect";
  if (step === "collect") {
    if (await isQuestionOrOther(text, LANGUAGES_Q)) { await sendMessage(chatId, await answerMidFlow(text, LANGUAGES_Q, LANGUAGES_FACTS)); return; }
    const raw = await parseWithClaude(
      "The care provider is choosing the languages she speaks from a FIXED list: " + LANGUAGE_OPTIONS.map((l) => `"${l}"`).join(", ") + ". " +
        'Reply with raw JSON only: {"action": "set" | "add" | "remove", "languages": [exact names from the list], "other": [anything she named that is not on the list]}. ' +
        '"I speak X and Y" is set; "add X" / "also X" is add; "remove X" / "not X" is remove. If she named nothing, reply {"action":"set","languages":[],"other":[]}.',
      text, 120,
    );
    let action: "set" | "add" | "remove" = "set"; let picked: string[] = []; let other: string[] = [];
    try {
      const p = JSON.parse(raw) as Record<string, unknown>;
      action = p.action === "add" || p.action === "remove" ? p.action : "set";
      picked = (Array.isArray(p.languages) ? p.languages : []).map((v) => LANGUAGE_OPTIONS.find((l) => l.toLowerCase() === String(v).trim().toLowerCase())).filter((v): v is string => !!v);
      other = (Array.isArray(p.other) ? p.other : []).map((v) => String(v).trim()).filter(Boolean);
    } catch { /* re-ask below */ }
    const note = other.length ? `"${other.join('", "')}" isn't one of the options, so I've left it off. ` : "";
    if (!picked.length) {
      await db.collection("agent_sessions").doc(phone).update({ profileUpdateStep: "collect", profileUpdateField: "languages", stateExpiresAt: FLOW_TTL() });
      await sendMessage(chatId, `${note}${LANGUAGES_Q}`);
      return;
    }
    const cg = (await db.collection("caregivers").doc(caregiverId).get()).data() ?? {};
    const current: string[] = Array.isArray(cg.languages) && cg.languages.length ? (cg.languages as string[]) : ["English"];
    let proposed: string[];
    if (action === "add") proposed = LANGUAGE_OPTIONS.filter((l) => current.includes(l) || picked.includes(l));
    else if (action === "remove") proposed = current.filter((l) => !picked.includes(l));
    else proposed = LANGUAGE_OPTIONS.filter((l) => picked.includes(l));
    if (!proposed.length) { await sendMessage(chatId, `${note}At least one language has to stay on your profile. ${LANGUAGES_Q}`); return; }
    await db.collection("agent_sessions").doc(phone).update({
      profileUpdateStep: "confirm", profileUpdateField: "languages", profileUpdateValue: JSON.stringify(proposed), stateExpiresAt: FLOW_TTL(),
    });
    await sendMessage(chatId, `${note}Your languages will be: ${proposed.join(", ")}.\n\nReply YES to save that, or NO to leave them as they are.`);
    return;
  }
  const proposed = (() => { try { return JSON.parse((session.profileUpdateValue as string) ?? "[]") as string[]; } catch { return [] as string[]; } })();
  const reAskConfirm = `So — save these languages: ${proposed.join(", ")}? Reply YES or NO.`;
  if (await isQuestionOrOther(text, reAskConfirm)) { await sendMessage(chatId, await answerMidFlow(text, reAskConfirm, LANGUAGES_FACTS)); return; }
  const d = await yesNo(text);
  if (d === "OTHER") { await sendMessage(chatId, reAskConfirm); return; }
  await clearProfileFlow(phone);
  if (d === "YES" && proposed.length) {
    await db.collection("caregivers").doc(caregiverId).update({ languages: proposed });
    await sendMessage(chatId, `Done — your languages now read: ${proposed.join(", ")}.`);
  } else {
    await sendMessage(chatId, "No problem — your languages weren't changed.");
  }
}

// ── LOOKING FOR — Weekly Availability › the job-type pills (single choice, jobTypes: [id]) ──
async function handleJobTypeUpdate(
  caregiverId: string, phone: string, text: string,
  session: Record<string, unknown>, chatId: string,
): Promise<void> {
  const step = (session.profileUpdateStep as string) ?? "collect";
  if (step === "collect") {
    if (await isQuestionOrOther(text, JOB_TYPE_Q)) { await sendMessage(chatId, await answerMidFlow(text, JOB_TYPE_Q, JOB_TYPE_FACTS)); return; }
    const raw = await parseWithClaude(
      'Which ONE job type is the care provider choosing? "occasional" / "now and then" / "as needed" → occasional. "part time" / "a few days a week" → part-time. "full time" / "every day" → full-time. ' +
        "Reply exactly occasional, part-time, full-time, or none.",
      text, 10,
    );
    const id = JOB_TYPE_OPTIONS.find((j) => j.id === raw.trim().toLowerCase())?.id;
    if (!id) {
      await db.collection("agent_sessions").doc(phone).update({ profileUpdateStep: "collect", profileUpdateField: "jobtype", stateExpiresAt: FLOW_TTL() });
      await sendMessage(chatId, JOB_TYPE_Q);
      return;
    }
    await db.collection("agent_sessions").doc(phone).update({ profileUpdateStep: "confirm", profileUpdateField: "jobtype", profileUpdateValue: id, stateExpiresAt: FLOW_TTL() });
    await sendMessage(chatId, `Looking for: ${jobTypeLabel(id)}.\n\nReply YES to save that, or NO to leave it as it is.`);
    return;
  }
  const id = String(session.profileUpdateValue ?? "");
  const reAskConfirm = `So — set Looking for to ${jobTypeLabel(id)}? Reply YES or NO.`;
  if (await isQuestionOrOther(text, reAskConfirm)) { await sendMessage(chatId, await answerMidFlow(text, reAskConfirm, JOB_TYPE_FACTS)); return; }
  const d = await yesNo(text);
  if (d === "OTHER") { await sendMessage(chatId, reAskConfirm); return; }
  await clearProfileFlow(phone);
  if (d === "YES" && JOB_TYPE_OPTIONS.some((j) => j.id === id)) {
    // The page's Save writes jobTypes as a one-element array of the hyphenated id.
    await db.collection("caregivers").doc(caregiverId).update({ jobTypes: [id] });
    await sendMessage(chatId, `Done — Looking for: ${jobTypeLabel(id)}.`);
  } else {
    await sendMessage(chatId, "No problem — nothing changed.");
  }
}

// ── TRAVEL — Location & Travel › Edit (serviceRadius: 5 / 10 / 15 / 25 / 50 miles; the address lives in Account Settings) ──
async function handleTravelUpdate(
  caregiverId: string, phone: string, text: string,
  session: Record<string, unknown>, chatId: string,
): Promise<void> {
  const step = (session.profileUpdateStep as string) ?? "collect";
  if (step === "collect") {
    if (await isQuestionOrOther(text, TRAVEL_Q)) { await sendMessage(chatId, await answerMidFlow(text, TRAVEL_Q, TRAVEL_FACTS)); return; }
    const raw = await parseWithClaude("Extract the travel distance in miles as a number. If none is stated, reply none. Reply with just the number.", text, 10);
    const radius = toServiceRadius(raw);
    if (!radius) {
      await db.collection("agent_sessions").doc(phone).update({ profileUpdateStep: "collect", profileUpdateField: "travel", stateExpiresAt: FLOW_TTL() });
      await sendMessage(chatId, TRAVEL_Q);
      return;
    }
    await db.collection("agent_sessions").doc(phone).update({ profileUpdateStep: "confirm", profileUpdateField: "travel", profileUpdateValue: String(radius), stateExpiresAt: FLOW_TTL() });
    await sendMessage(chatId, `Willing to travel within ${radius} miles.\n\nReply YES to save that, or NO to leave it as it is.`);
    return;
  }
  const radius = Number(session.profileUpdateValue ?? 0);
  const reAskConfirm = `So — set your travel distance to ${radius} miles? Reply YES or NO.`;
  if (await isQuestionOrOther(text, reAskConfirm)) { await sendMessage(chatId, await answerMidFlow(text, reAskConfirm, TRAVEL_FACTS)); return; }
  const d = await yesNo(text);
  if (d === "OTHER") { await sendMessage(chatId, reAskConfirm); return; }
  await clearProfileFlow(phone);
  if (d === "YES" && TRAVEL_OPTIONS.includes(radius)) {
    await db.collection("caregivers").doc(caregiverId).update({ serviceRadius: radius });
    await sendMessage(chatId, `Done — willing to travel within ${radius} miles.`);
  } else {
    await sendMessage(chatId, "No problem — nothing changed.");
  }
}

// ── BIO ─────────────────────────────────────────────────────────────────────

async function handleBioUpdate(
  caregiverId: string, phone: string, text: string,
  session: Record<string, unknown>, chatId: string,
): Promise<void> {
  const step = (session.profileUpdateStep as string) ?? "collect";

  if (step === "collect") {
    const reAsk = BIO_Q;
    if (await isQuestionOrOther(text, reAsk)) {
      await sendMessage(chatId, await answerMidFlow(text, reAsk, BIO_FACTS));
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      await db.collection("agent_sessions").doc(phone).update({
        profileUpdateStep:  "collect",
        profileUpdateField: "bio",
        stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      await sendMessage(chatId, reAsk);
      return;
    }
    // A cap, never a silent cut (founder, 2026-10-19) — the page's box stops at the same count.
    if (trimmed.length > BIO_MAX_CHARS) {
      await db.collection("agent_sessions").doc(phone).update({
        profileUpdateStep:  "collect",
        profileUpdateField: "bio",
        stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      await sendMessage(chatId, `That's ${trimmed.length.toLocaleString("en-US")} characters and the bio holds up to ${BIO_MAX_CHARS.toLocaleString("en-US")}. Could you send a shorter version?`);
      return;
    }
    const bio = trimmed;
    await db.collection("agent_sessions").doc(phone).update({
      profileUpdateStep:  "confirm",
      profileUpdateField: "bio",
      profileUpdateValue: bio,
      stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    await sendMessage(chatId, `Here's your new bio:\n\n"${bio}"\n\nWant me to save that?`);
    return;
  }

  // confirm
  const proposedBio = (session.profileUpdateValue as string) ?? "";
  const reAskConfirm = `So — want me to save this bio?\n\n"${proposedBio}"`;
  if (await isQuestionOrOther(text, reAskConfirm)) {
    await sendMessage(chatId, await answerMidFlow(text, reAskConfirm, BIO_FACTS));
    return;
  }
  const decision = await yesNo(text);
  if (decision === "OTHER") { await sendMessage(chatId, reAskConfirm); return; } // a failed parse re-asks, never acts
  await clearProfileFlow(phone);
  if (decision === "YES" && proposedBio) {
    await db.collection("caregivers").doc(caregiverId).update({
      bio:              proposedBio,
    });
    await sendMessage(chatId, "Done — your bio is updated.");
  } else {
    await sendMessage(chatId, "No problem — your bio wasn't changed.");
  }
}

// ── PHOTO ───────────────────────────────────────────────────────────────────
// Uses a web upload link (auto-returns to SMS on completion per the web→SMS
// handoff rule). MMS attachments aren't reliably available on all carriers
// and the existing onboarding photo flow already uses this pattern.

async function handlePhotoUpdate(
  _caregiverId: string, phone: string, _text: string,
  _session: Record<string, unknown>, chatId: string,
): Promise<void> {
  const token = generateToken({ phone, task: "photo_upload" });
  const photoUrl = `${APP_URL}/upload/photo?t=${token}&return=sms`;

  await clearProfileFlow(phone);
  await sendMessage(chatId,
    "Tap to upload a new profile photo — it'll bring you right back here when you're done:",
  );
  await sendMessage(chatId, { parts: [{ type: "link", value: photoUrl }] });
}

// ── PAUSE ACCOUNT ──────────────────────────────────────────────────────────

async function handlePauseAccount(
  caregiverId: string, phone: string, text: string,
  session: Record<string, unknown>, chatId: string,
): Promise<void> {
  const step = (session.profileUpdateStep as string) ?? "collect";

  if (step === "collect") {
    const reAsk = "When would you like to pause until? (e.g. \"until July 12\", \"for two weeks\", \"indefinitely\")";
    if (await isQuestionOrOther(text, reAsk)) {
      await sendMessage(chatId, await answerMidFlow(text, reAsk, PAUSE_FACTS));
      return;
    }
    // Business-timezone today — a UTC anchor after 5pm PT parses "until
    // Friday" style pause dates a day late.
    const todayIso = businessTodayStr();
    const raw = await parseWithClaude(
      `Parse the care provider's pause-until date. Today is ${todayIso}. Reply JSON: ` +
        '{"until":"YYYY-MM-DD"} for a specific end date, or {"until":"indefinite"} for an open-ended pause. ' +
        'If you cannot extract any date or duration, reply: __none__.',
      text,
      40,
    );
    if (raw === "__none__" || raw === "__parse_error__") {
      await db.collection("agent_sessions").doc(phone).update({
        profileUpdateStep:  "collect",
        profileUpdateField: "pause",
        stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      await sendMessage(chatId, reAsk);
      return;
    }
    let until = "indefinite";
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.until === "string") until = parsed.until;
    } catch { /* keep default */ }

    await db.collection("agent_sessions").doc(phone).update({
      profileUpdateStep:  "confirm",
      profileUpdateField: "pause",
      profileUpdateValue: until,
      stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    const untilLabel = until === "indefinite" ? "indefinitely" : `until ${until}`;
    await sendMessage(chatId,
      `Pause your account ${untilLabel}? You won't receive job matches during this time. ` +
      `Reply YES to pause, or NO to cancel.`,
    );
    return;
  }

  // confirm
  const until = (session.profileUpdateValue as string) ?? "indefinite";
  const untilLabel = until === "indefinite" ? "indefinitely" : `until ${until}`;
  const reAskConfirm = `Pause your account ${untilLabel}? Reply YES to pause, or NO to cancel.`;
  if (await isQuestionOrOther(text, reAskConfirm)) {
    await sendMessage(chatId, await answerMidFlow(text, reAskConfirm, PAUSE_FACTS));
    return;
  }
  const decision = await parseWithClaude(
    '"yes", "pause", "confirm", "do it" → YES. "no", "cancel", "wait" → NO. Anything else → OTHER. Reply exactly YES, NO or OTHER.',
    text, 6,
  );
  // A failed or unclear parse re-asks — pausing is never decided by a guess (2026-10-11).
  if (decision !== "YES" && decision !== "NO") { await sendMessage(chatId, reAskConfirm); return; }
  await clearProfileFlow(phone);
  if (decision === "YES") {
    // This door texts its own "Done" line below, so the shared write stamps the session
    // and the lifecycle notice (B7) keeps the bell only — one text per event.
    await pauseCaregiver(caregiverId, until, { phone });
    const backWhen = until === "indefinite" ? "Text REACTIVATE whenever you're ready to come back." : `You'll be reactivated on ${until}. Text REACTIVATE sooner if your plans change.`;
    await sendMessage(chatId, `Done — your account is paused. ${backWhen}`);
  } else {
    await sendMessage(chatId, "No problem — your account is still active.");
  }
}

// ── REACTIVATE ─────────────────────────────────────────────────────────────

async function handleReactivate(
  caregiverId: string, phone: string,
  _session: Record<string, unknown>, chatId: string,
): Promise<void> {
  await reactivateCaregiver(caregiverId, { phone }); // texts its own welcome below → lifecycle bell only (B7)
  await clearProfileFlow(phone);
  const msg = await generateCaraMessage({
    audience: "caregiver",
    context: "A care provider just reactivated their account after being paused. Welcome them back warmly in one short sentence.",
    fallback: "Welcome back — you're set to receive job matches again.",
    maxTokens: 60,
  });
  await sendMessage(chatId, msg);
}

/**
 * Helper: detect which profile-update field an inbound intent corresponds to.
 * Returns undefined if the intent isn't a profile-update intent.
 */
export function profileFieldFromIntent(intent: string): ProfileUpdateField | undefined {
  switch (intent) {
    case "UPDATE_RATE":    return "rates";
    case "UPDATE_SKILLS":  return "skills";
    case "UPDATE_BIO":     return "bio";
    case "UPDATE_PHOTO":   return "photo";
    case "PAUSE_ACCOUNT":  return "pause";
    case "REACTIVATE":     return "reactivate";
    default:               return undefined;
  }
}
