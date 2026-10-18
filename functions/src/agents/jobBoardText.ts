// The Jobs page, texted. 2026-09-27 (founder, live): the model DID produce the
// numbered job list, but the reply post-processor rewrote every list-shaped
// SMS into "I found a few options near you — which one?" and the caregiver
// never saw a single job. So the list and the Details modal are sent by the
// TOOLS themselves, verbatim from jobBoardPage.ts (the site's cards), and the
// model adds nothing (SELF_SENDING_FLOW_STARTS in qaAgent.ts).
//
// Numbers are the handle: the last list texted is remembered on the session
// (`lastJobList`) so "2", "details on 3", "apply to 2" resolve to job ids
// without the model ever guessing an id. "This job" right after a new-job
// notice resolves through `lastNoticedJobId` (newJobNotice.ts).
//
// Filters (sweep B3, 2026-10-11): the page's sidebar (search, pay range, time
// of day, days, seniors, care type) over text. The filter VALUES come from the
// quick-tier model as a structured object (`extractJobBoardFilters`), validated
// against the sidebar's own option sets (`normalizeJobBoardFilters`) — the
// words' meaning is never read by code. "JOBS" alone is the page as it opens;
// "JOBS <words>" is the sidebar set from those words; a follow-up such as
// "only weekends" while the job list is the newest list texted narrows the
// LAST filters (stored with the list on `lastJobList.filters`, so MORE and the
// numbered picks keep indexing the filtered list that was shown).
import * as admin from "firebase-admin";
import { sendMessage, type AgentSession } from "../linq/client";
import { parseWithClaude } from "../utils/parseWithClaude";
import {
  loadAvailableJobs, loadJobDetails, jobCardLine, setJobHidden,
  normalizeJobBoardFilters, hasJobBoardFilters, jobBoardFiltersLabel,
  JOB_BOARD_CARE_TYPES,
  type AvailableJobsResult, type JobBoardFilters, type JobDetails,
} from "./jobBoardPage";

const db = admin.firestore();

export interface LastJobList {
  at: string;
  items: Array<{ number: number; jobId: string; title: string }>;
  // Paging (founder, 2026-09-27): the site's page scrolls; a text can't. Two
  // at a time, newest first (the page's order), "MORE" for the next two;
  // numbering continues across pages so "apply to 5" keeps meaning job 5.
  offset?: number;
  total?: number;
  // The sidebar set this list was built with (absent = the default view).
  filters?: JobBoardFilters;
}

export const PAGE_SIZE = 2;
/**
 * The footer follows the list it closes (founder, 2026-10-07: a one-job list that said "apply to 2"
 * / "hide 2", and offered "apply" on a Set Up Transportation job, was confusing). The examples use
 * the numbers actually shown; "apply" is offered only when a shown job can be applied to, and a
 * gated job gets the Details modal's own line ("To apply you'll need to: …").
 */
export function listFooter(shown: ReadonlyArray<{ action: string }>, from = 0): string {
  const numbered = shown.map((card, i) => ({ n: from + i + 1, action: card.action }));
  const first = numbered[0]?.n ?? 1;
  const applicable = numbered.find((j) => j.action === "Apply Now");
  const gated = numbered.find((j) => j.action !== "Apply Now");
  const parts = [`Reply with a number for the details${applicable ? `, "apply to ${applicable.n}" to apply` : ""}, or "hide ${first}".`];
  if (gated) parts.push(`To apply to job ${gated.n} you'll need to: ${gated.action}.`);
  return parts.join(" ");
}
/** @deprecated kept for callers that only need the default shape — prefer listFooter(shown, from). */
export const LIST_FOOTER = listFooter([{ action: "Apply Now" }]);

/**
 * JobBoard.tsx: "N jobs found", one card per line, the empty states verbatim.
 * `from` = how many were already shown (the next page continues the numbers).
 */
