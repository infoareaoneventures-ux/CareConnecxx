// One visit at a time (founder, 2026-10-07: "they shouldn't start two shifts at
// the same time"). A caregiver with a visit IN PROGRESS cannot start another one
// anywhere: the Bookings page, the Calendar, the home dashboard's today list and
// Evia's START all read this rule. Since 2026-10-11 this file is a UI
// convenience only — the rule is ENFORCED server-side in
// functions/src/shifts/visitActions.ts startVisit (reached by the site through
// services/visitActionQueue.ts and by Evia's START), which refuses with the same
// words. Finish (or the family's cancel) releases it.

export interface InProgressVisitLike { id: string; status?: string; clientName?: string }

/** The caregiver's OTHER visit that is in progress, if any — the one that must be finished before `shiftId` can start. */
export function otherVisitInProgress<T extends InProgressVisitLike>(visits: T[], shiftId: string): T | null {
  return visits.find((v) => v.status === 'in-progress' && v.id !== shiftId) ?? null;
}

export const FINISH_FIRST_LABEL = 'Finish your current visit first';

/** The button's tooltip / Evia's refusal: who the open visit is with. */
export function finishFirstText(other: { clientName?: string } | null): string {
  const who = other?.clientName?.trim();
  return who ? `Finish your visit with ${who} first.` : 'Finish your current visit first.';
}
