import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Calendar as CalendarIcon, MapPin, User,
  XCircle, X, Plus, MessageSquare, ChevronLeft, ChevronRight, ChevronDown, ChevronUp,
  Video, Phone, Home, CheckCircle, Loader2, Hourglass,
} from 'lucide-react';
import { auth, db } from '../lib/firebase';
import firebase from 'firebase/compat/app';
import { useCareConnex } from '../context/CareConnexContext';
import { availabilityService } from '../services/availabilityService';
import { ClientNavigation } from './client/ClientNavigation';
import { shiftDisplayStatus, shiftStatusBlockClass, shiftStatusBadgeClass, shiftStatusDotClass, shiftStatusLabel } from '../utils/shiftUtils';

interface Shift {
  id: string;
  caregiverId: string;
  caregiverName: string;
  caregiverPhotoURL?: string | null;
  clientId: string;
  date: string;
  startTime: string;
  endTime?: string;
  status: 'scheduled' | 'in-progress' | 'completed' | 'cancelled';
  address: string;
  notes?: string;
  completionNotes?: string;
  tasksCompleted?: string[];
  careNeeds?: string[];
  careRecipients?: Array<{ name: string; relationship?: string; age?: string; photoURL?: string | null; careNeeds?: string[]; careNeedDetails?: Record<string, string[]> }>;
  startedAt?: any;
  completedAt?: any;
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
function fmtTs(ts: any): string {
  if (!ts) return '';
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  return `${date}, ${time}`;
}
function fmtDuration(start: any, end: any): string {
  if (!start || !end) return '';
  const s = start?.toDate ? start.toDate() : new Date(start);
  const e = end?.toDate   ? end.toDate()   : new Date(end);
  const totalSecs = Math.round((e.getTime() - s.getTime()) / 1000);
  if (totalSecs <= 0) return '';
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const sec = totalSecs % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
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
  if (whole === 0)  return mins ? `12:${String(mins).padStart(2,'0')}am` : '12am';
  if (whole < 12)   return mins ? `${whole}:${String(mins).padStart(2,'0')}am` : `${whole}am`;
  return mins ? `${whole-12}:${String(mins).padStart(2,'0')}pm` : `${whole-12}pm`;
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
  const [caregivers, setCaregivers] = useState<{ id: string; name: string; address?: string; bookingId?: string; schedule?: Record<string, Array<{ start: string; end: string }>> }[]>([]);
  const [pendingAmendments, setPendingAmendments] = useState<Array<{
    id: string; caregiverName: string; newDays: Record<string, Array<{ start: string; end: string }>>; startDate?: string; ongoing?: boolean; endDate?: string;
  }>>([]);

  const [selectedShift,     setSelectedShift]     = useState<Shift | null>(null);
  const [selectedInterview, setSelectedInterview] = useState<InterviewEvent | null>(null);
  const [expandedDates,     setExpandedDates]     = useState<Record<string, boolean>>({});
  const [selectedDay,       setSelectedDay]       = useState(localDate(new Date()));
  const [showAddModal,      setShowAddModal]      = useState(false);
  const [visitCaregiverId,   setVisitCaregiverId]   = useState('');
  const [selectedDays,       setSelectedDays]       = useState<string[]>([]);
  const [dayTimes,           setDayTimes]           = useState<Record<string, Array<{ start: string; end: string }>>>({});
  const [visitNotes,         setVisitNotes]         = useState('');
  const [visitStartDate,     setVisitStartDate]     = useState('');
  const [visitEndOption,     setVisitEndOption]     = useState<'ongoing' | 'end_date'>('ongoing');
  const [visitEndDate,       setVisitEndDate]       = useState('');
  // Day-of-week → time blocks from actual scheduled shifts for the selected caregiver
  const [cgShiftBlocks, setCgShiftBlocks] = useState<Record<string, Array<{ start: string; end: string }>>>({});
  const [cgWeeklyAvail, setCgWeeklyAvail] = useState<Record<string, any[]>>({});
  const [cgBookedSlots, setCgBookedSlots] = useState<Record<string, Array<{s:number;e:number}>>>({});

  useEffect(() => { fetchShifts(); }, [monthDate]);
  useEffect(() => { fetchHiredCaregivers(); fetchInterviews(); generateMissingShifts(); }, []);

  // When the caregiver selection changes in the Request Visit modal,
  // load their upcoming scheduled shifts and build a day-of-week → blocks map.
  // Also load caregiver weeklyAvailability + booked slots summary.
  // Include clientId filter so the query satisfies Firestore security rules.
  useEffect(() => {
    const fdb = db;
    if (!visitCaregiverId || !fdb || !auth) {
      setCgShiftBlocks({});
      setCgWeeklyAvail({});
      setCgBookedSlots({});
      return;
    }
    const user = auth.currentUser;
    if (!user) return;

    // Load caregiver weeklyAvailability + booked slots summary
    Promise.all([
      fdb.collection('caregivers').doc(visitCaregiverId).get().catch(() => null),
      fdb.collection('caregiver_booked_slots').doc(visitCaregiverId).get().catch(() => null),
    ]).then(([cgSnap, bookedSnap]) => {
      if (cgSnap?.exists) setCgWeeklyAvail((cgSnap.data() as any)?.weeklyAvailability || {});
      if (bookedSnap?.exists) setCgBookedSlots((bookedSnap.data() as any)?.slots || {});
    }).catch(() => {});

    // Keep existing cgShiftBlocks logic (the shifts query by clientId + caregiverId)
    const _t = new Date();
    const today = `${_t.getFullYear()}-${String(_t.getMonth()+1).padStart(2,'0')}-${String(_t.getDate()).padStart(2,'0')}`;
    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    fdb.collection('shifts')
      .where('clientId', '==', user.uid)
      .where('caregiverId', '==', visitCaregiverId)
      .where('status', '==', 'scheduled')
      .get()
      .then(snap => {
        const blocks: Record<string, Array<{ start: string; end: string }>> = {};
        snap.docs.forEach(d => {
          const data = d.data();
          if (!data.date || data.date < today) return;
          const dow = DAY_NAMES[new Date(data.date + 'T12:00:00').getDay()];
          if (!blocks[dow]) blocks[dow] = [];
          if (data.startTime && data.endTime) {
            const already = blocks[dow].some(b => b.start === data.startTime && b.end === data.endTime);
            if (!already) blocks[dow].push({ start: data.startTime, end: data.endTime });
          }
        });
        setCgShiftBlocks(blocks);
      })
      .catch(() => setCgShiftBlocks({}));
  }, [visitCaregiverId]);

  // Subscribe to pending booking amendments so client sees "Awaiting response"
  useEffect(() => {
    if (!auth || !db) return;
    const user = auth.currentUser;
    if (!user) return;
    const unsub = db.collection('booking_amendments')
      .where('clientId', '==', user.uid)
      .where('status', '==', 'pending')
      .onSnapshot(
        snap => setPendingAmendments(snap.docs.map(d => ({ id: d.id, ...d.data() } as any))),
        () => {}
      );
    return () => unsub();
  }, []);

  // If no shifts exist for an accepted booking, generate 4 weeks client-side.
  // This runs once on mount and acts as a safety net when the Cloud Function hasn't fired yet.
  const generateMissingShifts = async () => {
    try {
      const fdb = db;
      if (!fdb || !auth) return;
      const user = auth.currentUser;
      if (!user) return;

      const bookingsSnap = await fdb.collection('booking_requests')
        .where('clientId', '==', user.uid)
        .where('status', '==', 'accepted')
        .get();
      if (bookingsSnap.empty) return;

      const ALL_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const normDay = (d: string) => d.trim().charAt(0).toUpperCase() + d.trim().slice(1, 3).toLowerCase();
      const addDays = (dateStr: string, days: number) => {
        const d = new Date(dateStr + 'T12:00:00');
        d.setDate(d.getDate() + days);
        return d.toISOString().split('T')[0];
      };
      const nextOccurrence = (fromDate: string, dayName: string) => {
        const target = ALL_DAYS.indexOf(normDay(dayName));
        if (target === -1) return fromDate;
        const base = new Date(fromDate + 'T12:00:00');
        const diff = (target - base.getDay() + 7) % 7;
        base.setDate(base.getDate() + diff);
        return base.toISOString().split('T')[0];
      };

      const today = new Date().toISOString().split('T')[0];
      const generateTo = addDays(today, 27);

      for (const bookingDoc of bookingsSnap.docs) {
        const booking = bookingDoc.data();
        const bookingId = bookingDoc.id;

        // Check if shifts already exist for this booking
        const existingSnap = await fdb.collection('shifts')
          .where('bookingRequestId', '==', bookingId)
          .where('status', '==', 'scheduled')
          .limit(1)
          .get();
        if (!existingSnap.empty) continue; // already has shifts

        const dayShiftTimes: Record<string, Array<{ start: string; end: string }>> =
          booking.schedule?.dayShiftTimes || {};
        if (Object.keys(dayShiftTimes).length === 0) continue;

        const startDate: string = booking.schedule?.startDate || today;
        const generateFrom = startDate >= today ? startDate : today;
        const endDate: string | null = booking.schedule?.ongoing ? null : (booking.schedule?.endDate || null);
        if (endDate && generateFrom > endDate) continue;

        const shiftBase = {
          clientId: user.uid,
          clientName: booking.clientName || '',
          caregiverId: booking.caregiverId || '',
          caregiverName: booking.caregiverName || '',
          caregiverPhotoURL: booking.caregiverPhotoURL || null,
          status: 'scheduled' as const,
          address: booking.address || '',
          rate: booking.rate ?? null,
          notes: booking.notes || '',
          careRecipients: booking.careRecipients || [],
          bookingRequestId: bookingId,
          recurringWeekly: true,
          tasksCompleted: [],
        };

        const batch = fdb.batch();
        let count = 0;

        Object.entries(dayShiftTimes).forEach(([day, blocks]) => {
          (blocks as Array<{ start: string; end: string }>)
            .filter(b => b.start && b.end)
            .forEach(b => {
              let dateStr = nextOccurrence(generateFrom, day);
              while (dateStr <= generateTo) {
                if (endDate && dateStr > endDate) break;
                if (count < 490) { // stay under Firestore batch limit
                  batch.set(fdb.collection('shifts').doc(), {
                    ...shiftBase,
                    date: dateStr,
                    startTime: b.start,
                    endTime: b.end,
                  });
                  count++;
                }
                dateStr = addDays(dateStr, 7);
              }
            });
        });

        if (count > 0) {
          await batch.commit();
          console.log(`generateMissingShifts: created ${count} shifts for booking ${bookingId}`);
        }
      }

      // Refresh the calendar after generating
      fetchShifts();
    } catch (e) {
      console.error('generateMissingShifts error:', e);
    }
  };

  const fetchShifts = async () => {
    try {
      const fdb = db;
      if (!fdb || !auth) { setLoading(false); return; }
      const user = auth.currentUser;
      if (!user) { navigate('/login'); return; }
      const startDate = new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1);
      const endDate = new Date(monthDate.getFullYear(), monthDate.getMonth() + 2, 0);
      const snap = await fdb.collection('shifts')
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
      const fdb = db;
      if (!fdb || !auth) return;
      const user = auth.currentUser;
      if (!user) return;
      const snap = await fdb.collection('video_interviews')
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
      const fdb = db;
      if (!fdb || !auth) return;
      const user = auth.currentUser;
      if (!user) return;

      // Only include bookings that have at least one scheduled shift —
      // past bookings (all shifts done) are excluded; use Re-book instead.
      const [bookingsSnap, shiftsSnap] = await Promise.all([
        fdb.collection('booking_requests')
          .where('clientId', '==', user.uid)
          .where('status', '==', 'accepted')
          .get(),
        fdb.collection('shifts')
          .where('clientId', '==', user.uid)
          .where('status', '==', 'scheduled')
          .get(),
      ]);

      // Build set of booking IDs that still have scheduled shifts
      const activeBookingIds = new Set<string>();
      shiftsSnap.docs.forEach(d => {
        const bid = d.data().bookingRequestId;
        if (bid) activeBookingIds.add(bid);
      });

      const seen = new Set<string>();
      const list: { id: string; name: string; address?: string; bookingId?: string; schedule?: Record<string, Array<{ start: string; end: string }>> }[] = [];
      bookingsSnap.forEach(doc => {
        const d = doc.data();
        // Skip if booking has no scheduled shifts (effectively past)
        if (!activeBookingIds.has(doc.id)) return;
        if (d.caregiverId && !seen.has(d.caregiverId)) {
          seen.add(d.caregiverId);
          list.push({
            id: d.caregiverId,
            name: d.caregiverName || 'Caregiver',
            address: d.address || '',
            bookingId: doc.id,
            schedule: d.schedule?.dayShiftTimes || {},
          });
        }
      });
      setCaregivers(list);
    } catch (e) { console.error(e); }
  };

