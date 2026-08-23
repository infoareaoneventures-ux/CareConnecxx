import { stripeService as externalStripeService } from './stripeService';
import { checkRateLimit, RATE_LIMITS } from './rateLimit';

import firebase, { auth, db, functions, isConfigured } from '../lib/firebase';
import { DEFAULT_CAREGIVER_AVATAR } from '../constants';
import { UNBOOKABLE_BG_STATUSES } from '../utils/caregiverEligibility';
import {
    PendingSwap,
    isActiveSwap,
    mapSummaryDoc,
} from './shiftSwap';

// A family-facing "Evia Activity" entry (projection of an allow-listed audit
// event; see functions/src/agents/activityFeedMap.ts). PII-free by construction.
export interface AgentActivityItem {
    id: string;
    eventType: string;
    description: string;
    timestamp?: string;
}

// ==========================================
// RATE LIMITING / DEBOUNCING UTILITIES
// ==========================================

interface DebouncedFunction<T extends (...args: any[]) => any> {
    (...args: Parameters<T>): ReturnType<T>;
    cancel: () => void;
    flush: () => ReturnType<T> | undefined;
}

function debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number,
    immediate: boolean = false
): DebouncedFunction<T> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let lastArgs: Parameters<T> | null = null;
    let lastThis: any = null;
    let result: ReturnType<T> | undefined;

    const later = () => {
        timeout = null;
        if (!immediate && lastArgs) {
            result = func.apply(lastThis, lastArgs);
            lastArgs = null;
            lastThis = null;
        }
    };

    const debounced = function (this: any, ...args: Parameters<T>): ReturnType<T> {
        lastArgs = args;
        lastThis = this;

        const callNow = immediate && !timeout;

        if (timeout) {
            clearTimeout(timeout);
        }

        timeout = setTimeout(later, wait);

        if (callNow) {
            result = func.apply(lastThis, lastArgs);
            lastArgs = null;
            lastThis = null;
        }

        return result as ReturnType<T>;
    };

    debounced.cancel = () => {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = null;
        lastArgs = null;
        lastThis = null;
    };

    debounced.flush = () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
            if (lastArgs) {
                result = func.apply(lastThis, lastArgs);
                lastArgs = null;
                lastThis = null;
            }
        }
        return result;
    };

    return debounced as DebouncedFunction<T>;
}

// Pending promises tracker for deduplication
const pendingPromises = new Map<string, Promise<any>>();

// Legacy local rate limiting - DEPRECATED
// Use the imported checkRateLimit from './rateLimit' for proper distributed rate limiting
const legacyRateLimitMap = new Map<string, string>();
const LEGACY_RATE_LIMIT_WINDOW_MS = 5000;
const LEGACY_RATE_LIMIT_MAX_ATTEMPTS = 3;

/**
 * @deprecated Use checkRateLimit from './rateLimit' for proper distributed rate limiting
 * Local rate limit check - only used as fallback
 */
function checkLocalRateLimit(key: string): string | null {
  const now = Date.now();
  const windowStart = now - LEGACY_RATE_LIMIT_WINDOW_MS;
  
  let attempts: number[] = [];
  const existing = legacyRateLimitMap.get(key);
  
  if (existing) {
    const stored = String(existing).split(',').map(Number).filter(t => t > windowStart);
    attempts = stored;
  }
  
  if (attempts.length >= LEGACY_RATE_LIMIT_MAX_ATTEMPTS) {
    const oldestAttempt = attempts[0];
    const timeToWait = Math.ceil((oldestAttempt + LEGACY_RATE_LIMIT_WINDOW_MS - now) / 1000);
    return `Too many requests. Please wait ${timeToWait} seconds before trying again.`;
  }
  
  attempts.push(now);
  legacyRateLimitMap.set(key, attempts.join(','));
  
  return null;
}

/**
 * @deprecated Use clearRateLimit from './rateLimit'
 */
function clearLocalRateLimit(key: string): void {
  legacyRateLimitMap.delete(key);
}

function dedupePromise<T>(key: string, factory: () => Promise<T>): Promise<T> {
    if (pendingPromises.has(key)) {
        return pendingPromises.get(key) as Promise<T>;
    }

    const promise = factory().finally(() => {
        pendingPromises.delete(key);
    });

    pendingPromises.set(key, promise);
    return promise;
}
import { Caregiver, Appointment, Review, Thread, DirectMessage, Senior, CarePlan, SupportTicket, AppNotification, BackgroundCheckData, AdminUser, MatchFeedback, EmergencyAlert, FamilyMember, Invoice, JobPost } from '../types';
import { errorHandler } from './errorHandler';
import { validators, isFirebaseError, getSafeErrorMessage, normalizePhoneNumber, sanitizeString } from '../utils/validation';
import { sanitizeMessage, sanitizeName, sanitizeBio, sanitizePlainText } from '../utils/sanitize';
import { notifyFamilyOfArrival } from './notificationService';
import { storageService } from './storageService';

// Email/password and Google auth were retired with the phone-only login
// cutover (docs/plans/2026-07-02-001-feat-cara-web-chat-phone-login-plan.md).
// Login is phone OTP at /login; signup is the phone-first /start flow.
// Coerce legacy server-written job_posts docs (Evia pre-2026-07-10) into the
// web JobPost render contract: those docs carried `location` as an OBJECT
// (crashes JSX), `summary` instead of `title`, `hourlyRate` instead of `rate`,
// and no `date` mirror. New writes go through functions'
// agents/jobPostContract.ts (buildWebJobPostDoc), so this is purely a defense
// for docs already in Firestore. Exported for the Job Board's
// direct-collection reads.
export const normalizeJobPost = (raw: any): JobPost => {
    const j: any = { ...raw };
    if (j.location && typeof j.location === 'object') {
        if (j.lat == null && j.location.lat != null) j.lat = j.location.lat;
        if (j.lng == null && j.location.lng != null) j.lng = j.location.lng;
        j.location = [j.location.city ?? j.city, j.zipCode].filter(Boolean).join(', ');
    }
    if (!j.title) j.title = j.summary || 'Care needed';
    if (j.rate == null) {
        if (typeof j.hourlyRate === 'number') j.rate = j.hourlyRate;
        else { j.rate = 0; j.rateFlexible = j.rateFlexible ?? true; }
    }
    if (!j.date && j.startDate) j.date = j.startDate;
    if (!j.careTypes && Array.isArray(j.requirements)) j.careTypes = j.requirements;
    if (Array.isArray(j.schedule?.days) && !j.daysOfWeek && j.schedule.days.length) j.daysOfWeek = j.schedule.days;
    return j as JobPost;
};

// Coerce the canonical care_plans/{clientUid} doc into the web CarePlan shape.
// Evia's update_care_plan tool may append plain strings to the array fields;
// the web UI needs { id, name, … } items. Extra Evia-only fields (careNeeds,
// dietaryNotes, doctorContacts, specialInstructions, notes) are passed through
// via the spread so a web save round-trips them unchanged.
const normalizeCarePlan = (data: any): CarePlan => {
    const arr = (v: any): any[] => (Array.isArray(v) ? v : []);
    const withId = (item: any, i: number, prefix: string) =>
        item && typeof item === 'object'
            ? { ...item, id: item.id || `${prefix}_${i}` }
            : null;
    return {
        ...data,
        medications: arr(data?.medications).map((m, i) =>
            withId(m, i, 'med') ?? { id: `med_${i}`, name: String(m), dosage: '', frequency: '' }),
        emergencyContacts: arr(data?.emergencyContacts).map((c, i) =>
            withId(c, i, 'contact') ?? { id: `contact_${i}`, name: String(c), relation: '', phone: '', isPrimary: false }),
        dailyRoutine: arr(data?.dailyRoutine).map((t, i) =>
            withId(t, i, 'task') ?? { id: `task_${i}`, time: '', description: String(t), category: 'activity' }),
    } as CarePlan;
};

