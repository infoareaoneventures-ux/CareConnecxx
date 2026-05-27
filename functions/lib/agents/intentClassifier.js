"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyIntent = classifyIntent;
const openaiClient_1 = require("../utils/openaiClient");
const VALID_INTENTS = new Set([
    "STOP", "TASK_REPLY", "PERMISSION_UPDATE", "REBOOK_REQUEST",
    "CANCEL_REQUEST", "MEMORY_QUERY", "ADD_FAMILY_MEMBER", "REMOVE_FAMILY_MEMBER",
    "FACT_CORRECTION", "FIND_CAREGIVER", "PAUSE_SCHEDULE", "CANCEL_SCHEDULE", "QUESTION",
    "BOOKING_CONFIRM", "BOOKING_DECLINE", "HIRE_CAREGIVER", "CAREGIVER_DECLINE_JOB",
    "SCHEDULE_REQUEST", "TRIGGER_MANAGEMENT", "CREDENTIAL_MANAGEMENT",
    "POST_JOB", "VIEW_MY_JOBS", "VIEW_APPLICANTS", "VIEW_JOURNAL",
    "APPROVE_TIMESHEET", "VIEW_EARNINGS", "UPDATE_AVAILABILITY", "BROWSE_JOB_BOARD",
    "RESCHEDULE_REQUEST", "MODIFY_SCHEDULE", "UPDATE_PAYMENT_METHOD",
    "REQUEST_REFUND", "VIEW_INVOICE", "VIEW_CARE_PLAN_HISTORY",
    "SWAP_REQUEST", "CLIENT_SWAP_REQUEST",
    "CANCEL_SHIFT", "UPDATE_RATE", "UPDATE_SKILLS", "UPDATE_BIO", "UPDATE_PHOTO",
    "PAUSE_ACCOUNT", "REACTIVATE", "INSTANT_PAYOUT",
    "FIND_NEARBY_PROVIDER", "BOOK_DOCTOR_APPOINTMENT",
    "PRESCRIPTION_REFILL", "NEW_PRESCRIPTION",
]);
// CANCEL is intentionally NOT here — it cancels a visit, not the account
const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "END"]);
async function classifyIntent(text, hasPendingTask) {
    const trimmed = text.trim().toUpperCase();
    if (STOP_WORDS.has(trimmed))
        return "STOP";
    if (trimmed === "CANCEL")
        return "CANCEL_REQUEST";
    if (hasPendingTask && ["1", "2", "3"].includes(trimmed))
        return "TASK_REPLY";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
        const raw = await (0, openaiClient_1.quickComplete)("You classify a message sent to an AI care assistant named Cara. " +
            "Reply with exactly one word from this list: STOP, TASK_REPLY, BOOKING_CONFIRM, BOOKING_DECLINE, HIRE_CAREGIVER, CAREGIVER_DECLINE_JOB, PERMISSION_UPDATE, REBOOK_REQUEST, CANCEL_REQUEST, MEMORY_QUERY, ADD_FAMILY_MEMBER, REMOVE_FAMILY_MEMBER, FACT_CORRECTION, FIND_CAREGIVER, PAUSE_SCHEDULE, CANCEL_SCHEDULE, SCHEDULE_REQUEST, TRIGGER_MANAGEMENT, CREDENTIAL_MANAGEMENT, POST_JOB, VIEW_MY_JOBS, VIEW_APPLICANTS, VIEW_JOURNAL, APPROVE_TIMESHEET, VIEW_EARNINGS, UPDATE_AVAILABILITY, BROWSE_JOB_BOARD, RESCHEDULE_REQUEST, MODIFY_SCHEDULE, UPDATE_PAYMENT_METHOD, REQUEST_REFUND, VIEW_INVOICE, VIEW_CARE_PLAN_HISTORY, SWAP_REQUEST, CLIENT_SWAP_REQUEST, CANCEL_SHIFT, UPDATE_RATE, UPDATE_SKILLS, UPDATE_BIO, UPDATE_PHOTO, PAUSE_ACCOUNT, REACTIVATE, INSTANT_PAYOUT, FIND_NEARBY_PROVIDER, BOOK_DOCTOR_APPOINTMENT, PRESCRIPTION_REFILL, NEW_PRESCRIPTION, QUESTION.\n" +
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
            "RESCHEDULE_REQUEST = a client wanting to move an existing appointment to a different date or time (e.g. 'reschedule Wednesday to Friday', 'move tomorrow\\'s visit to next week', 'can we switch the Monday appointment to Tuesday', 'change the appointment time').\n" +
            "MODIFY_SCHEDULE = a client wanting to change the days or times of their recurring care schedule — NOT a one-time appointment (e.g. 'change my recurring Mondays to Tuesdays', 'move weekly care from morning to afternoon', 'swap my Thursday visits to Fridays going forward', 'change the schedule days').\n" +
            "UPDATE_PAYMENT_METHOD = a client wanting to update or change their billing or payment method (e.g. 'update my card', 'change my credit card', 'my card expired', 'update billing', 'add a new payment method', 'my payment failed').\n" +
            "REQUEST_REFUND = a client asking for a refund on a visit (e.g. 'I want a refund', 'can I get my money back for Tuesday', 'charge me back for last visit', 'request refund for Wednesday visit').\n" +
            "VIEW_INVOICE = a client asking to see their bill or invoice details (e.g. 'show my bill', 'what was I charged for', 'see my invoice', 'itemized bill', 'what did I pay for', 'show my billing details').\n" +
            "VIEW_CARE_PLAN_HISTORY = a client asking about changes to the care plan or wanting to see past versions (e.g. 'what changed in the care plan', 'show care plan history', 'who updated the care plan', 'restore old care plan', 'show previous care plan').\n" +
            "SWAP_REQUEST = a caregiver wanting to swap, transfer, or find coverage for one of their shifts (e.g. 'can someone cover my Tuesday shift', 'I need someone to take my Wednesday visit', 'looking for coverage', 'can\\'t make Thursday need swap', 'swap my shift with someone').\n" +
            "CLIENT_SWAP_REQUEST = a client asking if a different caregiver can cover a specific date or visit (e.g. 'can someone else cover Thursday', 'I want a different caregiver for Friday', 'swap the caregiver for next Tuesday', 'can Maria cover instead of David').\n" +
            "CANCEL_SHIFT = a caregiver wanting to proactively cancel one of their own upcoming shifts (e.g. 'I need to cancel my Tuesday shift', 'cancel my Wednesday visit', 'I can't make my Friday appointment', 'I have to back out of tomorrow').\n" +
            "UPDATE_RATE = a caregiver wanting to change their hourly rate (e.g. 'change my rate to $28', 'update my hourly to 25', 'I want to raise my rate', 'set my pay to $30/hr').\n" +
            "UPDATE_SKILLS = a caregiver wanting to add or remove care specialties/skills on their profile (e.g. 'add dementia care to my skills', 'remove mobility from my specialties', 'I can also do post-surgery now', 'I'm now certified in hospice care').\n" +
            "UPDATE_BIO = a caregiver wanting to update their bio or profile description (e.g. 'change my bio', 'update my profile description', 'rewrite my about-me', 'my bio is wrong').\n" +
            "UPDATE_PHOTO = a caregiver wanting to update their profile photo (e.g. 'change my photo', 'update my profile picture', 'new headshot', 'replace my photo').\n" +
            "PAUSE_ACCOUNT = a caregiver wanting to pause their account / go on vacation / temporarily stop receiving job matches (e.g. 'going on vacation Jul 5-12', 'pause my account', 'I need a break for two weeks', 'stop sending me jobs for a month', 'I'm taking time off').\n" +
            "REACTIVATE = a caregiver wanting to come back from a pause / vacation mode and start receiving jobs again (e.g. 'I'm back', 'reactivate me', 'unpause my account', 'I want to start taking jobs again').\n" +
            "INSTANT_PAYOUT = a caregiver requesting an instant payout of their available balance (e.g. 'PAYOUT', 'cash out now', 'instant payout', 'send me my money now', 'pay me out today').\n" +
            "FIND_NEARBY_PROVIDER = asking to find or locate a nearby doctor, clinic, hospital, pharmacy, urgent care, dentist, or specialist (e.g. 'find a cardiologist near me', 'closest pharmacy to mom', 'any urgent care nearby', 'find a clinic in Atlanta', 'where can I find a dermatologist close by').\n" +
            "BOOK_DOCTOR_APPOINTMENT = asking Cara to book or schedule a doctor appointment on their behalf (e.g. 'book an appointment with Dr. Smith', 'schedule a checkup for mom', 'can you make an appointment with my doctor', 'book me in with Dr. Johnson next week', 'I need to see a doctor — can you book it').\n" +
            "PRESCRIPTION_REFILL = asking Cara to refill or renew an existing prescription at a pharmacy (e.g. 'refill mom's blood pressure medication', 'can you renew my prescription at CVS', 'I need a refill on Lisinopril', 'refill my prescription', 'request a refill at Walgreens', 'renew dad's medication').\n" +
            "NEW_PRESCRIPTION = asking for a brand new prescription for a new condition or medication not previously prescribed (e.g. 'I need a prescription for anxiety', 'get me a prescription for something for the pain', 'mom needs a prescription for her new diagnosis', 'can you help me get a new prescription').\n" +
            "QUESTION = anything else.", text, { maxTokens: 10, signal: controller.signal });
        clearTimeout(timer);
        const label = raw.trim().toUpperCase();
        if (VALID_INTENTS.has(label))
            return label;
        console.warn("intentClassifier: unrecognized label", { label, preview: text.slice(0, 50) });
    }
    catch (err) {
        clearTimeout(timer);
        console.error("intentClassifier error:", err);
    }
    return "QUESTION";
}
//# sourceMappingURL=intentClassifier.js.map