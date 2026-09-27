// The caregiver Jobs page's two forms, as scripted step-by-step flows
// (founder, 2026-09-27: "should reschedule, applying be in a flow… they will be
// able to get out anytime… have the option to submit or cancel, like the
// confirmation"):
//
//   • Apply — the "Apply for Position" modal (JobBoard.tsx): Your Profile
//     (experience, rating, first 3 skills) + Client's budget, an OPTIONAL cover
//     letter, then Submit Application / Cancel. Ends in the site's exact
//     job_applications write (jobApplicationSubmit.ts).
//   • Propose new time / Reschedule — the interview row's form: a date, a time
//     from the site's picker (9:00 AM–6:00 PM on the hour / half hour), then
//     Send new time / Cancel. Ends in the site's exact proposal write
//     (reschedulePendingTime / rescheduledBy 'caregiver'); the family is told by
//     onVideoInterviewWrite like a click on the site.
//
// Same conventions as the family's scripted flows (interviewFlow.ts,
// bookingFlow.ts): one question per turn, isBackOutRequest checked FIRST at
// every step ("never mind" / "cancel" leaves immediately), a mid-flow question
// is answered and the step re-asked, LLM parsing with re-ask on anything
// unclear, 1h expiry via stateExpiresAt.
import * as admin from "firebase-admin";
import { sendMessage, AgentSession } from "../linq/client";
import { quickComplete } from "../utils/openaiClient";
import { isBackOutRequest, isQuestionOrOther, answerMidFlow } from "./stepHandler";
import { parseScheduledTimeMs, formatInterviewTime, businessTodayStr } from "../utils/scheduledTime";
import { caregiverBlockReason, jobRequiresTransport, textCaregiverGateBlock } from "./caregiverAccessGate";
import { submitJobApplication } from "./jobApplicationSubmit";
import { rateLabel, normalizeJobPost } from "./jobBoardPage";
import { sendJobList } from "./jobBoardText";
import { isSiteInterviewSlot, PENDING_STATUSES, ACCEPTED_STATUSES } from "./caregiverInterviewsTab";

const db = admin.firestore();
const FLOW_TTL_MS = 60 * 60 * 1000;
const DIDNT_CATCH = "Sorry, I didn't quite catch that.";

async function parse(prompt: string, text: string): Promise<string> {
  return quickComplete(prompt + "\nReply with ONLY the requested value — no explanation.", text, { maxTokens: 120 }).catch(() => "__parse_error__");
}

// ── Apply flow ────────────────────────────────────────────────────────────────

export interface ApplyFlowData {
  jobId: string;
  jobTitle: string;
  budget: string;         // rateLabel — "Client's budget"
  coverLetter?: string;
}

const COVER_QUESTION = "Cover letter (optional) — tell the client why you're a good fit, or reply SKIP.";
const APPLY_CONFIRM = (d: ApplyFlowData) =>
  `Ready to send?\n\nJob: ${d.jobTitle}\nCover letter: ${d.coverLetter ? `"${d.coverLetter}"` : "(none)"}\n\nReply SUBMIT to send your application, or CANCEL.`;

export async function startApplyFlow(
  phone: string, chatId: string, session: AgentSession, args: { caregiverId: string; jobId: string },
): Promise<{ started: boolean; reason?: string }> {
  const [jobSnap, cgSnap, dup] = await Promise.all([
    db.collection("job_posts").doc(args.jobId).get(),
    db.collection("caregivers").doc(args.caregiverId).get(),
    db.collection("job_applications").where("jobId", "==", args.jobId).where("caregiverId", "==", args.caregiverId).limit(1).get(),
  ]);
  if (!jobSnap.exists || jobSnap.data()?.status !== "open") {
    // Same as the board: the closed post is gone from it — show what's there now.
    await sendMessage(chatId, "That job is no longer open — here's what's open near you now:");
    await sendJobList(phone, chatId, args.caregiverId).catch(() => {});
    return { started: false, reason: "not_open" };
  }
  if (!dup.empty) {
    await sendMessage(chatId, "You've already applied to that job — it's on your My Applications tab.");
    return { started: false, reason: "duplicate" };
  }
  const job = normalizeJobPost({ id: jobSnap.id, ...(jobSnap.data() as Record<string, unknown>) });
  const cg = (cgSnap.exists ? cgSnap.data() : {}) as Record<string, unknown>;
  // JobBoard.tsx: the gate button stands in for Apply Now.
  const gate = caregiverBlockReason(cg, { transport: jobRequiresTransport(job) });
  if (gate) {
    await textCaregiverGateBlock(phone, chatId, gate, cg);
    return { started: false, reason: "gated" };
  }

  const data: ApplyFlowData = { jobId: args.jobId, jobTitle: String(job.title ?? "Care needed"), budget: rateLabel(job) };
  await db.collection("agent_sessions").doc(phone).update({
    applyFlowStep: "apply_cover",
    applyFlowData: data,
    stateExpiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString(),
  });
  // The modal, top to bottom: title, Your Profile, Client's budget, cover letter.
  const skills = Array.isArray(cg.skills) ? (cg.skills as string[]).slice(0, 3).join(", ") : "";
  const experience = cg.experience ?? cg.yearsExperience;
  const rating = typeof cg.rating === "number" && (Number(cg.reviewCount) || 0) > 0 ? `\nRating: ${cg.rating.toFixed(1)} ⭐` : "";
  await sendMessage(chatId,
    `Apply for Position — ${data.jobTitle}\n\n` +
    `Your Profile\nExperience: ${experience ?? 0}${typeof experience === "number" ? " years" : ""}${rating}${skills ? `\nSkills: ${skills}` : ""}\n` +
    `Client's budget: ${data.budget}\n\n${COVER_QUESTION}`);
  return { started: true };
}

