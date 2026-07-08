import { ConversationStep } from "./conversationStep";
import { AgentSession } from "../linq/client";

/**
 * CAREGIVER_STEPS — the linear caregiver onboarding questions as data.
 *
 * Each entry is a `ConversationStep` (see conversationStep.ts) that the `runStep`
 * runner drives through the CLAUDE.md checklist. This file owns ONLY the per-step
 * variation that used to differ between the hand-written `handleCaregiverAsk*`
 * handlers: the parse prompt, how the parser's raw output maps to stored
 * `onboardingData` fields, the re-ask / retry text, the next step id, and the
 * acknowledging next question.
 *
 * Every user-visible string here is copied VERBATIM from the former
 * `handleCaregiverAsk*` handlers in onboardingConversation.ts. Changing any of
 * them changes what Evia says — that is a regression, not a refactor.
 *
 * ── Boundary: what is migrated vs. left bespoke ──────────────────────────────
 * MIGRATED (here): caregiver_ask_name, caregiver_ask_experience,
 *   caregiver_ask_specialties, caregiver_ask_availability, caregiver_ask_job_type,
 *   caregiver_ask_rate. These are pure ask-a-question / store-an-answer /
 *   ask-the-next steps.
 *
 * LEFT BESPOKE (NOT in this table — keep their own handlers in
 * onboardingConversation.ts) because they do more than merge-then-ask:
 *   - caregiver_ask_location — reverse-geocodes one-tap location pins AND fires
 *     the live local-job teaser (sends extra messages); mirrors the bespoke
 *     client location step's complexity.
 *   - caregiver_ask_profile — sits between specialties and availability; kept on
 *     its own handler (it was not in U3's migration list).
 *   - caregiver_ask_email — has a non-standard question-gate (skips the
 *     isQuestionOrOther LLM hop when the text contains "@") and validates the raw
 *     inbound text rather than a parsed value; both diverge from the generic
 *     checklist, so it keeps its bespoke handler.
 *   - caregiver_ask_bio — merges the bio then HANDS OFF to handleCaregiverSendPhoto
 *     (a side effect beyond merge — its "next" is another handler, not a question).
 *   - All non-linear steps: photo/document upload, MVR opt-in, membership (Stripe),
 *     background check (Checkr), Stripe Connect, and finalization.
 *
 * The helper a step's `nextQuestion` needs (`generateCaraMessage`, `locationPrompt`)
 * is injected via `buildCaregiverSteps` so this module stays free of an import
 * cycle with onboardingConversation.ts. The `parse` functions are pure (except
 * the rate step, which stashes its failure-specific retry message on the session
 * in memory — see below).
 */

export interface CaregiverStepDeps {
  /** Generate Evia's next line (ack + next question) — same call shape as before. */
  generateCaraMessage: (opts: {
    audience: "caregiver" | "family";
    context: string;
    fallback: string;
    maxTokens?: number;
    language?: "en" | "es";
    emotionalDirective?: string;
  }) => Promise<string>;
  /** Wrap a location ask with the "tap to share" affordance on iMessage/RCS. */
  locationPrompt: (base: string, service?: string) => string;
}

