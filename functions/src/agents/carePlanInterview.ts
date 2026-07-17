// Post-payment care-plan interview (2026-07-15).
//
// After a family finishes onboarding (payment → job live → permissions →
// onboardingStep "complete"), Evia interviews them to build the FULL care plan —
// task detail per recipient, medications, and an emergency contact — so
// caregivers know exactly what care is needed. Founder decisions (07-15):
//   • Kickoff at onboarding-complete (the payment→permissions window is owned
//     by deterministic state machines — never inject the interview there).
//   • Free agent loop drives it (not sequenced steps): a per-turn directive
//     grounded in LIVE completeness, hard-completion pressure, everything
//     interrupts, the interview re-asserts each turn until done.
//   • "Complete" is COMPUTED FROM DATA (never model-asserted): task detail for
//     every recipient + medications (an explicit "none" counts) + one emergency
//     contact (an explicit decline counts).
//   • On completion: targeted job_posts field update (privacy-filtered task
//     detail only — NEVER a buildWebJobPostDoc rebuild, which would zero
//     applicantCount/notifiedCount and bump createdAt) + a follow-up text to
//     ENGAGED caregivers only (replied interested or applied).
//   • Privacy line: task detail flows to caregivers; medication names,
//     diagnoses, routine specifics, contacts, and recipient names never do.
//     buildCaregiverSafeCareSummary is the single choke point — it only ACCEPTS
//     task-level fields, so medical data physically can't flow through it.
//
// Kill switch: CARE_PLAN_INTERVIEW_ENABLED (config/featureFlags.ts). Flipping
// it off mid-interview silences the directive and the kickoff — no migration.

import * as admin from "firebase-admin";
import { carePlanInterviewEnabled } from "../config/featureFlags";
import { allCareRecipients, recipientPlanKey } from "./careRecipients";

const db = admin.firestore();

// ── Completeness (the data-driven definition of "done") ───────────────────────

export interface CarePlanCompleteness {
  complete: boolean;
  /** Human labels of what's still needed, in ask order. */
  missing: string[];
  /** Human labels of what's already on file (so the directive never re-asks). */
  filled: string[];
  /** Per-recipient task detail from carePlans.recipientPlans (caregiver-safe). */
  taskDetailByRecipient: Record<string, Record<string, string[]>>;
  /** Union of care-type categories across recipients (caregiver-safe). */
  careTypes: string[];
  /** planKey → display first name, for every recipient on file (2026-07-16).
   *  NOT caregiver-safe — directive/kickoff/job-post naming only goes through
   *  the explicitly name-approved paths (taskSummaryByRecipient). */
  recipientNames: Record<string, string>;
}

function filledArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

