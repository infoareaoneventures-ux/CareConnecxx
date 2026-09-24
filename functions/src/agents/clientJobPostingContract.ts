// Single source of truth for the shape of a client's job_postings/{uid} document
// and the carePlans/{uid} location-pool entry — mirrors the web wizard's
// createJobPosting (services/api.ts, ClientJobPostingWizard.tsx) field for
// field, so it doesn't matter whether a client finished setup on the website
// or over SMS with Evia. Locked to the web wizard's shape by
// clientJobPostingContract.parity.test.ts — if either side's fields ever
// drift, that test fails.
//
// This file owns ONLY the "what does the document look like" logic (pure
// functions, no Firestore calls). The actual writes live in
// onboardingConversation.ts (persistClientCareRecords) and buildJobPost.ts
// (buildAndSaveJobPost), which both call into here instead of shaping their
// own copies.

import { allCareRecipients, normalizeAdditionalRecipients, toWebsiteRelationship } from "./careRecipients";
import { coerceClientRate } from "./onboardingContract";
import { businessTodayStr } from "../utils/scheduledTime";

// ── Care level ────────────────────────────────────────────────────────────────
// Used ONLY by the later Post-a-Job flow (jobPostingFlow.ts → job_posts). The
// signup wizard never writes job_postings.careLevel (WhatsNext.tsx falls back
// to 'moderate'), so buildJobPostingsDoc below does not either. Care needs
// only — diagnoses/conditions are out of scope (non-medical care).

export function deriveCareLevel(conditions: string[], careNeeds: string[]): string {
  const heavy = [...conditions, ...careNeeds].join(" ").toLowerCase();
  if (/dementia|alzheimer|medical|wound|catheter|feeding|insulin/.test(heavy)) return "intensive";
  return (careNeeds.length || conditions.length) ? "moderate" : "light";
}

// ── Time of day — wizard's own lowercase values (TIME_OPTIONS in
// ClientJobPostingWizard.tsx), distinct from job_posts' capitalized slot enum
// (mapTimeOfDayToSlots in onboardingConversation.ts, used for buildWebJobPostDoc) ──

const WIZARD_TIME_OF_DAY_VALUES = new Set(["morning", "afternoon", "evening", "overnight"]);

export function mapTimeOfDayToWizardValues(tod: unknown): string[] {
  if (Array.isArray(tod)) {
    const mapped = tod.map((t) => String(t).toLowerCase()).filter((t) => WIZARD_TIME_OF_DAY_VALUES.has(t));
    return mapped.length ? mapped : [];
  }
  const t = (tod ?? "").toString().toLowerCase();
  if (!t) return [];
  if (t.includes("all") || t.includes("any")) return ["morning", "afternoon", "evening"];
  const slots: string[] = [];
  if (t.includes("morning") || t.includes("am")) slots.push("morning");
  if (t.includes("afternoon") || t.includes("noon")) slots.push("afternoon");
  if (t.includes("evening") || t.includes("night") || t.includes("pm")) slots.push("evening");
  if (t.includes("overnight") || t.includes("24")) slots.push("overnight");
  return slots;
}

// ── Care frequency — wizard's own stored values (step 2 of ClientJobPostingWizard) ──
// Evia collects occasional/part_time/full_time (onboardingDirective.ts); map
// onto exactly what the wizard writes for true parity.

export function mapCareFrequencyToWizardValue(freq: unknown): string | undefined {
  switch (freq) {
    case "occasional": return "specific";
    case "part_time":  return "part-time";
    case "full_time":  return "full-time";
    default: return typeof freq === "string" && freq ? freq : undefined;
  }
}

// ── Rate — wizard's `rate` is a number > 0 (numeric input, canAdvanceAt(13)),
// with `rateFlexible` always false at signup: the wizard has NO "flexible"
// option. (The later Post-a-Job flow's rateFlexible is a different flow.)
// A non-numeric value → no rate (the save-time validator re-asks before it
// can ever get here). ──

export function parseRate(raw: unknown): { rate?: number; rateFlexible: false } {
  const n = coerceClientRate(raw);
  return n === null ? { rateFlexible: false } : { rate: n, rateFlexible: false };
}

