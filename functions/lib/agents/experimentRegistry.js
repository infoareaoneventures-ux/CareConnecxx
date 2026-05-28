"use strict";
// Active prompt experiments. Imported for side-effects from qaAgent — registers
// each experiment into the in-process registry at module load. Add new
// experiments here; remove them when the experiment ends.
//
// Conventions:
//   - key: lowercase kebab/snake. Stable for the lifetime of the experiment.
//   - control variant should always have an empty directive (`""`) so
//     measuring "control vs treatment" is a pure prompt diff.
//   - Use the `predicate` to dark-launch (return `false` everywhere) — the
//     framework still records nothing, and zero traffic sees the variant.
//     When ready to ramp, swap the predicate for cohort logic or remove it.
//
// Reading the data: every turn that sees a variant emits
// `cara.turn { experiments: { <key>: <variant>, ... } }` in Cloud Logging.
Object.defineProperty(exports, "__esModule", { value: true });
const promptExperiments_1 = require("./promptExperiments");
// ── tone-warmth-v1 ────────────────────────────────────────────────────────────
// Hypothesis: an explicit warmth/empathy directive on the first turn of a
// conversation improves perceived voice and reduces "robotic" complaints.
// Status: ACTIVE — client cohort only (caregivers stay on default voice).
// 50/50 control vs treat. Sticky per userId via FNV-1a.
// Exposure logged via metrics.experiments on every cara.turn log line.
(0, promptExperiments_1.registerExperiment)({
    key: "tone-warmth-v1",
    description: "Adds an explicit warmth + empathy directive to the system prompt",
    variants: {
        control: "",
        treat: "WARMTH (experiment): When the family's message has any emotional weight, " +
            "open your reply by reflecting what they're feeling in 4–8 words before answering. " +
            "Example: \"That sounds exhausting — let me look.\" Skip if the message is purely transactional.",
    },
    // Client cohort only — caregiver tone is already calibrated separately.
    predicate: (ctx) => ctx.userType === "client",
});
//# sourceMappingURL=experimentRegistry.js.map