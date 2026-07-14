import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

// Care-plan version history.
//
// Canonical care-plan path (bug-audit §6.1 consolidation, 2026-07-06): the live
// plan is the TOP-LEVEL document `care_plans/{clientId}` — the same path the MCP
// get_care_plan / update_care_plan tools read and write. Version snapshots live
// in its `versions` subcollection: `care_plans/{clientId}/versions/{autoId}`.
//
// This trigger fires on every write to a live plan doc and appends a snapshot of
// the NEW state (`after`) — so `versions` is a complete forward history and the
// live doc always equals the most recent version. Restoring a version writes the
// live doc, which fires this trigger again and records the restored state as the
// newest version.
//
// Loop-safe: this writes to the `versions` SUBCOLLECTION, not to the
// `care_plans/{clientId}` document, so it does not re-fire itself.
export const onCarePlanWrite = functions.firestore
  .document("care_plans/{clientId}")
  .onWrite(async (change, context) => {
    const before = change.before.exists ? change.before.data() : null;
    const after  = change.after.exists  ? change.after.data()  : null;
    if (!after) return;                                      // deletion — nothing to snapshot
    if (before && JSON.stringify(before) === JSON.stringify(after)) return; // no-op write

    const { clientId } = context.params;
    await db.collection("care_plans").doc(clientId)
      .collection("versions").add({
        carePlan:  after,                                    // full plan state at this version
        savedAt:   new Date().toISOString(),
        changedBy: (after.lastUpdatedBy as string | undefined) ?? "unknown",
        summary:   before ? buildChangeSummary(before, after) : "Care plan created",
      });
  });

function buildChangeSummary(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const changes: string[] = [];
  const fields = ["medications", "careNeeds", "dietaryNotes", "doctorContacts", "specialInstructions", "notes"];
  for (const field of fields) {
    const bVal = JSON.stringify(before[field]);
    const aVal = JSON.stringify(after[field]);
    if (bVal !== aVal) changes.push(field.replace(/([A-Z])/g, " $1").toLowerCase());
  }
  return changes.length ? `Updated: ${changes.join(", ")}` : "Care plan updated";
}
