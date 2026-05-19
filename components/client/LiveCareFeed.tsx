import React, { useEffect, useState } from 'react';
import { AlertTriangle, Clock } from 'lucide-react';
import { db } from '../../lib/firebase';

interface Checkin {
  id: string;
  caregiverName: string;
  status: string;
  notes?: string | null;
  timestamp: string;
}

interface LiveCareFeedProps {
  clientId: string;
  activeAppointmentEndTime?: string; // ISO datetime; if provided, used for overdue check
}

const STATUS_EMOJI: Record<string, string> = {
  all_good:         '✅',
  needs_attention:  '⚠️',
  medication_given: '💊',
  meal_prepared:    '🍽️',
};

const STATUS_LABEL: Record<string, string> = {
  all_good:         'All good',
  needs_attention:  'Needs attention',
  medication_given: 'Medication given',
  meal_prepared:    'Meal prepared',
};

export const LiveCareFeed: React.FC<LiveCareFeedProps> = ({ clientId, activeAppointmentEndTime }) => {
  const [checkins, setCheckins] = useState<Checkin[]>([]);
  const [now, setNow] = useState(Date.now());

  // Real-time listener scoped to today
  useEffect(() => {
    if (!db || !clientId) return;
    const todayIso = new Date().toISOString().slice(0, 10);

    const unsub = db
      .collection('shift_checkins')
      .where('clientId', '==', clientId)
      .where('timestamp', '>=', `${todayIso}T00:00:00.000Z`)
      .orderBy('timestamp', 'desc')
      .onSnapshot(snap => {
        setCheckins(snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<Checkin, 'id'>) })));
      });

    return () => { try { unsub(); } catch {} };
  }, [clientId]);

  // Tick every minute for overdue banner
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (checkins.length === 0) return null;

  const lastCheckin = checkins[0];
  const lastCheckinAge = now - new Date(lastCheckin.timestamp).getTime();
  const isOverdue =
    activeAppointmentEndTime &&
    now < new Date(activeAppointmentEndTime).getTime() &&
    lastCheckinAge > 2.5 * 60 * 60 * 1000;

  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
        <Clock className="w-4 h-4 text-primary-600" />
        Live Shift Updates
      </h2>

      {isOverdue && (
        <div className="mb-3 flex items-center gap-2 bg-yellow-50 border border-yellow-200 rounded-xl p-3 text-sm text-yellow-800">
          <AlertTriangle className="w-4 h-4 shrink-0 text-yellow-600" />
          <span>Check-in overdue — last update was over 2.5 hours ago.</span>
        </div>
      )}

      <div className="relative pl-5 border-l-2 border-slate-200 space-y-4">
        {checkins.map(c => {
          const emoji = STATUS_EMOJI[c.status] ?? '📋';
          const label = STATUS_LABEL[c.status] ?? c.status.replace(/_/g, ' ');
          const time = new Date(c.timestamp).toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
          });

          return (
            <div key={c.id} className="relative">
              <span className="absolute -left-[1.35rem] top-0.5 w-4 h-4 bg-white border-2 border-primary-400 rounded-full" />
              <div className="bg-white border border-slate-100 rounded-xl p-3 shadow-sm">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-sm font-semibold text-slate-800">
                    {emoji} {label}
                  </span>
                  <span className="text-xs text-slate-400">{time}</span>
                </div>
                <p className="text-xs text-slate-500">{c.caregiverName}</p>
                {c.notes && (
                  <p className="mt-1.5 text-xs text-slate-600 italic">"{c.notes}"</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