// Reads BOTH stores (the split the webapp uses): task detail lives in
// carePlans/{uid}.recipientPlans (camelCase — CarePlan.tsx tabs), medical
// fields live in canonical care_plans/{uid} (underscore — update_care_plan).
export async function getCarePlanCompleteness(
  clientId: string,
  onboardingData?: Record<string, unknown>,
): Promise<CarePlanCompleteness> {
  const [webSnap, canonSnap] = await Promise.all([
    db.collection("carePlans").doc(clientId).get(),
    db.collection("care_plans").doc(clientId).get(),
  ]);
  const web   = (webSnap.data()  ?? {}) as Record<string, unknown>;
  const canon = (canonSnap.data() ?? {}) as Record<string, unknown>;

  const missing: string[] = [];
  const filled:  string[] = [];

  // 1) Care-task detail per recipient. Recipients come from the plan doc itself
  //    (recipientPlans keys), falling back to onboardingData for a brand-new
  //    signup whose plan doc hasn't been written yet.
  const recipientPlans = (web.recipientPlans ?? {}) as Record<string, Record<string, unknown>>;
  const planKeys = Object.keys(recipientPlans);
  const expectedKeys = planKeys.length
    ? planKeys
    : allCareRecipients(onboardingData ?? {}).map((r) => recipientPlanKey((r.name || "").split(" ")[0] || r.name));

  const taskDetailByRecipient: Record<string, Record<string, string[]>> = {};
  const careTypesSet = new Set<string>();
  const recipientNames: Record<string, string> = {};
  let recipientsMissingDetail = 0;
  for (const key of expectedKeys) {
    const plan   = recipientPlans[key] ?? {};
    recipientNames[key] = String(plan.name ?? "").trim().split(" ")[0]
      || key.split("_")[0].replace(/^./, (c) => c.toUpperCase());
    const detail = (plan.careNeedDetails ?? {}) as Record<string, unknown>;
    const clean: Record<string, string[]> = {};
    for (const [category, tasks] of Object.entries(detail)) {
      if (filledArray(tasks)) clean[category] = (tasks as unknown[]).map(String);
    }
    for (const t of (Array.isArray(plan.careNeeds) ? plan.careNeeds as unknown[] : [])) {
      careTypesSet.add(String(t));
    }
    for (const category of Object.keys(clean)) careTypesSet.add(category);
    if (Object.keys(clean).length > 0) {
      taskDetailByRecipient[key] = clean;
      const name = String(plan.name ?? key);
      filled.push(`day-to-day care tasks for ${name}`);
    } else {
      recipientsMissingDetail++;
      const name = String(plan.name ?? "").trim();
      missing.push(name ? `day-to-day care tasks for ${name}` : "day-to-day care tasks");
    }
  }
  if (expectedKeys.length === 0) {
    // No recipients resolvable at all — treat task detail as missing so the
    // interview asks rather than silently completing on an empty plan.
    recipientsMissingDetail++;
    missing.push("day-to-day care tasks");
  }

  // 2) Emergency contact — one on file, or explicitly declined.
  // NOTE (founder, 2026-07-15): medications are NOT collected by the interview —
  // tasks stay at "medication reminders" level; drug names never solicited.
  const contactFilled = filledArray(canon.emergencyContacts) || canon.emergencyContactDeclined === true;
  if (contactFilled) filled.push("emergency contact");
  else missing.push("an emergency contact (name + phone)");

  // Optional (asked once for routine, volunteered for dietary — never blocking).
  // Multi-recipient (2026-07-16): per-person entries in recipientMedical get
  // named labels so the directive can see WHOSE routine is on file; the
  // account-level fields keep their household labels (fail-soft — old docs
  // without the map behave exactly as before).
  const recipientMedical = (canon.recipientMedical ?? {}) as Record<string, Record<string, unknown>>;
  for (const key of expectedKeys) {
    const rm = recipientMedical[key];
    if (!rm) continue;
    const name = recipientNames[key];
    if (filledArray(rm.dailyRoutine))                              filled.push(`daily routine (${name})`);
    if (rm.dietaryNotes || filledArray(rm.dietaryRestrictions))    filled.push(`dietary notes (${name})`);
    if (filledArray(rm.medications))                               filled.push(`medications for ${name} (volunteered — never ask)`);
  }
  if (filledArray(canon.dailyRoutine))                                    filled.push("daily routine");
  if (canon.dietaryNotes || filledArray(canon.dietaryRestrictions))       filled.push("dietary notes");
  if (filledArray(canon.medications))                                     filled.push("medications (volunteered — never ask)");

  return {
    complete: recipientsMissingDetail === 0 && contactFilled,
    missing,
    filled,
    taskDetailByRecipient,
    careTypes: [...careTypesSet],
    recipientNames,
  };
}

// ── Session-state gate ─────────────────────────────────────────────────────────

// True when this session is mid-interview: kill switch on, flag set, not yet
// completed. Callers pass the in-hand session; writes always re-read fresh.
export function carePlanInterviewPending(session: Record<string, unknown> | undefined): boolean {
  if (!carePlanInterviewEnabled()) return false;
  if (!session) return false;
  return session.carePlanInterviewActive === true && !session.carePlanInterviewCompletedAt;
}

// ── Per-turn directive (the steering mechanism, PROFILE-REVIEW-MODE pattern) ──

