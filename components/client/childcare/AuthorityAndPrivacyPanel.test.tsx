// AuthorityAndPrivacyPanel (plan 2026-07-22-002, U11) — household adults,
// scopes, invites, revocation, data export/delete.
//
// Pins: UI drives from callable responses (partial scopes hide what
// checkAuthority would deny — non-primary adults get no invite/revoke UI),
// one-time invite token display, recent-auth remediation, revoked/expired
// authority states, dispute-hold copy (R18), lifecycle entry points, and the
// members-seam unavailable state.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
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

import { AuthorityAndPrivacyPanel } from './AuthorityAndPrivacyPanel';

function callsTo(name: string) {
  return hoisted.calls.filter((c) => c.name === name);
}

function codeError(code: string): Error {
  const err = new Error(code) as Error & { details?: unknown };
  err.details = { code };
  return err;
}

const CHILD = { childId: 'c1', displayLabel: 'Mia', ageBand: 'preschool', careCategories: ['babysitting'], safetyCurrentVersion: 1 };

function arm(opts: {
  households?: any[];
  authorities?: any[];
  children?: any[];
  members?: any[] | 'error';
} = {}) {
  hoisted.handlers.set('v1-getMyHouseholdState', async () => ({
    data: {
      success: true,
      households: opts.households ?? [{ householdId: 'hh1', isPrimary: true, membershipRole: 'primary', status: 'active' }],
      authorities: opts.authorities ?? [
        { authorityId: 'auth1', householdId: 'hh1', childId: 'c1', scopes: ['view', 'schedule', 'payment'], state: 'active', expiresAt: null, accessVersion: 1 },
      ],
    },
  }));
  hoisted.handlers.set('v1-listMyChildren', async () => ({
    data: { success: true, children: opts.children ?? [CHILD] },
  }));
  hoisted.handlers.set('v1-listHouseholdMembers', async () => {
    if (opts.members === 'error') throw new Error('seam missing');
    return { data: { success: true, members: opts.members ?? [] } };
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/childcare/authority']}>
      <AuthorityAndPrivacyPanel />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
  hoisted.calls.length = 0;
});

describe('AuthorityAndPrivacyPanel — states and scopes', () => {
  it('flags-off renders unavailable', async () => {
    hoisted.handlers.set('v1-getMyHouseholdState', async () => { throw codeError('childcare_disabled'); });
    hoisted.handlers.set('v1-listMyChildren', async () => { throw codeError('childcare_disabled'); });
    renderPage();
    expect(await screen.findByText('Childcare is coming soon')).toBeTruthy();
  });

  it('shows own scopes as chips, driven by the callable response', async () => {
    arm({});
    renderPage();
    expect(await screen.findByText('Mia (3–4 yrs)')).toBeTruthy();
    expect(screen.getByText('View')).toBeTruthy();
    expect(screen.getByText('Schedule')).toBeTruthy();
    expect(screen.getByText('Payment')).toBeTruthy();
  });

  it('an authorized adult with partial scopes and no primary role gets NO invite or revoke controls', async () => {
    arm({
      households: [{ householdId: 'hh1', isPrimary: false, membershipRole: 'adult', status: 'active' }],
      authorities: [{ authorityId: 'auth2', householdId: 'hh1', childId: 'c1', scopes: ['view'], state: 'active', expiresAt: null, accessVersion: 1 }],
      members: [{
        adultUid: 'other-1', displayLabel: 'Alex P', role: 'adult',
        authorities: [{ childId: 'c1', scopes: ['view'], state: 'active', accessVersion: 1 }],
      }],
    });
    renderPage();
    await screen.findByText('Household adults');
    expect(screen.queryByRole('button', { name: /Invite an adult/ })).toBeNull();
    await screen.findByText(/Alex P/);
    expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull();
    // Their own limited scope still shows.
    expect(screen.getByText('View')).toBeTruthy();
    expect(screen.queryByText('Payment')).toBeNull();
  });

  it('revoked and expired own authorities show explicit remediation, never silent omission', async () => {
    arm({
      authorities: [
        { authorityId: 'a-rev', householdId: 'hh1', childId: 'c1', scopes: ['view'], state: 'revoked', expiresAt: null, accessVersion: 4 },
        { authorityId: 'a-exp', householdId: 'hh1', childId: 'c1', scopes: ['schedule'], state: 'active', expiresAt: '2020-01-01T00:00:00.000Z', accessVersion: 2 },
      ],
    });
    renderPage();
    expect(await screen.findByText('Access revoked')).toBeTruthy();
    expect(screen.getByText(/Access expired — ask the primary adult/)).toBeTruthy();
  });

  it('members-seam failure shows an explicit non-silent state with retry', async () => {
    arm({ members: 'error' });
    renderPage();
    expect(await screen.findByText(/adults can't be listed right now/i)).toBeTruthy();
    hoisted.handlers.set('v1-listHouseholdMembers', async () => ({ data: { success: true, members: [] } }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No other adults have access yet.')).toBeTruthy();
  });
});

describe('AuthorityAndPrivacyPanel — invites', () => {
  it('creates an invite with exact payload and shows the one-time token exactly once', async () => {
    arm({});
    hoisted.handlers.set('v1-inviteHouseholdAdult', async () => ({
      data: { success: true, tokenId: 't1', inviteToken: 'tok.SECRET', expiresAt: '2026-08-01T00:00:00.000Z', alreadyExisted: false },
    }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Invite an adult/ }));
    fireEvent.change(screen.getByLabelText('Invite contact'), { target: { value: '+14085551234' } });
    fireEvent.click(screen.getByLabelText('Schedule for Mia'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create invite' })); });

    const sent = callsTo('v1-inviteHouseholdAdult');
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.householdId).toBe('hh1');
    expect(sent[0].payload.intendedContact).toEqual({ channel: 'sms', value: '+14085551234' });
    expect(sent[0].payload.proposedScopes).toEqual([{ childId: 'c1', scopes: ['schedule'] }]);
    expect(String(sent[0].payload.idempotencyKey).length).toBeGreaterThan(8);

    // One-time display, dismissible; never persisted to web storage.
    expect(screen.getByTestId('invite-token').textContent).toBe('tok.SECRET');
    const stored = JSON.stringify({ ...window.localStorage, ...window.sessionStorage });
    expect(stored).not.toContain('tok.SECRET');
    fireEvent.click(screen.getByRole('button', { name: /hide the code/ }));
    expect(screen.queryByTestId('invite-token')).toBeNull();
  });

  it('recent-auth requirement surfaces the exact security remediation', async () => {
    arm({});
    hoisted.handlers.set('v1-inviteHouseholdAdult', async () => { throw codeError('recent_auth_required'); });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Invite an adult/ }));
    fireEvent.change(screen.getByLabelText('Invite contact'), { target: { value: '+14085551234' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create invite' })); });
    expect(await screen.findByText(/please sign in again, then retry/i)).toBeTruthy();
  });
});

describe('AuthorityAndPrivacyPanel — revocation (R18)', () => {
  const memberRow = {
    adultUid: 'other-1', displayLabel: 'Alex P', role: 'adult',
    authorities: [{ childId: 'c1', scopes: ['view', 'schedule'], state: 'active', accessVersion: 3 }],
  };

  it('revoke sends the exact payload including the expected access version', async () => {
    arm({ members: [memberRow] });
    hoisted.handlers.set('v1-revokeGuardianAuthority', async () => ({
      data: { success: true, authorityId: 'authX', state: 'revoked', disputeHold: false, accessVersion: 4 },
    }));
    renderPage();
    const btn = await screen.findByRole('button', { name: /Revoke Mia access for Alex P/ });
    await act(async () => { fireEvent.click(btn); });
    const sent = callsTo('v1-revokeGuardianAuthority');
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.householdId).toBe('hh1');
    expect(sent[0].payload.childId).toBe('c1');
    expect(sent[0].payload.targetAdultUid).toBe('other-1');
    expect(sent[0].payload.expectedAccessVersion).toBe(3);
    expect(await screen.findByText(/Access revoked\. All derived access/)).toBeTruthy();
  });

  it('a dispute hold is explained verbatim (co-guardian protection, R18)', async () => {
    arm({ members: [memberRow] });
    hoisted.handlers.set('v1-revokeGuardianAuthority', async () => ({
      data: { success: true, authorityId: 'authX', state: 'dispute_hold', disputeHold: true, accessVersion: 4 },
    }));
    renderPage();
    const btn = await screen.findByRole('button', { name: /Revoke/ });
    await act(async () => { fireEvent.click(btn); });
    expect(await screen.findByText(/dispute hold/)).toBeTruthy();
    expect(screen.getByText(/operator reviews it before access ends/)).toBeTruthy();
  });
});

describe('AuthorityAndPrivacyPanel — data lifecycle (U3 callables)', () => {
  it('export sends childId + idempotency key and tracks the request status', async () => {
    arm({});
    hoisted.handlers.set('v1-requestChildDataExport', async () => ({
      data: { success: true, requestId: 'req1', state: 'queued' },
    }));
    hoisted.handlers.set('v1-getLifecycleRequestStatus', async () => ({
      data: { success: true, requestId: 'req1', state: 'completed' },
    }));
    renderPage();
    const btn = await screen.findByRole('button', { name: 'Export data for Mia' });
    await act(async () => { fireEvent.click(btn); });
    const sent = callsTo('v1-requestChildDataExport');
    expect(sent[0].payload.childId).toBe('c1');
    expect(String(sent[0].payload.idempotencyKey).length).toBeGreaterThan(8);
    expect(await screen.findByText(/Export requested/)).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check status' })); });
    expect(callsTo('v1-getLifecycleRequestStatus')[0].payload).toEqual({ requestId: 'req1' });
    expect(await screen.findByText(/Completed/)).toBeTruthy();
  });

  it('deletion requires confirmation and explains the tracked workflow (never auth-only wipe copy)', async () => {
    arm({});
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    hoisted.handlers.set('v1-requestChildDataDeletion', async () => ({
      data: { success: true, requestId: 'req2', state: 'queued' },
    }));
    renderPage();
    const btn = await screen.findByRole('button', { name: 'Delete data for Mia' });
    await act(async () => { fireEvent.click(btn); });
    expect(confirmSpy).toHaveBeenCalled();
    expect(callsTo('v1-requestChildDataDeletion')[0].payload.childId).toBe('c1');
    expect(await screen.findByText(/tracked below until every eligible record/)).toBeTruthy();
    confirmSpy.mockRestore();
  });

  it('declining the confirm sends nothing', async () => {
    arm({});
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    const btn = await screen.findByRole('button', { name: 'Delete data for Mia' });
    await act(async () => { fireEvent.click(btn); });
    expect(callsTo('v1-requestChildDataDeletion')).toHaveLength(0);
    confirmSpy.mockRestore();
  });
});
