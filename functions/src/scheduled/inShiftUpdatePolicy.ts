/**
 * Pure decision logic for in-shift family updates.
 *
 * During an active visit (appointment status "in-progress") the family should
 * hear from Evia on a time-based ladder — not just when a care-plan task happens
 * to get acked. This module owns the "should we prompt the caregiver now?" and
 * "the caregiver went quiet — should we send the family a heartbeat?" decisions,
 * kept pure so every cadence edge case is unit-tested without Firestore.
 *
 * Ladder: nothing for shifts <= MIN_SHIFT_MIN (arrival + shift-end summary
 * already bracket them). Otherwise first prompt LADDER_FIRST_DELAY_MIN after the
 * caregiver arrived, then every `cadenceMinutes` (family-tunable, defaults to
 * LADDER_INTERVAL_MIN), suppressed within END_SUPPRESSION_MIN of scheduled end
 * (the shift-end summary is coming), and hard-capped at
 * MAX_FAMILY_UPDATES_PER_SHIFT so a bug can never machine-gun a family.
 */

export const MIN_SHIFT_MIN = 90;                 // shifts this short get no mid-shift update
export const LADDER_FIRST_DELAY_MIN = 60;        // first prompt this long after arrival
export const LADDER_INTERVAL_MIN = 120;          // default spacing between prompts
export const END_SUPPRESSION_MIN = 45;           // no prompt within this window of scheduled end
export const MAX_FAMILY_UPDATES_PER_SHIFT = 6;   // hard ceiling on family messages per shift
export const HEARTBEAT_AFTER_MIN = 20;           // unanswered prompt older than this → family heartbeat

/**
 * Shape of the `awaitingInShiftUpdate` session flag — written by the sweep job
 * when it prompts the caregiver, consumed by routeCaregiver's reply handler.
 * One declaration so the two sides can't drift.
 */
export interface AwaitingInShiftUpdate {
  appointmentId: string;
  clientId:      string;
  seniorId:      string;
  seniorName:    string;
  question:      string;
  topic:         string;
  promptedAt:    string;
}

export interface PromptInput {
  /** When the shift went in-progress (arrivedAt, or scheduled start as fallback), ms. */
  anchorMs:          number | null;
  /** Scheduled end of the shift, ms. Null → end-suppression skipped. */
  scheduledEndMs:    number | null;
  /** Planned shift length in hours. Null → short-shift check skipped. */
  durationHours:     number | null;
  /** When the caregiver was last prompted this shift, ms. Null → never. */
  lastPromptAtMs:    number | null;
  /** Family-facing updates already sent this shift (prompts relayed + heartbeats). */
  familyUpdateCount: number;
  /** Caregiver already has an open, unanswered prompt — don't double-ask. */
  awaitingReply:     boolean;
  /** Interval between prompts in minutes (family override; defaults to LADDER_INTERVAL_MIN). */
  cadenceMinutes:    number;
  /**
   * The family explicitly set cadenceMinutes (set_visit_update_frequency).
   * When true the FIRST prompt also fires at cadenceMinutes after arrival —
   * "every 8 hours please" must not still produce a 60-minute first update,
   * and "every 45 minutes" must not wait a full hour.
   */
  cadenceOverridden: boolean;
  nowMs:             number;
}

export type PromptDecision =
  | { action: "prompt" }
  | { action: "skip"; reason: string };

export function decideInShiftPrompt(input: PromptInput): PromptDecision {
  const {
    anchorMs, scheduledEndMs, durationHours, lastPromptAtMs,
    familyUpdateCount, awaitingReply, cadenceMinutes, cadenceOverridden, nowMs,
  } = input;

  if (anchorMs === null) return { action: "skip", reason: "no_anchor" };
  if (durationHours !== null && durationHours * 60 <= MIN_SHIFT_MIN) {
    return { action: "skip", reason: "shift_too_short" };
  }
  if (familyUpdateCount >= MAX_FAMILY_UPDATES_PER_SHIFT) {
    return { action: "skip", reason: "ceiling_reached" };
  }
  if (awaitingReply) return { action: "skip", reason: "awaiting_reply" };

  if (scheduledEndMs !== null) {
    const minutesToEnd = (scheduledEndMs - nowMs) / 60_000;
    if (minutesToEnd <= END_SUPPRESSION_MIN) {
      return { action: "skip", reason: "near_end" };
    }
  }

  const elapsedMin = (nowMs - anchorMs) / 60_000;
  const firstDelayMin = cadenceOverridden && cadenceMinutes > 0 ? cadenceMinutes : LADDER_FIRST_DELAY_MIN;
  if (elapsedMin < firstDelayMin) {
    return { action: "skip", reason: "too_early" };
  }

  if (lastPromptAtMs !== null) {
    const sinceLastMin = (nowMs - lastPromptAtMs) / 60_000;
    const interval = cadenceMinutes > 0 ? cadenceMinutes : LADDER_INTERVAL_MIN;
    if (sinceLastMin < interval) {
      return { action: "skip", reason: "cadence" };
    }
  }

  return { action: "prompt" };
}

