import React, { useState, useEffect, useCallback } from 'react';
import {
  ChevronLeft, ChevronRight, Plus, X, CheckCircle, Loader2, Calendar,
} from 'lucide-react';
import { dbService, authService } from '../../services/api';
import { CaregiverSchedule } from './CaregiverSchedule';
import { CaregiverTopNav } from './CaregiverTopNav';
import { DragSelectWeekGrid } from './DragSelectWeekGrid';
import { Appointment, WeeklySchedule } from '../../types';

interface CaregiverCalendarPageProps {
  onNavigate: (view: any) => void;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_LABELS_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PERIODS = ['Morning', 'Afternoon', 'Evening'];

export const CaregiverCalendarPage: React.FC<CaregiverCalendarPageProps> = ({ onNavigate }) => {
  const [loading, setLoading] = useState(true);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [availability, setAvailability] = useState<Record<string, string[]>>({});
  const [monthDate, setMonthDate] = useState(new Date());
  const [showAvailModal, setShowAvailModal] = useState(false);
  const [editAvail, setEditAvail] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [showBanner, setShowBanner] = useState(true);

  const currentUser = authService.getCurrentUser();
  const today = new Date();

  useEffect(() => {
    const fetchData = async () => {
      try {
        if (currentUser?.uid) {
          const [apptData, profileData] = await Promise.all([
            dbService.getAppointments().catch(() => ({ appointments: [] })),
            dbService.getCaregivers().catch(() => ({ caregivers: [] })),
          ]);

          const myAppts = (apptData.appointments || []).filter(
            (a: Appointment) => a.caregiverId === currentUser.uid
          );
          setAppointments(myAppts);

          const me = profileData.caregivers?.find(
            (c: any) => c.uid === currentUser.uid
          );
          if (me?.weeklyAvailability) {
            setAvailability(me.weeklyAvailability as Record<string, string[]>);
          }
        }
      } catch {
        // silently fail — show empty state
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [currentUser]);

  // Mini-calendar helpers
  const daysInMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
  const firstDayOfWeek = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1).getDay();
  const monthBlanks = Array.from({ length: firstDayOfWeek });
  const monthDays = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  const dayHasAvailability = (d: number) => {
    const date = new Date(monthDate.getFullYear(), monthDate.getMonth(), d);
    const dayIdx = date.getDay();
    const shortKey = DAYS[dayIdx];                     // legacy: "Sun"
    const longKey = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][dayIdx]; // new: "sunday"
    const slots = (availability as any)[shortKey] || (availability as any)[longKey] || [];
    return slots.length > 0;
  };

  const togglePeriod = (day: string, period: string) => {
    setEditAvail(prev => {
      const current = prev[day] || [];
      const updated = current.includes(period)
        ? current.filter(p => p !== period)
        : [...current, period];
      return { ...prev, [day]: updated };
    });
  };

  const openAvailModal = () => {
    setEditAvail(availability);
    setShowAvailModal(true);
  };

  const saveAvailability = useCallback(async () => {
    if (!currentUser?.uid) return;
    setSaving(true);
    try {
      await dbService.updateUser('caregivers', currentUser.uid, {
        weeklyAvailability: editAvail as any,
      });
      setAvailability(editAvail);
      setShowAvailModal(false);
    } catch {
      // ignore — optimistic UI
      setAvailability(editAvail);
      setShowAvailModal(false);
    } finally {
      setSaving(false);
    }
  }, [currentUser, editAvail]);

  if (loading) return (
    <div className="flex justify-center items-center h-[60vh]">
      <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 pb-24 animate-slide-in">
      <CaregiverTopNav />

      <div className="max-w-6xl mx-auto px-4 py-6">

        {/* Page header (mobile-only back button; desktop gets TopNav) */}
        <div className="flex items-center gap-3 mb-5 md:hidden">
          <button
            onClick={() => onNavigate('caregiver')}
            className="p-2 -ml-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition-colors"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <h1 className="text-2xl font-bold text-slate-900">My Calendar</h1>
        </div>

        {/* UrbanSitter-style drag-to-select banner */}
        {showBanner && (
          <div className="bg-sky-50 border border-sky-200 rounded-2xl px-5 py-3.5 mb-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Calendar className="w-5 h-5 text-sky-600 flex-shrink-0" />
              <p className="text-sm text-sky-900 font-medium">Click and drag the times you are available to work.</p>
            </div>
            <button
              onClick={() => setShowBanner(false)}
              className="text-sky-400 hover:text-sky-600 flex-shrink-0"
              aria-label="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Occasional vs Part/Full-time dual update links */}
        <div className="bg-white border border-slate-200 rounded-2xl px-5 py-4 mb-5 grid sm:grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase mb-1">Occasional jobs</p>
            <button
              onClick={openAvailModal}
              className="text-sm text-primary-600 hover:text-primary-700 font-semibold"
            >
              Confirm this calendar is up to date →
            </button>
          </div>
          <div className="sm:border-l sm:border-slate-200 sm:pl-4">
            <p className="text-xs font-semibold text-slate-500 uppercase mb-1">Full-time &amp; Part-time jobs</p>
            <button
              onClick={openAvailModal}
              className="text-sm text-primary-600 hover:text-primary-700 font-semibold"
            >
              Update general availability →
            </button>
          </div>
        </div>

      <div className="flex gap-5">

        {/* ── Left: Mini Monthly Calendar ── */}
        <div className="w-64 flex-shrink-0 space-y-4">

          {/* Add Availability CTA */}
          <button
            onClick={openAvailModal}
            className="w-full flex items-center justify-center gap-2 bg-primary-500 hover:bg-primary-600 text-white font-semibold text-sm py-3 rounded-xl transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Update Availability
          </button>

          {/* Mini calendar */}
          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            {/* Month nav */}
            <div className="flex items-center justify-between mb-3">
              <button
                onClick={() => setMonthDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-500 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm font-bold text-slate-800">
                {MONTH_NAMES[monthDate.getMonth()]} {monthDate.getFullYear()}
              </span>
              <button
                onClick={() => setMonthDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-500 transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {/* Day-of-week headers */}
            <div className="grid grid-cols-7 gap-0.5 mb-1">
              {DAY_LABELS_SHORT.map((d, i) => (
                <div key={i} className="text-center text-[10px] font-bold text-slate-400 py-1">{d}</div>
              ))}
            </div>

            {/* Calendar grid */}
            <div className="grid grid-cols-7 gap-0.5">
              {monthBlanks.map((_, i) => <div key={`b-${i}`} className="h-8" />)}
              {monthDays.map(d => {
                const date = new Date(monthDate.getFullYear(), monthDate.getMonth(), d);
                const isToday = date.toDateString() === today.toDateString();
                const hasAvail = dayHasAvailability(d);

                return (
                  <div
                    key={d}
                    className={`h-8 rounded-lg flex items-center justify-center relative text-xs font-medium ${
                      isToday
                        ? 'bg-primary-500 text-white'
                        : 'text-slate-700'
                    }`}
                  >
                    {d}
                    {hasAvail && !isToday && (
                      <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 bg-primary-400 rounded-full" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Availability legend */}
          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <h3 className="text-xs font-bold text-slate-700 mb-3 uppercase tracking-wide">My Availability</h3>
            <div className="space-y-2">
              {DAYS.map((shortDay, idx) => {
                const longDay = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][idx];
                const entries = ((availability as any)[shortDay] || (availability as any)[longDay] || []) as any[];
                const formatSlot = (e: any): string => {
                  if (typeof e === 'string') return e.slice(0, 3);
                  if (e && typeof e === 'object' && typeof e.start === 'string' && typeof e.end === 'string') {
                    const fmt = (t: string) => {
                      const h = parseInt(t.split(':')[0], 10);
                      if (h === 0 || h === 24) return '12a';
                      if (h === 12) return '12p';
                      return h < 12 ? `${h}a` : `${h - 12}p`;
                    };
                    return `${fmt(e.start)}-${fmt(e.end)}`;
                  }
                  return '';
                };
                return (
                  <div key={shortDay} className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-600 w-8">{shortDay}</span>
                    {entries.length > 0 ? (
                      <div className="flex gap-1 flex-wrap justify-end">
                        {entries.map((e, i) => (
                          <span key={i} className="text-[10px] bg-primary-50 text-primary-600 px-1.5 py-0.5 rounded font-medium">{formatSlot(e)}</span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[10px] text-slate-300">—</span>
                    )}
                  </div>
                );
              })}
            </div>
            <button
              onClick={openAvailModal}
              className="w-full mt-3 text-xs text-primary-600 font-semibold hover:text-primary-700 text-center"
            >
              Edit →
            </button>
          </div>
        </div>

        {/* ── Right: Weekly Schedule ── */}
        <div className="flex-1 min-w-0">
          <CaregiverSchedule
            appointments={appointments}
            weeklyAvailability={availability}
          />
        </div>
      </div>

      {/* ── Availability Edit Modal ── */}
      {showAvailModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div
            className="bg-white rounded-3xl w-full max-w-xl max-h-[90vh] overflow-y-auto shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b border-slate-100 sticky top-0 bg-white rounded-t-3xl z-10">
              <div>
                <h3 className="font-bold text-slate-900">Update Availability</h3>
                <p className="text-xs text-slate-500 mt-0.5">Select the times you're available each day</p>
              </div>
              <button onClick={() => setShowAvailModal(false)} className="p-2 hover:bg-slate-100 rounded-xl transition-colors">
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            {/* Availability grid (click & drag) */}
            <div className="p-5">
              <DragSelectWeekGrid
                value={editAvail}
                onChange={(next) => setEditAvail(next as any)}
              />
            </div>

            {/* Footer */}
            <div className="p-5 border-t border-slate-100 flex gap-3">
              <button
                onClick={() => setShowAvailModal(false)}
                className="flex-1 py-3 rounded-xl border border-slate-200 text-sm font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveAvailability}
                disabled={saving}
                className="flex-1 py-3 rounded-xl bg-primary-500 hover:bg-primary-600 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Save Availability
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
};
