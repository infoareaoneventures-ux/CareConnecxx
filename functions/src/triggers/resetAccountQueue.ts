// Admin "Reset Account" queue trigger — wipes EVERYTHING tied to a test account
// (uid + phone) so an end-to-end test can start from the signup page on a clean
// slate. Fires on adminResetQueue onCreate (same IAM-bypass pattern as
// adminAdvanceQueue).
//
// 2026-09-20 (founder: "reset should delete everything related to that
// account"): the first version deleted the account record, the conversation and
// the memory but left every booking, shift, timesheet, interview, review, chat
// room, bell entry, the Stripe customer + subscription, the preference record
// and the proactive triggers — so a "fresh" test still saw the old visits on the
// caregiver's side and inherited an active membership. Now: recursive deletes
// of every uid/phone-keyed document (subcollections included), field-keyed
// sweeps across every collection that references the account, and the Stripe
// subscription cancelled + customer deleted.
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

const db = admin.firestore();
const auth = admin.auth();

/** Documents keyed by the uid — deleted recursively (subcollections too). */
const UID_KEYED_DOCS = [
  "users", "customers", "clientIntakes", "carePlans", "care_plans", "senior_profiles", "job_postings",
  "agent_memory_files", "learned_facts", "memory_embeddings", "memory_reconciliation",
  "user_preferences", "agent_permissions", "caregivers", "publicCaregiverProfiles", "stripe_accounts",
];
/** Documents keyed by the phone number — deleted recursively. */
const PHONE_KEYED_DOCS = [
  "agent_sessions", "agent_conversations", "web_onboarding_sessions", "agent_tasks_active",
  "user_preferences", "agent_permissions", "day_patterns", "agent_prefetch", "agent_rate",
  "agent_inbound_locks", "agent_outbound_dedup", "agent_read_receipts", "agent_dnd_queue",
  "trigger_engagement", "wow_fires", "linq_pair_rate", "interviewRequestLimits",
];
/** Collections whose documents point at the account through one of these fields. */
const FIELD_KEYED_COLLECTIONS = [
  "booking_requests", "shifts", "shiftHours", "appointments", "video_interviews", "interviews", "reviews",
  "job_posts", "job_applications", "booking_amendments", "hire_decisions", "disputes", "invoices", "payments",
  "agent_tasks", "agent_objectives", "pending_actions", "pending_commitments", "proactive_triggers",
  "proactive_drafts", "user_triggers", "billingApprovalOutbox", "billingOperations", "admin_alerts",
  "support_tickets", "family_groups", "family_group_members", "email_change_requests", "phone_change_requests",
  "account_action_requests", "weekly_digests", "emergency_alerts", "emergency_events", "in_shift_updates",
  "shift_checkins", "shift_offers", "shift_swap_requests", "match_history", "match_outcomes", "clientMatches",
  "user_activity_feed", "agent_action_ledger", "agent_audit_log", "agent_uncertainty_log", "agent_event_log",
  "agent_approvals", "wellbeing_checkins", "consent_audit_log", "referrals", "seniors", "notifications",
  "caregiver_booked_slots", "appointment_care_plans", "carePlanVersions", "care_keepsakes", "health_summaries",
  "health_alerts_pending", "care_journal", "adminAdvanceQueue",
];
const KEY_FIELDS = ["clientId", "userId", "uid", "recipientId", "ownerId", "requesterId", "caregiverId"];
const PHONE_FIELDS = ["phone", "clientPhone", "caregiverPhone", "toPhone"];

