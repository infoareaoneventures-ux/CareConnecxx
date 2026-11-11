import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('../../../services/api', () => ({ dbService: { getPublicCaregiverRates: async () => [18, 20, 22, 24, 26, 28, 30, 32] } }));

import { Step4Rate } from './Step4Rate';
import { Step6Review } from './Step6Review';
import { INITIAL_FORM_DATA } from './types';
import { saveDraft, loadDraft, clearDraft, isMeaningfulDraft, DRAFT_MAX_AGE_MS } from './draft';
import { computeRateRange, rateRangeOrFallback } from '../../../utils/marketRate';

const noop = () => {};

describe('Step4Rate — guidance, billed amount and an inline error', () => {
  it('shows the typical local range and the billed amount as the family types', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Step4Rate data={{ ...INITIAL_FORM_DATA }} onChange={onChange} onContinue={noop} onBack={noop} onShowToast={noop} />);
    expect(await screen.findByText(/typically ask about/i)).toBeTruthy();
    expect(screen.getByTestId('billed-rate').textContent).toMatch(/9% service fee/);
    rerender(<Step4Rate data={{ ...INITIAL_FORM_DATA, rate: 25 }} onChange={onChange} onContinue={noop} onBack={noop} onShowToast={noop} />);
    expect(screen.getByTestId('billed-rate').textContent).toContain('$27.25/hr');
  });

  it('an empty rate shows the error UNDER the field (no toast) and it clears when the rate is typed', () => {
    const toast = vi.fn(); const onContinue = vi.fn();
    render(<Step4Rate data={{ ...INITIAL_FORM_DATA }} onChange={noop} onContinue={onContinue} onBack={noop} onShowToast={toast} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert').textContent).toMatch(/hourly rate/i);
    expect(toast).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Hourly rate'), { target: { value: '30' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Step6Review — readable dates, no invented details', () => {
  it('formats the dates and says how it is paid', () => {
    render(<Step6Review data={{ ...INITIAL_FORM_DATA, startDate: '2026-11-10', ongoing: true, rate: 25, title: 'Care in Gilroy', careTypes: [], daysOfWeek: ['Tue'], timeOfDay: [] }} onChange={noop} onContinue={noop} onBack={noop} onShowToast={noop} isSubmitting={false} onEditStep={noop} onSubmit={noop} />);
    expect(screen.getByText(/Tue, Nov 10, 2026/)).toBeTruthy();
    expect(screen.queryByText(/2026-11-10/)).toBeNull();
    expect(screen.getByText(/paid by card through Evia/)).toBeTruthy();
    expect(screen.queryByText(/Pets in home/i)).toBeNull();
  });
});

describe('post-a-job draft', () => {
  beforeEach(() => window.localStorage.clear());
  const filled = { ...INITIAL_FORM_DATA, title: 'Care in Gilroy', rate: 30 };

  it('saves per account, restores, and clears', () => {
    saveDraft('u1', 3, filled);
    expect(loadDraft('u1')?.step).toBe(3);
    expect(loadDraft('u1')?.data.title).toBe('Care in Gilroy');
    expect(loadDraft('someone-else')).toBeNull();
    clearDraft('u1');
    expect(loadDraft('u1')).toBeNull();
  });
  it('ignores a week-old, unreadable or empty draft', () => {
    saveDraft('u1', 2, filled, Date.now() - DRAFT_MAX_AGE_MS - 1000);
    expect(loadDraft('u1')).toBeNull();
    window.localStorage.setItem('evia.postJobDraft.u2', '{not json');
    expect(loadDraft('u2')).toBeNull();
    expect(isMeaningfulDraft({ step: 0, data: INITIAL_FORM_DATA, savedAt: 1 }, INITIAL_FORM_DATA)).toBe(false);
    expect(isMeaningfulDraft({ step: 0, data: filled, savedAt: 1 }, INITIAL_FORM_DATA)).toBe(true);
  });
  it('no uid, no storage: never throws', () => {
    expect(() => saveDraft(undefined, 1, filled)).not.toThrow();
    expect(loadDraft(undefined)).toBeNull();
  });
});

describe('market rate range', () => {
  it('25th–75th percentile, falling back to $18–28 on thin data', () => {
    expect(computeRateRange([18, 20, 22, 24, 26, 28, 30, 32])).toEqual({ min: 22, max: 30 });
    expect(computeRateRange([20, 22])).toBeNull();
    expect(rateRangeOrFallback([20, 22])).toEqual({ min: 18, max: 28 });
    expect(computeRateRange([1, 2, 999, 5000, 25, 26, 27, 28, 29])?.min).toBeGreaterThanOrEqual(10);
  });
});
