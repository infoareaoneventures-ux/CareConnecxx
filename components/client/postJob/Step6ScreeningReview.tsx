import React from 'react';
import { Plus, X, Loader2 } from 'lucide-react';
import {
  StepProps,
  TIME_OF_DAY_OPTIONS,
  CARE_LEVEL_OPTIONS,
  PAYMENT_OPTIONS,
} from './types';

const MAX_SCREENING = 5;
const MAX_Q_LEN = 500;

interface Step6Props extends StepProps {
  isSubmitting: boolean;
  onEditStep: (stepIndex: number) => void;
  onSubmit: () => void;
}

const Row: React.FC<{ label: string; value: React.ReactNode; onEdit: () => void }> = ({ label, value, onEdit }) => (
  <div className="flex items-start justify-between gap-4 py-3 border-b border-slate-100 last:border-b-0">
    <div className="min-w-0 flex-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-sm text-slate-800 mt-1 break-words">{value}</p>
    </div>
    <button
      type="button"
      onClick={onEdit}
      className="text-xs font-semibold text-primary-600 hover:text-primary-700 flex-shrink-0"
    >
      Edit
    </button>
  </div>
);

export const Step6ScreeningReview: React.FC<Step6Props> = ({
  data, onChange, onBack, onShowToast, isSubmitting, onEditStep, onSubmit,
}) => {
  const addQuestion = () => {
    if (data.screeningQuestions.length >= MAX_SCREENING) return;
    onChange({ screeningQuestions: [...data.screeningQuestions, ''] });
  };

  const updateQuestion = (i: number, value: string) => {
    const next = [...data.screeningQuestions];
    next[i] = value.slice(0, MAX_Q_LEN);
    onChange({ screeningQuestions: next });
  };

  const removeQuestion = (i: number) => {
    onChange({ screeningQuestions: data.screeningQuestions.filter((_, idx) => idx !== i) });
  };

  const handlePost = () => {
    const cleanedQuestions = data.screeningQuestions.map(q => q.trim()).filter(Boolean);
    if (cleanedQuestions.length !== data.screeningQuestions.length) {
      onChange({ screeningQuestions: cleanedQuestions });
    }
    onSubmit();
  };

  const scheduleSummary = (() => {
    const endPart = data.ongoing ? 'ongoing' : data.endDate ? `to ${data.endDate}` : '';
    const days = data.daysOfWeek.length ? data.daysOfWeek.join(', ') : 'no days';
    const tod = data.timeOfDay.length
      ? data.timeOfDay.map(v => TIME_OF_DAY_OPTIONS.find(o => o.value === v)?.label ?? v).join(', ')
      : '—';
    return `${data.startDate || '—'} ${endPart} · ${days} · ${tod}`;
  })();

  const locationSummary = [data.streetAddress, data.city, `${data.state} ${data.zipCode}`.trim()].filter(Boolean).join(', ');
  const careLevelLabel = CARE_LEVEL_OPTIONS.find(o => o.value === data.careLevel)?.label || '—';
  const paymentLabel = PAYMENT_OPTIONS.find(o => o.value === data.paymentMethod)?.label || '—';
  const rateSummary = data.rateFlexible ? 'Rate depends on experience' : `$${data.rate}/hr`;

  const householdBits: string[] = [];
  if (data.petsInHome) householdBits.push('pets in home');
  if (data.smokingHousehold) householdBits.push('smoking household');
  const householdSummary = householdBits.length ? householdBits.join(' · ') : 'none noted';

  return (
    <div>
      <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 text-center mb-1">Add screening questions</h2>
      <p className="text-center text-slate-500 mb-8">Optional — up to 5. Caregivers answer these when they apply.</p>

      {/* Screening */}
      <div className="space-y-3">
        {data.screeningQuestions.map((q, i) => (
          <div key={i} className="flex items-start gap-2">
            <textarea
              value={q}
              onChange={e => updateQuestion(i, e.target.value)}
              placeholder={`Question ${i + 1} — e.g. "Do you have experience with dementia care?"`}
              rows={2}
              className="flex-1 px-4 py-3 rounded-xl border-2 border-slate-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-100 focus:outline-none resize-none text-sm"
            />
            <button
              type="button"
              onClick={() => removeQuestion(i)}
              aria-label="Remove question"
              className="w-9 h-9 rounded-lg border border-slate-200 flex items-center justify-center text-slate-400 hover:text-red-600 hover:border-red-200 flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}

        {data.screeningQuestions.length < MAX_SCREENING && (
          <button
            type="button"
            onClick={addQuestion}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary-600 hover:text-primary-700"
          >
            <Plus className="w-4 h-4" />
            {data.screeningQuestions.length === 0 ? 'Add a screening question' : 'Add another'}
          </button>
        )}
      </div>

      {/* Review */}
      <div className="mt-10">
        <h3 className="text-lg font-bold text-slate-900 mb-3">Review your post</h3>
        <div className="bg-white rounded-2xl border border-slate-200 px-4 sm:px-6 py-1">
          <Row label="Title" value={data.title || '—'} onEdit={() => onEditStep(4)} />
          <Row label="Schedule" value={scheduleSummary} onEdit={() => onEditStep(0)} />
          <Row label="Location" value={locationSummary || '—'} onEdit={() => onEditStep(1)} />
          <Row
            label="Care needs"
            value={
              <>
                {data.careTypes.join(', ') || '—'} · <span className="text-slate-500">{careLevelLabel}</span>
                <br />
                <span className="text-xs text-slate-500">Household: {householdSummary}</span>
              </>
            }
            onEdit={() => onEditStep(2)}
          />
          <Row label="Rate & payment" value={`${rateSummary} · ${paymentLabel}`} onEdit={() => onEditStep(3)} />
          <Row label="Details" value={data.description || '—'} onEdit={() => onEditStep(4)} />
        </div>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          disabled={isSubmitting}
          className="text-sm text-slate-500 hover:text-slate-700 font-medium disabled:opacity-40"
        >
          Back
        </button>
        <button
          type="button"
          onClick={handlePost}
          disabled={isSubmitting}
          className="bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white font-semibold px-10 py-3 rounded-xl shadow-md transition-colors flex items-center gap-2"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> Submitting...
            </>
          ) : (
            'Submit Request'
          )}
        </button>
      </div>
    </div>
  );
};
