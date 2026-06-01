import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";

const db = admin.firestore();

// ── onDisputeCreated — notify both parties and set 48h SLA ────────────────────

export const onDisputeCreated = functions.firestore
  .document("disputes/{disputeId}")
  .onCreate(async (snap, context) => {
    const disputeId = context.params.disputeId;
    const dispute   = snap.data();
    if (!dispute) return;

    const { clientId, caregiverId, appointmentId, reason } = dispute;

    // Load phones for both parties
    const [clientSnap, caregiverSnap] = await Promise.all([
      db.collection("users").doc(clientId ?? "").get(),
      db.collection("caregivers").doc(caregiverId ?? "").get(),
    ]);

    const clientPhone    = clientSnap.data()?.phone as string | undefined;
    const caregiverPhone = caregiverSnap.data()?.phone as string | undefined;

    const slaDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    // Record SLA deadline on the dispute
    await snap.ref.update({ slaDeadline, status: "open", notifiedAt: new Date().toISOString() });

    const displayReason = (reason as string | undefined) ?? "a billing concern";

    // Notify family
    if (clientPhone) {
      await sendViaInteractionAgent(clientPhone, {
        content:
          `We received a dispute regarding ${displayReason}.\n\n` +
          `Our team is reviewing it and will respond within 48 hours. ` +
          `Reply with any additional details you'd like us to consider.`,
        urgency:     "standard",
        sourceAgent: "dispute_resolution",
        canDrop:     false,
      }).catch(err => console.error("[onDisputeCreated] notify client failed:", err));
    }

    // Notify caregiver
    if (caregiverPhone) {
      await sendViaInteractionAgent(caregiverPhone, {
        content:
          `A dispute has been filed regarding ${displayReason}.\n\n` +
          `Please reply with your account of what happened so we can review it fairly.`,
        urgency:     "standard",
        sourceAgent: "dispute_resolution",
        canDrop:     false,
      }).catch(err => console.error("[onDisputeCreated] notify caregiver failed:", err));
    }

    // Log admin alert
    await db.collection("admin_alerts").add({
      type:        "dispute_opened",
      disputeId,
      clientId,
      caregiverId,
      appointmentId,
      reason,
      slaDeadline,
      createdAt:   new Date().toISOString(),
      resolved:    false,
    });

    console.log(`[onDisputeCreated] Dispute ${disputeId} opened, SLA: ${slaDeadline}`);
  });

// ── checkDisputeSLAs — runs every hour, escalates disputes past 48h ───────────

export const checkDisputeSLAs = functions.pubsub
  .schedule("0 * * * *")   // top of every hour
  .onRun(async () => {
    const now = new Date().toISOString();

    const snap = await db.collection("disputes")
      .where("status",      "==", "open")
      .where("slaDeadline", "<=", now)
      .get();

    if (snap.empty) return null;

    for (const doc of snap.docs) {
      const dispute = doc.data();
      try {
        await escalateDispute(doc.id, dispute);
      } catch (err) {
        console.error(`[checkDisputeSLAs] escalation failed for dispute ${doc.id}:`, err);
      }
    }

    console.log(`[checkDisputeSLAs] Escalated ${snap.size} overdue disputes`);
    return null;
  });

async function escalateDispute(disputeId: string, dispute: any): Promise<void> {
  // Mark escalated so it doesn't get picked up again
  await db.collection("disputes").doc(disputeId).update({
    status:      "escalated",
    escalatedAt: new Date().toISOString(),
  });

  // Notify both parties of escalation
  const [clientSnap, caregiverSnap] = await Promise.all([
    db.collection("users").doc(dispute.clientId ?? "").get(),
    db.collection("caregivers").doc(dispute.caregiverId ?? "").get(),
  ]);

  const clientPhone    = clientSnap.data()?.phone    as string | undefined;
  const caregiverPhone = caregiverSnap.data()?.phone as string | undefined;

  const escalationMsg =
    "Your dispute has been escalated to our senior care team for a final decision. " +
    "You'll hear from us within 24 hours.";

  if (clientPhone) {
    await sendViaInteractionAgent(clientPhone, {
      content:     escalationMsg,
      urgency:     "standard",
      sourceAgent: "dispute_resolution",
      canDrop:     false,
    }).catch(() => {});
  }
  if (caregiverPhone) {
    await sendViaInteractionAgent(caregiverPhone, {
      content:     escalationMsg,
      urgency:     "standard",
      sourceAgent: "dispute_resolution",
      canDrop:     false,
    }).catch(() => {});
  }

  // Mark admin alert for immediate attention
  await db.collection("admin_alerts").add({
    type:        "dispute_escalated",
    disputeId,
    clientId:    dispute.clientId,
    caregiverId: dispute.caregiverId,
    createdAt:   new Date().toISOString(),
    resolved:    false,
    priority:    "high",
  });

  console.log(`[escalateDispute] Dispute ${disputeId} escalated`);
}
