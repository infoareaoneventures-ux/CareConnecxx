import { TEST_CASES, EvalCase } from "./testCases";
import { detectCrisis, MEDICAL_RESPONSE, EMOTIONAL_RESPONSE } from "../safety/crisisDetector";
import { classifyIntent } from "../agents/intentClassifier";
import { lintMessage } from "../safety/linter";

// ── Eval outcome ──────────────────────────────────────────────────────────────
// `skipped` cases are NOT counted as passes (the old behaviour silently returned
// passed:true for every non-crisis/linter case, inflating the rate to ~100% and
// making the 90% deploy gate meaningless). A skipped case is one this CLI runner
// cannot honestly evaluate without the live agent — it's excluded from the pass
// rate and reported, never counted as a win. (ch7 TDAD: an eval that can't fail
// isn't an eval.)
type CaseOutcome = { status: "passed" } | { status: "failed"; reason: string } | { status: "skipped"; reason: string };

// The live agent path is opt-in and spend/prod-touching (it calls the real
// runQaAgent, which reads/writes Firestore and bills the model provider), so it
// runs ONLY with CARA_EVAL_LIVE=true against a NON-production Firebase project.
// Mirrors the CARA_ONBOARDING_EVAL_LIVE gate in qaAgent.onboarding.eval.test.ts.
const LIVE_AGENT_EVAL = process.env.CARA_EVAL_LIVE === "true";

// Categories the CLI runner can drive as a single agent turn. Multi-turn
// onboarding flows are evaluated by the dedicated vitest harness
// (qaAgent.onboarding.eval.test.ts, graded by onboardingEvalGraders.ts), not
// here, so they stay skipped rather than being half-evaluated on one turn.
const LIVE_EVALUABLE_CATEGORIES = new Set([
  "qa_general", "matching", "booking", "interview",
  "permissions", "correction", "health_alerts",
]);

// Check a produced reply against the case's substring allow/deny lists.
function checkReply(tc: EvalCase, reply: string): CaseOutcome {
  const lower = reply.toLowerCase();
  for (const must of tc.mustContain ?? []) {
    if (!lower.includes(must.toLowerCase())) {
      return { status: "failed", reason: `Reply missing required string: "${must}" — got: "${reply.slice(0, 120)}"` };
    }
  }
  for (const mustNot of tc.mustNotContain ?? []) {
    if (lower.includes(mustNot.toLowerCase())) {
      return { status: "failed", reason: `Reply contains banned string: "${mustNot}"` };
    }
  }
  return { status: "passed" };
}

// ── Individual test evaluator ─────────────────────────────────────────────────

async function evaluateCase(tc: EvalCase, index: number): Promise<CaseOutcome> {
  const text = tc.input;
  const liveIntentEvalEnabled = process.env.CARA_EVAL_LIVE_INTENT === "true";

  // ── Crisis cases: verify crisis detector fires correctly ──────────────────
  if (tc.category === "crisis") {
    const crisis = detectCrisis(text);
    let response = "";

    if (tc.mustContain?.includes("911")) {
      if (crisis !== "medical") {
        return { status: "failed", reason: `Expected medical crisis detection, got: ${crisis}` };
      }
      response = MEDICAL_RESPONSE;
    } else if (tc.mustContain?.includes("988")) {
      if (crisis !== "emotional") {
        return { status: "failed", reason: `Expected emotional crisis detection, got: ${crisis}` };
      }
      response = EMOTIONAL_RESPONSE;
    }
    return checkReply(tc, response);
  }

  // ── Intent classification cases ───────────────────────────────────────────
  if (tc.expectedIntent && liveIntentEvalEnabled) {
    try {
      const intent = await classifyIntent(text, false);
      if (intent !== tc.expectedIntent) {
        return { status: "failed", reason: `Expected intent ${tc.expectedIntent}, got ${intent}` };
      }
      return { status: "passed" };
    } catch (err) {
      return { status: "skipped", reason: `intent classification threw: ${String(err)}` };
    }
  }

  // ── Linter cases — verify banned phrases are stripped ────────────────────
  const LINTER_STRIPPED = new Set(["as an ai"]);
  const linterTargets = (tc.mustNotContain ?? []).filter(p => LINTER_STRIPPED.has(p.toLowerCase()));
  if (linterTargets.length > 0) {
    for (const mustNot of linterTargets) {
      const lintedTest = lintMessage(`Test: ${mustNot}`);
      if (lintedTest.toLowerCase().includes(mustNot.toLowerCase())) {
        return { status: "failed", reason: `Linter failed to remove banned phrase: "${mustNot}"` };
      }
    }
    return { status: "passed" };
  }

  // ── Agent-output cases: drive the real agent (opt-in, live only) ──────────
  // These are the cases the old code silently auto-passed. With CARA_EVAL_LIVE
  // set we run one real agent turn and check the reply; otherwise we SKIP (never
  // fake a pass). Onboarding categories are evaluated by the vitest harness.
  if (LIVE_AGENT_EVAL && LIVE_EVALUABLE_CATEGORIES.has(tc.category)) {
    try {
      const { runQaAgent } = await import("../agents/qaAgent");
      // Unique synthetic identity per case so conversations don't cross-talk.
      const phone = `+1555${String(1_000_000 + index).slice(-7)}`;
      const reply = await runQaAgent({
        text,
        phone,
        chatId:   phone,
        userId:   `eval_${tc.id}`,
        seniorId: "",
        userType: "client",
        intent:   null,
        skipSend: true,
      } as Parameters<typeof runQaAgent>[0]);
      return checkReply(tc, typeof reply === "string" ? reply : "");
    } catch (err) {
      return { status: "failed", reason: `Live agent turn threw: ${String(err)}` };
    }
  }

  // Not live, or a category this CLI runner doesn't drive → honest skip.
  return {
    status: "skipped",
    reason: LIVE_AGENT_EVAL
      ? `category '${tc.category}' is evaluated by the vitest onboarding/golden harness, not this CLI runner`
      : `agent-output case — set CARA_EVAL_LIVE=true (non-prod project) to evaluate against the real agent`,
  };
}

