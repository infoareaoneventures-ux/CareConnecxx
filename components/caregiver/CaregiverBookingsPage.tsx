import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CalendarDays, Clock, MapPin, CheckCircle, XCircle,
  Loader2, MessageSquare, Star, Banknote, CreditCard, ChevronDown,
  ChevronUp, Phone, AlertCircle, Repeat, FileText, ClipboardList, Lock,
} from 'lucide-react';
import { CaregiverTopNav } from './CaregiverTopNav';
import { useCareConnex } from '../../context/CareConnexContext';
import { useCaregiverGate } from '../../hooks/useCaregiverGate';
import { db } from '../../lib/firebase';
import { shiftDisplayStatus, shiftStatusBadgeClass, shiftStatusLabel } from '../../utils/shiftUtils';
import { paymentMethodLabel } from '../../types';
import firebase from '../../lib/firebase';
import { dbService } from '../../services/api';
import type { PendingSwap } from '../../services/shiftSwap';
import { PendingSwapsPanel } from '../shared/PendingSwapsPanel';
// Childcare U11 (plan 2026-07-22-002): ADDITIVE childcare bookings section.
// It renders null while childcare is unavailable (flags off / probe failure),
// so senior-only caregivers see this page byte-identically to before.
import { ChildcareBookingsSection } from './ChildcareBookingsSection';

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
  status: 'pending' | 'scheduled' | 'in-progress' | 'completed' | 'cancelled';
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
  completionNotes?: string;
  careNeeds?: string[];
  startedAt?: any;
  completedAt?: any;
  paid?: boolean;
  rate?: number | null;
  paymentMethod?: string | null;
  recurringWeekly?: boolean;
  bookingRequestId?: string;
}

interface BookingAmendment {
  id: string;
  bookingRequestId: string | null;
  clientId: string;
  clientName: string;
  caregiverId: string;
  caregiverName: string;
  status: 'pending' | 'accepted' | 'declined';
  type: 'add_recurring_days';
  newDays: Record<string, Array<{ start: string; end: string }>>;
  notes: string;
  startDate?: string;
  endDate?: string | null;
  ongoing?: boolean;
  createdAt: any;
}

