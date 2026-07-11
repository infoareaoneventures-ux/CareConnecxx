import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({ collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({}) }) }) }) });
  firestore.FieldValue = { delete: () => ({ __delete: true }) };
  const stub = { apps: [{}], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

import { pickBackgroundPII, CAREGIVER_PII_BACKGROUND_FIELDS } from "./caregiverPrivate";

describe("pickBackgroundPII", () => {
  it("keeps only the known PII fields with defined values", () => {
    const out = pickBackgroundPII({
      legalFirstName: "Jane",
      legalLastName: "Doe",
      zip: "95050",
      // operational fields that must NOT be treated as PII:
      status: "pending",
      checkrCandidateId: "cand_123",
      invitationStatus: "sent",
    });
    expect(out).toEqual({ legalFirstName: "Jane", legalLastName: "Doe", zip: "95050" });
  });

  it("drops null/undefined PII values", () => {
    const out = pickBackgroundPII({ legalFirstName: "Jane", legalLastName: null, dob: undefined, zip: "95050" });
    expect(out).toEqual({ legalFirstName: "Jane", zip: "95050" });
  });

  it("returns {} for empty/absent input", () => {
    expect(pickBackgroundPII(undefined)).toEqual({});
    expect(pickBackgroundPII(null)).toEqual({});
    expect(pickBackgroundPII({})).toEqual({});
    expect(pickBackgroundPII({ status: "pending", checkrCandidateId: "x" })).toEqual({});
  });

  it("covers exactly the identity PII fields (guards against scope drift)", () => {
    expect([...CAREGIVER_PII_BACKGROUND_FIELDS].sort()).toEqual(
      ["dob", "legalFirstName", "legalLastName", "ssnLastFour", "zip"].sort(),
    );
  });
});
