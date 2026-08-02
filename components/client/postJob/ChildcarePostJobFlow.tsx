// ── ChildcarePostJobFlow (plan 2026-07-22-002, U11) ─────────────────────────
//
// The childcare branch of PostJobFlow (vertical chosen at flow start via the
// recipient hub — /client/post-job?vertical=child). Wires the U6-built
// ChildcareRequirementsStep and submits through v1-createChildcareJobPost
// ONLY (R32 — auto-ID job_posts; NEVER the legacy job_postings singleton, and
// NO direct Firestore writes, unlike the senior flow's legacy mirror).
//
// Deliberately free-text-free (R33/AE19): nothing typed here can reach the
// public childcare listing — the requirement projection is computed
// server-side from the child profiles.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { functions } from '../../../lib/firebase';
import { childcareCallable } from '../../../lib/childcareCallable';
import { ClientNavigation } from '../ClientNavigation';
import { StepIndicator } from '../../ui/StepIndicator';
import ChildcareRequirementsStep, {
  canContinue,
  type ChildcareChildSummary,
  type ChildcareRequirementsValue,
} from './ChildcareRequirementsStep';
import {
  callableErrorCode,
  isChildcareDisabledError,
  newIdempotencyKey,
} from '../../shared/childcareAccess';

type LoadState = 'loading' | 'ready' | 'unavailable' | 'error';

const TOTAL_STEPS = 3;

// Enableable pilot categories (deferred categories are server-rejected — the
// jurisdiction policy is the authority; this list mirrors ChildProfileFlow).
const APPROVED_SERVICE_CATEGORIES = ['babysitting', 'nanny_care', 'after_school_care', 'date_night_care'];

const DAY_OPTIONS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const TIME_OF_DAY_OPTIONS = ['morning', 'afternoon', 'evening'];

function dayLabel(day: string): string {
  return day.charAt(0).toUpperCase() + day.slice(1);
}