const ALL_DAYS_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Returns the date string (YYYY-MM-DD) of the first occurrence of dayName on or after startDate
function normDay(day: string): string {
  const d = day.trim();
  return d.charAt(0).toUpperCase() + d.slice(1, 3).toLowerCase();
}
function nextOccurrence(startDate: string, dayName: string): string {
  const target = ALL_DAYS_ORDER.indexOf(normDay(dayName));
  if (target === -1) return startDate;
  const base = new Date(startDate + 'T12:00:00');
  const diff = (target - base.getDay() + 7) % 7;
  base.setDate(base.getDate() + diff);
  return base.toISOString().split('T')[0];
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

/** Sort shift blocks within a day chronologically by start time */
function sortBlocks<T extends { start: string }>(blocks: T[]): T[] {
  return [...blocks].sort((a, b) => {
    const toMins = (t: string) => {
      const clean = t.startsWith('~') ? t.slice(1) : t;
      const [h, m] = clean.split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    return toMins(a.start) - toMins(b.start);
  });
}


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
  blockReason?: 'membership' | 'background' | null;
}> = ({ req, onAccept, onDecline, submitting, blockReason }) => {
  const navigate = useNavigate();
  const { setMembershipModalOpen } = useCareConnex();
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
                      sortBlocks(dayShiftTimes![day].filter(b => b.start && b.end)).map((b, i) => {
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
                            <div className="space-y-1">
                              {([
                                { label: 'Enjoys conversation', key: 'enjoysConversation' },
                                { label: 'Prefers quiet', key: 'prefersQuiet' },
                                { label: 'Family in area', key: 'familyInArea' },
                                { label: 'Friends or visitors', key: 'friendsVisitors' },
                                { label: 'Has appointments', key: 'hasAppointments' },
                              ] as const).filter(({ key }) => lifestyle && (lifestyle as any)[key] !== null && (lifestyle as any)[key] !== undefined).map(({ label, key }) => (
                                <React.Fragment key={key}>
                                  <div className="flex items-center justify-between text-[10px]">
                                    <span className="text-slate-500">{label}</span>
                                    <span className={`px-1.5 py-0.5 rounded-full font-semibold ${(lifestyle as any)[key] === true ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>{(lifestyle as any)[key] === true ? 'Yes' : 'No'}</span>
                                  </div>
                                  {key === 'familyInArea' && lifestyle?.familyInArea === true && lifestyle?.familyVisitFreq && (
                                    <div className="flex items-center justify-between text-[10px]">
                                      <span className="text-slate-400">Family visit frequency</span>
                                      <span className="text-slate-600 font-medium">{lifestyle.familyVisitFreq}</span>
                                    </div>
                                  )}
                                  {key === 'friendsVisitors' && lifestyle?.friendsVisitors === true && lifestyle?.friendsVisitFreq && (
                                    <div className="flex items-center justify-between text-[10px]">
                                      <span className="text-slate-400">Friends visit frequency</span>
                                      <span className="text-slate-600 font-medium">{lifestyle.friendsVisitFreq}</span>
                                    </div>
                                  )}
                                </React.Fragment>
                              ))}
                            </div>
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
              {blockReason === 'membership' ? (
                <button onClick={() => setMembershipModalOpen(true)} className="flex items-center gap-1.5 px-4 py-2 bg-slate-100 border border-slate-200 text-slate-500 rounded-xl text-sm font-semibold transition-colors hover:bg-slate-200">
                  <Lock className="w-4 h-4" /> Activate Membership
                </button>
              ) : blockReason === 'background' ? (
                <button onClick={() => navigate('/caregiver/dashboard')} className="flex items-center gap-1.5 px-4 py-2 bg-amber-50 border border-amber-200 text-amber-700 rounded-xl text-sm font-semibold transition-colors hover:bg-amber-100">
                  <Lock className="w-4 h-4" /> Complete Verification
                </button>
              ) : (
                <button
                  onClick={() => onAccept(req.id)}
                  disabled={submitting}
                  className="flex items-center gap-1.5 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50 transition-colors"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                  Accept
                </button>
              )}
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
  amendments: BookingAmendment[];
  onCancel: (id: string) => void;
  onAcceptAmendment: (amendment: BookingAmendment) => Promise<void>;
}> = ({ shifts, amendments, onCancel, onAcceptAmendment }) => {
  const navigate = useNavigate();
  const { blockReason } = useCaregiverGate();
  const { setMembershipModalOpen } = useCareConnex();
  const base = shifts[0];
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [expandedShift, setExpandedShift] = useState<string | null>(null);
  const [showAllShifts, setShowAllShifts] = useState(false);
  const [tasksByShift, setTasksByShift] = useState<Record<string, string[]>>(
    () => Object.fromEntries(shifts.map(s => [s.id, s.tasksCompleted || []]))
  );

  // Sync tasksByShift when Firestore snapshot updates shifts (e.g. changes made from calendar)
  useEffect(() => {
    setTasksByShift(prev => {
      const next = { ...prev };
      shifts.forEach(s => { next[s.id] = s.tasksCompleted || []; });
      return next;
    });
  }, [shifts]);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [endingShiftId, setEndingShiftId] = useState<string | null>(null);
  const [endNotesByShift, setEndNotesByShift] = useState<Record<string, string>>({});

  const handleStart = async (shiftId: string) => {
    if (!db) return;
    setSubmitting(shiftId);
    await db.collection('shifts').doc(shiftId).update({
      status: 'in-progress',
      startedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {}).finally(() => setSubmitting(null));
  };

  const handleEnd = async (shiftId: string, notes?: string) => {
    if (!db) return;
    setSubmitting(shiftId);
    setEndingShiftId(null);
    const update: any = {
      status: 'completed',
      completedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (notes?.trim()) update.completionNotes = notes.trim();
    await db.collection('shifts').doc(shiftId).update(update).catch(() => {}).finally(() => setSubmitting(null));
  };

  const handleCancelShift = async (shiftId: string) => {
    if (!db || !window.confirm('Cancel this shift only? The rest of your booking stays active.')) return;
    setSubmitting(shiftId);
    await db.collection('shifts').doc(shiftId).update({
      status: 'cancelled',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {}).finally(() => setSubmitting(null));
  };

  const toggleCategory = async (shiftId: string, subtaskKeys: string[]) => {
    const shift = shifts.find(s => s.id === shiftId);
    if (!shift || shift.status !== 'in-progress') return;
    const prev = tasksByShift[shiftId] || [];
    const allDone = subtaskKeys.every(k => prev.includes(k));
    const next = allDone
      ? prev.filter(k => !subtaskKeys.includes(k))
      : [...new Set([...prev, ...subtaskKeys])];
    setTasksByShift(p => ({ ...p, [shiftId]: next }));
    if (db) await db.collection('shifts').doc(shiftId).update({ tasksCompleted: next }).catch(() => {});
  };

  const toggleTask = async (shiftId: string, key: string) => {
    const shift = shifts.find(s => s.id === shiftId);
    if (!shift || shift.status !== 'in-progress') return;
    const prev = tasksByShift[shiftId] || [];
    const next = prev.includes(key) ? prev.filter(t => t !== key) : [...prev, key];
    setTasksByShift(p => ({ ...p, [shiftId]: next }));
    if (db) await db.collection('shifts').doc(shiftId).update({ tasksCompleted: next }).catch(() => {});
  };

  // Delegated to page-level handler (lifted so orphan amendments in Requests tab can share it)

  const recipients = base.careRecipients || [];
  const ec = base.emergencyContact;

  return (
  <>
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
                  {!base.schedule.ongoing && base.schedule.endDate ? ` → ${fmtDate(base.schedule.endDate)}` : ''}
                </p>
              )}
              {ALL_DAYS_ORDER.filter(d => base.schedule!.dayShiftTimes![d]?.length).map(day => {
                const blocks = sortBlocks(base.schedule!.dayShiftTimes![day]);
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
            <span><span className="font-semibold">${base.rate}/hr</span><span className="text-slate-400"> · {base.paymentMethod === 'credit' ? 'Card' : paymentMethodLabel(base.paymentMethod)}</span></span>
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
                            <span className={`px-2 py-0.5 rounded-full font-semibold text-xs ${(ls as any)[key] === true ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>{(ls as any)[key] === true ? 'Yes' : 'No'}</span>
                          </div>
                          {key === 'familyInArea' && (ls as any).familyInArea === true && (ls as any).familyVisitFreq && (
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-slate-400">Family visit frequency</span>
                              <span className="text-slate-600 font-medium">{(ls as any).familyVisitFreq}</span>
                            </div>
                          )}
                          {key === 'friendsVisitors' && (ls as any).friendsVisitors === true && (ls as any).friendsVisitFreq && (
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-slate-400">Friends visit frequency</span>
                              <span className="text-slate-600 font-medium">{(ls as any).friendsVisitFreq}</span>
                            </div>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
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

      {/* ── Recurring schedule amendment requests ── */}
      {amendments.map(amendment => (
        <div key={amendment.id} className="border-t border-violet-100 bg-violet-50 px-5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="space-y-0.5 mb-1">
                {ALL_DAYS_ORDER.filter(d => amendment.newDays[d]?.length).map(day => (
                  <p key={day} className="text-xs text-slate-700">
                    <span className="font-semibold">{day}</span>
                    {' · '}
                    {amendment.newDays[day].map(b => `${fmtTime(b.start)} – ${fmtTime(b.end)}`).join(', ')}
                  </p>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-1">
                {amendment.startDate
                  ? `Starts ${fmtDate(amendment.startDate)}`
                  : 'Starts immediately'}
                {amendment.ongoing
                  ? ' · Ongoing'
                  : amendment.endDate
                    ? ` → ${fmtDate(amendment.endDate)}`
                    : ''}
              </p>
              {amendment.notes && <p className="text-xs text-slate-400 italic mt-0.5">{amendment.notes}</p>}
            </div>
            <div className="flex gap-2 shrink-0 mt-0.5">
              <button
                onClick={() => onAcceptAmendment(amendment)}
                className="px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold rounded-xl flex items-center gap-1 transition-colors"
              >
                <CheckCircle className="w-3.5 h-3.5" /> Accept
              </button>
              <button
                onClick={async () => {
                  if (!db) return;
                  await db.collection('booking_amendments').doc(amendment.id).update({
                    status: 'declined',
                    respondedAt: firebase.firestore.FieldValue.serverTimestamp(),
                  }).catch(() => {});
                  // Notification handled by onBookingAmendmentWrite Cloud Function
                }}
                className="px-3 py-1.5 border border-red-200 hover:bg-red-50 text-red-500 text-xs font-semibold rounded-xl transition-colors"
              >
                Decline
              </button>
            </div>
          </div>
        </div>
      ))}

      {/* ── Pending extra visit requests ── */}
      {shifts.filter(s => s.status === 'pending').map(shift => (
        <div key={shift.id} className="border-t border-amber-100 bg-amber-50 px-5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-0.5">Extra Visit Requested</p>
              <p className="text-sm font-semibold text-slate-800">{fmtDate(shift.date)}</p>
              <p className="text-xs text-slate-500">{fmtTime(shift.startTime)}{shift.endTime ? ` – ${fmtTime(shift.endTime)}` : ''}</p>
              {shift.notes && <p className="text-xs text-slate-400 mt-1 italic">{shift.notes}</p>}
            </div>
            <div className="flex gap-2 shrink-0 mt-0.5">
              <button
                onClick={async () => {
                  if (!db) return;
                  // U3: the client notification is owned by the onShiftStatusChanged
                  // server trigger (pending → scheduled = extra_visit_accepted). The
                  // browser only writes the canonical status; no peer notification.
                  await db.collection('shifts').doc(shift.id).update({
                    status: 'scheduled',
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                  }).catch(() => {});
                }}
                className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold rounded-xl flex items-center gap-1"
              >
                <CheckCircle className="w-3.5 h-3.5" /> Accept
              </button>
              <button
                onClick={async () => {
                  if (!db) return;
                  // U3: onShiftStatusChanged owns the client notification
                  // (pending → cancelled = extra_visit_declined). Browser writes
                  // only the canonical status.
                  await db.collection('shifts').doc(shift.id).update({
                    status: 'cancelled',
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                  }).catch(() => {});
                }}
                className="px-3 py-1.5 border border-red-200 hover:bg-red-50 text-red-500 text-xs font-semibold rounded-xl"
              >
                Decline
              </button>
            </div>
          </div>
        </div>
      ))}

      {/* ── Upcoming shifts ── */}
      <div className="border-t border-slate-100">
        <p className="px-5 pt-3 pb-1 text-xs font-semibold text-slate-400 uppercase tracking-wide">Upcoming Shifts</p>
        {(() => {
          const allUpcoming = shifts
            .filter(s => s.status !== 'pending' && shiftDisplayStatus(s) !== 'overdue')
            .sort((a, b) => {
              const d = (a.date || '').localeCompare(b.date || '');
              return d !== 0 ? d : (a.startTime || '').localeCompare(b.startTime || '');
            });
          const visible = showAllShifts ? allUpcoming : allUpcoming.slice(0, 2);
          const hiddenCount = allUpcoming.length - 2;
          return (
            <>
              {visible.map(shift => {
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
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${shiftStatusBadgeClass(shiftDisplayStatus(shift))}`}>
                      {shiftStatusLabel(shiftDisplayStatus(shift))}
                    </span>
                  </div>
                  {shift.startedAt && (
                    <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-500">
                      <span>Started: <span className="font-semibold text-slate-700">{fmtTs(shift.startedAt)}</span></span>
                      {shift.completedAt && <span>Ended: <span className="font-semibold text-slate-700">{fmtTs(shift.completedAt)}</span></span>}
                    </div>
                  )}
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
                  {(() => {
                    if (shift.status !== 'scheduled') return null;
                    const ds = shiftDisplayStatus(shift);
                    if (ds === 'overdue') return null;
                    const minsUntilStart = (new Date(`${shift.date}T${shift.startTime}`).getTime() - Date.now()) / 60000;
                    if (minsUntilStart > 15) return null;
                    return blockReason === 'membership' ? (
                      <button onClick={() => setMembershipModalOpen(true)} className="inline-flex items-center gap-1 px-3 py-1.5 bg-slate-100 border border-slate-200 text-slate-500 rounded-xl text-xs font-semibold transition-colors hover:bg-slate-200">
                        <Lock className="w-3 h-3" /> Activate Membership
                      </button>
                    ) : blockReason === 'background' ? (
                      <button onClick={() => navigate('/caregiver/dashboard')} className="inline-flex items-center gap-1 px-3 py-1.5 bg-amber-50 border border-amber-200 text-amber-700 rounded-xl text-xs font-semibold transition-colors hover:bg-amber-100">
                        <Lock className="w-3 h-3" /> Complete Verification
                      </button>
                    ) : (
                      <button
                        onClick={() => handleStart(shift.id)}
                        disabled={submitting === shift.id}
                        className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-xs font-semibold disabled:opacity-50 transition-colors"
                      >
                        {submitting === shift.id ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                        Start Shift
                      </button>
                    );
                  })()}
                  {shift.status === 'in-progress' && endingShiftId !== shift.id && (
                    <button
                      onClick={() => setEndingShiftId(shift.id)}
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
                            const subKeys = subtasks.map((sub: string) => `${ri}_${need}_${sub}`);
                            const allDone = subKeys.every((k: string) => completed.includes(k));
                            return (
                              <div key={need} className="rounded-lg border border-blue-200 overflow-hidden">
                                <button
                                  type="button"
                                  onClick={() => toggleCategory(shift.id, subKeys)}
                                  disabled={!inProgress}
                                  className={`w-full flex items-center gap-2 px-2 py-1.5 text-left transition-colors ${allDone ? 'bg-primary-500' : 'bg-primary-50 hover:bg-primary-100'} ${!inProgress ? 'cursor-default opacity-60' : ''}`}
                                >
                                  <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-colors ${allDone ? 'bg-white border-white' : 'border-primary-300 bg-white'}`}>
                                    {allDone && <CheckCircle className="w-2.5 h-2.5 text-primary-500" />}
                                  </div>
                                  <span className={`text-xs font-semibold ${allDone ? 'text-white line-through' : 'text-primary-700'}`}>{need}</span>
                                </button>
                                <div className="px-2 pb-1">{subtasks.map((sub: string) => checkboxRow(`${ri}_${need}_${sub}`, sub, true))}</div>
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

              {/* End shift notes step */}
              {shift.status === 'in-progress' && endingShiftId === shift.id && (
                <div className="px-5 pb-4 space-y-2">
                  <textarea
                    value={endNotesByShift[shift.id] || ''}
                    onChange={e => setEndNotesByShift(p => ({ ...p, [shift.id]: e.target.value }))}
                    placeholder="Add shift notes (optional)…"
                    rows={3}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-green-200 resize-none"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEndingShiftId(null)}
                      className="flex-1 py-2 border border-slate-200 rounded-xl text-slate-600 text-sm hover:bg-slate-50"
                    >
                      Back
                    </button>
                    <button
                      onClick={() => handleEnd(shift.id, endNotesByShift[shift.id])}
                      disabled={submitting === shift.id}
                      className="flex-1 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50"
                    >
                      {submitting === shift.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                      Complete
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAllShifts(v => !v)}
            className="w-full py-2.5 border-t border-slate-100 text-xs text-slate-500 hover:text-slate-700 flex items-center justify-center gap-1 transition-colors"
          >
            {showAllShifts
              ? <><ChevronUp className="w-3.5 h-3.5" /> Show less</>
              : <><ChevronDown className="w-3.5 h-3.5" /> Show {hiddenCount} more shift{hiddenCount !== 1 ? 's' : ''}</>
            }
          </button>
        )}
        </>
        );
      })()}
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
  </>
  );
};

// ── Past Booking Group Card ──────────────────────────────────────────────────

const PastBookingGroupCard: React.FC<{ shifts: Shift[]; onLogHours?: (shift: Shift) => void; blockReason?: 'membership' | 'background' | null }> = ({ shifts, onLogHours, blockReason }) => {
  const navigate = useNavigate();
  const { setMembershipModalOpen } = useCareConnex();
  const base = shifts[0];
  const [expandedShiftId, setExpandedShiftId] = useState<string | null>(null);
  const [showAllShifts, setShowAllShifts] = useState(false);

  const completedCount = shifts.filter(s => s.status === 'completed').length;
  const cancelledCount = shifts.filter(s => s.status === 'cancelled').length;
  const missedCount    = shifts.filter(s => s.status === 'scheduled' || s.status === 'pending').length;

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
                <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">
                  <CheckCircle className="w-3 h-3" /> {completedCount} completed
                </span>
              )}
              {missedCount > 0 && (
                <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full border bg-orange-50 text-orange-600 border-orange-200">
                  {missedCount} missed
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
        <button
          onClick={() => navigate(`/caregiver/inbox?client=${base.clientId}`)}
          className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 transition-colors shrink-0"
        >
          <MessageSquare className="w-4 h-4" /> Message
        </button>
      </div>

      {/* Shift rows */}
      <div className="border-t border-slate-100">
        {(showAllShifts ? shifts : shifts.slice(0, 2)).map(shift => {
          const isCompleted = shift.status === 'completed';
          const isMissed    = shift.status === 'scheduled' || shift.status === 'pending';
          const isOpen = expandedShiftId === shift.id;
          const actualStart = fmtTs(shift.startedAt);
          const actualEnd   = fmtTs(shift.completedAt);
          const duration    = fmtDuration(shift.startedAt, shift.completedAt);
          const shiftDate   = new Date(shift.date + 'T12:00:00');
          const dayAbbr     = shiftDate.toLocaleDateString('en-US', { weekday: 'short' });
          const dayNum      = shiftDate.getDate();
          return (
            <div key={shift.id}>
              <div
                className={`border-t border-slate-100 px-4 py-3 flex items-center gap-3 ${isCompleted ? 'cursor-pointer hover:bg-slate-50' : ''}`}
                onClick={() => isCompleted && setExpandedShiftId(isOpen ? null : shift.id)}
              >
                {/* Date block */}
                <div className={`w-11 h-11 rounded-xl flex flex-col items-center justify-center shrink-0 ${isCompleted ? 'bg-slate-100' : isMissed ? 'bg-orange-50' : 'bg-red-50'}`}>
                  <span className={`text-[9px] font-semibold uppercase leading-none ${isCompleted ? 'text-slate-500' : isMissed ? 'text-orange-400' : 'text-red-400'}`}>{dayAbbr}</span>
                  <span className={`text-base font-bold leading-tight ${isCompleted ? 'text-slate-700' : isMissed ? 'text-orange-500' : 'text-red-500'}`}>{dayNum}</span>
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-800">
                    {shiftDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  </p>
                  <p className="text-xs text-slate-400">
                    {actualStart && actualEnd
                      ? `${actualStart} – ${actualEnd}${duration ? ` · ${duration}` : ''}`
                      : `${fmtTime(shift.startTime)}${shift.endTime ? ` – ${fmtTime(shift.endTime)}` : ''}`}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {isMissed ? (
                    blockReason === 'membership' ? (
                      <button onClick={() => setMembershipModalOpen(true)} className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-100 border border-slate-200 text-slate-500 text-xs font-semibold rounded-lg transition-colors hover:bg-slate-200">
                        <Lock className="w-3 h-3" /> Activate Membership
                      </button>
                    ) : blockReason === 'background' ? (
                      <button onClick={() => navigate('/caregiver/dashboard')} className="inline-flex items-center gap-1 px-2.5 py-1 bg-amber-50 border border-amber-200 text-amber-700 text-xs font-semibold rounded-lg transition-colors hover:bg-amber-100">
                        <Lock className="w-3 h-3" /> Complete Verification
                      </button>
                    ) : (
                      <button
                        onClick={e => { e.stopPropagation(); onLogHours?.(shift); }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-primary-600 text-white text-xs font-semibold rounded-lg hover:bg-primary-700 transition-colors"
                      >
                        <ClipboardList className="w-3 h-3" /> Log Hours
                      </button>
                    )
                  ) : (
                    <>
                      <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${shiftStatusBadgeClass(shiftDisplayStatus(shift))}`}>
                        {shiftStatusLabel(shiftDisplayStatus(shift))}
                      </span>
                      {isCompleted && <span className="text-slate-400 text-xs">{isOpen ? '▲' : '▼'}</span>}
                    </>
                  )}
                </div>
              </div>
              {isCompleted && isOpen && (
                <div className="px-5 pb-4 pt-3 space-y-3 bg-slate-50 border-t border-slate-100">
                  {/* Scheduled + Started/Ended times */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-3 text-xs">
                      <span className="w-20 text-slate-400 shrink-0">Scheduled</span>
                      <span className="font-semibold text-slate-700">{fmtTime(shift.startTime)}{shift.endTime ? ` – ${fmtTime(shift.endTime)}` : ''}</span>
                    </div>
                    {(actualStart || actualEnd) && (
                      <div className="flex items-center gap-3 text-xs">
                        <span className="w-20 text-slate-400 shrink-0">Started</span>
                        <span className="font-semibold text-slate-700">
                          {actualStart}{actualEnd ? <span className="text-slate-400 font-normal"> · Ended </span> : ''}{actualEnd}
                          {duration && <span className="text-primary-600 font-semibold"> · {duration}</span>}
                        </span>
                      </div>
                    )}
                  </div>
                  {/* Tasks per recipient — care plan card format */}
                  {(() => {
                    const doneRaw: string[] = shift.tasksCompleted || [];
                    const recipients = (shift.careRecipients || []) as Array<{ name: string; relationship?: string; age?: string; photoURL?: string | null; careNeeds?: string[]; careNeedDetails?: Record<string, string[]> }>;
                    const hasTasks = recipients.some(r => (r.careNeeds || []).length > 0) || (shift.careNeeds || []).length > 0;
                    if (!hasTasks) return null;

                    // Compute total/done for header count
                    let totalT = 0; let doneT = 0;
                    if (recipients.some(r => (r.careNeeds || []).length > 0)) {
                      recipients.forEach((r, ri) => {
                        (r.careNeeds || []).forEach(cat => {
                          const subs = (r.careNeedDetails || {})[cat] || [];
                          if (subs.length > 0) {
                            totalT += subs.length;
                            doneT += subs.filter((sub: string) => doneRaw.includes(`${ri}_${cat}_${sub}`)).length;
                          } else {
                            totalT += 1;
                            doneT += doneRaw.includes(`${ri}_${cat}`) ? 1 : 0;
                          }
                        });
                      });
                    } else {
                      totalT = (shift.careNeeds || []).length;
                      doneT = doneRaw.filter((k: string) => (shift.careNeeds || []).includes(k)).length;
                    }

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
                        {recipients.some(r => (r.careNeeds || []).length > 0) ? (
                          <div className="space-y-3">
                            {recipients.map((r, ri) => {
                              const cats = r.careNeeds || [];
                              const det = r.careNeedDetails || {};
                              if (cats.length === 0) return null;
                              return (
                                <div key={ri}>
                                  {(
                                    <div className="flex items-center gap-1.5 mb-1.5">
                                      <div className="w-5 h-5 rounded-full overflow-hidden bg-primary-100 shrink-0 flex items-center justify-center">
                                        {r.photoURL
                                          ? <img src={r.photoURL} alt={r.name} className="w-full h-full object-cover" />
                                          : <span className="text-[9px] font-bold text-primary-600">{r.name.split(' ').map((p: string) => p[0]).join('').slice(0,2).toUpperCase()}</span>}
                                      </div>
                                      <p className="text-xs font-semibold text-slate-600">{r.name}{r.relationship ? ` · ${r.relationship}` : ''}{r.age ? ` · Age ${r.age}` : ''}</p>
                                    </div>
                                  )}
                                  <div className="space-y-1.5">
                                    {cats.map((cat, ci) => {
                                      const subs = det[cat] || [];
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
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          // Fallback: flat careNeeds list
                          <div className="space-y-0.5">
                            {(shift.careNeeds || []).map((t: string, i: number) => {
                              const done = doneRaw.includes(t);
                              return (
                                <div key={i} className={`flex items-center gap-2 text-xs ${done ? 'text-green-700' : 'text-slate-400'}`}>
                                  <CheckCircle className={`w-3.5 h-3.5 shrink-0 ${done ? 'text-green-500' : 'text-slate-300'}`} />
                                  {t}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  {/* Caregiver notes */}
                  {shift.completionNotes && (
                    <div className="p-3 bg-white border border-slate-200 rounded-xl">
                      <p className="text-xs font-semibold text-slate-500 mb-1">Caregiver Notes</p>
                      <p className="text-xs text-slate-600">{shift.completionNotes}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {shifts.length > 2 && (
          <button
            type="button"
            onClick={() => setShowAllShifts(v => !v)}
            className="w-full py-2.5 border-t border-slate-100 text-xs text-slate-500 hover:text-slate-700 flex items-center justify-center gap-1 transition-colors"
          >
            {showAllShifts
              ? <><ChevronUp className="w-3.5 h-3.5" /> Show less</>
              : <><ChevronDown className="w-3.5 h-3.5" /> Show {shifts.length - 2} more shift{shifts.length - 2 !== 1 ? 's' : ''}</>
            }
          </button>
        )}
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
  const { currentUser, addToast, setMembershipModalOpen } = useCareConnex();
  const { blockReason } = useCaregiverGate();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => {
    const t = searchParams.get('tab');
    return (t === 'active' || t === 'past' || t === 'requests') ? t : 'requests';
  });

  const [requests, setRequests] = useState<BookingRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [activeShifts, setActiveShifts] = useState<Shift[]>([]);
  const [activeLoading, setActiveLoading] = useState(true);

  const [pastShifts, setPastShifts] = useState<Shift[]>([]);
  const [pastLoading, setPastLoading] = useState(true);
  const [overdueShifts, setOverdueShifts] = useState<Shift[]>([]);
  const [logHoursShift, setLogHoursShift] = useState<Shift | null>(null);
  const [logStartDate, setLogStartDate] = useState('');
  const [logStart, setLogStart] = useState('');
  const [logEndDate, setLogEndDate] = useState('');
  const [logEnd, setLogEnd] = useState('');
  const [logTasks, setLogTasks] = useState<string[]>([]);
  const [logNote, setLogNote] = useState('');
  const [loggingHours, setLoggingHours] = useState(false);

  const [amendments, setAmendments] = useState<BookingAmendment[]>([]);
  const [pendingSwaps, setPendingSwaps] = useState<PendingSwap[]>([]);

  const uid = currentUser?.uid;

  // Pending shift swaps this caregiver initiated (U7) — live so the caregiver
  // sees acceptance happen instead of the swap resolving silently.
  useEffect(() => {
    if (!uid) return;
    const unsub = dbService.subscribeShiftSwapsForCaregiver(uid, setPendingSwaps);
    return () => { try { unsub(); } catch {} };
  }, [uid]);

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
      .where('status', 'in', ['pending', 'scheduled', 'in-progress'])
      .orderBy('date', 'asc')
      .onSnapshot(snap => {
        setActiveShifts(snap.docs.map(d => ({ id: d.id, ...d.data() } as Shift)));
        setActiveLoading(false);
      }, () => setActiveLoading(false));
    return () => unsub();
  }, [uid]);

  // Fetch pending booking amendments (recurring schedule requests from client)
  useEffect(() => {
    if (!uid || !db) return;
    const unsub = db.collection('booking_amendments')
      .where('caregiverId', '==', uid)
      .where('status', '==', 'pending')
      .onSnapshot(snap => {
        setAmendments(snap.docs.map(d => ({ id: d.id, ...d.data() } as BookingAmendment)));
      }, () => {});
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

  // Fetch overdue shifts (scheduled but date+time has passed)
  useEffect(() => {
    if (!uid || !db) return;
    const n = new Date();
    const today = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
    const unsub = db.collection('shifts')
      .where('caregiverId', '==', uid)
      .where('status', 'in', ['scheduled', 'pending'])
      .where('date', '<=', today)
      .onSnapshot(snap => {
        // Include previous days + today's shifts only if the scheduled time has already passed
        setOverdueShifts(snap.docs
          .map(d => ({ id: d.id, ...d.data() } as Shift))
          .filter(s => shiftDisplayStatus(s) === 'overdue')
        );
      }, () => {});
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

      // Shift generation is handled by the onBookingAccepted Cloud Function
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
      const snap = await db.collection('booking_requests').doc(id).get();
      const data = snap.data() as any;
      await db.collection('booking_requests').doc(id).update({
        status: 'declined',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      // Notification handled by onBookingRequestWrite Cloud Function
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
          .where('caregiverId', '==', uid)
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

  const handleAcceptAmendment = async (amendment: BookingAmendment) => {
    const fdb = db;
    if (!fdb) return;
    try {
      const addDaysLocal = (dateStr: string, days: number) => {
        const d = new Date(dateStr + 'T12:00:00');
        d.setDate(d.getDate() + days);
        return d.toISOString().split('T')[0];
      };
      const _n = new Date();
      const today = `${_n.getFullYear()}-${String(_n.getMonth()+1).padStart(2,'0')}-${String(_n.getDate()).padStart(2,'0')}`;
      const generateFrom = amendment.startDate && amendment.startDate >= today ? amendment.startDate : today;
      const generateTo = addDaysLocal(generateFrom, 27);

      if (amendment.bookingRequestId) {
        const bookingSnap = await fdb.collection('booking_requests').doc(amendment.bookingRequestId).get();
        if (bookingSnap.exists) {
          const booking = bookingSnap.data()!;
          const currentDST: Record<string, Array<{ start: string; end: string }>> = booking.schedule?.dayShiftTimes || {};
          // Only merge into the permanent schedule for ongoing amendments.
          // Amendments with an end date are temporary — don't add them to
          // dayShiftTimes or the shiftGenerator will keep recreating them.
          const mergedDST: Record<string, Array<{ start: string; end: string }>> = amendment.ongoing
            ? (() => {
                const dst = { ...currentDST };
                for (const [day, blocks] of Object.entries(amendment.newDays)) {
                  if (!dst[day]) dst[day] = [];
                  dst[day] = [...dst[day], ...(blocks as Array<{ start: string; end: string }>)];
                }
                return dst;
              })()
            : currentDST;
          if (amendment.ongoing) {
            await fdb.collection('booking_requests').doc(amendment.bookingRequestId).update({
              'schedule.dayShiftTimes': mergedDST,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
          }
          const endDate: string | null = amendment.ongoing
            ? null
            : (amendment.endDate || (booking.schedule?.ongoing ? null : booking.schedule?.endDate || null));
          let cgPhotoURL: string | null = booking.caregiverPhotoURL || null;
          if (!cgPhotoURL && amendment.caregiverId) {
            const cgSnap = await fdb.collection('caregivers').doc(amendment.caregiverId).get().catch(() => null);
            const cgData = cgSnap?.data() as any;
            cgPhotoURL = cgData?.photo || cgData?.profilePhoto || cgData?.photoURL || cgData?.imageUrl || null;
          }
          const shiftBase = {
            clientId: booking.clientId || amendment.clientId,
            clientName: booking.clientName || amendment.clientName,
            clientPhotoURL: booking.clientPhotoURL || null,
            caregiverId: amendment.caregiverId,
            caregiverName: booking.caregiverName || amendment.caregiverName,
            caregiverPhotoURL: cgPhotoURL,
            status: 'scheduled',
            address: booking.address || '',
            careNeeds: booking.careNeeds || [],
            lifestylePreferences: booking.lifestylePreferences || [],
            rate: booking.rate ?? null,
            paymentMethod: booking.paymentMethod || null,
            notes: booking.notes || '',
            careRecipients: booking.careRecipients || [],
            emergencyContact: booking.emergencyContact || null,
            schedule: { ...(booking.schedule || {}), dayShiftTimes: mergedDST },
            bookingRequestId: amendment.bookingRequestId,
            recurringWeekly: true,
            tasksCompleted: [],
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          };
          const batch = fdb.batch();
          let count = 0;
          for (const [day, blocks] of Object.entries(amendment.newDays)) {
            for (const block of blocks as Array<{ start: string; end: string }>) {
              let dateStr = nextOccurrence(generateFrom, day);
              while (dateStr <= generateTo && count < 490) {
                if (endDate && dateStr > endDate) break;
                batch.set(fdb.collection('shifts').doc(), {
                  ...shiftBase,
                  date: dateStr,
                  startTime: block.start,
                  endTime: block.end,
                });
                count++;
                const d = new Date(dateStr + 'T12:00:00');
                d.setDate(d.getDate() + 7);
                dateStr = d.toISOString().split('T')[0];
              }
            }
          }
          if (count > 0) await batch.commit();
          // Notification handled by onBookingAmendmentWrite Cloud Function
        }
      }
      await fdb.collection('booking_amendments').doc(amendment.id).update({
        status: 'accepted',
        respondedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      addToast('Schedule updated — new visits added.', 'success');
    } catch (e) {
      console.error('handleAcceptAmendment error', e);
      addToast('Failed to accept request', 'error');
    }
  };

  const pendingRequests = requests.filter(r => r.status === 'pending');

  // All pending schedule-change amendments go to the Requests tab
  const orphanAmendments = amendments;

  return (
    <>
    <div className="min-h-screen bg-slate-50 pb-24">
      <CaregiverTopNav />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Bookings</h1>
        <p className="text-sm text-slate-500 mb-6">Manage incoming booking requests and your scheduled shifts.</p>

        {/* Pending shift swaps you've requested (U7) — hidden when none */}
        <div className="mb-6">
          <PendingSwapsPanel swaps={pendingSwaps} title="Pending swaps" subtitle="Swaps you've requested" />
        </div>

        {/* Childcare bookings (U11) — additive; renders nothing when childcare
            is unavailable so the senior page is unchanged. */}
        <ChildcareBookingsSection />

        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-6">
          <button onClick={() => setTab('requests')} className={pillTab(tab === 'requests')}>
            Requests
            {(pendingRequests.length + orphanAmendments.length) > 0 && tab !== 'requests' && (
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
                {pendingRequests.length + orphanAmendments.length}
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
            ) : pendingRequests.length === 0 && orphanAmendments.length === 0 ? (
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
                    blockReason={blockReason}
                  />
                ))}
                {orphanAmendments.map(a => (
                  <div key={a.id} className="bg-white border border-violet-200 rounded-2xl shadow-sm overflow-hidden">
                    <div className="px-5 pt-4 pb-3 flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-violet-100 flex items-center justify-center shrink-0">
                        <span className="text-sm font-bold text-violet-700">
                          {(a.clientName ?? '?')[0].toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <p className="font-semibold text-slate-900">{a.clientName || 'Client'}</p>
                        <p className="text-xs text-slate-400">Schedule change request</p>
                      </div>
                    </div>
                    <div className="border-t border-violet-100 bg-violet-50 px-5 py-3">
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
                        <div className="flex gap-2 shrink-0 mt-0.5">
                          {blockReason === 'membership' ? (
                            <button onClick={() => setMembershipModalOpen(true)} className="px-3 py-1.5 bg-slate-100 border border-slate-200 text-slate-500 text-xs font-semibold rounded-xl flex items-center gap-1 transition-colors hover:bg-slate-200">
                              <Lock className="w-3.5 h-3.5" /> Activate Membership
                            </button>
                          ) : blockReason === 'background' ? (
                            <button onClick={() => navigate('/caregiver/dashboard')} className="px-3 py-1.5 bg-amber-50 border border-amber-200 text-amber-700 text-xs font-semibold rounded-xl flex items-center gap-1 transition-colors hover:bg-amber-100">
                              <Lock className="w-3.5 h-3.5" /> Complete Verification
                            </button>
                          ) : (
                            <button
                              onClick={() => handleAcceptAmendment(a)}
                              className="px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold rounded-xl flex items-center gap-1 transition-colors"
                            >
                              <CheckCircle className="w-3.5 h-3.5" /> Accept
                            </button>
                          )}
                          <button
                            onClick={async () => {
                              if (!db) return;
                              await db.collection('booking_amendments').doc(a.id).update({
                                status: 'declined',
                                respondedAt: firebase.firestore.FieldValue.serverTimestamp(),
                              }).catch(() => {});
                              // Notification handled by onBookingAmendmentWrite Cloud Function
                            }}
                            className="px-3 py-1.5 border border-red-200 hover:bg-red-50 text-red-500 text-xs font-semibold rounded-xl transition-colors"
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* ── Active Bookings ── */}
        {tab === 'active' && (
          <div className="space-y-4">
            {activeLoading || pastLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary-500" /></div>
            ) : (
              (() => {
                // Group shifts by bookingRequestId, preserving order of first occurrence
                const groups = new Map<string, Shift[]>();
                activeShifts.forEach(s => {
                  const key = s.bookingRequestId || s.id;
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key)!.push(s);
                });
                // Bring past bookings back to active if they have a pending amendment
                amendments.forEach(a => {
                  if (a.bookingRequestId && !groups.has(a.bookingRequestId)) {
                    const pastForBooking = pastShifts.filter(s => s.bookingRequestId === a.bookingRequestId);
                    if (pastForBooking.length > 0) groups.set(a.bookingRequestId, pastForBooking);
                  }
                });

                if (groups.size === 0) return (
                  <EmptyState
                    icon={<CalendarDays className="w-6 h-6" />}
                    title="No active bookings"
                    body="Your scheduled and in-progress shifts will appear here."
                  />
                );

                // Amendments are shown in the Requests tab — pass empty array here
                return Array.from(groups.entries()).map(([key, groupShifts]) => (
                  <BookingGroupCard
                    key={key}
                    shifts={groupShifts}
                    amendments={[]}
                    onCancel={handleCancelShift}
                    onAcceptAmendment={handleAcceptAmendment}
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
            ) : pastShifts.length === 0 && overdueShifts.length === 0 ? (
              <EmptyState
                icon={<CalendarDays className="w-6 h-6" />}
                title="No past bookings"
                body="Completed and cancelled shifts will appear here."
              />
            ) : (
              (() => {
                const groups = new Map<string, Shift[]>();
                // Merge overdue (missed) shifts into the same grouping as past shifts
                [...overdueShifts, ...pastShifts].forEach(s => {
                  const key = s.bookingRequestId || s.clientId || s.id;
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key)!.push(s);
                });
                return Array.from(groups.entries()).map(([key, groupShifts]) => (
                  <PastBookingGroupCard
                    key={key}
                    shifts={groupShifts}
                    blockReason={blockReason}
                    onLogHours={shift => {
                      setLogHoursShift(shift);
                      setLogStartDate(shift.date || '');
                      setLogStart(shift.startTime || '');
                      // If shift crosses midnight, end date is next day
                      const crossesMidnight = (shift.endTime || '') < (shift.startTime || '');
                      const endD = crossesMidnight
                        ? (() => { const d = new Date(shift.date + 'T12:00:00'); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; })()
                        : shift.date || '';
                      setLogEndDate(endD);
                      setLogEnd(shift.endTime || '');
                      setLogTasks([]);
                      setLogNote('');
                    }}
                  />
                ));
              })()
            )}
          </div>
        )}
      </div>
    </div>

    {/* ── Log Hours Modal ── */}
    {logHoursShift && (() => {
      type RecipientType = { name: string; relationship?: string; age?: string; photoURL?: string | null; careNeeds?: string[]; careNeedDetails?: Record<string, string[]> };
      const recipients = (logHoursShift.careRecipients || []) as RecipientType[];
      const hasTasks = recipients.some(r => (r.careNeeds || []).length > 0) || (logHoursShift.careNeeds || []).length > 0;
      const toggleTask = (key: string) => setLogTasks(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);

      // Total hours calculation
      const totalMins = (() => {
        if (!logStartDate || !logStart || !logEndDate || !logEnd) return null;
        const s = new Date(`${logStartDate}T${logStart}:00`).getTime();
        const e = new Date(`${logEndDate}T${logEnd}:00`).getTime();
        if (isNaN(s) || isNaN(e) || e <= s) return null;
        return Math.round((e - s) / 60000);
      })();
      const totalLabel = totalMins != null
        ? `${Math.floor(totalMins / 60)}h ${totalMins % 60}m`
        : null;

      return (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm max-h-[90vh] flex flex-col">
            <div className="overflow-y-auto flex-1 p-6 space-y-5">
              {/* Header */}
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-slate-900">Log Hours</h3>
                  <p className="text-sm text-slate-500 mt-0.5">{logHoursShift.clientName}</p>
                </div>
                {totalLabel && (
                  <span className="text-sm font-bold text-primary-600 bg-primary-50 px-3 py-1 rounded-full border border-primary-200">
                    {totalLabel}
                  </span>
                )}
              </div>

              {/* Start date + time */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Actual Start</label>
                <div className="flex gap-2">
                  <input type="date" value={logStartDate} onChange={e => setLogStartDate(e.target.value)}
                    className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary-400" />
                  <input type="time" value={logStart} onChange={e => setLogStart(e.target.value)}
                    className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary-400" />
                </div>
              </div>

              {/* End date + time */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Actual End</label>
                <div className="flex gap-2">
                  <input type="date" value={logEndDate} onChange={e => setLogEndDate(e.target.value)}
                    className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary-400" />
                  <input type="time" value={logEnd} onChange={e => setLogEnd(e.target.value)}
                    className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary-400" />
                </div>
              </div>

              {/* Tasks — hierarchical */}
              {hasTasks && (
                <div>
                  <p className="text-xs font-semibold text-slate-600 mb-2">Tasks Completed</p>
                  <div className="space-y-3">
                    {recipients.some(r => (r.careNeeds || []).length > 0) ? (
                      recipients.map((r, ri) => {
                        const cats = r.careNeeds || [];
                        if (cats.length === 0) return null;
                        const det = r.careNeedDetails || {};
                        return (
                          <div key={ri}>
                            <p className="text-xs font-semibold text-slate-500 mb-1.5">{r.name}{r.relationship ? ` · ${r.relationship}` : ''}</p>
                            <div className="space-y-1.5">
                              {cats.map((cat, ci) => {
                                const subs = det[cat] || [];
                                if (subs.length > 0) {
                                  const allDone = subs.every((sub: string) => logTasks.includes(`${ri}_${cat}_${sub}`));
                                  const doneCnt = subs.filter((sub: string) => logTasks.includes(`${ri}_${cat}_${sub}`)).length;
                                  return (
                                    <div key={ci} className="border border-slate-200 rounded-xl overflow-hidden">
                                      <div className={`flex items-center gap-2 px-3 py-2 ${allDone ? 'bg-green-50' : 'bg-slate-50'}`}>
                                        <CheckCircle className={`w-3.5 h-3.5 shrink-0 ${allDone ? 'text-green-500' : 'text-slate-300'}`} />
                                        <p className={`text-xs font-semibold flex-1 ${allDone ? 'text-green-700' : 'text-primary-600'}`}>{cat}</p>
                                        <span className="text-[10px] text-slate-400">{doneCnt}/{subs.length}</span>
                                      </div>
                                      <div className="px-3 py-2 space-y-1.5 border-t border-slate-100">
                                        {subs.map((sub: string, si: number) => {
                                          const key = `${ri}_${cat}_${sub}`;
                                          const done = logTasks.includes(key);
                                          return (
                                            <button key={si} onClick={() => toggleTask(key)}
                                              className={`w-full flex items-center gap-2 text-xs text-left transition-colors ${done ? 'text-green-700' : 'text-slate-500'}`}>
                                              <CheckCircle className={`w-3.5 h-3.5 shrink-0 ${done ? 'text-green-500' : 'text-slate-300'}`} />
                                              {sub}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  );
                                }
                                const key = `${ri}_${cat}`;
                                const done = logTasks.includes(key);
                                return (
                                  <button key={ci} onClick={() => toggleTask(key)}
                                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl border text-xs text-left transition-colors ${done ? 'bg-green-50 border-green-200 text-green-700' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                                    <CheckCircle className={`w-3.5 h-3.5 shrink-0 ${done ? 'text-green-500' : 'text-slate-300'}`} />
                                    <span className="font-semibold">{cat}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="space-y-1.5">
                        {(logHoursShift.careNeeds || []).map((t: string, i: number) => {
                          const done = logTasks.includes(t);
                          return (
                            <button key={i} onClick={() => toggleTask(t)}
                              className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl border text-xs text-left transition-colors ${done ? 'bg-green-50 border-green-200 text-green-700' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                              <CheckCircle className={`w-3.5 h-3.5 shrink-0 ${done ? 'text-green-500' : 'text-slate-300'}`} />
                              <span className="font-semibold">{t}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Caregiver Notes */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Caregiver Notes <span className="font-normal text-slate-400">(optional)</span></label>
                <textarea value={logNote} onChange={e => setLogNote(e.target.value)} rows={3}
                  placeholder="Any notes about the visit…"
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 resize-none focus:outline-none focus:ring-2 focus:ring-primary-400" />
              </div>
            </div>

            {/* Sticky footer */}
            <div className="p-4 border-t border-slate-100 flex gap-2">
              <button onClick={() => setLogHoursShift(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-50 transition-colors">
                Cancel
              </button>
              <button
                disabled={loggingHours || !logStartDate || !logStart || !logEndDate || !logEnd || !totalMins || totalMins <= 0}
                onClick={async () => {
                  if (!db || !logHoursShift || !logStart || !logEnd || !logStartDate || !logEndDate) return;
                  setLoggingHours(true);
                  try {
                    const startedAt = new Date(`${logStartDate}T${logStart}:00`);
                    const completedAt = new Date(`${logEndDate}T${logEnd}:00`);
                    await db.collection('shifts').doc(logHoursShift.id).update({
                      status: 'completed',
                      startedAt: firebase.firestore.Timestamp.fromDate(startedAt),
                      completedAt: firebase.firestore.Timestamp.fromDate(completedAt),
                      loggedManually: true,
                      tasksCompleted: logTasks,
                      ...(logNote.trim() ? { completionNotes: logNote.trim() } : {}),
                      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    });
                    addToast('Hours logged successfully', 'success');
                    setLogHoursShift(null);
                  } catch {
                    addToast('Failed to log hours', 'error');
                  } finally {
                    setLoggingHours(false);
                  }
                }}
                className="flex-1 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-semibold hover:bg-primary-700 disabled:opacity-50 transition-colors"
              >
                {loggingHours ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      );
    })()}
    </>
  );
};
