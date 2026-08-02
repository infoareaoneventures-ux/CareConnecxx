import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { dbService, authService } from '../services/api';
import { notificationService } from '../services/notifications';
import { pushNotificationService } from '../services/pushNotificationService';
import { setSentryUser } from '../lib/sentry';
import { isConfigured, db } from '../lib/firebase';
import firebase from 'firebase/compat/app';
import { Appointment, Caregiver, EmergencyAlert, ToastMessage, ToastType, User, UserProfile } from '../types';
import { EmergencyAlertBanner } from '../components/EmergencyAlertBanner';
import { resetChildcareAccessCache } from '../components/shared/childcareAccess';

/**
 * Extended user with profile data from Firestore
 * Combines Firebase Auth User with app-specific profile
 */
export interface AuthenticatedUser {
    uid: string;
    email: string | null;
    displayName: string | null;
    photoURL: string | null;
    userType: 'client' | 'caregiver' | 'admin';
    isVerified?: boolean;
    phone?: string;
}

export type AuthRecoveryKind = 'offline' | 'unauthenticated' | 'unauthorized' | 'unavailable';

export interface AuthRecoveryState {
    kind: AuthRecoveryKind;
    message: string;
}

interface CareConnexContextType {
    currentUser: AuthenticatedUser | null;
    caregiverProfile: Caregiver | null;
    refreshCaregiverProfile: () => Promise<void>;
    appointments: Appointment[];
    caregivers: Caregiver[];
    isLoading: boolean;
    authResolved: boolean;
    authRecovery: AuthRecoveryState | null;
    retryAuth: () => void;
    signOutFromRecovery: () => Promise<void>;
    toasts: ToastMessage[];
    addToast: (message: string, type: ToastType) => void;
    removeToast: (id: string) => void;
    bookAppointment: (appointment: Appointment) => Promise<void>;
    completePayment: (appointmentId: string) => void;
    submitReview: (appointmentId: string) => void;
    blockedIds: Set<string>;
    blockedUserProfiles: Record<string, { name: string; photo: string }>;
    unblockUser: (targetId: string) => Promise<void>;
    membershipModalOpen: boolean;
    setMembershipModalOpen: (v: boolean) => void;
}

const CareConnexContext = createContext<CareConnexContextType | undefined>(undefined);

