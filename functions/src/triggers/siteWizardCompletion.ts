// ── The questionnaire finished ON THE SITE while the text cursor still sat on a
// collection step (2026-10-19, founder: "after I clicked Looks good to complete
// the care plan, Evia didn't text me anything or what my next step is").
//
// The dashboard shows the next card the moment the wizard finishes; by text the
// person hears the same thing as it happens (standing rule: the family is told
// of everything they would see in-app). ONE text, sent through the SAME gate
// senders Evia's own flow uses (identity check for a family, membership for a
// care provider), with the session cursor parked exactly where Evia's flow
// would park it. The decision rules and the once-only claim live in
// agents/siteWizardSync.ts, shared with the inbound webhook's reconcile.
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import {
  familyWizardFinishedOnSite, providerWizardFinishedOnSite, sessionStillCollecting, claimSiteWizardNotice,
} from "../agents/siteWizardSync";
import type { OnboardingRole } from "../agents/onboardingContract";

export { familyWizardFinishedOnSite, providerWizardFinishedOnSite, sessionStillCollecting };

const db = admin.firestore();

async function findSessionByUid(uid: string): Promise<FirebaseFirestore.QueryDocumentSnapshot | null> {
  const byUser = await db.collection("agent_sessions").where("userId", "==", uid).limit(1).get();
  if (!byUser.empty) return byUser.docs[0];
  const byCaregiver = await db.collection("agent_sessions").where("caregiverId", "==", uid).limit(1).get();
  return byCaregiver.empty ? null : byCaregiver.docs[0];
}

async function sendNextGate(role: OnboardingRole, uid: string, eventId: string): Promise<void> {
  const doc = await findSessionByUid(uid);
  if (!doc) return; // never texted Evia — no channel to speak on; the dashboard card is what they see
  const session = doc.data() as Record<string, any>;
  if (!session.chatId || session.optedOut === true) return;
  if (!sessionStillCollecting(role, session.onboardingStep)) return;
  if (!(await claimSiteWizardNotice(doc.id, role, eventId))) return;

  const conv = await import("../agents/onboardingConversation");
  if (role === "caregiver") await conv.advanceCaregiverAfterSiteWizard(doc.id, session.chatId as string, session as any);
  else await conv.advanceClientAfterSiteWizard(doc.id, session.chatId as string, session as any);
}

export const onFamilyWizardFinishedOnSite = functions.firestore
  .document("job_postings/{uid}")
  .onWrite(async (change, context) => {
    if (!familyWizardFinishedOnSite(change.before.data(), change.after.data())) return;
    await sendNextGate("client", context.params.uid as string, context.eventId)
      .catch((err) => console.error(`[onFamilyWizardFinishedOnSite] failed for ${context.params.uid}:`, err));
  });

export const onProviderWizardFinishedOnSite = functions.firestore
  .document("caregivers/{uid}")
  .onUpdate(async (change, context) => {
    if (!providerWizardFinishedOnSite(change.before.data(), change.after.data())) return;
    await sendNextGate("caregiver", context.params.uid as string, context.eventId)
      .catch((err) => console.error(`[onProviderWizardFinishedOnSite] failed for ${context.params.uid}:`, err));
  });
