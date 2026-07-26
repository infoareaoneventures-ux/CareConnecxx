import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { haversineMiles } from "../ai/scoring";
import { buildWebJobPostDoc } from "../agents/jobPostContract";
import { sendMessage, startTyping, getOrCreateSession } from "../linq/client";
import { sendViaInteractionAgent, AgentOutput } from "../agents/caraAgent";
import { parseWithClaude } from "../utils/parseWithClaude";
import { answerHumanMidFlow } from "../agents/humanReply";

const MATCH_PUSH_THRESHOLD = 80; // push only when skill overlap is ≥ 80%
// U11 — only INVITE caregivers whose profile actually fits the job, not every
// active caregiver in range. Tunable; jobs with no stated care types score 50
// and so still reach nearby caregivers.
export const INVITE_MATCH_THRESHOLD = 34;

export function computeSimpleMatchScore(cgSkills: string[], jobCareTypes: string[]): number {
  if (!jobCareTypes.length) return 50;
  const cgNorm = cgSkills.map(s => s.toLowerCase());
  const matches = jobCareTypes.filter(t => cgNorm.some(s => s.includes(t.toLowerCase()) || t.toLowerCase().includes(s)));
  return Math.round((matches.length / jobCareTypes.length) * 100);
}

async function sendJobMatchPush(
  caregiverId: string,
  jobId: string,
  jobTitle: string,
  city: string,
  matchScore: number
): Promise<void> {
  const userSnap = await admin.firestore().collection("caregivers").doc(caregiverId).get();
  const fcmTokens: string[] = userSnap.data()?.fcmTokens ?? [];
  if (!fcmTokens.length) return;

  const sends = fcmTokens.slice(0, 5).map(token =>
    admin.messaging().send({
      token,
      notification: {
        title: "New job match for you!",
        body: `${jobTitle} · ${city} — ${matchScore}% match`,
      },
      data: {
        type:       "job_match",
        jobId,
        matchScore: String(matchScore),
        deepLink:   `/caregiver/jobs/${jobId}`,
      },
      android: { priority: "high" },
    }).catch(() => { /* ignore invalid token errors */ })
  );
  await Promise.all(sends);
}

const db = admin.firestore();

const NOTIFY_RADIUS_MILES = 25;

// ── createJobPost ─────────────────────────────────────────────────────────────

