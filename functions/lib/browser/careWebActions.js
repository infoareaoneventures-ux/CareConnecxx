"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchHealthcareProvider = searchHealthcareProvider;
exports.getPharmacyInfo = getPharmacyInfo;
exports.fetchHealthcarePage = fetchHealthcarePage;
exports.performBrowserAction = performBrowserAction;
exports.scheduleDoctorAppointment = scheduleDoctorAppointment;
exports.requestPharmacyRefill = requestPharmacyRefill;
exports.checkInsuranceAuthorization = checkInsuranceAuthorization;
const zod_1 = require("zod");
const browserbaseClient_1 = require("./browserbaseClient");
const credentialVault_1 = require("./credentialVault");
// ── ACTION 1: Search for a healthcare provider ────────────────────────────────
// "Find Dr. Peterson's phone number"
// "What are the hours for CVS on Peachtree?"
// "Does Northside Hospital accept United Healthcare?"
async function searchHealthcareProvider(params) {
    var _a;
    const startTime = Date.now();
    const sessionId = "search_" + Date.now();
    try {
        const searchQuery = params.city
            ? `${params.query} ${params.city}`
            : params.query;
        const results = await (0, browserbaseClient_1.searchWeb)(searchQuery, 5);
        let pageContent = "";
        if ((_a = results[0]) === null || _a === void 0 ? void 0 : _a.url) {
            const fetched = await (0, browserbaseClient_1.fetchPage)(results[0].url).catch(() => null);
            if (fetched && fetched.statusCode === 200) {
                pageContent = fetched.content.slice(0, 2000);
            }
        }
        await (0, browserbaseClient_1.logBrowserSession)({
            userId: params.userId,
            phone: params.phone,
            sessionId,
            action: "search_healthcare_provider",
            success: true,
            result: `Found ${results.length} results for: ${searchQuery}`,
            durationMs: Date.now() - startTime,
        });
        return {
            found: results.length > 0,
            results: results.map(r => ({ name: r.title, url: r.url })),
            summary: pageContent || results.map(r => r.title).join(", "),
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await (0, browserbaseClient_1.logBrowserSession)({
            userId: params.userId,
            phone: params.phone,
            sessionId,
            action: "search_healthcare_provider",
            success: false,
            error: message,
            durationMs: Date.now() - startTime,
        });
        throw err;
    }
}
// ── ACTION 2: Get pharmacy information ────────────────────────────────────────
// "What are the CVS hours near mom's house?"
// "Does Walgreens on Peachtree have mom's blood pressure medication?"
async function getPharmacyInfo(params) {
    var _a, _b;
    const startTime = Date.now();
    const sessionId = "search_" + Date.now();
    try {
        const searchQuery = [params.pharmacy, params.query, params.city, params.zip]
            .filter(Boolean)
            .join(" ");
        const results = await (0, browserbaseClient_1.searchWeb)(searchQuery, 3);
        let info = "";
        if ((_a = results[0]) === null || _a === void 0 ? void 0 : _a.url) {
            const fetched = await (0, browserbaseClient_1.fetchPage)(results[0].url, true).catch(() => null);
            if ((fetched === null || fetched === void 0 ? void 0 : fetched.statusCode) === 200) {
                info = fetched.content.slice(0, 1500);
            }
        }
        if (!info && results.length > 0) {
            info = results.map(r => `${r.title}: ${r.url}`).join("\n");
        }
        await (0, browserbaseClient_1.logBrowserSession)({
            userId: params.userId,
            phone: params.phone,
            sessionId,
            action: "get_pharmacy_info",
            success: true,
            result: `Found pharmacy info for: ${searchQuery}`,
            durationMs: Date.now() - startTime,
        });
        return {
            found: !!info,
            info: info || "No information found",
            url: (_b = results[0]) === null || _b === void 0 ? void 0 : _b.url,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await (0, browserbaseClient_1.logBrowserSession)({
            userId: params.userId,
            phone: params.phone,
            sessionId,
            action: "get_pharmacy_info",
            success: false,
            error: message,
            durationMs: Date.now() - startTime,
        });
        throw err;
    }
}
// ── ACTION 3: Fetch a healthcare portal page ──────────────────────────────────
// Read any publicly accessible healthcare page for context.
async function fetchHealthcarePage(params) {
    const startTime = Date.now();
    const sessionId = "fetch_" + Date.now();
    try {
        const result = await (0, browserbaseClient_1.fetchPage)(params.url, true);
        await (0, browserbaseClient_1.logBrowserSession)({
            userId: params.userId,
            phone: params.phone,
            sessionId,
            action: "fetch_healthcare_page",
            success: result.statusCode === 200,
            result: `Fetched ${params.url}: ${result.statusCode}`,
            durationMs: Date.now() - startTime,
        });
        return result;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await (0, browserbaseClient_1.logBrowserSession)({
            userId: params.userId,
            phone: params.phone,
            sessionId,
            action: "fetch_healthcare_page",
            success: false,
            error: message,
            durationMs: Date.now() - startTime,
        });
        throw err;
    }
}
// ── ACTION 4: Full browser action via Stagehand ───────────────────────────────
// Poke-style AI browser navigation for tasks requiring a real browser session.
// For launch: public sites only (no login required).
async function performBrowserAction(params) {
    var _a, _b, _c;
    const startTime = Date.now();
    let session = null;
    if (params.requiresLogin) {
        return {
            success: false,
            result: "I can't log into websites automatically yet — that feature is coming soon. " +
                "I can find the right link and walk you through it step by step.",
            sessionId: "not_started",
        };
    }
    try {
        session = await (0, browserbaseClient_1.createBrowserSession)({ proxies: true, solveCaptchas: true });
        const page = session.page;
        if (params.url) {
            await page.goto(params.url, { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(2000);
        }
        await session.stagehand.act(params.task);
        await page.waitForTimeout(2000);
        const extracted = await session.stagehand.extract(`Extract the key information relevant to: ${params.task}`, zod_1.z.object({
            summary: zod_1.z.string(),
            keyInfo: zod_1.z.string().optional(),
        }));
        const result = (_a = extracted === null || extracted === void 0 ? void 0 : extracted.summary) !== null && _a !== void 0 ? _a : "Task completed.";
        await (0, browserbaseClient_1.logBrowserSession)({
            userId: params.userId,
            phone: params.phone,
            sessionId: session.sessionId,
            action: "perform_browser_action",
            success: true,
            result: result.slice(0, 200),
            durationMs: Date.now() - startTime,
        });
        return {
            success: true,
            result,
            sessionId: session.sessionId,
            debugUrl: `https://www.browserbase.com/sessions/${session.sessionId}`,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[performBrowserAction] error:", err);
        await (0, browserbaseClient_1.logBrowserSession)({
            userId: params.userId,
            phone: params.phone,
            sessionId: (_b = session === null || session === void 0 ? void 0 : session.sessionId) !== null && _b !== void 0 ? _b : "error",
            action: "perform_browser_action",
            success: false,
            error: message,
            durationMs: Date.now() - startTime,
        });
        return {
            success: false,
            result: "I ran into a problem completing that task. " +
                "Let me find the right link for you instead.",
            sessionId: (_c = session === null || session === void 0 ? void 0 : session.sessionId) !== null && _c !== void 0 ? _c : "error",
        };
    }
    finally {
        if (session)
            await (0, browserbaseClient_1.closeBrowserSession)(session);
    }
}
// ── ACTION 5: Schedule a doctor appointment ───────────────────────────────────
// Logs into MyChart / athenahealth / FollowMyHealth and books an appointment.
// Returns needsCredentials: true if login hasn't been stored yet.
const DOCTOR_PORTAL_URLS = {
    mychart: "https://mychart.com",
    athenahealth: "https://www.athenahealth.com/patients",
    followmyhealth: "https://www.followmyhealth.com",
};
async function scheduleDoctorAppointment(params) {
    var _a, _b, _c, _d, _e, _f;
    const startTime = Date.now();
    let session = null;
    const service = (_a = params.portalService) !== null && _a !== void 0 ? _a : "mychart";
    const credentials = await (0, credentialVault_1.getCredential)(params.userId, service);
    if (!credentials) {
        return { success: false, result: "credentials_required", needsCredentials: true };
    }
    try {
        session = await (0, browserbaseClient_1.createBrowserSession)({ proxies: true, solveCaptchas: true });
        const page = session.page;
        const portalUrl = (_d = (_c = (_b = params.portalUrl) !== null && _b !== void 0 ? _b : credentials.portalUrl) !== null && _c !== void 0 ? _c : DOCTOR_PORTAL_URLS[service]) !== null && _d !== void 0 ? _d : "https://mychart.com";
        await page.goto(portalUrl, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);
        await session.stagehand.act(`Log in with username "${credentials.username}" and password "${credentials.password}"`);
        await page.waitForTimeout(3000);
        await session.stagehand.act("Navigate to the appointments or scheduling section");
        await page.waitForTimeout(2000);
        await session.stagehand.act(`Find and select ${params.doctorName}${params.specialty ? ` (${params.specialty})` : ""}`);
        await page.waitForTimeout(2000);
        if (params.appointmentType) {
            await session.stagehand.act(`Select appointment type: ${params.appointmentType}`);
            await page.waitForTimeout(2000);
        }
        const dateContext = params.preferredDate ? `closest to ${params.preferredDate}` : "as soon as possible";
        await session.stagehand.act(`Find and select an available appointment slot ${dateContext}`);
        await page.waitForTimeout(2000);
        await session.stagehand.act("Confirm and submit the appointment");
        await page.waitForTimeout(3000);
        const details = await session.stagehand.extract("Extract the appointment confirmation: date, time, doctor name, location, and confirmation number", zod_1.z.object({
            date: zod_1.z.string(),
            time: zod_1.z.string(),
            doctor: zod_1.z.string().optional(),
            location: zod_1.z.string().optional(),
            confirmationNumber: zod_1.z.string().optional(),
        }));
        await (0, credentialVault_1.markCredentialUsed)(params.userId, service, true);
        await (0, browserbaseClient_1.logBrowserSession)({
            userId: params.userId, phone: params.phone, sessionId: session.sessionId,
            action: "schedule_doctor_appointment", success: true,
            result: `Scheduled with ${params.doctorName} on ${(_e = details === null || details === void 0 ? void 0 : details.date) !== null && _e !== void 0 ? _e : "unknown date"}`,
            durationMs: Date.now() - startTime,
        });
        return {
            success: true,
            result: `Appointment scheduled with ${params.doctorName}`,
            appointmentDetails: details !== null && details !== void 0 ? details : undefined,
            sessionId: session.sessionId,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await (0, credentialVault_1.markCredentialUsed)(params.userId, service, false);
        await (0, browserbaseClient_1.logBrowserSession)({
            userId: params.userId, phone: params.phone, sessionId: (_f = session === null || session === void 0 ? void 0 : session.sessionId) !== null && _f !== void 0 ? _f : "error",
            action: "schedule_doctor_appointment", success: false,
            error: message, durationMs: Date.now() - startTime,
        });
        return {
            success: false,
            result: `I ran into a problem scheduling with ${params.doctorName}. ` +
                `The portal may have changed or your login may need updating. ` +
                `Reply "update my ${service} login" to refresh your credentials.`,
            sessionId: session === null || session === void 0 ? void 0 : session.sessionId,
        };
    }
    finally {
        if (session)
            await (0, browserbaseClient_1.closeBrowserSession)(session);
    }
}
// ── ACTION 6: Request a pharmacy refill ──────────────────────────────────────
const PHARMACY_URLS = {
    cvs: "https://www.cvs.com/account/login",
    walgreens: "https://www.walgreens.com/login",
    riteaid: "https://www.riteaid.com/account/login",
};
async function requestPharmacyRefill(params) {
    var _a, _b, _c, _d, _e, _f, _g;
    const startTime = Date.now();
    let session = null;
    const service = params.pharmacyService;
    const credentials = await (0, credentialVault_1.getCredential)(params.userId, service);
    if (!credentials) {
        return { success: false, result: "credentials_required", needsCredentials: true };
    }
    try {
        session = await (0, browserbaseClient_1.createBrowserSession)({ proxies: true, solveCaptchas: true });
        const page = session.page;
        const portalUrl = (_b = (_a = credentials.portalUrl) !== null && _a !== void 0 ? _a : PHARMACY_URLS[service]) !== null && _b !== void 0 ? _b : "https://www.cvs.com/account/login";
        await page.goto(portalUrl, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);
        await session.stagehand.act(`Log in with email "${credentials.username}" and password "${credentials.password}"`);
        await page.waitForTimeout(3000);
        await session.stagehand.act("Navigate to prescriptions or refill section");
        await page.waitForTimeout(2000);
        const medTarget = params.rxNumber
            ? `prescription with Rx number ${params.rxNumber}`
            : params.medicationName
                ? `${params.medicationName}${params.seniorName ? ` for ${params.seniorName}` : ""}`
                : "the most recently filled prescription";
        await session.stagehand.act(`Find and select ${medTarget}`);
        await page.waitForTimeout(2000);
        await session.stagehand.act("Request a refill for this prescription");
        await page.waitForTimeout(3000);
        const details = await session.stagehand.extract("Extract the refill details: medication name, Rx number, estimated ready date, and pickup location", zod_1.z.object({
            medication: zod_1.z.string(),
            rxNumber: zod_1.z.string().optional(),
            estimatedReady: zod_1.z.string().optional(),
            pickupLocation: zod_1.z.string().optional(),
        }));
        await (0, credentialVault_1.markCredentialUsed)(params.userId, service, true);
        await (0, browserbaseClient_1.logBrowserSession)({
            userId: params.userId, phone: params.phone, sessionId: session.sessionId,
            action: "pharmacy_refill", success: true,
            result: `Refill requested for ${(_d = (_c = details === null || details === void 0 ? void 0 : details.medication) !== null && _c !== void 0 ? _c : params.medicationName) !== null && _d !== void 0 ? _d : "prescription"}`,
            durationMs: Date.now() - startTime,
        });
        return {
            success: true,
            result: `Refill requested for ${(_f = (_e = details === null || details === void 0 ? void 0 : details.medication) !== null && _e !== void 0 ? _e : params.medicationName) !== null && _f !== void 0 ? _f : "prescription"}`,
            refillDetails: details !== null && details !== void 0 ? details : undefined,
            sessionId: session.sessionId,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await (0, credentialVault_1.markCredentialUsed)(params.userId, service, false);
        await (0, browserbaseClient_1.logBrowserSession)({
            userId: params.userId, phone: params.phone, sessionId: (_g = session === null || session === void 0 ? void 0 : session.sessionId) !== null && _g !== void 0 ? _g : "error",
            action: "pharmacy_refill", success: false,
            error: message, durationMs: Date.now() - startTime,
        });
        return {
            success: false,
            result: `I ran into a problem with the ${service} refill. ` +
                `Reply "update my ${service} login" if your password changed.`,
            sessionId: session === null || session === void 0 ? void 0 : session.sessionId,
        };
    }
    finally {
        if (session)
            await (0, browserbaseClient_1.closeBrowserSession)(session);
    }
}
// ── ACTION 7: Check insurance coverage / authorization / claim status ─────────
async function checkInsuranceAuthorization(params) {
    var _a, _b, _c, _d;
    const startTime = Date.now();
    let session = null;
    const service = (0, credentialVault_1.insurerToServiceKey)(params.insurer);
    const credentials = await (0, credentialVault_1.getCredential)(params.userId, service);
    if (!credentials) {
        return { success: false, result: "credentials_required", needsCredentials: true };
    }
    try {
        session = await (0, browserbaseClient_1.createBrowserSession)({ proxies: true, solveCaptchas: true });
        const page = session.page;
        const portalUrl = (_b = (_a = params.insurerPortalUrl) !== null && _a !== void 0 ? _a : credentials.portalUrl) !== null && _b !== void 0 ? _b : `https://www.${params.insurer.toLowerCase().replace(/\s+/g, "")}.com/member`;
        await page.goto(portalUrl, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);
        await session.stagehand.act(`Log in with username "${credentials.username}" and password "${credentials.password}"`);
        await page.waitForTimeout(3000);
        const navTarget = {
            coverage: "Navigate to benefits or coverage section",
            authorization: "Navigate to prior authorization or referrals section",
            claim_status: "Navigate to claims or claim status section",
        };
        await session.stagehand.act(navTarget[params.checkType]);
        await page.waitForTimeout(2000);
        if (params.referenceNumber) {
            await session.stagehand.act(`Search for reference number ${params.referenceNumber}`);
            await page.waitForTimeout(2000);
        }
        else if (params.serviceDescription) {
            await session.stagehand.act(`Check ${params.checkType} for: ${params.serviceDescription}` +
                (params.seniorName ? ` for ${params.seniorName}` : ""));
            await page.waitForTimeout(2000);
        }
        const details = await session.stagehand.extract(`Extract the ${params.checkType} result: status, whether covered, authorization number, effective dates, and key notes`, zod_1.z.object({
            status: zod_1.z.string(),
            covered: zod_1.z.boolean().optional(),
            authorizationNumber: zod_1.z.string().optional(),
            effectiveDate: zod_1.z.string().optional(),
            notes: zod_1.z.string().optional(),
        }));
        await (0, credentialVault_1.markCredentialUsed)(params.userId, service, true);
        await (0, browserbaseClient_1.logBrowserSession)({
            userId: params.userId, phone: params.phone, sessionId: session.sessionId,
            action: "insurance_check", success: true,
            result: `${params.checkType} check: ${(_c = details === null || details === void 0 ? void 0 : details.status) !== null && _c !== void 0 ? _c : "complete"}`,
            durationMs: Date.now() - startTime,
        });
        return {
            success: true,
            result: `${params.insurer} ${params.checkType} check complete`,
            details: details !== null && details !== void 0 ? details : undefined,
            sessionId: session.sessionId,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await (0, credentialVault_1.markCredentialUsed)(params.userId, service, false);
        await (0, browserbaseClient_1.logBrowserSession)({
            userId: params.userId, phone: params.phone, sessionId: (_d = session === null || session === void 0 ? void 0 : session.sessionId) !== null && _d !== void 0 ? _d : "error",
            action: "insurance_check", success: false,
            error: message, durationMs: Date.now() - startTime,
        });
        return {
            success: false,
            result: `I ran into a problem checking ${params.insurer}. ` +
                `The portal may require updated credentials or be temporarily down.`,
            sessionId: session === null || session === void 0 ? void 0 : session.sessionId,
        };
    }
    finally {
        if (session)
            await (0, browserbaseClient_1.closeBrowserSession)(session);
    }
}
//# sourceMappingURL=careWebActions.js.map