import { stripeService as externalStripeService } from './stripeService';
import { checkRateLimit, checkSignupRateLimit, RATE_LIMITS } from './rateLimit';

import firebase, { auth, db, functions, isConfigured, googleProvider } from '../lib/firebase';
import { getStorage, ref as storageRef, deleteObject } from 'firebase/storage';
import { DEFAULT_CAREGIVER_AVATAR } from '../constants';

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
import { Caregiver, Appointment, Review, Thread, DirectMessage, Senior, CarePlan, SupportTicket, AppNotification, BackgroundCheckData, AdminUser, MatchFeedback, EmergencyAlert, FamilyMember, JobPost, CareJournalEntry } from '../types';
import { errorHandler } from './errorHandler';
import { validators, validateSignup, validateLogin, isFirebaseError, getSafeErrorMessage, normalizePhoneNumber, sanitizeString } from '../utils/validation';
import { sanitizeMessage, sanitizeName, sanitizeBio, sanitizePlainText } from '../utils/sanitize';
import { notifyFamilyOfCheckIn, notifyFamilyOfArrival } from './notificationService';
import { storageService } from './storageService';

export const dbService = {
    login: async (email: string, pass: string, userType: 'client' | 'caregiver') => {
        // Validate inputs before Firebase call
        const validation = validateLogin({ email, password: pass });
        if (!validation.isValid) {
            throw new Error(validation.errors[0].message);
        }

        if (isConfigured && auth) {
            try {
                const userCredential = await auth.signInWithEmailAndPassword(email, pass);
                return userCredential.user;
            } catch (error: unknown) {
                // Log with hashed email for HIPAA compliance
                await errorHandler.logError(error, {
                    action: 'login',
                    component: 'authService',
                    additionalData: { 
                        userType, 
                        emailHash: await validators.hashForLogging(email)
                    }
                });
                throw new Error(getSafeErrorMessage(error));
            }
        } else {
            throw new Error("Authentication service not configured. Please check your Firebase settings.");
        }
    },

    signup: async (email: string, pass: string, name: string, userType: 'client' | 'caregiver', additionalData: {
        zipCode?: string;
        hourlyRate?: number;
        personalityTags?: string[];
        certifications?: string[];
        experience?: number;
        hasTransportation?: boolean;
        location?: string;
        latitude?: number;
        longitude?: number;
        gender?: 'Male' | 'Female' | 'Non-binary' | 'Prefer not to say';
        verified?: boolean;
        onboardingStatus?: string;
        [key: string]: unknown;
    }) => {
        // SECURITY FIX: IP-based rate limiting to prevent email rotation attacks
        // An attacker can bypass email-based limits by using random emails
        const ipBasedLimit = await checkSignupRateLimit();
        if (!ipBasedLimit.allowed) {
            throw new Error(`Too many signup attempts. Please try again in ${Math.ceil((ipBasedLimit.retryAfterMs || 60000) / 60000)} minutes.`);
        }
        
        // Also check email-based limit as secondary protection
        const emailBasedLimit = await checkRateLimit(email.toLowerCase().trim(), RATE_LIMITS.signup);
        if (!emailBasedLimit.allowed) {
            throw new Error(`Too many signup attempts for this email. Please try again later.`);
        }

        // Validate all inputs before any Firebase calls
        const validation = validateSignup({ email, password: pass, name, userType, ...additionalData });
        if (!validation.isValid) {
            throw new Error(validation.errors.map(e => `${e.field}: ${e.message}`).join(', '));
        }

        // Validate hourly rate bounds for caregivers
        if (userType === 'caregiver' && additionalData.hourlyRate !== undefined) {
            const rate = additionalData.hourlyRate;
            if (rate < 15 || rate > 100) {
                throw new Error('Hourly rate must be between $15 and $100');
            }
        }

        // Sanitize inputs
        const sanitizedEmail = sanitizeString(email);
        const sanitizedName = sanitizeString(name);

        if (isConfigured && auth && db) {
            let user;
            try {
                const userCredential = await auth.createUserWithEmailAndPassword(sanitizedEmail, pass);
                user = userCredential.user;
            } catch (error: unknown) {
                // SECURITY FIX: Removed auto-recovery login attempt
                // This was a vulnerability allowing account enumeration attacks
                await errorHandler.logError(error, {
                    action: 'signup',
                    component: 'authService',
                    additionalData: {
                        userType,
                        emailHash: await validators.hashForLogging(sanitizedEmail)
                    }
                });
                throw new Error(getSafeErrorMessage(error));
            }

            if (user) {
                await user.updateProfile({ displayName: sanitizedName });

                // Critical Fix: Firestore cannot accept 'undefined'. Use 'null' instead.
                const verifiedStatus = userType === 'caregiver' ? false : null;

                // ATTEMPT FIRESTORE WRITE
                try {
                    // Sanitize all additional data
                    // CRITICAL FIX: Filter out undefined and empty string values - Firestore rejects undefined
                    const sanitizedAdditionalData = Object.fromEntries(
                        Object.entries(additionalData)
                            .filter(([_, value]) => value !== undefined && value !== '')
                            .map(([key, value]) => {
                                // Normalize phone numbers to E.164 format
                                if (key === 'phone' && typeof value === 'string') {
                                    const normalized = normalizePhoneNumber(value);
                                    return [key, normalized || value];
                                }
                                return [key, typeof value === 'string' ? sanitizeString(value) : value];
                            })
                    );

                    await db.collection('users').doc(user.uid).set({
                        uid: user.uid,
                        name: sanitizedName,
                        email: sanitizedEmail,
                        userType,
                        createdAt: new Date().toISOString(),
                        isBanned: false,
                        verified: verifiedStatus,
                        ...sanitizedAdditionalData
                    }, { merge: true });

                    if (userType === 'client') {
                        await db.collection('senior_profiles').doc(user.uid).set({
                            name: sanitizedName,
                            personality: 'Introvert',
                            needs: [],
                            zipCode: additionalData.zipCode ?? null,
                            familyMembers: []
                        }, { merge: true });
                    } else if (userType === 'caregiver') {
                        await db.collection('caregivers').doc(user.uid).set({
                            uid: user.uid,
                            name: sanitizedName,
                            hourlyRate: additionalData.hourlyRate || 25,
                            verified: false,
                            instantPayAvailable: false,
                            personalityTags: additionalData.personalityTags || [],
                            matchScore: 80,
                            distance: 0,
                            availability: [],
                            backgroundCheckStatus: 'none',
                            ...sanitizedAdditionalData
                        }, { merge: true });
                    }
                } catch (dbError: unknown) {
                    await errorHandler.logError(dbError, {
                        userId: user.uid,
                        action: 'create_user_profile',
                        component: 'authService',
                        additionalData: { userType }
                    });
                    const errorMessage = dbError instanceof Error ? dbError.message : 'Unknown error';
                    console.warn("Firestore Write Failed:", errorMessage);
                    throw new Error("Failed to create user profile. Please check your permissions and try again.");
                }
            }
            // Send email verification for caregivers
            if (userType === 'caregiver' && user) {
                try {
                    await user.sendEmailVerification();
                    console.log('Email verification sent to caregiver');
                } catch (verifyError) {
                    console.error('Failed to send email verification:', verifyError);
                    // Don't fail signup if verification email fails
                }
            }
            
            // Clear rate limit on successful signup
            clearLocalRateLimit(`signup_${email.toLowerCase().trim()}`);
            return user;
        } else {
            throw new Error("Auth service not configured");
        }
    },

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

    sendPasswordResetEmail: async (email: string) => {
        const cacheKey = `pwd_reset_${email.toLowerCase().trim()}`;
        return dedupePromise(cacheKey, async () => {
            if (!isConfigured || !functions) {
                throw new Error("Authentication service not configured");
            }
            try {
                const fn = functions.httpsCallable('v1-sendPasswordResetEmail');
                await fn({ email });
                return true;
            } catch (error: unknown) {
                await errorHandler.logError(error, {
                    action: 'password_reset',
                    component: 'authService',
                    additionalData: { emailHash: await validators.hashForLogging(email) }
                });
                throw new Error(getSafeErrorMessage(error));
            }
        });
    },

    signInWithGoogle: async (userType: 'client' | 'caregiver') => {
        if (!isConfigured || !auth || !db) {
            throw new Error("Authentication service not configured.");
        }
        let result: firebase.auth.UserCredential;
        try {
            result = await auth.signInWithPopup(googleProvider);
        } catch (error: unknown) {
            throw new Error(getSafeErrorMessage(error));
        }
        const user = result.user;
        if (!user) throw new Error("Google sign-in did not return a user.");

        const userDocRef = db.collection('users').doc(user.uid);
        const userDoc = await userDocRef.get();

        if (!userDoc.exists) {
            const displayName = user.displayName || user.email?.split('@')[0] || 'User';
            await userDocRef.set({
                uid: user.uid,
                name: displayName,
                email: user.email,
                userType,
                createdAt: new Date().toISOString(),
                isBanned: false,
                verified: userType === 'caregiver' ? false : null,
            }, { merge: true });

            if (userType === 'client') {
                await db.collection('senior_profiles').doc(user.uid).set({
                    name: displayName,
                    personality: 'Introvert',
                    needs: [],
                    familyMembers: [],
                }, { merge: true });
            } else {
                await db.collection('caregivers').doc(user.uid).set({
                    uid: user.uid,
                    name: displayName,
                    hourlyRate: 25,
                    verified: false,
                    instantPayAvailable: false,
                    personalityTags: [],
                    matchScore: 80,
                    distance: 0,
                    availability: [],
                    backgroundCheckStatus: 'none',
                    onboardingStatus: 'incomplete',
                    onboardingStep: 1,
                }, { merge: true });
            }
        }

        const actualUserType = (userDoc.data()?.userType as 'client' | 'caregiver' | undefined) ?? userType;
        return { user, isNewUser: !userDoc.exists, actualUserType };
    },

    confirmGoogleUserName: async (uid: string, firstName: string, lastName: string) => {
        if (!isConfigured || !db) throw new Error("Service not configured.");
        const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
        await db.collection('users').doc(uid).update({ name: fullName, firstName: firstName.trim(), lastName: lastName.trim() });
        await db.collection('senior_profiles').doc(uid).update({ name: fullName }).catch(() => {});
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
                let query = db.collection('caregivers')
                    .orderBy('name')
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
                snap.forEach(doc => jobs.push({ id: doc.id, ...doc.data() } as JobPost));
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
                snap.forEach(doc => jobs.push({ id: doc.id, ...doc.data() } as JobPost));
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
                    if (data && data.title) {
                        jobs.push({ id: doc.id, ...data } as JobPost);
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
                        clientId: validators.hashForLogging(clientId),
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
            const DEFAULT_HOURS_PER_VISIT = 3; // Standard visit duration
            
            const jobRef = db.collection('job_posts').doc(jobId);
            
            try {
                const result = await db.runTransaction(async (transaction) => {
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
                    const appointmentRef = db.collection('appointments').doc();
                    transaction.set(appointmentRef, {
                        caregiverId: caregiver.id,
                        caregiverName: caregiver.name,
                        clientName: jobData.clientName,
                        clientId: jobData.clientId,
                        date: jobData.date,
                        isoDate: new Date().toISOString().split('T')[0],
                        time: jobData.startTime,
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
            // BUG FIX: Wrap transaction in try-catch for better error handling
            try {
                const appointment = await db.runTransaction(async (transaction) => {
                // Extract date and time for availability check
                const { caregiverId, date, time, clientId } = appointmentData;
                
                // CRITICAL FIX: Use atomic lock acquisition to prevent race conditions
                // The lock document ID is based on the time slot - if it exists, someone else is booking
                const lockId = `${caregiverId}_${date}_${time}`;
                const lockRef = db.collection('appointment_locks').doc(lockId);
                
                // Try to create lock atomically
                const lockDoc = await transaction.get(lockRef);
                if (lockDoc.exists) {
                    const lockData = lockDoc.data();
                    if (lockData && lockData.expiresAt && new Date(lockData.expiresAt) > new Date()) {
                        throw new Error('This time slot is currently being booked by another user. Please try again in a moment or select a different time.');
                    }
                }
                
                transaction.set(lockRef, {
                    lockId,
                    caregiverId,
                    date,
                    time,
                    clientId,
                    createdAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
                });
                
                // Check for double-booking: Query for existing appointments
                // These queries are now part of the transaction for true atomicity
                const existingApptsQuery = db.collection('appointments')
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
                const clientApptsQuery = db.collection('appointments')
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
                const docRef = db.collection('appointments').doc();
                const docId = docRef.id;

                // Determine status based on booking type
                // If caregiverId is provided (direct booking), it needs caregiver confirmation
                // If it's from job board accept, it's already confirmed
                const isDirectBooking = !!appointmentData.caregiverId && !appointmentData.isRecurring;
                const status = isDirectBooking ? 'pending_caregiver_confirmation' : 'confirmed';

                const newAppt = {
                    ...appointmentData,
                    id: docId,
                    createdAt: new Date().toISOString(),
                    status
                };

                // Remove undefined fields - Firestore doesn't accept undefined values
                const cleanedAppt = Object.fromEntries(
                    Object.entries(newAppt).filter(([_, value]) => value !== undefined)
                );

                transaction.set(docRef, cleanedAppt);
                
                // Release the lock after successful booking
                transaction.delete(lockRef);
                
                // Clear rate limit on successful booking
                clearLocalRateLimit(`booking_${appointmentData.clientId}_${appointmentData.caregiverId}`);
                
                return cleanedAppt as unknown as Appointment;
            });

            // Notify caregiver of new booking request (fire-and-forget, don't fail booking)
            try {
                await db.collection('users').doc(appointment.caregiverId).collection('notifications').add({
                    userId: appointment.caregiverId,
                    type: 'new_booking',
                    title: 'New Booking Request',
                    message: `${appointment.clientName} booked you for ${appointment.date} at ${appointment.time}.`,
                    data: { appointmentId: appointment.id },
                    read: false,
                    isRead: false,
                    timestamp: new Date().toISOString(),
                    createdAt: new Date().toISOString()
                });
            } catch (_) { /* non-critical */ }

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
                        appts.push(doc.data() as Appointment);
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
            if (data?.clientId !== auth.currentUser?.uid && data?.caregiverId !== auth.currentUser?.uid) {
                throw new Error('Unauthorized');
            }

            const updateData = {
                status: 'cancelled',
                cancellationReason: reason,
                cancelledBy: cancelledBy,
                cancelledAt: new Date().toISOString()
            };

            await db.collection('appointments').doc(appointmentId).update(updateData);

            // Notify the other party about the cancellation
            const notifyUserId = cancelledBy === 'client' ? data?.caregiverId : data?.clientId;
            const notifyName = cancelledBy === 'client' ? data?.clientName : data?.caregiverName;
            if (notifyUserId) {
                try {
                    const reasonLabel = reason || 'No reason given';
                    await db.collection('users').doc(notifyUserId).collection('notifications').add({
                        userId: notifyUserId,
                        type: 'appointment_cancelled',
                        title: 'Appointment Cancelled',
                        message: `${notifyName || 'The other party'} cancelled the appointment on ${data?.date} at ${data?.time}. Reason: ${reasonLabel}.`,
                        data: { appointmentId, cancelledBy, reason },
                        read: false,
                        isRead: false,
                        timestamp: new Date().toISOString(),
                        createdAt: new Date().toISOString()
                    });
                } catch (_) { /* non-critical */ }
            }

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
            if (data?.clientId !== auth.currentUser?.uid && data?.caregiverId !== auth.currentUser?.uid) {
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
            if (data?.clientId !== auth.currentUser?.uid && data?.caregiverId !== auth.currentUser?.uid) {
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
            batch.set(ref, { ...appt, id: ref.id, createdAt: now });
        });
        await batch.commit();

        // Notify caregiver once for the whole series
        const first = appointments[0];
        const n = appointments.length;
        const firstDate = first.date ? new Date(first.date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
        try {
            await db.collection('users').doc(first.caregiverId).collection('notifications').add({
                type: 'booking',
                title: 'New Booking Request',
                message: `${first.clientName} sent a recurring booking request — ${n} date${n !== 1 ? 's' : ''} starting ${firstDate}.`,
                read: false,
                isRead: false,
                timestamp: now,
                createdAt: now,
                data: { recurringGroupId: (first as any).recurringGroupId, clientId: first.clientId },
            });
        } catch { /* non-fatal */ }
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

        // Notify client
        try {
            await db.collection('users').doc(clientId).collection('notifications').add({
                type: 'booking',
                title: 'Booking Confirmed!',
                message: `${caregiverName} accepted your booking request. Your care schedule is confirmed.`,
                read: false,
                isRead: false,
                timestamp: now,
                createdAt: now,
                data: { recurringGroupId },
            });
        } catch { /* non-fatal */ }
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

        // Notify client
        try {
            await db.collection('users').doc(clientId).collection('notifications').add({
                type: 'alert',
                title: 'Booking Declined',
                message: `${caregiverName} is unable to accept your booking request. You can search for another caregiver.`,
                read: false,
                isRead: false,
                timestamp: now,
                createdAt: now,
                data: { recurringGroupId },
            });
        } catch { /* non-fatal */ }
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
                if (e.code === 'permission-denied') return true;
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
                const docSnap = await db.collection('senior_profiles').doc(uid).get();
                if (docSnap.exists) {
                    return { id: 0, uid: docSnap.id, ...docSnap.data() } as unknown as Senior;
                }
                // Try reading from user doc if profile missing
                const userDoc = await db.collection('users').doc(uid).get();
                if (userDoc.exists) {
                    const userData = userDoc.data() as any;
                    return { id: 0, uid, name: userData.name, personality: 'Introvert', needs: [], location: '' } as Senior;
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
                    } as Thread);
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

    getCarePlan: async (uid: string): Promise<CarePlan> => {
        if (isConfigured && db) {
            try {
                const doc = await db.collection('senior_profiles').doc(uid).collection('care_plans').doc('default').get();
                if (doc.exists) return doc.data() as CarePlan;
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
                await db.collection('senior_profiles').doc(uid).collection('care_plans').doc('default').set(plan, { merge: true });
            } catch (e: any) {
                if (e.code === 'permission-denied') return;
            }
        }
    },

    subscribeToCarePlan: (uid: string, onUpdate: (plan: CarePlan) => void) => {
        if (isConfigured && db) {
            const docRef = db.collection('senior_profiles').doc(uid).collection('care_plans').doc('default');
            return docRef.onSnapshot((doc) => {
                if (doc.exists) {
                    onUpdate(doc.data() as CarePlan);
                } else {
                    onUpdate({ medications: [], emergencyContacts: [], dailyRoutine: [] });
                }
            }, (error) => {
                if (error.code === 'permission-denied') {
                    onUpdate({ medications: [], emergencyContacts: [], dailyRoutine: [] });
                }
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
                await db.collection('senior_profiles').doc(uid).collection('care_plans').doc('default').update({
                    dailyRoutine: updatedPlan.dailyRoutine
                });
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

                // Notify the client that someone applied
                if (jobData.clientId) {
                    try {
                        await db.collection('users').doc(jobData.clientId).collection('notifications').add({
                            userId: jobData.clientId,
                            type: 'job_application',
                            title: 'New Job Application',
                            message: `${applicationData.caregiverName} applied to your post: "${jobData.title}".`,
                            data: { jobId, caregiverId },
                            read: false,
                            isRead: false,
                            timestamp: new Date().toISOString(),
                            createdAt: new Date().toISOString()
                        });
                    } catch (_) { /* non-critical */ }
                }

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
     * Subscribe to care journal entries for real-time updates
     */


    // Care Journal Functions - Family Command Center
    createCareJournalEntry: async (entry: CareJournalEntry) => {
        if (!isConfigured || !db) {
            throw new Error("Database not connected");
        }

        try {
            await db.collection('care_journal').doc(entry.id).set({
                ...entry,
                createdAt: new Date().toISOString()
            });

            // Also update appointment to mark as checked in
            await db.collection('appointments').doc(entry.appointmentId).update({
                hasJournalEntry: true,
                lastJournalEntryAt: new Date().toISOString()
            });

            // Send notification to family
            await dbService.notifyFamilyOfCheckIn(entry);

            return entry;
        } catch (error) {
            console.error('Failed to create care journal entry:', error);
            throw new Error('Failed to save care journal entry. Please try again.');
        }
    },

    getHealthSignalsForEntries: async (entryIds: string[]): Promise<Record<string, { severity: string; signals: string[] }>> => {
        if (!isConfigured || !db || entryIds.length === 0) return {};
        try {
            const snap = await db.collection('health_signals')
                .where('journalEntryId', 'in', entryIds.slice(0, 10))
                .get();
            const result: Record<string, { severity: string; signals: string[] }> = {};
            snap.docs.forEach(doc => {
                const d = doc.data();
                if (d.journalEntryId) {
                    result[d.journalEntryId] = { severity: d.severity, signals: d.signals ?? [] };
                }
            });
            return result;
        } catch {
            return {};
        }
    },

    updateCareJournalEntry: async (
        entryId: string,
        updates: Partial<Pick<CareJournalEntry, 'notes' | 'wellness' | 'activities'>>
    ) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        await db.collection('care_journal').doc(entryId).update({
            ...updates,
            updatedAt: new Date().toISOString(),
        });
    },

    deleteCareJournalEntry: async (entryId: string, photoUrls: string[]) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        // Best-effort photo deletion — don't fail if URLs are not real Storage paths
        const storage = getStorage();
        await Promise.allSettled(
            photoUrls.map(url =>
                deleteObject(storageRef(storage, url)).catch(() => {})
            )
        );
        await db.collection('care_journal').doc(entryId).delete();
    },

    getCareJournalEntries: async (seniorId: string, limit: number = 30) => {
        if (!isConfigured || !db) {
            return [];
        }

        try {
            const snapshot = await db.collection('care_journal')
                .where('seniorId', '==', seniorId)
                .orderBy('timestamp', 'desc')
                .limit(limit)
                .get();

            return snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            })) as CareJournalEntry[];
        } catch (error) {
            console.error('Failed to fetch care journal:', error);
            return [];
        }
    },

    subscribeToCareJournal: (seniorId: string, onUpdate: (entries: CareJournalEntry[]) => void) => {
        if (!isConfigured || !db) {
            return () => {};
        }

        // Log view access for HIPAA audit
        const currentUser = auth?.currentUser;
        if (currentUser) {
            db.collection('care_journal_views').add({
                seniorId,
                viewerId: currentUser.uid,
                viewerEmail: currentUser.email,
                viewType: 'subscription',
                timestamp: new Date().toISOString(),
                userAgent: navigator.userAgent
            }).catch(err => console.error('Failed to log view:', err));
        }

        return db.collection('care_journal')
            .where('seniorId', '==', seniorId)
            .orderBy('timestamp', 'desc')
            .limit(50)
            .onSnapshot(snapshot => {
                const entries = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                })) as CareJournalEntry[];
                onUpdate(entries);
            }, error => {
                console.error('Care journal subscription error:', error);
            });
    },

    /**
     * Log individual entry view for HIPAA audit
     */
    logCareJournalView: async (entryId: string, seniorId: string) => {
        if (!isConfigured || !db || !auth?.currentUser) return;

        try {
            await db.collection('care_journal_views').add({
                entryId,
                seniorId,
                viewerId: auth.currentUser.uid,
                viewerEmail: auth.currentUser.email,
                viewType: 'individual',
                timestamp: new Date().toISOString(),
                userAgent: navigator.userAgent
            });
        } catch (error) {
            console.error('Failed to log care journal view:', error);
        }
    },

    notifyFamilyOfCheckIn: async (entry: CareJournalEntry) => {
        // Get senior's profile for name and family members
        const seniorDoc = await db?.collection('senior_profiles').doc(entry.seniorId).get();
        if (!seniorDoc?.exists) return;

        const seniorData = seniorDoc.data() as { 
            name?: string; 
            familyMembers?: { email: string; name: string; phone?: string; userId?: string }[] 
        };
        const seniorName = seniorData?.name || 'Your Loved One';
        const familyMembers = seniorData?.familyMembers || [];

        if (familyMembers.length === 0) return;

        // Get caregiver info
        const caregiverDoc = await db?.collection('caregivers').doc(entry.caregiverId).get();
        const caregiverName = caregiverDoc?.exists 
            ? (caregiverDoc.data() as { name?: string })?.name || 'Caregiver'
            : 'Caregiver';

        // Create in-app notifications
        for (const member of familyMembers) {
            await db?.collection('notifications').add({
                userId: member.userId || member.email,
                type: 'caregiver_check_in',
                title: `${caregiverName} Completed Visit`,
                message: `${caregiverName} checked in after visiting ${seniorName}. ${entry.wellness?.mood === 'great' ? 'Everything went well!' : 'View details for more info.'}`,
                entryId: entry.id,
                seniorId: entry.seniorId,
                timestamp: new Date().toISOString(),
                read: false
            });
        }

        // Send SMS, Email, and Push notifications
        await notifyFamilyOfCheckIn(familyMembers, {
            type: 'caregiver_check_in',
            seniorId: entry.seniorId,
            seniorName,
            caregiverName,
            message: entry.wellness?.mood === 'great' 
                ? 'Everything went well!'
                : 'View the app for more details.',
            data: {
                mood: entry.wellness?.mood,
                activities: entry.activities,
                notes: entry.notes,
                photos: entry.photos,
                entryId: entry.id,
                appUrl: `${window.location.origin}/client`,
                preferencesUrl: `${window.location.origin}/client-profile`
            }
        });
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
        const caregiverDoc = await db?.collection('caregivers').doc(caregiverId).get();
        const caregiverName = caregiverDoc?.exists 
            ? (caregiverDoc.data() as { name?: string })?.name || 'Caregiver'
            : 'Caregiver';

        // Send arrival notifications
        await notifyFamilyOfArrival(familyMembers, seniorName, caregiverName, appointmentTime);
    },

    sendWeeklyDigest: async (seniorId: string, email: string) => {
        // Get senior info
        const seniorDoc = await db?.collection('senior_profiles').doc(seniorId).get();
        if (!seniorDoc?.exists) return;

        const seniorName = (seniorDoc.data() as { name?: string })?.name || 'Your Loved One';

        // Get last 7 days of entries
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);

        const snapshot = await db?.collection('care_journal')
            .where('seniorId', '==', seniorId)
            .where('timestamp', '>=', weekAgo.toISOString())
            .orderBy('timestamp', 'desc')
            .get();

        const entries = snapshot?.docs.map(doc => doc.data()) as CareJournalEntry[] || [];

        if (entries.length === 0) return;

        // Calculate stats
        const { sendWeeklyDigest } = await import('./notificationService');
        await sendWeeklyDigest(email, seniorName, {
            visitsCount: entries.length,
            totalHours: Math.round(entries.length * 3), // Estimate 3 hours per visit
            avgMood: entries[0]?.wellness?.mood || 'good',
            highlights: entries.slice(0, 3).map(e => 
                `${e.activities?.join(', ') || 'Care visit'} - ${e.wellness?.mood === 'great' ? 'Great day!' : 'Good care provided'}`
            ),
            photosCount: entries.reduce((sum, e) => sum + (e.photos?.length || 0), 0)
        });
    },

    /**
     * Get caregivers pending verification (for admin dashboard)
     */
    getCaregiversForVerification: async (status: string = 'submitted') => {
        if (!isConfigured || !db) {
            return [];
        }

        try {
            let query: firebase.firestore.Query = db.collection('caregivers');

            if (status !== 'all') {
                // 'pending' in the UI maps to 'submitted' in Firestore (set when caregiver finishes signup)
                const firestoreStatus = status === 'pending' ? 'submitted' : status;
                query = query.where('verificationStatus', '==', firestoreStatus);
            }

            const snapshot = await query
                .orderBy('submittedAt', 'desc')
                .limit(100)
                .get();

            return snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
        } catch (error) {
            console.error('Failed to fetch caregivers for verification:', error);
            return [];
        }
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

    /**
     * Get referral stats for user
     */
    getReferralStats: async (userId: string) => {
        if (!isConfigured || !db) {
            return {
                totalReferrals: 0,
                successfulReferrals: 0,
                pendingReferrals: 0,
                totalEarnings: 0,
                referralCode: ''
            };
        }

        try {
            // Get user's referral code
            const userDoc = await db.collection('users').doc(userId).get();
            const userData = userDoc.data();
            const referralCode = userData?.referralCode || generateReferralCode();

            // If no code exists, create one
            if (!userData?.referralCode) {
                await db.collection('users').doc(userId).update({ referralCode });
            }

            // Get referrals
            const referralsSnapshot = await db.collection('referrals')
                .where('referrerId', '==', userId)
                .get();

            const referrals = referralsSnapshot.docs.map(doc => doc.data());
            const successful = referrals.filter(r => r.status === 'successful');

            return {
                totalReferrals: referrals.length,
                successfulReferrals: successful.length,
                pendingReferrals: referrals.filter(r => r.status === 'pending').length,
                totalEarnings: successful.reduce((sum, r) => sum + (r.reward || 0), 0),
                referralCode
            };
        } catch (error) {
            console.error('Failed to get referral stats:', error);
            return {
                totalReferrals: 0,
                successfulReferrals: 0,
                pendingReferrals: 0,
                totalEarnings: 0,
                referralCode: ''
            };
        }
    },

    /**
     * Get user's referrals list
     */
    getReferrals: async (userId: string) => {
        if (!isConfigured || !db) {
            return [];
        }

        try {
            const snapshot = await db.collection('referrals')
                .where('referrerId', '==', userId)
                .orderBy('createdAt', 'desc')
                .get();

            return snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
        } catch (error) {
            console.error('Failed to get referrals:', error);
            return [];
        }
    },

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
            // Find referrer
            const referrerSnapshot = await db.collection('users')
                .where('referralCode', '==', referralCode)
                .limit(1)
                .get();

            if (referrerSnapshot.empty) return;

            const referrerId = referrerSnapshot.docs[0].id;

            // Update referral record
            const referralSnapshot = await db.collection('referrals')
                .where('referralCode', '==', referralCode)
                .where('referredId', '==', null)
                .limit(1)
                .get();

            if (!referralSnapshot.empty) {
                await referralSnapshot.docs[0].ref.update({
                    referredId: newUserId,
                    status: 'pending', // Will be 'successful' after first booking
                    updatedAt: new Date().toISOString()
                });
            }

            // Add referral credit to new user
            await db.collection('users').doc(newUserId).update({
                referralCode: generateReferralCode(),
                referredBy: referrerId,
                referralCredit: 25 // $25 credit
            });
        } catch (error) {
            console.error('Failed to process referral:', error);
        }
    },

    // ==================== PHASE 2 FEATURES ====================

    // --- VIDEO UPDATES / MEDIA GALLERY ---

    createMediaUpdate: async (data: {
        appointmentId: string;
        clientId: string;
        caregiverId: string;
        caregiverName: string;
        media: { url: string; path: string; type: string }[];
        caption: string;
        timestamp: string;
    }) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        const docRef = await db.collection('media_updates').add({
            ...data,
            createdAt: new Date().toISOString()
        });
        return docRef.id;
    },

    getMediaForClient: async (clientId: string): Promise<any[]> => {
        if (!isConfigured || !db) return [];
        
        try {
            const snap = await db.collection('media_updates')
                .where('clientId', '==', clientId)
                .orderBy('timestamp', 'desc')
                .limit(100)
                .get();
            
            return snap.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
        } catch (e) {
            console.error('Failed to fetch media:', e);
            return [];
        }
    },

    subscribeToMediaUpdates: (clientId: string, onUpdate: (item: any) => void) => {
        if (!isConfigured || !db) return () => {};
        
        return db.collection('media_updates')
            .where('clientId', '==', clientId)
            .orderBy('timestamp', 'desc')
            .limit(1)
            .onSnapshot(snap => {
                snap.docChanges().forEach(change => {
                    if (change.type === 'added') {
                        onUpdate({ id: change.doc.id, ...change.doc.data() });
                    }
                });
            });
    },

    notifyFamilyOfMediaUpdate: async (data: {
        clientId: string;
        caregiverName: string;
        mediaCount: number;
        appointmentId: string;
    }) => {
        if (!isConfigured || !db) return;

        // Create notification
        await db.collection('notifications').add({
            userId: data.clientId,
            type: 'media_update',
            title: 'New Care Update!',
            message: `${data.caregiverName} shared ${data.mediaCount} new photo${data.mediaCount > 1 ? 's' : ''} from today's visit.`,
            appointmentId: data.appointmentId,
            timestamp: new Date().toISOString(),
            read: false
        });
    },

    likeMedia: async (mediaId: string) => {
        if (!isConfigured || !db) return;
        await db.collection('media_updates').doc(mediaId).update({
            likes: firebase.firestore.FieldValue.increment(1)
        });
    },

    addComment: async (data: { mediaId: string; text: string; timestamp: string }) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        const user = auth?.currentUser;
        const comment = {
            id: Date.now().toString(),
            authorName: user?.displayName || 'Family Member',
            text: data.text,
            timestamp: data.timestamp
        };
        
        await db.collection('media_updates').doc(data.mediaId).update({
            comments: firebase.firestore.FieldValue.arrayUnion(comment)
        });
        
        return comment;
    },

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

    getCaregiverOfMonth: async (): Promise<any | null> => {
        if (!isConfigured || !db) return null;
        
        try {
            const snap = await db.collection('caregiver_of_month')
                .orderBy('year', 'desc')
                .orderBy('month', 'desc')
                .limit(1)
                .get();
            
            if (!snap.empty) return snap.docs[0].data();
            return null;
        } catch (e) {
            return null;
        }
    },

    getPeerRecognitions: async (caregiverId: string): Promise<any[]> => {
        if (!isConfigured || !db) return [];
        
        try {
            const snap = await db.collection('peer_recognitions')
                .where('toCaregiverId', '==', caregiverId)
                .orderBy('createdAt', 'desc')
                .limit(20)
                .get();
            
            return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        } catch (e) {
            return [];
        }
    },

    givePeerRecognition: async (data: {
        caregiverId: string;
        category: string;
        message: string;
    }) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        const user = auth?.currentUser;
        if (!user) throw new Error("Not authenticated");
        
        const recognition = {
            fromCaregiverId: user.uid,
            fromName: user.displayName || 'Anonymous',
            toCaregiverId: data.caregiverId,
            category: data.category,
            message: data.message,
            createdAt: new Date().toISOString()
        };
        
        await db.collection('peer_recognitions').add(recognition);
    },

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
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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
            approvedBy: auth.currentUser?.uid,
            status: 'pre_confirmed'
        };
        
        await db.collection('match_assignments').doc(assignmentId).update({
            approvedMatches: firebase.firestore.FieldValue.arrayUnion(approvedMatch)
        });
    },

    sendMatchesToClient: async (assignmentId: string, clientId: string) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        const assignment = await db.collection('match_assignments').doc(assignmentId).get();
        const data = assignment.data();
        
        if (!data || data.approvedMatches.length < 5) {
            throw new Error("Need 5 pre-confirmed matches before sending to client");
        }
        
        // Copy approved matches to client's subcollection
        const batch = db.batch();
        
        data.approvedMatches.forEach((match: any, index: number) => {
            const matchRef = db.collection('users').doc(clientId).collection('approved_matches').doc();
            batch.set(matchRef, {
                ...match,
                assignmentId,
                priority: index + 1
            });
        });
        
        // Update assignment status
        batch.update(db.collection('match_assignments').doc(assignmentId), {
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
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    },

    updateInterviewRequest: async (requestId: string, updates: any) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        await db.collection('interview_requests').doc(requestId).update(updates);
    },

    getMatchScoreForCaregiver: async (caregiverId: string, clientPhone: string): Promise<any | null> => {
        if (!isConfigured || !db) return null;
        const snap = await db.collection('interview_requests')
            .where('caregiverId', '==', caregiverId)
            .where('clientPhone', '==', clientPhone)
            .orderBy('createdAt', 'desc')
            .limit(1)
            .get();
        if (snap.empty) return null;
        return snap.docs[0].data().matchScore ?? null;
    },

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
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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
        
        // TODO: Notify caregiver
    },


    getShiftHistory: async (caregiverId: string, clientId: string, limit: number = 30) => {
        if (!isConfigured || !db) return [];
        
        const snapshot = await db.collection('shifts')
            .where('caregiverId', '==', caregiverId)
            .where('clientId', '==', clientId)
            .orderBy('timestamp', 'desc')
            .limit(limit)
            .get();
        
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    },

    // ==========================================
    // TIMESHEET / HOURS APPROVAL
    // ==========================================

    submitTimesheet: async (data: {
        caregiverId: string;
        clientId: string;
        weekStart: string;
        weekEnd: string;
        dailyHours: any[];
        totalHours: number;
        hourlyRate: number;
        totalPay: number;
        notes?: string;
    }) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        const timesheetRef = db.collection('timesheets').doc();
        
        // Calculate auto-approve time (2 days from now)
        const autoApproveAt = new Date();
        autoApproveAt.setDate(autoApproveAt.getDate() + 2);
        
        await timesheetRef.set({
            ...data,
            id: timesheetRef.id,
            status: 'pending',
            submittedAt: new Date().toISOString(),
            autoApproveAt: autoApproveAt.toISOString(),
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        return timesheetRef.id;
    },

    getClientTimesheets: async (clientId: string) => {
        if (!isConfigured || !db) return [];
        
        const snapshot = await db.collection('timesheets')
            .where('clientId', '==', clientId)
            .orderBy('submittedAt', 'desc')
            .get();
        
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    },

    getCaregiverTimesheets: async (caregiverId: string) => {
        if (!isConfigured || !db) return [];
        
        const snapshot = await db.collection('timesheets')
            .where('caregiverId', '==', caregiverId)
            .orderBy('submittedAt', 'desc')
            .get();
        
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    },

    approveTimesheet: async (timesheetId: string, approvalData: {
        approvedAt: string;
        approvedBy: string;
    }) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        await db.collection('timesheets').doc(timesheetId).update({
            status: 'approved',
            ...approvalData,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    },

    disputeTimesheet: async (timesheetId: string, disputeData: {
        disputedAt: string;
        disputeReason: string;
        disputedDays: string[];
    }) => {
        if (!isConfigured || !db) throw new Error("Database not connected");
        
        await db.collection('timesheets').doc(timesheetId).update({
            status: 'disputed',
            ...disputeData,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    },

    autoApproveTimesheet: async (timesheetId: string) => {
        if (!isConfigured || !db) throw new Error("Database not connected");

        await db.collection('timesheets').doc(timesheetId).update({
            status: 'auto_approved',
            autoApprovedAt: new Date().toISOString(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    },

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

};

export const stripeService = externalStripeService;
// Export storageService for convenience
export { storageService };

// authService is an alias for dbService
export { dbService as authService };

// Explicit export to prevent tree-shaking
export const subscribeToMediaUpdates = dbService.subscribeToMediaUpdates;

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
    submit: async (appointmentId: string, startTime: string, endTime: string) => {
        if (!isConfigured) throw new Error('Firebase not configured');
        const fn = functions.httpsCallable('submitShiftHours');
        const res = await fn({ appointmentId, startTime, endTime });
        return res.data as { success: boolean; appointmentId: string; totalHours: number };
    },

    review: async (
        appointmentId: string,
        action: 'approve' | 'propose_correction',
        proposed?: { startTime: string; endTime: string; reason?: string }
    ) => {
        if (!isConfigured) throw new Error('Firebase not configured');
        const fn = functions.httpsCallable('reviewShiftHours');
        const res = await fn({
            appointmentId,
            action,
            proposedStartTime: proposed?.startTime,
            proposedEndTime: proposed?.endTime,
            proposalReason: proposed?.reason,
        });
        return res.data as { success: boolean };
    },

    respondToCorrection: async (appointmentId: string, action: 'accept' | 'reject') => {
        if (!isConfigured) throw new Error('Firebase not configured');
        const fn = functions.httpsCallable('respondToCorrection');
        const res = await fn({ appointmentId, action });
        return res.data as { success: boolean };
    },

    adminResolve: async (appointmentId: string, finalStartTime: string, finalEndTime: string, note?: string) => {
        if (!isConfigured) throw new Error('Firebase not configured');
        const fn = functions.httpsCallable('adminResolveShiftHours');
        const res = await fn({ appointmentId, finalStartTime, finalEndTime, note });
        return res.data as { success: boolean };
    },

    retryPayment: async (appointmentId: string) => {
        if (!isConfigured) throw new Error('Firebase not configured');
        const fn = functions.httpsCallable('retryShiftPayment');
        const res = await fn({ appointmentId });
        return res.data as { success: boolean; error?: string };
    },

    updateBookingPaymentMethod: async (appointmentId: string, paymentMethod: 'cash' | 'credit') => {
        if (!isConfigured) throw new Error('Firebase not configured');
        const fn = functions.httpsCallable('updateBookingPaymentMethod');
        const res = await fn({ appointmentId, paymentMethod });
        return res.data as { success: boolean };
    },

    subscribeForCaregiver: (caregiverId: string, cb: (rows: any[]) => void) => {
        if (!isConfigured || !db) { cb([]); return () => {}; }
        return db.collection('shiftHours')
            .where('caregiverId', '==', caregiverId)
            .orderBy('submittedAt', 'desc')
            .onSnapshot(snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    },

    subscribeForClient: (clientId: string, cb: (rows: any[]) => void) => {
        if (!isConfigured || !db) { cb([]); return () => {}; }
        return db.collection('shiftHours')
            .where('clientId', '==', clientId)
            .orderBy('submittedAt', 'desc')
            .onSnapshot(snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
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

    // Critical write — throw if this fails
    await db.collection('job_postings').doc(uid).set({
        ...clean,
        clientId: uid,
        status: 'active',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    // Best-effort writes — don't block wizard completion if they fail
    const profileUpdate: Record<string, any> = {
        careNeeds: clean.careNeeds,
        scheduleNeeded: clean.selectedDays,
        zipCode: clean.zipCode,
    };
    if (clean.city && clean.state) profileUpdate.location = `${clean.city}, ${clean.state}`;
    if (clean.careRecipientFirstName) profileUpdate.firstName = clean.careRecipientFirstName;
    if (clean.careRecipientLastName)  profileUpdate.lastName  = clean.careRecipientLastName;
    if (clean.adultsCount) profileUpdate.adultsCount = clean.adultsCount;
    if (clean.photoURL) profileUpdate.imageUrl = clean.photoURL;
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
