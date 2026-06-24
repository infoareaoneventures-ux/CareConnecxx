import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import {
  describeForFeed,
  ownerResolutionPlan,
} from "../agents/activityFeedMap";
import type { AuditEventType } from "../observability/auditLog";

const db = admin.firestore();

/** A transient (retryable) Auth error vs. the expected "not found" skip case. */
function isNotFound(e: any): boolean {
  return e?.code === "auth/user-not-found" || e?.code === "auth/invalid-phone-number";
}

/**
 * Resolve the OWNING FAMILY's Firebase Auth uid for an audit event, then confirm
 * it actually belongs to a family/client (userType === 'client'). Returns null
 * when no family owner can be resolved or the resolved user is not a client —
 * the event is then skipped, never written under a caregiver/unknown key. This
 * ENFORCES the family-only invariant at the projection boundary rather than
 * assuming the allow-list events are always family-keyed (some, like phone-keyed
 * message_sent to a caregiver, are not).
 *
 * Throws on transient Auth/Firestore errors (network, 5xx) so the trigger retries
 * rather than silently dropping the event forever.
 */
async function resolveFamilyOwnerUid(plan: { phone?: string; uidCandidate?: string }): Promise<string | null> {
  let uid: string | null = null;

  if (plan.phone) {
    const e164 = plan.phone.startsWith("+") ? plan.phone : `+${plan.phone}`;
    try {
      uid = (await admin.auth().getUserByPhoneNumber(e164)).uid;
    } catch (e) {
      if (!isNotFound(e)) throw e; // transient — let the trigger retry
      // not a known phone — fall through to the uid candidate
    }
  }
  if (!uid && plan.uidCandidate) {
    try {
      await admin.auth().getUser(plan.uidCandidate);
      uid = plan.uidCandidate;
    } catch (e) {
      if (!isNotFound(e)) throw e; // transient — let the trigger retry
    }
  }
  if (!uid) return null;

  // Family-only gate: the feed is for families. Skip if the resolved user is a
  // caregiver (e.g. a message Cara sent TO a caregiver, keyed by their phone).
  const userSnap = await db.collection("users").doc(uid).get();
  if (userSnap.exists && (userSnap.data() as any)?.userType === "caregiver") return null;
  return uid;
}

/**
 * Track C / U8 — project allow-listed audit events into the family-facing
 * `user_activity_feed`. SECURITY INVARIANTS (see activityFeedMap.ts):
 *   - opt-in allow-list (sensitive/caregiver/internal events are skipped)
 *   - static, PII-free descriptions (never derived from `data`)
 *   - owner resolved to a family uid AND confirmed non-caregiver, or skipped
 *   - suppressed (never-delivered) events are not projected as actions taken
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
      data?: { suppressed?: boolean };
    };

    const description = describeForFeed(event.eventType);
    if (!description) return; // excluded / unmapped — nothing family-facing to show

    // Don't report actions that were logged but never actually performed
    // (rate-capped / duplicate / wait — caraAgent logs these with suppressed:true).
    if (event.data?.suppressed === true) return;

    const ownerUid = await resolveFamilyOwnerUid(ownerResolutionPlan(event));
    if (!ownerUid) {
      // No resolvable family owner (or resolved to a caregiver) — skip rather than
      // write an unreadable/mis-keyed doc.
      console.warn(`projectActivityFeed: no family owner for ${event.eventType} (${context.params.auditId}) — skipped`);
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
