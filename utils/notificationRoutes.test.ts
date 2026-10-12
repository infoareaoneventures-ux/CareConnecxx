import { describe, it, expect } from 'vitest';
import { routeForNotification } from './notificationRoutes';

// The bell lands on the page its body names — sweep C10 (2026-10-11). Evia's twin
// (functions/src/agents/notificationsPage.ts) mirrors this map path for path; its
// test compiles this file and asserts parity, so a change here changes both.
// Every type below is one the server writes to a caregiver (notificationTriggers.ts,
// newJobNotice.ts, shiftHours.ts, caregiverTimesheetReminders.ts, shiftEndReminder.ts,
// payoutCommon.ts, stripeConnectWebhook.ts, caregiverAccountEvents.ts, index.ts,
// staleSessionNudge.ts, interviewLinkTrigger.ts).
const CAREGIVER_CASES: Array<[Record<string, unknown>, string]> = [
  // Jobs
  [{ type: 'new_job', data: { jobId: 'j1' } }, '/caregiver/jobs?job=j1'],
  [{ type: 'new_job' }, '/caregiver/jobs'],
  [{ type: 'job_application_accepted', data: { applicationId: 'a1', jobId: 'j1' } }, '/caregiver/jobs?tab=applications'],
  [{ type: 'job_application_declined' }, '/caregiver/jobs?tab=applications'],
  [{ type: 'interview_request' }, '/caregiver/jobs?tab=interviews'],
  [{ type: 'interview_accepted' }, '/caregiver/jobs?tab=interviews'],
  [{ type: 'interview_declined' }, '/caregiver/jobs?tab=interviews'],
  [{ type: 'interview_rescheduled' }, '/caregiver/jobs?tab=interviews'],
  [{ type: 'interview_cancelled' }, '/caregiver/jobs?tab=interviews'],
  [{ type: 'interview_reminder' }, '/caregiver/jobs?tab=interviews'],
  [{ type: 'hire_decision' }, '/caregiver/jobs?tab=interviews'],
  // Bookings › Requests
  [{ type: 'booking_request', data: { bookingId: 'b1' } }, '/caregiver/bookings?tab=requests'],
  [{ type: 'booking_cancelled' }, '/caregiver/bookings?tab=requests'],
  [{ type: 'amendment_request' }, '/caregiver/bookings?tab=requests'],
  [{ type: 'amendment_cancelled' }, '/caregiver/bookings?tab=requests'],
  [{ type: 'booking', transitionType: 'booking_confirmed' }, '/caregiver/bookings?tab=requests'],
  // Bookings › Active (the visit itself when the bell carries it)
  [{ type: 'shift_rescheduled', data: { shiftId: 's1' } }, '/caregiver/bookings?tab=active&visit=s1'],
  [{ type: 'shift_cancelled', data: { shiftId: 's1' } }, '/caregiver/bookings?tab=active&visit=s1'],
  [{ type: 'shift_started' }, '/caregiver/bookings?tab=active'],
  [{ type: 'shift_needs_replacement' }, '/caregiver/bookings?tab=active'],
  [{ type: 'shift_end_reminder', data: { shiftId: 's1' } }, '/caregiver/bookings?tab=active&visit=s1'],
  [{ type: 'alert', transitionType: 'shift_cancelled_by_client', data: { appointmentId: 'a1' } }, '/caregiver/bookings?tab=active'],
  // Bookings › Past (finished, or never started — Log Hours lives there)
  [{ type: 'shift_completed', data: { shiftId: 's1' } }, '/caregiver/bookings?tab=past'],
  [{ type: 'shift_missed', data: { shiftId: 's1' } }, '/caregiver/bookings?tab=past'],
  // Payments
  [{ type: 'shift_hours_approved' }, '/caregiver/payments?tab=timesheets'],
  [{ type: 'shift_hours_auto_approved' }, '/caregiver/payments?tab=timesheets'],
  [{ type: 'shift_hours_admin_review' }, '/caregiver/payments?tab=timesheets'],
  [{ type: 'shift_hours_paid' }, '/caregiver/payments?tab=timesheets'],
  [{ type: 'shift_hours_payment_failed' }, '/caregiver/payments?tab=timesheets'],
  [{ type: 'shift_hours_unsubmitted' }, '/caregiver/payments?tab=timesheets'],
  [{ type: 'shift_hours_correction_reminder' }, '/caregiver/payments?tab=timesheets'],
  [{ type: 'payout_initiated' }, '/caregiver/payments?tab=payouts'],
  [{ type: 'payout_paid' }, '/caregiver/payments?tab=payouts'],
  [{ type: 'payout_failed' }, '/caregiver/payments?tab=payouts'],
  [{ type: 'caregiver_payouts_enabled' }, '/caregiver/payments?tab=payouts'],
  [{ type: 'caregiver_payouts_disabled' }, '/caregiver/payments?tab=payouts'],
  // Settings › Membership & verification
  [{ type: 'caregiver_membership_paid' }, '/caregiver/settings'],
  [{ type: 'caregiver_membership_renewed' }, '/caregiver/settings'],
  [{ type: 'caregiver_membership_payment_failed' }, '/caregiver/settings'],
  [{ type: 'caregiver_membership_cancel_scheduled' }, '/caregiver/settings'],
  [{ type: 'caregiver_membership_reactivated' }, '/caregiver/settings'],
  [{ type: 'caregiver_membership_cancelled' }, '/caregiver/settings'],
  [{ type: 'caregiver_membership_revoked' }, '/caregiver/settings'],
  [{ type: 'caregiver_membership_renewal_upcoming' }, '/caregiver/settings'],
  [{ type: 'membership_payment_failed' }, '/caregiver/settings'],
  [{ type: 'membership_cancelled' }, '/caregiver/settings'],
  [{ type: 'caregiver_bgcheck_consent_received' }, '/caregiver/settings'],
  [{ type: 'caregiver_bgcheck_clear' }, '/caregiver/settings'],
  [{ type: 'caregiver_bgcheck_review' }, '/caregiver/settings'],
  [{ type: 'caregiver_bgcheck_on_hold' }, '/caregiver/settings'],
  [{ type: 'caregiver_bgcheck_disputed' }, '/caregiver/settings'],
  [{ type: 'caregiver_bgcheck_canceled' }, '/caregiver/settings'],
  [{ type: 'caregiver_bgcheck_action_required' }, '/caregiver/settings'],
  [{ type: 'caregiver_bgcheck_not_approved' }, '/caregiver/settings'],
  [{ type: 'caregiver_bgcheck_document_required' }, '/caregiver/settings'],
  [{ type: 'caregiver_bgcheck_link_expired' }, '/caregiver/settings'],
  [{ type: 'caregiver_bgcheck_revoked' }, '/caregiver/settings'],
  [{ type: 'caregiver_mvr_clear' }, '/caregiver/settings'],
  [{ type: 'caregiver_mvr_review' }, '/caregiver/settings'],
  [{ type: 'caregiver_mvr_not_approved' }, '/caregiver/settings'],
  [{ type: 'caregiver_mvr_consent_requested' }, '/caregiver/settings'],
  [{ type: 'caregiver_mvr_check_started' }, '/caregiver/settings'],
  [{ type: 'caregiver_transport_badge_earned' }, '/caregiver/settings'],
  [{ type: 'caregiver_transport_badge_lost' }, '/caregiver/settings'],
  [{ type: 'caregiver_renewal_refresh_reminder' }, '/caregiver/settings'],
  [{ type: 'caregiver_renewal_refresh_locked' }, '/caregiver/settings'],
  [{ type: 'account_update' }, '/caregiver/settings'],
  // Elsewhere
  [{ type: 'caregiver_now_bookable' }, '/caregiver/jobs'],
  [{ type: 'review_received' }, '/caregiver/profile?section=reviews'],
  [{ type: 'onboarding_reminder', data: { step: 'caregiver_ask_bio' } }, '/caregiver/dashboard'],
  [{ type: 'system' }, '/caregiver/dashboard'],
  [{ type: 'alert' }, '/caregiver/dashboard'],
  [{}, '/caregiver/dashboard'],
];

