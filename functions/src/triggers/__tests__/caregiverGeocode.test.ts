import { describe, it, expect, vi, beforeEach } from "vitest";

// triggers/caregiverGeocode.ts is THE owner of caregivers/{uid}.lat/lng
// (2026-10-11): street-first through the one server geocoder
// (utils/geocode.ts geocodeAddress), geoPrecision stamped, re-run only when
// the address changed or coords are missing (so its own update never loops).

const hoisted = vi.hoisted(() => ({
  updates: [] as Array<{ path: string; data: any }>,
}));

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        update: vi.fn(async (data: any) => { hoisted.updates.push({ path: `${name}/${id}`, data }); }),
      }),
    }),
  }), { FieldValue: {} });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("firebase-functions/v1", () => ({
  firestore: { document: () => ({ onWrite: (fn: unknown) => fn }) },
  config: () => ({}),
}));
const geocodeAddress = vi.fn();
vi.mock("../../utils/geocode", () => ({ geocodeAddress: (...a: unknown[]) => geocodeAddress(...a) }));

import { geocodeCaregiverDoc } from "../caregiverGeocode";

const run = (before: Record<string, unknown> | null, after: Record<string, unknown> | null) =>
  (geocodeCaregiverDoc as unknown as (change: any, context: any) => Promise<void>)(
    {
      before: { exists: before !== null, data: () => before ?? undefined },
      after:  { exists: after !== null,  data: () => after ?? undefined },
    },
    { params: { uid: "cg1" } },
  );

const ADDRESS = { street: "123 Main St", city: "San Jose", state: "CA", zipCode: "95110" };

beforeEach(() => { hoisted.updates.length = 0; geocodeAddress.mockReset(); });

describe("geocodeCaregiverDoc — one owner, street first", () => {
  it("geocodes the FULL street address (not just the ZIP) on a new record and stamps geoPrecision 'street'", async () => {
    geocodeAddress.mockResolvedValue({ lat: 37.3361, lng: -121.8905, geoPrecision: "street" });
    await run(null, { ...ADDRESS, name: "Maria" });
    expect(geocodeAddress).toHaveBeenCalledWith(ADDRESS);
    expect(hoisted.updates).toEqual([{
      path: "caregivers/cg1",
      data: { lat: 37.3361, lng: -121.8905, latitude: 37.3361, longitude: -121.8905, geoPrecision: "street" },
    }]);
  });

  it("re-geocodes when the address changes, even though ZIP-level coords are already on the record (Evia's mirror once wrote those)", async () => {
    geocodeAddress.mockResolvedValue({ lat: 37.3361, lng: -121.8905, geoPrecision: "street" });
    await run({ city: "San Jose", zipCode: "95110", lat: 37.33, lng: -121.89 }, { ...ADDRESS, lat: 37.33, lng: -121.89 });
    expect(geocodeAddress).toHaveBeenCalledTimes(1);
    expect(hoisted.updates[0].data.geoPrecision).toBe("street");
  });

  it("its own coordinate update does not re-trigger a geocode (no address change, coords present)", async () => {
    const withCoords = { ...ADDRESS, lat: 37.3361, lng: -121.8905, latitude: 37.3361, longitude: -121.8905, geoPrecision: "street" };
    await run(ADDRESS, withCoords);
    expect(geocodeAddress).not.toHaveBeenCalled();
    expect(hoisted.updates).toEqual([]);
  });

  it("fills a record that lacks coords on any write (a bio save), marking the fallback honestly as 'zip'", async () => {
    geocodeAddress.mockResolvedValue({ lat: 37.35, lng: -121.88, geoPrecision: "zip" });
    await run({ ...ADDRESS, bio: "a" }, { ...ADDRESS, bio: "ab" });
    expect(hoisted.updates[0].data).toMatchObject({ geoPrecision: "zip" });
  });

  it("writes nothing when there is no city or ZIP, or when geocoding fails", async () => {
    await run(null, { name: "No address" });
    geocodeAddress.mockResolvedValue(null);
    await run(null, ADDRESS);
    expect(hoisted.updates).toEqual([]);
  });
});
