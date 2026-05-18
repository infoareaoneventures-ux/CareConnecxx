import React, { useState, useEffect } from 'react';
import { Check } from 'lucide-react';
import { StepProps, CARE_TYPES } from './types';
import { useCareConnex } from '../../../context/CareConnexContext';
import { db } from '../../../lib/firebase';

const CARE_NEED_SUBS: Record<string, string[]> = {
  'Mobility Assistance': ['Ambulation', 'Transfer Assist'],
  'Dementia / Memory Care': ['Supervision / Safety monitoring', 'Memory support', 'Redirection / cueing'],
  'Medication Reminders': ['Morning', 'Afternoon', 'Evening', 'Bedtime'],
  'Personal Care': ['Bathing', 'Dressing Assistance', 'Toileting', 'Feeding', 'Comb Hair', 'Oral Hygiene', 'Skin Care', 'Physical Activity'],
  'Companionship': [],
  'Transportation': ['Doctor appointments', 'Grocery shopping', 'Pharmacy visits', 'Hairdresser / barber'],
  'Meal Preparation': ['Breakfast', 'Lunch', 'Snack', 'Dinner'],
  'Light Housekeeping': ['Light housekeeping (dusting, vacuuming, mopping)', 'Change bed linens', 'Change bath towels', 'Take out trash'],
};

export const Step3CareNeeds: React.FC<StepProps> = ({ data, onChange, onContinue, onBack, onShowToast }) => {
  const { currentUser } = useCareConnex();
  const [didPrepopulate, setDidPrepopulate] = useState(false);

  // Pre-populate from care plan for the primary recipient (only if nothing is selected yet)
  useEffect(() => {
    if (didPrepopulate || data.careTypes.length > 0) return;
    if (!currentUser?.uid || !db || data.careRecipients.length === 0) return;
    const primary = data.careRecipients[0];
    const key = `${primary.firstName.toLowerCase()}_${(primary.lastName || 'noname').toLowerCase()}`.replace(/\s+/g, '_');
    db.collection('carePlans').doc(currentUser.uid).get().then(snap => {
      if (!snap.exists) return;
      const cp = snap.data() as any;
      const rp = cp?.recipientPlans?.[key];
      if (rp?.careNeeds?.length) {
        onChange({ careTypes: rp.careNeeds, careNeedDetails: rp.careNeedDetails || {} });
      }
    }).catch(() => {}).finally(() => setDidPrepopulate(true));
  }, [currentUser?.uid]);

  const toggleCareType = (ct: string) => {
    if (data.careTypes.includes(ct)) {
      const nextDetails = { ...data.careNeedDetails };
      delete nextDetails[ct];
      onChange({ careTypes: data.careTypes.filter(c => c !== ct), careNeedDetails: nextDetails });
    } else {
      onChange({ careTypes: [...data.careTypes, ct] });
    }
  };

  const toggleSub = (careType: string, sub: string) => {
    const current = data.careNeedDetails[careType] || [];
    const next = current.includes(sub) ? current.filter(s => s !== sub) : [...current, sub];
    onChange({ careNeedDetails: { ...data.careNeedDetails, [careType]: next } });
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
      <p className="text-center text-slate-500 mb-8">Select all that apply — then choose specific tasks.</p>

      <div className="space-y-2">
        {CARE_TYPES.map(ct => {
          const selected = data.careTypes.includes(ct);
          const subs = CARE_NEED_SUBS[ct] || [];
          const selectedSubs = data.careNeedDetails[ct] || [];
          return (
            <div
              key={ct}
              className={`rounded-xl border-2 transition-all overflow-hidden ${
                selected ? 'border-primary-600 bg-primary-50' : 'border-slate-200 bg-white'
              }`}
            >
              <button
                type="button"
                onClick={() => toggleCareType(ct)}
                className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-left"
              >
                <span className={selected ? 'text-primary-700 font-semibold' : 'text-slate-600'}>{ct}</span>
                {selected && <Check className="w-4 h-4 flex-shrink-0 text-primary-600" />}
              </button>
              {selected && subs.length > 0 && (
                <div className="px-4 pb-3 pt-1 flex flex-wrap gap-2 border-t border-primary-100">
                  {subs.map(sub => {
                    const subSelected = selectedSubs.includes(sub);
                    return (
                      <button
                        key={sub}
                        type="button"
                        onClick={() => toggleSub(ct, sub)}
                        className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-all ${
                          subSelected
                            ? 'bg-primary-600 border-primary-600 text-white'
                            : 'bg-white border-slate-200 text-slate-600 hover:border-primary-300'
                        }`}
                      >
                        {sub}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
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
