import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { sendMessage, AgentSession } from "../linq/client";
import { buildAndSaveJobPost, jobLiveMessage, notifiedOutcomePhrase } from "./buildJobPost";
import { defaultJobTitle } from "./jobPostContract";
import { isConvergenceFlipped, caraOutputGuardEnabled } from "../config/featureFlags";
import { generateCaraMessage } from "../utils/caraMessage";
import { describeWhoIsWho, allCareRecipients, recipientPlanKey } from "./careRecipients";
import { guardModelOutput, ANTI_INVENTION_CLAUSE } from "../safety/outputGuard";
import { describeSharedProfile } from "./profileBriefing";
import { deriveCareLevel } from "./clientJobPostingContract";
import { lookupZipPlace } from "../utils/geocode";

const db = admin.firestore();

// ── Prompt-driven sequencing (U13) — DARK behind CONVERGENCE_FLIPPED="job_posting" ─
// Same data-driven dispatch as the onboarding dispatcher (U12): the job-posting
// flow is a clean linear field-collection machine, so the next step is derived
// from which field is still missing rather than the stored cursor. The field
// schema below is the contract; jp_confirm_post (the terminal write) is the
// hand-off once every field is collected. Flag OFF (default) ⇒ live path unchanged.
//
// 2026-09-07: brought up to full parity with the website's own wizard order —
// PostJobFlow.tsx renders Step1Schedule.tsx BEFORE Step2WhoWhere.tsx (confirmed
// by both the component order and the wizard's own "Step 2 of 6" label on the
// who/where screen), so: frequency/start/days/time FIRST, THEN Step2WhoWhere.tsx
// ("who's receiving care?" — recipients, caregivers needed, location), THEN
// Step3CareNeeds.tsx → Step4Rate.tsx → Step5Describe.tsx. jp_ask_recipient_relationship and
// jp_ask_location_environment are deliberately NOT in JP_STEP_ORDER (same
// pattern as jp_confirm_post): they're reached only via an explicit
// updateJobStep call from within a handler, and isDispatchableJobStep excludes
// them so the U13 auto-resolver never overrides that literal cursor with a
// field-based guess mid-way through a conditional sub-step.
//
// jobCareLevel ("light/moderate/full care") is no longer its own question —
// the site's wizard has NO input anywhere that sets this field (it only ever
// displays it, read-only, on the final review screen), so nothing on the site
// can ever answer it either. It's still collected — derived automatically
// from care needs (deriveCareLevel), the same way the onboarding job-posting
// path (clientJobPostingContract.ts) already does.
//
// jobTitle (added 2026-09-07, revised same day per Hamse): the site's wizard
// auto-suggests "Senior care in {city}" (Step5Describe.tsx) and lets the
// family type their own before posting — but Evia deliberately does NOT ask a
// dedicated title question at all (Hamse's call: no need to surface something
// this low-stakes as its own conversational step). It's silently filled with
// that same site default the moment the address/city is known
// (jp_ask_location) — see defaultJobTitle in jobPostContract.ts — so an
// SMS-posted job's title matches what a site user gets by simply not
// bothering to customize the auto-suggestion.
export const JOB_POSTING_CONVERGENCE_FLOW = "job_posting";

