// ── The family intake as ONE process that follows the site (2026-10-20) ──────
//
// Founder, after a text test in which "me and my child" became an adult-or-child
// question about him, the correction was dropped, and the confirm step appended
// his words to the job description: "can there be one process that follows the
// site … make sure that works well and correct."
//
// This module IS the family questionnaire by text: the site wizard's steps, in
// the site's order, one question per turn, with fixed wording. The model does two
// things only — it reads each answer into the field's value (parseWithClaude) and
// it answers a side question before the current question is re-asked. It never
// decides what to ask next and never writes a question.
//
//   site step  → text step
//   2  frequency              family_ask_frequency
//   3  home address           family_ask_home_address        (ZIP → city/state like the site)
//   4  care address           family_ask_care_address        (same address? / another; service-area gate)
//   5  start date             family_ask_start, family_ask_ongoing
//   6  days + time            family_ask_days
//   8  photo (optional)       family_ask_photo
//   9  relationship(s)        family_ask_recipients          (one to FOUR people, read as a list)
//   10 names / stages         family_ask_recipient_name / _kind / _stage   (one person at a time, by name)
//   11 emergency contact      family_ask_emergency, _emergency_phone, _emergency_relationship
//   12 care types             family_ask_needs               (the lists for the people on the roster)
//   13 rate                   family_ask_rate
//   14 description            family_ask_description         (cap, never cut; medication refused)
//   /start email              family_ask_email               (only when the site didn't collect it)
//   → client_confirm_intake   (the existing recap + confirm handler)
//
// The next question is always the FIRST UNANSWERED step computed from the live
// data — the site record (job_postings / users, read before every turn) under the
// text draft — so answers given on the site are never asked again, front-loaded
// answers skip ahead, and a correction at any step simply changes the data.
//
// Everything saved goes through mergeOnboardingData, which mirrors each field to
// job_postings/{uid} as it lands, so the site shows it while the text is going.
//
// Pure parts (step order, next step, roster rules, questions, value validation)
// are exported for tests; every side effect arrives through FamilyIntakeDeps.
import {
  AGE_RANGES, STAGE_HEADING, OTHER_KIND_QUESTION, ageRangeFromWords, ageRangeLabel, stageQuestion,
  recipientCareKind, rosterCareKinds, serviceMenuText, serviceLabel, JOB_DESCRIPTION_MAX_CHARS,
} from "./caregiverServiceLabels";
import { coerceClientRate, isFieldFilled, FAMILY_STEP_ORDER, FAMILY_STEP_IDS } from "./onboardingContract";
import { normalizeStartDateToISO, formatWizardPhone, mapTimeOfDayToWizardValues } from "./clientJobPostingContract";

// ── Step ids (in the site's order; the list itself lives in onboardingContract.ts) ──
export { FAMILY_STEP_ORDER, FAMILY_STEP_IDS };
export type FamilyStep = (typeof FAMILY_STEP_ORDER)[number];
export function isFamilyScriptStep(step: unknown): step is FamilyStep {
  return typeof step === "string" && (FAMILY_STEP_IDS as readonly string[]).includes(step);
}

/** The site allows one to four people on a post. */
export const MAX_RECIPIENTS = 4;

type Data = Record<string, unknown>;

// ── Roster model ─────────────────────────────────────────────────────────────
// Evia's internal relationship words (the website's are mapped at the boundary by
// careRecipients.toWebsiteRelationship: self → myself; the rest pass through).
export type RosterRelationship = "self" | "parent" | "spouse" | "adult child" | "child" | "other";
export const ROSTER_RELATIONSHIPS: readonly RosterRelationship[] = ["self", "parent", "spouse", "adult child", "child", "other"];

export interface RosterPerson {
  relationship: RosterRelationship;
  /** First (and last) name as given; "" until asked. Self carries the account name. */
  name: string;
  /** Only for "other": the site's two-way pick. */
  careKind?: "senior" | "child";
  /** Only for a child: one AGE_RANGES id. */
  ageRange?: string;
}