  const resetVisitModal = () => {
    setVisitCaregiverId('');
    setSelectedDays([]);
    setDayTimes({});
    setVisitNotes('');
    setVisitStartDate('');
    setVisitEndOption('ongoing');
    setVisitEndDate('');
  };

  const handleAddShift = async () => {
    try {
      const fdb = db;
      if (!fdb || !auth) return;
      const user = auth.currentUser;
      if (!user) return;
      const cg = caregivers.find(c => c.id === visitCaregiverId);

      // Build newDays from selectedDays + dayTimes (each day can have multiple blocks)
      const newDays: Record<string, Array<{ start: string; end: string }>> = {};
      for (const day of selectedDays) {
        const blocks = dayTimes[day] || [];
        const validBlocks = blocks.filter(b => b.start && b.end).map(b => ({
          start: b.start.startsWith('~') ? b.start.slice(1) : b.start,
          end: b.end === '~00:00' ? '00:00' : (b.end.startsWith('~') ? b.end.slice(1) : b.end),
        }));
        if (validBlocks.length === 0) continue;
        newDays[day] = validBlocks;
      }

      const _td2 = new Date();
      const todayStr = `${_td2.getFullYear()}-${String(_td2.getMonth()+1).padStart(2,'0')}-${String(_td2.getDate()).padStart(2,'0')}`;
      const isOngoing = visitEndOption === 'ongoing';

      await fdb.collection('booking_amendments').add({
        bookingRequestId: cg?.bookingId || null,
        clientId: user.uid,
        clientName: user.displayName || '',
        caregiverId: visitCaregiverId,
        caregiverName: cg?.name || 'Unknown',
        status: 'pending',
        type: 'add_recurring_days',
        newDays,
        notes: visitNotes,
        startDate: visitStartDate || todayStr,
        endDate: isOngoing ? null : (visitEndDate || null),
        ongoing: isOngoing,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      const dayList = selectedDays.join(', ');
      const isOneDay = !isOngoing && visitStartDate && visitEndDate && visitStartDate === visitEndDate;
      await fdb.collection('users').doc(visitCaregiverId).collection('notifications').add({
        userId: visitCaregiverId,
        type: 'extra_visit_request',
        title: isOneDay ? 'Extra Visit Requested' : 'Schedule Change Requested',
        message: isOneDay
          ? `Your client requested an extra visit on ${new Date(visitStartDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}.`
          : `Your client wants to add ${dayList} to your regular schedule.`,
        read: false,
        isRead: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      });

      setShowAddModal(false);
      resetVisitModal();
      addToast('Visit request sent — waiting for caregiver to accept.', 'success');
      fetchShifts();
    } catch (e) {
      console.error(e);
      addToast('Failed to send request. Please try again.', 'error');
    }
  };

  const handleCancel = async (id: string) => {
    if (!confirm('Cancel this shift?')) return;
    if (!db) return;
    await db.collection('shifts').doc(id).update({
      status: 'cancelled', cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    setSelectedShift(null);
    fetchShifts();
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
    : `${MONTH_NAMES[wFirst.getMonth()].slice(0,3)} ${wFirst.getDate()} – ${MONTH_NAMES[wLast.getMonth()].slice(0,3)} ${wLast.getDate()}`;

  // ── Day helpers ──────────────────────────────────────────────────────────
  const dayDateStr    = localDate(dayDate);
  const dayShifts     = shifts.filter(s => s.date === dayDateStr && s.status !== 'cancelled');
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
  const ShiftDetail = ({ shift, onClose }: { shift: Shift; onClose: () => void }) => {
    const cgInitials = shift.caregiverName.split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase();
    return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center shrink-0">
            {shift.caregiverPhotoURL
              ? <img src={shift.caregiverPhotoURL} alt={shift.caregiverName} className="w-full h-full object-cover" />
              : <span className="text-sm font-bold text-primary-600">{cgInitials}</span>}
          </div>
          <div>
            <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${statusBadge(shift)}`}>
              {shiftStatusLabel(shiftDisplayStatus(shift))}
            </span>
            <h3 className="font-bold text-slate-900 mt-1">{shift.caregiverName}</h3>
            <p className="text-sm text-slate-500">{shift.date} · {fmt12(shift.startTime)}{shift.endTime ? ` – ${fmt12(shift.endTime)}` : ''}</p>
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg font-bold">×</button>
      </div>
      <div className="space-y-3 text-sm mb-4">
        {/* Address */}
        <div className="flex items-start gap-2 text-slate-600">
          <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0 text-slate-400" />
          <span>{shift.address}</span>
        </div>
        {/* Scheduled + Actual times */}
        <div className="space-y-1">
          <div className="flex items-center gap-3 text-xs">
            <span className="w-20 text-slate-400 shrink-0">Scheduled</span>
            <span className="font-semibold text-slate-700">{fmt12(shift.startTime)}{shift.endTime ? ` – ${fmt12(shift.endTime)}` : ''}</span>
          </div>
          {(shift.startedAt || shift.completedAt) && (() => {
            const s = fmtTs(shift.startedAt), e = fmtTs(shift.completedAt), d = fmtDuration(shift.startedAt, shift.completedAt);
            return (
              <div className="flex items-center gap-3 text-xs">
                <span className="w-20 text-slate-400 shrink-0">Started</span>
                <span className="font-semibold text-slate-700">
                  {s}{e ? <span className="text-slate-400 font-normal"> · Ended </span> : ''}{e}
                  {d && <span className="text-primary-600 font-semibold"> · {d}</span>}
                </span>
              </div>
            );
          })()}
        </div>
        {/* Tasks per recipient — completion state card format */}
        {(() => {
          const doneRaw: string[] = shift.tasksCompleted || [];
          const recipients = shift.careRecipients || [];
          const hasRecipients = recipients.some(r => (r.careNeeds || []).length > 0);
          if (!hasRecipients && (shift.careNeeds || []).length === 0) return null;

          // Compute total/done for header count
          let totalT = 0; let doneT = 0;
          if (hasRecipients) {
            recipients.forEach((r, ri) => {
              (r.careNeeds || []).forEach(cat => {
                const subs = (r.careNeedDetails || {})[cat] || [];
                if (subs.length > 0) { totalT += subs.length; doneT += subs.filter((sub: string) => doneRaw.includes(`${ri}_${cat}_${sub}`)).length; }
                else { totalT += 1; doneT += doneRaw.includes(`${ri}_${cat}`) ? 1 : 0; }
              });
            });
          } else {
            totalT = (shift.careNeeds || []).length;
            doneT = doneRaw.filter((k: string) => (shift.careNeeds || []).includes(k)).length;
          }

          const renderCards = (careNeeds: string[], careNeedDetails: Record<string, string[]>, ri: number) => (
            <div className="space-y-1.5">
              {careNeeds.map((category, ci) => {
                const subtasks = careNeedDetails[category] || [];
                const doneSubCount = subtasks.filter((sub: string) => doneRaw.includes(`${ri}_${category}_${sub}`)).length;
                const catDone = subtasks.length > 0 ? doneSubCount === subtasks.length : doneRaw.includes(`${ri}_${category}`);
                return (
                  <div key={ci} className="border border-slate-200 rounded-xl overflow-hidden">
                    <div className={`flex items-center gap-2 px-3 py-2 ${catDone ? 'bg-green-50' : 'bg-slate-50'}`}>
                      <CheckCircle className={`w-3.5 h-3.5 shrink-0 ${catDone ? 'text-green-500' : 'text-slate-300'}`} />
                      <p className={`text-xs font-semibold flex-1 ${catDone ? 'text-green-700 line-through' : 'text-primary-600'}`}>{category}</p>
                      {subtasks.length > 0 && doneSubCount > 0 && (
                        <span className={`text-[10px] font-semibold ${catDone ? 'text-green-600' : 'text-slate-400'}`}>{doneSubCount}/{subtasks.length}</span>
                      )}
                    </div>
                    {subtasks.length > 0 && (
                      <div className="px-3 py-2 space-y-1">
                        {subtasks.map((sub: string, si: number) => {
                          const done = doneRaw.includes(`${ri}_${category}_${sub}`);
                          return (
                            <div key={si} className={`flex items-center gap-2 text-xs font-medium ${done ? 'text-green-700' : 'text-slate-400'}`}>
                              <CheckCircle className={`w-3.5 h-3.5 flex-shrink-0 ${done ? 'text-green-500' : 'text-slate-300'}`} />
                              {sub}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );

          return (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Tasks</p>
                {totalT > 0 && (
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${doneT === totalT ? 'bg-green-100 text-green-700' : doneT > 0 ? 'bg-slate-100 text-slate-500' : 'bg-slate-100 text-slate-500'}`}>
                    {doneT}/{totalT}
                  </span>
                )}
              </div>
              {hasRecipients
                ? recipients.map((r, ri) => {
                    const needs = r.careNeeds || [];
                    if (needs.length === 0) return null;
                    return (
                      <div key={ri} className="mb-3">
                        {(
                          <div className="flex items-center gap-2 mb-1.5">
                            <div className="w-6 h-6 rounded-full overflow-hidden bg-primary-100 shrink-0 flex items-center justify-center">
                              {r.photoURL
                                ? <img src={r.photoURL} alt={r.name} className="w-full h-full object-cover" />
                                : <span className="text-[9px] font-bold text-primary-600">{r.name.split(' ').map((p: string) => p[0]).join('').slice(0,2).toUpperCase()}</span>}
                            </div>
                            <p className="text-xs font-semibold text-slate-600">{r.name}{r.relationship ? ` · ${r.relationship}` : ''}{r.age ? ` · Age ${r.age}` : ''}</p>
                          </div>
                        )}
                        {renderCards(needs, r.careNeedDetails || {}, ri)}
                      </div>
                    );
                  })
                : renderCards(shift.careNeeds || [], {}, 0)}
            </div>
          );
        })()}
        {/* Notes */}
        {shift.notes && <div className="p-3 bg-slate-50 rounded-xl text-slate-600 text-xs">{shift.notes}</div>}
        {shift.completionNotes && (
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Shift Notes</p>
            <p className="text-xs text-slate-600">{shift.completionNotes}</p>
          </div>
        )}
      </div>
      {shift.status === 'scheduled' && (
        <div className="flex gap-2">
          <button onClick={() => navigate(`/client/inbox?caregiver=${shift.caregiverId}`)} className="flex-1 py-2 border border-slate-200 rounded-xl hover:bg-slate-50 text-slate-600 text-sm font-medium flex items-center justify-center gap-1.5">
            <MessageSquare className="w-4 h-4" />Message
          </button>
          <button onClick={() => handleCancel(shift.id)} className="flex-1 py-2 border border-red-200 rounded-xl hover:bg-red-50 text-red-500 text-sm font-medium flex items-center justify-center gap-1.5">
            <XCircle className="w-4 h-4" />Cancel
          </button>
        </div>
      )}
      {shift.status === 'completed' && (
        <div className="flex items-center gap-2">
          <button onClick={() => navigate(`/client/inbox?caregiver=${shift.caregiverId}`)} className="flex-1 py-2 border border-slate-200 rounded-xl hover:bg-slate-50 text-slate-600 text-sm font-medium flex items-center justify-center gap-1.5">
            <MessageSquare className="w-4 h-4" />Message
          </button>
        </div>
      )}
    </div>
  );
  };

  const InterviewDetail = ({ interview, onClose }: { interview: InterviewEvent; onClose: () => void }) => {
    const [job, setJob]             = useState<any>(null);
    const [cancelling, setCancelling] = useState(false);

    const TypeIcon  = interview.interviewType === 'phone' ? Phone : interview.interviewType === 'in-person' ? Home : Video;
    const typeLabel = interview.interviewType === 'phone' ? 'Phone Call' : interview.interviewType === 'in-person' ? 'In Person' : 'Video Call';
    const statusLabel = interview.status === 'requested' ? 'Pending'
      : interview.status === 'in-progress' ? 'In Progress'
      : interview.status.charAt(0).toUpperCase() + interview.status.slice(1);
    const statusColor = interview.status === 'completed'   ? 'bg-green-100 text-green-700 border-green-200'
      : interview.status === 'cancelled' || interview.status === 'declined' ? 'bg-slate-100 text-slate-500 border-slate-200'
      : interview.status === 'in-progress' ? 'bg-orange-100 text-orange-700 border-orange-200'
      : 'bg-purple-100 text-purple-700 border-purple-200';

    const initials = interview.caregiverName.split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase();

    useEffect(() => {
      if (!interview.jobId || !db) return;
      db.collection('job_posts').doc(interview.jobId).get()
        .then(doc => { if (doc.exists) setJob(doc.data()); })
        .catch(() => {});
    }, [interview.jobId]);

    const handleCancel = async () => {
      if (!window.confirm('Cancel this interview?')) return;
      if (!db) return;
      const fdb = db;
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
    const freq:      string | undefined = job?.jobFrequency;
    const rate:      number | undefined = job?.rate;
    const location:  string | null = job?.location || (job?.city ? [job.city, job.state].filter(Boolean).join(', ') : null);

    return (
      <div className="bg-white rounded-2xl border border-purple-100 p-5 shadow-sm">
        {/* Header: avatar + name + status */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full overflow-hidden bg-purple-100 flex items-center justify-center shrink-0">
              {(interview as any).caregiverPhoto
                ? <img src={(interview as any).caregiverPhoto} alt={interview.caregiverName} className="w-full h-full object-cover" />
                : <span className="text-sm font-bold text-purple-600">{initials}</span>}
            </div>
            <div>
              <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${statusColor}`}>
                Interview · {statusLabel}
              </span>
              <h3 className="font-bold text-slate-900 mt-1">{interview.caregiverName}</h3>
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
          {/* Join Call for video + accepted/in-progress */}
          {interview.interviewType === 'video' && (interview.status === 'accepted' || interview.status === 'in-progress') && (
            <button onClick={() => navigate('/client/video')}
              className="w-full py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-1.5">
              <Video className="w-4 h-4" /> Join Call
            </button>
          )}
          <div className="flex gap-2">
            <button onClick={() => navigate('/client/inbox')}
              className="flex-1 py-2 border border-slate-200 rounded-xl hover:bg-slate-50 text-slate-600 text-sm flex items-center justify-center gap-1.5">
              <MessageSquare className="w-4 h-4" /> Message
            </button>
            {(interview.status === 'requested' || interview.status === 'accepted') && (
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
              {caregivers.length > 0 && (
                <button onClick={() => setShowAddModal(true)} className="flex items-center gap-1.5 px-4 py-2 bg-primary-600 text-white rounded-xl text-sm font-semibold hover:bg-primary-700 transition-colors">
                  <Plus className="w-4 h-4" />Request Visit
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">

        {/* ── Shared legend (all views) ─────────────────────────────────── */}
        <div className="flex items-center gap-5 px-4 py-2.5 mb-4 bg-white rounded-xl border border-slate-200 text-xs text-slate-500 flex-wrap">
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-primary-500 inline-block" />Scheduled</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-accent-500 inline-block" />In Progress</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-yellow-400 inline-block" />Late</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-orange-400 inline-block" />Overdue</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-slate-400 inline-block" />Completed</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-rose-600 inline-block" />Cancelled</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-purple-500 inline-block" />Interviews</span>
        </div>

        {/* ── Pending visit requests (awaiting caregiver response) ───────── */}
        {pendingAmendments.length > 0 && (
          <div className="mb-4 space-y-2">
            {pendingAmendments.map(a => {
              const fmt12 = (t: string) => {
                const [hStr, mStr] = (t || '').split(':');
                const h = parseInt(hStr, 10);
                const m = parseInt(mStr || '0', 10);
                if (isNaN(h)) return t;
                const ampm = h >= 12 ? 'PM' : 'AM';
                const h12 = h % 12 || 12;
                return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
              };
              const dayList = Object.entries(a.newDays || {})
                .map(([day, blocks]) =>
                  `${day} ${(blocks as Array<{start:string;end:string}>).map(b => `${fmt12(b.start)}–${fmt12(b.end)}`).join(', ')}`
                ).join(' · ');
              return (
                <div key={a.id} className="bg-amber-50 rounded-xl border border-amber-200 p-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center shrink-0">
                      <Hourglass className="w-5 h-5 text-amber-600" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900 text-sm truncate">{a.caregiverName}</p>
                      <p className="text-xs text-slate-500 truncate">{dayList}</p>
                    </div>
                  </div>
                  <span className="text-xs font-semibold text-amber-700 bg-amber-100 border border-amber-200 px-2 py-1 rounded-lg shrink-0 whitespace-nowrap">
                    Awaiting response
                  </span>
                </div>
              );
            })}
          </div>
        )}

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
                                      className={`absolute rounded-md border overflow-hidden z-10 text-left hover:brightness-110 transition-all ${statusStyle(shift)}`}
                                      style={{ top: (cs - H_START) * CELL_H + 1, height: (ce - cs) * CELL_H - 2, left: '2px', right: hasBoth ? '50%' : '2px' }}>
                                      <p className="px-1.5 pt-1 text-xs font-bold text-white leading-tight truncate">{shift.caregiverName.split(' ')[0]}</p>
                                      <p className="px-1.5 text-xs text-white/80">{fmt12(shift.startTime)}{shift.endTime ? ` – ${fmt12(shift.endTime)}` : ''}</p>
                                      {(shiftDisplayStatus(shift) === 'overdue' || shiftDisplayStatus(shift) === 'late') && <p className="px-1.5 text-xs text-white font-semibold">{shiftStatusLabel(shiftDisplayStatus(shift))}</p>}
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
                                  className={`absolute rounded-lg border overflow-hidden z-10 text-left hover:brightness-110 transition-all ${statusStyle(shift)} ${shift.status === 'in-progress' ? 'ring-2 ring-white ring-opacity-60' : ''}`}
                                  style={{ top: (cs - H_START) * CELL_H + 1, height: (ce - cs) * CELL_H - 2, left: '4px', right: dayInterviews.length > 0 ? '50%' : '4px' }}>
                                  <p className="px-2 pt-1.5 text-sm font-bold text-white leading-tight truncate">{shift.caregiverName}</p>
                                  <p className="px-2 text-xs text-white/80">{fmt12(shift.startTime)}{shift.endTime ? ` – ${fmt12(shift.endTime)}` : ''}</p>
                                  {(shiftDisplayStatus(shift) === 'overdue' || shiftDisplayStatus(shift) === 'late') && <p className="px-2 text-xs text-white font-semibold mt-0.5">{shiftStatusLabel(shiftDisplayStatus(shift))}</p>}
                                  {shift.status === 'in-progress' && <p className="px-2 text-xs text-white font-semibold mt-0.5">In Progress</p>}
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
                                isSel ? 'bg-white' : s.status === 'scheduled' ? 'bg-primary-500' : s.status === 'in-progress' ? 'bg-accent-500' : s.status === 'completed' ? 'bg-green-500' : 'bg-rose-600'
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
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${statusBadge(shift)}`}>
                            {shiftStatusLabel(shiftDisplayStatus(shift))}
                          </span>
                          <span className="text-sm font-bold text-slate-700">{fmt12(shift.startTime)}{shift.endTime ? `–${fmt12(shift.endTime)}` : ''}</span>
                        </div>
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center">
                            <User className="w-4 h-4 text-primary-600" />
                          </div>
                          <p className="font-medium text-slate-900 text-sm">{shift.caregiverName}</p>
                        </div>
                        {shift.status === 'scheduled' && (
                          <div className="flex gap-2 mt-3">
                            <button onClick={() => navigate(`/client/inbox?caregiver=${shift.caregiverId}`)} className="flex-1 py-1.5 border border-slate-200 text-slate-600 text-xs font-medium rounded-lg hover:bg-slate-50">Message</button>
                            <button onClick={() => handleCancel(shift.id)} className="flex-1 py-1.5 border border-red-200 text-red-500 rounded-lg hover:bg-red-50 text-xs">Cancel</button>
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
                        <p className="text-xs text-slate-500">{fmt12(s.startTime)}{s.endTime ? ` – ${fmt12(s.endTime)}` : ''}</p>
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
                              <div key={i}
                                onClick={() => { setSelectedShift(s); setSelectedInterview(null); }}
                                className="flex items-center gap-3 p-4 bg-white rounded-xl border border-slate-200 cursor-pointer hover:border-slate-300 hover:shadow-sm transition-all">
                                <div className={`w-1 self-stretch rounded-full flex-shrink-0 ${shiftStatusDotClass(shiftDisplayStatus(s))}`} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${statusBadge(s)}`}>
                                      {shiftStatusLabel(shiftDisplayStatus(s))}
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

      {/* ── Request Extra Visit Modal ─────────────────────────────────────── */}
      {showAddModal && (() => {
        const selectedCg = caregivers.find(c => c.id === visitCaregiverId);
        const schedule = selectedCg?.schedule || {};
        const DAY_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const VISIT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

        // ── Availability helpers ──────────────────────────────────────────
        const DAY_NAME_TO_IDX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        const getNextDateForDay = (dayName: string, fromDateStr: string): Date | null => {
          if (!fromDateStr) return null;
          const fromDate = new Date(fromDateStr + 'T12:00:00');
          const targetDow = DAY_NAME_TO_IDX[dayName];
          if (targetDow === undefined) return null;
          const diff = (targetDow - fromDate.getDay() + 7) % 7;
          const result = new Date(fromDate);
          result.setDate(result.getDate() + diff);
          return result;
        };

        // Days whose requested times fall outside the caregiver's weekly availability
        const weeklyUnavailableDays: string[] = selectedCg ? selectedDays.filter(day => {
          const blocks = dayTimes[day] || [];
          return blocks.some(b => {
            if (!b.start || !b.end) return false;
            const checkDate = getNextDateForDay(day, visitStartDate);
            if (!checkDate) return false;
            const [sh, sm] = b.start.split(':').map(Number);
            const end = b.end === '~00:00' ? '00:00' : (b.end.startsWith('~') ? b.end.slice(1) : b.end);
            const [eh, em] = end.split(':').map(Number);
            const durationHours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
            if (durationHours <= 0) return false;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return !availabilityService.checkWeeklyAvailability(selectedCg as any, checkDate, b.start, durationHours);
          });
        }) : [];
        const scheduledDays = DAY_ORDER.filter(d => schedule[d]?.some(b => b.start && b.end));
        // Merge regular schedule blocks + actual shift blocks for overlap checking
        const allBlocksForDay = (day: string) => {
          const schedBlocks = (schedule[day] || []).filter(b => b.start && b.end);
          const shiftBlocks = (cgShiftBlocks[day] || []).filter(b => b.start && b.end);
          // Deduplicate
          const seen = new Set<string>();
          return [...schedBlocks, ...shiftBlocks].filter(b => {
            const key = `${b.start}-${b.end}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        };

        // Check if a proposed [newStart, newEnd) overlaps any existing block for that day
        const hasOverlap = (day: string, newStart: string, newEnd: string) => {
          const [nsh, nsm] = newStart.split(':').map(Number);
          const [neh, nem] = newEnd.split(':').map(Number);
          const ns = nsh * 60 + nsm, ne = neh * 60 + nem;
          return allBlocksForDay(day).some(b => {
            const [bsh, bsm] = b.start.split(':').map(Number);
            const [beh, bem] = b.end.split(':').map(Number);
            const bs = bsh * 60 + bsm, be = beh * 60 + bem;
            return ns < be && ne > bs;
          });
        };

        const overlappingDays = selectedDays.filter(day => {
          const blocks = dayTimes[day] || [];
          return blocks.some(b => b.start && b.end && hasOverlap(day, b.start.startsWith('~') ? b.start.slice(1) : b.start, b.end === '~00:00' ? '00:00' : (b.end.startsWith('~') ? b.end.slice(1) : b.end)));
        });

        const canSubmit =
          !!visitCaregiverId &&
          selectedDays.length > 0 &&
          selectedDays.every(day => (dayTimes[day] || []).some(b => b.start && b.end)) &&
          !!visitStartDate &&
          (visitEndOption === 'ongoing' || !!visitEndDate) &&
          overlappingDays.length === 0 &&
          weeklyUnavailableDays.length === 0;

        // ── Availability helpers (same as booking modal) ──────────────────────
        const ABBR_TO_FULL: Record<string,string> = { Sun:'sunday', Mon:'monday', Tue:'tuesday', Wed:'wednesday', Thu:'thursday', Fri:'friday', Sat:'saturday' };
        const BLOCK_MINS: Record<string, {s:number;e:number}> = { morning:{s:360,e:720}, afternoon:{s:720,e:1080}, evening:{s:1080,e:1380}, overnight:{s:1380,e:360} };
        const TIME_OPTS = Array.from({ length: 96 }, (_, i) => { const h = Math.floor(i / 4), m = (i % 4) * 15; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`; });
        const toMin = (t: string) => { const [h, m] = (t || '00:00').split(':').map(Number); return h * 60 + m; };
        const stripNextDay = (t: string) => t.startsWith('~') ? t.slice(1) : t;
        const blockEndMin = (end: string) => end === '~00:00' ? 1440 : toMin(stripNextDay(end));
        const fmtTimeOpt = (t: string) => {
          if (!t) return '';
          const raw = t.startsWith('~') ? t.slice(1) : t;
          const [hh, mm] = raw.split(':').map(Number);
          const ap = hh < 12 ? 'AM' : 'PM';
          const h12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
          return `${h12}:${String(mm).padStart(2,'0')} ${ap}`;
        };
        const hasWeeklyAvail = Object.keys(cgWeeklyAvail).length > 0;
        const hasShiftBlocks = Object.keys(cgShiftBlocks).length > 0;
        const hasCgAvail = hasWeeklyAvail || hasShiftBlocks;
        const getDaySlots = (abbr: string): Array<{s:number;e:number}> => {
          // Prefer caregiver's self-reported weeklyAvailability; fall back to their existing shift schedule
          if (hasWeeklyAvail) {
            const full = ABBR_TO_FULL[abbr] || abbr.toLowerCase();
            const raw: any[] = cgWeeklyAvail[full] || [];
            const result: {s:number;e:number}[] = [];
            for (const sl of raw) {
              let s: number, e: number;
              if (typeof sl === 'string') {
                const bm = BLOCK_MINS[sl]; if (!bm) continue;
                s = bm.s; e = bm.e;
              } else {
                if (!sl?.start) continue;
                s = toMin(sl.start); e = toMin(sl.end);
              }
              if (e > 0 && e <= s) {
                result.push({s, e: 1440});
                result.push({s: 0, e});
              } else {
                result.push({s, e: e > 0 ? e : 1440});
              }
            }
            return result;
          }
          // Fall back to cgShiftBlocks (the caregiver's regular recurring schedule with this client)
          return (cgShiftBlocks[abbr] || []).map(b => ({ s: toMin(b.start), e: toMin(b.end) }));
        };
        const isDayAvailable = (abbr: string) => !hasCgAvail || getDaySlots(abbr).length > 0;
        const availTimeOpts = (abbr: string, extraBusy: Array<{s:number;e:number}> = []) => {
          const allBusy = [...(cgBookedSlots[abbr] || []), ...extraBusy];
          return TIME_OPTS.filter(t => !allBusy.some(b => toMin(t) >= b.s && toMin(t) < b.e));
        };
        const availEndOpts = (abbr: string, startT: string, extraBusy: Array<{s:number;e:number}> = []) => {
          const startM = startT ? toMin(startT) : 0;
          const allBusy = [...(cgBookedSlots[abbr] || []), ...extraBusy];
          const sameDayOpts = TIME_OPTS.filter(t => {
            if (startT && t <= startT) return false;
            const eM = toMin(t);
            if (allBusy.some(b => b.s < eM && b.e > startM)) return false;
            return true;
          });
          const nextDayOpts = allBusy.some(b => b.s < 1440 && b.e > startM) ? [] : ['~00:00'];
          return [...sameDayOpts, ...nextDayOpts];
        };
        const otherBlocksBusy = (abbr: string, excludeIdx: number): Array<{s:number;e:number}> =>
          (dayTimes[abbr] || [])
            .filter((b, i) => i !== excludeIdx && b.start && b.end)
            .map(b => ({ s: toMin(stripNextDay(b.start)), e: blockEndMin(b.end) }));
        const isBlockOutsidePreferred = (abbr: string, start: string, end: string) => {
          if (!hasCgAvail) return false;
          const slots = getDaySlots(abbr);
          if (slots.length === 0) return true; // day not in preferred schedule at all
          const inSlot = (m: number) => slots.some(sl => m >= sl.s && m <= sl.e);
          if (start && !inSlot(toMin(start))) return true;
          if (end && !inSlot(end === '~00:00' ? 1440 : toMin(stripNextDay(end)))) return true;
          return false;
        };
        const calcDayHours = (blocks: Array<{start:string;end:string}>) =>
          blocks.filter(b => b.start && b.end).reduce((sum, b) => {
            const s = toMin(stripNextDay(b.start));
            const e = blockEndMin(b.end);
            return sum + Math.max(0, e - s) / 60;
          }, 0);
        const fmtHours = (h: number) => h === 0 ? '' : `${h % 1 === 0 ? h : h.toFixed(2)}h`;
        const mergeIvs = (ivs: Array<{s:number;e:number}>) => {
          if (!ivs.length) return [];
          const sorted = [...ivs].sort((a,b) => a.s - b.s);
          const out = [{ ...sorted[0] }];
          for (let i = 1; i < sorted.length; i++) {
            const last = out[out.length - 1];
            if (sorted[i].s <= last.e) last.e = Math.max(last.e, sorted[i].e);
            else out.push({ ...sorted[i] });
          }
          return out;
        };
        const fmtM = (m: number) => {
          const h = Math.floor(m / 60) % 24;
          const mn = m % 60;
          const dh = h === 0 ? 12 : h > 12 ? h - 12 : h;
          const p = h >= 12 ? 'pm' : 'am';
          return mn === 0 ? `${dh}${p}` : `${dh}:${String(mn).padStart(2,'0')}${p}`;
        };
        return (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl max-h-[90vh] flex flex-col">

              {/* Header */}
              <div className="px-6 pt-6 pb-4 border-b border-slate-100 shrink-0">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">Request Visit</h3>
                    <p className="text-xs text-slate-400 mt-0.5">Add a visit outside your regular schedule</p>
                  </div>
                  <button onClick={() => { setShowAddModal(false); resetVisitModal(); }}
                    className="text-slate-400 hover:text-slate-600 p-1 -mr-1 -mt-1 text-xl font-bold leading-none">×</button>
                </div>
              </div>

              {/* Scrollable body */}
              <div className="overflow-y-auto flex-1 px-6 py-4 space-y-5">

                {/* Caregiver */}
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Caregiver</label>
                  <select value={visitCaregiverId} onChange={e => setVisitCaregiverId(e.target.value)}
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 bg-white">
                    <option value="">Select caregiver</option>
                    {caregivers.map(cg => <option key={cg.id} value={cg.id}>{cg.name}</option>)}
                  </select>
                </div>

                {visitCaregiverId && <>

                {/* Schedule dates */}
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Schedule</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">Start date</label>
                      <input
                        type="date"
                        value={visitStartDate}
                        onChange={e => { const _n = new Date(); const _min = `${_n.getFullYear()}-${String(_n.getMonth()+1).padStart(2,'0')}-${String(_n.getDate()).padStart(2,'0')}`; const v = e.target.value; setVisitStartDate(v && v < _min ? _min : v); }}
                        min={(() => { const _n = new Date(); return `${_n.getFullYear()}-${String(_n.getMonth()+1).padStart(2,'0')}-${String(_n.getDate()).padStart(2,'0')}`; })()}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 bg-white"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">End date</label>
                      <input
                        type="date"
                        value={visitEndDate}
                        onChange={e => {
                          setVisitEndDate(e.target.value);
                          if (e.target.value) setVisitEndOption('end_date');
                        }}
                        min={visitStartDate || (() => { const _n = new Date(); return `${_n.getFullYear()}-${String(_n.getMonth()+1).padStart(2,'0')}-${String(_n.getDate()).padStart(2,'0')}`; })()}
                        disabled={visitEndOption === 'ongoing'}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 bg-white disabled:bg-slate-50 disabled:text-slate-400"
                      />
                      <label className="flex items-center gap-1.5 mt-1.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={visitEndOption === 'ongoing'}
                          onChange={e => {
                            setVisitEndOption(e.target.checked ? 'ongoing' : 'end_date');
                            if (e.target.checked) setVisitEndDate('');
                          }}
                          className="w-3.5 h-3.5 accent-primary-600"
                        />
                        <span className="text-xs text-slate-500">Ongoing</span>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Shift times per day */}
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Shift times per day</p>

                  {selectedDays.length === 0 ? (
                    <p className="text-xs text-slate-400 italic mb-2">No days added yet.</p>
                  ) : (
                    <div className="space-y-2 mb-3">
                      {selectedDays.map(day => {
                        const blocks = dayTimes[day] || [];
                        return (
                          <div key={day} className="space-y-1">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                                <span>{day}</span>
                                {fmtHours(calcDayHours(blocks)) && <span className="text-primary-600">{fmtHours(calcDayHours(blocks))}</span>}
                                {overlappingDays.includes(day) && (
                                  <span className="text-[10px] font-semibold text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-full flex items-center gap-0.5"><span>⚠</span> Overlaps existing shift</span>
                                )}
                                {!overlappingDays.includes(day) && !isDayAvailable(day) && (
                                  <span className="text-[10px] font-semibold text-orange-600 bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded-full">Outside available hours</span>
                                )}
                              </div>
                              <button type="button" onClick={() => { setSelectedDays(prev => prev.filter(d => d !== day)); setDayTimes(prev => { const next = { ...prev }; delete next[day]; return next; }); }} className="text-xs text-slate-400 hover:text-red-500 transition-colors">Remove</button>
                            </div>
                            <div className="space-y-1.5">
                              {blocks.map((block, bi) => (
                                <div key={bi} className="flex flex-col gap-1">
                                  {isDayAvailable(day) && isBlockOutsidePreferred(day, stripNextDay(block.start), block.end) && (
                                    <span className="text-[10px] font-semibold text-orange-600 bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded-full self-start">Outside available hours</span>
                                  )}
                                  <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                                    <select value={stripNextDay(block.start)}
                                      onChange={e => { const nb = [...blocks]; nb[bi] = { ...block, start: e.target.value }; setDayTimes(prev => ({ ...prev, [day]: nb })); }}
                                      className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary-300 bg-white">
                                      <option value="">Start</option>
                                      {availTimeOpts(day, otherBlocksBusy(day, bi)).map(t => <option key={t} value={t}>{fmtTimeOpt(t)}</option>)}
                                    </select>
                                    <span className="text-xs text-slate-400 shrink-0">to</span>
                                    <select value={block.end}
                                      onChange={e => { const nb = [...blocks]; nb[bi] = { ...block, end: e.target.value }; setDayTimes(prev => ({ ...prev, [day]: nb })); }}
                                      className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary-300 bg-white">
                                      <option value="">End</option>
                                      {availEndOpts(day, stripNextDay(block.start), otherBlocksBusy(day, bi)).map(t => <option key={t} value={t}>{fmtTimeOpt(t)}</option>)}
                                    </select>
                                    {blocks.length > 1 && (
                                      <button type="button" onClick={() => { const nb = blocks.filter((_, i) => i !== bi); setDayTimes(prev => ({ ...prev, [day]: nb })); }} className="text-slate-300 hover:text-red-400 transition-colors ml-1 shrink-0">✕</button>
                                    )}
                                  </div>
                                </div>
                              ))}
                              {blocks.every(b => b.start && b.end) && availTimeOpts(day, blocks.filter(b => b.start && b.end).map(b => ({ s: toMin(stripNextDay(b.start)), e: blockEndMin(b.end) }))).length > 0 && (
                                <button type="button" onClick={() => setDayTimes(prev => ({ ...prev, [day]: [...blocks, { start: '', end: '' }] }))} className="text-xs text-primary-600 hover:text-primary-800 font-medium mt-1 self-start">
                                  + Add time
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Add a day pills */}
                  {VISIT_DAYS.some(d => !selectedDays.includes(d)) && (
                    <div className="flex flex-nowrap gap-1">
                      {VISIT_DAYS.filter(d => !selectedDays.includes(d)).map(day => {
                        const isUnavail = !isDayAvailable(day);
                        const dayBookings = (cgBookedSlots[day] || []).sort((a, b) => a.s - b.s);
                        // Split bookings: client's own schedule vs other clients
                        const mySlots = (cgShiftBlocks[day] || []).map(b => ({ s: toMin(b.start), e: toMin(b.end) }));
                        const isMySlot = (b: {s:number;e:number}) => mySlots.some(m => m.s === b.s && m.e === b.e);
                        const scheduledStr = mergeIvs(dayBookings.filter(isMySlot)).map(b => `${fmtM(b.s)}–${fmtM(b.e)}`).join(', ');
                        const busyStr = mergeIvs(dayBookings.filter(b => !isMySlot(b))).map(b => `${fmtM(b.s)}–${fmtM(b.e)}`).join(', ');
                        const slots = hasCgAvail ? getDaySlots(day).filter(sl => sl.s < 1440) : [];
                        const freeIntervals = slots.flatMap(sl => {
                          const slE = sl.e || 1440;
                          let free = [{ s: sl.s, e: slE }];
                          for (const bk of dayBookings.filter(b => b.s < slE && b.e > sl.s)) {
                            free = free.flatMap(iv => {
                              if (bk.e <= iv.s || bk.s >= iv.e) return [iv];
                              const parts: Array<{s:number;e:number}> = [];
                              if (bk.s > iv.s) parts.push({ s: iv.s, e: bk.s });
                              if (bk.e < iv.e) parts.push({ s: bk.e, e: iv.e });
                              return parts;
                            });
                          }
                          return free.filter(iv => iv.e > iv.s);
                        });
                        const freeStr = mergeIvs(freeIntervals).map(iv => `${fmtM(iv.s)}–${fmtM(iv.e)}`).join(', ');
                        const fullyBooked = slots.length > 0 && freeIntervals.length === 0;
                        const isUnavailable = isUnavail || fullyBooked;
                        const hasTooltip = slots.length > 0 || isUnavail || busyStr.length > 0 || scheduledStr.length > 0;
                        return (
                          <div key={day} className="relative group">
                            <button type="button"
                              onClick={() => { setSelectedDays(prev => [...prev, day]); setDayTimes(prev => ({ ...prev, [day]: [{ start: '', end: '' }] })); }}
                              className={`text-xs font-semibold px-2 py-1 rounded-full border transition-colors ${isUnavailable ? 'border-orange-200 bg-orange-50 text-orange-600 hover:bg-orange-100 hover:border-orange-300' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-primary-50 hover:border-primary-300 hover:text-primary-700'}`}>
                              + {day}
                            </button>
                            {hasTooltip && (
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none hidden group-hover:block">
                                <div className="bg-slate-800 text-white rounded-lg px-3 py-2 shadow-xl text-[11px] whitespace-nowrap">
                                  {fullyBooked && <div className="text-orange-300 font-medium">Not available — fully booked</div>}
                                  {!fullyBooked && !isUnavail && freeStr && <div className="text-emerald-300 font-medium">Available: {freeStr}</div>}
                                  {isUnavail && <div className="text-orange-300">Outside available hours</div>}
                                  {scheduledStr && <div className="text-blue-300 font-medium">Scheduled: {scheduledStr}</div>}
                                  {busyStr && <div className="text-orange-300 font-medium">Busy: {busyStr}</div>}
                                  <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800" />
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Notes */}
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Notes (optional)</label>
                  <textarea value={visitNotes} onChange={e => setVisitNotes(e.target.value)}
                    placeholder="Any special instructions…"
                    rows={2}
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 resize-none" />
                </div>

                </>}
              </div>

              {/* Footer */}
              <div className="px-6 pb-6 pt-4 border-t border-slate-100 shrink-0">
                <div className="flex gap-3">
                  <button onClick={() => { setShowAddModal(false); resetVisitModal(); }}
                    className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50">
                    Cancel
                  </button>
                  <button onClick={handleAddShift} disabled={!canSubmit}
                    className="flex-1 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-semibold hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed">
                    Send Request
                  </button>
                </div>
                <p className="text-xs text-slate-400 text-center mt-2">
                  Your caregiver will need to accept before these visits are added to the schedule.
                </p>
              </div>

            </div>
          </div>
        );
      })()}
    </div>
  );
}