const JP_STEP_ORDER: Array<{ step: string; field: string }> = [
  { step: "jp_ask_frequency",         field: "jobFrequency" },
  { step: "jp_ask_start",             field: "jobStartDate" },
  { step: "jp_ask_days",              field: "jobDays" },
  { step: "jp_ask_time",              field: "jobTimeOfDay" },
  { step: "jp_ask_recipients",        field: "careRecipients" },
  { step: "jp_ask_caregivers_needed", field: "caregiversNeeded" },
  { step: "jp_ask_location",          field: "streetAddress" },
  { step: "jp_ask_care_needs",        field: "jobCareNeeds" },
  { step: "jp_ask_rate",              field: "jobHourlyRate" },
  { step: "jp_ask_description",       field: "jobDescription" },
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

// ── Who/where data model ──────────────────────────────────────────────────────
// Mirrors Step2WhoWhere.tsx's own sourcing: job_postings/{uid} (primary +
// additionalRecipients + savedLocations) and carePlans/{uid}.locationPool are
// the SAME collections the site reads its picker options from, so a person or
// address added on the site shows up here too, and vice versa (buildJobPost.ts
// is what makes the "vice versa" half true — see its own comments).

export interface JobRecipient { firstName: string; lastName: string; relationship: string; isSelf: boolean; }
export interface JobLocation { street: string; city: string; state: string; zipCode: string; petsInHome: boolean; smokingHousehold: boolean; }

const RELATIONSHIP_CHIPS = ["Parent", "Spouse or Partner", "Other"];

// 2026-09-07 (live-caught): a parsed classification value ("occasional",
// "Parent", ...) was being matched against its expected enum with a plain,
// case-sensitive `.includes()` — Claude Haiku doesn't reliably return the
// exact requested casing even for a trivial single-word classification (a
// live test replying literally "occasional" twice got re-asked both times).
// This bug was invisible before the parse-failure re-ask fix (same commit)
// because the OLD code silently defaulted to "occasional" on any mismatch —
// which happened to be right by coincidence whenever the user's real answer
// WAS "occasional". Match case-insensitively, return the canonically-cased
// option so storage/display stays consistent either way.
function matchEnum(raw: string, options: string[]): string | null {
  const norm = raw.trim().toLowerCase();
  return options.find((o) => o.toLowerCase() === norm) ?? null;
}

async function fetchRecipientOptions(uid: string, onboardingData: Record<string, unknown>): Promise<JobRecipient[]> {
  const options: JobRecipient[] = [];
  const seen = new Set<string>();
  const addOpt = (o: JobRecipient) => {
    const key = recipientPlanKey(o.firstName, o.lastName);
    if (seen.has(key)) return;
    seen.add(key);
    options.push(o);
  };

  const accountName = ((onboardingData.firstName ?? onboardingData.name ?? "") as string).trim();
  const [accountFirst, ...accountRest] = accountName.split(/\s+/).filter(Boolean);
  addOpt({ firstName: accountFirst || "Me", lastName: accountRest.join(" "), relationship: "Myself", isSelf: true });

  for (const r of allCareRecipients(onboardingData)) {
    const [f, ...rest] = r.name.split(/\s+/).filter(Boolean);
    addOpt({ firstName: f || r.name, lastName: rest.join(" "), relationship: r.relationship ?? "", isSelf: false });
  }

  const jpSnap = await db.collection("job_postings").doc(uid).get().catch(() => null);
  if (jpSnap?.exists) {
    const jp = jpSnap.data() as Record<string, unknown>;
    const extra = Array.isArray(jp.additionalRecipients) ? jp.additionalRecipients as Array<Record<string, unknown>> : [];
    for (const r of extra) {
      const f = String(r.firstName ?? "").trim();
      if (!f) continue;
      addOpt({ firstName: f, lastName: String(r.lastName ?? ""), relationship: String(r.relationship ?? ""), isSelf: false });
    }
  }
  return options;
}

function formatRecipientOptions(options: JobRecipient[]): string {
  return options.map((o, i) =>
    `${i + 1}) ${o.isSelf ? "Myself" : `${o.firstName} ${o.lastName}`.trim()}${o.relationship && !o.isSelf ? ` (${o.relationship})` : ""}`
  ).join("\n");
}

async function fetchLocationOptions(uid: string, onboardingData: Record<string, unknown>): Promise<JobLocation[]> {
  const options: JobLocation[] = [];
  const seen = new Set<string>();
  const addLoc = (l: JobLocation) => {
    if (!l.street || !l.zipCode) return;
    const key = `${l.street.toLowerCase()}_${l.zipCode}`;
    if (seen.has(key)) return;
    seen.add(key);
    options.push(l);
  };

  const [jpSnap, cpSnap] = await Promise.all([
    db.collection("job_postings").doc(uid).get().catch(() => null),
    db.collection("carePlans").doc(uid).get().catch(() => null),
  ]);

  const poolFromCp = cpSnap?.exists
    ? (((cpSnap.data() as Record<string, unknown>).locationPool as Array<Record<string, unknown>> | undefined) ?? [])
    : [];
  const petsSmokeMap: Record<string, { petsInHome: boolean; smokingHousehold: boolean }> = {};
  for (const loc of poolFromCp) {
    const key = `${String(loc.street ?? "").toLowerCase()}_${loc.zipCode ?? ""}`;
    petsSmokeMap[key] = { petsInHome: loc.petsInHome === true, smokingHousehold: loc.smokingHousehold === true };
  }

  if (jpSnap?.exists) {
    const jp = jpSnap.data() as Record<string, unknown>;
    if (jp.street && jp.zipCode) {
      const key = `${String(jp.street).toLowerCase()}_${jp.zipCode}`;
      const ps = petsSmokeMap[key] ?? { petsInHome: jp.petsInHome === true, smokingHousehold: jp.smokingHousehold === true };
      addLoc({ street: String(jp.street), city: String(jp.city ?? ""), state: String(jp.state ?? ""), zipCode: String(jp.zipCode), ...ps });
    }
    const saved = Array.isArray(jp.savedLocations) ? jp.savedLocations as Array<Record<string, unknown>> : [];
    for (const loc of saved) {
      if (!loc.street || !loc.zipCode) continue;
      const key = `${String(loc.street).toLowerCase()}_${loc.zipCode}`;
      const ps = petsSmokeMap[key] ?? { petsInHome: false, smokingHousehold: false };
      addLoc({ street: String(loc.street), city: String(loc.city ?? ""), state: String(loc.state ?? ""), zipCode: String(loc.zipCode), ...ps });
    }
  }
  for (const loc of poolFromCp) {
    if (!loc.street || !loc.zipCode) continue;
    addLoc({ street: String(loc.street), city: String(loc.city ?? ""), state: String(loc.state ?? ""), zipCode: String(loc.zipCode), petsInHome: loc.petsInHome === true, smokingHousehold: loc.smokingHousehold === true });
  }

  // Brand-new account with nothing on file yet — offer the onboarding address
  // (if any) as a starting option instead of forcing a from-scratch re-entry.
  if (options.length === 0 && onboardingData.street && onboardingData.zipCode) {
    addLoc({
      street: String(onboardingData.street), city: String(onboardingData.city ?? ""),
      state: String(onboardingData.state ?? ""), zipCode: String(onboardingData.zipCode),
      petsInHome: onboardingData.petsInHome === true, smokingHousehold: onboardingData.smokingHousehold === true,
    });
  }
  return options;
}

function formatLocationOptions(options: JobLocation[]): string {
  return options.map((o, i) => `${i + 1}) ${o.street}, ${o.city} ${o.state} ${o.zipCode}`.trim()).join("\n");
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

// 2026-09-07: sent when a step's own extraction genuinely fails or comes back
// unrecognized (raw text that isn't a question and isn't a valid answer either
// — most often the user trying to CORRECT an earlier answer, e.g. "I said
// 9/14" mid-frequency-question). Previously every step silently substituted a
// hardcoded default (["Monday","Wednesday","Friday"], "moderate",
// ["Companionship"], flexible rate, etc.) and echoed it back as if it were the
// user's real answer — so a correction attempt was not just ignored, it was
// overwritten with a fabricated value the user never said. Re-asking instead
// means nothing gets merged/advanced until a real, recognized answer lands.
const JP_DIDNT_CATCH = "Sorry, I didn't quite catch that.";

async function answerQuestionMidFlow(text: string, session: AgentSession): Promise<string> {
  const d = (session as any).onboardingData as Record<string, unknown> ?? {};
  // Recall grounding — without it, "what city did I tell you?" gets a
  // grounded-sounding denial even though the answer is on the session.
  const sharedProfile = describeSharedProfile(session as any);
  const response = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system:
      "You are Evia, a care coordinator helping a client post a care job. " +
      `They are setting up a job for ${(d.seniorName as string) ?? "their loved one"}. ` +
      (sharedProfile ? `${sharedProfile} ` : "") +
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
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const onboardingData = (session as any).onboardingData as Record<string, unknown> ?? {};
  // R11: ground who's who — the job is care FOR the recipient, never for the
  // account holder posting it.
  const whoIsWho = describeWhoIsWho(onboardingData);
  await db.collection("agent_sessions").doc(phone).update({
    jobPostingStep: "jp_ask_frequency",
    jobPostingData: {},
    stateExpiresAt: expiresAt,
  });
  const msg = await generateCaraMessage({
    audience: "family",
    language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
    context: (whoIsWho ? whoIsWho + " " : "") +
      "Kicking off posting a new care job. First question: how often do they need help — just occasional (a day or two a week), part-time (3–4 days), or full-time (5+ days). Be warm and a little excited.",
    fallback: `Let's post a new care job! 🎉\n\nHow often do you need help — just occasional (a day or two a week), part-time (3–4 days), or full-time (5+ days)?`,
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
    case "jp_ask_recipients":            return handleJpAskRecipients(phone, chatId, text, session);
    case "jp_ask_recipient_relationship": return handleJpAskRecipientRelationship(phone, chatId, text, session);
    case "jp_ask_caregivers_needed":     return handleJpAskCaregiversNeeded(phone, chatId, text, session);
    case "jp_ask_location":              return handleJpAskLocation(phone, chatId, text, session);
    case "jp_ask_location_environment":  return handleJpAskLocationEnvironment(phone, chatId, text, session);
    case "jp_ask_frequency":   return handleJpAskFrequency(phone, chatId, text, session);
    case "jp_ask_start":       return handleJpAskStart(phone, chatId, text, session);
    case "jp_ask_days":        return handleJpAskDays(phone, chatId, text, session);
    case "jp_ask_time":        return handleJpAskTime(phone, chatId, text, session);
    case "jp_ask_care_needs":  return handleJpAskCareNeeds(phone, chatId, text, session);
    case "jp_ask_rate":        return handleJpAskRate(phone, chatId, text, session);
    case "jp_ask_description": return handleJpAskDescription(phone, chatId, text, session);
    case "jp_confirm_post":    return handleJpConfirmPost(phone, chatId, text, session);
    default:
      await startJobPostingFlow(phone, chatId, session);
  }
}

// ── Step handlers: who/where (2026-09-07 parity build) ────────────────────────

async function handleJpAskRecipients(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const onboardingData = (session as any).onboardingData as Record<string, unknown> ?? {};
  const uid = (session as any).userId as string | undefined;
  const options = uid ? await fetchRecipientOptions(uid, onboardingData) : [];
  const listText = formatRecipientOptions(options);
  const REASK = `Who is this job for?\n\n${listText}\n\nReply with a name or number (a few is fine, e.g. "1, 2") — or tell me someone new and how they're related to you.`;

  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
    return;
  }

  const raw = await parseWithClaude(
    `Known people on file:\n${listText}\n\n` +
    "The family is choosing who a care job is for. Match their reply against the numbered list above (by number or name — case-insensitive, first name is enough). " +
    'Return ONLY a JSON object: {"matched": [numbers from the list the message actually refers to], "newName": "a person\'s name mentioned that is NOT on the list, or null", "newRelationship": "their relationship to the account holder if the message stated one — must be exactly Parent, Spouse or Partner, or Other — else null"}. ' +
    "Never invent a match or a name the message doesn't actually contain.",
    text
  );
  let matched: number[] = [];
  let newName: string | null = null;
  let newRelationship: string | null = null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.matched)) {
      matched = parsed.matched.filter((n: unknown) => typeof n === "number" && n >= 1 && n <= options.length);
    }
    if (typeof parsed.newName === "string" && parsed.newName.trim()) newName = parsed.newName.trim();
    if (typeof parsed.newRelationship === "string") {
      newRelationship = matchEnum(parsed.newRelationship, RELATIONSHIP_CHIPS);
    }
  } catch { /**/ }

  if (matched.length === 0 && !newName) {
    await sendMessage(chatId, `${JP_DIDNT_CATCH} ${REASK}`);
    return;
  }

  const chosen: JobRecipient[] = matched.map((n) => options[n - 1]);

  if (newName) {
    const [first, ...rest] = newName.split(/\s+/).filter(Boolean);
    if (newRelationship) {
      chosen.push({ firstName: first, lastName: rest.join(" "), relationship: newRelationship, isSelf: false });
      await finishRecipientSelection(phone, chatId, chosen);
      return;
    }
    // Relationship not stated — ask it before moving on. Anyone already
    // matched from the known list is kept; the new person is appended once
    // their relationship comes back.
    await mergeJobData(phone, {
      careRecipients: chosen,
      pendingNewRecipientFirstName: first,
      pendingNewRecipientLastName: rest.join(" "),
    });
    await updateJobStep(phone, "jp_ask_recipient_relationship");
    await sendMessage(chatId, `Got it — and what's your relationship to ${first}? (Parent, Spouse or Partner, or Other)`);
    return;
  }

  await finishRecipientSelection(phone, chatId, chosen);
}