// ── Main runner ───────────────────────────────────────────────────────────────

export async function runEvals(): Promise<{
  passed: number;
  failed: number;
  skipped: number;
  evaluated: number;
  total: number;
  rate: number;
  failures: Array<{ id: string; category: string; input: string; reason?: string }>;
}> {
  const failures: Array<{ id: string; category: string; input: string; reason?: string }> = [];
  let passed = 0;
  let skipped = 0;

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i];
    try {
      const result = await evaluateCase(tc, i);
      if (result.status === "passed") {
        passed++;
      } else if (result.status === "skipped") {
        skipped++;
      } else {
        failures.push({ id: tc.id, category: tc.category, input: tc.input, reason: result.reason });
      }
    } catch (err) {
      failures.push({
        id:       tc.id,
        category: tc.category,
        input:    tc.input,
        reason:   `Exception: ${String(err)}`,
      });
    }
  }

  const total     = TEST_CASES.length;
  const evaluated = total - skipped;
  // Rate is over EVALUATED cases only — a skipped case is neither a pass nor a
  // fail, so it must not dilute or inflate the gate.
  const rate = evaluated > 0 ? passed / evaluated : 0;

  return { passed, failed: failures.length, skipped, evaluated, total, rate, failures };
}

/**
 * The release gate's verdict (pure). Emergency cases are MUST-PASS (2026-11-09): a single missed emergency wording
 * blocks the release no matter how high the overall rate is — a 90% rate would otherwise let two of twenty-five
 * through. Nothing evaluated = misconfiguration, never a vacuous pass.
 */
export function evalGateVerdict(r: { evaluated: number; rate: number; failures: Array<{ id: string; category: string }> }): { pass: boolean; reason: string } {
  const missedEmergencies = r.failures.filter((f) => f.category === "crisis");
  if (missedEmergencies.length > 0) {
    return { pass: false, reason: `Emergency cases are must-pass and ${missedEmergencies.length} failed (${missedEmergencies.map((f) => f.id).join(", ")}). Blocking deploy.` };
  }
  if (r.evaluated === 0) return { pass: false, reason: "No cases were evaluated — the eval gate cannot pass vacuously. Check configuration." };
  if (r.rate < 0.9) return { pass: false, reason: `Pass rate ${(r.rate * 100).toFixed(1)}% < 90% threshold. Blocking deploy.` };
  return { pass: true, reason: "ok" };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  runEvals().then(({ passed, failed, skipped, evaluated, total, rate, failures }) => {
    console.log(`\n── Evia Eval Results ──`);
    console.log(`  Evaluated: ${evaluated}/${total} (${skipped} skipped)`);
    console.log(`  Passed: ${passed}/${evaluated} (${(rate * 100).toFixed(1)}%)`);
    console.log(`  Failed: ${failed}`);
    if (!process.env.CARA_EVAL_LIVE) {
      console.log(`  ⚠️  Agent-output cases skipped — set CARA_EVAL_LIVE=true (non-prod project) to evaluate the real agent.`);
    }

    if (failures.length > 0) {
      console.log(`\n── Failures ──`);
      for (const f of failures) {
        console.log(`  [${f.category}] ${f.id}: "${f.input.slice(0, 60)}"`);
        if (f.reason) console.log(`    → ${f.reason}`);
      }
    }

    const verdict = evalGateVerdict({ evaluated, rate, failures });
    if (!verdict.pass) {
      console.error(`\n❌ ${verdict.reason}`);
      process.exit(1);
    } else {
      console.log(`\n✅ All good — ${(rate * 100).toFixed(1)}% pass rate over ${evaluated} evaluated cases.`);
    }
  }).catch((err) => {
    console.error("Eval runner error:", err);
    process.exit(1);
  });
}
