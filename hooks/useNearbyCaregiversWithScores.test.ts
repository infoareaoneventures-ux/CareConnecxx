import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// 2026-10-11 ("Distance is ZIP-level" fix, family side): a caregiver WITHOUT
// coordinates used to get distance 0 — the "closest" of all — in the
// dashboard's Nearby Caregivers. Unknown is unknown: no distance on the item,
// sorted after every known distance (the caregiver Jobs board already treats a
// job without coords this way). Evia's twin: caregiverMatchScoring.ts.

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const queryOf = (coll: string) => ({
    where: () => queryOf(coll),
    limit: () => queryOf(coll),
    get: async () => {
      const items = Array.from(docs.entries())
        .filter(([p]) => p.startsWith(`${coll}/`))
        .map(([p, d]) => ({ id: p.split('/')[1], data: () => d }));
      return { docs: items, forEach: (fn: (d: any) => void) => items.forEach(fn), empty: items.length === 0 };
    },
  });
  const db = {
    collection: (coll: string) => ({
      ...queryOf(coll),
      doc: (id: string) => ({
        get: async () => ({ exists: docs.has(`${coll}/${id}`), data: () => docs.get(`${coll}/${id}`) }),
      }),
    }),
  };
  return { docs, db };
});

vi.mock('../lib/firebase', () => ({ db: hoisted.db }));
vi.mock('../utils/transportDocs', () => ({ hasValidTransportDocs: () => false }));
vi.mock('../utils/caregiverEligibility', () => ({ isCaregiverBookable: () => true }));

import { useNearbyCaregiversWithScores, compareDistanceUnknownLast, nearestDistanceMiles } from './useNearbyCaregiversWithScores';

const CLIENT = 'client1';
const bookable = { onboardingStatus: 'profile_complete', verificationStatus: 'approved', rating: 5, skills: [] };

beforeEach(() => {
  hoisted.docs.clear();
  // One care location (downtown San Jose) from an open post.
  hoisted.docs.set(`job_posts/p1`, { clientId: CLIENT, status: 'open', lat: 37.3382, lng: -121.8863, careTypes: [] });
});

describe('compareDistanceUnknownLast / nearestDistanceMiles', () => {
  it('known distances sort ascending; unknown goes last; two unknowns are equal', () => {
    expect(compareDistanceUnknownLast(1.2, 4)).toBeLessThan(0);
    expect(compareDistanceUnknownLast(undefined, 4)).toBeGreaterThan(0);
    expect(compareDistanceUnknownLast(4, null)).toBeLessThan(0);
    expect(compareDistanceUnknownLast(undefined, null)).toBe(0);
  });
  it('nearestDistanceMiles is undefined (not 0) without coords on either side', () => {
    expect(nearestDistanceMiles(undefined, undefined, [{ lat: 37.3, lng: -121.9 }])).toBeUndefined();
    expect(nearestDistanceMiles(37.3, -121.9, [])).toBeUndefined();
    expect(nearestDistanceMiles(37.3382, -121.8863, [{ lat: 37.3382, lng: -121.8863 }])).toBe(0);
    expect(nearestDistanceMiles(37.60, -122.0, [{ lat: 37.3382, lng: -121.8863 }])).toBeGreaterThan(10);
  });
});

describe('useNearbyCaregiversWithScores — unknown distance', () => {
  it('a caregiver without coordinates has no distance and sorts AFTER one with a known distance (equal skills/availability/rating)', async () => {
    hoisted.docs.set('publicCaregiverProfiles/no-coords', { ...bookable, name: 'No Coords' });
    hoisted.docs.set('publicCaregiverProfiles/near', { ...bookable, name: 'Near', lat: 37.35, lng: -121.90 });

    const { result } = renderHook(() => useNearbyCaregiversWithScores(CLIENT, { limit: 6 }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.caregivers.map(c => c.id)).toEqual(['near', 'no-coords']);
    const noCoords = result.current.caregivers.find(c => c.id === 'no-coords')!;
    expect(noCoords.distance).toBeUndefined();
    expect(result.current.caregivers.find(c => c.id === 'near')!.distance).toBeGreaterThan(0);
  });

  it('the unknown-distance caregiver is still listed (never dropped by the radius filter) and a known far one is', async () => {
    hoisted.docs.set('publicCaregiverProfiles/no-coords', { ...bookable, name: 'No Coords' });
    hoisted.docs.set('publicCaregiverProfiles/far', { ...bookable, name: 'Far', lat: 38.58, lng: -121.49 }); // Sacramento, ~90 mi

    const { result } = renderHook(() => useNearbyCaregiversWithScores(CLIENT, { maxDistance: 25 }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.caregivers.map(c => c.id)).toEqual(['no-coords']);
  });
});
