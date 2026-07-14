import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { quickComplete } from "../utils/openaiClient";

// Proactive Reflection — v1 (admin-review-first)
//
// Every hour, Evia reads the last 24h of journal entries, completed visits,
// upcoming visits, and billing events for each opted-in family, runs a single
// gpt-4o-mini pass over the aggregated context, and asks: "Is there anything
// Evia should surface to the family right now that they haven't already
// asked about?"
//
// The model can answer either with a structured draft or with NOOP. Drafts are
// written to `proactive_drafts` with status="pending_review" — we do NOT send
// them. The 2-week admin-review-first phase from the roadmap is enforced at
// the storage layer; a separate (future) approval tool flips them to
// "approved" and a downstream sender consumes those. This file delivers the
// detection half of the loop; sending lives elsewhere.
//
// Design choices:
//   - gpt-4o-mini only (single-shot, cheap; ~$0.15/1M input). Hourly across a
//     few hundred families is well under $1/day.
//   - Per-family lookback is fixed at 24h. Reflection runs hourly so a signal
//     that develops over 6h has 24 chances to be surfaced — we don't need a
//     longer window in the prompt.
//   - Strict NOOP / JSON output. Anything that doesn't parse is dropped
//     silently (no draft); we'd rather miss a turn than write garbage to the
//     review queue.
//   - Idempotency: we hash the aggregated context per (userId, hour) and skip
//     when the same hash already produced a draft in the last 6h. Prevents
//     re-flagging the same situation hour after hour.

const db = admin.firestore();

const LOOKBACK_MS    = 24 * 60 * 60 * 1000;
const DEDUPE_TTL_MS  =  6 * 60 * 60 * 1000;
const MAX_FAMILIES_PER_RUN = 250;

type DraftSeverity = "low" | "medium" | "high";

export interface ReflectionDraft {
  userId:       string;
  phone:        string;
  draftText:    string;
  reason:       string;
  severity:     DraftSeverity;
  contextHash:  string;
  status:       "pending_review";
  createdAt:    string;
  inputs: {
    journalCount:  number;
    pastApptCount: number;
    upcomingCount: number;
    billingCount:  number;
  };
}

interface FamilySnapshot {
  journal:  Array<Record<string, unknown>>;
  past:     Array<Record<string, unknown>>;
  upcoming: Array<Record<string, unknown>>;
  billing:  Array<Record<string, unknown>>;
  seniorName: string;
  clientName: string;
}

async function loadFamilySnapshot(userId: string, seniorId: string): Promise<FamilySnapshot> {
  const now      = new Date();
  const since    = new Date(now.getTime() - LOOKBACK_MS).toISOString();
  const ahead    = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const [journalSnap, pastSnap, upcomingSnap, billingSnap, seniorSnap, userSnap] = await Promise.all([
    db.collection("care_journal")
      .where("seniorId", "==", seniorId)
      .where("timestamp", ">=", since)
      .orderBy("timestamp", "desc")
      .limit(20).get(),
    db.collection("appointments")
      .where("clientId", "==", userId)
      .where("isoDate", ">=", since)
      .where("isoDate", "<=", now.toISOString())
      .where("status", "==", "completed")
      .limit(20).get(),
    db.collection("appointments")
      .where("clientId", "==", userId)
      .where("isoDate", ">", now.toISOString())
      .where("isoDate", "<=", ahead)
      .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
      .orderBy("isoDate", "asc").limit(10).get(),
    db.collection("billing_events")
      .where("userId", "==", userId)
      .where("createdAt", ">=", since)
      .orderBy("createdAt", "desc").limit(10).get().catch(() => null),
    db.collection("senior_profiles").doc(seniorId).get(),
    db.collection("users").doc(userId).get(),
  ]);

  return {
    journal:    journalSnap.docs.map(d => d.data()),
    past:       pastSnap.docs.map(d => d.data()),
    upcoming:   upcomingSnap.docs.map(d => d.data()),
    billing:    billingSnap ? billingSnap.docs.map(d => d.data()) : [],
    seniorName: (seniorSnap.data()?.name as string | undefined) ?? "your loved one",
    clientName: (userSnap.data()?.firstName as string | undefined)
              ?? (userSnap.data()?.name as string | undefined)?.split(" ")[0]
              ?? "there",
  };
}