async function finishRecipientSelection(
  phone: string, chatId: string, chosen: JobRecipient[]
): Promise<void> {
  await mergeJobData(phone, { careRecipients: chosen });
  await updateJobStep(phone, "jp_ask_caregivers_needed");
  const names = chosen.map((r) => r.isSelf ? "you" : r.firstName).join(" and ");
  await sendMessage(chatId,
    `Got it — care for ${names}.\n\nHow many caregivers do you need for this job? (Most families need just 1 — reply a number 1-4)`
  );
}

async function handleJpAskRecipientRelationship(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const jobData = await getJobData(phone);
  const first = (jobData.pendingNewRecipientFirstName as string) ?? "them";
  const REASK = `What's your relationship to ${first}? (Parent, Spouse or Partner, or Other)`;
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
    return;
  }
  const raw = await parseWithClaude(
    'Map the relationship described to exactly one of: Parent, Spouse or Partner, Other. ' +
    '"mom"/"dad"/"mother"/"father"/"parent" = Parent. "husband"/"wife"/"partner"/"spouse" = "Spouse or Partner". Anything else relationship-like = Other. ' +
    'Reply with exactly one of those three values.',
    text
  );
  const relationship = matchEnum(raw, RELATIONSHIP_CHIPS);
  if (!relationship) {
    await sendMessage(chatId, `${JP_DIDNT_CATCH} ${REASK}`);
    return;
  }
  const last = (jobData.pendingNewRecipientLastName as string) ?? "";
  const existing = (jobData.careRecipients as JobRecipient[]) ?? [];
  const chosen = [...existing, { firstName: first, lastName: last, relationship, isSelf: false }];
  await finishRecipientSelection(phone, chatId, chosen);
}

