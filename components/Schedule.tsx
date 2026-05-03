import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Calendar as CalendarIcon, Clock, MapPin, User, CheckCircle,
  XCircle, Plus, MessageSquare, ChevronLeft, ChevronRight, DollarSign,
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
  date: string;          // YYYY-MM-DD
  startTime: string;     // "09:00" 24-h
  endTime?: string;      // "13:00" 24-h
  status: 'scheduled' | 'in-progress' | 'completed' | 'cancelled';
  address: string;
  notes?: string;
  tasksCompleted?: string[];
  createdBy: 'client' | 'caregiver';
  paid?: boolean;
  paidAt?: string;
}

// ── Calendar constants ──────────────────────────────────────────────────────
const H_START = 6;   // 6am
const H_END   = 22;  // 10pm
const CELL_H  = 56;  // px per hour
const TOTAL_H = (H_END - H_START) * CELL_H;
const HOURS   = Array.from({ length: H_END - H_START }, (_, i) => i + H_START);
const DAY_KEYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
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

export default function Schedule() {
  const navigate = useNavigate();
  const { addToast } = useCareConnex();

  // ── View state ────────────────────────────────────────────────────────────
  const [view,       setView]       = useState<'week' | 'month' | 'day'>('week');
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthDate,  setMonthDate]  = useState(new Date());
  const [dayDate,    setDayDate]    = useState(new Date());

  // ── Data state ────────────────────────────────────────────────────────────
  const [shifts,     setShifts]     = useState<Shift[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [caregivers, setCaregivers] = useState<{ id: string; name: string }[]>([]);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [selectedShift,  setSelectedShift]  = useState<Shift | null>(null);
  const [selectedDay,    setSelectedDay]    = useState(new Date().toISOString().split('T')[0]);
  const [showAddModal,   setShowAddModal]   = useState(false);
  const [newShift, setNewShift] = useState({
    caregiverId: '', date: '', startTime: '09:00', endTime: '13:00', notes: '',
  });

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => { fetchShifts(); }, [monthDate]);
  useEffect(() => { fetchHiredCaregivers(); }, []);

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchShifts = async () => {
    try {
      const user = auth.currentUser;
      if (!user) { navigate('/login'); return; }

      const startDate = new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1);
      const endDate = new Date(monthDate.getFullYear(), monthDate.getMonth() + 2, 0);
      const start = startDate.toISOString().split('T')[0];
      const end = endDate.toISOString().split('T')[0];

      const snap = await db.collection('shifts')
        .where('clientId', '==', user.uid)
        .where('date', '>=', start)
        .where('date', '<=', end)
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
    await db.collection('shifts').doc(id).update({
      paid: true,
      paidAt: new Date().toISOString(),
    });
    setShifts(prev => prev.map(s => s.id === id ? { ...s, paid: true } : s));
    setSelectedShift(prev => prev?.id === id ? { ...prev, paid: true } : prev);
  };

  // ── Week helpers ──────────────────────────────────────────────────────────
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
      if (wd.toISOString().split('T')[0] === s.date) {
        if (!shiftsByDay[idx]) shiftsByDay[idx] = [];
        shiftsByDay[idx].push(s);
      }
    });
  });

  const wFirst = weekDates[0], wLast = weekDates[6];
  const weekLabel = wFirst.getMonth() === wLast.getMonth()
    ? `${MONTH_NAMES[wFirst.getMonth()]} ${wFirst.getDate()} – ${wLast.getDate()}, ${wFirst.getFullYear()}`
    : `${MONTH_NAMES[wFirst.getMonth()].slice(0,3)} ${wFirst.getDate()} – ${MONTH_NAMES[wLast.getMonth()].slice(0,3)} ${wLast.getDate()}`;

  // ── Day helpers ───────────────────────────────────────────────────────────
  const dayDateStr = dayDate.toISOString().split('T')[0];
  const dayShifts  = shifts.filter(s => s.date === dayDateStr);

  // ── Month helpers ─────────────────────────────────────────────────────────
  const daysInMonth    = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
  const firstDayOfWeek = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1).getDay();
  const monthBlanks    = Array.from({ length: firstDayOfWeek });
  const monthDays      = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const selectedDateShifts = shifts.filter(s => s.date === selectedDay);

  // ── Shift detail panel ────────────────────────────────────────────────────
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
        {shift.notes && (
          <div className="p-3 bg-slate-50 rounded-xl text-slate-600 text-sm">{shift.notes}</div>
        )}
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
          <button
            onClick={() => handleComplete(shift.id)}
            className="flex-1 py-2 bg-green-600 text-white text-sm font-semibold rounded-xl hover:bg-green-700 transition-colors"
          >
            <CheckCircle className="w-4 h-4 inline mr-1" />Mark Complete
          </button>
          <button
            onClick={() => navigate(`/client/inbox?caregiver=${shift.caregiverId}`)}
            className="px-3 py-2 border border-slate-200 rounded-xl hover:bg-slate-50 text-slate-600"
          >
            <MessageSquare className="w-4 h-4" />
          </button>
          <button
            onClick={() => handleCancel(shift.id)}
            className="px-3 py-2 border border-red-200 rounded-xl hover:bg-red-50 text-red-500"
          >
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
            <button
              onClick={() => handleMarkPaid(shift.id)}
              className="flex-1 py-2 bg-primary-600 text-white text-sm font-semibold rounded-xl hover:bg-primary-700 transition-colors"
            >
              <DollarSign className="w-4 h-4 inline mr-1" />Mark Paid
            </button>
          )}
          <button
            onClick={() => navigate(`/client/inbox?caregiver=${shift.caregiverId}`)}
            className="px-3 py-2 border border-slate-200 rounded-xl hover:bg-slate-50 text-slate-600"
          >
            <MessageSquare className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );

  if (loading) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600" />
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <ClientNavigation />

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-xl font-bold text-slate-900">My Bookings</h1>
              <p className="text-sm text-slate-500">Upcoming and past care visits</p>
            </div>
            <div className="flex items-center gap-2">
              {/* View toggle */}
              <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5">
                {(['day', 'week', 'month'] as const).map(v => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-md capitalize transition-colors ${
                      view === v ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    {v.charAt(0).toUpperCase() + v.slice(1)}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowAddModal(true)}
                className="flex items-center gap-1.5 px-4 py-2 bg-primary-600 text-white rounded-xl text-sm font-semibold hover:bg-primary-700 transition-colors"
              >
                <Plus className="w-4 h-4" />Add Shift
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">

        {/* ── Week view ─────────────────────────────────────────────────── */}
        {view === 'week' && (
          <div className="flex flex-col gap-4">
            {/* Week nav */}
            <div className="flex items-center gap-2">
              <button onClick={() => setWeekOffset(w => w - 1)} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500 transition-colors">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button onClick={() => setWeekOffset(0)} className="px-3 py-1.5 text-xs font-semibold bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors">
                Today
              </button>
              <button onClick={() => setWeekOffset(w => w + 1)} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500 transition-colors">
                <ChevronRight className="w-4 h-4" />
              </button>
              <span className="text-sm font-medium text-slate-600 ml-1">{weekLabel}</span>
            </div>

            <div className="flex gap-4">
              {/* Calendar grid */}
              <div className="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200 overflow-hidden">
                {/* Legend */}
                <div className="flex items-center gap-5 px-4 py-2.5 border-b border-slate-100 bg-slate-50 text-xs text-slate-500 flex-wrap">
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-primary-500 inline-block" />Scheduled</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-accent-500 inline-block" />In Progress</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-slate-400 inline-block" />Completed</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-red-400 inline-block" />Cancelled</span>
                </div>

                <div className="overflow-x-auto">
                  <div style={{ minWidth: 520 }}>
                    {/* Day headers */}
                    <div className="grid border-b border-slate-200 bg-slate-50" style={{ gridTemplateColumns: '52px repeat(7, 1fr)' }}>
                      <div className="border-r border-slate-200" />
                      {weekDates.map((d, i) => (
                        <div key={i} className={`py-2.5 text-center border-r border-slate-200 last:border-r-0 ${isToday(d) ? 'bg-primary-50' : ''}`}>
                          <div className={`text-xs font-bold uppercase tracking-wide ${isToday(d) ? 'text-primary-500' : 'text-slate-500'}`}>
                            {DAY_ABBR[d.getDay()]}
                          </div>
                          <button
                            onClick={() => { setDayDate(d); setView('day'); }}
                            className={`mx-auto mt-1 w-7 h-7 flex items-center justify-center rounded-full text-sm font-bold transition-colors hover:bg-primary-100 ${
                              isToday(d) ? 'bg-primary-600 text-white' : 'text-slate-700'
                            }`}
                          >
                            {d.getDate()}
                          </button>
                        </div>
                      ))}
                    </div>

                    {/* Time grid */}
                    <div className="overflow-y-auto" style={{ maxHeight: 560 }}>
                      <div className="relative" style={{ height: TOTAL_H }}>

                        {/* Background grid lines */}
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
                              {HOURS.map(h => (
                                <div key={h} className="border-b border-slate-100" style={{ height: CELL_H }} />
                              ))}
                            </div>
                          ))}
                        </div>

                        {/* Content columns */}
                        <div className="absolute inset-0" style={{ display: 'grid', gridTemplateColumns: '52px repeat(7, 1fr)' }}>
                          <div /> {/* gutter */}
                          {weekDates.map((_, colIdx) => {
                            const dayShiftsCol = shiftsByDay[colIdx] || [];
                            return (
                              <div key={colIdx} className="relative border-r border-slate-200 last:border-r-0">
                                {dayShiftsCol.map((shift, si) => {
                                  const startH = parseH(shift.startTime);
                                  const endH   = parseH(shift.endTime || undefined) || startH + 2;
                                  const cs     = Math.max(startH, H_START);
                                  const ce     = Math.min(endH,   H_END);
                                  if (ce <= cs) return null;
                                  const top    = (cs - H_START) * CELL_H;
                                  const height = (ce - cs) * CELL_H;
                                  return (
                                    <button
                                      key={si}
                                      onClick={() => setSelectedShift(shift)}
                                      className={`absolute inset-x-0.5 rounded-md border overflow-hidden z-10 text-left hover:brightness-110 transition-all ${statusStyle(shift.status)}`}
                                      style={{ top: top + 1, height: height - 2 }}
                                    >
                                      <p className="px-1.5 pt-1 text-xs font-bold text-white leading-tight truncate">
                                        {shift.caregiverName.split(' ')[0]}
                                      </p>
                                      <p className="px-1.5 text-xs text-white/80 leading-tight">
                                        {shift.startTime}{shift.endTime ? ` – ${shift.endTime}` : ''}
                                      </p>
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

              {/* Detail panel */}
              {selectedShift && (
                <div className="w-72 flex-shrink-0">
                  <ShiftDetail shift={selectedShift} onClose={() => setSelectedShift(null)} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Day view ──────────────────────────────────────────────────── */}
        {view === 'day' && (
          <div className="flex flex-col gap-4">
            {/* Day nav */}
            <div className="flex items-center gap-2">
              <button onClick={() => setDayDate(d => { const n=new Date(d); n.setDate(d.getDate()-1); return n; })} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button onClick={() => setDayDate(new Date())} className="px-3 py-1.5 text-xs font-semibold bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors">
                Today
              </button>
              <button onClick={() => setDayDate(d => { const n=new Date(d); n.setDate(d.getDate()+1); return n; })} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500">
                <ChevronRight className="w-4 h-4" />
              </button>
              <span className="text-sm font-medium text-slate-600 ml-1">
                {dayDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </span>
            </div>

            <div className="flex gap-4">
              <div className="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <div style={{ minWidth: 280 }}>
                    {/* Day header */}
                    <div className="grid border-b border-slate-200 bg-slate-50" style={{ gridTemplateColumns: '52px 1fr' }}>
                      <div className="border-r border-slate-200" />
                      <div className={`py-3 text-center ${isToday(dayDate) ? 'bg-primary-50' : ''}`}>
                        <p className={`text-xs font-bold uppercase tracking-wide ${isToday(dayDate) ? 'text-primary-500' : 'text-slate-500'}`}>
                          {DAY_ABBR[dayDate.getDay()]}
                        </p>
                        <div className={`mx-auto mt-1 w-8 h-8 flex items-center justify-center rounded-full text-base font-bold ${isToday(dayDate) ? 'bg-primary-600 text-white' : 'text-slate-700'}`}>
                          {dayDate.getDate()}
                        </div>
                      </div>
                    </div>
                    {/* Time grid */}
                    <div className="overflow-y-auto" style={{ maxHeight: 560 }}>
                      <div className="relative" style={{ height: TOTAL_H }}>
                        {/* Grid lines */}
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
                        {/* Shift blocks */}
                        <div className="absolute inset-0" style={{ display: 'grid', gridTemplateColumns: '52px 1fr' }}>
                          <div />
                          <div className="relative">
                            {dayShifts.map((shift, si) => {
                              const startH = parseH(shift.startTime);
                              const endH   = parseH(shift.endTime || undefined) || startH + 2;
                              const cs     = Math.max(startH, H_START);
                              const ce     = Math.min(endH,   H_END);
                              if (ce <= cs) return null;
                              const top    = (cs - H_START) * CELL_H;
                              const height = (ce - cs) * CELL_H;
                              return (
                                <button
                                  key={si}
                                  onClick={() => setSelectedShift(shift)}
                                  className={`absolute inset-x-1 rounded-lg border overflow-hidden z-10 text-left hover:brightness-110 transition-all ${statusStyle(shift.status)}`}
                                  style={{ top: top + 1, height: height - 2 }}
                                >
                                  <p className="px-2 pt-1.5 text-sm font-bold text-white leading-tight truncate">{shift.caregiverName}</p>
                                  <p className="px-2 text-xs text-white/80">{shift.startTime}{shift.endTime ? ` – ${shift.endTime}` : ''}</p>
                                  {shift.notes && <p className="px-2 text-xs text-white/70 truncate mt-0.5">{shift.notes}</p>}
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
              {selectedShift && (
                <div className="w-72 flex-shrink-0">
                  <ShiftDetail shift={selectedShift} onClose={() => setSelectedShift(null)} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Month view ────────────────────────────────────────────────── */}
        {view === 'month' && (
          <div className="grid lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              {/* Month nav */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <button onClick={() => setMonthDate(d => new Date(d.getFullYear(), d.getMonth()-1, 1))} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <h2 className="text-base font-bold text-slate-900 px-1">
                    {MONTH_NAMES[monthDate.getMonth()]} {monthDate.getFullYear()}
                  </h2>
                  <button onClick={() => setMonthDate(d => new Date(d.getFullYear(), d.getMonth()+1, 1))} className="p-1.5 rounded-lg hover:bg-white border border-slate-200 text-slate-500">
                    <ChevronRight className="w-4 h-4" />
                  </button>
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
                    const dateStr = new Date(monthDate.getFullYear(), monthDate.getMonth(), d).toISOString().split('T')[0];
                    const dayS    = shifts.filter(s => s.date === dateStr);
                    const isSel   = selectedDay === dateStr;
                    const isTodayDate = today.toDateString() === new Date(monthDate.getFullYear(), monthDate.getMonth(), d).toDateString();
                    return (
                      <button
                        key={d}
                        onClick={() => setSelectedDay(dateStr)}
                        className={`h-12 rounded-xl flex flex-col items-center justify-start pt-1 text-sm font-medium relative transition-all group ${
                          isSel ? 'bg-primary-600 text-white shadow-sm'
                          : isTodayDate ? 'ring-2 ring-primary-300 text-primary-600'
                          : 'hover:bg-slate-50 text-slate-700'
                        }`}
                      >
                        <span>{d}</span>
                        {dayS.length > 0 && (
                          <div className="flex gap-0.5 mt-0.5">
                            {dayS.slice(0, 3).map((s, i) => (
                              <span key={i} className={`w-1.5 h-1.5 rounded-full ${
                                isSel ? 'bg-white'
                                : s.status === 'scheduled' ? 'bg-primary-500'
                                : s.status === 'in-progress' ? 'bg-accent-500'
                                : s.status === 'completed' ? 'bg-green-500'
                                : 'bg-red-400'
                              }`} />
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
                {selectedDateShifts.length === 0 ? (
                  <div className="text-center py-10 text-slate-400">
                    <CalendarIcon className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm">No shifts this day</p>
                    <button onClick={() => setShowAddModal(true)} className="mt-3 text-sm text-primary-600 font-medium hover:underline">
                      + Add Shift
                    </button>
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
                            <button onClick={() => handleComplete(shift.id)} className="flex-1 py-1.5 bg-green-600 text-white text-xs font-semibold rounded-lg hover:bg-green-700">
                              Mark Complete
                            </button>
                            <button onClick={() => handleCancel(shift.id)} className="px-2.5 py-1.5 border border-red-200 text-red-500 rounded-lg hover:bg-red-50 text-xs">
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Upcoming shifts */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h3 className="font-bold text-slate-900 mb-3 text-sm">Upcoming</h3>
                <div className="space-y-2">
                  {shifts
                    .filter(s => s.date >= today.toISOString().split('T')[0] && s.status === 'scheduled')
                    .slice(0, 4)
                    .map(s => (
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
                  {shifts.filter(s => s.date >= today.toISOString().split('T')[0] && s.status === 'scheduled').length === 0 && (
                    <p className="text-xs text-slate-400 text-center py-4">No upcoming shifts</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ── Add Shift Modal ────────────────────────────────────────────────── */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl">
            <h3 className="text-lg font-bold text-slate-900 mb-4">Schedule a Shift</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Caregiver</label>
                <select
                  value={newShift.caregiverId}
                  onChange={e => setNewShift({ ...newShift, caregiverId: e.target.value })}
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200"
                >
                  <option value="">Select caregiver</option>
                  {caregivers.map(cg => <option key={cg.id} value={cg.id}>{cg.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Date</label>
                <input type="date" value={newShift.date}
                  onChange={e => setNewShift({ ...newShift, date: e.target.value })}
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Start</label>
                  <input type="time" value={newShift.startTime}
                    onChange={e => setNewShift({ ...newShift, startTime: e.target.value })}
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">End</label>
                  <input type="time" value={newShift.endTime}
                    onChange={e => setNewShift({ ...newShift, endTime: e.target.value })}
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Notes (optional)</label>
                <textarea value={newShift.notes}
                  onChange={e => setNewShift({ ...newShift, notes: e.target.value })}
                  placeholder="Any special instructions…"
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 h-20 resize-none"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowAddModal(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors">
                Cancel
              </button>
              <button onClick={handleAddShift}
                disabled={!newShift.caregiverId || !newShift.date}
                className="flex-1 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-semibold hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                Add Shift
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
