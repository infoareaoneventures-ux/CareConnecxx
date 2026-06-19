import * as admin from "firebase-admin";

const db = admin.firestore();

export type CaraOpsSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface CaraOpsAlertInput {
  type: string;
  severity?: CaraOpsSeverity;
  phone?: string;
  userId?: string;
  role?: string;
  source?: string;
  message?: string;
  reason?: string;
  actionId?: string;
  toolName?: string;
  targetCollection?: string;
  targetDocId?: string;
  error?: string;
  context?: Record<string, unknown>;
}

// Best-effort alerting sink: never throws (a failed alert must not break the
// caller's main flow). Returns true when the alert was persisted, false when
// the write failed — callers that tell a user "I've flagged this for review"
// can branch on this so they don't claim a flag that didn't persist.
export async function createCaraOpsAlert(input: CaraOpsAlertInput): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    await db.collection("admin_alerts").add({
      type: input.type,
      severity: input.severity ?? "medium",
      source: input.source ?? "cara",
      resolved: false,
      createdAt: now,
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(input.message ? { message: input.message.slice(0, 500) } : {}),
      ...(input.reason ? { reason: input.reason.slice(0, 500) } : {}),
      ...(input.actionId ? { actionId: input.actionId } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.targetCollection ? { targetCollection: input.targetCollection } : {}),
      ...(input.targetDocId ? { targetDocId: input.targetDocId } : {}),
      ...(input.error ? { error: input.error.slice(0, 500) } : {}),
      ...(input.context ? { context: input.context } : {}),
    });
    return true;
  } catch (err) {
    console.error("caraOpsAlert write error:", err);
    return false;
  }
}