export async function createJobPost(
  intakeId: string,
  intakeData: any,
  clientId: string
): Promise<void> {
  try {
    // Childcare U6 (plan 2026-07-22-002, R32/R33): this writer produces the
    // SENIOR web-contract job shape (clientName, phone, location string) with
    // no privacy projection — childcare demand never flows through it.
    if (intakeData?.careVertical === "child") {
      console.warn(`[createJobPost] childcare intake ${intakeId} refused — childcare jobs are created by v1-createChildcareJobPost`);
      return;
    }
    let lat = intakeData.lat ?? intakeData.latitude ?? intakeData.location?.latitude ?? intakeData.location?.lat ?? null;
    let lng = intakeData.lng ?? intakeData.longitude ?? intakeData.location?.longitude ?? intakeData.location?.lng ?? null;
    const city = intakeData.city ?? intakeData.location?.city ?? undefined;
    const careTypes: string[] = intakeData.careTypes ?? [];

    // Geocode fallback (parity with buildAndSaveJobPost): an intake with only a
    // city/zip used to produce a coordless job here — radius notifications dead.
    if (lat == null || lng == null) {
      const { geocodeCityOrZip } = await import("../utils/geocode");
      const coords = await geocodeCityOrZip(
        city as string | undefined,
        (intakeData.zipCode ?? intakeData.location?.zipCode) as string | undefined,
        (intakeData.state ?? intakeData.location?.state) as string | undefined,
      ).catch(() => null);
      if (coords) { lat = coords.lat; lng = coords.lng; }
    }

    // Web JobPost contract via the shared builder — the caregiver Job Board
    // renders title/location-string/rate/date; the old hand-rolled shape here
    // (summary + location OBJECT + Timestamp createdAt) rendered blank and
    // could crash the board's JSX. Merge-write: Evia's post-payment
    // buildAndSaveJobPost targets the same job_posts/{uid} doc.
    const recipientFirst = (intakeData.recipientFirstName ?? intakeData.recipientName ?? "") as string;
    const daysPerWeek    = Number(intakeData.daysPerWeek ?? 0);
    const timeOfDay      = typeof intakeData.timeOfDay === "string" && intakeData.timeOfDay
      ? [intakeData.timeOfDay as string]
      : (Array.isArray(intakeData.timeOfDay) ? intakeData.timeOfDay as string[] : []);
    await db.collection("job_posts").doc(intakeId).set(buildWebJobPostDoc({
      clientId,
      source:      "intake_trigger",
      title:       `Care for ${recipientFirst.split(" ")[0] || "a Loved One"}`,
      clientName:  ((intakeData.contactName ?? intakeData.firstName ?? "") as string) || undefined,
      careTypes,
      startDate:   (intakeData.startDate ?? undefined) as string | undefined,
      frequency:   daysPerWeek >= 5 ? "full_time" : daysPerWeek >= 3 ? "part_time" : daysPerWeek > 0 ? "occasional" : undefined,
      daysPerWeek,
      timeOfDay,
      hourlyRate:  Number(intakeData.budgetMax ?? 0) || Number(intakeData.budgetMin ?? 0) || "flexible",
      city,
      zipCode:     (intakeData.zipCode ?? undefined) as string | undefined,
      lat,
      lng,
      recipientsCount: Number(intakeData.recipientsCount ?? 0) || undefined,
      phone:       (intakeData.phone ?? undefined) as string | undefined,
      intakeId,
    }), { merge: true });

    if (!lat || !lng) {
      console.warn(`[createJobPost] Intake ${intakeId} has no coordinates — caregivers will not be notified`);
    }
  } catch (err) {
    console.error("[createJobPost] failed:", err);
  }
}

// ── notifyAreaCaregivers ──────────────────────────────────────────────────────

