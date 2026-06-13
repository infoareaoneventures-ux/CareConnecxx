import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Calendar, CalendarDays, Clock, CheckCircle, Briefcase,
  Users, MapPin, Star, MessageSquare, DollarSign,
  TrendingUp, FileText, Mail, Heart,
} from 'lucide-react';
import type { Caregiver, AddToastFunction } from '../../types';
import { db } from '../../lib/firebase';
import { authService, shiftHoursService } from '../../services/api';
import { CaregiverOnboardingDashboard } from './CaregiverOnboardingDashboard';

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

function fmtDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
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
  const currentUser = authService.getCurrentUser();
  const uid = profile.uid || profile.id || currentUser?.uid || '';

  // Data
  const [bookingRequests, setBookingRequests] = useState<any[]>([]);
  const [pendingAmendments, setPendingAmendments] = useState<any[]>([]);
  const [allShifts, setAllShifts] = useState<any[]>([]);
  const [shiftHours, setShiftHours] = useState<any[]>([]);
  const [openJobs, setOpenJobs] = useState<any[]>([]);
  const [myApplications, setMyApplications] = useState<any[]>([]);
  const [myInterviews, setMyInterviews] = useState<any[]>([]);

  // UI tabs
  const [bookingTab, setBookingTab] = useState<'pending' | 'upcoming'>('pending');
  const [scheduleTab, setScheduleTab] = useState<'active' | 'upcoming'>('upcoming');
  const [careRequestsTab, setCareRequestsTab] = useState<'applications' | 'interviews'>('applications');

  // Real-time: booking requests + shifts
  useEffect(() => {
    if (!uid || !db) return;
    const unsubs: (() => void)[] = [];

    const brUnsub = db.collection('booking_requests')
      .where('caregiverId', '==', uid)
      .onSnapshot(snap => {
        setBookingRequests(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, () => {});
    unsubs.push(brUnsub);

    const sUnsub = db.collection('shifts')
      .where('caregiverId', '==', uid)
      .onSnapshot(snap => {
        setAllShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, () => {});
    unsubs.push(sUnsub);

    return () => unsubs.forEach(u => { try { u(); } catch {} });
  }, [uid]);

  // Pending booking amendments (schedule change requests from clients)
  useEffect(() => {
    if (!uid || !db) return;
    const unsub = db.collection('booking_amendments')
      .where('caregiverId', '==', uid)
      .where('status', '==', 'pending')
      .onSnapshot(snap => {
        setPendingAmendments(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, () => {});
    return () => unsub();
  }, [uid]);

  // Interviews (interview_requests + video_interviews)
  useEffect(() => {
    if (!uid || !db) return;
    const unsubs: (() => void)[] = [];
    let irList: any[] = [];
    let viList: any[] = [];
    const merge = () => {
      const combined = [...irList, ...viList].sort((a, b) => {
        const ta = a.scheduledTime || a.createdAt || 0;
        const tb = b.scheduledTime || b.createdAt || 0;
        return tb > ta ? 1 : -1;
      });
      setMyInterviews(combined);
    };
    unsubs.push(db.collection('interview_requests').where('caregiverId', '==', uid).orderBy('createdAt', 'desc').onSnapshot(snap => { irList = snap.docs.map(d => ({ id: d.id, _src: 'ir', ...d.data() })); merge(); }, () => {}));
    unsubs.push(db.collection('video_interviews').where('caregiverId', '==', uid).orderBy('scheduledTime', 'desc').onSnapshot(snap => { viList = snap.docs.map(d => ({ id: d.id, _src: 'vi', ...d.data() })); merge(); }, () => {}));
    return () => unsubs.forEach(u => { try { u(); } catch {} });
  }, [uid]);

  // Shift hours
  useEffect(() => {
    if (!uid) return;
    return shiftHoursService.subscribeForCaregiver(uid, rows => setShiftHours(rows));
  }, [uid]);

  // One-time: open jobs + my applications
  useEffect(() => {
    if (!db) return;
    db.collection('job_posts')
      .where('status', '==', 'open')
      .orderBy('createdAt', 'desc')
      .limit(4)
      .get()
      .then(snap => setOpenJobs(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
      .catch(() => {});

    if (!uid) return;
    db.collection('job_applications')
      .where('caregiverId', '==', uid)
      .orderBy('appliedAt', 'desc')
      .limit(5)
      .get()
      .then(snap => setMyApplications(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
      .catch(() => {});
  }, [uid]);

  // ── Derived state ──────────────────────────────────────────────────────────

  const todayStr = new Date().toISOString().slice(0, 10);
  const pendingBookings = bookingRequests.filter(b => b.status === 'pending');
  const acceptedBookings = bookingRequests.filter(b => b.status === 'accepted');
  const hasActiveFamilies = acceptedBookings.length > 0;

  const todayShifts = allShifts.filter(s => s.date === todayStr);
  const activeShifts = todayShifts.filter(s => s.status === 'in-progress');
  const upcomingTodayShifts = todayShifts.filter(s => s.status === 'scheduled');
  const upcomingShifts = allShifts
    .filter(s => s.date > todayStr && (s.status === 'scheduled' || s.status === 'in-progress'))
    .sort((a, b) => a.date.localeCompare(b.date));

  const pendingReviewHours = shiftHours.filter(h =>
    ['pending_client_review', 'caregiver_counter_proposed', 'payment_failed'].includes(h.status)
  );
  const approvedHours = shiftHours.filter(h => ['approved', 'auto_approved'].includes(h.status));

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
  const pendingEarnings = approvedHours
    .reduce((s, h) => s + (h.grossPay ?? (getShiftHoursDisplay(h) * (h.payRate ?? 0))), 0);

  // Greeting (used in home-base mode)
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const firstName = getFirstName(profile.name);
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  // ── Sidebar — shared between both states ───────────────────────────────────

  const Sidebar = (
    <div className="space-y-4">
      {/* Quick Stats */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100">
          <h3 className="font-semibold text-slate-900 text-sm flex items-center gap-2">
            <Star className="w-4 h-4 text-primary-600" />
            Your Stats
          </h3>
        </div>
        <div className="p-4 space-y-3">
          {(profile.rating ?? (profile as any).averageRating) != null && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500 font-medium">Rating</span>
              <div className="flex items-center gap-1">
                <Star className="w-3.5 h-3.5 text-yellow-400 fill-yellow-400" />
                <span className="text-sm font-bold text-slate-800">
                  {Number(profile.rating ?? (profile as any).averageRating).toFixed(1)}
                </span>
                {(profile.reviewCount ?? 0) > 0 && (
                  <span className="text-xs text-slate-400">({profile.reviewCount})</span>
                )}
              </div>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500 font-medium">Active families</span>
            <span className="text-sm font-bold text-slate-800">{acceptedBookings.length}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500 font-medium">Rate</span>
            <span className="text-sm font-bold text-slate-800">${profile.hourlyRate ?? '—'}/hr</span>
          </div>
          <button
            onClick={() => navigate('/caregiver/profile')}
            className="w-full text-xs text-primary-600 font-medium hover:underline text-center pt-1"
          >
            Edit profile →
          </button>
        </div>
      </div>

      {/* My Applications */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <h3 className="font-semibold text-slate-900 text-sm flex items-center gap-2">
            <Briefcase className="w-4 h-4 text-primary-600" />
            My Applications
          </h3>
          <button onClick={() => navigate('/caregiver/jobs')} className="text-xs text-primary-600 font-medium hover:underline">View all</button>
        </div>
        <div className="p-3">
          {myApplications.length === 0 ? (
            <div className="text-center py-3">
              <p className="text-xs text-slate-400 leading-snug">No applications yet</p>
              <button onClick={() => navigate('/caregiver/jobs')} className="mt-2 text-xs text-primary-600 font-medium hover:underline">Browse Jobs →</button>
            </div>
          ) : (
            <div className="space-y-2">
              {myApplications.slice(0, 3).map((a: any) => {
                const statusCfg: Record<string, { label: string; color: string }> = {
                  pending:  { label: 'Pending',  color: 'text-amber-700' },
                  accepted: { label: 'Accepted', color: 'text-green-700' },
                  rejected: { label: 'Declined', color: 'text-red-600' },
                };
                const cfg = statusCfg[a.status] ?? { label: a.status, color: 'text-slate-500' };
                return (
                  <div key={a.id} className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-slate-700 truncate flex-1">{a.jobTitle || 'Care Job'}</p>
                    <span className={`text-[10px] font-bold flex-shrink-0 ${cfg.color}`}>{cfg.label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Support */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-primary-600 to-primary-500 px-4 py-3">
          <h3 className="font-bold text-white text-sm flex items-center gap-2">
            <Heart className="w-4 h-4" />
            Need Help?
          </h3>
        </div>
        <div className="p-4">
          <p className="text-xs text-slate-500 mb-3">Our support team is here for you.</p>
          <div className="mb-3">
            <a href="mailto:support@careconnex.com" className="flex items-center gap-2 text-xs text-slate-600 hover:text-primary-600">
              <Mail className="w-3.5 h-3.5 text-slate-400" />support@careconnex.com
            </a>
          </div>
          <button
            onClick={() => navigate('/caregiver/inbox')}
            className="w-full flex items-center justify-center gap-1.5 py-2 bg-primary-600 hover:bg-primary-700 text-white text-xs font-semibold rounded-lg transition-colors"
          >
            <MessageSquare className="w-3.5 h-3.5" />Chat with Us
          </button>
        </div>
      </div>
    </div>
  );

  if (!hasActiveFamilies) {
    return (
      <CaregiverOnboardingDashboard
        profile={profile}
        onNavigate={onNavigate}
        onShowToast={onShowToast}
      />
    );
  }

  // ── HOME BASE state — has active families ──────────────────────────────────

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-24">

      {/* Greeting */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Good {timeOfDay}, {firstName}!</h1>
        <p className="text-sm text-slate-500 mt-0.5">{today}</p>
      </div>

      {/* Row 1 — Care Requests | Today's Schedule | My Families */}
      <div className="grid lg:grid-cols-3 gap-4 mb-4">

        {/* Care Requests */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <Briefcase className="w-4 h-4 text-primary-500" />
            <h2 className="font-semibold text-slate-900">Care Requests</h2>
          </div>

          {/* Tab toggle */}
          <div className="flex bg-slate-100 rounded-lg p-0.5 mb-4">
            <button
              onClick={() => setCareRequestsTab('applications')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${careRequestsTab === 'applications' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
            >
              <FileText className="w-3.5 h-3.5" /> My Applications
            </button>
            <button
              onClick={() => setCareRequestsTab('interviews')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${careRequestsTab === 'interviews' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
            >
              <Users className="w-3.5 h-3.5" /> Interviews
            </button>
          </div>

          {/* My Applications tab */}
          {careRequestsTab === 'applications' && (() => {
            if (myApplications.length === 0) return (
              <div className="text-center py-5">
                <p className="text-sm text-slate-400 mb-2">No applications yet</p>
                <button onClick={() => navigate('/caregiver/jobs')} className="text-xs text-primary-600 font-medium hover:underline">Browse Jobs →</button>
              </div>
            );
            return (
              <>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-slate-700">Applications</p>
                  <button onClick={() => navigate('/caregiver/jobs?tab=applications')} className="text-xs text-primary-600 font-medium hover:underline flex items-center gap-0.5">View all &rsaquo;</button>
                </div>
                <div className="space-y-3 max-h-64 overflow-y-auto">
                  {myApplications.slice(0, 4).map((a: any) => {
                    const statusCfg: Record<string, { label: string; color: string }> = {
                      pending:  { label: 'Pending',  color: 'text-amber-600' },
                      accepted: { label: 'Accepted', color: 'text-green-600' },
                      rejected: { label: 'Declined', color: 'text-red-500' },
                    };
                    const cfg = statusCfg[a.status] ?? { label: a.status, color: 'text-slate-500' };
                    const appliedDate = a.appliedAt ? new Date(a.appliedAt?.toDate?.() ?? a.appliedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
                    return (
                      <div key={a.id} className="border-b border-slate-100 pb-3 last:border-0 last:pb-0">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <p className="text-sm font-semibold text-slate-900 leading-snug flex-1">{a.jobTitle || 'Care Job'}</p>
                          <div className="text-right flex-shrink-0">
                            {a.rate != null && <p className="text-xs font-bold text-green-700 bg-green-50 px-1.5 py-0.5 rounded">${a.rate}/hr</p>}
                            <p className={`text-xs font-semibold mt-0.5 ${cfg.color}`}>{cfg.label}</p>
                          </div>
                        </div>
                        {(a.location || a.clientName) && (
                          <div className="flex items-center gap-1 text-xs text-slate-500 mb-1">
                            <MapPin className="w-3 h-3 flex-shrink-0" />
                            <span className="truncate">{[a.location, a.clientName].filter(Boolean).join(' · ')}</span>
                          </div>
                        )}
                        {a.interviewStatus && (
                          <p className="text-xs text-slate-400 italic">{a.interviewStatus}</p>
                        )}
                        {appliedDate && <p className="text-[10px] text-slate-400 mt-1">Applied {appliedDate}</p>}
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()}

          {/* Interviews tab */}
          {careRequestsTab === 'interviews' && (() => {
            if (myInterviews.length === 0) return (
              <div className="text-center py-5">
                <p className="text-sm text-slate-400 mb-2">No interviews scheduled</p>
                <button onClick={() => navigate('/caregiver/jobs?tab=interviews')} className="text-xs text-primary-600 font-medium hover:underline">View Job Board →</button>
              </div>
            );
            return (
              <>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-slate-700">Interviews</p>
                  <button onClick={() => navigate('/caregiver/jobs?tab=interviews')} className="text-xs text-primary-600 font-medium hover:underline flex items-center gap-0.5">View all &rsaquo;</button>
                </div>
                <div className="space-y-3 max-h-64 overflow-y-auto">
                  {myInterviews.slice(0, 4).map((iv: any) => {
                    const scheduled = iv.scheduledTime ? new Date(iv.scheduledTime?.toDate?.() ?? iv.scheduledTime) : null;
                    const dateStr = scheduled ? scheduled.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
                    const timeStr = scheduled ? scheduled.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
                    const statusCfg: Record<string, { label: string; color: string }> = {
                      accepted:   { label: 'Accepted',  color: 'text-green-600' },
                      scheduled:  { label: 'Scheduled', color: 'text-primary-600' },
                      completed:  { label: 'Completed', color: 'text-slate-500' },
                      declined:   { label: 'Declined',  color: 'text-red-500' },
                      cancelled:  { label: 'Cancelled', color: 'text-red-500' },
                      pending:    { label: 'Pending',   color: 'text-amber-600' },
                    };
                    const cfg = statusCfg[iv.status] ?? { label: iv.status, color: 'text-slate-500' };
                    const ivType = iv.interviewType || iv.type || '';
                    return (
                      <div key={iv.id} className="border-b border-slate-100 pb-3 last:border-0 last:pb-0">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <p className="text-sm font-semibold text-slate-900 leading-snug flex-1">{iv.jobTitle || 'Interview'}</p>
                          <p className={`text-xs font-semibold flex-shrink-0 ${cfg.color}`}>{cfg.label}</p>
                        </div>
                        {iv.clientName && (
                          <div className="flex items-center gap-1 text-xs text-slate-500 mb-1">
                            <MapPin className="w-3 h-3 flex-shrink-0" />
                            <span className="truncate">{iv.clientName}</span>
                          </div>
                        )}
                        {(dateStr || timeStr) && (
                          <div className="flex items-center gap-1 text-xs text-slate-500">
                            <Clock className="w-3 h-3 flex-shrink-0" />
                            <span>{dateStr}{timeStr ? ` · ${timeStr}` : ''}</span>
                          </div>
                        )}
                        {ivType && <p className="text-[10px] text-slate-400 mt-0.5 capitalize">{ivType}</p>}
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()}
        </div>

        {/* Today's Schedule */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-primary-500" />
              <h2 className="font-semibold text-slate-900">Today's Schedule</h2>
            </div>
            <button onClick={() => navigate('/caregiver/calendar')} className="text-xs text-primary-600 font-medium hover:underline">Calendar</button>
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
                {tab === 'active' && activeShifts.length > 0 && (
                  <span className="ml-0.5 bg-green-100 text-green-700 text-[10px] font-bold px-1.5 rounded-full">{activeShifts.length}</span>
                )}
              </button>
            ))}
          </div>
          {(() => {
            const list = scheduleTab === 'active' ? activeShifts : upcomingTodayShifts;
            if (list.length === 0) return (
              <div className="text-center py-5">
                <CalendarDays className="w-8 h-8 text-slate-200 mx-auto mb-2" />
                <p className="text-sm text-slate-400">
                  {scheduleTab === 'active' ? 'No active shifts right now' : 'No more shifts today'}
                </p>
              </div>
            );
            return (
              <div className="space-y-3">
                {list.slice(0, 3).map((s: any) => (
                  <div key={s.id} className={`rounded-xl p-3 border ${s.status === 'in-progress' ? 'border-green-300 bg-green-50' : 'border-slate-200'}`}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
                        {s.clientPhotoURL
                          ? <img src={s.clientPhotoURL} alt={s.clientName} className="w-full h-full object-cover" />
                          : <span className="text-sm font-bold text-primary-600">{(s.clientName || 'F')[0].toUpperCase()}</span>
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-slate-900 text-sm truncate">{s.clientName || 'Family'}</p>
                        <p className={`text-xs font-medium ${s.status === 'in-progress' ? 'text-green-600' : 'text-slate-500'}`}>
                          {s.status === 'in-progress' ? 'In Progress' : 'Upcoming'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                      <Clock className="w-3 h-3 flex-shrink-0" />
                      <span className="font-medium">{fmtTime(s.startTime)} – {fmtTime(s.endTime)}</span>
                    </div>
                    {s.address && (
                      <div className="flex items-center gap-1.5 text-xs text-slate-400 mt-1">
                        <MapPin className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{s.address}</span>
                      </div>
                    )}
                  </div>
                ))}
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
          <div className="space-y-3 max-h-64 overflow-y-auto">
            {acceptedBookings.slice(0, 4).map((b: any) => (
              <div key={b.id} className="flex items-center gap-3 p-2 rounded-xl hover:bg-slate-50 transition-colors">
                <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
                  {b.clientPhotoURL
                    ? <img src={b.clientPhotoURL} alt={b.clientName} className="w-full h-full object-cover" />
                    : <span className="text-sm font-bold text-primary-600">{(b.clientName || 'F')[0].toUpperCase()}</span>
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-900 truncate">{b.clientName || 'Family'}</p>
                  {b.jobTitle && <p className="text-xs text-slate-500 truncate">{b.jobTitle}</p>}
                </div>
                <button
                  onClick={() => navigate('/caregiver/inbox')}
                  className="p-1.5 rounded-lg hover:bg-primary-50 text-slate-400 hover:text-primary-600 transition-colors flex-shrink-0"
                >
                  <MessageSquare className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* Row 2 — Bookings | Timesheets | Earnings */}
      <div className="grid lg:grid-cols-3 gap-4 mb-4">

        {/* Bookings */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-primary-500" />
              <h2 className="font-semibold text-slate-900">Bookings</h2>
            </div>
          </div>
          <div className="flex bg-slate-100 rounded-lg p-0.5 mb-4">
            <button
              onClick={() => setBookingTab('pending')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${bookingTab === 'pending' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
            >
              <Clock className="w-3.5 h-3.5" /> Pending
            </button>
            <button
              onClick={() => setBookingTab('upcoming')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${bookingTab === 'upcoming' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
            >
              <CalendarDays className="w-3.5 h-3.5" /> Upcoming
            </button>
          </div>
          {bookingTab === 'pending' && (() => {
            const totalPending = pendingBookings.length + pendingAmendments.length;
            if (totalPending === 0) return (
              <div className="text-center py-5">
                <p className="text-sm text-slate-400 mb-2">No pending requests</p>
                <button onClick={() => navigate('/caregiver/jobs')} className="text-xs text-primary-600 font-medium hover:underline">Browse Job Board →</button>
              </div>
            );
            return (
              <>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-slate-700">Pending</p>
                  <button onClick={() => navigate('/caregiver/bookings?tab=requests')} className="text-xs text-primary-600 font-medium hover:underline flex items-center gap-0.5">View all</button>
                </div>
                <div className="space-y-3 max-h-72 overflow-y-auto">
                  {pendingBookings.slice(0, 2).map((b: any) => {
                    const dst = b.schedule?.dayShiftTimes;
                    const schedLine = dst ? Object.entries(dst).slice(0, 2).map(([day, slots]: [string, any]) => { const slot = slots?.[0]; return slot ? `${day} ${fmtTime(slot.start)}–${fmtTime(slot.end)}` : day; }).join(' · ') : null;
                    return (
                      <div key={b.id} className="border border-slate-200 rounded-xl p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                            {b.clientPhotoURL ? <img src={b.clientPhotoURL} alt={b.clientName} className="w-full h-full object-cover" /> : <span className="text-xs font-bold text-primary-600">{(b.clientName || 'F')[0].toUpperCase()}</span>}
                          </div>
                          <p className="text-sm font-semibold text-slate-900 truncate flex-1">{b.clientName || 'Family'}</p>
                          <span className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full shrink-0">Awaiting response</span>
                        </div>
                        <div className="space-y-1 mb-1">
                          {b.jobTitle && <p className="text-xs text-slate-500 truncate">{b.jobTitle}</p>}
                          {schedLine && <div className="flex items-center gap-1.5 text-xs text-slate-500"><Calendar className="w-3 h-3 flex-shrink-0" /><span className="truncate">{schedLine}</span></div>}
                          {b.address && <div className="flex items-center gap-1.5 text-xs text-slate-500"><MapPin className="w-3 h-3 flex-shrink-0" /><span className="truncate">{b.address}</span></div>}
                        </div>
                        {b.rate != null && <p className="text-sm font-bold text-primary-600">${b.rate}/hr · {b.paymentMethod === 'credit' ? 'Card' : 'Cash'}</p>}
                      </div>
                    );
                  })}
                  {pendingAmendments.slice(0, 2).map((a: any) => {
                    const schedLine = a.newDays ? Object.entries(a.newDays as Record<string, Array<{ start: string; end: string }>>).slice(0, 2).map(([day, slots]) => { const slot = slots?.[0]; return slot ? `${day} ${fmtTime(slot.start)}–${fmtTime(slot.end)}` : day; }).join(' · ') : null;
                    return (
                      <div key={a.id} className="border border-slate-200 rounded-xl p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                            <span className="text-xs font-bold text-primary-600">{(a.clientName || 'F')[0].toUpperCase()}</span>
                          </div>
                          <p className="text-sm font-semibold text-slate-900 truncate flex-1">{a.clientName || 'Family'}</p>
                          <span className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full shrink-0">Awaiting response</span>
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs text-slate-500">Schedule change request</p>
                          {schedLine && <div className="flex items-center gap-1.5 text-xs text-slate-500"><Calendar className="w-3 h-3 flex-shrink-0" /><span className="truncate">{schedLine}{a.ongoing ? ' · Ongoing' : ''}</span></div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()}
          {bookingTab === 'upcoming' && (() => {
            const tomorrowStr = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })();
            const upcoming = upcomingShifts.filter((s: any) => s.date >= tomorrowStr);
            if (upcoming.length === 0) return (
              <div className="text-center py-5">
                <p className="text-sm text-slate-400 mb-2">No upcoming shifts</p>
                <button onClick={() => navigate('/caregiver/bookings')} className="text-xs text-primary-600 font-medium hover:underline">View bookings →</button>
              </div>
            );
            return (
              <>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-slate-700">Upcoming Shifts</p>
                  <button onClick={() => navigate('/caregiver/bookings?tab=active')} className="text-xs text-primary-600 font-medium hover:underline">View all</button>
                </div>
                <div className="space-y-3 max-h-72 overflow-y-auto">
                  {upcoming.slice(0, 2).map((shift: any) => {
                    const parts = (shift.date || '').split('-');
                    const d = parts.length === 3 ? new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) : null;
                    return (
                      <div key={shift.id} className="border border-slate-200 rounded-xl p-3 flex items-start gap-3">
                        <div className="text-center w-10 flex-shrink-0 pt-0.5">
                          <p className="text-xl font-bold text-slate-900 leading-none">{d ? d.getDate() : '–'}</p>
                          <p className="text-xs font-semibold text-slate-400 uppercase mt-0.5">{d ? d.toLocaleDateString('en-US', { month: 'short' }) : ''}</p>
                          <p className="text-xs text-slate-400">{d ? d.toLocaleDateString('en-US', { weekday: 'short' }) : ''}</p>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                              {shift.clientPhotoURL ? <img src={shift.clientPhotoURL} alt={shift.clientName} className="w-full h-full object-cover" /> : <span className="text-xs font-bold text-primary-600">{(shift.clientName || 'F')[0].toUpperCase()}</span>}
                            </div>
                            <p className="text-sm font-semibold text-slate-900 truncate flex-1">{shift.clientName || 'Family'}</p>
                          </div>
                          {(shift.startTime || shift.endTime) && <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-0.5"><Clock className="w-3 h-3 flex-shrink-0" /><span>{fmtTime(shift.startTime)}{shift.endTime ? ` – ${fmtTime(shift.endTime)}` : ''}</span></div>}
                          {shift.address && <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-0.5"><MapPin className="w-3 h-3 flex-shrink-0" /><span className="truncate">{shift.address}</span></div>}
                          {shift.rate != null && <p className="text-xs font-semibold text-primary-600 mt-1">${shift.rate}/hr · {shift.paymentMethod === 'credit' ? 'Card' : 'Cash'}</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()}
        </div>

        {/* Timesheets */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary-500" />
              <h2 className="font-semibold text-slate-900">Timesheets</h2>
            </div>
            <button onClick={() => navigate('/caregiver/payments')} className="text-xs text-primary-600 font-medium hover:underline">View all</button>
          </div>
          {pendingReviewHours.length === 0 && approvedHours.length === 0 ? (
            <div className="flex items-center gap-3 p-3 bg-green-50 rounded-xl">
              <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center flex-shrink-0">
                <CheckCircle className="w-4 h-4 text-green-600" />
              </div>
              <p className="text-sm text-slate-600">All timesheets up to date</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {[...pendingReviewHours, ...approvedHours].slice(0, 4).map((h: any) => {
                const hrs = getShiftHoursDisplay(h);
                const pay = h.grossPay ?? (hrs * (h.payRate ?? 0));
                const STATUS_MAP: Record<string, { label: string; color: string; bg: string }> = {
                  pending_client_review:      { label: 'Pending Review', color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' },
                  caregiver_counter_proposed: { label: 'Counter Sent',   color: 'text-yellow-700', bg: 'bg-yellow-50 border-yellow-200' },
                  payment_failed:             { label: 'Payment Failed', color: 'text-red-700',    bg: 'bg-red-50 border-red-200' },
                  approved:                   { label: 'Approved',       color: 'text-green-700',  bg: 'bg-green-50 border-green-200' },
                  auto_approved:              { label: 'Auto-Approved',  color: 'text-green-700',  bg: 'bg-green-50 border-green-200' },
                };
                const cfg = STATUS_MAP[h.status] ?? { label: h.status, color: 'text-slate-600', bg: 'bg-slate-100 border-slate-200' };
                const submittedDate = h.submittedAt
                  ? new Date(h.submittedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                  : '';
                return (
                  <div key={h.id} className="border border-slate-200 rounded-xl p-3">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs font-semibold text-slate-800 truncate flex-1">{h.clientName || 'Client'}</p>
                      <span className="text-xs text-slate-400 flex-shrink-0 ml-2">{submittedDate}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs mt-1 flex-wrap">
                      <span className="font-semibold text-slate-700">{hrs > 0 ? `${hrs.toFixed(1)}h` : '—'}</span>
                      <span className="text-slate-300">·</span>
                      <span className="font-bold text-primary-600">${pay.toFixed(2)}</span>
                      <span className={`ml-auto px-2 py-0.5 rounded-full text-[10px] font-semibold border ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Earnings */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-primary-500" />
              <h2 className="font-semibold text-slate-900">Earnings</h2>
            </div>
            <button onClick={() => navigate('/caregiver/payments')} className="text-xs text-primary-600 font-medium hover:underline">Details</button>
          </div>
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
              <div className="bg-amber-50 rounded-xl p-3">
                <p className="text-xs font-semibold text-amber-600 mb-0.5">Pending</p>
                <p className="text-lg font-bold text-amber-900">${pendingEarnings.toFixed(2)}</p>
              </div>
            </div>
            {profile.hourlyRate && (
              <div className="flex items-center gap-2 text-xs text-slate-500 pt-1">
                <TrendingUp className="w-3.5 h-3.5 text-slate-400" />
                <span>Your rate: <span className="font-semibold text-slate-700">${profile.hourlyRate}/hr</span></span>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Row 3 — Job Board Preview + Sidebar */}
      <div className="grid lg:grid-cols-3 gap-4">

        <div className="lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-slate-900">Job Board</h2>
            <button onClick={() => navigate('/caregiver/jobs')} className="text-sm text-primary-600 hover:text-primary-700 font-bold">
              See all posts →
            </button>
          </div>
          {openJobs.length === 0 ? (
            <div className="bg-slate-50 border border-slate-200 rounded-[2rem] p-8 text-center">
              <Briefcase className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="text-slate-500 text-sm">No new jobs right now. Check back soon.</p>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-4">
              {openJobs.map((job: any) => (
                <div key={job.id} className="bg-white border border-slate-100 rounded-[1.5rem] p-5 hover:border-primary-300 hover:shadow-lg shadow-sm transition-all duration-300">
                  <div className="flex items-start gap-3 mb-3">
                    <div className="w-10 h-10 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-base flex-shrink-0">
                      {(job.clientName || 'F').charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-slate-900 text-sm truncate">{job.title || 'Senior Care'}</p>
                      <p className="text-xs text-primary-600 font-bold">
                        {job.date ? fmtDate(job.date) : 'Flexible start'}
                      </p>
                    </div>
                  </div>
                  <p className="text-sm text-slate-600 line-clamp-2 mb-3 leading-relaxed">{job.description}</p>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                      <MapPin className="w-4 h-4 text-slate-400" />
                      {job.location || job.zipCode || 'Location TBD'}
                    </div>
                    <button
                      onClick={() => navigate('/caregiver/jobs')}
                      className="text-sm font-bold text-primary-600 hover:text-primary-700 bg-primary-50 px-3 py-1.5 rounded-full"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>{Sidebar}</div>

      </div>
    </div>
  );
};
