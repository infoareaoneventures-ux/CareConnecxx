"use strict";
/**
 * Linq Webhook Subscriptions API
 *
 * Manages CRUD for webhook subscriptions plus a one-time setup utility
 * that registers the Cara webhook URL and stores the signing secret.
 *
 * Usage (run once after deploy):
 *   import { ensureWebhookSubscription } from "./subscriptions";
 *   await ensureWebhookSubscription();
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
exports.CARA_WEBHOOK_EVENTS = void 0;
exports.createSubscription = createSubscription;
exports.listSubscriptions = listSubscriptions;
exports.getSubscription = getSubscription;
exports.updateSubscription = updateSubscription;
exports.deleteSubscription = deleteSubscription;
exports.ensureWebhookSubscription = ensureWebhookSubscription;
exports.setSubscriptionActive = setSubscriptionActive;
const axios_1 = __importDefault(require("axios"));
const admin = __importStar(require("firebase-admin"));
const BASE_URL = (_a = process.env.LINQ_BASE_URL) !== null && _a !== void 0 ? _a : "https://api.linqapp.com/api/partner/v3";
function headers() {
    var _a;
    return {
        Authorization: `Bearer ${(_a = process.env.LINQ_API_KEY) !== null && _a !== void 0 ? _a : ""}`,
        "Content-Type": "application/json",
    };
}
// ── Core events Cara needs ────────────────────────────────────────────────────
exports.CARA_WEBHOOK_EVENTS = [
    "message.sent",
    "message.received",
    "message.delivered",
    "message.read",
    "message.failed",
    "message.edited",
    "reaction.added",
    "reaction.removed",
    "chat.created",
    "chat.typing_indicator.started",
    "chat.typing_indicator.stopped",
    "participant.added",
    "participant.removed",
    "phone_number.status_updated",
];
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
            if ((status === 500 || status === 503) && i < attempts - 1) {
                await new Promise((r) => setTimeout(r, Math.pow(2, i) * 1000));
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}
// ── CRUD ──────────────────────────────────────────────────────────────────────
async function createSubscription(params) {
    const res = await withRetry(() => axios_1.default.post(`${BASE_URL}/webhook-subscriptions`, params, { headers: headers() }));
    return res.data;
}
async function listSubscriptions() {
    var _a, _b, _c;
    const res = await withRetry(() => axios_1.default.get(`${BASE_URL}/webhook-subscriptions`, { headers: headers() }));
    return ((_c = (_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a.subscriptions) !== null && _b !== void 0 ? _b : res.data) !== null && _c !== void 0 ? _c : []);
}
async function getSubscription(id) {
    const res = await withRetry(() => axios_1.default.get(`${BASE_URL}/webhook-subscriptions/${id}`, { headers: headers() }));
    return res.data;
}
async function updateSubscription(id, params) {
    const res = await withRetry(() => axios_1.default.patch(`${BASE_URL}/webhook-subscriptions/${id}`, params, { headers: headers() }));
    return res.data;
}
async function deleteSubscription(id) {
    await withRetry(() => axios_1.default.delete(`${BASE_URL}/webhook-subscriptions/${id}`, { headers: headers() }));
}
// ── One-time setup ────────────────────────────────────────────────────────────
/**
 * Idempotent: registers the Cara webhook URL with Linq if not already present.
 * Persists the signing_secret to Firestore `system_config/linq_webhook`.
 * Run once after each deploy to a new environment.
 *
 * @param webhookUrl  Full HTTPS URL to the linqWebhook Cloud Function endpoint
 * @param events      Override the default CARA_WEBHOOK_EVENTS list
 */
async function ensureWebhookSubscription(webhookUrl, events = exports.CARA_WEBHOOK_EVENTS) {
    var _a;
    const db = admin.firestore();
    // Check if we already have a subscription on record
    const configSnap = await db.collection("system_config").doc("linq_webhook").get();
    const existing = configSnap.data();
    if (existing === null || existing === void 0 ? void 0 : existing.subscriptionId) {
        // Verify it still exists on Linq's side
        try {
            const sub = await getSubscription(existing.subscriptionId);
            if (!sub.is_active) {
                await updateSubscription(sub.id, { is_active: true });
            }
            console.info("ensureWebhookSubscription: existing subscription is active", sub.id);
            return { subscriptionId: sub.id, isNew: false };
        }
        catch (err) {
            const status = (_a = err === null || err === void 0 ? void 0 : err.response) === null || _a === void 0 ? void 0 : _a.status;
            if (status !== 404)
                throw err;
            // 404 — subscription was deleted on Linq's side, fall through to recreate
        }
    }
    // Check remote list to avoid duplicate target_urls
    const allSubs = await listSubscriptions();
    const match = allSubs.find((s) => s.target_url === webhookUrl);
    if (match) {
        // Already registered from a previous run without a Firestore record
        await db.collection("system_config").doc("linq_webhook").set({ subscriptionId: match.id, targetUrl: webhookUrl, updatedAt: new Date().toISOString() }, { merge: true });
        return { subscriptionId: match.id, isNew: false };
    }
    // Create a fresh subscription
    const sub = await createSubscription({
        target_url: webhookUrl,
        subscribed_events: events,
    });
    // Persist subscription ID and signing_secret (signing_secret is shown only on creation)
    await db.collection("system_config").doc("linq_webhook").set({
        subscriptionId: sub.id,
        targetUrl: webhookUrl,
        signingSecret: sub.signing_secret,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });
    console.info("ensureWebhookSubscription: created new subscription", sub.id);
    return { subscriptionId: sub.id, isNew: true };
}
/**
 * Pause or resume all Cara webhook subscriptions.
 * Useful during deployments or maintenance windows.
 */
async function setSubscriptionActive(subscriptionId, active) {
    await updateSubscription(subscriptionId, { is_active: active });
    const db = admin.firestore();
    await db.collection("system_config").doc("linq_webhook").set({ isActive: active, updatedAt: new Date().toISOString() }, { merge: true });
}
//# sourceMappingURL=subscriptions.js.map