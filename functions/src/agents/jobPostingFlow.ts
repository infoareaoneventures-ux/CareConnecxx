import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { sendMessage, AgentSession } from "../linq/client";
import { buildAndSaveJobPost, jobLiveMessage } from "./buildJobPost";
import { defaultJobTitle } from "./jobPostContract";
import { isConvergenceFlipped, caraOutputGuardEnabled } from "../config/featureFlags";
import { generateCaraMessage } from "../utils/caraMessage";
import { allCareRecipients, recipientPlanKey } from "./careRecipients";
import { guardModelOutput, ANTI_INVENTION_CLAUSE } from "../safety/outputGuard";
import { describeSharedProfile } from "./profileBriefing";
import { deriveCareLevel } from "./clientJobPostingContract";
import { lookupZipPlace } from "../utils/geocode";
import { normalizeCareNeeds } from "../utils/careNeedCategories";
import { isBackOutRequest } from "./stepHandler";

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

// 2026-09-08 (live-caught): every JSON-shaped parseWithClaude call below fed
// the raw text straight into JSON.parse inside a silently-swallowed try/catch
// — indistinguishable, from the caller's side, from "the model correctly
// found nothing." A perfectly good answer wrapped in a stray ```json code
// fence or a word of commentary (a known model quirk that
// CLASSIFICATION_GUARD_CLAUSE reduces but doesn't guarantee against) was
// silently treated as if the user hadn't said anything, sending the same
// generic re-ask as a totally garbled reply. Strips a code fence if present,
// and — critically — LOGS the raw text on failure, so a repeat leaves real
// diagnostic evidence instead of another silent guess.
function parseJsonLoose(raw: string, where: string): any | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    console.warn(`[jobPostingFlow] ${where}: JSON.parse failed on model output`, { raw: raw.slice(0, 300) });
    return null;
  }
}

// 2026-09-08 (live-caught): a genuine date VALUE ("2026-09-15", "ASAP", "next
// Monday", even a short raw echo) is never a full explanatory sentence. This
// catches the specific refusal shape guardModelOutput doesn't (that guard
// targets "who's the briefing for" confusion, not a data-extraction refusal)
// — long, and/or a first-person explanation of why it couldn't find a date.
function looksLikeExtractionRefusal(value: string): boolean {
  if (value.length > 40) return true;
  return /\b(i need|i don'?t|doesn'?t contain|unable to|cannot|can'?t (?:find|extract|determine))\b/i.test(value);
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

// 2026-09-07 (live-caught): every classification/extraction prompt in this
// file used to carry the shared ANTI_INVENTION_CLAUSE, which is written for
// free-form GENERATED messages and explicitly talks about "the briefing" —
// something these plain "pick one of three words" / "extract this value"
// prompts never have. Claude Haiku, given no briefing to reference, got
// confused and answered with a long, meta "I don't have enough context..."
// response instead of classifying — which the output guard correctly caught
// as a meta_response and rejected, silently, forever (no logging existed
// until this same fix), so a literal, unambiguous "occasional" reply reliably
// produced a 529-character rejected response and an endless re-ask loop. This
// clause says the same "don't invent" thing without the briefing framing that
// doesn't apply here.
export const CLASSIFICATION_GUARD_CLAUSE =
  "Reply with ONLY the requested value or format — no explanation, no extra text, no questions. " +
  "Never invent information the user's message doesn't contain.";

async function parseWithClaude(prompt: string, userText: string): Promise<string> {
  try {
    const response = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system:     prompt + "\n" + CLASSIFICATION_GUARD_CLAUSE,
      messages:   [{ role: "user", content: userText }],
    });
    const parsed = ((response.content[0] as { text: string }).text ?? "").trim();
    // Output guard (U2, R2): a meta-response/URL from the parser is a parse
    // failure — every call site already handles "__parse_error__" (raw text or
    // validated default). Kill switch: CARA_OUTPUT_GUARD_ENABLED=false.
    if (parsed) {
      const guard = caraOutputGuardEnabled() ? guardModelOutput(parsed) : { ok: true as const };
      if (!guard.ok) {
        // 2026-09-07: this whole function previously failed SILENTLY on any
        // rejection or exception — no log, no alert — so a live, 100%-
        // reproducing extraction failure (a family stuck re-asked on a plain
        // "occasional") had zero server-side evidence to diagnose from.
        console.warn("[jobPostingFlow] parseWithClaude: output guard rejected model response", { reason: (guard as any).reason, rawLength: parsed.length });
        return "__parse_error__";
      }
    }
    return parsed;
  } catch (err) {
    console.error("[jobPostingFlow] parseWithClaude: Anthropic call threw", err);
    return "__parse_error__";
  }
}

