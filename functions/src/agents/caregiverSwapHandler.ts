import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { parseWithClaude } from "../utils/parseWithClaude";
import { isCaregiverBookable } from "../utils/caregiverEligibility";
import { generateCaraMessage } from "../utils/caraMessage";
import { answerHumanMidFlow } from "./humanReply";
import { businessTodayStr } from "../utils/scheduledTime";

const db = admin.firestore();

async function isSwapQuestion(text: string, reAsk: string): Promise<boolean> {
  const result = await parseWithClaude(
    `A caregiver is in a shift-swap flow. Current question: "${reAsk}". ` +
      "Reply YES if their message is a question or off-topic rather than a direct answer. Reply NO otherwise. Only reply YES or NO.",
    text,
    5,
  );
  return result.toUpperCase().startsWith("Y");
}

async function answerSwapMidFlow(text: string, reAsk: string): Promise<string> {
  return answerHumanMidFlow({
    audience: "caregiver",
    situation: "caregiver is finding coverage for one of their shifts",
    text,
    reAsk,
  });
}

export async function handleCaregiverSwapRequest(
  caregiverId: string,
  caregiverName: string,
  caregiverPhone: string,
  text: string,
  session: Record<string, unknown>,
  chatId: string
): Promise<void> {
  const step = (session.swapStep as string) ?? "identify_shift";

  // ── isQuestionOrOther guard (skip on identify_shift initial entry where text
  //    is the original "SWAP" intent message, not a step answer) ──────────────
  if (step === "confirm_shift") {
    const reAsk = "Reply with the number of the shift you need covered, or CANCEL.";
    if (await isSwapQuestion(text, reAsk)) {
      await sendMessage(chatId, await answerSwapMidFlow(text, reAsk));
      return;
    }
  }

  if (step === "identify_shift") {
    // Find upcoming confirmed appointments for this caregiver
    // Business-timezone today — UTC hid tonight's shift after 5pm PT
    const today = businessTodayStr();
    const snap = await db.collection("appointments")
      .where("caregiverId", "==", caregiverId)
      .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
      .where("date", ">=", today)
      .orderBy("date", "asc")
      .limit(5)
      .get();

    if (snap.empty) {
      await sendMessage(chatId, await generateCaraMessage({
        audience: "caregiver",
        language: (session.preferredLanguage as string) === "es" ? "es" : "en",
        context: "The caregiver asked to swap a shift, but they don't have any upcoming shifts on the calendar. Gently let them know there's nothing to swap right now.",
        fallback: "You don't have any upcoming shifts to swap.",
        maxTokens: 60,
      }));
      return;
    }

    const shifts = snap.docs.map((d, i) => ({
      index: i + 1,
      id: d.id,
      date: d.data().date,
      time: d.data().startTime ?? d.data().time,
      clientName: d.data().clientName,
      clientId: d.data().clientId,
      duration: d.data().durationHours ?? d.data().duration,
    }));

    await db.collection("agent_sessions").doc(caregiverPhone).update({
      swapStep: "confirm_shift",
      swapCandidates: JSON.stringify(shifts),
    });

    const list = shifts.map(s => `${s.index}. ${s.date} at ${s.time} — ${s.clientName}`).join("\n");
    await sendMessage(chatId, `Which shift do you need covered?\n${list}\n\nReply with the number.`);
    return;
  }

  if (step === "confirm_shift") {
    let candidates: Array<{ index: number; id: string; date: string; time: string; clientName: string; clientId: string; duration: number }> = [];
    try {
      candidates = JSON.parse((session.swapCandidates as string) ?? "[]");
    } catch {
      await sendMessage(chatId, "Something went wrong — let me start over. Which shift do you need covered?");
      await db.collection("agent_sessions").doc(caregiverPhone).update({ swapStep: "identify_shift", swapCandidates: admin.firestore.FieldValue.delete() });
      return;
    }
    const pick = parseInt(text.trim(), 10);
    const shift = candidates.find((s) => s.index === pick);

    if (!shift) {
      await sendMessage(chatId, `Please reply with a number between 1 and ${candidates.length}.`);
      return;
    }

    await db.collection("agent_sessions").doc(caregiverPhone).update({
      swapStep: "broadcasting",
      swapShiftId: shift.id,
      swapShiftDate: shift.date,
      swapClientId: shift.clientId,
    });

    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: (session.preferredLanguage as string) === "es" ? "es" : "en",
      context: `The caregiver picked the shift on ${shift.date} at ${shift.time} with the ${shift.clientName} family to get covered. Warmly confirm you've got it, tell them you'll find available caregivers now and reach out, and you'll let them know when someone accepts. Mention the date/time and the ${shift.clientName} family.`,
      fallback: `Got it — ${shift.date} at ${shift.time} with the ${shift.clientName} family. I'll find available caregivers now and reach out to them. I'll let you know when someone accepts.`,
      maxTokens: 90,
    }));

    // Find available caregivers and broadcast
    await broadcastSwapRequest(caregiverId, caregiverName, shift, caregiverPhone, chatId);
    return;
  }
}

