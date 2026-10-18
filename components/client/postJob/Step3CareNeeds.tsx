import React, { useState, useEffect } from 'react';
import { Check } from 'lucide-react';
import { StepProps } from './types';
import {
  serviceLabel, CARE_KIND_LABEL, CareKind, normalizeCareKinds, serviceListsForKinds,
  AGE_RANGES, kindsOfServices,
} from '../../caregiver/signup/constants';
import { useCareConnex } from '../../../context/CareConnexContext';
import { db } from '../../../lib/firebase';

// The eight types of care per kind, nothing underneath — the same lists the
// family's setup wizard and the care provider's services step show (founder
// 2026-10-04 / 2026-10-18). The careNeedDetails field stays in the data shape,
// always {}. ONE question sits above the list(s): who the care is for — senior
// care, child care, or both (the household's answer, job_postings.careKinds).
// A senior-only answer shows exactly what this step always showed. Child care
// adds the child list and the age-range chips (informational, like pets and
// smoking — never a filter).
export const CARE_KIND_CHOICES: Array<{ value: CareKind[]; label: string }> = [
  { value: ['senior'], label: CARE_KIND_LABEL.senior },
  { value: ['child'], label: CARE_KIND_LABEL.child },
  { value: ['senior', 'child'], label: 'Both' },
];
export const sameKinds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((k) => b.includes(k));

export const Step3CareNeeds: React.FC<StepProps> = ({ data, onChange, onContinue, onBack, onShowToast }) => {
  const { currentUser } = useCareConnex();
  const [didPrepopulate, setDidPrepopulate] = useState(false);
  const [kindsLoaded, setKindsLoaded] = useState(false);

  // The household's answer on record (job_postings.careKinds) is this step's
  // default; a missing field means senior care, exactly as before.
  useEffect(() => {
    if (kindsLoaded) return;
    if (!currentUser?.uid || !db) { setKindsLoaded(true); return; }
    db.collection('job_postings').doc(currentUser.uid).get().then(snap => {
      const stored = normalizeCareKinds((snap.data() as any)?.careKinds);
      if (!sameKinds(stored, data.careKinds)) onChange({ careKinds: stored });
    }).catch(() => {}).finally(() => setKindsLoaded(true));
  }, [currentUser?.uid]);

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
        onChange({ careTypes: rp.careNeeds, careNeedDetails: {}, ...(Array.isArray(rp.ageRanges) ? { ageRanges: rp.ageRanges } : {}) });
      }
    }).catch(() => {}).finally(() => setDidPrepopulate(true));
  }, [currentUser?.uid]);

  const lists = serviceListsForKinds(data.careKinds);
  const visible = new Set(lists.flatMap(l => [...l.services]));
  const childOn = normalizeCareKinds(data.careKinds).includes('child');

  const pickKinds = (kinds: CareKind[]) => {
    // Services that are no longer on a shown list drop off; chips go with child care.
    const keptTypes = data.careTypes.filter(ct => serviceListsForKinds(kinds).some(l => (l.services as readonly string[]).includes(ct)));
    onChange({ careKinds: kinds, careTypes: keptTypes, ...(kinds.includes('child') ? {} : { ageRanges: [] }) });
  };

  const toggleCareType = (ct: string) => {
    if (data.careTypes.includes(ct)) {
      onChange({ careTypes: data.careTypes.filter(c => c !== ct), careNeedDetails: {} });
    } else {
      onChange({ careTypes: [...data.careTypes, ct], careNeedDetails: {} });
    }
  };

  const toggleAgeRange = (id: string) => {
    onChange({ ageRanges: data.ageRanges.includes(id) ? data.ageRanges.filter(a => a !== id) : [...data.ageRanges, id] });
  };

  const handleContinue = async () => {
    const chosen = data.careTypes.filter(ct => visible.has(ct));
    if (chosen.length === 0) {
      onShowToast('Please select at least one type of care', 'error');
      return;
    }
    const postKinds = kindsOfServices(chosen, data.careKinds);
    if (postKinds.includes('child') && data.ageRanges.length === 0) {
      onShowToast("Please pick the child's age range", 'error');
      return;
    }
    if (chosen.length !== data.careTypes.length) onChange({ careTypes: chosen });
    // The household's answer, remembered for the next post and the Care Plan.
    if (currentUser?.uid && db) {
      try { await db.collection('job_postings').doc(currentUser.uid).set({ careKinds: normalizeCareKinds(data.careKinds) }, { merge: true }); } catch { /* non-critical */ }
    }
    onContinue();
  };

  return (
    <div>
      <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 text-center mb-1">What type of care is needed?</h2>
      <p className="text-center text-slate-500 mb-6">Select all that apply.</p>

      <div className="mb-6">
        <p className="text-sm font-semibold text-slate-700 mb-2">Who is the care for?</p>
        <div className="grid grid-cols-3 gap-2">
          {CARE_KIND_CHOICES.map(choice => {
            const on = sameKinds(normalizeCareKinds(data.careKinds), choice.value);
            return (
              <button key={choice.label} type="button" onClick={() => pickKinds(choice.value)}
                className={`px-3 py-2.5 rounded-xl border-2 text-sm font-semibold transition-all ${on ? 'border-primary-600 bg-primary-50 text-primary-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}>
                {choice.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-5">
        {lists.map(list => (
          <div key={list.kind}>
            {lists.length > 1 && <p className="text-sm font-semibold text-slate-700 mb-2">{CARE_KIND_LABEL[list.kind]}</p>}
            <div className="space-y-2">
              {list.services.map(ct => {
                const selected = data.careTypes.includes(ct);
                return (
                  <div
                    key={`${list.kind}-${ct}`}
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
            {list.kind === 'child' && childOn && (
              <div className="mt-3">
                <p className="text-sm font-semibold text-slate-700 mb-2">Age range</p>
                <div className="flex flex-wrap gap-2">
                  {AGE_RANGES.map(a => {
                    const on = data.ageRanges.includes(a.id);
                    return (
                      <button key={a.id} type="button" onClick={() => toggleAgeRange(a.id)}
                        className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-all ${on ? 'border-primary-600 bg-primary-50 text-primary-700' : 'border-slate-300 bg-white text-slate-700 hover:border-primary-400'}`}>
                        {a.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
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
