import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import { sendMessage, getOrCreateSession, AgentSession } from "../linq/client";
import { writeFeedbackSignal } from "../ai/feedback";
import { generateCaraMessage } from "../utils/caraMessage";

let _claude: Anthropic | null = null;
function getClaude(): Anthropic {
  if (!_claude) _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}
import { getPermissions } from "./permissionsConversation";
import { notifyAdminInterviewScheduled } from "../notifications";
import { generateCallLink, generateICSFile, uploadICSToStorage } from "./interviewLinks";
import { scheduleTrigger } from "../triggers/triggerEngine";

const db = admin.firestore();

// ── Parse caregiver selection from family text ────────────────────────────────

async function parseSelection(text: string, matchCount: number): Promise<number[]> {
  const norm  = text.trim().toLowerCase();
  if (norm === "all") return Array.from({ length: matchCount }, (_, i) => i + 1);

  const result = await getClaude().messages.create({
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
  const result = await getClaude().messages.create({
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

  const today = new Date().toISOString().slice(0, 10);
  const apptSnap = await db.collection("appointments")
    .where("clientId", "==", clientId)
    .where("status", "in", ["confirmed", "pending"])
    .where("date", ">=", today)
    .get();

  // Build set of busy hours as "YYYY-MM-DDTHH" strings
  const busy = new Set<string>();
  for (const d of apptSnap.docs) {
    const a = d.data();
    if (a.date && a.time) {
      const hour = a.time.slice(0, 2);
      busy.add(`${a.date}T${hour}`);
    }
  }

  for (const iso of proposedTimes) {
    const dt   = new Date(iso);
    const key  = `${dt.toISOString().slice(0, 10)}T${String(dt.getHours()).padStart(2, "0")}`;
    if (!busy.has(key)) return iso;
  }

  // All proposed times conflict — return the first anyway
  return proposedTimes[0];
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
      context:  "The family wants to reach out to caregivers for an interview, but Cara doesn't yet have their permission to contact caregivers on their behalf. Ask them to reply ALLOW to grant permission, or visit the app to update their settings.",
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
      context:  `Introduce yourself as Cara, the care coordinator, and let ${match.name} know that a family is interested in meeting them for a care position. The senior is ${seniorName}, who is a ${relationship}${age ? ` and is ${age} years old` : ""}. Ask if they're available for a 20-minute video call this week. Tell them to reply with 2–3 times that work, or PASS to decline.`,
      fallback: `Hi ${match.name} — I'm Cara, your care coordinator.\n\nA family is interested in meeting you for a care position for their ${relationship}, ${age ? `${age}-year-old ` : ""}${seniorName}.\n\nAre you available for a 20-minute video call this week?\n\nReply with 2–3 times that work for you, or PASS to decline.`,
    });
    await sendMessage(caregiverSession.chatId, caregiverReachOutMsg);
  }

  const reachedOutMsg = await generateCaraMessage({
    audience: "family",
    context:  `Cara just contacted ${selected.length} ${selected.length === 1 ? "caregiver" : "caregivers"} on the family's behalf. Let them know and say you'll text as soon as you hear back with availability.`,
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
          context:  `${caregiverName} just declined the interview request and isn't available right now. Ask the family if they'd like you to reach out to the next best match, and tell them to reply YES if so.`,
          fallback: `${caregiverName} isn't available right now.\n\nWant me to reach out to the next best match? Reply YES and I'll get on it.`,
          maxTokens: 80,
        });
        await sendMessage(familySession.chatId, caregiverUnavailableMsg);
        // Remember this caregiver was declined so matching won't re-present them
        await db.collection("agent_sessions").doc(reqData.clientPhone).update({
          rejectedCaregiverIds: admin.firestore.FieldValue.arrayUnion(caregiverId),
        });
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
  const mutualTime = await findMutualTime(proposedTimes, clientPhone) ?? proposedTimes[0];
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
      context:  `${caregiverName} is available for an interview. The proposed time is ${formatted}. Ask the family to confirm by replying YES to schedule.`,
      fallback: `${caregiverName} is available for an interview.\n\n${formatted}\n\nConfirm this time? Reply YES to schedule.`,
      maxTokens: 80,
    });
    await sendMessage(familySession.chatId,
      `${caregiverAvailableMsg}\n\n${formatted}\n\nReply YES to schedule.`
    );
    // Store pending confirmation
    await db.collection("agent_sessions").doc(reqData.clientPhone).update({
      pendingInterviewConfirm: { docId: doc.id, caregiverName, mutualTime, formatted },
    });
  }

  const timesSentMsg = await generateCaraMessage({
    audience: "caregiver",
    context:  "The caregiver just sent their available times for an interview. Cara has forwarded those times to the family. Let the caregiver know and tell them you'll reach out once the family confirms.",
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
    await sendMessage(chatId, "I don't have a pending interview to confirm. Let me know if you'd like to schedule one.");
    return;
  }

  // Create confirmed interview in Firestore
  const interviewRef = await db.collection("interviews").add({
    clientPhone:   phone,
    caregiverName: pending.caregiverName,
    scheduledTime: pending.mutualTime,
    status:        "scheduled",
    followUpSent:  false,
    createdAt:     new Date().toISOString(),
  });

  // Get family session to determine iMessage vs other
  const familySession = await db.collection("agent_sessions").doc(phone).get();
  const isIMessage = (familySession.data()?.service ?? "") === "iMessage";

  // Generate call link (FaceTime for iMessage, Google Meet otherwise)
  let callUrl = "";
  try {
    callUrl = await generateCallLink({
      isIMessage,
      startTime:       pending.mutualTime,
      durationMinutes: 30,
      title:           `Care Interview — ${pending.caregiverName}`,
    });
    await interviewRef.update({ callUrl });
  } catch (err) {
    console.error("Call link generation error:", err);
  }

  // Generate and upload .ics calendar invite
  let icsUrl = "";
  if (callUrl) {
    try {
      const icsContent = generateICSFile({
        title:           `Care Interview — ${pending.caregiverName}`,
        startTime:       pending.mutualTime,
        durationMinutes: 30,
        description:     `${isIMessage ? "FaceTime" : "Google Meet"} interview with ${pending.caregiverName}`,
        callUrl,
        uid:             `cara-${interviewRef.id}@cara.com`,
      });
      icsUrl = await uploadICSToStorage(icsContent, `interviews/${interviewRef.id}.ics`);
    } catch (err) {
      console.error("ICS upload error:", err);
    }
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
    context:  `The interview with ${pending.caregiverName} is now officially scheduled for ${pending.formatted}. Tell the family to tap the ${isIMessage ? "FaceTime" : "Google Meet"} link above to join, and let them know a calendar invite was included with a 30-minute reminder.`,
    fallback: `Interview set for ${pending.formatted}.\n\nTap the ${isIMessage ? "FaceTime" : "Meet"} link above to join. Calendar invite included, with a 30-minute reminder.`,
    maxTokens: 80,
  });
  await sendMessage(chatId, interviewConfirmFamilyMsg);

  // Text the caregiver
  const reqSnap = await db.collection("interview_requests").doc(pending.docId).get();
  const caregiverId = reqSnap.data()?.caregiverId as string | undefined;
  let cgPhone: string | undefined;
  if (caregiverId) {
    const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
    cgPhone = cgSnap.data()?.phone as string | undefined;
    if (cgPhone) {
      const cgSession  = await getOrCreateSession(cgPhone);
      const cgIsIMessa = (cgSession as any).service === "iMessage";
      if (callUrl) {
        await sendMessage(cgSession.chatId, { parts: [{ type: "link", value: callUrl }] } as any);
      }
      if (icsUrl) {
        await sendMessage(cgSession.chatId, { parts: [{ type: "media", url: icsUrl }] } as any);
      }
      const interviewConfirmCaregiverMsg = await generateCaraMessage({
        audience: "caregiver",
        context:  `The interview has been confirmed for ${pending.formatted}. Tell them the ${cgIsIMessa ? "FaceTime" : "Google Meet"} link is above, a calendar invite was included with a 30-minute reminder, and to reply RESCHEDULE if they need to change the time.`,
        fallback: `Interview confirmed. ${pending.formatted}.\n\n${cgIsIMessa ? "FaceTime" : "Meet"} link above. Calendar invite included, with a 30-minute reminder.\n\nReply RESCHEDULE if you need to change the time.`,
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
    }).catch((err) => console.error("scheduleTrigger (family reminder) error:", err));

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
      }).catch((err) => console.error("scheduleTrigger (caregiver reminder) error:", err));
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
  }).catch((err) => console.error("scheduleTrigger (followup) error:", err));
}

// ── Write interview outcome feedback signal ───────────────────────────────────

export async function writeInterviewOutcomeSignal(
  clientId:    string,
  caregiverId: string,
  outcome:     "hire" | "pass"
): Promise<void> {
  await writeFeedbackSignal({
    clientId,
    caregiverId,
    signal: outcome === "hire" ? 3 : -2,
    source: outcome === "hire" ? "hire" : "pass",
  }).catch((err) => console.error("writeInterviewOutcomeSignal error:", err));
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
