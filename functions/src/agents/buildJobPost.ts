import * as admin from "firebase-admin";
import axios from "axios";
import { notifyAreaCaregivers } from "../triggers/jobNotifications";
import { recipientPlanKey, normalizeAdditionalRecipients, allCareRecipients } from "./careRecipients";
import { buildWebJobPostDoc } from "./jobPostContract";

const db = admin.firestore();

// ── Geocoding (zippopotam.us — free, no API key) ──────────────────────────────

async function geocodeZip(zipCode: string): Promise<{ lat: number; lng: number } | null> {
  if (!zipCode || zipCode.length < 5) return null;
  try {
    const resp = await axios.get(`https://api.zippopotam.us/us/${zipCode}`, { timeout: 5000 });
    const place = resp.data?.places?.[0];
    if (place?.latitude && place?.longitude) {
      return { lat: parseFloat(place.latitude), lng: parseFloat(place.longitude) };
    }
  } catch {
    // Non-critical — job post will still be created, just without radius notifications
  }
  return null;
}

// City-name fallback (OpenStreetMap Nominatim — free, no key). The conversational
// intake captures a CITY ("Santa Clara") but usually no ZIP, so geocodeZip alone
// left jobs with no coordinates and notifyAreaCaregivers silently notified nobody.
// State defaults to California (service area is Santa Clara County) when the
// intake didn't capture one, so a bare city name isn't ambiguous across states.
async function geocodeCity(city: string, state?: string): Promise<{ lat: number; lng: number } | null> {
  if (!city || !city.trim()) return null;
  try {
    const resp = await axios.get("https://nominatim.openstreetmap.org/search", {
      params: { format: "json", country: "USA", state: state || "California", city: city.trim(), limit: 1 },
      headers: { "User-Agent": "EviaCares/1.0 (support@eviacares.com)" },
      timeout: 5000,
    });
    const place = resp.data?.[0];
    if (place?.lat && place?.lon) {
      return { lat: parseFloat(place.lat), lng: parseFloat(place.lon) };
    }
  } catch {
    // Non-critical — fall through to no-coords (city-string match still applies).
  }
  return null;
}

// "near {city}" when we have a city, else "in your area". Owns the no-city
// fallback so callers pass the raw city (null/undefined when unknown) — no
// magic-string sentinel to keep in sync across call sites.
function whereClause(city: string | null | undefined): string {
  return city ? ` near ${city}` : " in your area";
}

// Truthful one-clause summary of the notify outcome, shared by the family-facing
// copy so the pluralization lives in exactly one place.
export function notifiedOutcomePhrase(city: string | null | undefined, notifiedCount: number): string {
  const where = whereClause(city);
  return notifiedCount > 0
    ? `${notifiedCount} caregiver${notifiedCount === 1 ? "" : "s"}${where} ${notifiedCount === 1 ? "has" : "have"} already been alerted`
    : `Evia is actively searching for caregivers${where} (none matched yet, but new ones join often)`;
}