export const ChildcarePostJobFlow: React.FC = () => {
  const navigate = useNavigate();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [children, setChildren] = useState<ChildcareChildSummary[]>([]);
  const [step, setStep] = useState(0);
  const [requirements, setRequirements] = useState<ChildcareRequirementsValue>({
    childIds: [],
    serviceCategories: [],
    transportRequired: false,
  });
  const [startDate, setStartDate] = useState('');
  const [days, setDays] = useState<Set<string>>(new Set());
  const [timeOfDay, setTimeOfDay] = useState<Set<string>>(new Set());
  const [hourlyRate, setHourlyRate] = useState('');
  const [city, setCity] = useState('');
  const [stateCode, setStateCode] = useState('CA');
  const [zipCode, setZipCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeyRef = useRef(newIdempotencyKey());

  const refresh = useCallback(async () => {
    if (!functions) { setLoadState('error'); return; }
    try {
      const resp = await childcareCallable('listMyChildren')({});
      setChildren(((resp.data as { children?: ChildcareChildSummary[] })?.children) ?? []);
      setLoadState('ready');
    } catch (err) {
      setLoadState(isChildcareDisabledError(err) ? 'unavailable' : 'error');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const toggleSet = (set: Set<string>, value: string, apply: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  const scheduleValid = !!startDate && days.size > 0 && timeOfDay.size > 0 && !!city.trim() && stateCode.trim().length === 2;

  const submit = async () => {
    if (!functions || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await childcareCallable('createChildcareJobPost')({
        idempotencyKey: idempotencyKeyRef.current,
        childIds: requirements.childIds,
        serviceCategories: requirements.serviceCategories,
        transportRequired: requirements.transportRequired,
        schedule: {
          startDate,
          days: [...days],
          timeOfDay: [...timeOfDay],
        },
        hourlyRate: hourlyRate === '' ? 0 : Number(hourlyRate),
        city: city.trim(),
        state: stateCode.trim().toUpperCase(),
        ...(zipCode.trim() ? { zipCode: zipCode.trim() } : {}),
      });
      setSubmitted(true);
    } catch (err) {
      const code = callableErrorCode(err);
      if (code === 'childcare_disabled') setError('Childcare features are not available right now.');
      else if (code === 'deferred_category') setError('One of the selected care types or age groups is not available yet — adjust the selection and try again.');
      else if (code === 'jurisdiction_not_ready') setError('Childcare is not open in this state yet.');
      else if (code === 'category_not_approved') setError('One of the selected care types is not available in your area yet.');
      else if (code === 'transport_not_available') setError('Driving is not available in your area yet — uncheck the transport requirement to post.');
      else if (code === 'identity_required') setError('Verify your identity first (under Childcare → Children), then post the job.');
      else setError('Could not post the job. Please check the details and try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loadState === 'loading') {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="flex justify-center py-24" role="status" aria-label="Loading childcare job form">
          <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
        </div>
      </div>
    );
  }

  if (loadState === 'unavailable') {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="max-w-lg mx-auto px-4 py-20 text-center space-y-2">
          <h1 className="text-xl font-semibold text-slate-900">Childcare is coming soon</h1>
          <p className="text-slate-500 text-sm">Childcare job posting is not available in your area yet.</p>
        </div>
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="max-w-lg mx-auto px-4 py-20 text-center space-y-4" role="alert">
          <p className="text-slate-600 text-sm">We could not load your childcare setup.</p>
          <button
            type="button"
            onClick={() => { setLoadState('loading'); void refresh(); }}
            className="px-5 py-2.5 rounded-full bg-slate-900 text-white text-sm font-semibold"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="max-w-xl mx-auto px-4 sm:px-6 py-16 text-center">
          <div className="w-20 h-20 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-10 h-10 text-primary-600" aria-hidden="true" />
          </div>
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Childcare job posted!</h1>
          <p className="text-slate-500 mb-8">
            Eligible, verified caregivers near you have been notified. They only ever see age groups and your
            approximate area — never names or your address.
          </p>
          <button
            type="button"
            onClick={() => navigate('/childcare')}
            className="bg-primary-600 hover:bg-primary-700 text-white font-semibold px-6 py-3 rounded-xl shadow-md"
          >
            Back to childcare
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <ClientNavigation />
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-10">
          {error && (
            <div role="alert" className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 mb-4">
              {error}
            </div>
          )}

          {step === 0 && (
            <ChildcareRequirementsStep
              childProfiles={children}
              approvedServiceCategories={APPROVED_SERVICE_CATEGORIES}
              value={requirements}
              onChange={setRequirements}
              onBack={() => navigate('/childcare')}
              onNext={() => { if (canContinue(requirements)) setStep(1); }}
            />
          )}

          {step === 1 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">When and where?</h2>
                <p className="mt-1 text-sm text-gray-500">
                  Only your city and an approximate area are shown to caregivers.
                </p>
              </div>
              <label className="block text-sm text-slate-600">
                Start date
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  aria-label="Start date"
                  className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
                />
              </label>
              <fieldset>
                <legend className="text-sm text-slate-600 mb-1">Days</legend>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Days of week">
                  {DAY_OPTIONS.map((day) => (
                    <button
                      key={day}
                      type="button"
                      onClick={() => toggleSet(days, day, setDays)}
                      aria-pressed={days.has(day)}
                      className={`rounded-full border px-3 py-1 text-sm ${
                        days.has(day) ? 'border-primary-600 bg-primary-50 text-primary-700' : 'border-slate-300 text-slate-700'
                      }`}
                    >
                      {dayLabel(day)}
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="text-sm text-slate-600 mb-1">Time of day</legend>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Time of day">
                  {TIME_OF_DAY_OPTIONS.map((block) => (
                    <button
                      key={block}
                      type="button"
                      onClick={() => toggleSet(timeOfDay, block, setTimeOfDay)}
                      aria-pressed={timeOfDay.has(block)}
                      className={`rounded-full border px-3 py-1 text-sm ${
                        timeOfDay.has(block) ? 'border-primary-600 bg-primary-50 text-primary-700' : 'border-slate-300 text-slate-700'
                      }`}
                    >
                      {dayLabel(block)}
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="text-sm text-slate-600">
                  City
                  <input
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    aria-label="City"
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
                  />
                </label>
                <label className="text-sm text-slate-600">
                  State
                  <input
                    value={stateCode}
                    maxLength={2}
                    onChange={(e) => setStateCode(e.target.value.toUpperCase())}
                    aria-label="State"
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
                  />
                </label>
                <label className="text-sm text-slate-600">
                  ZIP (optional)
                  <input
                    value={zipCode}
                    maxLength={10}
                    onChange={(e) => setZipCode(e.target.value)}
                    aria-label="ZIP code"
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <label className="block text-sm text-slate-600">
                Hourly rate in dollars (leave blank for flexible)
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={hourlyRate}
                  onChange={(e) => setHourlyRate(e.target.value)}
                  aria-label="Hourly rate"
                  className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
                />
              </label>
              <div className="flex justify-between">
                <button
                  type="button"
                  onClick={() => setStep(0)}
                  className="rounded-lg border px-4 py-2 text-gray-700"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => { if (scheduleValid) setStep(2); }}
                  disabled={!scheduleValid}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Review &amp; post</h2>
                <p className="mt-1 text-sm text-gray-500">
                  Caregivers will see: age groups, care types, schedule, rate, and your approximate area — nothing
                  else.
                </p>
              </div>
              <dl className="text-sm text-slate-700 space-y-1.5">
                <div><dt className="inline font-medium">Children:</dt> <dd className="inline">{requirements.childIds.length}</dd></div>
                <div><dt className="inline font-medium">Care types:</dt> <dd className="inline">{requirements.serviceCategories.join(', ')}</dd></div>
                <div><dt className="inline font-medium">Driving needed:</dt> <dd className="inline">{requirements.transportRequired ? 'Yes' : 'No'}</dd></div>
                <div><dt className="inline font-medium">Starts:</dt> <dd className="inline">{startDate}</dd></div>
                <div><dt className="inline font-medium">Days:</dt> <dd className="inline">{[...days].map(dayLabel).join(', ')}</dd></div>
                <div><dt className="inline font-medium">Time:</dt> <dd className="inline">{[...timeOfDay].map(dayLabel).join(', ')}</dd></div>
                <div><dt className="inline font-medium">Rate:</dt> <dd className="inline">{hourlyRate === '' || Number(hourlyRate) === 0 ? 'Flexible' : `$${hourlyRate}/hr`}</dd></div>
                <div><dt className="inline font-medium">Area:</dt> <dd className="inline">{city}, {stateCode}</dd></div>
              </dl>
              <div className="flex justify-between">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="rounded-lg border px-4 py-2 text-gray-700"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={isSubmitting}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                  Post childcare job
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-col items-center gap-3">
          <StepIndicator steps={TOTAL_STEPS} current={step} onStepClick={(i) => setStep(Math.max(0, Math.min(step, i)))} />
          <p className="text-xs text-slate-400">Step {step + 1} of {TOTAL_STEPS}</p>
        </div>
      </div>
    </div>
  );
};

export default ChildcarePostJobFlow;
