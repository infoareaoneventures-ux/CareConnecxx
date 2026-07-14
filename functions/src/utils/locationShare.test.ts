import { describe, it, expect } from "vitest";
import { extractLocationPart, reverseGeocode, canRequestNativeLocation } from "./locationShare";

describe("locationShare", () => {
  describe("extractLocationPart", () => {
    it("reads a native structured location part (latitude/longitude)", () => {
      const loc = extractLocationPart([
        { type: "location", latitude: 30.2672, longitude: -97.7431, name: "Austin" },
      ]);
      expect(loc).toEqual({ lat: 30.2672, lng: -97.7431, label: "Austin" });
    });

    it("reads a nested location object with lat/lng", () => {
      const loc = extractLocationPart([
        { type: "location_share", location: { lat: 40.7128, lng: -74.006 } },
      ]);
      expect(loc).toMatchObject({ lat: 40.7128, lng: -74.006 });
    });

    it("parses an Apple Maps link part (?ll=)", () => {
      const loc = extractLocationPart([
        { type: "link", url: "https://maps.apple.com/?ll=37.7749,-122.4194&q=Pin" },
      ]);
      expect(loc).toMatchObject({ lat: 37.7749, lng: -122.4194 });
    });

    it("parses a Google Maps ?q= link part", () => {
      const loc = extractLocationPart([
        { type: "rich_link", value: "https://www.google.com/maps?q=34.0522,-118.2437" },
      ]);
      expect(loc).toMatchObject({ lat: 34.0522, lng: -118.2437 });
    });

    it("parses a Google Maps /@lat,lng path", () => {
      const loc = extractLocationPart([
        { type: "link", url: "https://www.google.com/maps/@41.8781,-87.6298,15z" },
      ]);
      expect(loc).toMatchObject({ lat: 41.8781, lng: -87.6298 });
    });

    it("parses a bare geo: URI", () => {
      const loc = extractLocationPart([
        { type: "media", url: "geo:47.6062,-122.3321" },
      ]);
      expect(loc).toMatchObject({ lat: 47.6062, lng: -122.3321 });
    });

    it("returns null for a text-only part", () => {
      expect(extractLocationPart([{ type: "text", value: "I'm in Austin TX" }])).toBeNull();
    });

    it("returns null for out-of-range coordinates", () => {
      expect(extractLocationPart([{ type: "location", latitude: 200, longitude: 999 }])).toBeNull();
    });

    it("returns null for an empty parts array", () => {
      expect(extractLocationPart([])).toBeNull();
    });
  });

  describe("reverseGeocode", () => {
    it("returns null for invalid coordinates without calling the network", async () => {
      const r = await reverseGeocode(NaN, NaN);
      expect(r).toBeNull();
    });
  });

  describe("canRequestNativeLocation", () => {
    it("allows 1:1 iMessage", () => {
      expect(canRequestNativeLocation({ service: "iMessage" })).toBe(true);
    });

    it("rejects RCS and SMS", () => {
      expect(canRequestNativeLocation({ service: "RCS" })).toBe(false);
      expect(canRequestNativeLocation({ service: "SMS" })).toBe(false);
    });

    it("rejects iMessage group chats (groupChatId present)", () => {
      expect(canRequestNativeLocation({ service: "iMessage", groupChatId: "grp_1" })).toBe(false);
    });

    it("rejects a missing/unknown service (safe default to typed ask)", () => {
      expect(canRequestNativeLocation({})).toBe(false);
      expect(canRequestNativeLocation(null)).toBe(false);
      expect(canRequestNativeLocation(undefined)).toBe(false);
    });
  });
});
