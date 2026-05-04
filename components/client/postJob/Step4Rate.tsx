import React from 'react';
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
