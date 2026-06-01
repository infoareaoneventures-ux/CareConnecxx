import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

// Save a version of the care plan every time it changes
export const onCarePlanWrite = functions.firestore
  .document("senior_profiles/{seniorId}/care_plans/{planId}")
  .onWrite(async (change, context) => {
    const before = change.before.exists ? change.before.data() : null;
    const after  = change.after.exists  ? change.after.data()  : null;
    if (!before || !after) return; // skip create and delete
    if (JSON.stringify(before) === JSON.stringify(after)) return; // no change

    const { seniorId } = context.params;
    await db.collection("senior_profiles").doc(seniorId)
      .collection("carePlanVersions").add({
        carePlan:  before,
        savedAt:   new Date().toISOString(),
        changedBy: (after.lastUpdatedBy as string | undefined) ?? "unknown",
        summary:   buildChangeSummary(before, after),
      });
  });

function buildChangeSummary(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const changes: string[] = [];
  const fields = ["medications", "careNeeds", "dietaryNotes", "doctorContacts", "specialInstructions"];
  for (const field of fields) {
    const bVal = JSON.stringify(before[field]);
    const aVal = JSON.stringify(after[field]);
    if (bVal !== aVal) changes.push(field.replace(/([A-Z])/g, " $1").toLowerCase());
  }
  return changes.length ? `Updated: ${changes.join(", ")}` : "Care plan updated";
}
