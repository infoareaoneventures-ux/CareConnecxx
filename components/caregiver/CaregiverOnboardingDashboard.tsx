import React, { useState, useEffect } from 'react';
import {
  CheckCircle, ChevronRight, Briefcase, Calendar, Star,
  Video, Users, Clock, MapPin, Loader2, AlertCircle
} from 'lucide-react';
import { Caregiver, JobPost, AddToastFunction } from '../../types';
import { dbService } from '../../services/api';
import { CaregiverBookingRequests } from './CaregiverBookingRequests';
import { CaregiverInterviewManager } from './CaregiverInterviewManager';

interface CaregiverOnboardingDashboardProps {
  profile: Caregiver;
  onNavigate: (view: any) => void;
  onShowToast?: AddToastFunction;
  onViewChecklist: () => void;
  onStartBackgroundCheck: () => void;
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

export const CaregiverOnboardingDashboard: React.FC<CaregiverOnboardingDashboardProps> = ({
  profile,
  onNavigate,
  onShowToast,
  onViewChecklist,
  onStartBackgroundCheck,
}) => {
  const [jobs, setJobs] = useState<JobPost[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const isApproved = profile.verificationStatus === 'approved' || profile.verified === true;
  const [approvalOpen, setApprovalOpen] = useState(!isApproved);
  const [successOpen, setSuccessOpen] = useState(isApproved);

  useEffect(() => {
    dbService.getOpenJobs()
      .then(all => setJobs(all.slice(0, 4)))
      .catch(() => {})
      .finally(() => setLoadingJobs(false));
  }, []);

  // Approval checklist items — derived from real profile fields
  const checklist = [
    {
      label: 'Purchase membership',
      done: !!(profile as any).membershipStatus && (profile as any).membershipStatus !== 'none' && (profile as any).membershipStatus !== 'inactive',
      onClick: () => onNavigate('caregiver-membership'),
    },
    {
      label: 'Submit background check',
      done: !!profile.backgroundCheckData?.checkrCandidateId ||
            (!!profile.backgroundCheckStatus && profile.backgroundCheckStatus !== 'none'),
      onClick: onStartBackgroundCheck,
    },
    {
      label: 'Tell families more about you',
      done: (profile.bio?.length ?? 0) >= 50,
      onClick: onViewChecklist,
    },
    {
      label: 'Upload a photo',
      done: !!(profile.photo || profile.imageUrl || (profile as any).photoURL),
      onClick: onViewChecklist,
    },
    {
      label: 'Set your rates',
      done: (profile.hourlyRate ?? 0) > 0,
      onClick: onViewChecklist,
    },
  ];

  const doneCount = checklist.filter(c => c.done).length;

  // Success guide items
  const successItems = [
    {
      label: 'Record a 30-second intro video',
      done: !!profile.introVideoUrl,
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

  // Progress tracker
  const progressSteps = [
    { label: 'Welcome!', done: true },
    { label: 'Complete checklist', done: doneCount >= 3 },
    { label: 'Profile approved', done: profile.verificationStatus === 'approved' },
    { label: 'Start applying!', done: profile.verificationStatus === 'approved' },
  ];

  const currentProgressStep = progressSteps.findIndex(s => !s.done);

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 pb-24">

      {/* ── Greeting ── */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-slate-500 text-sm mb-0.5">👋 Good {getGreeting()}, {getFirstName(profile.name)}</p>
          <h1 className="text-2xl font-bold text-slate-900">
            {isApproved ? "Let's find your next family." : "Let's get you ready to apply."}
          </h1>
        </div>
      </div>

      {/* ── Approval / Approved Banner ── */}
      {!isApproved ? (
        <div className="bg-primary-50 border border-primary-200 rounded-[2rem] p-6 mb-8 flex items-start gap-4 shadow-sm">
          <div className="bg-primary-100 p-2.5 rounded-2xl flex-shrink-0">
            <AlertCircle className="w-5 h-5 text-primary-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-primary-950 mb-0.5">Let's get your profile approved.</p>
            <p className="text-sm text-primary-800 font-medium">Complete the checklist to get approved, then you can apply to jobs.</p>
          </div>
          <button
            onClick={onViewChecklist}
            className="flex-shrink-0 text-sm font-bold text-primary-700 hover:text-primary-900 underline underline-offset-2 transition-colors mt-1"
          >
            Approval checklist →
          </button>
        </div>
      ) : (
        <div className="bg-primary-50 border border-primary-200 rounded-[2rem] p-6 mb-8 flex items-start gap-4 shadow-sm">
          <div className="bg-primary-100 p-2.5 rounded-2xl flex-shrink-0">
            <CheckCircle className="w-5 h-5 text-primary-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-primary-950 mb-0.5">You're approved — start applying!</p>
            <p className="text-sm text-primary-800 font-medium">Browse open jobs on the Job Board and send your first application.</p>
          </div>
          <button
            onClick={() => onNavigate('caregiver-jobs')}
            className="flex-shrink-0 text-sm font-bold text-primary-700 hover:text-primary-900 underline underline-offset-2 transition-colors mt-1"
          >
            Go to Job Board →
          </button>
        </div>
      )}

      {/* ── Incoming Booking Requests ── */}
      {profile.uid && (
        <div className="mb-8">
          <CaregiverBookingRequests
            caregiverId={profile.uid}
            onShowToast={onShowToast || (() => {})}
          />
        </div>
      )}

      {/* ── Interview Requests ── */}
      {profile.uid && (
        <div className="mb-8">
          <CaregiverInterviewManager
            caregiverId={profile.uid}
            onShowToast={onShowToast || (() => {})}
          />
        </div>
      )}

      {/* ── Job Board Preview ── */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-900">Job Board</h2>
          <button
            onClick={() => onNavigate('caregiver-jobs')}
            className="text-sm text-primary-600 hover:text-primary-700 font-bold"
          >
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
              <div
                key={job.id}
                className="bg-white border border-slate-100 rounded-[1.5rem] p-6 hover:border-primary-300 hover:shadow-lg shadow-sm transition-all duration-300"
              >
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
                  <button
                    onClick={() => onNavigate('caregiver-jobs')}
                    className="text-sm font-bold text-primary-600 hover:text-primary-700 bg-primary-50 px-3 py-1.5 rounded-full"
                  >
                    View
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Getting Started Progress ── */}
      <div className="bg-white border border-slate-100 rounded-[2rem] p-6 mb-8 shadow-sm">
        <h2 className="text-base font-bold text-slate-900 mb-5">Getting started</h2>
        <div className="relative flex items-center justify-between">
          {/* connector line */}
          <div className="absolute left-5 right-5 top-5 h-0.5 bg-slate-100 -z-0" />
          <div
            className="absolute left-5 top-5 h-0.5 bg-primary-500 -z-0 transition-all duration-500"
            style={{ width: `${Math.min((currentProgressStep < 0 ? 4 : currentProgressStep) / 3, 1) * 100}%` }}
          />
          {progressSteps.map((ps, i) => (
            <div key={i} className="flex flex-col items-center gap-2 z-10 w-[70px]">
              <div className={`w-10 h-10 rounded-full border-2 flex items-center justify-center transition-all ${
                ps.done ? 'bg-primary-500 border-primary-500 shadow-md shadow-primary-500/20' : i === currentProgressStep ? 'bg-white border-primary-400' : 'bg-white border-slate-200'
              }`}>
                {ps.done
                  ? <CheckCircle className="w-5 h-5 text-white" />
                  : <div className={`w-3 h-3 rounded-full ${i === currentProgressStep ? 'bg-primary-400' : 'bg-slate-200'}`} />
                }
              </div>
              <p className={`text-[11px] text-center leading-tight ${ps.done ? 'text-primary-700 font-bold' : i === currentProgressStep ? 'text-slate-800 font-semibold' : 'text-slate-400 font-medium'}`}>
                {ps.label}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Approval Checklist (accordion) ── */}
      <div className="bg-white border border-slate-100 rounded-[2rem] overflow-hidden mb-6 shadow-sm">
        <button
          onClick={() => setApprovalOpen(o => !o)}
          className="w-full px-6 py-5 flex items-center justify-between text-left hover:bg-slate-50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <span className="font-bold text-slate-900">Approval Checklist</span>
            <span className={`text-[11px] px-2.5 py-1 rounded-full font-bold shadow-sm ${doneCount === checklist.length ? 'bg-green-100 text-green-800' : 'bg-primary-100 text-primary-800'}`}>
              {doneCount}/{checklist.length}
            </span>
          </div>
          <ChevronRight className={`w-5 h-5 text-slate-400 transition-transform ${approvalOpen ? 'rotate-90' : ''}`} />
        </button>
        {approvalOpen && (
          <div className="border-t border-slate-50 divide-y divide-slate-50">
            {checklist.map((item, i) => (
              <button
                key={i}
                onClick={item.done ? undefined : item.onClick}
                className={`w-full px-6 py-4 flex items-center gap-4 text-left transition-colors ${item.done ? 'cursor-default' : 'hover:bg-slate-50'}`}
              >
                <div className={`w-6 h-6 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                  item.done ? 'bg-primary-500 border-primary-500 shadow-sm' : 'border-slate-200'
                }`}>
                  {item.done && <CheckCircle className="w-4 h-4 text-white" />}
                </div>
                <span className={`text-sm font-medium flex-1 ${item.done ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
                  {item.label}
                </span>
                {!item.done && <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0" />}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Success Guide (accordion) ── */}
      <div id="success-guide" className="bg-white border border-slate-100 rounded-[2rem] overflow-hidden mb-8 shadow-sm scroll-mt-20">
        <button
          onClick={() => setSuccessOpen(o => !o)}
          className="w-full px-6 py-5 flex items-center justify-between text-left hover:bg-slate-50 transition-colors"
        >
          <div>
            <span className="font-bold text-slate-900">Success Guide</span>
            <span className="text-slate-500 font-medium text-sm ml-2 hidden sm:inline">Book jobs faster! Follow our guide below to stand out.</span>
          </div>
          <ChevronRight className={`w-5 h-5 text-slate-400 transition-transform flex-shrink-0 ${successOpen ? 'rotate-90' : ''}`} />
        </button>
        {successOpen && (
          <div className="border-t border-slate-50 divide-y divide-slate-50">
            {successItems.map((item, i) => (
              <button
                key={i}
                onClick={item.done ? undefined : item.onClick}
                className={`w-full px-6 py-4 flex items-center gap-4 text-left transition-colors ${item.done ? 'cursor-default' : 'hover:bg-slate-50'}`}
              >
                <div className={`w-6 h-6 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                  item.done ? 'bg-primary-500 border-primary-500 shadow-sm' : 'border-slate-200'
                }`}>
                  {item.done && <CheckCircle className="w-4 h-4 text-white" />}
                </div>
                <span className={`text-sm font-medium flex-1 ${item.done ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
                  {item.label}
                </span>
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
