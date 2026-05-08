import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import { sendMessage, sendToPhone, AgentSession } from "../linq/client";

const db = admin.firestore();

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface HealthTrend {
  seniorId:   string;
  clientId:   string;
  period:     string;
  trends:     string[];
  flags:      string[];
  highlights: string;
  generatedAt: string;
  shareToken:  string;
}

// ── Data loader — 90 days of journal entries ──────────────────────────────────

async function load90Days(seniorId: string, userId: string) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const [journalSnap, apptSnap, seniorSnap] = await Promise.all([
    db.collection("care_journal")
      .where("seniorId", "==", seniorId)
      .where("timestamp", ">=", ninetyDaysAgo)
      .orderBy("timestamp", "asc")
      .limit(100)
      .get(),
    db.collection("appointments")
      .where("clientId", "==", userId)
      .where("isoDate", ">=", ninetyDaysAgo.slice(0, 10))
      .limit(100)
      .get(),
    db.collection("senior_profiles").doc(seniorId).get(),
  ]);

  return {
    journal:    journalSnap.docs.map(d => d.data()),
    appts:      apptSnap.docs.map(d => d.data()),
    seniorName: seniorSnap.data()?.name ?? "Senior",
    seniorNeeds: seniorSnap.data()?.needs ?? [],
  };
}

// ── Claude trend analysis ─────────────────────────────────────────────────────

async function analyzeTrends(
  data: Awaited<ReturnType<typeof load90Days>>
): Promise<{ trends: string[]; flags: string[]; highlights: string }> {
  const { journal, appts, seniorName } = data;

  const completedAppts  = appts.filter(a => a.status === "completed").length;
  const cancelledAppts  = appts.filter(a => a.status === "cancelled").length;

  // Aggregate wellness data
  const moodCounts: Record<string, number> = {};
  let ateWellCount = 0, tookMedsCount = 0, wasActiveCount = 0;

  for (const e of journal) {
    const mood = e.wellness?.mood;
    if (mood) moodCounts[mood] = (moodCounts[mood] ?? 0) + 1;
    if (e.wellness?.ateWell)   ateWellCount++;
    if (e.wellness?.tookMeds)  tookMedsCount++;
    if (e.wellness?.wasActive) wasActiveCount++;
  }

  const total = journal.length || 1;
  const allNotes = journal
    .map(e => e.notes)
    .filter(Boolean)
    .join(" | ")
    .slice(0, 3000);

  const prompt = [
    `You are analyzing 90 days of care data for ${seniorName}.`,
    ``,
    `Stats:`,
    `- ${journal.length} journal entries recorded`,
    `- ${completedAppts} of ${completedAppts + cancelledAppts} appointments completed`,
    `- Ate well: ${Math.round(ateWellCount / total * 100)}% of visits`,
    `- Medications taken: ${Math.round(tookMedsCount / total * 100)}% of visits`,
    `- Physically active: ${Math.round(wasActiveCount / total * 100)}% of visits`,
    `- Mood distribution: ${JSON.stringify(moodCounts)}`,
    ``,
    `Caregiver notes (last 90 days):`,
    allNotes || "No notes recorded",
    ``,
    `Respond with valid JSON only, no markdown:`,
    `{`,
    `  "trends": ["3-5 observed trends over the 90 days"],`,
    `  "flags": ["0-3 concerns worth discussing with a doctor, empty if none"],`,
    `  "highlights": "2-3 sentence warm summary a family could share with a physician"`,
    `}`,
  ].join("\n");

  try {
    const response = await getClient().messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 500,
      messages:   [{ role: "user", content: prompt }],
    });
    const raw = ((response.content[0] as { text: string }).text ?? "").trim();
    return JSON.parse(raw);
  } catch (err) {
    console.error("healthTrends Claude error:", err);
    return {
      trends:     [`${completedAppts} appointments completed over 90 days`],
      flags:      [],
      highlights: `${seniorName} received consistent care over the past 90 days.`,
    };
  }
}

// ── Scheduled function — 1st of each month at 9am ET ────────────────────────

// ── Core logic (shared by scheduled + manual trigger) ────────────────────────

async function runMonthlyHealthTrends(): Promise<number> {
  const sessionsSnap = await db
    .collection("agent_sessions")
    .where("optedOut", "==", false)
    .get();

  let sent = 0;

  for (const sessionDoc of sessionsSnap.docs) {
    const session = sessionDoc.data() as AgentSession;
    if (!session.userId || session.optedIn === false) continue;

    try {
      const phone    = sessionDoc.id;
      const seniorId = session.seniorId ?? session.userId;
      const data     = await load90Days(seniorId, session.userId);

      if (data.journal.length < 3) continue;

      const analysis   = await analyzeTrends(data);
      const shareToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const period     = new Date().toISOString().slice(0, 7);

      const trend: HealthTrend = {
        seniorId,
        clientId:    session.userId,
        period,
        trends:      analysis.trends,
        flags:       analysis.flags,
        highlights:  analysis.highlights,
        generatedAt: new Date().toISOString(),
        shareToken,
      };

      await db.collection("health_trends").doc(`${seniorId}_${period}`).set(trend);

      const appUrl     = process.env.APP_URL ?? "https://app.careconnecxx.com";
      const summaryUrl = `${appUrl}/health-summary/${shareToken}`;
      const monthName  = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });

      const linkMessage = { parts: [{ type: "link" as const, value: summaryUrl }] };

      if (session.chatId) {
        await sendMessage(session.chatId, linkMessage);
        await sendMessage(
          session.chatId,
          `Here's ${data.seniorName}'s ${monthName} health summary — 90 days of care data.\n` +
          `You can share this directly with their doctor or print it from that page.\n\n` +
          (analysis.highlights ? `This month: ${analysis.highlights}` : "")
        );
      } else {
        await sendToPhone(phone, `${data.seniorName}'s ${monthName} health summary is ready: ${summaryUrl}`);
      }

      sent++;
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`healthTrends error for session ${sessionDoc.id}:`, err);
    }
  }

  console.log(`healthTrends: sent ${sent} reports`);
  return sent;
}

// ── Scheduled function — 1st of each month at 9am ET ────────────────────────

export const sendMonthlyHealthTrends = functions.pubsub
  .schedule("0 14 1 * *") // 9am ET = 14:00 UTC
  .timeZone("UTC")
  .onRun(() => runMonthlyHealthTrends());

// ── Manual trigger for testing (admin only) ───────────────────────────────────

export const triggerHealthTrendsNow = functions.https.onCall(async (_, context) => {
  if (!context.auth?.token.admin) {
    throw new functions.https.HttpsError("permission-denied", "Admin only");
  }
  const sent = await runMonthlyHealthTrends();
  return { sent };
});