// Grounded in LIVE completeness each turn so the model never re-asks a filled
// field (the gate-step-amnesia bug class) and never invents missing ones.
export async function buildCarePlanInterviewDirective(
  clientId: string,
  session: Record<string, unknown> | undefined,
): Promise<string> {
  try {
    const c = await getCarePlanCompleteness(
      clientId,
      (session?.onboardingData ?? undefined) as Record<string, unknown> | undefined,
    );
    if (c.complete) return ""; // data says done — post-turn completion handles the rest
    // Multi-recipient households get ~4 extra lines (directive is injected every
    // turn — keep it tight): name the people, ask separately, attribute saves.
    const names = Object.values(c.recipientNames);
    const multiRecipientRules = names.length > 1
      ? `- THIS HOUSEHOLD CARES FOR ${names.length} PEOPLE: ${names.join(" and ")}. Ask about each person SEPARATELY ` +
        "— never assume they need the same help. Always pass recipientFirstName to save_care_task_detail AND to " +
        "update_care_plan (for dailyRoutine, dietary, and any volunteered medication facts) so each person's plan " +
        "stays their own. Ask about the daily routine once PER PERSON. The emergency contact is ONE question for " +
        "the whole household. The needs recorded at signup were listed for everyone together — confirm what " +
        "applies to whom instead of assuming both people need the same help.\n"
      : "";
    return (
      "\n\nCARE PLAN INTERVIEW (active until the plan is complete): This family finished signup and their " +
      "care request is already out to caregivers. Your standing goal is to finish their care plan — it tells " +
      "caregivers exactly what care is needed.\n" +
      `LIVE CARE-PLAN STATUS RIGHT NOW — already on file (NEVER re-ask these): ${c.filled.length ? c.filled.join("; ") : "nothing yet"}. ` +
      `Still needed, in this order: ${c.missing.join("; ")}.\n` +
      "Rules:\n" +
      multiRecipientRules +
      "- Ask for exactly ONE missing item per message, in the order listed. Short, warm, conversational — no numbered lists.\n" +
      "- If the family raises ANYTHING else (a caregiver match, payment, a question), handle that FIRST and fully, " +
      "then steer back to the next missing item in the same reply. VARY the steer-back phrasing every time — never " +
      "repeat the same transition sentence twice.\n" +
      "- Save answers the moment you have them: care tasks via save_care_task_detail (map what they describe onto " +
      "categories like Personal Care, Mobility Assistance, Meal Preparation, Medication Reminders, Transportation, " +
      "Companionship, Light Housekeeping, Dementia / Memory Care, with the specific tasks under each); emergency " +
      "contact, daily routine, and dietary notes via update_care_plan.\n" +
      "- MEDICATION REMINDERS: after the care tasks are saved, ask ONCE whether they'd like the caregiver to give " +
      "medication reminders (and roughly when — morning, evening, with meals). Yes → save a generic \"Medication " +
      "Reminders\" task via save_care_task_detail (e.g. \"Morning reminder\"); no → move on. NEVER ask about specific " +
      "medications — no drug names, dosages, or what they're for. If the family volunteers drug names unprompted, " +
      "save them quietly with update_care_plan (field medications), keep every task entry generic, and ask no " +
      "follow-ups about them.\n" +
      "- PRIVACY: care tasks are shared with caregivers before hiring, so a task entry must name the ACTIVITY only " +
      "(e.g. \"morning medication reminder\", \"help with bathing\") — NEVER a drug name, dosage, diagnosis, or the " +
      "recipient's name.\n" +
      "- Then ask ONCE (one question) about their typical daily routine — wake, meals, " +
      "rest, activities. Any answer is fine and a \"skip\"/\"not sure\" is fine too; save what they give via " +
      "update_care_plan field dailyRoutine and NEVER ask about routine a second time. Dietary notes: save only if " +
      "they volunteer them — never ask.\n" +
      "- The family is GIVING you this data — do not read it back for confirmation before saving; save it and move on. " +
      "Only confirm if their answer was genuinely ambiguous.\n" +
      "- If they refuse an emergency contact after one gentle explanation of why it matters, save " +
      "emergencyContactDeclined true via update_care_plan — never badger.\n" +
      "- NEVER promise the plan is 'done' while items are still listed as needed above."
    );
  } catch (e) {
    console.warn("[carePlanInterview] directive build failed (skipping this turn):", e);
    return "";
  }
}

