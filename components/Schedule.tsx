import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Calendar as CalendarIcon, MapPin, User, CheckCircle,
  XCircle, Plus, MessageSquare, ChevronLeft, ChevronRight, DollarSign,
  Video, Phone, Home,
} from 'lucide-react';
import { auth, db } from '../lib/firebase';
import firebase from 'firebase/compat/app';
import { useCareConnex } from '../context/CareConnexContext';
import { ClientNavigation } from './client/ClientNavigation';

interface Shift {
  id: string;
  caregiverId: string;
  caregiverName: string;
  clientId: string;
  date: string;
  startTime: string;
  endTime?: string;
  status: 'scheduled' | 'in-progress' | 'completed' | 'cancelled';
  address: string;
  notes?: string;
  tasksCompleted?: string[];
  createdBy: 'client' | 'caregiver';
  paid?: boolean;
  paidAt?: string;
}

interface InterviewEvent {
  id: string;
  caregiverId: string;
  caregiverName: string;
  clientId: string;
  scheduledTime: string;
  status: 'requested' | 'accepted' | 'in-progress' | 'completed' | 'cancelled' | 'declined';
  interviewType: 'video' | 'phone' | 'in-person';
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

const H_START = 6;
const H_END   = 22;
const CELL_H  = 56;
const TOTAL_H = (H_END - H_START) * CELL_H;
const HOURS   = Array.from({ length: H_END - H_START }, (_, i) => i + H_START);
const DAY_ABBR = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function parseH(t?: string): number {
  if (!t) return 9;
  const [h, m] = t.split(':').map(Number);
  return (h || 0) + (m || 0) / 60;
}

function fmtH(h: number): string {
  const whole = Math.floor(h);
  const mins  = Math.round((h - whole) * 60);
  if (whole === 12) return mins ? `12:${String(mins).padStart(2,'0')}pm` : '12pm';
  if (whole === 0)  return '12am';
  if (whole < 12)   return mins ? `${whole}:${String(mins).padStart(2,'0')}am` : `${whole}am`;
  return mins ? `${whole-12}:${String(mins).padStart(2,'0')}pm` : `${whole-12}pm`;
}

function statusStyle(status: Shift['status']): string {
  switch (status) {
    case 'scheduled':   return 'bg-primary-500 border-primary-600';
    case 'in-progress': return 'bg-accent-500 border-accent-600';
    case 'completed':   return 'bg-slate-400 border-slate-500';
    case 'cancelled':   return 'bg-red-400 border-red-500';
    default:            return 'bg-slate-400 border-slate-500';
  }
}

function statusBadge(status: Shift['status']): string {
  switch (status) {
    case 'scheduled':   return 'bg-primary-100 text-primary-700 border-primary-200';
    case 'in-progress': return 'bg-accent-100 text-accent-700 border-accent-200';
    case 'completed':   return 'bg-green-100 text-green-700 border-green-200';
    case 'cancelled':   return 'bg-red-100 text-red-700 border-red-200';
    default:            return 'bg-slate-100 text-slate-700';
  }
}

function interviewBlockStyle(status: InterviewEvent['status']): string {
  if (status === 'completed') return 'bg-purple-300 border-purple-400';
  if (status === 'cancelled') return 'bg-slate-400 border-slate-500';
  return 'bg-purple-500 border-purple-600';
}

export default function Schedule() {
  const navigate = useNavigate();
  const { addToast } = useCareConnex();

  const [view,       setView]       = useState<'week' | 'month' | 'day' | 'list'>('week');
  const [dateFilter, setDateFilter] = useState<'upcoming' | 'this-week' | 'this-month' | 'last-30' | 'all'>('upcoming');
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthDate,  setMonthDate]  = useState(new Date());
  const [dayDate,    setDayDate]    = useState(new Date());