// 2026-09-07 (live-caught): the prompt used to judge relevance "to the
// current question" without ever stating what that question WAS — a
// context-free guess. Short, valid answers ("morning", "Myself", "1", a bare
// name from the options list) are exactly the replies that guess gets wrong,
// since in isolation they can look like a fragment of a greeting or an
// off-topic aside. Passing the actual question text fixes this at the source
// (every call site below passes its own REASK/current-question copy).
//
// 2026-09-08 (live-caught, regression from the "who is this job for" fix
// above): those "someone else"/"another person" examples were hardcoded
// into THIS shared prompt, used across all 13 different questions in this
// file (frequency, days, confirm-YES/NO, etc.) — a bare "yes" answering the
// FINAL confirm question got misclassified as off-topic, anchored on
// examples about naming a person that had nothing to do with what was
// actually asked. Generalized to the underlying principle (a short/partial/
// vague attempt still counts as a direct answer) without anchoring to any
// one question's specific wording, so it applies correctly regardless of
// which of the 13 questions is currently active.
async function isQuestionOrOther(text: string, currentQuestion: string): Promise<boolean> {
  const result = await parseWithClaude(
    `The question Evia just asked the family was: "${currentQuestion}"\n\n` +
    "Reply NO if the family's message is ANY attempt — even a single word, a bare number, or a short/partial/vague one — " +
    "to address that specific question. A vague or incomplete attempt still counts as a direct answer (a follow-up question " +
    "can ask for whatever detail is still missing) — it is NOT the same as asking something else or changing the subject. " +
    "Reply YES only if the message is a genuine question, or a comment that does not attempt to address what was asked at all. " +
    "Only reply YES or NO.",
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

async function answerQuestionMidFlow(phone: string, text: string, session: AgentSession): Promise<string> {
  // 2026-09-07 (live-caught): this used to ground itself in the ACCOUNT's
  // original onboarding senior (onboardingData.seniorName) unconditionally —
  // so a mid-flow question asked while posting a job for someone NEW (a
  // different recipient than the account's on-file senior) got answered
  // using the wrong person's saved details. recipientsDisplayName already
  // resolves the job's ACTUAL in-progress recipient (careRecipients, or the
  // pending new name mid-relationship-question), falling back to the
  // account's senior only when nothing job-specific has been collected yet.
  const { name: recipientName, jobSpecific } = await resolveJobRecipient(phone, session);
  // Recall grounding — without it, "what city did I tell you?" gets a
  // grounded-sounding denial even though the answer is on the session.
  //
  // 2026-09-08 (live-caught, same conversation as the fix above): even after
  // grounding the "They are setting up a job for X" line correctly,
  // describeSharedProfile still injected its own WHO'S WHO framing built from
  // the ACCOUNT's original onboarding senior — an emphatic "the recipient is
  // Samira M... never for {accountHolder}" that flatly contradicted the
  // correct line right before it ("for you"), and the model followed the
  // louder, more specific sentence. Only include it when nothing job-specific
  // has been collected yet (jobSpecific === false), where its grounding is
  // actually correct instead of stale.
  const sharedProfile = jobSpecific ? "" : describeSharedProfile(session as any);
  // 2026-09-08 (live-caught): this call sees ONLY the current message — no
  // transcript of the conversation, including Evia's OWN prior messages. A
  // family replying to Evia's own interview-completion nudge ("Can you make
  // it complete") got answered as if it must be about the job posting
  // (the only thing this prompt knows about), producing a confused
  // "are you setting up a job posting, or something else?" reply — and when
  // asked directly "what interview do I have," it confidently claimed
  // "I haven't mentioned an interview... this is our first message!", which
  // was flatly false (Evia's own prior text named the interview). This
  // function has no way to know that — it must not pretend otherwise, and
  // must not try to force an out-of-scope question into job-posting terms.
  const response = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system:
      "You are Evia, a care coordinator helping a client post a care job. " +
      `They are setting up a job for ${recipientName}. ` +
      (sharedProfile ? `${sharedProfile} ` : "") +
      "You see ONLY this one message, not the rest of the conversation — including anything Evia herself said earlier. " +
      "NEVER claim something was or wasn't mentioned before; you cannot know that. " +
      "If the message is clearly about something OTHER than the details of THIS job post (a different topic entirely — " +
      "e.g. an interview, a booking, billing, a different job) — do not try to answer it or guess what it's about. Instead say " +
      "plainly that it'll have to wait, e.g. \"That sounds like something else — let's finish this first, and I'll help with " +
      "that right after.\" Otherwise answer their actual question about this job post briefly (1–2 sentences). Be warm and helpful. " +
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

// 2026-09-13: every step below used to only recognize a cancel at the FINAL
// jp_confirm_post step (its own YES/NO parse) — anywhere earlier, "never
// mind"/"cancel this" fell through isQuestionOrOther as an off-topic aside,
// got a brief reply, and the SAME question just re-asked itself next turn,
// with no way to actually leave. Live-caught the worst version of this: a
// family misrouted into this flow mid-interview-scheduling had "cancel this
// request"/"cancel the job post" — even a direct answer to Evia's OWN
// clarifying question — loop forever with no escape. Checked FIRST in every
// handler below, ahead of isQuestionOrOther, using the same shared
// classifier interviewFlow.ts was built with from the start.
async function handleJobPostingBackOut(phone: string, chatId: string, session: AgentSession): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    jobPostingStep: admin.firestore.FieldValue.delete(),
    jobPostingData: admin.firestore.FieldValue.delete(),
    stateExpiresAt: admin.firestore.FieldValue.delete(),
  });
  await sendMessage(chatId, await generateCaraMessage({
    audience: "family",
    language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
    context: "The family decided not to post the care job right now. Warmly let them know that's completely fine and they can text you anytime when they're ready to post a new job.",
    fallback: "No problem! Text me anytime when you're ready to post a new job.",
    maxTokens: 80,
  }));
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
  await db.collection("agent_sessions").doc(phone).update({
    jobPostingStep: "jp_ask_frequency",
    jobPostingData: {},
    stateExpiresAt: expiresAt,
  });
  // 2026-09-08 (live-caught): this used to pass describeWhoIsWho(onboardingData)
  // as grounding — the ACCOUNT's original onboarding senior — into the very
  // FIRST message of a NEW job post, before the flow has any business knowing
  // who this particular job is for. Matching the site's own wizard order
  // (Step1Schedule before Step2WhoWhere), recipient is asked LATER
  // (jp_ask_recipients); asserting a name here produced "we're setting up
  // care for Samira M" even when the family was about to post for someone
  // else entirely. Deliberately recipient-neutral until that step.
  const msg = await generateCaraMessage({
    audience: "family",
    language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
    context:
      "Kicking off posting a new care job. Who this specific job is for hasn't been asked yet (that's a later question in this flow) — " +
      "do NOT name or assume any care recipient. First question: how often is help needed — just occasional (a day or two a week), " +
      "part-time (3–4 days), or full-time (5+ days). Be warm and a little excited.",
    fallback: `Let's post a new care job!\n\nHow often do you need help — just occasional (a day or two a week), part-time (3–4 days), or full-time (5+ days)?`,
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

  if (await isBackOutRequest(text, REASK)) return handleJobPostingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, REASK)) {
    const answer = await answerQuestionMidFlow(phone, text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
    return;
  }

  const raw = await parseWithClaude(
    `Known people on file:\n${listText}\n\n` +
    "The family is choosing who a care job is for. Match their reply against the numbered list above (by number or name — case-insensitive, first name is enough). " +
    'Return ONLY a JSON object: {"matched": [numbers from the list the message actually refers to], "newName": "a person\'s name mentioned that is NOT on the list, or null", "newRelationship": "their relationship to the account holder, if stated — must be exactly Parent, Spouse or Partner, or Other — else null", "impliesNewPerson": true or false}. ' +
    '"newRelationship" can be set even when "newName" is null — e.g. "it\'s someone new, my mother" states the relationship without a name yet. ' +
    '"impliesNewPerson" is true whenever the family indicates this is for someone NOT on the list — e.g. "someone else", "another person", "it\'s for someone new" — even with no name or relationship stated at all. ' +
    "Never invent a match or a name the message doesn't actually contain.",
    text
  );
  let matched: number[] = [];
  let newName: string | null = null;
  let newRelationship: string | null = null;
  let impliesNewPerson = false;
  const parsed = parseJsonLoose(raw, "handleJpAskRecipients");
  if (parsed) {
    if (Array.isArray(parsed.matched)) {
      matched = parsed.matched.filter((n: unknown) => typeof n === "number" && n >= 1 && n <= options.length);
    }
    if (typeof parsed.newName === "string" && parsed.newName.trim()) newName = parsed.newName.trim();
    if (typeof parsed.newRelationship === "string") {
      newRelationship = matchEnum(parsed.newRelationship, RELATIONSHIP_CHIPS);
    }
    impliesNewPerson = parsed.impliesNewPerson === true;
  }

  // 2026-09-08 (live-caught): "someone else" / "another person" / "it's
  // someone new, my mother" all correctly never invent a name — but repeating
  // the ENTIRE generic question felt like nothing was understood. Remember
  // any stated relationship and ask specifically for the missing name instead,
  // for ANY phrasing that signals a new/different person, not just one that
  // also names a relationship.
  if (matched.length === 0 && !newName) {
    if (newRelationship || impliesNewPerson) {
      if (newRelationship) await mergeJobData(phone, { pendingNewRecipientRelationship: newRelationship });
      await sendMessage(chatId, "Sure — what's their name?");
      return;
    }
    await sendMessage(chatId, `${JP_DIDNT_CATCH} ${REASK}`);
    return;
  }

  const chosen: JobRecipient[] = matched.map((n) => options[n - 1]);

  if (newName) {
    const [first, ...rest] = newName.split(/\s+/).filter(Boolean);
    const jobData = await getJobData(phone);
    const relationship = newRelationship ?? ((jobData.pendingNewRecipientRelationship as string | undefined) ?? null);
    if (relationship) {
      chosen.push({ firstName: first, lastName: rest.join(" "), relationship, isSelf: false });
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
  if (await isBackOutRequest(text, REASK)) return handleJobPostingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, REASK)) {
    const answer = await answerQuestionMidFlow(phone, text, session);
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
  if (await isBackOutRequest(text, REASK)) return handleJobPostingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, REASK)) {
    const answer = await answerQuestionMidFlow(phone, text, session);
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

  if (await isBackOutRequest(text, REASK)) return handleJobPostingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, REASK)) {
    const answer = await answerQuestionMidFlow(phone, text, session);
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
  const parsed = parseJsonLoose(raw, "handleJpAskLocation");
  if (parsed) {
    if (typeof parsed.matchedIndex === "number" && parsed.matchedIndex >= 1 && parsed.matchedIndex <= locations.length) {
      matchedIndex = parsed.matchedIndex;
    }
    if (typeof parsed.newStreet === "string" && parsed.newStreet.trim()) newStreet = parsed.newStreet.trim();
    if (typeof parsed.newZip === "string" && /^\d{5}$/.test(parsed.newZip.trim())) newZip = parsed.newZip.trim();
  }

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
  if (await isBackOutRequest(text, REASK)) return handleJobPostingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, REASK)) {
    const answer = await answerQuestionMidFlow(phone, text, session);
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
    `Got it — ${petsInHome ? "pets, yes" : "no pets"}, ${smokingHousehold ? "smoking, yes" : "no smoking"}.\n\n${await careNeedsQuestion(phone)}`
  );
}

