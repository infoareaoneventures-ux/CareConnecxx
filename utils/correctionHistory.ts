// "Correction history: Accepted" appeared on a timesheet nobody had corrected: approving hours exactly as submitted
// writes an "accepted" entry (the audit trail), which the timeline then showed as if a correction had happened.
// The timeline only means something once someone actually proposed or countered a change.
export function realCorrection(action: unknown): boolean {
  return action !== 'submitted' && action !== 'accepted';
}
