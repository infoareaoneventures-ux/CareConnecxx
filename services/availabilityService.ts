import { Caregiver, WeeklySchedule, TimeSlot } from '../types';
import { db } from '../lib/firebase';

/**
 * Enhanced Availability Matching Service
 * Filters caregivers based on:
 * 1. Their weekly availability schedule
 * 2. Existing booking conflicts
 * 3. Buffer time between appointments
 */

// Buffer time between appointments (in minutes)
const BUFFER_MINUTES = 30;

export const availabilityService = {
    /**
     * Check if a caregiver is available at a specific date and time
     * NOW includes conflict checking with existing appointments
     */
    isAvailable: async (
        caregiver: Caregiver,
        requestedDate: Date,
        startTime: string, // "14:00"
        duration: number // hours
    ): Promise<boolean> => {
        // 1. Check weekly schedule availability
        const hasWeeklyAvailability = availabilityService.checkWeeklyAvailability(
            caregiver,
            requestedDate,
            startTime,
            duration
        );

        if (!hasWeeklyAvailability) {
            return false;
        }

        // 2. Check for booking conflicts (CRITICAL FIX)
        const hasConflict = await availabilityService.checkForConflicts(
            caregiver.id,
            requestedDate,
            startTime,
            duration
        );

        return !hasConflict;
    },

    /**
     * Check weekly schedule only (original logic)
     */
    checkWeeklyAvailability: (
        caregiver: Caregiver,
        requestedDate: Date,
        startTime: string,
        duration: number
    ): boolean => {
        if (!caregiver.weeklyAvailability) {
            // If no availability set, assume available (legacy caregivers)
            return true;
        }

        const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][requestedDate.getDay()] as keyof WeeklySchedule;
        const daySlots = caregiver.weeklyAvailability[dayOfWeek];

        if (!daySlots || daySlots.length === 0) {
            return false; // Not available on this day
        }

        // Convert start time to minutes for easier comparison
        const requestedStartMinutes = timeToMinutes(startTime);
        const requestedEndMinutes = requestedStartMinutes + (duration * 60);

        // Check if requested time falls within any of the caregiver's time slots
        return daySlots.some(slot => {
            const slotStartMinutes = timeToMinutes(slot.start);
            const slotEndMinutes = timeToMinutes(slot.end);

            // Check if requested time is completely within this slot
            return requestedStartMinutes >= slotStartMinutes && requestedEndMinutes <= slotEndMinutes;
        });
    },

    /**
     * CRITICAL FIX: Check for booking conflicts in Firestore
     * Queries existing appointments and checks for time overlap
     */
    checkForConflicts: async (
        caregiverId: string,
        requestedDate: Date,
        startTime: string,
        duration: number
    ): Promise<boolean> => {
        if (!db) {
            console.warn('Database not available, skipping conflict check');
            return false; // Allow in offline mode
        }

        try {
            // Format date to YYYY-MM-DD for comparison
            const dateStr = requestedDate.toISOString().split('T')[0];
            
            // Calculate time window with buffer
            const requestedStartMinutes = timeToMinutes(startTime);
            const requestedEndMinutes = requestedStartMinutes + (duration * 60);
            const bufferStart = requestedStartMinutes - BUFFER_MINUTES;
            const bufferEnd = requestedEndMinutes + BUFFER_MINUTES;

            // Query existing appointments for this caregiver on this date
            const appointmentsSnap = await db
                .collection('appointments')
                .where('caregiverId', '==', caregiverId)
                .where('date', '==', dateStr)
                .where('status', 'in', ['confirmed', 'in-progress'])
                .get();

            // Check each existing appointment for overlap
            for (const doc of appointmentsSnap.docs) {
                const appt = doc.data();
                const apptStartMinutes = timeToMinutes(appt.time);
                const apptDuration = appt.cost ? Math.round(appt.cost / (appt.hourlyRate || 25)) : 2; // Estimate from cost
                const apptEndMinutes = apptStartMinutes + (apptDuration * 60);

                // Check for overlap (including buffer)
                const hasOverlap = (
                    (bufferStart < apptEndMinutes && bufferEnd > apptStartMinutes)
                );

                if (hasOverlap) {
                    console.log(`Conflict found: Caregiver ${caregiverId} has appointment ${doc.id} from ${appt.time}`);
                    return true; // Conflict found
                }
            }

            return false; // No conflicts
        } catch (error) {
            console.error('Error checking for conflicts:', error);
            // In case of error, allow the booking (fail open for UX, but log error)
            return false;
        }
    },

    /**
     * Find all caregivers available at a specific date and time
     * NOW async due to conflict checking
     */
    findAvailableCaregivers: async (
        caregivers: Caregiver[],
        requestedDate: Date,
        startTime: string,
        duration: number,
        requiredSkills?: string[]
    ): Promise<Caregiver[]> => {
        const availableCaregivers: Caregiver[] = [];

        for (const caregiver of caregivers) {
            // Check availability (now async)
            const isAvailable = await availabilityService.isAvailable(
                caregiver,
                requestedDate,
                startTime,
                duration
            );

            if (!isAvailable) continue;

            // Check skills if specified
            if (requiredSkills && requiredSkills.length > 0) {
                const hasRequiredSkills = requiredSkills.every(skill =>
                    caregiver.skills?.includes(skill) || 
                    caregiver.medicalSkills?.includes(skill)
                );
                if (!hasRequiredSkills) continue;
            }

            availableCaregivers.push(caregiver);
        }

        return availableCaregivers;
    },

    /**
     * Get caregiver's next available slot
     * NOW checks real availability including conflicts
     */
    getNextAvailableSlot: async (
        caregiver: Caregiver,
        startDate: Date,
        duration: number
    ): Promise<{ date: Date; time: string } | null> => {
        if (!caregiver.weeklyAvailability) return null;

        // Check next 30 days
        for (let i = 0; i < 30; i++) {
            const checkDate = new Date(startDate);
            checkDate.setDate(checkDate.getDate() + i);

            const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][checkDate.getDay()] as keyof WeeklySchedule;
            const daySlots = caregiver.weeklyAvailability[dayOfWeek];

            if (daySlots && daySlots.length > 0) {
                // Check each slot
                for (const slot of daySlots) {
                    const slotDuration = timeToMinutes(slot.end) - timeToMinutes(slot.start);
                    
                    if (slotDuration >= duration * 60) {
                        // Check if this slot is actually available (no conflicts)
                        const hasConflict = await availabilityService.checkForConflicts(
                            caregiver.id,
                            checkDate,
                            slot.start,
                            duration
                        );

                        if (!hasConflict) {
                            return {
                                date: checkDate,
                                time: slot.start
                            };
                        }
                    }
                }
            }
        }

        return null;
    },

    /**
     * Batch check availability for multiple caregivers
     * More efficient than calling isAvailable for each
     */
    batchCheckAvailability: async (
        caregivers: Caregiver[],
        requestedDate: Date,
        startTime: string,
        duration: number
    ): Promise<Map<string, boolean>> => {
        const results = new Map<string, boolean>();
        
        // Check weekly availability first (fast, synchronous)
        const candidates = caregivers.filter(c => 
            availabilityService.checkWeeklyAvailability(c, requestedDate, startTime, duration)
        );

        // Then check conflicts for candidates only (slower, async)
        const dateStr = requestedDate.toISOString().split('T')[0];
        
        try {
            // Single query for all candidates
            const caregiverIds = candidates.map(c => c.id);
            const appointmentsSnap = await db
                .collection('appointments')
                .where('caregiverId', 'in', caregiverIds)
                .where('date', '==', dateStr)
                .where('status', 'in', ['confirmed', 'in-progress'])
                .get();

            // Calculate time window with buffer
            const requestedStartMinutes = timeToMinutes(startTime);
            const requestedEndMinutes = requestedStartMinutes + (duration * 60);
            const bufferStart = requestedStartMinutes - BUFFER_MINUTES;
            const bufferEnd = requestedEndMinutes + BUFFER_MINUTES;

            // Group conflicts by caregiver
            const conflictsByCaregiver = new Map<string, boolean>();
            
            appointmentsSnap.docs.forEach(doc => {
                const appt = doc.data();
                const apptStartMinutes = timeToMinutes(appt.time);
                const apptDuration = appt.cost ? Math.round(appt.cost / (appt.hourlyRate || 25)) : 2;
                const apptEndMinutes = apptStartMinutes + (apptDuration * 60);

                const hasOverlap = (bufferStart < apptEndMinutes && bufferEnd > apptStartMinutes);
                
                if (hasOverlap) {
                    conflictsByCaregiver.set(appt.caregiverId, true);
                }
            });

            // Build results
            caregivers.forEach(caregiver => {
                const weeklyAvailable = availabilityService.checkWeeklyAvailability(
                    caregiver, requestedDate, startTime, duration
                );
                const hasConflict = conflictsByCaregiver.has(caregiver.id);
                results.set(caregiver.id, weeklyAvailable && !hasConflict);
            });
        } catch (error) {
            console.error('Batch availability check failed:', error);
            // Fallback to individual checks
            for (const caregiver of caregivers) {
                const available = await availabilityService.isAvailable(
                    caregiver, requestedDate, startTime, duration
                );
                results.set(caregiver.id, available);
            }
        }

        return results;
    }
};

/**
 * Helper: Convert time string to minutes since midnight
 */
function timeToMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
}
