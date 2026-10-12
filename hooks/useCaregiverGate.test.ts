import { describe, it, expect, vi } from 'vitest';

vi.mock('../context/CareConnexContext', () => ({ useCareConnex: () => ({}) }));
vi.mock('../services/api', () => ({ dbService: {} }));
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }));

import { caregiverBlockReasonFor, caregiverMembershipActive, isMembershipActive, caregiverMembershipPaymentFailed } from './useCaregiverGate';

// ONE membership rule everywhere (founder, 2026-10-11): active / trialing / Stripe's retry
// state (past_due / payment_failed) / legacy membershipPaid with no status. The dashboard
// progress card, Settings › Membership & verification and the membership checkout all
// import this — a failed renewal charge is a notice, never a wall or a second checkout.
describe('caregiverMembershipActive — the one rule', () => {
  it('active, trialing and the retry state count as active; legacy membershipPaid too', () => {
    for (const s of ['active', 'trialing', 'past_due', 'payment_failed']) expect(caregiverMembershipActive({ membershipStatus: s })).toBe(true);
    expect(caregiverMembershipActive({ membershipPaid: true })).toBe(true);
    expect(isMembershipActive).toBe(caregiverMembershipActive);
  });
  it('canceled, unpaid, incomplete, inactive and nothing do not', () => {
    for (const s of ['canceled', 'unpaid', 'incomplete', 'inactive']) expect(caregiverMembershipActive({ membershipStatus: s, membershipPaid: true })).toBe(false);
    expect(caregiverMembershipActive({})).toBe(false);
    expect(caregiverMembershipActive(null)).toBe(false);
  });
  it('the retry state is the only "update your card" state', () => {
    expect(caregiverMembershipPaymentFailed({ membershipStatus: 'past_due' })).toBe(true);
    expect(caregiverMembershipPaymentFailed({ membershipStatus: 'payment_failed' })).toBe(true);
    expect(caregiverMembershipPaymentFailed({ membershipStatus: 'active' })).toBe(false);
    expect(caregiverMembershipPaymentFailed({ membershipStatus: 'canceled' })).toBe(false);
  });
});

// The Jobs page gate as a pure function — the same rule firestore.rules runs on
// the application write and Evia's caregiverAccessGate.ts runs before its own.
const active = { membershipStatus: 'active', backgroundCheckStatus: 'clear' };
const badge = {
  ...active,
  services: ['Transportation'],
  documents: { driversLicense: { status: 'approved' }, insurance: { status: 'approved' }, registration: { status: 'approved' } },
  isApprovedDriver: true,
};

describe('caregiverBlockReasonFor', () => {
  it('membership first, then background', () => {
    expect(caregiverBlockReasonFor({}, false)).toBe('membership');
    expect(caregiverBlockReasonFor({ membershipPaid: true }, false)).toBe('background');
    expect(caregiverBlockReasonFor(active, false)).toBeNull();
  });
  it('a driving job needs the badge; a revoked driving record takes it away even with approved documents', () => {
    expect(caregiverBlockReasonFor(badge, true)).toBeNull();
    expect(caregiverBlockReasonFor({ ...badge, isApprovedDriver: false }, true)).toBe('transport');
    expect(caregiverBlockReasonFor(active, true)).toBe('transport');
    expect(caregiverBlockReasonFor(badge, false)).toBeNull();
  });
});
