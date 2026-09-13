import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-09-09: a name-fallback lookup finding MORE than one caregiver this
// family was shown (resolveCaregiverForInterview's own "ambiguous" code) used
// to collapse into the exact same flat "not available" tool error as a
// genuine no-match, leaving the agent nothing to ask the family other than a
// dead end. This exercises createVideoInterviewRequestForTool's own mapping
// of that code — the lookup logic + its candidates is covered independently
// in videoInterviewRequest.test.ts.
//
// 2026-09-12: caregiver resolution now runs on the PROPOSE step (before the
// family confirms), via resolveCaregiverForInterview directly — not inside
// requestVideoInterview, which only runs on the confirmed commit. Mock the
// resolution step, not the commit, to exercise the code path these tests
// actually hit on a single (unconfirmed) call.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
  });
  const makeCollRef = (path: string): any => ({
    doc: (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`),
  });
  return {
    docState,
    collection: vi.fn((p: string) => makeCollRef(p)),
    reset: () => docState.clear(),
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collection }) },
  firestore: Object.assign(() => ({ collection: hoisted.collection }), {
    FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
  }),
}));
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../agents/matchingAgent", () => ({ runMatchingForClient: vi.fn().mockResolvedValue(undefined) }));

import { VideoInterviewRequestError } from "../../agents/videoInterviewRequest";
vi.mock("../../agents/videoInterviewRequest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/videoInterviewRequest")>();
  return { ...actual, resolveCaregiverForInterview: vi.fn(), requestVideoInterview: vi.fn() };
});
import { resolveCaregiverForInterview } from "../../agents/videoInterviewRequest";
import { handleToolCall } from "../server";

const CLIENT = "client_1";
const baseInput = {
  clientId: CLIENT, caregiverId: "Alice Rivera",
  preferredDate: "2026-09-01", preferredTime: "10:00",
  phone: "+15551234567",
};

describe("schedule_interview — ambiguous name-fallback surfaces candidates instead of a dead end", () => {
  beforeEach(() => {
    hoisted.reset();
    vi.mocked(resolveCaregiverForInterview).mockReset();
    hoisted.docState.set(`users/${CLIENT}`, { identityCheckStatus: "verified", membershipStatus: "active" });
  });

  it("returns the tied candidates and an instruction to ask, instead of a flat error", async () => {
    vi.mocked(resolveCaregiverForInterview).mockRejectedValueOnce(
      new VideoInterviewRequestError(
        "ambiguous",
        'This family has been shown 2 caregivers named "Alice Rivera" — ask which one they mean, then retry with the correct caregiverId.',
        [{ id: "cg_1", hourlyRate: 20 }, { id: "cg_alice2", hourlyRate: 25 }],
      ),
    );

    const r = await handleToolCall("schedule_interview", baseInput) as any;

    expect(r._toolError).toBeUndefined();
    expect(r.success).toBe(false);
    expect(r.ambiguous).toBe(true);
    expect(r.candidates).toEqual([{ id: "cg_1", hourlyRate: 20 }, { id: "cg_alice2", hourlyRate: 25 }]);
    expect(String(r.note)).toMatch(/ask the family/i);
    expect(String(r.note)).toMatch(/never their name/i);
  });

  it("a genuine no-match still returns the plain NOT_FOUND tool error, unchanged", async () => {
    vi.mocked(resolveCaregiverForInterview).mockRejectedValueOnce(
      new VideoInterviewRequestError("failed-precondition", "Caregiver is not available for interviews"),
    );

    const r = await handleToolCall("schedule_interview", baseInput) as any;

    expect(r._toolError).toBe(true);
    expect(r.code).toBe("NOT_FOUND");
    expect(r.ambiguous).toBeUndefined();
  });
});
