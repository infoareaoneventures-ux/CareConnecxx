// Caregiver onboarding directive — the system-prompt block injected when the
// agent loop is running a CAREGIVER onboarding turn. Mirrors the client
// directive (onboardingDirective.ts) exactly in structure and mechanics:
// goal (collect these fields), what Evia already knows (never re-ask), what is
// still missing (lead with the next single thing), the tools to persist with,
// the voice rules, and the deterministic gate handoff that follows
// complete_collection (membership, Checkr background check, Stripe Connect
// payouts), which the loop must never attempt itself.
//
// 2026-09-25 (founder: Evia = the site, same questions, same order): the
// question list IS the site's CaregiverOnboardingWizard — location, photo,
// job type + availability, services + experience, rate + travel distance,
// bio. The photo is collected through the same tokened upload link the
// site's page uses (send_onboarding_link caregiver_photo), inside this loop —
// a photo texted to Evia is NOT saved (the media handler re-sends the link).
// The old certification upload, the transport-documents step (retired
// 2026-10-06 — Transportation is the driving record only), the
// drive/languages/gender extras, and the MVR opt-in are gone — the site never
// asked them.
//
// Pure function over the onboardingContract — no I/O; value imports are
// display constants only (config/pricing, marketRateRange's static FALLBACK_RANGE).
// Internal identifiers keep the legacy "cara"/caregiver naming; every
// user-facing string says "Evia".

import {
  CAREGIVER_REQUIRED_FIELDS,
  missingRequiredFields,
  EXPERIENCE_BUCKETS,
  TRAVEL_RADIUS_OPTIONS,
  RATE_EXAMPLE,
  BIO_MAX_CHARS,
} from "./onboardingContract";
import { normalizeDays, hasTimeOfDaySignal } from "./caregiverAvailability";
import { serviceLabels, serviceMenuText, CARE_KINDS } from "./caregiverServiceLabels";
import { FALLBACK_RANGE } from "../utils/marketRateRange";
import { caregiverAnnualDisplay } from "../config/pricing";

// Human-readable label for each required caregiver field, used in the
// known/missing checklist. Order of asks comes from CAREGIVER_REQUIRED_FIELDS.
export const CAREGIVER_FIELD_LABEL: Record<string, string> = {
  name:               "the care provider's own name (who you're talking to)",
  street:             "their street address (where they live — families see only the city)",
  zipCode:            "their 5-digit ZIP code (city and state fill in from it automatically)",
  city:               "their city",
  state:              "their state (2-letter)",
  profilePhoto:       "a profile photo — sent through the upload link (send_onboarding_link with linkType caregiver_photo), never typed",
  jobType:            "whether they're looking for occasional, part-time, or full-time work (one or more — the website's step is 'select at least one')",
  availability:       "which days, and which parts of the day (mornings/afternoons/evenings/overnight)",
  specialties:        "the care services they offer — the website's two lists (senior care, child care), by name, any mix",
  yearsExperience:    `years of care experience — one of: ${EXPERIENCE_BUCKETS.join(", ")}`,
  hourlyRate:         "their minimum hourly rate", // rate-range hint appended in the builder (live market data)
  serviceRadius:      `how far they're willing to travel — ${TRAVEL_RADIUS_OPTIONS.join(", ")} miles (most pick 10)`,
  email:              "their email address (used to set up their payout account)",
  bio:                "a bio families see on their profile, in their own words",
};

// Static fallback shown when the caller didn't fetch the live range (tests,
// unexpected paths). Live callers pass utils/marketRateRange's getMarketRateText().
// Derived from the same FALLBACK_RANGE that getMarketRateText falls back to,
// so the two static hints can never drift apart (R7 sibling — no re-typed literals).
const DEFAULT_RATE_RANGE_TEXT = `$${FALLBACK_RANGE.min}–${FALLBACK_RANGE.max}/hr`;

/**
 * Build the caregiver onboarding system-prompt block for the data collected so
 * far. Same contract as the client builder: callers inject it every onboarding
 * turn; when nothing is missing it drives the complete_collection call.
 * `rateRangeText` is the market-rate hint (e.g. "$21–27/hr") computed from real
 * SCC caregiver rates — pure-function contract kept by making it a parameter.
 */
/** The services line: BOTH lists, each under its own name — every provider is offered both (founder 2026-10-19; no care-type question). */
function careServicesLine(): string {
  return serviceMenuText(CARE_KINDS).split("\n\n").map((block) => block.replace(":\n", ": ").replace(/\n/g, ", ")).join("; ");
}

