import { db } from '../lib/firebase';
import * as admin from 'firebase-admin';

// Configuration for different rate limit types
export const RATE_LIMITS = {
    signup: { windowMs: 3600000, maxRequests: 5 },  // 5 signups per hour per IP/email
    booking: { windowMs: 60000, maxRequests: 5 },   // 5 bookings per minute per user
    default: { windowMs: 60000, maxRequests: 10 }   // default limits
};

export async function checkRateLimit(key: string, options: { windowMs: number; maxRequests: number; keyPrefix?: string } = RATE_LIMITS.default): Promise<{ allowed: boolean; retryAfterMs?: number }> {
    if (!db) {
        console.warn('DB not initialized, skipping rate limit check.');
        return { allowed: true };
    }

    const { windowMs, maxRequests, keyPrefix = 'rl:default:' } = options;
    const fullKey = `${keyPrefix}${key}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    try {
        const rateLimitRef = db.collection('rate_limits').doc(fullKey);
        
        // Use a transaction to ensure atomic updates
        return await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(rateLimitRef);
            
            if (!doc.exists) {
                transaction.set(rateLimitRef, {
                    count: 1,
                    firstRequest: now,
                    lastRequest: now
                });
                return { allowed: true };
            }

            const data = doc.data();
            if (!data) return { allowed: true };

            // If the window has expired, reset the counter
            if (data.firstRequest < windowStart) {
                transaction.set(rateLimitRef, {
                    count: 1,
                    firstRequest: now,
                    lastRequest: now
                });
                return { allowed: true };
            }

            // If within window and over limit
            if (data.count >= maxRequests) {
                const retryAfterMs = (data.firstRequest + windowMs) - now;
                return { allowed: false, retryAfterMs };
            }

            // Increment the counter
            transaction.update(rateLimitRef, {
                count: data.count + 1,
                lastRequest: now
            });

            return { allowed: true };
        });
    } catch (error) {
        console.error('Rate limiting error:', error);
        // Fail open if the rate limit system itself errors
        return { allowed: true };
    }
}

export async function checkSignupRateLimit(): Promise<{ allowed: boolean; retryAfterMs?: number }> {
    const ip = getClientIP();
    return checkRateLimit(ip, { ...RATE_LIMITS.signup, keyPrefix: 'rl:signup:ip:' });
}

export function getClientIP(): string {
    // In a real browser context this is hard to get reliably without a backend.
    // In Firebase functions context, we would extract this from req.ip.
    // Assuming this is used mostly client-side for now, or passed down.
    return 'client-side-ip-placeholder';
}

export async function cleanupRateLimits(): Promise<number> {
    if (!db) return 0;
    try {
        const now = Date.now();
        // Delete documents older than 24 hours (86400000 ms) to keep the collection small
        const cutoff = now - 86400000;
        const snapshot = await db.collection('rate_limits').where('lastRequest', '<', cutoff).limit(500).get();
        
        const batch = db.batch();
        snapshot.docs.forEach((doc) => {
            batch.delete(doc.ref);
        });
        await batch.commit();
        return snapshot.size;
    } catch (error) {
        console.error('Cleanup rate limits error:', error);
        return 0;
    }
}
