import { quickComplete } from "../utils/openaiClient";
import { safeParseJson } from "../utils/jsonUtils";
import { businessTodayStr } from "../utils/scheduledTime";
import { sendViaInteractionAgent } from "./caraAgent";
import {
  createUserTrigger,
  listUserTriggers,
  deleteUserTrigger,
  UserTrigger,
} from "../triggers/userTriggerManager";

interface ParsedSchedule {
  recurrence:  UserTrigger["recurrence"];
  dayOfWeek?:  number;
  hour:        number;
  minute:      number;
  label:       string;
  message:     string;
}

async function parseScheduleRequest(userMessage: string): Promise<ParsedSchedule | null> {
  // Business-timezone today — telling the LLM "today is <UTC date>" after 5pm
  // PT parses "tomorrow" a day late.
  const today = businessTodayStr();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  let raw: string;
  try {
    raw = await quickComplete(
      `Today is ${today}. ` +
        "Extract a reminder schedule from the user's message. Reply with a JSON object only:\n" +
        '{"recurrence":"daily"|"weekly"|"monthly"|"once","dayOfWeek":0-6|null,"hour":0-23,"minute":0-59,"label":"short name","message":"full reminder text"}\n' +
        "dayOfWeek: 0=Sunday, 1=Monday ... 6=Saturday. Null for non-weekly. " +
        "hour/minute: 24h format. " +
        "label: short user-facing name (e.g. 'mom medications'). " +
        "message: the full text Evia will send as the reminder. " +
        "If you cannot parse a schedule, reply with null.",
      userMessage,
      { maxTokens: 120, signal: controller.signal },
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  const trimmed = (raw ?? "").trim();
  if (trimmed === "null" || trimmed === "") return null;

  return safeParseJson<ParsedSchedule>(trimmed, "parseScheduleRequest", null, "object");
}

export async function handleScheduleRequest(
  phone:       string,
  userMessage: string,
  session:     Record<string, unknown>
): Promise<void> {
  const userId = (session.userId ?? phone) as string;

  const parsed = await parseScheduleRequest(userMessage);
  if (!parsed) {
    await sendViaInteractionAgent(phone, {
      content:
        "I didn't quite catch that schedule. Could you be more specific? " +
        "For example: 'Remind me every Monday at 9am about mom's medications.'",
      urgency:     "standard",
      sourceAgent: "scheduling_handler",
      canDrop:     false,
    });
    return;
  }

  await createUserTrigger(phone, userId, {
    label:      parsed.label,
    recurrence: parsed.recurrence,
    dayOfWeek:  parsed.dayOfWeek ?? undefined,
    hour:       parsed.hour,
    minute:     parsed.minute,
    message:    parsed.message,
  });

  const recurrenceText = formatRecurrenceConfirmation(parsed);
  await sendViaInteractionAgent(phone, {
    content:     `Done — I'll remind you ${recurrenceText} about ${parsed.label}. Reply "show reminders" anytime to manage them.`,
    urgency:     "standard",
    sourceAgent: "scheduling_handler",
    canDrop:     false,
  });
}

export type TriggerAction = "list" | "cancel" | "create" | "question";

// Classify reminder-management intent with an LLM instead of keyword `.includes`
// matching (which mis-fired on negation, e.g. "don't cancel anything" → cancel).
export async function classifyTriggerAction(userMessage: string): Promise<TriggerAction> {
  const raw = await quickComplete(
    "A user is managing reminders with a care assistant. Classify their message as one word: " +
      "LIST (see existing reminders), CANCEL (remove/stop a reminder), CREATE (set up a new reminder), " +
      "or QUESTION (asking how reminders work, or anything that isn't one of the above). " +
      "Reply with only one word.",
    userMessage,
    { maxTokens: 5 },
  ).catch(() => "create");
  const v = raw.trim().toUpperCase();
  if (v.startsWith("LIST")) return "list";
  if (v.startsWith("CANCEL")) return "cancel";
  if (v.startsWith("QUESTION")) return "question";
  return "create";
}

// Resolve which reminder the user wants to cancel via the LLM, not a substring
// match on the label (which broke on paraphrase and partial names).
export async function resolveCancelTarget(
  userMessage: string,
  triggers:    UserTrigger[],
): Promise<UserTrigger | null> {
  if (triggers.length === 0) return null;
  if (triggers.length === 1) return triggers[0];
  const labels = triggers.map((t, i) => `${i}: ${t.label}`).join("; ");
  const raw = await quickComplete(
    `The user wants to cancel one of these reminders (index: label): ${labels}. ` +
      "Which index do they mean? Reply with only the number, or NONE if unclear.",
    userMessage,
    { maxTokens: 5 },
  ).catch(() => "NONE");
  const idx = parseInt(raw.trim(), 10);
  return Number.isInteger(idx) && idx >= 0 && idx < triggers.length ? triggers[idx] : null;
}

export async function handleTriggerManagement(
  phone:       string,
  userMessage: string,
  session:     Record<string, unknown>
): Promise<void> {
  const action = await classifyTriggerAction(userMessage);

  if (action === "question") {
    await sendViaInteractionAgent(phone, {
      content:
        "Happy to help with reminders! You can say things like 'Remind me every Monday at 9am about " +
        "mom's medications', 'show my reminders', or 'cancel the medication reminder'.",
      urgency:     "standard",
      sourceAgent: "scheduling_handler",
      canDrop:     false,
    });
    return;
  }

  // "show my reminders" / "list reminders"
  if (action === "list") {
    const triggers = await listUserTriggers(phone);
    if (triggers.length === 0) {
      await sendViaInteractionAgent(phone, {
        content:     "You don't have any active reminders set up. Text me something like 'Remind me every Monday at 9am about mom's medications' to add one.",
        urgency:     "standard",
        sourceAgent: "scheduling_handler",
        canDrop:     false,
      });
      return;
    }
    const lines = triggers.map((t, i) =>
      `${i + 1}. ${t.label} — ${formatRecurrenceConfirmation(t)}`
    ).join("\n");
    await sendViaInteractionAgent(phone, {
      content:     `Your active reminders:\n\n${lines}\n\nTo cancel one, reply "cancel [name]".`,
      urgency:     "standard",
      sourceAgent: "scheduling_handler",
      canDrop:     false,
    });
    return;
  }

  // "cancel my [label] reminder"
  if (action === "cancel") {
    const triggers = await listUserTriggers(phone);
    if (triggers.length === 0) {
      await sendViaInteractionAgent(phone, {
        content:     "You don't have any active reminders to cancel.",
        urgency:     "standard",
        sourceAgent: "scheduling_handler",
        canDrop:     false,
      });
      return;
    }

    // Resolve which reminder via the LLM, not a substring match.
    const match = await resolveCancelTarget(userMessage, triggers);

    if (!match) {
      const labels = triggers.map(t => t.label).join(", ");
      await sendViaInteractionAgent(phone, {
        content:     `I didn't find a matching reminder. Your active reminders: ${labels}. Which one would you like to cancel?`,
        urgency:     "standard",
        sourceAgent: "scheduling_handler",
        canDrop:     false,
      });
      return;
    }

    await deleteUserTrigger(phone, match.id!);
    await sendViaInteractionAgent(phone, {
      content:     `Cancelled — I'll stop sending the "${match.label}" reminder.`,
      urgency:     "standard",
      sourceAgent: "scheduling_handler",
      canDrop:     false,
    });
    return;
  }

  // Default: treat as a new schedule request
  await handleScheduleRequest(phone, userMessage, session);
}

function formatRecurrenceConfirmation(t: { recurrence: string; dayOfWeek?: number | null; hour: number; minute: number }): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const h    = t.hour;
  const m    = t.minute;
  const ampm = h >= 12 ? "pm" : "am";
  const h12  = h % 12 === 0 ? 12 : h % 12;
  const mStr = m === 0 ? "" : `:${String(m).padStart(2, "0")}`;
  const time = `${h12}${mStr}${ampm}`;

  switch (t.recurrence) {
    case "daily":   return `every day at ${time}`;
    case "weekly":  return `every ${days[t.dayOfWeek ?? 1]} at ${time}`;
    case "monthly": return `monthly at ${time}`;
    case "once":    return `once at ${time}`;
    default:        return `at ${time}`;
  }
}
