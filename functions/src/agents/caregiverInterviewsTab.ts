// The caregiver's Jobs page > Interviews tab, as data — the server-side twin of
// the Interviews tab in components/caregiver/JobBoard.tsx (2026-09-27).
//
// Same read: video_interviews where caregiverId == uid; requested/scheduled
// read as pending; time = scheduledTime || scheduledAt || scheduledDateTime;
// sorted pending → accepted → confirmed → completed → declined → cancelled,
// then by time; families this caregiver blocked are dropped; the linked
// application supplies the job's location and rate. Same card: job title,
// location, family name, rate, status pill, date + time, type, "Join video
// call" (a Google Meet link, only while pending / accepted / confirmed),
// notes, the reschedule-proposal banner — and `actions` = the exact buttons
// the row shows for its status (gated rows: Decline + the gate button in
// place of Accept). Same empty state: "No interviews yet."
import * as admin from "firebase-admin";
import { parseScheduledTimeMs, formatInterviewTime } from "../utils/scheduledTime";
import { caregiverBlockReason } from "./caregiverAccessGate";
import { GATE_BUTTON_LABEL, rateLabel } from "./jobBoardPage";

const db = admin.firestore();
type Doc = Record<string, unknown>;

export type InterviewTabStatus = "pending" | "accepted" | "confirmed" | "completed" | "declined" | "cancelled";
export const INTERVIEW_TAB_CHIPS = ["all", "pending", "accepted", "completed", "declined", "cancelled"] as const;
export type InterviewTabChip = typeof INTERVIEW_TAB_CHIPS[number];

const STATUS_ORDER: Record<string, number> = { pending: 0, accepted: 1, confirmed: 2, completed: 3, declined: 4, cancelled: 5 };
export const PENDING_STATUSES = ["requested", "scheduled", "pending"];
export const ACCEPTED_STATUSES = ["accepted", "confirmed"];

/** JobBoard.tsx: requested / scheduled → pending; everything else as stored. */
export function displayInterviewStatus(raw: unknown): InterviewTabStatus {
  const s = String(raw || "pending");
  if (s === "requested" || s === "scheduled") return "pending";
  return s as InterviewTabStatus;
}

/** JobBoard.tsx normalizeDate: scheduledTime || scheduledAt || scheduledDateTime, Timestamp or string. */
export function interviewTimeIso(iv: Doc): string | null {
  const raw = iv.scheduledTime ?? iv.scheduledAt ?? iv.scheduledDateTime;
  if (!raw) return null;
  const asTs = raw as { toDate?: () => Date };
  if (typeof asTs?.toDate === "function") return asTs.toDate().toISOString();
  return String(raw);
}

function localLabel(iso: string | null): string | null {
  if (!iso) return null;
  const ms = parseScheduledTimeMs(iso);
  return Number.isNaN(ms) ? null : formatInterviewTime(ms);
}

export function interviewTypeLabel(iv: Doc): "Video" | "Phone" | "In Person" {
  const t = String(iv.interviewType || "video");
  if (t === "in-person") return "In Person";
  if (t === "phone") return "Phone";
  return "Video";
}

/** JobBoard.tsx: the Join button shows only for a Google Meet link while pending / accepted / confirmed. */
export function joinVideoCallUrl(iv: Doc, status: InterviewTabStatus): string | null {
  const url = iv.callUrl as string | undefined;
  if (!url || !url.startsWith("https://meet.google.com/")) return null;
  return ["pending", "accepted", "confirmed"].includes(status) ? url : null;
}

export type InterviewAction =
  | "Details" | "Accept" | "Decline" | "Cancel" | "Propose new time" | "Reschedule"
  | "Propose different time" | "Accept new time" | "Join video call"
  | "Activate Membership" | "Complete Verification";

/**
 * The footer buttons for one row, exactly as JobBoard.tsx renders them.
 * `gate` is the page's blockReason (membership → background); it applies to
 * PENDING rows only — an accepted interview is already agreed.
 */
export function interviewActions(
  status: InterviewTabStatus,
  proposal: { by: "caregiver" | "client" } | null,
  gate: "membership" | "background" | null,
  join: string | null,
): InterviewAction[] {
  const actions: InterviewAction[] = ["Details"];
  if (join) actions.push("Join video call");
  if (status === "pending" && gate) {
    actions.push("Decline", gate === "membership" ? "Activate Membership" : "Complete Verification");
    return actions;
  }
  if (status === "pending" || status === "accepted" || status === "confirmed") {
    const endAction: InterviewAction = status === "pending" ? "Decline" : "Cancel";
    if (proposal?.by === "caregiver") { actions.push(endAction); return actions; }          // own proposal out: only end it
    if (proposal?.by === "client") { actions.push("Propose different time", endAction, "Accept new time"); return actions; }
    if (status === "pending") { actions.push("Propose new time", "Decline", "Accept"); return actions; }
    actions.push("Reschedule", "Cancel");
    return actions;
  }
  return actions; // completed / declined / cancelled: Details only
}

