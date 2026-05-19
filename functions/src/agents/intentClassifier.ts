import Anthropic from "@anthropic-ai/sdk";
import { callClaudeWithRetry } from "../utils/claudeRetry";

export type Intent =
  | "STOP"
  | "TASK_REPLY"
  | "QUESTION"
  | "PERMISSION_UPDATE"
  | "REBOOK_REQUEST"
  | "CANCEL_REQUEST"
  | "MEMORY_QUERY"
  | "ADD_FAMILY_MEMBER"
  | "REMOVE_FAMILY_MEMBER"
  | "FACT_CORRECTION"
  | "FIND_CAREGIVER"
  | "PAUSE_SCHEDULE"
  | "CANCEL_SCHEDULE"
  | "BOOKING_CONFIRM"
  | "BOOKING_DECLINE"
  | "HIRE_CAREGIVER"
  | "CAREGIVER_DECLINE_JOB"
  | "SCHEDULE_REQUEST"
  | "TRIGGER_MANAGEMENT"
  | "CREDENTIAL_MANAGEMENT"
  | "POST_JOB"
  | "VIEW_MY_JOBS"
  | "VIEW_APPLICANTS"
  | "VIEW_JOURNAL"
  | "APPROVE_TIMESHEET"
  | "VIEW_EARNINGS"
  | "UPDATE_AVAILABILITY"
  | "BROWSE_JOB_BOARD";

const VALID_INTENTS = new Set<Intent>([
  "STOP", "TASK_REPLY", "PERMISSION_UPDATE", "REBOOK_REQUEST",
  "CANCEL_REQUEST", "MEMORY_QUERY", "ADD_FAMILY_MEMBER", "REMOVE_FAMILY_MEMBER",
  "FACT_CORRECTION", "FIND_CAREGIVER", "PAUSE_SCHEDULE", "CANCEL_SCHEDULE", "QUESTION",
  "BOOKING_CONFIRM", "BOOKING_DECLINE", "HIRE_CAREGIVER", "CAREGIVER_DECLINE_JOB",
  "SCHEDULE_REQUEST", "TRIGGER_MANAGEMENT", "CREDENTIAL_MANAGEMENT",
  "POST_JOB", "VIEW_MY_JOBS", "VIEW_APPLICANTS", "VIEW_JOURNAL",
  "APPROVE_TIMESHEET", "VIEW_EARNINGS", "UPDATE_AVAILABILITY", "BROWSE_JOB_BOARD",
]);

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// CANCEL is intentionally NOT here — it cancels a visit, not the account
const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "END"]);

