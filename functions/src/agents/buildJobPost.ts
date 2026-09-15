import * as admin from "firebase-admin";
import { notifyAreaCaregivers } from "../triggers/jobNotifications";
import { recipientPlanKey, resolveRecipientKey, normalizeAdditionalRecipients, allCareRecipients, CareRecipient } from "./careRecipients";
import { buildWebJobPostDoc, defaultJobTitle } from "./jobPostContract";
import { geocodeZip, geocodeCity } from "../utils/geocode";
import { buildJobPostingsDoc, buildCarePlanLocationEntry, mapJobPostingsDocToOnboardingData } from "./clientJobPostingContract";

const db = admin.firestore();

// 2026-09-08 (Hamse's call): one honest, universal message regardless of
// notifiedCount — matches the site's own "Care Request Submitted!" wording
// (PostJobFlow.tsx). The prior version branched on notifiedCount to say
// "I've reached out to N caregivers" vs. "I'm actively searching... none
// matched yet" — both overstated what actually happens: there's no ongoing
// search, just a one-time scan at posting plus a separate invite to each new
// caregiver as they join later, and this job is already visible to every
// caregiver browsing regardless of any of that. Never mentioning a specific
// count sidesteps the original bug this file was built to fix (claiming
// caregivers were notified when none were) by construction — there's no
// count-dependent branch left to accidentally regress.
export const jobLiveMessage =
  "Your care request is submitted! I'll reach out as soon as applications start coming in.";

// Additive union by name — never lets a narrower per-job recipient selection
// shrink the account's persistent roster (the website's own PostJobFlow.tsx
// gives this exact guarantee via arrayUnion; see the call site below).
function unionRecipientsByName(base: CareRecipient[], extra: CareRecipient[]): CareRecipient[] {
  const out = [...base];
  const seen = new Set(base.map((r) => recipientPlanKey(r.name)));
  for (const r of extra) {
    const key = recipientPlanKey(r.name);
    if (!seen.has(key)) { seen.add(key); out.push(r); }
  }
  return out;
}

type JobDataRecipient = { firstName: string; lastName?: string; relationship?: string; isSelf?: boolean };

