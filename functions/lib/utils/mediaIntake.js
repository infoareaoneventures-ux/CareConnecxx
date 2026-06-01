"use strict";
/**
 * Inbound image / document support.
 *
 * Caregivers (and clients) on iMessage/RCS naturally snap a photo of their CNA
 * card or take a headshot and text it straight into the thread — far easier than
 * leaving the conversation for a web upload link. Linq delivers those as non-text
 * parts on the inbound webhook. Until now Cara read ONLY `type:"text"` parts and
 * dropped everything else into a generic "Got your message!" reply, which broke
 * the natural flow at exactly the photo/document onboarding steps.
 *
 * This module mirrors voiceTranscription.ts / locationShare.ts:
 *
 *   1. Detects an image or document part (tolerant of several shapes — Linq's
 *      inbound media schema isn't strictly documented).
 *   2. Downloads the bytes (direct signed URL, falling back to authenticated
 *      fetch, or resolving an attachment_id via the Attachments API).
 *   3. Stores the file in Firebase Storage on the SAME paths the web upload page
 *      uses (`profile_photos/…`, `caregiver_docs/…`) and returns a long-lived
 *      read URL, so the rest of Cara treats a texted photo identically to a
 *      web-uploaded one.
 *
 * Audio (voice memos), location pins, stickers, and plain text are deliberately
 * NOT matched here — each has its own dedicated path in the webhook.
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
exports.extractMediaPart = extractMediaPart;
exports.downloadMedia = downloadMedia;
exports.storeInboundMedia = storeInboundMedia;
const axios_1 = __importDefault(require("axios"));
const admin = __importStar(require("firebase-admin"));
const IMAGE_EXT = ["jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "tiff", "bmp"];
const DOC_EXT = ["pdf", "doc", "docx", "txt", "rtf", "csv"];
function extOf(filename) {
    if (!filename)
        return "";
    const m = filename.toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/);
    return m ? m[1] : "";
}
function isImageContentType(ct) {
    return ct.startsWith("image/");
}
function isDocContentType(ct) {
    return (ct === "application/pdf" ||
        ct.startsWith("application/msword") ||
        ct.includes("officedocument") ||
        ct === "text/plain" ||
        ct === "text/rtf" ||
        ct === "application/rtf" ||
        ct === "text/csv");
}
/**
 * Pull the first image / document part out of an inbound webhook's parts array.
 * Returns null if none found.
 *
 * Tolerant of several shapes since Linq's inbound media field names aren't tightly
 * specified:
 *   - `type: "image" | "photo"` or `type: "media"` with an image content_type / ext
 *   - `type: "document" | "file"` or `type: "media"` with a document content_type / ext
 *   - url under `url` / `media_url` / nested `attachment.url`, or an `attachment_id`
 *
 * Audio parts, location parts, stickers, and bare text are skipped — they have
 * their own handlers (voiceTranscription, locationShare, the sticker fast-reply).
 */
function extractMediaPart(parts) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    for (const p of parts !== null && parts !== void 0 ? parts : []) {
        const type = String((_a = p === null || p === void 0 ? void 0 : p.type) !== null && _a !== void 0 ? _a : "").toLowerCase();
        // Never claim parts owned by another handler.
        if (type === "text" || type === "sticker" || type === "location" ||
            type === "location_share" || type === "geo" || type === "voice_memo" ||
            type === "voicememo" || type === "audio")
            continue;
        const nested = ((_c = (_b = p === null || p === void 0 ? void 0 : p.attachment) !== null && _b !== void 0 ? _b : p === null || p === void 0 ? void 0 : p.media) !== null && _c !== void 0 ? _c : {});
        const contentType = String((_g = (_f = (_e = (_d = p === null || p === void 0 ? void 0 : p.content_type) !== null && _d !== void 0 ? _d : p === null || p === void 0 ? void 0 : p.mime_type) !== null && _e !== void 0 ? _e : nested === null || nested === void 0 ? void 0 : nested.content_type) !== null && _f !== void 0 ? _f : nested === null || nested === void 0 ? void 0 : nested.mime_type) !== null && _g !== void 0 ? _g : "").toLowerCase();
        const filename = (_j = (_h = p === null || p === void 0 ? void 0 : p.filename) !== null && _h !== void 0 ? _h : p === null || p === void 0 ? void 0 : p.name) !== null && _j !== void 0 ? _j : nested === null || nested === void 0 ? void 0 : nested.filename;
        const ext = extOf(filename) || extOf(p === null || p === void 0 ? void 0 : p.url);
        // Audio that slipped through as type:"media" — leave it for the voice path.
        if (contentType.startsWith("audio/"))
            continue;
        const isImage = type === "image" || type === "photo" ||
            isImageContentType(contentType) || IMAGE_EXT.includes(ext);
        const isDocument = type === "document" || type === "file" ||
            isDocContentType(contentType) || DOC_EXT.includes(ext);
        if (!isImage && !isDocument)
            continue;
        const url = (_l = (_k = p === null || p === void 0 ? void 0 : p.url) !== null && _k !== void 0 ? _k : p === null || p === void 0 ? void 0 : p.media_url) !== null && _l !== void 0 ? _l : nested === null || nested === void 0 ? void 0 : nested.url;
        const attachment_id = (_m = p === null || p === void 0 ? void 0 : p.attachment_id) !== null && _m !== void 0 ? _m : nested === null || nested === void 0 ? void 0 : nested.id;
        if (!url && !attachment_id)
            continue;
        return {
            kind: isImage ? "image" : "document",
            url,
            attachment_id,
            content_type: contentType || undefined,
            filename,
        };
    }
    return null;
}
/**
 * Resolve a downloadable URL and fetch the bytes. Mirrors the voice-memo
 * download: try the signed URL directly, fall back to an authenticated fetch if
 * it's gated, and resolve an `attachment_id` via the Attachments API when no
 * direct URL was provided. Throws on any failure (callers fall back gracefully).
 */
