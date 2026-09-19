import React, { useState, useEffect, useMemo } from 'react';
import {
  Zap, Landmark, CheckCircle2, AlertCircle, Lock,
  ExternalLink, Calendar, DollarSign, FileDown,
  ShieldCheck, RefreshCw, XCircle, ChevronDown, ChevronUp, X, CheckCircle, Car,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { CaregiverTopNav } from './CaregiverTopNav';
import { PayoutHistory } from './PayoutHistory';
import { ConnectBankButton } from '../ui/ConnectBankButton';
import { InstantPayoutModal } from './InstantPayoutModal';
import { CompletedShift, SubmitShiftHoursModal } from '../payroll/SubmitShiftHoursModal';
import { useCareConnex } from '../../context/CareConnexContext';
import { shiftHoursService, dbService } from '../../services/api';
import { checkOnboardingStatus, requestInstantPayout, getPayoutBalance, getSubscriptionStatus, getCaregiverBillingPortalUrl, createMvrAddonCheckout } from '../../services/stripeService';
import { db } from '../../lib/firebase';
import type { Caregiver } from '../../types';
import { paymentMethodLabel } from '../../types';

// ── types ───────────────────────────────────────────────────────────────────

type Tab = 'timesheets' | 'payouts' | 'membership';

interface SubscriptionInfo {
  status: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

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

interface ShiftRow {
  id: string;
  appointmentId: string;
  clientName?: string;
  clientPhotoURL?: string | null;
  caregiverId: string;
  payRate?: number;
  paymentMethod?: 'credit';
  submittedStartTime?: string;
  submittedEndTime?: string;
  submittedTotalHours?: number;
  finalStartTime?: string;
  finalEndTime?: string;
  finalTotalHours?: number;
  resolvedBy?: string;
  proposedStartTime?: string;
  proposedEndTime?: string;
  proposedTotalHours?: number;
  proposalReason?: string;
  counterStartTime?: string;
  counterEndTime?: string;
  counterTotalHours?: number;
  counterNote?: string;
  counterLineItems?: LineItem[];
  counterLineItemsTotal?: number;
  counterGrossPay?: number;
  correctionHistory?: CorrectionHistoryEntry[];
  lineItems?: LineItem[];
  lineItemsTotal?: number;
  basePay?: number;
  grossPay?: number;
  submittedAt?: string;
  autoApproveAt?: string;
  status: string;
  stripeFailureReason?: string;
  loggedManually?: boolean;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function toDate(ts: any): Date | null {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate();
  if (typeof ts === 'string') return new Date(ts);
  if (ts.seconds) return new Date(ts.seconds * 1000);
  return null;
}

const fmtTime = (d: Date) =>
  d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });

const fmtDate = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const fmtDateTime = (d: Date) =>
  `${fmtDate(d)}, ${fmtTime(d)}`;

/** 0.1 → "6 min" · 1.5 → "1h 30m" · 2.0 → "2h" */
const fmtDuration = (hours: number): string => {
  const totalSecs = Math.round(hours * 3600);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

function toDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const HISTORY_ACTION_LABEL: Record<string, string> = {
  submitted:          'Submitted by caregiver',
  proposed_correction:'Client proposed correction',
  counter_proposed:   'Caregiver sent counter',
  accepted:           'Accepted',
  escalated:          'Escalated to admin',
  admin_resolved:     'Resolved by admin',
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
    <div className="mt-3 space-y-1">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">History</p>
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
                      {fmtTime(new Date(entry.startTime!))} – {fmtTime(new Date(entry.endTime!))} · {fmtDuration(entry.hours!)}
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
                    <div className="flex items-center justify-between px-3 py-1.5 bg-slate-50">
                      <span className="font-semibold text-slate-600">Total</span>
                      <span className="font-bold text-slate-900">${entryGrossPay.toFixed(2)}</span>
                    </div>
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

const Col: React.FC<{ label: string; value: string; highlight?: boolean; className?: string }> = ({
  label, value, highlight, className = '',
}) => (
  <div className={`flex flex-col min-w-0 ${className}`}>
    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 leading-none mb-0.5">
      {label}
    </span>
    <span className={`text-sm leading-tight truncate ${highlight ? 'font-bold text-slate-900' : 'font-medium text-slate-700'}`}>
      {value}
    </span>
  </div>
);

const Divider: React.FC = () => <div className="w-px h-8 bg-slate-100 shrink-0" />;

const STATUS_LABEL: Record<string, string> = {
  pending_client_review:     'Pending client review',
  correction_proposed:       'Correction Received',
  caregiver_counter_proposed: 'Counter sent',
  approved:                  'Approved',
  auto_approved:             'Auto-approved',
  disputed_admin_review:     'Admin reviewing',
  requires_admin_review:     'Under review',
  paid:                      'Paid',
  payment_failed:            'Awaiting Payment',
};

const STATUS_STYLE: Record<string, string> = {
  pending_client_review:     'bg-amber-50 text-amber-700 border-amber-200',
  correction_proposed:       'bg-orange-50 text-orange-700 border-orange-200',
  caregiver_counter_proposed:'bg-yellow-50 text-yellow-700 border-yellow-200',
  approved:                  'bg-blue-50 text-blue-700 border-blue-200',
  auto_approved:             'bg-blue-50 text-blue-700 border-blue-200',
  disputed_admin_review:     'bg-purple-50 text-purple-700 border-purple-200',
  requires_admin_review:     'bg-purple-50 text-purple-700 border-purple-200',
  paid:                      'bg-green-50 text-green-700 border-green-200',
  payment_failed:            'bg-amber-50 text-amber-700 border-amber-200',
};

// ── sub-components ────────────────────────────────────────────────────────────

// ── ReviewRespondModal ────────────────────────────────────────────────────────

const ReviewRespondModal: React.FC<{
  row: ShiftRow;
  onClose: () => void;
  onAccept: () => void;
  onCounter: (counter: { startTime: string; endTime: string; note?: string; lineItems?: LineItem[] }) => void;
}> = ({ row, onClose, onAccept, onCounter }) => {
  const proposedLineItems: LineItem[] = (row as any).proposedLineItems ?? row.lineItems ?? [];
  const proposedBasePay = row.proposedTotalHours != null && row.payRate
    ? Math.round(row.proposedTotalHours * row.payRate * 100) / 100 : 0;
  const proposedGross = (row as any).proposedGrossPay
    ?? Math.round((proposedBasePay + proposedLineItems.reduce((s, li) => s + (Number(li.amount) || 0), 0)) * 100) / 100;

  const [counterStart,     setCounterStart]     = React.useState(row.proposedStartTime ? toDateTimeLocal(row.proposedStartTime) : '');
  const [counterEnd,       setCounterEnd]       = React.useState(row.proposedEndTime   ? toDateTimeLocal(row.proposedEndTime)   : '');
  const [counterLineItems, setCounterLineItems] = React.useState<LineItem[]>(row.lineItems ?? []);
  const [counterNote,      setCounterNote]      = React.useState('');
  const [submitting,       setSubmitting]       = React.useState(false);

  const counterStartMs = counterStart ? new Date(counterStart).getTime() : 0;
  const counterEndMs   = counterEnd   ? new Date(counterEnd).getTime()   : 0;
  // Exact seconds → cents, the same math the server bills with (billing/
  // shiftBillingAmounts). Rounding the HOURS first showed "$2.10" for a 25-minute
  // counter the server would charge as $2.08 (live-caught 2026-09-18).
  const counterHours   = counterStartMs && counterEndMs && counterEndMs > counterStartMs
    ? (counterEndMs - counterStartMs) / 3_600_000 : 0;
  const counterBase    = Math.round(counterHours * (row.payRate ?? 0) * 100) / 100;
  const counterLITotal = counterLineItems.reduce((s, li) => s + (Number(li.amount) || 0), 0);
  const counterGross   = Math.round((counterBase + counterLITotal) * 100) / 100;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 sticky top-0 bg-white rounded-t-2xl sm:rounded-t-2xl z-10">
          <div>
            <h2 className="font-bold text-slate-900">Review correction</h2>
            <p className="text-sm text-slate-500 mt-0.5">{row.clientName}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-500 text-lg">×</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Client proposed — full receipt */}
          <div className="bg-orange-50 border border-orange-200 rounded-xl overflow-hidden">
            <p className="text-xs font-semibold text-orange-600 uppercase tracking-wide px-4 pt-3 pb-1">Client proposed</p>
            <div className="divide-y divide-orange-100">
              <div className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="text-slate-500">Time</span>
                <span className="font-medium text-slate-800">
                  {row.proposedStartTime && row.proposedEndTime
                    ? `${fmtTime(new Date(row.proposedStartTime))} – ${fmtTime(new Date(row.proposedEndTime))}`
                    : '—'}
                  {row.proposedTotalHours != null ? ` · ${fmtDuration(row.proposedTotalHours)}` : ''}
                </span>
              </div>
              {row.payRate != null && (
                <div className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-slate-500">${row.payRate}/hr · Base</span>
                  <span className="font-medium text-slate-800">${proposedBasePay.toFixed(2)}</span>
                </div>
              )}
              {proposedLineItems.map((li, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-slate-500">{li.label || li.type}{li.note ? ` · ${li.note}` : ''}</span>
                  <span className="font-medium text-slate-800">+${Number(li.amount).toFixed(2)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between px-4 py-2.5 bg-orange-100">
                <span className="font-bold text-slate-800">Total</span>
                <span className="font-bold text-slate-900">${proposedGross.toFixed(2)}</span>
              </div>
            </div>
            {row.proposalReason && (
              <p className="text-xs text-slate-500 italic px-4 pb-3 pt-1">"{row.proposalReason}"</p>
            )}
          </div>

          {/* Accept button */}
          <button
            disabled={submitting}
            onClick={async () => { setSubmitting(true); try { await onAccept(); } finally { setSubmitting(false); } }}
            className="w-full py-3 rounded-xl bg-primary-600 text-white font-semibold text-sm hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            Accept · ${proposedGross.toFixed(2)}
          </button>

          {/* Divider */}
          <div className="relative flex items-center gap-3">
            <div className="flex-1 border-t border-slate-200" />
            <span className="text-xs text-slate-400 shrink-0">or send a counter</span>
            <div className="flex-1 border-t border-slate-200" />
          </div>

          {/* Counter form */}
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Counter start</label>
                <input type="datetime-local" value={counterStart} onChange={e => setCounterStart(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-300" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Counter end</label>
                <input type="datetime-local" value={counterEnd} onChange={e => setCounterEnd(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-300" />
              </div>
            </div>

            {counterLineItems.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Additional charges</p>
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
                  {counterLineItems.map((li, i) => (
                    <div key={i} className="flex items-center justify-between px-3 py-2 gap-2">
                      <span className="text-xs text-slate-600 flex-1 truncate">{li.label || li.type}{li.note ? ` · ${li.note}` : ''}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-xs text-slate-400">$</span>
                        <input type="number" min="0" step="0.01" value={li.amount}
                          onChange={e => setCounterLineItems(counterLineItems.map((x, j) =>
                            j === i ? { ...x, amount: parseFloat(e.target.value) || 0 } : x))}
                          className="w-16 px-2 py-1 border border-slate-200 rounded-lg text-xs text-right focus:outline-none focus:ring-2 focus:ring-primary-300" />
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center justify-between px-3 py-2 bg-slate-50">
                    <span className="text-xs font-semibold text-slate-600">Your total</span>
                    <span className="text-xs font-bold text-slate-900">${counterGross.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Note (optional)</label>
              <textarea value={counterNote} onChange={e => setCounterNote(e.target.value)} rows={2}
                placeholder="Why do you disagree?"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-300" />
            </div>

            <button
              disabled={submitting || !counterStart || !counterEnd}
              onClick={async () => {
                setSubmitting(true);
                try {
                  await onCounter({
                    startTime: new Date(counterStart).toISOString(),
                    endTime:   new Date(counterEnd).toISOString(),
                    note: counterNote.trim() || undefined,
                    lineItems: counterLineItems.length > 0 ? counterLineItems : undefined,
                  });
                } finally { setSubmitting(false); }
              }}
              className="w-full py-3 rounded-xl bg-slate-800 text-white font-semibold text-sm hover:bg-slate-900 disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Sending…' : `Send counter · $${counterGross.toFixed(2)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ── PendingShiftRow ────────────────────────────────────────────────────────────

const PendingShiftRow: React.FC<{
  row: ShiftRow;
  onRespond: (action: 'accept' | 'counter_propose', counter?: { startTime: string; endTime: string; note?: string; lineItems?: LineItem[] }) => void;
}> = ({ row, onRespond }) => {
  // All hooks must be declared before any early returns
  const [pendingOpen,       setPendingOpen]       = React.useState(false);
  const [reviewOpen,        setReviewOpen]        = React.useState(false);
  const [showDetailModal,   setShowDetailModal]   = React.useState(false);

  if (row.status === 'caregiver_counter_proposed') {
    const counterGross = row.counterGrossPay ?? (
      row.counterTotalHours != null && row.payRate != null
        ? Math.round((row.counterTotalHours * row.payRate + (row.counterLineItemsTotal ?? 0)) * 100) / 100
        : null
    );
    // Data strip shows original submitted values — counter is pending, not approved yet
    const ctrStart = row.submittedStartTime ? new Date(row.submittedStartTime) : null;
    const ctrEnd   = row.submittedEndTime   ? new Date(row.submittedEndTime)   : null;
    const ctrHours = row.submittedTotalHours ?? 0;
    const stripPay = row.grossPay ?? 0;
    const method   = row.paymentMethod ? paymentMethodLabel(row.paymentMethod) : '—';
    // Original submission values for the HOURS receipt
    const origBasePay = row.basePay ?? (row.submittedTotalHours != null && row.payRate ? Math.round(row.submittedTotalHours * row.payRate * 100) / 100 : null);
    const origGross   = row.grossPay ?? origBasePay;
    const counterBasePay = row.counterTotalHours != null && row.payRate
      ? Math.round(row.counterTotalHours * row.payRate * 100) / 100
      : null;

    return (
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        {/* Collapsed data strip */}
        <div
          className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 transition-colors select-none"
          onClick={() => setPendingOpen(o => !o)}
        >
          <Col label="Date"     value={ctrStart ? fmtDate(ctrStart) : '—'}  className="shrink-0 w-[58px]" />
          <Divider />
          <Col label="In"       value={ctrStart ? fmtTime(ctrStart) : '—'}  className="shrink-0 w-[88px]" />
          <Divider />
          <Col label="Out"      value={ctrEnd   ? fmtTime(ctrEnd)   : '—'}  className="shrink-0 w-[88px]" />
          <Divider />
          <Col label="Duration" value={fmtDuration(ctrHours)}               className="shrink-0 w-[62px]" />
          <Divider />
          <Col label="Pay"      value={`$${stripPay.toFixed(2)}`} highlight  className="shrink-0 w-[60px]" />
          <Divider />
          <Col label="Method"   value={method}                               className="shrink-0 w-[46px]" />

          <div className="flex items-center gap-1.5 shrink-0 ml-auto">
            {row.loggedManually && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 whitespace-nowrap">Logged</span>
            )}
            <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-yellow-50 text-yellow-700 border-yellow-200 whitespace-nowrap">
              Counter sent
            </span>
            {pendingOpen ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
          </div>
        </div>

        {/* Expanded detail */}
        {pendingOpen && (
          <div className="border-t border-slate-100 px-4 pt-3 pb-4 space-y-3">

            {/* Original HOURS receipt */}
            <div className="rounded-xl border border-slate-200 overflow-hidden">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide px-3 pt-2.5 pb-1">Hours submitted</p>
              <div className="divide-y divide-slate-100">
                {row.payRate != null && (
                  <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                    <span className="text-slate-400">Rate</span>
                    <span className="text-slate-700">${row.payRate}/hr</span>
                  </div>
                )}
                {row.submittedStartTime && row.submittedEndTime && (
                  <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                    <span className="text-slate-400">{row.loggedManually ? 'Reported in / out' : 'Clock in / out'}</span>
                    <span className="text-slate-700">
                      {fmtDateTime(new Date(row.submittedStartTime))} – {fmtDateTime(new Date(row.submittedEndTime))}
                    </span>
                  </div>
                )}
                {row.submittedTotalHours != null && (
                  <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                    <span className="text-slate-400">Total hours</span>
                    <span className="font-semibold text-slate-700">{fmtDuration(row.submittedTotalHours)}</span>
                  </div>
                )}
                {origBasePay != null && row.lineItems && row.lineItems.length > 0 && (
                  <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                    <span className="text-slate-400">Base pay</span>
                    <span className="text-slate-700">${origBasePay.toFixed(2)}</span>
                  </div>
                )}
                {row.lineItems && row.lineItems.map((li, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-1.5 text-xs">
                    <span className="text-slate-400 truncate">{li.label || li.type}{li.note ? ` · ${li.note}` : ''}</span>
                    <span className="text-slate-700 shrink-0">+${Number(li.amount).toFixed(2)}</span>
                  </div>
                ))}
                {origGross != null && (
                  <div className="flex items-center justify-between px-3 py-2 bg-slate-50 text-xs">
                    <span className="font-semibold text-slate-600">Total</span>
                    <span className="font-bold text-slate-900">${origGross.toFixed(2)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Correction history */}
            {row.correctionHistory && row.correctionHistory.length > 0 && (
              <CorrectionTimeline
                history={row.correctionHistory}
                payRate={row.payRate}
                submittedLineItems={row.lineItems}
                submittedBasePay={row.basePay}
                submittedGrossPay={row.grossPay}
              />
            )}
            <button
              onClick={() => setShowDetailModal(true)}
              className="w-full py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
            >
              View shift
            </button>
          </div>
        )}
        {showDetailModal && (
          <ShiftDetailModal shiftId={row.appointmentId} onClose={() => setShowDetailModal(false)} />
        )}
      </div>
    );
  }

  if (row.status === 'correction_proposed') {
    const submittedBasePay  = row.basePay ?? (row.submittedTotalHours != null && row.payRate ? Math.round(row.submittedTotalHours * row.payRate * 100) / 100 : null);
    const origGross         = row.grossPay ?? submittedBasePay;
    const proposedLineItems: LineItem[] = (row as any).proposedLineItems ?? row.lineItems ?? [];
    const proposedBasePay   = row.proposedTotalHours != null && row.payRate ? Math.round(row.proposedTotalHours * row.payRate * 100) / 100 : null;
    const proposedGross     = (row as any).proposedGrossPay ?? (proposedBasePay != null ? Math.round((proposedBasePay + proposedLineItems.reduce((s, li) => s + (Number(li.amount) || 0), 0)) * 100) / 100 : null);
    const payDiff           = proposedGross != null && origGross != null ? Math.round((proposedGross - origGross) * 100) / 100 : null;
    // Data strip uses original submitted values
    const stripStart = row.submittedStartTime ? new Date(row.submittedStartTime) : null;
    const stripEnd   = row.submittedEndTime   ? new Date(row.submittedEndTime)   : null;
    const stripHours = row.submittedTotalHours ?? 0;
    const stripPay   = origGross ?? 0;
    const method     = row.paymentMethod ? paymentMethodLabel(row.paymentMethod) : '—';

    return (
      <>
        <div className="bg-white rounded-2xl border border-orange-200 overflow-hidden">
          {/* Collapsed data strip */}
          <div
            className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-orange-50 transition-colors select-none"
            onClick={() => setPendingOpen(o => !o)}
          >
            <Col label="Date"     value={stripStart ? fmtDate(stripStart) : '—'} className="shrink-0 w-[58px]" />
            <Divider />
            <Col label="In"       value={stripStart ? fmtTime(stripStart) : '—'} className="shrink-0 w-[88px]" />
            <Divider />
            <Col label="Out"      value={stripEnd   ? fmtTime(stripEnd)   : '—'} className="shrink-0 w-[88px]" />
            <Divider />
            <Col label="Duration" value={fmtDuration(stripHours)}                className="shrink-0 w-[62px]" />
            <Divider />
            <Col label="Pay"      value={`$${stripPay.toFixed(2)}`} highlight     className="shrink-0 w-[60px]" />
            <Divider />
            <Col label="Method"   value={method}                                 className="shrink-0 w-[46px]" />
            <div className="flex items-center gap-1.5 shrink-0 ml-auto">
              {row.loggedManually && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 whitespace-nowrap">Logged</span>
              )}
              <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-orange-50 text-orange-700 border-orange-200 whitespace-nowrap">
                Correction Received
              </span>
              {pendingOpen ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
            </div>
          </div>

          {showDetailModal && (
            <ShiftDetailModal shiftId={row.appointmentId} onClose={() => setShowDetailModal(false)} />
          )}
          {/* Expanded detail */}
          {pendingOpen && (
            <div className="border-t border-orange-100 px-4 pt-3 pb-4 space-y-3">
              <p className="text-sm font-semibold text-slate-700">{row.clientName}</p>

              {/* Your original submission — full width */}
              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide px-3 pt-2.5 pb-1">Hours submitted</p>
                <div className="divide-y divide-slate-100">
                  {row.payRate != null && (
                    <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span className="text-slate-400">Rate</span>
                      <span className="text-slate-700">${row.payRate}/hr</span>
                    </div>
                  )}
                  {row.submittedStartTime && row.submittedEndTime && (
                    <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span className="text-slate-400">{row.loggedManually ? 'Reported in / out' : 'Clock in / out'}</span>
                      <span className="text-slate-700">{fmtDateTime(new Date(row.submittedStartTime))} – {fmtDateTime(new Date(row.submittedEndTime))}</span>
                    </div>
                  )}
                  {row.submittedTotalHours != null && (
                    <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span className="text-slate-400">Total hours</span>
                      <span className="font-semibold text-slate-700">{fmtDuration(row.submittedTotalHours)}</span>
                    </div>
                  )}
                  {submittedBasePay != null && row.lineItems && row.lineItems.length > 0 && (
                    <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span className="text-slate-400">Base pay</span>
                      <span className="text-slate-700">${submittedBasePay.toFixed(2)}</span>
                    </div>
                  )}
                  {row.lineItems && row.lineItems.map((li, i) => (
                    <div key={i} className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span className="text-slate-400 truncate">{li.label || li.type}{li.note ? ` · ${li.note}` : ''}</span>
                      <span className="text-slate-700 shrink-0">+${Number(li.amount).toFixed(2)}</span>
                    </div>
                  ))}
                  {origGross != null && (
                    <div className="flex items-center justify-between px-3 py-2 bg-slate-50 text-xs">
                      <span className="font-semibold text-slate-600">Total</span>
                      <span className="font-bold text-slate-900">${origGross.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              </div>


              <div className="flex gap-2">
                <button
                  onClick={() => setShowDetailModal(true)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  View shift
                </button>
                <button
                  onClick={() => setReviewOpen(true)}
                  className="flex-1 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 transition-colors"
                >
                  Review & Respond
                </button>
              </div>

              {row.correctionHistory && row.correctionHistory.length > 0 && (
                <CorrectionTimeline history={row.correctionHistory} payRate={row.payRate} submittedLineItems={row.lineItems} submittedBasePay={row.basePay} submittedGrossPay={row.grossPay} />
              )}
            </div>
          )}
        </div>

        {reviewOpen && (
          <ReviewRespondModal
            row={row}
            onClose={() => setReviewOpen(false)}
            onAccept={async () => { await onRespond('accept'); setReviewOpen(false); }}
            onCounter={async (counter) => { await onRespond('counter_propose', counter); setReviewOpen(false); }}
          />
        )}
      </>
    );
  }

  // pending_client_review — expandable data strip
  const dispStart = row.submittedStartTime ? new Date(row.submittedStartTime) : null;
  const dispEnd   = row.submittedEndTime   ? new Date(row.submittedEndTime)   : null;
  const hours = (dispStart && dispEnd)
    ? (dispEnd.getTime() - dispStart.getTime()) / 3_600_000
    : (row.finalTotalHours ?? row.submittedTotalHours ?? 0);
  const basePay   = hours * (row.payRate ?? 0);
  const hasExtras = row.lineItems && row.lineItems.length > 0;
  const gross     = row.grossPay ?? basePay;
  const method    = row.paymentMethod ? paymentMethodLabel(row.paymentMethod) : '—';
  const autoAt    = row.autoApproveAt
    ? new Date(row.autoApproveAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 transition-colors select-none"
        onClick={() => setPendingOpen(o => !o)}
      >
        <Col label="Date"     value={dispStart ? fmtDate(dispStart) : '—'}  className="shrink-0 w-[58px]" />
        <Divider />
        <Col label="In"       value={dispStart ? fmtTime(dispStart) : '—'}  className="shrink-0 w-[88px]" />
        <Divider />
        <Col label="Out"      value={dispEnd   ? fmtTime(dispEnd)   : '—'}  className="shrink-0 w-[88px]" />
        <Divider />
        <Col label="Duration" value={fmtDuration(hours)}                    className="shrink-0 w-[62px]" />
        <Divider />
        <Col label="Pay"      value={`$${gross.toFixed(2)}`} highlight      className="shrink-0 w-[60px]" />
        <Divider />
        <Col label="Method"   value={method}                                className="shrink-0 w-[46px]" />

        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
          {row.loggedManually && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 whitespace-nowrap">Logged</span>
          )}
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${STATUS_STYLE[row.status] || 'bg-slate-50 text-slate-600 border-slate-200'}`}>
            {STATUS_LABEL[row.status] || row.status}
          </span>
          {pendingOpen ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </div>
      </div>

      {pendingOpen && (
        <div className="border-t-2 border-slate-200 bg-slate-50 px-4 py-3 space-y-3">

          <div className="divide-y divide-slate-200 text-xs border border-slate-200 rounded-xl overflow-hidden">
            {row.payRate != null && (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-400">Rate</span>
                <span className="font-medium text-slate-700">${row.payRate}/hr</span>
              </div>
            )}
            {dispStart && dispEnd && (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-400">Clock in / out</span>
                <span className="font-medium text-slate-700">
                  {fmtDateTime(dispStart)} – {fmtDateTime(dispEnd)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-slate-400">Total hours</span>
              <span className="font-medium text-slate-700">{fmtDuration(hours)}</span>
            </div>
            {hasExtras ? (
              <>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-slate-400">Base pay</span>
                  <span className="font-medium text-slate-700">${basePay.toFixed(2)}</span>
                </div>
                {row.lineItems!.map((li, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2">
                    <span className="text-slate-400">
                      {li.type === 'custom' ? (li.label || 'Custom') : li.label}
                      {li.note ? ` · ${li.note}` : ''}
                    </span>
                    <span className="font-medium text-slate-700">+${li.amount.toFixed(2)}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between px-3 py-2 bg-slate-100">
                  <span className="font-semibold text-slate-700">Total</span>
                  <span className="font-bold text-slate-900">${gross.toFixed(2)}</span>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-400">Gross pay</span>
                <span className="font-bold text-slate-900">${gross.toFixed(2)}</span>
              </div>
            )}
            {autoAt && (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-400">Auto-approves</span>
                <span className="font-medium text-slate-700">{autoAt}</span>
              </div>
            )}
            {!autoAt && row.status === 'pending_client_review' && (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-400">Auto-approves</span>
                <span className="font-medium text-amber-700">No — needs the family's approval</span>
              </div>
            )}
          </div>

          {row.correctionHistory && row.correctionHistory.some(e => e.action !== 'submitted') && (
            <CorrectionTimeline history={row.correctionHistory} payRate={row.payRate} submittedLineItems={row.lineItems} submittedBasePay={row.basePay} submittedGrossPay={row.grossPay} />
          )}
          <button
            onClick={() => setShowDetailModal(true)}
            className="w-full py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
          >
            View shift
          </button>
        </div>
      )}
      {showDetailModal && (
        <ShiftDetailModal shiftId={row.appointmentId} onClose={() => setShowDetailModal(false)} />
      )}
    </div>
  );
};

const HistoryShiftRow: React.FC<{ row: ShiftRow }> = ({ row }) => {
  const [open, setOpen] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);

  // Prefer final (post-correction) times over originally submitted times
  const dispStart = row.finalStartTime
    ? new Date(row.finalStartTime)
    : row.submittedStartTime ? new Date(row.submittedStartTime) : null;
  const dispEnd = row.finalEndTime
    ? new Date(row.finalEndTime)
    : row.submittedEndTime   ? new Date(row.submittedEndTime)   : null;

  // Always compute hours from the actual clock-in/out timestamps (seconds-accurate).
  // Fall back to stored value only if timestamps are missing.
  const hours = (dispStart && dispEnd)
    ? (dispEnd.getTime() - dispStart.getTime()) / 3_600_000
    : (row.finalTotalHours ?? row.submittedTotalHours ?? 0);
  const basePay  = hours * (row.payRate ?? 0);
  const hasExtras = row.lineItems && row.lineItems.length > 0;
  // Use stored grossPay (includes line items) if available, otherwise compute from hours
  const gross = row.grossPay ?? basePay;
  const method = row.paymentMethod ? paymentMethodLabel(row.paymentMethod) : '—';

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      {/* one-line data strip */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 transition-colors select-none"
        onClick={() => setOpen(o => !o)}
      >
        <Col label="Date"     value={dispStart ? fmtDate(dispStart) : '—'}  className="shrink-0 w-[58px]" />
        <Divider />
        <Col label="In"       value={dispStart ? fmtTime(dispStart) : '—'}  className="shrink-0 w-[88px]" />
        <Divider />
        <Col label="Out"      value={dispEnd   ? fmtTime(dispEnd)   : '—'}  className="shrink-0 w-[88px]" />
        <Divider />
        <Col label="Duration" value={fmtDuration(hours)}                    className="shrink-0 w-[62px]" />
        <Divider />
        <Col label="Pay"      value={`$${gross.toFixed(2)}`} highlight      className="shrink-0 w-[60px]" />
        <Divider />
        <Col label="Method"   value={method}                                className="shrink-0 w-[46px]" />

        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
          {row.loggedManually && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 whitespace-nowrap">Logged</span>
          )}
          {(['caregiver', 'admin', 'system_auto_accept'].includes(row.resolvedBy ?? '')
            || (row.resolvedBy === 'client' && Array.isArray(row.correctionHistory) && row.correctionHistory.some((e: any) => ['correction_proposed', 'counter_proposed'].includes(e.action)))) && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-teal-50 text-teal-700 border-teal-200 whitespace-nowrap">
              Corrected
            </span>
          )}
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${STATUS_STYLE[row.status] || 'bg-slate-50 text-slate-500 border-slate-200'}`}>
            {STATUS_LABEL[row.status] || row.status}
          </span>
          {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </div>
      </div>

      {/* expanded details */}
      {open && (
        <div className="border-t-2 border-slate-200 bg-slate-50 px-4 py-3 space-y-3">

          <div className="divide-y divide-slate-200 text-xs border border-slate-200 rounded-xl overflow-hidden">
            {row.payRate != null && (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-400">Rate</span>
                <span className="font-medium text-slate-700">${row.payRate}/hr</span>
              </div>
            )}
            {dispStart && dispEnd && (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-400">Clock in / out</span>
                <span className="font-medium text-slate-700">
                  {fmtDateTime(dispStart)} – {fmtDateTime(dispEnd)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-slate-400">Total hours</span>
              <span className="font-medium text-slate-700">{fmtDuration(hours)}</span>
            </div>
            {hasExtras ? (
              <>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-slate-400">Base pay</span>
                  <span className="font-medium text-slate-700">${basePay.toFixed(2)}</span>
                </div>
                {row.lineItems!.map((li, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2">
                    <span className="text-slate-400">
                      {li.type === 'custom' ? (li.label || 'Custom') : li.label}
                      {li.note ? ` · ${li.note}` : ''}
                    </span>
                    <span className="font-medium text-slate-700">+${li.amount.toFixed(2)}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between px-3 py-2 bg-slate-100">
                  <span className="font-semibold text-slate-700">Total</span>
                  <span className="font-bold text-slate-900">${gross.toFixed(2)}</span>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-400">Gross pay</span>
                <span className="font-bold text-slate-900">${gross.toFixed(2)}</span>
              </div>
            )}
            {row.submittedAt && (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-400">Submitted</span>
                <span className="font-medium text-slate-700">
                  {new Date(row.submittedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
              </div>
            )}
          </div>

          {row.status === 'payment_failed' && row.stripeFailureReason && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
              ⚠ {row.stripeFailureReason}
            </p>
          )}

          {row.correctionHistory && row.correctionHistory.some(e => e.action !== 'submitted') && (
            <CorrectionTimeline history={row.correctionHistory} payRate={row.payRate} submittedLineItems={row.lineItems} submittedBasePay={row.basePay} submittedGrossPay={row.grossPay} />
          )}
          <button
            onClick={() => setShowDetailModal(true)}
            className="w-full py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
          >
            View shift
          </button>
        </div>
      )}
      {showDetailModal && (
        <ShiftDetailModal shiftId={row.appointmentId} onClose={() => setShowDetailModal(false)} />
      )}
    </div>
  );
};

// ── ShiftDetailModal ─────────────────────────────────────────────────────────

const ShiftDetailModal: React.FC<{ shiftId: string; onClose: () => void }> = ({ shiftId, onClose }) => {
  const [data, setData] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!db) return;
    db.collection('shifts').doc(shiftId).get().then(doc => {
      if (doc.exists) setData({ id: doc.id, ...doc.data() });
    }).finally(() => setLoading(false));
  }, [shiftId]);

  const fmtTs = (ts: any) => {
    if (!ts) return null;
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  };
  const fmtDate = (val: any) => {
    if (!val) return null;
    // Firestore Timestamp
    if (val?.toDate) return val.toDate().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    // ISO string "YYYY-MM-DD" or full ISO
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    // For plain "YYYY-MM-DD" strings, parse as local date to avoid UTC shift
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
      const [y, mo, dy] = val.split('-').map(Number);
      return new Date(y, mo - 1, dy).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };
  const fmtDur = (a: any, b: any) => {
    if (!a || !b) return null;
    const s = a?.toDate ? a.toDate() : new Date(a);
    const e = b?.toDate ? b.toDate() : new Date(b);
    const totalSecs = Math.round((e.getTime() - s.getTime()) / 1000);
    if (totalSecs <= 0) return null;
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const sec = totalSecs % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <p className="font-semibold text-slate-900">Completed Shift</p>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
          {loading ? (
            <div className="py-12 text-center text-slate-400 text-sm">Loading…</div>
          ) : !data ? (
            <div className="py-12 text-center text-slate-400 text-sm">Shift not found.</div>
          ) : (
            <>
              {/* Timing */}
              <div className="bg-slate-50 rounded-xl px-4 py-3 space-y-2">
                <div className="flex items-start gap-3 text-xs">
                  <span className="w-24 text-slate-400 shrink-0 pt-0.5">Scheduled</span>
                  <div className="font-semibold text-slate-700 leading-relaxed">
                    {fmtDate(data.date) && (
                      <span className="block text-slate-500 font-normal">{fmtDate(data.date)}</span>
                    )}
                    <span>{data.startTime ? new Date(`2000-01-01T${data.startTime}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : ''}{data.endTime ? ` – ${new Date(`2000-01-01T${data.endTime}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}` : ''}</span>
                  </div>
                </div>
                {(data.startedAt || data.completedAt) && (
                  <div className="flex items-start gap-3 text-xs pt-2 border-t border-slate-200">
                    <span className="w-24 text-slate-400 shrink-0 pt-0.5">Completed</span>
                    <div className="font-semibold text-slate-700 leading-relaxed">
                      {(() => {
                        const startDate = fmtDate(data.startedAt);
                        const endDate   = fmtDate(data.completedAt);
                        return (
                          <span className="block">
                            {data.startedAt && (
                              <><span className="text-slate-500 font-normal">{startDate}</span>{' '}{fmtTs(data.startedAt)}</>
                            )}
                            {data.completedAt && (
                              <>
                                <span className="text-slate-400 font-normal"> – </span>
                                <span className="text-slate-500 font-normal">{endDate}</span>
                                {' '}{fmtTs(data.completedAt)}
                              </>
                            )}
                            {fmtDur(data.startedAt, data.completedAt) && (
                              <span className="text-primary-600 font-semibold"> · {fmtDur(data.startedAt, data.completedAt)}</span>
                            )}
                          </span>
                        );
                      })()}

                    </div>
                  </div>
                )}
              </div>

              {/* Tasks */}
              {(() => {
                const doneRaw: string[] = data.tasksCompleted || [];
                const recipients: any[] = data.careRecipients || [];
                const hasTasks = recipients.some((r: any) => (r.careNeeds || []).length > 0);
                if (!hasTasks) return null;

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
                      {recipients.map((r: any, ri: number) => {
                        const cats: string[] = r.careNeeds || [];
                        const det: Record<string, string[]> = r.careNeedDetails || {};
                        if (cats.length === 0) return null;
                        return (
                          <div key={ri}>
                            <div className="flex items-center gap-1.5 mb-1.5">
                              <div className="w-5 h-5 rounded-full overflow-hidden bg-primary-100 shrink-0 flex items-center justify-center">
                                {r.photoURL
                                  ? <img src={r.photoURL} alt={r.name} className="w-full h-full object-cover" />
                                  : <span className="text-[9px] font-bold text-primary-600">{r.name.split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase()}</span>}
                              </div>
                              <p className="text-xs font-semibold text-slate-600">{r.name}</p>
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
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Completion notes */}
              {data.completionNotes && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                  <p className="text-xs font-semibold text-slate-500 mb-1">Caregiver Notes</p>
                  <p className="text-xs text-slate-600">{data.completionNotes}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ── SubmittableShiftCard ──────────────────────────────────────────────────────

/** One-line labeled card: Client | Date | In | Out | Duration | Est. Pay | Status */
const SubmittableShiftCard: React.FC<{
  shift: CompletedShift;
  onSubmitted: () => void;
  onError: (msg: string) => void;
  hideClient?: boolean;
}> = ({ shift, onSubmitted, onError, hideClient }) => {
  const [open, setOpen] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);

  const actualStart = toDate(shift.startedAt);
  const actualEnd   = toDate(shift.completedAt);

  const schedStart = new Date(`${shift.date}T${shift.startTime}:00`);
  const schedEnd   = shift.endTime
    ? new Date(`${shift.date}T${shift.endTime}:00`)
    : new Date(schedStart.getTime() + 3_600_000);

  const dispStart = actualStart ?? schedStart;
  const dispEnd   = actualEnd   ?? schedEnd;
  const hasActual = !!(actualStart && actualEnd);

  const durationH = dispEnd.getTime() > dispStart.getTime()
    ? (dispEnd.getTime() - dispStart.getTime()) / 3_600_000
    : 0;

  const estPay = shift.rate && durationH > 0 ? shift.rate * durationH : null;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      {/* ── single-line header (pure data strip) ── */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 transition-colors select-none"
        onClick={() => setOpen(o => !o)}
      >
        <Col label="Date"     value={fmtDate(dispStart)}                              className="shrink-0 w-[58px]" />
        <div className="w-px h-8 bg-slate-100 shrink-0" />
        <Col label={hasActual ? 'In'  : 'Sched in'}  value={fmtTime(dispStart)}      className="shrink-0 w-[88px]" />
        <div className="w-px h-8 bg-slate-100 shrink-0" />
        <Col label={hasActual ? 'Out' : 'Sched out'} value={fmtTime(dispEnd)}        className="shrink-0 w-[88px]" />
        <div className="w-px h-8 bg-slate-100 shrink-0" />
        <Col label="Duration" value={durationH > 0 ? fmtDuration(durationH) : '—'}    className="shrink-0 w-[58px]" />
        <div className="w-px h-8 bg-slate-100 shrink-0" />
        <Col label="Est. pay" value={estPay != null ? `$${estPay.toFixed(2)}` : '—'} highlight className="shrink-0 w-[60px]" />
        <div className="w-px h-8 bg-slate-100 shrink-0" />
        <Col
          label="Method"
          value={shift.paymentMethod ? paymentMethodLabel(shift.paymentMethod) : '—'}
          className="shrink-0 w-[46px]"
        />

        {/* Status badge + chevron — pushed to the right */}
        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
          {shift.loggedManually && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 whitespace-nowrap">
              Logged
            </span>
          )}
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 whitespace-nowrap">
            Not submitted
          </span>
          {open
            ? <ChevronUp  className="w-4 h-4 text-slate-400" />
            : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </div>
      </div>

      {/* ── expanded details ── */}
      {open && (
        <div className="border-t-2 border-slate-200 bg-slate-50 px-4 py-3 space-y-3">
          {/* Client identity — hidden when grouped */}
          {!hideClient && (
            <div className="flex items-center gap-3">
              {shift.clientPhotoURL ? (
                <img src={shift.clientPhotoURL} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
              ) : (
                <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center shrink-0">
                  <span className="text-sm font-bold text-primary-700">
                    {(shift.clientName || '?').charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
              <p className="text-sm font-semibold text-slate-900">{shift.clientName ?? 'Client'}</p>
            </div>
          )}

          <div className="divide-y divide-slate-200 text-xs border border-slate-200 rounded-xl overflow-hidden">
            {shift.rate != null && (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-400">Rate</span>
                <span className="font-medium text-slate-700">${shift.rate}/hr</span>
              </div>
            )}
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-slate-400">Scheduled</span>
              <span className="font-medium text-slate-700">
                {fmtDate(schedStart)} · {fmtTime(schedStart)}{shift.endTime ? `–${fmtTime(schedEnd)}` : ''}
              </span>
            </div>
            {hasActual && (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-400">{shift.loggedManually ? 'Reported in' : 'Clock in'}</span>
                <span className="font-medium text-slate-700">{fmtDateTime(actualStart!)}</span>
              </div>
            )}
            {hasActual && (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-400">{shift.loggedManually ? 'Reported out' : 'Clock out'}</span>
                <span className="font-medium text-slate-700">{fmtDateTime(actualEnd!)}</span>
              </div>
            )}
            {shift.careRecipients && shift.careRecipients.length > 0 && (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-400">
                  {shift.careRecipients.length === 1 ? 'Recipient' : 'Recipients'}
                </span>
                <span className="font-medium text-slate-700">
                  {shift.careRecipients.map(r => r.name).join(', ')}
                </span>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={e => { e.stopPropagation(); setShowDetailModal(true); }}
              className="flex-1 py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
            >
              View shift
            </button>
            <button
              onClick={e => { e.stopPropagation(); setShowModal(true); }}
              className="flex-1 py-2.5 rounded-xl bg-primary-600 text-white text-sm font-semibold hover:bg-primary-700 transition-colors"
            >
              Submit hours
            </button>
          </div>
        </div>
      )}

      {showDetailModal && (
        <ShiftDetailModal shiftId={shift.id} onClose={() => setShowDetailModal(false)} />
      )}

      {showModal && (
        <SubmitShiftHoursModal
          shift={shift}
          onClose={() => setShowModal(false)}
          onSubmitted={() => { setShowModal(false); onSubmitted(); }}
          onError={(msg) => { setShowModal(false); onError(msg); }}
        />
      )}
    </div>
  );
};

// ── main page ─────────────────────────────────────────────────────────────────

export const CaregiverPaymentsPage: React.FC = () => {
  const { currentUser, addToast, setMembershipModalOpen } = useCareConnex();
  const navigate = useNavigate();
  const uid = currentUser?.uid ?? '';

  // Deep-linkable via ?tab=payouts|timesheets|membership — the "Set up payouts"
  // checklist CTA (CaregiverOnboardingDashboard.tsx) sends caregivers straight
  // here rather than making them find the tab themselves.
  const initialTab = (() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return (t === 'payouts' || t === 'timesheets' || t === 'membership') ? t : 'timesheets';
  })();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [tsFilter, setTsFilter] = useState<'unsubmitted' | 'pending' | 'history'>('unsubmitted');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (key: string) => setExpandedGroups(prev => ({ ...prev, [key]: !prev[key] }));
  const [showReport, setShowReport] = useState(false);
  const [reportFrom, setReportFrom] = useState('');
  const [reportTo,   setReportTo]   = useState('');
  const [shiftRows, setShiftRows] = useState<ShiftRow[]>([]);
  const [completedShifts, setCompletedShifts] = useState<CompletedShift[]>([]);

  // Payouts tab state
  const [profile, setProfile] = useState<Caregiver | null>(null);
  const [showPayoutModal, setShowPayoutModal] = useState(false);
  // Live Stripe instant balance — what a cash-out will actually pay. The
  // shift-derived availableBalance below is "earned"; charges/transfers may
  // still be settling, so the two can differ.
  const [instantBalance, setInstantBalance] = useState<number | null>(null);
  const [fetchingBalance, setFetchingBalance] = useState(false);

  // Membership tab state
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [managing, setManaging] = useState(false);
  const [becomingDriver, setBecomingDriver] = useState(false);

  // ── data subscriptions ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!uid) return;
    const unsub = shiftHoursService.subscribeForCaregiver(uid, rows => setShiftRows(rows as ShiftRow[]));
    return () => { try { (unsub as any)?.(); } catch {} };
  }, [uid]);

  useEffect(() => {
    if (!uid || !db) return;
    // Watch the shifts collection (source of truth for completed visits)
    const unsub = db.collection('shifts')
      .where('caregiverId', '==', uid)
      .where('status', '==', 'completed')
      .onSnapshot(snap => {
        setCompletedShifts(snap.docs.map(d => ({ id: d.id, ...d.data() } as CompletedShift)));
      });
    return () => unsub();
  }, [uid]);

  useEffect(() => {
    if (!uid) return;
    let active = true;
    // Initial load gives the full merged profile (users + caregivers doc),
    // plus the owner-only private/payout subdoc (stripeAccountId + Connect
    // flags moved off the world-readable parent).
    (async () => {
      const [p, payout] = await Promise.all([
        dbService.getUser(uid),
        dbService.getOwnCaregiverPayoutFields(uid),
      ]);
      if (active && p) setProfile({ ...(p as any), ...payout });
    })();
    // Live-patch the caregiver-doc fields (rate, verification, background
    // check) so Evia's writes reflect here without a manual refresh. Re-merge
    // the payout subdoc on each patch so the parent doc (which no longer
    // carries the Stripe fields) can't clobber them.
    const unsub = dbService.subscribeCaregiverProfile(uid, async (cg) => {
      if (!active || !cg) return;
      const payout = await dbService.getOwnCaregiverPayoutFields(uid);
      if (active) setProfile(prev => ({ ...(prev as any), ...cg, ...payout }));
    });
    return () => { active = false; try { (unsub as any)?.(); } catch {} };
  }, [uid]);

  // Load membership subscription details when tab opens
  useEffect(() => {
    if (tab !== 'membership' || subscription !== null) return;
    setSubLoading(true);
    getSubscriptionStatus()
      .then(s => setSubscription({ status: s.status, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd }))
      .catch(() => setSubscription({ status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false }))
      .finally(() => setSubLoading(false));
  }, [tab, subscription]);

  // On return from Stripe onboarding, force a status refresh
  useEffect(() => {
    if (!profile?.stripeAccountId) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('stripe') !== 'success') return;
    (async () => {
      try {
        await checkOnboardingStatus(profile.stripeAccountId!);
        const [p, payout] = await Promise.all([
          dbService.getUser(uid),
          dbService.getOwnCaregiverPayoutFields(uid),
        ]);
        if (p) setProfile({ ...(p as any), ...payout });
        addToast('Payout setup updated', 'success');
      } catch (err) {
        console.error('Status refresh failed:', err);
      } finally {
        const url = new URL(window.location.href);
        url.searchParams.delete('stripe');
        window.history.replaceState({}, '', url.toString());
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.stripeAccountId]);

  // ── derived state ─────────────────────────────────────────────────────────

  const submittableShifts = useMemo(() => {
    // shiftRows use appointmentId which is set to the shiftId by submitShiftHours
    const withHours = new Set(shiftRows.map(r => r.appointmentId));
    return completedShifts.filter(s => !withHours.has(s.id));
  }, [completedShifts, shiftRows]);

  const pendingRows = shiftRows.filter(r =>
    ['pending_client_review', 'correction_proposed', 'caregiver_counter_proposed', 'payment_failed'].includes(r.status)
  );
  const historyRows = shiftRows.filter(r =>
    !['pending_client_review', 'correction_proposed', 'caregiver_counter_proposed', 'payment_failed'].includes(r.status)
  );
  const actionCount = submittableShifts.length + pendingRows.length;

  // Available balance: credit bookings that are approved/auto_approved but not paid yet
  const availableBalance = useMemo(() => {
    return shiftRows
      .filter(r => r.paymentMethod === 'credit' && (r.status === 'approved' || r.status === 'auto_approved'))
      .reduce((sum, r) => {
        const hours = r.finalTotalHours ?? r.submittedTotalHours ?? 0;
        const pay = r.grossPay ?? hours * (r.payRate ?? 0);
        return sum + pay;
      }, 0);
  }, [shiftRows]);

  const hasAccount = !!profile?.stripeAccountId;
  const fullyEnabled = !!(profile?.payoutsEnabled && profile?.chargesEnabled);
  const canPayout = fullyEnabled && availableBalance >= 1;

  // Report: date-filtered slice of historyRows
  const reportedRows = useMemo(() => {
    if (!showReport || (!reportFrom && !reportTo)) return historyRows;
    return historyRows.filter(r => {
      const raw = r.submittedStartTime ?? r.submittedAt;
      if (!raw) return false;
      const d = new Date(raw).toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
      if (reportFrom && d < reportFrom) return false;
      if (reportTo   && d > reportTo)   return false;
      return true;
    });
  }, [historyRows, showReport, reportFrom, reportTo]);

  const reportSummary = useMemo(() => {
    const rows = reportedRows;
    const totalHours = rows.reduce((s, r) => {
      const startTs = r.finalStartTime ?? r.submittedStartTime;
      const endTs   = r.finalEndTime   ?? r.submittedEndTime;
      const h = (startTs && endTs)
        ? (new Date(endTs).getTime() - new Date(startTs).getTime()) / 3_600_000
        : (r.finalTotalHours ?? r.submittedTotalHours ?? 0);
      return s + h;
    }, 0);
    const totalPay   = rows.reduce((s, r) => {
      return s + (r.grossPay ?? 0);
    }, 0);
    return { shifts: rows.length, hours: totalHours, pay: totalPay };
  }, [reportedRows]);

  // ── handlers ──────────────────────────────────────────────────────────────

  const handleExportCSV = () => {
    const header = ['Client', 'Date', 'Clock In', 'Clock Out', 'Duration', 'Pay ($)', 'Method', 'Status'];
    const lines = reportedRows.map(r => {
      const startTs = r.finalStartTime ?? r.submittedStartTime;
      const endTs   = r.finalEndTime   ?? r.submittedEndTime;
      const date    = startTs ? new Date(startTs).toLocaleDateString('en-CA') : '';
      const clockIn = startTs ? fmtTime(new Date(startTs)) : '';
      const clockOut= endTs   ? fmtTime(new Date(endTs))   : '';
      const h = (startTs && endTs)
        ? (new Date(endTs).getTime() - new Date(startTs).getTime()) / 3_600_000
        : (r.finalTotalHours ?? r.submittedTotalHours ?? 0);
      const duration = `"${fmtDuration(h)}"`;  // quoted so Excel treats as text, not time
      const pay = r.grossPay ?? h * (r.payRate ?? 0);
      return [
        `"${(r.clientName ?? '').replace(/"/g, '""')}"`,
        date,
        clockIn,
        clockOut,
        duration,
        pay.toFixed(2),
        r.paymentMethod ?? '',
        STATUS_LABEL[r.status] ?? r.status,
      ].join(',');
    });
    const csv  = [header.join(','), ...lines].join('\n');
    const url  = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `timesheet-${reportFrom || 'all'}-to-${reportTo || 'all'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRespondToCorrection = async (
    row: ShiftRow,
    action: 'accept' | 'counter_propose',
    counter?: { startTime: string; endTime: string; note?: string; lineItems?: LineItem[] }
  ) => {
    try {
      await shiftHoursService.respondToCorrection(row.appointmentId, action, counter as any);
      addToast(
        action === 'accept' ? 'Correction accepted' : 'Counter-proposal sent to client',
        'success'
      );
    } catch (e: any) {
      addToast(e?.message || 'Failed to respond', 'error');
    }
  };

  const handlePayout = async () => {
    try {
      const result = await requestInstantPayout();
      if (result.success) {
        addToast(`Instant payout of $${result.amount.toFixed(2)} initiated — free, arrives in ~30 minutes!`, 'success');
      }
    } catch (error: any) {
      addToast(error.message || 'Payout failed. Please try again.', 'error');
      throw error;
    }
  };

  const handleOpenPayoutModal = async () => {
    setFetchingBalance(true);
    try {
      const balance = await getPayoutBalance();
      setInstantBalance(balance.instantAvailable);
      if (balance.instantAvailable < 1) {
        addToast(
          balance.pending > 0
            ? `$${balance.pending.toFixed(2)} is still settling — it pays out automatically, no action needed.`
            : 'Nothing to cash out right now — your earnings pay out automatically every day.',
          'info',
        );
        return;
      }
      setShowPayoutModal(true);
    } catch {
      // Balance lookup failed — open with the shift-derived figure; the
      // backend re-checks the real balance before paying anyway.
      setInstantBalance(null);
      setShowPayoutModal(true);
    } finally {
      setFetchingBalance(false);
    }
  };

  const handleManageMembership = async () => {
    setManaging(true);
    try {
      const url = await getCaregiverBillingPortalUrl();
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e: any) {
      const code = e?.code as string | undefined;
      let msg = 'Could not open billing portal. Please try again.';
      if (code === 'functions/not-found' || e?.message?.includes('No billing account')) {
        msg = 'No billing account found. Please purchase a membership first.';
      } else if (code === 'functions/unauthenticated') {
        msg = 'Please log in to manage your membership.';
      } else if (code === 'functions/internal' || code === 'internal') {
        msg = 'Billing portal unavailable right now. Please try again later.';
      } else if (e?.message && !['internal', 'unknown'].includes(e.message)) {
        msg = e.message;
      }
      addToast(msg, 'error');
    } finally {
      setManaging(false);
    }
  };

  const handleBecomeApprovedDriver = async () => {
    setBecomingDriver(true);
    try {
      const successUrl = `${window.location.origin}/caregiver/payments?mvr=success`;
      const cancelUrl = `${window.location.origin}/caregiver/payments`;
      const url = await createMvrAddonCheckout(successUrl, cancelUrl);
      if (url) {
        window.location.href = url;
      } else {
        addToast('Could not start the Approved Driver checkout. Please try again.', 'error');
      }
    } catch (e: any) {
      addToast(e?.message || 'The Approved Driver add-on is unavailable right now. Please try again later.', 'error');
    } finally {
      setBecomingDriver(false);
    }
  };

  // ── render ────────────────────────────────────────────────────────────────

  if (!uid) return null;

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <CaregiverTopNav />

      <div className="max-w-3xl mx-auto px-4 md:px-6 py-6">
        {/* Page heading */}
        <h1 className="text-2xl font-bold text-slate-900 mb-5">Payments</h1>

        {/* Tab pills */}
        <div className="flex gap-2 mb-6">
          {([
            { id: 'timesheets',  label: 'Timesheets',  badge: actionCount },
            { id: 'payouts',     label: 'Payouts',     badge: 0 },
            { id: 'membership',  label: 'Membership',  badge: 0 },
          ] as { id: Tab; label: string; badge: number }[]).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative flex items-center gap-2 px-5 py-2 rounded-full text-sm font-semibold transition-all ${
                tab === t.id
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'bg-white text-slate-600 border border-slate-200 hover:border-slate-300'
              }`}
            >
              {t.label}
              {t.badge > 0 && (
                <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${tab === t.id ? 'bg-white/20 text-white' : 'bg-amber-500 text-white'}`}>
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        <hr className="border-slate-200 mb-6" />

        {/* ── TIMESHEETS TAB ─────────────────────────────────────────────── */}
        {tab === 'timesheets' && (
          <div className="space-y-4">
            {/* Filter chips + Report button */}
            <div className="flex items-center gap-2 flex-wrap">
              {([
                { id: 'unsubmitted', label: 'Unsubmitted', count: submittableShifts.length, alert: true  },
                { id: 'pending',     label: 'Pending',     count: pendingRows.length,        alert: true  },
                { id: 'history',     label: 'History',     count: historyRows.length,        alert: false },
              ] as { id: typeof tsFilter; label: string; count: number; alert: boolean }[]).map(f => (
                <button
                  key={f.id}
                  onClick={() => { setTsFilter(f.id); if (f.id !== 'history') { setShowReport(false); } }}
                  className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-medium transition-all border ${
                    tsFilter === f.id
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                  }`}
                >
                  {f.label}
                  {f.count > 0 && (
                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full leading-none ${
                      tsFilter === f.id
                        ? 'bg-white/20 text-white'
                        : f.alert
                        ? 'bg-amber-500 text-white'
                        : 'bg-slate-100 text-slate-600'
                    }`}>
                      {f.count}
                    </span>
                  )}
                </button>
              ))}

              {/* Report toggle — only visible on History filter */}
              {tsFilter === 'history' && (
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

            {/* ── Report panel ── */}
            {showReport && (
              <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
                {/* Date inputs + export */}
                <div className="flex items-end gap-3 flex-wrap">
                  <div>
                    <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">From</label>
                    <input
                      type="date"
                      value={reportFrom}
                      onChange={e => setReportFrom(e.target.value)}
                      className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">To</label>
                    <input
                      type="date"
                      value={reportTo}
                      onChange={e => setReportTo(e.target.value)}
                      className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
                    />
                  </div>
                  {(reportFrom || reportTo) && (
                    <button
                      onClick={() => { setReportFrom(''); setReportTo(''); }}
                      className="text-xs text-slate-400 hover:text-slate-600 pb-1.5"
                    >
                      Clear
                    </button>
                  )}
                  <button
                    onClick={handleExportCSV}
                    disabled={reportedRows.length === 0}
                    className="ml-auto flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-40 transition-colors"
                  >
                    <FileDown className="w-3.5 h-3.5" />
                    Export CSV
                  </button>
                </div>

                {/* Summary row */}
                {reportedRows.length > 0 ? (
                  <div className="flex gap-6 pt-2 border-t border-slate-100">
                    {[
                      { label: 'Shifts',          value: String(reportSummary.shifts) },
                      { label: 'Total hours',      value: fmtDuration(reportSummary.hours) },
                      { label: 'Total earnings',   value: `$${reportSummary.pay.toFixed(2)}` },
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

            {/* Unified filtered list — grouped by client */}
            <div className="space-y-4">
              {/* Unsubmitted */}
              {tsFilter === 'unsubmitted' && (() => {
                const grouped = submittableShifts.reduce((acc, shift) => {
                  const key = shift.clientId || shift.clientName || 'unknown';
                  if (!acc[key]) acc[key] = { name: shift.clientName ?? 'Client', photo: shift.clientPhotoURL ?? undefined, shifts: [] };
                  acc[key].shifts.push(shift);
                  return acc;
                }, {} as Record<string, { name: string; photo?: string; shifts: typeof submittableShifts }>);
                return Object.entries(grouped).map(([key, group]) => {
                  const isExpanded = !!expandedGroups[key];
                  const visible = isExpanded ? group.shifts : group.shifts.slice(0, 2);
                  const hidden = group.shifts.length - 2;
                  return (
                    <div key={key}>
                      <div className="flex items-center gap-2 mb-2 px-1">
                        <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-xs shrink-0">
                          {group.photo ? <img src={group.photo} className="w-full h-full object-cover" alt="" /> : group.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm font-semibold text-slate-700">{group.name}</span>
                        <span className="text-xs text-slate-400">{group.shifts.length} shift{group.shifts.length !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="space-y-2">
                        {visible.map(shift => (
                          <SubmittableShiftCard key={shift.id} shift={shift} hideClient
                            onSubmitted={() => addToast('Hours submitted — awaiting client approval', 'success')}
                            onError={(msg) => addToast(msg || 'Failed to submit hours', 'error')}
                          />
                        ))}
                        {hidden > 0 && !isExpanded && (
                          <button onClick={() => toggleGroup(key)} className="w-full text-xs text-primary-600 hover:text-primary-800 font-medium py-1.5 text-center">
                            Show more
                          </button>
                        )}
                        {isExpanded && group.shifts.length > 2 && (
                          <button onClick={() => toggleGroup(key)} className="w-full text-xs text-slate-400 hover:text-slate-600 font-medium py-1.5 text-center">
                            Show less
                          </button>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}

              {/* Pending */}
              {tsFilter === 'pending' && (() => {
                const grouped = pendingRows.reduce((acc, row) => {
                  const key = (row as any).clientId || row.clientName || 'unknown';
                  if (!acc[key]) acc[key] = { name: row.clientName ?? 'Client', photo: row.clientPhotoURL ?? undefined, rows: [] };
                  acc[key].rows.push(row);
                  return acc;
                }, {} as Record<string, { name: string; photo?: string; rows: typeof pendingRows }>);
                return Object.entries(grouped).map(([key, group]) => {
                  const gkey = `p_${key}`;
                  const isExpanded = !!expandedGroups[gkey];
                  const visible = isExpanded ? group.rows : group.rows.slice(0, 2);
                  const hidden = group.rows.length - 2;
                  return (
                    <div key={key}>
                      <div className="flex items-center gap-2 mb-2 px-1">
                        <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-xs shrink-0">
                          {group.photo ? <img src={group.photo} className="w-full h-full object-cover" alt="" /> : group.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm font-semibold text-slate-700">{group.name}</span>
                        <span className="text-xs text-slate-400">{group.rows.length} shift{group.rows.length !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="space-y-2">
                        {visible.map(row => (
                          <PendingShiftRow key={row.id} row={row}
                            onRespond={(action, counter) => handleRespondToCorrection(row, action, counter)}
                          />
                        ))}
                        {hidden > 0 && !isExpanded && <button onClick={() => toggleGroup(gkey)} className="w-full text-xs text-primary-600 hover:text-primary-800 font-medium py-1.5 text-center">Show more</button>}
                        {isExpanded && group.rows.length > 2 && <button onClick={() => toggleGroup(gkey)} className="w-full text-xs text-slate-400 hover:text-slate-600 font-medium py-1.5 text-center">Show less</button>}
                      </div>
                    </div>
                  );
                });
              })()}

              {/* History — month → client two-level grouping (History filter only) */}
              {tsFilter === 'history' && reportedRows.length > 0 && (() => {
                const sorted = reportedRows.slice().sort((a, b) =>
                  new Date(b.submittedStartTime ?? b.submittedAt ?? '').getTime() -
                  new Date(a.submittedStartTime ?? a.submittedAt ?? '').getTime()
                );
                const monthGroups = sorted.reduce((acc, row) => {
                  const d = new Date(row.submittedStartTime ?? row.submittedAt ?? '');
                  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                  const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
                  if (!acc[key]) acc[key] = { label, rows: [] };
                  acc[key].rows.push(row);
                  return acc;
                }, {} as Record<string, { label: string; rows: typeof reportedRows }>);
                return Object.entries(monthGroups).map(([monthKey, monthGroup]) => {
                  const monthTotal = monthGroup.rows.reduce((s, r) => s + (r.grossPay ?? 0), 0);
                  const clientGroups = monthGroup.rows.reduce((acc, row) => {
                    const key = (row as any).clientId || row.clientName || 'unknown';
                    if (!acc[key]) acc[key] = { name: row.clientName ?? 'Client', photo: row.clientPhotoURL ?? undefined, rows: [] };
                    acc[key].rows.push(row);
                    return acc;
                  }, {} as Record<string, { name: string; photo?: string; rows: typeof reportedRows }>);
                  return (
                    <div key={monthKey} className="space-y-3">
                      <div className="flex items-center justify-between px-1 pt-2 border-t border-slate-100 first:border-t-0 first:pt-0">
                        <span className="text-sm font-bold text-slate-800">{monthGroup.label}</span>
                        <span className="text-xs text-slate-500">{monthGroup.rows.length} shift{monthGroup.rows.length !== 1 ? 's' : ''} · ${monthTotal.toFixed(2)}</span>
                      </div>
                      {Object.entries(clientGroups).map(([clientKey, clientGroup]) => {
                        const expandKey = `h_${monthKey}_${clientKey}`;
                        const isExpanded = !!expandedGroups[expandKey];
                        const visible = isExpanded ? clientGroup.rows : clientGroup.rows.slice(0, 2);
                        const hidden = clientGroup.rows.length - 2;
                        return (
                          <div key={clientKey} className="space-y-2">
                            <div className="flex items-center gap-2 px-1">
                              <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-xs shrink-0">
                                {clientGroup.photo ? <img src={clientGroup.photo} className="w-full h-full object-cover" alt="" /> : clientGroup.name.charAt(0).toUpperCase()}
                              </div>
                              <span className="text-sm font-semibold text-slate-700">{clientGroup.name}</span>
                              <span className="text-xs text-slate-400">{clientGroup.rows.length} shift{clientGroup.rows.length !== 1 ? 's' : ''}</span>
                            </div>
                            <div className="space-y-2">
                              {visible.map(row => <HistoryShiftRow key={row.id} row={row} />)}
                            </div>
                            {hidden > 0 && !isExpanded && (
                              <button onClick={() => toggleGroup(expandKey)} className="w-full text-xs text-primary-600 hover:text-primary-800 font-medium py-1.5 text-center">
                                Show {hidden} more
                              </button>
                            )}
                            {isExpanded && clientGroup.rows.length > 2 && (
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
              })()}

              {/* Empty state */}
              {((tsFilter === 'unsubmitted' && submittableShifts.length === 0) ||
                (tsFilter === 'pending'     && pendingRows.length === 0) ||
                (tsFilter === 'history'     && reportedRows.length === 0)) && (
                <div className="bg-white rounded-2xl border border-slate-200 p-6 text-sm text-slate-400 text-center">
                  {tsFilter === 'unsubmitted' ? 'No shifts waiting on you to submit hours.' :
                   tsFilter === 'pending'     ? 'Nothing pending.'                          :
                                               'No completed shifts yet.'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── PAYOUTS TAB ───────────────────────────────────────────────── */}
        {tab === 'payouts' && (
          <div className="space-y-4">

            {/* Available balance hero */}
            <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-3xl p-6 text-white relative overflow-hidden">
              <div className="absolute right-4 top-4 opacity-5">
                <DollarSign size={120} />
              </div>
              <div className="relative z-10">
                <p className="text-slate-400 text-sm font-medium mb-1">Available to Cash Out</p>
                <p className="text-4xl font-bold mb-4">${availableBalance.toFixed(2)}</p>

                {canPayout ? (
                  <button
                    onClick={handleOpenPayoutModal}
                    disabled={fetchingBalance}
                    className="flex items-center gap-2 bg-white text-slate-900 px-5 py-2.5 rounded-xl font-semibold text-sm hover:bg-slate-100 disabled:opacity-60 transition-colors shadow-sm"
                  >
                    <Zap className="w-4 h-4 text-blue-600" />
                    {fetchingBalance ? 'Checking balance…' : 'Cash Out'}
                  </button>
                ) : !fullyEnabled ? (
                  <button
                    onClick={() => {}}
                    className="flex items-center gap-2 bg-white/10 border border-white/20 text-white px-5 py-2.5 rounded-xl font-semibold text-sm hover:bg-white/20 transition-colors"
                  >
                    <Landmark className="w-4 h-4" />
                    Connect a bank to unlock payouts
                  </button>
                ) : (
                  <p className="text-sm text-slate-400">No approved earnings to cash out yet.</p>
                )}

                <p className="text-xs text-slate-400 mt-3">
                  💡 Earnings pay out automatically every day (free) · Instant cash-out: free, ~30 min
                </p>
              </div>
            </div>

            {/* Bank account / Stripe Connect */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <p className="font-bold text-slate-900 mb-3">Bank account (Stripe)</p>
              {fullyEnabled ? (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle2 className="w-5 h-5 text-green-600" />
                    <p className="text-sm font-semibold text-green-700">Bank account connected</p>
                  </div>
                  <p className="text-sm text-slate-500 mb-3">
                    Earnings pay out automatically every day and arrive ~2 business days after each visit is paid (free).
                    Instant payouts arrive in about 30 minutes — also free.
                  </p>
                  <a
                    href="https://dashboard.stripe.com/express"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary-700 hover:underline"
                  >
                    Manage in Stripe <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </>
              ) : hasAccount ? (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <AlertCircle className="w-5 h-5 text-amber-600" />
                    <p className="text-sm font-semibold text-amber-700">Setup incomplete</p>
                  </div>
                  <p className="text-sm text-slate-500 mb-3">
                    Stripe needs more information. Finish the onboarding to start receiving payouts.
                  </p>
                  <ConnectBankButton onShowToast={addToast} />
                </>
              ) : (
                <>
                  <p className="text-sm text-slate-500 mb-3">
                    Connect a bank account to receive payouts from credit-card bookings.
                  </p>
                  <ConnectBankButton onShowToast={addToast} />
                </>
              )}
              <p className="mt-3 text-xs text-slate-400 flex items-center gap-1">
                <Lock className="w-3 h-3" /> Secured by Stripe
              </p>
            </div>

            {/* Payout schedule info */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <p className="font-bold text-slate-900 mb-3 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-primary-600" /> Payout schedule
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-slate-50 rounded-xl text-center">
                  <p className="font-semibold text-slate-900 text-sm">Automatic</p>
                  <p className="text-xs text-slate-500 mt-0.5">Daily · ~2 business days</p>
                  <p className="text-xs font-bold text-green-600 mt-1">Free</p>
                </div>
                <div className="p-3 bg-primary-50 border border-primary-100 rounded-xl text-center">
                  <p className="font-semibold text-slate-900 text-sm">Instant</p>
                  <p className="text-xs text-slate-500 mt-0.5">~30 minutes</p>
                  <p className="text-xs font-bold text-primary-600 mt-1">Free</p>
                </div>
              </div>
            </div>

            {/* Payout history */}
            {uid && <PayoutHistory uid={uid} />}

          </div>
        )}

        {/* ── MEMBERSHIP TAB ────────────────────────────────────────────── */}
        {tab === 'membership' && (
          <div className="space-y-4">
            <MembershipCard
              profile={profile}
              subscription={subscription}
              loading={subLoading}
              onRefresh={() => { setSubscription(null); }}
              onGetMembership={() => setMembershipModalOpen(true)}
              onManage={handleManageMembership}
              managing={managing}
            />
            <ApprovedDriverCard
              isApprovedDriver={(profile as any)?.isApprovedDriver === true}
              mvrPending={(profile as any)?.mvrPaid === true && (profile as any)?.isApprovedDriver !== true}
              onBecomeDriver={handleBecomeApprovedDriver}
              busy={becomingDriver}
            />
          </div>
        )}
      </div>

      {/* Modals */}
      {showPayoutModal && (
        <InstantPayoutModal
          availableBalance={instantBalance ?? availableBalance}
          onClose={() => setShowPayoutModal(false)}
          onConfirm={handlePayout}
          onShowToast={addToast}
        />
      )}
    </div>
  );
};

// ── ApprovedDriverCard ─────────────────────────────────────────────────────────
// Surfaces the caregiver's Approved Driver (MVR) status and the self-serve
// "add MVR later" upgrade. isApprovedDriver was previously written by the backend
// but shown nowhere — this is its first UI surface.

interface ApprovedDriverCardProps {
  isApprovedDriver: boolean;
  mvrPending: boolean;
  onBecomeDriver: () => void;
  busy: boolean;
}

const ApprovedDriverCard: React.FC<ApprovedDriverCardProps> = ({
  isApprovedDriver, mvrPending, onBecomeDriver, busy,
}) => {
  if (isApprovedDriver) {
    return (
      <div className="bg-white rounded-2xl border border-blue-200 p-5 flex items-center gap-3">
        <div className="w-11 h-11 bg-blue-500 rounded-xl flex items-center justify-center flex-shrink-0">
          <Car className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1">
          <p className="font-semibold text-slate-900 text-sm flex items-center gap-1.5">
            Approved Driver <CheckCircle className="w-4 h-4 text-blue-600" />
          </p>
          <p className="text-xs text-slate-500">Families who need a driver can see your verified-driver badge.</p>
        </div>
      </div>
    );
  }

  if (mvrPending) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-5 flex items-center gap-3">
        <div className="w-11 h-11 bg-slate-100 rounded-xl flex items-center justify-center flex-shrink-0">
          <Car className="w-5 h-5 text-slate-400" />
        </div>
        <div className="flex-1">
          <p className="font-semibold text-slate-900 text-sm">Driver check in progress</p>
          <p className="text-xs text-slate-500">Your Motor Vehicle Report is being reviewed. We'll activate your Approved Driver badge once it clears.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-11 h-11 bg-blue-50 rounded-xl flex items-center justify-center flex-shrink-0">
          <Car className="w-5 h-5 text-blue-600" />
        </div>
        <div className="flex-1">
          <p className="font-semibold text-slate-900 text-sm">Become an Approved Driver</p>
          <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
            Add a Motor Vehicle Report (MVR) check so families who need a driver can see your verified-driver badge. One-time add-on; doesn't change your membership.
          </p>
        </div>
      </div>
      <button
        onClick={onBecomeDriver}
        disabled={busy}
        className="w-full py-3 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-sm rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
      >
        {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Car className="w-4 h-4" />}
        {busy ? 'Starting checkout…' : 'Add Approved Driver status'}
      </button>
    </div>
  );
};

// ── MembershipCard ────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  active:         { label: 'Active',          color: 'text-green-700',  bg: 'bg-green-50 border-green-200',  icon: <CheckCircle2 className="w-4 h-4 text-green-600" /> },
  trialing:       { label: 'Trial',           color: 'text-blue-700',   bg: 'bg-blue-50 border-blue-200',    icon: <ShieldCheck className="w-4 h-4 text-blue-600" /> },
  past_due:       { label: 'Payment due',     color: 'text-amber-700',  bg: 'bg-amber-50 border-amber-200',  icon: <AlertCircle className="w-4 h-4 text-amber-600" /> },
  payment_failed: { label: 'Payment failed',  color: 'text-red-700',    bg: 'bg-red-50 border-red-200',      icon: <XCircle className="w-4 h-4 text-red-600" /> },
  canceled:       { label: 'Canceled',        color: 'text-slate-600',  bg: 'bg-slate-50 border-slate-200',  icon: <XCircle className="w-4 h-4 text-slate-400" /> },
};

interface MembershipCardProps {
  profile: Caregiver | null;
  subscription: SubscriptionInfo | null;
  loading: boolean;
  onRefresh: () => void;
  onGetMembership: () => void;
  onManage: () => Promise<void>;
  managing: boolean;
}

const MembershipCard: React.FC<MembershipCardProps> = ({
  profile, subscription, loading, onRefresh, onGetMembership, onManage, managing,
}) => {
  const status = profile?.membershipStatus as string | undefined;
  const isActive = status === 'active' || status === 'trialing';
  const badge = status ? STATUS_BADGE[status] : null;

  const renewalDate = subscription?.currentPeriodEnd
    ? subscription.currentPeriodEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-8 flex items-center justify-center gap-2 text-slate-400 text-sm">
        <RefreshCw className="w-4 h-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (!isActive) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center">
        <div className="w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <ShieldCheck className="w-7 h-7 text-slate-400" />
        </div>
        <h3 className="font-bold text-slate-900 mb-1">No active membership</h3>
        <p className="text-sm text-slate-500 mb-5">
          {status === 'canceled'
            ? 'Your membership was canceled. Renew to access jobs and platform features.'
            : 'Activate your membership to start accepting bookings and applying for jobs.'}
        </p>
        <button
          onClick={onGetMembership}
          className="px-6 py-2.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold rounded-xl transition-colors"
        >
          Activate Membership
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Status hero */}
      <div className="bg-gradient-to-br from-primary-600 to-blue-700 rounded-3xl p-6 text-white relative overflow-hidden">
        <div className="absolute right-4 top-4 opacity-10">
          <ShieldCheck size={100} />
        </div>
        <div className="relative z-10">
          <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-semibold mb-3 ${badge ? badge.bg + ' ' + badge.color : 'bg-white/20 text-white border-white/20'}`}>
            {badge?.icon}
            {badge?.label ?? status}
          </div>
          <p className="text-white/70 text-sm mb-0.5">Evia Membership</p>
          {/* No hardcoded amount here — members on the legacy $66.49 price and the
              current $54.99 price both land on this page; exact billing lives in
              the Stripe portal via Manage. */}
          <p className="text-2xl font-bold">Annual plan</p>
          {subscription?.cancelAtPeriodEnd ? (
            <p className="text-sm text-amber-200 mt-2">
              ⚠ Cancels on {renewalDate ?? '—'}
            </p>
          ) : renewalDate ? (
            <p className="text-sm text-white/60 mt-2 flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5" /> Renews {renewalDate}
            </p>
          ) : null}
        </div>
      </div>

      {/* What's included */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <p className="font-bold text-slate-900 mb-3">What's included</p>
        <ul className="space-y-2.5">
          {[
            'No platform fees — keep 100% of every booking',
            'Access all job postings and apply instantly',
            'Background check badge on your profile',
            'Direct messaging with families',
          ].map(item => (
            <li key={item} className="flex items-start gap-2.5 text-sm text-slate-700">
              <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      {/* Manage */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 flex items-center justify-between gap-4">
        <div>
          <p className="font-semibold text-slate-900 text-sm">Manage membership</p>
          <p className="text-xs text-slate-500 mt-0.5">Update payment method, cancel, or view invoices via Stripe.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onRefresh}
            disabled={loading}
            className="p-2 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors disabled:opacity-40"
            title="Refresh status"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onManage}
            disabled={managing}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 transition-colors disabled:opacity-60"
          >
            {managing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
            {managing ? 'Opening…' : 'Manage'}
          </button>
        </div>
      </div>
    </>
  );
};

export default CaregiverPaymentsPage;
