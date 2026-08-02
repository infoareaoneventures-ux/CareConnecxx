// ClientProfileDashboard recipient hub (plan 2026-07-22-002, U11).
//
// Pins: the explicit vertical/recipient switch appears only when childcare is
// available; senior recipients keep EXACTLY their current rendering when it
// is not (parity); switching verticals never cross-loads content (dual
// household); the childcare tab offers opt-in when no children exist.

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

const INTAKE = {
  recipientName: 'Eleanor Rigby',
  relationship: 'Mother',
  zipCode: '95125',
  schedule: 'Weekdays',
  startDate: '2026-08-01',
  duration: '4 hours',
  careTypes: ['Companionship'],
  contactName: 'Paul R',
  email: 'fam@example.com',
  phone: '+14085551234',
};

vi.mock('../lib/firebase', () => ({
  functions: { httpsCallable: hoisted.httpsCallable },
  // lib/childcareCallable imports this; undefined selects its compat path.
  childcareFunctions: undefined,
  auth: { currentUser: { uid: 'u1' } },
  db: {
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: true, data: () => INTAKE }) }),
    }),
  },
  default: {},
}));
vi.mock('./client/ClientNavigation', () => ({ ClientNavigation: () => <nav data-testid="client-nav" /> }));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

import ClientProfileDashboard from './ClientProfileDashboard';
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
      <ClientProfileDashboard />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
  resetChildcareAccessCache();
});

describe('ClientProfileDashboard — recipient hub', () => {
  it('senior-only household (flags off): no vertical switch, exact senior layout (parity)', async () => {
    armAccess({ disabled: true });
    renderPage();
    expect(await screen.findByText('Eleanor Rigby')).toBeTruthy();
    // Senior parity pins.
    expect(screen.getByText('Your Care Request')).toBeTruthy();
    expect(screen.getByText("What's Next?")).toBeTruthy();
    expect(screen.getByText('Request Status')).toBeTruthy();
    // Zero childcare UI.
    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull());
    expect(screen.queryByTestId('recipient-hub-childcare')).toBeNull();
  });

  it('dual household: explicit switch, no cross-loading between verticals', async () => {
    armAccess({
      children: [{ childId: 'c1', displayLabel: 'Mia', ageBand: 'preschool', careCategories: [], safetyCurrentVersion: 1 }],
    });
    renderPage();
    await screen.findByText('Eleanor Rigby');
    const tablist = await screen.findByRole('tablist', { name: 'Care recipients' });
    expect(tablist).toBeTruthy();

    // Default = senior: senior content visible, childcare hidden (no cross-load).
    expect(screen.getByText('Your Care Request')).toBeTruthy();
    expect(screen.queryByTestId('recipient-hub-childcare')).toBeNull();

    // Switch to childcare: children visible, senior grid unmounted.
    fireEvent.click(screen.getByRole('tab', { name: 'Childcare' }));
    expect(screen.getByTestId('recipient-hub-childcare')).toBeTruthy();
    expect(screen.getByText('Mia')).toBeTruthy();
    expect(screen.queryByText('Your Care Request')).toBeNull();
    // The senior recipient's data never appears inside the childcare tab.
    expect(screen.getByTestId('recipient-hub-childcare').textContent).not.toContain('Eleanor');

    // Switch back: senior content restored exactly.
    fireEvent.click(screen.getByRole('tab', { name: 'Senior care' }));
    expect(screen.getByText('Your Care Request')).toBeTruthy();
    expect(screen.queryByTestId('recipient-hub-childcare')).toBeNull();
  });

  it('child-only opt-in: available without children shows the opt-in card routing to /childcare', async () => {
    armAccess({ children: [] });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Childcare' }));
    expect(screen.getByText('Also caring for a child?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set up childcare' }));
    expect(mockNavigate).toHaveBeenCalledWith('/childcare');
  });

  it('childcare tab shows only display label + age band — never DOB or safety detail', async () => {
    armAccess({
      children: [{ childId: 'c1', displayLabel: 'Mia', ageBand: 'preschool', careCategories: ['babysitting'], safetyCurrentVersion: 3 }],
    });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Childcare' }));
    const hub = screen.getByTestId('recipient-hub-childcare');
    expect(hub.textContent).toContain('Mia');
    expect(hub.textContent).toContain('3–4 yrs');
    expect(hub.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no DOB-like strings
  });
});