// ── Start date — the wizard stores an ISO yyyy-mm-dd from a date input,
// clamped to today (`val < todayISO() ? todayISO() : val`). ──
// Canonicalizes an already-extracted answer into that shape:
//   - ISO date (optionally with a time suffix) → the date, clamped to today
//   - "ASAP"/"now"/"today"/"soon"/"immediately"/"right away" → today
//   - anything else → null (caller resolves via the quick model, then re-asks)
// Value canonicalization of a constrained value (same class as JOB_TYPE_CANON),
// not intent parsing of free text — the LLM resolution lives in the caller.
const ASAP_WORDS = new Set([
  "asap", "now", "today", "soon", "immediately", "right away", "as soon as possible", "right now",
]);

export function normalizeStartDateToISO(raw: unknown, today: string = businessTodayStr()): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/.exec(t);
  if (iso) return iso[1] < today ? today : iso[1];
  const key = t.toLowerCase().replace(/[.!]+$/g, "").replace(/\s+/g, " ");
  if (ASAP_WORDS.has(key)) return today;
  return null;
}

// ── Emergency contact phone — the wizard's input formats as `(555) 000-0000`
// and canAdvanceAt(11) requires ≥10 digits. Returns undefined when fewer than
// 10 digits are present (a leading US country code is dropped). ──
export function formatWizardPhone(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  let digits = String(raw).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length < 10) return undefined;
  const d = digits.slice(0, 10);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function todayISO(): string {
  return businessTodayStr();
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

// ── job_postings/{uid} ──────────────────────────────────────────────────────

export interface ClientJobPostingsDoc {
  careFrequency?: string;
  street?: string; zipCode?: string; city?: string; state?: string; neighborhood?: string;
  startDate: string; endDate?: string; ongoing: boolean; daysFlexible: boolean;
  selectedDays: string[]; timeOfDay: string[];
  // The signup-time photo is the ACCOUNT HOLDER's own photo (mirrored to
  // users/{uid} by the caller) — it only becomes the care RECIPIENT's photo
  // here when the client IS the recipient (relationship "myself"). This is
  // the exact field CarePlan.tsx reads for the primary recipient's photo;
  // otherwise the recipient's own photo is set later via CarePlan's own
  // per-recipient upload (Hamse, 2026-08-23).
  careRecipientPhotoURL?: string;
  careRecipientFirstName?: string; careRecipientLastName?: string; careRecipientAge?: string;
  adultsCount: number; caregiversNeeded: number;
  additionalRecipients: Array<{ firstName: string; lastName: string; age?: string; relationship?: string }>;
  relationship?: string;
  emergencyFirstName?: string; emergencyLastName?: string; emergencyPhone?: string; emergencyRelationship?: string;
  careNeeds: string[];
  petsInHome: boolean; smokingHousehold: boolean;
  rate?: number; rateFlexible: boolean; paymentMethod?: string;
  jobDescription?: string;
  /** Site taxonomy sub-tasks per category (CarePlan.tsx / Step3CareNeeds.tsx careNeedDetails). */
  careNeedDetails?: Record<string, string[]>;
  clientId: string; phone: string; status: string; source: string;
}

// Build the job_postings/{uid} document in the wizard's exact shape from
// whatever Evia has collected in onboardingData. Safe to call repeatedly
// (idempotent) — callers write it with {merge:true}.
export function buildJobPostingsDoc(uid: string, phone: string, d: Record<string, unknown>): ClientJobPostingsDoc {
  const seniorName   = (d.seniorName ?? "") as string;
  const { first: careRecipientFirstName, last: careRecipientLastName } = splitName(seniorName);
  const careNeeds    = (Array.isArray(d.careNeeds)  ? d.careNeeds  : []) as string[];
  const seniorAge    = d.age as number | string | undefined;

  const extraRecipients = normalizeAdditionalRecipients(d.additionalRecipients);
  const additionalRecipients = extraRecipients.map((r) => {
    const { first, last } = splitName(r.name);
    return {
      firstName: first, lastName: last,
      relationship: r.relationship,
      ...(r.age !== undefined ? { age: String(r.age) } : {}),
    };
  });

  const { rate, rateFlexible } = parseRate(d.rate);

  const ecName = (d.emergencyContactName ?? "") as string;
  const { first: emergencyFirstName, last: emergencyLastName } = splitName(ecName);

  const relationship = toWebsiteRelationship(d.relationship as string | undefined);
  const photoURL = (d.careRecipientPhotoURL as string) || undefined;

  return {
    careFrequency: mapCareFrequencyToWizardValue(d.careFrequency),
    street: (d.street as string) || undefined,
    zipCode: (d.zipCode as string) || undefined,
    city: (d.city as string) || undefined,
    state: (d.state as string) || undefined,
    // Always the wizard's ISO yyyy-mm-dd (legacy sessions may still hold
    // "ASAP"/free text — canonicalize, else fall back to today like the
    // wizard's clamp does).
    startDate: normalizeStartDateToISO(d.startDate) ?? todayISO(),
    endDate: (d.endDate as string) || undefined,
    ongoing: d.ongoing === true,
    daysFlexible: d.daysFlexible === true,
    selectedDays: Array.isArray(d.selectedDays) ? d.selectedDays as string[] : [],
    timeOfDay: mapTimeOfDayToWizardValues(d.timeOfDay),
    careRecipientPhotoURL: relationship === "myself" ? photoURL : undefined,
    careRecipientFirstName: careRecipientFirstName || undefined,
    careRecipientLastName: careRecipientLastName || undefined,
    careRecipientAge: seniorAge !== undefined ? String(seniorAge) : undefined,
    adultsCount: 1 + extraRecipients.length,
    caregiversNeeded: (d.caregiversNeeded as number) || 1,
    additionalRecipients,
    relationship,
    emergencyFirstName: emergencyFirstName || undefined,
    emergencyLastName: emergencyLastName || undefined,
    emergencyPhone: formatWizardPhone(d.emergencyContactPhone),
    emergencyRelationship: (d.emergencyContactRelationship as string) || undefined,
    careNeeds,
    petsInHome: d.petsInHome === true,
    smokingHousehold: d.smokingHousehold === true,
    rate,
    rateFlexible,
    paymentMethod: (d.paymentMethod as string) || undefined,
    jobDescription: (d.jobDescription as string) || undefined,
    careNeedDetails: (d.careNeedDetails && typeof d.careNeedDetails === "object" && Object.keys(d.careNeedDetails as object).length) ? (d.careNeedDetails as Record<string, string[]>) : undefined,
    clientId: uid,
    phone,
    status: "active",
    source: "cara_sms",
  };
}

// ── carePlans/{uid} location-pool entry ──────────────────────────────────────
// Same fields createJobPosting (services/api.ts) pushes onto locationPool
// (street/city/state/zipCode/petsInHome/smokingHousehold), plus lat/lng — the
// site reads carePlans.locationPool[].lat/lng for distance (FindCaregivers.tsx,
// useNearbyCaregiversWithScores.ts). No Evia-only `primary` marker.

export interface CarePlanLocationEntry {
  street?: string; city?: string; state?: string; zipCode?: string;
  petsInHome: boolean; smokingHousehold: boolean;
  lat?: number; lng?: number;
}

export function buildCarePlanLocationEntry(
  d: Record<string, unknown>,
  coords?: { lat: number; lng: number },
): CarePlanLocationEntry {
  return {
    street: (d.street as string) || undefined,
    city: (d.city as string) || undefined,
    state: (d.state as string) || undefined,
    zipCode: (d.zipCode as string) || undefined,
    petsInHome: d.petsInHome === true,
    smokingHousehold: d.smokingHousehold === true,
    ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
  };
}

// Upsert ONE entry into an existing pool the way createJobPosting does: match
// on street (case-insensitive) + zip; on a match, refresh pets/smoking (and
// lat/lng when known) on that entry; otherwise append. Returns null when the
// entry has no street — createJobPosting's locationPoolUpdate returns early
// then, so the pool is left untouched.
export function upsertCarePlanLocationPool(
  existingPool: unknown,
  entry: CarePlanLocationEntry,
): Array<Record<string, unknown>> | null {
  if (!entry.street) return null;
  const pool: Array<Record<string, unknown>> = Array.isArray(existingPool)
    ? (existingPool as Array<Record<string, unknown>>).filter((l) => l && typeof l === "object")
    : [];
  const idx = pool.findIndex((l) =>
    String(l.street ?? "").toLowerCase() === String(entry.street).toLowerCase() &&
    String(l.zipCode ?? "") === String(entry.zipCode ?? ""));
  const coords = entry.lat !== undefined && entry.lng !== undefined ? { lat: entry.lat, lng: entry.lng } : {};
  if (idx >= 0) {
    return pool.map((l, i) => (i === idx
      ? { ...l, petsInHome: entry.petsInHome, smokingHousehold: entry.smokingHousehold, ...coords }
      : l));
  }
  return [...pool, {
    street: entry.street, city: entry.city, state: entry.state, zipCode: entry.zipCode,
    petsInHome: entry.petsInHome, smokingHousehold: entry.smokingHousehold, ...coords,
  }];
}

// ── senior_profiles/{uid} wizard-parity fields ───────────────────────────────
// Exactly createJobPosting's profileUpdate (services/api.ts): careNeeds/needs/
// scheduleNeeded/zipCode always; name/firstName/lastName/adultsCount/location
// ("City, ST")/age/relationship only when present. No diagnoses or preference
// fields — the wizard has none.

export interface SeniorProfileWizardFields {
  careNeeds: string[];
  needs: string[];
  scheduleNeeded: string[];
  zipCode?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  adultsCount?: number;
  location?: string;
  age?: number;
  relationship?: string;
}

// imageUrl deliberately NOT written here — senior_profiles.imageUrl is a dead
// field nothing reads (CarePlan.tsx reads job_postings.careRecipientPhotoURL
// instead, see buildJobPostingsDoc above). Matches the website wizard fix of
// the same date.
export function buildSeniorProfileWizardFields(d: Record<string, unknown>): SeniorProfileWizardFields {
  const careNeeds = (Array.isArray(d.careNeeds) ? d.careNeeds : []) as string[];
  const { first, last } = splitName((d.seniorName ?? "") as string);
  const recipientName = [first, last].filter(Boolean).join(" ");
  const city  = (d.city  as string) || "";
  const state = (d.state as string) || "";
  const age   = Number(d.age);
  const relationship = toWebsiteRelationship(d.relationship as string | undefined);
  const adultsCount = 1 + normalizeAdditionalRecipients(d.additionalRecipients).length;
  return {
    careNeeds,
    needs: careNeeds,
    scheduleNeeded: Array.isArray(d.selectedDays) ? d.selectedDays as string[] : [],
    ...((d.zipCode as string) ? { zipCode: d.zipCode as string } : {}),
    ...(recipientName ? { name: recipientName } : {}),
    ...(first ? { firstName: first } : {}),
    ...(last ? { lastName: last } : {}),
    adultsCount,
    ...(city && state ? { location: `${city}, ${state}` } : {}),
    ...(Number.isFinite(age) && age > 0 ? { age } : {}),
    ...(relationship ? { relationship } : {}),
  };
}

// ── Reverse mapping: live site docs → Evia's onboardingData shape ───────────
//
// A client can complete some or all of setup on the website directly instead
// of over SMS — Evia's own onboardingData draft (agent_sessions/{phone}) never
// sees any of that, since nothing previously read job_postings/carePlans/users
// back into it. This is the inverse of buildJobPostingsDoc above: given
// whatever's live on those documents, produce onboardingData-shaped fields so
// Evia's "what's still needed" check reflects the real account state instead
// of just its own private draft (2026-09-06 cross-channel sync fix). Callers
// merge this UNDER their own onboardingData (site data fills gaps, an
// in-conversation answer from THIS turn always wins) and treat it as
// read-only context for prompt-building — never persisted back verbatim,
// since save_onboarding_field remains the only writer of the real draft.

const WIZARD_TO_CARA_FREQUENCY: Record<string, string> = {
  "specific": "occasional", "part-time": "part_time", "full-time": "full_time",
};

function joinName(first?: string, last?: string): string {
  return [first, last].filter(Boolean).join(" ").trim();
}

export function mapJobPostingsDocToOnboardingData(
  jobPostings: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!jobPostings) return {};
  const d = jobPostings;
  const out: Record<string, unknown> = {};

  if (d.careFrequency) out.careFrequency = WIZARD_TO_CARA_FREQUENCY[d.careFrequency as string] ?? d.careFrequency;
  if (d.street)   out.street = d.street;
  if (d.zipCode)  out.zipCode = d.zipCode;
  if (d.city)     out.city = d.city;
  if (d.state)    out.state = d.state;
  if (d.startDate) out.startDate = d.startDate;
  if (d.endDate)  out.endDate = d.endDate;
  if (typeof d.ongoing === "boolean") out.ongoing = d.ongoing;
  if (typeof d.daysFlexible === "boolean") out.daysFlexible = d.daysFlexible;
  if (Array.isArray(d.selectedDays) && d.selectedDays.length) out.selectedDays = d.selectedDays;
  if (Array.isArray(d.timeOfDay) && d.timeOfDay.length) out.timeOfDay = d.timeOfDay[0];
  if (d.careRecipientPhotoURL) out.careRecipientPhotoURL = d.careRecipientPhotoURL;

  const seniorName = joinName(d.careRecipientFirstName as string | undefined, d.careRecipientLastName as string | undefined);
  if (seniorName) out.seniorName = seniorName;
  if (d.careRecipientAge) out.age = d.careRecipientAge;
  if (Array.isArray(d.additionalRecipients) && d.additionalRecipients.length) {
    out.additionalRecipients = (d.additionalRecipients as Array<Record<string, unknown>>).map((r) => ({
      name: joinName(r.firstName as string | undefined, r.lastName as string | undefined),
      relationship: r.relationship,
      age: r.age,
    }));
  }
  if (d.relationship) out.relationship = d.relationship === "myself" ? "self" : d.relationship;

  const emergencyContactName = joinName(d.emergencyFirstName as string | undefined, d.emergencyLastName as string | undefined);
  if (emergencyContactName) out.emergencyContactName = emergencyContactName;
  if (d.emergencyPhone) out.emergencyContactPhone = d.emergencyPhone;
  if (d.emergencyRelationship) out.emergencyContactRelationship = d.emergencyRelationship;

  if (Array.isArray(d.careNeeds) && d.careNeeds.length) out.careNeeds = d.careNeeds;
  if (typeof d.petsInHome === "boolean") out.petsInHome = d.petsInHome;
  if (typeof d.smokingHousehold === "boolean") out.smokingHousehold = d.smokingHousehold;
  // The wizard has no "flexible" rate — only a numeric rate maps back.
  if (typeof d.rate === "number" && d.rate > 0) out.rate = d.rate;
  if (d.jobDescription) out.jobDescription = d.jobDescription;
  if (d.careNeedDetails && typeof d.careNeedDetails === "object") out.careNeedDetails = d.careNeedDetails;
  // The wizard's home-address step (its own draft field names, saved per step by
  // ClientJobPostingWizard) → Evia's home* fields, so a family who typed their
  // address on the site is never asked for it again over text.
  const ha = d._homeAddress as Record<string, unknown> | undefined;
  if (ha && typeof ha === "object") {
    if (ha.street)  out.homeStreet  = ha.street;
    if (ha.zipCode) out.homeZipCode = ha.zipCode;
    if (ha.city)    out.homeCity    = ha.city;
    if (ha.state)   out.homeState   = ha.state;
  }
  if (typeof d._customAddressOpen === "boolean") out.sameAsHomeAddress = !d._customAddressOpen;
  if (typeof d.caregiversNeeded === "number") out.caregiversNeeded = d.caregiversNeeded;

  return out;
}

