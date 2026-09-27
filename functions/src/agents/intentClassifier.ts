import { quickComplete } from "../utils/openaiClient";

// Safety net (2026-08-31): "find me a caregiver near me" and "find a
// cardiologist near me" share the same sentence shape, and the classifier
// occasionally mistakes the former for FIND_NEARBY_PROVIDER — which
// hard-deflects with a canned "Evia cannot search for providers" refusal that
// never reaches the real caregiver-matching tools (Evia's actual core job). A
// live family hit exactly this. A literal mention of "caregiver" always wins
// over that specific misclassification, regardless of what the model guessed.
export function isCaregiverSearchMisroutedAsProviderSearch(intent: Intent, text: string): boolean {
  return intent === "FIND_NEARBY_PROVIDER" && /\bcaregivers?\b/i.test(text);
}

export type Intent =
  | "STOP"
  | "HELP"
  | "TASK_REPLY"
  | "QUESTION"
  | "REBOOK_REQUEST"
  | "CANCEL_REQUEST"
  | "MEMORY_QUERY"
  | "FACT_CORRECTION"
  | "FIND_CAREGIVER"
  | "PAUSE_SCHEDULE"
  | "CANCEL_SCHEDULE"
  | "BOOKING_CONFIRM"
  | "BOOKING_DECLINE"
  | "HIRE_CAREGIVER"
  | "SCHEDULE_REQUEST"
  | "TRIGGER_MANAGEMENT"
  | "CREDENTIAL_MANAGEMENT"
  | "POST_JOB"
  | "VIEW_MY_JOBS"
  | "VIEW_APPLICANTS"
  | "VIEW_JOURNAL"
  | "VIEW_EARNINGS"
  | "UPDATE_AVAILABILITY"
  | "BROWSE_JOB_BOARD"
  | "RESCHEDULE_REQUEST"
  | "MODIFY_SCHEDULE"
  | "UPDATE_PAYMENT_METHOD"
  | "VIEW_INVOICE"
  | "VIEW_CARE_PLAN_HISTORY"
  | "FIND_REPLACEMENT"
  | "CANCEL_SHIFT"
  | "UPDATE_RATE"
  | "UPDATE_SKILLS"
  | "UPDATE_BIO"
  | "UPDATE_PHOTO"
  | "PAUSE_ACCOUNT"
  | "REACTIVATE"
  | "INSTANT_PAYOUT"
  | "FIND_NEARBY_PROVIDER"
  | "BOOK_DOCTOR_APPOINTMENT"
  | "PRESCRIPTION_REFILL"
  | "NEW_PRESCRIPTION"
  | "UPDATE_ONBOARDING";

const VALID_INTENTS = new Set<Intent>([
  "STOP", "HELP", "TASK_REPLY", "REBOOK_REQUEST",
  "CANCEL_REQUEST", "MEMORY_QUERY",
  "FACT_CORRECTION", "FIND_CAREGIVER", "PAUSE_SCHEDULE", "CANCEL_SCHEDULE", "QUESTION",
  "BOOKING_CONFIRM", "BOOKING_DECLINE", "HIRE_CAREGIVER",
  "SCHEDULE_REQUEST", "TRIGGER_MANAGEMENT", "CREDENTIAL_MANAGEMENT",
  "POST_JOB", "VIEW_MY_JOBS", "VIEW_APPLICANTS", "VIEW_JOURNAL",
  "VIEW_EARNINGS", "UPDATE_AVAILABILITY", "BROWSE_JOB_BOARD",
  "RESCHEDULE_REQUEST", "MODIFY_SCHEDULE", "UPDATE_PAYMENT_METHOD",
  "VIEW_INVOICE", "VIEW_CARE_PLAN_HISTORY",
  "FIND_REPLACEMENT",
  "CANCEL_SHIFT", "UPDATE_RATE", "UPDATE_SKILLS", "UPDATE_BIO", "UPDATE_PHOTO",
  "PAUSE_ACCOUNT", "REACTIVATE", "INSTANT_PAYOUT",
  "FIND_NEARBY_PROVIDER", "BOOK_DOCTOR_APPOINTMENT",
  "PRESCRIPTION_REFILL", "NEW_PRESCRIPTION",
  "UPDATE_ONBOARDING",
]);

