import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";

const db = admin.firestore();

export async function handleClientSwapRequest(
  clientId: string,
  clientPhone: string,
  text: string,
  session: Record<string, unknown>,
  chatId: string
): Promise<void> {
  const step = (session.clientSwapStep as string) ?? "identify_appointment";

  if (step === "identify_appointment") {
    const today = new Date().toISOString().split("T")[0];
    const snap = await db.collection("appointments")
      .where("clientId", "==", clientId)
      .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
      .where("date", ">=", today)
      .orderBy("date", "asc")
      .limit(5)
      .get();

    if (snap.empty) {
      await sendMessage(chatId, "I don't see any upcoming visits to swap the caregiver for.");
      return;
    }

    const visits = snap.docs.map((d, i) => ({
      index: i + 1,
      id: d.id,
      date: d.data().date,
      time: d.data().time,
      caregiverName: d.data().caregiverName,
      caregiverId: d.data().caregiverId,
      duration: d.data().duration,
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
      await sendMessage(chatId, `I wasn't able to find an available replacement caregiver for ${visit.date}. Would you like me to create a support ticket instead?`);
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
    await db.collection("appointments").doc(appointmentId).update({
      caregiverId: chosen.id,
      caregiverName: chosen.name,
      swapNote: `Client-requested caregiver swap`,
    });

    await db.collection("agent_sessions").doc(clientPhone).update({ clientSwapStep: admin.firestore.FieldValue.delete() });

    // Notify new caregiver
    const newCgSnap = await db.collection("caregivers").doc(chosen.id).get();
    if (newCgSnap.exists && newCgSnap.data()?.chatId) {
      await sendMessage(newCgSnap.data()!.chatId, `Hi ${chosen.name}, you've been assigned a new visit on ${session.clientSwapDate}. Cara will send you more details soon.`);
    }

    await sendMessage(chatId, `Done — ${chosen.name} is now set for ${session.clientSwapDate}. I'll notify them. Let me know if you need anything else.`);
  }
}