// users/{uid} — the account holder's OWN address (distinct document from
// job_postings' care address) and recovery email.
export function mapUsersDocToOnboardingData(
  users: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!users) return {};
  const out: Record<string, unknown> = {};
  if (users.street)  out.homeStreet = users.street;
  if (users.zipCode) out.homeZipCode = users.zipCode;
  if (users.city)    out.homeCity = users.city;
  if (users.state)   out.homeState = users.state;
  if (users.email)   out.email = users.email;
  return out;
}

// Re-export for callers that need the recipient list without importing
// careRecipients.ts directly.
export { allCareRecipients, normalizeAdditionalRecipients };

// ── Per-step draft (2026-09-20, founder: "one questionnaire, two doors") ────
// Evia writes each accepted answer onto job_postings/{uid} as it is given, in the
// wizard's own field names, so the site wizard resumes where the text left off
// (and the wizard's own per-step saves flow back into Evia through
// mapJobPostingsDocToOnboardingData). Unlike buildJobPostingsDoc, NOTHING is
// defaulted here — a key is present only when the family actually answered it,
// so a merge can never overwrite a wizard answer with a placeholder.
export function buildClientDraftMirror(uid: string, phone: string, d: Record<string, unknown>): Record<string, unknown> {
  const full = buildJobPostingsDoc(uid, phone, d) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const has = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
  const take = (key: string, when: boolean) => { if (when && has(full[key])) out[key] = full[key]; };
  take("careFrequency", has(d.careFrequency));
  take("street", has(d.street)); take("zipCode", has(d.zipCode)); take("city", has(d.city)); take("state", has(d.state));
  take("startDate", has(d.startDate)); take("endDate", has(d.endDate));
  if (d.ongoing !== undefined) out.ongoing = d.ongoing === true;
  if (d.daysFlexible !== undefined) out.daysFlexible = d.daysFlexible === true;
  take("selectedDays", has(d.selectedDays)); take("timeOfDay", has(d.timeOfDay));
  take("careRecipientPhotoURL", has(d.careRecipientPhotoURL));
  take("careRecipientFirstName", has(d.seniorName)); take("careRecipientLastName", has(d.seniorName)); take("careRecipientAge", d.age !== undefined && d.age !== null && d.age !== "");
  take("relationship", has(d.relationship)); take("additionalRecipients", has(d.additionalRecipients));
  if (has(d.additionalRecipients)) out.adultsCount = full.adultsCount;
  take("caregiversNeeded", has(d.caregiversNeeded));
  take("emergencyFirstName", has(d.emergencyContactName)); take("emergencyLastName", has(d.emergencyContactName));
  take("emergencyPhone", has(d.emergencyContactPhone)); take("emergencyRelationship", has(d.emergencyContactRelationship));
  take("careNeeds", has(d.careNeeds));
  if (d.petsInHome !== undefined) out.petsInHome = d.petsInHome === true;
  if (d.smokingHousehold !== undefined) out.smokingHousehold = d.smokingHousehold === true;
  if (d.rate !== undefined && d.rate !== null && d.rate !== "") { take("rate", true); out.rateFlexible = full.rateFlexible === true; }
  take("jobDescription", has(d.jobDescription));
  if (d.careNeedDetails && typeof d.careNeedDetails === "object" && Object.keys(d.careNeedDetails as object).length) out.careNeedDetails = d.careNeedDetails;
  // The wizard's home-address step reads its OWN draft fields (_homeAddress /
  // _customAddressOpen), not street/city — without this the step opened empty
  // on the site after Evia had already collected the address (live 2026-09-20).
  const same = d.sameAsHomeAddress === true;
  const home = {
    street:  d.homeStreet  ?? (same ? d.street  : undefined),
    zipCode: d.homeZipCode ?? (same ? d.zipCode : undefined),
    city:    d.homeCity    ?? (same ? d.city    : undefined),
    state:   d.homeState   ?? (same ? d.state   : undefined),
  };
  if (Object.values(home).some(has)) out._homeAddress = { street: home.street ?? "", zipCode: home.zipCode ?? "", city: home.city ?? "", state: home.state ?? "" };
  if (d.sameAsHomeAddress !== undefined) out._customAddressOpen = d.sameAsHomeAddress !== true;
  return out;
}
