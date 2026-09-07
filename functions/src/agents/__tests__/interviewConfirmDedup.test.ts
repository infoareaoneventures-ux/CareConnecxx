import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-09-07 fix: handleInterviewConfirm minted a brand-new video_interviews
// doc every time it ran, and only cleared session.pendingInterviewConfirm
// AFTER already sending confirmation texts and scheduling reminders. Inbound
// SMS delivery is at-least-once, so the same "yes" arriving twice in quick
// succession (live-caught: a family got the "your interview is in an hour"
// reminder — and the confirmation texts — twice, at the same timestamp) each
// independently created a full duplicate interview + reminder chain. Fix:
// atomically claim (read-and-clear) pendingInterviewConfirm in a transaction
// BEFORE any work happens — a second call for the same pending confirmation
// finds the flag already gone and is a silent no-op.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
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

  const makeCollRef = (collName: string): any => ({
    doc: (id?: string) => makeDocRef(collName, id ?? `auto-${nextId++}`),
  });

  const runTransaction = vi.fn(async (fn: (tx: any) => Promise<any>) => {
    const tx = {
      get:    async (ref: any) => ref.get(),
      update: async (ref: any, data: any) => ref.update(data),
      create: async (ref: any, data: any) => ref.set(data),
    };
    return fn(tx);
  });

  return {
    docState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    runTransaction,
    reset: () => { docState.clear(); nextId = 1; runTransaction.mockClear(); },
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(
    () => ({ collection: hoisted.collectionMock, runTransaction: hoisted.runTransaction }),
    { FieldValue: { delete: () => ({ __delete: true }) } }
  );
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
const notifyAdminInterviewScheduled = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../../notifications", () => ({ notifyAdminInterviewScheduled: (...a: unknown[]) => notifyAdminInterviewScheduled(...a) }));
const createInterviewCallAssets = vi.fn(async (..._a: unknown[]) => ({ callUrl: "https://meet.example/abc", icsUrl: "https://ics.example/abc.ics" }));
vi.mock("../interviewLinks", () => ({ createInterviewCallAssets: (...a: unknown[]) => createInterviewCallAssets(...a) }));
const scheduleTrigger = vi.fn(async (..._a: unknown[]) => "trigger-id");
vi.mock("../../triggers/triggerEngine", () => ({ scheduleTrigger: (...a: unknown[]) => scheduleTrigger(...a) }));
vi.mock("../permissionsConversation", () => ({ getPermissions: vi.fn(async () => null) }));
vi.mock("../../utils/claudeClient", () => ({ getSharedClient: () => ({ messages: { create: async () => ({ content: [{ text: "[]" }] }) } }) }));

import { handleInterviewConfirm } from "../interviewAgent";
import type { AgentSession } from "../../linq/client";

const PHONE   = "+15551234567";
const CHAT_ID = "chat-1";
const FUTURE_ISO = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();

const pending = {
  docId:         "req-1",
  caregiverName: "Basra Yousuf",
  mutualTime:    FUTURE_ISO,
  formatted:     "Monday, 9:30 AM",
};

function baseSession(): AgentSession {
  return {
    phone:   PHONE,
    chatId:  CHAT_ID,
    userId:  "client-uid",
    userType: "client",
    pendingInterviewConfirm: pending,
  } as unknown as AgentSession;
}

beforeEach(() => {
  hoisted.reset();
  sendMessage.mockClear();
  getOrCreateSession.mockClear();
  notifyAdminInterviewScheduled.mockClear();
  createInterviewCallAssets.mockClear();
  scheduleTrigger.mockClear();
  hoisted.docState.set(`agent_sessions/${PHONE}`, { pendingInterviewConfirm: pending, userId: "client-uid" });
  hoisted.docState.set("interview_requests/req-1", { caregiverId: "cg-basra", status: "awaiting_caregiver_availability" });
  hoisted.docState.set("caregivers/cg-basra", { phone: "+15559998888" });
});

describe("handleInterviewConfirm — duplicate-confirmation guard", () => {
  it("confirms once: one video_interviews doc, one pair of reminders scheduled", async () => {
    await handleInterviewConfirm(PHONE, CHAT_ID, baseSession());

    const videoInterviewDocs = [...hoisted.docState.keys()].filter((k) => k.startsWith("video_interviews/"));
    expect(videoInterviewDocs.length).toBe(1);
    // family reminder + caregiver reminder + post-interview follow-up = 3 scheduleTrigger calls
    expect(scheduleTrigger).toHaveBeenCalledTimes(3);

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.pendingInterviewConfirm).toBeUndefined();
  });

  it("a duplicate confirmation for the same pending interview (e.g. a redelivered SMS) is a silent no-op", async () => {
    const session = baseSession();
    await handleInterviewConfirm(PHONE, CHAT_ID, session);

    const videoInterviewDocsAfterFirst = [...hoisted.docState.keys()].filter((k) => k.startsWith("video_interviews/"));
    expect(videoInterviewDocsAfterFirst.length).toBe(1);

    sendMessage.mockClear();
    scheduleTrigger.mockClear();

    // Same (stale) session object passed again, exactly as a second, concurrently
    // -delivered "yes" would arrive with the pendingInterviewConfirm flag it read
    // before the first call's claim transaction cleared it in the DB.
    await handleInterviewConfirm(PHONE, CHAT_ID, session);

    const videoInterviewDocsAfterSecond = [...hoisted.docState.keys()].filter((k) => k.startsWith("video_interviews/"));
    expect(videoInterviewDocsAfterSecond.length).toBe(1); // no second doc created
    expect(sendMessage).not.toHaveBeenCalled();            // no duplicate confirmation texts
    expect(scheduleTrigger).not.toHaveBeenCalled();         // no duplicate reminders
  });
});
