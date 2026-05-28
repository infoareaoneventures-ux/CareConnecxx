"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INTERNAL_SUB_AGENT_NAMES = exports.SUB_AGENT_REGISTRY = void 0;
exports.getPublicSubAgentNames = getPublicSubAgentNames;
exports.runEphemeralSubAgent = runEphemeralSubAgent;
exports.buildTaskToolDescription = buildTaskToolDescription;
const openaiClient_1 = require("../utils/openaiClient");
const claudeClient_1 = require("../utils/claudeClient");
const claudeRetry_1 = require("../utils/claudeRetry");
exports.SUB_AGENT_REGISTRY = {
    journal_summarizer: {
        name: "journal_summarizer",
        description: "Distill a list of care journal entries into a single warm-but-clinical paragraph for the family. " +
            "Pass the entries verbatim in `description` (you can include dates, moods, meals, meds, notes).",
        needsSonnet: false,
        inputs: "description should contain a list of journal entries with timestamps, moods, meals/meds flags, and notes.",
        systemPrompt: "You summarize a list of care journal entries for a family member. " +
            "Output one paragraph (3-5 sentences) of natural, warm prose that highlights TRENDS, not individual entries. " +
            "Call out patterns (3+ days of low appetite, repeated mood dips, missed meds) explicitly. " +
            "If there is nothing concerning, say so plainly. " +
            "Do not include greetings, sign-offs, bullet points, or markdown. " +
            "Reference dates only when a pattern starts or breaks. " +
            "Never invent details that aren't in the input.",
    },
    caregiver_compare: {
        name: "caregiver_compare",
        description: "Compare two or more caregivers and recommend one for a specific shift. " +
            "Pass each caregiver's name, rate, specialties, rating, and any context in `description`.",
        needsSonnet: true, // tradeoffs need real reasoning
        inputs: "description should contain shift requirements + a list of caregivers (name, rate, specialties, rating).",
        systemPrompt: "You compare caregivers for a specific shift and pick one. " +
            "Output exactly two sentences: " +
            "Sentence 1 names your recommendation and the single biggest reason. " +
            "Sentence 2 names the runner-up and the one trade-off that decided it. " +
            "No headers, no lists, no hedging. If the choice is genuinely close, say \"close call\" in sentence 1.",
    },
    budget_impact: {
        name: "budget_impact",
        description: "Compute the approximate monthly billing impact of a proposed care change. " +
            "Pass current hours/rate and proposed hours/rate in `description`.",
        needsSonnet: false,
        inputs: "description should contain current rate, current hours/week, proposed rate, proposed hours/week.",
        systemPrompt: "You compute approximate monthly cost changes for home care. " +
            "Assume 4.33 weeks per month. Output exactly one short paragraph: " +
            "the current monthly total, the new monthly total, the delta in dollars, and whether it's an increase or decrease. " +
            "Use plain language (\"about $X more per month\"). No tables, no math notation.",
    },
    // Internal — invoked automatically by the qaAgent tool loop after 2+
    // consecutive tool-error iterations. NOT meant for the main agent to call
    // directly (excluded from buildTaskToolDescription and the `task` enum).
    recovery: {
        name: "recovery",
        description: "(Internal) Diagnose why the main agent keeps hitting tool errors and propose a different approach.",
        needsSonnet: true,
        inputs: "description should contain: the original user request, the tools tried, and the recent error messages.",
        systemPrompt: "You are a recovery analyst for an SMS care-coordination agent (Cara). The main agent has hit two or more consecutive tool errors in a single turn. " +
            "Your job: read the situation, then return TWO short sentences. " +
            "Sentence 1: the most likely reason the tools are failing (wrong tool, missing arg, retrying an unavailable resource, etc). " +
            "Sentence 2: a concrete different approach (a different tool, asking the user one clarifying question, or replying without tools). " +
            "Never propose retrying the exact same call. Never apologize. No headers, no lists, no markdown.",
    },
};
/** Sub-agent names the parent agent must NOT invoke via `task` (internal-only). */
exports.INTERNAL_SUB_AGENT_NAMES = new Set(["recovery"]);
/** Sub-agent names the parent agent CAN invoke via the `task` MCP tool. */
function getPublicSubAgentNames() {
    return Object.keys(exports.SUB_AGENT_REGISTRY).filter(n => !exports.INTERNAL_SUB_AGENT_NAMES.has(n));
}
/**
 * Execute a single ephemeral sub-agent. Returns the raw text output. Throws
 * only on infrastructure errors — bad subagent_type and empty descriptions
 * return a structured error string that the parent agent can act on without
 * crashing its turn.
 */
