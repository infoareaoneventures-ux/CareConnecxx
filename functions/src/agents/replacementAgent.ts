import * as admin from "firebase-admin";
import { sendToPhone } from "../linq/client";
import { sendViaInteractionAgent } from "./caraAgent";
import { scoreReplacements, ReplacementOption } from "./replacementScorer";
import { scheduleTrigger } from "../triggers/triggerEngine";

const db = admin.firestore();

const SUPPORT_PHONE = process.env.SUPPORT_PHONE ?? "1-800-555-0199";

// ── Contact a replacement candidate via Linq ──────────────────────────────────

export async function contactReplacementCandidate(
  caregiver: ReplacementOption & { phone?: string },
  appt: { date: string; time: string; address?: string; durationHours?: number; hourlyRate?: number },
  taskId: string
): Promise<void> {
  if (!caregiver.phone) return;

  const earnings = ((appt.hourlyRate ?? caregiver.hourlyRate ?? 22) * (appt.durationHours ?? 4)).toFixed(2);

  const msg =
    `Hi ${caregiver.name.split(" ")[0]}! 👋 We have an urgent visit that needs coverage:\n\n` +
    `📅 ${appt.date} at ${appt.time}\n` +
    (appt.address ? `📍 ${appt.address}\n` : "") +
    `💰 ~$${earnings} for the visit\n\n` +
    `Reply YES if you can take it, or NO to pass.`;

  await sendToPhone(caregiver.phone, msg).catch((err) =>
    console.error(`contactReplacementCandidate failed for ${caregiver.phone}:`, err)
  );

  await db.collection("replacement_candidates").add({
    taskId,
    caregiverId: caregiver.caregiverId,
    phone:       caregiver.phone,
    status:      "contacted",
    contactedAt: new Date().toISOString(),
  });
}

// ── No replacements found — alert admin + notify family ───────────────────────

export async function handleNoReplacementsFound(
  appointmentId: string,
  clientId:      string,
  phone:         string,
  appt:          { caregiverName?: string; date: string; time: string }
): Promise<void> {
  const now = new Date().toISOString();

  await db.collection("admin_alerts").add({
    type:          "no_replacement_found",
    appointmentId,
    clientId,
    phone,
    date:          appt.date,
    time:          appt.time,
    createdAt:     now,
    resolved:      false,
  });

  const msg =
    `${appt.caregiverName ?? "Your caregiver"} had to cancel and I wasn't able to find a replacement in time. ` +
    `Please call our support team at ${SUPPORT_PHONE} or open the app to reschedule.`;

  await sendViaInteractionAgent(phone, {
    content:     msg,
    urgency:     "immediate",
    sourceAgent: "emergency_replacement",
    canDrop:     false,
  }).catch(() => sendToPhone(phone, msg));
}

// ── Full emergency replacement flow ──────────────────────────────────────────

export async function runEmergencyReplacement(params: {
  appointmentId: string;
  clientId:      string;
  clientPhone:   string;
  appt:          any;
}): Promise<void> {
  const { appointmentId, clientId, clientPhone, appt } = params;
  const now = new Date().toISOString();

  const options = await scoreReplacements({
    clientId,
    appointmentId,
    date:      appt.date,
    time:      appt.time,
    excludeId: appt.caregiverId ?? "",
  });

  if (options.length === 0) {
    await handleNoReplacementsFound(appointmentId, clientId, clientPhone, appt);
    return;
  }

  const confirmToken = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const taskRef = await db.collection("agent_tasks").add({
    type:          "replacement_confirmation",
    appointmentId,
    clientId,
    clientPhone,
    options,
    confirmToken,
    status:        "awaiting_approval",
    expiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    createdAt:     now,
  });

  const numberEmojis = ["1️⃣", "2️⃣", "3️⃣"];
  const optionLines = options
    .slice(0, 3)
    .map((o, i) => {
      const rebookedNote = o.previouslyBooked ? " · booked before" : "";
      return `${numberEmojis[i]} ${o.name} · ${o.rating}⭐ · $${o.hourlyRate}/hr${rebookedNote}`;
    })
    .join("\n");

  const cancelMsg =
    `${appt.caregiverName ?? "Your caregiver"} had to cancel the ${appt.time} visit.\n\n` +
    `I found ${options.length} available caregiver${options.length > 1 ? "s" : ""}:\n\n` +
    `${optionLines}\n\n` +
    `Reply 1, 2, or 3. Nothing is booked until you confirm.`;

  await sendViaInteractionAgent(clientPhone, {
    content:     cancelMsg,
    urgency:     "immediate",
    sourceAgent: "emergency_replacement",
    canDrop:     false,
  }).catch(() => sendToPhone(clientPhone, cancelMsg));

  // Contact all candidates in parallel
  const caregiverSnaps = await Promise.all(
    options.slice(0, 3).map((o) => db.collection("caregivers").doc(o.caregiverId).get())
  );
  await Promise.all(
    options.slice(0, 3).map((o, i) => {
      const phone = caregiverSnaps[i].data()?.phone as string | undefined;
      return contactReplacementCandidate(
        { ...o, phone },
        { date: appt.date, time: appt.time, address: appt.address, durationHours: appt.durationHours },
        taskRef.id
      );
    })
  );

  // Schedule 30-min escalation in case no one responds
  await scheduleTrigger({
    userId:      clientId,
    phone:       clientPhone,
    type:        "custom",
    message:     `replacement_task:${taskRef.id}`,
    scheduledAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  }).catch((err) => console.error("scheduleTrigger (replacement escalation) error:", err));

  await db.collection("agent_alerts_log").add({
    type:          "emergency_replacement_started",
    clientId,
    phone:         clientPhone,
    appointmentId,
    taskId:        taskRef.id,
    sentAt:        now,
  });
}
