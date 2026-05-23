"use strict";
/**
 * Inbound voice-memo support.
 *
 * Users (especially older clients) often can't type easily — they tap-and-hold
 * to send an iMessage voice memo instead. Linq delivers those as a non-text
 * part on the inbound webhook. This module:
 *
 *   1. Detects a voice-memo part on the webhook payload (tolerant of several
 *      shapes — Linq's inbound schema for media isn't strictly documented).
 *   2. Resolves a downloadable URL (direct or via attachment lookup).
 *   3. Downloads the audio bytes (falling back to authenticated fetch if the
 *      URL is gated).
 *   4. Transcribes via OpenAI Whisper so the rest of Cara can treat the
 *      result as if the user had typed it.
 *
 * Whisper handles every format Linq accepts for voice memos (mp3, m4a, aac,
 * caf, wav, aiff, amr), so there is no transcoding step.
 */
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
exports.extractVoiceMemoPart = extractVoiceMemoPart;
exports.transcribeVoiceMemo = transcribeVoiceMemo;
const openai_1 = require("openai");
const axios_1 = __importDefault(require("axios"));
const openaiClient_1 = require("./openaiClient");
/**
 * Pull the first voice-memo / audio part out of an inbound webhook's parts array.
 * Returns null if none found.
 *
 * Tolerant of several shapes since the inbound payload field names for media
 * aren't tightly specified in Linq's public docs:
 *   - `type: "voice_memo"` (most likely)
 *   - `type: "audio"`
 *   - `type: "media"` with `content_type` / `mime_type` starting with "audio/"
 *   - a nested `voice_memo` object (per the outbound response schema)
 */
function extractVoiceMemoPart(parts) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    for (const p of parts !== null && parts !== void 0 ? parts : []) {
        const type = String((_a = p === null || p === void 0 ? void 0 : p.type) !== null && _a !== void 0 ? _a : "").toLowerCase();
        const contentType = String((_c = (_b = p === null || p === void 0 ? void 0 : p.content_type) !== null && _b !== void 0 ? _b : p === null || p === void 0 ? void 0 : p.mime_type) !== null && _c !== void 0 ? _c : "");
        const isVoiceType = type === "voice_memo" || type === "voicememo" || type === "audio";
        const isAudioMedia = type === "media" && contentType.startsWith("audio/");
        const hasVoiceField = !!((p === null || p === void 0 ? void 0 : p.voice_memo_url) || (p === null || p === void 0 ? void 0 : p.voice_memo));
        if (!isVoiceType && !isAudioMedia && !hasVoiceField)
            continue;
        const nested = ((_d = p === null || p === void 0 ? void 0 : p.voice_memo) !== null && _d !== void 0 ? _d : {});
        const url = (_g = (_f = (_e = p === null || p === void 0 ? void 0 : p.url) !== null && _e !== void 0 ? _e : p === null || p === void 0 ? void 0 : p.voice_memo_url) !== null && _f !== void 0 ? _f : p === null || p === void 0 ? void 0 : p.media_url) !== null && _g !== void 0 ? _g : nested === null || nested === void 0 ? void 0 : nested.url;
        const attachment_id = (_h = p === null || p === void 0 ? void 0 : p.attachment_id) !== null && _h !== void 0 ? _h : nested === null || nested === void 0 ? void 0 : nested.id;
        const resolvedContentType = contentType || (nested === null || nested === void 0 ? void 0 : nested.mime_type) || undefined;
        const duration_ms = (_j = p === null || p === void 0 ? void 0 : p.duration_ms) !== null && _j !== void 0 ? _j : nested === null || nested === void 0 ? void 0 : nested.duration_ms;
        if (url || attachment_id) {
            return { url, attachment_id, content_type: resolvedContentType, duration_ms };
        }
    }
    return null;
}
/**
 * Download the voice memo and transcribe via Whisper. Throws on any failure;
 * callers should catch and fall back to a generic "got your message" response.
 */
async function transcribeVoiceMemo(part) {
    var _a;
    let downloadUrl = part.url;
    if (!downloadUrl && part.attachment_id) {
        const { getAttachment } = await Promise.resolve().then(() => __importStar(require("../linq/attachments")));
        const attachment = await getAttachment(part.attachment_id);
        downloadUrl = attachment.url;
    }
    if (!downloadUrl)
        throw new Error("voiceTranscription: no downloadable URL");
    const buffer = await downloadAudio(downloadUrl);
    const filename = guessFilename(part.content_type);
    const file = await (0, openai_1.toFile)(buffer, filename, {
        type: part.content_type || "audio/m4a",
    });
    const result = await (0, openaiClient_1.getOpenAIClient)().audio.transcriptions.create({
        file,
        model: "whisper-1",
        response_format: "text",
    });
    const transcript = typeof result === "string"
        ? result
        : ((_a = result === null || result === void 0 ? void 0 : result.text) !== null && _a !== void 0 ? _a : "");
    return transcript.trim();
}
async function downloadAudio(url) {
    var _a, _b;
    try {
        const res = await axios_1.default.get(url, {
            responseType: "arraybuffer",
            timeout: 15000,
            maxContentLength: 15 * 1024 * 1024,
        });
        return Buffer.from(res.data);
    }
    catch (err) {
        const status = (_a = err === null || err === void 0 ? void 0 : err.response) === null || _a === void 0 ? void 0 : _a.status;
        const apiKey = (_b = process.env.LINQ_API_KEY) !== null && _b !== void 0 ? _b : "";
        if ((status === 401 || status === 403) && apiKey) {
            const res = await axios_1.default.get(url, {
                responseType: "arraybuffer",
                timeout: 15000,
                maxContentLength: 15 * 1024 * 1024,
                headers: { Authorization: `Bearer ${apiKey}` },
            });
            return Buffer.from(res.data);
        }
        throw err;
    }
}
function guessFilename(contentType) {
    const ct = (contentType !== null && contentType !== void 0 ? contentType : "").toLowerCase();
    if (ct.includes("mpeg") || ct.includes("mp3"))
        return "voicememo.mp3";
    if (ct.includes("wav"))
        return "voicememo.wav";
    if (ct.includes("aac"))
        return "voicememo.aac";
    if (ct.includes("amr"))
        return "voicememo.amr";
    if (ct.includes("aiff"))
        return "voicememo.aiff";
    if (ct.includes("caf"))
        return "voicememo.caf";
    return "voicememo.m4a";
}
//# sourceMappingURL=voiceTranscription.js.map