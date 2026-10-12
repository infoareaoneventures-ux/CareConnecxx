import { describe, it, expect, vi, beforeEach } from "vitest";

// The ONE rule for a job post's point (2026-10-11): the Care Plan location's
// saved street-level coords, else the street geocoded now, else ZIP/city —
// marked with geoPrecision so a backfill can find the coarse ones.

const geocodeAddress = vi.fn();
vi.mock("../../utils/geocode", () => ({ geocodeAddress: (...a: unknown[]) => geocodeAddress(...a) }));

import { poolEntryStreetPoint, resolveJobPostPoint } from "../jobPostCoords";

const STREET_ENTRY = { street: "123 Main St", city: "San Jose", state: "CA", zipCode: "95110", lat: 37.3361, lng: -121.8905, geoPrecision: "street" };
const ZIP_ENTRY    = { street: "456 Oak Ave", city: "San Jose", state: "CA", zipCode: "95112", lat: 37.35, lng: -121.88, geoPrecision: "zip" };
const UNMARKED     = { street: "789 Pine Rd", city: "San Jose", state: "CA", zipCode: "95113", lat: 37.34, lng: -121.89 };

beforeEach(() => geocodeAddress.mockReset());

describe("poolEntryStreetPoint", () => {
  it("returns the matching entry's point only when it is street-level (case-insensitive street + zip match)", () => {
    const pool = [ZIP_ENTRY, STREET_ENTRY, UNMARKED];
    expect(poolEntryStreetPoint(pool, "123 MAIN st", "95110")).toEqual({ lat: 37.3361, lng: -121.8905, geoPrecision: "street" });
    expect(poolEntryStreetPoint(pool, "456 Oak Ave", "95112")).toBeNull();   // ZIP-level: re-derive
    expect(poolEntryStreetPoint(pool, "789 Pine Rd", "95113")).toBeNull();   // legacy, unmarked: re-derive
    expect(poolEntryStreetPoint(pool, "1 Nowhere", "95110")).toBeNull();
    expect(poolEntryStreetPoint(undefined, "123 Main St", "95110")).toBeNull();
    expect(poolEntryStreetPoint(pool, "", "95110")).toBeNull();
  });
});

describe("resolveJobPostPoint", () => {
  it("uses the Care Plan location's street-level point without geocoding", async () => {
    const point = await resolveJobPostPoint([STREET_ENTRY], { street: "123 Main St", city: "San Jose", state: "CA", zipCode: "95110" });
    expect(point).toEqual({ lat: 37.3361, lng: -121.8905, geoPrecision: "street" });
    expect(geocodeAddress).not.toHaveBeenCalled();
  });

  it("falls back to geocoding the full street (the one server geocoder) when the pool has no street-level point", async () => {
    geocodeAddress.mockResolvedValue({ lat: 37.3511, lng: -121.8822, geoPrecision: "street" });
    const point = await resolveJobPostPoint([ZIP_ENTRY], { street: "456 Oak Ave", city: "San Jose", state: "CA", zipCode: "95112" });
    expect(geocodeAddress).toHaveBeenCalledWith({ street: "456 Oak Ave", city: "San Jose", state: "CA", zipCode: "95112" });
    expect(point).toEqual({ lat: 37.3511, lng: -121.8822, geoPrecision: "street" });
  });

  it("the geocoder's ZIP fallback is passed through as 'zip' (never mislabelled street)", async () => {
    geocodeAddress.mockResolvedValue({ lat: 37.35, lng: -121.88, geoPrecision: "zip" });
    const point = await resolveJobPostPoint([], { city: "San Jose", state: "CA", zipCode: "95112" });
    expect(point?.geoPrecision).toBe("zip");
  });

  it("returns null when nothing geocodes", async () => {
    geocodeAddress.mockResolvedValue(null);
    expect(await resolveJobPostPoint([], { city: "", zipCode: "" })).toBeNull();
  });
});
