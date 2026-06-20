import * as admin from "firebase-admin";

const db = admin.firestore();

// 6-year retention to match the audit log (HIPAA minimum). Firestore's TTL
// policy auto-deletes docs whose `ttl` Timestamp has passed.
const SIX_YEARS_MS = 6 * 365 * 24 * 60 * 60 * 1000;

export type AgentActionStatus =
  | "proposed"
  | "confirmed"
  | "executed"
  | "failed"
  | "cancelled";

export interface AgentActionLedgerEntry {
  actionType: string;
  status: AgentActionStatus;
  userId?: string;
  phone?: string;
  role?: "client" | "caregiver" | "admin" | "family" | string;
  sourceMessageId?: string;
  toolName?: string;
  targetCollection?: string;
  targetDocId?: string;
  errorReason?: string;
  metadata?: Record<string, unknown>;
}

function retentionTtl(): FirebaseFirestore.Timestamp {
  const expiresAtMs = Date.now() + SIX_YEARS_MS;
  const timestampFactory = admin.firestore.Timestamp as typeof admin.firestore.Timestamp | undefined;
  if (!timestampFactory || typeof timestampFactory.fromMillis !== "function") {
    // Firestore's TTL policy only honors Firestore Timestamp fields — a plain
    // Date is silently ignored, which would disable auto-deletion and retain
    // these (PHI-adjacent) ledger docs indefinitely. Fail loud instead of
    // writing a TTL-less doc that looks healthy; the throw is caught by
    // logAgentAction's swallow-and-log so the best-effort flow is unaffected.
    throw new Error("retentionTtl: admin.firestore.Timestamp.fromMillis unavailable — cannot set ledger TTL");
  }
  return timestampFactory.fromMillis(expiresAtMs);
}

export async function logAgentAction(
  entry: AgentActionLedgerEntry,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await db.collection("agent_action_ledger").add({
      ...entry,
      createdAt: now,
      updatedAt: now,
      ttl: retentionTtl(),
    });
  } catch (err) {
    console.error("agent_action_ledger write error:", err);
  }
}
