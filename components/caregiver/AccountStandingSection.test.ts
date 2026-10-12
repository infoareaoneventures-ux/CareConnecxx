import { describe, it, expect, vi } from 'vitest';

vi.mock('../BackgroundCheckModal', () => ({ BackgroundCheckModal: () => null }));
vi.mock('../../services/stripeService', () => ({ getSubscriptionStatus: vi.fn(), getCaregiverBillingPortalUrl: vi.fn() }));
vi.mock('../../hooks/useCaregiverGate', () => ({
  caregiverMembershipActive: (p: any) => ['active', 'trialing', 'past_due', 'payment_failed'].includes(p?.membershipStatus),
  caregiverMembershipPaymentFailed: (p: any) => ['past_due', 'payment_failed'].includes(p?.membershipStatus),
  MEMBERSHIP_PAYMENT_FAILED_NOTICE: 'notice',
  ADD_TRANSPORTATION_PATH: '/care-provider/profile?edit=services',
}));

import { backgroundCheckState, driverCardFor, DRIVER_CARD_TEXT } from './AccountStandingSection';

// Settings › Membership & verification — one state rule per card, shared with the
// dashboard and Evia's twin (functions/src/agents/caregiverMembership.ts).

describe('driverCardFor', () => {
  const docsOk = { services: ['Transportation'], documents: { driversLicense: { status: 'approved' }, insurance: { status: 'approved' }, registration: { status: 'approved' } } };
  it('cleared = Transportation live', () => {
    expect(driverCardFor({ ...docsOk, isApprovedDriver: true }, true)).toBe('approved');
    expect(driverCardFor({ ...docsOk, isApprovedDriver: true }, false)).toBe('approved'); // no documents behind Transportation (2026-10-06)
  });
  it("the admin's Revoked (consider) and a suspended report read as under review — the dashboard's state the card was missing", () => {
    expect(driverCardFor({ ...docsOk, isApprovedDriver: false, mvrStatus: 'consider' }, false)).toBe('review');
    expect(driverCardFor({ ...docsOk, mvrStatus: 'suspended' }, false)).toBe('review');
    expect(DRIVER_CARD_TEXT.review.body).toContain('Transportation is off your profile for now');
    // Founder, 2026-10-04: no follow-up promise to the caregiver — the team is alerted instead (admin_alerts mvr_review).
    for (const t of Object.values(DRIVER_CARD_TEXT)) expect(t.body).not.toMatch(/our team will/i);
  });
  it("the admin's final decision reads not approved, not under review", () => {
    expect(driverCardFor({ ...docsOk, isApprovedDriver: false, mvrStatus: 'not_approved' }, false)).toBe('not_approved');
    expect(DRIVER_CARD_TEXT.not_approved.body).toContain("Non-driving jobs aren't affected");
  });
  it('pending, included, offer', () => {
    expect(driverCardFor({ ...docsOk, mvrStatus: 'pending' }, false)).toBe('pending');
    expect(driverCardFor({ ...docsOk, mvrPaid: true, backgroundCheckData: { mvrIncluded: true } }, false)).toBe('pending'); // bundled report under way
    expect(driverCardFor({ ...docsOk, mvrPaid: true }, false)).toBe('included'); // paid, consent not given yet (2026-10-07)
    expect(driverCardFor({ services: ['Transportation'] }, false)).toBe('included');
    expect(driverCardFor({ services: ['Companionship'] }, false)).toBe('offer');
  });
  it('no approval words anywhere on the card', () => {
    for (const t of Object.values(DRIVER_CARD_TEXT)) expect(t.title + ' ' + t.body).not.toMatch(/approved driver|verified|badge/i);
  });
});

describe('backgroundCheckState', () => {
  it('membership active and nothing started → the Start button (the dashboard step rule); inactive → informational', () => {
    expect(backgroundCheckState({}, true)).toEqual({ kind: 'consent', renewal: false });
    expect(backgroundCheckState({}, false)).toEqual({ kind: 'not_started' });
    expect(backgroundCheckState({ backgroundCheckData: { consentRequired: true, consentReason: 'renewal' } }, true)).toEqual({ kind: 'consent', renewal: true });
    expect(backgroundCheckState({ backgroundCheckStatus: 'clear' }, true).kind).toBe('cleared');
  });
});
