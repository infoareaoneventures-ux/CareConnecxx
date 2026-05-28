"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports._internal = exports.triggerProactiveReflectionNow = exports.runProactiveReflection = void 0;
exports.buildReflectionPrompt = buildReflectionPrompt;
exports.parseReflectionOutput = parseReflectionOutput;
exports.hashContext = hashContext;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const openaiClient_1 = require("../utils/openaiClient");
// Proactive Reflection — v1 (admin-review-first)
//
// Every hour, Cara reads the last 24h of journal entries, completed visits,
// upcoming visits, and billing events for each opted-in family, runs a single
// gpt-4o-mini pass over the aggregated context, and asks: "Is there anything
// Cara should surface to the family right now that they haven't already
// asked about?"
//
// The model can answer either with a structured draft or with NOOP. Drafts are
// written to `proactive_drafts` with status="pending_review" — we do NOT send
// them. The 2-week admin-review-first phase from the roadmap is enforced at
// the storage layer; a separate (future) approval tool flips them to
// "approved" and a downstream sender consumes those. This file delivers the
// detection half of the loop; sending lives elsewhere.
//
// Design choices:
//   - gpt-4o-mini only (single-shot, cheap; ~$0.15/1M input). Hourly across a
//     few hundred families is well under $1/day.
//   - Per-family lookback is fixed at 24h. Reflection runs hourly so a signal
//     that develops over 6h has 24 chances to be surfaced — we don't need a
//     longer window in the prompt.
//   - Strict NOOP / JSON output. Anything that doesn't parse is dropped
//     silently (no draft); we'd rather miss a turn than write garbage to the
//     review queue.
//   - Idempotency: we hash the aggregated context per (userId, hour) and skip
//     when the same hash already produced a draft in the last 6h. Prevents
//     re-flagging the same situation hour after hour.
const db = admin.firestore();
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_FAMILIES_PER_RUN = 250;
async function loadFamilySnapshot(userId, seniorId) {
    var _a, _b, _c, _d, _e, _f, _g;
    const now = new Date();
    const since = new Date(now.getTime() - LOOKBACK_MS).toISOString();
    const ahead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const [journalSnap, pastSnap, upcomingSnap, billingSnap, seniorSnap, userSnap] = await Promise.all([
        db.collection("care_journal")
            .where("seniorId", "==", seniorId)
            .where("timestamp", ">=", since)
            .orderBy("timestamp", "desc")
            .limit(20).get(),
        db.collection("appointments")
            .where("clientId", "==", userId)
            .where("isoDate", ">=", since)
            .where("isoDate", "<=", now.toISOString())
            .where("status", "==", "completed")
            .limit(20).get(),
        db.collection("appointments")
            .where("clientId", "==", userId)
            .where("isoDate", ">", now.toISOString())
            .where("isoDate", "<=", ahead)
            .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
            .orderBy("isoDate", "asc").limit(10).get(),
        db.collection("billing_events")
            .where("userId", "==", userId)
            .where("createdAt", ">=", since)
            .orderBy("createdAt", "desc").limit(10).get().catch(() => null),
        db.collection("senior_profiles").doc(seniorId).get(),
        db.collection("users").doc(userId).get(),
    ]);
    return {
        journal: journalSnap.docs.map(d => d.data()),
        past: pastSnap.docs.map(d => d.data()),
        upcoming: upcomingSnap.docs.map(d => d.data()),
        billing: billingSnap ? billingSnap.docs.map(d => d.data()) : [],
        seniorName: (_b = (_a = seniorSnap.data()) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : "your loved one",
        clientName: (_g = (_d = (_c = userSnap.data()) === null || _c === void 0 ? void 0 : _c.firstName) !== null && _d !== void 0 ? _d : (_f = (_e = userSnap.data()) === null || _e === void 0 ? void 0 : _e.name) === null || _f === void 0 ? void 0 : _f.split(" ")[0]) !== null && _g !== void 0 ? _g : "there",
    };
}
// Compact textual rollup the LLM reads. Kept short to keep token cost low and
// to force the model to attend to specific signals rather than scan noise.
function buildReflectionPrompt(snap) {
    const journalLines = snap.journal.slice(0, 8).map(e => {
        var _a, _b, _c, _d, _e, _f, _g;
        const ts = (_b = (_a = e.timestamp) === null || _a === void 0 ? void 0 : _a.slice(0, 10)) !== null && _b !== void 0 ? _b : "?";
        const mood = (_d = (_c = e.wellness) === null || _c === void 0 ? void 0 : _c.mood) !== null && _d !== void 0 ? _d : "?";
        const ate = ((_e = e.wellness) === null || _e === void 0 ? void 0 : _e.ateWell) ? "ate well" : "appetite low";
        const meds = ((_f = e.wellness) === null || _f === void 0 ? void 0 : _f.tookMeds) ? "meds taken" : "meds missed";
        const notes = ((_g = e.notes) !== null && _g !== void 0 ? _g : "").slice(0, 120);
        return `  - ${ts} mood=${mood} ${ate} ${meds}${notes ? ` :: ${notes}` : ""}`;
    }).join("\n");
    const pastLines = snap.past.slice(0, 6).map(a => { var _a, _b, _c; return `  - ${(_b = (_a = a.date) !== null && _a !== void 0 ? _a : a.isoDate) !== null && _b !== void 0 ? _b : "?"} with ${(_c = a.caregiverName) !== null && _c !== void 0 ? _c : "caregiver"}`; }).join("\n");
    const upcomingLines = snap.upcoming.slice(0, 5).map(a => { var _a, _b, _c, _d, _e; return `  - ${(_b = (_a = a.date) !== null && _a !== void 0 ? _a : a.isoDate) !== null && _b !== void 0 ? _b : "?"} at ${(_c = a.time) !== null && _c !== void 0 ? _c : "?"} with ${(_d = a.caregiverName) !== null && _d !== void 0 ? _d : "caregiver"} (${(_e = a.status) !== null && _e !== void 0 ? _e : "?"})`; }).join("\n");
    const billingLines = snap.billing.slice(0, 5).map(b => { var _a, _b; return `  - ${(_a = b.type) !== null && _a !== void 0 ? _a : "event"} ${b.amount ? `$${b.amount}` : ""} ${(_b = b.status) !== null && _b !== void 0 ? _b : ""}`; }).join("\n");
    return [
        `Family: ${snap.clientName} (client), caring for ${snap.seniorName}.`,
        "",
        "RECENT CARE JOURNAL (last 24h):",
        journalLines || "  (no entries)",
        "",
        "COMPLETED VISITS (last 24h):",
        pastLines || "  (none)",
        "",
        "UPCOMING VISITS (next 7 days):",
        upcomingLines || "  (none scheduled)",
        "",
        "RECENT BILLING EVENTS:",
        billingLines || "  (none)",
    ].join("\n");
}
const REFLECTION_SYSTEM = `You are Cara's quiet observer. Read the family's last 24h of care data and decide whether there is something worth Cara proactively reaching out about RIGHT NOW that the family hasn't already asked.

Strong reasons to surface:
  • Pattern across multiple journal entries (3+ days of missed meds, appetite dropping, mood declining).
  • Caregiver no-show or repeated lateness.
  • An upcoming visit at risk (caregiver hasn't confirmed, gap on a day the family relies on).
  • A billing anomaly the family will see on a credit card before Cara explains it.
  • A milestone or anniversary worth a warm note.
  • A safety concern visible in the journal that hasn't been flagged.

Reasons NOT to surface:
  • A single normal entry. One bad day is not a pattern.
  • A scheduled visit that's fine.
  • A routine billing event with no surprise.
  • Anything the family was clearly already aware of (mentioned by name in journal).
  • Boredom — if nothing is meaningfully wrong or right, say nothing.

OUTPUT FORMAT: exactly one JSON object on a single line, no prose around it, no code fences.

If nothing is worth surfacing:
{"action":"noop"}

If something is worth surfacing:
{"action":"draft","draftText":"<the actual SMS Cara would send, in her voice — warm, short, names the specific thing>","reason":"<one sentence: what pattern you detected>","severity":"low|medium|high"}

Severity guide:
  • high   = safety / health concern that needs the family to act today
  • medium = something they'll want to know within a day but isn't urgent
  • low    = warmth / milestone / pre-warning before a billing event hits

Be conservative. Drafts go to a human review queue, but bad drafts still cost reviewer attention.`;
function parseReflectionOutput(raw) {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    try {
        const obj = JSON.parse(trimmed);
        if (obj.action === "noop")
            return { action: "noop" };
        if (obj.action !== "draft")
            return null;
        const draftText = typeof obj.draftText === "string" ? obj.draftText.trim() : "";
        const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
        const severity = obj.severity === "low" || obj.severity === "medium" || obj.severity === "high"
            ? obj.severity
            : "medium";
        if (!draftText || !reason)
            return null;
        if (draftText.length > 320)
            return null; // SMS-shaped; longer is a bug
        return { action: "draft", draftText, reason, severity };
    }
    catch (_a) {
        return null;
    }
}
// Stable hash for dedupe. Doesn't need to be cryptographic — we just want
// "did we already process this same situation in the last few hours."
function hashContext(prompt) {
    let h = 5381;
    for (let i = 0; i < prompt.length; i++) {
        h = ((h << 5) + h + prompt.charCodeAt(i)) & 0x7fffffff;
    }
    return h.toString(16);
}
async function recentDraftExists(userId, contextHash) {
    const since = new Date(Date.now() - DEDUPE_TTL_MS).toISOString();
    const snap = await db.collection("proactive_drafts")
        .where("userId", "==", userId)
        .where("contextHash", "==", contextHash)
        .where("createdAt", ">=", since)
        .limit(1).get();
    return !snap.empty;
}
async function reflectForFamily(opts) {
    try {
        const snap = await loadFamilySnapshot(opts.userId, opts.seniorId);
        // Skip families with zero activity in the window — nothing to reflect on.
        if (snap.journal.length === 0 && snap.past.length === 0 &&
            snap.upcoming.length === 0 && snap.billing.length === 0) {
            return "noop";
        }
        const prompt = buildReflectionPrompt(snap);
        const contextHash = hashContext(prompt);
        if (await recentDraftExists(opts.userId, contextHash))
            return "skipped";
        const raw = await (0, openaiClient_1.quickComplete)(REFLECTION_SYSTEM, prompt, { maxTokens: 300 });
        const parsed = parseReflectionOutput(raw);
        if (!parsed || parsed.action === "noop")
            return "noop";
        const draft = {
            userId: opts.userId,
            phone: opts.phone,
            draftText: parsed.draftText,
            reason: parsed.reason,
            severity: parsed.severity,
            contextHash,
            status: "pending_review",
            createdAt: new Date().toISOString(),
            inputs: {
                journalCount: snap.journal.length,
                pastApptCount: snap.past.length,
                upcomingCount: snap.upcoming.length,
                billingCount: snap.billing.length,
            },
        };
        await db.collection("proactive_drafts").add(draft);
        return "drafted";
    }
    catch (err) {
        console.error("proactiveReflection: family failed", opts.userId, err);
        return "error";
    }
}
async function runReflectionPass() {
    var _a;
    const sessionsSnap = await db.collection("agent_sessions")
        .where("optedOut", "==", false)
        .where("userType", "==", "client")
        .limit(MAX_FAMILIES_PER_RUN)
        .get();
    const stats = { scanned: 0, drafted: 0, noop: 0, skipped: 0, errored: 0 };
    for (const doc of sessionsSnap.docs) {
        const session = doc.data();
        const userId = session.userId;
        const seniorId = (_a = session.seniorId) !== null && _a !== void 0 ? _a : userId;
        if (!userId || !seniorId)
            continue;
        if (session.optedIn === false)
            continue;
        stats.scanned++;
        const outcome = await reflectForFamily({ phone: doc.id, userId, seniorId });
        if (outcome === "drafted")
            stats.drafted++;
        else if (outcome === "skipped")
            stats.skipped++;
        else if (outcome === "error")
            stats.errored++;
        else
            stats.noop++;
        // Light pacing — we're hitting Firestore + OpenAI per family; 100ms is
        // enough to spread the burst out and stay under any per-second quotas.
        await new Promise(r => setTimeout(r, 100));
    }
    console.info("proactiveReflection.pass", stats);
    return stats;
}
// Hourly schedule. The pass itself self-limits to MAX_FAMILIES_PER_RUN; if we
// outgrow that, partition by phone hash across multiple staggered hourly jobs.
exports.runProactiveReflection = functions.pubsub
    .schedule("0 * * * *")
    .timeZone("UTC")
    .onRun(() => runReflectionPass());
// Admin-only manual trigger for development + the 2-week review-first phase.
exports.triggerProactiveReflectionNow = functions.https.onCall(async (_, context) => {
    var _a;
    if (!((_a = context.auth) === null || _a === void 0 ? void 0 : _a.token.admin)) {
        throw new functions.https.HttpsError("permission-denied", "Admin only");
    }
    return runReflectionPass();
});
// Exported for tests.
exports._internal = { reflectForFamily, runReflectionPass };
//# sourceMappingURL=proactiveReflection.js.map