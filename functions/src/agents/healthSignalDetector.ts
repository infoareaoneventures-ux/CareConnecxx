import Anthropic from "@anthropic-ai/sdk";

export type HealthSeverity = "none" | "watch" | "flag";

export interface HealthSignalResult {
  signals:  string[];
  severity: HealthSeverity;
  summary:  string;
}

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const SYSTEM_PROMPT = `You are a health signal detector reviewing a caregiver's visit notes for a senior.

Extract any concerning health observations and classify severity.

Respond with valid JSON only, no markdown:
{
  "signals": ["list of specific health observations, empty if none"],
  "severity": "none | watch | flag",
  "summary": "1-2 sentence warm summary suitable to send to a family member"
}

Severity guide:
- none: normal visit, no health concerns
- watch: mild concern worth monitoring (e.g. lighter appetite, mild fatigue)
- flag: notable concern worth mentioning to a doctor (e.g. pain, confusion, fall, medication refusal, significant mood change)

Never diagnose. Never use clinical language. Write summary as if texting a caring friend.`;

export async function detectHealthSignals(
  notes: string,
  wellness: { ateWell?: boolean; tookMeds?: boolean; wasActive?: boolean; mood?: string },
  activities: string[]
): Promise<HealthSignalResult> {
  const fallback: HealthSignalResult = {
    signals:  [],
    severity: "none",
    summary:  "Visit completed. Caregiver notes have been logged.",
  };

  if (!notes?.trim() && !wellness) return fallback;

  const contextText = [
    notes ? `Caregiver notes: ${notes}` : "",
    `Wellness: ate well=${wellness?.ateWell}, took meds=${wellness?.tookMeds}, was active=${wellness?.wasActive}, mood=${wellness?.mood ?? "unknown"}`,
    activities?.length ? `Activities: ${activities.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await getClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: "user", content: contextText }],
    });

    const raw = ((response.content[0] as { text: string }).text ?? "").trim();
    const parsed = JSON.parse(raw) as HealthSignalResult;

    if (!["none", "watch", "flag"].includes(parsed.severity)) {
      parsed.severity = "none";
    }

    return parsed;
  } catch (err) {
    console.error("healthSignalDetector error:", err);
    return fallback;
  }
}
