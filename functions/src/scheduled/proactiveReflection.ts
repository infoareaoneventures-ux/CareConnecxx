import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { quickComplete } from "../utils/openaiClient";
import { parseWellness, describeWellness } from "../agents/careEvidence";
import { deriveCareInsights, concerningInsights } from "../agents/careInsights";
import { decideForRecipient } from "./proactiveDecisionEngine";

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
//   - Visits/billing lookback is 24h (reflection runs hourly, so a signal that
//     develops over 6h has 24 chances to be surfaced). The JOURNAL lookback is
//     72h because the system prompt asks for multi-day patterns (3+ days of
//     explicit negatives) — asking for a 3-day pattern over a 24h dataset made
//     the model invent the missing days (U1/AE2). The loaded window and the
//     window claimed in the prompt must stay identical; both are recorded in
//     the draft's inputs metadata.
//   - Strict NOOP / JSON output. Anything that doesn't parse is dropped
//     silently (no draft); we'd rather miss a turn than write garbage to the
//     review queue.
//   - Idempotency: we hash the aggregated context per (userId, hour) and skip
//     when the same hash already produced a draft in the last 6h. Prevents
//     re-flagging the same situation hour after hour.

const db = admin.firestore();

export const ACTIVITY_LOOKBACK_HOURS = 24; // completed visits + billing
export const JOURNAL_LOOKBACK_HOURS  = 72; // must cover the 3-day pattern ask
const ACTIVITY_LOOKBACK_MS = ACTIVITY_LOOKBACK_HOURS * 60 * 60 * 1000;
const JOURNAL_LOOKBACK_MS  = JOURNAL_LOOKBACK_HOURS * 60 * 60 * 1000;
const DEDUPE_TTL_MS  =  6 * 60 * 60 * 1000;
const MAX_FAMILIES_PER_RUN = 250;

type DraftSeverity = "low" | "medium" | "high";

export interface ReflectionDraft {
  userId:       string;
  phone:        string;
  draftText:    string;
  reason:       string;
  severity:     DraftSeverity;
  /** U8: model-classified category, policy-gated before entering review. */
  category:     ReflectionCategory;
  /** Deterministic careInsights evidence count backing a health candidate. */
  evidenceCount: number;
  policyDisposition: "send" | "review_first";
  contextHash:  string;
  status:       "pending_review";
  createdAt:    string;
  inputs: {
    journalCount:  number;
    pastApptCount: number;
    upcomingCount: number;
    billingCount:  number;
    // Evidence-window metadata (AE2): the windows actually loaded, which must
    // match the windows the prompt claims.
    journalWindowHours:  number;
    activityWindowHours: number;
  };
}

// Data-minimized billing signal exposed to the reflection model (R8/KTD9):
// normalized source + status + coarse date only. Never amounts, descriptions,
// payment instruments, names, or record/provider IDs.
export interface BillingSignal {
  source: "invoice" | "payment";
  status: string;
  date:   string; // YYYY-MM-DD
}

interface FamilySnapshot {
  journal:  Array<Record<string, unknown>>;
  past:     Array<Record<string, unknown>>;
  upcoming: Array<Record<string, unknown>>;
  billing:  BillingSignal[];
  billingUnavailable: boolean;
  seniorName: string;
  clientName: string;
}

// Coarse date (YYYY-MM-DD) from a Firestore Timestamp | Date | ISO string.
function coarseDate(v: unknown): string {
  const d = (v as { toDate?: () => Date } | null)?.toDate?.()
    ?? (typeof v === "string" || typeof v === "number" ? new Date(v) : v instanceof Date ? v : null);
  if (!d || isNaN(d.getTime())) return "?";
  return d.toISOString().slice(0, 10);
}

const INVOICE_STATUSES = new Set(["draft", "pending", "paid", "overdue", "void", "refunded"]);
const PAYMENT_STATUSES = new Set(["succeeded", "pending", "failed", "refunded", "disputed"]);
function normalizeStatus(raw: unknown, allow: Set<string>): string {
  const s = String(raw ?? "").toLowerCase();
  return allow.has(s) ? s : "other";
}

