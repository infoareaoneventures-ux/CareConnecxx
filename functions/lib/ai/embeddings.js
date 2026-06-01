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
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMBEDDING_MODEL = exports.EMBEDDING_DIM = void 0;
exports.hashText = hashText;
exports.composeCaregiverText = composeCaregiverText;
exports.composeIntakeText = composeIntakeText;
exports.generateEmbedding = generateEmbedding;
exports.cosineSimilarity = cosineSimilarity;
const genai_1 = require("@google/genai");
const crypto = __importStar(require("crypto"));
const functions = __importStar(require("firebase-functions/v1"));
const EMBEDDING_MODEL = "text-embedding-004";
exports.EMBEDDING_MODEL = EMBEDDING_MODEL;
const EMBEDDING_DIM = 768;
exports.EMBEDDING_DIM = EMBEDDING_DIM;
const apiKey = process.env.GEMINI_API_KEY ||
    process.env.VITE_GEMINI_API_KEY ||
    ((_a = functions.config().gemini) === null || _a === void 0 ? void 0 : _a.api_key);
const ai = apiKey ? new genai_1.GoogleGenAI({ apiKey }) : null;
function hashText(text) {
    return crypto.createHash("sha1").update(text).digest("hex");
}
function stripPII(text) {
    return text
        .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "")
        .replace(/(\+?\d[\d\s().-]{7,}\d)/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
function composeCaregiverText(caregiver) {
    var _a, _b;
    const parts = [];
    const years = caregiver.yearsExperience || caregiver.experience || 0;
    if (years > 0)
        parts.push(`Caregiver with ${years} years of professional experience.`);
    const skills = [
        ...(caregiver.skills || []),
        ...(caregiver.specializations || []),
        ...(caregiver.specialties || []),
        ...(caregiver.medicalSkills || []),
    ];
    if (skills.length)
        parts.push(`Care skills and specializations: ${skills.join(", ")}.`);
    if ((_a = caregiver.certifications) === null || _a === void 0 ? void 0 : _a.length) {
        parts.push(`Professional certifications: ${caregiver.certifications.join(", ")}.`);
    }
    if ((_b = caregiver.languages) === null || _b === void 0 ? void 0 : _b.length) {
        parts.push(`Languages spoken: ${caregiver.languages.join(", ")}.`);
    }
    // ADL capabilities in plain language
    const adls = caregiver.adls || caregiver.adlSkills || [];
    if (adls.length) {
        parts.push(`Activities of daily living (ADLs): assists with ${adls.join(", ")}.`);
    }
    // Personality traits — important for cultural/personality fit
    const personality = caregiver.personalityTags || caregiver.personality || [];
    const personalityList = Array.isArray(personality) ? personality : [personality].filter(Boolean);
    if (personalityList.length) {
        parts.push(`Personality and approach: ${personalityList.join(", ")}.`);
    }
    // Specific conditions handled
    const conditions = [];
    if (skills.some(s => /dementia|alzheimer|memory/i.test(s)))
        conditions.push("dementia and memory care");
    if (skills.some(s => /parkinson/i.test(s)))
        conditions.push("Parkinson's disease");
    if (skills.some(s => /hospice|palliative/i.test(s)))
        conditions.push("hospice and end-of-life care");
    if (skills.some(s => /stroke/i.test(s)))
        conditions.push("stroke recovery");
    if (skills.some(s => /diabetes/i.test(s)))
        conditions.push("diabetes management");
    if (skills.some(s => /autism/i.test(s)))
        conditions.push("autism support");
    if (conditions.length) {
        parts.push(`Experienced with: ${conditions.join(", ")}.`);
    }
    // Additional profile details
    if (caregiver.gender)
        parts.push(`Gender: ${caregiver.gender}.`);
    if (caregiver.petFriendly)
        parts.push("Pet-friendly caregiver.");
    if (caregiver.hasTransportation || caregiver.hasCar)
        parts.push("Has own transportation.");
    if (caregiver.smokingStatus === "non-smoker" || caregiver.nonSmoker)
        parts.push("Non-smoker.");
    if (caregiver.bio || caregiver.about) {
        parts.push(`Personal statement: ${stripPII(String(caregiver.bio || caregiver.about))}`);
    }
    return parts.join(" ").slice(0, 4000);
}
const SCHEDULE_DAY_LABELS = {
    monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
    thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday",
};
const SCHEDULE_BLOCK_LABELS = {
    morning: "mornings", afternoon: "afternoons", evening: "evenings", overnight: "overnight",
};
function describeSchedule(schedule) {
    if (!schedule || typeof schedule !== "object")
        return "";
    const days = [];
    for (const [day, blocks] of Object.entries(schedule)) {
        if (!Array.isArray(blocks) || !blocks.length)
            continue;
        const label = SCHEDULE_DAY_LABELS[day.toLowerCase()] || day;
        const blockLabels = blocks
            .map(b => SCHEDULE_BLOCK_LABELS[String(b).toLowerCase()] || b)
            .join(" and ");
        days.push(`${label} ${blockLabels}`);
    }
    return days.length ? days.join(", ") : "";
}
function describeADLs(tasks) {
    if (!tasks || typeof tasks !== "object")
        return "";
    const ADL_LABELS = {
        bathing: "bathing", dressing: "dressing", grooming: "grooming",
        toileting: "toileting", transfer: "transfers and mobility",
        ambulation: "walking and ambulation", feeding: "feeding and meals",
        medication: "medication management", housekeeping: "light housekeeping",
        transportation: "transportation and errands", companionship: "companionship",
    };
    const active = [];
    for (const [key, val] of Object.entries(tasks)) {
        if ((Array.isArray(val) && val.length > 0) || val === true) {
            active.push(ADL_LABELS[key.toLowerCase()] || key);
        }
    }
    return active.join(", ");
}
function composeIntakeText(intake) {
    var _a, _b, _c, _d;
    const parts = [];
    // Care recipient info
    const recipientAge = ((_a = intake.careRecipient) === null || _a === void 0 ? void 0 : _a.age) || intake.seniorAge;
    const recipientName = ((_b = intake.careRecipient) === null || _b === void 0 ? void 0 : _b.firstName) || "the care recipient";
    if (recipientAge)
        parts.push(`Family seeking care for ${recipientName}, age ${recipientAge}.`);
    // Care needs
    const needs = intake.careTypes || intake.needs || [];
    if (Array.isArray(needs) && needs.length) {
        parts.push(`Primary care needs: ${needs.join(", ")}.`);
    }
    // ADL tasks in plain language
    if (intake.tasks && typeof intake.tasks === "object") {
        const adlDesc = describeADLs(intake.tasks);
        if (adlDesc)
            parts.push(`Assistance needed with: ${adlDesc}.`);
    }
    // Medical / cognitive conditions
    const conditions = [];
    const allNeeds = [...needs, ...Object.keys(intake.tasks || {})].map(s => s.toLowerCase());
    if (allNeeds.some(n => /dementia|alzheimer|memory/i.test(n)))
        conditions.push("dementia or memory impairment");
    if (allNeeds.some(n => /parkinson/i.test(n)))
        conditions.push("Parkinson's disease");
    if (allNeeds.some(n => /hospice|palliative/i.test(n)))
        conditions.push("hospice care");
    if (allNeeds.some(n => /diabetes/i.test(n)))
        conditions.push("diabetes");
    if ((_c = intake.medicalConditions) === null || _c === void 0 ? void 0 : _c.length)
        conditions.push(...intake.medicalConditions);
    if (conditions.length)
        parts.push(`Medical context: ${conditions.join(", ")}.`);
    // Schedule in human language
    const schedDesc = describeSchedule(intake.schedule);
    if (schedDesc)
        parts.push(`Care schedule needed: ${schedDesc}.`);
    // Preferences
    if (intake.genderPreference && intake.genderPreference !== "No Preference") {
        parts.push(`Prefers a ${intake.genderPreference} caregiver.`);
    }
    if (intake.languagePreference) {
        parts.push(`Language preference: ${intake.languagePreference}.`);
    }
    if ((_d = intake.careRecipient) === null || _d === void 0 ? void 0 : _d.personality) {
        parts.push(`Care recipient personality: ${intake.careRecipient.personality}.`);
    }
    if (intake.petInHome)
        parts.push("There are pets in the home.");
    // Free-text context from family
    if (intake.additionalComments) {
        parts.push(`Family notes: ${stripPII(String(intake.additionalComments))}`);
    }
    return parts.join(" ").slice(0, 4000);
}
async function generateEmbedding(text) {
    var _a, _b;
    if (!text.trim())
        return null;
    const inputHash = hashText(text);
    if (!ai) {
        console.warn("[embeddings] GEMINI_API_KEY not set — skipping embedding");
        return null;
    }
    try {
        const resp = await ai.models.embedContent({
            model: EMBEDDING_MODEL,
            contents: text,
        });
        const values = (_b = (_a = resp.embeddings) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.values;
        if (!values || values.length !== EMBEDDING_DIM) {
            console.warn(`[embeddings] Unexpected vector length: ${values === null || values === void 0 ? void 0 : values.length}`);
            return null;
        }
        return { vector: values, inputHash, sourceText: text };
    }
    catch (err) {
        console.error("[embeddings] Gemini call failed:", err);
        return null;
    }
}
function cosineSimilarity(a, b) {
    if (a.length !== b.length)
        return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0)
        return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
//# sourceMappingURL=embeddings.js.map