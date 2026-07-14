import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  Calendar as CalendarIcon, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, MessageSquare, X,
  Video, Phone, Home, Loader2, User, MapPin, CheckCircle, Lock,
} from 'lucide-react';
import firebase from 'firebase/compat/app';
import { db } from '../../lib/firebase';
import { CaregiverTopNav } from './CaregiverTopNav';
import { useCaregiverGate } from '../../hooks/useCaregiverGate';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useCareConnex } from '../../context/CareConnexContext';
import { blocksToWeeklySlots, weeklySlotsToBl } from '../../services/availabilityService';
import { shiftDisplayStatus, shiftStatusBlockClass, shiftStatusBadgeClass, shiftStatusDotClass, shiftStatusLabel } from '../../utils/shiftUtils';

const TIME_BLOCKS = [
  { id: 'morning',   label: 'Morning',   hours: '6am – 12pm' },
  { id: 'afternoon', label: 'Afternoon', hours: '12pm – 6pm' },
  { id: 'evening',   label: 'Evening',   hours: '6pm – 12am' },
  { id: 'overnight', label: 'Overnight', hours: '12am – 6am' },
] as const;

const WEEK_DAYS = [
  { key: 'sunday',    short: 'Sun' },
  { key: 'monday',    short: 'Mon' },
  { key: 'tuesday',   short: 'Tue' },
  { key: 'wednesday', short: 'Wed' },
  { key: 'thursday',  short: 'Thu' },
  { key: 'friday',    short: 'Fri' },
  { key: 'saturday',  short: 'Sat' },
] as const;

interface Shift {
  id: string;
  caregiverId: string;
  clientId: string;
  clientName?: string;
  date: string;
  startTime: string;
  endTime?: string;
  status: 'scheduled' | 'in-progress' | 'completed' | 'cancelled';
  address?: string;
  notes?: string;
  completionNotes?: string;
  tasksCompleted?: string[];
  careNeeds?: string[];
  lifestylePreferences?: string[];
  bookingRequestId?: string;
  startedAt?: any;
  completedAt?: any;
  rate?: number | null;
}

