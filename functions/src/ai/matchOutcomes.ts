import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

export type MatchOutcomeKind = "hired" | "rejected";
export type MatchOutcomeSource = "job_application" | "video_interview";

/**
 * Server-side writer for the `match_outcomes` collection — the learning-loop
 * data consumed by matchingAgent.ts (buildFamilyMatchHistory) and
 * outcomeAnalytics.ts (getOutcomePatternSummary). Until 2026-07-06 only the
 * web wrote here (services/api.ts recordMatchOutcome, no live callers), so
 * the collection stayed empty in prod.
 *
 * Doc ID is `${source}_${refId}` so trigger retries and evolving statuses
 * upsert one row per decision instead of duplicating. `timestamp` is an ISO
 * string to match the web writer's shape (readers orderBy("timestamp")).
 */
export async function writeMatchOutcome(opts: {
  clientId: string | undefined;
  caregiverId: string | undefined;
  outcome: MatchOutcomeKind;
  source: MatchOutcomeSource;
  refId: string;
}): Promise<void> {
  const { clientId, caregiverId, outcome, source, refId } = opts;
  if (!clientId || !caregiverId || !refId) return;
  await admin
    .firestore()
    .collection("match_outcomes")
    .doc(`${source}_${refId}`)
    .set(
      {
        clientId,
        caregiverId,
        outcome,
        source,
        refId,
        timestamp: new Date().toISOString(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}
