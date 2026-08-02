// ChildcareIncidentQueue (plan 2026-07-22-002, U12) — operator queue UI.
//
// Pins: callable-only data flow (no Firestore imports), the sanitized queue
// render, the MANDATORY reason-for-access prompt BEFORE any detail fetch
// (R56 — empty reason never sends a request), the exact detail payload shape
// (caseId + reason), scope-denial messaging (AE18), status transitions via
// the callable, and the no-operator-role queue denial state.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import * as fs from 'fs';
import * as path from 'path';

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
  auth: { currentUser: { uid: 'op-safety' } },
}));
vi.mock('../../lib/childcareCallable', () => ({
  childcareCallable: (name: string) => hoisted.httpsCallable(
    name.startsWith('v1-') ? name : `v1-${name}`,
  ),
}));

import { ChildcareIncidentQueue } from './ChildcareIncidentQueue';

const ROW = {
  caseId: 'cinc_1',
  category: 'injury',
  status: 'open',
  source: 'marker',
  ownerUid: null,
  createdAt: '2026-07-23T11:00:00.000Z',
  updatedAt: '2026-07-23T11:00:00.000Z',
  evidenceCount: 1,
  suspectedPartyCount: 0,
  hasPayoutHold: false,
  hasLitigationHold: true,
};

const DETAIL = {
  caseId: 'cinc_1',
  category: 'injury',
  status: 'open',
  ownerUid: null,
  summary: 'Family reported an injury during pickup.',
  subject: { bookingId: 'cbook_1', sessionPhone: '+14085551234', householdId: null },
  evidenceRefs: [{ kind: 'session', ref: '+14085551234', addedByUid: 'system', addedAt: 'x' }],
  suspectedPartyUids: ['cg-sus'],
  transitions: [],
};

function callsTo(name: string) {
  return hoisted.calls.filter((c) => c.name === name);
}

function deniedError(): Error {
  const err = new Error('You do not have permission to perform this action.') as Error & { code?: string };
  err.code = 'permission-denied';
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
  hoisted.calls.length = 0;
  hoisted.handlers.set('v1-listChildcareIncidents', async () => ({
    data: { success: true, incidents: [ROW] },
  }));
});

describe('ChildcareIncidentQueue — sanitized queue', () => {
  it('loads the queue on mount via the callable and renders sanitized rows', async () => {
    render(<ChildcareIncidentQueue />);
    expect(await screen.findByText('injury')).toBeTruthy();
    expect(screen.getByText('unassigned')).toBeTruthy();
    expect(screen.getByText('escalation')).toBeTruthy(); // marker source label
    expect(screen.getByText('litigation')).toBeTruthy(); // hold badge
    expect(callsTo('v1-listChildcareIncidents')).toHaveLength(1);
    // Nothing child-sensitive is on screen before the detail flow.
    expect(screen.queryByText('+14085551234')).toBeNull();
  });

  it('a status filter change re-queries with the status payload', async () => {
    render(<ChildcareIncidentQueue />);
    await screen.findByText('injury');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'open' } });
    });
    const listCalls = callsTo('v1-listChildcareIncidents');
    expect(listCalls[listCalls.length - 1].payload).toEqual({ status: 'open' });
  });

  it('shows the operator-role denial state when the queue itself is denied', async () => {
    hoisted.handlers.set('v1-listChildcareIncidents', async () => { throw deniedError(); });
    render(<ChildcareIncidentQueue />);
    expect(
      await screen.findByText('You do not have an operator role for the childcare incident queue.'),
    ).toBeTruthy();
  });
});

