import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { haversineMiles } from "../ai/scoring";
import { sendMessage, startTyping, getOrCreateSession } from "../linq/client";
import { sendViaInteractionAgent, AgentOutput } from "../agents/caraAgent";
import { parseWithClaude } from "../utils/parseWithClaude";
import { quickComplete } from "../utils/openaiClient";

const MATCH_PUSH_THRESHOLD = 80; // push only when skill overlap is ≥ 80%

function computeSimpleMatchScore(cgSkills: string[], jobCareTypes: string[]): number {
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
    const lat = intakeData.latitude ?? intakeData.location?.latitude ?? intakeData.location?.lat ?? null;
    const lng = intakeData.longitude ?? intakeData.location?.longitude ?? intakeData.location?.lng ?? null;
    const city = intakeData.city ?? intakeData.location?.city ?? null;
    const careTypes: string[] = intakeData.careTypes ?? [];

    await db.collection("job_posts").doc(intakeId).set({
      intakeId,
      clientId,
      status:         "open",
      careTypes,
      schedule:       intakeData.schedule ?? null,
      startDate:      intakeData.startDate ?? null,
      location:       { lat, lng, city },
      summary:        careTypes.length > 0
        ? `New care job — ${careTypes.join(", ")}`
        : "New care job",
      applicantCount: 0,
      notifiedCount:  0,
      createdAt:      FieldValue.serverTimestamp(),
    });

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
): Promise<void> {
  const clientLat = intakeData.latitude ?? intakeData.location?.latitude ?? intakeData.location?.lat;
  const clientLng = intakeData.longitude ?? intakeData.location?.longitude ?? intakeData.location?.lng;
  const city      = intakeData.city ?? intakeData.location?.city ?? "";
  const careTypes: string[] = intakeData.careTypes ?? [];

  if (!clientLat || !clientLng) {
    console.warn(`[notifyAreaCaregivers] No coordinates for job ${jobId} — skipping notifications`);
    return;
  }

  const snap = await db.collection("caregivers").where("status", "==", "active").get();
  if (snap.empty) {
    console.log("[notifyAreaCaregivers] No active caregivers found");
    return;
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

    const cgLat = cg.latitude ?? cg.location?.latitude ?? cg.location?.lat;
    const cgLng = cg.longitude ?? cg.location?.longitude ?? cg.location?.lng;
    const dist  = haversineMiles(clientLat, clientLng, cgLat, cgLng);
    if (dist === undefined || dist > NOTIFY_RADIUS_MILES) continue;

    try {
      // Idempotency guard — don't text the same caregiver twice for the same job
      const existing = await db.collection("job_notifications")
        .where("caregiverId", "==", doc.id)
        .where("jobId", "==", jobId)
        .limit(1)
        .get();
      if (!existing.empty) continue;

      const session = await getOrCreateSession(phone, { caregiverId: doc.id });
      if (session.optedOut) continue;

      const firstName = (cg.firstName ?? cg.name ?? "there").split(" ")[0];

      const scheduleText = buildScheduleText(intakeData);
      const careText     = careTypes.length > 0 ? careTypes.join(", ") : "care";

      const message =
        `Hi ${firstName}! A new care job opened near you.\n\n` +
        `📍 ${city || "your area"} · ${careText}` +
        (scheduleText ? `\n${scheduleText}` : "") +
        `\n\nInterested? Reply YES or NO.`;

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

      // FCM push for high-match caregivers (cap at 50)
      if (pushSentCount < 50) {
        const cgSkills: string[] = [
          ...(cg.specialties ?? []),
          ...(cg.medicalSkills ?? []),
          ...(cg.certifications ?? []),
        ];
        const matchScore = computeSimpleMatchScore(cgSkills, careTypes);
        if (matchScore >= MATCH_PUSH_THRESHOLD) {
          await sendJobMatchPush(doc.id, jobId, jobTitle, city || "your area", matchScore)
            .catch(err => console.error(`[notifyAreaCaregivers] push failed for ${doc.id}:`, err));
          pushSentCount++;
        }
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
    "A caregiver was just texted about a new job opportunity and asked to reply YES or NO. " +
      "Reply YES if their message is a general question or off-topic comment rather than a yes/no answer. " +
      "Reply NO if it is a direct yes/no decision. Only reply YES or NO.",
    text,
    5,
  );
  if (qRaw.toUpperCase().startsWith("Y")) {
    const answer = await quickComplete(
      "You are Cara, an AI care assistant. A caregiver was offered a job and asked a question instead of replying YES/NO. " +
        "Answer their question briefly (1-2 sentences). Do NOT ask them to commit — that prompt comes next.",
      text,
      { maxTokens: 180 },
    ).catch(() => "Let me get back to you on that. In the meantime —");
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "So — interested in this job? Reply YES or NO.");
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

  await sendMessage(
    chatId,
    `Great! Just to confirm — are you available for ${scheduleText}?\n\nReply YES to apply or NO to pass.`
  );
}

async function notifyFamilyIfAllDeclined(jobId: string): Promise<void> {
  const notifSnap = await db.collection("job_notifications")
    .where("jobId", "==", jobId)
    .get();

  if (notifSnap.empty) return;

  const allDeclined = notifSnap.docs.every(d =>
    d.data().status === "declined" || d.data().status === "applied"
  );

  // Only act if every notified caregiver has responded AND all declined
  const anyApplied = notifSnap.docs.some(d => d.data().status === "applied");
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

    const caregiverName = session.name ?? session.firstName ?? "Caregiver";

    // Write application
    await db.collection("job_applications").add({
      jobId,
      caregiverId,
      clientId,
      phone,
      caregiverName,
      status:    "pending",
      appliedAt: new Date().toISOString(),
      source:    "sms_notification",
    });

    // Add to family's candidate pool
    await db.collection("clientMatches").doc(clientId).set(
      { appliedCandidates: FieldValue.arrayUnion(caregiverId), updatedAt: new Date().toISOString() },
      { merge: true }
    );

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
    const snap = await db.collection("job_posts")
      .where("clientId", "==", clientId)
      .where("status",   "==", "open")
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (snap.empty) return;

    await snap.docs[0].ref.update({
      status:   "closed",
      closedAt: new Date().toISOString(),
    });

    console.log(`[closeJobPost] Closed job post ${snap.docs[0].id} for client ${clientId}`);
  } catch (err) {
    console.error("[closeJobPost] failed:", err);
  }
}
