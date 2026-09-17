import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { handlePromptGet } from "../mcp/server";
import { getRelevantFacts } from "../memory/learnedFacts";
import { getMemoryContext } from "../memory/memoryFiles";
import { getPreferences, isInDND } from "../memory/preferences";
import { businessTodayStr } from "../utils/scheduledTime";
import { generateCaraMessage } from "../utils/caraMessage";
import { describeWhoIsWho } from "../agents/careRecipients";
import { guardModelOutput, ANTI_INVENTION_CLAUSE } from "../safety/outputGuard";
import { caraOutputGuardEnabled } from "../config/featureFlags";
import { gateOptionalSend } from "./engineGate";
import { queryVisits, visitSeniorName } from "../utils/visitQuery";

const db = admin.firestore();

// ── Briefing generation (U2 — hallucination hardening) ───────────────────────
// Both morning-briefing model calls bypass generateCaraMessage, so they carry
// the shared anti-invention rule and route their output through the model-
// output guard themselves. Exported for tests.

// Caregiver briefing: the briefing prompt arrives fully-formed via
// handlePromptGet as the user message, so the anti-invention rule rides in the
// system slot. Empty, guard-rejected, or errored output → the deterministic
// fallback lines.
//
// knownUrls: URLs the SYSTEM put into the prompt (the maps link). The guard's
// R3 url rule targets INVENTED URLs — the model echoing a prompt-supplied link
// is correct behavior, and rejecting it degraded the briefing to the fallback
// lines every day. Known URLs are stripped from the text BEFORE the guard
// judges it (so only model-authored URLs can trip it), the DELIVERED text is
// untouched, and a known URL the model dropped is re-appended deterministically
// so the briefing always carries its link (the fallback shape always did).
export async function generateCaregiverBriefingContent(
  briefingPrompt: string,
  fallback: string,
  knownUrls: string[] = []
): Promise<string> {
  try {
    const aiResponse = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system:     ANTI_INVENTION_CLAUSE,
      messages:   [{ role: "user", content: briefingPrompt }],
    });
    let text = ((aiResponse.content[0] as { text: string }).text ?? "").trim();
    if (!text) return fallback;
    const urls = knownUrls.filter((u): u is string => typeof u === "string" && u.length > 0);
    // Neutralize prompt-supplied URLs so the guard judges only model-authored ones.
    let judged = text;
    for (const u of urls) judged = judged.split(u).join(" ");
    if (caraOutputGuardEnabled() && !guardModelOutput(judged).ok) return fallback;
    // Restore any known URL the model left out — the delivered briefing must
    // always include its system link, same as the fallback lines do.
    for (const u of urls) if (!text.includes(u)) text = `${text}\n\n${u}`;
    return text;
  } catch {
    return fallback;
  }
}

// Family briefing: returns "" when the model output is empty or guard-rejected
// so the call site's existing catch → generateCaraMessage fallback takes over
// (raw rejected output is never delivered).
export async function generateFamilyBriefingText(briefingContent: string): Promise<string> {
  const resp = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 180,
    system:
      "You write a brief morning text for a family member whose loved one has a caregiver visit today.\n" +
      "Tone: warm, direct, practical — like a trusted care coordinator texting. No bullet points, no emoji.\n" +
      "Format: 2-3 sentences max. Start with caregiver arrival info. Add one specific care note if available.\n" +
      "Output only the message text.\n" +
      ANTI_INVENTION_CLAUSE,
    messages: [{ role: "user", content: briefingContent }],
  });
  const text = ((resp.content[0] as { text: string }).text ?? "").trim();
  if (text && caraOutputGuardEnabled() && !guardModelOutput(text).ok) return "";
  return text;
}

