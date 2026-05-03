// Error message constants for user-friendly error handling
export const ERROR_MESSAGES = {
    AUTH: {
        INVALID_CREDENTIALS: 'Email or password is incorrect. Please try again.',
        EMAIL_IN_USE: 'This email is already registered. Try logging in instead.',
        WEAK_PASSWORD: 'Password must be at least 6 characters long.',
        NETWORK_ERROR: 'Connection issue. Please check your internet and try again.',
        USER_NOT_FOUND: 'No account found with this email. Please sign up first.',
        TOO_MANY_REQUESTS: 'Too many login attempts. Please wait a few minutes and try again.',
        INVALID_EMAIL: 'Please enter a valid email address.',
    },

    BOOKING: {
        CAREGIVER_UNAVAILABLE: 'This caregiver is not available at the selected time.',
        PAYMENT_FAILED: 'Payment could not be processed. Please check your card details.',
        DUPLICATE_BOOKING: 'You already have a booking at this time.',
        INVALID_DATE: 'Please select a future date and time.',
        MISSING_INFORMATION: 'Please fill in all required booking details.',
        BOOKING_NOT_FOUND: 'This booking could not be found.',
    },

    PROFILE: {
        UPDATE_FAILED: 'Could not save changes. Please try again.',
        PHOTO_TOO_LARGE: 'Photo must be smaller than 5MB.',
        INVALID_LOCATION: 'Could not find this address. Please check and try again.',
        MISSING_REQUIRED_FIELDS: 'Please fill in all required fields.',
        INVALID_PHONE: 'Please enter a valid phone number.',
    },

    PAYMENT: {
        CARD_DECLINED: 'Your card was declined. Please try a different payment method.',
        INSUFFICIENT_FUNDS: 'Insufficient funds. Please use a different card.',
        EXPIRED_CARD: 'This card has expired. Please use a different card.',
        INVALID_CARD: 'Invalid card details. Please check and try again.',
        PROCESSING_ERROR: 'Payment processing error. Please try again.',
    },

    MESSAGING: {
        SEND_FAILED: 'Could not send message. Please try again.',
        LOAD_FAILED: 'Could not load messages. Please refresh the page.',
        EMPTY_MESSAGE: 'Please enter a message before sending.',
    },

    GENERAL: {
        NETWORK_ERROR: 'Network error. Please check your connection and try again.',
        PERMISSION_DENIED: 'You don\'t have permission to perform this action.',
        NOT_FOUND: 'The requested item could not be found.',
        SERVER_ERROR: 'Server error. Please try again later.',
        UNKNOWN_ERROR: 'Something went wrong. Please try again.',
    },
};

// Firebase error code mapping
export const FIREBASE_ERROR_MAP: Record<string, string> = {
    'auth/invalid-credential': ERROR_MESSAGES.AUTH.INVALID_CREDENTIALS,
    'auth/user-not-found': ERROR_MESSAGES.AUTH.USER_NOT_FOUND,
    'auth/wrong-password': ERROR_MESSAGES.AUTH.INVALID_CREDENTIALS,
    'auth/email-already-in-use': ERROR_MESSAGES.AUTH.EMAIL_IN_USE,
    'auth/weak-password': ERROR_MESSAGES.AUTH.WEAK_PASSWORD,
    'auth/network-request-failed': ERROR_MESSAGES.AUTH.NETWORK_ERROR,
    'auth/too-many-requests': ERROR_MESSAGES.AUTH.TOO_MANY_REQUESTS,
    'auth/invalid-email': ERROR_MESSAGES.AUTH.INVALID_EMAIL,
    'permission-denied': ERROR_MESSAGES.GENERAL.PERMISSION_DENIED,
    'not-found': ERROR_MESSAGES.GENERAL.NOT_FOUND,
    'unavailable': ERROR_MESSAGES.GENERAL.NETWORK_ERROR,
};
