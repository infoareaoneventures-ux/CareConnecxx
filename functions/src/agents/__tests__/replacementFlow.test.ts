import { describe, it, expect, vi, beforeEach } from "vitest";

// replacementFlow.ts (2026-09-14): the website's Find Replacement modal as a
// scripted SMS flow — candidates + keep/change the visit's date/time → pick →
// recap → YES → the same booking_requests write the modal's Request button
// makes. These tests exercise the step machine directly, the same way
// bookingFlow.test.ts exercises bookingFlow.ts.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const sets: Array<{ path: string; data: any }> = [];
  const updates: Array<{ path: string; data: any }> = [];
  let autoId = 0;

  const resolveSentinels = (cur: Record<string, any>, k: string, v: any) => {
    if (v && typeof v === "object" && (v as any).__delete) { delete cur[k]; return; }
    if (v && typeof v === "object" && (v as any).__arrayUnion) {
      const existing = Array.isArray(cur[k]) ? [...cur[k]] : [];
      for (const a of (v as any).__arrayUnion) if (!existing.includes(a)) existing.push(a);
      cur[k] = existing;
      return;
    }
    cur[k] = v;
  };

  const makeDocRef = (collName: string, id: string): any => {
    const path = `${collName}/${id}`;
    return {
      id,
      path,
      get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
      set: vi.fn(async (data: any, opts?: any) => {
        const base = opts?.merge ? { ...(docState.get(path) ?? {}) } : {};
        for (const [k, v] of Object.entries(data)) resolveSentinels(base, k, v);
        docState.set(path, base);
        sets.push({ path, data });
      }),
      update: vi.fn(async (data: any) => {
        const cur = { ...(docState.get(path) ?? {}) };
        for (const [k, v] of Object.entries(data)) resolveSentinels(cur, k, v);
        docState.set(path, cur);
        updates.push({ path, data });
      }),
    };
  };

  // where("==") / where("in") chains + limit + get — enough for
  // findReplacementCandidates (booking_requests / publicCaregiverProfiles).
  const makeQuery = (collName: string, conditions: Array<[string, string, any]>): any => ({
    where: (field: string, op: string, value: any) => makeQuery(collName, [...conditions, [field, op, value]]),
    limit: () => makeQuery(collName, conditions),
    get: async () => {
      const prefix = `${collName}/`;
      const docs = [...docState.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .filter(([, data]) => conditions.every(([f, op, v]) =>
          op === "in" ? (Array.isArray(v) && v.includes((data as any)?.[f])) : (data as any)?.[f] === v))
        .map(([path, data]) => ({ id: path.slice(prefix.length), data: () => data }));
      return { empty: docs.length === 0, docs, size: docs.length };
    },
  });

  const makeCollRef = (collName: string): any => ({
    doc: (id?: string) => makeDocRef(collName, id ?? `auto-${++autoId}`),
    where: (field: string, op: string, value: any) => makeQuery(collName, [[field, op, value]]),
    limit: () => makeQuery(collName, []),
  });

  return {
    docState, sets, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); sets.length = 0; updates.length = 0; autoId = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      delete: () => ({ __delete: true }),
      arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
  });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});

const sendMessage = vi.fn(async (..._a: unknown[]) => ({ message_id: "m1" }));
vi.mock("../../linq/client", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async (opts: any) => opts.fallback ?? "msg") }));
vi.mock("../../safety/outputGuard", () => ({ guardModelOutput: () => ({ ok: true }), ANTI_INVENTION_CLAUSE: "ANTI_INVENTION" }));
vi.mock("../../config/featureFlags", () => ({ caraOutputGuardEnabled: () => true }));
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../config/appUrl", () => ({ getAppUrl: () => "https://app.test" }));
vi.mock("../../utils/knownNames", () => ({ addKnownNames: vi.fn().mockResolvedValue(undefined) }));
const messagesCreate = vi.fn();
vi.mock("../../utils/claudeClient", () => ({
  getSharedClient: () => ({ messages: { create: (...a: unknown[]) => messagesCreate(...a) } }),
}));
// stepHandler's isBackOutRequest goes through the shared utils/parseWithClaude
// (OpenAI fast path) — route it through the same queue so every model call in
// a step is accounted for in order: back-out → question → extraction. An
// empty queue reads as a parse failure, which isBackOutRequest treats as NO.
vi.mock("../../utils/parseWithClaude", () => ({
  parseWithClaude: async () => {
    const r = await messagesCreate();
    const t = r?.content?.[0]?.text;
    return typeof t === "string" ? t : "__parse_error__";
  },
}));

import { startReplacementFlow, handleReplacementFlowStep } from "../replacementFlow";

const PHONE = "+15551234567";
const CHAT  = "chat-1";
const UID   = "client-uid";

