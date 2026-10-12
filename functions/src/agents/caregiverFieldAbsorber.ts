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
import { isFieldFilled, toExperienceBucket, toServiceRadius, availabilityComplete } from "./onboardingContract";
import { orderedCanonicalServices } from "./caregiverServiceLabels";

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
    "You are extracting onboarding details from one message a care provider sent to Evia while signing up for work. " +
      "Return JSON only with the fields you can confidently extract. Omit fields not present. " +
      "Schema: " +
      `{"name":"the care provider's own first/full name (the person texting; never a client's or senior's name)",` +
      `"street":"street address line only (number + street), never the city or zip",` +
      `"city":"city name",` +
      `"state":"2-letter US state code",` +
      `"zipCode":"5-digit US zip code",` +
      `"yearsExperience":number,` +
      `"specialties":["short care specialty like 'dementia' or 'mobility assistance'"],` +
      `"availability":{"days":["Monday"],"hours":"9am-5pm"},` +
      `"jobType":"occasional | part_time | full_time — or a list of those when they name more than one",` +
      `"hourlyRate":number,` +
      `"serviceRadius":number of miles they're willing to travel — only if stated,` +
      `"email":"email address"}. ` +
      "Be conservative — only include a field if it is unambiguously stated. Reply with raw JSON, no markdown.",
    text,
  ).catch(() => "{}");

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw); } catch { return {}; }

  // Validate/normalize each candidate value; drop anything malformed rather
  // than persisting garbage. Mirrors the scripted parsers' clamps.
  const candidates: Record<string, unknown> = {};
  if (typeof parsed.name === "string" && parsed.name.trim()) candidates.name = parsed.name.trim();
  if (typeof parsed.street === "string" && parsed.street.trim() && /\d/.test(parsed.street)) candidates.street = parsed.street.trim();
  if (typeof parsed.city === "string" && parsed.city.trim()) candidates.city = parsed.city.trim();
  if (typeof parsed.state === "string" && /^[A-Za-z]{2}$/.test(parsed.state.trim())) candidates.state = parsed.state.trim().toUpperCase();
  if (typeof parsed.zipCode === "string" && /^\d{5}$/.test(parsed.zipCode.trim())) {
    candidates.zipCode = parsed.zipCode.trim();
  }
  // Wizard shape: experience is a bucket string ("3-5 years"), never a raw number.
  if (typeof parsed.yearsExperience === "number" && parsed.yearsExperience >= 0) {
    const bucket = toExperienceBucket(parsed.yearsExperience);
    if (bucket) candidates.yearsExperience = bucket;
  }
  // Care services = the website's eight only (2026-10-04): the caregiver's words
  // are mapped onto PRIMARY_SERVICES before anything is kept — never a raw word
  // on the record. What fits nothing is dropped here; the loop's save tool (not
  // the absorber) is where Evia tells her what was left off.
  const specialtyWords = cleanStringArray(parsed.specialties);
  if (specialtyWords.length) {
    try {
      const { mapCaregiverServices } = await import("./caregiverServices");
      const { matched } = await mapCaregiverServices(specialtyWords);
      if (matched.length) candidates.specialties = matched;
    } catch { /* nothing kept */ }
  }
  if (parsed.availability && typeof parsed.availability === "object" && !Array.isArray(parsed.availability)) {
    const a = parsed.availability as Record<string, unknown>;
    const days  = cleanStringArray(a.days);
    const hours = typeof a.hours === "string" ? a.hours.trim() : "";
    if (days.length || hours) candidates.availability = { days, hours };
  }
  // One or more job types (the wizard's multi-select): a list of one collapses to the string.
  if (typeof parsed.jobType === "string" && JOB_TYPES.has(parsed.jobType)) {
    candidates.jobType = parsed.jobType;
  } else if (Array.isArray(parsed.jobType)) {
    const ids = Array.from(new Set(parsed.jobType.filter((v): v is string => typeof v === "string" && JOB_TYPES.has(v))));
    if (ids.length === 1) candidates.jobType = ids[0];
    else if (ids.length > 1) candidates.jobType = ids;
  }
  // The rate is theirs to set — any amount above $0 (founder 2026-10-04); zero is never stored.
  if (typeof parsed.hourlyRate === "number" && parsed.hourlyRate > 0) {
    candidates.hourlyRate = parsed.hourlyRate;
  }
  if (typeof parsed.email === "string" && EMAIL_RE.test(parsed.email.trim().toLowerCase())) {
    candidates.email = parsed.email.trim().toLowerCase();
  }
  // Travel distance → the wizard's nearest option (5/10/15/25/50 miles).
  if (typeof parsed.serviceRadius === "number" && parsed.serviceRadius > 0) {
    const radius = toServiceRadius(parsed.serviceRadius);
    if (radius) candidates.serviceRadius = radius;
  }
  // Nothing the site's wizard doesn't collect is absorbed (certifications,
  // gender, languages, canDrive were removed 2026-09-25).

  // Zip → city/state exactly like the wizard's zippopotam.us lookup (the same
  // derivation save_onboarding_field does), so a front-loaded "20 descanso dr
  // san jose 95134" lands as "San Jose", not the caregiver's lowercase typing
  // (live 2026-09-26: the profile read "Lives in san jose"). Best-effort.
  if (typeof candidates.zipCode === "string") {
    try {
      const { lookupZipPlace } = await import("../utils/geocode");
      const place = await lookupZipPlace(candidates.zipCode);
      if (place?.city) {
        candidates.city = place.city;
        if (place.state) candidates.state = place.state;
      }
    } catch { /* keep what they typed */ }
  }

  // Only return fields that are actually new (never touch a model-saved value).
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(candidates)) {
    if (!isFieldFilled(v)) continue;
    // Availability is two pieces (days + parts of the day). A saved HALF is not
    // "filled" — merge the other half onto it instead of skipping it.
    if (k === "availability" && isFieldFilled(existing.availability) && !availabilityComplete(existing.availability)) {
      const cur = (existing.availability && typeof existing.availability === "object" && !Array.isArray(existing.availability)
        ? existing.availability : {}) as Record<string, unknown>;
      const add = v as { days: string[]; hours: string };
      const curDays  = cleanStringArray(cur.days);
      const curHours = typeof cur.hours === "string" ? cur.hours : "";
      const days  = unionCI(curDays, add.days) ?? curDays;
      const hours = add.hours || curHours;
      if (days.length !== curDays.length || hours !== curHours) out.availability = { days, hours };
      continue;
    }
    if (k === "specialties") continue; // one list on three fields — merged below
    if (isFieldFilled(existing[k])) continue;
    out[k] = v;
  }

  // Services are ONE list on three fields (specialties = skills = services, the
  // exact site strings). Absorbed services are ADDED onto what's already saved —
  // the wizard's "select all that apply" — never removed here.
  if (Array.isArray(candidates.specialties) && candidates.specialties.length) {
    const merged = mergeServices(existing, candidates.specialties as string[]);
    if (merged) { out.specialties = merged; out.skills = merged; out.services = merged; }
  }

  return out;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The saved list + the new services, in menu order; null when nothing new was added. */