export async function notifyAreaCaregivers(
  jobId: string,
  intakeData: any,
  clientId: string
): Promise<number> {
  // Childcare U6 (R34/KTD11): this fan-out has NO eligibility gate — it texts
  // every active caregiver in radius. Childcare jobs are notified only through
  // the eligibility-gated childcare fan-out (jobCallables). Fail closed.
  if (intakeData?.careVertical === "child") {
    console.warn(`[notifyAreaCaregivers] childcare job ${jobId} refused — childcare notifications are eligibility-gated (R34)`);
    return 0;
  }
  // Coord chain accepts BOTH shapes: web-contract top-level lat/lng (all
  // writers since 2026-07-10) and the legacy location-object docs.
  const clientLat = intakeData.lat ?? intakeData.latitude ?? intakeData.location?.latitude ?? intakeData.location?.lat;
  const clientLng = intakeData.lng ?? intakeData.longitude ?? intakeData.location?.longitude ?? intakeData.location?.lng;
  // job_posts.location IS a string in the web contract — jobPostContract.ts joins
  // [city, state, zipCode] into `locationStr` ("City, State, Zip"). When we fall
  // through to that joined string, take only the leading city segment; the full
  // joined string would never equal a caregiver's plain city and would fail the
  // equality match below. Plain city values (no comma) pass through unchanged.
  const cityRaw   = (intakeData.city ?? intakeData.location?.city ?? intakeData.location ?? "");
  const city      = (typeof cityRaw === "string" ? cityRaw : "").split(",")[0];
  const careTypes: string[] = intakeData.careTypes ?? [];

  const hasCoords = !!clientLat && !!clientLng;
  const cityKey   = city.trim().toLowerCase();

  // Without coordinates we can't do a proximity radius — but a hard return used
  // to notify NOBODY while the family was told caregivers were alerted. Fall
  // back to matching caregivers whose own city equals the job's city so the
  // notification still goes out. If we have neither coords nor a city, there's
  // genuinely nothing to match on.
  if (!hasCoords && !cityKey) {
    console.warn(`[notifyAreaCaregivers] No coordinates or city for job ${jobId} — skipping notifications`);
    return 0;
  }
  if (!hasCoords) {
    console.warn(`[notifyAreaCaregivers] No coordinates for job ${jobId} — falling back to city match on "${city}"`);
  }

  const snap = await db.collection("caregivers").where("status", "==", "active").get();
  if (snap.empty) {
    console.log("[notifyAreaCaregivers] No active caregivers found");
    return 0;
  }

  let notifiedCount = 0;
  let pushSentCount = 0;
  const jobTitle = careTypes.length > 0 ? `${careTypes.join(", ")} job` : "Care job";

  const todayIso = new Date().toISOString();
  for (const doc of snap.docs) {
    const cg    = doc.data();
    const phone = cg.phone as string | undefined;
    if (!phone || cg.optedOut === true) continue;
    // Skip paused caregivers — they're on vacation / temporarily off the platform
    const pausedUntil = cg.pausedUntil as string | undefined;
    if (pausedUntil && pausedUntil > todayIso) continue;

    const cgLat  = cg.latitude ?? cg.location?.latitude ?? cg.location?.lat;
    const cgLng  = cg.longitude ?? cg.location?.longitude ?? cg.location?.lng;
    const cgCity = (cg.city ?? cg.location?.city ?? "").toString().split(",")[0].trim().toLowerCase();

    if (hasCoords && cgLat != null && cgLng != null) {
      const dist = haversineMiles(clientLat, clientLng, cgLat, cgLng);
      if (dist === undefined || dist > NOTIFY_RADIUS_MILES) continue;
    } else {
      // City-string fallback — used when the JOB has no coords, and ALSO when
      // the CAREGIVER doc has no coords (a coordless caregiver living in the
      // job's own city used to be silently skipped whenever the job had
      // coordinates — the exact inverse of the coordless-job bug).
      if (!cgCity || !cityKey || cgCity !== cityKey) continue;
    }

    // Profile-fit gate (U11): a caregiver covering none of the job's care types
    // is skipped rather than blasted "a job opened near you". The same score
    // decides the FCM push below, so it's computed once here.
    const cgSkills: string[] = [
      ...(cg.specialties ?? []),
      ...(cg.medicalSkills ?? []),
      ...(cg.certifications ?? []),
    ];
    const matchScore = computeSimpleMatchScore(cgSkills, careTypes);
    if (matchScore < INVITE_MATCH_THRESHOLD) continue;

    try {
      // Idempotency guard — don't text the same caregiver twice for the same job.
      // Keyed by PHONE, not caregiverId: duplicate caregiver docs sharing one
      // phone (seen live 07-14 — one person, two docs, two texts for the same
      // job) collapse to a single notification. The caregiverId check stays as
      // a secondary net for legacy notification docs written before phone was
      // reliably present.
      const [byPhone, byId] = await Promise.all([
        db.collection("job_notifications")
          .where("phone", "==", phone).where("jobId", "==", jobId).limit(1).get(),
        db.collection("job_notifications")
          .where("caregiverId", "==", doc.id).where("jobId", "==", jobId).limit(1).get(),
      ]);
      if (!byPhone.empty || !byId.empty) continue;

      const session = await getOrCreateSession(phone, { caregiverId: doc.id });
      if (session.optedOut) continue;

      const firstName = (cg.firstName ?? cg.name ?? "there").split(" ")[0];

      const scheduleText = buildScheduleText(intakeData);
      const careText     = careTypes.length > 0 ? careTypes.join(", ") : "care";

      const message =
        `Hi ${firstName}! A new care job opened near you.\n\n` +
        `📍 ${city || "your area"} · ${careText}` +
        (scheduleText ? `\n${scheduleText}` : "") +
        `\n\nInterested? Just tell me yes or no — or ask me anything about it.`;

      await startTyping(session.chatId).catch(() => {});
      await sendMessage(session.chatId, message);

      await db.collection("job_notifications").add({
        caregiverId: doc.id,
        jobId,
        phone,
        sentAt: new Date().toISOString(),
      });

      await db.collection("agent_sessions").doc(phone).update({
        awaitingJobResponse:              true,
        awaitingAvailabilityConfirmation: false,
        pendingJobId:                     jobId,
        pendingJobSentAt:                 new Date().toISOString(),
      } as any);

      notifiedCount++;

      // FCM push for high-match caregivers (cap at 50). Reuses the matchScore
      // computed above for the invite gate.
      if (pushSentCount < 50 && matchScore >= MATCH_PUSH_THRESHOLD) {
        await sendJobMatchPush(doc.id, jobId, jobTitle, city || "your area", matchScore)
          .catch(err => console.error(`[notifyAreaCaregivers] push failed for ${doc.id}:`, err));
        pushSentCount++;
      }
    } catch (err) {
      console.error(`[notifyAreaCaregivers] Failed for caregiver ${doc.id}:`, err);
    }
  }

  if (notifiedCount > 0) {
    await db.collection("job_posts").doc(jobId)
      .update({ notifiedCount: FieldValue.increment(notifiedCount) })
      .catch(err => console.error("[notifyAreaCaregivers] notifiedCount update failed:", err));
  }

  console.log(`[notifyAreaCaregivers] Notified ${notifiedCount} caregivers for job ${jobId}`);
  return notifiedCount;
}

