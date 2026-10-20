// ── Site → Evia for a FAMILY mid-signup (2026-10-19) ─────────────────────────
// The family's questionnaire can finish on the site while the text cursor still
// sits on a collection step. Three doors converge here so the next thing the
// person hears by text is the next CARD the dashboard shows (identity check,
// then membership), never the first question again:
//   1. triggers/siteWizardCompletion.ts — the moment job_postings flips to active
//   2. linq/webhooks.ts, before routing a text — the twin of the care provider's
//      reconcileCaregiverOnboardingWithSite
//   3. the web bridge's first "Hey Evia" — when the wizard was finished first
// ONE text, claimed once on the session (siteWizardNoticeAt), through the same
// gate sender Evia's own flow uses (advanceClientAfterSiteWizard).
//
// Evia's OWN completion never double-texts: complete_collection parks the first
// gate step BEFORE anything is stamped, and persistClientCareRecords runs at
// client_confirm_intake — neither is a "still collecting" step.
import * as admin from "firebase-admin";
import { CLIENT_COLLECTION_STEPS, CAREGIVER_COLLECTION_STEPS, type OnboardingRole } from "./onboardingContract";

const db = admin.firestore();

// A family's text intake also has the scripted post-collection steps (start date,
// preferences, budget) — the site wizard covers those too. client_confirm_intake
// is deliberately NOT here: that is where Evia's own completion writes the record.
const CLIENT_SITE_FINISHABLE = new Set<string>([...CLIENT_COLLECTION_STEPS, "client_ask_start", "client_ask_preferences", "client_ask_budget"]);
const CAREGIVER_SITE_FINISHABLE = new Set<string>(CAREGIVER_COLLECTION_STEPS);

/** Pure decision: is the text cursor still on something the site just finished? */
export function sessionStillCollecting(role: OnboardingRole, step: unknown): boolean {
  const s = String(step ?? "");
  return role === "caregiver" ? CAREGIVER_SITE_FINISHABLE.has(s) : CLIENT_SITE_FINISHABLE.has(s);
}

/** The site's createJobPosting flips the record to active at the wizard's last step. */
export function familyWizardFinishedOnSite(before: Record<string, any> | undefined, after: Record<string, any> | undefined): boolean {
  return before?.status !== "active" && after?.status === "active";
}

/** The site's bio save stamps profile_complete at the wizard's last step. */
export function providerWizardFinishedOnSite(before: Record<string, any> | undefined, after: Record<string, any> | undefined): boolean {
  return before?.onboardingStatus !== "profile_complete" && after?.onboardingStatus === "profile_complete";
}

/**
 * Claim the one site-finished notice for this session, inside a transaction that
 * re-checks the cursor — a retried trigger event, a text arriving in the same
 * second, or Evia's own completion landing in between must never make a second
 * text. Returns true exactly once.
 */
export async function claimSiteWizardNotice(phone: string, role: OnboardingRole, eventId: string): Promise<boolean> {
  const ref = db.collection("agent_sessions").doc(phone);
  return db.runTransaction(async (tx) => {
    const fresh = await tx.get(ref);
    if (!fresh.exists) return false;
    const d = (fresh.data() ?? {}) as Record<string, any>;
    if (d.siteWizardNoticeAt) return false;
    if (!sessionStillCollecting(role, d.onboardingStep)) return false;
    tx.update(ref, { siteWizardNoticeAt: new Date().toISOString(), siteWizardNoticeEventId: eventId });
    return true;
  });
}

/**
 * Before routing a family's text: if the site already finished their questionnaire
 * (job_postings/{uid}.status === "active") while the cursor still sits on a
 * collection step, send the next gate and park the cursor there. Returns true when
 * the turn was handled (the caller sends nothing else). Best-effort: any read
 * failure returns false and the turn routes as before.
 */
export async function reconcileClientOnboardingWithSite(phone: string, session: Record<string, any>, eventId = "inbound"): Promise<boolean> {
  try {
    if (session.userType === "caregiver") return false;
    if (!sessionStillCollecting("client", session.onboardingStep)) return false;
    const uid = session.userId as string | undefined;
    const chatId = session.chatId as string | undefined;
    if (!uid || !chatId || session.optedOut === true) return false;
    const jp = await db.collection("job_postings").doc(uid).get();
    if (!jp.exists || jp.data()?.status !== "active") return false;
    if (!(await claimSiteWizardNotice(phone, "client", eventId))) return false;
    const conv = await import("./onboardingConversation");
    await conv.advanceClientAfterSiteWizard(phone, chatId, session as any);
    return true;
  } catch (err) {
    console.error("reconcileClientOnboardingWithSite failed (non-fatal):", err);
    return false;
  }
}
