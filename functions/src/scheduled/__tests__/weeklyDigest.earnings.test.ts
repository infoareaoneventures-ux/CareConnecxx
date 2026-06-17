import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Filter-aware Firestore + dependency stand-ins ────────────────────────────
// runWeeklyDigests has two loops: a client digest loop (query: agent_sessions
// where optedOut==false) and a caregiver earnings loop (query: agent_sessions
// where userType==caregiver). We isolate the earnings loop by making
// getPermissions return canSendWeeklyDigest:false so the client loop `continue`s
// for every session (the caregiver loop has no permission gate). The mock throws
// if anything reads visit_payments, pinning the regression: earnings must come
// from the shiftHours rail.
const hoisted = vi.hoisted(() => {
  const data: Record<string, Array<{ id: string; doc: any }>> = {
    agent_sessions: [],
    shiftHours: [],
    caregivers: [],
    weekly_digests: [],
  };
  const digestWrites: any[] = [];

  const matches = (rows: Array<{ id: string; doc: any }>, wheres: Array<[string, string, any]>) => {
    let out = rows;
    for (const [field, op, value] of wheres) {
      if (op === "==") out = out.filter(r => r.doc[field] === value);
      else if (op === ">=") out = out.filter(r => (r.doc[field] ?? "") >= value);
      else if (op === "<=") out = out.filter(r => (r.doc[field] ?? "") <= value);
      else if (op === ">") out = out.filter(r => (r.doc[field] ?? "") > value);
      else if (op === "in") out = out.filter(r => Array.isArray(value) && value.includes(r.doc[field]));
    }
    return out;
  };

  const makeDocRef = (name: string, id: string) => ({
    id,
    get: async () => {
      const row = (data[name] ?? []).find(r => r.id === id);
      return { exists: !!row, id, data: () => row?.doc };
    },
    set: async (d: any) => {
      if (name === "weekly_digests") digestWrites.push({ id, ...d });
      const arr = data[name] ?? (data[name] = []);
      const existing = arr.find(r => r.id === id);
      if (existing) existing.doc = { ...existing.doc, ...d };
      else arr.push({ id, doc: d });
    },
    update: async (d: any) => {
      const row = (data[name] ?? []).find(r => r.id === id);
      if (row) row.doc = { ...row.doc, ...d };
    },
  });

  const makeQuery = (name: string) => {
    const wheres: Array<[string, string, any]> = [];
    const q: any = {
      where: (field: string, op: string, value: any) => { wheres.push([field, op, value]); return q; },
      orderBy: () => q,
      limit: () => q,
      doc: (id: string) => makeDocRef(name, id),
      get: async () => {
        const rows = matches(data[name] ?? [], wheres);
        return {
          empty: rows.length === 0,
          docs: rows.map(r => ({ id: r.id, data: () => r.doc, ref: makeDocRef(name, r.id) })),
        };
      },
    };
    return q;
  };

  const firestore: any = () => ({
    collection: (name: string) => {
      if (name === "visit_payments") {
        throw new Error("weeklyDigest must not read visit_payments — earnings come from shiftHours");
      }
      return makeQuery(name);
    },
  });
  firestore.Timestamp = { fromMillis: (ms: number) => ({ _ms: ms }) };
  firestore.FieldValue = { arrayUnion: (...v: any[]) => ({ __arrayUnion: v }), delete: () => ({ __delete: true }) };

  const sendSpy = vi.fn(async (..._a: any[]) => undefined);
  const caraMsgSpy = vi.fn(async (args: any) => args?.fallback ?? "msg");

  return {
    data,
    digestWrites,
    firestore,
    sendSpy,
    caraMsgSpy,
    seed: (name: string, rows: Array<{ id: string; doc: any }>) => { data[name] = rows; },
    reset: () => {
      for (const k of Object.keys(data)) data[k] = [];
      digestWrites.length = 0;
      sendSpy.mockClear();
      caraMsgSpy.mockClear();
    },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: hoisted.firestore },
  firestore: hoisted.firestore,
}));

vi.mock("firebase-functions/v1", () => {
  const chain: any = { schedule: () => chain, timeZone: () => chain, onRun: (fn: any) => fn };
  return {
    __esModule: true,
    pubsub: chain,
    https: { onCall: (fn: any) => fn, HttpsError: class extends Error {} },
  };
});

vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: hoisted.sendSpy }));
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: hoisted.caraMsgSpy }));
// Client loop only — force-skip it so the test isolates caregiver earnings.
vi.mock("../../agents/permissionsConversation", () => ({
  getPermissions: vi.fn(async () => ({ canSendWeeklyDigest: false })),
}));
// Imported by the module but exercised only in the (skipped) client loop.
vi.mock("../../utils/claudeClient", () => ({ getSharedClient: () => ({}) }));
vi.mock("../../linq/client", () => ({}));
vi.mock("../../mcp/server", () => ({ handlePromptGet: vi.fn(async () => "") }));
vi.mock("../../memory/memoryFiles", () => ({ getMemoryContext: vi.fn(async () => "") }));
vi.mock("../../memory/learnedFacts", () => ({ getRelevantFacts: vi.fn(async () => "") }));

import {
  runWeeklyDigests,
  shiftGrossCents,
  isShiftEarnedSince,
  EARNED_SHIFT_STATUSES,
} from "../weeklyDigest";

const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

beforeEach(() => hoisted.reset());
afterEach(() => vi.clearAllMocks());

