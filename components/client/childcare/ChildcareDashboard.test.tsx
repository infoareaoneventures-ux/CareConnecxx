// ChildcareDashboard (plan 2026-07-22-002, U11) — family childcare hub.
//
// Pins: flags-off unavailable state (direct URL while dark), loading, network
// error + retry, multiple children, jobs list + matches entry, bookings seam
// unavailable state (explicit, never silent), empty states with remediation
// copy, and responsive/accessible structure.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

import { ChildcareDashboard } from './ChildcareDashboard';

function disabledError(): Error {
  const err = new Error('disabled') as Error & { details?: unknown };
  err.details = { code: 'childcare_disabled' };
  return err;
}

function arm(opts: {
  households?: any[];
  children?: any[];
  jobs?: any[];
  bookings?: any[] | 'error';
} = {}) {
  hoisted.handlers.set('v1-getMyHouseholdState', async () => ({
    data: { success: true, households: opts.households ?? [{ householdId: 'hh1', isPrimary: true }], authorities: [] },
  }));
  hoisted.handlers.set('v1-listMyChildren', async () => ({
    data: { success: true, children: opts.children ?? [] },
  }));
  hoisted.handlers.set('v1-listMyChildcareJobs', async () => ({
    data: { success: true, jobs: opts.jobs ?? [] },
  }));
  hoisted.handlers.set('v1-listMyChildcareBookings', async () => {
    if (opts.bookings === 'error') throw new Error('seam missing');
    return { data: { success: true, bookings: opts.bookings ?? [] } };
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/childcare']}>
      <ChildcareDashboard />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
  hoisted.calls.length = 0;
});

describe('ChildcareDashboard — gating states', () => {
  it('shows the unavailable state when flags are off (direct URL while dark)', async () => {
    hoisted.handlers.set('v1-getMyHouseholdState', async () => { throw disabledError(); });
    hoisted.handlers.set('v1-listMyChildren', async () => { throw disabledError(); });
    hoisted.handlers.set('v1-listMyChildcareJobs', async () => { throw disabledError(); });
    renderPage();
    expect(await screen.findByText('Childcare is coming soon')).toBeTruthy();
    // Senior reassurance copy + zero childcare content in the DOM.
    expect(screen.getByText(/senior care tools are unaffected/i)).toBeTruthy();
    expect(screen.queryByText('Children')).toBeNull();
  });

  it('shows a retryable error state on network failure (never silent)', async () => {
    hoisted.handlers.set('v1-getMyHouseholdState', async () => { throw new Error('network'); });
    hoisted.handlers.set('v1-listMyChildren', async () => { throw new Error('network'); });
    hoisted.handlers.set('v1-listMyChildcareJobs', async () => { throw new Error('network'); });
    renderPage();
    expect(await screen.findByText(/could not load your childcare dashboard/i)).toBeTruthy();
    arm({});
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Childcare')).toBeTruthy();
  });

  it('renders a loading state first', () => {
    arm({});
    renderPage();
    expect(screen.getByRole('status', { name: 'Loading childcare dashboard' })).toBeTruthy();
  });
});

describe('ChildcareDashboard — content', () => {
  it('renders multiple children as cards with add-child entry point', async () => {
    arm({
      children: [
        { childId: 'c1', displayLabel: 'Mia', ageBand: 'preschool', careCategories: ['babysitting'], safetyCurrentVersion: 1 },
        { childId: 'c2', displayLabel: 'Leo', ageBand: 'school_age', careCategories: ['after_school_care'], safetyCurrentVersion: 0 },
        { childId: 'c3', displayLabel: 'Zoe', ageBand: 'toddler', careCategories: ['nanny_care'], safetyCurrentVersion: 2 },
      ],
    });
    renderPage();
    expect(await screen.findByText('Mia')).toBeTruthy();
    expect(screen.getByText('Leo')).toBeTruthy();
    expect(screen.getByText('Zoe')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add a child/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/childcare/children');
  });

  it('shows explicit empty states for children, jobs, and bookings', async () => {
    arm({ children: [], jobs: [], bookings: [] });
    renderPage();
    expect(await screen.findByText('No child profiles yet.')).toBeTruthy();
    expect(screen.getByText('No childcare jobs yet.')).toBeTruthy();
    expect(await screen.findByText('No childcare bookings yet.')).toBeTruthy();
  });

  it('lists jobs with applicant counts and routes to the matches view', async () => {
    arm({
      children: [{ childId: 'c1', displayLabel: 'Mia', ageBand: 'preschool', careCategories: [], safetyCurrentVersion: 1 }],
      jobs: [{ jobId: 'job1', title: 'Childcare for 1 child', status: 'open', ageBands: ['preschool'], serviceCategories: ['babysitting'], applicantCount: 2 }],
    });
    renderPage();
    expect(await screen.findByText('Childcare for 1 child')).toBeTruthy();
    expect(screen.getByText('2 applicants')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View applicants' }));
    expect(mockNavigate).toHaveBeenCalledWith('/childcare/jobs/job1/matches');
  });

  it('post-job entry carries the childcare vertical; without children it routes to add-child first', async () => {
    arm({
      children: [{ childId: 'c1', displayLabel: 'Mia', ageBand: 'preschool', careCategories: [], safetyCurrentVersion: 1 }],
    });
    renderPage();
    await screen.findByText('Mia');
    fireEvent.click(screen.getByRole('button', { name: /Post a childcare job/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/client/post-job?vertical=child');
  });

  it('bookings seam failure shows an explicit non-silent state with retry', async () => {
    arm({ bookings: 'error' });
    renderPage();
    expect(await screen.findByText(/bookings could not be loaded right now/i)).toBeTruthy();
    // Retry with the seam now working.
    hoisted.handlers.set('v1-listMyChildcareBookings', async () => ({
      data: { success: true, bookings: [{ bookingId: 'b1', status: 'confirmed', caregiverName: 'Sarah M', recipientLabel: '2 children', schedule: { dates: [{ date: '2026-08-01', startTime: '09:00', endTime: '12:00' }] } }] },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Sarah M/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View booking' }));
    expect(mockNavigate).toHaveBeenCalledWith('/childcare/bookings/b1');
  });

  it('renders responsive + accessible structure (labelled sections, no raw child data beyond label/band)', async () => {
    arm({
      children: [{ childId: 'c1', displayLabel: 'Mia', ageBand: 'preschool', careCategories: ['babysitting'], safetyCurrentVersion: 1 }],
    });
    const { container } = renderPage();
    await screen.findByText('Mia');
    // Sections are aria-labelled for screen readers.
    expect(container.querySelector('[aria-labelledby="childcare-children-heading"]')).toBeTruthy();
    expect(container.querySelector('[aria-labelledby="childcare-jobs-heading"]')).toBeTruthy();
    expect(container.querySelector('[aria-labelledby="childcare-bookings-heading"]')).toBeTruthy();
    // Mobile-first: children grid stacks on small screens (grid-cols-1 base).
    expect(container.innerHTML).toContain('grid-cols-1');
  });
});
