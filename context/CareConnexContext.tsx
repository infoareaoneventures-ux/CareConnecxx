import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { dbService, authService } from '../services/api';
import { notificationService } from '../services/notifications';
import { pushNotificationService } from '../services/pushNotificationService';
import { setSentryUser } from '../lib/sentry';
import { isConfigured } from '../lib/firebase';
import { Appointment, Caregiver, ToastMessage, ToastType, User, UserProfile } from '../types';

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

interface CareConnexContextType {
    currentUser: AuthenticatedUser | null;
    caregiverProfile: Caregiver | null;
    refreshCaregiverProfile: () => Promise<void>;
    appointments: Appointment[];
    caregivers: Caregiver[];
    isLoading: boolean;
    authResolved: boolean;
    toasts: ToastMessage[];
    addToast: (message: string, type: ToastType) => void;
    removeToast: (id: string) => void;
    bookAppointment: (appointment: Appointment) => Promise<void>;
    completePayment: (appointmentId: string) => void;
    submitReview: (appointmentId: string) => void;
}

const CareConnexContext = createContext<CareConnexContextType | undefined>(undefined);

export const CareConnexProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [currentUser, setCurrentUser] = useState<AuthenticatedUser | null>(null);
    const [caregiverProfile, setCaregiverProfile] = useState<Caregiver | null>(null);
    const [appointments, setAppointments] = useState<Appointment[]>([]);
    const [caregivers, setCaregivers] = useState<Caregiver[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [authResolved, setAuthResolved] = useState(false);
    const [toasts, setToasts] = useState<ToastMessage[]>([]);

    // Auth Listener - fetches user profile from Firestore to get userType
    useEffect(() => {
        const fetchProfileWithRetry = async (uid: string, attempts = 3, delayMs = 400) => {
            for (let i = 0; i < attempts; i++) {
                const profile = await dbService.getUser(uid);
                if (profile) return profile;
                if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
            }
            return null;
        };

        const unsubscribe = authService.onAuthStateChanged(async (firebaseUser) => {
            if (firebaseUser) {
                // Fetch user profile from Firestore to get userType.
                // Retry because onAuthStateChanged fires before signup Firestore writes complete.
                try {
                    const profile = await fetchProfileWithRetry(firebaseUser.uid);
                    const validUserTypes = ['client', 'caregiver', 'admin'] as const;
                    const userType = profile?.userType && validUserTypes.includes(profile.userType)
                        ? profile.userType
                        : 'client';
                    const authenticatedUser: AuthenticatedUser = {
                        uid: firebaseUser.uid,
                        email: firebaseUser.email,
                        displayName: firebaseUser.displayName,
                        photoURL: firebaseUser.photoURL,
                        userType,
                        isVerified: profile?.verified ?? false,
                        phone: profile?.phone
                    };
                    setCurrentUser(authenticatedUser);
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
                    setCurrentUser({
                        uid: firebaseUser.uid,
                        email: firebaseUser.email,
                        displayName: firebaseUser.displayName,
                        photoURL: firebaseUser.photoURL,
                        userType: 'client'
                    });
                }
            } else {
                setCurrentUser(null);
                setCaregiverProfile(null);
                setSentryUser(null);
                pushNotificationService.removeToken('').catch(() => {});
            }
            setAuthResolved(true);
        });

        return () => {
            if (unsubscribe) unsubscribe();
        };
    }, []);

    const refreshCaregiverProfile = async () => {
        if (currentUser?.uid) {
            const p = await dbService.getUser(currentUser.uid);
            if (p) setCaregiverProfile(p as any);
        }
    };

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

        console.log('[CareConnex] Subscribing to appointments for', currentUser.uid);
        
        const unsubscribe = dbService.subscribeToAppointments(
            currentUser.uid,
            currentUser.userType === 'admin' ? 'client' : currentUser.userType,
            (updatedAppts) => {
                setAppointments(updatedAppts);
            }
        );

        return () => {
            console.log('[CareConnex] Unsubscribing from appointments');
            unsubscribe();
        };
    }, [currentUser?.uid, currentUser?.userType]); // Only re-subscribe when user changes

    // U2: Live caregiver-profile listener. Cara writes to caregivers/{uid}
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

    return (
        <CareConnexContext.Provider value={{
            currentUser,
            caregiverProfile,
            refreshCaregiverProfile,
            appointments,
            caregivers,
            isLoading,
            authResolved,
            toasts,
            addToast,
            removeToast,
            bookAppointment,
            completePayment,
            submitReview
        }}>
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