describe("shiftGrossCents", () => {
  it("resolves grossPay (dollars) to cents", () => {
    expect(shiftGrossCents({ grossPay: 120 })).toBe(12000);
  });
  it("uses amountCents when grossPay is absent (Cara / care-notes rail)", () => {
    expect(shiftGrossCents({ amountCents: 8000 })).toBe(8000);
  });
  it("falls back to hours × rate", () => {
    expect(shiftGrossCents({ submittedTotalHours: 4, payRate: 25 })).toBe(10000);
    expect(shiftGrossCents({ finalTotalHours: 3, hourlyRate: 20 })).toBe(6000);
  });
  it("returns 0 for malformed / non-positive amounts", () => {
    expect(shiftGrossCents({})).toBe(0);
    expect(shiftGrossCents({ grossPay: -5 })).toBe(0);
    expect(shiftGrossCents({ submittedTotalHours: "x", payRate: 25 })).toBe(0);
  });
});

describe("isShiftEarnedSince", () => {
  const weekAgo = iso(7 * DAY);
  it("counts client-approved shifts inside the window", () => {
    expect(isShiftEarnedSince({ status: "approved", submittedAt: iso(2 * DAY) }, weekAgo)).toBe(true);
    expect(isShiftEarnedSince({ status: "auto_approved", submittedAt: iso(1 * DAY) }, weekAgo)).toBe(true);
    expect(isShiftEarnedSince({ status: "paid", submittedAt: iso(1 * DAY) }, weekAgo)).toBe(true);
  });
  it("excludes unapproved, disputed, and failed shifts", () => {
    expect(isShiftEarnedSince({ status: "pending_client_review", submittedAt: iso(1 * DAY) }, weekAgo)).toBe(false);
    expect(isShiftEarnedSince({ status: "payment_failed", submittedAt: iso(1 * DAY) }, weekAgo)).toBe(false);
    expect(isShiftEarnedSince({ status: "disputed_admin_review", submittedAt: iso(1 * DAY) }, weekAgo)).toBe(false);
  });
  it("excludes earned shifts older than the window", () => {
    expect(isShiftEarnedSince({ status: "approved", submittedAt: iso(14 * DAY) }, weekAgo)).toBe(false);
  });
  it("falls back to createdAt and excludes shifts with no timestamp", () => {
    expect(isShiftEarnedSince({ status: "approved", createdAt: iso(1 * DAY) }, weekAgo)).toBe(true);
    expect(isShiftEarnedSince({ status: "approved" }, weekAgo)).toBe(false);
  });
  it("excludes pending_client_review from the earned set", () => {
    expect(EARNED_SHIFT_STATUSES.has("pending_client_review")).toBe(false);
    expect([...EARNED_SHIFT_STATUSES].sort()).toEqual(["approved", "auto_approved", "paid"]);
  });
});

describe("runWeeklyDigests — caregiver earnings", () => {
  beforeEach(() => {
    hoisted.seed("agent_sessions", [
      { id: "+15550000001", doc: { userId: "cg-user-1", caregiverId: "cg1", userType: "caregiver", optedOut: false, optedIn: true } },
    ]);
    hoisted.seed("caregivers", [{ id: "cg1", doc: { name: "Jamie Rivera" } }]);
    hoisted.seed("shiftHours", [
      // earned this week — grossPay rail ($120) and amountCents rail ($80)
      { id: "s1", doc: { caregiverId: "cg1", status: "approved", grossPay: 120, submittedAt: iso(2 * DAY), date: "2026-06-14" } },
      { id: "s2", doc: { caregiverId: "cg1", status: "paid", amountCents: 8000, submittedAt: iso(1 * DAY) } },
      // excluded: not yet approved
      { id: "s3", doc: { caregiverId: "cg1", status: "pending_client_review", grossPay: 50, submittedAt: iso(1 * DAY) } },
      // excluded: approved but older than the window
      { id: "s4", doc: { caregiverId: "cg1", status: "approved", grossPay: 999, submittedAt: iso(14 * DAY) } },
      // excluded: belongs to another caregiver
      { id: "s5", doc: { caregiverId: "cg2", status: "approved", grossPay: 777, submittedAt: iso(1 * DAY) } },
    ]);
  });

  it("sums only client-approved shifts from this week, across both pay rails", async () => {
    await runWeeklyDigests();

    expect(hoisted.sendSpy).toHaveBeenCalledTimes(1);
    const [phone, payload] = hoisted.sendSpy.mock.calls[0];
    expect(phone).toBe("+15550000001");
    expect(payload.sourceAgent).toBe("weekly_digest");

    // Context handed to Cara reflects $120 + $80 = $200 over 2 visits.
    const ctx = hoisted.caraMsgSpy.mock.calls[0][0].context as string;
    expect(ctx).toContain("$200.00");
    expect(ctx).toContain("2 visit");

    // Persisted digest record matches.
    expect(hoisted.digestWrites).toHaveLength(1);
    expect(hoisted.digestWrites[0]).toMatchObject({ caregiverId: "cg1", totalCents: 20000, visitCount: 2 });
  });

  it("sends nothing when the caregiver has no earned shifts this week", async () => {
    hoisted.seed("shiftHours", [
      { id: "s3", doc: { caregiverId: "cg1", status: "pending_client_review", grossPay: 50, submittedAt: iso(1 * DAY) } },
      { id: "s4", doc: { caregiverId: "cg1", status: "approved", grossPay: 999, submittedAt: iso(14 * DAY) } },
    ]);

    await runWeeklyDigests();

    expect(hoisted.sendSpy).not.toHaveBeenCalled();
    expect(hoisted.digestWrites).toHaveLength(0);
  });
});