function buildScheduleText(intake: any): string {
  if (typeof intake.schedule === "string") return intake.schedule;
  const days  = intake.daysPerWeek ? `${intake.daysPerWeek} days/week` : null;
  const time  = intake.timeOfDay ?? intake.schedule?.timeOfDay ?? null;
  const hours = intake.hoursPerDay ? `${intake.hoursPerDay} hrs/day` : null;
  return [days, time, hours].filter(Boolean).join(", ");
}

// ── handleJobResponse ─────────────────────────────────────────────────────────

export async function handleJobResponse(
  phone: string,
  text: string,
  chatId: string,
  session: any
): Promise<void> {
  const jobId = session.pendingJobId as string | null | undefined;

  if (!jobId) {
    await db.collection("agent_sessions").doc(phone).update({
      awaitingJobResponse: false,
      pendingJobId:        null,
      pendingJobSentAt:    null,
    } as any);
    return;
  }

  // isQuestionOrOther — if caregiver asks a question instead of YES/NO, answer
  // it and re-pose the question without consuming the pending state.
  const qRaw = await parseWithClaude(
    "A caregiver was just texted about a new job opportunity and asked whether they're interested (yes or no). " +
      "Reply YES if their message is a general question or off-topic comment rather than a yes/no answer. " +
      "Reply NO if it is a direct yes/no decision. Only reply YES or NO.",
    text,
    5,
  );
  if (qRaw.toUpperCase().startsWith("Y")) {
    // Ground the answer in THIS job's actual details — "tell me more" must
    // describe the job/client, not whatever flow happened to be active
    // (seen live 07-14: a "tell me more" reply got a speech about arrival
    // auto-notify settings instead of the job).
    const qJobSnap = await db.collection("job_posts").doc(jobId).get().catch(() => null);
    const qJob     = qJobSnap?.exists ? qJobSnap.data()! : null;
    const jobFacts = qJob
      ? [
          Array.isArray(qJob.careTypes) && qJob.careTypes.length ? `care needed: ${qJob.careTypes.join(", ")}` : null,
          qJob.city ? `location: ${qJob.city}` : null,
          `schedule: ${buildScheduleSummaryFromJobPost(qJob)}`,
          typeof qJob.rate === "number" && qJob.rate > 0 ? `pay: $${qJob.rate}/hr` : null,
          qJob.schedule?.startDate ? `starts: ${qJob.schedule.startDate}` : null,
        ].filter(Boolean).join("; ")
      : "";
    await sendMessage(chatId, await answerHumanMidFlow({
      audience: "caregiver",
      situation:
        "caregiver was offered a job and asked a question instead of replying yes or no. " +
        (jobFacts
          ? `The job's details — use ONLY these facts, never invent others: ${jobFacts}. `
          : "") +
        "If their question asks for something not in these facts (e.g. specifics about the client), " +
        "say more details are shared after they express interest.",
      text,
      reAsk: "So — interested in this job? A simple yes or no works.",
      maxTokens: 180,
    }));
    return;
  }

  // Single LLM call to determine YES/NO from natural language.
  const decision = await parseWithClaude(
    'A caregiver is responding to a job offer. ' +
      '"yes", "yeah", "yep", "sure", "ok", "interested", "I\'ll take it" → YES. ' +
      '"no", "pass", "can\'t", "decline", "skip", "not interested" → NO. ' +
      'Reply with exactly YES or NO.',
    text,
    5,
  );
  const isYes = ["YES", "Y", "YEAH", "YEP"].includes(decision.toUpperCase());

  if (!isYes) {
    await db.collection("agent_sessions").doc(phone).update({
      awaitingJobResponse: false,
      pendingJobId:        null,
      pendingJobSentAt:    null,
    } as any);
    await sendMessage(chatId, "No problem — I'll reach out when something comes up.");

    // Record the decline and check if all notified caregivers have declined
    await db.collection("job_notifications")
      .where("phone",  "==", phone)
      .where("jobId",  "==", jobId)
      .limit(1)
      .get()
      .then(snap => {
        if (!snap.empty) return snap.docs[0].ref.update({ status: "declined", declinedAt: new Date().toISOString() });
        return undefined;
      })
      .catch(() => {});

    notifyFamilyIfAllDeclined(jobId).catch(err =>
      console.error("[handleJobResponse] notifyFamilyIfAllDeclined failed:", err)
    );
    return;
  }

  // YES path — ask availability confirmation
  const jobSnap = await db.collection("job_posts").doc(jobId).get();
  const scheduleText = jobSnap.exists
    ? buildScheduleSummaryFromJobPost(jobSnap.data()!)
    : "this schedule";

  await db.collection("agent_sessions").doc(phone).update({
    awaitingJobResponse:              false,
    awaitingAvailabilityConfirmation: true,
    pendingJobId:                     jobId,
  } as any);

  // Record the interest on the notification doc — "engaged" caregivers
  // (interested or applied) are the ones who get the care-plan follow-up when
  // the family finishes their plan (carePlanInterview, 2026-07-15).
  await db.collection("job_notifications")
    .where("phone", "==", phone)
    .where("jobId", "==", jobId)
    .limit(1)
    .get()
    .then(snap => {
      if (!snap.empty && !snap.docs[0].data().status) {
        return snap.docs[0].ref.update({ status: "interested", interestedAt: new Date().toISOString() });
      }
      return undefined;
    })
    .catch(() => {});

  await sendMessage(
    chatId,
    `Great! Just to confirm — are you available for ${scheduleText}? Say yes and I'll send in your application, or no to pass.`
  );
}

