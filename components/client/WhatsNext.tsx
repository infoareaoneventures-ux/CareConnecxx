import React, { useEffect, useRef } from 'react';
import {
  Check,
  Heart,
  ChevronRight,
  Sparkles,
  ShieldCheck,
  Crown,
} from 'lucide-react';
import {
  useOnboardingProgress,
  OnboardingStepId,
} from '../../hooks/useOnboardingProgress';
import { startIdentityVerification } from '../../services/stripeService';
import { db } from '../../lib/firebase';
import { dbService } from '../../services/api';

export type OnboardingStep = OnboardingStepId;

interface StepDef {
  id: OnboardingStepId;
  label: string;
  shortLabel: string;
  title: string;
  description: string;
  cta: string;
  icon: React.ComponentType<{ className?: string }>;
  action: 'navigate' | 'scroll-matches' | 'start-identity';
  path?: string;
}

const STEP_DEFS: StepDef[] = [
  {
    id: 'care-plan',
    label: 'Care Plan',
    shortLabel: 'Care Plan',
    title: 'Tell us about your loved one',
    description: 'A complete care plan helps us match the right caregiver.',
    cta: 'Continue Care Plan',
    icon: Heart,
    action: 'navigate',
    path: '/client/care-plan',
  },
  {
    id: 'identity-check',
    label: 'Identity',
    shortLabel: 'Identity',
    title: 'Verify your identity',
    description: 'A quick ID check keeps our caregivers and community safe.',
    cta: 'Start Identity Check',
    icon: ShieldCheck,
    action: 'start-identity',
  },
  {
    id: 'pay-membership',
    label: 'Membership',
    shortLabel: 'Membership',
    title: 'Activate your membership',
    description: 'Unlock caregiver messaging, matching, and booking.',
    cta: 'View Membership Plans',
    icon: Crown,
    action: 'navigate',
    path: '/client/membership',
  },
];

interface WhatsNextProps {
  uid: string;
  displayName?: string;
  onNavigate: (path: string) => void;
  onScrollToMatches?: () => void;
}

