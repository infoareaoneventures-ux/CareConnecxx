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

// ── Data loaders ──────────────────────────────────────────────────────────────

async function getWeekData(seniorId: string, userId: string) {
  const now     = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const [journalSnap, pastApptSnap, upcomingSnap, seniorSnap, userSnap] = await Promise.all([
    db.collection("care_journal")
      .where("seniorId", "==", seniorId)
      .where("timestamp", ">=", weekAgo)
      .orderBy("timestamp", "desc")
      .limit(10)
      .get(),
    db.collection("appointments")
      .where("clientId", "==", userId)
      .where("isoDate", ">=", weekAgo)
      .where("isoDate", "<=", now.toISOString())
      .where("status", "==", "completed")
      .limit(10)
      .get(),
    db.collection("appointments")
      .where("clientId", "==", userId)
      .where("isoDate", ">", now.toISOString())
      .where("isoDate", "<=", weekAhead)
      .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
      .orderBy("isoDate", "asc")
      .limit(5)
      .get(),
    db.collection("senior_profiles").doc(seniorId).get(),
    db.collection("users").doc(userId).get(),
  ]);

  return {
    journal:    journalSnap.docs.map(d => d.data()),
    pastAppts:  pastApptSnap.docs.map(d => d.data()),
    upcoming:   upcomingSnap.docs.map(d => d.data()),
    seniorName: seniorSnap.data()?.name ?? "your loved one",
    clientName: userSnap.data()?.firstName ?? userSnap.data()?.name?.split(" ")[0] ?? "there",
  };
}

// ── Claude digest generation ──────────────────────────────────────────────────

async function generateDigest(data: Awaited<ReturnType<typeof getWeekData>>): Promise<string> {
  const { journal, pastAppts, upcoming, seniorName, clientName } = data;

  if (journal.length === 0 && pastAppts.length === 0) {
    return `Good morning ${clientName} ☀️ No visits were logged this week for ${seniorName}. If this seems wrong, please check the app or contact support.`;
  }

  const journalContext = journal.map(e => {
    const mood    = e.wellness?.mood ?? "unknown";
    const ateWell = e.wellness?.ateWell ? "ate well" : "appetite concerns";
    const meds    = e.wellness?.tookMeds ? "meds taken" : "meds missed";
    return `- ${(e.timestamp as string)?.slice(0, 10)}: mood ${mood}, ${ateWell}, ${meds}. Notes: ${(e.notes as string)?.slice(0, 150) ?? "none"}`;
  }).join("\n");

  const apptContext = upcoming.map(a =>
    `- ${a.date} at ${a.time} with ${a.caregiverName}`
  ).join("\n");

  const completedCount = pastAppts.length;
  const now = new Date();
  const dayName = now.toLocaleDateString("en-US", { weekday: "long" });

  const prompt = [
    `You're writing a warm Sunday morning care update text for ${clientName} about ${seniorName}.`,
    ``,
    `This week's data:`,
    `- ${completedCount} visit(s) completed`,
    `Journal entries:\n${journalContext || "None"}`,
    `Upcoming visits:\n${apptContext || "None scheduled"}`,
    ``,
    `Write a warm, personal weekly summary as a text message. Use simple emoji. Include:`,
    `1. A "Good morning" greeting with the day`,
    `2. Quick stats on visits completed`,
    `3. 2-3 notable observations from the journal (mood, appetite, activity)`,
    `4. Upcoming visits this week (date, time, caregiver)`,
    `5. One warm closing line`,
    ``,
    `Keep it under 300 words. Conversational, not clinical. No markdown, just plain text with line breaks.`,
  ].join("\n");

  try {
    const response = await getClient().messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 400,
      messages:   [{ role: "user", content: prompt }],
    });
    return ((response.content[0] as { text: string }).text ?? "").trim();
  } catch (err) {
    console.error("weeklyDigest Claude error:", err);
    return (
      `Good morning ${clientName} ☀️ Here's ${seniorName}'s week:\n\n` +
      `✅ ${completedCount} visit(s) completed\n\n` +
      (apptContext ? `Coming up:\n${apptContext}\n\n` : "") +
      `Have a wonderful ${dayName}.`
    );
  }
}

// ── Core logic (shared by scheduled + manual trigger) ────────────────────────

async function runWeeklyDigests(): Promise<number> {
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
      const data     = await getWeekData(seniorId, session.userId);
      const digest   = await generateDigest(data);

      if (session.chatId) {
        await sendMessage(session.chatId, digest);
      } else {
        await sendToPhone(phone, digest);
      }

      const today = new Date().toISOString().slice(0, 10);
      await db.collection("weekly_digests").doc(`${session.userId}_${today}`).set({
        clientId:  session.userId,
        seniorId,
        phone,
        sentAt:    new Date().toISOString(),
        digestLen: digest.length,
      });

      sent++;
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`weeklyDigest error for session ${sessionDoc.id}:`, err);
    }
  }

  console.log(`weeklyDigest: sent ${sent} digests`);
  return sent;
}

// ── Scheduled function — every Sunday at 8am ET ───────────────────────────────

export const sendWeeklyDigests = functions.pubsub
  .schedule("0 13 * * 0") // 8am ET = 13:00 UTC
  .timeZone("UTC")
  .onRun(() => runWeeklyDigests());

// ── Manual trigger for testing (admin only) ───────────────────────────────────

export const triggerWeeklyDigestNow = functions.https.onCall(async (_, context) => {
  if (!context.auth?.token.admin) {
    throw new functions.https.HttpsError("permission-denied", "Admin only");
  }
  const sent = await runWeeklyDigests();
  return { sent };
});