interface InterviewEvent {
  id: string;
  caregiverId: string;
  clientId: string;
  clientName?: string;
  scheduledTime: string;
  status: 'requested' | 'accepted' | 'scheduled' | 'confirmed' | 'in-progress' | 'completed' | 'cancelled' | 'declined';
  interviewType: 'video' | 'phone' | 'in-person';
  callUrl?: string;
  notes?: string;
  jobId?: string;
  jobTitle?: string;
  date: string;
  startTime: string;
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseInterview(id: string, data: any): InterviewEvent {
  const dt = new Date(data.scheduledTime);
  return {
    id,
    ...data,
    date: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`,
    startTime: `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`,
  };
}

const H_START = 0;
const H_END   = 24;
const CELL_H  = 56;
const TOTAL_H = (H_END - H_START) * CELL_H;
const HOURS   = Array.from({ length: H_END - H_START }, (_, i) => i + H_START);
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const SLOT_RANGES: Record<string, { start: number; end: number }> = {
  morning:   { start: 6,  end: 12 },
  afternoon: { start: 12, end: 18 },
  evening:   { start: 18, end: 22 },
  overnight: { start: 22, end: 24 },
  am:        { start: 6,  end: 12 },
  pm:        { start: 12, end: 18 },
};

function parseH(t?: string): number {
  if (!t) return 9;
  const [h, m] = t.split(':').map(Number);
  return (h || 0) + (m || 0) / 60;
}

function fmtH(h: number): string {
  const whole = Math.floor(h);
  const mins  = Math.round((h - whole) * 60);
  if (whole === 12) return mins ? `12:${String(mins).padStart(2, '0')}pm` : '12pm';
  if (whole === 0)  return mins ? `12:${String(mins).padStart(2, '0')}am` : '12am';
  if (whole < 12)   return mins ? `${whole}:${String(mins).padStart(2, '0')}am` : `${whole}am`;
  return mins ? `${whole - 12}:${String(mins).padStart(2, '0')}pm` : `${whole - 12}pm`;
}

/** Convert "HH:MM" 24-hr string → "12:xx am/pm" */
function fmt12(t?: string): string {
  if (!t) return '';
  return fmtH(parseH(t));
}

function statusStyle(shift: Shift): string {
  return shiftStatusBlockClass(shiftDisplayStatus(shift));
}

function statusBadge(shift: Shift): string {
  return shiftStatusBadgeClass(shiftDisplayStatus(shift));
}

function interviewBlockStyle(status: InterviewEvent['status']): string {
  if (status === 'completed') return 'bg-purple-300 border-purple-400';
  if (status === 'cancelled' || status === 'declined') return 'bg-slate-400 border-slate-500';
  return 'bg-purple-500 border-purple-600';
}

interface CaregiverCalendarPageProps {
  onNavigate: (view: any) => void;
}

export const CaregiverCalendarPage: React.FC<CaregiverCalendarPageProps> = ({ onNavigate: _onNavigate }) => {
  const navigate = useNavigate();
  const { blockReason } = useCaregiverGate();
  const { setMembershipModalOpen } = useCareConnex();
  const [view,       setView]       = useState<'week' | 'month' | 'day' | 'list'>('week');
  const [dateFilter, setDateFilter] = useState<'upcoming' | 'this-week' | 'this-month' | 'last-30' | 'all'>('upcoming');
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthDate,  setMonthDate]  = useState(new Date());
  const [dayDate,    setDayDate]    = useState(new Date());

  const [shifts,       setShifts]       = useState<Shift[]>([]);
  const [interviews,   setInterviews]   = useState<InterviewEvent[]>([]);
  const [availability, setAvailability] = useState<Record<string, any[]>>({});
  const [loading,      setLoading]      = useState(true);

  const [selectedShift,     setSelectedShift]     = useState<Shift | null>(null);
  const [selectedInterview, setSelectedInterview] = useState<InterviewEvent | null>(null);
  const [selectedDay,       setSelectedDay]       = useState(localDate(new Date()));
  const [showAvailModal,    setShowAvailModal]    = useState(false);
  const [editAvail,         setEditAvail]         = useState<Record<string, any[]>>({});
  const [saving,            setSaving]            = useState(false);
  const [expandedDates,     setExpandedDates]     = useState<Record<string, boolean>>({});

  const user = useAuthUser();

  useEffect(() => { fetchShifts(); }, [monthDate]);
  useEffect(() => { fetchInterviews(); fetchAvailability(); }, []);

  const fetchShifts = async () => {
    if (!user || !db) { setLoading(false); return; }
    try {
      const startDate = new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1);
      const endDate   = new Date(monthDate.getFullYear(), monthDate.getMonth() + 2, 0);
      const snap = await db.collection('shifts')
        .where('caregiverId', '==', user.uid)
        .where('date', '>=', localDate(startDate))
        .where('date', '<=', localDate(endDate))
        .orderBy('date', 'asc')
        .get();
      const list: Shift[] = [];
      snap.forEach(doc => list.push({ id: doc.id, ...doc.data() } as Shift));
      setShifts(list);
    } catch (e) {
      console.error('fetchShifts:', e);
    } finally {
      setLoading(false);
    }
  };

  const fetchInterviews = async () => {
    if (!user || !db) return;
    try {
      const snap = await db.collection('video_interviews')
        .where('caregiverId', '==', user.uid)
        .get();
      const list: InterviewEvent[] = [];
      snap.forEach(doc => {
        const data = doc.data();
        if (['requested', 'accepted', 'scheduled', 'confirmed', 'in-progress', 'completed'].includes(data.status)) {
          list.push(parseInterview(doc.id, data));
        }
      });
      setInterviews(list);
    } catch (e) {
      console.error('fetchInterviews:', e);
    }
  };

  const fetchAvailability = async () => {
    if (!user || !db) return;
    try {
      const snap = await db.collection('caregivers').doc(user.uid).get();
      const data = snap.data();
      if (data?.weeklyAvailability) setAvailability(weeklySlotsToBl(data.weeklyAvailability) as Record<string, any[]>);
    } catch {}
  };

  const handleStartShift = async (shiftId: string) => {
    if (!db) return;
    await db.collection('shifts').doc(shiftId).update({
      status: 'in-progress',
      startedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    setSelectedShift(prev => prev ? { ...prev, status: 'in-progress' } : prev);
    fetchShifts();
  };

  const handleEndShift = async (shiftId: string, notes?: string) => {
    if (!db) return;
    const update: Record<string, any> = {
      status: 'completed',
      completedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (notes?.trim()) update.completionNotes = notes.trim();
    await db.collection('shifts').doc(shiftId).update(update);
    setSelectedShift(null);
    fetchShifts();
  };

  const handleCancelShift = async (shiftId: string) => {
    if (!confirm('Cancel this shift? The client will be notified.')) return;
    if (!db || !user) return;
    const shift = shifts.find(s => s.id === shiftId);
    await db.collection('shifts').doc(shiftId).update({
      status: 'cancelled',
      cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
      cancelledBy: 'caregiver',
    });
    // Notification handled by onShiftStatusChanged Cloud Function
    setSelectedShift(null);
    fetchShifts();
  };


  const saveAvailability = useCallback(async () => {
    if (!user || !db) return;
    setSaving(true);
    try {
      await db.collection('caregivers').doc(user.uid).update({ weeklyAvailability: blocksToWeeklySlots(editAvail as Record<string, string[]>) });
      setAvailability(editAvail);
      setShowAvailModal(false);
    } catch {
      setAvailability(editAvail);
      setShowAvailModal(false);
    } finally {
      setSaving(false);
    }
  }, [user, editAvail]);

  const today = new Date();
  const todayStr = localDate(today);

  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay() + weekOffset * 7);
  const weekDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });
  const isToday = (d: Date) => d.toDateString() === today.toDateString();

  const shiftsByDay: Record<number, Shift[]> = {};
  shifts.filter(s => s.status !== 'cancelled').forEach(s => {
    weekDates.forEach((wd, idx) => {
      if (localDate(wd) === s.date) {
        if (!shiftsByDay[idx]) shiftsByDay[idx] = [];
        shiftsByDay[idx].push(s);
      }
    });
  });

  const interviewsByDay: Record<number, InterviewEvent[]> = {};
  interviews.forEach(iv => {
    weekDates.forEach((wd, idx) => {
      if (localDate(wd) === iv.date) {
        if (!interviewsByDay[idx]) interviewsByDay[idx] = [];
        interviewsByDay[idx].push(iv);
      }
    });
  });

  const wFirst = weekDates[0], wLast = weekDates[6];
  const weekLabel = wFirst.getMonth() === wLast.getMonth()
    ? `${MONTH_NAMES[wFirst.getMonth()]} ${wFirst.getDate()} – ${wLast.getDate()}, ${wFirst.getFullYear()}`
    : `${MONTH_NAMES[wFirst.getMonth()].slice(0, 3)} ${wFirst.getDate()} – ${MONTH_NAMES[wLast.getMonth()].slice(0, 3)} ${wLast.getDate()}`;

  const dayDateStr    = localDate(dayDate);
  const dayShifts     = shifts.filter(s => s.date === dayDateStr && s.status !== 'cancelled');
  const dayInterviews = interviews.filter(iv => iv.date === dayDateStr);

  const daysInMonth    = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
  const firstDayOfWeek = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1).getDay();
  const monthBlanks    = Array.from({ length: firstDayOfWeek });
  const monthDays      = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const selectedDateShifts     = shifts.filter(s => s.date === selectedDay);
  const selectedDateInterviews = interviews.filter(iv => iv.date === selectedDay);

  type CalEvent =
    | { kind: 'shift';     date: string; startTime: string; shift: Shift }
    | { kind: 'interview'; date: string; startTime: string; interview: InterviewEvent };

  const allEvents: CalEvent[] = [
    ...shifts.map(s  => ({ kind: 'shift'     as const, date: s.date,  startTime: s.startTime,  shift: s })),
    ...interviews.map(iv => ({ kind: 'interview' as const, date: iv.date, startTime: iv.startTime, interview: iv })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

  const filteredEvents = allEvents.filter(e => {
    switch (dateFilter) {
      case 'upcoming':   return e.date >= todayStr;
      case 'this-week':  return e.date >= localDate(weekDates[0]) && e.date <= localDate(weekDates[6]);
      case 'this-month': {
        const y = today.getFullYear(), m = today.getMonth();
        const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
        const end   = `${y}-${String(m + 1).padStart(2, '0')}-${String(new Date(y, m + 1, 0).getDate()).padStart(2, '0')}`;
        return e.date >= start && e.date <= end;
      }
      case 'last-30': {
        const start = localDate(new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000));
        return e.date >= start && e.date <= todayStr;
      }
      default: return true;
    }
  });

  const groupedEvents: Record<string, CalEvent[]> = {};
  filteredEvents.forEach(e => {
    if (!groupedEvents[e.date]) groupedEvents[e.date] = [];
    groupedEvents[e.date].push(e);
  });
  const groupedDates = Object.keys(groupedEvents).sort();

  function getAvailBlocks(dayKey: string): Array<{ start: number; end: number }> {
    const slots: any[] = (availability as any)[dayKey]
      || (availability as any)[dayKey.charAt(0).toUpperCase() + dayKey.slice(1, 3)]
      || [];
    const ranges: Array<{ start: number; end: number }> = [];
    slots.forEach(slot => {
      const key = typeof slot === 'string' ? slot.toLowerCase() : '';
      const range = SLOT_RANGES[key];
      if (!range) return;
      const last = ranges[ranges.length - 1];
      if (last && last.end === range.start) { last.end = range.end; }
      else { ranges.push({ ...range }); }
    });
    return ranges;
  }

  const AvailBlocks = ({ dayKey }: { dayKey: string }) => (
    <>
      {getAvailBlocks(dayKey).map((r, ri) => {
        const cs = Math.max(r.start, H_START);
        const ce = Math.min(r.end, H_END);
        if (ce <= cs) return null;
        return (
          <div key={ri} className="absolute inset-x-0.5 rounded-md bg-primary-50 border border-primary-100 pointer-events-none"
            style={{ top: (cs - H_START) * CELL_H + 1, height: (ce - cs) * CELL_H - 2 }} />
        );
      })}
    </>
  );

  const activeDetail = selectedShift ? 'shift' : selectedInterview ? 'interview' : null;

  const ShiftDetail = ({ shift, onClose }: { shift: Shift; onClose: () => void }) => {
    const now = new Date();
    const shiftStart = new Date(`${shift.date}T${shift.startTime}`);
    const endTimeStr = shift.endTime || shift.startTime;
    // If end time is earlier in the day than start time, the shift crosses midnight — end is on the next day
    const endDate = endTimeStr < (shift.startTime || '00:00')
      ? (() => { const d = new Date(shift.date + 'T12:00:00'); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; })()
      : shift.date;
    const shiftEnd      = new Date(`${endDate}T${endTimeStr}`);
    const minUntilStart = (shiftStart.getTime() - now.getTime()) / 60000;
    const shiftEnded    = shiftEnd <= now;

    // Which actions are available
    // canStart: within 15 min of start OR late (started but not ended yet) — not overdue
    const canStart  = shift.status === 'scheduled' && minUntilStart <= 15 && !shiftEnded;
    const canEnd    = shift.status === 'in-progress';
    const canCancel = shift.status === 'scheduled';

    const householdInfo = shift.lifestylePreferences || [];

    // Actual start/end/duration helpers
    const tsToDate = (ts: any): Date | null => {
      if (!ts) return null;
      if (ts?.toDate) return ts.toDate();
      if (ts?.seconds) return new Date(ts.seconds * 1000);
      return null;
    };
    const fmtTs = (ts: any) => {
      const d = tsToDate(ts);
      if (!d) return null;
      const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
      return `${date}, ${time}`;
    };
    const actualStart = fmtTs(shift.startedAt);
    const actualEnd   = fmtTs(shift.completedAt);
    const duration = (() => {
      const s = tsToDate(shift.startedAt); const e = tsToDate(shift.completedAt);
      if (!s || !e) return null;
      const totalSecs = Math.round((e.getTime() - s.getTime()) / 1000);
      if (totalSecs <= 0) return null;
      const h = Math.floor(totalSecs / 3600);
      const m = Math.floor((totalSecs % 3600) / 60);
      const sec = totalSecs % 60;
      return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    })();

    // Care tasks — from shift directly, or fetch from booking as fallback
    const [careNeeds, setCareNeeds] = React.useState<string[]>(shift.careNeeds || []);
    const [tasksCompleted, setTasksCompleted] = React.useState<string[]>(shift.tasksCompleted || []);
    const [fetchingTasks, setFetchingTasks] = React.useState(false);

    // Real-time sync: listen to this shift doc so task changes from bookings page show up here
    React.useEffect(() => {
      if (!db) return;
      const unsub = db.collection('shifts').doc(shift.id)
        .onSnapshot(doc => {
          if (doc.exists) {
            const data = doc.data() as any;
            setTasksCompleted(data.tasksCompleted || []);
          }
        });
      return () => unsub();
    }, [shift.id]);

    // End shift notes flow
    const [endingShift, setEndingShift] = React.useState(false);
    const [endNotes, setEndNotes] = React.useState('');

    // Booking details
    const [bookingData, setBookingData] = React.useState<any>(null);

    React.useEffect(() => {
      if (!shift.bookingRequestId || !db) return;
      if (careNeeds.length === 0) setFetchingTasks(true);
      db.collection('booking_requests').doc(shift.bookingRequestId).get()
        .then(doc => {
          const data = doc.data() || {};
          if (careNeeds.length === 0) setCareNeeds(data.careNeeds || []);
          setBookingData(data);
        })
        .catch(() => {})
        .finally(() => setFetchingTasks(false));
    }, [shift.id]);

    const handleToggleTask = async (task: string) => {
      if (!db) return;
      const updated = tasksCompleted.includes(task)
        ? tasksCompleted.filter(t => t !== task)
        : [...tasksCompleted, task];
      setTasksCompleted(updated);
      await db.collection('shifts').doc(shift.id).update({ tasksCompleted: updated }).catch(() => {});
    };

    const handleToggleCategory = async (keys: string[]) => {
      if (!db) return;
      const allDone = keys.every(k => tasksCompleted.includes(k));
      const updated = allDone
        ? tasksCompleted.filter(k => !keys.includes(k))
        : [...new Set([...tasksCompleted, ...keys])];
      setTasksCompleted(updated);
      await db.collection('shifts').doc(shift.id).update({ tasksCompleted: updated }).catch(() => {});
    };

    return (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Header */}
        <div className="p-5 pb-3">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-3">
              {(() => {
                const nm = shift.clientName || 'Client';
                const ini = nm.split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase();
                const photo = (shift as any).clientPhotoURL;
                return (
                  <div className="w-10 h-10 rounded-full overflow-hidden bg-blue-100 flex items-center justify-center shrink-0">
                    {photo
                      ? <img src={photo} alt={nm} className="w-full h-full object-cover" />
                      : <span className="text-sm font-bold text-blue-600">{ini}</span>}
                  </div>
                );
              })()}
              <div>
                <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${statusBadge(shift)}`}>
                  {shift.status === 'in-progress' ? '● In Progress' : shiftStatusLabel(shiftDisplayStatus(shift))}
                </span>
                <h3 className="font-bold text-slate-900 text-base mt-1">{shift.clientName || 'Client'}</h3>
                <p className="text-sm text-slate-500 mt-0.5">
                  {new Date(shift.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  {' · '}{fmt12(shift.startTime)}{shift.endTime ? ` – ${fmt12(shift.endTime)}` : ''}
                </p>
              </div>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg font-bold leading-none">×</button>
          </div>
          {shift.rate && (
            <p className="text-xs text-slate-400 mt-0.5">${shift.rate}/hr</p>
          )}
        </div>

        {/* Info: address + household badges */}
        <div className="px-5 space-y-2 text-sm mb-3">
          {shift.address && (
            <div>
              <div className="flex items-start gap-2 text-slate-600">
                <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0 text-slate-400" />
                <span className="text-xs">{shift.address}</span>
              </div>
              {householdInfo.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5 ml-6">
                  {householdInfo.map((pref, i) => (
                    <span key={i} className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-xs font-medium">
                      {pref}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {shift.notes && (
            <div className="p-3 bg-slate-50 rounded-xl text-slate-600 text-xs">{shift.notes}</div>
          )}
        </div>

        {/* Actual time worked */}
        {(actualStart || actualEnd) && (
          <div className="px-5 mb-3 space-y-1">
            <div className="flex items-center gap-3 text-xs">
              <span className="w-20 text-slate-400 shrink-0">Scheduled</span>
              <span className="font-semibold text-slate-700">{fmt12(shift.startTime)}{shift.endTime ? ` – ${fmt12(shift.endTime)}` : ''}</span>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="w-20 text-slate-400 shrink-0">Started</span>
              <span className="font-semibold text-slate-700">
                {actualStart}
                {actualEnd && <><span className="text-slate-400 font-normal"> · Ended </span>{actualEnd}</>}
                {duration && <span className="text-primary-600 font-semibold"> · {duration}</span>}
              </span>
            </div>
          </div>
        )}

        {/* Tasks — grouped by recipient when booking data available */}
        {(careNeeds.length > 0 || fetchingTasks || (bookingData?.careRecipients?.length ?? 0) > 0) && (
          <div className="px-5 mb-4">
            {(() => {
              // Compute total/done counts across all recipients
              let total = 0; let done = 0;
              if (bookingData?.careRecipients?.length > 0) {
                bookingData.careRecipients.forEach((r: any, ri: number) => {
                  const cats: string[] = r.careNeeds || [];
                  const det: Record<string, string[]> = r.careNeedDetails || {};
                  cats.forEach(cat => {
                    const subs = det[cat] || [];
                    if (subs.length > 0) {
                      total += subs.length;
                      done += subs.filter((sub: string) => tasksCompleted.includes(`${ri}_${cat}_${sub}`) || tasksCompleted.includes(sub)).length;
                    } else {
                      total += 1;
                      done += tasksCompleted.includes(`${ri}_${cat}`) ? 1 : 0;
                    }
                  });
                });
              } else {
                total = careNeeds.length;
                done = tasksCompleted.filter(t => careNeeds.includes(t)).length;
              }
              return (
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Tasks</p>
                  {total > 0 && (
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${done === total ? 'bg-green-100 text-green-700' : done > 0 ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                      {done}/{total}
                    </span>
                  )}
                </div>
              );
            })()}
            {fetchingTasks && !bookingData ? (
              <p className="text-xs text-slate-400">Loading tasks…</p>
            ) : bookingData?.careRecipients?.length > 0 ? (
              <div className="space-y-3">
                {bookingData.careRecipients.map((r: any, ri: number) => {
                  const categories: string[] = r.careNeeds || [];
                  const details: Record<string, string[]> = r.careNeedDetails || {};
                  if (categories.length === 0) return null;
                  const isCompleted = shift.status === 'completed' || shift.status === 'cancelled';
                  return (
                    <div key={ri}>
                      <div className="flex items-center gap-1.5 mb-1.5">
                        {r.photoURL
                          ? <img src={r.photoURL} className="w-5 h-5 rounded-full object-cover shrink-0" alt="" />
                          : <div className="w-5 h-5 rounded-full bg-primary-100 flex items-center justify-center text-primary-600 text-[10px] font-bold shrink-0">{(r.name || r.firstName || '?')[0].toUpperCase()}</div>
                        }
                        <span className="text-xs font-semibold text-slate-700">{r.name || r.firstName}</span>
                        {r.relationship && <span className="text-xs text-slate-400">· {r.relationship}{r.age ? ` · Age ${r.age}` : ''}</span>}
                      </div>
                      <div className="space-y-1.5">
                        {categories.map((category, ci) => {
                          const subtasks = details[category] || [];
                          const subKeys = subtasks.map((sub: string) => `${ri}_${category}_${sub}`);
                          const doneSubCount = subKeys.filter((k: string) => tasksCompleted.includes(k)).length;
                          const allSubDone = subtasks.length > 0 && doneSubCount === subtasks.length;
                          const catKey = `${ri}_${category}`;
                          const catDone = subtasks.length === 0 ? tasksCompleted.includes(catKey) : allSubDone;
                          return (
                            <div key={ci} className="border border-slate-200 rounded-xl overflow-hidden">
                              {isCompleted ? (
                                <div className={`flex items-center gap-2 px-3 py-2 ${catDone ? 'bg-green-50' : 'bg-slate-50'}`}>
                                  <CheckCircle className={`w-3.5 h-3.5 shrink-0 ${catDone ? 'text-green-500' : 'text-slate-300'}`} />
                                  <p className={`text-xs font-semibold flex-1 ${catDone ? 'text-green-700 line-through' : 'text-primary-600'}`}>{category}</p>
                                  {subtasks.length > 0 && doneSubCount > 0 && (
                                    <span className={`text-[10px] font-semibold ${catDone ? 'text-green-600' : 'text-slate-400'}`}>{doneSubCount}/{subtasks.length}</span>
                                  )}
                                </div>
                              ) : (
                                <button
                                  onClick={() => subtasks.length > 0 ? handleToggleCategory(subKeys) : handleToggleTask(catKey)}
                                  className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${catDone ? 'bg-primary-50' : 'bg-slate-50 hover:bg-slate-100'}`}
                                >
                                  <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-colors ${catDone ? 'bg-primary-500 border-primary-500' : 'border-primary-300 bg-white'}`}>
                                    {catDone && <CheckCircle className="w-2.5 h-2.5 text-white" />}
                                  </div>
                                  <p className={`text-xs font-semibold flex-1 ${catDone ? 'text-primary-400 line-through' : 'text-primary-600'}`}>{category}</p>
                                </button>
                              )}
                              {subtasks.length > 0 && (
                                <div className="px-3 py-2 space-y-1">
                                  {subtasks.map((sub: string, si: number) => {
                                    const taskKey = `${ri}_${category}_${sub}`;
                                    const done = tasksCompleted.includes(taskKey) || tasksCompleted.includes(sub);
                                    if (isCompleted) return (
                                      <div key={si} className={`flex items-center gap-2 text-xs font-medium ${done ? 'text-green-700' : 'text-slate-400'}`}>
                                        <CheckCircle className={`w-3.5 h-3.5 flex-shrink-0 ${done ? 'text-green-500' : 'text-slate-300'}`} />
                                        {sub}
                                      </div>
                                    );
                                    return (
                                      <button key={si} onClick={() => handleToggleTask(taskKey)}
                                        className={`w-full flex items-center gap-2 text-left text-xs font-medium transition-colors ${done ? 'text-green-700' : 'text-slate-600 hover:text-slate-900'}`}>
                                        <CheckCircle className={`w-3.5 h-3.5 flex-shrink-0 ${done ? 'text-green-500' : 'text-slate-300'}`} />
                                        {sub}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-1.5">
                {careNeeds.map((task, i) => {
                  const done = tasksCompleted.includes(task);
                  const isCompleted = shift.status === 'completed' || shift.status === 'cancelled';
                  if (isCompleted) return (
                    <div key={i} className={`flex items-center gap-2.5 px-3 py-2 rounded-xl border text-xs font-medium ${done ? 'bg-green-50 border-green-200 text-green-700' : 'bg-slate-50 border-slate-100 text-slate-400'}`}>
                      <CheckCircle className={`w-4 h-4 flex-shrink-0 ${done ? 'text-green-500' : 'text-slate-200'}`} />
                      {task}
                    </div>
                  );
                  return (
                    <button key={i} onClick={() => handleToggleTask(task)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border text-left text-xs font-medium transition-colors ${done ? 'bg-green-50 border-green-200 text-green-700' : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'}`}>
                      <CheckCircle className={`w-4 h-4 flex-shrink-0 ${done ? 'text-green-500' : 'text-slate-300'}`} />
                      {task}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="px-5 pb-3 space-y-2">
          {/* Scheduled: not yet startable */}
          {shift.status === 'scheduled' && !canStart && !shiftEnded && (
            <p className="text-xs text-slate-400 text-center py-1">
              Start available 15 min before shift
            </p>
          )}

          {/* Scheduled + within 15 min of start (or past start but not ended): Start Shift */}
          {canStart && (
            blockReason === 'membership' ? (
              <button onClick={() => setMembershipModalOpen(true)} className="w-full py-2.5 bg-slate-100 border border-slate-200 text-slate-500 text-sm font-semibold rounded-xl flex items-center justify-center gap-1.5 transition-colors hover:bg-slate-200">
                <Lock className="w-4 h-4" /> Activate Membership
              </button>
            ) : blockReason === 'background' ? (
              <button onClick={() => navigate('/caregiver/dashboard')} className="w-full py-2.5 bg-amber-50 border border-amber-200 text-amber-700 text-sm font-semibold rounded-xl flex items-center justify-center gap-1.5 transition-colors hover:bg-amber-100">
                <Lock className="w-4 h-4" /> Complete Verification
              </button>
            ) : (
              <button
                onClick={() => handleStartShift(shift.id)}
                className="w-full py-2.5 bg-accent-500 hover:bg-accent-600 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-1.5 transition-colors"
              >
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                Start Shift
              </button>
            )
          )}

          {/* In Progress: End Shift (two-step with notes) */}
          {canEnd && !endingShift && (
            <button
              onClick={() => setEndingShift(true)}
              className="w-full py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-1.5 transition-colors"
            >
              <CheckCircle className="w-4 h-4" />End Shift
            </button>
          )}
          {canEnd && endingShift && (
            <div className="space-y-2">
              <textarea
                value={endNotes}
                onChange={e => setEndNotes(e.target.value)}
                placeholder="Add shift notes (optional)…"
                rows={3}
                className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-green-200 resize-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setEndingShift(false)}
                  className="flex-1 py-2 border border-slate-200 rounded-xl text-slate-600 text-sm hover:bg-slate-50"
                >
                  Back
                </button>
                <button
                  onClick={() => handleEndShift(shift.id, endNotes)}
                  className="flex-1 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-1.5"
                >
                  <CheckCircle className="w-4 h-4" />Complete
                </button>
              </div>
            </div>
          )}

          {/* Completed */}
          {shift.status === 'completed' && (
            <div className="space-y-2">
              <div className="flex items-center justify-center gap-1.5 py-2 text-green-700 text-sm font-semibold bg-green-50 rounded-xl border border-green-200">
                <CheckCircle className="w-4 h-4" /> Shift Completed
              </div>
              {shift.completionNotes && (
                <div className="p-3 bg-slate-50 rounded-xl text-xs text-slate-600 border border-slate-200">
                  <p className="text-xs font-semibold text-slate-500 mb-1">Caregiver Notes</p>
                  {shift.completionNotes}
                </div>
              )}
            </div>
          )}

          {/* Cancelled */}
          {shift.status === 'cancelled' && (
            <div className="flex items-center justify-center gap-1.5 py-2 text-rose-600 text-sm font-semibold bg-rose-50 rounded-xl border border-rose-200">
              Shift Cancelled
            </div>
          )}

          {/* Bottom row: Message + Cancel */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => navigate('/caregiver/inbox')}
              className="flex-1 py-2 border border-slate-200 rounded-xl hover:bg-slate-50 text-slate-600 flex items-center justify-center gap-1.5 text-sm"
            >
              <MessageSquare className="w-4 h-4" />Message
            </button>
            {canCancel && (
              <button
                onClick={() => handleCancelShift(shift.id)}
                className="px-3 py-2 border border-red-200 rounded-xl hover:bg-red-50 text-red-500 text-sm font-medium"
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* Emergency Contact — always visible */}
        {bookingData?.emergencyContact?.name && (
          <div className="px-5 pb-5">
            <div className="p-3 bg-red-50 border border-red-100 rounded-xl">
              <p className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-1">Emergency Contact</p>
              <p className="text-xs text-red-700 font-medium">
                {bookingData.emergencyContact.name}
                {bookingData.emergencyContact.relationship && (
                  <span className="text-red-400 font-normal"> · {bookingData.emergencyContact.relationship}</span>
                )}
              </p>
              {bookingData.emergencyContact.phone && (
                <p className="text-xs text-red-600 mt-0.5">📞 {bookingData.emergencyContact.phone}</p>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const InterviewDetail = ({ interview, onClose }: { interview: InterviewEvent; onClose: () => void }) => {
    const [job, setJob]                   = useState<any>(null);
    const [clientPhoto, setClientPhoto]   = useState<string | null>(null);
    const [accepting,  setAccepting]      = useState(false);
    const [declining,  setDeclining]      = useState(false);
    const [cancelling, setCancelling]     = useState(false);

    const TypeIcon  = interview.interviewType === 'phone' ? Phone : interview.interviewType === 'in-person' ? Home : Video;
    const typeLabel = interview.interviewType === 'phone' ? 'Phone Call' : interview.interviewType === 'in-person' ? 'In Person' : 'Video Call';
    const statusLabel = interview.status === 'requested' ? 'Pending'
      : interview.status === 'in-progress' ? 'In Progress'
      : interview.status.charAt(0).toUpperCase() + interview.status.slice(1);
    const statusColor = interview.status === 'completed'   ? 'bg-green-100 text-green-700 border-green-200'
      : interview.status === 'cancelled' || interview.status === 'declined' ? 'bg-slate-100 text-slate-500 border-slate-200'
      : interview.status === 'in-progress' ? 'bg-orange-100 text-orange-700 border-orange-200'
      : 'bg-purple-100 text-purple-700 border-purple-200';

    const name     = interview.clientName || 'Client';
    const initials = name.split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase();

    useEffect(() => {
      if (!interview.jobId) return;
      const fdb = db;
      if (!fdb) return;
      fdb.collection('job_posts').doc(interview.jobId).get()
        .then(doc => { if (doc.exists) setJob(doc.data()); })
        .catch(() => {});
    }, [interview.jobId]);

    useEffect(() => {
      if (!interview.clientId) return;
      const fdb = db;
      if (!fdb) return;
      // 1. Embedded directly on the interview doc (new interviews going forward)
      const embedded = (interview as any).clientPhotoURL || (interview as any).clientPhoto;
      if (embedded) { setClientPhoto(embedded); return; }
      const pickPhoto = (d: any) => d?.clientPhotoURL || d?.photoURL || d?.imageUrl || d?.photo || d?.avatar || null;
      // 2. users doc → 3. senior_profiles → 4. booking_requests (most reliable: PostsPage always writes clientPhotoURL there)
      fdb.collection('users').doc(interview.clientId).get()
        .then(doc => {
          const photo = pickPhoto(doc.data());
          if (photo) { setClientPhoto(photo); return; }
          return fdb.collection('senior_profiles').doc(interview.clientId).get()
            .then(sp => {
              const p = pickPhoto(sp.data());
              if (p) { setClientPhoto(p); return; }
              // Grab clientPhotoURL from the most recent booking request by this client
              return fdb.collection('booking_requests')
                .where('clientId', '==', interview.clientId)
                .limit(1)
                .get()
                .then(snap => {
                  if (!snap.empty) {
                    const url = snap.docs[0].data()?.clientPhotoURL;
                    if (url) setClientPhoto(url);
                  }
                });
            });
        })
        .catch(() => {});
    }, [interview.clientId]);

    const handleAccept = async () => {
      const fdb = db;
      if (!fdb) return;
      setAccepting(true);
      try {
        await fdb.collection('video_interviews').doc(interview.id).update({
          status: 'accepted', acceptedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        // Notification handled by onVideoInterviewWrite Cloud Function
        setInterviews(prev => prev.map(iv => iv.id === interview.id ? { ...iv, status: 'accepted' as const } : iv));
        setSelectedInterview(prev => prev?.id === interview.id ? { ...prev, status: 'accepted' as const } : prev);
      } catch { } finally { setAccepting(false); }
    };

    const handleDecline = async () => {
      if (!window.confirm('Decline this interview request?')) return;
      const fdb = db;
      if (!fdb) return;
      setDeclining(true);
      try {
        await fdb.collection('video_interviews').doc(interview.id).update({
          status: 'declined', declinedBy: 'caregiver', declinedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        // Notification handled by onVideoInterviewWrite Cloud Function
        setInterviews(prev => prev.map(iv => iv.id === interview.id ? { ...iv, status: 'declined' as const } : iv));
        setSelectedInterview(prev => prev?.id === interview.id ? { ...prev, status: 'declined' as const } : prev);
      } catch { } finally { setDeclining(false); }
    };

    const handleCancel = async () => {
      if (!window.confirm('Cancel this interview?')) return;
      const fdb = db;
      if (!fdb) return;
      setCancelling(true);
      try {
        await fdb.collection('video_interviews').doc(interview.id).update({
          status: 'cancelled', cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        setInterviews(prev => prev.map(iv => iv.id === interview.id ? { ...iv, status: 'cancelled' as const } : iv));
        setSelectedInterview(prev => prev?.id === interview.id ? { ...prev, status: 'cancelled' as const } : prev);
      } catch { } finally { setCancelling(false); }
    };

    const careTypes: string[] = job?.careTypes || job?.requirements || [];
    const days:      string[] = job?.daysOfWeek || [];
    const times:     string[] = (job?.timeOfDay || []).map((t: string) => t.charAt(0).toUpperCase() + t.slice(1));
    const freq:      string | undefined  = job?.jobFrequency;
    const rate:      number | undefined  = job?.rate;
    const location:  string | null = job?.location || (job?.city ? [job.city, job.state].filter(Boolean).join(', ') : null);

    return (
      <div className="bg-white rounded-2xl border border-purple-100 p-5 shadow-sm">
        {/* Header: avatar + name + status */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full overflow-hidden bg-blue-100 flex items-center justify-center shrink-0">
              {clientPhoto
                ? <img src={clientPhoto} alt={name} className="w-full h-full object-cover" />
                : <span className="text-sm font-bold text-blue-600">{initials}</span>}
            </div>
            <div>
              <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${statusColor}`}>
                Interview · {statusLabel}
              </span>
              <h3 className="font-bold text-slate-900 mt-1">{name}</h3>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>

        {/* Date + time */}
        <div className="flex items-center gap-2 text-sm text-slate-500 mb-3">
          <CalendarIcon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <span>
            {new Date(interview.scheduledTime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            {' · '}
            {new Date(`2000-01-01T${interview.startTime}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
          </span>
        </div>

        <div className="space-y-2 text-sm">
          {/* Interview type */}
          <div className="flex items-center gap-2 text-slate-600">
            <TypeIcon className="w-3.5 h-3.5 shrink-0" /><span>{typeLabel}</span>
          </div>

          {/* Location */}
          {location && (
            <div className="flex items-center gap-2 text-slate-500">
              <MapPin className="w-3.5 h-3.5 shrink-0 text-slate-400" /><span className="text-xs">{location}</span>
            </div>
          )}

          {/* Care type chips */}
          {careTypes.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {careTypes.map((c: string) => (
                <span key={c} className="text-xs px-2 py-0.5 bg-teal-50 text-teal-700 rounded-full border border-teal-100">{c}</span>
              ))}
            </div>
          )}

          {/* Days of week */}
          {days.length > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-slate-600 flex-wrap">
              <span className="text-slate-400 shrink-0">Days:</span>
              {days.map((d: string) => (
                <span key={d} className="px-1.5 py-0.5 bg-slate-100 rounded text-slate-700 font-medium">{d}</span>
              ))}
            </div>
          )}

          {/* Time of day */}
          {times.length > 0 && (
            <p className="text-xs text-slate-500"><span className="text-slate-400">Time:</span> {times.join(', ')}</p>
          )}

          {/* Frequency + rate */}
          {(freq || rate) && (
            <p className="text-xs text-slate-500">
              {freq && <span className="capitalize font-medium text-slate-600">{freq.replace('-', ' ')}</span>}
              {freq && rate && ' · '}
              {rate && <span className="font-medium text-slate-600">${rate}/hr</span>}
            </p>
          )}

          {/* Notes */}
          {interview.notes && (
            <div className="p-3 bg-slate-50 rounded-xl text-slate-600 break-words text-xs max-h-24 overflow-y-auto mt-1">
              {interview.notes}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="mt-4 flex flex-col gap-2">
          {/* Accept / Decline for pending requests */}
          {interview.status === 'requested' && (
            <div className="flex gap-2">
              <button onClick={handleAccept} disabled={accepting}
                className="flex-1 py-2 bg-green-600 hover:bg-green-700 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-1.5">
                {accepting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-4 h-4" />} Accept
              </button>
              <button onClick={handleDecline} disabled={declining}
                className="flex-1 py-2 border border-red-200 hover:bg-red-50 text-red-600 rounded-xl text-sm font-medium flex items-center justify-center gap-1.5">
                {declining ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-4 h-4" />} Decline
              </button>
            </div>
          )}

          {/* Join the Google Meet link (server-generated; meet.google.com only) */}
          {interview.callUrl?.startsWith('https://meet.google.com/') &&
            ['accepted', 'scheduled', 'confirmed', 'in-progress'].includes(interview.status) && (
            <button onClick={() => window.open(interview.callUrl, '_blank', 'noopener')}
              className="w-full py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-1.5">
              <Video className="w-4 h-4" /> Join video call
            </button>
          )}

          <div className="flex gap-2">
            <button onClick={() => navigate('/caregiver/inbox')}
              className="flex-1 py-2 border border-slate-200 rounded-xl hover:bg-slate-50 text-slate-600 text-sm flex items-center justify-center gap-1.5">
              <MessageSquare className="w-4 h-4" /> Message
            </button>
            {interview.status === 'accepted' && (
              <button onClick={handleCancel} disabled={cancelling}
                className="px-3 py-2 border border-red-200 rounded-xl hover:bg-red-50 text-red-500 text-sm flex items-center justify-center gap-1.5">
                {cancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />} Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
    </div>
  );

  return (
  <>
    <div className="min-h-screen bg-slate-50 pb-24">
      <CaregiverTopNav />

      <header className="bg-white border-b border-slate-200 sticky top-[57px] z-10">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-xl font-bold text-slate-900">My Calendar</h1>
              <p className="text-sm text-slate-500">Upcoming shifts and interviews</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5">
                {(['day', 'week', 'month', 'list'] as const).map(v => (
                  <button key={v} onClick={() => setView(v)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-md capitalize transition-colors ${view === v ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
                    {v.charAt(0).toUpperCase() + v.slice(1)}
                  </button>
                ))}
              </div>
              <button
                onClick={() => { setEditAvail(availability); setShowAvailModal(true); }}
                className="flex items-center gap-1.5 px-4 py-2 bg-primary-600 text-white rounded-xl text-sm font-semibold hover:bg-primary-700 transition-colors"
              >
                Update Availability
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">

        {/* ── Shared legend (all views) ── */}
        <div className="flex items-center gap-5 px-4 py-2.5 mb-4 bg-white rounded-xl border border-slate-200 text-xs text-slate-500 flex-wrap">
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-primary-100 border border-primary-200 inline-block" />Available</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-primary-500 inline-block" />Scheduled</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-accent-500 inline-block" />In Progress</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-slate-400 inline-block" />Completed</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-rose-600 inline-block" />Cancelled</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-purple-500 inline-block" />Interviews</span>
        </div>

        {/* ── Week view ── */}
        {view === 'week' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <button onClick={() => setWeekOffset(w => w - 1)} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500"><ChevronLeft className="w-4 h-4" /></button>
              <button onClick={() => setWeekOffset(0)} className="px-3 py-1.5 text-xs font-semibold bg-primary-600 text-white rounded-lg hover:bg-primary-700">Today</button>
              <button onClick={() => setWeekOffset(w => w + 1)} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500"><ChevronRight className="w-4 h-4" /></button>
              <span className="text-sm font-medium text-slate-600 ml-1">{weekLabel}</span>
            </div>
            <div className="flex gap-4">
              <div className="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <div style={{ minWidth: 520 }}>
                    <div className="grid border-b border-slate-200 bg-slate-50" style={{ gridTemplateColumns: '52px repeat(7, 1fr)' }}>
                      <div className="border-r border-slate-200" />
                      {weekDates.map((d, i) => (
                        <div key={i} className={`py-2.5 text-center border-r border-slate-200 last:border-r-0 ${isToday(d) ? 'bg-primary-50' : ''}`}>
                          <div className={`text-xs font-bold uppercase tracking-wide ${isToday(d) ? 'text-primary-500' : 'text-slate-500'}`}>{DAY_ABBR[d.getDay()]}</div>
                          <button onClick={() => { setDayDate(d); setView('day'); }}
                            className={`mx-auto mt-1 w-7 h-7 flex items-center justify-center rounded-full text-sm font-bold transition-colors hover:bg-primary-100 ${isToday(d) ? 'bg-primary-600 text-white' : 'text-slate-700'}`}>
                            {d.getDate()}
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="overflow-y-auto" style={{ maxHeight: 560 }}>
                      <div className="relative" style={{ height: TOTAL_H }}>
                        <div className="absolute inset-0 pointer-events-none" style={{ display: 'grid', gridTemplateColumns: '52px repeat(7, 1fr)' }}>
                          <div className="border-r border-slate-200">
                            {HOURS.map(h => (
                              <div key={h} className="border-b border-slate-100 flex items-start justify-end pr-2" style={{ height: CELL_H, paddingTop: 4 }}>
                                <span className="text-xs text-slate-400">{fmtH(h)}</span>
                              </div>
                            ))}
                          </div>
                          {Array.from({ length: 7 }).map((_, ci) => (
                            <div key={ci} className="border-r border-slate-200 last:border-r-0">
                              {HOURS.map(h => <div key={h} className="border-b border-slate-100" style={{ height: CELL_H }} />)}
                            </div>
                          ))}
                        </div>
                        <div className="absolute inset-0" style={{ display: 'grid', gridTemplateColumns: '52px repeat(7, 1fr)' }}>
                          <div />
                          {weekDates.map((wd, colIdx) => {
                            const colShifts = shiftsByDay[colIdx] || [];
                            const colIvs    = interviewsByDay[colIdx] || [];
                            const hasBoth   = colShifts.length > 0 && colIvs.length > 0;
                            return (
                              <div key={colIdx} className="relative border-r border-slate-200 last:border-r-0">
                                <AvailBlocks dayKey={DAY_KEYS[wd.getDay()]} />
                                {colShifts.map((shift, si) => {
                                  const startH = parseH(shift.startTime);
                                  const endH   = parseH(shift.endTime) || startH + 2;
                                  const cs = Math.max(startH, H_START), ce = Math.min(endH, H_END);
                                  if (ce <= cs) return null;
                                  return (
                                    <button key={`s-${si}`}
                                      onClick={() => { setSelectedShift(shift); setSelectedInterview(null); }}
                                      className={`absolute rounded-md border overflow-hidden z-10 text-left hover:brightness-110 transition-all ${statusStyle(shift)} ${shift.status === 'in-progress' ? 'ring-2 ring-white ring-opacity-60' : ''}`}
                                      style={{ top: (cs - H_START) * CELL_H + 1, height: (ce - cs) * CELL_H - 2, left: '2px', right: hasBoth ? '50%' : '2px' }}>
                                      <p className="px-1.5 pt-1 text-xs font-bold text-white leading-tight truncate">{(shift.clientName || 'Client').split(' ')[0]}</p>
                                      <p className="px-1.5 text-xs text-white/80">{fmt12(shift.startTime)}{shift.endTime ? ` – ${fmt12(shift.endTime)}` : ''}</p>
                                      {(shiftDisplayStatus(shift) === 'overdue' || shift.status === 'in-progress') && <p className="px-1.5 text-[10px] text-white font-semibold">{shift.status === 'in-progress' ? 'In Progress' : shiftStatusLabel(shiftDisplayStatus(shift))}</p>}
                                    </button>
                                  );
                                })}
                                {colIvs.map((iv, ii) => {
                                  const startH = parseH(iv.startTime);
                                  const cs = Math.max(startH, H_START), ce = Math.min(startH + 1, H_END);
                                  if (ce <= cs) return null;
                                  return (
                                    <button key={`i-${ii}`}
                                      onClick={() => { setSelectedInterview(iv); setSelectedShift(null); }}
                                      className={`absolute rounded-md border overflow-hidden z-10 text-left hover:brightness-110 transition-all ${interviewBlockStyle(iv.status)}`}
                                      style={{ top: (cs - H_START) * CELL_H + 1, height: (ce - cs) * CELL_H - 2, left: hasBoth ? '50%' : '2px', right: '2px' }}>
                                      <p className="px-1.5 pt-1 text-xs font-bold text-white leading-tight truncate">{(iv.clientName || 'Interview')}</p>
                                      <p className="px-1.5 text-xs text-white/80">Interview</p>
                                    </button>
                                  );
                                })}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              {activeDetail === 'shift' && selectedShift && (
                <div className="w-72 flex-shrink-0"><ShiftDetail shift={selectedShift} onClose={() => setSelectedShift(null)} /></div>
              )}
              {activeDetail === 'interview' && selectedInterview && (
                <div className="w-72 flex-shrink-0"><InterviewDetail interview={selectedInterview} onClose={() => setSelectedInterview(null)} /></div>
              )}
            </div>
          </div>
        )}

        {/* ── Day view ── */}
        {view === 'day' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <button onClick={() => setDayDate(d => { const n = new Date(d); n.setDate(d.getDate() - 1); return n; })} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500"><ChevronLeft className="w-4 h-4" /></button>
              <button onClick={() => setDayDate(new Date())} className="px-3 py-1.5 text-xs font-semibold bg-primary-600 text-white rounded-lg hover:bg-primary-700">Today</button>
              <button onClick={() => setDayDate(d => { const n = new Date(d); n.setDate(d.getDate() + 1); return n; })} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500"><ChevronRight className="w-4 h-4" /></button>
              <span className="text-sm font-medium text-slate-600 ml-1">
                {dayDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </span>
            </div>
            <div className="flex gap-4">
              <div className="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <div style={{ minWidth: 280 }}>
                    <div className="grid border-b border-slate-200 bg-slate-50" style={{ gridTemplateColumns: '52px 1fr' }}>
                      <div className="border-r border-slate-200" />
                      <div className={`py-3 text-center ${isToday(dayDate) ? 'bg-primary-50' : ''}`}>
                        <p className={`text-xs font-bold uppercase tracking-wide ${isToday(dayDate) ? 'text-primary-500' : 'text-slate-500'}`}>{DAY_ABBR[dayDate.getDay()]}</p>
                        <div className={`mx-auto mt-1 w-8 h-8 flex items-center justify-center rounded-full text-base font-bold ${isToday(dayDate) ? 'bg-primary-600 text-white' : 'text-slate-700'}`}>{dayDate.getDate()}</div>
                      </div>
                    </div>
                    <div className="overflow-y-auto" style={{ maxHeight: 560 }}>
                      <div className="relative" style={{ height: TOTAL_H }}>
                        <div className="absolute inset-0 pointer-events-none" style={{ display: 'grid', gridTemplateColumns: '52px 1fr' }}>
                          <div className="border-r border-slate-200">
                            {HOURS.map(h => (
                              <div key={h} className="border-b border-slate-100 flex items-start justify-end pr-2" style={{ height: CELL_H, paddingTop: 4 }}>
                                <span className="text-xs text-slate-400">{fmtH(h)}</span>
                              </div>
                            ))}
                          </div>
                          <div>{HOURS.map(h => <div key={h} className="border-b border-slate-100" style={{ height: CELL_H }} />)}</div>
                        </div>
                        <div className="absolute inset-0" style={{ display: 'grid', gridTemplateColumns: '52px 1fr' }}>
                          <div />
                          <div className="relative">
                            <AvailBlocks dayKey={DAY_KEYS[dayDate.getDay()]} />
                            {dayShifts.map((shift, si) => {
                              const startH = parseH(shift.startTime);
                              const endH   = parseH(shift.endTime) || startH + 2;
                              const cs = Math.max(startH, H_START), ce = Math.min(endH, H_END);
                              if (ce <= cs) return null;
                              return (
                                <button key={si}
                                  onClick={() => { setSelectedShift(shift); setSelectedInterview(null); }}
                                  className={`absolute rounded-lg border overflow-hidden z-10 text-left hover:brightness-110 transition-all ${statusStyle(shift)}`}
                                  style={{ top: (cs - H_START) * CELL_H + 1, height: (ce - cs) * CELL_H - 2, left: '4px', right: dayInterviews.length > 0 ? '50%' : '4px' }}>
                                  <p className="px-2 pt-1.5 text-sm font-bold text-white leading-tight truncate">{shift.clientName || 'Client'}</p>
                                  <p className="px-2 text-xs text-white/80">{fmt12(shift.startTime)}{shift.endTime ? ` – ${fmt12(shift.endTime)}` : ''}</p>
                                  {shiftDisplayStatus(shift) === 'overdue' && <p className="px-2 text-xs text-white font-semibold mt-0.5">{shiftStatusLabel(shiftDisplayStatus(shift))}</p>}
                                </button>
                              );
                            })}
                            {dayInterviews.map((iv, ii) => {
                              const startH = parseH(iv.startTime);
                              const cs = Math.max(startH, H_START), ce = Math.min(startH + 1, H_END);
                              if (ce <= cs) return null;
                              return (
                                <button key={ii}
                                  onClick={() => { setSelectedInterview(iv); setSelectedShift(null); }}
                                  className={`absolute rounded-lg border overflow-hidden z-10 text-left hover:brightness-110 transition-all ${interviewBlockStyle(iv.status)}`}
                                  style={{ top: (cs - H_START) * CELL_H + 1, height: (ce - cs) * CELL_H - 2, left: dayShifts.length > 0 ? '50%' : '4px', right: '4px' }}>
                                  <p className="px-2 pt-1.5 text-sm font-bold text-white leading-tight truncate">{iv.clientName || 'Interview'}</p>
                                  <p className="px-2 text-xs text-white/80">Interview</p>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              {activeDetail === 'shift' && selectedShift && (
                <div className="w-72 flex-shrink-0"><ShiftDetail shift={selectedShift} onClose={() => setSelectedShift(null)} /></div>
              )}
              {activeDetail === 'interview' && selectedInterview && (
                <div className="w-72 flex-shrink-0"><InterviewDetail interview={selectedInterview} onClose={() => setSelectedInterview(null)} /></div>
              )}
            </div>
          </div>
        )}

        {/* ── Month view ── */}
        {view === 'month' && (
          <div className="grid lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <div className="flex items-center gap-2 mb-4">
                <button onClick={() => setMonthDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500"><ChevronLeft className="w-4 h-4" /></button>
                <h2 className="text-base font-bold text-slate-900 px-1">{MONTH_NAMES[monthDate.getMonth()]} {monthDate.getFullYear()}</h2>
                <button onClick={() => setMonthDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500"><ChevronRight className="w-4 h-4" /></button>
              </div>
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <div className="grid grid-cols-7 gap-1 mb-2">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                    <div key={d} className="text-center text-xs font-bold text-slate-400 py-1">{d}</div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {monthBlanks.map((_, i) => <div key={`b-${i}`} className="h-12" />)}
                  {monthDays.map(d => {
                    const dateStr     = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                    const dayS        = shifts.filter(s => s.date === dateStr);
                    const dayI        = interviews.filter(iv => iv.date === dateStr);
                    const isSel       = selectedDay === dateStr;
                    const isTodayDate = today.toDateString() === new Date(monthDate.getFullYear(), monthDate.getMonth(), d).toDateString();
                    return (
                      <button key={d} onClick={() => setSelectedDay(dateStr)}
                        className={`h-12 rounded-xl flex flex-col items-center justify-start pt-1 text-sm font-medium transition-all ${
                          isSel ? 'bg-primary-600 text-white shadow-sm' : isTodayDate ? 'ring-2 ring-primary-300 text-primary-600' : 'hover:bg-slate-50 text-slate-700'
                        }`}>
                        <span>{d}</span>
                        {(dayS.length > 0 || dayI.length > 0) && (
                          <div className="flex gap-0.5 mt-0.5 flex-wrap justify-center">
                            {dayS.slice(0, 2).map((s, i) => (
                              <span key={`s-${i}`} className={`w-1.5 h-1.5 rounded-full ${isSel ? 'bg-white' : s.status === 'scheduled' ? 'bg-primary-500' : s.status === 'in-progress' ? 'bg-accent-500' : s.status === 'completed' ? 'bg-green-500' : 'bg-rose-600'}`} />
                            ))}
                            {dayI.slice(0, 1).map((_, i) => (
                              <span key={`i-${i}`} className={`w-1.5 h-1.5 rounded-full ${isSel ? 'bg-white' : 'bg-purple-500'}`} />
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {/* If a shift is selected, show the detail panel instead of day summary */}
              {activeDetail === 'shift' && selectedShift && (
                <ShiftDetail shift={selectedShift} onClose={() => setSelectedShift(null)} />
              )}
              {activeDetail === 'interview' && selectedInterview && (
                <InterviewDetail interview={selectedInterview} onClose={() => setSelectedInterview(null)} />
              )}
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h3 className="font-bold text-slate-900 mb-4">
                  {new Date(selectedDay + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                </h3>
                {selectedDateShifts.length === 0 && selectedDateInterviews.length === 0 ? (
                  <div className="text-center py-10 text-slate-400">
                    <CalendarIcon className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm">No events this day</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {selectedDateShifts.map(shift => (
                      <div
                        key={shift.id}
                        onClick={() => { setSelectedShift(shift); setSelectedInterview(null); }}
                        className="border border-slate-200 rounded-xl p-4 cursor-pointer hover:border-primary-300 hover:shadow-sm transition-all"
                      >
                        <div className="flex justify-between items-center mb-2">
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${statusBadge(shift)}`}>
                            {shiftStatusLabel(shiftDisplayStatus(shift))}
                          </span>
                          <span className="text-sm font-bold text-slate-700">{fmt12(shift.startTime)}{shift.endTime ? `–${fmt12(shift.endTime)}` : ''}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center">
                            <User className="w-4 h-4 text-primary-600" />
                          </div>
                          <p className="font-medium text-slate-900 text-sm">{shift.clientName || 'Client'}</p>
                        </div>
                        <p className="text-xs text-primary-500 mt-2 font-medium">Tap to manage →</p>
                      </div>
                    ))}
                    {selectedDateInterviews.map(iv => {
                      const typeLabel   = iv.interviewType === 'phone' ? 'Phone' : iv.interviewType === 'in-person' ? 'In Person' : 'Video';
                      const statusLabel = iv.status === 'requested' ? 'Pending' : iv.status.charAt(0).toUpperCase() + iv.status.slice(1);
                      return (
                        <div key={iv.id} className="border border-purple-200 rounded-xl p-4 bg-purple-50">
                          <div className="flex justify-between items-center mb-2">
                            <span className="text-xs font-semibold px-2 py-0.5 rounded-full border bg-purple-100 text-purple-700 border-purple-200">
                              Interview · {statusLabel}
                            </span>
                            <span className="text-sm font-bold text-slate-700">
                              {new Date(`2000-01-01T${iv.startTime}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center">
                              <Video className="w-4 h-4 text-purple-600" />
                            </div>
                            <div>
                              <p className="font-medium text-slate-900 text-sm">{iv.clientName || iv.jobTitle || 'Client'}</p>
                              <p className="text-xs text-slate-500">{typeLabel}{iv.jobTitle ? ` · ${iv.jobTitle}` : ''}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h3 className="font-bold text-slate-900 mb-3 text-sm">Upcoming</h3>
                <div className="space-y-2">
                  {shifts.filter(s => s.date >= todayStr && s.status === 'scheduled').sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)).slice(0, 4).map(s => (
                    <div key={s.id} className="flex items-center gap-3 p-2.5 bg-slate-50 rounded-xl">
                      <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-sm flex-shrink-0">
                        {new Date(s.date + 'T12:00:00').getDate()}
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-slate-900 text-sm truncate">{s.clientName || 'Client'}</p>
                        <p className="text-xs text-slate-500">{fmt12(s.startTime)}{s.endTime ? ` – ${fmt12(s.endTime)}` : ''}</p>
                      </div>
                    </div>
                  ))}
                  {interviews.filter(iv => iv.date >= todayStr && (iv.status === 'requested' || iv.status === 'accepted')).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)).slice(0, 2).map(iv => (
                    <div key={iv.id} className="flex items-center gap-3 p-2.5 bg-purple-50 rounded-xl">
                      <div className="w-9 h-9 rounded-full bg-purple-100 flex items-center justify-center text-purple-700 font-bold text-sm flex-shrink-0">
                        {new Date(iv.date + 'T12:00:00').getDate()}
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-slate-900 text-sm truncate">{iv.clientName || iv.jobTitle || 'Interview'}</p>
                        <p className="text-xs text-purple-600">Interview · {new Date(`2000-01-01T${iv.startTime}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}</p>
                      </div>
                    </div>
                  ))}
                  {shifts.filter(s => s.date >= todayStr && s.status === 'scheduled').length === 0 &&
                   interviews.filter(iv => iv.date >= todayStr && (iv.status === 'requested' || iv.status === 'accepted')).length === 0 && (
                    <p className="text-xs text-slate-400 text-center py-4">No upcoming events</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── List view ── */}
        {view === 'list' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 flex-wrap">
              {([
                { id: 'all',        label: 'All' },
                { id: 'upcoming',   label: 'Upcoming' },
                { id: 'this-week',  label: 'This Week' },
                { id: 'this-month', label: 'This Month' },
                { id: 'last-30',    label: 'Last 30 Days' },
              ] as const).map(f => (
                <button key={f.id} onClick={() => { setDateFilter(f.id); setExpandedDates({}); }}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${dateFilter === f.id ? 'bg-primary-600 border-primary-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'}`}>
                  {f.label}
                </button>
              ))}
            </div>
            {groupedDates.length === 0 ? (
              <div className="text-center py-16 text-slate-400 bg-white rounded-2xl border border-slate-200">
                <CalendarIcon className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm">No events for this period</p>
              </div>
            ) : (
              <div className="flex gap-4">
                <div className="flex-1 min-w-0 space-y-6">
                  {groupedDates.map(date => {
                    const allEvents = groupedEvents[date];
                    const isDateExpanded = !!expandedDates[date];
                    const visibleEvents = isDateExpanded ? allEvents : allEvents.slice(0, 2);
                    const hiddenCount = allEvents.length - 2;
                    return (
                    <div key={date}>
                      <div className="flex items-center gap-2 mb-2 px-1">
                        <h3 className="text-sm font-bold text-slate-700">
                          {new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                        </h3>
                        {date === todayStr && (
                          <span className="text-xs bg-primary-100 text-primary-700 px-2 py-0.5 rounded-full font-medium">Today</span>
                        )}
                      </div>
                      <div className="space-y-2">
                        {visibleEvents.map((e, i) => {
                          if (e.kind === 'shift') {
                            const s = e.shift;
                            return (
                              <div key={i} onClick={() => { setSelectedShift(s); setSelectedInterview(null); }}
                                className="flex items-center gap-3 p-4 bg-white rounded-xl border border-slate-200 cursor-pointer hover:border-slate-300 hover:shadow-sm transition-all">
                                <div className={`w-1 self-stretch rounded-full flex-shrink-0 ${shiftStatusDotClass(shiftDisplayStatus(s))}`} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${statusBadge(s)}`}>
                                      {shiftStatusLabel(shiftDisplayStatus(s))}
                                    </span>
                                  </div>
                                  <p className="font-medium text-slate-900 text-sm">{s.clientName || 'Client'}</p>
                                  <p className="text-xs text-slate-500 mt-0.5">
                                    {new Date(`2000-01-01T${s.startTime}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                                    {s.endTime ? ` – ${new Date(`2000-01-01T${s.endTime}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}` : ''}
                                  </p>
                                </div>
                                <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
                              </div>
                            );
                          } else {
                            const iv = e.interview;
                            const TypeIcon    = iv.interviewType === 'phone' ? Phone : iv.interviewType === 'in-person' ? Home : Video;
                            const statusLabel = iv.status === 'requested' ? 'Pending' : iv.status.charAt(0).toUpperCase() + iv.status.slice(1);
                            return (
                              <div key={i} onClick={() => { setSelectedInterview(iv); setSelectedShift(null); }}
                                className="flex items-center gap-3 p-4 bg-white rounded-xl border border-purple-200 cursor-pointer hover:border-purple-300 hover:shadow-sm transition-all">
                                <div className="w-1 self-stretch rounded-full flex-shrink-0 bg-purple-500" />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full border bg-purple-100 text-purple-700 border-purple-200">
                                      Interview · {statusLabel}
                                    </span>
                                  </div>
                                  <p className="font-medium text-slate-900 text-sm">{iv.clientName || iv.jobTitle || 'Interview'}</p>
                                  <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
                                    <TypeIcon className="w-3 h-3" />
                                    {new Date(`2000-01-01T${iv.startTime}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                                    {iv.jobTitle ? ` · ${iv.jobTitle}` : ''}
                                  </p>
                                </div>
                                <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
                              </div>
                            );
                          }
                        })}
                      </div>
                      {hiddenCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setExpandedDates(prev => ({ ...prev, [date]: !prev[date] }))}
                          className="w-full mt-1 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-500 hover:text-slate-700 flex items-center justify-center gap-1 transition-colors"
                        >
                          {isDateExpanded
                            ? <><ChevronUp className="w-3.5 h-3.5" /> Show less</>
                            : <><ChevronDown className="w-3.5 h-3.5" /> Show {hiddenCount} more shift{hiddenCount !== 1 ? 's' : ''}</>
                          }
                        </button>
                      )}
                    </div>
                  ); })}
                </div>
                {activeDetail === 'shift' && selectedShift && (
                  <div className="w-72 flex-shrink-0"><ShiftDetail shift={selectedShift} onClose={() => setSelectedShift(null)} /></div>
                )}
                {activeDetail === 'interview' && selectedInterview && (
                  <div className="w-72 flex-shrink-0"><InterviewDetail interview={selectedInterview} onClose={() => setSelectedInterview(null)} /></div>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {/* ── Availability Modal ── */}
      {showAvailModal && createPortal(
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-100">
              <div>
                <h3 className="font-bold text-slate-900">Update Availability</h3>
                <p className="text-xs text-slate-500 mt-0.5">Tap to toggle when you're available</p>
              </div>
              <button onClick={() => setShowAvailModal(false)} className="p-2 hover:bg-slate-100 rounded-xl transition-colors">
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            <div className="p-5 overflow-x-auto">
              <table className="w-full min-w-[420px]">
                <thead>
                  <tr>
                    <th className="w-28 pb-3" />
                    {WEEK_DAYS.map(d => (
                      <th key={d.key} className="pb-3 text-center">
                        <button
                          type="button"
                          onClick={() => {
                            const allOn = TIME_BLOCKS.every(b =>
                              (editAvail[d.key] || []).includes(b.id)
                            );
                            setEditAvail(prev => ({
                              ...prev,
                              [d.key]: allOn ? [] : TIME_BLOCKS.map(b => b.id),
                            }));
                          }}
                          className="text-xs font-bold text-slate-500 hover:text-primary-600 transition-colors"
                        >
                          {d.short}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="space-y-1">
                  {TIME_BLOCKS.map(block => (
                    <tr key={block.id}>
                      <td className="pr-3 py-1.5">
                        <div>
                          <p className="text-xs font-semibold text-slate-700">{block.label}</p>
                          <p className="text-[10px] text-slate-400">{block.hours}</p>
                        </div>
                      </td>
                      {WEEK_DAYS.map(d => {
                        const active = (editAvail[d.key] || []).includes(block.id);
                        return (
                          <td key={d.key} className="py-1.5 px-1 text-center">
                            <button
                              type="button"
                              onClick={() => {
                                setEditAvail(prev => {
                                  const current = prev[d.key] || [];
                                  return {
                                    ...prev,
                                    [d.key]: active
                                      ? current.filter(x => x !== block.id)
                                      : [...current, block.id],
                                  };
                                });
                              }}
                              className={`w-8 h-8 rounded-lg transition-all text-xs font-semibold ${
                                active
                                  ? 'bg-primary-500 text-white shadow-sm'
                                  : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                              }`}
                              aria-label={`${block.label} ${d.short}`}
                            >
                              {active ? '✓' : ''}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-5 pb-5 flex gap-3">
              <button onClick={() => setShowAvailModal(false)} className="flex-1 py-3 rounded-xl border border-slate-200 text-sm font-semibold text-slate-600 hover:bg-slate-50 transition-colors">Cancel</button>
              <button onClick={saveAvailability} disabled={saving} className="flex-1 py-3 rounded-xl bg-primary-500 hover:bg-primary-600 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-60">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Save Availability
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  </>
  );
};