// ── Kickoff ────────────────────────────────────────────────────────────────────

// Sets the session flag and sends the first interview question. Used by the
// onboarding-complete handoff (permissionsConversation) and the backfill
// migration. Fail-soft: a send failure leaves the flag set, so the next inbound
// turn's directive still drives the interview.
export async function startCarePlanInterview(
  phone: string,
  chatId: string,
  session: Record<string, unknown>,
  opts?: { source?: "onboarding" | "backfill" },
): Promise<boolean> {
  if (!carePlanInterviewEnabled()) return false;
  if (session.carePlanInterviewActive === true || session.carePlanInterviewCompletedAt) return false;

  const clientId = (session.userId ?? "") as string;
  if (!clientId) return false;

  // Skip entirely if the plan is somehow already complete (e.g. webapp-built).
  const c = await getCarePlanCompleteness(clientId, session.onboardingData as Record<string, unknown> | undefined);
  if (c.complete) return false;

  // Claim the interview transactionally so two racing kickoffs (e.g. a payment
  // webhook retry re-running the permissions completion, or the backfill racing
  // an inbound turn) send the first question exactly once. Only the caller that
  // flips the flag from unset proceeds to send.
  const sessionRef = db.collection("agent_sessions").doc(phone);
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef);
    const s = (snap.data() ?? {}) as Record<string, unknown>;
    if (s.carePlanInterviewActive === true || s.carePlanInterviewCompletedAt) return false;
    tx.set(sessionRef, {
      carePlanInterviewActive:    true,
      carePlanInterviewStartedAt: new Date().toISOString(),
      carePlanInterviewSource:    opts?.source ?? "onboarding",
    }, { merge: true });
    return true;
  }).catch((e) => {
    console.error("[carePlanInterview] kickoff claim transaction failed:", e);
    return false;
  });
  if (!claimed) return false;

  const d = (session.onboardingData ?? {}) as Record<string, unknown>;
  // Multi-recipient households: name everyone, interview the primary first, and
  // tell the family the structure ("then we'll do John") so nobody gets skipped.
  const recipients = allCareRecipients(d).map((r) => (r.name || "").split(" ")[0]).filter(Boolean);
  const seniorName = recipients[0] || (d.seniorName as string) || "your loved one";
  const others = recipients.slice(1);
  const householdLine = others.length
    ? ` Care is for ${recipients.length} people: ${recipients.join(" and ")}. Start with ${seniorName} and say you'll go through ${others.join(" and ")} right after — each person gets their own plan.`
    : "";
  const knownNeeds = Array.isArray(d.careNeeds) && (d.careNeeds as unknown[]).length
    ? (d.careNeeds as unknown[]).map(String).join(", ")
    : "";

  try {
    const { generateCaraMessage } = await import("../utils/caraMessage");
    const { sendMessage } = await import("../linq/client");
    const first = await generateCaraMessage({
      audience: "family",
      context:
        (opts?.source === "backfill"
          ? `Evia is proactively checking in with a family who signed up a little while ago — their care request is live with caregivers, but their care plan was never finished. Open with a warm one-line check-in (no re-introduction — they know Evia). `
          : `Evia is starting a short care-plan interview with a family whose care request is already live with caregivers. `) +
        `The care recipient is ${seniorName}.${householdLine}${knownNeeds ? ` At signup the family said they need help with: ${knownNeeds}.` : ""} ` +
        `Explain in ONE warm sentence that while caregivers respond, a quick care plan helps them know exactly what ` +
        `${seniorName} needs day to day — then ask the FIRST question: what specific day-to-day tasks does ${seniorName} ` +
        `need help with (things like bathing, dressing, meals, getting around, rides)? One question only, no lists.`,
      fallback: others.length
        ? `While caregivers respond, let's build the care plan for ${recipients.join(" and ")} — each gets their own. ` +
          `First, ${seniorName}: what day-to-day tasks does ${seniorName} need help with? Things like bathing, dressing, meals, getting around, or rides. (${others.join(" and ")} next!)`
        : `While caregivers respond, let's build ${seniorName}'s care plan — it shows caregivers exactly what's needed. ` +
          `First: what day-to-day tasks does ${seniorName} need help with? Things like bathing, dressing, meals, getting around, or rides.`,
      maxTokens: 160,
    });
    await sendMessage(chatId, first);
  } catch (e) {
    console.error("[carePlanInterview] kickoff send failed (flag stays set; directive resumes next turn):", e);
  }
  return true;
}