export async function handleApplyFlowStep(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const step = (session as any).applyFlowStep as string;
  const data = ((session as any).applyFlowData ?? {}) as ApplyFlowData;
  const clear = () => db.collection("agent_sessions").doc(phone).update({
    applyFlowStep: admin.firestore.FieldValue.delete(), applyFlowData: admin.firestore.FieldValue.delete(), stateExpiresAt: admin.firestore.FieldValue.delete(),
  });
  const cancelled = async () => { await clear(); await sendMessage(chatId, "Okay — nothing was sent. The job is still on your Jobs page if you change your mind."); };

  if (step === "apply_cover") {
    if (await isBackOutRequest(text, COVER_QUESTION)) return cancelled();
    if (await isQuestionOrOther(text, COVER_QUESTION)) {
      await sendMessage(chatId, await answerMidFlow(text, COVER_QUESTION));
      return;
    }
    const verdict = await parse(
      "The caregiver was asked for an OPTIONAL cover letter, or to reply SKIP. Reply SKIP if they declined / want no cover letter " +
      "(\"skip\", \"no\", \"none\", \"no thanks\"). Otherwise reply LETTER — their message IS the cover letter.", text);
    const coverLetter = verdict.trim().toUpperCase().startsWith("SKIP") ? "" : text.trim();
    const next: ApplyFlowData = { ...data, coverLetter };
    await db.collection("agent_sessions").doc(phone).update({ applyFlowStep: "apply_confirm", applyFlowData: next });
    await sendMessage(chatId, APPLY_CONFIRM(next));
    return;
  }

  if (step === "apply_confirm") {
    const norm = text.trim().toUpperCase();
    let action: "submit" | "cancel" | "other";
    if (norm === "SUBMIT" || norm === "YES" || norm === "SEND") action = "submit";
    else if (norm === "CANCEL" || norm === "NO") action = "cancel";
    else if (await isBackOutRequest(text, APPLY_CONFIRM(data))) action = "cancel";
    else {
      const v = await parse("Evia asked the caregiver to reply SUBMIT to send their job application, or CANCEL. Classify: SUBMIT (they want it sent), CANCEL (they don't), or OTHER (a question / something else).", text);
      action = v.toUpperCase().startsWith("SUBMIT") ? "submit" : v.toUpperCase().startsWith("CANCEL") ? "cancel" : "other";
    }
    if (action === "cancel") return cancelled();
    if (action === "other") {
      if (await isQuestionOrOther(text, APPLY_CONFIRM(data))) await sendMessage(chatId, await answerMidFlow(text, APPLY_CONFIRM(data)));
      else await sendMessage(chatId, `${DIDNT_CATCH} ${APPLY_CONFIRM(data)}`);
      return;
    }
    const caregiverId = (session.caregiverId ?? session.userId) as string;
    const result = await submitJobApplication({ caregiverId, jobId: data.jobId, coverLetter: data.coverLetter, source: "sms:apply_flow" });
    await clear();
    if (result.ok) {
      await sendMessage(chatId, `Application submitted for ${result.jobTitle}!`); // the site's toast
    } else if (result.code === "GATED" && result.gate) {
      await textCaregiverGateBlock(phone, chatId, result.gate);
    } else if (result.code === "DUPLICATE") {
      await sendMessage(chatId, "You have already applied to this job.");
    } else {
      await sendMessage(chatId, "That job is no longer accepting applications.");
    }
    return;
  }
  await clear();
}

