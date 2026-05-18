import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { handlePromptGet } from "../mcp/server";
import { getRelevantFacts } from "../memory/learnedFacts";
import { getMemoryContext } from "../memory/memoryFiles";
import { getPreferences, isInDND } from "../memory/preferences";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const db = admin.firestore();

// Runs every day at 7am local (12:00 UTC covers most US time zones at 7am)
export const sendMorningBriefings = functions.pubsub
  .schedule("0 12 * * *")
  .timeZone("America/Los_Angeles")
  .onRun(async () => {
    const today = new Date().toISOString().slice(0, 10);

    // Find all confirmed appointments for today
    const snap = await db.collection("appointments")
      .where("date",   "==", today)
      .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
      .get();

    for (const doc of snap.docs) {
      const appt = doc.data();
      const caregiverId = appt.caregiverId as string;
      if (!caregiverId) continue;

      try {
        const [cgSnap, clientSnap, carePlanSnap] = await Promise.all([
          db.collection("caregivers").doc(caregiverId).get(),
          db.collection("users").doc(appt.clientId).get(),
          db.collection("care_plans").doc(appt.clientId).get(),
        ]);

        const caregiver = cgSnap.data();
        if (!caregiver?.phone) continue;

        const cgSession = await db.collection("agent_sessions").doc(caregiver.phone).get();
        if (!cgSession.exists) continue;

        const senior   = clientSnap.data();
        const carePlan = carePlanSnap.data();
        const cgFirstName  = ((caregiver.name ?? "there") as string).split(" ")[0];
        const seniorName   = (senior?.seniorName ?? appt.clientName ?? "your client") as string;
        const address      = (appt.address ?? appt.location ?? "the client's home") as string;
        const schedule     = `${appt.startTime ?? ""}${appt.endTime ? `–${appt.endTime as string}` : ""}`;

        const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(address)}`;

        // Fetch last journal entry for context
        const lastJournal = await db.collection("care_journal")
          .where("seniorId", "==", appt.clientId)
          .orderBy("timestamp", "desc")
          .limit(1)
          .get()
          .catch(() => null);
        const lastNotes = lastJournal?.empty ? null :
          (lastJournal?.docs[0].data().notes as string | undefined) ?? null;

        // Build context note from last visit or care plan note
        const contextNote = lastNotes
          ? lastNotes.slice(0, 120)
          : (carePlan?.notes ? (carePlan.notes as string).slice(0, 120) : null);

        // Medication line — only if there are meds
        const meds = (carePlan?.medications as string[] | undefined) ?? [];
        const medLine = meds.length > 0
          ? `Medications: ${meds.slice(0, 2).join(", ")}.`
          : null;

        // Verified badge — show for first 30 days after background check clears
        const clearedAt = caregiver?.backgroundCheckData?.clearedAt as string | undefined;
        const verifiedNote = (
          caregiver?.backgroundCheckData?.status === "clear" &&
          clearedAt &&
          Date.now() - new Date(clearedAt).getTime() < 30 * 24 * 60 * 60 * 1000
        )
          ? `Your background check is active and current. ✓`
          : null;

        const fallbackLines = [
          `Morning ${cgFirstName}! ${seniorName} today${schedule ? ` — ${schedule}` : ""} at ${address}.`,
          mapsUrl,
          contextNote,
          medLine,
          verifiedNote,
          `Reply ARRIVED when you get there.`,
        ].filter(Boolean);

        let content: string;
        try {
          const briefingPrompt = handlePromptGet("morning-caregiver-briefing", {
            caregiverName: cgFirstName,
            seniorName,
            schedule:      schedule ?? "",
            address,
            mapsUrl:       mapsUrl ?? "",
            medLine:       medLine ?? "",
            verifiedNote:  verifiedNote ?? "",
          });
          const aiResponse = await getClient().messages.create({
            model:    "claude-haiku-4-5-20251001",
            max_tokens: 200,
            messages: [{ role: "user", content: briefingPrompt }],
          });
          content = ((aiResponse.content[0] as { text: string }).text ?? "").trim()
            || fallbackLines.join("\n\n");
        } catch {
          content = fallbackLines.join("\n\n");
        }

        await sendViaInteractionAgent(caregiver.phone as string, {
          content,
          urgency:     "standard",
          sourceAgent: "morning_briefing",
          canDrop:     true,
        });
      } catch (err) {
        console.error("morningBriefing error for appt", doc.id, err);
      }
    }

    // ── Family morning briefings — send to clients with visits today ──────────
    await sendFamilyMorningBriefings(today, snap.docs).catch(err =>
      console.error("[morningBriefing] sendFamilyMorningBriefings error:", err)
    );

    // Check caregiver workloads (run Monday mornings to catch the week ahead)
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek === 1) { // Monday
      await checkCaregiverWorkloads().catch(err =>
        console.error("[morningBriefing] checkCaregiverWorkloads error:", err)
      );
    }
  });

// ── Caregiver workload awareness ──────────────────────────────────────────────

export async function checkCaregiverWorkloads(): Promise<void> {
  const today    = new Date().toISOString().slice(0, 10);
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
  const weekStartStr = weekStart.toISOString().slice(0, 10);

  // Get all caregivers with confirmed/completed appointments this week
  const apptSnap = await db.collection("appointments")
    .where("status", "in", ["confirmed", "completed", "in-progress"])
    .where("date",   ">=", weekStartStr)
    .where("date",   "<=", today)
    .get();

  if (apptSnap.empty) return;

  // Sum hours by caregiver
  const hoursById: Record<string, { hours: number; name: string; phone?: string }> = {};
  for (const doc of apptSnap.docs) {
    const d = doc.data();
    const cgId   = d.caregiverId as string;
    const cgName = d.caregiverName as string;
    if (!cgId) continue;

    const startTime = d.startTime ?? "09:00";
    const endTime   = d.endTime   ?? d.completedAt?.slice(11, 16) ?? "17:00";
    const [sh, sm]  = startTime.split(":").map(Number);
    const [eh, em]  = endTime.split(":").map(Number);
    const durationH = Math.max(0, (eh * 60 + em - sh * 60 - sm) / 60);

    if (!hoursById[cgId]) hoursById[cgId] = { hours: 0, name: cgName, phone: undefined };
    hoursById[cgId].hours += durationH;
    if (!hoursById[cgId].name) hoursById[cgId].name = cgName;
  }

  // For caregivers at 45h+, send a wellness message (once per week)
  for (const [cgId, data] of Object.entries(hoursById)) {
    if (data.hours < 45) continue;

    try {
      const cgSnap = await db.collection("caregivers").doc(cgId).get();
      const cgData = cgSnap.data();
      if (!cgData) continue;

      // Check if we sent this week already
      const lastWorkloadAlert = cgData.lastWorkloadAlertWeek as string | undefined;
      if (lastWorkloadAlert === weekStartStr) continue;

      const cgPhone = cgData.phone as string | undefined;
      if (!cgPhone) continue;

      await sendViaInteractionAgent(cgPhone, {
        content:
          `You're scheduled for ${Math.round(data.hours)} hours this week — that's a full load. ` +
          `Make sure you're taking care of yourself too. Reply SCHEDULE to see your week.`,
        urgency:     "standard",
        sourceAgent: "workload_check",
        canDrop:     true,
      });

      await db.collection("caregivers").doc(cgId).update({
        lastWorkloadAlertWeek: weekStartStr,
      });
    } catch (err) {
      console.error(`[checkCaregiverWorkloads] Error for caregiver ${cgId}:`, err);
    }
  }
}

