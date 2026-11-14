// ── The family intake as ONE process that follows the site (2026-10-20) ──────
//
// Founder, after a text test in which "me and my child" became an adult-or-child
// question about him, the correction was dropped, and the confirm step appended
// his words to the job description: "can there be one process that follows the
// site … make sure that works well and correct" — and then: "do the same as the
// site. everything that a client can do on the site for the signup wizard all
// the way to the confirmation."
//
// This module IS the family questionnaire by text: the site wizard's steps, in
// the site's order, one question per turn, with fixed wording. The model does two
// things only — it reads each answer into the field's value (parseWithClaude) and
// it answers a side question before the current question is re-asked. It never
// decides what to ask next and never writes a question.
//
//   site step  → text step
//   /start     name (only when a cold text has none)   family_ask_name
//   2  frequency                                       family_ask_frequency
//   3  home address (ZIP → city/state)                 family_ask_home_address
//   4  care address (saved / different; county gate)   family_ask_care_address
//   6  start date, ongoing / end date                  family_ask_start, family_ask_ongoing
//   6  days (select all) + flexible + time of day       family_ask_days
//   8  photo (Skip for now)                            family_ask_photo
//   9  relationship (six buttons; Other → adult/child) family_ask_recipients (+ _recipient_kind)
//   10 name (+ Stage for a child)                      family_ask_recipient_name, _recipient_stage
//   10 "How many people need care?" (1-4)              family_ask_more_people
//   10 each extra person: relationship, kind, name, stage   family_ask_recipient_relationship, …
//   10 "How many care providers do you need?" (1-4)    family_ask_providers_count
//   11 emergency contact: name, phone, relationship    family_ask_emergency, _phone, _relationship
//   12 care types (the lists for the people on the post), pets / smoking   family_ask_needs, family_ask_pets_smoking
//   13 rate                                            family_ask_rate
//   14 description (cap, never cut; medication refused) family_ask_description
//   /start email (only when the site didn't collect it) family_ask_email
//   → client_confirm_intake (the existing recap + confirm handler) = step 15
//
// The next question is always the FIRST UNANSWERED step computed from the live
// data — the site record (job_postings / users, read before every turn) under the
// text draft — so answers given on the site are never asked again, front-loaded
// answers skip ahead, and a correction at any step simply changes the data.
//
// Nothing about a person is guessed: a bare "my son / my daughter" is ASKED —
// child, or an adult son or daughter — the way the site's Adult child and Child
// buttons force the pick; the count of people is asked like the site's counter.
//
// Everything saved goes through mergeOnboardingData, which mirrors each field to
// job_postings/{uid} as it lands, so the site shows it while the text is going.
//
// Pure parts (step order, next step, roster rules, questions, value validation)
// are exported for tests; every side effect arrives through FamilyIntakeDeps.
import { containsContactDetails, CONTACT_DETAILS_MESSAGE } from "../utils/contactDetails";
import {
  AGE_RANGES, STAGE_HEADING, OTHER_KIND_QUESTION, ageRangeFromWords, ageRangeLabel, stageQuestion,
  recipientCareKind, rosterCareKinds, serviceMenuText, serviceLabel, JOB_DESCRIPTION_MAX_CHARS,
  CARE_KIND_LABEL, type CareKind,
} from "./caregiverServiceLabels";
import { coerceClientRate, isFieldFilled, FAMILY_STEP_ORDER, FAMILY_STEP_IDS } from "./onboardingContract";
import { normalizeStartDateToISO, formatWizardPhone, mapTimeOfDayToWizardValues } from "./clientJobPostingContract";
import { timeOfDayFromClock, CLOCK_TIMES_NOTE } from "./familyClockTimes";

// ── Step ids (in the site's order; the list itself lives in onboardingContract.ts) ──
export { FAMILY_STEP_ORDER, FAMILY_STEP_IDS };
export type FamilyStep = (typeof FAMILY_STEP_ORDER)[number];
export function isFamilyScriptStep(step: unknown): step is FamilyStep {
  return typeof step === "string" && (FAMILY_STEP_IDS as readonly string[]).includes(step);
}

/** The site allows one to four people on a post, and one to four care providers. */
export const MAX_RECIPIENTS = 4;
export const MAX_PROVIDERS = 4;

type Data = Record<string, unknown>;

// ── Roster model ─────────────────────────────────────────────────────────────
// Evia's internal relationship words (the website's are mapped at the boundary by
// careRecipients.toWebsiteRelationship: self → myself; the rest pass through).
// "unknown" is a person the count question added whose relationship is still to be asked.
export type RosterRelationship = "self" | "parent" | "spouse" | "adult child" | "child" | "other" | "unknown";
/** The site's six, in the site's order — the words every relationship question offers. */
export const RELATIONSHIP_OPTIONS_TEXT = "Myself, Parent, Spouse or Partner, Adult child, Child, or Other";

export interface RosterPerson {
  relationship: RosterRelationship;
  /** First (and last) name as given; "" until asked. Self carries the account name. */
  name: string;
  /** Only for "other": the site's two-way pick. */
  careKind?: "senior" | "child";
  /** Only for a child: one AGE_RANGES id. */
  ageRange?: string;
  /** A bare "my son / my daughter": child or adult child is still to be ASKED (never guessed). */
  kindUnknown?: boolean;
}

export function normalizeRelationship(value: unknown): RosterRelationship | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (["self", "myself", "me", "i"].includes(v)) return "self";
  if (["parent", "mother", "father", "mom", "dad", "mum", "stepmother", "stepfather", "parents"].includes(v)) return "parent";
  if (["spouse", "spouse or partner", "partner", "wife", "husband"].includes(v)) return "spouse";
  if (["adult child", "adult son", "adult daughter", "grown son", "grown daughter", "grown child"].includes(v)) return "adult child";
  if (["child", "kid", "baby", "toddler", "infant", "teen", "teenager", "minor"].includes(v)) return "child";
  if (["son", "daughter", "son or daughter", "son or daughter (age unknown)"].includes(v)) return "child"; // callers mark kindUnknown
  if (["other", "grandparent", "grandmother", "grandfather", "sibling", "brother", "sister", "friend", "neighbor", "relative", "aunt", "uncle", "cousin"].includes(v)) return "other";
  if (["unknown", ""].includes(v)) return "unknown";
  return null;
}

/** A person is a child when the relationship says so (and it is not still to be asked), or Other was answered "child". */
export function isChildPerson(p: Pick<RosterPerson, "relationship" | "careKind" | "kindUnknown">): boolean {
  if (p.kindUnknown) return false;
  const rel = p.relationship === "self" ? "Myself" : p.relationship === "adult child" ? "Adult child" : p.relationship === "unknown" ? "" : p.relationship.charAt(0).toUpperCase() + p.relationship.slice(1);
  return recipientCareKind(rel, p.careKind) === "child";
}

function personFromStored(r: Record<string, unknown> | undefined, fallbackRel: RosterRelationship): RosterPerson {
  const rel = normalizeRelationship(r?.relationship) ?? fallbackRel;
  return {
    relationship: rel,
    name: String(r?.name ?? "").trim(),
    ...(r?.careKind === "child" || r?.careKind === "senior" ? { careKind: r.careKind as "child" | "senior" } : {}),
    ...(typeof r?.ageRange === "string" && r.ageRange ? { ageRange: r.ageRange } : {}),
    ...(r?.kindUnknown === true ? { kindUnknown: true } : {}),
  };
}

/** The roster as stored: primary on the top-level fields, the rest in additionalRecipients. */
export function rosterFromData(d: Data): RosterPerson[] {
  const primaryRel = normalizeRelationship(d.relationship);
  if (!primaryRel || primaryRel === "unknown") return [];
  const primary: RosterPerson = {
    relationship: primaryRel,
    name: String(d.seniorName ?? "").trim(),
    ...(d.careKind === "child" || d.careKind === "senior" ? { careKind: d.careKind } : {}),
    ...(typeof d.ageRange === "string" && d.ageRange ? { ageRange: d.ageRange } : {}),
    ...(d.primaryKindUnknown === true ? { kindUnknown: true } : {}),
  };
  const extra = Array.isArray(d.additionalRecipients) ? (d.additionalRecipients as Array<Record<string, unknown>>) : [];
  return [primary, ...extra.map((r) => personFromStored(r, "unknown"))];
}

/** The stored shape for a roster (the fields mergeOnboardingData mirrors to the site). */
export function dataFromRoster(roster: RosterPerson[]): Data {
  if (!roster.length) return {};
  const [p, ...rest] = roster;
  return {
    relationship: p.relationship,
    seniorName: p.name,
    careKind: p.relationship === "other" && p.careKind ? p.careKind : null,
    ageRange: isChildPerson(p) && p.ageRange ? p.ageRange : null,
    primaryKindUnknown: p.kindUnknown === true ? true : null,
    additionalRecipients: rest.map((r) => ({
      name: r.name,
      relationship: r.relationship === "unknown" ? "" : r.relationship,
      ...(r.relationship === "other" && r.careKind ? { careKind: r.careKind } : {}),
      ...(isChildPerson(r) && r.ageRange ? { ageRange: r.ageRange } : {}),
      ...(r.kindUnknown === true ? { kindUnknown: true } : {}),
    })),
  };
}

