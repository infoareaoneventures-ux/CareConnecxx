import React from 'react';
import { StepProps, PAYMENT_OPTIONS } from './types';

export const Step4Rate: React.FC<StepProps> = ({ data, onChange, onContinue, onBack, onShowToast }) => {
  const handleContinue = () => {
    if (!data.rateFlexible && (!data.rate || data.rate <= 0)) {
      onShowToast('Please enter an hourly rate', 'error');
      return;
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
          <div className="mb-2">
            <label className="text-sm font-semibold text-slate-700">Hourly rate</label>
          </div>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 font-semibold">$</span>
            <input
              type="number"
              min={1}
              value={data.rate ?? ''}
              disabled={data.rateFlexible}
              onChange={e => onChange({ rate: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="e.g. 32"
              className="w-full pl-8 pr-14 py-3 border-2 border-slate-200 rounded-xl text-lg font-semibold text-slate-900 focus:outline-none focus:border-primary-500 disabled:opacity-40"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-medium">/hr</span>
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
