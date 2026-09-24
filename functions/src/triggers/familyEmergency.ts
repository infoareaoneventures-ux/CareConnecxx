import * as functions from "firebase-functions/v1";
import { raiseFamilyEmergency } from "../emergency";

// The website's red Emergency button (components/client/FamilyEmergency.tsx).
// Same path as Evia's trigger_emergency_alert tool — see emergency.ts.
export const triggerFamilyEmergency = functions.https.onCall(async (data, context) => {
  if (!context.auth?.uid) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }
  const { shiftId, note } = (data ?? {}) as { shiftId?: string; note?: string };
  const result = await raiseFamilyEmergency({
    clientId: context.auth.uid,
    shiftId: typeof shiftId === "string" && shiftId ? shiftId : null,
    note: typeof note === "string" && note ? note : null,
    source: "site",
  });
  return { success: true, ...result };
});
