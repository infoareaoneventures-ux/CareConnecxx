// ClientProfile childcare additions (plan 2026-07-22-002, U11).
//
// Pins: the childcare card appears ONLY when childcare is available AND the
// household has child recipients; the senior rendering is unchanged for
// senior-only fixtures (parity pins).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
  db: null,
  auth: null,
  default: {},
}));
vi.mock('../services/api', () => ({
  authService: {
    getCurrentUser: () => ({ uid: 'u1', email: 'fam@example.com' }),
    logout: vi.fn(),
    updateUserPassword: vi.fn(),
    deleteUserAccount: vi.fn(),
  },
  dbService: {
    getSeniorProfile: vi.fn(async () => ({ name: 'Eleanor Rigby', location: 'San Jose, CA', needs: ['Mobility'], imageUrl: '' })),
    subscribeToSeniorProfile: vi.fn(() => () => {}),
    updateUser: vi.fn(),
  },
}));
vi.mock('./FamilyManager', () => ({ FamilyManager: () => <div data-testid="family-manager" /> }));
vi.mock('./client/ClientNavigation', () => ({ ClientNavigation: () => <nav data-testid="client-nav" /> }));
vi.mock('./ui/AvatarUpload', () => ({ AvatarUpload: () => <div data-testid="avatar-upload" /> }));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

import { ClientProfile } from './ClientProfile';
import { resetChildcareAccessCache } from './shared/childcareAccess';

function codeError(code: string): Error {
  const err = new Error(code) as Error & { details?: unknown };
  err.details = { code };
  return err;
}

function armAccess(opts: { disabled?: boolean; children?: any[] } = {}) {
  hoisted.handlers.set('v1-getMyHouseholdState', async () => {
    if (opts.disabled) throw codeError('childcare_disabled');
    return { data: { success: true, households: [{ householdId: 'hh1', isPrimary: true }], authorities: [] } };
  });
  hoisted.handlers.set('v1-listMyChildren', async () => {
    if (opts.disabled) throw codeError('childcare_disabled');
    return { data: { success: true, children: opts.children ?? [] } };
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ClientProfile onNavigate={vi.fn()} onShowToast={vi.fn()} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
  resetChildcareAccessCache();
});

describe('ClientProfile — childcare gating + senior parity', () => {
  it('senior-only (flags off): ZERO childcare UI and the senior profile renders unchanged', async () => {
    armAccess({ disabled: true });
    const { container } = renderPage();
    expect(await screen.findByText('Eleanor Rigby')).toBeTruthy();
    // Senior parity pins: tabs, care needs, payment methods all present.
    expect(screen.getByText('Profile Details')).toBeTruthy();
    expect(screen.getByText('Family Access')).toBeTruthy();
    expect(screen.getByText('Security')).toBeTruthy();
    expect(screen.getByText('My Care Needs')).toBeTruthy();
    expect(screen.getByText('Payment Methods')).toBeTruthy();
    // Zero childcare markers anywhere in the DOM.
    await waitFor(() => expect(screen.queryByTestId('client-profile-childcare-card')).toBeNull());
    expect(container.innerHTML).not.toMatch(/childcare/i);
  });

  it('available but NO child recipients: still no childcare card (opt-in lives on the hub)', async () => {
    armAccess({ children: [] });
    renderPage();
    await screen.findByText('Eleanor Rigby');
    await waitFor(() => expect(screen.queryByTestId('client-profile-childcare-card')).toBeNull());
  });

  it('available with child recipients: the card appears and routes to /childcare', async () => {
    armAccess({
      children: [
        { childId: 'c1', displayLabel: 'Mia', ageBand: 'preschool', careCategories: [], safetyCurrentVersion: 1 },
        { childId: 'c2', displayLabel: 'Leo', ageBand: 'school_age', careCategories: [], safetyCurrentVersion: 0 },
      ],
    });
    renderPage();
    const card = await screen.findByTestId('client-profile-childcare-card');
    expect(card.textContent).toContain('2 child profiles');
    // Recipient separation copy — adult settings stay separate.
    expect(card.textContent).toContain('separate from this profile');
    fireEvent.click(screen.getByRole('button', { name: 'Open childcare dashboard' }));
    expect(mockNavigate).toHaveBeenCalledWith('/childcare');
    // Senior sections still intact alongside (no replacement, additive only).
    expect(screen.getByText('My Care Needs')).toBeTruthy();
  });
});
