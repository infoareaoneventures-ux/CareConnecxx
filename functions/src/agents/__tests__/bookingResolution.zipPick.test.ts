import { describe, it, expect, vi } from "vitest";
vi.mock("firebase-admin", () => { const stub = { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => ({ collection: () => ({}) }), { FieldPath: { documentId: () => "id" }, FieldValue: {}, Timestamp: {} }) }; return { __esModule: true, default: stub, ...stub }; });
import { pickPoolAddressByZip } from "../bookingResolution";

const santaClara = { street: "Boulevard Ave", city: "Santa Clara", state: "CA", zipCode: "95050" };
const gilroy = { street: "100 Test Lane", city: "Gilroy", state: "CA", zipCode: "95020" };

describe("pickPoolAddressByZip", () => {
  it("picks the one saved address in the job post's ZIP", () => {
    expect(pickPoolAddressByZip([santaClara, gilroy] as any, "95020")).toEqual(gilroy);
  });
  it("returns null when none or more than one match, or no ZIP is known", () => {
    expect(pickPoolAddressByZip([santaClara, gilroy] as any, "94000")).toBeNull();
    expect(pickPoolAddressByZip([gilroy, { ...gilroy, street: "9 Other St" }] as any, "95020")).toBeNull();
    expect(pickPoolAddressByZip([santaClara, gilroy] as any, undefined)).toBeNull();
  });
});