export const CareConnexProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [currentUser, setCurrentUser] = useState<AuthenticatedUser | null>(null);
    const [caregiverProfile, setCaregiverProfile] = useState<Caregiver | null>(null);
    const [appointments, setAppointments] = useState<Appointment[]>([]);
    const [caregivers, setCaregivers] = useState<Caregiver[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [authResolved, setAuthResolved] = useState(false);
    const [authRecovery, setAuthRecovery] = useState<AuthRecoveryState | null>(null);
    const [authRetryNonce, setAuthRetryNonce] = useState(0);
    const [toasts, setToasts] = useState<ToastMessage[]>([]);
    const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());
    const [blockedUserProfiles, setBlockedUserProfiles] = useState<Record<string, { name: string; photo: string }>>({});
    const [membershipModalOpen, setMembershipModalOpen] = useState(false);
    const [emergencyAlerts, setEmergencyAlerts] = useState<EmergencyAlert[]>([]);
    const [dismissedAlertIds, setDismissedAlertIds] = useState<Set<string>>(new Set());

    // Auth Listener - fetches user profile from Firestore to get userType
    useEffect(() => {
        let cancelled = false;
        const delays = [0, 1000, 3000];
        const fetchProfileWithRetry = async (uid: string) => {
            let lastError: unknown = new Error('Profile unavailable');
            for (const delayMs of delays) {
                if (delayMs) await new Promise(r => setTimeout(r, delayMs));
                try {
                    const profile = await Promise.race([
                        dbService.getUser(uid),
                        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Profile request timed out')), 3000)),
                    ]);
                    if (profile) return profile;
                    lastError = Object.assign(new Error('Profile not found'), { code: 'not-found' });
                } catch (error) {
                    lastError = error;
                }
            }
            throw lastError;
        };

        const recoveryFor = (error: unknown): AuthRecoveryState => {
            const code = String((error as any)?.code ?? '');
            if (typeof navigator !== 'undefined' && !navigator.onLine) {
                return { kind: 'offline', message: 'You appear to be offline. Reconnect, then try again.' };
            }
            if (code.includes('permission-denied')) {
                return { kind: 'unauthorized', message: 'Your account cannot access its profile. Please sign out and contact support.' };
            }
            if (!authService.getCurrentUser()) {
                return { kind: 'unauthenticated', message: 'Your sign-in session expired. Sign out and sign in again.' };
            }
            return { kind: 'unavailable', message: 'We could not load your account profile. Your role was not changed. Please try again.' };
        };

        const unsubscribe = authService.onAuthStateChanged(async (firebaseUser) => {
            if (cancelled) return;
            setAuthRecovery(null);
            if (firebaseUser) {
                const cachedRole = localStorage.getItem(`evia:last-role:${firebaseUser.uid}`);
                if (cachedRole === 'client' || cachedRole === 'caregiver' || cachedRole === 'admin') {
                    setCurrentUser({
                        uid: firebaseUser.uid,
                        email: firebaseUser.email,
                        displayName: firebaseUser.displayName,
                        photoURL: firebaseUser.photoURL,
                        userType: cachedRole,
                    });
                }
                // Fetch user profile from Firestore to get userType.
                // Retry because onAuthStateChanged fires before signup Firestore writes complete.
                try {
                    const profile = await fetchProfileWithRetry(firebaseUser.uid);
                    const validUserTypes = ['client', 'caregiver', 'admin'] as const;
                    if (!profile?.userType || !validUserTypes.includes(profile.userType)) {
                        throw Object.assign(new Error('Profile has no valid role'), { code: 'invalid-role' });
                    }
                    const userType = profile.userType;
                    // Auth displayName is unset for phone-OTP signups; the SMS
                    // onboarding writes the name to the users doc instead
                    // (clients: firstName, caregivers: name) — fall back to it
                    // so the dashboard never greets by email prefix. Client
                    // profiles are merged with senior_profiles in getUser, so
                    // their `name` is the CARE RECIPIENT's — use firstName only.
                    const profileName = userType === 'client'
                        ? ((profile as any)?.firstName || null)
                        : ((profile as any)?.name || (profile as any)?.firstName || null);
                    const authenticatedUser: AuthenticatedUser = {
                        uid: firebaseUser.uid,
                        email: firebaseUser.email,
                        displayName: firebaseUser.displayName || profileName,
                        photoURL: firebaseUser.photoURL,
                        userType,
                        isVerified: profile?.verified ?? false,
                        phone: profile?.phone
                    };
                    if (cancelled) return;
                    setCurrentUser(authenticatedUser);
                    localStorage.setItem(`evia:last-role:${firebaseUser.uid}`, userType);
                    if (userType === 'caregiver' && profile) setCaregiverProfile(profile as any);
                    setSentryUser({ uid: authenticatedUser.uid, email: authenticatedUser.email });

                    // Initialize push notifications for logged in user
                    if (authenticatedUser.uid) {
                        pushNotificationService.initialize(authenticatedUser.uid).catch(err => {
                            console.log('Push notification init failed (non-critical):', err);
                        });
                    }
                } catch (error) {
                    console.error('Failed to fetch user profile:', error);
                    if (cancelled) return;
                    setAuthRecovery(recoveryFor(error));
                }
            } else {
                setCurrentUser(null);
                setCaregiverProfile(null);
                setSentryUser(null);
                pushNotificationService.removeToken('').catch(() => {});
            }
            if (!cancelled) setAuthResolved(true);
        });

        return () => {
            cancelled = true;
            if (unsubscribe) unsubscribe();
        };
    }, [authRetryNonce]);

    // Childcare access summaries are principal-bound. Token refresh, login,
    // logout, and account switching invalidate both settled and in-flight
    // entries before any child-derived state can be reused.
    useEffect(() => {
        if (!isConfigured || !authService.onIdTokenChanged) return;
        return authService.onIdTokenChanged(() => resetChildcareAccessCache());
    }, []);

    const retryAuth = () => {
        setAuthResolved(false);
        setAuthRecovery(null);
        setAuthRetryNonce(value => value + 1);
    };

    const signOutFromRecovery = async () => {
        await dbService.logout();
        setAuthRecovery(null);
        setCurrentUser(null);
    };

    const refreshCaregiverProfile = async () => {
        if (currentUser?.uid) {
            const p = await dbService.getUser(currentUser.uid);
            if (p) setCaregiverProfile(p as any);
        }
    };

    // Real-time listener: keep caregiverProfile in sync with Firestore
    // so admin changes (membership, bg check, docs) reflect immediately
    useEffect(() => {
        if (!currentUser?.uid || currentUser.userType !== 'caregiver' || !db) return;
        const unsub = db.collection('caregivers').doc(currentUser.uid)
            .onSnapshot(snap => {
                if (snap.exists) setCaregiverProfile({ id: snap.id, ...snap.data() } as any);
            }, () => {});
        return unsub;
    }, [currentUser?.uid, currentUser?.userType]);

    const addToast = (message: string, type: ToastType) => {
        const id = Math.random().toString(36).substr(2, 9);
        setToasts((prev) => [...prev, { id, message, type }]);
    };

    const removeToast = (id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    };

    // Initialize Data
    useEffect(() => {
        let cancelled = false;

        const initBackend = async () => {
            try {
                if (isConfigured) {
                    try {
                        const isConnected = await dbService.verifyConnection();
                        if (cancelled) return;
                        if (isConnected) {
                            console.log("Database connected");
                        } else {
                            addToast("Warning: Database connection unstable", "error");
                        }
                    } catch (connErr) {
                        if (cancelled) return;
                        console.error("Database connection check failed:", connErr);
                    }
                } else {
                    addToast("Backend not configured. Check Firebase setup.", "error");
                }

            } finally {
                if (!cancelled) {
                    setIsLoading(false);
                }
            }
        };

        initBackend();

        // Subscribe to notifications
        const unsubNotifications = notificationService.onNotification((notif) => {
            addToast(notif.body, 'info');
        });

        return () => { 
            cancelled = true;
            unsubNotifications();
            notificationService.stopSimulation();
        };
    }, []); // Only run once on mount

    // Fetch caregiver list only for client/admin users
    useEffect(() => {
        if (!currentUser || currentUser.userType === 'caregiver') return;
        dbService.getCaregivers(100)
            .then(({ caregivers: fetched }) => setCaregivers(fetched))
            .catch(e => console.error("Failed to fetch caregivers", e));
    }, [currentUser?.uid, currentUser?.userType]);

    // BUG FIX: Separate useEffect for appointment subscription
    // This prevents memory leaks and ensures proper cleanup
    useEffect(() => {
        if (!currentUser) {
            setAppointments([]); // Clear appointments when logged out
            return;
        }

        console.log('[Evia] Subscribing to appointments for', currentUser.uid);
        
        const unsubscribe = dbService.subscribeToAppointments(
            currentUser.uid,
            currentUser.userType === 'admin' ? 'client' : currentUser.userType,
            (updatedAppts) => {
                setAppointments(updatedAppts);
            }
        );

        return () => {
            console.log('[Evia] Unsubscribing from appointments');
            unsubscribe();
        };
    }, [currentUser?.uid, currentUser?.userType]); // Only re-subscribe when user changes

    // U2: Live caregiver-profile listener. Evia writes to caregivers/{uid}
    // during onboarding/profile edits/verification; this keeps the caregiver
    // dashboard fresh without a logout/login. Per KTD-4, the listener updates
    // context state unconditionally — consuming edit forms hold their in-progress
    // state locally so a snapshot doesn't clobber unsaved input.
    useEffect(() => {
        if (!currentUser || currentUser.userType !== 'caregiver') return;

        const unsubscribe = dbService.subscribeToCaregiverProfile(
            currentUser.uid,
            (caregiverData) => {
                if (!caregiverData) return; // keep last-known if the doc/read is unavailable
                setCaregiverProfile(prev => ({
                    ...(prev as any),
                    ...caregiverData,
                    userType: 'caregiver',
                }) as any);
            }
        );

        return () => unsubscribe();
    }, [currentUser?.uid, currentUser?.userType]);

    // U3: Live user-doc listener. Surfaces agent-driven changes to verification
    // status / account state on currentUser without a reload (beyond the one-shot
    // getUser at auth time). users/{uid} read rule already exists.
    useEffect(() => {
        if (!currentUser?.uid) return;

        const unsubscribe = dbService.subscribeToUser(currentUser.uid, (data) => {
            if (!data) return; // keep last-known if unavailable
            setCurrentUser(prev => {
                if (!prev) return prev;
                const validUserTypes = ['client', 'caregiver', 'admin'] as const;
                const nextType = typeof data.userType === 'string' && (validUserTypes as readonly string[]).includes(data.userType)
                    ? (data.userType as AuthenticatedUser['userType'])
                    : prev.userType;
                return {
                    ...prev,
                    userType: nextType,
                    isVerified: (data.verified as boolean | undefined) ?? prev.isVerified,
                    phone: (data.phone as string | undefined) ?? prev.phone,
                };
            });
        });

        return () => unsubscribe();
    }, [currentUser?.uid]);

    const bookAppointment = async (appointment: Appointment) => {
        try {
            setAppointments(prev => [...prev, appointment]); // Optimistic
            await dbService.createAppointment(appointment);
            // Success toast is shown in ClientDashboard, not here
        } catch (error: unknown) {
            console.error("Booking failed:", error);

            // Revert optimistic update
            setAppointments(prev => prev.filter(a => a.id !== appointment.id));

            // Show specific error message
            const errorMessage = error instanceof Error ? error.message : '';
            if (errorMessage.includes('Database not connected')) {
                addToast("Unable to connect to server. Please check your internet connection.", 'error');
            } else if (errorMessage.includes('permission-denied')) {
                addToast("Permission denied. Please sign in again.", 'error');
            } else {
                addToast("Booking saved locally but failed to sync. We'll retry automatically.", 'error');
            }
        }
    };

    const completePayment = (appointmentId: string) => {
        setAppointments(prev => prev.map(a =>
            a.id === appointmentId ? { ...a, paymentStatus: 'paid' } : a
        ));
        addToast("Payment processing confirmed", 'success');
    };

    const submitReview = (appointmentId: string) => {
        setAppointments(prev => prev.map(a =>
            a.id === appointmentId ? { ...a, hasReview: true } : a
        ));
    };

    // Live emergency_alerts listener. Both the EmergencySOS UI and the agent's
    // trigger_emergency_alert MCP tool write this collection; this surfaces an
    // active alert as an in-app banner (see EmergencyAlertBanner below) instead
    // of relying solely on the push/SMS fan-out. Scope note: the subscription
    // (and the firestore.rules read rule) is initiator-scoped. Household members
    // are notified via server fan-out (notifiedContacts holds phone numbers, not
    // uids), so a household-wide client query is not supportable by the current
    // rules/data shape.
    useEffect(() => {
        if (!currentUser?.uid) {
            setEmergencyAlerts([]);
            setDismissedAlertIds(new Set());
            return;
        }
        const unsubscribe = dbService.subscribeToEmergencyAlerts(currentUser.uid, setEmergencyAlerts);
        return () => unsubscribe();
    }, [currentUser?.uid]);

    // Subscribe to blocked users list
    useEffect(() => {
        if (!currentUser?.uid || !db) { setBlockedIds(new Set()); setBlockedUserProfiles({}); return; }
        const unsub = db.collection('users').doc(currentUser.uid)
            .onSnapshot(snap => {
                const data = snap.data() as any;
                setBlockedIds(new Set(data?.blockedUsers || []));
                setBlockedUserProfiles(data?.blockedUserProfiles || {});
            }, () => {});
        return unsub;
    }, [currentUser?.uid]);

    const unblockUser = async (targetId: string) => {
        if (!currentUser?.uid || !db) return;
        const userRef = db.collection('users').doc(currentUser.uid);
        // Split into two updates — mixing arrayRemove + FieldValue.delete on nested fields can reject
        await userRef.update({
            blockedUsers: firebase.firestore.FieldValue.arrayRemove(targetId),
        });
        await userRef.update({
            [`blockedUserProfiles.${targetId}`]: firebase.firestore.FieldValue.delete(),
        }).catch(() => {}); // field may not exist on legacy blocks — safe to ignore
        // Hide the room from the unblocking user until a new message arrives.
        // Also set messagesCutoff so messages sent while blocked stay hidden after unblock.
        try {
            const roomId = [currentUser.uid, targetId].sort().join('_');
            const roomSnap = await db.collection('chatRooms').doc(roomId).get();
            if (roomSnap.exists) {
                await db.collection('chatRooms').doc(roomId).update({
                    [`messagesCutoff.${currentUser.uid}`]: firebase.firestore.FieldValue.serverTimestamp(),
                    [`deletedAt.${currentUser.uid}`]: firebase.firestore.FieldValue.serverTimestamp(),
                });
            }
        } catch {
            // chatRoom update failing should not block the unblock itself
        }
    };

    return (
        <CareConnexContext.Provider value={{
            currentUser,
            caregiverProfile,
            refreshCaregiverProfile,
            appointments,
            caregivers,
            isLoading,
            authResolved,
            authRecovery,
            retryAuth,
            signOutFromRecovery,
            toasts,
            addToast,
            removeToast,
            bookAppointment,
            completePayment,
            submitReview,
            blockedIds,
            blockedUserProfiles,
            unblockUser,
            membershipModalOpen,
            setMembershipModalOpen,
        }}>
            <EmergencyAlertBanner
                alerts={emergencyAlerts.filter(a => !dismissedAlertIds.has(a.id))}
                onDismiss={(alertId) => setDismissedAlertIds(prev => {
                    const next = new Set(prev);
                    next.add(alertId);
                    return next;
                })}
            />
            {children}
        </CareConnexContext.Provider>
    );
};

export const useCareConnex = () => {
    const context = useContext(CareConnexContext);
    if (context === undefined) {
        throw new Error('useCareConnex must be used within a CareConnexProvider');
    }
    return context;
};