// ── Privacy choke point ────────────────────────────────────────────────────────

// The ONLY producer of caregiver-facing care-plan content. It accepts task-level
// fields BY PARAMETER — medications, diagnoses, contacts, routine specifics, and
// recipient names are not inputs, so they cannot leak through it. Both the
// job-post enrichment and the engaged-caregiver follow-up go through here.
export function buildCaregiverSafeCareSummary(
  taskDetailByRecipient: Record<string, Record<string, string[]>>,
  careTypes: string[],
): { summary: string; careTypes: string[] } {
  // Merge task detail across recipients into category → task set (no names).
  const byCategory = new Map<string, Set<string>>();
  for (const detail of Object.values(taskDetailByRecipient)) {
    for (const [category, tasks] of Object.entries(detail)) {
      const set = byCategory.get(category) ?? new Set<string>();
      for (const t of tasks) {
        const clean = String(t).trim();
        if (clean) set.add(clean);
      }
      byCategory.set(category, set);
    }
  }
  const parts: string[] = [];
  for (const [category, tasks] of byCategory) {
    parts.push(tasks.size ? `${category} (${[...tasks].slice(0, 6).join(", ").toLowerCase()})` : category);
  }
  const allTypes = [...new Set([...careTypes, ...byCategory.keys()])];
  return {
    summary: parts.join(" · "),
    careTypes: allTypes,
  };
}

// ── Completion (data-driven, idempotent) ──────────────────────────────────────

// Called after each qaAgent turn while the interview is pending. Re-reads the
// session FRESH (the in-hand copy predates this turn's tool writes to it) and
// the plan docs; when the data says complete, claims completion atomically,
// enriches the live job post, and notifies engaged caregivers. Returns true
// only for the turn that actually claimed completion.
export async function maybeCompleteCarePlanInterview(
  phone: string,
  session: Record<string, unknown> | undefined,
): Promise<boolean> {
  try {
    if (!carePlanInterviewPending(session)) return false;
    const clientId = (session?.userId ?? "") as string;
    if (!clientId) return false;

    const c = await getCarePlanCompleteness(clientId, session?.onboardingData as Record<string, unknown> | undefined);
    if (!c.complete) return false;

    // Atomic claim — a racing turn (or webhook retry) must not double-fire the
    // caregiver follow-up. Only the transaction that flips the flag proceeds.
    const sessionRef = db.collection("agent_sessions").doc(phone);
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(sessionRef);
      const s = (snap.data() ?? {}) as Record<string, unknown>;
      if (s.carePlanInterviewActive !== true || s.carePlanInterviewCompletedAt) return false;
      tx.update(sessionRef, {
        carePlanInterviewActive:      admin.firestore.FieldValue.delete(),
        carePlanInterviewCompletedAt: new Date().toISOString(),
      });
      return true;
    });
    if (!claimed) return false;

    const safe = buildCaregiverSafeCareSummary(c.taskDetailByRecipient, c.careTypes);
    // Multi-recipient (founder-approved 2026-07-16): FIRST NAMES may appear in
    // the per-person task summary on the job post — matching the existing
    // "Care for Mary & John" title. ONLY first name + task activities flow;
    // built here (not inside buildCaregiverSafeCareSummary, which stays the
    // nameless choke point for every other caregiver-facing surface).
    const taskSummaryByRecipient = buildNamedTaskSummaries(c);

    // Both post-completion effects are independent and non-blocking for the
    // family's reply latency; each logs loudly on failure.
    await Promise.all([
      enrichJobPostFromCarePlan(clientId, safe, taskSummaryByRecipient).catch((e) =>
        console.error("[carePlanInterview] job-post enrichment failed:", e)),
      notifyEngagedCaregiversOfCarePlan(clientId, safe).catch((e) =>
        console.error("[carePlanInterview] engaged-caregiver follow-up failed:", e)),
    ]);
    return true;
  } catch (e) {
    console.error("[carePlanInterview] completion check failed:", e);
    return false;
  }
}

