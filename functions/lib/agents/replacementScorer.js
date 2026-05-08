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
exports.scoreReplacements = scoreReplacements;
const admin = __importStar(require("firebase-admin"));
const scoring_1 = require("../ai/scoring");
const db = admin.firestore();
async function scoreReplacements(params) {
    var _a, _b;
    const { clientId, excludeId } = params;
    // Load senior needs for skill matching
    const seniorSnap = await db.collection("senior_profiles").doc(clientId).get();
    const clientNeeds = (_b = (_a = seniorSnap.data()) === null || _a === void 0 ? void 0 : _a.needs) !== null && _b !== void 0 ? _b : [];
    // Load past bookings to flag previously-booked caregivers
    const pastSnap = await db
        .collection("appointments")
        .where("clientId", "==", clientId)
        .where("status", "==", "completed")
        .limit(50)
        .get();
    const previouslyBooked = new Set(pastSnap.docs.map((d) => d.data().caregiverId));
    // Load verified caregivers (exclude the one who cancelled)
    const caregiverSnap = await db
        .collection("caregivers")
        .where("verified", "==", true)
        .limit(40)
        .get();
    const candidates = caregiverSnap.docs
        .map((d) => (Object.assign({ id: d.id }, d.data())))
        .filter((c) => c.id !== excludeId);
    if (candidates.length === 0)
        return [];
    // Score each candidate
    const scored = candidates.map((c) => {
        var _a, _b, _c, _d, _e, _f;
        const input = {
            caregiverId: c.id,
            caregiverSkills: [
                ...((_a = c.skills) !== null && _a !== void 0 ? _a : []),
                ...((_b = c.certifications) !== null && _b !== void 0 ? _b : []),
                ...((_c = c.medicalSkills) !== null && _c !== void 0 ? _c : []),
            ],
            clientNeeds,
            distanceMiles: c.distance,
            rating: c.rating,
            yearsExperience: c.experience,
            personalBoost: previouslyBooked.has(c.id) ? 5 : 0,
        };
        const result = (0, scoring_1.scoreCaregiver)(input);
        return {
            caregiverId: c.id,
            name: (_d = c.name) !== null && _d !== void 0 ? _d : "Caregiver",
            rating: +((_e = c.rating) !== null && _e !== void 0 ? _e : 0).toFixed(1),
            hourlyRate: (_f = c.hourlyRate) !== null && _f !== void 0 ? _f : 0,
            previouslyBooked: previouslyBooked.has(c.id),
            score: result.score,
        };
    });
    // Sort by score descending, return top 3
    return scored.sort((a, b) => b.score - a.score).slice(0, 3);
}
//# sourceMappingURL=replacementScorer.js.map