export type ShiftDisplayStatus =
  | 'overdue'
  | 'scheduled'
  | 'in-progress'
  | 'completed'
  | 'cancelled'
  | 'needs_replacement';

// Local calendar date (YYYY-MM-DD) — NOT UTC. Appointments store the local
// calendar date, so conflict checks must compare against the local date; using
// toISOString() (UTC) rolls to the next day for evening-local times and misses
// same-day conflicts. Exported for reuse (e.g. availabilityService).
export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timeToMins(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function shiftDisplayStatus(shift: {
  status: string;
  date: string;
  startTime?: string;
  endTime?: string;
}): ShiftDisplayStatus {
  // A caregiver-cancelled visit nobody covered ages out like any other: once its
  // window has passed it is Overdue, not "Needs Replacement" forever (live
  // 2026-09-20: a 1:30 PM visit still offered Find replacement at 2:49 PM).
  if (shift.status !== 'scheduled' && shift.status !== 'needs_replacement') return shift.status as ShiftDisplayStatus;

  const now = new Date();
  const todayStr = localDateStr(now);
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const startMins = timeToMins(shift.startTime || '00:00');
  const endMins = timeToMins(shift.endTime || '23:59');

  // For shifts crossing midnight (e.g. 11:45 PM → 12:00 AM), endMins < startMins.
  // Treat the effective end as endMins + 1440 so the shift isn't falsely overdue.
  const effectiveEndMins = endMins < startMins ? endMins + 1440 : endMins;
  if (shift.date < todayStr || (shift.date === todayStr && effectiveEndMins <= nowMins)) return 'overdue';
  return shift.status as ShiftDisplayStatus;
}

/** Tailwind classes for calendar event blocks */
export function shiftStatusBlockClass(status: ShiftDisplayStatus): string {
  switch (status) {
    case 'overdue':     return 'bg-orange-400 border-orange-500';
    case 'scheduled':   return 'bg-primary-500 border-primary-600';
    case 'in-progress': return 'bg-accent-500 border-accent-600';
    case 'completed':   return 'bg-slate-400 border-slate-500';
    case 'cancelled':   return 'bg-rose-600 border-rose-700';
    case 'needs_replacement': return 'bg-amber-500 border-amber-600';
    default:            return 'bg-slate-400 border-slate-500';
  }
}

/** Tailwind classes for status badge pills */
export function shiftStatusBadgeClass(status: ShiftDisplayStatus): string {
  switch (status) {
    case 'overdue':     return 'bg-orange-100 text-orange-700 border-orange-200';
    case 'scheduled':   return 'bg-primary-100 text-primary-700 border-primary-200';
    case 'in-progress': return 'bg-accent-100 text-accent-700 border-accent-200';
    case 'completed':   return 'bg-green-100 text-green-700 border-green-200';
    case 'cancelled':   return 'bg-rose-100 text-rose-700 border-rose-200';
    case 'needs_replacement': return 'bg-amber-100 text-amber-800 border-amber-200';
    default:            return 'bg-slate-100 text-slate-600 border-slate-200';
  }
}

/** Left-border dot color for list views */
export function shiftStatusDotClass(status: ShiftDisplayStatus): string {
  switch (status) {
    case 'overdue':     return 'bg-orange-400';
    case 'scheduled':   return 'bg-primary-500';
    case 'in-progress': return 'bg-accent-500';
    case 'completed':   return 'bg-slate-400';
    case 'cancelled':   return 'bg-rose-600';
    case 'needs_replacement': return 'bg-amber-500';
    default:            return 'bg-slate-400';
  }
}

export function shiftStatusLabel(status: ShiftDisplayStatus): string {
  switch (status) {
    case 'overdue':     return 'Overdue';
    case 'scheduled':   return 'Scheduled';
    case 'in-progress': return 'In Progress';
    case 'completed':   return 'Completed';
    case 'cancelled':   return 'Cancelled';
    case 'needs_replacement': return 'Needs Replacement';
    default:            return String(status);
  }
}