export function jobListText(
  page: AvailableJobsResult,
  opts: { filtered?: boolean; filtersLabel?: string; limited?: boolean; from?: number; pageSize?: number } = {},
): { text: string; shown: AvailableJobsResult["jobs"]; remaining: number } {
  const from = opts.from ?? 0;
  if (page.jobs.length === 0) return { text: opts.filtered ? "No jobs match your filters." : "No open jobs right now.", shown: [], remaining: 0 };
  const size = opts.pageSize ?? (opts.limited ? page.jobs.length : PAGE_SIZE);
  const shown = page.jobs.slice(from, from + size);
  const remaining = Math.max(0, page.jobs.length - (from + shown.length));
  // Founder (2026-09-27): no counts in the text — "Jobs found:", two at a
  // time, MORE for the next two, until there are none left. A filtered list
  // names the sidebar set it was built with (B3), still without a count.
  if (shown.length === 0) return { text: "That's all the open jobs right now — reply with a number for the details.", shown, remaining: 0 };
  const label = opts.filtered && opts.filtersLabel ? ` (${opts.filtersLabel})` : "";
  const header = from === 0 ? (opts.limited ? `Jobs near you${label}:` : `Jobs found${label}:`) : `More jobs${label}:`;
  const lines = shown.map((card, i) =>
    `${from + i + 1}. ${jobCardLine(card)}${card.action !== "Apply Now" ? ` — ${card.action}` : ""}`);
  const footerBase = listFooter(shown, from);
  const footer = remaining > 0 ? `${footerBase} Reply MORE to see more.` : footerBase;
  return { text: [header, ...lines, "", footer].join("\n"), shown, remaining };
}

/** The Job Details modal, top to bottom, ending in the ONE footer the modal shows. */
export function jobDetailsText(d: JobDetails): string {
  const where = d.location
    ? `${d.location}${d.distanceMiles != null ? ` (${d.distanceMiles.toFixed(1)} mi away)` : ""}`
    : (d.distanceMiles != null ? `${d.distanceMiles.toFixed(1)} mi away` : "");
  const pills = [d.kind ?? "", d.frequency, d.day ? "Daytime" : "", d.night ? "Nights" : "",
    d.seniors ? `${d.seniors} people` : "", ...d.ageRanges, d.transportation ? "Transportation" : ""].filter(Boolean).join(" · ");
  const out: string[] = [d.title];
  if (d.postedBy) out.push(`Posted by ${d.postedBy}`);
  if (where) out.push(where);
  out.push(`${d.rate}${d.paymentMethod ? ` (${d.paymentMethod})` : ""}`);
  if (pills) out.push(pills);
  if (d.careTypes.length) out.push(`Care: ${d.careTypes.join(", ")}`);
  if (d.startingDate) out.push(`Starting: ${d.startingDate}`);
  if (d.daysOfWeek.length) out.push(`Days: ${d.daysOfWeek.join(", ")}`);
  if (d.time) out.push(`Time: ${d.time}`);
  if (d.hoursPerWeek) out.push(`Hours/week: ${d.hoursPerWeek}`);
  if (d.description) out.push("", d.description);
  out.push("");
  if (d.interviewStatus) out.push(d.interviewStatus);
  else if (d.applicationStatus) out.push(d.applicationStatus);
  else if (d.action === "Apply Now") out.push(`Reply "apply" to apply, or a number for another job.`);
  else out.push(`To apply you'll need to: ${d.action}.`);
  return out.join("\n");
}

