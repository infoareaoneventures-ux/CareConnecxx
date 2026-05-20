import * as functions from "firebase-functions";
import Anthropic from "@anthropic-ai/sdk";
import { checkRateLimit } from "./rateLimit";

const ALLOWED_MODELS = new Set([
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
]);

let _claude: Anthropic | null = null;
function getClaude(): Anthropic {
  if (!_claude) _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

export const aiProxy = functions.https.onCall(async (data, context) => {
  if (!context.auth?.uid) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }

  const {
    system,
    user,
    model = "claude-haiku-4-5-20251001",
    maxTokens = 1000,
  } = data as {
    system: string;
    user: string;
    model?: string;
    maxTokens?: number;
  };

  if (!system || !user) {
    throw new functions.https.HttpsError("invalid-argument", "system and user are required");
  }

  if (!ALLOWED_MODELS.has(model)) {
    throw new functions.https.HttpsError("invalid-argument", `Model ${model} not allowed`);
  }

  const rateResult = await checkRateLimit(context.auth.uid, {
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "rl:aiProxy:",
  });

  if (!rateResult.allowed) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Rate limit exceeded. Try again in a minute."
    );
  }

  let response: Awaited<ReturnType<Anthropic["messages"]["create"]>>;
  try {
    response = await getClaude().messages.create({
      model,
      max_tokens: Math.min(maxTokens, 2000),
      system,
      messages: [{ role: "user", content: user }],
    });
  } catch (err) {
    console.error("aiProxy: Anthropic API error", err);
    throw new functions.https.HttpsError("internal", "AI service unavailable. Please try again.");
  }

  return { text: (response.content[0] as { text: string }).text ?? "" };
});
