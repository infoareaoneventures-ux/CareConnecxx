// Caregiver dual-channel sync (2026-09-23) — the caregiver-side counterpart to
// clientJobPostingContract.ts's mapJobPostingsDocToOnboardingData. A caregiver
// may answer some questions by text and others on the site's revived signup
// wizard; this reads back whatever the SITE has already collected onto
// caregivers/{uid} so Evia's own onboarding directive sees it as already known,
// the same way qaAgent.ts already does for a client's job_postings/{uid} draft.
//
// Unlike the client side, there is no separate "wizard draft" document — the
// wizard and Evia's onboardingConversation.ts's buildCaregiverProfileMirror
// both read/write the SAME caregivers/{uid} record, using mostly the same
// field names already (photo, skills/services, hourlyRate, email, bio,
// weeklyAvailability, city, zipCode). This file only needs to translate the
// handful of fields that genuinely differ in name or shape.
import { describeWeeklyAvailability, type WeeklyAvailabilityMap } from "./caregiverAvailability";

// The webapp's hyphenated jobTypes id → Evia's underscored jobType enum — the
// exact reverse of onboardingContract.ts's JOB_TYPE_TO_WEB_ID.
const WEB_ID_TO_JOB_TYPE: Record<string, string> = {
  occasional:  "occasional",
  "part-time": "part_time",
  "full-time": "full_time",
};

function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

export function mapCaregiversDocToOnboardingData(
  d: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!d) return out;

  const copy = (key: string, v: unknown) => { if (v !== undefined && v !== null && v !== "") out[key] = v; };

  copy("name",     d.name);
  copy("city",     d.city);
  copy("zipCode",  d.zipCode);
  copy("street",   d.street);
  copy("state",    d.state);
  copy("email",    d.email);
  copy("bio",      d.bio);
  copy("gender",   d.gender);
  copy("hourlyRate", d.hourlyRate);
  copy("yearsExperience", d.yearsExperience ?? d.experience);
  copy("canDrive", d.canDrive);
  if (Array.isArray(d.languages) && d.languages.length) out.languages = d.languages;

  // The wizard's own field is `photo`; Evia's onboarding-data field is
  // `profilePhoto` (buildCaregiverProfileMirror's forward direction mirrors
  // profilePhoto onto photo/photoURL — this is the reverse of that same alias).
  copy("profilePhoto", d.photo ?? d.profilePhoto);

  // skills/services (canonical, post-canonicalization) is the specialties list
  // both channels already share — Evia's own field for this is `specialties`.
  const skills = Array.isArray(d.skills) ? d.skills
    : Array.isArray(d.services) ? d.services
    : undefined;
  if (Array.isArray(skills) && skills.length) out.specialties = skills;

  // jobTypes (array, hyphenated ids, wizard is single-select despite the array
  // type) → jobType (Evia's singular, underscored field). Reverse of
  // onboardingContract.ts's caregiverJobTypesToWebIds.
  if (Array.isArray(d.jobTypes) && d.jobTypes.length) {
    const first = String(d.jobTypes[0] ?? "").trim().toLowerCase();
    const jobType = WEB_ID_TO_JOB_TYPE[first];
    if (jobType) out.jobType = jobType;
  }

  // weeklyAvailability (structured block map) → availability (Evia's own
  // conversational {days, hours} shape). Best-effort, for context only — this
  // never gets written back, only read into the "already known" summary.
  const weekly = d.weeklyAvailability as WeeklyAvailabilityMap | undefined;
  if (weekly && typeof weekly === "object" && Object.keys(weekly).length) {
    const days = Object.keys(weekly)
      .filter((day) => Array.isArray(weekly[day]) && weekly[day].length > 0)
      .map(cap);
    const hours = describeWeeklyAvailability(weekly);
    if (days.length || hours) out.availability = { days, hours };
  }

  return out;
}
