import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { claimWebhookEvent, settleWebhookEvent, CHECKR_EVENTS_COLLECTION } from "./utils/webhookLedger";
import { checkrPost, checkrGet } from "./checkrApi";
import { assertMvrCheckConfig } from "./mvrConfig";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

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
    // ONE path for both consent surfaces (2026-09-25) — see backgroundCheckConsent.ts.
    const { authorizeBackgroundCheck } = await import("./backgroundCheckConsent");
    const result = await authorizeBackgroundCheck({
      uid, email,
      form: { legalFirstName, legalLastName, zipCode, state: typeof state === "string" ? state : undefined },
    });
    return { success: true, candidateId: result.candidateId, invitationUrl: result.invitationUrl ?? undefined, already: result.status === "already" };
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

// Caregiver notifications for every Checkr outcome come from
// notifications/caregiverAccountEvents.ts (2026-09-27): the record write below
// is announced ONCE (bell + text, same words) by onCaregiverAccountChange, and
// the three candidate.* notices that leave no record transition go through the
// same module with the Checkr event id. Nothing is sent from this file.
async function notifyCandidateNotice(caregiverUid: string, kind: "bgcheck_document_required", eventId: string): Promise<void> {
  const { notifyCaregiverAccountEvent } = await import("./notifications/caregiverAccountEvents");
  await notifyCaregiverAccountEvent(caregiverUid, kind, { eventId: `checkr:${eventId}` })
    .catch((err) => console.error(`checkr candidate notice (${kind}) failed for ${caregiverUid}:`, err));
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
 * Bundled criminal+MVR report (Transportation on the profile at payment) that
 * came back NON-clear: Checkr gives one overall result for the whole report, so
 * on its own it can't say whether the criminal search or the driving record
 * caused it. Ask Checkr for the MVR screening's own result and record THAT on
 * the MVR fields, so the admin's "Driving Record" line tells the truth
 * (founder, 2026-09-25). Falls back to mirroring the overall result when the
 * report carries no MVR id or the lookup fails — never throws.
 */
async function resolveBundledMvrStatus(
  payload: Record<string, any>,
  cgData: Record<string, any>,
  updates: Record<string, any>,
  overallStatus: "consider" | "suspended",
): Promise<void> {
  if (cgData.mvrPaid !== true) return;
  const mvrId = typeof payload.motor_vehicle_report === "string" ? payload.motor_vehicle_report
    : typeof payload.motor_vehicle_report?.id === "string" ? payload.motor_vehicle_report.id : null;
  let resolved: string = overallStatus;
  if (mvrId) {
    try {
      const mvr = await checkrGet(`/motor_vehicle_reports/${mvrId}`);
      const own = mapCheckrResult(mvr ?? {});
      if (own === "clear" || own === "consider" || own === "suspended" || own === "pending") resolved = own;
    } catch (err) {
      console.warn(`resolveBundledMvrStatus: MVR lookup failed for ${mvrId}; mirroring overall "${overallStatus}":`, err);
    }
  }
  updates["mvrStatus"] = resolved;
  if (resolved === "clear") {
    // Driving record itself is fine — the badge still waits on core approval.
    updates["isApprovedDriver"] = true;
    updates["mvrClearedAt"] = new Date().toISOString();
  } else if (resolved === "consider" || resolved === "suspended") {
    updates["isApprovedDriver"] = false;
  }
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
  // The caregiver's "driving record cleared / needs review" and any badge
  // change are announced by onCaregiverAccountChange from this write.
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
    let candidateNotice: "bgcheck_document_required" | null = null;

    if (type === "candidate.driver_license_required" || type === "candidate.driver_abstract_required" || type === "candidate.id_required" || type === "candidate.deferred") {
      // Checkr needs something from the caregiver by email; the record only
      // goes back to pending, so this notice is sent by event id.
      updates["backgroundCheckData.status"] = "pending";
      candidateNotice = "bgcheck_document_required";

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
      // The cached link is dead — drop it from the Evia session too so the next
      // link request mints a fresh invitation instead of resending a dead URL.
      // (The caregiver's "link expired" bell + text comes from the record change.)
      try {
        const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
        const cgPhone = cgSnap.data()?.phone as string | undefined;
        if (cgPhone) {
          await db.collection("agent_sessions").doc(cgPhone).update({
            bgcheckInviteUrl: admin.firestore.FieldValue.delete(),
          }).catch(() => {});
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
            // The bundled report carries the MVR — record it on the same
            // fields the standalone MVR-only path uses, so the admin's
            // "Driving record" line and the badge gate read one shape.
            updates["mvrStatus"] = "clear";
            updates["mvrClearedAt"] = new Date().toISOString();
          }
          const cgPhone = cgData?.phone as string | undefined;
          if (cgPhone) {
            // The "approved" notice (bell + text) comes from the record change;
            // this only moves a session that is waiting on the check to the
            // payouts step (the step handler ignores any other session).
            const { advanceOnboardingStep } = await import("./agents/onboardingConversation");
            await advanceOnboardingStep(cgPhone, "background_check", "");
            // Flag so any follow-up reply routes to qaAgent with BG-check context
            await db.collection("agent_sessions").doc(cgPhone).update({
              pendingBgCheckAck:      "clear",
              pendingBgCheckAckSetAt: new Date().toISOString(),
            }).catch(() => {});
          }
        } catch (err) {
          console.error("advanceOnboardingStep(background_check) error:", err);
        }

      } else if (status === "consider") {
        // Write admin alert for manual review
        try {
          const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
          const cgData = cgSnap.data() ?? {};
          // Bundled criminal+MVR report: record the MVR screening's OWN result
          // so the admin's "Driving record" line says which check needs review.
          await resolveBundledMvrStatus(payload, cgData, updates, "consider");
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
            // The "needs review" notice comes from the record change (bell + text).
            await db.collection("agent_sessions").doc(cgData.phone).update({
              pendingBgCheckAck:      "review",
              pendingBgCheckAckSetAt: new Date().toISOString(),
            }).catch(() => {});
          }
        } catch (err) {
          console.error("admin_alerts write error (consider):", err);
        }
      } else if (status === "suspended") {
        // Write admin alert (medium severity — normal Checkr flow, not a failure)
        try {
          const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
          const cgData = cgSnap.data() ?? {};
          await resolveBundledMvrStatus(payload, cgData, updates, "suspended");
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
            // The "on hold" notice comes from the record change (bell + text).
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

    } else if (type === "report.resumed") {
      updates["backgroundCheckData.status"] = "pending";

    } else if (type === "report.disputed") {
      updates["backgroundCheckData.status"] = "pending";
      updates["backgroundCheckData.disputed"] = true;
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
      } catch (err) {
        console.error("admin_alerts write error (disputed):", err);
      }

    } else if (type === "report.pre_adverse_action") {
      updates["backgroundCheckData.status"] = "consider";
      updates["verificationStatus"] = "pre_adverse_action";

    } else if (type === "report.post_adverse_action") {
      updates["verified"] = false;
      updates["verificationStatus"] = "rejected";
      updates["backgroundCheckData.status"] = "consider";

    } else {
      await settle("processed");
      res.status(200).json({ received: true, ignored: type });
      return;
    }

    if (Object.keys(updates).length > 0) {
      await db.collection("caregivers").doc(caregiverUid).update(updates);
    }
    if (candidateNotice) {
      await notifyCandidateNotice(caregiverUid, candidateNotice, String(eventId ?? payload.id ?? type));
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
