import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays, Clock, MapPin, User, CheckCircle, XCircle,
  Loader2, MessageSquare, Star, Banknote, CreditCard, ChevronDown,
  ChevronUp, Phone, AlertCircle, Repeat, FileText,
} from 'lucide-react';
import { CaregiverTopNav } from './CaregiverTopNav';
import { useCareConnex } from '../../context/CareConnexContext';
import { db } from '../../lib/firebase';
import firebase from '../../lib/firebase';

const ALL_DAYS_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function nextOccurrence(fromDate: string, dayName: string): string {
  const target = ALL_DAYS_ORDER.indexOf(dayName);
  if (target === -1) return fromDate;
  const base = new Date(fromDate + 'T12:00:00');
  const diff = (target - base.getDay() + 7) % 7;
  base.setDate(base.getDate() + diff);
  return base.toISOString().split('T')[0];
}

type Tab = 'requests' | 'active' | 'past';

interface RecipientLifestyle {
  favoriteActivities?: string[];
  favoriteActivitiesOther?: string;
  helpActivities?: string[];
  helpActivitiesOther?: string;
  entertainment?: string[];
  entertainmentOther?: string;
  enjoysConversation?: boolean | null;
  prefersQuiet?: boolean | null;
  familyInArea?: boolean | null;
  familyVisitFreq?: string;
  friendsVisitors?: boolean | null;
  friendsVisitFreq?: string;
  hasAppointments?: boolean | null;
  appointmentsDetails?: string;
}

interface CareRecipient {
  name: string;
  relationship?: string;
  age?: string;
  photoURL?: string;
  careNeeds?: string[];
  careNeedDetails?: Record<string, string[]>;
  lifestyle?: RecipientLifestyle | null;
}

interface BookingRequest {
  id: string;
  clientId: string;
  clientName: string;
  clientPhotoURL?: string | null;
  clientRating?: number;
  careRecipients?: Array<CareRecipient | string>;
  careNeeds?: string[];
  tasks?: string[];
  schedule?: {
    days?: string[];
    startTime?: string;
    endTime?: string;
    startDate?: string;
    endDate?: string;
    ongoing?: boolean;
    dayShiftTimes?: Record<string, Array<{ start: string; end: string; label?: string }>>;
  };
  address?: string;
  rate?: number;
  paymentMethod?: string;
  lifestylePreferences?: string[];
  emergencyContact?: { name?: string; phone?: string; relationship?: string };
  notes?: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt?: any;
}

interface Shift {
  id: string;
  clientId: string;
  clientName?: string;
  clientPhotoURL?: string | null;
  caregiverId: string;
  caregiverName?: string;
  caregiverPhotoURL?: string | null;
  date: string;
  startTime: string;
  endTime?: string;
  status: 'scheduled' | 'in-progress' | 'completed' | 'cancelled';
  address?: string;
  lifestylePreferences?: string[];
  schedule?: {
    startDate?: string;
    endDate?: string;
    ongoing?: boolean;
    dayShiftTimes?: Record<string, Array<{ start: string; end: string; label?: string }>>;
  } | null;
  notes?: string;
  careRecipients?: Array<{
    name: string;
    relationship?: string;
    age?: string;
    photoURL?: string | null;
    careNeeds?: string[];
    careNeedDetails?: Record<string, string[]>;
    lifestyle?: RecipientLifestyle | null;
  }>;
  emergencyContact?: { name?: string; phone?: string; relationship?: string } | null;
  tasksCompleted?: string[];
  paid?: boolean;
  rate?: number | null;
  paymentMethod?: string | null;
  recurringWeekly?: boolean;
  bookingRequestId?: string;
}

const ALL_DAYS_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Returns the date string (YYYY-MM-DD) of the first occurrence of dayName on or after startDate
function nextOccurrence(startDate: string, dayName: string): string {
  const target = ALL_DAYS_ORDER.indexOf(dayName);
  if (target === -1) return startDate;
  const base = new Date(startDate + 'T12:00:00');
  const diff = (target - base.getDay() + 7) % 7;
  base.setDate(base.getDate() + diff);
  return base.toISOString().split('T')[0];
}

