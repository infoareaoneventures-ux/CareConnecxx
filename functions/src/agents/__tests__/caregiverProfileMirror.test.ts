// The caregiver record mirror (caregiverProfileMirror.ts) — caregiver sweep
// C3/C4/C7 (2026-10-11): the site's field names, wizardStep never backwards,
// merge-not-overwrite, coords never mirrored (the geocode trigger owns them).
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  sets: [] as Array<{ path: string; data: any; opts?: any }>,
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({ exists: hoisted.docs.has(`${name}/${id}`), data: () => hoisted.docs.get(`${name}/${id}`) }),
        set: async (data: any, opts?: any) => {
          hoisted.sets.push({ path: `${name}/${id}`, data, opts });
          hoisted.docs.set(`${name}/${id}`, { ...(opts?.merge ? hoisted.docs.get(`${name}/${id}`) ?? {} : {}), ...data });
        },
      }),
    }),
  }), { FieldValue: { delete: () => "__delete__" } });
  return { __esModule: true, default: { firestore }, firestore };
});

import {
  buildCaregiverProfileMirror,
  profileMirrorForExisting,
  wizardStepForDraft,
  mirrorCaregiverDraftToRecord,
  toMaxClients,
} from "../caregiverProfileMirror";

const FULL = {
  name: "Maria Lopez", phone: "+15551112222", street: "1 Main St", zipCode: "95110", city: "San Jose", state: "CA",
  profilePhoto: "https://storage/profile-photos/caregivers/u1",
  jobType: ["part_time", "full_time"],
  availability: { days: ["Monday", "Tuesday"], hours: "mornings" },
  specialties: ["Personal Care"], skills: ["Personal Care"], services: ["Personal Care"],
  yearsExperience: "3-5 years",
  hourlyRate: 24, serviceRadius: 10, rateFor2Seniors: 30, rateFor3PlusSeniors: 35, maxClients: "2",
  email: "maria@example.com", bio: "x".repeat(160),
  lat: 37.33, lng: -121.89,
};

beforeEach(() => { hoisted.docs.clear(); hoisted.sets.length = 0; });

describe("buildCaregiverProfileMirror — the site's field names (C7)", () => {
  it("writes jobTypes (hyphenated, one or many) and never a singular jobType on the record", () => {
    const out = buildCaregiverProfileMirror(FULL);
    expect(out.jobTypes).toEqual(["part-time", "full-time"]);
    expect(out).not.toHaveProperty("jobType");
    expect(buildCaregiverProfileMirror({ jobType: "occasional" }).jobTypes).toEqual(["occasional"]);
  });
  it("writes weeklyAvailability (the grid) and not Evia's own availability answer", () => {
    const out = buildCaregiverProfileMirror(FULL);
    expect(out.weeklyAvailability).toBeTruthy();
    expect(out).not.toHaveProperty("availability");
    // half an answer → no grid at all
    expect(buildCaregiverProfileMirror({ availability: { days: ["Monday"], hours: "" } })).not.toHaveProperty("weeklyAvailability");
  });
  it("writes the rates step under the profile page's names and the photo as `photo` (+ reader mirrors)", () => {
    const out = buildCaregiverProfileMirror(FULL);
    expect(out).toMatchObject({ hourlyRate: 24, serviceRadius: 10, rateFor2Seniors: 30, rateFor3PlusSeniors: 35, maxClients: "2" });
    expect(out).not.toHaveProperty("rateForTwo");
    expect(out).not.toHaveProperty("rateForThree");
    expect(out.photo).toBe(FULL.profilePhoto);
    expect(out.photoURL).toBe(FULL.profilePhoto);
    expect(out.profilePhoto).toBe(FULL.profilePhoto);
    expect(out.wizardStep).toBe("done");
  });
  it("toMaxClients → the site's select values", () => {
    expect(toMaxClients("3+")).toBe("3+");
    expect(toMaxClients(5)).toBe("3+");
    expect(toMaxClients("2")).toBe("2");
    expect(toMaxClients("one")).toBeNull();
  });
  it("wizardStepForDraft accepts one or many job types", () => {
    expect(wizardStepForDraft({ ...FULL, jobType: undefined })).toBe("availability");
    expect(wizardStepForDraft({ ...FULL, jobType: "occasional" })).toBe("done");
  });
});