// This job's actual recipient(s), collected earlier in jp_ask_recipients —
// used for every question from here on instead of the single onboarding-time
// senior name, so a job posted for someone else (or for "myself") reads
// correctly for the rest of the flow. `jobSpecific` is true once a real
// answer has been collected for THIS job (as opposed to falling back to the
// account's generic on-file senior) — see answerQuestionMidFlow for why
// callers need to know the difference, not just the name.
async function resolveJobRecipient(phone: string, session: AgentSession): Promise<{ name: string; jobSpecific: boolean }> {
  const jobData = await getJobData(phone);
  const recipients = (jobData.careRecipients as JobRecipient[]) ?? [];
  if (recipients.length) {
    return { name: recipients.map((r) => r.isSelf ? "you" : r.firstName).join(" and "), jobSpecific: true };
  }
  // A new person's name may be known before their relationship is (mid
  // jp_ask_recipient_relationship) — prefer that over the account's
  // unrelated on-file senior.
  const pendingFirst = jobData.pendingNewRecipientFirstName as string | undefined;
  if (pendingFirst) return { name: pendingFirst, jobSpecific: true };
  return { name: seniorFirstName(session), jobSpecific: false };
}

async function recipientsDisplayName(phone: string, session: AgentSession): Promise<string> {
  return (await resolveJobRecipient(phone, session)).name;
}