async function notifyFamilyIfAllDeclined(jobId: string): Promise<void> {
  const notifSnap = await db.collection("job_notifications")
    .where("jobId", "==", jobId)
    .get();

  if (notifSnap.empty) return;

  // Count ONLY docs that represent a real notification send (sentAt present).
  // Every notifyAreaCaregivers doc has sentAt; this guards against any
  // non-notification doc that shares the collection from wedging the check.
  const notifiedDocs = notifSnap.docs.filter(d => !!d.data().sentAt);
  if (notifiedDocs.length === 0) return;

  const allDeclined = notifiedDocs.every(d =>
    d.data().status === "declined" || d.data().status === "applied"
  );

  // Only act if every notified caregiver has responded AND all declined
  const anyApplied = notifiedDocs.some(d => d.data().status === "applied");
  if (!allDeclined || anyApplied) return;

  // Look up the job post → get clientId → find family phone
  const jobSnap = await db.collection("job_posts").doc(jobId).get();
  if (!jobSnap.exists) return;

  const jobData  = jobSnap.data()!;
  const clientId = jobData.clientId as string | undefined;
  if (!clientId) return;

  // Cap re-match attempts at 2 to prevent infinite loops
  const rematchAttempts = (jobData.rematchAttempts ?? 0) as number;
  if (rematchAttempts >= 2) {
    // All attempts exhausted — escalate to admin and notify family
    await db.collection("admin_alerts").add({
      type:      "job_no_coverage",
      jobId,
      clientId,
      createdAt: new Date().toISOString(),
      resolved:  false,
      priority:  "high",
    });
    const userSnap    = await db.collection("users").doc(clientId).get();
    const familyPhone = userSnap.data()?.phone as string | undefined;
    if (familyPhone) {
      await sendViaInteractionAgent(familyPhone, {
        content:
          "I've done a thorough search and haven't been able to find available caregivers right now. " +
          "Our team has been notified and will reach out within 2 hours to help.",
        urgency:     "standard",
        sourceAgent: "job_notification",
        canDrop:     false,
      });
    }
    await db.collection("job_posts").doc(jobId).update({ status: "no_coverage" });
    return;
  }

  // Increment attempt counter before proceeding
  await db.collection("job_posts").doc(jobId).update({
    rematchAttempts: FieldValue.increment(1),
  });

  const userSnap = await db.collection("users").doc(clientId).get();
  const familyPhone = userSnap.data()?.phone as string | undefined;
  if (!familyPhone) return;

  await sendViaInteractionAgent(familyPhone, {
    content:
      "The caregivers I reached out to aren't available right now. " +
      "I'm searching for more options and will text you as soon as I find a match.",
    urgency:     "standard",
    sourceAgent: "job_notification",
    canDrop:     false,
  });

  // Trigger a fresh broad matching pass
  const sessionSnap = await db.collection("agent_sessions").doc(familyPhone).get();
  if (sessionSnap.exists) {
    const sessionData = sessionSnap.data() ?? {};
    const { runMatchingForClient } = await import("../agents/matchingAgent");
    await runMatchingForClient(
      familyPhone,
      (sessionData as any).chatId ?? "",
      sessionData,
      sessionData
    ).catch(err => console.error("[notifyFamilyIfAllDeclined] re-match failed:", err));
  }
}

