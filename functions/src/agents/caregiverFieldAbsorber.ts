// Caregiver-side persistence safety net — the caregiver mirror of
// absorbClientFields (onboardingConversation.ts). The agent loop depends on the
// MODEL calling save_onboarding_field; when it chats an answer but skips the
// tool (or saves only some of a front-loaded message), this deterministic
// extractor recovers the rest server-side so a caregiver's answer is never lost
// and the signup never sticks.
//
// Conservative by design: returns {} on any parse error, validates every value,
// and only ever returns fields NOT already filled — so a field the model DID
// save can never be overwritten.
//
// Kept in its own small module (not onboardingConversation.ts, which teammates
// own) so the webhook can import it without touching the legacy runner.

import { parseWithClaude } from "../utils/parseWithClaude";
import { isFieldFilled } from "./onboardingContract";

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const JOB_TYPES = new Set(["occasional", "part_time", "full_time"]);

function cleanStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim())
    : [];
}

/**
 * Scan one inbound caregiver message for ANY conversational onboarding fields
 * and return only the ones not already saved. Lets a caregiver say "I'm Maria
 * in San Jose, 6 years experience, mostly dementia, $25/hr" once and have every
 * field captured — mirroring the client flow's absorbClientFields technique.
 *
 * NOTE: bio is intentionally NOT absorbed — almost any message could be
 * misread as a bio, and a wrong bio is family-visible. The loop collects it
 * explicitly (and re-asks if the model skipped the save).
 */
export async function absorbCaregiverFields(
  text: string,
  existing: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const raw = await parseWithClaude(
    "You are extracting onboarding details from one message a caregiver sent to Evia while signing up for work. " +
      "Return JSON only with the fields you can confidently extract. Omit fields not present. " +
      "Schema: " +
      `{"name":"the caregiver's own first/full name (the person texting; never a client's or senior's name)",` +
      `"city":"city name",` +
      `"zipCode":"5-digit US zip code",` +
      `"yearsExperience":number,` +
      `"specialties":["short care specialty like 'dementia' or 'mobility assistance'"],` +
      `"certifications":["certification name like 'CNA' or 'HHA'"],` +
      `"availability":{"days":["Monday"],"hours":"9am-5pm"},` +
      `"jobType":"occasional | part_time | full_time",` +
      `"hourlyRate":number,` +
      `"email":"email address",` +
      `"gender":"how the caregiver identifies, only if they state it (e.g. female, male, non-binary)",` +
      `"languages":["language they speak, e.g. 'Spanish'"],` +
      `"canDrive":true or false — only if they clearly say whether they drive}. ` +
      "Be conservative — only include a field if it is unambiguously stated. Reply with raw JSON, no markdown.",
    text,
  ).catch(() => "{}");

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw); } catch { return {}; }

  // Validate/normalize each candidate value; drop anything malformed rather
  // than persisting garbage. Mirrors the scripted parsers' clamps.
  const candidates: Record<string, unknown> = {};
  if (typeof parsed.name === "string" && parsed.name.trim()) candidates.name = parsed.name.trim();
  if (typeof parsed.city === "string" && parsed.city.trim()) candidates.city = parsed.city.trim();
  if (typeof parsed.zipCode === "string" && /^\d{5}$/.test(parsed.zipCode.trim())) {
    candidates.zipCode = parsed.zipCode.trim();
  }
  if (typeof parsed.yearsExperience === "number" && parsed.yearsExperience > 0) {
    candidates.yearsExperience = parsed.yearsExperience;
  }
  const specialties = cleanStringArray(parsed.specialties);
  if (specialties.length) candidates.specialties = specialties;
  const certifications = cleanStringArray(parsed.certifications);
  if (certifications.length) candidates.certifications = certifications;
  if (parsed.availability && typeof parsed.availability === "object" && !Array.isArray(parsed.availability)) {
    const a = parsed.availability as Record<string, unknown>;
    const days  = cleanStringArray(a.days);
    const hours = typeof a.hours === "string" ? a.hours.trim() : "";
    if (days.length || hours) candidates.availability = { days, hours };
  }
  if (typeof parsed.jobType === "string" && JOB_TYPES.has(parsed.jobType)) {
    candidates.jobType = parsed.jobType;
  }
  if (typeof parsed.hourlyRate === "number" && parsed.hourlyRate >= 5 && parsed.hourlyRate <= 200) {
    candidates.hourlyRate = parsed.hourlyRate;
  }
  if (typeof parsed.email === "string" && EMAIL_RE.test(parsed.email.trim().toLowerCase())) {
    candidates.email = parsed.email.trim().toLowerCase();
  }
  // Optional profile-parity extras (2g). Never required — captured only when the
  // caregiver clearly volunteers them so families can filter.
  if (typeof parsed.gender === "string" && parsed.gender.trim()) {
    candidates.gender = parsed.gender.trim();
  }
  const languages = cleanStringArray(parsed.languages);
  if (languages.length) candidates.languages = languages;
  if (typeof parsed.canDrive === "boolean") candidates.canDrive = parsed.canDrive;

  // Only return fields that are actually new (never touch a model-saved value).
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(candidates)) {
    if (!isFieldFilled(v)) continue;
    if (isFieldFilled(existing[k])) continue;
    out[k] = v;
  }

  // When we recovered fresh specialties, also write the canonical skills/services
  // enum the webapp checkboxes + matching engine read (mirrors the save handler's
  // canonicalization). Only when skills isn't already set, and never at the cost
  // of the raw specialties, which are already in `out`.
  if (Array.isArray(out.specialties) && out.specialties.length && !isFieldFilled(existing.skills)) {
    try {
      const { canonicalizeCaregiverServices } = await import("./caregiverServices");
      const canonical = await canonicalizeCaregiverServices(out.specialties);
      if (canonical.length) {
        out.skills = canonical;
        out.services = canonical;
      }
    } catch {
      /* keep raw specialties; canonicalization is best-effort */
    }
  }

  return out;
}

