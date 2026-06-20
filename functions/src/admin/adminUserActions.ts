import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { requireAdmin } from "./requireAdmin";
import { logAudit } from "../observability/auditLog";

const db = admin.firestore();

function nowIso() {
  return new Date().toISOString();
}

/**
 * admin_suspend_user — soft-suspend a user account.
 *
 * Suspension is a reversible status flag (`accountStatus: "suspended"`), never a
 * destructive delete (Constraints: soft-delete/terminal-status only for users).
 * Audit-logged with the operator and reason.
 */
export const admin_suspend_user = functions.https.onCall(
  async (data, context) => {
    const adminUid = await requireAdmin(context);

    const userId: string = data?.userId;
    const reason: string = typeof data?.reason === "string" ? data.reason.trim().slice(0, 2000) : "";

    if (!userId) {
      throw new functions.https.HttpsError("invalid-argument", "userId is required");
    }
    if (!reason) {
      throw new functions.https.HttpsError("invalid-argument", "A suspension reason is required");
    }
    if (userId === adminUid) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "An admin cannot suspend their own account",
      );
    }

    const ref = db.collection("users").doc(userId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new functions.https.HttpsError("not-found", "User not found");
    }

    const now = nowIso();
    await ref.update({
      accountStatus: "suspended",
      suspendedAt: now,
      suspendedBy: adminUid,
      suspensionReason: reason,
      updatedAt: now,
    });

    await logAudit({
      eventType: "user_suspended",
      userId,
      data: {
        source: "callable:admin_suspend_user",
        adminUid,
        reason,
      },
    });

    return { success: true, userId, accountStatus: "suspended" };
  },
);

/**
 * admin_restore_user — clear a soft suspension.
 */
export const admin_restore_user = functions.https.onCall(
  async (data, context) => {
    const adminUid = await requireAdmin(context);

    const userId: string = data?.userId;
    const note: string = typeof data?.note === "string" ? data.note.slice(0, 2000) : "";

    if (!userId) {
      throw new functions.https.HttpsError("invalid-argument", "userId is required");
    }

    const ref = db.collection("users").doc(userId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new functions.https.HttpsError("not-found", "User not found");
    }

    const now = nowIso();
    await ref.update({
      accountStatus: "active",
      restoredAt: now,
      restoredBy: adminUid,
      restoreNote: note || null,
      // Clear suspension artifacts so the doc doesn't carry contradictory state.
      suspensionReason: admin.firestore.FieldValue.delete(),
      suspendedBy: admin.firestore.FieldValue.delete(),
      updatedAt: now,
    });

    await logAudit({
      eventType: "user_restored",
      userId,
      data: {
        source: "callable:admin_restore_user",
        adminUid,
        note: note || null,
      },
    });

    return { success: true, userId, accountStatus: "active" };
  },
);