// Runs every day at 7am Pacific. With .timeZone() set, the cron string is
// interpreted IN that timezone — "0 12 * * *" here meant noon PT, not 12:00
// UTC, so "morning" briefings were landing midday, after visits had started.
export const sendMorningBriefings = functions.pubsub
  .schedule("0 7 * * *")
  .timeZone("America/Los_Angeles")
  .onRun(async () => {
    const today = businessTodayStr();

    // Find all confirmed visits for today (either pipeline)
    const docs = await queryVisits({
      dateOp: "==", dateValue: today,
      shiftStatuses: ["scheduled"],
    });

    for (const doc of docs) {
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
        const seniorName   = (senior?.seniorName as string | undefined) ?? visitSeniorName(appt, "your client");
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
          // mapsUrl is prompt-supplied — pass it as a known URL so the output
          // guard doesn't reject the model for echoing it (R3 targets invented
          // URLs only).
          content = await generateCaregiverBriefingContent(briefingPrompt, fallbackLines.join("\n\n"), [mapsUrl]);
        } catch {
          content = fallbackLines.join("\n\n");
        }

        // U8 engine gate (KTD15): optional discretionary source — this file has
        // THREE heterogeneous sends, each gated with its own dedupeKey prefix.
        // A lost pass re-enters naturally on the next scheduled (daily) run.
        const g = await gateOptionalSend({
          phone: caregiver.phone as string,
          candidate: {
            source: "morningBriefing",
            category: "re_engagement",
            urgency: 1,
            evidenceCount: 1,
            dedupeKey: `mbrief-cg:${caregiverId}:${today}`,
          },
        });
        if (!g.allowed) {
          console.info("morningBriefing.policy", { caregiverId, disposition: g.disposition, reason: g.reason });
          continue;
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
    await sendFamilyMorningBriefings(today, docs).catch(err =>
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

  // Get all caregivers with confirmed/completed visits this week (either pipeline)
  const visitDocs = await queryVisits({
    dateOp: ">=", dateValue: weekStartStr, dateUpperBound: today,
    shiftStatuses: ["scheduled", "completed", "in-progress"],
  });

  if (visitDocs.length === 0) return;

  // Sum hours by caregiver
  const hoursById: Record<string, { hours: number; name: string; phone?: string }> = {};
  for (const doc of visitDocs) {
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

      const workloadMsg = await generateCaraMessage({
        audience: "caregiver",
        context:
          `This caregiver is scheduled for ${Math.round(data.hours)} hours this week — that's a heavy load. ` +
          "Send them a warm, caring heads-up to pace themselves and take care of their own health. " +
          "Let them know they can reply SCHEDULE to see their week. Keep it brief and genuinely caring, not corporate.",
        fallback:
          `You're scheduled for ${Math.round(data.hours)} hours this week — that's a full load. ` +
          `Make sure you're taking care of yourself too. Reply SCHEDULE to see your week.`,
        maxTokens: 80,
      });

      // U8 engine gate (KTD15): weekly workload wellness message — keyed to the
      // week (matches its own lastWorkloadAlertWeek dedupe); a lost pass
      // re-enters on the next Monday run.
      const g = await gateOptionalSend({
        phone: cgPhone,
        candidate: {
          source: "morningBriefing",
          category: "re_engagement",
          urgency: 1,
          evidenceCount: 1,
          dedupeKey: `mbrief-workload:${cgId}:${weekStartStr}`,
        },
      });
      if (!g.allowed) {
        console.info("morningBriefing.policy", { caregiverId: cgId, disposition: g.disposition, reason: g.reason });
        continue;
      }

      await sendViaInteractionAgent(cgPhone, {
        content:     workloadMsg,
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

      // Respect DND from preferences. preferredSummaryTime is NOT checked
      // here: this cron runs once (7am PT) and can only suppress, never
      // reschedule — and getPreferences fills a default of "18:00", so gating
      // on it would silently drop the briefing for every default client. (The
      // old check also compared the server's UTC hour to the user's local
      // preference, which is how it appeared to work at the noon-PT run.)
      const prefs = await getPreferences(phone).catch(() => null);
      if (prefs && isInDND(prefs)) continue;

      // Avoid duplicate sends — check if we sent a family briefing today already
      const lastBriefingSnap = await db.collection("agent_alerts_log")
        .where("type",     "==", "family_morning_briefing")
        .where("clientId", "==", clientId)
        .where("sentAt",   ">=", today)
        .limit(1)
        .get();
      if (!lastBriefingSnap.empty) continue;

      const caregiverName = (cgSnap?.data()?.name ?? appt.caregiverName ?? "Your caregiver") as string;
      const seniorName    = (clientData.seniorName as string | undefined) ?? visitSeniorName(appt);
      const startTime     = (appt.startTime ?? "") as string;
      const schedule      = startTime ? `at ${startTime}` : "today";
      // R11 (hallucination hardening 2026-07-17): the reader is the account
      // holder; the visit is for the care recipient — ground who's who in BOTH
      // model calls (primary briefing + generateCaraMessage fallback).
      const whoIsWho = describeWhoIsWho({
        ...((session.onboardingData ?? {}) as Record<string, unknown>),
        seniorName: (session.onboardingData as any)?.seniorName ?? clientData.seniorName,
      });

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

        content = await generateFamilyBriefingText(
          (whoIsWho ? whoIsWho + "\n" : "") +
          `Senior: ${seniorName}\n` +
          `Caregiver: ${caregiverName} arriving ${schedule}\n` +
          factsLine + "\n" +
          memLine
        );
        if (!content) throw new Error("empty");
      } catch {
        // Fallback via generateCaraMessage
        const noteLine = topFacts.length > 0
          ? ` Keep in mind: ${topFacts[0].toLowerCase()}.`
          : "";
        content = await generateCaraMessage({
          audience: "family",
          context:
            (whoIsWho ? whoIsWho + " " : "") +
            `Write a brief morning text to a family member letting them know their caregiver is coming today. ` +
            `Caregiver: ${caregiverName}, arriving ${schedule}. Senior: ${seniorName}.` +
            (noteLine ? ` Care note: ${noteLine.trim()}` : ""),
          fallback: `Good morning! ${caregiverName} is scheduled to arrive ${schedule} for ${seniorName}.${noteLine}`,
          maxTokens: 80,
        });
      }

      // U8 engine gate (KTD15): family half of the briefing — distinct dedupe
      // prefix from the caregiver half. A lost pass re-enters on tomorrow's run.
      const g = await gateOptionalSend({
        phone,
        candidate: {
          source: "morningBriefing",
          category: "re_engagement",
          urgency: 1,
          evidenceCount: 1,
          dedupeKey: `mbrief-fam:${clientId}:${today}`,
        },
      });
      if (!g.allowed) {
        console.info("morningBriefing.policy", { clientId, disposition: g.disposition, reason: g.reason });
        continue;
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
