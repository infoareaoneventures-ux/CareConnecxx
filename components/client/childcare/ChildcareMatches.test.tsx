// ChildcareMatches (plan 2026-07-22-002, U11) — applications for one job.
//
// Pins: flags-off unavailable, no-matches empty state, applicant rendering
// from the PUBLIC projection only, accept/reject exact payloads, server
// eligibility denial remediation (provider_not_eligible), and the
// applications-seam unavailable state.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
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

import { ChildcareMatches } from './ChildcareMatches';

function callsTo(name: string) {
  return hoisted.calls.filter((c) => c.name === name);
}

function codeError(code: string): Error {
  const err = new Error(code) as Error & { details?: unknown };
  err.details = { code };
  return err;
}

function arm(opts: { jobs?: any[]; applications?: any[] | 'error'; profiles?: Record<string, any> } = {}) {
  hoisted.handlers.set('v1-listMyChildcareJobs', async () => ({
    data: { success: true, jobs: opts.jobs ?? [{ jobId: 'job1', title: 'Childcare for 2 children', status: 'open', ageBands: ['preschool'], serviceCategories: ['babysitting'], applicantCount: 1 }] },
  }));
  hoisted.handlers.set('v1-listChildcareJobApplications', async () => {
    if (opts.applications === 'error') throw new Error('seam missing');
    return { data: { success: true, applications: opts.applications ?? [] } };
  });
  hoisted.handlers.set('v1-publicCaregiverProfile', async (payload: any) => ({
    data: { found: true, profile: (opts.profiles ?? {})[payload.id] ?? { name: 'Caregiver' } },
  }));
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/childcare/jobs/job1/matches']}>
      <Routes>
        <Route path="/childcare/jobs/:jobId/matches" element={<ChildcareMatches />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
  hoisted.calls.length = 0;
});

describe('ChildcareMatches — states', () => {
  it('flags-off renders the unavailable state', async () => {
    hoisted.handlers.set('v1-listMyChildcareJobs', async () => { throw codeError('childcare_disabled'); });
    renderPage();
    expect(await screen.findByText('Childcare is coming soon')).toBeTruthy();
  });

  it('no matches shows the explicit empty state', async () => {
    arm({ applications: [] });
    renderPage();
    expect(await screen.findByText('No applicants yet')).toBeTruthy();
    expect(screen.getByText(/Eligible caregivers near you have been notified/)).toBeTruthy();
  });

  it('applications-seam failure shows an explicit unavailable state with retry', async () => {
    arm({ applications: 'error' });
    renderPage();
    expect(await screen.findByText(/applicant list could not be loaded/i)).toBeTruthy();
    hoisted.handlers.set('v1-listChildcareJobApplications', async () => ({
      data: { success: true, applications: [{ applicationId: 'a1', jobId: 'job1', caregiverId: 'cg1', status: 'pending' }] },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /Accept application/ })).toBeTruthy();
  });
});

describe('ChildcareMatches — accept / reject', () => {
  const pendingApp = { applicationId: 'a1', jobId: 'job1', caregiverId: 'cg1', status: 'pending' };

  it('renders applicant from the public projection (evidence labels, childcare rating)', async () => {
    arm({
      applications: [pendingApp],
      profiles: {
        cg1: {
          name: 'Sarah Martinez',
          city: 'San Jose',
          state: 'CA',
          backgroundCheckStatus: 'clear',
          childcareEvidenceLabels: ['background_check_current', 'childcare_reviewed'],
          childcareReputation: { ratingAvg: 4.8, ratingCount: 12 },
        },
      },
    });
    renderPage();
    expect(await screen.findByText('Sarah Martinez')).toBeTruthy();
    expect(screen.getByText('San Jose, CA')).toBeTruthy();
    expect(screen.getByTestId('childcare-evidence-background_check_current')).toBeTruthy();
    expect(screen.getByTestId('childcare-evidence-childcare_reviewed')).toBeTruthy();
    expect(screen.getByText(/4\.8 \(12 childcare reviews\)/)).toBeTruthy();
  });

  it('accept sends the exact jobId+caregiverId payload and confirms', async () => {
    arm({ applications: [pendingApp] });
    hoisted.handlers.set('v1-acceptChildcareApplication', async () => ({
      data: { success: true, applicationId: 'a1', status: 'accepted', changed: true },
    }));
    renderPage();
    const accept = await screen.findByRole('button', { name: /Accept application/ });
    await act(async () => { fireEvent.click(accept); });
    const sent = callsTo('v1-acceptChildcareApplication');
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({ jobId: 'job1', caregiverId: 'cg1' });
    expect(await screen.findByText(/Application accepted/)).toBeTruthy();
  });

  it('reject calls the reject callable', async () => {
    arm({ applications: [pendingApp] });
    hoisted.handlers.set('v1-rejectChildcareApplication', async () => ({
      data: { success: true, applicationId: 'a1', status: 'rejected', changed: true },
    }));
    renderPage();
    const decline = await screen.findByRole('button', { name: /Decline application/ });
    await act(async () => { fireEvent.click(decline); });
    expect(callsTo('v1-rejectChildcareApplication')[0].payload).toEqual({ jobId: 'job1', caregiverId: 'cg1' });
    expect(await screen.findByText('Application declined.')).toBeTruthy();
  });

  it('server eligibility denial (R29) surfaces exact remediation, not a generic error', async () => {
    arm({ applications: [pendingApp] });
    hoisted.handlers.set('v1-acceptChildcareApplication', async () => { throw codeError('provider_not_eligible'); });
    renderPage();
    const accept = await screen.findByRole('button', { name: /Accept application/ });
    await act(async () => { fireEvent.click(accept); });
    expect(await screen.findByText(/not currently eligible for childcare/)).toBeTruthy();
  });

  it('non-pending applications render decision state without action buttons', async () => {
    arm({ applications: [{ ...pendingApp, applicationId: 'a2', status: 'rejected' }] });
    renderPage();
    await waitFor(() => expect(callsTo('v1-listChildcareJobApplications')).toHaveLength(1));
    expect(await screen.findByText(/Rejected/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Accept application/ })).toBeNull();
  });
});
