import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { parseScheduledTimeMs, businessTodayStr, slotHourKey, apptSlotHourKey } from "../utils/scheduledTime";
import { sendMessage, getOrCreateSession, AgentSession } from "../linq/client";
import { writeFeedbackSignal } from "../ai/feedback";
import { generateCaraMessage } from "../utils/caraMessage";

import { getPermissions } from "./permissionsConversation";
import { notifyAdminInterviewScheduled } from "../notifications";
import { createInterviewCallAssets } from "./interviewLinks";
import { scheduleTrigger } from "../triggers/triggerEngine";

const db = admin.firestore();

// ── Parse caregiver selection from family text ────────────────────────────────

async function parseSelection(text: string, matchCount: number): Promise<number[]> {
  const norm  = text.trim().toLowerCase();
  if (norm === "all") return Array.from({ length: matchCount }, (_, i) => i + 1);

  const result = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 30,
    system:
      `The user is selecting from a numbered list of ${matchCount} caregivers. ` +
      "Reply with only a JSON array of the numbers they selected, e.g. [1] or [1,3]. Nothing else.",
    messages: [{ role: "user", content: text }],
  });
  try {
    const arr = JSON.parse((result.content[0] as { text: string }).text ?? "[]") as number[];
    return arr.filter((n) => n >= 1 && n <= matchCount);
  } catch {
    return [];
  }
}

// ── Parse caregiver availability from text ────────────────────────────────────

async function parseAvailability(text: string): Promise<string[]> {
  const result = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system:
      "Extract interview time proposals from this message as an array of ISO datetime strings. " +
      "Assume the current year. Reply with only a JSON array, e.g. [\"2026-05-15T14:00:00\"].",
    messages: [{ role: "user", content: text }],
  });
  try {
    return JSON.parse((result.content[0] as { text: string }).text ?? "[]") as string[];
  } catch {
    return [];
  }
}

// ── Cross-check proposed times against client's existing confirmed appointments ─

async function findMutualTime(proposedTimes: string[], clientPhone: string): Promise<string | null> {
  if (proposedTimes.length === 0) return null;

  // Load the client's confirmed upcoming appointments
  const sessSnap  = await db.collection("agent_sessions").doc(clientPhone).get();
  const clientId: string | undefined = sessSnap.data()?.userId;
  if (!clientId) return proposedTimes[0];

  // Pacific business date — the UTC date is already tomorrow during PT evening
  // hours, which would drop today's remaining appointments from the busy set.
  const today = businessTodayStr();
  const apptSnap = await db.collection("appointments")
    .where("clientId", "==", clientId)
    .where("status", "in", ["confirmed", "pending"])
    .where("date", ">=", today)
    .get();

  // Build set of busy hours as "YYYY-MM-DDTHH" strings. Both sides MUST go
  // through the shared Pacific slot-key helpers: stored `time` is PT wall-clock
  // ("2:00 PM"), while proposals arrive as ISO strings — keying one side via
  // toISOString()/getHours() (UTC on Cloud Functions) shifted the buckets 7-8h
  // apart, so no conflict was ever detected and families got double-booked.
  const busy = new Set<string>();
  for (const d of apptSnap.docs) {
    const a = d.data();
    const key = apptSlotHourKey(a.date, a.time);
    if (key) busy.add(key);
  }

  for (const iso of proposedTimes) {
    const ms = parseScheduledTimeMs(iso);
    if (!Number.isFinite(ms)) continue;
    if (!busy.has(slotHourKey(ms))) return iso;
  }

  // All proposed times conflict with the family's calendar — signal "no mutual
  // time" (U8) so the caller can ask the caregiver for different times instead
  // of booking the family into a known conflict.
  return null;
}

// ── Handle family selecting caregivers for interview ─────────────────────────

