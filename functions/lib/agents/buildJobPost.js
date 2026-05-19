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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAndSaveJobPost = buildAndSaveJobPost;
const admin = __importStar(require("firebase-admin"));
const axios_1 = __importDefault(require("axios"));
const jobNotifications_1 = require("../triggers/jobNotifications");
const db = admin.firestore();
// ── Geocoding (zippopotam.us — free, no API key) ──────────────────────────────
async function geocodeZip(zipCode) {
    var _a, _b;
    if (!zipCode || zipCode.length < 5)
        return null;
    try {
        const resp = await axios_1.default.get(`https://api.zippopotam.us/us/${zipCode}`, { timeout: 5000 });
        const place = (_b = (_a = resp.data) === null || _a === void 0 ? void 0 : _a.places) === null || _b === void 0 ? void 0 : _b[0];
        if ((place === null || place === void 0 ? void 0 : place.latitude) && (place === null || place === void 0 ? void 0 : place.longitude)) {
            return { lat: parseFloat(place.latitude), lng: parseFloat(place.longitude) };
        }
    }
    catch (_c) {
        // Non-critical — job post will still be created, just without radius notifications
    }
    return null;
}
// ── Main builder ──────────────────────────────────────────────────────────────
async function buildAndSaveJobPost(params) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
    const { uid, phone, onboardingData, jobData } = params;
    const seniorName = ((_a = onboardingData.seniorName) !== null && _a !== void 0 ? _a : "");
    const firstName = seniorName.split(" ")[0] || seniorName;
    const relationship = ((_b = onboardingData.relationship) !== null && _b !== void 0 ? _b : "");
    const city = ((_c = onboardingData.city) !== null && _c !== void 0 ? _c : "");
    const zipCode = ((_d = onboardingData.zipCode) !== null && _d !== void 0 ? _d : "");
    const conditions = ((_e = onboardingData.conditions) !== null && _e !== void 0 ? _e : []);
    const seniorAge = onboardingData.age;
    const careNeeds = ((_f = jobData.jobCareNeeds) !== null && _f !== void 0 ? _f : []);
    const careLevel = ((_g = jobData.jobCareLevel) !== null && _g !== void 0 ? _g : "moderate");
    const startDate = ((_h = jobData.jobStartDate) !== null && _h !== void 0 ? _h : "");
    const frequency = ((_j = jobData.jobFrequency) !== null && _j !== void 0 ? _j : "occasional");
    const days = ((_k = jobData.jobDays) !== null && _k !== void 0 ? _k : []);
    const timeOfDay = ((_l = jobData.jobTimeOfDay) !== null && _l !== void 0 ? _l : []);
    const hourlyRate = jobData.jobHourlyRate;
    const paymentMethod = ((_m = jobData.jobPaymentMethod) !== null && _m !== void 0 ? _m : "card");
    const description = ((_o = jobData.jobDescription) !== null && _o !== void 0 ? _o : "");
    const petsInHome = ((_p = jobData.petsInHome) !== null && _p !== void 0 ? _p : false);
    const smokingHousehold = ((_q = jobData.smokingHousehold) !== null && _q !== void 0 ? _q : false);
    const title = `${careLevel === "light" ? "Light " : careLevel === "intensive" ? "Full " : ""}Care for ${firstName || "Loved One"}`;
    const coords = await geocodeZip(zipCode);
    // ── job_postings/{uid} — client's own record ──────────────────────────────
    const jobPostingDoc = {
        clientId: uid,
        careRecipientFirstName: firstName,
        careRecipientName: seniorName,
        relationship,
        title,
        description,
        city,
        zipCode,
        location: Object.assign({ city, zipCode }, (coords !== null && coords !== void 0 ? coords : {})),
        schedule: { startDate, frequency, days, timeOfDay },
        careNeeds,
        careLevel,
        hourlyRate,
        paymentMethod,
        petsInHome,
        smokingHousehold,
        status: "open",
        postedAt: admin.firestore.FieldValue.serverTimestamp(),
        source: "cara",
        phone,
    };
    await db.collection("job_postings").doc(uid).set(jobPostingDoc, { merge: true });
    // ── carePlans/{uid} — full care plan with recipient details ───────────────
    const recipientKey = `recipient_${firstName.toLowerCase().replace(/[^a-z0-9]/g, "_") || "primary"}`;
    await db.collection("carePlans").doc(uid).set({
        clientId: uid,
        phone,
        recipientPlans: {
            [recipientKey]: {
                name: seniorName,
                age: seniorAge,
                relationship,
                careNeeds,
                careLevel,
                conditions,
                updatedAt: new Date().toISOString(),
            },
        },
        locationPool: [
            Object.assign({ city,
                zipCode,
                petsInHome,
                smokingHousehold, primary: true }, (coords !== null && coords !== void 0 ? coords : {})),
        ],
        updatedAt: new Date().toISOString(),
    }, { merge: true });
    // ── job_posts/{autoId} — public listing that triggers caregiver notifications
    const jobPostRef = db.collection("job_posts").doc();
    const jobPostDoc = {
        intakeId: jobPostRef.id,
        clientId: uid,
        status: "open",
        careTypes: careNeeds,
        schedule: { frequency, days, timeOfDay },
        startDate,
        location: { lat: (_r = coords === null || coords === void 0 ? void 0 : coords.lat) !== null && _r !== void 0 ? _r : null, lng: (_s = coords === null || coords === void 0 ? void 0 : coords.lng) !== null && _s !== void 0 ? _s : null, city },
        summary: careNeeds.length > 0 ? `New care job — ${careNeeds.slice(0, 2).join(", ")}` : "New care job",
        daysPerWeek: days.length,
        timeOfDay: timeOfDay.join(", "),
        hourlyRate,
        paymentMethod,
        applicantCount: 0,
        notifiedCount: 0,
        source: "cara",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await jobPostRef.set(jobPostDoc);
    // ── onboardingProgress flags on users/{uid} ───────────────────────────────
    await db.collection("users").doc(uid).set({
        onboardingProgress: {
            carePlanComplete: true,
            identityVerified: true,
            membershipActive: true,
            jobPosted: true,
            jobPostId: jobPostRef.id,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    // ── Notify area caregivers (fire-and-forget) ──────────────────────────────
    (0, jobNotifications_1.notifyAreaCaregivers)(jobPostRef.id, jobPostDoc, uid)
        .catch((err) => console.error("[buildAndSaveJobPost] notifyAreaCaregivers error:", err));
    console.log(`[buildAndSaveJobPost] Job posted: ${jobPostRef.id} for uid=${uid}`);
    return jobPostRef.id;
}
//# sourceMappingURL=buildJobPost.js.map