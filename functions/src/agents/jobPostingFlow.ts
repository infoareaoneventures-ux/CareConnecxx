import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { sendMessage, AgentSession } from "../linq/client";
import { buildAndSaveJobPost, jobLiveMessage, notifiedOutcomePhrase } from "./buildJobPost";
import { isConvergenceFlipped, caraOutputGuardEnabled } from "../config/featureFlags";
import { generateCaraMessage } from "../utils/caraMessage";
import { describeWhoIsWho } from "./careRecipients";
import { guardModelOutput, ANTI_INVENTION_CLAUSE } from "../safety/outputGuard";

const db = admin.firestore();

// ── Prompt-driven sequencing (U13) — DARK behind CONVERGENCE_FLIPPED="job_posting" ─
// Same data-driven dispatch as the onboarding dispatcher (U12): the job-posting
// flow is a clean linear field-collection machine, so the next step is derived
// from which field is still missing rather than the stored cursor. The field
// schema below is the contract; jp_confirm_post (the terminal write) is the
// hand-off once every field is collected. Flag OFF (default) ⇒ live path unchanged.
export const JOB_POSTING_CONVERGENCE_FLOW = "job_posting";

const JP_STEP_ORDER: Array<{ step: string; field: string }> = [
  { step: "jp_ask_start",       field: "jobStartDate" },
  { step: "jp_ask_frequency",   field: "jobFrequency" },
  { step: "jp_ask_days",        field: "jobDays" },
  { step: "jp_ask_time",        field: "jobTimeOfDay" },
  { step: "jp_ask_care_needs",  field: "jobCareNeeds" },
  { step: "jp_ask_care_level",  field: "jobCareLevel" },
  { step: "jp_ask_environment", field: "petsInHome" },
  { step: "jp_ask_rate",        field: "jobHourlyRate" },
  { step: "jp_ask_pay_method",  field: "jobPaymentMethod" },
  { step: "jp_ask_description", field: "jobDescription" },
];
const JP_POST_COLLECTION_STEP = "jp_confirm_post";

function jpFieldFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value))      return value.length > 0;
  return true; // numbers / booleans (incl. petsInHome:false) / objects count as set
}

// First step whose required field is still empty, else the terminal confirm step.
export function resolveJobStep(jobData: Record<string, unknown> | undefined): string {
  const data = jobData ?? {};
  for (const { step, field } of JP_STEP_ORDER) {
    if (!jpFieldFilled(data[field])) return step;
  }
  return JP_POST_COLLECTION_STEP;
}

export function isJobPostingDispatchEnabled(): boolean {
  return isConvergenceFlipped(JOB_POSTING_CONVERGENCE_FLOW);
}

function isDispatchableJobStep(step: string): boolean {
  return step === "" || JP_STEP_ORDER.some((s) => s.step === step);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function parseWithClaude(prompt: string, userText: string): Promise<string> {
  try {
    const response = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 200,
      // U2 (hallucination hardening): parse results are echoed back to the
      // user ("Got it — starting ${stored}!"), so this raw-output path carries
      // the shared anti-invention rule too.
      system:     prompt + "\n" + ANTI_INVENTION_CLAUSE,
      messages:   [{ role: "user", content: userText }],
    });
    const parsed = ((response.content[0] as { text: string }).text ?? "").trim();
    // Output guard (U2, R2): a meta-response/URL from the parser is a parse
    // failure — every call site already handles "__parse_error__" (raw text or
    // validated default). Kill switch: CARA_OUTPUT_GUARD_ENABLED=false.
    if (parsed && caraOutputGuardEnabled() && !guardModelOutput(parsed).ok) {
      return "__parse_error__";
    }
    return parsed;
  } catch {
    return "__parse_error__";
  }
}

async function isQuestionOrOther(text: string): Promise<boolean> {
  const result = await parseWithClaude(
    "Reply YES if this is a general question or off-topic comment unrelated to answering the current question. Reply NO if it is a direct answer. Only reply YES or NO.",
    text
  );
  return result.toUpperCase().startsWith("Y");
}

// U2: deterministic mid-flow fallback — sent instead of a guard-rejected model
// answer. The step handler re-asks the current question right after, so short
// honest copy is enough (mirrors humanReply's HUMAN_MIDFLOW_FALLBACK).
export const JP_MIDFLOW_FALLBACK = "Good question — I don't want to guess on that one.";

