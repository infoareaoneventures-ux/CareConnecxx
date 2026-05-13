import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import { sendMessage, getOrCreateSession, AgentSession } from "../linq/client";

let _claude: Anthropic | null = null;
function getClaude(): Anthropic {
  if (!_claude) _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}
import { getPermissions } from "./permissionsConversation";
import { notifyAdminInterviewScheduled } from "../notifications";
import { generateCallLink, generateICSFile, uploadICSToStorage } from "./interviewLinks";

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
    await sendMessage(chatId, "I don't have any pending matches right now. Let me search again — I'll text you shortly! 🔍");
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
    await sendMessage(chatId,
      "I need your permission to reach out to caregivers on your behalf.\n\n" +
      "Reply ALLOW to give me permission, or visit the app to update your settings."
    );
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
    await sendMessage(caregiverSession.chatId,
      `Hi ${match.name}! 👋 I'm Cara, your care assistant.\n\n` +
      `A family is interested in meeting you for a care position for their ${relationship}, ` +
      `${age ? `${age}-year-old ` : ""}${seniorName}.\n\n` +
      `Are you available for a 20-minute video call this week?\n\n` +
      `Reply with 2–3 times that work for you, or PASS to decline.`
    );
  }

  await sendMessage(chatId,
    `I've reached out to ${selected.length === 1 ? "that caregiver" : "those caregivers"} on your behalf! 💙\n\n` +
    `I'll text you as soon as I hear back with their availability.`
  );
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
        await sendMessage(familySession.chatId,
          `${caregiverName} isn't available right now.\n\n` +
          `Want me to reach out to the next best match? Reply YES and I'll get on it. 🔍`
        );
        // Remember this caregiver was declined so matching won't re-present them
        await db.collection("agent_sessions").doc(reqData.clientPhone).update({
          rejectedCaregiverIds: admin.firestore.FieldValue.arrayUnion(caregiverId),
        });
      }
    }
    await sendMessage(chatId, "No problem! I'll let the family know. Good luck with your other bookings! 😊");
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
    await sendMessage(chatId, "I couldn't find an active interview request. Please try again or contact support.");
    return;
  }

  const doc     = snap.docs[0];
  const reqData = doc.data();

  // Pick first proposed time that works
  const mutualTime = proposedTimes[0]; // TODO: cross-check with client's calendar
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
    await sendMessage(familySession.chatId,
      `${caregiverName} is available for an interview!\n\n` +
      `📅 ${formatted}\n\n` +
      `Confirm this time? Reply YES to schedule.`
    );
    // Store pending confirmation
    await db.collection("agent_sessions").doc(reqData.clientPhone).update({
      pendingInterviewConfirm: { docId: doc.id, caregiverName, mutualTime, formatted },
    });
  }

  await sendMessage(chatId,
    `I've sent those times to the family! I'll let you know once they confirm. 📅`
  );
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
    await sendMessage(chatId, "I don't have a pending interview to confirm. Let me know if you'd like to schedule one! 📅");
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
  await sendMessage(chatId,
    `✅ Interview set for ${pending.formatted}.\n\n` +
    `Tap the ${isIMessage ? "FaceTime" : "Meet"} link above to join. Calendar invite included — it has a 30-min reminder built in. 📅`
  );

  // Text the caregiver
  const reqSnap = await db.collection("interview_requests").doc(pending.docId).get();
  const caregiverId = reqSnap.data()?.caregiverId as string | undefined;
  if (caregiverId) {
    const cgSnap  = await db.collection("caregivers").doc(caregiverId).get();
    const cgPhone = cgSnap.data()?.phone as string | undefined;
    if (cgPhone) {
      const cgSession  = await getOrCreateSession(cgPhone);
      const cgIsIMessa = (cgSession as any).service === "iMessage";
      if (callUrl) {
        await sendMessage(cgSession.chatId, { parts: [{ type: "link", value: callUrl }] } as any);
      }
      if (icsUrl) {
        await sendMessage(cgSession.chatId, { parts: [{ type: "media", url: icsUrl }] } as any);
      }
      await sendMessage(cgSession.chatId,
        `The family confirmed your interview! 🎉\n\n` +
        `📅 ${pending.formatted}\n\n` +
        `Tap the ${cgIsIMessa ? "FaceTime" : "Meet"} link above to join. Calendar invite included.\n` +
        `Reply RESCHEDULE if something comes up.`
      );
    }
  }
}

// ── Post-interview follow-up ──────────────────────────────────────────────────

export async function sendPostInterviewFollowUp(interviewId: string): Promise<void> {
  const snap = await db.collection("interviews").doc(interviewId).get();
  if (!snap.exists) return;
  const data = snap.data()!;

  const clientSnap = await db.collection("agent_sessions").doc(data.clientPhone).get();
  if (clientSnap.exists) {
    await sendMessage(clientSnap.data()!.chatId,
      `How did the interview with ${data.caregiverName} go?\n\n` +
      `Reply:\n` +
      `HIRE — I'll start the booking process\n` +
      `MAYBE — I'll keep them in mind\n` +
      `PASS — I'll look for other options`
    );
    // Look up caregiverId so HIRE flow can fetch hourly rate + rejection memory
    const reqSnap = await db.collection("interview_requests")
      .where("interviewId", "==", interviewId).limit(1).get();
    const caregiverId = reqSnap.empty ? "" : (reqSnap.docs[0].data().caregiverId ?? "");
    await db.collection("agent_sessions").doc(data.clientPhone).update({
      pendingInterviewOutcome: { interviewId, caregiverName: data.caregiverName, caregiverId },
    });
  }
}
