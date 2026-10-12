// The caregiver record mirror — ONE writer for everything Evia collects over
// text landing on caregivers/{uid}, the record the site's wizard, profile page
// and dashboard read (founder, 2026-09-25: one questionnaire, two doors).
//
// Pure leaf (firebase-admin only, no conversation imports) so the MCP save
// tool, the inbound absorber and the gate machinery can all mirror a field the
// moment it is saved — the way the site's wizard saves every step to the record
// immediately (caregiver sweep C3, 2026-10-11).
//
// Rules (caregiver sweep C4/C7, 2026-10-11):
//   - the record gets the SITE's field names only: jobTypes (hyphenated ids),
//     weeklyAvailability (the grid), rateFor2Seniors / rateFor3PlusSeniors /
//     maxClients, photo (+ photoURL/profilePhoto readers), skills/services.
//     Nothing server-side reads a singular `jobType` on the record — it is no
//     longer written.
//   - wizardStep NEVER moves backwards: the record's cursor wins when it is
//     further along than what the text draft computes.
//   - MERGE, never overwrite: a field the record already holds is rewritten only
//     when the session collected a newer value for it THIS save (changedKeys);
//     with no changedKeys (a re-link, the payout finalization) only fields the
//     record lacks are filled. Later site edits are never clobbered.
//   - coords are NOT mirrored at all (2026-10-11): caregivers/{uid}.lat/lng
//     have one owner, triggers/caregiverGeocode.ts, which geocodes the street
//     fields this mirror writes (street first, ZIP/city fallback) and stamps
//     geoPrecision. The text draft never carries a ZIP-level point any more.
import * as admin from "firebase-admin";
import { deriveWeeklyAvailability } from "./caregiverAvailability";
import {
  availabilityComplete,
  caregiverJobTypesToWebIds,
  isFieldFilled,
  toExperienceBucket,
} from "./onboardingContract";
import { MAX_CLIENTS_OPTIONS } from "./onboardingContract";

/** The site wizard's step ids in order (CaregiverOnboardingWizard.tsx stepsArr; email is skipped when on file). */
export const WIZARD_STEP_ORDER: readonly string[] = ["welcome", "location", "email", "photo", "availability", "services", "rates", "bio", "done"];

function wizardStepIndex(step: unknown): number {
  if (typeof step !== "string") return -1;
  // A record parked on the retired transport-docs step resumes at rates (the wizard's own rule).
  const s = step === "transport-docs" ? "rates" : step;
  return WIZARD_STEP_ORDER.indexOf(s);
}

/** The wizard step id the caregiver would resume at, from what Evia has collected so far (mirrors the wizard's step list). */
export function wizardStepForDraft(d: Record<string, unknown>): string | null {
  const has = (k: string) => isFieldFilled(d[k]);
  if (!(has("street") && has("zipCode") && has("city") && has("state"))) return "location";
  if (!has("profilePhoto")) return "photo";
  if (!((has("jobType") || has("jobTypes")) && availabilityComplete(d.availability))) return "availability";
  if (!(has("specialties") && has("yearsExperience"))) return "services";
  if (!(has("hourlyRate") && has("serviceRadius"))) return "rates";
  if (!has("bio")) return "bio";
  return "done";
}

/** Site-shape value for the optional "max clients" select ("1" | "2" | "3+"), else null. */
export function toMaxClients(value: unknown): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (MAX_CLIENTS_OPTIONS.includes(s)) return s;
  const n = Number(s.replace(/\+$/, ""));
  if (!Number.isFinite(n)) return null;
  if (n >= 3) return "3+";
  if (n === 2) return "2";
  if (n === 1) return "1";
  return null;
}