/** Which job the caregiver means: an explicit id, a number from the last list, the job whose details were just shown, or the job just noticed. */
export function resolveJobRef(
  session: Record<string, unknown>,
  ref: { jobId?: unknown; number?: unknown },
): string | null {
  if (typeof ref.jobId === "string" && ref.jobId.trim()) return ref.jobId.trim();
  const n = typeof ref.number === "number" ? ref.number : (typeof ref.number === "string" ? parseInt(ref.number, 10) : NaN);
  if (Number.isFinite(n)) {
    const last = session.lastJobList as LastJobList | undefined;
    const hit = last?.items?.find((it) => it.number === n);
    return hit ? hit.jobId : null;
  }
  // No number, no id: the job most recently put in front of them wins — the
  // details they just read, the job just noticed, or (if the newest thing was
  // a list) nothing, so the tool asks by number. 2026-09-27 live: "can you
  // provide details" right after a new-job notice showed a job whose details
  // they had read earlier, because "last shown" was checked before "just noticed".
  const ts = (v: unknown) => (typeof v === "string" ? Date.parse(v) || 0 : 0);
  const candidates: Array<{ at: number; jobId: string | null }> = [];
  if (typeof session.lastJobDetailsJobId === "string" && session.lastJobDetailsJobId) candidates.push({ at: ts(session.lastJobDetailsAt), jobId: session.lastJobDetailsJobId });
  if (typeof session.lastNoticedJobId === "string" && session.lastNoticedJobId) candidates.push({ at: ts(session.lastNoticedJobAt), jobId: session.lastNoticedJobId });
  const last = session.lastJobList as LastJobList | undefined;
  if (last?.items?.length) candidates.push({ at: ts(last.at), jobId: last.items.length === 1 ? last.items[0].jobId : null });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.at - a.at);
  return candidates[0].jobId;
}

export async function sendJobList(
  phone: string, chatId: string, caregiverId: string,
  opts: { filters?: JobBoardFilters; sort?: "newest" | "nearest"; limit?: number; more?: boolean; refine?: boolean } = {},
): Promise<{ sent: boolean; count: number; total: number; remaining: number; items: LastJobList["items"]; filters: JobBoardFilters; filtersLabel: string }> {
  // MORE continues the last list where it left off — with the SAME sidebar set
  // (a filtered list paged with the default set would renumber a different
  // list); refine narrows the last set; anything else starts over.
  let prev: LastJobList | undefined;
  if (opts.more || opts.refine) {
    const sess = await db.collection("agent_sessions").doc(phone).get().catch(() => null);
    prev = (sess?.data()?.lastJobList as LastJobList | undefined) ?? undefined;
  }
  const given = normalizeJobBoardFilters(opts.filters);
  const filters: JobBoardFilters = opts.more && !hasJobBoardFilters(given)
    ? normalizeJobBoardFilters(prev?.filters)
    : (opts.refine ? { ...normalizeJobBoardFilters(prev?.filters), ...given } : given);
  const page = await loadAvailableJobs(caregiverId, { filters, sort: opts.sort, limit: opts.limit });
  const filtersLabel = jobBoardFiltersLabel(filters);
  if (!page) { await sendMessage(chatId, "I couldn't find your care provider account to load the Jobs page."); return { sent: false, count: 0, total: 0, remaining: 0, items: [], filters, filtersLabel }; }
  const filtered = hasJobBoardFilters(filters);
  const from = opts.more && prev ? (prev.offset ?? prev.items.length) : 0;
  const { text, shown, remaining } = jobListText(page, { filtered, filtersLabel, limited: !!opts.limit, from });
  await sendMessage(chatId, text);
  const newItems = shown.map((card, i) => ({ number: from + i + 1, jobId: card.jobId, title: card.title }));
  const items = from > 0 && prev ? [...prev.items.filter((it) => it.number <= from), ...newItems] : newItems;
  await db.collection("agent_sessions").doc(phone).set(
    { lastJobList: { at: new Date().toISOString(), items, offset: from + shown.length, total: page.total, ...(filtered ? { filters } : {}) } satisfies LastJobList },
    { merge: true },
  ).catch(() => {});
  return { sent: true, count: shown.length, total: page.total, remaining, items, filters, filtersLabel };
}

// ── The JOBS keyword path (routeCaregiver.ts) ─────────────────────────────────
// The exact words the page announces; the sidebar values come from the model.
const JOBS_WORDS: ReadonlySet<string> = new Set(["JOBS", "JOB BOARD", "JOBS PAGE", "AVAILABLE JOBS", "OPEN JOBS"]);
/** A follow-up narrows the last list only while that list is recent (the same window as a parked question). */
export const JOB_LIST_FOLLOW_UP_WINDOW_MS = 2 * 60 * 60 * 1000;
const OTHER_LIST_KEYS = ["lastPastBookingList", "lastCalendarList", "lastFamilyList", "lastActiveBookingList", "lastBookingRequestList", "lastTimesheetList"] as const;

