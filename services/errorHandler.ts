import firebase from '../lib/firebase';
import { FIREBASE_ERROR_MAP, ERROR_MESSAGES } from '../constants/errorMessages';

// Get Firestore instance from the initialized Firebase app
const getDb = () => firebase.firestore();

/**
 * Standardized application error structure
 */
export interface AppError {
    message: string;
    code?: string;
    stack?: string;
}

/**
 * Context for error logging and handling
 */
export interface ErrorContext {
    userId?: string;
    action?: string;
    component?: string;
    additionalData?: Record<string, unknown>;
}

/**
 * Central error handling utility
 */
export const errorHandler = {
    /**
     * Get user-friendly error message from Firebase error
     */
    getUserMessage(error: unknown): string {
        if (!error) return ERROR_MESSAGES.GENERAL.UNKNOWN_ERROR;

        // Type guard for error with code property
        const isErrorWithCode = (e: unknown): e is { code: string } => 
            typeof e === 'object' && e !== null && 'code' in e;

        // Type guard for error with message property
        const isErrorWithMessage = (e: unknown): e is { message: string } =>
            typeof e === 'object' && e !== null && 'message' in e && typeof (e as Record<string, unknown>).message === 'string';

        // Check if it's a Firebase error with a code
        if (isErrorWithCode(error) && FIREBASE_ERROR_MAP[error.code]) {
            return FIREBASE_ERROR_MAP[error.code];
        }

        // Check for custom error messages
        if (isErrorWithMessage(error)) {
            // If message is already user-friendly, return it
            if (!error.message.includes('Firebase') && !error.message.includes('Error:')) {
                return error.message;
            }
        }

        // Default to generic error
        return ERROR_MESSAGES.GENERAL.UNKNOWN_ERROR;
    },

    /**
     * Log error to Firestore for debugging
     */
    async logError(error: unknown, context: ErrorContext = {}): Promise<void> {
        try {
            const isErrorWithMessage = (e: unknown): e is { message: string } =>
                typeof e === 'object' && e !== null && 'message' in e;
            const isErrorWithCode = (e: unknown): e is { code: string } =>
                typeof e === 'object' && e !== null && 'code' in e;
            const isErrorWithStack = (e: unknown): e is { stack: string } =>
                typeof e === 'object' && e !== null && 'stack' in e;

            const errorLog = {
                message: isErrorWithMessage(error) ? error.message : 'Unknown error',
                code: isErrorWithCode(error) ? error.code : 'unknown',
                stack: isErrorWithStack(error) ? error.stack : null,
                timestamp: new Date().toISOString(),
                userId: context.userId || 'anonymous',
                action: context.action || 'unknown',
                component: context.component || 'unknown',
                additionalData: context.additionalData || {},
                userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'server',
            };

            const db = getDb();
            await db.collection('error_logs').add(errorLog);
        } catch (loggingError) {
            // Silently fail if logging fails (don't want to create infinite loop)
            console.error('Failed to log error:', loggingError);
        }
    },

    /**
     * Handle error with user notification and logging
     */
    async handleError(
        error: unknown,
        context: ErrorContext = {},
        showToast?: (message: string, type: 'success' | 'error' | 'info') => void
    ): Promise<string> {
        const userMessage = this.getUserMessage(error);

        // Log error to Firestore
        await this.logError(error, context);

        // Show toast if provided
        if (showToast) {
            showToast(userMessage, 'error');
        }

        return userMessage;
    },

    /**
     * Retry function with exponential backoff
     * 
     * @template T - Return type of the function
     * @param fn - Async function to retry
     * @param maxRetries - Maximum number of retry attempts (default: 3)
     * @param delayMs - Initial delay in milliseconds (default: 1000)
     * @returns Promise resolving to the function result
     * @throws Last error encountered after all retries
     */
    async retry<T>(
        fn: () => Promise<T>,
        maxRetries: number = 3,
        delayMs: number = 1000
    ): Promise<T> {
        let lastError: unknown;

        for (let i = 0; i < maxRetries; i++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;

                // Type guard for error with code property
                const isErrorWithCode = (e: unknown): e is { code: string } =>
                    typeof e === 'object' && e !== null && 'code' in e;

                // Don't retry on auth errors or permission errors
                if (isErrorWithCode(error)) {
                    const code = error.code;
                    if (code?.startsWith('auth/') || code === 'permission-denied') {
                        throw error;
                    }
                }

                // Wait before retrying (exponential backoff)
                if (i < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, delayMs * Math.pow(2, i)));
                }
            }
        }

        throw lastError;
    },
};
