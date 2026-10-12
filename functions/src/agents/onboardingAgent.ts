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

  // stripe_connect: landing on /done proves NOTHING — Stripe fires return_url
  // on flow exit (completed or abandoned) and refresh_url on dead links. Only
  // the account's own charges/payouts flags count. Without this gate a mere
  // page visit activated the caregiver ("payouts are ready to go") with no
  // payout account behind it (founder repro, 2026-07-09).
  if (payload.task === "stripe_connect") {
    const { verifyStripeConnectComplete } = await import("./onboardingConversation");
    const check = await verifyStripeConnectComplete(payload.phone);
    if (check.status !== "complete") {
      return {
        status:    check.status,
        finishUrl: check.status === "incomplete" ? check.finishUrl : null,
      };
    }
  }

  const { advanceOnboardingStep } = await import("./onboardingConversation");
  await advanceOnboardingStep(payload.phone, payload.task, taskId ?? "");

  return { status: "ok" };
});

// Stripe redirects expired/already-visited account links to the refresh_url.
// Its contract: mint a FRESH account link and put the user back into hosted
// onboarding. Served at /stripe-refresh via a hosting rewrite. (Account links
// are single-use, and iMessage's link-preview fetch can consume one before the
// caregiver ever taps — so this path is hit routinely, not just on timeouts.)
export const stripeConnectRefresh = functions
  .runWith({ timeoutSeconds: 30 })
  .https.onRequest(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const token = (req.query.t ?? "").toString().trim();

    const { verifyToken } = await import("./tokenService");
    const payload = token ? verifyToken(token) : null;
    if (!payload || payload.task !== "stripe_connect") {
      res.status(410).send(refreshFallbackHtml(
        "This payout setup link has expired",
        "No worries — just reply to Evia's text and ask for your payout link. She'll send a fresh one right away."
      ));
      return;
    }

    const { mintStripeConnectAccountLink } = await import("./onboardingConversation");
    const url = await mintStripeConnectAccountLink(payload.phone);
    if (!url) {
      res.status(500).send(refreshFallbackHtml(
        "We couldn't open payout setup",
        "Something hiccuped on our end. Reply to Evia's text and she'll send you a fresh payout setup link."
      ));
      return;
    }
    res.redirect(302, url);
  });