async function handleJpAskCaregiversNeeded(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const REASK = "How many caregivers do you need for this job? (Most families need just 1 — reply a number 1-4)";
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
    return;
  }
  const raw = await parseWithClaude(
    'Extract how many caregivers the family needs, as a number from 1 to 4. "just one"/"one"/"1" = 1. Reply with only the number.',
    text
  );
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1 || n > 4) {
    await sendMessage(chatId, `${JP_DIDNT_CATCH} ${REASK}`);
    return;
  }
  await mergeJobData(phone, { caregiversNeeded: n });
  await updateJobStep(phone, "jp_ask_location");

  const uid = (session as any).userId as string | undefined;
  const onboardingData = (session as any).onboardingData as Record<string, unknown> ?? {};
  const locations = uid ? await fetchLocationOptions(uid, onboardingData) : [];
  const listText = formatLocationOptions(locations);
  await sendMessage(chatId,
    `Got it — ${n} caregiver${n === 1 ? "" : "s"}.\n\nWhich address is this for?\n\n${listText}\n\n` +
    (locations.length ? "Reply with a number, or a new street address + zip code." : "Reply with the street address + zip code.")
  );
}

async function handleJpAskLocation(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const uid = (session as any).userId as string | undefined;
  const onboardingData = (session as any).onboardingData as Record<string, unknown> ?? {};
  const locations = uid ? await fetchLocationOptions(uid, onboardingData) : [];
  const listText = formatLocationOptions(locations);
  const REASK = `Which address is this for?\n\n${listText}\n\n` +
    (locations.length ? "Reply with a number, or a new street address + zip code." : "Reply with the street address + zip code.");

  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
    return;
  }

  const raw = await parseWithClaude(
    `Known addresses:\n${listText}\n\n` +
    "Match the family's reply to ONE of the numbered addresses above by number, OR extract a NEW street address and 5-digit zip code if they gave one not on the list. " +
    'Return ONLY a JSON object: {"matchedIndex": number or null, "newStreet": string or null, "newZip": "5-digit zip or null"}. Never invent an address.',
    text
  );
  let matchedIndex: number | null = null;
  let newStreet: string | null = null;
  let newZip: string | null = null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.matchedIndex === "number" && parsed.matchedIndex >= 1 && parsed.matchedIndex <= locations.length) {
      matchedIndex = parsed.matchedIndex;
    }
    if (typeof parsed.newStreet === "string" && parsed.newStreet.trim()) newStreet = parsed.newStreet.trim();
    if (typeof parsed.newZip === "string" && /^\d{5}$/.test(parsed.newZip.trim())) newZip = parsed.newZip.trim();
  } catch { /**/ }

  if (matchedIndex) {
    const loc = locations[matchedIndex - 1];
    await mergeJobData(phone, {
      streetAddress: loc.street, city: loc.city, state: loc.state, zipCode: loc.zipCode,
      petsInHome: loc.petsInHome, smokingHousehold: loc.smokingHousehold,
      isNewLocation: false,
      // Silent default (no question asked — see the JP_STEP_ORDER comment).
      jobTitle: defaultJobTitle(loc.city || null),
    });
    await updateJobStep(phone, "jp_ask_care_needs");
    await sendMessage(chatId, `Got it — ${loc.street}.\n\n${await careNeedsQuestion(phone)}`);
    return;
  }

  if (newStreet && newZip) {
    const place = await lookupZipPlace(newZip);
    await mergeJobData(phone, {
      streetAddress: newStreet, zipCode: newZip,
      city: place?.city ?? "", state: place?.state ?? "",
      isNewLocation: true,
      // Silent default (no question asked — see the JP_STEP_ORDER comment).
      jobTitle: defaultJobTitle(place?.city || null),
    });
    await updateJobStep(phone, "jp_ask_location_environment");
    await sendMessage(chatId,
      `Got it — ${newStreet}.\n\nA couple quick home questions: Are there any pets in the home? And does anyone smoke in the home?\n\n` +
      "(e.g. \"yes dog, no smoking\" or \"no pets, no smoke\" or \"cat yes, smoke no\")"
    );
    return;
  }

  await sendMessage(chatId, `${JP_DIDNT_CATCH} ${REASK}`);
}