describe('ChildcareIncidentQueue — reason-for-access gate (R56)', () => {
  it('opening a case shows the reason prompt and does NOT fetch detail yet', async () => {
    render(<ChildcareIncidentQueue />);
    await screen.findByText('injury');
    fireEvent.click(screen.getByText('Open case'));
    expect(await screen.findByText('Reason for access')).toBeTruthy();
    expect(callsTo('v1-getChildcareIncidentDetail')).toHaveLength(0);
  });

  it('an EMPTY reason never sends a request', async () => {
    render(<ChildcareIncidentQueue />);
    await screen.findByText('injury');
    fireEvent.click(screen.getByText('Open case'));
    await screen.findByText('Reason for access');
    await act(async () => { fireEvent.click(screen.getByText('Open case detail')); });
    expect(callsTo('v1-getChildcareIncidentDetail')).toHaveLength(0);
    expect(screen.getByText('A reason for access is required.')).toBeTruthy();
  });

  it('a structured reason fetches detail with exactly caseId + reason code and renders the case', async () => {
    hoisted.handlers.set('v1-getChildcareIncidentDetail', async () => ({
      data: { success: true, incident: DETAIL },
    }));
    render(<ChildcareIncidentQueue />);
    await screen.findByText('injury');
    fireEvent.click(screen.getByText('Open case'));
    fireEvent.change(await screen.findByLabelText('Reason for access'), {
      target: { value: 'incident_investigation' },
    });
    await act(async () => { fireEvent.click(screen.getByText('Open case detail')); });
    const detailCalls = callsTo('v1-getChildcareIncidentDetail');
    expect(detailCalls).toHaveLength(1);
    expect(detailCalls[0].payload).toEqual({
      caseId: 'cinc_1',
      reason: 'incident_investigation',
    });
    expect(screen.getByText('Family reported an injury during pickup.')).toBeTruthy();
    expect(screen.getByText(/Suspected parties excluded from notifications: 1/)).toBeTruthy();
  });

  it('a scope denial on detail shows the childSafetyOperator message (AE18) — queue stays visible', async () => {
    hoisted.handlers.set('v1-getChildcareIncidentDetail', async () => { throw deniedError(); });
    render(<ChildcareIncidentQueue />);
    await screen.findByText('injury');
    fireEvent.click(screen.getByText('Open case'));
    fireEvent.change(await screen.findByLabelText('Reason for access'), { target: { value: 'safety_review' } });
    await act(async () => { fireEvent.click(screen.getByText('Open case detail')); });
    expect(screen.getByText('Case detail requires the child-safety operator role.')).toBeTruthy();
    expect(screen.getByText('injury')).toBeTruthy();
  });
});

describe('ChildcareIncidentQueue — detail actions', () => {
  async function openDetail() {
    hoisted.handlers.set('v1-getChildcareIncidentDetail', async () => ({
      data: { success: true, incident: DETAIL },
    }));
    render(<ChildcareIncidentQueue />);
    await screen.findByText('injury');
    fireEvent.click(screen.getByText('Open case'));
    fireEvent.change(await screen.findByLabelText('Reason for access'), { target: { value: 'incident_triage' } });
    await act(async () => { fireEvent.click(screen.getByText('Open case detail')); });
  }

  it('offers only the valid next statuses for an open case and calls the update callable', async () => {
    hoisted.handlers.set('v1-updateChildcareIncidentStatus', async () => ({
      data: { success: true, status: 'investigating' },
    }));
    await openDetail();
    expect(screen.getByText('Mark investigating')).toBeTruthy();
    expect(screen.queryByText('Mark resolved')).toBeNull(); // open → resolved is not a valid move
    await act(async () => { fireEvent.click(screen.getByText('Mark investigating')); });
    expect(callsTo('v1-updateChildcareIncidentStatus')[0].payload).toEqual({
      caseId: 'cinc_1',
      status: 'investigating',
      reason: 'incident_triage',
    });
  });

  it('assign-to-me sends the signed-in operator uid', async () => {
    hoisted.handlers.set('v1-assignChildcareIncident', async () => ({
      data: { success: true, ownerUid: 'op-safety' },
    }));
    await openDetail();
    await act(async () => { fireEvent.click(screen.getByText('Assign to me')); });
    expect(callsTo('v1-assignChildcareIncident')[0].payload).toEqual({
      caseId: 'cinc_1',
      ownerUid: 'op-safety',
      reason: 'incident_triage',
    });
  });
});

describe('ChildcareIncidentQueue — structural contracts', () => {
  it('never imports Firestore — the browser has no read path to childcare_incidents', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'ChildcareIncidentQueue.tsx'), 'utf8');
    expect(src).not.toContain("from 'firebase/firestore'");
    expect(src).not.toContain('collection(');
    expect(src).not.toContain('getDocs');
    expect(src).toContain("from '../../lib/childcareCallable'");
    expect(src).not.toContain('functions.httpsCallable');
  });
});