// Per-person task summaries for the job post: first name → "Category (tasks)"
// line. Returns null unless the household has 2+ recipients WITH task detail —
// single-recipient posts keep the nameless summary only. First names only;
// task strings are already privacy-screened at save time (activity only, no
// drug names/diagnoses — see save_care_task_detail).
export function buildNamedTaskSummaries(c: CarePlanCompleteness): Record<string, string> | null {
  const keys = Object.keys(c.taskDetailByRecipient);
  if (keys.length < 2) return null;
  const out: Record<string, string> = {};
  for (const key of keys) {
    const name = c.recipientNames[key] || key.split("_")[0];
    const parts: string[] = [];
    for (const [category, tasks] of Object.entries(c.taskDetailByRecipient[key])) {
      parts.push(tasks.length ? `${category} (${tasks.slice(0, 6).join(", ").toLowerCase()})` : category);
    }
    if (parts.length) out[name] = parts.join(" · ");
  }
  return Object.keys(out).length >= 2 ? out : null;
}

// Targeted field update on the LIVE job post — never a buildWebJobPostDoc
// rebuild (that would reset applicantCount/notifiedCount to 0 and stamp a fresh
// createdAt, wiping engagement and re-sorting the board). Only caregiver-safe
// fields move: careTypes, requirements (the match-keyword mirror), a task
// summary appended to the description, and (multi-recipient households) the
// per-person taskSummaryByRecipient map.
export async function enrichJobPostFromCarePlan(
  clientId: string,
  safe: { summary: string; careTypes: string[] },
  taskSummaryByRecipient?: Record<string, string> | null,
): Promise<void> {
  const ref = db.collection("job_posts").doc(clientId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const job = snap.data() ?? {};
  if (job.status !== "open") return;

  // Anchor on the EXACT block we append ("\n\nDay-to-day tasks: …"), not the
  // bare phrase — otherwise family description text that happens to contain
  // "Day-to-day tasks:" mid-sentence would be truncated. Splitting on the
  // anchored form only ever strips a block WE wrote, keeping re-enrichment
  // idempotent (replace, never stack) without eating the family's own words.
  const TASK_BLOCK_ANCHOR = "\n\nDay-to-day tasks:";
  const baseDescription = String(job.description ?? "").split(TASK_BLOCK_ANCHOR)[0].trimEnd();
  const update: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
    carePlanEnrichedAt: new Date().toISOString(),
  };
  if (safe.careTypes.length) {
    update.careTypes    = safe.careTypes;
    update.requirements = safe.careTypes; // legacy mirror (jobMatchService keywords)
  }
  // Multi-recipient: the description's task block becomes per-person lines
  // ("Mary — … / John — …") so every existing surface shows the breakdown with
  // zero UI changes; the map rides along for structured renderers.
  if (taskSummaryByRecipient) {
    update.taskSummaryByRecipient = taskSummaryByRecipient;
    const perPerson = Object.entries(taskSummaryByRecipient)
      .map(([n, s]) => `${n} — ${s}`).join("; ");
    update.description = `${baseDescription}${TASK_BLOCK_ANCHOR} ${perPerson}`.trim();
  } else if (safe.summary) {
    update.description = `${baseDescription}${TASK_BLOCK_ANCHOR} ${safe.summary}`.trim();
  }
  await ref.update(update);
  console.log(`[carePlanInterview] job post enriched for client=${clientId}`);
}

