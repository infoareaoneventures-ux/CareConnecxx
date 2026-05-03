import { useState, useCallback } from 'react';

export interface BookingState {
    service?: string;
    date?: string;
    time?: string;
    duration?: number;
    selectedCaregiverId?: string;
    confirmed: boolean;
}

/**
 * Hook for managing the booking flow state
 * 
 * @example
 * const { bookingState, updateBookingState, isComplete, reset } = useBookingFlow();
 */
export const useBookingFlow = () => {
    const [bookingState, setBookingState] = useState<BookingState>({
        confirmed: false
    });

    const updateBookingState = useCallback((updates: Partial<BookingState>) => {
        setBookingState(prev => ({ ...prev, ...updates }));
    }, []);

    const isComplete = useCallback(() => {
        return !!(
            bookingState.service &&
            bookingState.date &&
            bookingState.time &&
            bookingState.duration &&
            bookingState.selectedCaregiverId
        );
    }, [bookingState]);

    const reset = useCallback(() => {
        setBookingState({ confirmed: false });
    }, []);

    return {
        bookingState,
        updateBookingState,
        isComplete,
        reset
    };
};
