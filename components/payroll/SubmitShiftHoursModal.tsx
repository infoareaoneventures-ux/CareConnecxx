import React, { useMemo, useState } from 'react';
import { Clock, X, Plus, Trash2 } from 'lucide-react';
import { shiftHoursService } from '../../services/api';
import { isOfflinePaymentMethod, paymentMethodLabel } from '../../types';

// ── types ─────────────────────────────────────────────────────────────────────

export type LineItemType = 'custom';

export interface LineItem {
  type: LineItemType;
  label: string;   // human label; for 'custom' this is user-entered
  note: string;
  amount: number;
}

export interface CompletedShift {
  id: string;
  clientId: string;
  clientName?: string;
  clientPhotoURL?: string | null;
  caregiverId: string;
  date: string;       // 'YYYY-MM-DD'
  startTime: string;  // scheduled 'HH:MM'
  endTime?: string;   // scheduled 'HH:MM'
  startedAt?: any;          // Firestore Timestamp or ISO — actual clock-in
  completedAt?: any;        // Firestore Timestamp or ISO — actual clock-out
  loggedManually?: boolean; // true when caregiver self-reported via Log Hours modal
  paymentMethod?: string;
  rate?: number;
  careRecipients?: Array<{ name: string; relationship?: string; age?: string; photoURL?: string | null }>;
  address?: string;
  notes?: string;
}

interface Props {
  shift: CompletedShift;
  onClose: () => void;
  onSubmitted: () => void;
  onError: (msg: string) => void;
}

// ── constants ─────────────────────────────────────────────────────────────────

const LINE_ITEM_TYPES: { value: LineItemType; label: string }[] = [
  { value: 'custom', label: 'Custom' },
];

const DEFAULT_LABEL: Record<LineItemType, string> = {
  custom: '',
};

// ── helpers ───────────────────────────────────────────────────────────────────


function toIso(ts: any): string | null {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (typeof ts === 'string') return ts;
  if (ts.seconds) return new Date(ts.seconds * 1000).toISOString();
  return null;
}

// Shifts only appear here after status === 'completed', so startedAt/completedAt are always set.
function defaultStartEnd(shift: CompletedShift): { startIso: string; endIso: string } {
  return {
    startIso: toIso(shift.startedAt) ?? '',
    endIso:   toIso(shift.completedAt) ?? '',
  };
}

// Mirrors the server's grace-window check (functions/src/billing/createValidatedShiftHours.ts)
// closely enough for this preview text — a browser-local reading of the
// scheduled HH:MM strings, not byte-identical TZ handling, but this is only
// ever advisory copy; the server is the actual authority either way.
const SCHEDULE_GRACE_MS = 15 * 60 * 1000;
// Mirrors functions/src/billing/config.ts EXPLICIT_APPROVAL_THRESHOLD_CENTS (50_000):
// a gross total over this never auto-approves — the server flags it
// requiresExplicitApproval, so the note below must say so too (2026-09-17).
const EXPLICIT_APPROVAL_THRESHOLD_DOLLARS = 500;

function parseHHMM(time: string): { h: number; m: number } | null {
  const m = time.trim().toUpperCase().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  if (m[3] === 'PM' && hour < 12) hour += 12;
  if (m[3] === 'AM' && hour === 12) hour = 0;
  if (hour > 23 || Number(m[2]) > 59) return null;
  return { h: hour, m: Number(m[2]) };
}

function scheduledWindowMs(shift: CompletedShift): { start: number; end: number } | null {
  if (!shift.date || !shift.startTime || !shift.endTime) return null;
  const start = parseHHMM(shift.startTime);
  const end = parseHHMM(shift.endTime);
  if (!start || !end) return null;
  const startDate = new Date(`${shift.date}T00:00:00`);
  startDate.setHours(start.h, start.m, 0, 0);
  const endDate = new Date(`${shift.date}T00:00:00`);
  endDate.setHours(end.h, end.m, 0, 0);
  const startMs = startDate.getTime();
  let endMs = endDate.getTime();
  if (endMs <= startMs) endMs += 24 * 60 * 60 * 1000;
  return { start: startMs, end: endMs };
}

