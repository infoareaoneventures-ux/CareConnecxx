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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getJobRecommendationsForCaregiver = getJobRecommendationsForCaregiver;
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
async function getJobRecommendationsForCaregiver(caregiverId, limit = 5) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const [cgSnap, jobsSnap] = await Promise.all([
        db.collection("caregivers").doc(caregiverId).get(),
        db.collection("job_posts").where("status", "==", "open").limit(20).get(),
    ]);
    if (!cgSnap.exists || jobsSnap.empty)
        return [];
    const cg = cgSnap.data();
    const cgSkills = (_a = cg.skills) !== null && _a !== void 0 ? _a : [];
    const cgAvailDays = Object.entries((_b = cg.weeklyAvailability) !== null && _b !== void 0 ? _b : {})
        .filter(([, slots]) => Array.isArray(slots) && slots.length > 0)
        .map(([day]) => day);
    const cgRate = (_c = cg.hourlyRate) !== null && _c !== void 0 ? _c : 20;
    const scored = [];
    for (const doc of jobsSnap.docs) {
        const job = doc.data();
        let score = 0;
        const reasons = [];
        // Skills match
        const jobNeeds = (_e = (_d = job.careTypes) !== null && _d !== void 0 ? _d : job.careNeeds) !== null && _e !== void 0 ? _e : [];
        const skillOverlap = jobNeeds.filter((need) => cgSkills.some(s => s.toLowerCase().includes(need.toLowerCase()) ||
            need.toLowerCase().includes(s.toLowerCase())));
        if (skillOverlap.length) {
            score += Math.min(40, skillOverlap.length * 15);
            reasons.push(`${skillOverlap.length} skill${skillOverlap.length > 1 ? "s" : ""} match`);
        }
        // Availability match
        const jobDays = ((_f = job.daysOfWeek) !== null && _f !== void 0 ? _f : []).map((d) => d.toLowerCase());
        const dayOverlap = jobDays.filter(d => cgAvailDays.includes(d));
        if (jobDays.length > 0 && dayOverlap.length === jobDays.length) {
            score += 30;
            reasons.push("available all required days");
        }
        else if (dayOverlap.length > 0) {
            score += 15;
            reasons.push(`available ${dayOverlap.length} of ${jobDays.length} required days`);
        }
        // Rate match
        const jobRate = (_h = (_g = job.hourlyRate) !== null && _g !== void 0 ? _g : job.rate) !== null && _h !== void 0 ? _h : 20;
        if (jobRate >= cgRate) {
            score += 20;
            reasons.push("rate meets your preference");
        }
        else if (jobRate >= cgRate * 0.85) {
            score += 10;
            reasons.push("rate close to your preference");
        }
        // Location bonus (if both have zipCode)
        if (cg.zipCode && job.zipCode && cg.zipCode === job.zipCode) {
            score += 10;
            reasons.push("same zip code");
        }
        scored.push({
            jobId: doc.id,
            clientName: (_j = job.clientName) !== null && _j !== void 0 ? _j : "A family",
            careTypes: jobNeeds,
            schedule: jobDays.join(", "),
            rate: jobRate,
            matchScore: Math.min(100, score),
            matchReasons: reasons,
            _score: score,
        });
    }
    return scored
        .sort((a, b) => b._score - a._score)
        .slice(0, limit)
        .map((_a) => {
        var { _score } = _a, rest = __rest(_a, ["_score"]);
        return rest;
    });
}
//# sourceMappingURL=jobMatchRecommender.js.map