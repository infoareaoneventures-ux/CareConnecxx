import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus, Briefcase, Users, MapPin, Calendar, Loader2, MoreHorizontal,
  Clock, Star, MessageSquare, User, CheckCircle, XCircle, Clock3,
  Video, Phone, ChevronRight, X, Send, Edit2, Pencil, RefreshCw,
} from 'lucide-react';
import { useAccessGates } from '../../hooks/useAccessGates';
import { ScheduleInterviewModal } from '../ScheduleInterviewModal';
import { EditJobPostModal } from './EditJobPostModal';
import { ClientNavigation } from './ClientNavigation';
import { useCareConnex } from '../../context/CareConnexContext';
import { dbService } from '../../services/api';
import { auth, db } from '../../lib/firebase';
import firebase from '../../lib/firebase';
import { JobPost } from '../../types';

type MainTab = 'posts' | 'interviews';
type PostsFilter = 'open' | 'closed';

const CARE_NEED_SUBS: Record<string, string[]> = {
  'Mobility Assistance': ['Ambulation', 'Transfer Assist'],
  'Dementia / Memory Care': ['Supervision / Safety monitoring', 'Memory support', 'Redirection / cueing'],
  'Medication Reminders': ['Morning', 'Afternoon', 'Evening', 'Bedtime'],
  'Personal Care': ['Bathing', 'Dressing Assistance', 'Toileting', 'Feeding', 'Comb Hair', 'Oral Hygiene', 'Skin Care', 'Physical Activity'],
  'Companionship': [],
  'Transportation': ['Doctor appointments', 'Grocery shopping', 'Pharmacy visits', 'Hairdresser / barber'],
  'Meal Preparation': ['Breakfast', 'Lunch', 'Snack', 'Dinner'],
  'Light Housekeeping': ['Light housekeeping (dusting, vacuuming, mopping)', 'Change bed linens', 'Change bath towels', 'Take out trash'],
};
const LIFESTYLE_FAVORITES = ['Walk', 'Reading', 'Cooking', 'Gardening', 'Watching TV', 'Socializing', 'Going outside', 'Exercise', 'Hobbies', 'Other'];
const LIFESTYLE_HELP: string[] = [];
const LIFESTYLE_ENTERTAINMENT = ['Music', 'Movies', 'TV Shows', 'Theater', 'Other'];
const VISIT_FREQS = ['Daily', 'Weekly', 'Monthly', 'Occasionally'];
const emptyLifestyleDraft = () => ({ favoriteActivities: [] as string[], favoriteActivitiesOther: '', helpActivities: [] as string[], helpActivitiesOther: '', entertainment: [] as string[], entertainmentOther: '', enjoysConversation: null as boolean | null, prefersQuiet: null as boolean | null, familyInArea: null as boolean | null, familyVisitFreq: '', friendsVisitors: null as boolean | null, friendsVisitFreq: '', hasAppointments: null as boolean | null, appointmentsDetails: '' });

interface Interview {
  id: string;
  caregiverId: string;
  caregiverName: string;
  caregiverPhoto?: string;
  date: string;
  time: string;
  createdAt?: string;
  type: 'video' | 'phone' | 'in-person';
  status: 'pending' | 'accepted' | 'declined' | 'completed' | 'no-response' | 'cancelled';
  notes?: string;
  jobId?: string;
  jobTitle?: string;
}

interface Applicant {
  applicationId: string;
  caregiverId: string;
  caregiverName: string;
  caregiverPhoto?: string;
  rating?: number;
  experience?: number;
  hourlyRate?: number;
  appliedAt: string;
  coverLetter?: string;
}

const TIME_LABELS: Record<string, string> = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
  overnight: 'Overnight',
};

const FREQ_COLORS: Record<string, string> = {
  'occasional': 'bg-violet-50 text-violet-700 border-violet-200',
  'one-time': 'bg-violet-50 text-violet-700 border-violet-200',
  'part-time': 'bg-sky-50 text-sky-700 border-sky-200',
  'full-time': 'bg-teal-50 text-teal-700 border-teal-200',
};

const FREQ_LABELS: Record<string, string> = {
  'occasional': 'Occasional',
  'one-time': 'Occasional',
  'part-time': 'Part-time',
  'full-time': 'Full-time',
};

const pillBtn = (active: boolean) =>
  `px-4 py-1.5 rounded-full text-sm font-semibold border transition-colors ${
    active ? 'bg-primary-50 border-primary-500 text-primary-700' : 'bg-white border-slate-200 text-slate-600 hover:border-primary-300'
  }`;

