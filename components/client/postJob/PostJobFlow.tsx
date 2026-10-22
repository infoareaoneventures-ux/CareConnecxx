import React, { useState } from 'react';
import { recordActedForPerson } from '../../../services/api';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { ClientNavigation } from '../ClientNavigation';
import { StepIndicator } from '../../ui/StepIndicator';
import { useCareConnex } from '../../../context/CareConnexContext';
import { dbService } from '../../../services/api';
import { db } from '../../../lib/firebase';
import { geocodeAddress } from '../../../utils/geocode';
import { Step1Schedule } from './Step1Schedule';
import { Step2WhoWhere } from './Step2WhoWhere';
import { postCareKinds, Step3CareNeeds } from './Step3CareNeeds';
import { Step4Rate } from './Step4Rate';
import { Step5Describe } from './Step5Describe';
import { Step6Review } from './Step6Review';
import { JobPostFormData, INITIAL_FORM_DATA } from './types';
import { kindsOfServices, recipientCareKind } from '../../caregiver/signup/constants';

const TOTAL_STEPS = 6;

export const PostJobFlow: React.FC = () => {
  const navigate = useNavigate();
  const { currentUser, addToast } = useCareConnex();

  const [step, setStep] = useState(0);
  const [data, setData] = useState<JobPostFormData>(INITIAL_FORM_DATA);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittedPostId, setSubmittedPostId] = useState<string | null>(null);

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
      // The post's point (ONE rule, 2026-10-11 — Evia's buildJobPost.ts follows it
      // through jobPostCoords.ts): the selected Care Plan location's saved
      // street-level point, else the street geocoded once here. The street
      // itself is never sent to the post; only lat/lng (+ geoPrecision) are.
      // Transportation alone defers to the picked recipients' kinds (Step 3's lists).
      const postKinds = kindsOfServices(data.careTypes, postCareKinds(data.careRecipients));
      const point = data.locationPoint?.geoPrecision === 'street'
        ? data.locationPoint
        : await geocodeAddress({ street: data.streetAddress, city: data.city, state: data.state, zipCode: data.zipCode }).catch(() => null);
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
        ...(point ? { lat: point.lat, lng: point.lng, geoPrecision: point.geoPrecision } : {}),

        careTypes: data.careTypes,
        careLevel: data.careLevel || undefined,
        petsInHome: data.petsInHome,
        smokingHousehold: data.smokingHousehold,
        // Who the care is for, read from the ticked services (Transportation alone
        // falls back to the picked recipients); the age chips ride along for child care.
        careKinds: postKinds,
        ...(postKinds.includes('child') && data.ageRanges.length ? { ageRanges: data.ageRanges } : {}),
      };

      const id = await dbService.createJobPost(payload as any, currentUser.uid);
      void recordActedForPerson('job_post_created', 'posted a job for care providers to see');
      setSubmittedPostId(typeof id === 'string' ? id : 'posted');
      addToast('Job posted! Care providers can now apply.', 'success');

      // Note: createJobPost stores the point passed above (and only geocodes itself when none was).

      // Save recipients to job_postings (for care plan recipient tabs) and
      // save per-recipient care data to carePlans/{uid}.recipientPlans
      if (db && data.careRecipients.length > 0) {
        try {
          const jpRef = db.collection('job_postings').doc(currentUser.uid);
          const existing = await jpRef.get();
          const existingData = (existing.data() as any) || {};

          const isChild = (r: { relationship?: string; careKind?: string }) => recipientCareKind(r.relationship, r.careKind) === 'child';
          const sameName = (a: { firstName?: string; lastName?: string }, b: { firstName?: string; lastName?: string }) =>
            (a.firstName || '').trim().toLowerCase() === (b.firstName || '').trim().toLowerCase() && (a.lastName || '').trim().toLowerCase() === (b.lastName || '').trim().toLowerCase();

          // Only set primary recipient if none exists yet
          if (!existingData.careRecipientFirstName) {
            const primary = data.careRecipients[0];
            await jpRef.set({
              careRecipientFirstName: primary.firstName,
              careRecipientLastName: primary.lastName || '',
              relationship: primary.relationship || '',
              ...(isChild(primary) && primary.ageRange ? { careRecipientAgeRange: primary.ageRange } : {}),
            }, { merge: true });
          } else {
            // A stage picked on Step 3 for the primary child lands on the record (one stage per child).
            const primary = data.careRecipients.find(r => sameName(r, { firstName: existingData.careRecipientFirstName, lastName: existingData.careRecipientLastName || '' }));
            if (primary && isChild(primary) && primary.ageRange && existingData.careRecipientAgeRange !== primary.ageRange) {
              await jpRef.set({ careRecipientAgeRange: primary.ageRange }, { merge: true });
            }
          }

          // Additional recipients: add the new ones; a stage picked on Step 3 updates the existing entry (never a duplicate).
          const existingAdd: any[] = Array.isArray(existingData.additionalRecipients) ? existingData.additionalRecipients : [];
          const nextAdd = existingAdd.slice();
          let changed = false;
          for (const r of data.careRecipients) {
            if (sameName(r, { firstName: existingData.careRecipientFirstName, lastName: existingData.careRecipientLastName || '' })) continue;
            const idx = nextAdd.findIndex(e => sameName(e, r));
            if (idx >= 0) {
              if (isChild(r) && r.ageRange && nextAdd[idx]?.ageRange !== r.ageRange) { nextAdd[idx] = { ...nextAdd[idx], ageRange: r.ageRange }; changed = true; }
              continue;
            }
            nextAdd.push({
              firstName: r.firstName, lastName: r.lastName || '', relationship: r.relationship || '',
              ...(r.careKind ? { careKind: r.careKind } : {}),
              ...(isChild(r) && r.ageRange ? { ageRange: r.ageRange } : {}),
            });
            changed = true;
          }
          if (changed) await jpRef.set({ additionalRecipients: nextAdd }, { merge: true });

          // Save per-recipient care needs to carePlans. The job description stays on the job post only —
          // care-plan Notes are the family's private, per-person field, edited on the Care Plan page (founder, 2026-10-09).
          // Location (with pets/smoking) is synced to locationPool — only set on recipient if none exists yet.
          const cpRef = db.collection('carePlans').doc(currentUser.uid);
          const cpSnap = await cpRef.get();
          const cpData = (cpSnap.data() as any) || {};
          const locationEntry = data.streetAddress
            ? [{ street: data.streetAddress, city: data.city, state: data.state, zipCode: data.zipCode, petsInHome: data.petsInHome ?? false, smokingHousehold: data.smokingHousehold ?? false }]
            : [];

          // Sync pets/smoking (and the point this post was geocoded with, so the
          // next post from this address reuses it) to the matching locationPool entry
          if (data.streetAddress) {
            const pool: any[] = cpData.locationPool || [];
            const poolIdx = pool.findIndex((l: any) => l.street?.toLowerCase() === data.streetAddress.toLowerCase() && l.zipCode === data.zipCode);
            const pointFields = point ? { lat: point.lat, lng: point.lng, geoPrecision: point.geoPrecision } : {};
            if (poolIdx >= 0) {
              pool[poolIdx] = { ...pool[poolIdx], petsInHome: data.petsInHome ?? false, smokingHousehold: data.smokingHousehold ?? false, ...pointFields };
            } else {
              pool.push({ street: data.streetAddress, city: data.city, state: data.state, zipCode: data.zipCode, petsInHome: data.petsInHome ?? false, smokingHousehold: data.smokingHousehold ?? false, ...pointFields });
            }
            try { await cpRef.set({ locationPool: pool }, { merge: true }); } catch { /* non-critical */ }
          }

          for (const r of data.careRecipients) {
            const key = `${r.firstName.toLowerCase()}_${(r.lastName || 'noname').toLowerCase()}`.replace(/\s+/g, '_');
            const existingLocs = cpData?.recipientPlans?.[key]?.locations;
            const updates: Record<string, any> = {
              [`recipientPlans.${key}.careNeeds`]: data.careTypes,
              [`recipientPlans.${key}.careNeedDetails`]: data.careNeedDetails || {},
              ...(recipientCareKind(r.relationship, r.careKind) === 'child' && r.ageRange ? { [`recipientPlans.${key}.ageRange`]: r.ageRange } : {}),
            };
            // Only set location if recipient has none saved yet
            if (!existingLocs?.length) {
              updates[`recipientPlans.${key}.locations`] = locationEntry;
            }
            try {
              await cpRef.update(updates);
            } catch (e: any) {
              if (e.code === 'not-found') {
                await cpRef.set({ recipientPlans: { [key]: { careNeeds: data.careTypes, careNeedDetails: data.careNeedDetails || {}, locations: locationEntry, ...(recipientCareKind(r.relationship, r.careKind) === 'child' && r.ageRange ? { ageRange: r.ageRange } : {}) } } });
              }
            }
          }
        } catch { /* non-critical */ }
      }
    } catch (err: any) {
      console.error('Failed to post job:', err); // the detail stays in the console, never shown to the family
      addToast('We could not post your job. Please try again.', 'error');
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
            Qualified care providers near {data.city || 'your location'} can now see and apply to your care request. We'll notify you when someone applies.
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
            <Step6Review
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
