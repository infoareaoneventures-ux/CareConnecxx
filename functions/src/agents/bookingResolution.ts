// Shared booking-field resolution — extracted 2026-09-13 from mcp/server.ts's
// request_booking case so this logic has exactly ONE home instead of being
// duplicated between the MCP tool and the new scripted bookingFlow.ts. Every
// function here is a pure(ish) read + resolve step; callers (the MCP tool,
// the flow) decide what to DO with an unresolved/ambiguous result — a
// toolError for the tool, a conversational question for the flow.
import * as admin from "firebase-admin";
import { resolveCaregiverName, coerceHourlyRate } from "../utils/caregiverRate";
import { multiRecipientScopingEnabled } from "../config/featureFlags";
import { resolveRecipientKey, recipientPlanKey } from "./careRecipients";

const db = admin.firestore();

// "HH:MM" → minutes since midnight, or null if malformed.
export function bookingTimeToMinutes(t: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export function parseBookingDateRange(input: {
  dates?:     unknown;
  startTime?: unknown;
  endTime?:   unknown;
}): { ok: true; dateList: string[]; durationHours: number } | { ok: false; message: string } {
  if (!input.dates || !input.startTime || !input.endTime) {
    return { ok: false, message: "dates, startTime, endTime are required" };
  }
  const dateList = (Array.isArray(input.dates) ? input.dates : [input.dates]).map(String).filter(Boolean);
  if (dateList.length === 0) return { ok: false, message: "at least one date is required" };

  const startMin = bookingTimeToMinutes(input.startTime);
  const endMin   = bookingTimeToMinutes(input.endTime);
  if (startMin === null || endMin === null || endMin <= startMin) {
    return { ok: false, message: "startTime/endTime must be 'HH:MM' with end after start" };
  }
  const durationHours = Math.round(((endMin - startMin) / 60) * 100) / 100;
  return { ok: true, dateList, durationHours };
}

export interface InterviewLinkage {
  jobId?: string;
  jobTitle?: string;
  applicationId?: string;
  jobPostSchedule?: { daysOfWeek?: string[]; startDate?: string; endDate?: string };
  jobPostRate?: number;
}

// Fail-soft throughout (mirrors the original inline try/catch): a lookup miss
// or ownership mismatch just proceeds as an unlinked booking, never blocks it.
export async function resolveInterviewLinkage(
  clientId: string, caregiverId: string | undefined, interviewId: string | undefined,
): Promise<InterviewLinkage> {
  if (!interviewId) return {};
  try {
    const ivSnap = await db.collection("video_interviews").doc(interviewId).get();
    const iv = ivSnap.data();
    if (!iv || iv.clientId !== clientId || iv.caregiverId !== caregiverId) return {};
    const applicationId = iv.applicationId as string | undefined;
    if (!applicationId) return {};
    const appSnap = await db.collection("job_applications").doc(applicationId).get();
    const jobId = appSnap.data()?.jobId as string | undefined;
    if (!jobId) return { applicationId };
    const jobSnap = await db.collection("job_posts").doc(jobId).get();
    const jobData = jobSnap.data();
    const jobTitle = jobData?.title as string | undefined;
    const daysOfWeek = jobData?.daysOfWeek as string[] | undefined;
    const jps: { daysOfWeek?: string[]; startDate?: string; endDate?: string } = {};
    if (Array.isArray(daysOfWeek) && daysOfWeek.length) jps.daysOfWeek = daysOfWeek;
    if (jobData?.startDate) jps.startDate = String(jobData.startDate);
    if (jobData?.endDate) jps.endDate = String(jobData.endDate);
    const coercedJobRate = coerceHourlyRate(jobData?.rate);
    return {
      applicationId, jobId, jobTitle,
      ...(Object.keys(jps).length ? { jobPostSchedule: jps } : {}),
      ...(coercedJobRate !== null ? { jobPostRate: coercedJobRate } : {}),
    };
  } catch (e) {
    console.warn("[bookingResolution] interview/job linkage lookup failed (booking proceeds unlinked):", e);
    return {};
  }
}

export const NO_RATE_MESSAGE =
  "No agreed rate is set for this booking. The website's own booking modal blocks sending until a " +
  "specific rate is confirmed — it never assumes the caregiver's own listed rate. Ask the family " +
  "(and caregiver, if not already agreed) what hourly rate this booking is at, and pass it as agreedRate.";

// Matches the website's own modal precedence exactly
// (bookingDraft.agreedRate ?? post?.rate ?? null): an explicit agreedRate the
// family gave, else the linked job post's own rate, else refuse. The
// caregiver's own listed hourlyRate is browsing/display data only and is
// NEVER used as a booking default on the site — never resolve it that way here.
export function resolveBookingRate(
  agreedRate: unknown, jobPostRate: number | undefined,
): { ok: true; hourlyRate: number } | { ok: false; reason: string } {
  if (agreedRate !== undefined && agreedRate !== null) return { ok: true, hourlyRate: Number(agreedRate) };
  if (jobPostRate !== undefined) return { ok: true, hourlyRate: jobPostRate };
  return { ok: false, reason: NO_RATE_MESSAGE };
}

export interface CaregiverNameResolution {
  ok: true; caregiverName: string;
}
export async function resolveBookingCaregiverName(
  caregiverId: string,
): Promise<CaregiverNameResolution | { ok: false; message: string }> {
  const nameRes = await resolveCaregiverName(caregiverId);
  if (!nameRes.ok) return { ok: false, message: nameRes.message };
  return { ok: true, caregiverName: nameRes.caregiverName };
}

export interface LocationOption {
  street?: string; city?: string; state?: string; zipCode?: string;
  petsInHome?: boolean; smokingHousehold?: boolean;
}

export type CareLocationResolution =
  | { ok: true; location: string }
  | { ok: false; ambiguous: true; options: LocationOption[] }
  | { ok: false; ambiguous: false; reason: string };

// Care location — REQUIRED, matching the website's own "Care Location"
// selector (carePlans/{uid}.locationPool — the SAME saved/tagged addresses
// the site's multi-address picker offers, e.g. a primary home plus a
// "Smoking household" alternate). When the family has more than one saved
// address on file and the caller hasn't already named one, this refuses with
// the real options (with their tags) so the caller can offer the SAME
// choices the site shows — never silently guess which one, never ask the
// family to type an address from scratch when one is already on file. Only
// when nothing is saved at all does it fall back to a single on-file
// address, then finally refuse.
export async function resolveCareLocation(
  clientId: string, careLocation: unknown,
): Promise<CareLocationResolution> {
  if (careLocation) return { ok: true, location: String(careLocation) };

  try {
    const cpSnapForLoc = await db.collection("carePlans").doc(clientId).get();
    const pool = (cpSnapForLoc.data()?.locationPool ?? []) as LocationOption[];
    const validPool = pool.filter((a) => a && [a.street, a.city, a.state, a.zipCode].some(Boolean));
    if (validPool.length === 1) {
      const a = validPool[0];
      return { ok: true, location: [a.street, a.city, a.state, a.zipCode].filter(Boolean).join(", ") };
    }
    if (validPool.length > 1) {
      return { ok: false, ambiguous: true, options: validPool };
    }
  } catch (e) {
    console.warn("[bookingResolution] care location pool lookup failed:", e);
  }

  try {
    const clientSnapForAddr = await db.collection("users").doc(clientId).get();
    const cd = clientSnapForAddr.data() ?? {};
    const onFileAddress = [cd.street, cd.city, cd.state, cd.zipCode].filter(Boolean).join(", ");
    if (onFileAddress) return { ok: true, location: onFileAddress };
  } catch (e) {
    console.warn("[bookingResolution] client address lookup failed:", e);
  }

  return {
    ok: false, ambiguous: false,
    reason: "No care location is on file for this family and none was given. Ask where care will happen " +
      "(their home address, or a specific facility/location) and pass it as careLocation before booking — " +
      "matching the website's own required 'Care Location' field.",
  };
}

// Formats the same ambiguous-address listing the MCP tool's toolError used to
// inline — kept here so both callers render identical option text/tags.
export function formatCareLocationOptions(options: LocationOption[]): string {
  return options.map((a, i) => {
    const addr = [a.street, a.city, a.state, a.zipCode].filter(Boolean).join(", ");
    const tags = [a.petsInHome ? "pets in home" : null, a.smokingHousehold ? "smoking household" : null]
      .filter(Boolean).join(", ");
    return `${i + 1}) ${addr}${tags ? ` (${tags})` : ""}`;
  }).join("; ");
}

export interface RecipientAttribution {
  recipientName?: string;
  recipientKey?: string;
  recipientResolved?: "named" | "defaulted_primary";
  careRecipients?: Array<Record<string, unknown>>;
}

// Resolve WHO this visit is for so multi-recipient households get
// correctly-attributed appointments. Only stamped when the household
// actually has 2+ recipients on file — single-recipient households keep the
// simple shape (absent = the sole recipient, fail-soft everywhere).
// Ambiguity NEVER blocks the money path: no name in a multi-home defaults to
// the primary senior + a note the caller can use to confirm.
export async function resolveRecipientAttribution(
  clientId: string, recipientFirstName: unknown, recipientFirstNames: unknown,
): Promise<RecipientAttribution> {
  const result: RecipientAttribution = {};
  try {
    if (!multiRecipientScopingEnabled()) return result;
    const webPlanSnap = await db.collection("carePlans").doc(clientId).get();
    const plans = (webPlanSnap.data()?.recipientPlans ?? {}) as Record<string, Record<string, unknown>>;
    const planKeys = Object.keys(plans);
    const names = Array.isArray(recipientFirstNames) && recipientFirstNames.length
      ? (recipientFirstNames as unknown[]).map(String)
      : (recipientFirstName ? [String(recipientFirstName)] : []);

    if (names.length > 1) {
      // Multiple named recipients for one booking (matches the website's
      // multi-select care recipients list) — resolve each independently;
      // unmatched names are simply skipped rather than blocking the whole booking.
      const resolved: Array<{ key: string; name: string }> = [];
      for (const n of names) {
        const res = resolveRecipientKey(planKeys, n);
        if (res.ok) resolved.push({ key: res.key, name: String(plans[res.key]?.name ?? n).trim() || n });
      }
      if (resolved.length) {
        result.recipientKey  = resolved[0].key;
        result.recipientName = resolved[0].name;
        result.recipientResolved = "named";
        result.careRecipients = resolved.map(({ key, name }) => {
          const plan = plans[key] ?? {};
          return {
            name,
            careNeeds:       plan.careNeeds ?? [],
            careNeedDetails: plan.careNeedDetails ?? {},
            lifestyle:       plan.lifestyle ?? {},
            notes:           plan.notes ?? "",
            // Matches the website's own per-recipient fields
            // (PostsPage.tsx's selectedRecipients build) — specific
            // tasks/locations for this recipient's care plan.
            tasks:           plan.tasks ?? {},
            locations:       plan.locations ?? [],
          };
        });
      }
    } else if (planKeys.length > 1) {
      const res = resolveRecipientKey(planKeys, names[0]);
      if (res.ok) {
        result.recipientKey  = res.key;
        result.recipientName = String(plans[res.key]?.name ?? names[0] ?? "").trim() || undefined;
        result.recipientResolved = "named";
      } else {
        const userSnap = await db.collection("users").doc(clientId).get();
        const primary = String(userSnap.data()?.seniorName ?? "").trim();
        if (primary) {
          result.recipientName = primary;
          result.recipientKey  = recipientPlanKey(primary.split(" ")[0]);
          result.recipientResolved = "defaulted_primary";
        }
      }
    }
  } catch (e) {
    console.warn("[bookingResolution] recipient attribution failed (booking proceeds unattributed):", e);
  }
  return result;
}

export interface EmergencyContact { name: string; phone: string; relationship?: string; }

// Pulled from the family's care plan on file, matching the website's own
// pre-fill (carePlans.emergencyContacts, isPrimary wins else the first on
// file). Never asked for in conversation; fail-soft if none is on file.
export async function resolveEmergencyContact(clientId: string): Promise<EmergencyContact | undefined> {
  try {
    const cpSnapForEc = await db.collection("carePlans").doc(clientId).get();
    const contacts = (cpSnapForEc.data()?.emergencyContacts ?? []) as Array<{
      name?: string; relation?: string; relationship?: string; phone?: string; isPrimary?: boolean;
    }>;
    const primaryContact = contacts.find((c) => c.isPrimary) ?? contacts[0];
    if (primaryContact?.phone) {
      return {
        name:         primaryContact.name ?? "",
        phone:        primaryContact.phone,
        relationship: primaryContact.relationship ?? primaryContact.relation,
      };
    }
  } catch (e) {
    console.warn("[bookingResolution] emergency contact lookup failed (booking proceeds without it):", e);
  }
  return undefined;
}

export interface TopLevelCareNeedsAndLifestyle {
  topLevelCareNeeds?: string[];
  lifestylePreferences?: string[];
}

// The website ALSO stamps two root-level fields onto the booking_requests doc
// itself (PostsPage.tsx's handleSendBooking) alongside the per-recipient
// careRecipients array — a deduped union of every selected recipient's
// careNeeds, and the pets-in-home/smoking-household tags of whichever saved
// address was actually picked for this visit. Fail-soft throughout; never
// blocks the booking.
export async function resolveTopLevelCareNeedsAndLifestyle(
  clientId: string,
  careRecipients: Array<Record<string, unknown>> | undefined,
  recipientKey: string | undefined,
  resolvedCareLocation: string,
): Promise<TopLevelCareNeedsAndLifestyle> {
  const result: TopLevelCareNeedsAndLifestyle = {};
  try {
    const cpSnapForNeeds = await db.collection("carePlans").doc(clientId).get();
    const cpData = cpSnapForNeeds.data() ?? {};
    const plans = (cpData.recipientPlans ?? {}) as Record<string, Record<string, unknown>>;
    if (careRecipients?.length) {
      const union = new Set<string>();
      for (const r of careRecipients) for (const n of (r.careNeeds as string[] | undefined) ?? []) union.add(n);
      if (union.size) result.topLevelCareNeeds = Array.from(union);
    } else {
      const soleKey = recipientKey ?? (Object.keys(plans).length === 1 ? Object.keys(plans)[0] : undefined);
      const needs = soleKey ? (plans[soleKey]?.careNeeds as string[] | undefined) : undefined;
      if (needs?.length) result.topLevelCareNeeds = needs;
    }

    const pool = (cpData.locationPool ?? []) as LocationOption[];
    const selectedEntry = pool.find(
      (a) => a && [a.street, a.city, a.state, a.zipCode].filter(Boolean).join(", ") === resolvedCareLocation,
    );
    if (selectedEntry) {
      const tags = [
        selectedEntry.petsInHome ? "Pets in home" : null,
        selectedEntry.smokingHousehold ? "Smoking household" : null,
      ].filter((t): t is string => t !== null);
      if (tags.length) result.lifestylePreferences = tags;
    }
  } catch (e) {
    console.warn("[bookingResolution] top-level care needs/lifestyle lookup failed (booking proceeds without them):", e);
  }
  return result;
}

// Per-recipient age/relationship — matches the website's own recipient cards
// (e.g. "parent · Age 22"). NOT on carePlans.recipientPlans at all — lives on
// job_postings/{clientUid} (the household profile doc, keyed by client, not
// by job post): the primary recipient's own
// careRecipientFirstName/LastName/Age + top-level relationship, plus an
// additionalRecipients array for everyone else. Matched onto careRecipients
// by first name; only enriches the multi-recipient array already built.
export async function enrichRecipientAgeRelationship(
  clientId: string, careRecipients: Array<Record<string, unknown>> | undefined,
): Promise<Array<Record<string, unknown>> | undefined> {
  if (!careRecipients?.length) return careRecipients;
  try {
    const jpSnap = await db.collection("job_postings").doc(clientId).get();
    const jp = jpSnap.data() ?? {};
    const jpRecipients: Array<{ firstName: string; age?: string; relationship?: string }> = [];
    if (jp.careRecipientFirstName) {
      jpRecipients.push({
        firstName:    String(jp.careRecipientFirstName),
        age:          jp.careRecipientAge as string | undefined,
        relationship: jp.relationship as string | undefined,
      });
    }
    for (const r of (jp.additionalRecipients ?? []) as Array<{ firstName?: string; age?: string; relationship?: string }>) {
      if (r?.firstName) jpRecipients.push({ firstName: String(r.firstName), age: r.age, relationship: r.relationship });
    }
    if (!jpRecipients.length) return careRecipients;
    return careRecipients.map((r) => {
      const firstName = String(r.name ?? "").split(" ")[0].toLowerCase();
      const match = jpRecipients.find((jr) => jr.firstName.toLowerCase() === firstName);
      return match ? { ...r, ...(match.age ? { age: match.age } : {}), ...(match.relationship ? { relationship: match.relationship } : {}) } : r;
    });
  } catch (e) {
    console.warn("[bookingResolution] recipient age/relationship lookup failed (booking proceeds without them):", e);
    return careRecipients;
  }
}
