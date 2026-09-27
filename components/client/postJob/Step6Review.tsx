import React from 'react';
import { Loader2 } from 'lucide-react';
import { StepProps, TIME_OF_DAY_OPTIONS, CARE_LEVEL_OPTIONS } from './types';

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

export const Step6Review: React.FC<Step6Props> = ({
  data, onBack, isSubmitting, onEditStep, onSubmit,
}) => {
  const handlePost = () => {
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
  // The wizard never asks for a care level today — show it only when set (no dangling "· —").
  const careLevelLabel = CARE_LEVEL_OPTIONS.find(o => o.value === data.careLevel)?.label || '';
  const rateSummary = data.rateFlexible ? 'Rate depends on experience' : `$${data.rate}/hr`;

  const householdBits: string[] = [];
  if (data.petsInHome) householdBits.push('pets in home');
  if (data.smokingHousehold) householdBits.push('smoking household');

  return (
    <div>
      <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 text-center mb-1">Review your post</h2>
      <p className="text-center text-slate-500 mb-8">Take a last look before caregivers can see it.</p>

      <div className="bg-white rounded-2xl border border-slate-200 px-4 sm:px-6 py-1">
        <Row label="Title" value={data.title || '—'} onEdit={() => onEditStep(4)} />
        <Row label="Schedule" value={scheduleSummary} onEdit={() => onEditStep(0)} />
        <Row
          label="Location"
          value={
            <>
              {locationSummary || '—'}
              {householdBits.length > 0 && (
                <>
                  <br />
                  <span className="text-xs text-slate-500">{householdBits.map(b => b.charAt(0).toUpperCase() + b.slice(1)).join(' · ')}</span>
                </>
              )}
            </>
          }
          onEdit={() => onEditStep(1)}
        />
        <Row
          label="Care needs"
          value={<>{data.careTypes.join(', ') || '—'}{careLevelLabel && <> · <span className="text-slate-500">{careLevelLabel}</span></>}</>}
          onEdit={() => onEditStep(2)}
        />
        <Row label="Rate & payment" value={`${rateSummary} · Credit Card`} onEdit={() => onEditStep(3)} />
        <Row label="Details" value={data.description || '—'} onEdit={() => onEditStep(4)} />
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
