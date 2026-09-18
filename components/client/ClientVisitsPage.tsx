import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CalendarCheck, History, MapPin, Clock, MessageSquare,
  XCircle, CalendarDays, Loader2, Repeat, CreditCard, Banknote,
  CheckCircle, ChevronDown, ChevronUp, AlertCircle, Phone, User, CalendarClock,
} from 'lucide-react';
import { db } from '../../lib/firebase';
import firebase from '../../lib/firebase';
import { ClientNavigation } from './ClientNavigation';
import { useAccessGates } from '../../hooks/useAccessGates';
import { useAuthUser } from '../../hooks/useAuthUser';
import { shiftDisplayStatus, shiftStatusBadgeClass, shiftStatusLabel } from '../../utils/shiftUtils';
import { isCaregiverBookable } from '../../utils/caregiverEligibility';
import { paymentMethodLabel } from '../../types';

interface Shift {
  id: string;
  caregiverId: string;
  caregiverName?: string;
  caregiverPhotoURL?: string | null;
  clientId: string;
  date: string;
  startTime: string;
  endTime?: string;
  status: 'scheduled' | 'in-progress' | 'completed' | 'cancelled' | 'needs_replacement';
  cancelledBy?: 'client' | 'caregiver';
  replacementRequestId?: string;
  replacementCaregiverName?: string;
  /** Who proposed the pending reschedule fields below. Undefined when there's
   * no pending proposal on this shift. */
  rescheduledBy?: 'client' | 'caregiver';
  /** A proposed new date/time for this same shift, awaiting the OTHER
   * party's acceptance — the real date/startTime/endTime never change until
   * that happens (same pattern as video_interviews' reschedulePendingTime). */
  reschedulePendingDate?: string;
  reschedulePendingStartTime?: string;
  reschedulePendingEndTime?: string;
  /** When the pending proposal above was sent — carried into rescheduleHistory's
   * proposedAt once accepted/declined, then cleared along with the rest. */
  reschedulePendingAt?: string;
  /** Append-only log of accepted reschedules on this shift — from/to date +
   * time, who proposed it and when, and who accepted it and when. Lives on
   * the shift doc itself (not a separate collection) since it's only ever
   * relevant in the context of this one shift. */
  rescheduleHistory?: Array<{
    from: { date: string; startTime: string; endTime?: string };
    to:   { date: string; startTime: string; endTime?: string };
    proposedBy: 'client' | 'caregiver';
    proposedAt: string;
    acceptedBy: 'client' | 'caregiver';
    acceptedAt: string;
  }>;
  address?: string;
  notes?: string;
  completionNotes?: string;
  /** Append-only lines the caregiver adds during the visit (Add a note on their pages). */
  notesLog?: Array<{ at: string; text: string; by?: string }>;
  careNeeds?: string[];
  tasksCompleted?: string[];
  startedAt?: any;
  completedAt?: any;
  paid?: boolean;
  rate?: number | null;
  paymentMethod?: string | null;
  recurringWeekly?: boolean;
  bookingRequestId?: string;
  schedule?: {
    startDate?: string;
    ongoing?: boolean;
    endDate?: string;
    dayShiftTimes?: Record<string, Array<{ start: string; end: string }>>;
  };
  careRecipients?: Array<{
    name: string;
    relationship?: string;
    age?: string;
    photoURL?: string | null;
    careNeeds?: string[];
    careNeedDetails?: Record<string, string[]>;
    lifestyle?: {
      favoriteActivities?: string[]; favoriteActivitiesOther?: string;
      helpActivities?: string[]; helpActivitiesOther?: string;
      entertainment?: string[]; entertainmentOther?: string;
      enjoysConversation?: boolean | null; prefersQuiet?: boolean | null;
      familyInArea?: boolean | null; familyVisitFreq?: string;
      friendsVisitors?: boolean | null; friendsVisitFreq?: string;
      hasAppointments?: boolean | null; appointmentsDetails?: string;
    } | null;
  }>;
  emergencyContact?: { name?: string; phone?: string; relationship?: string } | null;
}

function toMinutesOfDay(t: string): number {
  const nextDay = t.startsWith('~');
  const raw = nextDay ? t.slice(1) : t;
  const [h, m] = raw.split(':').map(Number);
  return (nextDay ? 1440 : 0) + (h || 0) * 60 + (m || 0);
}

function timeRangesOverlap(startA: string, endA: string | undefined, startB: string, endB: string | undefined): boolean {
  const aStart = toMinutesOfDay(startA), aEnd = toMinutesOfDay(endA || startA);
  const bStart = toMinutesOfDay(startB), bEnd = toMinutesOfDay(endB || startB);
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Fetches this SAME caregiver's other active shifts with this client on a
 * date, excluding the shift currently being rescheduled — used both to block
 * a double-booking on accept and to grey out conflicting slots in the
 * propose picker. Deliberately scoped to (this client, this caregiver) only —
 * a client can legitimately have two DIFFERENT caregivers booked at
 * overlapping times (e.g. a two-person care team, or a handoff), so that's
 * not a conflict; only the same caregiver double-booked with this client is.
 * firestore.rules only lets a client read shifts where clientId ==
 * themselves, so a client can't see (and therefore can't query for
 * conflicts against) this caregiver's OTHER clients' shifts either — that
 * cross-party check would need a server-side (admin SDK) callable, which
 * this does not attempt.
 */
async function fetchOwnShiftsForDate(
  fdb: firebase.firestore.Firestore,
  clientId: string,
  caregiverId: string,
  date: string,
  excludeShiftId?: string
): Promise<Array<{ startTime: string; endTime?: string }>> {
  if (!date) return [];
  const snap = await fdb.collection('shifts')
    .where('clientId', '==', clientId)
    .where('status', 'in', ['scheduled', 'in-progress'])
    .where('date', '==', date)
    .get();
  return snap.docs
    .filter(d => d.id !== excludeShiftId && d.data().caregiverId === caregiverId)
    .map(d => ({ startTime: d.data().startTime, endTime: d.data().endTime }));
}

function conflictAt(slot: string, conflicts: Array<{ startTime: string; endTime?: string }>): boolean {
  const m = toMinutesOfDay(slot);
  return conflicts.some(c => m >= toMinutesOfDay(c.startTime) && m < toMinutesOfDay(c.endTime || c.startTime));
}

function rangeConflicts(start: string, end: string, conflicts: Array<{ startTime: string; endTime?: string }>): { startTime: string; endTime?: string } | null {
  return conflicts.find(c => timeRangesOverlap(start, end, c.startTime, c.endTime)) ?? null;
}

