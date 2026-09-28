import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { jobTitle } from "../agents/situationSnapshot";
import { gateOptionalSend } from "./engineGate";

const db = admin.firestore();

// Give the one-time "you got an applicant" alert (onJobApplicationCreate, notificationTriggers.ts) time
// to be acted on before we follow up.
export const MIN_AGE_MS = 24 * 60 * 60 * 1000;
// At most one follow-up nudge per job per this window — never become a daily nag.
export const COOLDOWN_MS = 48 * 60 * 60 * 1000;

/**
 * Pure decision: should this open job trigger a stale-applicant nudge right now?
 * Extracted so the guard logic (freshness + cooldown) is unit-tested without
 * Firestore. The scheduled job below handles the I/O and message send.
 */
export function shouldNudgeStaleApplicants(p: {
  pendingCount:    number;
  oldestPendingMs: number | null;
  lastNudgedMs:    number | null;
  nowMs:           number;
}): boolean {
  if (p.pendingCount <= 0) return false;
  if (p.oldestPendingMs === null) return false;
  if (p.nowMs - p.oldestPendingMs < MIN_AGE_MS) return false;            // too fresh — the initial alert owns this window
  if (p.lastNudgedMs !== null && p.nowMs - p.lastNudgedMs < COOLDOWN_MS) return false; // already nudged recently
  return true;
}

/**
 * Stale-applicant nudge. `onJobApplicationCreate` (notificationTriggers.ts) alerts the family ONCE when a
 * caregiver applies; if they don't act, applicants go stale and caregivers feel
 * ghosted. This follows up — gently, at most once per 48h per job — so the
 * marketplace doesn't silently leak applicants.
 *
 * Read-only except the send + a cooldown marker on the job; no money/booking
 * path. Mirrors the established scheduled-nudge pattern (pendingDecisionNudge):
 * per-item idempotency marker, opt-out / onboarding guards, one nudge per client
 * per run, generateCaraMessage + sendViaInteractionAgent(canDrop) which respects
 * DND/dedup downstream.
 */
export const sendStaleApplicantNudges = functions.pubsub
  .schedule("0 16 * * *") // once daily, late afternoon; DND queueing handled downstream
  .onRun(async () => {
    const nowMs = Date.now();

    // Single-field inequality → auto-indexed. Status filtered in memory to avoid
    // a composite index requirement.
    const jobsSnap = await db.collection("job_posts")
      .where("applicantCount", ">", 0)
      .orderBy("applicantCount", "desc")
      .limit(300)
      .get();

    const nudgedClients = new Set<string>();

    for (const jobDoc of jobsSnap.docs) {
      const job = jobDoc.data();
      try {
        if ((job.status as string) !== "open") continue;

        const clientId = (job.clientId ?? job.userId ?? "") as string;
        if (!clientId || nudgedClients.has(clientId)) continue;

        const lastNudgedMs = job.staleApplicantNudgedAt
          ? Date.parse(job.staleApplicantNudgedAt as string) || null
          : null;
        // Cheap cooldown gate before the applications read.
        if (lastNudgedMs !== null && nowMs - lastNudgedMs < COOLDOWN_MS) continue;

        const appSnap = await db.collection("job_applications")
          .where("jobId", "==", jobDoc.id)
          .where("status", "==", "pending")
          .orderBy("appliedAt", "asc")
          .limit(10)
          .get();
        const pending = appSnap.docs;
        const oldestPendingMs = pending.length
          ? (Date.parse(pending[0].data().appliedAt as string) || null)
          : null;

        if (!shouldNudgeStaleApplicants({
          pendingCount: pending.length,
          oldestPendingMs,
          lastNudgedMs,
          nowMs,
        })) continue;

        // Resolve the client session — mirrors the applicant alert.
        const sessionQ = await db.collection("agent_sessions")
          .where("userId", "==", clientId)
          .limit(1)
          .get();
        if (sessionQ.empty) continue;
        const sessionDoc  = sessionQ.docs[0];
        const sessionData = sessionDoc.data();
        if (sessionData.optedOut) continue;
        if (sessionData.onboardingStep !== "complete") continue;
        const phone = (sessionData.phone ?? sessionDoc.id) as string;

        // U8 engine gate (KTD15): optional discretionary follow-up — the
        // engine decides per recipient per pass. A lost pass re-enters on the
        // next daily run (no cooldown marker is stamped when the gate skips).
        const g = await gateOptionalSend({
          phone,
          candidate: {
            source: "staleApplicantNudge",
            category: "visit_risk",
            urgency: 2,
            evidenceCount: 1,
            dedupeKey: `staleapp:${clientId}:${new Date(nowMs).toISOString().slice(0, 10)}`,
          },
        });
        if (!g.allowed) {
          console.info("staleApplicantNudge.policy", { phone, disposition: g.disposition, reason: g.reason });
          continue;
        }

        const count = pending.length;
        const label = jobTitle(job);

        const message = await generateCaraMessage({
          audience: "family",
          context:
            `The family has ${count} caregiver${count === 1 ? "" : "s"} still waiting to hear back on their job post (${label}). ` +
            `Gently nudge them to take a look — offer to pull up the strongest fit or set up an intro call. ` +
            `One or two warm sentences, no pressure, no guilt.`,
          fallback:
            `You've still got ${count} caregiver${count === 1 ? "" : "s"} waiting on your ${label} post — want me to pull up the best fit?`,
          maxTokens: 100,
        });

        await sendViaInteractionAgent(phone, {
          content:     message,
          urgency:     "standard",
          sourceAgent: "stale_applicant_nudge",
          canDrop:     true,
        });

        await jobDoc.ref.update({ staleApplicantNudgedAt: new Date().toISOString() }).catch(() => {});
        nudgedClients.add(clientId);
      } catch (err) {
        console.error(`[sendStaleApplicantNudges] error for job ${jobDoc.id}:`, err);
      }
    }
  });
