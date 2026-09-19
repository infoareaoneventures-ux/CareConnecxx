// Default prompt augmenters — migrated from the inline `systemPrompt += ...`
// chain in qaAgent.ts. Each augmenter is a pure function over AugmenterContext
// that returns either a directive string or null/empty (skip).
//
// Migration policy:
//   - Move one augmenter at a time. Each PR contains the new registry entry
//     AND the deletion of the corresponding inline append.
//   - The new directive text MUST be byte-identical to what the inline code
//     emitted. Test it by running the goldenTranscripts replay before and
//     after.
//   - Augmenters that need data not on ctx (e.g. Firestore reads) STAY inline
//     until we can populate the data through ctx.extras instead. Don't move
//     them to keep augmenters pure.

import type { PromptAugmenter, AugmenterContext } from "./promptAugmenters";
// Type-only import: preferences.ts touches Firestore at module load, and the
// erased type keeps this module pure (and its tests admin-free).
import type { CaraPreferences } from "../memory/preferences";

// ── language — replies in user's preferred language when set on session ──────
// Migrated from qaAgent.ts:1022 (es-only). Same text; same trigger condition.
export const languageAugmenter: PromptAugmenter = {
  name:        "language",
  description: "Switch reply language to user's preferred language when set",
  predicate: (ctx) => {
    const lang = (ctx.session as { preferredLanguage?: unknown } | undefined)?.preferredLanguage;
    return lang === "es";
  },
  augment: () =>
    "LANGUAGE: The family member speaks Spanish. Respond in warm, natural Spanish — " +
    "keep the same tone as Evia's English voice (close, direct, no chatbot phrasing). Do not switch back " +
    "to English unless the user does first.",
};

// ── unconfirmed-identity — phone in system but onboarding incomplete ─────────
// Migrated from qaAgent.ts:977-986. Same text; same trigger.
export const unconfirmedIdentityAugmenter: PromptAugmenter = {
  name:        "unconfirmed-identity",
  description: "Suppress care data when phone has unconfirmed identity",
  predicate: (ctx) => !!(ctx.session as { __unconfirmedIdentity?: unknown } | undefined)?.__unconfirmedIdentity,
  augment: () =>
    "UNCONFIRMED IDENTITY: This phone is in the system but the speaker has not completed onboarding, " +
    "so we do not know who they are or what care plan they belong to. " +
    "Do NOT mention any senior, caregiver, appointment, interview, care plan, family group, or other person's data — " +
    "treat as if you have no profile context (because what's on file may be someone else's). " +
    "Do NOT call any tool that reads or writes care data (matching, booking, journal, scheduling, payments). " +
    "If they ask whether you know them, say plainly: \"I have your number on file but not your name yet — " +
    "we never finished setting up your account. Want to do that now?\" " +
    "Otherwise answer general questions about Evia (what we do, pricing, how it works) and gently nudge toward setup.",
};

// ── persona-reinject — fires every 4th turn OR after a lint violation ────────
// Migrated from qaAgent.ts:1081-1088. Same text; same trigger.
export const personaReinjectAugmenter: PromptAugmenter = {
  name:        "persona-reinject",
  description: "Re-inject Evia persona + epistemic reminder to prevent voice drift",
  predicate: (ctx: AugmenterContext) => {
    const recentLintViolation = !!(ctx.session as { recentLintViolation?: unknown } | undefined)?.recentLintViolation;
    return (ctx.turnCount > 0 && ctx.turnCount % 4 === 0) || recentLintViolation;
  },
  augment: () =>
    "<system_reminder>You are Evia — warm, direct, specific. " +
    "Text format only: no bullet points, no headers, no em-dashes. " +
    "Keep replies under 300 characters when possible. " +
    "Lead with the human before the data. " +
    "Epistemic: only state facts from your context or tool results. If uncertain, say 'I don't have that info' rather than guessing. " +
    "Tools available — use them for fresh data and to take real actions.</system_reminder>",
};

// ── frustration-recovery — user just showed frustration; change register ─────
// Closes the write-only frustration loop: detectFrustrationSignals used to set
// a metrics flag nobody read back. Now the CURRENT turn (via extras, computed
// pre-prompt in qaAgent) and the NEXT turn (via session.recentFrustration,
// persisted end-of-turn beside recentLintViolation) both get a behavior
// directive instead of just a dashboard datapoint.
export const frustrationRecoveryAugmenter: PromptAugmenter = {
  name:        "frustration-recovery",
  description: "After detected user frustration, drop filler and lead with concrete recovery",
  predicate: (ctx) =>
    !!(ctx.extras as { frustrationThisTurn?: unknown } | undefined)?.frustrationThisTurn ||
    !!(ctx.session as { recentFrustration?: unknown } | undefined)?.recentFrustration,
  augment: () =>
    "FRUSTRATION RECOVERY: This user recently expressed frustration or had to repeat themselves. " +
    "Do not open with warmth boilerplate or apology padding. Own the miss in a few plain words at most, " +
    "then give the single most concrete next step or answer. No hedging, no 'I understand your frustration', " +
    "no re-asking for information they already gave — reread the conversation and use what is already there.",
};