  const [shifts,     setShifts]     = useState<Shift[]>([]);
  const [interviews, setInterviews] = useState<InterviewEvent[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [caregivers, setCaregivers] = useState<{ id: string; name: string }[]>([]);

  const [selectedShift,     setSelectedShift]     = useState<Shift | null>(null);
  const [selectedInterview, setSelectedInterview] = useState<InterviewEvent | null>(null);
  const [selectedDay,       setSelectedDay]       = useState(localDate(new Date()));
  const [showAddModal,      setShowAddModal]      = useState(false);
  const [newShift, setNewShift] = useState({
    caregiverId: '', date: '', startTime: '09:00', endTime: '13:00', notes: '',
  });

  useEffect(() => { fetchShifts(); }, [monthDate]);
  useEffect(() => { fetchHiredCaregivers(); fetchInterviews(); }, []);

  const fetchShifts = async () => {
    try {
      const user = auth.currentUser;
      if (!user) { navigate('/login'); return; }
      const startDate = new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1);
      const endDate = new Date(monthDate.getFullYear(), monthDate.getMonth() + 2, 0);
      const snap = await db.collection('shifts')
        .where('clientId', '==', user.uid)
        .where('date', '>=', localDate(startDate))
        .where('date', '<=', localDate(endDate))
        .orderBy('date', 'asc')
        .get();
      const list: Shift[] = [];
      snap.forEach(doc => list.push({ id: doc.id, ...doc.data() } as Shift));
      setShifts(list);
    } catch (e) {
      console.error('Error fetching shifts:', e);
    } finally {
      setLoading(false);
    }
  };

  const fetchInterviews = async () => {
    try {
      const user = auth.currentUser;
      if (!user) return;
      const snap = await db.collection('video_interviews')
        .where('clientId', '==', user.uid)
        .get();
      const list: InterviewEvent[] = [];
      snap.forEach(doc => {
        const data = doc.data();
        if (data.status === 'requested' || data.status === 'accepted' || data.status === 'in-progress' || data.status === 'completed') {
          list.push(parseInterview(doc.id, data));
        }
      });
      setInterviews(list);
    } catch (e) {
      console.error('Error fetching interviews for calendar:', e);
    }
  };

  const fetchHiredCaregivers = async () => {
    try {
      const user = auth.currentUser;
      if (!user) return;
      const snap = await db.collection('connections')
        .where('clientId', '==', user.uid)
        .where('status', '==', 'active')
        .get();
      const list: { id: string; name: string }[] = [];
      snap.forEach(doc => list.push({ id: doc.data().caregiverId, name: doc.data().caregiverName }));
      setCaregivers(list);
    } catch (e) { console.error(e); }
  };

