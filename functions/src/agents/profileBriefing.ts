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
//
// Authority (U6, memory-grounding plan): this briefing is a SIGNUP SNAPSHOT —
// the lowest-priority memory layer. Callers that hold the canonical live
// profile (senior_profiles via data/seniorProfileRepository) pass it as the
// second argument; any field canonical also carries (recipient name, location,
// care needs, conditions) is then presented FROM canonical, so the snapshot
// fills gaps but can never contradict newer canonical data. The snapshot never
// emits an age fact at all, so canonical age cannot be overridden here.

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

export function describeSharedProfile(
  session: SessionLike,
  // Canonical senior profile (senior_profiles doc data, canonical-first via
  // seniorProfileRepository). Optional: mid-signup surfaces have no canonical
  // profile yet and pass nothing — the snapshot then stands alone.
  canonicalProfile?: Record<string, unknown> | null,
): string {
  const d = (session?.onboardingData ?? {}) as Record<string, unknown>;
  const userType = String(session?.userType ?? "");
  const facts: string[] = [];

  if (userType === "caregiver") {
    // Canonical-wins (U6), same rule the client branch below already follows —
    // this branch used to ignore canonicalProfile entirely, so a caregiver's
    // own facts (name, rate, availability, etc.) could go stale for the
    // lifetime of their account instead of just during signup.
    const canon = (canonicalProfile ?? {}) as Record<string, unknown>;
    const name = String(canon.name ?? d.name ?? "").trim();
    if (name) facts.push(`name: ${name}`);
    const canonLoc = describeLocation({ city: canon.city, zipCode: canon.zipCode });
    const loc = canonLoc || describeLocation(d);
    if (loc) facts.push(`location: ${loc}`);
    const years = canon.yearsExperience ?? canon.experience ?? d.yearsExperience;
    if (typeof years === "number" && years > 0) facts.push(`experience: ${years} year${years === 1 ? "" : "s"}`);
    const specialties = asList(canon.specializations) || asList(canon.specialties) || asList(canon.skills)
      || asList(d.specialties) || asList(d.services) || asList(d.skills);
    if (specialties) facts.push(`specialties: ${specialties}`);
    const avail = describeAvailability(canon.weeklyAvailability ?? canon.availability) || describeAvailability(d.availability);
    if (avail) facts.push(`availability: ${avail}`);
    const jobType = asList(canon.jobTypes) || String(d.jobType ?? "").trim().replace(/_/g, "-");
    if (jobType) facts.push(`work type: ${jobType}`);
    const rate = canon.hourlyRate ?? d.hourlyRate;
    if (typeof rate === "number" && rate > 0) facts.push(`rate: $${rate}/hr`);
    const email = String(canon.email ?? d.email ?? "").trim();
    if (email) facts.push(`email: ${email}`);
    const languages = asList(canon.languages) || asList(d.languages);
    if (languages) facts.push(`languages: ${languages}`);
    const certs = asList(canon.certifications) || asList(d.certifications);
    if (certs) facts.push(`certifications: ${certs}`);
    const canDrive = canon.canDrive !== undefined ? canon.canDrive : d.canDrive;
    if (canDrive !== undefined && !declined(canDrive)) {
      facts.push(`can drive: ${String(canDrive) === "true" || canDrive === true || String(canDrive) === "yes" ? "yes" : "no"}`);
    }
  } else {
    // Client/family — who's-who first (mandatory whenever a client name is
    // interpolated into family-facing LLM context; see careRecipients.ts).
    // Canonical-wins precedence (U6): where the canonical live profile carries
    // a value, it is presented instead of the possibly-stale signup answer.
    const canon = (canonicalProfile ?? {}) as Record<string, unknown>;
    const canonLoc = describeLocation({ city: canon.location, zipCode: canon.zipCode });
    const loc = canonLoc || describeLocation(d);
    if (loc) facts.push(`location: ${loc}`);
    const careNeeds = asList(canon.needs) || asList(d.careNeeds);
    if (careNeeds) facts.push(`care needs: ${careNeeds}`);
    const conditions = asList(canon.diagnoses) || asList(d.conditions);
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

    // Canonical recipient name wins in the who's-who framing — a renamed/
    // corrected senior_profiles.name must not be undercut by the signup answer.
    const canonName = String(canon.name ?? "").trim();
    const whoIsWho = describeWhoIsWho(canonName ? { ...d, seniorName: canonName } : d);
    if (!facts.length) return whoIsWho; // nothing shared yet — who's-who alone (may also be "")
    return `${whoIsWho ? `${whoIsWho} ` : ""}${INSTRUCTION}${facts.join("; ")}.`;
  }

  if (!facts.length) return "";
  return `${INSTRUCTION}${facts.join("; ")}.`;
}
