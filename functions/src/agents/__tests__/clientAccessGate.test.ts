// agents/clientAccessGate.ts = hooks/useAccessGates.tsx over SMS: identity
// first, then membership; the modal's copy + its CTA link; the site's
// paywall-view signal on a membership block.
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const sets: Array<{ path: string; data: any; opts?: any }> = [];
  const makeDoc = (path: string) => ({
    id: path.split("/").pop(),
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data, opts });
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
  });
  const coll = (path: string): any => ({
    doc: (id: string) => makeDoc(`${path}/${id}`),
    where: (_f: string, _op: string, v: unknown) => ({
      limit: () => ({
        get: vi.fn(async () => ({
          docs: [...docState.entries()]
            .filter(([k, d]) => k.startsWith(path + "/") && d?.userId === v)
            .map(([k, d]) => ({ id: k.split("/").pop(), data: () => d })),
        })),
      }),
    }),
  });
  const sendMessage = vi.fn(async () => undefined);
  const sendOnboardingLink = vi.fn(async () => ({ success: true }));
  return {
    docState, sets, coll, sendMessage, sendOnboardingLink,
    reset: () => { docState.clear(); sets.length = 0; sendMessage.mockClear(); sendOnboardingLink.mockReset(); sendOnboardingLink.mockResolvedValue({ success: true }); },
  };
});

vi.mock("firebase-admin", () => ({ firestore: () => ({ collection: hoisted.coll }) }));
vi.mock("../../linq/client", () => ({ sendMessage: (...a: any[]) => (hoisted.sendMessage as any)(...a) }));
vi.mock("../onboardingConversation", () => ({ sendOnboardingLink: (...a: any[]) => (hoisted.sendOnboardingLink as any)(...a) }));

import { checkClientAccess, enforceClientGate, clientGateText, isClientMembershipActive, findClientSession } from "../clientAccessGate";

const UID = "client-uid";
const PHONE = "+15550001111";
const CHAT = "chat-1";
const texts = () => hoisted.sendMessage.mock.calls.map((c: any[]) => (typeof c[1] === "string" ? c[1] : JSON.stringify(c[1])));

beforeEach(() => hoisted.reset());

describe("checkClientAccess — the site's rule", () => {
  it("identity first: an unverified family is blocked on identity even with an active membership", async () => {
    hoisted.docState.set(`users/${UID}`, { membershipStatus: "active" });
    expect(await checkClientAccess(UID, "booking")).toEqual({ ok: false, block: "identity" });
    expect(hoisted.sets).toHaveLength(0); // the gate only reads — no writes on a block
  });

  it("membership second: verified but lapsed is blocked (no paywall-view stamp — removed with the win-back job, 2026-09-23)", async () => {
    hoisted.docState.set(`users/${UID}`, { identityCheckStatus: "verified", membershipStatus: "canceled" });
    expect(await checkClientAccess(UID, "booking", "Basra")).toEqual({ ok: false, block: "membership" });
    expect(hoisted.sets).toHaveLength(0);
  });

  it.each([
    [{ identityCheckStatus: "verified", membershipStatus: "active" }],
    [{ identityCheckStatus: "verified", membershipStatus: "trialing" }],
    [{ identityCheckStatus: "verified", subscriptionActive: true, membershipStatus: "canceled" }],
  ])("passes for %j (useAccessGates: subscriptionActive || active || trialing)", async (u) => {
    hoisted.docState.set(`users/${UID}`, u);
    expect(await checkClientAccess(UID, "message")).toEqual({ ok: true });
  });

  it("a missing users doc is treated like the site treats an empty one — blocked on identity", async () => {
    expect(await checkClientAccess(UID, "interview")).toEqual({ ok: false, block: "identity" });
  });

  it("isClientMembershipActive mirrors the hook exactly", () => {
    expect(isClientMembershipActive({ membershipStatus: "past_due" })).toBe(false);
    expect(isClientMembershipActive({ subscriptionActive: "yes" })).toBe(false);
    expect(isClientMembershipActive({ membershipStatus: "trialing" })).toBe(true);
    expect(isClientMembershipActive(null)).toBe(false);
  });
});

describe("clientGateText — the modals' copy", () => {
  it("identity = IdentityGateModal (says 'contact' for every action, like the modal)", () => {
    expect(clientGateText("identity", "booking", "Basra")).toMatch(/^To contact Basra, you need to complete a quick identity check\. Pick up where you left off!/);
    expect(clientGateText("identity", "booking")).toMatch(/^To contact caregivers, you need to complete a quick identity check/);
    expect(clientGateText("identity", "message")).toMatch(/Stripe Identity/);
  });

  it("membership = PlanSelectModal header per action", () => {
    expect(clientGateText("membership", "booking", "Basra")).toMatch(/^Select a plan to book Basra/);
    expect(clientGateText("membership", "interview", "Basra")).toMatch(/^Select a plan to interview Basra/);
    expect(clientGateText("membership", "message", "Basra")).toMatch(/^Select a plan to contact Basra/);
    expect(clientGateText("membership", "booking")).toMatch(/^Select a plan to continue/);
  });
});

describe("enforceClientGate — the modal over SMS", () => {
  it("blocked: texts the copy, then the modal's CTA link (membership → the checkout link), returns true", async () => {
    hoisted.docState.set(`users/${UID}`, { identityCheckStatus: "verified" });
    expect(await enforceClientGate(PHONE, CHAT, UID, "booking", "Basra")).toBe(true);
    expect(texts()[0]).toMatch(/^Select a plan to book Basra/);
    expect(hoisted.sendOnboardingLink).toHaveBeenCalledWith(PHONE, "client_payment");
  });

  it("identity block sends the Stripe Identity link", async () => {
    hoisted.docState.set(`users/${UID}`, { membershipStatus: "active" });
    expect(await enforceClientGate(PHONE, CHAT, UID, "interview", "Basra")).toBe(true);
    expect(texts()[0]).toMatch(/identity check/);
    expect(hoisted.sendOnboardingLink).toHaveBeenCalledWith(PHONE, "client_identity");
  });

  it("passes silently for an active, verified family", async () => {
    hoisted.docState.set(`users/${UID}`, { identityCheckStatus: "verified", membershipStatus: "active" });
    expect(await enforceClientGate(PHONE, CHAT, UID, "booking")).toBe(false);
    expect(hoisted.sendMessage).not.toHaveBeenCalled();
    expect(hoisted.sendOnboardingLink).not.toHaveBeenCalled();
  });

  it("link mint failure falls back to the site page where the same modal lives", async () => {
    hoisted.docState.set(`users/${UID}`, { identityCheckStatus: "verified" });
    hoisted.sendOnboardingLink.mockRejectedValueOnce(new Error("stripe down"));
    expect(await enforceClientGate(PHONE, CHAT, UID, "booking")).toBe(true);
    expect(texts()[1]).toMatch(/\/client\/membership/);
  });
});

describe("findClientSession — texting the block from a tool that only knows the clientId", () => {
  it("uses the injected phone when its session has a chat", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID });
    expect(await findClientSession(UID, PHONE)).toEqual({ phone: PHONE, chatId: CHAT });
  });

  it("falls back to the session that belongs to the family's uid", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID });
    hoisted.docState.set("agent_sessions/+15559999999", { chatId: "other", userId: "someone-else" });
    expect(await findClientSession(UID)).toEqual({ phone: PHONE, chatId: CHAT });
    expect(await findClientSession("nobody")).toBeNull();
  });
});