export function buildCaregiverSteps(deps: CaregiverStepDeps): Record<string, ConversationStep> {
  const { generateCaraMessage, locationPrompt } = deps;

  return {
    // ── caregiver_ask_name ──────────────────────────────────────────────────────
    caregiver_ask_name: {
      id: "caregiver_ask_name",
      parsePrompt:
        "Extract the full name from this message. Reply with just the name, nothing else.",
      parse(raw) {
        if (raw === "__parse_error__" || !raw) return null; // re-ask: "didn't catch your name"
        return { name: raw };
      },
      nextStep: "caregiver_ask_location",
      reask: () => "What's your name?",
      retry: () => "I didn't catch your name — could you share it?",
      async nextQuestion(session) {
        const name = (session.onboardingData?.name as string) ?? "";
        const msg9 = await generateCaraMessage({
          audience: "caregiver",
          context: `Evia just learned the caregiver's name is ${name}. Greet them by name and ask what city and zip code they work in.`,
          fallback: `Hi ${name} — what city and zip code do you work in?`,
          maxTokens: 80,
        });
        return locationPrompt(msg9, session.service);
      },
    },

    // ── caregiver_ask_experience ──────────────────────────────────────────────────
    caregiver_ask_experience: {
      id: "caregiver_ask_experience",
      parsePrompt:
        'Extract yearsExperience (number) and certifications (array of strings) from this message. Reply in JSON: {"yearsExperience":0,"certifications":[]}',
      parse(raw) {
        if (raw === "__parse_error__") return null; // re-ask instead of recording 0 years / no certs
        let yearsExperience = 0, certifications: string[] = [];
        try { const p = JSON.parse(raw); yearsExperience = p.yearsExperience ?? 0; certifications = Array.isArray(p.certifications) ? p.certifications : []; } catch { /* keep defaults */ }
        // Only include certifications when this step actually found some —
        // otherwise an empty [] overwrites certifications already extracted from
        // the caregiver's free-form story step (caregiver_ask_story).
        return { yearsExperience, ...(certifications.length ? { certifications } : {}) };
      },
      nextStep: "caregiver_ask_specialties",
      reask: () => "How many years of caregiving experience do you have, and do you hold any certifications?",
      // Reached on parse error (a valid "0 years / none" answer still advances).
      retry: () => "How many years of caregiving experience do you have, and do you hold any certifications?",
      async nextQuestion(session) {
        const yearsExperience = (session.onboardingData?.yearsExperience as number) ?? 0;
        const certifications  = (session.onboardingData?.certifications as string[]) ?? [];
        const msg11intro = await generateCaraMessage({
          audience: "caregiver",
          context:
            `Evia is onboarding a caregiver who just told her they have ${yearsExperience || "some"} years of experience` +
            `${certifications.length ? ` and these certifications: ${certifications.join(", ")}` : ""}. ` +
            `Acknowledge that warmly in one short line (genuine, not flattery clichés), then ask what types of care they specialize in.`,
          fallback: "What types of care do you specialize in?",
          maxTokens: 80,
        });
        return `${msg11intro}\n\nFor example: dementia, Alzheimer's, mobility assistance, post-surgery, companionship, medication management...`;
      },
    },

    // ── caregiver_ask_specialties ──────────────────────────────────────────────────
    caregiver_ask_specialties: {
      id: "caregiver_ask_specialties",
      parsePrompt:
        "Extract a list of care specialties from this message. Reply in JSON: {\"specialties\":[\"...\",\"...\"]}",
      parse(raw) {
        if (raw === "__parse_error__") return null; // re-ask instead of recording empty specialties
        let specialties: string[] = [];
        try { const p = JSON.parse(raw); specialties = Array.isArray(p.specialties) ? p.specialties : []; } catch { /* keep defaults */ }
        return { specialties };
      },
      nextStep: "caregiver_ask_profile",
      reask: () => "What types of care do you specialize in? (e.g. dementia, mobility, post-surgery, companionship)",
      // Reached on parse error.
      retry: () => "What types of care do you specialize in? (e.g. dementia, mobility, post-surgery, companionship)",
      async nextQuestion(session) {
        const specialties = (session.onboardingData?.specialties as string[]) ?? [];
        return generateCaraMessage({
          audience: "caregiver",
          context:
            `Evia is onboarding a caregiver who just shared their specialties${specialties.length ? `: ${specialties.join(", ")}` : ""}. ` +
            `Acknowledge it warmly in one short line, then ask three quick profile details families use when matching: ` +
            `whether they're male or female (some families have a preference), what languages they speak, and whether they can ` +
            `drive clients to appointments. Keep it light and quick.`,
          fallback: "A few quick details families use to match — are you male or female, what languages do you speak, and can you drive clients to appointments?",
          maxTokens: 100,
        });
      },
    },

    // ── caregiver_ask_availability ──────────────────────────────────────────────────
    caregiver_ask_availability: {
      id: "caregiver_ask_availability",
      parsePrompt:
        "Extract availability days (array of strings) and hours (string) from this message. Reply in JSON: {\"days\":[\"Monday\",\"Tuesday\"],\"hours\":\"9am-5pm\"}",
      parse(raw) {
        if (raw === "__parse_error__") return null; // re-ask instead of recording empty availability
        let days: string[] = [], hours = "";
        try { const p = JSON.parse(raw); days = Array.isArray(p.days) ? p.days : []; hours = p.hours ?? ""; } catch { /* keep defaults */ }
        return { availability: { days, hours } };
      },
      nextStep: "caregiver_ask_job_type",
      reask: () => "What days and hours are you generally available to work?",
      // Reached on parse error.
      retry: () => "What days and hours are you generally available to work?",
      async nextQuestion(session) {
        const availability = (session.onboardingData?.availability as { days?: string[]; hours?: string }) ?? {};
        const hours = availability.hours ?? "";
        const availIntro = await generateCaraMessage({
          audience: "caregiver",
          context:
            `Evia is onboarding a caregiver who just shared their availability${hours ? ` (${hours})` : ""}. ` +
            `Acknowledge it warmly in one short line, then ask whether they want occasional, part-time, or ` +
            `full-time work. Phrase it as a natural either/or question, not a numbered menu.`,
          fallback: "Got it, thanks!",
          maxTokens: 60,
        });
        return `${availIntro}\n\nAre you looking for occasional fill-in shifts, part-time (under 25 hrs/week), or full-time work?`;
      },
    },

    // ── caregiver_ask_job_type ──────────────────────────────────────────────────────
    caregiver_ask_job_type: {
      id: "caregiver_ask_job_type",
      parsePrompt:
        '"1", occasional, fill-in, as-needed, flexible, sometimes → occasional. ' +
        '"2", part-time, part time, a few days, some days → part_time. ' +
        '"3", full-time, full time, every day, all week → full_time. ' +
        'Reply with exactly one of: occasional, part_time, full_time',
      parse(raw) {
        if (raw === "__parse_error__") return null; // re-ask instead of defaulting to part_time
        const jobType = ["occasional", "part_time", "full_time"].includes(raw) ? raw : "part_time";
        return { jobType };
      },
      nextStep: "caregiver_ask_rate",
      reask: () => "Are you looking for occasional, part-time, or full-time work?",
      // Reached on parse error (an unrecognized-but-present answer still defaults to part_time).
      retry: () => "Are you looking for occasional, part-time, or full-time work?",
      async nextQuestion(session) {
        const jobType = (session.onboardingData?.jobType as string) ?? "part_time";
        const jobTypeLabel: Record<string, string> = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
        const d = session.onboardingData ?? {};
        const city = (d.city as string) ?? "";
        return `${jobTypeLabel[jobType] ?? "Got it"}! What's your hourly rate?\n\n` +
          (city ? `(Most caregivers in ${city} charge $18–28/hr)` : "(Most caregivers charge $18–28/hr)");
      },
    },

    // ── caregiver_ask_rate ──────────────────────────────────────────────────────────
    caregiver_ask_rate: {
      id: "caregiver_ask_rate",
      parsePrompt:
        "Extract the hourly rate as a number from this message. Reply with just the number (e.g. 22). No dollar sign.",
      parse(raw, session) {
        // Two distinct re-ask messages (parse error vs out-of-range), preserved by
        // stashing the right one on the session in memory for `retry` to read.
        // (In-memory only — never persisted; cleared implicitly on the next turn.)
        const s = session as AgentSession & { _rateRetryMsg?: string };
        if (raw === "__parse_error__") {
          s._rateRetryMsg = "Hmm, I didn't catch that. What's your hourly rate? Just a number works (e.g. \"22\")";
          return null;
        }
        const hourlyRate = parseFloat(raw);
        if (isNaN(hourlyRate) || hourlyRate < 5 || hourlyRate > 200) {
          s._rateRetryMsg = "Could you share your hourly rate as a number between $5 and $200? (e.g. \"22\")";
          return null;
        }
        return { hourlyRate };
      },
      nextStep: "caregiver_ask_email",
      reask: () => "What's your hourly rate? Just a number works (e.g. \"22\").",
      retry(session) {
        const s = session as AgentSession & { _rateRetryMsg?: string };
        // Defensive fallback (parse always sets _rateRetryMsg before returning null).
        return s._rateRetryMsg ?? "Hmm, I didn't catch that. What's your hourly rate? Just a number works (e.g. \"22\")";
      },
      async nextQuestion(session) {
        const hourlyRate = (session.onboardingData?.hourlyRate as number) ?? 0;
        return generateCaraMessage({
          audience: "caregiver",
          context:
            `Evia is onboarding a caregiver who just set their rate at $${hourlyRate}/hr. Acknowledge it in one short, ` +
            `genuine line (no flattery clichés), then ask for their email address, mentioning it's used to set up their payout account.`,
          fallback: `$${hourlyRate}/hr works. What's your email address? I'll use it to set up your payout account.`,
          maxTokens: 70,
        });
      },
    },
  };
}
