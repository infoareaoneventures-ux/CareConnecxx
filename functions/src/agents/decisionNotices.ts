// Decision notices → deterministic replies (founder, 2026-09-27: "with such a
// small word like accept / confirm… isn't doing the action correctly").
//
// When Evia texts a notice that ends in a decision — an interview request, a
// proposed interview time, a booking request, a schedule change, a new job —
// the notice PARKS the expected decision on the session: which record, which
// words are valid, and how long it stands. The next inbound is checked against
// that first (routeCaregiver / routeClient, after any active scripted flow and
// before keywords or the agent): an exact word match, else a quick-tier
// classifier for phrasings like "yes confirm" / "I can't". A match runs the
// page's own write directly and texts the page's toast; a question or
// anything else falls through to the agent with the decision still parked.
// The same pattern as SUBMIT / CANCEL in the apply flow — no tool choice, no
// id, no guessing.
import * as admin from "firebase-admin";
import { sendMessage, AgentSession } from "../linq/client";
import { quickComplete } from "../utils/openaiClient";
import { answerMidFlow } from "./stepHandler";

const db = admin.firestore();

export type DecisionKind =
  | "interview_request"          // caregiver: ACCEPT / DECLINE / PROPOSE
  | "interview_proposal"         // either side: CONFIRM / PROPOSE
  | "booking_request"            // caregiver: ACCEPT / DECLINE / DETAILS
  | "booking_request_decline"    // caregiver: the page's confirm — YES / NO
  | "amendment"                  // caregiver: ACCEPT / DECLINE
  | "new_job"                    // caregiver: APPLY / DETAILS
  | "job_application"            // client: VIEW / INTERVIEW / DECLINE — the post's applicant row (2026-10-07)
  | "job_application_decline";   // client: YES / NO — the decline confirm (no card in view)

export interface PendingDecision {
  kind: DecisionKind;
  recordId: string;
  /** What they were asked, for the classifier ("an interview request from The Nguyen Family"). */
  label: string;
  options: string[];
  role: "caregiver" | "client";
  /** Who the decision is about ("Basra Yousuf") — named in confirms and toasts so a reply always says which one. */
  party?: string;
  parkedAt: string;
  expiresAt: string;
}

export const DECISION_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const OPTIONS: Record<DecisionKind, string[]> = {
  interview_request:       ["ACCEPT", "DECLINE", "PROPOSE"],
  interview_proposal:      ["CONFIRM", "PROPOSE"],
  booking_request:         ["ACCEPT", "DECLINE", "DETAILS"],
  booking_request_decline: ["YES", "NO"],
  amendment:               ["ACCEPT", "DECLINE"],
  new_job:                 ["APPLY", "DETAILS"],
  job_application:         ["VIEW", "INTERVIEW", "DECLINE"],
  job_application_decline: ["YES", "NO"],
};

export function parkedDecision(kind: DecisionKind, recordId: string, label: string, role: "caregiver" | "client", now = Date.now(), party?: string): PendingDecision {
  return { kind, recordId, label, options: OPTIONS[kind], role, ...(party ? { party } : {}), parkedAt: new Date(now).toISOString(), expiresAt: new Date(now + DECISION_TTL_MS).toISOString() };
}

const BARE_YES_NO = new Set(["YES", "YEAH", "YEP", "YUP", "OK", "OKAY", "SURE", "NO", "NOPE", "NAH"]);

/** Session patch a notice passes along with its text. */
export const parkDecision = (pd: PendingDecision): Record<string, unknown> => ({ pendingDecision: pd });

/**
 * Exact-word match — allowed without an LLM because the notice explicitly
 * said "Reply ACCEPT or DECLINE" (the strict-keyword rule). The whole text
 * must be one offered word; a sentence ("please decline the booking request",
 * "I can't accept this") goes to the classifier below, never to a keyword
 * scan. A bare "yes"/"no" counts ONLY where the prompt literally offered
 * YES / NO (the decline confirm) — never as ACCEPT: 2026-09-28 live, the agent
 * asked its own yes/no question while a booking request was parked, and a
 * "yes" must not accept a booking.
 */
export function matchDecisionWord(text: string, options: string[]): string | null {
  const norm = text.trim().toUpperCase().replace(/[^A-Z ]/g, "").replace(/\s+/g, " ").trim();
  if (!norm) return null;
  return options.includes(norm) ? norm : null;
}

/** A question ABOUT the parked notice (the item itself, or what the offered replies do) — answered from the notice, never sent to the agent blind. */
export const QUESTION_ABOUT_NOTICE = "QUESTION";

