import { CARE_PROVIDER_TERM_RULE } from "./terminology";
import { flowParseCall, flowAnswerCall } from "./flowModelCall";
import * as admin from "firebase-admin";
import { sendMessage, AgentSession } from "../linq/client";
import { enforceClientGate } from "./clientAccessGate";
import { buildAndSaveJobPost, jobLiveMessage } from "./buildJobPost";
import { defaultJobTitle } from "./jobPostContract";
import { kindsOfServices, careKindBadge, ageRangeLabel, AGE_RANGES, CareKind, CARE_KINDS, relationshipsForKinds, rosterCareKinds, serviceListsForKinds, ageRangeFromWords, stageOf, stageQuestion, recipientCareKind, OTHER_KIND_QUESTION, STAGE_HEADING } from "./caregiverServiceLabels";
import { isConvergenceFlipped, caraOutputGuardEnabled } from "../config/featureFlags";
import { generateCaraMessage } from "../utils/caraMessage";
import { allCareRecipients, recipientPlanKey } from "./careRecipients";
import { guardModelOutput, ANTI_INVENTION_CLAUSE } from "../safety/outputGuard";
import { describeSharedProfile } from "./profileBriefing";
import { deriveCareLevel } from "./clientJobPostingContract";
import { lookupZipPlace } from "../utils/geocode";
import { canonicalizeCareNeeds } from "./careNeedsTaxonomy";
import { serviceLabel, serviceLabels, serviceMenuText, JOB_DESCRIPTION_MAX_CHARS } from "./caregiverServiceLabels";
import { isBackOutRequest, TRIVIAL_CONFIRM_WORDS, bareNumberPick } from "./stepHandler";
import { formatDateForDisplay } from "../utils/scheduledTime";
import { isMedicationInstruction, MEDICATION_INSTRUCTION_MESSAGE } from "../utils/medicationInstruction";
import { containsContactDetails, CONTACT_DETAILS_MESSAGE } from "../utils/contactDetails";

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

export interface JobRecipient { firstName: string; lastName: string; relationship: string; isSelf: boolean; /** Only for "Other": the family's adult-or-child answer (asked for every Other since 2026-10-19). */ careKind?: "senior" | "child"; /** ONE stage per child (AGE_RANGES id), set on the child (2026-10-18 late). */ ageRange?: string; }
const isChildRecipient = (r: JobRecipient): boolean => recipientCareKind(r.isSelf ? "Myself" : r.relationship, r.careKind) === "child";
export interface JobLocation { street: string; city: string; state: string; zipCode: string; petsInHome: boolean; smokingHousehold: boolean; }