function buildScheduleSummaryFromJobPost(job: any): string {
  if (typeof job.schedule === "string") return job.schedule;
  const days  = job.daysPerWeek ? `${job.daysPerWeek} days/week` : null;
  const time  = job.timeOfDay ?? null;
  const hours = job.hoursPerDay ? `${job.hoursPerDay} hrs/day` : null;
  return [days, time, hours].filter(Boolean).join(", ") || "this schedule";
}

// ── handleAvailabilityConfirmation ────────────────────────────────────────────

export async function handleAvailabilityConfirmation(
  phone: string,
  text: string,
  chatId: string,
  session: any
): Promise<void> {
  const jobId = session.pendingJobId as string | null | undefined;

  // Always clear flags first
  await db.collection("agent_sessions").doc(phone).update({
    awaitingAvailabilityConfirmation: false,
    pendingJobId:                     null,
    pendingJobSentAt:                 null,
  } as any);

  if (!jobId) {
    await sendMessage(chatId, "No problem — I'll reach out when the next opportunity opens up.");
    return;
  }

  let available = false;
  try {
    available = await parseAvailabilityConfirmation(text);
  } catch (err) {
    console.error("[handleAvailabilityConfirmation] Haiku parse failed:", err);
    // Default to treating as NO on parse failure
  }

  if (!available) {
    await sendMessage(chatId, "No worries — thanks for letting us know. I'll reach out when something else opens up.");
    return;
  }

  // YES — write application
  try {
    const jobSnap = await db.collection("job_posts").doc(jobId).get();
    if (!jobSnap.exists) {
      await sendMessage(chatId, "Sorry, that position is no longer available. I'll text you when new ones come up!");
      return;
    }
    const job       = jobSnap.data()!;
    const clientId  = job.clientId as string;

    // Resolve caregiverId from session or by phone lookup
    let caregiverId = session.caregiverId as string | undefined;
    if (!caregiverId) {
      const cgSnap = await db.collection("caregivers").where("phone", "==", phone).limit(1).get();
      caregiverId  = cgSnap.empty ? undefined : cgSnap.docs[0].id;
    }
    if (!caregiverId) {
      console.error("[handleAvailabilityConfirmation] Could not resolve caregiverId for phone", phone);
      await sendMessage(chatId, "Something went wrong — please contact us directly to apply.");
      return;
    }

    // Prefer the caregiver doc's real name — session.name is often unset for
    // established caregivers, which made the family's applicant alert read
    // "Caregiver applied to your post" (seen live 2026-07-15).
    let caregiverName = (session.name ?? session.firstName) as string | undefined;
    if (!caregiverName) {
      const cgDoc = await db.collection("caregivers").doc(caregiverId).get();
      caregiverName = (cgDoc.data()?.name as string | undefined) || undefined;
    }
    caregiverName = caregiverName || "Caregiver";

    // Write application
    const { jobApplicationSnapshot } = await import("../utils/jobApplicationDoc");
    await db.collection("job_applications").add({
      jobId,
      caregiverId,
      clientId,
      phone,
      caregiverName,
      ...jobApplicationSnapshot(job),
      status:    "pending",
      appliedAt: new Date().toISOString(),
      source:    "sms_notification",
    });

    // Add to family's candidate pool
    await db.collection("clientMatches").doc(clientId).set(
      { appliedCandidates: FieldValue.arrayUnion(caregiverId), updatedAt: new Date().toISOString() },
      { merge: true }
    );

    // Stamp the notification doc "applied". notifyFamilyIfAllDeclined has
    // always READ status === "applied" but nothing ever wrote it — an applied
    // caregiver looked like a non-responder to the all-declined sweep. Also
    // marks this caregiver "engaged" for the care-plan follow-up (2026-07-15).
    await db.collection("job_notifications")
      .where("phone", "==", phone)
      .where("jobId", "==", jobId)
      .limit(1)
      .get()
      .then(snap => {
        if (!snap.empty) return snap.docs[0].ref.update({ status: "applied", appliedAt: new Date().toISOString() });
        return undefined;
      })
      .catch(() => {});

    // Notify family
    await notifyFamilyOfApplicant(clientId, caregiverName, caregiverId);

    await sendMessage(chatId, "You're in. I'll let you know once the family reviews your application.");
    console.log(`[handleAvailabilityConfirmation] ${caregiverId} applied to job ${jobId}`);
  } catch (err) {
    console.error("[handleAvailabilityConfirmation] application write failed:", err);
    await sendMessage(chatId, "Something went wrong on our end. Please try again or contact us directly.");
  }
}

