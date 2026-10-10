// Where the family's job-posting wizard resumes (founder, 2026-10-09: "I want to
// make sure it's matching"). The draft on job_postings/{uid} is written by BOTH
// doors — the wizard per step, and Evia as each answer is given over text — so
// the wizard must open at the first step that still needs an answer, wherever
// those answers came from. Before this, a text-collected draft opened at step 2
// and the family clicked Next through every step Evia had already asked.
//
// Rules mirror ClientJobPostingWizard.tsx canAdvanceAt (the required steps) —
// keep the two in lockstep. Optional steps count as done when their field is
// in the draft, or when the wizard itself already moved past them (draftStep).
import { evaluateServiceArea } from './serviceArea';

export const WIZARD_TOTAL_STEPS = 15;

type Draft = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function stepDone(s: number, d: Draft, draftStep: number | null): boolean {
  const ha = (d._homeAddress && typeof d._homeAddress === 'object' ? d._homeAddress : {}) as Draft;
  const custom = d._customAddressOpen === true;
  const careZip = custom ? str(d.zipCode) : str(ha.zipCode);
  const careCity = custom ? str(d.city) : str(ha.city);
  const visited = draftStep !== null && s < draftStep;
  switch (s) {
    // Required steps — the wizard's own canAdvanceAt rules.
    case 2: return !!d.careFrequency;
    case 3: return str(ha.street).length > 0 && str(ha.zipCode).length >= 5;
    case 4: return careZip.length >= 5 && evaluateServiceArea({ zip: careZip, city: careCity }) === 'in';
    case 6: return !!d.startDate && (arr(d.selectedDays).length > 0 || d.daysFlexible === true);
    case 10: return str(d.careRecipientFirstName).length > 0;
    case 11: return str(d.emergencyFirstName).length > 0 && str(d.emergencyPhone).length >= 10;
    case 12: return arr(d.careNeeds).length > 0;
    case 13: return typeof d.rate === 'number' && d.rate > 0;
    // Optional steps — answered, or already passed on the site.
    case 5: return visited || !!d.startDate;
    case 7:
    case 8: return visited || !!d.photoURL;
    case 9: return visited || !!d.relationship;
    case 14: return visited || str(d.jobDescription).length > 0;
    default: return visited;
  }
}

/**
 * The step the wizard should open at for this draft: the first step (2…14) not
 * yet done; the review step when everything is. `draftStep` is the wizard's own
 * saved cursor (absent for a text-only draft).
 */
export function resumeStepForDraft(d: Draft | null | undefined, draftStep?: unknown): number {
  if (!d) return 1;
  const cursor = typeof draftStep === 'number' && draftStep > 1 && draftStep < WIZARD_TOTAL_STEPS ? draftStep : null;
  for (let s = 2; s < WIZARD_TOTAL_STEPS; s++) if (!stepDone(s, d, cursor)) return s;
  return WIZARD_TOTAL_STEPS;
}
