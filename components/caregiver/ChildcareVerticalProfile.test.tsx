// ChildcareVerticalProfile (plan 2026-07-22-002, U11) — caregiver vertical page.
//
// Pins: flags-off unavailable (senior untouched copy), pending/expired/revoked
// screening remediation (exact copy per issue code), upsert payload shape,
// AE21 reused-base-fields surfacing, policy acceptance, screening start with
// invitation URL, unknown-code fallback (never silent), and error retry.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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
  auth: null,
  default: {},
}));
vi.mock('./CaregiverTopNav', () => ({
  CaregiverTopNav: () => <nav data-testid="caregiver-nav" />,
}));

import { ChildcareVerticalProfile, CHILDCARE_REMEDIATION } from './ChildcareVerticalProfile';

function callsTo(name: string) {
  return hoisted.calls.filter((c) => c.name === name);
}

function codeError(code: string): Error {
  const err = new Error(code) as Error & { details?: unknown };
  err.details = { code };
  return err;
}

const READY_PROFILE = {
  ageBands: ['preschool', 'school_age'],
  services: ['babysitting'],
  yearsChildcareExperience: 4,
  hourlyRate: 26,
  transport: { offersTransport: true },
  limitations: [],
  jurisdictionState: 'CA',
  adultAgeAttested: true,
  acceptedPolicyVersion: 'ca-2026-07',
  approvalState: 'approved',
  suspensionActive: false,
  profileVersion: 3,
};

function armState(overrides: Record<string, unknown> = {}) {
  hoisted.handlers.set('v1-getMyChildcareProviderState', async () => ({
    data: {
      success: true,
      hasVerticalProfile: true,
      verticalProfile: READY_PROFILE,
      screening: { evidenceStatus: 'clear', invitationStatus: 'completed', expiresAt: '2027-01-01T00:00:00.000Z', adverseActionState: 'none', evidenceVersion: 2 },
      reusedBaseFields: ['name', 'email', 'city'],
      missingBaseFields: [],
      missingChildcareFields: [],
      eligibility: { eligible: true, issues: [], transportCapable: true, renewalDue: false },
      ...overrides,
    },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.handlers.clear();
  hoisted.calls.length = 0;
});

describe('ChildcareVerticalProfile — gating', () => {
  it('flags-off renders unavailable with senior-independence reassurance', async () => {
    hoisted.handlers.set('v1-getMyChildcareProviderState', async () => { throw codeError('childcare_disabled'); });
    render(<ChildcareVerticalProfile />);
    expect(await screen.findByText('Childcare is coming soon')).toBeTruthy();
    expect(screen.getByText(/senior care profile, approval, and bookings are completely unaffected/i)).toBeTruthy();
  });

  it('network failure shows explicit retry', async () => {
    hoisted.handlers.set('v1-getMyChildcareProviderState', async () => { throw new Error('network'); });
    render(<ChildcareVerticalProfile />);
    expect(await screen.findByText(/could not load your childcare profile/i)).toBeTruthy();
    armState();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/You are visible to families for childcare/)).toBeTruthy();
  });
});

describe('ChildcareVerticalProfile — remediation (exact copy per issue code)', () => {
  it('pending screening shows the in-progress remediation', async () => {
    armState({
      screening: { evidenceStatus: 'pending', invitationStatus: 'sent', expiresAt: null, adverseActionState: 'none', evidenceVersion: 1 },
      eligibility: { eligible: false, issues: [{ code: 'evidence_pending', field: 'evidenceStatus' }, { code: 'manual_approval_missing', field: 'approval.state' }], transportCapable: false, renewalDue: false },
    });
    render(<ChildcareVerticalProfile />);
    expect(await screen.findByText(/background check is still in progress/)).toBeTruthy();
    expect(screen.getByText(/has not been approved by the Evia team yet/)).toBeTruthy();
    expect(screen.getByText(/not visible for childcare yet/)).toBeTruthy();
  });

  it('expired screening shows the renew remediation', async () => {
    armState({
      screening: { evidenceStatus: 'expired', invitationStatus: 'completed', expiresAt: '2026-01-01T00:00:00.000Z', adverseActionState: 'none', evidenceVersion: 3 },
      eligibility: { eligible: false, issues: [{ code: 'report_expired', field: 'expiresAt' }], transportCapable: false, renewalDue: true },
    });
    render(<ChildcareVerticalProfile />);
    expect(await screen.findByText(/background check has expired/)).toBeTruthy();
    expect(screen.getByText(/Renew it with the button/)).toBeTruthy();
    expect(screen.getByText(/due for renewal/)).toBeTruthy();
  });

  it('revoked approval and suspension show contact-support remediation and senior independence', async () => {
    armState({
      eligibility: { eligible: false, issues: [{ code: 'manual_approval_revoked', field: 'approval.state' }, { code: 'suspension_active', field: 'suspension' }], transportCapable: false, renewalDue: false },
    });
    render(<ChildcareVerticalProfile />);
    expect(await screen.findByText(/approval was revoked/)).toBeTruthy();
    expect(screen.getByText(/visibility is suspended/)).toBeTruthy();
    expect(screen.getByText(/senior care work is not affected by this suspension/)).toBeTruthy();
  });

  it('an unknown issue code falls back to a named-code remediation (never silent omission)', async () => {
    armState({
      eligibility: { eligible: false, issues: [{ code: 'brand_new_gate', field: '(x)' }], transportCapable: false, renewalDue: false },
    });
    render(<ChildcareVerticalProfile />);
    expect(await screen.findByText(/code: brand_new_gate/)).toBeTruthy();
  });

  it('every mapped remediation names both the gap and an action', () => {
    for (const [code, entry] of Object.entries(CHILDCARE_REMEDIATION)) {
      expect(entry.missing.length, code).toBeGreaterThan(10);
      expect(entry.action.length, code).toBeGreaterThan(10);
    }
  });
});

