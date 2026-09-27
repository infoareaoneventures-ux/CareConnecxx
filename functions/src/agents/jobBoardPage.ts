// The caregiver Jobs board, as data — the server-side twin of
// components/caregiver/JobBoard.tsx (Available Jobs tab) and the dashboard's
// "Nearby Jobs" section (CaregiverHomeDashboard.tsx / CaregiverOnboardingDashboard.tsx).
//
// Evia reads and shows EXACTLY what the website does (founder, 2026-09-27:
// "evia shouldn't have any other paths other than what the site does"):
//   • same query: job_posts where status == open, newest first, no cap;
//   • same drops: already applied, hidden by this caregiver, client
//     deactivated (clientActive === false), client blocked by this caregiver;
//   • same radius rule: only when the caregiver has coordinates AND a travel
//     distance > 0 AND the job has coordinates — jobs without coordinates are
//     always shown; no skills / fit filter of any kind;
//   • same sidebar filters (search, pay range, time of day, days, seniors in
//     home, care type) with the same field semantics;
//   • same card content (title, location, distance, rate or "Flexible",
//     payment method, frequency pill, Day/Night pills, seniors, Transportation,
//     date line, hours line) and the same Details modal fields;
//   • the dashboard view = the same list sorted by distance, first four.
// Every label here is copied from the page's own rendering so a text from Evia
// reads like the card the caregiver would see on the site.
import * as admin from "firebase-admin";
import { haversineMiles } from "../ai/scoring";
import { caregiverBlockReason, jobRequiresTransport, CaregiverGateReason } from "./caregiverAccessGate";

const db = admin.firestore();

type Doc = Record<string, unknown>;

// services/api.ts normalizeJobPost — legacy Evia-written docs carry location as
// an object / summary instead of title / hourlyRate instead of rate.
export function normalizeJobPost(raw: Doc): Doc {
  const j: Doc = { ...raw };
  const loc = j.location as Doc | string | undefined;
  if (loc && typeof loc === "object") {
    if (j.lat == null && loc.lat != null) j.lat = loc.lat;
    if (j.lng == null && loc.lng != null) j.lng = loc.lng;
    j.location = [loc.city ?? j.city, j.zipCode].filter(Boolean).join(", ");
  }
  if (!j.title) j.title = (j.summary as string) || "Care needed";
  if (j.rate == null) {
    if (typeof j.hourlyRate === "number") j.rate = j.hourlyRate;
    else { j.rate = 0; j.rateFlexible = j.rateFlexible ?? true; }
  }
  if (!j.date && j.startDate) j.date = j.startDate;
  if (!j.careTypes && Array.isArray(j.requirements)) j.careTypes = j.requirements;
  const sched = j.schedule as Doc | undefined;
  if (Array.isArray(sched?.days) && !j.daysOfWeek && (sched!.days as unknown[]).length) j.daysOfWeek = sched!.days;
  return j;
}

// JobBoard.tsx rateLabel: a flexible job stores rate 0 + rateFlexible.
export function rateLabel(job: Doc): string {
  const rate = job.rate as number | undefined;
  if (job.rateFlexible || !rate || rate <= 0) return "Flexible";
  return `$${rate}/hr`;
}

// JobBoard.tsx card frequency pill (derived from minHoursPerWeek when unset).
export function frequencyLabel(job: Doc): string {
  const hrs = job.minHoursPerWeek as number | undefined;
  const freq = (job.jobFrequency as string) || (hrs && hrs >= 32 ? "full-time" : hrs ? "part-time" : "occasional");
  const labels: Record<string, string> = { "one-time": "Occasional", occasional: "Occasional", "part-time": "Part-time", "full-time": "Full-time" };
  return labels[freq] || freq;
}

function timeOfDayList(job: Doc): string[] {
  return Array.isArray(job.timeOfDay) ? (job.timeOfDay as string[]) : [];
}

