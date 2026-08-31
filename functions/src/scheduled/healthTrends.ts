import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { getSharedClient } from "../utils/claudeClient";
import { sendMessage, sendToPhone, AgentSession } from "../linq/client";
import { getAppUrl } from "../config/appUrl";
import { rollupCareSignals, describeSignalRate } from "../agents/careEvidence";
import { getPermissions } from "../agents/permissionsConversation";

const db = admin.firestore();

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
  expiresAt:   string;   // ISO — token is invalid after this date
}

// ── Data loader — 90 days of journal entries ──────────────────────────────────

async function load90Days(seniorId: string, userId: string) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // appointments uses `isoDate` (full ISO string); shifts (2026-08-30 pipeline)
  // has no such field, only a plain `date` (YYYY-MM-DD) — both are compared
  // against the same date-only cutoff, so the two queries stay separate rather
  // than going through queryVisitsMerged (which assumes one shared field name).
  const [journalSnap, apptSnap, shiftSnap, seniorSnap] = await Promise.all([
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
    db.collection("shifts")
      .where("clientId", "==", userId)
      .where("date", ">=", ninetyDaysAgo.slice(0, 10))
      .limit(100)
      .get(),
    db.collection("senior_profiles").doc(seniorId).get(),
  ]);

  return {
    journal:    journalSnap.docs.map(d => d.data()),
    appts:      [...apptSnap.docs, ...shiftSnap.docs].map(d => d.data()),
    seniorName: seniorSnap.data()?.name ?? "Senior",
    seniorNeeds: seniorSnap.data()?.needs ?? [],
  };
}

// ── Claude trend analysis ─────────────────────────────────────────────────────

// Wellness stat lines with known-only denominators and explicit coverage
// (U1/R2/AE1): a journal entry that omitted a field is reported as unrecorded,
// never counted as a miss. Below MIN_KNOWN_FOR_RATE known observations the
// line says so instead of stating a rate. Exported for tests.
export function buildWellnessStatLines(journal: Array<Record<string, unknown>>): string[] {
  const fields = [
    { field: "ateWell" as const,   label: "Ate well" },
    { field: "tookMeds" as const,  label: "Medications taken" },
    { field: "wasActive" as const, label: "Physically active" },
  ];
  return fields.map(({ field, label }) => {
    const rate = describeSignalRate(rollupCareSignals(journal, field));
    return rate
      ? `- ${label}: ${rate}`
      : `- ${label}: not recorded often enough to report a rate (do not treat this as a concern)`;
  });
}

async function analyzeTrends(
  data: Awaited<ReturnType<typeof load90Days>>
): Promise<{ trends: string[]; flags: string[]; highlights: string }> {
  const { journal, appts, seniorName } = data;

  const completedAppts  = appts.filter(a => a.status === "completed").length;
  const cancelledAppts  = appts.filter(a => a.status === "cancelled").length;

  const moodCounts: Record<string, number> = {};
  for (const e of journal) {
    const mood = e.wellness?.mood;
    if (mood) moodCounts[mood] = (moodCounts[mood] ?? 0) + 1;
  }

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
    ...buildWellnessStatLines(journal),
    `- Mood distribution (from entries that recorded mood): ${JSON.stringify(moodCounts)}`,
    ``,
    `Rules: rates above cover only visits where the field was recorded. Unrecorded fields are UNKNOWN — never describe them as missed medications, poor appetite, or inactivity, and never flag a concern from missing data alone.`,
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
    const response = await getSharedClient().messages.create({
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

      // U8 manifest audit 2026-07-22: this health report is permission-gated
      // like the weekly digest — the flag is user-controllable in natural
      // language ("health alerts") and this check was MISSING here.
      const perms = await getPermissions(session.userId).catch(() => null);
      if (perms !== null && perms.canSendHealthAlerts === false) continue;

      const period = new Date().toISOString().slice(0, 7);

      // Send-dedupe (same audit): the deterministic doc id was written but
      // never READ, so a double-run (cron overlap or manual trigger after the
      // cron) double-sent the report. One report per senior per month.
      const existing = await db.collection("health_trends").doc(`${seniorId}_${period}`).get();
      if (existing.exists) continue;

      const data = await load90Days(seniorId, session.userId);

      if (data.journal.length < 3) continue;

      const analysis   = await analyzeTrends(data);
      const shareToken = crypto.randomBytes(16).toString("base64url");

      const now        = new Date();
      const expiresAt  = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();

      const trend: HealthTrend = {
        seniorId,
        clientId:    session.userId,
        period,
        trends:      analysis.trends,
        flags:       analysis.flags,
        highlights:  analysis.highlights,
        generatedAt: now.toISOString(),
        shareToken,
        expiresAt,
      };

      await db.collection("health_trends").doc(`${seniorId}_${period}`).set(trend);

      // Write a lookup document keyed by shareToken so the React page can fetch by URL
      await db.collection("health_summaries").doc(shareToken).set({
        ...trend,
        seniorName: data.seniorName,
      });

      const appUrl     = getAppUrl();
      const summaryUrl = `${appUrl}/health-summary/${shareToken}`;
      const monthName  = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });

      // /health-summary/{token} is an app route with no OG rewrite, so the
      // transport downgrades a link part to inline text (card would be blank).
      // Send the explanation FIRST so the URL bubble never arrives contextless.
      const linkMessage = { parts: [{ type: "link" as const, value: summaryUrl }] };

      if (session.chatId) {
        await sendMessage(
          session.chatId,
          `Here's ${data.seniorName}'s ${monthName} health summary — 90 days of care data.\n` +
          `You can share this directly with their doctor or print it from that page.\n\n` +
          (analysis.highlights ? `This month: ${analysis.highlights}` : "")
        );
        await sendMessage(session.chatId, linkMessage);
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
