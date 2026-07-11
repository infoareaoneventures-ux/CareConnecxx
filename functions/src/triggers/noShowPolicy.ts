/**
 * Pure decision logic for arrival capture and no-show replacement.
 *
 * Previously, a confirmed visit with no `arrivedAt` 20 minutes past its start
 * triggered emergency replacement immediately — so a caregiver who arrived on
 * time but forgot to text ARRIVED caused the family to be told their caregiver
 * "had to cancel." That false alarm is a direct hit to the peace-of-mind promise.
 *
 * New flow: at start + ARRIVAL_PING_AFTER_MIN with no arrival, Evia first texts
 * the caregiver a capture ping ("text ARRIVED so I can let the family know").
 * Emergency replacement only fires if that ping goes unanswered for
 * NO_SHOW_AFTER_PING_MIN — a ~10-minute delay on true no-shows, in exchange for
 * never falsely telling a family their caregiver cancelled.
 *
 * Kept pure so the timing gates are unit-tested without Firestore or the trigger
 * engine's surrounding scan.
 */

export const ARRIVAL_PING_AFTER_MIN = 10;   // send capture ping this long after start
export const NO_SHOW_AFTER_PING_MIN = 15;   // replace only if ping unanswered this long

export interface ArrivalCaptureInput {
  /** Scheduled shift start, ms. */
  startMs:              number;
  /** Caregiver has checked in (appointment has arrivedAt). */
  arrived:             boolean;
  /** When the capture ping was sent, ms. Null → not yet sent. */
  arrivalPingSentAtMs: number | null;
  /** Latest caregiver inbound to Evia, ms. Null → none. */
  lastInboundAtMs:     number | null;
  /**
   * A caregiver phone is resolvable, so a ping can actually be sent. When false
   * the ping step is skipped and a true no-show still escalates to replacement
   * once the combined ping + wait window has elapsed — otherwise an unreachable
   * caregiver would leave the decision stuck at "ping" forever and the family
   * would never hear about the no-show at all.
   */
  canPing:             boolean;
  nowMs:               number;
}

export type ArrivalCaptureDecision =
  | { action: "ping" }      // send the capture ping now
  | { action: "replace" }   // ping unanswered long enough — run emergency replacement
  | { action: "wait" }      // too early, or still inside a grace window
  | { action: "skip"; reason: string };

export function decideArrivalCapture(input: ArrivalCaptureInput): ArrivalCaptureDecision {
  const { startMs, arrived, arrivalPingSentAtMs, lastInboundAtMs, canPing, nowMs } = input;

  if (arrived) return { action: "skip", reason: "arrived" };

  const elapsedMin = (nowMs - startMs) / 60_000;

  // No ping possible (unresolvable caregiver phone): fall back to the plain
  // timeout — replacement once the ping + wait budget has fully elapsed.
  if (!canPing && arrivalPingSentAtMs === null) {
    if (elapsedMin >= ARRIVAL_PING_AFTER_MIN + NO_SHOW_AFTER_PING_MIN) {
      return { action: "replace" };
    }
    return { action: "wait" };
  }

  // No ping yet — send one once we're past the arrival grace window.
  if (arrivalPingSentAtMs === null) {
    if (elapsedMin >= ARRIVAL_PING_AFTER_MIN) return { action: "ping" };
    return { action: "wait" };
  }

  // Ping already sent. If the caregiver has since replied (but still hasn't
  // checked in — e.g. answered a question without texting ARRIVED), they're
  // engaged; hold rather than yank the visit out from under them.
  if (lastInboundAtMs !== null && lastInboundAtMs > arrivalPingSentAtMs) {
    return { action: "wait" };
  }

  const sincePingMin = (nowMs - arrivalPingSentAtMs) / 60_000;
  if (sincePingMin >= NO_SHOW_AFTER_PING_MIN) return { action: "replace" };

  return { action: "wait" };
}