function session(overrides: Record<string, unknown> = {}): any {
  return { phone: PHONE, chatId: CHAT, userId: UID, userType: "client", ...overrides };
}
function modelReplies(...texts: string[]) {
  for (const text of texts) messagesCreate.mockResolvedValueOnce({ content: [{ text }] });
}

// A Basra-cancelled Tuesday visit with one Care Team candidate (Maria).
function seedNeedsReplacement() {
  hoisted.docState.set("shifts/sh1", {
    clientId: UID, caregiverId: "cg-basra", status: "needs_replacement",
    date: "2026-09-15", startTime: "11:00", endTime: "13:00", address: "4746 Campbell Ave", clientName: "The Family",
    careRecipients: [{ name: "Samira", careNeeds: ["Companionship"] }],
  });
  hoisted.docState.set("booking_requests/br-old", {
    clientId: UID, caregiverId: "cg-maria", caregiverName: "Maria Santos", rate: 28, status: "completed", updatedAt: { seconds: 50 },
  });
  hoisted.docState.set("caregivers/cg-maria", { name: "Maria Santos", hourlyRate: 28 });
  hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID });
}

const PICKED = {
  shiftId: "sh1",
  candidates: [{ id: "cg-maria", name: "Maria Santos", rate: 28 }],
  visitDate: "2026-09-15", visitStart: "11:00", visitEnd: "13:00",
};

beforeEach(() => {
  hoisted.reset();
  sendMessage.mockClear();
  messagesCreate.mockReset();
});

describe("startReplacementFlow", () => {
  it("texts each candidate's card, records pendingMatches as a replacement list, and asks the modal's one question", async () => {
    seedNeedsReplacement();
    const r = await startReplacementFlow(PHONE, CHAT, session(), { shiftId: "sh1" });
    expect(r.started).toBe(true);
    const texts = sendMessage.mock.calls.map((c) => String(c[1]));
    expect(texts[0]).toContain("Maria Santos — $28/hr");
    expect(texts[0]).toContain("https://app.test/p/cg-maria");
    expect(texts.at(-1)).toContain("Which one would you like to send the request to?");
    expect(texts.at(-1)).toContain("Tuesday, September 15, 2026, 11:00 AM–1:00 PM");
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.replacementFlowStep).toBe("rp_pick");
    expect(stored.pendingMatchesSource).toBe("replacement");
    expect(stored.pendingReplacementShiftId).toBe("sh1");
    expect(stored.replacementFlowData.candidates[0].id).toBe("cg-maria");
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("refuses a visit that isn't awaiting a replacement and does not start", async () => {
    seedNeedsReplacement();
    hoisted.docState.set("shifts/sh1", { ...hoisted.docState.get("shifts/sh1"), status: "scheduled" });
    const r = await startReplacementFlow(PHONE, CHAT, session(), { shiftId: "sh1" });
    expect(r.started).toBe(false);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).replacementFlowStep).toBeUndefined();
    expect(String(sendMessage.mock.calls[0][1])).toContain("isn't waiting on a replacement");
  });

  it("when nobody is available, says so plainly and offers the site's only other button — Skip — as a real YES/NO step", async () => {
    seedNeedsReplacement();
    hoisted.docState.delete("booking_requests/br-old");
    const r = await startReplacementFlow(PHONE, CHAT, session(), { shiftId: "sh1" });
    expect(r.started).toBe(true);
    expect(r.reason).toBe("no_candidates");
    const sent = String(sendMessage.mock.calls[0][1]);
    expect(sent).toContain("couldn't find anyone available to cover the Tuesday, September 15, 2026, 11:00 AM–1:00 PM visit");
    expect(sent).toContain("Reply YES to skip it");
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.replacementFlowStep).toBe("rp_skip_confirm");
    expect(stored.replacementFlowData.candidates).toEqual([]);
  });
});