async function handleJpAskLocationEnvironment(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const REASK = "Are there pets in the home? Does anyone smoke in the home?";
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
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
  if (rawPets === "__parse_error__" || rawSmoke === "__parse_error__") {
    await sendMessage(chatId, `${JP_DIDNT_CATCH} ${REASK}`);
    return;
  }
  const petsInHome       = rawPets.toUpperCase().startsWith("Y");
  const smokingHousehold = rawSmoke.toUpperCase().startsWith("Y");
  await mergeJobData(phone, { petsInHome, smokingHousehold });
  await updateJobStep(phone, "jp_ask_care_needs");
  await sendMessage(chatId,
    `Got it — ${petsInHome ? "pets ✓" : "no pets"}, ${smokingHousehold ? "smoking ✓" : "no smoking"}.\n\n${await careNeedsQuestion(phone)}`
  );
}

// This job's actual recipient(s), collected earlier in jp_ask_recipients —
// used for every question from here on instead of the single onboarding-time
// senior name, so a job posted for someone else (or for "myself") reads
// correctly for the rest of the flow.
async function recipientsDisplayName(phone: string, session: AgentSession): Promise<string> {
  const jobData = await getJobData(phone);
  const recipients = (jobData.careRecipients as JobRecipient[]) ?? [];
  return recipients.length
    ? recipients.map((r) => r.isSelf ? "you" : r.firstName).join(" and ")
    : seniorFirstName(session);
}

