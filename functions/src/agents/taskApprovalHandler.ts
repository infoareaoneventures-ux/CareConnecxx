import * as admin from "firebase-admin";
import { sendMessage, AgentSession } from "../linq/client";
import { createBookingTask } from "./bookingExecutor";
import { resolveCaregiverRate } from "../utils/caregiverRate";
import { quickComplete } from "../utils/openaiClient";
import { generateCaraMessage } from "../utils/caraMessage";
import { answerHumanQuestionOnly } from "./humanReply";

const db = admin.firestore();

async function isQuestionOrOther(text: string): Promise<boolean> {
  try {
    const result = await quickComplete(
      "The user was just shown a list of caregivers (numbered 1, 2, 3...) and asked to pick one. " +
      "Reply YES if their reply is a question or off-topic comment about the caregivers, the booking, " +
      "pricing, or anything else. Reply NO if it is a selection (a number, a name, or a clear pick).",
      text,
      { maxTokens: 5 },
    );
    return result.trim().toUpperCase().startsWith("Y");
  } catch {
    return false;
  }
}

async function answerQuestionMidFlow(text: string, optionsSummary: string): Promise<string> {
  return answerHumanQuestionOnly({
    audience: "family",
    situation: `family was shown caregiver options (${optionsSummary}) and asked to pick one`,
    text,
    maxTokens: 180,
  });
}

export async function handleTaskApproval(
  taskDoc: admin.firestore.QueryDocumentSnapshot,
  choice: string,
  session: AgentSession,
  chatId: string
): Promise<void> {
  const task    = taskDoc.data();
  const options = task.options ?? [];

  // If the family asked a question instead of picking, answer it and re-ask.
  if (await isQuestionOrOther(choice)) {
    const optionsSummary = options
      .map((o: any, i: number) => `${i + 1}. ${o.name ?? "caregiver"}`)
      .join(", ");
    const answer = await answerQuestionMidFlow(choice, optionsSummary);
    await sendMessage(chatId, answer);
    await sendMessage(chatId,
      `When you're ready, reply 1, 2, or 3 to choose a caregiver for your ${task.time ?? "upcoming"} visit.`
    );
    return;
  }

  const idx = parseInt(choice, 10) - 1;

  if (idx < 0 || idx >= options.length) {
    await sendMessage(chatId, "Please reply 1, 2, or 3 to choose a caregiver.");
    return;
  }

  const selected = options[idx];

  // Validate caregiver is still active
  const cgSnap = selected.caregiverId
    ? await db.collection("caregivers").doc(selected.caregiverId).get()
    : null;
  if (cgSnap && cgSnap.exists && cgSnap.data()?.status === "inactive") {
    await sendMessage(chatId,
      `${selected.name} is no longer available. Want me to search for another caregiver?`
    );
    return;
  }

  // Store selection so CONFIRM reply can finalize it
  await taskDoc.ref.update({ status: "pending_confirm", selectedIdx: idx });
  await db.collection("agent_sessions").doc((session as any).phone ?? taskDoc.ref.path).update({
    pendingTaskConfirm: {
      taskId:        taskDoc.id,
      caregiverName: selected.name,
      caregiverId:   selected.caregiverId ?? "",
      time:          task.time ?? "",
    },
    pendingTaskConfirmSetAt: new Date().toISOString(),
  }).catch(() => {});

  await sendMessage(chatId,
    `Got it — ${selected.name} for your ${task.time ?? "upcoming"} visit.\n\n` +
    `Reply CONFIRM to book, or SKIP to choose someone else.`
  );
}

// Called when user replies CONFIRM after handleTaskApproval
export async function finalizeTaskApproval(
  phone: string,
  chatId: string,
  session: Record<string, unknown>
): Promise<void> {
  const pending = (session as any).pendingTaskConfirm as {
    taskId: string; caregiverName: string; caregiverId: string; time: string;
  } | undefined;

  if (!pending) {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: (session.preferredLanguage as string) === "es" ? "es" : "en",
      context: "The family tried to confirm a booking, but there isn't one pending right now. Gently let them know, and offer to search for caregivers.",
      fallback: "I don't have a pending booking to confirm. Want me to search for caregivers?",
      maxTokens: 70,
    }));
    return;
  }

  // Pull original task for appointment details
  const taskSnap = await db.collection("agent_tasks").doc(pending.taskId).get();
  if (!taskSnap.exists) {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: (session.preferredLanguage as string) === "es" ? "es" : "en",
      context: "The booking the family was about to confirm has expired. Gently let them know, and offer to start a fresh search.",
      fallback: "That booking has expired. Want me to start a fresh search?",
      maxTokens: 70,
    }));
    await db.collection("agent_sessions").doc(phone).update({
      pendingTaskConfirm: admin.firestore.FieldValue.delete(),
    }).catch(() => {});
    return;
  }

  const task = taskSnap.data()!;

  // Create a real booking task that goes through the standard confirmation flow.
  // 2026-09-13: this used to fall back to a hardcoded $20/hr when the
  // caregiver had no rate on file — a fabricated rate here becomes a
  // fabricated charge the caregiver is asked to accept. Resolve the real
  // rate the same way request_booking does; refuse rather than guess.
  const clientId = (session as any).userId ?? phone;
  const rateResult = await resolveCaregiverRate(pending.caregiverId);
  if (!rateResult.ok) {
    await sendMessage(chatId,
      `I wasn't able to confirm ${pending.caregiverName}'s current rate, so I couldn't complete this booking yet — ` +
      `I'll get that sorted and follow up.`);
    await db.collection("agent_sessions").doc(phone).update({
      pendingTaskConfirm: admin.firestore.FieldValue.delete(),
    }).catch(() => {});
    return;
  }
  const hourlyRate = rateResult.hourlyRate;

  // Use appointments from original task or fall back to stored time
  const appointments = (task.appointments ?? [{
    date:          task.date ?? new Date().toISOString().slice(0, 10),
    startTime:     task.startTime ?? "09:00",
    endTime:       task.endTime   ?? "17:00",
    durationHours: task.durationHours ?? 8,
  }]) as Array<{ date: string; startTime: string; endTime: string; durationHours: number }>;

  const bookingTaskId = await createBookingTask({
    clientPhone:            phone,
    clientId,
    caregiverId:            pending.caregiverId,
    caregiverName:          pending.caregiverName,
    appointments,
    hourlyRate,
    isEmergencyReplacement: task.type === "replacement_confirmation",
  });

  await db.collection("agent_sessions").doc(phone).update({
    pendingTaskConfirm: admin.firestore.FieldValue.delete(),
  }).catch(() => {});

  if (bookingTaskId) {
    // Auto-approve — user already confirmed intent
    const { executeBookings } = await import("./bookingExecutor");
    await executeBookings(bookingTaskId, phone);
  } else {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: (session.preferredLanguage as string) === "es" ? "es" : "en",
      context: "Something went wrong starting the booking. Warmly apologize, ask them to try again, and mention they can text FIND to search for a new caregiver. You MUST include the literal keyword \"FIND\".",
      fallback: "Something went wrong starting the booking. Try again or text FIND to search for a new caregiver.",
      maxTokens: 80,
    }));
  }
}
