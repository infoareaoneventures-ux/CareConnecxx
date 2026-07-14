import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

/**
 * One-time migration (U3, cara-web-chat plan): caregiver agent_sessions were
 * finalized with `caregiverId` but never `userId`, so the web-thread mirror
 * (threadMirror resolves sessions by userId) silently skipped caregivers —
 * their Evia history never reached threads/cara_{uid}.
 *
 * For each caregiver session missing userId, resolve the Firebase Auth user
 * that owns the session's phone number and stamp its uid. Sessions whose phone
 * has no auth user are reported and left untouched (mid-onboarding caregivers
 * finalize with userId going forward via onboardingConversation).
 *
 * Protect with header: x-admin-secret: <MIGRATION_ADMIN_SECRET env var>
 * Dry-run with ?dryRun=1 — reports what would change, writes nothing.
 *
 * Safe to re-run — sessions that already have userId are skipped and existing
 * userId values are never overwritten.
 */
export const backfillCaregiverSessionUserIds = functions.https.onRequest(async (req, res) => {
  const adminSecret = req.headers["x-admin-secret"];
  if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
  const results = {
    dryRun,
    backfilled: 0,
    alreadySet: 0,
    noAuthUser: [] as string[],
    errors:     [] as string[],
  };

  const snap = await db.collection("agent_sessions")
    .where("userType", "==", "caregiver")
    .get();

  for (const doc of snap.docs) {
    const session = doc.data();
    if (session.userId) {
      results.alreadySet++;
      continue;
    }

    // Session doc ID is the E.164 phone; the phone field mirrors it when set.
    const phone = (session.phone as string | undefined) ?? doc.id;

    try {
      const authUser = await admin.auth().getUserByPhoneNumber(phone);
      if (!dryRun) {
        await doc.ref.update({ userId: authUser.uid });
      }
      results.backfilled++;
    } catch (e: any) {
      if (e?.code === "auth/user-not-found") {
        results.noAuthUser.push(phone);
      } else {
        results.errors.push(`${doc.id}: ${e.message}`);
      }
    }
  }

  res.json(results);
});
