import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-08-24: schedule_interview was entirely ungated — an unverified or
// unpaid family could schedule a caregiver interview through Evia with no
// paywall at all. Mirrors the website's own gate (hooks/useAccessGates.tsx
// `gate('interview', ...)`). Only the gate itself is exercised here (it
// returns before any of the Meet-link/ICS creation machinery runs) — the
// full booking/interview-creation path already has its own coverage.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
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

import { handleToolCall } from "../server";

const CLIENT = "client_1";
const baseInput = {
  clientId: CLIENT, caregiverId: "cg1",
  preferredDate: "2026-09-01", preferredTime: "10:00",
};

describe("schedule_interview — access gate", () => {
  beforeEach(() => hoisted.reset());

  it("blocks when identity is not verified", async () => {
    hoisted.docState.set(`users/${CLIENT}`, { membershipStatus: "active" });
    const r = await handleToolCall("schedule_interview", baseInput) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("IDENTITY_REQUIRED");
  });

  it("blocks when membership is not active", async () => {
    hoisted.docState.set(`users/${CLIENT}`, { identityCheckStatus: "verified" });
    const r = await handleToolCall("schedule_interview", baseInput) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("MEMBERSHIP_REQUIRED");
  });

  it("blocks when clientId is missing entirely", async () => {
    const r = await handleToolCall("schedule_interview", { ...baseInput, clientId: undefined }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
  });
});
