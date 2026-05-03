import { describe, it, expect, vi } from 'vitest';
import { availabilityService } from './availabilityService';
import { Caregiver } from '../types';

// Mock Firebase
vi.mock('../lib/firebase', () => ({
  db: {}
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(() => ({})),
  getDocs: vi.fn()
}));

describe('AvailabilityService', () => {
  const mockCaregiver: Caregiver = {
    id: 'caregiver123',
    uid: 'caregiver123',
    name: 'Test Caregiver',
    hourlyRate: 30,
    verified: true,
    instantPayAvailable: false,
    personalityTags: ['Patient'],
    matchScore: 80,
    distance: 5,
    availability: [],
    weeklyAvailability: {
      monday: [{ start: '09:00', end: '17:00' }],
      tuesday: [{ start: '09:00', end: '17:00' }],
      wednesday: [{ start: '09:00', end: '17:00' }],
      thursday: [{ start: '09:00', end: '17:00' }],
      friday: [{ start: '09:00', end: '17:00' }],
      saturday: [],
      sunday: []
    }
  };

  describe('checkWeeklyAvailability', () => {
    it('should return true for available time slot on Monday', () => {
      // Use noon UTC to ensure consistent day across timezones
      const monday = new Date('2026-02-09T12:00:00Z');
      expect(monday.getUTCDay()).toBe(1); // Verify it's Monday in UTC
      
      const result = availabilityService.checkWeeklyAvailability(
        mockCaregiver,
        monday,
        '10:00',
        2
      );
      expect(result).toBe(true);
    });

    it('should return false for unavailable day (Sunday)', () => {
      const sunday = new Date('2026-02-08T12:00:00Z');
      expect(sunday.getUTCDay()).toBe(0); // Verify Sunday
      
      const result = availabilityService.checkWeeklyAvailability(
        mockCaregiver,
        sunday,
        '10:00',
        2
      );
      expect(result).toBe(false);
    });

    it('should return false for time outside availability', () => {
      const monday = new Date('2026-02-09T12:00:00Z');
      const result = availabilityService.checkWeeklyAvailability(
        mockCaregiver,
        monday,
        '18:00', // After 5 PM
        2
      );
      expect(result).toBe(false);
    });

    it('should return false if duration exceeds availability', () => {
      const monday = new Date('2026-02-09T12:00:00Z');
      const result = availabilityService.checkWeeklyAvailability(
        mockCaregiver,
        monday,
        '14:00', // 2 PM
        5 // Would end at 7 PM, past availability
      );
      expect(result).toBe(false);
    });

    it('should return true for legacy caregivers without weeklyAvailability', () => {
      const legacyCaregiver = { ...mockCaregiver, weeklyAvailability: undefined };
      const monday = new Date('2026-02-09T12:00:00Z');
      const result = availabilityService.checkWeeklyAvailability(
        legacyCaregiver,
        monday,
        '10:00',
        2
      );
      expect(result).toBe(true);
    });
  });

  describe('day of week mapping', () => {
    it('should correctly map days to availability keys', () => {
      // Test using UTC dates to avoid timezone issues
      expect(new Date('2026-02-09T12:00:00Z').getUTCDay()).toBe(1); // Monday = 1
      expect(new Date('2026-02-08T12:00:00Z').getUTCDay()).toBe(0); // Sunday = 0
      expect(new Date('2026-02-07T12:00:00Z').getUTCDay()).toBe(6); // Saturday = 6
      expect(new Date('2026-02-10T12:00:00Z').getUTCDay()).toBe(2); // Tuesday = 2
    });
  });
});
