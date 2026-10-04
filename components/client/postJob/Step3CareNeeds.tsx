import React, { useState, useEffect } from 'react';
import { Check } from 'lucide-react';
import { StepProps, CARE_TYPES } from './types';
import { serviceLabel } from '../../caregiver/signup/constants';
import { useCareConnex } from '../../../context/CareConnexContext';
import { db } from '../../../lib/firebase';

// The eight types of care, nothing underneath — the same list the family's setup
// wizard and the caregiver's services step show (founder 2026-10-04). The
// careNeedDetails field stays in the data shape, always {}.
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
        onChange({ careTypes: rp.careNeeds, careNeedDetails: {} });
      }
    }).catch(() => {}).finally(() => setDidPrepopulate(true));
  }, [currentUser?.uid]);

  const toggleCareType = (ct: string) => {
    if (data.careTypes.includes(ct)) {
      onChange({ careTypes: data.careTypes.filter(c => c !== ct), careNeedDetails: {} });
    } else {
      onChange({ careTypes: [...data.careTypes, ct], careNeedDetails: {} });
    }
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

      <div className="space-y-2">
        {CARE_TYPES.map(ct => {
          const selected = data.careTypes.includes(ct);
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
                <span className={selected ? 'text-primary-700 font-semibold' : 'text-slate-600'}>{serviceLabel(ct)}</span>
                {selected && <Check className="w-4 h-4 flex-shrink-0 text-primary-600" />}
              </button>
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
