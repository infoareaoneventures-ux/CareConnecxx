// PostJobFlow childcare branch (plan 2026-07-22-002, U11).
//
// Pins BOTH sides of the vertical switch:
//   • SENIOR PARITY: without ?vertical=child the senior flow renders its
//     exact 6-step sequence (characterization — the childcare work may never
//     change a senior byte).
//   • CHILDCARE: ?vertical=child renders the U6 ChildcareRequirementsStep,
//     collects schedule/area, and submits ONLY through
//     v1-createChildcareJobPost (R32 — no legacy job_postings write).

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
  default: { firestore: { FieldValue: { arrayUnion: (...v: any[]) => v } } },
}));
vi.mock('../../../services/api', () => ({
  dbService: { createJobPost: vi.fn(async () => 'post-1') },
  authService: { getCurrentUser: () => ({ uid: 'u1' }) },
}));
vi.mock('../../../context/CareConnexContext', () => ({
  useCareConnex: () => ({ currentUser: { uid: 'u1' }, addToast: vi.fn() }),
}));
vi.mock('../ClientNavigation', () => ({
  ClientNavigation: () => <nav data-testid="client-nav" />,
}));
// Senior step stubs: pin the SEQUENCE without coupling to step internals.
vi.mock('./Step1Schedule', () => ({
  Step1Schedule: ({ onContinue }: any) => <div data-testid="senior-step-1"><button onClick={onContinue}>continue-1</button></div>,
}));
vi.mock('./Step2WhoWhere', () => ({
  Step2WhoWhere: ({ onContinue }: any) => <div data-testid="senior-step-2"><button onClick={onContinue}>continue-2</button></div>,
}));
vi.mock('./Step3CareNeeds', () => ({
  Step3CareNeeds: ({ onContinue }: any) => <div data-testid="senior-step-3"><button onClick={onContinue}>continue-3</button></div>,
}));
vi.mock('./Step4Rate', () => ({
  Step4Rate: ({ onContinue }: any) => <div data-testid="senior-step-4"><button onClick={onContinue}>continue-4</button></div>,
}));
vi.mock('./Step5Describe', () => ({
  Step5Describe: ({ onContinue }: any) => <div data-testid="senior-step-5"><button onClick={onContinue}>continue-5</button></div>,
}));
vi.mock('./Step6ScreeningReview', () => ({
  Step6ScreeningReview: () => <div data-testid="senior-step-6" />,
}));

import { PostJobFlow } from './PostJobFlow';

function callsTo(name: string) {
  return hoisted.calls.filter((c) => c.name === name);
}

function codeError(code: string): Error {
  const err = new Error(code) as Error & { details?: unknown };
  err.details = { code };
  return err;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/client/post-job" element={<PostJobFlow />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
  hoisted.calls.length = 0;
});

describe('PostJobFlow — senior parity (characterization)', () => {
  it('without a vertical param the senior flow renders its exact 6-step sequence and NO childcare calls happen', async () => {
    renderAt('/client/post-job');
    // Step sequence pin.
    expect(screen.getByTestId('senior-step-1')).toBeTruthy();
    expect(screen.getByText('Step 1 of 6')).toBeTruthy();
    for (const [btn, next] of [
      ['continue-1', 'senior-step-2'],
      ['continue-2', 'senior-step-3'],
      ['continue-3', 'senior-step-4'],
      ['continue-4', 'senior-step-5'],
      ['continue-5', 'senior-step-6'],
    ] as const) {
      fireEvent.click(screen.getByText(btn));
      expect(screen.getByTestId(next)).toBeTruthy();
    }
    expect(screen.getByText('Step 6 of 6')).toBeTruthy();
    // Zero childcare surface and zero childcare callables in the senior flow.
    expect(screen.queryByTestId('childcare-requirements-step')).toBeNull();
    expect(hoisted.calls).toHaveLength(0);
  });

  it('an unknown vertical value also renders the senior flow (fail to senior UI only for the explicit child value)', () => {
    renderAt('/client/post-job?vertical=banana');
    expect(screen.getByTestId('senior-step-1')).toBeTruthy();
    expect(hoisted.calls).toHaveLength(0);
  });
});

