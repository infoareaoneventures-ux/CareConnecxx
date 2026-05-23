import { quickComplete } from "../utils/openaiClient";
import { safeParseJson } from "../utils/jsonUtils";

export type HealthSeverity = "none" | "watch" | "flag";

export interface HealthSignalResult {
  signals:  string[];
  severity: HealthSeverity;
  summary:  string;
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
    summary:  "",
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const raw = await quickComplete(SYSTEM_PROMPT, contextText, {
      maxTokens: 300,
      signal:    controller.signal,
    });
    clearTimeout(timer);

    const parsed = safeParseJson<HealthSignalResult>(raw, "detectHealthSignals", null, "object");
    if (!parsed) return fallback;

    if (!["none", "watch", "flag"].includes(parsed.severity)) {
      parsed.severity = "none";
    }
    parsed.signals = Array.isArray(parsed.signals) ? parsed.signals : [];
    parsed.summary = typeof parsed.summary === "string" ? parsed.summary : "";

    return parsed;
  } catch (err) {
    console.error("healthSignalDetector error:", err);
    return fallback;
  }
}
