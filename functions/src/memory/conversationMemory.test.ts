import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// U2 (memory-grounding hardening 2026-07-17-002): activity marking policy (R1)
// and the pure backfill decision (R3). Firestore is mocked; the write helper is
// exercised against an in-memory db.

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(
    () => {
      throw new Error("tests must pass an explicit db to markSessionActivity");
    },
    {
      FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
    },
  );
  const stub = { apps: [], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

import {
  sessionActivityFields,
  markSessionActivity,
  decideActivityBackfill,
  ACTIVITY_BACKFILL_WINDOW_MS,
  ACTIVITY_BACKFILL_FUTURE_SKEW_MS,
} from "./conversationMemory";

const DAY = 24 * 60 * 60 * 1000;

// ── In-memory db for the write helper ────────────────────────────────────────
const updates: Array<{ path: string; data: Record<string, unknown> }> = [];
let failUpdate = false;
const fakeDb = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      update: async (data: Record<string, unknown>) => {
        if (failUpdate) throw new Error("NOT_FOUND: simulated");
        updates.push({ path: `${name}/${id}`, data });
      },
    }),
  }),
} as any;

beforeEach(() => {
  updates.length = 0;
  failUpdate = false;
});

describe("sessionActivityFields", () => {
  it("patches lastMessageAt with a server timestamp (never an ISO string)", () => {
    const fields = sessionActivityFields() as Record<string, unknown>;
    expect(Object.keys(fields)).toEqual(["lastMessageAt"]);
    expect(fields.lastMessageAt).toEqual({ __serverTimestamp: true });
    expect(typeof fields.lastMessageAt).not.toBe("string");
  });
});

describe("markSessionActivity", () => {
  it("writes lastMessageAt to agent_sessions/{phone}", async () => {
    await markSessionActivity("+14085551234", fakeDb);
    expect(updates).toHaveLength(1);
    expect(updates[0].path).toBe("agent_sessions/+14085551234");
    expect(updates[0].data).toEqual({ lastMessageAt: { __serverTimestamp: true } });
  });

  it("swallows a write failure — activity marking must never block a user turn", async () => {
    failUpdate = true;
    await expect(markSessionActivity("+14085551234", fakeDb)).resolves.toBeUndefined();
  });
});

// ── Ingress seam contracts (R1 / KTD2) ───────────────────────────────────────
// The Linq webhook writes activity beside lastInboundAt in ONE update; the web
// callable marks it after its accept guards. Behavior for the web seam is
// covered in webChat.test.ts; these source contracts pin the SMS seam (the full
// webhook handler is not unit-loadable) and the wiring itself.

const here = __dirname;

describe("verified-ingress wiring", () => {
  it("Linq webhook spreads sessionActivityFields() into the lastInboundAt session update", () => {
    const src = readFileSync(join(here, "../linq/webhooks.ts"), "utf8");
    expect(src).toContain('import { sessionActivityFields } from "../memory/conversationMemory"');
    // The activity fields ride in the SAME update object as lastInboundAt so the
    // SMS seam cannot accept a turn without marking activity.
    expect(src).toMatch(
      /lastInboundAt: new Date\(\)\.toISOString\(\),\s*\n\s*\.\.\.sessionActivityFields\(\),/,
    );
  });

  it("web chat marks activity after the onboarding guard and before the agent import", () => {
    const src = readFileSync(join(here, "../linq/webChat.ts"), "utf8");
    const markAt = src.indexOf("markSessionActivity(phone, db)");
    expect(markAt).toBeGreaterThan(-1);
    // After every accept guard…
    expect(markAt).toBeGreaterThan(src.indexOf('status:    "finishSetup"'));
    // …and before the model can possibly run.
    expect(markAt).toBeLessThan(src.indexOf('import("../agents/qaAgent")'));
  });
});

// ── Backfill decision (R3) ───────────────────────────────────────────────────

const NOW = Date.parse("2026-07-18T12:00:00Z");
const base = {
  hasLastMessageAt: false,
  sessionUserType: "client" as string | null,
  canonicalUserType: null as string | null,
  latestUserMessageTimestampMs: NOW - 2 * DAY,
  nowMs: NOW,
};

describe("decideActivityBackfill", () => {
  it("recent user-message evidence is written verbatim (epoch ms of the row, not now)", () => {
    const d = decideActivityBackfill(base);
    expect(d.history).toBe("recent_history");
    expect(d.writeLastMessageAtMs).toBe(NOW - 2 * DAY);
    expect(d.role).toBe("client");
  });

  it("already-populated sessions are never rewritten (idempotency: second dry-run reports 0)", () => {
    const d = decideActivityBackfill({ ...base, hasLastMessageAt: true });
    expect(d.history).toBe("already_populated");
    expect(d.writeLastMessageAtMs).toBeNull();
  });

  it("no user history → no write", () => {
    const d = decideActivityBackfill({ ...base, latestUserMessageTimestampMs: null });
    expect(d.history).toBe("no_history");
    expect(d.writeLastMessageAtMs).toBeNull();
  });

  it("non-numeric/garbage timestamp evidence counts as no history", () => {
    for (const bad of [NaN, Infinity, -5, 0]) {
      const d = decideActivityBackfill({ ...base, latestUserMessageTimestampMs: bad });
      expect(d.history).toBe("no_history");
      expect(d.writeLastMessageAtMs).toBeNull();
    }
  });

  it("evidence older than the 7-day window is stale and NOT written (cannot mark stale sessions active)", () => {
    const d = decideActivityBackfill({
      ...base,
      latestUserMessageTimestampMs: NOW - ACTIVITY_BACKFILL_WINDOW_MS - 1,
    });
    expect(d.history).toBe("stale_history");
    expect(d.writeLastMessageAtMs).toBeNull();
  });

  it("evidence just inside the window is written", () => {
    const ts = NOW - ACTIVITY_BACKFILL_WINDOW_MS + 60_000;
    const d = decideActivityBackfill({ ...base, latestUserMessageTimestampMs: ts });
    expect(d.history).toBe("recent_history");
    expect(d.writeLastMessageAtMs).toBe(ts);
  });

  it("a future timestamp beyond clock skew is not sane evidence", () => {
    const d = decideActivityBackfill({
      ...base,
      latestUserMessageTimestampMs: NOW + ACTIVITY_BACKFILL_FUTURE_SKEW_MS + 1,
    });
    expect(d.history).toBe("stale_history");
    expect(d.writeLastMessageAtMs).toBeNull();
  });

  it("ambiguous role: no session role, no explicit canonical role → excluded from repair", () => {
    const d = decideActivityBackfill({ ...base, sessionUserType: null, canonicalUserType: null });
    expect(d.role).toBe("ambiguous");
    expect(d.repairUserType).toBeNull();
  });

  it("ambiguous role: a non-canonical role string (e.g. 'admin') never repairs", () => {
    const d = decideActivityBackfill({ ...base, sessionUserType: null, canonicalUserType: "admin" });
    expect(d.role).toBe("ambiguous");
    expect(d.repairUserType).toBeNull();
  });

  it("missing session role repairs ONLY from an explicit canonical role", () => {
    const d = decideActivityBackfill({ ...base, sessionUserType: null, canonicalUserType: "client" });
    expect(d.role).toBe("client");
    expect(d.repairUserType).toBe("client");
  });

  it("an explicit session role wins and is never re-repaired", () => {
    const d = decideActivityBackfill({
      ...base,
      sessionUserType: "caregiver",
      canonicalUserType: "client",
    });
    expect(d.role).toBe("caregiver");
    expect(d.repairUserType).toBeNull();
  });
});
