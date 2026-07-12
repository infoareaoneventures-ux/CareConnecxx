import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { quickComplete } from "../utils/openaiClient";
import { isCaregiverBookable } from "../utils/caregiverEligibility";
import { createShiftOffer } from "./shiftOffer";
import { generateCaraMessage } from "../utils/caraMessage";
import { answerHumanQuestionOnly } from "./humanReply";
import { businessTodayStr } from "../utils/scheduledTime";

const db = admin.firestore();

async function isQuestionOrOther(text: string): Promise<boolean> {
  try {
    const result = await quickComplete(
      "The user was shown a numbered list of upcoming visits and asked to pick one to swap the caregiver for. " +
      "Reply YES if their reply is a question or off-topic comment (about swap fees, timing, caregivers in general). " +
      "Reply NO if it is a selection (a number).",
      text,
      { maxTokens: 5 },
    );
    return result.trim().toUpperCase().startsWith("Y");
  } catch {
    return false;
  }
}

async function answerSwapQuestion(text: string): Promise<string> {
  return answerHumanQuestionOnly({
    audience: "family",
    situation: "family was shown upcoming visits and asked to pick one to swap the caregiver for",
    text,
    maxTokens: 180,
  });
}

export async function handleClientSwapRequest(
  clientId: string,
  clientPhone: string,
  text: string,
  session: Record<string, unknown>,
  chatId: string
): Promise<void> {
  const step = (session.clientSwapStep as string) ?? "identify_appointment";

  if (step === "identify_appointment") {
    // Business-timezone today — UTC hid tonight's shift after 5pm PT
    const today = businessTodayStr();
    const snap = await db.collection("appointments")
      .where("clientId", "==", clientId)
      .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
      .where("date", ">=", today)
      .orderBy("date", "asc")
      .limit(5)
      .get();

    if (snap.empty) {
      await sendMessage(chatId, await generateCaraMessage({
        audience: "family",
        language: (session.preferredLanguage as string) === "es" ? "es" : "en",
        context: "The family asked to swap the caregiver for an upcoming visit, but there aren't any upcoming visits on the calendar. Gently let them know.",
        fallback: "I don't see any upcoming visits to swap the caregiver for.",
        maxTokens: 60,
      }));
      return;
    }

    const visits = snap.docs.map((d, i) => ({
      index: i + 1,
      id: d.id,
      date: d.data().date,
      time: d.data().startTime ?? d.data().time,
      caregiverName: d.data().caregiverName,
      caregiverId: d.data().caregiverId,
      duration: d.data().durationHours ?? d.data().duration,
    }));

    await db.collection("agent_sessions").doc(clientPhone).update({
      clientSwapStep: "select_appointment",
      clientSwapVisits: JSON.stringify(visits),
    });

    const list = visits.map(v => `${v.index}. ${v.date} at ${v.time} with ${v.caregiverName}`).join("\n");
    await sendMessage(chatId, `Which visit do you want to swap the caregiver for?\n${list}\n\nReply with the number.`);
    return;
  }

  if (step === "select_appointment") {
    let visits: Array<{ index: number; id: string; date: string; time: string; caregiverName: string; caregiverId: string; duration: number }> = [];
    try {
      visits = JSON.parse((session.clientSwapVisits as string) ?? "[]");
    } catch {
      await sendMessage(chatId, "Something went wrong — let me start over. Which visit do you want to swap the caregiver for?");
      await db.collection("agent_sessions").doc(clientPhone).update({ clientSwapStep: "identify_appointment", clientSwapVisits: admin.firestore.FieldValue.delete() });
      return;
    }

    // Question guard — "what's a swap?" / "will I keep my schedule?" used to
    // get parsed as a number and rejected with "reply with a number".
    if (await isQuestionOrOther(text)) {
      const answer = await answerSwapQuestion(text);
      await sendMessage(chatId, answer);
      const list = visits.map(v => `${v.index}. ${v.date} at ${v.time} with ${v.caregiverName}`).join("\n");
      await sendMessage(chatId, `When you're ready, which visit do you want to swap?\n${list}\n\nReply with the number.`);
      return;
    }

    const pick = parseInt(text.trim(), 10);
    const visit = visits.find((v: any) => v.index === pick);
    if (!visit) {
      await sendMessage(chatId, `Reply with a number between 1 and ${visits.length}.`);
      return;
    }

    // Find available replacement caregivers
    const dayOfWeek = new Date(visit.date).toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
    const [shiftHour] = (visit.time ?? "09:00").split(":").map(Number);

    const caregiverSnap = await db.collection("caregivers")
      .where("verified", "==", true)
      .limit(30)
      .get();

    const options: Array<{ id: string; name: string; rate?: number }> = [];
    for (const doc of caregiverSnap.docs) {
      if (doc.id === visit.caregiverId) continue;
      const data = doc.data();
      if (!isCaregiverBookable(data)) continue;
      const avail = data.weeklyAvailability?.[dayOfWeek] as Array<{ start: string; end: string }> | undefined;
      if (!avail?.length) continue;
      const slotOk = avail.some(slot => {
        const startH = parseInt(slot.start.split(":")[0], 10);
        const endH   = parseInt(slot.end.split(":")[0], 10);
        return shiftHour >= startH && shiftHour < endH;
      });
      if (!slotOk) continue;
      const conflict = await db.collection("appointments")
        .where("caregiverId", "==", doc.id)
        .where("date", "==", visit.date)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .limit(1).get();
      if (!conflict.empty) continue;
      options.push({ id: doc.id, name: data.name ?? data.firstName ?? "Caregiver", rate: data.hourlyRate });
      if (options.length >= 3) break;
    }

    if (options.length === 0) {
      await sendMessage(chatId, await generateCaraMessage({
        audience: "family",
        language: (session.preferredLanguage as string) === "es" ? "es" : "en",
        context: `You searched but couldn't find an available replacement caregiver for the ${visit.date} visit. Gently let the family know, and offer to create a support ticket instead. Mention the ${visit.date} date.`,
        fallback: `I wasn't able to find an available replacement caregiver for ${visit.date}. Would you like me to create a support ticket instead?`,
        maxTokens: 80,
      }));
      await db.collection("agent_sessions").doc(clientPhone).update({ clientSwapStep: admin.firestore.FieldValue.delete() });
      return;
    }

    await db.collection("agent_sessions").doc(clientPhone).update({
      clientSwapStep: "select_caregiver",
      clientSwapAppointmentId: visit.id,
      clientSwapDate: visit.date,
      clientSwapOptions: JSON.stringify(options),
    });

    const list = options.map((o, i) => `${i + 1}. ${o.name}${o.rate ? ` — $${o.rate}/hr` : ""}`).join("\n");
    await sendMessage(chatId, `Here are available caregivers for ${visit.date}:\n${list}\n\nWhich one would you like? Reply with the number, or say CANCEL to keep your current caregiver.`);
    return;
  }

  if (step === "select_caregiver") {
    if (text.trim().toUpperCase() === "CANCEL") {
      await db.collection("agent_sessions").doc(clientPhone).update({ clientSwapStep: admin.firestore.FieldValue.delete() });
      await sendMessage(chatId, "No problem — keeping your current caregiver for that visit.");
      return;
    }

    let options: Array<{ id: string; name: string; rate?: number }> = [];
    try {
      options = JSON.parse((session.clientSwapOptions as string) ?? "[]");
    } catch {
      await sendMessage(chatId, "Something went wrong — let me start over. Which visit do you want to swap the caregiver for?");
      await db.collection("agent_sessions").doc(clientPhone).update({ clientSwapStep: "identify_appointment", clientSwapOptions: admin.firestore.FieldValue.delete() });
      return;
    }
    const pick = parseInt(text.trim(), 10);
    const chosen = options[pick - 1];
    if (!chosen) {
      await sendMessage(chatId, `Reply with a number between 1 and ${options.length}, or CANCEL.`);
      return;
    }

    const appointmentId = session.clientSwapAppointmentId as string;
    const swapDate      = session.clientSwapDate as string;

    await db.collection("agent_sessions").doc(clientPhone).update({ clientSwapStep: admin.firestore.FieldValue.delete() });

    // The appointment is NOT modified yet — the new caregiver must accept the
    // shift offer first (shiftOffer.ts applies the swap on YES).
    const newCgSnap = await db.collection("caregivers").doc(chosen.id).get();
    const newCgPhone = newCgSnap.data()?.phone as string | undefined;
    if (!newCgPhone) {
      await sendMessage(chatId,
        `I couldn't reach ${chosen.name} to confirm — your current caregiver is still assigned. ` +
        `Want to pick a different caregiver from the list?`
      );
      return;
    }

    const apptSnap = await db.collection("appointments").doc(appointmentId).get();
    const apptTime = (apptSnap.data()?.time ?? apptSnap.data()?.startTime ?? "") as string;

    await createShiftOffer({
      kind:           "swap",
      caregiverId:    chosen.id,
      caregiverName:  chosen.name,
      caregiverPhone: newCgPhone,
      clientId,
      clientPhone,
      appointmentIds: [appointmentId],
      payload: {
        date:                  swapDate,
        previousCaregiverId:   apptSnap.data()?.caregiverId ?? null,
        previousCaregiverName: apptSnap.data()?.caregiverName ?? null,
      },
      summary: `Cover a visit on ${swapDate}${apptTime ? ` at ${apptTime}` : ""} (client-requested caregiver swap)`,
      offerMessage:
        `Hi ${chosen.name} — a family would like you to cover a visit on ${swapDate}${apptTime ? ` at ${apptTime}` : ""}. ` +
        `I'll send the care plan and directions if you take it.`,
    });

    await sendMessage(chatId,
      `I've asked ${chosen.name} to confirm they can cover ${swapDate}. ` +
      `Your current caregiver stays assigned until ${chosen.name} accepts — I'll text you the moment they do.`
    );
  }
}
