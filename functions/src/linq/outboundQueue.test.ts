import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── In-memory Firestore mock (queue docs + admin_alerts + transactions) ───────
const hoisted = vi.hoisted(() => {
  let autoId = 0;
  const queueDocs = new Map<string, any>();
  const alertAdds: any[] = [];
  let queueAddShouldThrow = false;

  const makeQueueDocRef = (id: string): any => ({
    id,
    update: vi.fn(async (data: any) => {
      queueDocs.set(id, { ...(queueDocs.get(id) ?? {}), ...data });
    }),
  });

  const queueCollection: any = {
    add: vi.fn(async (data: any) => {
      if (queueAddShouldThrow) throw new Error("firestore unavailable");
      const id = `q${++autoId}`;
      queueDocs.set(id, data);
      return { id };
    }),
    where: (field: string, op: string, value: any) => {
      const filters: Array<[string, string, any]> = [[field, op, value]];
      const chain: any = {
        where: (f: string, o: string, v: any) => { filters.push([f, o, v]); return chain; },
        orderBy: () => chain,
        limit: () => chain,
        get: async () => {
          const matches = [...queueDocs.entries()].filter(([, d]) =>
            filters.every(([f, o, v]) => {
              if (o === "==") return d[f] === v;
              if (o === "<=") return d[f] <= v;
              return true;
            }));
          return {
            empty: matches.length === 0,
            docs: matches.map(([id, d]) => ({
              id,
              data: () => queueDocs.get(id),
              ref: makeQueueDocRef(id),
            })),
          };
        },
      };
      return chain;
    },
  };

  const alertsCollection: any = {
    add: vi.fn(async (data: any) => { alertAdds.push(data); return { id: `a${alertAdds.length}` }; }),
  };

  const collectionMock = vi.fn((path: string) =>
    path === "admin_alerts" ? alertsCollection : queueCollection);

  const runTransaction = vi.fn(async (fn: any) =>
    fn({
      get: async (ref: any) => ({
        exists: queueDocs.has(ref.id),
        data: () => queueDocs.get(ref.id),
      }),
      update: (ref: any, data: any) => {
        queueDocs.set(ref.id, { ...(queueDocs.get(ref.id) ?? {}), ...data });
      },
    }));

  return {
    queueDocs, alertAdds, collectionMock, runTransaction,
    setQueueAddThrow: (v: boolean) => { queueAddShouldThrow = v; },
    reset: () => {
      queueDocs.clear();
      alertAdds.length = 0;
      autoId = 0;
      queueAddShouldThrow = false;
    },
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn: any = () => ({
    collection: hoisted.collectionMock,
    runTransaction: hoisted.runTransaction,
  });
  firestoreFn.Timestamp = { fromMillis: (ms: number) => ({ __ttlMillis: ms }) };
  return { __esModule: true, default: { firestore: firestoreFn }, firestore: firestoreFn };
});

vi.mock("./client", () => ({
  safeSend:    vi.fn(async () => "sent"),
  sendToPhone: vi.fn(async () => "sent"),
}));

import {
  enqueueOutbound,
  drainOutboundQueue,
  DEFAULT_QUEUE_TTL_MS,
  CIRCUIT_RETRY_DELAY_MS,
  MAX_DRAIN_ATTEMPTS,
} from "./outboundQueue";
import { safeSend, sendToPhone } from "./client";

const NOW = Date.parse("2026-07-02T12:00:30.000Z"); // mid-window on purpose

function queuedDoc(overrides: Record<string, any> = {}) {
  return {
    target:           { kind: "phone", phone: "+15550001111" },
    targetKey:        "phone:+15550001111",
    payloadText:      "Your Thursday visit was cancelled.",
    payloadMessage:   null,
    superviseContext: null,
    preferredService: null,
    reason:           "circuit_open",
    source:           "test",
    status:           "queued",
    attempts:         0,
    notBefore:        new Date(NOW - 1000).toISOString(),
    expiresAt:        new Date(NOW + 60 * 60 * 1000).toISOString(),
    lastError:        null,
    createdAt:        new Date(NOW - 5000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(safeSend).mockResolvedValue("sent" as any);
  vi.mocked(sendToPhone).mockResolvedValue("sent" as any);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("enqueueOutbound", () => {
  it("parks a circuit-open message with a 2-minute recheck delay and default 15-min expiry", async () => {
    const ok = await enqueueOutbound({
      target: { kind: "phone", phone: "+15550001111" },
      text:   "hello",
      reason: "circuit_open",
      source: "sendToPhone",
    });
    expect(ok).toBe(true);
    const doc = [...hoisted.queueDocs.values()][0];
    expect(doc.status).toBe("queued");
    expect(doc.notBefore).toBe(new Date(NOW + CIRCUIT_RETRY_DELAY_MS).toISOString());
    expect(doc.expiresAt).toBe(new Date(NOW + DEFAULT_QUEUE_TTL_MS).toISOString());
    expect(doc.payloadText).toBe("hello");
    expect(doc.targetKey).toBe("phone:+15550001111");
  });

  it("schedules a rate-limited message for the start of the NEXT 60s window", async () => {
    await enqueueOutbound({
      target: { kind: "chat", chatId: "chat-1" },
      text:   "hi",
      reason: "rate_limited",
    });
    const doc = [...hoisted.queueDocs.values()][0];
    // NOW is 12:00:30 → next window opens at 12:01:00.
    expect(doc.notBefore).toBe("2026-07-02T12:01:00.000Z");
  });

  it("honors a caller-supplied must-deliver TTL", async () => {
    const sixHours = 6 * 60 * 60 * 1000;
    await enqueueOutbound({
      target: { kind: "phone", phone: "+15550001111" },
      text:   "APPROVE prompt",
      reason: "circuit_open",
      ttlMs:  sixHours,
    });
    const doc = [...hoisted.queueDocs.values()][0];
    expect(doc.expiresAt).toBe(new Date(NOW + sixHours).toISOString());
  });

  it("persists skipHistoryRecord so a redelivered send keeps skipping the history recorder (U3)", async () => {
    await enqueueOutbound({
      target: { kind: "chat", chatId: "chat-2" },
      text:   "QA reply already persisted by saveConversationTurn",
      reason: "send_failed",
      skipHistoryRecord: true,
    });
    const doc = [...hoisted.queueDocs.values()][0];
    expect(doc.skipHistoryRecord).toBe(true);
  });

  it("defaults skipHistoryRecord to false when the caller does not set it", async () => {
    await enqueueOutbound({
      target: { kind: "phone", phone: "+15550001111" },
      text:   "hello",
      reason: "circuit_open",
    });
    expect([...hoisted.queueDocs.values()][0].skipHistoryRecord).toBe(false);
  });

  it("returns false (degrades to drop) when the queue write fails — never throws", async () => {
    hoisted.setQueueAddThrow(true);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = await enqueueOutbound({
      target: { kind: "phone", phone: "+15550001111" },
      text:   "hello",
      reason: "circuit_open",
    });
    expect(ok).toBe(false);
    errSpy.mockRestore();
  });
});

describe("drainOutboundQueue", () => {
  it("delivers a due phone-target message via sendToPhone with _noQueue and settles it", async () => {
    hoisted.queueDocs.set("q1", queuedDoc());
    const r = await drainOutboundQueue();
    expect(r).toEqual({ sent: 1, requeued: 0, expired: 0, failed: 0 });
    expect(sendToPhone).toHaveBeenCalledWith(
      "+15550001111",
      "Your Thursday visit was cancelled.",
      expect.objectContaining({ _noQueue: true }),
    );
    expect(hoisted.queueDocs.get("q1").status).toBe("sent");
  });

  it("delivers a chat-target message through safeSend so it is re-supervised", async () => {
    hoisted.queueDocs.set("q1", queuedDoc({
      target:           { kind: "chat", chatId: "chat-9" },
      targetKey:        "chat:chat-9",
      superviseContext: { phone: "+15550002222", role: "client" },
    }));
    const r = await drainOutboundQueue();
    expect(r.sent).toBe(1);
    expect(safeSend).toHaveBeenCalledWith(
      "chat-9",
      "Your Thursday visit was cancelled.",
      { phone: "+15550002222", role: "client" },
      expect.objectContaining({ _noQueue: true }),
    );
  });

  it("replays skipHistoryRecord on redelivery so the recorder stays skipped (U3)", async () => {
    hoisted.queueDocs.set("q1", queuedDoc({ skipHistoryRecord: true }));
    const r = await drainOutboundQueue();
    expect(r.sent).toBe(1);
    expect(sendToPhone).toHaveBeenCalledWith(
      "+15550001111",
      "Your Thursday visit was cancelled.",
      expect.objectContaining({ skipHistoryRecord: true, _noQueue: true }),
    );
  });

  it("does not touch messages that are not due yet", async () => {
    hoisted.queueDocs.set("q1", queuedDoc({ notBefore: new Date(NOW + 60_000).toISOString() }));
    const r = await drainOutboundQueue();
    expect(r).toEqual({ sent: 0, requeued: 0, expired: 0, failed: 0 });
    expect(sendToPhone).not.toHaveBeenCalled();
    expect(hoisted.queueDocs.get("q1").status).toBe("queued");
  });

  it("expires stale messages instead of delivering them late", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    hoisted.queueDocs.set("q1", queuedDoc({ expiresAt: new Date(NOW - 1000).toISOString() }));
    const r = await drainOutboundQueue();
    expect(r.expired).toBe(1);
    expect(sendToPhone).not.toHaveBeenCalled();
    expect(hoisted.queueDocs.get("q1").status).toBe("expired");
    warnSpy.mockRestore();
  });

  it("requeues with backoff when the send is still blocked, and preserves per-target order", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(sendToPhone).mockResolvedValue("dropped" as any);
    hoisted.queueDocs.set("q1", queuedDoc({ createdAt: new Date(NOW - 9000).toISOString() }));
    hoisted.queueDocs.set("q2", queuedDoc({ createdAt: new Date(NOW - 3000).toISOString() }));

    const r = await drainOutboundQueue();

    // Older message attempted and requeued; newer one skipped entirely so the
    // conversation is never delivered out of order.
    expect(r).toEqual({ sent: 0, requeued: 1, expired: 0, failed: 0 });
    expect(sendToPhone).toHaveBeenCalledTimes(1);
    const q1 = hoisted.queueDocs.get("q1");
    expect(q1.status).toBe("queued");
    expect(q1.attempts).toBe(1);
    expect(Date.parse(q1.notBefore)).toBeGreaterThan(NOW);
    expect(hoisted.queueDocs.get("q2").attempts).toBe(0);
    warnSpy.mockRestore();
  });

  it("treats skipped_opt_out as settled — an opted-out recipient must never be retried", async () => {
    vi.mocked(sendToPhone).mockResolvedValue("skipped_opt_out" as any);
    hoisted.queueDocs.set("q1", queuedDoc());
    const r = await drainOutboundQueue();
    expect(r.sent).toBe(1);
    expect(hoisted.queueDocs.get("q1").status).toBe("sent");
    expect(hoisted.queueDocs.get("q1").finalOutcome).toBe("skipped_opt_out");
  });

  it("marks the doc failed and raises an admin alert after the final attempt", async () => {
    vi.mocked(sendToPhone).mockRejectedValue(new Error("linq 500"));
    hoisted.queueDocs.set("q1", queuedDoc({ attempts: MAX_DRAIN_ATTEMPTS - 1 }));
    const r = await drainOutboundQueue();
    expect(r.failed).toBe(1);
    expect(hoisted.queueDocs.get("q1").status).toBe("failed");
    expect(hoisted.alertAdds).toHaveLength(1);
    expect(hoisted.alertAdds[0]).toMatchObject({
      type:     "linq_outbound_queue_failed",
      severity: "high",
      resolved: false,
      lastError: "linq 500",
    });
  });

  it("never delivers a chat-target message without its supervise context", async () => {
    hoisted.queueDocs.set("q1", queuedDoc({
      target:           { kind: "chat", chatId: "chat-9" },
      targetKey:        "chat:chat-9",
      superviseContext: null,
      attempts:         MAX_DRAIN_ATTEMPTS - 1,
    }));
    const r = await drainOutboundQueue();
    expect(safeSend).not.toHaveBeenCalled();
    expect(sendToPhone).not.toHaveBeenCalled();
    expect(r.failed).toBe(1);
    expect(hoisted.queueDocs.get("q1").status).toBe("failed");
  });
});