export async function classifyIntent(
  text: string,
  hasPendingTask: boolean
): Promise<Intent> {
  const trimmed = text.trim().toUpperCase();

  if (STOP_WORDS.has(trimmed)) return "STOP";
  if (trimmed === "CANCEL") return "CANCEL_REQUEST";
  if (hasPendingTask && ["1", "2", "3"].includes(trimmed)) return "TASK_REPLY";

  try {
    const response = await callClaudeWithRetry(getClient(), {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system:
        "You classify a message sent to an AI care assistant named Cara. " +
        "Reply with exactly one word from this list: STOP, TASK_REPLY, BOOKING_CONFIRM, BOOKING_DECLINE, HIRE_CAREGIVER, CAREGIVER_DECLINE_JOB, PERMISSION_UPDATE, REBOOK_REQUEST, CANCEL_REQUEST, MEMORY_QUERY, ADD_FAMILY_MEMBER, REMOVE_FAMILY_MEMBER, FACT_CORRECTION, FIND_CAREGIVER, PAUSE_SCHEDULE, CANCEL_SCHEDULE, SCHEDULE_REQUEST, TRIGGER_MANAGEMENT, CREDENTIAL_MANAGEMENT, POST_JOB, VIEW_MY_JOBS, VIEW_APPLICANTS, VIEW_JOURNAL, APPROVE_TIMESHEET, VIEW_EARNINGS, UPDATE_AVAILABILITY, BROWSE_JOB_BOARD, QUESTION.\n" +
        "STOP = opting out of all messages.\n" +
        "TASK_REPLY = responding to a numbered list (1, 2, or 3).\n" +
        "BOOKING_CONFIRM = confirming or approving a booking, schedule, or action (e.g. 'yes', 'sure', 'sounds good', 'let's do it', 'book it', 'go ahead', 'that works', 'perfect', 'confirmed', 'ok', 'yep').\n" +
        "BOOKING_DECLINE = declining or rejecting a booking, schedule, or action (e.g. 'no', 'never mind', 'cancel that', 'don't book', 'skip it', 'not right now', 'actually no', 'forget it', 'nope').\n" +
        "HIRE_CAREGIVER = wanting to hire or proceed with a specific caregiver after an interview (e.g. 'hire Maria', 'let's go with James', 'I want to book Sarah', 'she was great, let's hire her').\n" +
        "CAREGIVER_DECLINE_JOB = a caregiver declining or passing on a job offer (e.g. 'I can\\'t take that', 'I\\'m not available', 'pass on that one', 'not interested', 'I\\'m unavailable that day', 'can\\'t do it').\n" +
        "PERMISSION_UPDATE = asking to stop/start/change a setting (e.g. 'stop weekly summaries').\n" +
        "REBOOK_REQUEST = asking to rebook a caregiver (e.g. 'book Maria again next week').\n" +
        "CANCEL_REQUEST = asking to cancel an upcoming visit (e.g. 'cancel Wednesday', 'cancel tomorrow\\'s visit').\n" +
        "MEMORY_QUERY = asking what Cara knows or remembers (e.g. 'what do you know about mom', 'what have you remembered', 'what\\'s in my file').\n" +
        "ADD_FAMILY_MEMBER = asking to add a family member to care updates (e.g. 'add my sister', 'include my brother John', 'add +1234567890 to updates').\n" +
        "REMOVE_FAMILY_MEMBER = asking to remove a family member from care updates (e.g. 'remove my sister', 'take John off the updates', 'remove +1234567890', 'stop sending updates to my brother').\n" +
        "FACT_CORRECTION = correcting a previously stated fact (e.g. 'actually mom is 82 not 78', 'I meant Tuesday not Monday', 'wait, her doctor is Dr. Chen not Dr. Lee').\n" +
        "FIND_CAREGIVER = asking to find, search for, or get a new caregiver (e.g. 'I need a caregiver', 'can you find someone', 'looking for help', 'find me a caregiver', 'we need a new caregiver', 'search for caregivers').\n" +
        "PAUSE_SCHEDULE = asking to pause or temporarily stop a recurring care schedule (e.g. 'pause the schedule', 'hold care for now', 'skip next few weeks', 'pause recurring visits').\n" +
        "CANCEL_SCHEDULE = asking to cancel/end a recurring care schedule permanently (e.g. 'cancel recurring care', 'stop the weekly schedule', 'end recurring visits', 'cancel the standing schedule').\n" +
        "SCHEDULE_REQUEST = asking Cara to set up a personal reminder (e.g. 'remind me every Monday about mom's medications', 'set a daily reminder at 8am', 'alert me every Friday afternoon').\n" +
        "TRIGGER_MANAGEMENT = viewing, listing, or cancelling existing personal reminders (e.g. 'show my reminders', 'list my alerts', 'cancel my medication reminder', 'delete the Monday reminder').\n" +
        "CREDENTIAL_MANAGEMENT = asking about stored portal logins (e.g. 'what logins do you have for me', 'remove my CVS login', 'update my MyChart password', 'do you have my Walgreens login', 'delete my insurance login').\n" +
        "POST_JOB = a client wanting to post a new care job (e.g. 'post a new job', 'I need to find a caregiver', 'can you post another listing', 'add a new care request', 'I want to hire someone new').\n" +
        "VIEW_MY_JOBS = a client asking about their own posted jobs (e.g. 'what jobs do I have posted', 'show my listings', 'see my care requests', 'which jobs are open', 'my job posts').\n" +
        "VIEW_APPLICANTS = a client asking who applied to a job (e.g. 'who applied', 'show me applicants', 'any caregivers interested', 'did anyone apply yet', 'applicants for my job').\n" +
        "VIEW_JOURNAL = a client asking to see care journal or visit notes (e.g. 'show me the care journal', 'what happened at the last visit', 'see the notes from today', 'what did the caregiver report', 'care updates').\n" +
        "APPROVE_TIMESHEET = a client wanting to approve shift hours or timesheets (e.g. 'approve the timesheet', 'review hours', 'approve payment', 'approve shift', 'caregiver submitted hours').\n" +
        "VIEW_EARNINGS = a caregiver asking about their pay or earnings (e.g. 'what have I earned', 'show my earnings', 'how much did I make this week', 'my balance', 'my payouts', 'my pay').\n" +
        "UPDATE_AVAILABILITY = a caregiver wanting to change their availability schedule (e.g. 'update my availability', 'change my schedule', 'not available Fridays anymore', 'add Monday to my availability', 'I am free on Tuesdays now').\n" +
        "BROWSE_JOB_BOARD = a caregiver wanting to see open jobs they can apply to (e.g. 'show me open jobs', 'any jobs available', 'job board', 'what jobs can I apply for', 'looking for work', 'find me a job').\n" +
        "QUESTION = anything else.",
      messages: [{ role: "user", content: text }],
    }, { timeoutMs: 8_000, maxAttempts: 3 });

    const label = (
      (response.content[0] as { text: string }).text ?? ""
    ).trim().toUpperCase() as Intent;

    if (VALID_INTENTS.has(label)) return label;

    console.warn("intentClassifier: unrecognized label from Claude", { label, preview: text.slice(0, 50) });
  } catch (err) {
    console.error("intentClassifier error:", err);
  }

  return "QUESTION";
}
