import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Loader2, Calendar, Phone, Heart, FileText, Clock, Home, CheckCircle, DollarSign, Hourglass, AlertTriangle, Bell, Briefcase, Users, MapPin, ChevronRight, Star, MessageSquare, Video } from 'lucide-react';
import { ScheduleInterviewModal } from '../ScheduleInterviewModal';
import { ViewType, Caregiver, ClientIntakeData, Senior } from '../../types';
import { dbService, authService } from '../../services/api';
import { useCareConnex } from '../../context/CareConnexContext';
import { useAccessGates } from '../../hooks/useAccessGates';
import { ClientNavigation } from './ClientNavigation';
import { CaregiverMatchCard } from './CaregiverMatchCard';
import { DashboardSidebar } from './DashboardSidebar';
import { WhatsNext } from './WhatsNext';
import { shiftHoursService } from '../../services/api';
import { ReviewShiftHoursModal } from '../payroll/ReviewShiftHoursModal';
import { SupportChatModal } from '../shared/SupportChatModal';
import firebase, { db } from '../../lib/firebase';
import { ClientJobPostingWizard } from './ClientJobPostingWizard';
import { LiveCareFeed } from './LiveCareFeed';
import { FamilyEmergency } from './FamilyEmergency';
import { useNearbyCaregiversWithScores } from '../../hooks/useNearbyCaregiversWithScores';


interface ClientDashboardProps {
  onNavigate: (view: ViewType, data?: any) => void;
}

// Best-effort geocode of a free-text location (city/zip) so proximity-based
// matching can actually fire for families who only completed intake (which
// stores city/state/zip but no lat/lng). Cached in-memory per session to avoid
// repeat Nominatim calls. Returns null on any failure — matching still works
// on the remaining signals (skills, schedule, rating) without it.
const _geoCache = new Map<string, { lat: number; lng: number } | null>();
async function geocodeLocation(query: string): Promise<{ lat: number; lng: number } | null> {
  const q = query.trim();
  if (!q) return null;
  if (_geoCache.has(q)) return _geoCache.get(q)!;
  try {
    // Bound the call so a slow/unreachable geocoder can't stall dashboard load.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=us`,
      { headers: { 'Accept-Language': 'en', 'User-Agent': 'CareConnex/1.0' }, signal: controller.signal }
    ).finally(() => clearTimeout(timer));
    const arr = await res.json();
    if (Array.isArray(arr) && arr[0]?.lat && arr[0]?.lon) {
      const v = { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) };
      _geoCache.set(q, v);
      return v;
    }
  } catch {
    // network/parse failure — fall through to null
  }
  _geoCache.set(q, null);
  return null;
}

// Assemble a Senior profile to drive matching. Prefers a saved senior_profiles
// doc (which may carry lat/lng, gender preference, personality) and enriches it
// with intake data (care types → needs, weekly schedule → days needed). Geocodes
// the location best-effort when no coordinates exist so proximity scoring works.
async function buildSeniorProfile(
  uid: string,
  intake: ClientIntakeData | null
): Promise<Senior | null> {
  let saved: Senior | null = null;
  try {
    saved = await dbService.getSeniorProfile(uid);
  } catch {
    // non-fatal — fall back to intake-only profile
  }
  if (!saved && !intake) return null;

  const needs = (saved?.needs?.length ? saved.needs : intake?.careTypes) || [];
  const scheduleNeeded = saved?.scheduleNeeded?.length
    ? saved.scheduleNeeded
    : Object.entries(intake?.weeklySchedule || {})
        .filter(([, slots]) => Array.isArray(slots) && slots.length > 0)
        .map(([day]) => day);
  const location =
    saved?.location || [intake?.city, intake?.state].filter(Boolean).join(', ');

  let latitude = saved?.latitude;
  let longitude = saved?.longitude;
  if (latitude == null || longitude == null) {
    const geoQuery =
      [intake?.streetAddress, intake?.city, intake?.state, intake?.zipCode]
        .filter(Boolean)
        .join(', ') || location;
    const geo = await geocodeLocation(geoQuery);
    if (geo) {
      latitude = geo.lat;
      longitude = geo.lng;
    }
  }

  return {
    id: 0,
    uid,
    name: saved?.name || intake?.recipientName || 'Care recipient',
    age: saved?.age || 0,
    needs,
    personality: saved?.personality || 'Ambivert',
    location,
    zipCode: intake?.zipCode || saved?.zipCode,
    latitude,
    longitude,
    scheduleNeeded,
    genderPreference: saved?.genderPreference,
  };
}

