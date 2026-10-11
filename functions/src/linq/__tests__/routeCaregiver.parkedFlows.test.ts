// Parked page flows own the caregiver's reply (2026-10-11, caregiver sweep E).
//
// Live before this: the Cash Out modal said "Reply CASH OUT … or CANCEL", but
// the PAYOUTS keyword handler ran BEFORE the parked confirm and re-opened the
// modal on every CASH OUT (only YES / SEND / CONFIRM ever reached the confirm);
// and a bare CANCEL inside the profile editor / availability modal / Cash Out
// modal opened the cancel-shift flow ("What do you need to cancel?") on top of
// the parked one. Rule now: while one of those modals is parked, the reply is
// that modal's answer — resumed before any page keyword — and a bare CANCEL
// backs out of THAT modal with its own one-line "nothing changed".
//
// Mock style mirrors routeCaregiver.characterization.test.ts (in-memory
// Firestore, collaborators stubbed; assert on writes + outbound messages).

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  let autoId = 0;

  const collDocs = (collPath: string) => {
    const prefix = collPath + "/";
    const out: Array<{ id: string; data: any }> = [];
    for (const [path, data] of docState) {
      if (path.startsWith(prefix)) {
        const rest = path.slice(prefix.length);
        if (!rest.includes("/")) out.push({ id: rest, data });
      }
    }
    return out;
  };

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docState.has(path), id: path.split("/").pop(), data: () => docState.get(path) }),
    set: async (data: any, opts?: any) => {
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    },
    update: async (data: any) => {
      const next = { ...(docState.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) {
        if ((v as any)?.__delete) delete next[k]; else next[k] = v;
      }
      docState.set(path, next);
    },
    delete: async () => { docState.delete(path); },
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (collPath: string): any => {
    const filters: Array<{ field: string; op: string; val: any }> = [];
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${collPath}/${id ?? `auto-${autoId++}`}`);
    ref.where = (field: string, op: string, val: any) => { filters.push({ field, op, val }); return ref; };
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.add = async (data: any) => { const id = `auto-${autoId++}`; docState.set(`${collPath}/${id}`, data); return { id }; };
    ref.get = async () => {
      let items = collDocs(collPath);
      for (const f of filters) {
        if (f.op === "==") items = items.filter((it) => it.data?.[f.field] === f.val);
      }
      return {
        empty: items.length === 0,
        docs: items.map((it) => ({ id: it.id, data: () => it.data, ref: makeDocRef(`${collPath}/${it.id}`) })),
      };
    };
    return ref;
  };

  const collection = vi.fn((name: string) => makeCollRef(name));
  const firestoreFn: any = Object.assign(() => ({ collection }), {
    FieldValue: {
      delete: () => ({ __delete: true }),
      arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
      increment: (n: number) => ({ __increment: n }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
    Timestamp: { fromMillis: (ms: number) => ({ __timestampMs: ms }) },
  });

  return { docState, firestoreFn, reset: () => { docState.clear(); autoId = 0; } };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn },
  apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn,
}));

const sendMessage = vi.fn(async (..._a: any[]) => ({ message_id: "m1" }));
vi.mock("../client", () => ({
  sendMessage: (...a: any[]) => sendMessage(...a),
  sendToPhone: vi.fn(async () => ({ message_id: "m2" })),
  startTyping: vi.fn(async () => {}),
  stopTyping: vi.fn(async () => {}),
}));

const quickComplete = vi.fn(async (..._a: any[]) => "NONE");
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => quickComplete(...a) }));
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async ({ fallback }: any) => fallback ?? "msg") }));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async () => {}) }));
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("../../observability/actionLedger", () => ({ logAgentAction: vi.fn(async () => {}) }));

const handleCaregiverCancelShift = vi.fn(async (..._a: any[]) => {});
vi.mock("../../agents/caregiverCancelShiftHandler", () => ({ handleCaregiverCancelShift: (...a: any[]) => handleCaregiverCancelShift(...a) }));
const handleCaregiverProfileUpdate = vi.fn(async (..._a: any[]) => {});
vi.mock("../../agents/caregiverProfileHandler", () => ({ handleCaregiverProfileUpdate: (...a: any[]) => handleCaregiverProfileUpdate(...a) }));
const handleAvailabilityUpdate = vi.fn(async (..._a: any[]) => {});
vi.mock("../../agents/availabilityHandler", () => ({ handleAvailabilityUpdate: (...a: any[]) => handleAvailabilityUpdate(...a) }));
const handleInstantPayoutConfirm = vi.fn(async (..._a: any[]) => {});
const startInstantPayout = vi.fn(async (..._a: any[]) => ({ started: true }));
vi.mock("../../agents/instantPayoutHandler", () => ({
  handleInstantPayoutConfirm: (...a: any[]) => handleInstantPayoutConfirm(...a),
  startInstantPayout: (...a: any[]) => startInstantPayout(...a),
}));
// The Payouts tab keywords (PAYOUTS · CASH OUT · SETUP …) — the handler that used
// to swallow CASH OUT before the parked confirm. Real behavior kept for CASH OUT so
// the ordering is what the tests prove, not the stub.
const handlePayoutsKeyword = vi.fn(async (_phone: string, _chatId: string, caregiverId: string, text: string) => {
  if (text.trim().toUpperCase() === "CASH OUT") { await startInstantPayout(caregiverId, _phone, _chatId); return "handled"; }
  return "passthrough";
});
vi.mock("../../agents/caregiverPayouts", () => ({ handlePayoutsKeyword: (...a: any[]) => (handlePayoutsKeyword as any)(...a) }));
// Pages that sit between the parked block and the Payouts keywords — stubbed to
// passthrough so a reply reaches the Payouts keyword when nothing is parked.
const passthrough = () => vi.fn(async () => "passthrough");
vi.mock("../../agents/decisionNotices", () => ({ handlePendingDecisionReply: passthrough() }));
vi.mock("../../agents/inShift", () => ({ handleInShiftKeyword: passthrough() }));
vi.mock("../../agents/visitMode", () => ({ handleVisitModeMessage: passthrough() }));
vi.mock("../../agents/caregiverFamilies", () => ({ handleFamiliesKeyword: passthrough() }));
vi.mock("../../agents/caregiverCalendar", () => ({ handleCalendarKeyword: passthrough() }));
vi.mock("../../agents/caregiverPastBookings", () => ({ handlePastBookingsKeyword: passthrough() }));
vi.mock("../../agents/caregiverMyProfile", () => ({ handleMyProfileKeyword: passthrough() }));
vi.mock("../../agents/caregiverSettings", () => ({ handleSettingsKeyword: passthrough() }));
vi.mock("../../agents/caregiverMembership", () => ({ handleMembershipKeyword: passthrough() }));

import { routeCaregiverMessage } from "../routeCaregiver";

const CG_PHONE = "+15551110000";
const CAREGIVER_ID = "cg-1";

function seed(sessionPatch: Record<string, unknown> = {}) {
  hoisted.docState.set(`caregivers/${CAREGIVER_ID}`, { name: "Jane", hourlyRate: 25 });
  hoisted.docState.set(`agent_sessions/${CG_PHONE}`, {
    chatId: "cg-chat", phone: CG_PHONE, service: "SMS", userType: "caregiver", caregiverId: CAREGIVER_ID, userId: CAREGIVER_ID,
    onboardingStep: "complete",
    ...sessionPatch,
  });
}
const session = () => hoisted.docState.get(`agent_sessions/${CG_PHONE}`) as Record<string, unknown>;
const ctx = (text: string) => ({ phone: CG_PHONE, chatId: "cg-chat", text, norm: text.toUpperCase().trim().replace(/\s+/g, " "), session: session() as any });
const inTenMinutes = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  quickComplete.mockResolvedValue("NONE");
});

describe("Cash Out modal — CASH OUT confirms (E1)", () => {
  it("CASH OUT while the confirm is parked goes to the confirm handler, never back to the PAYOUTS keyword", async () => {
    seed({ pendingInstantPayoutConfirm: new Date().toISOString(), pendingInstantPayoutAmount: "5000" });
    const r = await routeCaregiverMessage(ctx("CASH OUT"));
    expect(r).toBe("handled");
    expect(handleInstantPayoutConfirm).toHaveBeenCalledTimes(1);
    expect(handleInstantPayoutConfirm.mock.calls[0]).toEqual([CAREGIVER_ID, CG_PHONE, "CASH OUT", "cg-chat"]);
    expect(handlePayoutsKeyword).not.toHaveBeenCalled();
    expect(startInstantPayout).not.toHaveBeenCalled(); // the modal is not re-sent
  });

  it("a stale confirm (older than 10 minutes) is cleared and CASH OUT opens the modal fresh through the Payouts keyword", async () => {
    seed({ pendingInstantPayoutConfirm: new Date(Date.now() - 11 * 60 * 1000).toISOString(), pendingInstantPayoutAmount: "5000" });
    const r = await routeCaregiverMessage(ctx("CASH OUT"));
    expect(r).toBe("handled");
    expect(session().pendingInstantPayoutConfirm).toBeUndefined();
    expect(session().pendingInstantPayoutAmount).toBeUndefined();
    expect(handleInstantPayoutConfirm).not.toHaveBeenCalled();
    expect(startInstantPayout).toHaveBeenCalledTimes(1);
  });

  it("CANCEL inside the Cash Out modal is the modal's own Cancel (its handler), not the cancel-shift flow", async () => {
    seed({ pendingInstantPayoutConfirm: new Date().toISOString(), pendingInstantPayoutAmount: "5000" });
    await routeCaregiverMessage(ctx("CANCEL"));
    expect(handleInstantPayoutConfirm).toHaveBeenCalledTimes(1);
    expect(handleInstantPayoutConfirm.mock.calls[0][2]).toBe("CANCEL");
    expect(handleCaregiverCancelShift).not.toHaveBeenCalled();
  });
});

describe("bare CANCEL backs out of the parked modal, not into the cancel-shift flow (E2)", () => {
  it("profile editor parked: CANCEL clears the editor with its one line; no cancel-shift flow, no editor turn", async () => {
    seed({ profileUpdateStep: "collect", profileUpdateField: "rates", stateExpiresAt: inTenMinutes() });
    const r = await routeCaregiverMessage(ctx("CANCEL"));
    expect(r).toBe("handled");
    expect(session().profileUpdateStep).toBeUndefined();
    expect(session().profileUpdateField).toBeUndefined();
    expect(session().stateExpiresAt).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toBe("No problem — your profile wasn't changed.");
    expect(handleCaregiverCancelShift).not.toHaveBeenCalled();
    expect(handleCaregiverProfileUpdate).not.toHaveBeenCalled();
  });

  it("availability modal parked: CANCEL clears it with the modal's own line; no cancel-shift flow", async () => {
    seed({ availabilityStep: "start", stateExpiresAt: inTenMinutes() });
    const r = await routeCaregiverMessage(ctx("CANCEL"));
    expect(r).toBe("handled");
    expect(session().availabilityStep).toBeUndefined();
    expect(sendMessage.mock.calls[0][1]).toBe("Okay — your availability wasn't changed.");
    expect(handleCaregiverCancelShift).not.toHaveBeenCalled();
    expect(handleAvailabilityUpdate).not.toHaveBeenCalled();
  });

  it("cancel-shift dialog parked: CANCEL is that dialog's own back-out (its handler), not a second 'What do you need to cancel?'", async () => {
    seed({ cancelStep: "confirm_shift", cancelCandidates: "[]", stateExpiresAt: inTenMinutes() });
    await routeCaregiverMessage(ctx("CANCEL"));
    expect(handleCaregiverCancelShift).toHaveBeenCalledTimes(1);
    expect(handleCaregiverCancelShift.mock.calls[0][3]).toBe("CANCEL");
    expect(session().cancelStep).toBe("confirm_shift"); // the router leaves the flow's own state to its handler
  });

  it("nothing parked: bare CANCEL still opens the cancel-shift flow", async () => {
    seed();
    await routeCaregiverMessage(ctx("CANCEL"));
    expect(handleCaregiverCancelShift).toHaveBeenCalledTimes(1);
  });
});

describe("a parked modal's reply is its answer, before any page keyword", () => {
  it("SAVE while the availability modal is parked goes to the modal (resumed here, not in routeClient)", async () => {
    seed({ availabilityStep: "confirm", pendingAvailability: "{}", stateExpiresAt: inTenMinutes() });
    const r = await routeCaregiverMessage(ctx("SAVE"));
    expect(r).toBe("handled");
    expect(handleAvailabilityUpdate).toHaveBeenCalledTimes(1);
    expect(handleAvailabilityUpdate.mock.calls[0].slice(0, 3)).toEqual([CAREGIVER_ID, CG_PHONE, "SAVE"]);
  });

  it("a page keyword typed mid-editor is the editor's answer (the editor owns the turn)", async () => {
    seed({ profileUpdateStep: "collect", profileUpdateField: "bio", stateExpiresAt: inTenMinutes() });
    await routeCaregiverMessage(ctx("PAYOUTS"));
    expect(handleCaregiverProfileUpdate).toHaveBeenCalledTimes(1);
    expect(handleCaregiverProfileUpdate.mock.calls[0][2]).toBe("PAYOUTS");
    expect(handlePayoutsKeyword).not.toHaveBeenCalled();
  });

  it("an expired editor is cleared and the text routes normally", async () => {
    seed({ profileUpdateStep: "collect", profileUpdateField: "bio", stateExpiresAt: new Date(Date.now() - 1000).toISOString() });
    await routeCaregiverMessage(ctx("PAYOUTS"));
    expect(session().profileUpdateStep).toBeUndefined();
    expect(handleCaregiverProfileUpdate).not.toHaveBeenCalled();
    expect(handlePayoutsKeyword).toHaveBeenCalledTimes(1);
  });
});