async function careNeedsQuestion(phone: string): Promise<string> {
  const jobData = await getJobData(phone);
  const recipients = (jobData.careRecipients as JobRecipient[]) ?? [];
  const name = recipients.length
    ? recipients.map((r) => r.isSelf ? "you" : r.firstName).join(" and ")
    : "your loved one";
  // 2026-09-08 (live-caught): "you" is second person — "does you need" reads
  // as broken grammar; every other name here is third person ("does Samira
  // need"). needCareVerb (below) picks the right conjugation either way.
  return `What kind of care ${needCareVerb(name)} ${name} need? Things like personal care ` +
    `(bathing, grooming), mobility help, memory care, medication reminders, meals, rides, companionship, ` +
    `or light housekeeping.`;
}

function needCareVerb(name: string): "do" | "does" {
  return name === "you" ? "do" : "does";
}

// ── Step handlers: schedule / care / rate / description (unchanged 2026-09-07 fixes) ──

async function handleJpAskFrequency(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const REASK = "How often do you need help? Occasional (1–2 days a week), part-time (3–4 days), or full-time (5+)?";
  if (await isBackOutRequest(text, REASK)) return handleJobPostingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, REASK)) {
    const answer = await answerQuestionMidFlow(phone, text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
    return;
  }
  const raw = await parseWithClaude(
    '"1", occasional, 1-2 days = occasional. ' +
    '"2", part-time, part time, 3-4 days = part_time. ' +
    '"3", full-time, full time, every day, 5+ days = full_time. ' +
    // 2026-09-08 (live-caught): "regularly" isn't any of the three — it says
    // nothing about days/week — but the prompt only ever offered these three
    // options, so the model forced a guess (part_time) and it got presented
    // to the family as settled fact ("Part-time!") instead of asked about.
    // Same principle as the JP_DIDNT_CATCH re-ask elsewhere in this file:
    // never silently substitute a value the family didn't actually say.
    'If the answer is vague and doesn\'t clearly indicate one of these three (e.g. "regularly", "often", ' +
    '"sometimes", "not sure") reply UNCLEAR — do not guess. ' +
    'Reply with exactly one of: occasional, part_time, full_time, UNCLEAR',
    text
  );
  const frequency = matchEnum(raw, ["occasional", "part_time", "full_time"]);
  if (!frequency) {
    // 2026-09-07: live-caught, 100%-reproducing failure on a plain "occasional"
    // that survived the case-insensitive matchEnum fix — log the actual raw
    // value so the next occurrence has real diagnostic evidence instead of
    // silently re-asking with zero trace of what the model actually returned.
    console.warn("[jobPostingFlow] handleJpAskFrequency: no enum match", { raw, textLength: text.length });
    await sendMessage(chatId, `${JP_DIDNT_CATCH} ${REASK}`);
    return;
  }
  const label: Record<string, string> = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
  await mergeJobData(phone, { jobFrequency: frequency });
  await updateJobStep(phone, "jp_ask_start");
  await sendMessage(chatId,
    `${label[frequency] ?? "Got it"}! When would you like care to start? (e.g. "next Monday", "ASAP", or a specific date)`
  );
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Display-only formatting for an echoed-back date — the STORED jobStartDate
// value stays YYYY-MM-DD (or "ASAP"/raw text) for consistency with the rest
// of the system (job_posts.startDate, etc.); a family reading a text message
// shouldn't see the raw ISO string ("2026-09-15") echoed back at them.
// Parses the string directly rather than via `new Date(...)` to avoid any
// timezone-shift risk on a date-only value.
export function formatDateForDisplay(value: string): string {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return value; // "ASAP" or a raw fallback string — show as-is
  const [, y, mo, d] = m;
  const monthName = MONTH_NAMES[parseInt(mo, 10) - 1];
  return monthName ? `${monthName} ${parseInt(d, 10)}, ${y}` : value;
}

async function handleJpAskStart(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const REASK = `When would you like care to start? (e.g. "next Monday", "ASAP", or a specific date)`;
  if (await isBackOutRequest(text, REASK)) return handleJobPostingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, REASK)) {
    const answer = await answerQuestionMidFlow(phone, text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
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
  // 2026-09-08 (live-caught): the model refused outright ("I need a message
  // with a start date to extract. Your message doesn't contain one.") instead
  // of returning __parse_error__ or a real value — that refusal sentence isn't
  // caught by guardModelOutput (built for a different meta-response shape:
  // "who's the briefing for", not a data-extraction refusal) or by the
  // __parse_error__ check, so it sailed through as the literal stored start
  // date and got echoed back in the job summary as "Start: I need a
  // message...". A real date VALUE is never a full explanatory sentence.
  const stored = (startDate !== "__parse_error__" && !looksLikeExtractionRefusal(startDate)) ? startDate : text.trim();
  await mergeJobData(phone, { jobStartDate: stored });
  await updateJobStep(phone, "jp_ask_days");
  await sendMessage(chatId,
    `Got it — starting ${formatDateForDisplay(stored)}! Which days work best?\n\n(e.g. "Mon, Wed, Fri" or "weekdays" or "every day")`
  );
}

async function handleJpAskDays(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const REASK = "Which days work best? (e.g. \"Mon, Wed, Fri\" or \"weekdays\")";
  if (await isBackOutRequest(text, REASK)) return handleJobPostingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, REASK)) {
    const answer = await answerQuestionMidFlow(phone, text, session);
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
  const parsedDays = parseJsonLoose(raw, "handleJpAskDays");
  if (Array.isArray(parsedDays) && parsedDays.length > 0) days = parsedDays;
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
  if (await isBackOutRequest(text, REASK)) return handleJobPostingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, REASK)) {
    const answer = await answerQuestionMidFlow(phone, text, session);
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
  const parsedTimes = parseJsonLoose(raw, "handleJpAskTime");
  if (Array.isArray(parsedTimes)) {
    const valid = ["morning", "afternoon", "evening", "overnight"];
    times = parsedTimes.filter((t: string) => valid.includes(t));
  }
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
  const REASK = `What kind of care ${needCareVerb(name)} ${name} need? (e.g. personal care, meals, companionship, mobility)`;
  if (await isBackOutRequest(text, REASK)) return handleJobPostingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, REASK)) {
    const answer = await answerQuestionMidFlow(phone, text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
    return;
  }
  const raw = await parseWithClaude(
    'Extract care needs as a JSON array of strings. Map to these standard values: ' +
    '"Personal Care" (bathing, grooming, hygiene, dressing), ' +
    '"Mobility Assistance" (walking, transfers, fall prevention), ' +
    '"Dementia / Memory Care" (dementia, Alzheimer\'s, cognitive support), ' +
    '"Medication Reminders" (meds, pills, prescriptions), ' +
    '"Meal Preparation" (cooking, meals, food, nutrition), ' +
    '"Transportation" (driving, errands, appointments), ' +
    '"Companionship" (social, activities, conversation), ' +
    '"Light Housekeeping" (cleaning, laundry, tidying). ' +
    'Return a JSON array of matching standard values, or an empty array. Only return the JSON array.',
    text
  );
  let careNeeds: string[] = [];
  const parsedNeeds = parseJsonLoose(raw, "handleJpAskCareNeeds");
  if (Array.isArray(parsedNeeds) && parsedNeeds.length > 0) {
    // The LLM is asked for standard category names but sometimes returns the
    // finer-grained symptom/task instead ("bathing" instead of "Personal
    // Care") — normalize onto the same 8 categories the web wizard uses, so
    // this matches what CarePlan.tsx expects and what caregiver skill-matching
    // actually searches on (both keyed on the parent category, never the
    // sub-task — see careNeedCategories.ts).
    careNeeds = normalizeCareNeeds(parsedNeeds);
  }
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
    `${needsLabel} — noted! What hourly rate are you offering? (e.g. "$20", "18 an hour", "flexible")`
  );
}

