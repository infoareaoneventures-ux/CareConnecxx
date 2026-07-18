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
import { guardModelOutput, ANTI_INVENTION_CLAUSE } from "../safety/outputGuard";
import { caraOutputGuardEnabled } from "../config/featureFlags";

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

// Exported for tests (U2 — anti-invention clause + output guard).
export async function generateDigest(data: Awaited<ReturnType<typeof getWeekData>>, userId: string): Promise<string> {
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

  // Deterministic digest — sent on API failure AND when the model output is
  // rejected by the output guard (U2, R2): raw meta-responses/URLs never ship.
  const fallbackDigest = () =>
    `Good morning ${clientName}. Here's ${seniorName}'s week:\n\n` +
    `${completedCount} visit(s) completed\n\n` +
    (apptContext ? `Coming up:\n${apptContext}\n\n` : "") +
    `Have a wonderful ${dayName}.`;

  try {
    const response = await getSharedClient().messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 400,
      // U2: the digest prompt arrives fully-formed via handlePromptGet as the
      // user message, so the anti-invention rule rides in the system slot.
      system:     ANTI_INVENTION_CLAUSE,
      messages:   [{ role: "user", content: prompt }],
    });
    const text = ((response.content[0] as { text: string }).text ?? "").trim();
    if (text && caraOutputGuardEnabled() && !guardModelOutput(text).ok) {
      return fallbackDigest();
    }
    return text;
  } catch (err) {
    console.error("weeklyDigest Claude error:", err);
    return fallbackDigest();
  }
}

// ── Caregiver earnings (shiftHours rail) ─────────────────────────────────────
// Successful visits bill through the shiftHours rail now; the legacy
// visit_payments collection is no longer written for them, so the weekly
// earnings summary reads shiftHours. A shift counts toward "this week's
// earnings" once the client has approved it — money that is on its way or
// already sent. pending_client_review is excluded: it is not yet confirmed.
export const EARNED_SHIFT_STATUSES: ReadonlySet<string> = new Set([
  "approved",
  "auto_approved",
  "paid",
]);

// Resolve a shift's gross caregiver pay in cents. The rails disagree on field
// names: in-app submitShiftHours writes grossPay (dollars); the Evia MCP and
// care-notes rails write amountCents. Mirror processShiftPayment's resolution
// and never return a non-finite or negative value.
export function shiftGrossCents(shift: any): number {
  const cents =
    typeof shift?.grossPay === "number"      ? shift.grossPay * 100
    : typeof shift?.amountCents === "number" ? shift.amountCents
    : Number(shift?.finalTotalHours ?? shift?.submittedTotalHours ?? 0) *
      Number(shift?.payRate ?? shift?.hourlyRate ?? 0) * 100;
  return Number.isFinite(cents) && cents > 0 ? Math.round(cents) : 0;
}

// True when an earned shift falls in the digest window. submittedAt is written
// by every rail; createdAt is a fallback. ISO strings compare lexicographically.
export function isShiftEarnedSince(shift: any, sinceIso: string): boolean {
  if (!EARNED_SHIFT_STATUSES.has(shift?.status)) return false;
  const ts = (shift?.submittedAt ?? shift?.createdAt ?? "") as string;
  return ts >= sinceIso;
}

// ── Core logic (shared by scheduled + manual trigger) ────────────────────────

// Process work in bounded-concurrency batches instead of one-at-a-time. The old
// sequential loop (one user per iteration, each awaiting a Claude call + several
// Firestore reads + a 200ms sleep) grows linearly and breaches the Cloud
// Function deadline at a few hundred users. Returns the count of items that the
// callback reported as sent (true). Per-item failures are isolated by the
// callback's own try/catch and counted as not-sent.
const DIGEST_BATCH_SIZE = 15;