export type RosterPending =
  | { kind: "relationship"; index: number; person: RosterPerson }
  | { kind: "kind"; index: number; person: RosterPerson }
  | { kind: "name"; index: number; person: RosterPerson }
  | { kind: "stage"; index: number; person: RosterPerson };

/** The first thing still missing on the roster, in person order — the site's step-9/10 gate. */
export function rosterPending(roster: RosterPerson[]): RosterPending | null {
  for (let i = 0; i < roster.length; i++) {
    const p = roster[i];
    if (p.relationship === "unknown") return { kind: "relationship", index: i, person: p };
    if (p.relationship === "other" && !p.careKind) return { kind: "kind", index: i, person: p };
    if (p.kindUnknown) return { kind: "kind", index: i, person: p };
    if (!p.name && p.relationship !== "self") return { kind: "name", index: i, person: p };
    if (isChildPerson(p) && !p.ageRange) return { kind: "stage", index: i, person: p };
  }
  return null;
}

/** "your mom", "your child", "this person" — how a question names an unnamed person. */
export function personPhrase(p: RosterPerson): string {
  if (p.name) return p.name;
  switch (p.relationship) {
    case "self": return "you";
    case "parent": return "your parent";
    case "spouse": return "your spouse or partner";
    case "adult child": return "your adult child";
    case "child": return p.kindUnknown ? "your son or daughter" : "your child";
    default: return "this person";
  }
}

// ── Next step: the first unanswered step from the live data ──────────────────
export function nextFamilyStep(d: Data): FamilyStep | null {
  // The account holder's name comes from /start; a cold text asks it once (first + last).
  if (!isFieldFilled(d.firstName)) return "family_ask_name";
  if (!isFieldFilled(d.careFrequency)) return "family_ask_frequency";
  if (!isFieldFilled(d.homeStreet) || !isFieldFilled(d.homeZipCode)) return "family_ask_home_address";
  if (d.sameAsHomeAddress !== true && !(isFieldFilled(d.street) && isFieldFilled(d.zipCode))) return "family_ask_care_address";
  if (!normalizeStartDateToISO(d.startDate)) return "family_ask_start";
  if (d.ongoing !== true && !isFieldFilled(d.endDate)) return "family_ask_ongoing";
  const days = Array.isArray(d.selectedDays) ? (d.selectedDays as unknown[]) : [];
  const tod = mapTimeOfDayToWizardValues(d.timeOfDay);
  if ((!days.length && d.daysFlexible !== true) || !tod.length) return "family_ask_days";
  if (!isFieldFilled(d.careRecipientPhotoURL) && d.photoSkipped !== true) return "family_ask_photo";
  const roster = rosterFromData(d);
  if (!roster.length) return "family_ask_recipients";
  // Each person is completed (relationship → adult/child → name → stage) before the next question.
  const pending = rosterPending(roster);
  if (pending) return stepForPending(pending);
  // The site's counter, by text: "Is there anyone else who needs care?" — asked after each person
  // until NO, a number, or four people (naming several at once, a number or "no" count as the count
  // being answered). Founder, 2026-10-21: cycle back for the next person. The mirrored adultsCount
  // is NOT a count answer — it is written after every added person, so reading it as "confirmed"
  // ended the cycle at the second person (live 2026-10-21: no way to add a third).
  const countConfirmed = d.rosterCountConfirmed === true;
  if (roster.length < MAX_RECIPIENTS && !countConfirmed) return "family_ask_more_people";
  const providers = Number(d.caregiversNeeded);
  if (!(providers >= 1 && providers <= MAX_PROVIDERS)) return "family_ask_providers_count";
  if (!isFieldFilled(d.emergencyContactName)) return "family_ask_emergency";
  if (!isFieldFilled(d.emergencyContactPhone)) return "family_ask_emergency_phone";
  if (!isFieldFilled(d.emergencyContactRelationship)) return "family_ask_emergency_relationship";
  if (!(Array.isArray(d.careNeeds) && (d.careNeeds as unknown[]).length)) return "family_ask_needs";
  if (careListsNotYetOffered(d).length) return "family_ask_needs"; // a person added later: their list, once
  if (d.householdAsked !== true) return "family_ask_pets_smoking";
  if (coerceClientRate(d.rate) === null) return "family_ask_rate";
  if (!isFieldFilled(d.jobDescription) && d.descriptionSkipped !== true) return "family_ask_description";
  if (!isFieldFilled(d.email)) return "family_ask_email";
  return null;
}

/** The care lists the people on the roster imply (a still-unknown person implies nothing yet). */
export function rosterKinds(d: Data): CareKind[] {
  const roster = rosterFromData(d).filter((p) => p.relationship !== "unknown" && !p.kindUnknown);
  return rosterCareKinds(roster.map((p) => ({ relationship: p.relationship === "self" ? "Myself" : p.relationship === "adult child" ? "Adult child" : p.relationship, careKind: p.careKind })));
}

/**
 * The lists whose services were never offered for this post: the site shows the
 * lists for everyone on the post, so a person added AFTER the care types were
 * picked (an adult joining a child-only post, or the reverse) gets their list
 * offered once. Care types that came from the site count as offered for everyone.
 */
export function careListsNotYetOffered(d: Data): CareKind[] {
  if (!(Array.isArray(d.careNeeds) && (d.careNeeds as unknown[]).length)) return [];
  if (!Array.isArray(d.careNeedsKindsOffered)) return []; // saved on the site (or before this rule): every list counts as offered
  const offered = new Set((d.careNeedsKindsOffered as unknown[]).map(String));
  return rosterKinds(d).filter((k) => !offered.has(k));
}

function stepForPending(p: RosterPending): FamilyStep {
  switch (p.kind) {
    case "relationship": return "family_ask_recipient_relationship";
    case "kind": return "family_ask_recipient_kind";
    case "name": return "family_ask_recipient_name";
    case "stage": return "family_ask_recipient_stage";
  }
}

/** The person a roster sub-step is about: the first person first, then the rest in order. */
function currentPending(d: Data): RosterPending | null {
  const roster = rosterFromData(d);
  if (!roster.length) return null;
  return rosterPending([roster[0]]) ?? rosterPending(roster);
}

function ordinalLabel(index: number): string { return `care recipient ${index + 1}`; }

// ── Questions: fixed text, the site's words ──────────────────────────────────
export function familyQuestion(step: FamilyStep, d: Data): string {
  const roster = rosterFromData(d);
  const pending = currentPending(d);
  switch (step) {
    case "family_ask_name": return "What's your first and last name?";
    case "family_ask_frequency": return "How often do you need care — occasional, part-time, or full-time?";
    case "family_ask_home_address": return "What's your home address? The street and ZIP code is all I need.";
    case "family_ask_care_address": return "Is care needed at that same address? Say yes, or send the care address (street and ZIP).";
    case "family_ask_start": return "When would you like care to start — as soon as possible, or a date?";
    case "family_ask_ongoing": return "Is this ongoing, or is there an end date?";
    case "family_ask_days": return "Which days of the week, and what time of day — morning, afternoon, evening, or overnight? (You can also say the days are flexible.)";
    case "family_ask_photo": return "Want to add a profile photo of yourself? Send a picture here, or say skip.";
    case "family_ask_recipients": return `What is your relationship to the person needing care? ${RELATIONSHIP_OPTIONS_TEXT}. (If care is for more than one person, you can name them all.)`;
    case "family_ask_recipient_relationship": return pending?.kind === "relationship"
      ? `What is your relationship to ${ordinalLabel(pending.index)}? ${RELATIONSHIP_OPTIONS_TEXT}.`
      : `What is your relationship to this person? ${RELATIONSHIP_OPTIONS_TEXT}.`;
    case "family_ask_recipient_kind": {
      if (pending?.kind !== "kind") return OTHER_KIND_QUESTION;
      const who = pending.person.name || personPhrase(pending.person);
      return pending.person.kindUnknown
        ? `Is ${who} a child, or an adult son or daughter?`
        : `${pending.person.name ? pending.person.name + " — " : ""}${OTHER_KIND_QUESTION}`;
    }
    case "family_ask_recipient_name": return pending?.kind === "name" ? `What's ${personPhrase(pending.person)}'s name? First and last is best.` : "Who is the care for?";
    case "family_ask_recipient_stage": return pending?.kind === "stage" ? stageQuestion(pending.person.name || personPhrase(pending.person)) : stageQuestion(null);
    // The site's counter, in text form (founder, 2026-10-20: a yes/no beats "how many in total"); a number still works.
    case "family_ask_more_people": return d.rosterAddPending === true
      ? `Who else needs care? Your relationship to them — ${RELATIONSHIP_OPTIONS_TEXT.replace("Myself, ", "Myself, ")}.`
      : "Is there anyone else who needs care? If not, just say no. Otherwise tell me who.";
    case "family_ask_providers_count": return `How many care providers do you need, 1 to 4? Most families need 1.`;
    case "family_ask_emergency": return "Who should we contact in case of an emergency? Their name and phone number.";
    case "family_ask_emergency_phone": return `What's ${String(d.emergencyContactName ?? "their")}'s phone number?`;
    case "family_ask_emergency_relationship": {
      const who = roster.length ? (roster[0].relationship === "self" ? "you" : roster[0].name || personPhrase(roster[0])) : "the person needing care";
      return `How is ${String(d.emergencyContactName ?? "that person")} related to ${who}? (e.g. Mother, Sibling, Friend)`;
    }
    case "family_ask_needs": {
      const missing = careListsNotYetOffered(d);
      if (missing.length) {
        const who = roster.filter((p) => missing.includes(recipientCareKind(p.relationship === "self" ? "Myself" : p.relationship === "adult child" ? "Adult child" : p.relationship, p.careKind))).map((p) => (p.relationship === "self" ? "you" : p.name || personPhrase(p)));
        const whoText = who.length === 1 ? who[0] : `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}`;
        const listName = missing.map((k) => CARE_KIND_LABEL[k].toLowerCase()).join(" and ");
        return `Now that ${whoText || "they"} ${who.length === 1 && who[0] !== "you" ? "is" : "are"} on the post too, anything from the ${listName} list? Pick as many as apply, or say none:\n${serviceMenuText(missing)}`;
      }
      const kinds = rosterKinds(d);
      return `What type of care is needed? Pick as many as apply:\n${serviceMenuText(kinds.length ? kinds : ["senior"])}`;
    }
    case "family_ask_pets_smoking": return "Two quick ones: are there pets in the home, and does anyone in the household smoke?";
    case "family_ask_rate": return "What would you like to pay per hour? (e.g. 32)";
    case "family_ask_description": return `What else should care providers know about this job? Care providers browsing jobs can read this, so leave out medical details, addresses, phone numbers, email addresses, and anything private. You can also say skip.`;
    case "family_ask_email": return "Last thing — what's your email address? It's only used for account recovery, never shared with care providers.";
  }
}

