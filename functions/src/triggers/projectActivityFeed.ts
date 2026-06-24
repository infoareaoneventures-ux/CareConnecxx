import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import {
  describeForFeed,
  ownerResolutionPlan,
} from "../agents/activityFeedMap";
import type { AuditEventType } from "../observability/auditLog";

const db = admin.firestore();

/**
 * Resolve the OWNING FAMILY's Firebase Auth uid for an audit event. Returns null
 * when no family owner can be resolved (the event is then skipped, never written
 * under an unresolved key). Phone-first; falls back to validating a uid candidate.
 * Because only family-side events reach here (allow-list in activityFeedMap), a
 * resolved uid is always the family's — never a caregiver's.
 */
async function resolveOwnerUid(plan: { phone?: string; uidCandidate?: string }): Promise<string | null> {
  if (plan.phone) {
    const e164 = plan.phone.startsWith("+") ? plan.phone : `+${plan.phone}`;
    try {
      const user = await admin.auth().getUserByPhoneNumber(e164);
      return user.uid;
    } catch { /* not a known phone — fall through */ }
  }
  if (plan.uidCandidate) {
    try {
      await admin.auth().getUser(plan.uidCandidate);
      return plan.uidCandidate;
    } catch { /* not a real uid — fall through */ }
  }
  return null;
}

/**
 * Track C / U8 — project allow-listed audit events into the family-facing
 * `user_activity_feed`. SECURITY INVARIANTS (see activityFeedMap.ts):
 *   - opt-in allow-list (sensitive/caregiver/internal events are skipped)
 *   - static, PII-free descriptions (never derived from `data`)
 *   - owner resolved to a family uid, or the event is skipped
 *   - idempotent: feed doc id == source audit doc id, written with set()
 * The raw `agent_audit_log` stays admin-only; only this projection is family-readable.
 */
export const projectActivityFeed = functions.firestore
  .document("agent_audit_log/{auditId}")
  .onCreate(async (snap, context) => {
    const event = snap.data() as {
      eventType: AuditEventType;
      userId?: string;
      phone?: string;
      timestamp?: string;
    };

    const description = describeForFeed(event.eventType);
    if (!description) return; // excluded / unmapped — nothing family-facing to show

    const ownerUid = await resolveOwnerUid(ownerResolutionPlan(event));
    if (!ownerUid) {
      // No resolvable family owner — skip rather than write an unreadable/mis-keyed doc.
      console.warn(`projectActivityFeed: no owner uid for ${event.eventType} (${context.params.auditId}) — skipped`);
      return;
    }

    // Idempotent: keyed by the source audit doc id so at-least-once retries overwrite.
    await db.collection("user_activity_feed").doc(context.params.auditId).set(
      {
        ownerUid,
        eventType: event.eventType,
        description,
        timestamp: event.timestamp ?? new Date().toISOString(),
      },
      { merge: true }
    );
  });
