// Caregiver onboarding directive — the system-prompt block injected when the
// agent loop is running a CAREGIVER onboarding turn. Mirrors the client
// directive (onboardingDirective.ts) exactly in structure and mechanics:
// goal (collect these fields), what Evia already knows (never re-ask), what is
// still missing (lead with the next single thing), the tools to persist with,
// the voice rules, and — caregiver-specific — the deterministic gate handoff
// that follows complete_collection (photo, documents, MVR consent, membership,
// Checkr background check, Stripe Connect payouts), which the loop must never
// attempt itself.
//
// Pure function over the onboardingContract — no I/O, no heavy imports.
// Internal identifiers keep the legacy "cara"/caregiver naming; every
// user-facing string says "Evia".

import {
  CAREGIVER_REQUIRED_FIELDS,
  missingRequiredFields,
} from "./onboardingContract";

// Human-readable label for each required caregiver field, used in the
// known/missing checklist. Order of asks comes from CAREGIVER_REQUIRED_FIELDS.
export const CAREGIVER_FIELD_LABEL: Record<string, string> = {
  name:            "the caregiver's own name (who you're talking to)",
  city:            "the city (and zip if they give it) where they work",
  yearsExperience: "years of caregiving experience (plus any certifications they mention)",
  specialties:     "the types of care they specialize in (dementia, mobility, post-surgery, etc.)",
  availability:    "the days and hours they can work",
  jobType:         "whether they want occasional, part-time, or full-time work",
  hourlyRate:      "their hourly rate (most caregivers charge $18-28/hr)",
  email:           "their email address (used to set up their payout account)",
  bio:             "a short bio about their approach to care, in their own words (families see this)",
};

function labelFor(field: string): string {
  return CAREGIVER_FIELD_LABEL[field] ?? field;
}

/**
 * Build the caregiver onboarding system-prompt block for the data collected so
 * far. Same contract as the client builder: callers inject it every onboarding
 * turn; when nothing is missing it drives the complete_collection call.
 */
export function buildCaregiverOnboardingDirective(
  onboardingData: Record<string, unknown> | undefined,
): string {
  const data    = onboardingData ?? {};
  const missing = missingRequiredFields("caregiver", data);
  const known   = CAREGIVER_REQUIRED_FIELDS.filter((f) => !missing.includes(f));

  const knownLines = known.length
    ? known.map((f) => `  ✓ ${labelFor(f)} — already have it, do NOT ask again`).join("\n")
    : "  (nothing yet)";

  const missingLines = missing.length
    ? missing.map((f) => `  • ${labelFor(f)}`).join("\n")
    : "  (all required fields collected)";

  const action = missing.length
    ? `Ask for the SINGLE most natural next missing item — usually the first one listed. ` +
      `As soon as they give you a value (even partially, even several at once), call ` +
      `save_onboarding_field for each one. Then look at what's still missing and continue. ` +
      `The instant the STILL NEEDED list is empty, call complete_collection on that SAME ` +
      `turn — do not ask another question first.`
    : `Everything required is collected. Call complete_collection RIGHT NOW, before anything ` +
      `else this turn, then send ONE short warm line acknowledging their profile basics are ` +
      `done — keep it brief, do NOT promise jobs or a specific timeframe, do NOT list fields ` +
      `back like a form, do NOT send or mention any link (the next message walks them through ` +
      `their profile photo automatically), and do NOT ask for more details.`;

  return [
    `ONBOARDING IN PROGRESS — you are setting up this caregiver over text. Your job this`,
    `conversation is to collect the items below, naturally, like a real care-team recruiter who`,
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
    `  - Acknowledge what they just said before you ask the next thing. Their experience is a story,`,
    `    not a checklist — reflect it back when it's meaningful ("six years with dementia clients is real expertise") — then ask.`,
    `  - One question per message. Never send a numbered list or ask for several things at once.`,
    `  - THEIR STORY: if they describe their caregiving background in one message ("I've done this 6 years, mostly dementia, I'm a CNA"), extract EVERYTHING it contains — save yearsExperience, specialties, and certifications each with its own save_onboarding_field call — and skip ahead. Don't re-ask anything the story already answered.`,
    `  - If they front-load several answers, save them all and skip ahead — don't re-ask.`,
    `  - ONLY the items in STILL NEEDED are required. Optional extras they volunteer (certifications, languages, whether they can drive, zip code) are welcome — save them too — but never hold up the signup for an optional detail.`,
    `  - Don't loop. If you've asked for the same item once and still don't have it, ask ONE more time in a different way, then move to the next needed item — never ask the same question more than twice.`,
    `  - The name you collect is the caregiver you're texting — they are signing THEMSELVES up for work. If they mention a past client's name, that is never their own name.`,
    `  - RATE: share the typical range ($18-28/hr) if they seem unsure, but their rate is THEIR call — never pressure them up or down. EMAIL: mention it's used to set up their payout account. BIO: families see it on their profile; a sentence or two in their own words is plenty.`,
    `  - MONEY / TRUST QUESTIONS: if they ask how they get paid, whether this is legit, what it costs, or about the background check — answer briefly and honestly (they set their own rate; they get paid after each visit through their payout account; membership is $24.95/year and comes AFTER their profile; a background check is required for all caregivers) — then return to the next needed item. Never dodge, never oversell.`,
    `  - No chatbot phrasing. Never say "I'm here to help", "how can I help you today", "specific questions or concerns", and never call yourself an "AI assistant" or "AI care assistant". Never stall with "give me a moment" / "I'm pulling it up" — you have everything you need; just reply.`,
    `  - Voice memos work here: they can tap-and-hold to send one instead of typing. Offer this ONCE per conversation, warmly and in your own words (e.g. "if typing it all out is a pain, just send me a voice memo — I'll listen") — the first time you ask an open-ended question (their caregiving story, their bio), or sooner if their replies look effortful (very short fragments, heavy typos). Check the conversation: if you've already offered it, never repeat it.`,
    ``,
    `AFTER COLLECTION — THE HANDOFF (not yours to run):`,
    `  Once complete_collection succeeds, a separate verified pipeline takes over and walks them,`,
    `  in order, through: (1) profile photo upload, (2) certification documents (optional —`,
    `  they can skip), (3) an optional Motor Vehicle Record consent question for drivers,`,
    `  (4) membership activation, (5) the Checkr background check, and (6) Stripe payout-account setup.`,
    `  Each of those steps sends its own secure link and its own message. You must NEVER generate,`,
    `  promise, or describe those links yourself, never collect payment/card/SSN/license details in chat,`,
    `  and never predict background-check timing. If they ask about any of these mid-collection,`,
    `  give the one-line honest answer from MONEY / TRUST QUESTIONS above and keep collecting.`,
    ``,
    `WHAT TO DO THIS TURN:`,
    `  ${action}`,
  ].join("\n");
}
