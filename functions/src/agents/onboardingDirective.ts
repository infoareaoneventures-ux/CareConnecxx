// Onboarding directive (U2) — the system-prompt block injected when the agent
// loop is running an onboarding turn (U3). It tells Evia the goal (collect these
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
  careNeeds:   "what kind of help the senior needs day to day",
  city:        "the city (and zip if they give it) where care is needed",
  daysPerWeek: "how many days a week care is needed",
  timeOfDay:   "what time of day care is needed (mornings, afternoons, etc.)",
  zipCode:     "the zip code where care is needed",
  hoursPerDay: "how many hours per day",
  relationship:"the family member's relationship to the senior",
  conditions:  "any diagnoses or conditions the senior has",
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
      `save_onboarding_field for each one. Then look at what's still missing and continue. ` +
      `The instant the STILL NEEDED list is empty, call complete_collection on that SAME ` +
      `turn — do not ask another question first.`
    : `Everything required is collected. Call complete_collection RIGHT NOW, before anything ` +
      `else this turn, then send ONE short warm line acknowledging you've got what you need to ` +
      `find ${role === "caregiver" ? "them work" : "their match"} — keep it brief, do NOT promise ` +
      `a specific timeframe or that options are coming "shortly" (the next message handles what's ` +
      `actually available), do NOT list fields back like a form, and do NOT ask for more details.`;

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
    `  - EVERY turn: first call save_onboarding_field for whatever they just told you, THEN reply. A short or one-word answer to your last question IS that field's value — save it immediately, don't ask them to confirm it and don't move on without saving it.`,
    `  - Acknowledge what they just said before you ask the next thing. Reflect the story`,
    `    back when it's heavy ("so she's alone mornings while you work") — then ask.`,
    `  - One question per message. Never send a numbered list or ask for several things at once.`,
    `  - If they front-load several answers, save them all and skip ahead — don't re-ask.`,
    `  - ONLY the items in STILL NEEDED are required. Never ask for anything not on that list (zip, exact address, budget, etc. are optional) — never hold up the signup for an optional detail.`,
    `  - Don't loop. If you've asked for the same item once and still don't have it, ask ONE more time in a different way, then move to the next needed item — never ask the same question more than twice.`,
    `  - Figure out WHO is who: the first name you collect is the ${audience} you're texting. If they first tell you who NEEDS care (e.g. "my mom", "her name is Jane") before giving their own name, that name is the senior's — save it as the senior, not as the ${audience}.`,
    `  - SELF-CARE: if they're looking for care for THEMSELVES (they say "for me"/"for myself", or relationship is already "self"), the senior IS the person texting. Save relationship as "self" and seniorName the same as their own name, NEVER ask who they're caring for, and speak to them directly — "you", never "your loved one" and never their name in the third person.`,
    `  - Don't get stuck on the ${audience}'s OWN name. If they haven't given it, collect the other items first and ask for their name near the end — never re-ask it every turn, and never treat an answer to a different question (a city, an age, a need) as their name.`,
    `  - No chatbot phrasing. Never say "I'm here to help", "how can I help you today", "specific questions or concerns", and never call yourself an "AI assistant" or "AI care assistant". Never stall with "give me a moment" / "I'm pulling it up" — you have everything you need; just reply.`,
    `  - Voice memos work here: they can tap-and-hold to send one instead of typing. Offer this ONCE per conversation, warmly and in your own words (e.g. "if typing it all out is a pain, just send me a voice memo — I'll listen") — the first time you ask an open-ended question (who they're caring for, what help is needed), or sooner if their replies look effortful (very short fragments, heavy typos). Check the conversation: if you've already offered it, never repeat it.`,
    ``,
    `WHAT TO DO THIS TURN:`,
    `  ${action}`,
  ].join("\n");
}