async function careNeedsQuestion(phone: string): Promise<string> {
  const jobData = await getJobData(phone);
  const recipients = (jobData.careRecipients as JobRecipient[]) ?? [];
  const name = recipients.length
    ? recipients.map((r) => r.isSelf ? "you" : r.firstName).join(" and ")
    : "your loved one";
  return `What kind of care does ${name} need? Just tell me in your own words — things like personal care ` +
    `(bathing, grooming), mobility help, memory care, medication reminders, meals, rides, companionship, ` +
    `or light housekeeping.`;
}

// ── Step handlers: schedule / care / rate / description (unchanged 2026-09-07 fixes) ──

async function handleJpAskFrequency(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const REASK = "How often do you need help? Occasional (1–2 days a week), part-time (3–4 days), or full-time (5+)?";
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
    return;
  }
  const raw = await parseWithClaude(
    '"1", occasional, 1-2 days = occasional. ' +
    '"2", part-time, part time, 3-4 days = part_time. ' +
    '"3", full-time, full time, every day, 5+ days = full_time. ' +
    'Reply with exactly one of: occasional, part_time, full_time',
    text
  );
  const frequency = matchEnum(raw, ["occasional", "part_time", "full_time"]);
  if (!frequency) {
    await sendMessage(chatId, `${JP_DIDNT_CATCH} ${REASK}`);
    return;
  }
  const label: Record<string, string> = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
  await mergeJobData(phone, { jobFrequency: frequency });
  await updateJobStep(phone, "jp_ask_start");
  await sendMessage(chatId,
    `${label[frequency] ?? "Got it"}! When would you like care to start? (e.g. "next Monday", "ASAP", "June 1")`
  );
}

