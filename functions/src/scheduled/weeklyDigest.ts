import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { AgentSession } from "../linq/client";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { getPermissions } from "../agents/permissionsConversation";
import { handlePromptGet } from "../mcp/server";
import { getMemoryContext } from "../memory/memoryFiles";
import { getRelevantFacts } from "../memory/learnedFacts";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

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

async function generateDigest(data: Awaited<ReturnType<typeof getWeekData>>, userId: string): Promise<string> {
  const { journal, pastAppts, upcoming, seniorName, clientName } = data;

  const [memCtx, facts] = await Promise.all([
    getMemoryContext(userId).catch(() => ""),
    getRelevantFacts(userId).catch(() => [] as { fact: string; category: string }[]),
  ]);

  const topFacts = facts
    .filter((f) => f.category === "medical" || f.category === "preference")
    .slice(0, 3)
    .map((f) => f.fact);

  if (journal.length === 0 && pastAppts.length === 0) {
    return `Good morning ${clientName}. No visits were logged this week for ${seniorName}. If this seems wrong, please check the app or contact support.`;
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

  const factsLine = topFacts.length > 0
    ? `Care notes on file: ${topFacts.join("; ")}.`
    : "";
  const memLine = memCtx ? memCtx.slice(0, 400) : "";

  const prompt = handlePromptGet("weekly-care-summary", {
    clientName,
    seniorName,
    completedCount: String(completedCount),
    journalContext: journalContext || "None",
    apptContext:    apptContext    || "Nothing scheduled yet",
    careNotes:      factsLine,
    memoryContext:  memLine,
  });

  try {
    const response = await getSharedClient().messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 400,
      messages:   [{ role: "user", content: prompt }],
    });
    return ((response.content[0] as { text: string }).text ?? "").trim();
  } catch (err) {
    console.error("weeklyDigest Claude error:", err);
    return (
      `Good morning ${clientName}. Here's ${seniorName}'s week:\n\n` +
      `${completedCount} visit(s) completed\n\n` +
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

      // Check permission before sending
      const perms = await getPermissions(session.userId).catch(() => null);
      if (perms !== null && perms.canSendWeeklyDigest === false) continue;

      const seniorId = session.seniorId ?? session.userId;
      const data     = await getWeekData(seniorId, session.userId);
      const digest   = await generateDigest(data, session.userId);

      await sendViaInteractionAgent(phone, {
        content:     digest,
        urgency:     "standard",
        sourceAgent: "weekly_digest",
        canDrop:     true,
      });

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

  // ── Caregiver earnings summaries ─────────────────────────────────────────────
  const cgSessionsSnap = await db
    .collection("agent_sessions")
    .where("userType",  "==", "caregiver")
    .where("optedOut",  "==", false)
    .get();

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const today   = new Date().toISOString().slice(0, 10);

  for (const cgDoc of cgSessionsSnap.docs) {
    const cgSession = cgDoc.data();
    if (!cgSession.caregiverId || cgSession.optedIn === false) continue;

    try {
      const cgPhone = cgDoc.id;
      const paySnap = await db
        .collection("visit_payments")
        .where("caregiverId", "==", cgSession.caregiverId)
        .where("createdAt",   ">=", weekAgo)
        .where("status",      "in", ["pending", "paid"])
        .get();

      if (paySnap.empty) continue;

      const visits   = paySnap.docs.map(d => d.data());
      const totalCents = visits.reduce((s, v) => s + (v.amountCents ?? 0), 0);
      const totalStr = `$${(totalCents / 100).toFixed(2)}`;
      const cgSnap   = await db.collection("caregivers").doc(cgSession.caregiverId).get();
      const cgName   = (cgSnap.data()?.name as string | undefined)?.split(" ")[0] ?? "there";

      const visitLines = visits.slice(0, 5).map(v =>
        `· ${v.date ?? "this week"} — $${((v.amountCents ?? 0) / 100).toFixed(2)}`
      ).join("\n");

      const earningsMsg = await generateCaraMessage({
        audience: "caregiver",
        context:
          `Caregiver first name: ${cgName}. ` +
          `This week's earnings summary: ${visits.length} visit${visits.length !== 1 ? "s" : ""}, ${totalStr} total, on its way. ` +
          `Visit breakdown:\n${visitLines}\n` +
          "Write a warm morning earnings summary. Express genuine appreciation for the work they do for these families. " +
          "Mention that payments hit within 2 business days.",
        fallback:
          `Morning ${cgName}. ${visits.length} visit${visits.length !== 1 ? "s" : ""} this week, ${totalStr} on its way to you.\n\n` +
          `${visitLines}\n\n` +
          `That's real work. Thank you for taking care of these families.\n\n` +
          `Payments hit within 2 business days.`,
      });

      await sendViaInteractionAgent(cgPhone, {
        content:     earningsMsg,
        urgency:     "standard",
        sourceAgent: "weekly_digest",
        canDrop:     true,
      });

      await db.collection("weekly_digests").doc(`cg_${cgSession.caregiverId}_${today}`).set({
        caregiverId: cgSession.caregiverId,
        phone:       cgPhone,
        sentAt:      new Date().toISOString(),
        totalCents,
        visitCount:  visits.length,
      });

      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`caregiver earnings digest error for ${cgDoc.id}:`, err);
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
