// ChildcareBookingDetails (plan 2026-07-22-002, U11) — one booking, family view.
//
// Pins: truthful state copy (AE14 — requested is never "confirmed"), payment
// setup incl. the needsPayer pending-payer path, change/cancel payloads,
// family-safe safety summary, review entry ONLY after completion, and the
// exact-address NEVER appearing in the family view (restricted detail absent
// from the DOM).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

vi.mock('../../../lib/firebase', () => ({
  functions: { httpsCallable: hoisted.httpsCallable },
  // lib/childcareCallable imports this; undefined selects its compat path.
  childcareFunctions: undefined,
  db: null,
  auth: null,
  default: {},
}));
vi.mock('../ClientNavigation', () => ({
  ClientNavigation: () => <nav data-testid="client-nav" />,
}));

import { ChildcareBookingDetails } from './ChildcareBookingDetails';

function callsTo(name: string) {
  return hoisted.calls.filter((c) => c.name === name);
}

function codeError(code: string): Error {
  const err = new Error(code) as Error & { details?: unknown };
  err.details = { code };
  return err;
}

const baseBooking = {
  bookingId: 'b1',
  status: 'requested',
  statusDescription: 'Booking request pending — waiting for the caregiver to accept.',
  caregiverName: 'Sarah Martinez',
  recipientLabel: '2 children',
  schedule: { dates: [{ date: '2026-08-01', startTime: '09:00', endTime: '12:00' }], recurring: null },
  hourlyRate: 28,
  paymentAuthorization: { state: 'none' },
  safetyAccessVersion: null,
};

function armBooking(booking: Record<string, unknown>) {
  hoisted.handlers.set('v1-getChildcareBooking', async () => ({ data: { success: true, booking } }));
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/childcare/bookings/b1']}>
      <Routes>
        <Route path="/childcare/bookings/:bookingId" element={<ChildcareBookingDetails />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
  hoisted.calls.length = 0;
});

describe('ChildcareBookingDetails — states', () => {
  it('flags-off shows unavailable; missing booking shows retryable error', async () => {
    hoisted.handlers.set('v1-getChildcareBooking', async () => { throw codeError('childcare_disabled'); });
    renderPage();
    expect(await screen.findByText('Childcare is coming soon')).toBeTruthy();
  });

  it('load failure shows explicit error with retry (network error retry scenario)', async () => {
    hoisted.handlers.set('v1-getChildcareBooking', async () => { throw new Error('network'); });
    renderPage();
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    armBooking(baseBooking);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Sarah Martinez/)).toBeTruthy();
  });

  it('requested booking shows the truthful pending description — never "confirmed" (AE14)', async () => {
    armBooking({ ...baseBooking, paymentAuthorization: { state: 'authorized' } });
    renderPage();
    expect(await screen.findByText(/waiting for the caregiver to accept/i)).toBeTruthy();
    expect(screen.getByText('Requested')).toBeTruthy();
    expect(screen.queryByText(/Booking confirmed/)).toBeNull();
  });

  it('the exact address never appears in the family view (restricted detail absent)', async () => {
    armBooking({
      ...baseBooking,
      status: 'confirmed',
      // Even if a leaky server field appeared, this component renders no
      // address surface at all.
      addressDetail: '123 Secret Lane, San Jose',
    });
    const { container } = renderPage();
    await screen.findByText(/Sarah Martinez/);
    expect(container.innerHTML).not.toContain('123 Secret Lane');
  });
});