describe('PostJobFlow — childcare branch', () => {
  const CHILDREN = [
    { childId: 'c1', displayLabel: 'Mia', ageBand: 'preschool', careCategories: ['babysitting'], safetyCurrentVersion: 1 },
    { childId: 'c2', displayLabel: 'Rey', ageBand: 'infant', careCategories: [], safetyCurrentVersion: 0 },
  ];

  it('?vertical=child renders the U6 requirements step with children from v1-listMyChildren', async () => {
    hoisted.handlers.set('v1-listMyChildren', async () => ({ data: { success: true, children: CHILDREN } }));
    renderAt('/client/post-job?vertical=child');
    expect(await screen.findByTestId('childcare-requirements-step')).toBeTruthy();
    expect(screen.getByText('Mia')).toBeTruthy();
    // Deferred category (infant) renders disabled — server would reject anyway.
    expect(screen.getByTestId('deferred-c2')).toBeTruthy();
    // Senior steps never mount on the childcare branch.
    expect(screen.queryByTestId('senior-step-1')).toBeNull();
  });

  it('flags-off shows the unavailable state on a direct URL', async () => {
    hoisted.handlers.set('v1-listMyChildren', async () => { throw codeError('childcare_disabled'); });
    renderAt('/client/post-job?vertical=child');
    expect(await screen.findByText('Childcare is coming soon')).toBeTruthy();
  });

  it('submits the exact v1-createChildcareJobPost payload (no legacy singleton write path)', async () => {
    hoisted.handlers.set('v1-listMyChildren', async () => ({ data: { success: true, children: CHILDREN } }));
    hoisted.handlers.set('v1-createChildcareJobPost', async () => ({
      data: { success: true, jobId: 'job1', created: true, notifiedCount: 3, job: {} },
    }));
    renderAt('/client/post-job?vertical=child');

    // Step 1: requirements.
    fireEvent.click(await screen.findByLabelText('Select Mia'));
    fireEvent.click(screen.getByRole('button', { name: 'Babysitting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // Step 2: schedule + area.
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-08-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
    fireEvent.click(screen.getByRole('button', { name: 'Afternoon' }));
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'San Jose' } });
    fireEvent.change(screen.getByLabelText('Hourly rate'), { target: { value: '28' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // Step 3: review + post.
    expect(screen.getByText(/Review & post/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Post childcare job' })); });

    const sent = callsTo('v1-createChildcareJobPost');
    expect(sent).toHaveLength(1);
    const payload = sent[0].payload;
    expect(payload.childIds).toEqual(['c1']);
    expect(payload.serviceCategories).toEqual(['babysitting']);
    expect(payload.transportRequired).toBe(false);
    expect(payload.schedule).toEqual({ startDate: '2026-08-10', days: ['monday'], timeOfDay: ['afternoon'] });
    expect(payload.hourlyRate).toBe(28);
    expect(payload.city).toBe('San Jose');
    expect(payload.state).toBe('CA');
    expect(String(payload.idempotencyKey).length).toBeGreaterThan(8);
    // Privacy-safe confirmation.
    expect(await screen.findByText('Childcare job posted!')).toBeTruthy();
    expect(screen.getByText(/never names or your address/)).toBeTruthy();
  });

  it('server policy denials map to exact remediation copy', async () => {
    hoisted.handlers.set('v1-listMyChildren', async () => ({ data: { success: true, children: CHILDREN } }));
    hoisted.handlers.set('v1-createChildcareJobPost', async () => { throw codeError('transport_not_available'); });
    renderAt('/client/post-job?vertical=child');
    fireEvent.click(await screen.findByLabelText('Select Mia'));
    fireEvent.click(screen.getByRole('button', { name: 'Babysitting' }));
    fireEvent.click(screen.getByLabelText('Transport required'));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-08-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
    fireEvent.click(screen.getByRole('button', { name: 'Morning' }));
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'San Jose' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Post childcare job' })); });
    expect(await screen.findByText(/Driving is not available in your area yet/)).toBeTruthy();
  });
});
