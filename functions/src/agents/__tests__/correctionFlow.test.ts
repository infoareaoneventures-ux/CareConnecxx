import { describe, it, expect, vi, beforeEach } from "vitest";

// correctionFlow.ts (2026-09-18): the Timesheets "Review submitted hours" modal
// as a scripted SMS flow — pick (if several) → proposed start → proposed end →
// optional reason → recap → YES → the same reviewShiftHoursAs propose_correction
// write; a waiting counter gets the modal's two buttons only: ACCEPT / ESCALATE.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const resolveSentinels = (cur: Record<string, any>, k: string, v: any) => {
    if (v && typeof v === "object" && (v as any).__delete) { delete cur[k]; return; }
    cur[k] = v;
  };
  const makeDocRef = (collName: string, id: string): any => {
    const path = `${collName}/${id}`;
    return {
      id, path,
      get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
      set: vi.fn(async (data: any) => { docState.set(path, { ...data }); }),
      update: vi.fn(async (data: any) => {
        const cur = { ...(docState.get(path) ?? {}) };
        for (const [k, v] of Object.entries(data)) resolveSentinels(cur, k, v);
        docState.set(path, cur);
      }),
    };
  };
  const makeQuery = (collName: string, conditions: Array<[string, string, any]>): any => ({
    where: (f: string, op: string, v: any) => makeQuery(collName, [...conditions, [f, op, v]]),
    orderBy: () => makeQuery(collName, conditions),
    limit: () => makeQuery(collName, conditions),
    get: async () => {
      const prefix = `${collName}/`;
      const docs = [...docState.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .filter(([, data]) => conditions.every(([f, , v]) => (data as any)?.[f] === v))
        .map(([path, data]) => ({ id: path.slice(prefix.length), data: () => data }));
      return { empty: docs.length === 0, docs, size: docs.length };
    },
  });
  const makeCollRef = (collName: string): any => ({
    doc: (id: string) => makeDocRef(collName, id),
    where: (f: string, op: string, v: any) => makeQuery(collName, [[f, op, v]]),
  });
  return { docState, collectionMock: vi.fn((p: string) => makeCollRef(p)), reset: () => docState.clear() };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: () => ({ __delete: true }), serverTimestamp: () => ({ __serverTimestamp: true }) },
  });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});

const sendMessage = vi.fn(async (..._a: unknown[]) => ({ message_id: "m1" }));
vi.mock("../../linq/client", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async (opts: any) => opts.fallback ?? "msg") }));
vi.mock("../../safety/outputGuard", () => ({ guardModelOutput: () => ({ ok: true }), ANTI_INVENTION_CLAUSE: "ANTI_INVENTION" }));
vi.mock("../../config/featureFlags", () => ({ caraOutputGuardEnabled: () => true }));
const messagesCreate = vi.fn();
vi.mock("../../utils/claudeClient", () => ({
  getSharedClient: () => ({ messages: { create: (...a: unknown[]) => messagesCreate(...a) } }),
}));
vi.mock("../../utils/parseWithClaude", () => ({
  parseWithClaude: async () => {
    const r = await messagesCreate();
    const t = r?.content?.[0]?.text;
    return typeof t === "string" ? t : "__parse_error__";
  },
}));
const reviewShiftHoursAs = vi.fn(async (_uid: string, _data: unknown) => ({ success: true }));
vi.mock("../../billing/reviewShiftHours", () => ({ reviewShiftHoursAs: (...a: unknown[]) => reviewShiftHoursAs(...(a as [string, any])) }));

import { startCorrectionFlow, handleCorrectionFlowStep, buildCorrectionRecap, hhmmToIsoNearAnchor } from "../correctionFlow";

const PHONE = "+15551234567";
const CHAT  = "chat-1";
const UID   = "client-uid";

function session(overrides: Record<string, unknown> = {}): any {
  return { phone: PHONE, chatId: CHAT, userId: UID, userType: "client", ...hoisted.docState.get(`agent_sessions/${PHONE}`), ...overrides };
}
function modelReplies(...texts: string[]) { for (const text of texts) messagesCreate.mockResolvedValueOnce({ content: [{ text }] }); }
function lastSent(): string { return String(sendMessage.mock.calls.at(-1)![1]); }
function sess() { return hoisted.docState.get(`agent_sessions/${PHONE}`); }