function fmtDuration(hours: number): string {
  const totalSecs = Math.round(hours * 3600);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── component ─────────────────────────────────────────────────────────────────

export const SubmitShiftHoursModal: React.FC<Props> = ({ shift, onClose, onSubmitted, onError }) => {
  const { startIso, endIso } = useMemo(() => defaultStartEnd(shift), [shift]);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const totalHours = useMemo(() => {
    const s = new Date(startIso).getTime();
    const e = new Date(endIso).getTime();
    if (!isFinite(s) || !isFinite(e) || e <= s) return 0;
    return (e - s) / 3_600_000;
  }, [startIso, endIso]);

  const basePay = shift.rate ? totalHours * shift.rate : null;
  const lineItemsTotal = lineItems.reduce((sum, li) => sum + (Number(li.amount) || 0), 0);
  const grandTotal    = basePay != null ? basePay + lineItemsTotal : null;
  // Additional charges skip the 24h auto-approve fallback (Hamse, 2026-08-23)
  // — an uncapped, caregiver-declared amount shouldn't be able to silently
  // charge the client just because they didn't check the app in time.
  const hasLineItems = lineItems.some(li => li.amount > 0);
  // Clocking in/out more than 15 minutes off the scheduled window gets the
  // same treatment (Hamse, 2026-08-24) — the server never blocks a real
  // submission for this, but it does require the client to explicitly
  // approve rather than letting it auto-approve after 24 hours.
  const scheduledWindow = useMemo(() => scheduledWindowMs(shift), [shift]);
  const isOutsideScheduledWindow = useMemo(() => {
    if (!scheduledWindow) return false;
    const s = new Date(startIso).getTime();
    const e = new Date(endIso).getTime();
    if (!isFinite(s) || !isFinite(e)) return false;
    return s < scheduledWindow.start - SCHEDULE_GRACE_MS || e > scheduledWindow.end + SCHEDULE_GRACE_MS;
  }, [scheduledWindow, startIso, endIso]);
  // Same threshold rule as the server (shiftBillingPolicy): gross total over $500
  // waits for the client even with no extra charges and on-time hours.
  const isOverThreshold = grandTotal != null && grandTotal > EXPLICIT_APPROVAL_THRESHOLD_DOLLARS;
  const needsExplicitApproval = hasLineItems || isOutsideScheduledWindow || isOverThreshold;
  const explicitApprovalReason = hasLineItems
    ? 'submissions with extra charges'
    : isOutsideScheduledWindow
      ? "hours that don't match the scheduled time"
      : `totals over $${EXPLICIT_APPROVAL_THRESHOLD_DOLLARS}`;

  // ── line item helpers ──

  const addLineItem = () =>
    setLineItems(prev => [...prev, { type: '' as LineItemType, label: '', note: '', amount: 0 }]);

  const updateLineItem = (i: number, patch: Partial<LineItem>) =>
    setLineItems(prev => prev.map((li, idx) => (idx === i ? { ...li, ...patch } : li)));

  const removeLineItem = (i: number) =>
    setLineItems(prev => prev.filter((_, idx) => idx !== i));

  const onTypeChange = (i: number, type: LineItemType) =>
    updateLineItem(i, { type, label: DEFAULT_LABEL[type] ?? '' });

  // ── submit ──

  const onConfirm = async () => {
    if (totalHours <= 0) { onError('End time must be after start time.'); return; }
    const missingType = lineItems.find(li => !li.type);
    if (missingType) { onError('Please select a type for each additional charge.'); return; }
    const missingAmount = lineItems.find(li => li.amount <= 0);
    if (missingAmount) { onError('Please enter an amount for each additional charge.'); return; }
    const invalid = lineItems.find(li => li.type === 'custom' && !li.label.trim());
    if (invalid) { onError('Please enter a label for each Custom charge.'); return; }
    setSubmitting(true);
    try {
      await shiftHoursService.submit(
        shift.id,
        startIso,
        endIso,
        lineItems.filter(li => li.amount > 0),
      );
      onSubmitted();
    } catch (e: any) {
      onError(e?.message || 'Failed to submit hours');
    } finally {
      setSubmitting(false);
    }
  };

  const isOffline = isOfflinePaymentMethod(shift.paymentMethod);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-6 pb-4 border-b border-slate-100">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Clock className="w-5 h-5 text-primary-600" />
              Submit hours worked
            </h2>
            <p className="text-sm text-slate-500 mt-0.5">{shift.clientName} · {shift.date}</p>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700 mt-0.5">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Times — read-only, sourced from actual clock-in/out */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Hours worked</p>
            </div>

            <div className="bg-slate-50 rounded-xl px-4 py-3 space-y-2">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-slate-400 mb-0.5">Clock in</p>
                  <p className="text-sm font-semibold text-slate-800">
                    {new Date(startIso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })}
                  </p>
                  <p className="text-xs text-slate-400">
                    {new Date(startIso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-400 mb-0.5">Clock out</p>
                  <p className="text-sm font-semibold text-slate-800">
                    {new Date(endIso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })}
                  </p>
                  <p className="text-xs text-slate-400">
                    {new Date(endIso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                </div>
              </div>
              <div className="border-t border-slate-200 pt-2 flex items-center justify-between">
                <span className="text-sm text-slate-500">Duration</span>
                <div className="text-right">
                  <span className="text-lg font-bold text-slate-900">{fmtDuration(totalHours)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Line items */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Additional charges</p>
              <button
                onClick={addLineItem}
                className="flex items-center gap-1 text-xs font-semibold text-primary-600 hover:text-primary-700 px-2 py-1 rounded-lg hover:bg-primary-50 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Add
              </button>
            </div>

            {lineItems.length === 0 && (
              <p className="text-xs text-slate-400 italic">
                No additional charges. Tap Add to include overtime, mileage, supplies, etc.
              </p>
            )}

            {lineItems.map((li, i) => (
              <div key={i} className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2">
                <div className="flex items-center gap-2">
                  {/* Type selector */}
                  <select
                    value={li.type}
                    onChange={e => onTypeChange(i, e.target.value as LineItemType)}
                    className={`flex-1 px-2 py-1.5 border rounded-lg text-sm bg-white ${!li.type ? 'border-red-400 text-slate-400' : 'border-slate-200'}`}
                  >
                    <option value="" disabled hidden>Select type</option>
                    {LINE_ITEM_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>

                  {/* Amount */}
                  <div className="relative w-28 shrink-0">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={li.amount || ''}
                      onChange={e => updateLineItem(i, { amount: parseFloat(e.target.value) || 0 })}
                      className="w-full pl-6 pr-3 py-1.5 border border-slate-200 rounded-lg text-sm"
                    />
                  </div>

                  {/* Remove */}
                  <button
                    onClick={() => removeLineItem(i)}
                    className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Custom label */}
                {li.type === 'custom' && (
                  <input
                    type="text"
                    placeholder="Label (e.g. Overtime or Mileage) *"
                    value={li.label}
                    onChange={e => updateLineItem(i, { label: e.target.value })}
                    className={`w-full px-3 py-1.5 border rounded-lg text-sm ${
                      !li.label.trim()
                        ? 'border-red-400 bg-red-50 placeholder-red-400'
                        : 'border-slate-200'
                    }`}
                  />
                )}

                {/* Note */}
                <input
                  type="text"
                  placeholder="Note (optional)"
                  value={li.note}
                  onChange={e => updateLineItem(i, { note: e.target.value })}
                  className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm"
                />
              </div>
            ))}
          </div>

          {/* Pay summary */}
          {(basePay != null || lineItems.length > 0) && (
            <div className="border border-slate-200 rounded-xl overflow-hidden text-sm">
              {basePay != null && (
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100">
                  <span className="text-slate-500">Base pay ({fmtDuration(totalHours)} @ ${shift.rate}/hr)</span>
                  <span className="font-semibold text-slate-700">${basePay.toFixed(2)}</span>
                </div>
              )}
              {lineItems.filter(li => li.amount > 0).map((li, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100">
                  <span className="text-slate-500">
                    {li.type === 'custom' ? (li.label || 'Custom') : li.label}
                    {li.note && <span className="text-slate-400"> · {li.note}</span>}
                  </span>
                  <span className="font-semibold text-slate-700">${Number(li.amount).toFixed(2)}</span>
                </div>
              ))}
              {grandTotal != null && lineItems.some(li => li.amount > 0) && (
                <div className="flex items-center justify-between px-4 py-3 bg-slate-50">
                  <span className="font-semibold text-slate-700">Total</span>
                  <span className="text-lg font-bold text-slate-900">${grandTotal.toFixed(2)}</span>
                </div>
              )}
            </div>
          )}

          {/* Payment note */}
          <p className="text-xs text-slate-500">
            {isOffline
              ? `Payment method: ${paymentMethodLabel(shift.paymentMethod)}. Client will approve your hours for the record; payment is made directly.`
              : needsExplicitApproval
                ? `Payment method: ${paymentMethodLabel(shift.paymentMethod)}. The client needs to review and approve this manually — there's no automatic approval for ${explicitApprovalReason}.`
                : `Payment method: ${paymentMethodLabel(shift.paymentMethod)}. Client has 24 hours to approve or propose a correction. After that, hours auto-approve and Stripe processes payment.`}
          </p>
        </div>

        {/* Footer */}
        <div className="flex gap-2 px-6 pb-6">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-700 font-medium hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting || totalHours <= 0 || lineItems.some(li => !li.type || li.amount <= 0 || (li.type === 'custom' && !li.label.trim()))}
            className="flex-1 py-2.5 rounded-xl bg-primary-600 text-white font-medium hover:bg-primary-700 disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
};
