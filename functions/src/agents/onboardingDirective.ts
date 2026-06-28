// Onboarding directive (U2) — the system-prompt block injected when the agent
// loop is running an onboarding turn (U3). It tells Cara the goal (collect these
// fields), what she already knows (so she never re-asks), what's still missing
// (so she leads with the next single thing), the tools to persist with, and the
// voice rules that keep collection conversational instead of form-like.
//
// Pure function over the onboardingContract — no I/O, no heavy imports.

import {
  OnboardingRole,
  requiredFieldsForRole,
  missingRequiredFields,
} from "./onboardingContract";

// Human-readable label for each field, used in the known/missing checklist.
const FIELD_LABEL: Record<string, string> = {
  // client
  firstName:   "the family member's first name (who you're talking to)",
  seniorName:  "who they're caring for — the senior's name and the relationship",
  age:         "the senior's age",
  city:        "the city and zip where care is needed",
  schedule:    "the days and times care is needed",
  // caregiver
  name:           "the caregiver's name",
  yearsExperience:"years of caregiving experience",
  specialties:    "the types of care they specialize in",
  availability:   "the days and hours they can work",
  jobType:        "occasional / part-time / full-time",
  hourlyRate:     "their hourly rate",
  email:          "their email address",
  bio:            "a short bio in their own words",
};

function labelFor(field: string): string {
  return FIELD_LABEL[field] ?? field;
}

/**
 * Build the onboarding system-prompt block for the given role and the data
 * collected so far. Returns "" when there is nothing left to collect AND the
 * caller has already handed off (callers should still inject it to drive the
 * complete_collection call when missing is empty).
 */
export function buildOnboardingDirective(
  role: OnboardingRole,
  onboardingData: Record<string, unknown> | undefined,
): string {
  const data    = onboardingData ?? {};
  const missing = missingRequiredFields(role, data);
  const required = requiredFieldsForRole(role);
  const known   = required.filter((f) => !missing.includes(f));

  const knownLines = known.length
    ? known.map((f) => `  ✓ ${labelFor(f)} — already have it, do NOT ask again`).join("\n")
    : "  (nothing yet)";

  const missingLines = missing.length
    ? missing.map((f) => `  • ${labelFor(f)}`).join("\n")
    : "  (all required fields collected)";

  const audience = role === "caregiver" ? "caregiver" : "family member";

  const action = missing.length
    ? `Ask for the SINGLE most natural next missing item — usually the first one listed. ` +
      `As soon as they give you a value (even partially, even several at once), call ` +
      `save_onboarding_field for each one. Then look at what's still missing and continue.`
    : `Everything required is collected. Call complete_collection now, then tell ${role === "caregiver" ? "them" : "the family"} ` +
      `in your own warm words what happens next — do NOT list fields back like a form.`;

  return [
    `ONBOARDING IN PROGRESS — you are setting up this ${audience} over text. Your job this`,
    `conversation is to collect the items below, naturally, like a real care coordinator who`,
    `leads a conversation — never a form.`,
    ``,
    `ALREADY KNOWN:`,
    knownLines,
    ``,
    `STILL NEEDED (one at a time, in roughly this order):`,
    missingLines,
    ``,
    `HOW TO TALK:`,
    `  - You are mid-conversation. You already greeted them. NEVER greet again, never re-introduce yourself, never open with "Hi"/"Hey <name>". Reply directly.`,
    `  - Acknowledge what they just said before you ask the next thing. Reflect the story`,
    `    back when it's heavy ("so she's alone mornings while you work") — then ask.`,
    `  - One question per message. Never send a numbered list or ask for several things at once.`,
    `  - If they front-load several answers, save them all and skip ahead — don't re-ask.`,
    `  - No chatbot phrasing. Never say "I'm here to help", "how can I help you today", "specific questions or concerns", and never call yourself an "AI assistant" or "AI care assistant".`,
    ``,
    `WHAT TO DO THIS TURN:`,
    `  ${action}`,
  ].join("\n");
}
