import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CalendarCheck, History, MapPin, Clock, MessageSquare,
  XCircle, CalendarDays, Loader2, Repeat, CreditCard, Banknote,
  CheckCircle, ChevronDown, ChevronUp, AlertCircle, Phone, User,
} from 'lucide-react';
import { auth, db } from '../../lib/firebase';
import { ClientNavigation } from './ClientNavigation';
import { shiftDisplayStatus, shiftStatusBadgeClass, shiftStatusLabel } from '../../utils/shiftUtils';

interface Shift {
  id: string;
  caregiverId: string;
  caregiverName?: string;
  caregiverPhotoURL?: string | null;
  clientId: string;
  date: string;
  startTime: string;
  endTime?: string;
  status: 'scheduled' | 'in-progress' | 'completed' | 'cancelled';
  address?: string;
  notes?: string;
  completionNotes?: string;
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

function fmtTime(t?: string): string {
  if (!t) return '';
  const clean = t.startsWith('~') ? t.slice(1) : t;
  return new Date(`2000-01-01T${clean}`).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function weeklyScheduleSummary(shift: Shift): string {
  const dst = shift.schedule?.dayShiftTimes;
  if (!dst || Object.keys(dst).length === 0) return '';
  return DAY_ORDER
    .filter(d => dst[d]?.length)
    .map(d => {
      const times = dst[d].map(b => `${fmtTime(b.start)}–${fmtTime(b.end)}`).join(', ');
      return `${d} ${times}`;
    })
    .join(' · ');
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
}

const PendingBookingCard: React.FC<PendingBookingCardProps> = ({ booking, onCancel, navigate }) => {
  const [cancelling, setCancelling] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const schedule = (() => {
    const dst = booking.schedule?.dayShiftTimes;
    if (!dst || Object.keys(dst).length === 0) return '';
    return DAY_ORDER
      .filter(d => dst[d]?.length)
      .map(d => {
        const times = dst[d].map((b: any) => `${fmtTime(b.start)}–${fmtTime(b.end)}`).join(', ');
        return `${d} ${times}`;
      })
      .join(' · ');
  })();

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
          onClick={() => navigate(`/client/inbox?caregiver=${booking.caregiverId}`)}
          className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 bg-white rounded-xl text-sm text-slate-600 hover:bg-slate-50 transition-colors shrink-0"
        >
          <MessageSquare className="w-4 h-4" /> Message
        </button>
      </div>

      {/* Booking details */}
      <div className="px-5 pb-4 space-y-2 border-t border-slate-50 pt-3">
        {schedule && (
          <div className="flex items-start gap-2 text-sm text-slate-700">
            <CalendarDays className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
            <span>{schedule}</span>
          </div>
        )}
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
              <span className="text-slate-400"> · {booking.paymentMethod === 'credit' ? 'Card' : 'Cash'}</span>
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
      {(booking.careRecipients?.length > 0 || booking.emergencyContact) && (
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

// ─── Active visit group card (one per booking) ──────────────────────────────

interface ActiveVisitGroupCardProps {
  shifts: Shift[];
  onCancelBooking: (shiftId: string) => Promise<void>;
  navigate: ReturnType<typeof useNavigate>;
}

const ActiveVisitGroupCard: React.FC<ActiveVisitGroupCardProps> = ({ shifts, onCancelBooking, navigate }) => {
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
  const schedule = weeklyScheduleSummary(base);

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
      await db.collection('shifts').doc(shiftId).update({ status: 'cancelled' });
      if (base.caregiverId) {
        await db.collection('users').doc(base.caregiverId).collection('notifications').add({
          userId: base.caregiverId,
          type: 'booking',
          title: 'Shift Cancelled',
          body: `A client cancelled one of your shifts.`,
          isRead: false,
          createdAt: new Date().toISOString(),
        }).catch(() => {});
      }
    } catch {
      // non-critical
    } finally {
      setCancellingShift(null);
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
            </div>
          </div>
        </div>
        <button
          onClick={() => navigate(`/client/inbox?caregiver=${base.caregiverId}`)}
          className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 bg-white rounded-xl text-sm text-slate-600 hover:bg-slate-50 transition-colors shrink-0"
        >
          <MessageSquare className="w-4 h-4" /> Message
        </button>
      </div>

      {/* Shared booking details */}
      <div className="px-5 pb-4 space-y-2 border-t border-slate-50 pt-3">
        {schedule && (
          <div className="flex items-start gap-2 text-sm text-slate-700">
            <CalendarDays className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
            <span>{schedule}</span>
          </div>
        )}
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
              <span className="text-slate-400"> · {base.paymentMethod === 'credit' ? 'Card' : 'Cash'}</span>
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
            return (
            <div key={s.id} className="px-5 py-3 flex items-center gap-3">
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
                </div>
              </div>
              <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border shrink-0 ${shiftStatusBadgeClass(ds)}`}>
                {shiftStatusLabel(ds)}
              </span>
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
}

const PastVisitGroupCard: React.FC<PastVisitGroupCardProps> = ({ shifts, navigate }) => {
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
          onClick={() => navigate(`/client/inbox?caregiver=${base.caregiverId}`)}
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
  const [loading, setLoading] = useState(true);

  const user = auth?.currentUser;

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
            const cSnap = await db!.collection('caregivers').doc(id).get().catch(() => null);
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
              const cSnap = await db!.collection('caregivers').doc(id).get().catch(() => null);
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
        .where('status', '==', 'scheduled')
        .where('clientId', '==', user?.uid)
        .get();
      futureSnap.docs.forEach(doc => batch.update(doc.ref, { status: 'cancelled' }));
      await batch.commit();
      await db.collection('booking_requests').doc(bookingRequestId).update({ status: 'cancelled' }).catch(() => {});
    } else {
      batch.update(db.collection('shifts').doc(shiftId), { status: 'cancelled' });
      await batch.commit();
    }

    if (caregiverId) {
      await db.collection('users').doc(caregiverId).collection('notifications').add({
        userId: caregiverId,
        type: 'booking',
        title: 'Booking Cancelled',
        body: `${user?.displayName || 'A client'} has cancelled their booking.`,
        isRead: false,
        createdAt: new Date().toISOString(),
      }).catch(() => {});
    }
  };

  const handleCancelPendingBooking = async (bookingId: string) => {
    if (!db) return;
    const snap = await db.collection('booking_requests').doc(bookingId).get().catch(() => null);
    const data = snap?.data() as any;
    await db.collection('booking_requests').doc(bookingId).update({ status: 'cancelled' });
    if (data?.caregiverId) {
      await db.collection('users').doc(data.caregiverId).collection('notifications').add({
        userId: data.caregiverId,
        type: 'booking',
        title: 'Booking Request Cancelled',
        body: `${user?.displayName || 'A client'} has cancelled their booking request.`,
        isRead: false,
        createdAt: new Date().toISOString(),
      }).catch(() => {});
    }
  };

  const activeShifts = shifts.filter(s => s.status === 'scheduled' || s.status === 'in-progress');
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
            {/* Contextual capability hint — tied to this surface (booking a visit). */}
            {tab !== 'past' && (
              <div className="mt-5 inline-flex items-start gap-2 text-left text-sm text-slate-500 bg-primary-50 border border-primary-100 rounded-xl px-4 py-3 max-w-md">
                <MessageSquare className="w-4 h-4 mt-0.5 text-primary-500 shrink-0" />
                <span>
                  Try texting Cara <span className="font-medium text-slate-700">“book a visit for next Monday morning”</span> or{' '}
                  <span className="font-medium text-slate-700">“find me a backup caregiver”</span> — she'll set it up for you.
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {tab === 'requests' && pendingBookings.map(b => (
              <PendingBookingCard
                key={b.id}
                booking={b}
                onCancel={handleCancelPendingBooking}
                navigate={navigate}
              />
            ))}
            {tab === 'requests' && pendingAmendments.map(a => (
              <div key={a.id} className="bg-white border border-amber-200 rounded-2xl shadow-sm overflow-hidden">
                <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                      <span className="text-sm font-bold text-amber-700">
                        {(a.caregiverName ?? '?')[0].toUpperCase()}
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
              />
            ))}
            {tab === 'past' && Array.from(pastGroups.entries()).map(([key, groupShifts]) => (
              <PastVisitGroupCard
                key={key}
                shifts={groupShifts}
                navigate={navigate}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
};