async function answerQuestionMidFlow(text: string, session: AgentSession): Promise<string> {
  const d = (session as any).onboardingData as Record<string, unknown> ?? {};
  const response = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system:
      "You are Evia, a care coordinator helping a client post a care job. " +
      `They are setting up a job for ${(d.seniorName as string) ?? "their loved one"}. ` +
      "Answer briefly (1–2 sentences). Be warm and helpful. " +
      "NEVER write out a URL or web address — a URL you compose will be wrong and dead — and never claim you " +
      "just sent, resent, or will send a link: real links are delivered by the system as separate tappable messages. " +
      ANTI_INVENTION_CLAUSE,
    messages: [{ role: "user", content: text }],
  });
  const answer = ((response.content[0] as { text: string }).text ?? "").trim();
  // Output guard (U2, R2): a meta-response or composed URL never reaches the
  // family's phone — the deterministic fallback goes out instead.
  if (answer && caraOutputGuardEnabled() && !guardModelOutput(answer).ok) {
    return JP_MIDFLOW_FALLBACK;
  }
  return answer;
}

async function getJobData(phone: string): Promise<Record<string, unknown>> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  return ((snap.data()?.jobPostingData ?? {}) as Record<string, unknown>);
}

async function mergeJobData(phone: string, data: Record<string, unknown>): Promise<void> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  const existing = (snap.data()?.jobPostingData ?? {}) as Record<string, unknown>;
  await db.collection("agent_sessions").doc(phone).update({
    jobPostingData: { ...existing, ...data },
  });
}

async function updateJobStep(phone: string, step: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({ jobPostingStep: step });
}

function seniorFirstName(session: AgentSession): string {
  const d = (session as any).onboardingData as Record<string, unknown> ?? {};
  const full = (d.seniorName as string) ?? "";
  return full.split(" ")[0] || "your loved one";
}

// ── Entry points ──────────────────────────────────────────────────────────────

export async function startJobPostingFlow(
  phone:   string,
  chatId:  string,
  session: AgentSession
): Promise<void> {
  const name = seniorFirstName(session);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  // R11: ground who's who — the job is care FOR the recipient, never for the
  // account holder posting it.
  const whoIsWho = describeWhoIsWho(((session as any).onboardingData ?? {}) as Record<string, unknown>);
  await db.collection("agent_sessions").doc(phone).update({
    jobPostingStep: "jp_ask_start",
    jobPostingData: {},
    stateExpiresAt: expiresAt,
  });
  const msg = await generateCaraMessage({
    audience: "family",
    language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
    context: (whoIsWho ? whoIsWho + " " : "") + `Kicking off posting a new care job for the senior named ${name}. This is the first question: ask when they'd like care to start, giving examples like "next Monday", "ASAP", or "June 1". Be warm and a little excited.`,
    fallback: `Let's post a new care job for ${name}! 🎉\n\nWhen would you like care to start? (e.g. "next Monday", "ASAP", "June 1")`,
    maxTokens: 90,
  });
  await sendMessage(chatId, msg);
}

export async function handleJobPostingStep(
  phone:   string,
  chatId:  string,
  text:    string,
  session: AgentSession
): Promise<void> {
  let step = (session as any).jobPostingStep as string ?? "";
  // U13 (DARK): derive the step from collected fields when the flag is on. Gate
  // step (jp_confirm_post) + all handlers unchanged; flag OFF ⇒ no change.
  if (isJobPostingDispatchEnabled() && isDispatchableJobStep(step)) {
    step = resolveJobStep((session as any).jobPostingData as Record<string, unknown> | undefined);
  }
  switch (step) {
    case "jp_ask_start":       return handleJpAskStart(phone, chatId, text, session);
    case "jp_ask_frequency":   return handleJpAskFrequency(phone, chatId, text, session);
    case "jp_ask_days":        return handleJpAskDays(phone, chatId, text, session);
    case "jp_ask_time":        return handleJpAskTime(phone, chatId, text, session);
    case "jp_ask_care_needs":  return handleJpAskCareNeeds(phone, chatId, text, session);
    case "jp_ask_care_level":  return handleJpAskCareLevel(phone, chatId, text, session);
    case "jp_ask_environment": return handleJpAskEnvironment(phone, chatId, text, session);
    case "jp_ask_rate":        return handleJpAskRate(phone, chatId, text, session);
    case "jp_ask_pay_method":  return handleJpAskPayMethod(phone, chatId, text, session);
    case "jp_ask_description": return handleJpAskDescription(phone, chatId, text, session);
    case "jp_confirm_post":    return handleJpConfirmPost(phone, chatId, text, session);
    default:
      await startJobPostingFlow(phone, chatId, session);
  }
}