export async function handleInterviewSelection(
  phone:   string,
  chatId:  string,
  text:    string,
  session: AgentSession
): Promise<void> {
  const matches: Array<{ id: string; name: string; rate: number }> =
    (session as any).pendingMatches ?? [];

  if (matches.length === 0) {
    const noMatchesMsg = await generateCaraMessage({
      audience: "family",
      context:  "The family asked to select a caregiver for an interview, but there are no pending matches in the system right now. Let them know you'll search again and text them shortly.",
      fallback: "I don't have any pending matches right now. Let me search again — I'll text you shortly.",
      maxTokens: 80,
    });
    await sendMessage(chatId, noMatchesMsg);
    return;
  }

  const selected = await parseSelection(text, matches.length);
  if (selected.length === 0) {
    await sendMessage(chatId, "I didn't catch which caregivers you'd like to interview. Reply with the number(s) — e.g. \"1\" or \"1 and 2\".");
    return;
  }

  // Check permission to contact caregivers on family's behalf
  const perms = await getPermissions(session.userId ?? phone).catch(() => null);
  if (perms && !perms.canContactCaregivers) {
    const permissionMsg = await generateCaraMessage({
      audience: "family",
      context:  "The family wants to reach out to caregivers for an interview, but Evia doesn't yet have their permission to contact caregivers on their behalf. Ask them to reply ALLOW to grant permission, or visit the app to update their settings.",
      fallback: "I need your permission to reach out to caregivers on your behalf.\n\nReply ALLOW to give me permission, or visit the app to update your settings.",
      maxTokens: 80,
    });
    await sendMessage(chatId, permissionMsg);
    return;
  }

  // Get senior name for context
  const intakeSnap = await db.collection("clientIntakes")
    .where("phone", "==", phone).orderBy("createdAt", "desc").limit(1).get();
  const intake   = intakeSnap.empty ? {} : intakeSnap.docs[0].data();
  const seniorName  = (intake.seniorName ?? "your loved one") as string;
  const relationship = (intake.relationship ?? "family") as string;
  const age         = intake.age ?? "";

  for (const idx of selected) {
    const match = matches[idx - 1];
    if (!match) continue;

    // Create interview request doc
    await db.collection("interview_requests").add({
      clientPhone:    phone,
      caregiverId:    match.id,
      caregiverName:  match.name,
      status:         "awaiting_caregiver_availability",
      seniorName,
      relationship,
      age,
      createdAt:      new Date().toISOString(),
      expiresAt:      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    // Text the caregiver
    const caregiverSnap = await db.collection("caregivers").doc(match.id).get();
    const caregiverPhone = caregiverSnap.data()?.phone as string | undefined;
    if (!caregiverPhone) continue;

    const caregiverSession = await getOrCreateSession(caregiverPhone, { caregiverId: match.id });
    const caregiverReachOutMsg = await generateCaraMessage({
      audience: "caregiver",
      context:  `Introduce yourself as Evia, the care coordinator, and let ${match.name} know that a family is interested in meeting them for a care position. The senior is ${seniorName}, who is a ${relationship}${age ? ` and is ${age} years old` : ""}. Ask if they're available for a 20-minute video call this week. Tell them to reply with 2–3 times that work, or PASS to decline.`,
      fallback: `Hi ${match.name} — I'm Evia, your care coordinator.\n\nA family is interested in meeting you for a care position for their ${relationship}, ${age ? `${age}-year-old ` : ""}${seniorName}.\n\nAre you available for a 20-minute video call this week?\n\nReply with 2–3 times that work for you, or PASS to decline.`,
    });
    await sendMessage(caregiverSession.chatId, caregiverReachOutMsg);
  }

  const reachedOutMsg = await generateCaraMessage({
    audience: "family",
    context:  `Evia just contacted ${selected.length} ${selected.length === 1 ? "caregiver" : "caregivers"} on the family's behalf. Let them know and say you'll text as soon as you hear back with availability.`,
    fallback: `I've reached out to ${selected.length === 1 ? "that caregiver" : "those caregivers"} on your behalf.\n\nI'll text you as soon as I hear back with their availability.`,
    maxTokens: 80,
  });
  await sendMessage(chatId, reachedOutMsg);
}

// ── Handle caregiver replying with availability ───────────────────────────────

export async function handleCaregiverAvailabilityReply(
  caregiverPhone: string,
  caregiverId:    string,
  caregiverName:  string,
  chatId:         string,
  text:           string
): Promise<void> {
  if (text.trim().toUpperCase() === "PASS") {
    // Find the pending interview request and mark declined
    const snap = await db.collection("interview_requests")
      .where("caregiverId", "==", caregiverId)
      .where("status", "==", "awaiting_caregiver_availability")
      .orderBy("createdAt", "desc").limit(1).get();

    if (!snap.empty) {
      const doc    = snap.docs[0];
      const reqData = doc.data();
      await doc.ref.update({ status: "caregiver_declined" });

      // Notify the family + add caregiver to rejection list
      const familySnap = await db.collection("agent_sessions")
        .where("phone", "==", reqData.clientPhone).limit(1).get();
      if (!familySnap.empty) {
        const familySession = familySnap.docs[0].data();
        const caregiverUnavailableMsg = await generateCaraMessage({
          audience: "family",
          context:  `${caregiverName} just declined the interview and isn't available. Tell the family briefly — they don't need to do anything; you're already moving on to the next best match.`,
          fallback: `${caregiverName} isn't available for the interview right now — I'm finding the next best match for you.`,
          maxTokens: 80,
        });
        await sendMessage(familySession.chatId, caregiverUnavailableMsg);
        // Clear the pending interview confirmation and remember this caregiver was declined
        await db.collection("agent_sessions").doc(reqData.clientPhone).update({
          pendingInterviewConfirm:  admin.firestore.FieldValue.delete(),
          rejectedCaregiverIds: admin.firestore.FieldValue.arrayUnion(caregiverId),
        });
        // Auto-advance (U8): once this request is terminal, kick off matching
        // for the next-best caregiver automatically instead of waiting for the
        // family to reply YES. No-ops if another interview request is still
        // active, and it owns the "searching for fresh options" message.
        const { checkAndTriggerRematching } = await import("../triggers/triggerEngine");
        await checkAndTriggerRematching(reqData.clientPhone, caregiverId).catch(() => {});
      }
    }
    const caregiverDeclinedAckMsg = await generateCaraMessage({
      audience: "caregiver",
      context:  "The caregiver just declined an interview request by replying PASS. Acknowledge their decision warmly and let them know you'll pass the message to the family.",
      fallback: "No problem — I'll let the family know.",
      maxTokens: 80,
    });
    await sendMessage(chatId, caregiverDeclinedAckMsg);
    return;
  }

  const proposedTimes = await parseAvailability(text);
  if (proposedTimes.length === 0) {
    await sendMessage(chatId,
      "I didn't quite catch those times. Could you share 2–3 times that work for you this week? " +
      "(e.g. \"Tuesday 2pm, Wednesday 10am, Thursday 3pm\")"
    );
    return;
  }

  // Update interview request with caregiver availability
  const snap = await db.collection("interview_requests")
    .where("caregiverId", "==", caregiverId)
    .where("status", "==", "awaiting_caregiver_availability")
    .orderBy("createdAt", "desc").limit(1).get();

  if (snap.empty) {
    // Request expired or already filled — let the caregiver know and close gracefully
    const expiredMsg = await generateCaraMessage({
      audience: "caregiver",
      context:  "The caregiver sent in their availability, but the interview request they were responding to has already been filled or has expired. Let them know gracefully and tell them you'll reach out when there's a new opening that fits their availability.",
      fallback: "That interview request has already been filled or expired. I'll reach out when there's a new opening that fits your availability.",
      maxTokens: 80,
    });
    await sendMessage(chatId, expiredMsg);
    return;
  }

  const doc     = snap.docs[0];
  const reqData = doc.data();

  // Cross-check proposed times against client's existing confirmed appointments
  const clientPhone: string = reqData.clientPhone ?? "";
  const mutualTimeResolved = await findMutualTime(proposedTimes, clientPhone);
  const renegotiations = (reqData.timeRenegotiations ?? 0) as number;
  if (mutualTimeResolved === null && renegotiations < 2) {
    // All proposed times clash with the family's calendar (U8) — ask the
    // caregiver for different times, capped at 2 rounds, rather than booking a
    // known conflict. The request stays awaiting_caregiver_availability, so the
    // caregiver's next reply re-enters this handler.
    await doc.ref.update({ caregiverAvailability: proposedTimes, timeRenegotiations: renegotiations + 1 });
    const clashMsg = await generateCaraMessage({
      audience: "caregiver",
      context:  "The times the caregiver proposed all conflict with the family's existing calendar. Politely ask them for 2-3 different times this week.",
      fallback: "Those times are all taken on the family's calendar. Could you share 2–3 other times this week that work for you?",
      maxTokens: 80,
    });
    await sendMessage(chatId, clashMsg);
    return;
  }
  // A mutual time was found, or we've already renegotiated twice — proceed with
  // the best available (first proposed time as a last resort).
  const mutualTime = mutualTimeResolved ?? proposedTimes[0];
  await doc.ref.update({
    status:             "awaiting_client_confirmation",
    caregiverAvailability: proposedTimes,
    proposedTime:       mutualTime,
  });

  // Format the time nicely
  const dt = new Date(mutualTime);
  const formatted = dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) +
    " at " + dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  // Text the family to confirm
  const familySnap = await db.collection("agent_sessions")
    .doc(reqData.clientPhone).get();
  if (familySnap.exists) {
    const familySession = familySnap.data()!;
    const caregiverAvailableMsg = await generateCaraMessage({
      audience: "family",
      context:  `${caregiverName} is available for an interview. The proposed time is ${formatted}. Ask the family if that time works — a yes from them schedules it. End with the question itself, never a stiff "Reply YES" instruction.`,
      fallback: `${caregiverName} is available for an interview.`,
      maxTokens: 80,
    });
    await sendMessage(familySession.chatId,
      `${caregiverAvailableMsg}\n\n${formatted}\n\nDoes that time work? Say yes and I'll get it scheduled.`
    );
    // Store pending confirmation
    await db.collection("agent_sessions").doc(reqData.clientPhone).update({
      pendingInterviewConfirm: { docId: doc.id, caregiverName, mutualTime, formatted },
      pendingInterviewConfirmSetAt: new Date().toISOString(),
    });
  }

  const timesSentMsg = await generateCaraMessage({
    audience: "caregiver",
    context:  "The caregiver just sent their available times for an interview. Evia has forwarded those times to the family. Let the caregiver know and tell them you'll reach out once the family confirms.",
    fallback: "I've sent those times to the family. I'll let you know once they confirm.",
    maxTokens: 80,
  });
  await sendMessage(chatId, timesSentMsg);
}

// ── Handle family confirming interview ────────────────────────────────────────

export async function handleInterviewConfirm(
  phone:   string,
  chatId:  string,
  session: AgentSession
): Promise<void> {
  const pending = (session as any).pendingInterviewConfirm as {
    docId: string; caregiverName: string; mutualTime: string; formatted: string;
  } | undefined;

  if (!pending) {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: (session as any)?.preferredLanguage === "es" ? "es" : "en",
      context: "The family tried to confirm an interview, but there isn't one pending right now. Gently let them know, and offer to help them schedule one.",
      fallback: "I don't have a pending interview to confirm. Let me know if you'd like to schedule one.",
      maxTokens: 70,
    }));
    return;
  }

  // Resolve identity up front so the interview record is queryable by
  // list_interviews (clientId/caregiverId) regardless of scheduling path
  const requestSnap  = await db.collection("interview_requests").doc(pending.docId).get();
  const caregiverId  = requestSnap.data()?.caregiverId as string | undefined;
  const familySession = await db.collection("agent_sessions").doc(phone).get();
  const clientId      = familySession.data()?.userId as string | undefined;

  // Create confirmed interview in Firestore
  const interviewRef = await db.collection("interviews").add({
    clientPhone:   phone,
    caregiverName: pending.caregiverName,
    ...(caregiverId ? { caregiverId } : {}),
    ...(clientId ? { clientId } : {}),
    scheduledTime: pending.mutualTime,
    status:        "scheduled",
    followUpSent:  false,
    createdAt:     new Date().toISOString(),
  });

  // Generate Google Meet link + .ics via the shared builder (ops alert on failure)
  let callUrl = "";
  let icsUrl  = "";
  try {
    const assets = await createInterviewCallAssets({
      title:           `Care Interview — ${pending.caregiverName}`,
      startTime:       pending.mutualTime,
      durationMinutes: 30,
      interviewId:     interviewRef.id,
    });
    callUrl = assets.callUrl;
    icsUrl  = assets.icsUrl;
    await interviewRef.update({ callUrl, ...(icsUrl ? { icsUrl } : {}) });
  } catch {
    // Alert already raised inside createInterviewCallAssets; never log the URL
    console.error(`Call link generation error for interview ${interviewRef.id}`);
  }

  // Update request doc
  await db.collection("interview_requests").doc(pending.docId).update({
    status:      "scheduled",
    interviewId: interviewRef.id,
  });

  // Notify admin
  notifyAdminInterviewScheduled({
    interviewId:   interviewRef.id,
    caregiverName: pending.caregiverName,
    clientPhone:   phone,
    scheduledTime: pending.mutualTime,
  }).catch((err) => console.error("notifyAdminInterviewScheduled error:", err));

  // Clear pending from session
  await db.collection("agent_sessions").doc(phone).update({
    pendingInterviewConfirm: admin.firestore.FieldValue.delete(),
  });

  // Send to family — call link + .ics + text
  if (callUrl) {
    await sendMessage(chatId, { parts: [{ type: "link", value: callUrl }] } as any);
  }
  if (icsUrl) {
    await sendMessage(chatId, { parts: [{ type: "media", url: icsUrl }] } as any);
  }
  const interviewConfirmFamilyMsg = await generateCaraMessage({
    audience: "family",
    context:  `The interview with ${pending.caregiverName} is now officially scheduled for ${pending.formatted}. Tell the family to tap the Google Meet link above to join, and let them know a calendar invite was included with a 30-minute reminder.`,
    fallback: `Interview set for ${pending.formatted}.\n\nTap the Meet link above to join. Calendar invite included, with a 30-minute reminder.`,
    maxTokens: 80,
  });
  await sendMessage(chatId, interviewConfirmFamilyMsg);

  // Text the caregiver
  let cgPhone: string | undefined;
  if (caregiverId) {
    const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
    cgPhone = cgSnap.data()?.phone as string | undefined;
    if (cgPhone) {
      const cgSession = await getOrCreateSession(cgPhone);
      if (callUrl) {
        await sendMessage(cgSession.chatId, { parts: [{ type: "link", value: callUrl }] } as any);
      }
      if (icsUrl) {
        await sendMessage(cgSession.chatId, { parts: [{ type: "media", url: icsUrl }] } as any);
      }
      const interviewConfirmCaregiverMsg = await generateCaraMessage({
        audience: "caregiver",
        context:  `The interview has been confirmed for ${pending.formatted}. Tell them the Google Meet link is above, a calendar invite was included with a 30-minute reminder, and to reply RESCHEDULE if they need to change the time.`,
        fallback: `Interview confirmed. ${pending.formatted}.\n\nMeet link above. Calendar invite included, with a 30-minute reminder.\n\nReply RESCHEDULE if you need to change the time.`,
        maxTokens: 80,
      });
      await sendMessage(cgSession.chatId, interviewConfirmCaregiverMsg);
    }
  }

  // Schedule 1h-before reminders and a post-interview follow-up trigger
  const interviewMs    = new Date(pending.mutualTime).getTime();
  const nowMs          = Date.now();
  const oneHourBefore  = interviewMs - 60 * 60 * 1000;
  const ninetyMinAway  = interviewMs - 90 * 60 * 1000;

  const triggerRefId = `interview_${interviewRef.id}`; // cancelTriggersByRef key on cancel

  if (nowMs < ninetyMinAway) {
    // 1h-before reminder to the family
    const familySessionSnap = await db.collection("agent_sessions").doc(phone).get();
    const familyUserId = (familySessionSnap.data()?.userId ?? phone) as string;
    await scheduleTrigger({
      userId:      familyUserId,
      phone,
      type:        "appointment_reminder",
      scheduledAt: new Date(oneHourBefore).toISOString(),
      message:
        `Your interview with ${pending.caregiverName} is in an hour — ` +
        (callUrl ? callUrl : "make sure you have the link ready."),
      refId:       triggerRefId,
    }, { bypassCalibration: true }).catch((err) => console.error("scheduleTrigger (family reminder) error:", err));

    // 1h-before reminder to the caregiver
    if (cgPhone) {
      const cgSessionSnap = await db.collection("agent_sessions").doc(cgPhone).get();
      const cgUserId = (cgSessionSnap.data()?.userId ?? cgPhone) as string;
      await scheduleTrigger({
        userId:      cgUserId,
        phone:       cgPhone,
        type:        "appointment_reminder",
        scheduledAt: new Date(oneHourBefore).toISOString(),
        message:
          `Interview in an hour with a family. ` +
          (callUrl ? callUrl : "Check your calendar.") +
          ` Reply if you need to reschedule.`,
        refId:       triggerRefId,
      }, { bypassCalibration: true }).catch((err) => console.error("scheduleTrigger (caregiver reminder) error:", err));
    }
  }

  // Post-interview follow-up at scheduledTime + 75 min (regardless of lead time)
  const followUpAt = new Date(interviewMs + 75 * 60 * 1000).toISOString();
  await scheduleTrigger({
    userId:      (await db.collection("agent_sessions").doc(phone).get()).data()?.userId ?? phone,
    phone,
    type:        "custom",
    scheduledAt: followUpAt,
    message:     `interview_followup:${interviewRef.id}`,
    refId:       triggerRefId,
  }, { bypassCalibration: true }).catch((err) => console.error("scheduleTrigger (followup) error:", err));
}

