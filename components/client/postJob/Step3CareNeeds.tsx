import React from 'react';
import { Check } from 'lucide-react';
import { StepProps, CARE_TYPES } from './types';

export const Step3CareNeeds: React.FC<StepProps> = ({ data, onChange, onContinue, onBack, onShowToast }) => {
  const toggleCareType = (ct: string) => {
    onChange({
      careTypes: data.careTypes.includes(ct)
        ? data.careTypes.filter(c => c !== ct)
        : [...data.careTypes, ct],
    });
  };

  const handleContinue = () => {
    if (data.careTypes.length === 0) {
      onShowToast('Please select at least one type of care', 'error');
      return;
    }
    onContinue();
  };

  return (
    <div>
      <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 text-center mb-1">What type of care is needed?</h2>
      <p className="text-center text-slate-500 mb-8">Select all that apply.</p>

      <div className="space-y-6">
        {/* Care types */}
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">Care needed</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {CARE_TYPES.map(ct => {
              const selected = data.careTypes.includes(ct);
              return (
                <button
                  key={ct}
                  type="button"
                  onClick={() => toggleCareType(ct)}
                  className={`flex items-center justify-between px-4 py-3 rounded-xl border-2 text-sm font-medium transition-all text-left ${
                    selected
                      ? 'bg-primary-50 border-primary-600 text-primary-700'
                      : 'bg-white border-slate-200 text-slate-600 hover:border-primary-300'
                  }`}
                >
                  <span>{ct}</span>
                  {selected && <Check className="w-4 h-4 flex-shrink-0 text-primary-600" />}
                </button>
              );
            })}
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
