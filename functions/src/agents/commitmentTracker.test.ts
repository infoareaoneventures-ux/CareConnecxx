import { describe, it, expect, beforeEach, vi } from "vitest";

// ── In-memory Firestore stand-in ────────────────────────────────────────────
// Collections used: pending_commitments (doc-keyed + sweepAfter range query),
// agent_sessions (doc get), agent_conversations/{phone}/messages (ordered
// query), admin_alerts (add).
const hoisted = vi.hoisted(() => {
  const DELETE_SENTINEL = Symbol("delete");
  let commitments = new Map<string, Record<string, unknown>>();
  let sessions    = new Map<string, Record<string, unknown>>();
  let messages    = new Map<string, Array<Record<string, unknown>>>();
  let turnWatch   = new Map<string, Record<string, unknown>>();
  const adminAlerts: Array<Record<string, unknown>> = [];

  const applyPatch = (cur: Record<string, unknown>, patch: Record<string, unknown>) => {
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (v === DELETE_SENTINEL) delete next[k];
      else if (v && typeof v === "object" && "__inc" in (v as object)) {
        next[k] = ((next[k] as number) ?? 0) + (v as { __inc: number }).__inc;
      } else next[k] = v;
    }
    return next;
  };

  const makeCommitmentRef = (id: string) => ({
    id,
    get: async () => {
      const data = commitments.get(id);
      return data
        ? { exists: true, id, data: () => data, ref: makeCommitmentRef(id) }
        : { exists: false, id, data: () => undefined };
    },
    set: async (data: Record<string, unknown>) => { commitments.set(id, { ...data }); },
    update: async (patch: Record<string, unknown>) => {
      const cur = commitments.get(id);
      if (!cur) throw new Error(`no doc ${id}`);
      commitments.set(id, applyPatch(cur, patch));
    },
  });

  const commitmentsCol = {
    doc: (id: string) => makeCommitmentRef(id),
    where: (field: string, op: string, value: unknown) => ({
      limit: (_n: number) => ({
        get: async () => {
          const entries = Array.from(commitments.entries()).filter(([, d]) => {
            const v = d[field] as string | undefined;
            if (v === undefined) return false;
            return op === "<=" ? v <= (value as string) : v === value;
          });
          return {
            empty: entries.length === 0,
            docs: entries.map(([id, data]) => ({
              id,
              ref: makeCommitmentRef(id),
              data: () => commitments.get(id),
            })),
          };
        },
      }),
    }),
  };

  const firestore = () => ({
    collection: (name: string) => {
      if (name === "pending_commitments") return commitmentsCol;
      if (name === "agent_sessions") {
        return {
          doc: (phone: string) => ({
            get: async () => {
              const data = sessions.get(phone);
              return { exists: !!data, data: () => data };
            },
          }),
        };
      }
      if (name === "agent_conversations") {
        return {
          doc: (phone: string) => ({
            collection: (_sub: string) => ({
              orderBy: () => ({
                limit: () => ({
                  get: async () => {
                    const msgs = (messages.get(phone) ?? [])
                      .slice()
                      .sort((a, b) => (b.timestamp as number) - (a.timestamp as number));
                    return { docs: msgs.map((m) => ({ data: () => m })) };
                  },
                }),
              }),
            }),
          }),
        };
      }
      if (name === "admin_alerts") {
        return { add: async (data: Record<string, unknown>) => { adminAlerts.push(data); return { id: "alert_1" }; } };
      }
      if (name === "turn_watch") {
        const makeWatchRef = (id: string) => ({
          id,
          delete: async () => { turnWatch.delete(id); },
        });
        return {
          doc: (id: string) => makeWatchRef(id),
          where: (field: string, _op: string, value: unknown) => ({
            limit: (_n: number) => ({
              get: async () => {
                const entries = Array.from(turnWatch.entries())
                  .filter(([, d]) => ((d[field] as string) ?? "") <= (value as string));
                return {
                  empty: entries.length === 0,
                  docs: entries.map(([id, data]) => ({
                    id, ref: makeWatchRef(id), data: () => data,
                  })),
                };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected collection: ${name}`);
    },
  });
  (firestore as any).FieldValue = {
    delete:    () => DELETE_SENTINEL,
    increment: (n: number) => ({ __inc: n }),
  };

  return {
    firestore,
    commitments: () => commitments,
    adminAlerts,
    seedCommitment: (id: string, data: Record<string, unknown>) => commitments.set(id, data),
    seedSession: (phone: string, data: Record<string, unknown>) => sessions.set(phone, data),
    seedMessages: (phone: string, msgs: Array<Record<string, unknown>>) => messages.set(phone, msgs),
    seedTurnWatch: (id: string, data: Record<string, unknown>) => turnWatch.set(id, data),
    turnWatch: () => turnWatch,
    reset: () => {
      commitments = new Map();
      sessions    = new Map();
      messages    = new Map();
      turnWatch   = new Map();
      adminAlerts.length = 0;
    },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: hoisted.firestore },
  firestore: hoisted.firestore,
}));

// Dynamic imports inside the tracker — intercepted by vi.mock as well.
const runMatchingForClient = vi.fn();
vi.mock("./matchingAgent", () => ({ runMatchingForClient: (...a: unknown[]) => (runMatchingForClient as Function).apply(null, a) }));

const runQaAgent = vi.fn();
const sendSplit  = vi.fn(async () => {});
vi.mock("./qaAgent", () => ({
  runQaAgent: (...a: unknown[]) => (runQaAgent as Function).apply(null, a),
  sendSplit:  (...a: unknown[]) => (sendSplit as Function).apply(null, a),
}));

const sendViaInteractionAgent = vi.fn(async () => {});
vi.mock("./caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => (sendViaInteractionAgent as Function).apply(null, a) }));

const quickComplete = vi.fn(async () => "YES");
vi.mock("../utils/openaiClient", () => ({ quickComplete: (...a: unknown[]) => (quickComplete as Function).apply(null, a) }));

import {
  recordCommitment,
  resolveCommitment,
  resolveIfMatchingQuestion,
  sweepOverdueCommitments,
  sweepDroppedTurns,
  SNAG_ANSWER_COPY,
  CHECKING_COPY,
} from "./commitmentTracker";

const PHONE  = "+14085551234";
const CHAT   = "chat_1";
const pastIso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const baseQaCommitment = (overrides: Record<string, unknown> = {}) => ({
  phone: PHONE, chatId: CHAT, kind: "qa_answer",
  promiseText: SNAG_ANSWER_COPY,
  question: "when is the next visit?",
  userId: "u1", seniorId: "s1", userType: "client",
  source: "test", status: "open", attempts: 0,
  createdAt: pastIso(20 * 60_000),
  dueAt: pastIso(60_000),
  sweepAfter: pastIso(60_000),
  ...overrides,
});

beforeEach(() => {
  hoisted.reset();
  runMatchingForClient.mockReset();
  runQaAgent.mockReset();
  sendSplit.mockClear();
  sendViaInteractionAgent.mockClear();
  quickComplete.mockReset().mockResolvedValue("YES");
});

describe("recordCommitment", () => {
  it("creates an open commitment keyed {phone}_{kind} with sweepAfter=dueAt", async () => {
    const id = await recordCommitment({
      phone: PHONE, chatId: CHAT, kind: "qa_answer",
      promiseText: CHECKING_COPY, question: "q?",
      source: "test", dueInMs: 10 * 60_000,
    });
    expect(id).toBe(`${PHONE}_qa_answer`);
    const doc = hoisted.commitments().get(id!)!;
    expect(doc.status).toBe("open");
    expect(doc.sweepAfter).toBe(doc.dueAt);
    expect(doc.question).toBe("q?");
  });

  it("dedupes into an existing open commitment (earliest promise wins)", async () => {
    hoisted.seedCommitment(`${PHONE}_qa_answer`, baseQaCommitment({ question: "original q" }));
    const id = await recordCommitment({
      phone: PHONE, chatId: CHAT, kind: "qa_answer",
      promiseText: SNAG_ANSWER_COPY, question: "newer q",
      source: "test", dueInMs: 10 * 60_000,
    });
    expect(id).toBe(`${PHONE}_qa_answer`);
    expect(hoisted.commitments().get(id!)!.question).toBe("original q");
  });

  it("replaces a previously resolved commitment with a fresh open one", async () => {
    hoisted.seedCommitment(`${PHONE}_qa_answer`, baseQaCommitment({ status: "fulfilled" }));
    await recordCommitment({
      phone: PHONE, chatId: CHAT, kind: "qa_answer",
      promiseText: SNAG_ANSWER_COPY, question: "fresh q",
      source: "test", dueInMs: 10 * 60_000,
    });
    const doc = hoisted.commitments().get(`${PHONE}_qa_answer`)!;
    expect(doc.status).toBe("open");
    expect(doc.question).toBe("fresh q");
  });
});

describe("resolveCommitment / resolveIfMatchingQuestion", () => {
  it("marks an open commitment fulfilled and removes the sweep marker", async () => {
    hoisted.seedCommitment(`${PHONE}_matching`, baseQaCommitment({ kind: "matching" }));
    await resolveCommitment(PHONE, "matching", "matches_sent");
    const doc = hoisted.commitments().get(`${PHONE}_matching`)!;
    expect(doc.status).toBe("fulfilled");
    expect(doc.resolution).toBe("matches_sent");
    expect("sweepAfter" in doc).toBe(false);
  });

  it("resolves qa_answer only when the answered text matches the committed question", async () => {
    hoisted.seedCommitment(`${PHONE}_qa_answer`, baseQaCommitment());
    await resolveIfMatchingQuestion(PHONE, "a different question");
    expect(hoisted.commitments().get(`${PHONE}_qa_answer`)!.status).toBe("open");

    await resolveIfMatchingQuestion(PHONE, "  When is the NEXT visit?  ");
    expect(hoisted.commitments().get(`${PHONE}_qa_answer`)!.status).toBe("fulfilled");
  });
});

describe("sweepOverdueCommitments — qa_answer", () => {
  it("re-runs the question, delivers the real answer, and marks fulfilled", async () => {
    hoisted.seedCommitment(`${PHONE}_qa_answer`, baseQaCommitment());
    hoisted.seedSession(PHONE, { userId: "u1" });
    runQaAgent.mockResolvedValue("Your next visit is Tuesday at 10am with Maria.");

    await sweepOverdueCommitments();

    expect(runQaAgent).toHaveBeenCalledOnce();
    const params = runQaAgent.mock.calls[0][0] as Record<string, unknown>;
    expect(params.text).toBe("when is the next visit?");
    expect(params.skipSend).toBe(true);
    expect(params.isRetry).toBe(true);
    expect(sendSplit).toHaveBeenCalledWith(CHAT, "Your next visit is Tuesday at 10am with Maria.");
    const doc = hoisted.commitments().get(`${PHONE}_qa_answer`)!;
    expect(doc.status).toBe("fulfilled");
    expect(doc.attempts).toBe(1);
  });

  it("escalates to a human when the re-run only produces the snag copy again", async () => {
    hoisted.seedCommitment(`${PHONE}_qa_answer`, baseQaCommitment());
    hoisted.seedSession(PHONE, {});
    runQaAgent.mockResolvedValue(SNAG_ANSWER_COPY);

    await sweepOverdueCommitments();

    expect(sendSplit).not.toHaveBeenCalled();
    expect(sendViaInteractionAgent).toHaveBeenCalledOnce();
    expect(hoisted.adminAlerts.some((a) => a.type === "commitment_unfulfilled" && a.severity === "high")).toBe(true);
    expect(hoisted.commitments().get(`${PHONE}_qa_answer`)!.status).toBe("escalated");
  });

  it("escalates without a second re-run when the attempt budget is spent", async () => {
    hoisted.seedCommitment(`${PHONE}_qa_answer`, baseQaCommitment({ attempts: 1 }));
    hoisted.seedSession(PHONE, {});

    await sweepOverdueCommitments();

    expect(runQaAgent).not.toHaveBeenCalled();
    expect(sendViaInteractionAgent).toHaveBeenCalledOnce();
    expect(hoisted.commitments().get(`${PHONE}_qa_answer`)!.status).toBe("escalated");
  });

  it("marks fulfilled without re-running when the conversation already covered it", async () => {
    hoisted.seedCommitment(`${PHONE}_qa_answer`, baseQaCommitment());
    hoisted.seedSession(PHONE, {});
    hoisted.seedMessages(PHONE, [
      { role: "user", content: "when is the next visit?", timestamp: Date.now() - 5 * 60_000 },
      { role: "assistant", content: "Tuesday at 10am with Maria.", timestamp: Date.now() - 4 * 60_000 },
    ]);
    quickComplete.mockResolvedValue("NO");

    await sweepOverdueCommitments();

    expect(runQaAgent).not.toHaveBeenCalled();
    const doc = hoisted.commitments().get(`${PHONE}_qa_answer`)!;
    expect(doc.status).toBe("fulfilled");
    expect(doc.resolution).toBe("resolved_in_conversation");
  });

  it("cancels the commitment when the user has opted out", async () => {
    hoisted.seedCommitment(`${PHONE}_qa_answer`, baseQaCommitment());
    hoisted.seedSession(PHONE, { optedOut: true });

    await sweepOverdueCommitments();

    expect(runQaAgent).not.toHaveBeenCalled();
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
    expect(hoisted.commitments().get(`${PHONE}_qa_answer`)!.status).toBe("cancelled");
  });
});

describe("sweepOverdueCommitments — matching", () => {
  const matchingCommitment = (overrides: Record<string, unknown> = {}) => ({
    phone: PHONE, chatId: CHAT, kind: "matching",
    promiseText: "I'll text you top matches within the hour.",
    source: "matchingAgent:catch", status: "open", attempts: 0,
    createdAt: pastIso(40 * 60_000),
    dueAt: pastIso(60_000),
    sweepAfter: pastIso(60_000),
    ...overrides,
  });

  it("marks fulfilled without re-running when matches already went out after the promise", async () => {
    hoisted.seedCommitment(`${PHONE}_matching`, matchingCommitment());
    hoisted.seedSession(PHONE, { pendingMatchesSetAt: new Date().toISOString() });

    await sweepOverdueCommitments();

    expect(runMatchingForClient).not.toHaveBeenCalled();
    expect(hoisted.commitments().get(`${PHONE}_matching`)!.status).toBe("fulfilled");
  });

  it("re-runs matching and marks fulfilled when the pass delivers", async () => {
    hoisted.seedCommitment(`${PHONE}_matching`, matchingCommitment());
    hoisted.seedSession(PHONE, {});
    runMatchingForClient.mockResolvedValue("matched");

    await sweepOverdueCommitments();

    expect(runMatchingForClient).toHaveBeenCalledOnce();
    const doc = hoisted.commitments().get(`${PHONE}_matching`)!;
    expect(doc.status).toBe("fulfilled");
    expect(doc.resolution).toBe("matches_sent");
  });

  it("leaves a failed re-run open for the next sweep, which escalates", async () => {
    hoisted.seedCommitment(`${PHONE}_matching`, matchingCommitment());
    hoisted.seedSession(PHONE, {});
    runMatchingForClient.mockResolvedValue("failed");

    await sweepOverdueCommitments();
    let doc = hoisted.commitments().get(`${PHONE}_matching`)!;
    expect(doc.status).toBe("open");
    expect(doc.attempts).toBe(1);
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();

    // Next sweep (attempt budget spent) — make it due again and run.
    hoisted.seedCommitment(`${PHONE}_matching`, { ...doc, sweepAfter: pastIso(1_000) });
    await sweepOverdueCommitments();

    doc = hoisted.commitments().get(`${PHONE}_matching`)!;
    expect(doc.status).toBe("escalated");
    expect(sendViaInteractionAgent).toHaveBeenCalledOnce();
    expect(hoisted.adminAlerts.some((a) => a.type === "commitment_unfulfilled" && a.kind === "matching")).toBe(true);
  });
});

describe("sweepOverdueCommitments — interview", () => {
  const interviewCommitment = (overrides: Record<string, unknown> = {}) => ({
    phone: PHONE, chatId: CHAT, kind: "interview",
    promiseText: "Got it, I'm lining up an interview with Basra.",
    userType: "client",
    source: "interviewPromiseNet:narrated_interview", status: "open", attempts: 0,
    createdAt: pastIso(10 * 60_000),
    dueAt: pastIso(60_000),
    sweepAfter: pastIso(60_000),
    ...overrides,
  });

  it("re-runs the agent with a nudge to ask for date/time, sends the reply, and marks fulfilled", async () => {
    hoisted.seedCommitment(`${PHONE}_interview`, interviewCommitment());
    hoisted.seedSession(PHONE, { userId: "u1" });
    runQaAgent.mockResolvedValue("What day and time works for the interview with Basra?");

    await sweepOverdueCommitments();

    expect(runQaAgent).toHaveBeenCalledOnce();
    const params = runQaAgent.mock.calls[0][0] as Record<string, unknown>;
    expect(params.skipSend).toBe(true);
    expect(params.isRetry).toBe(true);
    expect((params.sourceChannel as string)).toContain("schedule_interview was never called");
    expect(sendSplit).toHaveBeenCalledWith(CHAT, "What day and time works for the interview with Basra?");
    const doc = hoisted.commitments().get(`${PHONE}_interview`)!;
    expect(doc.status).toBe("fulfilled");
    expect(doc.resolution).toBe("asked_for_datetime");
    expect(doc.attempts).toBe(1);
  });

  it("escalates to a human when the re-run produces no reply at all", async () => {
    hoisted.seedCommitment(`${PHONE}_interview`, interviewCommitment());
    hoisted.seedSession(PHONE, {});
    runQaAgent.mockResolvedValue("");

    await sweepOverdueCommitments();

    expect(sendSplit).not.toHaveBeenCalled();
    expect(sendViaInteractionAgent).toHaveBeenCalledOnce();
    expect(hoisted.adminAlerts.some((a) => a.type === "commitment_unfulfilled" && a.kind === "interview")).toBe(true);
    expect(hoisted.commitments().get(`${PHONE}_interview`)!.status).toBe("escalated");
  });

  it("escalates without a second re-run when the attempt budget is spent", async () => {
    hoisted.seedCommitment(`${PHONE}_interview`, interviewCommitment({ attempts: 1 }));
    hoisted.seedSession(PHONE, {});

    await sweepOverdueCommitments();

    expect(runQaAgent).not.toHaveBeenCalled();
    expect(sendViaInteractionAgent).toHaveBeenCalledOnce();
    expect(hoisted.commitments().get(`${PHONE}_interview`)!.status).toBe("escalated");
  });
});

describe("sweepDroppedTurns", () => {
  it("converts an overdue unanswered inbound into a tracked commitment and consumes the marker", async () => {
    hoisted.seedTurnWatch("chat_9", {
      phone: PHONE, chatId: "chat_9",
      text: "is maria coming tomorrow?",
      userId: "u1", userType: "client",
      inboundAt: pastIso(15 * 60_000),
      dueAt: pastIso(60_000),
    });
    hoisted.seedSession(PHONE, {});

    await sweepDroppedTurns();

    const doc = hoisted.commitments().get(`${PHONE}_qa_answer`)!;
    expect(doc).toBeTruthy();
    expect(doc.status).toBe("open");
    expect(doc.question).toBe("is maria coming tomorrow?");
    expect(doc.source).toBe("turnWatch:dropped_turn");
    expect(hoisted.turnWatch().size).toBe(0);
  });

  it("skips opted-out users but still consumes the marker", async () => {
    hoisted.seedTurnWatch("chat_10", {
      phone: PHONE, chatId: "chat_10", text: "hello?",
      inboundAt: pastIso(15 * 60_000), dueAt: pastIso(60_000),
    });
    hoisted.seedSession(PHONE, { optedOut: true });

    await sweepDroppedTurns();

    expect(hoisted.commitments().has(`${PHONE}_qa_answer`)).toBe(false);
    expect(hoisted.turnWatch().size).toBe(0);
  });

  it("leaves not-yet-due markers alone", async () => {
    hoisted.seedTurnWatch("chat_11", {
      phone: PHONE, chatId: "chat_11", text: "fresh question",
      inboundAt: new Date().toISOString(),
      dueAt: new Date(Date.now() + 9 * 60_000).toISOString(),
    });

    await sweepDroppedTurns();

    expect(hoisted.commitments().has(`${PHONE}_qa_answer`)).toBe(false);
    expect(hoisted.turnWatch().size).toBe(1);
  });
});
