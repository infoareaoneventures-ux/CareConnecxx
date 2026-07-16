import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

// ── adminAlertAging — daily sweep of unresolved admin_alerts ───────────────────
//
// admin_alerts are only notified at create-time (triggers/adminAlertNotifier.ts,
// and only for whitelisted types/priorities). Anything left with resolved:false
// after that rots silently. This job re-surfaces aging unresolved alerts to the
// founder as ONE digest email per run (via the same admin_email_queue mechanism
// adminAlertNotifier uses), stamping each reminded doc so it isn't re-nagged
// every day.

const HOUR_MS = 60 * 60 * 1000;

// severity/priority values that get the fast (24h) aging threshold
const HIGH_URGENCY = new Set(["high", "critical", "urgent"]);

export const HIGH_URGENCY_AGE_MS = 24 * HOUR_MS;
export const DEFAULT_AGE_MS      = 72 * HOUR_MS;
export const REMINDER_COOLDOWN_MS = 24 * HOUR_MS;
export const MAX_REMINDERS_PER_RUN = 20;

export interface AdminAlertAgingResult {
  scanned: number;
  /** Number of alerts included in this run's digest (0 when nothing aged). */
  reminded: number;
  digestQueued: boolean;
  /** Counts by alert type for the reminded batch. */
  byType: Record<string, number>;
  /** Age in whole hours of the oldest reminded alert, or null when none. */
  oldestAgeHours: number | null;
}

// Core sweep logic, exported separately from the pubsub wrapper so tests can
// call it directly with a pinned `now`.
export async function runAdminAlertAging(now: Date = new Date()): Promise<AdminAlertAgingResult> {
  const db    = admin.firestore();
  const nowMs = now.getTime();

  const snap = await db.collection("admin_alerts")
    .where("resolved", "==", false)
    .get();

  interface AgedAlert {
    id: string;
    ref: FirebaseFirestore.DocumentReference;
    type: string;
    createdMs: number;
  }

  const aged: AgedAlert[] = [];
  for (const doc of snap.docs) {
    const alert = doc.data() ?? {};

    // createdAt is an ISO string by repo convention; skip docs without one —
    // we can't age what we can't date.
    const createdAt = typeof alert.createdAt === "string" ? alert.createdAt : "";
    const createdMs = createdAt ? Date.parse(createdAt) : NaN;
    if (!Number.isFinite(createdMs)) continue;

    // Alerts carry `severity` (caraOpsAlerts writers) and/or `priority`
    // (older writers) — honor whichever is present, severity first.
    const urgency = String(alert.severity ?? alert.priority ?? "").toLowerCase();
    const ageThresholdMs = HIGH_URGENCY.has(urgency) ? HIGH_URGENCY_AGE_MS : DEFAULT_AGE_MS;
    if (nowMs - createdMs < ageThresholdMs) continue;

    // Reminder dedup: skip docs already reminded within the cooldown window.
    const lastReminded = typeof alert.lastAgingReminderAt === "string"
      ? Date.parse(alert.lastAgingReminderAt)
      : NaN;
    if (Number.isFinite(lastReminded) && nowMs - lastReminded < REMINDER_COOLDOWN_MS) continue;

    aged.push({
      id:        doc.id,
      ref:       doc.ref,
      type:      typeof alert.type === "string" && alert.type ? alert.type : "unknown",
      createdMs,
    });
  }

  // Oldest first, capped per run so one bad week can't produce a 500-row email.
  aged.sort((a, b) => a.createdMs - b.createdMs);
  const batch = aged.slice(0, MAX_REMINDERS_PER_RUN);

  const byType: Record<string, number> = {};
  for (const a of batch) byType[a.type] = (byType[a.type] ?? 0) + 1;
  const oldestAgeHours = batch.length > 0
    ? Math.floor((nowMs - batch[0].createdMs) / HOUR_MS)
    : null;

  let digestQueued = false;
  if (batch.length > 0) {
    const adminEmail = process.env.ADMIN_EMAIL ?? "support@eviacares.com";
    const nowIso     = now.toISOString();

    const typeLines = Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `- ${type}: ${count}`)
      .join("\n");

    // ONE digest per run — not one email per alert.
    try {
      await db.collection("admin_email_queue").add({
        to:      adminEmail,
        subject: `[Evia Alert Digest] ${batch.length} unresolved alert${batch.length === 1 ? "" : "s"} aging`,
        body:
          `${batch.length} unresolved admin alert${batch.length === 1 ? " is" : "s are"} past the aging threshold.\n\n` +
          `Counts by type:\n${typeLines}\n\n` +
          `Oldest: ${oldestAgeHours}h old\n\n` +
          `Resolve them in the admin dashboard (Alerts panel).`,
        createdAt: nowIso,
        sent:      false,
      });
      digestQueued = true;
    } catch (err) {
      console.error("[adminAlertAging] Failed to queue digest email:", err);
    }

    // Only stamp docs when the digest actually queued — if the email write
    // failed, the next daily run should pick these alerts up again.
    if (digestQueued) {
      await Promise.all(
        batch.map(a => a.ref.update({ lastAgingReminderAt: nowIso }).catch(() => {})),
      );
    }
  }

  const reminded = digestQueued ? batch.length : 0;
  console.log(
    `[adminAlertAging] scanned=${snap.docs.length} aged=${aged.length} reminded=${reminded} digestQueued=${digestQueued}`,
  );
  return { scanned: snap.docs.length, reminded, digestQueued, byType, oldestAgeHours };
}

// Runs daily at 9 AM PT (16:00 UTC)
export const adminAlertAgingDaily = functions.pubsub
  .schedule("0 16 * * *")
  .onRun(async () => {
    await runAdminAlertAging();
  });