// The relationship choices are the same for every household (founder 2026-10-19: no care-type setting) —
// the site's add-person chips: Parent, Spouse or Partner, Adult child, Child, Other.
const RELATIONSHIP_CHIPS: string[] = relationshipsForKinds(CARE_KINDS, { includeMyself: false });
const chipsLine = (chips: readonly string[]): string => chips.length > 1 ? `${chips.slice(0, -1).join(", ")}, or ${chips[chips.length - 1]}` : chips.join("");

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
    addOpt({ firstName: f || r.name, lastName: rest.join(" "), relationship: r.relationship ?? "", isSelf: false, ...(r.careKind ? { careKind: r.careKind } : {}), ...(r.ageRange ? { ageRange: r.ageRange } : {}) });
  }

  const jpSnap = await db.collection("job_postings").doc(uid).get().catch(() => null);
  if (jpSnap?.exists) {
    const jp = jpSnap.data() as Record<string, unknown>;
    const asKind = (v: unknown): "senior" | "child" | undefined => (v === "child" || v === "senior" ? v : undefined);
    const pFirst = String(jp.careRecipientFirstName ?? "").trim();
    if (pFirst) addOpt({ firstName: pFirst, lastName: String(jp.careRecipientLastName ?? ""), relationship: String(jp.relationship ?? ""), isSelf: false, ...(asKind(jp.careRecipientCareKind) ? { careKind: asKind(jp.careRecipientCareKind) } : {}), ...(typeof jp.careRecipientAgeRange === "string" ? { ageRange: jp.careRecipientAgeRange } : {}) });
    const extra = Array.isArray(jp.additionalRecipients) ? jp.additionalRecipients as Array<Record<string, unknown>> : [];
    for (const r of extra) {
      const f = String(r.firstName ?? "").trim();
      if (!f) continue;
      const stage = stageOf(r);
      addOpt({ firstName: f, lastName: String(r.lastName ?? ""), relationship: String(r.relationship ?? ""), isSelf: false, ...(asKind(r.careKind) ? { careKind: asKind(r.careKind) } : {}), ...(stage ? { ageRange: stage } : {}) });
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
    const parsed = await flowParseCall(prompt + "\n" + CLASSIFICATION_GUARD_CLAUSE, userText, 200);
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
const JP_DIDNT_CATCH = "Sorry, I'm not sure I followed.";

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
  const answer = await flowAnswerCall(CARE_PROVIDER_TERM_RULE + " " + "You are Evia, a care coordinator helping a client post a care job. " +
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
      ANTI_INVENTION_CLAUSE, text, 100);
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
  // The patch is merged into ONE nested map, so a FieldValue.delete() inside it is not allowed
  // by Firestore ("must appear at the top level") and the whole update throws — live 2026-10-26
  // (Basra): the Adult / Child answer on a job post got the typing dots and then nothing. A delete
  // marker means "drop this key": remove it from the merged map instead of writing it.
  const merged: Record<string, unknown> = { ...existing };
  const deleteSentinel = admin.firestore.FieldValue.delete();
  for (const [k, v] of Object.entries(data)) {
    const isDelete = !!v && typeof v === "object" && typeof (v as { isEqual?: unknown }).isEqual === "function" && (v as { isEqual: (o: unknown) => boolean }).isEqual(deleteSentinel);
    if (isDelete) delete merged[k]; else merged[k] = v;
  }
  await db.collection("agent_sessions").doc(phone).update({ jobPostingData: merged });
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
  // PostsPage.tsx / ClientDashboard.tsx: "New Request" runs gate('booking') before the wizard opens.
  const gateClientId = session.userId as string | undefined;
  if (gateClientId && await enforceClientGate(phone, chatId, gateClientId, "booking")) return;
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
  // An edit in progress (from the recap, or a correction mid-flow) sits on a step whose field is already
  // filled — the stored step is the truth then, never the derived one (2026-10-26).
  const jd = (session as any).jobPostingData as Record<string, unknown> | undefined;
  const editInProgress = jd?.editingFromConfirm === true || (typeof jd?.resumeStep === "string" && jd.resumeStep.length > 0);
  // U13 (DARK): derive the step from collected fields when the flag is on. Gate
  // step (jp_confirm_post) + all handlers unchanged; flag OFF ⇒ no change.
  if (!editInProgress && isJobPostingDispatchEnabled() && isDispatchableJobStep(step)) {
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
  const REASK = `Who is this job for?\n\n${listText}\n\nTell me a name or number (a few is fine), or tell me someone new and how they're related to you.`;

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
      await addNewRecipientOrAskKind(phone, chatId, session, chosen, first, rest.join(" "), relationship);
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
    await sendMessage(chatId, `Got it — and what's your relationship to ${first}? (${chipsLine(RELATIONSHIP_CHIPS)})`);
    return;
  }

  await finishRecipientSelection(phone, chatId, session, chosen);
}

// A new person with their relationship known: "Other" is the one case the relationship can't settle,
// so the site's follow-up (Adult / Child) is asked once, here — for EVERY Other (founder 2026-10-19);
// everyone else joins the post straight away.
async function addNewRecipientOrAskKind(
  phone: string, chatId: string, _session: AgentSession, chosen: JobRecipient[], first: string, last: string, relationship: string,
): Promise<void> {
  if (relationship === "Other") {
    await mergeJobData(phone, {
      careRecipients: chosen,
      pendingNewRecipientFirstName: first,
      pendingNewRecipientLastName: last,
      pendingNewRecipientRelationship: "Other",
      awaitingRecipientKind: true,
    });
    await updateJobStep(phone, "jp_ask_recipient_relationship");
    await sendMessage(chatId, `Got it. ${OTHER_KIND_QUESTION} (Adult / Child)`);
    return;
  }
  await finishRecipientSelection(phone, chatId, _session, [...chosen, { firstName: first, lastName: last, relationship, isSelf: false }]);
}

async function finishRecipientSelection(
  phone: string, chatId: string, session: AgentSession, chosen: JobRecipient[]
): Promise<void> {
  await mergeJobData(phone, { careRecipients: chosen });
  if (await resumeAfterEdit(phone, chatId, session)) return;
  await updateJobStep(phone, "jp_ask_caregivers_needed");
  const names = chosen.map((r) => r.isSelf ? "you" : r.firstName).join(" and ");
  await sendMessage(chatId,
    `Got it — care for ${names}.\n\nHow many care providers do you need for this job? Most families need just 1, and anywhere from 1 to 4 is fine.`
  );
}

async function handleJpAskRecipientRelationship(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const jobData = await getJobData(phone);
  const first = (jobData.pendingNewRecipientFirstName as string) ?? "them";
  const chips = RELATIONSHIP_CHIPS;
  const awaitingKind = jobData.awaitingRecipientKind === true;
  const REASK = awaitingKind ? `${OTHER_KIND_QUESTION} (Adult / Child)` : `What's your relationship to ${first}? (${chipsLine(chips)})`;
  if (await isBackOutRequest(text, REASK)) return handleJobPostingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, REASK)) {
    const answer = await answerQuestionMidFlow(phone, text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
    return;
  }
  const last = (jobData.pendingNewRecipientLastName as string) ?? "";
  const existing = (jobData.careRecipients as JobRecipient[]) ?? [];
  if (awaitingKind) {
    // The site's follow-up for "Other" — the model reads the answer, the enum clamps it.
    const raw = await parseWithClaude(
      'The family was asked whether a person is an adult or a child. Reply SENIOR for an adult, CHILD for a child, or OTHER if the message does not say. Reply with exactly one word.',
      text
    );
    const kind = /^child$/i.test(raw.trim()) ? "child" : /^senior$/i.test(raw.trim()) ? "senior" : null;
    if (!kind) { await sendMessage(chatId, `${JP_DIDNT_CATCH} ${REASK}`); return; }
    await mergeJobData(phone, { awaitingRecipientKind: admin.firestore.FieldValue.delete(), pendingNewRecipientRelationship: admin.firestore.FieldValue.delete() });
    await finishRecipientSelection(phone, chatId, session, [...existing, { firstName: first, lastName: last, relationship: "Other", isSelf: false, careKind: kind }]);
    return;
  }
  const raw = await parseWithClaude(
    `Map the relationship described to exactly one of: ${chips.join(", ")}. ` +
    '"mom"/"dad"/"mother"/"father"/"parent" = Parent. "husband"/"wife"/"partner"/"spouse" = "Spouse or Partner". ' +
    (chips.includes("Adult child") ? '"adult son"/"adult daughter"/"grown son"/"grown daughter"/"my son, he is 30" (a grown child) = "Adult child". ' : "") +
    (chips.includes("Child") ? '"son"/"daughter"/"kid"/"child"/"grandchild" (a minor, or no sign of their age) = Child. ' : (chips.includes("Adult child") ? '"son"/"daughter" with no sign they are a minor = "Adult child". ' : "")) +
    'Anything else relationship-like = Other. Reply with exactly one of those values.',
    text
  );
  const relationship = matchEnum(raw, chips);
  if (!relationship) {
    await sendMessage(chatId, `${JP_DIDNT_CATCH} ${REASK}`);
    return;
  }
  await addNewRecipientOrAskKind(phone, chatId, session, existing, first, last, relationship);
}