export const WhatsNext: React.FC<WhatsNextProps> = ({
  uid,
  displayName,
  onNavigate,
  onScrollToMatches,
}) => {
  const {
    carePlanPercent,
    carePlanHint,
    steps,
    currentStep,
    completedCount,
    identityVerified,
    membershipActive,
    loading,
  } = useOnboardingProgress(uid);

  const hasAutoPosted = useRef(false);

  useEffect(() => {
    if (loading || !identityVerified || !membershipActive) return;
    if (hasAutoPosted.current) return;
    if (!db) return;

    // Check if a job post already exists before creating one
    db.collection('job_posts').where('clientId', '==', uid).limit(1).get().then(snap => {
      if (!snap.empty) return;
      hasAutoPosted.current = true;
      db!.collection('job_postings').doc(uid).get().then(postingSnap => {
        if (!postingSnap.exists) return;
        const w = postingSnap.data() as any;
        const city = w.city || '';
        const state = w.state || '';
        dbService.createJobPost({
          title: `Senior care${city ? ` in ${city}` : ''}`,
          description: w.jobDescription || 'Looking for a caring and reliable caregiver.',
          careTypes: w.careNeeds || [],
          requirements: w.careNeeds || [],
          startDate: w.startDate || new Date().toISOString().split('T')[0],
          city,
          state,
          zipCode: w.zipCode || '',
          location: [city, state].filter(Boolean).join(', '),
          streetAddress: w.street || '',
          timeOfDay: w.timeOfDay || [],
          daysOfWeek: w.selectedDays || [],
          rate: w.rate || 0,
          rateFlexible: !w.rate,
          // Cash/Venmo/Zelle removed platform-wide (Hamse, 2026-08-23) — every
          // job is paid by card now. This used to default to 'cash', the
          // opposite of every other write path's 'credit' default, which
          // meant a job could silently go out cash-only if Evia's free-form
          // intake loop completed without ever asking about payment method.
          paymentMethod: 'credit',
          careLevel: w.careLevel || 'moderate',
        }, uid).catch(() => {});
      }).catch(() => {});
    }).catch(() => {});
  }, [uid, loading, identityVerified, membershipActive]);

  if (loading) return null;

  const firstName = (displayName || 'there').split(' ')[0];
  const hour = new Date().getHours();
  const tod = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

  const allDone = currentStep === 'all-done';

  if (allDone) {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    return (
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Good {tod}, {firstName}!</h1>
        <p className="text-sm text-slate-500 mt-0.5">{today}</p>
      </div>
    );
  }
  const activeDef = !allDone ? STEP_DEFS.find((s) => s.id === currentStep) : null;

  const triggerStep = (def: StepDef) => {
    if (
      identityVerified &&
      !membershipActive &&
      def.id !== 'identity-check' &&
      def.id !== 'pay-membership'
    ) {
      onNavigate('/client/membership');
      return;
    }

    if (def.action === 'start-identity') {
      const next = '/client/membership';
      const returnUrl = `${window.location.origin}/client/identity-callback?next=${encodeURIComponent(next)}`;
      startIdentityVerification(returnUrl).catch((e) => {
        console.error('Failed to start identity verification', e);
        alert('Could not start identity verification. Please try again.');
      });
      return;
    }

    if (def.action === 'navigate' && def.path) {
      onNavigate(def.path);
    } else if (def.action === 'scroll-matches') {
      if (onScrollToMatches) {
        onScrollToMatches();
      } else {
        document
          .getElementById('caregiver-matches')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  };

  const gradientClass = allDone
    ? 'from-emerald-500 via-emerald-500 to-primary-600'
    : 'from-primary-600 via-primary-500 to-primary-50';

  const segments = STEP_DEFS.length - 1;
  const activeIdx = allDone ? segments : STEP_DEFS.findIndex((s) => s.id === currentStep);
  const fillPct = Math.min(100, (activeIdx / segments) * 100);

  return (
    <section
      className={`relative mb-6 overflow-hidden rounded-3xl bg-gradient-to-br ${gradientClass} p-6 md:p-8 shadow-xl shadow-primary-600/20`}
      aria-label="Onboarding progress"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-white opacity-10 blur-2xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-20 -left-10 h-48 w-48 rounded-full bg-white opacity-10 blur-2xl"
      />

      <div className="relative">
        <div className="flex flex-wrap items-end justify-between gap-2 mb-6">
          <div>
            <h2 className="text-2xl md:text-3xl font-bold text-white tracking-tight">
              {allDone
                ? `You're all set, ${firstName}`
                : `Good ${tod}, ${firstName}`}
            </h2>
            <p className="mt-1 text-sm text-primary-50/90">
              {allDone
                ? 'Your care coordinator is here if you need anything.'
                : `You're ${completedCount} of ${STEP_DEFS.length} steps away from care.`}
            </p>
          </div>
          {!allDone && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white backdrop-blur">
              <Sparkles className="h-3.5 w-3.5" />
              Step {STEP_DEFS.findIndex((s) => s.id === currentStep) + 1} of {STEP_DEFS.length}
            </span>
          )}
        </div>

        <div className="relative mb-6">
          <div className="absolute left-7 right-7 top-7 h-1 rounded-full bg-white/20" />
          <div
            className="absolute left-7 top-7 h-1 rounded-full bg-white transition-[width] duration-700 ease-out"
            style={{ width: `calc((100% - 3.5rem) * ${fillPct / 100})` }}
          />

          <ol className="relative grid grid-cols-3 gap-1 sm:gap-2">
            {STEP_DEFS.map((def, idx) => {
              const state = steps.find((s) => s.id === def.id);
              const done = state?.done ?? false;
              const active = !done && def.id === currentStep;
              const Icon = def.icon;

              const circleBase =
                'h-14 w-14 rounded-full flex items-center justify-center font-bold text-base transition-all duration-300';
              const circleClass = done
                ? `${circleBase} bg-white text-primary-700 ring-4 ring-white/40`
                : active
                ? `${circleBase} bg-white text-primary-700 ring-4 ring-white/60 scale-110 shadow-lg`
                : `${circleBase} bg-white/20 text-white/70 border-2 border-white/30`;

              const labelClass = done || active ? 'text-white' : 'text-white/60';
              const clickable = done || active;

              return (
                <li key={def.id} className="flex flex-col items-center">
                  <button
                    type="button"
                    onClick={() => clickable && triggerStep(def)}
                    disabled={!clickable}
                    className={`group flex flex-col items-center gap-2 ${
                      clickable ? 'cursor-pointer' : 'cursor-default'
                    }`}
                    aria-label={`${def.label}${done ? ' — completed' : active ? ' — in progress' : ' — locked'}`}
                  >
                    <span className={circleClass}>
                      {done ? (
                        <Check className="h-6 w-6" strokeWidth={3} />
                      ) : active ? (
                        <Icon className="h-6 w-6" />
                      ) : (
                        <span>{idx + 1}</span>
                      )}
                    </span>
                    <span
                      className={`text-xs md:text-sm font-semibold text-center leading-tight ${labelClass}`}
                    >
                      {def.shortLabel}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>

        {activeDef && (
          <div className="rounded-2xl bg-white/12 p-4 md:p-5 backdrop-blur">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                <h3 className="text-lg md:text-xl font-bold text-white">
                  {activeDef.title}
                </h3>
                <p className="mt-1 text-sm text-primary-50/90">
                  {activeDef.id === 'care-plan'
                    ? `${carePlanPercent}% complete — ${carePlanHint.toLowerCase()}.`
                    : activeDef.description}
                </p>

                {activeDef.id === 'care-plan' && (
                  <div className="mt-3 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-white/20">
                    <div
                      className="h-full rounded-full bg-white transition-[width] duration-500 ease-out"
                      style={{ width: `${carePlanPercent}%` }}
                    />
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => triggerStep(activeDef)}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-primary-700 shadow-md transition-all duration-200 hover:-translate-y-0.5 hover:bg-primary-50 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-primary-600"
              >
                <span>{activeDef.cta}</span>
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {allDone && (
          <div className="rounded-2xl bg-white/12 p-4 md:p-5 backdrop-blur">
            <p className="text-sm text-primary-50/95">
              Care plan complete, identity verified, membership active. You're ready to find care.
            </p>
          </div>
        )}
      </div>
    </section>
  );
};
