// CaregiverProfile childcare additions (plan 2026-07-22-002, U11).
//
// Pins: the childcare summary card appears ONLY when the caregiver-side
// availability probe succeeds; senior-only caregivers (flags off) render the
// profile byte-identically (parity — dual-profile caregiver scenario:
// senior sections untouched either way).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

vi.mock('../lib/firebase', () => ({
  functions: { httpsCallable: hoisted.httpsCallable },
  // lib/childcareCallable imports this; undefined selects its compat path.
  childcareFunctions: undefined,
  auth: null,
  db: null,
  default: {},
}));
// STABLE reference: CaregiverProfile calls authService.getCurrentUser() in its
// render body and uses the result as a useEffect dependency. A fresh object
// each call would change the dep every render → effect re-runs → setState →
// infinite re-render (production returns a cached, stable Firebase user). The
// object is created ONCE inside the factory so every call returns the same ref.
vi.mock('../services/api', () => {
  const stableUser = { uid: 'cg1' };
  return {
  authService: { getCurrentUser: () => stableUser },
  dbService: {
    getUser: vi.fn(async () => ({
      name: 'Sarah Martinez',
      bio: 'Experienced caregiver.',
      services: ['Companionship'],
      hourlyRate: 32,
      email: 's@example.com',
      verified: true,
    })),
    subscribeToReviews: vi.fn(() => () => {}),
    updateUser: vi.fn(),
  },
  };
});
vi.mock('../context/CareConnexContext', () => ({
  useCareConnex: () => ({ refreshCaregiverProfile: vi.fn() }),
}));
vi.mock('./caregiver/CaregiverTopNav', () => ({ CaregiverTopNav: () => <nav data-testid="caregiver-nav" /> }));
vi.mock('./caregiver/ProfileApprovalBanner', () => ({ ProfileApprovalBanner: () => null }));
vi.mock('./ui/AvatarUpload', () => ({ AvatarUpload: () => <div data-testid="avatar-upload" /> }));
vi.mock('../services/documentUpload', () => ({
  uploadDocument: vi.fn(),
  documentUploadService: { uploadDocument: vi.fn() },
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

import { CaregiverProfile } from './CaregiverProfile';
import { resetChildcareAccessCache } from './shared/childcareAccess';

function codeError(code: string): Error {
  const err = new Error(code) as Error & { details?: unknown };
  err.details = { code };
  return err;
}

function armProvider(opts: { disabled?: boolean; eligible?: boolean } = {}) {
  hoisted.handlers.set('v1-getMyChildcareProviderState', async () => {
    if (opts.disabled) throw codeError('childcare_disabled');
    return {
      data: {
        success: true,
        hasVerticalProfile: true,
        verticalProfile: null,
        screening: null,
        reusedBaseFields: [],
        missingBaseFields: [],
        missingChildcareFields: [],
        eligibility: { eligible: opts.eligible ?? false, issues: [], transportCapable: false },
      },
    };
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <CaregiverProfile onNavigate={vi.fn()} onShowToast={vi.fn()} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
  resetChildcareAccessCache();
});

// CaregiverProfile is a very large component; rendering it repeatedly in one
// jsdom worker accumulates fiber-tree memory. Unmount aggressively between
// tests so the file passes in a single run on constrained machines.
afterEach(() => {
  cleanup();
});

describe('CaregiverProfile — childcare card gating + senior parity', () => {
  it('senior-only caregiver (flags off): no childcare card, senior sections unchanged', async () => {
    armProvider({ disabled: true });
    renderPage();
    expect(await screen.findByText('Sarah Martinez')).toBeTruthy();
    // Senior parity pins.
    expect(screen.getByText(/About Sarah/)).toBeTruthy();
    expect(screen.getByText('Care Services')).toBeTruthy();
    expect(screen.getByText('Rates')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('caregiver-profile-childcare-card')).toBeNull());
  });

  it('dual-vertical caregiver: childcare card appears, senior sections untouched', async () => {
    armProvider({ eligible: true });
    renderPage();
    const card = await screen.findByTestId('caregiver-profile-childcare-card');
    expect(card.textContent).toContain('Visible');
    // Independence statement (R24): childcare separate from senior profile.
    expect(card.textContent).toContain('separate from your senior care profile');
    // Senior sections still present and unmodified.
    expect(screen.getByText('Care Services')).toBeTruthy();
    expect(screen.getByText('Rates')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Manage childcare profile' }));
    expect(mockNavigate).toHaveBeenCalledWith('/caregiver/childcare');
  });

  it('not-yet-eligible provider shows the setup-needed badge (remediation entry point)', async () => {
    armProvider({ eligible: false });
    renderPage();
    const card = await screen.findByTestId('caregiver-profile-childcare-card');
    expect(card.textContent).toContain('Setup needed');
  });
});