// Basra's live test shift: 10:03:27 PM – 10:38:51 PM Pacific on Sep 17 at $5/hr.
const SUBMITTED = {
  clientId: UID, caregiverId: "cg-basra", caregiverName: "Basra Yousuf", appointmentId: "sh-1",
  submittedStartTime: "2026-09-18T05:03:27.000Z", submittedEndTime: "2026-09-18T05:38:51.000Z",
  payRate: 5, lineItems: [], status: "pending_client_review", submittedAt: "2026-09-18T05:40:00.000Z",
};

beforeEach(() => {
  hoisted.reset(); sendMessage.mockClear(); messagesCreate.mockReset(); reviewShiftHoursAs.mockClear();
  hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID });
});

describe("startCorrectionFlow — the Review submitted hours modal, opened", () => {
  it("nothing in Needs Review → says so, no flow", async () => {
    const r = await startCorrectionFlow(PHONE, CHAT, session(), { initialText: "can you change the clock in time" });
    expect(r).toEqual({ started: false, reason: "nothing_to_review" });
    expect(lastSent()).toContain("nothing waiting for your review");
    expect(sess().correctionFlowStep).toBeUndefined();
  });

  it("one timesheet, no time in the family's words → asks the proposed clock-in with the submitted times shown", async () => {
    hoisted.docState.set("shiftHours/sh-1", SUBMITTED);
    modelReplies(JSON.stringify({ start: null, end: null }));
    const r = await startCorrectionFlow(PHONE, CHAT, session(), { initialText: "can you change the clock in time" });
    expect(r.started).toBe(true);
    expect(sess().correctionFlowStep).toBe("cf_ask_start");
    expect(lastSent()).toBe('Basra submitted 10:03 PM–10:38 PM on Thursday, September 17, 2026. What should the clock-in be? (e.g. "10:05 PM" — or reply KEEP to leave it at 10:03 PM)');
  });

  it("the family's words already carry both times → straight to the reason question", async () => {
    hoisted.docState.set("shiftHours/sh-1", SUBMITTED);
    modelReplies(JSON.stringify({ start: "22:05", end: "22:30" }));
    await startCorrectionFlow(PHONE, CHAT, session(), { initialText: "she got here at 10:05 and left at 10:30" });
    expect(sess().correctionFlowStep).toBe("cf_ask_reason");
    expect(sess().correctionFlowData).toMatchObject({ proposedStart: "2026-09-18T05:05:00.000Z", proposedEnd: "2026-09-18T05:30:00.000Z" });
    expect(lastSent()).toContain("Got it — 10:05 PM to 10:30 PM.");
  });
});

describe("12-hour ambiguity is settled against the submitted time (live-caught: 10:05 stored as 10:05 AM)", () => {
  it("picks the reading nearest the submitted time", () => {
    const anchor = "2026-09-18T05:03:27.000Z"; // 10:03 PM Pacific
    expect(hhmmToIsoNearAnchor(10, 5, anchor)).toBe("2026-09-18T05:05:00.000Z");  // "10:05" → 10:05 PM
    expect(hhmmToIsoNearAnchor(22, 5, anchor)).toBe("2026-09-18T05:05:00.000Z");  // "22:05" → same
    expect(hhmmToIsoNearAnchor(9, 45, "2026-09-17T16:00:00.000Z")).toBe("2026-09-17T16:45:00.000Z"); // 9 AM visit, "9:45" → 9:45 AM
    expect(hhmmToIsoNearAnchor(25, 0, anchor)).toBeNull();
  });
  it("a model reply of '10:05' for a 10:03 PM visit becomes 10:05 PM in the flow", async () => {
    hoisted.docState.set("shiftHours/sh-1", SUBMITTED);
    await startCorrectionFlow(PHONE, CHAT, session(), {});
    modelReplies(JSON.stringify({ time: "10:05" }));
    await handleCorrectionFlowStep(PHONE, CHAT, "10:05", session());
    expect(sess().correctionFlowData.proposedStart).toBe("2026-09-18T05:05:00.000Z");
    expect(lastSent()).toContain("Clock-in 10:05 PM, got it.");
  });
});