// ── communication-preferences — DND window + channel prefs for timing reasoning ──
// New block (not a migration). The delivery layer (shouldSend / isInDND) already
// ENFORCES quiet hours; this surfaces them to the model so Evia can reason about
// timing out loud ("I'll hold this until morning") instead of silently colliding
// with the gate. Data arrives pure via ctx.extras.preferences (populated in
// qaAgent from the getPreferences call the DND gate already makes - no new read).
export const communicationPreferencesAugmenter: PromptAugmenter = {
  name:        "communication-preferences",
  description: "Surface DND window and channel preferences so Evia can reason about send timing",
  predicate: (ctx) => !!(ctx.extras as { preferences?: unknown } | undefined)?.preferences,
  augment: (ctx) => {
    const p = (ctx.extras as { preferences?: Partial<CaraPreferences> }).preferences ?? {};
    const lines: string[] = [];
    if (p.dndEnabled && p.dndStart && p.dndEnd) {
      lines.push(`- Quiet hours (do not disturb): ${p.dndStart}-${p.dndEnd}${p.timezone ? ` ${p.timezone}` : ""}. Messages are held during this window.`);
    } else {
      lines.push("- Quiet hours: not enabled.");
    }
    if (p.activeHours?.start && p.activeHours?.end) {
      lines.push(`- Preferred active hours for outreach: ${p.activeHours.start}-${p.activeHours.end}.`);
    }
    if (p.preferredSummaryTime) {
      lines.push(`- Preferred daily summary time: ${p.preferredSummaryTime}.`);
    }
    if (p.preferSMS) {
      lines.push("- Prefers SMS over other channels.");
    }
    return (
      "COMMUNICATION PREFERENCES (delivery timing is enforced downstream - use these to REASON about timing, not to gate your reply to this message):\n" +
      lines.join("\n") + "\n" +
      "When a reminder, follow-up, or proactive message would land inside quiet hours, say you'll hold it until the window ends " +
      "(e.g. \"I'll hold this until morning\") and schedule it for after. Never promise delivery inside the quiet-hours window."
    );
  },
};

// ── current-time block — built for the DYNAMIC (post-cache-breakpoint) side ──
// Deliberately NOT registered in DEFAULT_AUGMENTERS: runAugmenters appends into
// the system-prompt text that qaAgent places BEHIND the ephemeral prompt-cache
// breakpoint, and a minute-granularity timestamp inside that block would
// invalidate the cached prefix on every turn. qaAgent instead appends this as a
// separate, uncached system text block AFTER the breakpoint, so the stable
// prefix (tools + system) still hits cache across turns while the tool-loop
// iterations within a turn reuse the same computed bytes. Kept in this file so
// it stays a pure, unit-tested prompt builder alongside the other directives.
//
// Formatting convention matches the single-shot handlers' "Today is {iso}"
// (schedulingHandler.ts / caregiverProfileHandler.ts), extended with
// day-of-week, local time, and timezone for scheduling-grade reasoning.
export function buildCurrentTimeBlock(timezone?: string, now: Date = new Date()): string {
  const FALLBACK_TZ = "America/Los_Angeles";
  let tz = (timezone ?? "").trim();
  let assumed = false;
  if (tz) {
    try {
      // Validate the IANA name the same way preferences.ts does.
      new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(now);
    } catch {
      tz = "";
    }
  }
  if (!tz) {
    tz = FALLBACK_TZ;
    assumed = true;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year:     "numeric",
    month:    "2-digit",
    day:      "2-digit",
    weekday:  "long",
    hour:     "numeric",
    minute:   "2-digit",
    hour12:   true,
    timeZoneName: "short",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  const iso     = `${get("year")}-${get("month")}-${get("day")}`;
  const weekday = get("weekday");
  const time    = `${get("hour")}:${get("minute")} ${get("dayPeriod")}`;
  const tzAbbr  = get("timeZoneName");

  const assumption = assumed
    ? " No timezone is on file for this user - this assumes " + FALLBACK_TZ + " (Evia's service area is Santa Clara County)."
    : "";

  return (
    `CURRENT TIME: Today is ${iso} (${weekday}). Local time: ${time} ${tzAbbr} (${tz}).${assumption} ` +
    "Resolve every relative date or time the user mentions (\"today\", \"tomorrow\", \"Thursday\", \"next week\", \"this morning\") against this, " +
    "and use it when reasoning about visit times, reminders, and quiet hours."
  );
}

// Convenience array — the order here is the order they'll be appended to the
// system prompt. Keep it stable; downstream consumers (turn metrics, tests)
// rely on the ordering.
export const DEFAULT_AUGMENTERS: readonly PromptAugmenter[] = [
  languageAugmenter,
  unconfirmedIdentityAugmenter,
  personaReinjectAugmenter,
  frustrationRecoveryAugmenter,
  communicationPreferencesAugmenter,
];