// The caregiver-doc field mapping for everything collected over SMS. Only
// DEFINED values are included: a merge with this object can never blank a
// field another path already set. The gating fields (status, onboardingStatus,
// verificationStatus, membershipSubscriptionId) are deliberately NOT here —
// they belong to the step machinery exclusively.
export function buildCaregiverProfileMirror(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const copy = (key: string, v: unknown): void => {
    if (v !== undefined && v !== null && v !== "") out[key] = v;
  };

  copy("name",    d.name);
  // phone self-heals on every merge (2026-09-06): a record that missed the
  // creation-time write otherwise stayed without a phone forever.
  copy("phone",   d.phone);
  // Wizard location step (2026-09-25): street + state alongside city/zip.
  copy("street",  d.street);
  copy("state",   d.state);
  copy("city",    d.city);
  copy("zipCode", d.zipCode);
  // No coords: triggers/caregiverGeocode.ts derives lat/lng/latitude/longitude
  // (+ geoPrecision) from the street fields above on this very write. NEVER
  // write `location` as a {lat,lng} OBJECT either: the webapp renders caregiver
  // `location` as a display string (React #31, live 2026-07-15).
  // Profile photo: `photo` is the site's canonical field (the profile page's
  // AvatarUpload writes it); photoURL/profilePhoto are what older readers use.
  if (d.profilePhoto) {
    out.profilePhoto = d.profilePhoto;
    out.photoURL     = d.profilePhoto;
    out.photo        = d.profilePhoto;
  }
  // Experience is the wizard's bucket string on BOTH fields the site writes.
  const expBucket = toExperienceBucket(d.yearsExperience);
  if (expBucket) {
    out.yearsExperience = expBucket;
    out.experience      = expBucket;
  }
  // specialties = skills = services: the website's eight, canonicalized at
  // save time (caregiverServices.ts). Prefer the canonical skills; fall back to
  // raw specialties only for legacy docs saved before canonicalization existed.
  if (Array.isArray(d.specialties) && d.specialties.length) out.specialties = d.specialties;
  const skills = Array.from(new Set([
    ...(Array.isArray(d.skills)       ? d.skills       as string[] : []),
    ...(Array.isArray(d.services)     ? d.services     as string[] : []),
    ...((!Array.isArray(d.skills) || !d.skills.length) &&
        (!Array.isArray(d.services) || !d.services.length) &&
        Array.isArray(d.specialties) ? d.specialties as string[] : []),
  ]));
  if (skills.length) {
    out.skills = skills;
    out.services = skills;
    // The wizard's services step also writes primaryServices [{name, yearsExperience}].
    if (expBucket) out.primaryServices = skills.map((name) => ({ name, yearsExperience: expBucket }));
  }
  // The site's availability field is the grid (weeklyAvailability) — derived
  // only once BOTH halves are stated so a partial answer never paints parts of
  // the day the caregiver never chose (live 2026-09-26). Evia's own {days,
  // hours} answer stays on the session, not the record (C7, 2026-10-11).
  if (availabilityComplete(d.availability)) {
    const weekly = deriveWeeklyAvailability(d.availability);
    if (weekly) out.weeklyAvailability = weekly;
  }
  copy("hourlyRate", d.hourlyRate);
  // The wizard's rates step: travel distance (5/10/15/25/50 miles) plus the
  // optional rates for two / three-or-more seniors and max clients, under the
  // profile page's names (founder, 2026-10-11: rateFor2Seniors /
  // rateFor3PlusSeniors, never rateForTwo/rateForThree).
  if (typeof d.serviceRadius === "number" && d.serviceRadius > 0) out.serviceRadius = d.serviceRadius;
  if (typeof d.rateFor2Seniors === "number" && d.rateFor2Seniors >= 0) out.rateFor2Seniors = d.rateFor2Seniors;
  if (typeof d.rateFor3PlusSeniors === "number" && d.rateFor3PlusSeniors >= 0) out.rateFor3PlusSeniors = d.rateFor3PlusSeniors;
  const maxClients = toMaxClients(d.maxClients);
  if (maxClients) out.maxClients = maxClients;
  copy("email",      d.email);
  copy("bio",        d.bio);
  // The site's "Looking for" field: jobTypes, an array of hyphenated ids (the
  // wizard's multi-select). The singular underscored jobType stays on the
  // session only — nothing server-side reads it from the record (C7).
  const jobTypes = caregiverJobTypesToWebIds(d.jobType, d.jobTypes);
  if (jobTypes.length) out.jobTypes = jobTypes;
  copy("stripeAccountId", d.stripeAccountId);
  // The site's wizard resumes from `wizardStep`; stamp where Evia's collection
  // stands so a caregiver who opens the site mid-text lands on the right step.
  const wizardStep = wizardStepForDraft(d);
  if (wizardStep) out.wizardStep = wizardStep;
  return out;
}

