"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkrWebhook = exports.initiateCheckrCandidate = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const crypto = __importStar(require("crypto"));
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();
const CHECKR_PACKAGE = process.env.CHECKR_PACKAGE || "driver_pro";
const CHECKR_PACKAGE_MVR = process.env.CHECKR_PACKAGE_MVR || CHECKR_PACKAGE;
function basicAuth(apiKey) {
    return "Basic " + Buffer.from(apiKey + ":").toString("base64");
}
async function checkrPost(path, body, idempotencyKey) {
    // CHECKR_KEY is preferred — avoids legacy Secret Manager binding on CHECKR_API_KEY
    const apiKey = (process.env.CHECKR_KEY || process.env.CHECKR_API_KEY || "").trim();
    if (!apiKey) {
        throw new functions.https.HttpsError("internal", "Checkr API Key not configured.");
    }
    const headers = {
        "Authorization": basicAuth(apiKey),
        "Content-Type": "application/json",
    };
    if (idempotencyKey) {
        headers["Idempotency-Key"] = idempotencyKey;
    }
    const baseUrl = process.env.CHECKR_API_URL || "https://api.checkr.com/v1";
    const keySource = process.env.CHECKR_KEY ? "CHECKR_KEY" : "CHECKR_API_KEY";
    console.log(`Checkr POST ${baseUrl}${path} key=${apiKey.slice(0, 8)}... (from ${keySource})`);
    const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error(`Checkr ${path} failed: ${res.status} ${errBody}`);
        throw new functions.https.HttpsError("internal", "Checkr request failed.");
    }
    return res.json();
}
// Official guide (p.17): check assessment first, then result. Use status only for suspension.
function mapCheckrResult(payload) {
    if (payload.status === "suspended")
        return "suspended";
    const effective = payload.assessment || payload.result;
    if (effective === "clear" || effective === "eligible")
        return "clear";
    if (effective === "consider" || effective === "review" || effective === "escalated")
        return "consider";
    return "pending";
}
exports.initiateCheckrCandidate = functions.runWith({}).https.onCall(async (data, context) => {
    var _a;
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
        const bgData = ((_a = caregiverSnap.data()) === null || _a === void 0 ? void 0 : _a.backgroundCheckData) || {};
        const existingCandidateId = bgData.checkrCandidateId;
        const invitationStatus = bgData.invitationStatus;
        // Block duplicate submissions unless the invitation expired or was canceled
        if (existingCandidateId && invitationStatus !== "expired" && invitationStatus !== "canceled") {
            return { success: true, candidateId: existingCandidateId };
        }
        // Build work_locations from form data or profile fallback (REQUIRED by Checkr for US checks)
        const caregiverData = caregiverSnap.data() || {};
        const workState = (typeof state === "string" && state.trim()) || caregiverData.state || "";
        const workCity = caregiverData.city || "";
        const workLocations = workState
            ? [Object.assign({ country: "US", state: workState.toUpperCase() }, (workCity && { city: workCity }))]
            : [];
        // Date-scoped idempotency key prevents duplicate candidates on same-day retries
        const dateKey = new Date().toISOString().slice(0, 10);
        // Reuse existing candidate record if re-inviting after expiry — avoids duplicate Checkr records
        let candidateId = existingCandidateId;
        if (!candidateId) {
            const candidateBody = {
                first_name: legalFirstName,
                last_name: legalLastName,
                email,
                zipcode: zipCode,
                custom_id: uid,
                // Do NOT send no_middle_name — locks the field on the Checkr invitation form (official guide p.10)
            };
            if (workLocations.length)
                candidateBody.work_locations = workLocations;
            const candidate = await checkrPost("/candidates", candidateBody, `${uid}-candidate-${dateKey}`);
            candidateId = candidate.id;
        }
        const mvrPaid = caregiverData.mvrPaid === true;
        const selectedPackage = mvrPaid ? CHECKR_PACKAGE_MVR : CHECKR_PACKAGE;
        const invitationBody = {
            candidate_id: candidateId,
            package: selectedPackage,
        };
        if (workLocations.length)
            invitationBody.work_locations = workLocations;
        await checkrPost("/invitations", invitationBody, `${uid}-invitation-${dateKey}`);
        await db.collection("caregivers").doc(uid).set({
            backgroundCheckData: Object.assign({ checkrCandidateId: candidateId, consentGiven: true, legalFirstName,
                legalLastName, zip: zipCode, submittedAt: new Date().toISOString(), status: "pending", invitationStatus: "sent" }, (mvrPaid && { mvrIncluded: true })),
        }, { merge: true });
        return { success: true, candidateId };
    }
    catch (error) {
        if (error instanceof functions.https.HttpsError)
            throw error;
        console.error("Checkr initiate error:", error === null || error === void 0 ? void 0 : error.message, error === null || error === void 0 ? void 0 : error.code, JSON.stringify(error));
        throw new functions.https.HttpsError("internal", "Background check initiation failed.");
    }
});
function verifyCheckrSignature(rawBody, signature, secret) {
    if (typeof signature !== "string" || signature.length === 0)
        return false;
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const given = Buffer.from(signature);
    const calc = Buffer.from(expected);
    if (given.length !== calc.length)
        return false;
    try {
        return crypto.timingSafeEqual(given, calc);
    }
    catch (_a) {
        return false;
    }
}
async function createCaregiverNotification(userId, title, body) {
    try {
        await db.collection("users").doc(userId).collection("notifications").add({
            title,
            body,
            type: "system",
            isRead: false,
            createdAt: new Date().toISOString(),
        });
    }
    catch (err) {
        if (process.env.NODE_ENV !== "production") {
            console.error("createCaregiverNotification failed:", err);
        }
    }
}
async function findCaregiverUidByCandidateId(candidateId) {
    const snap = await db.collection("caregivers")
        .where("backgroundCheckData.checkrCandidateId", "==", candidateId)
        .limit(1)
        .get();
    if (snap.empty)
        return null;
    return snap.docs[0].id;
}
exports.checkrWebhook = functions.runWith({}).https.onRequest(async (req, res) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
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
        }
        else {
            console.error("Checkr webhook rejected: CHECKR_WEBHOOK_SECRET is not set. Refusing to process unverified webhooks.");
            res.status(500).send("Webhook secret not configured");
            return;
        }
    }
    else if (!signature || !verifyCheckrSignature(req.rawBody, signature, webhookSecret)) {
        res.status(401).send("Invalid signature");
        return;
    }
    const event = req.body || {};
    const type = typeof event.type === "string" ? event.type : "";
    const payload = ((_a = event === null || event === void 0 ? void 0 : event.data) === null || _a === void 0 ? void 0 : _a.object) || {};
    try {
        // candidate.* events carry the candidate in payload.id; all others reference it via candidate_id
        const lookupId = type.startsWith("candidate")
            ? payload.id
            : payload.candidate_id;
        if (!lookupId) {
            res.status(200).json({ received: true, ignored: "no candidate reference" });
            return;
        }
        const caregiverUid = await findCaregiverUidByCandidateId(lookupId);
        if (!caregiverUid) {
            res.status(200).json({ received: true, ignored: "caregiver not found" });
            return;
        }
        const updates = {};
        let notificationPayload = null;
        if (type === "candidate.driver_license_required" || type === "candidate.driver_abstract_required") {
            updates["backgroundCheckData.status"] = "pending";
            notificationPayload = {
                title: "Driving record document required",
                body: "Checkr needs a driving record document to continue your background check. Check your email from Checkr for instructions.",
            };
        }
        else if (type === "candidate.id_required") {
            updates["backgroundCheckData.status"] = "pending";
            notificationPayload = {
                title: "ID verification required",
                body: "Checkr needs to verify your identity to continue your background check. Check your email from Checkr for instructions.",
            };
        }
        else if (type === "candidate.deferred") {
            updates["backgroundCheckData.status"] = "pending";
            notificationPayload = {
                title: "Background check deferred",
                body: "Your background check has been deferred. Check your email from Checkr or contact support for next steps.",
            };
        }
        else if (type === "candidate.created" ||
            type === "candidate.updated" ||
            type === "candidate.engaged" ||
            type === "candidate.pre_adverse_action" ||
            type === "candidate.post_adverse_action") {
            // Silently acknowledge — report-level events handle the meaningful state changes
            res.status(200).json({ received: true, ignored: type });
            return;
        }
        else if (type === "invitation.created") {
            updates["backgroundCheckData.invitationStatus"] = "sent";
        }
        else if (type === "invitation.completed") {
            updates["backgroundCheckData.invitationStatus"] = "completed";
        }
        else if (type === "invitation.expired") {
            updates["backgroundCheckData.invitationStatus"] = "expired";
            notificationPayload = {
                title: "Verification link expired",
                body: "Your background check link expired after 7 days. Return to your dashboard to get a new link.",
            };
        }
        else if (type === "invitation.deleted" || type === "invitation.cancelled") {
            updates["backgroundCheckData.invitationStatus"] = "canceled";
        }
        else if (type === "verification.created") {
            updates["backgroundCheckData.status"] = "pending";
            updates["backgroundCheckData.invitationStatus"] = "awaiting_documents";
            notificationPayload = {
                title: "Document upload required",
                body: "Your background check is on hold. Check your email from Checkr — they need you to upload a document to continue.",
            };
        }
        else if (type === "verification.completed" || type === "verification.processed") {
            updates["backgroundCheckData.invitationStatus"] = "documents_submitted";
        }
        else if (type === "report.created") {
            updates["backgroundCheckData.checkrReportId"] = payload.id;
            updates["backgroundCheckData.status"] = mapCheckrResult(payload);
        }
        else if (type === "report.completed" ||
            type === "report.updated" ||
            type === "report.suspended" ||
            type === "report.engaged" ||
            type === "report.upgraded") {
            const status = mapCheckrResult(payload);
            updates["backgroundCheckData.status"] = status;
            if (payload.id)
                updates["backgroundCheckData.checkrReportId"] = payload.id;
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
                updates["backgroundCheckStatus"] = "clear";
                updates["backgroundCheckComplete"] = true;
                updates["backgroundCheckData.checkrClearedAt"] = new Date().toISOString();
                notificationPayload = {
                    title: "Background check approved! 🎉",
                    body: "Great news — your background check came back clear. You're approved and families can now book you!",
                };
                // Advance Cara onboarding if caregiver has an iMessage session; also mark approved driver if MVR was included
                try {
                    const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
                    const cgData = cgSnap.data();
                    if (((_b = cgData === null || cgData === void 0 ? void 0 : cgData.backgroundCheckData) === null || _b === void 0 ? void 0 : _b.mvrIncluded) === true) {
                        updates["isApprovedDriver"] = true;
                    }
                    const cgPhone = cgData === null || cgData === void 0 ? void 0 : cgData.phone;
                    if (cgPhone) {
                        const { advanceOnboardingStep } = await Promise.resolve().then(() => __importStar(require("./agents/onboardingConversation")));
                        await advanceOnboardingStep(cgPhone, "background_check", "");
                        // Flag so any follow-up reply routes to qaAgent with BG-check context
                        await db.collection("agent_sessions").doc(cgPhone).update({
                            pendingBgCheckAck: "clear",
                            pendingBgCheckAckSetAt: new Date().toISOString(),
                        }).catch(() => { });
                    }
                }
                catch (err) {
                    console.error("advanceOnboardingStep(background_check) error:", err);
                }
                // Notify families who expressed interest while bg check was pending
                try {
                    const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
                    const cgName = (_d = (_c = cgSnap.data()) === null || _c === void 0 ? void 0 : _c.name) !== null && _d !== void 0 ? _d : "Your caregiver";
                    const interestSnap = await db.collection("agent_tasks")
                        .where("type", "==", "caregiver_interest")
                        .where("caregiverId", "==", caregiverUid)
                        .where("status", "==", "pending_bg_clear")
                        .get();
                    for (const taskDoc of interestSnap.docs) {
                        const task = taskDoc.data();
                        try {
                            const { sendViaInteractionAgent } = await Promise.resolve().then(() => __importStar(require("./agents/caraAgent")));
                            await sendViaInteractionAgent(task.clientPhone, {
                                content: `Good news! ${cgName}'s background check just cleared. ` +
                                    `You can now book them — just say the word and I'll take care of it.`,
                                urgency: "standard",
                                sourceAgent: "bg_check_clear",
                                canDrop: true,
                            });
                            await taskDoc.ref.update({ status: "notified", notifiedAt: new Date().toISOString() });
                        }
                        catch (notifyErr) {
                            console.error("bg clear family notify error:", notifyErr);
                        }
                    }
                }
                catch (err) {
                    console.error("caregiver_interest notify error:", err);
                }
            }
            else if (status === "consider") {
                notificationPayload = {
                    title: "Background check needs review",
                    body: "Your background check is under review. Our team will follow up shortly.",
                };
                // Write admin alert for manual review
                try {
                    const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
                    const cgData = (_e = cgSnap.data()) !== null && _e !== void 0 ? _e : {};
                    await db.collection("admin_alerts").add({
                        type: "background_check_review",
                        caregiverId: caregiverUid,
                        name: (_f = cgData.name) !== null && _f !== void 0 ? _f : "",
                        phone: (_g = cgData.phone) !== null && _g !== void 0 ? _g : "",
                        status: "consider",
                        checkrReportId: (_h = payload.id) !== null && _h !== void 0 ? _h : "",
                        createdAt: new Date().toISOString(),
                        resolved: false,
                        severity: "high",
                    });
                    if (cgData.phone) {
                        const { sendViaInteractionAgent } = await Promise.resolve().then(() => __importStar(require("./agents/caraAgent")));
                        await sendViaInteractionAgent(cgData.phone, {
                            content: `Hi ${(_k = (_j = cgData.name) === null || _j === void 0 ? void 0 : _j.split(" ")[0]) !== null && _k !== void 0 ? _k : "there"} — ` +
                                `your background check is under review. This is normal and usually takes a few business days. ` +
                                `Our team will reach out if anything is needed. Hang tight.`,
                            urgency: "standard",
                            sourceAgent: "checkr_status",
                            canDrop: true,
                        });
                        await db.collection("agent_sessions").doc(cgData.phone).update({
                            pendingBgCheckAck: "review",
                            pendingBgCheckAckSetAt: new Date().toISOString(),
                        }).catch(() => { });
                    }
                }
                catch (err) {
                    console.error("admin_alerts write error (consider):", err);
                }
            }
            else if (status === "suspended") {
                notificationPayload = {
                    title: "Background check on hold",
                    body: "Your background check is on hold while Checkr gathers additional information. Check your email from Checkr for next steps.",
                };
                // Write admin alert (medium severity — normal Checkr flow, not a failure)
                try {
                    const cgSnap = await db.collection("caregivers").doc(caregiverUid).get();
                    const cgData = (_l = cgSnap.data()) !== null && _l !== void 0 ? _l : {};
                    await db.collection("admin_alerts").add({
                        type: "background_check_suspended",
                        caregiverId: caregiverUid,
                        name: (_m = cgData.name) !== null && _m !== void 0 ? _m : "",
                        phone: (_o = cgData.phone) !== null && _o !== void 0 ? _o : "",
                        status: "suspended",
                        createdAt: new Date().toISOString(),
                        resolved: false,
                        severity: "medium",
                    });
                    if (cgData.phone) {
                        const { sendViaInteractionAgent } = await Promise.resolve().then(() => __importStar(require("./agents/caraAgent")));
                        await sendViaInteractionAgent(cgData.phone, {
                            content: `Hi ${(_q = (_p = cgData.name) === null || _p === void 0 ? void 0 : _p.split(" ")[0]) !== null && _q !== void 0 ? _q : "there"} — ` +
                                `Checkr put your background check on hold while they gather more information. ` +
                                `Please check the email from Checkr and follow any instructions there. ` +
                                `Reach out if you need anything — we're here to help.`,
                            urgency: "standard",
                            sourceAgent: "checkr_status",
                            canDrop: true,
                        });
                        await db.collection("agent_sessions").doc(cgData.phone).update({
                            pendingBgCheckAck: "suspended",
                            pendingBgCheckAckSetAt: new Date().toISOString(),
                        }).catch(() => { });
                    }
                }
                catch (err) {
                    console.error("admin_alerts write error (suspended):", err);
                }
            }
        }
        else if (type === "report.canceled") {
            updates["backgroundCheckData.status"] = "canceled";
            updates["backgroundCheckData.canceledAt"] = new Date().toISOString();
            notificationPayload = {
                title: "Background check canceled",
                body: "Your background check was canceled. Please contact support or resubmit.",
            };
        }
        else if (type === "report.resumed") {
            updates["backgroundCheckData.status"] = "pending";
        }
        else if (type === "report.disputed") {
            updates["backgroundCheckData.status"] = "pending";
            updates["backgroundCheckData.disputed"] = true;
            notificationPayload = {
                title: "Background check under dispute",
                body: "Your background check result is being reviewed following your dispute. We'll update you when resolved.",
            };
        }
        else if (type === "report.pre_adverse_action") {
            updates["backgroundCheckData.status"] = "consider";
            updates["verificationStatus"] = "pre_adverse_action";
            notificationPayload = {
                title: "Background check — action required",
                body: "A preliminary decision has been made on your background check. Check your email for next steps from Checkr.",
            };
        }
        else if (type === "report.post_adverse_action") {
            updates["verified"] = false;
            updates["verificationStatus"] = "rejected";
            updates["backgroundCheckData.status"] = "consider";
            notificationPayload = {
                title: "Background check not approved",
                body: "Unfortunately your background check was not approved. Contact support if you have questions.",
            };
        }
        else {
            res.status(200).json({ received: true, ignored: type });
            return;
        }
        if (Object.keys(updates).length > 0) {
            await db.collection("caregivers").doc(caregiverUid).update(updates);
        }
        if (notificationPayload) {
            await createCaregiverNotification(caregiverUid, notificationPayload.title, notificationPayload.body);
        }
        res.status(200).json({ received: true });
    }
    catch (error) {
        if (process.env.NODE_ENV !== "production") {
            console.error("checkrWebhook handler error:", error === null || error === void 0 ? void 0 : error.message);
        }
        // Acknowledge to prevent Checkr retry storms on handler bugs; we log for our own diagnostics.
        res.status(200).json({ received: true, error: "handled" });
    }
});
//# sourceMappingURL=checkr.js.map