import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

// ── opsAnomalyWatch — hourly failure-spike detector ────────────────────────────
//
// Per-turn failures each write an admin_alerts doc, but nothing watched the
// RATE: a degradation was invisible until the weekly scorecard or a manual
// canary run. This job counts the last hour's alerts by type against fixed
// thresholds and, on breach, writes ONE critical `ops_anomaly` alert (which
// adminAlertNotifier emails at create-time) and SMS's the founder directly —
// same paging mechanism providerFailureAlert uses.

const HOUR_MS = 60 * 60 * 1000;
export const ANTI_SPAM_WINDOW_MS = 6 * HOUR_MS;

// Combined-count thresholds; a group breaches when the sum of its member
// types in the last hour reaches the limit.
export const ANOMALY_GROUPS: ReadonlyArray<{ name: string; types: string[]; threshold: number }> = [
  { name: "agent_turn_failures",  types: ["qa_agent_failure", "qa_loop_exhausted", "handle_inbound_failure"], threshold: 5 },
  { name: "broken_promises",      types: ["commitment_unfulfilled"], threshold: 3 },
  { name: "delivery_failures",    types: ["linq_send_failure", "linq_outbound_queue_failed"], threshold: 3 },
  { name: "matching_failures",    types: ["matching_run_failed"], threshold: 3 },
];
export const ANY_SINGLE_TYPE_THRESHOLD = 10;

export interface OpsAnomalyResult {
  scanned: number;
  breaches: Array<{ name: string; count: number; threshold: number }>;
  alerted: boolean;
  skippedAntiSpam: boolean;
}

export async function runOpsAnomalyWatch(now: Date = new Date()): Promise<OpsAnomalyResult> {
  const db = admin.firestore();
  const oneHourAgo = new Date(now.getTime() - HOUR_MS).toISOString();

  const snap = await db.collection("admin_alerts")
    .where("createdAt", ">=", oneHourAgo)
    .get();

  const byType: Record<string, number> = {};
  let recentAnomalyAlert = false;
  for (const doc of snap.docs) {
    const a = doc.data() ?? {};
    const type = typeof a.type === "string" ? a.type : "unknown";
    if (type === "ops_anomaly") { recentAnomalyAlert = true; continue; } // never self-count
    byType[type] = (byType[type] ?? 0) + 1;
  }

  const breaches: OpsAnomalyResult["breaches"] = [];
  for (const g of ANOMALY_GROUPS) {
    const count = g.types.reduce((s, t) => s + (byType[t] ?? 0), 0);
    if (count >= g.threshold) breaches.push({ name: g.name, count, threshold: g.threshold });
  }
  for (const [type, count] of Object.entries(byType)) {
    if (count >= ANY_SINGLE_TYPE_THRESHOLD && !breaches.some((b) => b.name === type)) {
      breaches.push({ name: type, count, threshold: ANY_SINGLE_TYPE_THRESHOLD });
    }
  }

  if (breaches.length === 0) {
    return { scanned: snap.size, breaches: [], alerted: false, skippedAntiSpam: false };
  }

  // Anti-spam: one anomaly page per window. The 1h query above only sees an
  // ops_anomaly doc from the current hour, so ALSO check the wider window.
  if (!recentAnomalyAlert) {
    const sixHoursAgo = new Date(now.getTime() - ANTI_SPAM_WINDOW_MS).toISOString();
    const priorSnap = await db.collection("admin_alerts")
      .where("type", "==", "ops_anomaly")
      .where("createdAt", ">=", sixHoursAgo)
      .limit(1)
      .get()
      .catch(() => null);
    recentAnomalyAlert = !!priorSnap && !priorSnap.empty;
  }
  if (recentAnomalyAlert) {
    console.warn("[opsAnomalyWatch] breach detected but anomaly alert already raised in window", { breaches });
    return { scanned: snap.size, breaches, alerted: false, skippedAntiSpam: true };
  }

  const summary = breaches.map((b) => `${b.name}: ${b.count}/${b.threshold}`).join(", ");
  await db.collection("admin_alerts").add({
    type:      "ops_anomaly",
    severity:  "critical",
    priority:  "critical", // adminAlertNotifier's high-priority check reads `priority`
    breaches,
    countsByType: byType,
    windowStart: oneHourAgo,
    createdAt: now.toISOString(),
    resolved:  false,
  });

  const adminPhone = process.env.ADMIN_PHONE;
  if (adminPhone) {
    const { sendToPhone } = await import("../linq/client");
    await sendToPhone(
      adminPhone,
      `Evia ops anomaly (last hour): ${summary}. Check the admin alerts panel.`,
    ).catch(() => {});
  }

  console.warn("[opsAnomalyWatch] ANOMALY PAGED:", summary);
  return { scanned: snap.size, breaches, alerted: true, skippedAntiSpam: false };
}

export const opsAnomalyWatchHourly = functions.pubsub
  .schedule("every 60 minutes")
  .onRun(async () => {
    await runOpsAnomalyWatch().catch((err) =>
      console.error("[opsAnomalyWatch] run failed:", err)
    );
  });
