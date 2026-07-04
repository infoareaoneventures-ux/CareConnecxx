/**
 * Rate Limiting Middleware for Firebase Cloud Functions
 * Prevents abuse by limiting requests per user/IP
 */

import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

export interface RateLimitConfig {
    windowMs: number;      // Time window in milliseconds
    maxRequests: number;   // Max requests per window
    keyPrefix: string;     // Prefix for rate limit keys
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAt: number;
    retryAfterMs?: number;
}

// Default configs for different endpoints
export const RATE_LIMITS = {
    // Auth endpoints - more restrictive
    auth: {
        windowMs: 15 * 60 * 1000,  // 15 minutes
        maxRequests: 10,           // 10 attempts per 15 min
        keyPrefix: 'rl:auth:'
    },
    // SMS sending - prevent spam
    sms: {
        windowMs: 60 * 60 * 1000,  // 1 hour
        maxRequests: 20,           // 20 SMS per hour per user
        keyPrefix: 'rl:sms:'
    },
    // General API calls
    api: {
        windowMs: 60 * 1000,       // 1 minute
        maxRequests: 60,           // 60 requests per minute
        keyPrefix: 'rl:api:'
    },
    // Background check - very restrictive
    backgroundCheck: {
        windowMs: 24 * 60 * 60 * 1000,  // 24 hours
        maxRequests: 3,                  // 3 attempts per day
        keyPrefix: 'rl:bgcheck:'
    },
    // Stripe operations
    stripe: {
        windowMs: 60 * 60 * 1000,  // 1 hour
        maxRequests: 10,           // 10 payment attempts per hour
        keyPrefix: 'rl:stripe:'
    }
};

/**
 * Check rate limit for a given key (user ID or IP)
 */
export async function checkRateLimit(
    key: string,
    config: RateLimitConfig
): Promise<RateLimitResult> {
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
            } else {
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
    } catch (error) {
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
export function getClientIdentifier(context: any, request?: any): string {
    // Prefer authenticated user ID
    if (context.auth?.uid) {
        return context.auth.uid;
    }
    
    // Fall back to IP address
    if (request?.ip) {
        return `ip:${request.ip}`;
    }
    
    // Last resort - use a hash of headers
    if (request?.headers) {
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
export const checkRateLimitHttp = functions.https.onCall(async (data, context) => {
    // Allow unauthenticated calls for signup rate limiting
    // (since users aren't logged in yet during signup)
    const { key, config } = data;
    
    if (!key || !config) {
        throw new functions.https.HttpsError('invalid-argument', 'Key and config are required');
    }
    
    // Get client identifier with IP extraction from request headers
    // SECURITY: This extracts the real IP server-side, preventing client spoofing
    const rawRequest = (context as any).rawRequest;
    const clientId = getClientIdentifier(context, rawRequest);
    const fullKey = `${config.keyPrefix || 'rl:'}${key}_${clientId}`;
    
    const result = await checkRateLimit(fullKey, config);
    return result;
});

// ── LLM spend guardrails ─────────────────────────────────────────────────────
// The agent loop is bounded per-turn (MAX_TOOL_CALLS_PER_TURN) but nothing
// bounded per-DAY spend: a runaway user, an injection loop, or a webhook storm
// could burn unbounded LLM budget. Two daily counters close that:
//   • checkDailyTurnCap    — per-phone agent turns per day (CARA_DAILY_TURN_CAP)
//   • checkGlobalDailyTurnBudget — global kill-switch (CARA_GLOBAL_DAILY_TURN_CAP)
// Both FAIL OPEN — for a care product, availability beats enforcement; a
// Firestore hiccup must never drop everyone's messages. (Deliberately unlike
// checkRateLimit's fail-closed posture for auth/payment endpoints.)

function envInt(name: string, dflt: number): number {
    const v = parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : dflt;
}

export interface SpendCheckResult {
    allowed: boolean;
    count: number;
    /** True exactly once — the increment that crossed the cap. Callers key
     *  their one-time user message / alert off this. */
    justBreached: boolean;
}

async function bumpDailyCounter(docId: string, cap: number): Promise<SpendCheckResult> {
    const ref = db.collection('rate_limits').doc(docId);
    const count = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const c = ((snap.data()?.count as number | undefined) ?? 0) + 1;
        tx.set(ref, { count: c, updatedAt: Date.now() }, { merge: true });
        return c;
    });
    return { allowed: count <= cap, count, justBreached: count === cap + 1 };
}

export async function checkDailyTurnCap(
    phone: string,
    cap = envInt('CARA_DAILY_TURN_CAP', 150)
): Promise<SpendCheckResult> {
    const day = new Date().toISOString().slice(0, 10);
    try {
        const result = await bumpDailyCounter(`rl:turns:${phone}:${day}`, cap);
        if (result.justBreached) {
            db.collection('admin_alerts').add({
                type: 'daily_turn_cap_hit',
                phone,
                cap,
                severity: 'medium',
                createdAt: new Date().toISOString(),
                resolved: false,
            }).catch(() => {});
        }
        return result;
    } catch (err) {
        console.error('checkDailyTurnCap failed (fail-open):', err);
        return { allowed: true, count: 0, justBreached: false };
    }
}

export async function checkGlobalDailyTurnBudget(
    cap = envInt('CARA_GLOBAL_DAILY_TURN_CAP', 20000)
): Promise<SpendCheckResult> {
    const day = new Date().toISOString().slice(0, 10);
    try {
        const result = await bumpDailyCounter(`rl:global_turns:${day}`, cap);
        if (result.justBreached) {
            db.collection('admin_alerts').add({
                type: 'global_llm_budget_exhausted',
                cap,
                severity: 'critical',
                createdAt: new Date().toISOString(),
                resolved: false,
            }).catch(() => {});
        }
        return result;
    } catch (err) {
        console.error('checkGlobalDailyTurnBudget failed (fail-open):', err);
        return { allowed: true, count: 0, justBreached: false };
    }
}

/**
 * Cleanup old rate limit entries (run periodically)
 */
export async function cleanupRateLimits(): Promise<number> {
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