function atMs(v: unknown): number {
  return typeof v === "string" ? (Date.parse(v) || 0) : 0;
}

/** The job list owns MORE / JOB n / HIDE n / a filter follow-up only while it is the most recent numbered list texted (caregiverTimesheets.listIsLatest, same rule). */
export function jobListIsLatest(session: Record<string, unknown>, nowMs: number = Date.now()): boolean {
  const last = session.lastJobList as LastJobList | undefined;
  const mine = atMs(last?.at);
  if (!mine || !last?.items) return false;
  if (nowMs - mine > JOB_LIST_FOLLOW_UP_WINDOW_MS) return false;
  for (const k of OTHER_LIST_KEYS) {
    if (atMs((session[k] as { at?: string } | undefined)?.at) > mine) return false;
  }
  return true;
}

const EXTRACT_PROMPT =
  "A care provider is texting what she wants the Jobs page's filter sidebar set to. The sidebar has exactly these controls: " +
  "search (free text matched against the job title, the location and the required skills), payMin and payMax (dollars per hour), " +
  "timeOfDay (any of: morning = 6am–12pm, afternoon = 12pm–6pm, evening = 6pm–12am, overnight = 12am–6am — use those four words), " +
  "days (any of Mon, Tue, Wed, Thu, Fri, Sat, Sun — 'weekends' = Sat and Sun, 'weekdays' = Mon to Fri), " +
  "seniors (any of \"1\", \"2\", \"3+\" — how many people need care), " +
  `careTypes (any of: ${JOB_BOARD_CARE_TYPES.join(", ")} — use these exact names). ` +
  "There is NO distance control — ignore any distance or radius she mentions. " +
  "Reply with ONLY a JSON object using those keys, each present only when she asked for it; " +
  "add \"clear\": true when she wants the filters removed / everything shown. " +
  "If she asked for nothing the sidebar can do, reply NONE.";

const REFINE_PROMPT =
  "A care provider was just texted the Jobs page list. Decide whether her new message is CHANGING THE FILTER SIDEBAR of that list " +
  "(narrowing or changing it — e.g. 'only weekends', 'over $25', 'mornings instead', 'just companionship ones', 'show everything again'). " +
  "If it is anything else — a number, 'apply', 'hide', 'details', a question, an answer to something, a greeting, a different page — reply NONE. " +
  "Otherwise reply with ONLY a JSON object of the sidebar controls she is setting: " +
  "search (free text), payMin / payMax (dollars per hour), timeOfDay (morning, afternoon, evening, overnight), " +
  "days (Mon, Tue, Wed, Thu, Fri, Sat, Sun — 'weekends' = Sat and Sun, 'weekdays' = Mon to Fri), seniors (\"1\", \"2\", \"3+\"), " +
  `careTypes (exact names from: ${JOB_BOARD_CARE_TYPES.join(", ")}); add "clear": true when she wants the filters removed. ` +
  "There is NO distance control — ignore distances. Only the controls she mentions; nothing invented.";

export type ExtractedJobBoardFilters = { filters: JobBoardFilters; clear: boolean };

/** The words after JOBS (or a follow-up) → the sidebar set, through the quick-tier model, validated against the page's options. */
export async function extractJobBoardFilters(words: string, mode: "jobs" | "refine" = "jobs"): Promise<ExtractedJobBoardFilters> {
  const none = { filters: {}, clear: false };
  const text = words.trim();
  if (!text) return none;
  const raw = await parseWithClaude(mode === "refine" ? REFINE_PROMPT : EXTRACT_PROMPT, text, 300).catch(() => "__parse_error__");
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "__parse_error__" || trimmed.toUpperCase().startsWith("NONE")) return none;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return none;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed.slice(start, end + 1)); } catch { return none; }
  const obj = (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : {};
  return { filters: normalizeJobBoardFilters(obj), clear: obj.clear === true };
}

