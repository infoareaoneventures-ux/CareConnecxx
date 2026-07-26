// Front door STAGE 2 — the INGRESS wiring.
//
// signupIngress.test.ts (unchanged) pins Stage 1's behaviour. This file pins what
// Stage 2 added to the same module:
//   • `childcare_caregiver_hold` is no longer a dead end — the real conversational
//     funnel runs behind it;
//   • Stage 1's ORDERING is preserved exactly: incident classification first
//     (pre-model, pre-flags), then the flags gate, then the funnel;
//   • the funnel is FAIL-OPEN to the Stage 1 status line;
//   • the CHILD → SENIOR switch is consulted from ONE site, covering both roles,
//     immediately after the incident classifier — and costs nothing on an
//     ordinary childcare turn.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("../observability/caraOpsAlerts", () => ({
  createCaraOpsAlert: vi.fn(async () => true),
}));

// The child → senior switch detector's only model dependency.
const parseWithClaude = vi.fn(async (..._a: unknown[]) => "none");
vi.mock("../utils/parseWithClaude", () => ({
  parseWithClaude: (...a: unknown[]) => parseWithClaude(...a),
}));

const zepInit = vi.fn(async () => {});
vi.mock("../memory/zepClient", () => ({
  initializeZepOnFirstContact: () => zepInit(),
  addUserMessageToZep: () => zepInit(),
  addBusinessDataToZep: () => zepInit(),
}));

import { makeFakeDb, type FakeDb } from "./__tests__/fakeFirestore";
import { bustChildcareFlagsCache } from "../config/featureFlags";
import {
  CHILDCARE_CAREGIVER_PATH,
  CHILDCARE_PROFILE_PATH,
  CHILDCARE_STEP_CAREGIVER_HOLD,
  CHILDCARE_STEP_UNAVAILABLE,
  caregiverFunnelOpeningMessage,
  routeChildcareCaregiverInbound,
  routeChildcareSessionInbound,
} from "./signupIngress";
import { CHILDCARE_INCIDENT_ACK } from "./incidentSignal";

const PHONE = "+15550008888";
const CHAT = "chat-s2";
const UID = "cg-s2";
const FLAGS_ON = {
  CHILDCARE_ENABLED: true,
  CHILDCARE_DISCOVERY_ENABLED: true,
  CHILDCARE_WRITES_ENABLED: true,
  CHILDCARE_PROACTIVE_ENABLED: false,
};

function caregiverSession(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chatId: CHAT, phone: PHONE, userType: "caregiver",
    careVertical: "child", verticalIntent: "child",
    userId: UID, onboardingStep: CHILDCARE_STEP_CAREGIVER_HOLD, ...over,
  };
}

function rig(flagsOn = true) {
  const fake: FakeDb = makeFakeDb(flagsOn ? { "childcare_flags/global": FLAGS_ON } : {});
  const sent: string[] = [];
  const send = vi.fn(async (_c: string, t: string) => { sent.push(t); });
  const runFunnel = vi.fn(async (_p: Record<string, unknown>) => ({
    handled: true, step: "caregiver_ask_childcare_experience",
    reply: "funnel reply", outcome: "funnel_started_delta",
  }));
  return { fake, sent, send, runFunnel };
}

beforeEach(() => {
  vi.clearAllMocks();
  bustChildcareFlagsCache();
  parseWithClaude.mockResolvedValue("none");
});

// ── The funnel replaces the hold ─────────────────────────────────────────────

