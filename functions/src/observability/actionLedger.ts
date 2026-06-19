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

function retentionTtl(): FirebaseFirestore.Timestamp | Date {
  const expiresAtMs = Date.now() + SIX_YEARS_MS;
  const timestampFactory = admin.firestore.Timestamp as typeof admin.firestore.Timestamp | undefined;
  if (timestampFactory && typeof timestampFactory.fromMillis === "function") {
    return timestampFactory.fromMillis(expiresAtMs);
  }
  return new Date(expiresAtMs);
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
