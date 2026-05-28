"use strict";
// Wow-moment registry — a small catalog of delightful Cara moments that fire
// when conditions match (first booking confirmed, care anniversary, billing
// streaks, etc). Pure functions only — predicates take a snapshot context and
// return whether the moment is eligible. No I/O lives here; the caller
// (proactiveReflection, qaAgent, or a manual trigger) wires the snapshot.
//
// Why a registry instead of inline checks? Two reasons:
//   1. Adding a new wow-moment shouldn't touch reflection / qaAgent — just
//      drop a new entry and write the predicate.
//   2. Cooldown + recently-fired dedupe lives in one place. The same moment
//      shouldn't fire twice in the same window even if conditions still hold.
Object.defineProperty(exports, "__esModule", { value: true });
exports.WOW_MOMENTS = void 0;
exports.findEligibleWowMoments = findEligibleWowMoments;
exports.renderWowCandidate = renderWowCandidate;
exports.pickWowCandidate = pickWowCandidate;
const DAY_MS = 24 * 60 * 60 * 1000;
function daysBetween(a, b) {
    return Math.floor(Math.abs(a.getTime() - b.getTime()) / DAY_MS);
}
function isFirstWeekOfMonth(date) {
    return date.getDate() <= 7;
}
exports.WOW_MOMENTS = [
    // First booking confirmed — fires within 48h of the first confirmation event.
    {
        name: "first_booking_confirmed",
        description: "Celebrates the family's first confirmed booking — once only.",
        cooldownDays: 365, // truly once
        predicate: (ctx) => {
            var _a;
            const confirms = ((_a = ctx.recentEvents) !== null && _a !== void 0 ? _a : []).filter(e => e.type === "booking_confirmed");
            if (confirms.length !== 1)
                return false;
            const ageMs = ctx.now.getTime() - new Date(confirms[0].timestamp).getTime();
            return ageMs >= 0 && ageMs <= 2 * DAY_MS;
        },
        buildMessage: (ctx) => {
            var _a;
            const who = (_a = ctx.seniorName) !== null && _a !== void 0 ? _a : "your loved one";
            return `Quick note — your first booking for ${who} is locked in. Excited to get this rolling. I'll be in touch as the day approaches.`;
        },
    },
    // Care anniversary — N years since the first completed visit, fires in the
    // first week of the anniversary month so it doesn't compete with the day-of
    // bookings.
    {
        name: "care_anniversary",
        description: "Marks an anniversary of the first completed visit.",
        cooldownDays: 300,
        predicate: (ctx) => {
            if (!ctx.firstVisitAt)
                return false;
            const first = new Date(ctx.firstVisitAt);
            if (Number.isNaN(first.getTime()))
                return false;
            // Same month as the first visit, at least 1 full year later, first week.
            const sameMonth = first.getMonth() === ctx.now.getMonth();
            const yearsSince = ctx.now.getFullYear() - first.getFullYear();
            return sameMonth && yearsSince >= 1 && isFirstWeekOfMonth(ctx.now);
        },
        buildMessage: (ctx) => {
            var _a;
            const first = new Date(ctx.firstVisitAt);
            const years = ctx.now.getFullYear() - first.getFullYear();
            const who = (_a = ctx.seniorName) !== null && _a !== void 0 ? _a : "your loved one";
            const yr = years === 1 ? "year" : "years";
            return `Hard to believe — ${years} ${yr} since the first visit with ${who}. Thanks for letting us be part of the care.`;
        },
    },
    // Milestone visit counts — 10th, 25th, 50th, 100th. Fires when the count
    // is hit exactly (no retroactive flagging — we check against a step list).
    {
        name: "visit_milestone",
        description: "Marks 10/25/50/100 completed visits.",
        cooldownDays: 60,
        predicate: (ctx) => {
            var _a;
            const c = (_a = ctx.completedVisits) !== null && _a !== void 0 ? _a : 0;
            return [10, 25, 50, 100, 250].includes(c);
        },
        buildMessage: (ctx) => {
            var _a, _b;
            const c = (_a = ctx.completedVisits) !== null && _a !== void 0 ? _a : 0;
            const who = (_b = ctx.seniorName) !== null && _b !== void 0 ? _b : "your loved one";
            return `${c} visits in — that's a real care relationship. Hope ${who} is doing well today.`;
        },
    },
    // Caregiver streak — same caregiver for the last 5 completed visits. A
    // light acknowledgment that consistency is happening.
    {
        name: "caregiver_streak",
        description: "Same caregiver for 5+ consecutive completed visits.",
        cooldownDays: 45,
        predicate: (ctx) => {
            var _a;
            const ids = (_a = ctx.recentCaregiverIds) !== null && _a !== void 0 ? _a : [];
            if (ids.length < 5)
                return false;
            const first = ids[0];
            if (!first)
                return false;
            return ids.slice(0, 5).every(id => id === first);
        },
        buildMessage: (ctx) => {
            var _a;
            const who = (_a = ctx.seniorName) !== null && _a !== void 0 ? _a : "your loved one";
            return `Noticing the same caregiver has been with ${who} the last few visits — consistency like that is gold. Let me know if you want me to lock it in as a standing match.`;
        },
    },
    // Smooth billing — 90+ days with no refunds, no failed payments. Quietly
    // confirms things are working.
    {
        name: "smooth_billing_quarter",
        description: "90+ consecutive days with zero billing issues.",
        cooldownDays: 95, // fires roughly once a quarter at most
        predicate: (ctx) => { var _a; return ((_a = ctx.billingCleanDays) !== null && _a !== void 0 ? _a : 0) >= 90; },
        buildMessage: () => "Quick heads-up: billing's been smooth on your end for the past quarter. No action needed — just wanted you to know it's been clean.",
    },
];
/**
 * Returns wow-moments whose predicate matches AND which are not muted by an
 * in-cooldown firing record. Ordering: registry order (so deterministic).
 * The caller is responsible for picking ONE if it wants to send only one.
 */
function findEligibleWowMoments(ctx, recentFires = []) {
    var _a;
    const muted = new Set();
    for (const r of recentFires) {
        const def = exports.WOW_MOMENTS.find(m => m.name === r.name);
        if (!def)
            continue;
        const firedAt = new Date(r.firedAt);
        if (Number.isNaN(firedAt.getTime()))
            continue;
        const cooldown = ((_a = def.cooldownDays) !== null && _a !== void 0 ? _a : 30);
        if (daysBetween(ctx.now, firedAt) < cooldown) {
            muted.add(def.name);
        }
    }
    return exports.WOW_MOMENTS.filter(m => !muted.has(m.name) && safePredicate(m, ctx));
}
function safePredicate(m, ctx) {
    try {
        return m.predicate(ctx);
    }
    catch (err) {
        console.warn(`wowMoments: predicate threw for "${m.name}"`, err);
        return false;
    }
}
function renderWowCandidate(moment, ctx) {
    return { name: moment.name, message: moment.buildMessage(ctx).trim() };
}
/** Convenience: pick the first eligible moment (registry order) and render it. */
function pickWowCandidate(ctx, recentFires = []) {
    const eligible = findEligibleWowMoments(ctx, recentFires);
    if (eligible.length === 0)
        return null;
    return renderWowCandidate(eligible[0], ctx);
}
//# sourceMappingURL=wowMoments.js.map