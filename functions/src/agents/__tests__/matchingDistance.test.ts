import { describe, it, expect } from "vitest";

// Transitive imports call admin.firestore() at module load, so the module won't
// import without a firebase-admin stub — this test exercises only the pure
// computeRuleSignals function, the stub just lets the module load.
import { vi } from "vitest";
vi.mock("firebase-admin", () => {
  const firestore = () => ({ collection: () => ({ where: () => ({}), doc: () => ({}), add: () => {} }) });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

import { computeRuleSignals, type CaregiverCandidate } from "../matchingAgent";

// 2026-08-31 fix: this used to guess proximity from a city-string/zip-prefix
// match ("no lat/lng in this flow"), which could rank — or entirely exclude
// upstream at the candidate-pool filter — a real nearby caregiver the
// website's own haversine distance calculation would have surfaced
// correctly. Real distance now used whenever both sides have coordinates.

const BASE_CAREGIVER: CaregiverCandidate = {
  id: "cg1",
  name: "Basra Yousuf",
  hourlyRate: 24,
  specialties: ["Companionship"],
  city: "San Jose",
  yearsExperience: 12,
};

describe("computeRuleSignals — real distance", () => {
  it("uses real haversine distance when both the client and caregiver have coordinates", () => {
    // San Jose, CA (95130) to San Jose, CA (95126) — a few miles apart, same city.
    const intake = { city: "San Jose", zipCode: "95130", __clientLat: 37.2431, __clientLng: -121.8996 };
    const caregiver: CaregiverCandidate = { ...BASE_CAREGIVER, ...( { lat: 37.3182, lng: -121.9469 } as any) };
    const { signals } = computeRuleSignals(caregiver, intake);
    expect(signals.distanceMiles).toBeGreaterThan(0);
    expect(signals.distanceMiles).toBeLessThan(10); // genuinely close, real math
  });

  it("does not silently drop a real nearby caregiver whose city string / zip prefix don't match", () => {
    // Different city string and a different 3-digit zip prefix, but geographically close —
    // exactly the site-vs-Evia mismatch reported live (caregivers visible on the website's
    // real-distance Browse Caregivers page but invisible through Evia's old proxy).
    const intake = { city: "San Jose", zipCode: "95130", __clientLat: 37.2431, __clientLng: -121.8996 };
    const caregiver: CaregiverCandidate = {
      ...BASE_CAREGIVER, city: "Santa Clara", ...( { zipCode: "95050", lat: 37.3541, lng: -121.9552 } as any),
    };
    const { signals } = computeRuleSignals(caregiver, intake);
    // Real distance is genuinely close (a few miles) even though city/zip strings differ.
    expect(signals.distanceMiles).toBeLessThan(15);
  });

  it("falls back to the old city/zip proxy when coordinates are missing on either side", () => {
    const intake = { city: "San Jose", zipCode: "95130" }; // no __clientLat/__clientLng
    const sameCity: CaregiverCandidate = { ...BASE_CAREGIVER, city: "San Jose" };
    const { signals: sameCitySignals } = computeRuleSignals(sameCity, intake);
    expect(sameCitySignals.distanceMiles).toBe(2);

    const sameZipPrefix: CaregiverCandidate = { ...BASE_CAREGIVER, city: "Different City", ...( { zipCode: "95199" } as any) };
    const { signals: zipSignals } = computeRuleSignals(sameZipPrefix, intake);
    expect(zipSignals.distanceMiles).toBe(12);

    const farAway: CaregiverCandidate = { ...BASE_CAREGIVER, city: "Nowhere", ...( { zipCode: "10001" } as any) };
    const { signals: farSignals } = computeRuleSignals(farAway, intake);
    expect(farSignals.distanceMiles).toBe(22);
  });

  it("prefers real coordinates over the city/zip proxy even when both are present", () => {
    // Same city string (would proxy to 2mi) but real coordinates are genuinely far apart.
    const intake = { city: "San Jose", zipCode: "95130", __clientLat: 37.2431, __clientLng: -121.8996 };
    const caregiver: CaregiverCandidate = {
      ...BASE_CAREGIVER, city: "San Jose", ...( { lat: 34.0522, lng: -118.2437 } as any), // Los Angeles
    };
    const { signals } = computeRuleSignals(caregiver, intake);
    expect(signals.distanceMiles).toBeGreaterThan(200);
  });
});
