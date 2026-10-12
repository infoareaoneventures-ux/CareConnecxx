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
  [{ type: 'new_job', data: { jobId: 'j1' } }, '/care-provider/jobs?job=j1'],
  [{ type: 'new_job' }, '/care-provider/jobs'],
  [{ type: 'job_application_accepted', data: { applicationId: 'a1', jobId: 'j1' } }, '/care-provider/jobs?tab=applications'],
  [{ type: 'job_application_declined' }, '/care-provider/jobs?tab=applications'],
  [{ type: 'interview_request' }, '/care-provider/jobs?tab=interviews'],
  [{ type: 'interview_accepted' }, '/care-provider/jobs?tab=interviews'],
  [{ type: 'interview_declined' }, '/care-provider/jobs?tab=interviews'],
  [{ type: 'interview_rescheduled' }, '/care-provider/jobs?tab=interviews'],
  [{ type: 'interview_cancelled' }, '/care-provider/jobs?tab=interviews'],
  [{ type: 'interview_reminder' }, '/care-provider/jobs?tab=interviews'],
  [{ type: 'hire_decision' }, '/care-provider/jobs?tab=interviews'],
  // Bookings › Requests
  [{ type: 'booking_request', data: { bookingId: 'b1' } }, '/care-provider/bookings?tab=requests'],
  [{ type: 'booking_cancelled' }, '/care-provider/bookings?tab=requests'],
  [{ type: 'amendment_request' }, '/care-provider/bookings?tab=requests'],
  [{ type: 'amendment_cancelled' }, '/care-provider/bookings?tab=requests'],
  [{ type: 'booking', transitionType: 'booking_confirmed' }, '/care-provider/bookings?tab=requests'],
  // Bookings › Active (the visit itself when the bell carries it)
  [{ type: 'shift_rescheduled', data: { shiftId: 's1' } }, '/care-provider/bookings?tab=active&visit=s1'],
  [{ type: 'shift_cancelled', data: { shiftId: 's1' } }, '/care-provider/bookings?tab=active&visit=s1'],
  [{ type: 'shift_started' }, '/care-provider/bookings?tab=active'],
  [{ type: 'shift_needs_replacement' }, '/care-provider/bookings?tab=active'],
  [{ type: 'shift_end_reminder', data: { shiftId: 's1' } }, '/care-provider/bookings?tab=active&visit=s1'],
  [{ type: 'alert', transitionType: 'shift_cancelled_by_client', data: { appointmentId: 'a1' } }, '/care-provider/bookings?tab=active'],
  // Bookings › Past (finished, or never started — Log Hours lives there)
  [{ type: 'shift_completed', data: { shiftId: 's1' } }, '/care-provider/bookings?tab=past'],
  [{ type: 'shift_missed', data: { shiftId: 's1' } }, '/care-provider/bookings?tab=past'],
  // Payments
  [{ type: 'shift_hours_approved' }, '/care-provider/payments?tab=timesheets'],
  [{ type: 'shift_hours_auto_approved' }, '/care-provider/payments?tab=timesheets'],
  [{ type: 'shift_hours_admin_review' }, '/care-provider/payments?tab=timesheets'],
  [{ type: 'shift_hours_paid' }, '/care-provider/payments?tab=timesheets'],
  [{ type: 'shift_hours_payment_failed' }, '/care-provider/payments?tab=timesheets'],
  [{ type: 'shift_hours_unsubmitted' }, '/care-provider/payments?tab=timesheets'],
  [{ type: 'shift_hours_correction_reminder' }, '/care-provider/payments?tab=timesheets'],
  [{ type: 'payout_initiated' }, '/care-provider/payments?tab=payouts'],
  [{ type: 'payout_paid' }, '/care-provider/payments?tab=payouts'],
  [{ type: 'payout_failed' }, '/care-provider/payments?tab=payouts'],
  [{ type: 'caregiver_payouts_enabled' }, '/care-provider/payments?tab=payouts'],
  [{ type: 'caregiver_payouts_disabled' }, '/care-provider/payments?tab=payouts'],
  // Settings › Membership & verification
  [{ type: 'caregiver_membership_paid' }, '/care-provider/settings'],
  [{ type: 'caregiver_membership_renewed' }, '/care-provider/settings'],
  [{ type: 'caregiver_membership_payment_failed' }, '/care-provider/settings'],
  [{ type: 'caregiver_membership_cancel_scheduled' }, '/care-provider/settings'],
  [{ type: 'caregiver_membership_reactivated' }, '/care-provider/settings'],
  [{ type: 'caregiver_membership_cancelled' }, '/care-provider/settings'],
  [{ type: 'caregiver_membership_revoked' }, '/care-provider/settings'],
  [{ type: 'caregiver_membership_renewal_upcoming' }, '/care-provider/settings'],
  [{ type: 'membership_payment_failed' }, '/care-provider/settings'],
  [{ type: 'membership_cancelled' }, '/care-provider/settings'],
  [{ type: 'caregiver_bgcheck_consent_received' }, '/care-provider/settings'],
  [{ type: 'caregiver_bgcheck_clear' }, '/care-provider/settings'],
  [{ type: 'caregiver_bgcheck_review' }, '/care-provider/settings'],
  [{ type: 'caregiver_bgcheck_on_hold' }, '/care-provider/settings'],
  [{ type: 'caregiver_bgcheck_disputed' }, '/care-provider/settings'],
  [{ type: 'caregiver_bgcheck_canceled' }, '/care-provider/settings'],
  [{ type: 'caregiver_bgcheck_action_required' }, '/care-provider/settings'],
  [{ type: 'caregiver_bgcheck_not_approved' }, '/care-provider/settings'],
  [{ type: 'caregiver_bgcheck_document_required' }, '/care-provider/settings'],
  [{ type: 'caregiver_bgcheck_link_expired' }, '/care-provider/settings'],
  [{ type: 'caregiver_bgcheck_revoked' }, '/care-provider/settings'],
  [{ type: 'caregiver_mvr_clear' }, '/care-provider/settings'],
  [{ type: 'caregiver_mvr_review' }, '/care-provider/settings'],
  [{ type: 'caregiver_mvr_not_approved' }, '/care-provider/settings'],
  [{ type: 'caregiver_mvr_consent_requested' }, '/care-provider/settings'],
  [{ type: 'caregiver_mvr_check_started' }, '/care-provider/settings'],
  [{ type: 'caregiver_transport_badge_earned' }, '/care-provider/settings'],
  [{ type: 'caregiver_transport_badge_lost' }, '/care-provider/settings'],
  [{ type: 'caregiver_renewal_refresh_reminder' }, '/care-provider/settings'],
  [{ type: 'caregiver_renewal_refresh_locked' }, '/care-provider/settings'],
  [{ type: 'account_update' }, '/care-provider/settings'],
  // Elsewhere
  [{ type: 'caregiver_now_bookable' }, '/care-provider/jobs'],
  [{ type: 'review_received' }, '/care-provider/profile?section=reviews'],
  [{ type: 'onboarding_reminder', data: { step: 'caregiver_ask_bio' } }, '/care-provider/dashboard'],
  [{ type: 'system' }, '/care-provider/dashboard'],
  [{ type: 'alert' }, '/care-provider/dashboard'],
  [{}, '/care-provider/dashboard'],
];

