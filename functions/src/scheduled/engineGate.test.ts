import { describe, expect, it, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const stubFs = () => ({ collection: () => ({}) });
  return { __esModule: true, default: { firestore: stubFs }, firestore: stubFs };
});

import { gateOptionalSend, decisionDocId, PROACTIVE_DECISIONS_COLLECTION } from "./engineGate";

const now = new Date("2026-07-22T20:00:00Z");

// Minimal in-memory Firestore double covering doc get/set on two collections.
function fakeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Record<string, unknown>>(Object.entries(seed));
  return {
    store,
    collection: (col: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = store.get(`${col}/${id}`);
          return { exists: data !== undefined, data: () => data };
        },
        set: async (data: Record<string, unknown>) => { store.set(`${col}/${id}`, data); },
      }),
    }),
  } as never;
}

const candidate = {
  source: "wowMomentsJob",
  category: "warmth" as const,
  urgency: 0 as const,
  evidenceCount: 1,
  dedupeKey: "wow:u1:first_visit:2026-07-22",
};

describe("gateOptionalSend (U8/KTD15/R43)", () => {
  it("allows a fresh candidate and persists an explicit disposition record", async () => {
    const db = fakeDb();
    const g = await gateOptionalSend({ phone: "+1555", candidate, db, now });
    expect(g).toEqual({ allowed: true, disposition: "send", reason: "winner" });
    const rec = (db as never as { store: Map<string, Record<string, unknown>> })
      .store.get(`${PROACTIVE_DECISIONS_COLLECTION}/${decisionDocId(candidate.dedupeKey)}`);
    expect(rec).toMatchObject({ source: "wowMomentsJob", disposition: "send" });
    // Reference-only record: enums/counts, no message text fields.
    expect(Object.keys(rec!).some((k) => /text|message|draft|content/i.test(k))).toBe(false);
  });

  it("suppresses a same-intent candidate while a prior winner is still live (cross-source dedupe)", async () => {
    const db = fakeDb({
      [`${PROACTIVE_DECISIONS_COLLECTION}/${decisionDocId(candidate.dedupeKey)}`]: {
        disposition: "send", expiresAt: "2026-07-23T20:00:00Z",
      },
    });
    const g = await gateOptionalSend({ phone: "+1555", candidate, db, now });
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("duplicate_intent_cross_source");
  });

  it("an EXPIRED prior winner does not block a new pass", async () => {
    const db = fakeDb({
      [`${PROACTIVE_DECISIONS_COLLECTION}/${decisionDocId(candidate.dedupeKey)}`]: {
        disposition: "send", expiresAt: "2026-07-21T20:00:00Z",
      },
    });
    const g = await gateOptionalSend({ phone: "+1555", candidate, db, now });
    expect(g.allowed).toBe(true);
  });

  it("defers when the recipient already had today's optional send (budget, R43)", async () => {
    const db = fakeDb({
      "agent_sessions/+1555": { proactiveSentToday: { date: "2026-07-22", count: 1 } },
    });
    const g = await gateOptionalSend({ phone: "+1555", candidate, db, now });
    expect(g.allowed).toBe(false);
    expect(g.disposition).toBe("deferred");
    expect(g.reason).toBe("daily_budget_reached");
  });

  it("a stale tally from yesterday does not count against today", async () => {
    const db = fakeDb({
      "agent_sessions/+1555": { proactiveSentToday: { date: "2026-07-21", count: 3 } },
    });
    const g = await gateOptionalSend({ phone: "+1555", candidate, db, now });
    expect(g.allowed).toBe(true);
  });

  it("suppresses categories the recipient muted (R44)", async () => {
    const db = fakeDb({
      "agent_sessions/+1555": { preferences: { mutedProactiveCategories: ["warmth"] } },
    });
    const g = await gateOptionalSend({ phone: "+1555", candidate, db, now });
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("category_muted_by_recipient");
  });

  it("health candidates without deterministic evidence are suppressed, never fail-open (R42)", async () => {
    const g = await gateOptionalSend({
      phone: "+1555",
      candidate: { ...candidate, category: "health_pattern", evidenceCount: 0, dedupeKey: "h:1" },
      db: fakeDb(), now,
    });
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("no_deterministic_evidence");
  });

  it("health winners go review_first — the gate does NOT allow a direct send", async () => {
    const g = await gateOptionalSend({
      phone: "+1555",
      candidate: { ...candidate, category: "health_pattern", evidenceCount: 3, dedupeKey: "h:2" },
      db: fakeDb(), now,
    });
    expect(g.allowed).toBe(false);
    expect(g.disposition).toBe("review_first");
  });

  it("fails OPEN on infra errors so a Firestore blip cannot dark a source", async () => {
    const broken = { collection: () => { throw new Error("firestore down"); } } as never;
    const g = await gateOptionalSend({ phone: "+1555", candidate, db: broken, now });
    expect(g).toEqual({ allowed: true, disposition: "error_fail_open", reason: "gate_error_fail_open" });
  });
});