async function runInBatches<T>(items: T[], size: number, fn: (item: T) => Promise<boolean>): Promise<number> {
  let sent = 0;
  for (let i = 0; i < items.length; i += size) {
    const results = await Promise.allSettled(items.slice(i, i + size).map(fn));
    sent += results.filter(r => r.status === "fulfilled" && r.value === true).length;
  }
  return sent;
}

// Send one client's weekly care digest. Returns true when a digest was sent.
async function sendClientDigest(sessionDoc: any, today: string): Promise<boolean> {
  const session = sessionDoc.data() as AgentSession;
  if (!session.userId || session.optedIn === false) return false;

  const phone = sessionDoc.id;
  const perms = await getPermissions(session.userId).catch(() => null);
  if (perms !== null && perms.canSendWeeklyDigest === false) return false;

  const seniorId = session.seniorId ?? session.userId;
  const data     = await getWeekData(seniorId, session.userId);
  const digest   = await generateDigest(data, session.userId);

  await sendViaInteractionAgent(phone, {
    content:     digest,
    urgency:     "standard",
    sourceAgent: "weekly_digest",
    canDrop:     true,
  });

  await db.collection("weekly_digests").doc(`${session.userId}_${today}`).set({
    clientId:  session.userId,
    seniorId,
    phone,
    sentAt:    new Date().toISOString(),
    digestLen: digest.length,
  });
  return true;
}

export async function runWeeklyDigests(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);

  const sessionsSnap = await db
    .collection("agent_sessions")
    .where("optedOut", "==", false)
    .get();

  const sent = await runInBatches(sessionsSnap.docs, DIGEST_BATCH_SIZE, (doc) =>
    sendClientDigest(doc, today).catch((err) => {
      console.error(`weeklyDigest error for session ${doc.id}:`, err);
      return false;
    }),
  );

  // ── Caregiver earnings summaries ─────────────────────────────────────────────
  const cgSessionsSnap = await db
    .collection("agent_sessions")
    .where("userType",  "==", "caregiver")
    .where("optedOut",  "==", false)
    .get();

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const cgSent = await runInBatches(cgSessionsSnap.docs, DIGEST_BATCH_SIZE, (doc) =>
    sendCaregiverEarnings(doc, weekAgo, today).catch((err) => {
      console.error(`caregiver earnings digest error for ${doc.id}:`, err);
      return false;
    }),
  );

  const total = sent + cgSent;
  console.log(`weeklyDigest: sent ${total} digests (${sent} client, ${cgSent} caregiver)`);
  return total;
}

// Send one caregiver's weekly earnings summary. Returns true when sent.
async function sendCaregiverEarnings(cgDoc: any, weekAgo: string, today: string): Promise<boolean> {
  const cgSession = cgDoc.data();
  if (!cgSession.caregiverId || cgSession.optedIn === false) return false;

  const cgPhone = cgDoc.id;
  // Successful visits bill through shiftHours now (visit_payments is retired
  // for them). Query by caregiver only — no composite index required — then
  // filter to "earned this week" in memory via the shared helpers.
  const shiftSnap = await db
    .collection("shiftHours")
    .where("caregiverId", "==", cgSession.caregiverId)
    .get();

  const visits = shiftSnap.docs
    .map(d => d.data())
    .filter(v => isShiftEarnedSince(v, weekAgo));

  if (visits.length === 0) return false;

  const totalCents = visits.reduce((s, v) => s + shiftGrossCents(v), 0);
  const totalStr = `$${(totalCents / 100).toFixed(2)}`;
  const cgSnap   = await db.collection("caregivers").doc(cgSession.caregiverId).get();
  const cgName   = (cgSnap.data()?.name as string | undefined)?.split(" ")[0] ?? "there";

  const visitLines = visits.slice(0, 5).map(v =>
    `· ${v.date ?? (v.submittedAt as string | undefined)?.slice(0, 10) ?? "this week"} — $${(shiftGrossCents(v) / 100).toFixed(2)}`
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
  return true;
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
