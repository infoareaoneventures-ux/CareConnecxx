import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * U8 (hallucination hardening 2026-07-17, R11) — representative behavior test
 * for the escalator group: issueEscalator's family-facing briefings interpolate
 * the senior's name but cannot cheaply load the family session, so they carry
 * the explicit inline attribution line ("The reader is the family member
 * coordinating care; the care recipient is {name}.") instead of the
 * describeWhoIsWho helper.
 */

const issueDoc: { data: Record<string, unknown> | null; updates: any[] } = { data: null, updates: [] };

vi.mock("firebase-admin", () => {
  const makeDocRef = (): any => ({
    get: async () => ({
      exists: issueDoc.data !== null,
      data:   () => issueDoc.data,
      ref:    { update: async (d: any) => { issueDoc.updates.push(d); } },
    }),
    update: async () => {},
  });
  const collection = () => ({ doc: () => makeDocRef(), add: async () => ({ id: "a1" }) });
  const firestore = Object.assign(() => ({ collection }), { FieldValue: {} });
  const stub = { apps: [], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("../../utils/claudeClient", () => ({ getSharedClient: () => ({ messages: { create: vi.fn() } }) }));
vi.mock("../../linq/client", () => ({ sendToPhone: vi.fn(async () => {}) }));

const sendSpy = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendSpy(...a) }));

const genCalls: Array<{ audience: string; context: string; fallback: string }> = [];
vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async (opts: any) => { genCalls.push(opts); return opts.fallback; }),
}));

import { sendIssueFollowUp } from "../issueEscalator";

beforeEach(() => {
  issueDoc.data = null;
  issueDoc.updates.length = 0;
  genCalls.length = 0;
  sendSpy.mockClear();
});

describe("issueEscalator follow-up — who-is-who attribution (R11)", () => {
  it("family follow-up context attributes the care to the recipient, not the reader", async () => {
    issueDoc.data = {
      clientPhone:    "+15550001111",
      caregiverPhone: null,
      seniorName:     "Rosie",
      resolvedAt:     null,
      followUpSentAt: null,
    };

    await sendIssueFollowUp("issue1");

    const familyCall = genCalls.find((c) => c.audience === "family");
    expect(familyCall).toBeTruthy();
    expect(familyCall!.context).toContain(
      "The reader is the family member coordinating care; the care recipient is Rosie.",
    );
    // The attribution line rides in the SAME context that interpolates the name.
    expect(familyCall!.context).toContain("how Rosie is doing");
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