function fmtDate(d: string) {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

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

function fmtTime(t?: string) {
  if (!t) return '';
  const nextDay = t.startsWith('~');
  const raw = nextDay ? t.slice(1) : t;
  try {
    const formatted = new Date(`2000-01-01T${raw}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return nextDay ? `${formatted} (next day)` : formatted;
  } catch { return raw; }
}

const statusBadge = (status: Shift['status']) => {
  switch (status) {
    case 'scheduled':   return 'bg-blue-100 text-blue-700 border-blue-200';
    case 'in-progress': return 'bg-green-100 text-green-700 border-green-200';
    case 'completed':   return 'bg-slate-100 text-slate-600 border-slate-200';
    case 'cancelled':   return 'bg-red-100 text-red-600 border-red-200';
  }
};

const ClientAvatar: React.FC<{ photoURL?: string | null; name?: string; size?: string; textColor?: string }> = ({
  photoURL, name, size = 'w-12 h-12', textColor = 'text-primary-700',
}) => {
  const [err, setErr] = useState(false);
  const initials = (name || 'C').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className={`${size} rounded-full overflow-hidden bg-primary-100 flex items-center justify-center shrink-0`}>
      {photoURL && !err
        ? <img src={photoURL} alt={name} className="w-full h-full object-cover" onError={() => setErr(true)} />
        : <span className={`${textColor} font-bold text-base`}>{initials}</span>
      }
    </div>
  );
};

const pillTab = (active: boolean) =>
  `inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
    active ? 'bg-primary-500 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
  }`;

// ── Booking Request Card ────────────────────────────────────────────────────

const RequestCard: React.FC<{
  req: BookingRequest;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
  submitting: boolean;
}> = ({ req, onAccept, onDecline, submitting }) => {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);

  const isPending = req.status === 'pending';

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      {/* Header */}
      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-3 min-w-0">
            <ClientAvatar photoURL={req.clientPhotoURL} name={req.clientName} size="w-10 h-10" />
            <div className="min-w-0">
              <p className="font-semibold text-slate-900">{req.clientName}</p>
              {req.clientRating != null && (
                <span className="flex items-center gap-1 text-xs text-amber-500 font-medium">
                  <Star className="w-3 h-3 fill-amber-400 stroke-amber-400" />
                  {req.clientRating.toFixed(1)} client rating
                </span>
              )}
            </div>
          </div>
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full flex-shrink-0 ${
            isPending ? 'bg-amber-100 text-amber-700' :
            req.status === 'accepted' ? 'bg-green-100 text-green-700' :
            'bg-red-100 text-red-600'
          }`}>
            {req.status.charAt(0).toUpperCase() + req.status.slice(1)}
          </span>
        </div>

        {/* Quick info row */}
        {(() => {
          const isCard = req.paymentMethod === 'credit' || req.paymentMethod?.toLowerCase() === 'card';
          const dayShiftTimes = req.schedule?.dayShiftTimes;
          const orderedDays = dayShiftTimes
            ? ALL_DAYS_ORDER.filter(d => dayShiftTimes[d]?.some(b => b.start && b.end))
            : [];
          return (
            <div className="space-y-1.5 text-sm text-slate-600 mb-4">
              {req.schedule?.startDate && (
                <div className="flex items-center gap-2">
                  <CalendarDays className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  <span>Starts {fmtDate(req.schedule.startDate)}</span>
                </div>
              )}
              {(req.schedule?.ongoing || req.schedule?.endDate) && (
                <div className="flex items-center gap-2">
                  <Repeat className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  {req.schedule.ongoing
                    ? <span className="text-xs font-semibold bg-teal-50 text-teal-700 border border-teal-200 px-2.5 py-1 rounded-full">Ongoing</span>
                    : <span>Ends {fmtDate(req.schedule.endDate!)}</span>}
                </div>
              )}
              {orderedDays.length > 0 ? (
                <div className="flex items-start gap-2">
                  <Clock className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    {orderedDays.map(day =>
                      dayShiftTimes![day].filter(b => b.start && b.end).map((b, i) => {
                        const mins = calcShiftMins(b.start, b.end);
                        return (
                          <div key={`${day}-${i}`}>
                            <span className="font-medium w-9 inline-block">{day}</span>
                            {fmtTime(b.start)} – {fmtTime(b.end)}
                            {mins > 0 && <span className="text-xs text-slate-400 ml-1.5">({fmtHours(mins)})</span>}
                          </div>
                        );
                      })
                    )}
                    {(() => {
                      const totalMins = orderedDays.reduce((sum, day) =>
                        sum + (dayShiftTimes![day]?.filter(b => b.start && b.end).reduce((s, b) => s + calcShiftMins(b.start, b.end), 0) || 0), 0);
                      return totalMins > 0 ? (
                        <div className="text-xs font-semibold text-slate-500 mt-1 pt-1 border-t border-slate-100">
                          {fmtHours(totalMins)} / week
                        </div>
                      ) : null;
                    })()}
                  </div>
                </div>
              ) : req.schedule?.days?.length ? (
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  <span>{req.schedule.days.join(', ')}</span>
                </div>
              ) : null}
              {req.address && (
                <div className="flex items-start gap-2">
                  <MapPin className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <span>{req.address}</span>
                    {req.lifestylePreferences && req.lifestylePreferences.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {req.lifestylePreferences.map(p => (
                          <span key={p} className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded-full font-medium">{p}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {req.rate != null && (
                <div className="flex items-center gap-2">
                  {isCard
                    ? <CreditCard className="w-4 h-4 text-slate-400 flex-shrink-0" />
                    : <Banknote className="w-4 h-4 text-slate-400 flex-shrink-0" />}
                  <span className="font-semibold text-slate-800">
                    ${req.rate}/hr · {isCard ? 'Card' : 'Cash'}
                  </span>
                  <span className="text-xs text-slate-400">(agreed rate)</span>
                </div>
              )}
            </div>
          );
        })()}


        {/* Expand/collapse */}
        <button
          onClick={() => setExpanded(e => !e)}
          className="flex items-center gap-1 text-xs text-primary-600 font-medium hover:text-primary-700 mb-4"
        >
          {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          {expanded ? 'Show less' : 'View full details'}
        </button>

        {expanded && (
          <div className="space-y-3 mb-4 border-t border-slate-100 pt-4">
            {/* Care recipients */}
            {req.careRecipients && req.careRecipients.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Care Recipient{req.careRecipients.length > 1 ? 's' : ''}</p>
                <div className="space-y-4">
                  {req.careRecipients.map((r: any, i: number) => {
                    const name = typeof r === 'string' ? r : r.name;
                    const relationship = typeof r === 'object' ? r.relationship : undefined;
                    const age = typeof r === 'object' ? r.age : undefined;
                    const photoURL = typeof r === 'object' ? r.photoURL : undefined;
                    const careNeeds: string[] = typeof r === 'object' ? (r.careNeeds || []) : [];
                    const careNeedDetails: Record<string, string[]> = typeof r === 'object' ? (r.careNeedDetails || {}) : {};
                    const lifestyle: RecipientLifestyle | null = typeof r === 'object' ? (r.lifestyle || null) : null;
                    const boolPrefs = lifestyle ? [
                      lifestyle.enjoysConversation === true && 'Enjoys conversation',
                      lifestyle.prefersQuiet === true && 'Prefers quiet',
                      lifestyle.familyInArea === true && (lifestyle.familyVisitFreq ? `Family in area · ${lifestyle.familyVisitFreq}` : 'Family in area'),
                      lifestyle.friendsVisitors === true && (lifestyle.friendsVisitFreq ? `Friends or visitors · ${lifestyle.friendsVisitFreq}` : 'Friends or visitors'),
                      lifestyle.hasAppointments === true && 'Has appointments',
                    ].filter(Boolean) as string[] : [];
                    const hasLifestyle = !!lifestyle && (
                      (lifestyle.favoriteActivities?.length || 0) > 0 ||
                      (lifestyle.helpActivities?.length || 0) > 0 ||
                      (lifestyle.entertainment?.length || 0) > 0 ||
                      boolPrefs.length > 0
                    );
                    return (
                      <div key={i} className="pl-3 border-l-2 border-primary-200 space-y-2.5">
                        {/* Recipient header */}
                        <div className="flex items-center gap-2.5">
                          {photoURL ? (
                            <div className="w-9 h-9 rounded-full overflow-hidden border border-slate-200 flex-shrink-0">
                              <img src={photoURL} alt={name} className="w-full h-full object-cover" />
                            </div>
                          ) : (
                            <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0">
                              <span className="text-primary-700 font-bold text-sm">{name?.charAt(0).toUpperCase() || '?'}</span>
                            </div>
                          )}
                          <div>
                            <p className="text-sm font-semibold text-slate-800">{name}</p>
                            {(relationship || age) && (
                              <p className="text-xs text-slate-400">{[relationship, age ? `Age ${age}` : ''].filter(Boolean).join(' · ')}</p>
                            )}
                          </div>
                        </div>

                        {/* Care plan — each category as its own card */}
                        {careNeeds.length > 0 && (
                          <div className="space-y-2">
                            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Care Plan</p>
                            {careNeeds.map((n: string) => {
                              const subtasks = careNeedDetails[n] || [];
                              return (
                                <div key={n} className="rounded-xl border border-blue-200 overflow-hidden">
                                  <div className="bg-blue-50 px-3 py-2">
                                    <span className="text-xs font-semibold text-blue-700">{n}</span>
                                  </div>
                                  {subtasks.length > 0 && (
                                    <div className="px-3 py-2 flex flex-wrap gap-1.5">
                                      {subtasks.map((t: string) => (
                                        <span key={t} className="text-xs bg-white text-slate-600 border border-slate-200 px-2.5 py-0.5 rounded-full">{t}</span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Lifestyle & Preferences */}
                        {hasLifestyle && (
                          <div className="space-y-1.5">
                            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Lifestyle & Preferences</p>
                            {(lifestyle!.favoriteActivities || []).length > 0 && (
                              <div>
                                <p className="text-[10px] text-slate-400 mb-0.5">Enjoys</p>
                                <div className="flex flex-wrap gap-1">
                                  {lifestyle!.favoriteActivities!.map(a => <span key={a} className="text-[10px] bg-green-50 text-green-700 border border-green-100 px-2 py-0.5 rounded-full">{a}</span>)}
                                </div>
                                {lifestyle!.favoriteActivitiesOther && <p className="text-[10px] text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {lifestyle!.favoriteActivitiesOther}</p>}
                              </div>
                            )}
                            {(lifestyle!.helpActivities || []).length > 0 && (
                              <div>
                                <p className="text-[10px] text-slate-400 mb-0.5">Needs help with</p>
                                <div className="flex flex-wrap gap-1">
                                  {lifestyle!.helpActivities!.map(a => <span key={a} className="text-[10px] bg-orange-50 text-orange-700 border border-orange-100 px-2 py-0.5 rounded-full">{a}</span>)}
                                </div>
                                {lifestyle!.helpActivitiesOther && <p className="text-[10px] text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {lifestyle!.helpActivitiesOther}</p>}
                              </div>
                            )}
                            {(lifestyle!.entertainment || []).length > 0 && (
                              <div>
                                <p className="text-[10px] text-slate-400 mb-0.5">Entertainment</p>
                                <div className="flex flex-wrap gap-1">
                                  {lifestyle!.entertainment!.map(e => <span key={e} className="text-[10px] bg-pink-50 text-pink-700 border border-pink-100 px-2 py-0.5 rounded-full">{e}</span>)}
                                </div>
                                {lifestyle!.entertainmentOther && <p className="text-[10px] text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {lifestyle!.entertainmentOther}</p>}
                              </div>
                            )}
                            {boolPrefs.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {boolPrefs.map(p => <span key={p} className="text-[10px] bg-slate-100 text-slate-600 border border-slate-200 px-2 py-0.5 rounded-full">{p}</span>)}
                              </div>
                            )}
                            {lifestyle?.hasAppointments === true && lifestyle?.appointmentsDetails && (
                              <p className="text-[10px] text-slate-500"><span className="font-medium text-slate-400">Appointments:</span> {lifestyle.appointmentsDetails}</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Emergency contact */}
            {req.emergencyContact?.name && (
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Emergency Contact</p>
                <div className="flex items-center gap-2 text-sm text-slate-700">
                  <Phone className="w-3.5 h-3.5 text-slate-400" />
                  <span>{req.emergencyContact.name}{req.emergencyContact.relationship ? ` (${req.emergencyContact.relationship})` : ''}</span>
                  {req.emergencyContact.phone && <span className="text-slate-500">· {req.emergencyContact.phone}</span>}
                </div>
              </div>
            )}

            {/* Notes */}
            {req.notes && (
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Notes</p>
                <p className="text-sm text-slate-600 bg-slate-50 rounded-xl px-3 py-2">{req.notes}</p>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(`/caregiver/inbox?client=${req.clientId}`)}
            className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <MessageSquare className="w-4 h-4" /> Message
          </button>
          {isPending && (
            <>
              <button
                onClick={() => onDecline(req.id)}
                disabled={submitting}
                className="flex items-center gap-1.5 px-4 py-2 border border-red-200 text-red-600 rounded-xl text-sm font-medium hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                <XCircle className="w-4 h-4" /> Decline
              </button>
              <button
                onClick={() => onAccept(req.id)}
                disabled={submitting}
                className="flex items-center gap-1.5 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50 transition-colors"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                Accept
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Booking Group Card (Active Bookings) ────────────────────────────────────

const BookingGroupCard: React.FC<{
  shifts: Shift[];
  onCancel: (id: string) => void;
}> = ({ shifts, onCancel }) => {
  const navigate = useNavigate();
  const base = shifts[0];
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [expandedShift, setExpandedShift] = useState<string | null>(null);
  const [tasksByShift, setTasksByShift] = useState<Record<string, string[]>>(
    () => Object.fromEntries(shifts.map(s => [s.id, s.tasksCompleted || []]))
  );
  const [submitting, setSubmitting] = useState<string | null>(null);

  const handleStart = async (shiftId: string) => {
    if (!db) return;
    setSubmitting(shiftId);
    await db.collection('shifts').doc(shiftId).update({
      status: 'in-progress',
      startedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {}).finally(() => setSubmitting(null));
  };

  const handleEnd = async (shiftId: string) => {
    if (!db) return;
    setSubmitting(shiftId);
    await db.collection('shifts').doc(shiftId).update({
      status: 'completed',
      endedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {}).finally(() => setSubmitting(null));
  };

  const handleCancelShift = async (shiftId: string) => {
    if (!db || !window.confirm('Cancel this shift only? The rest of your booking stays active.')) return;
    setSubmitting(shiftId);
    await db.collection('shifts').doc(shiftId).update({
      status: 'cancelled',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {}).finally(() => setSubmitting(null));
  };

  const toggleTask = async (shiftId: string, key: string) => {
    const shift = shifts.find(s => s.id === shiftId);
    if (!shift || shift.status !== 'in-progress') return;
    const prev = tasksByShift[shiftId] || [];
    const next = prev.includes(key) ? prev.filter(t => t !== key) : [...prev, key];
    setTasksByShift(p => ({ ...p, [shiftId]: next }));
    if (db) await db.collection('shifts').doc(shiftId).update({ tasksCompleted: next }).catch(() => {});
  };

  const recipients = base.careRecipients || [];
  const ec = base.emergencyContact;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">

      {/* ── Header ── */}
      <div className="px-5 pt-5 pb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <ClientAvatar photoURL={base.clientPhotoURL} name={base.clientName} />
          <div className="min-w-0">
            <p className="font-semibold text-slate-900 text-base">{base.clientName || 'Client'}</p>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-violet-700 bg-violet-50 border border-violet-200 px-2.5 py-0.5 rounded-full mt-0.5">
              <Repeat className="w-3 h-3" /> Ongoing
            </span>
          </div>
        </div>
        <button
          onClick={() => navigate(`/caregiver/inbox?client=${base.clientId}`)}
          className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 transition-colors shrink-0"
        >
          <MessageSquare className="w-4 h-4" /> Message
        </button>
      </div>

      {/* ── Shared info ── */}
      <div className="px-5 pb-4 space-y-2">
        {/* Weekly schedule */}
        {base.schedule?.dayShiftTimes && Object.keys(base.schedule.dayShiftTimes).length > 0 && (
          <div className="flex items-start gap-2 text-sm text-slate-700">
            <CalendarDays className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              {base.schedule.startDate && (
                <p className="text-xs text-slate-400 mb-1">
                  Starts {fmtDate(base.schedule.startDate)}
                  {base.schedule.ongoing
                    ? <span className="ml-1.5 text-[10px] font-semibold bg-teal-50 text-teal-700 border border-teal-200 px-1.5 py-0.5 rounded-full">Ongoing</span>
                    : base.schedule.endDate ? ` → ${fmtDate(base.schedule.endDate)}` : ''}
                </p>
              )}
              {ALL_DAYS_ORDER.filter(d => base.schedule!.dayShiftTimes![d]?.length).map(day => {
                const blocks = base.schedule!.dayShiftTimes![day];
                const mins = blocks.reduce((s, b) => s + calcShiftMins(b.start, b.end), 0);
                return (
                  <div key={day} className="flex items-center gap-2">
                    <span className="w-8 text-xs font-semibold text-slate-500">{day}</span>
                    <span className="text-xs text-slate-700">{blocks.map(b => `${fmtTime(b.start)} – ${fmtTime(b.end)}`).join(', ')}</span>
                    {mins > 0 && <span className="text-[10px] text-primary-600 font-semibold ml-auto">{fmtHours(mins)}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {base.address && (
          <div className="flex items-start gap-2 text-sm text-slate-700">
            <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
            <div>
              <span>{base.address}</span>
              {base.lifestylePreferences && base.lifestylePreferences.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {base.lifestylePreferences.map(p => (
                    <span key={p} className="text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full">{p}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {base.rate != null && (
          <div className="flex items-center gap-2 text-sm text-slate-700">
            {base.paymentMethod === 'credit'
              ? <CreditCard className="w-4 h-4 text-slate-400 shrink-0" />
              : <Banknote className="w-4 h-4 text-slate-400 shrink-0" />}
            <span><span className="font-semibold">${base.rate}/hr</span><span className="text-slate-400"> · {base.paymentMethod === 'credit' ? 'Card' : 'Cash'}</span></span>
          </div>
        )}
        {base.notes && (
          <div className="flex items-start gap-2 text-sm text-slate-500">
            <FileText className="w-4 h-4 text-slate-300 shrink-0 mt-0.5" />
            <span>{base.notes}</span>
          </div>
        )}
      </div>

      {/* ── Details toggle (care plan, lifestyle, emergency) ── */}
      {(recipients.length > 0 || ec) && (
        <button
          type="button"
          onClick={() => setDetailsOpen(o => !o)}
          className="w-full px-5 py-2.5 border-t border-slate-100 flex items-center justify-between text-sm text-primary-600 font-medium hover:bg-slate-50 transition-colors"
        >
          <span>{detailsOpen ? 'Hide details' : 'Care plan & preferences'}</span>
          {detailsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      )}

      {detailsOpen && (
        <div className="px-5 py-4 border-t border-slate-100 space-y-5">
          {recipients.map((r, ri) => {
            const needs = r.careNeeds || [];
            const details = r.careNeedDetails || {};
            const ls = r.lifestyle;
            return (
              <div key={ri} className="border-l-4 border-primary-200 pl-3 space-y-2.5">
                <div className="flex items-center gap-2">
                  <div className="w-9 h-9 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center shrink-0">
                    {r.photoURL
                      ? <img src={r.photoURL} alt={r.name} className="w-full h-full object-cover" />
                      : <span className="text-primary-700 font-bold text-xs">{r.name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()}</span>
                    }
                  </div>
                  <div>
                    <p className="font-semibold text-slate-800 text-sm">{r.name}</p>
                    <p className="text-xs text-slate-400">{[r.relationship, r.age ? `Age ${r.age}` : ''].filter(Boolean).join(' · ')}</p>
                  </div>
                </div>
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
                {ls && ((ls.favoriteActivities?.length || 0) > 0 || (ls.helpActivities?.length || 0) > 0 || (ls.entertainment?.length || 0) > 0 || ls.enjoysConversation === true || ls.prefersQuiet === true || ls.familyInArea === true || ls.friendsVisitors === true || ls.hasAppointments === true) && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Lifestyle</p>
                    {ls.favoriteActivities && ls.favoriteActivities.length > 0 && (
                      <div><p className="text-xs text-slate-400 mb-1">Enjoys</p><div className="flex flex-wrap gap-1">{ls.favoriteActivities.map(a => <span key={a} className="text-xs bg-green-50 text-green-700 border border-green-100 px-2 py-0.5 rounded-full">{a}</span>)}</div>{ls.favoriteActivitiesOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.favoriteActivitiesOther}</p>}</div>
                    )}
                    {ls.helpActivities && ls.helpActivities.length > 0 && (
                      <div><p className="text-xs text-slate-400 mb-1">Needs help with</p><div className="flex flex-wrap gap-1">{ls.helpActivities.map(a => <span key={a} className="text-xs bg-amber-50 text-amber-700 border border-amber-100 px-2 py-0.5 rounded-full">{a}</span>)}</div>{ls.helpActivitiesOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.helpActivitiesOther}</p>}</div>
                    )}
                    {ls.entertainment && ls.entertainment.length > 0 && (
                      <div><p className="text-xs text-slate-400 mb-1">Entertainment</p><div className="flex flex-wrap gap-1">{ls.entertainment.map(a => <span key={a} className="text-xs bg-purple-50 text-purple-700 border border-purple-100 px-2 py-0.5 rounded-full">{a}</span>)}</div>{ls.entertainmentOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.entertainmentOther}</p>}</div>
                    )}
                    {(() => {
                      const bools = [
                        ls.enjoysConversation === true && 'Enjoys conversation',
                        ls.prefersQuiet === true && 'Prefers quiet',
                        ls.familyInArea === true && (ls.familyVisitFreq ? `Family in area · ${ls.familyVisitFreq}` : 'Family in area'),
                        ls.friendsVisitors === true && (ls.friendsVisitFreq ? `Friends or visitors · ${ls.friendsVisitFreq}` : 'Friends or visitors'),
                        ls.hasAppointments === true && 'Has appointments',
                      ].filter(Boolean) as string[];
                      return bools.length > 0 ? <div className="flex flex-wrap gap-1">{bools.map(p => <span key={p} className="text-xs bg-slate-100 text-slate-600 border border-slate-200 px-2 py-0.5 rounded-full">{p}</span>)}</div> : null;
                    })()}
                    {ls.hasAppointments === true && ls.appointmentsDetails && <p className="text-xs text-slate-500"><span className="font-medium text-slate-400">Appointments:</span> {ls.appointmentsDetails}</p>}
                  </div>
                )}
              </div>
            );
          })}
          {ec && (ec.name || ec.phone) && (
            <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-3">
              <p className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">Emergency Contact</p>
              <div className="flex items-center gap-2 text-sm text-red-800">
                <Phone className="w-3.5 h-3.5 shrink-0" />
                <span className="font-medium">{ec.name}</span>
                {ec.relationship && <span className="text-red-500">· {ec.relationship}</span>}
                {ec.phone && <span className="font-semibold">{ec.phone}</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Upcoming shifts ── */}
      <div className="border-t border-slate-100">
        <p className="px-5 pt-3 pb-1 text-xs font-semibold text-slate-400 uppercase tracking-wide">Upcoming Shifts</p>
        {shifts.map(shift => {
          const inProgress = shift.status === 'in-progress';
          const completed = tasksByShift[shift.id] || [];
          const totalTasks = recipients.reduce((sum, r) => {
            const needs = r.careNeeds || [];
            const det = r.careNeedDetails || {};
            return sum + needs.reduce((s, n) => s + ((det[n]?.length || 0) || 1), 0);
          }, 0);
          const isExpanded = expandedShift === shift.id;

          return (
            <div key={shift.id} className="border-t border-slate-100 first:border-t-0">
              {/* Shift row */}
              <div className="px-5 py-3 flex items-center gap-3">
                {/* Cancel single shift — far left */}
                {shift.status === 'scheduled' && (
                  <button
                    onClick={() => handleCancelShift(shift.id)}
                    disabled={submitting === shift.id}
                    title="Cancel this shift only"
                    className="p-1 text-red-300 hover:text-red-500 transition-colors disabled:opacity-50 shrink-0"
                  >
                    <XCircle className="w-4 h-4" />
                  </button>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-slate-800">{fmtDate(shift.date)}</span>
                    <span className="text-xs text-slate-500">{fmtTime(shift.startTime)}{shift.endTime ? ` – ${fmtTime(shift.endTime)}` : ''}</span>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${statusBadge(shift.status)}`}>
                      {shift.status === 'in-progress' ? 'In Progress' : 'Scheduled'}
                    </span>
                  </div>
                  {totalTasks > 0 && (
                    <div className="flex items-center gap-2 mt-1.5">
                      <div className="flex-1 h-1 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-primary-500 rounded-full transition-all" style={{ width: `${Math.round((completed.length / totalTasks) * 100)}%` }} />
                      </div>
                      <span className="text-[10px] text-slate-400 shrink-0">{completed.length}/{totalTasks}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {recipients.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setExpandedShift(isExpanded ? null : shift.id)}
                      className="text-xs text-primary-600 font-medium px-3 py-1 rounded-full border border-primary-200 bg-white hover:bg-primary-50 transition-colors"
                    >
                      {isExpanded ? 'Hide' : 'Tasks'}
                    </button>
                  )}
                  {shift.status === 'scheduled' && (
                    <button
                      onClick={() => handleStart(shift.id)}
                      disabled={submitting === shift.id}
                      className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-xs font-semibold disabled:opacity-50 transition-colors"
                    >
                      {submitting === shift.id ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                      Start
                    </button>
                  )}
                  {shift.status === 'in-progress' && (
                    <button
                      onClick={() => handleEnd(shift.id)}
                      disabled={submitting === shift.id}
                      className="inline-flex items-center gap-1 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-xl text-xs font-semibold disabled:opacity-50 transition-colors"
                    >
                      {submitting === shift.id ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                      End
                    </button>
                  )}
                </div>
              </div>

              {/* Task checklist (expanded per shift) */}
              {isExpanded && recipients.length > 0 && (
                <div className="px-5 pb-3 space-y-3">
                  {recipients.map((r, ri) => {
                    const needs = r.careNeeds || [];
                    const det = r.careNeedDetails || {};
                    if (needs.length === 0) return null;
                    return (
                      <div key={ri} className="border-l-2 border-primary-200 pl-3 space-y-1.5">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center shrink-0">
                            {r.photoURL
                              ? <img src={r.photoURL} alt={r.name} className="w-full h-full object-cover" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                              : <span className="text-primary-700 font-bold text-[10px]">{r.name.split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase()}</span>
                            }
                          </div>
                          <p className="text-xs font-semibold text-slate-600">{r.name}</p>
                        </div>
                        {needs.map(need => {
                          const subtasks = det[need] || [];
                          const checkboxRow = (key: string, label: string, indented = false) => {
                            const done = completed.includes(key);
                            return (
                              <button key={key} type="button" onClick={() => toggleTask(shift.id, key)} disabled={!inProgress}
                                className={`w-full flex items-center gap-2 text-left py-1 group ${indented ? 'pl-2' : ''} ${inProgress ? '' : 'cursor-default opacity-60'}`}>
                                <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-colors ${done ? 'bg-primary-500 border-primary-500' : inProgress ? 'border-slate-300 group-hover:border-primary-400' : 'border-slate-200 bg-slate-50'}`}>
                                  {done && <CheckCircle className="w-2.5 h-2.5 text-white" />}
                                </div>
                                <span className={`text-xs ${done ? 'line-through text-slate-400' : 'text-slate-700'}`}>{label}</span>
                              </button>
                            );
                          };
                          if (subtasks.length > 0) {
                            const allDone = subtasks.every(sub => completed.includes(`${ri}_${need}_${sub}`));
                            return (
                              <div key={need} className="rounded-lg border border-blue-200 overflow-hidden">
                                <div className="flex items-center gap-2 bg-primary-50 px-2 py-1">
                                  <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-colors ${allDone ? 'bg-primary-500 border-primary-500' : 'border-primary-300 bg-white'}`}>
                                    {allDone && <CheckCircle className="w-2.5 h-2.5 text-white" />}
                                  </div>
                                  <span className={`text-xs font-semibold ${allDone ? 'text-primary-400 line-through' : 'text-primary-700'}`}>{need}</span>
                                </div>
                                <div className="px-2 pb-1">{subtasks.map(sub => checkboxRow(`${ri}_${need}_${sub}`, sub, true))}</div>
                              </div>
                            );
                          }
                          // Standalone — header IS the checkbox
                          const key = `${ri}_${need}`;
                          const done = completed.includes(key);
                          return (
                            <button key={need} type="button" onClick={() => toggleTask(shift.id, key)} disabled={!inProgress}
                              className={`w-full flex items-center gap-2 text-left rounded-lg border overflow-hidden px-2 py-1.5 transition-colors ${
                                done ? 'bg-primary-500 border-primary-500' : 'bg-primary-50 border-blue-200'
                              } ${inProgress ? 'cursor-pointer hover:opacity-90' : 'cursor-default opacity-60'}`}>
                              <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-colors ${done ? 'bg-white border-white' : 'border-primary-300'}`}>
                                {done && <CheckCircle className="w-2.5 h-2.5 text-primary-500" />}
                              </div>
                              <span className={`text-xs font-semibold ${done ? 'text-white line-through' : 'text-primary-700'}`}>{need}</span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                  {!inProgress && <p className="text-xs text-slate-400 italic">Start the shift to check off tasks</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Footer: cancel booking ── */}
      <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center gap-2">
        <button
          onClick={() => onCancel(shifts[0].id)}
          className="inline-flex items-center gap-1.5 px-3 py-2 border border-red-200 bg-white rounded-xl text-sm text-red-500 hover:bg-red-50 transition-colors"
        >
          <XCircle className="w-4 h-4" /> Cancel Booking
        </button>
      </div>

    </div>
  );
};

// ── Shift Card (Past Bookings) ───────────────────────────────────────────────

const ShiftCard: React.FC<{
  shift: Shift;
  onCancel?: (id: string) => void;
}> = ({ shift, onCancel }) => {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [localCompleted, setLocalCompleted] = useState<string[]>(shift.tasksCompleted || []);
  const [submitting, setSubmitting] = useState(false);

  const inProgress = shift.status === 'in-progress';

  const handleStartShift = async () => {
    if (!db) return;
    setSubmitting(true);
    await db.collection('shifts').doc(shift.id).update({
      status: 'in-progress',
      startedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {}).finally(() => setSubmitting(false));
  };

  const handleEndShift = async () => {
    if (!db) return;
    setSubmitting(true);
    await db.collection('shifts').doc(shift.id).update({
      status: 'completed',
      endedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {}).finally(() => setSubmitting(false));
  };

  const toggleTask = async (taskKey: string) => {
    if (!inProgress) return;
    const next = localCompleted.includes(taskKey)
      ? localCompleted.filter(t => t !== taskKey)
      : [...localCompleted, taskKey];
    setLocalCompleted(next);
    if (db) {
      await db.collection('shifts').doc(shift.id).update({ tasksCompleted: next }).catch(() => {});
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

  const recipients = shift.careRecipients || [];
  const totalTasks = recipients.reduce((sum, r) => {
    const needs = r.careNeeds || [];
    const details = r.careNeedDetails || {};
    return sum + needs.reduce((s, n) => s + ((details[n]?.length || 0) || 1), 0);
  }, 0);
  const doneCount = localCompleted.length;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">

      {/* Header */}
      <div className="px-5 pt-5 pb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-12 h-12 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center shrink-0">
            {shift.clientPhotoURL
              ? <img src={shift.clientPhotoURL} alt={shift.clientName} className="w-full h-full object-cover" onError={e => { (e.currentTarget as HTMLImageElement).style.display='none'; }} />
              : <span className="text-primary-700 font-bold text-base">
                  {(shift.clientName || 'C').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()}
                </span>
            }
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-slate-900 text-base">{shift.clientName || 'Client'}</p>
            <span className={`inline-flex items-center text-xs font-semibold px-2.5 py-0.5 rounded-full border mt-0.5 ${statusBadge(shift.status)}`}>
              {statusLabel(shift.status)}
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {shift.recurringWeekly && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-violet-700 bg-violet-50 border border-violet-200 px-2.5 py-0.5 rounded-full">
              <Repeat className="w-3 h-3" /> Weekly
            </span>
          )}
          {shift.paid && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700 bg-green-50 border border-green-200 px-2.5 py-0.5 rounded-full">
              <CheckCircle className="w-3 h-3" /> Paid
            </span>
          )}
        </div>
      </div>

      {/* Quick info */}
      <div className="px-5 pb-4 space-y-2">
        {/* Full weekly schedule */}
        {shift.schedule?.dayShiftTimes && Object.keys(shift.schedule.dayShiftTimes).length > 0 ? (
          <div className="flex items-start gap-2 text-sm text-slate-700">
            <CalendarDays className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              {shift.schedule.startDate && (
                <p className="text-xs text-slate-400 mb-1">
                  Starts {fmtDate(shift.schedule.startDate)}
                  {shift.schedule.ongoing
                    ? <span className="ml-1.5 text-[10px] font-semibold bg-teal-50 text-teal-700 border border-teal-200 px-1.5 py-0.5 rounded-full">Ongoing</span>
                    : shift.schedule.endDate
                      ? ` → ${fmtDate(shift.schedule.endDate)}`
                      : ''}
                </p>
              )}
              {ALL_DAYS_ORDER.filter(d => shift.schedule!.dayShiftTimes![d]?.length).map(day => {
                const blocks = shift.schedule!.dayShiftTimes![day];
                const mins = blocks.reduce((s, b) => s + calcShiftMins(b.start, b.end), 0);
                return (
                  <div key={day} className="flex items-center gap-2">
                    <span className="w-8 text-xs font-semibold text-slate-500">{day}</span>
                    <span className="text-xs text-slate-700">{blocks.map(b => `${fmtTime(b.start)} – ${fmtTime(b.end)}`).join(', ')}</span>
                    {mins > 0 && <span className="text-[10px] text-primary-600 font-semibold ml-auto">{fmtHours(mins)}</span>}
                  </div>
                );
              })}
              {(() => {
                const total = ALL_DAYS_ORDER.reduce((s, d) => {
                  return s + (shift.schedule!.dayShiftTimes![d] || []).reduce((ss, b) => ss + calcShiftMins(b.start, b.end), 0);
                }, 0);
                return total > 0 ? (
                  <div className="flex items-center gap-2 pt-0.5 border-t border-slate-100 mt-1">
                    <span className="text-xs text-slate-400">Total per week</span>
                    <span className="text-xs font-semibold text-primary-600 ml-auto">{fmtHours(total)}</span>
                  </div>
                ) : null;
              })()}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-700">
            <CalendarDays className="w-4 h-4 text-slate-400 shrink-0" />
            <span>{fmtDate(shift.date)}</span>
          </div>
        )}
        <div className="flex items-center gap-2 text-sm text-slate-700">
          <Clock className="w-4 h-4 text-slate-400 shrink-0" />
          <span>{fmtTime(shift.startTime)}{shift.endTime ? ` – ${fmtTime(shift.endTime)}` : ''}</span>
        </div>
        {shift.address && (
          <div className="flex items-start gap-2 text-sm text-slate-700">
            <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
            <div>
              <span>{shift.address}</span>
              {shift.lifestylePreferences && shift.lifestylePreferences.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {shift.lifestylePreferences.map(p => (
                    <span key={p} className="text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full">{p}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {shift.rate != null && (
          <div className="flex items-center gap-2 text-sm text-slate-700">
            {shift.paymentMethod === 'credit'
              ? <CreditCard className="w-4 h-4 text-slate-400 shrink-0" />
              : <Banknote className="w-4 h-4 text-slate-400 shrink-0" />}
            <span>
              <span className="font-semibold">${shift.rate}/hr</span>
              <span className="text-slate-400"> · {shift.paymentMethod === 'credit' ? 'Card' : 'Cash'}</span>
            </span>
          </div>
        )}
        {shift.notes && (
          <div className="flex items-start gap-2 text-sm text-slate-500">
            <FileText className="w-4 h-4 text-slate-300 shrink-0 mt-0.5" />
            <span>{shift.notes}</span>
          </div>
        )}

        {/* Task progress */}
        {totalTasks > 0 && (
          <div className="flex items-center gap-2 pt-1">
            <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary-500 rounded-full transition-all"
                style={{ width: `${Math.round((doneCount / totalTasks) * 100)}%` }}
              />
            </div>
            <span className="text-xs text-slate-500 shrink-0">{doneCount}/{totalTasks} tasks</span>
          </div>
        )}
      </div>

      {/* Expand toggle */}
      {recipients.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className="w-full px-5 py-2.5 border-t border-slate-100 flex items-center justify-between text-sm text-primary-600 font-medium hover:bg-slate-50 transition-colors"
        >
          <span>{expanded ? 'Hide care plan' : 'View care plan & tasks'}</span>
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      )}

      {/* Expanded: care recipients + care plan checklist */}
      {expanded && recipients.length > 0 && (
        <div className="px-5 py-4 border-t border-slate-100 space-y-5">
          {recipients.map((r, ri) => {
            const needs = r.careNeeds || [];
            const details = r.careNeedDetails || {};
            const ls = r.lifestyle;
            return (
              <div key={ri} className="border-l-4 border-primary-200 pl-3">
                {/* Recipient header */}
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-9 h-9 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center shrink-0">
                    {r.photoURL
                      ? <img src={r.photoURL} alt={r.name} className="w-full h-full object-cover" />
                      : <span className="text-primary-700 font-bold text-xs">{r.name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()}</span>
                    }
                  </div>
                  <div>
                    <p className="font-semibold text-slate-800 text-sm">{r.name}</p>
                    <p className="text-xs text-slate-400">{[r.relationship, r.age ? `Age ${r.age}` : ''].filter(Boolean).join(' · ')}</p>
                  </div>
                </div>

                {/* Care plan checklist */}
                {needs.length > 0 && (
                  <div className="space-y-2 mb-3">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Care Plan</p>
                    {needs.map(need => {
                      const subtasks = details[need] || [];
                      if (subtasks.length > 0) {
                        return (
                          <div key={need}>
                            <p className="text-xs font-semibold text-primary-700 bg-primary-50 rounded-lg px-3 py-1.5 mb-1">{need}</p>
                            <div className="space-y-1 pl-2">
                              {subtasks.map(sub => {
                                const key = `${ri}_${need}_${sub}`;
                                const done = localCompleted.includes(key);
                                return (
                                  <button
                                    key={key}
                                    type="button"
                                    onClick={() => toggleTask(key)}
                                    disabled={!inProgress}
                                    className={`w-full flex items-center gap-2 text-left py-1 group ${inProgress ? '' : 'cursor-default opacity-60'}`}
                                  >
                                    <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-colors ${done ? 'bg-primary-500 border-primary-500' : inProgress ? 'border-slate-300 group-hover:border-primary-400' : 'border-slate-200 bg-slate-50'}`}>
                                      {done && <CheckCircle className="w-2.5 h-2.5 text-white" />}
                                    </div>
                                    <span className={`text-xs ${done ? 'line-through text-slate-400' : 'text-slate-700'}`}>{sub}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      }
                      const key = `${ri}_${need}`;
                      const done = localCompleted.includes(key);
                      return (
                        <button
                          key={need}
                          type="button"
                          onClick={() => toggleTask(key)}
                          disabled={!inProgress}
                          className={`w-full flex items-center gap-2 text-left py-1 group ${inProgress ? '' : 'cursor-default opacity-60'}`}
                        >
                          <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-colors ${done ? 'bg-primary-500 border-primary-500' : inProgress ? 'border-slate-300 group-hover:border-primary-400' : 'border-slate-200 bg-slate-50'}`}>
                            {done && <CheckCircle className="w-2.5 h-2.5 text-white" />}
                          </div>
                          <span className={`text-xs font-medium ${done ? 'line-through text-slate-400' : 'text-slate-700'}`}>{need}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Lifestyle */}
                {ls && ((ls.favoriteActivities?.length || 0) > 0 || (ls.helpActivities?.length || 0) > 0 || (ls.entertainment?.length || 0) > 0 || ls.enjoysConversation === true || ls.prefersQuiet === true || ls.familyInArea === true || ls.friendsVisitors === true || ls.hasAppointments === true) && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Lifestyle</p>
                    {ls.favoriteActivities && ls.favoriteActivities.length > 0 && (
                      <div>
                        <p className="text-xs text-slate-400 mb-1">Enjoys</p>
                        <div className="flex flex-wrap gap-1">
                          {ls.favoriteActivities.map(a => <span key={a} className="text-xs bg-green-50 text-green-700 border border-green-100 px-2 py-0.5 rounded-full">{a}</span>)}
                        </div>
                        {ls.favoriteActivitiesOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.favoriteActivitiesOther}</p>}
                      </div>
                    )}
                    {ls.helpActivities && ls.helpActivities.length > 0 && (
                      <div>
                        <p className="text-xs text-slate-400 mb-1">Needs help with</p>
                        <div className="flex flex-wrap gap-1">
                          {ls.helpActivities.map(a => <span key={a} className="text-xs bg-amber-50 text-amber-700 border border-amber-100 px-2 py-0.5 rounded-full">{a}</span>)}
                        </div>
                        {ls.helpActivitiesOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.helpActivitiesOther}</p>}
                      </div>
                    )}
                    {ls.entertainment && ls.entertainment.length > 0 && (
                      <div>
                        <p className="text-xs text-slate-400 mb-1">Entertainment</p>
                        <div className="flex flex-wrap gap-1">
                          {ls.entertainment.map(a => <span key={a} className="text-xs bg-purple-50 text-purple-700 border border-purple-100 px-2 py-0.5 rounded-full">{a}</span>)}
                        </div>
                        {ls.entertainmentOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.entertainmentOther}</p>}
                      </div>
                    )}
                    {(() => {
                      const bools = [
                        ls.enjoysConversation === true && 'Enjoys conversation',
                        ls.prefersQuiet === true && 'Prefers quiet',
                        ls.familyInArea === true && (ls.familyVisitFreq ? `Family in area · ${ls.familyVisitFreq}` : 'Family in area'),
                        ls.friendsVisitors === true && (ls.friendsVisitFreq ? `Friends or visitors · ${ls.friendsVisitFreq}` : 'Friends or visitors'),
                        ls.hasAppointments === true && 'Has appointments',
                      ].filter(Boolean) as string[];
                      return bools.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {bools.map(p => <span key={p} className="text-xs bg-slate-100 text-slate-600 border border-slate-200 px-2 py-0.5 rounded-full">{p}</span>)}
                        </div>
                      ) : null;
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
          {shift.emergencyContact && (shift.emergencyContact.name || shift.emergencyContact.phone) && (
            <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-3">
              <p className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">Emergency Contact</p>
              <div className="flex items-center gap-2 text-sm text-red-800">
                <Phone className="w-3.5 h-3.5 shrink-0" />
                <span className="font-medium">{shift.emergencyContact.name}</span>
                {shift.emergencyContact.relationship && <span className="text-red-500">· {shift.emergencyContact.relationship}</span>}
                {shift.emergencyContact.phone && <span className="font-semibold">{shift.emergencyContact.phone}</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center gap-2 flex-wrap">
        <button
          onClick={() => navigate(`/caregiver/inbox?client=${shift.clientId}`)}
          className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 bg-white rounded-xl text-sm text-slate-600 hover:bg-slate-50 transition-colors"
        >
          <MessageSquare className="w-4 h-4" /> Message
        </button>

        {shift.status === 'scheduled' && (
          <>
            <button
              onClick={handleStartShift}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50 transition-colors ml-auto"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
              Start Shift
            </button>
            {onCancel && (
              <button
                onClick={() => onCancel(shift.id)}
                className="inline-flex items-center gap-1.5 px-3 py-2 border border-red-200 bg-white rounded-xl text-sm text-red-500 hover:bg-red-50 transition-colors"
              >
                <XCircle className="w-4 h-4" /> Cancel
              </button>
            )}
          </>
        )}

        {shift.status === 'in-progress' && (
          <button
            onClick={handleEndShift}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50 transition-colors ml-auto"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            End Shift
          </button>
        )}
      </div>

    </div>
  );
};

// ── Past Booking Group Card ──────────────────────────────────────────────────

const PastBookingGroupCard: React.FC<{ shifts: Shift[] }> = ({ shifts }) => {
  const base = shifts[0];
  const [detailsOpen, setDetailsOpen] = useState(false);
  const recipients = base.careRecipients || [];
  const ec = base.emergencyContact;

  const completedCount = shifts.filter(s => s.status === 'completed').length;
  const cancelledCount = shifts.filter(s => s.status === 'cancelled').length;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">

      {/* Header */}
      <div className="px-5 pt-5 pb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <ClientAvatar photoURL={base.clientPhotoURL} name={base.clientName} textColor="text-slate-500" />
          <div className="min-w-0">
            <p className="font-semibold text-slate-900 text-base">{base.clientName || 'Client'}</p>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              {completedCount > 0 && (
                <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full border bg-green-100 text-green-700 border-green-200">
                  {completedCount} completed
                </span>
              )}
              {cancelledCount > 0 && (
                <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full border bg-red-100 text-red-600 border-red-200">
                  {cancelledCount} cancelled
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Shared info */}
      <div className="px-5 pb-4 space-y-2">
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
            <span><span className="font-semibold">${base.rate}/hr</span><span className="text-slate-400"> · {base.paymentMethod === 'credit' ? 'Card' : 'Cash'}</span></span>
          </div>
        )}
      </div>

      {/* Details toggle */}
      {(recipients.length > 0 || ec) && (
        <button
          type="button"
          onClick={() => setDetailsOpen(o => !o)}
          className="w-full px-5 py-2.5 border-t border-slate-100 flex items-center justify-between text-sm text-primary-600 font-medium hover:bg-slate-50 transition-colors"
        >
          <span>{detailsOpen ? 'Hide details' : 'Care plan & preferences'}</span>
          {detailsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      )}

      {detailsOpen && (
        <div className="px-5 py-4 border-t border-slate-100 space-y-4">
          {recipients.map((r, ri) => {
            const needs = r.careNeeds || [];
            const details = r.careNeedDetails || {};
            return (
              <div key={ri} className="border-l-4 border-slate-200 pl-3 space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full overflow-hidden bg-slate-100 flex items-center justify-center shrink-0">
                    {r.photoURL
                      ? <img src={r.photoURL} alt={r.name} className="w-full h-full object-cover" />
                      : <span className="text-slate-500 font-bold text-xs">{r.name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()}</span>
                    }
                  </div>
                  <div>
                    <p className="font-semibold text-slate-700 text-sm">{r.name}</p>
                    <p className="text-xs text-slate-400">{[r.relationship, r.age ? `Age ${r.age}` : ''].filter(Boolean).join(' · ')}</p>
                  </div>
                </div>
                {needs.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {needs.map(need => {
                      const subtasks = details[need] || [];
                      return (
                        <div key={need} className="rounded-lg border border-slate-200 overflow-hidden">
                          <div className="bg-slate-50 px-2.5 py-1"><span className="text-xs font-semibold text-slate-600">{need}</span></div>
                          {subtasks.length > 0 && (
                            <div className="px-2.5 py-1.5 flex flex-wrap gap-1">
                              {subtasks.map(t => <span key={t} className="text-xs text-slate-500 border border-slate-200 px-2 py-0.5 rounded-full">{t}</span>)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {ec && (ec.name || ec.phone) && (
            <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-3">
              <p className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">Emergency Contact</p>
              <div className="flex items-center gap-2 text-sm text-red-800">
                <Phone className="w-3.5 h-3.5 shrink-0" />
                <span className="font-medium">{ec.name}</span>
                {ec.relationship && <span className="text-red-500">· {ec.relationship}</span>}
                {ec.phone && <span className="font-semibold">{ec.phone}</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Shift history */}
      <div className="border-t border-slate-100">
        <p className="px-5 pt-3 pb-1 text-xs font-semibold text-slate-400 uppercase tracking-wide">Shift History</p>
        {shifts.map(shift => (
          <div key={shift.id} className="border-t border-slate-100 px-5 py-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-700">{fmtDate(shift.date)}</p>
              <p className="text-xs text-slate-400">{fmtTime(shift.startTime)}{shift.endTime ? ` – ${fmtTime(shift.endTime)}` : ''}</p>
            </div>
            <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${statusBadge(shift.status)}`}>
              {shift.status === 'completed' ? 'Completed' : 'Cancelled'}
            </span>
          </div>
        ))}
      </div>

    </div>
  );
};

// ── Empty State ─────────────────────────────────────────────────────────────

const EmptyState: React.FC<{ icon: React.ReactNode; title: string; body: string }> = ({ icon, title, body }) => (
  <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center">
    <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3 text-slate-400">
      {icon}
    </div>
    <p className="font-semibold text-slate-700 mb-1">{title}</p>
    <p className="text-sm text-slate-400">{body}</p>
  </div>
);

// ── Main Page ───────────────────────────────────────────────────────────────

export const CaregiverBookingsPage: React.FC = () => {
  const { currentUser, addToast } = useCareConnex();
  const [tab, setTab] = useState<Tab>('requests');

  const [requests, setRequests] = useState<BookingRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [activeShifts, setActiveShifts] = useState<Shift[]>([]);
  const [activeLoading, setActiveLoading] = useState(true);

  const [pastShifts, setPastShifts] = useState<Shift[]>([]);
  const [pastLoading, setPastLoading] = useState(true);

  const uid = currentUser?.uid;

  // Fetch booking requests
  useEffect(() => {
    if (!uid || !db) { setRequestsLoading(false); return; }
    const unsub = db.collection('booking_requests')
      .where('caregiverId', '==', uid)
      .orderBy('createdAt', 'desc')
      .onSnapshot(snap => {
        setRequests(snap.docs.map(d => ({ id: d.id, ...d.data() } as BookingRequest)));
        setRequestsLoading(false);
      }, () => setRequestsLoading(false));
    return () => unsub();
  }, [uid]);

  // Fetch active shifts
  useEffect(() => {
    if (!uid || !db) { setActiveLoading(false); return; }
    const unsub = db.collection('shifts')
      .where('caregiverId', '==', uid)
      .where('status', 'in', ['scheduled', 'in-progress'])
      .orderBy('date', 'asc')
      .onSnapshot(snap => {
        setActiveShifts(snap.docs.map(d => ({ id: d.id, ...d.data() } as Shift)));
        setActiveLoading(false);
      }, () => setActiveLoading(false));
    return () => unsub();
  }, [uid]);

  // Fetch past shifts
  useEffect(() => {
    if (!uid || !db) { setPastLoading(false); return; }
    const unsub = db.collection('shifts')
      .where('caregiverId', '==', uid)
      .where('status', 'in', ['completed', 'cancelled'])
      .orderBy('date', 'desc')
      .onSnapshot(snap => {
        setPastShifts(snap.docs.map(d => ({ id: d.id, ...d.data() } as Shift)));
        setPastLoading(false);
      }, () => setPastLoading(false));
    return () => unsub();
  }, [uid]);

  const handleAccept = async (id: string) => {
    if (!db) return;
    setSubmitting(true);
    try {
      await db.collection('booking_requests').doc(id).update({
        status: 'accepted',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      const [bookingSnap, caregiverSnap] = await Promise.all([
        db.collection('booking_requests').doc(id).get(),
        uid ? db.collection('caregivers').doc(uid).get().catch(() => null) : Promise.resolve(null),
      ]);
      const booking = bookingSnap.data() as any;
      const caregiverData = caregiverSnap?.data() as any;
      const caregiverPhotoURL = caregiverData?.profilePhoto || caregiverData?.photoURL || caregiverData?.photo || null;

      // Create shifts for the next 4 weeks (or up to endDate for fixed-term bookings)
      const dayShiftTimes: Record<string, Array<{ start: string; end: string }>> =
        booking?.schedule?.dayShiftTimes || {};
      const startDate: string =
        booking?.schedule?.startDate || new Date().toISOString().split('T')[0];
      const endDate: string | null = booking?.schedule?.ongoing ? null : (booking?.schedule?.endDate || null);
      const WEEKS = 4;

      const shiftDocs: Array<{ date: string; start: string; end: string }> = [];
      Object.entries(dayShiftTimes).forEach(([day, blocks]) => {
        (blocks as Array<{ start: string; end: string }>)
          .filter(b => b.start && b.end)
          .forEach(b => {
            const first = nextOccurrence(startDate, day);
            for (let w = 0; w < WEEKS; w++) {
              const d = new Date(first + 'T12:00:00');
              d.setDate(d.getDate() + w * 7);
              const dateStr = d.toISOString().split('T')[0];
              if (endDate && dateStr > endDate) break;
              shiftDocs.push({ date: dateStr, start: b.start, end: b.end });
            }
          });
      });

      if (shiftDocs.length > 0) {
        const shiftBase = {
          clientId: booking.clientId || '',
          clientName: booking.clientName || '',
          clientPhotoURL: booking.clientPhotoURL || null,
          caregiverId: uid || '',
          caregiverName: booking.caregiverName || currentUser?.displayName || '',
          caregiverPhotoURL: caregiverPhotoURL,
          status: 'scheduled',
          address: booking.address || '',
          lifestylePreferences: booking.lifestylePreferences || [],
          rate: booking.rate ?? null,
          paymentMethod: booking.paymentMethod || null,
          notes: booking.notes || '',
          careRecipients: booking.careRecipients || [],
          emergencyContact: booking.emergencyContact || null,
          schedule: booking.schedule || null,
          bookingRequestId: id,
          jobId: booking.jobId || null,
          recurringWeekly: true,
          tasksCompleted: [],
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        };
        const batch = db.batch();
        shiftDocs.forEach(({ date, start, end }) => {
          batch.set(db!.collection('shifts').doc(), {
            ...shiftBase,
            date,
            startTime: start,
            endTime: end,
          });
        });
        await batch.commit();
      }

      // Auto-close job post if enough caregivers have accepted
      if (booking?.jobId && booking?.clientId) {
        const [jobSnap, acceptedSnap] = await Promise.all([
          db.collection('job_posts').doc(booking.jobId).get(),
          db.collection('booking_requests')
            .where('jobId', '==', booking.jobId)
            .where('status', '==', 'accepted')
            .get(),
        ]);
        const jobData = jobSnap.data();
        const caregiversNeeded = jobData?.caregiversNeeded || 1;
        if (acceptedSnap.size >= caregiversNeeded) {
          await db.collection('job_posts').doc(booking.jobId).update({
            status: 'filled',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
        }
      }

      addToast('Booking request accepted!', 'success');
    } catch (e) {
      console.error('handleAccept error', e);
      addToast('Failed to accept request', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDecline = async (id: string) => {
    if (!db || !window.confirm('Decline this booking request?')) return;
    setSubmitting(true);
    try {
      await db.collection('booking_requests').doc(id).update({
        status: 'declined',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      addToast('Request declined', 'info');
    } catch {
      addToast('Failed to decline request', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelShift = async (id: string) => {
    if (!db || !window.confirm('Cancel this shift and all future scheduled shifts for this booking?')) return;
    try {
      const shiftSnap = await db.collection('shifts').doc(id).get();
      const shiftData = shiftSnap.data() as any;
      const bookingRequestId: string | undefined = shiftData?.bookingRequestId;

      // Cancel this shift + all future scheduled shifts for the same booking
      const batch = db.batch();
      batch.update(db.collection('shifts').doc(id), {
        status: 'cancelled',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      if (bookingRequestId) {
        const futureSnap = await db.collection('shifts')
          .where('bookingRequestId', '==', bookingRequestId)
          .where('status', '==', 'scheduled')
          .get();
        futureSnap.docs.forEach(doc => {
          if (doc.id !== id) {
            batch.update(doc.ref, {
              status: 'cancelled',
              updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
          }
        });

        await batch.commit();

        await db.collection('booking_requests').doc(bookingRequestId).update({
          status: 'cancelled',
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      } else {
        await batch.commit();
      }

      addToast('Booking cancelled', 'info');
    } catch {
      addToast('Failed to cancel shift', 'error');
    }
  };

  const pendingRequests = requests.filter(r => r.status === 'pending');

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <CaregiverTopNav />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Bookings</h1>
        <p className="text-sm text-slate-500 mb-6">Manage incoming booking requests and your scheduled shifts.</p>

        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-6">
          <button onClick={() => setTab('requests')} className={pillTab(tab === 'requests')}>
            Requests
            {pendingRequests.length > 0 && tab !== 'requests' && (
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
                {pendingRequests.length}
              </span>
            )}
          </button>
          <button onClick={() => setTab('active')} className={pillTab(tab === 'active')}>
            Active Bookings
          </button>
          <button onClick={() => setTab('past')} className={pillTab(tab === 'past')}>
            Past Bookings
          </button>
        </div>

        {/* ── Requests ── */}
        {tab === 'requests' && (
          <div className="space-y-4">
            {requestsLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary-500" /></div>
            ) : pendingRequests.length === 0 ? (
              <EmptyState
                icon={<AlertCircle className="w-6 h-6" />}
                title="No pending requests"
                body="When a family sends you a booking request, it will appear here. Accepted bookings move to Active Bookings."
              />
            ) : (
              <>
                {pendingRequests.map(req => (
                  <RequestCard
                    key={req.id}
                    req={req}
                    onAccept={handleAccept}
                    onDecline={handleDecline}
                    submitting={submitting}
                  />
                ))}
              </>
            )}
          </div>
        )}

        {/* ── Active Bookings ── */}
        {tab === 'active' && (
          <div className="space-y-4">
            {activeLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary-500" /></div>
            ) : activeShifts.length === 0 ? (
              <EmptyState
                icon={<CalendarDays className="w-6 h-6" />}
                title="No active bookings"
                body="Your scheduled and in-progress shifts will appear here."
              />
            ) : (
              (() => {
                // Group shifts by bookingRequestId, preserving order of first occurrence
                const groups = new Map<string, Shift[]>();
                activeShifts.forEach(s => {
                  const key = s.bookingRequestId || s.id;
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key)!.push(s);
                });
                return Array.from(groups.entries()).map(([key, groupShifts]) => (
                  <BookingGroupCard
                    key={key}
                    shifts={groupShifts}
                    onCancel={handleCancelShift}
                  />
                ));
              })()
            )}
          </div>
        )}

        {/* ── Past Bookings ── */}
        {tab === 'past' && (
          <div className="space-y-4">
            {pastLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary-500" /></div>
            ) : pastShifts.length === 0 ? (
              <EmptyState
                icon={<CalendarDays className="w-6 h-6" />}
                title="No past bookings"
                body="Completed and cancelled shifts will appear here."
              />
            ) : (
              (() => {
                const groups = new Map<string, Shift[]>();
                pastShifts.forEach(s => {
                  const key = s.bookingRequestId || s.id;
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key)!.push(s);
                });
                return Array.from(groups.entries()).map(([key, groupShifts]) => (
                  <PastBookingGroupCard key={key} shifts={groupShifts} />
                ));
              })()
            )}
          </div>
        )}
      </div>
    </div>
  );
};
