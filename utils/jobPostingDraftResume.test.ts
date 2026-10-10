import { describe, it, expect } from 'vitest';
import { resumeStepForDraft, WIZARD_TOTAL_STEPS } from './jobPostingDraftResume';

// The wizard opens at the first step still missing an answer, whichever door
// (site per-step save or Evia's per-answer mirror) wrote the draft (2026-10-09).
const home = { street: '20 Descending Dr', zipCode: '95134', city: 'San Jose', state: 'CA' };

describe('resumeStepForDraft', () => {
  it('no draft → the intro', () => {
    expect(resumeStepForDraft(null)).toBe(1);
    expect(resumeStepForDraft(undefined)).toBe(1);
  });
  it('care frequency answered by text → the home-address step, not step 2', () => {
    expect(resumeStepForDraft({ careFrequency: 'ongoing' })).toBe(3);
  });
  it("Evia's mirrored home address satisfies the address step and the care-address step when care is at home", () => {
    expect(resumeStepForDraft({ careFrequency: 'ongoing', _homeAddress: home, _customAddressOpen: false })).toBe(5);
  });
  it('a custom care address outside the service area holds the wizard at step 4', () => {
    expect(resumeStepForDraft({ careFrequency: 'ongoing', _homeAddress: home, _customAddressOpen: true, zipCode: '90210', city: 'Beverly Hills' })).toBe(4);
  });
  it('a required gap earlier always wins over a later site cursor', () => {
    expect(resumeStepForDraft({ careFrequency: 'ongoing', _homeAddress: { ...home, zipCode: '' } }, 9)).toBe(3);
  });
  it("optional steps the site already passed are not re-shown; text-only drafts see them once", () => {
    const through6 = { careFrequency: 'ongoing', _homeAddress: home, _customAddressOpen: false, startDate: '2026-10-20', selectedDays: ['Mon'] };
    expect(resumeStepForDraft(through6)).toBe(7);          // Evia-only: photo step not yet seen
    expect(resumeStepForDraft(through6, 9)).toBe(9);       // site was on step 9 → resume there
    expect(resumeStepForDraft({ ...through6, photoURL: 'x', relationship: 'parent' })).toBe(10);
  });
  it('everything required answered → the review step', () => {
    const full = {
      careFrequency: 'ongoing', _homeAddress: home, _customAddressOpen: false, startDate: '2026-10-20', selectedDays: ['Mon'],
      photoURL: 'x', relationship: 'parent', careRecipientFirstName: 'Hamse', emergencyFirstName: 'Basra', emergencyPhone: '6505633842',
      careNeeds: ['Companionship'], rate: 25, jobDescription: 'help',
    };
    expect(resumeStepForDraft(full)).toBe(WIZARD_TOTAL_STEPS);
  });
});