async function handleJpAskStart(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, `When would you like care to start? (e.g. "next Monday", "ASAP", "June 1")`);
    return;
  }
  // Anchor relative dates ("next Monday", "in two weeks") to the REAL current
  // date — without this the model has no idea what "today" is and guesses,
  // which produced dates over a year in the past/future for a plain "next
  // Monday". Pacific time, matching the rest of the platform's date handling.
  const now = new Date();
  const todayIso = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD
  const todayDow = now.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long" });
  const startDate = await parseWithClaude(
    `Today is ${todayDow}, ${todayIso}. Extract a start date from this message, relative to TODAY. ` +
    "If the user says 'ASAP', 'immediately', or 'now', return 'ASAP'. " +
    "Otherwise return the date in YYYY-MM-DD format if possible, or a plain description. Reply with just the date value.",
    text
  );
  const stored = startDate !== "__parse_error__" ? startDate : text.trim();
  await mergeJobData(phone, { jobStartDate: stored });
  await updateJobStep(phone, "jp_ask_days");
  await sendMessage(chatId,
    `Got it — starting ${stored}! Which days work best?\n\n(e.g. "Mon, Wed, Fri" or "weekdays" or "every day")`
  );
}

async function handleJpAskDays(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const REASK = "Which days work best? (e.g. \"Mon, Wed, Fri\" or \"weekdays\")";
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
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
  if (days.length === 0) {
    await sendMessage(chatId, `${JP_DIDNT_CATCH} ${REASK}`);
    return;
  }
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
  const REASK = "What time of day works best? Mornings, afternoons, evenings, overnight, or a mix?";
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
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
  if (times.length === 0) {
    await sendMessage(chatId, `${JP_DIDNT_CATCH} ${REASK}`);
    return;
  }
  const timeLabel = times.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" & ");
  await mergeJobData(phone, { jobTimeOfDay: times });
  await updateJobStep(phone, "jp_ask_recipients");
  const onboardingData = (session as any).onboardingData as Record<string, unknown> ?? {};
  const uid = (session as any).userId as string | undefined;
  const options = uid ? await fetchRecipientOptions(uid, onboardingData) : [];
  const listText = formatRecipientOptions(options);
  await sendMessage(chatId,
    `${timeLabel} — noted!\n\nWho is this job for?\n\n${listText}\n\n` +
    "Reply with a name or number (a few is fine) — or tell me someone new and how they're related to you."
  );
}

async function handleJpAskCareNeeds(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const name = await recipientsDisplayName(phone, session);
  const REASK = `What kind of care does ${name} need? (e.g. personal care, meals, companionship, mobility)`;
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
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
  if (careNeeds.length === 0) {
    await sendMessage(chatId, `${JP_DIDNT_CATCH} ${REASK}`);
    return;
  }
  const needsLabel = careNeeds.slice(0, 3).join(", ") + (careNeeds.length > 3 ? ` +${careNeeds.length - 3} more` : "");
  // jobCareLevel derived, never asked — see the JP_STEP_ORDER comment at the
  // top of the file for why.
  const jobCareLevel = deriveCareLevel([], careNeeds);
  await mergeJobData(phone, { jobCareNeeds: careNeeds, jobCareLevel });
  await updateJobStep(phone, "jp_ask_rate");
  await sendMessage(chatId,
    `${needsLabel} — great choices! What hourly rate are you offering? (e.g. "$20", "18 an hour", "flexible")`
  );
}

