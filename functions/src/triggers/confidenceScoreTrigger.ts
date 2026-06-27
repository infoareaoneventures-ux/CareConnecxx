import * as functions from "firebase-functions/v1";
import {
  computeConfidenceScoreFromFields,
  CONFIDENCE_SOURCE_FIELDS,
} from "../agents/confidenceScore";

/**
 * Recompute and persist a caregiver's confidence score whenever a source field
 * changes (U2). Loop-guarded twice: (1) it only fires when a CONFIDENCE_SOURCE
 * field actually changed — writing confidenceScore/confidenceSignals does not
 * retrigger, since those are not source fields; (2) it skips the write when the
 * recomputed value is unchanged.
 */
export const recomputeConfidenceScore = functions.firestore
  .document("caregivers/{caregiverId}")
  .onWrite(async (change) => {
    if (!change.after.exists) return; // deleted
    const after = change.after.data() as Record<string, unknown>;
    const before = (change.before.exists ? change.before.data() : {}) as Record<string, unknown>;

    const sourceChanged = CONFIDENCE_SOURCE_FIELDS.some(
      (f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]),
    );
    if (!sourceChanged) return;

    const result = computeConfidenceScoreFromFields(after);
    if (
      after.confidenceScore === result.score &&
      JSON.stringify(after.confidenceSignals) === JSON.stringify(result.signals)
    ) {
      return; // no change — avoid a redundant write
    }

    await change.after.ref.set(
      {
        confidenceScore: result.score,
        confidenceSignals: result.signals,
        confidenceScoreUpdatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
  });