// The site's Skip button next to Find Replacement (2026-09-15, live-caught:
// "no skip" outside any flow drew "Okay, skipping that" with NO write at all).
describe("rp_skip_confirm — the site's Skip button", () => {
  it("a bare SKIP at the pick step asks for confirmation — nothing cancelled yet, no model call", async () => {
    seedNeedsReplacement();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, replacementFlowStep: "rp_pick", replacementFlowData: PICKED });
    await handleReplacementFlowStep(PHONE, CHAT, "skip", session({ replacementFlowStep: "rp_pick" }));
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).replacementFlowStep).toBe("rp_skip_confirm");
    expect(hoisted.docState.get("shifts/sh1").status).toBe("needs_replacement");
    const sent = String(sendMessage.mock.calls.at(-1)![1]);
    expect(sent).toContain("Skip the Tuesday, September 15, 2026, 11:00 AM–1:00 PM visit?");
    expect(sent).toContain("Reply YES to skip it");
  });

  it("'no need for a replacement, just skip it' at the pick step is read as skip by the model and asks for confirmation", async () => {
    seedNeedsReplacement();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, replacementFlowStep: "rp_pick", replacementFlowData: PICKED });
    modelReplies("NO", "NO", JSON.stringify({ pickIndex: null, pickName: null, skip: true, keepTime: null, newDate: null, newStart: null, newEnd: null }));
    await handleReplacementFlowStep(PHONE, CHAT, "no need for a replacement, just skip it", session({ replacementFlowStep: "rp_pick" }));
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).replacementFlowStep).toBe("rp_skip_confirm");
    expect(hoisted.docState.get("shifts/sh1").status).toBe("needs_replacement");
  });

  it("YES cancels the visit in place exactly like the site's Skip (status cancelled, cancelledBy client) and clears the flow", async () => {
    seedNeedsReplacement();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, replacementFlowStep: "rp_skip_confirm", replacementFlowData: PICKED });
    await handleReplacementFlowStep(PHONE, CHAT, "yes", session({ replacementFlowStep: "rp_skip_confirm" }));
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(hoisted.docState.get("shifts/sh1")).toMatchObject({ status: "cancelled", cancelledBy: "client" });
    expect(hoisted.sets.find((s) => s.path.startsWith("booking_requests/"))).toBeUndefined();
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.replacementFlowStep).toBeUndefined();
    const sent = String(sendMessage.mock.calls.at(-1)![1]);
    expect(sent).toContain("Done — I skipped the Tuesday, September 15, 2026, 11:00 AM–1:00 PM visit");
    expect(sent).toContain("rest of your booking is unchanged");
  });

  it("NO goes back to the candidates and leaves the visit as Needs Replacement", async () => {
    seedNeedsReplacement();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, replacementFlowStep: "rp_skip_confirm", replacementFlowData: PICKED });
    await handleReplacementFlowStep(PHONE, CHAT, "no", session({ replacementFlowStep: "rp_skip_confirm" }));
    expect(hoisted.docState.get("shifts/sh1").status).toBe("needs_replacement");
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).replacementFlowStep).toBe("rp_pick");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("Which one would you like to send the request to?");
  });

  it("does not cancel if the visit was already covered or skipped on the site since", async () => {
    seedNeedsReplacement();
    hoisted.docState.set("shifts/sh1", { ...hoisted.docState.get("shifts/sh1"), status: "scheduled" });
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, replacementFlowStep: "rp_skip_confirm", replacementFlowData: PICKED });
    await handleReplacementFlowStep(PHONE, CHAT, "yes", session({ replacementFlowStep: "rp_skip_confirm" }));
    expect(hoisted.docState.get("shifts/sh1").status).toBe("scheduled");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("isn't waiting on a replacement anymore");
  });
});

describe("rp_pick", () => {
  it("a bare number picks the candidate and goes straight to the recap — no model call", async () => {
    seedNeedsReplacement();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, replacementFlowStep: "rp_pick", replacementFlowData: PICKED });
    await handleReplacementFlowStep(PHONE, CHAT, "1", session({ replacementFlowStep: "rp_pick" }));
    expect(messagesCreate).not.toHaveBeenCalled();
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.replacementFlowStep).toBe("rp_confirm");
    expect(stored.replacementFlowData.caregiverName).toBe("Maria Santos");
    const recap = String(sendMessage.mock.calls.at(-1)![1]);
    expect(recap).toContain("Send a replacement request to Maria Santos ($28/hr) for Tuesday, September 15, 2026, 11:00 AM–1:00 PM?");
    expect(recap).toContain("Reply YES to send it");
  });

  it("a name plus a new time picks the candidate and carries the changed time into the recap", async () => {
    seedNeedsReplacement();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, replacementFlowStep: "rp_pick", replacementFlowData: PICKED });
    // back-out → NO, question → NO, then the pick+time extraction
    modelReplies("NO", "NO", JSON.stringify({ pickIndex: null, pickName: "Maria", keepTime: false, newDate: null, newStart: "14:00", newEnd: "16:00" }));
    await handleReplacementFlowStep(PHONE, CHAT, "Maria but 2pm to 4pm", session({ replacementFlowStep: "rp_pick" }));
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.replacementFlowStep).toBe("rp_confirm");
    expect(stored.replacementFlowData).toMatchObject({ caregiverId: "cg-maria", newStart: "14:00", newEnd: "16:00" });
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("2:00 PM–4:00 PM");
  });

  it("'never mind' backs out and clears the flow without sending anything", async () => {
    seedNeedsReplacement();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, replacementFlowStep: "rp_pick", replacementFlowData: PICKED });
    modelReplies("YES"); // isBackOutRequest
    await handleReplacementFlowStep(PHONE, CHAT, "never mind", session({ replacementFlowStep: "rp_pick" }));
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.replacementFlowStep).toBeUndefined();
    expect(hoisted.sets.find((s) => s.path.startsWith("booking_requests/"))).toBeUndefined();
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("haven't sent anything");
  });
});

