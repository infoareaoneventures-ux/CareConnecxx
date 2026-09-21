import React, { useMemo, useState } from 'react';
import { X, CheckCircle2, AlertTriangle, ArrowUpRight, ChevronDown, ChevronUp } from 'lucide-react';
import { shiftHoursService } from '../../services/api';
import { paymentMethodLabel } from '../../types';
import { totalChargedDollars, SERVICE_FEE_PERCENT_LABEL } from '../../utils/pricing';

interface CorrectionHistoryEntry {
  by: string;
  action: string;
  at: string;
  startTime?: string;
  endTime?: string;
  hours?: number;
  note?: string;
  lineItems?: Array<{ type: string; label?: string; note?: string; amount: number }>;
  lineItemsTotal?: number;
  basePay?: number;
  grossPay?: number;
}

interface Props {
  shift: any; // ShiftHours row
  onClose: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

function toLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
}

function fmtTimeRange(startIso: string, endIso: string): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ', ' +
    new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  return `${fmt(startIso)} – ${fmt(endIso)}`;
}

function fmtDuration(hours: number): string {
  const totalSecs = Math.round(hours * 3600);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

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
  submittedLineItems?: Array<{ type: string; label?: string; note?: string; amount: number }>;
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
    <div className="space-y-1 mt-3">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Correction history</p>
      {history.map((entry, i) => {
        const isOpen = expanded.has(i);
        const isSubmitted = entry.action === 'submitted';
        const entryLineItems = (Array.isArray(entry.lineItems) && entry.lineItems.length > 0)
          ? entry.lineItems
          : (isSubmitted ? submittedLineItems : undefined);
        const entryBasePay = entry.basePay
          ?? (isSubmitted ? submittedBasePay : null)
          ?? (entry.hours != null && payRate ? Math.round(entry.hours * payRate * 100) / 100 : null);
        const entryGrossPay = entry.grossPay ?? (isSubmitted ? submittedGrossPay : null);
        const hasReceipt = !!(entry.startTime && entry.endTime);

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
                  <p className="text-slate-400 mt-0.5">{fmtTimestamp(entry.at)}</p>
                </div>
                {hasReceipt && (
                  isOpen
                    ? <ChevronUp className="w-3.5 h-3.5 text-slate-400 shrink-0 ml-2" />
                    : <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0 ml-2" />
                )}
              </div>

              {/* Expanded receipt */}
              {isOpen && hasReceipt && (
                <div className="mt-1.5 rounded-lg border border-slate-100 overflow-hidden">
                  <div className="divide-y divide-slate-100">
                    <div className="flex items-center justify-between px-3 py-1.5">
                      <span className="text-slate-400">Time</span>
                      <span className="text-slate-600">
                        {fmtTimeRange(entry.startTime!, entry.endTime!)}
                        {entry.hours != null ? ` · ${fmtDuration(entry.hours)}` : ''}
                      </span>
                    </div>
                    {entryBasePay != null && payRate != null && (
                      <div className="flex items-center justify-between px-3 py-1.5">
                        <span className="text-slate-400">${payRate}/hr · Base</span>
                        <span className="text-slate-600">${entryBasePay.toFixed(2)}</span>
                      </div>
                    )}
                    {entryLineItems && entryLineItems.map((li, j) => (
                      <div key={j} className="flex items-center justify-between px-3 py-1.5">
                        <span className="text-slate-400 truncate">{li.label || li.type}{li.note ? ` · ${li.note}` : ''}</span>
                        <span className="text-slate-600 shrink-0">+${Number(li.amount).toFixed(2)}</span>
                      </div>
                    ))}
                    {entryGrossPay != null && (
                      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-50">
                        <span className="font-semibold text-slate-600">Total</span>
                        <span className="font-bold text-slate-800">${entryGrossPay.toFixed(2)}</span>
                      </div>
                    )}
                    {entry.note && (
                      <div className="px-3 py-1.5 text-slate-400 italic">"{entry.note}"</div>
                    )}
                  </div>
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

export const ReviewShiftHoursModal: React.FC<Props> = ({ shift, onClose, onDone, onError }) => {
  // Determine initial mode based on shift status
  const initialMode = shift.status === 'caregiver_counter_proposed' ? 'counter' : 'menu';
  const [mode, setMode] = useState<'menu' | 'correct' | 'counter'>(initialMode);
  const [start, setStart] = useState(toLocal(shift.submittedStartTime));
  const [end, setEnd] = useState(toLocal(shift.submittedEndTime));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [correctedLineItems, setCorrectedLineItems] = useState<Array<{type: string; label: string; note: string; amount: number}>>(
    Array.isArray(shift.lineItems) ? shift.lineItems.map((li: any) => ({ ...li })) : []
  );

  const proposedHours = useMemo(() => {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    if (!isFinite(s) || !isFinite(e) || e <= s) return 0;
    return Math.round(((e - s) / 3600000) * 100) / 100;
  }, [start, end]);

  const doApprove = async () => {
    setBusy(true);
    try {
      await shiftHoursService.review(shift.appointmentId, 'approve');
      onDone();
    } catch (e: any) {
      onError(e?.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const doPropose = async () => {
    if (proposedHours <= 0) {
      onError('End must be after start.');
      return;
    }
    setBusy(true);
    try {
      await shiftHoursService.review(shift.appointmentId, 'propose_correction', {
        startTime: new Date(start).toISOString(),
        endTime: new Date(end).toISOString(),
        reason: reason.trim() || undefined,
        lineItems: correctedLineItems,
      });
      onDone();
    } catch (e: any) {
      onError(e?.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const doAcceptCounter = async () => {
    setBusy(true);
    try {
      await shiftHoursService.review(shift.appointmentId, 'accept_counter');
      onDone();
    } catch (e: any) {
      onError(e?.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const doEscalate = async () => {
    setBusy(true);
    try {
      await shiftHoursService.review(shift.appointmentId, 'escalate');
      onDone();
    } catch (e: any) {
      onError(e?.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const hasHistory = Array.isArray(shift.correctionHistory) && shift.correctionHistory.some((e: any) => e.action !== 'submitted');

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Review submitted hours</h2>
            <p className="text-sm text-slate-500 mt-1">{shift.caregiverName}</p>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
        </div>

        {/* Original submission summary */}
        <div className="bg-slate-50 rounded-xl p-4 mb-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-600">Submitted hours</span>
            <span className="text-lg font-bold text-slate-900">{fmtDuration(shift.submittedTotalHours)}</span>
          </div>
          <p className="text-xs text-slate-500">
            {fmtTimeRange(shift.submittedStartTime, shift.submittedEndTime)}
          </p>
          <p className="text-xs text-slate-500">
            Rate: ${shift.payRate}/hr · Payment: {paymentMethodLabel(shift.paymentMethod)}
          </p>

          {/* Pay breakdown — always shown */}
          <div className="pt-2 border-t border-slate-200 space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-600">Base pay</span>
              <span className="font-semibold text-slate-700">${Number(shift.basePay ?? shift.submittedTotalHours * shift.payRate).toFixed(2)}</span>
            </div>
            {Array.isArray(shift.lineItems) && shift.lineItems.length > 0 && (
              <>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide pt-1">Additional charges</p>
                {shift.lineItems.map((li: any, i: number) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-slate-600">
                      {li.type === 'custom' ? (li.label || 'Custom') : li.label}
                      {li.note ? <span className="text-slate-400"> · {li.note}</span> : null}
                    </span>
                    <span className="font-semibold text-slate-700">+${Number(li.amount).toFixed(2)}</span>
                  </div>
                ))}
              </>
            )}
            <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-200">
              <span className="font-semibold text-slate-700">Total</span>
              <span className="font-bold text-slate-900">${Number(shift.grossPay ?? shift.submittedTotalHours * shift.payRate).toFixed(2)}</span>
            </div>
          </div>

          {shift.status === 'pending_client_review' && shift.autoApproveAt && (
            <p className="text-xs text-slate-400">
              Auto-approves at {new Date(shift.autoApproveAt).toLocaleString()}
            </p>
          )}
        </div>

        {/* ── COUNTER mode: caregiver sent a counter-proposal ── */}
        {mode === 'counter' && (
          <div className="space-y-4">
            {/* Caregiver's counter — full receipt */}
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl overflow-hidden">
              <p className="text-xs font-semibold text-yellow-700 uppercase tracking-wide px-4 pt-3 pb-1">Caregiver's counter-proposal</p>
              <div className="divide-y divide-yellow-200">
                {shift.payRate != null && (
                  <div className="flex items-center justify-between px-4 py-2 text-xs">
                    <span className="text-yellow-700">Rate</span>
                    <span className="text-slate-800">${shift.payRate}/hr</span>
                  </div>
                )}
                {shift.counterStartTime && shift.counterEndTime && (
                  <div className="flex items-center justify-between px-4 py-2 text-xs">
                    <span className="text-yellow-700">Clock in / out</span>
                    <span className="text-slate-800">{fmtTimeRange(shift.counterStartTime, shift.counterEndTime)}</span>
                  </div>
                )}
                {shift.counterTotalHours != null && (
                  <div className="flex items-center justify-between px-4 py-2 text-xs">
                    <span className="text-yellow-700">Total hours</span>
                    <span className="font-semibold text-slate-800">{fmtDuration(shift.counterTotalHours)}</span>
                  </div>
                )}
                {(() => {
                  const counterBasePay = shift.counterTotalHours != null && shift.payRate
                    ? Math.round(shift.counterTotalHours * shift.payRate * 100) / 100
                    : null;
                  const counterLineItems: any[] = Array.isArray(shift.counterLineItems) ? shift.counterLineItems : [];
                  const counterGross = shift.counterGrossPay ?? (
                    counterBasePay != null
                      ? Math.round((counterBasePay + counterLineItems.reduce((s: number, li: any) => s + (Number(li.amount) || 0), 0)) * 100) / 100
                      : null
                  );
                  return (
                    <>
                      {counterBasePay != null && counterLineItems.length > 0 && (
                        <div className="flex items-center justify-between px-4 py-2 text-xs">
                          <span className="text-yellow-700">Base pay</span>
                          <span className="text-slate-800">${counterBasePay.toFixed(2)}</span>
                        </div>
                      )}
                      {counterLineItems.map((li: any, i: number) => (
                        <div key={i} className="flex items-center justify-between px-4 py-2 text-xs">
                          <span className="text-yellow-700 truncate">{li.label || li.type}{li.note ? ` · ${li.note}` : ''}</span>
                          <span className="text-slate-800 shrink-0">+${Number(li.amount).toFixed(2)}</span>
                        </div>
                      ))}
                      {counterGross != null && (
                        <div className="flex items-center justify-between px-4 py-2.5 bg-yellow-100 text-xs">
                          <span className="font-semibold text-yellow-800">Total</span>
                          <span className="font-bold text-slate-900">${counterGross.toFixed(2)}</span>
                        </div>
                      )}
                    </>
                  );
                })()}
                {shift.counterNote && (
                  <div className="px-4 py-2 text-xs text-yellow-700 italic">"{shift.counterNote}"</div>
                )}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={doAcceptCounter}
                disabled={busy}
                className="flex-1 py-2.5 rounded-lg bg-primary-600 text-white font-medium hover:bg-primary-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <CheckCircle2 className="w-4 h-4" />
                {busy ? 'Processing…' : 'Accept counter'}
              </button>
              <button
                onClick={doEscalate}
                disabled={busy}
                className="flex-1 py-2.5 rounded-lg border border-red-200 text-red-700 font-medium hover:bg-red-50 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <ArrowUpRight className="w-4 h-4" />
                {busy ? 'Processing…' : 'Escalate to admin'}
              </button>
            </div>
          </div>
        )}

        {/* ── MENU mode ── */}
        {mode === 'menu' && (
          <div className="space-y-2">
            <button
              onClick={doApprove}
              disabled={busy}
              className="w-full py-2.5 rounded-lg bg-primary-600 text-white font-medium hover:bg-primary-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <CheckCircle2 className="w-4 h-4" /> Approve as submitted
            </button>
            <button
              onClick={() => setMode('correct')}
              disabled={busy}
              className="w-full py-2.5 rounded-lg border border-slate-300 text-slate-700 font-medium hover:bg-slate-50 flex items-center justify-center gap-2"
            >
              <AlertTriangle className="w-4 h-4" /> Propose a correction
            </button>
          </div>
        )}

        {/* ── CORRECT mode ── */}
        {mode === 'correct' && (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Proposed start</label>
              <input type="datetime-local" step={1} value={start} onChange={e => setStart(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Proposed end</label>
              <input type="datetime-local" step={1} value={end} onChange={e => setEnd(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
            </div>
            <div className="flex items-center justify-between bg-slate-50 rounded-lg px-4 py-2">
              <span className="text-sm text-slate-500">Proposed total</span>
              <span className="text-base font-bold text-slate-900">{fmtDuration(proposedHours)}</span>
            </div>
            {shift.payRate && (
              <p className="text-xs text-slate-500 px-1">
                Charged to your card if accepted: ${totalChargedDollars(proposedHours * shift.payRate + correctedLineItems.reduce((s, li) => s + (Number(li.amount) || 0), 0)).toFixed(2)} (incl. {SERVICE_FEE_PERCENT_LABEL} service fee)
              </p>
            )}
            {(Array.isArray(shift.lineItems) && shift.lineItems.length > 0) && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Additional charges</p>
                <p className="text-xs text-slate-400">You can adjust amounts or remove charges you dispute.</p>
                {correctedLineItems.map((li, i) => (
                  <div key={i} className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2">
                    <span className="flex-1 text-sm text-slate-600">
                      {li.label || li.type}
                      {li.note ? <span className="text-slate-400"> · {li.note}</span> : null}
                    </span>
                    <div className="relative w-24 shrink-0">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={li.amount || ''}
                        onChange={e => setCorrectedLineItems(prev => prev.map((item, idx) =>
                          idx === i ? { ...item, amount: parseFloat(e.target.value) || 0 } : item
                        ))}
                        className="w-full pl-5 pr-2 py-1 border border-slate-200 rounded-lg text-sm"
                      />
                    </div>
                    <button
                      onClick={() => setCorrectedLineItems(prev => prev.filter((_, idx) => idx !== i))}
                      className="p-1 text-slate-400 hover:text-red-500 shrink-0"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                {shift.payRate && (
                  <div className="flex items-center justify-between bg-slate-100 rounded-lg px-4 py-2 text-sm">
                    <span className="text-slate-500">Proposed total (incl. charges)</span>
                    <span className="font-bold text-slate-900">
                      ${(proposedHours * shift.payRate + correctedLineItems.reduce((s, li) => s + (Number(li.amount) || 0), 0)).toFixed(2)}
                    </span>
                  </div>
                )}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Reason (optional)</label>
              <textarea value={reason} onChange={e => setReason(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm resize-none"
                placeholder="Why the correction?"
              />
            </div>
            <p className="text-xs text-slate-500">
              Caregiver has 24h to accept or send a counter. If they don't respond, your proposal is auto-accepted.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setMode('menu')} disabled={busy} className="flex-1 py-2.5 rounded-lg border border-slate-200 text-slate-700 font-medium">
                Back
              </button>
              <button onClick={doPropose} disabled={busy || proposedHours <= 0}
                className="flex-1 py-2.5 rounded-lg bg-accent-500 text-white font-medium hover:bg-accent-600 disabled:opacity-50">
                {busy ? 'Sending…' : 'Send correction'}
              </button>
            </div>
          </div>
        )}

        {/* Correction history (shown in all modes) */}
        {hasHistory && (
          <div className="mt-4 pt-4 border-t border-slate-100">
            <CorrectionTimeline
              history={shift.correctionHistory}
              payRate={shift.payRate}
              submittedLineItems={shift.lineItems}
              submittedBasePay={shift.basePay}
              submittedGrossPay={shift.grossPay}
            />
          </div>
        )}
      </div>
    </div>
  );
};
