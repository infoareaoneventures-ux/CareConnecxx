import firebase from "firebase/compat/app";
import { auth, db } from "../lib/firebase";

export type MatchSignal = "favorited" | "messaged" | "hired" | "interviewed";

const SIGNAL_WEIGHTS: Record<MatchSignal, number> = {
    favorited: 1,
    interviewed: 3,
    messaged: 3,
    hired: 5,
};

export async function logMatchSignal(
    caregiverId: string,
    signal: MatchSignal
): Promise<void> {
    const fdb = db;
    if (!auth || !fdb) return;
    const user = auth.currentUser;
    if (!user || !caregiverId) return;
    try {
        const ref = fdb
            .collection("users")
            .doc(user.uid)
            .collection("match_history")
            .doc(caregiverId);
        await ref.set(
            {
                caregiverId,
                [`signals.${signal}`]: firebase.firestore.FieldValue.serverTimestamp(),
                weight: firebase.firestore.FieldValue.increment(
                    SIGNAL_WEIGHTS[signal]
                ),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );
    } catch (err) {
        console.warn("[logMatchSignal] failed", err);
    }
}
