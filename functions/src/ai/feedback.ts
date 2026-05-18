import * as admin from "firebase-admin";

export type FeedbackMap = Map<string, number>;

const MAX_BOOST   =  5;  // max positive boost (pts)
const MAX_PENALTY = -5;  // max negative penalty (pts)

export async function writeFeedbackSignal(params: {
  clientId:       string;
  caregiverId:    string;
  signal:         number;  // e.g. +1, -1, +3, -2
  source:         "post_visit_feedback" | "hire" | "pass" | "health_signal";
  appointmentId?: string;
  rawText?:       string;
}): Promise<void> {
  const db = admin.firestore();
  const ref = db.collection("users").doc(params.clientId)
                .collection("match_history").doc(params.caregiverId);

  const snap = await ref.get();
  const current = snap.exists ? (snap.data()?.weight as number ?? 0) : 0;
  const next    = Math.min(MAX_BOOST, Math.max(MAX_PENALTY, current + params.signal));

  await ref.set({
    weight:            next,
    lastUpdated:       new Date().toISOString(),
    lastSource:        params.source,
    lastAppointmentId: params.appointmentId ?? null,
    signalCount:       admin.firestore.FieldValue.increment(1),
  }, { merge: true });

  console.log(
    `[writeFeedbackSignal] ${params.clientId} ↔ ${params.caregiverId}: ` +
    `${current} + ${params.signal} = ${next} (${params.source})`
  );
}

export async function readClientFeedback(
    clientId: string
): Promise<FeedbackMap> {
    const map = new Map<string, number>();
    if (!clientId) return map;
    try {
        const snap = await admin
            .firestore()
            .collection("users")
            .doc(clientId)
            .collection("match_history")
            .limit(500)
            .get();
        snap.forEach((doc) => {
            const data = doc.data();
            const raw = Number(data.weight || 0);
            if (raw === 0) return;
            // Clamp to [MAX_PENALTY, MAX_BOOST]
            map.set(doc.id, Math.min(MAX_BOOST, Math.max(MAX_PENALTY, raw)));
        });
    } catch (err) {
        console.warn("[readClientFeedback] failed:", err);
    }
    return map;
}

export function boostForCaregiver(
    feedback: FeedbackMap,
    caregiverId: string
): number {
    return feedback.get(caregiverId) || 0;
}