// ── Interview reschedule flow (Propose new time / Reschedule) ─────────────────

export interface RescheduleFlowData {
  interviewId: string;
  clientName: string;
  jobTitle?: string;
  date?: string;   // YYYY-MM-DD
  time?: string;   // HH:MM
}

const DATE_QUESTION = "What date? (e.g. 9/28 or next Monday)";
const TIME_QUESTION = "What time? Interviews run between 9:00 AM and 6:00 PM, on the hour or half hour (e.g. 10:30 AM).";
const RS_CONFIRM = (d: RescheduleFlowData, label: string) =>
  `New time: ${label}\n\nReply SEND to propose it to ${d.clientName} — the interview stays at its current time until they confirm — or CANCEL.`;

export async function startInterviewRescheduleFlow(
  phone: string, chatId: string, session: AgentSession, args: { caregiverId: string; interviewId: string },
): Promise<{ started: boolean; reason?: string }> {
  const ivSnap = await db.collection("video_interviews").doc(args.interviewId).get();
  const iv = ivSnap.data();
  if (!ivSnap.exists || iv?.caregiverId !== args.caregiverId) {
    await sendMessage(chatId, "I couldn't find that interview.");
    return { started: false, reason: "not_found" };
  }
  const status = String(iv.status ?? "pending");
  const pending = PENDING_STATUSES.includes(status);
  if (!pending && !ACCEPTED_STATUSES.includes(status)) {
    await sendMessage(chatId, `That interview is ${status} — there's nothing to reschedule.`);
    return { started: false, reason: "terminal" };
  }
  if (iv.reschedulePendingTime && iv.rescheduledBy === "caregiver") {
    await sendMessage(chatId, "You already proposed a new time for this interview — it's waiting on the family to confirm.");
    return { started: false, reason: "own_proposal_out" };
  }
  // JobBoard.tsx hides the form while gated (membership → background check).
  const cg = (await db.collection("caregivers").doc(args.caregiverId).get()).data() ?? {};
  const gate = caregiverBlockReason(cg);
  if (gate) {
    await textCaregiverGateBlock(phone, chatId, gate, cg);
    return { started: false, reason: "gated" };
  }
  const data: RescheduleFlowData = { interviewId: args.interviewId, clientName: String(iv.clientName || "the family"), jobTitle: iv.jobTitle as string | undefined };
  await db.collection("agent_sessions").doc(phone).update({
    interviewRescheduleFlowStep: "rs_date",
    interviewRescheduleFlowData: data,
    stateExpiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString(),
  });
  const current = typeof iv.scheduledTime === "string" ? formatInterviewTime(parseScheduledTimeMs(iv.scheduledTime)) : "";
  await sendMessage(chatId, `${status === "accepted" || status === "confirmed" ? "Reschedule" : "Propose a new time for"} your interview with ${data.clientName}${data.jobTitle ? ` (${data.jobTitle})` : ""}${current ? `, currently ${current}` : ""}.\n\n${DATE_QUESTION}`);
  return { started: true };
}

