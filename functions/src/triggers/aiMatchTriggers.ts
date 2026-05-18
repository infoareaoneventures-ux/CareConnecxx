import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import {
    ensureCaregiverEmbedding,
    runMatchingForIntake,
} from "../ai/matchJob";
import { composeCaregiverText, hashText } from "../ai/embeddings";
import { createJobPost, notifyAreaCaregivers } from "./jobNotifications";

const CAREGIVER_EMBED_FIELDS = [
    "skills",
    "specializations",
    "specialties",
    "medicalSkills",
    "certifications",
    "languages",
    "bio",
    "about",
    "yearsExperience",
    "experience",
    "personalityTags",
    "personality",
    "adls",
    "adlSkills",
    "gender",
    "petFriendly",
    "hasTransportation",
];

function caregiverFieldsChanged(before: any, after: any): boolean {
    if (!before) return true;
    return CAREGIVER_EMBED_FIELDS.some((f) => {
        const a = JSON.stringify(before[f] ?? null);
        const b = JSON.stringify(after[f] ?? null);
        return a !== b;
    });
}

export const onCaregiverWrite = functions.firestore
    .document("caregivers/{caregiverId}")
    .onWrite(async (change, context) => {
        const caregiverId = context.params.caregiverId;
        const after = change.after.exists ? change.after.data() : null;
        if (!after) return null;

        const before = change.before.exists ? change.before.data() : null;

        if (before && !caregiverFieldsChanged(before, after)) {
            return null;
        }

        const sourceText = composeCaregiverText(after);
        if (!sourceText) return null;

        if (after.embeddingInputHash === hashText(sourceText)) {
            return null;
        }

        console.log(`[onCaregiverWrite] Re-embedding ${caregiverId}`);
        await ensureCaregiverEmbedding(caregiverId, after);

        try {
            await rescoreActiveIntakes();
        } catch (err) {
            console.error("[onCaregiverWrite] rescore failed:", err);
        }
        return null;
    });

async function rescoreActiveIntakes(): Promise<void> {
    const db = admin.firestore();
    let cursor: admin.firestore.QueryDocumentSnapshot | null = null;
    let totalRescored = 0;

    // Paginate through all active intakes so no records are missed
    while (true) {
        let query = db
            .collection("clientIntakes")
            .where("status", "in", ["active", "open", "pending"])
            .orderBy("createdAt", "desc")
            .limit(100);
        if (cursor) query = query.startAfter(cursor) as typeof query;

        const page = await query.get().catch(() => null);
        if (!page || page.empty) break;

        for (const doc of page.docs) {
            const data = doc.data();
            if (!data) continue;
            try {
                await runMatchingForIntake(doc.id, data);
                totalRescored++;
            } catch (err) {
                console.error(`[rescoreActiveIntakes] failed for intake ${doc.id}:`, err);
            }
        }

        if (page.docs.length < 100) break; // last page
        cursor = page.docs[page.docs.length - 1];
    }

    console.log(`[rescoreActiveIntakes] Rescored ${totalRescored} intakes`);
}

export const onIntakeAiMatch = functions.firestore
    .document("clientIntakes/{intakeId}")
    .onCreate(async (snap, context) => {
        const intakeId = context.params.intakeId;
        const data = snap.data();
        if (!data) return null;
        try {
            const result = await runMatchingForIntake(intakeId, data);
            console.log(
                `[onIntakeAiMatch] Wrote ${result?.count ?? 0} matches for client ${result?.clientId}`
            );

            if (result?.clientId) {
                await createJobPost(intakeId, data, result.clientId);
                await notifyAreaCaregivers(intakeId, data, result.clientId);
            }
        } catch (err) {
            console.error("[onIntakeAiMatch] failed:", err);
        }
        return null;
    });

export const onIntakeUpdatedAiMatch = functions.firestore
    .document("clientIntakes/{intakeId}")
    .onUpdate(async (change, context) => {
        const intakeId = context.params.intakeId;
        const before = change.before.data();
        const after = change.after.data();
        if (!after) return null;
        const watched = ["careTypes", "tasks", "schedule", "additionalComments", "location"];
        const changed = watched.some(
            (f) => JSON.stringify(before?.[f] ?? null) !== JSON.stringify(after?.[f] ?? null)
        );
        if (!changed) return null;
        try {
            const result = await runMatchingForIntake(intakeId, after);
            console.log(
                `[onIntakeUpdatedAiMatch] Refreshed ${result?.count ?? 0} matches for ${result?.clientId}`
            );
        } catch (err) {
            console.error("[onIntakeUpdatedAiMatch] failed:", err);
        }
        return null;
    });

export const onHireRequestFeedback = functions.firestore
    .document("hire_requests/{requestId}")
    .onWrite(async (change, context) => {
        const after = change.after.exists ? change.after.data() : null;
        if (!after) return null;
        const before = change.before.exists ? change.before.data() : null;
        if (before && before.status === after.status) return null;

        const clientId = after.clientId;
        const caregiverId = after.caregiverId;
        if (!clientId || !caregiverId) return null;

        const positiveStatuses = ["coordinator_approved", "caregiver_accepted", "booking_created"];
        const negativeStatuses = ["rejected", "dismissed", "coordinator_rejected", "client_rejected"];

        const isPositive = positiveStatuses.includes(after.status);
        const isNegative = negativeStatuses.includes(after.status);
        if (!isPositive && !isNegative) return null;

        try {
            if (isPositive) {
                await admin
                    .firestore()
                    .collection("users")
                    .doc(clientId)
                    .collection("match_history")
                    .doc(caregiverId)
                    .set(
                        {
                            caregiverId,
                            signal: "hired",
                            signals: { hired: FieldValue.serverTimestamp() },
                            weight: FieldValue.increment(5),
                            updatedAt: FieldValue.serverTimestamp(),
                        },
                        { merge: true }
                    );
                console.log(
                    `[onHireRequestFeedback] Logged 'hired' for client ${clientId} ↔ caregiver ${caregiverId}`
                );
            } else {
                // Negative signal: reduce boost weight so this caregiver ranks lower in future
                await admin
                    .firestore()
                    .collection("users")
                    .doc(clientId)
                    .collection("match_history")
                    .doc(caregiverId)
                    .set(
                        {
                            caregiverId,
                            signal: "rejected",
                            signals: { rejected: FieldValue.serverTimestamp() },
                            weight: FieldValue.increment(-3),
                            updatedAt: FieldValue.serverTimestamp(),
                        },
                        { merge: true }
                    );
                console.log(
                    `[onHireRequestFeedback] Logged 'rejected' for client ${clientId} ↔ caregiver ${caregiverId}`
                );
            }
        } catch (err) {
            console.error("[onHireRequestFeedback] failed:", err);
        }
        return null;
    });

export const refreshAllMatchesWeekly = functions.pubsub
    .schedule("every monday 04:00")
    .timeZone("America/Los_Angeles")
    .onRun(async () => {
        const db = admin.firestore();
        const intakes = await db
            .collection("clientIntakes")
            .orderBy("createdAt", "desc")
            .limit(200)
            .get()
            .catch(() => null);
        if (!intakes || intakes.empty) {
            console.log("[refreshAllMatchesWeekly] No intakes to refresh");
            return null;
        }
        let count = 0;
        for (const doc of intakes.docs) {
            try {
                await runMatchingForIntake(doc.id, doc.data());
                count++;
            } catch (err) {
                console.error(
                    `[refreshAllMatchesWeekly] failed for ${doc.id}:`,
                    err
                );
            }
        }
        console.log(`[refreshAllMatchesWeekly] Refreshed ${count} intakes`);
        return null;
    });
