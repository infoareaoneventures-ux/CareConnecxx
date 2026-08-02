// ChildProfileFlow (plan 2026-07-22-002, U4) — secure child-profile form.
//
// Pins: resume from canonical state, callable-only writes with exact payload
// shapes (no extra child fields leak into create), household bootstrap, NO
// local persistence of private safety fields, identity callback consumption
// (one-time state from sessionStorage), and the flags-off unavailable state.

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

vi.mock('../../../lib/firebase', () => ({
  functions: { httpsCallable: hoisted.httpsCallable },
  // lib/childcareCallable imports this; undefined selects its compat path.
  childcareFunctions: undefined,
}));

import { ChildProfileFlow, IDENTITY_STATE_STORAGE_KEY } from './ChildProfileFlow';

function callsTo(name: string) {
  return hoisted.calls.filter((c) => c.name === name);
}

function disabledError(): Error {
  const err = new Error('Childcare features are not available yet.') as Error & { details?: unknown };
  err.details = { code: 'childcare_disabled' };
  return err;
}

function armDefaults(opts: { households?: any[]; children?: any[] } = {}) {
  hoisted.handlers.set('v1-getMyHouseholdState', async () => ({
    data: { success: true, households: opts.households ?? [], authorities: [] },
  }));
  hoisted.handlers.set('v1-listMyChildren', async () => ({
    data: { success: true, children: opts.children ?? [] },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
  hoisted.calls.length = 0;
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.pushState({}, '', '/childcare/children');
});

describe('ChildProfileFlow — resume from canonical state', () => {
  it('renders multiple children from listMyChildren (resumable)', async () => {
    armDefaults({
      households: [{ householdId: 'hh1', isPrimary: true }],
      children: [
        { childId: 'c1', displayLabel: 'Mia', ageBand: 'preschool', careCategories: ['babysitting'], safetyCurrentVersion: 1 },
        { childId: 'c2', displayLabel: 'Leo', ageBand: 'school_age', careCategories: ['after_school_care'], safetyCurrentVersion: 0 },
      ],
    });
    render(<ChildProfileFlow />);
    expect(await screen.findByText('Mia')).toBeTruthy();
    expect(screen.getByText('Leo')).toBeTruthy();
    expect(screen.getByText('Update safety details')).toBeTruthy(); // Mia has a version
    expect(screen.getByText('Add safety details')).toBeTruthy();    // Leo does not
  });

  it('shows the unavailable state when the flags are off (childcare_disabled)', async () => {
    hoisted.handlers.set('v1-getMyHouseholdState', async () => { throw disabledError(); });
    hoisted.handlers.set('v1-listMyChildren', async () => { throw disabledError(); });
    render(<ChildProfileFlow />);
    expect(await screen.findByText('Childcare is coming soon')).toBeTruthy();
    // No form is rendered — nothing child-related can be typed while dark.
    expect(screen.queryByLabelText('Child name')).toBeNull();
  });
});

describe('ChildProfileFlow — create child (callable-only writes)', () => {
  it('bootstraps a household when none exists, then creates the profile with the exact payload', async () => {
    armDefaults({ households: [], children: [] });
    hoisted.handlers.set('v1-createHousehold', async () => ({ data: { success: true, householdId: 'hh-new' } }));
    hoisted.handlers.set('v1-createChildProfile', async () => ({ data: { success: true, childId: 'c-new' } }));

    render(<ChildProfileFlow />);
    await screen.findByText('Add a child');

    fireEvent.change(screen.getByLabelText('Child name'), { target: { value: 'Mia' } });
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '2021-03-04' } });
    fireEvent.click(screen.getByLabelText('Babysitting'));
    await act(async () => { fireEvent.click(screen.getByText('Add child')); });

    expect(callsTo('v1-createHousehold')).toHaveLength(1);
    const create = callsTo('v1-createChildProfile');
    expect(create).toHaveLength(1);
    const payload = create[0].payload;
    expect(Object.keys(payload).sort()).toEqual(
      ['careCategories', 'displayLabel', 'guardianAttestationVersion', 'householdId', 'idempotencyKey', 'safety'].sort(),
    );
    expect(payload.householdId).toBe('hh-new');
    expect(payload.displayLabel).toBe('Mia');
    expect(payload.careCategories).toEqual(['babysitting']);
    // Private zone: create carries the DOB and NOTHING else.
    expect(Object.keys(payload.safety)).toEqual(['dateOfBirth']);
    expect(payload.guardianAttestationVersion).toBe('pending-policy-version');
    expect(String(payload.idempotencyKey).length).toBeGreaterThan(8);
  });

  it('reuses the existing household without calling createHousehold', async () => {
    armDefaults({ households: [{ householdId: 'hh1', isPrimary: true }], children: [] });
    hoisted.handlers.set('v1-createChildProfile', async () => ({ data: { success: true } }));

    render(<ChildProfileFlow />);
    await screen.findByText('Add a child');
    fireEvent.change(screen.getByLabelText('Child name'), { target: { value: 'Leo' } });
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '2019-01-02' } });
    fireEvent.click(screen.getByLabelText('Nanny care'));
    await act(async () => { fireEvent.click(screen.getByText('Add child')); });

    expect(callsTo('v1-createHousehold')).toHaveLength(0);
    expect(callsTo('v1-createChildProfile')[0].payload.householdId).toBe('hh1');
  });
});

