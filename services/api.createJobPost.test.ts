import { describe, it, expect, vi, beforeEach } from 'vitest';

// 2026-10-11 ("Distance is ZIP-level" fix): the site's createJobPost stores a
// STREET-level point — the one PostJobFlow hands over from the selected Care
// Plan location, or the street geocoded once through utils/geocode.ts
// geocodeAddress — and never the street itself. geoPrecision says how the
// point was derived. Evia's buildJobPost.ts / jobPostCoords.ts is the twin.

const hoisted = vi.hoisted(() => ({
  added: [] as Array<{ coll: string; data: any }>,
  geocodeAddress: vi.fn(),
}));

vi.mock('../lib/firebase', () => ({
  __esModule: true,
  default: { firestore: { FieldValue: {} } },
  auth: { currentUser: { uid: 'client1', displayName: 'Pat Family' } },
  db: {
    collection: (coll: string) => ({
      add: async (data: any) => { hoisted.added.push({ coll, data }); return { id: 'post1' }; },
    }),
  },
  functions: {},
  storage: {},
  isConfigured: true,
}));
vi.mock('./stripeService', () => ({ stripeService: {} }));
vi.mock('../utils/geocode', () => ({
  geocodeAddress: (...a: unknown[]) => hoisted.geocodeAddress(...a),
  geocodeToLatLng: vi.fn(async () => null),
}));

import { dbService } from './api';

const BASE = {
  title: 'Senior care in San Jose',
  description: 'Looking for a caring and reliable caregiver for my mother on weekday afternoons.',
  startDate: '2026-11-01',
  city: 'San Jose', state: 'CA', zipCode: '95110',
  careTypes: ['Companionship'],
};

beforeEach(() => { hoisted.added.length = 0; hoisted.geocodeAddress.mockReset().mockResolvedValue(null); });

describe('dbService.createJobPost — street-level point, street never stored', () => {
  it('stores the Care Plan location point PostJobFlow passes (lat/lng/geoPrecision) without geocoding again', async () => {
    await dbService.createJobPost({ ...BASE, lat: 37.3361, lng: -121.8905, geoPrecision: 'street' } as any, 'client1');
    expect(hoisted.geocodeAddress).not.toHaveBeenCalled();
    const doc = hoisted.added[0].data;
    expect(doc).toMatchObject({ lat: 37.3361, lng: -121.8905, geoPrecision: 'street', city: 'San Jose', state: 'CA', zipCode: '95110' });
    expect(doc.streetAddress).toBeUndefined();
  });

  it('geocodes the FULL street when a street is given but no point, stores the point as street-level, and never stores the street (the WhatsNext auto-post path)', async () => {
    hoisted.geocodeAddress.mockResolvedValue({ lat: 37.3361, lng: -121.8905, geoPrecision: 'street' });
    await dbService.createJobPost({ ...BASE, streetAddress: '123 Main St' } as any, 'client1');
    expect(hoisted.geocodeAddress).toHaveBeenCalledWith({ street: '123 Main St', city: 'San Jose', state: 'CA', zipCode: '95110' });
    const doc = hoisted.added[0].data;
    expect(doc).toMatchObject({ lat: 37.3361, lng: -121.8905, geoPrecision: 'street' });
    expect(doc).not.toHaveProperty('streetAddress');
  });

  it('with only city/state/zip the point is the ZIP centroid, marked "zip" (the backfill target)', async () => {
    hoisted.geocodeAddress.mockResolvedValue({ lat: 37.33, lng: -121.89, geoPrecision: 'zip' });
    await dbService.createJobPost(BASE as any, 'client1');
    expect(hoisted.added[0].data).toMatchObject({ lat: 37.33, lng: -121.89, geoPrecision: 'zip' });
  });

  it('saves the post without a point when geocoding fails (the server trigger fills the centroid later)', async () => {
    await dbService.createJobPost(BASE as any, 'client1');
    const doc = hoisted.added[0].data;
    expect(doc.lat).toBeUndefined();
    expect(doc.geoPrecision).toBeUndefined();
    expect(doc.status).toBe('open');
  });
});