async function handleJpAskRate(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const REASK = "What hourly rate are you offering? (e.g. \"$20\", \"18 an hour\", \"flexible\")";
  if (await isBackOutRequest(text, REASK)) return handleJobPostingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, REASK)) {
    const answer = await answerQuestionMidFlow(phone, text, session);
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
  const name = await recipientsDisplayName(phone, session);
  const REASK = `Can you describe a typical care day for ${name}? A sentence or two is great.`;
  if (await isBackOutRequest(text, REASK)) return handleJobPostingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, REASK)) {
    const answer = await answerQuestionMidFlow(phone, text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
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
  const CONFIRM_REASK = "Confirming whether to post this job for caregivers to see — reply YES to post it, or NO to start over.";
  if (await isBackOutRequest(text, CONFIRM_REASK)) return handleJobPostingBackOut(phone, chatId, session);
  // 2026-09-13 (live-caught, "it's keep repeating" — same fix given to
  // bookingFlow.ts/interviewFlow.ts's confirm steps): a real question gets
  // answered plus a short reminder, not the whole job-post summary again.
  if (await isQuestionOrOther(text, CONFIRM_REASK)) {
    const answer = await answerQuestionMidFlow(phone, text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, CONFIRM_REASK);
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
    await buildAndSaveJobPost({ uid, phone, onboardingData, jobData });

    await db.collection("agent_sessions").doc(phone).update({
      jobPostingStep: admin.firestore.FieldValue.delete(),
      jobPostingData:  admin.firestore.FieldValue.delete(),
      stateExpiresAt: admin.firestore.FieldValue.delete(),
    });

    // 2026-09-08 (Hamse's call): one honest, universal message — see
    // jobLiveMessage's own comment for why this no longer varies by
    // notifiedCount. No Job ID line either — it's a raw Firestore doc id (in
    // fact the client's own account uid, per buildJobPost.ts's
    // job_posts/{uid} keying — not a distinct per-job identifier at all),
    // meaningless to a family and never shown anywhere on the site either.
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
      context: `The family's care request was just submitted. Tell them you'll reach out as soon as applications start coming in, and mention they can view their post anytime by texting you "show my jobs". You MUST include the exact phrase "show my jobs".`,
      fallback: `${jobLiveMessage}\n\nYou can view your post any time by texting me "show my jobs".`,
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
  const zipCode   = (jobData.zipCode as string) ?? "";
  const startDate = (jobData.jobStartDate  as string) ?? "TBD";
  const frequency = (jobData.jobFrequency  as string) ?? "occasional";
  const days      = (jobData.jobDays       as string[]) ?? [];
  const times     = (jobData.jobTimeOfDay  as string[]) ?? [];
  const careNeeds = (jobData.jobCareNeeds  as string[]) ?? [];
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
  // 2026-09-08 (live-caught): the zip code was captured and stored correctly
  // (city/state resolve from it via lookupZipPlace) but never shown in this
  // summary at all, unlike the site's own review screen (Step6Review.tsx),
  // which always includes it — matching that exact "street, city, state zip"
  // composition so the family can see it was captured, not just trust it was.
  const locationLabel = street
    ? [street, city, `${state} ${zipCode}`.trim()].filter(Boolean).join(", ")
    : "TBD";

  // 2026-09-08 (Hamse's call): no emojis — matches the site's own Step6Review.tsx,
  // which renders this same summary as plain labeled text.
  return [
    title ? `Title: ${title}` : "",
    `For: ${recipientsLabel}`,
    `Caregivers needed: ${caregiversNeeded}`,
    `Location: ${locationLabel}`,
    `Start: ${formatDateForDisplay(startDate)}`,
    `Frequency: ${freqLabel[frequency] ?? frequency}`,
    `Days: ${daysLabel}`,
    `Time: ${timesLabel}`,
    `Care needs: ${needsLabel}`,
    `Rate: ${rateLabel} (${payMethod})`,
    `Pets: ${pets} | Smoking: ${smoking}`,
    desc ? `"${desc}"` : "",
  ].filter(Boolean).join("\n");
}
