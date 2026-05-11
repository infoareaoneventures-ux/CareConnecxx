import React, { useState, useEffect } from 'react';
import {
  CheckCircle, ChevronRight, Briefcase, Calendar, Star,
  Users, MapPin, Loader2, ArrowRight, Clock, Lock,
} from 'lucide-react';
import { Caregiver, JobPost, AddToastFunction } from '../../types';
import { dbService } from '../../services/api';
import { CaregiverBookingRequests } from './CaregiverBookingRequests';
import { CaregiverInterviewManager } from './CaregiverInterviewManager';
import { ProfileApprovalBanner } from './ProfileApprovalBanner';

interface CaregiverOnboardingDashboardProps {
  profile: Caregiver;
  onNavigate: (view: any) => void;
  onShowToast?: AddToastFunction;
  onViewChecklist: () => void;
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
}> = ({ profile, onNavigate }) => {
  const p = profile as any;
  const isApproved = p.verificationStatus === 'approved' || profile.verified === true;
  const profileComplete = p.onboardingStatus === 'profile_complete' || p.onboardingStatus === 'submitted' || isApproved;
  const hasPaid = !!(p.membershipStatus && p.membershipStatus !== 'none' && p.membershipStatus !== 'inactive');
  const checkrInitiated = !!p.backgroundCheckData?.checkrCandidateId;
  const underReview = p.verificationStatus === 'submitted';
  const rejected = p.verificationStatus === 'rejected';
  const infoRequested = p.verificationStatus === 'info_requested';
  const bgInProgress = (hasPaid || checkrInitiated || underReview) && !isApproved;

  if (isApproved) return null;

  const activeStep = !profileComplete ? 1 : !isApproved ? 2 : 3;

  // CTA card content
  let cardTitle = '';
  let cardDesc = '';
  let cardCta: { label: string; onClick: () => void } | undefined;
  let cardVariant: 'default' | 'info' | 'warning' = 'default';

  if (activeStep === 1) {
    cardTitle = 'Complete your profile';
    cardDesc = 'Add your photo, availability, services, and bio.';
    cardCta = { label: 'Complete profile', onClick: () => onNavigate('caregiver-profile') };
  } else {
    if (rejected) {
      cardTitle = 'Application not approved';
      cardDesc = p.rejectionReason || 'Contact support for details.';
      cardVariant = 'warning';
    } else if (infoRequested) {
      cardTitle = 'Additional information needed';
      cardDesc = p.infoRequestNotes || 'Please update your profile and resubmit.';
      cardCta = { label: 'Update profile', onClick: () => onNavigate('caregiver-profile') };
      cardVariant = 'warning';
    } else if (bgInProgress) {
      cardTitle = underReview ? 'Profile under review' : 'Background check in progress';
      cardDesc = underReview
        ? 'Our team is reviewing your profile. This takes 1–2 business days.'
        : 'Your background check is underway. We\'ll notify you when complete.';
      cardVariant = 'info';
    } else {
      cardTitle = 'Complete your registration';
      cardDesc = '$24.95 annual membership — covers your background check and platform access.';
      cardCta = { label: 'Complete registration · $24.95', onClick: () => onNavigate('caregiver-membership') };
    }
  }

  const steps = [
    { label: 'Account', done: true, inProgress: false },
    { label: 'Profile', done: profileComplete, inProgress: !profileComplete },
    { label: 'Verification', done: isApproved, inProgress: bgInProgress },
    { label: 'Apply', done: isApproved, inProgress: false },
  ];

  return (
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
  );
};

// ── Main Dashboard ────────────────────────────────────────────────────────────

