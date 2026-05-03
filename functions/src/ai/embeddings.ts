import { GoogleGenAI } from "@google/genai";
import * as crypto from "crypto";
import * as functions from "firebase-functions";

const EMBEDDING_MODEL = "text-embedding-004";
const EMBEDDING_DIM = 768;

const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.VITE_GEMINI_API_KEY ||
    functions.config().gemini?.api_key;

const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

export interface EmbeddingResult {
    vector: number[];
    inputHash: string;
    sourceText: string;
}

export function hashText(text: string): string {
    return crypto.createHash("sha1").update(text).digest("hex");
}

function stripPII(text: string): string {
    return text
        .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "")
        .replace(/(\+?\d[\d\s().-]{7,}\d)/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

export function composeCaregiverText(caregiver: any): string {
    const parts: string[] = [];

    const years = caregiver.yearsExperience || caregiver.experience || 0;
    if (years > 0) parts.push(`Caregiver with ${years} years of professional experience.`);

    const skills = [
        ...(caregiver.skills || []),
        ...(caregiver.specializations || []),
        ...(caregiver.specialties || []),
        ...(caregiver.medicalSkills || []),
    ];
    if (skills.length) parts.push(`Care skills and specializations: ${skills.join(", ")}.`);

    if (caregiver.certifications?.length) {
        parts.push(`Professional certifications: ${caregiver.certifications.join(", ")}.`);
    }

    if (caregiver.languages?.length) {
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
    const conditions: string[] = [];
    if (skills.some(s => /dementia|alzheimer|memory/i.test(s))) conditions.push("dementia and memory care");
    if (skills.some(s => /parkinson/i.test(s))) conditions.push("Parkinson's disease");
    if (skills.some(s => /hospice|palliative/i.test(s))) conditions.push("hospice and end-of-life care");
    if (skills.some(s => /stroke/i.test(s))) conditions.push("stroke recovery");
    if (skills.some(s => /diabetes/i.test(s))) conditions.push("diabetes management");
    if (skills.some(s => /autism/i.test(s))) conditions.push("autism support");
    if (conditions.length) {
        parts.push(`Experienced with: ${conditions.join(", ")}.`);
    }

    // Additional profile details
    if (caregiver.gender) parts.push(`Gender: ${caregiver.gender}.`);
    if (caregiver.petFriendly) parts.push("Pet-friendly caregiver.");
    if (caregiver.hasTransportation || caregiver.hasCar) parts.push("Has own transportation.");
    if (caregiver.smokingStatus === "non-smoker" || caregiver.nonSmoker) parts.push("Non-smoker.");

    if (caregiver.bio || caregiver.about) {
        parts.push(`Personal statement: ${stripPII(String(caregiver.bio || caregiver.about))}`);
    }

    return parts.join(" ").slice(0, 4000);
}

const SCHEDULE_DAY_LABELS: Record<string, string> = {
    monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
    thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday",
};

const SCHEDULE_BLOCK_LABELS: Record<string, string> = {
    morning: "mornings", afternoon: "afternoons", evening: "evenings", overnight: "overnight",
};

function describeSchedule(schedule: any): string {
    if (!schedule || typeof schedule !== "object") return "";
    const days: string[] = [];
    for (const [day, blocks] of Object.entries(schedule)) {
        if (!Array.isArray(blocks) || !blocks.length) continue;
        const label = SCHEDULE_DAY_LABELS[day.toLowerCase()] || day;
        const blockLabels = (blocks as string[])
            .map(b => SCHEDULE_BLOCK_LABELS[String(b).toLowerCase()] || b)
            .join(" and ");
        days.push(`${label} ${blockLabels}`);
    }
    return days.length ? days.join(", ") : "";
}

function describeADLs(tasks: any): string {
    if (!tasks || typeof tasks !== "object") return "";
    const ADL_LABELS: Record<string, string> = {
        bathing: "bathing", dressing: "dressing", grooming: "grooming",
        toileting: "toileting", transfer: "transfers and mobility",
        ambulation: "walking and ambulation", feeding: "feeding and meals",
        medication: "medication management", housekeeping: "light housekeeping",
        transportation: "transportation and errands", companionship: "companionship",
    };
    const active: string[] = [];
    for (const [key, val] of Object.entries(tasks)) {
        if ((Array.isArray(val) && val.length > 0) || val === true) {
            active.push(ADL_LABELS[key.toLowerCase()] || key);
        }
    }
    return active.join(", ");
}

export function composeIntakeText(intake: any): string {
    const parts: string[] = [];

    // Care recipient info
    const recipientAge = intake.careRecipient?.age || intake.seniorAge;
    const recipientName = intake.careRecipient?.firstName || "the care recipient";
    if (recipientAge) parts.push(`Family seeking care for ${recipientName}, age ${recipientAge}.`);

    // Care needs
    const needs = intake.careTypes || intake.needs || [];
    if (Array.isArray(needs) && needs.length) {
        parts.push(`Primary care needs: ${needs.join(", ")}.`);
    }

    // ADL tasks in plain language
    if (intake.tasks && typeof intake.tasks === "object") {
        const adlDesc = describeADLs(intake.tasks);
        if (adlDesc) parts.push(`Assistance needed with: ${adlDesc}.`);
    }

    // Medical / cognitive conditions
    const conditions: string[] = [];
    const allNeeds = [...needs, ...Object.keys(intake.tasks || {})].map(s => s.toLowerCase());
    if (allNeeds.some(n => /dementia|alzheimer|memory/i.test(n))) conditions.push("dementia or memory impairment");
    if (allNeeds.some(n => /parkinson/i.test(n))) conditions.push("Parkinson's disease");
    if (allNeeds.some(n => /hospice|palliative/i.test(n))) conditions.push("hospice care");
    if (allNeeds.some(n => /diabetes/i.test(n))) conditions.push("diabetes");
    if (intake.medicalConditions?.length) conditions.push(...intake.medicalConditions);
    if (conditions.length) parts.push(`Medical context: ${conditions.join(", ")}.`);

    // Schedule in human language
    const schedDesc = describeSchedule(intake.schedule);
    if (schedDesc) parts.push(`Care schedule needed: ${schedDesc}.`);

    // Preferences
    if (intake.genderPreference && intake.genderPreference !== "No Preference") {
        parts.push(`Prefers a ${intake.genderPreference} caregiver.`);
    }
    if (intake.languagePreference) {
        parts.push(`Language preference: ${intake.languagePreference}.`);
    }
    if (intake.careRecipient?.personality) {
        parts.push(`Care recipient personality: ${intake.careRecipient.personality}.`);
    }
    if (intake.petInHome) parts.push("There are pets in the home.");

    // Free-text context from family
    if (intake.additionalComments) {
        parts.push(`Family notes: ${stripPII(String(intake.additionalComments))}`);
    }

    return parts.join(" ").slice(0, 4000);
}

export async function generateEmbedding(
    text: string
): Promise<EmbeddingResult | null> {
    if (!text.trim()) return null;
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
        const values = resp.embeddings?.[0]?.values;
        if (!values || values.length !== EMBEDDING_DIM) {
            console.warn(
                `[embeddings] Unexpected vector length: ${values?.length}`
            );
            return null;
        }
        return { vector: values, inputHash, sourceText: text };
    } catch (err) {
        console.error("[embeddings] Gemini call failed:", err);
        return null;
    }
}

export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export { EMBEDDING_DIM, EMBEDDING_MODEL };