async function downloadMedia(part) {
    var _a;
    let downloadUrl = part.url;
    let contentType = (_a = part.content_type) !== null && _a !== void 0 ? _a : "";
    if (!downloadUrl && part.attachment_id) {
        const { getAttachment } = await Promise.resolve().then(() => __importStar(require("../linq/attachments")));
        const attachment = await getAttachment(part.attachment_id);
        downloadUrl = attachment.url;
        contentType = contentType || attachment.content_type;
    }
    if (!downloadUrl)
        throw new Error("mediaIntake: no downloadable URL");
    const { buffer, headerType } = await fetchBytes(downloadUrl);
    const resolvedType = contentType || headerType ||
        (part.kind === "image" ? "image/jpeg" : "application/octet-stream");
    return {
        buffer,
        content_type: resolvedType,
        ext: guessExt(resolvedType, part.filename),
    };
}
async function fetchBytes(url) {
    var _a, _b, _c, _d, _e, _f;
    const MAX = 25 * 1024 * 1024; // 25 MB ceiling for an inbound photo/document
    try {
        const res = await axios_1.default.get(url, {
            responseType: "arraybuffer",
            timeout: 20000,
            maxContentLength: MAX,
        });
        return {
            buffer: Buffer.from(res.data),
            headerType: String((_b = (_a = res.headers) === null || _a === void 0 ? void 0 : _a["content-type"]) !== null && _b !== void 0 ? _b : ""),
        };
    }
    catch (err) {
        const status = (_c = err === null || err === void 0 ? void 0 : err.response) === null || _c === void 0 ? void 0 : _c.status;
        const apiKey = (_d = process.env.LINQ_API_KEY) !== null && _d !== void 0 ? _d : "";
        if ((status === 401 || status === 403) && apiKey) {
            const res = await axios_1.default.get(url, {
                responseType: "arraybuffer",
                timeout: 20000,
                maxContentLength: MAX,
                headers: { Authorization: `Bearer ${apiKey}` },
            });
            return {
                buffer: Buffer.from(res.data),
                headerType: String((_f = (_e = res.headers) === null || _e === void 0 ? void 0 : _e["content-type"]) !== null && _f !== void 0 ? _f : ""),
            };
        }
        throw err;
    }
}
function guessExt(contentType, filename) {
    const fromName = extOf(filename);
    if (fromName)
        return fromName;
    const ct = contentType.toLowerCase();
    if (ct.includes("jpeg") || ct.includes("jpg"))
        return "jpg";
    if (ct.includes("png"))
        return "png";
    if (ct.includes("heic"))
        return "heic";
    if (ct.includes("heif"))
        return "heif";
    if (ct.includes("webp"))
        return "webp";
    if (ct.includes("gif"))
        return "gif";
    if (ct.includes("pdf"))
        return "pdf";
    if (ct.includes("msword"))
        return "doc";
    if (ct.includes("officedocument"))
        return "docx";
    if (ct.includes("csv"))
        return "csv";
    if (ct.includes("rtf"))
        return "rtf";
    if (ct.includes("plain"))
        return "txt";
    return contentType.startsWith("image/") ? "jpg" : "bin";
}
/**
 * Store inbound media in Firebase Storage on the SAME path convention the web
 * upload page uses (`profile_photos/…` for headshots, `caregiver_docs/…` for
 * documents) and return a long-lived signed read URL — matching the existing
 * signed-URL pattern in invoicing.ts / voiceSummary.ts.
 */
async function storeInboundMedia(params) {
    const folder = params.kind === "image" ? "profile_photos" : "caregiver_docs";
    const safePhone = params.phone.replace(/[^0-9]/g, "");
    const path = `${folder}/${safePhone}_${Date.now()}.${params.ext}`;
    const bucket = admin.storage().bucket();
    const file = bucket.file(path);
    await file.save(params.buffer, {
        contentType: params.content_type,
        resumable: false,
    });
    const [url] = await file.getSignedUrl({ action: "read", expires: "01-01-2100" });
    return url;
}
//# sourceMappingURL=mediaIntake.js.map