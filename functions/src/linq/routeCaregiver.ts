import * as admin from "firebase-admin";
import { sendMessage, startTyping, stopTyping, AgentSession } from "./client";
import { quickComplete } from "../utils/openaiClient";
import { generateCaraMessage } from "../utils/caraMessage";
import { sendIfNotDND } from "../utils/dndGuard";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { handleCaregiverSwapRequest, handleSwapAcceptance } from "../agents/caregiverSwapHandler";
import { handleCaregiverCancelShift } from "../agents/caregiverCancelShiftHandler";
import { handleCaregiverProfileUpdate } from "../agents/caregiverProfileHandler";
import { handleJobResponse, handleAvailabilityConfirmation } from "../triggers/jobNotifications";
import { handleCaregiverAvailabilityReply } from "../agents/interviewAgent";
import { logAudit } from "../observability/auditLog";
import { logAgentAction } from "../observability/actionLedger";
import {
  createCaregiverReferralInvite,
  normalizeCaregiverReferralPhone,
  resolveCaregiverReferralName,
} from "../agents/caregiverReferral";
import { answerHumanQuestionOnly } from "../agents/humanReply";
import { businessTodayStr, businessTomorrowStr } from "../utils/scheduledTime";
import type { AwaitingInShiftUpdate } from "../scheduled/inShiftUpdatePolicy";
import { autoApproveAtIso, TIMESHEET_AUTO_APPROVE_HOURS } from "../config/slaConstants";
import { buildLayFallbackSummary } from "./shiftSummaryFallback";

const db = admin.firestore();

export interface CaregiverRouteContext {
  phone: string;
  chatId: string;
  text: string;
  norm: string;
  session: AgentSession;
}

interface PendingCaregiverReferral {
  referredName?:  string;
  referredPhone?: string;
  startedAt?:     string;
}

function normalizeReferralPhone(raw: string): string {
  return normalizeCaregiverReferralPhone(raw);
}

function extractPhoneFromText(text: string): string {
  const match = text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return match ? normalizeReferralPhone(match[0]) : "";
}