/**
 * JOBS · JOBS <words> · MORE · JOB n · HIDE n · APPLY [TO] n — the Jobs page's
 * Available Jobs tab, its sidebar, the Details button, Hide and Apply Now, by
 * exact word; the numbers index the list that was texted (filtered or not).
 */
export async function handleJobsKeyword(
  phone: string, chatId: string, caregiverId: string, text: string, session: Record<string, unknown>,
): Promise<"handled" | "passthrough"> {
  const raw = text.trim();
  const upper = raw.toUpperCase().replace(/\s+/g, " ");
  if (JOBS_WORDS.has(upper)) { await sendJobList(phone, chatId, caregiverId); return "handled"; }
  if (upper.startsWith("JOBS ")) {
    const { filters, clear } = await extractJobBoardFilters(raw.slice(5));
    // Nothing the sidebar can do with those words → the page as it opens, no claim made.
    await sendJobList(phone, chatId, caregiverId, clear ? {} : { filters });
    return "handled";
  }
  const latest = jobListIsLatest(session);
  if (upper === "MORE" && latest) { await sendJobList(phone, chatId, caregiverId, { more: true }); return "handled"; }
  const pick = /^(JOB|HIDE|APPLY(?: TO)?)\s+(\d+)$/i.exec(upper);
  if (pick && latest) {
    const verb = pick[1].startsWith("APPLY") ? "APPLY" : pick[1];
    const n = Number(pick[2]);
    const jobId = resolveJobRef(session, { number: n });
    if (!jobId) { await sendMessage(chatId, `I don't have a job ${n} on the last list — reply JOBS to see them.`); return "handled"; }
    if (verb === "JOB") { await sendJobDetails(phone, chatId, caregiverId, jobId); return "handled"; }
    if (verb === "HIDE") {
      // The card's Hide button: the same write (caregivers/{uid}.hiddenJobIds) and the page's toast.
      try { await setJobHidden(caregiverId, jobId, true); await sendMessage(chatId, "Job hidden"); }
      catch { await sendMessage(chatId, "Could not hide this job. Please try again."); }
      return "handled";
    }
    const { startApplyFlow } = await import("./caregiverJobFlows");
    await startApplyFlow(phone, chatId, { ...session, caregiverId, chatId } as unknown as AgentSession, { caregiverId, jobId });
    return "handled";
  }
  return "passthrough";
}

/**
 * A free-text follow-up to the job list ("only weekends", "over $25") narrows
 * the last sidebar set — only while that list is the newest list texted and
 * only when the quick model reads the message as a filter change; a bare
 * number is the page's own reply protocol and is never read as one. Runs after
 * every page keyword (routeCaregiver.ts), so a page word still opens its page.
 */
export async function handleJobsFilterFollowUp(
  phone: string, chatId: string, caregiverId: string, text: string, session: Record<string, unknown>,
): Promise<"handled" | "passthrough"> {
  const raw = text.trim();
  if (!raw || /^\d+$/.test(raw) || !jobListIsLatest(session)) return "passthrough";
  const { filters, clear } = await extractJobBoardFilters(raw, "refine");
  if (clear) { await sendJobList(phone, chatId, caregiverId); return "handled"; }
  if (!hasJobBoardFilters(filters)) return "passthrough";
  await sendJobList(phone, chatId, caregiverId, { filters, refine: true });
  return "handled";
}

export async function sendJobDetails(
  phone: string, chatId: string, caregiverId: string, jobId: string,
): Promise<{ sent: boolean; ok: boolean; reason?: string }> {
  const r = await loadJobDetails(caregiverId, jobId);
  if (!r.ok) {
    await sendMessage(chatId, r.reason === "no_caregiver"
      ? "I couldn't find your care provider account to load that job."
      : "That job is no longer available.");
    return { sent: true, ok: false, reason: r.reason };
  }
  await sendMessage(chatId, jobDetailsText(r.details));
  await db.collection("agent_sessions").doc(phone).set({ lastJobDetailsJobId: jobId, lastJobDetailsAt: new Date().toISOString() }, { merge: true }).catch(() => {});
  return { sent: true, ok: true };
}
