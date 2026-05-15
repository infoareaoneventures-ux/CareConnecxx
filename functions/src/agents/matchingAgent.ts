import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";

const db = admin.firestore();

interface CaregiverCandidate {
  id:                     string;
  name:                   string;
  rating?:                number;
  hourlyRate:             number;
  specialties:            string[];
  city:                   string;
  yearsExperience:        number;
  availability?:          { days: string[]; hours: string };
  pendingBackgroundCheck?: boolean;
}

function score(caregiver: CaregiverCandidate, intake: Record<string, unknown>): number {
  let pts = 0;
  const needs = (intake.careNeeds ?? []) as string[];
  for (const need of needs) {
    if (caregiver.specialties?.some((s) => s.toLowerCase().includes(need.toLowerCase()))) pts += 10;
  }
  pts += Math.min((caregiver.yearsExperience ?? 0) * 2, 20);
  pts += Math.min((caregiver.rating ?? 0) * 4, 20);
  if ((caregiver.city ?? "").toLowerCase() === ((intake.city ?? "") as string).toLowerCase()) pts += 10;
  return pts;
}

export async function runMatchingForClient(
  phone:   string,
  chatId:  string,
  intake:  Record<string, unknown>,
  session?: Record<string, unknown>
): Promise<void> {
  try {
    const zip    = (intake.zipCode ?? "") as string;
    const city   = (intake.city    ?? "") as string;

    // Exclude caregivers the family has already declined
    const rejectedIds: string[] = (session?.rejectedCaregiverIds ?? []) as string[];
    if (!session) {
      const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
      if (sessionSnap.exists) {
        rejectedIds.push(...((sessionSnap.data()?.rejectedCaregiverIds ?? []) as string[]));
      }
    }

    // Pull active + pending_review caregivers in a broad radius
    const snap = await db.collection("caregivers")
      .where("status", "in", ["active", "pending_review"])
      .limit(50)
      .get();

    let caregivers: CaregiverCandidate[] = snap.docs
      .map((d) => ({
        id:                    d.id,
        pendingBackgroundCheck: d.data().status === "pending_review",
        ...d.data(),
      } as CaregiverCandidate))
      .filter((c) =>
        !rejectedIds.includes(c.id) && (
          c.city?.toLowerCase() === city.toLowerCase() ||
          (c as any).zipCode?.startsWith(zip.slice(0, 3))
        )
      );

    if (caregivers.length === 0) {
      // Broader search if local returns nothing (still respecting rejections)
      caregivers = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as CaregiverCandidate))
        .filter((c) => !rejectedIds.includes(c.id));
    }

    const top3 = caregivers
      .map((c) => ({ c, pts: score(c, intake) }))
      .sort((a, b) => b.pts - a.pts)
      .slice(0, 3)
      .map((x) => x.c);

    if (top3.length === 0) {
      // Write admin alert so the team can manually follow up
      const intakeCareNeeds = (intake.careNeeds ?? []) as string[];
      await db.collection("admin_alerts").add({
        type:       "no_match_found",
        clientPhone: phone,
        city:       (intake.city    ?? "") as string,
        zipCode:    (intake.zipCode ?? "") as string,
        careNeeds:  intakeCareNeeds,
        createdAt:  new Date().toISOString(),
        resolved:   false,
        severity:   "high",
      });
      await sendMessage(chatId,
        "I don't have anyone available in your area right now, but I've flagged your request " +
        "and our team will reach out within 24 hours to find the right match. 💙"
      );
      return;
    }

    // Write pending interview requests (and caregiver_interest tasks for pending-bg-check caregivers)
    for (const c of top3) {
      await db.collection("interview_requests").add({
        clientPhone:  phone,
        caregiverId:  c.id,
        caregiverName: c.name,
        status:       "pending_presentation",
        createdAt:    new Date().toISOString(),
      });

      if ((c as any).pendingBackgroundCheck) {
        await db.collection("agent_tasks").add({
          type:          "caregiver_interest",
          caregiverId:   c.id,
          caregiverName: c.name,
          clientPhone:   phone,
          clientId:      (session as any)?.userId ?? phone,
          status:        "pending_bg_clear",
          createdAt:     new Date().toISOString(),
        });
      }
    }

    const lines = top3.map((c, i) => {
      const stars    = "⭐".repeat(Math.round(c.rating ?? 4));
      const specials = (c.specialties ?? []).slice(0, 2).join(", ") || "General care";
      const yrs      = c.yearsExperience ?? "?";
      const bgNote     = (c as any).pendingBackgroundCheck ? "\n   ⏳ Background check in progress" : "";
      const profileUrl = `${process.env.APP_URL ?? "https://careconnecxx.com"}/caregiver/${c.id}`;
      return (
        `${i + 1}️⃣  ${c.name} · ${stars} · $${c.hourlyRate}/hr\n` +
        `   ${specials} · ${yrs}yrs exp${bgNote}\n` +
        `   👤 ${profileUrl}`
      );
    }).join("\n\n");

    await sendMessage(chatId,
      `I found ${top3.length} great matches for ${(intake.seniorName ?? "your loved one") as string} in ${city}! 🎉\n\n` +
      `${lines}\n\n` +
      `Reply with numbers to request interviews.\n` +
      `(e.g. "1" or "1 and 3" or "all")`
    );

    // Store match list in session for follow-up
    await db.collection("agent_sessions").doc(phone).update({
      pendingMatches: top3.map((c) => ({ id: c.id, name: c.name, rate: c.hourlyRate })),
    });
  } catch (err) {
    console.error("runMatchingForClient error:", err);
    await sendMessage(chatId,
      "I'm searching for caregivers — I'll text you top matches within the hour! 🔍"
    );
  }
}
