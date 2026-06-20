import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";

const db = admin.firestore();

// ── confirmAgentTask — token-scoped quick-confirm callable ──────────────────
//
// The QuickConfirmPage (components/pages/QuickConfirmPage.tsx) is a public,
// unauthenticated magic-link page: the family taps a link Cara texted them to
// confirm a replacement/booking. The ONLY auth factor is the opaque
// `confirmToken` carried in the URL.
//
// Previously the page wrote `agent_tasks/{id}.status = "completed"` and an
// `agent_approvals` record DIRECTLY via the web SDK. That required broad
// client write access to high-risk agent collections (anyone authenticated —
// or, with the page being public, effectively anyone — could mutate arbitrary
// agent_tasks). This callable moves that mutation server-side: the page reads
// the token-scoped task (rules allow token-where reads only) and calls here to
// commit the confirmation. The collections are now server-write-only.
//
const TOKEN_RE = /^[A-Za-z0-9]{6,128}$/;

// ── getAgentTaskByToken — token-scoped read for the public confirm page ─────
//
// The page renders the chosen caregiver/time from the task. Doing the lookup
// here (instead of a public Firestore `where('confirmToken','==')` list query)
// keeps agent_tasks fully admin/server-scoped in firestore.rules — the public
// page never touches the collection directly. Returns ONLY the single
// token-matched doc, and only the fields the page renders.
export const getAgentTaskByToken = functions.https.onCall(async (data) => {
  const token = (data?.token as string | undefined)?.trim();
  if (!token || !TOKEN_RE.test(token)) {
    throw new functions.https.HttpsError("invalid-argument", "A valid confirmation token is required.");
  }

  const snap = await db
    .collection("agent_tasks")
    .where("confirmToken", "==", token)
    .limit(1)
    .get();

  if (snap.empty) {
    throw new functions.https.HttpsError("not-found", "This confirmation link is invalid.");
  }

  const task = snap.docs[0].data() as Record<string, any>;

  if (task.status === "completed") {
    return { status: "completed" as const };
  }
  if (task.expiresAt && new Date(task.expiresAt) < new Date()) {
    return { status: "expired" as const };
  }

  const idx    = (task.selectedIdx as number | undefined) ?? 0;
  const chosen = Array.isArray(task.options) ? task.options[idx] : undefined;

  return {
    status: "ready" as const,
    time:   task.time ?? null,
    selected: chosen
      ? {
          caregiverId:      chosen.caregiverId ?? null,
          name:             chosen.name ?? null,
          rating:           chosen.rating ?? null,
          hourlyRate:       chosen.hourlyRate ?? null,
          previouslyBooked: chosen.previouslyBooked ?? false,
        }
      : null,
  };
});

// Idempotent: a second confirm of an already-completed task is a no-op success.
export const confirmAgentTask = functions.https.onCall(async (data) => {
  const token = (data?.token as string | undefined)?.trim();
  if (!token || !TOKEN_RE.test(token)) {
    throw new functions.https.HttpsError("invalid-argument", "A valid confirmation token is required.");
  }

  // The token IS the credential — look the task up by it (never by caller-supplied id).
  const snap = await db
    .collection("agent_tasks")
    .where("confirmToken", "==", token)
    .limit(1)
    .get();

  if (snap.empty) {
    throw new functions.https.HttpsError("not-found", "This confirmation link is invalid.");
  }

  const taskDoc = snap.docs[0];
  const task    = taskDoc.data() as Record<string, any>;

  // Already confirmed → idempotent no-op (handles SMS/web double-tap retries).
  if (task.status === "completed") {
    return { success: true, alreadyConfirmed: true };
  }

  // Expired tokens cannot be confirmed.
  if (task.expiresAt && new Date(task.expiresAt) < new Date()) {
    throw new functions.https.HttpsError("deadline-exceeded", "This confirmation link has expired.");
  }

  const idx     = (task.selectedIdx as number | undefined) ?? 0;
  const chosen  = Array.isArray(task.options) ? task.options[idx] : undefined;

  // Atomically claim the task so concurrent confirms (web tap + SMS reply) don't
  // both record an approval.
  const claimed = await db.runTransaction(async (t) => {
    const fresh = await t.get(taskDoc.ref);
    if (!fresh.exists) return false;
    const fd = fresh.data() as Record<string, any>;
    if (fd.status === "completed") return false;
    t.update(taskDoc.ref, { status: "completed", confirmedAt: new Date().toISOString() });
    return true;
  });

  if (!claimed) {
    return { success: true, alreadyConfirmed: true };
  }

  // Record the human approval (server-side; agent_approvals is server-write-only).
  await db.collection("agent_approvals").add({
    taskId:              taskDoc.id,
    selectedCaregiverId: chosen?.caregiverId ?? null,
    selectedCaregiver:   chosen?.name ?? null,
    humanApproved:       true,
    approvedAt:          new Date().toISOString(),
    source:              "quick_confirm_page",
  });

  return { success: true, caregiverName: chosen?.name ?? null };
});
