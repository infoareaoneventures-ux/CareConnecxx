import { beforeEach, describe, expect, it, vi } from "vitest";

// Caregiver sweep C12 (2026-10-11): sendViaInteractionAgent with fixedString —
// the block-only review (never a rewrite), the SEND/WAIT judge skipped, a
// blocked send resolving false (so a lockstep caller writes no bell), and the
// judge being told who the reader is when it does run.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeDocRef = (path: string): any => ({
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    update: vi.fn(async (data: any) => docState.set(path, { ...(docState.get(path) ?? {}), ...data })),
  });
  const makeCollRef = (path: string): any => ({ doc: (id: string) => makeDocRef(`${path}/${id}`), add: vi.fn(async () => ({ id: "auto" })) });
  return { docState, collection: vi.fn((path: string) => makeCollRef(path)), reset: () => docState.clear() };
});

const sendMessage = vi.fn(async (..._a: any[]) => ({ message_id: "m1" }));
const supervise = vi.fn(async (text: string, ..._a: any[]) => `${text} (rewritten)`);
const reviewFixedString = vi.fn(async (..._a: any[]) => true);
const quickComplete = vi.fn(async (..._a: any[]) => "SEND");

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collection }) },
  firestore: () => ({ collection: hoisted.collection }),
}));
vi.mock("../../linq/client", () => ({ sendMessage: (...a: any[]) => sendMessage(...a) }));
vi.mock("../../memory/preferences", () => ({
  getPreferences: vi.fn(async () => ({ dndEnabled: false, timezone: "America/Los_Angeles" })),
  isInDND: vi.fn(() => false),
  isActiveHour: vi.fn(() => true),
  validatedTz: (tz: string) => tz,
}));
vi.mock("../../safety/supervisor", () => ({ supervise: (text: string, ctx: any) => supervise(text, ctx), reviewFixedString: (text: string, ctx: any) => reviewFixedString(text, ctx) }));
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("../../observability/consentAudit", () => ({ buildConsentAuditRecord: vi.fn((_p, _s, action) => ({ action })) }));
vi.mock("../../utils/outboundLedger", () => ({ claimOutboundSend: vi.fn(async () => true) }));
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => quickComplete(...a) }));
vi.mock("../caregiverSearch", () => ({ presentCaregiverSearch: vi.fn(), searchCaregivers: vi.fn() }));
vi.mock("../intentClassifier", () => ({ classifyIntent: vi.fn(async () => "QUESTION") }));

import { sendViaInteractionAgent, sessionRole } from "../caraAgent";

const PHONE = "+15550001111";
const NOTICE = "Your membership is active. Next: authorize your background check — it takes about 2 minutes.";

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  reviewFixedString.mockResolvedValue(true);
  quickComplete.mockResolvedValue("SEND");
  hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: "chat-1", caregiverId: "cg1", userType: "caregiver", optedOut: false });
});

describe("sessionRole", () => {
  it("reads the caregiver from userType or caregiverId; everything else is the family", () => {
    expect(sessionRole({ userType: "caregiver" })).toBe("caregiver");
    expect(sessionRole({ caregiverId: "cg1" })).toBe("caregiver");
    expect(sessionRole({ userId: "fam" })).toBe("client");
    expect(sessionRole(undefined)).toBe("client");
  });
});

describe("fixedString sends", () => {
  it("go out exactly as written: the rewriting reviewer is never called, the block-only review is, with the caregiver role", async () => {
    const ok = await sendViaInteractionAgent(PHONE, { content: NOTICE, urgency: "immediate", sourceAgent: "caregiver_account_event", canDrop: false, fixedString: true });
    expect(ok).toBe(true);
    expect(supervise).not.toHaveBeenCalled();
    expect(reviewFixedString).toHaveBeenCalledWith(NOTICE, expect.objectContaining({ phone: PHONE, role: "caregiver", fixedString: true }));
    expect(sendMessage).toHaveBeenCalledWith("chat-1", NOTICE, {});
  });

  it("a BLOCKED fixed string is not sent and resolves false — the caller writes no bell", async () => {
    reviewFixedString.mockResolvedValueOnce(false);
    const ok = await sendViaInteractionAgent(PHONE, { content: NOTICE, urgency: "standard", sourceAgent: "thirty_min_shift_reminder", canDrop: false, fixedString: true });
    expect(ok).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("skip the LLM SEND/WAIT judge even when droppable (DND / active hours still apply through shouldSend's earlier checks)", async () => {
    const ok = await sendViaInteractionAgent(PHONE, { content: NOTICE, urgency: "standard", sourceAgent: "nudge", canDrop: true, fixedString: true });
    expect(ok).toBe(true);
    expect(quickComplete).not.toHaveBeenCalled();
  });

  it("model-generated text keeps the rewriting reviewer, now told the session's role", async () => {
    await sendViaInteractionAgent(PHONE, { content: "Here are two caregivers.", urgency: "immediate", sourceAgent: "qa", canDrop: false });
    expect(supervise).toHaveBeenCalledWith("Here are two caregivers.", { phone: PHONE, role: "caregiver" });
    expect(sendMessage).toHaveBeenCalledWith("chat-1", "Here are two caregivers. (rewritten)", {});
  });
});

describe("the SEND/WAIT judge is role-aware", () => {
  it("a caregiver's droppable nudge is judged as a message to a caregiver, not 'a care update to a family'", async () => {
    await sendViaInteractionAgent(PHONE, { content: "Still waiting on you: a booking request from The Nguyens.", urgency: "standard", sourceAgent: "pending_decision_nudge", canDrop: true });
    expect(quickComplete).toHaveBeenCalledTimes(1);
    const [system, user] = quickComplete.mock.calls[0] as unknown as [string, string];
    expect(system).toContain("to a caregiver");
    expect(system).not.toContain("to a family");
    expect(user).toContain("Current local time for this caregiver");
  });

  it("a family session is still judged as a family", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: "chat-1", userId: "fam1", optedOut: false });
    await sendViaInteractionAgent(PHONE, { content: "Alice checked off 3 tasks.", urgency: "standard", sourceAgent: "in_shift", canDrop: true });
    const [system] = quickComplete.mock.calls[0] as unknown as [string, string];
    expect(system).toContain("to a family");
  });

  it("WAIT drops the text and resolves false (the lockstep caller then writes no bell)", async () => {
    quickComplete.mockResolvedValueOnce("WAIT");
    const ok = await sendViaInteractionAgent(PHONE, { content: "Still waiting on you.", urgency: "standard", sourceAgent: "pending_decision_nudge", canDrop: true });
    expect(ok).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
