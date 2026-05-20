import * as admin from "firebase-admin";

const db = admin.firestore();

// State stored in agent_sessions.refundStep
// Steps: identify_visit → confirm → submitted

export async function handleRefundRequest(
  clientId: string,
  text: string,
  session: Record<string, unknown>,
  sendMessage: (msg: string) => Promise<void>
): Promise<void> {
  const step = (session.refundStep as string) ?? "identify_visit";

  if (step === "identify_visit") {
    // Get recent appointments for this client
    const apptSnap = await db.collection("appointments")
      .where("clientId", "==", clientId)
      .where("status", "in", ["completed", "confirmed"])
      .orderBy("isoDate", "desc")
      .limit(5)
      .get();

    if (apptSnap.empty) {
      await sendMessage("I don't see any recent visits to refund. If you think this is a mistake, I can create a support ticket for you.");
      await db.collection("agent_sessions").doc(clientId).update({ refundStep: admin.firestore.FieldValue.delete() });
      return;
    }

    const visits = apptSnap.docs.map((d, i) => {
      const data = d.data();
      return {
        index:         i + 1,
        id:            d.id,
        date:          data.date as string,
        caregiverName: data.caregiverName as string,
        cost:          data.cost as number | undefined,
      };
    });

    await db.collection("agent_sessions").doc(clientId).update({
      refundStep:       "confirm",
      refundCandidates: JSON.stringify(visits),
    });

    const list = visits
      .map(v => `${v.index}. ${v.date} with ${v.caregiverName} — $${v.cost ?? "?"}`)
      .join("\n");
    await sendMessage(`Which visit would you like a refund for?\n${list}\n\nReply with the number.`);
    return;
  }

  if (step === "confirm") {
    const candidates = JSON.parse((session.refundCandidates as string) ?? "[]") as Array<{
      index: number;
      id: string;
      date: string;
      caregiverName: string;
      cost?: number;
    }>;
    const pick = parseInt(text.trim(), 10);
    const visit = candidates.find(v => v.index === pick);

    if (!visit) {
      await sendMessage(`Please reply with a number between 1 and ${candidates.length}.`);
      return;
    }

    await db.collection("agent_sessions").doc(clientId).update({
      refundStep:          "submitted",
      refundAppointmentId: visit.id,
    });

    await sendMessage(
      `Just to confirm — you want a refund for the ${visit.date} visit with ${visit.caregiverName}? ` +
      `Reply YES to submit the request.`
    );
    return;
  }

  if (step === "submitted") {
    const norm = text.trim().toUpperCase();
    if (norm !== "YES") {
      await sendMessage("No problem — refund request cancelled. Let me know if you need anything else.");
      await db.collection("agent_sessions").doc(clientId).update({
        refundStep:          admin.firestore.FieldValue.delete(),
        refundAppointmentId: admin.firestore.FieldValue.delete(),
        refundCandidates:    admin.firestore.FieldValue.delete(),
      });
      return;
    }

    const appointmentId = session.refundAppointmentId as string;
    await db.collection("refundRequests").add({
      clientId,
      appointmentId,
      status:      "pending_review",
      requestedAt: new Date().toISOString(),
      source:      "cara_self_service",
    });

    await db.collection("agent_sessions").doc(clientId).update({
      refundStep:          admin.firestore.FieldValue.delete(),
      refundAppointmentId: admin.firestore.FieldValue.delete(),
      refundCandidates:    admin.firestore.FieldValue.delete(),
    });

    await sendMessage(
      "Your refund request has been submitted. An admin will review it within 24 hours and you'll hear back via text. " +
      "If approved, it typically takes 3–5 business days to appear on your statement."
    );
  }
}
