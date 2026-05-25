import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Clock, CreditCard, CheckCircle, AlertTriangle, Loader2,
  ChevronDown, ChevronUp, Banknote, CalendarDays, ExternalLink,
  AlertCircle,
} from 'lucide-react';
import { ClientNavigation } from './ClientNavigation';
import { useCareConnex } from '../../context/CareConnexContext';
import { auth, db } from '../../lib/firebase';
import { shiftHoursService } from '../../services/api';
import { getClientBillingPortalUrl } from '../../services/stripeService';
import { ReviewShiftHoursModal } from '../payroll/ReviewShiftHoursModal';

type Tab = 'timesheets' | 'payment-method';

type ShiftHoursStatus =
  | 'pending_client_review'
  | 'correction_proposed'
  | 'caregiver_counter_proposed'
  | 'approved'
  | 'auto_approved'
  | 'disputed_admin_review'
  | 'paid'
  | 'payment_failed';

type DateFilter = 'all' | 'this-month' | 'last-3-months';

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
  paymentMethod: 'cash' | 'credit';
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
  counterNote?: string;
  correctionHistory?: CorrectionHistoryEntry[];
  lineItems?: LineItem[];
  lineItemsTotal?: number;
  basePay?: number;
  grossPay?: number;
  submittedAt: string;
  autoApproveAt: string;
  status: ShiftHoursStatus;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}
