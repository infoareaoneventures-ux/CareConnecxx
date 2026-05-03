import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { ClientNavigation } from '../ClientNavigation';
import { StepIndicator } from '../../ui/StepIndicator';
import { useCareConnex } from '../../../context/CareConnexContext';
import { dbService } from '../../../services/api';
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
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Job posted!</h1>
          <p className="text-slate-500 mb-8">
            Qualified caregivers near {data.city || 'your location'} can now see and apply to your job. We'll notify you when someone applies.
          </p>
          <div className="flex flex-col sm:flex-row justify-center gap-3">
            <button
              onClick={() => navigate('/client/posts')}
              className="bg-primary-600 hover:bg-primary-700 text-white font-semibold px-6 py-3 rounded-xl shadow-md transition-colors"
            >
              View my posts
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
