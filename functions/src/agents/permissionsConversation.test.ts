import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const sets: Array<{ coll: string; data: Record<string, unknown> }> = [];
  const docRef = (coll: string) => ({
    get: async () => ({ exists: false, data: () => ({}) }),
    set: async (data: Record<string, unknown>) => { sets.push({ coll, data }); },
    update: async () => {},
  });
  const collRef = (coll: string) => ({
    doc: () => docRef(coll),
    where: () => collRef(coll),
    orderBy: () => collRef(coll),
    limit: () => collRef(coll),
    get: async () => ({ empty: true, docs: [] }),
    add: async () => ({ id: "x" }),
  });
  const firestore = () => ({ collection: (coll: string) => collRef(coll) });
  return { sets, firestore };
});

vi.mock("firebase-admin", () => ({ __esModule: true, default: { firestore: h.firestore }, firestore: h.firestore }));

const quickComplete = vi.fn();
vi.mock("../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => quickComplete(...a) }));
vi.mock("../utils/claudeClient", () => ({ getSharedClient: () => ({ messages: { create: vi.fn() } }) }));

const sendMessage = vi.fn(async (..._a: any[]) => ({ message_id: "m" }));
vi.mock("../linq/client", () => ({ sendMessage: (...a: any[]) => sendMessage(...a) }));
vi.mock("../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async ({ fallback }: { fallback: string }) => fallback) }));
vi.mock("../config/appUrl", () => ({ getAppUrl: () => "https://app.test" }));
vi.mock("./matchingAgent", () => ({ runMatchingForClient: vi.fn(async () => {}) }));

import { classifyPermissionReply, handleClientPermissionsReply, handleCaregiverPermissionsReply } from "./permissionsConversation";

const session = (step: string) => ({ onboardingStep: step, onboardingData: { seniorName: "Mom" } }) as never;

beforeEach(() => {
  h.sets.length = 0;
  quickComplete.mockReset();
  sendMessage.mockClear();
});

describe("classifyPermissionReply", () => {
  it("short-circuits explicit yes/no without an LLM call", async () => {
    expect(await classifyPermissionReply("YES")).toBe("yes");
    expect(await classifyPermissionReply("no")).toBe("no");
    expect(await classifyPermissionReply("1")).toBe("yes");
    expect(await classifyPermissionReply("2")).toBe("no");
    expect(quickComplete).not.toHaveBeenCalled();
  });

  it("classifies a mid-flow question as 'question' via the LLM", async () => {
    quickComplete.mockResolvedValue("QUESTION");
    expect(await classifyPermissionReply("what if I change my mind later?")).toBe("question");
  });

  it("falls back to 'question' when the LLM errors (never coerces to no)", async () => {
    quickComplete.mockRejectedValueOnce(new Error("down"));
    expect(await classifyPermissionReply("hmm not sure")).toBe("question");
  });
});

describe("handleClientPermissionsReply — mid-flow question guard", () => {
  it("answers a question and re-asks WITHOUT recording a permission", async () => {
    quickComplete.mockResolvedValue("QUESTION");
    await handleClientPermissionsReply("+1555", "chat1", "what does that mean?", session("client_permissions_contact"), "u1");
    // No write to agent_permissions — the bug this fixes.
    expect(h.sets.find((s) => s.coll === "agent_permissions")).toBeUndefined();
    // The question was answered + re-asked.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String((sendMessage.mock.calls[0] as any[])[1])).toContain("Reply YES or NO");
  });

  it("records the permission as granted on YES", async () => {
    await handleClientPermissionsReply("+1555", "chat1", "YES", session("client_permissions_contact"), "u1");
    const permWrite = h.sets.find((s) => s.coll === "agent_permissions");
    expect(permWrite?.data).toMatchObject({ canContactCaregivers: true });
  });

  it("records the permission as denied on NO", async () => {
    await handleClientPermissionsReply("+1555", "chat1", "NO", session("client_permissions_contact"), "u1");
    const permWrite = h.sets.find((s) => s.coll === "agent_permissions");
    expect(permWrite?.data).toMatchObject({ canContactCaregivers: false });
  });
});

describe("handleClientPermissionsReply — capability menu on completion (U3)", () => {
  it("sends the client capability menu after the final permissions step completes", async () => {
    await handleClientPermissionsReply("+1555", "chat1", "YES", session("client_permissions_autobook"), "u1");
    const texts = sendMessage.mock.calls.map((c: any[]) => String(c[1]));
    expect(texts.some((t) => t.includes("Here's what I can help you with"))).toBe(true);
    expect(texts.some((t) => t.includes("Find a caregiver"))).toBe(true);
  });
});

describe("handleCaregiverPermissionsReply — capability menu on completion (U3)", () => {
  it("sends the CAREGIVER capability menu after the final caregiver permissions step completes", async () => {
    await handleCaregiverPermissionsReply("+1555", "chat1", "YES", session("caregiver_permissions_arrival"), "cg1");
    const texts = sendMessage.mock.calls.map((c: any[]) => String(c[1]));
    expect(texts.some((t) => t.includes("Find work"))).toBe(true);
    // client-only capabilities must NOT appear in the caregiver menu
    expect(texts.some((t) => t.includes("Find a caregiver"))).toBe(false);
  });
});