async function deleteQueryResults(q: admin.firestore.Query, errors: string[], label: string): Promise<number> {
  let deleted = 0;
  try {
    // Loop in pages: a delete-all sweep must not stop at the first 500.
    for (let i = 0; i < 20; i++) {
      const snap = await q.limit(200).get();
      if (snap.empty) break;
      await Promise.all(snap.docs.map((d) => db.recursiveDelete(d.ref)));
      deleted += snap.size;
      if (snap.size < 200) break;
    }
  } catch (err) {
    errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return deleted;
}

async function stripeCleanup(uid: string, errors: string[]): Promise<void> {
  try {
    const custSnap = await db.collection("customers").doc(uid).get();
    const customerId = custSnap.data()?.stripeCustomerId as string | undefined;
    if (!customerId) return;
    const { getStripeClient } = await import("../stripe");
    const stripe = getStripeClient();
    const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 });
    for (const sub of subs.data) {
      if (["canceled", "incomplete_expired"].includes(sub.status)) continue;
      await stripe.subscriptions.cancel(sub.id).catch((err: Error) => errors.push(`stripe sub ${sub.id}: ${err.message}`));
    }
    // Deleting the customer also detaches its payment methods; test accounts only.
    await stripe.customers.del(customerId).catch((err: Error) => errors.push(`stripe customer: ${err.message}`));
  } catch (err) {
    errors.push(`stripe: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const processResetAccountQueue = functions.firestore
  .document("adminResetQueue/{docId}")
  .onCreate(async (snap) => {
    const { uid, phone } = snap.data() as { uid: string; phone: string; role?: string };

    if (!uid || !phone) {
      await snap.ref.update({ error: "uid and phone are required", processedAt: new Date().toISOString() });
      return;
    }

    const errors: string[] = [];
    const counts: Record<string, number> = {};

    // Stripe first — it needs customers/{uid}, which is deleted below.
    await stripeCleanup(uid, errors);

    // Firebase Auth login.
    await auth.deleteUser(uid).catch((err) => {
      if (err.code !== "auth/user-not-found") errors.push(`auth: ${err.message}`);
    });

    // Field-keyed sweeps: every document that points at the account or the phone.
    for (const coll of FIELD_KEYED_COLLECTIONS) {
      let n = 0;
      for (const f of KEY_FIELDS) n += await deleteQueryResults(db.collection(coll).where(f, "==", uid), errors, `${coll}.${f}`);
      for (const f of PHONE_FIELDS) n += await deleteQueryResults(db.collection(coll).where(f, "==", phone), errors, `${coll}.${f}`);
      if (n) counts[coll] = n;
    }
    // Chat rooms (incl. the support room) list the uid as a participant.
    counts.chatRooms = await deleteQueryResults(db.collection("chatRooms").where("participants", "array-contains", uid), errors, "chatRooms");
    // Family-group rosters list phones.
    counts.family_group_members_phones = await deleteQueryResults(db.collection("family_group_members").where("phones", "array-contains", phone), errors, "family_group_members.phones");

    // Keyed documents, subcollections included (users/{uid}/notifications, customers/{uid}/subscriptions, agent_sessions/{phone}/messages …).
    for (const coll of UID_KEYED_DOCS) await db.recursiveDelete(db.collection(coll).doc(uid)).catch((err) => errors.push(`${coll}/${uid}: ${err.message}`));
    for (const coll of PHONE_KEYED_DOCS) await db.recursiveDelete(db.collection(coll).doc(phone)).catch((err) => errors.push(`${coll}/${phone}: ${err.message}`));

    // Zep memory.
    try {
      const { getZepUserId: resolveId } = await import("../memory/zepClient");
      const zepUserId = resolveId(phone);
      const { ZepClient } = await import("@getzep/zep-cloud");
      const apiKey = process.env.ZEP_API_KEY ?? "";
      if (apiKey) {
        const zep = new ZepClient({ apiKey });
        await (zep.user as any).delete(zepUserId).catch((err: Error) => {
          if (!String(err).includes("404") && !String(err).includes("not found")) errors.push(`zep: ${err.message}`);
        });
      }
    } catch (err) {
      errors.push(`zep import: ${String(err)}`);
    }

    // Storage: profile photos, uploads, documents under the uid or phone.
    try {
      const bucket = admin.storage().bucket();
      for (const prefix of [`${uid}/`, `profile_photos/${uid}/`, `uploads/${phone}/`, `uploads/${uid}/`, `documents/${uid}/`]) {
        const [files] = await bucket.getFiles({ prefix });
        await Promise.all(files.map((f) => f.delete().catch(() => null)));
      }
    } catch (err) {
      errors.push(`storage: ${String(err)}`);
    }

    await snap.ref.update({
      processedAt: new Date().toISOString(),
      counts,
      ...(errors.length ? { errors } : { success: true }),
    });

    console.log(`[resetAccountQueue] uid=${uid} phone=${phone} done`, { counts, errors: errors.length ? errors : "none" });
  });
