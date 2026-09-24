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
vi.mock("../config/appUrl", () => ({ getAppUrl: () => "https://app.test", appLink: (path: string) => `https://app.test${path}` }));
const notifyNewCaregiverOfJobs = vi.fn(async (..._a: any[]) => {});
vi.mock("../triggers/caregiverJobMatch", () => ({ notifyNewCaregiverOfJobs: (...a: any[]) => notifyNewCaregiverOfJobs(...a) }));

import { classifyPermissionReply, handleCaregiverPermissionsReply } from "./permissionsConversation";

const session = (step: string, extra: Record<string, unknown> = {}) =>
  ({ onboardingStep: step, onboardingData: { seniorName: "Mom" }, ...extra }) as never;

beforeEach(() => {
  h.sets.length = 0;
  quickComplete.mockReset();
  sendMessage.mockClear();
  notifyNewCaregiverOfJobs.mockClear();
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

describe("handleCaregiverPermissionsReply — capability menu on completion (U3)", () => {
  it("sends the CAREGIVER capability menu after the final caregiver permissions step completes", async () => {
    await handleCaregiverPermissionsReply("+1555", "chat1", "YES", session("caregiver_permissions_arrival"), "cg1");
    const texts = sendMessage.mock.calls.map((c: any[]) => String(c[1]));
    expect(texts.some((t) => /clock out|earnings|payout|caregiver/i.test(t))).toBe(true);
    // client-only capabilities must NOT appear in the caregiver menu
    expect(texts.some((t) => t.includes("Find a caregiver"))).toBe(false);
  });

  it("fires the job fan-out only when the permissions flow completes (YES/NO collision fix)", async () => {
    await handleCaregiverPermissionsReply("+1555", "chat1", "YES", session("caregiver_permissions_arrival"), "cg1");
    // The fan-out is a fire-and-forget dynamic import — wait for it to land.
    await vi.waitFor(() => expect(notifyNewCaregiverOfJobs).toHaveBeenCalledWith("cg1"));
  });

  it("decline answer COMPLETES the flow — arrival question removed, arrival notifications always granted (2026-07-15)", async () => {
    await handleCaregiverPermissionsReply("+1555", "chat1", "YES", session("caregiver_permissions_decline"), "cg1");
    const permWrite = h.sets.find((s) => s.coll === "agent_permissions");
    expect(permWrite?.data).toMatchObject({
      canDeclineJobsAutomatically:   true,
      canSendArrivalNotifications:   true,
      canShareJournalWithFamily:     true,
      canAcceptJobsWithConfirmation: true,
    });
    const texts = sendMessage.mock.calls.map((c: any[]) => String(c[1]));
    // The old arrival opt-in question must never be asked again.
    expect(texts.some((t) => /automatically let the family know/i.test(t))).toBe(false);
    // Completion celebration + fan-out fire straight from the decline step.
    expect(texts.some((t) => /You're all set/i.test(t))).toBe(true);
    await vi.waitFor(() => expect(notifyNewCaregiverOfJobs).toHaveBeenCalledWith("cg1"));
  });
});

describe("permissions question-detour bailout (max ONE re-ask)", () => {
  it("caregiver: first question detour answers + re-asks, records nothing", async () => {
    quickComplete.mockResolvedValue("QUESTION");
    await handleCaregiverPermissionsReply("+1555", "chat1", "what's missing in my profile?",
      session("caregiver_permissions_decline"), "cg1");
    expect(h.sets.find((s) => s.coll === "agent_permissions")).toBeUndefined();
    expect(String((sendMessage.mock.calls[0] as any[])[1])).toContain("pass on job requests");
    expect(notifyNewCaregiverOfJobs).not.toHaveBeenCalled();
  });

  it("caregiver: second question detour defaults permissions OFF, completes, and does NOT re-ask", async () => {
    quickComplete.mockResolvedValue("QUESTION");
    await handleCaregiverPermissionsReply("+1555", "chat1", "why is my profile not finished?",
      session("caregiver_permissions_decline", { permissionsDetourCount: 1 }), "cg1");
    const permWrite = h.sets.find((s) => s.coll === "agent_permissions");
    expect(permWrite?.data).toMatchObject({
      canDeclineJobsAutomatically:   false,
      // Arrival notifications are standard behavior (2026-07-15) — always
      // granted, never asked; family is notified on ARRIVED unconditionally.
      canSendArrivalNotifications:   true,
      canShareJournalWithFamily:     true,
      canAcceptJobsWithConfirmation: true,
    });
    const texts = sendMessage.mock.calls.map((c: any[]) => String(c[1]));
    // No re-ask of the pending permission question — the flow bailed out.
    expect(texts.some((t) => t.includes("pass on job requests"))).toBe(false);
    // The session is unblocked — job fan-out fires like any other completion.
    await vi.waitFor(() => expect(notifyNewCaregiverOfJobs).toHaveBeenCalledWith("cg1"));
  });

  it("caregiver: bailout mid-flow (legacy arrival step) keeps the already-answered decline permission untouched", async () => {
    quickComplete.mockResolvedValue("QUESTION");
    await handleCaregiverPermissionsReply("+1555", "chat1", "hmm what does that mean?",
      session("caregiver_permissions_arrival", { permissionsDetourCount: 1 }), "cg1");
    const permWrite = h.sets.find((s) => s.coll === "agent_permissions");
    // Arrival notifications default GRANTED (standard behavior, 2026-07-15).
    expect(permWrite?.data).toMatchObject({ canSendArrivalNotifications: true });
    expect(permWrite?.data).not.toHaveProperty("canDeclineJobsAutomatically");
  });
});