describe('routeForNotification — every caregiver bell lands on the page its body names', () => {
  it.each(CAREGIVER_CASES)('%j → %s', (n, expected) => {
    expect(routeForNotification(n as any, 'caregiver')).toBe(expected);
  });
  it('no caregiver bell that names a page falls through to the dashboard', () => {
    const named = ['new_job', 'job_application_accepted', 'caregiver_membership_paid', 'caregiver_bgcheck_clear', 'caregiver_mvr_review', 'caregiver_renewal_refresh_locked', 'shift_rescheduled', 'booking_request', 'amendment_request', 'payout_paid'];
    for (const type of named) expect(routeForNotification({ type }, 'caregiver')).not.toBe('/care-provider/dashboard');
  });
  it('membership never goes to Payments (the card moved to Settings 2026-10-04)', () => {
    for (const type of ['caregiver_membership_paid', 'caregiver_membership_payment_failed', 'membership_cancelled']) {
      expect(routeForNotification({ type }, 'caregiver')).not.toContain('/care-provider/payments');
    }
  });
});

describe('routeForNotification — the family map is unchanged', () => {
  const CLIENT_CASES: Array<[Record<string, unknown>, string]> = [
    [{ type: 'review_prompt', data: { caregiverId: 'cg1' } }, '/client/care-provider/cg1?review=1'],
    [{ type: 'job_application' }, '/client/posts'],
    [{ type: 'interview_accepted' }, '/client/posts?tab=interviews'],
    [{ type: 'booking_declined' }, '/client/find-care-providers'],
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
