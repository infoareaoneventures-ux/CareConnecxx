import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { Search, Loader2, Briefcase, MapPin, Calendar, Clock, Lock, X, FileText, CheckCircle, XCircle, Clock4, Sun, Moon, Users, CreditCard, Banknote, EyeOff, Eye, Car, SlidersHorizontal, Video, Phone, Home, Send } from 'lucide-react';
import { Button } from '../ui/Button';
import { JobPost, Caregiver, AddToastFunction } from '../../types';
import { dbService, normalizeJobPost } from '../../services/api';
import { db } from '../../lib/firebase';
import firebase from '../../lib/firebase';
import { jobApplicationService, useMyApplications } from '../../hooks/useJobApplications';
import { useCareConnex } from '../../context/CareConnexContext';
import { useCaregiverGate } from '../../hooks/useCaregiverGate';
import { Skeleton } from '../ui/Skeleton';

// Pure math — no API calls. Jobs store lat/lng at creation time.
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3959;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// A flexible job stores rate 0 + rateFlexible:true. Rendering "$0/hr" made every
// flexible post look like unpaid work — show "Flexible" instead.
function rateLabel(job: { rate?: number | null; rateFlexible?: boolean } | null | undefined): string {
    if (!job || job.rateFlexible || !job.rate || job.rate <= 0) return 'Flexible';
    return `$${job.rate}/hr`;
}


interface JobBoardProps {
    onShowToast: AddToastFunction;
    profile: Caregiver | null;
    onJobAccepted: () => void;
    hideApplicationsTab?: boolean;
}

// Same half-hour slots ScheduleInterviewModal.tsx's own time picker uses
// (9 AM–6 PM) — matches the site's one existing interview time-picker
// convention rather than a raw native <input type="time">.
const RESCHEDULE_TIME_SLOTS: string[] = (() => {
    const slots: string[] = [];
    for (let hour = 9; hour <= 18; hour++) {
        slots.push(`${hour.toString().padStart(2, '0')}:00`);
        if (hour < 18) slots.push(`${hour.toString().padStart(2, '0')}:30`);
    }
    return slots;
})();

interface InterviewItem {
    id: string;
    clientId: string;
    clientName: string;
    scheduledAt: string;
    createdAt?: string;
    status: 'pending' | 'accepted' | 'confirmed' | 'completed' | 'declined' | 'cancelled';
    notes?: string;
    jobTitle?: string;
    jobId?: string;
    interviewType?: string;
    callUrl?: string;
    source: 'video';
    /** Who proposed reschedulePendingTime. Undefined when there's no pending
     * reschedule proposal. When 'caregiver', this is this caregiver's OWN
     * outgoing proposal — the family needs to act next, not this caregiver. */
    rescheduledBy?: 'client' | 'caregiver';
    /** ISO datetime — a proposed new time for the in-place Reschedule action,
     * awaiting the OTHER party's acceptance. The real scheduledTime/status
     * never change until this is actually accepted — Decline stays fully
     * valid on the current confirmed interview the whole time this is set. */
    reschedulePendingTime?: string;
}

type TabType = 'available' | 'my-applications' | 'interviews' | 'hidden';
type ApplicationStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn';