// Canonical billing signal built from invoices (keyed by clientId) and payments
// (keyed by userId) independently. Each source is fail-soft on its own; a source
// that errors is reported as unavailable rather than disguised as empty (R8).
//
// Operand types are per-writer: invoicing.ts stamps createdAt as an ISO STRING,
// while stripe.ts stamps serverTimestamp() (a Firestore Timestamp). Firestore
// inequality filters are type-strict — a string operand against a Timestamp
// field silently matches nothing — so each query uses its writer's type.
async function loadBillingSignals(
  userId: string, since: string,
): Promise<{ signals: BillingSignal[]; unavailable: boolean }> {
  const sinceTs = admin.firestore.Timestamp.fromDate(new Date(since));
  const [invoices, payments] = await Promise.all([
    db.collection("invoices")
      .where("clientId", "==", userId)
      .where("createdAt", ">=", since)
      .orderBy("createdAt", "desc").limit(10).get()
      .then(s => ({ ok: true as const, docs: s.docs })).catch(() => ({ ok: false as const, docs: [] })),
    db.collection("payments")
      .where("userId", "==", userId)
      .where("createdAt", ">=", sinceTs)
      .orderBy("createdAt", "desc").limit(10).get()
      .then(s => ({ ok: true as const, docs: s.docs })).catch(() => ({ ok: false as const, docs: [] })),
  ]);

  const signals: BillingSignal[] = [
    ...invoices.docs.map(d => ({
      source: "invoice" as const,
      status: normalizeStatus(d.data().status, INVOICE_STATUSES),
      date:   coarseDate(d.data().createdAt),
    })),
    ...payments.docs.map(d => ({
      source: "payment" as const,
      status: normalizeStatus(d.data().status, PAYMENT_STATUSES),
      date:   coarseDate(d.data().createdAt),
    })),
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);

  return { signals, unavailable: !invoices.ok || !payments.ok };
}

async function loadFamilySnapshot(userId: string, seniorId: string): Promise<FamilySnapshot> {
  const now          = new Date();
  const since        = new Date(now.getTime() - ACTIVITY_LOOKBACK_MS).toISOString();
  const journalSince = new Date(now.getTime() - JOURNAL_LOOKBACK_MS).toISOString();
  const ahead        = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // appointments uses `isoDate` (full ISO string); shifts (2026-08-30 pipeline)
  // has no such field, only a plain `date` (YYYY-MM-DD) — queried separately
  // at day granularity and merged, since queryVisitsMerged assumes one shared
  // field name across both collections.
  const todayStr = now.toISOString().slice(0, 10);
  const [journalSnap, pastApptSnap, pastShiftSnap, upcomingApptSnap, upcomingShiftSnap, billing, seniorSnap, userSnap] = await Promise.all([
    db.collection("care_journal")
      .where("seniorId", "==", seniorId)
      .where("timestamp", ">=", journalSince)
      .orderBy("timestamp", "desc")
      .limit(20).get(),
    db.collection("appointments")
      .where("clientId", "==", userId)
      .where("isoDate", ">=", since)
      .where("isoDate", "<=", now.toISOString())
      .where("status", "==", "completed")
      .limit(20).get(),
    db.collection("shifts")
      .where("clientId", "==", userId)
      .where("date", ">=", since.slice(0, 10))
      .where("date", "<=", todayStr)
      .where("status", "==", "completed")
      .limit(20).get(),
    db.collection("appointments")
      .where("clientId", "==", userId)
      .where("isoDate", ">", now.toISOString())
      .where("isoDate", "<=", ahead)
      .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
      .orderBy("isoDate", "asc").limit(10).get(),
    db.collection("shifts")
      .where("clientId", "==", userId)
      .where("date", ">=", todayStr)
      .where("date", "<=", ahead.slice(0, 10))
      .where("status", "==", "scheduled")
      .orderBy("date", "asc").limit(10).get(),
    loadBillingSignals(userId, since),
    db.collection("senior_profiles").doc(seniorId).get(),
    db.collection("users").doc(userId).get(),
  ]);

  return {
    journal:    journalSnap.docs.map(d => d.data()),
    past:       [...pastApptSnap.docs, ...pastShiftSnap.docs].map(d => d.data()),
    upcoming:   [...upcomingApptSnap.docs, ...upcomingShiftSnap.docs]
      .map(d => d.data())
      .sort((a, b) => String(a.date ?? a.isoDate ?? "").localeCompare(String(b.date ?? b.isoDate ?? ""))),
    billing:    billing.signals,
    billingUnavailable: billing.unavailable,
    seniorName: (seniorSnap.data()?.name as string | undefined) ?? "your loved one",
    clientName: (userSnap.data()?.firstName as string | undefined)
              ?? (userSnap.data()?.name as string | undefined)?.split(" ")[0]
              ?? "there",
  };
}