export async function handleInterviewRescheduleFlowStep(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const step = (session as any).interviewRescheduleFlowStep as string;
  const data = ((session as any).interviewRescheduleFlowData ?? {}) as RescheduleFlowData;
  const ref = db.collection("agent_sessions").doc(phone);
  const clear = () => ref.update({
    interviewRescheduleFlowStep: admin.firestore.FieldValue.delete(), interviewRescheduleFlowData: admin.firestore.FieldValue.delete(), stateExpiresAt: admin.firestore.FieldValue.delete(),
  });
  const cancelled = async () => { await clear(); await sendMessage(chatId, "Okay — nothing was sent. The interview stays as it is."); };

  if (step === "rs_date") {
    if (await isBackOutRequest(text, DATE_QUESTION)) return cancelled();
    if (await isQuestionOrOther(text, DATE_QUESTION)) { await sendMessage(chatId, await answerMidFlow(text, DATE_QUESTION)); return; }
    const today = businessTodayStr();
    const raw = await parse(
      `Today is ${today} (Pacific time). The caregiver is naming the DATE for an interview. Reply with that date as YYYY-MM-DD ` +
      "(resolve relative words like tomorrow / next Monday / 9/28 against today, never a past date), or NONE if no date is given.", text);
    const m = /(\d{4}-\d{2}-\d{2})/.exec(raw);
    if (!m || m[1] < today) { await sendMessage(chatId, `${DIDNT_CATCH} ${DATE_QUESTION}`); return; }
    // The caregiver may have given date AND time in one message.
    const t = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
    let time: string | undefined;
    if (t) {
      let h = Number(t[1]) % 12; if (t[3].toLowerCase() === "pm") h += 12;
      time = `${String(h).padStart(2, "0")}:${t[2] ?? "00"}`;
    }
    const next: RescheduleFlowData = { ...data, date: m[1], ...(time && isSiteInterviewSlot(time) ? { time } : {}) };
    if (next.time) {
      await ref.update({ interviewRescheduleFlowStep: "rs_confirm", interviewRescheduleFlowData: next });
      await sendMessage(chatId, RS_CONFIRM(next, formatInterviewTime(parseScheduledTimeMs(`${next.date}T${next.time}:00`))));
    } else {
      await ref.update({ interviewRescheduleFlowStep: "rs_time", interviewRescheduleFlowData: next });
      await sendMessage(chatId, TIME_QUESTION);
    }
    return;
  }

  if (step === "rs_time") {
    if (await isBackOutRequest(text, TIME_QUESTION)) return cancelled();
    if (await isQuestionOrOther(text, TIME_QUESTION)) { await sendMessage(chatId, await answerMidFlow(text, TIME_QUESTION)); return; }
    const raw = await parse("The caregiver is naming a TIME of day. Reply with it as 24-hour HH:MM (e.g. 10:30, 14:00), or NONE if no time is given.", text);
    const m = /(\d{1,2}):(\d{2})/.exec(raw);
    const time = m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
    if (!time || !isSiteInterviewSlot(time)) { await sendMessage(chatId, `${DIDNT_CATCH} ${TIME_QUESTION}`); return; }
    const next: RescheduleFlowData = { ...data, time };
    await ref.update({ interviewRescheduleFlowStep: "rs_confirm", interviewRescheduleFlowData: next });
    await sendMessage(chatId, RS_CONFIRM(next, formatInterviewTime(parseScheduledTimeMs(`${next.date}T${time}:00`))));
    return;
  }

  if (step === "rs_confirm") {
    const label = data.date && data.time ? formatInterviewTime(parseScheduledTimeMs(`${data.date}T${data.time}:00`)) : "";
    const question = RS_CONFIRM(data, label);
    const norm = text.trim().toUpperCase();
    let action: "send" | "cancel" | "other";
    if (norm === "SEND" || norm === "YES" || norm === "SUBMIT") action = "send";
    else if (norm === "CANCEL" || norm === "NO") action = "cancel";
    else if (await isBackOutRequest(text, question)) action = "cancel";
    else {
      const v = await parse("Evia asked the caregiver to reply SEND to propose the new interview time, or CANCEL. Classify: SEND, CANCEL, or OTHER (a question / a different time / something else).", text);
      action = v.toUpperCase().startsWith("SEND") ? "send" : v.toUpperCase().startsWith("CANCEL") ? "cancel" : "other";
    }
    if (action === "cancel") return cancelled();
    if (action === "other") {
      if (await isQuestionOrOther(text, question)) await sendMessage(chatId, await answerMidFlow(text, question));
      else await sendMessage(chatId, `${DIDNT_CATCH} ${question}`);
      return;
    }
    const startMs = parseScheduledTimeMs(`${data.date}T${data.time}:00`);
    if (Number.isNaN(startMs) || startMs <= Date.now()) { await clear(); await sendMessage(chatId, "That time has already passed — start again with a future date."); return; }
    const ivRef = db.collection("video_interviews").doc(data.interviewId);
    const iv = (await ivRef.get()).data();
    if (!iv || (iv.reschedulePendingTime && iv.rescheduledBy === "caregiver")) { await clear(); await sendMessage(chatId, "That proposal is already out — waiting on the family."); return; }
    // The site's handleRescheduleInterview write, field for field.
    await ivRef.update({
      reschedulePendingTime: new Date(startMs).toISOString(),
      rescheduledBy: "caregiver",
      acceptedRescheduleViaAgent: admin.firestore.FieldValue.delete(),
      rescheduledViaAgent: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await clear();
    await sendMessage(chatId, "New time proposed — waiting on the family to confirm"); // the site's toast
    return;
  }
  await clear();
}
