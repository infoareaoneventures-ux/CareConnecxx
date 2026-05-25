import React, { useState, useEffect, useMemo } from 'react';
import {
  Zap, Landmark, CheckCircle2, AlertCircle, Lock,
  ExternalLink, Calendar, DollarSign, FileDown,
  ShieldCheck, RefreshCw, XCircle, ChevronDown, ChevronUp,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { CaregiverTopNav } from './CaregiverTopNav';
import { PayoutHistory } from './PayoutHistory';
import { ConnectBankButton } from '../ui/ConnectBankButton';
import { InstantPayoutModal, PayoutMethod } from './InstantPayoutModal';
import { CompletedShift } from '../payroll/SubmitShiftHoursModal';
import { useCareConnex } from '../../context/CareConnexContext';
import { shiftHoursService, dbService } from '../../services/api';
import { checkOnboardingStatus, requestInstantPayout, requestStandardPayout, getSubscriptionStatus, getCaregiverBillingPortalUrl } from '../../services/stripeService';
import { db } from '../../lib/firebase';
import type { Caregiver } from '../../types';

// ── types ───────────────────────────────────────────────────────────────────

type Tab = 'timesheets' | 'payouts' | 'membership';

interface SubscriptionInfo {
  status: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

interface ShiftRow {
  id: string;
  appointmentId: string;
  clientName?: string;
  caregiverId: string;
  payRate?: number;
  paymentMethod?: 'cash' | 'credit';
  submittedStartTime?: string;
  submittedEndTime?: string;
  submittedTotalHours?: number;
  finalStartTime?: string;
  finalEndTime?: string;
  finalTotalHours?: number;
  resolvedBy?: string;
  proposedTotalHours?: number;
  proposalReason?: string;
  grossPay?: number;
  submittedAt?: string;
  autoApproveAt?: string;
  status: string;
  stripeFailureReason?: string;
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
  d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

const fmtDate = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

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
  pending_client_review: 'Pending client review',
  correction_proposed: 'Client proposed correction',
  approved: 'Approved',
  auto_approved: 'Auto-approved',
  disputed_admin_review: 'Admin reviewing',
  paid: 'Paid',
  payment_failed: 'Payment failed',
};

const STATUS_STYLE: Record<string, string> = {
  pending_client_review: 'bg-amber-50 text-amber-700 border-amber-200',
  correction_proposed:   'bg-orange-50 text-orange-700 border-orange-200',
  approved:              'bg-blue-50 text-blue-700 border-blue-200',
  auto_approved:         'bg-blue-50 text-blue-700 border-blue-200',
  disputed_admin_review: 'bg-purple-50 text-purple-700 border-purple-200',
  paid:                  'bg-green-50 text-green-700 border-green-200',
  payment_failed:        'bg-red-50 text-red-700 border-red-200',
};

// ── sub-components ────────────────────────────────────────────────────────────

const PendingShiftRow: React.FC<{
  row: ShiftRow;
  onRespond: (action: 'accept' | 'reject') => void;
  onConfirmCash: () => void;
}> = ({ row, onRespond, onConfirmCash }) => {
  // All hooks must be declared before any early returns
  const [confirming,   setConfirming]   = React.useState(false);
  const [pendingOpen,  setPendingOpen]  = React.useState(false);

  // Cash shift approved by client — caregiver must confirm receipt
  if (row.paymentMethod === 'cash' && (row.status === 'approved' || row.status === 'auto_approved')) {
    const hours = row.finalTotalHours ?? row.submittedTotalHours ?? 0;
    const gross = row.grossPay ?? hours * (row.payRate ?? 0);
    return (
      <div className="bg-green-50 border border-green-200 rounded-2xl p-4">
        <div className="flex items-start justify-between mb-1">
          <div>
            <p className="font-semibold text-slate-900">{row.clientName}</p>
            <p className="text-sm text-slate-600 mt-0.5">
              {hours}h · <span className="font-bold text-slate-900">${gross.toFixed(2)} cash</span>
              {' · '}Client approved ✓
            </p>
          </div>
          <span className="shrink-0 text-xs font-medium px-2.5 py-1 rounded-full border bg-green-100 text-green-700 border-green-300">
            Awaiting your confirmation
          </span>
        </div>
        <button
          disabled={confirming}
          onClick={async () => {
            setConfirming(true);
            try { await onConfirmCash(); } finally { setConfirming(false); }
          }}
          className="mt-3 w-full py-2.5 rounded-xl bg-green-600 text-white text-sm font-semibold hover:bg-green-700 disabled:opacity-50 transition-colors"
        >
          {confirming ? 'Confirming…' : 'Confirm cash received'}
        </button>
      </div>
    );
  }

  if (row.status === 'correction_proposed') {
    return (
      <div className="bg-primary-50 border border-primary-200 rounded-2xl p-4">
        <div className="flex items-start justify-between mb-2">
          <div>
            <p className="font-semibold text-slate-900">{row.clientName}</p>
            <p className="text-sm text-slate-600 mt-0.5">
              You submitted <span className="font-bold">{row.submittedTotalHours}h</span>
              {' · '}Client proposed <span className="font-bold">{row.proposedTotalHours}h</span>
            </p>
            {row.proposalReason && (
              <p className="text-xs text-slate-500 mt-1">Reason: {row.proposalReason}</p>
            )}
          </div>
        </div>
        <div className="flex gap-2 mt-3">
          <button
            onClick={() => onRespond('accept')}
            className="px-4 py-1.5 rounded-xl bg-primary-600 text-white text-sm font-semibold hover:bg-primary-700 transition-colors"
          >
            Accept {row.proposedTotalHours}h
          </button>
          <button
            onClick={() => onRespond('reject')}
            className="px-4 py-1.5 rounded-xl border border-slate-300 text-slate-700 text-sm font-semibold hover:bg-slate-50 transition-colors"
          >
            Reject → send to admin
          </button>
        </div>
      </div>
    );
  }

  // pending_client_review — expandable data strip
  const dispStart = row.submittedStartTime ? new Date(row.submittedStartTime) : null;
  const dispEnd   = row.submittedEndTime   ? new Date(row.submittedEndTime)   : null;
  const hours     = row.finalTotalHours ?? row.submittedTotalHours ?? 0;
  const gross     = row.grossPay ?? (hours * (row.payRate ?? 0));
  const method    = row.paymentMethod
    ? row.paymentMethod.charAt(0).toUpperCase() + row.paymentMethod.slice(1)
    : '—';
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
        <Col label="In"       value={dispStart ? fmtTime(dispStart) : '—'}  className="shrink-0 w-[66px]" />
        <Divider />
        <Col label="Out"      value={dispEnd   ? fmtTime(dispEnd)   : '—'}  className="shrink-0 w-[66px]" />
        <Divider />
        <Col label="Duration" value={`${hours}h`}                           className="shrink-0 w-[58px]" />
        <Divider />
        <Col label="Pay"      value={`$${gross.toFixed(2)}`} highlight      className="shrink-0 w-[60px]" />
        <Divider />
        <Col label="Method"   value={method}                                className="shrink-0 w-[46px]" />

        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${STATUS_STYLE[row.status] || 'bg-slate-50 text-slate-600 border-slate-200'}`}>
            {STATUS_LABEL[row.status] || row.status}
          </span>
          {pendingOpen ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </div>
      </div>

      {pendingOpen && (
        <div className="border-t-2 border-slate-200 bg-slate-50 px-4 py-3 space-y-3">
          {/* Client identity */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center shrink-0">
              <span className="text-sm font-bold text-primary-700">
                {(row.clientName ?? '?')[0].toUpperCase()}
              </span>
            </div>
            <p className="text-sm font-semibold text-slate-900">{row.clientName ?? 'Client'}</p>
          </div>

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
                  {fmtTime(dispStart)} – {fmtTime(dispEnd)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-slate-400">Total hours</span>
              <span className="font-medium text-slate-700">{hours}h</span>
            </div>
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-slate-400">Gross pay</span>
              <span className="font-bold text-slate-900">${gross.toFixed(2)}</span>
            </div>
            {autoAt && (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-slate-400">Auto-approves</span>
                <span className="font-medium text-slate-700">{autoAt}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const HistoryShiftRow: React.FC<{ row: ShiftRow }> = ({ row }) => {
  const [open, setOpen] = useState(false);

  // Prefer final (post-correction) times over originally submitted times
  const dispStart = row.finalStartTime
    ? new Date(row.finalStartTime)
    : row.submittedStartTime ? new Date(row.submittedStartTime) : null;
  const dispEnd = row.finalEndTime
    ? new Date(row.finalEndTime)
    : row.submittedEndTime   ? new Date(row.submittedEndTime)   : null;

  const hours = row.finalTotalHours ?? row.submittedTotalHours ?? 0;
  const gross = row.grossPay ?? (hours * (row.payRate ?? 0));
  const method = row.paymentMethod
    ? row.paymentMethod.charAt(0).toUpperCase() + row.paymentMethod.slice(1)
    : '—';

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      {/* one-line data strip */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 transition-colors select-none"
        onClick={() => setOpen(o => !o)}
      >
        {/* Client name — makes it easy to identify the shift without expanding */}
        <div className="shrink-0 w-[90px] min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-slate-400 font-medium leading-none mb-0.5">Client</p>
          <p className="text-xs font-semibold text-slate-800 truncate">{row.clientName ?? '—'}</p>
        </div>
        <Divider />
        <Col label="Date"     value={dispStart ? fmtDate(dispStart) : '—'}  className="shrink-0 w-[58px]" />
        <Divider />
        <Col label="In"       value={dispStart ? fmtTime(dispStart) : '—'}  className="shrink-0 w-[66px]" />
        <Divider />
        <Col label="Out"      value={dispEnd   ? fmtTime(dispEnd)   : '—'}  className="shrink-0 w-[66px]" />
        <Divider />
        <Col label="Duration" value={`${hours}h`}                           className="shrink-0 w-[58px]" />
        <Divider />
        <Col label="Pay"      value={`$${gross.toFixed(2)}`} highlight      className="shrink-0 w-[60px]" />
        <Divider />
        <Col label="Method"   value={method}                                className="shrink-0 w-[46px]" />

        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
          {row.resolvedBy === 'caregiver' && (
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
          {/* Client identity */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center shrink-0">
              <span className="text-sm font-bold text-primary-700">
                {(row.clientName ?? '?')[0].toUpperCase()}
              </span>
            </div>
            <p className="text-sm font-semibold text-slate-900">{row.clientName ?? 'Client'}</p>
          </div>

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
                  {fmtTime(dispStart)} – {fmtTime(dispEnd)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-slate-400">Total hours</span>
              <span className="font-medium text-slate-700">{hours}h</span>
            </div>
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-slate-400">Gross pay</span>
              <span className="font-bold text-slate-900">${gross.toFixed(2)}</span>
            </div>
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
        </div>
      )}
    </div>
  );
};

// ── SubmittableShiftCard ──────────────────────────────────────────────────────

/** One-line labeled card: Client | Date | In | Out | Duration | Est. Pay | Status */
const SubmittableShiftCard: React.FC<{
  shift: CompletedShift;
  onSubmit: (startIso: string, endIso: string) => Promise<void>;
}> = ({ shift, onSubmit }) => {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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
    ? Math.round(((dispEnd.getTime() - dispStart.getTime()) / 3_600_000) * 100) / 100
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
        <Col label={hasActual ? 'In'  : 'Sched in'}  value={fmtTime(dispStart)}      className="shrink-0 w-[66px]" />
        <div className="w-px h-8 bg-slate-100 shrink-0" />
        <Col label={hasActual ? 'Out' : 'Sched out'} value={fmtTime(dispEnd)}        className="shrink-0 w-[66px]" />
        <div className="w-px h-8 bg-slate-100 shrink-0" />
        <Col label="Duration" value={durationH > 0 ? `${durationH}h` : '—'}          className="shrink-0 w-[58px]" />
        <div className="w-px h-8 bg-slate-100 shrink-0" />
        <Col label="Est. pay" value={estPay != null ? `$${estPay.toFixed(2)}` : '—'} highlight className="shrink-0 w-[60px]" />
        <div className="w-px h-8 bg-slate-100 shrink-0" />
        <Col
          label="Method"
          value={shift.paymentMethod ? shift.paymentMethod.charAt(0).toUpperCase() + shift.paymentMethod.slice(1) : '—'}
          className="shrink-0 w-[46px]"
        />

        {/* Status badge + chevron — pushed to the right */}
        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
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
          {/* Client identity */}
          <div className="flex items-center gap-3">
            {shift.clientPhotoURL ? (
              <img src={shift.clientPhotoURL} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
            ) : (
              <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center shrink-0">
                <span className="text-sm font-bold text-primary-700">
                  {(shift.clientName ?? '?')[0].toUpperCase()}
                </span>
              </div>
            )}
            <p className="text-sm font-semibold text-slate-900">{shift.clientName ?? 'Client'}</p>
          </div>

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
                {shift.date} · {shift.startTime}{shift.endTime ? `–${shift.endTime}` : ''}
              </span>
            </div>
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

          <button
            disabled={submitting}
            onClick={async e => {
              e.stopPropagation();
              setSubmitting(true);
              try {
                await onSubmit(dispStart.toISOString(), dispEnd.toISOString());
              } finally {
                setSubmitting(false);
              }
            }}
            className="w-full py-2.5 rounded-xl bg-primary-600 text-white text-sm font-semibold hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Submitting…' : 'Submit hours'}
          </button>
        </div>
      )}
    </div>
  );
};

// ── main page ─────────────────────────────────────────────────────────────────

export const CaregiverPaymentsPage: React.FC = () => {
  const { currentUser, addToast } = useCareConnex();
  const navigate = useNavigate();
  const uid = currentUser?.uid ?? '';

  const [tab, setTab] = useState<Tab>('timesheets');
  const [tsFilter, setTsFilter] = useState<'all' | 'unsubmitted' | 'pending' | 'history'>('all');
  const [showReport, setShowReport] = useState(false);
  const [reportFrom, setReportFrom] = useState('');
  const [reportTo,   setReportTo]   = useState('');
  const [shiftRows, setShiftRows] = useState<ShiftRow[]>([]);
  const [completedShifts, setCompletedShifts] = useState<CompletedShift[]>([]);

  // Payouts tab state
  const [profile, setProfile] = useState<Caregiver | null>(null);
  const [showPayoutModal, setShowPayoutModal] = useState(false);
  const [saving, setSaving] = useState(false);

  // Membership tab state
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [managing, setManaging] = useState(false);

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
    (async () => {
      const p = await dbService.getUser(uid);
      if (active && p) setProfile(p as any);
    })();
    return () => { active = false; };
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
        const p = await dbService.getUser(uid);
        if (p) setProfile(p as any);
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
    ['pending_client_review', 'correction_proposed'].includes(r.status) ||
    // cash approved shifts that need caregiver cash confirmation
    (r.paymentMethod === 'cash' && (r.status === 'approved' || r.status === 'auto_approved'))
  );
  const historyRows = shiftRows.filter(r =>
    !['pending_client_review', 'correction_proposed'].includes(r.status) &&
    // exclude cash-approved shifts waiting for confirmation — they still belong in Pending
    !(r.paymentMethod === 'cash' && (r.status === 'approved' || r.status === 'auto_approved'))
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
      if (!r.submittedAt) return false;
      const d = r.submittedAt.slice(0, 10);
      if (reportFrom && d < reportFrom) return false;
      if (reportTo   && d > reportTo)   return false;
      return true;
    });
  }, [historyRows, showReport, reportFrom, reportTo]);

  const reportSummary = useMemo(() => {
    const rows = reportedRows;
    const totalHours = rows.reduce((s, r) => s + (r.finalTotalHours ?? r.submittedTotalHours ?? 0), 0);
    const totalPay   = rows.reduce((s, r) => {
      const h = r.finalTotalHours ?? r.submittedTotalHours ?? 0;
      return s + (r.grossPay ?? h * (r.payRate ?? 0));
    }, 0);
    return { shifts: rows.length, hours: Math.round(totalHours * 100) / 100, pay: totalPay };
  }, [reportedRows]);

  // ── handlers ──────────────────────────────────────────────────────────────

  const handleExportCSV = () => {
    const header = ['Client', 'Date', 'Hours', 'Pay ($)', 'Method', 'Status'];
    const lines = reportedRows.map(r => {
      const date  = r.submittedAt ? new Date(r.submittedAt).toLocaleDateString('en-US') : '';
      const hours = r.finalTotalHours ?? r.submittedTotalHours ?? 0;
      const pay   = r.grossPay ?? hours * (r.payRate ?? 0);
      return [
        `"${(r.clientName ?? '').replace(/"/g, '""')}"`,
        date,
        hours.toFixed(2),
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

  const handleRespondToCorrection = async (row: ShiftRow, action: 'accept' | 'reject') => {
    try {
      await shiftHoursService.respondToCorrection(row.appointmentId, action);
      addToast(action === 'accept' ? 'Correction accepted' : 'Sent to admin for review', 'success');
    } catch (e: any) {
      addToast(e?.message || 'Failed to respond', 'error');
    }
  };

  const handleConfirmCash = async (row: ShiftRow) => {
    try {
      await shiftHoursService.confirmCashReceived(row.appointmentId);
      addToast('Cash payment confirmed — shift marked paid', 'success');
    } catch (e: any) {
      addToast(e?.message || 'Failed to confirm cash receipt', 'error');
    }
  };

  const handlePayout = async (method: PayoutMethod) => {
    try {
      const result = method === 'instant'
        ? await requestInstantPayout()
        : await requestStandardPayout();
      if (result.success) {
        addToast(
          method === 'instant'
            ? `Instant payout of $${result.amount.toFixed(2)} initiated!`
            : `Standard payout of $${result.amount.toFixed(2)} initiated!`,
          'success',
        );
      }
    } catch (error: any) {
      addToast(error.message || 'Payout failed. Please try again.', 'error');
      throw error;
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

  const toggleAcceptsCreditCards = async (next: boolean) => {
    if (!uid || !profile) return;
    setSaving(true);
    try {
      await dbService.updateUser('caregivers', uid, { acceptsCreditCards: next } as any);
      setProfile({ ...profile, acceptsCreditCards: next });
      addToast(next ? 'Credit card bookings enabled' : 'Credit card bookings disabled', 'success');
    } catch {
      addToast('Failed to update', 'error');
    } finally {
      setSaving(false);
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
                { id: 'all',         label: 'All',         count: submittableShifts.length + shiftRows.length, alert: false },
                { id: 'unsubmitted', label: 'Unsubmitted', count: submittableShifts.length,                    alert: true  },
                { id: 'pending',     label: 'Pending',     count: pendingRows.length,                          alert: true  },
                { id: 'history',     label: 'History',     count: historyRows.length,                          alert: false },
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
                      { label: 'Total hours',      value: `${reportSummary.hours}h` },
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

            {/* Unified filtered list */}
            <div className="space-y-2">
              {/* Unsubmitted */}
              {(tsFilter === 'all' || tsFilter === 'unsubmitted') &&
                submittableShifts.map(shift => (
                  <SubmittableShiftCard
                    key={shift.id}
                    shift={shift}
                    onSubmit={async (startIso, endIso) => {
                      try {
                        await shiftHoursService.submit(shift.id, startIso, endIso);
                        addToast('Hours submitted — awaiting client approval', 'success');
                      } catch (e: any) {
                        addToast(e?.message || 'Failed to submit hours', 'error');
                        throw e;
                      }
                    }}
                  />
                ))
              }

              {/* Pending */}
              {(tsFilter === 'all' || tsFilter === 'pending') &&
                pendingRows.map(row => (
                  <PendingShiftRow
                    key={row.id}
                    row={row}
                    onRespond={action => handleRespondToCorrection(row, action)}
                    onConfirmCash={() => handleConfirmCash(row)}
                  />
                ))
              }

              {/* History — uses reportedRows when report panel is open */}
              {(tsFilter === 'all' || tsFilter === 'history') && reportedRows.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100">
                  {reportedRows.map(row => <HistoryShiftRow key={row.id} row={row} />)}
                </div>
              )}

              {/* Empty state */}
              {((tsFilter === 'all'         && submittableShifts.length === 0 && shiftRows.length === 0) ||
                (tsFilter === 'unsubmitted' && submittableShifts.length === 0) ||
                (tsFilter === 'pending'     && pendingRows.length === 0) ||
                (tsFilter === 'history'     && reportedRows.length === 0)) && (
                <div className="bg-white rounded-2xl border border-slate-200 p-6 text-sm text-slate-400 text-center">
                  {tsFilter === 'all'         ? 'No shifts yet.'                               :
                   tsFilter === 'unsubmitted' ? 'No shifts waiting on you to submit hours.'    :
                   tsFilter === 'pending'     ? 'Nothing pending.'                             :
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
                    onClick={() => setShowPayoutModal(true)}
                    className="flex items-center gap-2 bg-white text-slate-900 px-5 py-2.5 rounded-xl font-semibold text-sm hover:bg-slate-100 transition-colors shadow-sm"
                  >
                    <Zap className="w-4 h-4 text-blue-600" />
                    Cash Out
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
                  💡 Instant: 30 min, 1.5% fee · Standard: 2-3 days, free
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
                    Standard payouts arrive in 2–3 business days (free).
                    Instant payouts arrive in 30 minutes (1.5% fee, min $0.50).
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

            {/* Credit card bookings toggle */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 flex items-start gap-4">
              <button
                onClick={() => toggleAcceptsCreditCards(!profile?.acceptsCreditCards)}
                disabled={saving}
                className={`relative w-11 h-6 rounded-full transition-colors shrink-0 mt-0.5 ${profile?.acceptsCreditCards ? 'bg-primary-500' : 'bg-slate-300'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${profile?.acceptsCreditCards ? 'translate-x-5' : ''}`} />
              </button>
              <div>
                <p className="font-semibold text-slate-900">Accept credit card bookings</p>
                <p className="text-sm text-slate-500 mt-0.5">
                  When off, families can only pay in cash. Accepting cards significantly increases the
                  jobs you see and your profile visibility.
                </p>
              </div>
            </div>

            {/* Payout schedule info */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <p className="font-bold text-slate-900 mb-3 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-primary-600" /> Payout schedule
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-slate-50 rounded-xl text-center">
                  <p className="font-semibold text-slate-900 text-sm">Standard</p>
                  <p className="text-xs text-slate-500 mt-0.5">2–3 business days</p>
                  <p className="text-xs font-bold text-green-600 mt-1">Free</p>
                </div>
                <div className="p-3 bg-primary-50 border border-primary-100 rounded-xl text-center">
                  <p className="font-semibold text-slate-900 text-sm">Instant</p>
                  <p className="text-xs text-slate-500 mt-0.5">~30 minutes</p>
                  <p className="text-xs font-bold text-primary-600 mt-1">1.5% fee</p>
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
              onGetMembership={() => navigate('/caregiver/membership')}
              onManage={handleManageMembership}
              managing={managing}
            />
          </div>
        )}
      </div>

      {/* Modals */}
      {showPayoutModal && (
        <InstantPayoutModal
          availableBalance={availableBalance}
          onClose={() => setShowPayoutModal(false)}
          onConfirm={handlePayout}
          onShowToast={addToast}
        />
      )}
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
          Get membership · $24.95/year
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
          <p className="text-white/70 text-sm mb-0.5">CareConnex Membership</p>
          <p className="text-2xl font-bold">Annual plan · $24.95/yr</p>
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
