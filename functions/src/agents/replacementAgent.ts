import * as admin from "firebase-admin";
import { sendToPhone } from "../linq/client";
import { sendViaInteractionAgent } from "./caraAgent";
import { scoreReplacements, ReplacementOption } from "./replacementScorer";
import { scheduleTrigger } from "../triggers/triggerEngine";

const db = admin.firestore();

// ── Contact a replacement candidate via Linq ──────────────────────────────────

export async function contactReplacementCandidate(
  caregiver: ReplacementOption & { phone?: string },
  appt: { date: string; time: string; address?: string; durationHours?: number; hourlyRate?: number; clientId?: string; seniorName?: string },
  taskId: string
): Promise<void> {
  if (!caregiver.phone) return;

  const earnings = ((appt.hourlyRate ?? caregiver.hourlyRate ?? 22) * (appt.durationHours ?? 4)).toFixed(2);

  // Fetch care notes so the substitute arrives informed
  let careNoteLines = "";
  if (appt.clientId) {
    try {
      const [carePlanSnap, lastJournalSnap] = await Promise.all([
        db.collection("care_plans").doc(appt.clientId).get(),
        db.collection("care_journal")
          .where("seniorId", "==", appt.clientId)
          .orderBy("timestamp", "desc")
          .limit(1)
          .get(),
      ]);
      const carePlan = carePlanSnap.data();
      const meds  = (carePlan?.medications as string[] | undefined) ?? [];
      const needs = (carePlan?.careNeeds   as string[] | undefined) ?? [];
      const lastNote = lastJournalSnap.empty
        ? null
        : (lastJournalSnap.docs[0].data().notes as string | undefined)?.slice(0, 100);
      const noteLines: string[] = [];
      if (needs.length)  noteLines.push(`Needs: ${needs.slice(0, 3).join(", ")}`);
      if (meds.length)   noteLines.push(`Meds: ${meds.slice(0, 2).join(", ")}`);
      if (lastNote)      noteLines.push(`Last visit: ${lastNote}`);
      if (noteLines.length) careNoteLines = `\n${noteLines.join("\n")}`;
    } catch { /* non-critical */ }
  }

  const seniorLine = appt.seniorName ? `Client: ${appt.seniorName}\n` : "";

  const msg =
    `Hi ${caregiver.name.split(" ")[0]} — urgent opening today.\n\n` +
    `${appt.date} at ${appt.time}\n` +
    (appt.address ? `${appt.address}\n` : "") +
    seniorLine +
    `~$${earnings} for the visit` +
    careNoteLines +
    `\n\nReply YES if you can take it, or NO to pass.`;

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
    `${appt.caregiverName ?? "Your caregiver"} had to cancel and I wasn't able to find a replacement right now. ` +
    `I've flagged this for our team and I'm searching for new options — someone will follow up within the hour.`;

  await sendViaInteractionAgent(phone, {
    content:     msg,
    urgency:     "immediate",
    sourceAgent: "emergency_replacement",
    canDrop:     false,
  }).catch(() => sendToPhone(phone, msg));

  // Kick off a fresh broad matching pass as a fallback
  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
  if (sessionSnap.exists) {
    const session = sessionSnap.data()!;
    const { runMatchingForClient } = await import("./matchingAgent");
    runMatchingForClient(phone, session.chatId ?? "", session, session).catch(err =>
      console.error("[handleNoReplacementsFound] fallback re-match failed:", err)
    );
  }
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

  // This is a safety-critical path: the family has been told coverage is being found.
  // A thrown error must NOT be silently swallowed by a fire-and-forget caller, so we
  // catch at the top level and raise an admin alert.
  try {
  // Mark replacement as in-progress so Evia can tell the family what's happening
  await db.collection("agent_tasks_active").doc(clientPhone).set({
    type:        "emergency_replacement",
    status:      "searching",
    startedAt:   now,
    description: `Searching for a replacement for ${appt.caregiverName ?? "your caregiver"}'s cancelled ${appt.time ?? ""} visit`,
  }).catch(() => {});

  const options = await scoreReplacements({
    clientId,
    appointmentId,
    date:      appt.date,
    time:      appt.time,
    excludeId: appt.caregiverId ?? "",
  });

  if (options.length === 0) {
    await db.collection("agent_tasks_active").doc(clientPhone).delete().catch(() => {});
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

  // Update active task status — waiting for family to pick
  await db.collection("agent_tasks_active").doc(clientPhone).set({
    type:        "emergency_replacement",
    status:      "awaiting_family_choice",
    taskId:      taskRef.id,
    startedAt:   now,
    description: `${options.length} replacement option${options.length > 1 ? "s" : ""} found — waiting for your reply`,
  }).catch(() => {});

  // Contact all candidates in parallel
  const caregiverSnaps = await Promise.all(
    options.slice(0, 3).map((o) => db.collection("caregivers").doc(o.caregiverId).get())
  );
  await Promise.all(
    options.slice(0, 3).map((o, i) => {
      const phone = caregiverSnaps[i].data()?.phone as string | undefined;
      return contactReplacementCandidate(
        { ...o, phone },
        {
          date: appt.date, time: appt.time, address: appt.address,
          durationHours: appt.durationHours, hourlyRate: appt.hourlyRate,
          clientId, seniorName: appt.clientName ?? appt.seniorName,
        },
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
  } catch (err) {
    console.error("[runEmergencyReplacement] failed:", err);
    await db.collection("admin_alerts").add({
      type:          "emergency_replacement_failed",
      severity:      "critical",
      appointmentId,
      clientId,
      clientPhone,
      error:         String((err as any)?.message ?? err),
      createdAt:     new Date().toISOString(),
    }).catch(() => {});
    // Best-effort: clear the in-progress marker so Evia doesn't claim it's still searching.
    await db.collection("agent_tasks_active").doc(clientPhone).delete().catch(() => {});
    // Do not re-throw: the alert + cleanup above is the full handling. Re-throwing would
    // double-alert (the webhooks caller also catches) and serves no recovery purpose.
  }
}
