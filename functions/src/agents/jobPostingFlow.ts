import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { sendMessage, AgentSession } from "../linq/client";
import { buildAndSaveJobPost } from "./buildJobPost";
import { isConvergenceFlipped } from "../config/featureFlags";

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
      system:     prompt,
      messages:   [{ role: "user", content: userText }],
    });
    return ((response.content[0] as { text: string }).text ?? "").trim();
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

async function answerQuestionMidFlow(text: string, session: AgentSession): Promise<string> {
  const d = (session as any).onboardingData as Record<string, unknown> ?? {};
  const response = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system:
      "You are Cara, an AI care assistant helping a client post a care job. " +
      `They are setting up a job for ${(d.seniorName as string) ?? "their loved one"}. ` +
      "Answer briefly (1–2 sentences). Be warm and helpful.",
    messages: [{ role: "user", content: text }],
  });
  return ((response.content[0] as { text: string }).text ?? "").trim();
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
  await db.collection("agent_sessions").doc(phone).update({
    jobPostingStep: "jp_ask_start",
    jobPostingData: {},
    stateExpiresAt: expiresAt,
  });
  await sendMessage(chatId,
    `Let's post a new care job for ${name}! 🎉\n\nWhen would you like care to start? (e.g. "next Monday", "ASAP", "June 1")`
  );
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
    `Got it — starting ${stored}! How often do you need help?\n\n` +
    "1️⃣  Occasional (1–2 days/week)\n" +
    "2️⃣  Part-time (3–4 days/week)\n" +
    "3️⃣  Full-time (5+ days/week)"
  );
}

async function handleJpAskFrequency(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId,
      "How often do you need help?\n\n" +
      "1️⃣  Occasional (1–2 days/week)\n" +
      "2️⃣  Part-time (3–4 days/week)\n" +
      "3️⃣  Full-time (5+ days/week)"
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
    `${days.length === 7 ? "Every day" : days.join(", ")} — perfect! What time of day works best?\n\n` +
    "Reply with one or more:\n\n" +
    "1️⃣  Morning (6am–noon)\n" +
    "2️⃣  Afternoon (noon–6pm)\n" +
    "3️⃣  Evening (6pm–10pm)\n" +
    "4️⃣  Overnight"
  );
}

async function handleJpAskTime(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId,
      "What time of day works best?\n\n" +
      "1️⃣  Morning (6am–noon)\n" +
      "2️⃣  Afternoon (noon–6pm)\n" +
      "3️⃣  Evening (6pm–10pm)\n" +
      "4️⃣  Overnight"
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
    `What kind of care does ${name} need? Reply with any that apply:\n\n` +
    "• Personal care (bathing, grooming)\n" +
    "• Mobility assistance\n" +
    "• Memory care\n" +
    "• Medication reminders\n" +
    "• Meal preparation\n" +
    "• Transportation\n" +
    "• Companionship\n" +
    "• Light housekeeping"
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
    `${needsLabel} — great choices! How intensive is the care?\n\n` +
    "1️⃣  Light — minimal assistance, mostly companionship\n" +
    "2️⃣  Moderate — daily help with several tasks\n" +
    "3️⃣  Full care — hands-on help most of the day"
  );
}

async function handleJpAskCareLevel(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId,
      "How intensive is the care?\n\n" +
      "1️⃣  Light\n2️⃣  Moderate\n3️⃣  Full care"
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
    `${rateLabel} — sounds good! How would you prefer to pay?\n\n` +
    "1️⃣  Card (processed through CareConnex)\n" +
    "2️⃣  Cash"
  );
}

async function handleJpAskPayMethod(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, "How would you prefer to pay?\n\n1️⃣  Card\n2️⃣  Cash");
    return;
  }
  const raw = await parseWithClaude(
    '"1", card, credit, debit, online, CareConnex = card. "2", cash, in person = cash. ' +
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
    await sendMessage(chatId, "No problem! Text me anytime when you're ready to post a new job.");
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
    await sendMessage(chatId, "I couldn't find your account. Please try again or visit the app to post.");
    return;
  }

  try {
    const onboardingData = ((session as any).onboardingData as Record<string, unknown>) ?? {};
    const jobData        = await getJobData(phone);
    const jobId = await buildAndSaveJobPost({ uid, phone, onboardingData, jobData });

    await db.collection("agent_sessions").doc(phone).update({
      jobPostingStep: admin.firestore.FieldValue.delete(),
      jobPostingData:  admin.firestore.FieldValue.delete(),
      stateExpiresAt: admin.firestore.FieldValue.delete(),
    });

    await sendMessage(chatId,
      `Your care request is live! Caregivers in your area are being notified.\n\n` +
      `I'll let you know when applications come in. You can also view your post at any time by texting me "show my jobs".\n\n` +
      `Job ID: ${jobId}`
    );
  } catch (err) {
    console.error("[jobPostingFlow] buildAndSaveJobPost error:", err);
    await sendMessage(chatId,
      "Sorry, I ran into a problem posting your job. Please try again or visit the app directly."
    );
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