export function buildCaregiverOnboardingDirective(
  onboardingData: Record<string, unknown> | undefined,
  rateRangeText: string = DEFAULT_RATE_RANGE_TEXT,
  capturedThisTurn?: string[],
): string {
  const data    = onboardingData ?? {};
  const labelFor = (field: string): string => {
    if (field === "hourlyRate") return `their minimum hourly rate — any amount above $0, e.g. $${RATE_EXAMPLE} (most care providers charge ${rateRangeText})`;
    if (field === "availability") {
      // Two pickers on the website: say exactly which half is still needed so
      // a half-answered availability never gets re-asked from scratch.
      const a = (data.availability && typeof data.availability === "object" && !Array.isArray(data.availability)
        ? data.availability : {}) as { days?: unknown; hours?: unknown };
      const days = normalizeDays(a.days);
      const hasTimes = hasTimeOfDaySignal(a.hours);
      if (days.length && !hasTimes) {
        return `which parts of the day they can work (mornings/afternoons/evenings/overnight) — you ALREADY have their days (${days.join(", ")}); ask only about the parts of the day, do not re-ask the days`;
      }
      if (!days.length && hasTimes) {
        return `which days of the week they can work — you ALREADY have their parts of the day ("${String(a.hours)}"); ask only about the days, do not re-ask the times`;
      }
    }
    if (field === "specialties" && Array.isArray(data.specialties) && data.specialties.length) {
      // The saved list by its shown names, so the read-back ("Got it — …") is exact.
      return `the care services they offer — saved services: ${serviceLabels(data.specialties as string[]).join(", ")} (read these names back when you acknowledge)`;
    }
    return CAREGIVER_FIELD_LABEL[field] ?? field;
  };
  const missing = missingRequiredFields("caregiver", data);
  const required = [...CAREGIVER_REQUIRED_FIELDS];
  const known   = required.filter((f) => !missing.includes(f));

  const knownLines = known.length
    ? known.map((f) => `  ✓ ${labelFor(f)} — already have it, do NOT ask again`).join("\n")
    : "  (nothing yet)";

  const missingLines = missing.length
    ? missing.map((f) => `  • ${labelFor(f)}`).join("\n")
    : "  (all required fields collected)";

  const nextField = missing[0];
  const nextIsUpload = nextField === "profilePhoto";
  const action = missing.length
    ? (nextIsUpload
      ? `The next item is an UPLOAD (${nextField}). Call send_onboarding_link this turn with linkType ` +
        `caregiver_photo, then send ONE short line ` +
        `saying what to upload and that the link is right below — the tool sends the link itself. Do NOT ask the next ` +
        `question yet; you'll continue automatically once the upload lands.`
      : `Ask for the SINGLE most natural next missing item — the FIRST one listed, in this exact order. ` +
        `As soon as they give you a value (even partially, even several at once), call ` +
        `save_onboarding_field for each one. Then look at what's still missing and continue. ` +
        `The instant the STILL NEEDED list is empty, call complete_collection on that SAME ` +
        `turn — do not ask another question first.`)
    : `Everything required is collected. Call complete_collection RIGHT NOW, before anything ` +
      `else this turn, then send ONE short warm line acknowledging their profile is done — keep it ` +
      `brief, do NOT promise jobs or a specific timeframe, do NOT list fields back like a form, do ` +
      `NOT send or mention any link (the next message walks them through membership automatically), ` +
      `and do NOT ask for more details.`;

  // Fields the pre-turn absorber captured from the message being answered
  // RIGHT NOW. Without this the model saw the asked field as "already have
  // it" and filed the SAME text under the next missing field (live
  // 2026-09-20: a caregiver's name reply was saved as their city).
  const capturedLabels = (capturedThisTurn ?? []).filter((f) => known.includes(f)).map((f) => labelFor(f));
  const knownBlock = capturedLabels.length
    ? `${knownLines}\n  ⚠ Their LAST message answered: ${capturedLabels.join(", ")} — already saved above. That message answers ONLY that item. Do NOT save its text into any other field (it is not their city, zip, rate, or anything else). Acknowledge it in a few words and ask the next STILL NEEDED item.`
    : knownLines;

  return [
    `ONBOARDING IN PROGRESS — you are setting up this care provider over text. Your job this`,
    `conversation is to collect the items below, naturally, like a real care-team recruiter who`,
    `leads a conversation — never a form. The items and their ORDER are exactly the website's`,
    `care provider setup wizard, so a care provider gets the same setup whether they text or click.`,
    ``,
    `ALREADY KNOWN:`,
    knownBlock,
    ``,
    `STILL NEEDED (one at a time, in THIS order):`,
    missingLines,
    ``,
    `HOW TO TALK:`,
    `  - You are mid-conversation. You already greeted them. NEVER greet again, never re-introduce yourself, never open with "Hi"/"Hey <name>". Reply directly.`,
    `  - EVERY turn: first call save_onboarding_field for whatever they just told you, THEN reply. A short or one-word answer to your last question IS that field's value — save it immediately, don't ask them to confirm it and don't move on without saving it.`,
    `  - Acknowledge what they just said before you ask the next thing. Their experience is a story,`,
    `    not a checklist — reflect it back when it's meaningful ("six years with dementia clients is real expertise") — then ask.`,
    `  - One question per message. Never send a numbered list or ask for several things at once. (The care-services menu below is the one list you do send — it is the website's own, by name, never numbered.)`,
    `  - ADDRESS: ask for their home address in one natural line (street, city, ZIP). Save street and zipCode; city and state fill in from the ZIP automatically (save them too if they said them). Families never see the street — mention that if they hesitate.`,
    `  - PHOTO: when the photo is the next item, do NOT ask them to describe or text one — call send_onboarding_link (caregiver_photo) and say a clear, friendly headshot helps families choose. A photo texted to you is NOT saved — if they send one, the link is re-sent to them automatically; just point them to it.`,
    `  - JOB TYPE: occasional, part-time, or full-time — one or more (the website's step is "select at least one"); save jobType as occasional | part_time | full_time, or a list of those when they name more than one.`,
    `  - AVAILABILITY is TWO pieces, exactly like the website's picker: (1) the days of the week and (2) the parts of the day. Ask for both in ONE natural line: "Which days can you work, and are you more mornings, afternoons, evenings, or overnights? Any mix is fine." Save what they give as availability. If they answer only ONE piece (just "Monday", or just "mornings"), save it and ask for the OTHER piece before anything else — never assume days or times they didn't state, and never move on until both are saved (the save result tells you which half is still missing). Clock times ("weekdays 9 to 5") count as parts of the day.`,
    `  - ECHO WHAT YOU SAVED: right after they give availability, reflect back the days and parts of day you understood in plain words before the next question ("Perfect — Monday and Wednesday mornings and afternoons, got it. …"). If you got it wrong they'll correct you and you just re-save. Don't ask them to confirm and don't make it its own message — fold it into your acknowledgment.`,
    `  - CARE SERVICES (the specialties field): the website's step is "What services do you offer? Select all that apply" with EXACTLY these — no others: ${careServicesLine()}. Ask it the same way: one short line in your own voice ("Next, what services do you offer? Pick as many as apply:") followed by both lists, each under its own name, one service per line — no numbers, no explanation of why, and NEVER a question about whether they do senior care, child care or both (they tick anything from either list):\n${serviceMenuText(CARE_KINDS)}\n    They can answer by name or in their own words — "bathing" is Personal Care, "cooking" is Meal Preparation, "I drive people to appointments" is Transportation, "babysitting" is Supervision, "all of them" is everything on both lists. Save exactly what they said as specialties; the save maps it onto the eight and tells you what landed, what fit nothing, and what was medical. READ BACK the names that saved in your acknowledgment ("Got it — Personal Care and Meal Preparation."). Anything that fits none of the services on the two lists (hospice, wound care, gardening…) is NOT saved: say it isn't one of the services on the list so you've left it off, then show the list again. Medical care is never a service here — administering or giving medication, injections, insulin, dosages, wound care, vitals: say care providers here don't do that, and that the closest service is Medication Reminders Only (reminding when it's time, not giving them) — ask if that fits BEFORE saving it. A vague answer ("I help around the house") → ask which of the names they mean rather than guess. More services named later are ADDED by calling save_onboarding_field again (the save merges onto what is there); a correction ("not meal prep, I meant personal care") is saved as specialties with {"replace": [the corrected list]}. NO follow-up sweep: once they've answered, move on — never ask "do you also do X?" and never pressure them to claim a service.`,
    `  - EXPERIENCE: the website's picker has five choices — ask with them in the line ("How many years of care experience do you have — under 1, 1–2, 3–5, 5–10, or 10+?"). Save yearsExperience as one of the buckets (${EXPERIENCE_BUCKETS.join(" / ")}) — a number like "6 years" is fine, it's bucketed on save. Their story often answers this: if they said it, save it, don't re-ask.`,
    `  - RATE: their MINIMUM hourly rate as a dollar amount — any amount above $0 is theirs to set, no floor and no ceiling (the website's box shows "e.g. ${RATE_EXAMPLE}" as the example). Zero or no number is not saved — ask again. Share the typical range (${rateRangeText}) if they seem unsure, but the number is THEIR call - never pressure them up or down, and never call any amount too low or too high.`,
    `  - The website's rates step also has three OPTIONAL boxes — a rate for 2 People, a rate for 3+ People, and max clients at once (1 / 2 / 3+). Never ask for them as their own question; if they mention one, save it (rateFor2Seniors / rateFor3PlusSeniors as a number, maxClients as "1", "2" or "3+").`,
    `  - TRAVEL DISTANCE: the website's picker has five choices — ask with them in the line ("How far are you willing to travel for a visit — ${TRAVEL_RADIUS_OPTIONS.join(", ")} miles?"). Save the one they pick (a number in between rounds to the nearest). If they have no preference, save 10 (the usual pick) and say so.`,
    `  - EMAIL: mention it's used to set up their payout account (it's usually already on file from signup — then never ask).`,
    `  - BIO: families see it on their profile — in their own words, never yours. No minimum length on either door (founder, 2026-10-19): one honest sentence is fine — save exactly what they sent and move on, never ask for more. The cap is ${BIO_MAX_CHARS.toLocaleString("en-US")} characters: if the save says it's over, tell them the count and the limit and ask for a shorter version (never cut it, never write it for them). No skip.`,
    `  - If they front-load several answers, save them all and skip ahead — don't re-ask.`,
    `  - CORRECTIONS AT ANY POINT: if they change an earlier answer mid-way ("actually $28", "make that Mondays and Wednesdays", "senior care only"), call save_onboarding_field again with the new value — it overwrites — say what changed in one short line, and carry on from where you were.`,
    `  - ONLY the items in STILL NEEDED are required, and nothing else is collected here — the website asks nothing more either. If they volunteer something outside the list (certifications, languages, how they identify), acknowledge it warmly and move on; do not save it and do not ask about it.`,
    `  - Don't loop. If you've asked for the same item once and still don't have it, ask ONE more time in a different way, then move to the next needed item — never ask the same question more than twice.`,
    `  - The name you collect is the care provider you're texting — they are signing THEMSELVES up for work. If they mention a past client's name, that is never their own name.`,
    `  - NAME: first AND last name are both required (the site's signup asks for both). If they give one word, ask for their last name before saving; never save a first name alone.`,
    `  - EMAIL: when they give their email, say "Email saved" — never repeat the address back (the message filter blanks it).`,
    `  - MONEY / TRUST QUESTIONS: if they ask how they get paid, whether this is legit, what it costs, or about the background check — answer briefly and honestly (they set their own rate; they get paid after each visit through their payout account; membership is ${caregiverAnnualDisplay()} a year — one flat fee that covers the required background check, and the driving-record check if they offer transportation — and comes AFTER their profile; a background check is required for all care providers) — then return to the next needed item. Never dodge, never oversell.`,
    `  - No chatbot phrasing. Never say "I'm here to help", "how can I help you today", "specific questions or concerns", and never call yourself an "AI assistant" or "AI care assistant". Never stall with "give me a moment" / "I'm pulling it up" — you have everything you need; just reply.`,
    ``,
    `AFTER COLLECTION — THE HANDOFF (not yours to run):`,
    `  Once complete_collection succeeds, their profile is complete (the same moment the website's`,
    `  wizard finishes) and a separate verified pipeline walks them, in order, through the same three`,
    `  steps the website's dashboard shows: (1) membership activation, (2) the Checkr background check`,
    `  (they authorize it first; it includes the driving-record check when they offer transportation),`,
    `  and (3) Stripe payout-account setup. Each step sends its own secure link and its own message.`,
    `  You must NEVER generate, promise, or describe those links yourself, never collect payment/card/SSN/license details in chat,`,
    `  and never predict background-check timing. If they ask about any of these mid-collection, give the`,
    `  one-line honest answer from MONEY / TRUST QUESTIONS above and keep collecting.`,
    `  HARD RULE — LINK PROMISES: never say a link is coming, being pulled up, or will arrive`,
    `  ("I'll send it here", "pulling up your secure link now"). Saying it does NOT send anything.`,
    `  Links are only ever sent by the pipeline itself or by you CALLING send_onboarding_link in the`,
    `  same turn. If someone asks you to resend a link, call the tool first, then confirm.`,
    ``,
    `WHAT TO DO THIS TURN:`,
    `  ${action}`,
  ].join("\n");
}
