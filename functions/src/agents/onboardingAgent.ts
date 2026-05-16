import * as functions from "firebase-functions";

// startSignup callable removed — new users are created in the webhook handler
// when they text "Hey Cara" first (MO consent). See linq/webhooks.ts handleInbound.

export const markTaskComplete = functions.https.onCall(async (data) => {
  const token  = (data?.token  ?? "").toString().trim();
  const taskId = (data?.taskId ?? "").toString().trim();

  if (!token) throw new functions.https.HttpsError("invalid-argument", "token required");

  const { verifyToken } = await import("./tokenService");
  const payload = verifyToken(token);
  if (!payload) throw new functions.https.HttpsError("unauthenticated", "invalid or expired token");

  const { advanceOnboardingStep } = await import("./onboardingConversation");
  await advanceOnboardingStep(payload.phone, payload.task, taskId ?? "");

  return { status: "ok" };
});