function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function tsToDate(ts: any): Date | null {
  if (!ts) return null;
  if (ts?.toDate) return ts.toDate();
  if (ts?.seconds) return new Date(ts.seconds * 1000);
  return null;
}
function fmtTs(ts: any): string | null {
  const d = tsToDate(ts);
  if (!d) return null;
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  return `${date}, ${time}`;
}
function fmtDuration(startTs: any, endTs: any): string | null {
  const s = tsToDate(startTs); const e = tsToDate(endTs);
  if (!s || !e) return null;
  const totalSecs = Math.round((e.getTime() - s.getTime()) / 1000);
  if (totalSecs <= 0) return null;
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const sec = totalSecs % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function fmtDate(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

const ALL_DAYS_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface BookingAmendment {
  id: string;
  bookingRequestId: string | null;
  clientId: string;
  clientName: string;
  caregiverId: string;
  caregiverName: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  type: 'add_recurring_days';
  newDays: Record<string, Array<{ start: string; end: string }>>;
  notes: string;
  startDate?: string;
  endDate?: string | null;
  ongoing?: boolean;
  createdAt: any;
}

// Quarter-hour slots spanning the full day — matches how shifts are actually
// scheduled elsewhere in the app (existing shift start/end times routinely
// fall on :15/:45, not just :00/:30), and unlike the interview time picker
// (9am-6pm, since interviews are always daytime), care shifts routinely run
// overnight (e.g. dementia/night care), so every slot from 12am through
// 11:45pm must be selectable.
const RESCHEDULE_TIME_SLOTS: string[] = (() => {
  const slots: string[] = [];
  for (let hour = 0; hour <= 23; hour++) {
    for (const min of ['00', '15', '30', '45']) {
      slots.push(`${hour.toString().padStart(2, '0')}:${min}`);
    }
  }
  return slots;
})();

function fmtTime(t?: string): string {
  if (!t) return '';
  const clean = t.startsWith('~') ? t.slice(1) : t;
  return new Date(`2000-01-01T${clean}`).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// "HH:MM" (or "~HH:MM" for a next-day block) → minutes since midnight —
// mirrors CaregiverBookingsPage.tsx's own parseMinutes exactly.
function parseMinutes(t: string): number {
  const nextDay = t.startsWith('~');
  const raw = nextDay ? t.slice(1) : t;
  const [h, m] = raw.split(':').map(Number);
  return (nextDay ? 1440 : 0) + (h || 0) * 60 + (m || 0);
}

function calcShiftMins(start: string, end: string): number {
  if (!start || !end) return 0;
  const diff = parseMinutes(end) - parseMinutes(start);
  return diff > 0 ? diff : 0;
}

function fmtHours(mins: number): string {
  if (mins === 0) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Per-day time + duration, plus a weekly total — matches
// CaregiverBookingsPage.tsx's own weekly-schedule block exactly (2026-09-14,
// Hamse-confirmed: the client's cards showed only a flat "Mon 9am–5pm ·
// Tue ..." string with no per-day or weekly duration, while the caregiver's
// equivalent card already showed both — same booking, same data, just a
// less detailed client-side render).
function WeeklyScheduleBlock({ dayShiftTimes }: { dayShiftTimes?: Record<string, Array<{ start: string; end: string }>> }) {
  if (!dayShiftTimes || Object.keys(dayShiftTimes).length === 0) return null;
  const orderedDays = DAY_ORDER.filter(d => dayShiftTimes[d]?.some(b => b.start && b.end));
  if (orderedDays.length === 0) return null;
  const totalMins = orderedDays.reduce((sum, day) =>
    sum + dayShiftTimes[day].filter(b => b.start && b.end).reduce((s, b) => s + calcShiftMins(b.start, b.end), 0), 0);
  return (
    <div className="flex items-start gap-2 text-sm text-slate-700">
      <CalendarDays className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
      <div className="space-y-0.5">
        {orderedDays.map(day => {
          const blocks = dayShiftTimes[day].filter(b => b.start && b.end);
          const mins = blocks.reduce((s, b) => s + calcShiftMins(b.start, b.end), 0);
          return (
            <div key={day} className="flex items-center gap-2">
              <span className="w-8 text-xs font-semibold text-slate-500">{day}</span>
              <span className="text-xs text-slate-700">{blocks.map(b => `${fmtTime(b.start)}–${fmtTime(b.end)}`).join(', ')}</span>
              {mins > 0 && <span className="text-[10px] text-primary-600 font-semibold ml-auto">{fmtHours(mins)}</span>}
            </div>
          );
        })}
        {totalMins > 0 && (
          <div className="text-xs font-semibold text-slate-500 mt-1 pt-1 border-t border-slate-100">
            {fmtHours(totalMins)} / week
          </div>
        )}
      </div>
    </div>
  );
}

const statusColor = (s: Shift['status']) => {
  switch (s) {
    case 'scheduled':   return 'bg-blue-100 text-blue-700 border-blue-200';
    case 'in-progress': return 'bg-amber-100 text-amber-700 border-amber-200';
    case 'completed':   return 'bg-green-100 text-green-700 border-green-200';
    case 'cancelled':   return 'bg-red-100 text-red-700 border-red-200';
    default:            return 'bg-slate-100 text-slate-700 border-slate-200';
  }
};

const statusLabel = (s: Shift['status']) => {
  switch (s) {
    case 'scheduled':   return 'Scheduled';
    case 'in-progress': return 'In Progress';
    case 'completed':   return 'Completed';
    case 'cancelled':   return 'Cancelled';
    default:            return s;
  }
};

// ─── Pending booking request card ────────────────────────────────────────────

interface PendingBookingCardProps {
  booking: any;
  onCancel: (id: string) => Promise<void>;
  navigate: ReturnType<typeof useNavigate>;
  onMessage: () => void;
}

const PendingBookingCard: React.FC<PendingBookingCardProps> = ({ booking, onCancel, navigate: _navigate, onMessage }) => {
  const [cancelling, setCancelling] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const handleCancel = async () => {
    if (!window.confirm('Cancel this booking request?')) return;
    setCancelling(true);
    try { await onCancel(booking.id); }
    finally { setCancelling(false); }
  };

  return (
    <div className="bg-white border border-amber-200 rounded-2xl shadow-sm overflow-hidden">

      {/* Header */}
      <div className="px-5 pt-5 pb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-12 h-12 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center shrink-0">
            {(booking.caregiverPhoto || booking.caregiverPhotoURL)
              ? <img src={booking.caregiverPhoto || booking.caregiverPhotoURL} alt={booking.caregiverName} className="w-full h-full object-cover" />
              : <span className="text-primary-700 font-bold text-base">
                  {(booking.caregiverName || 'C').split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase()}
                </span>
            }
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-slate-900 text-base">{booking.caregiverName || 'Caregiver'}</p>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              {booking.schedule?.ongoing
                ? <span className="inline-flex items-center gap-1 text-xs font-medium text-violet-700 bg-violet-50 border border-violet-200 px-2 py-0.5 rounded-full">
                    <Repeat className="w-3 h-3" /> Ongoing
                  </span>
                : booking.schedule?.endDate
                  ? <span className="text-xs text-slate-500">Until {new Date(booking.schedule.endDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  : null
              }
              {booking.jobTitle && <p className="text-xs text-slate-500 truncate">{booking.jobTitle}</p>}
            </div>
          </div>
        </div>
        <button
          onClick={onMessage}
          className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 bg-white rounded-xl text-sm text-slate-600 hover:bg-slate-50 transition-colors shrink-0"
        >
          <MessageSquare className="w-4 h-4" /> Message
        </button>
      </div>

      {/* Booking details */}
      <div className="px-5 pb-4 space-y-2 border-t border-slate-50 pt-3">
        {booking.schedule?.startDate && (
          <div className="flex items-start gap-2 text-sm text-slate-700">
            <CalendarDays className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
            <span>Starts {fmtDate(booking.schedule.startDate)}</span>
          </div>
        )}
        <WeeklyScheduleBlock dayShiftTimes={booking.schedule?.dayShiftTimes} />
        {booking.address && (
          <div className="flex items-start gap-2 text-sm text-slate-700">
            <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
            <span>{booking.address}</span>
          </div>
        )}
        {booking.rate != null && (
          <div className="flex items-center gap-2 text-sm text-slate-700">
            {booking.paymentMethod === 'credit'
              ? <CreditCard className="w-4 h-4 text-slate-400 shrink-0" />
              : <Banknote className="w-4 h-4 text-slate-400 shrink-0" />}
            <span>
              <span className="font-semibold">${booking.rate}/hr</span>
              <span className="text-slate-400"> · {booking.paymentMethod === 'credit' ? 'Card' : paymentMethodLabel(booking.paymentMethod)}</span>
            </span>
          </div>
        )}
        {booking.careNeeds?.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {booking.careNeeds.map((n: string) => (
              <span key={n} className="text-xs bg-primary-50 text-primary-700 border border-primary-100 px-2 py-0.5 rounded-full">{n}</span>
            ))}
          </div>
        )}
      </div>

      {/* Expandable booking details */}
      {(booking.careRecipients?.length > 0 || booking.emergencyContact || booking.notes) && (
        <div className="border-t border-slate-100">
          <button
            onClick={() => setDetailsOpen(v => !v)}
            className="w-full px-5 py-3 flex items-center justify-between text-sm text-primary-600 font-medium hover:bg-slate-50 transition-colors"
          >
            <span>Booking details</span>
            {detailsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {detailsOpen && (
            <div className="px-5 pb-4 space-y-4 border-t border-slate-50">
              {(booking.careRecipients || []).map((r: any, ri: number) => {
                const needs = r.careNeeds || [];
                const details = r.careNeedDetails || {};
                const ls = r.lifestyle;
                return (
                  <div key={ri} className="border-l-4 border-primary-200 pl-3 space-y-2.5 pt-3">
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center shrink-0">
                        {r.photoURL
                          ? <img src={r.photoURL} alt={r.name} className="w-full h-full object-cover" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                          : <User className="w-4 h-4 text-primary-500" />}
                      </div>
                      <div>
                        <p className="font-semibold text-slate-800 text-sm">{r.name}</p>
                        <p className="text-xs text-slate-400">{[r.relationship, r.age ? `Age ${r.age}` : ''].filter(Boolean).join(' · ')}</p>
                      </div>
                    </div>
                    {needs.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Care Plan</p>
                        {needs.map((need: string) => {
                          const subtasks = details[need] || [];
                          return (
                            <div key={need} className="rounded-xl border border-blue-200 overflow-hidden">
                              <div className="bg-blue-50 px-3 py-1.5">
                                <span className="text-xs font-semibold text-blue-700">{need}</span>
                              </div>
                              {subtasks.length > 0 && (
                                <div className="px-3 py-2 flex flex-wrap gap-1.5">
                                  {subtasks.map((t: string) => <span key={t} className="text-xs bg-white text-slate-600 border border-slate-200 px-2.5 py-0.5 rounded-full">{t}</span>)}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {ls && (
                      <div className="space-y-1.5">
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Lifestyle & Preferences</p>
                        {ls.favoriteActivities?.length > 0 && (
                          <div>
                            <p className="text-xs text-slate-400 mb-1">Enjoys</p>
                            <div className="flex flex-wrap gap-1">{ls.favoriteActivities.map((a: string) => <span key={a} className="text-xs bg-green-50 text-green-700 border border-green-100 px-2 py-0.5 rounded-full">{a}</span>)}</div>
                            {ls.favoriteActivitiesOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.favoriteActivitiesOther}</p>}
                          </div>
                        )}
                        {ls.helpActivities?.length > 0 && (
                          <div>
                            <p className="text-xs text-slate-400 mb-1">Needs help with</p>
                            <div className="flex flex-wrap gap-1">{ls.helpActivities.map((a: string) => <span key={a} className="text-xs bg-orange-50 text-orange-700 border border-orange-100 px-2 py-0.5 rounded-full">{a}</span>)}</div>
                            {ls.helpActivitiesOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.helpActivitiesOther}</p>}
                          </div>
                        )}
                        {ls.entertainment?.length > 0 && (
                          <div>
                            <p className="text-xs text-slate-400 mb-1">Entertainment</p>
                            <div className="flex flex-wrap gap-1">{ls.entertainment.map((a: string) => <span key={a} className="text-xs bg-pink-50 text-pink-700 border border-pink-100 px-2 py-0.5 rounded-full">{a}</span>)}</div>
                            {ls.entertainmentOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.entertainmentOther}</p>}
                          </div>
                        )}
                        <div className="space-y-1">
                          {([
                            { label: 'Enjoys conversation', key: 'enjoysConversation' },
                            { label: 'Prefers quiet', key: 'prefersQuiet' },
                            { label: 'Family in area', key: 'familyInArea' },
                            { label: 'Friends or visitors', key: 'friendsVisitors' },
                            { label: 'Has appointments', key: 'hasAppointments' },
                          ] as const).filter(({ key }) => ls[key] !== null && ls[key] !== undefined).map(({ label, key }) => (
                            <React.Fragment key={key}>
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-slate-500">{label}</span>
                                <span className={`px-1.5 py-0.5 rounded-full font-semibold text-xs ${ls[key] === true ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>{ls[key] === true ? 'Yes' : 'No'}</span>
                              </div>
                              {key === 'familyInArea' && ls.familyInArea === true && ls.familyVisitFreq && (
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-slate-400">Family visit frequency</span>
                                  <span className="text-slate-600 font-medium">{ls.familyVisitFreq}</span>
                                </div>
                              )}
                              {key === 'friendsVisitors' && ls.friendsVisitors === true && ls.friendsVisitFreq && (
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-slate-400">Friends visit frequency</span>
                                  <span className="text-slate-600 font-medium">{ls.friendsVisitFreq}</span>
                                </div>
                              )}
                            </React.Fragment>
                          ))}
                        </div>
                        {ls.hasAppointments === true && ls.appointmentsDetails && (
                          <p className="text-xs text-slate-500"><span className="font-medium text-slate-400">Appointments:</span> {ls.appointmentsDetails}</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {booking.emergencyContact && (booking.emergencyContact.name || booking.emergencyContact.phone) && (
                <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-3">
                  <p className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">Emergency Contact</p>
                  <div className="flex items-center gap-2 text-sm text-red-800">
                    <Phone className="w-3.5 h-3.5 shrink-0" />
                    <span className="font-medium">{booking.emergencyContact.name}</span>
                    {booking.emergencyContact.relationship && <span className="text-red-500">· {booking.emergencyContact.relationship}</span>}
                    {booking.emergencyContact.phone && <span className="font-semibold">{booking.emergencyContact.phone}</span>}
                  </div>
                </div>
              )}
              {booking.notes && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Notes</p>
                  <p className="text-sm text-slate-600 bg-slate-50 rounded-xl px-3 py-2">{booking.notes}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex justify-end">
        <button
          onClick={handleCancel}
          disabled={cancelling}
          className="inline-flex items-center gap-1.5 px-4 py-2 border border-red-200 bg-white rounded-xl text-sm text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50"
        >
          {cancelling ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
          Cancel Request
        </button>
      </div>
    </div>
  );
};

// ─── Shift replacement (caregiver cancelled a single shift) ─────────────────

interface ReplacementCandidate {
  caregiverId: string;
  name: string;
  photoURL?: string | null;
  hourlyRate?: number | null;
  rating?: number;
  distanceMiles?: number | null;
  source: 'care_team' | 'match';
}

// Haversine distance in miles — mirrors hooks/useNearbyCaregiversWithScores.ts
// exactly, so "how far" means the same thing here as everywhere else on the site.
function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 0–1: fraction of the recipient's care needs a caregiver's skills cover —
// mirrors hooks/useNearbyCaregiversWithScores.ts's skillsOverlap exactly.
function skillsOverlap(cgSkills: string[], clientNeeds: string[]): number {
  if (!clientNeeds.length || !cgSkills.length) return 0;
  const cgLower = cgSkills.map(s => s.toLowerCase());
  let matched = 0;
  clientNeeds.forEach(need => {
    const n = need.toLowerCase();
    if (cgLower.some(s => s.includes(n) || n.includes(s))) matched++;
  });
  return matched / clientNeeds.length;
}

// Care Team members with a currently-active booking fill the list first (up to
// 5 total); any remaining slots are filled with other approved caregivers,
// ranked by care-needs match then distance then rating (mirrors
// useNearbyCaregiversWithScores' own ranking, minus the availability-overlap
// term — a single ad-hoc replacement shift has no weekly schedule to compare
// against). Tier 1 mirrors MyCareTeam.tsx's own active-caregiver derivation so
// "Care Team" here means the same thing it does everywhere else on the site.
async function fetchReplacementCandidates(
  fdb: NonNullable<typeof db>,
  clientUid: string,
  excludeCaregiverId: string,
  shift: Shift,
): Promise<ReplacementCandidate[]> {
  const MAX = 5;
  const candidates: ReplacementCandidate[] = [];
  const seenIds = new Set<string>([excludeCaregiverId]);

  // This specific recipient's care needs (scoped to the actual shift being
  // replaced, not the client's needs in general) — also decides the hard
  // transportation gate below, same trigger useNearbyCaregiversWithScores uses.
  const clientNeeds = [...new Set((shift.careRecipients || []).flatMap(r => r.careNeeds || []))];
  const needsTransportation = clientNeeds.some(n => /transport/i.test(n));

  // Tier 1: anyone the client has ever had a booking relationship with —
  // active Care Team AND past (completed/cancelled) bookings both count,
  // one candidate per caregiver, most recent booking wins.
  const careTeamSnap = await fdb.collection('booking_requests')
    .where('clientId', '==', clientUid)
    .where('status', 'in', ['accepted', 'completed', 'cancelled'])
    .get();
  const byCaregiver = new Map<string, { data: any; ts: number }>();
  careTeamSnap.docs.forEach(doc => {
    const d = doc.data() as any;
    if (!d.caregiverId) return;
    const ts = d.updatedAt?.seconds ?? d.createdAt?.seconds ?? 0;
    const existing = byCaregiver.get(d.caregiverId);
    if (!existing || ts > existing.ts) byCaregiver.set(d.caregiverId, { data: d, ts });
  });
  for (const [cgId, { data: d }] of byCaregiver) {
    if (candidates.length >= MAX) break;
    if (seenIds.has(cgId)) continue;
    // Care Team is an already-established relationship — the transportation
    // hard filter below only applies to tier 2 (strangers being suggested),
    // not to someone the family already knows and trusts.
    seenIds.add(cgId);
    candidates.push({
      caregiverId: cgId,
      name: d.caregiverName || 'Caregiver',
      photoURL: d.caregiverPhotoURL || null,
      hourlyRate: d.rate ?? null,
      source: 'care_team',
    });
  }

  if (candidates.length < MAX) {
    // The client's own location (for distance) — same geocoded pool
    // CarePlan.tsx's saveSection writes to on every save.
    const cpSnap = await fdb.collection('carePlans').doc(clientUid).get().catch(() => null);
    const locationPool = (cpSnap?.data() as any)?.locationPool || [];
    const clientLoc = locationPool.find((l: any) => l.lat != null && l.lng != null) || null;

    // caregivers is admin/owner-only for reads (firestore.rules) — clients
    // discover caregivers via publicCaregiverProfiles instead, same as
    // FindCaregivers.tsx / useNearbyCaregiversWithScores.
    const pool = await fdb.collection('publicCaregiverProfiles').where('onboardingStatus', '==', 'profile_complete').limit(50).get();
    const scored = pool.docs
      .map(d => ({ id: d.id, ...d.data() } as any))
      .filter(c => !seenIds.has(c.id) && isCaregiverBookable(c) && (!needsTransportation || c.hasValidTransportDocs))
      .map(c => {
        const cgLat = c.lat ?? c.latitude ?? null;
        const cgLng = c.lng ?? c.longitude ?? null;
        const distanceMiles = (clientLoc && cgLat != null && cgLng != null)
          ? Math.round(haversineMiles(clientLoc.lat, clientLoc.lng, cgLat, cgLng) * 10) / 10
          : null;
        return { ...c, _distanceMiles: distanceMiles, _skillsScore: skillsOverlap(c.skills || c.specializations || [], clientNeeds) };
      })
      .sort((a, b) => {
        const skillsDiff = b._skillsScore - a._skillsScore;
        if (Math.abs(skillsDiff) > 0.01) return skillsDiff;
        if (a._distanceMiles != null && b._distanceMiles != null && a._distanceMiles !== b._distanceMiles) {
          return a._distanceMiles - b._distanceMiles;
        }
        return (b.rating || 0) - (a.rating || 0);
      });
    for (const c of scored) {
      if (candidates.length >= MAX) break;
      candidates.push({
        caregiverId: c.id,
        name: c.name || 'Caregiver',
        photoURL: c.photoURL || c.photo || c.profilePhoto || c.imageUrl || null,
        hourlyRate: c.hourlyRate ?? null,
        rating: c.rating,
        distanceMiles: c._distanceMiles,
        source: 'match',
      });
    }
  }
  return candidates;
}

const REPLACEMENT_TIME_SLOTS: string[] = (() => {
  const slots: string[] = [];
  for (let h = 0; h < 24; h++) {
    slots.push(`${h.toString().padStart(2, '0')}:00`);
    slots.push(`${h.toString().padStart(2, '0')}:30`);
  }
  return slots;
})();

function timeSlotOptions(current: string): string[] {
  return REPLACEMENT_TIME_SLOTS.includes(current)
    ? REPLACEMENT_TIME_SLOTS
    : [current, ...REPLACEMENT_TIME_SLOTS].sort();
}

interface ReplacementPickerModalProps {
  shift: Shift;
  clientUid: string;
  onClose: () => void;
  onConfirm: (candidate: ReplacementCandidate, when: { date: string; startTime: string; endTime: string }) => Promise<void>;
}

const ReplacementPickerModal: React.FC<ReplacementPickerModalProps> = ({ shift, clientUid, onClose, onConfirm }) => {
  const [candidates, setCandidates] = useState<ReplacementCandidate[] | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [date, setDate] = useState(shift.date);
  const [startTime, setStartTime] = useState(shift.startTime);
  const [endTime, setEndTime] = useState(shift.endTime || shift.startTime);

  useEffect(() => {
    let cancelled = false;
    if (!db) { setCandidates([]); return; }
    fetchReplacementCandidates(db, clientUid, shift.caregiverId, shift)
      .then(list => { if (!cancelled) setCandidates(list); })
      .catch((err) => {
        console.error('fetchReplacementCandidates failed:', err);
        if (!cancelled) setCandidates([]);
      });
    return () => { cancelled = true; };
  }, [clientUid, shift.caregiverId]);

  const handlePick = async (candidate: ReplacementCandidate) => {
    setConfirmingId(candidate.caregiverId);
    try { await onConfirm(candidate, { date, startTime, endTime }); }
    finally { setConfirmingId(null); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-100">
          <p className="font-semibold text-slate-900">Find a replacement</p>
          <p className="text-xs text-slate-500 mt-0.5">Originally {fmtDate(shift.date)}, {fmtTime(shift.startTime)}{shift.endTime ? ` – ${fmtTime(shift.endTime)}` : ''}</p>
        </div>
        <div className="px-5 pt-4 pb-2 border-b border-slate-100 grid grid-cols-3 gap-2">
          <label className="text-xs text-slate-500">
            Date
            <input
              type="date"
              value={date}
              min={new Date().toISOString().split('T')[0]}
              onChange={e => setDate(e.target.value)}
              className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-slate-800"
            />
          </label>
          <label className="text-xs text-slate-500">
            Start
            <select
              value={startTime}
              onChange={e => setStartTime(e.target.value)}
              className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-slate-800"
            >
              {timeSlotOptions(shift.startTime).map(t => <option key={t} value={t}>{fmtTime(t)}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-500">
            End
            <select
              value={endTime}
              onChange={e => setEndTime(e.target.value)}
              className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-slate-800"
            >
              {timeSlotOptions(shift.endTime || shift.startTime).map(t => <option key={t} value={t}>{fmtTime(t)}</option>)}
            </select>
          </label>
        </div>
        <div className="p-5 space-y-3">
          {candidates === null ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-primary-500" /></div>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-6">No caregivers are available for this shift right now.</p>
          ) : (
            candidates.map(c => (
              <div key={c.caregiverId} className="flex items-center gap-3 border border-slate-200 rounded-xl px-3 py-2.5">
                <div className="w-10 h-10 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center shrink-0">
                  {c.photoURL
                    ? <img src={c.photoURL} alt={c.name} className="w-full h-full object-cover" />
                    : <span className="text-primary-700 font-bold text-sm">{c.name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()}</span>}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800 truncate">{c.name}</p>
                  <p className="text-xs text-slate-400">
                    {[c.source === 'care_team' ? 'On your Care Team' : null, c.hourlyRate != null ? `$${c.hourlyRate}/hr` : null]
                      .filter(Boolean).join(' · ')}
                  </p>
                </div>
                <a
                  href={`/client/caregiver/${c.caregiverId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 border border-slate-200 hover:bg-slate-50 text-slate-600 text-xs font-semibold rounded-xl transition-colors shrink-0"
                >
                  Profile
                </a>
                <button
                  onClick={() => handlePick(c)}
                  disabled={confirmingId !== null}
                  className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-xs font-semibold rounded-xl transition-colors disabled:opacity-50 shrink-0"
                >
                  {confirmingId === c.caregiverId ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Request'}
                </button>
              </div>
            ))
          )}
        </div>
        <div className="px-5 py-3 border-t border-slate-100 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700 transition-colors">Cancel</button>
        </div>
      </div>
    </div>
  );
};

// ─── Active visit group card (one per booking) ──────────────────────────────

interface ActiveVisitGroupCardProps {
  shifts: Shift[];
  onCancelBooking: (shiftId: string) => Promise<void>;
  navigate: ReturnType<typeof useNavigate>;
  onMessage: () => void;
  onSkipReplacement: (shiftId: string) => Promise<void>;
  onFindReplacement: (shift: Shift) => void;
  onWithdrawReplacement: (replacementRequestId: string) => Promise<void>;
  /** The generator paused new visits because the membership lapsed (booking_requests.schedulePausedAt). */
  schedulePaused?: boolean;
}

const ActiveVisitGroupCard: React.FC<ActiveVisitGroupCardProps> = ({ shifts, onCancelBooking, navigate: _navigate, onMessage, onSkipReplacement, onFindReplacement, onWithdrawReplacement, schedulePaused }) => {
  const base = shifts[0];
  const [cancelling, setCancelling] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const sorted = [...shifts].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    return d !== 0 ? d : (a.startTime || '').localeCompare(b.startTime || '');
  });
  const preview = showAll ? sorted : sorted.slice(0, 2);
  const ongoing = base.schedule?.ongoing ?? base.recurringWeekly ?? false;
  const endDate  = base.schedule?.endDate;

  const [cancellingShift, setCancellingShift] = useState<string | null>(null);

  const handleCancel = async () => {
    setCancelling(true);
    try { await onCancelBooking(base.id); }
    finally { setCancelling(false); }
  };

  const handleCancelShift = async (shiftId: string) => {
    if (!db || !window.confirm('Cancel this shift only? The rest of your booking stays active.')) return;
    setCancellingShift(shiftId);
    try {
      // onShiftCancelled Cloud Function fires and notifies the caregiver.
      // Clear any pending reschedule proposal too — a cancelled shift has
      // nothing left to reschedule, and leaving these set would keep the
      // "waiting to confirm" banner rendering on an already-dead shift.
      await db.collection('shifts').doc(shiftId).update({
        status: 'cancelled',
        cancelledBy: 'client',
        reschedulePendingDate: firebase.firestore.FieldValue.delete(),
        reschedulePendingStartTime: firebase.firestore.FieldValue.delete(),
        reschedulePendingEndTime: firebase.firestore.FieldValue.delete(),
        rescheduledBy: firebase.firestore.FieldValue.delete(),
      });
    } catch {
      // non-critical
    } finally {
      setCancellingShift(null);
    }
  };

  // Reschedule the SAME shift in place — no cancel, no new doc. Mirrors the
  // video_interviews Reschedule pattern (see notificationTriggers.ts /
  // PostsPage.tsx): a proposal is stored in separate reschedulePendingDate/
  // StartTime/EndTime fields and NEVER touches the real date/startTime/
  // endTime until the other party explicitly accepts — writing directly to
  // the real fields would move a confirmed visit before anyone agreed to it.
  const [rescheduleOpenId, setRescheduleOpenId] = useState<string | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleStart, setRescheduleStart] = useState('');
  const [rescheduleEnd, setRescheduleEnd] = useState('');
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  // Your own other shifts on the currently-picked reschedule date — used to
  // grey out conflicting slots in the picker below (same idea as the "add a
  // day" flow's availability filtering in Schedule.tsx).
  const [dateConflicts, setDateConflicts] = useState<Array<{ startTime: string; endTime?: string }>>([]);
  const [historyOpenId, setHistoryOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!db || !rescheduleOpenId || !rescheduleDate) { setDateConflicts([]); return; }
    let cancelled = false;
    fetchOwnShiftsForDate(db, base.clientId, base.caregiverId, rescheduleDate, rescheduleOpenId)
      .then(list => { if (!cancelled) setDateConflicts(list); })
      .catch(() => { if (!cancelled) setDateConflicts([]); });
    return () => { cancelled = true; };
  }, [rescheduleOpenId, rescheduleDate]);

  const handleProposeReschedule = async (shift: Shift) => {
    if (!db || !rescheduleDate || !rescheduleStart || !rescheduleEnd) return;
    const conflict = rangeConflicts(rescheduleStart, rescheduleEnd, dateConflicts);
    if (conflict) {
      window.alert(`That overlaps another visit you have at ${fmtTime(conflict.startTime)}${conflict.endTime ? `–${fmtTime(conflict.endTime)}` : ''} that day — choose a different time.`);
      return;
    }
    setReschedulingId(shift.id);
    try {
      await db.collection('shifts').doc(shift.id).update({
        reschedulePendingDate: rescheduleDate,
        reschedulePendingStartTime: rescheduleStart,
        reschedulePendingEndTime: rescheduleEnd,
        reschedulePendingAt: new Date().toISOString(),
        rescheduledBy: 'client',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      setRescheduleOpenId(null);
      setRescheduleDate('');
      setRescheduleStart('');
      setRescheduleEnd('');
    } catch {
      // non-critical
    } finally {
      setReschedulingId(null);
    }
  };

  // Accept the caregiver's proposed time — this is the moment the real
  // date/startTime/endTime actually change, same shift doc throughout.
  // Only checks the CLIENT's own other shifts (readable under firestore.rules);
  // it can't see whether the caregiver themselves is now double-booked with a
  // different client — that would need a server-side check.
  const handleAcceptReschedule = async (shift: Shift) => {
    if (!db || !shift.reschedulePendingDate) return;
    setReschedulingId(shift.id);
    try {
      const ownShifts = await fetchOwnShiftsForDate(db, shift.clientId, shift.caregiverId, shift.reschedulePendingDate, shift.id);
      const conflict = rangeConflicts(shift.reschedulePendingStartTime!, shift.reschedulePendingEndTime || shift.reschedulePendingStartTime!, ownShifts);
      if (conflict) {
        window.alert(`You already have another visit booked at ${fmtTime(conflict.startTime)}${conflict.endTime ? `–${fmtTime(conflict.endTime)}` : ''} that day — choose a different time.`);
        return;
      }
      await db.collection('shifts').doc(shift.id).update({
        date: shift.reschedulePendingDate,
        startTime: shift.reschedulePendingStartTime,
        endTime: shift.reschedulePendingEndTime,
        reschedulePendingDate: firebase.firestore.FieldValue.delete(),
        reschedulePendingStartTime: firebase.firestore.FieldValue.delete(),
        reschedulePendingEndTime: firebase.firestore.FieldValue.delete(),
        reschedulePendingAt: firebase.firestore.FieldValue.delete(),
        rescheduledBy: firebase.firestore.FieldValue.delete(),
        // arrayUnion can't hold a serverTimestamp() sentinel inside its
        // elements, so acceptedAt is a plain client-clock ISO string here.
        rescheduleHistory: firebase.firestore.FieldValue.arrayUnion({
          from: { date: shift.date, startTime: shift.startTime, endTime: shift.endTime ?? null },
          to:   { date: shift.reschedulePendingDate, startTime: shift.reschedulePendingStartTime, endTime: shift.reschedulePendingEndTime ?? null },
          proposedBy: shift.rescheduledBy,
          proposedAt: shift.reschedulePendingAt ?? null,
          acceptedBy: shift.rescheduledBy === 'caregiver' ? 'client' : 'caregiver',
          acceptedAt: new Date().toISOString(),
        }),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch {
      // non-critical
    } finally {
      setReschedulingId(null);
    }
  };

  // Decline a caregiver's proposal, or withdraw your own — either way just
  // clears the pending fields; the real, still-confirmed time is untouched.
  const handleClearReschedule = async (shift: Shift) => {
    if (!db) return;
    setReschedulingId(shift.id);
    try {
      await db.collection('shifts').doc(shift.id).update({
        reschedulePendingDate: firebase.firestore.FieldValue.delete(),
        reschedulePendingStartTime: firebase.firestore.FieldValue.delete(),
        reschedulePendingEndTime: firebase.firestore.FieldValue.delete(),
        reschedulePendingAt: firebase.firestore.FieldValue.delete(),
        rescheduledBy: firebase.firestore.FieldValue.delete(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch {
      // non-critical
    } finally {
      setReschedulingId(null);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">

      {/* Header */}
      <div className="px-5 pt-5 pb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-12 h-12 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center shrink-0">
            {base.caregiverPhotoURL
              ? <img src={base.caregiverPhotoURL} alt={base.caregiverName} className="w-full h-full object-cover" />
              : <span className="text-primary-700 font-bold text-base">
                  {(base.caregiverName || 'C').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()}
                </span>
            }
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-slate-900 text-base">{base.caregiverName || 'Caregiver'}</p>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              {ongoing
                ? <span className="inline-flex items-center gap-1 text-xs font-medium text-violet-700 bg-violet-50 border border-violet-200 px-2 py-0.5 rounded-full">
                    <Repeat className="w-3 h-3" /> Ongoing
                  </span>
                : endDate
                  ? <span className="text-xs text-slate-500">Until {new Date(endDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  : null
              }
              {schedulePaused && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full" title="Visits already on the calendar still happen. Reactivate your membership to resume new visits.">
                  Schedule paused — membership inactive
                </span>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={onMessage}
          className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 bg-white rounded-xl text-sm text-slate-600 hover:bg-slate-50 transition-colors shrink-0"
        >
          <MessageSquare className="w-4 h-4" /> Message
        </button>
      </div>

      {/* Shared booking details */}
      <div className="px-5 pb-4 space-y-2 border-t border-slate-50 pt-3">
        {base.schedule?.startDate && (
          <div className="flex items-start gap-2 text-sm text-slate-700">
            <CalendarDays className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
            <span>Starts {fmtDate(base.schedule.startDate)}</span>
          </div>
        )}
        <WeeklyScheduleBlock dayShiftTimes={base.schedule?.dayShiftTimes} />
        {base.address && (
          <div className="flex items-start gap-2 text-sm text-slate-700">
            <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
            <span>{base.address}</span>
          </div>
        )}
        {base.rate != null && (
          <div className="flex items-center gap-2 text-sm text-slate-700">
            {base.paymentMethod === 'credit'
              ? <CreditCard className="w-4 h-4 text-slate-400 shrink-0" />
              : <Banknote className="w-4 h-4 text-slate-400 shrink-0" />}
            <span>
              <span className="font-semibold">${base.rate}/hr</span>
              <span className="text-slate-400"> · {base.paymentMethod === 'credit' ? 'Card' : paymentMethodLabel(base.paymentMethod)}</span>
            </span>
          </div>
        )}
        {base.notes && (
          <div className="flex items-start gap-2 text-sm text-slate-500">
            <AlertCircle className="w-4 h-4 text-slate-300 shrink-0 mt-0.5" />
            <span>{base.notes}</span>
          </div>
        )}
      </div>

      {/* Booking details toggle */}
      {(base.careRecipients?.length || base.emergencyContact) ? (
        <div className="border-t border-slate-100">
          <button
            onClick={() => setDetailsOpen(v => !v)}
            className="w-full px-5 py-3 flex items-center justify-between text-sm text-primary-600 font-medium hover:bg-slate-50 transition-colors"
          >
            <span>Booking details</span>
            {detailsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {detailsOpen && (
            <div className="px-5 pb-4 space-y-4 border-t border-slate-50">
              {(base.careRecipients || []).map((r, ri) => {
                const needs = r.careNeeds || [];
                const details = r.careNeedDetails || {};
                const ls = r.lifestyle;
                return (
                  <div key={ri} className="border-l-4 border-primary-200 pl-3 space-y-2.5 pt-3">
                    {/* Recipient header */}
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center shrink-0">
                        {r.photoURL
                          ? <img src={r.photoURL} alt={r.name} className="w-full h-full object-cover" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                          : <User className="w-4 h-4 text-primary-500" />
                        }
                      </div>
                      <div>
                        <p className="font-semibold text-slate-800 text-sm">{r.name}</p>
                        <p className="text-xs text-slate-400">{[r.relationship, r.age ? `Age ${r.age}` : ''].filter(Boolean).join(' · ')}</p>
                      </div>
                    </div>

                    {/* Care needs */}
                    {needs.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Care Plan</p>
                        {needs.map(need => {
                          const subtasks = details[need] || [];
                          return (
                            <div key={need} className="rounded-xl border border-blue-200 overflow-hidden">
                              <div className="bg-blue-50 px-3 py-1.5">
                                <span className="text-xs font-semibold text-blue-700">{need}</span>
                              </div>
                              {subtasks.length > 0 && (
                                <div className="px-3 py-2 flex flex-wrap gap-1.5">
                                  {subtasks.map(t => <span key={t} className="text-xs bg-white text-slate-600 border border-slate-200 px-2.5 py-0.5 rounded-full">{t}</span>)}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Lifestyle */}
                    {ls && (
                      <div className="space-y-1.5">
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Lifestyle & Preferences</p>
                        {ls.favoriteActivities && ls.favoriteActivities.length > 0 && (
                          <div>
                            <p className="text-xs text-slate-400 mb-1">Enjoys</p>
                            <div className="flex flex-wrap gap-1">{ls.favoriteActivities.map(a => <span key={a} className="text-xs bg-green-50 text-green-700 border border-green-100 px-2 py-0.5 rounded-full">{a}</span>)}</div>
                            {ls.favoriteActivitiesOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.favoriteActivitiesOther}</p>}
                          </div>
                        )}
                        {ls.helpActivities && ls.helpActivities.length > 0 && (
                          <div>
                            <p className="text-xs text-slate-400 mb-1">Needs help with</p>
                            <div className="flex flex-wrap gap-1">{ls.helpActivities.map(a => <span key={a} className="text-xs bg-orange-50 text-orange-700 border border-orange-100 px-2 py-0.5 rounded-full">{a}</span>)}</div>
                            {ls.helpActivitiesOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.helpActivitiesOther}</p>}
                          </div>
                        )}
                        {ls.entertainment && ls.entertainment.length > 0 && (
                          <div>
                            <p className="text-xs text-slate-400 mb-1">Entertainment</p>
                            <div className="flex flex-wrap gap-1">{ls.entertainment.map(a => <span key={a} className="text-xs bg-pink-50 text-pink-700 border border-pink-100 px-2 py-0.5 rounded-full">{a}</span>)}</div>
                            {ls.entertainmentOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.entertainmentOther}</p>}
                          </div>
                        )}
                        <div className="space-y-1">
                          {([
                            { label: 'Enjoys conversation', key: 'enjoysConversation' },
                            { label: 'Prefers quiet', key: 'prefersQuiet' },
                            { label: 'Family in area', key: 'familyInArea' },
                            { label: 'Friends or visitors', key: 'friendsVisitors' },
                            { label: 'Has appointments', key: 'hasAppointments' },
                          ] as const).filter(({ key }) => (ls as any)[key] !== null && (ls as any)[key] !== undefined).map(({ label, key }) => (
                            <React.Fragment key={key}>
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-slate-500">{label}</span>
                                <span className={`px-1.5 py-0.5 rounded-full font-semibold text-xs ${(ls as any)[key] === true ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>{(ls as any)[key] === true ? 'Yes' : 'No'}</span>
                              </div>
                              {key === 'familyInArea' && ls.familyInArea === true && ls.familyVisitFreq && (
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-slate-400">Family visit frequency</span>
                                  <span className="text-slate-600 font-medium">{ls.familyVisitFreq}</span>
                                </div>
                              )}
                              {key === 'friendsVisitors' && ls.friendsVisitors === true && ls.friendsVisitFreq && (
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-slate-400">Friends visit frequency</span>
                                  <span className="text-slate-600 font-medium">{ls.friendsVisitFreq}</span>
                                </div>
                              )}
                            </React.Fragment>
                          ))}
                        </div>
                        {ls.hasAppointments === true && ls.appointmentsDetails && (
                          <p className="text-xs text-slate-500"><span className="font-medium text-slate-400">Appointments:</span> {ls.appointmentsDetails}</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Emergency contact */}
              {base.emergencyContact && (base.emergencyContact.name || base.emergencyContact.phone) && (
                <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-3">
                  <p className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">Emergency Contact</p>
                  <div className="flex items-center gap-2 text-sm text-red-800">
                    <Phone className="w-3.5 h-3.5 shrink-0" />
                    <span className="font-medium">{base.emergencyContact.name}</span>
                    {base.emergencyContact.relationship && <span className="text-red-500">· {base.emergencyContact.relationship}</span>}
                    {base.emergencyContact.phone && <span className="font-semibold">{base.emergencyContact.phone}</span>}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}

      {/* Upcoming shifts list */}
      <div className="border-t border-slate-100">
        <p className="px-5 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wide">
          Upcoming Shifts
        </p>
        <div className="divide-y divide-slate-50">
          {preview.map(s => {
            const ds = shiftDisplayStatus(s);
            const needsReplacement = s.status === 'needs_replacement';
            return (
            <div key={s.id} className={needsReplacement ? 'bg-amber-50/60' : undefined}>
              <div className="px-5 py-3 flex items-center gap-3">
                {/* Cancel single shift — far left */}
                {s.status === 'scheduled' && (
                  <button
                    onClick={() => handleCancelShift(s.id)}
                    disabled={cancellingShift === s.id}
                    title="Cancel this shift only"
                    className="p-1 text-red-300 hover:text-red-500 transition-colors disabled:opacity-50 shrink-0"
                  >
                    {cancellingShift === s.id
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <XCircle className="w-4 h-4" />
                    }
                  </button>
                )}
                {/* Reschedule — only when your turn (no proposal out, or reviewing the
                    caregiver's), not while the propose form for this shift is open, and
                    not once the shift is overdue (already passed with no reschedule sent
                    — that's a no-show/dispute situation, not something to just move). */}
                {s.status === 'scheduled' && s.rescheduledBy !== 'client' && rescheduleOpenId !== s.id && ds !== 'overdue' && (
                  <button
                    onClick={() => {
                      setRescheduleOpenId(s.id);
                      setRescheduleDate(s.reschedulePendingDate || s.date);
                      setRescheduleStart(s.reschedulePendingStartTime || s.startTime);
                      setRescheduleEnd(s.reschedulePendingEndTime || s.endTime || '');
                    }}
                    disabled={reschedulingId === s.id}
                    title={s.reschedulePendingDate ? 'Propose a different time' : 'Reschedule this shift'}
                    className="p-1 text-blue-300 hover:text-blue-500 transition-colors disabled:opacity-50 shrink-0"
                  >
                    <CalendarClock className="w-4 h-4" />
                  </button>
                )}
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="text-center shrink-0 w-10">
                    <p className="text-xs font-bold text-primary-600 leading-tight">
                      {new Date(s.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}
                    </p>
                    <p className="text-sm font-semibold text-slate-800 leading-tight">
                      {new Date(s.date + 'T12:00:00').getDate()}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm text-slate-700">{fmtDate(s.date)}</p>
                    <p className="text-xs text-slate-400 flex items-center gap-1 mt-0.5">
                      <Clock className="w-3 h-3" />
                      {fmtTime(s.startTime)}{s.endTime ? ` – ${fmtTime(s.endTime)}` : ''}
                    </p>
                    {/* A visit's own note (e.g. the note on the schedule-change request
                        that created it) — shown only when it differs from the booking's
                        general note above, so regular visits don't repeat it. */}
                    {s.notes && s.notes !== base.notes && (
                      <p className="text-xs text-slate-400 italic mt-0.5">{s.notes}</p>
                    )}
                  </div>
                </div>
                <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border shrink-0 ${shiftStatusBadgeClass(ds)}`}>
                  {shiftStatusLabel(ds)}
                </span>
              </div>
              {/* Reschedule history — collapsed by default, one line per past
                  change, so a shift that's been moved a few times doesn't turn
                  into a wall of text. */}
              {s.rescheduleHistory && s.rescheduleHistory.length > 0 && (
                <div className="px-5 pb-2 -mt-1">
                  <button
                    onClick={() => setHistoryOpenId(v => v === s.id ? null : s.id)}
                    className="text-[11px] text-slate-400 hover:text-slate-600 transition-colors"
                  >
                    {historyOpenId === s.id ? 'Hide' : 'Show'} reschedule history ({s.rescheduleHistory.length})
                  </button>
                  {historyOpenId === s.id && (
                    <ul className="mt-1 space-y-0.5">
                      {s.rescheduleHistory.map((h, i) => {
                        // Legacy shape (changedBy/changedAt, written before this
                        // was split into propose+accept) — fall back gracefully
                        // instead of showing blank "you" for both.
                        const legacy = h as any;
                        const isLegacy = !h.proposedBy && legacy.changedBy;
                        return (
                        <li key={i} className="text-[11px] text-slate-400">
                          <div>
                            {fmtDate(h.from.date)}, {fmtTime(h.from.startTime)}{h.from.endTime ? `–${fmtTime(h.from.endTime)}` : ''}
                            {' → '}
                            {fmtDate(h.to.date)}, {fmtTime(h.to.startTime)}{h.to.endTime ? `–${fmtTime(h.to.endTime)}` : ''}
                          </div>
                          <div className="text-slate-300">
                            {isLegacy
                              // Old schema only ever wrote changedBy/changedAt from inside the
                              // accept handler — changedBy is who PROPOSED it, changedAt is
                              // when it was ACCEPTED (by the other party) — no proposed-on
                              // date was ever captured, so that half is left blank.
                              ? <>Requested by {legacy.changedBy === 'caregiver' ? 'caregiver' : 'you'}
                                  {' · '}Confirmed by {legacy.changedBy === 'caregiver' ? 'you' : 'caregiver'} on {fmtStamp(legacy.changedAt)}</>
                              : <>Requested by {h.proposedBy === 'caregiver' ? 'caregiver' : 'you'} on {fmtStamp(h.proposedAt)}
                                  {' · '}Confirmed by {h.acceptedBy === 'caregiver' ? 'caregiver' : 'you'} on {fmtStamp(h.acceptedAt)}</>}
                          </div>
                        </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
              {needsReplacement && (
                <div className="px-5 pb-3 -mt-1">
                  {s.replacementRequestId ? (
                    <div className="flex items-center gap-2 flex-wrap text-xs text-amber-800 bg-amber-100 border border-amber-200 rounded-lg px-3 py-2">
                      <span className="flex-1 min-w-[160px]">Waiting on {s.replacementCaregiverName || 'the new caregiver'} to respond</span>
                      <button
                        onClick={() => onWithdrawReplacement(s.replacementRequestId!)}
                        className="px-2.5 py-1 border border-amber-300 hover:bg-amber-200 text-amber-800 text-xs font-semibold rounded-lg transition-colors shrink-0"
                      >
                        Choose someone else
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-xs text-amber-800 flex-1 min-w-[160px]">Your caregiver cancelled this visit.</p>
                      <button
                        onClick={() => onFindReplacement(s)}
                        className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-xl transition-colors"
                      >
                        Find replacement
                      </button>
                      <button
                        onClick={() => onSkipReplacement(s.id)}
                        className="px-3 py-1.5 border border-amber-300 hover:bg-amber-100 text-amber-700 text-xs font-semibold rounded-xl transition-colors"
                      >
                        Skip
                      </button>
                    </div>
                  )}
                </div>
              )}
              {/* Reschedule proposal pending — the CONFIRMED date/time above (s.date/
                  startTime/endTime) is still what's actually scheduled until accepted. */}
              {s.status === 'scheduled' && s.reschedulePendingDate && (
                <div className="px-5 pb-3 -mt-1">
                  <div className="flex items-center gap-2 flex-wrap text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                    <span className="flex-1 min-w-[160px]">
                      {s.rescheduledBy === 'caregiver'
                        ? `${s.caregiverName || 'Your caregiver'} proposed moving this visit to `
                        : 'You proposed moving this visit to '}
                      {fmtDate(s.reschedulePendingDate)}, {fmtTime(s.reschedulePendingStartTime)}
                      {s.reschedulePendingEndTime ? ` – ${fmtTime(s.reschedulePendingEndTime)}` : ''}
                      {s.rescheduledBy === 'client' && ' — waiting on your caregiver to confirm'}
                    </span>
                    {s.rescheduledBy === 'caregiver' && (
                      <button
                        onClick={() => handleAcceptReschedule(s)}
                        disabled={reschedulingId === s.id}
                        className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors shrink-0 disabled:opacity-50"
                      >
                        Accept new time
                      </button>
                    )}
                    <button
                      onClick={() => handleClearReschedule(s)}
                      disabled={reschedulingId === s.id}
                      className="px-2.5 py-1 border border-blue-300 hover:bg-blue-100 text-blue-800 text-xs font-semibold rounded-lg transition-colors shrink-0 disabled:opacity-50"
                    >
                      {s.rescheduledBy === 'caregiver' ? 'Decline' : 'Withdraw'}
                    </button>
                  </div>
                </div>
              )}
              {/* Propose form */}
              {rescheduleOpenId === s.id && (
                <div className="px-5 pb-3 -mt-1">
                  <div className="flex flex-wrap items-end gap-2 bg-blue-50 border border-blue-100 rounded-lg p-2">
                    <div>
                      <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Date</label>
                      <input type="date" value={rescheduleDate} min={new Date().toISOString().split('T')[0]}
                        onChange={(e) => setRescheduleDate(e.target.value)}
                        className="text-xs border border-slate-200 rounded-lg px-2 py-1.5" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Start</label>
                      <select value={rescheduleStart} onChange={(e) => setRescheduleStart(e.target.value)}
                        className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white">
                        <option value="">Choose...</option>
                        {/* Only genuinely open start times are listed — a slot that's the
                            START of an already-booked visit is excluded outright, not
                            shown-but-disabled, so every visible option is actually pickable. */}
                        {RESCHEDULE_TIME_SLOTS.filter(t => !conflictAt(t, dateConflicts)).map((t) => (
                          <option key={t} value={t}>{fmtTime(t)}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-slate-500 mb-0.5">End</label>
                      <select value={rescheduleEnd} onChange={(e) => setRescheduleEnd(e.target.value)}
                        className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white">
                        <option value="">Choose...</option>
                        {/* After the chosen start, AND stopping before the next already-booked
                            visit that day — an end time that would run into another visit is
                            excluded, so the existing booking's start is respected as a hard cap. */}
                        {RESCHEDULE_TIME_SLOTS.filter(t => (!rescheduleStart || t > rescheduleStart) && (!rescheduleStart || !rangeConflicts(rescheduleStart, t, dateConflicts))).map((t) => (
                          <option key={t} value={t}>{fmtTime(t)}</option>
                        ))}
                      </select>
                    </div>
                    {dateConflicts.length > 0 && (
                      <p className="basis-full text-[11px] text-slate-500">
                        Already booked that day: {dateConflicts.map((c, i) => (
                          <span key={i}>{i > 0 ? ', ' : ''}{fmtTime(c.startTime)}{c.endTime ? `–${fmtTime(c.endTime)}` : ''}</span>
                        ))}
                      </p>
                    )}
                    <button
                      onClick={() => handleProposeReschedule(s)}
                      disabled={reschedulingId === s.id || !rescheduleDate || !rescheduleStart || !rescheduleEnd}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 text-white rounded-lg text-xs font-semibold hover:bg-primary-700 disabled:opacity-50"
                    >
                      {reschedulingId === s.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CalendarClock className="w-3.5 h-3.5" />} Send new time
                    </button>
                    <button
                      onClick={() => { setRescheduleOpenId(null); setRescheduleDate(''); setRescheduleStart(''); setRescheduleEnd(''); }}
                      className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
            );
          })}
        </div>
        {sorted.length > 2 && (
          <button
            onClick={() => setShowAll(v => !v)}
            className="w-full py-2.5 text-xs text-slate-500 hover:text-slate-700 flex items-center justify-center gap-1 transition-colors"
          >
            {showAll
              ? <><ChevronUp className="w-3.5 h-3.5" /> Show less</>
              : <><ChevronDown className="w-3.5 h-3.5" /> Show {sorted.length - 2} more shifts</>
            }
          </button>
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex justify-end">
        <button
          onClick={handleCancel}
          disabled={cancelling}
          className="inline-flex items-center gap-1.5 px-4 py-2 border border-red-200 bg-white rounded-xl text-sm text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50"
        >
          {cancelling
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <XCircle className="w-4 h-4" />
          }
          Cancel Booking
        </button>
      </div>
    </div>
  );
};

// ─── Past visit group card (one per booking) ─────────────────────────────────

interface PastVisitGroupCardProps {
  shifts: Shift[];
  navigate: ReturnType<typeof useNavigate>;
  onMessage: () => void;
}

const PastVisitGroupCard: React.FC<PastVisitGroupCardProps> = ({ shifts, navigate: _navigate, onMessage }) => {
  const base = shifts[0];
  const [expanded, setExpanded] = useState(false);
  const [expandedShiftId, setExpandedShiftId] = useState<string | null>(null);
  const sorted = [...shifts].sort((a, b) => {
    const d = b.date.localeCompare(a.date);
    return d !== 0 ? d : (b.startTime || '').localeCompare(a.startTime || '');
  });

  const completedCount = shifts.filter(s => s.status === 'completed').length;
  const cancelledCount = shifts.filter(s => s.status === 'cancelled').length;

  const preview = expanded ? sorted : sorted.slice(0, 2);

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">

      {/* Header */}
      <div className="px-5 pt-5 pb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-12 h-12 rounded-full overflow-hidden bg-slate-100 flex items-center justify-center shrink-0">
            {base.caregiverPhotoURL
              ? <img src={base.caregiverPhotoURL} alt={base.caregiverName} className="w-full h-full object-cover" />
              : <span className="text-slate-500 font-bold text-base">
                  {(base.caregiverName || 'C').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()}
                </span>
            }
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-slate-900 text-base">{base.caregiverName || 'Caregiver'}</p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {completedCount > 0 && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
                  <CheckCircle className="w-3 h-3" /> {completedCount} completed
                </span>
              )}
              {cancelledCount > 0 && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">
                  <XCircle className="w-3 h-3" /> {cancelledCount} cancelled
                </span>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={onMessage}
          className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 bg-white rounded-xl text-sm text-slate-600 hover:bg-slate-50 transition-colors shrink-0"
        >
          <MessageSquare className="w-4 h-4" /> Message
        </button>
      </div>

      {/* Shift history rows */}
      <div className="border-t border-slate-100 divide-y divide-slate-50">
        {preview.map(s => {
          const isCompleted = s.status === 'completed';
          const isOpen = expandedShiftId === s.id;
          const actualStart = fmtTs(s.startedAt);
          const actualEnd   = fmtTs(s.completedAt);
          const duration    = fmtDuration(s.startedAt, s.completedAt);
          return (
            <div key={s.id}>
              <div
                className={`px-5 py-3 flex items-center justify-between gap-3 ${isCompleted ? 'cursor-pointer hover:bg-slate-50' : ''}`}
                onClick={() => isCompleted && setExpandedShiftId(isOpen ? null : s.id)}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="text-center shrink-0 w-10">
                    <p className="text-xs font-bold text-slate-400 leading-tight">
                      {new Date(s.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}
                    </p>
                    <p className="text-sm font-semibold text-slate-600 leading-tight">
                      {new Date(s.date + 'T12:00:00').getDate()}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm text-slate-600">{fmtDate(s.date)}</p>
                    <p className="text-xs text-slate-400 flex items-center gap-1 mt-0.5">
                      <Clock className="w-3 h-3" />
                      {actualStart && actualEnd
                        ? `${actualStart} – ${actualEnd}${duration ? ` · ${duration}` : ''}`
                        : `${fmtTime(s.startTime)}${s.endTime ? ` – ${fmtTime(s.endTime)}` : ''}`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {s.paid && (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
                      <CheckCircle className="w-3 h-3" /> Paid
                    </span>
                  )}
                  <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${statusColor(s.status)}`}>
                    {statusLabel(s.status)}
                  </span>
                  {isCompleted && (
                    <span className="text-slate-400 text-xs">{isOpen ? '▲' : '▼'}</span>
                  )}
                </div>
              </div>
              {isCompleted && isOpen && (
                <div className="px-5 pb-4 pt-3 space-y-3 bg-slate-50 border-t border-slate-100">
                  {/* Scheduled + Started times */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-3 text-xs">
                      <span className="w-20 text-slate-400 shrink-0">Scheduled</span>
                      <span className="font-semibold text-slate-700">{fmtTime(s.startTime)}{s.endTime ? ` – ${fmtTime(s.endTime)}` : ''}</span>
                    </div>
                    {(actualStart || actualEnd) && (
                      <div className="flex items-center gap-3 text-xs">
                        <span className="w-20 text-slate-400 shrink-0">Started</span>
                        <span className="font-semibold text-slate-700">
                          {actualStart}
                          {actualEnd && <><span className="text-slate-400 font-normal"> · Ended </span>{actualEnd}</>}
                          {duration && <span className="text-primary-600 font-semibold"> · {duration}</span>}
                        </span>
                      </div>
                    )}
                  </div>
                  {/* Tasks per recipient — care plan card format */}
                  {(() => {
                    const doneRaw: string[] = s.tasksCompleted || [];
                    const recipients = (s.careRecipients || []) as Array<{ name: string; relationship?: string; age?: string; photoURL?: string | null; careNeeds?: string[]; careNeedDetails?: Record<string, string[]> }>;
                    const hasTasks = recipients.some(r => (r.careNeeds || []).length > 0) || (s.careNeeds || []).length > 0;
                    if (!hasTasks) return null;

                    let totalT = 0; let doneT = 0;
                    if (recipients.some(r => (r.careNeeds || []).length > 0)) {
                      recipients.forEach((r, ri) => {
                        (r.careNeeds || []).forEach(cat => {
                          const subs = (r.careNeedDetails || {})[cat] || [];
                          if (subs.length > 0) { totalT += subs.length; doneT += subs.filter((sub: string) => doneRaw.includes(`${ri}_${cat}_${sub}`)).length; }
                          else { totalT += 1; doneT += doneRaw.includes(`${ri}_${cat}`) ? 1 : 0; }
                        });
                      });
                    } else {
                      totalT = (s.careNeeds || []).length;
                      doneT = doneRaw.filter((k: string) => (s.careNeeds || []).includes(k)).length;
                    }

                    const renderCards = (careNeeds: string[], careNeedDetails: Record<string, string[]>, ri: number) => (
                      <div className="space-y-1.5">
                        {careNeeds.map((cat, ci) => {
                          const subs = careNeedDetails[cat] || [];
                          const doneSubCount = subs.filter((sub: string) => doneRaw.includes(`${ri}_${cat}_${sub}`)).length;
                          const catDone = subs.length > 0 ? doneSubCount === subs.length : doneRaw.includes(`${ri}_${cat}`);
                          return (
                            <div key={ci} className="border border-slate-200 rounded-xl overflow-hidden">
                              <div className={`flex items-center gap-2 px-3 py-2 ${catDone ? 'bg-green-50' : 'bg-slate-50'}`}>
                                <CheckCircle className={`w-3.5 h-3.5 shrink-0 ${catDone ? 'text-green-500' : 'text-slate-300'}`} />
                                <p className={`text-xs font-semibold flex-1 ${catDone ? 'text-green-700 line-through' : 'text-primary-600'}`}>{cat}</p>
                                {subs.length > 0 && doneSubCount > 0 && (
                                  <span className={`text-[10px] font-semibold ${catDone ? 'text-green-600' : 'text-slate-400'}`}>{doneSubCount}/{subs.length}</span>
                                )}
                              </div>
                              {subs.length > 0 && (
                                <div className="px-3 py-2 space-y-1">
                                  {subs.map((sub: string, si: number) => {
                                    const done = doneRaw.includes(`${ri}_${cat}_${sub}`);
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
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${doneT === totalT ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                              {doneT}/{totalT}
                            </span>
                          )}
                        </div>
                        {recipients.some(r => (r.careNeeds || []).length > 0)
                          ? recipients.map((r, ri) => {
                              const needs = r.careNeeds || [];
                              if (needs.length === 0) return null;
                              return (
                                <div key={ri} className="mb-3">
                                  {(
                                    <div className="flex items-center gap-2 mb-1.5">
                                      <div className="w-5 h-5 rounded-full overflow-hidden bg-primary-100 shrink-0 flex items-center justify-center">
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
                          : renderCards(s.careNeeds || [], {}, 0)}
                      </div>
                    );
                  })()}
                  {/* Visit notes — the caregiver's log during the visit (append-only, live) */}
                  {Array.isArray(s.notesLog) && s.notesLog.length > 0 && (
                    <div className="p-3 bg-white border border-slate-200 rounded-xl">
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Visit Notes</p>
                      <div className="space-y-1">
                        {s.notesLog.map((n, i) => (
                          <p key={i} className="text-xs text-slate-600">
                            <span className="text-slate-400 mr-1.5">{new Date(n.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>{n.text}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Caregiver notes */}
                  {s.completionNotes && (
                    <div className="p-3 bg-white border border-slate-200 rounded-xl">
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Caregiver Notes</p>
                      <p className="text-xs text-slate-600">{s.completionNotes}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {sorted.length > 2 && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="w-full py-2.5 text-xs text-slate-500 hover:text-slate-700 flex items-center justify-center gap-1 transition-colors"
          >
            {expanded
              ? <><ChevronUp className="w-3.5 h-3.5" /> Show less</>
              : <><ChevronDown className="w-3.5 h-3.5" /> Show {sorted.length - 2} more shifts</>
            }
          </button>
        )}
      </div>
    </div>
  );
};

// ─── Main page ────────────────────────────────────────────────────────────────

type Tab = 'requests' | 'active' | 'past';

export const ClientVisitsPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialTab = (['requests', 'active', 'past'].includes(searchParams.get('tab') ?? '') ? searchParams.get('tab') : 'active') as Tab;
  const [tab, setTab] = useState<Tab>(initialTab);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [pendingBookings, setPendingBookings] = useState<any[]>([]);
  const [pendingAmendments, setPendingAmendments] = useState<BookingAmendment[]>([]);
  const [pausedBookingIds, setPausedBookingIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const { gate, Modals: GateModals } = useAccessGates();

  const user = useAuthUser();

  // Accepted bookings — only for the membership-pause flag the shift generator writes.
  useEffect(() => {
    if (!user || !db) return;
    const unsub = db.collection('booking_requests')
      .where('clientId', '==', user.uid)
      .where('status', '==', 'accepted')
      .onSnapshot(snap => {
        setPausedBookingIds(new Set(snap.docs.filter(d => !!(d.data() as any).schedulePausedAt).map(d => d.id)));
      }, () => {});
    return unsub;
  }, [user?.uid]);

  useEffect(() => {
    if (!user || !db) { setLoading(false); return; }

    const bookingUnsub = db.collection('booking_requests')
      .where('clientId', '==', user.uid)
      .where('status', '==', 'pending')
      .onSnapshot(snap => {
        const loaded = snap.docs.map(d => ({ id: d.id, ...d.data() } as any));
        setPendingBookings(loaded);
        // Back-fill caregiverPhotoURL for requests saved without it
        const missing = loaded.filter((b: any) => !b.caregiverPhotoURL && !b.caregiverPhoto && b.caregiverId);
        if (missing.length > 0 && db) {
          const uniqueIds = [...new Set(missing.map((b: any) => b.caregiverId as string))];
          Promise.all(uniqueIds.map(async id => {
            const cSnap = await db!.collection('publicCaregiverProfiles').doc(id).get().catch(() => null);
            if (cSnap?.exists) {
              const d = cSnap.data() as any;
              const photo = d?.photo || d?.profilePhoto || d?.photoURL || d?.imageUrl || '';
              return [id, photo] as [string, string];
            }
            return [id, ''] as [string, string];
          })).then(entries => {
            const photoMap = Object.fromEntries(entries);
            setPendingBookings(prev => prev.map((b: any) =>
              (b.caregiverPhotoURL || b.caregiverPhoto) ? b : { ...b, caregiverPhotoURL: photoMap[b.caregiverId] || null }
            ));
          });
        }
      }, () => {});

    const unsub = db.collection('shifts')
      .where('clientId', '==', user.uid)
      .orderBy('date', 'desc')
      .onSnapshot(
        snap => {
          const loaded = snap.docs.map(d => ({ id: d.id, ...d.data() } as Shift));
          setShifts(loaded);
          setLoading(false);
          // Back-fill caregiverPhotoURL for shifts that are missing it
          const missing = loaded.filter(s => !s.caregiverPhotoURL && s.caregiverId);
          if (missing.length > 0 && db) {
            const uniqueIds = [...new Set(missing.map(s => s.caregiverId))];
            Promise.all(uniqueIds.map(async id => {
              const cSnap = await db!.collection('publicCaregiverProfiles').doc(id).get().catch(() => null);
              if (cSnap?.exists) {
                const d = cSnap.data() as any;
                const photo = d?.photo || d?.profilePhoto || d?.photoURL || d?.imageUrl || '';
                return [id, photo] as [string, string];
              }
              return [id, ''] as [string, string];
            })).then(entries => {
              const photoMap = Object.fromEntries(entries);
              setShifts(prev => prev.map(s =>
                s.caregiverPhotoURL ? s : { ...s, caregiverPhotoURL: photoMap[s.caregiverId] || null }
              ));
            });
          }
        },
        () => setLoading(false),
      );
    const amendUnsub = db.collection('booking_amendments')
      .where('clientId', '==', user.uid)
      .where('status', '==', 'pending')
      .onSnapshot(snap => {
        setPendingAmendments(snap.docs.map(d => ({ id: d.id, ...d.data() } as BookingAmendment)));
      }, () => {});

    return () => { unsub(); bookingUnsub(); amendUnsub(); };
  }, [user?.uid]);

  const handleCancelBooking = async (shiftId: string) => {
    if (!confirm('Cancel this booking and all upcoming scheduled visits?')) return;
    if (!db) return;
    const shiftSnap = await db.collection('shifts').doc(shiftId).get();
    const shiftData = shiftSnap.data() as any;
    const bookingRequestId: string | undefined = shiftData?.bookingRequestId;
    const caregiverId: string | undefined = shiftData?.caregiverId;

    const batch = db.batch();
    if (bookingRequestId) {
      const futureSnap = await db.collection('shifts')
        .where('bookingRequestId', '==', bookingRequestId)
        // 2026-09-14 (live-caught): 'scheduled' alone left a shift the
        // caregiver had already cancelled (status: 'needs_replacement')
        // completely untouched by this action — since the Active Bookings
        // list includes 'needs_replacement' shifts regardless of the
        // parent booking's own status, the card never disappeared even
        // though booking_requests was correctly marked cancelled below.
        .where('status', 'in', ['scheduled', 'needs_replacement'])
        .where('clientId', '==', user?.uid)
        .get();
      // Mark shifts as bulkCancelled so onShiftCancelled skips individual notifications
      futureSnap.docs.forEach(doc => batch.update(doc.ref, { status: 'cancelled', bulkCancelled: true }));
      await batch.commit();
      // onBookingRequestWrite Cloud Function fires here and notifies the caregiver
      await db.collection('booking_requests').doc(bookingRequestId).update({ status: 'cancelled' }).catch(() => {});
    } else {
      batch.update(db.collection('shifts').doc(shiftId), { status: 'cancelled', bulkCancelled: true });
      await batch.commit();
    }
    // Notification handled by onBookingRequestWrite Cloud Function
  };

  const handleCancelPendingBooking = async (bookingId: string) => {
    if (!db) return;
    const snap = await db.collection('booking_requests').doc(bookingId).get().catch(() => null);
    const data = snap?.data() as any;
    // onBookingRequestWrite Cloud Function fires and notifies the caregiver
    await db.collection('booking_requests').doc(bookingId).update({ status: 'cancelled' });
  };

  const handleSkipReplacement = async (shiftId: string) => {
    if (!db || !window.confirm('Skip this shift? No replacement caregiver will be arranged and it will be marked cancelled.')) return;
    await db.collection('shifts').doc(shiftId).update({
      status: 'cancelled',
      cancelledBy: 'client',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  };

  const [replacementShift, setReplacementShift] = useState<Shift | null>(null);

  const handleConfirmReplacement = async (
    shift: Shift,
    candidate: ReplacementCandidate,
    when: { date: string; startTime: string; endTime: string },
  ) => {
    if (!db || !user) return;
    const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayName = DAY_ABBR[new Date(when.date + 'T12:00:00').getDay()];
    const bookingRef = await db.collection('booking_requests').add({
      clientId: user.uid,
      clientName: user.displayName || '',
      caregiverId: candidate.caregiverId,
      caregiverName: candidate.name,
      caregiverPhotoURL: candidate.photoURL || null,
      address: shift.address || '',
      rate: candidate.hourlyRate ?? shift.rate ?? null,
      paymentMethod: 'credit',
      careNeeds: [...new Set((shift.careRecipients || []).flatMap(r => r.careNeeds || []))],
      careRecipients: shift.careRecipients || [],
      notes: shift.notes || null,
      emergencyContact: shift.emergencyContact || null,
      schedule: {
        days: [dayName],
        startDate: when.date,
        endDate: when.date,
        ongoing: false,
        dayShiftTimes: { [dayName]: [{ start: when.startTime, end: when.endTime || when.startTime }] },
      },
      isShiftReplacement: true,
      replacementForShiftId: shift.id,
      status: 'pending',
      isResend: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection('shifts').doc(shift.id).update({
      replacementRequestId: bookingRef.id,
      replacementCaregiverName: candidate.name,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    setReplacementShift(null);
  };

  const handleWithdrawReplacement = async (replacementRequestId: string) => {
    if (!db || !window.confirm('Cancel this request and choose a different caregiver?')) return;
    await db.collection('booking_requests').doc(replacementRequestId).update({
      status: 'cancelled',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  };

  const activeShifts = shifts.filter(s => s.status === 'scheduled' || s.status === 'in-progress' || s.status === 'needs_replacement');
  const pastShifts   = shifts.filter(s => s.status === 'completed'  || s.status === 'cancelled');

  function groupByBooking(list: Shift[]): Map<string, Shift[]> {
    const map = new Map<string, Shift[]>();
    list.forEach(s => {
      const key = s.bookingRequestId || s.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    });
    return map;
  }

  const activeGroups = groupByBooking(activeShifts);
  const pastGroups   = groupByBooking(pastShifts);
  const isEmpty = tab === 'requests' ? pendingBookings.length === 0 && pendingAmendments.length === 0 : tab === 'active' ? activeGroups.size === 0 : pastGroups.size === 0;

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <ClientNavigation />

      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-4">
          <h1 className="text-xl font-bold text-slate-900">My Bookings</h1>
          <p className="text-sm text-slate-500">Scheduled and past care bookings</p>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6">
        <div className="flex gap-2 mb-6 flex-wrap">
          {([
            { id: 'requests' as Tab, label: 'Requests', icon: <Clock className="w-4 h-4" />, badge: pendingBookings.length + pendingAmendments.length },
            { id: 'active'   as Tab, label: 'Active Bookings', icon: <CalendarCheck className="w-4 h-4" /> },
            { id: 'past'     as Tab, label: 'Past Bookings', icon: <History className="w-4 h-4" /> },
          ]).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'bg-primary-600 text-white'
                  : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
              }`}
            >
              {t.icon}{t.label}
              {t.badge ? (
                <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full leading-none ${tab === t.id ? 'bg-white text-primary-600' : 'bg-amber-100 text-amber-700'}`}>
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-7 h-7 animate-spin text-primary-500" />
          </div>
        ) : isEmpty ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center">
            <CalendarDays className="w-10 h-10 mx-auto mb-3 text-slate-300" />
            <p className="font-semibold text-slate-700 mb-1">
              {tab === 'requests' ? 'No pending requests' : tab === 'active' ? 'No active bookings' : 'No past bookings'}
            </p>
            <p className="text-sm text-slate-400">
              {tab === 'requests'
                ? 'Booking requests you send to caregivers will appear here.'
                : tab === 'active'
                ? 'Bookings will appear here once a caregiver accepts your request.'
                : 'Completed and cancelled bookings will appear here.'}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {tab === 'requests' && pendingBookings.map(b => (
              <PendingBookingCard
                key={b.id}
                booking={b}
                onCancel={handleCancelPendingBooking}
                navigate={navigate}
                onMessage={() => gate('message', b.caregiverName, () => navigate(`/client/inbox?caregiver=${b.caregiverId}`))}
              />
            ))}
            {tab === 'requests' && pendingAmendments.map(a => (
              <div key={a.id} className="bg-white border border-amber-200 rounded-2xl shadow-sm overflow-hidden">
                <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                      <span className="text-sm font-bold text-amber-700">
                        {(a.caregiverName || '?').charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div>
                      <p className="font-semibold text-slate-900">{a.caregiverName || 'Caregiver'}</p>
                      <p className="text-xs text-slate-400">Schedule change request · Awaiting response</p>
                    </div>
                  </div>
                  <span className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full shrink-0">
                    Awaiting response
                  </span>
                </div>
                <div className="border-t border-amber-100 bg-amber-50 px-5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="space-y-0.5 mb-1">
                        {ALL_DAYS_ORDER.filter(d => a.newDays?.[d]?.length).map(day => (
                          <p key={day} className="text-xs text-slate-700">
                            <span className="font-semibold">{day}</span>
                            {' · '}
                            {a.newDays[day].map((b: any) => `${fmtTime(b.start)} – ${fmtTime(b.end)}`).join(', ')}
                          </p>
                        ))}
                      </div>
                      <p className="text-xs text-slate-500 mt-1">
                        {a.startDate ? `Starts ${fmtDate(a.startDate)}` : 'Starts immediately'}
                        {a.ongoing ? ' · Ongoing' : a.endDate ? ` → ${fmtDate(a.endDate)}` : ''}
                      </p>
                      {a.notes && <p className="text-xs text-slate-400 italic mt-0.5">{a.notes}</p>}
                    </div>
                    <button
                      onClick={async () => {
                        if (!db) return;
                        // onBookingAmendmentWrite Cloud Function fires and notifies the caregiver
                        await db.collection('booking_amendments').doc(a.id).update({ status: 'cancelled' }).catch(() => {});
                      }}
                      className="px-3 py-1.5 border border-red-200 hover:bg-red-50 text-red-500 text-xs font-semibold rounded-xl transition-colors shrink-0 mt-0.5"
                    >
                      Cancel Request
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {tab === 'active' && Array.from(activeGroups.entries()).map(([key, groupShifts]) => (
              <ActiveVisitGroupCard
                key={key}
                shifts={groupShifts}
                onCancelBooking={handleCancelBooking}
                navigate={navigate}
                onMessage={() => gate('message', groupShifts[0]?.caregiverName, () => navigate(`/client/inbox?caregiver=${groupShifts[0]?.caregiverId}`))}
                onSkipReplacement={handleSkipReplacement}
                onFindReplacement={setReplacementShift}
                onWithdrawReplacement={handleWithdrawReplacement}
                schedulePaused={pausedBookingIds.has(String(groupShifts[0]?.bookingRequestId ?? ''))}
              />
            ))}
            {tab === 'past' && Array.from(pastGroups.entries()).map(([key, groupShifts]) => (
              <PastVisitGroupCard
                key={key}
                shifts={groupShifts}
                navigate={navigate}
                onMessage={() => gate('message', groupShifts[0]?.caregiverName, () => navigate(`/client/inbox?caregiver=${groupShifts[0]?.caregiverId}`))}
              />
            ))}
          </div>
        )}
      </main>
      {replacementShift && user && (
        <ReplacementPickerModal
          shift={replacementShift}
          clientUid={user.uid}
          onClose={() => setReplacementShift(null)}
          onConfirm={(candidate, when) => handleConfirmReplacement(replacementShift, candidate, when)}
        />
      )}
      <GateModals />
    </div>
  );
};