async function handleJpAskRate(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const REASK = "What hourly rate are you offering? (e.g. \"$20\", \"18 an hour\", \"flexible\")";
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
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
  if (isNaN(rate)) {
    await sendMessage(chatId, `${JP_DIDNT_CATCH} ${REASK}`);
    return;
  }
  const jobHourlyRate = rate;
  const rateLabel = jobHourlyRate > 0 ? `$${jobHourlyRate}/hr` : "flexible rate";
  // Cash/Venmo/Zelle removed platform-wide (Hamse, 2026-08-23) — every job is
  // paid by card now, so this no longer asks; jobPaymentMethod is kept at its
  // "card" default (see buildJobSummary) purely for downstream code that
  // still reads the field. Skips straight to the description question —
  // jp_ask_pay_method (which used to ask "how would you prefer to pay" and
  // parse the answer) is gone; removed from JP_STEP_ORDER too.
  await mergeJobData(phone, { jobHourlyRate, jobPaymentMethod: "card" });
  await updateJobStep(phone, "jp_ask_description");
  const name = await recipientsDisplayName(phone, session);
  await sendMessage(chatId,
    `${rateLabel} — sounds good! Last question: can you briefly describe a typical care day for ${name}?\n\n` +
    "(A sentence or two is great — this helps caregivers understand the role)"
  );
}

async function handleJpAskDescription(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  if (await isQuestionOrOther(text)) {
    const answer = await answerQuestionMidFlow(text, session);
    await sendMessage(chatId, answer);
    const name = await recipientsDisplayName(phone, session);
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
  const recipients = (jobData.careRecipients as JobRecipient[]) ?? [];
  const recipientsLabel = recipients.length > 0
    ? recipients.map((r) => r.isSelf ? "Myself" : `${r.firstName} ${r.lastName}`.trim()).join(", ")
    : seniorFirstName(session);
  const caregiversNeeded = (jobData.caregiversNeeded as number) ?? 1;
  const street    = (jobData.streetAddress as string) ?? "";
  const city      = (jobData.city as string) ?? "";
  const state     = (jobData.state as string) ?? "";
  const startDate = (jobData.jobStartDate  as string) ?? "TBD";
  const frequency = (jobData.jobFrequency  as string) ?? "occasional";
  const days      = (jobData.jobDays       as string[]) ?? [];
  const times     = (jobData.jobTimeOfDay  as string[]) ?? [];
  const careNeeds = (jobData.jobCareNeeds  as string[]) ?? [];
  const careLevel = (jobData.jobCareLevel  as string)   ?? "moderate";
  const rate      = (jobData.jobHourlyRate as number)   ?? 0;
  const payMethod = (jobData.jobPaymentMethod as string) ?? "card";
  const pets      = (jobData.petsInHome       as boolean) ? "yes" : "no";
  const smoking   = (jobData.smokingHousehold  as boolean) ? "yes" : "no";
  const desc      = (jobData.jobDescription as string) ?? "";
  const title     = (jobData.jobTitle as string) ?? "";

  const freqLabel: Record<string, string> = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
  const rateLabel  = rate > 0 ? `$${rate}/hr` : "Flexible";
  const daysLabel  = days.length > 0 ? days.join(", ") : "TBD";
  const timesLabel = times.length > 0
    ? times.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" & ")
    : "TBD";
  const needsLabel = careNeeds.length > 0 ? careNeeds.join(", ") : "General care";
  const locationLabel = street ? `${street}, ${city}${city && state ? " " : ""}${state}`.trim() : "TBD";

  return [
    title ? `📌 Title: ${title}` : "",
    `👤 For: ${recipientsLabel}`,
    `🧑‍⚕️ Caregivers needed: ${caregiversNeeded}`,
    `📍 Location: ${locationLabel}`,
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
