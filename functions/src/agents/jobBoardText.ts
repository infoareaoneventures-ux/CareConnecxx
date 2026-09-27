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
}

export const LIST_FOOTER = `Reply with a number for the details, "apply to 2" to apply, or "hide 2".`;

/** JobBoard.tsx: "N jobs found", one card per line, the empty states verbatim. */
export function jobListText(page: AvailableJobsResult, opts: { filtered?: boolean; limited?: boolean } = {}): string {
  if (page.jobs.length === 0) return opts.filtered ? "No jobs match your filters." : "No open jobs right now.";
  const header = `${page.total} job${page.total === 1 ? "" : "s"} found${opts.limited && page.jobs.length < page.total ? ` — the ${page.jobs.length} nearest` : ""}:`;
  const lines = page.jobs.map((card, i) =>
    `${i + 1}. ${jobCardLine(card)}${card.action !== "Apply Now" ? ` — ${card.action}` : ""}`);
  return [header, ...lines, "", LIST_FOOTER].join("\n");
}

/** The Job Details modal, top to bottom, ending in the ONE footer the modal shows. */
export function jobDetailsText(d: JobDetails): string {
  const where = d.location
    ? `${d.location}${d.distanceMiles != null ? ` (${d.distanceMiles.toFixed(1)} mi away)` : ""}`
    : (d.distanceMiles != null ? `${d.distanceMiles.toFixed(1)} mi away` : "");
  const pills = [d.frequency, d.day ? "Day" : "", d.night ? "Night" : "",
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
  const shown = session.lastJobDetailsJobId;
  if (typeof shown === "string" && shown) return shown;
  const noticed = session.lastNoticedJobId;
  if (typeof noticed === "string" && noticed) return noticed;
  return null;
}

export async function sendJobList(
  phone: string, chatId: string, caregiverId: string,
  opts: { filters?: JobBoardFilters; sort?: "newest" | "nearest"; limit?: number } = {},
): Promise<{ sent: boolean; count: number; total: number; items: LastJobList["items"] }> {
  const page = await loadAvailableJobs(caregiverId, opts);
  if (!page) { await sendMessage(chatId, "I couldn't find your caregiver account to load the Jobs page."); return { sent: false, count: 0, total: 0, items: [] }; }
  const filtered = !!opts.filters && Object.values(opts.filters).some((v) => Array.isArray(v) ? v.length > 0 : v != null && v !== "");
  await sendMessage(chatId, jobListText(page, { filtered, limited: !!opts.limit }));
  const items = page.jobs.map((card, i) => ({ number: i + 1, jobId: card.jobId, title: card.title }));
  await db.collection("agent_sessions").doc(phone).set(
    { lastJobList: { at: new Date().toISOString(), items } satisfies LastJobList },
    { merge: true },
  ).catch(() => {});
  return { sent: true, count: page.jobs.length, total: page.total, items };
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
  await db.collection("agent_sessions").doc(phone).set({ lastJobDetailsJobId: jobId }, { merge: true }).catch(() => {});
  return { sent: true, ok: true };
}