export interface CaregiverInterviewRow {
  interviewId: string;
  jobId: string | null;
  jobTitle: string;                 // "Interview" when the request has no job
  jobLocation: string | null;       // from the linked application
  clientId: string | null;
  clientName: string;
  rate: string | null;              // "$26/hr" / "Flexible", only when an application is linked
  status: InterviewTabStatus;       // the pill
  rawStatus: string;
  scheduledTime: string | null;
  scheduledTimeLocal: string | null;
  interviewType: "Video" | "Phone" | "In Person";
  joinVideoCall: string | null;
  notes: string | null;
  proposal: { time: string; timeLocal: string | null; by: "caregiver" | "client"; banner: string } | null;
  actions: InterviewAction[];
}

export interface CaregiverInterviewsTab {
  interviews: CaregiverInterviewRow[];
  count: number;
  chip: InterviewTabChip;
  emptyText?: string;
}

export async function listCaregiverInterviews(caregiverId: string, chip: string | undefined = "all"): Promise<CaregiverInterviewsTab> {
  const filter: InterviewTabChip = (INTERVIEW_TAB_CHIPS as readonly string[]).includes(String(chip ?? "all")) ? (chip as InterviewTabChip) : "all";
  const [cgSnap, userSnap, ivSnap, appSnap] = await Promise.all([
    db.collection("caregivers").doc(caregiverId).get(),
    db.collection("users").doc(caregiverId).get().catch(() => null),
    db.collection("video_interviews").where("caregiverId", "==", caregiverId).get(),
    db.collection("job_applications").where("caregiverId", "==", caregiverId).get(),
  ]);
  const cg = (cgSnap.exists ? cgSnap.data() : {}) as Doc;
  const blocked = new Set<string>((userSnap?.data()?.blockedUsers as string[] | undefined) ?? []);
  const gate = caregiverBlockReason(cg) as "membership" | "background" | null;
  const appByJob = new Map<string, Doc>();
  for (const d of appSnap.docs) { const a = d.data(); if (a.jobId) appByJob.set(String(a.jobId), a); }

  const rows = ivSnap.docs
    .map((d) => ({ id: d.id, iv: d.data() as Doc }))
    .filter(({ iv }) => !blocked.has(String(iv.clientId ?? "")))
    .map(({ id, iv }) => {
      const status = displayInterviewStatus(iv.status);
      const time = interviewTimeIso(iv);
      const app = iv.jobId ? appByJob.get(String(iv.jobId)) : undefined;
      const join = joinVideoCallUrl(iv, status);
      const proposalTime = iv.reschedulePendingTime as string | undefined;
      const by: "caregiver" | "client" | null = iv.rescheduledBy === "caregiver" ? "caregiver" : iv.rescheduledBy === "client" ? "client" : null;
      const clientName = String(iv.clientName || "Client");
      const proposal: CaregiverInterviewRow["proposal"] = proposalTime && by
        ? {
            time: proposalTime,
            timeLocal: localLabel(proposalTime),
            by,
            banner: by === "client"
              ? `${clientName} proposed a new time: ${localLabel(proposalTime) ?? proposalTime}`
              : `You proposed a new time: ${localLabel(proposalTime) ?? proposalTime} — waiting on the family to confirm`,
          }
        : null;
      const row: CaregiverInterviewRow & { _sortMs: number } = {
        interviewId: id,
        jobId: (iv.jobId as string) ?? null,
        jobTitle: String(iv.jobTitle || "Interview"),
        jobLocation: (app?.jobLocation as string) ?? null,
        clientId: (iv.clientId as string) ?? null,
        clientName,
        rate: app ? rateLabel({ rate: app.jobRate, rateFlexible: app.jobRateFlexible }) : null,
        status,
        rawStatus: String(iv.status || "pending"),
        scheduledTime: time,
        scheduledTimeLocal: localLabel(time),
        interviewType: interviewTypeLabel(iv),
        joinVideoCall: join,
        notes: (iv.notes as string) || null,
        proposal,
        actions: interviewActions(status, proposal, gate, join),
        _sortMs: time ? (Number.isNaN(parseScheduledTimeMs(time)) ? Date.parse(time) || 0 : parseScheduledTimeMs(time)) : 0,
      };
      return row;
    })
    .sort((a, b) => {
      const so = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
      return so !== 0 ? so : a._sortMs - b._sortMs;
    })
    .filter((r) => filter === "all" || r.status === filter)
    .map(({ _sortMs, ...row }) => row);

  return {
    interviews: rows,
    count: rows.length,
    chip: filter,
    ...(ivSnap.docs.length === 0 ? { emptyText: "No interviews yet." } : {}),
  };
}

/** Site's 30-minute picker: 9:00–18:00 on the hour or half hour. */
export function isSiteInterviewSlot(hhmm: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return false;
  const h = Number(m[1]); const mm = Number(m[2]);
  if (mm !== 0 && mm !== 30) return false;
  if (h < 9 || h > 18) return false;
  if (h === 18 && mm !== 0) return false;
  return true;
}
export { GATE_BUTTON_LABEL };
