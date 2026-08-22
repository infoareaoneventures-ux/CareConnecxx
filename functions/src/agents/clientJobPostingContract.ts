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

import { allCareRecipients, normalizeAdditionalRecipients } from "./careRecipients";

// ── Care level ────────────────────────────────────────────────────────────────

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

// ── Rate — wizard's `rate` is a number (or absent), with a separate
// `rateFlexible` boolean. Evia may collect the literal string "flexible". ──

export function parseRate(raw: unknown): { rate?: number; rateFlexible: boolean } {
  if (raw === undefined || raw === null || raw === "") return { rateFlexible: false };
  if (typeof raw === "number" && Number.isFinite(raw)) return { rate: raw, rateFlexible: false };
  if (String(raw).toLowerCase() === "flexible") return { rateFlexible: true };
  const n = Number(raw);
  return Number.isFinite(n) ? { rate: n, rateFlexible: false } : { rateFlexible: true };
}

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
  photoURL?: string;
  careRecipientFirstName?: string; careRecipientLastName?: string; careRecipientAge?: string;
  adultsCount: number; caregiversNeeded: number;
  additionalRecipients: Array<{ firstName: string; lastName: string; age?: string; relationship?: string }>;
  relationship?: string;
  emergencyFirstName?: string; emergencyLastName?: string; emergencyPhone?: string; emergencyRelationship?: string;
  careNeeds: string[]; careLevel: string;
  petsInHome: boolean; smokingHousehold: boolean;
  rate?: number; rateFlexible: boolean; paymentMethod?: string;
  jobDescription?: string;
  clientId: string; phone: string; status: string; source: string;
}

// Build the job_postings/{uid} document in the wizard's exact shape from
// whatever Evia has collected in onboardingData. Safe to call repeatedly
// (idempotent) — callers write it with {merge:true}.
export function buildJobPostingsDoc(uid: string, phone: string, d: Record<string, unknown>): ClientJobPostingsDoc {
  const seniorName   = (d.seniorName ?? "") as string;
  const { first: careRecipientFirstName, last: careRecipientLastName } = splitName(seniorName);
  const conditions   = (Array.isArray(d.conditions) ? d.conditions : []) as string[];
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

  return {
    careFrequency: mapCareFrequencyToWizardValue(d.careFrequency),
    street: (d.street as string) || undefined,
    zipCode: (d.zipCode as string) || undefined,
    city: (d.city as string) || undefined,
    state: (d.state as string) || undefined,
    startDate: (d.startDate as string) || todayISO(),
    endDate: (d.endDate as string) || undefined,
    ongoing: d.ongoing === true,
    daysFlexible: d.daysFlexible === true,
    selectedDays: Array.isArray(d.selectedDays) ? d.selectedDays as string[] : [],
    timeOfDay: mapTimeOfDayToWizardValues(d.timeOfDay),
    photoURL: (d.careRecipientPhotoURL as string) || undefined,
    careRecipientFirstName: careRecipientFirstName || undefined,
    careRecipientLastName: careRecipientLastName || undefined,
    careRecipientAge: seniorAge !== undefined ? String(seniorAge) : undefined,
    adultsCount: 1 + extraRecipients.length,
    caregiversNeeded: (d.caregiversNeeded as number) || 1,
    additionalRecipients,
    relationship: (d.relationship as string) || undefined,
    emergencyFirstName: emergencyFirstName || undefined,
    emergencyLastName: emergencyLastName || undefined,
    emergencyPhone: (d.emergencyContactPhone as string) || undefined,
    emergencyRelationship: (d.emergencyContactRelationship as string) || undefined,
    careNeeds,
    careLevel: deriveCareLevel(conditions, careNeeds),
    petsInHome: d.petsInHome === true,
    smokingHousehold: d.smokingHousehold === true,
    rate,
    rateFlexible,
    paymentMethod: (d.paymentMethod as string) || undefined,
    jobDescription: (d.jobDescription as string) || undefined,
    clientId: uid,
    phone,
    status: "active",
    source: "cara_sms",
  };
}

// ── carePlans/{uid} location-pool entry ──────────────────────────────────────
// Union of every field either current SMS writer or the web wizard needs, so
// CarePlan.tsx's address picker never ends up missing street/state or
// pets/smoking depending on which channel wrote it.

export interface CarePlanLocationEntry {
  street?: string; city?: string; state?: string; zipCode?: string;
  petsInHome: boolean; smokingHousehold: boolean;
  primary: true;
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
    primary: true,
    ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
  };
}

// ── senior_profiles/{uid} wizard-parity fields ───────────────────────────────
// Additive to whatever else persistClientCareRecords already writes for this
// doc (diagnoses, genderPreference, languagePreference are SMS-only extras the
// wizard doesn't have — kept as-is by the caller, not touched here).

export interface SeniorProfileWizardFields {
  careNeeds: string[];
  needs: string[];
  scheduleNeeded: string[];
  imageUrl?: string;
}

export function buildSeniorProfileWizardFields(d: Record<string, unknown>): SeniorProfileWizardFields {
  const careNeeds = (Array.isArray(d.careNeeds) ? d.careNeeds : []) as string[];
  return {
    careNeeds,
    needs: careNeeds,
    scheduleNeeded: Array.isArray(d.selectedDays) ? d.selectedDays as string[] : [],
    imageUrl: (d.careRecipientPhotoURL as string) || undefined,
  };
}

// Re-export for callers that need the recipient list without importing
// careRecipients.ts directly.
export { allCareRecipients, normalizeAdditionalRecipients };