describe("profileMirrorForExisting — merge, never overwrite (C4)", () => {
  const mirror = buildCaregiverProfileMirror(FULL);

  it("a brand-new record takes everything", () => {
    expect(profileMirrorForExisting(mirror, {})).toEqual(mirror);
  });
  it("with no changed keys (re-link / payout finalization) only fields the record lacks are filled — a site edit survives", () => {
    const existing = { bio: "Edited on the site.", hourlyRate: 40, name: "Maria L." };
    const out = profileMirrorForExisting(mirror, existing);
    expect(out).not.toHaveProperty("bio");
    expect(out).not.toHaveProperty("hourlyRate");
    expect(out).not.toHaveProperty("name");
    expect(out.email).toBe("maria@example.com"); // missing → filled
    expect(out.jobTypes).toEqual(["part-time", "full-time"]);
  });
  it("a field collected THIS save is rewritten; the rest of the record is left alone", () => {
    const existing = { bio: "Edited on the site.", hourlyRate: 40 };
    const out = profileMirrorForExisting(mirror, existing, ["bio"]);
    expect(out.bio).toBe(FULL.bio);
    expect(out).not.toHaveProperty("hourlyRate");
  });
  it("derived fields follow their source: services saved → skills/services/primaryServices flow; experience saved → experience + primaryServices", () => {
    const existing = { skills: ["Companionship"], services: ["Companionship"], primaryServices: [{ name: "Companionship", yearsExperience: "1-2 years" }], yearsExperience: "1-2 years", experience: "1-2 years" };
    const a = profileMirrorForExisting(mirror, existing, ["specialties", "skills", "services"]);
    expect(a.skills).toEqual(["Personal Care"]);
    expect(a.services).toEqual(["Personal Care"]);
    expect(a.primaryServices).toEqual([{ name: "Personal Care", yearsExperience: "3-5 years" }]);
    expect(a).not.toHaveProperty("yearsExperience");
    const b = profileMirrorForExisting(mirror, existing, ["yearsExperience"]);
    expect(b.yearsExperience).toBe("3-5 years");
    expect(b.experience).toBe("3-5 years");
    expect(b.primaryServices).toBeTruthy();
    expect(b).not.toHaveProperty("skills");
  });
  it("the grid the site holds is re-derived only when the availability answer changed this save", () => {
    const siteGrid = { monday: [{ start: "06:00", end: "12:00" }], friday: [{ start: "12:00", end: "18:00" }] };
    expect(profileMirrorForExisting(mirror, { weeklyAvailability: siteGrid }, ["bio"])).not.toHaveProperty("weeklyAvailability");
    expect(profileMirrorForExisting(mirror, { weeklyAvailability: siteGrid }, ["availability"]).weeklyAvailability).toEqual(mirror.weeklyAvailability);
    expect(profileMirrorForExisting(mirror, { weeklyAvailability: {} }).weeklyAvailability).toEqual(mirror.weeklyAvailability); // empty grid = none → filled
  });
  it("coords are never mirrored (2026-10-11): triggers/caregiverGeocode.ts owns lat/lng from the street fields the mirror writes", () => {
    for (const k of ["lat", "lng", "latitude", "longitude", "geoPrecision"]) expect(mirror).not.toHaveProperty(k);
    expect(mirror.street).toBe("1 Main St");
    const existing = { lat: 37.3361, lng: -121.8905, latitude: 37.3361, longitude: -121.8905, geoPrecision: "street" };
    const out = profileMirrorForExisting(mirror, existing, ["street", "zipCode", "lat", "lng"]);
    for (const k of ["lat", "lng", "latitude", "longitude", "geoPrecision"]) expect(out).not.toHaveProperty(k);
    expect(profileMirrorForExisting(mirror, {})).not.toHaveProperty("lat");
  });
  it("wizardStep never moves backwards; dropped once the record is profile_complete", () => {
    const early = buildCaregiverProfileMirror({ street: "1 Main St", zipCode: "95110", city: "San Jose", state: "CA" }); // → photo
    expect(early.wizardStep).toBe("photo");
    expect(profileMirrorForExisting(early, { wizardStep: "rates" }, ["street"])).not.toHaveProperty("wizardStep");
    expect(profileMirrorForExisting(early, { wizardStep: "location" }, ["street"]).wizardStep).toBe("photo");
    expect(profileMirrorForExisting(early, { wizardStep: "photo" }, ["street"])).not.toHaveProperty("wizardStep"); // equal: nothing to rewrite
    expect(profileMirrorForExisting(early, {}).wizardStep).toBe("photo");
    expect(profileMirrorForExisting(early, { wizardStep: "transport-docs" })).not.toHaveProperty("wizardStep"); // legacy id = rates
    expect(profileMirrorForExisting(mirror, { onboardingStatus: "profile_complete", wizardStep: "done" }, ["bio"])).not.toHaveProperty("wizardStep");
  });
});

describe("mirrorCaregiverDraftToRecord — the one write (C3)", () => {
  it("writes the merged draft's changed fields onto caregivers/{uid} in the site's shape", async () => {
    hoisted.docs.set("caregivers/u1", { name: "Maria Lopez", wizardStep: "rates", hourlyRate: 40 });
    const patch = await mirrorCaregiverDraftToRecord("u1", FULL, ["bio"]);
    expect(patch.bio).toBe(FULL.bio);
    expect(patch).not.toHaveProperty("hourlyRate");
    expect(patch.wizardStep).toBe("done");
    expect(hoisted.sets[0]).toMatchObject({ path: "caregivers/u1", opts: { merge: true } });
    expect(hoisted.docs.get("caregivers/u1")).toMatchObject({ bio: FULL.bio, hourlyRate: 40, jobTypes: ["part-time", "full-time"], wizardStep: "done" });
  });
  it("writes nothing when nothing changed", async () => {
    hoisted.docs.set("caregivers/u1", buildCaregiverProfileMirror(FULL));
    const patch = await mirrorCaregiverDraftToRecord("u1", FULL, ["bio"]);
    expect(Object.keys(patch)).toEqual(["bio"]); // same value, rewritten (changed this save) — one field, no clobber elsewhere
    hoisted.sets.length = 0;
    const none = await mirrorCaregiverDraftToRecord("u1", FULL);
    expect(none).toEqual({});
    expect(hoisted.sets).toHaveLength(0);
  });
});