// ── Step handlers ─────────────────────────────────────────────────────────────

async function handleJpAskStart(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, `When would you like care to start? (e.g. "next Monday", "ASAP", "June 1")`);
    return;
  }
  const startDate = await parseWithClaude(
    "Extract a start date from this message. If the user says 'ASAP', 'immediately', or 'now', return 'ASAP'. " +
    "Otherwise return the date in YYYY-MM-DD format if possible, or a plain description. Reply with just the date value.",
    text
  );
  const stored = startDate !== "__parse_error__" ? startDate : text.trim();
  await mergeJobData(phone, { jobStartDate: stored });
  await updateJobStep(phone, "jp_ask_frequency");
  await sendMessage(chatId,
    `Got it — starting ${stored}! How often do you need help — just occasional (a day or two a week), ` +
    `part-time (3–4 days), or full-time (5+ days)?`
  );
}

async function handleJpAskFrequency(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId,
      "So — how often do you need help? Occasional (1–2 days a week), part-time (3–4 days), or full-time (5+)?"
    );
    return;
  }
  const raw = await parseWithClaude(
    '"1", occasional, 1-2 days = occasional. ' +
    '"2", part-time, part time, 3-4 days = part_time. ' +
    '"3", full-time, full time, every day, 5+ days = full_time. ' +
    'Reply with exactly one of: occasional, part_time, full_time',
    text
  );
  const frequency = ["occasional", "part_time", "full_time"].includes(raw) ? raw : "occasional";
  const label: Record<string, string> = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
  await mergeJobData(phone, { jobFrequency: frequency });
  await updateJobStep(phone, "jp_ask_days");
  await sendMessage(chatId,
    `${label[frequency] ?? "Got it"}! Which days work best?\n\n(e.g. "Mon, Wed, Fri" or "weekdays" or "every day")`
  );
}

async function handleJpAskDays(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "Which days work best? (e.g. \"Mon, Wed, Fri\" or \"weekdays\")");
    return;
  }
  const raw = await parseWithClaude(
    'Extract days of the week as a JSON array using full names (Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday). ' +
    '"weekdays" or "mon-fri" = ["Monday","Tuesday","Wednesday","Thursday","Friday"]. ' +
    '"weekends" = ["Saturday","Sunday"]. ' +
    '"every day" or "daily" = all 7 days. ' +
    'Return only a JSON array, nothing else.',
    text
  );
  let days: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) days = parsed;
  } catch { /**/ }
  if (days.length === 0) days = ["Monday", "Wednesday", "Friday"];
  await mergeJobData(phone, { jobDays: days });
  await updateJobStep(phone, "jp_ask_time");
  await sendMessage(chatId,
    `${days.length === 7 ? "Every day" : days.join(", ")} — perfect! What time of day works best — ` +
    `mornings, afternoons, evenings, overnight, or a mix?`
  );
}

async function handleJpAskTime(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId,
      "So — what time of day works best? Mornings, afternoons, evenings, overnight, or a mix?"
    );
    return;
  }
  const raw = await parseWithClaude(
    'Extract time-of-day preferences as a JSON array. ' +
    '"1" or morning or am or 6am → "morning". ' +
    '"2" or afternoon or pm or noon → "afternoon". ' +
    '"3" or evening or night → "evening". ' +
    '"4" or overnight or graveyard → "overnight". ' +
    'Return a JSON array with one or more of: morning, afternoon, evening, overnight. ' +
    'Return only the JSON array.',
    text
  );
  let times: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    const valid = ["morning", "afternoon", "evening", "overnight"];
    if (Array.isArray(parsed)) times = parsed.filter((t: string) => valid.includes(t));
  } catch { /**/ }
  if (times.length === 0) times = ["morning"];
  const timeLabel = times.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" & ");
  await mergeJobData(phone, { jobTimeOfDay: times });
  await updateJobStep(phone, "jp_ask_care_needs");
  const name = seniorFirstName(session);
  await sendMessage(chatId,
    `${timeLabel} — noted!\n\n` +
    `What kind of care does ${name} need? Just tell me in your own words — things like personal care ` +
    `(bathing, grooming), mobility help, memory care, medication reminders, meals, rides, companionship, ` +
    `or light housekeeping.`
  );
}