async function broadcastSwapRequest(
  fromCaregiverId: string,
  fromCaregiverName: string,
  shift: any,
  fromPhone: string,
  fromChatId: string
): Promise<void> {
  // Query available caregivers
  const caregiverSnap = await db.collection("caregivers")
    .where("verified", "==", true)
    .limit(30)
    .get();

  const dayOfWeek = new Date(shift.date).toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
  const [shiftHour] = (shift.time ?? "09:00").split(":").map(Number);

  // Filter: not the requesting caregiver, available that day, not already booked
  const candidates: Array<{ id: string; name: string; phone: string; chatId?: string }> = [];

  for (const doc of caregiverSnap.docs) {
    if (doc.id === fromCaregiverId) continue;
    const data = doc.data();

    // Canonical bookability post-filter (the where() above is index pre-filtering only)
    if (!isCaregiverBookable(data)) continue;

    // Check weekly availability
    const avail = data.weeklyAvailability?.[dayOfWeek] as Array<{ start: string; end: string }> | undefined;
    if (!avail?.length) continue;
    const slotOk = avail.some(slot => {
      const startH = parseInt(slot.start.split(":")[0], 10);
      const endH   = parseInt(slot.end.split(":")[0], 10);
      return shiftHour >= startH && shiftHour < endH;
    });
    if (!slotOk) continue;

    // Check not already booked
    const conflictSnap = await db.collection("appointments")
      .where("caregiverId", "==", doc.id)
      .where("date", "==", shift.date)
      .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
      .limit(1)
      .get();
    if (!conflictSnap.empty) continue;

    candidates.push({ id: doc.id, name: data.name ?? data.firstName ?? "Caregiver", phone: data.phone, chatId: data.chatId });
    if (candidates.length >= 3) break;
  }

  if (candidates.length === 0) {
    await sendMessage(fromChatId, await generateCaraMessage({
      audience: "caregiver",
      language: "en",
      context: "You searched but couldn't find any available caregivers to cover this caregiver's shift. Gently let them know, and suggest they may need to contact their coordinator or cancel the shift directly.",
      fallback: "I wasn't able to find any available caregivers for that shift. You may need to contact your coordinator or cancel the shift directly.",
      maxTokens: 80,
    }));
    await db.collection("agent_sessions").doc(fromPhone).update({ swapStep: admin.firestore.FieldValue.delete() });
    return;
  }

  // Create swap request doc
  const swapRef = await db.collection("shift_swap_requests").add({
    appointmentId: shift.id,
    fromCaregiverId,
    fromCaregiverName,
    clientId: shift.clientId,
    date: shift.date,
    time: shift.time,
    duration: shift.duration,
    status: "open",
    candidatesContacted: candidates.map(c => c.id),
    candidateResponses: [],
    initiatedBy: "caregiver",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  // Text each candidate
  for (const candidate of candidates) {
    if (!candidate.chatId && !candidate.phone) continue;
    const targetChatId = candidate.chatId ?? candidate.phone;
    const msg = `Hi ${candidate.name}, ${fromCaregiverName} is looking for coverage:\n📅 ${shift.date} at ${shift.time}\n👤 ${shift.clientName ?? "a family"}\n\nAre you available? Reply ACCEPT or DECLINE.`;
    try {
      await sendMessage(targetChatId, msg);
      // Mark their session with the pending swap
      await db.collection("agent_sessions").doc(candidate.phone ?? candidate.id).set(
        {
          pendingSwapRequestId: swapRef.id,
          pendingSwapFromName:  fromCaregiverName,
          pendingSwapSetAt:     new Date().toISOString(),
        },
        { merge: true }
      );
    } catch (e) {
      console.error(`Failed to reach candidate ${candidate.id}:`, e);
    }
  }
}

export async function handleSwapAcceptance(
  caregiverId: string,
  caregiverName: string,
  swapRequestId: string,
  chatId: string
): Promise<void> {
  const swapRef = db.collection("shift_swap_requests").doc(swapRequestId);
  const swapDoc = await swapRef.get();
  if (!swapDoc.exists) {
    await sendMessage(chatId, "That swap request is no longer available.");
    return;
  }
  const swap = swapDoc.data()!;
  // Cheap pre-check for the common (uncontended) case and a fast UX reply.
  if (swap.status !== "open") {
    await sendMessage(chatId, "This shift has already been filled. Thanks anyway!");
    return;
  }

  // Authoritative claim: re-read status INSIDE the transaction so two caregivers
  // accepting concurrently can't both win. Without this, both pass the pre-check
  // above and the second tx's blind update overwrites the first (last-write-wins
  // on appointments.caregiverId). Mirrors shiftOffer.ts claimOffer.
  let claimed = false;
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(swapRef);
    if (!fresh.exists || fresh.data()!.status !== "open") {
      return; // another caregiver won the race — leave their assignment intact
    }
    claimed = true;
    tx.update(swapRef, {
      status: "accepted",
      toCaregiverId: caregiverId,
      toCaregiverName: caregiverName,
      acceptedAt: new Date().toISOString(),
    });
    tx.update(db.collection("appointments").doc(swap.appointmentId), {
      caregiverId,
      caregiverName,
      swappedFrom: swap.fromCaregiverId,
      swapNote: `Swapped from ${swap.fromCaregiverName} to ${caregiverName}`,
    });
  });

  if (!claimed) {
    await sendMessage(chatId, "This shift has already been filled. Thanks anyway!");
    return;
  }

  // Confirm with accepting caregiver
  await sendMessage(chatId, await generateCaraMessage({
    audience: "caregiver",
    language: "en",
    context: `The caregiver just accepted coverage for the ${swap.date} shift — it's now theirs. Warmly confirm it's theirs, let them know the family will be notified, and thank them. Mention the ${swap.date} date.`,
    fallback: `You've got it! The ${swap.date} shift is now yours. The family will be notified. Thank you!`,
    maxTokens: 80,
  }));

  // Notify original caregiver
  const fromSnap = await db.collection("caregivers").doc(swap.fromCaregiverId).get();
  if (fromSnap.exists && fromSnap.data()?.chatId) {
    await sendMessage(fromSnap.data()!.chatId, `Good news — ${caregiverName} has accepted coverage for your ${swap.date} shift. You're all set!`);
  }

  // Notify client
  const clientSnap = await db.collection("users").doc(swap.clientId).get();
  if (clientSnap.exists && clientSnap.data()?.chatId) {
    await sendMessage(clientSnap.data()!.chatId, await generateCaraMessage({
      audience: "family",
      language: "en",
      context: `Letting the family know their caregiver for the ${swap.date} visit has changed — ${caregiverName} will be covering it now. Warmly reassure them and invite any questions. Mention the ${swap.date} date and that ${caregiverName} is covering.`,
      fallback: `Heads up — your caregiver for ${swap.date} has changed. ${caregiverName} will be covering that visit. Let me know if you have any questions.`,
      maxTokens: 80,
    }));
  }
}
