import React, { useState } from 'react';
import { CheckCircle, AlertTriangle, Pill, UtensilsCrossed, Loader2 } from 'lucide-react';
import { db } from '../../lib/firebase';

type CheckinStatus = 'all_good' | 'needs_attention' | 'medication_given' | 'meal_prepared';

interface ShiftCheckinProps {
  clientId: string;
  caregiverId: string;
  appointmentId: string;
  caregiverName: string;
  onCheckinSent?: () => void;
}

const CHECKIN_OPTIONS: { status: CheckinStatus; label: string; Icon: React.FC<{ className?: string }> }[] = [
  { status: 'all_good',         label: 'All Good',         Icon: CheckCircle },
  { status: 'needs_attention',  label: 'Needs Attention',  Icon: AlertTriangle },
  { status: 'medication_given', label: 'Medication Given', Icon: Pill },
  { status: 'meal_prepared',    label: 'Meal Prepared',    Icon: UtensilsCrossed },
];

export const ShiftCheckin: React.FC<ShiftCheckinProps> = ({
  clientId,
  caregiverId,
  appointmentId,
  caregiverName,
  onCheckinSent,
}) => {
  const [selected, setSelected] = useState<CheckinStatus | null>(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async () => {
    if (!selected || !db) return;
    setSaving(true);
    try {
      await db.collection('shift_checkins').add({
        clientId,
        caregiverId,
        appointmentId,
        caregiverName,
        status: selected,
        notes: notes.trim() || null,
        timestamp: new Date().toISOString(),
      });
      setSent(true);
      setSelected(null);
      setNotes('');
      onCheckinSent?.();
    } catch (err) {
      console.error('Check-in failed:', err);
    } finally {
      setSaving(false);
    }
  };

  if (sent) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-2xl p-4 text-center">
        <CheckCircle className="w-8 h-8 text-green-600 mx-auto mb-2" />
        <p className="text-sm font-semibold text-green-800">Check-in sent to family</p>
        <button
          onClick={() => setSent(false)}
          className="mt-2 text-xs text-green-600 underline"
        >
          Send another
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4">
      <h3 className="text-sm font-semibold text-slate-800 mb-3">Quick Check-in</h3>

      <div className="grid grid-cols-2 gap-2 mb-3">
        {CHECKIN_OPTIONS.map(({ status, label, Icon }) => (
          <button
            key={status}
            onClick={() => setSelected(status)}
            className={`flex items-center gap-2 p-3 rounded-xl border text-sm font-medium transition-colors ${
              selected === status
                ? 'bg-primary-600 border-primary-600 text-white'
                : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-primary-50 hover:border-primary-300'
            }`}
          >
            <Icon className="w-4 h-4 shrink-0" />
            {label}
          </button>
        ))}
      </div>

      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="Add a note (optional)…"
        rows={2}
        className="w-full text-sm border border-slate-200 rounded-xl p-3 resize-none focus:outline-none focus:ring-2 focus:ring-primary-500 mb-3"
      />

      <button
        onClick={handleSubmit}
        disabled={!selected || saving}
        className="w-full py-2.5 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2"
      >
        {saving && <Loader2 className="w-4 h-4 animate-spin" />}
        {saving ? 'Sending…' : 'Send Check-in'}
      </button>
    </div>
  );
};
