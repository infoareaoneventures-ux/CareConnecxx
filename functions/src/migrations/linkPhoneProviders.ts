import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

// Same normalization rule as the Linq pipeline (routeIntent.normalizeE164):
// 10 digits → +1XXXXXXXXXX; 11 starting with 1 → +XXXXXXXXXXX; already-+ kept.
function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.trim().startsWith("+") && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

/**
 * Pre-cutover migration (U6, cara-web-chat plan): phone-OTP login signs into
 * the auth user that OWNS the phone number — or mints a brand-new uid if none
 * does. All data is uid-keyed, so every email-era account must have its phone
 * linked as an auth provider BEFORE email login is removed, or those users
 * phone-login into fresh empty accounts.
 *
 * For each users/{uid} doc: normalize the stored phone to E.164, then link it
 * to the auth user via admin.auth().updateUser. Collisions (another auth user
 * already owns the phone) are reported and never auto-merged. Accounts with no
 * phone on file are enumerated for the support outreach list.
 *
 * Protect with header: x-admin-secret: <MIGRATION_ADMIN_SECRET env var>
 * Dry-run with ?dryRun=1 — reports what would change, writes nothing.
 *
 * Safe to re-run — already-linked accounts are skipped.
 */
export const linkPhoneProviders = functions
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
    linked:          0,
    alreadyLinked:   0,
    docsNormalized:  0,
    noPhone:         [] as Array<{ uid: string; userType?: string }>,
    invalidPhone:    [] as Array<{ uid: string; phone: string }>,
    collisions:      [] as Array<{ uid: string; phone: string; ownedBy: string }>,
    providerMismatch: [] as Array<{ uid: string; docPhone: string; authPhone: string }>,
    noAuthAccount:   [] as string[],
    errors:          [] as string[],
  };

  const snap = await db.collection("users").get();

  for (const doc of snap.docs) {
    const uid  = doc.id;
    const data = doc.data();
    const rawPhone = data.phone as string | undefined;

    if (!rawPhone) {
      results.noPhone.push({ uid, userType: data.userType as string | undefined });
      continue;
    }

    const phone = normalizeE164(rawPhone);
    if (!phone) {
      results.invalidPhone.push({ uid, phone: rawPhone });
      continue;
    }

    try {
      // Normalize the stored value so phone → agent_sessions lookups match
      // (agent_sessions doc IDs are E.164).
      if (phone !== rawPhone) {
        if (!dryRun) await doc.ref.update({ phone });
        results.docsNormalized++;
      }

      let authUser: admin.auth.UserRecord;
      try {
        authUser = await admin.auth().getUser(uid);
      } catch (e: any) {
        if (e?.code === "auth/user-not-found") {
          results.noAuthAccount.push(uid);
          continue;
        }
        throw e;
      }

      if (authUser.phoneNumber === phone) {
        results.alreadyLinked++;
        continue;
      }
      if (authUser.phoneNumber && authUser.phoneNumber !== phone) {
        // Auth already carries a different phone — flag, never clobber.
        results.providerMismatch.push({ uid, docPhone: phone, authPhone: authUser.phoneNumber });
        continue;
      }

      if (!dryRun) {
        try {
          await admin.auth().updateUser(uid, { phoneNumber: phone });
        } catch (e: any) {
          if (e?.code === "auth/phone-number-already-exists") {
            let ownedBy = "unknown";
            try {
              ownedBy = (await admin.auth().getUserByPhoneNumber(phone)).uid;
            } catch { /* report with unknown owner */ }
            results.collisions.push({ uid, phone, ownedBy });
            continue;
          }
          throw e;
        }
      } else {
        // Dry-run collision detection: does some OTHER auth user own the phone?
        try {
          const owner = await admin.auth().getUserByPhoneNumber(phone);
          if (owner.uid !== uid) {
            results.collisions.push({ uid, phone, ownedBy: owner.uid });
            continue;
          }
        } catch (e: any) {
          if (e?.code !== "auth/user-not-found") throw e;
        }
      }
      results.linked++;
    } catch (e: any) {
      results.errors.push(`${uid}: ${e.message}`);
    }
  }

  res.json(results);
});