// Compact textual rollup the LLM reads. Kept short to keep token cost low and
// to force the model to attend to specific signals rather than scan noise.
export function buildReflectionPrompt(snap: FamilySnapshot): string {
  const journalLines = snap.journal.slice(0, 12).map(e => {
    const ts    = (e.timestamp as string | undefined)?.slice(0, 10) ?? "?";
    const line  = describeWellness(parseWellness(e));
    const notes = ((e.notes as string | undefined) ?? "").slice(0, 120);
    return `  - ${ts} ${line}${notes ? ` :: ${notes}` : ""}`;
  }).join("\n");

  const pastLines = snap.past.slice(0, 6).map(a =>
    `  - ${a.date ?? a.isoDate ?? "?"} with ${a.caregiverName ?? "caregiver"}`,
  ).join("\n");

  const upcomingLines = snap.upcoming.slice(0, 5).map(a =>
    `  - ${a.date ?? a.isoDate ?? "?"} at ${a.time ?? "?"} with ${a.caregiverName ?? "caregiver"} (${a.status ?? "?"})`,
  ).join("\n");

  // Source + status + coarse date only — no amounts or free text (R8/KTD9).
  const billingLines = snap.billing.slice(0, 5).map(b =>
    `  - ${b.date} ${b.source} ${b.status}`,
  ).join("\n");
  const billingBlock = snap.billing.length
    ? billingLines
    : snap.billingUnavailable
      ? "  (billing data unavailable)"
      : "  (none)";

  return [
    `Family: ${snap.clientName} (client), caring for ${snap.seniorName}.`,
    "",
    `RECENT CARE JOURNAL (last ${JOURNAL_LOOKBACK_HOURS / 24} days):`,
    journalLines || "  (no entries)",
    "",
    `COMPLETED VISITS (last ${ACTIVITY_LOOKBACK_HOURS}h):`,
    pastLines || "  (none)",
    "",
    "UPCOMING VISITS (next 7 days):",
    upcomingLines || "  (none scheduled)",
    "",
    "RECENT BILLING (source/status/date only):",
    billingBlock,
  ].join("\n");
}

const REFLECTION_SYSTEM = `You are Evia's quiet observer. Read the family's recent care data (journal covers the last 3 days; visits and billing cover the last 24h) and decide whether there is something worth Evia proactively reaching out about RIGHT NOW that the family hasn't already asked.

DATA RULES (non-negotiable):
  • "not recorded" means UNKNOWN. It is never evidence of missed meds, poor appetite, low activity, or any concern. Only lines marked "(recorded)" are actual negative observations.
  • A health pattern claim requires explicit recorded negatives on at least 3 distinct days within the journal window. Fewer explicit observations = no pattern, regardless of how the notes read.
  • Never extrapolate beyond the stated windows. You cannot see anything older than the journal window.

Strong reasons to surface:
  • Pattern across multiple journal entries (3+ distinct days of RECORDED missed meds, recorded appetite decline, mood declining).
  • Caregiver no-show or repeated lateness.
  • An upcoming visit at risk (caregiver hasn't confirmed, gap on a day the family relies on).
  • A billing anomaly the family will see on a credit card before Evia explains it.
  • A milestone or anniversary worth a warm note.
  • A safety concern visible in the journal that hasn't been flagged.

Reasons NOT to surface:
  • A single normal entry. One bad day is not a pattern.
  • Unrecorded wellness fields — missing data is not a signal.
  • A scheduled visit that's fine.
  • A routine billing event with no surprise.
  • Anything the family was clearly already aware of (mentioned by name in journal).
  • Boredom — if nothing is meaningfully wrong or right, say nothing.

OUTPUT FORMAT: exactly one JSON object on a single line, no prose around it, no code fences.

If nothing is worth surfacing:
{"action":"noop"}

If something is worth surfacing:
{"action":"draft","draftText":"<the actual SMS Evia would send, in her voice — warm, short, names the specific thing>","reason":"<one sentence: what pattern you detected>","severity":"low|medium|high","category":"health|visit|billing|milestone"}

Category guide (pick exactly one):
  • health    = wellness/medication/appetite/mood pattern in the journal
  • visit     = an upcoming or completed visit issue (no-show risk, unconfirmed)
  • billing   = a billing event the family will notice
  • milestone = warmth, anniversary, positive moment

Severity guide:
  • high   = safety / health concern that needs the family to act today
  • medium = something they'll want to know within a day but isn't urgent
  • low    = warmth / milestone / pre-warning before a billing event hits

Be conservative. Drafts go to a human review queue, but bad drafts still cost reviewer attention.`;

