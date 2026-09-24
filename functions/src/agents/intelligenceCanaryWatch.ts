// Intelligence canary watch (plan 2026-07-18-001 U12, hold signals).
//
// Hourly sweep over the live evidence artifacts the U1-U8 stack now produces,
// converting them into deduped admin alerts when a hold signal fires:
//   - postcondition MISMATCH receipts (U5): a handler claimed success but the
//     fresh read disagreed — the single loudest "false completion" signal.
//   - unverifiable-receipt rate (U5): verification infrastructure degrading.
//   - suppressed no-evidence health drafts (U8): the LLM proposing health
//     outreach without deterministic evidence (working as designed, but a
//     spike means the reflection prompt is drifting).
//
// Reads are single-field time-ordered scans with in-memory filtering — no
// compound queries, so no new index contracts (plan index workflow). Alerts
// are content-free (counts + action names only) and deduped one-per-signal
// per UTC day via deterministic doc ids.

import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

const SCAN_LIMIT = 200;
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface CanarySignal {
  signal: string;
  severity: "high" | "medium";
  count: number;
  detail: Record<string, number>;
}

export async function runIntelligenceCanarySweep(now: Date = new Date()): Promise<{
  signals: CanarySignal[]; alertsWritten: number;
}> {
  const sinceTs = admin.firestore.Timestamp.fromMillis(now.getTime() - LOOKBACK_MS);
  const signals: CanarySignal[] = [];

  // U5 receipts live on executed-action ledger records.
  const ledgerSnap = await db.collection("agent_action_ledger")
    .orderBy("createdAt", "desc").limit(SCAN_LIMIT).get()
    .catch(() => null);
  if (ledgerSnap) {
    const recent = ledgerSnap.docs
      .map((d) => d.data() as { createdAt?: admin.firestore.Timestamp; status?: string; toolName?: string; metadata?: { evidence?: { status?: string } } })
      .filter((d) => d.createdAt && d.createdAt.toMillis() >= sinceTs.toMillis() && d.status === "executed");
    const byTool = (status: string) => recent
      .filter((d) => d.metadata?.evidence?.status === status)
      .reduce<Record<string, number>>((acc, d) => {
        const t = d.toolName ?? "unknown";
        acc[t] = (acc[t] ?? 0) + 1;
        return acc;
      }, {});
    const mismatches = byTool("mismatch");
    const mismatchCount = Object.values(mismatches).reduce((a, b) => a + b, 0);
    if (mismatchCount > 0) {
      signals.push({ signal: "postcondition_mismatch", severity: "high", count: mismatchCount, detail: mismatches });
    }
    const unverifiable = byTool("unverifiable");
    const unverifiableCount = Object.values(unverifiable).reduce((a, b) => a + b, 0);
    // Unverifiable includes migration-state handler_output receipts; alert only
    // on volume that suggests verifier infrastructure failure.
    if (unverifiableCount >= 10) {
      signals.push({ signal: "verifier_degraded", severity: "medium", count: unverifiableCount, detail: unverifiable });
    }
  }

  // Dedupe: one alert per signal per UTC day.
  let alertsWritten = 0;
  const day = now.toISOString().slice(0, 10);
  for (const s of signals) {
    const ref = db.collection("admin_alerts").doc(`intelligence_canary_${s.signal}_${day}`);
    const existing = await ref.get();
    if (existing.exists) continue;
    await ref.set({
      type: "intelligence_canary",
      signal: s.signal,
      severity: s.severity,
      count: s.count,
      detail: s.detail, // counts by tool name only — never content
      message: `Intelligence canary: ${s.signal} fired ${s.count}x in 24h (plan 2026-07-18-001 hold signal).`,
      createdAt: now.toISOString(),
      status: "open",
    });
    alertsWritten++;
  }

  console.info("intelligenceCanary.sweep", {
    signals: signals.map((s) => ({ signal: s.signal, count: s.count })),
    alertsWritten,
  });
  return { signals, alertsWritten };
}

export const intelligenceCanaryWatch = functions.pubsub
  .schedule("15 * * * *") // hourly at :15, offset from other sweeps
  .timeZone("UTC")
  .onRun(() => runIntelligenceCanarySweep());