async function runEphemeralSubAgent(opts) {
    var _a, _b, _c, _d;
    const startedAt = Date.now();
    const def = exports.SUB_AGENT_REGISTRY[opts.subagentType];
    if (!def) {
        return {
            output: `ERROR: unknown subagent_type "${opts.subagentType}". Available: ${Object.keys(exports.SUB_AGENT_REGISTRY).join(", ")}.`,
            subagentType: opts.subagentType,
            durationMs: Date.now() - startedAt,
            modelUsed: "gpt-4o-mini",
        };
    }
    const description = ((_a = opts.description) !== null && _a !== void 0 ? _a : "").trim();
    if (!description) {
        return {
            output: "ERROR: description is required and was empty.",
            subagentType: opts.subagentType,
            durationMs: Date.now() - startedAt,
            modelUsed: "gpt-4o-mini",
        };
    }
    const maxTokens = (_b = opts.maxTokens) !== null && _b !== void 0 ? _b : (def.needsSonnet ? 400 : 250);
    if (def.needsSonnet) {
        try {
            const resp = await (0, claudeRetry_1.callClaudeWithRetry)((0, claudeClient_1.getSharedClient)(), {
                model: "claude-sonnet-4-6",
                max_tokens: maxTokens,
                system: def.systemPrompt,
                messages: [{ role: "user", content: description }],
            });
            const text = ((_d = (_c = resp.content[0]) === null || _c === void 0 ? void 0 : _c.text) !== null && _d !== void 0 ? _d : "").trim();
            return {
                output: text || "(empty)",
                subagentType: def.name,
                durationMs: Date.now() - startedAt,
                modelUsed: "claude-sonnet-4-6",
            };
        }
        catch (err) {
            console.error(`subagent ${def.name} failed:`, err);
            return {
                output: "ERROR: sub-agent failed. The main agent should try a direct approach.",
                subagentType: def.name,
                durationMs: Date.now() - startedAt,
                modelUsed: "claude-sonnet-4-6",
            };
        }
    }
    // Lightweight path — gpt-4o-mini for the bulk of analytical work.
    const text = await (0, openaiClient_1.quickComplete)(def.systemPrompt, description, { maxTokens, signal: opts.signal })
        .catch((err) => {
        console.error(`subagent ${def.name} (mini) failed:`, err);
        return "ERROR: sub-agent failed. The main agent should try a direct approach.";
    });
    return {
        output: (text !== null && text !== void 0 ? text : "").trim() || "(empty)",
        subagentType: def.name,
        durationMs: Date.now() - startedAt,
        modelUsed: "gpt-4o-mini",
    };
}
/**
 * Build the MCP tool description for `task`. Surfaces the registry's
 * sub-agent names + descriptions so Claude can pick the right one without
 * us hardcoding tool variants per type. Single tool, multiple targets.
 */
function buildTaskToolDescription() {
    const lines = Object.values(exports.SUB_AGENT_REGISTRY)
        .filter(d => !exports.INTERNAL_SUB_AGENT_NAMES.has(d.name))
        .map(d => `  • ${d.name}: ${d.description}`);
    return [
        "Delegate a focused analytical chunk to an ephemeral sub-agent. The sub-agent has its own focused system prompt and returns a single text result.",
        "Use this when a turn needs a distinct piece of analysis that would otherwise pollute your main reasoning (e.g. summarizing many journal entries, comparing caregivers, computing budget impact).",
        "You can call `task` multiple times in one turn — independent calls run in parallel.",
        "Available sub-agents:",
        ...lines,
    ].join("\n");
}
//# sourceMappingURL=ephemeralSubAgents.js.map