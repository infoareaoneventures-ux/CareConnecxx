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

const db = admin.firestore();

export type DecisionKind =
  | "interview_request"          // caregiver: ACCEPT / DECLINE / PROPOSE
  | "interview_proposal"         // either side: CONFIRM / PROPOSE
  | "booking_request"            // caregiver: ACCEPT / DECLINE / DETAILS
  | "booking_request_decline"    // caregiver: the page's confirm — YES / NO
  | "amendment"                  // caregiver: ACCEPT / DECLINE
  | "new_job";                   // caregiver: APPLY / DETAILS

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

/** Exact word first; otherwise a quick-tier classifier; a question / anything else → null (the agent takes it). */
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
    `"sounds good" → the positive option, "tell me more" → DETAILS when offered). Only a question, a request about something else, or an unclear reply is OTHER. Reply with ONE word only.`,
    text,
    { maxTokens: 5 },
  ).catch(() => "OTHER");
  const word = raw.trim().toUpperCase().replace(/[^A-Z]/g, "");
  return pd.options.includes(word) ? word : null;
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
