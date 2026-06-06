import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { User, Loader2, Calendar, Phone, Heart, FileText, Edit, Clock, Home, Search, CheckCircle, DollarSign, Hourglass } from 'lucide-react';
import { Button } from '../ui/Button';
import { BookingModal } from '../BookingModal';
import { ScheduleInterviewModal } from '../ScheduleInterviewModal';
import { ViewType, Appointment, Caregiver, ClientIntakeData, Senior } from '../../types';
import { dbService, authService } from '../../services/api';
import { useCareConnex } from '../../context/CareConnexContext';
import { useAccessGates } from '../../hooks/useAccessGates';
import { ClientNavigation } from './ClientNavigation';
import { CaregiverMatchCard } from './CaregiverMatchCard';
import { DashboardSidebar } from './DashboardSidebar';
import { WhatsNext } from './WhatsNext';
import { shiftHoursService } from '../../services/api';
import { ReviewShiftHoursModal } from '../payroll/ReviewShiftHoursModal';
import { calculateMLMatchScore } from '../../services/mlMatchScoring';
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
  const [searchParams] = useSearchParams();
  const { appointments, caregivers, bookAppointment: onBook, addToast: onShowToast } = useCareConnex();
  
  // Modal states
  const [selectedCaregiver, setSelectedCaregiver] = useState<Caregiver | null>(null);
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

  const currentUser = authService.getCurrentUser();
  const { gate, Modals: GateModals } = useAccessGates();

  // Nearby caregivers — uses same logic as Browse Caregivers (distance-filtered, AI-scored)
  const { caregivers: matchedCaregivers, loading: caregiversLoading, clientLocations } = useNearbyCaregiversWithScores(
    currentUser?.uid ?? null,
    { maxDistance: 25, limit: 4 }
  );

  useEffect(() => {
    if (!currentUser?.uid) return;
    const unsub = shiftHoursService.subscribeForClient(currentUser.uid, rows => {
      setShiftsToReview(rows.filter((r: any) => r.status === 'pending_client_review'));
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

  // Handle booking confirmation
  const handleBookingConfirm = async (appt: Appointment) => {
    try {
      await onBook(appt);
      onShowToast?.('Appointment booked successfully!', 'success');
      setSelectedCaregiver(null);
    } catch (error) {
      onShowToast?.('Failed to book appointment', 'error');
    }
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

  const handleGatedBook = (caregiver: Caregiver) =>
    gate('booking', caregiver.name, () => setSelectedCaregiver(caregiver));

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

        {/* What's Next hero — data-driven, replaces greeting + stepper */}
        {currentUser?.uid && (
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

        {/* Shift hours to review */}
        {shiftsToReview.length > 0 && (
          <div className="mb-6 bg-accent-50 border border-accent-200 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-accent-900 mb-3">
              {shiftsToReview.length} shift{shiftsToReview.length !== 1 ? 's' : ''} to review
            </h2>
            <div className="space-y-2">
              {shiftsToReview.map(shift => {
                const msLeft = new Date(shift.autoApproveAt).getTime() - Date.now();
                const hoursLeft = Math.max(0, Math.round(msLeft / 3600000));
                return (
                  <div key={shift.id} className="bg-white rounded-lg p-3 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-slate-900">{shift.caregiverName}</p>
                      <p className="text-sm text-slate-500">
                        {shift.submittedTotalHours}h · auto-approves in {hoursLeft}h
                      </p>
                    </div>
                    <button
                      onClick={() => setReviewingShift(shift)}
                      className="px-3 py-1.5 rounded-lg bg-accent-500 text-white text-sm font-medium hover:bg-accent-600"
                    >
                      Review
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {reviewingShift && (
          <ReviewShiftHoursModal
            shift={reviewingShift}
            onClose={() => setReviewingShift(null)}
            onDone={() => { setReviewingShift(null); onShowToast?.('Done', 'success'); }}
            onError={msg => onShowToast?.(msg, 'error')}
          />
        )}

        {/* Page header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Nearby Caregivers</h1>
        </div>

        {/* Two Column Layout */}
        <div className="grid lg:grid-cols-3 gap-6">

          {/* LEFT — Caregiver cards (always shown) */}
          <div className="lg:col-span-2 space-y-6">


            {matchedCaregivers.length > 0 ? (
              <div id="caregiver-matches" className="grid sm:grid-cols-2 gap-4">
                {matchedCaregivers.map((caregiver) => (
                  <CaregiverMatchCard
                    key={caregiver.id}
                    caregiver={caregiver}
                    matchScore={0}
                    matchReasons={[]}
                    onBook={handleGatedBook}
                    onViewProfile={(cg) => navigate(`/client/caregiver/${cg.id}`)}
                    onMessage={handleGatedMessage}
                    isSaved={savedIds.includes(caregiver.id)}
                    onToggleSave={handleToggleSave}
                  />
                ))}
              </div>
            ) : (
              /* Loading placeholders — never show "No matches yet" as a dead end */
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
            )}

            {/* See more results link */}
            {matchedCaregivers.length > 0 && (
              <div className="text-center pt-1 pb-2">
                <button
                  onClick={() => navigate('/client/find-caregivers')}
                  className="inline-flex items-center gap-1.5 text-sm text-primary-600 font-medium hover:text-primary-700 hover:underline transition-colors"
                >
                  See more results →
                </button>
              </div>
            )}

            {/* Top Rated second row — only when no upcoming confirmed visits */}
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
                        onBook={setSelectedCaregiver}
                        onViewProfile={(cg) => navigate(`/client/caregiver/${cg.id}`)}
                        isSaved={savedIds.includes(caregiver.id)}
                        onToggleSave={handleToggleSave}
                      />
                    ))}
                  </div>
                </section>
              );
            })()}

            {/* Pending booking requests */}
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
                      <span className="text-xs font-semibold text-amber-700 bg-amber-100 border border-amber-200 px-2 py-1 rounded-lg flex-shrink-0">
                        Awaiting response
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Upcoming visits */}
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

            {/* Articles & Resources */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-bold text-slate-900">Senior Care Resources</h2>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                {[
                  {
                    tag: 'Dementia Care',
                    title: '10 ways to make home safer for someone with Alzheimer\'s',
                    readTime: '4 min read',
                    bg: 'bg-blue-50',
                    tagColor: 'text-blue-700 bg-blue-100',
                  },
                  {
                    tag: 'Nutrition',
                    title: 'Meal planning tips for seniors with diabetes or COPD',
                    readTime: '3 min read',
                    bg: 'bg-accent-50',
                    tagColor: 'text-accent-700 bg-accent-100',
                  },
                  {
                    tag: 'Fall Prevention',
                    title: 'How to reduce fall risk in the bathroom and bedroom',
                    readTime: '5 min read',
                    bg: 'bg-primary-50',
                    tagColor: 'text-primary-700 bg-primary-100',
                  },
                  {
                    tag: 'Caregiver Tips',
                    title: 'What to ask during a caregiver interview (free checklist)',
                    readTime: '6 min read',
                    bg: 'bg-blue-50',
                    tagColor: 'text-blue-700 bg-blue-100',
                  },
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

          {/* RIGHT — Sidebar */}
          <DashboardSidebar
            savedCaregivers={savedCaregivers}
            currentUserUid={currentUser?.uid}
            onChatCoordinator={handleChatCoordinator}
            onNavigate={onNavigate}
            onViewCaregiver={(cg) => navigate(`/client/caregiver/${cg.id}`)}
          />
        </div>
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

      {selectedCaregiver && (
        <BookingModal
          caregiver={selectedCaregiver}
          onClose={() => setSelectedCaregiver(null)}
          onConfirm={handleBookingConfirm}
        />
      )}

      {scheduleInterviewCaregiver && (
        <ScheduleInterviewModal
          caregiver={scheduleInterviewCaregiver}
          onClose={() => setScheduleInterviewCaregiver(null)}
          onSuccess={(message) => {
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
