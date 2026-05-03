import * as admin from "firebase-admin";

export type FeedbackMap = Map<string, number>;

const MAX_BOOST = 5;    // max positive boost (pts)
const MAX_PENALTY = -5; // max negative penalty (pts)

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
