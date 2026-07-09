import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { randomUUID } from "crypto";

// startSignup callable removed — new users are created in the webhook handler
// when they text "Hey Evia" first (MO consent). See linq/webhooks.ts handleInbound.

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

// Token-authenticated file upload for the /upload/photo and /upload/document
// pages. The caregiver arriving from an SMS link has NO Firebase Auth session,
// so a client-side Storage write is always rejected by storage.rules — the
// signed onboarding JWT is the auth here, and the Admin SDK performs the write.
// Advances onboarding in the same call (no separate markTaskComplete needed).
const UPLOAD_MAX_BYTES = 6 * 1024 * 1024; // callable body caps at 10MB; base64 inflates ~1.37x
const UPLOAD_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

export const uploadOnboardingFile = functions
  .runWith({ memory: "512MB", timeoutSeconds: 120 })
  .https.onCall(async (data) => {
    const token       = (data?.token ?? "").toString().trim();
    const dataBase64  = (data?.dataBase64 ?? "").toString();
    const contentType = (data?.contentType ?? "").toString().trim().toLowerCase();

    if (!token)      throw new functions.https.HttpsError("invalid-argument", "token required");
    if (!dataBase64) throw new functions.https.HttpsError("invalid-argument", "file data required");

    const { verifyToken } = await import("./tokenService");
    const payload = verifyToken(token);
    if (!payload) throw new functions.https.HttpsError("unauthenticated", "invalid or expired token");

    const isPhoto = payload.task === "photo_upload";
    if (!isPhoto && payload.task !== "doc_upload") {
      throw new functions.https.HttpsError("permission-denied", "token not valid for file upload");
    }

    const typeOk = isPhoto
      ? contentType.startsWith("image/")
      : contentType.startsWith("image/") || contentType === "application/pdf";
    if (!typeOk) {
      throw new functions.https.HttpsError("invalid-argument", "unsupported file type");
    }

    const buf = Buffer.from(dataBase64, "base64");
    if (!buf.length) throw new functions.https.HttpsError("invalid-argument", "file data empty or unreadable");
    if (buf.length > UPLOAD_MAX_BYTES) {
      throw new functions.https.HttpsError("invalid-argument", "file too large (6MB max)");
    }

    const ext    = UPLOAD_EXT[contentType] ?? (isPhoto ? "jpg" : "pdf");
    const digits = payload.phone.replace(/\D/g, "");
    const path   = `${isPhoto ? "profile_photos" : "caregiver_docs"}/onboarding/${digits}_${Date.now()}.${ext}`;

    // Download-token URL: readable regardless of storage.rules, no IAM signBlob needed.
    const downloadToken = randomUUID();
    const bucket = admin.storage().bucket();
    await bucket.file(path).save(buf, {
      contentType,
      metadata: { metadata: { firebaseStorageDownloadTokens: downloadToken } },
    });
    const url =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}` +
      `/o/${encodeURIComponent(path)}?alt=media&token=${downloadToken}`;

    const { advanceOnboardingStep } = await import("./onboardingConversation");
    await advanceOnboardingStep(payload.phone, payload.task, url);

    return { status: "ok", url };
  });
