import Anthropic from "@anthropic-ai/sdk";

export type Intent = "STOP" | "TASK_REPLY" | "QUESTION";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "CANCEL", "END"]);

export async function classifyIntent(
  text: string,
  hasPendingTask: boolean
): Promise<Intent> {
  const trimmed = text.trim().toUpperCase();

  // Hard-coded STOP check — no Claude call needed
  if (STOP_WORDS.has(trimmed)) return "STOP";

  // Hard-coded numeric reply check when a task is pending
  if (hasPendingTask && ["1", "2", "3"].includes(trimmed)) return "TASK_REPLY";

  // Fast Claude classification for everything else
  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system:
        "You classify a family member's text to a care assistant. " +
        'Reply with exactly one word: STOP, TASK_REPLY, or QUESTION. ' +
        "STOP = opting out. TASK_REPLY = responding to a numbered list. QUESTION = anything else.",
      messages: [{ role: "user", content: text }],
    });

    const label = (
      (response.content[0] as { text: string }).text ?? ""
    ).trim().toUpperCase() as Intent;

    if (["STOP", "TASK_REPLY", "QUESTION"].includes(label)) return label;
  } catch (err) {
    console.error("intentClassifier error:", err);
  }

  return "QUESTION";
}
