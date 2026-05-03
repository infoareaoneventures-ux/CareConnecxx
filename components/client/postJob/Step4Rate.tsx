import React from 'react';
import { Star } from 'lucide-react';
import { StepProps, PAYMENT_OPTIONS } from './types';

const RATE_MIN = 18;
const RATE_MAX = 75;
const AVG_RATE = 32;

export const Step4Rate: React.FC<StepProps> = ({ data, onChange, onContinue, onBack, onShowToast }) => {
  const handleContinue = () => {
    if (!data.rateFlexible) {
      if (!data.rate || data.rate < RATE_MIN || data.rate > RATE_MAX) {
        onShowToast(`Rate must be between $${RATE_MIN} and $${RATE_MAX}/hr`, 'error');
        return;
      }
    }
    if (!data.paymentMethod) {
      onShowToast('Please choose a payment method', 'error');
      return;
    }
    onContinue();
  };

  return (
    <div>
      <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 text-center mb-1">Set your rate</h2>
      <p className="text-center text-slate-500 mb-6">Posting is free — you only pay the caregiver you hire.</p>

      {/* Pro tip */}
      <div className="flex items-center gap-3 bg-primary-50 border border-primary-200 rounded-xl px-4 py-3 mb-6">
        <Star className="w-5 h-5 text-primary-600 flex-shrink-0" />
        <p className="text-sm text-primary-800">
          <span className="font-semibold">Pro tip:</span> jobs posting at or above the local average of <span className="font-semibold">${AVG_RATE}/hr</span> see more caregiver responses.
        </p>
      </div>

      <div className="space-y-6">
        {/* Rate */}
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <label className="text-sm font-semibold text-slate-700">Hourly rate</label>
            {!data.rateFlexible && (
              <span className="text-2xl font-bold text-primary-700">${data.rate}/hr</span>
            )}
          </div>
          <input
            type="range"
            min={RATE_MIN}
            max={RATE_MAX}
            value={data.rate}
            disabled={data.rateFlexible}
            onChange={e => onChange({ rate: Number(e.target.value) })}
            className="w-full accent-teal-600 disabled:opacity-40"
          />
          <div className="flex justify-between text-xs text-slate-400 mt-1">
            <span>${RATE_MIN}/hr</span>
            <span>Avg ${AVG_RATE}/hr</span>
            <span>${RATE_MAX}/hr</span>
          </div>

          <label className="inline-flex items-center gap-2 mt-3 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={data.rateFlexible}
              onChange={e => onChange({ rateFlexible: e.target.checked })}
              className="w-4 h-4 accent-teal-600"
            />
            Rate depends on experience
          </label>
        </div>

        {/* Payment method */}
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">Payment method</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {PAYMENT_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChange({ paymentMethod: opt.value })}
                className={`text-left px-4 py-3 rounded-xl border-2 transition-all ${
                  data.paymentMethod === opt.value
                    ? 'bg-primary-50 border-primary-600'
                    : 'bg-white border-slate-200 hover:border-primary-300'
                }`}
              >
                <p className="font-semibold text-slate-800 text-sm">{opt.label}</p>
                <p className="text-xs text-slate-500 mt-0.5">{opt.description}</p>
              </button>
            ))}
          </div>
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
