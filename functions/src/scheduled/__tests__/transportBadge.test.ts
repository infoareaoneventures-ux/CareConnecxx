import { describe, it, expect, vi } from "vitest";

// Caregiver sweep C16 (2026-10-11): the nightly badge job computes "offers
// Transportation" exactly like the site's utils/transportDocs.ts — services
// when it has entries, else skills. The old `services || skills` took an EMPTY
// services array as the answer and never fell back to skills.

vi.mock("firebase-admin", () => {
  const firestore: any = Object.assign(() => ({ collection: () => ({}) }), { FieldValue: {} });
  return { __esModule: true, firestore, default: { firestore } };
});
vi.mock("firebase-functions/v1", () => {
  const builder: any = {
    pubsub: { schedule: () => ({ timeZone: () => ({ onRun: (h: any) => h }) }) },
    https: { onCall: (h: any) => h, HttpsError: class extends Error {} },
  };
  return { __esModule: true, ...builder, default: builder };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn() }));

import { transportationLive } from "../transportBadge";
import { caregiverOffersTransportation } from "../../agents/caregiverAccessGate";

describe("transportationLive — one rule with utils/transportDocs.ts", () => {
  it("services set → services decide", () => {
    expect(transportationLive({ services: ["Transportation"], skills: [], isApprovedDriver: true })).toBe(true);
    expect(transportationLive({ services: ["Companionship"], skills: ["Transportation"], isApprovedDriver: true })).toBe(false); // a stale skills array no longer counts
  });
  it("services empty + skills set → skills decide (the case the old job got wrong)", () => {
    expect(transportationLive({ services: [], skills: ["Transportation"], isApprovedDriver: true })).toBe(true);
    expect(caregiverOffersTransportation({ services: [], skills: ["Transportation"] })).toBe(true);
  });
  it("both empty → not offered; and never live without the driving record", () => {
    expect(transportationLive({ services: [], skills: [], isApprovedDriver: true })).toBe(false);
    expect(transportationLive({ isApprovedDriver: true })).toBe(false);
    expect(transportationLive({ services: ["Transportation"], isApprovedDriver: false })).toBe(false);
    expect(transportationLive({ skills: ["Transportation"] })).toBe(false);
  });
});
