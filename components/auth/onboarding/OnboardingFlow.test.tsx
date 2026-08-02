// Childcare U4 (plan 2026-07-22-002) — signup intent plumbing tests.
//
// THE critical assertions are the SENIOR PARITY rows: without the explicit
// childcare entry param the flow must render the exact pre-childcare steps and
// send the exact pre-childcare callable payload (no careVertical key at all).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';

const hoisted = vi.hoisted(() => ({
  confirm: vi.fn(async (_code: string): Promise<any> => ({ user: { uid: 'u1' } })),
  signInWithPhoneNumber: vi.fn(async (..._args: any[]): Promise<any> => ({ confirm: hoisted.confirm })),
  createWebOnboardingSession: vi.fn(async (_payload: any): Promise<any> => ({ data: { linqPhone: '+15550009999' } })),
  httpsCallable: vi.fn((_name: string) => hoisted.createWebOnboardingSession),
  getOrCreateRecaptchaVerifier: vi.fn(() => ({ verify: vi.fn() })),
  clearRecaptchaVerifier: vi.fn(),
}));

vi.mock('../../../lib/firebase', () => ({
  auth: { signInWithPhoneNumber: hoisted.signInWithPhoneNumber },
  functions: { httpsCallable: hoisted.httpsCallable },
  getOrCreateRecaptchaVerifier: hoisted.getOrCreateRecaptchaVerifier,
  clearRecaptchaVerifier: hoisted.clearRecaptchaVerifier,
}));

vi.mock('react-router-dom', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock('../../../hooks/useDeviceClass', () => ({ useDeviceClass: () => 'desktop' }));
vi.mock('../../../hooks/useOnboardingSession', () => ({
  useOnboardingSession: () => ({ status: 'awaiting_inbound' }),
}));
vi.mock('./QRHandoff', () => ({
  QRHandoff: () => <div data-testid="qr-handoff" />,
}));
vi.mock('./MobileHandoff', () => ({
  MobileHandoff: () => <div data-testid="mobile-handoff" />,
}));
vi.mock('../../../utils/launchConfig', () => ({ supportPhone: null }));
vi.mock('../../ui/BloomMark', () => ({
  BloomMark: () => <svg data-testid="bloom" />,
}));

import { OnboardingFlow } from './OnboardingFlow';

const CARE_TYPE_HEADING = 'Who is this care for?';

async function driveConsentThroughVerify() {
  // Consent screen
  fireEvent.click(screen.getByRole('checkbox'));
  await act(async () => { fireEvent.click(screen.getByText('Continue')); });
  // Name step
  fireEvent.change(screen.getByPlaceholderText('Your first name'), { target: { value: 'Alex' } });
  await act(async () => { fireEvent.click(screen.getByText('Continue')); });
  // Phone step
  fireEvent.change(screen.getByPlaceholderText('(555) 555-5555'), { target: { value: '4085551234' } });
  await act(async () => { fireEvent.click(screen.getByText(/Send code/)); });
  // Verify step
  fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '123456' } });
  await act(async () => { fireEvent.click(screen.getByText('Verify')); });
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.signInWithPhoneNumber.mockResolvedValue({ confirm: hoisted.confirm });
  hoisted.confirm.mockResolvedValue({ user: { uid: 'u1' } });
  hoisted.createWebOnboardingSession.mockResolvedValue({ data: { linqPhone: '+15550009999' } });
  hoisted.httpsCallable.mockReturnValue(hoisted.createWebOnboardingSession);
});