export const dbService = {
    logout: async () => {
        if (isConfigured && auth) {
            await auth.signOut();
        }
    },

    updateUserPassword: async (newPass: string, currentPass?: string) => {
        if (isConfigured && auth && auth.currentUser) {
            if (currentPass && auth.currentUser.email) {
                const credential = firebase.auth.EmailAuthProvider.credential(auth.currentUser.email, currentPass);
                await auth.currentUser.reauthenticateWithCredential(credential);
            }
            await auth.currentUser.updatePassword(newPass);
            return true;
        }
        throw new Error("Not logged in");
    },

    deleteUserAccount: async () => {
        if (isConfigured && auth && auth.currentUser) {
            await auth.currentUser.delete();
            return true;
        }
        throw new Error("Not logged in");
    },

    onAuthStateChanged: (callback: (user: firebase.User | null) => void) => {
        if (isConfigured && auth) {
            return auth.onAuthStateChanged((user) => {
                callback(user);
            });
        }
        // Firebase not configured — immediately resolve as unauthenticated
        callback(null);
        return () => { };
    },

    getCurrentUser: () => {
        return auth?.currentUser || null;
    },

    verifyConnection: async () => {
        if (!isConfigured || !db) {
            // Strict Mode: Fail immediately if no DB
            throw new Error("❌ Database Disconnected. Please configure .env with valid Firebase credentials.");
        }
        try {
            await db.collection('users').limit(1).get();
            return true;
        } catch (e: any) {
            if (e.code === 'permission-denied') return true;
            console.error("Database connection verification failed:", e);
            throw e; // Bubble up
        }
    },

    // Beta access-code hash (config/sitePassword — hash+salt only, never the
    // plaintext). Public read-only doc; see PasswordGate.tsx for the client-side
    // verification flow this backs.
    getSitePasswordHash: async (): Promise<{ salt: string; hash: string } | null> => {
        if (!isConfigured || !db) return null;
        const snap = await db.collection('config').doc('sitePassword').get();
        const data = snap.data() as { salt?: string; hash?: string } | undefined;
        if (!data?.salt || !data?.hash) return null;
        return { salt: data.salt, hash: data.hash };
    },

    getUser: async (uid: string): Promise<AdminUser | null> => {
        if (isConfigured && db) {
            try {
                // Fetch caregivers + users in parallel to avoid sequential round-trips
                const [cgDoc, userDoc] = await Promise.all([
                    db.collection('caregivers').doc(uid).get(),
                    db.collection('users').doc(uid).get(),
                ]);

                if (cgDoc.exists && cgDoc.data()) {
                    return {
                        ...(userDoc.exists ? userDoc.data() : {}),
                        ...cgDoc.data(),
                        userType: 'caregiver',
                    } as AdminUser;
                }

                if (userDoc.exists) {
                    const data = userDoc.data();
                    if (data && data.uid) {
                        if (data.userType === 'client') {
                            const snDoc = await db.collection('senior_profiles').doc(uid).get();
                            if (snDoc.exists && snDoc.data()) {
                                return { ...data, ...snDoc.data(), userType: 'client' } as AdminUser;
                            }
                        }
                        return data as AdminUser;
                    }
                }

                // Fallback for legacy client profiles with no users doc
                const snDoc = await db.collection('senior_profiles').doc(uid).get();
                if (snDoc.exists && snDoc.data()) {
                    return { ...snDoc.data(), userType: 'client' } as AdminUser;
                }

            } catch (e: unknown) {
                console.error("Error fetching user role:", e);
                throw e;
            }
        } else {
            throw new Error("Database not connected");
        }
        return null;
    },

    getAllUsers: async (): Promise<AdminUser[]> => {
        if (isConfigured && db) {
            try {
                const snap = await db.collection('users').get();
                const users: AdminUser[] = [];
                snap.forEach(doc => users.push(doc.data() as AdminUser));
                return users;
            } catch (e: any) {
                if (e.code === 'permission-denied') return [];
                console.warn("Fetch Users Error:", e);
                return [];
            }
        }
        return [];
    },

    banUser: async (uid: string) => {
        // SECURITY FIX: Verify caller is admin before banning
        if (isConfigured && db && auth?.currentUser) {
            try {
                // Check if current user is admin
                const currentUserDoc = await db.collection('users').doc(auth.currentUser.uid).get();
                const currentUserData = currentUserDoc.data();
                if (!currentUserData || (currentUserData.userType !== 'admin' && !currentUserData.isAdmin)) {
                    throw new Error('Unauthorized: Admin access required');
                }

                await db.collection('users').doc(uid).update({ isBanned: true });
                
                // Audit log
                await errorHandler.logError(new Error('User banned'), {
                    action: 'ban_user',
                    component: 'dbService',
                    additionalData: { 
                        bannedUserId: uid,
                        bannedBy: auth.currentUser.uid,
                        timestamp: new Date().toISOString()
                    }
                });
                
                return true;
            } catch (e) {
                console.error("Ban User Error", e);
                throw e;
            }
        }
        throw new Error("Not authenticated or database not connected");
    },

    getCaregivers: async (limitSize: number = 10, lastDoc: firebase.firestore.QueryDocumentSnapshot | null = null): Promise<{ caregivers: Caregiver[], lastDoc: firebase.firestore.QueryDocumentSnapshot | null }> => {
        if (isConfigured && db) {
            try {
                let query = db.collection('publicCaregiverProfiles')
                    .where('onboardingStatus', '==', 'profile_complete')
                    .limit(limitSize);

                if (lastDoc) {
                    query = query.startAfter(lastDoc);
                }

                let querySnapshot = await query.get();
                
                let caregivers: Caregiver[] = [];
                querySnapshot.forEach((doc) => {
                    const data = doc.data();
                    if (data && data.name) {
                        caregivers.push({ id: doc.id, ...data } as Caregiver);
                    }
                });
                
                if (caregivers.length === 0) return { caregivers: [], lastDoc: null };

                return {
                    caregivers,
                    lastDoc: querySnapshot.docs[querySnapshot.docs.length - 1] || null
                };
            } catch (err: unknown) {
                if (isFirebaseError(err) && err.code === 'permission-denied') {
                    console.warn("Firestore permission denied for caregivers. Check rules.");
                    throw new Error('Access denied. Please check your account permissions.');
                }
                console.error("Firestore read failed", err);
                throw new Error('Failed to fetch caregivers. Please try again.');
            }
        }
        return { caregivers: [], lastDoc: null };
    },

    createJobPost: async (post: Partial<JobPost>, clientId: string) => {
        const allowedFields = [
            'title', 'description', 'rate', 'date', 'startTime', 'endTime',
            'location', 'requirements', 'seniorNeeds',
            'startDate', 'endDate', 'daysOfWeek', 'timeOfDay', 'minHoursPerWeek', 'jobFrequency',
            'recipientsCount', 'streetAddress', 'city', 'state', 'zipCode', 'neighborhood',
            'careTypes', 'careLevel', 'petsInHome', 'smokingHousehold',
            'paymentMethod', 'rateFlexible',
            'screeningQuestions',
        ];

        const sanitizedPost: any = {};
        for (const field of allowedFields) {
            const value = (post as any)[field];
            // Firestore rejects undefined values — skip them entirely
            if (value !== undefined) {
                sanitizedPost[field] = value;
            }
        }

        if (!sanitizedPost.title || !sanitizedPost.description) {
            throw new Error('Missing required fields: title, description');
        }
        if (!sanitizedPost.startDate && !sanitizedPost.date) {
            throw new Error('Missing required field: startDate');
        }

        // Mirror startDate → date so legacy consumers keep working
        if (sanitizedPost.startDate && !sanitizedPost.date) {
            sanitizedPost.date = sanitizedPost.startDate;
        }
        // Mirror careTypes → requirements so jobMatchService keyword extraction still works
        if (Array.isArray(sanitizedPost.careTypes) && !sanitizedPost.requirements) {
            sanitizedPost.requirements = sanitizedPost.careTypes;
        }
        // Derive a friendly location string when city/state/zip are present but no explicit location
        if (!sanitizedPost.location && sanitizedPost.city) {
            const parts = [sanitizedPost.city, sanitizedPost.state, sanitizedPost.zipCode].filter(Boolean);
            sanitizedPost.location = parts.join(', ');
        }

        // Geocode the job address once at creation — stored as lat/lng so caregivers
        // can do instant distance math without API calls at browse time.
        const addrQuery = [sanitizedPost.streetAddress, sanitizedPost.city, sanitizedPost.state, sanitizedPost.zipCode]
            .filter(Boolean).join(', ') || sanitizedPost.location || '';
        if (addrQuery) {
            try {
                const geoRes = await fetch(
                    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(addrQuery)}&format=json&limit=1&countrycodes=us`,
                    { headers: { 'Accept-Language': 'en', 'User-Agent': 'Evia/1.0' } }
                );
                const geoData = await geoRes.json();
                if (geoData?.length) {
                    sanitizedPost.lat = parseFloat(geoData[0].lat);
                    sanitizedPost.lng = parseFloat(geoData[0].lon);
                }
            } catch { /* best effort — job saves without coords if geocoding fails */ }
        }

        if (isConfigured && db) {
            const currentUser = auth?.currentUser;
            const clientName = currentUser?.displayName || 'Anonymous';

            const ref = await db.collection('job_posts').add({
                ...sanitizedPost,
                clientId,
                clientName,
                status: 'open',
                applicantCount: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
            return ref.id;
        }
        throw new Error("Database not configured");
    },

    getJobPostsByClient: async (clientId: string): Promise<JobPost[]> => {
        if (isConfigured && db) {
            try {
                const snap = await db.collection('job_posts')
                    .where('clientId', '==', clientId)
                    .get();
                const jobs: JobPost[] = [];
                snap.forEach(doc => jobs.push(normalizeJobPost({ id: doc.id, ...doc.data() })));
                jobs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
                return jobs;
            } catch (e: any) {
                if (e.code === 'permission-denied') return [];
                console.warn("getJobPostsByClient error:", e);
                return [];
            }
        }
        return [];
    },

    // Live variant of getJobPostsByClient (U6): agent-created/edited job posts
    // surface in the client UI without a manual refresh. Mirrors subscribeCareJournal.
    subscribeJobPostsByClient: (clientId: string, onUpdate: (posts: JobPost[]) => void, onError?: (e: any) => void): (() => void) => {
        if (!isConfigured || !db || !clientId) { onUpdate([]); return () => {}; }
        return db.collection('job_posts')
            .where('clientId', '==', clientId)
            .onSnapshot(
                snap => {
                    const jobs: JobPost[] = [];
                    snap.forEach(doc => jobs.push(normalizeJobPost({ id: doc.id, ...doc.data() })));
                    jobs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
                    onUpdate(jobs);
                },
                (e: any) => {
                    if (e?.code !== 'permission-denied') console.warn("subscribeJobPostsByClient error:", e);
                    if (onError) onError(e); else onUpdate([]);
                }
            );
    },

    // Family-facing "Evia Activity" feed (U9). Live, owner-scoped, newest first.
    // onError lets the UI distinguish a genuine failure from an empty feed.
    subscribeAgentActivity: (
        ownerUid: string,
        onUpdate: (items: AgentActivityItem[]) => void,
        onError?: (e: any) => void,
    ): (() => void) => {
        if (!isConfigured || !db || !ownerUid) { onUpdate([]); return () => {}; }
        return db.collection('user_activity_feed')
            .where('ownerUid', '==', ownerUid)
            .orderBy('timestamp', 'desc')
            .limit(50)
            .onSnapshot(
                snap => onUpdate(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as AgentActivityItem))),
                (e: any) => {
                    if (e?.code !== 'permission-denied') console.warn("subscribeAgentActivity error:", e);
                    if (onError) onError(e); else onUpdate([]);
                }
            );
    },

    // Caregiver-initiated swaps this caregiver is tracking (U7). Live, reads the
    // sanitized shift_swap_summaries projection (raw collections are server-only).
    subscribeShiftSwapsForCaregiver: (caregiverId: string, onUpdate: (swaps: PendingSwap[]) => void): (() => void) => {
        if (!isConfigured || !db || !caregiverId) { onUpdate([]); return () => {}; }
        return db.collection('shift_swap_summaries')
            .where('fromCaregiverId', '==', caregiverId)
            .onSnapshot(
                snap => onUpdate(snap.docs.map(mapSummaryDoc).filter(isActiveSwap)),
                (e: any) => {
                    if (e?.code !== 'permission-denied') console.warn("subscribeShiftSwapsForCaregiver error:", e);
                    onUpdate([]);
                }
            );
    },

    // Swaps affecting this client's appointments (U7). Both swap sources are
    // projected into shift_swap_summaries keyed by clientId, so a single
    // owner-scoped listener covers caregiver- and client-initiated swaps.
    subscribeShiftSwapsForClient: (clientId: string, onUpdate: (swaps: PendingSwap[]) => void): (() => void) => {
        if (!isConfigured || !db || !clientId) { onUpdate([]); return () => {}; }
        return db.collection('shift_swap_summaries')
            .where('clientId', '==', clientId)
            .onSnapshot(
                snap => onUpdate(snap.docs.map(mapSummaryDoc).filter(isActiveSwap)),
                (e: any) => {
                    if (e?.code !== 'permission-denied') console.warn("subscribeShiftSwapsForClient error:", e);
                    onUpdate([]);
                }
            );
    },

    cancelJobPost: async (jobId: string, clientId: string) => {
        if (!isConfigured || !db) throw new Error('Database not connected');
        const ref = db.collection('job_posts').doc(jobId);
        const doc = await ref.get();
        if (!doc.exists) throw new Error('Job not found');
        const data = doc.data();
        if (!data || data.clientId !== clientId) {
            throw new Error('Unauthorized: You can only cancel your own job posts');
        }
        await ref.update({
            status: 'cancelled',
            updatedAt: new Date().toISOString(),
        });
    },

    getOpenJobs: async (): Promise<JobPost[]> => {
        if (isConfigured && db) {
            try {
                const q = db.collection('job_posts').where('status', '==', 'open').orderBy('createdAt', 'desc');
                const snap = await q.get();

                const jobs: JobPost[] = [];
                snap.forEach(doc => jobs.push(normalizeJobPost({ id: doc.id, ...doc.data() })));
                return jobs;
            } catch (e: any) {
                if (e.code === 'permission-denied') return [];
                console.warn("Fetch Jobs Error:", e);
                return [];
            }
        }
        return [];
    },

    getMatches: async (seniorProfile: Senior, clientId?: string): Promise<Caregiver[]> => {
        // Import dynamically to avoid circular dependencies if any, though here it is fine.
        // In production, this call would be an HTTP request to a Cloud Function endpoint.
        // e.g., await axios.post('/api/getMatches', { seniorProfile });

        const { matchingEngine } = await import('./server/matchingEngine');
        const matches = await matchingEngine.findMatches(seniorProfile);

        return matches;
    },


    getAllJobs: async (): Promise<JobPost[]> => {
        if (isConfigured && db) {
            try {
                const snap = await db.collection('job_posts').orderBy('createdAt', 'desc').get();
                const jobs: JobPost[] = [];
                snap.forEach(doc => {
                    const data = doc.data();
                    if (data && (data.title || data.summary)) {
                        jobs.push(normalizeJobPost({ id: doc.id, ...data }));
                    }
                });
                return jobs;
            } catch (e: unknown) {
                console.error('Error fetching all jobs:', e);
                throw new Error('Failed to fetch jobs');
            }
        }
        return [];
    },

    deleteJobPost: async (jobId: string, clientId: string) => {
        if (isConfigured && db) {
            try {
                const doc = await db.collection('job_posts').doc(jobId).get();
                if (!doc.exists) throw new Error('Job not found');
                
                const data = doc.data();
                if (!data || data.clientId !== clientId) {
                    throw new Error('Unauthorized: You can only delete your own job posts');
                }
                
                await doc.ref.delete();
                
                // Audit log for HIPAA compliance
                await errorHandler.logError(new Error('Job deleted'), {
                    action: 'delete_job',
                    component: 'dbService',
                    additionalData: { 
                        jobId,
                        clientId: await validators.hashForLogging(clientId),
                        timestamp: new Date().toISOString()
                    }
                });
            } catch (error: unknown) {
                console.error('Delete Job Error', error);
                throw new Error('Failed to delete job post. Please try again.');
            }
        } else {
            throw new Error('Database not connected');
        }
    },

    acceptJob: async (jobId: string, caregiver: Caregiver) => {
        // SECURITY FIX: Wrap in transaction to prevent race conditions
        if (isConfigured && db) {
            const fdb = db;
            const DEFAULT_HOURS_PER_VISIT = 3; // Standard visit duration

            const jobRef = fdb.collection('job_posts').doc(jobId);
            
            try {
                const result = await fdb.runTransaction(async (transaction) => {
                    // Read job within transaction for atomicity
                    const jobDoc = await transaction.get(jobRef);
                    if (!jobDoc.exists) throw new Error("Job not found");
                    
                    const jobData = jobDoc.data();
                    if (!jobData) throw new Error("Job data is corrupted");
                    
                    // CRITICAL FIX: Check if job is already filled
                    if (jobData.status === 'filled') {
                        throw new Error("This job has already been accepted by another caregiver");
                    }
                    
                    if (jobData.status !== 'open') {
                        throw new Error("This job is no longer available");
                    }

                    // Create appointment atomically
                    const appointmentRef = fdb.collection('appointments').doc();
                    transaction.set(appointmentRef, {
                        caregiverId: caregiver.id,
                        caregiverName: caregiver.name,
                        clientName: jobData.clientName,
                        clientId: jobData.clientId,
                        date: jobData.date,
                        isoDate: jobData.date,
                        time: jobData.startTime,
                        duration: DEFAULT_HOURS_PER_VISIT,
                        status: 'confirmed',
                        paymentStatus: 'pending',
                        cost: jobData.rate * DEFAULT_HOURS_PER_VISIT,
                        createdAt: new Date().toISOString()
                    });

                    // Update job status atomically
                    transaction.update(jobRef, { status: 'filled', acceptedBy: caregiver.id, acceptedAt: new Date().toISOString() });
                    
                    return jobData;
                });

                return true;
            } catch (error: any) {
                console.error("Accept job failed:", error);
                // Return user-friendly error without exposing internal details
                if (error.message?.includes('already been accepted')) {
                    throw new Error('This job has already been accepted by another caregiver');
                } else if (error.message?.includes('no longer available')) {
                    throw new Error('This job is no longer available');
                } else {
                    throw new Error('Failed to accept job. Please try again.');
                }
            }
        }
        throw new Error("Database not connected");
    },

    createAppointment: async (appointmentData: Omit<Appointment, 'id' | 'createdAt' | 'status'>) => {
        // Rate limiting: Prevent booking spam
        const rateLimitKey = `booking_${appointmentData.clientId}_${appointmentData.caregiverId}`;
        const rateLimitResult = await checkRateLimit(rateLimitKey, {
            windowMs: 60 * 1000, // 1 minute
            maxRequests: 5,      // 5 bookings per minute
            keyPrefix: 'rl:booking:'
        });
        if (!rateLimitResult.allowed) {
            throw new Error(`Rate limit exceeded. Try again in ${Math.ceil((rateLimitResult.retryAfterMs || 60000) / 1000)} seconds.`);
        }

        if (isConfigured && db) {
            const fdb = db;
            // BUG FIX: Wrap transaction in try-catch for better error handling
            try {
                const appointment = await fdb.runTransaction(async (transaction) => {
                // Extract date and time for availability check
                const { caregiverId, date, time, clientId } = appointmentData;
                
                // CRITICAL FIX: Use atomic lock acquisition to prevent race conditions.
                // Two deterministic lock docs participate in the transaction's
                // consistency boundary: one keyed by the caregiver's slot (blocks two
                // clients grabbing the same caregiver+time) and one keyed by the
                // client's slot (blocks one client booking two caregivers at the same
                // time). Concurrent in-flight bookings are serialized by these
                // transactional reads+writes.
                const lockId = `${caregiverId}_${date}_${time}`;
                const lockRef = fdb.collection('appointment_locks').doc(lockId);
                const clientLockId = `client_${clientId}_${date}_${time}`;
                const clientLockRef = fdb.collection('appointment_locks').doc(clientLockId);

                // Firestore requires all transactional reads before any writes.
                const lockDoc = await transaction.get(lockRef);
                const clientLockDoc = await transaction.get(clientLockRef);

                const lockData = lockDoc.exists ? lockDoc.data() : null;
                if (lockData && lockData.expiresAt && new Date(lockData.expiresAt) > new Date()) {
                    throw new Error('This time slot is currently being booked by another user. Please try again in a moment or select a different time.');
                }
                const clientLockData = clientLockDoc.exists ? clientLockDoc.data() : null;
                if (clientLockData && clientLockData.expiresAt && new Date(clientLockData.expiresAt) > new Date()) {
                    throw new Error('You already have an appointment being booked at this time.');
                }

                const lockCreatedAt = new Date().toISOString();
                const lockExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
                transaction.set(lockRef, {
                    lockId,
                    caregiverId,
                    date,
                    time,
                    clientId,
                    createdAt: lockCreatedAt,
                    expiresAt: lockExpiresAt
                });
                transaction.set(clientLockRef, {
                    lockId: clientLockId,
                    caregiverId,
                    date,
                    time,
                    clientId,
                    createdAt: lockCreatedAt,
                    expiresAt: lockExpiresAt
                });

                // Secondary check for ALREADY-COMMITTED appointments (concurrent
                // in-flight bookings are handled by the locks above). These plain
                // queries are NOT part of the transaction.
                const existingApptsQuery = fdb.collection('appointments')
                    .where('caregiverId', '==', caregiverId)
                    .where('date', '==', date)
                    .where('time', '==', time)
                    .where('status', 'in', ['confirmed', 'in-progress'])
                    .limit(1);
                
                const existingApptsSnap = await existingApptsQuery.get();
                
                if (!existingApptsSnap.empty) {
                    throw new Error('This time slot is no longer available. Please select a different time.');
                }
                
                // Also check if client has a conflicting appointment
                const clientApptsQuery = fdb.collection('appointments')
                    .where('clientId', '==', clientId)
                    .where('date', '==', date)
                    .where('time', '==', time)
                    .where('status', 'in', ['confirmed', 'in-progress'])
                    .limit(1);
                
                const clientApptsSnap = await clientApptsQuery.get();
                
                if (!clientApptsSnap.empty) {
                    throw new Error('You already have an appointment scheduled at this time.');
                }
                
                // Create appointment atomically
                const docRef = fdb.collection('appointments').doc();
                const docId = docRef.id;

                // No-silent-booking contract: any booking that assigns a SPECIFIC
                // caregiver requires that caregiver's confirmation before it's
                // 'confirmed' — whether one-time or recurring. (Previously recurring
                // direct bookings auto-confirmed, silently assigning a caregiver who
                // never accepted.) Bookings with no assigned caregiver (job-board
                // posts) confirm through their own acceptance flow.
                const needsCaregiverConfirmation = !!appointmentData.caregiverId;
                const status = needsCaregiverConfirmation ? 'pending_caregiver_confirmation' : 'confirmed';

                const newAppt = {
                    ...appointmentData,
                    date: appointmentData.date || appointmentData.isoDate,
                    isoDate: appointmentData.isoDate || appointmentData.date,
                    time: appointmentData.time || appointmentData.startTime,
                    duration: appointmentData.duration || 1,
                    id: docId,
                    createdAt: new Date().toISOString(),
                    status
                };

                // Remove undefined fields - Firestore doesn't accept undefined values
                const cleanedAppt = Object.fromEntries(
                    Object.entries(newAppt).filter(([_, value]) => value !== undefined)
                );

                transaction.set(docRef, cleanedAppt);
                
                // Release both locks after successful booking
                transaction.delete(lockRef);
                transaction.delete(clientLockRef);
                
                // Clear rate limit on successful booking
                clearLocalRateLimit(`booking_${appointmentData.clientId}_${appointmentData.caregiverId}`);
                
                return cleanedAppt as unknown as Appointment;
            });

            // U3: the caregiver notification is owned by the onAppointmentCreated
            // server trigger. Browser peer-writes into another user's
            // notifications subcollection are denied by rules; removed.

            return appointment;
            } catch (error: any) {
                // BUG FIX: Provide specific error messages for common transaction failures
                console.error('[createAppointment] Transaction failed:', error);
                
                if (error.message?.includes('time slot is currently being booked')) {
                    throw new Error('This time slot is being booked by another user. Please try a different time.');
                } else if (error.message?.includes('no longer available')) {
                    throw new Error('This time slot is no longer available. Please select a different time.');
                } else if (error.message?.includes('already have an appointment')) {
                    throw new Error('You already have an appointment at this time.');
                } else if (error.code === 'permission-denied') {
                    throw new Error('Permission denied. Please sign in again.');
                } else if (error.code === 'unavailable') {
                    throw new Error('Service temporarily unavailable. Please try again.');
                } else {
                    // SECURITY FIX: Use safe error message to avoid leaking internal details
                    throw new Error('Booking failed. Please try again or contact support if the problem persists.');
                }
            }
        }
        throw new Error("Database not connected");
    },

    subscribeToAppointments: (
        userId: string,
        userType: 'client' | 'caregiver',
        onUpdate: (appts: Appointment[]) => void
    ) => {
        if (isConfigured && db) {
            // Filter by user type - clients see their bookings, caregivers see their assignments
            const field = userType === 'client' ? 'clientId' : 'caregiverId';

            console.log(`📡 Setting up appointment listener for ${userType}: ${userId}`);

            const unsubscribe = db.collection('appointments')
                .where(field, '==', userId)
                .onSnapshot((snapshot) => {
                    const appts: Appointment[] = [];
                    snapshot.forEach((doc) => {
                        // Include doc.id — the live listener feeds cancel/start/end
                        // actions and React keys that reference appointment.id.
                        // getAppointments() already spreads id; this path omitted it.
                        appts.push({ id: doc.id, ...doc.data() } as Appointment);
                    });
                    console.log(`📊 Received ${appts.length} appointments for ${userType} ${userId}`);
                    onUpdate(appts);
                }, (error) => {
                    if (error.code === 'permission-denied') {
                        console.warn('Permission denied for appointments. User may need to sign in again.');
                        return;
                    }
                    console.warn("Firestore Listener Error:", error.message);
                });
            return unsubscribe;
        }
        return () => { };
    },

    getAppointments: async (userId?: string, userType?: 'client' | 'caregiver'): Promise<{ appointments: Appointment[] }> => {
        if (isConfigured && db) {
            try {
                const currentUid = userId || auth?.currentUser?.uid;
                if (!currentUid) return { appointments: [] };
                const field = (userType || 'caregiver') === 'client' ? 'clientId' : 'caregiverId';
                const snap = await db.collection('appointments').where(field, '==', currentUid).get();
                const appointments: Appointment[] = [];
                snap.forEach(doc => appointments.push({ id: doc.id, ...doc.data() } as Appointment));
                return { appointments };
            } catch {
                return { appointments: [] };
            }
        }
        return { appointments: [] };
    },

    cancelAppointment: async (appointmentId: string, reason: string, cancelledBy: 'client' | 'caregiver') => {
        if (isConfigured && db) {
            // Fetch appointment to verify ownership
            const apptDoc = await db.collection('appointments').doc(appointmentId).get();
            if (!apptDoc.exists) throw new Error('Appointment not found');

            const data = apptDoc.data();
            if (data?.clientId !== auth?.currentUser?.uid && data?.caregiverId !== auth?.currentUser?.uid) {
                throw new Error('Unauthorized');
            }

            const updateData = {
                status: 'cancelled',
                cancellationReason: reason,
                cancelledBy: cancelledBy,
                cancelledAt: new Date().toISOString()
            };

            await db.collection('appointments').doc(appointmentId).update(updateData);

            // U3: the other-party cancellation notification is owned by the
            // onAppointmentCancelled server trigger (which reads the canonical
            // appointment to derive the recipient). Browser peer-write removed.

            return true;
        }
        throw new Error("Database not connected");
    },

    startVisit: async (appointmentId: string) => {
        const updateData = {
            status: 'in-progress',
        };

        if (isConfigured && db) {
            // Fetch appointment to verify ownership
            const apptDoc = await db.collection('appointments').doc(appointmentId).get();
            if (!apptDoc.exists) throw new Error('Appointment not found');

            const data = apptDoc.data();
            if (data?.clientId !== auth?.currentUser?.uid && data?.caregiverId !== auth?.currentUser?.uid) {
                throw new Error('Unauthorized');
            }

            await db.collection('appointments').doc(appointmentId).update(updateData);
        }
        return updateData;
    },

    endVisit: async (appointmentId: string) => {
        const updateData: any = {
            status: 'completed',
            paymentStatus: 'pending'
        };

        if (isConfigured && db) {
            // Fetch appointment to verify ownership
            const apptDoc = await db.collection('appointments').doc(appointmentId).get();
            if (!apptDoc.exists) throw new Error('Appointment not found');

            const data = apptDoc.data();
            if (data?.clientId !== auth?.currentUser?.uid && data?.caregiverId !== auth?.currentUser?.uid) {
                throw new Error('Unauthorized');
            }

            await db.collection('appointments').doc(appointmentId).update(updateData);
        }
        return updateData;
    },

    // Get pending booking requests for caregiver
    getPendingBookingRequests: async (caregiverId: string): Promise<Appointment[]> => {
        if (isConfigured && db) {
            try {
                const snapshot = await db.collection('appointments')
                    .where('caregiverId', '==', caregiverId)
                    .where('status', '==', 'pending_caregiver_confirmation')
                    .orderBy('createdAt', 'desc')
                    .get();
                
                return snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                } as Appointment));
            } catch (error) {
                console.error('Failed to get pending booking requests:', error);
                return [];
            }
        }
        return [];
    },

    // Update appointment (for accept/decline)
    updateAppointment: async (appointmentId: string, updates: Partial<Appointment>): Promise<boolean> => {
        if (isConfigured && db) {
            try {
                await db.collection('appointments').doc(appointmentId).update({
                    ...updates,
                    updatedAt: new Date().toISOString()
                });
                return true;
            } catch (error) {
                console.error('Failed to update appointment:', error);
                throw new Error('Failed to update appointment');
            }
        }
        return false;
    },

    // Batch-create multiple appointments for a recurring booking series
    createRecurringBookings: async (appointments: Array<Omit<Appointment, 'id' | 'createdAt'>>): Promise<void> => {
        if (!isConfigured || !db) throw new Error('Database not connected');
        if (appointments.length === 0) return;

        const batch = db.batch();
        const now = new Date().toISOString();
        appointments.forEach(appt => {
            const ref = db!.collection('appointments').doc();
            batch.set(ref, {
                ...appt,
                date: appt.date || appt.isoDate,
                isoDate: appt.isoDate || appt.date,
                time: appt.time || appt.startTime,
                duration: appt.duration || 1,
                id: ref.id,
                createdAt: now,
            });
        });
        await batch.commit();

        // The appointment onCreate trigger owns one leased summary per group
        // and party. Sending here as well races the batch triggers.
    },

    // Accept an entire recurring booking group (caregiver confirms all dates at once)
    confirmRecurringGroup: async (recurringGroupId: string, caregiverId: string, clientId: string, clientName: string, caregiverName: string): Promise<void> => {
        if (!isConfigured || !db) throw new Error('Database not connected');

        const snap = await db.collection('appointments')
            .where('recurringGroupId', '==', recurringGroupId)
            .where('caregiverId', '==', caregiverId)
            .get();

        if (snap.empty) return;

        const batch = db.batch();
        const now = new Date().toISOString();
        snap.docs.forEach(doc => {
            batch.update(doc.ref, { status: 'confirmed', caregiverConfirmedAt: now });
        });
        await batch.commit();

        // U3: the client "booking confirmed" notification is owned by the
        // onAppointmentUpdated server trigger, keyed by recurringGroupId so the
        // whole group produces exactly one notification. Browser peer-write
        // (rules-blocked) removed.
    },

    // Decline an entire recurring booking group
    declineRecurringGroup: async (recurringGroupId: string, caregiverId: string, clientId: string, caregiverName: string): Promise<void> => {
        if (!isConfigured || !db) throw new Error('Database not connected');

        const snap = await db.collection('appointments')
            .where('recurringGroupId', '==', recurringGroupId)
            .where('caregiverId', '==', caregiverId)
            .get();

        if (snap.empty) return;

        const batch = db.batch();
        const now = new Date().toISOString();
        snap.docs.forEach(doc => {
            batch.update(doc.ref, {
                status: 'cancelled',
                cancelledBy: 'caregiver',
                caregiverDeclinedAt: now,
                cancellationReason: 'Caregiver declined booking request',
            });
        });
        await batch.commit();

        // U3: the client "booking declined" notification is owned by the
        // onAppointmentCancelled server trigger (fires on cancelledBy:'caregiver').
        // Browser peer-write (rules-blocked) removed.
    },

    // Create notification
    createNotification: async (notification: {
        userId: string;
        type: string;
        title: string;
        message: string;
        data?: any;
    }): Promise<boolean> => {
        if (isConfigured && db) {
            try {
                await db.collection('users').doc(notification.userId).collection('notifications').add({
                    ...notification,
                    body: (notification as any).body ?? notification.message,
                    read: false,
                    isRead: false,
                    timestamp: new Date().toISOString(),
                    createdAt: new Date().toISOString()
                });
                return true;
            } catch (error) {
                console.error('Failed to create notification:', error);
                return false;
            }
        }
        return false;
    },

    updateUser: async (collectionName: string, uid: string, data: Partial<AdminUser | Caregiver | Senior>) => {
        // SECURITY FIX: Verify ownership or admin status before updating
        if (isConfigured && db && auth?.currentUser) {
            try {
                const currentUid = auth.currentUser.uid;
                
                // Check if current user is admin
                const currentUserDoc = await db.collection('users').doc(currentUid).get();
                const currentUserData = currentUserDoc.data();
                const isAdmin = currentUserData?.userType === 'admin' || currentUserData?.isAdmin === true;
                
                // Non-admins can only update their own profile
                if (!isAdmin && uid !== currentUid) {
                    throw new Error('Unauthorized: You can only update your own profile');
                }
                
                // Non-admins cannot modify sensitive fields
                if (!isAdmin) {
                    const sensitiveFields = ['isBanned', 'verified', 'verificationStatus', 'userType', 'isAdmin', 'stripeAccountId', 'totalEarnings'];
                    for (const field of sensitiveFields) {
                        if (field in data) {
                            delete (data as any)[field];
                        }
                    }
                }
                
                // FIX: Check for rejected verification status on caregivers
                if (collectionName === 'caregivers') {
                    const caregiverDoc = await db.collection('caregivers').doc(uid).get();
                    if (caregiverDoc.exists) {
                        const caregiverData = caregiverDoc.data() as Caregiver;
                        // Block updates if caregiver is rejected - must contact admin
                        if (caregiverData.verificationStatus === 'rejected') {
                            throw new Error('Account verification was rejected. Please contact support to resolve this issue.');
                        }
                    }
                }
                
                await db.collection(collectionName).doc(uid).set(data, { merge: true });
                
                // Audit log for sensitive updates
                if (isAdmin && uid !== currentUid) {
                    await errorHandler.logError(new Error('User updated by admin'), {
                        action: 'admin_update_user',
                        component: 'dbService',
                        additionalData: { 
                            targetUserId: uid,
                            collectionName,
                            updatedBy: currentUid,
                            timestamp: new Date().toISOString()
                        }
                    });
                }
                
                return true;
            } catch (e: any) {
                // A permission-denied error means the update did NOT happen —
                // surface it instead of masking the authorization failure as
                // success (which would leave the caller believing the write
                // applied).
                throw e;
            }
        }
        throw new Error("Not authenticated or database not connected");
    },

    getSystemStats: async () => {
        if (isConfigured && db) {
            try {
                const usersSnap = await db.collection('users').get();
                const caregiversSnap = await db.collection('caregivers').get();
                const apptsSnap = await db.collection('appointments').get();
                
                // Count clients (users with role='client' or userType='client')
                let clients = 0;
                usersSnap.forEach(doc => {
                    const data = doc.data();
                    if (data.role === 'client' || data.userType === 'client') {
                        clients++;
                    }
                });

                return {
                    users: usersSnap.size || 0,
                    clients: clients,
                    caregivers: caregiversSnap.size || 0,
                    appointments: apptsSnap.size || 0,
                    revenue: 0 // In real app, calculate from Stripe Balance
                };
            } catch (e) {
                return { users: 0, clients: 0, caregivers: 0, appointments: 0, revenue: 0 };
            }
        }
        return { users: 0, clients: 0, caregivers: 0, appointments: 0, revenue: 0 };
    },

    submitReview: async (review: Review) => {
        // Rate limit: Prevent duplicate review submission
        const cacheKey = `review_${review.clientId}_${review.caregiverId}_${review.appointmentId}`;
        return dedupePromise(cacheKey, async () => {
            if (isConfigured && db) {
                await db.collection('reviews').add(review);
                return true;
            }
            throw new Error("Database not connected");
        });
    },

    markAppointmentReviewed: async (appointmentId: string) => {
        if (isConfigured && db) {
            await db.collection('appointments').doc(appointmentId).update({ hasReview: true });
        }
    },

    subscribeToReviews: (caregiverId: string, onUpdate: (reviews: Review[]) => void) => {
        if (isConfigured && db) {
            const q = db.collection('reviews').where('caregiverId', '==', caregiverId);
            return q.onSnapshot((snapshot) => {
                const reviews: Review[] = [];
                snapshot.forEach(doc => reviews.push({ id: doc.id, ...doc.data() } as Review));
                onUpdate(reviews);
            }, (error) => {
                if (error.code === 'permission-denied') return;
            });
        }
        return () => { };
    },

    logFeedback: async (seniorId: string, caregiverId: string | number, action: 'hired' | 'rejected' | 'viewed', reason?: string) => {
        const feedback: MatchFeedback = {
            seniorId,
            caregiverId: String(caregiverId),
            action,
            reason: reason || '',
            timestamp: new Date().toISOString()
        };

        if (isConfigured && db) {
            try {
                await db.collection('match_feedback').add(feedback);
            } catch (e) {
                console.warn("Error logging match feedback", e);
            }
        }
    },

    getMatchFeedback: async (seniorId: string): Promise<MatchFeedback[]> => {
        if (isConfigured && db) {
            try {
                const q = db.collection('match_feedback').where('seniorId', '==', seniorId);
                const snapshot = await q.get();
                const feedback: MatchFeedback[] = [];
                snapshot.forEach(doc => feedback.push(doc.data() as MatchFeedback));
                return feedback;
            } catch (e: any) {
                if (e.code === 'permission-denied') return [];
                console.warn("Error fetching match feedback", e);
                return [];
            }
        }
        return [];
    },

    getSeniorProfile: async (uid: string): Promise<Senior | null> => {
        if (isConfigured && db) {
            try {
                // First try direct doc lookup (works for old 1:1 model where seniorId === clientUID)
                const docSnap = await db.collection('senior_profiles').doc(uid).get();
                if (docSnap.exists) {
                    return { id: 0, uid: docSnap.id, ...docSnap.data() } as unknown as Senior;
                }
                // Backward-compat fallback: query by clientId field (new multi-senior model)
                const querySnap = await db.collection('senior_profiles').where('clientId', '==', uid).limit(1).get();
                if (!querySnap.empty) {
                    const qDoc = querySnap.docs[0];
                    return { id: 0, uid: qDoc.id, ...qDoc.data() } as unknown as Senior;
                }
                // Last resort: read from user doc if no senior profile exists at all
                const userDoc = await db.collection('users').doc(uid).get();
                if (userDoc.exists) {
                    const userData = userDoc.data() as any;
                    return { id: 0, uid, name: userData.name, personality: 'Introvert', needs: [], location: '' } as unknown as Senior;
                }
                return null;
            } catch (e: any) {
                if (e.code === 'permission-denied') return null;
                console.warn("Error fetching senior profile", e);
                return null;
            }
        }
        return null;
    },

    /**
     * Creates a new senior_profiles doc with an auto-generated ID (multi-senior model).
     * Sets the clientId back-reference and registers the new seniorId on the user doc.
     * Returns the new senior doc ID.
     */
    createSeniorProfile: async (clientId: string, data: Partial<Senior>): Promise<string> => {
        if (!isConfigured || !db) throw new Error("Service not configured.");
        const newRef = db.collection('senior_profiles').doc();
        const newSeniorId = newRef.id;
        const batch = db.batch();
        batch.set(newRef, {
            ...data,
            clientId,
            personality: data.personality ?? 'Introvert',
            needs: data.needs ?? [],
            familyMembers: data.familyMembers ?? [],
            createdAt: new Date().toISOString(),
        });
        batch.update(db.collection('users').doc(clientId), {
            seniorIds: firebase.firestore.FieldValue.arrayUnion(newSeniorId),
        });
        await batch.commit();
        return newSeniorId;
    },

    /**
     * Lists all seniors in a client's household.
     * Queries senior_profiles where clientId == clientId (new model).
     * Falls back to the old 1:1 model (senior_profiles/{clientId}) for legacy accounts.
     */
    listHouseholdSeniors: async (clientId: string): Promise<Senior[]> => {
        if (!isConfigured || !db) return [];
        try {
            const querySnap = await db.collection('senior_profiles').where('clientId', '==', clientId).get();
            if (!querySnap.empty) {
                return querySnap.docs.map(d => ({ id: 0, uid: d.id, ...d.data() } as unknown as Senior));
            }
            // Old-model fallback: single senior whose doc ID === clientId
            const legacySnap = await db.collection('senior_profiles').doc(clientId).get();
            if (legacySnap.exists) {
                return [{ id: 0, uid: legacySnap.id, ...legacySnap.data() } as unknown as Senior];
            }
            return [];
        } catch (e: any) {
            if (e.code === 'permission-denied') return [];
            console.warn("Error listing household seniors", e);
            return [];
        }
    },

    subscribeToThreads: (userType: 'client' | 'caregiver', onUpdate: (threads: Thread[]) => void) => {
        if (isConfigured && db && auth?.currentUser) {
            const q = db.collection('threads').where('participants', 'array-contains', auth.currentUser.uid);

            return q.onSnapshot(async (snapshot) => {
                const threads: Thread[] = [];
                for (const docSnap of snapshot.docs) {
                    const data = docSnap.data();
                    threads.push({
                        id: docSnap.id,
                        ...data,
                        messages: []
                    } as unknown as Thread);
                }
                onUpdate(threads);
            }, (error) => {
                if (error.code === 'permission-denied') {
                    console.warn('Permission denied for threads. User may need to sign in again.');
                    onUpdate([]); // Return empty array so UI shows empty state instead of infinite loading
                    return;
                }
                console.error('Thread subscription error:', error);
                onUpdate([]); // Return empty array on any error
            });
        }
        return () => { };
    },

    subscribeToMessages: (threadId: string, onUpdate: (messages: DirectMessage[]) => void) => {
        if (isConfigured && db) {
            const q = db.collection('threads').doc(threadId).collection('messages').orderBy('createdAt', 'asc');
            return q.onSnapshot((snapshot) => {
                const msgs: DirectMessage[] = [];
                snapshot.forEach(doc => {
                    const data = doc.data();
                    msgs.push({
                        id: doc.id,
                        ...data,
                        timestamp: data.createdAt?.toDate ? data.createdAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Now'
                    } as DirectMessage);
                });
                onUpdate(msgs);
            }, (error) => {
                if (error.code === 'permission-denied') return;
            });
        }
        return () => { };
    },

    sendMessage: async (threadId: string, text: string, senderId: string) => {
        // Rate limit: Prevent message spam with 500ms debounce per thread
        const cacheKey = `msg_${threadId}_${senderId}`;
        return dedupePromise(cacheKey, async () => {
            if (isConfigured && db) {
                try {
                    // Sanitize message content before storage
                    const sanitizedText = sanitizeMessage(text);
                    
                    if (!sanitizedText.trim()) {
                        throw new Error('Message cannot be empty');
                    }

                    const threadRef = db.collection('threads').doc(threadId);
                    await threadRef.collection('messages').add({
                        text: sanitizedText,
                        senderId,
                        isRead: false,
                        createdAt: firebase.firestore.FieldValue.serverTimestamp()
                    });
                    await threadRef.update({
                        lastMessage: sanitizedText.substring(0, 100), // Truncate for preview
                        lastMessageTime: new Date().toLocaleTimeString(),
                        unreadCount: 1
                    });
                    return true;
                } catch (e: any) {
                    console.error("Message send failed", e);
                    throw e;
                }
            }
            throw new Error("Database not connected");
        });
    },

    createThread: async (otherUserId: string, otherUserName: string, otherUserAvatar?: string) => {
        // Rate limit: Prevent duplicate thread creation with deduplication
        const currentUid = auth?.currentUser?.uid;
        if (!currentUid) throw new Error("Not authenticated");
        
        // Default avatar if none provided
        const avatar = otherUserAvatar || DEFAULT_CAREGIVER_AVATAR;
        
        const cacheKey = `thread_${currentUid}_${otherUserId}`;
        return dedupePromise(cacheKey, async () => {
            if (isConfigured && db) {
                try {
                    const q = db.collection('threads').where('participants', 'array-contains', currentUid);
                    const snap = await q.get();
                    const existing = snap.docs.find(d => {
                        const p = d.data().participants as string[];
                        return p.includes(otherUserId);
                    });

                    if (existing) {
                        return existing.id;
                    }

                    const newThreadRef = db.collection('threads').doc();
                    await newThreadRef.set({
                        id: newThreadRef.id,
                        participants: [currentUid, otherUserId],
                        contactName: otherUserName,
                        contactAvatar: avatar,
                        lastMessage: 'Started conversation',
                        lastMessageTime: 'Just now',
                        unreadCount: 0
                    });
                    return newThreadRef.id;
                } catch (e: any) {
                    console.error("Create thread failed", e);
                    throw e;
                }
            }
            throw new Error("Database not connected");
        });
    },

    // ── Evia web chat (threads/cara_{uid} — the mirrored SMS/iMessage thread) ──
    // Messages are server-written only (firestore.rules); the web sends via the
    // v1-chatWithCara callable and renders whatever lands in the thread.

    caraThreadId: (): string | null =>
        auth?.currentUser ? `cara_${auth.currentUser.uid}` : null,

    subscribeToCaraThread: (onUpdate: (thread: { id: string; [key: string]: any } | null) => void) => {
        if (isConfigured && db && auth?.currentUser) {
            return db.collection('threads').doc(`cara_${auth.currentUser.uid}`).onSnapshot(
                (snap) => onUpdate(snap.exists ? { id: snap.id, ...snap.data() } : null),
                (error) => {
                    if (error.code !== 'permission-denied') console.error('Evia thread subscription error:', error);
                    onUpdate(null);
                }
            );
        }
        return () => { };
    },

    clearCaraThreadUnread: async () => {
        // The only client-side write firestore.rules allows on an Evia thread.
        if (isConfigured && db && auth?.currentUser) {
            await db.collection('threads').doc(`cara_${auth.currentUser.uid}`)
                .update({ unreadCount: 0 })
                .catch(() => { /* thread may not exist yet */ });
        }
    },

    sendCaraMessage: async (message: string, clientMessageId: string): Promise<{
        available: boolean;
        status?: 'ok' | 'rateLimited' | 'notSetUp' | 'finishSetup' | 'caraBusy' | 'smsFlowActive' | 'duplicate';
        reply?: string;
        rateLimited?: boolean;
        showMatches?: boolean;
        optedOut?: boolean;
        clientMessageId?: string;
    }> => {
        if (!functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-chatWithCara');
        const res = await fn({ message: sanitizeMessage(message), clientMessageId });
        return res.data;
    },

    // Canonical care-plan path (consolidation, 2026-07-12): the live plan is the
    // TOP-LEVEL doc care_plans/{clientUid} — the SAME doc Evia's get_care_plan /
    // update_care_plan SMS tools read and write, so medications/instructions sync
    // both ways. The old web path senior_profiles/{uid}/care_plans/default is
    // legacy: read once as a fallback until the backfill migration runs, never
    // written again. Evia may append plain-string entries (e.g. "Metformin 500mg")
    // to the arrays — normalizeCarePlan coerces them into the web item shapes and
    // preserves Evia-only fields (careNeeds, dietaryNotes, doctorContacts, …) so a
    // web save round-trips them untouched.
    getCarePlan: async (uid: string): Promise<CarePlan> => {
        if (isConfigured && db) {
            try {
                const doc = await db.collection('care_plans').doc(uid).get();
                if (doc.exists) return normalizeCarePlan(doc.data());
                const legacy = await db.collection('senior_profiles').doc(uid).collection('care_plans').doc('default').get();
                if (legacy.exists) return normalizeCarePlan(legacy.data());
                return { medications: [], emergencyContacts: [], dailyRoutine: [] };
            } catch (e) {
                return { medications: [], emergencyContacts: [], dailyRoutine: [] };
            }
        }
        return { medications: [], emergencyContacts: [], dailyRoutine: [] };
    },

    updateCarePlan: async (uid: string, plan: CarePlan) => {
        if (isConfigured && db) {
            try {
                await db.collection('care_plans').doc(uid).set({
                    ...plan,
                    lastUpdatedBy: 'web',
                    updatedAt: new Date().toISOString(),
                }, { merge: true });
            } catch (e: any) {
                if (e.code === 'permission-denied') return;
            }
        }
    },

    subscribeToCarePlan: (uid: string, onUpdate: (plan: CarePlan) => void) => {
        if (isConfigured && db) {
            const docRef = db.collection('care_plans').doc(uid);
            return docRef.onSnapshot((doc) => {
                if (doc.exists) {
                    onUpdate(normalizeCarePlan(doc.data()));
                } else {
                    // Pre-migration fallback: surface any data stranded on the
                    // legacy subdoc so nothing disappears before the backfill.
                    db!.collection('senior_profiles').doc(uid).collection('care_plans').doc('default').get()
                        .then(legacy => onUpdate(legacy.exists
                            ? normalizeCarePlan(legacy.data())
                            : { medications: [], emergencyContacts: [], dailyRoutine: [] }))
                        .catch(() => onUpdate({ medications: [], emergencyContacts: [], dailyRoutine: [] }));
                }
            }, (error) => {
                if (error.code === 'permission-denied') {
                    onUpdate({ medications: [], emergencyContacts: [], dailyRoutine: [] });
                }
            });
        }
        return () => { };
    },

    // Live caregiver-doc updates. Evia writes rate, payout status, verification,
    // and background-check fields to the caregivers doc; without this the web UI
    // shows stale values until a manual refresh (the "silent action" gap).
    subscribeCaregiverProfile: (caregiverId: string, onUpdate: (profile: Record<string, any> | null) => void) => {
        if (isConfigured && db) {
            return db.collection('publicCaregiverProfiles').doc(caregiverId).onSnapshot(doc => {
                onUpdate(doc.exists ? ({ id: doc.id, ...doc.data() }) : null);
            }, (error) => { if (error.code === 'permission-denied') return; });
        }
        return () => { };
    },

    // U2: Live listener for a caregiver's own profile doc (caregivers/{uid}).
    // Evia's agent writes to this doc during onboarding, profile edits, and
    // verification flips; without a listener the caregiver dashboard shows a
    // stale profile until logout/login. Mirrors subscribeToCarePlan.
    // Emits the raw caregiver doc data; the caller merges it over the cached
    // users-doc fields (caregiver doc wins, matching getUser's merge order).
    subscribeToCaregiverProfile: (uid: string, onUpdate: (caregiverData: Record<string, unknown> | null) => void) => {
        if (isConfigured && db) {
            const docRef = db.collection('caregivers').doc(uid);
            return docRef.onSnapshot((doc) => {
                onUpdate(doc.exists ? (doc.data() as Record<string, unknown>) : null);
            }, (error) => {
                // Best-effort surface: log for diagnosis, emit nothing (keep last-known), no toast.
                console.error('[subscribeToCaregiverProfile] snapshot error:', error?.code || error);
            });
        }
        return () => { };
    },

    // Fires whenever a caregiver enters or leaves the pending-verification states,
    // so the admin verification dashboard can re-pull its queue live when a Checkr
    // webhook or Evia/admin action changes a background-check / verification status.
    subscribeCaregiverVerificationChanges: (onChange: () => void) => {
        if (isConfigured && db) {
            return db.collection('caregivers')
                .where('verificationStatus', 'in', ['submitted', 'pending', 'info_requested', 'pre_adverse_action'])
                .onSnapshot(() => onChange(), () => { });
        }
        return () => { };
    },

    // U3: Live listener for a client's (primary) senior profile doc.
    // Evia writes care needs/preferences during intake; this keeps the
    // client's profile/intake view fresh without a reload. Mirrors getSeniorProfile
    // (doc keyed by the client uid). The senior_profiles read rule was amended
    // (KTD-10) so additional household seniors (userId-stamped) are also readable.
    subscribeToSeniorProfile: (uid: string, onUpdate: (data: Record<string, unknown> | null) => void) => {
        if (isConfigured && db) {
            const docRef = db.collection('senior_profiles').doc(uid);
            return docRef.onSnapshot((doc) => {
                onUpdate(doc.exists ? (doc.data() as Record<string, unknown>) : null);
            }, (error) => {
                console.error('[subscribeToSeniorProfile] snapshot error:', error?.code || error);
            });
        }
        return () => { };
    },

    // U3: Live listener for the user doc (users/{uid}). Surfaces agent-driven
    // changes to verification status, account state, and aggregated fields
    // live, beyond the one-shot getUser at auth time. users/{uid} read rule
    // already exists (firestore.rules:79) — no rule change needed.
    subscribeToUser: (uid: string, onUpdate: (data: Record<string, unknown> | null) => void) => {
        if (isConfigured && db) {
            const docRef = db.collection('users').doc(uid);
            return docRef.onSnapshot((doc) => {
                onUpdate(doc.exists ? (doc.data() as Record<string, unknown>) : null);
            }, (error) => {
                console.error('[subscribeToUser] snapshot error:', error?.code || error);
            });
        }
        return () => { };
    },

    toggleRoutineTask: async (uid: string, taskIndex: number, currentPlan: CarePlan) => {
        const updatedPlan = { ...currentPlan };
        if (updatedPlan.dailyRoutine[taskIndex]) {
            updatedPlan.dailyRoutine[taskIndex].isCompleted = !updatedPlan.dailyRoutine[taskIndex].isCompleted;
        }

        if (isConfigured && db) {
            try {
                await db.collection('care_plans').doc(uid).set({
                    dailyRoutine: updatedPlan.dailyRoutine
                }, { merge: true });
            } catch (e: any) {
                // Ignore permission error
            }
        }
        return updatedPlan;
    },

    createSupportTicket: async (ticket: Partial<SupportTicket>) => {
        // Rate limit: Prevent ticket spam (1 per user per 5 seconds)
        const cacheKey = `ticket_${ticket.userId}`;
        return dedupePromise(cacheKey, async () => {
            if (isConfigured && db) {
                await db.collection('support_tickets').add({
                    ...ticket,
                    status: 'open',
                    createdAt: new Date().toISOString()
                });
                return;
            }
            throw new Error("Database not connected");
        });
    },

    subscribeToTickets: (onUpdate: (tickets: SupportTicket[]) => void) => {
        if (isConfigured && db) {
            return db.collection('support_tickets').orderBy('createdAt', 'desc').onSnapshot(snap => {
                const tickets: SupportTicket[] = [];
                snap.forEach(doc => tickets.push({ id: doc.id, ...doc.data() } as SupportTicket));
                onUpdate(tickets);
            }, (error) => { if (error.code === 'permission-denied') return; });
        }
        return () => { };
    },

    subscribeToUserNotifications: (uid: string, onUpdate: (notifs: AppNotification[]) => void) => {
        if (isConfigured && db) {
            return db.collection('users').doc(uid).collection('notifications').orderBy('createdAt', 'desc').limit(20).onSnapshot(snap => {
                const notifs: AppNotification[] = [];
                snap.forEach(doc => {
                    const data = doc.data();
                    // Normalize read field — some docs use isRead, some use read
                    const isRead = data.isRead === true || data.read === true;
                    notifs.push({ id: doc.id, ...data, read: isRead, isRead } as unknown as AppNotification);
                });
                onUpdate(notifs);
            }, (error) => { if (error.code === 'permission-denied') return; });
        }
        return () => { };
    },

    markNotificationRead: async (uid: string, notifId: string) => {
        if (isConfigured && db) {
            await db.collection('users').doc(uid).collection('notifications').doc(notifId).update({ isRead: true, read: true });
        }
    },

    initiateBackgroundCheck: async (data: BackgroundCheckData) => {
        if (isConfigured && functions && auth?.currentUser) {
            try {
                const initiateFn = functions.httpsCallable('v1-initiateCheckrCandidate');
                await initiateFn(data);
                return true;
            } catch (error: any) {
                console.error("Background Check Error:", error);
                throw new Error('Background check initiation failed. Please try again or contact support.');
            }
        }
        throw new Error("Backend not connected");
    },

    triggerEmergencyAlert: async (initiatorId: string, type: 'client' | 'caregiver', location?: { lat: number, lng: number }) => {
        const alert: EmergencyAlert = {
            id: `alert_${Date.now()}`,
            initiatorId,
            initiatorType: type,
            timestamp: new Date().toISOString(),
            location,
            status: 'active',
            notifiedContacts: []
        };

        if (isConfigured && db) {
            await db.collection('emergency_alerts').add(alert);
        }
        return true;
    },

    // Live in-app surface for emergency_alerts. Both the EmergencySOS UI
    // (triggerEmergencyAlert above) and the agent's trigger_emergency_alert
    // MCP tool write this collection; without a listener the alert only
    // reaches users via push/SMS (server fan-out in
    // functions/src/familyEmergency.ts). Equality-only query - no composite
    // index needed; rules scope reads to the initiator.
    subscribeToEmergencyAlerts: (userId: string, onUpdate: (alerts: EmergencyAlert[]) => void): (() => void) => {
        if (!isConfigured || !db) { onUpdate([]); return () => {}; }
        return db.collection('emergency_alerts')
            .where('initiatorId', '==', userId)
            .where('status', '==', 'active')
            .onSnapshot(snap => {
                const alerts = snap.docs
                    .map(d => ({ ...(d.data() as EmergencyAlert), id: d.id }))
                    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
                onUpdate(alerts);
            }, (error) => { if (error.code === 'permission-denied') onUpdate([]); });
    },





    inviteFamilyMember: async (seniorId: string, email: string, phone?: string) => {
        const newMember: FamilyMember = {
            id: `fam_${Date.now()}`,
            name: email.split('@')[0],
            email,
            ...(phone && { phone }),
            role: 'viewer',
            status: 'pending'
        };

        if (isConfigured && db) {
            await db.collection('senior_profiles').doc(seniorId).update({
                familyMembers: firebase.firestore.FieldValue.arrayUnion(newMember)
            });
        }
        return newMember;
    },

    getFamilyMembers: async (seniorId: string): Promise<FamilyMember[]> => {
        if (isConfigured && db) {
            const doc = await db.collection('senior_profiles').doc(seniorId).get();
            if (doc.exists) {
                return (doc.data()?.familyMembers as FamilyMember[]) || [];
            }
        }
        return [];
    },

    // Live family roster. There are TWO sources of truth: the web invite flow
    // (inviteFamilyMember above) writes senior_profiles.familyMembers, while the
    // agent's add_family_member / remove_family_member MCP tools and the /join
    // page also maintain the family_group_members index. Listening to both and
    // merging (deduped by phone, then email) means agent-made changes show up
    // in FamilyManager without a refresh. Profile entries are listed first so
    // the richer web-invite record (email/role) wins on a phone collision.
    subscribeToFamilyMembers: (seniorId: string, onUpdate: (members: FamilyMember[]) => void): (() => void) => {
        if (!isConfigured || !db) { onUpdate([]); return () => {}; }

        let profileMembers: FamilyMember[] = [];
        let groupMembers: FamilyMember[] = [];
        const dedupeKey = (m: FamilyMember): string => {
            const phoneDigits = (m.phone || '').replace(/\D/g, '');
            if (phoneDigits) return `p:${phoneDigits}`;
            if (m.email) return `e:${m.email.toLowerCase()}`;
            return `i:${m.id}`;
        };
        const emit = () => {
            const seen = new Set<string>();
            const merged: FamilyMember[] = [];
            for (const m of [...profileMembers, ...groupMembers]) {
                const key = dedupeKey(m);
                if (seen.has(key)) continue;
                seen.add(key);
                merged.push(m);
            }
            onUpdate(merged);
        };

        const unsubProfile = db.collection('senior_profiles').doc(seniorId)
            .onSnapshot(doc => {
                profileMembers = (doc.exists ? (doc.data()?.familyMembers as FamilyMember[]) : []) || [];
                emit();
            }, (error) => { if (error.code === 'permission-denied') { profileMembers = []; emit(); } });

        const unsubGroup = db.collection('family_group_members')
            .where('userId', '==', seniorId)
            .onSnapshot(snap => {
                groupMembers = snap.docs.map(d => {
                    const data = d.data();
                    return {
                        id: d.id,
                        name: (data.memberName as string) || 'Family member',
                        email: '',
                        ...(data.memberPhone ? { phone: data.memberPhone as string } : {}),
                        role: 'viewer',
                        // joinedAt is stamped when the member first texts in
                        status: data.joinedAt ? 'active' : 'pending',
                    } as FamilyMember;
                });
                emit();
            }, (error) => { if (error.code === 'permission-denied') { groupMembers = []; emit(); } });

        return () => { unsubProfile(); unsubGroup(); };
    },

    // --- NOTIFICATION API ENDPOINTS ---
    sendNotification: async (userId: string, notification: Omit<AppNotification, 'id' | 'createdAt'>) => {
        if (isConfigured && db) {
            await db.collection('notifications').add({
                ...notification,
                userId,
                createdAt: new Date().toISOString()
            });
            return true;
        }
        throw new Error("Database not connected");
    },

    getNotifications: async (userId: string, limitCount: number = 50): Promise<AppNotification[]> => {
        if (isConfigured && db) {
            try {
                const snap = await db.collection('notifications')
                    .where('userId', '==', userId)
                    .orderBy('createdAt', 'desc')
                    .limit(limitCount)
                    .get();
                const notifications: AppNotification[] = [];
                snap.forEach(doc => notifications.push({ id: doc.id, ...doc.data() } as AppNotification));
                return notifications;
            } catch (e: any) {
                if (e.code === 'permission-denied') return [];
                console.warn("Fetch notifications error:", e);
                return [];
            }
        }
        return [];
    },

    // --- APPOINTMENT CARE PLAN LINK API ---
    linkCarePlanToAppointment: async (
        appointmentId: string,
        carePlanData: {
            clientId: string;
            caregiverId: string;
            carePlanSnapshot: CarePlan;
            specialInstructions?: string;
        }
    ) => {
        if (isConfigured && db) {
            const docRef = await db.collection('appointment_care_plans').add({
                appointmentId,
                ...carePlanData,
                tasksCompleted: [],
                createdAt: new Date().toISOString()
            });
            
            // Update appointment with reference
            await db.collection('appointments').doc(appointmentId).update({
                hasCarePlan: true,
                carePlanId: docRef.id
            });
            
            return docRef.id;
        }
        throw new Error("Database not connected");
    },

    getAppointmentCarePlan: async (appointmentId: string) => {
        if (isConfigured && db) {
            const snap = await db.collection('appointment_care_plans')
                .where('appointmentId', '==', appointmentId)
                .limit(1)
                .get();
            if (!snap.empty) {
                return { id: snap.docs[0].id, ...snap.docs[0].data() };
            }
            return null;
        }
        return null;
    },

    // --- JOB APPLICATION API ---
    applyToJob: async (jobId: string, caregiverId: string, applicationData: {
        caregiverName: string;
        caregiverPhoto?: string;
        coverLetter?: string;
        proposedRate?: number;
    }) => {
        // Rate limit: Prevent duplicate application submission
        const cacheKey = `apply_${jobId}_${caregiverId}`;
        return dedupePromise(cacheKey, async () => {
            if (isConfigured && db) {
                // Get job details first
                const jobDoc = await db.collection('job_posts').doc(jobId).get();
                if (!jobDoc.exists) throw new Error("Job not found");
                const jobData = jobDoc.data() as JobPost;

                // Check for existing application
                const existingQuery = await db.collection('job_applications')
                    .where('jobId', '==', jobId)
                    .where('caregiverId', '==', caregiverId)
                    .limit(1)
                    .get();
                
                if (!existingQuery.empty) {
                    throw new Error("You have already applied to this job");
                }

                // Create application
                await db.collection('job_applications').add({
                    jobId,
                    jobTitle: jobData.title,
                    caregiverId,
                    clientId: jobData.clientId,
                    clientName: jobData.clientName,
                    status: 'pending',
                    appliedAt: new Date().toISOString(),
                    ...applicationData
                });

                // U3: the client "new application" notification is owned by the
                // onJobApplicationCreate server trigger (fires on this
                // job_applications write). Browser peer-write removed.

                return true;
            }
            throw new Error("Database not connected");
        });
    },

    getMyApplications: async (caregiverId: string) => {
        if (isConfigured && db) {
            try {
                const snap = await db.collection('job_applications')
                    .where('caregiverId', '==', caregiverId)
                    .orderBy('appliedAt', 'desc')
                    .get();
                const applications: any[] = [];
                snap.forEach(doc => applications.push({ id: doc.id, ...doc.data() }));
                return applications;
            } catch (e: any) {
                if (e.code === 'permission-denied') return [];
                return [];
            }
        }
        return [];
    },

    getJobApplications: async (clientId: string) => {
        if (isConfigured && db) {
            try {
                const snap = await db.collection('job_applications')
                    .where('clientId', '==', clientId)
                    .orderBy('appliedAt', 'desc')
                    .get();
                const applications: any[] = [];
                snap.forEach(doc => applications.push({ id: doc.id, ...doc.data() }));
                return applications;
            } catch (e: any) {
                if (e.code === 'permission-denied') return [];
                return [];
            }
        }
        return [];
    },

    updateApplicationStatus: async (applicationId: string, status: string) => {
        if (isConfigured && db) {
            await db.collection('job_applications').doc(applicationId).update({
                status,
                updatedAt: new Date().toISOString()
            });
            return true;
        }
        throw new Error("Database not connected");
    },

    // --- REVIEW API ---
    getReviewsForCaregiver: async (caregiverId: string): Promise<Review[]> => {
        if (isConfigured && db) {
            try {
                const snap = await db.collection('reviews')
                    .where('caregiverId', '==', caregiverId)
                    .orderBy('createdAt', 'desc')
                    .get();
                const reviews: Review[] = [];
                snap.forEach(doc => reviews.push({ id: doc.id, ...doc.data() } as Review));
                return reviews;
            } catch (e: any) {
                if (e.code === 'permission-denied') return [];
                return [];
            }
        }
        return [];
    },

    getReviewById: async (reviewId: string): Promise<Review | null> => {
        if (isConfigured && db) {
            const doc = await db.collection('reviews').doc(reviewId).get();
            if (doc.exists) return { id: doc.id, ...doc.data() } as Review;
            return null;
        }
        return null;
    },

    // --- TICKET MANAGEMENT API ---
    getSupportTickets: async (filters?: { status?: string; priority?: string }): Promise<SupportTicket[]> => {
        if (isConfigured && db) {
            try {
                let query: any = db.collection('support_tickets').orderBy('createdAt', 'desc');
                if (filters?.status) {
                    query = query.where('status', '==', filters.status);
                }
                const snap = await query.get();
                const tickets: SupportTicket[] = [];
                snap.forEach((doc: any) => tickets.push({ id: doc.id, ...doc.data() } as SupportTicket));
                return tickets;
            } catch (e: any) {
                if (e.code === 'permission-denied') return [];
                return [];
            }
        }
        return [];
    },

    updateTicketStatus: async (ticketId: string, status: string, assignedTo?: string) => {
        if (isConfigured && db) {
            const updateData: { status: string; updatedAt: string; assignedTo?: string } = { status, updatedAt: new Date().toISOString() };
            if (assignedTo) updateData.assignedTo = assignedTo;
            await db.collection('support_tickets').doc(ticketId).update(updateData);
            return true;
        }
        throw new Error("Database not connected");
    },

    addTicketResponse: async (ticketId: string, response: {
        message: string;
        isAdmin: boolean;
        adminName?: string;
    }) => {
        if (isConfigured && db) {
            await db.collection('support_tickets').doc(ticketId).collection('responses').add({
                ...response,
                createdAt: new Date().toISOString()
            });
            
            // Update ticket status if it was open
            await db.collection('support_tickets').doc(ticketId).update({
                status: 'in-progress',
                updatedAt: new Date().toISOString()
            });
            
            return true;
        }
        throw new Error("Database not connected");
    },

    // --- SYSTEM STATS API ---
    getDashboardStats: async () => {
        if (isConfigured && db) {
            try {
                const [users, caregivers, appointments, jobs, tickets] = await Promise.all([
                    db.collection('users').get(),
                    db.collection('caregivers').get(),
                    db.collection('appointments').get(),
                    db.collection('job_posts').get(),
                    db.collection('support_tickets').where('status', 'in', ['open', 'in-progress']).get()
                ]);

                // Calculate revenue from completed appointments
                const completedAppts = await db.collection('appointments')
                    .where('status', '==', 'completed')
                    .get();
                
                let totalRevenue = 0;
                completedAppts.forEach((doc: firebase.firestore.QueryDocumentSnapshot) => {
                    totalRevenue += doc.data().cost || 0;
                });

                return {
                    users: users.size,
                    caregivers: caregivers.size,
                    appointments: appointments.size,
                    openJobs: jobs.size,
                    pendingTickets: tickets.size,
                    revenue: totalRevenue
                };
            } catch (e) {
                return { users: 0, caregivers: 0, appointments: 0, openJobs: 0, pendingTickets: 0, revenue: 0 };
            }
        }
        return { users: 0, caregivers: 0, appointments: 0, openJobs: 0, pendingTickets: 0, revenue: 0 };
    },

    /**
     * Subscribe to care journal entries for real-time updates.
     * Entries are written server-side (Evia's journal tools + caregiver flows)
     * into `care_journal`; rules allow the owning client, the caregiver, and
     * admins to read. Single-field query + client-side sort — no composite
     * index needed.
     */
    subscribeCareJournal: (clientId: string, onUpdate: (entries: any[]) => void) => {
        if (isConfigured && db && clientId) {
            const q = db.collection('care_journal')
                .where('clientId', '==', clientId)
                .limit(50);
            return q.onSnapshot(snapshot => {
                const entries = snapshot.docs
                    .map(doc => ({ id: doc.id, ...doc.data() } as any))
                    .sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')));
                onUpdate(entries);
            }, (error: any) => {
                if (error.code === 'permission-denied') {
                    onUpdate([]);
                    return;
                }
                console.error('Care journal subscription error:', error);
                onUpdate([]);
            });
        }
        return () => { };
    },

    notifyFamilyOfArrival: async (seniorId: string, caregiverId: string, appointmentTime: string) => {
        // Get senior's profile
        const seniorDoc = await db?.collection('senior_profiles').doc(seniorId).get();
        if (!seniorDoc?.exists) return;

        const seniorData = seniorDoc.data() as { 
            name?: string; 
            familyMembers?: { email: string; name: string; phone?: string; userId?: string }[] 
        };
        const seniorName = seniorData?.name || 'Your Loved One';
        const familyMembers = seniorData?.familyMembers || [];

        if (familyMembers.length === 0) return;

        // Get caregiver info
        const caregiverDoc = await db?.collection('publicCaregiverProfiles').doc(caregiverId).get();
        const caregiverName = caregiverDoc?.exists 
            ? (caregiverDoc.data() as { name?: string })?.name || 'Caregiver'
            : 'Caregiver';

        // Send arrival notifications
        await notifyFamilyOfArrival(familyMembers, seniorName, caregiverName, appointmentTime);
    },

    sendWeeklyDigest: async (_seniorId: string, _email: string) => {
        // Care journal removed — weekly digest no longer supported
    },

    /**
     * Get caregivers for the admin verification dashboard.
     *
     * Supported `status` values:
     *  - 'exceptions': the manual-review queue — docs awaiting review
     *    (submitted/pending/info_requested/pre_adverse_action) PLUS any caregiver
     *    whose background check sits in an exception state (UNBOOKABLE_BG_STATUSES).
     *    Two queries merged client-side (Firestore has no OR across fields).
     *  - 'pending': awaiting Checkr / docs review (submitted | pending | info_requested)
     *  - 'approved': includes legacy 'checkr_clear' docs written before the
     *    Checkr webhook auto-approved clear results.
     *  - 'all': everything
     *  - anything else: exact verificationStatus equality (legacy callers pass 'submitted')
     *
     * No server-side orderBy: 'in'/equality + orderBy(submittedAt) would require
     * composite indexes that don't exist (and orderBy drops docs missing the
     * field). Results are sorted newest-first client-side instead.
     */
    getCaregiversForVerification: async (status: string = 'submitted') => {
        if (!isConfigured || !db) {
            return [];
        }

        const mapDocs = (snap: firebase.firestore.QuerySnapshot) =>
            snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Record<string, any>));
        const sortNewest = (rows: Record<string, any>[]) =>
            rows.sort((a, b) =>
                String(b.submittedAt ?? b.backgroundCheckData?.submittedAt ?? b.createdAt ?? '')
                    .localeCompare(String(a.submittedAt ?? a.backgroundCheckData?.submittedAt ?? a.createdAt ?? ''))
            );

        try {
            const col = db.collection('caregivers');

            if (status === 'all') {
                return sortNewest(mapDocs(await col.limit(200).get()));
            }

            if (status === 'exceptions') {
                const [reviewSnap, bgSnap] = await Promise.all([
                    col.where('verificationStatus', 'in',
                        ['submitted', 'pending', 'info_requested', 'pre_adverse_action'])
                        .limit(100).get(),
                    col.where('backgroundCheckData.status', 'in', [...UNBOOKABLE_BG_STATUSES])
                        .limit(100).get(),
                ]);
                const byId = new Map<string, Record<string, any>>();
                for (const doc of [...reviewSnap.docs, ...bgSnap.docs]) {
                    byId.set(doc.id, { id: doc.id, ...doc.data() });
                }
                return sortNewest([...byId.values()]);
            }

            if (status === 'pending') {
                const snap = await col
                    .where('verificationStatus', 'in', ['submitted', 'pending', 'info_requested'])
                    .limit(100).get();
                return sortNewest(mapDocs(snap));
            }

            if (status === 'approved') {
                const snap = await col
                    .where('verificationStatus', 'in', ['approved', 'checkr_clear'])
                    .limit(100).get();
                return sortNewest(mapDocs(snap));
            }

            const snap = await col
                .where('verificationStatus', '==', status)
                .limit(100).get();
            return sortNewest(mapDocs(snap));
        } catch (error) {
            console.error('Failed to fetch caregivers for verification:', error);
            return [];
        }
    },

    // ==================== PROACTIVE REFLECTION DRAFTS ====================

    /**
     * Subscribe to proactive_drafts filtered by status, ordered newest-first.
     * Returns the unsubscribe function. Empty status array = "all statuses".
     */
    subscribeProactiveDrafts: (
        statuses: string[],
        cb: (drafts: Array<Record<string, any>>) => void
    ): (() => void) => {
        if (!isConfigured || !db) {
            cb([]);
            return () => {};
        }
        let q: firebase.firestore.Query = db.collection('proactive_drafts');
        if (statuses.length === 1) {
            q = q.where('status', '==', statuses[0]);
        } else if (statuses.length > 1) {
            // Firestore 'in' supports up to 30 values — well above our 6-status union.
            q = q.where('status', 'in', statuses);
        }
        return q.orderBy('createdAt', 'desc')
            .limit(200)
            .onSnapshot(
                (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
                (err) => {
                    console.error('subscribeProactiveDrafts:', err);
                    cb([]);
                }
            );
    },

    /**
     * Approve via the audited v1-reviewProactiveDraft callable (U8/AE23). The
     * server verifies live admin role, transitions transactionally, and stamps
     * the immutable reviewed-content hash the sender re-verifies at send time.
     * Inline edits ride along as `editedText` so the hash covers the FINAL
     * text (server enforces 1-320 chars). The optional review note is metadata
     * only — written after the decision, never part of the hashed content.
     */
    approveProactiveDraft: async (
        draftId: string,
        _adminUid: string,
        reviewNote?: string,
        editedText?: string
    ): Promise<void> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-reviewProactiveDraft');
        const payload: Record<string, any> = { draftId, decision: 'approve' };
        if (editedText !== undefined && editedText.trim()) payload.editedText = editedText.trim();
        await fn(payload);
        if (reviewNote && reviewNote.trim() && db) {
            await db.collection('proactive_drafts').doc(draftId)
                .update({ approvalNote: reviewNote.trim() })
                .catch((err) => console.warn('approvalNote write failed (non-fatal):', err));
        }
    },

    /** Reject via the audited callable; the reason is metadata written after. */
    rejectProactiveDraft: async (
        draftId: string,
        _adminUid: string,
        reason: string
    ): Promise<void> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        if (!reason || !reason.trim()) throw new Error('Rejection requires a reason');
        const fn = functions.httpsCallable('v1-reviewProactiveDraft');
        await fn({ draftId, decision: 'reject' });
        if (db) {
            await db.collection('proactive_drafts').doc(draftId)
                .update({ rejectionReason: reason.trim() })
                .catch((err) => console.warn('rejectionReason write failed (non-fatal):', err));
        }
    },

    /**
     * Calls the sendApprovedDraftNow callable Cloud Function. Server validates
     * admin auth + draft state and dispatches via the same path the scheduled
     * sender uses, so behavior matches whether sent now or by the cron.
     */
    sendApprovedDraftNow: async (draftId: string): Promise<{ success: boolean; error?: string }> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-sendApprovedDraftNow');
        const result = await fn({ draftId });
        return (result.data as { success: boolean; error?: string }) ?? { success: false, error: 'no response' };
    },

    // ==================== ADMIN ALERTS ====================

    /**
     * Subscribe to admin_alerts, newest first (single-field orderBy → automatic
     * index, no composite required). Unresolved/resolved filtering happens
     * client-side so one listener powers both the panel and the sidebar badge.
     *
     * NOTE: firestore.rules has no /admin_alerts match block yet, so client
     * reads are denied by default until an `allow read, update: if isAdmin();`
     * rule is added. The `v1-listAdminAlerts` / `v1-resolveAdminAlert` callables
     * (functions/src/adminAlerts.ts) are the rules-bypassing alternative.
     */
    subscribeAdminAlerts: (
        cb: (alerts: Array<Record<string, any>>) => void,
        onError?: (err: Error) => void
    ): (() => void) => {
        if (!isConfigured || !db) {
            cb([]);
            return () => {};
        }
        return db.collection('admin_alerts')
            .orderBy('createdAt', 'desc')
            .limit(200)
            .onSnapshot(
                (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
                (err) => {
                    console.error('subscribeAdminAlerts:', err);
                    onError?.(err as unknown as Error);
                    cb([]);
                }
            );
    },

    resolveAdminAlert: async (alertId: string, resolvedBy?: string): Promise<void> => {
        if (!isConfigured || !db) throw new Error('Not connected');
        // Attribute to the signed-in operator (matches assignAgentAction et al.)
        // unless an explicit actor is passed.
        const resolver = resolvedBy || auth?.currentUser?.uid;
        await db.collection('admin_alerts').doc(alertId).update({
            resolved: true,
            resolvedAt: new Date().toISOString(),
            ...(resolver ? { resolvedBy: resolver } : {}),
        });
    },

    // ==================== ADMIN EXECUTION CALLABLES (U3) ====================
    // Admin-gated backend callables that make Control Room / verification /
    // ticket / dispute / ledger exception handling executable (not note-only).
    // Auth + admin-role is enforced server-side by requireAdmin.

    adminReviewCaregiverException: async (
        caregiverId: string,
        decision: 'approve' | 'reject' | 'request_info',
        note?: string
    ): Promise<{ success: boolean; bookable: boolean; verificationStatus: string }> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-admin_review_caregiver_exception');
        const result = await fn({ caregiverId, decision, note });
        return result.data as any;
    },

    adminReviewDocument: async (
        caregiverId: string,
        documentType: string,
        decision: 'approve' | 'reject',
        note?: string
    ): Promise<{ success: boolean; status: string }> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-admin_review_document');
        const result = await fn({ caregiverId, documentType, decision, note });
        return result.data as any;
    },

    adminSuspendUser: async (userId: string, reason: string): Promise<{ success: boolean }> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-admin_suspend_user');
        const result = await fn({ userId, reason });
        return result.data as any;
    },

    adminRestoreUser: async (userId: string, note?: string): Promise<{ success: boolean }> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-admin_restore_user');
        const result = await fn({ userId, note });
        return result.data as any;
    },

    adminRespondSupportTicket: async (
        ticketId: string,
        message: string,
        resolve?: boolean
    ): Promise<{ success: boolean; status: string }> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-admin_respond_support_ticket');
        const result = await fn({ ticketId, message, resolve: !!resolve });
        return result.data as any;
    },

    adminResolveDispute: async (
        appointmentId: string,
        outcome: 'approve' | 'reject',
        opts?: { finalTotalHours?: number; note?: string }
    ): Promise<{ success: boolean }> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-admin_resolve_dispute');
        const result = await fn({ appointmentId, outcome, ...opts });
        return result.data as any;
    },

    adminReviewInvoiceException: async (
        alertId: string,
        resolution: 'resolved' | 'writeoff' | 'retry_scheduled',
        note?: string
    ): Promise<{ success: boolean }> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-admin_review_invoice_exception');
        const result = await fn({ alertId, resolution, note });
        return result.data as any;
    },

    adminRetryAgentAction: async (
        ledgerId: string,
        idempotencyKey: string,
        opts?: { replayToolName?: string; replayInput?: Record<string, unknown> }
    ): Promise<{ success: boolean; error?: string }> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-admin_retry_agent_action');
        const result = await fn({ ledgerId, idempotencyKey, ...opts });
        return result.data as any;
    },

    // ==================== CONTROL ROOM RECOVERY CALLABLES (U4) ====================
    // Backend-executable recovery: each is admin-gated by requireAdmin, writes an
    // audit record, transitions ledger/pending/alert state, is idempotency-keyed,
    // and fails visibly (never false success). High-risk replays require confirm.

    adminRetryLinqDelivery: async (
        idempotencyKey: string,
        opts: { ledgerId?: string; chatId?: string; phone?: string; text?: string }
    ): Promise<{ success: boolean; error?: string }> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-admin_retry_linq_delivery');
        const result = await fn({ idempotencyKey, ...opts });
        return result.data as any;
    },

    adminReplayPendingAction: async (
        pendingActionId: string,
        idempotencyKey: string,
        confirm: boolean
    ): Promise<{ success: boolean; error?: string }> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-admin_replay_pending_action');
        const result = await fn({ pendingActionId, idempotencyKey, confirm });
        return result.data as any;
    },

    adminCancelPendingAction: async (
        pendingActionId: string,
        reason: string
    ): Promise<{ success: boolean; executed: boolean }> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-admin_cancel_pending_action');
        const result = await fn({ pendingActionId, reason });
        return result.data as any;
    },

    adminAssignRecoveryOwner: async (
        target: { ledgerId?: string; alertId?: string },
        owner: { ownerUid?: string; ownerLabel?: string }
    ): Promise<{ success: boolean }> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-admin_assign_recovery_owner');
        const result = await fn({ ...target, ...owner });
        return result.data as any;
    },

    adminMarkRecoveryComplete: async (
        target: { ledgerId?: string; alertId?: string },
        reason: string
    ): Promise<{ success: boolean }> => {
        if (!isConfigured || !functions) throw new Error('Not connected');
        const fn = functions.httpsCallable('v1-admin_mark_recovery_complete');
        const result = await fn({ ...target, reason });
        return result.data as any;
    },

    assignAgentAction: async (entryId: string, adminUid?: string): Promise<void> => {
        if (!isConfigured || !db) throw new Error('Not connected');
        const uid = adminUid || auth?.currentUser?.uid;
        if (!uid) throw new Error('Admin user is required');
        await db.collection('agent_action_ledger').doc(entryId).update({
            assignedTo: uid,
            assignedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
    },

    requestAgentActionRetry: async (entryId: string, reason: string, adminUid?: string): Promise<void> => {
        if (!isConfigured || !db) throw new Error('Not connected');
        const uid = adminUid || auth?.currentUser?.uid;
        if (!uid) throw new Error('Admin user is required');
        const cleanReason = reason.trim();
        if (!cleanReason) throw new Error('Retry reason is required');
        await db.collection('agent_action_ledger').doc(entryId).update({
            recoveryAction: 'retry_requested',
            operatorNotes: cleanReason.slice(0, 1000),
            retryCount: firebase.firestore.FieldValue.increment(1),
            lastRetryAt: new Date().toISOString(),
            assignedTo: uid,
            assignedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
    },

    markAgentActionHandled: async (entryId: string, handledReason: string, adminUid?: string): Promise<void> => {
        if (!isConfigured || !db) throw new Error('Not connected');
        const uid = adminUid || auth?.currentUser?.uid;
        if (!uid) throw new Error('Admin user is required');
        const cleanReason = handledReason.trim();
        if (!cleanReason) throw new Error('Handled reason is required');
        await db.collection('agent_action_ledger').doc(entryId).update({
            status: 'cancelled',
            handledBy: uid,
            handledAt: new Date().toISOString(),
            handledReason: cleanReason.slice(0, 1000),
            updatedAt: new Date().toISOString(),
        });
    },

    cancelPendingAction: async (actionId: string, reason: string, adminUid?: string): Promise<void> => {
        if (!isConfigured || !db) throw new Error('Not connected');
        const uid = adminUid || auth?.currentUser?.uid;
        if (!uid) throw new Error('Admin user is required');
        const cleanReason = reason.trim();
        if (!cleanReason) throw new Error('Cancel reason is required');
        await db.collection('pending_actions').doc(actionId).update({
            status: 'rejected',
            resolvedAt: new Date().toISOString(),
            cancelledAt: new Date().toISOString(),
            cancelledBy: uid,
            operatorNotes: cleanReason.slice(0, 1000),
            recoveryAction: 'admin_cancelled',
        });
    },

    reproposePendingAction: async (actionId: string, reason: string, adminUid?: string): Promise<void> => {
        if (!isConfigured || !db) throw new Error('Not connected');
        const uid = adminUid || auth?.currentUser?.uid;
        if (!uid) throw new Error('Admin user is required');
        const cleanReason = reason.trim();
        if (!cleanReason) throw new Error('Re-proposal reason is required');
        const now = Date.now();
        await db.collection('pending_actions').doc(actionId).update({
            status: 'awaiting',
            proposedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
            resolvedAt: null,
            // Clear terminal artifacts from the prior cancel/execution so the
            // re-opened (awaiting) doc doesn't carry contradictory state.
            cancelledAt: null,
            cancelledBy: null,
            executionPreview: null,
            executingStartedAt: null,
            reProposedAt: new Date(now).toISOString(),
            reProposedBy: uid,
            operatorNotes: cleanReason.slice(0, 1000),
            recoveryAction: 'admin_reproposed',
        });
    },

    subscribeAgentActionLedger: (
        cb: (entries: Array<Record<string, any>>) => void,
        onError?: (err: Error) => void
    ): (() => void) => {
        if (!isConfigured || !db) {
            cb([]);
            return () => {};
        }
        return db.collection('agent_action_ledger')
            .orderBy('updatedAt', 'desc')
            .limit(250)
            .onSnapshot(
                (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
                (err) => {
                    console.error('subscribeAgentActionLedger:', err);
                    onError?.(err as unknown as Error);
                    cb([]);
                }
            );
    },

    subscribeCaraTurnMetrics: (
        cb: (entries: Array<Record<string, any>>) => void,
        onError?: (err: Error) => void
    ): (() => void) => {
        if (!isConfigured || !db) {
            cb([]);
            return () => {};
        }
        return db.collection('cara_turn_metrics')
            .orderBy('at', 'desc')
            .limit(150)
            .onSnapshot(
                (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
                (err) => {
                    console.error('subscribeCaraTurnMetrics:', err);
                    onError?.(err as unknown as Error);
                    cb([]);
                }
            );
    },

    subscribePendingActions: (
        cb: (actions: Array<Record<string, any>>) => void,
        onError?: (err: Error) => void
    ): (() => void) => {
        if (!isConfigured || !db) {
            cb([]);
            return () => {};
        }
        return db.collection('pending_actions')
            .orderBy('proposedAt', 'desc')
            .limit(150)
            .onSnapshot(
                (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
                (err) => {
                    console.error('subscribePendingActions:', err);
                    onError?.(err as unknown as Error);
                    cb([]);
                }
            );
    },

    // Count of unreviewed user reports — drives the admin Reports tab badge.
    subscribeNewReportsCount: (
        cb: (count: number) => void,
        onError?: (err: Error) => void
    ): (() => void) => {
        if (!isConfigured || !db) {
            cb(0);
            return () => {};
        }
        return db.collection('reports')
            .where('status', '==', 'new')
            .onSnapshot(
                (snap) => cb(snap.size),
                (err) => {
                    console.error('subscribeNewReportsCount:', err);
                    onError?.(err as unknown as Error);
                    cb(0);
                }
            );
    },

    // ==================== COORDINATOR METHODS ====================

    getCareCoordinators: async (): Promise<any[]> => {
        if (!isConfigured || !db) return [];
        try {
            const snap = await db.collection('coordinators').get();
            return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        } catch { return []; }
    },

    createCareCoordinator: async (data: any): Promise<any> => {
        if (!isConfigured || !db) throw new Error('Not connected');
        const ref = await db.collection('coordinators').add({ ...data, createdAt: new Date().toISOString() });
        return { id: ref.id, ...data };
    },

    updateCareCoordinator: async (id: string, data: any): Promise<void> => {
        if (!isConfigured || !db) return;
        await db.collection('coordinators').doc(id).update(data);
    },

    // ==================== AI MATCH TRACKING ====================

    getClientMatches: async (clientId: string): Promise<{
        topMatches: Array<{
            caregiverId: string;
            score: number;
            reasons: string[];
            redFlags: string[];
            confidence: 'high' | 'medium' | 'low';
            source: 'embedding' | 'fallback';
        }>;
        computedAt: any;
        version: number;
    } | null> => {
        if (!isConfigured || !db) return null;
        try {
            const doc = await db.collection('clientMatches').doc(clientId).get();
            if (!doc.exists) return null;
            return doc.data() as any;
        } catch {
            return null;
        }
    },

    recordMatchDismissal: async (clientId: string, caregiverId: string): Promise<void> => {
        if (!isConfigured || !db) return;
        try {
            await db.collection('hire_requests').add({
                clientId,
                caregiverId,
                status: 'client_rejected',
                createdAt: new Date().toISOString(),
            });
        } catch { /* best effort */ }
    },

    storeAIMatchScores: async (clientId: string, scores: any[]): Promise<void> => {
        if (!isConfigured || !db) return;
        try { await db.collection('ai_match_scores').doc(clientId).set({ scores, updatedAt: new Date().toISOString() }); } catch { /* best effort */ }
    },

    recordMatchOutcome: async (clientId: string, caregiverId: string, outcome: string): Promise<void> => {
        if (!isConfigured || !db) return;
        try { await db.collection('match_outcomes').add({ clientId, caregiverId, outcome, timestamp: new Date().toISOString() }); } catch { /* best effort */ }
    },

    getCoordinatorMatchingStats: async (coordinatorId: string): Promise<any> => {
        if (!isConfigured || !db) return {};
        try {
            const snap = await db.collection('match_outcomes').where('coordinatorId', '==', coordinatorId).get();
            return { total: snap.size };
        } catch { return {}; }
    },

    createMatchTrackingEvent: async (event: any): Promise<void> => {
        if (!isConfigured || !db) return;
        try { await db.collection('match_tracking').add({ ...event, timestamp: new Date().toISOString() }); } catch { /* best effort */ }
    },

    // ==================== REFERRAL SYSTEM ====================
    // U4 (2026-07-20): dead web referral readers getReferralStats/getReferrals
    // removed — zero callers; referrals are SMS/server-owned by product decision.
    // The backend referral flow (processReferral + v1-resolveReferrerByCode) and
    // sendReferralInvite are preserved.

    /**
     * Send referral invite via email
     */
    sendReferralInvite: async (userId: string, email: string, userType: 'client' | 'caregiver') => {
        if (!isConfigured || !db) {
            return;
        }

        try {
            // Get user's referral code
            const userDoc = await db.collection('users').doc(userId).get();
            const referralCode = userDoc.data()?.referralCode || generateReferralCode();

            // Create referral record
            await db.collection('referrals').add({
                referrerId: userId,
                referrerUserId: userId,
                referredEmail: email,
                status: 'pending',
                referralCode,
                userType,
                createdAt: new Date().toISOString()
            });

            // Send email (would integrate with SendGrid/Email service)
            console.log(`Referral invite sent to ${email} with code ${referralCode}`);
        } catch (error) {
            console.error('Failed to send referral invite:', error);
            throw new Error('Failed to send referral invite. Please try again.');
        }
    },

    /**
     * Process referral on new user signup
     */
    processReferral: async (referralCode: string, newUserId: string) => {
        if (!isConfigured || !db) {
            return;
        }

        try {
            const now = new Date().toISOString();
            const directReferralRef = db.collection('referrals').doc(referralCode);
            const directReferralSnap = await directReferralRef.get();
            if (directReferralSnap.exists) {
                const referral = directReferralSnap.data() || {};
                const referrerId = referral.referrerUserId || referral.referrerId;
                await directReferralRef.update({
                    referredId: newUserId,
                    referredUserId: newUserId,
                    status: ['approved', 'first_booking_completed', 'successful', 'rejected'].includes(referral.status)
                        ? referral.status
                        : 'started',
                    startedAt: referral.startedAt || now,
                    updatedAt: now
                });
                await db.collection('users').doc(newUserId).set({
                    referralCode: generateReferralCode(),
                    ...(referrerId ? { referredBy: referrerId } : {}),
                    sourceReferralId: directReferralSnap.id,
                }, { merge: true });
                return;
            }

            // Find referrer via a server-side callable. Clients can no longer
            // query the users collection (the list rule is admin-only, to stop
            // full-directory enumeration), so the Admin SDK does the lookup.
            // No match → return, same as the old empty-snapshot behavior.
            if (!functions) return;
            const resolveFn = functions.httpsCallable('v1-resolveReferrerByCode');
            const resolveRes = await resolveFn({ code: referralCode });
            const referrerId = (resolveRes.data as { referrerId?: string })?.referrerId;
            if (!referrerId) return;

            // Update referral record
            const referralSnapshot = await db.collection('referrals')
                .where('referralCode', '==', referralCode)
                .where('referredId', '==', null)
                .limit(1)
                .get();

            if (!referralSnapshot.empty) {
                await referralSnapshot.docs[0].ref.update({
                    referredId: newUserId,
                    referredUserId: newUserId,
                    status: 'started',
                    startedAt: now,
                    updatedAt: now
                });
            }

            // Referral benefits (referredBy + $25 referralCredit) are granted
            // server-side by v1-resolveReferrerByCode above — referralCredit
            // is client-write-blocked in firestore.rules, so writing it here
            // would fail the whole update.
            await db.collection('users').doc(newUserId).update({
                referralCode: generateReferralCode(),
            });
        } catch (error) {
            console.error('Failed to process referral:', error);
        }
    },

    // ==================== PHASE 2 FEATURES ====================

    // --- VIDEO UPDATES / MEDIA GALLERY ---
    // U4 (2026-07-20): the media_updates Phase-2 block (createMediaUpdate,
    // getMediaForClient, subscribeToMediaUpdates, notifyFamilyOfMediaUpdate,
    // likeMedia, addComment) was removed — zero callers and zero production
    // documents. No web reader or writer of media_updates remains.

    // --- SMART CARE PLAN V2 ---

    getSmartCarePlan: async (clientId: string): Promise<any | null> => {
        if (!isConfigured || !db) return null;
        
        try {
            const doc = await db.collection('smart_care_plans').doc(clientId).get();
            if (doc.exists) return doc.data();
            return null;
        } catch (e) {
            return null;
        }
    },

    saveSmartCarePlan: async (clientId: string, plan: any) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        await db.collection('smart_care_plans').doc(clientId).set({
            ...plan,
            updatedAt: new Date().toISOString()
        }, { merge: true });
    },

    // --- RECOGNITION CENTER ---

    getCaregiverBadges: async (caregiverId: string): Promise<any[]> => {
        if (!isConfigured || !db) return [];
        
        try {
            const doc = await db.collection('caregiver_badges').doc(caregiverId).get();
            if (doc.exists) return doc.data()?.badges || [];
            return [];
        } catch (e) {
            return [];
        }
    },

    getCaregiverMilestones: async (caregiverId: string): Promise<any[]> => {
        if (!isConfigured || !db) return [];
        
        try {
            const doc = await db.collection('caregiver_milestones').doc(caregiverId).get();
            if (doc.exists) return doc.data()?.milestones || [];
            return [];
        } catch (e) {
            return [];
        }
    },

    // U4 (2026-07-20): getCaregiverOfMonth (caregiver_of_month) and
    // getPeerRecognitions (peer_recognitions) removed — zero callers and zero
    // production documents.

    /**
     * Check if an email is already registered in the system
     * Returns true if email exists, false otherwise
     */
    checkEmailExists: async (email: string): Promise<boolean> => {
        if (!isConfigured || !auth) {
            throw new Error("Authentication service not configured");
        }

        try {
            // Use Firebase's fetchSignInMethodsForEmail to check if email exists
            const methods = await auth.fetchSignInMethodsForEmail(email.toLowerCase().trim());
            return methods.length > 0;
        } catch (error) {
            console.error('Error checking email existence:', error);
            // Don't expose specific errors to prevent email enumeration attacks
            // Return false to allow signup to proceed and fail naturally if email exists
            return false;
        }
    },

    // Live admin invoice list (InvoicingTab). Invoices are created/updated
    // server-side only (createInvoice / processClientApproval, Admin SDK), so
    // the admin table needs a listener to reflect those writes without a refresh.
    subscribeToInvoices: (onUpdate: (invoices: Invoice[]) => void): (() => void) => {
        if (!isConfigured || !db) { onUpdate([]); return () => {}; }
        return db.collection('invoices')
            .orderBy('createdAt', 'desc')
            .onSnapshot(snapshot => {
                onUpdate(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as Invoice[]);
            }, error => {
                console.error('Invoices subscription error:', error);
            });
    },

    // --- INTAKE LEADS MANAGEMENT ---
    subscribeToIntakeLeads: (callback: (leads: any[]) => void) => {
        if (!isConfigured || !db) {
            callback([]);
            return () => {};
        }

        return db.collection('clientIntakes')
            .orderBy('createdAt', 'desc')
            .onSnapshot(snapshot => {
                const leads = snapshot.docs.map(doc => ({
                    userId: doc.id,
                    ...doc.data()
                }));
                callback(leads);
            }, error => {
                console.error('Intake leads subscription error:', error);
                callback([]);
            });
    },

    updateIntakeLead: async (userId: string, updates: { status?: string; contactedAt?: string; notes?: string }) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        await db.collection('clientIntakes').doc(userId).update({
            ...updates,
            updatedAt: new Date().toISOString()
        });
    },

    // ==========================================
    // CARE COORDINATOR MATCHING API
    // ==========================================

    createMatchAssignment: async (data: {
        clientId: string;
        seniorId: string;
        careNeeds: any[];
        priority: 'low' | 'medium' | 'high' | 'urgent';
        notes?: string;
    }) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        const docRef = await db.collection('match_assignments').add({
            ...data,
            status: 'pending_review',
            aiSuggestedMatches: [],
            approvedMatches: [],
            rejectedMatches: [],
            createdAt: new Date().toISOString()
        });
        
        return docRef.id;
    },

    getMatchAssignments: async (filters?: { status?: string; coordinatorId?: string }) => {
        if (!isConfigured || !db) return [];
        
        let query: any = db.collection('match_assignments');
        
        if (filters?.status) {
            query = query.where('status', '==', filters.status);
        }
        
        const snapshot = await query.orderBy('createdAt', 'desc').get();
        return snapshot.docs.map((doc: firebase.firestore.QueryDocumentSnapshot) => ({ id: doc.id, ...doc.data() }));
    },

    updateMatchAssignment: async (assignmentId: string, updates: any) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        await db.collection('match_assignments').doc(assignmentId).update(updates);
    },

    approveMatch: async (assignmentId: string, matchData: {
        caregiverId: string;
        caregiverName: string;
        coordinatorNotes?: string;
        priority: number;
    }) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        const approvedMatch = {
            ...matchData,
            approvedAt: new Date().toISOString(),
            approvedBy: auth?.currentUser?.uid,
            status: 'pre_confirmed'
        };
        
        await db.collection('match_assignments').doc(assignmentId).update({
            approvedMatches: firebase.firestore.FieldValue.arrayUnion(approvedMatch)
        });
    },

    sendMatchesToClient: async (assignmentId: string, clientId: string) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        const fdb = db;

        const assignment = await fdb.collection('match_assignments').doc(assignmentId).get();
        const data = assignment.data();
        
        if (!data || data.approvedMatches.length < 5) {
            throw new Error("Need 5 pre-confirmed matches before sending to client");
        }
        
        // Copy approved matches to client's subcollection
        const batch = fdb.batch();

        data.approvedMatches.forEach((match: any, index: number) => {
            const matchRef = fdb.collection('users').doc(clientId).collection('approved_matches').doc();
            batch.set(matchRef, {
                ...match,
                assignmentId,
                priority: index + 1
            });
        });

        // Update assignment status
        batch.update(fdb.collection('match_assignments').doc(assignmentId), {
            status: 'sent_to_client',
            sentToClientAt: new Date().toISOString()
        });
        
        await batch.commit();
    },

    getClientApprovedMatches: async (clientId: string) => {
        if (!isConfigured || !db) return [];
        
        const snapshot = await db.collection('users')
            .doc(clientId)
            .collection('approved_matches')
            .orderBy('priority')
            .get();
            
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    },

    createInterviewRequest: async (data: {
        clientId: string;
        seniorId: string;
        caregiverId: string;
        matchAssignmentId: string;
        type: 'video' | 'phone' | 'in_person';
        proposedTimes: string[];
        clientNotes?: string;
    }) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        const docRef = await db.collection('interview_requests').add({
            ...data,
            status: 'pending',
            duration: 20,
            createdAt: new Date().toISOString()
        });
        
        return docRef.id;
    },

    getInterviewRequests: async (filters: { clientId?: string; caregiverId?: string }) => {
        if (!isConfigured || !db) return [];
        
        let query: any = db.collection('interview_requests');
        
        if (filters.clientId) {
            query = query.where('clientId', '==', filters.clientId);
        }
        if (filters.caregiverId) {
            query = query.where('caregiverId', '==', filters.caregiverId);
        }
        
        const snapshot = await query.orderBy('createdAt', 'desc').get();
        return snapshot.docs.map((doc: firebase.firestore.QueryDocumentSnapshot) => ({ id: doc.id, ...doc.data() }));
    },

    updateInterviewRequest: async (requestId: string, updates: any) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        await db.collection('interview_requests').doc(requestId).update(updates);
    },

    // U4 (2026-07-20): getMatchScoreForCaregiver (interview_requests
    // caregiverId+clientPhone+createdAt) removed — zero callers.

    submitInterviewFeedback: async (requestId: string, feedback: {
        fit: 'strong' | 'maybe' | 'no_match';
        notes?: string;
    }) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        await db.collection('interview_requests').doc(requestId).update({
            clientFeedback: {
                ...feedback,
                submittedAt: new Date().toISOString()
            },
            status: 'completed'
        });
    },

    submitHireRequest: async (data: {
        clientId: string;
        seniorId: string;
        matchAssignmentId: string;
        caregiverId: string;
        interviewedCaregiverIds: string[];
        proposedStartDate: string;
        proposedSchedule: { days: string[]; startTime: string; endTime: string };
        serviceType: 'ongoing' | 'one_time' | 'respite';
        clientNotes?: string;
    }) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        const docRef = await db.collection('hire_requests').add({
            ...data,
            status: 'pending_coordinator_review',
            requestedAt: new Date().toISOString()
        });
        
        // Update match assignment status
        await db.collection('match_assignments').doc(data.matchAssignmentId).update({
            status: 'hire_requested'
        });
        
        return docRef.id;
    },

    getHireRequests: async (filters?: { status?: string; coordinatorId?: string }) => {
        if (!isConfigured || !db) return [];
        
        let query: any = db.collection('hire_requests');
        
        if (filters?.status) {
            query = query.where('status', '==', filters.status);
        }
        
        const snapshot = await query.orderBy('requestedAt', 'desc').get();
        return snapshot.docs.map((doc: firebase.firestore.QueryDocumentSnapshot) => ({ id: doc.id, ...doc.data() }));
    },

    updateHireRequestStatus: async (requestId: string, updates: {
        status: string;
        coordinatorId?: string;
        coordinatorNotes?: string;
    }) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        const updateData: any = {
            status: updates.status,
            coordinatorReviewedAt: new Date().toISOString()
        };
        
        if (updates.coordinatorId) {
            updateData.coordinatorId = updates.coordinatorId;
        }
        if (updates.coordinatorNotes) {
            updateData.coordinatorNotes = updates.coordinatorNotes;
        }
        
        await db.collection('hire_requests').doc(requestId).update(updateData);
    },

    approveHireRequest: async (requestId: string, coordinatorId: string) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        await db.collection('hire_requests').doc(requestId).update({
            status: 'coordinator_approved',
            coordinatorId,
            coordinatorReviewedAt: new Date().toISOString()
        });

        // Caregiver notification is owned by the server-side Firestore trigger
        // `onHireRequestApproved` (functions/src/matching.ts), which fires on this
        // exact `coordinator_approved` status transition and delivers the in-app
        // notification doc + hire-offer email + Linq SMS/iMessage via the Admin SDK.
        // Do not add a client-side notify here (would double-notify).
        // Note: this callable currently has zero frontend callers; kept intentionally
        // (do not delete) — the coordinator approval path may be wired to UI later.
    },


    // U4 (2026-07-20): getShiftHistory (shifts caregiverId+clientId+timestamp)
    // and the legacy timesheets CRUD block (submitTimesheet, getClientTimesheets,
    // getCaregiverTimesheets, approveTimesheet, disputeTimesheet,
    // autoApproveTimesheet) removed — zero callers and zero production documents.
    // Canonical payroll is shiftHours (see shiftHoursService).

    getMatchOutcomes: async (since?: string): Promise<any[]> => {
        if (!isConfigured || !db) return [];
        try {
            let q: firebase.firestore.Query = db.collection('match_outcomes');
            if (since) q = q.where('timestamp', '>=', since);
            const snap = await q.orderBy('timestamp', 'desc').limit(500).get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch { return []; }
    },

    getCoordinatorStats: async (coordinatorId: string): Promise<any> => {
        if (!isConfigured || !db) return { totalMatches: 0, aiSuggestionsPicked: 0, manualPicks: 0, hireRate: 0, retentionRate: 0 };
        try {
            const snap = await db.collection('match_outcomes').where('coordinatorId', '==', coordinatorId).get();
            const rows = snap.docs.map(d => d.data());
            const aiPicked = rows.filter(r => r.wasAISuggested && r.wasSelected).length;
            const hired = rows.filter(r => r.outcome === 'hired').length;
            return {
                totalMatches: rows.length,
                aiSuggestionsPicked: aiPicked,
                manualPicks: rows.filter(r => !r.wasAISuggested && r.wasSelected).length,
                hireRate: rows.length ? Math.round((hired / rows.length) * 100) : 0,
                retentionRate: 0
            };
        } catch { return { totalMatches: 0, aiSuggestionsPicked: 0, manualPicks: 0, hireRate: 0, retentionRate: 0 }; }
    },

    getAIEffectivenessStats: async (): Promise<any> => {
        if (!isConfigured || !db) return { totalSuggestions: 0, pickedByCoordinator: 0, pickedAndHired: 0, averageScoreOfPicked: 0, averageScoreOfNotPicked: 0 };
        try {
            const snap = await db.collection('match_outcomes').where('wasAISuggested', '==', true).get();
            const rows = snap.docs.map(d => d.data());
            const picked = rows.filter(r => r.wasSelected);
            const pickedAndHired = picked.filter(r => r.outcome === 'hired');
            const avgScore = (arr: any[]) => arr.length ? arr.reduce((s, r) => s + (r.score || 0), 0) / arr.length : 0;
            return {
                totalSuggestions: rows.length,
                pickedByCoordinator: picked.length,
                pickedAndHired: pickedAndHired.length,
                averageScoreOfPicked: avgScore(picked),
                averageScoreOfNotPicked: avgScore(rows.filter(r => !r.wasSelected))
            };
        } catch { return { totalSuggestions: 0, pickedByCoordinator: 0, pickedAndHired: 0, averageScoreOfPicked: 0, averageScoreOfNotPicked: 0 }; }
    },

    updateMatchOutcome: async (matchAssignmentId: string, caregiverId: string, updates: any): Promise<void> => {
        if (!isConfigured || !db) return;
        try {
            const snap = await db.collection('match_outcomes')
                .where('matchAssignmentId', '==', matchAssignmentId)
                .where('caregiverId', '==', caregiverId)
                .limit(1).get();
            if (!snap.empty) {
                await snap.docs[0].ref.update(updates);
            } else {
                await db.collection('match_outcomes').add({ matchAssignmentId, caregiverId, ...updates });
            }
        } catch { /* best effort */ }
    },

    // Own-doc payout fields (stripeAccountId, payoutsEnabled, chargesEnabled,
    // stripeOnboardingComplete, detailsSubmitted) — moved off the
    // world-readable caregivers/{id} parent to the owner-only private/payout
    // subdoc. Readable only by the owner or an admin.
    getOwnCaregiverPayoutFields: async (uid: string): Promise<Record<string, any>> => {
        if (!isConfigured || !db || !uid) return {};
        try {
            const snap = await db.collection('caregivers').doc(uid).collection('private').doc('payout').get();
            return snap.exists ? (snap.data() as Record<string, any>) : {};
        } catch { return {}; }
    },

};

export const stripeService = externalStripeService;
// Export storageService for convenience
export { storageService };

// authService is an alias for dbService
export { dbService as authService };

/**
 * Generate a unique referral code
 */
function generateReferralCode(): string {
    return 'CARE' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ==========================================
// SHIFT HOURS (per-shift submit / review / Stripe)
// ==========================================

export const shiftHoursService = {
    submit: async (
        shiftId: string,
        startTime: string,
        endTime: string,
        lineItems?: Array<{ type: string; label: string; note: string; amount: number }>,
    ) => {
        if (!isConfigured || !functions) throw new Error('Firebase not configured');
        const fn = functions.httpsCallable('v1-submitShiftHours');
        const res = await fn({ shiftId, startTime, endTime, lineItems: lineItems ?? [] });
        return res.data as { success: boolean; shiftId: string; totalHours: number };
    },

    review: async (
        appointmentId: string,
        action: 'approve' | 'propose_correction' | 'accept_counter' | 'escalate',
        proposed?: { startTime: string; endTime: string; reason?: string; lineItems?: Array<{ type: string; label: string; note: string; amount: number }> }
    ) => {
        if (!isConfigured || !functions) throw new Error('Firebase not configured');
        const fn = functions.httpsCallable('v1-reviewShiftHours');
        const res = await fn({
            appointmentId,
            action,
            proposedStartTime: proposed?.startTime,
            proposedEndTime: proposed?.endTime,
            proposalReason: proposed?.reason,
            lineItems: proposed?.lineItems,
        });
        return res.data as { success: boolean };
    },

    respondToCorrection: async (
        appointmentId: string,
        action: 'accept' | 'counter_propose',
        counter?: { startTime: string; endTime: string; note?: string; lineItems?: Array<{ type: string; label: string; note: string; amount: number }> }
    ) => {
        if (!isConfigured || !functions) throw new Error('Firebase not configured');
        const fn = functions.httpsCallable('v1-respondToCorrection');
        const res = await fn({
            appointmentId,
            action,
            counterStartTime: counter?.startTime,
            counterEndTime: counter?.endTime,
            counterNote: counter?.note,
            counterLineItems: counter?.lineItems,
        });
        return res.data as { success: boolean };
    },

    adminResolve: async (appointmentId: string, finalStartTime: string, finalEndTime: string, note?: string) => {
        if (!isConfigured || !functions) throw new Error('Firebase not configured');
        const fn = functions.httpsCallable('v1-adminResolveShiftHours');
        const res = await fn({ appointmentId, finalStartTime, finalEndTime, note });
        return res.data as { success: boolean };
    },

    retryPayment: async (appointmentId: string) => {
        if (!isConfigured || !functions) throw new Error('Firebase not configured');
        const fn = functions.httpsCallable('v1-retryShiftPayment');
        const res = await fn({ appointmentId });
        return res.data as { success: boolean; error?: string };
    },

    updateBookingPaymentMethod: async (appointmentId: string, paymentMethod: 'cash' | 'venmo' | 'zelle' | 'credit') => {
        if (!isConfigured || !functions) throw new Error('Firebase not configured');
        const fn = functions.httpsCallable('v1-updateBookingPaymentMethod');
        const res = await fn({ appointmentId, paymentMethod });
        return res.data as { success: boolean };
    },

    // Caregiver confirms receipt of an offline payment (cash, Venmo, or Zelle).
    // Name kept for existing callers; covers all offline methods.
    confirmCashReceived: async (appointmentId: string) => {
        if (!isConfigured || !db) throw new Error('Firebase not configured');
        const uid = auth?.currentUser?.uid;
        if (!uid) throw new Error('Must be signed in');

        const ref = db.collection('shiftHours').doc(appointmentId);
        const snap = await ref.get();
        if (!snap.exists) throw new Error('Shift hours record not found');

        const shift = snap.data()!;
        const method = (shift.paymentMethod || '').toLowerCase();
        if (shift.caregiverId !== uid)
            throw new Error('Only the caregiver can confirm payment receipt');
        if (!['cash', 'venmo', 'zelle'].includes(method))
            throw new Error('Shift is not an offline (cash/Venmo/Zelle) payment');
        if (shift.status !== 'approved' && shift.status !== 'auto_approved')
            throw new Error(`Shift must be approved first (current: ${shift.status})`);

        const now = new Date().toISOString();
        await ref.update({
            status: 'paid',
            paidMethod: method,
            paidAt: now,
            cashConfirmedAt: now,
            updatedAt: now,
        });
        return { success: true };
    },

    subscribeForCaregiver: (caregiverId: string, cb: (rows: any[]) => void) => {
        if (!isConfigured || !db) { cb([]); return () => {}; }
        return db.collection('shiftHours')
            .where('caregiverId', '==', caregiverId)
            .orderBy('submittedAt', 'desc')
            .onSnapshot(
                snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
                _err => cb([])
            );
    },

    subscribeForClient: (clientId: string, cb: (rows: any[]) => void) => {
        if (!isConfigured || !db) { cb([]); return () => {}; }
        return db.collection('shiftHours')
            .where('clientId', '==', clientId)
            .orderBy('submittedAt', 'desc')
            .onSnapshot(
                snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
                _err => cb([])  // index missing or permission error — stop the spinner
            );
    },

    subscribeForAdmin: (cb: (rows: any[]) => void) => {
        if (!isConfigured || !db) { cb([]); return () => {}; }
        return db.collection('shiftHours')
            .where('status', 'in', ['disputed_admin_review', 'payment_failed'])
            .orderBy('submittedAt', 'desc')
            .onSnapshot(snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    },

    getForAppointment: async (appointmentId: string) => {
        if (!isConfigured || !db) return null;
        const doc = await db.collection('shiftHours').doc(appointmentId).get();
        return doc.exists ? { id: doc.id, ...doc.data() } : null;
    },
};

// ─── Admin-only helpers ──────────────────────────────────────────────────────

export const adminService = {
    getAllAppointments: async (): Promise<import('../types').Appointment[]> => {
        if (!isConfigured || !db) return [];
        try {
            const snap = await db.collection('appointments').orderBy('isoDate', 'desc').limit(500).get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() } as import('../types').Appointment));
        } catch { return []; }
    },

    cancelAppointment: async (appointmentId: string, reason: string): Promise<void> => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        await db.collection('appointments').doc(appointmentId).update({
            status: 'cancelled',
            cancellationReason: reason,
            cancelledBy: 'admin',
            cancelledAt: new Date().toISOString(),
        });
    },

    getAllReviews: async (): Promise<import('../types').Review[]> => {
        if (!isConfigured || !db) return [];
        try {
            const snap = await db.collection('reviews').orderBy('date', 'desc').limit(500).get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() } as import('../types').Review));
        } catch { return []; }
    },

    deleteReview: async (reviewId: string): Promise<void> => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        await db.collection('reviews').doc(reviewId).delete();
    },

    unbanUser: async (uid: string): Promise<void> => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        await db.collection('users').doc(uid).update({ isBanned: false, suspendedUntil: null, suspensionReason: null });
    },

    suspendUser: async (uid: string, reason: string, days: number): Promise<void> => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        const until = new Date();
        until.setDate(until.getDate() + days);
        await db.collection('users').doc(uid).update({
            isSuspended: true,
            suspendedUntil: until.toISOString(),
            suspensionReason: reason,
        });
    },

    unsuspendUser: async (uid: string): Promise<void> => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        await db.collection('users').doc(uid).update({ isSuspended: false, suspendedUntil: null, suspensionReason: null });
    },

    updateClient: async (uid: string, data: Partial<import('../types').AdminUser>): Promise<void> => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        await db.collection('users').doc(uid).update(data as any);
    },

    getUserEmail: async (uid: string): Promise<string | null> => {
        if (!isConfigured || !db) return null;
        try {
            const doc = await db.collection('users').doc(uid).get();
            return doc.exists ? (doc.data()?.email ?? null) : null;
        } catch { return null; }
    },

    updateCaregiver: async (uid: string, data: Partial<import('../types').Caregiver>): Promise<void> => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        await db.collection('caregivers').doc(uid).update(data as any);
        // Mirror name/email to users collection
        const mirror: Record<string, any> = {};
        if (data.name) mirror.name = data.name;
        if (data.email) mirror.email = data.email;
        if (Object.keys(mirror).length) {
            try { await db.collection('users').doc(uid).update(mirror); } catch { /* best effort */ }
        }
    },

    // Caregiver identity PII (legal name / DOB / SSN-4 / ZIP) now lives in the
    // owner+admin-only caregivers/{uid}/private/background doc, not the
    // world-readable parent. Admins read it here to render the verification
    // detail view. Returns {} when absent (pre-backfill docs still carry the
    // fields on the parent, so callers merge parent-then-private).
    getCaregiverBackgroundPII: async (uid: string): Promise<Record<string, any>> => {
        if (!isConfigured || !db || !uid) return {};
        try {
            const snap = await db.collection('caregivers').doc(uid).collection('private').doc('background').get();
            return snap.exists ? (snap.data() as Record<string, any>) : {};
        } catch { return {}; }
    },

    getClientAppointments: async (clientId: string): Promise<import('../types').Appointment[]> => {
        if (!isConfigured || !db) return [];
        try {
            const snap = await db.collection('appointments').where('clientId', '==', clientId).orderBy('isoDate', 'desc').limit(20).get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() } as import('../types').Appointment));
        } catch { return []; }
    },

    getCaregiverAppointments: async (caregiverId: string): Promise<import('../types').Appointment[]> => {
        if (!isConfigured || !db) return [];
        try {
            const snap = await db.collection('appointments').where('caregiverId', '==', caregiverId).orderBy('isoDate', 'desc').limit(20).get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() } as import('../types').Appointment));
        } catch { return []; }
    },

    getAllCaregivers: async (): Promise<import('../types').Caregiver[]> => {
        if (!isConfigured || !db) return [];
        const snap = await db.collection('caregivers').limit(500).get();
        return snap.docs.map(d => ({ ...d.data(), uid: d.id } as import('../types').Caregiver));
    },

};

// ── Standalone: Job Posting Wizard save ──────────────────────────────────────
// Exported separately because dbService is large enough to exceed TS object-type
// inference limits, making new members invisible to importers.

export interface WizardJobPostingData {
    careFrequency: string;
    street: string;
    zipCode: string;
    city: string;
    state: string;
    neighborhood: string;
    startDate: string;
    daysFlexible: boolean;
    selectedDays: string[];
    timeOfDay: string[];
    photoURL: string;
    careRecipientFirstName: string;
    careRecipientLastName: string;
    careRecipientAge: string;
    adultsCount: number;
    additionalRecipients: { firstName: string; lastName: string; age: string; relationship: string }[];
    relationship: string;
    emergencyFirstName: string;
    emergencyLastName: string;
    emergencyPhone: string;
    careNeeds: string[];
    rate: number;
    rateFlexible: boolean;
    paymentMethod: string;
    jobDescription: string;
    petsInHome?: boolean;
    smokingHousehold?: boolean;
}

export async function createJobPosting(uid: string, data: WizardJobPostingData): Promise<void> {
    if (!isConfigured || !db) throw new Error("Database not connected");

    const clean = {
        ...data,
        careRecipientFirstName: sanitizePlainText(data.careRecipientFirstName),
        careRecipientLastName:  sanitizePlainText(data.careRecipientLastName),
        jobDescription: sanitizePlainText(data.jobDescription),
        street: sanitizePlainText(data.street),
        city: sanitizePlainText(data.city),
        state: sanitizePlainText(data.state),
        neighborhood: sanitizePlainText(data.neighborhood),
        emergencyFirstName: sanitizePlainText(data.emergencyFirstName),
        emergencyLastName:  sanitizePlainText(data.emergencyLastName),
        emergencyPhone:     sanitizePlainText(data.emergencyPhone),
        additionalRecipients: data.additionalRecipients.map(r => ({
            firstName:    sanitizePlainText(r.firstName),
            lastName:     sanitizePlainText(r.lastName),
            age:          r.age,
            relationship: r.relationship,
        })),
    };

    // Geocode the care address once at wizard completion so Find Caregivers
    // can do instant distance math without any API calls at browse time.
    let lat: number | null = null;
    let lng: number | null = null;
    const addrQuery = [clean.street, clean.city, clean.state, clean.zipCode].filter(Boolean).join(', ');
    if (addrQuery) {
        try {
            const geoRes = await fetch(
                `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(addrQuery)}&format=json&limit=1&countrycodes=us`,
                { headers: { 'Accept-Language': 'en', 'User-Agent': 'Evia/1.0' } }
            );
            const geoData = await geoRes.json();
            if (geoData?.length) {
                lat = parseFloat(geoData[0].lat);
                lng = parseFloat(geoData[0].lon);
            }
        } catch { /* best effort — wizard saves without coords if geocoding fails */ }
    }

    // Signup-time photo is the ACCOUNT HOLDER's own photo (same semantics as
    // AccountSettings.tsx's "your photo") — NOT automatically the care
    // recipient's. It only becomes the recipient's photo (careRecipientPhotoURL,
    // the field CarePlan.tsx actually reads) when the client IS the recipient;
    // otherwise the recipient's own photo gets set later via CarePlan's own
    // per-recipient upload. Excluded from the generic `clean` spread below so
    // it never lands under the ambiguous raw `photoURL` key on job_postings
    // (Hamse, 2026-08-23).
    const { photoURL, ...cleanForJobPosting } = clean;

    // Critical write — throw if this fails
    await db.collection('job_postings').doc(uid).set({
        ...cleanForJobPosting,
        clientId: uid,
        status: 'active',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        ...(lat !== null && lng !== null ? { lat, lng } : {}),
        ...(photoURL && clean.relationship === 'myself' ? { careRecipientPhotoURL: photoURL } : {}),
    });

    if (photoURL) {
        await db.collection('users').doc(uid).set({ photoURL }, { merge: true }).catch(() => {});
        try { await firebase.auth().currentUser?.updateProfile({ photoURL }); } catch { /* best effort */ }
    }

    // Best-effort writes — don't block wizard completion if they fail
    // name/needs are the canonical Senior fields (types.ts) — read by the
    // dashboard, ClientProfile, and the AI matching engine. careNeeds/
    // firstName/lastName are kept too (also valid Senior fields) but were
    // previously the ONLY fields written here, so a web-onboarded client's
    // care needs never showed up anywhere that reads the canonical `needs`.
    const recipientName = [clean.careRecipientFirstName, clean.careRecipientLastName].filter(Boolean).join(' ');
    const profileUpdate: Record<string, any> = {
        careNeeds: clean.careNeeds,
        needs: clean.careNeeds,
        scheduleNeeded: clean.selectedDays,
        zipCode: clean.zipCode,
    };
    if (recipientName) profileUpdate.name = recipientName;
    if (clean.city && clean.state) profileUpdate.location = `${clean.city}, ${clean.state}`;
    if (clean.careRecipientFirstName) profileUpdate.firstName = clean.careRecipientFirstName;
    if (clean.careRecipientLastName)  profileUpdate.lastName  = clean.careRecipientLastName;
    if (clean.adultsCount) profileUpdate.adultsCount = clean.adultsCount;
    if (clean.careRecipientAge) profileUpdate.age = parseInt(clean.careRecipientAge, 10) || undefined;
    if (clean.relationship) profileUpdate.relationship = clean.relationship;

    // Sync pets/smoking to locationPool entry for the primary address
    const locationPoolUpdate = async () => {
        if (!clean.street) return;
        const cpRef = db!.collection('carePlans').doc(uid);
        const cpSnap = await cpRef.get();
        const pool: any[] = (cpSnap.data() as any)?.locationPool || [];
        const poolIdx = pool.findIndex((l: any) => l.street?.toLowerCase() === clean.street.toLowerCase() && l.zipCode === clean.zipCode);
        if (poolIdx >= 0) {
            pool[poolIdx] = { ...pool[poolIdx], petsInHome: clean.petsInHome ?? false, smokingHousehold: clean.smokingHousehold ?? false };
        } else {
            pool.push({ street: clean.street, city: clean.city, state: clean.state, zipCode: clean.zipCode, petsInHome: clean.petsInHome ?? false, smokingHousehold: clean.smokingHousehold ?? false });
        }
        await cpRef.set({ locationPool: pool }, { merge: true });
    };

    // Normalize wizard emergency contact into carePlans/{uid}.emergencyContacts
    const emergencyContactWrite = (clean.emergencyFirstName || clean.emergencyPhone)
        ? db.collection('carePlans').doc(uid).set({
            emergencyContacts: [{
                id: 'wizard',
                name: [clean.emergencyFirstName, clean.emergencyLastName].filter(Boolean).join(' '),
                relation: (clean as any).emergencyRelationship || '',
                phone: clean.emergencyPhone,
                isPrimary: true,
            }],
        }, { merge: true })
        : Promise.resolve();

    await Promise.allSettled([
        db.collection('senior_profiles').doc(uid).set(profileUpdate, { merge: true }),
        db.collection('users').doc(uid).set({ jobPostingCompleted: true }, { merge: true }),
        locationPoolUpdate(),
        emergencyContactWrite,
    ]);
}
