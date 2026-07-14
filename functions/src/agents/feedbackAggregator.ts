import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "./caraAgent";

const db = admin.firestore();

// ── Aggregate post-visit feedback into caregiver document ────────────────────

export async function aggregateFeedbackForCaregiver(caregiverId: string): Promise<void> {
  const snap = await db.collection("post_visit_feedback")
    .where("caregiverId", "==", caregiverId)
    .where("status", "==", "submitted")
    .get();

  if (snap.empty) return;

  let total = 0;
  let count = 0;
  let lastFeedbackAt = "";

  for (const doc of snap.docs) {
    const data = doc.data();
    const rating = data.rating as number | undefined;
    if (typeof rating === "number" && rating >= 1 && rating <= 5) {
      total += rating;
      count += 1;
    }
    const createdAt = data.createdAt as string | undefined;
    if (createdAt && createdAt > lastFeedbackAt) {
      lastFeedbackAt = createdAt;
    }
  }

  if (count === 0) return;

  const averageRating = Math.round((total / count) * 100) / 100;

  await db.collection("caregivers").doc(caregiverId).update({
    averageRating,
    rating: averageRating,   // matchingAgent.ts reads caregiver.rating
    ratingCount: count,
    lastFeedbackAt,
  });
}

// ── Create admin alert when a low rating is submitted ────────────────────────

export async function handleLowRating(
  caregiverId:   string,
  rating:        number,
  appointmentId: string,
  clientId:      string
): Promise<void> {
  const alertId = `low_caregiver_rating_${appointmentId}`.replace(/\//g, "%2F");
  await db.collection("admin_alerts").doc(alertId).set({
    type:          "low_caregiver_rating",
    caregiverId,
    rating,
    appointmentId,
    clientId,
    resolved:      false,
    priority:      "medium",
    createdAt:     new Date().toISOString(),
  }, { merge: true });
}

// ── Detect repeated negative feedback from same client → suggest switch ──────

async function checkSatisfactionTrend(
  caregiverId: string,
  clientId:    string,
): Promise<void> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const recentSnap = await db.collection("post_visit_feedback")
    .where("caregiverId", "==", caregiverId)
    .where("clientId",   "==", clientId)
    .where("createdAt",  ">=", thirtyDaysAgo)
    .get();

  const negCount = recentSnap.docs.filter(d => (d.data().rating as number) <= 2).length;
  if (negCount < 2) return;

  // Gate: only suggest once per 14 days per (client, caregiver) pair
  const gateKey = `satisfactionAlertSent_${caregiverId}`;
  const clientSnap = await db.collection("users").doc(clientId).get();
  const clientData = clientSnap.data() ?? {};
  const lastSent   = clientData[gateKey] as string | undefined;
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  if (lastSent && lastSent > fourteenDaysAgo) return;

  // Look up client phone from agent_sessions
  const sessionSnap = await db.collection("agent_sessions")
    .where("userId", "==", clientId)
    .limit(1)
    .get();
  if (sessionSnap.empty) return;
  const clientPhone = sessionSnap.docs[0].id;

  // Get caregiver name
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
  const cgName = cgSnap.exists
    ? `${cgSnap.data()!.firstName ?? ""} ${cgSnap.data()!.lastName ?? ""}`.trim() || "your caregiver"
    : "your caregiver";

  await sendViaInteractionAgent(clientPhone, {
    content: `I noticed you've had a few visits with ${cgName} that didn't go as well as hoped. Would you like me to find someone new who might be a better fit? Just say "find a new caregiver" and I'll get started.`,
    urgency:     "standard",
    sourceAgent: "feedback_aggregator",
    canDrop:     true,
  }).catch(() => {});

  await db.collection("users").doc(clientId).update({
    [gateKey]: new Date().toISOString(),
  });
}

// ── Single entry point after any feedback is saved ───────────────────────────

export async function onFeedbackSubmitted(
  caregiverId:   string,
  rating:        number,
  appointmentId: string,
  clientId:      string
): Promise<void> {
  await aggregateFeedbackForCaregiver(caregiverId);

  if (rating < 3.5) {
    await handleLowRating(caregiverId, rating, appointmentId, clientId);
  }

  if (rating <= 2) {
    checkSatisfactionTrend(caregiverId, clientId).catch((err) =>
      console.error("[feedbackAggregator] checkSatisfactionTrend error:", err)
    );
  }
}
