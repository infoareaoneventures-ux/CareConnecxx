// ClientNavigation childcare entry (plan 2026-07-22-002, U11).
//
// Pins: the additive "Childcare" entry is flag-gated (once-per-session probe)
// AND engagement-gated (children or a household); senior-only users see the
// navigation byte-identically (parity).

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
  default: {},
}));
vi.mock('../../services/api', () => ({
  authService: {
    getCurrentUser: () => ({ uid: 'u1', displayName: 'Paul' }),
    logout: vi.fn(),
  },
  dbService: { getSeniorProfile: vi.fn(async () => null) },
}));
vi.mock('../../hooks/useCaraUnread', () => ({ useCaraUnread: () => 0 }));
vi.mock('../ui/NotificationDropdown', () => ({ NotificationDropdown: () => <div data-testid="notif" /> }));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

import { ClientNavigation } from './ClientNavigation';
import { resetChildcareAccessCache } from '../shared/childcareAccess';

function codeError(code: string): Error {
  const err = new Error(code) as Error & { details?: unknown };
  err.details = { code };
  return err;
}

function armAccess(opts: { disabled?: boolean; children?: any[]; households?: any[] } = {}) {
  hoisted.handlers.set('v1-getMyHouseholdState', async () => {
    if (opts.disabled) throw codeError('childcare_disabled');
    return { data: { success: true, households: opts.households ?? [], authorities: [] } };
  });
  hoisted.handlers.set('v1-listMyChildren', async () => {
    if (opts.disabled) throw codeError('childcare_disabled');
    return { data: { success: true, children: opts.children ?? [] } };
  });
}

function renderNav() {
  return render(
    <MemoryRouter initialEntries={['/client/dashboard']}>
      <ClientNavigation />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
  resetChildcareAccessCache();
});

async function openAvatarMenu() {
  // The avatar toggle is the button containing the chevron; it has no label —
  // find it via the initials avatar inside the right-side cluster.
  const buttons = screen.getAllByRole('button');
  const avatarBtn = buttons.find((b) => b.textContent?.includes('P') && b.querySelector('div'));
  expect(avatarBtn).toBeTruthy();
  fireEvent.click(avatarBtn!);
  await screen.findByText('Account Settings');
}

describe('ClientNavigation — childcare entry gating', () => {
  it('senior-only (flags off): the avatar menu has exactly the pre-childcare items (parity)', async () => {
    armAccess({ disabled: true });
    renderNav();
    await openAvatarMenu();
    expect(screen.getByText('Payments')).toBeTruthy();
    expect(screen.getByText('Membership')).toBeTruthy();
    expect(screen.getByText('Account Settings')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Childcare')).toBeNull());
  });

  it('flags on but no engagement (no children, no household): entry stays hidden', async () => {
    armAccess({ children: [], households: [] });
    renderNav();
    await openAvatarMenu();
    await waitFor(() => expect(screen.queryByText('Childcare')).toBeNull());
  });

  it('engaged household: the entry appears and navigates to /childcare', async () => {
    armAccess({
      children: [{ childId: 'c1', displayLabel: 'Mia', ageBand: 'preschool', careCategories: [], safetyCurrentVersion: 1 }],
      households: [{ householdId: 'hh1', isPrimary: true }],
    });
    renderNav();
    await openAvatarMenu();
    const entry = await screen.findByText('Childcare');
    fireEvent.click(entry);
    expect(mockNavigate).toHaveBeenCalledWith('/childcare');
  });
});