describe('ChildcareVerticalProfile — upsert (AE21)', () => {
  it('sends the exact childcare-delta payload and surfaces reused base fields', async () => {
    armState();
    hoisted.handlers.set('v1-upsertChildcareVerticalProfile', async () => ({
      data: {
        success: true,
        profileVersion: 4,
        reusedBaseFields: ['name', 'email', 'city'],
        missingBaseFields: [],
        missingChildcareFields: [],
      },
    }));
    render(<ChildcareVerticalProfile />);
    await screen.findByText('Childcare details');

    fireEvent.click(screen.getByLabelText('Age group 1–2 yrs')); // add toddler
    fireEvent.change(screen.getByLabelText('Childcare hourly rate'), { target: { value: '30' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save childcare profile' })); });

    const sent = callsTo('v1-upsertChildcareVerticalProfile');
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0].payload).sort()).toEqual([
      'adultAgeAttested', 'ageBands', 'hourlyRate', 'jurisdictionState',
      'offersTransport', 'services', 'yearsChildcareExperience',
    ]);
    expect(sent[0].payload.ageBands).toEqual(expect.arrayContaining(['preschool', 'school_age', 'toddler']));
    expect(sent[0].payload.hourlyRate).toBe(30);
    expect(sent[0].payload.jurisdictionState).toBe('CA');
    expect(sent[0].payload.adultAgeAttested).toBe(true);

    // AE21: reused fields are named — no surface re-asks them.
    expect(await screen.findByText(/We reused 3 details from your existing profile/)).toBeTruthy();
  });
});

describe('ChildcareVerticalProfile — policy and screening', () => {
  it('policy acceptance calls the callable and reports the version', async () => {
    armState({ verticalProfile: { ...READY_PROFILE, acceptedPolicyVersion: null } });
    hoisted.handlers.set('v1-acceptChildcarePolicy', async () => ({
      data: { success: true, acceptedPolicyVersion: 'ca-2026-07' },
    }));
    render(<ChildcareVerticalProfile />);
    const btn = await screen.findByRole('button', { name: 'Accept childcare policy' });
    await act(async () => { fireEvent.click(btn); });
    expect(callsTo('v1-acceptChildcarePolicy')).toHaveLength(1);
    expect(await screen.findByText(/Childcare policy accepted \(version ca-2026-07\)/)).toBeTruthy();
  });

  it('policy_version_unavailable maps to the exact waiting copy', async () => {
    armState({ verticalProfile: { ...READY_PROFILE, acceptedPolicyVersion: null } });
    hoisted.handlers.set('v1-acceptChildcarePolicy', async () => { throw codeError('policy_version_unavailable'); });
    render(<ChildcareVerticalProfile />);
    const btn = await screen.findByRole('button', { name: 'Accept childcare policy' });
    await act(async () => { fireEvent.click(btn); });
    expect(await screen.findByText(/policy for your state is not ready to accept yet/)).toBeTruthy();
  });

  it('screening start shows the invitation link on invitation_sent', async () => {
    armState({ screening: null, eligibility: { eligible: false, issues: [{ code: 'screening_absent', field: '(document)' }], transportCapable: false, renewalDue: false } });
    hoisted.handlers.set('v1-startChildcareScreening', async () => ({
      data: { success: true, mode: 'invitation_sent', evidenceStatus: 'pending', invitationUrl: 'https://apply.checkr.example/x' },
    }));
    render(<ChildcareVerticalProfile />);
    const btn = await screen.findByRole('button', { name: 'Start background check' });
    await act(async () => { fireEvent.click(btn); });
    expect(callsTo('v1-startChildcareScreening')).toHaveLength(1);
    const link = await screen.findByRole('link', { name: /Complete your background check/ });
    expect(link.getAttribute('href')).toBe('https://apply.checkr.example/x');
  });

  it('base_evidence_adopted explains the shared-package reuse (no duplicate check)', async () => {
    armState();
    hoisted.handlers.set('v1-startChildcareScreening', async () => ({
      data: { success: true, mode: 'base_evidence_adopted', evidenceStatus: 'clear' },
    }));
    render(<ChildcareVerticalProfile />);
    const btn = await screen.findByRole('button', { name: 'Renew background check' });
    await act(async () => { fireEvent.click(btn); });
    expect(await screen.findByText(/existing background check covers childcare too/)).toBeTruthy();
  });

  it('never uses safety-guarantee language for a clear check', async () => {
    armState();
    const { container } = render(<ChildcareVerticalProfile />);
    await screen.findByText(/You are visible to families for childcare/);
    expect(container.innerHTML).not.toMatch(/guarantee|100% safe|fully vetted/i);
    expect(screen.getByText(/never an automatic approval/)).toBeTruthy();
  });
});