export function normalizeRelationship(value: unknown): RosterRelationship | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (["self", "myself", "me", "i"].includes(v)) return "self";
  if (["parent", "mother", "father", "mom", "dad", "mum", "stepmother", "stepfather", "parents"].includes(v)) return "parent";
  if (["spouse", "spouse or partner", "partner", "wife", "husband"].includes(v)) return "spouse";
  if (["adult child", "adult son", "adult daughter", "grown son", "grown daughter", "grown child"].includes(v)) return "adult child";
  if (["child", "son", "daughter", "kid", "baby", "toddler", "infant", "teen", "teenager"].includes(v)) return "child";
  if (["other", "grandparent", "grandmother", "grandfather", "sibling", "brother", "sister", "friend", "neighbor", "relative", "aunt", "uncle", "cousin"].includes(v)) return "other";
  return null;
}

/** A person is a child when the relationship says so, or Other was answered "child". */
export function isChildPerson(p: Pick<RosterPerson, "relationship" | "careKind">): boolean {
  const rel = p.relationship === "self" ? "Myself" : p.relationship === "adult child" ? "Adult child" : p.relationship.charAt(0).toUpperCase() + p.relationship.slice(1);
  return recipientCareKind(rel, p.careKind) === "child";
}

/** The roster as stored: primary on the top-level fields, the rest in additionalRecipients. */
export function rosterFromData(d: Data): RosterPerson[] {
  const primaryRel = normalizeRelationship(d.relationship);
  if (!primaryRel) return [];
  const primary: RosterPerson = {
    relationship: primaryRel,
    name: String(d.seniorName ?? "").trim(),
    ...(d.careKind === "child" || d.careKind === "senior" ? { careKind: d.careKind } : {}),
    ...(typeof d.ageRange === "string" && d.ageRange ? { ageRange: d.ageRange } : {}),
  };
  const extra = Array.isArray(d.additionalRecipients) ? (d.additionalRecipients as Array<Record<string, unknown>>) : [];
  const rest: RosterPerson[] = [];
  for (const r of extra) {
    const rel = normalizeRelationship(r?.relationship) ?? "other";
    rest.push({
      relationship: rel,
      name: String(r?.name ?? "").trim(),
      ...(r?.careKind === "child" || r?.careKind === "senior" ? { careKind: r.careKind as "child" | "senior" } : {}),
      ...(typeof r?.ageRange === "string" && r.ageRange ? { ageRange: r.ageRange } : {}),
    });
  }
  return [primary, ...rest];
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
    additionalRecipients: rest.map((r) => ({
      name: r.name,
      relationship: r.relationship,
      ...(r.relationship === "other" && r.careKind ? { careKind: r.careKind } : {}),
      ...(isChildPerson(r) && r.ageRange ? { ageRange: r.ageRange } : {}),
    })),
  };
}

export type RosterPending =
  | { kind: "name"; index: number; person: RosterPerson }
  | { kind: "kind"; index: number; person: RosterPerson }
  | { kind: "stage"; index: number; person: RosterPerson };

