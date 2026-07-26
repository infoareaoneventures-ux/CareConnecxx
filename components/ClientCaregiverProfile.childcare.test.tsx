// ClientCaregiverProfile childcare additions (plan 2026-07-22-002, U11).
//
// Pins: the childcare chip/evidence appear ONLY when the server projection
// marks the caregiver childcare-visible; senior-only caregiver data renders
// byte-identically (parity); reputation shown is the per-vertical childcare
// aggregate, labeled as such (R45).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

vi.mock('../lib/firebase', () => ({
  functions: { httpsCallable: vi.fn(() => async () => { throw new Error('unused'); }) },
  auth: { currentUser: null },
  db: undefined,
  default: {},
}));
vi.mock('../hooks/useAccessGates', () => ({
  useAccessGates: () => ({ gate: vi.fn(), Modals: () => null }),
}));
vi.mock('../context/CareConnexContext', () => ({
  useCareConnex: () => ({ addToast: vi.fn() }),
}));
vi.mock('../services/api', () => ({
  dbService: { getJobPostsByClient: vi.fn(async () => []) },
  authService: { getCurrentUser: () => null },
}));
vi.mock('./ScheduleInterviewModal', () => ({ ScheduleInterviewModal: () => null }));
vi.mock('./client/LeaveReviewModal', () => ({ LeaveReviewModal: () => null }));
vi.mock('./client/ClientNavigation', () => ({ ClientNavigation: () => <nav data-testid="client-nav" /> }));

import ClientCaregiverProfile from './ClientCaregiverProfile';

const SENIOR_ONLY = {
  firstName: 'Sarah',
  lastName: 'Martinez',
  rating: 4.9,
  reviewCount: 21,
  hourlyRate: 32,
  city: 'San Jose',
  bio: 'Experienced senior caregiver.',
  skills: ['Companionship'],
  backgroundCheckStatus: 'clear',
};

function renderProfile(data: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <ClientCaregiverProfile modalMode overrideId="cg1" overrideData={data} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ClientCaregiverProfile — childcare visibility', () => {
  it('senior-only caregiver: NO childcare chip and the senior profile renders unchanged (parity)', () => {
    const { container } = renderProfile(SENIOR_ONLY);
    expect(screen.getByText('Sarah Martinez')).toBeTruthy();
    expect(screen.getByText(/4\.9 \(21 reviews\)/)).toBeTruthy();
    expect(screen.queryByTestId('childcare-available-chip')).toBeNull();
    expect(container.innerHTML).not.toMatch(/childcare/i);
  });

  it('caregivers-doc summary shape (childcareProvider.visible): chip + evidence labels render', () => {
    renderProfile({
      ...SENIOR_ONLY,
      childcareProvider: { visible: true, evidenceLabels: ['background_check_current', 'childcare_reviewed'] },
      childcareReputationSummary: { ratingAvg: 4.7, ratingCount: 3 },
    });
    const chip = screen.getByTestId('childcare-available-chip');
    // Per-vertical childcare reputation, clearly labeled — never the senior 4.9.
    expect(chip.textContent).toContain('4.7 (3 childcare reviews)');
    expect(screen.getByTestId('childcare-evidence-background_check_current')).toBeTruthy();
    expect(screen.getByTestId('childcare-evidence-childcare_reviewed')).toBeTruthy();
  });

  it('public projection shape (verticalVisibility.child): chip renders too', () => {
    renderProfile({
      ...SENIOR_ONLY,
      verticalVisibility: { child: true },
      childcareEvidenceLabels: ['childcare_policy_accepted'],
      childcareReputation: { ratingAvg: 5, ratingCount: 1 },
    });
    expect(screen.getByTestId('childcare-available-chip')).toBeTruthy();
    expect(screen.getByTestId('childcare-evidence-childcare_policy_accepted')).toBeTruthy();
  });

  it('a NOT-visible childcare summary shows nothing (AE9 direction: no unearned childcare claim)', () => {
    renderProfile({
      ...SENIOR_ONLY,
      childcareProvider: { visible: false, evidenceLabels: ['background_check_current'] },
    });
    expect(screen.queryByTestId('childcare-available-chip')).toBeNull();
    expect(screen.queryByTestId('childcare-evidence-background_check_current')).toBeNull();
  });

  it('unknown evidence labels are dropped, not invented (display only what the allowlist knows)', () => {
    renderProfile({
      ...SENIOR_ONLY,
      childcareProvider: { visible: true, evidenceLabels: ['totally_made_up_label'] },
    });
    expect(screen.getByTestId('childcare-available-chip')).toBeTruthy();
    expect(screen.queryByTestId('childcare-evidence-totally_made_up_label')).toBeNull();
  });
});
