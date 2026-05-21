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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startHealthcareFlow = startHealthcareFlow;
exports.resumeHealthcareFlow = resumeHealthcareFlow;
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const caraMessage_1 = require("../utils/caraMessage");
const careWebActions_1 = require("../browser/careWebActions");
const credentialVault_1 = require("../browser/credentialVault");
const db = admin.firestore();
let _claude = null;
function getClaude() {
    if (!_claude)
        _claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
}
async function parseWithClaude(prompt, userText) {
    var _a;
    try {
        const response = await getClaude().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 200,
            system: prompt,
            messages: [{ role: "user", content: userText }],
        });
        return ((_a = response.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
    }
    catch (_b) {
        return "__parse_error__";
    }
}
async function isQuestionOrOther(text) {
    const result = await parseWithClaude("Reply YES if this is a general question or off-topic comment unrelated to answering the current question. " +
        "Reply NO if it is a direct answer. Only reply YES or NO.", text);
    return result.toUpperCase().startsWith("Y");
}
async function answerMidFlow(text, context) {
    var _a;
    const response = await getClaude().messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        system: `You are Cara, a warm AI care assistant. A client is in the middle of a healthcare request. ` +
            `Context: ${context}. Answer their question briefly (1–2 sentences).`,
        messages: [{ role: "user", content: text }],
    });
    return ((_a = response.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
}
// ── Firestore state helpers ───────────────────────────────────────────────────
async function setFlowState(phone, step, data, ttlMs = 20 * 60 * 1000) {
    await db.collection("agent_sessions").doc(phone).update({
        healthcareFlowStep: step,
        healthcareFlowData: data,
        stateExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
    });
}
async function clearFlowState(phone) {
    await db.collection("agent_sessions").doc(phone).update({
        healthcareFlowStep: admin.firestore.FieldValue.delete(),
        healthcareFlowData: admin.firestore.FieldValue.delete(),
        stateExpiresAt: admin.firestore.FieldValue.delete(),
    });
}
// ── Provider search execution ─────────────────────────────────────────────────
function formatProviderResults(results, summary, providerType, location) {
    if (results.length === 0) {
        return (`I couldn't find any ${providerType}s near ${location}. ` +
            `Try a different zip code or city name.`);
    }
    const lines = [];
    for (let i = 0; i < Math.min(results.length, 5); i++) {
        lines.push(`${i + 1}. ${results[i].name}`);
        if (results[i].url)
            lines.push(`   ${results[i].url}`);
    }
    // Include the fetched snippet if it has useful text (not just URLs)
    const snippet = summary && summary.length > 30 && !summary.startsWith("http")
        ? `\n\n${summary.slice(0, 400)}`
        : "";
    return `Here are ${providerType}s near ${location}:\n\n${lines.join("\n")}${snippet}`;
}
async function doProviderSearch(phone, sendMessage, data, userId) {
    var _a;
    const location = (_a = data.location) !== null && _a !== void 0 ? _a : "";
    const providerType = data.specialty || data.providerType || "healthcare provider";
    await sendMessage("Give me a moment — searching nearby...");
    const result = await (0, careWebActions_1.searchHealthcareProvider)({
        userId,
        phone,
        query: `${providerType} near ${location}`,
        city: location,
    });
    await clearFlowState(phone);
    await sendMessage(formatProviderResults(result.results, result.summary, providerType, location));
}
// ── Appointment booking execution ─────────────────────────────────────────────
async function executeAppointmentBooking(phone, sendMessage, data, userId) {
    var _a, _b, _c;
    const portal = ((_a = data.portalService) !== null && _a !== void 0 ? _a : "mychart");
    const hasCred = await (0, credentialVault_1.hasCredential)(userId, portal);
    if (!hasCred) {
        await clearFlowState(phone);
        const portalLabel = portal === "mychart" ? "MyChart" :
            portal === "athenahealth" ? "athenahealth" : "FollowMyHealth";
        await sendMessage(`To book for you automatically I need your ${portalLabel} login. ` +
            `Reply "save my ${portal} login" and I'll walk you through storing it securely.`);
        return;
    }
    await sendMessage(`Booking your ${(_b = data.appointmentType) !== null && _b !== void 0 ? _b : "appointment"} with ${data.doctorName} — ` +
        `give me a minute...`);
    const result = await (0, careWebActions_1.scheduleDoctorAppointment)({
        userId,
        phone,
        doctorName: (_c = data.doctorName) !== null && _c !== void 0 ? _c : "your doctor",
        appointmentType: data.appointmentType,
        preferredDate: data.preferredDate,
        portalService: portal,
    });
    await clearFlowState(phone);
    if (result.success && result.appointmentDetails) {
        const d = result.appointmentDetails;
        let msg = `Done! Your appointment is booked:\n\n📅 ${d.date} at ${d.time}`;
        if (d.doctor)
            msg += `\nWith ${d.doctor}`;
        if (d.location)
            msg += `\n📍 ${d.location}`;
        if (d.confirmationNumber)
            msg += `\nConfirmation #: ${d.confirmationNumber}`;
        await sendMessage(msg);
    }
    else if (result.needsCredentials) {
        await sendMessage(`I need your ${portal} portal login to book for you. ` +
            `Reply "save my ${portal} login" to set it up.`);
    }
    else {
        await sendMessage(result.result);
    }
}
// ── Prescription refill execution ─────────────────────────────────────────────
async function executePharmacyRefill(phone, sendMessage, data, userId) {
    var _a, _b;
    const pharmacy = ((_a = data.pharmacyService) !== null && _a !== void 0 ? _a : "cvs");
    const hasCred = await (0, credentialVault_1.hasCredential)(userId, pharmacy);
    if (!hasCred) {
        await clearFlowState(phone);
        await sendMessage(`To request the refill for you I need your ${pharmacy.toUpperCase()} account login. ` +
            `Reply "save my ${pharmacy} login" and I'll securely store it.`);
        return;
    }
    const medLabel = (_b = data.medicationName) !== null && _b !== void 0 ? _b : "the prescription";
    await sendMessage(`Requesting the refill at ${pharmacy.toUpperCase()} — give me a moment...`);
    const result = await (0, careWebActions_1.requestPharmacyRefill)({
        userId,
        phone,
        pharmacyService: pharmacy,
        medicationName: data.medicationName,
        rxNumber: data.rxNumber,
    });
    await clearFlowState(phone);
    if (result.success && result.refillDetails) {
        const r = result.refillDetails;
        let msg = `Refill requested for ${r.medication}!`;
        if (r.estimatedReady)
            msg += `\n\nEstimated ready: ${r.estimatedReady}`;
        if (r.pickupLocation)
            msg += `\nPickup: ${r.pickupLocation}`;
        if (r.rxNumber)
            msg += `\nRx #: ${r.rxNumber}`;
        await sendMessage(msg);
    }
    else if (result.needsCredentials) {
        await sendMessage(`I need your ${pharmacy.toUpperCase()} login to request refills. ` +
            `Reply "save my ${pharmacy} login" to set it up.`);
    }
    else {
        await sendMessage(result.result);
    }
}
// ── Entry: start a new healthcare flow ────────────────────────────────────────
async function startHealthcareFlow(phone, chatId, text, session, intent, sendMessage) {
    var _a;
    const userId = (_a = session.userId) !== null && _a !== void 0 ? _a : phone;
    // ── FIND_NEARBY_PROVIDER ──────────────────────────────────────────────────
    if (intent === "FIND_NEARBY_PROVIDER") {
        const parsed = await parseWithClaude(`Extract from this message:
1. providerType: one of "doctor", "clinic", "pharmacy", "urgent care", "dentist", "specialist" — default "doctor"
2. specialty: e.g. "cardiologist", "dermatologist", "pediatrician" — or "" if not specified
3. location: city name, neighborhood, or zip code — or "" if not mentioned

Reply as JSON only: {"providerType":"...","specialty":"...","location":"..."}`, text);
        let providerType = "doctor";
        let specialty = "";
        let location = "";
        try {
            const p = JSON.parse(parsed);
            providerType = p.providerType || "doctor";
            specialty = p.specialty || "";
            location = p.location || "";
        }
        catch ( /* keep defaults */_b) { /* keep defaults */ }
        const data = {
            intent,
            query: specialty || providerType,
            providerType: specialty || providerType,
            specialty,
            location,
        };
        if (!location) {
            await setFlowState(phone, "hc_search_location", data);
            const msg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: `Cara is helping find a nearby ${specialty || providerType}. Ask for the city or zip code to search near.`,
                fallback: `What city or zip code should I search near?`,
                maxTokens: 60,
            });
            await sendMessage(msg);
            return;
        }
        await doProviderSearch(phone, sendMessage, data, userId);
        return;
    }
    // ── BOOK_DOCTOR_APPOINTMENT ───────────────────────────────────────────────
    if (intent === "BOOK_DOCTOR_APPOINTMENT") {
        const parsed = await parseWithClaude(`Extract from this message:
1. doctorName: doctor's name or "" if not mentioned
2. appointmentType: one of "checkup", "follow-up", "urgent", "new patient" — or "" if not specified
3. preferredDate: preferred date in natural language or "" if not mentioned
4. portalService: one of "mychart", "athenahealth", "followmyhealth" — or "" if not mentioned

Reply as JSON only: {"doctorName":"...","appointmentType":"...","preferredDate":"...","portalService":"..."}`, text);
        let doctorName = "";
        let appointmentType = "";
        let preferredDate = "";
        let portalService = "";
        try {
            const p = JSON.parse(parsed);
            doctorName = p.doctorName || "";
            appointmentType = p.appointmentType || "";
            preferredDate = p.preferredDate || "";
            portalService = p.portalService || "";
        }
        catch ( /* keep defaults */_c) { /* keep defaults */ }
        const data = { intent, doctorName, appointmentType, preferredDate, portalService };
        if (!doctorName) {
            await setFlowState(phone, "hc_appt_doctor", data);
            const msg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: "Cara is helping book a doctor appointment. Ask for the doctor's name.",
                fallback: "Which doctor would you like to book with?",
                maxTokens: 60,
            });
            await sendMessage(msg);
            return;
        }
        if (!appointmentType) {
            await setFlowState(phone, "hc_appt_type", data);
            await sendMessage(`What type of visit with ${doctorName}? (checkup, follow-up, urgent, or new patient)`);
            return;
        }
        if (!preferredDate) {
            await setFlowState(phone, "hc_appt_date", data);
            const msg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: `Cara is booking a ${appointmentType} with ${doctorName}. Ask what date works best.`,
                fallback: "What date works best for you?",
                maxTokens: 60,
            });
            await sendMessage(msg);
            return;
        }
        if (!portalService) {
            await setFlowState(phone, "hc_appt_portal", data);
            await sendMessage("Which patient portal do you use — MyChart, athenahealth, or FollowMyHealth?");
            return;
        }
        await executeAppointmentBooking(phone, sendMessage, data, userId);
        return;
    }
    // ── PRESCRIPTION_REFILL ───────────────────────────────────────────────────
    if (intent === "PRESCRIPTION_REFILL") {
        const parsed = await parseWithClaude(`Extract from this message:
1. pharmacyService: one of "cvs", "walgreens", "riteaid" — or "" if not mentioned
2. medicationName: medication name or "" if not mentioned
3. rxNumber: Rx prescription number or "" if not mentioned

Reply as JSON only: {"pharmacyService":"...","medicationName":"...","rxNumber":"..."}`, text);
        let pharmacyService = "";
        let medicationName = "";
        let rxNumber = "";
        try {
            const p = JSON.parse(parsed);
            pharmacyService = p.pharmacyService || "";
            medicationName = p.medicationName || "";
            rxNumber = p.rxNumber || "";
        }
        catch ( /* keep defaults */_d) { /* keep defaults */ }
        const data = { intent, pharmacyService, medicationName, rxNumber };
        if (!pharmacyService) {
            await setFlowState(phone, "hc_rx_pharmacy", data);
            await sendMessage("Which pharmacy — CVS, Walgreens, or Rite Aid?");
            return;
        }
        await executePharmacyRefill(phone, sendMessage, data, userId);
        return;
    }
    // ── NEW_PRESCRIPTION ──────────────────────────────────────────────────────
    if (intent === "NEW_PRESCRIPTION") {
        // Detect if this is actually a refill in disguise
        const kind = await parseWithClaude("Is this about renewing/refilling an existing medication the person already takes, " +
            "or a brand-new prescription for a condition they haven't been treated for yet? " +
            'Reply "refill" or "new" only.', text);
        if (kind.toLowerCase() === "refill") {
            await startHealthcareFlow(phone, chatId, text, session, "PRESCRIPTION_REFILL", sendMessage);
            return;
        }
        const condition = await parseWithClaude("What condition or symptom needs this new prescription? Extract just the condition in a few words. Reply 'general' if unclear.", text);
        const data = {
            intent,
            condition: condition === "__parse_error__" ? "general" : condition,
        };
        await setFlowState(phone, "hc_newrx_hasdoctor", data);
        const msg = await (0, caraMessage_1.generateCaraMessage)({
            audience: "family",
            context: `Client needs a new prescription for ${data.condition}. Ask if they have a doctor they'd like to see for this.`,
            fallback: "Do you already have a doctor you'd like to book for this?",
            maxTokens: 80,
        });
        await sendMessage(msg);
        return;
    }
}
// ── Resume: handle replies to in-progress flows ───────────────────────────────
async function resumeHealthcareFlow(phone, chatId, text, session, sendMessage) {
    var _a, _b, _c, _d, _e, _f, _g;
    const step = session.healthcareFlowStep;
    const data = ((_a = session.healthcareFlowData) !== null && _a !== void 0 ? _a : {});
    const userId = (_b = session.userId) !== null && _b !== void 0 ? _b : phone;
    // ── hc_search_location: waiting for city/zip ──────────────────────────────
    if (step === "hc_search_location") {
        if (await isQuestionOrOther(text)) {
            const answer = await answerMidFlow(text, "client is providing their location for a provider search");
            await sendMessage(answer);
            await sendMessage("What city or zip code should I search near?");
            return;
        }
        const location = await parseWithClaude("Extract just the city name, neighborhood, or zip code from this message. Reply with only the location.", text);
        const updated = Object.assign(Object.assign({}, data), { location: location === "__parse_error__" ? text.trim() : location });
        await setFlowState(phone, "hc_search_location", updated);
        await doProviderSearch(phone, sendMessage, updated, userId);
        return;
    }
    // ── hc_appt_doctor: waiting for doctor name ───────────────────────────────
    if (step === "hc_appt_doctor") {
        if (await isQuestionOrOther(text)) {
            const answer = await answerMidFlow(text, "client is booking a doctor appointment");
            await sendMessage(answer);
            await sendMessage("Which doctor would you like to book with?");
            return;
        }
        const doctorName = await parseWithClaude("Extract the doctor's name from this message. Reply with the name only.", text);
        const updated = Object.assign(Object.assign({}, data), { doctorName: doctorName === "__parse_error__" ? text.trim() : doctorName });
        await setFlowState(phone, "hc_appt_type", updated);
        await sendMessage(`What type of visit with ${updated.doctorName}? (checkup, follow-up, urgent, or new patient)`);
        return;
    }
    // ── hc_appt_type: waiting for appointment type ────────────────────────────
    if (step === "hc_appt_type") {
        if (await isQuestionOrOther(text)) {
            const answer = await answerMidFlow(text, "client is choosing appointment type");
            await sendMessage(answer);
            await sendMessage("What type of visit is this? (checkup, follow-up, urgent, or new patient)");
            return;
        }
        const raw = await parseWithClaude('"checkup" or "annual" or "routine" or "physical" → checkup. ' +
            '"follow up" or "follow-up" or "return" → follow-up. ' +
            '"urgent" or "sick" or "asap" → urgent. ' +
            '"new patient" or "first time" or "new" → new patient. ' +
            "Reply with exactly one of: checkup, follow-up, urgent, new patient.", text);
        const apptType = ["checkup", "follow-up", "urgent", "new patient"].includes(raw) ? raw : "checkup";
        const updated = Object.assign(Object.assign({}, data), { appointmentType: apptType });
        await setFlowState(phone, "hc_appt_date", updated);
        const msg = await (0, caraMessage_1.generateCaraMessage)({
            audience: "family",
            context: `Cara is booking a ${apptType} with ${(_c = updated.doctorName) !== null && _c !== void 0 ? _c : "the doctor"}. Ask what date works best.`,
            fallback: "What date works best for you?",
            maxTokens: 60,
        });
        await sendMessage(msg);
        return;
    }
    // ── hc_appt_date: waiting for preferred date ──────────────────────────────
    if (step === "hc_appt_date") {
        if (await isQuestionOrOther(text)) {
            const answer = await answerMidFlow(text, "client is picking an appointment date");
            await sendMessage(answer);
            await sendMessage("What date works best?");
            return;
        }
        const updated = Object.assign(Object.assign({}, data), { preferredDate: text.trim() }); // keep natural language for Stagehand
        if (!updated.portalService) {
            await setFlowState(phone, "hc_appt_portal", updated);
            await sendMessage("Which patient portal do you use — MyChart, athenahealth, or FollowMyHealth?");
            return;
        }
        await executeAppointmentBooking(phone, sendMessage, updated, userId);
        return;
    }
    // ── hc_appt_portal: waiting for portal choice ─────────────────────────────
    if (step === "hc_appt_portal") {
        if (await isQuestionOrOther(text)) {
            const answer = await answerMidFlow(text, "client is choosing their patient portal");
            await sendMessage(answer);
            await sendMessage("Which portal do you use — MyChart, athenahealth, or FollowMyHealth?");
            return;
        }
        const raw = await parseWithClaude('"mychart" or "my chart" → mychart. ' +
            '"athena" or "athenahealth" or "athena health" → athenahealth. ' +
            '"followmyhealth" or "follow my health" or "fmh" → followmyhealth. ' +
            "Reply with exactly one of: mychart, athenahealth, followmyhealth.", text);
        const portal = ["mychart", "athenahealth", "followmyhealth"].includes(raw) ? raw : "mychart";
        await executeAppointmentBooking(phone, sendMessage, Object.assign(Object.assign({}, data), { portalService: portal }), userId);
        return;
    }
    // ── hc_rx_pharmacy: waiting for pharmacy choice ───────────────────────────
    if (step === "hc_rx_pharmacy") {
        if (await isQuestionOrOther(text)) {
            const answer = await answerMidFlow(text, "client is choosing their pharmacy for a refill");
            await sendMessage(answer);
            await sendMessage("Which pharmacy — CVS, Walgreens, or Rite Aid?");
            return;
        }
        const raw = await parseWithClaude('"cvs" or "CVS" → cvs. ' +
            '"walgreens" or "walgreen" → walgreens. ' +
            '"rite aid" or "riteaid" or "rite-aid" → riteaid. ' +
            "Reply with exactly one of: cvs, walgreens, riteaid.", text);
        const pharmacy = ["cvs", "walgreens", "riteaid"].includes(raw) ? raw : "cvs";
        await executePharmacyRefill(phone, sendMessage, Object.assign(Object.assign({}, data), { pharmacyService: pharmacy }), userId);
        return;
    }
    // ── hc_newrx_hasdoctor: do they have a doctor for this? ───────────────────
    if (step === "hc_newrx_hasdoctor") {
        if (await isQuestionOrOther(text)) {
            const answer = await answerMidFlow(text, "client needs a new prescription and Cara asked if they have a doctor");
            await sendMessage(answer);
            await sendMessage("Do you already have a doctor you'd like to book for this?");
            return;
        }
        const raw = await parseWithClaude("Does the user say YES they have a doctor, or NO they don't? Reply YES or NO only.", text);
        const hasDoctor = raw.toUpperCase().startsWith("Y");
        if (hasDoctor) {
            // Pivot to appointment booking flow
            const bookingData = {
                intent: "BOOK_DOCTOR_APPOINTMENT",
                appointmentType: "follow-up",
            };
            await setFlowState(phone, "hc_appt_doctor", bookingData);
            const msg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: `Client needs a prescription for ${(_d = data.condition) !== null && _d !== void 0 ? _d : "a condition"}. They have a doctor. Ask for the doctor's name to book.`,
                fallback: "Which doctor would you like to see for this?",
                maxTokens: 70,
            });
            await sendMessage(msg);
        }
        else {
            // Search for nearby providers based on condition
            const specialty = await parseWithClaude(`Given this medical condition: "${(_e = data.condition) !== null && _e !== void 0 ? _e : "general"}". ` +
                `What type of doctor treats this? Reply with just the specialty (e.g. "cardiologist", "dermatologist", "primary care doctor"). ` +
                `Default to "primary care doctor" if unsure.`, (_f = data.condition) !== null && _f !== void 0 ? _f : "general");
            const providerType = specialty === "__parse_error__" ? "primary care doctor" : specialty;
            const searchData = {
                intent: "FIND_NEARBY_PROVIDER",
                query: providerType,
                providerType,
                specialty: providerType,
            };
            await setFlowState(phone, "hc_search_location", searchData);
            const msg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: `Client needs a ${providerType} for ${(_g = data.condition) !== null && _g !== void 0 ? _g : "a new condition"} and doesn't have one. Ask for city or zip to find nearby options.`,
                fallback: `Let me find a ${providerType} near you. What city or zip code?`,
                maxTokens: 80,
            });
            await sendMessage(msg);
        }
        return;
    }
    // Unrecognized step — clear and apologize
    await clearFlowState(phone);
    const msg = await (0, caraMessage_1.generateCaraMessage)({
        audience: "family",
        context: "There was an issue with a healthcare request. Cara is apologizing and offering to help again.",
        fallback: "Something went wrong with that request — let's start over. What can I help you with?",
        maxTokens: 60,
    });
    await sendMessage(msg);
}
//# sourceMappingURL=healthcareHandler.js.map