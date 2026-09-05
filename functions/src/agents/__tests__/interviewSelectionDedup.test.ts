import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-09-05 fix: handleInterviewSelection never cleared pendingMatches after
// acting on a selection, so a family replying with the same digit twice in one
// conversation (e.g. "2" again, later, after an unrelated "which caregiver do
// you want to meet?" prompt) re-ran this whole function a second time — a
// second real interview_requests doc AND a second real SMS to the caregiver
// for the exact same request. Live-caught via a duplicated "didn't respond in
// time" notification later (functions/src/triggers/triggerEngine.ts's
// checkExpiredInterviewRequests fires once per non-terminal doc). These tests
// lock in: (1) a repeat selection doesn't duplicate the request or re-text the
// caregiver, (2) pendingMatches is cleared once a selection has been acted on.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  // collection name -> array of {id, data}
  const collState = new Map<string, Array<{ id: string; data: any }>>();
  let nextId = 1;

  const resolveSentinels = (cur: Record<string, any>, k: string, v: any) => {
    if (v && typeof v === "object" && (v as any).__delete) { delete cur[k]; return; }
    cur[k] = v;
  };

  const makeDocRef = (collName: string, id: string): any => {
    const path = `${collName}/${id}`;
    return {
      id,
      get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
      set: vi.fn(async (data: any, opts?: any) => {
        const base = opts?.merge ? { ...(docState.get(path) ?? {}) } : {};
        for (const [k, v] of Object.entries(data)) resolveSentinels(base, k, v);
        docState.set(path, base);
      }),
      update: vi.fn(async (data: any) => {
        const cur = { ...(docState.get(path) ?? {}) };
        for (const [k, v] of Object.entries(data)) resolveSentinels(cur, k, v);
        docState.set(path, cur);
      }),
    };
  };

  const makeQuery = (collName: string, filters: Array<[string, string, any]>): any => {
    const self = {
      where: (f: string, op: string, v: any) => makeQuery(collName, [...filters, [f, op, v]]),
      orderBy: () => self,
      limit: () => self,
      get: async () => {
        const all = collState.get(collName) ?? [];
        const matched = all.filter((d) =>
          filters.every(([f, , v]) => d.data[f] === v)
        );
        return {
          empty: matched.length === 0,
          size: matched.length,
          docs: matched.map((d) => ({
            id: d.id,
            data: () => d.data,
            ref: {
              update: vi.fn(async (patch: any) => {
                Object.assign(d.data, patch);
              }),
            },
          })),
        };
      },
    };
    return self;
  };

  const makeCollRef = (collName: string): any => ({
    doc: (id: string) => makeDocRef(collName, id),
    where: (f: string, op: string, v: any) => makeQuery(collName, [[f, op, v]]),
    add: vi.fn(async (data: any) => {
      const id = `auto-${nextId++}`;
      const arr = collState.get(collName) ?? [];
      arr.push({ id, data: { ...data } });
      collState.set(collName, arr);
      return { id };
    }),
  });

  return {
    docState,
    collState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); nextId = 1; },
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: () => ({ __delete: true }) },
  });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});

const sendMessage = vi.fn(async (..._a: unknown[]) => ({ message_id: "m1" }));
const getOrCreateSession = vi.fn(async (..._a: unknown[]) => ({ chatId: "cg-chat" }));
vi.mock("../../linq/client", () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  getOrCreateSession: (...a: unknown[]) => getOrCreateSession(...a),
}));

vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async (opts: any) => opts.fallback ?? "msg"),
}));

vi.mock("../../ai/feedback", () => ({ writeFeedbackSignal: vi.fn() }));
vi.mock("../../notifications", () => ({ notifyAdminInterviewScheduled: vi.fn() }));
vi.mock("../interviewLinks", () => ({ createInterviewCallAssets: vi.fn() }));
vi.mock("../../triggers/triggerEngine", () => ({ scheduleTrigger: vi.fn() }));
vi.mock("../permissionsConversation", () => ({ getPermissions: vi.fn(async () => null) }));