/** The first thing still missing on the roster, in person order — the site's step-10 gate. */
export function rosterPending(roster: RosterPerson[]): RosterPending | null {
  for (let i = 0; i < roster.length; i++) {
    const p = roster[i];
    if (!p.name && p.relationship !== "self") return { kind: "name", index: i, person: p };
    if (p.relationship === "other" && !p.careKind) return { kind: "kind", index: i, person: p };
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
    case "child": return "your child";
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
  const pending = rosterPending(roster);
  if (pending) return pending.kind === "name" ? "family_ask_recipient_name" : pending.kind === "kind" ? "family_ask_recipient_kind" : "family_ask_recipient_stage";
  if (!isFieldFilled(d.emergencyContactName)) return "family_ask_emergency";
  if (!isFieldFilled(d.emergencyContactPhone)) return "family_ask_emergency_phone";
  if (!isFieldFilled(d.emergencyContactRelationship)) return "family_ask_emergency_relationship";
  if (!(Array.isArray(d.careNeeds) && (d.careNeeds as unknown[]).length)) return "family_ask_needs";
  if (coerceClientRate(d.rate) === null) return "family_ask_rate";
  if (!isFieldFilled(d.jobDescription) && d.descriptionSkipped !== true) return "family_ask_description";
  if (!isFieldFilled(d.email)) return "family_ask_email";
  return null;
}

// ── Questions: fixed text, the site's words ──────────────────────────────────
export function familyQuestion(step: FamilyStep, d: Data): string {
  const roster = rosterFromData(d);
  const pending = rosterPending(roster);
  switch (step) {
    case "family_ask_name": return "What's your first and last name?";
    case "family_ask_frequency": return "How often do you need care — occasional, part-time, or full-time?";
    case "family_ask_home_address": return "What's your home address? The street and ZIP code is all I need.";
    case "family_ask_care_address": return "Is care needed at that same address? Say yes, or send the care address (street and ZIP).";
    case "family_ask_start": return "When would you like care to start — as soon as possible, or a date?";
    case "family_ask_ongoing": return "Is this ongoing, or is there an end date?";
    case "family_ask_days": return "Which days of the week, and what time of day — morning, afternoon, evening, or overnight? (You can also say the days are flexible.)";
    case "family_ask_photo": return "Want to add a profile photo of yourself? Send a picture here, or say skip.";
    case "family_ask_recipients": return `Who is the care for? For example: my mom, me and my child, or my parents — up to ${MAX_RECIPIENTS} people.`;
    case "family_ask_recipient_name": return pending?.kind === "name" ? `What's ${personPhrase(pending.person)}'s name? First and last is best.` : "Who is the care for?";
    case "family_ask_recipient_kind": return pending?.kind === "kind" ? `${pending.person.name ? pending.person.name + " — " : ""}${OTHER_KIND_QUESTION}` : OTHER_KIND_QUESTION;
    case "family_ask_recipient_stage": return pending?.kind === "stage" ? stageQuestion(pending.person.name || personPhrase(pending.person)) : stageQuestion(null);
    case "family_ask_emergency": return "Who should we contact in case of an emergency? Their name and phone number.";
    case "family_ask_emergency_phone": return `What's ${String(d.emergencyContactName ?? "their")}'s phone number?`;
    case "family_ask_emergency_relationship": {
      const who = roster.length ? (roster[0].relationship === "self" ? "you" : roster[0].name || personPhrase(roster[0])) : "the person needing care";
      return `How is ${String(d.emergencyContactName ?? "that person")} related to ${who}?`;
    }
    case "family_ask_needs": {
      const kinds = rosterCareKinds(roster.map((p) => ({ relationship: p.relationship === "self" ? "Myself" : p.relationship === "adult child" ? "Adult child" : p.relationship, careKind: p.careKind })));
      return `What type of care is needed? Pick as many as apply:\n${serviceMenuText(kinds.length ? kinds : ["senior"])}`;
    }
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

// ── Deps: every side effect, injected ────────────────────────────────────────
export interface FamilyIntakeDeps {
  parseWithClaude: (prompt: string, text: string) => Promise<string>;
  isQuestionOrOther: (text: string, currentQuestion: string) => Promise<boolean>;
  answerQuestionMidFlow: (text: string, session: any, phone: string) => Promise<string>;
  canonicalizeCareNeeds: (terms: unknown) => Promise<{ careNeeds: string[]; medical: string[]; unmapped: string[] }>;
  lookupZipPlace: (zip: string) => Promise<{ city: string; state: string } | null>;
  evaluateServiceArea: (args: { city?: string | null; zip?: string | null }) => "in" | "out" | "need_zip";
  parkOutOfArea: (args: { phone: string; role: "client"; city: string; zipCode: string; name?: string; onboardingData?: Data }) => Promise<void>;
  /** The site record mapped into draft field names (job_postings + users) — read before every turn. */
  loadSiteData: (session: any) => Promise<Data>;
  mergeOnboardingData: (phone: string, fields: Data) => Promise<void>;
  updateSession: (phone: string, updates: Data) => Promise<void>;
  sendMessage: (chatId: string, text: string) => Promise<unknown>;
  /** Park the cursor at client_confirm_intake and send the recap (the existing confirm step). */
  sendRecap: (phone: string, chatId: string) => Promise<void>;
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
  for (const [k, v] of Object.entries(draft)) if (isFieldFilled(v) || typeof v === "boolean") out[k] = v;
  return out;
}

// ── Per-step answer readers (the model reads the value; the code validates it) ──
interface StepResult { fields: Data; ack: string }

async function readName(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null> {
  const raw = await deps.parseWithClaude("Extract the person's own name as given (first and last if shared). Reply with just the name as typed, or unknown.", text);
  const name = raw.trim();
  if (!name || name.toLowerCase() === "unknown" || name === "__parse_error__") return null;
  const [firstName, ...rest] = name.split(/\s+/);
  const lastName = rest.join(" ");
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
  const tod = mapTimeOfDayToWizardValues(p.timeOfDay);
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
  const ack = `${[dayWords, finalTod.join("/")].filter(Boolean).join(", ")}, got it.`;
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

/** "me and my child", "my parents", "mom Dorothy and dad Frank" → a roster (first = primary). */
export async function readRoster(deps: FamilyIntakeDeps, text: string, accountName: { first: string; last: string }): Promise<{ roster: RosterPerson[]; capped: boolean } | null> {
  const raw = await deps.parseWithClaude(
    "The family was asked who the care is for. List EVERY person needing care, in the order mentioned, as raw JSON " +
      '{"people":[{"relationship":"self|parent|spouse|adult child|child|other","name":"first and last if given, else empty","stage":"only for a child when stated: ' +
      AGE_RANGES.map((a) => a.label).join(", ") + '","kind":"only for other when stated: adult|child"}]}. ' +
      'Rules: "me / myself / I" is self. "my child / son / daughter / kid" is child (a GROWN son or daughter is "adult child"). "mom / dad / mother / father" is parent; "my parents" is TWO parents. "wife / husband / partner" is spouse. Anyone else (grandparent, sibling, friend, neighbor) is other. ' +
      'Do not invent people and do not repeat a person. Reply {"people":[]} if nobody is named.',
    text,
  );
  let p: { people?: unknown };
  try { p = JSON.parse(raw); } catch { return null; }
  const people = Array.isArray(p.people) ? (p.people as Array<Record<string, unknown>>) : [];
  const roster: RosterPerson[] = [];
  for (const x of people) {
    const rel = normalizeRelationship(x?.relationship);
    if (!rel) continue;
    const name = rel === "self" ? [accountName.first, accountName.last].filter(Boolean).join(" ") : String(x?.name ?? "").trim();
    const stage = ageRangeFromWords(x?.stage) ?? undefined;
    const kindWord = String(x?.kind ?? "").trim().toLowerCase();
    const careKind = rel === "other" ? (kindWord === "child" ? "child" : kindWord === "adult" ? "senior" : undefined) : undefined;
    if (rel === "self" && roster.some((r) => r.relationship === "self")) continue;
    roster.push({ relationship: rel, name, ...(careKind ? { careKind } : {}), ...(stage && (rel === "child" || careKind === "child") ? { ageRange: stage } : {}) });
  }
  if (!roster.length) return null;
  const capped = roster.length > MAX_RECIPIENTS;
  return { roster: roster.slice(0, MAX_RECIPIENTS), capped };
}

function rosterAck(roster: RosterPerson[]): string {
  const words = roster.map((p) => (p.relationship === "self" ? "you" : p.name || personPhrase(p).replace(/^your /, "your ")));
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return `Care for ${list}, got it.`;
}

async function readRecipientName(deps: FamilyIntakeDeps, text: string, d: Data): Promise<StepResult | null> {
  const roster = rosterFromData(d);
  const pending = rosterPending(roster);
  if (!pending || pending.kind !== "name") return null;
  const raw = await deps.parseWithClaude("Extract the person's name as given (first and last if shared). Reply with just the name, or unknown.", text);
  const name = raw.trim();
  if (!name || name.toLowerCase() === "unknown" || name === "__parse_error__") return null;
  roster[pending.index] = { ...pending.person, name };
  return { fields: dataFromRoster(roster), ack: `${name}, got it.` };
}

async function readRecipientKind(deps: FamilyIntakeDeps, text: string, d: Data): Promise<StepResult | null> {
  const roster = rosterFromData(d);
  const pending = rosterPending(roster);
  if (!pending || pending.kind !== "kind") return null;
  const raw = await deps.parseWithClaude(`The family was asked "${OTHER_KIND_QUESTION}". Reply exactly ADULT, CHILD, or unknown.`, text);
  const v = raw.trim().toUpperCase();
  if (v !== "ADULT" && v !== "CHILD") return null;
  roster[pending.index] = { ...pending.person, careKind: v === "CHILD" ? "child" : "senior" };
  return { fields: dataFromRoster(roster), ack: `${v === "CHILD" ? "A child" : "An adult"}, got it.` };
}

async function readRecipientStage(deps: FamilyIntakeDeps, text: string, d: Data): Promise<StepResult | null> {
  const roster = rosterFromData(d);
  const pending = rosterPending(roster);
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

async function readEmergency(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null> {
  const raw = await deps.parseWithClaude(
    'The family was asked for their emergency contact\'s name and phone number. Reply with raw JSON {"name":"","phone":"","relationship":""} — leave a value empty when not stated.',
    text,
  );
  try {
    const p = JSON.parse(raw) as { name?: unknown; phone?: unknown; relationship?: unknown };
    const name = String(p.name ?? "").trim();
    const phone = formatWizardPhone(p.phone);
    const relationship = String(p.relationship ?? "").trim();
    if (!name && !phone) return null;
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

async function readNeeds(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null | { fields: Data; ack: string; note?: string }> {
  const raw = await deps.parseWithClaude(
    'The family was asked what type of care is needed and may name several things. Reply with raw JSON {"needs":["each thing they named, in their words"]} — or {"needs":[]} if none.',
    text,
  );
  let needsWords: string[] = [];
  try { const p = JSON.parse(raw) as { needs?: unknown }; needsWords = Array.isArray(p.needs) ? (p.needs as unknown[]).map(String) : []; } catch { needsWords = [text]; }
  if (!needsWords.length) needsWords = [text];
  const c = await deps.canonicalizeCareNeeds(needsWords);
  if (!c.careNeeds.length) return null;
  const notes: string[] = [];
  if (c.medical.length) notes.push(`${c.medical.join(", ")} is medical care, which care providers here don't do, so I left it off — the closest service is Medication Reminders Only (reminding when it's time, not giving them).`);
  if (c.unmapped.length) notes.push(`${c.unmapped.join(", ")} isn't one of the services on the list, so I left it off.`);
  return { fields: { careNeeds: c.careNeeds }, ack: `${c.careNeeds.map(serviceLabel).join(", ")}, got it.${notes.length ? " " + notes.join(" ") : ""}` };
}

async function readRate(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null> {
  const raw = await deps.parseWithClaude("The family was asked what they'd like to pay per hour. Reply with just the number of dollars per hour (no symbol), or unknown.", text);
  const n = coerceClientRate(raw) ?? coerceClientRate(text);
  if (n === null) return null;
  return { fields: { rate: n }, ack: `$${n}/hr, got it.` };
}

async function readDescription(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null | { error: string }> {
  const raw = await deps.parseWithClaude("The family was asked what else care providers should know about the job, or to say skip. Reply exactly SKIP if they declined / have nothing to add, otherwise reply TEXT.", text);
  if (raw.trim().toUpperCase() === "SKIP") return { fields: { descriptionSkipped: true }, ack: "No problem, we'll leave that blank." };
  const t = text.trim();
  if (t.length > JOB_DESCRIPTION_MAX_CHARS) return { error: `That's ${t.length.toLocaleString("en-US")} characters and the job details hold up to ${JOB_DESCRIPTION_MAX_CHARS.toLocaleString("en-US")}. Could you send a shorter version?` };
  if (deps.isMedicationInstruction(t)) return { error: deps.medicationMessage };
  return { fields: { jobDescription: t }, ack: "Got it, I saved that." };
}

async function readEmail(deps: FamilyIntakeDeps, text: string): Promise<StepResult | null> {
  const raw = await deps.parseWithClaude("Extract the email address from this message. Reply with just the email, or unknown.", text);
  const v = raw.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(v)) return null;
  return { fields: { email: v }, ack: `${v}, got it.` };
}

// ── Corrections / front-loading: other fields stated in the same message ─────
// One extraction over the whole schema (the model reads; the code validates),
// applied as OVERWRITES so a changed answer wins — except the field of the step
// being answered (its own reader owns it) and the roster (readRoster owns it).
export async function extractOtherFields(deps: FamilyIntakeDeps, text: string, currentStep: FamilyStep, accountName: { first: string; last: string }): Promise<{ fields: Data; roster?: RosterPerson[]; capped?: boolean }> {
  const t = deps.today();
  const raw = await deps.parseWithClaude(
    `Today is ${t.weekday}, ${t.iso}. The family is partway through setting up care by text and was just asked: "${familyQuestionLabel(currentStep)}". ` +
      "Besides the answer to that question, extract ONLY other details they clearly stated or changed in this message, as raw JSON with any of: " +
      '{"careFrequency":"occasional|part_time|full_time","homeStreet":"","homeZipCode":"","startDate":"YYYY-MM-DD or ASAP","ongoing":true,"endDate":"YYYY-MM-DD","selectedDays":["MON"],"daysFlexible":false,"timeOfDay":["morning"],' +
      '"emergencyContactName":"","emergencyContactPhone":"","emergencyContactRelationship":"","careNeeds":["their words"],"rate":0,"email":"",' +
      '"recipients":"ONLY if they say WHO the care is for (e.g. me and my child, my mom): copy that phrase here"}. ' +
      "Omit everything not clearly stated. No markdown.",
    text,
  ).catch(() => "{}");
  let p: Data = {};
  try { p = JSON.parse(raw) as Data; } catch { return { fields: {} }; }
  const fields: Data = {};
  const skip = new Set<string>(fieldsOwnedBy(currentStep));
  const freq = normalizeFrequency(p.careFrequency); if (freq && !skip.has("careFrequency")) fields.careFrequency = freq;
  if (typeof p.homeStreet === "string" && p.homeStreet.trim() && !skip.has("homeStreet")) fields.homeStreet = p.homeStreet.trim();
  if (isValidZip(p.homeZipCode) && !skip.has("homeZipCode")) fields.homeZipCode = String(p.homeZipCode).trim();
  const start = normalizeStartDateToISO(p.startDate, t.iso); if (start && !skip.has("startDate")) fields.startDate = start;
  if (p.ongoing === true && !skip.has("ongoing")) { fields.ongoing = true; fields.endDate = null; }
  const end = normalizeStartDateToISO(p.endDate, t.iso); if (end && !skip.has("endDate")) { fields.endDate = end; fields.ongoing = false; }
  const days = normalizeDayCodes(p.selectedDays); if (days.length && !skip.has("selectedDays")) { fields.selectedDays = days; fields.daysFlexible = false; }
  if (p.daysFlexible === true && !skip.has("daysFlexible")) { fields.daysFlexible = true; fields.selectedDays = []; }
  const tod = mapTimeOfDayToWizardValues(p.timeOfDay); if (tod.length && !skip.has("timeOfDay")) fields.timeOfDay = tod;
  if (typeof p.emergencyContactName === "string" && p.emergencyContactName.trim() && !skip.has("emergencyContactName")) fields.emergencyContactName = p.emergencyContactName.trim();
  const ePhone = formatWizardPhone(p.emergencyContactPhone); if (ePhone && !skip.has("emergencyContactPhone")) fields.emergencyContactPhone = ePhone;
  if (typeof p.emergencyContactRelationship === "string" && p.emergencyContactRelationship.trim() && !skip.has("emergencyContactRelationship")) fields.emergencyContactRelationship = p.emergencyContactRelationship.trim();
  const rate = coerceClientRate(p.rate); if (rate !== null && !skip.has("rate")) fields.rate = rate;
  if (typeof p.email === "string" && /^\S+@\S+\.\S+$/.test(p.email.trim()) && !skip.has("email")) fields.email = p.email.trim().toLowerCase();
  if (Array.isArray(p.careNeeds) && p.careNeeds.length && !skip.has("careNeeds")) {
    const c = await deps.canonicalizeCareNeeds(p.careNeeds).catch(() => ({ careNeeds: [] as string[], medical: [], unmapped: [] }));
    if (c.careNeeds.length) fields.careNeeds = c.careNeeds;
  }
  let roster: RosterPerson[] | undefined; let capped: boolean | undefined;
  if (typeof p.recipients === "string" && p.recipients.trim() && !skip.has("relationship")) {
    const r = await readRoster(deps, p.recipients, accountName).catch(() => null);
    if (r) { roster = r.roster; capped = r.capped; }
  }
  return { fields, ...(roster ? { roster, capped } : {}) };
}

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
    case "family_ask_recipients": case "family_ask_recipient_name": case "family_ask_recipient_kind": case "family_ask_recipient_stage": return ["relationship", "seniorName", "additionalRecipients", "careKind", "ageRange"];
    case "family_ask_emergency": return ["emergencyContactName", "emergencyContactPhone", "emergencyContactRelationship"];
    case "family_ask_emergency_phone": return ["emergencyContactPhone"];
    case "family_ask_emergency_relationship": return ["emergencyContactRelationship"];
    case "family_ask_needs": return ["careNeeds"];
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
    case "family_ask_recipients": return "who the care is for";
    case "family_ask_recipient_name": return "a care recipient's name";
    case "family_ask_recipient_kind": return "whether the person is an adult or a child";
    case "family_ask_recipient_stage": return "a child's stage";
    case "family_ask_emergency": return "the emergency contact's name and phone";
    case "family_ask_emergency_phone": return "the emergency contact's phone";
    case "family_ask_emergency_relationship": return "how the emergency contact is related";
    case "family_ask_needs": return "what type of care is needed";
    case "family_ask_rate": return "the hourly rate";
    case "family_ask_description": return "what else care providers should know";
    case "family_ask_email": return "their email";
  }
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

  // 1. A side question: answer it, then re-ask the current question. No write.
  if (await deps.isQuestionOrOther(text, question)) {
    const answer = await deps.answerQuestionMidFlow(text, session, phone);
    await deps.sendMessage(chatId, `${answer}\n\n${question}`);
    return;
  }

  // 2. Read this step's answer.
  let result: StepResult | null | { error: string } = null;
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
      if (r) { result = { fields: dataFromRoster(r.roster), ack: rosterAck(r.roster) }; rosterCapped = r.capped; }
      break;
    }
    case "family_ask_recipient_name": result = await readRecipientName(deps, text, d); break;
    case "family_ask_recipient_kind": result = await readRecipientKind(deps, text, d); break;
    case "family_ask_recipient_stage": result = await readRecipientStage(deps, text, d); break;
    case "family_ask_emergency": result = await readEmergency(deps, text); break;
    case "family_ask_emergency_phone": result = await readEmergencyPhone(deps, text); break;
    case "family_ask_emergency_relationship": result = await readEmergencyRelationship(deps, text); break;
    case "family_ask_needs": result = await readNeeds(deps, text); break;
    case "family_ask_rate": result = await readRate(deps, text); break;
    case "family_ask_description": result = await readDescription(deps, text); break;
    case "family_ask_email": result = await readEmail(deps, text); break;
  }
  if (result && "error" in result) { await deps.sendMessage(chatId, result.error); return; }

  // 3. Other fields in the same message (front-loading or a correction) — overwrite.
  const fields: Data = { ...(result?.fields ?? {}) };
  const acks: string[] = result ? [result.ack] : [];
  if (text.trim().split(/\s+/).length >= WORDS_FOR_SIDE_EXTRACTION) {
    const other: { fields: Data; roster?: RosterPerson[]; capped?: boolean } = await extractOtherFields(deps, text, step, accountName).catch(() => ({ fields: {} }));
    for (const [k, v] of Object.entries(other.fields)) if (!(k in fields)) fields[k] = v;
    if (other.roster && !isRosterStep(step)) {
      Object.assign(fields, dataFromRoster(other.roster));
      acks.push(rosterAck(other.roster));
      if (other.capped) rosterCapped = true;
    }
  }

  // 4. Nothing usable — re-ask, no write.
  if (!Object.keys(fields).length) {
    await deps.updateSession(phone, { onboardingStep: step });
    await deps.sendMessage(chatId, `Sorry, I didn't catch that. ${question}`);
    return;
  }

  // 5. Save (mirrors to the site record) and gate the service area on an address.
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

  // 6. Next question = the first still-unanswered step; none left → the recap.
  const next = nextFamilyStep(d);
  const capNote = rosterCapped ? ` I can set up care for up to ${MAX_RECIPIENTS} people, like the site, so I kept the first ${MAX_RECIPIENTS}.` : "";
  if (!next) {
    await deps.sendMessage(chatId, `${acks.join(" ")}${capNote}`);
    await deps.sendRecap(phone, chatId);
    return;
  }
  await deps.updateSession(phone, { onboardingStep: next });
  await deps.sendMessage(chatId, `${acks.join(" ")}${capNote} ${familyQuestion(next, d)}`);
}

export function isRosterStep(step: FamilyStep): boolean {
  return step === "family_ask_recipients" || step === "family_ask_recipient_name" || step === "family_ask_recipient_kind" || step === "family_ask_recipient_stage";
}

/** "you (Light Housekeeping) and Mahad K, your child · Toddler" — every person, for the recap. */
export function describeRoster(d: Data): string {
  const roster = rosterFromData(d);
  if (!roster.length) return String(d.seniorName ?? "your loved one");
  const words = roster.map((p) => {
    if (p.relationship === "self") return "you";
    const rel = p.relationship === "adult child" ? "your adult child" : p.relationship === "other" ? (p.careKind === "child" ? "a child" : "") : `your ${p.relationship}`;
    const stage = isChildPerson(p) && p.ageRange ? ageRangeLabel(p.ageRange) : "";
    const tail = [rel, stage].filter(Boolean).join(" · ");
    return `${p.name || personPhrase(p)}${tail ? ` (${tail})` : ""}`;
  });
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
