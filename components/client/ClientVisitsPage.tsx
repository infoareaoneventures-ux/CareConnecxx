import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarCheck, History, MapPin, Clock, MessageSquare,
  XCircle, CalendarDays, Loader2, Repeat, CreditCard, Banknote,
  CheckCircle, ChevronDown, ChevronUp, AlertCircle, Phone, User,
} from 'lucide-react';
import { auth, db } from '../../lib/firebase';
import { ClientNavigation } from './ClientNavigation';

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

  const sorted = [...shifts].sort((a, b) => a.date.localeCompare(b.date));
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
    await db.collection('shifts').doc(shiftId).update({ status: 'cancelled' })
      .catch(() => {})
      .finally(() => setCancellingShift(null));
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
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Lifestyle</p>
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
                            <div className="flex flex-wrap gap-1">{ls.helpActivities.map(a => <span key={a} className="text-xs bg-amber-50 text-amber-700 border border-amber-100 px-2 py-0.5 rounded-full">{a}</span>)}</div>
                            {ls.helpActivitiesOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.helpActivitiesOther}</p>}
                          </div>
                        )}
                        {ls.entertainment && ls.entertainment.length > 0 && (
                          <div>
                            <p className="text-xs text-slate-400 mb-1">Entertainment</p>
                            <div className="flex flex-wrap gap-1">{ls.entertainment.map(a => <span key={a} className="text-xs bg-purple-50 text-purple-700 border border-purple-100 px-2 py-0.5 rounded-full">{a}</span>)}</div>
                            {ls.entertainmentOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.entertainmentOther}</p>}
                          </div>
                        )}
                        {(() => {
                          const tags = [
                            ls.enjoysConversation === true && 'Enjoys conversation',
                            ls.prefersQuiet === true && 'Prefers quiet',
                            ls.familyInArea === true && (ls.familyVisitFreq ? `Family in area · ${ls.familyVisitFreq}` : 'Family in area'),
                            ls.friendsVisitors === true && (ls.friendsVisitFreq ? `Friends or visitors · ${ls.friendsVisitFreq}` : 'Friends or visitors'),
                            ls.hasAppointments === true && 'Has appointments',
                          ].filter(Boolean) as string[];
                          return tags.length > 0
                            ? <div className="flex flex-wrap gap-1">{tags.map(t => <span key={t} className="text-xs bg-slate-100 text-slate-600 border border-slate-200 px-2 py-0.5 rounded-full">{t}</span>)}</div>
                            : null;
                        })()}
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
          {preview.map(s => (
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
              <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border shrink-0 ${statusColor(s.status)}`}>
                {statusLabel(s.status)}
              </span>
            </div>
          ))}
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
  const sorted = [...shifts].sort((a, b) => b.date.localeCompare(a.date));

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

type Tab = 'active' | 'past';

export const ClientVisitsPage: React.FC = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('active');
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);

  const user = auth?.currentUser;

  useEffect(() => {
    if (!user || !db) { setLoading(false); return; }
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
    return () => unsub();
  }, [user?.uid]);

  const handleCancelBooking = async (shiftId: string) => {
    if (!confirm('Cancel this booking and all upcoming scheduled visits?')) return;
    if (!db) return;
    const shiftSnap = await db.collection('shifts').doc(shiftId).get();
    const shiftData = shiftSnap.data() as any;
    const bookingRequestId: string | undefined = shiftData?.bookingRequestId;

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
  const isEmpty = tab === 'active' ? activeGroups.size === 0 : pastGroups.size === 0;

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
        <div className="flex gap-2 mb-6">
          {([
            { id: 'active' as Tab, label: 'Active Bookings', icon: <CalendarCheck className="w-4 h-4" /> },
            { id: 'past'   as Tab, label: 'Past Bookings', icon: <History className="w-4 h-4" /> },
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
              {tab === 'active' ? 'No active bookings' : 'No past bookings'}
            </p>
            <p className="text-sm text-slate-400">
              {tab === 'active'
                ? 'Bookings will appear here once a caregiver accepts your request.'
                : 'Completed and cancelled bookings will appear here.'}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {tab === 'active'
              ? Array.from(activeGroups.entries()).map(([key, groupShifts]) => (
                  <ActiveVisitGroupCard
                    key={key}
                    shifts={groupShifts}
                    onCancelBooking={handleCancelBooking}
                    navigate={navigate}
                  />
                ))
              : Array.from(pastGroups.entries()).map(([key, groupShifts]) => (
                  <PastVisitGroupCard
                    key={key}
                    shifts={groupShifts}
                    navigate={navigate}
                  />
                ))
            }
          </div>
        )}
      </main>
    </div>
  );
};
