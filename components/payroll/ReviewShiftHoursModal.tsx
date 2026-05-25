import React, { useMemo, useState } from 'react';
import { X, CheckCircle2, AlertTriangle } from 'lucide-react';
import { shiftHoursService } from '../../services/api';

interface Props {
  shift: any; // ShiftHours row
  onClose: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

function toLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const ReviewShiftHoursModal: React.FC<Props> = ({ shift, onClose, onDone, onError }) => {
  const [mode, setMode] = useState<'menu' | 'correct'>('menu');
  const [start, setStart] = useState(toLocal(shift.submittedStartTime));
  const [end, setEnd] = useState(toLocal(shift.submittedEndTime));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

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
      });
      onDone();
    } catch (e: any) {
      onError(e?.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Review submitted hours</h2>
            <p className="text-sm text-slate-500 mt-1">{shift.caregiverName}</p>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
        </div>

        <div className="bg-slate-50 rounded-xl p-4 mb-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-600">Hours</span>
            <span className="text-lg font-bold text-slate-900">{shift.submittedTotalHours}h</span>
          </div>
          <p className="text-xs text-slate-500">
            {new Date(shift.submittedStartTime).toLocaleString()} → {new Date(shift.submittedEndTime).toLocaleString()}
          </p>
          <p className="text-xs text-slate-500">
            Rate: ${shift.payRate}/hr · Payment: {shift.paymentMethod === 'cash' ? 'Cash' : 'Credit card'}
          </p>

          {/* Line items breakdown */}
          {Array.isArray(shift.lineItems) && shift.lineItems.length > 0 && (
            <div className="pt-2 border-t border-slate-200 space-y-1">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Additional charges</p>
              {shift.lineItems.map((li: any, i: number) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-slate-600">
                    {li.type === 'custom' ? (li.label || 'Custom') : li.label}
                    {li.note ? <span className="text-slate-400"> · {li.note}</span> : null}
                  </span>
                  <span className="font-semibold text-slate-700">+${Number(li.amount).toFixed(2)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-200">
                <span className="font-semibold text-slate-700">Total</span>
                <span className="font-bold text-slate-900">${Number(shift.grossPay ?? shift.submittedTotalHours * shift.payRate).toFixed(2)}</span>
              </div>
            </div>
          )}

          <p className="text-xs text-slate-400">
            Auto-approves at {new Date(shift.autoApproveAt).toLocaleString()}
          </p>
        </div>

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

        {mode === 'correct' && (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Proposed start</label>
              <input type="datetime-local" value={start} onChange={e => setStart(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Proposed end</label>
              <input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
            </div>
            <div className="flex items-center justify-between bg-slate-50 rounded-lg px-4 py-2">
              <span className="text-sm text-slate-500">Proposed total</span>
              <span className="text-base font-bold text-slate-900">{proposedHours.toFixed(2)}h</span>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Reason (optional)</label>
              <textarea value={reason} onChange={e => setReason(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm resize-none"
                placeholder="Why the correction?"
              />
            </div>
            <p className="text-xs text-slate-500">
              Caregiver has 24h to accept or reject. If they don't respond, your proposal is auto-accepted.
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
      </div>
    </div>
  );
};
