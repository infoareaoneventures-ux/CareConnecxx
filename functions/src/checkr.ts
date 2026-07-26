import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { claimWebhookEvent, settleWebhookEvent, CHECKR_EVENTS_COLLECTION } from "./utils/webhookLedger";
import { checkrPost } from "./checkrApi";
import { assertMvrCheckConfig } from "./mvrConfig";
import { writeCaregiverBackgroundPII } from "./caregiverPrivate";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// Essential Criminal: county criminal (7yr), global watchlist, national criminal
// (standard), sex offender, SSN trace, motor vehicle report.
const CHECKR_PACKAGE = process.env.CHECKR_PACKAGE || "checkrdirect_essential_criminal";

type CheckrStatus = "pending" | "clear" | "consider" | "suspended" | "canceled";

// checkrPost / candidate+invitation creation live in checkrApi.ts — the ONE
// place that talks to the Checkr REST API (shared with the SMS onboarding flow).

// Official guide (p.17): check assessment first, then result. Use status only for suspension.
function mapCheckrResult(payload: Record<string, any>): CheckrStatus {
  if (payload.status === "suspended") return "suspended";
  const effective = payload.assessment || payload.result;
  if (effective === "clear" || effective === "eligible") return "clear";
  if (effective === "consider" || effective === "review" || effective === "escalated") return "consider";
  return "pending";
}

export const initiateCheckrCandidate = functions.runWith({}).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be logged in.");
  }

  const { legalFirstName, legalLastName, zipCode, state, consentGiven } = data || {};
  const email = context.auth.token.email;
  const uid = context.auth.uid;

  console.log("initiateCheckrCandidate called", {
    uid,
    hasEmail: !!email,
    hasFirst: !!legalFirstName,
    hasLast: !!legalLastName,
    hasZip: !!zipCode,
    hasState: !!state,
    consent: consentGiven,
    apiKey: !!(process.env.CHECKR_API_KEY || "").trim(),
    apiUrl: process.env.CHECKR_API_URL || "(default)",
    pkg: process.env.CHECKR_PACKAGE || "(default)",
  });

  if (consentGiven !== true) {
    throw new functions.https.HttpsError("failed-precondition", "Consent is required.");
  }
  if (!legalFirstName || !legalLastName || !zipCode) {
    throw new functions.https.HttpsError("invalid-argument", "Missing required fields.");
  }
  if (typeof legalFirstName !== "string" || typeof legalLastName !== "string" || typeof zipCode !== "string") {
    throw new functions.https.HttpsError("invalid-argument", "Fields must be strings.");
  }
  if (legalFirstName.length > 50 || legalLastName.length > 50) {
    throw new functions.https.HttpsError("invalid-argument", "Name fields must be 50 characters or less.");
  }
  if (!/^\d{5}(-\d{4})?$/.test(zipCode)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid ZIP code format.");
  }
  if (!email) {
    throw new functions.https.HttpsError("failed-precondition", "Caregiver must have an email on file.");
  }

  try {
    // Read existing caregiver doc for idempotency check and location data
    const caregiverSnap = await db.collection("caregivers").doc(uid).get();
    const bgData = caregiverSnap.data()?.backgroundCheckData || {};
    const existingCandidateId: string | undefined = bgData.checkrCandidateId;
    const invitationStatus: string | undefined = bgData.invitationStatus;

    // Block duplicate submissions unless the invitation expired or was canceled
    if (existingCandidateId && invitationStatus !== "expired" && invitationStatus !== "canceled") {
      return { success: true, candidateId: existingCandidateId };
    }

    // Build work_locations from form data or profile fallback (REQUIRED by Checkr for US checks)
    const caregiverData = caregiverSnap.data() || {};
    const workState: string = (typeof state === "string" && state.trim()) || caregiverData.state || "";
    const workCity: string = caregiverData.city || "";
    const workLocations = workState
      ? [{ country: "US", state: workState.toUpperCase(), ...(workCity && { city: workCity }) }]
      : [];

    // Date-scoped idempotency key prevents duplicate candidates on same-day retries
    const dateKey = new Date().toISOString().slice(0, 10);

    // Reuse existing candidate record if re-inviting after expiry — avoids duplicate Checkr records
    let candidateId = existingCandidateId;
    if (!candidateId) {
      const candidateBody: Record<string, unknown> = {
        first_name: legalFirstName,
        last_name: legalLastName,
        email,
        zipcode: zipCode,
        custom_id: uid,
        // Do NOT send no_middle_name — locks the field on the Checkr invitation form (official guide p.10)
      };
      if (workLocations.length) candidateBody.work_locations = workLocations;

      const candidate = await checkrPost("/candidates", candidateBody, `${uid}-candidate-${dateKey}`);
      candidateId = candidate.id as string;
    }

    const mvrPaid = caregiverData.mvrPaid === true;
    // assertMvrCheckConfig throws if the MVR package is unset or equals the base
    // package — a loud failure beats silently running a non-MVR check after charging.
    const selectedPackage = mvrPaid ? assertMvrCheckConfig("bundled") : CHECKR_PACKAGE;
    const invitationBody: Record<string, unknown> = {
      candidate_id: candidateId,
      package: selectedPackage,
    };
    if (workLocations.length) invitationBody.work_locations = workLocations;

    const invitation = await checkrPost("/invitations", invitationBody, `${uid}-invitation-${dateKey}`);
    const invitationUrl: string | undefined = invitation?.invitation_url;

    // Identity PII (legal name, ZIP) goes to the owner/admin-only private
    // subcollection — NOT the world-readable parent doc. Operational fields
    // stay on the parent for agent gating + the admin verification query.
    await writeCaregiverBackgroundPII(uid, { legalFirstName, legalLastName, zip: zipCode });
    await db.collection("caregivers").doc(uid).set({
      backgroundCheckData: {
        checkrCandidateId: candidateId,
        consentGiven: true,
        submittedAt: new Date().toISOString(),
        status: "pending",
        invitationStatus: "sent",
        ...(invitationUrl && { invitationUrl }),
        ...(mvrPaid && { mvrIncluded: true }),
      },
    }, { merge: true });

    return { success: true, candidateId, invitationUrl };
  } catch (error: any) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error("Checkr initiate error:", error?.message, error?.code, JSON.stringify(error));
    throw new functions.https.HttpsError("internal", "Background check initiation failed.");
  }
});