  const handleAddShift = async () => {
    try {
      const user = auth.currentUser;
      if (!user) return;
      const cg = caregivers.find(c => c.id === newShift.caregiverId);
      await db.collection('shifts').add({
        clientId: user.uid,
        caregiverId: newShift.caregiverId,
        caregiverName: cg?.name || 'Unknown',
        date: newShift.date, startTime: newShift.startTime, endTime: newShift.endTime,
        status: 'scheduled', address: 'Client Address', notes: newShift.notes,
        tasksCompleted: [], createdBy: 'client',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      await db.collection('notifications').add({
        userId: newShift.caregiverId, type: 'new_shift',
        title: 'New Shift Scheduled',
        message: `New shift on ${newShift.date} at ${newShift.startTime}`,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(), read: false,
      });
      setShowAddModal(false);
      setNewShift({ caregiverId: '', date: '', startTime: '09:00', endTime: '13:00', notes: '' });
      fetchShifts();
    } catch (e) { console.error(e); addToast('Failed to add shift. Please try again.', 'error'); }
  };

  const handleComplete = async (id: string) => {
    await db.collection('shifts').doc(id).update({
      status: 'completed', completedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    setSelectedShift(null);
    fetchShifts();
  };

  const handleCancel = async (id: string) => {
    if (!confirm('Cancel this shift?')) return;
    await db.collection('shifts').doc(id).update({
      status: 'cancelled', cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    setSelectedShift(null);
    fetchShifts();
  };

  const handleMarkPaid = async (id: string) => {
    await db.collection('shifts').doc(id).update({ paid: true, paidAt: new Date().toISOString() });
    setShifts(prev => prev.map(s => s.id === id ? { ...s, paid: true } : s));
    setSelectedShift(prev => prev?.id === id ? { ...prev, paid: true } : prev);
  };

  // ── Week helpers ─────────────────────────────────────────────────────────
  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay() + weekOffset * 7);
  const weekDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });
  const isToday = (d: Date) => d.toDateString() === today.toDateString();

  const shiftsByDay: Record<number, Shift[]> = {};
  shifts.forEach(s => {
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
    : `${MONTH_NAMES[wFirst.getMonth()].slice(0,3)} ${wFirst.getDate()} – ${MONTH_NAMES[wLast.getMonth()].slice(0,3)} ${wLast.getDate()}`;

  // ── Day helpers ──────────────────────────────────────────────────────────
  const dayDateStr    = localDate(dayDate);
  const dayShifts     = shifts.filter(s => s.date === dayDateStr);
  const dayInterviews = interviews.filter(iv => iv.date === dayDateStr);

  // ── Month helpers ────────────────────────────────────────────────────────
  const daysInMonth    = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
  const firstDayOfWeek = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1).getDay();
  const monthBlanks    = Array.from({ length: firstDayOfWeek });
  const monthDays      = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const selectedDateShifts     = shifts.filter(s => s.date === selectedDay);
  const selectedDateInterviews = interviews.filter(iv => iv.date === selectedDay);

  const activeDetail = selectedShift ? 'shift' : selectedInterview ? 'interview' : null;

  // ── List view helpers ────────────────────────────────────────────────────
  type CalEvent =
    | { kind: 'shift';     date: string; startTime: string; shift: Shift }
    | { kind: 'interview'; date: string; startTime: string; interview: InterviewEvent };

  const todayStr = localDate(today);
  const allEvents: CalEvent[] = [
    ...shifts.map(s  => ({ kind: 'shift'     as const, date: s.date,  startTime: s.startTime,  shift: s })),
    ...interviews.map(iv => ({ kind: 'interview' as const, date: iv.date, startTime: iv.startTime, interview: iv })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

  const filteredEvents = allEvents.filter(e => {
    switch (dateFilter) {
      case 'upcoming':    return e.date >= todayStr;
      case 'this-week':   return e.date >= localDate(weekDates[0]) && e.date <= localDate(weekDates[6]);
      case 'this-month': {
        const y = today.getFullYear(), m = today.getMonth();
        const start = `${y}-${String(m+1).padStart(2,'0')}-01`;
        const end   = `${y}-${String(m+1).padStart(2,'0')}-${String(new Date(y, m+1, 0).getDate()).padStart(2,'0')}`;
        return e.date >= start && e.date <= end;
      }
      case 'last-30': {
        const start = localDate(new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000));
        return e.date >= start && e.date <= todayStr;
      }
      case 'all': return true;
      default:    return true;
    }
  });

  const groupedEvents: Record<string, CalEvent[]> = {};
  filteredEvents.forEach(e => {
    if (!groupedEvents[e.date]) groupedEvents[e.date] = [];
    groupedEvents[e.date].push(e);
  });
  const groupedDates = Object.keys(groupedEvents).sort();

  // ── Detail panels ────────────────────────────────────────────────────────
  const ShiftDetail = ({ shift, onClose }: { shift: Shift; onClose: () => void }) => (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
      <div className="flex items-start justify-between mb-4">
        <div>
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${statusBadge(shift.status)}`}>
            {shift.status.replace('-',' ').replace(/\b\w/g, l => l.toUpperCase())}
          </span>
          <h3 className="font-bold text-slate-900 mt-2">{shift.caregiverName}</h3>
          <p className="text-sm text-slate-500">{shift.date} · {shift.startTime}{shift.endTime ? ` – ${shift.endTime}` : ''}</p>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg font-bold">×</button>
      </div>
      <div className="space-y-2 text-sm mb-4">
        <div className="flex items-start gap-2 text-slate-600">
          <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0 text-slate-400" />
          <span>{shift.address}</span>
        </div>
        {shift.notes && <div className="p-3 bg-slate-50 rounded-xl text-slate-600">{shift.notes}</div>}
        {shift.tasksCompleted && shift.tasksCompleted.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {shift.tasksCompleted.map((t, i) => (
              <span key={i} className="text-xs bg-primary-50 text-primary-700 border border-primary-200 px-2 py-0.5 rounded-full">{t}</span>
            ))}
          </div>
        )}
      </div>
      {shift.status === 'scheduled' && (
        <div className="flex gap-2">
          <button onClick={() => handleComplete(shift.id)} className="flex-1 py-2 bg-green-600 text-white text-sm font-semibold rounded-xl hover:bg-green-700">
            <CheckCircle className="w-4 h-4 inline mr-1" />Mark Complete
          </button>
          <button onClick={() => navigate(`/client/inbox?caregiver=${shift.caregiverId}`)} className="px-3 py-2 border border-slate-200 rounded-xl hover:bg-slate-50 text-slate-600">
            <MessageSquare className="w-4 h-4" />
          </button>
          <button onClick={() => handleCancel(shift.id)} className="px-3 py-2 border border-red-200 rounded-xl hover:bg-red-50 text-red-500">
            <XCircle className="w-4 h-4" />
          </button>
        </div>
      )}
      {shift.status === 'completed' && (
        <div className="flex items-center gap-2">
          {shift.paid ? (
            <span className="flex items-center gap-1.5 px-3 py-2 bg-green-50 text-green-700 text-sm font-semibold rounded-xl border border-green-200">
              <CheckCircle className="w-4 h-4" /> Paid
            </span>
          ) : (
            <button onClick={() => handleMarkPaid(shift.id)} className="flex-1 py-2 bg-primary-600 text-white text-sm font-semibold rounded-xl hover:bg-primary-700">
              <DollarSign className="w-4 h-4 inline mr-1" />Mark Paid
            </button>
          )}
          <button onClick={() => navigate(`/client/inbox?caregiver=${shift.caregiverId}`)} className="px-3 py-2 border border-slate-200 rounded-xl hover:bg-slate-50 text-slate-600">
            <MessageSquare className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );

  const InterviewDetail = ({ interview, onClose }: { interview: InterviewEvent; onClose: () => void }) => {
    const TypeIcon = interview.interviewType === 'phone' ? Phone : interview.interviewType === 'in-person' ? Home : Video;
    const typeLabel = interview.interviewType === 'phone' ? 'Phone Call' : interview.interviewType === 'in-person' ? 'In Person' : 'Video Call';
    const statusLabel = interview.status === 'requested' ? 'Pending' : interview.status.charAt(0).toUpperCase() + interview.status.slice(1);
    return (
      <div className="bg-white rounded-2xl border border-purple-100 p-5 shadow-sm">
        <div className="flex items-start justify-between mb-4">
          <div>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full border bg-purple-100 text-purple-700 border-purple-200">
              Interview · {statusLabel}
            </span>
            <h3 className="font-bold text-slate-900 mt-2">{interview.caregiverName}</h3>
            <p className="text-sm text-slate-500">
              {new Date(interview.scheduledTime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              {' · '}
              {new Date(`2000-01-01T${interview.startTime}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg font-bold">×</button>
        </div>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2 text-slate-600">
            <TypeIcon className="w-3.5 h-3.5" /><span>{typeLabel}</span>
          </div>
          {interview.jobTitle && (
            <p className="text-xs text-slate-500">Related to: <span className="font-medium text-slate-700">{interview.jobTitle}</span></p>
          )}
          {interview.notes && <div className="p-3 bg-slate-50 rounded-xl text-slate-600 mt-2 break-words overflow-hidden max-h-24 overflow-y-auto text-xs">{interview.notes}</div>}
        </div>
        <div className="mt-4">
          <button onClick={() => navigate(`/client/inbox?caregiver=${interview.caregiverId}`)} className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-xl hover:bg-slate-50 text-slate-600 text-sm">
            <MessageSquare className="w-4 h-4" /> Message
          </button>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600" />
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <ClientNavigation />

      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-xl font-bold text-slate-900">My Calendar</h1>
              <p className="text-sm text-slate-500">Upcoming care visits and interviews</p>
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
              <button onClick={() => setShowAddModal(true)} className="flex items-center gap-1.5 px-4 py-2 bg-primary-600 text-white rounded-xl text-sm font-semibold hover:bg-primary-700 transition-colors">
                <Plus className="w-4 h-4" />Add Shift
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">

        {/* ── Week view ──────────────────────────────────────────────────── */}
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
                {/* Legend */}
                <div className="flex items-center gap-5 px-4 py-2.5 border-b border-slate-100 bg-slate-50 text-xs text-slate-500 flex-wrap">
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-primary-500 inline-block" />Scheduled</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-accent-500 inline-block" />In Progress</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-slate-400 inline-block" />Completed</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-red-400 inline-block" />Cancelled</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-purple-500 inline-block" />Interviews</span>
                </div>

                <div className="overflow-x-auto">
                  <div style={{ minWidth: 520 }}>
                    {/* Day headers */}
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

                    {/* Time grid */}
                    <div className="overflow-y-auto" style={{ maxHeight: 560 }}>
                      <div className="relative" style={{ height: TOTAL_H }}>
                        {/* Grid lines */}
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

                        {/* Content columns */}
                        <div className="absolute inset-0" style={{ display: 'grid', gridTemplateColumns: '52px repeat(7, 1fr)' }}>
                          <div />
                          {weekDates.map((_, colIdx) => {
                            const colShifts = shiftsByDay[colIdx] || [];
                            const colIvs    = interviewsByDay[colIdx] || [];
                            const hasBoth   = colShifts.length > 0 && colIvs.length > 0;
                            return (
                              <div key={colIdx} className="relative border-r border-slate-200 last:border-r-0">
                                {colShifts.map((shift, si) => {
                                  const startH = parseH(shift.startTime);
                                  const endH   = parseH(shift.endTime) || startH + 2;
                                  const cs = Math.max(startH, H_START), ce = Math.min(endH, H_END);
                                  if (ce <= cs) return null;
                                  return (
                                    <button key={`s-${si}`}
                                      onClick={() => { setSelectedShift(shift); setSelectedInterview(null); }}
                                      className={`absolute rounded-md border overflow-hidden z-10 text-left hover:brightness-110 transition-all ${statusStyle(shift.status)}`}
                                      style={{ top: (cs - H_START) * CELL_H + 1, height: (ce - cs) * CELL_H - 2, left: '2px', right: hasBoth ? '50%' : '2px' }}>
                                      <p className="px-1.5 pt-1 text-xs font-bold text-white leading-tight truncate">{shift.caregiverName.split(' ')[0]}</p>
                                      <p className="px-1.5 text-xs text-white/80">{shift.startTime}{shift.endTime ? ` – ${shift.endTime}` : ''}</p>
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
                                      <p className="px-1.5 pt-1 text-xs font-bold text-white leading-tight truncate">{iv.caregiverName.split(' ')[0]}</p>
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
                <div className="w-72 flex-shrink-0">
                  <ShiftDetail shift={selectedShift} onClose={() => setSelectedShift(null)} />
                </div>
              )}
              {activeDetail === 'interview' && selectedInterview && (
                <div className="w-72 flex-shrink-0">
                  <InterviewDetail interview={selectedInterview} onClose={() => setSelectedInterview(null)} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Day view ───────────────────────────────────────────────────── */}
        {view === 'day' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <button onClick={() => setDayDate(d => { const n=new Date(d); n.setDate(d.getDate()-1); return n; })} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500"><ChevronLeft className="w-4 h-4" /></button>
              <button onClick={() => setDayDate(new Date())} className="px-3 py-1.5 text-xs font-semibold bg-primary-600 text-white rounded-lg hover:bg-primary-700">Today</button>
              <button onClick={() => setDayDate(d => { const n=new Date(d); n.setDate(d.getDate()+1); return n; })} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500"><ChevronRight className="w-4 h-4" /></button>
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
                            {dayShifts.map((shift, si) => {
                              const startH = parseH(shift.startTime);
                              const endH   = parseH(shift.endTime) || startH + 2;
                              const cs = Math.max(startH, H_START), ce = Math.min(endH, H_END);
                              if (ce <= cs) return null;
                              return (
                                <button key={si}
                                  onClick={() => { setSelectedShift(shift); setSelectedInterview(null); }}
                                  className={`absolute rounded-lg border overflow-hidden z-10 text-left hover:brightness-110 transition-all ${statusStyle(shift.status)}`}
                                  style={{ top: (cs - H_START) * CELL_H + 1, height: (ce - cs) * CELL_H - 2, left: '4px', right: dayInterviews.length > 0 ? '50%' : '4px' }}>
                                  <p className="px-2 pt-1.5 text-sm font-bold text-white leading-tight truncate">{shift.caregiverName}</p>
                                  <p className="px-2 text-xs text-white/80">{shift.startTime}{shift.endTime ? ` – ${shift.endTime}` : ''}</p>
                                  {shift.notes && <p className="px-2 text-xs text-white/70 truncate mt-0.5">{shift.notes}</p>}
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
                                  <p className="px-2 pt-1.5 text-sm font-bold text-white leading-tight truncate">{iv.caregiverName}</p>
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

        {/* ── Month view ─────────────────────────────────────────────────── */}
        {view === 'month' && (
          <div className="grid lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <button onClick={() => setMonthDate(d => new Date(d.getFullYear(), d.getMonth()-1, 1))} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500"><ChevronLeft className="w-4 h-4" /></button>
                  <h2 className="text-base font-bold text-slate-900 px-1">{MONTH_NAMES[monthDate.getMonth()]} {monthDate.getFullYear()}</h2>
                  <button onClick={() => setMonthDate(d => new Date(d.getFullYear(), d.getMonth()+1, 1))} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500"><ChevronRight className="w-4 h-4" /></button>
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <div className="grid grid-cols-7 gap-1 mb-2">
                  {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
                    <div key={d} className="text-center text-xs font-bold text-slate-400 py-1">{d}</div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {monthBlanks.map((_, i) => <div key={`b-${i}`} className="h-12" />)}
                  {monthDays.map(d => {
                    const dateStr = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                    const dayS    = shifts.filter(s => s.date === dateStr);
                    const dayI    = interviews.filter(iv => iv.date === dateStr);
                    const isSel   = selectedDay === dateStr;
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
                              <span key={`s-${i}`} className={`w-1.5 h-1.5 rounded-full ${
                                isSel ? 'bg-white' : s.status === 'scheduled' ? 'bg-primary-500' : s.status === 'in-progress' ? 'bg-accent-500' : s.status === 'completed' ? 'bg-green-500' : 'bg-red-400'
                              }`} />
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

            {/* Selected day detail */}
            <div className="space-y-4">
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h3 className="font-bold text-slate-900 mb-4">
                  {new Date(selectedDay + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' })}
                </h3>
                {selectedDateShifts.length === 0 && selectedDateInterviews.length === 0 ? (
                  <div className="text-center py-10 text-slate-400">
                    <CalendarIcon className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm">No events this day</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {selectedDateShifts.map(shift => (
                      <div key={shift.id} className="border border-slate-200 rounded-xl p-4">
                        <div className="flex justify-between items-center mb-2">
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${statusBadge(shift.status)}`}>
                            {shift.status.replace('-',' ').replace(/\b\w/g, l=>l.toUpperCase())}
                          </span>
                          <span className="text-sm font-bold text-slate-700">{shift.startTime}{shift.endTime ? `–${shift.endTime}` : ''}</span>
                        </div>
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center">
                            <User className="w-4 h-4 text-primary-600" />
                          </div>
                          <p className="font-medium text-slate-900 text-sm">{shift.caregiverName}</p>
                        </div>
                        {shift.status === 'scheduled' && (
                          <div className="flex gap-2 mt-3">
                            <button onClick={() => handleComplete(shift.id)} className="flex-1 py-1.5 bg-green-600 text-white text-xs font-semibold rounded-lg hover:bg-green-700">Mark Complete</button>
                            <button onClick={() => handleCancel(shift.id)} className="px-2.5 py-1.5 border border-red-200 text-red-500 rounded-lg hover:bg-red-50 text-xs">Cancel</button>
                          </div>
                        )}
                      </div>
                    ))}
                    {selectedDateInterviews.map(iv => {
                      const typeLabel = iv.interviewType === 'phone' ? 'Phone' : iv.interviewType === 'in-person' ? 'In Person' : 'Video';
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
                              <p className="font-medium text-slate-900 text-sm">{iv.caregiverName}</p>
                              <p className="text-xs text-slate-500">{typeLabel}{iv.jobTitle ? ` · ${iv.jobTitle}` : ''}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Upcoming */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h3 className="font-bold text-slate-900 mb-3 text-sm">Upcoming</h3>
                <div className="space-y-2">
                  {shifts.filter(s => s.date >= localDate(today) && s.status === 'scheduled').sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)).slice(0, 4).map(s => (
                    <div key={s.id} className="flex items-center gap-3 p-2.5 bg-slate-50 rounded-xl">
                      <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-sm flex-shrink-0">
                        {new Date(s.date + 'T12:00:00').getDate()}
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-slate-900 text-sm truncate">{s.caregiverName}</p>
                        <p className="text-xs text-slate-500">{s.startTime}{s.endTime ? ` – ${s.endTime}` : ''}</p>
                      </div>
                    </div>
                  ))}
                  {interviews.filter(iv => iv.date >= localDate(today) && (iv.status === 'requested' || iv.status === 'accepted')).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)).slice(0, 2).map(iv => (
                    <div key={iv.id} className="flex items-center gap-3 p-2.5 bg-purple-50 rounded-xl">
                      <div className="w-9 h-9 rounded-full bg-purple-100 flex items-center justify-center text-purple-700 font-bold text-sm flex-shrink-0">
                        {new Date(iv.date + 'T12:00:00').getDate()}
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-slate-900 text-sm truncate">{iv.caregiverName}</p>
                        <p className="text-xs text-purple-600">Interview · {new Date(`2000-01-01T${iv.startTime}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}</p>
                      </div>
                    </div>
                  ))}
                  {shifts.filter(s => s.date >= localDate(today) && s.status === 'scheduled').length === 0 &&
                   interviews.filter(iv => iv.date >= localDate(today) && (iv.status === 'requested' || iv.status === 'accepted')).length === 0 && (
                    <p className="text-xs text-slate-400 text-center py-4">No upcoming events</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
        {/* ── List view ──────────────────────────────────────────────────── */}
        {view === 'list' && (
          <div className="flex flex-col gap-4">
            {/* Date filter chips */}
            <div className="flex items-center gap-2 flex-wrap">
              {([
                { id: 'all',        label: 'All' },
                { id: 'upcoming',   label: 'Upcoming' },
                { id: 'this-week',  label: 'This Week' },
                { id: 'this-month', label: 'This Month' },
                { id: 'last-30',    label: 'Last 30 Days' },
              ] as const).map(f => (
                <button key={f.id} onClick={() => setDateFilter(f.id)}
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
                  {groupedDates.map(date => (
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
                        {groupedEvents[date].map((e, i) => {
                          if (e.kind === 'shift') {
                            const s = e.shift;
                            return (
                              <div key={i}
                                onClick={() => { setSelectedShift(s); setSelectedInterview(null); }}
                                className="flex items-center gap-3 p-4 bg-white rounded-xl border border-slate-200 cursor-pointer hover:border-slate-300 hover:shadow-sm transition-all">
                                <div className={`w-1 self-stretch rounded-full flex-shrink-0 ${s.status === 'scheduled' ? 'bg-primary-500' : s.status === 'in-progress' ? 'bg-accent-500' : s.status === 'completed' ? 'bg-slate-400' : 'bg-red-400'}`} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${statusBadge(s.status)}`}>
                                      {s.status.replace('-',' ').replace(/\b\w/g, l => l.toUpperCase())}
                                    </span>
                                  </div>
                                  <p className="font-medium text-slate-900 text-sm">{s.caregiverName}</p>
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
                            const TypeIcon = iv.interviewType === 'phone' ? Phone : iv.interviewType === 'in-person' ? Home : Video;
                            const statusLabel = iv.status === 'requested' ? 'Pending' : iv.status.charAt(0).toUpperCase() + iv.status.slice(1);
                            return (
                              <div key={i}
                                onClick={() => { setSelectedInterview(iv); setSelectedShift(null); }}
                                className="flex items-center gap-3 p-4 bg-white rounded-xl border border-purple-200 cursor-pointer hover:border-purple-300 hover:shadow-sm transition-all">
                                <div className="w-1 self-stretch rounded-full flex-shrink-0 bg-purple-500" />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full border bg-purple-100 text-purple-700 border-purple-200">
                                      Interview · {statusLabel}
                                    </span>
                                  </div>
                                  <p className="font-medium text-slate-900 text-sm">{iv.caregiverName}</p>
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
                    </div>
                  ))}
                </div>

                {/* Detail panel */}
                {activeDetail === 'shift' && selectedShift && (
                  <div className="w-72 flex-shrink-0">
                    <ShiftDetail shift={selectedShift} onClose={() => setSelectedShift(null)} />
                  </div>
                )}
                {activeDetail === 'interview' && selectedInterview && (
                  <div className="w-72 flex-shrink-0">
                    <InterviewDetail interview={selectedInterview} onClose={() => setSelectedInterview(null)} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {/* ── Add Shift Modal ───────────────────────────────────────────────── */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl">
            <h3 className="text-lg font-bold text-slate-900 mb-4">Schedule a Shift</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Caregiver</label>
                <select value={newShift.caregiverId} onChange={e => setNewShift({ ...newShift, caregiverId: e.target.value })}
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200">
                  <option value="">Select caregiver</option>
                  {caregivers.map(cg => <option key={cg.id} value={cg.id}>{cg.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Date</label>
                <input type="date" value={newShift.date} onChange={e => setNewShift({ ...newShift, date: e.target.value })}
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Start</label>
                  <input type="time" value={newShift.startTime} onChange={e => setNewShift({ ...newShift, startTime: e.target.value })}
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">End</label>
                  <input type="time" value={newShift.endTime} onChange={e => setNewShift({ ...newShift, endTime: e.target.value })}
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Notes (optional)</label>
                <textarea value={newShift.notes} onChange={e => setNewShift({ ...newShift, notes: e.target.value })}
                  placeholder="Any special instructions…"
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 h-20 resize-none" />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowAddModal(false)} className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={handleAddShift} disabled={!newShift.caregiverId || !newShift.date}
                className="flex-1 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-semibold hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed">
                Add Shift
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
