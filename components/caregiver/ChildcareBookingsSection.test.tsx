// ChildcareBookingsSection (plan 2026-07-22-002, U11) — additive caregiver
// bookings section.
//
// Pins: renders NOTHING when childcare is unavailable (senior parity /
// emergency-off), list + accept/decline + check-in/out payloads, the
// coordination view with the exact address clearly marked confidential,
// revoked-access remediation, the list-seam unavailable state, and empty state.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

const hoisted = vi.hoisted(() => {
  const handlers = new Map<string, (payload: any) => Promise<any>>();
  const calls: Array<{ name: string; payload: any }> = [];
  const httpsCallable = vi.fn((name: string) => async (payload: any) => {
    calls.push({ name, payload });
    const handler = handlers.get(name);
    if (!handler) throw new Error(`no handler for ${name}`);
    return handler(payload);
  });
  return { handlers, calls, httpsCallable };
});

vi.mock('../../lib/firebase', () => ({
  functions: { httpsCallable: hoisted.httpsCallable },
  // lib/childcareCallable imports this; undefined selects its compat path.
  childcareFunctions: undefined,
  db: null,
  // The section gates its availability probe on auth.currentUser.uid, so the
  // mock must supply a signed-in caregiver (a stable literal — the uid is a
  // useEffect dependency).
  auth: { currentUser: { uid: 'cg1' } },
  default: {},
}));

import { ChildcareBookingsSection } from './ChildcareBookingsSection';
import { resetChildcareAccessCache } from '../shared/childcareAccess';

function callsTo(name: string) {
  return hoisted.calls.filter((c) => c.name === name);
}

function codeError(code: string): Error {
  const err = new Error(code) as Error & { details?: unknown };
  err.details = { code };
  return err;
}

function armAvailable() {
  hoisted.handlers.set('v1-getMyChildcareProviderState', async () => ({
    data: {
      success: true,
      hasVerticalProfile: true,
      verticalProfile: null,
      screening: null,
      reusedBaseFields: [],
      missingBaseFields: [],
      missingChildcareFields: [],
      eligibility: { eligible: true, issues: [], transportCapable: false },
    },
  }));
}

function armBookings(bookings: any[] | 'error') {
  hoisted.handlers.set('v1-listMyChildcareBookings', async () => {
    if (bookings === 'error') throw new Error('seam missing');
    return { data: { success: true, bookings } };
  });
}

const REQUESTED = {
  bookingId: 'b1',
  status: 'requested',
  recipientLabel: '2 children (3–4 yrs)',
  hourlyRate: 28,
  schedule: { dates: [{ date: '2026-08-01', startTime: '09:00', endTime: '12:00' }], recurring: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
  hoisted.calls.length = 0;
  resetChildcareAccessCache();
});

describe('ChildcareBookingsSection — availability gating (senior parity / emergency-off)', () => {
  it('renders NOTHING when the availability probe fails closed (flags off)', async () => {
    hoisted.handlers.set('v1-getMyChildcareProviderState', async () => { throw codeError('childcare_disabled'); });
    const { container } = render(<ChildcareBookingsSection />);
    await waitFor(() => expect(callsTo('v1-getMyChildcareProviderState')).toHaveLength(1));
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('childcare-bookings-section')).toBeNull();
  });

  it('emergency-off mid-session: a disabled list response collapses the section entirely', async () => {
    armAvailable();
    hoisted.handlers.set('v1-listMyChildcareBookings', async () => { throw codeError('childcare_disabled'); });
    const { container } = render(<ChildcareBookingsSection />);
    await waitFor(() => expect(callsTo('v1-listMyChildcareBookings')).toHaveLength(1));
    expect(container.innerHTML).toBe('');
  });
});

