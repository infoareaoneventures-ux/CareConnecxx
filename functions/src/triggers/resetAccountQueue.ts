// Admin "Reset Test Account" queue trigger — wipes all data for a uid/phone
// so an end-to-end test can run from a clean slate. Fires on adminResetQueue
// onCreate (same IAM-bypass pattern as adminAdvanceQueue).

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

const db  = admin.firestore();
const auth = admin.auth();

async function deleteSubcollection(ref: admin.firestore.DocumentReference, subcol: string): Promise<void> {
  const snap = await ref.collection(subcol).limit(500).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

export const processResetAccountQueue = functions.firestore
  .document("adminResetQueue/{docId}")
  .onCreate(async (snap) => {
    const { uid, phone, role } = snap.data() as { uid: string; phone: string; role?: string };

    if (!uid || !phone) {
      await snap.ref.update({ error: "uid and phone are required", processedAt: new Date().toISOString() });
      return;
    }

    const errors: string[] = [];

    // ── Firebase Auth ──────────────────────────────────────────────────────────
    await auth.deleteUser(uid).catch((err) => {
      if (err.code !== "auth/user-not-found") errors.push(`auth: ${err.message}`);
    });

    // ── Firestore docs ─────────────────────────────────────────────────────────
    const delDoc = (path: string) =>
      db.doc(path).delete().catch((err) => errors.push(`${path}: ${err.message}`));

    await Promise.all([
      delDoc(`users/${uid}`),
      delDoc(`clientIntakes/${uid}`),
      delDoc(`carePlans/${uid}`),
      delDoc(`senior_profiles/${uid}`),
      delDoc(`job_postings/${uid}`),
      delDoc(`web_onboarding_sessions/${phone}`),
      delDoc(`agent_memory_files/${uid}`),
      // caregivers doc (for caregiver resets)
      ...(role === "caregiver" ? [delDoc(`caregivers/${uid}`)] : []),
    ]);

    // agent_sessions/{phone} — has messages subcollection
    const sessRef = db.collection("agent_sessions").doc(phone);
    await deleteSubcollection(sessRef, "messages").catch((err) => errors.push(`agent_sessions/messages: ${err.message}`));
    await sessRef.delete().catch((err) => errors.push(`agent_sessions: ${err.message}`));

    // agent_conversations/{phone}/messages subcollection
    const convRef = db.collection("agent_conversations").doc(phone);
    await deleteSubcollection(convRef, "messages").catch((err) => errors.push(`agent_conversations/messages: ${err.message}`));
    await convRef.delete().catch((err) => errors.push(`agent_conversations: ${err.message}`));

    // ── Zep memory ────────────────────────────────────────────────────────────
    try {
      const { getZepUserId: resolveId } = await import("../memory/zepClient");
      const zepUserId = resolveId(phone);
      const { ZepClient } = await import("@getzep/zep-cloud");
      const apiKey = process.env.ZEP_API_KEY ?? "";
      if (apiKey) {
        const zep = new ZepClient({ apiKey });
        await (zep.user as any).delete(zepUserId).catch((err: Error) => {
          // Not-found is fine — user was never initialized
          if (!String(err).includes("404") && !String(err).includes("not found")) {
            errors.push(`zep: ${err.message}`);
          }
        });
      }
    } catch (err) {
      errors.push(`zep import: ${String(err)}`);
    }

    // ── Firebase Storage ───────────────────────────────────────────────────────
    try {
      const bucket = admin.storage().bucket();
      const [files] = await bucket.getFiles({ prefix: `${uid}/` });
      await Promise.all(files.map(f => f.delete().catch(() => null)));
      // Also try phone-keyed paths
      const [phoneFiles] = await bucket.getFiles({ prefix: `uploads/${phone}/` });
      await Promise.all(phoneFiles.map(f => f.delete().catch(() => null)));
    } catch (err) {
      errors.push(`storage: ${String(err)}`);
    }

    await snap.ref.update({
      processedAt: new Date().toISOString(),
      ...(errors.length ? { errors } : { success: true }),
    });

    console.log(`[resetAccountQueue] uid=${uid} phone=${phone} done`, errors.length ? { errors } : "clean");
  });
