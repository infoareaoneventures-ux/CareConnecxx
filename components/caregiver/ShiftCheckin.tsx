import React, { useState } from 'react';
import { CheckCircle, AlertTriangle, Pill, UtensilsCrossed, Loader2, MapPin } from 'lucide-react';
import { db, functions } from '../../lib/firebase';

type CheckinStatus = 'all_good' | 'needs_attention' | 'medication_given' | 'meal_prepared';

type ArrivalState =
  | 'idle'
  | 'locating'
  | 'arrived'
  | 'arrived_offsite'
  | 'denied'      // PERMISSION_DENIED
  | 'unavailable' // POSITION_UNAVAILABLE
  | 'timeout'     // TIMEOUT
  | 'error';

/** Wrap getCurrentPosition in a promise so we can branch on the error code. */
function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject({ code: 2 }); // treat missing API as POSITION_UNAVAILABLE
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000,
    });
  });
}

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
  const [arrival, setArrival] = useState<ArrivalState>('idle');
  const [arrivalMsg, setArrivalMsg] = useState('');

  // U4: location-prompted arrival check-in. Captures GPS once and calls the
  // (auth-hardened) submitGpsCheckin callable so distance validation + family
  // notification fire. Falls back to a manual, unvalidated check-in on any
  // geolocation failure, surfacing the specific reason.
  const submitArrival = async (coords?: { latitude: number; longitude: number }) => {
    if (!functions) { setArrival('error'); setArrivalMsg('Check-in is unavailable right now.'); return; }
    try {
      const call = functions.httpsCallable('v1-submitGpsCheckin');
      const res: any = await call(
        coords
          ? { caregiverId, appointmentId, latitude: coords.latitude, longitude: coords.longitude }
          : { caregiverId, appointmentId, manual: true },
      );
      const validated = !!res?.data?.validated;
      setArrival(coords ? (validated ? 'arrived' : 'arrived_offsite') : 'arrived');
      setArrivalMsg(res?.data?.message ?? 'Checked in.');
      onCheckinSent?.();
    } catch (err) {
      console.error('GPS check-in failed:', err);
      setArrival('error');
      setArrivalMsg('Could not record your check-in. Please try again.');
    }
  };

  const handleArrive = async () => {
    setArrival('locating');
    try {
      const pos = await getPosition();
      await submitArrival({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
    } catch (e: any) {
      // 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
      if (e?.code === 1) { setArrival('denied'); setArrivalMsg('Location is blocked. Enable it in your browser settings, or check in without GPS.'); }
      else if (e?.code === 3) { setArrival('timeout'); setArrivalMsg('Locating timed out. Retry, or check in without GPS.'); }
      else { setArrival('unavailable'); setArrivalMsg('Location signal unavailable. You can still check in without GPS.'); }
    }
  };

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
      {/* U4: location-prompted arrival */}
      <div className="mb-4 pb-4 border-b border-slate-100">
        {arrival === 'arrived' || arrival === 'arrived_offsite' ? (
          <div className="flex items-start gap-2 text-sm">
            <MapPin className={`w-4 h-4 mt-0.5 shrink-0 ${arrival === 'arrived' ? 'text-green-600' : 'text-amber-600'}`} />
            <p className={arrival === 'arrived' ? 'text-green-700' : 'text-amber-700'}>{arrivalMsg}</p>
          </div>
        ) : (
          <>
            <button
              onClick={handleArrive}
              disabled={arrival === 'locating'}
              className="w-full py-2.5 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2"
            >
              {arrival === 'locating' ? <Loader2 className="w-4 h-4 animate-spin" /> : <MapPin className="w-4 h-4" />}
              {arrival === 'locating' ? 'Locating…' : "I've arrived"}
            </button>
            {(arrival === 'denied' || arrival === 'unavailable' || arrival === 'timeout' || arrival === 'error') && (
              <div className="mt-2">
                <p className="text-xs text-slate-500 mb-2">{arrivalMsg}</p>
                <div className="flex gap-2">
                  {arrival === 'timeout' && (
                    <button onClick={handleArrive} className="flex-1 py-2 text-xs font-semibold rounded-lg border border-primary-300 text-primary-700 hover:bg-primary-50">
                      Retry
                    </button>
                  )}
                  <button onClick={() => submitArrival()} className="flex-1 py-2 text-xs font-semibold rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
                    Check in without GPS
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

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