async function handleJpAskCareNeeds(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    const name = seniorFirstName(session);
    await sendMessage(chatId,
      `What kind of care does ${name} need? (e.g. personal care, meals, companionship, mobility)`
    );
    return;
  }
  const raw = await parseWithClaude(
    'Extract care needs as a JSON array of strings. Map to these standard values: ' +
    '"Personal Care" (bathing, grooming, hygiene, dressing), ' +
    '"Mobility Assistance" (walking, transfers, fall prevention), ' +
    '"Memory Care" (dementia, Alzheimer\'s, cognitive support), ' +
    '"Medication Reminders" (meds, pills, prescriptions), ' +
    '"Meal Preparation" (cooking, meals, food, nutrition), ' +
    '"Transportation" (driving, errands, appointments), ' +
    '"Companionship" (social, activities, conversation), ' +
    '"Light Housekeeping" (cleaning, laundry, tidying). ' +
    'Return a JSON array of matching standard values, or an empty array. Only return the JSON array.',
    text
  );
  let careNeeds: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) careNeeds = parsed;
  } catch { /**/ }
  if (careNeeds.length === 0) careNeeds = ["Companionship"];
  const needsLabel = careNeeds.slice(0, 3).join(", ") + (careNeeds.length > 3 ? ` +${careNeeds.length - 3} more` : "");
  await mergeJobData(phone, { jobCareNeeds: careNeeds });
  await updateJobStep(phone, "jp_ask_care_level");
  await sendMessage(chatId,
    `${needsLabel} — great choices! How intensive is the care — pretty light (mostly companionship), ` +
    `moderate (daily help with several tasks), or full care (hands-on help most of the day)?`
  );
}

async function handleJpAskCareLevel(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId,
      "So — how intensive is the care? Light, moderate, or full care?"
    );
    return;
  }
  const raw = await parseWithClaude(
    '"1", light, minimal, easy, independent = light. ' +
    '"2", moderate, medium, some help = moderate. ' +
    '"3", full, intensive, heavy, lots of help = intensive. ' +
    'Reply with exactly one of: light, moderate, intensive',
    text
  );
  const careLevel = ["light", "moderate", "intensive"].includes(raw) ? raw : "moderate";
  const levelLabel: Record<string, string> = { light: "Light", moderate: "Moderate", intensive: "Full care" };
  await mergeJobData(phone, { jobCareLevel: careLevel });
  await updateJobStep(phone, "jp_ask_environment");
  await sendMessage(chatId,
    `${levelLabel[careLevel]} — got it! A couple quick home questions:\n\n` +
    "Are there any pets in the home? And does anyone smoke in the home?\n\n" +
    "(e.g. \"yes dog, no smoking\" or \"no pets, no smoke\" or \"cat yes, smoke no\")"
  );
}

async function handleJpAskEnvironment(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "Are there pets in the home? Does anyone smoke in the home?");
    return;
  }
  const rawPets = await parseWithClaude(
    'Does the message indicate there are pets in the home? ' +
    'Reply YES if pets are mentioned positively or if the user says yes to pets. ' +
    'Reply NO if no pets or user says no. Only reply YES or NO.',
    text
  );
  const rawSmoke = await parseWithClaude(
    'Does the message indicate there is smoking in the home? ' +
    'Reply YES if smoking is mentioned positively or the user says yes to smoking. ' +
    'Reply NO if no smoking or the user says no. Only reply YES or NO.',
    text
  );
  const petsInHome        = rawPets.toUpperCase().startsWith("Y");
  const smokingHousehold  = rawSmoke.toUpperCase().startsWith("Y");
  const petStr   = petsInHome       ? "pets ✓" : "no pets";
  const smokeStr = smokingHousehold ? "smoking ✓" : "no smoking";
  await mergeJobData(phone, { petsInHome, smokingHousehold });
  await updateJobStep(phone, "jp_ask_rate");
  await sendMessage(chatId,
    `Got it — ${petStr}, ${smokeStr}.\n\nWhat hourly rate are you offering? (e.g. "$20", "18 an hour", "flexible")`
  );
}

