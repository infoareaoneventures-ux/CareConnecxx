import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { describeForFeed, ownerResolutionPlan } from "../agents/activityFeedMap";
import { resolveFamilyOwnerUid, FEED_TTL_MS } from "./activityOwner";
import type { AuditEventType } from "../observability/auditLog";

const db = admin.firestore();

/**
 * Track C / U8 — project allow-listed audit events into the family-facing
 * `user_activity_feed`. SECURITY INVARIANTS (see activityFeedMap.ts + activityOwner.ts):
 *   - opt-in allow-list (sensitive/caregiver/internal events are skipped)
 *   - static, PII-free descriptions (never derived from `data`)
 *   - owner resolved to a family uid AND confirmed non-caregiver, or skipped
 *   - suppressed (never-delivered) events are not projected as actions taken
 *   - idempotent: feed doc id == source audit doc id, written with set()
 *   - entries carry a `ttl` for a 1-year retention policy
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

    const ownerUid = await resolveFamilyOwnerUid(db, admin.auth(), ownerResolutionPlan(event));
    if (!ownerUid) {
      // No resolvable family owner (or resolved to a caregiver) — skip rather than
      // write an unreadable/mis-keyed doc.
      console.warn(`projectActivityFeed: no family owner for ${event.eventType} (${context.params.auditId}) — skipped`);
      return;
    }

    // Idempotent: keyed by the source audit doc id so at-least-once retries overwrite.
    const now = Date.now();
    await db.collection("user_activity_feed").doc(context.params.auditId).set(
      {
        ownerUid,
        eventType: event.eventType,
        description,
        timestamp: event.timestamp ?? new Date(now).toISOString(),
        ttl: admin.firestore.Timestamp.fromMillis(now + FEED_TTL_MS),
      },
      { merge: true }
    );
  });
