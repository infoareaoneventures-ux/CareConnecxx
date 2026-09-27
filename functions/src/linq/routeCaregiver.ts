import * as admin from "firebase-admin";
import { sendMessage, startTyping, stopTyping, AgentSession } from "./client";
import { quickComplete } from "../utils/openaiClient";
import { generateCaraMessage } from "../utils/caraMessage";
import { sendIfNotDND } from "../utils/dndGuard";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { handleCaregiverCancelShift } from "../agents/caregiverCancelShiftHandler";
import { handleCaregiverProfileUpdate } from "../agents/caregiverProfileHandler";
import { logAudit } from "../observability/auditLog";
import { logAgentAction } from "../observability/actionLedger";
import {
  createCaregiverReferralInvite,
  normalizeCaregiverReferralPhone,
  resolveCaregiverReferralName,
} from "../agents/caregiverReferral";
import { answerHumanQuestionOnly } from "../agents/humanReply";
import { businessTodayStr, businessTomorrowStr, parseScheduledTimeMs, formatDateForDisplay, formatHHMMForDisplay } from "../utils/scheduledTime";
import { buildLayFallbackSummary } from "./shiftSummaryFallback";
import { bookedWindowMillis, createValidatedShiftHours } from "../billing/createValidatedShiftHours";
import { getVisitDoc } from "../utils/visitQuery";

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
    "Does this caregiver's message EXPLICITLY express intent to refer, invite, or recommend ANOTHER person " +
      "to become an Evia caregiver (e.g. \"I want to refer my friend\", \"can I invite someone\")? " +
      "A bare acknowledgment like \"yes\", \"no\", \"ok\", \"sure\", or \"sounds good\" is NOT referral intent — " +
      "it is an answer to some earlier question, so reply NO. " +
      "Reply YES only when the message itself names or clearly describes bringing in another person. " +
      "Reply only YES or NO.",
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

  // Dual-lookup — dayBeforeShiftReminder.ts/thirtyMinShiftReminder.ts stamp
  // this pending-confirmation flag for visits in either appointments (old
  // bookings) or shifts (new ones from the 2026-08-30 pipeline).
  const visitSnap = await getVisitDoc(info.appointmentId);

  if (decision === "CONFIRM") {
    await visitSnap.ref.update({
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
          // R11: who-is-who attribution — care belongs to the recipient, not the reader.
          `The reader is the family member coordinating care; the care recipient is ${info.seniorName}. ` +
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
    await visitSnap.ref.update({
      caregiverDayBeforeCancelled:   true,
      caregiverDayBeforeCancelledAt: new Date().toISOString(),
    });

    const cancelMsg = await generateCaraMessage({
      audience: "caregiver",
      context:
        `${cgFirstName} just let you know they can't make ${info.seniorName}'s shift on ${displayDate}. ` +
        `Write a brief, understanding response — acknowledge the situation without judgment and ` +
        `let them know the family will be notified. Do NOT promise to find coverage or a replacement. ` +
        `Be warm, not cold.`,
      fallback:
        `Understood, ${cgFirstName} — I'll let the family know about ${displayDate}. ` +
        `I appreciate you letting me know ahead of time.`,
    });
    await sendMessage(chatId, cancelMsg);

    // 2026-09-16: replaced the legacy "I'm already working on finding
    // coverage" alert + runEmergencyReplacement (an Evia-only process the
    // site never had). A caregiver who can't make it does on the website
    // what its Cancel button does: within 24h of start the visit becomes
    // needs_replacement (the family sees Find Replacement / Skip), further
    // out it's simply cancelled. onShiftStatusChanged (notificationTriggers.ts)
    // then texts + notifies the family — no manual family send here.
    if (visitSnap.exists && visitSnap.ref.parent.id === "shifts") {
      const shift = visitSnap.data() ?? {};
      const shiftStart = String(shift.startTime ?? "");
      const isUrgent = shift.date && shiftStart
        ? (parseScheduledTimeMs(`${shift.date}T${shiftStart.slice(0, 5)}:00`) - Date.now()) / (1000 * 60 * 60) <= 24
        : false;
      await visitSnap.ref.update({
        status:             isUrgent ? "needs_replacement" : "cancelled",
        cancelledBy:        "caregiver",
        cancelledAt:        new Date().toISOString(),
        cancellationReason: "Declined the day-before confirmation",
      });
      logAudit({
        eventType: "shift_cancelled", userId: session.caregiverId ?? phone,
        data: { source: "dayBeforeConfirmation", shiftId: visitSnap.id, isUrgent },
      }).catch(() => {});
    } else {
      // Legacy appointments doc — nothing on the site cancels these anymore.
      // Tell the family plainly, with no promise of automatic coverage.
      const clientPhone = await getClientPhoneByClientId(info.clientId);
      if (clientPhone) {
        await sendViaInteractionAgent(clientPhone, {
          content:
            `Heads up — ${cgFirstName} let me know they can't make ${info.seniorName}'s visit on ${displayDate}` +
            `${info.startTime ? " at " + info.startTime : ""}. You can find a new caregiver from your My Bookings page, or text me and I'll help.`,
          urgency:     "immediate",
          sourceAgent: "shift_confirm_family_update",
          canDrop:     false,
        });
      }
    }
  } else {
    // QUESTION or unclear — answer the question, then re-ask the confirmation.
    // Generate the answer inline so we control message ordering (otherwise the
    // re-ask can land before the interaction agent's reply).
    let answer = "";
    try {
      answer = await answerHumanQuestionOnly({
        audience: "caregiver",
        situation: `caregiver was asked to confirm ${info.seniorName}'s shift on ${formatDateForDisplay(info.appointmentDate)} at ${formatHHMMForDisplay(info.startTime)}`,
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
      `So — can you confirm you'll be at ${info.seniorName}'s shift on ${formatDateForDisplay(info.appointmentDate)}? A quick yes or no is all I need.`
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

  // Load care plan (same read order as shiftTaskNudges: CANONICAL
  // care_plans/{clientId} first — web cutover 2026-07-12 — then legacy subdocs)
  let dailyRoutine: Array<{ id: string; time: string; description: string; category: string }> = [];
  let medications:  Array<{ name: string; dosage: string; frequency: string }> = [];

  const canonicalSnap = await db.collection("care_plans").doc(clientId).get().catch(() => null);
  if (canonicalSnap?.exists) {
    const d = canonicalSnap.data()!;
    dailyRoutine = (d.dailyRoutine ?? []) as typeof dailyRoutine;
    medications  = (d.medications  ?? []) as typeof medications;
  }
  if (!dailyRoutine.length && !medications.length) {
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

  const lines = sorted.map(t => `• ${formatHHMMForDisplay(t.time)} — ${t.description}`);

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

  // Store that we're awaiting care notes.
  await db.collection("agent_sessions").doc(phone).update({
    awaitingCareNotes:    true,
    careNotesApptId:      snap.empty ? "" : snap.docs[0].id,
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

  await sendViaInteractionAgent(clientPhone, {
    content,
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
      deliveryTarget: "primary_client",
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
      deliveryTarget: "primary_client",
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

// stateExpiresAt is SHARED across every awaiting/pending session flag. Deleting
// it while another flow's flag is still set makes that flow immortal (its expiry
// check treats a missing stateExpiresAt as never-expired) — so only the last
// flag standing may delete it.
export function otherStateFlagsActive(session: Record<string, unknown>, except: string): boolean {
  const FLAGS = [
    "awaitingCareNotes", "awaitingTaskAck", "awaitingLateMinutes", "awaitingIssueDescription",
    "pendingShiftConfirmation", "pendingCaregiverReferral",
  ];
  return FLAGS.some(f => f !== except && !!(session as any)[f]);
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
    const appointmentRef = db.collection("appointments").doc(apptId);
    const apptSnap = await appointmentRef.get();
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
      const completedAt = new Date().toISOString();
      t.update(appointmentRef, { status: "completed", completedAt, updatedAt: completedAt });
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
  // the onShiftHoursApproved trigger to charge the client (incl. the 9%
  // platform fee) and transfer net pay to the caregiver's Connect account.
  // Idempotent on appointmentId so it never double-bills if hours were already
  // submitted (e.g. via the MCP submit_shift_hours tool).
  //
  // NOTE: this replaces the old createVisitPayment call, which created a Stripe
  // PaymentIntent with confirm:false that was never confirmed — so visits
  // completed over SMS were never actually charged and no fee was taken.
  let billingSubmitted = false;   // the visit is in the shiftHours rail (will be paid)
  let billingNeedsAdminReview = false;
  let grossPay = Math.round(hourlyRate * durationHours * 100) / 100;
  if (apptId && clientId && grossPay > 0) {
    try {
      const bookedWindow = bookedWindowMillis(apptSnap?.data() ?? {});
      if (!bookedWindow) throw new Error("appointment_has_no_canonical_booked_window");
      const result = await createValidatedShiftHours({
        appointmentId: apptId,
        actorUid: caregiverId,
        submittedStartTime: new Date(bookedWindow.start).toISOString(),
        submittedEndTime: new Date(bookedWindow.end).toISOString(),
        source: "care_note",
      });
      billingSubmitted = true;
      billingNeedsAdminReview = result.status === "requires_admin_review";
      grossPay = result.grossPayCents / 100;

      // The durable approval outbox owns family notification and delivery state.
    } catch (err) {
      console.error("[handleCareNotes] validated shiftHours create error:", err);
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

  const safePaymentLine = billingNeedsAdminReview
    ? `Your hours are recorded and are waiting for Evia's billing team to review them.`
    : billingSubmitted
      ? `Your hours are recorded - the family approval request is queued.`
      : `Thanks for the update.`;

  await sendMessage(chatId,
    `Got it — notes saved.\n\n` +
    `${safePaymentLine}\n` +
    `${nextLine}\n\n` +
    `Have a great rest of your day.`
  );
}

// ── Caregiver inbound routing — extracted verbatim from webhooks.ts handleInbound ──
// Returns "handled" when the message was fully handled (handleInbound must return),
// or "fallthrough" when no caregiver path matched (handleInbound continues).
export async function routeCaregiverMessage(ctx: CaregiverRouteContext): Promise<"handled" | "fallthrough"> {
  const { phone, chatId, text, norm, session } = ctx;

    // ── Shift offer YES/NO — new bookings, time changes ───────────────────────
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

    // (The texted job-invite yes/no state machine that used to own every reply
    // here for 48h was removed 2026-09-27 — the website has no such flow.)

    // ── Jobs page forms as scripted flows (caregiverJobFlows.ts) ─────────────
    // The Apply modal and the interview Propose-new-time form, one question per
    // turn, back-out at any step, Submit/Send or Cancel at the end — checked
    // before any keyword/NLU so a short answer like "9/28 at 9am" is the
    // flow's answer, not something else's.
    for (const flow of ["applyFlowStep", "interviewRescheduleFlowStep"] as const) {
      if (!(session as any)[flow]) continue;
      const dataKey = flow === "applyFlowStep" ? "applyFlowData" : "interviewRescheduleFlowData";
      const expiry = (session as any).stateExpiresAt as string | undefined;
      if (expiry && new Date(expiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({
          [flow]: admin.firestore.FieldValue.delete(), [dataKey]: admin.firestore.FieldValue.delete(), stateExpiresAt: admin.firestore.FieldValue.delete(),
        }).catch(() => {});
        await sendMessage(chatId, "That timed out — nothing was sent. Text me anytime to start again.");
        return "handled";
      }
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        const flows = await import("../agents/caregiverJobFlows");
        if (flow === "applyFlowStep") await flows.handleApplyFlowStep(phone, chatId, text, session);
        else await flows.handleInterviewRescheduleFlowStep(phone, chatId, text, session);
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
      return "handled";
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
      // (CONFIRM keyword/NLU removed 2026-09-27: it wrote the legacy appointments
      // collection the site has no button for, and swallowed interview replies
      // like "9/28 at 9am" with "Got it — confirmed!" before the agent saw them.
      // A booking request is accepted with respond_to_booking_request, an
      // interview with respond_to_interview_request — exactly the site's buttons.)
      // (RESCHEDULE and PASS keyword acks removed 2026-09-27: they wrote
      // nothing and told the caregiver times were "sent" / a request was
      // "passed" on. Moving an interview or a visit is a real tool call now —
      // reschedule_interview / manage_shift_reschedule — and declining a
      // request is respond_to_interview_request, exactly like the site.)
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

    // Awaiting care notes after DONE.
    if ((session as any).awaitingCareNotes) {
      const cnExpiry = (session as any).stateExpiresAt as string | undefined;
      if (cnExpiry && new Date(cnExpiry) < new Date()) {
        await db.collection("agent_sessions").doc(phone).update({ awaitingCareNotes: false, stateExpiresAt: admin.firestore.FieldValue.delete() }).catch(() => {});
      } else {
        await handleCareNotes(phone, chatId, text, session);
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
        const today2 = businessTodayStr();
        const lateApptSnap = await db.collection("appointments")
          .where("caregiverId", "==", session.caregiverId ?? "")
          .where("date",        "==", today2).limit(1).get();
        const clientPhone = lateApptSnap.empty ? null : await getClientPhoneForAppt(lateApptSnap.docs[0].data());


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

      const issueToday = businessTodayStr();
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

    // Caregiver rescheduling — parse new times and acknowledge.
    // 2026-09-09: this used to look up a live interview_requests doc (status
    // scheduled/awaiting_client_confirmation) to actually relay the caregiver's
    // times to the family — but nothing has created such a doc since
    // schedule_interview/video_interviews became the only interview path
    // (2026-09-07), so reqSnap was always empty and that branch was already
    // dead. The unconditional ack below is exactly what always ran regardless;
    // removing the dead query changes no observable behavior.
    // A legacy caregiverRescheduling flag (the removed RESCHEDULE ack) no
    // longer owns the next text — clear it and route normally.
    if ((session as any).caregiverRescheduling) {
      await db.collection("agent_sessions").doc(phone).update({ caregiverRescheduling: admin.firestore.FieldValue.delete() }).catch(() => {});
    }

    // (Removed 2026-07-15: a pendingInterviewAvailabilityRequest consumer sat
    // here, but NOTHING in production sets that flag — only a test seeded it.
    // A flag with no setter and no expiry was one hijack away from consuming
    // every inbound text.)

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
        "Classify this caregiver message as one of: ARRIVED, DONE, LATE, ISSUE, NONE. " +
          "ARRIVED = caregiver arrived at or is entering a care visit. " +
          "DONE = caregiver has finished a care visit. " +
          "LATE = caregiver is running late to a visit. " +
          "ISSUE = caregiver is reporting a problem happening during a care visit (with the senior, the home, safety, or the tasks). " +
          "NOT an ISSUE: correcting something Evia said, disagreeing with a status (background check, payment, application, profile), " +
          "or asking about their own account — those are NONE. " +
          "NONE = does not fit any of the above. " +
          "Reply with exactly one word.",
        text,
        { maxTokens: 15 },
      ).catch(() => "");
      const nluAction = nluRaw.trim().toUpperCase();
      // 2026-07-22 incident: "No my background check is cleared already" (a
      // correction) classified as ISSUE and parked the session asking "what
      // happened during the visit?" — the caregiver had never had a visit.
      // Deterministic guard: an NLU-inferred ISSUE requires a visit TODAY
      // (in-progress or confirmed) to be plausible; otherwise fall through to
      // normal routing so the QA agent answers. The explicit "ISSUE" keyword
      // (typed deliberately) keeps its direct path above.
      let nluDispatch = nluAction;
      if (nluAction === "ISSUE") {
        const today = businessTodayStr();
        const todayVisit = await db.collection("appointments")
          .where("caregiverId", "==", session.caregiverId ?? "")
          .where("date", ">=", today)
          .where("date", "<=", today)
          .where("status", "in", ["in-progress", "confirmed"])
          .orderBy("date", "asc")
          .limit(1).get().catch(() => null);
        if (!todayVisit || todayVisit.empty) {
          console.info("[routeCaregiverMessage] NLU ISSUE suppressed — no visit today", { phone });
          nluDispatch = "NONE";
        }
      }
      if (nluDispatch in KEYWORDS) {
        if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
        try { await KEYWORDS[nluDispatch](); } finally { if (session.service === "iMessage") await stopTyping(chatId).catch(() => {}); }
        return "handled";
      }
    }

  return "fallthrough";
}
