import * as admin from "firebase-admin";
import { scoreCaregiver, ScoringInput } from "../ai/scoring";

const db = admin.firestore();

export interface ReplacementOption {
  caregiverId:     string;
  name:            string;
  rating:          number;
  hourlyRate:      number;
  previouslyBooked: boolean;
  score:           number;
}

export interface ScoreReplacementsParams {
  clientId:      string;
  appointmentId: string;
  date:          string;
  time:          string;
  excludeId:     string; // the caregiver who cancelled
}

export async function scoreReplacements(
  params: ScoreReplacementsParams
): Promise<ReplacementOption[]> {
  const { clientId, excludeId } = params;

  // Load senior needs for skill matching
  const seniorSnap = await db.collection("senior_profiles").doc(clientId).get();
  const clientNeeds: string[] = seniorSnap.data()?.needs ?? [];

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
    .map((d) => ({ id: d.id, ...d.data() } as any))
    .filter((c) => c.id !== excludeId);

  if (candidates.length === 0) return [];

  // Score each candidate
  const scored: ReplacementOption[] = candidates.map((c) => {
    const input: ScoringInput = {
      caregiverId:      c.id,
      caregiverSkills:  [
        ...(c.skills          ?? []),
        ...(c.certifications  ?? []),
        ...(c.medicalSkills   ?? []),
      ],
      clientNeeds,
      distanceMiles:    c.distance,
      rating:           c.rating,
      yearsExperience:  c.experience,
      personalBoost:    previouslyBooked.has(c.id) ? 5 : 0,
    };

    const result = scoreCaregiver(input);

    return {
      caregiverId:      c.id,
      name:             c.name ?? "Caregiver",
      rating:           +(c.rating ?? 0).toFixed(1),
      hourlyRate:       c.hourlyRate ?? 0,
      previouslyBooked: previouslyBooked.has(c.id),
      score:            result.score,
    };
  });

  // Sort by score descending, return top 3
  return scored.sort((a, b) => b.score - a.score).slice(0, 3);
}
