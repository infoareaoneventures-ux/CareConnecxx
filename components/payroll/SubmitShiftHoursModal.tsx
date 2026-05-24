import React, { useMemo, useState } from 'react';
import { Clock, X } from 'lucide-react';
import { shiftHoursService } from '../../services/api';

export interface CompletedShift {
  id: string;
  clientId: string;
  clientName?: string;
  clientPhotoURL?: string | null;
  caregiverId: string;
  date: string;       // 'YYYY-MM-DD'
  startTime: string;  // scheduled 'HH:MM'
  endTime?: string;   // scheduled 'HH:MM'
  startedAt?: any;    // Firestore Timestamp or ISO — actual clock-in
  completedAt?: any;  // Firestore Timestamp or ISO — actual clock-out
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

function toDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIso(ts: any): string | null {
  if (!ts) return null;
  // Firestore Timestamp
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  // Already ISO string
  if (typeof ts === 'string') return ts;
  // Seconds-based object
  if (ts.seconds) return new Date(ts.seconds * 1000).toISOString();
  return null;
}

function defaultStartEnd(shift: CompletedShift): { startIso: string; endIso: string } {
  // Prefer actual clock-in / clock-out times; fall back to scheduled window
  const actualStart = toIso(shift.startedAt);
  const actualEnd = toIso(shift.completedAt);

  const scheduledStart = new Date(`${shift.date}T${shift.startTime}:00`).toISOString();
  const scheduledEnd = shift.endTime
    ? new Date(`${shift.date}T${shift.endTime}:00`).toISOString()
    : new Date(new Date(`${shift.date}T${shift.startTime}:00`).getTime() + 3_600_000).toISOString();

  return {
    startIso: actualStart ?? scheduledStart,
    endIso:   actualEnd   ?? scheduledEnd,
  };
}

export const SubmitShiftHoursModal: React.FC<Props> = ({ shift, onClose, onSubmitted, onError }) => {
  const { startIso, endIso } = useMemo(() => defaultStartEnd(shift), [shift]);
  const [start, setStart] = useState(toDateTimeLocal(startIso));
  const [end, setEnd] = useState(toDateTimeLocal(endIso));
  const [submitting, setSubmitting] = useState(false);

  const totalHours = useMemo(() => {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    if (!isFinite(s) || !isFinite(e) || e <= s) return 0;
    return Math.round(((e - s) / 3_600_000) * 100) / 100;
  }, [start, end]);

  const onConfirm = async () => {
    if (totalHours <= 0) {
      onError('End time must be after start time.');
      return;
    }
    setSubmitting(true);
    try {
      await shiftHoursService.submit(
        shift.id,
        new Date(start).toISOString(),
        new Date(end).toISOString(),
      );
      onSubmitted();
    } catch (e: any) {
      onError(e?.message || 'Failed to submit hours');
    } finally {
      setSubmitting(false);
    }
  };

  const isCash = shift.paymentMethod === 'cash';

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Clock className="w-5 h-5 text-primary-600" />
              Submit hours worked
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              {shift.clientName} · {shift.date}
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Start</label>
            <input
              type="datetime-local"
              value={start}
              onChange={e => setStart(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">End</label>
            <input
              type="datetime-local"
              value={end}
              onChange={e => setEnd(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            />
          </div>

          <div className="flex items-center justify-between bg-slate-50 rounded-lg px-4 py-3">
            <span className="text-sm text-slate-500">Total hours</span>
            <span className="text-xl font-bold text-slate-900">{totalHours.toFixed(2)}h</span>
          </div>

          <p className="text-xs text-slate-500">
            {isCash
              ? 'Payment method: Cash. Client will approve your hours for the record; cash is paid directly.'
              : 'Payment method: Credit. Client has 24 hours to approve or propose a correction. After that, hours auto-approve and Stripe processes payment.'}
          </p>
        </div>

        <div className="flex gap-2 mt-6">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-lg border border-slate-200 text-slate-700 font-medium hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting || totalHours <= 0}
            className="flex-1 py-2.5 rounded-lg bg-primary-600 text-white font-medium hover:bg-primary-700 disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
};
