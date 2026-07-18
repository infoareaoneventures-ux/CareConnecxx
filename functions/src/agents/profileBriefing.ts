// ── Shared "what they've already told you" briefing ──────────────────────────
// One grounding block, built from agent_sessions.onboardingData, that EVERY
// LLM reply path answering a user question must include in its prompt.
//
// Why (live bug, Hamse 2026-07-17): at parked/awaiting gate steps the quick
// reply path's only grounding was the user's name + static step facts + the
// live gate fact — none of the profile the user had already shared. A recall
// question ("what zip code did I share with you?") therefore hit the
// anti-invention rules with an empty context and produced a truthful-sounding
// denial ("I don't have your zip showing in this chat") even though the data
// had been saved to Firestore all along. Same defect class as the who's-who
// conflation (2026-07-17) and the payout-permissions false grounding
// (2026-07-14): a reply path assembled too thin a briefing.
//
// Rule: any new LLM reply surface that answers free-form user questions
// mid-signup or mid-flow includes describeSharedProfile(session) in its
// prompt. Facts only, already-collected only — this block never asks for
// anything and never speculates; empty fields are simply omitted.

import { describeWhoIsWho } from "./careRecipients";

type SessionLike = {
  userType?: unknown;
  onboardingData?: Record<string, unknown> | null;
} | null | undefined;

const ZIP_RE = /^\d{5}(-\d{4})?$/;

// The loop's service-area ZIP fallback (and users who answer "what city?" with
// a ZIP) can leave a bare ZIP in the `city` field — present it as a ZIP, never
// as "city 95130".
export function describeLocation(d: Record<string, unknown>): string {
  const city = String(d.city ?? "").trim();
  const zip  = String(d.zipCode ?? "").trim();
  const cityIsZip = ZIP_RE.test(city);
  if (cityIsZip) return `ZIP ${zip || city}`;
  if (city && zip) return `${city} (ZIP ${zip})`;
  if (city) return city;
  if (zip)  return `ZIP ${zip}`;
  return "";
}

function asList(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean).join(", ");
  return String(value ?? "").trim();
}

// "prefer_not_to_answer" is a declined question, not a shared fact.
function declined(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "prefer_not_to_answer";
}

function describeAvailability(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    const a = value as Record<string, unknown>;
    const days  = asList(a.days);
    const hours = String(a.hours ?? "").trim();
    if (days && hours) return `${days} (${hours})`;
    return days || hours;
  }
  return "";
}

const INSTRUCTION =
  "THEY'VE ALREADY SHARED (saved from this signup — when they ask what they told you, e.g. their city, ZIP, " +
  "rate, schedule, or email, answer DIRECTLY from these facts; never say you don't have them or ask them to " +
  "resend; if a detail is truly not listed here, only then say you don't have that one yet): ";

export function describeSharedProfile(session: SessionLike): string {
  const d = (session?.onboardingData ?? {}) as Record<string, unknown>;
  const userType = String(session?.userType ?? "");
  const facts: string[] = [];

  if (userType === "caregiver") {
    const name = String(d.name ?? "").trim();
    if (name) facts.push(`name: ${name}`);
    const loc = describeLocation(d);
    if (loc) facts.push(`location: ${loc}`);
    const years = d.yearsExperience;
    if (typeof years === "number" && years > 0) facts.push(`experience: ${years} year${years === 1 ? "" : "s"}`);
    const specialties = asList(d.specialties) || asList(d.services) || asList(d.skills);
    if (specialties) facts.push(`specialties: ${specialties}`);
    const avail = describeAvailability(d.availability);
    if (avail) facts.push(`availability: ${avail}`);
    const jobType = String(d.jobType ?? "").trim().replace(/_/g, "-");
    if (jobType) facts.push(`work type: ${jobType}`);
    const rate = d.hourlyRate;
    if (typeof rate === "number" && rate > 0) facts.push(`rate: $${rate}/hr`);
    const email = String(d.email ?? "").trim();
    if (email) facts.push(`email: ${email}`);
    const languages = asList(d.languages);
    if (languages) facts.push(`languages: ${languages}`);
    const certs = asList(d.certifications);
    if (certs) facts.push(`certifications: ${certs}`);
    if (d.canDrive !== undefined && !declined(d.canDrive)) {
      facts.push(`can drive: ${String(d.canDrive) === "true" || d.canDrive === true || String(d.canDrive) === "yes" ? "yes" : "no"}`);
    }
  } else {
    // Client/family — who's-who first (mandatory whenever a client name is
    // interpolated into family-facing LLM context; see careRecipients.ts).
    const loc = describeLocation(d);
    if (loc) facts.push(`location: ${loc}`);
    const careNeeds = asList(d.careNeeds);
    if (careNeeds) facts.push(`care needs: ${careNeeds}`);
    const conditions = asList(d.conditions);
    if (conditions) facts.push(`conditions mentioned: ${conditions}`);
    const days = asList(d.daysPerWeek);
    if (days) facts.push(`days per week: ${days}`);
    const timeOfDay = asList(d.timeOfDay);
    if (timeOfDay) facts.push(`time of day: ${timeOfDay}`);
    const hoursPerDay = String(d.hoursPerDay ?? "").trim();
    if (hoursPerDay) facts.push(`hours per day: ${hoursPerDay}`);
    const schedule = String(d.schedule ?? "").trim();
    if (schedule) facts.push(`schedule: ${schedule}`);
    const startDate = String(d.startDate ?? "").trim();
    if (startDate) facts.push(`start: ${startDate}`);
    const budget = String(d.budget ?? "").trim();
    if (budget) facts.push(`budget: ${budget}`);

    const whoIsWho = describeWhoIsWho(d);
    if (!facts.length) return whoIsWho; // nothing shared yet — who's-who alone (may also be "")
    return `${whoIsWho ? `${whoIsWho} ` : ""}${INSTRUCTION}${facts.join("; ")}.`;
  }

  if (!facts.length) return "";
  return `${INSTRUCTION}${facts.join("; ")}.`;
}
