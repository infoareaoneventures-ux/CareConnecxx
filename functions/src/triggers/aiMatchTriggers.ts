import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import {
    ensureCaregiverEmbedding,
    runMatchingForIntake,
} from "../ai/matchJob";
import { composeCaregiverText, hashText } from "../ai/embeddings";
import { writeMatchOutcome } from "../ai/matchOutcomes";
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
        // Childcare U6 (plan 2026-07-22-002, R32/R34): a typed childcare
        // intake never enters this senior fan-out — childcare demand (job
        // post + eligibility-gated provider notification) is created
        // exclusively by v1-createChildcareJobPost. Skipping here prevents
        // the senior createJobPost/notifyAreaCaregivers pipeline (no
        // eligibility gate, legacy shapes) from ever seeing childcare.
        if (data.careVertical === "child") {
            console.log(`[onIntakeAiMatch] childcare intake ${intakeId} skipped — childcare demand flows through v1-createChildcareJobPost`);
            return null;
        }
        try {
            const result = await runMatchingForIntake(intakeId, data);
            console.log(
                `[onIntakeAiMatch] Wrote ${result?.count ?? 0} matches for client ${result?.clientId}`
            );

            if (result?.clientId) {
                // Public job post + caregiver SMS blast ONLY for paying families.
                // clientIntakes is now created at intake-confirm (pre-payment,
                // 2026-07-10) so this onCreate fires before checkout — the
                // matching above still runs (feeds the show-caregivers preview),
                // but the job goes public at payment via Evia's prefilled
                // job-post confirm (buildAndSaveJobPost → same job_posts/{uid}).
                const userSnap = await admin.firestore().collection("users").doc(result.clientId).get();
                const u = userSnap.data() ?? {};
                const paid = u.subscriptionActive === true || u.membershipStatus === "active";
                if (paid) {
                    await createJobPost(intakeId, data, result.clientId);
                    await notifyAreaCaregivers(intakeId, data, result.clientId);
                } else {
                    console.log(`[onIntakeAiMatch] intake ${intakeId}: client not subscribed yet — job post deferred to payment`);
                }
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
        // Childcare U6: same skip as onIntakeAiMatch (senior pipeline only).
        if (after.careVertical === "child") return null;
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
            await writeMatchOutcome({
                clientId,
                caregiverId,
                outcome: isPositive ? "hired" : "rejected",
                source: "hire_request",
                refId: context.params.requestId,
            });
        } catch (err) {
            console.error("[onHireRequestFeedback] failed:", err);
        }
        return null;
    });

// Learning-loop outcome writers. Web (PostsPage/useJobApplications) and Evia
// (mcp respond_to_job_application) both mutate job_applications.status
// directly, so this trigger is the single choke point that records the
// family's hire/pass decision regardless of surface.
export const onJobApplicationOutcome = functions.firestore
    .document("job_applications/{applicationId}")
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();
        if (!after || before?.status === after.status) return null;
        if (after.status !== "accepted" && after.status !== "rejected") return null;
        // Childcare U6 (R45): childcare application outcomes never feed the
        // senior match_outcomes learning loop (per-vertical reputation is U8
        // childcare/reputationProjection work). Senior rows unchanged.
        if (after.careVertical === "child") return null;
        try {
            await writeMatchOutcome({
                clientId: after.clientId,
                caregiverId: after.caregiverId,
                outcome: after.status === "accepted" ? "hired" : "rejected",
                source: "job_application",
                refId: context.params.applicationId,
            });
        } catch (err) {
            console.error("[onJobApplicationOutcome] failed:", err);
        }
        return null;
    });

// A client declining a video interview is a "pass" on that caregiver.
// Caregiver-side declines (declinedBy !== 'client') are availability, not a
// family decision, and are not recorded.
export const onVideoInterviewClientDecline = functions.firestore
    .document("video_interviews/{interviewId}")
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();
        if (!after || before?.status === after.status) return null;
        if (after.status !== "declined" || after.declinedBy !== "client") return null;
        // Childcare U6 (R45): childcare interview declines never feed the
        // senior match_outcomes learning loop.
        if (after.careVertical === "child") return null;
        try {
            await writeMatchOutcome({
                clientId: after.clientId,
                caregiverId: after.caregiverId,
                outcome: "rejected",
                source: "video_interview",
                refId: context.params.interviewId,
            });
        } catch (err) {
            console.error("[onVideoInterviewClientDecline] failed:", err);
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
