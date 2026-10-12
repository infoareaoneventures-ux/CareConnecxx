// Where a bell notification takes you when clicked — ONE map for the whole
// site (components/ui/NotificationDropdown.tsx) and mirrored, path for path,
// in functions/src/agents/notificationsPage.ts so Evia names the same page
// (its test compiles this file and asserts parity — change both together).
// Family side audited 2026-09-19 against every type the server writes to
// families (functions/src/triggers/notificationTriggers.ts, appointmentUpdated.ts,
// notifications.ts, stripe.ts, agents/reviewPrompt.ts).
// Caregiver side re-routed 2026-10-11 (sweep C10) to the page each bell body
// names: Jobs (new_job / My Applications / Interviews), Bookings by tab
// (Requests for booking + amendment requests, Active for live visits, Past for
// finished ones), Payments by tab (Timesheets / Payouts), Settings ›
// Membership & verification for membership / background check / driving
// record / renewal, My Profile › Reviews for a review.
export type NotificationRole = 'client' | 'caregiver';

export interface RoutableNotification {
  type?: string;
  /** Set by writeUserNotification writers whose `type` is generic ('alert' / 'booking'). */
  transitionType?: string;
  data?: Record<string, any> | null;
}

export function routeForNotification(n: RoutableNotification, role: NotificationRole): string {
  const t = String(n.type || '');
  const tt = String(n.transitionType || '');
  const data = n.data || {};
  if (role === 'client') {
    // The first-visit review prompt → that caregiver's profile with the modal open.
    if (t === 'review_prompt') return data.caregiverId ? `/client/care-provider/${data.caregiverId}?review=1` : '/client/dashboard';
    if (t.startsWith('account')) return '/client/account';
    if (t === 'job_application') return '/client/posts';
    if (t.startsWith('interview') || t === 'hire_decision') return '/client/posts?tab=interviews';
    // A declined request is listed nowhere — the useful page is finding someone else.
    // Timesheets (submitted / approved / counter / auto-accepted / payment failed) live on Payments.
    if (t.startsWith('shift_hours')) return '/client/payments';
    if (t === 'booking_declined' || tt === 'booking_declined') return '/client/find-care-providers';
    // The finished visit's tasks, notes and hours live on the Past Bookings tab.
    if (t === 'shift_completed') return '/client/bookings?tab=past';
    // A schedule-change request still waiting → Requests tab; a decision on one → the live schedule.
    if (t === 'amendment_request') return '/client/bookings?tab=requests';
    if (t.startsWith('booking') || t.startsWith('amendment') || t.startsWith('shift')) return '/client/bookings?tab=active';
    // Legacy generic types carry the specifics in transitionType / data.
    if (t === 'alert' && (tt.startsWith('shift') || data.appointmentId || data.recurringGroupId)) return '/client/bookings?tab=active';
    if (t.includes('membership')) return '/client/membership';
    if (t.includes('payment')) return '/client/payments';
    return '/client/dashboard';
  }
  return caregiverRoute(t, tt, data);
}

// ── Caregiver ──────────────────────────────────────────────────────────────────
// Lifecycle bells (functions/src/notifications/caregiverAccountEvents.ts) are typed
// `caregiver_<kind>`: membership_*, bgcheck_*, mvr_*, transport_badge_*,
// renewal_refresh_*, membership_renewal_upcoming, payouts_*, now_bookable.
function caregiverRoute(t: string, tt: string, data: Record<string, any>): string {
  const shiftId = typeof data.shiftId === 'string' && data.shiftId ? data.shiftId : '';
  const active = shiftId ? `/care-provider/bookings?tab=active&visit=${shiftId}` : '/care-provider/bookings?tab=active';

  // Jobs page — the job card itself, My Applications, Interviews.
  if (t === 'new_job') return typeof data.jobId === 'string' && data.jobId ? `/care-provider/jobs?job=${data.jobId}` : '/care-provider/jobs';
  if (t.startsWith('job_application')) return '/care-provider/jobs?tab=applications';
  if (t.startsWith('interview') || t === 'hire_decision') return '/care-provider/jobs?tab=interviews';

  // Payments — Timesheets events (submitted / approved / correction / paid / reminders) and payouts.
  if (t.startsWith('shift_hours')) return '/care-provider/payments?tab=timesheets';
  if (t.includes('payout')) return '/care-provider/payments?tab=payouts';

  // Bookings — a request waiting on the caregiver (or withdrawn) → Requests; a finished or
  // unfinished-past visit → Past (Log Hours lives there); every live-visit event → Active.
  if (t.startsWith('booking') || t.startsWith('amendment')) return '/care-provider/bookings?tab=requests';
  if (t === 'shift_completed' || t === 'shift_missed') return '/care-provider/bookings?tab=past';
  if (t.startsWith('shift')) return active;
  if (t === 'alert' && (tt.startsWith('shift') || data.appointmentId || data.recurringGroupId)) return active;

  // Settings › Membership & verification — membership, background check, driving record,
  // renewal refresh, Transportation live/removed, account standing (the cards moved there 2026-10-04).
  if (t.includes('membership') || t.includes('bgcheck') || t.includes('mvr') || t.includes('renewal') || t.includes('transport_badge') || t.startsWith('account')) return '/care-provider/settings';
  // "You're approved — families can now find and book you" → the Jobs page.
  if (t === 'caregiver_now_bookable') return '/care-provider/jobs';

  // A new review lives on the caregiver's own profile page (Reviews card) — it used to fall through to the dashboard (2026-10-07).
  if (t === 'review_received') return '/care-provider/profile?section=reviews';
  // onboarding_reminder ("pick up on your dashboard") and anything unknown → the dashboard.
  return '/care-provider/dashboard';
}
