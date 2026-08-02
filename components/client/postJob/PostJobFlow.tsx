import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
// Childcare U11 (plan 2026-07-22-002): the childcare branch of the post-job
// flow. The vertical is chosen at flow start via the recipient hub context
// (?vertical=child); the senior flow below is untouched.
import { ChildcarePostJobFlow } from './ChildcarePostJobFlow';
import { ClientNavigation } from '../ClientNavigation';
import { StepIndicator } from '../../ui/StepIndicator';
import { useCareConnex } from '../../../context/CareConnexContext';
import { dbService } from '../../../services/api';
import { db } from '../../../lib/firebase';
import firebase from '../../../lib/firebase';
import { Step1Schedule } from './Step1Schedule';
import { Step2WhoWhere } from './Step2WhoWhere';
import { Step3CareNeeds } from './Step3CareNeeds';
import { Step4Rate } from './Step4Rate';
import { Step5Describe } from './Step5Describe';
import { Step6ScreeningReview } from './Step6ScreeningReview';
import { JobPostFormData, INITIAL_FORM_DATA } from './types';

const TOTAL_STEPS = 6;

export const PostJobFlow: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { currentUser, addToast } = useCareConnex();

  // Childcare U11: explicit vertical switch at flow start. Anything other than
  // ?vertical=child renders the senior flow byte-identically (parity pinned by
  // PostJobFlow.childcare.test.tsx).
  const isChildcareVertical = new URLSearchParams(location.search).get('vertical') === 'child';

  const [step, setStep] = useState(0);
  const [data, setData] = useState<JobPostFormData>(INITIAL_FORM_DATA);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittedPostId, setSubmittedPostId] = useState<string | null>(null);

  // Childcare branch — after all hooks so the hook order stays stable.
  if (isChildcareVertical) return <ChildcarePostJobFlow />;

  const onChange = (patch: Partial<JobPostFormData>) => setData(prev => ({ ...prev, ...patch }));
  const goTo = (i: number) => setStep(Math.max(0, Math.min(TOTAL_STEPS - 1, i)));
  const next = () => goTo(step + 1);
  const back = () => {
    if (step === 0) {
      navigate('/client/dashboard');
    } else {
      goTo(step - 1);
    }
  };

  const handleSubmit = async () => {
    if (!currentUser?.uid) {
      addToast('Please sign in to post a job', 'error');
      return;
    }
    setIsSubmitting(true);
    try {
      const payload = {
        title: data.title.trim(),
        description: data.description.trim(),
        rate: data.rateFlexible ? 0 : data.rate,
        rateFlexible: data.rateFlexible,
        paymentMethod: data.paymentMethod || undefined,

        startDate: data.startDate,
        endDate: data.ongoing ? undefined : (data.endDate || undefined),
        daysOfWeek: data.daysOfWeek,
        timeOfDay: data.timeOfDay.length ? data.timeOfDay : undefined,
        minHoursPerWeek: data.minHoursPerWeek ? Number(data.minHoursPerWeek) : undefined,
        jobFrequency: data.jobFrequency || undefined,
        applicantCount: 0,

        recipientsCount: (Math.min(4, data.careRecipients.length || 1)) as 1 | 2 | 3 | 4,
        caregiversNeeded: data.caregiversNeeded || 1,
        city: data.city.trim(),
        state: data.state.trim(),
        zipCode: data.zipCode.trim(),

        careTypes: data.careTypes,
        careLevel: data.careLevel || undefined,
        petsInHome: data.petsInHome,
        smokingHousehold: data.smokingHousehold,

        screeningQuestions: data.screeningQuestions.map(q => q.trim()).filter(Boolean),
      };

      const id = await dbService.createJobPost(payload as any, currentUser.uid);
      setSubmittedPostId(typeof id === 'string' ? id : 'posted');
      addToast('Job posted! Caregivers can now apply.', 'success');

      // Note: geocoding is handled inside createJobPost — no separate geocoding needed here.

      // Save recipients to job_postings (for care plan recipient tabs) and
      // save per-recipient care data to carePlans/{uid}.recipientPlans
      if (db && data.careRecipients.length > 0) {
        try {
          const jpRef = db.collection('job_postings').doc(currentUser.uid);
          const existing = await jpRef.get();
          const existingData = (existing.data() as any) || {};

          // Only set primary recipient if none exists yet
          if (!existingData.careRecipientFirstName) {
            const primary = data.careRecipients[0];
            await jpRef.set({
              careRecipientFirstName: primary.firstName,
              careRecipientLastName: primary.lastName || '',
              relationship: primary.relationship || '',
            }, { merge: true });
          }

          // Add additional recipients via arrayUnion (no overwrite)
          for (const r of data.careRecipients) {
            const entry = { firstName: r.firstName, lastName: r.lastName || '', relationship: r.relationship || '', age: '' };
            if (
              entry.firstName === existingData.careRecipientFirstName &&
              entry.lastName === (existingData.careRecipientLastName || '')
            ) continue;
            await jpRef.set(
              { additionalRecipients: firebase.firestore.FieldValue.arrayUnion(entry) },
              { merge: true }
            );
          }

          // Save per-recipient care needs and notes to carePlans.
          // Location (with pets/smoking) is synced to locationPool — only set on recipient if none exists yet.
          const cpRef = db.collection('carePlans').doc(currentUser.uid);
          const cpSnap = await cpRef.get();
          const cpData = (cpSnap.data() as any) || {};
          const locationEntry = data.streetAddress
            ? [{ street: data.streetAddress, city: data.city, state: data.state, zipCode: data.zipCode, petsInHome: data.petsInHome ?? false, smokingHousehold: data.smokingHousehold ?? false }]
            : [];

          // Sync pets/smoking to the matching locationPool entry
          if (data.streetAddress) {
            const pool: any[] = cpData.locationPool || [];
            const poolIdx = pool.findIndex((l: any) => l.street?.toLowerCase() === data.streetAddress.toLowerCase() && l.zipCode === data.zipCode);
            if (poolIdx >= 0) {
              pool[poolIdx] = { ...pool[poolIdx], petsInHome: data.petsInHome ?? false, smokingHousehold: data.smokingHousehold ?? false };
            } else {
              pool.push({ street: data.streetAddress, city: data.city, state: data.state, zipCode: data.zipCode, petsInHome: data.petsInHome ?? false, smokingHousehold: data.smokingHousehold ?? false });
            }
            try { await cpRef.set({ locationPool: pool }, { merge: true }); } catch { /* non-critical */ }
          }

          for (const r of data.careRecipients) {
            const key = `${r.firstName.toLowerCase()}_${(r.lastName || 'noname').toLowerCase()}`.replace(/\s+/g, '_');
            const existingLocs = cpData?.recipientPlans?.[key]?.locations;
            const updates: Record<string, any> = {
              [`recipientPlans.${key}.careNeeds`]: data.careTypes,
              [`recipientPlans.${key}.careNeedDetails`]: data.careNeedDetails || {},
              [`recipientPlans.${key}.notes`]: data.description.trim(),
            };
            // Only set location if recipient has none saved yet
            if (!existingLocs?.length) {
              updates[`recipientPlans.${key}.locations`] = locationEntry;
            }
            try {
              await cpRef.update(updates);
            } catch (e: any) {
              if (e.code === 'not-found') {
                await cpRef.set({ recipientPlans: { [key]: { careNeeds: data.careTypes, careNeedDetails: data.careNeedDetails || {}, notes: data.description.trim(), locations: locationEntry } } });
              }
            }
          }
        } catch { /* non-critical */ }
      }
    } catch (err: any) {
      console.error('Failed to post job:', err);
      addToast(err?.message || 'Failed to post job. Please try again.', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (submittedPostId) {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="max-w-xl mx-auto px-4 sm:px-6 py-16 text-center">
          <div className="w-20 h-20 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-10 h-10 text-primary-600" />
          </div>
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Care Request Submitted!</h1>
          <p className="text-slate-500 mb-8">
            Qualified caregivers near {data.city || 'your location'} can now see and apply to your care request. We'll notify you when someone applies.
          </p>
          <div className="flex flex-col sm:flex-row justify-center gap-3">
            <button
              onClick={() => navigate('/client/posts')}
              className="bg-primary-600 hover:bg-primary-700 text-white font-semibold px-6 py-3 rounded-xl shadow-md transition-colors"
            >
              View Care Requests
            </button>
            <button
              onClick={() => navigate('/client/dashboard')}
              className="bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 font-semibold px-6 py-3 rounded-xl transition-colors"
            >
              Back to dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <ClientNavigation />

      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-10">
          {step === 0 && (
            <Step1Schedule data={data} onChange={onChange} onContinue={next} onBack={back} onShowToast={addToast} />
          )}
          {step === 1 && (
            <Step2WhoWhere data={data} onChange={onChange} onContinue={next} onBack={back} onShowToast={addToast} />
          )}
          {step === 2 && (
            <Step3CareNeeds data={data} onChange={onChange} onContinue={next} onBack={back} onShowToast={addToast} />
          )}
          {step === 3 && (
            <Step4Rate data={data} onChange={onChange} onContinue={next} onBack={back} onShowToast={addToast} />
          )}
          {step === 4 && (
            <Step5Describe data={data} onChange={onChange} onContinue={next} onBack={back} onShowToast={addToast} />
          )}
          {step === 5 && (
            <Step6ScreeningReview
              data={data}
              onChange={onChange}
              onContinue={next}
              onBack={back}
              onShowToast={addToast}
              isSubmitting={isSubmitting}
              onEditStep={goTo}
              onSubmit={handleSubmit}
            />
          )}
        </div>

        <div className="mt-6 flex flex-col items-center gap-3">
          <StepIndicator steps={TOTAL_STEPS} current={step} onStepClick={goTo} />
          <p className="text-xs text-slate-400">Step {step + 1} of {TOTAL_STEPS}</p>
        </div>
      </div>
    </div>
  );
};

export default PostJobFlow;