function fmtAmount(hours: number, rate: number) {
  return `$${(hours * rate).toFixed(2)}`;
}
/** 0.1 → "6 min" · 1.5 → "1h 30m" · 2.0 → "2h" */
function fmtDuration(hours: number): string {
  const totalMins = Math.round(hours * 60);
  if (totalMins < 60) return `${totalMins} min`;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

const STATUS_CONFIG: Record<ShiftHoursStatus, { label: string; color: string; bg: string; border: string }> = {
  pending_client_review:     { label: 'Needs Review',      color: 'text-amber-700',   bg: 'bg-amber-50',   border: 'border-amber-200' },
  correction_proposed:       { label: 'Correction Sent',   color: 'text-orange-700',  bg: 'bg-orange-50',  border: 'border-orange-200' },
  caregiver_counter_proposed:{ label: 'Counter Received',  color: 'text-yellow-700',  bg: 'bg-yellow-50',  border: 'border-yellow-200' },
  approved:                  { label: 'Approved',           color: 'text-blue-700',    bg: 'bg-blue-50',    border: 'border-blue-200' },
  auto_approved:             { label: 'Auto-Approved',      color: 'text-blue-700',    bg: 'bg-blue-50',    border: 'border-blue-200' },
  disputed_admin_review:     { label: 'Under Review',       color: 'text-purple-700',  bg: 'bg-purple-50',  border: 'border-purple-200' },
  paid:                      { label: 'Paid',               color: 'text-green-700',   bg: 'bg-green-50',   border: 'border-green-200' },
  payment_failed:            { label: 'Payment Failed',     color: 'text-red-700',     bg: 'bg-red-50',     border: 'border-red-200' },
};

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
}> = ({ row, onReview }) => {
  const [expanded, setExpanded] = useState(false);
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
      {/* Main row */}
      <div
        className="px-5 py-4 flex items-center gap-4 cursor-pointer hover:bg-slate-50 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <CaregiverAvatar name={row.caregiverName} photoURL={row.caregiverPhotoURL} />

        <div className="flex-1 min-w-0">
          <p className="font-semibold text-slate-900 text-sm">{row.caregiverName}</p>
          <p className="text-xs text-slate-500 mt-0.5">{fmtDate(row.submittedStartTime)}</p>
        </div>

        <div className="hidden sm:flex flex-col items-end text-right shrink-0">
          <p className="text-sm font-semibold text-slate-800">{fmtDuration(dispHours)}</p>
          <div className="flex items-center gap-1 text-xs text-slate-500 mt-0.5">
            {row.paymentMethod === 'credit'
              ? <CreditCard className="w-3 h-3" />
              : <Banknote className="w-3 h-3" />}
            <span>{row.paymentMethod === 'credit' ? 'Card' : 'Cash'}</span>
          </div>
        </div>

        <div className="flex flex-col items-end shrink-0 gap-1.5">
          <p className="text-sm font-bold text-slate-900">${totalPay.toFixed(2)}</p>
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {isCorrected && (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-teal-50 text-teal-700 border-teal-200 whitespace-nowrap">
                Corrected
              </span>
            )}
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${cfg.color} ${cfg.bg} ${cfg.border}`}>
              {cfg.label}
            </span>
          </div>
        </div>

        <div className="shrink-0 text-slate-400">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-slate-100 px-5 py-4 bg-slate-50 space-y-4">
          {/* Times */}
          <div className="space-y-1">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Hours</p>
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden text-xs">
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-500">{isCorrected ? 'Original' : 'Submitted'}</span>
                <span className="font-semibold text-slate-700">
                  {fmtTime(row.submittedStartTime)} – {fmtTime(row.submittedEndTime)}
                  <span className="text-primary-600 font-bold ml-2">{fmtDuration((new Date(row.submittedEndTime).getTime() - new Date(row.submittedStartTime).getTime()) / 3_600_000)}</span>
                </span>
              </div>
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-500">Rate</span>
                <span className="font-semibold text-slate-700">${row.payRate}/hr · Base {fmtAmount(dispHours, row.payRate)}</span>
              </div>
              {row.status === 'pending_client_review' && (
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-slate-500">Auto-approves</span>
                  <span className="text-slate-500">{fmtDate(row.autoApproveAt)}</span>
                </div>
              )}
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
              {/* Care recipients */}
              {Array.isArray(shiftDetails.careRecipients) && shiftDetails.careRecipients.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Care Recipient</p>
                  {shiftDetails.careRecipients.map((r: any, ri: number) => (
                    <div key={ri} className="flex items-center gap-2 mb-1">
                      <div className="w-6 h-6 rounded-full bg-primary-100 flex items-center justify-center shrink-0 overflow-hidden">
                        {r.photoURL
                          ? <img src={r.photoURL} alt={r.name} className="w-full h-full object-cover" />
                          : <span className="text-[9px] font-bold text-primary-700">{(r.name || '?').charAt(0).toUpperCase()}</span>}
                      </div>
                      <span className="text-xs font-semibold text-slate-700">{r.name}</span>
                      {r.relationship && <span className="text-xs text-slate-400">· {r.relationship}</span>}
                      {r.age && <span className="text-xs text-slate-400">· Age {r.age}</span>}
                    </div>
                  ))}
                </div>
              )}

              {/* Tasks */}
              {Array.isArray(shiftDetails.tasksCompleted) && shiftDetails.tasksCompleted.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Tasks Completed</p>
                  <div className="space-y-0.5">
                    {shiftDetails.tasksCompleted.map((t: string, i: number) => (
                      <div key={i} className="flex items-center gap-2 text-xs text-green-700">
                        <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0" />
                        <span>{t.replace(/^\d+_[^_]+_/, '').replace(/^\d+_/, '')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

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
          {row.status === 'payment_failed' && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <p className="text-xs text-red-700 font-medium">
                Payment failed. Please check your card on file in the Payment Method tab.
              </p>
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
  const [rows, setRows] = useState<ShiftHoursRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [reviewRow, setReviewRow] = useState<ShiftHoursRow | null>(null);

  // Payment method state
  const [stripeCustomerId, setStripeCustomerId] = useState<string | null>(null);
  const [loadingCard, setLoadingCard] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);

  const user = auth.currentUser;

  // Subscribe to shiftHours for this client
  useEffect(() => {
    if (!user) { setLoading(false); return; }
    const unsub = shiftHoursService.subscribeForClient(user.uid, (data) => {
      setRows(data as ShiftHoursRow[]);
      setLoading(false);
    });
    return () => unsub();
  }, [user?.uid]);

  // Fetch Stripe customer status — stored in customers/{uid} by checkout
  useEffect(() => {
    if (!user || !db) { setLoadingCard(false); return; }
    db.collection('customers').doc(user.uid).get()
      .then(snap => {
        setStripeCustomerId(snap.data()?.stripeCustomerId || null);
      })
      .catch(() => {})
      .finally(() => setLoadingCard(false));
  }, [user?.uid]);

  // Filter rows by date
  const filteredRows = useMemo(() => {
    if (dateFilter === 'all') return rows;
    const now = new Date();
    const cutoff = new Date();
    if (dateFilter === 'this-month') {
      cutoff.setDate(1);
      cutoff.setHours(0, 0, 0, 0);
    } else {
      cutoff.setMonth(now.getMonth() - 3);
    }
    return rows.filter(r => new Date(r.submittedAt) >= cutoff);
  }, [rows, dateFilter]);

  const pendingCount = rows.filter(r =>
    r.status === 'pending_client_review' || r.status === 'caregiver_counter_proposed'
  ).length;

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
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Payments</h1>
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
            {/* Pending alert */}
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

            {/* Date filter */}
            <div className="flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-slate-400 shrink-0" />
              <div className="flex gap-1.5">
                {([
                  { id: 'all', label: 'All time' },
                  { id: 'this-month', label: 'This month' },
                  { id: 'last-3-months', label: 'Last 3 months' },
                ] as { id: DateFilter; label: string }[]).map(f => (
                  <button
                    key={f.id}
                    onClick={() => setDateFilter(f.id)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                      dateFilter === f.id
                        ? 'bg-primary-600 text-white'
                        : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

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
                <p className="font-semibold text-slate-700 mb-1">No timesheets yet</p>
                <p className="text-sm text-slate-400">
                  When a caregiver completes a shift and submits their hours, they'll appear here for your review.
                </p>
              </div>
            ) : (
              <>
                {/* Pending first */}
                {filteredRows
                  .slice()
                  .sort((a, b) => {
                    // items needing client action first, then by date desc
                    const needsAction = (s: ShiftHoursStatus) =>
                      s === 'pending_client_review' || s === 'caregiver_counter_proposed' ? 0 : 1;
                    const aP = needsAction(a.status);
                    const bP = needsAction(b.status);
                    if (aP !== bP) return aP - bP;
                    return new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime();
                  })
                  .map(row => (
                    <ShiftRow
                      key={row.id}
                      row={row}
                      onReview={setReviewRow}
                    />
                  ))}
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
                  {stripeCustomerId ? (
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
                    {stripeCustomerId ? 'Manage payment method' : 'Add a card'}
                  </button>
                </div>

                <div className="border-t border-slate-100 px-6 py-4 bg-slate-50">
                  <p className="text-xs text-slate-400">
                    <span className="font-medium text-slate-500">How payments work:</span> When you approve a caregiver's hours, your card is automatically charged. For cash payments, the caregiver marks it paid after receiving cash directly from you.
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
