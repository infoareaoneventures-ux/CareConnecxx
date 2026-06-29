import { describe, it, expect } from "vitest";
import {
  isInServiceArea,
  serviceAreaStatus,
  normalizeCity,
  extractZip,
  SANTA_CLARA_COUNTY_ZIPS,
  SANTA_CLARA_COUNTY_CITIES,
} from "./serviceArea";

describe("serviceArea — Santa Clara County gate", () => {
  it("accepts in-county ZIPs", () => {
    for (const z of ["95110", "94301", "95014", "94086", "95035", "95020"]) {
      expect(isInServiceArea({ zip: z })).toBe(true);
    }
  });

  it("rejects out-of-county ZIPs", () => {
    for (const z of ["94601" /*Oakland*/, "95060" /*Santa Cruz*/, "94102" /*SF*/, "90001" /*LA*/]) {
      expect(isInServiceArea({ zip: z })).toBe(false);
    }
  });

  it("accepts in-county cities (and aliases), case-insensitive", () => {
    for (const c of ["San Jose", "san jose", "SJ", "Sunnyvale", "Palo Alto", "Los Gatos", "Cupertino"]) {
      expect(isInServiceArea({ city: c })).toBe(true);
    }
  });

  it("rejects out-of-county cities", () => {
    for (const c of ["Oakland", "San Francisco", "Santa Cruz", "Fremont", "Hayward"]) {
      expect(isInServiceArea({ city: c })).toBe(false);
    }
  });

  it("ZIP is authoritative over city text and tolerates 'City, CA 95110' format", () => {
    expect(isInServiceArea({ city: "San Jose, CA 95125" })).toBe(true);
    // out-of-area ZIP embedded → out of area even if city words look local
    expect(isInServiceArea({ city: "San Jose", zip: "94601" })).toBe(false);
  });

  it("extractZip pulls a 5-digit zip from free text", () => {
    expect(extractZip("Austin, TX 95110")).toBe("95110");
    expect(extractZip("95014-1234")).toBe("95014");
    expect(extractZip("no zip here")).toBe("");
  });

  it("normalizeCity lowercases and strips trailing detail", () => {
    expect(normalizeCity("  Palo Alto, CA 94301 ")).toBe("palo alto");
    expect(normalizeCity("SAN JOSE")).toBe("san jose");
  });

  it("serviceAreaStatus distinguishes in/out/unknown", () => {
    expect(serviceAreaStatus({ zip: "95110" })).toBe("in_area");
    expect(serviceAreaStatus({ zip: "94601" })).toBe("out_of_area");
    expect(serviceAreaStatus({ city: "San Jose" })).toBe("in_area");
    expect(serviceAreaStatus({ city: "Oakland" })).toBe("out_of_area");
    expect(serviceAreaStatus({ city: "", zip: "" })).toBe("unknown");
    expect(serviceAreaStatus({ city: "asdfghjkl" })).toBe("out_of_area"); // unrecognized city name
  });

  it("data sets are non-trivially populated", () => {
    expect(SANTA_CLARA_COUNTY_ZIPS.size).toBeGreaterThan(40);
    expect(SANTA_CLARA_COUNTY_CITIES.has("san jose")).toBe(true);
  });
});