// Compact textual rollup the LLM reads. Kept short to keep token cost low and
// to force the model to attend to specific signals rather than scan noise.
export function buildReflectionPrompt(snap: FamilySnapshot): string {
  const journalLines = snap.journal.slice(0, 8).map(e => {
    const ts   = (e.timestamp as string | undefined)?.slice(0, 10) ?? "?";
    const mood = (e.wellness as Record<string, unknown> | undefined)?.mood ?? "?";
    const ate  = (e.wellness as Record<string, unknown> | undefined)?.ateWell ? "ate well" : "appetite low";
    const meds = (e.wellness as Record<string, unknown> | undefined)?.tookMeds ? "meds taken" : "meds missed";
    const notes = ((e.notes as string | undefined) ?? "").slice(0, 120);
    return `  - ${ts} mood=${mood} ${ate} ${meds}${notes ? ` :: ${notes}` : ""}`;
  }).join("\n");

  const pastLines = snap.past.slice(0, 6).map(a =>
    `  - ${a.date ?? a.isoDate ?? "?"} with ${a.caregiverName ?? "caregiver"}`,
  ).join("\n");

  const upcomingLines = snap.upcoming.slice(0, 5).map(a =>
    `  - ${a.date ?? a.isoDate ?? "?"} at ${a.time ?? "?"} with ${a.caregiverName ?? "caregiver"} (${a.status ?? "?"})`,
  ).join("\n");

  const billingLines = snap.billing.slice(0, 5).map(b =>
    `  - ${b.type ?? "event"} ${b.amount ? `$${b.amount}` : ""} ${b.status ?? ""}`,
  ).join("\n");

  return [
    `Family: ${snap.clientName} (client), caring for ${snap.seniorName}.`,
    "",
    "RECENT CARE JOURNAL (last 24h):",
    journalLines || "  (no entries)",
    "",
    "COMPLETED VISITS (last 24h):",
    pastLines || "  (none)",
    "",
    "UPCOMING VISITS (next 7 days):",
    upcomingLines || "  (none scheduled)",
    "",
    "RECENT BILLING EVENTS:",
    billingLines || "  (none)",
  ].join("\n");
}

const REFLECTION_SYSTEM = `You are Evia's quiet observer. Read the family's last 24h of care data and decide whether there is something worth Evia proactively reaching out about RIGHT NOW that the family hasn't already asked.

Strong reasons to surface:
  • Pattern across multiple journal entries (3+ days of missed meds, appetite dropping, mood declining).
  • Caregiver no-show or repeated lateness.
  • An upcoming visit at risk (caregiver hasn't confirmed, gap on a day the family relies on).
  • A billing anomaly the family will see on a credit card before Evia explains it.
  • A milestone or anniversary worth a warm note.
  • A safety concern visible in the journal that hasn't been flagged.

Reasons NOT to surface:
  • A single normal entry. One bad day is not a pattern.
  • A scheduled visit that's fine.
  • A routine billing event with no surprise.
  • Anything the family was clearly already aware of (mentioned by name in journal).
  • Boredom — if nothing is meaningfully wrong or right, say nothing.

OUTPUT FORMAT: exactly one JSON object on a single line, no prose around it, no code fences.

If nothing is worth surfacing:
{"action":"noop"}

If something is worth surfacing:
{"action":"draft","draftText":"<the actual SMS Evia would send, in her voice — warm, short, names the specific thing>","reason":"<one sentence: what pattern you detected>","severity":"low|medium|high"}

Severity guide:
  • high   = safety / health concern that needs the family to act today
  • medium = something they'll want to know within a day but isn't urgent
  • low    = warmth / milestone / pre-warning before a billing event hits

Be conservative. Drafts go to a human review queue, but bad drafts still cost reviewer attention.`;

interface ReflectionResult {
  action: "noop" | "draft";
  draftText?: string;
  reason?:    string;
  severity?:  DraftSeverity;
}

export function parseReflectionOutput(raw: string): ReflectionResult | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (obj.action === "noop") return { action: "noop" };
    if (obj.action !== "draft") return null;

    const draftText = typeof obj.draftText === "string" ? obj.draftText.trim() : "";
    const reason    = typeof obj.reason    === "string" ? obj.reason.trim()    : "";
    const severity  = obj.severity === "low" || obj.severity === "medium" || obj.severity === "high"
      ? obj.severity
      : "medium";

    if (!draftText || !reason) return null;
    if (draftText.length > 320) return null; // SMS-shaped; longer is a bug

    return { action: "draft", draftText, reason, severity };
  } catch {
    return null;
  }
}

