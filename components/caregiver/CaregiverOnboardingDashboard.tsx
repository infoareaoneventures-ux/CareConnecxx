import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle, Briefcase, MapPin, ArrowRight, Clock, Lock,
  Calendar, Sun, Moon, Car, Users as UsersIcon, CreditCard, Banknote, X, Loader2,
} from 'lucide-react';
import { Caregiver, JobPost, AddToastFunction } from '../../types';
import { ProfileApprovalBanner } from './ProfileApprovalBanner';
import { BackgroundCheckModal } from '../BackgroundCheckModal';
import { CaregiverCareRequestsCard } from './CaregiverCareRequestsCard';
import { CaregiverBookingsCard } from './CaregiverBookingsCard';
import { jobApplicationService } from '../../hooks/useJobApplications';
import { hasValidTransportDocs } from '../../utils/transportDocs';
import { openCaregiverBillingPortal } from '../../services/stripeService';

interface CaregiverOnboardingDashboardProps {
  profile: Caregiver;
  onNavigate: (view: any) => void;
  onShowToast?: AddToastFunction;
  jobs?: JobPost[];
  jobsLoaded?: boolean;
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

function getFirstName(name: string): string {
  return name?.split(' ')[0] || name || 'there';
}

// ── Progress Card ─────────────────────────────────────────────────────────────

const CaregiverProgressCard: React.FC<{
  profile: Caregiver;
  onNavigate: (view: any) => void;
  onShowToast?: AddToastFunction;
}> = ({ profile, onNavigate, onShowToast }) => {
  const [showBgModal, setShowBgModal] = useState(false);
  const p = profile as any;
  const membershipActive = p.membershipStatus === 'active' || p.membershipStatus === 'trialing' || (!p.membershipStatus && p.membershipPaid === true);
  const bgApprovedFull = profile.verified === true || p.backgroundCheckStatus === 'clear' || p.backgroundCheckComplete === true;
  const isApproved = membershipActive && bgApprovedFull;
  const profileComplete = p.onboardingStatus === 'profile_complete' || p.onboardingStatus === 'submitted' || isApproved;
  const hasPaid = membershipActive;
  const checkrInitiated = !!p.backgroundCheckData?.checkrCandidateId;
  const rejected = p.verificationStatus === 'rejected';
  const infoRequested = p.verificationStatus === 'info_requested';
  const bgCheckInProgress = checkrInitiated && !bgApprovedFull;

  if (isApproved) return null;

  const activeStep = !profileComplete ? 1
    : !hasPaid ? 2
    : !checkrInitiated ? 3
    : 4;

  // CTA card content
  let cardTitle = '';
  let cardDesc = '';
  let cardCta: { label: string; onClick: () => void } | undefined;
  let cardVariant: 'default' | 'info' | 'warning' = 'default';

  if (rejected) {
    cardTitle = 'Application not approved';
    cardDesc = p.rejectionReason || 'Contact support for details.';
    cardVariant = 'warning';
  } else if (infoRequested) {
    cardTitle = 'Additional information needed';
    cardDesc = p.infoRequestNotes || 'Please update your profile and resubmit.';
    cardCta = { label: 'Update profile', onClick: () => onNavigate('caregiver-profile') };
    cardVariant = 'warning';
  } else if (activeStep === 1) {
    cardTitle = 'Complete your profile';
    cardDesc = 'Add your photo, availability, services, and bio.';
    cardCta = { label: 'Complete profile', onClick: () => onNavigate('caregiver-profile') };
  } else if (activeStep === 2) {
    if (p.membershipStatus === 'payment_failed') {
      cardTitle = 'Payment failed';
      cardDesc = 'We couldn\'t process your last payment. Update your payment method to continue.';
      cardVariant = 'warning';
      cardCta = {
        label: 'Update payment',
        onClick: async () => {
          try {
            await openCaregiverBillingPortal(`${window.location.origin}/caregiver/dashboard`);
          } catch {
            onShowToast?.('Unable to open billing portal. Please try again.', 'error');
          }
        },
      };
    } else if (p.membershipStatus === 'canceled') {
      cardTitle = 'Membership canceled';
      cardDesc = 'Your membership has been canceled. Reactivate to regain access to jobs and messaging.';
      cardCta = { label: 'Reactivate membership', onClick: () => onNavigate('caregiver-membership') };
    } else {
      cardTitle = 'Activate your membership';
      cardDesc = '';
      cardCta = { label: 'Activate membership', onClick: () => onNavigate('caregiver-membership') };
    }
  } else if (activeStep === 3) {
    cardTitle = 'Start your background check';
    cardDesc = '';
    cardCta = {
      label: 'Start background check',
      onClick: () => setShowBgModal(true),
    };
  } else if (activeStep === 4) {
    cardTitle = 'Background check in progress';
    cardDesc = 'Your background check is underway — we\'ll notify you once it clears.';
    cardVariant = 'info';
  }

  const steps = [
    { label: 'Account', done: true, inProgress: false },
    { label: 'Profile', done: profileComplete, inProgress: !profileComplete },
    { label: 'Membership', done: hasPaid, inProgress: !hasPaid && profileComplete },
    { label: 'Background Check', done: bgApprovedFull, inProgress: bgCheckInProgress },
  ];

  return (
    <>
      {showBgModal && (
        <BackgroundCheckModal
          onClose={() => setShowBgModal(false)}
          onShowToast={onShowToast || (() => {})}
          onSuccess={() => setShowBgModal(false)}
        />
      )}
    <div className="bg-white border border-slate-100 rounded-[2rem] p-6 mb-8 shadow-sm">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-5">Your progress</p>

      {/* Horizontal stepper */}
      <div className="flex items-start mb-5">
        {steps.map((step, i) => (
          <React.Fragment key={i}>
            <div className="flex flex-col items-center flex-1 min-w-0">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center mb-2 flex-shrink-0 ${
                step.done ? 'bg-teal-500 shadow-sm' : step.inProgress ? 'bg-indigo-600 shadow-sm' : 'bg-slate-100'
              }`}>
                {step.done
                  ? <CheckCircle className="w-5 h-5 text-white" />
                  : step.inProgress
                  ? <Clock className="w-4 h-4 text-white" />
                  : <Lock className="w-4 h-4 text-slate-400" />
                }
              </div>
              <span className={`text-xs font-semibold text-center px-1 leading-tight ${
                step.done ? 'text-teal-600' : step.inProgress ? 'text-indigo-700' : 'text-slate-400'
              }`}>{step.label}</span>
            </div>
            {i < steps.length - 1 && (
              <div className={`h-0.5 flex-1 mt-[18px] mx-1 ${step.done ? 'bg-teal-200' : 'bg-slate-100'}`} />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Active step CTA card */}
      <div className={`rounded-2xl p-4 ${
        cardVariant === 'warning' ? 'bg-red-50 border border-red-100'
        : cardVariant === 'info' ? 'bg-blue-50 border border-blue-100'
        : 'bg-indigo-50 border border-indigo-100'
      }`}>
        <p className={`text-sm font-semibold mb-1 ${
          cardVariant === 'warning' ? 'text-red-900' : cardVariant === 'info' ? 'text-blue-900' : 'text-indigo-900'
        }`}>{cardTitle}</p>
        <p className={`text-xs leading-relaxed ${
          cardVariant === 'warning' ? 'text-red-700' : cardVariant === 'info' ? 'text-blue-700' : 'text-indigo-600'
        } ${cardCta ? 'mb-3' : 'mb-0'}`}>{cardDesc}</p>
        {cardCta && (
          <button
            onClick={cardCta.onClick}
            className="flex items-center gap-1.5 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-full transition-colors"
          >
            {cardCta.label} <ArrowRight className="w-3 h-3" />
          </button>
        )}
        {cardVariant === 'info' && !cardCta && (
          <div className="flex items-center gap-1.5 text-xs font-medium text-blue-600 mt-1">
            <Clock className="w-3 h-3" /> In progress
          </div>
        )}
      </div>
    </div>
    </>
  );
};

// ── Main Dashboard ────────────────────────────────────────────────────────────

export const CaregiverOnboardingDashboard: React.FC<CaregiverOnboardingDashboardProps> = ({
  profile,
  onNavigate,
  onShowToast,
  jobs: prefetchedJobs,
  jobsLoaded: prefetchedJobsLoaded,
}) => {
  const [jobs, setJobs] = useState<JobPost[]>(prefetchedJobs ?? []);
  const loadingJobs = !prefetchedJobsLoaded;

  // Sync jobs when parent finishes loading
  React.useEffect(() => {
    if (prefetchedJobs) setJobs(prefetchedJobs);
  }, [prefetchedJobs]);
  const [viewingJob, setViewingJob] = useState<JobPost | null>(null);
  const [applyingJob, setApplyingJob] = useState<JobPost | null>(null);
  const [coverLetter, setCoverLetter] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleApplyToJob = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.verified) {
      onShowToast?.('Background check required. Please complete verification to apply.', 'error');
      return;
    }
    if (!applyingJob) return;
    const requiresTransport = applyingJob.careTypes?.includes('Transportation') || (applyingJob as any).requirements?.includes('Driving');
    if (requiresTransport && !hasValidTransportDocs(profile)) {
      onShowToast?.('This job requires transportation. Your transport documents are not verified.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await jobApplicationService.applyToJob(
        applyingJob.id, applyingJob.title, applyingJob.clientId, applyingJob.clientName,
        { caregiverId: profile.uid, caregiverName: profile.name, caregiverPhoto: (profile as any).photo || (profile as any).imageUrl || '', experience: profile.experience ?? 0, rating: (profile as any).rating ?? undefined, skills: (profile as any).skills || (profile as any).certifications || [] },
        coverLetter,
      );
      onShowToast?.(`Application submitted for ${applyingJob.title}!`, 'success');
      setJobs(prev => prev.filter(j => j.id !== applyingJob.id));
      setApplyingJob(null);
      setCoverLetter('');
    } catch (err: unknown) {
      onShowToast?.(err instanceof Error ? err.message : 'Failed to submit application.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 pb-24">

      {/* ── Greeting ── */}
      <div className="mb-6">
        <p className="text-2xl font-bold text-slate-900">Good {getGreeting()}, {getFirstName(profile.name)}</p>
        <p className="text-sm text-slate-500 mt-0.5">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      </div>

      {/* ── Progress Card ── */}
      <CaregiverProgressCard
        profile={profile}
        onNavigate={onNavigate}
        onShowToast={onShowToast}
      />

      {/* ── Info requested / Rejected Banner ── */}
      {(profile.verificationStatus === 'info_requested' || profile.verificationStatus === 'rejected') && (
        <ProfileApprovalBanner profile={profile} />
      )}

      {/* ── 2-column layout ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Left: Job Board */}
        <div className="lg:col-span-2">
          <h2 className="text-xl font-bold text-slate-900 mb-4">Nearby Jobs</h2>
          {loadingJobs ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 animate-pulse">
                {[1, 2, 3].map(i => (
                  <div key={i} className="border border-slate-100 rounded-xl p-4">
                    <div className="flex items-start gap-3 mb-2">
                      <div className="w-9 h-9 rounded-full bg-slate-200 flex-shrink-0" />
                      <div className="flex-1 space-y-1.5">
                        <div className="h-3.5 bg-slate-200 rounded w-3/4" />
                        <div className="h-3 bg-slate-100 rounded w-1/3" />
                      </div>
                    </div>
                    <div className="h-3 bg-slate-100 rounded w-full mb-1" />
                    <div className="h-3 bg-slate-100 rounded w-2/3" />
                  </div>
                ))}
              </div>
            ) : jobs.length === 0 ? (
              <div className="text-center py-8">
                <Briefcase className="w-8 h-8 text-slate-200 mx-auto mb-2" />
                <p className="text-sm text-slate-400">No jobs posted yet. Check back soon.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {jobs.map(job => {
                  const p = profile as any;
                  const cgLat = p.latitude ?? p.lat;
                  const cgLng = p.longitude ?? p.lng;
                  const dist = (cgLat != null && cgLng != null && (job as any).lat != null && (job as any).lng != null)
                    ? (() => {
                        const R = 3959, dLat = ((job as any).lat - cgLat) * Math.PI / 180, dLng = ((job as any).lng - cgLng) * Math.PI / 180;
                        const a = Math.sin(dLat/2)**2 + Math.cos(cgLat*Math.PI/180)*Math.cos((job as any).lat*Math.PI/180)*Math.sin(dLng/2)**2;
                        return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))).toFixed(1);
                      })()
                    : null;
                  const freq = (job as any).jobFrequency || '';
                  const freqLabel = freq === 'full-time' ? 'FULL-TIME' : freq === 'part-time' ? 'PART-TIME' : 'OCCASIONAL';
                  const times: string[] = (job as any).timeOfDay || [];
                  const isDay = times.some((t: string) => ['morning','afternoon'].includes(t));
                  const isNight = times.some((t: string) => ['evening','overnight'].includes(t));
                  const needsTransport = ((job as any).careTypes || (job as any).requirements || []).some((r: string) => /transport/i.test(r));
                  const seniors = (job as any).recipientsCount || (job as any).numberOfSeniors;
                  const dateStr = (job as any).date
                    ? new Date((job as any).date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
                    : null;
                  const timeStr = (() => {
                    const s = (job as any).startTime, e = (job as any).endTime;
                    if (s && e) return `${s} – ${e}`;
                    const labels = times.map((t: string) => t.charAt(0).toUpperCase() + t.slice(1));
                    return labels.join(', ') || null;
                  })();
                  const isCash = !((job as any).paymentMethod) || (job as any).paymentMethod === 'cash';
                  return (
                    <div key={job.id} className="bg-white rounded-2xl p-5 hover:shadow-md shadow-sm transition-all">
                      {/* Header: title + rate */}
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <div className="min-w-0 flex-1">
                          <h4 className="font-bold text-slate-900 text-sm leading-snug mb-1">{job.title || 'Senior Care'}</h4>
                          <div className="flex items-center gap-1.5 text-xs text-slate-500">
                            <MapPin className="w-3 h-3 flex-shrink-0" />
                            <span>{job.location || (job as any).zipCode || 'Location TBD'}</span>
                            {dist && <span className="text-slate-400">({dist} mi away)</span>}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          {job.rate != null && (
                            <span className="text-sm font-bold text-green-700 bg-green-100 px-2.5 py-1 rounded-full">${job.rate}/hr</span>
                          )}
                          {(job as any).paymentMethod && (
                            <p className="text-[10px] text-slate-400 mt-1 flex items-center justify-end gap-0.5">
                              {isCash ? <Banknote className="w-3 h-3" /> : <CreditCard className="w-3 h-3" />}
                              via {isCash ? 'cash' : 'card'}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Badges */}
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-primary-50 text-primary-700">{freqLabel}</span>
                        {isDay && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-primary-50 text-primary-700 flex items-center gap-1"><Sun className="w-3 h-3" />Day</span>}
                        {isNight && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 flex items-center gap-1"><Moon className="w-3 h-3" />Night</span>}
                        {seniors > 1 && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 flex items-center gap-1"><UsersIcon className="w-3 h-3" />{seniors} seniors</span>}
                        {needsTransport && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 flex items-center gap-1"><Car className="w-3 h-3" />Transport</span>}
                      </div>

                      {/* Date + time */}
                      {(dateStr || timeStr) && (
                        <div className="bg-slate-50 rounded-xl px-3 py-2 mb-4 space-y-1">
                          {dateStr && <div className="flex items-center gap-2 text-xs text-slate-600"><Calendar className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />{dateStr}</div>}
                          {timeStr && <div className="flex items-center gap-2 text-xs text-slate-600"><Clock className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />{timeStr}</div>}
                        </div>
                      )}

                      {/* Buttons */}
                      <div className="flex gap-2">
                        <button onClick={() => setApplyingJob(job)} className="flex-1 py-2 bg-primary-600 hover:bg-primary-700 text-white text-xs font-bold rounded-xl transition-colors">Apply Now</button>
                        <button onClick={() => setViewingJob(job)} className="px-4 py-2 border border-slate-200 hover:border-slate-300 text-slate-700 text-xs font-semibold rounded-xl transition-colors">Details</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          {jobs.length > 0 && (
            <div className="text-center pt-2 pb-1">
              <button onClick={() => onNavigate('caregiver-jobs')} className="inline-flex items-center gap-1.5 text-sm text-primary-600 font-medium hover:text-primary-700 hover:underline transition-colors">
                See more →
              </button>
            </div>
          )}
        </div>

        {/* Right sidebar: Care Requests + Bookings */}
        {profile.uid && (
          <div className="lg:col-span-1 space-y-4">
            <CaregiverCareRequestsCard caregiverId={profile.uid} />
            <CaregiverBookingsCard caregiverId={profile.uid} pendingOnly />
          </div>
        )}

      </div>

      {/* ── Job Details Modal ── */}
      {viewingJob && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setViewingJob(null)} />
          <div className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl p-6 max-h-[90vh] overflow-y-auto">
            <button onClick={() => setViewingJob(null)} className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"><X size={24} /></button>

            {/* Header */}
            <div className="pr-8 mb-1">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-xl font-bold text-slate-900 leading-tight">{viewingJob.title}</h2>
                {viewingJob.rate != null && (
                  <span className="bg-green-100 text-green-700 text-sm font-bold px-3 py-1 rounded-full shrink-0">${viewingJob.rate}/hr</span>
                )}
              </div>
              <p className="text-slate-500 text-sm mt-1">Posted by {viewingJob.clientName}</p>
              {viewingJob.location && (
                <p className="text-slate-400 text-xs mt-0.5 flex items-center gap-1"><MapPin className="w-3 h-3" />{viewingJob.location}</p>
              )}
            </div>

            {/* Chips */}
            {(viewingJob.jobFrequency || (viewingJob.careTypes ?? (viewingJob as any).requirements ?? []).length > 0) && (
              <div className="flex flex-wrap gap-2 mt-3 mb-4">
                {viewingJob.jobFrequency && (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-700 text-[11px] font-semibold uppercase tracking-wide">
                    {({'one-time':'Occasional','occasional':'Occasional','part-time':'Part-time','full-time':'Full-time'} as Record<string,string>)[viewingJob.jobFrequency] || viewingJob.jobFrequency}
                  </span>
                )}
                {(viewingJob.careTypes ?? (viewingJob as any).requirements ?? []).map((ct: string, i: number) => (
                  <span key={i} className="text-[11px] bg-blue-50 text-blue-700 border border-blue-100 px-2.5 py-0.5 rounded-full font-medium">{ct}</span>
                ))}
              </div>
            )}

            {/* Schedule */}
            <div className="bg-slate-50 p-4 rounded-xl space-y-2 text-sm mb-4">
              {(viewingJob.startDate || (viewingJob as any).date) && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Starting Date</span>
                  <span className="font-medium">{(() => { const d = new Date(((viewingJob.startDate || (viewingJob as any).date) as string) + 'T12:00:00'); return isNaN(d.getTime()) ? (viewingJob.startDate || (viewingJob as any).date) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); })()}</span>
                </div>
              )}
              {Array.isArray(viewingJob.daysOfWeek) && viewingJob.daysOfWeek.length > 0 && (
                <div className="flex justify-between"><span className="text-slate-500">Days</span><span className="font-medium">{viewingJob.daysOfWeek.join(', ')}</span></div>
              )}
              {(() => {
                const timeLabel = viewingJob.startTime && viewingJob.endTime && viewingJob.startTime !== '-'
                  ? `${viewingJob.startTime} – ${viewingJob.endTime}`
                  : Array.isArray(viewingJob.timeOfDay) && viewingJob.timeOfDay.length > 0
                    ? (viewingJob.timeOfDay as string[]).map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(', ')
                    : null;
                return timeLabel ? (
                  <div className="flex justify-between"><span className="text-slate-500">Time</span><span className="font-medium">{timeLabel}</span></div>
                ) : null;
              })()}
              {viewingJob.recipientsCount != null && (
                <div className="flex justify-between"><span className="text-slate-500">Seniors</span><span className="font-medium">{viewingJob.recipientsCount} {viewingJob.recipientsCount === 1 ? 'senior' : 'seniors'}</span></div>
              )}
              {viewingJob.minHoursPerWeek != null && (
                <div className="flex justify-between"><span className="text-slate-500">Hours/week</span><span className="font-medium">{viewingJob.minHoursPerWeek}+ hrs</span></div>
              )}
            </div>

            {/* Description */}
            {viewingJob.description && (
              <div className="mb-4">
                <h3 className="font-bold text-slate-900 mb-2 text-sm">Description</h3>
                <p className="text-slate-600 text-sm leading-relaxed break-words">{viewingJob.description}</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <button onClick={() => setViewingJob(null)} className="flex-1 py-2.5 border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-semibold rounded-xl transition-colors">Close</button>
              <button onClick={() => { setApplyingJob(viewingJob); setViewingJob(null); }} className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-bold rounded-xl transition-colors">Apply Now</button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* ── Apply Modal ── */}
      {applyingJob && createPortal(
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setApplyingJob(null)} />
          <div className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl flex flex-col max-h-[90vh]">
            <button onClick={() => setApplyingJob(null)} className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 z-10"><X size={24} /></button>

            <div className="overflow-y-auto flex-1 p-6">
              <h2 className="text-xl font-bold text-slate-900 mb-1">Apply for Position</h2>
              <p className="text-slate-500 text-sm mb-6">{applyingJob.title}</p>

              <form id="dashboard-apply-form" onSubmit={handleApplyToJob} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Cover Letter <span className="text-slate-400 font-normal">(Optional)</span>
                  </label>
                  <textarea
                    value={coverLetter}
                    onChange={e => setCoverLetter(e.target.value)}
                    placeholder="Tell the client why you're a good fit..."
                    className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                    rows={4}
                  />
                </div>

                <div className="bg-slate-50 p-4 rounded-xl">
                  <h4 className="font-medium text-slate-900 mb-2">Your Profile</h4>
                  <div className="text-sm text-slate-600 space-y-1">
                    <p><span className="text-slate-400">Experience:</span> {profile.experience ?? 0} years</p>
                    {(profile as any).rating != null && (
                      <p><span className="text-slate-400">Rating:</span> {Number((profile as any).rating).toFixed(1)} ⭐</p>
                    )}
                    {(profile as any).skills?.length > 0 && (
                      <p><span className="text-slate-400">Skills:</span> {(profile as any).skills.slice(0, 3).join(', ')}</p>
                    )}
                  </div>
                </div>

                {applyingJob.rate != null && (
                  <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-800">
                    <strong>Client's budget:</strong> ${applyingJob.rate}/hr
                  </div>
                )}
              </form>
            </div>

            <div className="border-t border-slate-100 p-4 flex gap-3 bg-white rounded-b-3xl">
              <button type="button" onClick={() => setApplyingJob(null)} className="flex-1 py-2.5 border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-semibold rounded-xl transition-colors">Cancel</button>
              <button type="submit" form="dashboard-apply-form" disabled={submitting} className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white text-sm font-bold rounded-xl transition-colors flex items-center justify-center gap-2">
                {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting...</> : 'Submit Application'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
