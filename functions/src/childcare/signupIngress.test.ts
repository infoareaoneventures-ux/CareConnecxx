// Childcare U4 (plan 2026-07-22-002): family signup ingress.
//
// Pins: typed-vertical session stamping (never senior defaults), flags
// re-check at inbound time (fail closed — R61), ONE deterministic enrollment
// objective under duplicate first inbounds (AE15), consent receipts at
// signup, bridge-doc privacy (exact field set — no child PII), static SMS
// bodies carrying routing/status/links only, and ZERO memory initialization
// (the module never touches zepClient — asserted via module-graph isolation
// plus the webhooks routing suite's zep-mock assertions).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApprovalResult } from "../agents/approvalHandler";

vi.mock("../observability/auditLog", () => ({
  logAudit: vi.fn(async () => {}),
}));

// U10: incident escalation pages ops through caraOpsAlerts (module-level db) —
// mock it so the routing tests can assert the page without firebase-admin.
const opsAlerts: Array<Record<string, unknown>> = [];
vi.mock("../observability/caraOpsAlerts", () => ({
  createCaraOpsAlert: vi.fn(async (input: Record<string, unknown>) => {
    opsAlerts.push(input);
    return true;
  }),
}));

const getPendingActions = vi.fn(async (_phone: string, _vertical: "child"): Promise<any[]> => []);
const handleApprovals = vi.fn(
  async (_params: Record<string, unknown>): Promise<ApprovalResult> => ({
    outcome: "fallthrough",
    reason: "question",
  }),
);
vi.mock("../agents/pendingActions", () => ({
  getAllPending: (...args: any[]) => getPendingActions(args[0], args[1]),
}));
vi.mock("../agents/approvalHandler", () => ({
  handlePendingApprovals: (...args: any[]) => handleApprovals(args[0]),
}));

// zepClient mock with a tripwire: if ANY ingress path imported and called it,
// these would record calls — the AE23 assertion below checks they never do.
const zepInit = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../memory/zepClient", () => ({
  initializeZepOnFirstContact: (...a: unknown[]) => zepInit(...a),
  addUserMessageToZep: (...a: unknown[]) => zepInit(...a),
  addBusinessDataToZep: (...a: unknown[]) => zepInit(...a),
}));

import { makeFakeDb, type FakeDb } from "./__tests__/fakeFirestore";
import { bustChildcareFlagsCache } from "../config/featureFlags";
import { OBJECTIVES_COLLECTION } from "../agents/objectiveLedger";
import {
  CHILDCARE_STEP_UNAVAILABLE,
  CHILDCARE_STEP_WEB_PROFILE,
  CHILDCARE_PROFILE_PATH,
  familyChildcareObjectiveId,
  ensureFamilyChildcareObjective,
  handleChildcareWebBridgeInbound,
  handleChildcareSessionInbound,
  routeChildcareSessionInbound,
  // Front door Stage 1 (childcare front door design note).
  CHILDCARE_STEP_CAREGIVER_HOLD,
  CHILDCARE_STEP_COLD_SIGNUP,
  CHILDCARE_CAREGIVER_PATH,
  CHILDCARE_CLIENT_SIGNUP_PATH,
  CHILDCARE_CAREGIVER_SIGNUP_PATH,
  handleChildcareCaregiverBridgeInbound,
  routeChildcareCaregiverInbound,
  handleChildcareColdInbound,
} from "./signupIngress";
import { CHILDCARE_INCIDENT_ACK } from "./incidentSignal";

const PHONE = "+15550001111";
const CHAT = "chat-1";
const UID = "web-uid-1";
const FLAGS_ON = {
  CHILDCARE_ENABLED: true,
  CHILDCARE_DISCOVERY_ENABLED: true,
  CHILDCARE_WRITES_ENABLED: true,
  CHILDCARE_PROACTIVE_ENABLED: false,
};

function bridgeDoc(overrides: Record<string, unknown> = {}) {
  return {
    uid: UID,
    role: "client",
    phone: PHONE,
    careVertical: "child",
    consentText: "v1.0",
    status: "awaiting_inbound",
    ...overrides,
  };
}

