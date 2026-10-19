import React, { useState, useEffect } from 'react';
import { Check } from 'lucide-react';
import { StepProps, CareRecipientEntry } from './types';
import {
  serviceLabel, CARE_KIND_LABEL, CareKind, normalizeCareKinds, serviceListsForKinds,
  AGE_RANGES, STAGE_HEADING, kindsOfServices, rosterCareKinds, recipientCareKind, recipientStage, stagesOfRecipients,
} from '../../caregiver/signup/constants';
import { useCareConnex } from '../../../context/CareConnexContext';
import { db } from '../../../lib/firebase';

// The eight types of care per kind, nothing underneath — the same lists the
// family's setup wizard and the care provider's services step show (founder
// 2026-10-04 / 2026-10-18). The careNeedDetails field stays in the data shape,
// always {}. There is NO question on this step (founder, 2026-10-18 evening):
// the household picked its care type once (signup / Account Settings →
// job_postings.careKinds) and the list(s) here follow the RECIPIENTS picked on
// Step 2 — a senior gets the senior list, a child the child list, both picked
// together get both lists under their own headings. A senior-care household
// sees exactly what this step always showed. The stage lives ON THE CHILD
// (one per child, founder 2026-10-18 late): this step asks it only for a picked
// child who has none yet, and the post's `ageRanges` = the children's stages.

/** The kinds this post can show: the picked recipients' kinds, kept inside the household's setting; no recipients yet → the setting. */
export function postCareKinds(recipients: readonly CareRecipientEntry[], householdKinds: unknown): CareKind[] {
  const household = normalizeCareKinds(householdKinds);
  const fromRoster = rosterCareKinds(recipients).filter(k => household.includes(k));
  return fromRoster.length ? fromRoster : household;
}

export const Step3CareNeeds: React.FC<StepProps> = ({ data, onChange, onContinue, onBack, onShowToast }) => {
  const { currentUser } = useCareConnex();
  const [didPrepopulate, setDidPrepopulate] = useState(false);
  const [kindsLoaded, setKindsLoaded] = useState(false);

  // The household's setting (job_postings.careKinds; missing = senior) gates
  // which lists can appear. Read only — Account Settings is the one writer.
  useEffect(() => {
    if (kindsLoaded) return;
    if (!currentUser?.uid || !db) { setKindsLoaded(true); return; }
    db.collection('job_postings').doc(currentUser.uid).get().then(snap => {
      const stored = normalizeCareKinds((snap.data() as any)?.careKinds);
      const current = normalizeCareKinds(data.careKinds);
      if (stored.length !== current.length || !stored.every(k => current.includes(k))) onChange({ careKinds: stored });
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
        onChange({ careTypes: rp.careNeeds, careNeedDetails: {} });
      }
    }).catch(() => {}).finally(() => setDidPrepopulate(true));
  }, [currentUser?.uid]);

  const kinds = postCareKinds(data.careRecipients, data.careKinds);
  const lists = serviceListsForKinds(kinds);
  const visible = new Set(lists.flatMap(l => [...l.services]));
  const childOn = kinds.includes('child');
  const recipientKey = (r: CareRecipientEntry) => `${r.firstName}|${r.lastName || ''}|${r.relationship}`;
  // The children who arrived here without a stage keep their row while the family is on this step (so a pick can be changed).
  const [askStageFor] = useState<string[]>(() => {
    if (!normalizeCareKinds(data.careKinds).includes('child')) return [];
    return data.careRecipients.filter(r => recipientCareKind(r.relationship, r.careKind) === 'child' && !recipientStage(r)).map(recipientKey);
  });
  const stageRows = data.careRecipients.filter(r => askStageFor.includes(recipientKey(r)));
  const childrenOnPost = data.careRecipients.filter(r => recipientCareKind(r.relationship, r.careKind) === 'child').length;
  const pickStage = (r: CareRecipientEntry, id: string) => {
    onChange({ careRecipients: data.careRecipients.map(x => (recipientKey(x) === recipientKey(r) ? { ...x, ageRange: id } : x)) });
  };

  const toggleCareType = (ct: string) => {
    if (data.careTypes.includes(ct)) {
      onChange({ careTypes: data.careTypes.filter(c => c !== ct), careNeedDetails: {} });
    } else {
      onChange({ careTypes: [...data.careTypes, ct], careNeedDetails: {} });
    }
  };

  const handleContinue = () => {
    const chosen = data.careTypes.filter(ct => visible.has(ct));
    if (chosen.length === 0) {
      onShowToast('Please select at least one type of care', 'error');
      return;
    }
    const postKinds = kindsOfServices(chosen, kinds);
    const missing = childOn ? data.careRecipients.find(r => recipientCareKind(r.relationship, r.careKind) === 'child' && !recipientStage(r)) : undefined;
    if (missing) {
      onShowToast(childrenOnPost > 1 ? `Please pick ${missing.firstName}'s stage` : "Please pick the child's stage", 'error');
      return;
    }
    // The post's `ageRanges` are just the picked children's stages (one per child).
    const stages = postKinds.includes('child') ? stagesOfRecipients(data.careRecipients, data.careKinds) : [];
    onChange({ ...(chosen.length !== data.careTypes.length ? { careTypes: chosen } : {}), ageRanges: stages });
    onContinue();
  };

  return (
    <div>
      <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 text-center mb-1">What type of care is needed?</h2>
      <p className="text-center text-slate-500 mb-6">Select all that apply.</p>

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
            {list.kind === 'child' && childOn && stageRows.map(r => (
              <div className="mt-3" key={recipientKey(r)}>
                <p className="text-sm font-semibold text-slate-700 mb-2">{childrenOnPost > 1 ? `${STAGE_HEADING} — ${r.firstName}` : STAGE_HEADING}</p>
                <div className="flex flex-wrap gap-2">
                  {AGE_RANGES.map(a => {
                    const on = recipientStage(r) === a.id;
                    return (
                      <button key={a.id} type="button" onClick={() => pickStage(r, a.id)}
                        className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-all ${on ? 'border-primary-600 bg-primary-50 text-primary-700' : 'border-slate-300 bg-white text-slate-700 hover:border-primary-400'}`}>
                        {a.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
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
