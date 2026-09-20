import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Clock, CreditCard, CheckCircle, AlertTriangle, Loader2, RefreshCw,
  ChevronDown, ChevronUp, ExternalLink,
  AlertCircle, FileDown,
} from 'lucide-react';
import { ClientNavigation } from './ClientNavigation';
import { useCareConnex } from '../../context/CareConnexContext';
import { db } from '../../lib/firebase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { shiftHoursService } from '../../services/api';
import { getClientBillingPortalUrl, getClientPaymentMethodStatus } from '../../services/stripeService';
import { ReviewShiftHoursModal } from '../payroll/ReviewShiftHoursModal';
import { serviceFeeDollars, totalChargedDollars, serviceFeeLabel, SERVICE_FEE_PERCENT_LABEL } from '../../utils/pricing';

type Tab = 'timesheets' | 'payment-method';

type ShiftHoursStatus =
  | 'pending_client_review'
  | 'correction_proposed'
  | 'caregiver_counter_proposed'
  | 'approved'
  | 'auto_approved'
  | 'disputed_admin_review'
  | 'requires_admin_review'
  | 'paid'
  | 'payment_failed';

type StatusFilter = 'needs-review' | 'history';

interface LineItem {
  type: string;
  label: string;
  note: string;
  amount: number;
}

interface CorrectionHistoryEntry {
  by: string;
  action: string;
  at: string;
  startTime?: string;
  endTime?: string;
  hours?: number;
  note?: string;
  basePay?: number;
  lineItems?: LineItem[];
  lineItemsTotal?: number;
  grossPay?: number;
}

