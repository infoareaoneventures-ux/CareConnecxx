// Where a bell notification takes you when clicked — ONE map for the whole
// site (components/ui/NotificationDropdown.tsx) and mirrored, path for path,
// in functions/src/agents/notificationsPage.ts so Evia names the same page.
// Audited 2026-09-19 against every type the server writes to families
// (functions/src/triggers/notificationTriggers.ts, appointmentUpdated.ts,
// notifications.ts, stripe.ts, agents/reviewPrompt.ts).
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
    if (t === 'review_prompt') return data.caregiverId ? `/client/caregiver/${data.caregiverId}?review=1` : '/client/dashboard';
    if (t === 'job_application') return '/client/posts';
    if (t.startsWith('interview') || t === 'hire_decision') return '/client/posts?tab=interviews';
    // A declined request is listed nowhere — the useful page is finding someone else.
    if (t === 'booking_declined' || tt === 'booking_declined') return '/client/find-caregivers';
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
  if (t.startsWith('interview') || t === 'hire_decision') return '/caregiver/jobs?tab=interviews';
  if (t.startsWith('booking') || t.startsWith('amendment') || t.startsWith('shift')) return '/caregiver/bookings';
  if (t.includes('payment') || t.includes('payout') || t.includes('membership')) return '/caregiver/payments';
  return '/caregiver/dashboard';
}