// Follow-up text to ENGAGED caregivers only: those who replied interested or
// applied to this job (job_notifications status interested/applied, plus
// job_applications as a net for applicants with no notification doc, e.g. web
// applicants). Deduped by phone; the sent-guard (carePlanUpdateSentAt) is
// written on an EXISTING doc — the caregiver's notification doc, or their
// application doc — NEVER a new job_notifications marker: a status-less marker
// there would make notifyFamilyIfAllDeclined's "every notified caregiver has
// responded" check false forever, silently killing the all-declined rematch.
export async function notifyEngagedCaregiversOfCarePlan(
  clientId: string,
  safe: { summary: string; careTypes: string[] },
): Promise<number> {
  if (!safe.summary) return 0;
  const jobId = clientId; // job_posts/{uid} — both SMS + intake writers converge on it

  const [interestedSnap, appliedSnap, applicationsSnap] = await Promise.all([
    db.collection("job_notifications").where("jobId", "==", jobId).where("status", "==", "interested").get(),
    db.collection("job_notifications").where("jobId", "==", jobId).where("status", "==", "applied").get(),
    db.collection("job_applications").where("jobId", "==", jobId).get(),
  ]);

  // phone → the EXISTING doc to stamp the sent-guard on. null = already sent for
  // this phone (poison). Prefer the notification doc; fall back to the
  // application doc for applicants that were never texted a notification. Every
  // ref points at a doc that already exists — we only ever set/merge onto it.
  const byPhone = new Map<string, FirebaseFirestore.DocumentReference | null>();
  const markSent = (p: string) => { if (p) byPhone.set(p, null); };
  for (const doc of [...interestedSnap.docs, ...appliedSnap.docs]) {
    const p = String(doc.data().phone ?? "");
    if (!p) continue;
    if (doc.data().carePlanUpdateSentAt) { markSent(p); continue; } // already sent — poison
    if (byPhone.get(p) === null) continue;                          // already poisoned by a sibling doc
    if (!byPhone.has(p)) byPhone.set(p, doc.ref);
  }
  for (const doc of applicationsSnap.docs) {
    const d = doc.data();
    let p = String(d.phone ?? "");
    if (!p && d.caregiverId) {
      // Webapp-originated application docs may lack a phone — resolve it from
      // the caregiver doc so web applicants get the follow-up too. Fail-soft:
      // an unresolvable phone just skips this applicant (they still see the
      // enriched job post in-app).
      try {
        const cgSnap = await db.collection("caregivers").doc(String(d.caregiverId)).get();
        p = String(cgSnap.data()?.phone ?? "");
      } catch (e) {
        console.warn(`[carePlanInterview] phone lookup failed for caregiver ${String(d.caregiverId)}:`, e);
      }
    }
    if (!p) continue;
    if (d.carePlanUpdateSentAt) { markSent(p); continue; }           // already sent via application-doc guard
    if (byPhone.has(p)) continue;                                    // notification doc (or poison) already chosen
    byPhone.set(p, doc.ref);                                         // guard on the application doc itself
  }

  const { generateCaraMessage } = await import("../utils/caraMessage");
  const { sendMessage, getOrCreateSession } = await import("../linq/client");

  let sent = 0;
  for (const [phone, guardRef] of byPhone) {
    if (guardRef === null) continue; // already sent for this phone
    if (sent >= 25) { console.warn(`[carePlanInterview] follow-up capped at 25 for job=${jobId}`); break; }
    try {
      const cgSession = await getOrCreateSession(phone);
      if (cgSession.optedOut) continue;
      const msg = await generateCaraMessage({
        audience: "caregiver",
        context:
          "A family this caregiver expressed interest in (or applied to) just finished their care plan. " +
          `Share the day-to-day care detail in ONE short friendly text using ONLY these facts — never invent ` +
          `medical details, names, or anything else: ${safe.summary}. ` +
          "Close by inviting them to reply with any questions.",
        fallback: `The family you were interested in finished their care plan — day-to-day it covers: ${safe.summary}. Reply if you have any questions!`,
        maxTokens: 140,
      });
      await sendMessage(cgSession.chatId, msg);
      sent++;
      // Best-effort guard write onto the EXISTING notification/application doc —
      // merge, never create. A failure here only risks a duplicate follow-up on
      // a retry; it can never wedge the all-declined check.
      await guardRef.set({ carePlanUpdateSentAt: new Date().toISOString() }, { merge: true })
        .catch(() => {});
    } catch (e) {
      console.error(`[carePlanInterview] follow-up send failed for ${phone}:`, e);
    }
  }
  console.log(`[carePlanInterview] care-plan follow-up sent to ${sent} engaged caregivers for job=${jobId}`);
  return sent;
}