export interface HeartbeatInput {
  /** Caregiver has an open, unanswered prompt. */
  awaitingReply:     boolean;
  /** When that prompt was sent, ms. Null → nothing pending. */
  promptSentAtMs:    number | null;
  /** Family-facing updates already sent this shift. */
  familyUpdateCount: number;
  nowMs:             number;
}

export type HeartbeatDecision =
  | { action: "heartbeat" }
  | { action: "skip"; reason: string };

/**
 * When a prompt goes unanswered past HEARTBEAT_AFTER_MIN, the family gets a
 * facts-only heartbeat so their awareness never depends on caregiver
 * responsiveness. The heartbeat never fabricates wellbeing and never says the
 * caregiver is unresponsive — the job builds it from known facts only.
 */
export function decideHeartbeat(input: HeartbeatInput): HeartbeatDecision {
  const { awaitingReply, promptSentAtMs, familyUpdateCount, nowMs } = input;

  if (!awaitingReply) return { action: "skip", reason: "not_awaiting" };
  if (promptSentAtMs === null) return { action: "skip", reason: "no_prompt_time" };
  if (familyUpdateCount >= MAX_FAMILY_UPDATES_PER_SHIFT) {
    return { action: "skip", reason: "ceiling_reached" };
  }

  const waitedMin = (nowMs - promptSentAtMs) / 60_000;
  if (waitedMin < HEARTBEAT_AFTER_MIN) return { action: "skip", reason: "still_waiting" };

  return { action: "heartbeat" };
}

/**
 * Choose the rotating, care-plan-aware question for this prompt. Kept pure so the
 * rotation is testable — the job supplies the current context. The reply is
 * free-text; this only picks what Evia asks. `slotIndex` (the count of prompts
 * already sent this shift) drives rotation; `hasMeds`/`timeOfDay` bias toward the
 * most relevant question.
 */
export type TimeOfDay = "morning" | "midday" | "afternoon" | "evening";

export function timeOfDayFromMinutes(minutesSinceMidnight: number): TimeOfDay {
  if (minutesSinceMidnight < 11 * 60) return "morning";
  if (minutesSinceMidnight < 14 * 60) return "midday";
  if (minutesSinceMidnight < 17 * 60) return "afternoon";
  return "evening";
}

export interface QuestionContext {
  seniorFirstName: string;
  slotIndex:       number;   // prompts already sent this shift (0 = first)
  timeOfDay:       TimeOfDay;
  hasMeds:         boolean;
  medsPromptedAlready: boolean;
}

/**
 * Returns a short, specific question the caregiver can answer in a few words.
 * Deterministic given the context so it's unit-testable; the job wraps the result
 * in warm phrasing via generateCaraMessage but this guarantees a grounded topic.
 */
export function pickRotatingQuestion(ctx: QuestionContext): { topic: string; text: string } {
  const name = ctx.seniorFirstName || "your client";

  // Med confirmation gets one slot if the plan has meds and we haven't asked yet.
  if (ctx.hasMeds && !ctx.medsPromptedAlready && ctx.slotIndex >= 1) {
    return { topic: "medication", text: `Have ${name}'s medications gone okay so far today?` };
  }

  const byTime: Record<TimeOfDay, { topic: string; text: string }> = {
    morning:   { topic: "morning",  text: `How's ${name} doing this morning?` },
    midday:    { topic: "meal",     text: `Did ${name} eat much for lunch?` },
    afternoon: { topic: "energy",   text: `How's ${name}'s energy this afternoon?` },
    evening:   { topic: "evening",  text: `How's ${name} settling in this evening?` },
  };

  // Rotate mood/activity in on later slots so it doesn't feel like the same ping.
  if (ctx.slotIndex >= 2 && ctx.slotIndex % 2 === 0) {
    return { topic: "mood", text: `What kind of mood is ${name} in right now?` };
  }

  return byTime[ctx.timeOfDay];
}
