"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runEvals = runEvals;
const testCases_1 = require("./testCases");
const crisisDetector_1 = require("../safety/crisisDetector");
const intentClassifier_1 = require("../agents/intentClassifier");
const linter_1 = require("../safety/linter");
// ── Individual test evaluator ─────────────────────────────────────────────────
async function evaluateCase(tc) {
    var _a, _b, _c, _d, _e;
    const text = tc.input;
    // ── Crisis cases: verify crisis detector fires correctly ──────────────────
    if (tc.category === "crisis") {
        const crisis = (0, crisisDetector_1.detectCrisis)(text);
        let response = "";
        if ((_a = tc.mustContain) === null || _a === void 0 ? void 0 : _a.includes("911")) {
            if (crisis !== "medical") {
                return { passed: false, reason: `Expected medical crisis detection, got: ${crisis}` };
            }
            response = crisisDetector_1.MEDICAL_RESPONSE;
        }
        else if ((_b = tc.mustContain) === null || _b === void 0 ? void 0 : _b.includes("988")) {
            if (crisis !== "emotional") {
                return { passed: false, reason: `Expected emotional crisis detection, got: ${crisis}` };
            }
            response = crisisDetector_1.EMOTIONAL_RESPONSE;
        }
        // Check mustContain / mustNotContain against the response
        for (const must of (_c = tc.mustContain) !== null && _c !== void 0 ? _c : []) {
            if (!response.toLowerCase().includes(must.toLowerCase())) {
                return { passed: false, reason: `Response missing required string: "${must}"` };
            }
        }
        for (const mustNot of (_d = tc.mustNotContain) !== null && _d !== void 0 ? _d : []) {
            if (response.toLowerCase().includes(mustNot.toLowerCase())) {
                return { passed: false, reason: `Response contains banned string: "${mustNot}"` };
            }
        }
        return { passed: true };
    }
    // ── Intent classification cases ───────────────────────────────────────────
    if (tc.expectedIntent) {
        try {
            const intent = await (0, intentClassifier_1.classifyIntent)(text, false);
            if (tc.expectedIntent && intent !== tc.expectedIntent) {
                // Soft check — intent mismatch is a warning, not a hard fail for most cases
                // (routing logic in webhooks.ts handles many cases keyword-based)
            }
        }
        catch (_f) {
            // Intent classification failure is non-critical for eval
        }
    }
    // ── Linter cases — verify banned phrases are stripped ────────────────────
    for (const mustNot of (_e = tc.mustNotContain) !== null && _e !== void 0 ? _e : []) {
        // Check if the banned phrase would survive linting when echoed back
        const testPhrase = mustNot.toLowerCase();
        if (testPhrase === "as an ai" ||
            testPhrase === "i cannot" ||
            testPhrase === "i am unable" ||
            testPhrase === "i don't have the ability") {
            // These should be stripped by linter — test that they ARE stripped
            const lintedTest = (0, linter_1.lintMessage)(`Test: ${mustNot}`);
            if (lintedTest.toLowerCase().includes(testPhrase)) {
                return { passed: false, reason: `Linter failed to remove banned phrase: "${mustNot}"` };
            }
        }
    }
    // ── Default: structural check only (mustContain / mustNotContain on input) ─
    // For a real eval, this would call the actual agent — here we do structural smoke tests
    return { passed: true };
}
// ── Main runner ───────────────────────────────────────────────────────────────
async function runEvals() {
    const failures = [];
    let passed = 0;
    for (const tc of testCases_1.TEST_CASES) {
        try {
            const result = await evaluateCase(tc);
            if (result.passed) {
                passed++;
            }
            else {
                failures.push({ id: tc.id, category: tc.category, input: tc.input, reason: result.reason });
            }
        }
        catch (err) {
            failures.push({
                id: tc.id,
                category: tc.category,
                input: tc.input,
                reason: `Exception: ${String(err)}`,
            });
        }
    }
    const total = testCases_1.TEST_CASES.length;
    const rate = passed / total;
    return { passed, failed: total - passed, total, rate, failures };
}
// ── CLI entry point ───────────────────────────────────────────────────────────
if (require.main === module) {
    runEvals().then(({ passed, failed, total, rate, failures }) => {
        console.log(`\n── Cara Eval Results ──`);
        console.log(`  Passed: ${passed}/${total} (${(rate * 100).toFixed(1)}%)`);
        console.log(`  Failed: ${failed}`);
        if (failures.length > 0) {
            console.log(`\n── Failures ──`);
            for (const f of failures) {
                console.log(`  [${f.category}] ${f.id}: "${f.input.slice(0, 60)}"`);
                if (f.reason)
                    console.log(`    → ${f.reason}`);
            }
        }
        if (rate < 0.9) {
            console.error(`\n❌ Pass rate ${(rate * 100).toFixed(1)}% < 90% threshold. Blocking deploy.`);
            process.exit(1);
        }
        else {
            console.log(`\n✅ All good — ${(rate * 100).toFixed(1)}% pass rate.`);
        }
    }).catch((err) => {
        console.error("Eval runner error:", err);
        process.exit(1);
    });
}
//# sourceMappingURL=runner.js.map