describe('routeForNotification — every caregiver bell lands on the page its body names', () => {
  it.each(CAREGIVER_CASES)('%j → %s', (n, expected) => {
    expect(routeForNotification(n as any, 'caregiver')).toBe(expected);
  });
  it('no caregiver bell that names a page falls through to the dashboard', () => {
    const named = ['new_job', 'job_application_accepted', 'caregiver_membership_paid', 'caregiver_bgcheck_clear', 'caregiver_mvr_review', 'caregiver_renewal_refresh_locked', 'shift_rescheduled', 'booking_request', 'amendment_request', 'payout_paid'];
    for (const type of named) expect(routeForNotification({ type }, 'caregiver')).not.toBe('/caregiver/dashboard');
  });
  it('membership never goes to Payments (the card moved to Settings 2026-10-04)', () => {
    for (const type of ['caregiver_membership_paid', 'caregiver_membership_payment_failed', 'membership_cancelled']) {
      expect(routeForNotification({ type }, 'caregiver')).not.toContain('/caregiver/payments');
    }
  });
});

describe('routeForNotification — the family map is unchanged', () => {
  const CLIENT_CASES: Array<[Record<string, unknown>, string]> = [
    [{ type: 'review_prompt', data: { caregiverId: 'cg1' } }, '/client/caregiver/cg1?review=1'],
    [{ type: 'job_application' }, '/client/posts'],
    [{ type: 'interview_accepted' }, '/client/posts?tab=interviews'],
    [{ type: 'booking_declined' }, '/client/find-caregivers'],
    [{ type: 'shift_hours_approved' }, '/client/payments'],
    [{ type: 'shift_completed' }, '/client/bookings?tab=past'],
    [{ type: 'amendment_request' }, '/client/bookings?tab=requests'],
    [{ type: 'shift_cancelled' }, '/client/bookings?tab=active'],
    [{ type: 'alert', transitionType: 'shift_cancelled_by_caregiver', data: { appointmentId: 'a1' } }, '/client/bookings?tab=active'],
    [{ type: 'membership_payment_failed' }, '/client/membership'],
    [{ type: 'payment_received' }, '/client/payments'],
    [{ type: 'system' }, '/client/dashboard'],
  ];
  it.each(CLIENT_CASES)('%j → %s', (n, expected) => {
    expect(routeForNotification(n as any, 'client')).toBe(expected);
  });
});
