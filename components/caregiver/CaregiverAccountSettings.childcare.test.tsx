// CaregiverAccountSettings childcare additions (plan 2026-07-22-002, U11).
//
// Pins: the "Childcare Profile" accordion appears ONLY when childcare is
// available (pilot staging: this is THE entry point to the single
// ChildcareVerticalProfile page); senior-only caregivers see the settings
// page unchanged (parity).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

vi.mock('../../lib/firebase', () => ({
  functions: { httpsCallable: hoisted.httpsCallable },
  // lib/childcareCallable imports this; undefined selects its compat path.
  childcareFunctions: undefined,
  auth: null,
  db: null,
  default: { auth: () => ({ currentUser: null }) },
}));
vi.mock('../../services/api', () => ({
  authService: { updateUserPassword: vi.fn(), deleteUserAccount: vi.fn() },
  dbService: {
    getUser: vi.fn(async () => ({
      firstName: 'Sarah', lastName: 'Martinez', email: 's@example.com',
      phone: '+14085551234', city: 'San Jose', state: 'CA', documents: {},
    })),
    updateUser: vi.fn(),
  },
}));
vi.mock('../../context/CareConnexContext', () => ({
  useCareConnex: () => ({
    currentUser: { uid: 'cg1' },
    addToast: vi.fn(),
    blockedIds: new Set<string>(),
    blockedUserProfiles: {},
    unblockUser: vi.fn(),
  }),
}));
vi.mock('./CaregiverTopNav', () => ({ CaregiverTopNav: () => <nav data-testid="caregiver-nav" /> }));
vi.mock('../../services/documentUpload', () => ({
  documentUploadService: { uploadDocument: vi.fn() },
  DocumentType: {},
}));
vi.mock('../../utils/geocode', () => ({ geocodeToLatLng: vi.fn(async () => null) }));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

import { CaregiverAccountSettings } from './CaregiverAccountSettings';
import { resetChildcareAccessCache } from '../shared/childcareAccess';

function codeError(code: string): Error {
  const err = new Error(code) as Error & { details?: unknown };
  err.details = { code };
  return err;
}

function armProvider(opts: { disabled?: boolean; eligible?: boolean; issues?: any[] } = {}) {
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
        eligibility: {
          eligible: opts.eligible ?? false,
          issues: opts.issues ?? [],
          transportCapable: false,
        },
      },
    };
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <CaregiverAccountSettings />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
  resetChildcareAccessCache();
});

describe('CaregiverAccountSettings — childcare section gating + parity', () => {
  it('senior-only caregiver (flags off): settings render unchanged, zero childcare UI', async () => {
    armProvider({ disabled: true });
    const { container } = renderPage();
    expect(await screen.findByText('Account Settings')).toBeTruthy();
    // Senior parity pins.
    expect(screen.getByText('Account Basics')).toBeTruthy();
    expect(screen.getByText('Blocked Users')).toBeTruthy();
    expect(screen.getByText('Delete account')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Childcare Profile')).toBeNull());
    expect(container.innerHTML).not.toMatch(/childcare/i);
  });

  it('childcare available: the accordion appears with the visibility badge and routes to the vertical page', async () => {
    armProvider({ eligible: true });
    renderPage();
    expect(await screen.findByText('Childcare Profile')).toBeTruthy();
    expect(screen.getByText('Visible')).toBeTruthy();
    // Open the accordion and use the entry point (pilot staging decision).
    fireEvent.click(screen.getByText('Childcare Profile'));
    expect(screen.getByTestId('childcare-settings-section')).toBeTruthy();
    expect(screen.getByText(/managed separately from\s+senior care/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Manage childcare profile/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/caregiver/childcare');
  });

  it('setup-needed provider shows the remediation count', async () => {
    armProvider({ eligible: false, issues: [{ code: 'evidence_pending', field: 'x' }, { code: 'manual_approval_missing', field: 'y' }] });
    renderPage();
    expect(await screen.findByText('Setup needed')).toBeTruthy();
    fireEvent.click(screen.getByText('Childcare Profile'));
    expect(screen.getByText(/2 items to resolve/)).toBeTruthy();
  });
});
