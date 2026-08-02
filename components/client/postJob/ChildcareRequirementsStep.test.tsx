// U6 (plan 2026-07-22-002): ChildcareRequirementsStep — functional unwired
// component (PostJobFlow wiring is U11). Scenarios: children rendered with age
// bands (never DOB), infant-band children disabled (deferred category),
// only jurisdiction-approved categories offered, transport toggle, and the
// continue gate (>=1 child + >=1 category).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import ChildcareRequirementsStep, {
  isSelectableChild,
  canContinue,
  type ChildcareRequirementsValue,
} from './ChildcareRequirementsStep';

const CHILDREN = [
  { childId: 'child-a', displayLabel: 'A.', ageBand: 'toddler', careCategories: ['babysitting'] },
  { childId: 'child-b', displayLabel: 'B.', ageBand: 'preschool', careCategories: ['babysitting'] },
  { childId: 'child-i', displayLabel: 'I.', ageBand: 'infant', careCategories: [] },
];

const APPROVED = ['babysitting', 'after_school_care'];

const EMPTY: ChildcareRequirementsValue = {
  childIds: [],
  serviceCategories: [],
  transportRequired: false,
};

function renderStep(value: ChildcareRequirementsValue, onChange = vi.fn(), onNext = vi.fn()) {
  render(
    <ChildcareRequirementsStep
      childProfiles={CHILDREN}
      approvedServiceCategories={APPROVED}
      value={value}
      onChange={onChange}
      onNext={onNext}
    />,
  );
  return { onChange, onNext };
}

describe('ChildcareRequirementsStep (U6 — unwired)', () => {
  it('renders children with age-band chips, never exact ages/DOB', () => {
    renderStep(EMPTY);
    expect(screen.getByText('A.')).toBeTruthy();
    expect(screen.getByText('1–2 yrs')).toBeTruthy();
    expect(screen.getByText('3–4 yrs')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no DOB anywhere
  });

  it('selecting a child emits the callable-shaped value', () => {
    const { onChange } = renderStep(EMPTY);
    fireEvent.click(screen.getByLabelText('Select A.'));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY, childIds: ['child-a'] });
  });

  it('infant-band children are disabled with a deferred note (scope boundary)', () => {
    renderStep(EMPTY);
    const infantBox = screen.getByLabelText('Select I.') as HTMLInputElement;
    // The disabled attribute is the UI guard (a real browser blocks the click;
    // jsdom's synthetic events bypass it, so the attribute is what we pin) —
    // and the server hard-blocks infant-band children regardless (jobCallables).
    expect(infantBox.disabled).toBe(true);
    expect(screen.getByTestId('deferred-child-i').textContent).toMatch(/isn't available yet/);
    expect(isSelectableChild(CHILDREN[2])).toBe(false);
    expect(isSelectableChild(CHILDREN[0])).toBe(true);
  });

  it('offers ONLY jurisdiction-approved categories', () => {
    renderStep(EMPTY);
    expect(screen.getByText('Babysitting')).toBeTruthy();
    expect(screen.getByText('After School Care')).toBeTruthy();
    // Deferred categories never render (they are not in the approved list).
    expect(screen.queryByText(/Infant Care|Overnight|Medication|Specialized/)).toBeNull();
  });

  it('toggles categories and transport through onChange', () => {
    const { onChange } = renderStep(EMPTY);
    fireEvent.click(screen.getByText('Babysitting'));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY, serviceCategories: ['babysitting'] });
    fireEvent.click(screen.getByLabelText('Transport required'));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY, transportRequired: true });
  });

  it('gates Next until at least one child AND one category are selected', () => {
    expect(canContinue(EMPTY)).toBe(false);
    expect(canContinue({ ...EMPTY, childIds: ['child-a'] })).toBe(false);
    expect(canContinue({ ...EMPTY, serviceCategories: ['babysitting'] })).toBe(false);
    const ready = { childIds: ['child-a'], serviceCategories: ['babysitting'], transportRequired: false };
    expect(canContinue(ready)).toBe(true);

    const { onNext } = renderStep(ready);
    fireEvent.click(screen.getByText('Next'));
    expect(onNext).toHaveBeenCalled();
  });

  it('shows a privacy preview of exactly what caregivers will see (bands + approximate area)', () => {
    renderStep({ childIds: ['child-a', 'child-b'], serviceCategories: ['babysitting'], transportRequired: false });
    const preview = screen.getByTestId('public-preview').textContent ?? '';
    expect(preview).toContain('1–2 yrs');
    expect(preview).toContain('approximate area');
    expect(preview).not.toContain('A.'); // no child labels in the public preview line
  });
});
