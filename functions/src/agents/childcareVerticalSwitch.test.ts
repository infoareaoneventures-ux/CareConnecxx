// Front door STAGE 2, deliverable 6a — CHILD → SENIOR switch.
//
// Stage 1 shipped a pure switch module that supports both directions and wired
// only senior → child. This suite pins the other direction's conversational
// owner: detection, the R-FD7 confirmation gate (detection NEVER re-stamps), the
// max-re-ask deny-by-default, the TTL, and the cost guard that keeps the model
// out of the way on ordinary childcare turns.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { makeFakeDb, type FakeDb } from "../childcare/__tests__/fakeFirestore";
import { handleChildcareToSeniorSwitchTurn } from "./childcareVerticalSwitch";
import { CHILDCARE_CAREGIVER_FUNNEL_FIELD } from "./childcareCaregiverFunnel";
import { VERTICAL_SWITCH_HOLD_TTL_MS } from "./verticalFrontDoor";

const PHONE = "+15550004444";
const CHAT = "chat-sw";
const NOW = new Date("2026-07-25T12:00:00.000Z");

function harness(session: Record<string, unknown> = {}, detectTo: "senior" | null = "senior") {
  const fake: FakeDb = makeFakeDb();
  const sent: string[] = [];
  const send = vi.fn(async (_c: string, t: string) => { sent.push(t); });
  const detect = vi.fn(async (_args: Record<string, unknown>) => ({ switchTo: detectTo, reason: "model" as const }));
  const s: Record<string, unknown> = {
    chatId: CHAT, phone: PHONE, userType: "client",
    careVertical: "child", verticalIntent: "child",
    onboardingStep: "childcare_web_profile", ...session,
  };
  const run = (text: string, now: Date = NOW) =>
    handleChildcareToSeniorSwitchTurn({
      phone: PHONE, chatId: CHAT, text, session: s,
      db: fake.db, sendMessage: send, now, detect: detect as never,
    });
  return { fake, sent, send, detect, session: s, run };
}

beforeEach(() => vi.clearAllMocks());

describe("cost guard: the model is only consulted when it could matter", () => {
  it("an ordinary childcare turn spends NOTHING (no model call, not handled)", async () => {
    for (const text of [
      "how do I finish setup?", "can we move Thursday to 3pm?", "any update?",
      "what's my rate again?", "hi",
    ]) {
      const h = harness();
      const r = await h.run(text);
      expect(r.handled).toBe(false);
      expect(r.outcome).toBe("no_senior_signal");
      expect(h.detect).not.toHaveBeenCalled();
      expect(h.sent).toEqual([]);
    }
  });

  it("empty text and __RESUME__ are never classified", async () => {
    const h = harness();
    expect((await h.run("")).handled).toBe(false);
    expect((await h.run("__RESUME__")).outcome).toBe("no_text");
    expect(h.detect).not.toHaveBeenCalled();
  });

  it("one turn is never classified twice (the two call sites share a marker)", async () => {
    const h = harness();
    await h.run("actually this is for my mother, she has dementia");
    h.detect.mockClear();
    const second = await h.run("actually this is for my mother, she has dementia");
    expect(second.outcome).toBe("already_checked");
    expect(h.detect).not.toHaveBeenCalled();
  });
});

describe("R-FD7: detection PARKS and asks — it never re-stamps", () => {
  it("a senior signal parks a hold and sends the confirmation", async () => {
    const h = harness();
    const r = await h.run("wait, I need this for my mother, not my kids");
    expect(r).toEqual({ handled: true, outcome: "switch_hold_parked" });
    expect(h.detect).toHaveBeenCalledTimes(1);
    expect(h.detect.mock.calls[0][0]).toMatchObject({ currentVertical: "child", currentRole: "client" });
    // THE stamp has NOT moved.
    expect(h.session.careVertical).toBe("child");
    expect(h.session.verticalIntent).toBe("child");
    expect(h.session.pendingVerticalSwitch).toMatchObject({ switchTo: "senior", asks: 1 });
    expect(h.sent[0]).toMatch(/switch this over to care for an adult/i);
    expect(h.sent[0]).toMatch(/Reply yes to switch/i);
  });

  it("a detected NON-switch leaves everything alone", async () => {
    const h = harness({}, null);
    const r = await h.run("my mom watches them sometimes, she has dementia though");
    expect(r.handled).toBe(false);
    expect(h.session.pendingVerticalSwitch).toBeUndefined();
    expect(h.session.careVertical).toBe("child");
  });

  it("a detector failure never breaks the turn", async () => {
    const fake = makeFakeDb();
    const sent: string[] = [];
    const s: Record<string, unknown> = { userType: "client", careVertical: "child" };
    const r = await handleChildcareToSeniorSwitchTurn({
      phone: PHONE, chatId: CHAT, text: "this is for my mother with dementia",
      session: s, db: fake.db, now: NOW,
      sendMessage: async (_c, t) => { sent.push(t); },
      detect: (async () => { throw new Error("model down"); }) as never,
    });
    expect(r.handled).toBe(false);
    expect(s.careVertical).toBe("child");
    expect(sent).toEqual([]);
  });
});

