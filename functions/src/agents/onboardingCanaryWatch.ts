// Onboarding-loop canary watch — reads the cara_turn_metrics Firestore mirror for
// onboarding-cohort turns and summarizes the rollback-relevant signals from
// docs/runbooks/onboarding-agent-loop-rollout.md:
//   - re-greet rate (should be ZERO)
//   - per-turn P95 latency vs the 4s provisional ceiling
//   - tool-error / exhausted / error rates
//
// Onboarding turns mirror to Firestore only while ONBOARDING_AGENT_LOOP is on
// (turnMetrics.ts), so this watch has data exactly during a canary and nothing to
// read when the flag is off.
//
// The summarizer is PURE (no I/O) so it unit-tests with synthetic records and no
// spend. The fetch + CLI are thin wrappers around it.

import { p95 } from "./onboardingEvalGraders";

export const ONBOARDING_LATENCY_CEILING_MS = 4_000;

export interface CanaryRecord {
  flowClass?: string | null;
  onboardingReGreet?: boolean;
  durationMs?: number;
  toolErrors?: number;
  exhausted?: boolean;
  errored?: boolean;
  phone?: string;
  at?: string;
}

export interface CanarySummary {
  turns: number;
  uniquePhones: number;
  reGreetCount: number;
  reGreetRate: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  toolErrorTurns: number;
  exhaustedTurns: number;
  erroredTurns: number;
  withinLatencyCeiling: boolean;
  /** True when every hard rollback gate is clean (no re-greet, within latency, no errored/exhausted). */
  healthy: boolean;
  ceilingMs: number;
}

/** Summarize a batch of onboarding canary records. Pure — no I/O. */
export function summarizeOnboardingCanary(
  records: CanaryRecord[],
  opts: { ceilingMs?: number } = {},
): CanarySummary {
  const ceilingMs = opts.ceilingMs ?? ONBOARDING_LATENCY_CEILING_MS;
  const onboarding = records.filter((r) => r.flowClass === "onboarding");
  const turns = onboarding.length;

  const latencies = onboarding
    .map((r) => r.durationMs)
    .filter((n): n is number => typeof n === "number" && n >= 0);

  const reGreetCount = onboarding.filter((r) => r.onboardingReGreet).length;
  const toolErrorTurns = onboarding.filter((r) => (r.toolErrors ?? 0) > 0).length;
  const exhaustedTurns = onboarding.filter((r) => r.exhausted).length;
  const erroredTurns = onboarding.filter((r) => r.errored).length;
  const uniquePhones = new Set(onboarding.map((r) => r.phone).filter(Boolean)).size;

  const p95LatencyMs = p95(latencies);
  const maxLatencyMs = latencies.length ? Math.max(...latencies) : 0;
  const withinLatencyCeiling = p95LatencyMs <= ceilingMs;

  return {
    turns,
    uniquePhones,
    reGreetCount,
    reGreetRate: turns ? reGreetCount / turns : 0,
    p95LatencyMs,
    maxLatencyMs,
    toolErrorTurns,
    exhaustedTurns,
    erroredTurns,
    withinLatencyCeiling,
    healthy:
      turns > 0 &&
      reGreetCount === 0 &&
      withinLatencyCeiling &&
      erroredTurns === 0 &&
      exhaustedTurns === 0,
    ceilingMs,
  };
}

/** Render a one-screen report from a summary. */
export function formatCanaryReport(s: CanarySummary, windowLabel: string): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const flag = (ok: boolean) => (ok ? "OK " : "⚠ ");
  return [
    `── Onboarding loop canary watch (${windowLabel}) ──`,
    `  turns:           ${s.turns}  (unique phones: ${s.uniquePhones})`,
    `  ${flag(s.reGreetCount === 0)}re-greets:      ${s.reGreetCount} (${pct(s.reGreetRate)}) — target 0`,
    `  ${flag(s.withinLatencyCeiling)}latency P95:    ${s.p95LatencyMs}ms (max ${s.maxLatencyMs}ms) — ceiling ${s.ceilingMs}ms`,
    `  ${flag(s.erroredTurns === 0)}errored turns:  ${s.erroredTurns}`,
    `  ${flag(s.exhaustedTurns === 0)}exhausted:      ${s.exhaustedTurns}`,
    `  tool-error turns: ${s.toolErrorTurns}`,
    ``,
    s.turns === 0
      ? `  no onboarding turns in window — is ONBOARDING_AGENT_LOOP=client set and taking traffic?`
      : s.healthy
        ? `  ✅ healthy — all hard rollback gates clean.`
        : `  ❌ NOT healthy — investigate the ⚠ rows before widening the canary.`,
  ].join("\n");
}

/** Fetch onboarding canary records from Firestore. Thin I/O wrapper. */
export async function fetchOnboardingCanary(opts: { sinceMs?: number; limit?: number } = {}): Promise<CanaryRecord[]> {
  const sinceMs = opts.sinceMs ?? 24 * 60 * 60 * 1000; // default: last 24h
  const limit = opts.limit ?? 1000;
  // Lazy require so module load never depends on admin being initialized.
  const admin = require("firebase-admin") as typeof import("firebase-admin");
  if (!admin.apps.length) admin.initializeApp();
  const sinceIso = new Date(Date.now() - sinceMs).toISOString();
  const snap = await admin
    .firestore()
    .collection("cara_turn_metrics")
    .where("flowClass", "==", "onboarding")
    .where("at", ">=", sinceIso)
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data() as CanaryRecord);
}

// ── CLI entry ─────────────────────────────────────────────────────────────────
// Usage: ts-node src/agents/onboardingCanaryWatch.ts [hoursWindow]
if (require.main === module) {
  const hours = Number(process.argv[2] ?? "24");
  const sinceMs = hours * 60 * 60 * 1000;
  fetchOnboardingCanary({ sinceMs })
    .then((records) => {
      const summary = summarizeOnboardingCanary(records);
      console.log(formatCanaryReport(summary, `last ${hours}h`));
      process.exit(summary.turns > 0 && !summary.healthy ? 1 : 0);
    })
    .catch((err) => {
      console.error("onboardingCanaryWatch error:", err);
      process.exit(2);
    });
}