// Name extraction is meaning-parsing of free-form text — CLAUDE.md mandates an
// LLM, never a keyword-strip heuristic. (Phone extraction stays regex: that is
// format detection, the explicitly-allowed exception, like email validation.)
async function extractReferralName(text: string): Promise<string> {
  const raw = await quickComplete(
    "Extract the referred caregiver's name from this text. If no name is present, reply with an empty string. Reply with only the name.",
    text,
    { maxTokens: 30 },
  ).catch(() => "");
  return raw.trim().replace(/^["']|["']$/g, "");
}

// Intent detection on free-form SMS — CLAUDE.md forbids regex/keyword matching
// here. The `norm` fast-path is allowed: it's the upstream LLM classifier's
// result, not a string heuristic. Everything else goes through the LLM.
async function isCaregiverReferralIntent(text: string, norm: string): Promise<boolean> {
  if (norm === "REFER" || norm === "REFERRAL") return true;
  const raw = await quickComplete(
    "Does this caregiver's message express intent to refer, invite, or recommend ANOTHER person to become an Evia caregiver? Reply only YES or NO.",
    text,
    { maxTokens: 5 },
  ).catch(() => "");
  return raw.trim().toUpperCase().startsWith("Y");
}

async function handleCaregiverReferral(
  phone: string,
  chatId: string,
  text: string,
  session: AgentSession,
  pending?: PendingCaregiverReferral,
): Promise<void> {
  // CLAUDE.md handler checklist: while collecting referral details, a mid-flow
  // question must not be misparsed as a name/phone. Detect it (LLM, not regex)
  // and re-ask the current question instead of extracting garbage from it.
  if (pending) {
    const qRaw = await quickComplete(
      "A caregiver is being asked for a referral's name and phone number. Is THIS message a question or off-topic, rather than a name/phone answer? Reply only YES or NO.",
      text,
      { maxTokens: 5 },
    ).catch(() => "");
    if (qRaw.trim().toUpperCase().startsWith("Y")) {
      const reAsk = pending.referredName
        ? `What phone number should I text for ${pending.referredName}?`
        : "Who should I invite? Send me their name.";
      await sendMessage(chatId, reAsk);
      return;
    }
  }

  const extractedPhone = extractPhoneFromText(text);
  const extractedName  = await extractReferralName(text);
  const next: PendingCaregiverReferral = {
    ...(pending ?? {}),
    ...(extractedName  ? { referredName: extractedName } : {}),
    ...(extractedPhone ? { referredPhone: extractedPhone } : {}),
    startedAt: pending?.startedAt ?? new Date().toISOString(),
  };

  if (!next.referredName) {
    await db.collection("agent_sessions").doc(phone).set({
      pendingCaregiverReferral: next,
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }, { merge: true });
    await sendMessage(chatId, "Who should I invite? Send me their name.");
    return;
  }

  if (!next.referredPhone) {
    await db.collection("agent_sessions").doc(phone).set({
      pendingCaregiverReferral: next,
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }, { merge: true });
    await sendMessage(chatId, `What phone number should I text for ${next.referredName}?`);
    return;
  }

  try {
    const referrerName = await resolveCaregiverReferralName(session.caregiverId, phone);
    const result = await createCaregiverReferralInvite({
      referrerUserId: session.caregiverId ?? session.userId ?? phone,
      referrerPhone: phone,
      referrerName,
      referredName: next.referredName,
      referredPhone: next.referredPhone,
      source: "cara_sms",
    });
    if (result.deliveryStatus === "sent") {
      await sendMessage(chatId, `Sent. I texted ${next.referredName} the caregiver application link.`);
    } else {
      await sendMessage(chatId, `I saved the referral, but I couldn't text ${next.referredName} yet. I flagged it for admin review.`);
    }
  } finally {
    await db.collection("agent_sessions").doc(phone).update({
      pendingCaregiverReferral: admin.firestore.FieldValue.delete(),
      stateExpiresAt: admin.firestore.FieldValue.delete(),
    }).catch(() => {});
  }
}

// ── Caregiver keyword handlers ────────────────────────────────────────────────

async function handleArrived(phone: string, chatId: string, session: AgentSession): Promise<void> {
  // Find today's appointment for this caregiver. Business-timezone date — the
  // UTC date is already tomorrow during Pacific evenings, so toISOString()
  // would miss every evening shift (appt.date is written/queried as a Pacific
  // business date by the reminder pipeline).
  const today  = businessTodayStr();
  const caregiverId = session.caregiverId;
  if (!caregiverId) return;

  const snap = await db.collection("appointments")
    .where("caregiverId", "==", caregiverId)
    .where("date",        "==", today)
    .where("status",      "in", ["confirmed", "pending_caregiver_confirmation"])
    .limit(1).get();

  if (snap.empty) {
    const noVisitMsg = await generateCaraMessage({
      audience: "caregiver",
      context: "Caregiver texted ARRIVED but no active appointment was found for them today. Let them know and invite them to flag if something looks wrong.",
      fallback: "I don't see a scheduled visit for you today. Let me know if something looks wrong.",
    });
    await sendMessage(chatId, noVisitMsg);
    return;
  }

  const appt = snap.docs[0];
  const apptData = appt.data();
  const arrivedAt = new Date().toISOString();
  await appt.ref.update({ arrivedAt, status: "in-progress" });

  // Track lateness if caregiver arrived >= 15 min after scheduled start
  const scheduledStart = apptData.startTime ?? apptData.time ?? "";
  if (scheduledStart && session.caregiverId) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const schedMs  = new Date(`${todayStr}T${scheduledStart.slice(0, 5)}:00`).getTime();
    const minutesLate = Math.round((Date.now() - schedMs) / 60000);
    if (minutesLate >= 15) {
      const cgSnap  = await db.collection("caregivers").doc(session.caregiverId).get();
      const cgName  = cgSnap.data()?.name ?? "Unknown";
      const { recordLatenessEvent, checkLatenessPattern } = await import("../agents/latenessTracker");
      recordLatenessEvent({
        caregiverId:   session.caregiverId,
        caregiverName: cgName,
        appointmentId: appt.id,
        clientId:      apptData.clientId ?? "",
        date:          todayStr,
        scheduledTime: scheduledStart.slice(0, 5),
        minutesLate,
        selfReported:  false,
      }).catch(() => {});
      checkLatenessPattern(session.caregiverId, cgName).catch(() => {});
    }
  }

  // Notify family (DND-aware: high urgency — queued but priority delivery)
  const clientPhone = await getClientPhoneForAppt(apptData);
  if (clientPhone) {
    const cgName2 = session.caregiverId
      ? (await db.collection("caregivers").doc(session.caregiverId).get()).data()?.name ?? "Your caregiver"
      : "Your caregiver";
    await sendIfNotDND(clientPhone, {
      content:     `${cgName2} just arrived for ${apptData.clientName ?? "the visit"}.`,
      urgency:     "immediate",
      sourceAgent: "arrived_notification",
      canDrop:     false,
    }, "high");
  }

  const arrivedAckMsg = await generateCaraMessage({
    audience: "caregiver",
    context: `Caregiver just arrived at the client's home${apptData.clientName ? ` for ${apptData.clientName}` : ""}. The family has been notified. Wish them a good visit.`,
    fallback: "Got it — I've let the family know you're there. Have a good visit.",
  });
  await sendMessage(chatId, arrivedAckMsg);

  // Send caregiver a care plan task overview for the shift (fire-and-forget)
  sendArrivalCarePlanBriefing(chatId, apptData).catch(() => {});
}

// ── Day-before shift confirmation handler ────────────────────────────────────

async function handleShiftConfirmation(
  phone:   string,
  chatId:  string,
  text:    string,
  session: AgentSession
): Promise<void> {
  const info = (session as any).pendingShiftConfirmation as {
    appointmentId:   string;
    appointmentDate: string;
    clientId:        string;
    seniorName:      string;
    startTime:       string;
    caregiverName:   string;
  };


  // Parse YES / NO / question
  const parseRaw = await quickComplete(
    "The caregiver is responding to a shift confirmation request for tomorrow. " +
      "Reply CONFIRM if they said yes, they'll be there. " +
      "Reply CANCEL if they said no, they can't make it. " +
      "Reply QUESTION if it is a question or unclear. " +
      "Reply with exactly one word.",
    text,
    { maxTokens: 10 },
  ).catch(() => "");

  const decision = parseRaw.trim().toUpperCase();

  // Always clear the state flag
  await db.collection("agent_sessions").doc(phone).update({
    pendingShiftConfirmation: admin.firestore.FieldValue.delete(),
    stateExpiresAt:           admin.firestore.FieldValue.delete(),
  });

  const cgFirstName  = info.caregiverName.split(" ")[0] || "Your caregiver";
  const displayDate  = (info as any).appointmentDisplay || info.appointmentDate;

  if (decision === "CONFIRM") {
    await db.collection("appointments").doc(info.appointmentId).update({
      caregiverDayBeforeConfirmed:   true,
      caregiverDayBeforeConfirmedAt: new Date().toISOString(),
    });

    const confirmMsg = await generateCaraMessage({
      audience: "caregiver",
      context:
        `${cgFirstName} just confirmed they'll be at ${info.seniorName}'s shift ` +
        `on ${displayDate}${info.startTime ? " at " + info.startTime : ""}. ` +
        `Write a warm, brief thank-you confirming you've got them set. Sound genuinely grateful.`,
      fallback:
        `You're all set — thanks for confirming, ${cgFirstName}! See you at ${info.seniorName}'s on ${displayDate}.`,
    });
    await sendMessage(chatId, confirmMsg);

    // Notify family
    const clientPhone = await getClientPhoneByClientId(info.clientId);
    if (clientPhone) {
      const familyMsg = await generateCaraMessage({
        audience: "family",
        context:
          `${cgFirstName} just confirmed they'll be at ${info.seniorName}'s care visit ` +
          `on ${displayDate}${info.startTime ? " at " + info.startTime : ""}. ` +
          `Write a warm, reassuring message letting the family know everything's confirmed. ` +
          `Sound like a coordinator who genuinely cares about their peace of mind.`,
        fallback:
          `Great news! ${cgFirstName} has confirmed they'll be there for ${info.seniorName}'s visit ` +
          `on ${displayDate}${info.startTime ? " at " + info.startTime : ""}. You're all set — no action needed!`,
      });
      await sendViaInteractionAgent(clientPhone, {
        content:     familyMsg,
        urgency:     "standard",
        sourceAgent: "shift_confirm_family_update",
        canDrop:     true,
      });
    }

  } else if (decision === "CANCEL") {
    await db.collection("appointments").doc(info.appointmentId).update({
      caregiverDayBeforeCancelled:   true,
      caregiverDayBeforeCancelledAt: new Date().toISOString(),
    });

    const cancelMsg = await generateCaraMessage({
      audience: "caregiver",
      context:
        `${cgFirstName} just let you know they can't make ${info.seniorName}'s shift on ${displayDate}. ` +
        `Write a brief, understanding response — acknowledge the situation without judgment, ` +
        `let them know the family will be notified and you'll take care of it from here. ` +
        `Be warm, not cold.`,
      fallback:
        `Understood, ${cgFirstName} — I'll let the family know and start working on coverage for ${displayDate}. ` +
        `I appreciate you letting me know ahead of time.`,
    });
    await sendMessage(chatId, cancelMsg);

    // Alert family with urgency
    const clientPhone = await getClientPhoneByClientId(info.clientId);
    if (clientPhone) {
      const alertMsg = await generateCaraMessage({
        audience: "family",
        context:
          `Unfortunately ${cgFirstName} just let us know they can't make ${info.seniorName}'s visit ` +
          `on ${displayDate}${info.startTime ? " at " + info.startTime : ""}. ` +
          `Write an urgent but calm message to the family alerting them. ` +
          `Let them know we're already working on finding a replacement. ` +
          `Tell them to reply HELP if they need immediate support. ` +
          `Be direct but not alarming — this is being handled.`,
        fallback:
          `Heads up — ${cgFirstName} won't be able to make ${info.seniorName}'s visit on ${displayDate}. ` +
          `I'm already working on finding coverage. Reply HELP if you need anything in the meantime.`,
      });
      await sendViaInteractionAgent(clientPhone, {
        content:     alertMsg,
        urgency:     "immediate",
        sourceAgent: "shift_confirm_family_update",
        canDrop:     false,
      });
    }

    // Trigger replacement agent (fire-and-forget). runEmergencyReplacement requires
    // { appointmentId, clientId, clientPhone, appt } — we must load the appointment to
    // build `appt` (caregiverId/time/date) and pass the family's phone. A failure here
    // is safety-critical (the family was just told coverage is being found), so we alert
    // admins on any error instead of silently swallowing it.
    if (clientPhone) {
      (async () => {
        try {
          const apptSnap = await db.collection("appointments").doc(info.appointmentId).get();
          const appt = {
            ...(apptSnap.data() || {}),
            caregiverName: info.caregiverName,
            date:          info.appointmentDate,
            time:          info.startTime,
          };
          const { runEmergencyReplacement } = await import("../agents/replacementAgent");
          if (typeof runEmergencyReplacement === "function") {
            await runEmergencyReplacement({
              appointmentId: info.appointmentId,
              clientId:      info.clientId,
              clientPhone,
              appt,
            });
          }
        } catch (err) {
          console.error("[handleShiftConfirmation] emergency replacement failed:", err);
          await db.collection("admin_alerts").add({
            type:          "emergency_replacement_failed",
            severity:      "critical",
            appointmentId: info.appointmentId,
            clientId:      info.clientId,
            clientPhone,
            seniorName:    info.seniorName,
            error:         String((err as any)?.message ?? err),
            createdAt:     new Date().toISOString(),
          }).catch(() => {});
        }
      })();
    } else {
      console.error("[handleShiftConfirmation] no clientPhone for appointment", info.appointmentId, "— cannot run replacement");
      await db.collection("admin_alerts").add({
        type:          "emergency_replacement_no_client_phone",
        severity:      "critical",
        appointmentId: info.appointmentId,
        clientId:      info.clientId,
        seniorName:    info.seniorName,
        createdAt:     new Date().toISOString(),
      }).catch(() => {});
    }

  } else {
    // QUESTION or unclear — answer the question, then re-ask the confirmation.
    // Generate the answer inline so we control message ordering (otherwise the
    // re-ask can land before the interaction agent's reply).
    let answer = "";
    try {
      answer = await answerHumanQuestionOnly({
        audience: "caregiver",
        situation: `caregiver was asked to confirm ${info.seniorName}'s shift on ${info.appointmentDate} at ${info.startTime}`,
        text,
        maxTokens: 180,
      });
    } catch {
      answer = "I do not want to guess on that.";
    }
    await sendMessage(chatId, answer);

    // Re-set the flag and re-ask (sequentially so the question is acknowledged first)
    await db.collection("agent_sessions").doc(phone).update({
      pendingShiftConfirmation: info,
      stateExpiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    });
    await sendMessage(chatId,
      `So — can you confirm you'll be at ${info.seniorName}'s shift on ${info.appointmentDate}? A quick yes or no is all I need.`
    );
  }
}

// ── Care plan briefing sent to caregiver at arrival ───────────────────────────

async function sendArrivalCarePlanBriefing(
  chatId:   string,
  apptData: admin.firestore.DocumentData
): Promise<void> {
  const clientId = (apptData.clientId ?? "") as string;
  const seniorId = (apptData.seniorId ?? clientId) as string;
  const seniorName = (apptData.clientName ?? "your client") as string;

  // Load care plan (same dual-path as shiftTaskNudges)
  let dailyRoutine: Array<{ id: string; time: string; description: string; category: string }> = [];
  let medications:  Array<{ name: string; dosage: string; frequency: string }> = [];

  for (const [collection, docId] of [
    ["senior_profiles", seniorId],
    ["senior_profiles", clientId],
  ] as [string, string][]) {
    if (!docId) continue;
    const snap = await db.collection(collection).doc(docId)
      .collection("care_plans").doc("default").get().catch(() => null);
    if (snap?.exists) {
      const d = snap.data()!;
      dailyRoutine = (d.dailyRoutine ?? []) as typeof dailyRoutine;
      medications  = (d.medications  ?? []) as typeof medications;
      break;
    }
  }
  if (!dailyRoutine.length && !medications.length) {
    // Try legacy flat collection
    const snap = await db.collection("care_plans").doc(clientId).get().catch(() => null);
    if (snap?.exists) {
      const d = snap.data()!;
      dailyRoutine = (d.dailyRoutine ?? []) as typeof dailyRoutine;
      medications  = (d.medications  ?? []) as typeof medications;
    }
  }

  // Day-of tasks added by family (via pre-shift check-in)
  const dayOfVisitTasks = (apptData.dayOfVisitTasks ?? []) as string[];

  if (!dailyRoutine.length && !medications.length && !dayOfVisitTasks.length) return;

  // Sort tasks by time (unparseable times go to end)
  const sorted = [...dailyRoutine].sort((a, b) => {
    const toMin = (t: string): number => {
      const m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (m) {
        let h = parseInt(m[1], 10);
        if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
        if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
        return h * 60 + parseInt(m[2], 10);
      }
      const h24 = t.match(/^(\d{1,2}):(\d{2})$/);
      return h24 ? parseInt(h24[1], 10) * 60 + parseInt(h24[2], 10) : 9999;
    };
    return toMin(a.time) - toMin(b.time);
  });

  const lines = sorted.map(t => `• ${t.time} — ${t.description}`);

  if (medications.length > 0) {
    const medLine = medications
      .slice(0, 3)
      .map(m => `${m.name} ${m.dosage} (${m.frequency})`)
      .join(", ");
    lines.push(`\nMedications: ${medLine}`);
  }

  // Day-of tasks added by family today (highest priority — show first)
  let dayOfSection = "";
  if (dayOfVisitTasks.length > 0) {
    const dayOfLines = dayOfVisitTasks.map(t => `• ${t}`).join("\n");
    dayOfSection = `Added for today's visit by the family:\n${dayOfLines}\n\n`;
  }

  const planSection = lines.length > 0
    ? `Regular care plan:\n${lines.join("\n")}`
    : "";

  const cgFirstName = ((apptData.caregiverName ?? "") as string).split(" ")[0] || "there";
  const opening = await generateCaraMessage({
    audience: "caregiver",
    context:
      `Write one warm, brief opening line (1 sentence) welcoming ${cgFirstName} to ${seniorName}'s visit. ` +
      `${dayOfVisitTasks.length > 0 ? "Mention there are some family additions to the plan today." : "Keep it encouraging."}`,
    fallback: `You're checked in — here's the plan for ${seniorName}'s visit today!`,
    maxTokens: 60,
  });

  const body =
    `${opening}\n\n` +
    dayOfSection +
    planSection +
    `\n\nReply DONE when the visit is complete, or ISSUE if anything comes up.`;

  await sendMessage(chatId, body);
}

async function handleDone(phone: string, chatId: string, session: AgentSession, text?: string): Promise<void> {
  const caregiverId = session.caregiverId;
  if (!caregiverId) return;

  // If DONE arrived with extra text (e.g. "DONE but I need to ask you something"),
  // surface a question check. The pure-keyword path passes text === "DONE" and
  // we skip the LLM hop.
  if (text && text.trim().toUpperCase() !== "DONE" && text.trim().length > 8) {
    const qRaw = await quickComplete(
      "A caregiver just signaled they're done with a visit. " +
        "Reply YES if their message also contains a question they need answered. " +
        "Reply NO if it's only a sign-off. Only reply YES or NO.",
      text,
      { maxTokens: 5 },
    ).catch(() => "NO");
    if (qRaw.trim().toUpperCase().startsWith("Y")) {
      let answer = "";
      try {
        answer = await answerHumanQuestionOnly({
          audience: "caregiver",
          situation: "caregiver said they are done with a visit and also asked a question",
          text,
          maxTokens: 180,
        });
      } catch { answer = "I do not want to guess on that."; }
      await sendMessage(chatId, answer);
    }
  }

  // No date clause: the UTC date is tomorrow during Pacific evenings so a date
  // filter missed every evening DONE (leaving the visit in-progress forever —
  // the in-shift sweep would keep messaging the family about a finished visit).
  // A caregiver has at most one in-progress visit, so caregiverId+status is
  // sufficient — and it also lets a forgotten yesterday-shift complete.
  const snap  = await db.collection("appointments")
    .where("caregiverId", "==", caregiverId)
    .where("status",      "==", "in-progress")
    .limit(1).get();

  const apptData = snap.empty ? null : snap.docs[0].data();

  if (!snap.empty) {
    await snap.docs[0].ref.update({ completedAt: new Date().toISOString() });
  }

  // Store that we're awaiting care notes. Any open mid-shift check-in prompt is
  // moot now — clear it, or the caregiver's care-notes reply would be consumed
  // by the in-shift handler and relayed as a mid-shift update on a done visit.
  await db.collection("agent_sessions").doc(phone).update({
    awaitingCareNotes:    true,
    careNotesApptId:      snap.empty ? "" : snap.docs[0].id,
    awaitingInShiftUpdate: admin.firestore.FieldValue.delete(),
    stateExpiresAt:       new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });

  const seniorName  = (apptData?.clientName ?? apptData?.seniorName ?? "your client") as string;
  const cgFirstName = session.caregiverId
    ? ((await db.collection("caregivers").doc(session.caregiverId).get().catch(() => null))
        ?.data()?.name ?? "").split(" ")[0]
    : "";

  const doneMessage = await generateCaraMessage({
    audience: "caregiver",
    context:
      `${cgFirstName ? cgFirstName + " just" : "The caregiver just"} finished their shift with ${seniorName}. ` +
      `Write a warm, celebratory wrap-up message asking them to share how the visit went. ` +
      `Ask them to mention: what they did with ${seniorName}, how ${seniorName} was feeling/acting, ` +
      `notes on any tasks completed, and anything ${seniorName} asked for that wasn't in the regular plan. ` +
      `Tell them you'll put together a nice update for the family. ` +
      `Sound genuinely appreciative of their work — like a coordinator who cares.`,
    fallback:
      `Amazing work today${cgFirstName ? ", " + cgFirstName : ""}! 🙌 ` +
      `Before I send the family an update — tell me how it went with ${seniorName}. ` +
      `What did you two get up to, how was ${seniorName} feeling, and anything special to note? ` +
      `I'll take it from there.`,
    maxTokens: 200,
  });

  await sendMessage(chatId, doneMessage);
}

async function handleRunningLate(phone: string, chatId: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    awaitingLateMinutes: true,
    stateExpiresAt:      new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
  const howLateMsg = await generateCaraMessage({
    audience: "caregiver",
    context: "Caregiver said they're running late. Evia is asking how late they expect to be.",
    fallback: "How late do you think you'll be?",
    maxTokens: 60,
  });
  await sendMessage(chatId, howLateMsg);
}

async function handleIssue(phone: string, chatId: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    awaitingIssueDescription: true,
    stateExpiresAt:           new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
  const issuePromptMsg = await generateCaraMessage({
    audience: "caregiver",
    context: "Caregiver reported an issue during a visit. Evia is asking them to describe what's happening.",
    fallback: "That sounds important. What's happening right now?",
    maxTokens: 80,
  });
  await sendMessage(chatId, issuePromptMsg);
}

async function getClientPhoneForAppt(appt: admin.firestore.DocumentData): Promise<string | null> {
  const clientId = appt.clientId as string;
  if (!clientId) return null;
  const snap = await db.collection("agent_sessions")
    .where("userId", "==", clientId).limit(1).get();
  if (snap.empty) return null;
  return (snap.docs[0].data() as any).phone ?? snap.docs[0].id;
}

async function getClientPhoneByClientId(clientId: string): Promise<string | null> {
  if (!clientId) return null;
  const snap = await db.collection("agent_sessions")
    .where("userId", "==", clientId).limit(1).get();
  if (snap.empty) return null;
  return (snap.docs[0].data() as any).phone ?? snap.docs[0].id;
}

// ── Mid-shift family micro-update (task completed) ────────────────────────────

async function sendFamilyTaskUpdate(params: {
  taskDescription: string;
  taskCategory:    string;
  notes:           string;
  clientId:        string;
  seniorId:        string;
  clientPhone:     string;
  caregiverId:     string;
}): Promise<void> {
  const { taskDescription, taskCategory, notes, clientId, seniorId, clientPhone, caregiverId } = params;

  // Resolve names
  let seniorName = "";
  if (seniorId) {
    const snap = await db.collection("senior_profiles").doc(seniorId).get().catch(() => null);
    seniorName = (snap?.data()?.name ?? "") as string;
  }
  if (!seniorName && clientId) {
    const snap = await db.collection("users").doc(clientId).get().catch(() => null);
    seniorName = (snap?.data()?.seniorName ?? "") as string;
  }
  if (!seniorName) seniorName = "your loved one";

  let cgFirstName = "";
  if (caregiverId) {
    const snap = await db.collection("caregivers").doc(caregiverId).get().catch(() => null);
    const name = (snap?.data()?.name ?? "") as string;
    cgFirstName = name.split(" ")[0] || name;
  }
  if (!cgFirstName) cgFirstName = "Your caregiver";


  let content: string;
  try {
    const raw = await quickComplete(
      "You write a brief 1-2 sentence real-time care update for a family member.\n" +
        "Tone: warm, direct, reassuring. From Evia (a care coordinator), not the caregiver.\n" +
        "Keep it short — this is a mid-shift task update. No emoji. Output only the message text.",
      `Task just completed: ${taskDescription}\n` +
        `Category: ${taskCategory}\n` +
        `Caregiver notes: ${notes || "no additional notes"}\n` +
        `Senior: ${seniorName}\n` +
        `Caregiver: ${cgFirstName}`,
      { maxTokens: 120 },
    );
    content = raw.trim();
    if (!content) throw new Error("empty");
  } catch {
    content = `${cgFirstName} just completed ${taskDescription} for ${seniorName}.${notes ? " " + notes : ""}`;
  }

  await sendViaInteractionAgent(clientPhone, {
    content,
    urgency:     "standard",
    sourceAgent: "shift_task_family_update",
    canDrop:     true,
  });
}

// ── Mid-shift family update (hourly caregiver check-in reply) ─────────────────

async function sendFamilyInShiftUpdate(params: {
  note:        string;
  topic:       string;
  concern?:    boolean;
  seniorName:  string;
  clientId:    string;
  clientPhone: string;
  caregiverId: string;
}): Promise<boolean> {
  const { note, topic, concern, seniorName, clientId, clientPhone, caregiverId } = params;

  let cgFirstName = "";
  if (caregiverId) {
    const snap = await db.collection("caregivers").doc(caregiverId).get().catch(() => null);
    const name = (snap?.data()?.name ?? "") as string;
    cgFirstName = name.split(" ")[0] || name;
  }
  if (!cgFirstName) cgFirstName = "Your caregiver";

  let content: string;
  try {
    const raw = await quickComplete(
      "You write a brief 1-2 sentence real-time care update for a family member during an in-progress visit.\n" +
        "Tone: warm, direct, reassuring. From Evia (a care coordinator), relaying what the caregiver just shared.\n" +
        (concern
          ? "The caregiver flagged something worth keeping an eye on: mention it calmly as something being watched — " +
            "no alarm, no speculation, no clinical detail.\n"
          : "") +
        "PRIVACY: everyday non-clinical language only — no medication names/dosages, lab values, or graphic detail; " +
        "refer to those in general terms ('took medications as planned'). No emoji. Output only the message text.",
      `Topic: ${topic}\n` +
        `What the caregiver reported: ${note || "doing well, nothing notable"}\n` +
        `Senior: ${seniorName}\n` +
        `Caregiver: ${cgFirstName}`,
      { maxTokens: 120 },
    );
    content = raw.trim();
    if (!content) throw new Error("empty");
  } catch {
    // Fallback states only verified facts — never the raw caregiver text
    // (PHI/tone-unchecked) and never a wellbeing claim we didn't compose.
    content = `${cgFirstName} just checked in from ${seniorName}'s visit — I'll share the full picture in the end-of-visit summary.`;
  }

  const sent = await sendViaInteractionAgent(clientPhone, {
    content,
    urgency:        "standard",
    sourceAgent:    "in_shift_update",
    canDrop:        true,
    bypassDailyCap: true,
  });
  if (sent) {
    logAudit({
      eventType: "care_update_shared",
      userId: clientId,
      phone: clientPhone,
      data: { source: "in_shift_update", topic, concern: concern === true },
    }).catch(() => {});
    // Praise-loop stamp: if the family responds warmly (text or tapback) in the
    // next hour, inShiftPraise.ts relays that warmth back to the caregiver.
    db.collection("agent_sessions").doc(clientPhone).update({
      lastInShiftUpdate: {
        caregiverId,
        seniorName,
        sentAt:        new Date().toISOString(),
        praiseRelayed: false,
      },
    }).catch(() => {});
  }
  return sent;
}

// ── Shift-end family update (after care notes parsed) ────────────────────────

export async function sendFamilyShiftEndUpdate(params: {
  caregiverName: string;
  clientId:      string;
  seniorId:      string;
  apptData:      admin.firestore.DocumentData | null;
  entry:         Record<string, unknown>;
}): Promise<void> {
  const { caregiverName, clientId, seniorId, apptData, entry } = params;

  const clientPhone = await getClientPhoneByClientId(clientId);
  if (!clientPhone) return;
  const clientSessionSnap = await db.collection("agent_sessions").doc(clientPhone).get().catch(() => null);
  const hasFamilyGroup = !!clientSessionSnap?.data()?.groupChatId;

  // Resolve senior name
  let seniorName = (apptData?.clientName ?? "") as string;
  if (!seniorName && seniorId) {
    const snap = await db.collection("senior_profiles").doc(seniorId).get().catch(() => null);
    seniorName = (snap?.data()?.name ?? "") as string;
  }
  if (!seniorName) seniorName = "your loved one";

  const cgFirstName        = caregiverName.split(" ")[0] || caregiverName;
  const mood               = (entry.mood               ?? "")  as string;
  const appetite           = (entry.appetite           ?? "")  as string;
  const activities         = (entry.activities         ?? [])  as string[];
  const observations       = (entry.observations       ?? "")  as string;
  const notes              = (entry.notes              ?? "")  as string;
  const unplannedActivities = (entry.unplannedActivities ?? []) as string[];
  const taskNotes          = (entry.taskNotes          ?? "")  as string;


  let content: string;
  try {
    const unplannedLine = unplannedActivities.length > 0
      ? `Unplanned activities (requested by senior): ${unplannedActivities.join(", ")}`
      : "No unplanned activities";

    const raw = await quickComplete(
      "You write a warm, personal text message to a family member after their loved one's care visit.\n" +
        "Tone: warm and reassuring, like a trusted care coordinator. From Evia, not the caregiver.\n" +
        "Structure: 1) Start with the visit wrapping up and overall mood/meals. " +
        "2) Mention planned tasks completed with any notes. " +
        "3) If the senior asked for anything outside the plan, mention it clearly. " +
        "4) End with whether there are any concerns.\n" +
        "PRIVACY (important): summarize in everyday, non-clinical language. Do NOT include specific " +
        "medication names or dosages, lab values, or graphic bodily-function detail — refer to those only " +
        "in general terms (e.g. 'took medications as planned', 'ate well'). Frame any health note as either " +
        "reassuring (nothing unusual) or as something worth following up on, without clinical specifics.\n" +
        "Keep it to 4-5 sentences. No bullet points. No emoji. Output only the message text, no greeting or sign-off.",
      `Senior: ${seniorName}\n` +
        `Caregiver: ${cgFirstName}\n` +
        `Mood: ${mood || "not reported"}\n` +
        `Appetite: ${appetite || "not reported"}\n` +
        `Activities completed: ${activities.length > 0 ? activities.join(", ") : "not reported"}\n` +
        `Notes on completed tasks: ${taskNotes || "none"}\n` +
        `${unplannedLine}\n` +
        `Observations: ${observations || "none"}\n` +
        `Additional notes: ${notes || "none"}`,
      { maxTokens: 280 },
    );
    content = raw.trim();
    if (!content) throw new Error("empty");
  } catch {
    // PHI-safe fallback (U3): never reproduce raw clinical observations verbatim
    // over SMS — flag that there are notes for the family to follow up on instead.
    content = buildLayFallbackSummary({
      seniorName, cgFirstName, mood, appetite, activities, observations, unplannedActivities,
    });
  }

  const finalContent = hasFamilyGroup
    ? content
    : `${content}\n\nWant me to keep someone else updated too? Send me their name and phone.`;

  await sendViaInteractionAgent(clientPhone, {
    content: finalContent,
    urgency:     "standard",
    sourceAgent: "shift_end_family_update",
    canDrop:     true,
  });
  logAudit({
    eventType: "care_update_shared",
    userId: clientId,
    phone: clientPhone,
    data: {
      source: "shift_end_family_update",
      seniorId,
      deliveryTarget: hasFamilyGroup ? "family_group" : "primary_client",
      caregiverName,
      appointmentId: apptData?.id ?? apptData?.appointmentId ?? null,
    },
  }).catch(() => {});
  logAgentAction({
    actionType: "care_update_shared",
    status: "executed",
    userId: clientId,
    phone: clientPhone,
    role: "client",
    targetCollection: "care_journal",
    metadata: {
      seniorId,
      deliveryTarget: hasFamilyGroup ? "family_group" : "primary_client",
      source: "shift_end_family_update",
    },
  }).catch(() => {});
}

// ── Task acknowledgment handler ───────────────────────────────────────────────

async function handleTaskAck(
  phone:   string,
  chatId:  string,
  text:    string,
  session: AgentSession
): Promise<void> {
  const taskInfo = (session as any).awaitingTaskAck as {
    taskId:          string;
    taskDescription: string;
    taskCategory:    string;
    appointmentId:   string;
    clientId:        string;
    seniorId:        string;
    seniorName:      string;
  };


  // isQuestionOrOther check — CLAUDE.md requirement
  const questionRaw = await quickComplete(
    "Is this message a question or completely unrelated to completing a care task? " +
      "Reply only YES or NO.",
    text,
    { maxTokens: 5 },
  ).catch(() => "");

  const isQuestion = questionRaw.trim().toUpperCase().startsWith("Y");

  if (isQuestion) {
    // Let the normal caraAgent handle the question, then re-ask about the task
    await sendViaInteractionAgent(phone, {
      content:     text,
      urgency:     "standard",
      sourceAgent: "task_ack_question",
      canDrop:     true,
    });
    await sendMessage(chatId, `By the way — did you complete ${taskInfo.taskDescription}?`);
    return;
  }

  // Parse completion + any brief notes
  const ackRaw = await quickComplete(
    "Did the caregiver confirm completing the task? Also extract any brief notes about how it went. " +
      'Reply JSON only: {"completed":"YES"|"NO"|"UNCLEAR","notes":"brief detail or empty string"}',
    text,
    { maxTokens: 80 },
  ).catch(() => "{}");

  let completed = true; // default to trusting the caregiver
  let notes = "";
  try {
    const parsed = JSON.parse(ackRaw || "{}");
    completed = (parsed.completed ?? "YES") !== "NO";
    notes = ((parsed.notes ?? "") as string).trim();
  } catch { /* keep defaults */ }

  if (completed) {
    // Mark task done on appointment doc
    await db.collection("appointments").doc(taskInfo.appointmentId).update({
      completedTaskIds: admin.firestore.FieldValue.arrayUnion(taskInfo.taskId),
    }).catch(() => {});

    // Send family micro-update
    const clientPhone = await getClientPhoneByClientId(taskInfo.clientId);
    if (clientPhone) {
      sendFamilyTaskUpdate({
        taskDescription: taskInfo.taskDescription,
        taskCategory:    taskInfo.taskCategory,
        notes,
        clientId:    taskInfo.clientId,
        seniorId:    taskInfo.seniorId,
        clientPhone,
        caregiverId: session.caregiverId ?? "",
      }).catch(err => console.error("[handleTaskAck] sendFamilyTaskUpdate error:", err));
    }

    const ackMsg = await generateCaraMessage({
      audience: "caregiver",
      context: notes
        ? `The caregiver just confirmed completing "${taskInfo.taskDescription}" for ${taskInfo.seniorName} ` +
          `and added a brief note: "${notes}". Write a warm 1-sentence acknowledgment — thank them and ` +
          `mention you'll pass the update along to the family.`
        : `The caregiver just confirmed completing "${taskInfo.taskDescription}" for ${taskInfo.seniorName}. ` +
          `Write a warm, brief 1-sentence acknowledgment.`,
      fallback: notes ? `Got it — I'll let the family know!` : `Got it — great work!`,
      maxTokens: 60,
    });
    await sendMessage(chatId, ackMsg);
  } else {
    const notDoneMsg = await generateCaraMessage({
      audience: "caregiver",
      context: `The caregiver said they haven't completed "${taskInfo.taskDescription}" for ` +
        `${taskInfo.seniorName} yet. Write a gentle, understanding 1-sentence reply — ` +
        `no pressure, Evia will follow up with them again soon.`,
      fallback: `No worries — I'll check back with you soon!`,
      maxTokens: 60,
    });
    await sendMessage(chatId, notDoneMsg);
  }

  // Clear state
  await db.collection("agent_sessions").doc(phone).update({
    awaitingTaskAck: admin.firestore.FieldValue.delete(),
    stateExpiresAt:  admin.firestore.FieldValue.delete(),
  });
}

// ── Mid-shift check-in reply handler (in-shift family updates) ────────────────

// Shared core for both paths a mid-shift update can arrive on: a reply to
// Evia's check-in prompt, or a spontaneous caregiver text during the shift.
// Structures the note, persists it, relays to the family, updates counters,
// and acks the caregiver.
async function processInShiftUpdate(params: {
  phone:         string;
  chatId:        string;
  text:          string;
  session:       AgentSession;
  appointmentId: string;
  clientId:      string;
  seniorId:      string;
  seniorName:    string;
  question:      string;  // "" for unprompted updates
  topic:         string;
  prompted:      boolean;
}): Promise<void> {
  const { chatId, text, session, appointmentId, clientId, seniorId, seniorName, question, topic, prompted } = params;

  // Structure the free-text note into the wellness shape (feeds the data
  // flywheel). The LLM judges eating/activity directly — never keyword-match
  // the meaning of the caregiver's words (CLAUDE.md rule).
  const parsedRaw = await quickComplete(
    "Extract a brief structured snapshot from a caregiver's mid-shift note about the person they care for. " +
      'Reply JSON only: {"mood":"","ateWell":true|false|null,"wasActive":true|false|null,"note":"short lay summary","concern":true|false}. ' +
      "ateWell/wasActive: true or false only when the note actually speaks to eating or activity; null when it doesn't. " +
      "Set concern true only if something needs family/clinical follow-up.",
    text,
    { maxTokens: 120 },
  ).catch(() => "{}");

  let mood = "", note = "", concern = false;
  let ateWell: boolean | null = null, wasActive: boolean | null = null;
  try {
    const p = JSON.parse(parsedRaw || "{}");
    mood      = (p.mood ?? "").toString().trim();
    note      = (p.note ?? "").toString().trim();
    concern   = p.concern === true;
    ateWell   = typeof p.ateWell   === "boolean" ? p.ateWell   : null;
    wasActive = typeof p.wasActive === "boolean" ? p.wasActive : null;
  } catch { /* keep defaults */ }
  if (!note) note = text.trim().slice(0, 300);

  // Persist the snapshot to its own collection (kept separate from care_journal
  // so it never trips the shift-end journal's one-per-appointment dedup).
  await db.collection("in_shift_updates").add({
    appointmentId,
    caregiverId:   session.caregiverId ?? "",
    clientId,
    seniorId,
    timestamp:     new Date().toISOString(),
    question,
    topic,
    prompted,
    wellness: { mood, ateWell, wasActive },
    note,
    concern,
  }).catch(err => console.error("[processInShiftUpdate] persist error:", err));

  // A concern is a signal we must never store-and-ignore: surface it to ops
  // (low severity — the crisis keyword path handles true emergencies) and let
  // the family relay mention it calmly.
  if (concern) {
    db.collection("admin_alerts").add({
      type:          "in_shift_concern",
      severity:      "low",
      resolved:      false,
      caregiverId:   session.caregiverId ?? "",
      clientId,
      appointmentId,
      note:          note.slice(0, 300),
      dedupeKey:     `in_shift_concern:${appointmentId}:${new Date().toISOString().slice(0, 13)}`,
      createdAt:     new Date().toISOString(),
    }).catch(() => {});
  }

  // Quiet per-caregiver signal (non-punitive, feeds the 60-day badge decision).
  if (session.caregiverId) {
    db.collection("caregivers").doc(session.caregiverId).update({
      [`inShiftStats.${prompted ? "replies" : "unprompted"}`]: admin.firestore.FieldValue.increment(1),
    }).catch(() => {});
  }

  // Relay the substance to the family. The per-shift ceiling counts only real
  // deliveries — a suppressed/undeliverable relay must not burn a slot.
  const clientPhone = await getClientPhoneByClientId(clientId);
  let relayed = false;
  if (clientPhone) {
    relayed = await sendFamilyInShiftUpdate({
      note,
      topic,
      concern,
      seniorName,
      clientId,
      clientPhone,
      caregiverId: session.caregiverId ?? "",
    }).catch(err => {
      console.error("[processInShiftUpdate] sendFamilyInShiftUpdate error:", err);
      return false;
    });
  }
  await db.collection("appointments").doc(appointmentId).update({
    ...(relayed ? { inShiftFamilyUpdateCount: admin.firestore.FieldValue.increment(1) } : {}),
    // An unprompted update counts as the slot's update — push the next
    // scheduled prompt out a full cadence interval from now.
    ...(prompted ? {} : { inShiftLastPromptAt: new Date().toISOString() }),
    inShiftUnansweredCount: 0,
  }).catch(() => {});

  // Warm ack — buffer framing (Evia handles the family so the caregiver doesn't).
  const ackMsg = await generateCaraMessage({
    audience: "caregiver",
    context: `The caregiver just shared a mid-shift update about ${seniorName}: "${note}". ` +
      `Write a warm 1-sentence thank-you and mention you'll pass it along to the family so they don't have to check in.`,
    fallback: `Thanks — I'll let ${seniorName}'s family know. You've got this!`,
    maxTokens: 60,
  });
  await sendMessage(chatId, ackMsg);
}

// stateExpiresAt is SHARED across every awaiting/pending session flag. Deleting
// it while another flow's flag is still set makes that flow immortal (its expiry
// check treats a missing stateExpiresAt as never-expired) — so only the last
// flag standing may delete it.
export function otherStateFlagsActive(session: Record<string, unknown>, except: string): boolean {
  const FLAGS = [
    "awaitingCareNotes", "awaitingTaskAck", "awaitingLateMinutes", "awaitingIssueDescription",
    "awaitingInShiftUpdate", "pendingShiftConfirmation", "pendingClientShiftConfirm", "pendingCaregiverReferral",
  ];
  return FLAGS.some(f => f !== except && !!(session as any)[f]);
}

async function handleInShiftUpdateReply(
  phone:   string,
  chatId:  string,
  text:    string,
  session: AgentSession
): Promise<void> {
  const info = (session as any).awaitingInShiftUpdate as AwaitingInShiftUpdate;

  // isQuestionOrOther — answer a mid-flow question, then re-ask the check-in.
  const questionRaw = await quickComplete(
    "A caregiver was asked a quick check-in question about the person they're caring for. " +
      "Reply YES only if their message is itself a question to the assistant (not an answer). Only YES or NO.",
    text,
    { maxTokens: 5 },
  ).catch(() => "NO");
  if (questionRaw.trim().toUpperCase().startsWith("Y")) {
    await sendViaInteractionAgent(phone, {
      content:     text,
      urgency:     "standard",
      sourceAgent: "in_shift_update_question",
      canDrop:     true,
    });
    await sendMessage(chatId, info.question);
    return;
  }

  await processInShiftUpdate({
    phone, chatId, text, session,
    appointmentId: info.appointmentId,
    clientId:      info.clientId,
    seniorId:      info.seniorId,
    seniorName:    info.seniorName,
    question:      info.question,
    topic:         info.topic,
    prompted:      true,
  });

  await db.collection("agent_sessions").doc(phone).update({
    awaitingInShiftUpdate: admin.firestore.FieldValue.delete(),
    ...(otherStateFlagsActive(session as unknown as Record<string, unknown>, "awaitingInShiftUpdate")
      ? {} : { stateExpiresAt: admin.firestore.FieldValue.delete() }),
  });
}

// ── Unprompted mid-shift update passthrough ───────────────────────────────────
// A caregiver who texts a spontaneous status update during an in-progress visit
// ("Dorothy's napping, all good") gets the same relay treatment as a prompted
// reply — the check-in prompt is a fallback, not a toll gate. Called at the END
// of routeCaregiverMessage, after every keyword/state handler declined the
// message, so it can never shadow ARRIVED/DONE/LATE or an awaiting flow.
async function tryUnpromptedInShiftUpdate(
  phone:   string,
  chatId:  string,
  text:    string,
  session: AgentSession
): Promise<boolean> {
  if (!session.caregiverId) return false;
  if (!text || text.trim().length < 12) return false; // too short to be a real update

  // No date clause — UTC-vs-Pacific date rollover would hide evening shifts
  // (same reasoning as handleDone above).
  const apptSnap = await db.collection("appointments")
    .where("caregiverId", "==", session.caregiverId)
    .where("status",      "==", "in-progress")
    .limit(1).get();
  if (apptSnap.empty) return false;
  const apptDoc = apptSnap.docs[0];
  const appt = apptDoc.data();
  if (appt.completedAt) return false;

  const verdict = await quickComplete(
    "A caregiver is mid-visit with an elderly client. Is their message a spontaneous status update about " +
      "how the client or the visit is going (mood, meals, activities, sleeping, general wellbeing)? " +
      "Reply YES only for a status update suitable to pass along to the client's family. " +
      "Reply NO for questions, requests, scheduling/payment topics, complaints, anything about family members, " +
      "interpersonal conflict, the caregiver's own situation, or anything needing an answer. Only YES or NO.",
    text,
    { maxTokens: 5 },
  ).catch(() => "NO");
  if (!verdict.trim().toUpperCase().startsWith("Y")) return false;

  const clientId = (appt.clientId ?? "") as string;
  await processInShiftUpdate({
    phone, chatId, text, session,
    appointmentId: apptDoc.id,
    clientId,
    seniorId:      (appt.seniorId ?? clientId) as string,
    seniorName:    ((appt.clientName ?? appt.seniorName ?? "your client") as string).split(" ")[0],
    question:      "",
    topic:         "unprompted",
    prompted:      false,
  });
  return true;
}

// ── Caregiver voice/text → structured journal ─────────────────────────────────

async function handleCareNotes(
  phone:    string,
  chatId:   string,
  text:     string,
  session:  AgentSession
): Promise<void> {

  // ── isQuestionOrOther — if caregiver is asking a question alongside (or
  // instead of) shift notes, answer it first then re-prompt. Skip the LLM
  // hop for short messages that look like a clear answer (< 30 chars).
  if (text.trim().length >= 30) {
    const questionRaw = await quickComplete(
      "A caregiver was asked to share notes about a care visit they just finished " +
        "(mood, meals, activities, anything notable). " +
        "Reply YES if their message is primarily a question to the assistant rather than visit notes. " +
        "Reply NO if it is visit notes (even if a small question is buried inside). Only reply YES or NO.",
      text,
      { maxTokens: 5 },
    ).catch(() => "NO");
    if (questionRaw.trim().toUpperCase().startsWith("Y")) {
      let answer = "";
      try {
        answer = await answerHumanQuestionOnly({
          audience: "caregiver",
          situation: "caregiver finished a shift and was asked for visit notes but asked a question instead",
          text,
          maxTokens: 180,
        });
      } catch { answer = "I do not want to guess on that."; }
      await sendMessage(chatId, answer);
      await sendMessage(chatId, "Now — tell me how the visit went so I can send the family an update. (Mood, meals, activities, anything notable.)");
      return;
    }
  }

  const structuredRaw = await quickComplete(
    "Convert this caregiver note into a structured care journal entry. " +
      'Reply in JSON: {"overallWellness":1,"mood":"happy|neutral|agitated|confused|tired",' +
      '"appetite":"good|fair|poor|refused","activities":[],"medications":[],' +
      '"observations":"","notes":"","unplannedActivities":[],"taskNotes":""}',
    text,
    { maxTokens: 300 },
  ).catch(() => "{}");

  let entry: Record<string, unknown> = {};
  try {
    entry = JSON.parse(structuredRaw || "{}");
  } catch { entry = { notes: text }; }

  const apptId = (session as any).careNotesApptId ?? "";
  const caregiverId = session.caregiverId ?? "";

  // Get clientId from appointment and re-validate status
  let clientId = "";
  let seniorId = "";
  if (apptId) {
    const apptSnap = await db.collection("appointments").doc(apptId).get();
    const apptData = apptSnap.data();
    clientId = apptData?.clientId ?? "";
    seniorId = apptData?.seniorId ?? clientId;

    // Re-validate: only write notes if appointment was actually in progress or just completed
    const validStatuses = ["in-progress", "completed", "confirmed"];
    if (apptData && !validStatuses.includes(apptData.status ?? "")) {
      await db.collection("agent_sessions").doc(phone).update({ awaitingCareNotes: false, careNotesApptId: "" });
      const cancelledNotesMsg = await generateCaraMessage({
        audience: "caregiver",
        context: "Caregiver submitted care notes but the visit was cancelled so notes cannot be saved. Let them know apologetically.",
        fallback: "I wasn't able to save those notes — it looks like that visit was cancelled.",
        maxTokens: 80,
      });
      await sendMessage(chatId, cancelledNotesMsg);
      return;
    }

    // Dedup + write in a single transaction to prevent duplicate journal entries if
    // two requests race (e.g. duplicate webhook delivery or fast caregiver retap).
    let alreadyExists = false;
    const journalRef  = db.collection("care_journal").doc();
    const sessionRef  = db.collection("agent_sessions").doc(phone);

    await db.runTransaction(async (t) => {
      const existingSnap = await t.get(
        db.collection("care_journal")
          .where("appointmentId", "==", apptId)
          .limit(1)
      );
      if (!existingSnap.empty) {
        alreadyExists = true;
        return;
      }
      t.set(journalRef, {
        caregiverId,
        clientId,
        seniorId,
        appointmentId: apptId,
        timestamp:     new Date().toISOString(),
        notes:         entry.notes ?? text,
        wellness: {
          ateWell:   entry.appetite === "good",
          tookMeds:  Array.isArray(entry.medications) && (entry.medications as unknown[]).length > 0,
          wasActive: Array.isArray(entry.activities)  && (entry.activities  as unknown[]).length > 0,
          mood:      entry.mood ?? "neutral",
        },
        activities:    entry.activities ?? [],
        observations:  entry.observations ?? "",
      });
      t.update(sessionRef, { awaitingCareNotes: false, careNotesApptId: "" });
    });

    if (alreadyExists) {
      await db.collection("agent_sessions").doc(phone).update({ awaitingCareNotes: false, careNotesApptId: "" });
      const notesAlreadySavedMsg = await generateCaraMessage({
        audience: "caregiver",
        context: "Caregiver tried to submit notes but notes for this visit are already saved. Let them know briefly.",
        fallback: "Notes for this visit are already saved.",
        maxTokens: 60,
      });
      await sendMessage(chatId, notesAlreadySavedMsg);
      return;
    }
  } else {
    // No apptId — write without dedup guard and clear flag
    await db.collection("care_journal").add({
      caregiverId,
      clientId,
      seniorId,
      appointmentId: apptId,
      timestamp:     new Date().toISOString(),
      notes:         entry.notes ?? text,
      wellness: {
        ateWell:   entry.appetite === "good",
        tookMeds:  Array.isArray(entry.medications) && (entry.medications as unknown[]).length > 0,
        wasActive: Array.isArray(entry.activities)  && (entry.activities  as unknown[]).length > 0,
        mood:      entry.mood ?? "neutral",
      },
      activities:    entry.activities ?? [],
      observations:  entry.observations ?? "",
    });
    await db.collection("agent_sessions").doc(phone).update({ awaitingCareNotes: false, careNotesApptId: "" });
  }

  const cgSnap    = await db.collection("caregivers").doc(caregiverId).get();
  const hourlyRate = cgSnap.data()?.hourlyRate ?? 20;

  const apptSnap = apptId
    ? await db.collection("appointments").doc(apptId).get()
    : null;
  const durationHours = apptSnap?.data()?.durationHours ?? 4;
  const cgName = cgSnap.data()?.name ?? "Your caregiver";

  // Fire shift-end family update (fire-and-forget — alreadyExists early-returns above, so if we
  // reach here the journal entry was newly written)
  if (apptId && clientId) {
    sendFamilyShiftEndUpdate({
      caregiverName: cgName,
      clientId,
      seniorId,
      apptData:      apptSnap?.data() ?? null,
      entry,
    }).catch(err => console.error("[handleCareNotes] family update error:", err));
  }

  // Submit the completed visit into the real payment rail: create a shiftHours
  // doc (pending_client_review) and ask the family to APPROVE. On approval,
  // routeClient → approveShiftHoursForClient flips it to "approved", which fires
  // the onShiftHoursApproved trigger to charge the client (incl. the 1.5%
  // platform fee) and transfer net pay to the caregiver's Connect account.
  // Idempotent on appointmentId so it never double-bills if hours were already
  // submitted (e.g. via the MCP submit_shift_hours tool).
  //
  // NOTE: this replaces the old createVisitPayment call, which created a Stripe
  // PaymentIntent with confirm:false that was never confirmed — so visits
  // completed over SMS were never actually charged and no fee was taken.
  let billingSubmitted = false;   // the visit is in the shiftHours rail (will be paid)
  let familyNotified = false;      // the family was actually pinged to APPROVE
  const grossPay = Math.round(hourlyRate * durationHours * 100) / 100;
  if (apptId && clientId && grossPay > 0) {
    const shiftRef = db.collection("shiftHours").doc(apptId);
    const submittedAt = new Date().toISOString();
    const apptDate = (apptSnap?.data()?.date as string) ?? submittedAt.slice(0, 10);
    // Resolve the billing rail from the appointment's paymentMethod. Guard the
    // type explicitly: String() coercion of a non-string (object/number/bool)
    // would silently yield "[object Object]"/"123" and route to "credit"
    // without signal. Treat any non-string as the credit default, but log it.
    const rawPaymentMethod = apptSnap?.data()?.paymentMethod;
    if (rawPaymentMethod != null && typeof rawPaymentMethod !== "string") {
      console.warn("[handleCareNotes] unexpected paymentMethod type on appointment", { apptId, type: typeof rawPaymentMethod });
    }
    const { normalizePaymentMethod } = await import("../billing/paymentMethods");
    const paymentMethod = normalizePaymentMethod(rawPaymentMethod);
    let created = false;
    try {
      // create() is atomic: it fails (ALREADY_EXISTS) if the doc already exists,
      // closing the get-then-set race where two concurrent submissions could both
      // pass an existence check and the second overwrite the first (re-firing side
      // effects). Mirrors the transactional care_journal dedup above.
      await shiftRef.create({
        id: apptId, appointmentId: apptId, shiftId: apptId,
        caregiverId, caregiverName: cgName,
        clientId, clientName: (apptSnap?.data()?.clientName ?? apptSnap?.data()?.seniorName ?? "Client"),
        payRate: hourlyRate, hourlyRate, currency: "usd",
        paymentMethod,
        submittedTotalHours: durationHours, finalTotalHours: durationHours, durationHours,
        basePay: grossPay, grossPay, amountCents: Math.round(grossPay * 100),
        date: apptDate, status: "pending_client_review", submittedAt,
        autoApproveAt: autoApproveAtIso(),
        paymentAttemptCount: 0, createdAt: submittedAt, updatedAt: submittedAt,
      });
      created = true;
      billingSubmitted = true;
      logAgentAction({
        actionType: "shift_hours_submitted",
        status: "executed",
        userId: caregiverId,
        phone,
        role: "caregiver",
        targetCollection: "shiftHours",
        targetDocId: apptId,
        metadata: { clientId, grossPay, durationHours, source: "care_notes_completion" },
      }).catch(() => {});
    } catch (err: any) {
      // ALREADY_EXISTS (gRPC code 6): hours were already submitted for this visit
      // (e.g. via the MCP submit_shift_hours tool) — it's in the rail, not an error.
      if (err?.code === 6 || /already exists/i.test(err?.message ?? "")) {
        billingSubmitted = true;
      } else {
        console.error("[handleCareNotes] shiftHours create error:", err);
      }
    }

    // Prompt the family over SMS (handled by routeClient's pendingShiftApproval
    // flow). Only on a fresh create — if the doc already existed the first
    // submitter already notified them. Mark familyNotified only on real success.
    if (created) {
      const clientPhone = await getClientPhoneByClientId(clientId);
      if (clientPhone) {
        try {
          await db.collection("agent_sessions").doc(clientPhone).set({
            pendingShiftApproval:      { appointmentId: apptId, amount: grossPay.toFixed(2), caregiverName: cgName },
            pendingShiftApprovalSetAt: submittedAt,
          }, { merge: true });
          await sendViaInteractionAgent(clientPhone, {
            content:
              `${cgName} just finished the visit on ${apptDate} (${durationHours}h, $${grossPay.toFixed(2)}).\n\n` +
              `Reply APPROVE to confirm and release payment, or DISPUTE if something looks off.`,
            urgency:     "standard",
            sourceAgent: "visit_completion",
            canDrop:     false,
          });
          familyNotified = true;
          logAgentAction({
            actionType: "shift_hours_approval_prompt",
            status: "executed",
            userId: clientId,
            phone: clientPhone,
            role: "client",
            targetCollection: "shiftHours",
            targetDocId: apptId,
            metadata: { caregiverId, grossPay, source: "care_notes_completion" },
          }).catch(() => {});
        } catch (notifyErr) {
          console.error("[handleCareNotes] family approval notification failed:", notifyErr);
          await db.collection("admin_alerts").add({
            type: "shift_hours_approval_notification_failed",
            severity: "high",
            appointmentId: apptId,
            caregiverId,
            clientId,
            clientPhone,
            createdAt: new Date().toISOString(),
            resolved: false,
            error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
          }).catch(() => {});
          logAgentAction({
            actionType: "shift_hours_approval_prompt",
            status: "failed",
            userId: clientId,
            phone: clientPhone,
            role: "client",
            targetCollection: "shiftHours",
            targetDocId: apptId,
            errorReason: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
            metadata: { caregiverId, grossPay, source: "care_notes_completion" },
          }).catch(() => {});
        }
      } else {
        console.error("[handleCareNotes] no client phone found to request shift approval", { clientId, apptId });
        await db.collection("admin_alerts").add({
          type: "shift_hours_approval_notification_failed",
          severity: "high",
          appointmentId: apptId,
          caregiverId,
          clientId,
          createdAt: new Date().toISOString(),
          resolved: false,
          error: "no_client_phone",
        }).catch(() => {});
      }
    }
  }

  // Find next appointment for this caregiver. Pacific tomorrow, not UTC —
  // caregivers submit shift notes in the PT evening, when the UTC date has
  // already rolled and UTC "tomorrow" skips right past tomorrow's visit
  // ("No upcoming visits scheduled yet." with one confirmed for tomorrow).
  const nextSnap = await db.collection("appointments")
    .where("caregiverId", "==", caregiverId)
    .where("date",        ">=", businessTomorrowStr())
    .where("status",      "in", ["confirmed"])
    .orderBy("date", "asc").limit(1).get();

  const nextLine = nextSnap.empty
    ? "No upcoming visits scheduled yet."
    : `Next visit: ${nextSnap.docs[0].data().date} at ${nextSnap.docs[0].data().startTime ?? ""}`;

  const paymentLine = !billingSubmitted
    ? `Thanks for the update.`
    : familyNotified
      ? `I've sent your hours to the family to confirm — you'll be paid once they approve (auto-approves in ${TIMESHEET_AUTO_APPROVE_HOURS}h if they don't reply).`
      : `Your hours are recorded — you'll be paid once they're approved (auto-approves in ${TIMESHEET_AUTO_APPROVE_HOURS}h).`;

  await sendMessage(chatId,
    `Got it — notes saved.\n\n` +
    `${paymentLine}\n` +
    `${nextLine}\n\n` +
    `Have a great rest of your day.`
  );
}

// ── Caregiver inbound routing — extracted verbatim from webhooks.ts handleInbound ──
// Returns "handled" when the message was fully handled (handleInbound must return),
// or "fallthrough" when no caregiver path matched (handleInbound continues).
export async function routeCaregiverMessage(ctx: CaregiverRouteContext): Promise<"handled" | "fallthrough"> {
  const { phone, chatId, text, norm, session } = ctx;

    // ── Shift offer YES/NO — new bookings, client swaps, time changes ─────────
    // Appointments only become confirmed (or change caregiver/time) after the
    // caregiver accepts; see agents/shiftOffer.ts. A question falls through so
    // the QA agent can answer it while the offer stays pending.
    if ((session as any).pendingShiftOfferId) {
      const { handleShiftOfferReply } = await import("../agents/shiftOffer");
      const offerOutcome = await handleShiftOfferReply({ phone, chatId, text }).catch((err) => {
        console.error("handleInbound: handleShiftOfferReply failed", err);
        return "fallthrough" as const;
      });
      if (offerOutcome === "handled") return "handled";
    }

    // ── Swap acceptance/decline — when another caregiver was asked to cover ──
    // Stale shift-swap requests (> 4h old) shouldn't hijack unrelated caregiver
    // messages weeks later. Clear the lingering field on stale state.
    if ((session as any).pendingSwapRequestId) {
      const swapSetAt   = (session as any).pendingSwapSetAt as string | undefined;
      const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
      if (swapSetAt && swapSetAt < fourHoursAgo) {
        await db.collection("agent_sessions").doc(phone).update({
          pendingSwapRequestId: admin.firestore.FieldValue.delete(),
          pendingSwapFromName:  admin.firestore.FieldValue.delete(),
          pendingSwapSetAt:     admin.firestore.FieldValue.delete(),
        }).catch(() => {});
        (session as any).pendingSwapRequestId = undefined;
      }
    }
    if ((session as any).pendingSwapRequestId) {
      const swapRequestId  = (session as any).pendingSwapRequestId as string;
      const fromName       = (session as any).pendingSwapFromName as string ?? "A caregiver";
      const swapRaw = await quickComplete(
        "The caregiver is responding to a shift-swap request. " +
          "Reply ACCEPT if they agree to cover the shift. " +
          "Reply DECLINE if they refuse. " +
          "Reply UNSURE if it is unclear. " +
          "Reply with exactly one word.",
        text,
        { maxTokens: 10 },
      ).catch(() => "");
      const swapDecision = swapRaw.trim().toUpperCase();

      if (swapDecision === "ACCEPT") {
        const cgName = session.caregiverId
          ? (await db.collection("caregivers").doc(session.caregiverId).get()).data()?.name ?? "Caregiver"
          : "Caregiver";
        await db.collection("agent_sessions").doc(phone).update({
          pendingSwapRequestId: admin.firestore.FieldValue.delete(),
          pendingSwapFromName:  admin.firestore.FieldValue.delete(),
        });
        if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
        try {
          await handleSwapAcceptance(session.caregiverId ?? phone, cgName, swapRequestId, chatId);
        } finally {
          if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
        }
        return "handled";
      }

      if (swapDecision === "DECLINE") {
        await db.collection("shift_swap_requests").doc(swapRequestId).update({
          candidateResponses: admin.firestore.FieldValue.arrayUnion({
            caregiverId: session.caregiverId ?? phone,
            response:    "declined",
            at:          new Date().toISOString(),
          }),
        }).catch(() => {});
        await db.collection("agent_sessions").doc(phone).update({
          pendingSwapRequestId: admin.firestore.FieldValue.delete(),
          pendingSwapFromName:  admin.firestore.FieldValue.delete(),
        });
        const swapDeclineMsg = await generateCaraMessage({
          audience: "caregiver",
          context: `Caregiver declined a shift swap request from ${fromName}. Evia is acknowledging the decline and thanking them for letting the coordinator know.`,
          fallback: `No problem — thanks for letting ${fromName}'s coordinator know!`,
          maxTokens: 60,
        });
        await sendMessage(chatId, swapDeclineMsg);
        return "handled";
      }
      // UNSURE — fall through to normal routing so Claude can answer the message
    }

    const pendingReferral = (session as any).pendingCaregiverReferral as PendingCaregiverReferral | undefined;
    if (pendingReferral) {
      const referralExpiry = (session as any).stateExpiresAt as string | undefined;
      if (referralExpiry && new Date(referralExpiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({
          pendingCaregiverReferral: admin.firestore.FieldValue.delete(),
          stateExpiresAt: admin.firestore.FieldValue.delete(),
        }).catch(() => {});
      } else {
        if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
        try {
          await handleCaregiverReferral(phone, chatId, text, session, pendingReferral);
        } finally {
          if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
        }
        return "handled";
      }
    }

    if (await isCaregiverReferralIntent(text, norm)) {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        await handleCaregiverReferral(phone, chatId, text, session);
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
      return "handled";
    }

    const KEYWORDS: Record<string, () => Promise<void>> = {
      ARRIVED:    () => handleArrived(phone, chatId, session),
      DONE:       () => handleDone(phone, chatId, session, text),
      LATE:       () => handleRunningLate(phone, chatId),
      ISSUE:      () => handleIssue(phone, chatId),
      CONFIRM:    async () => {
        // Find most recent appointment for this caregiver not yet confirmed
        const now = new Date().toISOString();
        const apptSnap = await db.collection("appointments")
          .where("caregiverId", "==", session.caregiverId ?? "")
          .where("status",      "==", "confirmed")
          .where("caregiverConfirmed", "!=", true)
          .orderBy("caregiverConfirmed")
          .orderBy("date", "asc")
          .limit(1).get();
        if (!apptSnap.empty) {
          const appt = apptSnap.docs[0].data();
          const updateFields: Record<string, unknown> = { caregiverConfirmed: true, caregiverConfirmedAt: now };
          // Mark check-in confirmed so escalation guard skips it
          if (appt.caregiverCheckInSent) {
            updateFields.caregiverCheckInConfirmed = true;
            updateFields.caregiverCheckInAt        = now;
          }
          await apptSnap.docs[0].ref.update(updateFields);
          // Notify family
          const familySnap = await db.collection("agent_sessions").doc(appt.clientId ?? appt.clientPhone).get();
          if (familySnap.exists) {
            await sendMessage(familySnap.data()!.chatId,
              `${appt.caregiverName ?? "Your caregiver"} confirmed the visit on ${appt.date}. You're all set.`
            );
          }
          await sendMessage(chatId, "Confirmed! See you then. 👍");
        } else {
          await sendMessage(chatId, "Got it — confirmed! 👍");
        }
      },
      RESCHEDULE: async () => {
        await db.collection("agent_sessions").doc(phone).update({
          caregiverRescheduling: true,
          stateExpiresAt:        new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        const rescheduleMsg = await generateCaraMessage({
          audience: "caregiver",
          context: "Caregiver wants to reschedule a visit. Evia is asking them to suggest 2–3 times that work and will relay them to the family.",
          fallback: "No problem — text me 2–3 times that work for you and I'll let the family know right away.",
          maxTokens: 80,
        });
        await sendMessage(chatId, rescheduleMsg);
      },
      PASS:       async () => {
        await handleCaregiverAvailabilityReply(phone, session.caregiverId ?? "", "", chatId, "PASS");
      },
      PAYOUT:     async () => {
        if (!session.caregiverId) {
          await sendMessage(chatId, "I couldn't find your caregiver profile. Send the email you used to sign up and I'll try again.");
          return;
        }
        const { startInstantPayout } = await import("../agents/instantPayoutHandler");
        await startInstantPayout(session.caregiverId, phone, chatId);
      },
      REACTIVATE: async () => {
        if (!session.caregiverId) return;
        await handleCaregiverProfileUpdate(
          session.caregiverId,
          phone,
          text,
          session as unknown as Record<string, unknown>,
          chatId,
          "reactivate",
        );
      },
    };

    if (norm in KEYWORDS) {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {/* non-critical */});
      try { await KEYWORDS[norm](); } finally { if (session.service === "iMessage") await stopTyping(chatId).catch(() => {}); }
      return "handled";
    }

    // YES / NO to replacement candidate request
    if (norm === "YES" || norm === "NO") {
      const candidateSnap = await db.collection("replacement_candidates")
        .where("phone",  "==", phone)
        .where("status", "==", "contacted")
        .orderBy("contactedAt", "desc")
        .limit(1)
        .get();

      if (!candidateSnap.empty) {
        const candidate = candidateSnap.docs[0].data();
        const taskSnap  = await db.collection("agent_tasks").doc(candidate.taskId).get();
        const task      = taskSnap.data();

        if (task && task.status === "awaiting_approval") {
          if (norm === "YES") {
            await candidateSnap.docs[0].ref.update({ status: "available", respondedAt: new Date().toISOString() });
            const jobConfirmMsg = await generateCaraMessage({
              audience: "caregiver",
              context: "Caregiver indicated availability for a job. Evia will confirm with the family and follow up shortly.",
              fallback: "Got it — we'll confirm with the family and follow up shortly.",
              maxTokens: 60,
            });
            await sendMessage(chatId, jobConfirmMsg);
          } else {
            await candidateSnap.docs[0].ref.update({ status: "declined", respondedAt: new Date().toISOString() });
            const jobDeclineMsg = await generateCaraMessage({
              audience: "caregiver",
              context: "Caregiver declined a job offer. Evia is acknowledging gracefully.",
              fallback: "No worries — thanks for letting us know!",
              maxTokens: 60,
            });
            await sendMessage(chatId, jobDeclineMsg);
          }
          return "handled";
        }
      }
    }

    // Day-before shift confirmation reply
    if ((session as any).pendingShiftConfirmation) {
      const scExpiry = (session as any).stateExpiresAt as string | undefined;
      if (scExpiry && new Date(scExpiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({
          pendingShiftConfirmation: admin.firestore.FieldValue.delete(),
          stateExpiresAt:           admin.firestore.FieldValue.delete(),
        }).catch(() => {});
        // fall through to normal routing
      } else {
        await handleShiftConfirmation(phone, chatId, text, session);
        return "handled";
      }
    }

    // Day-before CLIENT shift confirmation reply (CONFIRM / CANCEL / question)
    if ((session as any).pendingClientShiftConfirm) {
      const csExpiry = (session as any).stateExpiresAt as string | undefined;
      if (csExpiry && new Date(csExpiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({
          pendingClientShiftConfirm: admin.firestore.FieldValue.delete(),
          stateExpiresAt:            admin.firestore.FieldValue.delete(),
        }).catch(() => {});
        // fall through to normal routing
      } else {
        const { handleClientShiftConfirm } = await import("../agents/clientShiftConfirmHandler");
        await handleClientShiftConfirm(phone, chatId, text, session as unknown as Record<string, unknown>);
        return "handled";
      }
    }

    // Awaiting task acknowledgment after a mid-shift nudge
    if ((session as any).awaitingTaskAck) {
      const taskAckExpiry = (session as any).stateExpiresAt as string | undefined;
      if (taskAckExpiry && new Date(taskAckExpiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({
          awaitingTaskAck: admin.firestore.FieldValue.delete(),
          stateExpiresAt:  admin.firestore.FieldValue.delete(),
        }).catch(() => {});
      } else {
        await handleTaskAck(phone, chatId, text, session);
        return "handled";
      }
    }

    // Awaiting care notes after DONE. Checked BEFORE the mid-shift check-in flag:
    // if both are somehow set, the shift-end journal always wins (handleDone also
    // clears awaitingInShiftUpdate, so coexistence is a defensive case only).
    if ((session as any).awaitingCareNotes) {
      const cnExpiry = (session as any).stateExpiresAt as string | undefined;
      if (cnExpiry && new Date(cnExpiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({ awaitingCareNotes: false, stateExpiresAt: admin.firestore.FieldValue.delete() }).catch(() => {});
      } else {
        await handleCareNotes(phone, chatId, text, session);
        return "handled";
      }
    }

    // Awaiting a mid-shift check-in reply (in-shift family updates)
    if ((session as any).awaitingInShiftUpdate) {
      const isuExpiry = (session as any).stateExpiresAt as string | undefined;
      if (isuExpiry && new Date(isuExpiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({
          awaitingInShiftUpdate: admin.firestore.FieldValue.delete(),
          stateExpiresAt:        admin.firestore.FieldValue.delete(),
        }).catch(() => {});
      } else {
        await handleInShiftUpdateReply(phone, chatId, text, session);
        return "handled";
      }
    }

    // Awaiting late minutes
    if ((session as any).awaitingLateMinutes) {
      const lmExpiry = (session as any).stateExpiresAt as string | undefined;
      if (lmExpiry && new Date(lmExpiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({ awaitingLateMinutes: false, stateExpiresAt: admin.firestore.FieldValue.delete() }).catch(() => {});
        // fall through to normal message processing
      } else {
        await db.collection("agent_sessions").doc(phone).update({ awaitingLateMinutes: false });
        const today2 = new Date().toISOString().slice(0, 10);
        const lateApptSnap = await db.collection("appointments")
          .where("caregiverId", "==", session.caregiverId ?? "")
          .where("date",        "==", today2).limit(1).get();
        const clientPhone = lateApptSnap.empty ? null : await getClientPhoneForAppt(lateApptSnap.docs[0].data());

        // Record lateness event
        if (!lateApptSnap.empty && session.caregiverId) {
          const lateApptData = lateApptSnap.docs[0].data();
          const minutesLateNum = parseInt(text.replace(/\D/g, ""), 10);
          if (!isNaN(minutesLateNum) && minutesLateNum > 0) {
            const cgSnap2 = await db.collection("caregivers").doc(session.caregiverId).get();
            const cgName2 = cgSnap2.data()?.name ?? "Unknown";
            const { recordLatenessEvent, checkLatenessPattern } = await import("../agents/latenessTracker");
            recordLatenessEvent({
              caregiverId:   session.caregiverId,
              caregiverName: cgName2,
              appointmentId: lateApptSnap.docs[0].id,
              clientId:      lateApptData.clientId ?? "",
              date:          today2,
              scheduledTime: (lateApptData.startTime ?? "").slice(0, 5),
              minutesLate:   minutesLateNum,
              selfReported:  true,
            }).catch(() => {});
            checkLatenessPattern(session.caregiverId, cgName2).catch(() => {});
          }
        }

        if (clientPhone) {
          const cgSnap = session.caregiverId
            ? await db.collection("caregivers").doc(session.caregiverId).get()
            : null;
          const cgName    = cgSnap?.data()?.name ?? "Your caregiver";
          const origTime  = lateApptSnap.empty ? "" : ` (originally ${lateApptSnap.docs[0].data().startTime})`;
          await sendIfNotDND(clientPhone, {
            content:     `${cgName} is running about ${text} late. They're on their way${origTime}.`,
            urgency:     "immediate",
            sourceAgent: "late_notification",
            canDrop:     false,
          }, "high");
        }
        const driveMsg = await generateCaraMessage({
          audience: "caregiver",
          context: "Caregiver said how late they'll be and Evia has already notified the family. Send a brief acknowledgment and wish them a safe drive.",
          fallback: "I've notified the family. Drive safe.",
          maxTokens: 60,
        });
        await sendMessage(chatId, driveMsg);
        return "handled";
      }
    }

    // Awaiting issue description — smart classification + multi-level escalation
    if ((session as any).awaitingIssueDescription) {
      const idExpiry = (session as any).stateExpiresAt as string | undefined;
      if (idExpiry && new Date(idExpiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({ awaitingIssueDescription: false, stateExpiresAt: admin.firestore.FieldValue.delete() }).catch(() => {});
        // fall through to normal message processing
      } else {
      await db.collection("agent_sessions").doc(phone).update({ awaitingIssueDescription: false });

      const issueToday = new Date().toISOString().slice(0, 10);
      const issueApptSnap = await db.collection("appointments")
        .where("caregiverId", "==", session.caregiverId ?? "")
        .where("date",        "==", issueToday)
        .where("status",      "in", ["confirmed", "in-progress"])
        .limit(1).get();
      const issueAppt = issueApptSnap.empty ? null : issueApptSnap.docs[0].data();
      const clientPhone = issueApptSnap.empty ? null : await getClientPhoneForAppt(issueAppt!);

      const cgSnap      = session.caregiverId
        ? await db.collection("caregivers").doc(session.caregiverId).get()
        : null;
      const cgName       = cgSnap?.data()?.name ?? "Your caregiver";
      const seniorId     = issueAppt?.seniorId ?? issueAppt?.clientId ?? "";
      const seniorSnap   = seniorId ? await db.collection("senior_profiles").doc(seniorId).get() : null;
      const seniorName   = seniorSnap?.data()?.name ?? (issueAppt as any)?.clientName ?? "your client";

      const { handleCaregiverIssue } = await import("../agents/issueEscalator");
      await handleCaregiverIssue({
        caregiverId:    session.caregiverId ?? phone,
        caregiverPhone: phone,
        caregiverName:  cgName,
        appointmentId:  issueApptSnap.empty ? "" : issueApptSnap.docs[0].id,
        clientId:       issueAppt?.clientId ?? "",
        clientPhone:    clientPhone ?? "",
        seniorId,
        seniorName,
        description:    text,
      }).catch(async (err) => {
        console.error("handleCaregiverIssue failed:", err);
        // Fallback: write plain admin alert
        await db.collection("admin_alerts").add({
          type:        "caregiver_issue",
          caregiverId: session.caregiverId ?? phone,
          phone, description: text, severity: "medium",
          createdAt: new Date().toISOString(), resolved: false,
        });
      });

      const issueFlaggedMsg = await generateCaraMessage({
        audience: "caregiver",
        context: "Caregiver reported an issue during a visit. Evia has escalated it to the team and notified the family. Thank them for letting Evia know.",
        fallback: "I've flagged this for our team and notified the family. Thank you for letting me know.",
        maxTokens: 80,
      });
      await sendMessage(chatId, issueFlaggedMsg);
      return "handled";
      } // end stateExpiresAt else
    }

    // Awaiting issue closure check (sent 20h after an ISSUE was filed)
    if ((session as any).awaitingIssueClosureCheck) {
      const issueLogId = (session as any).awaitingIssueClosureCheck as string;
      await db.collection("agent_sessions").doc(phone).update({
        awaitingIssueClosureCheck: admin.firestore.FieldValue.delete(),
      });
      const normReply = text.trim().toUpperCase();
      if (normReply === "YES" || normReply.startsWith("YES")) {
        await db.collection("issue_log").doc(issueLogId).update({
          resolvedAt: new Date().toISOString(),
        }).catch(() => {});
        const issueResolvedMsg = await generateCaraMessage({
          audience: "caregiver",
          context: "Caregiver confirmed the issue from a prior visit is resolved. Evia is glad to hear it and wraps up the check-in.",
          fallback: "Good to hear — glad everything's okay.",
          maxTokens: 60,
        });
        await sendMessage(chatId, issueResolvedMsg);
      } else {
        const issueUpdateMsg = await generateCaraMessage({
          audience: "caregiver",
          context: "Caregiver gave an update on an ongoing issue rather than confirming it's resolved. Evia acknowledges the update and notes it.",
          fallback: "Thanks for the update — I've noted it. Let me know if anything changes.",
          maxTokens: 60,
        });
        await sendMessage(chatId, issueUpdateMsg);
      }
      return "handled";
    }

    // ── Wellbeing check-in response: "4 3 5" style reply ──────────────────────
    // Only fires if the message is ONLY three numbers separated by whitespace
    // — otherwise "I'm 32, need help 3 mornings" used to hijack this handler.
    // Also gated to 7 days of staleness from when the check-in was sent.
    if ((session as any).pendingWellbeingCheckin) {
      const sentAtIso = (session as any).wellbeingCheckinSentAt as string | undefined;
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const isFresh = !sentAtIso || sentAtIso > sevenDaysAgo;
      const trimmed = text.trim();
      const isPureRatingReply = /^[1-5](?:\s+[1-5]){2}$/.test(trimmed);

      if (!isFresh) {
        await db.collection("agent_sessions").doc(phone).update({
          pendingWellbeingCheckin: admin.firestore.FieldValue.delete(),
          wellbeingCheckinSentAt:  admin.firestore.FieldValue.delete(),
        }).catch(() => {});
        (session as any).pendingWellbeingCheckin = undefined;
      } else if (!isPureRatingReply) {
        // Don't hijack — message isn't a rating answer. Fall through.
      } else {
        const parts = trimmed.split(/\s+/).map(Number).filter(n => !isNaN(n) && n >= 1 && n <= 5);
        if (parts.length === 3) {
          const [energy, stress, satisfaction] = parts;
          await db.collection("wellbeing_checkins").add({
            caregiverId: session.caregiverId ?? session.userId ?? phone,
            phone,
            energy,
            stress,
            satisfaction,
            recordedAt: new Date().toISOString(),
          });
          await db.collection("agent_sessions").doc(phone).update({
            pendingWellbeingCheckin: admin.firestore.FieldValue.delete(),
            wellbeingCheckinSentAt:  admin.firestore.FieldValue.delete(),
          });
          const avg = (energy + stress + satisfaction) / 3;
          const reply = avg < 3
            ? `Thank you for being honest 💙 Your scores tell me you might need some support. Would you like to:\n\n1. Adjust your schedule\n2. Talk to our support team\n3. Get info on mental health resources\n\nReply 1, 2, or 3 — or just ignore this if you're okay.`
            : `Checked in. Sounds like things are going well — your clients are in good hands.`;
          await sendMessage(chatId, reply);
          return "handled";
        }
      }
    }

    // Caregiver rescheduling — parse new times and notify family
    if ((session as any).caregiverRescheduling) {
      let timeList: string[] = [];
      try {
        const parsedRaw = await quickComplete(
          "Extract interview time proposals from this message as a JSON array of human-readable strings. " +
            "Reply with only a JSON array, e.g. [\"Tuesday 2pm\",\"Wednesday 10am\"]. Keep them short.",
          text,
          { maxTokens: 100 },
        );
        timeList = JSON.parse(parsedRaw || "[]") as string[];
      } catch { /* fall through — use raw text below */ }
      const timesText = timeList.length > 0 ? timeList.join(", ") : text;

      // Find the relevant interview request
      const caregiverId = session.caregiverId ?? "";
      const cgSnap      = caregiverId ? await db.collection("caregivers").doc(caregiverId).get() : null;
      const cgName      = cgSnap?.data()?.name ?? "Your caregiver";
      const reqSnap     = await db.collection("interview_requests")
        .where("caregiverId", "==", caregiverId)
        .where("status",      "in", ["scheduled", "awaiting_client_confirmation"])
        .orderBy("createdAt", "desc").limit(1).get();

      if (!reqSnap.empty) {
        const reqData       = reqSnap.docs[0].data();
        const familyPhone   = reqData.clientPhone as string;
        const familySession = await db.collection("agent_sessions").doc(familyPhone).get();
        if (familySession.exists) {
          await sendMessage(familySession.data()!.chatId,
            `${cgName} needs to reschedule the interview.\n\n` +
            `They're available: ${timesText}\n\n` +
            `Reply with which time works, or PASS to find someone new.`
          );
          // Let family's next reply be handled as a time selection
          await db.collection("agent_sessions").doc(familyPhone).update({
            pendingTimeSelection: { interviewRequestId: reqSnap.docs[0].id, caregiverName: cgName },
            stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          });
        }
        await reqSnap.docs[0].ref.update({ status: "awaiting_client_confirmation", caregiverAvailability: timeList });
      }

      // Clear the flag only after the family has been notified successfully
      await db.collection("agent_sessions").doc(phone).update({ caregiverRescheduling: admin.firestore.FieldValue.delete() });
      await sendMessage(chatId, "Got it — I've sent those times to the family. I'll let you know once they confirm.");
      return "handled";
    }

    // Caregiver availability reply (for interview scheduling)
    if ((session as any).pendingInterviewAvailabilityRequest) {
      await handleCaregiverAvailabilityReply(
        phone,
        session.caregiverId ?? "",
        "",
        chatId,
        text
      );
      return "handled";
    }

    // ── Job alert: YES/NO/natural-language response ────────────────────────
    if ((session as any).awaitingJobResponse === true) {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try { await handleJobResponse(phone, text, chatId, session as any); }
      finally { if (session.service === "iMessage") await stopTyping(chatId).catch(() => {}); }
      return "handled";
    }

    // ── Job alert: availability confirmation (any text) ─────────────────────
    if ((session as any).awaitingAvailabilityConfirmation === true) {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try { await handleAvailabilityConfirmation(phone, text, chatId, session as any); }
      finally { if (session.service === "iMessage") await stopTyping(chatId).catch(() => {}); }
      return "handled";
    }

    // ── Caregiver shift swap — multi-step state machine ───────────────────
    if ((session as any).swapStep) {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        const cgDoc = session.caregiverId
          ? await db.collection("caregivers").doc(session.caregiverId).get()
          : null;
        await handleCaregiverSwapRequest(
          session.caregiverId ?? phone,
          cgDoc?.data()?.name ?? "Caregiver",
          phone,
          text,
          session as unknown as Record<string, unknown>,
          chatId
        );
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
      return "handled";
    }

    // ── Caregiver-initiated shift cancellation — multi-step state machine ─
    if ((session as any).cancelStep) {
      const expiry = (session as any).stateExpiresAt as string | undefined;
      if (expiry && new Date(expiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({
          cancelStep:          admin.firestore.FieldValue.delete(),
          cancelCandidates:    admin.firestore.FieldValue.delete(),
          cancelShiftId:       admin.firestore.FieldValue.delete(),
          cancelShiftDate:     admin.firestore.FieldValue.delete(),
          cancelShiftClientId: admin.firestore.FieldValue.delete(),
          stateExpiresAt:      admin.firestore.FieldValue.delete(),
        }).catch(() => {});
      } else {
        if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
        try {
          const cgDoc = session.caregiverId
            ? await db.collection("caregivers").doc(session.caregiverId).get()
            : null;
          await handleCaregiverCancelShift(
            session.caregiverId ?? phone,
            cgDoc?.data()?.name ?? "Caregiver",
            phone,
            text,
            session as unknown as Record<string, unknown>,
            chatId,
          );
        } finally {
          if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
        }
        return "handled";
      }
    }

    // ── Profile update flow (rate / skills / bio / photo / pause / reactivate)
    if ((session as any).profileUpdateStep) {
      const expiry = (session as any).stateExpiresAt as string | undefined;
      if (expiry && new Date(expiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({
          profileUpdateStep:  admin.firestore.FieldValue.delete(),
          profileUpdateField: admin.firestore.FieldValue.delete(),
          profileUpdateValue: admin.firestore.FieldValue.delete(),
          stateExpiresAt:     admin.firestore.FieldValue.delete(),
        }).catch(() => {});
      } else if (session.caregiverId) {
        if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
        try {
          await handleCaregiverProfileUpdate(
            session.caregiverId,
            phone,
            text,
            session as unknown as Record<string, unknown>,
            chatId,
          );
        } finally {
          if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
        }
        return "handled";
      }
    }

    // ── PAYOUT instant-payout YES/NO confirmation ──────────────────────────
    if ((session as any).pendingInstantPayoutConfirm) {
      const setAt = (session as any).pendingInstantPayoutConfirm as string;
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      if (setAt < tenMinAgo) {
        await db.collection("agent_sessions").doc(phone).update({
          pendingInstantPayoutConfirm: admin.firestore.FieldValue.delete(),
          pendingInstantPayoutAmount:  admin.firestore.FieldValue.delete(),
        }).catch(() => {});
      } else {
        const { handleInstantPayoutConfirm } = await import("../agents/instantPayoutHandler");
        await handleInstantPayoutConfirm(
          session.caregiverId ?? phone,
          phone,
          text,
          chatId,
        );
        return "handled";
      }
    }

    // ── Caregiver NLU fallback — handle natural-language keyword variants ──
    // Runs only when no exact keyword matched and no state machine is active.
    // Catches "I just arrived", "I'm done now", "running about 10 min late", etc.
    {
      const nluRaw = await quickComplete(
        "Classify this caregiver message as one of: ARRIVED, DONE, LATE, ISSUE, CONFIRM, RESCHEDULE, NONE. " +
          "ARRIVED = caregiver arrived at or is entering a care visit. " +
          "DONE = caregiver has finished a care visit. " +
          "LATE = caregiver is running late to a visit. " +
          "ISSUE = caregiver is reporting a problem or concern during a visit. " +
          "CONFIRM = caregiver is confirming an upcoming appointment. " +
          "RESCHEDULE = caregiver wants to change the time of an appointment. " +
          "NONE = does not fit any of the above. " +
          "Reply with exactly one word.",
        text,
        { maxTokens: 15 },
      ).catch(() => "");
      const nluAction = nluRaw.trim().toUpperCase();
      if (nluAction in KEYWORDS) {
        if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
        try { await KEYWORDS[nluAction](); } finally { if (session.service === "iMessage") await stopTyping(chatId).catch(() => {}); }
        return "handled";
      }
    }

    // ── Unprompted mid-shift update passthrough ──────────────────────────────
    // Last caregiver-specific check before general routing: a spontaneous
    // status text during an in-progress visit relays to the family like a
    // prompted check-in reply would. Every keyword/NLU/state handler above
    // (incl. ISSUE) already declined this message.
    try {
      if (await tryUnpromptedInShiftUpdate(phone, chatId, text, session)) return "handled";
    } catch (err) {
      console.error("[routeCaregiverMessage] unprompted in-shift check failed:", err);
    }

  return "fallthrough";
}
