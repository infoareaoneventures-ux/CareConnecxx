import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

// ── listAdminAlerts — returns unresolved alerts, newest first ─────────────────

export const listAdminAlerts = functions.https.onCall(async (_data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be logged in");
  }

  const snap = await db.collection("admin_alerts")
    .where("resolved", "==", false)
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();

  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
});

// ── resolveAdminAlert — mark a single alert resolved ─────────────────────────

export const resolveAdminAlert = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be logged in");
  }

  const alertId: string = data.alertId;
  const note:    string = data.note ?? "";

  if (!alertId) {
    throw new functions.https.HttpsError("invalid-argument", "alertId is required");
  }

  const ref  = db.collection("admin_alerts").doc(alertId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError("not-found", "Alert not found");
  }

  await ref.update({
    resolved:     true,
    resolvedAt:   new Date().toISOString(),
    resolvedBy:   context.auth.uid,
    resolvedNote: note,
  });

  return { success: true };
});

// ── getAlertStats — counts by type for the dashboard ─────────────────────────

export const getAlertStats = functions.https.onCall(async (_data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be logged in");
  }

  const [unresolvedSnap, last7dSnap] = await Promise.all([
    db.collection("admin_alerts").where("resolved", "==", false).get(),
    db.collection("admin_alerts")
      .where("createdAt", ">=", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .get(),
  ]);

  // Count by type for unresolved
  const byType: Record<string, number> = {};
  for (const d of unresolvedSnap.docs) {
    const t = (d.data().type as string) ?? "unknown";
    byType[t] = (byType[t] ?? 0) + 1;
  }

  // Count resolved vs open in the last 7 days
  let resolved7d = 0;
  let open7d     = 0;
  for (const d of last7dSnap.docs) {
    d.data().resolved ? resolved7d++ : open7d++;
  }

  return {
    totalUnresolved: unresolvedSnap.size,
    byType,
    last7Days: { open: open7d, resolved: resolved7d },
  };
});