// Honest "your job is live" copy driven by the REAL notify outcome. Callers used
// to hard-code "I've notified caregivers within 25 miles" even when zero were
// reached (no coords / empty area) — a false claim to the family.
export function jobLiveMessage(city: string | null | undefined, notifiedCount: number): string {
  const where = whereClause(city);
  return notifiedCount > 0
    ? `Your care request is live! 🎉 I've reached out to ${notifiedCount} caregiver${notifiedCount === 1 ? "" : "s"}${where} and I'll message you the moment someone's interested.`
    : `Your care request is live! 🎉 I'm searching for caregivers${where} right now and I'll text you the moment I find a match.`;
}

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildAndSaveJobPost(params: {
  uid:            string;
  phone:          string;
  onboardingData: Record<string, unknown>;
  jobData:        Record<string, unknown>;
}): Promise<{ jobId: string; notifiedCount: number }> {
  const { uid, phone, onboardingData, jobData } = params;

  const seniorName    = (onboardingData.seniorName    ?? "") as string;
  const firstName     = seniorName.split(" ")[0] || seniorName;
  const relationship  = (onboardingData.relationship  ?? "") as string;
  const city          = (onboardingData.city          ?? "") as string;
  const zipCode       = (onboardingData.zipCode       ?? "") as string;
  const conditions    = (onboardingData.conditions    ?? []) as string[];
  const seniorAge     = onboardingData.age as number | undefined;

  const careNeeds      = (jobData.jobCareNeeds     ?? []) as string[];
  const careLevel      = (jobData.jobCareLevel     ?? "moderate") as string;
  const startDate      = (jobData.jobStartDate     ?? "") as string;
  const frequency      = (jobData.jobFrequency     ?? "occasional") as string;
  const days           = (jobData.jobDays          ?? []) as string[];
  const timeOfDay      = (jobData.jobTimeOfDay     ?? []) as string[];
  const hourlyRate     = jobData.jobHourlyRate;
  const paymentMethod  = (jobData.jobPaymentMethod ?? "card") as string;
  const description    = (jobData.jobDescription   ?? "") as string;
  const petsInHome     = (jobData.petsInHome        ?? false) as boolean;
  const smokingHousehold = (jobData.smokingHousehold ?? false) as boolean;

  // Multi-recipient household ("both mom and dad"): the web CarePlan/Posts
  // tabs are built from job_postings' primary careRecipient* fields plus
  // additionalRecipients[] — write them in the exact shape the web writes.
  const extraRecipients = normalizeAdditionalRecipients(onboardingData.additionalRecipients);
  const additionalRecipients = extraRecipients.map((r) => ({
    firstName:    r.name.split(" ")[0] || r.name,
    lastName:     "",
    name:         r.name,
    relationship: r.relationship ?? "",
    ...(r.age !== undefined ? { age: String(r.age) } : {}),
  }));
  const recipientsCount = 1 + additionalRecipients.length;
  const recipientNames  = [firstName, ...additionalRecipients.map((r) => r.firstName)].filter(Boolean);

  const title = `${careLevel === "light" ? "Light " : careLevel === "intensive" ? "Full " : ""}Care for ${
    recipientNames.length > 1 ? recipientNames.join(" & ") : firstName || "Loved One"
  }`;

  const stateHint = (onboardingData.state ?? jobData.state ?? "") as string;
  let coords = await geocodeZip(zipCode);
  if (!coords) coords = await geocodeCity(city, stateHint);

  // ── job_postings/{uid} — client's own record ──────────────────────────────
  const jobPostingDoc = {
    clientId:               uid,
    careRecipientFirstName: firstName,
    careRecipientName:      seniorName,
    ...(seniorAge !== undefined ? { careRecipientAge: String(seniorAge) } : {}),
    relationship,
    ...(additionalRecipients.length ? { additionalRecipients } : {}),
    recipientsCount,
    title,
    description,
    city,
    zipCode,
    location:   { city, zipCode, ...(coords ?? {}) },
    schedule:   { startDate, frequency, days, timeOfDay, daysPerWeek: days.length || Number(jobData.jobDaysPerWeek ?? 0) },
    careNeeds,
    careLevel,
    hourlyRate,
    paymentMethod,
    petsInHome,
    smokingHousehold,
    status:     "open",
    postedAt:   admin.firestore.FieldValue.serverTimestamp(),
    source:     "cara",
    phone,
  };

  await db.collection("job_postings").doc(uid).set(jobPostingDoc, { merge: true });

  // ── carePlans/{uid} — full care plan with recipient details ───────────────
  // One plan entry per recipient, keyed with the web CarePlan.tsx getKey format
  // (recipientPlanKey) so the web tabs find Evia's data. Needs/conditions are
  // shared at signup (same as the web PostJob flow); per-person edits happen in
  // the CarePlan tabs afterward.
  const recipients = allCareRecipients(onboardingData);
  const recipientPlans: Record<string, unknown> = {};
  for (const r of recipients.length ? recipients : [{ name: seniorName, relationship, age: seniorAge }]) {
    recipientPlans[recipientPlanKey((r.name || "").split(" ")[0] || r.name || "primary")] = {
      name:         r.name || seniorName,
      age:          r.age ?? (recipientPlanKey(r.name || "") === recipientPlanKey(seniorName) ? seniorAge : undefined),
      relationship: r.relationship ?? "",
      careNeeds,
      careLevel,
      conditions,
      updatedAt:    new Date().toISOString(),
    };
  }
  await db.collection("carePlans").doc(uid).set({
    clientId: uid,
    phone,
    recipientPlans,
    locationPool: [
      {
        city,
        zipCode,
        petsInHome,
        smokingHousehold,
        primary: true,
        ...(coords ?? {}),
      },
    ],
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  // ── job_posts/{uid} — public listing in the WEB JobPost contract ───────────
  // Keyed by the client uid, NOT an autoId: the clientIntakes onCreate trigger
  // (aiMatchTriggers → jobNotifications.createJobPost) also writes
  // job_posts/{uid}, so both paths converge on ONE doc instead of the board
  // showing the same family twice (and caregivers being texted twice).
  const jobPostRef = db.collection("job_posts").doc(uid);
  const jobPostDoc = buildWebJobPostDoc({
    clientId:        uid,
    source:          "cara",
    title,
    description,
    clientName:      ((onboardingData.firstName ?? "") as string) || undefined,
    careTypes:       careNeeds,
    careLevel,
    startDate,
    frequency,
    days,
    daysPerWeek:     Number(jobData.jobDaysPerWeek ?? 0),
    timeOfDay,
    hourlyRate:      hourlyRate as number | string | undefined,
    paymentMethod,
    city,
    zipCode,
    lat:             coords?.lat ?? null,
    lng:             coords?.lng ?? null,
    recipientsCount,
    petsInHome,
    smokingHousehold,
    phone,
    intakeId:        uid,
  });
  await jobPostRef.set(jobPostDoc, { merge: true });

  // ── onboardingProgress flags on users/{uid} ───────────────────────────────
  await db.collection("users").doc(uid).set({
    onboardingProgress: {
      carePlanComplete: true,
      identityVerified: true,
      membershipActive: true,
      jobPosted:        true,
      jobPostId:        jobPostRef.id,
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  // ── Notify area caregivers ────────────────────────────────────────────────
  // Awaited (was fire-and-forget) so the caller can tell the family the REAL
  // outcome instead of unconditionally claiming caregivers were notified. The
  // marketplace is small enough that the added latency is a few seconds; each
  // notify is a single plain-text send (no link, no inter-part delay).
  const notifiedCount = await notifyAreaCaregivers(jobPostRef.id, jobPostDoc, uid)
    .catch((err) => { console.error("[buildAndSaveJobPost] notifyAreaCaregivers error:", err); return 0; });

  console.log(`[buildAndSaveJobPost] Job posted: ${jobPostRef.id} for uid=${uid} (notified ${notifiedCount})`);
  return { jobId: jobPostRef.id, notifiedCount };
}