interface ShiftHoursRow {
  id: string;
  appointmentId: string;
  caregiverId: string;
  caregiverName: string;
  caregiverPhotoURL?: string | null;
  clientId: string;
  clientName: string;
  payRate: number;
  paymentMethod: 'credit';
  submittedStartTime: string;
  submittedEndTime: string;
  submittedTotalHours: number;
  finalStartTime?: string;
  finalEndTime?: string;
  finalTotalHours?: number;
  resolvedBy?: string;
  counterStartTime?: string;
  counterEndTime?: string;
  counterTotalHours?: number;
  counterGrossPay?: number;
  proposedStartTime?: string;
  proposedEndTime?: string;
  proposedTotalHours?: number;
  proposedGrossPay?: number;
  counterNote?: string;
  correctionHistory?: CorrectionHistoryEntry[];
  lineItems?: LineItem[];
  lineItemsTotal?: number;
  basePay?: number;
  grossPay?: number;
  /** Written by the backend at every amount write (2026-09-19): the fee and the family's charge as they stood — history must show what was charged, not what today's rate would say. */
  serviceFeeCents?: number;
  totalChargeCents?: number;
  submittedAt: string;
  autoApproveAt: string | null;
  status: ShiftHoursStatus;
  loggedManually?: boolean;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
}
function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${fmtTime(iso)}`;
}
/** The family's fee / charge for a row: the backend-recorded values when present, else the same arithmetic as the backend (utils/pricing.ts). */
function feeFor(r: { serviceFeeCents?: number }, gross: number): number {
  return typeof r.serviceFeeCents === 'number' ? r.serviceFeeCents / 100 : serviceFeeDollars(gross);
}
function chargedFor(r: { totalChargeCents?: number }, gross: number): number {
  return typeof r.totalChargeCents === 'number' ? r.totalChargeCents / 100 : totalChargedDollars(gross);
}
function fmtAmount(hours: number, rate: number) {
  return `$${(hours * rate).toFixed(2)}`;
}
/** 0:00:11 · 1:30:05 · 2:00:00 (HH:MM:SS) */
function fmtDuration(hours: number): string {
  const totalSecs = Math.round(hours * 3600);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const STATUS_CONFIG: Record<ShiftHoursStatus, { label: string; color: string; bg: string; border: string }> = {
  pending_client_review:     { label: 'Needs Review',      color: 'text-amber-700',   bg: 'bg-amber-50',   border: 'border-amber-200' },
  correction_proposed:       { label: 'Correction Sent',   color: 'text-orange-700',  bg: 'bg-orange-50',  border: 'border-orange-200' },
  caregiver_counter_proposed:{ label: 'Counter Received',  color: 'text-yellow-700',  bg: 'bg-yellow-50',  border: 'border-yellow-200' },
  approved:                  { label: 'Approved',           color: 'text-blue-700',    bg: 'bg-blue-50',    border: 'border-blue-200' },
  auto_approved:             { label: 'Auto-Approved',      color: 'text-blue-700',    bg: 'bg-blue-50',    border: 'border-blue-200' },
  disputed_admin_review:     { label: 'Under Review',       color: 'text-purple-700',  bg: 'bg-purple-50',  border: 'border-purple-200' },
  requires_admin_review:     { label: 'Under Review',       color: 'text-purple-700',  bg: 'bg-purple-50',  border: 'border-purple-200' },
  paid:                      { label: 'Paid',               color: 'text-green-700',   bg: 'bg-green-50',   border: 'border-green-200' },
  payment_failed:            { label: 'Payment Failed',     color: 'text-red-700',     bg: 'bg-red-50',     border: 'border-red-200' },
};

// Needs Review also carries the "sent and waiting on someone else" states
// (correction_proposed — client already proposed a correction, caregiver
// hasn't responded yet; disputed_admin_review — escalated, waiting on admin;
// requires_admin_review — a billing/notice step failed and needs our team,
// e.g. a stuck payout or an approval notice that couldn't be delivered) so
// those shifts stay visible instead of disappearing until they resolve.
const NEEDS_REVIEW_STATUSES: ShiftHoursStatus[] = [
  'pending_client_review', 'caregiver_counter_proposed', 'payment_failed',
  'correction_proposed', 'disputed_admin_review', 'requires_admin_review',
];

const HISTORY_ACTION_LABEL: Record<string, string> = {
  submitted:           'Submitted by caregiver',
  proposed_correction: 'Client proposed correction',
  counter_proposed:    'Caregiver sent counter',
  accepted:            'Accepted',
  escalated:           'Escalated to admin',
  admin_resolved:      'Resolved by admin',
};

const CorrectionTimeline: React.FC<{
  history: CorrectionHistoryEntry[];
  payRate?: number;
  submittedLineItems?: LineItem[];
  submittedBasePay?: number;
  submittedGrossPay?: number;
}> = ({ history, payRate, submittedLineItems, submittedBasePay, submittedGrossPay }) => {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (i: number) => setExpanded(prev => {
    const next = new Set(prev);
    next.has(i) ? next.delete(i) : next.add(i);
    return next;
  });
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Correction history</p>
      {history.map((entry, i) => {
        const isOpen = expanded.has(i);
        const isSubmitted = entry.action === 'submitted';
        const entryBasePay = entry.basePay ?? (isSubmitted ? submittedBasePay : null) ?? (entry.hours != null && payRate ? Math.round(entry.hours * payRate * 100) / 100 : null);
        const entryLineItems = (Array.isArray(entry.lineItems) && entry.lineItems.length > 0) ? entry.lineItems : (isSubmitted ? submittedLineItems : undefined);
        const entryGrossPay  = entry.grossPay ?? (isSubmitted ? submittedGrossPay : null);
        const hasReceipt = !!(entry.startTime && entry.endTime && entry.hours != null);
        const ts = new Date(entry.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          + ', '
          + new Date(entry.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        return (
          <div key={i} className="flex gap-3 text-xs">
            <div className="flex flex-col items-center shrink-0">
              <div className="w-2 h-2 rounded-full bg-slate-300 mt-2.5" />
              {i < history.length - 1 && <div className="w-px flex-1 bg-slate-200 mt-1" />}
            </div>
            <div className="pb-2 flex-1 min-w-0">
              {/* Row header — always visible, clickable if has receipt */}
              <div
                className={`flex items-center justify-between ${hasReceipt ? 'cursor-pointer select-none' : ''}`}
                onClick={() => hasReceipt && toggle(i)}
              >
                <div>
                  <p className="font-semibold text-slate-700">{HISTORY_ACTION_LABEL[entry.action] || entry.action}</p>
                  <p className="text-slate-400 mt-0.5">{ts}</p>
                </div>
                {hasReceipt && (
                  isOpen
                    ? <ChevronUp className="w-3.5 h-3.5 text-slate-400 shrink-0 ml-2" />
                    : <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0 ml-2" />
                )}
              </div>

              {/* Expanded receipt */}
              {isOpen && hasReceipt && (
                <div className="mt-1.5 divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden bg-white">
                  <div className="flex items-center justify-between px-3 py-1.5">
                    <span className="text-slate-400">Time</span>
                    <span className="font-medium text-slate-700">
                      {fmtTime(entry.startTime!)} – {fmtTime(entry.endTime!)} · {fmtDuration(entry.hours!)}
                    </span>
                  </div>
                  {payRate != null && entryBasePay != null && (
                    <div className="flex items-center justify-between px-3 py-1.5">
                      <span className="text-slate-400">${payRate}/hr · Base</span>
                      <span className="font-medium text-slate-700">${entryBasePay.toFixed(2)}</span>
                    </div>
                  )}
                  {Array.isArray(entryLineItems) && entryLineItems.map((li, j) => (
                    <div key={j} className="flex items-center justify-between px-3 py-1.5">
                      <span className="text-slate-400">{li.label || li.type}{li.note ? ` · ${li.note}` : ''}</span>
                      <span className="font-medium text-slate-700">+${Number(li.amount).toFixed(2)}</span>
                    </div>
                  ))}
                  {entryGrossPay != null && (
                    <>
                      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-50">
                        <span className="font-semibold text-slate-600">Total</span>
                        <span className="font-bold text-slate-900">${entryGrossPay.toFixed(2)}</span>
                      </div>
                      <div className="flex items-center justify-between px-3 py-1.5">
                        <span className="text-slate-400">{serviceFeeLabel(entryGrossPay)} · charged ${totalChargedDollars(entryGrossPay).toFixed(2)}</span>
                        <span className="font-medium text-slate-700">${serviceFeeDollars(entryGrossPay).toFixed(2)}</span>
                      </div>
                    </>
                  )}
                  {entry.note && (
                    <div className="px-3 py-1.5 text-slate-400 italic">"{entry.note}"</div>
                  )}
                </div>
              )}
              {!hasReceipt && entry.note && (
                <p className="text-slate-400 mt-0.5 italic">"{entry.note}"</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const CaregiverAvatar: React.FC<{ name?: string; photoURL?: string | null; size?: string }> = ({
  name = 'C', photoURL, size = 'w-10 h-10',
}) => {
  const [err, setErr] = useState(false);
  const initials = name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className={`${size} rounded-full overflow-hidden bg-primary-100 flex items-center justify-center shrink-0`}>
      {photoURL && !err
        ? <img src={photoURL} alt={name} className="w-full h-full object-cover" onError={() => setErr(true)} />
        : <span className="text-primary-700 font-bold text-sm">{initials}</span>
      }
    </div>
  );
};

// ── ShiftRow ──────────────────────────────────────────────────────────────────

const ShiftRow: React.FC<{
  row: ShiftHoursRow;
  onReview: (row: ShiftHoursRow) => void;
  hideCaregiver?: boolean;
}> = ({ row, onReview, hideCaregiver }) => {
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setRetrying(true);
    setRetryError(null);
    try {
      await shiftHoursService.retryPayment(row.id);
    } catch (err: any) {
      setRetryError(err?.message || 'Retry failed. Please update your payment method and try again.');
    } finally {
      setRetrying(false);
    }
  };
  const [shiftDetails, setShiftDetails] = useState<any>(null);

  const cfg = STATUS_CONFIG[row.status] || STATUS_CONFIG.pending_client_review;
  // Compute hours from actual timestamps (seconds-accurate). Final times take
  // priority for corrected shifts; fall back to stored value if timestamps missing.
  const startTs = row.finalStartTime ?? row.submittedStartTime;
  const endTs   = row.finalEndTime   ?? row.submittedEndTime;
  const dispHours = (startTs && endTs)
    ? (new Date(endTs).getTime() - new Date(startTs).getTime()) / 3_600_000
    : (row.finalTotalHours ?? row.submittedTotalHours);
  const basePay   = dispHours * row.payRate;
  const hasExtras = row.lineItems && row.lineItems.length > 0;
  // Use stored grossPay (includes line items) when available
  const totalPay  = row.grossPay ?? basePay;
  // While a correction is pending (Correction Sent), the only live figures are
  // the proposed ones — that is what the caregiver is deciding on and what will
  // most likely be charged — so the row shows them, marked, with the submitted
  // figures beneath the status. Resolved rows show the final figures as before.
  // Same for a caregiver COUNTER (Counter Received): the counter's figures are
  // what the family is deciding on.
  const proposalPending = row.status === 'correction_proposed' && !!row.proposedStartTime && !!row.proposedEndTime;
  const counterPending  = row.status === 'caregiver_counter_proposed' && !!row.counterStartTime && !!row.counterEndTime;
  const livePending = proposalPending || counterPending;
  const liveLabel = proposalPending ? 'Proposed' : 'Counter';
  const shownStart = proposalPending ? row.proposedStartTime! : counterPending ? row.counterStartTime! : startTs;
  const shownEnd   = proposalPending ? row.proposedEndTime!   : counterPending ? row.counterEndTime!   : endTs;
  const shownHours = livePending
    ? (new Date(shownEnd).getTime() - new Date(shownStart).getTime()) / 3_600_000
    : dispHours;
  const shownPay   = proposalPending ? (row.proposedGrossPay ?? Math.round(shownHours * row.payRate * 100) / 100)
    : counterPending ? (row.counterGrossPay ?? Math.round(shownHours * row.payRate * 100) / 100)
    : totalPay;
  const isPending = row.status === 'pending_client_review' || row.status === 'caregiver_counter_proposed';
  // Show "Corrected" whenever the correction flow was triggered (client proposed, caregiver countered, or admin resolved)
  const isCorrected = ['caregiver', 'admin', 'system_auto_accept'].includes(row.resolvedBy ?? '')
    || (row.resolvedBy === 'client' && Array.isArray(row.correctionHistory) && row.correctionHistory.some((e: any) => ['correction_proposed', 'counter_proposed'].includes(e.action)));

  // Lazy-load shift details on expand
  useEffect(() => {
    if (!expanded || shiftDetails || !db) return;
    // Try shifts collection first, fall back to appointments
    db.collection('shifts').doc(row.appointmentId).get()
      .then(snap => snap.exists ? setShiftDetails(snap.data()) : null)
      .catch(() => null);
  }, [expanded, row.appointmentId]);

  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
      {/* Main row — flex with dividers matching caregiver side */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 transition-colors select-none"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="shrink-0 w-[58px]"><p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Date</p><p className="text-sm font-semibold text-primary-600 mt-0.5">{new Date(row.submittedStartTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p></div>
        <div className="w-px h-8 bg-slate-100 shrink-0" />
        <div className="shrink-0 w-[88px]"><p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{livePending ? `${liveLabel} in` : 'In'}</p><p className="text-sm text-slate-700 mt-0.5">{fmtTime(shownStart)}</p></div>
        <div className="w-px h-8 bg-slate-100 shrink-0" />
        <div className="shrink-0 w-[88px]"><p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{livePending ? `${liveLabel} out` : 'Out'}</p><p className="text-sm text-slate-700 mt-0.5">{fmtTime(shownEnd)}</p></div>
        <div className="w-px h-8 bg-slate-100 shrink-0" />
        <div className="shrink-0 w-[62px]"><p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Duration</p><p className="text-sm text-slate-700 mt-0.5">{shownHours > 0 ? fmtDuration(shownHours) : '—'}</p></div>
        <div className="w-px h-8 bg-slate-100 shrink-0" />
        <div className="shrink-0 w-[60px]"><p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{livePending ? liveLabel : 'Pay'}</p><p className="text-sm font-bold text-slate-900 mt-0.5">${shownPay.toFixed(2)}</p></div>
        <div className="w-px h-8 bg-slate-100 shrink-0" />
        <div className="shrink-0 w-[46px]">
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Method</p>
          <div className="flex items-center gap-1 text-xs text-slate-600 mt-0.5">
            <CreditCard className="w-3 h-3" />
            <span>Card</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 ml-auto shrink-0">
          <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${cfg.color} ${cfg.bg} ${cfg.border}`}>{cfg.label}</span>
          {livePending && (
            <span className="text-[10px] text-slate-400 whitespace-nowrap">
              Submitted {fmtTime(startTs)}–{fmtTime(endTs)} · ${totalPay.toFixed(2)}
              {counterPending && row.proposedStartTime && row.proposedEndTime && <> · You proposed {fmtTime(row.proposedStartTime)}–{fmtTime(row.proposedEndTime)}</>}
            </span>
          )}
          {(isCorrected || row.loggedManually) && (
            <div className="flex items-center gap-1 flex-wrap justify-end">
              {isCorrected && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-teal-50 text-teal-700 border-teal-200">Corrected</span>}
              {row.loggedManually && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-slate-100 text-slate-500 border-slate-200">Logged</span>}
            </div>
          )}
        </div>
        <div className="shrink-0 text-slate-400">{expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-slate-100 px-5 py-4 bg-slate-50 space-y-4">
          {/* Times */}
          <div className="space-y-1">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Hours</p>
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden text-xs">
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-500">Rate</span>
                <span className="font-semibold text-slate-700">${row.payRate}/hr</span>
              </div>
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-500">{isCorrected ? 'Final in / out' : row.loggedManually ? 'Reported in / out' : 'Clock in / out'}</span>
                <span className="font-semibold text-slate-700">
                  {fmtDateTime(startTs)} – {fmtDateTime(endTs)}
                </span>
              </div>
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-500">Total hours</span>
                <span className="font-semibold text-slate-700">{fmtDuration(dispHours)}</span>
              </div>
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-500">Base pay</span>
                <span className="font-semibold text-slate-700">{fmtAmount(dispHours, row.payRate)}</span>
              </div>
              {row.status === 'pending_client_review' && (
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-slate-500">Auto-approves</span>
                  {row.autoApproveAt
                    ? <span className="text-slate-500">{fmtDate(row.autoApproveAt)}</span>
                    : <span className="text-amber-700 font-medium text-right">No — needs your approval (hours fall outside the scheduled visit or need a look)</span>}
                </div>
              )}
            </div>
          </div>

          {/* What goes on the family's card — the caregiver's total plus the
              service fee (founder decision 2026-09-19: 9%, $1 minimum). The same
              arithmetic as the backend charge (utils/pricing.ts mirrors
              billing/shiftBillingAmounts.ts), so this can never disagree with it. */}
          <div className="space-y-1">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Your card</p>
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden text-xs">
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-500">Caregiver total</span>
                <span className="font-semibold text-slate-700">${shownPay.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-500">{serviceFeeLabel(shownPay, livePending ? serviceFeeDollars(shownPay) : feeFor(row, shownPay))}</span>
                <span className="font-semibold text-slate-700">${(livePending ? serviceFeeDollars(shownPay) : feeFor(row, shownPay)).toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between px-3 py-2.5 bg-slate-50">
                <span className="font-semibold text-slate-700">{['approved', 'auto_approved', 'paid'].includes(row.status) ? 'Charged to your card' : livePending ? `${liveLabel} charge` : row.status === 'payment_failed' ? 'Charge failed' : 'Will be charged'}</span>
                <span className="font-bold text-slate-900">${(livePending ? totalChargedDollars(shownPay) : chargedFor(row, shownPay)).toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Line items */}
          {hasExtras && (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Additional charges</p>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden text-xs">
                {row.lineItems!.map((li, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2">
                    <span className="text-slate-600">
                      {li.type === 'custom' ? (li.label || 'Custom') : li.label}
                      {li.note ? <span className="text-slate-400"> · {li.note}</span> : null}
                    </span>
                    <span className="font-semibold text-slate-700">+${li.amount.toFixed(2)}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between px-3 py-2.5 bg-slate-50">
                  <span className="font-semibold text-slate-700">Total</span>
                  <span className="font-bold text-slate-900">${totalPay.toFixed(2)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Shift details if loaded */}
          {shiftDetails && (
            <>
              {/* Care recipients + tasks — care plan card format */}
              {(() => {
                const doneRaw: string[] = shiftDetails.tasksCompleted || [];
                const recipients: any[] = shiftDetails.careRecipients || [];
                const hasTasks = recipients.some((r: any) => (r.careNeeds || []).length > 0);
                if (!hasTasks && doneRaw.length === 0) return null;

                let totalT = 0; let doneT = 0;
                recipients.forEach((r: any, ri: number) => {
                  (r.careNeeds || []).forEach((cat: string) => {
                    const subs = (r.careNeedDetails || {})[cat] || [];
                    if (subs.length > 0) {
                      totalT += subs.length;
                      doneT += subs.filter((s: string) => doneRaw.includes(`${ri}_${cat}_${s}`)).length;
                    } else {
                      totalT += 1;
                      doneT += doneRaw.includes(`${ri}_${cat}`) ? 1 : 0;
                    }
                  });
                });

                return (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Tasks</p>
                      {totalT > 0 && (
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${doneT === totalT ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                          {doneT}/{totalT}
                        </span>
                      )}
                    </div>
                    <div className="space-y-3">
                      {hasTasks
                        ? recipients.map((r: any, ri: number) => {
                            const cats: string[] = r.careNeeds || [];
                            const det: Record<string, string[]> = r.careNeedDetails || {};
                            if (cats.length === 0) return null;
                            return (
                              <div key={ri}>
                                <div className="flex items-center gap-1.5 mb-1.5">
                                  <div className="w-5 h-5 rounded-full overflow-hidden bg-primary-100 shrink-0 flex items-center justify-center">
                                    {r.photoURL
                                      ? <img src={r.photoURL} alt={r.name} className="w-full h-full object-cover" />
                                      : <span className="text-[9px] font-bold text-primary-600">{(r.name || '?').split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase()}</span>}
                                  </div>
                                  <p className="text-xs font-semibold text-slate-600">
                                    {r.name}{r.relationship ? ` · ${r.relationship}` : ''}{r.age ? ` · Age ${r.age}` : ''}
                                  </p>
                                </div>
                                <div className="space-y-1.5">
                                  {cats.map((cat: string, ci: number) => {
                                    const subs = det[cat] || [];
                                    const doneSubCount = subs.filter((s: string) => doneRaw.includes(`${ri}_${cat}_${s}`)).length;
                                    const catDone = subs.length > 0 ? doneSubCount === subs.length : doneRaw.includes(`${ri}_${cat}`);
                                    return (
                                      <div key={ci} className="border border-slate-200 rounded-xl overflow-hidden">
                                        <div className={`flex items-center gap-2 px-3 py-2 ${catDone ? 'bg-green-50' : 'bg-slate-50'}`}>
                                          <CheckCircle className={`w-3.5 h-3.5 shrink-0 ${catDone ? 'text-green-500' : 'text-slate-300'}`} />
                                          <p className={`text-xs font-semibold flex-1 ${catDone ? 'text-green-700 line-through' : 'text-primary-600'}`}>{cat}</p>
                                          {subs.length > 0 && doneSubCount > 0 && (
                                            <span className={`text-[10px] font-semibold ${catDone ? 'text-green-600' : 'text-slate-400'}`}>{doneSubCount}/{subs.length}</span>
                                          )}
                                        </div>
                                        {subs.length > 0 && (
                                          <div className="px-3 py-2 space-y-1">
                                            {subs.map((sub: string, si: number) => {
                                              const done = doneRaw.includes(`${ri}_${cat}_${sub}`);
                                              return (
                                                <div key={si} className={`flex items-center gap-2 text-xs font-medium ${done ? 'text-green-700' : 'text-slate-400'}`}>
                                                  <CheckCircle className={`w-3.5 h-3.5 shrink-0 ${done ? 'text-green-500' : 'text-slate-300'}`} />
                                                  {sub}
                                                </div>
                                              );
                                            })}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })
                        : /* Fallback: flat list for old shifts without careRecipients structure */
                          <div className="space-y-0.5">
                            {doneRaw.map((t: string, i: number) => (
                              <div key={i} className="flex items-center gap-2 text-xs text-green-700">
                                <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0" />
                                <span>{t.replace(/^\d+_[^_]+_/, '').replace(/^\d+_/, '')}</span>
                              </div>
                            ))}
                          </div>
                      }
                    </div>
                  </div>
                );
              })()}

              {/* Notes */}
              {shiftDetails.completionNotes && (
                <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Caregiver Notes</p>
                  <p className="text-xs text-slate-600">{shiftDetails.completionNotes}</p>
                </div>
              )}
            </>
          )}

          {/* Status-specific messages */}
          {row.status === 'correction_proposed' && (
            <div className="flex items-start gap-2 bg-orange-50 border border-orange-200 rounded-xl px-4 py-3">
              <AlertTriangle className="w-4 h-4 text-orange-500 shrink-0 mt-0.5" />
              <p className="text-xs text-orange-700 font-medium">
                You proposed a correction. Waiting for the caregiver to accept or send a counter.
              </p>
            </div>
          )}
          {row.status === 'disputed_admin_review' && (
            <div className="flex items-start gap-2 bg-purple-50 border border-purple-200 rounded-xl px-4 py-3">
              <AlertCircle className="w-4 h-4 text-purple-500 shrink-0 mt-0.5" />
              <p className="text-xs text-purple-700 font-medium">
                This dispute has been escalated to our team and will be resolved within 48 hours.
              </p>
            </div>
          )}
          {row.status === 'requires_admin_review' && (
            <div className="flex items-start gap-2 bg-purple-50 border border-purple-200 rounded-xl px-4 py-3">
              <AlertCircle className="w-4 h-4 text-purple-500 shrink-0 mt-0.5" />
              <p className="text-xs text-purple-700 font-medium">
                Our team needs to take a closer look at this one before it can be processed. No action needed from you right now.
              </p>
            </div>
          )}
          {row.status === 'payment_failed' && (
            <div className="space-y-2">
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <p className="text-xs text-red-700 font-medium">
                  Payment failed. Please check your card on file in the Payment Method tab.
                </p>
              </div>
              {retryError && (
                <p className="text-xs text-red-600 px-1">{retryError}</p>
              )}
              <button
                onClick={handleRetry}
                disabled={retrying}
                className="w-full py-2.5 bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors"
              >
                {retrying ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                {retrying ? 'Retrying…' : 'Retry Payment'}
              </button>
            </div>
          )}

          {/* Correction history */}
          {row.correctionHistory && row.correctionHistory.some((e: any) => e.action !== 'submitted') && (
            <CorrectionTimeline history={row.correctionHistory} payRate={row.payRate} submittedLineItems={row.lineItems} submittedBasePay={row.basePay} submittedGrossPay={row.grossPay} />
          )}

          {/* Actions */}
          {isPending && (
            <button
              onClick={e => { e.stopPropagation(); onReview(row); }}
              className="w-full py-2.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors"
            >
              <CheckCircle className="w-4 h-4" />
              {row.status === 'caregiver_counter_proposed' ? 'Review & Respond' : 'Review & Approve'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// ── Main Page ─────────────────────────────────────────────────────────────────

export const Payments: React.FC = () => {
  const { addToast } = useCareConnex();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('timesheets');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (key: string) => setExpandedGroups(prev => ({ ...prev, [key]: !prev[key] }));
  const [rows, setRows] = useState<ShiftHoursRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('needs-review');
  const [reviewRow, setReviewRow] = useState<ShiftHoursRow | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [reportFrom, setReportFrom] = useState('');
  const [reportTo, setReportTo] = useState('');

  // Payment method state. stripeCustomerId only tells you a Stripe customer
  // record exists (written the moment checkout STARTS, before any card is
  // entered) — hasValidCard is a live Stripe check for whether a real,
  // charge-able card is actually attached, and is what the UI displays.
  const [stripeCustomerId, setStripeCustomerId] = useState<string | null>(null);
  const [hasValidCard, setHasValidCard] = useState<boolean | null>(null);
  const [loadingCard, setLoadingCard] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);

  const user = useAuthUser();

  // Subscribe to shiftHours for this client
  useEffect(() => {
    if (!user) { setLoading(false); return; }
    const unsub = shiftHoursService.subscribeForClient(user.uid, (data) => {
      setRows(data as ShiftHoursRow[]);
      setLoading(false);
    });
    return () => unsub();
  }, [user?.uid]);

  // stripeCustomerId (Firestore, fast — used only to decide "Add a card" vs
  // "Manage payment method" / redirect-to-membership vs open-portal) and
  // hasValidCard (live Stripe check — used for the actual "Card connected" /
  // "No card on file" status shown to the client) load in parallel; the UI
  // waits for both so it never flashes a stale/wrong state.
  useEffect(() => {
    if (!user || !db) { setLoadingCard(false); return; }
    let active = true;
    Promise.allSettled([
      db.collection('customers').doc(user.uid).get()
        .then(snap => { if (active) setStripeCustomerId(snap.data()?.stripeCustomerId || null); }),
      getClientPaymentMethodStatus()
        .then(status => { if (active) setHasValidCard(status.hasCard); })
        .catch(() => { if (active) setHasValidCard(false); }),
    ]).finally(() => { if (active) setLoadingCard(false); });
    return () => { active = false; };
  }, [user?.uid]);

  // Filter rows by date
  const pendingReviewCount = rows.filter(r => r.status === 'pending_client_review').length;
  const pendingCount = pendingReviewCount + rows.filter(r => r.status === 'caregiver_counter_proposed').length;

  const historyRows = useMemo(() =>
    rows.filter(r => r.status === 'approved' || r.status === 'auto_approved' || r.status === 'paid'),
  [rows]);

  const reportedRows = useMemo(() => {
    if (!showReport || (!reportFrom && !reportTo)) return historyRows;
    return historyRows.filter(r => {
      const raw = r.submittedStartTime ?? r.submittedAt;
      if (!raw) return false;
      const d = new Date(raw).toLocaleDateString('en-CA');
      if (reportFrom && d < reportFrom) return false;
      if (reportTo   && d > reportTo)   return false;
      return true;
    });
  }, [historyRows, showReport, reportFrom, reportTo]);

  const reportSummary = useMemo(() => {
    const totalHours = reportedRows.reduce((s, r) => {
      const startTs = r.finalStartTime ?? r.submittedStartTime;
      const endTs   = r.finalEndTime   ?? r.submittedEndTime;
      const h = (startTs && endTs)
        ? (new Date(endTs).getTime() - new Date(startTs).getTime()) / 3_600_000
        : (r.finalTotalHours ?? r.submittedTotalHours ?? 0);
      return s + h;
    }, 0);
    const totalPay = reportedRows.reduce((s, r) => s + (r.grossPay ?? 0), 0);
    const totalCharged = reportedRows.reduce((s, r) => s + chargedFor(r, r.grossPay ?? 0), 0);
    return { shifts: reportedRows.length, hours: totalHours, pay: totalPay, charged: totalCharged };
  }, [reportedRows]);

  const filteredRows = useMemo(() => {
    if (statusFilter === 'needs-review') return rows.filter(r => NEEDS_REVIEW_STATUSES.includes(r.status));
    return showReport && (reportFrom || reportTo) ? reportedRows : historyRows;
  }, [rows, statusFilter, showReport, reportFrom, reportTo, reportedRows, historyRows]);

  const handleExportCSV = () => {
    const header = ['Caregiver', 'Date', 'Clock In', 'Clock Out', 'Duration', 'Pay ($)', 'Service fee ($)', 'Charged ($)', 'Method', 'Status'];
    const lines = reportedRows.map(r => {
      const startTs = r.finalStartTime ?? r.submittedStartTime;
      const endTs   = r.finalEndTime   ?? r.submittedEndTime;
      const date    = startTs ? new Date(startTs).toLocaleDateString('en-CA') : '';
      const clockIn = startTs ? fmtTime(startTs) : '';
      const clockOut= endTs   ? fmtTime(endTs)   : '';
      const h = (startTs && endTs)
        ? (new Date(endTs).getTime() - new Date(startTs).getTime()) / 3_600_000
        : (r.finalTotalHours ?? r.submittedTotalHours ?? 0);
      const duration = `"${fmtDuration(h)}"`;  // quote to prevent Excel treating H:MM:SS as time
      const payNum = r.grossPay ?? h * (r.payRate ?? 0);
      const pay = payNum.toFixed(2);
      const fee = feeFor(r, payNum).toFixed(2);
      const charged = chargedFor(r, payNum).toFixed(2);
      return [
        `"${(r.caregiverName ?? '').replace(/"/g, '""')}"`,
        date,
        clockIn,
        clockOut,
        duration,
        pay,
        fee,
        charged,
        r.paymentMethod ?? '',
        r.status,
      ].join(',');
    });
    const csv = [header.join(','), ...lines].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `timesheets-${reportFrom || 'all'}-to-${reportTo || 'all'}.csv`;
    a.click();
  };

  const pillTab = (active: boolean) =>
    `inline-flex items-center gap-2 px-5 py-2 rounded-full text-sm font-medium transition-colors ${
      active ? 'bg-primary-600 text-white shadow-sm' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
    }`;

  const handleOpenPortal = async () => {
    // No card yet → send to membership/checkout to add one
    if (!stripeCustomerId) {
      navigate('/client/membership');
      return;
    }
    // Card exists → open Stripe Billing Portal to manage/update it
    setPortalLoading(true);
    try {
      const url = await getClientBillingPortalUrl();
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e: any) {
      const code = e?.code as string | undefined;
      let msg = 'Could not open billing portal. Please try again.';
      if (code === 'functions/not-found' || e?.message?.includes('No billing account')) {
        msg = 'No payment account found. Please subscribe first.';
      } else if (code === 'functions/internal' || code === 'internal') {
        msg = 'Billing portal unavailable right now. Please try again later.';
      }
      addToast(msg, 'error');
    } finally {
      setPortalLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <ClientNavigation />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 pb-28">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Timesheets</h1>
        <p className="text-sm text-slate-500 mb-6">Approve hours and manage your payment method.</p>

        {/* Tabs */}
        <div className="flex gap-2 mb-6 flex-wrap">
          <button onClick={() => setTab('timesheets')} className={pillTab(tab === 'timesheets')}>
            <Clock className="w-4 h-4" /> Timesheets
            {pendingCount > 0 && tab !== 'timesheets' && (
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold">
                {pendingCount}
              </span>
            )}
          </button>
          <button onClick={() => setTab('payment-method')} className={pillTab(tab === 'payment-method')}>
            <CreditCard className="w-4 h-4" /> Payment Method
          </button>
        </div>

        {/* ── Timesheets ── */}
        {tab === 'timesheets' && (
          <div className="space-y-4">
            {/* Pending alert — counts both pending_client_review and caregiver_counter_proposed,
                since both require the client to review and respond (see needs-review filter). */}
            {pendingCount > 0 && (
              <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-5 py-4">
                <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                  <Clock className="w-5 h-5 text-amber-600" />
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-amber-800 text-sm">
                    {pendingCount} shift{pendingCount > 1 ? 's' : ''} to review
                  </p>
                  <p className="text-xs text-amber-600 mt-0.5">
                    Approve or propose a correction. Shifts auto-approve after 24 hours.
                  </p>
                </div>
              </div>
            )}

            {/* Status filter */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {([
                { id: 'needs-review', label: 'Needs Review', count: pendingCount },
                { id: 'history',      label: 'History',      count: historyRows.length },
              ] as { id: StatusFilter; label: string; count: number }[]).map(f => (
                <button
                  key={f.id}
                  onClick={() => { setStatusFilter(f.id); if (f.id !== 'history') setShowReport(false); }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    statusFilter === f.id
                      ? 'bg-primary-600 text-white'
                      : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {f.label}
                  {f.count > 0 && <span className={`text-[10px] font-bold ${statusFilter === f.id ? 'text-white/80' : 'text-slate-400'}`}>{f.count}</span>}
                </button>
              ))}
              {statusFilter === 'history' && (
                <button
                  onClick={() => setShowReport(s => !s)}
                  className={`ml-auto flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-medium border transition-all ${
                    showReport
                      ? 'bg-primary-600 text-white border-primary-600'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <FileDown className="w-3.5 h-3.5" />
                  Report
                </button>
              )}
            </div>

            {/* Report panel */}
            {showReport && statusFilter === 'history' && (
              <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
                <div className="flex items-end gap-3 flex-wrap">
                  <div>
                    <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">From</label>
                    <input type="date" value={reportFrom} onChange={e => setReportFrom(e.target.value)}
                      className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-300" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">To</label>
                    <input type="date" value={reportTo} onChange={e => setReportTo(e.target.value)}
                      className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-300" />
                  </div>
                  {(reportFrom || reportTo) && (
                    <button onClick={() => { setReportFrom(''); setReportTo(''); }}
                      className="text-xs text-slate-400 hover:text-slate-600 pb-1.5">Clear</button>
                  )}
                  <button onClick={handleExportCSV} disabled={reportedRows.length === 0}
                    className="ml-auto flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-40 transition-colors">
                    <FileDown className="w-3.5 h-3.5" />
                    Export CSV
                  </button>
                </div>
                {reportedRows.length > 0 ? (
                  <div className="flex gap-6 pt-2 border-t border-slate-100">
                    {[
                      { label: 'Shifts',         value: String(reportSummary.shifts) },
                      { label: 'Total hours',    value: fmtDuration(reportSummary.hours) },
                      { label: 'To caregivers',  value: `$${reportSummary.pay.toFixed(2)}` },
                      { label: 'Charged to you', value: `$${reportSummary.charged.toFixed(2)}` },
                    ].map(s => (
                      <div key={s.label}>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{s.label}</p>
                        <p className="text-base font-bold text-slate-900 mt-0.5">{s.value}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400 pt-2 border-t border-slate-100">
                    No history records match the selected date range.
                  </p>
                )}
              </div>
            )}

            {/* List */}
            {loading ? (
              <div className="flex justify-center py-16">
                <Loader2 className="w-6 h-6 animate-spin text-primary-500" />
              </div>
            ) : filteredRows.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center">
                <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
                  <Clock className="w-6 h-6 text-slate-400" />
                </div>
                <p className="font-semibold text-slate-700 mb-1">
                  {statusFilter === 'history' ? 'No completed shifts yet' : 'No timesheets yet'}
                </p>
                <p className="text-sm text-slate-400">
                  {statusFilter === 'history'
                    ? 'Approved and paid shifts will appear here.'
                    : "When a caregiver completes a shift and submits their hours, they'll appear here for your review."}
                </p>
              </div>
            ) : (
              <>
                {statusFilter === 'history' ? (() => {
                  const sorted = filteredRows.slice().sort((a, b) =>
                    new Date(b.submittedStartTime ?? b.submittedAt).getTime() - new Date(a.submittedStartTime ?? a.submittedAt).getTime()
                  );
                  // Group by month
                  const monthGroups = sorted.reduce((acc, row) => {
                    const d = new Date(row.submittedStartTime ?? row.submittedAt);
                    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                    const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
                    if (!acc[key]) acc[key] = { label, rows: [] };
                    acc[key].rows.push(row);
                    return acc;
                  }, {} as Record<string, { label: string; rows: typeof filteredRows }>);

                  return Object.entries(monthGroups).map(([monthKey, monthGroup]) => {
                    const monthTotal = monthGroup.rows.reduce((s, r) => {
                      const start = r.finalStartTime ?? r.submittedStartTime;
                      const end = r.finalEndTime ?? r.submittedEndTime;
                      const hrs = (start && end) ? (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000 : (r.finalTotalHours ?? r.submittedTotalHours ?? 0);
                      return s + (r.grossPay ?? hrs * (r.payRate ?? 0));
                    }, 0);
                    const monthCharged = monthGroup.rows.reduce((s, r) => {
                      const start = r.finalStartTime ?? r.submittedStartTime;
                      const end = r.finalEndTime ?? r.submittedEndTime;
                      const hrs = (start && end) ? (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000 : (r.finalTotalHours ?? r.submittedTotalHours ?? 0);
                      return s + chargedFor(r, r.grossPay ?? hrs * (r.payRate ?? 0));
                    }, 0);
                    // Group by caregiver within the month
                    const cgGroups = monthGroup.rows.reduce((acc, row) => {
                      const key = row.caregiverId || row.caregiverName || 'unknown';
                      if (!acc[key]) acc[key] = { name: row.caregiverName ?? 'Caregiver', photo: row.caregiverPhotoURL ?? undefined, rows: [] };
                      acc[key].rows.push(row);
                      return acc;
                    }, {} as Record<string, { name: string; photo?: string; rows: typeof filteredRows }>);

                    return (
                      <div key={monthKey} className="space-y-3">
                        {/* Month header */}
                        <div className="flex items-center justify-between px-1 pt-2 border-t border-slate-100 first:border-t-0 first:pt-0">
                          <span className="text-sm font-bold text-slate-800">{monthGroup.label}</span>
                          <span className="text-xs text-slate-500">{monthGroup.rows.length} shift{monthGroup.rows.length !== 1 ? 's' : ''} · ${monthTotal.toFixed(2)} to caregivers · ${monthCharged.toFixed(2)} charged</span>
                        </div>
                        {/* Caregivers within month */}
                        {Object.entries(cgGroups).map(([cgKey, cgGroup]) => {
                          const expandKey = `${monthKey}-${cgKey}`;
                          const isExpanded = !!expandedGroups[expandKey];
                          const visible = isExpanded ? cgGroup.rows : cgGroup.rows.slice(0, 2);
                          const hidden = cgGroup.rows.length - 2;
                          return (
                            <div key={cgKey} className="space-y-2">
                              <div className="flex items-center gap-2 px-1">
                                <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-xs shrink-0">
                                  {cgGroup.photo ? <img src={cgGroup.photo} className="w-full h-full object-cover" alt="" /> : cgGroup.name.charAt(0).toUpperCase()}
                                </div>
                                <span className="text-sm font-semibold text-slate-700">{cgGroup.name}</span>
                                <span className="text-xs text-slate-400">{cgGroup.rows.length} shift{cgGroup.rows.length !== 1 ? 's' : ''}</span>
                              </div>
                              {visible.map(row => (
                                <ShiftRow key={row.id} row={row} onReview={setReviewRow} hideCaregiver />
                              ))}
                              {hidden > 0 && !isExpanded && (
                                <button onClick={() => toggleGroup(expandKey)} className="w-full text-xs text-primary-600 hover:text-primary-800 font-medium py-1.5 text-center">
                                  Show {hidden} more
                                </button>
                              )}
                              {isExpanded && cgGroup.rows.length > 2 && (
                                <button onClick={() => toggleGroup(expandKey)} className="w-full text-xs text-slate-400 hover:text-slate-600 font-medium py-1.5 text-center">
                                  Show less
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  });
                })() : (() => {
                  // Needs Review — group by caregiver
                  const sorted = filteredRows.slice().sort((a, b) => {
                    const needsAction = (s: ShiftHoursStatus) =>
                      s === 'pending_client_review' || s === 'caregiver_counter_proposed' ? 0 : 1;
                    const aP = needsAction(a.status);
                    const bP = needsAction(b.status);
                    if (aP !== bP) return aP - bP;
                    return new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime();
                  });
                  const grouped = sorted.reduce((acc, row) => {
                    const key = row.caregiverId || row.caregiverName || 'unknown';
                    if (!acc[key]) acc[key] = { name: row.caregiverName ?? 'Caregiver', photo: row.caregiverPhotoURL ?? undefined, rows: [] };
                    acc[key].rows.push(row);
                    return acc;
                  }, {} as Record<string, { name: string; photo?: string; rows: typeof filteredRows }>);
                  return Object.entries(grouped).map(([key, group]) => {
                    const isExpanded = !!expandedGroups[key];
                    const visible = isExpanded ? group.rows : group.rows.slice(0, 2);
                    const hidden = group.rows.length - 2;
                    return (
                      <div key={key} className="space-y-2">
                        <div className="flex items-center gap-2 px-1">
                          <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-xs shrink-0">
                            {group.photo ? <img src={group.photo} className="w-full h-full object-cover" alt="" /> : group.name.charAt(0).toUpperCase()}
                          </div>
                          <span className="text-sm font-semibold text-slate-700">{group.name}</span>
                          <span className="text-xs text-slate-400">{group.rows.length} shift{group.rows.length !== 1 ? 's' : ''}</span>
                        </div>
                        {visible.map(row => (
                          <ShiftRow key={row.id} row={row} onReview={setReviewRow} hideCaregiver />
                        ))}
                        {hidden > 0 && !isExpanded && (
                          <button onClick={() => toggleGroup(key)} className="w-full text-xs text-primary-600 hover:text-primary-800 font-medium py-1.5 text-center">
                            Show more
                          </button>
                        )}
                        {isExpanded && group.rows.length > 2 && (
                          <button onClick={() => toggleGroup(key)} className="w-full text-xs text-slate-400 hover:text-slate-600 font-medium py-1.5 text-center">
                            Show less
                          </button>
                        )}
                      </div>
                    );
                  });
                })()}
              </>
            )}
          </div>
        )}

        {/* ── Payment Method ── */}
        {tab === 'payment-method' && (
          <div className="space-y-4">
            {loadingCard ? (
              <div className="flex justify-center py-16">
                <Loader2 className="w-6 h-6 animate-spin text-primary-500" />
              </div>
            ) : (
              <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
                <div className="px-6 pt-6 pb-4">
                  <p className="font-semibold text-slate-900 mb-1">Card on file</p>
                  <p className="text-sm text-slate-500">
                    Your card is used for automatic payment when you approve a caregiver's hours. We never store your full card number — it's managed securely by Stripe.
                  </p>
                </div>

                <div className="px-6 pb-6">
                  {hasValidCard ? (
                    <div className="flex items-center gap-4 bg-slate-50 border border-slate-200 rounded-xl px-4 py-4 mb-4">
                      <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shrink-0">
                        <CreditCard className="w-5 h-5 text-white" />
                      </div>
                      <div className="flex-1">
                        <p className="font-semibold text-slate-800 text-sm">Card connected</p>
                        <p className="text-xs text-slate-500 mt-0.5">Managed securely via Stripe</p>
                      </div>
                      <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-green-50 text-green-700 border border-green-200">
                        Active
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-4 mb-4">
                      <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center shrink-0">
                        <AlertTriangle className="w-5 h-5 text-amber-600" />
                      </div>
                      <div className="flex-1">
                        <p className="font-semibold text-amber-800 text-sm">No card on file</p>
                        <p className="text-xs text-amber-600 mt-0.5">
                          Add a card to pay caregivers when you approve their hours.
                        </p>
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handleOpenPortal}
                    disabled={portalLoading}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors"
                  >
                    {portalLoading
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <ExternalLink className="w-4 h-4" />}
                    {hasValidCard ? 'Manage payment method' : 'Add a card'}
                  </button>
                </div>

                <div className="border-t border-slate-100 px-6 py-4 bg-slate-50">
                  <p className="text-xs text-slate-400">
                    <span className="font-medium text-slate-500">How payments work:</span> When you approve a caregiver's hours, or 24 hours pass without you reviewing them, your card is automatically charged for the caregiver's total plus Evia's {SERVICE_FEE_PERCENT_LABEL} service fee (minimum $1). Caregivers keep 100% of their rate.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Review modal */}
      {reviewRow && (
        <ReviewShiftHoursModal
          shift={reviewRow}
          onClose={() => setReviewRow(null)}
          onDone={() => {
            setReviewRow(null);
            addToast('Done — hours updated.', 'success');
          }}
          onError={(msg) => {
            addToast(msg, 'error');
          }}
        />
      )}
    </div>
  );
};
