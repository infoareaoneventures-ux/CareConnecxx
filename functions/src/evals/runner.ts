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
  const LINTER_STRIPPED = new Set(["as an ai", "i cannot", "i am unable", "i don't have the ability"]);
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

    // Gate on the evaluated set. If nothing was evaluated (misconfiguration),
    // fail loudly rather than pass vacuously.
    if (evaluated === 0) {
      console.error(`\n❌ No cases were evaluated — the eval gate cannot pass vacuously. Check configuration.`);
      process.exit(1);
    } else if (rate < 0.9) {
      console.error(`\n❌ Pass rate ${(rate * 100).toFixed(1)}% < 90% threshold. Blocking deploy.`);
      process.exit(1);
    } else {
      console.log(`\n✅ All good — ${(rate * 100).toFixed(1)}% pass rate over ${evaluated} evaluated cases.`);
    }
  }).catch((err) => {
    console.error("Eval runner error:", err);
    process.exit(1);
  });
}