describe("the confirmation answer", () => {
  const held = { pendingVerticalSwitch: { switchTo: "senior", askedAt: NOW.toISOString(), asks: 1 } };

  it("YES re-stamps senior, clears the childcare funnel state, and re-enters ask_role", async () => {
    const h = harness({ ...held, [CHILDCARE_CAREGIVER_FUNNEL_FIELD]: { step: "caregiver_ask_childcare_ages", data: { name: "Ana" } } });
    const r = await h.run("yes");
    expect(r).toEqual({ handled: true, outcome: "switch_confirmed_senior" });
    expect(h.session.careVertical).toBe("senior");
    expect(h.session.verticalIntent).toBe("senior");
    expect(h.session.pendingVerticalSwitch).toBeNull();
    // Vertical-specific ROUTING state does not ride along into the other vertical.
    expect(h.session[CHILDCARE_CAREGIVER_FUNNEL_FIELD]).toBeNull();
    expect(h.session.onboardingStep).toBe("ask_role");
    expect(h.sent[0]).toMatch(/set this up for an adult instead/i);
    // Persisted, not just in memory.
    expect(h.fake.get(`agent_sessions/${PHONE}`)).toMatchObject({
      careVertical: "senior", onboardingStep: "ask_role",
    });
  });

  it("NO clears the hold and keeps them in childcare", async () => {
    const h = harness(held);
    const r = await h.run("no, sorry");
    expect(r).toEqual({ handled: true, outcome: "switch_declined" });
    expect(h.session.careVertical).toBe("child");
    expect(h.session.pendingVerticalSwitch).toBeNull();
    expect(h.sent[0]).toMatch(/staying with childcare/i);
  });

  it("an unclear answer re-asks ONCE, then denies by default (no switch)", async () => {
    const h = harness(held);
    const first = await h.run("what does that mean?");
    expect(first).toEqual({ handled: true, outcome: "switch_reask" });
    expect((h.session.pendingVerticalSwitch as { asks: number }).asks).toBe(2);

    // A second unclear reply on the re-asked hold abandons it.
    const h2 = harness({ pendingVerticalSwitch: { switchTo: "senior", askedAt: NOW.toISOString(), asks: 2 } });
    const second = await h2.run("hmm");
    expect(second).toEqual({ handled: false, outcome: "switch_abandoned" });
    expect(h2.session.careVertical).toBe("child"); // deny-by-default = do NOT switch
    expect(h2.session.pendingVerticalSwitch).toBeNull();
  });

  it("an EXPIRED hold is abandoned and the turn continues as an ordinary childcare turn", async () => {
    const h = harness(held);
    const later = new Date(NOW.getTime() + VERTICAL_SWITCH_HOLD_TTL_MS + 1000);
    const r = await h.run("yes", later);
    expect(r).toEqual({ handled: false, outcome: "hold_expired" });
    expect(h.session.careVertical).toBe("child"); // a stale yes never re-stamps
    expect(h.session.pendingVerticalSwitch).toBeNull();
  });

  it("works for a CAREGIVER childcare session too (one site, both roles)", async () => {
    const h = harness({ ...held, userType: "caregiver" });
    const r = await h.run("yes");
    expect(r.outcome).toBe("switch_confirmed_senior");
    expect(h.session.careVertical).toBe("senior");
    expect(h.sent[0]).toMatch(/caregiver looking for work/i);
  });
});