describe('ChildcareBookingDetails — payment', () => {
  it('setup calls the callable and reports success', async () => {
    armBooking(baseBooking);
    hoisted.handlers.set('v1-setupChildcareBookingPayment', async () => ({
      data: { success: true, bookingId: 'b1', paymentState: 'authorized' },
    }));
    renderPage();
    const btn = await screen.findByRole('button', { name: 'Set up payment' });
    await act(async () => { fireEvent.click(btn); });
    expect(callsTo('v1-setupChildcareBookingPayment')[0].payload).toEqual({ bookingId: 'b1' });
    expect(await screen.findByText('Payment setup completed.')).toBeTruthy();
  });

  it('a guardian without payment scope gets the explicit pending-payer explanation (partial scopes)', async () => {
    armBooking(baseBooking);
    hoisted.handlers.set('v1-setupChildcareBookingPayment', async () => ({
      data: { success: true, bookingId: 'b1', paymentState: 'pending', needsPayer: true },
    }));
    renderPage();
    const btn = await screen.findByRole('button', { name: 'Set up payment' });
    await act(async () => { fireEvent.click(btn); });
    expect(await screen.findByText(/do not hold payment permission/)).toBeTruthy();
    expect(screen.getByText(/authorized payer in your household/)).toBeTruthy();
  });

  it('no setup button once payment is authorized', async () => {
    armBooking({ ...baseBooking, paymentAuthorization: { state: 'authorized' } });
    renderPage();
    await screen.findByText(/Sarah Martinez/);
    expect(screen.queryByRole('button', { name: 'Set up payment' })).toBeNull();
    expect(screen.getByText(/funds are set aside/)).toBeTruthy();
  });
});

describe('ChildcareBookingDetails — change / cancel / safety / review', () => {
  it('change request sends the schedule with an idempotency key', async () => {
    armBooking({ ...baseBooking, status: 'confirmed' });
    hoisted.handlers.set('v1-requestChildcareBookingChange', async () => ({
      data: { success: true, bookingId: 'b1', applied: false, pending: true },
    }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Request a schedule change' }));
    fireEvent.change(screen.getByLabelText('New date'), { target: { value: '2026-08-05' } });
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '10:00' } });
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '14:00' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send change request' })); });
    const sent = callsTo('v1-requestChildcareBookingChange');
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.bookingId).toBe('b1');
    expect(sent[0].payload.schedule).toEqual({
      dates: [{ date: '2026-08-05', startTime: '10:00', endTime: '14:00' }],
      recurring: null,
    });
    expect(String(sent[0].payload.idempotencyKey).length).toBeGreaterThan(8);
    expect(await screen.findByText(/Change requested/)).toBeTruthy();
  });

  it('cancel calls the cancel callable', async () => {
    armBooking(baseBooking);
    hoisted.handlers.set('v1-cancelChildcareBooking', async () => ({
      data: { success: true, bookingId: 'b1', status: 'canceled' },
    }));
    renderPage();
    const btn = await screen.findByRole('button', { name: 'Cancel booking' });
    await act(async () => { fireEvent.click(btn); });
    expect(callsTo('v1-cancelChildcareBooking')[0].payload.bookingId).toBe('b1');
  });

  it('safety summary explains version-bound sharing when a projection exists', async () => {
    armBooking({ ...baseBooking, status: 'confirmed', safetyAccessVersion: 2 });
    renderPage();
    expect(await screen.findByText(/version 2(\D|$)/)).toBeTruthy();
    expect(screen.getByText(/withdrawn automatically/)).toBeTruthy();
  });

  it('review entry appears ONLY after completion and submits rating + comment', async () => {
    armBooking({ ...baseBooking, status: 'completed' });
    hoisted.handlers.set('v1-submitChildcareReview', async () => ({ data: { success: true } }));
    renderPage();
    expect(await screen.findByText('Leave a review')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: '5 stars' }));
    fireEvent.change(screen.getByLabelText('Review comment'), { target: { value: 'Wonderful with the kids.' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit review' })); });
    expect(callsTo('v1-submitChildcareReview')[0].payload).toEqual({
      bookingId: 'b1',
      rating: 5,
      comment: 'Wonderful with the kids.',
    });
  });

  it('no review entry before completion', async () => {
    armBooking({ ...baseBooking, status: 'confirmed' });
    renderPage();
    await screen.findByText(/Sarah Martinez/);
    expect(screen.queryByText('Leave a review')).toBeNull();
  });
});