describe("rp_confirm", () => {
  const CONFIRM = { ...PICKED, caregiverId: "cg-maria", caregiverName: "Maria Santos", caregiverRate: 28 };

  it("a bare 'yes' sends the replacement request exactly like the modal's Request button — no model call", async () => {
    seedNeedsReplacement();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, replacementFlowStep: "rp_confirm", replacementFlowData: CONFIRM });
    await handleReplacementFlowStep(PHONE, CHAT, "yes", session({ replacementFlowStep: "rp_confirm" }));
    expect(messagesCreate).not.toHaveBeenCalled();
    const bookingSet = hoisted.sets.find((s) => s.path.startsWith("booking_requests/"));
    expect(bookingSet?.data).toMatchObject({
      clientId: UID, caregiverId: "cg-maria", caregiverName: "Maria Santos",
      isShiftReplacement: true, replacementForShiftId: "sh1", status: "pending",
      schedule: { days: ["Tue"], startDate: "2026-09-15", endDate: "2026-09-15", ongoing: false, dayShiftTimes: { Tue: [{ start: "11:00", end: "13:00" }] } },
    });
    expect(hoisted.docState.get("shifts/sh1")).toMatchObject({ status: "needs_replacement", replacementCaregiverName: "Maria Santos" });
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.replacementFlowStep).toBeUndefined();
    expect(stored.pendingReplacementShiftId).toBeUndefined();
    const sent = String(sendMessage.mock.calls.at(-1)![1]);
    expect(sent).toContain("Sent — I asked Maria Santos to cover Tuesday, September 15, 2026, 11:00 AM–1:00 PM");
    expect(sent).toContain("Nothing changes until they accept");
  });

  it("a changed day/time is what gets sent", async () => {
    seedNeedsReplacement();
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      chatId: CHAT, userId: UID, replacementFlowStep: "rp_confirm",
      replacementFlowData: { ...CONFIRM, newDate: "2026-09-16", newStart: "14:00", newEnd: "16:00" },
    });
    await handleReplacementFlowStep(PHONE, CHAT, "YES", session({ replacementFlowStep: "rp_confirm" }));
    const bookingSet = hoisted.sets.find((s) => s.path.startsWith("booking_requests/"));
    expect(bookingSet?.data.schedule).toMatchObject({ days: ["Wed"], startDate: "2026-09-16", dayShiftTimes: { Wed: [{ start: "14:00", end: "16:00" }] } });
  });

  it("a bare 'no' cancels without writing anything — no model call", async () => {
    seedNeedsReplacement();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, replacementFlowStep: "rp_confirm", replacementFlowData: CONFIRM });
    await handleReplacementFlowStep(PHONE, CHAT, "no", session({ replacementFlowStep: "rp_confirm" }));
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(hoisted.sets.find((s) => s.path.startsWith("booking_requests/"))).toBeUndefined();
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).replacementFlowStep).toBeUndefined();
  });

  it("does not send if the visit stopped needing a replacement since the recap (skipped/covered on the site)", async () => {
    seedNeedsReplacement();
    hoisted.docState.set("shifts/sh1", { ...hoisted.docState.get("shifts/sh1"), status: "cancelled" });
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, replacementFlowStep: "rp_confirm", replacementFlowData: CONFIRM });
    await handleReplacementFlowStep(PHONE, CHAT, "yes", session({ replacementFlowStep: "rp_confirm" }));
    expect(hoisted.sets.find((s) => s.path.startsWith("booking_requests/"))).toBeUndefined();
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("isn't waiting on a replacement anymore");
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).replacementFlowStep).toBeUndefined();
  });

  it("'actually make it 3 to 5' changes the time and re-shows the recap", async () => {
    seedNeedsReplacement();
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: CHAT, userId: UID, replacementFlowStep: "rp_confirm", replacementFlowData: CONFIRM });
    modelReplies("NO", JSON.stringify({ action: "change_time", pickIndex: null, pickName: null, newDate: null, newStart: "15:00", newEnd: "17:00" }));
    await handleReplacementFlowStep(PHONE, CHAT, "actually make it 3 to 5", session({ replacementFlowStep: "rp_confirm" }));
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.replacementFlowStep).toBe("rp_confirm");
    expect(stored.replacementFlowData).toMatchObject({ newStart: "15:00", newEnd: "17:00" });
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("3:00 PM–5:00 PM");
    expect(hoisted.sets.find((s) => s.path.startsWith("booking_requests/"))).toBeUndefined();
  });
});