/**
 * Exact word first; otherwise a quick-tier classifier. A question about THIS notice → QUESTION_ABOUT_NOTICE (answered
 * from the notice's own text, 2026-10-11); a request about something else / anything unclear → null (the agent takes it).
 */
export async function classifyDecision(text: string, pd: PendingDecision): Promise<string | null> {
  const exact = matchDecisionWord(text, pd.options);
  if (exact) return exact;
  // A bare yes / no / ok answers whatever was asked LAST — which may be the
  // agent's own question, not the parked notice — so unless YES / NO were the
  // offered words it never reaches the classifier (the strict yes/no protocol).
  if (BARE_YES_NO.has(text.trim().toUpperCase().replace(/[^A-Z ]/g, "").replace(/\s+/g, " ").trim()) && !pd.options.includes("YES")) return null;
  const raw = await quickComplete(
    `Evia texted a person about ${pd.label} and asked them to reply with one of: ${pd.options.join(", ")}. ` +
    `Classify their reply as exactly one of those words when it clearly means that choice — including when the word sits inside a sentence about this same item ` +
    `(e.g. "please decline the booking request" → DECLINE, "yes confirm" → CONFIRM, "I can't make it" / "I can't accept this" → DECLINE, ` +
    `"sounds good" → the positive option, "tell me more" → DETAILS when offered). ` +
    `A question ABOUT this same item (its time, place, pay, who it is with, what happens next) or about what those replies do → QUESTION. ` +
    `Only a request about something else, or an unclear reply, is OTHER. Reply with ONE word only.`,
    text,
    { maxTokens: 5 },
  ).catch(() => "OTHER");
  const word = raw.trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (word === QUESTION_ABOUT_NOTICE) return QUESTION_ABOUT_NOTICE;
  return pd.options.includes(word) ? word : null;
}

// ── A question while a notice is parked: answered from the notice, then the expected reply re-stated ──
const OPTION_MEANING: Record<DecisionKind, string> = {
  interview_request:       "ACCEPT accepts the interview (the Jobs page's Accept — the Google Meet link is then texted to both sides); DECLINE declines it; PROPOSE proposes a different time to the family.",
  interview_proposal:      "CONFIRM confirms the proposed time (the interview moves to it); PROPOSE proposes another time instead.",
  booking_request:         "ACCEPT accepts the booking (its visits go on the caregiver's schedule and the family is told); DECLINE declines it (a YES/NO confirm follows first); DETAILS shows the whole request.",
  booking_request_decline: "YES declines the booking request; NO leaves it pending on the Requests tab.",
  amendment:               "ACCEPT accepts the family's schedule change (the booking's visits follow the new schedule); DECLINE declines it and the schedule stays as it was.",
  new_job:                 "APPLY starts the application (a cover letter is asked, then SUBMIT sends it); DETAILS shows the whole job post.",
  job_application:         "VIEW shows the caregiver's profile link; INTERVIEW requests an interview with them; DECLINE declines the application (a YES/NO confirm follows first).",
  job_application_decline: "YES declines the application (the caregiver is not told); NO leaves it pending on the post.",
};
const listWords = (ws: string[]) => (ws.length > 1 ? `${ws.slice(0, -1).join(", ")} or ${ws[ws.length - 1]}` : ws[0] ?? "");
/** The expected reply, re-stated after the answer. */
export const expectedReplyLine = (pd: PendingDecision) => `Reply ${listWords(pd.options)} for ${pd.label}.`;