export type ReflectionCategory = "health" | "visit" | "billing" | "milestone";

interface ReflectionResult {
  action: "noop" | "draft";
  draftText?: string;
  reason?:    string;
  severity?:  DraftSeverity;
  category?:  ReflectionCategory;
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

    // Missing/invalid category defaults to "health" — the CONSERVATIVE choice:
    // health candidates face the deterministic-evidence gate (U8/R42), so an
    // unclassified draft can never sneak past it.
    const category: ReflectionCategory =
      obj.category === "visit" || obj.category === "billing" || obj.category === "milestone"
        ? obj.category
        : "health";

    return { action: "draft", draftText, reason, severity, category };
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
}): Promise<"noop" | "skipped" | "drafted" | "suppressed" | "error"> {
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

    // U8 slice 2 (R40/R42): the reflection draft is now a CANDIDATE that must
    // pass the unified proactive policy before it may enter the review queue.
    // Health candidates carry deterministic careInsights evidence — an LLM
    // hunch with zero recorded-negative-day support is suppressed here, never
    // reviewed, never sent. First manifest source migrated to the engine.
    const insightEvidence = parsed.category === "health"
      ? concerningInsights(deriveCareInsights(snap.journal)).length
      : 1; // non-health categories are grounded by their own loaders
    const CATEGORY_MAP = { health: "health_pattern", visit: "visit_risk", billing: "billing_heads_up", milestone: "warmth" } as const;
    const nowIso = new Date().toISOString();
    const decision = decideForRecipient([{
      source: "proactiveReflection",
      category: CATEGORY_MAP[parsed.category!],
      urgency: parsed.severity === "high" ? 3 : parsed.severity === "medium" ? 2 : 1,
      evidenceCount: insightEvidence,
      dedupeKey: contextHash,
      createdAt: nowIso,
      expiresAt: new Date(Date.now() + DEDUPE_TTL_MS).toISOString(),
    }], { optionalSendsToday: 0, inDnd: false })[0];
    if (decision.disposition !== "send" && decision.disposition !== "review_first") {
      console.info("proactiveReflection.policy", {
        disposition: decision.disposition,
        reason: decision.reason,
        category: parsed.category,
      });
      return "suppressed";
    }

    const draft: ReflectionDraft = {
      userId:      opts.userId,
      phone:       opts.phone,
      draftText:   parsed.draftText!,
      reason:      parsed.reason!,
      severity:    parsed.severity!,
      category:    parsed.category!,
      evidenceCount: insightEvidence,
      policyDisposition: decision.disposition,
      contextHash,
      status:      "pending_review",
      createdAt:   nowIso,
      inputs: {
        journalCount:  snap.journal.length,
        pastApptCount: snap.past.length,
        upcomingCount: snap.upcoming.length,
        billingCount:  snap.billing.length,
        journalWindowHours:  JOURNAL_LOOKBACK_HOURS,
        activityWindowHours: ACTIVITY_LOOKBACK_HOURS,
      },
    };

    await db.collection("proactive_drafts").add(draft);
    return "drafted";
  } catch (err) {
    console.error("proactiveReflection: family failed", opts.userId, err);
    return "error";
  }
}

async function runReflectionPass(): Promise<{ scanned: number; drafted: number; noop: number; skipped: number; suppressed: number; errored: number }> {
  const sessionsSnap = await db.collection("agent_sessions")
    .where("optedOut", "==", false)
    .where("userType", "==", "client")
    .limit(MAX_FAMILIES_PER_RUN)
    .get();

  const stats = { scanned: 0, drafted: 0, noop: 0, skipped: 0, suppressed: 0, errored: 0 };

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
    else if (outcome === "suppressed") stats.suppressed++;
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
