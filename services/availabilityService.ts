import { Caregiver, WeeklySchedule, TimeSlot } from '../types';
import { db } from '../lib/firebase';
import { localDateStr } from '../utils/shiftUtils';

/**
 * Enhanced Availability Matching Service
 * Filters caregivers based on:
 * 1. Their weekly availability schedule
 * 2. Existing booking conflicts
 * 3. Buffer time between appointments
 */

// Buffer time between appointments (in minutes)
const BUFFER_MINUTES = 30;

/**
 * Onboarding Step 5 saves weeklyAvailability as block IDs: { monday: ['morning', 'afternoon'] }
 * Evia's availabilityHandler saves it as TimeSlots:        { monday: [{ start: '06:00', end: '12:00' }] }
 * This map normalizes both formats so the service works regardless of which was used.
 */
const BLOCK_TO_TIMESLOT: Record<string, TimeSlot> = {
  morning:   { start: '06:00', end: '12:00' },
  afternoon: { start: '12:00', end: '18:00' },
  evening:   { start: '18:00', end: '23:00' },
  overnight: { start: '23:00', end: '06:00' }, // cross-midnight: 11pm → 6am
};

function normalizeSlots(slots: (TimeSlot | string)[]): TimeSlot[] {
  return slots.flatMap(slot => {
    if (typeof slot === 'string') {
      const mapped = BLOCK_TO_TIMESLOT[slot];
      return mapped ? [mapped] : [];
    }
    return [slot as TimeSlot];
  });
}

const BLOCK_ORDER = ['morning', 'afternoon', 'evening', 'overnight'] as const;

/**
 * Convert block IDs → TimeSlots for Firestore storage.
 * Use this before saving from onboarding or profile edit so
 * the format matches what Evia's availabilityHandler writes.
 * e.g. { monday: ['morning','afternoon'] } → { monday: [{start:'06:00',end:'12:00'},{start:'12:00',end:'18:00'}] }
 */
export function blocksToWeeklySlots(
  blocks: Record<string, string[]>
): Record<string, TimeSlot[]> {
  const result: Record<string, TimeSlot[]> = {};
  for (const [day, blockIds] of Object.entries(blocks)) {
    result[day] = blockIds.map(id => BLOCK_TO_TIMESLOT[id]).filter(Boolean) as TimeSlot[];
  }
  return result;
}

/**
 * Convert TimeSlots (from Firestore) → block IDs for the UI grid.
 * Handles both formats: if a value is already a string block ID, it passes through.
 * e.g. { monday: [{start:'06:00',end:'18:00'}] } → { monday: ['morning','afternoon'] }
 */
export function weeklySlotsToBl(
  weekly: Record<string, (TimeSlot | string)[]>
): Record<string, string[]> {
  const blockMins: Record<string, { s: number; e: number }> = {
    morning:   { s: 360,  e: 720  },  // 06:00–12:00
    afternoon: { s: 720,  e: 1080 },  // 12:00–18:00
    evening:   { s: 1080, e: 1380 },  // 18:00–23:00
    overnight: { s: 1380, e: 1440 },  // 23:00–24:00
  };
  const result: Record<string, string[]> = {};
  for (const [day, slots] of Object.entries(weekly)) {
    const active = new Set<string>();
    for (const slot of slots) {
      if (typeof slot === 'string') {
        if (BLOCK_TO_TIMESLOT[slot]) active.add(slot);
      } else {
        const s = timeToMinutes(slot.start);
        const eRaw = timeToMinutes(slot.end);
        // If end ≤ start it crosses midnight (e.g. 23:00–06:00) — add 24h to end
        const e = eRaw <= s ? eRaw + 1440 : eRaw;
        for (const b of BLOCK_ORDER) {
          const r = blockMins[b];
          if (s < r.e && e > r.s) active.add(b);
        }
      }
    }
    result[day] = BLOCK_ORDER.filter(b => active.has(b));
  }
  return result;
}

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
        _startTime: string,
        _duration: number
    ): boolean => {
        if (!caregiver.weeklyAvailability) {
            // If no availability set, assume available (legacy caregivers)
            return true;
        }

        const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][requestedDate.getDay()] as keyof WeeklySchedule;
        const rawSlots = caregiver.weeklyAvailability[dayOfWeek] as (TimeSlot | string)[];
        const daySlots = normalizeSlots(rawSlots || []);

        if (daySlots.length === 0) {
            return false; // Not available on this day
        }

        // Day has availability — allow any time on this day.
        // Per-hour blocking (calendar conflicts) is handled separately.
        return true;
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
            // Local calendar date (NOT UTC) — appointments store local dates, so
            // toISOString() would query the wrong day for evening-local bookings
            // and miss same-day conflicts (double-book). See utils/shiftUtils.
            const dateStr = localDateStr(requestedDate);
            
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
        // Local calendar date (NOT UTC) — see the note above / utils/shiftUtils.
        const dateStr = localDateStr(requestedDate);
        
        try {
            // Single query for all candidates
            const caregiverIds = candidates.map(c => c.id);
            const fdb = db;
            if (!fdb) throw new Error('Firestore not initialized');
            const appointmentsSnap = await fdb
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