/** The notice's own record, as the page shows it — best effort, each loader fails soft to the notice's label. */
export async function noticeScreenText(pd: PendingDecision, session: AgentSession & Record<string, unknown>): Promise<string> {
  const caregiverId = String(session.caregiverId ?? "");
  try {
    switch (pd.kind) {
      case "booking_request":
      case "booking_request_decline": {
        const br = await import("./caregiverBookingRequests");
        const loaded = await br.loadBookingRequestFor(caregiverId, pd.recordId);
        if (loaded.ok) return [...br.requestCardLines(loaded.req), ...br.requestDetailsLines(loaded.req)].join("\n");
        break;
      }
      case "amendment": {
        const br = await import("./caregiverBookingRequests");
        const snap = await db.collection("booking_amendments").doc(pd.recordId).get();
        if (snap.exists) return br.amendmentCardLines({ ...(snap.data() as Omit<import("./caregiverBookingRequests").Amendment, "id">), id: snap.id }).join("\n");
        break;
      }
      case "interview_request":
      case "interview_proposal": {
        const snap = await db.collection("video_interviews").doc(pd.recordId).get();
        const iv = snap.exists ? (snap.data() ?? {}) : null;
        if (!iv) break;
        const { interviewTimeIso, interviewTypeLabel } = await import("./caregiverInterviewsTab");
        const { parseScheduledTimeMs, formatInterviewTime } = await import("../utils/scheduledTime");
        const whenIso = interviewTimeIso(iv);
        const whenMs = whenIso ? parseScheduledTimeMs(whenIso) : NaN;
        const proposedMs = typeof iv.reschedulePendingTime === "string" ? parseScheduledTimeMs(iv.reschedulePendingTime) : NaN;
        return [
          `Interview${iv.jobTitle ? ` for "${String(iv.jobTitle)}"` : ""} — ${pd.role === "caregiver" ? `family: ${String(iv.clientName || "the family")}` : `caregiver: ${String(iv.caregiverName || "your caregiver")}`}`,
          `Type: ${interviewTypeLabel(iv)}`,
          Number.isFinite(whenMs) ? `Scheduled time: ${formatInterviewTime(whenMs)}` : "Scheduled time: not set yet",
          Number.isFinite(proposedMs) ? `Proposed new time: ${formatInterviewTime(proposedMs)} (proposed by the ${String(iv.rescheduledBy || "other side")})` : "",
          `Status: ${String(iv.status ?? "pending")}`,
        ].filter(Boolean).join("\n");
      }
      case "new_job": {
        const { loadJobDetails } = await import("./jobBoardPage");
        const { jobDetailsText } = await import("./jobBoardText");
        const r = await loadJobDetails(caregiverId, pd.recordId);
        if (r.ok) return jobDetailsText(r.details);
        break;
      }
      case "job_application":
      case "job_application_decline": {
        const snap = await db.collection("job_applications").doc(pd.recordId).get();
        const app = snap.exists ? (snap.data() ?? {}) : null;
        if (!app) break;
        return [
          `Application from ${String(app.caregiverName ?? pd.party ?? "a caregiver")} to "${String(app.jobTitle ?? "your post")}"`,
          app.coverLetter ? `Cover letter: "${String(app.coverLetter)}"` : "No cover letter.",
          `Status: ${String(app.status ?? "pending")}`,
        ].join("\n");
      }
    }
  } catch { /* fail soft — the label below still grounds the answer */ }
  return `Evia's notice was about ${pd.label}${pd.party ? ` (${pd.party})` : ""}.`;
}

/** Answer a question about the parked notice from its own record + what the replies do, then re-state the expected reply. Nothing is decided. */
export async function answerNoticeQuestion(chatId: string, text: string, pd: PendingDecision, session: AgentSession & Record<string, unknown>): Promise<void> {
  const screen = await noticeScreenText(pd, session);
  const facts = `What the notice showed them:\n${screen}\n\nWhat each reply does: ${OPTION_MEANING[pd.kind]} The decision is still waiting — nothing has been accepted, declined, confirmed or sent.`;
  await sendMessage(chatId, await answerMidFlow(text, expectedReplyLine(pd), { audience: pd.role === "client" ? "family" : "caregiver", facts }));
}

export function isExpired(pd: PendingDecision, now = Date.now()): boolean {
  const t = Date.parse(pd.expiresAt);
  return !Number.isFinite(t) || t < now;
}

async function clearDecision(phone: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({ pendingDecision: admin.firestore.FieldValue.delete() }).catch(() => {});
}

/**
 * Route entry: "handled" when the reply answered the parked decision (the
 * page's write ran and the toast was texted), "passthrough" otherwise.
 */
export async function handlePendingDecisionReply(
  phone: string, chatId: string, text: string, session: AgentSession & Record<string, unknown>,
): Promise<"handled" | "passthrough"> {
  const pd = session.pendingDecision as PendingDecision | undefined;
  if (!pd || !pd.kind || !pd.recordId) return "passthrough";
  if (isExpired(pd)) { await clearDecision(phone); return "passthrough"; }
  const choice = await classifyDecision(text, pd);
  if (!choice) return "passthrough";
  // A question about the notice is answered from the notice itself (2026-10-11: it used to reach the agent with nothing
  // about the pending notice); the decision stays parked and the expected reply is re-stated.
  if (choice === QUESTION_ABOUT_NOTICE) { await answerNoticeQuestion(chatId, text, pd, session); return "handled"; }
  await runDecision(phone, chatId, session, pd, choice);
  return "handled";
}

