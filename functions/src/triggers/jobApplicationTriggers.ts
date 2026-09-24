import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

// Applications in these statuses count toward the job's applicantCount.
// "withdrawn" applications do NOT count.
const COUNTED_STATUSES = new Set(["pending", "accepted", "rejected"]);

function counts(status: string | undefined | null): boolean {
  return !!status && COUNTED_STATUSES.has(status);
}

/**
 * Maintains job_posts/{jobId}.applicantCount in response to writes on
 * job_applications/{appId}. Used by the Job Board "Less than 10 applicants"
 * badge.
 *
 * Create   → +1 (if status counts)
 * Delete   → -1 (if prior status counted)
 * Status change:
 *   counted → not-counted (e.g. withdrawn): -1
 *   not-counted → counted (re-applied): +1
 *   same bucket: no-op
 * jobId change: decrement old, increment new (rare/defensive)
 */
export const onJobApplicationWrite = functions.firestore
    .document("job_applications/{appId}")
    .onWrite(async (change, context) => {
        const before = change.before.exists ? change.before.data() : null;
        const after = change.after.exists ? change.after.data() : null;

        const beforeJobId: string | undefined = before?.jobId;
        const afterJobId: string | undefined = after?.jobId;
        const beforeStatus: string | undefined = before?.status;
        const afterStatus: string | undefined = after?.status;

        const beforeCounts = before ? counts(beforeStatus) : false;
        const afterCounts = after ? counts(afterStatus) : false;

        const deltas = new Map<string, number>();
        const bump = (jobId: string | undefined, delta: number) => {
            if (!jobId || delta === 0) return;
            deltas.set(jobId, (deltas.get(jobId) ?? 0) + delta);
        };

        if (beforeJobId && afterJobId && beforeJobId !== afterJobId) {
            // jobId changed — settle both sides
            if (beforeCounts) bump(beforeJobId, -1);
            if (afterCounts) bump(afterJobId, +1);
        } else {
            const jobId = afterJobId ?? beforeJobId;
            if (!beforeCounts && afterCounts) bump(jobId, +1);
            else if (beforeCounts && !afterCounts) bump(jobId, -1);
        }

        if (deltas.size === 0) return null;

        const db = admin.firestore();
        const ops: Promise<unknown>[] = [];
        for (const [jobId, delta] of deltas) {
            const ref = db.collection("job_posts").doc(jobId);
            ops.push(
                db.runTransaction(async (tx) => {
                    const snap = await tx.get(ref);
                    if (!snap.exists) return;
                    const current = (snap.data()?.applicantCount as number) ?? 0;
                    const next = Math.max(0, current + delta);
                    tx.update(ref, { applicantCount: next });
                }),
            );
        }

        try {
            await Promise.all(ops);
        } catch (err) {
            console.error("[onJobApplicationWrite] counter update failed", {
                appId: context.params.appId,
                deltas: Array.from(deltas.entries()),
                err,
            });
        }
        return null;
    });

