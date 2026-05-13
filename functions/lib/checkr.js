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
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const crypto = __importStar(require("crypto"));
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();
const CHECKR_BASE_URL = process.env.CHECKR_API_URL || "https://api.checkr.com/v1";
const CHECKR_PACKAGE = process.env.CHECKR_PACKAGE || "driver_pro";
function basicAuth(apiKey) {
    return "Basic " + Buffer.from(apiKey + ":").toString("base64");
}
async function checkrPost(path, body, idempotencyKey) {
    const apiKey = (process.env.CHECKR_API_KEY || "").trim();
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
    const res = await fetch(`${CHECKR_BASE_URL}${path}`, {
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
exports.initiateCheckrCandidate = functions.runWith({ secrets: ["CHECKR_API_KEY"] }).https.onCall(async (data, context) => {
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
        const invitationBody = {
            candidate_id: candidateId,
            package: CHECKR_PACKAGE,
        };
        if (workLocations.length)
            invitationBody.work_locations = workLocations;
        await checkrPost("/invitations", invitationBody, `${uid}-invitation-${dateKey}`);
        await db.collection("caregivers").doc(uid).set({
            backgroundCheckData: {
                checkrCandidateId: candidateId,
                consentGiven: true,
                legalFirstName,
                legalLastName,
                zip: zipCode,
                submittedAt: new Date().toISOString(),
                status: "pending",
                invitationStatus: "sent",
            },
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
exports.checkrWebhook = functions.runWith({ secrets: ["CHECKR_API_KEY"] }).https.onRequest(async (req, res) => {
    var _a;
    if (req.method !== "POST") {
        res.status(405).send("Method not allowed");
        return;
    }
    // Use dedicated webhook signing secret if configured; fall back to API key for backwards compatibility
    const webhookSecret = (process.env.CHECKR_WEBHOOK_SECRET || process.env.CHECKR_API_KEY || "").trim();
    if (!webhookSecret) {
        console.error("Checkr webhook secret not configured");
        res.status(500).send("Webhook not configured");
        return;
    }
    const signature = req.headers["x-checkr-signature"];
    if (!verifyCheckrSignature(req.rawBody, signature, webhookSecret)) {
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
        if (type === "invitation.created") {
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
        else if (type === "invitation.deleted") {
            updates["backgroundCheckData.invitationStatus"] = "canceled";
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
                // Option B: admin manually approves everyone — do not auto-set verified: true
                updates["verificationStatus"] = "checkr_clear";
                updates["backgroundCheckData.checkrClearedAt"] = new Date().toISOString();
                notificationPayload = {
                    title: "Background check complete",
                    body: "Your background check came back clear. Our team will complete the final review shortly.",
                };
            }
            else if (status === "consider") {
                notificationPayload = {
                    title: "Background check needs review",
                    body: "Your background check is under review. Our team will follow up shortly.",
                };
            }
            else if (status === "suspended") {
                notificationPayload = {
                    title: "Background check update",
                    body: "Your background check could not be completed. Please contact support.",
                };
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