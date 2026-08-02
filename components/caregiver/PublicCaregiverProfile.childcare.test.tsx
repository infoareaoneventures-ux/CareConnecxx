// PublicCaregiverProfile childcare additions (plan 2026-07-22-002, U11/R30/R45).
//
// Pins: the public page renders ONLY what the U5/U8 projection provides —
// per-vertical visibility, allowlisted evidence labels, per-vertical
// reputation. Senior-only projections render byte-identically (parity), and
// no safety-guarantee language ever appears.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React from 'react';

const hoisted = vi.hoisted(() => {
  const handlers = new Map<string, (payload: any) => Promise<any>>();
  const httpsCallable = vi.fn((name: string) => async (payload: any) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`no handler for ${name}`);
    return handler(payload);
  });
  return { handlers, httpsCallable };
});

vi.mock('../../lib/firebase', () => ({
  functions: { httpsCallable: hoisted.httpsCallable },
  auth: null,
  db: null,
  default: {},
}));
vi.mock('./LookingForSection', () => ({ LookingForSection: () => null }));

import { PublicCaregiverProfile } from './PublicCaregiverProfile';

const SENIOR_PROFILE = {
  id: 'cg1',
  name: 'Sarah Martinez',
  bio: 'Experienced caregiver.',
  city: 'San Jose',
  state: 'CA',
  rating: 4.9,
  reviewCount: 21,
  verified: true,
  backgroundCheckStatus: 'clear',
  hourlyRate: 32,
  skills: ['Companionship'],
};

function armProfile(profile: Record<string, unknown>) {
  hoisted.handlers.set('v1-publicCaregiverProfile', async () => ({
    data: { found: true, profile },
  }));
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/p/cg1']}>
      <Routes>
        <Route path="/p/:id" element={<PublicCaregiverProfile />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
});

describe('PublicCaregiverProfile — per-vertical projection rendering', () => {
  it('senior-only projection: no childcare section, senior page unchanged (parity)', async () => {
    armProfile(SENIOR_PROFILE);
    const { container } = renderPage();
    expect(await screen.findByText('Sarah Martinez')).toBeTruthy();
    expect(screen.getByText(/4\.9/)).toBeTruthy();
    expect(screen.getByText(/\$32\/hr/)).toBeTruthy();
    expect(screen.queryByTestId('childcare-public-section')).toBeNull();
    expect(container.innerHTML).not.toMatch(/childcare/i);
  });

  it('childcare-visible projection renders visibility + evidence labels + per-vertical reputation', async () => {
    armProfile({
      ...SENIOR_PROFILE,
      verticalVisibility: { child: true },
      childcareEvidenceLabels: ['background_check_current', 'childcare_reviewed', 'transport_capable'],
      childcareReputation: { ratingAvg: 4.7, ratingCount: 8, completedBookings: 15, repeatFamilies: 4 },
    });
    renderPage();
    const section = await screen.findByTestId('childcare-public-section');
    expect(section.textContent).toContain('4.7');
    expect(section.textContent).toContain('8 childcare reviews');
    expect(section.textContent).toContain('15 completed childcare bookings');
    expect(section.textContent).toContain('4 repeat families');
    // Separately-labeled cross-vertical history (R45) — the senior 4.9 stays
    // the senior aggregate, childcare gets its own numbers.
    expect(screen.getByText(/4\.9/)).toBeTruthy();
    // Evidence labels from the allowlist render as badges.
    expect(screen.getByTestId('childcare-evidence-background_check_current')).toBeTruthy();
    expect(screen.getByTestId('childcare-evidence-childcare_reviewed')).toBeTruthy();
    expect(screen.getByTestId('childcare-evidence-transport_capable')).toBeTruthy();
  });

  it('visible but review-less childcare shows the honest empty state', async () => {
    armProfile({
      ...SENIOR_PROFILE,
      verticalVisibility: { child: true },
      childcareEvidenceLabels: [],
    });
    renderPage();
    const section = await screen.findByTestId('childcare-public-section');
    expect(section.textContent).toContain('No childcare reviews yet.');
  });

  it('verticalVisibility.child=false renders NO childcare section (R31 — visibility withdrawn)', async () => {
    armProfile({
      ...SENIOR_PROFILE,
      verticalVisibility: { child: false },
      // Even leaked labels must not render without visibility.
      childcareEvidenceLabels: ['background_check_current'],
    });
    renderPage();
    await screen.findByText('Sarah Martinez');
    expect(screen.queryByTestId('childcare-public-section')).toBeNull();
    expect(screen.queryByTestId('childcare-evidence-background_check_current')).toBeNull();
  });

  it('never emits safety-guarantee language and invents no claims beyond the projection', async () => {
    armProfile({
      ...SENIOR_PROFILE,
      verticalVisibility: { child: true },
      childcareEvidenceLabels: ['background_check_current'],
    });
    const { container } = renderPage();
    await screen.findByTestId('childcare-public-section');
    expect(container.innerHTML).not.toMatch(/guarantee|100% safe|fully vetted|certified safe/i);
    // Labels outside the allowlist never render.
    expect(screen.queryByText(/Reviewed for childcare/)).toBeNull();
  });
});
