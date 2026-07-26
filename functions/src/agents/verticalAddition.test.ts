// Front door STAGE 2, deliverables 6b + 6c.
//
// 6b — a COMPLETED session could not add a vertical: `verticalSwitchEligibleStep`
// excludes "complete", so "I also need childcare" reached runQaAgent. Per R-FD6
// that is an ADDITION (two independent profiles), so this suite pins that the
// addition path NEVER re-stamps `careVertical` and never disturbs the existing
// senior state — while still reaching the right destination per role.
//
// 6c — `verticalNotedInterest` was stamped by Stage 1's dual ask and consumed by
// nobody. Pinned here: surfaced at most ONCE, only at a natural moment, and
// cleared so it can never nag.

import { describe, it, expect, vi, beforeEach } from "vitest";

// The addition path reads the canonical childcare route constants from
// childcare/signupIngress, which pulls in observability/auditLog — a module with
// a top-level admin.firestore(). Same shallow mock the ingress suite uses.
vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));

import { makeFakeDb, type FakeDb } from "../childcare/__tests__/fakeFirestore";
import {
  NOTED_INTEREST_OFFER_FIELD,
  detectVerticalAddition,
  handleVerticalAdditionTurn,
  isLowContentTurn,
  notedInterestOffer,
} from "./verticalAddition";
import { CHILDCARE_CAREGIVER_FUNNEL_FIELD } from "./childcareCaregiverFunnel";

const PHONE = "+15550005555";
const CHAT = "chat-add";
const UID = "acct-uid-1";
const NOW = new Date("2026-07-25T12:00:00.000Z");

function harness(session: Record<string, unknown> = {}, opts: { addVertical?: "child" | null; childcareEnabled?: boolean } = {}) {
  const fake: FakeDb = makeFakeDb();
  const sent: string[] = [];
  const send = vi.fn(async (_c: string, t: string) => { sent.push(t); });
  const detect = vi.fn(async () => ({
    addVertical: opts.addVertical === undefined ? ("child" as const) : opts.addVertical,
    reason: "model",
  }));
  const runCaregiverFunnel = vi.fn(async (_p: Record<string, unknown>) => ({
    handled: true, step: "caregiver_ask_childcare_experience",
    reply: "opening + delta question", outcome: "funnel_started_delta",
  }));
  const ensureFamilyObjective = vi.fn(async () => ({ created: true }));
  const s: Record<string, unknown> = {
    chatId: CHAT, phone: PHONE, userType: "client", userId: UID,
    onboardingStep: "complete", seniorId: "senior-1", ...session,
  };
  const run = (text: string) =>
    handleVerticalAdditionTurn({
      phone: PHONE, chatId: CHAT, text, session: s,
      sendMessage: send, db: fake.db, now: NOW,
      detect: detect as never,
      childcareEnabled: opts.childcareEnabled ?? true,
      runCaregiverFunnel: runCaregiverFunnel as never,
      ensureFamilyObjective: ensureFamilyObjective as never,
      appLinkFor: (p: string) => `https://app.test${p}`,
    });
  return { fake, sent, send, detect, runCaregiverFunnel, ensureFamilyObjective, session: s, run };
}

beforeEach(() => vi.clearAllMocks());

// ── Detection ────────────────────────────────────────────────────────────────

