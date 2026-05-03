import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import {
    composeCaregiverText,
    composeIntakeText,
    generateEmbedding,
    hashText,
} from "./embeddings";
import {
    availabilityOverlap,
    haversineMiles,
    scoreCaregiver,
    ScoredMatch,
} from "./scoring";
import { boostForCaregiver, readClientFeedback } from "./feedback";

const MAX_CAREGIVERS_PER_RUN = 500;
const TOP_N = 20;

function pickSkills(data: any): string[] {
    return [
        ...(data.skills || []),
        ...(data.specializations || []),
        ...(data.specialties || []),
    ];
}

function pickNeeds(intake: any): string[] {
    if (Array.isArray(intake.careTypes)) return intake.careTypes;
    if (intake.tasks && typeof intake.tasks === "object") {
        return Object.keys(intake.tasks).filter(
            (k) => Array.isArray(intake.tasks[k]) && intake.tasks[k].length > 0
        );
    }
    return [];
}

function pickLatLng(data: any): { lat?: number; lng?: number } {
    const lat =
        data.latitude ?? data.location?.latitude ?? data.location?.lat;
    const lng =
        data.longitude ?? data.location?.longitude ?? data.location?.lng;
    return { lat, lng };
}

export async function ensureCaregiverEmbedding(
    caregiverId: string,
    data: any
): Promise<number[] | null> {
    const text = composeCaregiverText(data);
    if (!text) return null;
    const hash = hashText(text);
    if (data.embeddingInputHash === hash && Array.isArray(data.embedding)) {
        return data.embedding;
    }
    const result = await generateEmbedding(text);
    if (!result) return null;
    await admin.firestore().collection("caregivers").doc(caregiverId).set(
        {
            embedding: result.vector,
            embeddingInputHash: result.inputHash,
            embeddingUpdatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
    );
    return result.vector;
}

export async function ensureIntakeEmbedding(
    intakeId: string,
    data: any
): Promise<number[] | null> {
    const text = composeIntakeText(data);
    if (!text) return null;
    const hash = hashText(text);
    if (data.embeddingInputHash === hash && Array.isArray(data.embedding)) {
        return data.embedding;
    }
    const result = await generateEmbedding(text);
    if (!result) return null;
    await admin.firestore().collection("clientIntakes").doc(intakeId).set(
        {
            embedding: result.vector,
            embeddingInputHash: result.inputHash,
            embeddingUpdatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
    );
    return result.vector;
}

export async function computeMatchesForIntake(
    intakeId: string,
    intakeData: any,
    intakeEmbedding: number[] | null
): Promise<ScoredMatch[]> {
    const db = admin.firestore();
    const clientId = intakeData.userId || intakeId;

    const [caregiversSnap, feedback] = await Promise.all([
        db.collection("caregivers").limit(MAX_CAREGIVERS_PER_RUN).get(),
        readClientFeedback(clientId),
    ]);

    const clientNeeds = pickNeeds(intakeData);
    const clientLoc = pickLatLng(intakeData);

    // Preference signals from intake
    const clientGenderPref = intakeData.genderPreference;
    const clientLanguage = intakeData.languagePreference;

    const scored: ScoredMatch[] = [];

    for (const doc of caregiversSnap.docs) {
        const cg = doc.data();
        if (cg.isActive === false) continue;

        const caregiverLoc = pickLatLng(cg);
        const distance = haversineMiles(
            clientLoc.lat,
            clientLoc.lng,
            caregiverLoc.lat,
            caregiverLoc.lng
        );

        const overlap = availabilityOverlap(
            cg.weeklyAvailability,
            intakeData.schedule
        );

        scored.push(
            scoreCaregiver({
                caregiverId: doc.id,
                caregiverEmbedding: cg.embedding,
                clientEmbedding: intakeEmbedding,
                caregiverSkills: pickSkills(cg),
                clientNeeds,
                distanceMiles: distance,
                availabilityOverlap: overlap,
                rating: cg.rating,
                yearsExperience: cg.yearsExperience ?? cg.experience,
                personalBoost: boostForCaregiver(feedback, doc.id),
                clientGenderPref,
                caregiverGender: cg.gender,
                clientLanguage,
                caregiverLanguages: cg.languages,
            })
        );
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, TOP_N);
}

export async function writeClientMatches(
    clientId: string,
    intakeId: string,
    matches: ScoredMatch[]
): Promise<void> {
    const visibleMatches = matches.filter(
        (m) => m.confidence === "high" || m.confidence === "medium"
    );
    await admin
        .firestore()
        .collection("clientMatches")
        .doc(clientId)
        .set(
            {
                clientId,
                intakeId,
                topMatches: visibleMatches,
                allMatches: matches,
                computedAt: FieldValue.serverTimestamp(),
                version: Date.now(),
            },
            { merge: false }
        );
}

export async function runMatchingForIntake(
    intakeId: string,
    intakeData: any
): Promise<{ clientId: string; count: number } | null> {
    const clientId = intakeData.userId || intakeId;
    const embedding = await ensureIntakeEmbedding(intakeId, intakeData);
    const matches = await computeMatchesForIntake(
        intakeId,
        intakeData,
        embedding
    );
    await writeClientMatches(clientId, intakeId, matches);
    return { clientId, count: matches.length };
}