describe('OnboardingFlow — senior parity (no childcare entry)', () => {
  it('client flow never shows the care-type step and sends the exact legacy payload keys', async () => {
    render(<OnboardingFlow />);
    fireEvent.click(screen.getByText('Find a caregiver'));
    // Straight to consent — the childcare step must not exist.
    expect(screen.queryByText(CARE_TYPE_HEADING)).toBeNull();
    expect(screen.getByText(/what happens next/i)).toBeTruthy();

    await driveConsentThroughVerify();

    expect(hoisted.createWebOnboardingSession).toHaveBeenCalledTimes(1);
    const payload = hoisted.createWebOnboardingSession.mock.calls[0][0];
    // EXACT key set — proves the payload is byte-identical in shape to the
    // pre-childcare senior flow (no additive careVertical key).
    expect(Object.keys(payload).sort()).toEqual(
      ['consentText', 'name', 'phone', 'referralId', 'role'].sort(),
    );
    expect(payload.role).toBe('client');
    expect('careVertical' in payload).toBe(false);
  });

  it('caregiver flow never shows the care-type step and sends no careVertical', async () => {
    render(<OnboardingFlow />);
    fireEvent.click(screen.getByText(/I(’|')m a caregiver/));
    expect(screen.queryByText(CARE_TYPE_HEADING)).toBeNull();

    await driveConsentThroughVerify();

    const payload = hoisted.createWebOnboardingSession.mock.calls[0][0];
    expect(payload.role).toBe('caregiver');
    expect('careVertical' in payload).toBe(false);
  });

  it('initialRole=client (role param) skips role AND care-type — consent first', () => {
    render(<OnboardingFlow initialRole="client" />);
    expect(screen.queryByText(CARE_TYPE_HEADING)).toBeNull();
    expect(screen.getByText(/what happens next/i)).toBeTruthy();
  });
});

// ── Front door Stage 1: ?vertical=child is an ANSWER, not a prompt ───────────
//
// DELIBERATE CHANGE from U4. U4 used the deep link to REVEAL the care-type
// question; Stage 1 asks that question organically instead, so a person who
// arrived via /start?vertical=child has already told us and must not be asked
// again. The link's outcome is unchanged and still pinned below: careVertical
// 'child' on the payload, and the step never rendered.
describe('OnboardingFlow — childcare deep link (?vertical=child) pre-answers the question', () => {
  it('client role: skips the care-type step and still stamps careVertical', async () => {
    render(<OnboardingFlow childcareEntry />);
    fireEvent.click(screen.getByText('Find a caregiver'));
    expect(screen.queryByText(CARE_TYPE_HEADING)).toBeNull();

    await driveConsentThroughVerify();

    const payload = hoisted.createWebOnboardingSession.mock.calls[0][0];
    expect(payload.careVertical).toBe('child');
    expect(payload.role).toBe('client');
  });

  it('caregiver role: the deep link now reaches childcare too (the role gate is gone)', async () => {
    render(<OnboardingFlow childcareEntry />);
    fireEvent.click(screen.getByText(/I(’|')m a caregiver/));
    expect(screen.queryByText(CARE_TYPE_HEADING)).toBeNull();

    await driveConsentThroughVerify();

    const payload = hoisted.createWebOnboardingSession.mock.calls[0][0];
    expect(payload.role).toBe('caregiver');
    expect(payload.careVertical).toBe('child');
  });

  it('initialRole=client with the entry param goes straight to consent', () => {
    render(<OnboardingFlow initialRole="client" childcareEntry />);
    expect(screen.queryByText(CARE_TYPE_HEADING)).toBeNull();
    expect(screen.getByText(/what happens next/i)).toBeTruthy();
  });
});

// ── Front door Stage 1: the organic "what kind of care?" step ────────────────
describe('OnboardingFlow — organic arrival asks the care type (askCareType)', () => {
  const CAREGIVER_CARE_TYPE_HEADING = 'What kind of care do you provide?';

  it('client: asks the question, and picking the older adult sends the EXACT legacy payload keys', async () => {
    render(<OnboardingFlow askCareType />);
    fireEvent.click(screen.getByText('Find a caregiver'));
    expect(screen.getByText(CARE_TYPE_HEADING)).toBeTruthy();
    fireEvent.click(screen.getByText('An older adult'));

    await driveConsentThroughVerify();

    const payload = hoisted.createWebOnboardingSession.mock.calls[0][0];
    // Senior parity DOWNSTREAM of the new question: byte-identical key set.
    expect(Object.keys(payload).sort()).toEqual(
      ['consentText', 'name', 'phone', 'referralId', 'role'].sort(),
    );
    expect('careVertical' in payload).toBe(false);
  });

  it('client: picking children stamps careVertical', async () => {
    render(<OnboardingFlow askCareType />);
    fireEvent.click(screen.getByText('Find a caregiver'));
    fireEvent.click(screen.getByText('My children'));

    await driveConsentThroughVerify();

    const payload = hoisted.createWebOnboardingSession.mock.calls[0][0];
    expect(payload.careVertical).toBe('child');
    expect(payload.role).toBe('client');
  });

  it('caregiver: asks with caregiver-framed copy and can reach childcare (Stage 1 unblock)', async () => {
    render(<OnboardingFlow askCareType />);
    fireEvent.click(screen.getByText(/I(’|')m a caregiver/));
    expect(screen.getByText(CAREGIVER_CARE_TYPE_HEADING)).toBeTruthy();
    fireEvent.click(screen.getByText('Children'));

    await driveConsentThroughVerify();

    const payload = hoisted.createWebOnboardingSession.mock.calls[0][0];
    expect(payload.role).toBe('caregiver');
    expect(payload.careVertical).toBe('child');
  });

  it('caregiver: picking older adults keeps the senior payload byte-identical', async () => {
    render(<OnboardingFlow askCareType />);
    fireEvent.click(screen.getByText(/I(’|')m a caregiver/));
    fireEvent.click(screen.getByText('Older adults'));

    await driveConsentThroughVerify();

    const payload = hoisted.createWebOnboardingSession.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(
      ['consentText', 'name', 'phone', 'referralId', 'role'].sort(),
    );
    expect('careVertical' in payload).toBe(false);
  });

  it('initialRole + askCareType starts ON the care-type step (role already answered)', () => {
    render(<OnboardingFlow initialRole="client" askCareType />);
    expect(screen.getByText(CARE_TYPE_HEADING)).toBeTruthy();
  });

  it('the deep link WINS over askCareType — an answered vertical is never re-asked', () => {
    render(<OnboardingFlow initialRole="client" askCareType childcareEntry />);
    expect(screen.queryByText(CARE_TYPE_HEADING)).toBeNull();
  });
});

// ── Front door Stage 2 (deliverable 7): the flags-off fall-through ────────────
//
// THE BUG. createWebOnboardingSession never writes the authoritative
// `careVertical` stamp while the childcare flags are off (correct — fail closed),
// and the web flow then continued straight to the SMS handoff. Texting Evia at
// that point started SENIOR onboarding — so a person who had explicitly picked
// childcare was silently re-routed, while the SMS path for the same intent
// reached an explicit waitlist.
//
// THE FIX. The callable now returns `childcareAvailable`, and `false` lands on an
// explicit terminal unavailable/waitlist screen. Senior responses never carry the
// field, so the senior path is untouched — pinned by the last row here.
describe('OnboardingFlow — Stage 2: childcare picked while childcare is OFF', () => {
  const UNAVAILABLE_HEADING = /Childcare isn(’|')t open here yet/;

  it('client: childcareAvailable:false reaches the explicit waitlist screen, NOT the SMS handoff', async () => {
    hoisted.createWebOnboardingSession.mockResolvedValue({
      data: { linqPhone: '+15550009999', childcareAvailable: false },
    });
    render(<OnboardingFlow askCareType />);
    fireEvent.click(screen.getByText('Find a caregiver'));
    fireEvent.click(screen.getByText('My children'));

    await driveConsentThroughVerify();

    expect(screen.getByText(UNAVAILABLE_HEADING)).toBeTruthy();
    expect(screen.getByText(/we'?ll text you the moment it opens up/i)).toBeTruthy();
    // The senior fall-through is gone: no SMS handoff is offered, because
    // texting Evia is exactly what used to start senior onboarding.
    expect(screen.queryByTestId('qr-handoff')).toBeNull();
    expect(screen.queryByTestId('mobile-handoff')).toBeNull();
  });

  it('caregiver: the same explicit state, with caregiver-framed copy', async () => {
    hoisted.createWebOnboardingSession.mockResolvedValue({
      data: { linqPhone: '+15550009999', childcareAvailable: false },
    });
    render(<OnboardingFlow askCareType />);
    fireEvent.click(screen.getByText(/I(’|')m a caregiver/));
    fireEvent.click(screen.getByText('Children'));

    await driveConsentThroughVerify();

    expect(screen.getByText(UNAVAILABLE_HEADING)).toBeTruthy();
    expect(screen.getByText(/childcare caregivers in your area/i)).toBeTruthy();
    expect(screen.queryByTestId('qr-handoff')).toBeNull();
  });

  it('childcareAvailable:true continues to the normal handoff', async () => {
    hoisted.createWebOnboardingSession.mockResolvedValue({
      data: { linqPhone: '+15550009999', childcareAvailable: true },
    });
    render(<OnboardingFlow askCareType />);
    fireEvent.click(screen.getByText('Find a caregiver'));
    fireEvent.click(screen.getByText('My children'));

    await driveConsentThroughVerify();

    expect(screen.queryByText(UNAVAILABLE_HEADING)).toBeNull();
    expect(screen.getByTestId('qr-handoff')).toBeTruthy();
  });

  it('SENIOR PARITY: the field is absent for a senior signup, so the handoff is unchanged', async () => {
    // Exactly the pre-Stage-2 response shape.
    hoisted.createWebOnboardingSession.mockResolvedValue({ data: { linqPhone: '+15550009999' } });
    render(<OnboardingFlow askCareType />);
    fireEvent.click(screen.getByText('Find a caregiver'));
    fireEvent.click(screen.getByText('An older adult'));

    await driveConsentThroughVerify();

    expect(screen.queryByText(UNAVAILABLE_HEADING)).toBeNull();
    expect(screen.getByTestId('qr-handoff')).toBeTruthy();
  });
});