export const CaregiverOnboardingDashboard: React.FC<CaregiverOnboardingDashboardProps> = ({
  profile,
  onNavigate,
  onShowToast,
  onViewChecklist,
}) => {
  const [jobs, setJobs] = useState<JobPost[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [successOpen, setSuccessOpen] = useState(false);
  const isApproved = (profile.verificationStatus === 'approved' || profile.verified === true)
    && profile.verificationStatus !== 'info_requested'
    && profile.verificationStatus !== 'rejected';

  useEffect(() => {
    dbService.getOpenJobs()
      .then(all => setJobs(all.slice(0, 4)))
      .catch(() => {})
      .finally(() => setLoadingJobs(false));
  }, []);

  const successItems = [
    {
      label: 'Record a 30-second intro video',
      done: !!(profile as any).introVideoUrl,
      onClick: () => onNavigate('caregiver-video'),
    },
    {
      label: 'Get a recommendation from a family',
      done: (profile.reviewCount ?? 0) > 0,
      onClick: () => onNavigate('caregiver-profile'),
    },
    {
      label: 'Add availability to your calendar',
      done: !!profile.weeklyAvailability && Object.values(profile.weeklyAvailability).some(slots => (slots as any[]).length > 0),
      onClick: () => onNavigate('caregiver-calendar'),
    },
  ];

  const greeting = isApproved
    ? "Let's find your next family."
    : profile.verificationStatus === 'info_requested'
    ? 'We need more information.'
    : profile.verificationStatus === 'rejected'
    ? 'Your application was not approved.'
    : profile.verificationStatus === 'submitted'
    ? 'Your profile is under review.'
    : 'Let\'s get you ready to apply.';

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 pb-24">

      {/* ── Greeting ── */}
      <div className="mb-6">
        <p className="text-slate-500 text-sm mb-0.5">👋 Good {getGreeting()}, {getFirstName(profile.name)}</p>
        <h1 className="text-2xl font-bold text-slate-900">{greeting}</h1>
      </div>

      {/* ── Progress Card ── */}
      <CaregiverProgressCard
        profile={profile}
        onNavigate={onNavigate}
      />

      {/* ── Info requested / Rejected Banner ── */}
      {(profile.verificationStatus === 'info_requested' || profile.verificationStatus === 'rejected') && (
        <ProfileApprovalBanner profile={profile} />
      )}

      {/* ── Approved Banner ── */}
      {isApproved && (
        <div className="bg-teal-50 border border-teal-200 rounded-[2rem] p-6 mb-8 flex items-start gap-4 shadow-sm">
          <div className="bg-teal-100 p-2.5 rounded-2xl flex-shrink-0">
            <CheckCircle className="w-5 h-5 text-teal-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-teal-950 mb-0.5">You're approved — start applying!</p>
            <p className="text-sm text-teal-800 font-medium">Browse open jobs and send your first application.</p>
          </div>
          <button
            onClick={() => onNavigate('caregiver-jobs')}
            className="flex-shrink-0 text-sm font-bold text-teal-700 hover:text-teal-900 underline underline-offset-2 transition-colors mt-1"
          >
            Job Board →
          </button>
        </div>
      )}

      {/* ── Booking Requests ── */}
      {profile.uid && (
        <div className="mb-8">
          <CaregiverBookingRequests caregiverId={profile.uid} onShowToast={onShowToast || (() => {})} />
        </div>
      )}

      {/* ── Interview Requests ── */}
      {profile.uid && (
        <div className="mb-8">
          <CaregiverInterviewManager caregiverId={profile.uid} onShowToast={onShowToast || (() => {})} />
        </div>
      )}

      {/* ── Job Board Preview ── */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-900">Job Board</h2>
          <button onClick={() => onNavigate('caregiver-jobs')} className="text-sm text-primary-600 hover:text-primary-700 font-bold">
            See all posts →
          </button>
        </div>
        {loadingJobs ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-6 h-6 text-slate-300 animate-spin" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="bg-slate-50 border border-slate-200 rounded-[2rem] p-8 text-center">
            <Briefcase className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="text-slate-500 text-sm">No jobs posted yet. Check back soon.</p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {jobs.map(job => (
              <div key={job.id} className="bg-white border border-slate-100 rounded-[1.5rem] p-6 hover:border-primary-300 hover:shadow-lg shadow-sm transition-all duration-300">
                <div className="flex items-start gap-4 mb-4">
                  <div className="w-12 h-12 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-base flex-shrink-0 shadow-inner">
                    {(job.clientName || 'F').charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-slate-900 text-sm truncate">{job.title || 'Senior Care'}, {job.jobFrequency ? job.jobFrequency.replace('-', ' ') : 'Occasional'}</p>
                    <p className="text-xs text-primary-600 font-bold">
                      starting {job.date ? new Date(job.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'Flexible'}
                    </p>
                  </div>
                </div>
                <p className="text-sm text-slate-600 line-clamp-2 mb-4 leading-relaxed font-medium">{job.description}</p>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                    <MapPin className="w-4 h-4 text-slate-400" />
                    {job.location || job.zipCode || 'Location TBD'}
                  </div>
                  <button onClick={() => onNavigate('caregiver-jobs')} className="text-sm font-bold text-primary-600 hover:text-primary-700 bg-primary-50 px-3 py-1.5 rounded-full">
                    View
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Success Guide ── */}
      <div className="bg-white border border-slate-100 rounded-[2rem] overflow-hidden mb-8 shadow-sm">
        <button
          onClick={() => setSuccessOpen(o => !o)}
          className="w-full px-6 py-5 flex items-center justify-between text-left hover:bg-slate-50 transition-colors"
        >
          <div>
            <span className="font-bold text-slate-900">Success Guide</span>
            <span className="text-slate-500 font-medium text-sm ml-2 hidden sm:inline">Book jobs faster — follow our guide to stand out.</span>
          </div>
          <ChevronRight className={`w-5 h-5 text-slate-400 transition-transform flex-shrink-0 ${successOpen ? 'rotate-90' : ''}`} />
        </button>
        {successOpen && (
          <div className="border-t border-slate-50 divide-y divide-slate-50">
            {successItems.map((item, i) => (
              <button key={i} onClick={item.done ? undefined : item.onClick}
                className={`w-full px-6 py-4 flex items-center gap-4 text-left transition-colors ${item.done ? 'cursor-default' : 'hover:bg-slate-50'}`}>
                <div className={`w-6 h-6 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${item.done ? 'bg-primary-500 border-primary-500 shadow-sm' : 'border-slate-200'}`}>
                  {item.done && <CheckCircle className="w-4 h-4 text-white" />}
                </div>
                <span className={`text-sm font-medium flex-1 ${item.done ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{item.label}</span>
                {!item.done && <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0" />}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Resources ── */}
      <div className="mb-8">
        <h2 className="text-lg font-bold text-slate-900 mb-4">Resources</h2>
        <div className="grid sm:grid-cols-3 gap-4">
          {[
            { icon: Briefcase, title: 'How CareConnex works', desc: 'Learn how to find jobs, apply, and get hired on the platform.' },
            { icon: Star, title: 'Building your profile', desc: 'Tips for standing out and getting more inquiries from families.' },
            { icon: Calendar, title: 'Getting your first booking', desc: 'Step-by-step guide to landing your first shift on CareConnex.' },
          ].map((r, i) => (
            <div key={i} className="bg-white border border-slate-100 rounded-[1.5rem] p-6 hover:border-primary-200 hover:shadow-md shadow-sm transition-all cursor-pointer">
              <div className="w-12 h-12 bg-primary-50 rounded-[1rem] flex items-center justify-center mb-4">
                <r.icon className="w-6 h-6 text-primary-600" />
              </div>
              <p className="font-bold text-slate-900 text-sm mb-1">{r.title}</p>
              <p className="text-sm font-medium text-slate-500 leading-relaxed">{r.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Community CTA ── */}
      <div className="bg-gradient-to-r from-primary-50 to-primary-50 border border-primary-100 rounded-[2rem] p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-white rounded-full shadow-sm">
            <Users className="w-6 h-6 text-primary-600" />
          </div>
          <div>
            <p className="font-bold text-slate-900">Join the CareConnex caregiver community</p>
            <p className="text-sm font-medium text-slate-600 mt-0.5">Share tips, ask questions, and connect with other caregivers.</p>
          </div>
        </div>
        <a
          href="mailto:community@careconnex.app?subject=Join%20the%20caregiver%20community"
          className="text-sm font-bold text-white bg-primary-600 hover:bg-primary-700 px-6 py-2.5 rounded-full whitespace-nowrap transition-colors shadow-md"
        >
          Join Now
        </a>
      </div>

    </div>
  );
};