// JobBoard.tsx card date line: Today/Tomorrow as-is, else "Sep 8, 2026", else the raw value (e.g. "ASAP").
export function dateLabel(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (value === "Today" || value === "Tomorrow") return value;
  const d = new Date(`${value}T12:00:00`);
  return isNaN(d.getTime()) ? value : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// JobBoard.tsx card hours line: "start – end", else capitalized time-of-day list, else "Flexible hours".
export function hoursLabel(job: Doc, fallback: string | null = "Flexible hours"): string | null {
  const s = job.startTime as string | undefined;
  const e = job.endTime as string | undefined;
  if (s && e && s !== "-") return `${s} – ${e}`;
  const tod = timeOfDayList(job);
  if (tod.length) return tod.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(", ");
  return fallback;
}

export interface JobCard {
  jobId: string;
  title: string;
  location: string;
  distanceMiles: number | null;      // "(0.2 mi away)" — only when both sides have coordinates
  rate: string;                      // "$26/hr" or "Flexible"
  paymentMethod: string | null;      // "via credit"
  frequency: string;                 // Occasional / Part-time / Full-time
  day: boolean;                      // Day pill (morning/afternoon)
  night: boolean;                    // Night pill (evening/overnight)
  seniors: number | null;            // "N seniors" pill when > 1
  transportation: boolean;           // Transportation pill
  date: string | null;
  hours: string | null;
  careTypes: string[];
  daysOfWeek: string[];
  // JobBoard.tsx: the button that stands in for Apply Now while gated.
  action: "Apply Now" | "Activate Membership" | "Complete Verification" | "Transportation Badge Required";
}

export const GATE_BUTTON_LABEL: Record<CaregiverGateReason, JobCard["action"]> = {
  membership: "Activate Membership",
  background: "Complete Verification",
  transport:  "Transportation Badge Required",
};

export function caregiverCoords(cg: Doc): { lat: number; lng: number } | null {
  const lat = (cg.latitude ?? cg.lat) as number | undefined;
  const lng = (cg.longitude ?? cg.lng) as number | undefined;
  // JobBoard.tsx: set only when both are truthy.
  return lat && lng ? { lat, lng } : null;
}

export function caregiverRadiusMiles(cg: Doc): number {
  return (cg.serviceRadius as number) || (cg.travelRadius as number) || 0;
}

export function jobDistanceMiles(job: Doc, coords: { lat: number; lng: number } | null): number | null {
  const jLat = job.lat as number | undefined;
  const jLng = job.lng as number | undefined;
  if (!coords || !jLat || !jLng) return null;
  const d = haversineMiles(coords.lat, coords.lng, jLat, jLng);
  return d === undefined ? null : Math.round(d * 10) / 10;
}

export function buildJobCard(job: Doc, cg: Doc, coords: { lat: number; lng: number } | null): JobCard {
  const tod = timeOfDayList(job);
  const careTypes = Array.isArray(job.careTypes) ? (job.careTypes as string[]) : [];
  const recipients = job.recipientsCount as number | undefined;
  const reason = caregiverBlockReason(cg, { transport: jobRequiresTransport(job) });
  return {
    jobId:         job.id as string,
    title:         (job.title as string) ?? "",
    location:      (job.location as string) ?? "",
    distanceMiles: jobDistanceMiles(job, coords),
    rate:          rateLabel(job),
    paymentMethod: typeof job.paymentMethod === "string" && job.paymentMethod ? `via ${job.paymentMethod}` : null,
    frequency:     frequencyLabel(job),
    day:           tod.some((t) => t === "morning" || t === "afternoon"),
    night:         tod.some((t) => t === "evening" || t === "overnight"),
    seniors:       recipients && recipients > 1 ? recipients : null,
    transportation: jobRequiresTransport(job),
    date:          dateLabel(job.date),
    hours:         hoursLabel(job),
    careTypes,
    daysOfWeek:    Array.isArray(job.daysOfWeek) ? (job.daysOfWeek as string[]) : [],
    action:        reason ? GATE_BUTTON_LABEL[reason] : "Apply Now",
  };
}

/** One line per card, in the card's own reading order — what Evia texts for a job. */
export function jobCardLine(card: JobCard): string {
  const where = card.location
    ? `${card.location}${card.distanceMiles != null ? ` (${card.distanceMiles.toFixed(1)} mi away)` : ""}`
    : (card.distanceMiles != null ? `${card.distanceMiles.toFixed(1)} mi away` : "");
  const pills = [card.frequency, card.day ? "Day" : "", card.night ? "Night" : "",
    card.seniors ? `${card.seniors} seniors` : "", card.transportation ? "Transportation" : ""].filter(Boolean).join(" · ");
  return [card.title, where, card.rate, pills, card.date, card.hours].filter(Boolean).join(" · ");
}

// ── Sidebar filters (JobBoard.tsx filteredJobs) ───────────────────────────────
export interface JobBoardFilters {
  search?: string;                 // title / location / requirements substring
  payMin?: number;                 // job.rate < payMin → out (a Flexible job has rate 0)
  payMax?: number;
  timeOfDay?: string[];            // morning | afternoon | evening | overnight — any overlap
  days?: string[];                 // Mon..Sun — any job day starting with the chip
  seniors?: Array<"1" | "2" | "3+">;
  careTypes?: string[];            // exact overlap with job.careTypes
}

export const JOB_BOARD_CARE_TYPES = [
  "Mobility Assistance", "Dementia / Memory Care", "Medication Reminders", "Personal Care",
  "Companionship", "Transportation", "Meal Preparation", "Light Housekeeping",
];

export function passesJobBoardFilters(job: Doc, f: JobBoardFilters | undefined): boolean {
  if (!f) return true;
  const q = (f.search ?? "").trim().toLowerCase();
  if (q) {
    const reqs = Array.isArray(job.requirements) ? (job.requirements as string[]) : [];
    const hit = String(job.title ?? "").toLowerCase().includes(q)
      || String(job.location ?? "").toLowerCase().includes(q)
      || reqs.some((r) => String(r).toLowerCase().includes(q));
    if (!hit) return false;
  }
  const rate = (job.rate as number) ?? 0;
  if (typeof f.payMin === "number" && rate < f.payMin) return false;
  if (typeof f.payMax === "number" && rate > f.payMax) return false;
  if (f.timeOfDay?.length) {
    const tod = timeOfDayList(job);
    if (!f.timeOfDay.some((t) => tod.includes(t))) return false;
  }
  if (f.days?.length) {
    const jDays = Array.isArray(job.daysOfWeek) ? (job.daysOfWeek as string[]) : [];
    if (!f.days.some((d) => jDays.some((jd) => jd.toLowerCase().startsWith(d.toLowerCase())))) return false;
  }
  if (f.seniors?.length) {
    const count = (job.recipientsCount as number) ?? 1;
    const ok = f.seniors.some((s) => (s === "1" ? count === 1 : s === "2" ? count === 2 : s === "3+" ? count >= 3 : false));
    if (!ok) return false;
  }
  if (f.careTypes?.length) {
    const jct = Array.isArray(job.careTypes) ? (job.careTypes as string[]) : [];
    if (!f.careTypes.some((ct) => jct.includes(ct))) return false;
  }
  return true;
}

// JobBoard.tsx radius rule — exclude only when EVERY input is known.
export function withinCaregiverRadius(job: Doc, coords: { lat: number; lng: number } | null, radius: number): boolean {
  const jLat = job.lat as number | undefined;
  const jLng = job.lng as number | undefined;
  if (!coords || !jLat || !jLng || radius <= 0) return true;
  const d = haversineMiles(coords.lat, coords.lng, jLat, jLng);
  return d === undefined ? true : d <= radius;
}

async function caregiverBlockedIds(caregiverId: string): Promise<Set<string>> {
  const u = await db.collection("users").doc(caregiverId).get().catch(() => null);
  const list = (u?.data()?.blockedUsers as string[] | undefined) ?? [];
  return new Set(list);
}

async function appliedJobIds(caregiverId: string): Promise<Set<string>> {
  const snap = await db.collection("job_applications").where("caregiverId", "==", caregiverId).get();
  return new Set(snap.docs.map((d) => d.data().jobId as string).filter(Boolean));
}

export async function loadCaregiverForBoard(caregiverId: string): Promise<Doc | null> {
  const snap = await db.collection("caregivers").doc(caregiverId).get();
  return snap.exists ? { id: snap.id, ...(snap.data() as Doc) } : null;
}

export interface AvailableJobsResult {
  jobs: JobCard[];
  total: number;              // "N jobs found" — after every filter
  hiddenCount: number;        // "View hidden jobs (N)"
  radiusMiles: number;        // 0 = no travel distance set → every open job shows
  hasCoords: boolean;
}

/**
 * The Available Jobs tab (sort "newest", the page's own order) or the
 * dashboard's Nearby Jobs (sort "nearest", limit 4).
 */
export async function loadAvailableJobs(
  caregiverId: string,
  opts: { filters?: JobBoardFilters; sort?: "newest" | "nearest"; limit?: number } = {},
): Promise<AvailableJobsResult | null> {
  const cg = await loadCaregiverForBoard(caregiverId);
  if (!cg) return null;
  const coords = caregiverCoords(cg);
  const radius = caregiverRadiusMiles(cg);
  const hidden = new Set(Array.isArray(cg.hiddenJobIds) ? (cg.hiddenJobIds as string[]) : []);
  const [applied, blocked, snap] = await Promise.all([
    appliedJobIds(caregiverId),
    caregiverBlockedIds(caregiverId),
    db.collection("job_posts").where("status", "==", "open").orderBy("createdAt", "desc").get(),
  ]);
  let jobs = snap.docs
    .map((d) => normalizeJobPost({ id: d.id, ...(d.data() as Doc) }))
    .filter((j) => !applied.has(j.id as string) && !hidden.has(j.id as string) && j.clientActive !== false)
    .filter((j) => !blocked.has(j.clientId as string))
    .filter((j) => passesJobBoardFilters(j, opts.filters))
    .filter((j) => withinCaregiverRadius(j, coords, radius));
  if (opts.sort === "nearest" && coords) {
    jobs = jobs
      .map((j) => ({ j, d: jobDistanceMiles(j, coords) ?? Infinity }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.j);
  }
  const total = jobs.length;
  if (opts.limit && opts.limit > 0) jobs = jobs.slice(0, opts.limit);
  return {
    jobs: jobs.map((j) => buildJobCard(j, cg, coords)),
    total,
    hiddenCount: hidden.size,
    radiusMiles: radius,
    hasCoords: !!coords,
  };
}

// ── Details modal (JobBoard.tsx viewingJob) ───────────────────────────────────
export interface JobDetails extends JobCard {
  postedBy: string | null;          // hidden until this caregiver's application is accepted (founder, 2026-09-27)
  startingDate: string | null;      // startDate || date, same label rule
  time: string | null;              // start–end / time-of-day list, or omitted
  hoursPerWeek: string | null;      // "20+ hrs"
  description: string | null;
  // Footer: the modal shows exactly ONE of these.
  interviewStatus: string | null;   // "Interview Pending" / "Interview Confirmed" / …
  applicationStatus: string | null; // "Application Pending" / "Application Accepted" / …
}

const INTERVIEW_FOOTER: Record<string, string> = {
  pending: "Interview Pending", requested: "Interview Pending", scheduled: "Interview Pending",
  accepted: "Interview Confirmed", confirmed: "Interview Confirmed",
  completed: "Interview Completed", declined: "Interview Declined", cancelled: "Interview Cancelled",
};
const APPLICATION_FOOTER: Record<string, string> = {
  accepted: "Application Accepted", rejected: "Application Rejected", withdrawn: "Application Withdrawn",
};

export type JobDetailsResult =
  | { ok: true; details: JobDetails }
  | { ok: false; reason: "not_found" | "unavailable" | "no_caregiver" };

/** handleViewJobDetails + the modal: refuses blocked / deactivated clients exactly like the page. */
export async function loadJobDetails(caregiverId: string, jobId: string): Promise<JobDetailsResult> {
  const cg = await loadCaregiverForBoard(caregiverId);
  if (!cg) return { ok: false, reason: "no_caregiver" };
  const snap = await db.collection("job_posts").doc(jobId).get();
  if (!snap.exists) return { ok: false, reason: "not_found" };
  const job = normalizeJobPost({ id: snap.id, ...(snap.data() as Doc) });
  const blocked = await caregiverBlockedIds(caregiverId);
  if (blocked.has(job.clientId as string) || job.clientActive === false) return { ok: false, reason: "unavailable" };

  const [appSnap, ivSnap] = await Promise.all([
    db.collection("job_applications").where("caregiverId", "==", caregiverId).where("jobId", "==", jobId).limit(1).get(),
    db.collection("video_interviews").where("caregiverId", "==", caregiverId).where("jobId", "==", jobId).limit(1).get(),
  ]);
  const app = appSnap.docs[0]?.data();
  const iv  = ivSnap.docs[0]?.data();
  const ivStatus = iv ? (INTERVIEW_FOOTER[String(iv.status)] ?? "Interview Scheduled") : null;
  const appStatus = app && !iv ? (APPLICATION_FOOTER[String(app.status)] ?? "Application Pending") : null;
  // "Posted by {clientName}" is not public: it appears once the family has
  // accepted this caregiver (accepted application, or an interview the family
  // requested that is accepted/confirmed/completed).
  const accepted = app?.status === "accepted" || ["accepted", "confirmed", "completed"].includes(String(iv?.status ?? ""));
  const card = buildJobCard(job, cg, caregiverCoords(cg));
  const hrs = job.minHoursPerWeek as number | undefined;
  return {
    ok: true,
    details: {
      ...card,
      postedBy:          accepted ? ((job.clientName as string) ?? null) : null,
      startingDate:      dateLabel(job.startDate ?? job.date),
      time:              hoursLabel(job, null),
      hoursPerWeek:      hrs != null ? `${hrs}+ hrs` : null,
      description:       (job.description as string) || null,
      interviewStatus:   ivStatus,
      applicationStatus: appStatus,
    },
  };
}

// ── Hide / unhide (JobBoard.tsx Hide button + "View hidden jobs" → Unhide) ────
// Stored on caregivers/{uid}.hiddenJobIds so the website and Evia share it.
export async function setJobHidden(caregiverId: string, jobId: string, hidden: boolean): Promise<void> {
  const op = hidden
    ? admin.firestore.FieldValue.arrayUnion(jobId)
    : admin.firestore.FieldValue.arrayRemove(jobId);
  await db.collection("caregivers").doc(caregiverId).set({ hiddenJobIds: op }, { merge: true });
}

/** The hidden tab: hidden jobs that are still open (title, location, rate), like the page. */
export async function loadHiddenJobs(caregiverId: string): Promise<Array<{ jobId: string; title: string; location: string; rate: string }> | null> {
  const cg = await loadCaregiverForBoard(caregiverId);
  if (!cg) return null;
  const hidden = Array.isArray(cg.hiddenJobIds) ? (cg.hiddenJobIds as string[]) : [];
  if (!hidden.length) return [];
  const snap = await db.collection("job_posts").where("status", "==", "open").get();
  return snap.docs
    .filter((d) => hidden.includes(d.id))
    .map((d) => normalizeJobPost({ id: d.id, ...(d.data() as Doc) }))
    .map((j) => ({ jobId: j.id as string, title: (j.title as string) ?? "", location: ((j.location as string) || (j.city as string)) ?? "", rate: rateLabel(j) }));
}
