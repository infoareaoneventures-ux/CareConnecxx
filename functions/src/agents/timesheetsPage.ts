// The website's Timesheets page (components/client/Payments.tsx), read the way
// the page reads it: every shiftHours doc for the family (newest submittedAt
// first), split into the Needs Review pill (six statuses — the family's own
// items AND the "sent, waiting on someone else" ones stay visible) and the
// History pill (approved / auto-approved / paid) with its optional date-range
// report + totals; each row carries exactly what the card shows and which
// button it offers (Review & Approve / Review & Respond / Retry payment).
import * as admin from "firebase-admin";
import { businessTodayStr, formatInterviewTime } from "../utils/scheduledTime";

const db = admin.firestore();

// True while the Timesheets page's "Needs Review" tab has something for this
// family (a submission or a caregiver counter). While it does, a free-text
// message about a clock-in/out or hours is a correction to THAT timesheet,
// never a stored memory fact — the fact-change detector must stand aside
// (live-caught 2026-09-18: "can you change the clock in time to…" was
// acknowledged as a memory update). Two equality queries, no new index.
export async function hasTimesheetAwaitingClient(clientId: string): Promise<boolean> {
  if (!clientId) return false;
  const statuses = ["pending_client_review", "caregiver_counter_proposed"];
  const snaps = await Promise.all(statuses.map((st) =>
    db.collection("shiftHours").where("clientId", "==", clientId).where("status", "==", st).limit(1).get()));
  return snaps.some((snap) => !snap.empty);
}

export type TimesheetsTab = "needs_review" | "history";

export const NEEDS_REVIEW_STATUSES = [
  "pending_client_review", "caregiver_counter_proposed", "payment_failed",
  "correction_proposed", "disputed_admin_review", "requires_admin_review",
] as const;
export const HISTORY_STATUSES = ["approved", "auto_approved", "paid"] as const;

// STATUS_CONFIG labels on the page.
export const STATUS_LABEL: Record<string, string> = {
  pending_client_review: "Needs Review",
  correction_proposed: "Correction Sent",
  caregiver_counter_proposed: "Counter Received",
  approved: "Approved",
  auto_approved: "Auto-Approved",
  disputed_admin_review: "Under Review",
  requires_admin_review: "Under Review",
  paid: "Paid",
  payment_failed: "Payment Failed",
};

// The sentence the card shows under certain statuses.
export const STATUS_HINT: Record<string, string> = {
  correction_proposed: "You proposed a correction. Waiting for the caregiver to accept or send a counter.",
  disputed_admin_review: "This dispute has been escalated to our team and will be resolved within 48 hours.",
  requires_admin_review: "Our team needs to take a closer look at this one before it can be processed. No action needed from you right now.",
  payment_failed: "Payment failed. Please check your card on file in the Payment Method tab.",
};

// HISTORY_ACTION_LABEL on the page (the correction timeline).
export const HISTORY_ACTION_LABEL: Record<string, string> = {
  submitted: "Submitted by caregiver",
  proposed_correction: "Client proposed correction",
  counter_proposed: "Caregiver sent counter",
  accepted: "Accepted",
  escalated: "Escalated to admin",
  admin_resolved: "Resolved by admin",
};

export interface TimesheetRow {
  id: string;
  appointmentId: string | null;
  caregiverId: string | null;
  caregiverName: string;
  date: string | null;
  clockIn: string | null;
  clockOut: string | null;
  clockInLocal: string | null;
  clockOutLocal: string | null;
  hours: number;
  duration: string;
  payRate: number;
  basePay: number;
  lineItems: Array<{ type?: string; label?: string; note?: string; amount?: number }>;
  grossPay: number;
  status: string;
  statusLabel: string;
  statusHint: string | null;
  isCorrected: boolean;
  autoApproveAt: string | null;
  /** Correction Sent only: the proposed window/pay — the row's live figures on the page while the caregiver decides. */
  proposed: { clockIn: string; clockOut: string; clockInLocal: string; clockOutLocal: string; hours: number; duration: string; grossPay: number } | null;
  /** Counter Received only: the caregiver's counter — the row's live figures on the page while the family decides. */
  counter: { clockIn: string; clockOut: string; clockInLocal: string; clockOutLocal: string; hours: number; duration: string; grossPay: number; note: string | null } | null;
  submittedAt: string | null;
  correctionHistory: Array<{ by?: string; action?: string; label: string; at?: string; hours?: number; grossPay?: number; note?: string | null }>;
  /** The card's button: review_and_approve (Needs Review) / review_and_respond (Counter Received) / retry_payment (Payment Failed). */
  actions: string[];
}