async function parseAvailabilityConfirmation(text: string): Promise<boolean> {
  const decision = await parseWithClaude(
    "A caregiver is confirming or declining availability for a specific care job. " +
      "Reply YES if they confirm availability, NO if they decline. Reply with exactly YES or NO.",
    text,
    5,
  );
  return decision.toUpperCase() === "YES";
}

async function notifyFamilyOfApplicant(
  clientId: string,
  caregiverName: string,
  caregiverId: string
): Promise<void> {
  try {
    const userSnap = await db.collection("users").doc(clientId).get();
    const familyPhone = userSnap.data()?.phone as string | undefined;
    if (!familyPhone) return;

    const output: AgentOutput = {
      content:
        `${caregiverName} just applied to your open care job and confirmed availability.\n\n` +
        `You can review their profile in the app. Reply HIRE to book them, or PASS to keep looking.`,
      urgency:     "standard",
      sourceAgent: "job_notification",
      canDrop:     false,
    };
    await sendViaInteractionAgent(familyPhone, output);
  } catch (err) {
    console.error("[notifyFamilyOfApplicant] failed:", err);
  }
}

// ── closeJobPost ──────────────────────────────────────────────────────────────

export async function closeJobPost(clientId: string): Promise<void> {
  try {
    // Childcare U6: the status=="open" filter structurally excludes childcare
    // jobs (they are status "open_childcare" — closed via
    // v1-closeChildcareJobPost); the explicit skip below is defense in depth.
    const snap = await db.collection("job_posts")
      .where("clientId", "==", clientId)
      .where("status",   "==", "open")
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (snap.empty) return;
    if (snap.docs[0].data()?.careVertical === "child") return;

    await snap.docs[0].ref.update({
      status:   "closed",
      closedAt: new Date().toISOString(),
    });

    console.log(`[closeJobPost] Closed job post ${snap.docs[0].id} for client ${clientId}`);
  } catch (err) {
    console.error("[closeJobPost] failed:", err);
  }
}
