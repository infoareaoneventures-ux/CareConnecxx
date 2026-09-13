import * as admin from "firebase-admin";

const db = admin.firestore();

// 2026-09-13 live incident: every caller of this used to read
// caregivers/{uid}.phone directly — a field that doesn't exist under the
// unified identity model (caregivers/{uid} = users/{uid} = Auth uid; the
// real phone lives on users/{uid}.phone, same source resolveClientPhone
// uses for clients elsewhere). Confirmed empirically: a real, active
// caregiver's `caregivers` doc had zero phone-shaped field at all, while
// their `users/{uid}.phone` had the real number.
//
// This wasn't just a missed-notification bug — three MCP tools
// (update_caregiver_profile, pause_account, reactivate_account) used the
// same read as a "fail closed unless BOTH phones exist and match" OWNERSHIP
// check. Since caregivers/{uid}.phone is always undefined, that check has
// been unconditionally rejecting every caregiver, always, regardless of who
// was asking — a caregiver has never been able to successfully update their
// profile, pause, or reactivate their account through Evia.
//
// Mirrors resolveClientPhone's fallback order (functions/src/triggers/
// interviewLinkTrigger.ts): users/{uid}.phone first, then the legacy
// caregivers/{uid}.phone read (in case any pre-unification doc still
// carries its own phone field), then a phone-keyed agent_sessions lookup.
export async function resolveCaregiverPhone(caregiverId?: string): Promise<string | undefined> {
  if (!caregiverId) return undefined;
  const userSnap = await db.collection("users").doc(caregiverId).get();
  const userPhone = userSnap.data()?.phone as string | undefined;
  if (userPhone) return userPhone;
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
  const cgPhone = cgSnap.data()?.phone as string | undefined;
  if (cgPhone) return cgPhone;
  const sessSnap = await db.collection("agent_sessions").where("userId", "==", caregiverId).limit(1).get();
  return sessSnap.empty ? undefined : sessSnap.docs[0].id; // agent_sessions are phone-keyed
}
