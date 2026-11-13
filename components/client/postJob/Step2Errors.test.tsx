import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('../../../context/CareConnexContext', () => ({ useCareConnex: () => ({ currentUser: null, caregiverProfile: null }) }));
vi.mock('../../../services/api', () => ({ dbService: { getSeniorProfile: async () => null, replaceFamilyAddress: async () => {} } }));
vi.mock('../../../lib/firebase', () => ({ db: null, default: { firestore: { FieldValue: { arrayUnion: (x: unknown) => x } } } }));

import { Step2WhoWhere } from './Step2WhoWhere';
import { INITIAL_FORM_DATA } from './types';

const noop = () => {};

describe('Step2WhoWhere — Continue checks show inline, not as a toast (2026-11-13)', () => {
  it('Continue with nobody selected shows the message above the button and raises no toast', () => {
    const toast = vi.fn(); const onContinue = vi.fn();
    render(<Step2WhoWhere data={{ ...INITIAL_FORM_DATA }} onChange={noop} onContinue={onContinue} onBack={noop} onShowToast={toast} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByTestId('step-error').textContent).toMatch(/at least one care recipient/i);
    expect(toast).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('a missing care location shows "Please select or add a care location" inline', () => {
    const toast = vi.fn();
    const data = { ...INITIAL_FORM_DATA, recipientsCount: 1 as const, careRecipients: [{ id: 'p1', firstName: 'Rosa', relationship: 'Parent' }] } as any;
    render(<Step2WhoWhere data={data} onChange={noop} onContinue={noop} onBack={noop} onShowToast={toast} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByTestId('step-error').textContent).toBe('Please select or add a care location');
    expect(toast).not.toHaveBeenCalled();
  });
});
