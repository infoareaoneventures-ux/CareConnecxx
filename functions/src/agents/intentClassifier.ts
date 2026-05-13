import Anthropic from "@anthropic-ai/sdk";

export type Intent = "STOP" | "TASK_REPLY" | "QUESTION" | "PERMISSION_UPDATE" | "REBOOK_REQUEST" | "CANCEL_REQUEST";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// CANCEL is intentionally NOT here — it cancels a visit, not the account
const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "END"]);

export async function classifyIntent(
  text: string,
  hasPendingTask: boolean
): Promise<Intent> {
  const trimmed = text.trim().toUpperCase();

  if (STOP_WORDS.has(trimmed)) return "STOP";
  if (trimmed === "CANCEL") return "CANCEL_REQUEST";
  if (hasPendingTask && ["1", "2", "3"].includes(trimmed)) return "TASK_REPLY";

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system:
        "You classify a message sent to an AI care assistant named Cara. " +
        "Reply with exactly one word from this list: STOP, TASK_REPLY, PERMISSION_UPDATE, REBOOK_REQUEST, CANCEL_REQUEST, QUESTION.\n" +
        "STOP = opting out of all messages.\n" +
        "TASK_REPLY = responding to a numbered list or YES/NO approval.\n" +
        "PERMISSION_UPDATE = asking to stop/start/change a setting (e.g. 'stop weekly summaries').\n" +
        "REBOOK_REQUEST = asking to rebook a caregiver (e.g. 'book Maria again next week').\n" +
        "CANCEL_REQUEST = asking to cancel an upcoming visit (e.g. 'cancel Wednesday', 'cancel tomorrow's visit').\n" +
        "QUESTION = anything else.",
      messages: [{ role: "user", content: text }],
    });

    const label = (
      (response.content[0] as { text: string }).text ?? ""
    ).trim().toUpperCase() as Intent;

    if (["STOP", "TASK_REPLY", "PERMISSION_UPDATE", "REBOOK_REQUEST", "CANCEL_REQUEST", "QUESTION"].includes(label)) {
      return label;
    }
  } catch (err) {
    console.error("intentClassifier error:", err);
  }

  return "QUESTION";
}