// parseSelection calls getSharedClient().messages.create(...) and parses a
// JSON array out of the reply — stub it to just extract the digit(s) present
// in the input text, which is all these tests' inputs ever contain.
vi.mock("../../utils/claudeClient", () => ({
  getSharedClient: () => ({
    messages: {
      create: async (opts: any) => {
        const userText = opts.messages?.[0]?.content ?? "";
        const nums = (userText.match(/\d+/g) ?? []).map(Number);
        return { content: [{ text: JSON.stringify(nums) }] };
      },
    },
  }),
}));

import { handleInterviewSelection } from "../interviewAgent";
import type { AgentSession } from "../../linq/client";

const PHONE = "+15551234567";
const CHAT_ID = "chat-1";

function baseSession(): AgentSession {
  return {
    phone: PHONE,
    chatId: CHAT_ID,
    userId: "client-uid",
    userType: "client",
    pendingMatches: [
      { id: "cg-imran", name: "Imran", rate: 24 },
      { id: "cg-basra", name: "Basra Yousuf", rate: 26 },
    ],
    pendingMatchesSetAt: new Date().toISOString(),
  } as unknown as AgentSession;
}

beforeEach(() => {
  hoisted.reset();
  sendMessage.mockClear();
  getOrCreateSession.mockClear();
  hoisted.collState.set("clientIntakes", [
    { id: "intake-1", data: { phone: PHONE, seniorName: "Mom", relationship: "daughter", age: 82, createdAt: new Date().toISOString() } },
  ]);
  hoisted.docState.set("caregivers/cg-basra", { phone: "+15559998888" });
  hoisted.docState.set("caregivers/cg-imran", { phone: "+15559997777" });
  hoisted.docState.set(`agent_sessions/${PHONE}`, {
    pendingMatches: (baseSession() as any).pendingMatches,
    pendingMatchesSetAt: (baseSession() as any).pendingMatchesSetAt,
  });
});

describe("handleInterviewSelection — duplicate-selection guard", () => {
  it("a repeat identical selection does not create a second interview_requests doc or re-text the caregiver", async () => {
    const session = baseSession();

    await handleInterviewSelection(PHONE, CHAT_ID, "2", session);
    expect(hoisted.collState.get("interview_requests")?.length).toBe(1);
    expect(hoisted.collState.get("interview_requests")?.[0].data).toMatchObject({
      caregiverId: "cg-basra",
      status: "awaiting_caregiver_availability",
    });
    // One text to the caregiver, one to the family.
    expect(sendMessage).toHaveBeenCalledTimes(2);

    sendMessage.mockClear();
    // Same session object (pendingMatches still present, exactly as it would
    // be if a later unrelated turn fetched the same never-cleared session) —
    // calling again must not duplicate anything.
    await handleInterviewSelection(PHONE, CHAT_ID, "2", session);
    expect(hoisted.collState.get("interview_requests")?.length).toBe(1);
    // Only the family gets a message this time ("already reached out") — the
    // caregiver is not texted again for the same request.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("clears pendingMatches on the session doc once a selection has been acted on", async () => {
    const session = baseSession();
    await handleInterviewSelection(PHONE, CHAT_ID, "2", session);
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.pendingMatches).toBeUndefined();
    expect(stored.pendingMatchesSetAt).toBeUndefined();
  });

  it("a different caregiver selected after the first is still contacted normally", async () => {
    const session = baseSession();
    await handleInterviewSelection(PHONE, CHAT_ID, "2", session); // Basra
    sendMessage.mockClear();
    await handleInterviewSelection(PHONE, CHAT_ID, "1", session); // Imran — different caregiver
    const reqs = hoisted.collState.get("interview_requests") ?? [];
    expect(reqs.length).toBe(2);
    expect(reqs.map((r) => r.data.caregiverId).sort()).toEqual(["cg-basra", "cg-imran"]);
    expect(sendMessage).toHaveBeenCalledTimes(2); // new caregiver texted + family told
  });
});
