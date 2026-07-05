import * as admin from "firebase-admin";
import axios from "axios";
import { notifyAreaCaregivers } from "../triggers/jobNotifications";
import { recipientPlanKey, normalizeAdditionalRecipients, allCareRecipients } from "./careRecipients";

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

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildAndSaveJobPost(params: {
  uid:            string;
  phone:          string;
  onboardingData: Record<string, unknown>;
  jobData:        Record<string, unknown>;
}): Promise<string> {
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

  const coords = await geocodeZip(zipCode);

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

  // ── job_posts/{autoId} — public listing that triggers caregiver notifications
  const jobPostRef = db.collection("job_posts").doc();
  const jobPostDoc = {
    intakeId:       jobPostRef.id,
    clientId:       uid,
    status:         "open",
    careTypes:      careNeeds,
    schedule:       { frequency, days, timeOfDay },
    startDate,
    location:       { lat: coords?.lat ?? null, lng: coords?.lng ?? null, city },
    summary:        careNeeds.length > 0 ? `New care job — ${careNeeds.slice(0, 2).join(", ")}` : "New care job",
    recipientsCount,
    daysPerWeek:    days.length || Number(jobData.jobDaysPerWeek ?? 0),
    timeOfDay:      timeOfDay.join(", "),
    hourlyRate,
    paymentMethod,
    applicantCount: 0,
    notifiedCount:  0,
    source:         "cara",
    createdAt:      admin.firestore.FieldValue.serverTimestamp(),
  };
  await jobPostRef.set(jobPostDoc);

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

  // ── Notify area caregivers (fire-and-forget) ──────────────────────────────
  notifyAreaCaregivers(jobPostRef.id, jobPostDoc, uid)
    .catch((err) => console.error("[buildAndSaveJobPost] notifyAreaCaregivers error:", err));

  console.log(`[buildAndSaveJobPost] Job posted: ${jobPostRef.id} for uid=${uid}`);
  return jobPostRef.id;
}