// Stable hash for dedupe. Doesn't need to be cryptographic — we just want
// "did we already process this same situation in the last few hours."
export function hashContext(prompt: string): string {
  let h = 5381;
  for (let i = 0; i < prompt.length; i++) {
    h = ((h << 5) + h + prompt.charCodeAt(i)) & 0x7fffffff;
  }
  return h.toString(16);
}

async function recentDraftExists(userId: string, contextHash: string): Promise<boolean> {
  const since = new Date(Date.now() - DEDUPE_TTL_MS).toISOString();
  const snap = await db.collection("proactive_drafts")
    .where("userId", "==", userId)
    .where("contextHash", "==", contextHash)
    .where("createdAt", ">=", since)
    .limit(1).get();
  return !snap.empty;
}

async function reflectForFamily(opts: {
  phone:    string;
  userId:   string;
  seniorId: string;
}): Promise<"noop" | "skipped" | "drafted" | "error"> {
  try {
    const snap   = await loadFamilySnapshot(opts.userId, opts.seniorId);
    // Skip families with zero activity in the window — nothing to reflect on.
    if (snap.journal.length === 0 && snap.past.length === 0 &&
        snap.upcoming.length === 0 && snap.billing.length === 0) {
      return "noop";
    }

    const prompt = buildReflectionPrompt(snap);
    const contextHash = hashContext(prompt);

    if (await recentDraftExists(opts.userId, contextHash)) return "skipped";

    const raw = await quickComplete(REFLECTION_SYSTEM, prompt, { maxTokens: 300 });
    const parsed = parseReflectionOutput(raw);
    if (!parsed || parsed.action === "noop") return "noop";

    const draft: ReflectionDraft = {
      userId:      opts.userId,
      phone:       opts.phone,
      draftText:   parsed.draftText!,
      reason:      parsed.reason!,
      severity:    parsed.severity!,
      contextHash,
      status:      "pending_review",
      createdAt:   new Date().toISOString(),
      inputs: {
        journalCount:  snap.journal.length,
        pastApptCount: snap.past.length,
        upcomingCount: snap.upcoming.length,
        billingCount:  snap.billing.length,
      },
    };

    await db.collection("proactive_drafts").add(draft);
    return "drafted";
  } catch (err) {
    console.error("proactiveReflection: family failed", opts.userId, err);
    return "error";
  }
}

async function runReflectionPass(): Promise<{ scanned: number; drafted: number; noop: number; skipped: number; errored: number }> {
  const sessionsSnap = await db.collection("agent_sessions")
    .where("optedOut", "==", false)
    .where("userType", "==", "client")
    .limit(MAX_FAMILIES_PER_RUN)
    .get();

  const stats = { scanned: 0, drafted: 0, noop: 0, skipped: 0, errored: 0 };

  for (const doc of sessionsSnap.docs) {
    const session = doc.data() as Record<string, unknown>;
    const userId   = session.userId   as string | undefined;
    const seniorId = (session.seniorId as string | undefined) ?? userId;
    if (!userId || !seniorId) continue;
    if (session.optedIn === false) continue;

    stats.scanned++;
    const outcome = await reflectForFamily({ phone: doc.id, userId, seniorId });
    if (outcome === "drafted") stats.drafted++;
    else if (outcome === "skipped") stats.skipped++;
    else if (outcome === "error")   stats.errored++;
    else stats.noop++;

    // Light pacing — we're hitting Firestore + OpenAI per family; 100ms is
    // enough to spread the burst out and stay under any per-second quotas.
    await new Promise(r => setTimeout(r, 100));
  }

  console.info("proactiveReflection.pass", stats);
  return stats;
}

// Hourly schedule. The pass itself self-limits to MAX_FAMILIES_PER_RUN; if we
// outgrow that, partition by phone hash across multiple staggered hourly jobs.
export const runProactiveReflection = functions.pubsub
  .schedule("0 * * * *")
  .timeZone("UTC")
  .onRun(() => runReflectionPass());

// Admin-only manual trigger for development + the 2-week review-first phase.
export const triggerProactiveReflectionNow = functions.https.onCall(async (_, context) => {
  if (!context.auth?.token.admin) {
    throw new functions.https.HttpsError("permission-denied", "Admin only");
  }
  return runReflectionPass();
});

// Exported for tests.
export const _internal = { reflectForFamily, runReflectionPass };