// ── Write interview outcome feedback signal ───────────────────────────────────

export async function writeInterviewOutcomeSignal(
  clientId:    string,
  caregiverId: string,
  outcome:     "hire" | "pass"
): Promise<void> {
  // Per-CLIENT signal (re-ranks this family's future matches).
  await writeFeedbackSignal({
    clientId,
    caregiverId,
    signal: outcome === "hire" ? 3 : -2,
    source: outcome === "hire" ? "hire" : "pass",
  }).catch((err) => console.error("writeInterviewOutcomeSignal error:", err));

  // Platform-wide per-caregiver reputation (U5) — lets a NEW family benefit
  // from other families' outcomes. Independent of the per-client signal above;
  // failure here must not block the per-client write, so it's fire-and-forget.
  const { recordCaregiverOutcome } = await import("../ai/caregiverReputation");
  recordCaregiverOutcome(db, caregiverId, outcome)
    .catch((err) => console.error("writeInterviewOutcomeSignal reputation error:", err));
}

// ── Post-interview follow-up ──────────────────────────────────────────────────

export async function sendPostInterviewFollowUp(interviewId: string): Promise<void> {
  const snap = await db.collection("interviews").doc(interviewId).get();
  if (!snap.exists) return;
  const data = snap.data()!;

  const clientSnap = await db.collection("agent_sessions").doc(data.clientPhone).get();
  if (clientSnap.exists) {
    const followUpMsg = await generateCaraMessage({
      audience: "family",
      context:  `The interview with ${data.caregiverName} just finished (about 75 minutes ago). Check in warmly and ask how it went — invite them to share their honest thoughts.`,
      fallback: `How did it go with ${data.caregiverName}?\n\nJust tell me what you thought.`,
      maxTokens: 80,
    });
    await sendMessage(clientSnap.data()!.chatId, followUpMsg);
    // Look up caregiverId so HIRE flow can fetch hourly rate + rejection memory
    const reqSnap = await db.collection("interview_requests")
      .where("interviewId", "==", interviewId).limit(1).get();
    const caregiverId = reqSnap.empty ? "" : (reqSnap.docs[0].data().caregiverId ?? "");
    await db.collection("agent_sessions").doc(data.clientPhone).update({
      pendingInterviewOutcome: { interviewId, caregiverName: data.caregiverName, caregiverId },
    });
  }
}
