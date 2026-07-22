import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const state = {
    ledger: [] as Array<Record<string, unknown>>,
    drafts: [] as Array<Record<string, unknown>>,
    alerts: new Map<string, Record<string, unknown>>(),
  };
  const ts = (ms: number) => ({ toMillis: () => ms });
  const firestore: any = () => ({
    collection: (name: string) => ({
      orderBy: () => ({ limit: () => ({ get: async () => ({
        docs: (name === "agent_action_ledger" ? state.ledger : state.drafts).map((d) => ({ data: () => d })),
      }) }) }),
      doc: (id: string) => ({
        get: async () => ({ exists: state.alerts.has(id) }),
        set: async (doc: Record<string, unknown>) => { state.alerts.set(id, doc); },
      }),
    }),
  });
  firestore.Timestamp = { fromMillis: (ms: number) => ts(ms) };
  return { state, ts, firestore };
});

vi.mock("firebase-admin", () => ({
  __esModule: true, default: { firestore: hoisted.firestore }, firestore: hoisted.firestore,
}));
vi.mock("firebase-functions/v1", () => {
  const chain: any = { schedule: () => chain, timeZone: () => chain, onRun: (fn: any) => fn };
  return { __esModule: true, pubsub: chain, https: { onCall: (fn: any) => fn, HttpsError: class extends Error {} } };
});

import { runIntelligenceCanarySweep } from "./intelligenceCanaryWatch";

const now = new Date("2026-07-22T21:00:00Z");
const ledgerRow = (evidenceStatus: string, toolName = "request_booking", ageMs = 1000) => ({
  createdAt: hoisted.ts(now.getTime() - ageMs),
  status: "executed",
  toolName,
  metadata: { evidence: { status: evidenceStatus } },
});

describe("intelligenceCanaryWatch (U12 hold signals)", () => {
  it("a single postcondition mismatch fires a high-severity alert with counts only", async () => {
    hoisted.state.ledger = [ledgerRow("mismatch"), ledgerRow("verified")];
    hoisted.state.drafts = [];
    hoisted.state.alerts.clear();
    const result = await runIntelligenceCanarySweep(now);
    expect(result.signals[0]).toMatchObject({ signal: "postcondition_mismatch", severity: "high", count: 1 });
    expect(result.alertsWritten).toBe(1);
    const alert = [...hoisted.state.alerts.values()][0];
    expect(JSON.stringify(alert)).not.toMatch(/draftText|phone|\+1408/);
  });

  it("dedupes to one alert per signal per day", async () => {
    hoisted.state.ledger = [ledgerRow("mismatch")];
    hoisted.state.drafts = [];
    hoisted.state.alerts.clear();
    await runIntelligenceCanarySweep(now);
    const second = await runIntelligenceCanarySweep(now);
    expect(second.alertsWritten).toBe(0);
    expect(hoisted.state.alerts.size).toBe(1);
  });

  it("old rows and non-executed rows are ignored; low unverifiable volume stays quiet", async () => {
    hoisted.state.ledger = [
      ledgerRow("mismatch", "x", 25 * 60 * 60 * 1000),          // outside 24h
      { ...ledgerRow("mismatch"), status: "duplicate_blocked" }, // not executed
      ...Array.from({ length: 5 }, () => ledgerRow("unverifiable")), // below 10
    ];
    hoisted.state.drafts = [];
    hoisted.state.alerts.clear();
    const result = await runIntelligenceCanarySweep(now);
    expect(result.signals).toHaveLength(0);
  });

  it("weak-evidence health drafts alert at threshold", async () => {
    hoisted.state.ledger = [];
    hoisted.state.drafts = Array.from({ length: 3 }, () => ({
      createdAt: now.toISOString(), category: "health", evidenceCount: 1,
    }));
    hoisted.state.alerts.clear();
    const result = await runIntelligenceCanarySweep(now);
    expect(result.signals[0]).toMatchObject({ signal: "weak_evidence_health_drafts", count: 3 });
  });
});