describe('ChildcareBookingsSection — list and actions', () => {
  it('shows the explicit empty state', async () => {
    armAvailable();
    armBookings([]);
    render(<ChildcareBookingsSection />);
    expect(await screen.findByText('No childcare bookings yet.')).toBeTruthy();
  });

  it('list-seam failure shows a non-silent retryable state', async () => {
    armAvailable();
    armBookings('error');
    render(<ChildcareBookingsSection />);
    expect(await screen.findByText(/could not be loaded right now/)).toBeTruthy();
    armBookings([REQUESTED]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('2 children (3–4 yrs)')).toBeTruthy();
  });

  it('accept and decline send the bookingId', async () => {
    armAvailable();
    armBookings([REQUESTED]);
    hoisted.handlers.set('v1-acceptChildcareBooking', async () => ({ data: { success: true, bookingId: 'b1', status: 'accepted' } }));
    render(<ChildcareBookingsSection />);
    const accept = await screen.findByRole('button', { name: /Accept childcare booking/ });
    await act(async () => { fireEvent.click(accept); });
    expect(callsTo('v1-acceptChildcareBooking')[0].payload).toEqual({ bookingId: 'b1' });
    // Truthful copy: acceptance is not confirmation (AE14).
    expect(await screen.findByText(/confirms once the family’s payment authorization completes/)).toBeTruthy();
  });

  it('check-in and check-out appear per status and call their callables', async () => {
    armAvailable();
    armBookings([
      { ...REQUESTED, bookingId: 'b2', status: 'confirmed' },
      { ...REQUESTED, bookingId: 'b3', status: 'in_progress', recipientLabel: '1 child (5–9 yrs)' },
    ]);
    hoisted.handlers.set('v1-checkInChildcareShift', async () => ({ data: { success: true, bookingId: 'b2', status: 'in_progress' } }));
    hoisted.handlers.set('v1-checkOutChildcareShift', async () => ({ data: { success: true, bookingId: 'b3', status: 'completed' } }));
    render(<ChildcareBookingsSection />);
    const checkIn = await screen.findByRole('button', { name: /Check in for 2 children/ });
    await act(async () => { fireEvent.click(checkIn); });
    expect(callsTo('v1-checkInChildcareShift')[0].payload).toEqual({ bookingId: 'b2' });

    const checkOut = await screen.findByRole('button', { name: /Check out for 1 child/ });
    await act(async () => { fireEvent.click(checkOut); });
    expect(callsTo('v1-checkOutChildcareShift')[0].payload).toEqual({ bookingId: 'b3' });
  });
});

describe('ChildcareBookingsSection — coordination view (the address surface)', () => {
  it('fetches coordination + safety and marks the details confidential', async () => {
    armAvailable();
    armBookings([{ ...REQUESTED, bookingId: 'b2', status: 'confirmed' }]);
    hoisted.handlers.set('v1-getChildcareBookingCoordination', async () => ({
      data: {
        success: true,
        bookingId: 'b2',
        version: 1,
        coordination: [{ childId: 'c1', addressDetail: '482 Willow Ct, San Jose, CA', arrivalNotes: 'Gate code 4411' }],
      },
    }));
    hoisted.handlers.set('v1-getChildcareBookingSafety', async () => ({
      data: {
        success: true,
        bookingId: 'b2',
        version: 1,
        children: [{
          childId: 'c1', displayLabel: 'Mia', ageBand: 'preschool',
          emergencyContacts: [{ name: 'Grandma Rose', relationship: 'grandmother', phone: '+14085551234' }],
          allergiesNote: 'peanuts',
        }],
      },
    }));
    render(<ChildcareBookingsSection />);
    const view = await screen.findByRole('button', { name: /View care details/ });
    await act(async () => { fireEvent.click(view); });

    expect(callsTo('v1-getChildcareBookingCoordination')[0].payload).toEqual({ bookingId: 'b2' });
    expect(callsTo('v1-getChildcareBookingSafety')[0].payload).toEqual({ bookingId: 'b2' });
    expect(await screen.findByText('482 Willow Ct, San Jose, CA')).toBeTruthy();
    expect(screen.getByText(/Confidential — for this booking only/)).toBeTruthy();
    expect(screen.getByText(/Allergies: peanuts/)).toBeTruthy();
    expect(screen.getByText(/Grandma Rose/)).toBeTruthy();

    // Nothing confidential is persisted to web storage (R57).
    const stored = JSON.stringify({ ...window.localStorage, ...window.sessionStorage });
    expect(stored).not.toContain('482 Willow Ct');
    expect(stored).not.toContain('peanuts');
  });

  it('revoked access shows remediation instead of the address (AE6)', async () => {
    armAvailable();
    armBookings([{ ...REQUESTED, bookingId: 'b2', status: 'confirmed' }]);
    hoisted.handlers.set('v1-getChildcareBookingCoordination', async () => { throw codeError('permission-denied'); });
    hoisted.handlers.set('v1-getChildcareBookingSafety', async () => { throw codeError('permission-denied'); });
    const { container } = render(<ChildcareBookingsSection />);
    const view = await screen.findByRole('button', { name: /View care details/ });
    await act(async () => { fireEvent.click(view); });
    expect(await screen.findByText(/access to this booking was withdrawn/)).toBeTruthy();
    expect(container.innerHTML).not.toContain('Willow Ct');
  });

  it('address is NOT in the DOM until the caregiver opens the coordination view', async () => {
    armAvailable();
    armBookings([{ ...REQUESTED, bookingId: 'b2', status: 'confirmed' }]);
    hoisted.handlers.set('v1-getChildcareBookingCoordination', async () => ({
      data: { success: true, bookingId: 'b2', version: 1, coordination: [{ childId: 'c1', addressDetail: '482 Willow Ct' }] },
    }));
    hoisted.handlers.set('v1-getChildcareBookingSafety', async () => ({ data: { success: true, bookingId: 'b2', version: 1, children: [] } }));
    const { container } = render(<ChildcareBookingsSection />);
    await screen.findByRole('button', { name: /View care details/ });
    expect(container.innerHTML).not.toContain('482 Willow Ct');
    expect(callsTo('v1-getChildcareBookingCoordination')).toHaveLength(0);
  });
});
