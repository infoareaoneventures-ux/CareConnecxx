"use strict";
/**
 * Rate Limiting Middleware for Firebase Cloud Functions
 * Prevents abuse by limiting requests per user/IP
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkRateLimitHttp = exports.RATE_LIMITS = void 0;
exports.checkRateLimit = checkRateLimit;
exports.getClientIdentifier = getClientIdentifier;
exports.cleanupRateLimits = cleanupRateLimits;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
// Default configs for different endpoints
exports.RATE_LIMITS = {
    // Auth endpoints - more restrictive
    auth: {
        windowMs: 15 * 60 * 1000, // 15 minutes
        maxRequests: 10, // 10 attempts per 15 min
        keyPrefix: 'rl:auth:'
    },
    // SMS sending - prevent spam
    sms: {
        windowMs: 60 * 60 * 1000, // 1 hour
        maxRequests: 20, // 20 SMS per hour per user
        keyPrefix: 'rl:sms:'
    },
    // General API calls
    api: {
        windowMs: 60 * 1000, // 1 minute
        maxRequests: 60, // 60 requests per minute
        keyPrefix: 'rl:api:'
    },
    // Background check - very restrictive
    backgroundCheck: {
        windowMs: 24 * 60 * 60 * 1000, // 24 hours
        maxRequests: 3, // 3 attempts per day
        keyPrefix: 'rl:bgcheck:'
    },
    // Stripe operations
    stripe: {
        windowMs: 60 * 60 * 1000, // 1 hour
        maxRequests: 10, // 10 payment attempts per hour
        keyPrefix: 'rl:stripe:'
    }
};
/**
 * Check rate limit for a given key (user ID or IP)
 */
async function checkRateLimit(key, config) {
    const docId = `${config.keyPrefix}${key}`;
    const now = Date.now();
    try {
        const docRef = db.collection('rate_limits').doc(docId);
        const result = await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(docRef);
            const data = doc.data();
            // Check if we have existing rate limit data
            if (data && data.windowStart && (now - data.windowStart) < config.windowMs) {
                // Still within window
                if (data.count >= config.maxRequests) {
                    // Rate limited
                    const resetAt = data.windowStart + config.windowMs;
                    return {
                        allowed: false,
                        remaining: 0,
                        resetAt,
                        retryAfterMs: resetAt - now
                    };
                }
                // Increment counter
                transaction.update(docRef, { count: data.count + 1 });
                return {
                    allowed: true,
                    remaining: config.maxRequests - data.count - 1,
                    resetAt: data.windowStart + config.windowMs
                };
            }
            else {
                // New window or first request
                transaction.set(docRef, {
                    windowStart: now,
                    count: 1,
                    updatedAt: now
                });
                return {
                    allowed: true,
                    remaining: config.maxRequests - 1,
                    resetAt: now + config.windowMs
                };
            }
        });
        return result;
    }
    catch (error) {
        console.error('Rate limit check failed:', error);
        // Fail closed - deny request if rate limiting fails
        return {
            allowed: false,
            remaining: 0,
            resetAt: Date.now() + 60000,
            retryAfterMs: 60000
        };
    }
}
/**
 * Helper to extract client identifier (user ID or IP)
 */
function getClientIdentifier(context, request) {
    var _a;
    // Prefer authenticated user ID
    if ((_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid) {
        return context.auth.uid;
    }
    // Fall back to IP address
    if (request === null || request === void 0 ? void 0 : request.ip) {
        return `ip:${request.ip}`;
    }
    // Last resort - use a hash of headers
    if (request === null || request === void 0 ? void 0 : request.headers) {
        const forwardedFor = request.headers['x-forwarded-for'];
        if (forwardedFor) {
            return `ip:${forwardedFor.split(',')[0].trim()}`;
        }
    }
    return 'unknown';
}
/**
 * Cloud Function: Check rate limit
 * Called by client for distributed rate limiting
 * Now extracts real IP address server-side for unauthenticated requests
 */
exports.checkRateLimitHttp = functions.https.onCall(async (data, context) => {
    // Allow unauthenticated calls for signup rate limiting
    // (since users aren't logged in yet during signup)
    const { key, config } = data;
    if (!key || !config) {
        throw new functions.https.HttpsError('invalid-argument', 'Key and config are required');
    }
    // Get client identifier with IP extraction from request headers
    // SECURITY: This extracts the real IP server-side, preventing client spoofing
    const rawRequest = context.rawRequest;
    const clientId = getClientIdentifier(context, rawRequest);
    const fullKey = `${config.keyPrefix || 'rl:'}${key}_${clientId}`;
    const result = await checkRateLimit(fullKey, config);
    return result;
});
/**
 * Cleanup old rate limit entries (run periodically)
 */
async function cleanupRateLimits() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago
    const snapshot = await db.collection('rate_limits')
        .where('updatedAt', '<', cutoff)
        .limit(500)
        .get();
    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    console.log(`Cleaned up ${snapshot.size} old rate limit entries`);
    return snapshot.size;
}
//# sourceMappingURL=rateLimit.js.map