function refreshFallbackHtml(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — Evia</title></head>` +
    `<body style="font-family:-apple-system,system-ui,sans-serif;background:#faf9f6;color:#1a1a1a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center">` +
    `<div style="max-width:22rem"><h1 style="font-size:1.4rem;margin-bottom:.75rem">${title}</h1>` +
    `<p style="line-height:1.5;color:#444">${body}</p></div></body></html>`;
}

// Token-authenticated file upload for the /upload/photo
// pages. The caregiver arriving from an SMS link has NO Firebase Auth session,
// so a client-side Storage write is always rejected by storage.rules — the
// signed onboarding JWT is the auth here, and the Admin SDK performs the write.
// Advances onboarding in the same call (no separate markTaskComplete needed).
// The site's limit (documentUpload.ts MAX_FILE_SIZE_MB / the wizard's PhotoStep): 5 MB (sweep C19, 2026-10-11).
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const UPLOAD_MAX_LABEL = "5MB";
/** The profile page's Storage path for a caregiver's photo (components/ui/AvatarUpload.tsx, storageFolder "caregivers") — the ONE path both doors write (2026-10-11). */
export const CAREGIVER_PROFILE_PHOTO_PATH = (uid: string) => `profile-photos/caregivers/${uid}`;
const UPLOAD_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

// Token-authenticated FCRA consent submit for the /bgcheck page (webapp
// parity with initiateCheckrCandidate in checkr.ts — same disclosure, same
// consent record, same "Checkr emails you" handoff; the signed onboarding JWT
// stands in for Firebase Auth, exactly like uploadOnboardingFile above).
// Field validation mirrors the webapp callable's checks.
export const confirmBgcheckOnboarding = functions
  .runWith({ timeoutSeconds: 60 })
  .https.onCall(async (data) => {
    const token          = (data?.token ?? "").toString().trim();
    const legalFirstName = (data?.legalFirstName ?? "").toString().trim();
    const legalLastName  = (data?.legalLastName ?? "").toString().trim();
    const zipCode        = (data?.zipCode ?? "").toString().trim();
    const state          = (data?.state ?? "").toString().trim().toUpperCase();
    const consentGiven   = data?.consentGiven === true;

    if (!token) throw new functions.https.HttpsError("invalid-argument", "token required");
    if (!consentGiven) throw new functions.https.HttpsError("failed-precondition", "Consent is required.");
    if (!legalFirstName || !legalLastName || !zipCode || !state) {
      throw new functions.https.HttpsError("invalid-argument", "Missing required fields.");
    }
    if (legalFirstName.length > 50 || legalLastName.length > 50) {
      throw new functions.https.HttpsError("invalid-argument", "Name fields must be 50 characters or less.");
    }
    if (!/^\d{5}(-\d{4})?$/.test(zipCode)) {
      throw new functions.https.HttpsError("invalid-argument", "Invalid ZIP code format.");
    }
    if (!/^[A-Z]{2}$/.test(state)) {
      throw new functions.https.HttpsError("invalid-argument", "Invalid state.");
    }

    const { verifyToken } = await import("./tokenService");
    const payload = verifyToken(token);
    if (!payload) throw new functions.https.HttpsError("unauthenticated", "invalid or expired token");
    if (payload.task !== "bgcheck_consent") {
      throw new functions.https.HttpsError("permission-denied", "token not valid for background-check consent");
    }

    try {
      const { confirmBgcheckConsent } = await import("./onboardingConversation");
      const result = await confirmBgcheckConsent(payload.phone, {
        legalFirstName, legalLastName, zipCode, state,
      });
      return { status: result.status };
    } catch (err) {
      if (err instanceof functions.https.HttpsError) throw err;
      if ((err as { code?: string })?.code === "membership_required") throw new functions.https.HttpsError("failed-precondition", (err as Error).message);
      console.error("confirmBgcheckOnboarding error:", err);
      throw new functions.https.HttpsError("internal", "Background check initiation failed.");
    }
  });

export const uploadOnboardingFile = functions
  .runWith({ memory: "512MB", timeoutSeconds: 120 })
  .https.onCall(async (data) => {
    const token        = (data?.token ?? "").toString().trim();
    const dataBase64   = (data?.dataBase64 ?? "").toString();
    const contentType  = (data?.contentType ?? "").toString().trim().toLowerCase();
    const fileName     = (data?.fileName ?? "").toString().trim().slice(0, 120);

    if (!token)      throw new functions.https.HttpsError("invalid-argument", "token required");
    if (!dataBase64) throw new functions.https.HttpsError("invalid-argument", "file data required");

    const { verifyToken } = await import("./tokenService");
    const payload = verifyToken(token);
    if (!payload) throw new functions.https.HttpsError("unauthenticated", "invalid or expired token");

    // Photo only (2026-10-06): transport documents are no longer collected —
    // Transportation is the service on the profile plus the driving record
    // (MVR), which runs with the membership. An old doc_upload token is refused.
    if (payload.task !== "photo_upload") {
      throw new functions.https.HttpsError("permission-denied", "token not valid for file upload");
    }
    if (!contentType.startsWith("image/")) {
      throw new functions.https.HttpsError("invalid-argument", "unsupported file type");
    }

    const buf = Buffer.from(dataBase64, "base64");
    if (!buf.length) throw new functions.https.HttpsError("invalid-argument", "file data empty or unreadable");
    if (buf.length > UPLOAD_MAX_BYTES) {
      throw new functions.https.HttpsError("invalid-argument", `file too large (${UPLOAD_MAX_LABEL} max)`);
    }

    // Same record AND same path the site writes: the profile page's
    // AvatarUpload stores the photo at profile-photos/caregivers/{uid} (one
    // object, overwritten on a new upload) and writes caregivers/{uid}.photo —
    // the ONE photo path for both doors (sweep C7, 2026-10-11; the old
    // caregivers/{uid}/documents/profilePhoto_* file + `documents` map are
    // gone). The caregiver doc exists from the first "Hey Evia"
    // (ensureCaregiverDocForOnboarding).
    const { ensureCaregiverDocForOnboarding } = await import("./onboardingConversation");
    const uid = await ensureCaregiverDocForOnboarding(payload.phone);
    if (!uid) throw new functions.https.HttpsError("failed-precondition", "caregiver account not ready — text Evia and try the link again");

    const ext    = UPLOAD_EXT[contentType] ?? "jpg";
    const safeName = (fileName || `profilePhoto.${ext}`).replace(/[^a-zA-Z0-9.-]/g, "_");
    const path   = CAREGIVER_PROFILE_PHOTO_PATH(uid);

    // Download-token URL: readable regardless of storage.rules, no IAM signBlob needed.
    const downloadToken = randomUUID();
    const bucket = admin.storage().bucket();
    await bucket.file(path).save(buf, {
      contentType,
      metadata: {
        metadata: {
          firebaseStorageDownloadTokens: downloadToken,
          uploadedBy: uid, uploadTime: new Date().toISOString(), originalName: safeName,
        },
      },
    });
    const url =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}` +
      `/o/${encodeURIComponent(path)}?alt=media&token=${downloadToken}`;

    // `photo` is what the profile page writes; photoURL / profilePhoto are the
    // readers' mirrors (caregiverProfileMirror.ts writes the same three from the
    // session on the advance below).
    const db = admin.firestore();
    await db.collection("caregivers").doc(uid).set(
      { photo: url, photoURL: url, profilePhoto: url },
      { merge: true },
    );

    const { advanceOnboardingStep } = await import("./onboardingConversation");
    await advanceOnboardingStep(payload.phone, payload.task, url);

    return { status: "ok", url, type: "profilePhoto" };
  });
