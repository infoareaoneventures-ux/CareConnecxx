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
import { buildCaregiverOnboardingDirective } from "./caregiverOnboardingDirective";

// Human-readable label for each CLIENT field — mirrors the web wizard's 14-step
// sequence so the SMS conversation asks the same questions in the same order.
// Caregiver labels live in caregiverOnboardingDirective.ts.
const FIELD_LABEL: Record<string, string> = {
  // Step 2
  careFrequency:  "how often care is needed — occasional (a few times/month), part-time (1–4 days/week), or full-time (5+ days/week)",
  // Step 3 — home address (account holder)
  homeStreet:     "the account holder's home street address",
  homeZipCode:    "the account holder's home zip code",
  homeCity:       "the city where the account holder lives",
  homeState:      "the account holder's home state (2-letter abbreviation)",
  // Step 3b — care address (same as home, or different)
  city:           "the city where care is needed",
  zipCode:        "the zip code where care is needed",
  street:         "the street address where care is needed",
  state:          "the state where care is needed",
  // Step 5
  startDate:      "when they'd like care to start (e.g. 'ASAP', 'next Monday', 'June 1')",
  selectedDays:   "which days of the week — save as an array e.g. ['MON','WED','FRI'] or ['MON','TUE','WED','THU','FRI']",
  timeOfDay:      "what time of day — morning (6am–12pm), afternoon (12pm–6pm), evening (6pm–12am), or overnight",
  // Step 8
  relationship:   "the family member's relationship to the person needing care (e.g. daughter, son, spouse)",
  // Step 9
  seniorName:     "the first and last name of the person who needs care",
  age:            "their age",
  additionalRecipients: "every OTHER person needing care when it's more than one (e.g. both mom and dad) — [{name, relationship, age}]",
  // Step 10
  emergencyContactName:         "the emergency contact's full name",
  emergencyContactPhone:        "the emergency contact's phone number",
  emergencyContactRelationship: "the emergency contact's relationship (e.g. son, neighbor)",
  // Step 11
  careNeeds:      "what kind of help is needed day to day (e.g. companionship, meals, bathing, medication reminders, transportation)",
  conditions:     "any diagnoses or conditions (e.g. Alzheimer's, Parkinson's) — optional",
  // Step 12
  rate:           "what they'd like to pay per hour — a number or 'flexible'",
  paymentMethod:  "how they plan to pay the caregiver — cash, Venmo, Zelle, or credit card",
  // Step 13
  jobDescription: "a short free-text description of the care situation (optional but helpful for caregivers)",
  // Collected throughout
  firstName:      "the family member's first name (the person texting)",
  hoursPerDay:    "how many hours per day",
  daysPerWeek:    "how many days per week (derived from selectedDays if available)",
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
  caregiverRateRangeText?: string,
): string {
  // Caregiver collection has its own directive (same structure + tone contract,
  // caregiver field checklist, plus the deterministic gate-handoff block).
  // caregiverRateRangeText: live market-rate hint (utils/marketRateRange) —
  // optional so this stays a pure function; omitted → static default.
  if (role === "caregiver") return buildCaregiverOnboardingDirective(onboardingData, caregiverRateRangeText);

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

  // Only the client reaches this point (caregiver delegated above).
  const audience = "family member";

  const action = missing.length
    ? `Ask for the SINGLE most natural next missing item — usually the first one listed. ` +
      `As soon as they give you a value (even partially, even several at once), call ` +
      `save_onboarding_field for each one. Then look at what's still missing and continue. ` +
      `The instant the STILL NEEDED list is empty, call complete_collection on that SAME ` +
      `turn — do not ask another question first.`
    : `Everything required is collected. Call complete_collection RIGHT NOW, before anything ` +
      `else this turn, then send ONE short warm line saying you've got what you need and you're ` +
      `pulling up caregivers near them now (that promise is safe — their matches are sent ` +
      `automatically right after your message). Keep it to one sentence, do NOT list fields back ` +
      `like a form, do NOT ask ANY question, and do NOT announce what you'll ask next — anything ` +
      `you ask here gets buried under the match cards that follow.`;

  return [
    `ONBOARDING IN PROGRESS — you are setting up this ${audience} over text, following the`,
    `same steps as the Evia web setup wizard. Your job is to collect the items below`,
    `naturally, like a real care coordinator — never a form, one question at a time.`,
    ``,
    `ALREADY KNOWN:`,
    knownLines,
    ``,
    `STILL NEEDED (collect in roughly this wizard order):`,
    missingLines,
    ``,
    `WIZARD QUESTION ORDER (follow this sequence, skip anything already known):`,
    `  1. How often care is needed (occasional / part-time / full-time)`,
    `  2. Their home address — street, zip, city, state (ask: "What's your home address?")`,
    `  3. Is care at the same address? — if YES: save homeCity→city, homeZipCode→zipCode, homeStreet→street, homeState→state too; if NO: ask for the care address separately`,
    `  4. When to start + which specific days + time of day`,
    `  5. Their relationship to the person needing care`,
    `  6. The senior's name and age (+ anyone else needing care)`,
    `  7. Emergency contact — name, phone, and their relationship`,
    `  8. What kind of help is needed day to day`,
    `  9. What they'd like to pay per hour`,
    ` 10. (Optional) A short description they'd like caregivers to see`,
    ` 11. The family member's own first name (if not already collected)`,
    ``,
    `HOW TO TALK:`,
    `  - You are mid-conversation. You already greeted them. NEVER greet again, never re-introduce yourself, never open with "Hi"/"Hey <name>". Reply directly.`,
    `  - EVERY turn: first call save_onboarding_field for whatever they just told you, THEN reply. A short or one-word answer to your last question IS that field's value — save it immediately.`,
    `  - Acknowledge what they just said before you ask the next thing. Reflect the story back when it's heavy — then ask.`,
    `  - One question per message. Never send a numbered list or ask for several things at once.`,
    `  - For selectedDays: save as an array of uppercase 3-letter codes e.g. ['MON','WED','FRI']. If they say "weekdays" save ['MON','TUE','WED','THU','FRI']; "weekends" → ['SAT','SUN']; "every day" → ['SUN','MON','TUE','WED','THU','FRI','SAT'].`,
    `  - For careFrequency: "a few times a month"/"occasionally" → "occasional"; "1-4 days/week"/"part time" → "part_time"; "5+ days"/"full time"/"every day" → "full_time".`,
    `  - When you ask what kind of help is needed, weave two or three natural examples — companionship, meals, bathing, rides, medication reminders. All care is NON-MEDICAL — never offer nursing or medical services.`,
    `  - For the emergency contact: ask naturally ("In case of an emergency, who should we reach out to?"). Save name as emergencyContactName, phone as emergencyContactPhone, their relation as emergencyContactRelationship.`,
    `  - For rate: ask what they'd like to pay per hour. Save the number as rate (e.g. 26) or "flexible" if they say that. Mention that families in the area typically pay $22–$30/hr if they seem unsure.
  - For startDate: when they give a date, acknowledge it as a TARGET or PREFERENCE — never say "X works" or imply availability is confirmed. Instead say something like "Got it, I'll aim for [date]" or "Noted — I'll look for someone available around then."`,
    `  - If they front-load several answers, save them all and skip ahead — don't re-ask.`,
    `  - Don't loop. If you've asked for the same item once and still don't have it, ask ONE more time differently, then move on — never ask the same question more than twice.`,
    `  - Figure out WHO is who: if they first name who NEEDS care (e.g. "my mom Jane") before their own name, that name is the senior's — save as seniorName, not firstName.
  - Age is optional — ask it naturally once but if they skip it or ask if it's required, tell them it's not and move on. Never insist on it.`,
    `  - SELF-CARE: if care is for themselves, save relationship as "self" and seniorName the same as firstName — never ask who they're caring for.`,
    `  - MULTIPLE LOVED ONES: first person → seniorName/relationship/age; everyone else → save_onboarding_field("additionalRecipients", [{name, relationship, age}]).`,
    `  - No chatbot phrasing. Never say "I'm here to help", "how can I assist you today", or call yourself an AI assistant.`,
    `  - Voice memos: offer ONCE warmly if their replies look effortful — "if typing is a pain, you can tap-and-hold to send a voice memo." Never repeat the offer.`,
    ``,
    `WHAT TO DO THIS TURN:`,
    `  ${action}`,
  ].join("\n");
}
