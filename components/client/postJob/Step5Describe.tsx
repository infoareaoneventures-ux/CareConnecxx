import { isMedicationInstruction, MEDICATION_INSTRUCTION_MESSAGE } from '../../../utils/medicationInstruction';
import React, { useEffect } from 'react';
import { StepProps } from './types';
import { defaultJobTitle, kindsOfServices, JOB_DESCRIPTION_MAX_CHARS } from '../../caregiver/signup/constants';
import { postCareKinds } from './Step3CareNeeds';

const MIN_DESC = 50;
const MAX_DESC = JOB_DESCRIPTION_MAX_CHARS;
const MIN_TITLE = 10;
const MAX_TITLE = 80;

export const Step5Describe: React.FC<StepProps> = ({ data, onChange, onContinue, onBack, onShowToast }) => {
  // Auto-prefill title on first visit when city is set
  useEffect(() => {
    if (!data.title && data.city) {
      onChange({ title: defaultJobTitle(data.city, kindsOfServices(data.careTypes, postCareKinds(data.careRecipients))) });
    }
  }, [data.city, data.title, onChange]);

  const handleContinue = () => {
    const title = data.title.trim();
    const desc = data.description.trim();
    if (title.length < MIN_TITLE) {
      onShowToast(`Title must be at least ${MIN_TITLE} characters`, 'error');
      return;
    }
    if (title.length > MAX_TITLE) {
      onShowToast(`Title must be ${MAX_TITLE} characters or fewer`, 'error');
      return;
    }
    if (desc.length < MIN_DESC) {
      onShowToast(`Description must be at least ${MIN_DESC} characters so care providers have enough context`, 'error');
      return;
    }
    if (desc.length > MAX_DESC) {
      onShowToast(`Description must be ${MAX_DESC} characters or fewer`, 'error');
      return;
    }
    if (isMedicationInstruction(desc)) {
      onShowToast(MEDICATION_INSTRUCTION_MESSAGE, 'error');
      return;
    }
    onContinue();
  };

  const descRemaining = MAX_DESC - data.description.length;
  const titleRemaining = MAX_TITLE - data.title.length;

  return (
    <div>
      <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 text-center mb-1">Describe the job</h2>
      <p className="text-center text-slate-500 mb-8">Strong descriptions help care providers know if they're the right fit.</p>

      <div className="space-y-6">
        {/* Title */}
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <label className="text-sm font-semibold text-slate-700">Job title</label>
            <span className={`text-xs ${titleRemaining < 0 ? 'text-red-500' : 'text-slate-400'}`}>
              {titleRemaining} characters remaining
            </span>
          </div>
          <input
            type="text"
            value={data.title}
            onChange={e => onChange({ title: e.target.value })}
            placeholder="Senior care in Santa Clara"
            maxLength={MAX_TITLE + 10}
            className="w-full px-4 py-3 rounded-xl border-2 border-slate-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-100 focus:outline-none"
          />
        </div>

        {/* Description */}
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <label className="text-sm font-semibold text-slate-700">Details</label>
            <span className={`text-xs ${descRemaining < 0 ? 'text-red-500' : 'text-slate-400'}`}>
              {descRemaining} characters remaining
            </span>
          </div>
          <textarea
            value={data.description}
            onChange={e => onChange({ description: e.target.value })}
            rows={8}
            className="w-full px-4 py-3 rounded-xl border-2 border-slate-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-100 focus:outline-none resize-none"
          />
          <p className="mt-2 text-xs text-slate-500">
            Care providers browsing jobs can read this. Leave out medical details, addresses, phone numbers, email addresses, and anything private.
          </p>
        </div>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-slate-500 hover:text-slate-700 font-medium"
        >
          Back
        </button>
        <button
          type="button"
          onClick={handleContinue}
          className="bg-primary-600 hover:bg-primary-700 text-white font-semibold px-10 py-3 rounded-xl shadow-md transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  );
};