describe("detectVerticalAddition", () => {
  it("costs nothing without a childcare signal", async () => {
    const parse = vi.fn(async () => '{"addVertical":"child"}');
    for (const text of ["how is mom doing?", "can we move Thursday's visit?", "what's my invoice?"]) {
      expect(await detectVerticalAddition({ text, parse })).toMatchObject({ addVertical: null, reason: "no_child_signal" });
    }
    expect(parse).not.toHaveBeenCalled();
  });

  it("R-FD3 guard: grandchildren are NOT a childcare request, even with a child signal", async () => {
    const parse = vi.fn(async () => '{"addVertical":"child"}');
    // "my daughter" trips the deterministic child pre-pass, so the cheap
    // no-signal exit does NOT apply — the grandchildren guard is what stops it.
    const r = await detectVerticalAddition({
      text: "my grandkids come over on Sundays when my daughter drops them off",
      parse,
    });
    expect(r).toMatchObject({ addVertical: null, reason: "passing_mention" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("resolves a real addition through the model", async () => {
    const r = await detectVerticalAddition({
      text: "I also need a sitter for my kids on Tuesdays",
      parse: async () => '{"addVertical":"child"}',
    });
    expect(r).toEqual({ addVertical: "child", reason: "model" });
  });

  it("fails safe to no-addition on garbage, refusal, and model failure", async () => {
    for (const raw of ["__parse_error__", "", "not json", '{"addVertical":"none"}', '{"addVertical":"admin"}']) {
      const r = await detectVerticalAddition({ text: "I also need a sitter for my kids", parse: async () => raw });
      expect(r.addVertical).toBeNull();
    }
    const thrown = await detectVerticalAddition({
      text: "I also need a sitter for my kids",
      parse: async () => { throw new Error("down"); },
    });
    expect(thrown).toMatchObject({ addVertical: null, reason: "parse_error" });
  });
});

// ── 6b: the addition itself ──────────────────────────────────────────────────

describe("R-FD6 addition on a COMPLETED session: never a re-stamp", () => {
  it("FAMILY: the secure child-profile route + ONE enrollment objective, senior state untouched", async () => {
    const h = harness();
    const r = await h.run("I also need childcare for my kids on Tuesdays");
    expect(r).toEqual({ handled: true, outcome: "addition_family_addition_detected" });
    expect(h.ensureFamilyObjective).toHaveBeenCalledWith(UID, expect.objectContaining({ channel: "linq" }));
    expect(h.sent[0]).toContain("https://app.test/childcare/children");
    expect(h.sent[0]).toMatch(/set up separately from your senior care/i);
    // THE INVARIANT: no vertical stamp, no step change, no senior disturbance.
    expect(h.session.careVertical).toBeUndefined();
    expect(h.session.verticalIntent).toBeUndefined();
    expect(h.session.onboardingStep).toBe("complete");
    expect(h.session.seniorId).toBe("senior-1");
    expect(h.fake.get(`agent_sessions/${PHONE}`)?.careVertical).toBeUndefined();
  });

  it("CAREGIVER: starts the Stage 2 funnel (delta mode), senior state untouched", async () => {
    const h = harness({ userType: "caregiver", caregiverId: UID });
    const r = await h.run("I'd also like to take childcare work");
    expect(r.handled).toBe(true);
    expect(r.outcome).toBe("addition_caregiver_funnel_started_delta");
    expect(h.runCaregiverFunnel).toHaveBeenCalledTimes(1);
    const funnelArgs = h.runCaregiverFunnel.mock.calls[0][0];
    expect(funnelArgs.openingLine).toContain("https://app.test/caregiver/childcare");
    expect(String(funnelArgs.openingLine)).toMatch(/its own profile, its own approval, and its own rate/i);
    expect(h.session.careVertical).toBeUndefined();
    expect(h.session.onboardingStep).toBe("complete");
  });

  it("a funnel already in flight owns the turn (no re-detection)", async () => {
    const h = harness({
      userType: "caregiver",
      [CHILDCARE_CAREGIVER_FUNNEL_FIELD]: { step: "caregiver_ask_childcare_ages", data: {} },
    });
    const r = await h.run("toddlers and teens");
    expect(r.outcome).toBe("funnel_funnel_started_delta");
    expect(h.runCaregiverFunnel).toHaveBeenCalledTimes(1);
    expect(h.detect).not.toHaveBeenCalled();
  });

  // A FINISHED funnel must release the conversation. Otherwise a completed
  // senior caregiver who added childcare would get "your childcare profile is
  // with our team" as the answer to every later senior message — the addition
  // path hijacking the account's primary vertical, which is exactly what it
  // exists not to do.
  it("a TERMINAL funnel releases the turn back to the senior path", async () => {
    for (const step of ["childcare_caregiver_review", "childcare_caregiver_ineligible"]) {
      const h = harness({
        userType: "caregiver",
        [CHILDCARE_CAREGIVER_FUNNEL_FIELD]: { step, data: {} },
      }, { addVertical: null });
      const r = await h.run("when is my next senior shift?");
      expect(r.handled).toBe(false);
      expect(h.runCaregiverFunnel).not.toHaveBeenCalled();
      expect(h.sent).toEqual([]);
    }
  });

  it("a terminal funnel does NOT block a fresh addition request either", async () => {
    const h = harness({
      userType: "caregiver",
      [CHILDCARE_CAREGIVER_FUNNEL_FIELD]: { step: "childcare_caregiver_review", data: {} },
    });
    const r = await h.run("actually I want to add more age groups for my kids work");
    expect(h.detect).toHaveBeenCalledTimes(1);
    expect(r.handled).toBe(true);
  });

  it("R-FD8: flags OFF reaches the waitlist state and only NOTES the interest", async () => {
    const h = harness({}, { childcareEnabled: false });
    const r = await h.run("I also need childcare for my kids");
    expect(r).toEqual({ handled: true, outcome: "addition_unavailable" });
    expect(h.sent[0]).toMatch(/isn't open in your area/i);
    expect(h.sent[0]).toMatch(/senior-care setup is unaffected/i);
    expect(h.sent[0]).not.toContain("https://app.test");
    expect(h.session.verticalNotedInterest).toBe("child");
    // Still never a stamp.
    expect(h.session.careVertical).toBeUndefined();
    expect(h.ensureFamilyObjective).not.toHaveBeenCalled();
  });

  it("no detection → not handled, and the turn proceeds to its normal destination", async () => {
    const h = harness({}, { addVertical: null });
    const r = await h.run("how did mom's visit go with the kids around?");
    expect(r.handled).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it("one turn is never classified twice", async () => {
    const h = harness();
    await h.run("I also need childcare for my kids");
    h.detect.mockClear();
    expect((await h.run("I also need childcare for my kids")).outcome).toBe("already_checked");
    expect(h.detect).not.toHaveBeenCalled();
  });
});

// ── 6c: the noted interest, surfaced at most once ────────────────────────────

describe("verticalNotedInterest is surfaced ONCE and never nags", () => {
  it("surfaces on a low-content turn and CLEARS the note in the same write", async () => {
    const h = harness({ verticalNotedInterest: "child" }, { addVertical: null });
    const r = await h.run("hey");
    expect(r).toEqual({ handled: true, outcome: "noted_interest_surfaced" });
    expect(h.sent[0]).toBe(notedInterestOffer("child"));
    expect(h.sent[0]).toMatch(/Before I forget/);
    expect(h.session.verticalNotedInterest).toBeNull();
    expect(h.session.verticalNotedInterestSurfacedAt).toBe(NOW.toISOString());
    expect(h.session[NOTED_INTEREST_OFFER_FIELD]).toMatchObject({ vertical: "child" });
  });

  it("is structurally at-most-once: a second low-content turn surfaces nothing", async () => {
    const h = harness({ verticalNotedInterest: "child" }, { addVertical: null });
    await h.run("hey");
    // Answer it away, then try again.
    h.session[NOTED_INTEREST_OFFER_FIELD] = null;
    delete h.session._verticalAdditionChecked;
    const second = await h.run("hi again");
    expect(second.handled).toBe(false);
    expect(h.sent).toHaveLength(1);
  });

  it("never talks over a REAL question — a substantive turn is left alone", async () => {
    const h = harness({ verticalNotedInterest: "child" }, { addVertical: null });
    const r = await h.run("can you move Thursday's visit to 3pm?");
    expect(r.handled).toBe(false);
    expect(h.sent).toEqual([]);
    // The note survives for a genuinely natural moment later.
    expect(h.session.verticalNotedInterest).toBe("child");
  });

  it("YES to the offer starts the addition; NO drops it for good", async () => {
    const yes = harness({ [NOTED_INTEREST_OFFER_FIELD]: { vertical: "child", askedAt: NOW.toISOString() } });
    const ry = await yes.run("yes please");
    expect(ry.outcome).toBe("addition_family_noted_interest_accepted");
    expect(yes.sent[0]).toContain("https://app.test/childcare/children");
    expect(yes.session[NOTED_INTEREST_OFFER_FIELD]).toBeNull();

    const no = harness({ [NOTED_INTEREST_OFFER_FIELD]: { vertical: "child", askedAt: NOW.toISOString() } });
    const rn = await no.run("no thanks");
    expect(rn).toEqual({ handled: false, outcome: "noted_interest_declined" });
    expect(no.sent).toEqual([]);
    expect(no.session[NOTED_INTEREST_OFFER_FIELD]).toBeNull();
  });

  it("an unrelated reply to the offer DROPS it rather than re-asking (never nagging)", async () => {
    const h = harness({ [NOTED_INTEREST_OFFER_FIELD]: { vertical: "child", askedAt: NOW.toISOString() } });
    const r = await h.run("actually what time is Thursday?");
    expect(r).toEqual({ handled: false, outcome: "noted_interest_dropped" });
    expect(h.session[NOTED_INTEREST_OFFER_FIELD]).toBeNull();
    expect(h.sent).toEqual([]);
  });

  it("a 'both' note narrows to the other vertical's offer copy", async () => {
    const h = harness({ verticalNotedInterest: "both" }, { addVertical: null });
    await h.run("thanks");
    expect(h.sent[0]).toBe(notedInterestOffer("both"));
    expect(h.sent[0]).toMatch(/both sides/i);
  });

  it("a SENIOR note on a senior account is a no-op answer, not a duplicate signup", async () => {
    const h = harness({ [NOTED_INTEREST_OFFER_FIELD]: { vertical: "senior", askedAt: NOW.toISOString() } });
    const r = await h.run("yes");
    expect(r.outcome).toBe("noted_interest_senior_noop");
    expect(h.sent[0]).toMatch(/already set up for adult care/i);
    expect(h.ensureFamilyObjective).not.toHaveBeenCalled();
  });

  it("isLowContentTurn is tight — it never swallows a real message", () => {
    for (const yes of ["hi", "hey", "hello", "thanks", "ok", "got it", "Good morning!", "👍"]) {
      expect(isLowContentTurn(yes)).toBe(true);
    }
    for (const no of ["hi can you help", "thanks — but what about Thursday?", "ok so when is the visit", "hello?? nobody answered"]) {
      expect(isLowContentTurn(no)).toBe(false);
    }
  });
});