describe("routeChildcareCaregiverInbound now runs the Stage 2 funnel", () => {
  it("hands the turn to the funnel, with the STATIC opening line that carries the secure route", async () => {
    const r = rig();
    expect(await routeChildcareCaregiverInbound({
      phone: PHONE, chatId: CHAT, text: "how do I finish?", session: caregiverSession(),
      db: r.fake.db, sendMessage: r.send, runFunnel: r.runFunnel as never,
    })).toBe(true);
    expect(r.runFunnel).toHaveBeenCalledTimes(1);
    const args = r.runFunnel.mock.calls[0][0];
    expect(args).toMatchObject({ phone: PHONE, chatId: CHAT, text: "how do I finish?" });
    expect(String(args.openingLine)).toContain(CHILDCARE_CAREGIVER_PATH);
    // The funnel delivered its own reply; the ingress did not also send one.
    expect(r.sent).toEqual([]);
    expect(zepInit).not.toHaveBeenCalled();
  });

  it("the opening line names BOTH routes and never the family route", () => {
    const opening = caregiverFunnelOpeningMessage();
    expect(opening).toContain(CHILDCARE_CAREGIVER_PATH);
    expect(opening).not.toContain(CHILDCARE_PROFILE_PATH);
    expect(opening).toMatch(/right here over text/i);
    expect(opening).toMatch(/in your account/i);
  });

  it("ORDER: an incident escalates FIRST — the funnel is never reached", async () => {
    const r = rig(false); // no flags doc at all: escalation must still win
    await routeChildcareCaregiverInbound({
      phone: PHONE, chatId: CHAT,
      text: "the child is hurt and bleeding, I think she needs an ambulance",
      session: caregiverSession(), db: r.fake.db, sendMessage: r.send, runFunnel: r.runFunnel as never,
    });
    expect(r.sent[0]).toBe(CHILDCARE_INCIDENT_ACK);
    expect(r.runFunnel).not.toHaveBeenCalled();
  });

  it("ORDER: flags OFF stays dark — the funnel is never reached", async () => {
    const r = rig(false);
    await routeChildcareCaregiverInbound({
      phone: PHONE, chatId: CHAT, text: "any update?", session: caregiverSession(),
      db: r.fake.db, sendMessage: r.send, runFunnel: r.runFunnel as never,
    });
    expect(r.sent[0]).toMatch(/isn't\s+available/i);
    expect(r.sent[0]).not.toContain(CHILDCARE_CAREGIVER_PATH);
    expect(r.runFunnel).not.toHaveBeenCalled();
  });

  it("the flags-off→on UPGRADE welcomes first; the funnel starts on the NEXT turn", async () => {
    const r = rig();
    r.fake.seed(`agent_sessions/${PHONE}`, caregiverSession({ onboardingStep: CHILDCARE_STEP_UNAVAILABLE }));
    await routeChildcareCaregiverInbound({
      phone: PHONE, chatId: CHAT, text: "hi",
      session: caregiverSession({ onboardingStep: CHILDCARE_STEP_UNAVAILABLE }),
      db: r.fake.db, sendMessage: r.send, runFunnel: r.runFunnel as never,
    });
    expect(r.fake.get(`agent_sessions/${PHONE}`)?.onboardingStep).toBe(CHILDCARE_STEP_CAREGIVER_HOLD);
    expect(r.sent[0]).toContain(CHILDCARE_CAREGIVER_PATH);
    expect(r.runFunnel).not.toHaveBeenCalled();
  });

  it("FAIL-OPEN: a funnel failure falls back to the Stage 1 status line, never silence", async () => {
    for (const broken of [
      vi.fn(async () => { throw new Error("funnel down"); }),
      vi.fn(async () => ({ handled: false, step: "", reply: "", outcome: "noop" })),
    ]) {
      const r = rig();
      expect(await routeChildcareCaregiverInbound({
        phone: PHONE, chatId: CHAT, text: "hello?", session: caregiverSession(),
        db: r.fake.db, sendMessage: r.send, runFunnel: broken as never,
      })).toBe(true);
      expect(r.sent).toHaveLength(1);
      expect(r.sent[0]).toContain(CHILDCARE_CAREGIVER_PATH);
    }
  });

  it("a COLD caregiver (no account yet) also gets the funnel, not a dead-end link", async () => {
    const r = rig();
    await routeChildcareCaregiverInbound({
      phone: PHONE, chatId: CHAT, text: "I want nanny jobs",
      session: caregiverSession({ onboardingStep: "childcare_cold_signup", userId: undefined }),
      db: r.fake.db, sendMessage: r.send, runFunnel: r.runFunnel as never,
    });
    expect(r.runFunnel).toHaveBeenCalledTimes(1);
    // The session's routing step converges on the funnel's own step.
    expect(r.fake.get(`agent_sessions/${PHONE}`)?.onboardingStep).toBe(CHILDCARE_STEP_CAREGIVER_HOLD);
  });

  it("routeChildcareSessionInbound still SPLITS on role, and the caregiver branch reaches the funnel", async () => {
    const r = rig();
    const runAgent = vi.fn(async () => "should never run");
    expect(await routeChildcareSessionInbound({
      phone: PHONE, chatId: CHAT, text: "when do I get reviewed?",
      session: caregiverSession(), db: r.fake.db, sendMessage: r.send, runAgent,
    })).toBe(true);
    // The family agent loop never ran; the caregiver route owns the turn.
    expect(runAgent).not.toHaveBeenCalled();
    // Real funnel (not injected here) replied — never the family route.
    expect(r.sent.join(" ")).not.toContain(CHILDCARE_PROFILE_PATH);
  });
});

// ── The CHILD → SENIOR switch is consulted from ONE site, for BOTH roles ─────

describe("child → senior switch is owned inside the childcare path (deliverable 6a)", () => {
  const familySession = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    chatId: CHAT, phone: PHONE, userType: "client",
    careVertical: "child", verticalIntent: "child",
    userId: UID, onboardingStep: "childcare_web_profile", ...over,
  });

  it("COST GUARD: an ordinary childcare turn never calls the model", async () => {
    const r = rig();
    await routeChildcareSessionInbound({
      phone: PHONE, chatId: CHAT, text: "how do I finish setup?",
      session: familySession(), db: r.fake.db, sendMessage: r.send,
      runAgent: vi.fn(async () => ""),
    });
    expect(parseWithClaude).not.toHaveBeenCalled();
  });

  it("FAMILY: a clear switch parks a confirmation and does NOT re-stamp (R-FD7)", async () => {
    parseWithClaude.mockResolvedValue('{"switchTo":"senior"}');
    const r = rig();
    const session = familySession();
    const runAgent = vi.fn(async () => "");
    expect(await routeChildcareSessionInbound({
      phone: PHONE, chatId: CHAT,
      text: "wait, I need this for my mother, she has dementia — not my kids",
      session, db: r.fake.db, sendMessage: r.send, runAgent,
    })).toBe(true);
    expect(r.sent[0]).toMatch(/switch this over to care for an adult/i);
    expect(session.careVertical).toBe("child"); // unmoved until confirmed
    expect(session.pendingVerticalSwitch).toMatchObject({ switchTo: "senior" });
    // Nothing else in the childcare router ran.
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("CAREGIVER: the SAME site covers them — the funnel is not reached this turn", async () => {
    parseWithClaude.mockResolvedValue('{"switchTo":"senior"}');
    const r = rig();
    const session = caregiverSession();
    await routeChildcareSessionInbound({
      phone: PHONE, chatId: CHAT,
      text: "actually I'd rather work with elderly clients, I'm a CNA",
      session, db: r.fake.db, sendMessage: r.send, runAgent: vi.fn(async () => ""),
    });
    expect(r.sent[0]).toMatch(/switch this over to care for an adult/i);
    expect(session.careVertical).toBe("child");
  });

  it("ORDER: an incident still escalates BEFORE the switch detector (R53)", async () => {
    parseWithClaude.mockResolvedValue('{"switchTo":"senior"}');
    const r = rig(false);
    await routeChildcareSessionInbound({
      phone: PHONE, chatId: CHAT,
      text: "my daughter is bleeding and my mother with dementia is here too, help",
      session: familySession(), db: r.fake.db, sendMessage: r.send, runAgent: vi.fn(async () => ""),
    });
    expect(r.sent[0]).toBe(CHILDCARE_INCIDENT_ACK);
    expect(parseWithClaude).not.toHaveBeenCalled();
  });

  it("a confirmed YES re-stamps senior and hands back to the senior funnel at ask_role", async () => {
    const r = rig();
    const session = familySession({
      pendingVerticalSwitch: { switchTo: "senior", askedAt: new Date().toISOString(), asks: 1 },
    });
    await routeChildcareSessionInbound({
      phone: PHONE, chatId: CHAT, text: "yes", session,
      db: r.fake.db, sendMessage: r.send, runAgent: vi.fn(async () => ""),
    });
    expect(session.careVertical).toBe("senior");
    expect(session.onboardingStep).toBe("ask_role");
    expect(r.sent[0]).toMatch(/set this up for an adult instead/i);
    expect(r.fake.get(`agent_sessions/${PHONE}`)).toMatchObject({ careVertical: "senior" });
  });

  it("a detector failure never breaks the childcare turn", async () => {
    parseWithClaude.mockRejectedValue(new Error("model down"));
    const r = rig();
    const session = familySession();
    expect(await routeChildcareSessionInbound({
      phone: PHONE, chatId: CHAT, text: "this is for my mother with dementia",
      session, db: r.fake.db, sendMessage: r.send, runAgent: vi.fn(async () => ""),
    })).toBe(true);
    expect(session.careVertical).toBe("child");
    expect(session.pendingVerticalSwitch).toBeUndefined();
  });
});
