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
exports.generateFaceTimeLink = generateFaceTimeLink;
exports.generateGoogleMeetLink = generateGoogleMeetLink;
exports.generateICSFile = generateICSFile;
exports.uploadICSToStorage = uploadICSToStorage;
exports.generateCallLink = generateCallLink;
const admin = __importStar(require("firebase-admin"));
// ── FaceTime Link ──────────────────────────────────────────────────────────────
async function generateFaceTimeLink() {
    const res = await fetch("https://facetime.apple.com/api/v1/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
    });
    if (!res.ok)
        throw new Error(`FaceTime API error: ${res.status}`);
    const data = await res.json();
    if (!data.url)
        throw new Error("FaceTime API returned no URL");
    return data.url;
}
// ── Google Meet Link ───────────────────────────────────────────────────────────
async function generateGoogleMeetLink(params) {
    var _a, _b, _c, _d;
    const { google } = await Promise.resolve().then(() => __importStar(require("googleapis")));
    const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const calendar = google.calendar({ version: "v3", auth });
    const endTime = new Date(new Date(params.startTime).getTime() + params.durationMinutes * 60000).toISOString();
    const event = await calendar.events.insert({
        calendarId: "primary",
        conferenceDataVersion: 1,
        requestBody: {
            summary: params.title,
            start: { dateTime: params.startTime },
            end: { dateTime: endTime },
            conferenceData: {
                createRequest: { requestId: `cara-${Date.now()}` },
            },
        },
    });
    const meetUrl = (_d = (_c = (_b = (_a = event.data.conferenceData) === null || _a === void 0 ? void 0 : _a.entryPoints) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.uri) !== null && _d !== void 0 ? _d : "";
    if (!meetUrl)
        throw new Error("Google Meet link generation failed");
    return meetUrl;
}
// ── .ics Calendar File ─────────────────────────────────────────────────────────
function generateICSFile(params) {
    var _a;
    const uid = (_a = params.uid) !== null && _a !== void 0 ? _a : `cara-${Date.now()}@cara.com`;
    const start = toICSDate(params.startTime);
    const end = toICSDate(new Date(new Date(params.startTime).getTime() + params.durationMinutes * 60000).toISOString());
    const safeDesc = params.description.replace(/\n/g, "\\n");
    return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Cara//Care Interview//EN",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTART:${start}`,
        `DTEND:${end}`,
        `SUMMARY:${params.title}`,
        `DESCRIPTION:${safeDesc}\\n\\nJoin: ${params.callUrl}`,
        `URL:${params.callUrl}`,
        "BEGIN:VALARM",
        "TRIGGER:-PT30M",
        "ACTION:DISPLAY",
        "DESCRIPTION:Interview starting in 30 minutes",
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
    ].join("\r\n");
}
function toICSDate(iso) {
    return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "").replace("Z", "Z");
}
// ── Upload .ics to Firebase Storage ───────────────────────────────────────────
async function uploadICSToStorage(content, path) {
    const bucket = admin.storage().bucket();
    const file = bucket.file(path);
    await file.save(Buffer.from(content, "utf-8"), {
        metadata: { contentType: "text/calendar" },
    });
    await file.makePublic();
    return `https://storage.googleapis.com/${bucket.name}/${path}`;
}
// ── Pick best call link (FaceTime for iMessage, Meet otherwise) ───────────────
async function generateCallLink(params) {
    if (params.isIMessage) {
        try {
            return await generateFaceTimeLink();
        }
        catch (err) {
            console.warn("FaceTime link failed, falling back to Google Meet:", err);
        }
    }
    return generateGoogleMeetLink({
        startTime: params.startTime,
        durationMinutes: params.durationMinutes,
        title: params.title,
    });
}
//# sourceMappingURL=interviewLinks.js.map