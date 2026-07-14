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
  idempotencyKey?: string;
}): Promise<void> {
  const db = admin.firestore();
  const ref = db.collection("users").doc(params.clientId)
                .collection("match_history").doc(params.caregiverId);

  let current = 0;
  let next = 0;
  let applied = false;
  await db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    const data = snap.data() ?? {};
    const processedSignalIds = Array.isArray(data.processedSignalIds)
      ? data.processedSignalIds.filter((value): value is string => typeof value === "string")
      : [];
    if (params.idempotencyKey && processedSignalIds.includes(params.idempotencyKey)) return;

    current = typeof data.weight === "number" ? data.weight : 0;
    next = Math.min(MAX_BOOST, Math.max(MAX_PENALTY, current + params.signal));
    const update: Record<string, unknown> = {
      weight:            next,
      lastUpdated:       new Date().toISOString(),
      lastSource:        params.source,
      lastAppointmentId: params.appointmentId ?? null,
      signalCount:       (typeof data.signalCount === "number" ? data.signalCount : 0) + 1,
    };
    if (params.idempotencyKey) {
      update.processedSignalIds = [...processedSignalIds.slice(-99), params.idempotencyKey];
    }
    transaction.set(ref, update, { merge: true });
    applied = true;
  });

  if (!applied) return;

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