describe("the steps, then YES → the modal's Send correction", () => {
  it("bare '10:05' means 10:05 PM for a 10:03 PM visit; end before start is refused; NO skips the reason; recap = the modal's numbers; YES sends the same write", async () => {
    hoisted.docState.set("shiftHours/sh-1", SUBMITTED);
    modelReplies(JSON.stringify({ start: null, end: null }));
    await startCorrectionFlow(PHONE, CHAT, session(), { initialText: "can you change the clock in time" });

    modelReplies(JSON.stringify({ time: "22:05" }));
    await handleCorrectionFlowStep(PHONE, CHAT, "10:05", session());
    expect(sess().correctionFlowStep).toBe("cf_ask_end");
    expect(sess().correctionFlowData.proposedStart).toBe("2026-09-18T05:05:00.000Z");
    expect(lastSent()).toContain("Clock-in 10:05 PM, got it. And the clock-out? (submitted 10:38 PM");

    // 9:30 PM is before the 10:05 PM clock-in — the modal's "End must be after start."
    modelReplies(JSON.stringify({ time: "21:30" }));
    await handleCorrectionFlowStep(PHONE, CHAT, "9:30", session());
    expect(sess().correctionFlowStep).toBe("cf_ask_end");
    expect(lastSent()).toContain("The clock-out has to be after the clock-in (10:05 PM).");

    modelReplies(JSON.stringify({ time: "22:30" }));
    await handleCorrectionFlowStep(PHONE, CHAT, "10:30", session());
    expect(sess().correctionFlowStep).toBe("cf_ask_reason");
    expect(lastSent()).toContain("Clock-out 10:30 PM, got it. Why the correction?");

    await handleCorrectionFlowStep(PHONE, CHAT, "no", session());
    expect(sess().correctionFlowStep).toBe("cf_confirm");
    const recap = lastSent();
    expect(recap).toContain("Submitted: 10:03 PM–10:38 PM (0:35:24) · $2.95");
    expect(recap).toContain("Proposed: 10:05 PM–10:30 PM (0:25:00) · base pay $2.08 at $5/hr · total $2.08");
    expect(recap).toContain("Reason: None");
    expect(recap).toContain("24 hours to accept or send a counter");
    expect(buildCorrectionRecap(sess().correctionFlowData)).toBe(recap);
    expect(reviewShiftHoursAs).not.toHaveBeenCalled();

    await handleCorrectionFlowStep(PHONE, CHAT, "YES", session());
    expect(reviewShiftHoursAs).toHaveBeenCalledWith(UID, {
      appointmentId: "sh-1", action: "propose_correction",
      proposedStartTime: "2026-09-18T05:05:00.000Z", proposedEndTime: "2026-09-18T05:30:00.000Z", proposalReason: undefined,
    });
    expect(sess().correctionFlowStep).toBeUndefined();
    expect(sess().correctionFlowData).toBeUndefined();
    expect(lastSent()).toContain("Sent — I proposed 10:05 PM–10:30 PM (0:25:00, $2.08; $3.08 charged incl. service fee) to Basra.");
    expect(lastSent()).toContain("24 hours to accept or send a counter");
  });

  it("KEEP leaves a time as submitted; a typed reason rides along on the write", async () => {
    hoisted.docState.set("shiftHours/sh-1", SUBMITTED);
    await startCorrectionFlow(PHONE, CHAT, session(), {});
    await handleCorrectionFlowStep(PHONE, CHAT, "keep", session());
    expect(sess().correctionFlowData.proposedStart).toBe(SUBMITTED.submittedStartTime);
    expect(lastSent()).toContain("Keeping 10:03 PM.");
    modelReplies(JSON.stringify({ time: "22:30" }));
    await handleCorrectionFlowStep(PHONE, CHAT, "10:30 pm", session());
    await handleCorrectionFlowStep(PHONE, CHAT, "She left early to pick up her kids, we agreed on 10:30", session());
    expect(sess().correctionFlowStep).toBe("cf_confirm");
    expect(lastSent()).toContain('Reason: "She left early to pick up her kids, we agreed on 10:30"');
    await handleCorrectionFlowStep(PHONE, CHAT, "yes", session());
    expect(reviewShiftHoursAs).toHaveBeenCalledWith(UID, expect.objectContaining({ action: "propose_correction", proposalReason: "She left early to pick up her kids, we agreed on 10:30" }));
  });

  it("NO at the recap sends nothing and clears the flow", async () => {
    hoisted.docState.set("shiftHours/sh-1", SUBMITTED);
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId: CHAT, userId: UID, correctionFlowStep: "cf_confirm",
      correctionFlowData: { rows: [], rowId: "sh-1", proposedStart: "2026-09-18T05:05:00.000Z", proposedEnd: "2026-09-18T05:30:00.000Z" },
    });
    await handleCorrectionFlowStep(PHONE, CHAT, "no", session());
    expect(reviewShiftHoursAs).not.toHaveBeenCalled();
    expect(sess().correctionFlowStep).toBeUndefined();
    expect(lastSent()).toContain("I haven't sent anything");
  });
});