function jobRecipientName(r: JobDataRecipient, onboardingData: Record<string, unknown>): string {
  return r.isSelf
    ? ((onboardingData.firstName ?? onboardingData.name ?? "Me") as string)
    : `${r.firstName} ${r.lastName ?? ""}`.trim();
}

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildAndSaveJobPost(params: {
  uid:            string;
  phone:          string;
  onboardingData: Record<string, unknown>;
  jobData:        Record<string, unknown>;
}): Promise<{ jobId: string; notifiedCount: number }> {
  const { uid, phone, onboardingData, jobData } = params;

  // ── Per-job who/where overrides (2026-09-07 parity build) ─────────────────
  // jobPostingFlow.ts's jp_ask_recipients/jp_ask_caregivers_needed/jp_ask_location
  // steps collect THIS job's actual choices — often a subset of, or an addition
  // to, the account's full household/address history. These win over onboarding
  // data for everything describing THIS specific job post. The account's
  // persistent roster (job_postings.additionalRecipients, carePlans.locationPool,
  // job_postings.savedLocations) is only ever ADDED to below, never shrunk to
  // match a narrower per-job selection — matching the website's own
  // PostJobFlow.tsx guarantee (arrayUnion, "set primary only if none exists yet").
  const jobRecipients: JobDataRecipient[] = Array.isArray(jobData.careRecipients)
    ? (jobData.careRecipients as JobDataRecipient[])
    : [];
  const hasJobLocation = typeof jobData.streetAddress === "string" && (jobData.streetAddress as string).trim().length > 0;

  const existingJpSnap = await db.collection("job_postings").doc(uid).get().catch(() => null);
  const existingJp = (existingJpSnap?.exists ? existingJpSnap.data() : {}) as Record<string, unknown>;
  const siteState  = mapJobPostingsDocToOnboardingData(existingJp);

  let rosterSeniorName: string;
  let rosterRelationship: string;
  let rosterAdditional: CareRecipient[];
  if (siteState.seniorName) {
    // A roster already exists on job_postings/{uid} — its primary is sticky
    // (never reassigned by a later job's narrower pick). Fold in every
    // recipient THIS job named that isn't already that primary.
    rosterSeniorName   = siteState.seniorName as string;
    rosterRelationship = (siteState.relationship as string) ?? "";
    const primaryKey = recipientPlanKey(rosterSeniorName);
    const thisJobExtras: CareRecipient[] = jobRecipients
      .filter((r) => recipientPlanKey(jobRecipientName(r, onboardingData)) !== primaryKey)
      .map((r) => ({ name: jobRecipientName(r, onboardingData), relationship: r.isSelf ? "myself" : (r.relationship ?? "") }));
    rosterAdditional = unionRecipientsByName(
      normalizeAdditionalRecipients(siteState.additionalRecipients),
      thisJobExtras,
    );
  } else if (jobRecipients.length > 0) {
    // No roster yet — this job's own primary choice becomes the account's.
    const existingPrimaryKey = recipientPlanKey((onboardingData.seniorName as string) ?? "");
    let primaryIdx = jobRecipients.findIndex(
      (r) => !r.isSelf && recipientPlanKey(jobRecipientName(r, onboardingData)) === existingPrimaryKey
    );
    if (primaryIdx < 0) primaryIdx = 0;
    const primary = jobRecipients[primaryIdx];
    rosterSeniorName   = jobRecipientName(primary, onboardingData);
    rosterRelationship = primary.isSelf ? "self" : (primary.relationship ?? (onboardingData.relationship as string) ?? "");
    rosterAdditional = jobRecipients
      .filter((_, i) => i !== primaryIdx)
      .map((r) => ({ name: jobRecipientName(r, onboardingData), relationship: r.isSelf ? "myself" : (r.relationship ?? "") }));
  } else {
    // Legacy fallback — a session that predates the who/where step, or a
    // direct MCP call that skipped it.
    rosterSeniorName   = (onboardingData.seniorName as string) ?? "";
    rosterRelationship = (onboardingData.relationship as string) ?? "";
    rosterAdditional   = normalizeAdditionalRecipients(onboardingData.additionalRecipients);
  }

  const effectiveOnboarding: Record<string, unknown> = {
    ...onboardingData,
    seniorName: rosterSeniorName,
    relationship: rosterRelationship,
    additionalRecipients: rosterAdditional,
  };
  if (hasJobLocation) {
    effectiveOnboarding.street  = jobData.streetAddress;
    effectiveOnboarding.zipCode = jobData.zipCode;
    effectiveOnboarding.city    = jobData.city;
    effectiveOnboarding.state   = jobData.state;
    effectiveOnboarding.petsInHome       = jobData.petsInHome;
    effectiveOnboarding.smokingHousehold = jobData.smokingHousehold;
  }
  if (typeof jobData.caregiversNeeded === "number") {
    effectiveOnboarding.caregiversNeeded = jobData.caregiversNeeded;
  }

  const seniorName    = rosterSeniorName || ((onboardingData.seniorName ?? "") as string);
  const relationship  = rosterRelationship || ((onboardingData.relationship ?? "") as string);
  const city          = hasJobLocation ? ((jobData.city as string) ?? "") : ((onboardingData.city ?? "") as string);
  const zipCode       = hasJobLocation ? ((jobData.zipCode as string) ?? "") : ((onboardingData.zipCode ?? "") as string);
  const conditions    = (onboardingData.conditions    ?? []) as string[];
  const seniorAge     = onboardingData.age as number | undefined;

  const careNeeds      = (jobData.jobCareNeeds     ?? []) as string[];
  const careNeedDetails = (jobData.jobCareNeedDetails ?? {}) as Record<string, string[]>;
  const careLevel      = (jobData.jobCareLevel     ?? "moderate") as string;
  const startDate      = (jobData.jobStartDate     ?? "") as string;
  const frequency      = (jobData.jobFrequency     ?? "occasional") as string;
  const days           = (jobData.jobDays          ?? []) as string[];
  const timeOfDay      = (jobData.jobTimeOfDay     ?? []) as string[];
  const hourlyRate     = jobData.jobHourlyRate;
  const description    = (jobData.jobDescription   ?? "") as string;
  const petsInHome     = (jobData.petsInHome        ?? false) as boolean;
  const smokingHousehold = (jobData.smokingHousehold ?? false) as boolean;
  const caregiversNeeded = typeof jobData.caregiversNeeded === "number" ? jobData.caregiversNeeded : 1;

  // THIS job's actual recipient selection (narrow) drives the public listing
  // and care-plan writes below — distinct from the account-wide roster
  // computed above, which only ever grows.
  const recipients: CareRecipient[] = jobRecipients.length > 0
    ? jobRecipients.map((r) => ({ name: jobRecipientName(r, onboardingData), relationship: r.isSelf ? "myself" : (r.relationship ?? "") }))
    : allCareRecipients(onboardingData);
  const recipientsCount = recipients.length || 1;

  // 2026-09-07 (Hamse's call): Evia never asks a dedicated title question —
  // jobPostingFlow.ts silently fills jobTitle with this same default the
  // moment the address/city is known (jp_ask_location), matching what the
  // website's own wizard auto-suggests (Step5Describe.tsx) before a site user
  // bothers to customize it. This fallback only covers a session that
  // predates that step or a direct MCP call that skipped it.
  const title = ((jobData.jobTitle as string | undefined)?.trim()) || defaultJobTitle(city || null);

  const stateHint = (jobData.state ?? onboardingData.state ?? "") as string;
  let coords = await geocodeZip(zipCode);
  if (!coords) coords = await geocodeCity(city, stateHint);

  // ── job_postings/{uid} — client's own record, in the wizard's exact shape ──
  // (clientJobPostingContract.ts is the single definition both the web wizard
  // and Evia's finalization write are locked to — see the parity test.)
  const jobPostingDoc = buildJobPostingsDoc(uid, phone, effectiveOnboarding);
  await db.collection("job_postings").doc(uid).set(jobPostingDoc, { merge: true });

  // A brand-new address entered THIS job (not matched to any known option) —
  // append it to the account's saved-locations history so it's selectable for
  // a future job post too, matching the website's addNewLocation write.
  if (jobData.isNewLocation === true && hasJobLocation) {
    await db.collection("job_postings").doc(uid).set({
      savedLocations: admin.firestore.FieldValue.arrayUnion({
        street: jobData.streetAddress, city: jobData.city ?? "", state: jobData.state ?? "", zipCode: jobData.zipCode,
      }),
    }, { merge: true }).catch(() => {});
  }

  // ── carePlans/{uid} — full care plan with recipient details ───────────────
  // One plan entry per recipient THIS job actually covers, keyed with the web
  // CarePlan.tsx getKey format (recipientPlanKey) so the web tabs find Evia's
  // data. Needs/conditions are shared at signup (same as the web PostJob
  // flow); per-person edits happen in the CarePlan tabs afterward.
  //
  // 2026-09-13 (live-caught): resolve each recipient's key against whatever
  // recipientPlans keys ALREADY exist for this client — the same prefix-match
  // resolveRecipientKey uses for every other recipient-scoped write (e.g.
  // save_care_task_detail in mcp/server.ts) — instead of always minting a
  // fresh "firstname_noname" key from just the first name. Minting blind used
  // to silently create a SECOND entry for someone already on file under a
  // real "first_last" key (e.g. the site's own "samira_m"), so the same
  // person showed up twice — once under each key — in any later recap or
  // pick list.
  const cpSnap = await db.collection("carePlans").doc(uid).get().catch(() => null);
  const existingPlanKeys = Object.keys((cpSnap?.data()?.recipientPlans ?? {}) as Record<string, unknown>);
  const seniorFirstName = (seniorName || "").trim().split(/\s+/)[0] || seniorName;
  const seniorKeyRes = resolveRecipientKey(existingPlanKeys, seniorFirstName);
  const seniorKey = seniorKeyRes.ok ? seniorKeyRes.key : recipientPlanKey(seniorFirstName);

  const recipientPlans: Record<string, unknown> = {};
  for (const r of recipients.length ? recipients : [{ name: seniorName, relationship, age: seniorAge }]) {
    const firstName = (r.name || "").trim().split(/\s+/)[0] || r.name || "primary";
    const keyRes = resolveRecipientKey(existingPlanKeys, firstName);
    const key = keyRes.ok ? keyRes.key : recipientPlanKey(firstName);
    recipientPlans[key] = {
      name:         r.name || seniorName,
      age:          r.age ?? (key === seniorKey ? seniorAge : undefined),
      relationship: r.relationship ?? "",
      careNeeds,
      // Matches the website's own two-level model (CarePlan.tsx's
      // careNeeds + careNeedDetails) — careNeeds is the parent category
      // ("Personal Care"), careNeedDetails is which specific sub-task chip
      // within it was actually named ("Bathing"). Previously only the
      // category was ever written here, so a family saying "bathing" showed
      // "Personal Care" on the Care Plan page with no sub-task selected at
      // all (2026-09-14, live-caught).
      careNeedDetails,
      careLevel,
      conditions,
      // Direct write, matching the website's own PostJobFlow.tsx /
      // mirrorJobPostRecipientsToWeb — before 2026-09-07 this was never set
      // here, so the Care Plan page's "Notes" section relied entirely on its
      // own frontend fallback to job_postings.jobDescription instead of a
      // first-class field like the web wizard writes.
      notes: description,
      // Signup-time copy shared across the household — see onboardingConversation.
      ...(recipients.length > 1 ? { sharedAtSignup: true } : {}),
      updatedAt:    new Date().toISOString(),
    };
  }

  // locationPool is a growing history of addresses (Step2WhoWhere.tsx reads it
  // as one of its candidate sources) — upsert THIS job's address into it
  // instead of overwriting the whole pool down to one entry every job post.
  const existingPool = (cpSnap?.exists ? ((cpSnap.data() as Record<string, unknown>).locationPool as Array<Record<string, unknown>> | undefined) : undefined) ?? [];
  const newLocEntry = buildCarePlanLocationEntry(effectiveOnboarding, coords ?? undefined) as unknown as Record<string, unknown>;
  let locationPool: Array<Record<string, unknown>>;
  if (newLocEntry.street && newLocEntry.zipCode) {
    const idx = existingPool.findIndex((l) =>
      String(l.street ?? "").toLowerCase() === String(newLocEntry.street).toLowerCase() &&
      String(l.zipCode ?? "") === String(newLocEntry.zipCode)
    );
    locationPool = idx >= 0
      ? existingPool.map((l, i) => (i === idx ? { ...l, ...newLocEntry } : l))
      : [...existingPool, newLocEntry];
  } else {
    locationPool = existingPool.length ? existingPool : [newLocEntry];
  }

  await db.collection("carePlans").doc(uid).set({
    clientId: uid,
    phone,
    recipientPlans,
    locationPool,
    // Finalizing the job post over SMS is Evia's equivalent of the wizard's
    // final "Submit" — stamp the same review marker the web Care Plan page
    // sets, so useOnboardingProgress.ts's completeness check is satisfied for
    // SMS clients (this field is never set on the web wizard's own path today —
    // a separate, known gap on the website side, out of scope here).
    carePlanReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  // 2026-09-09 live incident: this function is called for BOTH the client's
  // very first job post (during onboarding) AND every later "post another
  // job" request from jobPostingFlow.ts — but job_posts/{uid} keying below is
  // only safe for the FIRST one. A second SMS-posted job silently overwrote
  // the family's existing post (applicants and all) instead of creating a
  // new one. Read the flag BEFORE this write sets it, so we know which case
  // we're in.
  const alreadyPostedBeforeSnap = await db.collection("users").doc(uid).get().catch(() => null);
  const alreadyPostedBefore = alreadyPostedBeforeSnap?.data()?.jobPostingCompleted === true;

  // users/{uid}.jobPostingCompleted — the same flag the web wizard sets at
  // Submit, so an SMS-onboarded client never sees the ClientJobPostingWizard
  // overlay if they later open the website (App.tsx's ClientRoute checks it).
  await db.collection("users").doc(uid).set({
    jobPostingCompleted: true,
  }, { merge: true }).catch((err) =>
    console.error("[buildAndSaveJobPost] users.jobPostingCompleted write failed (non-fatal):", err));

  // ── job_posts/{uid or autoId} — public listing in the WEB JobPost contract ─
  // Keyed by the client uid ONLY for the client's first-ever job post: the
  // clientIntakes onCreate trigger (aiMatchTriggers → jobNotifications.
  // createJobPost) also writes job_posts/{uid} around the same time during
  // onboarding, so both paths need to converge on ONE doc instead of the
  // board showing the same family twice (and caregivers being texted twice).
  // That race only exists once, at onboarding — a client posting a SECOND or
  // later job already has jobPostingCompleted=true and no intake trigger is
  // ever going to fire again, so it gets a real autoId instead of colliding
  // with (and destroying) their existing post.
  const jobPostRef = alreadyPostedBefore
    ? db.collection("job_posts").doc()
    : db.collection("job_posts").doc(uid);
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
    city,
    zipCode,
    lat:             coords?.lat ?? null,
    lng:             coords?.lng ?? null,
    recipientsCount,
    caregiversNeeded,
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
