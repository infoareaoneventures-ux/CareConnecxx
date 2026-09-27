import { describe, it, expect, vi, beforeEach } from "vitest";

// The interview-identity guard: catches Evia's own reply naming a different
// caregiver than the one a just-succeeded schedule_interview call actually
// targeted (2026-09-06 live bug — confirmed via Firestore the tool created
// the interview with a different caregiver than the reply named). Self-
// corrects: cancels the wrongly-created interview, notifies the wrongly-
// targeted caregiver, pages ops, and replaces the outgoing reply.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const updates: Array<{ path: string; data: any }> = [];
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      const prev = docState.get(path) ?? {};
      docState.set(path, { ...prev, ...data });
    }),
  });
  const makeCollRef = (path: string): any => ({ doc: (id: string) => makeDocRef(`${path}/${id}`) });
  return {
    docState, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: () => ({ __delete: true }), serverTimestamp: () => ({ __serverTimestamp: true }) },
  }),
}));

const quickComplete = vi.fn(async () => "NO");
vi.mock("../utils/openaiClient", () => ({ quickComplete: (...a: unknown[]) => (quickComplete as any)(...a) }));

const createCaraOpsAlert = vi.fn(async () => true);
vi.mock("../observability/caraOpsAlerts", () => ({ createCaraOpsAlert: (...a: unknown[]) => (createCaraOpsAlert as any)(...a) }));

const sendToPhone = vi.fn(async () => {});
vi.mock("../linq/client", () => ({ sendToPhone: (...a: unknown[]) => (sendToPhone as any)(...a) }));

import { guardInterviewIdentityConsistency } from "./interviewIdentityGuard";

const IV_ID = "iv_1";
const CAREGIVER_ID = "cg_imran";
const PHONE = "+15551234567";

beforeEach(() => {
  hoisted.reset();
  quickComplete.mockReset().mockResolvedValue("NO");
  createCaraOpsAlert.mockClear();
  sendToPhone.mockClear();
  hoisted.docState.set(`caregivers/${CAREGIVER_ID}`, { name: "Imran", phone: "+15559998888" });
});

describe("guardInterviewIdentityConsistency", () => {
  it("passes the reply through unchanged when it names the actual caregiver (or no one)", async () => {
    const reply = await guardInterviewIdentityConsistency({
      reply: "Yes, I sent Imran the interview request for tomorrow at 9am.",
      interviewId: IV_ID, caregiverId: CAREGIVER_ID, caregiverName: "Imran", phone: PHONE,
    });
    expect(reply).toBe("Yes, I sent Imran the interview request for tomorrow at 9am.");
    expect(hoisted.updates).toHaveLength(0);
    expect(sendToPhone).not.toHaveBeenCalled();
    expect(createCaraOpsAlert).not.toHaveBeenCalled();
  });

  it("self-corrects when the reply names a different caregiver: cancels the interview, notifies them, pages ops, replaces the reply", async () => {
    quickComplete.mockResolvedValue("YES");
    const reply = await guardInterviewIdentityConsistency({
      reply: "Yes, I sent Basra the interview request for tomorrow at 9am.",
      interviewId: IV_ID, caregiverId: CAREGIVER_ID, caregiverName: "Imran", phone: PHONE,
    });

    expect(reply).not.toContain("Basra");
    expect(reply.toLowerCase()).toContain("double-check");

    const ivUpdate = hoisted.updates.find((u) => u.path === `video_interviews/${IV_ID}`);
    expect(ivUpdate?.data.status).toBe("cancelled");
    expect(ivUpdate?.data.cancelledReason).toBe("identity_mismatch_auto_corrected");
    // One text to the caregiver (the apology below), not two: the trigger's own
    // "cancelled the scheduled interview" text is suppressed by cancelledViaAgent.
    expect(ivUpdate?.data.cancelledBy).toBe("client");
    expect(ivUpdate?.data.cancelledViaAgent).toBe(true);

    expect(sendToPhone).toHaveBeenCalledWith("+15559998888", expect.stringContaining("mistake"));

    expect(createCaraOpsAlert).toHaveBeenCalledWith(expect.objectContaining({
      type: "interview_identity_mismatch",
      severity: "high",
      phone: PHONE,
    }));
  });

  it("does not guess or create a new interview for the caregiver the reply named", async () => {
    quickComplete.mockResolvedValue("YES");
    await guardInterviewIdentityConsistency({
      reply: "Yes, I sent Basra the interview request for tomorrow at 9am.",
      interviewId: IV_ID, caregiverId: CAREGIVER_ID, caregiverName: "Imran", phone: PHONE,
    });
    // Only the one (cancelling) update should have happened — no new doc created.
    expect(hoisted.updates).toHaveLength(1);
  });

  it("does nothing when the reply is empty", async () => {
    const reply = await guardInterviewIdentityConsistency({
      reply: "", interviewId: IV_ID, caregiverId: CAREGIVER_ID, caregiverName: "Imran", phone: PHONE,
    });
    expect(reply).toBe("");
    expect(quickComplete).not.toHaveBeenCalled();
  });

  it("fails closed to NO when the classifier throws (no false-positive cancellation)", async () => {
    quickComplete.mockRejectedValue(new Error("provider down"));
    const reply = await guardInterviewIdentityConsistency({
      reply: "Yes, I sent Imran the interview request for tomorrow at 9am.",
      interviewId: IV_ID, caregiverId: CAREGIVER_ID, caregiverName: "Imran", phone: PHONE,
    });
    expect(reply).toContain("Imran");
    expect(hoisted.updates).toHaveLength(0);
  });

  it("still cancels and pages ops even when the wrongly-targeted caregiver has no reachable phone", async () => {
    hoisted.docState.set(`caregivers/${CAREGIVER_ID}`, { name: "Imran" }); // no phone field
    quickComplete.mockResolvedValue("YES");
    await guardInterviewIdentityConsistency({
      reply: "Yes, I sent Basra the interview request for tomorrow at 9am.",
      interviewId: IV_ID, caregiverId: CAREGIVER_ID, caregiverName: "Imran", phone: PHONE,
    });
    expect(sendToPhone).not.toHaveBeenCalled();
    expect(createCaraOpsAlert).toHaveBeenCalled();
    expect(hoisted.updates.find((u) => u.path === `video_interviews/${IV_ID}`)?.data.status).toBe("cancelled");
  });
});