// ── Value rules (the site's) ─────────────────────────────────────────────────
const DAY_CODES: Record<string, string> = {
  sun: "SUN", sunday: "SUN", mon: "MON", monday: "MON", tue: "TUE", tues: "TUE", tuesday: "TUE", wed: "WED", wednesday: "WED",
  thu: "THU", thur: "THU", thurs: "THU", thursday: "THU", fri: "FRI", friday: "FRI", sat: "SAT", saturday: "SAT",
};
export function normalizeDayCodes(value: unknown): string[] {
  const arr = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s/]+/) : [];
  const out: string[] = [];
  for (const v of arr) { const c = DAY_CODES[String(v).trim().toLowerCase()]; if (c && !out.includes(c)) out.push(c); }
  const order = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return out.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
export function normalizeFrequency(value: unknown): "occasional" | "part_time" | "full_time" | null {
  const v = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["occasional", "specific", "sometimes", "as_needed"].includes(v)) return "occasional";
  if (["part_time", "parttime", "part"].includes(v)) return "part_time";
  if (["full_time", "fulltime", "full"].includes(v)) return "full_time";
  return null;
}
export function isValidZip(value: unknown): value is string { return /^\d{5}$/.test(String(value ?? "").trim()); }
function smallCount(value: unknown, max: number): number | null {
  const n = Number(String(value ?? "").trim().replace(/[^\d]/g, ""));
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

// ── Deps: every side effect, injected ────────────────────────────────────────
export interface FamilyIntakeDeps {
  parseWithClaude: (prompt: string, text: string) => Promise<string>;
  isQuestionOrOther: (text: string, currentQuestion: string) => Promise<boolean>;
  answerQuestionMidFlow: (text: string, session: any, phone: string) => Promise<string>;
  canonicalizeCareNeeds: (terms: unknown, opts?: { kinds?: readonly string[] }) => Promise<{ careNeeds: string[]; medical: string[]; unmapped: string[] }>;
  lookupZipPlace: (zip: string) => Promise<{ city: string; state: string } | null>;
  evaluateServiceArea: (args: { city?: string | null; zip?: string | null }) => "in" | "out" | "need_zip";
  parkOutOfArea: (args: { phone: string; role: "client"; city: string; zipCode: string; name?: string; onboardingData?: Data }) => Promise<void>;
  /** The site record mapped into draft field names (job_postings + users) — read before every turn. */
  loadSiteData: (session: any) => Promise<Data>;
  mergeOnboardingData: (phone: string, fields: Data) => Promise<void>;
  updateSession: (phone: string, updates: Data) => Promise<void>;
  sendMessage: (chatId: string, text: string) => Promise<unknown>;
  /** Park the cursor at client_confirm_intake and send the recap (the existing confirm step), prefixed by the last ack in the SAME message. */
  sendRecap: (phone: string, chatId: string, prefix?: string) => Promise<void>;
  isMedicationInstruction: (text: string) => boolean;
  medicationMessage: string;
  /** Today in the business time zone (YYYY-MM-DD) and its weekday name, for relative dates. */
  today: () => { iso: string; weekday: string };
}

export interface FamilyIntakeTurn {
  phone: string;
  chatId: string;
  text: string;
  session: any;
}

/** The effective data this turn sees: the site record under the text draft (a text answer wins). */
export async function effectiveFamilyData(deps: FamilyIntakeDeps, session: any): Promise<Data> {
  const draft = (session?.onboardingData ?? {}) as Data;
  const site = await deps.loadSiteData(session).catch(() => ({} as Data));
  const out: Data = { ...site };
  for (const [k, v] of Object.entries(draft)) if (isFieldFilled(v) || typeof v === "boolean" || typeof v === "number") out[k] = v;
  return out;
}

// ── Per-step answer readers (the model reads the value; the code validates it) ──
interface StepResult { fields: Data; ack: string }

async function readName(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null | { error: string }> {
  const raw = await deps.parseWithClaude("Extract the person's own name as given (first and last if shared). Reply with just the name as typed, or unknown.", text);
  const name = raw.trim();
  if (!name || name.toLowerCase() === "unknown" || name === "__parse_error__") return null;
  const [firstName, ...rest] = name.split(/\s+/);
  const lastName = rest.join(" ");
  // Both parts, like the site's signup (2026-10-24): a first name alone is asked again, never saved half.
  if (!lastName) return { error: `Thanks, ${firstName} — I need your last name too. What's your first and last name?` };
  return { fields: { firstName, ...(lastName ? { lastName } : {}) }, ack: `Nice to meet you, ${firstName}.` };
}

async function readFrequency(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null> {
  const raw = await deps.parseWithClaude(
    'The family was asked how often they need care: occasional, part-time, or full-time. Reply with exactly one word — occasional, part_time, full_time — or unknown if they did not say.',
    text,
  );
  const f = normalizeFrequency(raw);
  if (!f) return null;
  const word = f === "occasional" ? "Occasional" : f === "part_time" ? "Part-time" : "Full-time";
  return { fields: { careFrequency: f }, ack: `${word} care, got it.` };
}

async function readAddress(deps: FamilyIntakeDeps, text: string): Promise<{ street: string; zip: string } | null> {
  const raw = await deps.parseWithClaude(
    'Extract a US street address line (house number + street) and the 5-digit ZIP code from this message. Reply with raw JSON {"street":"","zip":""}; leave a value empty if it is not there.',
    text,
  );
  try {
    const p = JSON.parse(raw) as { street?: unknown; zip?: unknown };
    const street = String(p.street ?? "").trim();
    const zip = String(p.zip ?? "").trim();
    if (!street && !isValidZip(zip)) return null;
    return { street, zip: isValidZip(zip) ? zip : "" };
  } catch { return null; }
}

async function readHomeAddress(deps: FamilyIntakeDeps, text: string, d: Data): Promise<StepResult | null> {
  const a = await readAddress(deps, text);
  if (!a) return null;
  const street = a.street || String(d.homeStreet ?? "");
  const zip = a.zip || String(d.homeZipCode ?? "");
  if (!street || !isValidZip(zip)) return null;
  const place = await deps.lookupZipPlace(zip).catch(() => null);
  const fields: Data = { homeStreet: street, homeZipCode: zip, ...(place ? { homeCity: place.city, homeState: place.state } : {}) };
  const where = place ? `${street}, ${place.city} ${zip}` : `${street}, ${zip}`;
  return { fields, ack: `${where}, got it.` };
}

async function readCareAddress(deps: FamilyIntakeDeps, text: string, d: Data): Promise<StepResult | null> {
  const raw = await deps.parseWithClaude(
    'The family was asked whether care is needed at the same address as their home, or at another address. Reply exactly SAME if they said yes / same / there, ADDRESS if they gave or implied a different address, or unknown.',
    text,
  );
  const v = raw.trim().toUpperCase();
  if (v === "SAME") {
    return {
      fields: { sameAsHomeAddress: true, street: d.homeStreet, zipCode: d.homeZipCode, city: d.homeCity ?? null, state: d.homeState ?? null },
      ack: "Same address, got it.",
    };
  }
  const a = await readAddress(deps, text);
  if (!a || !a.street || !isValidZip(a.zip)) return null;
  const place = await deps.lookupZipPlace(a.zip).catch(() => null);
  return {
    fields: { sameAsHomeAddress: false, street: a.street, zipCode: a.zip, ...(place ? { city: place.city, state: place.state } : {}) },
    ack: `Care at ${a.street}${place ? `, ${place.city}` : ""} ${a.zip}, got it.`,
  };
}

async function readStart(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null> {
  const t = deps.today();
  const raw = await deps.parseWithClaude(
    `Today is ${t.weekday}, ${t.iso}. The family was asked when they want care to start. Reply with the date as YYYY-MM-DD (resolve relative words like tomorrow / next Monday against today), ASAP if they want it right away or as soon as possible, or unknown.`,
    text,
  );
  const iso = normalizeStartDateToISO(raw.trim(), t.iso);
  if (!iso) return null;
  const asap = iso === t.iso;
  return { fields: { startDate: iso }, ack: asap ? "Starting as soon as possible, got it." : `Starting ${iso}, got it.` };
}

async function readOngoing(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null> {
  const t = deps.today();
  const raw = await deps.parseWithClaude(
    `Today is ${t.weekday}, ${t.iso}. The family was asked whether the care is ongoing or has an end date. Reply exactly ONGOING, or the end date as YYYY-MM-DD, or unknown.`,
    text,
  );
  const v = raw.trim();
  if (v.toUpperCase() === "ONGOING") return { fields: { ongoing: true, endDate: null }, ack: "Ongoing, got it." };
  const iso = normalizeStartDateToISO(v, t.iso);
  if (!iso) return null;
  return { fields: { ongoing: false, endDate: iso }, ack: `Through ${iso}, got it.` };
}

async function readDays(deps: FamilyIntakeDeps, text: string, d: Data): Promise<StepResult | null> {
  const raw = await deps.parseWithClaude(
    'The family was asked which days of the week and what time of day they need care. Reply with raw JSON {"days":["MON","TUE"],"flexible":false,"timeOfDay":["morning"]} — days as uppercase 3-letter codes; flexible true when they said the days are flexible / any day; timeOfDay from morning, afternoon, evening, overnight (several allowed; "all day" = morning, afternoon, evening). Leave a value empty when not stated.',
    text,
  );
  let p: { days?: unknown; flexible?: unknown; timeOfDay?: unknown };
  try { p = JSON.parse(raw); } catch { return null; }
  const days = normalizeDayCodes(p.days);
  const flexible = p.flexible === true;
  // A stated clock range ("9am to 1pm") is every day-part it touches, not just the one the model picked.
  const clockParts = timeOfDayFromClock(text);
  const tod = clockParts.length ? mapTimeOfDayToWizardValues(clockParts) : mapTimeOfDayToWizardValues(p.timeOfDay);
  const prevDays = Array.isArray(d.selectedDays) ? (d.selectedDays as string[]) : [];
  const prevTod = mapTimeOfDayToWizardValues(d.timeOfDay);
  const finalDays = days.length ? days : prevDays;
  const finalFlex = flexible || (!days.length && d.daysFlexible === true);
  const finalTod = tod.length ? tod : prevTod;
  if (!days.length && !flexible && !tod.length) return null;
  const fields: Data = {
    ...(days.length ? { selectedDays: days, daysFlexible: false } : flexible ? { daysFlexible: true, selectedDays: [] } : {}),
    ...(tod.length ? { timeOfDay: tod } : {}),
  };
  const dayWords = finalFlex && !finalDays.length ? "flexible days" : finalDays.join("/");
  const ack = `${[dayWords, finalTod.join("/")].filter(Boolean).join(", ")}, got it.${clockParts.length ? ` ${CLOCK_TIMES_NOTE}` : ""}`;
  return { fields, ack };
}

async function readPhotoSkip(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null> {
  const raw = await deps.parseWithClaude(
    'The family was asked to send a profile photo or say skip. Reply exactly SKIP if they declined or want to skip / do it later, or unknown.',
    text,
  );
  if (raw.trim().toUpperCase() === "SKIP") return { fields: { photoSkipped: true }, ack: "No problem, we'll skip the photo." };
  return null;
}

/**
 * "me and my child", "my parents", "mom Dorothy and dad Frank", "Parent" → a roster (first = primary).
 * A bare son / daughter is NOT guessed: it comes back as a child with kindUnknown, so the next
 * question asks child or adult son/daughter — the site's Adult child vs Child buttons, by text.
 */
export async function readRoster(deps: FamilyIntakeDeps, text: string, accountName: { first: string; last: string }): Promise<{ roster: RosterPerson[]; capped: boolean } | null> {
  const raw = await deps.parseWithClaude(
    "The family was asked their relationship to the person needing care (Myself, Parent, Spouse or Partner, Adult child, Child, or Other) and may name one or several people. List EVERY person needing care, in the order mentioned, as raw JSON " +
      '{"people":[{"relationship":"self|parent|spouse|adult child|child|son or daughter (age unknown)|other","name":"first and last if given, else empty","stage":"only for a child when stated: ' +
      AGE_RANGES.map((a) => a.label).join(", ") + '","kind":"only for other when stated: adult|child"}]}. ' +
      'Rules: "me / myself / I" is self. "child", "kid", a baby/toddler/teen, or a son/daughter with an age under 18 is child. A GROWN son or daughter, or "adult child", is "adult child". ' +
      'A bare "my son" / "my daughter" with NO age or adult/child cue is "son or daughter (age unknown)" — never guess. "mom / dad / mother / father" is parent; "my parents" is TWO parents. "wife / husband / partner" is spouse. Anyone else (grandparent, sibling, friend, neighbor) is other. ' +
      'Do not invent people and do not repeat a person. Reply {"people":[]} if nobody is named.',
    text,
  );
  let p: { people?: unknown };
  try { p = JSON.parse(raw); } catch { return null; }
  const people = Array.isArray(p.people) ? (p.people as Array<Record<string, unknown>>) : [];
  const roster: RosterPerson[] = [];
  for (const x of people) {
    const relWord = String(x?.relationship ?? "").trim().toLowerCase();
    const rel = normalizeRelationship(relWord);
    if (!rel || rel === "unknown") continue;
    const kindUnknown = relWord.startsWith("son or daughter") || relWord === "son" || relWord === "daughter";
    const name = rel === "self" ? [accountName.first, accountName.last].filter(Boolean).join(" ") : String(x?.name ?? "").trim();
    const stage = ageRangeFromWords(x?.stage) ?? undefined;
    const kindWord = String(x?.kind ?? "").trim().toLowerCase();
    const careKind = rel === "other" ? (kindWord === "child" ? "child" : kindWord === "adult" ? "senior" : undefined) : undefined;
    if (rel === "self" && roster.some((r) => r.relationship === "self")) continue;
    // A stated stage settles a bare son/daughter as a child.
    const settledUnknown = kindUnknown && !stage;
    roster.push({
      relationship: rel, name,
      ...(careKind ? { careKind } : {}),
      ...(stage && (rel === "child" || careKind === "child") ? { ageRange: stage } : {}),
      ...(settledUnknown ? { kindUnknown: true } : {}),
    });
  }
  if (!roster.length) return null;
  const merged = mergeSamePerson(roster, text);
  const capped = merged.length > MAX_RECIPIENTS;
  return { roster: merged.slice(0, MAX_RECIPIENTS), capped };
}

/**
 * "It's for my mom, Linda" is ONE person. The reader sometimes lists "my mom" and "Linda" separately, which left the
 * family with a nameless parent AND a named one (live text test, 2026-11-14). Two people with the same relationship,
 * exactly one of them named, in a message with no "and" / "both" / plural, are the same person.
 */
export function mergeSamePerson(roster: RosterPerson[], text: string): RosterPerson[] {
  if (roster.length !== 2) return roster;
  const [a, b] = roster;
  if (a.relationship !== b.relationship || a.relationship === "self" || a.relationship === "unknown") return roster;
  const named = roster.filter((p) => p.name);
  if (named.length !== 1) return roster;
  if (/\b(and|&|both|plus|also|parents|siblings)\b|\+/i.test(text)) return roster;
  return [named[0]];
}

function rosterAck(roster: RosterPerson[]): string {
  const words = roster.map((p) => (p.relationship === "self" ? "you" : p.name || personPhrase(p)));
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return `Care for ${list}, got it.`;
}

async function readRecipientRelationship(deps: FamilyIntakeDeps, text: string, d: Data, accountName: { first: string; last: string }): Promise<StepResult | null> {
  const roster = rosterFromData(d);
  const pending = currentPending(d);
  if (!pending || pending.kind !== "relationship") return null;
  const r = await readRoster(deps, text, accountName);
  if (!r) return null;
  const given = r.roster[0];
  if (given.relationship === "self" && roster.some((p) => p.relationship === "self")) return null;
  roster[pending.index] = { ...given, name: given.name || pending.person.name };
  return { fields: dataFromRoster(roster), ack: `${given.relationship === "self" ? "You" : personPhrase(given).replace(/^your /, "Your ")}, got it.` };
}

async function readRecipientName(deps: FamilyIntakeDeps, text: string, d: Data): Promise<StepResult | null> {
  const roster = rosterFromData(d);
  const pending = currentPending(d);
  if (!pending || pending.kind !== "name") return null;
  const raw = await deps.parseWithClaude("Extract the person's name as given (first and last if shared). Reply with just the name, or unknown.", text);
  const name = raw.trim();
  if (!name || name.toLowerCase() === "unknown" || name === "__parse_error__") return null;
  roster[pending.index] = { ...pending.person, name };
  return { fields: dataFromRoster(roster), ack: `${name}, got it.` };
}

async function readRecipientKind(deps: FamilyIntakeDeps, text: string, d: Data): Promise<StepResult | null> {
  const roster = rosterFromData(d);
  const pending = currentPending(d);
  if (!pending || pending.kind !== "kind") return null;
  const q = pending.person.kindUnknown ? "Is this person a child, or an adult son or daughter?" : OTHER_KIND_QUESTION;
  const raw = await deps.parseWithClaude(`The family was asked "${q}". Reply exactly ADULT, CHILD, or unknown.`, text);
  const v = raw.trim().toUpperCase();
  if (v !== "ADULT" && v !== "CHILD") return null;
  if (pending.person.kindUnknown) {
    const { kindUnknown: _k, ...rest } = pending.person;
    roster[pending.index] = { ...rest, relationship: v === "CHILD" ? "child" : "adult child" };
  } else {
    roster[pending.index] = { ...pending.person, careKind: v === "CHILD" ? "child" : "senior" };
  }
  return { fields: dataFromRoster(roster), ack: `${v === "CHILD" ? "A child" : "An adult"}, got it.` };
}

async function readRecipientStage(deps: FamilyIntakeDeps, text: string, d: Data): Promise<StepResult | null> {
  const roster = rosterFromData(d);
  const pending = currentPending(d);
  if (!pending || pending.kind !== "stage") return null;
  const raw = await deps.parseWithClaude(
    `The family was asked the child's ${STAGE_HEADING.toLowerCase()}: ${AGE_RANGES.map((a) => a.label).join(", ")}. Reply with exactly one of those labels, or unknown.`,
    text,
  );
  const stage = ageRangeFromWords(raw) ?? ageRangeFromWords(text);
  if (!stage) return null;
  roster[pending.index] = { ...pending.person, ageRange: stage };
  return { fields: dataFromRoster(roster), ack: `${ageRangeLabel(stage)}, got it.` };
}

/** The site's "How many people need care?" counter, by text: "Is there anyone else who needs care? Reply NO, or tell me who." */
async function readMorePeople(deps: FamilyIntakeDeps, text: string, d: Data, accountName: { first: string; last: string }): Promise<StepResult | null> {
  const roster = rosterFromData(d);
  const norm = text.trim().toUpperCase();
  // The question offers NO outright (strict binary reply); YES means "someone else" — ask who.
  if (norm === "NO" || norm === "NO." || norm === "NOPE") {
    return { fields: { ...dataFromRoster(roster), rosterCountConfirmed: true, rosterAddPending: null }, ack: "Nobody else, got it." };
  }
  if (norm === "YES" || norm === "YES." || norm === "YEAH" || norm === "YEP") {
    return { fields: { rosterAddPending: true }, ack: "" };
  }
  // People named ("myself", "my dad too", "adult child too") are ADDED — read first, never judged as
  // chit-chat. The cycle stays open: after this person's details, "anyone else?" is asked again.
  const named = await readRoster(deps, text, accountName).catch(() => null);
  if (named) {
    const added = named.roster.filter((x) => !(x.relationship === "self" && roster.some((q) => q.relationship === "self")));
    const next = [...roster, ...added].slice(0, MAX_RECIPIENTS);
    return { fields: { ...dataFromRoster(next), rosterCountConfirmed: next.length >= MAX_RECIPIENTS ? true : null, rosterAddPending: null }, ack: rosterAck(next) };
  }
  const raw = await deps.parseWithClaude(
    `The family was asked "Is there anyone else who needs care? Reply NO, or tell me who." Reply with raw JSON {"count":0,"others":"the OTHER people named, copied from their words, or empty"} — a plain NO / "just her" / "only me" means nobody else: reply {"count":1,"others":""}; if they gave a total number of people (1 to ${MAX_RECIPIENTS}) put it in count; if they named who else, put that phrase in others.`,
    text,
  );
  let p: { count?: unknown; others?: unknown };
  try { p = JSON.parse(raw); } catch { return null; }
  const others = String(p.others ?? "").trim();
  if (others) {
    const r = await readRoster(deps, others, accountName);
    if (!r) return null;
    const added = r.roster.filter((x) => !(x.relationship === "self" && roster.some((q) => q.relationship === "self")));
    const next = [...roster, ...added].slice(0, MAX_RECIPIENTS);
    return { fields: { ...dataFromRoster(next), rosterCountConfirmed: next.length >= MAX_RECIPIENTS ? true : null, rosterAddPending: null }, ack: rosterAck(next) };
  }
  const count = smallCount(p.count, MAX_RECIPIENTS);
  if (count === null) return null;
  const next = [...roster];
  while (next.length < count) next.push({ relationship: "unknown", name: "" });
  return { fields: { ...dataFromRoster(next), rosterCountConfirmed: true, rosterAddPending: null }, ack: count === 1 ? "Nobody else, got it." : `${count} people, got it.` };
}

async function readProvidersCount(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null> {
  const raw = await deps.parseWithClaude(`The family was asked how many care providers they need (1 to ${MAX_PROVIDERS}). Reply with just the number ("one is fine" = 1), or unknown.`, text);
  const n = smallCount(raw, MAX_PROVIDERS) ?? smallCount(text, MAX_PROVIDERS);
  if (n === null) return null;
  return { fields: { caregiversNeeded: n }, ack: `${n} care provider${n === 1 ? "" : "s"}, got it.` };
}

async function readEmergency(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null | { error: string } | { question: true }> {
  const raw = await deps.parseWithClaude(
    'The family was asked for their emergency contact\'s name and phone number. ' +
    'Reply with raw JSON {"kind":"answer","name":"","phone":"","relationship":""}. ' +
    'kind is "question" when the message asks something or is confused about why it is being asked ("what is this for", "why do you need that"); ' +
    'kind is "none" when they say they have nobody to give or decline ("dont have one", "no one"); otherwise "answer". ' +
    'For an answer the message is almost always the NAME — initials or a short fragment count as the name (e.g. "S m" → name "S m", "mom" → name "mom"). ' +
    'NEVER put a question or a refusal in "name". Leave a value empty when not stated.',
    text,
  );
  try {
    const p = JSON.parse(raw) as { kind?: unknown; name?: unknown; phone?: unknown; relationship?: unknown };
    // A question gets answered and the question re-asked; a refusal gets the reason we need one — neither is ever
    // saved as the contact's name (2026-11-09, fix plan Wave 2: "what is this for" / "dont have one" became a name).
    if (p.kind === "question") return { question: true };
    if (p.kind === "none") return { error: "We do need one person we can call in an emergency. It can be a friend, a neighbor or a relative. Who should we put?" };
    const name = String(p.name ?? "").trim();
    const phone = formatWizardPhone(p.phone);
    const relationship = String(p.relationship ?? "").trim();
    if (!name && !phone) {
      // The model judged this an ANSWER but returned nothing: a few letters with no digits is initials or a short
      // name ("S m"). Only ever for an answer — never a guess from a question or a refusal.
      const t = text.trim();
      if (/^[A-Za-z][A-Za-z .'\-]{0,40}$/.test(t) && t.split(/\s+/).length <= 4) return { fields: { emergencyContactName: t }, ack: `${t}, got it.` };
      return null;
    }
    const fields: Data = { ...(name ? { emergencyContactName: name } : {}), ...(phone ? { emergencyContactPhone: phone } : {}), ...(relationship ? { emergencyContactRelationship: relationship } : {}) };
    return { fields, ack: `${[name, phone].filter(Boolean).join(", ")}, got it.` };
  } catch { return null; }
}

async function readEmergencyPhone(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null> {
  const raw = await deps.parseWithClaude("Extract the phone number from this message. Reply with just the digits, or unknown.", text);
  const phone = formatWizardPhone(raw) ?? formatWizardPhone(text);
  if (!phone) return null;
  return { fields: { emergencyContactPhone: phone }, ack: `${phone}, got it.` };
}

async function readEmergencyRelationship(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null> {
  const raw = await deps.parseWithClaude("The family was asked how their emergency contact is related to the person needing care (son, daughter, sibling, neighbor, friend…). Reply with that relationship in one or two words, or unknown.", text);
  const v = raw.trim();
  if (!v || v.toLowerCase() === "unknown" || v === "__parse_error__") return null;
  return { fields: { emergencyContactRelationship: v }, ack: `${v.charAt(0).toUpperCase() + v.slice(1)}, got it.` };
}

async function readNeeds(deps: FamilyIntakeDeps, text: string, d: Data): Promise<StepResult | null> {
  const existing = Array.isArray(d.careNeeds) ? (d.careNeeds as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const offeredNow = rosterKinds(d);
  const followUp = careListsNotYetOffered(d).length > 0;
  const raw = await deps.parseWithClaude(
    'The family was asked what type of care is needed and may name several things. Reply with raw JSON {"needs":["each thing they named, in their words"],"none":false} — none true when they said none / nothing / no (on a follow-up list); {"needs":[]} if nothing is named.',
    text,
  );
  let needsWords: string[] = []; let none = false;
  try { const p = JSON.parse(raw) as { needs?: unknown; none?: unknown }; needsWords = Array.isArray(p.needs) ? (p.needs as unknown[]).map(String) : []; none = p.none === true; } catch { needsWords = [text]; }
  if (followUp && none && !needsWords.length) {
    return { fields: { careNeedsKindsOffered: offeredNow }, ack: "Nothing more, got it." };
  }
  if (!needsWords.length) needsWords = [text];
  // Whose post this is decides the names ("bathing" on a child-care post is Bathing & Dressing — live 2026-10-26).
  const c = await deps.canonicalizeCareNeeds(needsWords, { kinds: offeredNow });
  if (!c.careNeeds.length) return null;
  const merged = followUp ? Array.from(new Set([...existing, ...c.careNeeds])) : c.careNeeds;
  const notes: string[] = [];
  if (c.medical.length) notes.push(`${c.medical.join(", ")} is medical care, which care providers here don't do, so I left it off — the closest service is Medication Reminders Only (reminding when it's time, not giving them).`);
  const unmapped = c.unmapped.filter((w) => !c.careNeeds.some((n) => n.toLowerCase().includes(w.toLowerCase()) || w.toLowerCase().includes(n.toLowerCase())));
  if (unmapped.length) notes.push(`${unmapped.join(", ")} isn't one of the services on the list, so I left it off.`);
  return { fields: { careNeeds: merged, careNeedsKindsOffered: offeredNow }, ack: `${c.careNeeds.map(serviceLabel).join(", ")}, got it.${notes.length ? " " + notes.join(" ") : ""}` };
}

/** The site's two checkboxes under the care types (optional, default unchecked). */
async function readPetsSmoking(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null> {
  const raw = await deps.parseWithClaude(
    'The family was asked two yes/no things: are there pets in the home, and does anyone in the household smoke. Reply with raw JSON {"pets":true|false|null,"smoking":true|false|null}. A plain "no" / "neither" / "none" / "no and no" answers BOTH with false; "yes" alone answers both with true; null only when a thing is genuinely not addressed.',
    text,
  );
  let p: { pets?: unknown; smoking?: unknown };
  try { p = JSON.parse(raw); } catch { return null; }
  if (typeof p.pets !== "boolean" && typeof p.smoking !== "boolean") return null;
  const pets = p.pets === true, smoking = p.smoking === true; // the site's checkboxes default unchecked
  const ack = [`${pets ? "Pets in the home" : "No pets"}`, `${smoking ? "someone smokes" : "no smoking"}`].join(", ") + ", got it.";
  return { fields: { petsInHome: pets, smokingHousehold: smoking, householdAsked: true }, ack };
}

async function readRate(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null> {
  const raw = await deps.parseWithClaude("The family was asked what they'd like to pay per hour. Reply with just the number of dollars per hour (no symbol), or unknown.", text);
  const n = coerceClientRate(raw) ?? coerceClientRate(text);
  if (n === null) return null;
  return { fields: { rate: n }, ack: `$${n}/hr, got it.` };
}

async function readDescription(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null | { error: string } | { question: true }> {
  const raw = await deps.parseWithClaude("The family was asked what else care providers should know about the job, or to say skip. Reply exactly SKIP if they declined / have nothing to add, QUESTION if they asked something about the process instead of describing the job, otherwise reply TEXT (anything they say about the job, the person, or what they're looking for IS the note).", text);
  if (raw.trim().toUpperCase() === "SKIP") return { fields: { descriptionSkipped: true }, ack: "No problem, we'll leave that blank." };
  if (raw.trim().toUpperCase() === "QUESTION") return { question: true };
  const t = text.trim();
  if (t.length > JOB_DESCRIPTION_MAX_CHARS) return { error: `That's ${t.length.toLocaleString("en-US")} characters and the job details hold up to ${JOB_DESCRIPTION_MAX_CHARS.toLocaleString("en-US")}. Could you send a shorter version?` };
  if (deps.isMedicationInstruction(t)) return { error: deps.medicationMessage };
  if (containsContactDetails(t)) return { error: CONTACT_DETAILS_MESSAGE }; // 2026-11-09: no phone, email or link in the public details
  return { fields: { jobDescription: t }, ack: "Got it, I saved that." };
}

async function readEmail(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null> {
  const raw = await deps.parseWithClaude("Extract the email address from this message. Reply with just the email, or unknown.", text);
  const v = raw.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(v)) return null;
  return { fields: { email: v }, ack: "Email saved, got it." };
}

// ── Corrections / front-loading: other fields stated in the same message ─────
// One extraction over the whole schema (the model reads; the code validates),
// applied as OVERWRITES so a changed answer wins — except the field of the step
// being answered (its own reader owns it) and the roster (readRoster owns it).
export async function extractOtherFields(deps: FamilyIntakeDeps, text: string, currentStep: FamilyStep, accountName: { first: string; last: string }, d: Data = {}): Promise<{ fields: Data; roster?: RosterPerson[]; capped?: boolean; rosterMode?: "add" | "replace"; people?: Data }> {
  const t = deps.today();
  const raw = await deps.parseWithClaude(
    `Today is ${t.weekday}, ${t.iso}. The family is partway through setting up care by text and was just asked: "${familyQuestionLabel(currentStep)}". ` +
      "Besides the answer to that question, extract ONLY other details they clearly stated or changed in this message, as raw JSON with any of: " +
      '{"careFrequency":"occasional|part_time|full_time","homeStreet":"","homeZipCode":"","sameAsHomeAddress":true,"street":"the CARE address street when it differs from home","zipCode":"","startDate":"YYYY-MM-DD or ASAP","ongoing":true,"endDate":"YYYY-MM-DD","selectedDays":["MON"],"daysFlexible":false,"timeOfDay":["morning"],' +
      '"emergencyContactName":"","emergencyContactPhone":"","emergencyContactRelationship":"","careNeeds":["their words"],"rate":0,"email":"","caregiversNeeded":0,"petsInHome":true,"smokingHousehold":false,' +
      '"recipients":"ONLY if they say WHO the care is for (e.g. me and my child, my mom): copy that phrase here","recipientsMode":"add if they ADD someone to the people already listed (add / also / too / as well), replace if they restate who the care is for",' +
      '"people":{"rename":{"from":"the listed person\'s current name or relationship","to":"new name"},"stage":{"who":"name or relationship","stage":"Infant|Toddler|Preschooler|School-age|Teen"},"relationship":{"who":"name","to":"parent|spouse|adult child|child|other"},"remove":"name or relationship of a listed person to take off"}}. ' +
      'A change to a person ALREADY listed (their name, stage, relationship, or taking them off) is "people", never "recipients". ' +
      'If they say two listed people are the SAME person, or one is a duplicate, that is people.remove of the duplicate (the one WITHOUT a name when only one has a name; otherwise the one they name), never a rename. ' +
      "Omit everything not clearly stated. No markdown.",
    text,
  ).catch(() => "{}");
  let p: Data = {};
  try { p = JSON.parse(raw) as Data; } catch { return { fields: {} }; }
  const fields: Data = {};
  const skip = new Set<string>(fieldsOwnedBy(currentStep));
  const freq = normalizeFrequency(p.careFrequency); if (freq && !skip.has("careFrequency")) fields.careFrequency = freq;
  if (typeof p.homeStreet === "string" && p.homeStreet.trim() && !skip.has("homeStreet")) fields.homeStreet = p.homeStreet.trim();
  if (isValidZip(p.homeZipCode) && !skip.has("homeZipCode")) {
    fields.homeZipCode = String(p.homeZipCode).trim();
    const pl = await deps.lookupZipPlace(fields.homeZipCode as string).catch(() => null);
    if (pl) { fields.homeCity = pl.city; fields.homeState = pl.state; }
  }
  // The care address (2026-10-21): "same as home", or a different street / ZIP; and when the home
  // address changes while care is at home, the care address follows it (the site stores both).
  if (p.sameAsHomeAddress === true && !skip.has("street")) {
    Object.assign(fields, { sameAsHomeAddress: true, street: fields.homeStreet ?? d.homeStreet ?? null, zipCode: fields.homeZipCode ?? d.homeZipCode ?? null, city: fields.homeCity ?? d.homeCity ?? null, state: fields.homeState ?? d.homeState ?? null });
  }
  if (typeof p.street === "string" && p.street.trim() && !skip.has("street")) { fields.street = p.street.trim(); fields.sameAsHomeAddress = false; }
  if (isValidZip(p.zipCode) && !skip.has("zipCode")) {
    fields.zipCode = String(p.zipCode).trim(); fields.sameAsHomeAddress = false;
    const pl = await deps.lookupZipPlace(fields.zipCode as string).catch(() => null);
    if (pl) { fields.city = pl.city; fields.state = pl.state; }
  }
  if ((fields.homeStreet !== undefined || fields.homeZipCode !== undefined) && fields.sameAsHomeAddress === undefined && d.sameAsHomeAddress === true && !skip.has("street")) {
    Object.assign(fields, { street: fields.homeStreet ?? d.homeStreet ?? null, zipCode: fields.homeZipCode ?? d.homeZipCode ?? null, city: fields.homeCity ?? d.homeCity ?? null, state: fields.homeState ?? d.homeState ?? null });
  }
  const start = normalizeStartDateToISO(p.startDate, t.iso); if (start && !skip.has("startDate")) fields.startDate = start;
  if (p.ongoing === true && !skip.has("ongoing")) { fields.ongoing = true; fields.endDate = null; }
  const end = normalizeStartDateToISO(p.endDate, t.iso); if (end && !skip.has("endDate")) { fields.endDate = end; fields.ongoing = false; }
  const days = normalizeDayCodes(p.selectedDays); if (days.length && !skip.has("selectedDays")) { fields.selectedDays = days; fields.daysFlexible = false; }
  if (p.daysFlexible === true && !skip.has("daysFlexible")) { fields.daysFlexible = true; fields.selectedDays = []; }
  const clockParts = timeOfDayFromClock(text);
  const tod = clockParts.length ? mapTimeOfDayToWizardValues(clockParts) : mapTimeOfDayToWizardValues(p.timeOfDay); if (tod.length && !skip.has("timeOfDay")) fields.timeOfDay = tod;
  if (typeof p.emergencyContactName === "string" && p.emergencyContactName.trim() && !skip.has("emergencyContactName")) fields.emergencyContactName = p.emergencyContactName.trim();
  const ePhone = formatWizardPhone(p.emergencyContactPhone); if (ePhone && !skip.has("emergencyContactPhone")) fields.emergencyContactPhone = ePhone;
  if (typeof p.emergencyContactRelationship === "string" && p.emergencyContactRelationship.trim() && !skip.has("emergencyContactRelationship")) fields.emergencyContactRelationship = p.emergencyContactRelationship.trim();
  const rate = coerceClientRate(p.rate); if (rate !== null && !skip.has("rate")) fields.rate = rate;
  const providers = smallCount(p.caregiversNeeded, MAX_PROVIDERS); if (providers !== null && !skip.has("caregiversNeeded")) fields.caregiversNeeded = providers;
  if (typeof p.petsInHome === "boolean" && !skip.has("petsInHome")) fields.petsInHome = p.petsInHome;
  if (typeof p.smokingHousehold === "boolean" && !skip.has("smokingHousehold")) fields.smokingHousehold = p.smokingHousehold;
  if (typeof p.email === "string" && /^\S+@\S+\.\S+$/.test(p.email.trim()) && !skip.has("email")) fields.email = p.email.trim().toLowerCase();
  if (Array.isArray(p.careNeeds) && p.careNeeds.length && !skip.has("careNeeds")) {
    const c = await deps.canonicalizeCareNeeds(p.careNeeds, { kinds: rosterKinds(d) }).catch(() => ({ careNeeds: [] as string[], medical: [], unmapped: [] }));
    if (c.careNeeds.length) fields.careNeeds = c.careNeeds;
  }
  let roster: RosterPerson[] | undefined; let capped: boolean | undefined;
  const rosterMode: "add" | "replace" = String(p.recipientsMode ?? "").trim().toLowerCase() === "add" ? "add" : "replace";
  if (typeof p.recipients === "string" && p.recipients.trim() && !skip.has("relationship")) {
    const r = await readRoster(deps, p.recipients, accountName).catch(() => null);
    if (r) { roster = r.roster; capped = r.capped; }
  }
  const people = p.people && typeof p.people === "object" && !skip.has("relationship") ? (p.people as Data) : undefined;
  return { fields, ...(roster ? { roster, capped, rosterMode } : {}), ...(people ? { people } : {}) };
}

const ROSTER_FIELDS = ["relationship", "seniorName", "additionalRecipients", "careKind", "ageRange", "primaryKindUnknown", "rosterCountConfirmed", "rosterAddPending"];

/** The fields a step's own reader writes (never overwritten by the side extraction). */
export function fieldsOwnedBy(step: FamilyStep): string[] {
  switch (step) {
    case "family_ask_name": return ["firstName", "lastName"];
    case "family_ask_frequency": return ["careFrequency"];
    case "family_ask_home_address": return ["homeStreet", "homeZipCode"];
    case "family_ask_care_address": return ["street", "zipCode"];
    case "family_ask_start": return ["startDate"];
    case "family_ask_ongoing": return ["ongoing", "endDate"];
    case "family_ask_days": return ["selectedDays", "daysFlexible", "timeOfDay"];
    case "family_ask_photo": return [];
    case "family_ask_recipients": case "family_ask_recipient_relationship": case "family_ask_recipient_name": case "family_ask_recipient_kind": case "family_ask_recipient_stage": case "family_ask_more_people": return ROSTER_FIELDS;
    case "family_ask_providers_count": return ["caregiversNeeded"];
    case "family_ask_emergency": return ["emergencyContactName", "emergencyContactPhone", "emergencyContactRelationship"];
    case "family_ask_emergency_phone": return ["emergencyContactPhone"];
    case "family_ask_emergency_relationship": return ["emergencyContactRelationship"];
    case "family_ask_needs": return ["careNeeds", "careNeedsKindsOffered"];
    case "family_ask_pets_smoking": return ["petsInHome", "smokingHousehold"];
    case "family_ask_rate": return ["rate"];
    case "family_ask_description": return ["jobDescription"];
    case "family_ask_email": return ["email"];
  }
}

/** A short label of the current question for the side-extraction prompt. */
export function familyQuestionLabel(step: FamilyStep): string {
  switch (step) {
    case "family_ask_name": return "their first and last name";
    case "family_ask_frequency": return "how often they need care";
    case "family_ask_home_address": return "their home address";
    case "family_ask_care_address": return "whether care is at the same address";
    case "family_ask_start": return "when care should start";
    case "family_ask_ongoing": return "whether it is ongoing or has an end date";
    case "family_ask_days": return "which days and time of day";
    case "family_ask_photo": return "a profile photo or skip";
    case "family_ask_recipients": return "their relationship to the person needing care";
    case "family_ask_recipient_relationship": return "their relationship to another care recipient";
    case "family_ask_recipient_name": return "a care recipient's name";
    case "family_ask_recipient_kind": return "whether the person is a child or an adult";
    case "family_ask_recipient_stage": return "a child's stage";
    case "family_ask_more_people": return "whether anyone else needs care";
    case "family_ask_providers_count": return "how many care providers they need";
    case "family_ask_emergency": return "the emergency contact's name and phone";
    case "family_ask_emergency_phone": return "the emergency contact's phone";
    case "family_ask_emergency_relationship": return "how the emergency contact is related";
    case "family_ask_needs": return "what type of care is needed";
    case "family_ask_pets_smoking": return "pets in the home and smoking";
    case "family_ask_rate": return "the hourly rate";
    case "family_ask_description": return "what else care providers should know";
    case "family_ask_email": return "their email";
  }
}

export function isRosterStep(step: FamilyStep): boolean {
  return ["family_ask_recipients", "family_ask_recipient_relationship", "family_ask_recipient_name", "family_ask_recipient_kind", "family_ask_recipient_stage", "family_ask_more_people"].includes(step);
}

// ── The turn ─────────────────────────────────────────────────────────────────
const WORDS_FOR_SIDE_EXTRACTION = 6; // a length check, not intent parsing (the model still reads the words)

export async function runFamilyIntakeTurn(deps: FamilyIntakeDeps, turn: FamilyIntakeTurn): Promise<void> {
  const { phone, chatId, session } = turn;
  const text = turn.text ?? "";
  let d = await effectiveFamilyData(deps, session);
  const step = nextFamilyStep(d);
  if (!step) { await deps.sendRecap(phone, chatId); return; }
  const question = familyQuestion(step, d);
  const accountName = { first: String(d.firstName ?? "").trim(), last: String(d.lastName ?? "").trim() };

  // 0. Resume: re-ask the current question, never parse the sentinel.
  if (text === "__RESUME__" || text.trim() === "") {
    await deps.updateSession(phone, { onboardingStep: step });
    await deps.sendMessage(chatId, question);
    return;
  }

  // 1. Read this step's answer FIRST (live 2026-10-21: "yes", "myself", "this is for
  //    my child" were judged "a question or other" by the model and answered with
  //    prose instead of being read). A real answer always wins; only when nothing
  //    reads as an answer does the side-question path run.
  let result: StepResult | null | { error: string } | { question: true } = null;
  let rosterCapped = false;
  switch (step) {
    case "family_ask_name": result = await readName(deps, text); break;
    case "family_ask_frequency": result = await readFrequency(deps, text); break;
    case "family_ask_home_address": result = await readHomeAddress(deps, text, d); break;
    case "family_ask_care_address": result = await readCareAddress(deps, text, d); break;
    case "family_ask_start": result = await readStart(deps, text); break;
    case "family_ask_ongoing": result = await readOngoing(deps, text); break;
    case "family_ask_days": result = await readDays(deps, text, d); break;
    case "family_ask_photo": result = await readPhotoSkip(deps, text); break;
    case "family_ask_recipients": {
      const r = await readRoster(deps, text, accountName);
      if (r) {
        // Several people named at once = the count is known (the site's counter, answered in one go).
        result = { fields: { ...dataFromRoster(r.roster), rosterCountConfirmed: r.roster.length > 1 ? true : null }, ack: rosterAck(r.roster) };
        rosterCapped = r.capped;
      }
      break;
    }
    case "family_ask_recipient_relationship": result = await readRecipientRelationship(deps, text, d, accountName); break;
    case "family_ask_recipient_name": result = await readRecipientName(deps, text, d); break;
    case "family_ask_recipient_kind": result = await readRecipientKind(deps, text, d); break;
    case "family_ask_recipient_stage": result = await readRecipientStage(deps, text, d); break;
    case "family_ask_more_people": result = await readMorePeople(deps, text, d, accountName); break;
    case "family_ask_providers_count": result = await readProvidersCount(deps, text); break;
    case "family_ask_emergency": result = await readEmergency(deps, text); break;
    case "family_ask_emergency_phone": result = await readEmergencyPhone(deps, text); break;
    case "family_ask_emergency_relationship": result = await readEmergencyRelationship(deps, text); break;
    case "family_ask_needs": result = await readNeeds(deps, text, d); break;
    case "family_ask_pets_smoking": result = await readPetsSmoking(deps, text); break;
    case "family_ask_rate": result = await readRate(deps, text); break;
    case "family_ask_description": result = await readDescription(deps, text); break;
    case "family_ask_email": result = await readEmail(deps, text); break;
  }
  if (result && "error" in result) { await deps.sendMessage(chatId, result.error); return; }
  const stepRead = result && !("question" in result) ? result : null;

  // 2. Other fields in the same message (front-loading or a correction) — overwrite.
  const fields: Data = { ...(stepRead?.fields ?? {}) };
  const acks: string[] = stepRead ? [stepRead.ack].filter(Boolean) : [];
  // Runs for a longer message, and ALWAYS when the step read nothing — a short correction
  // ("make it full time", "change to Mondays") at any step is still applied (2026-10-21).
  if (!stepRead || text.trim().split(/\s+/).length >= WORDS_FOR_SIDE_EXTRACTION) {
    const other: { fields: Data; roster?: RosterPerson[]; capped?: boolean; rosterMode?: "add" | "replace"; people?: Data } = await extractOtherFields(deps, text, step, accountName, d).catch(() => ({ fields: {} }));
    for (const [k, v] of Object.entries(other.fields)) if (!(k in fields)) fields[k] = v;
    if (other.roster && !isRosterStep(step)) {
      // "add my dad" mid-flow ADDS; "it's for me and my child" restates (replaces).
      const existing = rosterFromData(d);
      const next = other.rosterMode === "add" && existing.length
        ? [...existing, ...other.roster.filter((x) => !(x.relationship === "self" && existing.some((q) => q.relationship === "self")))].slice(0, MAX_RECIPIENTS)
        : other.roster;
      Object.assign(fields, dataFromRoster(next), { rosterCountConfirmed: other.rosterMode === "add" ? (d.rosterCountConfirmed === true ? true : null) : (next.length > 1 ? true : null) });
      acks.push(rosterAck(next));
      if (other.capped) rosterCapped = true;
    }
    if (other.people && !other.roster && !isRosterStep(step)) {
      // The recap's people applier (rename / stage / relationship / remove; never the account holder's
      // own name, never the last person). Loaded here, not at the top: the two modules import each other.
      const { applyRecapEdit } = await import("./familyRecapEdits");
      const pe = await applyRecapEdit(deps, { ...d, ...fields }, { people: other.people }).catch(() => null);
      if (pe) {
        Object.assign(fields, pe.fields);
        const said = pe.notes.filter(Boolean).join("; ");
        if (said) acks.push(`${said.charAt(0).toUpperCase()}${said.slice(1)}.`);
        if (pe.ask) acks.push(`${pe.ask} Tell me by name and I'll change it.`);
      }
    }
  }

  // 3. Nothing read as an answer: a side question is answered and the current
  //    question re-asked (no write); anything else gets a plain re-ask.
  if (!Object.keys(fields).length) {
    const isQuestion = (result && "question" in result) || await deps.isQuestionOrOther(text, question);
    console.info("familyIntake turn", { step, read: "none", question: isQuestion });
    if (isQuestion) {
      const answer = await deps.answerQuestionMidFlow(text, session, phone);
      await deps.sendMessage(chatId, `${answer}\n\n${question}`);
      return;
    }
    await deps.updateSession(phone, { onboardingStep: step });
    await deps.sendMessage(chatId, `Sorry, I didn't catch that. ${question}`);
    return;
  }

  // 4. Save (mirrors to the site record) and gate the service area on an address.
  console.info("familyIntake turn", { step, read: stepRead ? "answer" : "side", keys: Object.keys(fields) });
  await deps.mergeOnboardingData(phone, fields);
  d = { ...d, ...fields };
  if (fields.zipCode !== undefined || fields.homeZipCode !== undefined || fields.sameAsHomeAddress === true) {
    const careZip = String((d.sameAsHomeAddress === true ? d.homeZipCode : d.zipCode) ?? "");
    const careCity = String((d.sameAsHomeAddress === true ? d.homeCity : d.city) ?? "");
    if (careZip && deps.evaluateServiceArea({ zip: careZip, city: careCity }) === "out") {
      await deps.parkOutOfArea({ phone, role: "client", city: careCity, zipCode: careZip, name: accountName.first || undefined, onboardingData: d });
      await deps.sendMessage(chatId, `Thanks so much${accountName.first ? ` ${accountName.first}` : ""} — I want to be upfront: right now Evia only serves Santa Clara County, California, so I'm not able to set up care in ${careCity || careZip} just yet. I've added you to our waitlist and we'll reach out the moment we expand to your area.`);
      return;
    }
  }

  // 5. Next question = the first still-unanswered step; none left → the recap, in
  //    ONE message with the ack (two sends can arrive out of order over SMS).
  const next = nextFamilyStep(d);
  const capNote = rosterCapped ? ` I can set up care for up to ${MAX_RECIPIENTS} people, like the site, so I kept the first ${MAX_RECIPIENTS}.` : "";
  const ackLine = `${acks.join(" ")}${capNote}`.trim();
  if (!next) {
    await deps.sendRecap(phone, chatId, ackLine || undefined);
    return;
  }
  await deps.updateSession(phone, { onboardingStep: next });
  await deps.sendMessage(chatId, `${ackLine ? ackLine + " " : ""}${familyQuestion(next, d)}`);
}

/** "you (Light Housekeeping) and Mahad K, your child · Toddler" — every person, for the recap. */
export function describeRoster(d: Data): string {
  const roster = rosterFromData(d);
  if (!roster.length) return String(d.seniorName ?? "your loved one");
  const words = roster.map((p) => {
    if (p.relationship === "self") return "you";
    const rel = p.relationship === "adult child" ? "your adult child" : p.relationship === "other" ? (p.careKind === "child" ? "a child" : "") : p.relationship === "unknown" ? "" : `your ${p.relationship}`;
    const stage = isChildPerson(p) && p.ageRange ? ageRangeLabel(p.ageRange) : "";
    const tail = [rel, stage].filter(Boolean).join(" · ");
    return `${p.name || personPhrase(p)}${tail ? ` (${tail})` : ""}`;
  });
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
