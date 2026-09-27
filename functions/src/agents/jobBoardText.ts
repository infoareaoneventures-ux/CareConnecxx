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
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import {
  loadAvailableJobs, loadJobDetails, jobCardLine,
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
}

export const PAGE_SIZE = 2;
export const LIST_FOOTER = `Reply with a number for the details, "apply to 2" to apply, or "hide 2".`;

/**
 * JobBoard.tsx: "N jobs found", one card per line, the empty states verbatim.
 * `from` = how many were already shown (the next page continues the numbers).
 */
export function jobListText(
  page: AvailableJobsResult,
  opts: { filtered?: boolean; limited?: boolean; from?: number; pageSize?: number } = {},
): { text: string; shown: AvailableJobsResult["jobs"]; remaining: number } {
  const from = opts.from ?? 0;
  if (page.jobs.length === 0) return { text: opts.filtered ? "No jobs match your filters." : "No open jobs right now.", shown: [], remaining: 0 };
  const size = opts.pageSize ?? (opts.limited ? page.jobs.length : PAGE_SIZE);
  const shown = page.jobs.slice(from, from + size);
  const remaining = Math.max(0, page.jobs.length - (from + shown.length));
  // Founder (2026-09-27): no counts in the text — "Jobs found:", two at a
  // time, MORE for the next two, until there are none left.
  if (shown.length === 0) return { text: "That's all the open jobs right now — reply with a number for the details.", shown, remaining: 0 };
  const header = from === 0 ? (opts.limited ? "Jobs near you:" : "Jobs found:") : "More jobs:";
  const lines = shown.map((card, i) =>
    `${from + i + 1}. ${jobCardLine(card)}${card.action !== "Apply Now" ? ` — ${card.action}` : ""}`);
  const footer = remaining > 0 ? `${LIST_FOOTER} Reply MORE to see more.` : LIST_FOOTER;
  return { text: [header, ...lines, "", footer].join("\n"), shown, remaining };
}

/** The Job Details modal, top to bottom, ending in the ONE footer the modal shows. */
export function jobDetailsText(d: JobDetails): string {
  const where = d.location
    ? `${d.location}${d.distanceMiles != null ? ` (${d.distanceMiles.toFixed(1)} mi away)` : ""}`
    : (d.distanceMiles != null ? `${d.distanceMiles.toFixed(1)} mi away` : "");
  const pills = [d.frequency, d.day ? "Daytime" : "", d.night ? "Nights" : "",
    d.seniors ? `${d.seniors} seniors` : "", d.transportation ? "Transportation" : ""].filter(Boolean).join(" · ");
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
  opts: { filters?: JobBoardFilters; sort?: "newest" | "nearest"; limit?: number; more?: boolean } = {},
): Promise<{ sent: boolean; count: number; total: number; remaining: number; items: LastJobList["items"] }> {
  const page = await loadAvailableJobs(caregiverId, opts);
  if (!page) { await sendMessage(chatId, "I couldn't find your caregiver account to load the Jobs page."); return { sent: false, count: 0, total: 0, remaining: 0, items: [] }; }
  const filtered = !!opts.filters && Object.values(opts.filters).some((v) => Array.isArray(v) ? v.length > 0 : v != null && v !== "");
  // MORE continues the last list where it left off; anything else starts over.
  let prev: LastJobList | undefined;
  if (opts.more) {
    const sess = await db.collection("agent_sessions").doc(phone).get().catch(() => null);
    prev = (sess?.data()?.lastJobList as LastJobList | undefined) ?? undefined;
  }
  const from = opts.more && prev ? (prev.offset ?? prev.items.length) : 0;
  const { text, shown, remaining } = jobListText(page, { filtered, limited: !!opts.limit, from });
  await sendMessage(chatId, text);
  const newItems = shown.map((card, i) => ({ number: from + i + 1, jobId: card.jobId, title: card.title }));
  const items = from > 0 && prev ? [...prev.items.filter((it) => it.number <= from), ...newItems] : newItems;
  await db.collection("agent_sessions").doc(phone).set(
    { lastJobList: { at: new Date().toISOString(), items, offset: from + shown.length, total: page.total } satisfies LastJobList },
    { merge: true },
  ).catch(() => {});
  return { sent: true, count: shown.length, total: page.total, remaining, items };
}

export async function sendJobDetails(
  phone: string, chatId: string, caregiverId: string, jobId: string,
): Promise<{ sent: boolean; ok: boolean; reason?: string }> {
  const r = await loadJobDetails(caregiverId, jobId);
  if (!r.ok) {
    await sendMessage(chatId, r.reason === "no_caregiver"
      ? "I couldn't find your caregiver account to load that job."
      : "That job is no longer available.");
    return { sent: true, ok: false, reason: r.reason };
  }
  await sendMessage(chatId, jobDetailsText(r.details));
  await db.collection("agent_sessions").doc(phone).set({ lastJobDetailsJobId: jobId, lastJobDetailsAt: new Date().toISOString() }, { merge: true }).catch(() => {});
  return { sent: true, ok: true };
}