describe("counter waiting — the modal's two buttons only", () => {
  const COUNTERED = {
    ...SUBMITTED, status: "caregiver_counter_proposed",
    proposedStartTime: "2026-09-18T05:05:00.000Z", proposedEndTime: "2026-09-18T05:30:00.000Z",
    counterStartTime: "2026-09-18T05:03:27.000Z", counterEndTime: "2026-09-18T05:35:00.000Z", counterNote: "I stayed until 10:35, the door needed locking",
  };

  it("opens in counter mode with ACCEPT / ESCALATE, and ACCEPT runs the modal's accept_counter", async () => {
    hoisted.docState.set("shiftHours/sh-1", COUNTERED);
    await startCorrectionFlow(PHONE, CHAT, session(), { initialText: "what about basra's counter" });
    expect(sess().correctionFlowStep).toBe("cf_respond_counter");
    const q = lastSent();
    expect(q).toContain("Basra sent a counter on the Thursday, September 17, 2026 timesheet: 10:03 PM–10:35 PM (0:31:33)");
    expect(q).toContain('Their note: "I stayed until 10:35, the door needed locking"');
    expect(q).toContain("You proposed 10:05 PM–10:30 PM.");
    expect(q).toContain("Reply ACCEPT to accept their counter");
    expect(q).toContain("or ESCALATE");
    await handleCorrectionFlowStep(PHONE, CHAT, "ACCEPT", session());
    expect(reviewShiftHoursAs).toHaveBeenCalledWith(UID, { appointmentId: "sh-1", action: "accept_counter" });
    expect(sess().correctionFlowStep).toBeUndefined();
    expect(lastSent()).toContain("Basra's counter is accepted: 10:03 PM–10:35 PM (0:31:33)");
  });

  it("ESCALATE runs the modal's escalate; a new time of the family's own is not an option (the site has no second proposal)", async () => {
    hoisted.docState.set("shiftHours/sh-1", COUNTERED);
    await startCorrectionFlow(PHONE, CHAT, session(), {});
    // "make it 10:32" → the classifier says other → answered, question re-asked, nothing written.
    modelReplies("NO", JSON.stringify({ action: "other" }), "I can only accept the counter or escalate it — the site offers no second proposal.");
    await handleCorrectionFlowStep(PHONE, CHAT, "make it 10:32 then", session());
    expect(reviewShiftHoursAs).not.toHaveBeenCalled();
    expect(sess().correctionFlowStep).toBe("cf_respond_counter");
    await handleCorrectionFlowStep(PHONE, CHAT, "escalate", session());
    expect(reviewShiftHoursAs).toHaveBeenCalledWith(UID, { appointmentId: "sh-1", action: "escalate" });
    expect(lastSent()).toContain("Escalated — our team will look at this one");
  });
});