export const PostsPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { currentUser, addToast } = useCareConnex();
  const { gate, Modals: GateModals } = useAccessGates();
  const handleNewRequest = () => gate('booking', undefined, () => navigate('/client/post-job'));

  const [posts, setPosts] = useState<JobPost[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [applicantCounts, setApplicantCounts] = useState<Record<string, number>>({});
  const [hiredCounts, setHiredCounts] = useState<Record<string, number>>({});
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [panelPostId, setPanelPostId] = useState<string | null>(null);
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [loadingApplicants, setLoadingApplicants] = useState(false);

  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [loadingInterviews, setLoadingInterviews] = useState(true);
  const [submittingDecision, setSubmittingDecision] = useState<Record<string, boolean>>({});
  const [decisionDone, setDecisionDone] = useState<Record<string, 'hired' | 'declined'>>({});
  const [interviewFilter, setInterviewFilter] = useState<'all' | 'pending' | 'accepted' | 'completed' | 'declined' | 'cancelled'>('all');

  const [mainTab, setMainTab] = useState<MainTab>('posts');
  const [postsFilter, setPostsFilter] = useState<PostsFilter>('open');

  // Deep-link from dashboard: ?tab=interviews&filter=pending|accepted|completed
  useEffect(() => {
    const tab = searchParams.get('tab');
    const filter = searchParams.get('filter');
    if (tab === 'interviews') {
      setMainTab('interviews');
      if (filter && ['pending','accepted','completed','declined','cancelled','all'].includes(filter)) {
        setInterviewFilter(filter as any);
      }
      setSearchParams({}, { replace: true });
    }
  }, [searchParams]);

  // Auto-open booking modal when arriving from Re-book on My Care Team
  useEffect(() => {
    const rebookId = searchParams.get('rebook');
    if (!rebookId || loadingInterviews || !interviews.length) return;
    const interview = interviews.find(
      i => i.caregiverId === rebookId && i.status === 'completed'
    );
    if (interview) {
      setMainTab('interviews');
      openSendBookingModal(interview);
    }
    // Clear param so refreshing doesn't re-trigger
    setSearchParams({}, { replace: true });
  }, [searchParams, interviews, loadingInterviews]);

  // Edit post modal
  const [editingPost, setEditingPost] = useState<JobPost | null>(null);

  // Send Booking modal
  const [sendBookingFor, setSendBookingFor] = useState<Interview | null>(null);
  const [sendingBooking, setSendingBooking] = useState(false);
  const [bookingStatuses, setBookingStatuses] = useState<Record<string, { id: string; status: 'pending' | 'accepted' | 'declined' | 'cancelled' }>>({});
  // Set of bookingRequestIds that still have at least one scheduled shift
  const [activeBookingIds, setActiveBookingIds] = useState<Set<string>>(new Set());
  const [loadingCarePlan, setLoadingCarePlan] = useState(false);
  const [loadedPost, setLoadedPost] = useState<any>(null);
  const [loadedPlan, setLoadedPlan] = useState<{
    recipients: Array<{ key: string; name: string; firstName: string; lastName: string; relationship: string; age: string; photoURL: string }>;
    recipientPlans: Record<string, { careNeeds: string[]; careNeedDetails: Record<string, string[]>; locations: any[]; notes: string; lifestyle: any; tasks: any }>;
    emergencyContacts: Array<{ name: string; relation: string; relationship?: string; phone: string; isPrimary?: boolean }>;
    locationPool: any[];
    primaryAddress: string;
  } | null>(null);
  const [bookingDraft, setBookingDraft] = useState<{
    note: string;
    selectedRecipientKeys: string[];
    recipientDrafts: Record<string, { careNeeds: string[]; careNeedDetails: Record<string, string[]>; lifestyle: ReturnType<typeof emptyLifestyleDraft> }>;
    lifestyleNotes: string[];
    selectedAddress: string;
    emergencyContactFirstName: string;
    emergencyContactLastName: string;
    emergencyContactPhone: string;
    emergencyContactRelation: string;
    shiftStartDate: string;
    shiftEndDate: string;
    shiftOngoing: boolean;
    dayShiftTimes: Record<string, Array<{ label: string; start: string; end: string }>>;
    agreedRate: number | null;
    paymentMethod: string;
  }>({ note: '', selectedRecipientKeys: [], recipientDrafts: {}, lifestyleNotes: [], selectedAddress: '', emergencyContactFirstName: '', emergencyContactLastName: '', emergencyContactPhone: '', emergencyContactRelation: '', shiftStartDate: '', shiftEndDate: '', shiftOngoing: false, dayShiftTimes: {}, agreedRate: null, paymentMethod: '' });
  const [editingBookingDetails, setEditingBookingDetails] = useState(false);
  const [scheduleConfirmed, setScheduleConfirmed] = useState(false);
  const [schedulePrePopulated, setSchedulePrePopulated] = useState(false);
  const [cgWeeklyAvail, setCgWeeklyAvail] = useState<Record<string, any[]>>({});
  const [cgBookedSlots, setCgBookedSlots] = useState<Record<string, Array<{s:number;e:number}>>>({});

  const LS_IVS_KEY = 'careconnex.posts.lastCheckedInterviews';
  const MIN_VALID_TS = new Date('2024-01-01').getTime();
  const [lastCheckedIvs, setLastCheckedIvs] = useState<number>(() => {
    const v = localStorage.getItem(LS_IVS_KEY);
    const parsed = v ? parseInt(v, 10) : 0;
    if (parsed > MIN_VALID_TS) return parsed;
    const now = Date.now();
    localStorage.setItem(LS_IVS_KEY, String(now));
    return now;
  });

  const LS_FILTER_KEY = (f: string) => `careconnex.posts.lastChecked.${f}`;
  const [lastCheckedFilter, setLastCheckedFilter] = useState<Record<string, number>>(() => {
    const now = Date.now();
    const result: Record<string, number> = {};
    (['pending', 'accepted', 'completed', 'declined', 'cancelled'] as const).forEach(f => {
      const v = localStorage.getItem(`careconnex.posts.lastChecked.${f}`);
      const parsed = v ? parseInt(v, 10) : 0;
      if (parsed > MIN_VALID_TS) { result[f] = parsed; }
      else { localStorage.setItem(`careconnex.posts.lastChecked.${f}`, String(now)); result[f] = now; }
    });
    return result;
  });

  // Schedule interview modal (from applicants panel)
  const [schedulingFor, setSchedulingFor] = useState<Applicant | null>(null);
  const [decliningApplicant, setDecliningApplicant] = useState<string | null>(null);

  // Load posts
  useEffect(() => {
    if (!currentUser?.uid) { setLoadingPosts(false); return; }
    let cancelled = false;
    setLoadingPosts(true);
    dbService.getJobPostsByClient(currentUser.uid)
      .then(list => { if (!cancelled) setPosts(list); })
      .catch(() => addToast('Could not load your posts', 'error'))
      .finally(() => { if (!cancelled) setLoadingPosts(false); });
    return () => { cancelled = true; };
  }, [currentUser?.uid]);

  // Count applicants per post
  useEffect(() => {
    if (!db || posts.length === 0) return;
    let cancelled = false;
    (async () => {
      const uid = currentUser?.uid;
      const [applicantEntries, hiredEntries] = await Promise.all([
        Promise.all(posts.map(async p => {
          try {
            const snap = await db!.collection('job_applications')
              .where('jobId', '==', p.id)
              .where('clientId', '==', uid)
              .where('status', '==', 'pending')
              .get();
            return [p.id, snap.size] as const;
          } catch {
            return [p.id, (p as any).applicantCount || 0] as const;
          }
        })),
        Promise.all(posts.map(async p => {
          try {
            const snap = await db!.collection('booking_requests')
              .where('jobId', '==', p.id)
              .where('clientId', '==', uid)
              .where('status', '==', 'accepted')
              .get();
            return [p.id, snap.size] as const;
          } catch {
            return [p.id, 0] as const;
          }
        })),
      ]);
      if (!cancelled) {
        setApplicantCounts(Object.fromEntries(applicantEntries));
        setHiredCounts(Object.fromEntries(hiredEntries));
      }
    })();
    return () => { cancelled = true; };
  }, [posts]);

  // Load interviews (real-time)
  useEffect(() => {
    if (!currentUser?.uid || !db) { setLoadingInterviews(false); return; }
    const unsub = db.collection('video_interviews')
      .where('clientId', '==', currentUser.uid)
      .onSnapshot(snap => {
        const mapped = snap.docs.map(doc => {
          const d = doc.data();
          const dt = d.scheduledTime ? new Date(d.scheduledTime) : new Date();
          const localDateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
          const localTimeStr = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
          const rawCreatedAt = d.createdAt;
          const createdAt = rawCreatedAt?.toDate ? rawCreatedAt.toDate().toISOString() : (typeof rawCreatedAt === 'string' ? rawCreatedAt : '');
          return {
            id: doc.id,
            caregiverId: d.caregiverId || '',
            caregiverName: d.caregiverName || '',
            caregiverPhoto: d.caregiverPhoto || '',
            date: localDateStr,
            time: localTimeStr,
            createdAt,
            type: (d.interviewType || d.type) as Interview['type'] || 'video',
            status: d.status === 'requested' ? 'pending' : (d.status as Interview['status']),
            notes: d.notes || undefined,
            jobId: d.jobId || undefined,
            jobTitle: d.jobTitle || undefined,
          };
        });
        const statusOrder: Record<string, number> = { pending: 0, accepted: 1, confirmed: 2, completed: 3, declined: 4, cancelled: 5 };
        const activeStatuses = new Set(['pending', 'accepted', 'confirmed']);
        mapped.sort((a, b) => {
          const so = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
          if (so !== 0) return so;
          const aTime = new Date(a.date + 'T' + a.time).getTime();
          const bTime = new Date(b.date + 'T' + b.time).getTime();
          // Active interviews: soonest first; resolved: most recent first
          return activeStatuses.has(a.status) ? aTime - bTime : bTime - aTime;
        });
        // Back-fill photos for interviews that don't have one stored
        const missing = mapped.filter(i => !i.caregiverPhoto && i.caregiverId);
        if (missing.length > 0 && db) {
          const uniqueIds = [...new Set(missing.map(i => i.caregiverId))];
          Promise.all(uniqueIds.map(async id => {
            const cSnap = await db!.collection('caregivers').doc(id).get().catch(() => null);
            if (cSnap?.exists) { const d = cSnap.data() as any; return [id, d.photoURL || d.photo || d.imageUrl || '']; }
            const uSnap = await db!.collection('users').doc(id).get().catch(() => null);
            if (uSnap?.exists) { const d = uSnap.data() as any; return [id, d.photoURL || d.photo || d.imageUrl || '']; }
            return [id, ''];
          })).then(entries => {
            const photoMap = Object.fromEntries(entries as [string, string][]);
            setInterviews(prev => prev.map(i => i.caregiverPhoto ? i : { ...i, caregiverPhoto: photoMap[i.caregiverId] || '' }));
          });
        }
        setInterviews(mapped);
        setLoadingInterviews(false);
      }, () => setLoadingInterviews(false));
    return () => unsub();
  }, [currentUser?.uid]);

  const { openPosts, closedPosts } = useMemo(() => ({
    openPosts: posts.filter(p => p.status === 'open'),
    closedPosts: posts.filter(p => p.status !== 'open'),
  }), [posts]);

  const visiblePosts = postsFilter === 'open' ? openPosts : closedPosts;

  const openApplicantsPanel = async (postId: string) => {
    if (!currentUser?.uid) return;
    setPanelPostId(postId);
    setApplicants([]);
    if (!db) return;
    setLoadingApplicants(true);
    try {
      // clientId filter satisfies the Firestore security rule for collection queries
      const snap = await db.collection('job_applications')
        .where('jobId', '==', postId)
        .where('clientId', '==', currentUser.uid)
        .where('status', '==', 'pending')
        .get();
      const results = await Promise.all(snap.docs.map(async doc => {
        const d = doc.data();
        // Normalize Firestore Timestamp → ISO string
        const rawDate = d.appliedAt || d.createdAt;
        const appliedAt = rawDate?.toDate ? rawDate.toDate().toISOString() : (rawDate || '');
        try {
          // Try caregivers collection first, then users
          let cData: any = null;
          const cSnap = await db!.collection('caregivers').doc(d.caregiverId).get();
          if (cSnap.exists) {
            cData = cSnap.data();
          } else {
            const uSnap = await db!.collection('users').doc(d.caregiverId).get();
            if (uSnap.exists) cData = uSnap.data();
          }
          const c = cData || {};
          return {
            applicationId: doc.id,
            caregiverId: d.caregiverId,
            caregiverName: d.caregiverName || c.name || c.displayName || `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Caregiver',
            caregiverPhoto: d.caregiverPhoto || c.photoURL || c.imageUrl || c.photo || '',
            rating: c.rating || c.averageRating || d.caregiverRating || 5.0,
            experience: c.experience || (c.yearsExperience ?? d.caregiverExperience),
            hourlyRate: c.hourlyRate ?? c.rate ?? d.caregiverRate,
            appliedAt,
            coverLetter: d.coverLetter || '',
          } as Applicant;
        } catch {
          return { applicationId: doc.id, caregiverId: d.caregiverId, caregiverName: d.caregiverName || 'Caregiver', appliedAt } as Applicant;
        }
      }));
      setApplicants(results);
    } catch (err: any) {
      addToast('Could not load applicants', 'error');
      console.error('openApplicantsPanel error:', err);
    } finally {
      setLoadingApplicants(false);
    }
  };

  const handleCancelPost = async (postId: string) => {
    if (!currentUser?.uid) return;
    setOpenMenuId(null);
    if (!window.confirm('Cancel this job post? Caregivers will no longer be able to apply.')) return;
    try {
      await dbService.cancelJobPost(postId, currentUser.uid);
      setPosts(prev => prev.map(p => p.id === postId ? { ...p, status: 'cancelled' } : p));
      addToast('Job post cancelled', 'info');
    } catch (err: any) {
      addToast(err?.message || 'Failed to cancel post', 'error');
    }
  };

  const openEditModal = (post: JobPost) => {
    setOpenMenuId(null);
    setEditingPost(post);
  };

  const handleDeclineApplicant = async (applicant: Applicant) => {
    if (!db || !currentUser?.uid) return;
    setDecliningApplicant(applicant.caregiverId);
    try {
      await db.collection('job_applications').doc(applicant.applicationId).update({
        status: 'rejected',
        declinedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      setApplicants(prev => prev.filter(a => a.caregiverId !== applicant.caregiverId));
      addToast('Applicant declined', 'info');
    } catch {
      addToast('Failed to decline applicant', 'error');
    } finally {
      setDecliningApplicant(null);
    }
  };

  const handleMarkInterviewComplete = async (interviewId: string) => {
    if (!db) return;
    try {
      await db.collection('video_interviews').doc(interviewId).update({
        status: 'completed',
        completedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      setInterviews(prev => prev.map(i => i.id === interviewId ? { ...i, status: 'completed' } : i));
    } catch { addToast('Failed to update interview', 'error'); }
  };

  const handleCancelInterview = async (interviewId: string) => {
    if (!window.confirm('Cancel this interview?') || !db) return;
    try {
      await db.collection('video_interviews').doc(interviewId).update({
        status: 'cancelled',
        cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      setInterviews(prev => prev.map(i => i.id === interviewId ? { ...i, status: 'cancelled' } : i));
    } catch { addToast('Failed to cancel interview', 'error'); }
  };

  // Real-time booking request statuses for this client
  useEffect(() => {
    if (!currentUser?.uid || !db) return;
    const unsub = db.collection('booking_requests')
      .where('clientId', '==', currentUser.uid)
      .onSnapshot(snap => {
        const STATUS_PRIORITY: Record<string, number> = { accepted: 4, pending: 3, declined: 2, cancelled: 1 };
        const map: Record<string, { id: string; status: 'pending' | 'accepted' | 'declined' | 'cancelled' }> = {};
        snap.docs.forEach(d => {
          const data = d.data();
          const key = `${data.caregiverId}_${data.jobId || data.interviewId || ''}`;
          const existing = map[key];
          const newPriority = STATUS_PRIORITY[data.status] ?? 0;
          const existingPriority = existing ? (STATUS_PRIORITY[existing.status] ?? 0) : -1;
          if (newPriority > existingPriority) {
            map[key] = { id: d.id, status: data.status };
          }
        });
        setBookingStatuses(map);
      }, () => {});
    return () => unsub();
  }, [currentUser?.uid]);

  // Track which bookings still have at least one scheduled shift (for Re-book button)
  useEffect(() => {
    if (!currentUser?.uid || !db) return;
    const unsub = db.collection('shifts')
      .where('clientId', '==', currentUser.uid)
      .where('status', '==', 'scheduled')
      .onSnapshot(snap => {
        const ids = new Set<string>();
        snap.docs.forEach(d => {
          const bid = d.data().bookingRequestId;
          if (bid) ids.add(bid);
        });
        setActiveBookingIds(ids);
      }, () => {});
    return () => unsub();
  }, [currentUser?.uid]);

  const getRecipientKey = (firstName: string, lastName: string) =>
    `${firstName.toLowerCase()}_${(lastName || 'noname').toLowerCase()}`
      .replace(/\s+/g, '_')
      .replace(/[~*/\[\].]/g, '');

  const openSendBookingModal = async (interview: Interview) => {
    setSendBookingFor(interview);
    setLoadingCarePlan(true);
    setLoadedPlan(null);
    setLoadedPost(null);
    setEditingBookingDetails(false);
    setScheduleConfirmed(false);
    setSchedulePrePopulated(false);
    setCgWeeklyAvail({});
    setCgBookedSlots({});
    setBookingDraft({ note: '', selectedRecipientKeys: [], recipientDrafts: {}, lifestyleNotes: [], selectedAddress: '', emergencyContactFirstName: '', emergencyContactLastName: '', emergencyContactPhone: '', emergencyContactRelation: '', shiftStartDate: '', shiftEndDate: '', shiftOngoing: true, dayShiftTimes: {}, agreedRate: null, paymentMethod: '' });
    if (!currentUser?.uid || !db) { setLoadingCarePlan(false); return; }
    try {
      // Only pre-fill from a previous booking when it's a genuine resend (declined/cancelled)
      const existingBookingStatus = bookingStatuses[`${interview.caregiverId}_${interview.jobId || interview.id}`];
      const isResendEligible = existingBookingStatus?.status === 'declined' || existingBookingStatus?.status === 'cancelled';
      const existingBookingId = isResendEligible ? existingBookingStatus?.id : undefined;
      const [cpSnap, jpSnap, freshPostSnap, prevBookingSnap] = await Promise.all([
        db.collection('carePlans').doc(currentUser.uid).get().catch(() => null),
        db.collection('job_postings').doc(currentUser.uid).get().catch(() => null),
        interview.jobId ? db.collection('job_posts').doc(interview.jobId).get().catch(() => null) : Promise.resolve(null),
        existingBookingId
          ? db.collection('booking_requests').doc(existingBookingId).get().catch(() => null)
          : Promise.resolve(null),
      ]);
      const cp = (cpSnap?.data() as any) || {};
      const jp = (jpSnap?.data() as any) || {};

      // Build recipient list from job_postings (deduplicated)
      const recipients: typeof loadedPlan extends null ? never : NonNullable<typeof loadedPlan>['recipients'] = [];
      const seenRecipientKeys = new Set<string>();
      if (jp.careRecipientFirstName) {
        const firstName = jp.careRecipientFirstName;
        const lastName = jp.careRecipientLastName || '';
        const key = getRecipientKey(firstName, lastName);
        seenRecipientKeys.add(key);
        recipients.push({ key, firstName, lastName, name: `${firstName} ${lastName}`.trim(), relationship: jp.relationship || '', age: jp.careRecipientAge || '', photoURL: jp.careRecipientPhotoURL || '' });
      }
      (jp.additionalRecipients || []).forEach((r: any) => {
        const firstName = (r.firstName || '').trim();
        const lastName = (r.lastName || '').trim();
        if (!firstName) return;
        const key = getRecipientKey(firstName, lastName);
        if (seenRecipientKeys.has(key)) return;
        seenRecipientKeys.add(key);
        recipients.push({ key, firstName, lastName, name: `${firstName} ${lastName}`.trim(), relationship: r.relationship || '', age: r.age || '', photoURL: r.photoURL || '' });
      });

      const recipientPlans = cp.recipientPlans || {};
      // carePlans/{uid}.emergencyContacts is the single source of truth
      const emergencyContacts: any[] = cp.emergencyContacts || [];
      const primaryContact = emergencyContacts.find((c: any) => c.isPrimary) || emergencyContacts[0];
      const primaryAddress = jp.street ? [jp.street, jp.city, jp.state, jp.zipCode].filter(Boolean).join(', ') : '';

      // Inject profile photo into any "myself" recipient
      let profilePhotoURL: string | null = auth?.currentUser?.photoURL || null;
      if (!profilePhotoURL) {
        const uSnap = await db.collection('users').doc(currentUser.uid).get().catch(() => null);
        const uData = uSnap?.data() as any;
        profilePhotoURL = uData?.photoURL || uData?.photo || uData?.profilePhoto || uData?.imageUrl || null;
      }
      if (profilePhotoURL) {
        recipients.forEach(r => {
          if (r.relationship?.toLowerCase() === 'myself') r.photoURL = profilePhotoURL!;
        });
      }

      const plan = {
        recipients,
        recipientPlans,
        emergencyContacts,
        locationPool: cp.locationPool || [],
        primaryAddress,
      };
      setLoadedPlan(plan);

      // Pre-select recipients up to the post's recipientsCount limit
      const post = interview.jobId ? posts.find(p => p.id === interview.jobId) : undefined;
      const limit = post?.recipientsCount ?? recipients.length;
      const allKeys = recipients.slice(0, limit).map(r => r.key);
      // Build per-recipient drafts from stored plan data
      const recipientDrafts: Record<string, { careNeeds: string[]; careNeedDetails: Record<string, string[]>; lifestyle: ReturnType<typeof emptyLifestyleDraft> }> = {};
      recipients.forEach(r => {
        const rp = (recipientPlans as any)[r.key];
        const ls = rp?.lifestyle || {};
        recipientDrafts[r.key] = {
          careNeeds: rp?.careNeeds || [],
          careNeedDetails: rp?.careNeedDetails || {},
          lifestyle: {
            favoriteActivities: ls.favoriteActivities || [],
            favoriteActivitiesOther: ls.favoriteActivitiesOther || '',
            helpActivities: ls.helpActivities || [],
            helpActivitiesOther: ls.helpActivitiesOther || '',
            entertainment: ls.entertainment || [],
            entertainmentOther: ls.entertainmentOther || '',
            enjoysConversation: ls.enjoysConversation ?? null,
            prefersQuiet: ls.prefersQuiet ?? null,
            familyInArea: ls.familyInArea ?? null,
            familyVisitFreq: ls.familyVisitFreq || '',
            friendsVisitors: ls.friendsVisitors ?? null,
            friendsVisitFreq: ls.friendsVisitFreq || '',
            hasAppointments: ls.hasAppointments ?? null,
            appointmentsDetails: ls.appointmentsDetails || '',
          },
        };
      });

      // Lifestyle notes (pets/smoking) from the primary address in locationPool
      const lifestyleNotes: string[] = [];
      (cp.locationPool || []).forEach((loc: any) => {
        if (loc.petsInHome && !lifestyleNotes.includes('Pets in home')) lifestyleNotes.push('Pets in home');
        if (loc.smokingHousehold && !lifestyleNotes.includes('Smoking household')) lifestyleNotes.push('Smoking household');
      });

      // Parse first/last from stored contact name
      const nameParts = (primaryContact?.name || '').trim().split(/\s+/);
      const ecFirst = nameParts[0] || '';
      const ecLast = nameParts.slice(1).join(' ');

      // Fresh post from Firestore — always current, never stale
      const freshPost = freshPostSnap?.exists ? { id: freshPostSnap.id, ...freshPostSnap.data() as any } : undefined;
      const postForDraft = freshPost || (interview.jobId ? posts.find(p => p.id === interview.jobId) : undefined);
      if (freshPost) setLoadedPost(freshPost);

      // Pre-populate from the existing booking (direct doc fetch or query result)
      const prevBookingData: any = (prevBookingSnap as any)?.data
        ? (prevBookingSnap as any).data()        // direct doc get()
        : (prevBookingSnap as any)?.docs?.[0]?.data(); // legacy query fallback
      const prevSchedule = prevBookingData?.schedule;
      const prevDayShiftTimes = prevSchedule?.dayShiftTimes && Object.keys(prevSchedule.dayShiftTimes).length > 0
        ? prevSchedule.dayShiftTimes
        : null;

      setBookingDraft({
        selectedRecipientKeys: allKeys,
        recipientDrafts,
        emergencyContactFirstName: ecFirst,
        emergencyContactLastName: ecLast,
        emergencyContactPhone: primaryContact?.phone || '',
        emergencyContactRelation: primaryContact?.relation || primaryContact?.relationship || '',
        shiftStartDate: prevSchedule?.startDate || postForDraft?.startDate || (postForDraft as any)?.date || '',
        shiftEndDate: prevSchedule?.ongoing ? '' : (prevSchedule?.endDate || postForDraft?.endDate || ''),
        shiftOngoing: prevSchedule?.endDate ? false : true,
        dayShiftTimes: prevDayShiftTimes ?? Object.fromEntries(
          (postForDraft?.daysOfWeek || []).map((day: string) => {
            const normalized = day.trim().charAt(0).toUpperCase() + day.trim().slice(1, 3).toLowerCase();
            return [normalized, [{ label: '', start: '', end: '' }]];
          })
        ),
        agreedRate: prevBookingData?.rate ?? null,
        paymentMethod: (() => {
          const raw = (prevBookingData?.paymentMethod || (postForDraft as any)?.paymentMethod || '').toLowerCase();
          return raw === 'cash' ? 'cash' : raw === 'card' || raw === 'credit' ? 'credit' : '';
        })(),
        selectedAddress: prevBookingData?.address || '',
        note: prevBookingData?.notes || '',
        lifestyleNotes: prevBookingData?.lifestylePreferences || lifestyleNotes,
      });
      if (prevDayShiftTimes) { setSchedulePrePopulated(true); setScheduleConfirmed(true); }

      // Load caregiver's weeklyAvailability + booked slots from lightweight summary doc
      try {
        const [cgSnap, bookedSnap] = await Promise.all([
          db.collection('caregivers').doc(interview.caregiverId).get(),
          db.collection('caregiver_booked_slots').doc(interview.caregiverId).get().catch(() => null),
        ]);
        if (cgSnap.exists) setCgWeeklyAvail((cgSnap.data() as any)?.weeklyAvailability || {});
        if (bookedSnap?.exists) setCgBookedSlots((bookedSnap.data() as any)?.slots || {});
      } catch { /* non-fatal */ }
    } catch (e) { console.error('openSendBookingModal error', e); }
    finally { setLoadingCarePlan(false); }
  };

  const handleSendBooking = async (interview: Interview, _unused: string) => {
    const user = auth?.currentUser;
    if (!user || !db) return;
    const fdb = db;
    gate('booking', interview.caregiverName, async () => {
    setSendingBooking(true);
    try {
      const post = interview.jobId ? posts.find(p => p.id === interview.jobId) : undefined;
      const key = `${interview.caregiverId}_${interview.jobId || interview.id}`;
      const existing = bookingStatuses[key];
      const isResend = existing?.status === 'declined' || existing?.status === 'cancelled';

      // Block duplicate bookings — never create a second doc when one is already active.
      // Exception: if all shifts are completed/cancelled the booking is effectively done
      // and a fresh re-booking should be allowed.
      // Use the in-memory activeBookingIds set (kept in sync via real-time listener)
      // instead of a raw shifts query — the query would be rejected by Firestore rules
      // because it doesn't include clientId/caregiverId in the filter.
      if (existing?.status === 'accepted') {
        if (activeBookingIds.has(existing.id)) {
          addToast('You already have an active booking with this caregiver.', 'info');
          setSendingBooking(false);
          return;
        }
        // Not in activeBookingIds — all shifts done, fall through to create a fresh one
      }
      if (existing?.status === 'pending') {
        addToast('Your booking request is already pending a response.', 'info');
        setSendingBooking(false);
        return;
      }

      // Prefer Auth photo; fall back to Firestore users document
      let clientPhotoURL: string | null = user.photoURL || null;
      if (!clientPhotoURL) {
        const uSnap = await fdb.collection('users').doc(user.uid).get().catch(() => null);
        const uData = uSnap?.data() as any;
        clientPhotoURL = uData?.photoURL || uData?.photo || uData?.profilePhoto || uData?.imageUrl || null;
      }

      // Build full recipient details for the booking request
      const selectedRecipients = (loadedPlan?.recipients || [])
        .filter(r => bookingDraft.selectedRecipientKeys.includes(r.key))
        .map(r => {
          const draft = bookingDraft.recipientDrafts[r.key];
          const plan = loadedPlan?.recipientPlans[r.key];
          return {
            name: r.name, relationship: r.relationship, age: r.age,
            photoURL: r.relationship?.toLowerCase() === 'myself' ? (clientPhotoURL || r.photoURL) : r.photoURL,
            careNeeds: draft?.careNeeds || plan?.careNeeds || [],
            careNeedDetails: draft?.careNeedDetails || plan?.careNeedDetails || {},
            lifestyle: draft?.lifestyle || null,
            tasks: plan?.tasks || {},
            locations: plan?.locations || [],
            notes: plan?.notes || '',
          };
        });

      const bookingData = {
        clientId: user.uid,
        clientName: user.displayName || '',
        clientPhotoURL,
        caregiverId: interview.caregiverId,
        caregiverName: interview.caregiverName,
        caregiverPhotoURL: interview.caregiverPhoto || null,
        jobId: interview.jobId || null,
        jobTitle: interview.jobTitle || post?.title || '',
        address: bookingDraft.selectedAddress || loadedPlan?.primaryAddress || (post ? [post.city, post.state, post.zipCode].filter(Boolean).join(', ') : ''),
        rate: bookingDraft.agreedRate ?? post?.rate ?? null,
        paymentMethod: (() => {
          const raw = (bookingDraft.paymentMethod || (post as any)?.paymentMethod || '').toLowerCase();
          return raw === 'cash' ? 'cash' : raw ? 'credit' : null;
        })(),
        careNeeds: [...new Set(Object.values(bookingDraft.recipientDrafts).flatMap(rd => rd.careNeeds))],
        careRecipients: selectedRecipients,
        lifestylePreferences: bookingDraft.lifestyleNotes,
        emergencyContact: (bookingDraft.emergencyContactFirstName || bookingDraft.emergencyContactPhone) ? {
          name: [bookingDraft.emergencyContactFirstName, bookingDraft.emergencyContactLastName].filter(Boolean).join(' '),
          phone: bookingDraft.emergencyContactPhone,
          relationship: bookingDraft.emergencyContactRelation,
        } : null,
        schedule: (() => {
          const DAY_ORDER = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
          const normDay = (d: string) => d.trim().charAt(0).toUpperCase() + d.trim().slice(1,3).toLowerCase();
          const normalizedDST = Object.fromEntries(
            Object.entries(bookingDraft.dayShiftTimes).map(([k, v]) => [normDay(k), v])
          );
          return {
            days: Object.keys(normalizedDST).length > 0
              ? Object.keys(normalizedDST).sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b))
              : (post?.daysOfWeek || []).map(normDay),
            startDate: bookingDraft.shiftStartDate || post?.startDate || (post as any)?.date || null,
            endDate: bookingDraft.shiftOngoing ? null : (bookingDraft.shiftEndDate || post?.endDate || null),
            ongoing: bookingDraft.shiftOngoing,
            dayShiftTimes: normalizedDST,
          };
        })(),
        notes: bookingDraft.note.trim() || null,
        interviewId: interview.id,
      };

      if (isResend && existing) {
        await fdb.collection('booking_requests').doc(existing.id).update({
          ...bookingData,
          status: 'pending',
          isResend: true,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        await fdb.collection('booking_requests').add({
          ...bookingData,
          status: 'pending',
          isResend: false,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        await fdb.collection('hire_decisions').add({
          clientId: user.uid,
          clientName: user.displayName || '',
          caregiverId: interview.caregiverId,
          caregiverName: interview.caregiverName,
          decision: 'hire',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });

        // Mark the caregiver's application as accepted
        if (interview.jobId) {
          try {
            const appSnap = await fdb.collection('job_applications')
              .where('caregiverId', '==', interview.caregiverId)
              .where('jobId', '==', interview.jobId)
              .limit(1)
              .get();
            if (!appSnap.empty) {
              await appSnap.docs[0].ref.update({
                status: 'accepted',
                acceptedAt: firebase.firestore.FieldValue.serverTimestamp(),
              });
            }
          } catch { /* non-critical */ }
        }
      }

      // Notification handled by onBookingRequestWrite Cloud Function

      setSendBookingFor(null);
      setBookingDraft({ note: '', selectedRecipientKeys: [], recipientDrafts: {}, lifestyleNotes: [], selectedAddress: '', emergencyContactFirstName: '', emergencyContactLastName: '', emergencyContactPhone: '', emergencyContactRelation: '', shiftStartDate: '', shiftEndDate: '', shiftOngoing: false, dayShiftTimes: {}, agreedRate: null, paymentMethod: '' });
      addToast(isResend ? 'Booking request resent!' : 'Booking request sent!', 'success');
    } catch (err: any) {
      console.error('handleSendBooking error:', err);
      addToast('Something went wrong. Please try again.', 'error');
    } finally {
      setSendingBooking(false);
    }
    }); // end gate callback
  };

  const handleCancelBooking = async (bookingId: string) => {
    if (!db) return;
    try {
      const bookingSnap = await db.collection('booking_requests').doc(bookingId).get();
      const bookingData = bookingSnap.data();
      await db.collection('booking_requests').doc(bookingId).update({ status: 'cancelled' });
      if (bookingData?.caregiverId) {
        try {
          const clientName = auth?.currentUser?.displayName || 'A family';
          await db.collection('users').doc(bookingData.caregiverId).collection('notifications').add({
            userId: bookingData.caregiverId,
            type: 'booking_cancelled',
            title: 'Booking Request Cancelled',
            body: `${clientName} cancelled their booking request.`,
            isRead: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
        } catch { /* non-critical */ }
      }
      addToast('Booking request cancelled.', 'success');
    } catch (err) {
      console.error('handleCancelBooking error:', err);
      addToast('Something went wrong. Please try again.', 'error');
    }
  };

  const handleDecision = async (interview: Interview, decision: 'hire' | 'decline') => {
    const user = auth?.currentUser;
    if (!user || !db) return;
    setSubmittingDecision(prev => ({ ...prev, [interview.id]: true }));
    try {
      if (decision === 'decline') {
        await db.collection('video_interviews').doc(interview.id).update({ status: 'declined', declinedBy: 'client' });
      }
      await db.collection('hire_decisions').add({
        clientId: user.uid,
        clientName: user.displayName || '',
        caregiverId: interview.caregiverId,
        caregiverName: interview.caregiverName,
        decision,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      // Notification handled by onVideoInterviewWrite Cloud Function (decline) /
      // onBookingRequestWrite Cloud Function (hire)
      setDecisionDone(prev => ({ ...prev, [interview.id]: decision === 'hire' ? 'hired' : 'declined' }));
      addToast(decision === 'hire' ? 'Booking request sent!' : 'Caregiver notified', 'success');
    } catch (err: any) { console.error('handleDecision error:', err?.code, err?.message, err); addToast('Something went wrong. Please try again.', 'error'); }
    finally { setSubmittingDecision(prev => ({ ...prev, [interview.id]: false })); }
  };

  const formatLocation = (p: JobPost) => {
    const parts = [p.city, p.state, p.zipCode].filter(Boolean);
    return parts.length ? parts.join(', ') : p.location || '—';
  };
  const formatRate = (p: JobPost) => p.rateFlexible || !p.rate ? 'Rate flexible' : `$${p.rate}/hr`;

  const interviewStatusStyle = (status: Interview['status']) => {
    switch (status) {
      case 'accepted': return 'bg-green-100 text-green-700 border-green-200';
      case 'pending': return 'bg-amber-100 text-amber-700 border-amber-200';
      case 'declined': return 'bg-red-100 text-red-700 border-red-200';
      case 'completed': return 'bg-blue-100 text-blue-700 border-blue-200';
      default: return 'bg-slate-100 text-slate-600 border-slate-200';
    }
  };

  const typeIcon = (type: Interview['type']) =>
    type === 'phone' ? <Phone className="w-3.5 h-3.5" /> : type === 'in-person' ? <MapPin className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />;

  return (
    <div className="min-h-screen bg-slate-50">
      <GateModals />
      <ClientNavigation />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900">Care Requests</h1>
          <button
            onClick={handleNewRequest}
            className="flex items-center gap-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold px-4 py-2 rounded-lg shadow-sm transition-colors"
          >
            <Plus className="w-4 h-4" /> New Request
          </button>
        </div>

        {/* Main tabs */}
        {(() => {
          const newIvs = interviews.filter(iv => {
            const ms = iv.createdAt ? new Date(iv.createdAt).getTime() : 0;
            return ms > lastCheckedIvs;
          }).length;
          const markIvs = () => {
            const now = Date.now();
            localStorage.setItem(LS_IVS_KEY, String(now));
            setLastCheckedIvs(now);
            setMainTab('interviews');
          };
          return (
            <div className="flex items-center gap-2 mb-6">
              <button
                onClick={() => setMainTab('posts')}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors ${mainTab === 'posts' ? 'bg-primary-500 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
              >
                Posts
              </button>
              <button
                onClick={markIvs}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors ${mainTab === 'interviews' ? 'bg-primary-500 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
              >
                Interviews
                {newIvs > 0 && mainTab !== 'interviews' && (
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">{newIvs}</span>
                )}
              </button>
            </div>
          );
        })()}

        {/* ── POSTS TAB ── */}
        {mainTab === 'posts' && (
          <>
            <div className="flex gap-2 mb-5">
              <button onClick={() => setPostsFilter('open')} className={pillBtn(postsFilter === 'open')}>Open ({openPosts.length})</button>
              <button onClick={() => setPostsFilter('closed')} className={pillBtn(postsFilter === 'closed')}>Closed ({closedPosts.length})</button>
            </div>

            {loadingPosts ? (
              <div className="py-16 flex items-center justify-center text-slate-400">
                <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading posts...
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {postsFilter === 'open' && (
                  <button
                    onClick={handleNewRequest}
                    className="flex flex-col items-center justify-center text-center border-2 border-dashed border-slate-300 rounded-2xl px-4 py-10 bg-white hover:border-primary-400 hover:bg-primary-50/30 transition-colors min-h-[180px]"
                  >
                    <Briefcase className="w-8 h-8 text-slate-300 mb-2" />
                    <p className="text-sm text-slate-500 mb-4">Post for a specific date or recurring needs</p>
                    <span className="inline-flex items-center gap-1.5 text-primary-600 font-semibold text-sm"><Plus className="w-4 h-4" /> New Request</span>
                  </button>
                )}

                {visiblePosts.length === 0 && postsFilter === 'closed' && (
                  <div className="md:col-span-2 text-center py-14 bg-white border border-slate-200 rounded-2xl">
                    <Briefcase className="w-10 h-10 text-slate-200 mx-auto mb-2" />
                    <p className="text-slate-400">No closed posts yet.</p>
                  </div>
                )}

                {visiblePosts.map(post => {
                  const count = applicantCounts[post.id] ?? 0;
                  const hired = hiredCounts[post.id] ?? 0;
                  const caregiversNeeded = (post as any).caregiversNeeded || 1;
                  const freq = (post as any).jobFrequency as string | undefined;
                  const days = post.daysOfWeek || [];
                  const times = post.timeOfDay || [];
                  const careTypes = post.careTypes || (post as any).requirements || [];

                  return (
                    <div key={post.id} className="relative bg-white border border-slate-200 rounded-2xl p-5 shadow-sm" onClick={() => setOpenMenuId(null)}>
                      {/* Title row */}
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            {freq && (
                              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${FREQ_COLORS[freq] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                                {FREQ_LABELS[freq] || freq}
                              </span>
                            )}
                            {post.status !== 'open' && (
                              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${
                                post.status === 'filled' ? 'bg-primary-50 text-primary-700 border border-primary-200' : 'bg-slate-100 text-slate-500'
                              }`}>{post.status}</span>
                            )}
                            {caregiversNeeded > 0 && (
                              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                                hired >= caregiversNeeded
                                  ? 'bg-green-50 text-green-700 border-green-200'
                                  : hired > 0
                                  ? 'bg-amber-50 text-amber-700 border-amber-200'
                                  : 'bg-slate-50 text-slate-600 border-slate-200'
                              }`}>
                                {hired} of {caregiversNeeded} hired
                              </span>
                            )}
                          </div>
                          <h3 className="font-bold text-slate-900 text-base leading-snug">{post.title}</h3>
                        </div>
                        {post.status === 'open' && (
                          <div className="relative shrink-0" onClick={e => e.stopPropagation()}>
                            <button
                              onClick={() => setOpenMenuId(openMenuId === post.id ? null : post.id)}
                              className="w-7 h-7 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400"
                            >
                              <MoreHorizontal className="w-4 h-4" />
                            </button>
                            {openMenuId === post.id && (
                              <div className="absolute right-0 mt-1 w-44 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-10">
                                <button onClick={() => openEditModal(post)} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                                  <Edit2 className="w-3.5 h-3.5 text-slate-400" /> Edit post
                                </button>
                                <div className="h-px bg-slate-100 mx-2" />
                                <button onClick={() => handleCancelPost(post.id)} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50">
                                  <XCircle className="w-3.5 h-3.5" /> Cancel post
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Date / location / rate */}
                      <div className="space-y-1.5 text-sm text-slate-600 mb-3">
                        {(post.startDate || post.date) && (
                          <p className="flex items-center gap-1.5">
                            <Calendar className="w-3.5 h-3.5 text-slate-400" />
                            {(() => {
                              const fmtDate = (s: string) => {
                                const parts = s.split('-');
                                if (parts.length !== 3) return s;
                                const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
                                return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                              };
                              const start = fmtDate(post.startDate || post.date);
                              return post.endDate ? `${start} → ${fmtDate(post.endDate)}` : start;
                            })()}
                          </p>
                        )}
                        <p className="flex items-center gap-1.5">
                          <MapPin className="w-3.5 h-3.5 text-slate-400" /> {formatLocation(post)}
                        </p>
                        <p className="text-primary-700 font-semibold">{formatRate(post)}</p>
                      </div>

                      {/* Days + time of day chips */}
                      {(days.length > 0 || times.length > 0) && (
                        <div className="flex flex-wrap gap-1.5 mb-3">
                          {days.map(d => (
                            <span key={d} className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{d}</span>
                          ))}
                          {times.map(t => (
                            <span key={t} className="text-xs bg-primary-50 text-primary-600 px-2 py-0.5 rounded-full">{TIME_LABELS[t] || t}</span>
                          ))}
                        </div>
                      )}

                      {/* Care types */}
                      {careTypes.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-3">
                          {(careTypes as string[]).slice(0, 3).map(ct => (
                            <span key={ct} className="text-xs bg-blue-50 text-blue-700 border border-blue-100 px-2 py-0.5 rounded-full">{ct}</span>
                          ))}
                          {careTypes.length > 3 && <span className="text-xs text-slate-400">+{careTypes.length - 3} more</span>}
                        </div>
                      )}

                      {/* Footer */}
                      <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                        <div className="flex items-center gap-3">
                          {post.recipientsCount != null && (
                            <span className="inline-flex items-center gap-1 text-sm text-slate-600">
                              <User className="w-3.5 h-3.5 text-slate-400" />
                              <span className="font-semibold">{post.recipientsCount}</span> {post.recipientsCount === 1 ? 'senior' : 'seniors'}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1.5 text-sm text-slate-700">
                            <Users className="w-4 h-4 text-primary-600" />
                            <span className="font-semibold">{count}</span> {count === 1 ? 'applicant' : 'applicants'}
                          </span>
                        </div>
                        {post.status === 'open' && count > 0 && (
                          <button onClick={() => openApplicantsPanel(post.id)} className="text-sm font-semibold text-primary-600 hover:text-primary-700">
                            View Applicants →
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ── INTERVIEWS TAB ── */}
        {mainTab === 'interviews' && (
          <>
            {loadingInterviews ? (
              <div className="py-16 flex items-center justify-center text-slate-400">
                <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading interviews...
              </div>
            ) : interviews.length === 0 ? (
              <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
                <Calendar className="w-10 h-10 text-slate-200 mx-auto mb-3" />
                <p className="text-slate-500 mb-4">No interviews yet.</p>
                <button onClick={() => navigate('/client/find-caregivers')} className="px-6 py-2.5 bg-primary-600 text-white font-semibold rounded-xl hover:bg-primary-700 text-sm">
                  Find Caregivers
                </button>
              </div>
            ) : (
              <>
                {/* Filter chips */}
                <div className="flex gap-2 flex-wrap mb-4">
                  {(['all', 'pending', 'accepted', 'completed', 'declined', 'cancelled'] as const).map(f => {
                    const total = f === 'all' ? interviews.length : interviews.filter(i => i.status === f).length;
                    if (f !== 'all' && total === 0) return null;
                    const newCount = f === 'all' ? 0 : interviews.filter(i => {
                      if (i.status !== f) return false;
                      const ms = i.createdAt ? new Date(i.createdAt).getTime() : 0;
                      return ms > (lastCheckedFilter[f] ?? 0);
                    }).length;
                    return (
                      <button
                        key={f}
                        onClick={() => {
                          setInterviewFilter(f);
                          if (f !== 'all') {
                            const now = Date.now();
                            localStorage.setItem(LS_FILTER_KEY(f), String(now));
                            setLastCheckedFilter(prev => ({ ...prev, [f]: now }));
                          }
                        }}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${interviewFilter === f ? 'bg-primary-600 border-primary-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'}`}
                      >
                        {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
                        {newCount > 0 && interviewFilter !== f && (
                          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none">{newCount}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              <div className="space-y-4">
                {interviews.filter(i => interviewFilter === 'all' || i.status === interviewFilter).map(interview => {
                  const done = decisionDone[interview.id];
                  const submitting = !!submittingDecision[interview.id];
                  const relatedPost = interview.jobId ? posts.find(p => p.id === interview.jobId) : undefined;
                  return (
                    <div key={interview.id} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                      {/* Job post banner */}
                      {relatedPost && (
                        <div className="bg-slate-50 border-b border-slate-100 px-6 py-3">
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <Briefcase className="w-3.5 h-3.5 text-primary-500 shrink-0" />
                              <span className="text-sm font-semibold text-slate-800 truncate">{relatedPost.title}</span>
                              {relatedPost.location && <span className="flex items-center gap-1 text-xs text-slate-500"><MapPin className="w-3 h-3" />{relatedPost.location}</span>}
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {relatedPost.rate && <span className="text-xs font-bold text-green-700 bg-green-50 px-2 py-0.5 rounded-full">${relatedPost.rate}/hr</span>}
                              {(relatedPost as any).jobFrequency || (relatedPost.minHoursPerWeek != null) ? (
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-primary-700 bg-primary-50 px-2 py-0.5 rounded-full">
                                  {(relatedPost as any).jobFrequency?.replace('-', ' ') || (relatedPost.minHoursPerWeek! >= 32 ? 'Full Time' : 'Part Time')}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          {Array.isArray(relatedPost.careTypes) && relatedPost.careTypes.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {(relatedPost.careTypes as string[]).slice(0, 4).map(ct => (
                                <span key={ct} className="text-[11px] bg-blue-50 text-blue-700 border border-blue-100 px-2 py-0.5 rounded-full">{ct}</span>
                              ))}
                              {relatedPost.careTypes.length > 4 && <span className="text-[11px] text-slate-400">+{relatedPost.careTypes.length - 4} more</span>}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="px-4 py-3">
                        {/* Caregiver row */}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center shrink-0 overflow-hidden">
                              {interview.caregiverPhoto
                                ? <img src={interview.caregiverPhoto} alt={interview.caregiverName} className="w-full h-full object-cover" />
                                : <User className="w-4 h-4 text-primary-600" />}
                            </div>
                            <div className="min-w-0">
                              <h3 className="font-semibold text-slate-900 text-sm truncate">{interview.caregiverName}</h3>
                              {!relatedPost && interview.jobTitle && (
                                <p className="text-xs text-primary-600 truncate">{interview.jobTitle}</p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 ml-2">
                            <button onClick={() => navigate(`/client/caregiver/${interview.caregiverId}`)} className="p-1 hover:bg-slate-100 rounded-lg">
                              <ChevronRight className="w-4 h-4 text-slate-400" />
                            </button>
                          </div>
                        </div>

                        {/* Date / time / type inline */}
                        <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                          <span className="flex items-center gap-1">
                            <Calendar className="w-3.5 h-3.5" />
                            {new Date(interview.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5" />{new Date(`2000-01-01T${interview.time}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                          </span>
                          <span className="flex items-center gap-1">
                            {typeIcon(interview.type)}
                            {interview.type === 'in-person' ? 'In Person' : interview.type.charAt(0).toUpperCase() + interview.type.slice(1)}
                          </span>
                        </div>

                        {/* Notes */}
                        {interview.notes && (
                          <p className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-1.5 break-words">{interview.notes}</p>
                        )}

                        {/* Actions */}
                        {(() => {
                          const key = `${interview.caregiverId}_${interview.jobId || interview.id}`;
                          const booking = bookingStatuses[key];
                          const showBar = (interview.status === 'pending' || interview.status === 'accepted') ||
                            interview.status === 'completed' || done ||
                            (interview.status === 'declined' && interview.jobId) || !!booking;
                          if (!showBar) return null;
                          return (
                            <div className="flex items-center gap-2 mt-3 pt-2 border-t border-slate-100 flex-wrap">
                              {(interview.status === 'pending' || interview.status === 'accepted') && (
                                <button
                                  onClick={() => gate('message', interview.caregiverName, () => navigate(`/client/inbox?caregiver=${interview.caregiverId}`))}
                                  className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-50"
                                >
                                  <MessageSquare className="w-3.5 h-3.5" /> Message
                                </button>
                              )}
                              {interview.status === 'pending' && (
                                <button
                                  onClick={() => handleCancelInterview(interview.id)}
                                  className="flex items-center gap-1.5 px-3 py-1.5 border border-red-200 text-red-600 rounded-lg text-xs font-medium hover:bg-red-50"
                                >
                                  Cancel
                                </button>
                              )}
                              {interview.status === 'accepted' && new Date(`${interview.date}T${interview.time}`) < new Date() && (
                                <button
                                  onClick={() => handleMarkInterviewComplete(interview.id)}
                                  className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-semibold hover:bg-green-700"
                                >
                                  <CheckCircle className="w-3.5 h-3.5" /> Mark as Completed
                                </button>
                              )}
                              {interview.status === 'completed' && (() => {
                                if (booking?.status === 'pending') return (
                                  <>
                                    <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-600">
                                      <Clock3 className="w-3.5 h-3.5" /> Booking sent · Awaiting response
                                    </span>
                                    <button
                                      onClick={() => handleCancelBooking(booking.id)}
                                      className="flex items-center gap-1.5 px-3 py-1.5 border border-red-200 text-red-600 rounded-lg text-xs font-medium hover:bg-red-50"
                                    >
                                      Cancel
                                    </button>
                                  </>
                                );
                                if (booking?.status === 'accepted') {
                                  const hasActiveShifts = activeBookingIds.has(booking.id);
                                  if (hasActiveShifts) return (
                                    <span className="flex items-center gap-1.5 text-xs font-semibold text-green-700">
                                      <CheckCircle className="w-3.5 h-3.5" /> Booking accepted
                                    </span>
                                  );
                                  // All shifts completed — offer to re-book
                                  return (
                                    <button
                                      onClick={() => gate('booking', interview.caregiverName, () => openSendBookingModal(interview))}
                                      className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 text-white rounded-lg text-xs font-semibold hover:bg-primary-700"
                                    >
                                      <RefreshCw className="w-3.5 h-3.5" /> Re-book
                                    </button>
                                  );
                                }
                                if (booking?.status === 'declined' || booking?.status === 'cancelled') return (
                                  <>
                                    <span className="flex items-center gap-1.5 text-xs text-red-600 font-medium">
                                      <XCircle className="w-3.5 h-3.5" /> {booking.status === 'cancelled' ? 'Visit cancelled' : 'Caregiver declined'}
                                    </span>
                                    <button
                                      onClick={() => gate('booking', interview.caregiverName, () => openSendBookingModal(interview))}
                                      className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 text-white rounded-lg text-xs font-semibold hover:bg-primary-700"
                                    >
                                      <Send className="w-3.5 h-3.5" /> Resend
                                    </button>
                                  </>
                                );
                                if (done === 'declined') return (
                                  <span className="flex items-center gap-1.5 text-xs text-slate-500">
                                    <XCircle className="w-3.5 h-3.5" /> Not selected
                                  </span>
                                );
                                return (
                                  <>
                                    <button onClick={() => handleDecision(interview, 'decline')} disabled={submitting} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                                      {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />} Not Selected
                                    </button>
                                    <button onClick={() => gate('booking', interview.caregiverName, () => openSendBookingModal(interview))} disabled={submitting} className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 text-white rounded-lg text-xs font-semibold hover:bg-primary-700 disabled:opacity-50">
                                      <Send className="w-3.5 h-3.5" /> Send Booking
                                    </button>
                                  </>
                                );
                              })()}
                              {interview.status === 'declined' && !done && interview.jobId && (
                                <button onClick={() => openApplicantsPanel(interview.jobId!)} className="flex items-center gap-1.5 px-3 py-1.5 border border-primary-200 text-primary-600 rounded-lg text-xs font-semibold hover:bg-primary-50">
                                  <Users className="w-3.5 h-3.5" /> View Other Applicants
                                </button>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })}
              </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Send Booking confirmation modal */}
      {sendBookingFor && (() => {
        // loadedPost has fresh Firestore data; fall back to posts state if not yet loaded
        const post = loadedPost || (sendBookingFor.jobId ? posts.find(p => p.id === sendBookingFor.jobId) : undefined);
        const key = `${sendBookingFor.caregiverId}_${sendBookingFor.jobId || sendBookingFor.id}`;
        const isResend = bookingStatuses[key]?.status === 'declined' || bookingStatuses[key]?.status === 'cancelled';
        const d = bookingDraft;
        const upd = (patch: Partial<typeof bookingDraft>) => setBookingDraft(prev => ({ ...prev, ...patch }));

        // Save & Confirm button validation
        const scheduleDays = Object.entries(d.dayShiftTimes);
        const noScheduleDays = scheduleDays.length === 0;
        const daysWithMissingTimes = scheduleDays
          .filter(([, blocks]) => (blocks as any[]).some((b: any) => !b.start || !b.end))
          .map(([day]) => day);
        const ABBR_TO_FULL: Record<string, string> = { Sun:'sunday', Mon:'monday', Tue:'tuesday', Wed:'wednesday', Thu:'thursday', Fri:'friday', Sat:'saturday' };
        const hasCgAvail = Object.keys(cgWeeklyAvail).length > 0;

        const saveIsDisabled = !d.agreedRate || !d.paymentMethod || !d.selectedAddress || noScheduleDays || daysWithMissingTimes.length > 0;
        const saveTip = !d.agreedRate ? 'Enter agreed rate to save'
          : !d.paymentMethod ? 'Select a payment method to save'
          : !d.selectedAddress ? 'Select a care location to save'
          : noScheduleDays ? 'Add at least one day with shift times'
          : daysWithMissingTimes.length > 0 ? `Set start & end time for: ${daysWithMissingTimes.join(', ')}`
          : '';

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setSendBookingFor(null)} />
            <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden">

              {/* Header */}
              <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100 shrink-0">
                <div>
                  <h2 className="font-bold text-slate-900 text-lg">{isResend ? 'Resend Booking Request' : 'Send Booking Request'}</h2>
                  <p className="text-xs text-slate-400 mt-0.5">Review and edit before sending</p>
                </div>
                <div className="flex items-center gap-2">
                  {!loadingCarePlan && loadedPlan && (
                    editingBookingDetails ? (
                      <button type="button"
                        onClick={() => { setEditingBookingDetails(false); setScheduleConfirmed(true); }}
                        disabled={saveIsDisabled}
                        title={saveTip}
                        className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-primary-600 text-white hover:bg-primary-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                        Save & Confirm
                      </button>
                    ) : (
                      <button type="button" onClick={() => setEditingBookingDetails(true)}
                        className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-600 hover:border-primary-300 hover:text-primary-600 transition-colors">
                        <Pencil className="w-3 h-3" />
                        Edit
                      </button>
                    )
                  )}
                  <button onClick={() => setSendBookingFor(null)} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors">
                    <X className="w-5 h-5 text-slate-400" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                {loadingCarePlan ? (
                  <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-primary-400" /></div>
                ) : (
                  <>
                    {/* Caregiver */}
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-primary-100 flex items-center justify-center shrink-0 overflow-hidden">
                        {sendBookingFor.caregiverPhoto
                          ? <img src={sendBookingFor.caregiverPhoto} alt={sendBookingFor.caregiverName} className="w-full h-full object-cover" />
                          : <User className="w-5 h-5 text-primary-600" />}
                      </div>
                      <div>
                        <p className="font-semibold text-slate-900">{sendBookingFor.caregiverName}</p>
                        <p className="text-xs text-slate-400">Caregiver</p>
                      </div>
                    </div>

                    {/* Job post summary */}
                    {post && (
                      <div className="bg-slate-50 rounded-xl px-4 py-4 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex flex-wrap items-center gap-1.5 mb-1">
                              {post.recipientsCount != null && (
                                <span className="text-xs font-semibold px-2 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-200">
                                  {post.recipientsCount} {post.recipientsCount === 1 ? 'senior' : 'seniors'}
                                </span>
                              )}
                            </div>
                            <p className="font-semibold text-slate-900">{post.title}</p>
                          </div>
                          {post.rate && <p className="text-xs text-slate-400 shrink-0">Listed: ${post.rate}/hr</p>}
                        </div>
                      </div>
                    )}

                    {/* Rate & Payment — required before sending */}
                    <div className="rounded-xl border border-slate-200 overflow-hidden">
                      <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
                        <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Rate & Payment</p>
                        {!editingBookingDetails && !d.agreedRate && (
                          <span className="text-xs font-semibold text-amber-600">Required</span>
                        )}
                      </div>
                      <div className="px-4 py-3">
                        {editingBookingDetails ? (
                          <div className="space-y-3">
                            <div>
                              {post?.rate && <p className="text-[10px] text-slate-400 mb-1">Listed on post: ${post.rate}/hr — enter the agreed rate</p>}
                              <div className="relative w-40">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm pointer-events-none">$</span>
                                <input
                                  type="number"
                                  value={d.agreedRate ?? ''}
                                  onChange={e => upd({ agreedRate: e.target.value !== '' ? Number(e.target.value) : null })}
                                  placeholder={post?.rate ? String(post.rate) : 'Agreed rate'}
                                  min={0}
                                  step={0.5}
                                  className="w-full border border-slate-200 rounded-xl pl-7 pr-10 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
                                />
                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none">/hr</span>
                              </div>
                            </div>
                            <div>
                              <p className="text-xs font-semibold text-slate-500 mb-1.5">Payment method</p>
                              <div className="flex gap-2">
                                {([{ value: 'cash', label: 'Cash' }, { value: 'credit', label: 'Card' }] as const).map(({ value, label }) => (
                                  <button key={value} type="button"
                                    onClick={() => upd({ paymentMethod: d.paymentMethod === value ? '' : value })}
                                    className={`text-xs px-4 py-1.5 rounded-full border transition-colors ${d.paymentMethod === value ? 'bg-primary-500 text-white border-primary-500' : 'bg-white text-slate-600 border-slate-200 hover:border-primary-300'}`}>
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        ) : d.agreedRate ? (
                          <div className="flex items-center gap-3">
                            <p className="text-sm font-bold text-green-700">${d.agreedRate}/hr</p>
                            {d.paymentMethod && <span className="text-xs bg-slate-100 text-slate-600 border border-slate-200 px-2.5 py-1 rounded-full font-medium">via {d.paymentMethod}</span>}
                          </div>
                        ) : (
                          <p className="text-xs text-amber-600">Enter the agreed rate — click <strong>Edit</strong> above</p>
                        )}
                      </div>
                    </div>

                    {/* Schedule — start date, end/ongoing, per-day shift times */}
                    {(() => {
                      const _td = new Date();
                      const todayIso = `${_td.getFullYear()}-${String(_td.getMonth()+1).padStart(2,'0')}-${String(_td.getDate()).padStart(2,'0')}`;
                      const fmtTime = (t: string, suffix = '') => {
                        if (!t) return '';
                        const nextDay = t.startsWith('~');
                        const raw = nextDay ? t.slice(1) : t;
                        try {
                          const [h, m] = raw.split(':');
                          const dt = new Date(); dt.setHours(+h, +m);
                          const formatted = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                          return nextDay ? `${formatted} (next day)` : formatted + suffix;
                        } catch { return raw; }
                      };
                      const stripNextDay = (t: string) => t.startsWith('~') ? t.slice(1) : t;
                      const fmtDate = (s: string) => { if (!s) return ''; try { return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return s; } };
                      const ALL_DAYS_ORDER = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
                      const TIME_OPTS = Array.from({ length: 96 }, (_, i) => {
                        const h = Math.floor(i / 4), m = (i % 4) * 15;
                        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
                      });
                      // ── Caregiver availability helpers ──────────────────
                      const toMin = (t: string) => { const [h, m] = (t || '00:00').split(':').map(Number); return h * 60 + m; };
                      // overnight is cross-midnight: e(360) < s(1380) → getDaySlots splits it
                      const BLOCK_MINS: Record<string, {s:number;e:number}> = { morning:{s:360,e:720}, afternoon:{s:720,e:1080}, evening:{s:1080,e:1380}, overnight:{s:1380,e:360} };
                      const getDaySlots = (abbr: string): Array<{s:number;e:number}> => {
                        if (!hasCgAvail) return [];
                        const full = ABBR_TO_FULL[abbr] || abbr.toLowerCase();
                        const raw: any[] = cgWeeklyAvail[full] || [];
                        const result: {s:number;e:number}[] = [];
                        for (const sl of raw) {
                          let s: number, e: number;
                          if (typeof sl === 'string') {
                            const bm = BLOCK_MINS[sl]; if (!bm) continue;
                            s = bm.s; e = bm.e;
                          } else {
                            if (!sl?.start) continue;
                            s = toMin(sl.start); e = toMin(sl.end);
                          }
                          if (e > 0 && e <= s) {
                            // cross-midnight (overnight 23:00–06:00): split into two ranges
                            result.push({s, e: 1440}); // 23:00–midnight
                            result.push({s: 0, e});    // midnight–06:00
                          } else {
                            result.push({s, e: e > 0 ? e : 1440});
                          }
                        }
                        return result;
                      };
                      const isDayAvailable = (abbr: string) => !hasCgAvail || getDaySlots(abbr).length > 0;
                      const availTimeOpts = (abbr: string, extraBusy: Array<{s:number;e:number}> = []) => {
                        const allBusy = [...(cgBookedSlots[abbr] || []), ...extraBusy];
                        return TIME_OPTS.filter(t => !allBusy.some(b => toMin(t) >= b.s && toMin(t) < b.e));
                      };
                      const availEndOpts = (abbr: string, startT: string, extraBusy: Array<{s:number;e:number}> = []) => {
                        const startM = startT ? toMin(startT) : 0;
                        const allBusy = [...(cgBookedSlots[abbr] || []), ...extraBusy];
                        const sameDayOpts = TIME_OPTS.filter(t => {
                          if (startT && t <= startT) return false;
                          const eM = toMin(t);
                          if (allBusy.some(b => b.s < eM && b.e > startM)) return false;
                          return true;
                        });
                        const nextDayOpts = allBusy.some(b => b.s < 1440 && b.e > startM) ? [] : ['~00:00'];
                        return [...sameDayOpts, ...nextDayOpts];
                      };
                      const blockEndMin = (end: string) => end === '~00:00' ? 1440 : toMin(stripNextDay(end));
                      const otherBlocksBusy = (abbr: string, excludeIdx: number): Array<{s:number;e:number}> =>
                        (d.dayShiftTimes[abbr] || [])
                          .filter((b, i) => i !== excludeIdx && b.start && b.end)
                          .map(b => ({ s: toMin(stripNextDay(b.start)), e: blockEndMin(b.end) }));
                      const isBlockOutsidePreferred = (abbr: string, start: string, end: string) => {
                        if (!hasCgAvail) return false;
                        const slots = getDaySlots(abbr);
                        if (slots.length === 0) return false; // day-level badge already shown
                        const inSlot = (m: number) => slots.some(sl => m >= sl.s && m <= sl.e);
                        if (start && !inSlot(toMin(start))) return true;
                        if (end && !inSlot(end === '~00:00' ? 1440 : toMin(stripNextDay(end)))) return true;
                        return false;
                      };
                      const fmtTimeOpt = (t: string) => {
                        if (!t) return '';
                        const isNext = t.startsWith('~');
                        const raw = isNext ? t.slice(1) : t;
                        const [hh, mm] = raw.split(':').map(Number);
                        const ap = hh < 12 ? 'AM' : 'PM';
                        const h12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
                        return `${h12}:${String(mm).padStart(2,'0')} ${ap}`;
                      };
                      const calcDayHours = (blocks: Array<{start:string;end:string}>) => {
                        return blocks.reduce((sum, b) => {
                          if (!b.start || !b.end) return sum;
                          const [sh, sm] = stripNextDay(b.start).split(':').map(Number);
                          const [eh, em] = stripNextDay(b.end).split(':').map(Number);
                          let mins = (eh * 60 + em) - (sh * 60 + sm);
                          if (mins <= 0) mins += 24 * 60;
                          return sum + mins / 60;
                        }, 0);
                      };
                      const fmtHours = (h: number) => h === 0 ? '' : `${h % 1 === 0 ? h : h.toFixed(2)}h`;
                      const daysWithTimes = Object.keys(d.dayShiftTimes).sort((a,b) => ALL_DAYS_ORDER.indexOf(a) - ALL_DAYS_ORDER.indexOf(b));
                      const availableDays = ALL_DAYS_ORDER.filter(day => !daysWithTimes.includes(day));
                      return (
                        <div className="rounded-xl border border-slate-200 overflow-hidden">
                          <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
                            <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Schedule</p>
                            {!editingBookingDetails && schedulePrePopulated && !scheduleConfirmed && daysWithTimes.some(day => (bookingDraft.dayShiftTimes[day] || []).some(b => b.start && b.end)) && (
                              <button type="button" onClick={() => setScheduleConfirmed(true)}
                                className="text-xs font-semibold text-primary-600 border border-primary-300 px-2.5 py-1 rounded-lg hover:bg-primary-50 transition-colors">
                                Confirm schedule
                              </button>
                            )}
                          </div>
                          <div className="px-4 py-3 space-y-3">
                            {editingBookingDetails ? (
                              <>
                                <div className="grid grid-cols-2 gap-3">
                                  <div>
                                    <p className="text-xs font-semibold text-slate-500 mb-1">Start date</p>
                                    <input type="date" value={d.shiftStartDate} min={todayIso}
                                      onChange={e => { const v = e.target.value; upd({ shiftStartDate: v && v < todayIso ? todayIso : v }); }}
                                      className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300" />
                                  </div>
                                  <div>
                                    <p className="text-xs font-semibold text-slate-500 mb-1">End date</p>
                                    <input type="date" value={d.shiftEndDate} min={d.shiftStartDate || todayIso}
                                      onChange={e => upd({ shiftEndDate: e.target.value, shiftOngoing: e.target.value ? false : true })}
                                      className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300" />
                                    <label className="inline-flex items-center gap-1.5 mt-1.5 text-xs text-slate-600 cursor-pointer">
                                      <input type="checkbox" checked={d.shiftOngoing} onChange={e => upd({ shiftOngoing: e.target.checked, shiftEndDate: e.target.checked ? '' : d.shiftEndDate })} className="w-3.5 h-3.5 accent-primary-600" />
                                      Ongoing
                                    </label>
                                  </div>
                                </div>
                                {daysWithTimes.length > 0 && (
                                  <div>
                                    <p className="text-xs font-semibold text-slate-500 mb-2">Shift times per day</p>
                                    <div className="space-y-3">
                                      {daysWithTimes.map(day => {
                                        const blocks = d.dayShiftTimes[day] || [];
                                        return (
                                          <div key={day}>
                                            <div className="flex items-center justify-between mb-1">
                                              <div className="flex items-center gap-2">
                                                <p className="text-xs font-bold text-slate-700">{day}</p>
                                                {(() => { const hrs = fmtHours(calcDayHours(d.dayShiftTimes[day] || [])); return hrs ? <span className="text-xs text-primary-600 font-semibold">{hrs}</span> : null; })()}
                                                {!isDayAvailable(day) && <span className="text-[10px] font-semibold text-orange-600 bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded-full">Outside available hours</span>}
                                              </div>
                                              <button type="button" onClick={() => { const next = { ...d.dayShiftTimes }; delete next[day]; upd({ dayShiftTimes: next }); }} className="text-xs text-slate-400 hover:text-red-500 transition-colors">Remove</button>
                                            </div>
                                            <div className="space-y-1.5">
                                              {blocks.map((block, bi) => (
                                                <div key={bi} className="flex flex-col gap-1">
                                                  {isBlockOutsidePreferred(day, stripNextDay(block.start), block.end) && (
                                                    <span className="text-[10px] font-semibold text-orange-600 bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded-full self-start">Outside available hours</span>
                                                  )}
                                                <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                                                  <select value={stripNextDay(block.start)}
                                                    onChange={e => { const nb = [...blocks]; nb[bi] = { ...block, start: e.target.value }; upd({ dayShiftTimes: { ...d.dayShiftTimes, [day]: nb } }); }}
                                                    className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary-300 bg-white">
                                                    <option value="">Start</option>
                                                    {availTimeOpts(day, otherBlocksBusy(day, bi)).map(t => <option key={t} value={t}>{fmtTimeOpt(t)}</option>)}
                                                  </select>
                                                  <span className="text-xs text-slate-400 shrink-0">to</span>
                                                  <select value={block.end}
                                                    onChange={e => { const nb = [...blocks]; nb[bi] = { ...block, end: e.target.value }; upd({ dayShiftTimes: { ...d.dayShiftTimes, [day]: nb } }); }}
                                                    className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary-300 bg-white">
                                                    <option value="">End</option>
                                                    {availEndOpts(day, stripNextDay(block.start), otherBlocksBusy(day, bi)).map(t => <option key={t} value={t}>{fmtTimeOpt(t)}</option>)}
                                                  </select>
                                                  {blocks.length > 1 && (
                                                    <button type="button" onClick={() => { const nb = blocks.filter((_, i) => i !== bi); upd({ dayShiftTimes: { ...d.dayShiftTimes, [day]: nb } }); }} className="text-slate-300 hover:text-red-400 transition-colors ml-1 shrink-0">✕</button>
                                                  )}
                                                </div>
                                                </div>
                                              ))}
                                              {blocks.every(b => b.start && b.end) && availTimeOpts(day, blocks.filter(b => b.start && b.end).map(b => ({ s: toMin(stripNextDay(b.start)), e: blockEndMin(b.end) }))).length > 0 && (
                                                <button
                                                  type="button"
                                                  onClick={() => upd({ dayShiftTimes: { ...d.dayShiftTimes, [day]: [...blocks, { label: '', start: '', end: '' }] } })}
                                                  className="text-xs text-primary-600 hover:text-primary-800 font-medium mt-1 self-start">
                                                  + Add time
                                                </button>
                                              )}
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}
                                {/* Add a day pills */}
                                {availableDays.length > 0 && (
                                  <div>
                                    <p className="text-xs font-semibold text-slate-500 mb-2">Add a day</p>
                                    <div className="flex flex-nowrap gap-1">
                                      {availableDays.map(day => {
                                        const dayAvail = isDayAvailable(day);
                                        const fmtM = (m: number) => {
                                          const h = Math.floor(m / 60) % 24;
                                          const mn = m % 60;
                                          const dh = h === 0 ? 12 : h > 12 ? h - 12 : h;
                                          const p = h >= 12 ? 'pm' : 'am';
                                          return mn === 0 ? `${dh}${p}` : `${dh}:${String(mn).padStart(2,'0')}${p}`;
                                        };
                                        const slots = hasCgAvail ? getDaySlots(day).filter(sl => sl.s < 1440) : [];
                                        const bookings = (cgBookedSlots[day] || []).sort((a, b) => a.s - b.s);
                                        // Subtract bookings from each slot to get net free intervals
                                        const freeIntervals = slots.flatMap(sl => {
                                          const slE = sl.e || 1440;
                                          let free = [{ s: sl.s, e: slE }];
                                          for (const bk of bookings.filter(b => b.s < slE && b.e > sl.s)) {
                                            free = free.flatMap(iv => {
                                              if (bk.e <= iv.s || bk.s >= iv.e) return [iv];
                                              const parts = [];
                                              if (bk.s > iv.s) parts.push({ s: iv.s, e: bk.s });
                                              if (bk.e < iv.e) parts.push({ s: bk.e, e: iv.e });
                                              return parts;
                                            });
                                          }
                                          return free.filter(iv => iv.e > iv.s);
                                        });
                                        const mergeIvs = (ivs: Array<{s:number;e:number}>) => {
                                          if (!ivs.length) return [];
                                          const sorted = [...ivs].sort((a,b) => a.s - b.s);
                                          const out = [{ ...sorted[0] }];
                                          for (let i = 1; i < sorted.length; i++) {
                                            const last = out[out.length - 1];
                                            if (sorted[i].s <= last.e) last.e = Math.max(last.e, sorted[i].e);
                                            else out.push({ ...sorted[i] });
                                          }
                                          return out;
                                        };
                                        const freeStr = mergeIvs(freeIntervals).map(iv => `${fmtM(iv.s)}–${fmtM(iv.e)}`).join(', ');
                                        const fullyBooked = slots.length > 0 && freeIntervals.length === 0;
                                        const isUnavailable = !dayAvail || fullyBooked;
                                        const busyStr = bookings.length > 0
                                          ? mergeIvs(bookings).map(b => `${fmtM(b.s)}–${fmtM(b.e)}`).join(', ')
                                          : '';
                                        const hasTooltip = slots.length > 0 || !dayAvail || busyStr.length > 0;
                                        return (
                                          <div key={day} className="relative group">
                                            <button type="button"
                                              onClick={() => upd({ dayShiftTimes: { ...d.dayShiftTimes, [day]: [{ label: '', start: '', end: '' }] } })}
                                              className={`text-xs font-semibold px-2 py-1 rounded-full border transition-colors ${
                                                isUnavailable
                                                  ? 'border-orange-200 bg-orange-50 text-orange-600 hover:bg-orange-100 hover:border-orange-300'
                                                  : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-primary-50 hover:border-primary-300 hover:text-primary-700'
                                              }`}>
                                              + {day}
                                            </button>
                                            {hasTooltip && (
                                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none hidden group-hover:block">
                                                <div className="bg-slate-800 text-white rounded-lg px-3 py-2 shadow-xl text-[11px] whitespace-nowrap">
                                                  {fullyBooked && <div className="text-orange-300 font-medium">Not available — fully booked</div>}
                                                  {!fullyBooked && dayAvail && freeStr && <div className="text-emerald-300 font-medium">Available: {freeStr}</div>}
                                                  {!dayAvail && <div className="text-orange-300">Outside available hours</div>}
                                                  {busyStr && <div className="text-orange-300 font-medium">Busy: {busyStr}</div>}
                                                  <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800" />
                                                </div>
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}
                                {(() => {
                                  const totalHrs = daysWithTimes.reduce((sum, day) => sum + calcDayHours(d.dayShiftTimes[day] || []), 0);
                                  if (totalHrs === 0) return null;
                                  return (
                                    <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                                      <span className="text-xs font-semibold text-slate-500">Total hours per week</span>
                                      <span className="text-sm font-bold text-primary-700">{fmtHours(totalHrs)}</span>
                                    </div>
                                  );
                                })()}
                              </>
                            ) : (
                              <>
                                <div className="flex items-center gap-4 text-sm text-slate-700 flex-wrap">
                                  {d.shiftStartDate && <span className="flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5 text-slate-400" /> Starts {fmtDate(d.shiftStartDate)}</span>}
                                  {d.shiftOngoing
                                    ? <span className="text-xs bg-teal-50 text-teal-700 border border-teal-200 px-2.5 py-1 rounded-full font-medium">Ongoing</span>
                                    : d.shiftEndDate
                                      ? <span className="text-xs text-slate-500">Ends {fmtDate(d.shiftEndDate)}</span>
                                      : null}
                                </div>
                                {daysWithTimes.length > 0 && (
                                  <div className="space-y-1.5">
                                    {daysWithTimes.map(day => {
                                      const blocks = d.dayShiftTimes[day] || [];
                                      const filled = blocks.filter(b => b.start && b.end);
                                      return (
                                        <div key={day} className="flex gap-3 text-xs">
                                          <span className="w-8 font-bold text-slate-700 shrink-0 pt-0.5">{day.slice(0, 3)}</span>
                                          <div className="space-y-0.5 flex-1">
                                            {filled.length === 0
                                              ? <span className="text-slate-400 italic">No time set — click Edit</span>
                                              : filled.map((b, i) => (
                                                <div key={i} className="text-slate-600">{fmtTime(b.start)} – {fmtTime(b.end)}</div>
                                              ))
                                            }
                                          </div>
                                          {(() => { const hrs = fmtHours(calcDayHours(filled)); return hrs ? <span className="text-xs font-semibold text-primary-600 shrink-0">{hrs}</span> : null; })()}
                                        </div>
                                      );
                                    })}
                                    {(() => {
                                      const totalHrs = daysWithTimes.reduce((sum, day) => { const filled = (d.dayShiftTimes[day] || []).filter(b => b.start && b.end); return sum + calcDayHours(filled); }, 0);
                                      if (totalHrs === 0) return null;
                                      return (
                                        <div className="flex items-center justify-between pt-2 border-t border-slate-100 mt-1">
                                          <span className="text-xs font-semibold text-slate-500">Total per week</span>
                                          <span className="text-sm font-bold text-primary-700">{fmtHours(totalHrs)}</span>
                                        </div>
                                      );
                                    })()}
                                  </div>
                                )}
                                {!d.shiftStartDate && daysWithTimes.length === 0 && (
                                  <p className="text-xs text-slate-400">No schedule set — click Edit to add</p>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Recipients — selectable cards */}
                    {loadedPlan && loadedPlan.recipients.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Care Recipients {editingBookingDetails && <span className="font-normal normal-case text-slate-400">— tap to include</span>}</p>
                        <div className="flex flex-col gap-2">
                          {loadedPlan.recipients.map(r => {
                            const selected = d.selectedRecipientKeys.includes(r.key);
                            return (
                              <button
                                key={r.key}
                                type="button"
                                disabled={!editingBookingDetails}
                                onClick={() => {
                                  const limit = post?.recipientsCount ?? loadedPlan.recipients.length;
                                  let newKeys: string[];
                                  if (selected) {
                                    newKeys = d.selectedRecipientKeys.filter(k => k !== r.key);
                                  } else if (d.selectedRecipientKeys.length >= limit) {
                                    // At limit: drop the oldest selection, add new one
                                    newKeys = [...d.selectedRecipientKeys.slice(1), r.key];
                                  } else {
                                    newKeys = [...d.selectedRecipientKeys, r.key];
                                  }
                                  setBookingDraft(prev => ({ ...prev, selectedRecipientKeys: newKeys }));
                                }}
                                className={`flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left transition-colors ${selected ? 'border-primary-500 bg-primary-50' : 'border-slate-200 bg-white'} ${editingBookingDetails ? 'hover:border-slate-300 cursor-pointer' : 'cursor-default'}`}
                              >
                                {/* Avatar */}
                                <div className="w-10 h-10 rounded-full overflow-hidden shrink-0 bg-primary-100 flex items-center justify-center">
                                  {r.photoURL
                                    ? <img src={r.photoURL} alt={r.name} className="w-full h-full object-cover" />
                                    : <span className="text-primary-700 font-bold text-sm">{r.name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()}</span>}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="font-semibold text-slate-900 text-sm">{r.name}</p>
                                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                    {r.relationship && <span className="text-xs text-slate-500">{r.relationship}</span>}
                                    {r.age && <span className="text-xs text-slate-400">· Age {r.age}</span>}
                                  </div>
                                  {/* Care needs for this recipient */}
                                  {(loadedPlan.recipientPlans[r.key]?.careNeeds || []).length > 0 && (
                                    <div className="flex flex-wrap gap-1 mt-1.5">
                                      {(loadedPlan.recipientPlans[r.key].careNeeds as string[]).slice(0, 3).map(n => (
                                        <span key={n} className="text-[10px] bg-blue-50 text-blue-700 border border-blue-100 px-1.5 py-0.5 rounded-full">{n}</span>
                                      ))}
                                      {loadedPlan.recipientPlans[r.key].careNeeds.length > 3 && (
                                        <span className="text-[10px] text-slate-400">+{loadedPlan.recipientPlans[r.key].careNeeds.length - 3} more</span>
                                      )}
                                    </div>
                                  )}
                                </div>
                                <div className={`w-5 h-5 rounded-full border-2 shrink-0 flex items-center justify-center ${selected ? 'border-primary-500 bg-primary-500' : 'border-slate-300'}`}>
                                  {selected && <CheckCircle className="w-3.5 h-3.5 text-white" />}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Care plan summary / edit */}
                    {loadedPlan && (() => {
                      const ecName = [d.emergencyContactFirstName, d.emergencyContactLastName].filter(Boolean).join(' ');
                      const selectedRecipients = loadedPlan.recipients.filter(r => d.selectedRecipientKeys.includes(r.key));

                      return (
                        <div className="rounded-xl border border-slate-200 overflow-hidden">
                          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
                            <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Care Plan Details</p>
                          </div>

                          <div className="divide-y divide-slate-100">
                            {/* Per-recipient care needs + lifestyle */}
                            {selectedRecipients.length === 0
                              ? <p className="px-4 py-3 text-xs text-slate-400">Select at least one recipient above</p>
                              : selectedRecipients.map(r => {
                                const rd = d.recipientDrafts[r.key] || { careNeeds: [], careNeedDetails: {}, lifestyle: emptyLifestyleDraft() };
                                const ls = rd.lifestyle;
                                const hasLifestyle = ls.favoriteActivities.length > 0 || ls.helpActivities.length > 0 || ls.entertainment.length > 0 || ls.enjoysConversation !== null || ls.prefersQuiet !== null || ls.familyInArea !== null || ls.friendsVisitors !== null;
                                const updRd = (patch: Partial<typeof rd>) => setBookingDraft(prev => ({ ...prev, recipientDrafts: { ...prev.recipientDrafts, [r.key]: { ...prev.recipientDrafts[r.key], ...patch } } }));
                                const updLs = (patch: Partial<typeof ls>) => updRd({ lifestyle: { ...ls, ...patch } });
                                return (
                                  <div key={r.key} className="px-4 py-3 space-y-3">
                                    {/* Recipient header */}
                                    <div className="flex items-center gap-2">
                                      <div className="w-7 h-7 rounded-full bg-primary-100 flex items-center justify-center shrink-0 overflow-hidden">
                                        {r.photoURL
                                          ? <img src={r.photoURL} alt={r.name} className="w-full h-full object-cover" />
                                          : <span className="text-primary-700 font-bold text-xs">{r.name.split(' ').map((p: string) => p[0]).join('').slice(0,2).toUpperCase()}</span>}
                                      </div>
                                      <div>
                                        <p className="text-sm font-bold text-slate-800">{r.name}</p>
                                        {(r.relationship || r.age) && <p className="text-xs text-slate-400">{[r.relationship, r.age ? `Age ${r.age}` : ''].filter(Boolean).join(' · ')}</p>}
                                      </div>
                                    </div>

                                    {/* Care needs */}
                                    <div>
                                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                                        Care Needs{editingBookingDetails && <span className="font-normal normal-case text-slate-400 ml-1">— tap to include or exclude</span>}
                                      </p>
                                      {editingBookingDetails ? (
                                        <div className="space-y-2">
                                          {Object.keys(CARE_NEED_SUBS).map(need => {
                                            const needOn = rd.careNeeds.includes(need);
                                            const allSubs = CARE_NEED_SUBS[need];
                                            return (
                                              <div key={need} className={`rounded-xl border-2 px-3 py-2.5 transition-colors ${needOn ? 'border-primary-300 bg-primary-50' : 'border-slate-200 bg-white'}`}>
                                                <button type="button" onClick={() => {
                                                  if (needOn) { const nd = { ...rd.careNeedDetails }; delete nd[need]; updRd({ careNeeds: rd.careNeeds.filter(n => n !== need), careNeedDetails: nd }); }
                                                  else updRd({ careNeeds: [...rd.careNeeds, need], careNeedDetails: { ...rd.careNeedDetails, [need]: [] } });
                                                }} className="flex items-center gap-2.5 w-full text-left">
                                                  <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${needOn ? 'border-primary-500 bg-primary-500' : 'border-slate-300 bg-white'}`}>
                                                    {needOn && <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                                                  </div>
                                                  <span className={`text-sm font-semibold ${needOn ? 'text-slate-800' : 'text-slate-500'}`}>{need}</span>
                                                </button>
                                                {needOn && allSubs.length > 0 && (
                                                  <div className="flex flex-wrap gap-1.5 mt-2 pl-6">
                                                    {allSubs.map(task => {
                                                      const taskOn = (rd.careNeedDetails[need] || []).includes(task);
                                                      return (
                                                        <button key={task} type="button"
                                                          onClick={() => updRd({ careNeedDetails: { ...rd.careNeedDetails, [need]: taskOn ? (rd.careNeedDetails[need] || []).filter(t => t !== task) : [...(rd.careNeedDetails[need] || []), task] } })}
                                                          className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${taskOn ? 'bg-primary-500 border-primary-500 text-white' : 'bg-white border-slate-300 text-slate-500 hover:border-primary-300'}`}>
                                                          {task}
                                                        </button>
                                                      );
                                                    })}
                                                  </div>
                                                )}
                                              </div>
                                            );
                                          })}
                                        </div>
                                      ) : (
                                        <div className="space-y-2">
                                          {rd.careNeeds.length === 0
                                            ? <span className="text-xs text-slate-400">None selected</span>
                                            : rd.careNeeds.map(n => {
                                              const tasks = rd.careNeedDetails[n] || [];
                                              return (
                                                <div key={n} className="rounded-xl border-2 border-primary-300 overflow-hidden">
                                                  <div className="px-4 py-3" style={{ backgroundColor: '#dbeafe' }}>
                                                    <p className="text-sm font-bold text-primary-700">{n}</p>
                                                  </div>
                                                  {tasks.length > 0 && (
                                                    <div className="px-4 py-3 flex flex-wrap gap-2" style={{ backgroundColor: '#f5f9ff' }}>
                                                      {tasks.map(t => <span key={t} className="px-3 py-1 rounded-full border border-slate-200 bg-white text-xs font-medium text-slate-600">{t}</span>)}
                                                    </div>
                                                  )}
                                                </div>
                                              );
                                            })
                                          }
                                        </div>
                                      )}
                                    </div>

                                    {/* Lifestyle */}
                                    <div>
                                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Lifestyle & Preferences</p>
                                      {editingBookingDetails ? (
                                        <div className="space-y-3">
                                          {([
                                            { label: 'FAVORITE ACTIVITIES', key: 'favoriteActivities' as const, otherKey: 'favoriteActivitiesOther' as const, opts: LIFESTYLE_FAVORITES },
                                            { label: 'ENTERTAINMENT', key: 'entertainment' as const, otherKey: 'entertainmentOther' as const, opts: LIFESTYLE_ENTERTAINMENT },
                                          ] as const).map(({ label, key, otherKey, opts }) => (
                                            <div key={key}>
                                              <p className="text-[10px] font-semibold text-slate-400 tracking-wide mb-1.5">{label}</p>
                                              <div className="flex flex-wrap gap-1.5">
                                                {opts.map(opt => { const on = ls[key].includes(opt); return <button key={opt} type="button" onClick={() => updLs({ [key]: on ? ls[key].filter((v: string) => v !== opt) : [...ls[key], opt] })} className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${on ? 'bg-primary-500 text-white border-primary-500' : 'bg-white text-slate-600 border-slate-200 hover:border-primary-300'}`}>{opt}</button>; })}
                                              </div>
                                              {ls[key].includes('Other') && (
                                                <input
                                                  type="text"
                                                  value={ls[otherKey]}
                                                  onChange={e => updLs({ [otherKey]: e.target.value })}
                                                  placeholder="Describe other…"
                                                  className="mt-2 w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary-300"
                                                />
                                              )}
                                            </div>
                                          ))}
                                          {([
                                            { label: 'ENJOYS CONVERSATION', key: 'enjoysConversation' as const },
                                            { label: 'PREFERS QUIET', key: 'prefersQuiet' as const },
                                            { label: 'FAMILY IN AREA', key: 'familyInArea' as const },
                                            { label: 'FRIENDS OR VISITORS', key: 'friendsVisitors' as const },
                                            { label: 'HAS APPOINTMENTS', key: 'hasAppointments' as const },
                                          ] as const).map(({ label, key }) => (
                                            <div key={key}>
                                              <p className="text-[10px] font-semibold text-slate-400 tracking-wide mb-1.5">{label}</p>
                                              <div className="flex gap-2">
                                                {([true, false] as const).map(val => <button key={String(val)} type="button" onClick={() => updLs({ [key]: ls[key] === val ? null : val })} className={`text-xs px-4 py-1.5 rounded-full border transition-colors ${ls[key] === val ? (val ? 'bg-primary-500 text-white border-primary-500' : 'bg-slate-600 text-white border-slate-600') : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}>{val ? 'Yes' : 'No'}</button>)}
                                              </div>
                                            </div>
                                          ))}
                                          {ls.familyInArea === true && (
                                            <div>
                                              <p className="text-[10px] font-semibold text-slate-400 tracking-wide mb-1.5">FAMILY VISIT FREQUENCY</p>
                                              <div className="flex flex-wrap gap-1.5">{VISIT_FREQS.map(f => <button key={f} type="button" onClick={() => updLs({ familyVisitFreq: ls.familyVisitFreq === f ? '' : f })} className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${ls.familyVisitFreq === f ? 'bg-primary-500 text-white border-primary-500' : 'bg-white text-slate-600 border-slate-200 hover:border-primary-300'}`}>{f}</button>)}</div>
                                            </div>
                                          )}
                                          {ls.friendsVisitors === true && (
                                            <div>
                                              <p className="text-[10px] font-semibold text-slate-400 tracking-wide mb-1.5">FRIENDS VISIT FREQUENCY</p>
                                              <div className="flex flex-wrap gap-1.5">{VISIT_FREQS.map(f => <button key={f} type="button" onClick={() => updLs({ friendsVisitFreq: ls.friendsVisitFreq === f ? '' : f })} className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${ls.friendsVisitFreq === f ? 'bg-primary-500 text-white border-primary-500' : 'bg-white text-slate-600 border-slate-200 hover:border-primary-300'}`}>{f}</button>)}</div>
                                            </div>
                                          )}
                                          {ls.hasAppointments === true && (
                                            <div>
                                              <p className="text-[10px] font-semibold text-slate-400 tracking-wide mb-1.5">APPOINTMENT DETAILS</p>
                                              <input
                                                type="text"
                                                value={ls.appointmentsDetails}
                                                onChange={e => updLs({ appointmentsDetails: e.target.value })}
                                                placeholder="e.g. doctor visits every Tuesday…"
                                                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary-300"
                                              />
                                            </div>
                                          )}
                                        </div>
                                      ) : hasLifestyle ? (
                                        <div className="space-y-2">
                                          {ls.favoriteActivities.length > 0 && <div><p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Enjoys</p><div className="flex flex-wrap gap-1.5">{ls.favoriteActivities.map(a => <span key={a} className="text-xs bg-violet-50 text-violet-700 border border-violet-200 px-2.5 py-1 rounded-full font-medium">{a}</span>)}</div>{ls.favoriteActivitiesOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.favoriteActivitiesOther}</p>}</div>}
                                          {ls.helpActivities.length > 0 && <div><p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Needs help with</p><div className="flex flex-wrap gap-1.5">{ls.helpActivities.map(a => <span key={a} className="text-xs bg-orange-50 text-orange-700 border border-orange-200 px-2.5 py-1 rounded-full font-medium">{a}</span>)}</div>{ls.helpActivitiesOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.helpActivitiesOther}</p>}</div>}
                                          {ls.entertainment.length > 0 && <div><p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Entertainment</p><div className="flex flex-wrap gap-1.5">{ls.entertainment.map(e => <span key={e} className="text-xs bg-pink-50 text-pink-700 border border-pink-200 px-2.5 py-1 rounded-full font-medium">{e}</span>)}</div>{ls.entertainmentOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.entertainmentOther}</p>}</div>}
                                          {([
                                            { label: 'Enjoys conversation', key: 'enjoysConversation' as const },
                                            { label: 'Prefers quiet', key: 'prefersQuiet' as const },
                                            { label: 'Family in area', key: 'familyInArea' as const },
                                            { label: 'Friends or visitors', key: 'friendsVisitors' as const },
                                            { label: 'Has appointments', key: 'hasAppointments' as const },
                                          ]).filter(({ key }) => ls[key] !== null).map(({ label, key }) => (
                                            <React.Fragment key={key}>
                                              <div className="flex items-center justify-between text-xs">
                                                <span className="text-slate-500 font-medium">{label}</span>
                                                <span className={`px-2.5 py-0.5 rounded-full font-semibold ${ls[key] === true ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>{ls[key] === true ? 'Yes' : 'No'}</span>
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
                                          {ls.hasAppointments === true && ls.appointmentsDetails && <p className="text-xs text-slate-500"><span className="font-medium text-slate-400">Appointments:</span> {ls.appointmentsDetails}</p>}
                                        </div>
                                      ) : <p className="text-xs text-slate-400">Not specified — click Edit to add</p>}
                                    </div>
                                  </div>
                                );
                              })
                            }

                            {/* Care location */}
                            <div className="px-4 py-3">
                              <div className="flex items-center justify-between mb-2">
                                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Care Location</p>
                                {!editingBookingDetails && !d.selectedAddress && (
                                  <span className="text-xs font-semibold text-amber-600">Required</span>
                                )}
                              </div>
                              {editingBookingDetails ? (() => {
                                const pool = loadedPlan.locationPool.length > 0
                                  ? loadedPlan.locationPool
                                  : loadedPlan.primaryAddress
                                    ? [{ street: loadedPlan.primaryAddress, city: '', state: '', zipCode: '' }]
                                    : [];
                                if (pool.length === 0) return <p className="text-xs text-slate-400">No address on file — update your profile</p>;
                                return (
                                  <div className="space-y-2">
                                    {pool.map((loc: any, i: number) => {
                                      const addr = loc.street?.includes(',')
                                        ? loc.street
                                        : [loc.street, loc.city, loc.state, loc.zipCode].filter(Boolean).join(', ');
                                      const selected = d.selectedAddress === addr;
                                      const tags: string[] = [];
                                      if (loc.petsInHome) tags.push('Pets in home');
                                      if (loc.smokingHousehold) tags.push('Smoking household');
                                      return (
                                        <button key={i} type="button"
                                          onClick={() => upd({ selectedAddress: addr, lifestyleNotes: tags })}
                                          className={`w-full text-left rounded-xl border-2 px-3 py-2.5 transition-colors ${selected ? 'border-primary-400 bg-primary-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                                          <div className="flex items-start gap-2">
                                            <MapPin className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${selected ? 'text-primary-500' : 'text-slate-400'}`} />
                                            <div>
                                              <p className={`text-sm font-medium ${selected ? 'text-primary-700' : 'text-slate-700'}`}>{addr}</p>
                                              {tags.length > 0 && (
                                                <div className="flex flex-wrap gap-1 mt-1">
                                                  {tags.map(t => <span key={t} className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full">{t}</span>)}
                                                </div>
                                              )}
                                            </div>
                                          </div>
                                        </button>
                                      );
                                    })}
                                  </div>
                                );
                              })() : d.selectedAddress ? (
                                <>
                                  <p className="text-sm text-slate-700 flex items-center gap-1.5 mb-1.5"><MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />{d.selectedAddress}</p>
                                  {d.lifestyleNotes.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5">
                                      {d.lifestyleNotes.map(l => <span key={l} className="text-xs bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-1 rounded-full font-medium">{l}</span>)}
                                    </div>
                                  )}
                                </>
                              ) : (
                                <p className="text-xs text-amber-600">Select the care location — click <strong>Edit</strong> above</p>
                              )}
                            </div>

                            {/* Emergency contact */}
                            <div className="px-4 py-3">
                              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Emergency Contact</p>
                              {editingBookingDetails ? (
                                <div className="grid grid-cols-2 gap-2">
                                  <input value={d.emergencyContactFirstName} onChange={e => upd({ emergencyContactFirstName: e.target.value })} placeholder="First name" className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300" />
                                  <input value={d.emergencyContactLastName} onChange={e => upd({ emergencyContactLastName: e.target.value })} placeholder="Last name" className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300" />
                                  <input value={d.emergencyContactRelation} onChange={e => upd({ emergencyContactRelation: e.target.value })} placeholder="Relationship" className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300" />
                                  <input value={d.emergencyContactPhone} onChange={e => upd({ emergencyContactPhone: e.target.value })} placeholder="Phone number" className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300" />
                                </div>
                              ) : ecName ? (
                                <div className="space-y-0.5">
                                  <p className="font-semibold text-slate-900 text-sm">{ecName}</p>
                                  <div className="flex items-center gap-3 flex-wrap">
                                    {d.emergencyContactRelation && <span className="text-xs text-slate-500 capitalize">{d.emergencyContactRelation}</span>}
                                    {d.emergencyContactPhone && <span className="text-xs text-slate-500 flex items-center gap-1"><Phone className="w-3 h-3" />{d.emergencyContactPhone}</span>}
                                  </div>
                                </div>
                              ) : (
                                <p className="text-xs text-amber-600">No emergency contact on file — click Edit to add one</p>
                              )}
                            </div>

                          </div>
                        </div>
                      );
                    })()}

                    {/* Note to caregiver */}
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                        Message to {sendBookingFor.caregiverName.split(' ')[0]} <span className="font-normal normal-case text-slate-400">(optional)</span>
                      </label>
                      <textarea
                        value={d.note}
                        onChange={e => upd({ note: e.target.value })}
                        placeholder="Add any details or instructions..."
                        rows={3}
                        className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-300"
                      />
                    </div>

                  </>
                )}
              </div>

              {/* Schedule warnings */}
              {(() => {
                if (editingBookingDetails) return null;
                const DAY_ORDER = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
                const jobPostDays: string[] = loadedPost?.daysOfWeek || (sendBookingFor.jobId ? posts.find(p => p.id === sendBookingFor.jobId)?.daysOfWeek : undefined) || [];
                const scheduledDays = Object.keys(bookingDraft.dayShiftTimes);
                const missingDays = jobPostDays.filter(d => !scheduledDays.includes(d)).sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
                const noTimeDays = scheduledDays.filter(day => !(bookingDraft.dayShiftTimes[day] || []).some(b => b.start && b.end)).sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
                if (missingDays.length === 0 && noTimeDays.length === 0) return null;
                return (
                  <div className="mx-6 mb-3 space-y-2">
                    {missingDays.length > 0 && (
                      <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                        <svg className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
                        <p className="text-xs text-amber-700">
                          <span className="font-semibold">{missingDays.join(', ')} {missingDays.length === 1 ? 'is' : 'are'} not included</span> in the schedule. The caregiver won't see {missingDays.length === 1 ? 'that day' : 'those days'}. Click Edit to add {missingDays.length === 1 ? 'it' : 'them'} back if needed.
                        </p>
                      </div>
                    )}
                    {noTimeDays.length > 0 && (
                      <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                        <svg className="w-4 h-4 text-red-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
                        <p className="text-xs text-red-700">
                          <span className="font-semibold">{noTimeDays.join(', ')} {noTimeDays.length === 1 ? 'is' : 'are'} missing shift hours.</span> Please click Edit and set the start and end time for {noTimeDays.length === 1 ? 'that day' : 'each day'} before sending.
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Pending confirmations — shown above footer so user knows what's blocking Send */}
              {!editingBookingDetails && schedulePrePopulated && !scheduleConfirmed && Object.keys(bookingDraft.dayShiftTimes).some(day => (bookingDraft.dayShiftTimes[day] || []).some(b => b.start && b.end)) && (
                <div className="px-6 py-3 border-t border-slate-100 bg-amber-50 flex flex-col gap-2 shrink-0">
                  <p className="text-xs font-semibold text-amber-800">Please confirm before sending:</p>
                  <button type="button" onClick={() => setScheduleConfirmed(true)}
                    className="self-start text-xs font-semibold text-primary-600 border border-primary-300 bg-white px-3 py-1.5 rounded-lg hover:bg-primary-50 transition-colors flex items-center gap-1">
                    <Calendar className="w-3 h-3" /> Confirm schedule
                  </button>
                </div>
              )}

              {/* Footer */}
              <div className="px-6 py-4 border-t border-slate-100 flex gap-2 shrink-0">
                <button
                  onClick={() => setSendBookingFor(null)}
                  className="flex-1 px-4 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleSendBooking(sendBookingFor, '')}
                  disabled={sendingBooking || loadingCarePlan || editingBookingDetails
                    || !bookingDraft.agreedRate || !bookingDraft.paymentMethod || !bookingDraft.selectedAddress
                    || Object.keys(bookingDraft.dayShiftTimes).some(day => !(bookingDraft.dayShiftTimes[day] || []).some(b => b.start && b.end))
                    || (schedulePrePopulated && !scheduleConfirmed && Object.keys(bookingDraft.dayShiftTimes).some(day => (bookingDraft.dayShiftTimes[day] || []).some(b => b.start && b.end)))}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50 transition-colors"
                >
                  {sendingBooking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {isResend ? 'Resend Request' : 'Send Booking Request'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Applicants modal */}
      {panelPostId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setPanelPostId(null)} />
          <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
              <div>
                <h2 className="font-bold text-slate-900 text-lg">Applicants</h2>
                <p className="text-xs text-slate-400 mt-0.5">{applicants.filter(a => {
                  const iv = interviews.find(iv => iv.caregiverId === a.caregiverId && iv.jobId === panelPostId);
                  const booking = bookingStatuses[`${a.caregiverId}_${panelPostId}`];
                  return !(iv && ['declined', 'no-response'].includes(iv.status)) && booking?.status !== 'declined';
                }).length} {applicants.length === 1 ? 'person applied' : 'people applied'}</p>
              </div>
              <button onClick={() => setPanelPostId(null)} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors">
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
              {loadingApplicants ? (
                <div className="flex items-center justify-center py-16 text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
                </div>
              ) : applicants.length === 0 ? (
                <div className="text-center py-16 px-6">
                  <User className="w-8 h-8 text-slate-300 mx-auto mb-3" />
                  <p className="font-semibold text-slate-600">No applicants yet</p>
                  <p className="text-sm text-slate-400 mt-1">Caregivers who apply will show up here.</p>
                </div>
              ) : (
                applicants.filter(a => {
                  const iv = interviews.find(iv => iv.caregiverId === a.caregiverId && iv.jobId === panelPostId);
                  const booking = bookingStatuses[`${a.caregiverId}_${panelPostId}`];
                  if (iv && ['declined', 'no-response'].includes(iv.status)) return false;
                  if (booking?.status === 'declined') return false;
                  return true;
                }).map(a => (
                  <div key={a.caregiverId} className="px-6 py-5">
                    {/* Top row: avatar + info */}
                    <div className="flex items-center gap-4 mb-4">
                      <div className="w-12 h-12 rounded-full bg-primary-100 overflow-hidden flex items-center justify-center shrink-0">
                        {a.caregiverPhoto
                          ? <img src={a.caregiverPhoto} alt={a.caregiverName} className="w-full h-full object-cover" />
                          : <span className="text-primary-600 font-bold text-base">{a.caregiverName?.charAt(0)?.toUpperCase()}</span>}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-slate-900">{a.caregiverName}</p>
                        <div className="flex items-center gap-3 mt-0.5">
                          {a.rating != null && (
                            <span className="flex items-center gap-1 text-xs text-amber-500 font-medium">
                              <Star className="w-3 h-3 fill-amber-400 stroke-amber-400" />{a.rating.toFixed(1)}
                            </span>
                          )}
                          {a.experience != null && <span className="text-xs text-slate-400">{a.experience} yrs exp</span>}
                          {a.appliedAt && !isNaN(new Date(a.appliedAt).getTime()) && (
                            <span className="text-xs text-slate-400">· {new Date(a.appliedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Cover letter */}
                    {a.coverLetter && (
                      <p className="text-sm text-slate-600 italic bg-slate-50 rounded-xl px-4 py-3 mb-4 break-words leading-relaxed">
                        "{a.coverLetter}"
                      </p>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => navigate(`/client/caregiver/${a.caregiverId}`)}
                        className="px-4 py-2 border border-slate-200 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        Profile
                      </button>
                      <button
                        onClick={() => { setPanelPostId(null); gate('message', a.caregiverName, () => navigate(`/client/inbox?caregiver=${a.caregiverId}`)); }}
                        className="px-4 py-2 border border-slate-200 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        Message
                      </button>
                      {(() => {
                        const iv = interviews.find(iv => iv.caregiverId === a.caregiverId && iv.jobId === panelPostId);
                        const booking = bookingStatuses[`${a.caregiverId}_${panelPostId}`];
                        const isHired = booking?.status === 'accepted';
                        const hasBooking = !!booking;
                        const interviewInProgress = iv && ['pending', 'accepted', 'confirmed'].includes(iv.status);
                        const interviewDone = iv && iv.status === 'completed';
                        const locked = isHired || hasBooking || interviewInProgress || interviewDone;

                        const interviewLabel = isHired ? 'Hired'
                          : hasBooking ? 'Booking Sent'
                          : interviewDone ? 'Interviewed'
                          : 'Interview Sent';

                        return (
                          <>
                            {locked ? (
                              <button disabled className="flex-1 py-2 bg-slate-100 text-slate-400 rounded-lg text-sm font-semibold cursor-not-allowed">
                                {interviewLabel}
                              </button>
                            ) : (
                              <button
                                onClick={() => { setPanelPostId(null); gate('interview', a.caregiverName, () => setSchedulingFor(a)); }}
                                className="flex-1 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg text-sm font-semibold transition-colors"
                              >
                                Request Interview
                              </button>
                            )}
                            <button
                              onClick={() => !locked && handleDeclineApplicant(a)}
                              disabled={decliningApplicant === a.caregiverId || locked}
                              className="px-4 py-2 border border-red-100 text-red-500 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                              {decliningApplicant === a.caregiverId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Decline'}
                            </button>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit post modal */}
      {editingPost && (
        <EditJobPostModal
          post={editingPost}
          onClose={() => setEditingPost(null)}
          onSaved={updated => setPosts(prev => prev.map(p => p.id === editingPost.id ? { ...p, ...updated } : p))}
          onShowToast={addToast}
        />
      )}

      {/* Schedule interview — reuse existing modal */}
      {schedulingFor && (
        <ScheduleInterviewModal
          caregiver={{
            uid: schedulingFor.caregiverId,
            id: schedulingFor.caregiverId,
            name: schedulingFor.caregiverName,
            imageUrl: schedulingFor.caregiverPhoto || '',
            photo: schedulingFor.caregiverPhoto || '',
            rating: schedulingFor.rating,
            hourlyRate: schedulingFor.hourlyRate,
          } as any}
          jobPosts={openPosts.map(p => ({ id: p.id, title: p.title, createdAt: p.createdAt }))}
          preselectedJobId={panelPostId || undefined}
          onClose={() => setSchedulingFor(null)}
          onSuccess={msg => { addToast(msg, 'success'); setSchedulingFor(null); }}
          onShowToast={addToast}
        />
      )}
    </div>
  );
};

export default PostsPage;