function makeSend() {
  const sent: string[] = [];
  const send = vi.fn(async (_chatId: string, text: string) => { sent.push(text); });
  return { send, sent };
}

async function runBridge(fake: FakeDb, send: ReturnType<typeof makeSend>["send"], overrides: Record<string, unknown> = {}) {
  return handleChildcareWebBridgeInbound({
    phone: PHONE,
    chatId: CHAT,
    service: "SMS",
    preferredLanguage: "en",
    webSessionData: bridgeDoc(overrides),
    db: fake.db,
    sendMessage: send,
    now: new Date("2026-07-22T12:00:00.000Z"),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  bustChildcareFlagsCache();
  opsAlerts.length = 0;
});

describe("handleChildcareWebBridgeInbound — flags ON (authoritative first inbound)", () => {
  function armedDb(): FakeDb {
    const fake = makeFakeDb({
      "childcare_flags/global": FLAGS_ON,
      [`web_onboarding_sessions/${PHONE}`]: bridgeDoc(),
    });
    return fake;
  }

  it("stamps the typed childcare session — never a senior default", async () => {
    const fake = armedDb();
    const { send } = makeSend();
    expect(await runBridge(fake, send)).toBe(true);
    const session = fake.get(`agent_sessions/${PHONE}`);
    expect(session).toMatchObject({
      careVertical: "child",
      verticalIntent: "child",
      userType: "client",
      userId: UID,
      onboardingStep: CHILDCARE_STEP_WEB_PROFILE,
      optedIn: true,
    });
  });

  it("creates the ONE vertical-stamped family enrollment objective", async () => {
    const fake = armedDb();
    const { send } = makeSend();
    await runBridge(fake, send);
    const objective = fake.get(`${OBJECTIVES_COLLECTION}/${familyChildcareObjectiveId(UID)}`);
    expect(objective).toMatchObject({
      userId: UID,
      careVertical: "child",
      intent: "childcare.family_enrollment",
      status: "active",
      role: "client",
      channel: "linq",
    });
  });

  it("duplicate first inbound converges on ONE objective (AE15)", async () => {
    const fake = armedDb();
    const { send } = makeSend();
    await runBridge(fake, send);
    const before = fake.get(`${OBJECTIVES_COLLECTION}/${familyChildcareObjectiveId(UID)}`);
    await runBridge(fake, send);
    const after = fake.get(`${OBJECTIVES_COLLECTION}/${familyChildcareObjectiveId(UID)}`);
    expect(after).toEqual(before);
    const objectiveDocs = [...fake.docs.keys()].filter((p) => p.startsWith(`${OBJECTIVES_COLLECTION}/`));
    expect(objectiveDocs).toHaveLength(1);
  });

  it("records the four signup consent receipts (pending-policy-version while CA versions are unset)", async () => {
    const fake = armedDb();
    const { send } = makeSend();
    await runBridge(fake, send);
    const receipts = [...fake.docs.entries()].filter(([p]) => p.startsWith("consent_receipts/"));
    expect(receipts).toHaveLength(4);
    const types = receipts.map(([, d]) => d.policyType).sort();
    expect(types).toEqual(["communicationConsent", "guardianAttestation", "privacy", "terms"]);
    for (const [, d] of receipts) expect(d.state).toBe("pending-policy-version");
  });

  it("marks the bridge doc connected and stamps the objective id — NO child PII anywhere", async () => {
    const fake = armedDb();
    const { send } = makeSend();
    await runBridge(fake, send);
    const bridge = fake.get(`web_onboarding_sessions/${PHONE}`)!;
    expect(bridge.status).toBe("connected");
    expect(bridge.childcareObjectiveId).toBe(familyChildcareObjectiveId(UID));
    // Exact field set: typed intent + routing only, no recipient details.
    expect(Object.keys(bridge).sort()).toEqual([
      "careVertical", "chatId", "childcareObjectiveId", "connectedAt",
      "consentText", "phone", "role", "status", "uid",
    ]);
  });

  it("sends ONE static welcome carrying the secure link and no user/child text", async () => {
    const fake = armedDb();
    const { send, sent } = makeSend();
    await runBridge(fake, send);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(CHILDCARE_PROFILE_PATH);
    expect(sent[0]).toContain("secure");
    expect(sent[0]).toContain("STOP");
  });

  it("never initializes memory (AE23/R50) — zepClient is untouched", async () => {
    const fake = armedDb();
    const { send } = makeSend();
    await runBridge(fake, send);
    expect(zepInit).not.toHaveBeenCalled();
  });
});

describe("handleChildcareWebBridgeInbound — fail closed", () => {
  it("flags OFF at inbound time: waitlist session, no objective, no receipts, unavailable message", async () => {
    const fake = makeFakeDb({ [`web_onboarding_sessions/${PHONE}`]: bridgeDoc() }); // no flags doc
    const { send, sent } = makeSend();
    expect(await runBridge(fake, send)).toBe(true);
    expect(fake.get(`agent_sessions/${PHONE}`)).toMatchObject({
      careVertical: "child",
      onboardingStep: CHILDCARE_STEP_UNAVAILABLE,
    });
    expect(fake.get(`${OBJECTIVES_COLLECTION}/${familyChildcareObjectiveId(UID)}`)).toBeUndefined();
    expect([...fake.docs.keys()].some((p) => p.startsWith("consent_receipts/"))).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/isn't available/);
    expect(sent[0]).not.toContain(CHILDCARE_PROFILE_PATH); // no links to dark surfaces
  });

  it("emergencyOff behaves exactly like flags off", async () => {
    const fake = makeFakeDb({
      "childcare_flags/global": { ...FLAGS_ON, emergencyOff: true },
      [`web_onboarding_sessions/${PHONE}`]: bridgeDoc(),
    });
    const { send } = makeSend();
    await runBridge(fake, send);
    expect(fake.get(`agent_sessions/${PHONE}`)?.onboardingStep).toBe(CHILDCARE_STEP_UNAVAILABLE);
  });

  it("missing uid on the bridge doc fails closed (no objective, waitlist state)", async () => {
    const fake = makeFakeDb({ "childcare_flags/global": FLAGS_ON });
    const { send } = makeSend();
    await runBridge(fake, send, { uid: "" });
    expect(fake.get(`agent_sessions/${PHONE}`)?.onboardingStep).toBe(CHILDCARE_STEP_UNAVAILABLE);
    const objectiveDocs = [...fake.docs.keys()].filter((p) => p.startsWith(`${OBJECTIVES_COLLECTION}/`));
    expect(objectiveDocs).toHaveLength(0);
  });
});

describe("handleChildcareSessionInbound — deterministic responder", () => {
  it("active childcare session gets the status message with the secure resume link", async () => {
    const fake = makeFakeDb({ "childcare_flags/global": FLAGS_ON });
    const { send, sent } = makeSend();
    const handled = await handleChildcareSessionInbound({
      phone: PHONE, chatId: CHAT,
      session: { careVertical: "child", onboardingStep: CHILDCARE_STEP_WEB_PROFILE, userId: UID },
      db: fake.db, sendMessage: send,
    });
    expect(handled).toBe(true);
    expect(sent[0]).toContain(CHILDCARE_PROFILE_PATH);
    expect(zepInit).not.toHaveBeenCalled();
  });

  it("flags flipped OFF: unavailable message only, no links", async () => {
    const fake = makeFakeDb();
    const { send, sent } = makeSend();
    await handleChildcareSessionInbound({
      phone: PHONE, chatId: CHAT,
      session: { careVertical: "child", onboardingStep: CHILDCARE_STEP_WEB_PROFILE, userId: UID },
      db: fake.db, sendMessage: send,
    });
    expect(sent[0]).toMatch(/isn't available/);
    expect(sent[0]).not.toContain(CHILDCARE_PROFILE_PATH);
  });

  it("waitlisted session upgrades when the flags turn on (resume, one objective)", async () => {
    const fake = makeFakeDb({
      "childcare_flags/global": FLAGS_ON,
      [`agent_sessions/${PHONE}`]: { careVertical: "child", onboardingStep: CHILDCARE_STEP_UNAVAILABLE, userId: UID },
    });
    const { send, sent } = makeSend();
    await handleChildcareSessionInbound({
      phone: PHONE, chatId: CHAT,
      session: fake.get(`agent_sessions/${PHONE}`)!,
      db: fake.db, sendMessage: send,
    });
    expect(fake.get(`agent_sessions/${PHONE}`)?.onboardingStep).toBe(CHILDCARE_STEP_WEB_PROFILE);
    expect(fake.get(`${OBJECTIVES_COLLECTION}/${familyChildcareObjectiveId(UID)}`)).toBeDefined();
    expect(sent[0]).toContain(CHILDCARE_PROFILE_PATH);
  });
});

// ── U10 routing upgrade: classified childcare sessions → the real agent loop ─

describe("routeChildcareSessionInbound (U10)", () => {
  const CHILD_SESSION = {
    careVertical: "child",
    verticalIntent: "child",
    userType: "client",
    userId: UID,
    onboardingStep: CHILDCARE_STEP_WEB_PROFILE,
  };

  function seedAuthority(fake: FakeDb, state = "active"): void {
    fake.seed(`guardian_authorities/child-1__${UID}`, {
      authorityId: `child-1__${UID}`,
      childId: "child-1",
      adultUid: UID,
      careVertical: "child",
      scopes: ["view"],
      state,
      effectiveAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      accessVersion: 1,
    });
  }

  it("R53: a serious-incident text escalates deterministically BEFORE flags and the loop", async () => {
    const fake = makeFakeDb(); // flags absent = OFF — escalation still runs
    const { send, sent } = makeSend();
    const runAgent = vi.fn(async () => "");
    const handled = await routeChildcareSessionInbound({
      phone: PHONE, chatId: CHAT,
      text: "my daughter got hurt at the sitter's and she's bleeding",
      session: CHILD_SESSION, db: fake.db, sendMessage: send, runAgent,
    });
    expect(handled).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
    expect(sent).toEqual([CHILDCARE_INCIDENT_ACK]);
    expect(fake.get(`agent_sessions/${PHONE}`)).toMatchObject({
      handedToHuman: true,
      handedToHumanReason: "childcare_incident",
      childcareIncidentMarker: "injury",
    });
    expect(opsAlerts[0]).toMatchObject({ type: "childcare_incident", severity: "high" });
    // R57: the alert never carries message content.
    expect(JSON.stringify(opsAlerts[0])).not.toContain("bleeding");
  });

  it("flags off (emergency): deterministic safe responder, never the loop", async () => {
    const fake = makeFakeDb();
    fake.seed("childcare_flags/global", { CHILDCARE_ENABLED: true, emergencyOff: true });
    const { send, sent } = makeSend();
    const runAgent = vi.fn(async () => "");
    const handled = await routeChildcareSessionInbound({
      phone: PHONE, chatId: CHAT, text: "can I change Thursday's booking?",
      session: CHILD_SESSION, db: fake.db, sendMessage: send, runAgent,
    });
    expect(handled).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
    expect(sent.join(" ")).toContain("isn't available");
  });

  it("intercepts only child pending actions before the loop and flags checks", async () => {
    const fake = makeFakeDb();
    const { send } = makeSend();
    const runAgent = vi.fn(async () => "");
    const pending = {
      id: "pa-child-1",
      phone: PHONE,
      toolName: "cancel_childcare_booking",
      toolInput: { bookingId: "booking-1", careVertical: "child" },
      preview: "Cancel childcare booking",
      proposedAt: "2026-07-22T12:00:00.000Z",
      expiresAt: "2026-07-22T12:15:00.000Z",
      status: "awaiting" as const,
      careVertical: "child" as const,
    };
    getPendingActions.mockResolvedValueOnce([pending]);
    handleApprovals.mockResolvedValueOnce({ outcome: "handled" });

    const handled = await routeChildcareSessionInbound({
      phone: PHONE,
      chatId: CHAT,
      text: "yes",
      session: CHILD_SESSION,
      db: fake.db,
      sendMessage: send,
      runAgent,
    });

    expect(handled).toBe(true);
    expect(getPendingActions).toHaveBeenCalledWith(PHONE, "child");
    expect(handleApprovals).toHaveBeenCalledWith(expect.objectContaining({
      phone: PHONE,
      userId: UID,
      userType: "client",
      pendings: [pending],
    }));
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("enrollment (no live child authority): deterministic responder keeps pointing at the secure web flow", async () => {
    const fake = makeFakeDb();
    fake.seed("childcare_flags/global", FLAGS_ON);
    const { send, sent } = makeSend();
    const runAgent = vi.fn(async () => "");
    const handled = await routeChildcareSessionInbound({
      phone: PHONE, chatId: CHAT, text: "how do I finish setup?",
      session: CHILD_SESSION, db: fake.db, sendMessage: send, runAgent,
    });
    expect(handled).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
    expect(sent.join(" ")).toContain(CHILDCARE_PROFILE_PATH);
  });

  it("revoked authorities do not unlock the loop (fail closed to the responder)", async () => {
    const fake = makeFakeDb();
    fake.seed("childcare_flags/global", FLAGS_ON);
    seedAuthority(fake, "revoked");
    const { send } = makeSend();
    const runAgent = vi.fn(async () => "");
    await routeChildcareSessionInbound({
      phone: PHONE, chatId: CHAT, text: "status?",
      session: CHILD_SESSION, db: fake.db, sendMessage: send, runAgent,
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("classified family with a live child authority runs the REAL agent loop (no zepThreadId ever passed)", async () => {
    const fake = makeFakeDb();
    fake.seed("childcare_flags/global", FLAGS_ON);
    seedAuthority(fake);
    const { send, sent } = makeSend();
    const runAgent = vi.fn(async (_p: Record<string, unknown>) => "On it!");
    const handled = await routeChildcareSessionInbound({
      phone: PHONE, chatId: CHAT, text: "can we move Thursday to 3pm?",
      session: { ...CHILD_SESSION, zepThreadId: "zep-should-not-ride" },
      eventId: "evt-1",
      db: fake.db, sendMessage: send, runAgent,
    });
    expect(handled).toBe(true);
    expect(runAgent).toHaveBeenCalledTimes(1);
    const params = runAgent.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toMatchObject({
      text: "can we move Thursday to 3pm?",
      phone: PHONE,
      userId: UID,
      userType: "client",
      seniorId: "",
      sourceTurn: { conversationId: CHAT, messageId: "evt-1" },
    });
    expect("zepThreadId" in params).toBe(false); // R50 — memory identity never rides
    expect(sent).toEqual([]); // the loop delivers its own reply
  });

  it("a loop failure falls closed to the static status message (never senior routing)", async () => {
    const fake = makeFakeDb();
    fake.seed("childcare_flags/global", FLAGS_ON);
    seedAuthority(fake);
    const { send, sent } = makeSend();
    const runAgent = vi.fn(async () => { throw new Error("model outage"); });
    const handled = await routeChildcareSessionInbound({
      phone: PHONE, chatId: CHAT, text: "hello?",
      session: CHILD_SESSION, db: fake.db, sendMessage: send, runAgent,
    });
    expect(handled).toBe(true);
    expect(sent.join(" ")).toContain("secure account");
  });
});

describe("ensureFamilyChildcareObjective", () => {
  it("is create-once per adult across channels", async () => {
    const fake = makeFakeDb();
    const first = await ensureFamilyChildcareObjective(UID, { db: fake.db, channel: "linq" });
    const second = await ensureFamilyChildcareObjective(UID, { db: fake.db, channel: "web" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.objective.objectiveId).toBe(first.objective.objectiveId);
    // The winner's record is authoritative — channel stays "linq".
    expect(second.objective.channel).toBe("linq");
  });
});

// ── Front door Stage 1: the caregiver + cold-text childcare ingress ───────────
//
// docs/architecture/childcare-front-door-design.md. U5 shipped fail-closed
// stubs on the assumption that a CAREGIVER could never carry a childcare stamp
// (the only origin was gated on role === "client"). Stage 1 removes that gate,
// so these rows pin the branch those stubs were missing: a childcare caregiver
// is stamped and answered deterministically — never family copy, never the
// senior caregiver loop, and never a silent drop.

describe("handleChildcareCaregiverBridgeInbound — a caregiver childcare signup", () => {
  function armedDb(flagsOn = true): FakeDb {
    return makeFakeDb({
      ...(flagsOn ? { "childcare_flags/global": FLAGS_ON } : {}),
      [`web_onboarding_sessions/${PHONE}`]: bridgeDoc({ role: "caregiver" }),
    });
  }

  async function runCaregiverBridge(fake: FakeDb, send: ReturnType<typeof makeSend>["send"], overrides: Record<string, unknown> = {}) {
    return handleChildcareCaregiverBridgeInbound({
      phone: PHONE,
      chatId: CHAT,
      service: "SMS",
      preferredLanguage: "en",
      webSessionData: bridgeDoc({ role: "caregiver", ...overrides }),
      db: fake.db,
      sendMessage: send,
      now: new Date("2026-07-25T12:00:00.000Z"),
    });
  }

  it("stamps a CAREGIVER childcare session at the hold step", async () => {
    const fake = armedDb();
    const { send } = makeSend();
    expect(await runCaregiverBridge(fake, send)).toBe(true);
    expect(fake.get(`agent_sessions/${PHONE}`)).toMatchObject({
      careVertical: "child",
      verticalIntent: "child",
      userType: "caregiver",
      userId: UID,
      onboardingStep: CHILDCARE_STEP_CAREGIVER_HOLD,
      optedIn: true,
    });
  });

  it("sends the CAREGIVER childcare route, never the family child-profile route", async () => {
    const fake = armedDb();
    const { send, sent } = makeSend();
    await runCaregiverBridge(fake, send);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(CHILDCARE_CAREGIVER_PATH);
    expect(sent[0]).not.toContain(CHILDCARE_PROFILE_PATH);
    expect(sent[0]).toMatch(/reply stop/i);
  });

  it("carries NO child detail and creates NO family enrollment objective", async () => {
    const fake = armedDb();
    const { send, sent } = makeSend();
    await runCaregiverBridge(fake, send);
    expect(fake.get(`${OBJECTIVES_COLLECTION}/${familyChildcareObjectiveId(UID)}`)).toBeUndefined();
    // Static template only: no interpolated user text, no names, no ages.
    expect(sent[0]).not.toMatch(/\d{1,2}\s*(year|yr|month)s?\s*old/i);
  });

  it("initializes NO memory (R50/AE23) — the zep tripwire is untouched", async () => {
    const fake = armedDb();
    const { send } = makeSend();
    await runCaregiverBridge(fake, send);
    expect(zepInit).not.toHaveBeenCalled();
  });

  it("flags OFF at inbound time fails closed to the waitlist state, never senior onboarding", async () => {
    const fake = armedDb(false);
    const { send, sent } = makeSend();
    expect(await runCaregiverBridge(fake, send)).toBe(true);
    expect(fake.get(`agent_sessions/${PHONE}`)).toMatchObject({
      careVertical: "child",
      userType: "caregiver",
      onboardingStep: CHILDCARE_STEP_UNAVAILABLE,
    });
    expect(sent[0]).toMatch(/isn't\s+available/i);
    expect(sent[0]).not.toContain(CHILDCARE_CAREGIVER_PATH);
  });

  it("a missing uid also fails closed (never a half-enrolled caregiver)", async () => {
    const fake = armedDb();
    const { send } = makeSend();
    await runCaregiverBridge(fake, send, { uid: "" });
    expect(fake.get(`agent_sessions/${PHONE}`)?.onboardingStep).toBe(CHILDCARE_STEP_UNAVAILABLE);
  });

  it("marks the web bridge connected so the /start tab flips", async () => {
    const fake = armedDb();
    const { send } = makeSend();
    await runCaregiverBridge(fake, send);
    expect(fake.get(`web_onboarding_sessions/${PHONE}`)).toMatchObject({ status: "connected", chatId: CHAT });
  });
});

describe("routeChildcareCaregiverInbound — later turns on a caregiver childcare session", () => {
  const caregiverSession = (over: Record<string, unknown> = {}) => ({
    chatId: CHAT, phone: PHONE, userType: "caregiver",
    careVertical: "child", verticalIntent: "child",
    userId: UID, onboardingStep: CHILDCARE_STEP_CAREGIVER_HOLD, ...over,
  });

  it("answers with the caregiver status line and the secure caregiver route", async () => {
    const fake = makeFakeDb({ "childcare_flags/global": FLAGS_ON });
    const { send, sent } = makeSend();
    expect(await routeChildcareCaregiverInbound({
      phone: PHONE, chatId: CHAT, text: "how do I finish?", session: caregiverSession(),
      db: fake.db, sendMessage: send,
    })).toBe(true);
    expect(sent[0]).toContain(CHILDCARE_CAREGIVER_PATH);
    expect(zepInit).not.toHaveBeenCalled();
  });

  it("R53: an incident report still escalates FIRST, even with no flags doc at all", async () => {
    const fake = makeFakeDb({});
    const { send, sent } = makeSend();
    await routeChildcareCaregiverInbound({
      phone: PHONE, chatId: CHAT,
      text: "the child is hurt and bleeding, I think she needs an ambulance",
      session: caregiverSession(), db: fake.db, sendMessage: send,
    });
    expect(sent[0]).toBe(CHILDCARE_INCIDENT_ACK);
    expect(opsAlerts.length).toBeGreaterThan(0);
  });

  it("flags OFF stays dark: the waitlist line, no link to a disabled surface", async () => {
    const fake = makeFakeDb({});
    const { send, sent } = makeSend();
    await routeChildcareCaregiverInbound({
      phone: PHONE, chatId: CHAT, text: "any update?", session: caregiverSession(),
      db: fake.db, sendMessage: send,
    });
    expect(sent[0]).toMatch(/isn't\s+available/i);
    expect(sent[0]).not.toContain(CHILDCARE_CAREGIVER_PATH);
  });

  it("flags flipped back ON upgrades a waitlisted caregiver to the hold step", async () => {
    const fake = makeFakeDb({
      "childcare_flags/global": FLAGS_ON,
      [`agent_sessions/${PHONE}`]: caregiverSession({ onboardingStep: CHILDCARE_STEP_UNAVAILABLE }),
    });
    const { send, sent } = makeSend();
    await routeChildcareCaregiverInbound({
      phone: PHONE, chatId: CHAT, text: "hi", db: fake.db, sendMessage: send,
      session: caregiverSession({ onboardingStep: CHILDCARE_STEP_UNAVAILABLE }),
    });
    expect(fake.get(`agent_sessions/${PHONE}`)?.onboardingStep).toBe(CHILDCARE_STEP_CAREGIVER_HOLD);
    expect(sent[0]).toContain(CHILDCARE_CAREGIVER_PATH);
  });

  it("routeChildcareSessionInbound SPLITS on role: a caregiver never reaches the family branches", async () => {
    const fake = makeFakeDb({ "childcare_flags/global": FLAGS_ON });
    const { send, sent } = makeSend();
    const runAgent = vi.fn(async () => "should never run");
    expect(await routeChildcareSessionInbound({
      phone: PHONE, chatId: CHAT, text: "when do I get approved?",
      session: caregiverSession(), db: fake.db, sendMessage: send, runAgent,
    })).toBe(true);
    // Caregiver copy, and NONE of the family machinery ran.
    expect(sent[0]).toContain(CHILDCARE_CAREGIVER_PATH);
    expect(sent[0]).not.toContain(CHILDCARE_PROFILE_PATH);
    expect(runAgent).not.toHaveBeenCalled();
    expect(getPendingActions).not.toHaveBeenCalled();
  });
});

describe("handleChildcareColdInbound — a childcare intent classified from a cold text", () => {
  it("client: stamps child, holds at the cold-signup step, sends the SECURE SIGNUP entry", async () => {
    const fake = makeFakeDb({ "childcare_flags/global": FLAGS_ON });
    const { send, sent } = makeSend();
    expect(await handleChildcareColdInbound({
      phone: PHONE, chatId: CHAT, service: "SMS", preferredLanguage: "en", role: "client",
      sessionPatch: { careVertical: "child", verticalIntent: "child" },
      db: fake.db, sendMessage: send, now: new Date("2026-07-25T12:00:00.000Z"),
    })).toBe(true);
    expect(fake.get(`agent_sessions/${PHONE}`)).toMatchObject({
      careVertical: "child", verticalIntent: "child", userType: "client",
      onboardingStep: CHILDCARE_STEP_COLD_SIGNUP,
    });
    // There is no account yet, so the SIGNUP entry is the right link — never
    // the authenticated child-profile route (which would hit a login wall).
    expect(sent[0]).toContain(CHILDCARE_CLIENT_SIGNUP_PATH);
    expect(zepInit).not.toHaveBeenCalled();
  });

  it("caregiver: sends the caregiver signup entry", async () => {
    const fake = makeFakeDb({ "childcare_flags/global": FLAGS_ON });
    const { send, sent } = makeSend();
    await handleChildcareColdInbound({
      phone: PHONE, chatId: CHAT, service: "SMS", preferredLanguage: "en", role: "caregiver",
      db: fake.db, sendMessage: send,
    });
    expect(fake.get(`agent_sessions/${PHONE}`)?.userType).toBe("caregiver");
    expect(sent[0]).toContain(CHILDCARE_CAREGIVER_SIGNUP_PATH);
  });

  it("role UNRESOLVED: the role is not guessed — a neutral entry lets them choose", async () => {
    const fake = makeFakeDb({ "childcare_flags/global": FLAGS_ON });
    const { send, sent } = makeSend();
    await handleChildcareColdInbound({
      phone: PHONE, chatId: CHAT, service: "SMS", preferredLanguage: "en", role: null,
      db: fake.db, sendMessage: send,
    });
    expect(fake.get(`agent_sessions/${PHONE}`)?.userType).toBeNull();
    expect(sent[0]).toContain(CHILDCARE_CLIENT_SIGNUP_PATH);
    expect(sent[0]).toMatch(/family looking for care or a caregiver/i);
  });

  it("R-FD8 flags OFF: the waitlist state, never a bypass and never senior", async () => {
    const fake = makeFakeDb({});
    const { send, sent } = makeSend();
    await handleChildcareColdInbound({
      phone: PHONE, chatId: CHAT, service: "SMS", preferredLanguage: "en", role: "client",
      db: fake.db, sendMessage: send,
    });
    expect(fake.get(`agent_sessions/${PHONE}`)).toMatchObject({
      careVertical: "child", onboardingStep: CHILDCARE_STEP_UNAVAILABLE,
    });
    expect(sent[0]).toMatch(/isn't\s+available/i);
    expect(sent[0]).not.toContain(CHILDCARE_CLIENT_SIGNUP_PATH);
  });

  it("mergeSession keeps existing identity fields (the R-FD7 switch re-stamp)", async () => {
    const fake = makeFakeDb({
      "childcare_flags/global": FLAGS_ON,
      [`agent_sessions/${PHONE}`]: {
        chatId: CHAT, phone: PHONE, userType: "client", userId: "existing-uid",
        onboardingStep: "client_ask_needs", createdAt: "2026-07-01T00:00:00.000Z",
        onboardingData: { firstName: "Alex" },
      },
    });
    const { send } = makeSend();
    await handleChildcareColdInbound({
      phone: PHONE, chatId: CHAT, service: "SMS", preferredLanguage: "en", role: "client",
      sessionPatch: { careVertical: "child", verticalIntent: "child" },
      mergeSession: true, db: fake.db, sendMessage: send,
    });
    const s = fake.get(`agent_sessions/${PHONE}`);
    expect(s).toMatchObject({
      userId: "existing-uid",
      careVertical: "child",
      onboardingStep: CHILDCARE_STEP_COLD_SIGNUP,
      createdAt: "2026-07-01T00:00:00.000Z", // a re-stamp does not reset it
    });
    expect(s?.onboardingData).toEqual({ firstName: "Alex" });
  });

  it("a later turn on a cold-signup session keeps pointing at the SIGNUP entry", async () => {
    const fake = makeFakeDb({ "childcare_flags/global": FLAGS_ON });
    const { send, sent } = makeSend();
    await handleChildcareSessionInbound({
      phone: PHONE, chatId: CHAT,
      session: {
        chatId: CHAT, phone: PHONE, userType: "client",
        careVertical: "child", verticalIntent: "child",
        onboardingStep: CHILDCARE_STEP_COLD_SIGNUP,
      },
      db: fake.db, sendMessage: send,
    });
    expect(sent[0]).toContain(CHILDCARE_CLIENT_SIGNUP_PATH);
    expect(sent[0]).not.toContain(CHILDCARE_PROFILE_PATH);
  });
});
