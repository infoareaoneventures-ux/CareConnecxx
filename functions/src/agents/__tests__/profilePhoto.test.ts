// The family's profile photo over text lands exactly where AccountSettings.tsx
// handlePhotoUpload puts it: storage profile_photos/{uid}/profile, then
// users.photoURL + senior_profiles/{uid}.imageUrl + the Auth photoURL.
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const sets: Array<{ path: string; data: any; opts?: any }> = [];
  const updateUser = vi.fn(async () => ({}));
  return { sets, updateUser };
});
vi.mock("firebase-admin", () => ({
  firestore: () => ({
    collection: (c: string) => ({
      doc: (id: string) => ({ set: async (data: any, opts?: any) => { hoisted.sets.push({ path: `${c}/${id}`, data, opts }); } }),
    }),
  }),
  auth: () => ({ updateUser: hoisted.updateUser }),
}));
vi.mock("../carePlanPage", () => ({ defaultPhotoDeps: {} }));

import { setClientProfilePhoto } from "../profilePhoto";

const deps = {
  fetchImage: vi.fn(async () => ({ buffer: Buffer.from("img"), content_type: "image/png", ext: "png" })),
  storeImage: vi.fn(async (path: string) => `https://firebasestorage.googleapis.com/v0/b/x/o/${encodeURIComponent(path)}?alt=media&token=t`),
};

beforeEach(() => { hoisted.sets.length = 0; hoisted.updateUser.mockClear(); deps.fetchImage.mockClear(); deps.storeImage.mockClear(); });

describe("setClientProfilePhoto — the site's Account Settings upload, by attachment", () => {
  it("stores under profile_photos/{uid}/profile and writes the site's three targets", async () => {
    const r = await setClientProfilePhoto("u1", "https://media.example/a.png", deps);
    expect(deps.fetchImage).toHaveBeenCalledWith("https://media.example/a.png");
    expect(deps.storeImage).toHaveBeenCalledWith("profile_photos/u1/profile", expect.any(Buffer), "image/png");
    expect(r.photoURL).toContain("profile_photos%2Fu1%2Fprofile");
    expect(hoisted.sets).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "users/u1", data: { photoURL: r.photoURL }, opts: { merge: true } }),
      expect.objectContaining({ path: "senior_profiles/u1", data: { imageUrl: r.photoURL }, opts: { merge: true } }),
    ]));
    expect(hoisted.updateUser).toHaveBeenCalledWith("u1", { photoURL: r.photoURL });
  });

  it("a typed word is never a photo — nothing is fetched or written", async () => {
    await expect(setClientProfilePhoto("u1", "skipped", deps)).rejects.toThrow(/http/);
    expect(deps.fetchImage).not.toHaveBeenCalled();
    expect(hoisted.sets).toEqual([]);
  });
});
