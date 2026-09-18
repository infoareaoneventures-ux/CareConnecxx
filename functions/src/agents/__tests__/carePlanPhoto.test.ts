// set_recipient_photo = CarePlan.tsx handleRecipientPhotoUpload over text: the
// attached photo lands in the page's own storage folder and roster field.
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const sets: Array<{ path: string; data: any; opts?: any }> = [];
  const makeDoc = (path: string): any => ({
    id: path.split("/").pop(),
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data, opts });
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => { docState.set(path, { ...(docState.get(path) ?? {}), ...data }); }),
  });
  const coll = (path: string): any => ({ doc: (id: string) => makeDoc(`${path}/${id}`) });
  return { docState, sets, coll, reset: () => { docState.clear(); sets.length = 0; } };
});
vi.mock("firebase-admin", () => ({
  firestore: Object.assign(() => ({ collection: hoisted.coll }), {
    FieldValue: { arrayUnion: (...v: any[]) => ({ __arrayUnion: v }), delete: () => ({ __delete: true }), serverTimestamp: () => ({ __serverTimestamp: true }) },
  }),
  storage: () => ({ bucket: () => ({ name: "test-bucket", file: () => ({ save: vi.fn(async () => undefined) }) }) }),
}));
vi.mock("../../utils/geocode", () => ({ geocodeStreetAddress: vi.fn(async () => null), lookupZipPlace: vi.fn(async () => null) }));

import { setRecipientPhoto } from "../carePlanPage";

const CLIENT = "client-uid";
const SOURCE = "https://firebasestorage.googleapis.com/v0/b/x/o/profile_photos%2F1_1.jpg?alt=media&token=t";
const deps = {
  fetchImage: vi.fn(async () => ({ buffer: Buffer.from("jpg"), content_type: "image/jpeg", ext: "jpg" })),
  storeImage: vi.fn(async (path: string) => `https://firebasestorage.googleapis.com/v0/b/test-bucket/o/${encodeURIComponent(path)}?alt=media&token=tok`),
};

const seedRoster = (extra: Record<string, unknown> = {}) => hoisted.docState.set(`job_postings/${CLIENT}`, {
  careRecipientFirstName: "Samira", careRecipientLastName: "M", relationship: "Parent", careRecipientAge: "22", ...extra,
});

beforeEach(() => { hoisted.reset(); deps.fetchImage.mockClear(); deps.storeImage.mockClear(); });

describe("setRecipientPhoto", () => {
  it("primary recipient → the page's folder clients/{uid}/recipients/recipient_0_… and job_postings.careRecipientPhotoURL", async () => {
    seedRoster();
    const r = await setRecipientPhoto(CLIENT, { sourceUrl: SOURCE }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipient.firstName).toBe("Samira");
    expect(r.storagePath).toMatch(new RegExp(`^clients/${CLIENT}/recipients/recipient_0_\\d+\\.jpg$`));
    expect(deps.fetchImage).toHaveBeenCalledWith(SOURCE);
    const jp = hoisted.sets.find((s) => s.path === `job_postings/${CLIENT}`);
    expect(jp?.data).toEqual({ careRecipientPhotoURL: r.photoURL });
    expect(jp?.opts).toEqual({ merge: true });
  });

  it("additional recipient → recipient_{i+1} and additionalRecipients[i].photoURL, the rest untouched", async () => {
    seedRoster({ additionalRecipients: [{ firstName: "Imran", lastName: "Mohammed", relationship: "Sibling", age: "30" }, { firstName: "Ali", lastName: "K", relationship: "Uncle" }] });
    const r = await setRecipientPhoto(CLIENT, { firstName: "Imran", sourceUrl: SOURCE }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.storagePath).toMatch(/recipient_1_\d+\.jpg$/);
    const jp = hoisted.sets.find((s) => s.path === `job_postings/${CLIENT}`);
    expect(jp?.data.additionalRecipients).toEqual([
      { firstName: "Imran", lastName: "Mohammed", relationship: "Sibling", age: "30", photoURL: r.photoURL },
      { firstName: "Ali", lastName: "K", relationship: "Uncle" },
    ]);
  });

  it("several recipients and no name → asks which, listing them (nothing uploaded)", async () => {
    seedRoster({ additionalRecipients: [{ firstName: "Imran", lastName: "Mohammed", relationship: "Sibling" }] });
    const r = await setRecipientPhoto(CLIENT, { sourceUrl: SOURCE }, deps);
    expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT", options: ["Samira M", "Imran Mohammed"] });
    expect(deps.fetchImage).not.toHaveBeenCalled();
  });

  it("unknown name → NOT_FOUND with the names on file; no recipients → NOT_FOUND; no photo → INVALID_INPUT", async () => {
    seedRoster();
    expect(await setRecipientPhoto(CLIENT, { firstName: "Zed", sourceUrl: SOURCE }, deps)).toMatchObject({ ok: false, code: "NOT_FOUND", options: ["Samira M"] });
    expect(await setRecipientPhoto(CLIENT, { sourceUrl: "" }, deps)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    hoisted.reset();
    expect(await setRecipientPhoto(CLIENT, { sourceUrl: SOURCE }, deps)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});
