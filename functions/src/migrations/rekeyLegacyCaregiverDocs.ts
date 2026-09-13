import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

// Collections whose `caregiverId` field must equal the caregivers doc ID
// (= Auth uid). The in-flow re-key at finalization (onboardingConversation.ts)
// moves only the caregivers doc; these child refs were left pointing at the
// legacy random ID, so `where('caregiverId','==',uid)` web queries miss them.
const CAREGIVER_REF_COLLECTIONS = [
  "shifts",
  "job_applications",
  "video_interviews",
  "interview_requests",
  "shift_offers",
  "reviews",
] as const;

// caregivers.phone is written from the session doc ID (E.164), but normalize
// defensively — legacy web-era docs may carry "(408) 555-1234" shapes.
function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * One-off identity unification (tracked follow-up since 2026-06-10): re-keys
 * pre-cutover random-ID `caregivers` docs onto the Firebase Auth uid so the
 * target invariant holds everywhere:
 *
 *   caregivers doc ID == users doc ID == Auth uid == session.userId
 *     == session.caregiverId == caregiverId field on child records
 *
 * Random-ID docs are invisible to every web surface (all read
 * caregivers.doc(currentUser.uid)) and write-locked by firestore.rules
 * (update requires request.auth.uid == docId), so phone-OTP caregivers with a
 * legacy doc get an empty dashboard and can't edit their profile.
 *
 * Per legacy doc (doc ID ≠ Auth uid resolved from its phone):
 *  1. Resolve the Auth user by phone; CREATE one if none exists (mirrors
 *     createFirebaseAuthAccount in onboardingConversation.ts).
 *  2. Copy the doc to caregivers/{uid} — fill-missing when a uid-keyed doc
 *     already exists (the newer doc wins), full copy + `uid` field otherwise.
 *  3. Copy any payouts subcollection docs (skip IDs already present).
 *  4. Seed users/{uid} parity (fill-missing: uid, userType, name, phone,
 *     caregiverId back-ref).
 *  5. Re-point `caregiverId` from legacy ID → uid across
 *     CAREGIVER_REF_COLLECTIONS, and agent_sessions.caregiverId (+ userId).
 *  6. Delete the legacy doc.
 *
 * Docs already keyed by their Auth uid are skipped. Docs with no phone or an
 * unresolvable phone are reported and left untouched (support outreach list).
 *
 * Protect with header: x-admin-secret: <MIGRATION_ADMIN_SECRET env var>
 * Dry-run with ?dryRun=1 — reports the full plan, writes nothing (and never
 * creates Auth users).
 * Safe to re-run — aligned docs skip; ref re-pointing is idempotent.
 */
export const rekeyLegacyCaregiverDocs = functions
  .runWith({ timeoutSeconds: 540 })
  .https.onRequest(async (req, res) => {
    const adminSecret = req.headers["x-admin-secret"];
    if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
    const results = {
      dryRun,
      aligned:        0,
      rekeyed:        [] as Array<Record<string, unknown>>,
      noPhone:        [] as string[],
      badPhone:       [] as string[],
      wouldCreateAuth: [] as string[],
      errors:         [] as string[],
    };

    const cgSnap = await db.collection("caregivers").get();
    for (const doc of cgSnap.docs) {
      const legacyId = doc.id;
      const d = doc.data();
      try {
        const rawPhone = (d.phone as string | undefined) ?? "";
        if (!rawPhone) {
          // uid-field docs written by the new path always carry phone; a
          // phoneless doc keyed by its own uid is legacy-web and already fine.
          if (d.uid === legacyId) results.aligned++;
          else results.noPhone.push(legacyId);
          continue;
        }
        const phone = toE164(rawPhone);
        if (!phone) {
          results.badPhone.push(`${legacyId} (${rawPhone})`);
          continue;
        }

        // Resolve — or create — the Auth account for this phone.
        let uid: string | null = null;
        try {
          uid = (await admin.auth().getUserByPhoneNumber(phone)).uid;
        } catch (e: any) {
          if (e?.code !== "auth/user-not-found") throw e;
          if (dryRun) {
            results.wouldCreateAuth.push(`${legacyId} (${phone})`);
            continue;
          }
          uid = (await admin.auth().createUser({
            phoneNumber: phone,
            displayName: (d.name as string) || undefined,
          })).uid;
        }
        if (!uid) throw new Error("no auth uid resolvable");

        if (uid === legacyId) {
          results.aligned++;
          continue;
        }

        // ── plan/execute the re-key ──────────────────────────────────────────
        const plan: Record<string, unknown> = { legacyId, uid, phone };

        const targetRef  = db.collection("caregivers").doc(uid);
        const targetSnap = await targetRef.get();
        plan.targetExisted = targetSnap.exists;
        if (!dryRun) {
          if (targetSnap.exists) {
            // Newer uid-keyed doc wins; only fill fields it is missing.
            const target = targetSnap.data() ?? {};
            const fill: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(d)) {
              if (target[k] === undefined) fill[k] = v;
            }
            fill.uid = uid;
            await targetRef.set(fill, { merge: true });
          } else {
            await targetRef.set({ ...d, uid });
          }
        }

        // payouts subcollection (server-written; rare on legacy docs)
        const payoutsSnap = await doc.ref.collection("payouts").get();
        plan.payoutsCopied = payoutsSnap.size;
        if (!dryRun && payoutsSnap.size > 0) {
          for (const p of payoutsSnap.docs) {
            const destRef  = targetRef.collection("payouts").doc(p.id);
            const destSnap = await destRef.get();
            if (!destSnap.exists) await destRef.set(p.data());
          }
        }

        // users/{uid} parity (fill-missing only — never flip userType)
        if (!dryRun) {
          const userRef  = db.collection("users").doc(uid);
          const userSnap = await userRef.get();
          const u = userSnap.data() ?? {};
          await userRef.set({
            uid,
            ...(u.userType ? {} : { userType: "caregiver" }),
            ...(u.name || !d.name ? {} : { name: d.name }),
            ...(u.phone ? {} : { phone }),
            ...(u.caregiverId ? {} : { caregiverId: uid }),
            ...(userSnap.exists ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }

        // Re-point caregiverId refs across child collections
        const repointed: Record<string, number> = {};
        for (const coll of CAREGIVER_REF_COLLECTIONS) {
          const refSnap = await db.collection(coll)
            .where("caregiverId", "==", legacyId)
            .get();
          if (refSnap.empty) continue;
          repointed[coll] = refSnap.size;
          if (!dryRun) {
            for (const r of refSnap.docs) {
              await r.ref.update({ caregiverId: uid });
            }
          }
        }
        plan.repointed = repointed;

        // agent_sessions carrying the legacy caregiverId
        const sessSnap = await db.collection("agent_sessions")
          .where("caregiverId", "==", legacyId)
          .get();
        plan.sessionsUpdated = sessSnap.size;
        if (!dryRun) {
          for (const s of sessSnap.docs) {
            await s.ref.update({ caregiverId: uid, userId: uid });
          }
        }

        // Retire the legacy doc last — everything above is idempotent, so a
        // crash before this point re-runs cleanly.
        if (!dryRun) await doc.ref.delete();

        results.rekeyed.push(plan);
      } catch (e: any) {
        results.errors.push(`caregivers/${legacyId}: ${e.message}`);
      }
    }

    res.json(results);
  });