function verifyCheckrSignature(rawBody: Buffer, signature: unknown, secret: string): boolean {
  if (typeof signature !== "string" || signature.length === 0) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = Buffer.from(signature);
  const calc = Buffer.from(expected);
  if (given.length !== calc.length) return false;
  try {
    return crypto.timingSafeEqual(given, calc);
  } catch {
    return false;
  }
}

async function createCaregiverNotification(userId: string, title: string, body: string): Promise<void> {
  try {
    await db.collection("users").doc(userId).collection("notifications").add({
      title,
      body,
      type: "system",
      isRead: false,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.error("createCaregiverNotification failed:", err);
    }
  }
}

async function findCaregiverUidByCandidateId(candidateId: string): Promise<string | null> {
  const snap = await db.collection("caregivers")
    .where("backgroundCheckData.checkrCandidateId", "==", candidateId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].id;
}

// Deliver a bad-news background-check notice (consider / suspended / disputed) to
// the caregiver. These are compliance-adjacent and must reach the caregiver even
// when no agent session exists yet — the legacy web-onboarded cohort never texted
// Evia, so sendViaInteractionAgent (which returns early on a missing session doc)
// would silently drop them. Session present → interaction agent (supervisor lint,
// audit, immediate/canDrop:false flags). No session → sendToPhone, which creates
// the chat, seeds the session, and enforces STOP opt-out itself. Any outcome that
// is neither sent nor queued pages ops so the miss is never silent.
async function sendBgcheckNoticeToCaregiver(
  phone: string,
  caregiverUid: string,
  content: string,
): Promise<void> {
  const sessSnap = await db.collection("agent_sessions").doc(phone).get();
  if (sessSnap.exists) {
    const { sendViaInteractionAgent } = await import("./agents/caraAgent");
    await sendViaInteractionAgent(phone, {
      content,
      urgency:     "immediate",
      sourceAgent: "checkr_status",
      canDrop:     false,
    });
    return;
  }
  const { sendToPhone } = await import("./linq/client");
  // sendToPhone RETHROWS chat-creation failures (the session-less path has no
  // dead-letter, unlike existing-chat sends) — a throw is a miss too, and must
  // page ops the same as a dropped outcome instead of dying in the branch's
  // outer console.error catch.
  let outcome: string;
  try {
    outcome = await sendToPhone(phone, content);
  } catch (err) {
    console.error("sendBgcheckNoticeToCaregiver sendToPhone error:", err instanceof Error ? err.message : err);
    outcome = "send_error";
  }
  if (outcome !== "sent" && outcome !== "queued") {
    // "skipped_opt_out" is a deliberate STOP; "dropped" is a circuit-open drop.
    // Either way a human must follow up out-of-band — the caregiver got nothing.
    await db.collection("admin_alerts").add({
      type:        "bgcheck_notice_undelivered",
      caregiverId: caregiverUid,
      phone,
      outcome,
      preview:     content.slice(0, 120),
      createdAt:   new Date().toISOString(),
      resolved:    false,
      severity:    "high",
    });
  }
}

/**
 * Initiate a standalone MVR-only Checkr check for a caregiver who added the
 * Approved Driver upgrade after signup. Reuses the caregiver's existing Checkr
 * candidate and runs the MVR-only package. Idempotent: the `mvrCheckInitiated`
 * precondition plus a dedicated `*-mvr-invitation-*` idempotency-key namespace
 * mean a redelivered payment webhook never starts a second check. The resulting
 * report is routed by handleMvrReportEvent to the driver badge ONLY.
 *
 * Called from the Stripe payment-success webhook (web add-on and Evia SMS).
 */
export async function initiateMvrOnlyCheck(caregiverUid: string): Promise<void> {
  const snap = await db.collection("caregivers").doc(caregiverUid).get();
  if (!snap.exists) {
    console.error(`initiateMvrOnlyCheck: caregiver ${caregiverUid} not found`);
    return;
  }
  const cg = snap.data() || {};
  if (cg.mvrCheckInitiated === true) {
    console.log(`initiateMvrOnlyCheck: already initiated for ${caregiverUid}, skipping`);
    return;
  }
  const candidateId: string | undefined = cg.backgroundCheckData?.checkrCandidateId;
  if (!candidateId) {
    // Paid for MVR but no Checkr candidate exists yet — never silently lose the
    // purchase; surface it for an admin to resolve.
    await db.collection("admin_alerts").add({
      type:        "mvr_no_candidate",
      caregiverId: caregiverUid,
      createdAt:   new Date().toISOString(),
      resolved:    false,
      severity:    "high",
    }).catch(() => {});
    console.error(`initiateMvrOnlyCheck: no Checkr candidate for ${caregiverUid}; raised admin alert`);
    return;
  }

  // Validates config and throws if the MVR-only package is unset or equals the
  // base package (would run a non-MVR check after charging).
  const pkg = assertMvrCheckConfig("mvr_only");
  const dateKey = new Date().toISOString().slice(0, 10);
  const workState: string = (cg.state || "").trim();
  const workLocations = workState ? [{ country: "US", state: workState.toUpperCase() }] : [];
  const invBody: Record<string, unknown> = { candidate_id: candidateId, package: pkg };
  if (workLocations.length) invBody.work_locations = workLocations;

  await checkrPost("/invitations", invBody, `${caregiverUid}-mvr-invitation-${dateKey}`);

  await db.collection("caregivers").doc(caregiverUid).set({
    mvrPaid:           true,
    mvrCheckInitiated: true,
    mvrStatus:         "pending",
    mvrInitiatedAt:    new Date().toISOString(),
  }, { merge: true });

  console.log(`initiateMvrOnlyCheck: MVR-only invitation sent for ${caregiverUid}`);
}

/**
 * Handle a Checkr report event that belongs to the standalone MVR-only check.
 * THE WALL: writes ONLY `isApprovedDriver` / `mvrStatus` (+ report id / cleared
 * timestamp). It must never write verified / verificationStatus / status /
 * approvedAt / backgroundCheckStatus / backgroundCheckComplete — a driving
 * result can never alter a caregiver's core approval.
 */
async function handleMvrReportEvent(
  caregiverUid: string,
  type: string,
  payload: Record<string, any>,
): Promise<void> {
  const updates: Record<string, any> = {};
  // Persist the report id so subsequent events for this report match by id even
  // if a later payload omits the package slug.
  if (payload.id) updates["mvrReportId"] = payload.id;

  const status = mapCheckrResult(payload);
  updates["mvrStatus"] = status;

  if (status === "clear") {
    updates["isApprovedDriver"] = true;
    updates["mvrClearedAt"] = new Date().toISOString();
  } else if (
    status === "consider" ||
    status === "suspended" ||
    type === "report.pre_adverse_action" ||
    type === "report.post_adverse_action" ||
    type === "report.canceled"
  ) {
    // Any non-clear MVR outcome withholds/removes the badge — and nothing else.
    updates["isApprovedDriver"] = false;
  }
  // pending / other → leave isApprovedDriver untouched.

  await db.collection("caregivers").doc(caregiverUid).update(updates);

  // Best-effort caregiver notification — scoped to the driver badge, never framed
  // as affecting their core approval.
  try {
    if (status === "clear") {
      await createCaregiverNotification(
        caregiverUid,
        "You're an Approved Driver! 🚗",
        "Your driving record check came back clear — your Approved Driver badge is now active.",
      );
    } else if (status === "consider" || status === "suspended") {
      await createCaregiverNotification(
        caregiverUid,
        "Driver check needs review",
        "Your driving record check needs a closer look. This only affects the Approved Driver badge — your caregiver approval is unchanged.",
      );
    }
  } catch {
    /* notification is best-effort */
  }
}

export const checkrWebhook = functions.runWith({}).https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }
  const signature = req.headers["x-checkr-signature"];
  const webhookSecret = (process.env.CHECKR_WEBHOOK_SECRET || "").trim();
  // Fail closed: a missing secret is a server misconfiguration, NOT a reason to skip
  // verification. Without this, a forged `report.completed{result:"clear"}` could mark
  // an unvetted person as a verified/bookable caregiver. The only escape is the local
  // Functions emulator, where no real webhooks arrive.
  const isEmulator = !!process.env.FUNCTIONS_EMULATOR;
  if (!webhookSecret) {
    if (isEmulator) {
      console.warn("Checkr webhook: CHECKR_WEBHOOK_SECRET unset — skipping verification (emulator only).");
    } else {
      console.error("Checkr webhook rejected: CHECKR_WEBHOOK_SECRET is not set. Refusing to process unverified webhooks.");
      res.status(500).send("Webhook secret not configured");
      return;
    }
  } else if (!signature || !verifyCheckrSignature(req.rawBody, signature, webhookSecret)) {
    res.status(401).send("Invalid signature");
    return;
  }

  const event = req.body || {};
  const type: string = typeof event.type === "string" ? event.type : "";
  const payload: Record<string, any> = event?.data?.object || {};

  // Exactly-once guard — a replayed report.completed would otherwise re-fire
  // family notifications, re-advance Evia onboarding, and duplicate admin
  // alerts. Events without an id (unexpected shape) process without dedupe.
  const eventId: string | null = typeof event.id === "string" && event.id ? event.id : null;
  if (eventId) {
    if (await claimWebhookEvent(CHECKR_EVENTS_COLLECTION, eventId) === "duplicate") {
      res.status(200).json({ received: true, status: "already_processed" });
      return;
    }
  }
  const settle = (outcome: "processed" | "failed") =>
    eventId ? settleWebhookEvent(CHECKR_EVENTS_COLLECTION, eventId, outcome) : Promise.resolve();

  try {
    // candidate.* events carry the candidate in payload.id; all others reference it via candidate_id
    const lookupId: string | undefined = type.startsWith("candidate")
      ? payload.id
      : payload.candidate_id;

    if (!lookupId) {
      await settle("processed");
      res.status(200).json({ received: true, ignored: "no candidate reference" });
      return;
    }

    const caregiverUid = await findCaregiverUidByCandidateId(lookupId);
    if (!caregiverUid) {
      await settle("processed");
      res.status(200).json({ received: true, ignored: "caregiver not found" });
      return;
    }

    // ── MVR wall ────────────────────────────────────────────────────────────
    // A standalone MVR-only report governs ONLY the Approved Driver badge. Route
    // it out before the core dispatch so a driving result can never touch
    // verified / verificationStatus / status. Matched by the MVR-only package
    // slug (present from report.created onward) or a previously stored
    // mvrReportId. The signup bundled criminal+MVR report uses a DIFFERENT
    // package and intentionally flows through the core handling below.
    if (type.startsWith("report.")) {
      const mvrOnlyPkg = (process.env.CHECKR_PACKAGE_MVR_ONLY || "").trim();
      const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
      const storedMvrReportId: string | undefined = cgSnap.data()?.mvrReportId;
      const isMvrReport =
        (!!mvrOnlyPkg && typeof payload.package === "string" && payload.package === mvrOnlyPkg) ||
        (!!storedMvrReportId && payload.id === storedMvrReportId);
      if (isMvrReport) {
        await handleMvrReportEvent(caregiverUid, type, payload);
        await settle("processed");
        res.status(200).json({ received: true, mvr: true });
        return;
      }
    }

    const updates: Record<string, any> = {};
    let notificationPayload: { title: string; body: string } | null = null;

    if (type === "candidate.driver_license_required" || type === "candidate.driver_abstract_required") {
      updates["backgroundCheckData.status"] = "pending";
      notificationPayload = {
        title: "Driving record document required",
        body: "Checkr needs a driving record document to continue your background check. Check your email from Checkr for instructions.",
      };

    } else if (type === "candidate.id_required") {
      updates["backgroundCheckData.status"] = "pending";
      notificationPayload = {
        title: "ID verification required",
        body: "Checkr needs to verify your identity to continue your background check. Check your email from Checkr for instructions.",
      };

    } else if (type === "candidate.deferred") {
      updates["backgroundCheckData.status"] = "pending";
      notificationPayload = {
        title: "Background check deferred",
        body: "Your background check has been deferred. Check your email from Checkr or contact support for next steps.",
      };

    } else if (
      type === "candidate.created" ||
      type === "candidate.updated" ||
      type === "candidate.engaged" ||
      type === "candidate.pre_adverse_action" ||
      type === "candidate.post_adverse_action"
    ) {
      // Silently acknowledge — report-level events handle the meaningful state changes
      await settle("processed");
      res.status(200).json({ received: true, ignored: type });
      return;

    } else if (type === "invitation.created") {
      updates["backgroundCheckData.invitationStatus"] = "sent";
      // Persist the canonical apply link so "send me the link" flows can resend
      // the SAME invitation instead of minting a duplicate.
      if (typeof payload.invitation_url === "string" && payload.invitation_url) {
        updates["backgroundCheckData.invitationUrl"] = payload.invitation_url;
      }

    } else if (type === "invitation.completed") {
      updates["backgroundCheckData.invitationStatus"] = "completed";

    } else if (type === "invitation.expired") {
      updates["backgroundCheckData.invitationStatus"] = "expired";
      updates["backgroundCheckData.invitationUrl"] = admin.firestore.FieldValue.delete();
      notificationPayload = {
        title: "Verification link expired",
        body: "Your background check link expired after 7 days. Return to your dashboard to get a new link.",
      };
      // The cached link is dead — drop it from the Evia session too so the next
      // link request mints a fresh invitation instead of resending a dead URL,
      // and proactively tell the caregiver how to get a new one.
      try {
        const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
        const cgPhone = cgSnap.data()?.phone as string | undefined;
        if (cgPhone) {
          await db.collection("agent_sessions").doc(cgPhone).update({
            bgcheckInviteUrl: admin.firestore.FieldValue.delete(),
          }).catch(() => {});
          const { sendViaInteractionAgent } = await import("./agents/caraAgent");
          await sendViaInteractionAgent(cgPhone, {
            content:
              "Your background check link expired — no worries, it happens. " +
              "Reply here and I'll text you a fresh one right away.",
            urgency:     "standard",
            sourceAgent: "checkr_status",
            canDrop:     true,
          });
        }
      } catch (err) {
        console.error("invitation.expired cleanup error:", err);
      }

    } else if (type === "invitation.deleted" || type === "invitation.cancelled") {
      updates["backgroundCheckData.invitationStatus"] = "canceled";
      updates["backgroundCheckData.invitationUrl"] = admin.firestore.FieldValue.delete();
      try {
        const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
        const cgPhone = cgSnap.data()?.phone as string | undefined;
        if (cgPhone) {
          await db.collection("agent_sessions").doc(cgPhone).update({
            bgcheckInviteUrl: admin.firestore.FieldValue.delete(),
          }).catch(() => {});
        }
      } catch (err) {
        console.error("invitation cancel cleanup error:", err);
      }

    } else if (type === "verification.created") {
      updates["backgroundCheckData.status"] = "pending";
      updates["backgroundCheckData.invitationStatus"] = "awaiting_documents";
      notificationPayload = {
        title: "Document upload required",
        body: "Your background check is on hold. Check your email from Checkr — they need you to upload a document to continue.",
      };

    } else if (type === "verification.completed" || type === "verification.processed") {
      updates["backgroundCheckData.invitationStatus"] = "documents_submitted";

    } else if (type === "report.created") {
      updates["backgroundCheckData.checkrReportId"] = payload.id;
      updates["backgroundCheckData.status"] = mapCheckrResult(payload);

    } else if (
      type === "report.completed" ||
      type === "report.updated" ||
      type === "report.suspended" ||
      type === "report.engaged" ||
      type === "report.upgraded"
    ) {
      const status = mapCheckrResult(payload);
      updates["backgroundCheckData.status"] = status;
      if (payload.id) updates["backgroundCheckData.checkrReportId"] = payload.id;

      if (type === "report.completed") {
        updates["backgroundCheckData.completedAt"] = new Date().toISOString();
        if (payload.includes_canceled) {
          updates["backgroundCheckData.includesCanceled"] = true;
        }
      }

      if (status === "clear") {
        updates["verified"] = true;
        updates["verificationStatus"] = "approved";
        updates["status"] = "active";
        updates["approvedAt"] = new Date().toISOString();
        updates["backgroundCheckStatus"] = "clear";
        updates["backgroundCheckComplete"] = true;
        updates["backgroundCheckData.checkrClearedAt"] = new Date().toISOString();
        notificationPayload = {
          title: "Background check approved! 🎉",
          body: "Great news — your background check came back clear. You're approved and families can now book you!",
        };

        // Advance Evia onboarding if caregiver has an iMessage session; also mark approved driver if MVR was included
        try {
          const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
          const cgData = cgSnap.data();
          // Gate the badge on the top-level, webhook-only mvrPaid flag (locked in
          // firestore.rules) rather than the client-reachable
          // backgroundCheckData.mvrIncluded — otherwise a caregiver could smuggle
          // mvrIncluded:true via the profile-submission write and self-grant the badge.
          if (cgData?.mvrPaid === true) {
            updates["isApprovedDriver"] = true;
          }
          const cgPhone = cgData?.phone as string | undefined;
          if (cgPhone) {
            // advanceOnboardingStep dedupes on processedWebhookTasks, so for a
            // caregiver whose ORIGINAL check already advanced onboarding (renewal /
            // re-run), it silently no-ops — and the "I'll text you the moment
            // results come in" promise would go unfulfilled. Text them directly in
            // that case instead of relying on the onboarding state machine.
            const sessSnap = await db.collection("agent_sessions").doc(cgPhone).get();
            const processedTasks: string[] = sessSnap.data()?.processedWebhookTasks ?? [];
            if (processedTasks.includes("background_check")) {
              const { sendViaInteractionAgent } = await import("./agents/caraAgent");
              await sendViaInteractionAgent(cgPhone, {
                content:
                  `🎉 Great news — your background check just cleared. ` +
                  `You're approved on Evia and bookings are active again. Nothing else needed from you!`,
                urgency:     "standard",
                sourceAgent: "checkr_status",
                canDrop:     false,
              });
            } else {
              const { advanceOnboardingStep } = await import("./agents/onboardingConversation");
              await advanceOnboardingStep(cgPhone, "background_check", "");
            }
            // Flag so any follow-up reply routes to qaAgent with BG-check context
            await db.collection("agent_sessions").doc(cgPhone).update({
              pendingBgCheckAck:      "clear",
              pendingBgCheckAckSetAt: new Date().toISOString(),
            }).catch(() => {});
          }
        } catch (err) {
          console.error("advanceOnboardingStep(background_check) error:", err);
        }

        // Notify families who expressed interest while bg check was pending
        try {
          const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
          const cgName = cgSnap.data()?.name ?? "Your caregiver";

          const interestSnap = await db.collection("agent_tasks")
            .where("type",        "==", "caregiver_interest")
            .where("caregiverId", "==", caregiverUid)
            .where("status",      "==", "pending_bg_clear")
            .get();

          for (const taskDoc of interestSnap.docs) {
            const task = taskDoc.data();
            try {
              const { sendViaInteractionAgent } = await import("./agents/caraAgent");
              await sendViaInteractionAgent(task.clientPhone, {
                content:
                  `Good news! ${cgName}'s background check just cleared. ` +
                  `You can now book them — just say the word and I'll take care of it.`,
                urgency:     "standard",
                sourceAgent: "bg_check_clear",
                canDrop:     true,
              });
              await taskDoc.ref.update({ status: "notified", notifiedAt: new Date().toISOString() });
            } catch (notifyErr) {
              console.error("bg clear family notify error:", notifyErr);
            }
          }
        } catch (err) {
          console.error("caregiver_interest notify error:", err);
        }
      } else if (status === "consider") {
        notificationPayload = {
          title: "Background check needs review",
          body: "Your background check is under review. Our team will follow up shortly.",
        };

        // Write admin alert for manual review
        try {
          const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
          const cgData = cgSnap.data() ?? {};
          await db.collection("admin_alerts").add({
            type:        "background_check_review",
            caregiverId: caregiverUid,
            name:        cgData.name ?? "",
            phone:       cgData.phone ?? "",
            status:      "consider",
            checkrReportId: payload.id ?? "",
            createdAt:   new Date().toISOString(),
            resolved:    false,
            severity:    "high",
          });

          if (cgData.phone) {
            // Compliance-adjacent: must always deliver (immediate bypasses the
            // daily cap, canDrop:false skips wait-tool suppression, and the
            // helper falls back to sendToPhone for session-less caregivers).
            await sendBgcheckNoticeToCaregiver(cgData.phone, caregiverUid,
              `Hi ${(cgData.name as string | undefined)?.split(" ")[0] ?? "there"} — ` +
              `your background check is under review. This is normal — our team will reach out if anything is needed, ` +
              `and I'll text you the moment it's resolved. Hang tight.`);
            // Ack flag lands after the send so it also lands on a session the
            // helper's sendToPhone fallback just created.
            await db.collection("agent_sessions").doc(cgData.phone).update({
              pendingBgCheckAck:      "review",
              pendingBgCheckAckSetAt: new Date().toISOString(),
            }).catch(() => {});
          }
        } catch (err) {
          console.error("admin_alerts write error (consider):", err);
        }
      } else if (status === "suspended") {
        notificationPayload = {
          title: "Background check on hold",
          body: "Your background check is on hold while Checkr gathers additional information. Check your email from Checkr for next steps.",
        };

        // Write admin alert (medium severity — normal Checkr flow, not a failure)
        try {
          const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
          const cgData = cgSnap.data() ?? {};
          await db.collection("admin_alerts").add({
            type:        "background_check_suspended",
            caregiverId: caregiverUid,
            name:        cgData.name ?? "",
            phone:       cgData.phone ?? "",
            status:      "suspended",
            checkrReportId: payload.id ?? "",
            createdAt:   new Date().toISOString(),
            resolved:    false,
            severity:    "high",
          });

          if (cgData.phone) {
            // Compliance-adjacent: must always deliver (see consider branch).
            await sendBgcheckNoticeToCaregiver(cgData.phone, caregiverUid,
              `Hi ${(cgData.name as string | undefined)?.split(" ")[0] ?? "there"} — ` +
              `Checkr put your background check on hold while they gather more information. ` +
              `Please check the email from Checkr and follow any instructions there. ` +
              `Reach out if you need anything — we're here to help.`);
            await db.collection("agent_sessions").doc(cgData.phone).update({
              pendingBgCheckAck:      "suspended",
              pendingBgCheckAckSetAt: new Date().toISOString(),
            }).catch(() => {});
          }
        } catch (err) {
          console.error("admin_alerts write error (suspended):", err);
        }
      }

    } else if (type === "report.canceled") {
      updates["backgroundCheckData.status"] = "canceled";
      updates["backgroundCheckData.canceledAt"] = new Date().toISOString();
      notificationPayload = {
        title: "Background check canceled",
        body: "Your background check was canceled. Please contact support or resubmit.",
      };

    } else if (type === "report.resumed") {
      updates["backgroundCheckData.status"] = "pending";

    } else if (type === "report.disputed") {
      updates["backgroundCheckData.status"] = "pending";
      updates["backgroundCheckData.disputed"] = true;
      notificationPayload = {
        title: "Background check under dispute",
        body: "Your background check result is being reviewed following your dispute. We'll update you when resolved.",
      };
      try {
        const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
        const cgData = cgSnap.data() ?? {};
        await db.collection("admin_alerts").add({
          type:        "background_check_review",
          caregiverId: caregiverUid,
          name:        cgData.name ?? "",
          phone:       cgData.phone ?? "",
          status:      "disputed",
          checkrReportId: payload.id ?? "",
          createdAt:   new Date().toISOString(),
          resolved:    false,
          severity:    "high",
        });
        if (cgData.phone) {
          // Compliance-adjacent: must always deliver (see consider branch).
          await sendBgcheckNoticeToCaregiver(cgData.phone, caregiverUid,
            "Your background check is being reviewed after the dispute. Our team is watching it and I'll text you as soon as there's an update. Nothing else needed from you right now.");
        }
      } catch (err) {
        console.error("admin_alerts write error (disputed):", err);
      }

    } else if (type === "report.pre_adverse_action") {
      updates["backgroundCheckData.status"] = "consider";
      updates["verificationStatus"] = "pre_adverse_action";
      notificationPayload = {
        title: "Background check — action required",
        body: "A preliminary decision has been made on your background check. Check your email for next steps from Checkr.",
      };

    } else if (type === "report.post_adverse_action") {
      updates["verified"] = false;
      updates["verificationStatus"] = "rejected";
      updates["backgroundCheckData.status"] = "consider";
      notificationPayload = {
        title: "Background check not approved",
        body: "Unfortunately your background check was not approved. Contact support if you have questions.",
      };

    } else {
      await settle("processed");
      res.status(200).json({ received: true, ignored: type });
      return;
    }

    if (Object.keys(updates).length > 0) {
      await db.collection("caregivers").doc(caregiverUid).update(updates);
    }
    if (notificationPayload) {
      await createCaregiverNotification(caregiverUid, notificationPayload.title, notificationPayload.body);
    }

    // ── Childcare vertical evidence mirror (plan 2026-07-22-002 U5, KTD10) ──
    // ADDITIVE: after the (unchanged) senior handling above, fan the event out
    // to caregivers/{uid}/screenings/child — but ONLY when the event matches
    // that screening's stored provider references (candidate/invitation/report
    // id + the shared base package slug), with doc-level idempotency for
    // out-of-order/redelivered events. Fully guarded: a childcare failure can
    // never affect the senior webhook outcome, and Checkr state remains
    // EVIDENCE — the mirror never writes approval (R27). MVR-wall events and
    // ignored candidate events returned earlier and are (correctly) excluded.
    try {
      const { mirrorCheckrEventToChildcareScreening } = await import("./childcare/providerEligibility");
      await mirrorCheckrEventToChildcareScreening({ caregiverUid, eventId, type, payload });
    } catch (err) {
      console.error("childcare screening mirror error (ignored):", err instanceof Error ? err.message : err);
    }

    await settle("processed");
    res.status(200).json({ received: true });
  } catch (error: any) {
    if (process.env.NODE_ENV !== "production") {
      console.error("checkrWebhook handler error:", error?.message);
    }
    // Release the claim — we ack 200 (no Checkr retry), but a freed id lets a
    // manual dashboard "resend" reprocess instead of being eaten as a duplicate.
    await settle("failed");
    // Acknowledge to prevent Checkr retry storms on handler bugs; we log for our own diagnostics.
    res.status(200).json({ received: true, error: "handled" });
  }
});
