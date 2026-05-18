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
exports.getBrowserbase = getBrowserbase;
exports.createBrowserSession = createBrowserSession;
exports.closeBrowserSession = closeBrowserSession;
exports.searchWeb = searchWeb;
exports.fetchPage = fetchPage;
exports.logBrowserSession = logBrowserSession;
const admin = __importStar(require("firebase-admin"));
const sdk_1 = require("@browserbasehq/sdk");
const stagehand_1 = require("@browserbasehq/stagehand");
const db = admin.firestore();
// ── Singleton client ──────────────────────────────────────────────────────────
let _bb = null;
function getBrowserbase() {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    if (!apiKey)
        throw new Error("BROWSERBASE_API_KEY not set");
    if (!_bb)
        _bb = new sdk_1.Browserbase({ apiKey });
    return _bb;
}
async function createBrowserSession(params) {
    var _a, _b;
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;
    if (!apiKey)
        throw new Error("BROWSERBASE_API_KEY not set");
    if (!projectId)
        throw new Error("BROWSERBASE_PROJECT_ID not set");
    const stagehand = new stagehand_1.Stagehand({
        env: "BROWSERBASE",
        apiKey,
        projectId,
        model: "claude-sonnet-4-6",
        verbose: 0,
        disablePino: true,
        browserbaseSessionCreateParams: {
            projectId,
            browserSettings: {
                solveCaptchas: (_a = params.solveCaptchas) !== null && _a !== void 0 ? _a : true,
            },
            proxies: params.proxies ? [{ type: "browserbase" }] : undefined,
        },
    });
    await stagehand.init();
    const page = stagehand.context.pages()[0];
    return {
        sessionId: (_b = stagehand.browserbaseSessionID) !== null && _b !== void 0 ? _b : "unknown",
        stagehand,
        page,
    };
}
async function closeBrowserSession(session) {
    try {
        await session.stagehand.close();
    }
    catch (err) {
        console.error("[closeBrowserSession] error:", err);
    }
}
// ── Search API ────────────────────────────────────────────────────────────────
// Fast web search — up to 25 results. Use before spinning up a browser session.
async function searchWeb(query, numResults = 5) {
    var _a;
    const bb = getBrowserbase();
    const response = await bb.search.web({
        query,
        numResults: Math.min(numResults, 25),
    });
    // SDK returns results on the response object
    const raw = (_a = response.results) !== null && _a !== void 0 ? _a : [];
    return raw.map(r => {
        var _a, _b;
        return ({
            title: (_a = r.title) !== null && _a !== void 0 ? _a : "",
            url: (_b = r.url) !== null && _b !== void 0 ? _b : "",
            publishedDate: r.publishedDate,
        });
    });
}
// ── Fetch API ─────────────────────────────────────────────────────────────────
// Lightweight page retrieval — no JS execution. Use for static content.
async function fetchPage(url, useProxy = false) {
    var _a, _b;
    const bb = getBrowserbase();
    const response = await bb.fetchAPI.create({
        url,
        proxies: useProxy,
    });
    const raw = response;
    return {
        content: (_a = raw.content) !== null && _a !== void 0 ? _a : "",
        statusCode: (_b = raw.statusCode) !== null && _b !== void 0 ? _b : 200,
    };
}
// ── Audit logging ─────────────────────────────────────────────────────────────
async function logBrowserSession(params) {
    try {
        await db.collection("browser_sessions").add(Object.assign(Object.assign({}, params), { timestamp: new Date().toISOString() }));
    }
    catch (err) {
        console.error("[logBrowserSession] failed to write audit log:", err);
    }
}
//# sourceMappingURL=browserbaseClient.js.map