const StatusBadge: React.FC<{ status: ApplicationStatus }> = ({ status }) => {
  const styles: Record<ApplicationStatus, { icon: React.ReactNode; className: string; label: string }> = {
    pending:   { icon: <Clock4 className="w-3 h-3" />,      className: 'text-[var(--color-warning-600)] bg-[var(--color-warning-50)]',   label: 'Pending' },
    accepted:  { icon: <CheckCircle className="w-3 h-3" />, className: 'text-[var(--color-success-600)] bg-[var(--color-success-50)]',   label: 'Accepted' },
    rejected:  { icon: <XCircle className="w-3 h-3" />,     className: 'text-[var(--color-error-600)] bg-[var(--color-error-50)]',       label: 'Declined by client' },
    withdrawn: { icon: null,                                  className: 'text-[var(--color-neutral-600)] bg-[var(--color-neutral-100)]', label: 'Withdrawn by you' },
  };
  const style = styles[status] || styles.pending;
  return (
    <span className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${style.className}`}>
      {style.icon}{style.label}
    </span>
  );
};

const JobCardSkeleton: React.FC = () => (
    <div className="bg-white p-5 rounded-2xl shadow-sm border border-[var(--color-neutral-100)]">
        <div className="flex justify-between items-start mb-3">
            <div className="flex-1">
                <Skeleton className="h-6 w-2/3 mb-2" />
                <Skeleton className="h-4 w-1/3" />
            </div>
            <Skeleton className="h-6 w-16 rounded-full" />
        </div>
        <div className="bg-[var(--color-neutral-50)] p-3 rounded-xl mb-4 space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
        </div>
        <div className="flex gap-2">
            <Skeleton className="h-10 flex-1 rounded-xl" />
            <Skeleton className="h-10 w-24 rounded-xl" />
        </div>
    </div>
);

const CHIP = (selected: boolean) =>
    `px-3 py-1 rounded-full text-xs font-medium border transition-colors cursor-pointer ${selected ? 'bg-primary-600 border-primary-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'}`;

export const JobBoard: React.FC<JobBoardProps> = ({ onShowToast, profile, onJobAccepted, hideApplicationsTab = false }) => {
    const { blockedIds, setMembershipModalOpen } = useCareConnex();
    const { blockReason, transportBlockReason } = useCaregiverGate();
    const navigate = useNavigate();
    const [jobs, setJobs] = useState<JobPost[]>([]);
    const [jobsLoading, setJobsLoading] = useState(false);
    const [viewingJob, setViewingJob] = useState<JobPost | null>(null);
    const [applyingJob, setApplyingJob] = useState<JobPost | null>(null);
    const [acceptingGigId, setAcceptingGigId] = useState<string | null>(null);
    const [searchParams, setSearchParams] = useSearchParams();
    const [activeTab, setActiveTab] = useState<TabType>(() => {
        const t = searchParams.get('tab');
        if (t === 'applications' || t === 'my-applications') return 'my-applications';
        if (t === 'interviews') return 'interviews';
        return 'available';
    });
    const [coverLetter, setCoverLetter] = useState('');
    const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

    // Filters
    const [searchQuery, setSearchQuery] = useState('');
    const [filterPayMin, setFilterPayMin] = useState<number | ''>('');
    const [filterPayMax, setFilterPayMax] = useState<number | ''>('');
    const [filterTimeOfDay, setFilterTimeOfDay] = useState<string[]>([]);
    const [filterDays, setFilterDays] = useState<string[]>([]);
    const [filterSeniorsCount, setFilterSeniorsCount] = useState<string[]>([]);
    const [filterCareTypes, setFilterCareTypes] = useState<string[]>([]);

    // Interviews
    const [interviews, setInterviews] = useState<InterviewItem[]>([]);
    const [interviewsLoading, setInterviewsLoading] = useState(false);
    const [submittingInterview, setSubmittingInterview] = useState<string | null>(null);
    // Reschedule the SAME interview (no cancel, no new request) while it's
    // still pending or accepted (not yet completed). Sets status back to
    // 'pending' so the family re-confirms the (possibly new) time — same
    // mechanism the client side uses.
    const [rescheduleOpenId, setRescheduleOpenId] = useState<string | null>(null);
    const [rescheduleDate, setRescheduleDate] = useState('');
    const [rescheduleTime, setRescheduleTime] = useState('');
    const [appFilter, setAppFilter] = useState<'pending' | 'closed'>('pending');
    const [ivFilter, setIvFilter] = useState<'all' | 'pending' | 'accepted' | 'confirmed' | 'completed' | 'declined' | 'cancelled'>(() => {
        const f = searchParams.get('filter');
        if (f === 'pending' || f === 'accepted' || f === 'confirmed' || f === 'completed' || f === 'declined' || f === 'cancelled') return f;
        return 'all';
    });

    const [hiddenJobs, setHiddenJobs] = useState<JobPost[]>([]);
    const [hiddenJobsLoading, setHiddenJobsLoading] = useState(false);
    const [cgLat, setCgLat] = useState<number | null>(null);
    const [cgLng, setCgLng] = useState<number | null>(null);

    const LS_APPS_KEY = 'careconnex.jobboard.lastCheckedApps';
    const LS_IVS_KEY  = 'careconnex.jobboard.lastCheckedInterviews';

    const MIN_VALID_TS = new Date('2024-01-01').getTime();

    const [lastCheckedApps, setLastCheckedApps] = useState<number>(() => {
        const v = localStorage.getItem(LS_APPS_KEY);
        const parsed = v ? parseInt(v, 10) : 0;
        if (parsed > MIN_VALID_TS) return parsed;
        const now = Date.now();
        localStorage.setItem(LS_APPS_KEY, String(now));
        return now;
    });
    const [lastCheckedIvs, setLastCheckedIvs] = useState<number>(() => {
        const v = localStorage.getItem(LS_IVS_KEY);
        const parsed = v ? parseInt(v, 10) : 0;
        if (parsed > MIN_VALID_TS) return parsed;
        const now = Date.now();
        localStorage.setItem(LS_IVS_KEY, String(now));
        return now;
    });

    const LS_IV_FILTER_KEY  = (f: string) => `careconnex.jobboard.lastChecked.iv.${f}`;

    const [lastCheckedIvFilter, setLastCheckedIvFilter] = useState<Record<string, number>>(() => {
        const now = Date.now();
        const result: Record<string, number> = {};
        (['pending', 'accepted', 'completed', 'declined', 'cancelled'] as const).forEach(f => {
            const v = localStorage.getItem(`careconnex.jobboard.lastChecked.iv.${f}`);
            const parsed = v ? parseInt(v, 10) : 0;
            if (parsed > MIN_VALID_TS) { result[f] = parsed; }
            else { localStorage.setItem(`careconnex.jobboard.lastChecked.iv.${f}`, String(now)); result[f] = now; }
        });
        return result;
    });

    const { applications, loading: applicationsLoading, withdrawApplication } = useMyApplications(profile?.uid || null);

    useEffect(() => {
        if (activeTab !== 'hidden') return;
        setHiddenJobsLoading(true);
        const hiddenIds: string[] = JSON.parse(localStorage.getItem('careconnex.hiddenJobs') || '[]');
        if (hiddenIds.length === 0) { setHiddenJobs([]); setHiddenJobsLoading(false); return; }
        if (!db) { setHiddenJobsLoading(false); return; }
        db.collection('job_posts').where('status', '==', 'open').get().then(snap => {
            const all = snap.docs.map(d => normalizeJobPost({ id: d.id, ...d.data() }));
            setHiddenJobs(all.filter(j => hiddenIds.includes(j.id)));
        }).catch(() => {}).finally(() => setHiddenJobsLoading(false));
    }, [activeTab]);

    useEffect(() => {
        if (activeTab !== 'available') return;
        if (!db) { setJobsLoading(false); return; }
        setJobsLoading(true);
        const unsubscribe = db.collection('job_posts')
            .where('status', '==', 'open')
            .orderBy('createdAt', 'desc')
            .onSnapshot(
                (snapshot) => {
                    const appliedJobIds = new Set(applications.map(a => a.jobId));
                    const hidden = new Set<string>(JSON.parse(localStorage.getItem('careconnex.hiddenJobs') || '[]'));
                    // normalizeJobPost: legacy Evia-written docs carry location
                    // as an OBJECT (crashes JSX) / summary instead of title —
                    // coerce to the render contract before anything touches them.
                    const allJobs = snapshot.docs.map(doc => normalizeJobPost({ id: doc.id, ...doc.data() }));
                    setJobs(allJobs.filter(job => !appliedJobIds.has(job.id) && !hidden.has(job.id) && (job as any).clientActive !== false));
                    setJobsLoading(false);
                },
                (error) => {
                    console.error('Failed to fetch jobs', error);
                    onShowToast('Failed to load jobs. Please try again.', 'error');
                    setJobsLoading(false);
                }
            );
        return unsubscribe;
    }, [activeTab, applications, onShowToast]);

    // Resolve caregiver coords from profile — used for instant distance math against job.lat/job.lng
    // Falls back to p.lat/p.lng for accounts created before the field-name standardisation
    useEffect(() => {
        if (!profile) return;
        const p = profile as any;
        const resolvedLat = p.latitude ?? p.lat ?? null;
        const resolvedLng = p.longitude ?? p.lng ?? null;
        if (resolvedLat && resolvedLng) {
            setCgLat(resolvedLat);
            setCgLng(resolvedLng);
        }
    }, [profile]);

    useEffect(() => {
        if (!profile?.uid) return;
        const fdb = db;
        if (!fdb) { setInterviewsLoading(false); return; }
        setInterviewsLoading(true);

        const normalizeDate = (raw: any): string => {
            if (!raw) return new Date().toISOString();
            return raw?.toDate ? raw.toDate().toISOString() : String(raw);
        };

        const unsub = fdb.collection('video_interviews')
            .where('caregiverId', '==', profile.uid)
            .onSnapshot(snap => {
                const statusOrder: Record<string, number> = { pending: 0, accepted: 1, confirmed: 2, completed: 3, declined: 4, cancelled: 5 };
                const videoData = snap.docs.map(doc => {
                    const d = doc.data();
                    const rawStatus = d.status || 'pending';
                    const status = rawStatus === 'requested' || rawStatus === 'scheduled' ? 'pending' : rawStatus;
                    return { id: doc.id, clientId: d.clientId || '', clientName: d.clientName || 'Client', scheduledAt: normalizeDate(d.scheduledTime || d.scheduledAt || d.scheduledDateTime), createdAt: normalizeDate(d.createdAt), status, notes: d.notes, jobTitle: d.jobTitle, jobId: d.jobId, interviewType: d.interviewType || 'video', callUrl: d.callUrl, source: 'video' as const, rescheduledBy: d.rescheduledBy || undefined, reschedulePendingTime: d.reschedulePendingTime || undefined };
                });
                videoData.sort((a, b) => {
                    const so = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
                    if (so !== 0) return so;
                    return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
                });
                setInterviews(videoData);
                setInterviewsLoading(false);
            }, () => setInterviewsLoading(false));

        return unsub;
    }, [profile?.uid]);

    const handleApplyToJob = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!applyingJob) return;
        if (!profile) return;
        setAcceptingGigId(applyingJob.id);
        try {
            await jobApplicationService.applyToJob(
                applyingJob.id, applyingJob.title, applyingJob.clientId, applyingJob.clientName,
                { caregiverId: profile.uid, caregiverName: profile.name, caregiverPhoto: profile.photo || profile.imageUrl || '', experience: profile.experience ?? 0, rating: profile.rating ?? undefined, skills: profile.skills || profile.certifications || [] },
                coverLetter,
            );
            onShowToast(`Application submitted for ${applyingJob.title}!`, 'success');
            setApplyingJob(null);
            setCoverLetter('');
            setJobs(prev => prev.filter(j => j.id !== applyingJob.id));
        } catch (e: unknown) {
            const errorMessage = e instanceof Error ? e.message : "Failed to apply for job.";
            onShowToast(errorMessage, 'error');
        } finally {
            setAcceptingGigId(null);
        }
    };

    const handleViewJobDetails = async (jobId: string) => {
        const fdb = db;
        if (!fdb) { onShowToast('Failed to load job details', 'error'); return; }
        try {
            const doc = await fdb.collection('job_posts').doc(jobId).get();
            if (doc.exists) {
                const job = normalizeJobPost({ id: doc.id, ...doc.data() });
                // Apply the same blocked-client / inactive-client filters the job list
                // uses, so a ?job= deep-link (or an Interviews/Applications "Details"
                // link) can't open a job from a blocked or deactivated client.
                if (blockedIds.has(job.clientId) || (job as any).clientActive === false) {
                    onShowToast('This job is no longer available', 'info');
                    return;
                }
                setViewingJob(job);
            } else {
                onShowToast('Job details not available', 'info');
            }
        } catch {
            onShowToast('Failed to load job details', 'error');
        }
    };

    // Auto-open a specific job when navigated here with ?job=<id> (e.g. from dashboard cards)
    useEffect(() => {
        const jobId = searchParams.get('job');
        if (!jobId) return;
        handleViewJobDetails(jobId);
        // Clear the param so the modal can be closed without it reopening
        setSearchParams(prev => { const next = new URLSearchParams(prev); next.delete('job'); return next; }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleWithdrawApplication = async (applicationId: string) => {
        try {
            await withdrawApplication(applicationId);
            onShowToast("Application withdrawn", 'info');
        } catch {
            onShowToast("Failed to withdraw application", 'error');
        }
    };

    const handleAcceptInterview = async (iv: InterviewItem) => {
        if (!db || !profile) return;
        setSubmittingInterview(iv.id);
        try {
            // U3: the client notification is owned by the onVideoInterviewWrite
            // server trigger (accept → client). The old browser peer-write here
            // always failed the notification rule and made this catch show a
            // false "Failed to accept" toast even though the update succeeded.
            await db.collection('video_interviews').doc(iv.id).update({
                status: 'accepted',
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
            onShowToast('Interview accepted', 'success');
        } catch {
            onShowToast('Failed to accept interview', 'error');
        } finally {
            setSubmittingInterview(null);
        }
    };

    // 2026-09-09 (live-caught): only ever wrote status:'declined' — a
    // reschedulePendingTime/rescheduledBy left over from a pending proposal
    // kept rendering the "proposed a new time / waiting to confirm" banner
    // and its buttons on an interview that was already over. Terminal
    // actions must always clear these two fields.
    const handleDeclineInterview = async (iv: InterviewItem) => {
        if (!db || !profile) return;
        setSubmittingInterview(iv.id);
        try {
            // U3: onVideoInterviewWrite owns the client notification (decline →
            // other party). Browser writes only the canonical status.
            await db.collection('video_interviews').doc(iv.id).update({
                status: 'declined',
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                reschedulePendingTime: firebase.firestore.FieldValue.delete(),
                rescheduledBy: firebase.firestore.FieldValue.delete(),
            });
            onShowToast('Interview declined', 'info');
        } catch {
            onShowToast('Failed to decline interview', 'error');
        } finally {
            setSubmittingInterview(null);
        }
    };

    // New: an ACCEPTED interview being called off is a cancellation, not a
    // decline (decline is for an unconfirmed request, cancel is for calling
    // off something already agreed to) — mirrors the client side's Cancel.
    const handleCancelInterview = async (iv: InterviewItem) => {
        if (!db || !profile) return;
        if (!window.confirm('Cancel this interview?')) return;
        setSubmittingInterview(iv.id);
        try {
            await db.collection('video_interviews').doc(iv.id).update({
                status: 'cancelled',
                cancelledBy: 'caregiver',
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                reschedulePendingTime: firebase.firestore.FieldValue.delete(),
                rescheduledBy: firebase.firestore.FieldValue.delete(),
            });
            onShowToast('Interview cancelled', 'info');
        } catch {
            onShowToast('Failed to cancel interview', 'error');
        } finally {
            setSubmittingInterview(null);
        }
    };

    // 2026-09-09 (live-caught): this used to write scheduledTime/status
    // directly, changing the CONFIRMED meeting time before the family ever
    // agreed to it. Store it as a proposal instead — the real scheduledTime
    // (and Decline, which always operates on the actual confirmed interview)
    // stays untouched until the family explicitly accepts.
    const handleRescheduleInterview = async (iv: InterviewItem) => {
        if (!db || !profile || !rescheduleDate || !rescheduleTime) return;
        const scheduledDateTime = new Date(`${rescheduleDate}T${rescheduleTime}:00`);
        if (scheduledDateTime <= new Date()) {
            onShowToast('Please pick a future date and time', 'error');
            return;
        }
        setSubmittingInterview(iv.id);
        try {
            await db.collection('video_interviews').doc(iv.id).update({
                reschedulePendingTime: scheduledDateTime.toISOString(),
                rescheduledBy: 'caregiver',
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
            setRescheduleOpenId(null);
            setRescheduleDate('');
            setRescheduleTime('');
            onShowToast('New time proposed — waiting on the family to confirm', 'success');
        } catch {
            onShowToast('Failed to propose the new time', 'error');
        } finally {
            setSubmittingInterview(null);
        }
    };

    // Accept the family's proposed time — THIS is the moment the real
    // scheduledTime actually changes, same doc throughout.
    const handleAcceptRescheduleProposal = async (iv: InterviewItem) => {
        if (!db || !profile || !iv.reschedulePendingTime) return;
        setSubmittingInterview(iv.id);
        try {
            await db.collection('video_interviews').doc(iv.id).update({
                scheduledTime: iv.reschedulePendingTime,
                status: 'accepted',
                reschedulePendingTime: firebase.firestore.FieldValue.delete(),
                rescheduledBy: firebase.firestore.FieldValue.delete(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
            onShowToast('Interview time confirmed', 'success');
        } catch {
            onShowToast('Failed to confirm the interview time', 'error');
        } finally {
            setSubmittingInterview(null);
        }
    };

    const toggleChip = (list: string[], setList: React.Dispatch<React.SetStateAction<string[]>>, value: string) => {
        setList(prev => prev.includes(value) ? prev.filter(x => x !== value) : [...prev, value]);
    };

    const activeFilterCount = [
        searchQuery !== '',
        filterPayMin !== '',
        filterPayMax !== '',
        filterTimeOfDay.length > 0,
        filterDays.length > 0,
        filterSeniorsCount.length > 0,
        filterCareTypes.length > 0,
    ].filter(Boolean).length;

    const clearFilters = () => {
        setSearchQuery('');
        setFilterPayMin('');
        setFilterPayMax('');
        setFilterTimeOfDay([]);
        setFilterDays([]);
        setFilterSeniorsCount([]);
        setFilterCareTypes([]);
    };

    const filteredJobs = jobs.filter(job => {
        if (blockedIds.has(job.clientId)) return false;
        const q = searchQuery.toLowerCase();
        if (q && !(
            (job.title ?? '').toLowerCase().includes(q) ||
            (job.location ?? '').toLowerCase().includes(q) ||
            (Array.isArray(job.requirements) && job.requirements.some(r => r.toLowerCase().includes(q)))
        )) return false;
        if (filterPayMin !== '' && job.rate < Number(filterPayMin)) return false;
        if (filterPayMax !== '' && job.rate > Number(filterPayMax)) return false;
        if (filterTimeOfDay.length > 0) {
            const tod: string[] = Array.isArray(job.timeOfDay) ? (job.timeOfDay as unknown as string[]) : [];
            if (!filterTimeOfDay.some(t => tod.includes(t))) return false;
        }
        if (filterDays.length > 0) {
            const jDays: string[] = Array.isArray((job as any).daysOfWeek) ? (job as any).daysOfWeek : [];
            if (!filterDays.some(d => jDays.some((jd: string) => jd.toLowerCase().startsWith(d.toLowerCase())))) return false;
        }
        if (filterSeniorsCount.length > 0) {
            const count = (job as any).recipientsCount ?? 1;
            const matches = filterSeniorsCount.some(s => {
                if (s === '1') return count === 1;
                if (s === '2') return count === 2;
                if (s === '3+') return count >= 3;
                return false;
            });
            if (!matches) return false;
        }
        if (filterCareTypes.length > 0) {
            const jct: string[] = Array.isArray(job.careTypes) ? (job.careTypes as unknown as string[]) : [];
            if (!filterCareTypes.some(ct => jct.includes(ct))) return false;
        }
        // Filter out jobs beyond the caregiver's service radius (only when both sets of coords are known)
        const jobLat = (job as any).lat;
        const jobLng = (job as any).lng;
        const cgRadius = (profile as any)?.serviceRadius || (profile as any)?.travelRadius || 0;
        if (cgLat && cgLng && jobLat && jobLng && cgRadius > 0) {
            if (haversineDistance(cgLat, cgLng, jobLat, jobLng) > cgRadius) return false;
        }
        return true;
    });

    // Drop interviews from blocked clients once, up front, so counts, badges,
    // filter chips, empty states, and the rendered list all stay consistent.
    const visibleInterviews = interviews.filter(iv => !blockedIds.has(iv.clientId));


    // Reusable filter panel content (shared between sidebar and mobile drawer)
    const FilterPanel = (
        <div className="space-y-5">
            {/* Search */}
            <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Search</label>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                        type="text"
                        placeholder="Area or skill..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    />
                </div>
            </div>

            {/* Pay rate */}
            <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Pay Rate ($/hr)</label>
                <div className="flex items-center gap-2">
                    <input
                        type="number"
                        placeholder="Min"
                        value={filterPayMin}
                        onChange={e => setFilterPayMin(e.target.value === '' ? '' : Number(e.target.value))}
                        min={0}
                        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    />
                    <span className="text-slate-400 text-sm flex-shrink-0">–</span>
                    <input
                        type="number"
                        placeholder="Max"
                        value={filterPayMax}
                        onChange={e => setFilterPayMax(e.target.value === '' ? '' : Number(e.target.value))}
                        min={0}
                        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    />
                </div>
            </div>

            {/* Time of day */}
            <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Time of Day</label>
                <div className="space-y-1.5">
                    {([
                        ['morning', 'Morning', '6am–12pm'],
                        ['afternoon', 'Afternoon', '12pm–6pm'],
                        ['evening', 'Evening', '6pm–12am'],
                        ['overnight', 'Overnight', '12am–6am'],
                    ] as const).map(([val, label, hours]) => (
                        <label key={val} className="flex items-center gap-2 cursor-pointer text-sm text-slate-700">
                            <input
                                type="checkbox"
                                checked={filterTimeOfDay.includes(val)}
                                onChange={() => toggleChip(filterTimeOfDay, setFilterTimeOfDay, val)}
                                className="accent-teal-600 rounded"
                            />
                            <span>{label}</span>
                            <span className="text-xs text-slate-400 ml-auto">{hours}</span>
                        </label>
                    ))}
                </div>
            </div>

            {/* Days of week */}
            <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Days</label>
                <div className="flex flex-wrap gap-1.5">
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
                        <button key={d} onClick={() => toggleChip(filterDays, setFilterDays, d)} className={CHIP(filterDays.includes(d))}>
                            {d}
                        </button>
                    ))}
                </div>
            </div>

            {/* Number of seniors */}
            <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Seniors in Home</label>
                <div className="space-y-1.5">
                    {(['1', '2', '3+'] as const).map(v => (
                        <label key={v} className="flex items-center gap-2 cursor-pointer text-sm text-slate-700">
                            <input
                                type="checkbox"
                                checked={filterSeniorsCount.includes(v)}
                                onChange={() => toggleChip(filterSeniorsCount, setFilterSeniorsCount, v)}
                                className="accent-teal-600 rounded"
                            />
                            {v} {v === '1' ? 'senior' : 'seniors'}
                        </label>
                    ))}
                </div>
            </div>

            {/* Care type */}
            <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Care Type</label>
                <div className="space-y-1.5">
                    {(['Mobility Assistance', 'Dementia / Memory Care', 'Medication Reminders', 'Personal Care', 'Companionship', 'Transportation', 'Meal Preparation', 'Light Housekeeping'] as const).map(ct => (
                        <label key={ct} className="flex items-center gap-2 cursor-pointer text-sm text-slate-700">
                            <input
                                type="checkbox"
                                checked={filterCareTypes.includes(ct)}
                                onChange={() => toggleChip(filterCareTypes, setFilterCareTypes, ct)}
                                className="accent-teal-600 rounded"
                            />
                            {ct}
                        </label>
                    ))}
                </div>
            </div>

            {activeFilterCount > 0 && (
                <button
                    onClick={clearFilters}
                    className="w-full text-sm text-primary-600 font-medium hover:text-primary-700 py-2 border border-primary-100 rounded-lg hover:bg-primary-50 transition-colors"
                >
                    Clear all filters ({activeFilterCount})
                </button>
            )}
        </div>
    );

    return (
    <>
        <div className="animate-slide-in">
            {/* Tabs */}
            {(() => {
                const tsMs = (v: any): number => {
                    if (!v) return 0;
                    if (typeof v.toMillis === 'function') return v.toMillis();
                    if (typeof v.toDate === 'function') return v.toDate().getTime();
                    const ms = new Date(v).getTime();
                    return isNaN(ms) ? 0 : ms;
                };
                const newApps = applications.filter(a => tsMs(a.appliedAt) > lastCheckedApps).length;
                const newIvs  = visibleInterviews.filter(iv => tsMs(iv.createdAt || iv.scheduledAt) > lastCheckedIvs).length;

                const markApps = () => {
                    const now = Date.now();
                    localStorage.setItem(LS_APPS_KEY, String(now));
                    setLastCheckedApps(now);
                    setActiveTab('my-applications');
                };
                const markIvs = () => {
                    const now = Date.now();
                    localStorage.setItem(LS_IVS_KEY, String(now));
                    setLastCheckedIvs(now);
                    setActiveTab('interviews');
                };

                return (
                    <div className="flex flex-wrap gap-2 mb-6">
                        <button
                            onClick={() => setActiveTab('available')}
                            className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors ${activeTab === 'available' ? 'bg-primary-500 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
                        >
                            Available Jobs
                        </button>
                        {!hideApplicationsTab && (
                            <button
                                onClick={markApps}
                                className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors ${activeTab === 'my-applications' ? 'bg-primary-500 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
                            >
                                My Applications
                                {newApps > 0 && activeTab !== 'my-applications' && (
                                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
                                        {newApps}
                                    </span>
                                )}
                            </button>
                        )}
                        <button
                            onClick={markIvs}
                            className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors ${activeTab === 'interviews' ? 'bg-primary-500 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
                        >
                            Interviews
                            {newIvs > 0 && activeTab !== 'interviews' && (
                                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
                                    {newIvs}
                                </span>
                            )}
                        </button>
                    </div>
                );
            })()}

            {/* ── Available Jobs ── two-column layout with left filter sidebar */}
            {activeTab === 'available' && (
                <>
                    {/* Mobile: Filters button */}
                    <div className="lg:hidden mb-4 flex items-center justify-between">
                        <p className="text-sm text-slate-500">{filteredJobs.length} job{filteredJobs.length !== 1 ? 's' : ''} found</p>
                        <button
                            onClick={() => setMobileFiltersOpen(true)}
                            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border rounded-xl transition-colors ${activeFilterCount > 0 ? 'bg-primary-50 border-primary-400 text-primary-700' : 'bg-white border-slate-200 text-slate-600'}`}
                        >
                            <SlidersHorizontal className="w-4 h-4" />
                            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
                        </button>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
                        {/* Filter sidebar — desktop */}
                        <aside className="hidden lg:block">
                            <div className="bg-white rounded-xl border border-slate-200 p-5 sticky top-20">
                                <h2 className="font-semibold text-slate-900 mb-4 flex items-center gap-2">
                                    <SlidersHorizontal className="w-4 h-4" />
                                    Filters
                                </h2>
                                {FilterPanel}
                                {activeTab === 'available' && (
                                    <button
                                        onClick={() => setActiveTab('hidden')}
                                        className="mt-4 flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors w-full"
                                    >
                                        <EyeOff className="w-3.5 h-3.5" />
                                        View hidden jobs{(() => { const ids = JSON.parse(localStorage.getItem('careconnex.hiddenJobs') || '[]'); return ids.length > 0 ? ` (${ids.length})` : ''; })()}
                                    </button>
                                )}
                                {(activeTab as string) === 'hidden' && (
                                    <button
                                        onClick={() => setActiveTab('available')}
                                        className="mt-4 flex items-center gap-1.5 text-xs text-primary-600 hover:text-primary-700 transition-colors w-full font-medium"
                                    >
                                        ← Back to available jobs
                                    </button>
                                )}
                            </div>
                        </aside>

                        {/* Job list */}
                        <section>
                            <p className="hidden lg:block text-sm text-slate-500 mb-3">{filteredJobs.length} job{filteredJobs.length !== 1 ? 's' : ''} found</p>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {jobsLoading ? (
                                    <>
                                        <JobCardSkeleton />
                                        <JobCardSkeleton />
                                        <JobCardSkeleton />
                                    </>
                                ) : filteredJobs.length === 0 ? (
                                    <div className="text-center p-8 text-[var(--color-neutral-400)] bg-[var(--color-neutral-50)] rounded-2xl">
                                        <Briefcase className="w-12 h-12 mx-auto mb-2 opacity-30" />
                                        <p>{activeFilterCount > 0 ? 'No jobs match your filters.' : 'No open jobs right now.'}</p>
                                    </div>
                                ) : (
                                    filteredJobs.map((job) => (
                                        <div key={job.id} className="bg-white p-5 rounded-2xl shadow-sm border border-[var(--color-neutral-100)] hover:border-[var(--color-primary-200)] transition-all relative overflow-hidden">
                                            {acceptingGigId === job.id && (
                                                <div className="absolute inset-0 bg-white/80 backdrop-blur-sm z-20 flex items-center justify-center">
                                                    <div className="flex flex-col items-center">
                                                        <Loader2 className="w-8 h-8 text-[var(--color-primary-600)] animate-spin mb-2" />
                                                        <span className="font-bold text-[var(--color-primary-800)]">Applying...</span>
                                                    </div>
                                                </div>
                                            )}

                                            <div className="flex justify-between items-start mb-3">
                                                <div className="flex-1 min-w-0">
                                                    <h4 className="font-bold text-[var(--color-neutral-900)] text-lg">{job.title}</h4>
                                                    <div className="flex items-center text-sm text-[var(--color-neutral-500)] mt-1 gap-3 flex-wrap">
                                                        <span className="flex items-center"><MapPin className="w-3 h-3 mr-1" /> {job.location}</span>
                                                        {cgLat && cgLng && (job as any).lat && (job as any).lng && (
                                                            <span className="text-xs">({haversineDistance(cgLat, cgLng, (job as any).lat, (job as any).lng).toFixed(1)} mi away)</span>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="text-right flex-shrink-0">
                                                    <span className="bg-[var(--color-success-100)] text-[var(--color-success-700)] text-sm font-bold px-3 py-1 rounded-full">
                                                        {rateLabel(job)}
                                                    </span>
                                                    {job.paymentMethod && (
                                                        <p className="text-[10px] text-slate-400 mt-1 flex items-center justify-end gap-1">
                                                            {job.paymentMethod === 'credit' ? <CreditCard className="w-3 h-3" /> : <Banknote className="w-3 h-3" />}
                                                            via {job.paymentMethod}
                                                        </p>
                                                    )}
                                                </div>
                                            </div>

                                            <div className="flex flex-wrap gap-2 mb-3">
                                                {(() => {
                                                    const freq = job.jobFrequency || (job.minHoursPerWeek && job.minHoursPerWeek >= 32 ? 'full-time' : job.minHoursPerWeek ? 'part-time' : 'occasional');
                                                    const freqLabel: Record<string,string> = { 'one-time': 'Occasional', 'occasional': 'Occasional', 'part-time': 'Part-time', 'full-time': 'Full-time' };
                                                    return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-700 text-[11px] font-semibold uppercase tracking-wide">{freqLabel[freq] || freq}</span>;
                                                })()}
                                                {(Array.isArray(job.timeOfDay) ? job.timeOfDay : []).some((t: any) => t === 'morning' || t === 'afternoon') && (
                                                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-700 text-[11px] font-medium"><Sun className="w-3 h-3" /> Day</span>
                                                )}
                                                {(Array.isArray(job.timeOfDay) ? job.timeOfDay : []).some((t: any) => t === 'evening' || t === 'overnight') && (
                                                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-[11px] font-medium"><Moon className="w-3 h-3" /> Night</span>
                                                )}
                                                {job.recipientsCount && job.recipientsCount > 1 && (
                                                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[11px] font-medium"><Users className="w-3 h-3" /> {job.recipientsCount} seniors</span>
                                                )}
                                                {(job.careTypes?.includes('Transportation') || job.requirements?.includes('Driving')) && (
                                                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[11px] font-medium"><Car className="w-3 h-3" /> Transportation</span>
                                                )}
                                            </div>

                                            <div className="bg-[var(--color-neutral-50)] p-3 rounded-xl mb-4 text-sm text-[var(--color-neutral-600)]">
                                                <div className="flex items-center mb-1">
                                                    <Calendar className="w-4 h-4 mr-2 text-[var(--color-neutral-400)]" />
                                                    {job.date === 'Tomorrow' || job.date === 'Today' ? job.date : (() => { const d = new Date(job.date + 'T12:00:00'); return isNaN(d.getTime()) ? job.date : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); })()}
                                                </div>
                                                <div className="flex items-center">
                                                    <Clock className="w-4 h-4 mr-2 text-[var(--color-neutral-400)]" />
                                                    {job.startTime && job.endTime && job.startTime !== '-'
                                                        ? `${job.startTime} – ${job.endTime}`
                                                        : Array.isArray(job.timeOfDay) && job.timeOfDay.length > 0
                                                            ? (job.timeOfDay as string[]).map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(', ')
                                                            : 'Flexible hours'}
                                                </div>
                                            </div>

                                            <div className="flex gap-2">
                                                {(() => {
                                                    const jobRequiresTransport = job.careTypes?.includes('Transportation') || job.requirements?.includes('Driving');
                                                    const reason = jobRequiresTransport ? transportBlockReason : blockReason;
                                                    if (reason === 'membership') return (
                                                        <button onClick={() => setMembershipModalOpen(true)} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-slate-100 text-slate-500 border border-slate-200 hover:bg-slate-200 text-xs font-semibold transition-colors">
                                                            <Lock className="w-3 h-3" /> Activate Membership
                                                        </button>
                                                    );
                                                    if (reason === 'background') return (
                                                        <button onClick={() => navigate('/caregiver/dashboard')} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-slate-100 text-slate-500 border border-slate-200 hover:bg-slate-200 text-xs font-semibold transition-colors">
                                                            <Lock className="w-3 h-3" /> Complete Verification
                                                        </button>
                                                    );
                                                    if (reason === 'transport') return (
                                                        <button onClick={() => navigate('/caregiver/settings')} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-orange-50 text-orange-500 border border-orange-200 hover:bg-orange-100 text-xs font-semibold transition-colors">
                                                            <Car className="w-3 h-3" /> Transportation Badge Required
                                                        </button>
                                                    );
                                                    return <Button fullWidth size="sm" onClick={() => setApplyingJob(job)}>Apply Now</Button>;
                                                })()}
                                                <Button variant="secondary" size="sm" onClick={() => setViewingJob(job)}>Details</Button>
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        const stored = JSON.parse(localStorage.getItem('careconnex.hiddenJobs') || '[]');
                                                        if (!stored.includes(job.id)) stored.push(job.id);
                                                        localStorage.setItem('careconnex.hiddenJobs', JSON.stringify(stored));
                                                        setJobs(prev => prev.filter(j => j.id !== job.id));
                                                        onShowToast('Job hidden', 'info');
                                                    }}
                                                    className="px-3 py-1.5 text-[var(--color-neutral-500)] hover:text-[var(--color-neutral-700)] text-xs flex items-center gap-1"
                                                    title="Hide this job"
                                                >
                                                    <EyeOff className="w-3.5 h-3.5" /> Hide
                                                </button>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </section>
                    </div>
                </>
            )}

            {/* ── My Applications ── */}
            {activeTab === 'my-applications' && (() => {
                // Build a map: jobId → interview (so we can show interview status on the card)
                const interviewByJobId = new Map(
                    visibleInterviews.filter(iv => iv.jobId).map(iv => [iv.jobId!, iv])
                );
                const baseApps = applications;
                const visibleApps = appFilter === 'pending'
                    ? baseApps.filter(a => a.status === 'pending')
                    : baseApps.filter(a => a.status === 'rejected' || a.status === 'withdrawn');
                return (
                    <div className="space-y-4">
                        {applicationsLoading ? (
                            <><JobCardSkeleton /><JobCardSkeleton /></>
                        ) : baseApps.length === 0 ? (
                            <div className="text-center p-8 text-[var(--color-neutral-400)] bg-[var(--color-neutral-50)] rounded-2xl">
                                <FileText className="w-12 h-12 mx-auto mb-2 opacity-30" />
                                <p>No applications yet.</p>
                                <button onClick={() => setActiveTab('available')} className="text-[var(--color-primary-600)] font-medium mt-2 hover:underline">
                                    Browse available jobs
                                </button>
                            </div>
                        ) : (
                            <>
                            {/* Tabs: Pending | Closed */}
                            <div className="flex bg-slate-100 rounded-lg p-0.5 mb-2">
                                {([
                                    { key: 'pending', label: 'Pending', count: baseApps.filter(a => a.status === 'pending').length },
                                    { key: 'closed',  label: 'Closed',  count: baseApps.filter(a => a.status === 'rejected' || a.status === 'withdrawn').length },
                                ] as const).map(({ key, label, count }) => (
                                    <button key={key} onClick={() => setAppFilter(key)}
                                        className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-colors ${appFilter === key ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
                                        {label}{count > 0 ? ` (${count})` : ''}
                                    </button>
                                ))}
                            </div>
                            {visibleApps.length === 0 ? (
                                <div className="text-center p-8 text-[var(--color-neutral-400)] bg-[var(--color-neutral-50)] rounded-2xl">
                                    <p>No {appFilter} applications.</p>
                                </div>
                            ) : visibleApps.map((app) => {
                                const rawDate = (app.appliedAt as any)?.toDate ? (app.appliedAt as any).toDate() : new Date(app.appliedAt);
                                const appliedDate = isNaN(rawDate.getTime()) ? null : rawDate;
                                const linkedInterview = app.jobId ? interviewByJobId.get(app.jobId) : undefined;
                                return (
                                    <div key={app.id} className="bg-white p-5 rounded-2xl shadow-sm border border-[var(--color-neutral-100)] hover:border-[var(--color-primary-200)] transition-all">
                                        {/* Header: title + rate + status */}
                                        <div className="flex justify-between items-start mb-3">
                                            <div className="flex-1 min-w-0">
                                                <h4 className="font-bold text-[var(--color-neutral-900)] text-lg leading-tight">{app.jobTitle}</h4>
                                                <div className="flex items-center text-sm text-[var(--color-neutral-500)] mt-1 gap-3 flex-wrap">
                                                    {app.jobLocation && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{app.jobLocation}</span>}
                                                    {linkedInterview && <span>{app.clientName}</span>}
                                                </div>
                                            </div>
                                            <div className="flex flex-col items-end gap-1.5 ml-3 flex-shrink-0">
                                                <span className="bg-[var(--color-success-100)] text-[var(--color-success-700)] text-sm font-bold px-3 py-1 rounded-full">{rateLabel({ rate: app.jobRate, rateFlexible: app.jobRateFlexible })}</span>
                                                <StatusBadge status={app.status as ApplicationStatus} />
                                                {linkedInterview && (() => {
                                                    const iv = linkedInterview;
                                                    const ivLabel = iv.status === 'pending' ? 'Interview Pending'
                                                        : iv.status === 'accepted' || iv.status === 'confirmed' ? 'Interview Confirmed'
                                                        : iv.status === 'completed' ? 'Interview Completed'
                                                        : iv.status === 'declined' ? 'Interview Declined'
                                                        : iv.status === 'cancelled' ? 'Interview Cancelled'
                                                        : 'Interview Scheduled';
                                                    const ivColor = iv.status === 'completed' ? 'bg-slate-100 text-slate-600'
                                                        : iv.status === 'accepted' || iv.status === 'confirmed' ? 'bg-blue-50 text-blue-700'
                                                        : iv.status === 'declined' || iv.status === 'cancelled' ? 'bg-red-50 text-red-600'
                                                        : 'bg-purple-50 text-purple-700';
                                                    return (
                                                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${ivColor}`}>
                                                            {ivLabel}
                                                        </span>
                                                    );
                                                })()}
                                            </div>
                                        </div>

                                        {/* Chips: frequency + care types */}
                                        <div className="flex flex-wrap gap-2 mb-3">
                                            {app.jobFrequency && (
                                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-700 text-[11px] font-semibold uppercase tracking-wide">{({'one-time':'Occasional','occasional':'Occasional','part-time':'Part-time','full-time':'Full-time'}[app.jobFrequency] || app.jobFrequency)}</span>
                                            )}
                                            {Array.isArray(app.jobCareTypes) && (app.jobCareTypes as string[]).slice(0, 3).map(ct => (
                                                <span key={ct} className="text-[11px] bg-blue-50 text-blue-700 border border-blue-100 px-2.5 py-0.5 rounded-full font-medium">{ct}</span>
                                            ))}
                                            {Array.isArray(app.jobCareTypes) && app.jobCareTypes.length > 3 && (
                                                <span className="text-[11px] text-slate-400">+{app.jobCareTypes.length - 3} more</span>
                                            )}
                                        </div>

                                        {/* Days */}
                                        {Array.isArray(app.jobDaysOfWeek) && app.jobDaysOfWeek.length > 0 && (
                                            <div className="bg-[var(--color-neutral-50)] p-3 rounded-xl mb-3 text-sm text-[var(--color-neutral-600)] flex items-center gap-2">
                                                <Calendar className="w-4 h-4 text-[var(--color-neutral-400)]" />
                                                {app.jobDaysOfWeek.join(', ')}
                                            </div>
                                        )}

                                        {/* Cover letter */}
                                        {app.coverLetter && (
                                            <p className="text-xs text-slate-500 italic bg-slate-50 rounded-lg px-3 py-2 mb-3 break-words">"{app.coverLetter}"</p>
                                        )}

                                        {/* Footer */}
                                        <div className="flex items-center gap-3 text-sm text-[var(--color-neutral-500)] border-t border-slate-100 pt-3">
                                            {appliedDate && (
                                                <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" />Applied {appliedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                            )}
                                            <div className="ml-auto flex items-center gap-3">
                                                {app.jobId && (
                                                    <button onClick={() => handleViewJobDetails(app.jobId!)} className="text-[var(--color-primary-600)] hover:text-[var(--color-primary-700)] font-medium text-sm">
                                                        Details
                                                    </button>
                                                )}
                                                {app.status === 'pending' && !(['pending', 'accepted', 'confirmed'].includes(linkedInterview?.status ?? '')) && (
                                                    <button onClick={() => handleWithdrawApplication(app.id)} className="text-[var(--color-error-500)] hover:text-[var(--color-error-600)] font-medium text-sm">
                                                        Withdraw
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                            </>
                        )}
                    </div>
                );
            })()}

            {/* ── Interviews ── */}
            {activeTab === 'interviews' && (
                <div className="space-y-3">
                    {interviewsLoading ? (
                        <><JobCardSkeleton /><JobCardSkeleton /></>
                    ) : visibleInterviews.length === 0 ? (
                        <div className="text-center p-8 text-slate-400 bg-slate-50 rounded-2xl">
                            <Video className="w-12 h-12 mx-auto mb-2 opacity-30" />
                            <p>No interviews yet.</p>
                        </div>
                    ) : (
                        <>
                        {/* Filter chips */}
                        <div className="flex gap-2 flex-wrap mb-3">
                            {(['all', 'pending', 'accepted', 'completed', 'declined', 'cancelled'] as const).map(f => {
                                const total = f === 'all' ? visibleInterviews.length : visibleInterviews.filter(iv => iv.status === f).length;
                                if (f !== 'all' && total === 0) return null;
                                const newCount = f === 'all' ? 0 : visibleInterviews.filter(iv => {
                                    if (iv.status !== f) return false;
                                    const tsMs = (v: any): number => {
                                        if (!v) return 0;
                                        if (typeof v.toMillis === 'function') return v.toMillis();
                                        if (typeof v.toDate === 'function') return v.toDate().getTime();
                                        const ms = new Date(v).getTime();
                                        return isNaN(ms) ? 0 : ms;
                                    };
                                    return tsMs(iv.createdAt || iv.scheduledAt) > (lastCheckedIvFilter[f] ?? 0);
                                }).length;
                                return (
                                    <button key={f} onClick={() => {
                                        setIvFilter(f);
                                        if (f !== 'all') {
                                            const now = Date.now();
                                            localStorage.setItem(LS_IV_FILTER_KEY(f), String(now));
                                            setLastCheckedIvFilter(prev => ({ ...prev, [f]: now }));
                                        }
                                    }} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${ivFilter === f ? 'bg-primary-600 border-primary-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'}`}>
                                        {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
                                        {newCount > 0 && ivFilter !== f && (
                                            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none">{newCount}</span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="space-y-3">
                            {visibleInterviews.filter(iv => ivFilter === 'all' || iv.status === ivFilter).map(iv => {
                                const date = new Date(iv.scheduledAt);
                                const app = iv.jobId ? applications.find(a => a.jobId === iv.jobId) : undefined;
                                const ivStatusColor = iv.status === 'pending' ? 'bg-yellow-50 text-yellow-700' : iv.status === 'accepted' || iv.status === 'confirmed' ? 'bg-green-50 text-green-700' : iv.status === 'completed' ? 'bg-slate-100 text-slate-600' : 'bg-red-50 text-red-600';
                                const typeIcon = iv.interviewType === 'phone' ? <Phone className="w-4 h-4 text-[var(--color-neutral-400)]" /> : iv.interviewType === 'in-person' ? <Home className="w-4 h-4 text-[var(--color-neutral-400)]" /> : <Video className="w-4 h-4 text-[var(--color-neutral-400)]" />;
                                const typeLabel = iv.interviewType === 'in-person' ? 'In Person' : iv.interviewType ? iv.interviewType.charAt(0).toUpperCase() + iv.interviewType.slice(1) : 'Video';
                                return (
                                    <div key={`${iv.source}-${iv.id}`} className="bg-white p-5 rounded-2xl shadow-sm border border-[var(--color-neutral-100)] hover:border-[var(--color-primary-200)] transition-all">
                                        {/* Header: title + rate + status */}
                                        <div className="flex justify-between items-start mb-3">
                                            <div className="flex-1 min-w-0">
                                                <h4 className="font-bold text-[var(--color-neutral-900)] text-lg leading-tight">{iv.jobTitle || 'Interview'}</h4>
                                                <div className="flex items-center text-sm text-[var(--color-neutral-500)] mt-1 gap-3 flex-wrap">
                                                    {app?.jobLocation && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{app.jobLocation}</span>}
                                                    <span>{iv.clientName}</span>
                                                </div>
                                            </div>
                                            <div className="flex flex-col items-end gap-1.5 ml-3 flex-shrink-0">
                                                {app && (
                                                    <span className="bg-[var(--color-success-100)] text-[var(--color-success-700)] text-sm font-bold px-3 py-1 rounded-full">{rateLabel({ rate: app.jobRate, rateFlexible: app.jobRateFlexible })}</span>
                                                )}
                                                <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${ivStatusColor}`}>
                                                    {iv.status.charAt(0).toUpperCase() + iv.status.slice(1)}
                                                </span>
                                            </div>
                                        </div>

                                        {/* Job chips */}
                                        {app && (
                                            <div className="flex flex-wrap gap-2 mb-3">
                                                {app.jobFrequency && (
                                                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-700 text-[11px] font-semibold uppercase tracking-wide">{({'one-time':'Occasional','occasional':'Occasional','part-time':'Part-time','full-time':'Full-time'}[app.jobFrequency] || app.jobFrequency)}</span>
                                                )}
                                                {Array.isArray(app.jobCareTypes) && (app.jobCareTypes as string[]).slice(0, 3).map(ct => (
                                                    <span key={ct} className="text-[11px] bg-blue-50 text-blue-700 border border-blue-100 px-2.5 py-0.5 rounded-full font-medium">{ct}</span>
                                                ))}
                                                {Array.isArray(app.jobCareTypes) && app.jobCareTypes.length > 3 && (
                                                    <span className="text-[11px] text-slate-400">+{app.jobCareTypes.length - 3} more</span>
                                                )}
                                            </div>
                                        )}

                                        {/* Interview date/time/type */}
                                        <div className="bg-[var(--color-neutral-50)] p-3 rounded-xl mb-3 text-sm text-[var(--color-neutral-600)] space-y-1.5">
                                            <div className="flex items-center gap-2">
                                                <Calendar className="w-4 h-4 text-[var(--color-neutral-400)]" />
                                                {date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                                                <span className="text-[var(--color-neutral-400)]">·</span>
                                                <Clock className="w-4 h-4 text-[var(--color-neutral-400)]" />
                                                {date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                {typeIcon}{typeLabel}
                                            </div>
                                            {iv.callUrl?.startsWith('https://meet.google.com/') && (iv.status === 'accepted' || iv.status === 'confirmed' || iv.status === 'pending') && (
                                                <button onClick={() => window.open(iv.callUrl, '_blank', 'noopener')}
                                                    className="flex items-center gap-2 text-sm font-semibold text-primary-600 hover:underline">
                                                    <Video className="w-4 h-4" /> Join video call
                                                </button>
                                            )}
                                        </div>

                                        {/* Notes */}
                                        {iv.notes && <p className="text-xs text-slate-500 italic bg-slate-50 rounded-lg px-3 py-2 mb-3 break-words">"{iv.notes}"</p>}

                                        {/* Reschedule proposal pending — the CONFIRMED time above (date/
                                            Clock line) is still what's actually scheduled until accepted. */}
                                        {iv.reschedulePendingTime && (
                                            <div className="mb-3 p-3 bg-blue-50 border border-blue-100 rounded-lg">
                                                <p className="text-xs font-medium text-blue-800 flex items-center gap-1.5">
                                                    <Clock className="w-3.5 h-3.5" />
                                                    {iv.rescheduledBy === 'client'
                                                        ? `${iv.clientName} proposed a new time: `
                                                        : 'You proposed a new time: '}
                                                    {new Date(iv.reschedulePendingTime).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                                    {iv.rescheduledBy === 'caregiver' && ' — waiting on the family to confirm'}
                                                </p>
                                            </div>
                                        )}

                                        {/* Reschedule — same interview, no decline; asks the family to
                                            re-confirm the new time. Available before completion only. */}
                                        {rescheduleOpenId === iv.id && !blockReason && (iv.status === 'pending' || iv.status === 'accepted') && (
                                            <div className="mb-3 flex flex-wrap items-end gap-2 bg-blue-50 border border-blue-100 rounded-lg p-2">
                                                <div>
                                                    <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Date</label>
                                                    <input type="date" value={rescheduleDate} min={new Date().toISOString().split('T')[0]} onChange={(e) => setRescheduleDate(e.target.value)}
                                                        className="text-xs border border-slate-200 rounded-lg px-2 py-1.5" />
                                                </div>
                                                <div>
                                                    <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Time</label>
                                                    <select value={rescheduleTime} onChange={(e) => setRescheduleTime(e.target.value)}
                                                        className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white">
                                                        <option value="">Choose a time...</option>
                                                        {RESCHEDULE_TIME_SLOTS.map((time) => (
                                                            <option key={time} value={time}>
                                                                {new Date(`2000-01-01T${time}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <button
                                                    onClick={() => handleRescheduleInterview(iv)}
                                                    disabled={submittingInterview === iv.id || !rescheduleDate || !rescheduleTime}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 text-white rounded-lg text-xs font-semibold hover:bg-primary-700 disabled:opacity-50"
                                                >
                                                    {submittingInterview === iv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Send new time
                                                </button>
                                                <button
                                                    onClick={() => { setRescheduleOpenId(null); setRescheduleDate(''); setRescheduleTime(''); }}
                                                    className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-50"
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        )}

                                        {/* Footer: Details + Accept/Decline */}
                                        {(() => {
                                            return (
                                                <div className="mt-3">
                                                    {iv.status === 'pending' && blockReason ? (
                                                        <div className="flex items-center justify-between">
                                                            {iv.jobId ? (
                                                                <button onClick={() => handleViewJobDetails(iv.jobId!)} className="text-[var(--color-primary-600)] hover:text-[var(--color-primary-700)] font-medium text-sm">
                                                                    Details
                                                                </button>
                                                            ) : <span />}
                                                            <div className="flex gap-2">
                                                                <button
                                                                    onClick={() => handleDeclineInterview(iv)}
                                                                    disabled={submittingInterview === iv.id}
                                                                    className="px-4 py-1.5 border border-red-200 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50"
                                                                >
                                                                    {submittingInterview === iv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Decline'}
                                                                </button>
                                                                {blockReason === 'membership' ? (
                                                                    <button onClick={() => setMembershipModalOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 border border-slate-200 text-slate-500 rounded-lg text-xs font-semibold hover:bg-slate-200 transition-colors">
                                                                        <Lock className="w-3 h-3" />
                                                                        Activate Membership
                                                                    </button>
                                                                ) : (
                                                                    <button onClick={() => navigate('/caregiver/dashboard')} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 border border-amber-200 text-amber-700 rounded-lg text-xs font-semibold hover:bg-amber-100 transition-colors">
                                                                        <Lock className="w-3 h-3" />
                                                                        Complete Verification
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <div className="flex items-center justify-between">
                                                            {iv.jobId ? (
                                                                <button onClick={() => handleViewJobDetails(iv.jobId!)} className="text-[var(--color-primary-600)] hover:text-[var(--color-primary-700)] font-medium text-sm">
                                                                    Details
                                                                </button>
                                                            ) : <span />}
                                                            {/* Ending the interview is Decline while it's still an
                                                                unconfirmed request (status 'pending'), or Cancel once
                                                                it was already accepted — a confirmed meeting being
                                                                called off is a cancellation, not a decline. Always
                                                                available regardless of whose turn it is to respond
                                                                to a proposal. */}
                                                            {iv.reschedulePendingTime && iv.rescheduledBy === 'caregiver' ? (
                                                                // This caregiver's OWN outgoing proposal — Accept/Propose
                                                                // only come available when it's your TURN to review someone
                                                                // else's proposal, never on your own.
                                                                <div className="flex items-center gap-2">
                                                                    <span className="text-sm text-slate-500 italic">Waiting on the family to confirm</span>
                                                                    <button
                                                                        onClick={() => (iv.status === 'accepted' ? handleCancelInterview(iv) : handleDeclineInterview(iv))}
                                                                        disabled={submittingInterview === iv.id}
                                                                        className="px-4 py-1.5 border border-red-200 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50"
                                                                    >
                                                                        {submittingInterview === iv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (iv.status === 'accepted' ? 'Cancel' : 'Decline')}
                                                                    </button>
                                                                </div>
                                                            ) : iv.reschedulePendingTime && iv.rescheduledBy === 'client' ? (
                                                                // The family proposed a new time — this caregiver reviews it,
                                                                // same shape as a fresh request (Accept/Decline/Counter).
                                                                <div className="flex gap-2">
                                                                    {rescheduleOpenId !== iv.id && (
                                                                        <button
                                                                            onClick={() => { setRescheduleOpenId(iv.id); setRescheduleDate(date.toISOString().slice(0, 10)); setRescheduleTime(date.toTimeString().slice(0, 5)); }}
                                                                            disabled={submittingInterview === iv.id}
                                                                            className="px-4 py-1.5 border border-blue-200 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-50 disabled:opacity-50"
                                                                        >
                                                                            Propose different time
                                                                        </button>
                                                                    )}
                                                                    <button
                                                                        onClick={() => (iv.status === 'accepted' ? handleCancelInterview(iv) : handleDeclineInterview(iv))}
                                                                        disabled={submittingInterview === iv.id}
                                                                        className="px-4 py-1.5 border border-red-200 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50"
                                                                    >
                                                                        {submittingInterview === iv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (iv.status === 'accepted' ? 'Cancel' : 'Decline')}
                                                                    </button>
                                                                    <button
                                                                        onClick={() => handleAcceptRescheduleProposal(iv)}
                                                                        disabled={submittingInterview === iv.id}
                                                                        className="px-4 py-1.5 bg-primary-600 hover:bg-primary-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
                                                                    >
                                                                        {submittingInterview === iv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Accept new time'}
                                                                    </button>
                                                                </div>
                                                            ) : iv.status === 'pending' ? (
                                                                <div className="flex gap-2">
                                                                    {rescheduleOpenId !== iv.id && (
                                                                        <button
                                                                            onClick={() => { setRescheduleOpenId(iv.id); setRescheduleDate(date.toISOString().slice(0, 10)); setRescheduleTime(date.toTimeString().slice(0, 5)); }}
                                                                            disabled={submittingInterview === iv.id}
                                                                            className="px-4 py-1.5 border border-blue-200 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-50 disabled:opacity-50"
                                                                        >
                                                                            Reschedule
                                                                        </button>
                                                                    )}
                                                                    <button
                                                                        onClick={() => handleDeclineInterview(iv)}
                                                                        disabled={submittingInterview === iv.id}
                                                                        className="px-4 py-1.5 border border-red-200 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50"
                                                                    >
                                                                        {submittingInterview === iv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Decline'}
                                                                    </button>
                                                                    <button
                                                                        onClick={() => handleAcceptInterview(iv)}
                                                                        disabled={submittingInterview === iv.id}
                                                                        className="px-4 py-1.5 bg-primary-600 hover:bg-primary-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
                                                                    >
                                                                        {submittingInterview === iv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Accept'}
                                                                    </button>
                                                                </div>
                                                            ) : iv.status === 'accepted' ? (
                                                                <div className="flex gap-2">
                                                                    {rescheduleOpenId !== iv.id && (
                                                                        <button
                                                                            onClick={() => { setRescheduleOpenId(iv.id); setRescheduleDate(date.toISOString().slice(0, 10)); setRescheduleTime(date.toTimeString().slice(0, 5)); }}
                                                                            disabled={submittingInterview === iv.id}
                                                                            className="px-4 py-1.5 border border-blue-200 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-50 disabled:opacity-50"
                                                                        >
                                                                            Reschedule
                                                                        </button>
                                                                    )}
                                                                    <button
                                                                        onClick={() => handleCancelInterview(iv)}
                                                                        disabled={submittingInterview === iv.id}
                                                                        className="px-4 py-1.5 border border-red-200 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50"
                                                                    >
                                                                        {submittingInterview === iv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Cancel'}
                                                                    </button>
                                                                </div>
                                                            ) : <span />}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })()}
                                    </div>
                                );
                            })}
                        </div>
                        </>
                    )}
                </div>
            )}

            {/* ── Hidden Jobs ── */}
            {activeTab === 'hidden' && (
                <div className="space-y-3">
                    {hiddenJobsLoading ? (
                        <div className="flex items-center justify-center py-12 text-slate-400"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...</div>
                    ) : hiddenJobs.length === 0 ? (
                        <div className="text-center py-16 text-slate-400">
                            <EyeOff className="w-8 h-8 mx-auto mb-3 opacity-40" />
                            <p className="font-medium text-slate-500">No hidden jobs</p>
                            <p className="text-sm mt-1">Jobs you hide will appear here so you can unhide them anytime.</p>
                        </div>
                    ) : (
                        hiddenJobs.map(job => (
                            <div key={job.id} className="bg-white border border-slate-200 rounded-2xl p-4 flex items-center justify-between gap-4">
                                <div className="min-w-0">
                                    <p className="font-semibold text-slate-900 truncate">{job.title}</p>
                                    <p className="text-sm text-slate-500">{job.location || job.city}</p>
                                    <p className="text-sm font-medium text-emerald-600 mt-0.5">{rateLabel(job)}</p>
                                </div>
                                <button
                                    onClick={() => {
                                        const stored: string[] = JSON.parse(localStorage.getItem('careconnex.hiddenJobs') || '[]');
                                        localStorage.setItem('careconnex.hiddenJobs', JSON.stringify(stored.filter(id => id !== job.id)));
                                        setHiddenJobs(prev => prev.filter(j => j.id !== job.id));
                                        onShowToast('Job unhidden', 'success');
                                    }}
                                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 shrink-0"
                                >
                                    <Eye className="w-4 h-4" /> Unhide
                                </button>
                            </div>
                        ))
                    )}
                </div>
            )}

            {/* ── Job Details Modal ── */}
            {viewingJob && createPortal(
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-[var(--color-neutral-900)]/60 backdrop-blur-sm" onClick={() => setViewingJob(null)} />
                    <div className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl p-6 animate-slide-in max-h-[90vh] overflow-y-auto">
                        <button onClick={() => setViewingJob(null)} className="absolute top-4 right-4 text-[var(--color-neutral-400)] hover:text-[var(--color-neutral-600)]"><X size={24} /></button>

                        {/* Header: title + rate badge */}
                        <div className="pr-8 mb-1">
                            <div className="flex items-start justify-between gap-3">
                                <h2 className="text-xl font-bold text-[var(--color-neutral-900)] leading-tight">{viewingJob.title}</h2>
                                <span className="bg-[var(--color-success-100)] text-[var(--color-success-700)] text-sm font-bold px-3 py-1 rounded-full shrink-0">{rateLabel(viewingJob)}</span>
                            </div>
                            <p className="text-[var(--color-neutral-500)] text-sm mt-1">Posted by {viewingJob.clientName}</p>
                            {viewingJob.location && (
                                <p className="text-[var(--color-neutral-400)] text-xs mt-0.5 flex items-center gap-1">
                                    <MapPin className="w-3 h-3" />{viewingJob.location}
                                </p>
                            )}
                        </div>

                        {/* Frequency + care type chips — same style as interview card */}
                        {(viewingJob.jobFrequency || (viewingJob.careTypes ?? viewingJob.requirements ?? []).length > 0) && (
                            <div className="flex flex-wrap gap-2 mt-3 mb-4">
                                {viewingJob.jobFrequency && (
                                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-700 text-[11px] font-semibold uppercase tracking-wide">
                                        {({'one-time':'Occasional','occasional':'Occasional','part-time':'Part-time','full-time':'Full-time'} as Record<string,string>)[viewingJob.jobFrequency] || viewingJob.jobFrequency}
                                    </span>
                                )}
                                {(viewingJob.careTypes ?? viewingJob.requirements ?? []).map((ct: string, i: number) => (
                                    <span key={i} className="text-[11px] bg-blue-50 text-blue-700 border border-blue-100 px-2.5 py-0.5 rounded-full font-medium">{ct}</span>
                                ))}
                            </div>
                        )}

                        <div className="space-y-4">
                            {/* Schedule info */}
                            <div className="bg-[var(--color-neutral-50)] p-4 rounded-xl space-y-2 text-sm">
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-neutral-500)]">Starting Date</span>
                                    <span className="font-medium">{(() => { const d = new Date((viewingJob.startDate || viewingJob.date) + 'T12:00:00'); return isNaN(d.getTime()) ? (viewingJob.startDate || viewingJob.date) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); })()}</span>
                                </div>
                                {Array.isArray(viewingJob.daysOfWeek) && viewingJob.daysOfWeek.length > 0 && (
                                    <div className="flex justify-between"><span className="text-[var(--color-neutral-500)]">Days</span><span className="font-medium">{viewingJob.daysOfWeek.join(', ')}</span></div>
                                )}
                                {(() => {
                                    const timeLabel = viewingJob.startTime && viewingJob.endTime && viewingJob.startTime !== '-'
                                        ? `${viewingJob.startTime} – ${viewingJob.endTime}`
                                        : Array.isArray(viewingJob.timeOfDay) && viewingJob.timeOfDay.length > 0
                                            ? (viewingJob.timeOfDay as string[]).map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(', ')
                                            : null;
                                    return timeLabel ? (
                                        <div className="flex justify-between"><span className="text-[var(--color-neutral-500)]">Time</span><span className="font-medium">{timeLabel}</span></div>
                                    ) : null;
                                })()}
                                {viewingJob.recipientsCount != null && (
                                    <div className="flex justify-between"><span className="text-[var(--color-neutral-500)]">Seniors</span><span className="font-medium">{viewingJob.recipientsCount} {viewingJob.recipientsCount === 1 ? 'senior' : 'seniors'}</span></div>
                                )}
                                {viewingJob.minHoursPerWeek != null && (
                                    <div className="flex justify-between"><span className="text-[var(--color-neutral-500)]">Hours/week</span><span className="font-medium">{viewingJob.minHoursPerWeek}+ hrs</span></div>
                                )}
                            </div>

                            {/* Description */}
                            {viewingJob.description && (
                                <div>
                                    <h3 className="font-bold text-[var(--color-neutral-900)] mb-2 text-sm">Description</h3>
                                    <p className="text-[var(--color-neutral-600)] text-sm leading-relaxed break-words">{viewingJob.description}</p>
                                </div>
                            )}
                            <div className="pt-4 flex gap-3">
                                <Button variant="secondary" fullWidth onClick={() => setViewingJob(null)}>Close</Button>
                                {(() => {
                                    const existingIv = interviews.find(iv => iv.jobId === viewingJob.id);
                                    const existingApp = applications.find(a => a.jobId === viewingJob.id);
                                    if (existingIv) {
                                        const label = existingIv.status === 'pending' ? 'Interview Pending'
                                            : existingIv.status === 'accepted' || existingIv.status === 'confirmed' ? 'Interview Confirmed'
                                            : existingIv.status === 'completed' ? 'Interview Completed'
                                            : existingIv.status === 'declined' ? 'Interview Declined'
                                            : existingIv.status === 'cancelled' ? 'Interview Cancelled'
                                            : 'Interview Scheduled';
                                        const color = existingIv.status === 'completed' ? 'bg-green-50 text-green-700 border-green-200'
                                            : existingIv.status === 'accepted' || existingIv.status === 'confirmed' ? 'bg-blue-50 text-blue-700 border-blue-200'
                                            : existingIv.status === 'declined' || existingIv.status === 'cancelled' ? 'bg-slate-50 text-slate-500 border-slate-200'
                                            : 'bg-yellow-50 text-yellow-700 border-yellow-200';
                                        return <div className={`flex-1 flex items-center justify-center px-3 py-2 rounded-xl border text-sm font-medium ${color}`}>{label}</div>;
                                    }
                                    if (existingApp) {
                                        const label = existingApp.status === 'accepted' ? 'Application Accepted'
                                            : existingApp.status === 'rejected' ? 'Application Rejected'
                                            : existingApp.status === 'withdrawn' ? 'Application Withdrawn'
                                            : 'Application Pending';
                                        const color = existingApp.status === 'accepted' ? 'bg-green-50 text-green-700 border-green-200'
                                            : existingApp.status === 'rejected' ? 'bg-red-50 text-red-600 border-red-200'
                                            : existingApp.status === 'withdrawn' ? 'bg-slate-50 text-slate-500 border-slate-200'
                                            : 'bg-yellow-50 text-yellow-700 border-yellow-200';
                                        return <div className={`flex-1 flex items-center justify-center px-3 py-2 rounded-xl border text-sm font-medium ${color}`}>{label}</div>;
                                    }
                                    const jobRequiresTransport = viewingJob?.careTypes?.includes('Transportation') || viewingJob?.requirements?.includes('Driving');
                                    const reason = jobRequiresTransport ? transportBlockReason : blockReason;
                                    if (reason === 'membership') return (
                                        <button onClick={() => setMembershipModalOpen(true)} className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-slate-100 text-slate-500 border border-slate-200 hover:bg-slate-200 text-sm font-semibold transition-colors">
                                            <Lock className="w-3.5 h-3.5" /> Activate Membership
                                        </button>
                                    );
                                    if (reason === 'background') return (
                                        <button onClick={() => navigate('/caregiver/dashboard')} className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-slate-100 text-slate-500 border border-slate-200 hover:bg-slate-200 text-sm font-semibold transition-colors">
                                            <Lock className="w-3.5 h-3.5" /> Complete Verification
                                        </button>
                                    );
                                    if (reason === 'transport') return (
                                        <button onClick={() => navigate('/caregiver/settings')} className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-orange-50 text-orange-500 border border-orange-200 hover:bg-orange-100 text-sm font-semibold transition-colors">
                                            <Car className="w-3.5 h-3.5" /> Transportation Badge Required
                                        </button>
                                    );
                                    return (
                                        <Button fullWidth onClick={() => { setApplyingJob(viewingJob); setViewingJob(null); }}>Apply Now</Button>
                                    );
                                })()}
                            </div>
                        </div>
                    </div>
                </div>
            , document.body)}

            {/* ── Apply Modal — sticky footer ── */}
            {applyingJob && createPortal(
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-[var(--color-neutral-900)]/60 backdrop-blur-sm" onClick={() => setApplyingJob(null)} />
                    <div className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl flex flex-col max-h-[90vh] animate-slide-in">
                        <button onClick={() => setApplyingJob(null)} className="absolute top-4 right-4 text-[var(--color-neutral-400)] hover:text-[var(--color-neutral-600)] z-10"><X size={24} /></button>

                        <div className="overflow-y-auto flex-1 p-6">
                            <h2 className="text-xl font-bold text-[var(--color-neutral-900)] mb-1">Apply for Position</h2>
                            <p className="text-[var(--color-neutral-500)] text-sm mb-6">{applyingJob.title}</p>

                            <form id="apply-form" onSubmit={handleApplyToJob} className="space-y-4">
                                <div>
                                    <label className="block text-sm font-medium text-[var(--color-neutral-700)] mb-2">
                                        Cover Letter <span className="text-[var(--color-neutral-400)] font-normal">(Optional)</span>
                                    </label>
                                    <textarea
                                        value={coverLetter}
                                        onChange={(e) => setCoverLetter(e.target.value)}
                                        placeholder="Tell the client why you're a good fit..."
                                        className="w-full px-4 py-3 border border-[var(--color-neutral-200)] rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--color-primary-500)] resize-none"
                                        rows={4}
                                    />
                                </div>

                                <div className="bg-[var(--color-neutral-50)] p-4 rounded-xl">
                                    <h4 className="font-medium text-[var(--color-neutral-900)] mb-2">Your Profile</h4>
                                    <div className="text-sm text-[var(--color-neutral-600)] space-y-1">
                                        <p><span className="text-[var(--color-neutral-400)]">Experience:</span> {profile?.experience ?? 0} years</p>
                                        {(profile?.rating != null) && (
                                            <p><span className="text-[var(--color-neutral-400)]">Rating:</span> {Number(profile.rating).toFixed(1)} ⭐</p>
                                        )}
                                        {profile?.skills && profile.skills.length > 0 && (
                                            <p><span className="text-[var(--color-neutral-400)]">Skills:</span> {profile.skills.slice(0, 3).join(', ')}</p>
                                        )}
                                    </div>
                                </div>

                                <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-800">
                                    <strong>Client's budget:</strong> {rateLabel(applyingJob)}
                                </div>
                            </form>
                        </div>

                        <div className="border-t border-[var(--color-neutral-100)] p-4 flex gap-3 bg-white rounded-b-3xl">
                            <Button type="button" variant="secondary" fullWidth onClick={() => setApplyingJob(null)}>Cancel</Button>
                            <Button type="submit" form="apply-form" fullWidth disabled={acceptingGigId === applyingJob.id}>
                                {acceptingGigId === applyingJob.id ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Submitting...</> : 'Submit Application'}
                            </Button>
                        </div>
                    </div>
                </div>
            , document.body)}

            {/* ── Mobile filter drawer ── */}
            {mobileFiltersOpen && (
                <div className="lg:hidden fixed inset-0 z-40">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setMobileFiltersOpen(false)} />
                    <div className="absolute right-0 top-0 bottom-0 w-[85%] max-w-sm bg-white shadow-xl flex flex-col">
                        <div className="flex items-center justify-between p-4 border-b border-slate-200">
                            <h2 className="font-semibold text-slate-900 flex items-center gap-2">
                                <SlidersHorizontal className="w-4 h-4" />
                                Filters
                            </h2>
                            <button onClick={() => setMobileFiltersOpen(false)} className="p-1.5 hover:bg-slate-100 rounded-full">
                                <X className="w-5 h-5 text-slate-600" />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4">{FilterPanel}</div>
                        <div className="p-4 border-t border-slate-200">
                            <button
                                onClick={() => setMobileFiltersOpen(false)}
                                className="w-full py-2.5 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700"
                            >
                                Show {filteredJobs.length} job{filteredJobs.length !== 1 ? 's' : ''}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    </>
    );
};