export const ClientDashboard: React.FC<ClientDashboardProps> = ({ onNavigate }) => {
  const navigate = useNavigate();
  const { appointments, addToast: onShowToast } = useCareConnex();
  
  // Modal states
  const [scheduleInterviewCaregiver, setScheduleInterviewCaregiver] = useState<Caregiver | null>(null);
  
  // Loading states
  const [isLoading, setIsLoading] = useState(true);

  // Intake data state
  const [intakeData, setIntakeData] = useState<ClientIntakeData | null>(null);
  const [showIntakeSummary, setShowIntakeSummary] = useState(false);

  // Saved caregivers
  const [savedCaregivers, setSavedCaregivers] = useState<Caregiver[]>([]);
  const [savedIds, setSavedIds] = useState<string[]>([]);

  // Top-rated caregivers (second row)
  const [topRatedCaregivers, setTopRatedCaregivers] = useState<Caregiver[]>([]);

  // Mark Paid state
  const [paidIds, setPaidIds] = useState<Set<string>>(new Set());
  const [markPaidTarget, setMarkPaidTarget] = useState<{ id: string; caregiverName: string; cost?: number } | null>(null);

  // Shift hours awaiting this client's review
  const [shiftsToReview, setShiftsToReview] = useState<any[]>([]);
  const [reviewingShift, setReviewingShift] = useState<any | null>(null);

  const [showSupportModal, setShowSupportModal] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [bookedCaregiverIds, setBookedCaregiverIds] = useState<Set<string>>(new Set());
  const [requestedCaregiverIds, setRequestedCaregiverIds] = useState<Set<string>>(new Set());
  const [clientOpenPosts, setClientOpenPosts] = useState<{ id: string; title: string }[]>([]);
  const [activeShifts, setActiveShifts] = useState<any[]>([]);
  const [activeCareTeam, setActiveCareTeam] = useState<any[]>([]);
  const [pendingInterviews, setPendingInterviews] = useState<any[]>([]);
  const [completedInterviews, setCompletedInterviews] = useState<any[]>([]);
  const [pendingBookingRequests, setPendingBookingRequests] = useState<any[]>([]);
  const [declinedBookings, setDeclinedBookings] = useState<any[]>([]);
  const [allBookingRequests, setAllBookingRequests] = useState<any[]>([]);
  const [clientAllPosts, setClientAllPosts] = useState<any[]>([]);
  const [allInterviews, setAllInterviews] = useState<any[]>([]);
  const [careRequestTab, setCareRequestTab] = useState<'posts' | 'interviews'>('posts');
  const [ivFilter, setIvFilter] = useState<'pending' | 'accepted' | 'completed'>('pending');

  const currentUser = authService.getCurrentUser();
  const { gate, Modals: GateModals } = useAccessGates();
  const hasActiveBooking = activeCareTeam.length > 0;

  // Nearby caregivers — uses same logic as Browse Caregivers (distance-filtered, AI-scored)
  const { caregivers: matchedCaregivers, loading: caregiversLoading } = useNearbyCaregiversWithScores(
    currentUser?.uid ?? null,
    { maxDistance: 25, limit: 4 }
  );

  // Home base data: care team, active shifts, pending interviews
  useEffect(() => {
    if (!currentUser?.uid || !db) return;
    const unsubs: (() => void)[] = [];

    // Job posts — all statuses for Care Requests card; open-only meta for interview modal
    db.collection('job_posts')
      .where('clientId', '==', currentUser.uid)
      .get()
      .then(snap => {
        const posts = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
        setClientAllPosts(posts);
        setClientOpenPosts(posts.filter(p => p.status === 'open').map(p => ({ id: p.id, title: p.title || 'Untitled post' })));
      })
      .catch(() => {});

    // Active care team — real-time subscription
    const teamUnsub = db.collection('booking_requests')
      .where('clientId', '==', currentUser.uid)
      .where('status', '==', 'accepted')
      .onSnapshot(snap => {
        const docs = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
        setActiveCareTeam(docs);
        setBookedCaregiverIds(new Set(docs.map((d: any) => d.caregiverId).filter(Boolean)));
      }, () => {});
    unsubs.push(teamUnsub);

    // Active shifts (scheduled + in-progress) — real-time subscription, sorted in JS to avoid composite index
    const shiftsUnsub = db.collection('shifts')
      .where('clientId', '==', currentUser.uid)
      .where('status', 'in', ['scheduled', 'in-progress'])
      .onSnapshot(snap => {
        const docs = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
        docs.sort((a: any, b: any) => (a.date || '').localeCompare(b.date || ''));
        setActiveShifts(docs);
      }, () => {});
    unsubs.push(shiftsUnsub);

    // All booking requests — used for Action Required card and completed interview filtering
    db.collection('booking_requests')
      .where('clientId', '==', currentUser.uid)
      .get()
      .then(snap => {
        const all = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
        setAllBookingRequests(all);
        setPendingBookingRequests(all.filter((b: any) => b.status === 'pending'));
        setDeclinedBookings(all.filter((b: any) => b.status === 'declined'));
      })
      .catch(() => {});

    // Interviews — all statuses for Care Requests card + derived states
    db.collection('video_interviews')
      .where('clientId', '==', currentUser.uid)
      .get()
      .then(snap => {
        const all = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
        setAllInterviews(all);
        const activeStatuses = new Set(['requested', 'pending', 'scheduled']);
        const pending = all.filter((d: any) => activeStatuses.has(d.status));
        setPendingInterviews(pending);
        setCompletedInterviews(all.filter((d: any) => d.status === 'completed'));
        setRequestedCaregiverIds(new Set(pending.map((d: any) => d.caregiverId).filter(Boolean)));
      })
      .catch(() => {});

    return () => unsubs.forEach(u => { try { u(); } catch {} });
  }, [currentUser?.uid]);

  useEffect(() => {
    if (!currentUser?.uid) return;
    const unsub = shiftHoursService.subscribeForClient(currentUser.uid, rows => {
      setShiftsToReview(rows.filter((r: any) => r.status === 'pending_client_review' || r.status === 'caregiver_counter_proposed'));
    });
    return () => { try { (unsub as any)?.(); } catch {} };
  }, [currentUser?.uid]);

  // Show wizard for new signups (sessionStorage flag) or users who never completed it
  useEffect(() => {
    const fromSignup = sessionStorage.getItem('careconnex_show_wizard') === 'true';
    if (fromSignup) {
      sessionStorage.removeItem('careconnex_show_wizard');
      setShowWizard(true);
      return;
    }
    if (!currentUser?.uid) return;
    dbService.getUser(currentUser.uid)
      .then(userData => {
        if (!(userData as any)?.jobPostingCompleted) setShowWizard(true);
      })
      .catch(() => {});
  }, [currentUser?.uid]);

  // Load client progress, intake data, and matched caregivers
  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        // Fetch intake data from Firestore
        let intakeLocal: ClientIntakeData | null = null;
        if (currentUser?.uid && db) {
          try {
            const intakeDoc = await db.collection('clientIntakes').doc(currentUser.uid).get();
            if (intakeDoc.exists) {
              intakeLocal = intakeDoc.data() as ClientIntakeData;
              setIntakeData(intakeLocal);
            }
          } catch (intakeError) {
            console.warn('Could not load intake data:', intakeError);
          }
        }


        // Load saved caregivers from user profile
        try {
          if (db && currentUser?.uid) {
            const userDoc = await db.collection('users').doc(currentUser.uid).get();
            const savedIds: string[] = (userDoc.data() as any)?.savedCaregiverIds || [];
            if (savedIds.length > 0) {
              const snap = await db.collection('caregivers')
                .where(firebase.firestore.FieldPath.documentId(), 'in', savedIds.slice(0, 10))
                .get();
              setSavedCaregivers(snap.docs.map(d => ({ id: d.id, ...d.data() } as Caregiver)));
            }
          }
        } catch {
          // saved caregivers are non-critical — silently ignore errors
        }
      } catch (error) {
        console.error('Failed to load dashboard data:', error);
        onShowToast?.('Failed to load dashboard data', 'error');
      } finally {
        setIsLoading(false);
      }
    };
    
    if (currentUser?.uid) {
      loadData();
    } else {
      // Redirect to login if not authenticated
      navigate('/login');
    }
  }, [currentUser?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load top-rated caregivers for second row
  useEffect(() => {
    if (!db || !currentUser?.uid) return;
    let isMounted = true;
    db.collection('caregivers')
      .orderBy('rating', 'desc')
      .limit(8)
      .get()
      .then(snap => {
        if (!isMounted) return;
        setTopRatedCaregivers(snap.docs.map(d => ({ id: d.id, ...d.data() } as Caregiver)));
      })
      .catch(() => {});
    return () => { isMounted = false; };
  }, [currentUser?.uid]);

  // Load saved caregiver IDs for heart buttons
  useEffect(() => {
    if (!db || !currentUser?.uid) return;
    db.collection('users').doc(currentUser.uid).get()
      .then(doc => setSavedIds((doc.data() as any)?.savedCaregiverIds || []))
      .catch(() => {});
  }, [currentUser?.uid]);

  const handleToggleSave = async (caregiver: Caregiver) => {
    if (!currentUser?.uid || !db) return;
    const next = savedIds.includes(caregiver.id)
      ? savedIds.filter(id => id !== caregiver.id)
      : [...savedIds, caregiver.id];
    setSavedIds(next);
    db.collection('users').doc(currentUser.uid).update({ savedCaregiverIds: next }).catch(() => setSavedIds(savedIds));
  };

  const handleMarkPaid = async () => {
    if (!markPaidTarget || !db) return;
    const id = markPaidTarget.id;
    setPaidIds(prev => new Set([...prev, id]));
    setMarkPaidTarget(null);
    db.collection('appointments').doc(id).update({
      paymentStatus: 'paid',
      paidAt: new Date().toISOString(),
    }).catch(() => setPaidIds(prev => { const s = new Set(prev); s.delete(id); return s; }));
  };

  const scrollToMatches = () => {
    document
      .getElementById('caregiver-matches')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  
  // Format weekly schedule for display
  const formatSchedule = (weeklySchedule?: Record<string, Array<{start: string, end: string}>>) => {
    if (!weeklySchedule) return 'No schedule set';
    
    const days = Object.entries(weeklySchedule)
      .filter(([_, slots]) => slots.length > 0)
      .map(([day, slots]) => {
        const slotStr = slots.map(s => `${s.start} - ${s.end}`).join(', ');
        return `${day}: ${slotStr}`;
      });
    
    return days.length > 0 ? days.join('; ') : 'No schedule set';
  };
  
  // Format care types for display
  const formatCareTypes = (careTypes?: string[]) => {
    if (!careTypes || careTypes.length === 0) return 'None specified';
    return careTypes.join(', ');
  };

  const handleChatCoordinator = () => {
    setShowSupportModal(true);
  };

  const handleChatClick = async (caregiver: Caregiver) => {
    try {
      await dbService.createThread(
        caregiver.id.toString(),
        caregiver.name || 'Caregiver',
        caregiver.imageUrl || (caregiver as any).photo || ''
      );
      navigate('/client/inbox');
    } catch {
      onShowToast?.('Could not start chat', 'error');
    }
  };

  const handleGatedMessage = (caregiver: Caregiver) =>
    gate('message', caregiver.name, () => handleChatClick(caregiver));

  // Match score per caregiver. When the matching engine produced a personalized,
  // proximity-aware score, use it verbatim. Otherwise (generic fallback list) fall
  // back to an honest rating/experience heuristic — never an inflated default.

  if (isLoading || caregiversLoading) {
    return (
      <>
        <ClientNavigation />
        <div className="min-h-screen flex items-center justify-center bg-[var(--color-neutral-50)]">
          <Loader2 className="w-10 h-10 text-[var(--color-primary-600)] animate-spin" />
        </div>
      </>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <ClientNavigation />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-16">

        {/* What's Next hero — only for new clients without an active booking */}
        {!hasActiveBooking && currentUser?.uid && (
          <WhatsNext
            uid={currentUser.uid}
            displayName={currentUser.displayName || currentUser.email?.split('@')[0]}
            onNavigate={(p) => navigate(p)}
            onScrollToMatches={scrollToMatches}
          />
        )}

        {/* Live shift check-ins — shown when there is an active appointment today */}
        {currentUser?.uid && (() => {
          const todayIso = new Date().toISOString().slice(0, 10);
          const active = appointments.find(a =>
            a.isoDate === todayIso &&
            (a.status === 'confirmed' || a.status === 'in-progress')
          );
          if (!active) return null;
          return <LiveCareFeed clientId={currentUser.uid} />;
        })()}

        {reviewingShift && (
          <ReviewShiftHoursModal
            shift={reviewingShift}
            onClose={() => setReviewingShift(null)}
            onDone={() => { setReviewingShift(null); onShowToast?.('Done', 'success'); }}
            onError={msg => onShowToast?.(msg, 'error')}
          />
        )}

        {hasActiveBooking ? (
          /* ── HOME BASE ──────────────────────────────────────────────── */
          <div className="space-y-4">

            {/* Row 1: Action Required (2/3) + Reminders (1/3) */}
            <div className="grid lg:grid-cols-3 gap-4">

              {/* Action Required */}
              <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    <h2 className="font-semibold text-slate-900">Action Required</h2>
                  </div>
                  <button onClick={() => navigate('/client/bookings')} className="text-xs text-primary-600 font-medium hover:underline">View all</button>
                </div>
                {shiftsToReview.length === 0 && pendingBookingRequests.length === 0 && completedInterviews.length === 0 && declinedBookings.length === 0 ? (
                  <p className="text-sm text-slate-400 py-1">You're all caught up — nothing needs your attention right now.</p>
                ) : (
                  <div className="space-y-2">
                    {shiftsToReview.length > 0 && (
                      <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
                        <div className="w-8 h-8 bg-accent-100 rounded-lg flex items-center justify-center flex-shrink-0">
                          <FileText className="w-4 h-4 text-accent-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-slate-900">{shiftsToReview.length} shift{shiftsToReview.length > 1 ? 's' : ''} to review</p>
                          <p className="text-xs text-slate-500">Approve or request a correction</p>
                        </div>
                        <button onClick={() => setReviewingShift(shiftsToReview[0])} className="px-3 py-1.5 text-xs font-semibold bg-accent-500 text-white rounded-lg hover:bg-accent-600 flex-shrink-0 transition-colors">
                          Review Now
                        </button>
                      </div>
                    )}
                    {pendingBookingRequests.length > 0 && (
                      <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
                        <div className="w-8 h-8 bg-amber-100 rounded-lg flex items-center justify-center flex-shrink-0">
                          <Calendar className="w-4 h-4 text-amber-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-slate-900">{pendingBookingRequests.length} booking awaiting response</p>
                          <p className="text-xs text-slate-500">Caregiver has not responded yet</p>
                        </div>
                        <button onClick={() => navigate('/client/bookings')} className="px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-100 flex-shrink-0 transition-colors">
                          View Booking
                        </button>
                      </div>
                    )}
                    {completedInterviews.length > 0 && (
                      <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
                        <div className="w-8 h-8 bg-primary-100 rounded-lg flex items-center justify-center flex-shrink-0">
                          <Users className="w-4 h-4 text-primary-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-slate-900">{completedInterviews.length} interview{completedInterviews.length > 1 ? 's' : ''} completed</p>
                          <p className="text-xs text-slate-500">Review and decide to hire</p>
                        </div>
                        <button onClick={() => navigate('/client/posts')} className="px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-100 flex-shrink-0 transition-colors">
                          View
                        </button>
                      </div>
                    )}
                    {declinedBookings.length > 0 && (
                      <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
                        <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center flex-shrink-0">
                          <AlertTriangle className="w-4 h-4 text-red-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-slate-900">{declinedBookings.length} booking declined</p>
                          <p className="text-xs text-slate-500">Find another caregiver</p>
                        </div>
                        <button onClick={() => navigate('/client/find-caregivers')} className="px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-100 flex-shrink-0 transition-colors">
                          Find Caregivers
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Reminders */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Bell className="w-4 h-4 text-primary-500" />
                    <h2 className="font-semibold text-slate-900">Reminders</h2>
                  </div>
                  <button onClick={() => navigate('/client/calendar')} className="text-xs text-primary-600 font-medium hover:underline">View calendar</button>
                </div>
                {(() => {
                  const todayStr = new Date().toISOString().slice(0, 10);
                  const tmrDate = new Date(); tmrDate.setDate(tmrDate.getDate() + 1);
                  const tomorrowStr = tmrDate.toISOString().slice(0, 10);
                  const todayShifts = activeShifts.filter((s: any) => s.date === todayStr);
                  const tomorrowShifts = activeShifts.filter((s: any) => s.date === tomorrowStr);
                  const autoApprove = shiftsToReview.filter(s => s.autoApproveAt && (new Date(s.autoApproveAt).getTime() - Date.now()) < 86400000);
                  if (todayShifts.length === 0 && autoApprove.length === 0 && tomorrowShifts.length === 0) {
                    return <p className="text-sm text-slate-400">No reminders for the next 2 days.</p>;
                  }
                  return (
                    <div className="space-y-4">
                      {(todayShifts.length > 0 || autoApprove.length > 0) && (
                        <div>
                          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Today</p>
                          <div className="space-y-2.5">
                            {todayShifts.map((s: any) => (
                              <div key={s.id} className="flex items-start gap-2.5">
                                <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${s.status === 'in-progress' ? 'bg-green-100' : 'bg-primary-100'}`}>
                                  <div className={`w-2 h-2 rounded-full ${s.status === 'in-progress' ? 'bg-green-500' : 'bg-primary-500'}`} />
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm text-slate-800">{s.status === 'in-progress' ? 'Shift in progress' : 'Shift scheduled'} with {s.caregiverName}</p>
                                  <p className="text-xs text-slate-400">{s.startTime} – {s.endTime}</p>
                                </div>
                              </div>
                            ))}
                            {autoApprove.length > 0 && (
                              <div className="flex items-start gap-2.5">
                                <div className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                                  <div className="w-2 h-2 rounded-full bg-amber-500" />
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm text-slate-800">{autoApprove.length} shift{autoApprove.length > 1 ? 's' : ''} will auto-approve after 24 hours</p>
                                  <p className="text-xs text-slate-400">Review before auto-approval</p>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      {tomorrowShifts.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Tomorrow</p>
                          <div className="space-y-2.5">
                            {tomorrowShifts.map((s: any) => (
                              <div key={s.id} className="flex items-start gap-2.5">
                                <div className="w-5 h-5 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                                  <Calendar className="w-3 h-3 text-slate-500" />
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm text-slate-800">Booking scheduled with {s.caregiverName}</p>
                                  <p className="text-xs text-slate-400">{s.startTime} – {s.endTime}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Row 2: Care Request in Progress + Active Booking + Care Team */}
            <div className="grid lg:grid-cols-3 gap-4">

              {/* Care Requests */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Briefcase className="w-4 h-4 text-primary-500" />
                    <h2 className="font-semibold text-slate-900">Care Requests</h2>
                  </div>
                  <button onClick={() => navigate('/client/posts')} className="text-xs text-primary-600 font-medium hover:underline">View all</button>
                </div>

                {/* Posts / Interviews tab toggle */}
                <div className="flex bg-slate-100 rounded-lg p-0.5 mb-4">
                  <button
                    onClick={() => setCareRequestTab('posts')}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${careRequestTab === 'posts' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    <FileText className="w-3.5 h-3.5" /> Posts
                  </button>
                  <button
                    onClick={() => setCareRequestTab('interviews')}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${careRequestTab === 'interviews' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    <Users className="w-3.5 h-3.5" /> Interviews
                  </button>
                </div>

                {/* Posts tab */}
                {careRequestTab === 'posts' && (() => {
                  const openPosts = clientAllPosts.filter(p => p.status === 'open');
                  return (
                    <>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-semibold text-slate-700">Posts</p>
                        <button onClick={() => navigate('/client/posts')} className="text-xs text-primary-600 font-medium hover:underline flex items-center gap-0.5">
                          View all <ChevronRight className="w-3 h-3" />
                        </button>
                      </div>
                      {openPosts.length === 0 ? (
                        <div className="text-center py-5">
                          <p className="text-sm text-slate-400 mb-2">No open posts</p>
                          <button onClick={() => navigate('/client/posts')} className="text-xs text-primary-600 font-medium hover:underline">Post a care request →</button>
                        </div>
                      ) : (
                        <div className="space-y-3 max-h-72 overflow-y-auto">
                          {[...openPosts].sort((a, b) => (b.createdAt || '') > (a.createdAt || '') ? 1 : -1).slice(0, 2).map((post: any) => {
                            const careTypes: string[] = post.careTypes || [];
                            const days: string[] = post.days || post.schedule?.days || [];
                            const timeBlocks: string[] = post.timeBlocks || post.schedule?.timeBlocks || [];
                            const schedTags = [...days.slice(0, 3), ...timeBlocks.slice(0, 2)];
                            const extraCare = careTypes.length > 3 ? careTypes.length - 3 : 0;
                            return (
                              <div key={post.id} className="border border-slate-200 rounded-xl p-3">
                                <div className="flex items-center gap-2 mb-2 min-w-0">
                                  <span className="text-xs font-semibold text-primary-700 bg-primary-50 border border-primary-100 px-2 py-0.5 rounded-full flex-shrink-0">{post.scheduleType || post.type || 'Part-time'}</span>
                                  <span className="text-xs text-slate-400 truncate">{post.hiredCount ?? 0} of {post.caregiversNeeded ?? 1} hired</span>
                                </div>
                                <p className="text-sm font-semibold text-slate-900 mb-2">{post.title}</p>
                                <div className="space-y-1 mb-2">
                                  {post.startDate && (
                                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                                      <Calendar className="w-3 h-3 flex-shrink-0" />
                                      <span>{post.startDate}</span>
                                    </div>
                                  )}
                                  {(post.city || post.location) && (
                                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                                      <MapPin className="w-3 h-3 flex-shrink-0" />
                                      <span className="truncate">{[post.city, post.state, post.zipCode].filter(Boolean).join(', ') || post.location}</span>
                                    </div>
                                  )}
                                </div>
                                {post.rateFlexible ? (
                                  <p className="text-sm font-semibold text-slate-500 mb-2">Rate flexible</p>
                                ) : post.rate ? (
                                  <p className="text-sm font-bold text-primary-600 mb-2">${post.rate}/hr</p>
                                ) : null}
                                {schedTags.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mb-2">
                                    {schedTags.map((tag: string, i: number) => (
                                      <span key={i} className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{tag}</span>
                                    ))}
                                  </div>
                                )}
                                {careTypes.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mb-2">
                                    {careTypes.slice(0, 3).map((ct: string, i: number) => (
                                      <span key={i} className="text-xs bg-primary-50 text-primary-600 px-2 py-0.5 rounded-full">{ct}</span>
                                    ))}
                                    {extraCare > 0 && <span className="text-xs text-slate-400 self-center">+{extraCare} more</span>}
                                  </div>
                                )}
                                <div className="flex items-center gap-3 pt-2 border-t border-slate-100">
                                  <span className="flex items-center gap-1 text-xs text-slate-500"><User className="w-3 h-3" />{post.seniorCount ?? 1} senior</span>
                                  <span className="flex items-center gap-1 text-xs text-slate-500"><Users className="w-3 h-3" />{post.applicantCount ?? 0} applicant{(post.applicantCount ?? 0) !== 1 ? 's' : ''}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  );
                })()}

                {/* Interviews tab */}
                {careRequestTab === 'interviews' && (() => {
                  const iPending = allInterviews.filter(iv => ['requested', 'pending'].includes(iv.status));
                  const iAccepted = allInterviews.filter(iv => iv.status === 'accepted');
                  const bookingMap: Record<string, any> = {};
                  allBookingRequests.forEach((b: any) => {
                    const key = `${b.caregiverId}_${b.jobId || b.interviewId || ''}`;
                    bookingMap[key] = b;
                  });
                  const iCompleted = allInterviews.filter(iv => {
                    if (iv.status !== 'completed') return false;
                    const key = `${iv.caregiverId}_${iv.jobId || iv.id}`;
                    const booking = bookingMap[key];
                    // Show only actionable: no booking sent, or booking declined/cancelled
                    return !booking || booking.status === 'declined' || booking.status === 'cancelled';
                  });
                  const sortedPending = [...iPending].sort((a, b) => (b.createdAt || '') > (a.createdAt || '') ? 1 : -1);
                  const sortedAccepted = [...iAccepted].sort((a, b) => (a.scheduledTime || '') > (b.scheduledTime || '') ? 1 : -1);
                  const sortedCompleted = [...iCompleted].sort((a, b) => (b.completedAt || b.scheduledTime || '') > (a.completedAt || a.scheduledTime || '') ? 1 : -1);
                  const displayList = (ivFilter === 'pending' ? sortedPending : ivFilter === 'accepted' ? sortedAccepted : sortedCompleted).slice(0, 2);

                  return (
                    <>
                      <div className="grid grid-cols-3 gap-2 mb-4">
                        <button onClick={() => setIvFilter('pending')} className={`border rounded-xl p-2.5 text-center transition-all ${ivFilter === 'pending' ? 'border-amber-400 bg-amber-50 ring-1 ring-amber-300' : 'border-amber-200 bg-amber-50 opacity-70 hover:opacity-100'}`}>
                          <p className="text-2xl font-bold text-amber-600">{iPending.length}</p>
                          <p className="text-xs font-semibold text-amber-600 mt-0.5">Pending</p>
                        </button>
                        <button onClick={() => setIvFilter('accepted')} className={`border rounded-xl p-2.5 text-center transition-all ${ivFilter === 'accepted' ? 'border-green-400 bg-green-50 ring-1 ring-green-300' : 'border-green-200 bg-green-50 opacity-70 hover:opacity-100'}`}>
                          <p className="text-2xl font-bold text-green-600">{iAccepted.length}</p>
                          <p className="text-xs font-semibold text-green-600 mt-0.5">Accepted</p>
                        </button>
                        <button onClick={() => setIvFilter('completed')} className={`border rounded-xl p-2.5 text-center transition-all ${ivFilter === 'completed' ? 'border-slate-400 bg-slate-100 ring-1 ring-slate-300' : 'border-slate-200 bg-slate-50 opacity-70 hover:opacity-100'}`}>
                          <p className="text-2xl font-bold text-slate-500">{iCompleted.length}</p>
                          <p className="text-xs font-semibold text-slate-500 mt-0.5">Completed</p>
                        </button>
                      </div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-semibold text-slate-700 capitalize">{ivFilter}</p>
                        <button onClick={() => navigate(`/client/posts?tab=interviews&filter=${ivFilter}`)} className="text-xs text-primary-600 font-medium hover:underline flex items-center gap-0.5">
                          View all <ChevronRight className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="space-y-1.5">
                        {displayList.length === 0 ? (
                          <p className="text-sm text-slate-400 text-center py-4">No interviews yet</p>
                        ) : displayList.map((iv: any) => {
                          const ivDt = iv.scheduledTime ? new Date(iv.scheduledTime) : (iv.date && iv.time ? new Date(`${iv.date}T${iv.time}`) : null);
                          const isVideo = iv.interviewType === 'video';
                          return (
                            <div key={iv.id} className="p-2.5 bg-slate-50 rounded-lg">
                              <div className="flex items-center gap-2.5">
                                <div className="w-8 h-8 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                                  {iv.caregiverPhotoURL ? (
                                    <img src={iv.caregiverPhotoURL} alt={iv.caregiverName} className="w-full h-full object-cover" />
                                  ) : (
                                    <span className="text-xs font-bold text-primary-600">{(iv.caregiverName || 'C')[0].toUpperCase()}</span>
                                  )}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="mb-0.5">
                                    <p className="text-sm font-medium text-slate-800 truncate">{iv.caregiverName}</p>
                                  </div>
                                  {iv.jobTitle && (
                                    <p className="text-xs text-slate-400 truncate mb-0.5">{iv.jobTitle}</p>
                                  )}
                                  <div className="flex items-center gap-2 flex-wrap">
                                    {ivDt && (
                                      <span className="flex items-center gap-1 text-xs text-slate-400">
                                        <Calendar className="w-3 h-3" />
                                        {ivDt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                                        {' · '}
                                        {ivDt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                                      </span>
                                    )}
                                    {iv.interviewType && (
                                      <span className="flex items-center gap-1 text-xs text-slate-400">
                                        {isVideo ? <Video className="w-3 h-3" /> : <Phone className="w-3 h-3" />}
                                        {isVideo ? 'Video' : 'Phone'}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* Active Booking */}
              {activeCareTeam.slice(0, 1).map((booking: any) => {
                const activeShift = activeShifts.find((s: any) => s.caregiverId === booking.caregiverId && s.status === 'in-progress')
                  || activeShifts.find((s: any) => s.caregiverId === booking.caregiverId);
                const inProgress = activeShift?.status === 'in-progress';
                return (
                  <div key={booking.id} className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="font-semibold text-slate-900">Active Booking</h2>
                      <button onClick={() => navigate('/client/bookings')} className="text-xs text-primary-600 font-medium hover:underline">View details</button>
                    </div>
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-10 h-10 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                        {booking.caregiverPhotoURL ? (
                          <img src={booking.caregiverPhotoURL} alt={booking.caregiverName} className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-sm font-bold text-primary-600">{(booking.caregiverName || 'C')[0].toUpperCase()}</span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-slate-900 text-sm">{booking.caregiverName}</p>
                        <p className="text-xs text-slate-500">
                          {activeShift ? `${inProgress ? 'Today' : activeShift.date} · ${activeShift.startTime} – ${activeShift.endTime}` : `$${booking.rate}/hr`}
                        </p>
                      </div>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${inProgress ? 'text-green-700 bg-green-100' : 'text-primary-700 bg-primary-100'}`}>
                        {inProgress ? 'In Progress' : 'Scheduled'}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => booking.caregiverId && handleChatClick({ id: booking.caregiverId, name: booking.caregiverName } as any)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <MessageSquare className="w-3.5 h-3.5" />
                        Message
                      </button>
                      <button
                        onClick={() => navigate('/client/bookings')}
                        className="flex-1 flex items-center justify-center py-2 text-xs font-medium border border-primary-200 rounded-lg text-primary-700 hover:bg-primary-50 transition-colors"
                      >
                        Booking Details
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Care Team */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-primary-500" />
                    <h2 className="font-semibold text-slate-900">Care Team</h2>
                  </div>
                  <button onClick={() => navigate('/client/care-team')} className="text-xs text-primary-600 font-medium hover:underline">View all</button>
                </div>
                <div className="space-y-2 mb-3">
                  {activeCareTeam.slice(0, 2).map((booking: any) => {
                    const onShift = activeShifts.some((s: any) => s.caregiverId === booking.caregiverId && s.status === 'in-progress');
                    return (
                      <div key={booking.id} className="flex items-center gap-3 p-2.5 bg-slate-50 rounded-lg">
                        <div className="w-9 h-9 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                          {booking.caregiverPhotoURL ? (
                            <img src={booking.caregiverPhotoURL} alt={booking.caregiverName} className="w-full h-full object-cover" />
                          ) : (
                            <span className="text-sm font-bold text-primary-600">{(booking.caregiverName || 'C')[0].toUpperCase()}</span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-slate-900 truncate">{booking.caregiverName}</p>
                          <p className="text-xs text-slate-500">{booking.caregiverRole || 'Caregiver'}</p>
                        </div>
                        {onShift && (
                          <span className="text-xs font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded-full flex-shrink-0">On Shift</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button
                  onClick={() => activeCareTeam[0]?.caregiverId && handleChatClick({ id: activeCareTeam[0].caregiverId, name: activeCareTeam[0].caregiverName } as any)}
                  className="w-full py-2 text-xs font-medium border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  Message Caregiver
                </button>
              </div>
            </div>

            {/* Row 3: Upcoming Bookings + Timesheets & Payments + Caregivers Near You */}
            <div className="grid lg:grid-cols-3 gap-4">

              {/* Upcoming Bookings */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-primary-500" />
                    <h2 className="font-semibold text-slate-900">Upcoming Bookings</h2>
                  </div>
                  <button onClick={() => navigate('/client/bookings')} className="text-xs text-primary-600 font-medium hover:underline">View schedule</button>
                </div>
                <div className="space-y-3">
                  {(() => {
                    const todayStr = new Date().toISOString().slice(0, 10);
                    const upcoming = activeShifts.filter((s: any) => s.date >= todayStr);
                    if (upcoming.length === 0) return <p className="text-sm text-slate-400 py-2">No upcoming shifts scheduled.</p>;
                    return upcoming.slice(0, 3).map((shift: any) => {
                      const parts = (shift.date || '').split('-');
                      const d = parts.length === 3 ? new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) : null;
                      return (
                        <div key={shift.id} className="flex items-center gap-3">
                          <div className="text-center w-9 flex-shrink-0">
                            <p className="text-xl font-bold text-slate-900 leading-none">{d ? d.getDate() : '–'}</p>
                            <p className="text-xs text-slate-400 uppercase">{d ? d.toLocaleDateString('en-US', { month: 'short' }) : ''}</p>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-slate-800 truncate">{shift.caregiverName}</p>
                            <p className="text-xs text-slate-400">{shift.startTime} – {shift.endTime}</p>
                          </div>
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${shift.status === 'in-progress' ? 'text-green-700 bg-green-100' : 'text-primary-700 bg-primary-50 border border-primary-100'}`}>
                            {shift.status === 'in-progress' ? 'In Progress' : 'Scheduled'}
                          </span>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>

              {/* Timesheets & Payments */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-primary-500" />
                    <h2 className="font-semibold text-slate-900">Timesheets & Payments</h2>
                  </div>
                  <button onClick={() => navigate('/client/payments')} className="text-xs text-primary-600 font-medium hover:underline">View all</button>
                </div>
                <div className="space-y-2">
                  {shiftsToReview.length > 0 ? (
                    <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
                      <div className="w-8 h-8 bg-accent-100 rounded-lg flex items-center justify-center flex-shrink-0">
                        <Clock className="w-4 h-4 text-accent-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-slate-900">{shiftsToReview.length} shift{shiftsToReview.length > 1 ? 's' : ''} to review</p>
                        <p className="text-xs text-slate-500">Review and approve timesheets</p>
                      </div>
                      <button onClick={() => setReviewingShift(shiftsToReview[0])} className="px-2.5 py-1.5 text-xs font-semibold bg-accent-500 text-white rounded-lg hover:bg-accent-600 flex-shrink-0 transition-colors">
                        Review Now
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 p-3 bg-green-50 rounded-lg">
                      <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center flex-shrink-0">
                        <CheckCircle className="w-4 h-4 text-green-600" />
                      </div>
                      <p className="text-sm text-slate-600">All timesheets reviewed</p>
                    </div>
                  )}
                  <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
                    <div className="w-8 h-8 bg-primary-100 rounded-lg flex items-center justify-center flex-shrink-0">
                      <DollarSign className="w-4 h-4 text-primary-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-900">View payment history</p>
                      <p className="text-xs text-slate-500">All payments and invoices</p>
                    </div>
                    <button onClick={() => navigate('/client/payments')} className="px-2.5 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-100 flex-shrink-0 transition-colors">
                      Go to Payments
                    </button>
                  </div>
                </div>
              </div>

              {/* Caregivers Near You */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-primary-500" />
                    <h2 className="font-semibold text-slate-900">Caregivers Near You</h2>
                  </div>
                  <button onClick={() => navigate('/client/find-caregivers')} className="text-xs text-primary-600 font-medium hover:underline">Find more</button>
                </div>
                <div className="space-y-2">
                  {matchedCaregivers.filter(c => !bookedCaregiverIds.has(c.id)).slice(0, 2).map(cg => (
                    <div
                      key={cg.id}
                      className="flex items-center gap-3 p-2.5 bg-slate-50 rounded-lg cursor-pointer hover:bg-slate-100 transition-colors"
                      onClick={() => navigate(`/client/caregiver/${cg.id}`)}
                    >
                      <div className="w-9 h-9 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                        {(cg.imageUrl || (cg as any).photo) ? (
                          <img src={cg.imageUrl || (cg as any).photo} alt={cg.name} className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-sm font-bold text-primary-600">{(cg.name || 'C')[0].toUpperCase()}</span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-slate-900 truncate">{cg.name}</p>
                        <div className="flex items-center gap-1">
                          <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
                          <span className="text-xs text-slate-500">{cg.rating ? cg.rating.toFixed(1) : '5.0'}</span>
                          {(cg as any).distanceMiles != null && (
                            <span className="text-xs text-slate-400 ml-1">· {(cg as any).distanceMiles.toFixed(1)} mi</span>
                          )}
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0" />
                    </div>
                  ))}
                  {matchedCaregivers.filter(c => !bookedCaregiverIds.has(c.id)).length === 0 && (
                    <div className="text-center py-4">
                      <p className="text-sm text-slate-400">No caregivers found nearby</p>
                      <button onClick={() => navigate('/client/find-caregivers')} className="mt-1 text-xs text-primary-600 font-medium hover:underline">Browse all →</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ── DISCOVERY ──────────────────────────────────────────────── */
          <>
            {shiftsToReview.length > 0 && (
              <div className="mb-6 bg-accent-50 border border-accent-200 rounded-xl p-4">
                <h2 className="text-sm font-semibold text-accent-900 mb-3">
                  {shiftsToReview.length} shift{shiftsToReview.length !== 1 ? 's' : ''} to review
                </h2>
                <div className="space-y-2">
                  {shiftsToReview.map(shift => {
                    const msLeft = shift.autoApproveAt ? new Date(shift.autoApproveAt).getTime() - Date.now() : 0;
                    const hoursLeft = Math.max(0, Math.round(msLeft / 3600000));
                    return (
                      <div key={shift.id} className="bg-white rounded-lg p-3 flex items-center justify-between">
                        <div>
                          <p className="font-medium text-slate-900">{shift.caregiverName}</p>
                          <p className="text-sm text-slate-500">{shift.submittedTotalHours}h · auto-approves in {hoursLeft}h</p>
                        </div>
                        <button onClick={() => setReviewingShift(shift)} className="px-3 py-1.5 rounded-lg bg-accent-500 text-white text-sm font-medium hover:bg-accent-600">
                          Review
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="mb-6">
              <h1 className="text-2xl font-bold text-slate-900">Nearby Caregivers</h1>
            </div>

            <div className="grid lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 space-y-6">

                {(() => {
                  const discoveryCaregivers = matchedCaregivers.filter(c => !bookedCaregiverIds.has(c.id));
                  return discoveryCaregivers.length > 0 ? (
                    <div id="caregiver-matches" className="grid sm:grid-cols-2 gap-4">
                      {discoveryCaregivers.map((caregiver) => (
                        <CaregiverMatchCard
                          key={caregiver.id}
                          caregiver={caregiver}
                          matchScore={0}
                          matchReasons={[]}
                          onBook={(cg) => setScheduleInterviewCaregiver(cg)}
                          onViewProfile={(cg) => navigate(`/client/caregiver/${cg.id}`)}
                          onMessage={handleGatedMessage}
                          isSaved={savedIds.includes(caregiver.id)}
                          onToggleSave={handleToggleSave}
                          isRequested={requestedCaregiverIds.has(caregiver.id)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="grid sm:grid-cols-2 gap-4">
                      {[1, 2, 3, 4].map(i => (
                        <div key={i} className="bg-white rounded-xl border border-slate-200 overflow-hidden animate-pulse">
                          <div className="h-44 bg-slate-100" />
                          <div className="p-4 space-y-3">
                            <div className="h-4 bg-slate-100 rounded w-2/3" />
                            <div className="h-3 bg-slate-100 rounded w-1/2" />
                            <div className="h-8 bg-slate-100 rounded" />
                          </div>
                        </div>
                      ))}
                      <div className="sm:col-span-2 text-center py-4">
                        <p className="text-sm text-slate-500">Caregivers are being matched to your area — check back shortly.</p>
                        <button onClick={() => navigate('/client/find-caregivers')} className="mt-2 text-primary-600 text-sm font-medium hover:underline">Browse all caregivers →</button>
                      </div>
                    </div>
                  );
                })()}

                {matchedCaregivers.length > 0 && (
                  <div className="text-center pt-1 pb-2">
                    <button onClick={() => navigate('/client/find-caregivers')} className="inline-flex items-center gap-1.5 text-sm text-primary-600 font-medium hover:text-primary-700 hover:underline transition-colors">
                      See more results →
                    </button>
                  </div>
                )}

                {topRatedCaregivers.length > 0 && appointments.filter(a => a.status === 'confirmed').length === 0 && (() => {
                  const deduped = topRatedCaregivers.filter(c => !matchedCaregivers.find(m => m.id === c.id)).slice(0, 4);
                  if (!deduped.length) return null;
                  return (
                    <section>
                      <div className="flex items-center justify-between mb-3">
                        <h2 className="text-lg font-bold text-slate-900">Top Rated Near You</h2>
                        <button onClick={() => navigate('/client/find-caregivers')} className="text-sm text-primary-600 font-medium hover:underline">See more →</button>
                      </div>
                      <div className="grid sm:grid-cols-2 gap-4">
                        {deduped.map(caregiver => (
                          <CaregiverMatchCard
                            key={caregiver.id}
                            caregiver={caregiver}
                            matchScore={0}
                            matchReasons={[]}
                            onBook={(cg) => setScheduleInterviewCaregiver(cg)}
                            onViewProfile={(cg) => navigate(`/client/caregiver/${cg.id}`)}
                            isSaved={savedIds.includes(caregiver.id)}
                            onToggleSave={handleToggleSave}
                            isRequested={requestedCaregiverIds.has(caregiver.id)}
                          />
                        ))}
                      </div>
                    </section>
                  );
                })()}

                {appointments.filter(a => a.status === 'pending_caregiver_confirmation').length > 0 && (
                  <section>
                    <h2 className="text-lg font-bold text-slate-900 mb-3">Pending Requests</h2>
                    <div className="space-y-2">
                      {appointments.filter(a => a.status === 'pending_caregiver_confirmation').slice(0, 3).map(appt => (
                        <div key={appt.id} className="bg-amber-50 rounded-xl border border-amber-200 p-4 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center flex-shrink-0">
                              <Hourglass className="w-5 h-5 text-amber-600" />
                            </div>
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-900 text-sm truncate">{appt.caregiverName}</p>
                              <p className="text-xs text-slate-500">{appt.date} at {appt.time}</p>
                            </div>
                          </div>
                          <span className="text-xs font-semibold text-amber-700 bg-amber-100 border border-amber-200 px-2 py-1 rounded-lg flex-shrink-0">Awaiting response</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {appointments.filter(a => a.status === 'confirmed').length > 0 && (
                  <section>
                    <h2 className="text-lg font-bold text-slate-900 mb-3">Upcoming Visits</h2>
                    <div className="space-y-2">
                      {appointments.filter(a => a.status === 'confirmed').slice(0, 3).map(appt => {
                        const isPaid = paidIds.has(appt.id) || appt.paymentStatus === 'paid';
                        return (
                          <div key={appt.id} className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3 flex-1 min-w-0">
                              <div className="w-10 h-10 bg-primary-100 rounded-xl flex items-center justify-center flex-shrink-0">
                                <Calendar className="w-5 h-5 text-primary-600" />
                              </div>
                              <div className="min-w-0">
                                <p className="font-semibold text-slate-900 text-sm truncate">{appt.caregiverName}</p>
                                <p className="text-xs text-slate-500">{appt.date} at {appt.time}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {isPaid ? (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700 bg-green-50 border border-green-200 px-2 py-1 rounded-lg">
                                  <CheckCircle className="w-3 h-3" /> Paid
                                </span>
                              ) : (
                                <button
                                  onClick={() => setMarkPaidTarget({ id: appt.id, caregiverName: appt.caregiverName, cost: appt.cost })}
                                  className="inline-flex items-center gap-1 text-xs font-semibold text-primary-700 bg-primary-50 border border-primary-200 hover:bg-primary-100 px-2 py-1 rounded-lg transition-colors"
                                >
                                  <DollarSign className="w-3 h-3" /> Mark Paid
                                </button>
                              )}
                              <button onClick={() => navigate('/client/calendar')} className="text-xs text-slate-400 hover:text-primary-600 font-medium transition-colors">View</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                <section>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-lg font-bold text-slate-900">Senior Care Resources</h2>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {[
                      { tag: 'Dementia Care', title: '10 ways to make home safer for someone with Alzheimer\'s', readTime: '4 min read', bg: 'bg-blue-50', tagColor: 'text-blue-700 bg-blue-100' },
                      { tag: 'Nutrition', title: 'Meal planning tips for seniors with diabetes or COPD', readTime: '3 min read', bg: 'bg-accent-50', tagColor: 'text-accent-700 bg-accent-100' },
                      { tag: 'Fall Prevention', title: 'How to reduce fall risk in the bathroom and bedroom', readTime: '5 min read', bg: 'bg-primary-50', tagColor: 'text-primary-700 bg-primary-100' },
                      { tag: 'Caregiver Tips', title: 'What to ask during a caregiver interview (free checklist)', readTime: '6 min read', bg: 'bg-blue-50', tagColor: 'text-blue-700 bg-blue-100' },
                    ].map((article, i) => (
                      <div key={i} className={`${article.bg} rounded-xl p-4 border border-slate-100 cursor-pointer hover:shadow-sm transition-shadow`}>
                        <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full mb-2 ${article.tagColor}`}>{article.tag}</span>
                        <p className="text-sm font-semibold text-slate-800 leading-snug mb-2">{article.title}</p>
                        <p className="text-xs text-slate-400">{article.readTime}</p>
                      </div>
                    ))}
                  </div>
                </section>

              </div>

              <DashboardSidebar
                savedCaregivers={savedCaregivers}
                currentUserUid={currentUser?.uid}
                onChatCoordinator={handleChatCoordinator}
                onViewCaregiver={(cg) => navigate(`/client/caregiver/${cg.id}`)}
              />
            </div>
          </>
        )}
      </main>

      {/* Mark Paid confirmation modal */}
      {markPaidTarget && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <DollarSign className="w-6 h-6 text-green-600" />
            </div>
            <h3 className="text-lg font-bold text-slate-900 text-center mb-1">Confirm Payment</h3>
            <p className="text-sm text-slate-500 text-center mb-5">
              Did you pay <span className="font-semibold text-slate-700">{markPaidTarget.caregiverName}</span>
              {markPaidTarget.cost ? <span> <span className="font-semibold text-slate-700">${markPaidTarget.cost}</span></span> : ''} directly?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setMarkPaidTarget(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
              >
                Not yet
              </button>
              <button
                onClick={handleMarkPaid}
                className="flex-1 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-xl text-sm font-semibold transition-colors"
              >
                Yes, mark paid
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      <GateModals />

      {showSupportModal && (
        <SupportChatModal
          onClose={() => setShowSupportModal(false)}
          userName={currentUser?.displayName || currentUser?.email?.split('@')[0]}
        />
      )}


      {scheduleInterviewCaregiver && (
        <ScheduleInterviewModal
          caregiver={scheduleInterviewCaregiver}
          jobPosts={clientOpenPosts}
          onClose={() => setScheduleInterviewCaregiver(null)}
          onSuccess={(message) => {
            if (scheduleInterviewCaregiver) {
              setRequestedCaregiverIds(prev => new Set([...prev, scheduleInterviewCaregiver.id]));
            }
            onShowToast?.(message, 'success');
            setScheduleInterviewCaregiver(null);
          }}
          onShowToast={onShowToast}
        />
      )}

      {/* Intake Summary Modal */}
      {showIntakeSummary && intakeData && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto animate-slide-in">
            {/* Header */}
            <div className="bg-gradient-to-r from-[var(--color-primary-600)] to-[var(--color-primary-500)] px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                  <FileText className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">Intake Summary</h2>
                  <p className="text-sm text-white/80">Your care requirements</p>
                </div>
              </div>
              <button
                onClick={() => setShowIntakeSummary(false)}
                className="text-white/80 hover:text-white transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="p-6 space-y-6">
              {/* Care Recipient */}
              <div className="bg-[var(--color-primary-50)] rounded-xl p-5 border border-[var(--color-primary-200)]">
                <div className="flex items-center gap-2 mb-3">
                  <User className="w-5 h-5 text-[var(--color-primary-600)]" />
                  <h3 className="font-bold text-[var(--color-neutral-900)]">Care Recipient</h3>
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-[var(--color-neutral-500)]">Name</p>
                    <p className="font-semibold text-[var(--color-neutral-900)]">
                      {intakeData.recipientFirstName} {intakeData.recipientLastName}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-[var(--color-neutral-500)]">Relationship</p>
                    <p className="font-semibold text-[var(--color-neutral-900)]">{intakeData.relationship}</p>
                  </div>
                </div>
              </div>

              {/* Care Types */}
              <div className="bg-white rounded-xl p-5 border border-[var(--color-neutral-200)]">
                <div className="flex items-center gap-2 mb-3">
                  <Heart className="w-5 h-5 text-[var(--color-primary-600)]" />
                  <h3 className="font-bold text-[var(--color-neutral-900)]">Care Types Needed</h3>
                </div>
                <div className="flex flex-wrap gap-2">
                  {intakeData.careTypes?.map((type, idx) => (
                    <span
                      key={idx}
                      className="px-3 py-1.5 bg-[var(--color-primary-50)] text-[var(--color-primary-700)] text-sm font-medium rounded-lg"
                    >
                      {type}
                    </span>
                  ))}
                </div>
              </div>

              {/* Schedule */}
              <div className="bg-white rounded-xl p-5 border border-[var(--color-neutral-200)]">
                <div className="flex items-center gap-2 mb-3">
                  <Clock className="w-5 h-5 text-[var(--color-primary-600)]" />
                  <h3 className="font-bold text-[var(--color-neutral-900)]">Schedule</h3>
                </div>
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-[var(--color-neutral-500)]">Type:</span>
                    <span className="font-medium text-[var(--color-neutral-900)]">{intakeData.schedule}</span>
                  </div>
                  <div>
                    <p className="text-sm text-[var(--color-neutral-500)] mb-2">Weekly Schedule:</p>
                    <div className="bg-[var(--color-neutral-50)] rounded-lg p-3 text-sm text-[var(--color-neutral-700)]">
                      {formatSchedule(intakeData.weeklySchedule)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Location */}
              <div className="bg-white rounded-xl p-5 border border-[var(--color-neutral-200)]">
                <div className="flex items-center gap-2 mb-3">
                  <Home className="w-5 h-5 text-[var(--color-primary-600)]" />
                  <h3 className="font-bold text-[var(--color-neutral-900)]">Care Location</h3>
                </div>
                <p className="text-[var(--color-neutral-700)]">
                  {intakeData.streetAddress}<br />
                  {intakeData.city}, {intakeData.state} {intakeData.zipCode}
                </p>
              </div>

              {/* Start Date & Duration */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="bg-white rounded-xl p-5 border border-[var(--color-neutral-200)]">
                  <div className="flex items-center gap-2 mb-3">
                    <Calendar className="w-5 h-5 text-[var(--color-primary-600)]" />
                    <h3 className="font-bold text-[var(--color-neutral-900)]">Start Date</h3>
                  </div>
                  <p className="text-[var(--color-neutral-700)]">{intakeData.startDate}</p>
                </div>
                <div className="bg-white rounded-xl p-5 border border-[var(--color-neutral-200)]">
                  <div className="flex items-center gap-2 mb-3">
                    <Clock className="w-5 h-5 text-[var(--color-primary-600)]" />
                    <h3 className="font-bold text-[var(--color-neutral-900)]">Duration</h3>
                  </div>
                  <p className="text-[var(--color-neutral-700)]">{intakeData.duration}</p>
                </div>
              </div>

              {/* Additional Comments */}
              {intakeData.additionalComments && (
                <div className="bg-[var(--color-neutral-50)] rounded-xl p-5 border border-[var(--color-neutral-200)]">
                  <h3 className="font-bold text-[var(--color-neutral-900)] mb-2">Additional Comments</h3>
                  <p className="text-sm text-[var(--color-neutral-600)]">{intakeData.additionalComments}</p>
                </div>
              )}

              {/* Contact Info */}
              <div className="bg-white rounded-xl p-5 border border-[var(--color-neutral-200)]">
                <div className="flex items-center gap-2 mb-3">
                  <Phone className="w-5 h-5 text-[var(--color-primary-600)]" />
                  <h3 className="font-bold text-[var(--color-neutral-900)]">Contact Information</h3>
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-[var(--color-neutral-700)]">
                    <span className="text-[var(--color-neutral-500)]">Name:</span> {intakeData.contactName}
                  </p>
                  <p className="text-sm text-[var(--color-neutral-700)]">
                    <span className="text-[var(--color-neutral-500)]">Phone:</span> {intakeData.phone}
                  </p>
                  <p className="text-sm text-[var(--color-neutral-700)]">
                    <span className="text-[var(--color-neutral-500)]">Email:</span> {intakeData.email}
                  </p>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 bg-[var(--color-neutral-50)] border-t border-[var(--color-neutral-200)] flex justify-between items-center">
              <p className="text-sm text-[var(--color-neutral-500)]">
                Submitted on {intakeData.createdAt ? new Date(intakeData.createdAt.toDate?.() || intakeData.createdAt).toLocaleDateString() : 'N/A'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Job Posting Wizard — fires once after signup */}
      {showWizard && currentUser?.uid && (
        <ClientJobPostingWizard
          uid={currentUser.uid}
          onComplete={() => setShowWizard(false)}
        />
      )}

      {/* Family emergency button — visible only when a shift is active today */}
      {currentUser?.uid && (() => {
        const todayIso = new Date().toISOString().slice(0, 10);
        const active = appointments.find(a =>
          a.isoDate === todayIso &&
          (a.status === 'confirmed' || a.status === 'in-progress')
        );
        if (!active) return null;
        return <FamilyEmergency appointmentId={active.id} />;
      })()}
    </div>
  );
};