const unionCI = (existing: unknown, added: string[]): string[] | null => {
  const base = cleanStringArray(existing);
  const seen = new Set(base.map((s) => s.toLowerCase()));
  const fresh = added.filter((s) => !seen.has(s.toLowerCase()));
  return fresh.length ? [...base, ...fresh] : null;
};

/**
 * UPDATE-mode absorber for a caregiver who volunteers new profile info AFTER
 * collection — e.g. "I can do transportation as well" while parked at the
 * photo/bg-check/payout gate. absorbCaregiverFields is collection-time and
 * refuses to touch a filled field, which silently DROPS additions like that
 * (seen live 07-14: the addition was lost and the reply read like Evia forgot
 * the conversation). Policy here:
 *  - array fields (specialties, certifications, languages) merge ADDITIVELY
 *    (case-insensitive union) — returned only when something new was added
 *  - availability merges: new days union onto existing, hours replaced only
 *    when stated
 *  - scalar fields still fill only when empty (a casual mention must never
 *    overwrite a deliberate answer)
 *  - specialties changes re-canonicalize into skills/services ADDITIVELY so
 *    matching + the webapp profile see the new capability
 * Returns {} when the message adds nothing — callers fall through to their
 * normal step behavior.
 */
export async function absorbCaregiverProfileUpdate(
  text: string,
  existing: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fresh = await absorbCaregiverFields(text, existing);   // empty-field fills, validated
  const out: Record<string, unknown> = { ...fresh };

  // Re-extract for the additive fields absorbCaregiverFields dropped because
  // they were already filled. One more parse only when the first pass returned
  // no array fields (the common "adds to an existing list" case).
  const raw = await parseWithClaude(
    "A caregiver already signed up with Evia texted a message. Extract ONLY details about the caregiver themselves " +
      "that they are adding or stating in THIS message. Return JSON only; omit anything not present. Schema: " +
      `{"specialties":["care service or specialty they say they offer, e.g. 'transportation' or 'dementia care'"],` +
      `"certifications":["certification name like 'CNA'"],` +
      `"languages":["language they speak"],` +
      `"availabilityDays":["day of week they say they're available"],` +
      `"availabilityHours":"hours they say they're available, e.g. 'mornings'"}. ` +
      "Be conservative — only include what is unambiguously about the caregiver's own offering. Reply with raw JSON, no markdown.",
    text,
  ).catch(() => "{}");

  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(raw); } catch { /* keep {} */ }

  let addedSpecialties: string[] = Array.isArray(fresh.specialties) ? (fresh.specialties as string[]) : [];
  for (const key of ["specialties", "certifications", "languages"] as const) {
    if (out[key]) continue; // first pass already handled the empty-field case
    const added = cleanStringArray(parsed[key]);
    if (!added.length) continue;
    const merged = unionCI(existing[key], added);
    if (merged) {
      out[key] = merged;
      if (key === "specialties") addedSpecialties = added;
    }
  }

  const addedDays  = cleanStringArray(parsed.availabilityDays);
  const addedHours = typeof parsed.availabilityHours === "string" ? parsed.availabilityHours.trim() : "";
  if (!out.availability && (addedDays.length || addedHours)) {
    const cur = (existing.availability && typeof existing.availability === "object"
      ? existing.availability : {}) as Record<string, unknown>;
    const mergedDays = unionCI(cur.days, addedDays);
    const curHours   = typeof cur.hours === "string" ? cur.hours : "";
    if (mergedDays || (addedHours && addedHours !== curHours)) {
      out.availability = {
        days:  mergedDays ?? cleanStringArray(cur.days),
        hours: addedHours || curHours,
      };
    }
  }

  // Specialties grew → extend the canonical skills/services enums additively
  // with the canonical form of ONLY the new specialties (never shrink or
  // re-derive the whole list: the webapp checkboxes may hold services the
  // canonicalizer wouldn't re-derive from specialties alone).
  if (addedSpecialties.length && !out.services) {
    try {
      const { canonicalizeCaregiverServices } = await import("./caregiverServices");
      const canonical = await canonicalizeCaregiverServices(addedSpecialties);
      const mergedServices = unionCI(existing.services, canonical);
      const mergedSkills   = unionCI(existing.skills,   canonical);
      if (mergedServices) out.services = mergedServices;
      if (mergedSkills)   out.skills   = mergedSkills;
    } catch { /* best-effort */ }
  }

  return out;
}