describe('ChildProfileFlow — private safety details', () => {
  it('submits straight to appendChildSafetyVersion and persists NOTHING locally', async () => {
    armDefaults({
      households: [{ householdId: 'hh1', isPrimary: true }],
      children: [{ childId: 'c1', displayLabel: 'Mia', ageBand: 'preschool', careCategories: ['babysitting'], safetyCurrentVersion: 0 }],
    });
    hoisted.handlers.set('v1-appendChildSafetyVersion', async () => ({ data: { success: true, version: 1 } }));

    render(<ChildProfileFlow />);
    fireEvent.click(await screen.findByText('Add safety details'));

    fireEvent.change(screen.getByLabelText('Emergency contact name'), { target: { value: 'Grandma Rose' } });
    fireEvent.change(screen.getByLabelText('Emergency contact relationship'), { target: { value: 'grandmother' } });
    fireEvent.change(screen.getByLabelText('Emergency contact phone'), { target: { value: '+14085551234' } });
    fireEvent.change(screen.getByLabelText('Allergies'), { target: { value: 'peanuts' } });
    await act(async () => { fireEvent.click(screen.getByText('Save safety details')); });

    const append = callsTo('v1-appendChildSafetyVersion');
    expect(append).toHaveLength(1);
    expect(append[0].payload.childId).toBe('c1');
    expect(append[0].payload.safety.allergiesNote).toBe('peanuts');
    expect(append[0].payload.safety.emergencyContacts).toEqual([
      { name: 'Grandma Rose', relationship: 'grandmother', phone: '+14085551234' },
    ]);

    // No local persistence of private fields — ever (R57 / U4 contract).
    const stored = JSON.stringify({ ...window.localStorage, ...window.sessionStorage });
    expect(stored).not.toContain('peanuts');
    expect(stored).not.toContain('Grandma Rose');
    // Form cleared after submit (in-memory copy dropped).
    expect(screen.queryByDisplayValue('peanuts')).toBeNull();
  });
});

describe('ChildProfileFlow — identity gate (R22)', () => {
  it('stores the one-time callback state and asks Stripe for the hosted URL', async () => {
    armDefaults({ households: [{ householdId: 'hh1', isPrimary: true }], children: [] });
    hoisted.handlers.set('v1-createChildcareIdentitySession', async () => ({
      data: { success: true, status: 'created', url: 'https://verify.stripe.example/x', callbackState: 'nonce123' },
    }));

    render(<ChildProfileFlow />);
    await screen.findByText('Verify my identity');
    await act(async () => { fireEvent.click(screen.getByText('Verify my identity')); });

    expect(callsTo('v1-createChildcareIdentitySession')).toHaveLength(1);
    expect(window.sessionStorage.getItem(IDENTITY_STATE_STORAGE_KEY)).toBe('nonce123');
  });

  it('on return, consumes the state exactly once (storage cleared before the round-trip)', async () => {
    window.history.pushState({}, '', '/childcare/children?identity=return');
    window.sessionStorage.setItem(IDENTITY_STATE_STORAGE_KEY, 'nonce123');
    armDefaults({ households: [], children: [] });
    hoisted.handlers.set('v1-consumeChildcareIdentityCallback', async () => ({
      data: { success: true, objectiveId: 'obj1', status: 'verified' },
    }));

    render(<ChildProfileFlow />);
    await waitFor(() => expect(callsTo('v1-consumeChildcareIdentityCallback')).toHaveLength(1));
    expect(callsTo('v1-consumeChildcareIdentityCallback')[0].payload).toEqual({ state: 'nonce123' });
    expect(window.sessionStorage.getItem(IDENTITY_STATE_STORAGE_KEY)).toBeNull();
    expect(await screen.findByText('Identity verified — thank you!')).toBeTruthy();
  });

  it('an expired/replayed state shows remediation instead of granting anything', async () => {
    window.history.pushState({}, '', '/childcare/children?identity=return');
    window.sessionStorage.setItem(IDENTITY_STATE_STORAGE_KEY, 'stale');
    armDefaults({ households: [], children: [] });
    hoisted.handlers.set('v1-consumeChildcareIdentityCallback', async () => {
      const err = new Error('expired') as Error & { details?: unknown };
      err.details = { code: 'callback_expired' };
      throw err;
    });

    render(<ChildProfileFlow />);
    expect(await screen.findByText(/verification link expired or was already used/)).toBeTruthy();
  });
});