async function handleJpAskRate(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "What hourly rate are you offering? (e.g. \"$20\", \"18 an hour\", \"flexible\")");
    return;
  }
  const raw = await parseWithClaude(
    'Extract the hourly rate as a number. ' +
    'If the user says "flexible", "open", or "negotiable", return 0. ' +
    'Otherwise extract the dollar amount and return only the number (e.g. 20, 18.50). ' +
    'Return only the number or 0.',
    text
  );
  const rate = parseFloat(raw);
  const jobHourlyRate = isNaN(rate) ? 0 : rate;
  const rateLabel = jobHourlyRate > 0 ? `$${jobHourlyRate}/hr` : "flexible rate";
  await mergeJobData(phone, { jobHourlyRate });
  await updateJobStep(phone, "jp_ask_pay_method");
  await sendMessage(chatId,
    `${rateLabel} — sounds good! How would you prefer to pay — card (processed through Evia), or cash?`
  );
}

async function handleJpAskPayMethod(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "So — how would you prefer to pay? Card through Evia, or cash?");
    return;
  }
  const raw = await parseWithClaude(
    '"1", card, credit, debit, online, Evia = card. "2", cash, in person = cash. ' +
    'Reply with exactly one of: card, cash',
    text
  );
  const payMethod = ["card", "cash"].includes(raw) ? raw : "card";
  const methodLabel = payMethod === "cash" ? "Cash" : "Card";
  await mergeJobData(phone, { jobPaymentMethod: payMethod });
  await updateJobStep(phone, "jp_ask_description");
  const name = seniorFirstName(session);
  await sendMessage(chatId,
    `${methodLabel} — perfect! Last question: can you briefly describe a typical care day for ${name}?\n\n` +
    "(A sentence or two is great — this helps caregivers understand the role)"
  );
}

async function handleJpAskDescription(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    const name = seniorFirstName(session);
    await sendMessage(chatId, `Can you describe a typical care day for ${name}? A sentence or two is great.`);
    return;
  }
  const description = text.trim().slice(0, 500);
  await mergeJobData(phone, { jobDescription: description });
  await updateJobStep(phone, "jp_confirm_post");
  const jobData = await getJobData(phone);
  const summary = buildJobSummary(jobData, session);
  await sendMessage(chatId,
    `Here's your job post:\n\n${summary}\n\nReply YES to post it for caregivers to see, or NO to start over.`
  );
}

