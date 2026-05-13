import * as admin from "firebase-admin";
import { AgentSession, sendMessage } from "../linq/client";
import { runMatchingForClient } from "./matchingAgent";
import { executeBookings } from "./bookingExecutor";

const db = admin.firestore();

// ── ExecutionTask — returned by Interaction Agent, consumed by Execution Agent ──

export interface ExecutionTask {
  type:
    | "booking"
    | "matching"
    | "alert"
    | "memory_update"
    | "wait"     // silence is the right action
    | "qa";      // hand off to QA agent
  payload: Record<string, unknown>;
}

// ── processEvent — internal natural language event dispatch ───────────────────

export async function processEvent(
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  switch (eventType) {
    case "journal.created":
      await handleJournalEvent(payload);
      break;

    case "appointment.cancelled":
      await handleAppointmentCancelledEvent(payload);
      break;

    case "caregiver.arrived":
      await handleCaregiverArrivedEvent(payload);
      break;

    case "interview.scheduled":
      // Future: notify family and caregiver with calendar details
      break;

    default:
      console.warn(`processEvent: unknown eventType "${eventType}"`);
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleJournalEvent(payload: Record<string, unknown>): Promise<void> {
  const { seniorId, caregiverId } = payload;

  if (!seniorId) return;

  const clientDoc = await db.collection("users").doc(seniorId as string).get();
  const phone     = clientDoc.data()?.phone as string | undefined;
  if (!phone) return;

  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
  if (!sessionSnap.exists) return;

  const session = sessionSnap.data() as AgentSession;
  if (session.optedOut || session.optedIn === false) return;

  // Delegate to journalCreated trigger logic — already handles health signals + message
  // processEvent is a dispatch layer; actual logic stays in triggers/journalCreated.ts
  console.log(`processEvent journal.created: seniorId=${seniorId}, caregiver=${caregiverId}`);
}

async function handleAppointmentCancelledEvent(payload: Record<string, unknown>): Promise<void> {
  const { clientPhone, caregiverName, date } = payload;
  if (!clientPhone) return;

  const sessionSnap = await db.collection("agent_sessions").doc(clientPhone as string).get();
  if (!sessionSnap.exists) return;

  const session = sessionSnap.data() as AgentSession;
  if (session.optedOut) return;

  await sendMessage(session.chatId,
    `Heads up — ${caregiverName ?? "your caregiver"}'s visit on ${date ?? "today"} has been cancelled.\n\n` +
    `Want me to find a replacement? Reply YES and I'll get on it right away. 💙`
  );
}

async function handleCaregiverArrivedEvent(payload: Record<string, unknown>): Promise<void> {
  const { clientPhone, caregiverName } = payload;
  if (!clientPhone) return;

  const sessionSnap = await db.collection("agent_sessions").doc(clientPhone as string).get();
  if (!sessionSnap.exists) return;

  const session = sessionSnap.data() as AgentSession;
  if (session.optedOut) return;

  await sendMessage(session.chatId,
    `${caregiverName ?? "Your caregiver"} has arrived for today's visit. 💙`
  );
}

// ── Interaction Agent — NLU only, reads only ──────────────────────────────────

export async function runInteractionAgent(
  phone:   string,
  chatId:  string,
  text:    string,
  session: AgentSession
): Promise<ExecutionTask> {
  const norm = text.trim().toUpperCase();

  // Delegate hire intent → booking execution
  if (norm === "HIRE") {
    const outcome = (session as any).pendingInterviewOutcome as
      { caregiverName: string; caregiverId: string } | undefined;

    if (outcome) {
      return {
        type: "booking",
        payload: {
          mode:          "hire",
          caregiverName: outcome.caregiverName,
          caregiverId:   outcome.caregiverId,
          phone,
          chatId,
        },
      };
    }
  }

  // Delegate YES to pending booking task → execution
  if ((norm === "YES" || norm === "Y")) {
    const taskSnap = await db
      .collection("agent_tasks")
      .where("clientPhone", "==", phone)
      .where("status",      "==", "awaiting_approval")
      .limit(1).get();

    if (!taskSnap.empty) {
      return {
        type: "booking",
        payload: { taskId: taskSnap.docs[0].id, phone, chatId },
      };
    }
  }

  // Search for caregiver
  if (
    norm.includes("FIND") ||
    norm.includes("CAREGIVER") ||
    norm.includes("NEED HELP") ||
    norm.includes("LOOKING FOR")
  ) {
    return {
      type: "matching",
      payload: { clientId: session.userId ?? phone, phone, chatId },
    };
  }

  // Default: hand off to QA agent
  return {
    type: "qa",
    payload: {
      text,
      phone,
      chatId,
      userId:      session.userId ?? phone,
      seniorId:    session.seniorId ?? session.userId ?? phone,
      userType:    session.userType ?? "client",
      caregiverId: session.caregiverId,
    },
  };
}

// ── Execution Agents — write to Firestore, no Claude calls ───────────────────

export async function runExecutionAgent(task: ExecutionTask): Promise<void> {
  switch (task.type) {
    case "booking":
      await bookingAgent(task.payload);
      break;

    case "matching":
      await matchingAgent(task.payload);
      break;

    case "alert":
      await alertAgent(task.payload);
      break;

    case "memory_update":
      await memoryAgent(task.payload);
      break;

    case "wait":
      // Deliberate silence — no action needed
      break;

    case "qa":
      // QA is handled separately in webhooks.ts via runQaAgent
      break;
  }
}

// ── Execution agent implementations ──────────────────────────────────────────

async function bookingAgent(payload: Record<string, unknown>): Promise<void> {
  const { taskId, phone } = payload;

  if (taskId) {
    // Execute an existing booking task
    await executeBookings(taskId as string, phone as string);
  } else if (payload.mode === "hire") {
    // HIRE flow: set up hireMode and prompt for start date
    const { caregiverName, phone: p, chatId: c } = payload;
    await db.collection("agent_sessions").doc(p as string).update({
      hireMode: caregiverName,
      pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
    });
    await sendMessage(c as string,
      `Great choice! 🎉 ${caregiverName} will be thrilled.\n\n` +
      `What date should their first visit be? (e.g. "this Monday" or "June 15")`
    );
  }
}

async function matchingAgent(payload: Record<string, unknown>): Promise<void> {
  const { phone, chatId } = payload;
  const sessionSnap = await db.collection("agent_sessions").doc(phone as string).get();
  const session = sessionSnap.data() ?? {};
  await runMatchingForClient(
    phone as string,
    chatId as string,
    session as Record<string, unknown>,
    session as Record<string, unknown>
  );
}

async function alertAgent(payload: Record<string, unknown>): Promise<void> {
  const { chatId, message, type, metadata } = payload;
  if (!chatId || !message) return;

  await sendMessage(chatId as string, message as string);
  await db.collection("agent_alerts_log").add({
    type:    type ?? "agent_alert",
    sentAt:  new Date().toISOString(),
    ...(typeof metadata === "object" && metadata !== null ? metadata as Record<string, unknown> : {}),
  });
}

async function memoryAgent(payload: Record<string, unknown>): Promise<void> {
  // Memory writes are handled in learnedFacts.ts and memoryFiles.ts
  // This stub allows future routing through the execution agent
  const { userId, text } = payload;
  if (!userId || !text) return;

  const { extractAndStoreFacts } = await import("../memory/learnedFacts");
  await extractAndStoreFacts(userId as string, text as string).catch(() => {});
}