// CANCEL is intentionally NOT here — it cancels a visit, not the account
const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "END"]);

// Classification result with a degradation flag. `degraded` is true when the
// LLM call failed, timed out, or returned an unrecognized label and we fell
// back to "QUESTION" — i.e. the QUESTION you got is a guess, not a decision.
// Callers MUST NOT take low-scrutiny fast paths (e.g. the runQuickReply
// trivial-greeting bypass) on a degraded classification; route to the full
// QA agent instead, which runs the complete safety pipeline.
export interface IntentClassification {
  intent:   Intent;
  degraded: boolean;
}

export async function classifyIntent(
  text: string,
  hasPendingTask: boolean
): Promise<Intent> {
  return (await classifyIntentDetailed(text, hasPendingTask)).intent;
}

export async function classifyIntentDetailed(
  text: string,
  hasPendingTask: boolean
): Promise<IntentClassification> {
  const trimmed = text.trim().toUpperCase();

  if (STOP_WORDS.has(trimmed)) return { intent: "STOP", degraded: false };
  // Exact-string command (allowed without an LLM per the Evia rules, like STOP).
  // Only an exact match triggers it — "help me find a caregiver" still routes to the LLM.
  if (trimmed === "HELP" || trimmed === "/HELP" || trimmed === "CAPABILITIES" || trimmed === "/CAPABILITIES") {
    return { intent: "HELP", degraded: false };
  }
  if (trimmed === "CANCEL") return { intent: "CANCEL_REQUEST", degraded: false };
  if (hasPendingTask && ["1", "2", "3"].includes(trimmed)) return { intent: "TASK_REPLY", degraded: false };

  // Retry once on a failed / timed-out / garbled attempt before degrading — a
  // transient OpenAI timeout must not silently downgrade routing to QUESTION
  // (which then skips the fast-path bypass and over-binds the QA agent).
  for (let attempt = 0; attempt < 2; attempt++) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const raw = await quickComplete(
        "You classify a message sent to a care coordinator named Evia. " +
        "Reply with exactly one word from this list: STOP, TASK_REPLY, BOOKING_CONFIRM, BOOKING_DECLINE, HIRE_CAREGIVER, REBOOK_REQUEST, CANCEL_REQUEST, MEMORY_QUERY, FACT_CORRECTION, FIND_CAREGIVER, PAUSE_SCHEDULE, CANCEL_SCHEDULE, SCHEDULE_REQUEST, TRIGGER_MANAGEMENT, CREDENTIAL_MANAGEMENT, POST_JOB, VIEW_MY_JOBS, VIEW_APPLICANTS, VIEW_JOURNAL, VIEW_EARNINGS, UPDATE_AVAILABILITY, BROWSE_JOB_BOARD, RESCHEDULE_REQUEST, MODIFY_SCHEDULE, UPDATE_PAYMENT_METHOD, VIEW_INVOICE, VIEW_CARE_PLAN_HISTORY, FIND_REPLACEMENT, CANCEL_SHIFT, UPDATE_RATE, UPDATE_SKILLS, UPDATE_BIO, UPDATE_PHOTO, PAUSE_ACCOUNT, REACTIVATE, INSTANT_PAYOUT, FIND_NEARBY_PROVIDER, BOOK_DOCTOR_APPOINTMENT, PRESCRIPTION_REFILL, NEW_PRESCRIPTION, UPDATE_ONBOARDING, QUESTION.\n" +
        "STOP = opting out of all messages.\n" +
        "TASK_REPLY = responding to a numbered list (1, 2, or 3).\n" +
        "BOOKING_CONFIRM = confirming or approving a booking, schedule, or action (e.g. 'yes', 'sure', 'sounds good', 'let's do it', 'book it', 'go ahead', 'that works', 'perfect', 'confirmed', 'ok', 'yep').\n" +
        "BOOKING_DECLINE = declining or rejecting a booking, schedule, or action (e.g. 'no', 'never mind', 'cancel that', 'don't book', 'skip it', 'not right now', 'actually no', 'forget it', 'nope').\n" +
        "HIRE_CAREGIVER = wanting to hire or proceed with a specific caregiver after an interview (e.g. 'hire Maria', 'let's go with James', 'I want to book Sarah', 'she was great, let's hire her').\n" +
        "REBOOK_REQUEST = asking to rebook or RESEND a booking with a caregiver they already have a request or booking with (e.g. 'book Maria again next week', 'can you resend the booking', 'send the booking to Basra again', 'rebook her').\n" +
        "CANCEL_REQUEST = asking to cancel an upcoming visit (e.g. 'cancel Wednesday', 'cancel tomorrow\\'s visit').\n" +
        "MEMORY_QUERY = asking what Evia knows or remembers (e.g. 'what do you know about mom', 'what have you remembered', 'what\\'s in my file').\n" +
        "FACT_CORRECTION = correcting a previously stated fact (e.g. 'actually mom is 82 not 78', 'I meant Tuesday not Monday', 'wait, her doctor is Dr. Chen not Dr. Lee'). Only pick this when the message explicitly states a corrected value for something already on file — a live-data question (how many/is there/do you have) is never FACT_CORRECTION, even if it references a caregiver or a number. A corrected clock-in, clock-out, hours, or pay for a visit or timesheet ('can you change the clock in time to 10:03', 'she actually left at 10:40', 'the hours are wrong') is NEVER FACT_CORRECTION — pick QUESTION so the agent proposes the correction on the timesheet.\n" +
        "FIND_CAREGIVER = asking to find, search for, or get a new caregiver/companion/home-care helper — Evia's own core service, NOT a medical provider (e.g. 'I need a caregiver', 'can you find someone', 'looking for help', 'find me a caregiver', 'find me a caregiver near me', 'any more caregivers nearby', 'is there another caregiver around me', 'we need a new caregiver', 'search for caregivers', 'how many caregivers do you have available', 'how many caregivers do you have around me', 'what caregivers are available near me'). This is a live lookup — always FIND_CAREGIVER, never FACT_CORRECTION, even though it starts with 'how many'.\n" +
        "PAUSE_SCHEDULE = asking to pause or temporarily stop a recurring care schedule (e.g. 'pause the schedule', 'hold care for now', 'skip next few weeks', 'pause recurring visits').\n" +
        "CANCEL_SCHEDULE = asking to cancel/end a recurring care schedule permanently (e.g. 'cancel recurring care', 'stop the weekly schedule', 'end recurring visits', 'cancel the standing schedule').\n" +
        "SCHEDULE_REQUEST = asking Evia to set up a personal reminder (e.g. 'remind me every Monday about mom's medications', 'set a daily reminder at 8am', 'alert me every Friday afternoon').\n" +
        "TRIGGER_MANAGEMENT = viewing, listing, or cancelling existing personal reminders (e.g. 'show my reminders', 'list my alerts', 'cancel my medication reminder', 'delete the Monday reminder').\n" +
        "CREDENTIAL_MANAGEMENT = asking about stored portal logins (e.g. 'what logins do you have for me', 'remove my CVS login', 'update my MyChart password', 'do you have my Walgreens login', 'delete my insurance login').\n" +
        "POST_JOB = a client wanting to post a new care job (e.g. 'post a new job', 'I need to find a caregiver', 'can you post another listing', 'add a new care request', 'I want to hire someone new').\n" +
        "VIEW_MY_JOBS = a client asking about their own posted jobs (e.g. 'what jobs do I have posted', 'show my listings', 'see my care requests', 'which jobs are open', 'my job posts').\n" +
        "VIEW_APPLICANTS = a client asking who applied to a job (e.g. 'who applied', 'show me applicants', 'any caregivers interested', 'did anyone apply yet', 'applicants for my job').\n" +
        "VIEW_JOURNAL = a client asking to see care journal or visit notes (e.g. 'show me the care journal', 'what happened at the last visit', 'see the notes from today', 'what did the caregiver report', 'care updates').\n" +
        "VIEW_EARNINGS = a caregiver asking about their pay or earnings (e.g. 'what have I earned', 'show my earnings', 'how much did I make this week', 'my balance', 'my payouts', 'my pay').\n" +
        "UPDATE_AVAILABILITY = a caregiver wanting to change their availability schedule (e.g. 'update my availability', 'change my schedule', 'not available Fridays anymore', 'add Monday to my availability', 'I am free on Tuesdays now').\n" +
        "BROWSE_JOB_BOARD = a caregiver wanting to see open jobs they can apply to (e.g. 'show me open jobs', 'any jobs available', 'job board', 'what jobs can I apply for', 'looking for work', 'find me a job').\n" +
        "RESCHEDULE_REQUEST = a client wanting to move an existing appointment to a different date or time (e.g. 'reschedule Wednesday to Friday', 'move tomorrow\\'s visit to next week', 'can we switch the Monday appointment to Tuesday', 'change the appointment time').\n" +
        "MODIFY_SCHEDULE = a client wanting to change the days or times of their recurring care schedule — NOT a one-time appointment (e.g. 'change my recurring Mondays to Tuesdays', 'move weekly care from morning to afternoon', 'swap my Thursday visits to Fridays going forward', 'change the schedule days').\n" +
        "UPDATE_PAYMENT_METHOD = a client wanting to update or change their billing or payment method (e.g. 'update my card', 'change my credit card', 'my card expired', 'update billing', 'add a new payment method', 'my payment failed').\n" +
        "VIEW_INVOICE = a client asking what they were charged or paid for care — the Timesheets page's History tab (e.g. 'show my bill', 'what was I charged for', 'what did I pay for', 'how much did I pay Basra last month', 'my payment history', 'approve the timesheet', 'any hours to approve').\n" +
        "VIEW_CARE_PLAN_HISTORY = a client asking about changes to the care plan or wanting to see past versions (e.g. 'what changed in the care plan', 'show care plan history', 'who updated the care plan', 'restore old care plan', 'show previous care plan').\n" +
        "FIND_REPLACEMENT = a client asking to find or send a replacement/cover for a visit their caregiver CANCELLED — a visit showing 'Needs Replacement' (e.g. 'find a replacement for Tuesday', 'who is available for replacement', 'can someone cover the visit Basra cancelled', 'find replacement', 'I need someone to cover tomorrow's cancelled visit'). This is the website's Find Replacement button, not a general caregiver search (FIND_CAREGIVER) — swapping a still-active caregiver is not something the site offers; a family asking for that is answered by the Q&A agent (cancel the visit, or wait for the caregiver to cancel).\n" +
        "CANCEL_SHIFT = a caregiver wanting to proactively cancel one of their own upcoming shifts (e.g. 'I need to cancel my Tuesday shift', 'cancel my Wednesday visit', 'I can't make my Friday appointment', 'I have to back out of tomorrow').\n" +
        "UPDATE_RATE = a caregiver wanting to change their hourly rate (e.g. 'change my rate to $28', 'update my hourly to 25', 'I want to raise my rate', 'set my pay to $30/hr').\n" +
        "UPDATE_SKILLS = a caregiver wanting to add or remove care specialties/skills on their profile (e.g. 'add dementia care to my skills', 'remove mobility from my specialties', 'I can also do post-surgery now', 'I'm now certified in hospice care').\n" +
        "UPDATE_BIO = a caregiver wanting to update their bio or profile description (e.g. 'change my bio', 'update my profile description', 'rewrite my about-me', 'my bio is wrong').\n" +
        "UPDATE_PHOTO = a caregiver wanting to update their profile photo (e.g. 'change my photo', 'update my profile picture', 'new headshot', 'replace my photo').\n" +
        "PAUSE_ACCOUNT = a caregiver wanting to pause their account / go on vacation / temporarily stop receiving job matches (e.g. 'going on vacation Jul 5-12', 'pause my account', 'I need a break for two weeks', 'stop sending me jobs for a month', 'I'm taking time off').\n" +
        "REACTIVATE = a caregiver wanting to come back from a pause / vacation mode and start receiving jobs again (e.g. 'I'm back', 'reactivate me', 'unpause my account', 'I want to start taking jobs again').\n" +
        "INSTANT_PAYOUT = a caregiver requesting an instant payout of their available balance (e.g. 'PAYOUT', 'cash out now', 'instant payout', 'send me my money now', 'pay me out today').\n" +
        "FIND_NEARBY_PROVIDER = asking to find or locate a nearby MEDICAL provider — doctor, clinic, hospital, pharmacy, urgent care, dentist, or specialist (e.g. 'find a cardiologist near me', 'closest pharmacy to mom', 'any urgent care nearby', 'find a clinic in Atlanta', 'where can I find a dermatologist close by'). Do NOT use this for a caregiver/companion/home-care aide search — 'find me a caregiver near me', 'any caregivers nearby', 'is there another caregiver around me' are FIND_CAREGIVER, never this, even though the sentence shape ('find X near me') looks the same.\n" +
        "BOOK_DOCTOR_APPOINTMENT = asking Evia to book or schedule a doctor appointment on their behalf (e.g. 'book an appointment with Dr. Smith', 'schedule a checkup for mom', 'can you make an appointment with my doctor', 'book me in with Dr. Johnson next week', 'I need to see a doctor — can you book it').\n" +
        "PRESCRIPTION_REFILL = asking Evia to refill or renew an existing prescription at a pharmacy (e.g. 'refill mom's blood pressure medication', 'can you renew my prescription at CVS', 'I need a refill on Lisinopril', 'refill my prescription', 'request a refill at Walgreens', 'renew dad's medication').\n" +
        "NEW_PRESCRIPTION = asking for a brand new prescription for a new condition or medication not previously prescribed (e.g. 'I need a prescription for anxiety', 'get me a prescription for something for the pain', 'mom needs a prescription for her new diagnosis', 'can you help me get a new prescription').\n" +
        "UPDATE_ONBOARDING = an already-onboarded family member wants to redo, fix, restart, or update the profile/onboarding info on file (senior name, age, city, care needs, etc.) — NOT a one-field correction (those are FACT_CORRECTION). Use this when the user references the whole setup as wrong, missing, or never finished (e.g. 'can you help me redo my onboarding', 'redo my profile', 'start over with my info', 'the onboarding never happened', 'that never happened, can you help me onboard', 'fix what's on file', 'my info is wrong', 'update what you know about mom', 'walk me through onboarding again', 'I never finished setting up').\n" +
        "QUESTION = anything else.",
      text,
      { maxTokens: 10, signal: controller.signal },
    );
    clearTimeout(timer);

    const label = raw.trim().toUpperCase() as Intent;
    if (VALID_INTENTS.has(label)) return { intent: label, degraded: false };

    console.warn("intentClassifier: unrecognized label", { label, attempt, preview: text.slice(0, 50) });
  } catch (err) {
    clearTimeout(timer);
    console.error("intentClassifier error:", { attempt, err });
  }
    // Brief backoff before the single retry; no delay after the final attempt.
    if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
  }

  // Degraded fallback — both attempts failed, so "QUESTION" is a guess.
  return { intent: "QUESTION", degraded: true };
}
