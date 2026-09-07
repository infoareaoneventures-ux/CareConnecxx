import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

// Mirrors the real SMS/TCPA opt-out (agent_sessions.optedOut, set by the STOP
// keyword — see sms.ts's optOutPhoneNumber/optInPhoneNumber) onto the
// caregiver's own document, so the shared bookability gate
// (utils/caregiverEligibility.ts's isCaregiverBookable) can see it as a plain
// field on the doc it already reads — the same pattern pausedUntil already
// uses, and the same field caregivers.optedOut this project already had a
// (previously dead) check for in matchingAgent.ts's isTemporarilyUnavailable.
//
// Found 2026-09-06: nothing anywhere checked the real opt-out before this —
// a caregiver who texted STOP could still be suggested as a match on the
// site or by Evia, even though Evia can no longer reach them to relay
// anything. isCaregiverBookable() itself can't do this lookup directly (it's
// a pure, dependency-free, sync function so the frontend can mirror it
// exactly — it has no way to reach a different collection), so this trigger
// denormalizes the value onto the one doc that function already reads.
export const mirrorCaregiverOptOut = functions.firestore
  .document("agent_sessions/{phone}")
  .onWrite(async (change, context) => {
    if (!change.after.exists) return;
    const after  = change.after.data() as Record<string, unknown>;
    const before = change.before.exists ? (change.before.data() as Record<string, unknown>) : null;

    if (after.userType !== "caregiver") return;
    const optedOut = after.optedOut === true;
    // Fast skip: nothing changed that this trigger cares about.
    if (before && (before.optedOut === true) === optedOut) return;

    const phone = context.params.phone as string;
    try {
      const caregiverId = typeof after.caregiverId === "string" && after.caregiverId
        ? after.caregiverId
        : (await db.collection("caregivers").where("phone", "==", phone).limit(1).get())
            .docs[0]?.id;
      if (!caregiverId) return;

      const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
      if (!cgSnap.exists || cgSnap.data()?.optedOut === optedOut) return;

      await cgSnap.ref.update({ optedOut });
    } catch (err) {
      console.error(`mirrorCaregiverOptOut error for ${phone}:`, err);
    }
  });