// ── Execution: the page's own write for each button ──────────────────────────
async function caregiverGate(phone: string, chatId: string, caregiverId: string, opts: { transport?: boolean } = {}): Promise<boolean> {
  const { checkCaregiverAccess, textCaregiverGateBlock } = await import("./caregiverAccessGate");
  const access = await checkCaregiverAccess(caregiverId, opts);
  if (access.ok) return true;
  await textCaregiverGateBlock(phone, chatId, access.block, access.caregiver as Record<string, unknown>);
  return false;
}

export async function runDecision(
  phone: string, chatId: string, session: AgentSession & Record<string, unknown>, pd: PendingDecision, choice: string,
): Promise<void> {
  const caregiverId = String(session.caregiverId ?? "");
  const clientId = String(session.userId ?? "");
  const say = (m: string) => sendMessage(chatId, m);
  let keepParked = false;

  switch (pd.kind) {
    case "interview_request": {
      const { respondToInterviewRequest, InterviewResponseError } = await import("./interviewResponse");
      if (choice === "PROPOSE") {
        const { startInterviewRescheduleFlow } = await import("./caregiverJobFlows");
        await startInterviewRescheduleFlow(phone, chatId, session as AgentSession, { caregiverId, interviewId: pd.recordId });
        break;
      }
      if (choice === "ACCEPT" && !(await caregiverGate(phone, chatId, caregiverId))) break;
      try {
        await respondToInterviewRequest({ caregiverId, interviewId: pd.recordId, decision: choice === "ACCEPT" ? "accept" : "decline", source: "decision_notice" });
        await say(choice === "ACCEPT" ? "Interview accepted" : "Interview declined"); // JobBoard.tsx toasts; the Meet link follows from the trigger
      } catch (err) {
        await say(err instanceof InterviewResponseError ? err.message : "That didn't go through — the interview may have changed. Reply here and I'll check.");
      }
      break;
    }
    case "interview_proposal": {
      if (choice === "PROPOSE") {
        if (pd.role === "caregiver") {
          const { startInterviewRescheduleFlow } = await import("./caregiverJobFlows");
          await startInterviewRescheduleFlow(phone, chatId, session as AgentSession, { caregiverId, interviewId: pd.recordId });
        } else {
          keepParked = true; // the family's own reschedule path runs through the agent
          await say("Sure — what day and time would you like instead?");
        }
        break;
      }
      const { handleToolCall } = await import("../mcp/server");
      const r = await handleToolCall("accept_interview_reschedule", {
        interviewId: pd.recordId, phone,
        ...(pd.role === "caregiver" ? { caregiverId } : { clientId, userId: clientId }),
      }) as { success?: boolean; message?: string; _toolError?: boolean };
      if (r?.success) await say("Interview time confirmed"); // PostsPage.tsx / JobBoard.tsx toast
      else if (r?._toolError && r.message && !/MEMBERSHIP|BACKGROUND/.test(String((r as { code?: string }).code ?? ""))) await say(r.message);
      break;
    }
    case "booking_request": {
      const br = await import("./caregiverBookingRequests");
      if (choice === "DETAILS") {
        const loaded = await br.loadBookingRequestFor(caregiverId, pd.recordId);
        if (!loaded.ok || loaded.req.status !== "pending") { await say("That request isn't on your Requests tab anymore."); break; }
        const { checkCaregiverAccess } = await import("./caregiverAccessGate");
        const access = await checkCaregiverAccess(caregiverId);
        const gate = access.ok ? null : (access.block === "transport" ? null : access.block);
        await say(br.requestListText([loaded.req], { gate }).text);
        keepParked = true;
        break;
      }
      if (choice === "DECLINE") {
        // The page's window.confirm('Decline this booking request?') — naming the family, since there is no card in view.
        await say(`Decline ${pd.party ? `${pd.party}'s` : "this"} booking request? Reply YES or NO.`);
        await db.collection("agent_sessions").doc(phone).set({ pendingDecision: parkedDecision("booking_request_decline", pd.recordId, `declining ${pd.label}`, "caregiver", Date.now(), pd.party) }, { merge: true }).catch(() => {});
        return;
      }
      if (!(await caregiverGate(phone, chatId, caregiverId))) break;
      const r = await br.respondToBookingRequest(caregiverId, pd.recordId, "accept");
      await say(r.ok ? r.toast : r.reason === "not_pending" ? `That request is already ${r.status}.` : "That request isn't on your Requests tab anymore.");
      break;
    }
    case "booking_request_decline": {
      if (choice === "NO") { await say(`Okay — ${pd.party ? `${pd.party}'s` : "the"} booking request stays as it is.`); break; }
      const br = await import("./caregiverBookingRequests");
      const r = await br.respondToBookingRequest(caregiverId, pd.recordId, "decline");
      await say(r.ok ? r.toast : r.reason === "not_pending" ? `That request is already ${r.status}.` : "That request isn't on your Requests tab anymore.");
      break;
    }
    case "amendment": {
      const br = await import("./caregiverBookingRequests");
      if (choice === "ACCEPT" && !(await caregiverGate(phone, chatId, caregiverId))) break;
      const r = choice === "ACCEPT" ? await br.acceptAmendment(caregiverId, pd.recordId) : await br.declineAmendment(caregiverId, pd.recordId);
      await say(r.ok ? r.toast : r.reason === "not_pending" ? `That schedule change is already ${r.status}.` : "That request isn't on your Requests tab anymore.");
      break;
    }
    case "job_application": {
      // PostsPage.tsx's applicant row: the profile (tap-through), Request Interview, Decline. Live 2026-10-07 the
      // notice asked "Want me to pull up their profile?" and a "Decline" reply was taken by the first-visit review
      // prompt instead ("the Leave a Review button stays…").
      const appSnap = await db.collection("job_applications").doc(pd.recordId).get().catch(() => null);
      const app = appSnap?.exists ? (appSnap.data() ?? {}) : null;
      if (!app) { await say("That application isn't on your post anymore."); break; }
      const name = String(app.caregiverName ?? pd.party ?? "the caregiver");
      const firstName = name.split(/\s+/)[0];
      if (String(app.status ?? "pending") !== "pending") { await say(`${firstName}'s application is already ${String(app.status)}.`); break; }
      if (choice === "VIEW") {
        const { getAppUrl } = await import("../config/appUrl");
        await say(`Tap to view ${firstName}'s profile: ${getAppUrl()}/p/${String(app.caregiverId ?? "")}\n\nReply INTERVIEW to request an interview, or DECLINE.`);
        keepParked = true;
        break;
      }
      if (choice === "DECLINE") {
        // The row's Decline button writes at once on the page (the card is in view); over text, name it and confirm.
        await say(`Decline ${firstName}'s application to "${String(app.jobTitle ?? "your post")}"? Reply YES or NO.`);
        await db.collection("agent_sessions").doc(phone).set({ pendingDecision: parkedDecision("job_application_decline", pd.recordId, `declining ${pd.label}`, "client", Date.now(), name) }, { merge: true }).catch(() => {});
        return;
      }
      // INTERVIEW — the row's Request Interview button: the site's interview flow for this caregiver, linked to the application.
      const { startInterviewFlow } = await import("./interviewFlow");
      await startInterviewFlow(phone, chatId, session as AgentSession, { caregiverId: String(app.caregiverId ?? ""), applicationId: pd.recordId });
      break;
    }
    case "job_application_decline": {
      const firstName = String(pd.party ?? "the caregiver").split(/\s+/)[0];
      if (choice === "NO") { await say(`Okay — ${firstName}'s application stays as it is.`); break; }
      const ref = db.collection("job_applications").doc(pd.recordId);
      const snap = await ref.get().catch(() => null);
      const app = snap?.exists ? (snap.data() ?? {}) : null;
      if (!app) { await say("That application isn't on your post anymore."); break; }
      if (String(app.status ?? "pending") !== "pending") { await say(`${firstName}'s application is already ${String(app.status)}.`); break; }
      // PostsPage.tsx handleDeclineApplicant, exactly: status 'rejected' + declinedAt; nothing is sent to the caregiver.
      await ref.update({ status: "rejected", declinedAt: admin.firestore.FieldValue.serverTimestamp() });
      await say("Applicant declined"); // the page's toast
      break;
    }
    case "new_job": {
      if (choice === "DETAILS") {
        const { sendJobDetails } = await import("./jobBoardText");
        await sendJobDetails(phone, chatId, caregiverId, pd.recordId);
        keepParked = true; // "apply" can still follow
        break;
      }
      const { startApplyFlow } = await import("./caregiverJobFlows");
      await startApplyFlow(phone, chatId, session as AgentSession, { caregiverId, jobId: pd.recordId });
      break;
    }
  }
  if (!keepParked) await clearDecision(phone);
}