// ── Family morning briefings ─────────────────────────────────────────────────

async function sendFamilyMorningBriefings(
  today: string,
  apptDocs: FirebaseFirestore.QueryDocumentSnapshot[]
): Promise<void> {
  // Deduplicate by clientId — one briefing per family even with multiple visits
  const seenClients = new Set<string>();

  for (const doc of apptDocs) {
    const appt       = doc.data();
    const clientId   = appt.clientId as string;
    if (!clientId || seenClients.has(clientId)) continue;
    seenClients.add(clientId);

    try {
      const [clientSnap, cgSnap] = await Promise.all([
        db.collection("users").doc(clientId).get(),
        appt.caregiverId ? db.collection("caregivers").doc(appt.caregiverId as string).get() : Promise.resolve(null),
      ]);

      const clientData = clientSnap.data();
      if (!clientData) continue;

      const phone: string | undefined = clientData.phone;
      if (!phone) continue;

      const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
      if (!sessionSnap.exists) continue;
      const session = sessionSnap.data()!;
      if (session.optedOut) continue;

      // Respect DND and preferred summary time from preferences
      const prefs = await getPreferences(phone).catch(() => null);
      if (prefs && isInDND(prefs)) continue;
      if (prefs?.preferredSummaryTime) {
        const [prefH] = prefs.preferredSummaryTime.split(":").map(Number);
        const nowHour = new Date().getHours();
        if (Math.abs(nowHour - prefH) > 1) continue;
      }

      // Avoid duplicate sends — check if we sent a family briefing today already
      const lastBriefingSnap = await db.collection("agent_alerts_log")
        .where("type",     "==", "family_morning_briefing")
        .where("clientId", "==", clientId)
        .where("sentAt",   ">=", today)
        .limit(1)
        .get();
      if (!lastBriefingSnap.empty) continue;

      const caregiverName = (cgSnap?.data()?.name ?? appt.caregiverName ?? "Your caregiver") as string;
      const seniorName    = (clientData.seniorName ?? "your loved one") as string;
      const startTime     = (appt.startTime ?? "") as string;
      const schedule      = startTime ? `at ${startTime}` : "today";

      // Load memory context for care priorities
      const [facts, memCtx] = await Promise.all([
        getRelevantFacts(clientId).catch(() => [] as { fact: string; category: string }[]),
        getMemoryContext(clientId).catch(() => ""),
      ]);

      const topFacts = facts
        .filter(f => f.category === "medical" || f.category === "routine")
        .slice(0, 3)
        .map(f => f.fact);

      // Generate briefing via Claude Haiku
      let content: string;
      try {
        const factsLine = topFacts.length > 0
          ? `Care priorities on file: ${topFacts.join("; ")}.`
          : "";
        const memLine = memCtx ? memCtx.slice(0, 300) : "";

        const resp = await getClient().messages.create({
          model:      "claude-haiku-4-5-20251001",
          max_tokens: 180,
          system:
            "You write a brief morning text for a family member whose loved one has a caregiver visit today.\n" +
            "Tone: warm, direct, practical — like a trusted care coordinator texting. No bullet points, no emoji.\n" +
            "Format: 2-3 sentences max. Start with caregiver arrival info. Add one specific care note if available.\n" +
            "Output only the message text.",
          messages: [{
            role: "user",
            content:
              `Senior: ${seniorName}\n` +
              `Caregiver: ${caregiverName} arriving ${schedule}\n` +
              factsLine + "\n" +
              memLine,
          }],
        });
        content = ((resp.content[0] as { text: string }).text ?? "").trim();
        if (!content) throw new Error("empty");
      } catch {
        // Fallback template
        const noteLine = topFacts.length > 0
          ? ` Keep in mind: ${topFacts[0].toLowerCase()}.`
          : "";
        content = `Good morning! ${caregiverName} is scheduled to arrive ${schedule} for ${seniorName}.${noteLine}`;
      }

      await sendViaInteractionAgent(phone, {
        content,
        urgency:     "standard",
        sourceAgent: "family_morning_briefing",
        canDrop:     true,
      });

      await db.collection("agent_alerts_log").add({
        type:     "family_morning_briefing",
        clientId,
        phone,
        sentAt:   today,
      });
    } catch (err) {
      console.error("[sendFamilyMorningBriefings] error for client", clientId, err);
    }
  }
}
