"use strict";
/**
 * Linq Attachments API
 *
 * Supports two sending strategies:
 *   - Direct URL  (≤ 10 MB): embed HTTPS URL in media part — no pre-upload needed
 *   - Pre-upload  (> 10 MB, up to 100 MB): get presigned URL → PUT binary → send attachment_id
 *
 * Uploaded attachments never expire and are bound to the creating partner account.
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
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestUploadUrl = requestUploadUrl;
exports.uploadBinary = uploadBinary;
exports.uploadFromUrl = uploadFromUrl;
exports.getAttachment = getAttachment;
exports.deleteAttachment = deleteAttachment;
const axios_1 = __importDefault(require("axios"));
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const BASE_URL = (_a = process.env.LINQ_BASE_URL) !== null && _a !== void 0 ? _a : "https://api.linqapp.com/api/partner/v3";
function headers() {
    var _a;
    return {
        Authorization: `Bearer ${(_a = process.env.LINQ_API_KEY) !== null && _a !== void 0 ? _a : ""}`,
        "Content-Type": "application/json",
    };
}
// ── Retry helper ──────────────────────────────────────────────────────────────
async function withRetry(fn, attempts = 3) {
    var _a;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        }
        catch (err) {
            lastErr = err;
            const status = (_a = err === null || err === void 0 ? void 0 : err.response) === null || _a === void 0 ? void 0 : _a.status;
            if (status === 500 && i < attempts - 1) {
                await new Promise((r) => setTimeout(r, Math.pow(2, i) * 1000));
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}
// ── Core attachment operations ────────────────────────────────────────────────
/**
 * Step 1 of pre-upload flow: request a presigned upload URL.
 * Returns the permanent attachment_id and a 15-minute-valid upload_url.
 */
async function requestUploadUrl(params) {
    var _a;
    const res = await withRetry(() => axios_1.default.post(`${BASE_URL}/attachments`, params, { headers: headers() }));
    return {
        attachment_id: (_a = res.data.id) !== null && _a !== void 0 ? _a : res.data.attachment_id,
        upload_url: res.data.upload_url,
    };
}
/**
 * Step 2 of pre-upload flow: PUT the raw binary to the presigned URL.
 * The upload_url is signed and does not require the Linq API key.
 */
async function uploadBinary(uploadUrl, data, contentType) {
    await withRetry(() => axios_1.default.put(uploadUrl, data, {
        headers: {
            "Content-Type": contentType,
            "Content-Length": String(data.length),
        },
        maxBodyLength: 110 * 1024 * 1024, // 110 MB ceiling (Linq max is 100 MB)
    }));
}
/**
 * Convenience: request presigned URL, fetch remote file, upload it.
 * Use when you have a publicly accessible URL but need permanent storage or >10 MB.
 */
async function uploadFromUrl(params) {
    const fileBuffer = await fetchRemoteBuffer(params.remoteUrl);
    const { attachment_id, upload_url } = await requestUploadUrl({
        filename: params.filename,
        content_type: params.content_type,
        size_bytes: fileBuffer.length,
    });
    await uploadBinary(upload_url, fileBuffer, params.content_type);
    return { attachment_id };
}
/**
 * Retrieve an attachment by ID (also refreshes signed CDN URL if expired).
 */
async function getAttachment(attachmentId) {
    const res = await withRetry(() => axios_1.default.get(`${BASE_URL}/attachments/${attachmentId}`, { headers: headers() }));
    return res.data;
}
/**
 * Permanently delete an attachment (irreversible).
 * Returns true on success (204), false if not found.
 */
async function deleteAttachment(attachmentId) {
    var _a;
    try {
        await withRetry(() => axios_1.default.delete(`${BASE_URL}/attachments/${attachmentId}`, { headers: headers() }));
        return true;
    }
    catch (err) {
        const status = (_a = err === null || err === void 0 ? void 0 : err.response) === null || _a === void 0 ? void 0 : _a.status;
        if (status === 404)
            return false;
        throw err;
    }
}
// ── Internal helpers ──────────────────────────────────────────────────────────
function fetchRemoteBuffer(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith("https") ? https : http;
        protocol.get(url, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        }).on("error", reject);
    });
}
//# sourceMappingURL=attachments.js.map