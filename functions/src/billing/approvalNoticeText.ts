// The "please review" text a family gets when a caregiver submits hours — the
// Timesheets card (components/client/Payments.tsx ShiftRow + the caregiver's
// SubmitShiftHoursModal) in words: caregiver, date, clock in/out, duration
// (h:mm:ss), the scheduled window, base pay at the rate, each additional
// charge, the total, and whether it auto-approves (and when) or needs the
// family — same facts the page shows, nothing the page doesn't.
import { formatClockTime, formatDateWithWeekday, formatInterviewTimeShort } from "../utils/scheduledTime";
import { serviceFeeCentsFor } from "./shiftBillingAmounts";
import { SHIFT_PLATFORM_FEE_RATE } from "./config";

export const SERVICE_FEE_LABEL = `Service fee (${Math.round(SHIFT_PLATFORM_FEE_RATE * 100)}%)`;

export interface ApprovalNoticePayload {
  caregiverName?: string;
  date?: string | null;
  totalHours?: number;
  bookedRate?: number;
  lineItems?: Array<{ type?: string; label?: string; note?: string; amount?: number }>;
  grossPayCents?: number;
  basePayCents?: number;
  lineItemsTotalCents?: number;
  submittedStartTime?: string | null;
  submittedEndTime?: string | null;
  scheduledStartMs?: number | null;
  scheduledEndMs?: number | null;
  requiresExplicitApproval?: boolean;
  outsideScheduledWindow?: boolean;
  autoApproveAt?: string | null;
}

// fmtDuration on the page: h:mm:ss.
export function fmtDuration(hours: number): string {
  const totalSecs = Math.round((Number(hours) || 0) * 3600);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function buildApprovalNoticeText(p: ApprovalNoticePayload): string {
  const caregiverName = p.caregiverName || "Your caregiver";
  const dateLabel = p.date ? formatDateWithWeekday(String(p.date)) : "the completed visit";
  const startMs = p.submittedStartTime ? Date.parse(p.submittedStartTime) : NaN;
  const endMs = p.submittedEndTime ? Date.parse(p.submittedEndTime) : NaN;
  const hours = Number(p.totalHours ?? 0);
  const rate = Number(p.bookedRate ?? 0);
  const basePay = p.basePayCents != null ? p.basePayCents / 100 : Math.round(hours * rate * 100) / 100;
  const lineItems = Array.isArray(p.lineItems) ? p.lineItems : [];
  const total = (Number(p.grossPayCents ?? 0) / 100).toFixed(2);

  const lines: string[] = [`${caregiverName} submitted hours for ${dateLabel}:`];
  lines.push(Number.isFinite(startMs) && Number.isFinite(endMs)
    ? `• Clock in ${formatClockTime(startMs)} → clock out ${formatClockTime(endMs)} (${fmtDuration(hours)})`
    : `• ${fmtDuration(hours)} worked`);
  if (p.scheduledStartMs && p.scheduledEndMs) {
    lines.push(`• Scheduled ${formatClockTime(p.scheduledStartMs)}–${formatClockTime(p.scheduledEndMs)}`);
  }
  lines.push(`• Base pay: ${fmtDuration(hours)} @ $${rate}/hr = $${basePay.toFixed(2)}`);
  lines.push(lineItems.length
    ? `• Additional charges: ${lineItems.map((li) => `${li.label || li.type || "charge"} $${Number(li.amount ?? 0).toFixed(2)}${li.note ? ` (${li.note})` : ""}`).join(", ")}`
    : "• No additional charges");
  lines.push(`• Total: $${total}`);
  // The family's side of the card: the fee and what actually goes on their card.
  const grossCents = Number(p.grossPayCents ?? 0);
  const feeCents = serviceFeeCentsFor(grossCents);
  lines.push(`• ${SERVICE_FEE_LABEL}: $${(feeCents / 100).toFixed(2)}`);
  lines.push(`• Charged to your card: $${((grossCents + feeCents) / 100).toFixed(2)}`);
  lines.push("");

  if (p.autoApproveAt) {
    const ms = Date.parse(p.autoApproveAt);
    lines.push(Number.isFinite(ms)
      ? `Auto-approves ${formatInterviewTimeShort(ms)} unless you review it first.`
      : "Auto-approves in 24 hours unless you review it first.");
  } else {
    // The page hides "Auto-approves" on these; the caregiver's modal says why.
    const reason = lineItems.length
      ? "because of the additional charges"
      : p.outsideScheduledWindow
        ? "because the hours fall outside the scheduled visit"
        : "because the total is over $500";
    lines.push(`This one needs your approval — it won't auto-approve ${reason}.`);
  }
  lines.push("Reply APPROVE to release payment, or tell me the correct clock-in and clock-out and I'll propose a correction.");
  return lines.join("\n");
}
