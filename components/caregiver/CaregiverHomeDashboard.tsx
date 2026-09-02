import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays, Clock, CheckCircle,
  MapPin, MessageSquare, DollarSign, Users,
  TrendingUp, FileText, Heart, Loader2, ChevronRight,
  CreditCard, Lock,
} from 'lucide-react';
import type { Caregiver, AddToastFunction } from '../../types';
import { db } from '../../lib/firebase';
import firebase from '../../lib/firebase';
import { authService, shiftHoursService, dbService, normalizeJobPost } from '../../services/api';
import { useCareConnex } from '../../context/CareConnexContext';
import { useCaregiverGate } from '../../hooks/useCaregiverGate';
import { CaregiverCareRequestsCard } from './CaregiverCareRequestsCard';
import { CaregiverBookingsCard } from './CaregiverBookingsCard';
import { shiftDisplayStatus } from '../../utils/shiftUtils';
import { CaregiverOnboardingDashboard, CaregiverProgressCard } from './CaregiverOnboardingDashboard';

interface CaregiverHomeDashboardProps {
  profile: Caregiver;
  onNavigate: (view: any) => void;
  onShowToast?: AddToastFunction;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(t?: string): string {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr || '0', 10);
  if (isNaN(h)) return t;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function fmtTs(ts: any): string {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getFirstName(name: string): string {
  return name?.split(' ')[0] || 'there';
}

function getShiftHoursDisplay(h: any): number {
  const start = h.finalStartTime ?? h.submittedStartTime;
  const end = h.finalEndTime ?? h.submittedEndTime;
  if (start && end) return (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
  return h.finalTotalHours ?? h.submittedTotalHours ?? 0;
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export const CaregiverHomeDashboard: React.FC<CaregiverHomeDashboardProps> = ({
  profile,
  onNavigate,
  onShowToast,
}) => {
  const navigate = useNavigate();
  const { blockedIds, setMembershipModalOpen } = useCareConnex();
  const { blockReason } = useCaregiverGate();
  const currentUser = authService.getCurrentUser();
  const uid = profile.uid || profile.id || currentUser?.uid || '';

  // Data
  const [bookingRequests, setBookingRequests] = useState<any[]>([]);
  const [bookingsLoaded, setBookingsLoaded] = useState(false);
  const [rawJobs, setRawJobs] = useState<any[]>([]);
  const [appliedJobIds, setAppliedJobIds] = useState<Set<string>>(new Set());
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [allShifts, setAllShifts] = useState<any[]>([]);
  const [shiftHours, setShiftHours] = useState<any[]>([]);
  const [scheduleTab, setScheduleTab] = useState<'active' | 'upcoming'>('upcoming');
  const [startingShift, setStartingShift] = useState<string | null>(null);
  const [endingShift, setEndingShift] = useState<string | null>(null);
  const [endNote, setEndNote] = useState('');
  const [taskModalShift, setTaskModalShift] = useState<any | null>(null);

  // Real-time: booking requests + shifts
  useEffect(() => {
    if (!uid || !db) return;
    const unsubs: (() => void)[] = [];

    const brUnsub = db.collection('booking_requests')
      .where('caregiverId', '==', uid)
      .onSnapshot(snap => {
        setBookingRequests(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        setBookingsLoaded(true);
      }, () => { setBookingsLoaded(true); });
    unsubs.push(brUnsub);

    const sUnsub = db.collection('shifts')
      .where('caregiverId', '==', uid)
      .onSnapshot(snap => {
        setAllShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, () => {});
    unsubs.push(sUnsub);

    return () => unsubs.forEach(u => { try { u(); } catch {} });
  }, [uid]);

  // Live jobs listener — same as the Jobs page so radius changes always reflect current data
  useEffect(() => {
    if (!uid || !db) return;
    const unsub = db.collection('job_posts')
      .where('status', '==', 'open')
      .orderBy('createdAt', 'desc')
      .onSnapshot(snap => {
        setRawJobs(snap.docs.map(d => normalizeJobPost({ id: d.id, ...d.data() })));
        setJobsLoaded(true);
      }, () => {
        dbService.getOpenJobs().then(all => { setRawJobs(all); setJobsLoaded(true); }).catch(() => setJobsLoaded(true));
      });

    db.collection('job_applications').where('caregiverId', '==', uid).get()
      .then(snap => setAppliedJobIds(new Set(snap.docs.map(d => (d.data() as any).jobId).filter(Boolean))))
      .catch(() => {});

    return unsub;
  }, [uid]);

  // Filter + sort inline so it re-runs whenever profile (radius/location) changes
  const cgLat = (profile as any).latitude ?? (profile as any).lat ?? null;
  const cgLng = (profile as any).longitude ?? (profile as any).lng ?? null;
  const hasLocation = cgLat != null && cgLng != null;
  const radius: number = (profile as any).serviceRadius || (profile as any).travelRadius || 0;

  const openJobs = (() => {
    let filtered = rawJobs.filter((j: any) => !appliedJobIds.has(j.id));
    if (hasLocation && radius > 0) {
      filtered = filtered.filter((j: any) => {
        if (j.lat == null || j.lng == null) return true;
        return haversine(cgLat, cgLng, j.lat, j.lng) <= radius;
      });
    }
    if (hasLocation) {
      filtered.sort((a: any, b: any) => {
        const dA = a.lat != null && a.lng != null ? haversine(cgLat, cgLng, a.lat, a.lng) : Infinity;
        const dB = b.lat != null && b.lng != null ? haversine(cgLat, cgLng, b.lat, b.lng) : Infinity;
        return dA - dB;
      });
    }
    return filtered.slice(0, 4);
  })();

  // Shift hours
  useEffect(() => {
    if (!uid) return;
    return shiftHoursService.subscribeForCaregiver(uid, rows => setShiftHours(rows));
  }, [uid]);

  // ── Derived state ──────────────────────────────────────────────────────────

  const todayStr = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  })();
  const acceptedBookings = bookingRequests.filter(b => b.status === 'accepted');
  const hasActiveFamilies = acceptedBookings.length > 0;

  const todayShifts = allShifts.filter(s => s.date === todayStr);
  // Include in-progress shifts from any date — caregiver may have started a shift yesterday and not ended it
  const activeShifts = allShifts.filter(s => s.status === 'in-progress').sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
  const upcomingTodayShifts = todayShifts.filter(s => s.status === 'scheduled').sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
  // Unsubmitted: completed shifts with no shiftHours entry yet
  const submittedShiftIds = new Set(shiftHours.map((h: any) => h.shiftId || h.appointmentId));
  const unsubmittedShifts = allShifts
    .filter(s => s.status === 'completed' && !submittedShiftIds.has(s.id))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // Action items: unsubmitted → correction (client-waiting items excluded)
  const correctionHours = shiftHours.filter(h => h.status === 'correction_proposed');

  // Build a clientId → photoURL map from all loaded records so older docs without a photo still resolve
  const clientPhotoMap: Record<string, string> = {};
  shiftHours.forEach((h: any) => {
    if (h.clientId && h.clientPhotoURL && !clientPhotoMap[h.clientId]) {
      clientPhotoMap[h.clientId] = h.clientPhotoURL;
    }
  });

  // Earnings
  const now = new Date();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const earnedHours = shiftHours.filter(h =>
    ['paid', 'cash_confirmed', 'approved', 'auto_approved'].includes(h.status)
  );
  const weekEarnings = earnedHours
    .filter(h => new Date(h.submittedAt || 0) >= weekStart)
    .reduce((s, h) => s + (h.grossPay ?? (getShiftHoursDisplay(h) * (h.payRate ?? 0))), 0);
  const monthEarnings = earnedHours
    .filter(h => new Date(h.submittedAt || 0) >= monthStart)
    .reduce((s, h) => s + (h.grossPay ?? (getShiftHoursDisplay(h) * (h.payRate ?? 0))), 0);
  // Greeting (used in home-base mode)
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const firstName = getFirstName(profile.name);
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });


  if (!bookingsLoaded) return null;

  if (!hasActiveFamilies) {
    return (
      <CaregiverOnboardingDashboard
        profile={profile}
        onNavigate={onNavigate}
        onShowToast={onShowToast}
        jobs={openJobs.filter((j: any) => !blockedIds.has(j.clientId))}
        jobsLoaded={jobsLoaded}
      />
    );
  }

  // ── HOME BASE state — has active families ──────────────────────────────────

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-24">

      {/* Greeting */}
      <div className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-ink-900 tracking-[-0.02em]">Good {timeOfDay}, {firstName}!</h1>
        <p className="text-sm text-slate-500 mt-0.5">{today}</p>
      </div>

      {/* Progress card — only renders when membership/bgc/transport is incomplete */}
      <CaregiverProgressCard profile={profile} onNavigate={onNavigate} onShowToast={onShowToast} compactMode />

      {/* Row 1 — Care Requests | Today's Schedule | My Families */}
      <div className="grid lg:grid-cols-3 gap-4 mb-4">

        {/* Care Requests */}
        <CaregiverCareRequestsCard caregiverId={uid} />

        {/* Today's Schedule */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-primary-500" />
              <h2 className="font-semibold text-slate-900">Today's Schedule</h2>
            </div>
          </div>
          <div className="flex bg-slate-100 rounded-lg p-0.5 mb-4">
            {(['active', 'upcoming'] as const).map(tab => (
              <button key={tab}
                onClick={() => setScheduleTab(tab)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors capitalize ${scheduleTab === tab ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
              >
                {tab === 'active'
                  ? <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  : <Clock className="w-3.5 h-3.5" />
                }
                {tab}
              </button>
            ))}
          </div>
          {(() => {
            const list = scheduleTab === 'active' ? activeShifts : upcomingTodayShifts;
            if (list.length === 0) return (
              <div className="text-center py-5">
                <CalendarDays className="w-8 h-8 text-slate-200 mx-auto mb-2" />
                <p className="text-sm text-slate-400">
                  {scheduleTab === 'active' ? 'No active shifts right now' : 'No upcoming shifts today'}
                </p>
              </div>
            );
            return (
              <div className="space-y-3 max-h-72 overflow-y-auto">
                {list.map((s: any) => {
                  const ds = shiftDisplayStatus(s);
                  const isInProgress = s.status === 'in-progress';
                  const cardBorder = isInProgress ? 'border-green-300 bg-green-50' : ds === 'overdue' ? 'border-orange-300 bg-orange-50' : 'border-slate-200';
                  const statusColor = isInProgress ? 'text-green-600' : ds === 'overdue' ? 'text-orange-600' : 'text-slate-500';
                  const statusText = isInProgress ? 'In Progress' : ds === 'overdue' ? 'Overdue' : 'Upcoming';
                  return (
                    <div key={s.id} className={`rounded-xl p-3 border ${cardBorder}`}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
                          {s.clientPhotoURL
                            ? <img src={s.clientPhotoURL} alt={s.clientName} className="w-full h-full object-cover" />
                            : <span className="text-sm font-bold text-primary-600">{(s.clientName || 'F')[0].toUpperCase()}</span>
                          }
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-slate-900 text-sm truncate">{s.clientName || 'Family'}</p>
                          <p className={`text-xs font-medium ${statusColor}`}>{statusText}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-slate-500">
                        <Clock className="w-3 h-3 flex-shrink-0" />
                        <span className="font-medium">{fmtTime(s.startTime)} – {fmtTime(s.endTime)}</span>
                      </div>
                      {isInProgress && s.startedAt && (
                        <div className="flex items-center gap-1.5 text-xs text-green-600 mt-0.5">
                          <CheckCircle className="w-3 h-3 flex-shrink-0" />
                          <span>Started {fmtTs(s.startedAt)}</span>
                        </div>
                      )}
                      {s.careRecipients?.length > 0 && (
                        <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-1">
                          <Heart className="w-3 h-3 flex-shrink-0 text-rose-400" />
                          <span className="truncate">{s.careRecipients.map((r: any) => r.name || r).join(', ')}</span>
                        </div>
                      )}
                      {s.address && (
                        <div className="flex items-center gap-1.5 text-xs text-slate-400 mt-1">
                          <MapPin className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{s.address}</span>
                        </div>
                      )}
                      {isInProgress && (() => {
                        const recipients: any[] = s.careRecipients || [];
                        const completed: string[] = s.tasksCompleted || [];
                        let totalTasks = 0; let doneTasks = 0;
                        recipients.forEach((r: any, ri: number) => {
                          const needs: string[] = r.careNeeds || [];
                          const det: Record<string, string[]> = r.careNeedDetails || {};
                          needs.forEach(need => {
                            const subs = det[need] || [];
                            if (subs.length > 0) { totalTasks += subs.length; doneTasks += subs.filter((sub: string) => completed.includes(`${ri}_${need}_${sub}`)).length; }
                            else { totalTasks++; if (completed.includes(`${ri}_${need}`)) doneTasks++; }
                          });
                        });
                        if (totalTasks === 0) return null;
                        return (
                          <button
                            onClick={() => setTaskModalShift(s)}
                            className="mt-2 w-full flex items-center justify-between px-3 py-2 bg-white hover:bg-primary-50 border border-primary-300 rounded-xl transition-colors"
                          >
                            <div className="flex items-center gap-2">
                              <CheckCircle className="w-3.5 h-3.5 text-primary-500" />
                              <span className="text-xs font-semibold text-primary-700">View Tasks</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${doneTasks === totalTasks ? 'bg-green-100 text-green-700' : 'bg-primary-100 text-primary-700'}`}>{doneTasks}/{totalTasks}</span>
                              <ChevronRight className="w-3.5 h-3.5 text-primary-400" />
                            </div>
                          </button>
                        );
                      })()}
                      {isInProgress && endingShift !== s.id && (
                        <button
                          onClick={() => { setEndingShift(s.id); setEndNote(''); }}
                          className="mt-2 w-full py-1.5 bg-slate-700 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg transition-colors"
                        >
                          End Shift
                        </button>
                      )}
                      {isInProgress && endingShift === s.id && (
                        <div className="mt-2 space-y-2">
                          <textarea
                            value={endNote}
                            onChange={e => setEndNote(e.target.value)}
                            placeholder="Add a note (optional)..."
                            rows={2}
                            className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-primary-400"
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => setEndingShift(null)}
                              className="flex-1 py-1.5 border border-slate-200 text-slate-600 text-xs font-semibold rounded-lg hover:bg-slate-50 transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={async () => {
                                if (!db) return;
                                await db.collection('shifts').doc(s.id).update({
                                  status: 'completed',
                                  completedAt: firebase.firestore.FieldValue.serverTimestamp(),
                                  ...(endNote.trim() ? { completionNotes: endNote.trim() } : {}),
                                });
                                setEndingShift(null);
                                setEndNote('');
                              }}
                              className="flex-1 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-xs font-semibold rounded-lg transition-colors"
                            >
                              Confirm
                            </button>
                          </div>
                        </div>
                      )}
                      {(() => {
                        if (isInProgress) return null;
                        if (ds === 'overdue') return null;
                        const minsUntil = (new Date(`${s.date}T${s.startTime}`).getTime() - Date.now()) / 60000;
                        if (minsUntil > 15) return null;
                        return blockReason === 'membership' ? (
                          <button onClick={() => setMembershipModalOpen(true)} className="mt-2 w-full py-1.5 bg-slate-100 border border-slate-200 text-slate-500 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors hover:bg-slate-200">
                            <Lock className="w-3 h-3" /> Activate Membership
                          </button>
                        ) : blockReason === 'background' ? (
                          <button onClick={() => navigate('/caregiver/dashboard')} className="mt-2 w-full py-1.5 bg-amber-50 border border-amber-200 text-amber-700 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors hover:bg-amber-100">
                            <Lock className="w-3 h-3" /> Complete Verification
                          </button>
                        ) : (
                          <button
                            onClick={async () => {
                              if (!db || startingShift) return;
                              setStartingShift(s.id);
                              try {
                                await db.collection('shifts').doc(s.id).update({ status: 'in-progress', startedAt: new Date() });
                              } finally {
                                setStartingShift(null);
                              }
                            }}
                            disabled={startingShift === s.id}
                            className="mt-2 w-full py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 disabled:opacity-50 transition-colors"
                          >
                            {startingShift === s.id ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                            Start Shift
                          </button>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {/* My Families */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-primary-500" />
              <h2 className="font-semibold text-slate-900">My Families</h2>
            </div>
            <button onClick={() => navigate('/caregiver/families')} className="text-xs text-primary-600 font-medium hover:underline">View all</button>
          </div>
          <div className="space-y-3 max-h-80 overflow-y-auto">
            {acceptedBookings.filter((b: any, i: number, arr: any[]) => arr.findIndex((x: any) => x.clientId === b.clientId) === i).slice(0, 2).map((b: any) => {
              const schedDays: string[] = (() => {
                const dst = b.schedule?.dayShiftTimes;
                if (dst && typeof dst === 'object') return Object.keys(dst);
                return b.schedule?.days || [];
              })();
              const rate = b.rate ?? b.caregiverRate ?? null;
              return (
                <div key={b.id} className="border border-slate-200 rounded-xl p-3.5">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-11 h-11 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                      {b.clientPhotoURL
                        ? <img src={b.clientPhotoURL} alt={b.clientName} className="w-full h-full object-cover" />
                        : <span className="text-sm font-bold text-primary-600">{(b.clientName || 'F')[0].toUpperCase()}</span>
                      }
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-slate-900 truncate">{b.clientName || 'Family'}</p>
                      <p className="text-xs text-slate-500">Client</p>
                    </div>
                  </div>
                  <div className="border-t border-slate-100 mb-3" />
                  <div className="flex items-center gap-3 mb-2 flex-wrap">
                    {rate != null && (
                      <p className="text-sm font-bold text-slate-800"><span className="text-primary-600">${rate}</span><span className="text-xs font-normal text-slate-400">/hr</span></p>
                    )}
                    {schedDays.length > 0 && (
                      <div className="flex gap-1 flex-wrap">
                        {schedDays.slice(0, 5).map((d: string) => (
                          <span key={d} className="text-[10px] font-semibold px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded">{d.slice(0,3)}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  {(() => {
                    const recipient = (b.careRecipients || [])[0];
                    const recipientName = recipient?.name || recipient?.firstName || b.clientName || '';
                    return recipientName ? (
                      <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-3">
                        <Heart className="w-3 h-3 text-rose-400 flex-shrink-0" />
                        <span>Caring for: <span className="font-semibold text-slate-700">{recipientName}</span></span>
                      </div>
                    ) : null;
                  })()}
                  <button
                    onClick={() => navigate('/caregiver/inbox')}
                    className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
                  >
                    <MessageSquare className="w-3.5 h-3.5" /> Message
                  </button>
                </div>
              );
            })}
          </div>
        </div>

      </div>

      {/* Row 2 — Bookings | Timesheets | Earnings */}
      <div className="grid lg:grid-cols-3 gap-4 mb-4">

        {/* Bookings */}
        <CaregiverBookingsCard caregiverId={uid} />

        {/* Timesheets */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary-500" />
              <h2 className="font-semibold text-slate-900">Timesheets</h2>
            </div>
            <button onClick={() => navigate('/caregiver/payments')} className="text-xs text-primary-600 font-medium hover:underline">View all</button>
          </div>
          {(() => {
            const hasActions = unsubmittedShifts.length > 0 || correctionHours.length > 0;
            if (!hasActions) {
              return (
                <div className="flex items-center gap-3 p-3 bg-green-50 rounded-xl">
                  <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <CheckCircle className="w-4 h-4 text-green-600" />
                  </div>
                  <p className="text-sm text-slate-600">All timesheets up to date</p>
                </div>
              );
            }
            const fmtT = (val: any) => {
              const d = val && typeof val.toDate === 'function' ? val.toDate() : val ? new Date(val) : null;
              return d ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) : '';
            };
            const fmtD = (val: any) => {
              const d = val && typeof val.toDate === 'function' ? val.toDate() : val ? new Date(val) : null;
              return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
            };
            // Unified action items: unsubmitted first, then correction
            const fmtDuration = (hrs: number) => { const s = Math.round(hrs * 3600); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60; return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; };
            type ActionItem = { key: string; clientName: string; clientPhotoURL?: string; clientId?: string; shiftDate: string; startTs: any; endTs: any; hrs: number; pay: number; badge: { label: string; color: string; bg: string }; actionLabel: string };
            const items: ActionItem[] = [
              ...unsubmittedShifts.map(s => {
                const startTs = s.startedAt ?? null;
                const endTs   = s.completedAt ?? null;
                const startD  = startTs && typeof startTs.toDate === 'function' ? startTs.toDate() : startTs ? new Date(startTs) : null;
                const endD    = endTs   && typeof endTs.toDate   === 'function' ? endTs.toDate()   : endTs   ? new Date(endTs)   : null;
                const hrs     = startD && endD ? (endD.getTime() - startD.getTime()) / 3_600_000 : 0;
                const pay     = hrs * (s.rate ?? 0);
                return { key: s.id, clientName: s.clientName || 'Client', clientPhotoURL: s.clientPhotoURL, clientId: s.clientId, shiftDate: fmtD(s.date ? `${s.date}T00:00` : null), startTs, endTs, hrs, pay, badge: { label: 'Not Submitted', color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' }, actionLabel: 'Submit' };
              }),
              ...correctionHours.map(h => {
                const hrs = getShiftHoursDisplay(h);
                const pay = h.grossPay ?? (hrs * (h.payRate ?? 0));
                return { key: h.id, clientName: h.clientName || 'Client', clientPhotoURL: h.clientPhotoURL || clientPhotoMap[h.clientId], clientId: h.clientId, shiftDate: fmtD(h.finalStartTime ?? h.submittedStartTime), startTs: h.finalStartTime ?? h.submittedStartTime, endTs: h.finalEndTime ?? h.submittedEndTime, hrs, pay, badge: { label: 'Correction Recvd', color: 'text-orange-700', bg: 'bg-orange-50 border-orange-200' }, actionLabel: 'Respond' };
              }),
            ];
            return (
              <div className="space-y-2">
                {items.slice(0, 2).map(item => {
                  const photoURL = item.clientPhotoURL || clientPhotoMap[item.clientId ?? ''] || null;
                  return (
                    <div key={item.key} className="border border-slate-200 rounded-xl p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-7 h-7 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
                            {photoURL
                              ? <img src={photoURL} className="w-full h-full object-cover" alt="" />
                              : <span className="text-xs font-bold text-primary-600">{item.clientName[0].toUpperCase()}</span>
                            }
                          </div>
                          <span className="text-xs font-semibold text-slate-800 truncate">{item.clientName}</span>
                        </div>
                        <span className="text-xs text-slate-400 flex-shrink-0 ml-2">{item.shiftDate}</span>
                      </div>
                      {item.startTs && item.endTs && (
                        <p className="text-xs text-slate-500 mb-1.5">
                          <span className="text-slate-400">{fmtD(item.startTs)}</span> {fmtT(item.startTs)}
                          <span className="text-slate-400"> → </span>
                          <span className="text-slate-400">{fmtD(item.endTs)}</span> {fmtT(item.endTs)}
                        </p>
                      )}
                      <div className="flex items-center gap-2 text-xs flex-wrap">
                        {item.hrs > 0 && <><span className="text-slate-500">{fmtDuration(item.hrs)}</span><span className="text-slate-300">·</span></>}
                        <span className="font-semibold text-slate-700">${item.pay.toFixed(2)}</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold border bg-blue-50 text-blue-700 border-blue-200">
                          Card
                        </span>
                        <span className={`ml-auto px-2 py-0.5 rounded-full text-[10px] font-semibold border ${item.badge.bg} ${item.badge.color}`}>{item.badge.label}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {/* Earnings */}
        {(() => {
          const getAmt = (h: any) => h.grossPay ?? (getShiftHoursDisplay(h) * (h.payRate ?? 0));
          const inReviewHours      = shiftHours.filter((h: any) => ['submitted', 'pending_client_review', 'caregiver_counter_proposed'].includes(h.status));
          const pendingCreditHours = shiftHours.filter((h: any) => ['approved', 'auto_approved'].includes(h.status));
          const failedHours        = shiftHours.filter((h: any) => h.status === 'payment_failed');
          const allOutstanding     = [...inReviewHours, ...correctionHours, ...pendingCreditHours, ...failedHours];
          const openCount          = unsubmittedShifts.length + allOutstanding.length;
          const needsActionCount   = unsubmittedShifts.length + correctionHours.length;
          const grandTotal = allOutstanding.reduce((s: number, h: any) => s + getAmt(h), 0);
          return (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-primary-500" />
                  <h2 className="font-semibold text-slate-900">Earnings</h2>
                </div>
                <button onClick={() => navigate('/caregiver/payments')} className="text-xs text-primary-600 font-medium hover:underline">View all</button>
              </div>

              {allOutstanding.length === 0 && unsubmittedShifts.length === 0 ? (
                <div className="space-y-3">
                  <div className="bg-primary-50 rounded-xl p-3">
                    <p className="text-xs font-semibold text-primary-700 mb-0.5">This Week</p>
                    <p className="text-2xl font-bold text-primary-900">${weekEarnings.toFixed(2)}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-slate-50 rounded-xl p-3">
                      <p className="text-xs font-semibold text-slate-500 mb-0.5">This Month</p>
                      <p className="text-lg font-bold text-slate-900">${monthEarnings.toFixed(2)}</p>
                    </div>
                    <div className="bg-slate-50 rounded-xl p-3">
                      <p className="text-xs font-semibold text-slate-500 mb-0.5">All time</p>
                      <p className="text-lg font-bold text-slate-900">${earnedHours.reduce((s: number, h: any) => s + getAmt(h), 0).toFixed(2)}</p>
                    </div>
                  </div>
                  {profile.hourlyRate && (
                    <div className="flex items-center gap-2 text-xs text-slate-500 pt-1">
                      <TrendingUp className="w-3.5 h-3.5 text-slate-400" />
                      <span>Your rate: <span className="font-semibold text-slate-700">${profile.hourlyRate}/hr</span></span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="bg-slate-50 rounded-xl p-4 space-y-3">
                    {/* Outstanding */}
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-slate-500">Outstanding</span>
                      <span className="text-sm font-semibold text-slate-900">{openCount} shift{openCount !== 1 ? 's' : ''}</span>
                    </div>
                    {needsActionCount > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-amber-600">Needs your action</span>
                        <span className="text-sm font-semibold text-amber-700">{needsActionCount} shift{needsActionCount !== 1 ? 's' : ''}</span>
                      </div>
                    )}
                    <div className="h-px bg-slate-200" />
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-sm text-slate-500">
                        <CreditCard className="w-3.5 h-3.5" /> Card
                      </div>
                      <span className="text-sm font-semibold text-slate-900">${grandTotal.toFixed(2)}</span>
                    </div>
                    <div className="h-px bg-slate-200" />
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-slate-700">Total outstanding</span>
                      <span className="text-base font-bold text-primary-600">${grandTotal.toFixed(2)}</span>
                    </div>
                  </div>

                </div>
              )}
            </div>
          );
        })()}

      </div>

      {/* Task Modal */}
      {taskModalShift && (() => {
        const s = taskModalShift;
        const recipients: any[] = s.careRecipients || [];
        const completed: string[] = s.tasksCompleted || [];
        const toggleTask = async (key: string) => {
          if (!db) return;
          const updated = completed.includes(key) ? completed.filter((t: string) => t !== key) : [...completed, key];
          await db.collection('shifts').doc(s.id).update({ tasksCompleted: updated }).catch(() => {});
          setTaskModalShift((prev: any) => prev ? { ...prev, tasksCompleted: updated } : null);
        };
        const toggleCategory = async (subKeys: string[]) => {
          if (!db) return;
          const allDone = subKeys.every(k => completed.includes(k));
          const updated = allDone ? completed.filter((k: string) => !subKeys.includes(k)) : [...new Set([...completed, ...subKeys])];
          await db.collection('shifts').doc(s.id).update({ tasksCompleted: updated }).catch(() => {});
          setTaskModalShift((prev: any) => prev ? { ...prev, tasksCompleted: updated } : null);
        };
        let totalTasks = 0; let doneTasks = 0;
        recipients.forEach((r: any, ri: number) => {
          const needs: string[] = r.careNeeds || [];
          const det: Record<string, string[]> = r.careNeedDetails || {};
          needs.forEach(need => {
            const subs = det[need] || [];
            if (subs.length > 0) { totalTasks += subs.length; doneTasks += subs.filter((sub: string) => completed.includes(`${ri}_${need}_${sub}`)).length; }
            else { totalTasks++; if (completed.includes(`${ri}_${need}`)) doneTasks++; }
          });
        });
        return (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/40" onClick={() => setTaskModalShift(null)}>
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                <div>
                  <p className="font-bold text-slate-900 text-sm">{s.clientName || 'Shift'}</p>
                  <p className="text-xs text-slate-500">{fmtTime(s.startTime)} – {fmtTime(s.endTime)}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${doneTasks === totalTasks ? 'bg-green-100 text-green-700' : 'bg-primary-100 text-primary-700'}`}>{doneTasks}/{totalTasks}</span>
                  <button onClick={() => setTaskModalShift(null)} className="text-slate-400 hover:text-slate-600">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              </div>
              <div className="overflow-y-auto p-4 space-y-2">
                {recipients.map((r: any, ri: number) => {
                  const needs: string[] = r.careNeeds || [];
                  const det: Record<string, string[]> = r.careNeedDetails || {};
                  if (needs.length === 0) return null;
                  return (
                    <div key={ri} className="space-y-1.5">
                      {needs.map(need => {
                        const subtasks: string[] = det[need] || [];
                        if (subtasks.length > 0) {
                          const subKeys = subtasks.map((sub: string) => `${ri}_${need}_${sub}`);
                          const allDone = subKeys.every(k => completed.includes(k));
                          return (
                            <div key={need} className="rounded-lg border border-blue-200 overflow-hidden">
                              <button type="button" onClick={() => toggleCategory(subKeys)}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${allDone ? 'bg-primary-500' : 'bg-primary-50 hover:bg-primary-100'}`}>
                                <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center ${allDone ? 'bg-white border-white' : 'border-primary-300 bg-white'}`}>
                                  {allDone && <CheckCircle className="w-2.5 h-2.5 text-primary-500" />}
                                </div>
                                <span className={`text-xs font-semibold ${allDone ? 'text-white line-through' : 'text-primary-700'}`}>{need}</span>
                              </button>
                              <div className="px-3 pb-1">
                                {subtasks.map((sub: string) => {
                                  const key = `${ri}_${need}_${sub}`;
                                  const done = completed.includes(key);
                                  return (
                                    <button key={key} type="button" onClick={() => toggleTask(key)} className="w-full flex items-center gap-2 text-left py-1.5 pl-2">
                                      <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-colors ${done ? 'bg-primary-500 border-primary-500' : 'border-slate-300'}`}>
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
                        const done = completed.includes(key);
                        return (
                          <button key={need} type="button" onClick={() => toggleTask(key)}
                            className={`w-full flex items-center gap-2 text-left rounded-lg border overflow-hidden px-3 py-2 transition-colors ${done ? 'bg-primary-500 border-primary-500' : 'bg-primary-50 border-blue-200 hover:bg-primary-100'}`}>
                            <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center ${done ? 'bg-white border-white' : 'border-primary-300 bg-white'}`}>
                              {done && <CheckCircle className="w-2.5 h-2.5 text-primary-500" />}
                            </div>
                            <span className={`text-xs font-semibold ${done ? 'text-white line-through' : 'text-primary-700'}`}>{need}</span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

    </div>
  );
};