const toMs = (v: unknown): number => {
  if (!v) return NaN;
  const t = v as { toMillis?: () => number; seconds?: number };
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t.seconds === "number") return t.seconds * 1000;
  return Date.parse(String(v));
};

// fmtDuration on the page: h:mm:ss.
export function fmtDuration(hours: number): string {
  const totalSecs = Math.round(hours * 3600);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function shapeTimesheetRow(id: string, r: Record<string, unknown>): TimesheetRow {
  // Final times win for corrected shifts; hours are seconds-accurate from the
  // timestamps, falling back to the stored totals — exactly the card's math.
  const startTs = (r.finalStartTime ?? r.submittedStartTime) as string | undefined;
  const endTs = (r.finalEndTime ?? r.submittedEndTime) as string | undefined;
  const startMs = toMs(startTs);
  const endMs = toMs(endTs);
  const hours = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? (endMs - startMs) / 3_600_000
    : Number(r.finalTotalHours ?? r.submittedTotalHours ?? 0);
  const payRate = Number(r.payRate ?? 0);
  const basePay = Math.round(hours * payRate * 100) / 100;
  const lineItems = Array.isArray(r.lineItems) ? (r.lineItems as TimesheetRow["lineItems"]) : [];
  const grossPay = typeof r.grossPay === "number" ? r.grossPay : basePay;
  const status = String(r.status ?? "pending_client_review");
  const history = Array.isArray(r.correctionHistory) ? (r.correctionHistory as Array<Record<string, unknown>>) : [];
  const resolvedBy = String(r.resolvedBy ?? "");
  const isCorrected = ["caregiver", "admin", "system_auto_accept"].includes(resolvedBy)
    || (resolvedBy === "client" && history.some((e) => ["correction_proposed", "counter_proposed", "proposed_correction"].includes(String(e.action))));
  const actions = status === "pending_client_review" ? ["review_and_approve"]
    : status === "caregiver_counter_proposed" ? ["review_and_respond"]
    : status === "payment_failed" ? ["retry_payment"]
    : [];
  return {
    id,
    appointmentId: (r.appointmentId as string | undefined) ?? id,
    caregiverId: (r.caregiverId as string | undefined) ?? null,
    caregiverName: (r.caregiverName as string | undefined) || "Caregiver",
    date: Number.isFinite(startMs) ? businessTodayStr(undefined, new Date(startMs)) : null,
    clockIn: startTs ?? null,
    clockOut: endTs ?? null,
    clockInLocal: Number.isFinite(startMs) ? formatInterviewTime(startMs) : null,
    clockOutLocal: Number.isFinite(endMs) ? formatInterviewTime(endMs) : null,
    hours: Math.round(hours * 100) / 100,
    duration: fmtDuration(hours),
    payRate,
    basePay,
    lineItems,
    grossPay: Math.round(grossPay * 100) / 100,
    status,
    statusLabel: STATUS_LABEL[status] ?? STATUS_LABEL.pending_client_review,
    statusHint: STATUS_HINT[status] ?? null,
    isCorrected,
    autoApproveAt: (r.autoApproveAt as string | undefined) ?? null,
    proposed: (() => {
      if (status !== "correction_proposed" || typeof r.proposedStartTime !== "string" || typeof r.proposedEndTime !== "string") return null;
      const ps = toMs(r.proposedStartTime); const pe = toMs(r.proposedEndTime);
      if (!Number.isFinite(ps) || !Number.isFinite(pe)) return null;
      const ph = (pe - ps) / 3_600_000;
      const pg = typeof r.proposedGrossPay === "number" ? r.proposedGrossPay : Math.round(ph * payRate * 100) / 100;
      return { clockIn: r.proposedStartTime, clockOut: r.proposedEndTime, clockInLocal: formatInterviewTime(ps), clockOutLocal: formatInterviewTime(pe), hours: Math.round(ph * 100) / 100, duration: fmtDuration(ph), grossPay: Math.round(pg * 100) / 100 };
    })(),
    counter: (() => {
      if (status !== "caregiver_counter_proposed" || typeof r.counterStartTime !== "string" || typeof r.counterEndTime !== "string") return null;
      const cs = toMs(r.counterStartTime); const ce = toMs(r.counterEndTime);
      if (!Number.isFinite(cs) || !Number.isFinite(ce)) return null;
      const ch = (ce - cs) / 3_600_000;
      const cg = typeof r.counterGrossPay === "number" ? r.counterGrossPay : Math.round(ch * payRate * 100) / 100;
      return { clockIn: r.counterStartTime, clockOut: r.counterEndTime, clockInLocal: formatInterviewTime(cs), clockOutLocal: formatInterviewTime(ce), hours: Math.round(ch * 100) / 100, duration: fmtDuration(ch), grossPay: Math.round(cg * 100) / 100, note: typeof r.counterNote === "string" && r.counterNote ? r.counterNote : null };
    })(),
    submittedAt: typeof r.submittedAt === "string" ? r.submittedAt : (Number.isFinite(toMs(r.submittedAt)) ? new Date(toMs(r.submittedAt)).toISOString() : null),
    correctionHistory: history
      .filter((e) => e.action !== "submitted")
      .map((e) => ({
        by: e.by as string | undefined,
        action: e.action as string | undefined,
        label: HISTORY_ACTION_LABEL[String(e.action)] ?? String(e.action ?? ""),
        at: e.at as string | undefined,
        hours: typeof e.hours === "number" ? e.hours : undefined,
        grossPay: typeof e.grossPay === "number" ? e.grossPay : undefined,
        note: (e.note as string | null | undefined) ?? null,
      })),
    actions,
  };
}

export interface TimesheetsPage {
  tab: TimesheetsTab;
  counts: { needsReview: number; history: number; pendingReview: number; pending: number };
  rows: TimesheetRow[];
  /** Needs Review is grouped by caregiver on the page, actionable rows first. */
  groups: Array<{ caregiverId: string | null; caregiverName: string; rows: TimesheetRow[] }>;
  /** History report totals (the date-range filter + CSV export summary). */
  report: { from: string | null; to: string | null; shifts: number; hours: number; pay: number } | null;
}

export async function readTimesheetsPage(
  clientId: string,
  opts: { tab?: TimesheetsTab; from?: string; to?: string } = {},
): Promise<TimesheetsPage> {
  const tab: TimesheetsTab = opts.tab === "history" ? "history" : "needs_review";
  const snap = await db.collection("shiftHours").where("clientId", "==", clientId).orderBy("submittedAt", "desc").get();
  const all = snap.docs.map((d) => shapeTimesheetRow(d.id, d.data() as Record<string, unknown>));
  const needsReview = all.filter((r) => (NEEDS_REVIEW_STATUSES as readonly string[]).includes(r.status));
  const history = all.filter((r) => (HISTORY_STATUSES as readonly string[]).includes(r.status));

  const counts = {
    needsReview: needsReview.length,
    history: history.length,
    pendingReview: all.filter((r) => r.status === "pending_client_review").length,
    pending: all.filter((r) => r.status === "pending_client_review" || r.status === "caregiver_counter_proposed").length,
  };

  if (tab === "history") {
    const from = opts.from?.trim() || null;
    const to = opts.to?.trim() || null;
    // reportedRows: filter on the local date of submittedStartTime ?? submittedAt.
    const reported = (from || to)
      ? history.filter((r) => {
          const raw = r.clockIn ?? r.submittedAt;
          if (!raw) return false;
          const d = businessTodayStr(undefined, new Date(toMs(raw)));
          if (from && d < from) return false;
          if (to && d > to) return false;
          return true;
        })
      : history;
    return {
      tab,
      counts,
      rows: reported,
      groups: [],
      report: {
        from, to,
        shifts: reported.length,
        hours: Math.round(reported.reduce((s, r) => s + r.hours, 0) * 100) / 100,
        pay: Math.round(reported.reduce((s, r) => s + r.grossPay, 0) * 100) / 100,
      },
    };
  }

  // Needs Review — group by caregiver, the rows that need the family first.
  const order = (s: string) => (s === "pending_client_review" || s === "caregiver_counter_proposed" ? 0 : 1);
  const groupsMap = new Map<string, { caregiverId: string | null; caregiverName: string; rows: TimesheetRow[] }>();
  for (const r of needsReview) {
    const key = r.caregiverId ?? r.caregiverName;
    if (!groupsMap.has(key)) groupsMap.set(key, { caregiverId: r.caregiverId, caregiverName: r.caregiverName, rows: [] });
    groupsMap.get(key)!.rows.push(r);
  }
  const groups = [...groupsMap.values()].map((g) => ({ ...g, rows: [...g.rows].sort((a, b) => order(a.status) - order(b.status)) }));
  return { tab, counts, rows: needsReview, groups, report: null };
}