function mergeServices(existing: Record<string, unknown>, added: string[]): string[] | null {
  const prev = orderedCanonicalServices([...arr(existing.skills), ...arr(existing.services), ...arr(existing.specialties)]);
  const merged = orderedCanonicalServices([...prev, ...added]);
  return merged.length !== prev.length ? merged : null;
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
    "A care provider already signed up with Evia texted a message. Extract ONLY details about the care provider themselves " +
      "that they are adding or stating in THIS message. Return JSON only; omit anything not present. Schema: " +
      `{"specialties":["care service or specialty they say they offer, e.g. 'transportation' or 'dementia care'"],` +
      `"availabilityDays":["day of week they say they're available"],` +
      `"availabilityHours":"hours they say they're available, e.g. 'mornings'"}. ` +
      "Be conservative — only include what is unambiguously about the care provider's own offering. Reply with raw JSON, no markdown.",
    text,
  ).catch(() => "{}");

  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(raw); } catch { /* keep {} */ }

  // Services: the same eight-only gate as collection — her words mapped onto the
  // site's strings, ADDED onto the saved list, written to all three fields.
  if (!out.specialties) {
    const added = cleanStringArray(parsed.specialties);
    if (added.length) {
      try {
        const { mapCaregiverServices } = await import("./caregiverServices");
        const { matched } = await mapCaregiverServices(added);
        const merged = matched.length ? mergeServices(existing, matched) : null;
        if (merged) { out.specialties = merged; out.skills = merged; out.services = merged; }
      } catch { /* best-effort */ }
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

  return out;
}