async function handleJpAskCaregiversNeeded(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const REASK = "How many care providers do you need for this job? Most families need just 1, and anywhere from 1 to 4 is fine.";
  let n = bareNumberPick(text, 4);
  if (n === null) {
    if (await isBackOutRequest(text, REASK)) return handleJobPostingBackOut(phone, chatId, session);
    if (await isQuestionOrOther(text, REASK)) {
      const answer = await answerQuestionMidFlow(phone, text, session);
      await sendMessage(chatId, answer);
      await sendMessage(chatId, REASK);
      return;
    }
    const raw = await parseWithClaude(
      'Extract how many care providers the family needs, as a number from 1 to 4. "just one"/"one"/"1" = 1. Reply with only the number, or NONE if the message states no count — never guess.',
      text
    );
    n = parseInt(raw, 10);
    if (isNaN(n) || n < 1 || n > 4) {
      await sendMessage(chatId, `${JP_DIDNT_CATCH} ${REASK}`);
      return;
    }
  }
  await mergeJobData(phone, { caregiversNeeded: n });
  if (await resumeAfterEdit(phone, chatId, session)) return;
  await updateJobStep(phone, "jp_ask_location");

  const uid = (session as any).userId as string | undefined;
  const onboardingData = (session as any).onboardingData as Record<string, unknown> ?? {};
  const locations = uid ? await fetchLocationOptions(uid, onboardingData) : [];
  const listText = formatLocationOptions(locations);
  await sendMessage(chatId,
    `Got it — ${n} care provider${n === 1 ? "" : "s"}.\n\nWhich address is this for?\n\n${listText}\n\n` +
    (locations.length ? "Just tell me the number, or a new street address and zip code." : "Tell me the street address and zip code.")
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
    (locations.length ? "Just tell me the number, or a new street address and zip code." : "Tell me the street address and zip code.");

  let matchedIndex: number | null = bareNumberPick(text, locations.length);
  let newStreet: string | null = null;
  let newZip: string | null = null;
  if (matchedIndex === null) {
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
    const parsed = parseJsonLoose(raw, "handleJpAskLocation");
    if (parsed) {
      if (typeof parsed.matchedIndex === "number" && parsed.matchedIndex >= 1 && parsed.matchedIndex <= locations.length) {
        matchedIndex = parsed.matchedIndex;
      }
      if (typeof parsed.newStreet === "string" && parsed.newStreet.trim()) newStreet = parsed.newStreet.trim();
      if (typeof parsed.newZip === "string" && /^\d{5}$/.test(parsed.newZip.trim())) newZip = parsed.newZip.trim();
    }
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
    if (await resumeAfterEdit(phone, chatId, session)) return;
    await updateJobStep(phone, "jp_ask_care_needs");
    await sendMessage(chatId, `Got it — ${loc.street}.\n\n${await careNeedsQuestion(phone, session)}`);
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
      "You can answer both at once, like yes a dog and no smoking."
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
  // Same as the site's step-2 Save (2026-09-27): the flags live on the Care
  // Plan's location pool entry for this address, patched in place.
  try {
    const jd = await getJobData(phone);
    const uid = (session as unknown as { userId?: string }).userId;
    if (uid && typeof jd.streetAddress === "string" && jd.streetAddress) {
      const ref = db.collection("carePlans").doc(uid);
      const snap = await ref.get();
      const pool: Array<Record<string, unknown>> = Array.isArray(snap.data()?.locationPool) ? [...(snap.data()!.locationPool as Array<Record<string, unknown>>)] : [];
      const key = (s?: unknown, z?: unknown) => `${String(s ?? "").toLowerCase().trim()}|${String(z ?? "")}`;
      const idx = pool.findIndex((l) => key(l?.street, l?.zipCode) === key(jd.streetAddress, jd.zipCode));
      const next = { street: String(jd.streetAddress), city: String(jd.city ?? ""), state: String(jd.state ?? ""), zipCode: String(jd.zipCode ?? ""), petsInHome, smokingHousehold };
      if (idx >= 0) pool[idx] = { ...pool[idx], petsInHome, smokingHousehold }; else pool.push(next);
      await ref.set({ locationPool: pool }, { merge: true });
    }
  } catch (err) {
    console.warn("[jobPostingFlow] location flags write-back skipped:", err instanceof Error ? err.message : err);
  }
  if (await resumeAfterEdit(phone, chatId, session)) return;
  await updateJobStep(phone, "jp_ask_care_needs");
  await sendMessage(chatId,
    `Got it — ${petsInHome ? "pets, yes" : "no pets"}, ${smokingHousehold ? "smoking, yes" : "no smoking"}.\n\n${await careNeedsQuestion(phone, session)}`
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

// No household care-type setting exists (founder 2026-10-19): the list(s) a post shows follow the
// RECIPIENTS on it — a child → the child list, an adult → the senior list, both → both lists; nobody
// on the post yet = the senior list.
function postCareKinds(recipients: readonly JobRecipient[]): CareKind[] {
  const onPost = rosterCareKinds(recipients.map((r) => ({ relationship: r.isSelf ? "Myself" : r.relationship, careKind: r.careKind })));
  return onPost.length ? onPost : ["senior"];
}

// ONE stage per child, set on the child (2026-10-18 late): asked only for a child on THIS post who has none yet,
// one at a time, by the child's first name when the post names more than one child — never a multi-select.
const RATE_Q = `What hourly rate are you offering? You can give a number, like $20, or say flexible.`;
const childrenOnPost = (recipients: JobRecipient[]): JobRecipient[] => recipients.filter(isChildRecipient);
function nextStageQuestion(recipients: JobRecipient[]): { child: JobRecipient; question: string } | null {
  const children = childrenOnPost(recipients);
  const child = children.find((r) => !r.ageRange);
  if (!child) return null;
  return { child, question: stageQuestion(children.length > 1 ? child.firstName : null) };
}
/** After the care needs (and after each stage answer): the next child's stage, or on to the rate. */
async function askNextStageOrRate(phone: string, chatId: string, session: AgentSession, recipients: JobRecipient[], prefix: string): Promise<void> {
  const next = nextStageQuestion(recipients);
  if (next) {
    await mergeJobData(phone, { awaitingStageFor: next.child.firstName });
    await sendMessage(chatId, `${prefix}${next.question}`);
    return;
  }
  await mergeJobData(phone, { awaitingStageFor: admin.firestore.FieldValue.delete() });
  if (await resumeAfterEdit(phone, chatId, session)) return;
  await updateJobStep(phone, "jp_ask_rate");
  await sendMessage(chatId, `${prefix}${RATE_Q}`);
}

async function careNeedsQuestion(phone: string, session: AgentSession): Promise<string> {
  const jobData = await getJobData(phone);
  const recipients = (jobData.careRecipients as JobRecipient[]) ?? [];
  const name = recipients.length
    ? recipients.map((r) => r.isSelf ? "you" : r.firstName).join(" and ")
    : "your loved one";
  const kinds = postCareKinds(recipients);
  // 2026-09-08 (live-caught): "you" is second person — "does you need" reads
  // as broken grammar; every other name here is third person ("does Samira
  // need"). needCareVerb (below) picks the right conjugation either way.
  // The website's step: the list(s) by name, nothing underneath (2026-10-04 / 2026-10-18).
  return `What type of care ${needCareVerb(name)} ${name} need? Pick as many as apply:\n${serviceMenuText(kinds)}`;
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
  if (await resumeAfterEdit(phone, chatId, session)) return;
  await updateJobStep(phone, "jp_ask_start");
  await sendMessage(chatId,
    `${label[frequency] ?? "Got it"}! When would you like care to start? You can say next Monday, as soon as possible, or a specific date.`
  );
}

async function handleJpAskStart(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const REASK = `When would you like care to start? You can say next Monday, as soon as possible, or a specific date.`;
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
  if (await resumeAfterEdit(phone, chatId, session)) return;
  await updateJobStep(phone, "jp_ask_days");
  await sendMessage(chatId,
    `Got it — starting ${formatDateForDisplay(stored)}! Which days work best? You can say Mon, Wed, Fri, or weekdays, or every day.`
  );
}

async function handleJpAskDays(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const REASK = "Which days work best? You can say Mon, Wed, Fri, or weekdays.";
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
  if (await resumeAfterEdit(phone, chatId, session)) return;
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
  if (await resumeAfterEdit(phone, chatId, session)) return;
  await updateJobStep(phone, "jp_ask_recipients");
  const onboardingData = (session as any).onboardingData as Record<string, unknown> ?? {};
  const uid = (session as any).userId as string | undefined;
  const options = uid ? await fetchRecipientOptions(uid, onboardingData) : [];
  const listText = formatRecipientOptions(options);
  await sendMessage(chatId,
    `${timeLabel} — noted!\n\nWho is this job for?\n\n${listText}\n\n` +
    "Tell me a name or number (a few is fine), or tell me someone new and how they're related to you."
  );
}

async function handleJpAskCareNeeds(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const name = await recipientsDisplayName(phone, session);
  const jobData0 = await getJobData(phone);
  // The list(s) follow the recipients on THIS post (their relationships): a post for a child shows the
  // child list + the stage chips; a post for an adult the senior list; both when the post names both.
  const recipients0 = (jobData0.careRecipients as JobRecipient[] | undefined) ?? [];
  const kinds: CareKind[] = postCareKinds(recipients0);
  const awaitingStageFor = typeof jobData0.awaitingStageFor === "string" ? jobData0.awaitingStageFor : null;
  const pendingStage = awaitingStageFor ? nextStageQuestion(recipients0) : null;
  const REASK = pendingStage ? pendingStage.question
    : `What type of care ${needCareVerb(name)} ${name} need? Pick as many as apply:\n${serviceMenuText(kinds)}`;
  // The answer is read FIRST; back-out / question only when nothing on the list was named (live
  // 2026-10-21: "school & homework" — an item on the menu — was judged "something else" and bounced).
  const notAnAnswer = async (): Promise<boolean> => {
    if (await isBackOutRequest(text, REASK)) { await handleJobPostingBackOut(phone, chatId, session); return true; }
    if (await isQuestionOrOther(text, REASK)) {
      const answer = await answerQuestionMidFlow(phone, text, session);
      await sendMessage(chatId, `${answer}\n\n${REASK}`);
      return true;
    }
    return false;
  };

  // ONE stage per child (2026-10-18 late): the answer lands on that child; then the next child, or the rate.
  if (pendingStage) {
    const raw = await parseWithClaude(
      `The family was asked which stage a child is at. Map their message onto exactly one of these names: ${AGE_RANGES.map((a) => a.label).join(", ")}. ` +
        'Reply with that one name, or NONE if the message does not say.',
      text,
    ).catch(() => "NONE");
    const id = ageRangeFromWords(raw);
    if (!id) {
      if (await notAnAnswer()) return;
      await sendMessage(chatId, `${JP_DIDNT_CATCH} ${pendingStage.question}`);
      return;
    }
    const key = recipientPlanKey(pendingStage.child.firstName, pendingStage.child.lastName);
    const updated = recipients0.map((r) => (recipientPlanKey(r.firstName, r.lastName) === key ? { ...r, ageRange: id } : r));
    await mergeJobData(phone, { careRecipients: updated });
    await askNextStageOrRate(phone, chatId, session, updated, `${pendingStage.child.firstName} · ${ageRangeLabel(id)} — noted! `);
    return;
  }

  // Names or the family's words → the website's lists (the mapper both sides
  // share); medical care is never a need; off-list words are left off and said
  // so; nothing is stored underneath a category (2026-10-04).
  const canon = await canonicalizeCareNeeds([text], { kinds });
  const notes: string[] = [];
  if (canon.medical.length) notes.push(`Care Providers here don't administer medication or give medical treatment, so "${canon.medical.join('", "')}" isn't a type of care I can add — the closest on the list is Medication Reminders Only (reminding when it's time, not giving them).`);
  if (canon.unmapped.length) notes.push(`"${canon.unmapped.join('", "')}" isn't one of the types of care on the list, so I've left it off.`);
  if (canon.unresolved.length) notes.push(`I couldn't place "${canon.unresolved.join('", "')}" — which of the list did you mean?`);
  // A service from the other list (a child service for an adult, or the reverse) is left off and said so —
  // the site has no way to tick it for that person either.
  const shown = new Set(serviceListsForKinds(kinds).flatMap((l) => l.services as readonly string[]));
  const careNeeds = canon.careNeeds.filter((s) => shown.has(s));
  const offList = canon.careNeeds.filter((s) => !shown.has(s));
  if (offList.length) notes.push(`"${offList.map(serviceLabel).join('", "')}" isn't on ${name}'s list, so I've left it off.`);
  if (careNeeds.length === 0) {
    // Nothing care-related in the message at all → maybe a back-out or a question. Something named
    // but left off (medical / off-list / unplaced) is an attempt at the question: the note + re-ask answer it.
    const sawNothing = !canon.medical.length && !canon.unmapped.length && !canon.unresolved.length && !offList.length;
    if (sawNothing && await notAnAnswer()) return;
    await sendMessage(chatId, `${notes.join(" ")}${notes.length ? " " : ""}${REASK}`);
    return;
  }
  const needsLabel = `${notes.join(" ")}${notes.length ? " " : ""}${serviceLabels(careNeeds).join(", ")}`;
  // jobCareLevel derived, never asked — see the JP_STEP_ORDER comment at the
  // top of the file for why.
  const jobCareLevel = deriveCareLevel([], careNeeds);
  // The post's kinds follow what was ticked (a Transportation-only post keeps the recipients' kinds);
  // the silent title default follows the kinds (jobPostContract.ts defaultJobTitle).
  const postKinds = kindsOfServices(careNeeds, kinds);
  const city = (jobData0.city as string) || "";
  await mergeJobData(phone, { jobCareNeeds: careNeeds, jobCareLevel, jobCareKinds: postKinds, jobTitle: defaultJobTitle(city || null, postKinds) });
  // A child on this post with no stage yet is asked for it here, one child at a time; otherwise the rate.
  await askNextStageOrRate(phone, chatId, session, recipients0, `${needsLabel} — noted! `);
}

async function handleJpAskRate(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const REASK = "What hourly rate are you offering? You can give a number, like $20, or say flexible.";
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
    'If the message states a dollar amount, return only the number (e.g. 20, 18.50). ' +
    'If it states NEITHER an amount NOR that the rate is flexible, return NONE — never guess (live 2026-10-26: a stray "Toddler" here must not become a flexible rate).',
    text
  );
  const rate = /^\s*NONE/i.test(raw) ? NaN : parseFloat(raw);
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
  if (await resumeAfterEdit(phone, chatId, session)) return;
  await updateJobStep(phone, "jp_ask_description");
  await sendMessage(chatId,
    // The site's Details box, word for word (2026-10-17): its heading is the question, the one line under it is the warning.
    `${rateLabel} — sounds good! Last question: what else should care providers know about this job?\n\n` +
    `A sentence or two is great. ${JOB_DESCRIPTION_PUBLIC_LINE}`
  );
}

// The line under the site's job-description box (Step5Describe.tsx / ClientJobPostingWizard.tsx), verbatim.
const JOB_DESCRIPTION_PUBLIC_LINE = "Care providers browsing jobs can read this. Leave out medical details, addresses, phone numbers, email addresses, and anything private.";

async function handleJpAskDescription(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const REASK = `What else should care providers know about this job? A sentence or two is great. ${JOB_DESCRIPTION_PUBLIC_LINE}`;
  if (await isBackOutRequest(text, REASK)) return handleJobPostingBackOut(phone, chatId, session);
  if (await isQuestionOrOther(text, REASK)) {
    const answer = await answerQuestionMidFlow(phone, text, session);
    await sendMessage(chatId, answer);
    await sendMessage(chatId, REASK);
    return;
  }
  // "I didn't give you the rate" is not the job's details (live 2026-10-26: it was posted as the note) — a
  // correction or objection about an earlier answer goes to that field, then this question is asked again.
  const correction = await readJobPostEdit(text, "midflow");
  if (correction.action in JP_EDIT_STEP) { await applyJobPostEdit(phone, chatId, session, correction, { from: "midflow", reask: REASK }); return; }
  const description = text.trim();
  // A limit, never a silent cut (founder, 2026-10-19) — the site's Details box stops at the same count.
  if (description.length > JOB_DESCRIPTION_MAX_CHARS) {
    await sendMessage(chatId, `That's ${description.length.toLocaleString("en-US")} characters and the job details hold up to ${JOB_DESCRIPTION_MAX_CHARS.toLocaleString("en-US")}. Could you send a shorter version?`);
    return;
  }
  if (isMedicationInstruction(description)) {
    await sendMessage(chatId, `${MEDICATION_INSTRUCTION_MESSAGE} ${REASK}`);
    return;
  }
  // No phone number, email or link in the public details (2026-11-09) — same line as the site's box.
  if (containsContactDetails(description)) {
    await sendMessage(chatId, `${CONTACT_DETAILS_MESSAGE} ${REASK}`);
    return;
  }
  await mergeJobData(phone, { jobDescription: description });
  await updateJobStep(phone, "jp_confirm_post");
  await sendJobPostRecap(phone, chatId, session);
}

// ── Edits from the recap, and corrections mid-flow — the site's Edit buttons on its review step ──────────
// (live 2026-10-26: "Change the rate to 20" at the recap re-showed the same recap; the recap said "tell me
// what to change" and had no way to.) One structured read decides WHICH field and, when the message states
// the new value, what it is; a value lands at once and the recap is shown again; without one the flow jumps
// back to that step, and the step's own advance brings it straight back here (resumeAfterEdit).
type JobPostEditAction = "confirm" | "cancel" | "other" | "edit_frequency" | "edit_start" | "edit_days" | "edit_time" | "edit_recipients" | "edit_count" | "edit_location" | "edit_home" | "edit_care_needs" | "edit_rate" | "edit_description";
interface JobPostEdit { action: JobPostEditAction; newRate: number | null; newCount: number | null; newDescription: string | null; pets: boolean | null; smoking: boolean | null }
const JP_EDIT_STEP: Record<string, string> = {
  edit_frequency: "jp_ask_frequency", edit_start: "jp_ask_start", edit_days: "jp_ask_days", edit_time: "jp_ask_time",
  edit_recipients: "jp_ask_recipients", edit_count: "jp_ask_caregivers_needed", edit_location: "jp_ask_location",
  edit_home: "jp_ask_location_environment", edit_care_needs: "jp_ask_care_needs", edit_rate: "jp_ask_rate", edit_description: "jp_ask_description",
};

async function readJobPostEdit(text: string, where: "recap" | "midflow"): Promise<JobPostEdit> {
  const none: JobPostEdit = { action: "other", newRate: null, newCount: null, newDescription: null, pets: null, smoking: null };
  const raw = await parseWithClaude(
    (where === "recap"
      ? "The family is reviewing their job post summary before it goes live. Classify their reply. "
      : "The family is mid-way through posting a job and was just asked for the job's details. Decide whether this message is instead a correction or objection about an EARLIER answer (the rate, the days, the time, the start, how often, who it is for, how many care providers, the address, pets / smoking, the types of care). If it is the details themselves, or anything else, it is \"other\". ") +
    'Return ONLY a JSON object: {"action": string, "newRate": number or null, "newCount": number or null, "newDescription": string or null, "pets": true, false or null, "smoking": true, false or null}. ' +
    'action is one of: "confirm" (yes / post it / looks good — only at the recap), "cancel" (no / start over / never mind — only at the recap), ' +
    '"edit_rate" (the hourly rate or pay — set newRate to the dollar amount ONLY if this message states one; "flexible" → 0; "I didn\'t give you the rate" / "you never asked my rate" → edit_rate with newRate null), ' +
    '"edit_days" (which days), "edit_time" (the time of day), "edit_start" (the start date), "edit_frequency" (occasional / part-time / full-time), ' +
    '"edit_recipients" (who the job is for), "edit_count" (how many care providers — set newCount 1 to 4 when stated), "edit_location" (the address), ' +
    '"edit_home" (pets or smoking — set pets / smoking when stated), "edit_care_needs" (the types of care), "edit_description" (the details text — set newDescription to the new text when the message gives it), ' +
    'or "other". Never invent a value the message does not state.',
    text,
  ).catch(() => "");
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return none;
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const action = typeof o.action === "string" && (o.action === "confirm" || o.action === "cancel" || o.action in JP_EDIT_STEP) ? (o.action as JobPostEditAction) : "other";
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      action, newRate: num(o.newRate), newCount: num(o.newCount),
      newDescription: typeof o.newDescription === "string" && o.newDescription.trim() ? o.newDescription.trim() : null,
      pets: typeof o.pets === "boolean" ? o.pets : null, smoking: typeof o.smoking === "boolean" ? o.smoking : null,
    };
  } catch { return none; }
}

/** The step's own question, for a jump back to it. */
async function jpQuestionFor(step: string, phone: string, session: AgentSession): Promise<string> {
  const uid = (session as any).userId as string | undefined;
  const onboardingData = ((session as any).onboardingData as Record<string, unknown>) ?? {};
  switch (step) {
    case "jp_ask_frequency": return "How often do you need help? Occasional (1–2 days a week), part-time (3–4 days), or full-time (5+)?";
    case "jp_ask_start": return "When would you like care to start? You can say next Monday, as soon as possible, or a specific date.";
    case "jp_ask_days": return "Which days work best? You can say Mon, Wed, Fri, or weekdays.";
    case "jp_ask_time": return "What time of day works best? Mornings, afternoons, evenings, overnight, or a mix?";
    case "jp_ask_recipients": {
      const options = uid ? await fetchRecipientOptions(uid, onboardingData) : [];
      return `Who is this job for?\n\n${formatRecipientOptions(options)}\n\nTell me a name or number (a few is fine), or tell me someone new and how they're related to you.`;
    }
    case "jp_ask_caregivers_needed": return "How many care providers do you need for this job? Most families need just 1, and anywhere from 1 to 4 is fine.";
    case "jp_ask_location": {
      const locations = uid ? await fetchLocationOptions(uid, onboardingData) : [];
      return `Which address is this for?\n\n${formatLocationOptions(locations)}\n\n${locations.length ? "Just tell me the number, or a new street address and zip code." : "Tell me the street address and zip code."}`;
    }
    case "jp_ask_location_environment": return "Are there pets in the home? Does anyone smoke in the home?";
    case "jp_ask_care_needs": return careNeedsQuestion(phone, session);
    case "jp_ask_rate": return RATE_Q;
    default: return `What else should care providers know about this job? A sentence or two is great. ${JOB_DESCRIPTION_PUBLIC_LINE}`;
  }
}

async function sendJobPostRecap(phone: string, chatId: string, session: AgentSession, prefix = ""): Promise<void> {
  const jobData = await getJobData(phone);
  const summary = buildJobSummary(jobData, session);
  await sendMessage(chatId, `${prefix}Here's your job post:\n\n${summary}\n\nDoes that look right? Say yes and I'll post it for care providers to see, or tell me what to change.`);
}

/**
 * After a step that was re-entered from an edit: back to the recap (an edit from the recap), or back to the
 * question the correction interrupted (a correction mid-flow). False when the flow is simply moving forward.
 */
async function resumeAfterEdit(phone: string, chatId: string, session: AgentSession): Promise<boolean> {
  const jobData = await getJobData(phone);
  if (jobData.editingFromConfirm === true) {
    await mergeJobData(phone, { editingFromConfirm: admin.firestore.FieldValue.delete() });
    await updateJobStep(phone, "jp_confirm_post");
    await sendJobPostRecap(phone, chatId, session, "Updated. ");
    return true;
  }
  if (typeof jobData.resumeStep === "string" && jobData.resumeStep) {
    const step = jobData.resumeStep;
    await mergeJobData(phone, { resumeStep: admin.firestore.FieldValue.delete() });
    await updateJobStep(phone, step);
    await sendMessage(chatId, `Thanks. ${await jpQuestionFor(step, phone, session)}`);
    return true;
  }
  return false;
}

async function applyJobPostEdit(
  phone: string, chatId: string, session: AgentSession, edit: JobPostEdit, where: { from: "recap" } | { from: "midflow"; reask: string },
): Promise<void> {
  const step = JP_EDIT_STEP[edit.action];
  // A value in the message lands at once.
  const landed = async (ack: string): Promise<void> => {
    if (where.from === "recap") { await sendJobPostRecap(phone, chatId, session, `${ack} `); return; }
    await sendMessage(chatId, `${ack} ${where.reask}`);
  };
  if (edit.action === "edit_rate" && edit.newRate !== null && edit.newRate >= 0) {
    await mergeJobData(phone, { jobHourlyRate: edit.newRate, jobPaymentMethod: "card" });
    return landed(edit.newRate > 0 ? `Rate updated to $${edit.newRate}/hr.` : "Rate set to flexible.");
  }
  if (edit.action === "edit_count" && edit.newCount !== null && edit.newCount >= 1 && edit.newCount <= 4) {
    await mergeJobData(phone, { caregiversNeeded: edit.newCount });
    return landed(`Care providers needed: ${edit.newCount}.`);
  }
  if (edit.action === "edit_home" && (edit.pets !== null || edit.smoking !== null)) {
    await mergeJobData(phone, { ...(edit.pets !== null ? { petsInHome: edit.pets } : {}), ...(edit.smoking !== null ? { smokingHousehold: edit.smoking } : {}) });
    return landed("Home details updated.");
  }
  if (edit.action === "edit_description" && edit.newDescription) {
    if (edit.newDescription.length > JOB_DESCRIPTION_MAX_CHARS) { await sendMessage(chatId, `That's ${edit.newDescription.length.toLocaleString("en-US")} characters and the job details hold up to ${JOB_DESCRIPTION_MAX_CHARS.toLocaleString("en-US")}. Could you send a shorter version?`); return; }
    if (isMedicationInstruction(edit.newDescription)) { await sendMessage(chatId, `${MEDICATION_INSTRUCTION_MESSAGE} What should the details say instead?`); return; }
    if (containsContactDetails(edit.newDescription)) { await sendMessage(chatId, `${CONTACT_DETAILS_MESSAGE} What should the details say instead?`); return; }
    await mergeJobData(phone, { jobDescription: edit.newDescription });
    return landed("Details updated.");
  }
  // No value given → that step's question; its advance comes straight back here.
  await mergeJobData(phone, where.from === "recap" ? { editingFromConfirm: true } : { resumeStep: "jp_ask_description" });
  await updateJobStep(phone, step);
  await sendMessage(chatId, `Sure. ${await jpQuestionFor(step, phone, session)}`);
}

async function handleJpConfirmPost(
  phone: string, chatId: string, text: string, session: AgentSession
): Promise<void> {
  const CONFIRM_REASK = "Should I post this job for care providers to see? Say yes to post it, or no to hold off.";

  // 2026-09-14 — same fix as bookingFlow.ts's handleBkConfirm: a bare,
  // unambiguous affirmative can never reasonably mean "cancel", so it skips
  // the probabilistic isBackOutRequest/classify calls entirely instead of
  // trusting them to get a borderline call right.
  const bareYes = text.trim().toUpperCase().replace(/[.!?]+$/g, "");
  let norm: string;
  if (TRIVIAL_CONFIRM_WORDS.has(bareYes)) {
    norm = "YES";
  } else {
    if (await isBackOutRequest(text, CONFIRM_REASK)) return handleJobPostingBackOut(phone, chatId, session);
    // The site's Edit buttons (live 2026-10-26: "change the rate to 20" went nowhere): a change named here is
    // applied, or its step is re-asked and comes straight back to this recap.
    const edit = await readJobPostEdit(text, "recap");
    if (edit.action in JP_EDIT_STEP) { await applyJobPostEdit(phone, chatId, session, edit, { from: "recap" }); return; }
    if (edit.action === "confirm") { norm = "YES"; }
    else if (edit.action === "cancel") { norm = "NO"; }
    else {
    // 2026-09-13 (live-caught, "it's keep repeating" — same fix given to
    // bookingFlow.ts/interviewFlow.ts's confirm steps): a real question gets
    // answered plus a short reminder, not the whole job-post summary again.
    if (await isQuestionOrOther(text, CONFIRM_REASK)) {
      const answer = await answerQuestionMidFlow(phone, text, session);
      await sendMessage(chatId, answer);
      await sendMessage(chatId, CONFIRM_REASK);
      return;
    }

    norm = await parseWithClaude(
      'The user is confirming or declining to post a job. ' +
      '"yes", "yep", "post it", "go ahead", "do it", "confirm", "looks good", "perfect" = YES. ' +
      '"no", "start over", "restart", "redo", "nope", "cancel" = NO. ' +
      'Reply with exactly YES or NO.',
      text
    );
    }
  }

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
      `Just to confirm, here's your job post:\n\n${summary}\n\nShould I post it?`
    );
    return;
  }

  // YES — post the job
  const uid = (session as any).userId as string | undefined;
  if (!uid) {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
      context: "You hit a snag finding the family's account while trying to post their job. Apologize briefly and ask them to reply so you can post it again. Never send them to the website. Reassuring, not technical.",
      fallback: "Sorry, that didn't go through. Reply and I'll post it again.",
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
      context: "Something went wrong while posting the family's job. Apologize briefly and ask them to reply so you can post it again. Never send them to the website. Reassuring, not technical.",
      fallback: "Sorry, that didn't go through. Reply and I'll post it again.",
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
  const kindBadge = careKindBadge(kindsOfServices(careNeeds, jobData.jobCareKinds));
  // ONE stage per child (2026-10-18 late): "Mahad · Toddler" per child on the post (a legacy post-level list as a fallback).
  const stages    = childrenOnPost(recipients).filter((r) => r.ageRange).map((r) => `${r.firstName} · ${ageRangeLabel(r.ageRange as string)}`);
  const ages      = stages.length ? stages : (Array.isArray(jobData.ageRanges) ? (jobData.ageRanges as string[]) : []).map(ageRangeLabel);
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
  const needsLabel = careNeeds.length > 0 ? careNeeds.map(serviceLabel).join(", ") : "General care";
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
    `Care Providers needed: ${caregiversNeeded}`,
    `Location: ${locationLabel}`,
    `Start: ${formatDateForDisplay(startDate)}`,
    `Frequency: ${freqLabel[frequency] ?? frequency}`,
    `Days: ${daysLabel}`,
    `Time: ${timesLabel}`,
    `Care needs: ${needsLabel}`,
    kindBadge ? `Care: ${kindBadge}` : "",
    ages.length ? `${STAGE_HEADING}: ${ages.join(", ")}` : "",
    `Rate: ${rateLabel} (${payMethod})`,
    `Pets: ${pets} | Smoking: ${smoking}`,
    desc ? `"${desc}"` : "",
  ].filter(Boolean).join("\n");
}