async function handleJpConfirmPost(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    const jobData = await getJobData(phone);
    const summary = buildJobSummary(jobData, session);
    await sendMessage(chatId,
      `Here's your job post:\n\n${summary}\n\nReply YES to post it for caregivers to see, or NO to start over.`
    );
    return;
  }

  const norm = await parseWithClaude(
    'The user is confirming or declining to post a job. ' +
    '"yes", "yep", "post it", "go ahead", "do it", "confirm", "looks good", "perfect" = YES. ' +
    '"no", "start over", "restart", "redo", "nope", "cancel" = NO. ' +
    'Reply with exactly YES or NO.',
    text
  );

  if (norm.toUpperCase() === "NO") {
    await db.collection("agent_sessions").doc(phone).update({
      jobPostingStep: admin.firestore.FieldValue.delete(),
      jobPostingData:  admin.firestore.FieldValue.delete(),
      stateExpiresAt: admin.firestore.FieldValue.delete(),
    });
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
      context: "The family decided not to post the care job right now. Warmly let them know that's completely fine and they can text you anytime when they're ready to post a new job.",
      fallback: "No problem! Text me anytime when you're ready to post a new job.",
      maxTokens: 80,
    }));
    return;
  }

  if (!norm.toUpperCase().startsWith("Y")) {
    const jobData = await getJobData(phone);
    const summary = buildJobSummary(jobData, session);
    await sendMessage(chatId,
      `Just to confirm — here's your job post:\n\n${summary}\n\nReply YES to post it or NO to cancel.`
    );
    return;
  }

  // YES — post the job
  const uid = (session as any).userId as string | undefined;
  if (!uid) {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
      context: "You hit a snag finding the family's account while trying to post their job. Warmly apologize, ask them to try again, and mention they can also post from the app. Keep it reassuring, not technical.",
      fallback: "I couldn't find your account. Please try again or visit the app to post.",
      maxTokens: 80,
    }));
    return;
  }

  try {
    const onboardingData = ((session as any).onboardingData as Record<string, unknown>) ?? {};
    const jobData        = await getJobData(phone);
    const { jobId, notifiedCount } = await buildAndSaveJobPost({ uid, phone, onboardingData, jobData });

    await db.collection("agent_sessions").doc(phone).update({
      jobPostingStep: admin.firestore.FieldValue.delete(),
      jobPostingData:  admin.firestore.FieldValue.delete(),
      stateExpiresAt: admin.firestore.FieldValue.delete(),
    });

    const city = ((jobData as any)?.city ?? (onboardingData as any)?.city ?? null) as string | null;
    const outcome = notifiedOutcomePhrase(city, notifiedCount);
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
      context: `The family's care request just went live. Reflect this EXACT outcome truthfully — do not overstate it: ${outcome}. Tell them you'll let them know when applications come in, and mention they can view their post anytime by texting you "show my jobs". You MUST include the exact phrase "show my jobs" and end with the line "Job ID: ${jobId}".`,
      fallback: `${jobLiveMessage(city, notifiedCount)}\n\nYou can view your post any time by texting me "show my jobs".\n\nJob ID: ${jobId}`,
      maxTokens: 130,
    }));
  } catch (err) {
    console.error("[jobPostingFlow] buildAndSaveJobPost error:", err);
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
      context: "Something went wrong while posting the family's job. Warmly apologize, ask them to try again, and mention they can also post directly in the app. Reassuring, not technical.",
      fallback: "Sorry, I ran into a problem posting your job. Please try again or visit the app directly.",
      maxTokens: 80,
    }));
  }
}

// ── Summary builder ───────────────────────────────────────────────────────────

function buildJobSummary(jobData: Record<string, unknown>, session: AgentSession): string {
  const name       = seniorFirstName(session);
  const startDate  = (jobData.jobStartDate  as string) ?? "TBD";
  const frequency  = (jobData.jobFrequency  as string) ?? "occasional";
  const days       = (jobData.jobDays       as string[]) ?? [];
  const times      = (jobData.jobTimeOfDay  as string[]) ?? [];
  const careNeeds  = (jobData.jobCareNeeds  as string[]) ?? [];
  const careLevel  = (jobData.jobCareLevel  as string)   ?? "moderate";
  const rate       = (jobData.jobHourlyRate as number)   ?? 0;
  const payMethod  = (jobData.jobPaymentMethod as string) ?? "card";
  const pets       = (jobData.petsInHome       as boolean) ? "yes" : "no";
  const smoking    = (jobData.smokingHousehold  as boolean) ? "yes" : "no";
  const desc       = (jobData.jobDescription as string) ?? "";

  const freqLabel: Record<string, string> = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
  const rateLabel  = rate > 0 ? `$${rate}/hr` : "Flexible";
  const daysLabel  = days.length > 0 ? days.join(", ") : "TBD";
  const timesLabel = times.length > 0
    ? times.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" & ")
    : "TBD";
  const needsLabel = careNeeds.length > 0 ? careNeeds.join(", ") : "General care";

  return [
    `👤 For: ${name}`,
    `📅 Start: ${startDate}`,
    `🔄 Frequency: ${freqLabel[frequency] ?? frequency}`,
    `📆 Days: ${daysLabel}`,
    `⏰ Time: ${timesLabel}`,
    `🩺 Care needs: ${needsLabel}`,
    `💪 Care level: ${careLevel.charAt(0).toUpperCase() + careLevel.slice(1)}`,
    `💵 Rate: ${rateLabel} (${payMethod})`,
    `🐾 Pets: ${pets} | 🚬 Smoking: ${smoking}`,
    desc ? `📝 "${desc}"` : "",
  ].filter(Boolean).join("\n");
}