// Which session (draft) keys feed each record field — the merge rule's map.
const SERVICE_KEYS = ["specialties", "skills", "services"] as const;
const MIRROR_SOURCES: Record<string, readonly string[]> = {
  name: ["name"], phone: ["phone"],
  street: ["street"], state: ["state"], city: ["city"], zipCode: ["zipCode"],
  profilePhoto: ["profilePhoto"], photoURL: ["profilePhoto"], photo: ["profilePhoto"],
  yearsExperience: ["yearsExperience"], experience: ["yearsExperience"],
  specialties: SERVICE_KEYS, skills: SERVICE_KEYS, services: SERVICE_KEYS,
  primaryServices: [...SERVICE_KEYS, "yearsExperience"],
  weeklyAvailability: ["availability"],
  hourlyRate: ["hourlyRate"], serviceRadius: ["serviceRadius"],
  rateFor2Seniors: ["rateFor2Seniors"], rateFor3PlusSeniors: ["rateFor3PlusSeniors"], maxClients: ["maxClients"],
  email: ["email"], bio: ["bio"],
  jobTypes: ["jobType", "jobTypes"],
  stripeAccountId: ["stripeAccountId"],
};

function recordHasGrid(existing: Record<string, unknown>): boolean {
  const grid = existing.weeklyAvailability;
  return !!grid && typeof grid === "object"
    && Object.values(grid as Record<string, unknown>).some((v) => Array.isArray(v) && v.length > 0);
}

/**
 * What the record may actually be written with, given what it already holds.
 *
 * `changedKeys` = the session keys collected THIS save. A record field fed by
 * one of them is rewritten (the caregiver just said so); any other field the
 * record already holds is left alone (the site may have edited it since); a
 * field the record lacks is filled from the draft either way. With no
 * changedKeys (a re-link, the payout finalization) the write is fill-only.
 *
 * wizardStep never moves backwards (the record's cursor wins when further
 * along), and is dropped entirely once the record is profile_complete — App.tsx
 * hides the wizard on that stamp and Evia's mirror must never re-open it
 * (found live 2026-09-26 after an admin revoke). Coords are never in the
 * mirror (the geocode trigger owns them).
 */
export function profileMirrorForExisting(
  mirror: Record<string, unknown>,
  existing: Record<string, unknown>,
  changedKeys?: Iterable<string>,
): Record<string, unknown> {
  const changed = new Set(changedKeys ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mirror)) {
    if (key === "wizardStep") continue; // handled below
    // "held" = the record has a real value (an empty grid / list / string is a gap to fill;
    // any finite number counts — a longitude is negative).
    const cur = existing[key];
    const held = typeof cur === "number" ? Number.isFinite(cur) : isFieldFilled(cur);
    if (!held) { out[key] = value; continue; }
    const sources = MIRROR_SOURCES[key] ?? [key];
    const changedThisSave = sources.some((s) => changed.has(s));
    if (!changedThisSave) continue;
    // The grid the site holds is re-derived only when the availability answer itself changed this save.
    if (key === "weeklyAvailability" && recordHasGrid(existing) && !changed.has("availability")) continue;
    out[key] = value;
  }
  if (existing.onboardingStatus !== "profile_complete" && typeof mirror.wizardStep === "string") {
    const next = mirror.wizardStep;
    // Only ever FORWARD (or a record with no cursor yet); an equal step is not rewritten.
    if (wizardStepIndex(next) > wizardStepIndex(existing.wizardStep)) out.wizardStep = next;
  }
  return out;
}

/**
 * Mirror the (merged) text draft onto caregivers/{uid} — the site's record —
 * under the merge rule above. Non-fatal: a mirror failure must never break the
 * conversation turn. Returns the patch written (empty when nothing changed).
 */
export async function mirrorCaregiverDraftToRecord(
  caregiverId: string,
  draft: Record<string, unknown>,
  changedKeys?: Iterable<string>,
): Promise<Record<string, unknown>> {
  const db = admin.firestore();
  const cgRef = db.collection("caregivers").doc(caregiverId);
  const current = (await cgRef.get().catch(() => null))?.data() ?? {};
  const patch = profileMirrorForExisting(buildCaregiverProfileMirror(draft), current, changedKeys);
  if (Object.keys(patch).length === 0) return patch;
  await cgRef.set(patch, { merge: true })
    .catch((err) => console.error("mirrorCaregiverDraftToRecord: caregiver profile mirror failed (non-fatal):", err));
  return patch;
}
