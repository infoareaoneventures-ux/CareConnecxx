// Pure: can this caregiver work right now — ONE rule (founder, 2026-10-11):
// membership active per caregiverAccessGate (active / trialing / the Stripe
// retry states past_due + payment_failed / legacy membershipPaid with no status)
// AND the background check cleared. Read by the lock release
// (triggers/caregiverAccountEvents.ts), the renewal sweep and the daily shift
// generator (scheduled/shiftGenerator.ts, caregiver sweep C17). Dependency-free
// so a scheduled job can import it without the trigger builders.
import { isCaregiverMembershipActiveForFamilies } from "./caregiverEligibility";

type Doc = Record<string, any>;

export function canWork(d: Doc | undefined): boolean {
  if (!d) return false;
  const bgOk = d.verified === true || d.backgroundCheckStatus === "clear" || d.backgroundCheckComplete === true;
  return bgOk && isCaregiverMembershipActiveForFamilies(d);
}

/** Pure: did this change lock the caregiver (working → not working)? */
export function lockedNow(before: Doc | undefined, after: Doc | undefined): boolean {
  return canWork(before) && !canWork(after);
}
