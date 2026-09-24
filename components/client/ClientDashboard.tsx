import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Loader2, Calendar, CalendarDays, Phone, Heart, FileText, Clock, Home, CheckCircle, DollarSign, Briefcase, Users, MapPin, ChevronRight, Star, MessageSquare, Video, CreditCard } from 'lucide-react';
import { ScheduleInterviewModal } from '../ScheduleInterviewModal';
import { ViewType, Caregiver, ClientIntakeData, Senior } from '../../types';
import { dbService, authService, normalizeJobPost } from '../../services/api';
import type { PendingSwap } from '../../services/shiftSwap';
import { PendingSwapsPanel } from '../shared/PendingSwapsPanel';
import { useCareConnex } from '../../context/CareConnexContext';
import { useAccessGates } from '../../hooks/useAccessGates';
import { ClientNavigation } from './ClientNavigation';
import { CaregiverMatchCard } from './CaregiverMatchCard';
import { DashboardSidebar } from './DashboardSidebar';
import { WhatsNext } from './WhatsNext';
import { shiftHoursService } from '../../services/api';
import { ReviewShiftHoursModal } from '../payroll/ReviewShiftHoursModal';
import { SupportChatModal } from '../shared/SupportChatModal';
import { CaregiverVerificationBadges } from '../shared/CaregiverVerificationBadges';
import firebase, { db } from '../../lib/firebase';
import { shiftDisplayStatus } from '../../utils/shiftUtils';
import { useNearbyCaregiversWithScores } from '../../hooks/useNearbyCaregiversWithScores';
import { VisitProgressPanel } from './VisitProgressPanel';
import { billedHourlyRate, totalChargedDollars } from '../../utils/pricing';


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
      { headers: { 'Accept-Language': 'en', 'User-Agent': 'Evia/1.0' }, signal: controller.signal }
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
  const { addToast: onShowToast, blockedIds } = useCareConnex();
  
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

  // Shift hours awaiting this client's review
  const [shiftsToReview, setShiftsToReview] = useState<any[]>([]);
  const [reviewingShift, setReviewingShift] = useState<any | null>(null);

  const [showSupportModal, setShowSupportModal] = useState(false);
  const [requestedCaregiverIds, setRequestedCaregiverIds] = useState<Set<string>>(new Set());
  const [clientOpenPosts, setClientOpenPosts] = useState<{ id: string; title: string; createdAt?: string }[]>([]);
  const [activeShifts, setActiveShifts] = useState<any[]>([]);
  // First-visit review prompt (2026-09-19): a caregiver with a completed shift,
  // no review from this family yet, and not dismissed → one card. Same facts the
  // profile page's Leave a Review button reads; Evia texts the same prompt once.
  const [completedShiftDocs, setCompletedShiftDocs] = useState<any[]>([]);
  const [myReviewCaregiverIds, setMyReviewCaregiverIds] = useState<Set<string>>(new Set());
  const [dismissedReviewPrompts, setDismissedReviewPrompts] = useState<string[]>([]);
  // Raw booking_requests docs with status:'accepted' — status stays 'accepted'
  // forever once accepted, so this alone does NOT mean the relationship is
  // still ongoing (see activeCareTeam below).
  const [acceptedBookingDocs, setAcceptedBookingDocs] = useState<any[]>([]);
  const [careTeamProfiles, setCareTeamProfiles] = useState<Record<string, { rating?: number; reviewCount?: number; verified?: boolean; backgroundCheckStatus?: string }>>({});
  const [pendingBookingRequests, setPendingBookingRequests] = useState<any[]>([]);
  const [pendingAmendments, setPendingAmendments] = useState<any[]>([]);
  const [pendingSwaps, setPendingSwaps] = useState<PendingSwap[]>([]);
  const [allBookingRequests, setAllBookingRequests] = useState<any[]>([]);
  const [clientAllPosts, setClientAllPosts] = useState<any[]>([]);
  const [allInterviews, setAllInterviews] = useState<any[]>([]);
  const [careRequestTab, setCareRequestTab] = useState<'posts' | 'interviews'>('posts');
  const [todayBookingTab, setTodayBookingTab] = useState<'active' | 'upcoming'>('upcoming');
  const [ivFilter, setIvFilter] = useState<'pending' | 'accepted' | 'completed'>('pending');
  const [bookingTab, setBookingTab] = useState<'pending' | 'upcoming'>('pending');
  const currentUser = authService.getCurrentUser();
  const { gate, Modals: GateModals, membershipActive, identityVerified } = useAccessGates();

  // A booking only counts as an active care-team relationship while it still
  // has a live shift — booking_requests.status stays 'accepted' forever once
  // accepted, so that field alone can't tell "ongoing" from "long over."
  // Mirrors PostsPage.tsx's own activeBookingIds (which offers "Re-book" once
  // all shifts are done instead of treating the booking as still active).
  const activeShiftBookingIds = useMemo(() => {
    const ids = new Set<string>();
    activeShifts.forEach((s: any) => { if (s.bookingRequestId) ids.add(s.bookingRequestId); });
    return ids;
  }, [activeShifts]);

  const activeCareTeam = useMemo(() => {
    const seen = new Set<string>();
    return acceptedBookingDocs.filter((d: any) =>
      activeShiftBookingIds.has(d.id) && d.caregiverId && !seen.has(d.caregiverId) && seen.add(d.caregiverId)
    );
  }, [acceptedBookingDocs, activeShiftBookingIds]);

  const bookedCaregiverIds = useMemo(
    () => new Set<string>(activeCareTeam.map((d: any) => d.caregiverId).filter(Boolean)),
    [activeCareTeam],
  );

  const hasActiveBooking = activeCareTeam.length > 0;

  const firstVisitReviewPrompts = useMemo(() => {
    // Exactly ONE completed shift with the caregiver = the first-visit window (same
    // moment Evia's recap line fires). A second shift, a review, or Not now ends it.
    const counts = new Map<string, { n: number; name: string }>();
    for (const s of completedShiftDocs) {
      const id = s.caregiverId as string | undefined;
      if (!id) continue;
      const cur = counts.get(id) ?? { n: 0, name: String(s.caregiverName || 'your caregiver') };
      counts.set(id, { n: cur.n + 1, name: cur.name });
    }
    return [...counts.entries()]
      .filter(([id, c]) => c.n === 1 && !myReviewCaregiverIds.has(id) && !dismissedReviewPrompts.includes(id))
      .map(([caregiverId, c]) => ({ caregiverId, caregiverName: c.name }));
  }, [completedShiftDocs, myReviewCaregiverIds, dismissedReviewPrompts]);
  const dismissReviewPrompt = async (caregiverId: string) => {
    setDismissedReviewPrompts(prev => [...prev, caregiverId]);
    if (!currentUser?.uid || !db) return;
    await db.collection('users').doc(currentUser.uid).set({ dismissedReviewPrompts: firebase.firestore.FieldValue.arrayUnion(caregiverId) }, { merge: true }).catch(() => {});
  };

  // A caregiver whose booking has ended but who was actually interviewed
  // before shouldn't be asked to "Request Interview" again in Nearby
  // Caregivers — offer Re-book instead. Same rule MyCareTeam.tsx's Past tab
  // and FindCaregivers.tsx already use.
  const rebookCaregiverIds = useMemo(() => {
    const completedInterviewIds = new Set<string>(
      allInterviews.filter((d: any) => d.status === 'completed').map((d: any) => d.caregiverId).filter(Boolean)
    );
    const pastBookingIds = new Set<string>(
      acceptedBookingDocs
        .filter((d: any) => !activeShiftBookingIds.has(d.id))
        .map((d: any) => d.caregiverId)
        .filter(Boolean)
    );
    return new Set<string>([...pastBookingIds].filter(id => completedInterviewIds.has(id)));
  }, [allInterviews, acceptedBookingDocs, activeShiftBookingIds]);

  // Nearby caregivers — uses same logic as Browse Caregivers (distance-filtered, AI-scored)
  const { caregivers: matchedCaregivers, loading: caregiversLoading } = useNearbyCaregiversWithScores(
    currentUser?.uid ?? null,
    { maxDistance: 25, limit: 4 }
  );

  // Home base data: care team, active shifts, pending interviews
  useEffect(() => {
    if (!currentUser?.uid || !db) return;
    const unsubs: (() => void)[] = [];

    // Job posts — all statuses for Care Requests card; open-only meta for interview
    // modal. Live (U6) so posts Evia creates/edits surface without a refresh.
    const jobPostsUnsub = db.collection('job_posts')
      .where('clientId', '==', currentUser.uid)
      .onSnapshot(snap => {
        // normalizeJobPost: server-written docs can carry location as an OBJECT — crashes JSX if rendered raw
        const posts = snap.docs.map(d => normalizeJobPost({ id: d.id, ...(d.data() as any) }));
        setClientAllPosts(posts);
        setClientOpenPosts(posts.filter(p => p.status === 'open').map(p => ({ id: p.id, title: p.title || 'Untitled post', createdAt: (p as any).createdAt })));
      }, () => {});
    unsubs.push(jobPostsUnsub);

    // Accepted booking_requests — real-time subscription. Whether each one is
    // still an ACTIVE relationship (vs. accepted long ago, all shifts since
    // finished) is derived separately via activeCareTeam, above.
    const teamUnsub = db.collection('booking_requests')
      .where('clientId', '==', currentUser.uid)
      .where('status', '==', 'accepted')
      .onSnapshot(snap => {
        setAcceptedBookingDocs(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })));
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

    // All booking requests — real-time so pending/cancel updates reflect immediately
    const bookingUnsub = db.collection('booking_requests')
      .where('clientId', '==', currentUser.uid)
      .onSnapshot(snap => {
        const all = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
        setAllBookingRequests(all);

        const pending = all.filter((b: any) => b.status === 'pending');
        setPendingBookingRequests(pending);
        // Back-fill photo for requests saved without caregiverPhotoURL
        const missing = pending.filter((b: any) => !b.caregiverPhotoURL && !b.caregiverPhoto && b.caregiverId);
        if (missing.length > 0) {
          const uniqueIds = [...new Set(missing.map((b: any) => b.caregiverId as string))];
          Promise.all(uniqueIds.map(async (id: string) => {
            const cSnap = await db!.collection('publicCaregiverProfiles').doc(id).get().catch(() => null);
            if (cSnap?.exists) {
              const d = cSnap.data() as any;
              return [id, d?.photo || d?.profilePhoto || d?.photoURL || d?.imageUrl || ''] as [string, string];
            }
            return [id, ''] as [string, string];
          })).then(entries => {
            const photoMap = Object.fromEntries(entries);
            setPendingBookingRequests(prev => prev.map((b: any) =>
              (b.caregiverPhotoURL || b.caregiverPhoto) ? b : { ...b, caregiverPhotoURL: photoMap[b.caregiverId] || null }
            ));
          });
        }
      }, () => {});
    unsubs.push(bookingUnsub);

    // Pending booking amendments (schedule change requests awaiting caregiver response)
    const amendUnsub = db.collection('booking_amendments')
      .where('clientId', '==', currentUser.uid)
      .where('status', '==', 'pending')
      .onSnapshot(snap => {
        setPendingAmendments(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, () => {});
    unsubs.push(amendUnsub);

    // Interviews — all statuses for Care Requests card + derived states.
    // Live listener (U5): agent-written interview requests now surface without a
    // manual refresh. Mirrors the booking_amendments onSnapshot pattern above.
    const interviewUnsub = db.collection('video_interviews')
      .where('clientId', '==', currentUser.uid)
      .onSnapshot(snap => {
        const all = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
        setAllInterviews(all);
        const activeStatuses = new Set(['requested', 'pending', 'scheduled']);
        const pending = all.filter((d: any) => activeStatuses.has(d.status));

        setRequestedCaregiverIds(new Set(pending.map((d: any) => d.caregiverId).filter(Boolean)));
      }, () => {});
    unsubs.push(interviewUnsub);

    // Pending shift swaps affecting this family's appointments (U7) — merges
    // caregiver-initiated and client-initiated swaps, live.
    unsubs.push(dbService.subscribeShiftSwapsForClient(currentUser.uid, setPendingSwaps));

    // Completed shifts + this family's reviews — the first-visit review card.
    unsubs.push(db.collection('shifts')
      .where('clientId', '==', currentUser.uid)
      .where('status', '==', 'completed')
      .onSnapshot(snap => setCompletedShiftDocs(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))), () => {}));
    unsubs.push(db.collection('reviews')
      .where('clientId', '==', currentUser.uid)
      .onSnapshot(snap => setMyReviewCaregiverIds(new Set(snap.docs.map(d => (d.data() as any).caregiverId).filter(Boolean))), () => {}));

    return () => unsubs.forEach(u => { try { u(); } catch {} });
  }, [currentUser?.uid]);

  // Caregiver profiles (rating + verification badges) for whoever is actually
  // shown on the Care Team card — reacts to activeCareTeam, not the raw
  // accepted-bookings list, so a stale/ended booking never fetches or shows a
  // badge for someone who isn't really on the team anymore.
  useEffect(() => {
    if (!db || activeCareTeam.length === 0) { setCareTeamProfiles({}); return; }
    let cancelled = false;
    (async () => {
      const profiles: Record<string, { rating?: number; reviewCount?: number; verified?: boolean; backgroundCheckStatus?: string }> = {};
      await Promise.all(
        activeCareTeam.slice(0, 2).map(async (d: any) => {
          if (!d.caregiverId) return;
          try {
            const cgDoc = await db!.collection('publicCaregiverProfiles').doc(d.caregiverId).get();
            const cg = cgDoc.data() || {};
            profiles[d.caregiverId] = {
              rating: cg.rating ?? cg.averageRating ?? undefined,
              reviewCount: cg.reviewCount ?? cg.totalReviews ?? 0,
              verified: cg.verified === true || cg.identityVerified === true,
              backgroundCheckStatus: cg.backgroundCheckStatus ?? cg.checkrStatus ?? undefined,
            };
          } catch { /* ignore */ }
        })
      );
      if (!cancelled) setCareTeamProfiles(profiles);
    })();
    return () => { cancelled = true; };
  }, [activeCareTeam]);

  const [unpaidShifts, setUnpaidShifts] = useState<any[]>([]);

  useEffect(() => {
    if (!currentUser?.uid) return;
    const UNPAID_STATUSES = ['pending_client_review', 'caregiver_counter_proposed', 'correction_proposed', 'payment_failed', 'approved', 'auto_approved'];
    const unsub = shiftHoursService.subscribeForClient(currentUser.uid, rows => {
      setShiftsToReview(
        rows
          .filter((r: any) => r.status === 'pending_client_review' || r.status === 'caregiver_counter_proposed' || r.status === 'payment_failed')
          .sort((a: any, b: any) => new Date(a.autoApproveAt).getTime() - new Date(b.autoApproveAt).getTime())
      );
      setUnpaidShifts(rows.filter((r: any) => UNPAID_STATUSES.includes(r.status)));
    });
    return () => { try { (unsub as any)?.(); } catch {} };
  }, [currentUser?.uid]);

  // The welcome/job-posting wizard no longer auto-fires (founder decision
  // 2026-07-02: it trapped users who hadn't finished intake). Posting a care
  // request stays available via the Find Care tab and dashboard CTAs.

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


        // Load saved caregivers from user profile; also check setup completion
        try {
          if (db && currentUser?.uid) {
            const userDoc = await db.collection('users').doc(currentUser.uid).get();
            const userData = userDoc.data() as any;
            // Show setup wizard for clients who haven't completed it yet.
            const savedIds: string[] = userData?.savedCaregiverIds || [];
            setDismissedReviewPrompts(Array.isArray(userData?.dismissedReviewPrompts) ? userData.dismissedReviewPrompts : []);
            if (savedIds.length > 0) {
              const snap = await db.collection('publicCaregiverProfiles')
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
    db.collection('publicCaregiverProfiles')
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

  const fmtTime = (t?: string) => {
    if (!t) return '';
    const [hStr, mStr] = t.split(':');
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr || '0', 10);
    if (isNaN(h)) return t;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
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
  

  const handleChatCoordinator = () => {
    setShowSupportModal(true);
  };

  const handleChatClick = async (caregiver: Caregiver) => {
    const clientUid = currentUser?.uid;
    if (!clientUid) { onShowToast?.('Could not start chat', 'error'); return; }
    try {
      const caregiverId = caregiver.id.toString();
      const sorted = [clientUid, caregiverId].sort();
      const roomId = sorted.join('_');
      const clientName = (currentUser as any)?.displayName || 'Client';
      const names = sorted.map(id => id === clientUid ? clientName : (caregiver.name || 'Caregiver'));
      const avatars = sorted.map(id => id === clientUid ? '' : (caregiver.imageUrl || (caregiver as any).photo || ''));
      navigate(`/client/inbox?room=${roomId}`, {
        state: {
          pendingRoom: {
            id: roomId,
            participants: sorted,
            participantNames: names,
            participantAvatars: avatars,
            unreadCount: { [clientUid]: 0, [caregiverId]: 0 },
            lastMessage: '',
            lastMessageTime: '',
            lastMessageTimestamp: null,
            createdAt: null,
          }
        }
      });
    } catch {
      onShowToast?.('Could not start chat', 'error');
    }
  };

  const handleGatedMessage = (caregiver: Caregiver) =>
    gate('message', caregiver.name, () => handleChatClick(caregiver));

  const handleGatedInterview = (caregiver: Caregiver) =>
    gate('interview', caregiver.name, () => setScheduleInterviewCaregiver(caregiver));

  // Match score per caregiver. When the matching engine produced a personalized,
  // proximity-aware score, use it verbatim. Otherwise (generic fallback list) fall
  // back to an honest rating/experience heuristic — never an inflated default.

  if (isLoading || caregiversLoading) {
    return (
      <>
        <ClientNavigation />
        <div className="min-h-screen flex items-center justify-center bg-paper-50">
          <Loader2 className="w-10 h-10 text-[var(--color-primary-600)] animate-spin" />
        </div>
      </>
    );
  }

  return (
    <div className="min-h-screen bg-paper-50">
      <ClientNavigation />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-16">

        {/* Greeting — only show when WhatsNext is hidden (active booking exists) */}
        {hasActiveBooking && (() => {
          const hour = new Date().getHours();
          const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
          const firstName = (currentUser?.displayName || currentUser?.email?.split('@')[0] || '').split(' ')[0];
          const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
          return (
            <div className="mb-6">
              <h1 className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Good {timeOfDay}, {firstName}!</h1>
              <p className="text-sm text-ink-600 mt-0.5">{today}</p>
            </div>
          );
        })()}

        {/* What's Next hero — only for new clients without an active booking */}
        {!hasActiveBooking && currentUser?.uid && (
          <WhatsNext
            uid={currentUser.uid}
            displayName={currentUser.displayName || currentUser.email?.split('@')[0]}
            onNavigate={(p) => navigate(p)}
            onScrollToMatches={scrollToMatches}
          />
        )}

        {/* Action required banner — returning client missing identity and/or membership */}
        {hasActiveBooking && (!identityVerified || !membershipActive) && (() => {
          const needsIdentity = !identityVerified;
          const needsMembership = !membershipActive;
          const bothNeeded = needsIdentity && needsMembership;
          return (
            <div className="mb-6 bg-white border border-slate-100 rounded-[2rem] shadow-sm p-6">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-5">Action required</p>
              <div className="flex items-start mb-5">
                {needsIdentity && (
                  <div className="flex flex-col items-center flex-1 min-w-0">
                    <div className="w-9 h-9 rounded-full bg-primary-600 flex items-center justify-center mb-2 shadow-sm">
                      <User className="w-4 h-4 text-white" />
                    </div>
                    <span className="text-xs font-semibold text-primary-600 text-center">Identity</span>
                  </div>
                )}
                {bothNeeded && <div className="flex-1 h-px bg-slate-200 mt-4 mx-1" />}
                {needsMembership && (
                  <div className="flex flex-col items-center flex-1 min-w-0">
                    <div className="w-9 h-9 rounded-full bg-primary-600 flex items-center justify-center mb-2 shadow-sm">
                      <CreditCard className="w-4 h-4 text-white" />
                    </div>
                    <span className="text-xs font-semibold text-primary-600 text-center">Membership</span>
                  </div>
                )}
              </div>
              <div className="bg-slate-50 rounded-2xl p-4">
                <p className="font-semibold text-slate-900 mb-3">
                  {needsIdentity && !needsMembership
                    ? 'Verify your identity'
                    : needsMembership && !needsIdentity
                    ? 'Activate your membership'
                    : 'Verify your identity & activate membership'}
                </p>
                <button
                  onClick={() => gate('booking', undefined, () => {})}
                  className="inline-flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold px-5 py-2.5 rounded-full transition-colors"
                >
                  {needsIdentity ? 'Verify identity' : 'Activate membership'}
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          );
        })()}

        {/* First-visit review prompt — one card per caregiver, until reviewed or dismissed (2026-09-19) */}
        {firstVisitReviewPrompts.map(p => (
          <div key={p.caregiverId} className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1">
              <p className="font-semibold text-slate-900">How was your first visit with {p.caregiverName.split(' ')[0]}?</p>
              <p className="text-sm text-slate-500">Leave a review — it helps other families choose.</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => dismissReviewPrompt(p.caregiverId)} className="px-4 py-2 text-sm font-semibold text-slate-600 border border-slate-200 rounded-full hover:bg-slate-50">Not now</button>
              <button onClick={() => navigate(`/client/caregiver/${p.caregiverId}?review=1`)} className="px-4 py-2 text-sm font-semibold text-white bg-primary-600 rounded-full hover:bg-primary-700">Leave a review</button>
            </div>
          </div>
        ))}


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


            {/* Row 2: Care Request in Progress + Active Booking + Care Team */}
            <div className="grid lg:grid-cols-3 gap-4">

              {/* Care Requests */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Briefcase className="w-4 h-4 text-primary-500" />
                    <h2 className="font-semibold text-slate-900">Care Requests</h2>
                  </div>
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
                            return (
                              <div key={post.id} className="border border-slate-200 rounded-xl p-3">
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
                  const iAccepted = allInterviews.filter(iv => ['accepted', 'scheduled', 'confirmed'].includes(iv.status));
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
                          <p className="text-sm text-slate-400 text-center py-4">No {ivFilter} interviews yet</p>
                        ) : displayList.map((iv: any) => {
                          const ivDt = iv.scheduledTime ? new Date(iv.scheduledTime) : (iv.date && iv.time ? new Date(`${iv.date}T${iv.time}`) : null);
                          const isVideo = iv.interviewType === 'video';
                          return (
                            <div key={iv.id} className="border border-slate-200 rounded-xl p-3">
                              {/* Header: avatar + name */}
                              <div className="flex items-center gap-2 mb-2">
                                <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                                  {iv.caregiverPhoto ? (
                                    <img src={iv.caregiverPhoto} alt={iv.caregiverName} className="w-full h-full object-cover" />
                                  ) : (
                                    <span className="text-xs font-bold text-primary-600">{(iv.caregiverName || 'C')[0].toUpperCase()}</span>
                                  )}
                                </div>
                                <p className="text-sm font-semibold text-slate-900 truncate">{iv.caregiverName}</p>
                              </div>
                              {/* Detail lines */}
                              <div className="space-y-1">
                                {iv.jobTitle && (
                                  <p className="text-xs text-slate-500 truncate">{iv.jobTitle}</p>
                                )}
                                {ivDt && (
                                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                                    <Calendar className="w-3 h-3 flex-shrink-0" />
                                    <span>{ivDt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · {ivDt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}</span>
                                  </div>
                                )}
                                {iv.interviewType && (
                                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                                    {isVideo ? <Video className="w-3 h-3 flex-shrink-0" /> : <Phone className="w-3 h-3 flex-shrink-0" />}
                                    <span>{isVideo ? 'Video' : 'Phone'}</span>
                                  </div>
                                )}
                                {iv.callUrl?.startsWith('https://meet.google.com/') && ['accepted', 'scheduled', 'confirmed'].includes(iv.status) && (
                                  <a href={iv.callUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary-600 hover:underline">
                                    <Video className="w-3 h-3 flex-shrink-0" />
                                    Join video call
                                  </a>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* Today's Booking */}
              {(() => {
                const _now = new Date();
                const todayStr = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}`;
                const activeTab = [...activeShifts]
                  .filter((s: any) => s.status === 'in-progress')
                  .sort((a: any, b: any) => (a.date || '').localeCompare(b.date || '') || (a.startTime || '').localeCompare(b.startTime || ''));
                const upcomingTab = [...activeShifts]
                  .filter((s: any) => s.date === todayStr && s.status === 'scheduled')
                  .sort((a: any, b: any) => (a.startTime || '').localeCompare(b.startTime || ''));
                const tabShifts = todayBookingTab === 'active' ? activeTab : upcomingTab;
                const renderShift = (shift: any) => {
                  const ds = shiftDisplayStatus(shift);
                  const isInProgress = shift.status === 'in-progress';
                  const cardBorder = ds === 'overdue' ? 'border-orange-300 bg-orange-50' : 'border-slate-200';
                  const statusColor = isInProgress ? 'text-green-600' : ds === 'overdue' ? 'text-orange-600' : 'text-slate-500';
                  const statusText = isInProgress ? 'In Progress' : ds === 'overdue' ? 'Overdue' : 'Upcoming';
                  return (
                    <div key={shift.id} className={`rounded-xl p-3 border ${cardBorder}`}>
                      <div className="flex items-center gap-2.5 mb-2">
                        <div className="w-9 h-9 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                          {shift.caregiverPhotoURL ? (
                            <img src={shift.caregiverPhotoURL} alt={shift.caregiverName} className="w-full h-full object-cover" />
                          ) : (
                            <span className="text-sm font-bold text-primary-600">{(shift.caregiverName || 'C')[0].toUpperCase()}</span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-slate-900 text-sm leading-tight truncate">{shift.caregiverName}</p>
                          {/* "Upcoming" restates the tab it's already in — only worth
                              showing when it's telling you something you don't already
                              know (overdue / in progress). */}
                          {statusText !== 'Upcoming' && (
                            <p className={`text-xs font-medium mt-0.5 ${statusColor}`}>
                              {statusText}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-slate-500">
                        <Clock className="w-3 h-3 flex-shrink-0" />
                        <span className="font-medium">{fmtTime(shift.startTime)} – {fmtTime(shift.endTime)}</span>
                      </div>
                      {isInProgress && shift.startedAt && (
                        <div className="flex items-center gap-1.5 text-xs mt-1 text-green-600 font-medium">
                          <CheckCircle className="w-3 h-3 flex-shrink-0" />
                          <span>Started at {(() => {
                            const d = shift.startedAt?.toDate ? shift.startedAt.toDate() : new Date(shift.startedAt);
                            return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
                          })()}</span>
                        </div>
                      )}
                      {shift.careRecipients && shift.careRecipients.length > 0 && (
                        <div className="flex items-center gap-1.5 text-xs mt-1 text-slate-500">
                          <User className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{shift.careRecipients.map((r: any) => typeof r === 'string' ? r : r.name).filter(Boolean).join(', ')}</span>
                        </div>
                      )}
                      {shift.address && (
                        <div className="flex items-center gap-1.5 text-xs mt-1 text-slate-500">
                          <MapPin className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{shift.address}</span>
                        </div>
                      )}
                      {/* Live progress while the caregiver is there — same panel as My Bookings */}
                      {isInProgress && (
                        <div className="mt-3">
                          <VisitProgressPanel shift={shift} live />
                        </div>
                      )}
                    </div>
                  );
                };
                return (
                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <CalendarDays className="w-4 h-4 text-primary-500" />
                        <h2 className="font-semibold text-slate-900">Today's Booking</h2>
                      </div>
                    </div>
                    {/* Tab toggle */}
                    <div className="flex bg-slate-100 rounded-lg p-0.5 mb-4">
                      <button
                        onClick={() => setTodayBookingTab('active')}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${todayBookingTab === 'active' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
                      >
                        <CheckCircle className="w-3.5 h-3.5" /> Active Shift
                      </button>
                      <button
                        onClick={() => setTodayBookingTab('upcoming')}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${todayBookingTab === 'upcoming' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
                      >
                        <Clock className="w-3.5 h-3.5" /> Upcoming
                      </button>
                    </div>
                    {/* Section label row — matches Care Requests "Posts" row */}
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold text-slate-700">
                        {todayBookingTab === 'active' ? 'Active Shifts' : 'Upcoming Shifts'}
                      </p>
                      <button onClick={() => navigate('/client/bookings')} className="text-xs text-primary-600 font-medium hover:underline flex items-center gap-0.5">
                        View all <ChevronRight className="w-3 h-3" />
                      </button>
                    </div>
                    {tabShifts.length > 0 ? (
                      <div className="space-y-2 max-h-72 overflow-y-auto">
                        {tabShifts.map(renderShift)}
                      </div>
                    ) : (
                      <div className="text-center py-5">
                        <p className="text-sm text-slate-400">
                          {todayBookingTab === 'active' ? 'No active shifts right now' : 'No upcoming shifts today'}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Care Team */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-primary-500" />
                    <h2 className="font-semibold text-slate-900">Care Team</h2>
                  </div>
                  <button onClick={() => navigate('/client/my-care-team')} className="text-xs text-primary-600 font-medium hover:underline">View all</button>
                </div>
                {activeCareTeam.length === 0 ? (
                  <div className="text-center py-6">
                    <p className="text-sm text-slate-400">No active caregivers</p>
                    <button onClick={() => navigate('/client/find-caregivers')} className="text-xs text-primary-600 font-medium hover:underline mt-1">Find a caregiver →</button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {activeCareTeam.slice(0, 2).map((booking: any) => {
                      const cgProfile = careTeamProfiles[booking.caregiverId] || {};
                      const schedDays: string[] = (() => {
                        const dst = booking.schedule?.dayShiftTimes;
                        if (dst && typeof dst === 'object') return Object.keys(dst);
                        return booking.schedule?.days || [];
                      })();
                      const rate = booking.rate ?? booking.caregiverRate ?? null;
                      const recipient = (booking.careRecipients || [])[0];
                      const recipientName = recipient?.name || recipient?.firstName || '';

                      return (
                        <div key={booking.id} className="border border-slate-200 rounded-xl p-3.5">
                          {/* Header: avatar + name + role */}
                          <div className="flex items-center gap-3 mb-3">
                            <div className="w-11 h-11 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                              {booking.caregiverPhotoURL ? (
                                <img src={booking.caregiverPhotoURL} alt={booking.caregiverName} className="w-full h-full object-cover" />
                              ) : (
                                <span className="text-sm font-bold text-primary-600">{(booking.caregiverName || 'C')[0].toUpperCase()}</span>
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-bold text-slate-900 truncate">{booking.caregiverName}</p>
                              <p className="text-xs text-slate-500">{booking.caregiverRole || 'Caregiver'}</p>
                              {cgProfile.rating != null && (cgProfile.reviewCount ?? 0) > 0 && (
                                <div className="flex items-center gap-1 mt-0.5">
                                  <Star className="w-3 h-3 text-yellow-400 fill-yellow-400" />
                                  <span className="text-xs font-semibold text-slate-700">{Number(cgProfile.rating).toFixed(1)}</span>
                                </div>
                              )}
                            </div>
                            <CaregiverVerificationBadges
                              verified={cgProfile.verified}
                              backgroundCheckStatus={cgProfile.backgroundCheckStatus}
                              className="flex-shrink-0"
                            />
                          </div>
                          {/* Divider */}
                          <div className="border-t border-slate-100 mb-3" />
                          {/* Rate + schedule days */}
                          <div className="flex items-center gap-3 mb-2 flex-wrap">
                            {rate != null && (
                              <p className="text-sm font-bold text-slate-800"><span className="text-primary-600">${rate}</span><span className="text-xs font-normal text-slate-400">/hr · ${billedHourlyRate(Number(rate)).toFixed(2)}/hr billed</span></p>
                            )}
                            {schedDays.length > 0 && (
                              <div className="flex gap-1 flex-wrap">
                                {schedDays.slice(0, 5).map(d => (
                                  <span key={d} className="text-[10px] font-semibold px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded">{d.slice(0,3)}</span>
                                ))}
                              </div>
                            )}
                          </div>
                          {/* Caring for */}
                          {recipientName && (
                            <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-2">
                              <Heart className="w-3 h-3 text-rose-400 flex-shrink-0" />
                              <span>Caring for: <span className="font-semibold text-slate-700">{recipientName}</span></span>
                            </div>
                          )}
                          {/* Actions */}
                          <div className="flex gap-2">
                            <button
                              onClick={() => booking.caregiverId && handleGatedMessage({ id: booking.caregiverId, name: booking.caregiverName } as any)}
                              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
                            >
                              <MessageSquare className="w-3.5 h-3.5" /> Message
                            </button>
                            <button
                              onClick={() => navigate(`/client/caregiver/${booking.caregiverId}`)}
                              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors"
                            >
                              <User className="w-3.5 h-3.5" /> Profile
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Evia Activity feed removed for now (Hamse, 2026-08-23) — every
                message_sent entry shows the same generic "Evia sent a message
                to your care team" line regardless of whether the care team
                had anyone to receive it, which reads as inaccurate. Revisit
                once the feed can reflect real delivery. */}

            {/* Pending care changes — live shift swaps (U7); hidden when none */}
            <PendingSwapsPanel
              swaps={pendingSwaps}
              title="Pending care changes"
              subtitle="Shift swaps being arranged for your visits"
            />

            {/* Row 3: Upcoming Bookings + Timesheets + Caregivers Near You */}
            <div className="grid lg:grid-cols-3 gap-4">

              {/* Bookings — matches Care Requests card pattern */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-primary-500" />
                    <h2 className="font-semibold text-slate-900">Bookings</h2>
                  </div>
                </div>

                {/* Tab toggle */}
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

                {/* Pending tab */}
                {bookingTab === 'pending' && (() => {
                  const totalPending = pendingBookingRequests.length + pendingAmendments.length;
                  if (totalPending === 0) return (
                    <div className="text-center py-5">
                      <p className="text-sm text-slate-400 mb-2">No pending bookings</p>
                      <button onClick={() => navigate('/client/posts?tab=interviews&filter=completed')} className="text-xs text-primary-600 font-medium hover:underline">View completed interviews →</button>
                    </div>
                  );
                  return (
                    <>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-semibold text-slate-700">Pending</p>
                        <button onClick={() => navigate('/client/bookings?tab=requests')} className="text-xs text-primary-600 font-medium hover:underline flex items-center gap-0.5">
                          View all <ChevronRight className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="space-y-3 max-h-72 overflow-y-auto">
                        {pendingBookingRequests.slice(0, 2).map((b: any) => {
                          const dst = b.schedule?.dayShiftTimes;
                          const schedLine = dst ? Object.entries(dst).slice(0, 2).map(([day, slots]: [string, any]) => {
                            const slot = slots?.[0];
                            return slot ? `${day} ${fmtTime(slot.start)}–${fmtTime(slot.end)}` : day;
                          }).join(' · ') : null;
                          return (
                            <div key={b.id} className="border border-slate-200 rounded-xl p-3">
                              <div className="flex items-center gap-2 mb-2">
                                <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                                  {(b.caregiverPhotoURL || b.caregiverPhoto) ? (
                                    <img src={b.caregiverPhotoURL || b.caregiverPhoto} alt={b.caregiverName} className="w-full h-full object-cover" />
                                  ) : (
                                    <span className="text-xs font-bold text-primary-600">{(b.caregiverName || 'C')[0].toUpperCase()}</span>
                                  )}
                                </div>
                                <p className="text-sm font-semibold text-slate-900 truncate flex-1">{b.caregiverName}</p>
                              </div>
                              <div className="space-y-1 mb-2">
                                {b.jobTitle && <p className="text-xs text-slate-500 truncate">{b.jobTitle}</p>}
                                {schedLine && (
                                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                                    <Calendar className="w-3 h-3 flex-shrink-0" />
                                    <span className="truncate">{schedLine}</span>
                                  </div>
                                )}
                                {b.address && (
                                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                                    <MapPin className="w-3 h-3 flex-shrink-0" />
                                    <span className="truncate">{b.address}</span>
                                  </div>
                                )}
                              </div>
                              {b.rate != null && (
                                <p className="text-sm font-bold text-primary-600">${b.rate}/hr · Card</p>
                              )}
                            </div>
                          );
                        })}
                        {pendingAmendments.slice(0, 2).map((a: any) => {
                          const schedLine = a.newDays
                            ? Object.entries(a.newDays as Record<string, Array<{ start: string; end: string }>>)
                                .slice(0, 2)
                                .map(([day, slots]) => {
                                  const slot = slots?.[0];
                                  return slot ? `${day} ${fmtTime(slot.start)}–${fmtTime(slot.end)}` : day;
                                })
                                .join(' · ')
                            : null;
                          return (
                            <div key={a.id} className="border border-slate-200 rounded-xl p-3">
                              <div className="flex items-center gap-2 mb-2">
                                <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                                  <span className="text-xs font-bold text-primary-600">{(a.caregiverName || 'C')[0].toUpperCase()}</span>
                                </div>
                                <p className="text-sm font-semibold text-slate-900 truncate flex-1">{a.caregiverName}</p>
                                <span className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full shrink-0">Awaiting response</span>
                              </div>
                              <div className="space-y-1">
                                <p className="text-xs text-slate-500">Schedule change request</p>
                                {schedLine && (
                                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                                    <Calendar className="w-3 h-3 flex-shrink-0" />
                                    <span className="truncate">{schedLine}{a.ongoing ? ' · Ongoing' : ''}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}

                {/* Upcoming tab */}
                {bookingTab === 'upcoming' && (() => {
                  // Local-date string, not toISOString() (UTC) — mixing the two rolled
                  // "tomorrow" forward an extra day whenever local time was already past
                  // UTC midnight, silently skipping tomorrow's real shifts.
                  const _now = new Date();
                  const todayStr = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}`;
                  const upcoming = [...activeShifts]
                    .filter((s: any) => s.date > todayStr)
                    .sort((a: any, b: any) => {
                      if (a.date !== b.date) return a.date > b.date ? 1 : -1;
                      return (a.startTime || '').localeCompare(b.startTime || '');
                    });
                  if (upcoming.length === 0) return (
                    <div className="text-center py-5">
                      <p className="text-sm text-slate-400 mb-2">No upcoming shifts</p>
                      <button onClick={() => navigate('/client/bookings')} className="text-xs text-primary-600 font-medium hover:underline">View bookings →</button>
                    </div>
                  );
                  return (
                    <>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-semibold text-slate-700">Upcoming Shifts</p>
                        <button onClick={() => navigate('/client/bookings')} className="text-xs text-primary-600 font-medium hover:underline flex items-center gap-0.5">
                          View all <ChevronRight className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="space-y-3 max-h-72 overflow-y-auto">
                        {upcoming.slice(0, 2).map((shift: any) => {
                          const parts = (shift.date || '').split('-');
                          const d = parts.length === 3 ? new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) : null;
                          const inProgress = shift.status === 'in-progress';
                          return (
                            <div key={shift.id} className="border border-slate-200 rounded-xl p-3 flex items-start gap-3">
                              {/* Date block */}
                              <div className="text-center w-10 flex-shrink-0 pt-0.5">
                                <p className="text-xl font-bold text-slate-900 leading-none">{d ? d.getDate() : '–'}</p>
                                <p className="text-xs font-semibold text-slate-400 uppercase mt-0.5">{d ? d.toLocaleDateString('en-US', { month: 'short' }) : ''}</p>
                                <p className="text-xs text-slate-400">{d ? d.toLocaleDateString('en-US', { weekday: 'short' }) : ''}</p>
                              </div>
                              {/* Details */}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                                    {shift.caregiverPhotoURL ? (
                                      <img src={shift.caregiverPhotoURL} alt={shift.caregiverName} className="w-full h-full object-cover" />
                                    ) : (
                                      <span className="text-xs font-bold text-primary-600">{(shift.caregiverName || 'C')[0].toUpperCase()}</span>
                                    )}
                                  </div>
                                  <p className="text-sm font-semibold text-slate-900 truncate flex-1">{shift.caregiverName}</p>
                                  {inProgress && (
                                    <span className="text-xs font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded-full flex-shrink-0">In Progress</span>
                                  )}
                                </div>
                                {(shift.startTime || shift.endTime) && (
                                  <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-0.5">
                                    <Clock className="w-3 h-3 flex-shrink-0" />
                                    <span>{fmtTime(shift.startTime)}{shift.endTime ? ` – ${fmtTime(shift.endTime)}` : ''}</span>
                                  </div>
                                )}
                                {shift.address && (
                                  <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-0.5">
                                    <MapPin className="w-3 h-3 flex-shrink-0" />
                                    <span className="truncate">{shift.address}</span>
                                  </div>
                                )}
                                {shift.rate != null && (
                                  <p className="text-xs font-semibold text-primary-600 mt-1">${shift.rate}/hr · Card</p>
                                )}
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
                  <button onClick={() => navigate('/client/payments')} className="text-xs text-primary-600 font-medium hover:underline">View all</button>
                </div>
                <div className="space-y-2">
                  {shiftsToReview.length > 0 ? (
                    <>
                      {shiftsToReview.slice(0, 2).map((shift: any) => {
                        const startTs = shift.finalStartTime ?? shift.submittedStartTime;
                        const endTs   = shift.finalEndTime   ?? shift.submittedEndTime;
                        const dispHours = (startTs && endTs)
                          ? (new Date(endTs).getTime() - new Date(startTs).getTime()) / 3_600_000
                          : (shift.finalTotalHours ?? shift.submittedTotalHours ?? 0);
                        const pay = shift.grossPay ?? (dispHours * (shift.payRate ?? 0));
                        const fmtTs = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
                        const shiftDate = startTs ? new Date(startTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
                        const durationStr = (() => {
                          if (!dispHours || dispHours <= 0) return '';
                          const totalSecs = Math.round(dispHours * 3600);
                          const h = Math.floor(totalSecs / 3600);
                          const m = Math.floor((totalSecs % 3600) / 60);
                          const s = totalSecs % 60;
                          return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                        })();
                        const STATUS_MAP: Record<string, { label: string; color: string; bg: string }> = {
                          pending_client_review:      { label: 'Needs Review',     color: 'text-amber-700',  bg: 'bg-amber-50 border border-amber-200' },
                          caregiver_counter_proposed: { label: 'Counter Received', color: 'text-yellow-700', bg: 'bg-yellow-50 border border-yellow-200' },
                          correction_proposed:        { label: 'Correction Sent',  color: 'text-orange-700', bg: 'bg-orange-50 border border-orange-200' },
                          payment_failed:             { label: 'Payment Failed',   color: 'text-red-700',    bg: 'bg-red-50 border border-red-200' },
                        };
                        const statusCfg = STATUS_MAP[shift.status] ?? { label: shift.status, color: 'text-slate-600', bg: 'bg-slate-100 border border-slate-200' };
                        const msLeft = shift.autoApproveAt ? new Date(shift.autoApproveAt).getTime() - Date.now() : 0;
                        const hoursLeft = Math.max(0, Math.round(msLeft / 3_600_000));
                        const showAutoApprove = shift.status === 'pending_client_review' && !!shift.autoApproveAt && hoursLeft <= 24;
                        const needsExplicitApproval = shift.status === 'pending_client_review' && !shift.autoApproveAt;
                        return (
                          <div key={shift.id} className="border border-slate-200 rounded-xl p-3">
                            {/* Row 1: avatar + caregiver name + date */}
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <div className="w-7 h-7 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
                                  {shift.caregiverPhotoURL
                                    ? <img src={shift.caregiverPhotoURL} className="w-full h-full object-cover" alt="" />
                                    : <span className="text-xs font-bold text-primary-600">{(shift.caregiverName || 'C')[0].toUpperCase()}</span>
                                  }
                                </div>
                                <span className="text-xs font-semibold text-slate-800 truncate">{shift.caregiverName || 'Caregiver'}</span>
                              </div>
                              <span className="text-xs text-slate-400 flex-shrink-0 ml-2">{shiftDate}</span>
                            </div>
                            {/* Row 2: time in → out */}
                            <p className="text-xs text-slate-500 mb-1.5">
                              {startTs && endTs ? `${fmtTs(startTs)} → ${fmtTs(endTs)}` : '—'}
                            </p>
                            {/* Row 3: duration · pay · method · status */}
                            <div className="flex items-center gap-2 text-xs mb-2 flex-wrap">
                              {durationStr && <span className="text-slate-500">{durationStr}</span>}
                              {durationStr && <span className="text-slate-300">·</span>}
                              <span className="font-semibold text-slate-700">${pay.toFixed(2)} <span className="font-normal text-slate-400">· ${(typeof shift.totalChargeCents === 'number' ? shift.totalChargeCents / 100 : totalChargedDollars(pay)).toFixed(2)} {shift.status === 'payment_failed' ? 'charge failed' : 'charged'}</span></span>
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold border bg-blue-50 text-blue-700 border-blue-200">
                                Card
                              </span>
                              <span className={`ml-auto px-2 py-0.5 rounded-full text-[10px] font-semibold ${statusCfg.bg} ${statusCfg.color}`}>
                                {statusCfg.label}
                              </span>
                            </div>
                            {/* Auto-approve warning */}
                            {showAutoApprove && (
                              <div className="flex items-center gap-1.5 text-[10px] text-amber-600">
                                <Clock className="w-3 h-3 flex-shrink-0" />
                                <span>Auto-approves in {hoursLeft}h</span>
                              </div>
                            )}
                            {needsExplicitApproval && (
                              <div className="flex items-center gap-1.5 text-[10px] text-amber-600">
                                <Clock className="w-3 h-3 flex-shrink-0" />
                                <span>Needs your approval — won't auto-approve</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </>
                  ) : (
                    <div className="flex items-center gap-3 p-3 bg-green-50 rounded-lg">
                      <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center flex-shrink-0">
                        <CheckCircle className="w-4 h-4 text-green-600" />
                      </div>
                      <p className="text-sm text-slate-600">All timesheets reviewed</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Payment Summary */}
              {(() => {
                const shiftAmt = (r: any) => {
                  const start = r.finalStartTime ?? r.submittedStartTime;
                  const end   = r.finalEndTime   ?? r.submittedEndTime;
                  const hrs   = (start && end)
                    ? (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000
                    : (r.finalTotalHours ?? r.submittedTotalHours ?? 0);
                  return r.grossPay ?? (hrs * (r.payRate ?? 0));
                };
                // What will go on the card: each caregiver total plus the 9% service fee (utils/pricing.ts = the backend math).
                const grandTotal = unpaidShifts.reduce((s, r) => s + (typeof r.totalChargeCents === 'number' ? r.totalChargeCents / 100 : totalChargedDollars(shiftAmt(r))), 0);
                const needsActionCount = unpaidShifts.filter(r =>
                  ['pending_client_review','caregiver_counter_proposed','correction_proposed','payment_failed'].includes(r.status)
                ).length;
                return (
                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <DollarSign className="w-4 h-4 text-primary-500" />
                        <h2 className="font-semibold text-slate-900">Payment Summary</h2>
                      </div>
                      <button onClick={() => navigate('/client/payments')} className="text-xs text-primary-600 font-medium hover:underline">View all</button>
                    </div>

                    {unpaidShifts.length === 0 ? (
                      <div className="text-center py-6">
                        <p className="text-sm text-slate-400">No outstanding payments</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {/* Summary rows */}
                        <div className="bg-slate-50 rounded-xl p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-slate-500">Outstanding</span>
                            <span className="text-sm font-semibold text-slate-900">{unpaidShifts.length} shift{unpaidShifts.length !== 1 ? 's' : ''}</span>
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
          </div>
        ) : (
          /* ── DISCOVERY ──────────────────────────────────────────────── */
          <>

            <div className="mb-6">
              <h1 className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Nearby Caregivers</h1>
            </div>

            <div className="grid lg:grid-cols-3 gap-6 items-start">
              <div className="lg:col-span-2 space-y-6 min-w-0">

                {(() => {
                  const discoveryCaregivers = matchedCaregivers.filter(c => !bookedCaregiverIds.has(c.id) && !blockedIds.has(c.id));
                  return discoveryCaregivers.length > 0 ? (
                    <div id="caregiver-matches" className="grid sm:grid-cols-2 gap-4">
                      {discoveryCaregivers.slice(0, 4).map((caregiver) => (
                        <CaregiverMatchCard
                          key={caregiver.id}
                          caregiver={caregiver}
                          matchScore={0}
                          matchReasons={[]}
                          onBook={handleGatedInterview}
                          onRebook={(cg) => navigate(`/client/posts?rebook=${cg.id}`)}
                          onViewProfile={(cg) => navigate(`/client/caregiver/${cg.id}`)}
                          onMessage={handleGatedMessage}
                          isSaved={savedIds.includes(caregiver.id)}
                          onToggleSave={handleToggleSave}
                          isRequested={requestedCaregiverIds.has(caregiver.id)}
                          isRebookable={rebookCaregiverIds.has(caregiver.id)}
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
                      See more →
                    </button>
                  </div>
                )}



              </div>

              <div className="space-y-4 sticky top-6">
                {/* Full Care Requests card — matches active dashboard */}
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Briefcase className="w-4 h-4 text-primary-500" />
                      <h2 className="font-semibold text-slate-900">Care Requests</h2>
                    </div>
                  </div>

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
                            {[...openPosts].sort((a, b) => (b.createdAt || '') > (a.createdAt || '') ? 1 : -1).slice(0, 2).map((post: any) => (
                              <div key={post.id} className="border border-slate-200 rounded-xl p-3">
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
                                <div className="flex items-center gap-3 pt-2 border-t border-slate-100">
                                  <span className="flex items-center gap-1 text-xs text-slate-500"><User className="w-3 h-3" />{post.seniorCount ?? 1} senior</span>
                                  <span className="flex items-center gap-1 text-xs text-slate-500"><Users className="w-3 h-3" />{post.applicantCount ?? 0} applicant{(post.applicantCount ?? 0) !== 1 ? 's' : ''}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {careRequestTab === 'interviews' && (() => {
                    const iPending = allInterviews.filter(iv => ['requested', 'pending'].includes(iv.status));
                    const iAccepted = allInterviews.filter(iv => ['accepted', 'scheduled', 'confirmed'].includes(iv.status));
                    const bookingMap: Record<string, any> = {};
                    allBookingRequests.forEach((b: any) => {
                      const key = `${b.caregiverId}_${b.jobId || b.interviewId || ''}`;
                      bookingMap[key] = b;
                    });
                    const iCompleted = allInterviews.filter(iv => {
                      if (iv.status !== 'completed') return false;
                      const key = `${iv.caregiverId}_${iv.jobId || iv.id}`;
                      const booking = bookingMap[key];
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
                            <p className="text-sm text-slate-400 text-center py-4">No {ivFilter} interviews yet</p>
                          ) : displayList.map((iv: any) => {
                            const ivDt = iv.scheduledTime ? new Date(iv.scheduledTime) : (iv.date && iv.time ? new Date(`${iv.date}T${iv.time}`) : null);
                            const isVideo = iv.interviewType === 'video';
                            return (
                              <div key={iv.id} className="border border-slate-200 rounded-xl p-3">
                                <div className="flex items-center gap-2 mb-2">
                                  <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                                    {iv.caregiverPhoto ? (
                                      <img src={iv.caregiverPhoto} alt={iv.caregiverName} className="w-full h-full object-cover" />
                                    ) : (
                                      <span className="text-xs font-bold text-primary-600">{(iv.caregiverName || 'C')[0].toUpperCase()}</span>
                                    )}
                                  </div>
                                  <p className="text-sm font-semibold text-slate-900 truncate">{iv.caregiverName}</p>
                                </div>
                                <div className="space-y-1">
                                  {iv.jobTitle && <p className="text-xs text-slate-500 truncate">{iv.jobTitle}</p>}
                                  {ivDt && (
                                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                                      <Calendar className="w-3 h-3 flex-shrink-0" />
                                      <span>{ivDt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · {ivDt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}</span>
                                    </div>
                                  )}
                                  {iv.interviewType && (
                                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                                      {isVideo ? <Video className="w-3 h-3 flex-shrink-0" /> : <Phone className="w-3 h-3 flex-shrink-0" />}
                                      <span>{isVideo ? 'Video' : 'Phone'}</span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    );
                  })()}
                </div>

                {/* Pending Bookings card — visible in discovery so clients can track requests awaiting acceptance */}
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-primary-500" />
                      <h2 className="font-semibold text-slate-900">Bookings</h2>
                    </div>
                    {pendingBookingRequests.length > 0 && (
                      <button onClick={() => navigate('/client/bookings?tab=requests')} className="text-xs text-primary-600 font-medium hover:underline flex items-center gap-0.5">
                        View all <ChevronRight className="w-3 h-3" />
                      </button>
                    )}
                  </div>

                  {pendingBookingRequests.length === 0 ? (
                    <div className="text-center py-4">
                      <p className="text-sm text-slate-400 mb-2">No pending bookings</p>
                      <button onClick={() => navigate('/client/posts?tab=interviews&filter=completed')} className="text-xs text-primary-600 font-medium hover:underline">View completed interviews →</button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {pendingBookingRequests.slice(0, 2).map((b: any) => {
                        const dst = b.schedule?.dayShiftTimes;
                        const schedLine = dst ? Object.entries(dst).slice(0, 2).map(([day, slots]: [string, any]) => {
                          const slot = slots?.[0];
                          return slot ? `${day} ${fmtTime(slot.start)}–${fmtTime(slot.end)}` : day;
                        }).join(' · ') : null;
                        return (
                          <div key={b.id} className="border border-slate-200 rounded-xl p-3">
                            <div className="flex items-center gap-2 mb-2">
                              <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                                {(b.caregiverPhotoURL || b.caregiverPhoto) ? (
                                  <img src={b.caregiverPhotoURL || b.caregiverPhoto} alt={b.caregiverName} className="w-full h-full object-cover" />
                                ) : (
                                  <span className="text-xs font-bold text-primary-600">{(b.caregiverName || 'C')[0].toUpperCase()}</span>
                                )}
                              </div>
                              <p className="text-sm font-semibold text-slate-900 truncate flex-1">{b.caregiverName}</p>
                              <span className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full shrink-0">Pending</span>
                            </div>
                            <div className="space-y-1">
                              {b.jobTitle && <p className="text-xs text-slate-500 truncate">{b.jobTitle}</p>}
                              {schedLine && (
                                <div className="flex items-center gap-1.5 text-xs text-slate-500">
                                  <Calendar className="w-3 h-3 flex-shrink-0" />
                                  <span className="truncate">{schedLine}</span>
                                </div>
                              )}
                              {b.rate != null && (
                                <p className="text-sm font-bold text-primary-600">${b.rate}/hr · Card</p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <DashboardSidebar
                  currentUserUid={currentUser?.uid}
                  onChatCoordinator={handleChatCoordinator}
                  hideCareRequests
                />
              </div>
            </div>
          </>
        )}
      </main>


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

    </div>
  );
};
