import React, { useState, useEffect } from 'react';
import { Search, List, Loader2, Briefcase, MapPin, Calendar, Clock, Lock, X, FileText, CheckCircle, XCircle, Clock4, Sun, Moon, Users, CreditCard, Banknote, EyeOff } from 'lucide-react';
import { Button } from '../ui/Button';
import { JobPost, Caregiver, AddToastFunction } from '../../types';
import { dbService } from '../../services/api';
import { db } from '../../lib/firebase';
import { jobApplicationService, useMyApplications } from '../../hooks/useJobApplications';
import { Skeleton } from '../ui/Skeleton';

interface JobBoardProps {
    onShowToast: AddToastFunction;
    profile: Caregiver | null;
    onJobAccepted: () => void;
    /** When true, hides the "My Applications" tab (used when applications are surfaced elsewhere, e.g. Bookings page). */
    hideApplicationsTab?: boolean;
}

type TabType = 'available' | 'my-applications';
type ApplicationStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn';

/**
 * Status badge component with consistent styling
 */
const StatusBadge: React.FC<{ status: ApplicationStatus }> = ({ status }) => {
  const styles: Record<ApplicationStatus, { icon: React.ReactNode; className: string; label: string }> = {
    pending: { 
      icon: <Clock4 className="w-3 h-3" />, 
      className: 'text-[var(--color-warning-600)] bg-[var(--color-warning-50)]',
      label: 'Pending'
    },
    accepted: { 
      icon: <CheckCircle className="w-3 h-3" />, 
      className: 'text-[var(--color-success-600)] bg-[var(--color-success-50)]',
      label: 'Accepted'
    },
    rejected: { 
      icon: <XCircle className="w-3 h-3" />, 
      className: 'text-[var(--color-error-600)] bg-[var(--color-error-50)]',
      label: 'Not Selected'
    },
    withdrawn: { 
      icon: null, 
      className: 'text-[var(--color-neutral-600)] bg-[var(--color-neutral-100)]',
      label: 'Withdrawn'
    }
  };

  const style = styles[status] || styles.pending;

  return (
    <span className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${style.className}`}>
      {style.icon}
      {style.label}
    </span>
  );
};

/**
 * Job card skeleton loader
 */
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

export const JobBoard: React.FC<JobBoardProps> = ({ onShowToast, profile, onJobAccepted, hideApplicationsTab = false }) => {
    const [jobs, setJobs] = useState<JobPost[]>([]);
    const [jobsLoading, setJobsLoading] = useState(false);
    const [viewingJob, setViewingJob] = useState<JobPost | null>(null);
    const [applyingJob, setApplyingJob] = useState<JobPost | null>(null);
    const [acceptingGigId, setAcceptingGigId] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<TabType>('available');
    const [coverLetter, setCoverLetter] = useState('');
    const [proposedRate, setProposedRate] = useState<number | null>(null);
    const [searchQuery, setSearchQuery] = useState('');

    // Use the hook for applications
    const { applications, loading: applicationsLoading, withdrawApplication } = useMyApplications(profile?.uid || null);

    // Real-time job board subscription
    useEffect(() => {
        if (activeTab !== 'available') return;

        setJobsLoading(true);

        const unsubscribe = db.collection('job_posts')
            .where('status', '==', 'open')
            .orderBy('createdAt', 'desc')
            .onSnapshot(
                (snapshot) => {
                    const appliedJobIds = new Set(applications.map(a => a.jobId));
                    const hidden = new Set<string>(JSON.parse(localStorage.getItem('careconnex.hiddenJobs') || '[]'));
                    const allJobs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as JobPost[];
                    setJobs(allJobs.filter(job => !appliedJobIds.has(job.id) && !hidden.has(job.id)));
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

    const handleApplyToJob = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!profile?.verified) {
            onShowToast("Background Check Required. Please complete verification to apply for jobs.", 'error');
            return;
        }
        if (!applyingJob) return;

        setAcceptingGigId(applyingJob.id);

        try {
            await jobApplicationService.applyToJob(
                applyingJob.id,
                applyingJob.title,
                applyingJob.clientId,
                applyingJob.clientName,
                {
                    caregiverId: profile.uid,
                    caregiverName: profile.name,
                    caregiverPhoto: profile.photo || profile.imageUrl || '',
                    experience: profile.experience,
                    rating: profile.rating,
                    skills: profile.skills || profile.certifications
                },
                coverLetter,
                proposedRate || undefined
            );

            onShowToast(`Application submitted for ${applyingJob.title}!`, 'success');
            setApplyingJob(null);
            setCoverLetter('');
            setProposedRate(null);

            // Refresh jobs locally
            setJobs(prev => prev.filter(j => j.id !== applyingJob.id));

        } catch (e: unknown) {
            console.error(e);
            const errorMessage = e instanceof Error ? e.message : "Failed to apply for job.";
            onShowToast(errorMessage, 'error');
        } finally {
            setAcceptingGigId(null);
        }
    };

    const handleWithdrawApplication = async (applicationId: string) => {
        try {
            await withdrawApplication(applicationId);
            onShowToast("Application withdrawn", 'info');
        } catch (e) {
            onShowToast("Failed to withdraw application", 'error');
        }
    };

    // Filter jobs based on search query
    const filteredJobs = jobs.filter(job => 
        job.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        job.location.toLowerCase().includes(searchQuery.toLowerCase()) ||
        job.requirements?.some(r => r.toLowerCase().includes(searchQuery.toLowerCase()))
    );

    return (
        <div className="animate-slide-in">
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h3 className="text-xl font-bold text-[var(--color-neutral-900)]">Job Board</h3>
                    <p className="text-[var(--color-neutral-500)] text-sm">Find and manage job opportunities</p>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-6 border-b border-[var(--color-neutral-200)]">
                <button
                    onClick={() => setActiveTab('available')}
                    className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                        activeTab === 'available' 
                            ? 'border-[var(--color-primary-500)] text-[var(--color-primary-600)]' 
                            : 'border-transparent text-[var(--color-neutral-500)] hover:text-[var(--color-neutral-700)]'
                    }`}
                >
                    Available Jobs
                </button>
                {!hideApplicationsTab && (
                    <button
                        onClick={() => setActiveTab('my-applications')}
                        className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                            activeTab === 'my-applications'
                                ? 'border-[var(--color-primary-500)] text-[var(--color-primary-600)]'
                                : 'border-transparent text-[var(--color-neutral-500)] hover:text-[var(--color-neutral-700)]'
                        }`}
                    >
                        My Applications ({applications.length})
                    </button>
                )}
            </div>

            {/* Available Jobs Tab */}
            {activeTab === 'available' && (
                <>
                    <div className="flex gap-2 mb-6">
                        <div className="relative flex-grow">
                            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[var(--color-neutral-400)] w-4 h-4" />
                            <input 
                                type="text" 
                                placeholder="Search by area or skill..." 
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full pl-9 pr-4 py-2 bg-white border border-[var(--color-neutral-200)] rounded-xl text-sm focus:outline-none focus:border-[var(--color-primary-500)]" 
                            />
                        </div>
                        <button className="px-3 py-2 bg-white border border-[var(--color-neutral-200)] rounded-xl text-[var(--color-neutral-600)] hover:bg-[var(--color-neutral-50)]">
                            <List className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="space-y-4">
                        {jobsLoading ? (
                            <>
                                <JobCardSkeleton />
                                <JobCardSkeleton />
                                <JobCardSkeleton />
                            </>
                        ) : filteredJobs.length === 0 ? (
                            <div className="text-center p-8 text-[var(--color-neutral-400)] bg-[var(--color-neutral-50)] rounded-2xl">
                                <Briefcase className="w-12 h-12 mx-auto mb-2 opacity-30" />
                                <p>{searchQuery ? 'No jobs match your search.' : 'No open jobs right now.'}</p>
                            </div>
                        ) : (
                            filteredJobs.map((job) => (
                                <div key={job.id} className="bg-white p-5 rounded-2xl shadow-sm border border-[var(--color-neutral-100)] hover:border-[var(--color-primary-200)] transition-all cursor-pointer group relative overflow-hidden">
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
                                                {typeof job.distance === 'number' && <span className="text-xs">({job.distance.toFixed(1)} mi)</span>}
                                            </div>
                                        </div>
                                        <div className="text-right flex-shrink-0">
                                            <span className="bg-[var(--color-success-100)] text-[var(--color-success-700)] text-sm font-bold px-3 py-1 rounded-full">
                                                ${job.rate}/hr
                                            </span>
                                            {job.paymentMethod && (
                                                <p className="text-[10px] text-slate-400 mt-1 flex items-center justify-end gap-1">
                                                    {job.paymentMethod === 'credit' ? <CreditCard className="w-3 h-3" /> : <Banknote className="w-3 h-3" />}
                                                    via {job.paymentMethod}
                                                </p>
                                            )}
                                        </div>
                                    </div>

                                    {/* Badges row: frequency, day/night, applicant count, recipients */}
                                    <div className="flex flex-wrap gap-2 mb-3">
                                        {(() => {
                                            const freq = job.jobFrequency
                                                || (job.minHoursPerWeek && job.minHoursPerWeek >= 32 ? 'full-time'
                                                    : job.minHoursPerWeek ? 'part-time' : 'one-time');
                                            return (
                                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-700 text-[11px] font-semibold uppercase tracking-wide">
                                                    {freq.replace('-', ' ')}
                                                </span>
                                            );
                                        })()}
                                        {job.timeOfDay?.some(t => t === 'morning' || t === 'afternoon') && (
                                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-700 text-[11px] font-medium">
                                                <Sun className="w-3 h-3" /> Day
                                            </span>
                                        )}
                                        {job.timeOfDay?.some(t => t === 'evening' || t === 'overnight') && (
                                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-[11px] font-medium">
                                                <Moon className="w-3 h-3" /> Night
                                            </span>
                                        )}
                                        {job.recipientsCount && job.recipientsCount > 1 && (
                                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[11px] font-medium">
                                                <Users className="w-3 h-3" /> {job.recipientsCount} seniors
                                            </span>
                                        )}
                                        {typeof job.applicantCount === 'number' && job.applicantCount < 10 && (
                                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-700 text-[11px] font-semibold">
                                                ★ Less than 10 applicants
                                            </span>
                                        )}
                                    </div>

                                    <div className="bg-[var(--color-neutral-50)] p-3 rounded-xl mb-4 text-sm text-[var(--color-neutral-600)]">
                                        <div className="flex items-center mb-1">
                                            <Calendar className="w-4 h-4 mr-2 text-[var(--color-neutral-400)]" />
                                            {job.date === 'Tomorrow' || job.date === 'Today' ? job.date : new Date(job.date).toLocaleDateString()}
                                        </div>
                                        <div className="flex items-center">
                                            <Clock className="w-4 h-4 mr-2 text-[var(--color-neutral-400)]" />
                                            {job.startTime} - {job.endTime}
                                        </div>
                                    </div>

                                    <div className="flex gap-2">
                                        {profile?.verified ? (
                                            <Button
                                                fullWidth
                                                size="sm"
                                                onClick={() => { setApplyingJob(job); setProposedRate(job.rate); }}
                                            >
                                                Apply Now
                                            </Button>
                                        ) : (
                                            <Button
                                                fullWidth
                                                size="sm"
                                                disabled
                                                className="bg-[var(--color-neutral-100)] text-[var(--color-neutral-400)] cursor-not-allowed border-[var(--color-neutral-200)]"
                                            >
                                                <Lock className="w-3 h-3 mr-2" /> Verification Pending
                                            </Button>
                                        )}
                                        <Button variant="secondary" size="sm" onClick={() => setViewingJob(job)}>Details</Button>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                const key = `careconnex.hiddenJobs`;
                                                const stored = JSON.parse(localStorage.getItem(key) || '[]');
                                                if (!stored.includes(job.id)) stored.push(job.id);
                                                localStorage.setItem(key, JSON.stringify(stored));
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
                </>
            )}

            {/* My Applications Tab */}
            {activeTab === 'my-applications' && (
                <div className="space-y-4">
                    {applicationsLoading ? (
                        <>
                            <JobCardSkeleton />
                            <JobCardSkeleton />
                        </>
                    ) : applications.length === 0 ? (
                        <div className="text-center p-8 text-[var(--color-neutral-400)] bg-[var(--color-neutral-50)] rounded-2xl">
                            <FileText className="w-12 h-12 mx-auto mb-2 opacity-30" />
                            <p>You haven't applied to any jobs yet.</p>
                            <button 
                                onClick={() => setActiveTab('available')}
                                className="text-[var(--color-primary-600)] font-medium mt-2 hover:underline"
                            >
                                Browse available jobs
                            </button>
                        </div>
                    ) : (
                        applications.map((app) => (
                            <div key={app.id} className="bg-white p-5 rounded-2xl shadow-sm border border-[var(--color-neutral-100)]">
                                <div className="flex justify-between items-start mb-3">
                                    <div>
                                        <h4 className="font-bold text-[var(--color-neutral-900)]">{app.jobTitle}</h4>
                                        <p className="text-sm text-[var(--color-neutral-500)]">Client: {app.clientName}</p>
                                    </div>
                                    <StatusBadge status={app.status as ApplicationStatus} />
                                </div>
                                
                                <div className="flex justify-between items-center text-sm text-[var(--color-neutral-500)]">
                                    <span>Applied {new Date(app.appliedAt).toLocaleDateString()}</span>
                                    {app.status === 'pending' && (
                                        <button
                                            onClick={() => handleWithdrawApplication(app.id)}
                                            className="text-[var(--color-error-500)] hover:text-[var(--color-error-600)] font-medium"
                                        >
                                            Withdraw
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))
                    )}
                </div>
            )}

            {/* Job Details Modal */}
            {viewingJob && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-[var(--color-neutral-900)]/60 backdrop-blur-sm" onClick={() => setViewingJob(null)} />
                    <div className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl p-6 animate-slide-in">
                        <button onClick={() => setViewingJob(null)} className="absolute top-4 right-4 text-[var(--color-neutral-400)] hover:text-[var(--color-neutral-600)]">
                            <X size={24} />
                        </button>

                        <h2 className="text-xl font-bold text-[var(--color-neutral-900)] mb-1">{viewingJob.title}</h2>
                        <p className="text-[var(--color-neutral-500)] text-sm mb-4">Posted by {viewingJob.clientName}</p>

                        <div className="space-y-4">
                            <div className="bg-[var(--color-neutral-50)] p-4 rounded-xl space-y-2 text-sm">
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-neutral-500)]">Rate</span>
                                    <span className="font-bold text-[var(--color-success-700)]">${viewingJob.rate}/hr</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-neutral-500)]">Date</span>
                                    <span className="font-medium text-[var(--color-neutral-900)]">{viewingJob.date}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-neutral-500)]">Time</span>
                                    <span className="font-medium text-[var(--color-neutral-900)]">{viewingJob.startTime} - {viewingJob.endTime}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-[var(--color-neutral-500)]">Location</span>
                                    <span className="font-medium text-[var(--color-neutral-900)]">{viewingJob.location}</span>
                                </div>
                            </div>

                            <div>
                                <h3 className="font-bold text-[var(--color-neutral-900)] mb-2 text-sm">Description</h3>
                                <p className="text-[var(--color-neutral-600)] text-sm leading-relaxed">{viewingJob.description}</p>
                            </div>

                            {viewingJob.requirements && viewingJob.requirements.length > 0 && (
                                <div>
                                    <h3 className="font-bold text-[var(--color-neutral-900)] mb-2 text-sm">Requirements</h3>
                                    <div className="flex flex-wrap gap-2">
                                        {viewingJob.requirements.map((req, i) => (
                                            <span key={i} className="px-2 py-1 bg-[var(--color-info-50)] text-[var(--color-info-700)] rounded text-xs font-medium border border-[var(--color-info-100)]">
                                                {req}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className="pt-4 flex gap-3">
                                <Button variant="secondary" fullWidth onClick={() => setViewingJob(null)}>Close</Button>
                                {profile?.verified ? (
                                    <Button fullWidth onClick={() => { setApplyingJob(viewingJob); setViewingJob(null); setProposedRate(viewingJob.rate); }}>Apply Now</Button>
                                ) : (
                                    <Button fullWidth disabled className="bg-[var(--color-neutral-100)] text-[var(--color-neutral-400)] cursor-not-allowed border-[var(--color-neutral-200)]">
                                        <Lock className="w-3 h-3 mr-2" /> Verify to Apply
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Apply Modal */}
            {applyingJob && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-[var(--color-neutral-900)]/60 backdrop-blur-sm" onClick={() => setApplyingJob(null)} />
                    <div className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl p-6 animate-slide-in max-h-[90vh] overflow-y-auto">
                        <button onClick={() => setApplyingJob(null)} className="absolute top-4 right-4 text-[var(--color-neutral-400)] hover:text-[var(--color-neutral-600)]">
                            <X size={24} />
                        </button>

                        <h2 className="text-xl font-bold text-[var(--color-neutral-900)] mb-1">Apply for Position</h2>
                        <p className="text-[var(--color-neutral-500)] text-sm mb-6">{applyingJob.title}</p>

                        <form onSubmit={handleApplyToJob} className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-neutral-700)] mb-2">
                                    Proposed Rate (per hour)
                                </label>
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-neutral-500)]">$</span>
                                    <input
                                        type="number"
                                        value={proposedRate || ''}
                                        onChange={(e) => setProposedRate(Number(e.target.value))}
                                        className="w-full pl-8 pr-4 py-2 border border-[var(--color-neutral-200)] rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--color-primary-500)]"
                                        min={1}
                                        required
                                    />
                                </div>
                                <p className="text-xs text-[var(--color-neutral-400)] mt-1">
                                    Client's budget: ${applyingJob.rate}/hr
                                </p>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-[var(--color-neutral-700)] mb-2">
                                    Cover Letter (Optional)
                                </label>
                                <textarea
                                    value={coverLetter}
                                    onChange={(e) => setCoverLetter(e.target.value)}
                                    placeholder="Tell the client why you're a good fit for this position..."
                                    className="w-full px-4 py-3 border border-[var(--color-neutral-200)] rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--color-primary-500)] resize-none"
                                    rows={4}
                                />
                            </div>

                            <div className="bg-[var(--color-neutral-50)] p-4 rounded-xl">
                                <h4 className="font-medium text-[var(--color-neutral-900)] mb-2">Your Profile</h4>
                                <div className="text-sm text-[var(--color-neutral-600)] space-y-1">
                                    <p><span className="text-[var(--color-neutral-400)]">Experience:</span> {profile?.experience || 0} years</p>
                                    {profile?.rating && <p><span className="text-[var(--color-neutral-400)]">Rating:</span> {profile.rating.toFixed(1)} ⭐</p>}
                                    {profile?.skills && profile.skills.length > 0 && (
                                        <p><span className="text-[var(--color-neutral-400)]">Skills:</span> {profile.skills.slice(0, 3).join(', ')}</p>
                                    )}
                                </div>
                            </div>

                            <div className="pt-4 flex gap-3">
                                <Button 
                                    type="button"
                                    variant="secondary" 
                                    fullWidth 
                                    onClick={() => setApplyingJob(null)}
                                >
                                    Cancel
                                </Button>
                                <Button 
                                    type="submit"
                                    fullWidth 
                                    disabled={acceptingGigId === applyingJob.id}
                                >
                                    {acceptingGigId === applyingJob.id ? (
                                        <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Submitting...</>
                                    ) : (
                                        'Submit Application'
                                    )}
                                </Button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};
