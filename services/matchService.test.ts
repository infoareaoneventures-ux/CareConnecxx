import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matchService } from './matchService';
import { Caregiver, Senior, MatchFeedback } from '../types';

// Mock availability service
vi.mock('./availabilityService', () => ({
  availabilityService: {
    isAvailable: vi.fn(),
    batchCheckAvailability: vi.fn()
  }
}));

import { availabilityService } from './availabilityService';

describe('MatchService', () => {
  const mockSenior: Senior = {
    id: 1,
    name: 'Test Senior',
    age: 75,
    location: 'Springfield, IL',
    zipCode: '62701',
    latitude: 39.7817,
    longitude: -89.6501,
    needs: ['Mobility Support'],
    personality: 'Introvert',
    phone: '5559876543'
  };

  const createBaseCaregiver = (overrides: Partial<Caregiver> = {}): Caregiver => ({
    id: 'caregiver123',
    uid: 'caregiver123',
    name: 'Test Caregiver',
    email: 'test@example.com',
    hourlyRate: 30,
    verified: false, // Start unverified to reduce score
    instantPayAvailable: false,
    personalityTags: [], // No tags to reduce score
    matchScore: 50,
    distance: 15, // Medium distance
    availability: [],
    weeklyAvailability: {
      monday: [{ start: '09:00', end: '17:00' }],
      tuesday: [{ start: '09:00', end: '17:00' }],
      wednesday: [{ start: '09:00', end: '17:00' }],
      thursday: [{ start: '09:00', end: '17:00' }],
      friday: [{ start: '09:00', end: '17:00' }],
      saturday: [],
      sunday: []
    },
    latitude: 39.85, // Near Springfield, IL (39.7817, -89.6501) - about 5 miles
    longitude: -89.60,
    skills: [], // No skills to reduce score
    medicalSkills: [],
    certifications: [],
    experience: 1, // Low experience
    rating: 3.0, // Low rating
    reviewCount: 5,
    reliabilityScore: 50, // Low reliability
    gender: 'Female',
    ...overrides
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (availabilityService.isAvailable as any).mockResolvedValue(true);
    (availabilityService.batchCheckAvailability as any).mockResolvedValue(
      new Map([['caregiver123', true]])
    );
  });

  describe('scoreCaregiver', () => {
    it('should return null if not available at requested time', async () => {
      (availabilityService.isAvailable as any).mockResolvedValue(false);

      const result = await matchService.scoreCaregiver(
        createBaseCaregiver(),
        mockSenior,
        [],
        {
          requestedDate: new Date('2026-02-09'),
          requestedTime: '10:00',
          requestedDuration: 2
        }
      );

      expect(result).toBeNull();
    });

    it('should return null if caregiver is too far away', async () => {
      const farCaregiver = createBaseCaregiver({
        latitude: 45.0,
        longitude: -95.0,
        distance: 35
      });

      const result = await matchService.scoreCaregiver(
        farCaregiver,
        mockSenior,
        []
      );

      expect(result).toBeNull();
    });

    it('should calculate score correctly for average match', async () => {
      const result = await matchService.scoreCaregiver(
        createBaseCaregiver(),
        mockSenior,
        []
      );

      expect(result).not.toBeNull();
      expect(result!.matchScore).toBeGreaterThanOrEqual(0);
      expect(result!.matchScore).toBeLessThanOrEqual(100);
    });

    it('should cap score at 100 for perfect caregivers', async () => {
      const perfectCaregiver = createBaseCaregiver({
        verified: true,
        distance: 3,
        latitude: 39.79,
        longitude: -89.64,
        rating: 5.0,
        reliabilityScore: 100,
        experience: 10,
        skills: ['Mobility Support', 'Medication Reminders'],
        medicalSkills: ['Medication Reminders'],
        personalityTags: ['Patient', 'Calm']
      });

      const result = await matchService.scoreCaregiver(
        perfectCaregiver,
        mockSenior,
        []
      );

      expect(result!.matchScore).toBeLessThanOrEqual(100);
    });

    it('should floor score at 0 for poor caregivers', async () => {
      const badCaregiver = createBaseCaregiver({
        distance: 25,
        verified: false,
        rating: 1.0,
        reliabilityScore: 10
      });

      const result = await matchService.scoreCaregiver(
        badCaregiver,
        mockSenior,
        []
      );

      expect(result!.matchScore).toBeGreaterThanOrEqual(0);
    });

    it('should give higher score to nearby vs far caregivers', async () => {
      // Both within 30 miles but one nearby (<5) and one far (>15)
      // Senior at (39.7817, -89.6501) in Springfield, IL
      // Nearby: ~3 miles away at (39.80, -89.60)
      // Far: ~18 miles away at (39.95, -89.40) - still under 30 mile cutoff
      const nearbyCaregiver = createBaseCaregiver({ 
        distance: 3, 
        latitude: 39.80,
        longitude: -89.60
      });
      const farCaregiver = createBaseCaregiver({ 
        distance: 18,
        latitude: 39.95,
        longitude: -89.40
      });

      const nearbyResult = await matchService.scoreCaregiver(
        nearbyCaregiver,
        mockSenior,
        []
      );

      const farResult = await matchService.scoreCaregiver(
        farCaregiver,
        mockSenior,
        []
      );

      expect(nearbyResult).not.toBeNull();
      expect(farResult).not.toBeNull();
      expect(nearbyResult!.matchScore).toBeGreaterThan(farResult!.matchScore);
    });

    it('should give higher score to verified caregivers', async () => {
      const unverifiedCaregiver = createBaseCaregiver({ verified: false });
      const verifiedCaregiver = createBaseCaregiver({ verified: true });

      const verifiedResult = await matchService.scoreCaregiver(
        verifiedCaregiver,
        mockSenior,
        []
      );

      const unverifiedResult = await matchService.scoreCaregiver(
        unverifiedCaregiver,
        mockSenior,
        []
      );

      expect(verifiedResult!.matchScore).toBeGreaterThan(unverifiedResult!.matchScore);
      expect(unverifiedResult!.matchFlags).toContain('Not yet verified');
    });

    it('should give higher score for skill matches', async () => {
      const skilledCaregiver = createBaseCaregiver({
        skills: ['Mobility Support'],
        medicalSkills: ['Medication Reminders']
      });

      const unskilledCaregiver = createBaseCaregiver({
        skills: [],
        medicalSkills: []
      });

      const skilledResult = await matchService.scoreCaregiver(
        skilledCaregiver,
        mockSenior,
        []
      );

      const unskilledResult = await matchService.scoreCaregiver(
        unskilledCaregiver,
        mockSenior,
        []
      );

      expect(skilledResult!.matchScore).toBeGreaterThan(unskilledResult!.matchScore);
    });

    it('should respect gender preference', async () => {
      const seniorWithPreference = {
        ...mockSenior,
        genderPreference: 'Female' as const
      };

      const matchingResult = await matchService.scoreCaregiver(
        createBaseCaregiver({ gender: 'Female' }),
        seniorWithPreference,
        []
      );

      const mismatchResult = await matchService.scoreCaregiver(
        createBaseCaregiver({ gender: 'Male' }),
        seniorWithPreference,
        []
      );

      expect(matchingResult!.matchScore).toBeGreaterThan(mismatchResult!.matchScore);
      expect(mismatchResult!.matchFlags).toContain('Gender mismatch (prefers Female)');
    });

    it('should match personality types', async () => {
      const introvertSenior = { ...mockSenior, personality: 'Introvert' as const };

      const calmCaregiver = createBaseCaregiver({
        personalityTags: ['Calm', 'Patient']
      });

      const energeticCaregiver = createBaseCaregiver({
        personalityTags: ['High Energy', 'Chatty']
      });

      const calmWithIntrovert = await matchService.scoreCaregiver(
        calmCaregiver,
        introvertSenior,
        []
      );

      const energeticWithIntrovert = await matchService.scoreCaregiver(
        energeticCaregiver,
        introvertSenior,
        []
      );

      expect(calmWithIntrovert!.matchScore).toBeGreaterThan(energeticWithIntrovert!.matchScore);
    });

    it('should learn from feedback history and penalize rejected patterns', async () => {
      const feedbackHistory: MatchFeedback[] = [
        {
          seniorId: '1',
          caregiverId: 'caregiver123',
          action: 'rejected',
          reason: 'Too loud and high energy',
          timestamp: new Date().toISOString()
        }
      ];

      const highEnergyCaregiver = createBaseCaregiver({
        personalityTags: ['High Energy', 'Loud']
      });

      const result = await matchService.scoreCaregiver(
        highEnergyCaregiver,
        mockSenior,
        feedbackHistory
      );

      expect(result!.matchFlags).toContain("Pattern: Previously rejected for 'High Energy'");
    });

    it('should give higher scores for better ratings', async () => {
      const highlyRated = createBaseCaregiver({ rating: 4.9, reviewCount: 50 });
      const lowRated = createBaseCaregiver({ rating: 2.5, reviewCount: 10 });

      const highResult = await matchService.scoreCaregiver(highlyRated, mockSenior, []);
      const lowResult = await matchService.scoreCaregiver(lowRated, mockSenior, []);

      expect(highResult!.matchScore).toBeGreaterThan(lowResult!.matchScore);
    });

    it('should give higher scores for more experience', async () => {
      const experienced = createBaseCaregiver({ experience: 10 });
      const novice = createBaseCaregiver({ experience: 1 });

      const expResult = await matchService.scoreCaregiver(experienced, mockSenior, []);
      const novResult = await matchService.scoreCaregiver(novice, mockSenior, []);

      expect(expResult!.matchScore).toBeGreaterThan(novResult!.matchScore);
    });
  });

  describe('scoreCaregivers (batch)', () => {
    it('should score multiple caregivers', async () => {
      const caregivers = [
        createBaseCaregiver({ id: 'cg1', rating: 4.5, verified: true }),
        createBaseCaregiver({ id: 'cg2', distance: 25, rating: 3.0 }),
        createBaseCaregiver({ id: 'cg3', distance: 5, rating: 3.5, verified: false })
      ];

      (availabilityService.batchCheckAvailability as any).mockResolvedValue(
        new Map([
          ['cg1', true],
          ['cg2', true],
          ['cg3', true]
        ])
      );

      const results = await matchService.scoreCaregivers(
        caregivers,
        mockSenior,
        []
      );

      expect(results.length).toBe(3);
      expect(results[0].matchScore).toBeGreaterThanOrEqual(0);
      expect(results[0].matchScore).toBeLessThanOrEqual(100);
    });

    it('should filter out unavailable caregivers', async () => {
      const caregivers = [
        createBaseCaregiver({ id: 'cg1' }),
        createBaseCaregiver({ id: 'cg2' })
      ];

      (availabilityService.batchCheckAvailability as any).mockResolvedValue(
        new Map([
          ['cg1', true],
          ['cg2', false]
        ])
      );

      const results = await matchService.scoreCaregivers(
        caregivers,
        mockSenior,
        [],
        {
          requestedDate: new Date(),
          requestedTime: '10:00',
          requestedDuration: 2
        }
      );

      expect(results.length).toBe(1);
      expect(results[0].id).toBe('cg1');
    });

    it('should sort by score descending', async () => {
      const caregivers = [
        createBaseCaregiver({ id: 'low', rating: 2.5, distance: 25, verified: false }),
        createBaseCaregiver({ id: 'high', rating: 4.8, distance: 3, verified: true }),
        createBaseCaregiver({ id: 'mid', rating: 3.5, distance: 10, verified: true })
      ];

      const results = await matchService.scoreCaregivers(
        caregivers,
        mockSenior,
        []
      );

      expect(results[0].id).toBe('high');
      expect(results[1].id).toBe('mid');
      expect(results[2].id).toBe('low');
    });
  });

  describe('getTopMatches', () => {
    it('should return top N matches', async () => {
      const caregivers = Array.from({ length: 10 }, (_, i) => 
        createBaseCaregiver({
          id: `cg${i}`,
          rating: 4.5 - (i * 0.2),
          distance: 3 + i * 2
        })
      );

      const results = await matchService.getTopMatches(
        caregivers,
        mockSenior,
        [],
        5
      );

      expect(results.length).toBe(5);
      expect(results[0].rating).toBeGreaterThan(results[4].rating!);
    });

    it('should handle fewer caregivers than N', async () => {
      const caregivers = [createBaseCaregiver()];

      const results = await matchService.getTopMatches(
        caregivers,
        mockSenior,
        [],
        5
      );

      expect(results.length).toBe(1);
    });
  });
});
