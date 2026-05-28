"use strict";
// Default prompt augmenters — migrated from the inline `systemPrompt += ...`
// chain in qaAgent.ts. Each augmenter is a pure function over AugmenterContext
// that returns either a directive string or null/empty (skip).
//
// Migration policy:
//   - Move one augmenter at a time. Each PR contains the new registry entry
//     AND the deletion of the corresponding inline append.
//   - The new directive text MUST be byte-identical to what the inline code
//     emitted. Test it by running the goldenTranscripts replay before and
//     after.
//   - Augmenters that need data not on ctx (e.g. Firestore reads) STAY inline
//     until we can populate the data through ctx.extras instead. Don't move
//     them to keep augmenters pure.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_AUGMENTERS = exports.personaReinjectAugmenter = exports.unconfirmedIdentityAugmenter = exports.languageAugmenter = void 0;
// ── language — replies in user's preferred language when set on session ──────
// Migrated from qaAgent.ts:1022 (es-only). Same text; same trigger condition.
exports.languageAugmenter = {
    name: "language",
    description: "Switch reply language to user's preferred language when set",
    predicate: (ctx) => {
        var _a;
        const lang = (_a = ctx.session) === null || _a === void 0 ? void 0 : _a.preferredLanguage;
        return lang === "es";
    },
    augment: () => "LANGUAGE: The family member speaks Spanish. Respond in warm, natural Spanish — " +
        "keep the same tone as Cara's English voice (close, direct, no chatbot phrasing). Do not switch back " +
        "to English unless the user does first.",
};
// ── unconfirmed-identity — phone in system but onboarding incomplete ─────────
// Migrated from qaAgent.ts:977-986. Same text; same trigger.
exports.unconfirmedIdentityAugmenter = {
    name: "unconfirmed-identity",
    description: "Suppress care data when phone has unconfirmed identity",
    predicate: (ctx) => { var _a; return !!((_a = ctx.session) === null || _a === void 0 ? void 0 : _a.__unconfirmedIdentity); },
    augment: () => "UNCONFIRMED IDENTITY: This phone is in the system but the speaker has not completed onboarding, " +
        "so we do not know who they are or what care plan they belong to. " +
        "Do NOT mention any senior, caregiver, appointment, interview, care plan, family group, or other person's data — " +
        "treat as if you have no profile context (because what's on file may be someone else's). " +
        "Do NOT call any tool that reads or writes care data (matching, booking, journal, scheduling, payments). " +
        "If they ask whether you know them, say plainly: \"I have your number on file but not your name yet — " +
        "we never finished setting up your account. Want to do that now?\" " +
        "Otherwise answer general questions about CareConnex (what we do, pricing, how it works) and gently nudge toward setup.",
};
// ── persona-reinject — fires every 4th turn OR after a lint violation ────────
// Migrated from qaAgent.ts:1081-1088. Same text; same trigger.
exports.personaReinjectAugmenter = {
    name: "persona-reinject",
    description: "Re-inject Cara persona + epistemic reminder to prevent voice drift",
    predicate: (ctx) => {
        var _a;
        const recentLintViolation = !!((_a = ctx.session) === null || _a === void 0 ? void 0 : _a.recentLintViolation);
        return (ctx.turnCount > 0 && ctx.turnCount % 4 === 0) || recentLintViolation;
    },
    augment: () => "<system_reminder>You are Cara — warm, direct, specific. " +
        "Text format only: no bullet points, no headers, no em-dashes. " +
        "Keep replies under 300 characters when possible. " +
        "Lead with the human before the data. " +
        "Epistemic: only state facts from your context or tool results. If uncertain, say 'I don't have that info' rather than guessing. " +
        "Tools available — use them for fresh data and to take real actions.</system_reminder>",
};
// Convenience array — the order here is the order they'll be appended to the
// system prompt. Keep it stable; downstream consumers (turn metrics, tests)
// rely on the ordering.
exports.DEFAULT_AUGMENTERS = [
    exports.languageAugmenter,
    exports.unconfirmedIdentityAugmenter,
    exports.personaReinjectAugmenter,
];
//# sourceMappingURL=defaultPromptAugmenters.js.map