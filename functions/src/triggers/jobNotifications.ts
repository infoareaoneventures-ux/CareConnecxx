import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { haversineMiles } from "../ai/scoring";
import { sendMessage, startTyping, getOrCreateSession } from "../linq/client";
import { sendViaInteractionAgent, AgentOutput } from "../agents/caraAgent";

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

  for (const doc of snap.docs) {
    const cg    = doc.data();
    const phone = cg.phone as string | undefined;
    if (!phone || cg.optedOut === true) continue;

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
  norm: string,
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

  if (norm === "NO") {
    await db.collection("agent_sessions").doc(phone).update({
      awaitingJobResponse: false,
      pendingJobId:        null,
      pendingJobSentAt:    null,
    } as any);
    await sendMessage(chatId, "No problem — I'll reach out when something comes up.");
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
  // Quick keyword check first
  const upper = text.trim().toUpperCase();
  if (["YES", "YEP", "YEA", "YEAH", "YUP", "CONFIRMED", "CONFIRM", "WORKS", "GOOD"].includes(upper)) return true;
  if (["NO", "NOPE", "CANT", "CAN'T", "UNAVAILABLE", "PASS"].includes(upper)) return false;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp   = await client.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 20,
    system:
      "The user is a caregiver confirming or declining availability for a care job. " +
      "Reply with exactly one word: YES if they confirm availability, NO if they decline. No other output.",
    messages: [{ role: "user", content: text }],
  });
  return ((resp.content[0] as { text: string }).text ?? "").trim().toUpperCase() === "YES";
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
