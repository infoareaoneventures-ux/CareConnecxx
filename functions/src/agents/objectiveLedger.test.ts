import { describe, expect, it, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const stubFs = () => ({ collection: () => ({}) });
  return { __esModule: true, default: { firestore: stubFs }, firestore: stubFs };
});

import {
  applyTransition,
  canTransition,
  selectForegroundObjective,
  isExpiryEligible,
  transitionObjective,
  TERMINAL_STATUSES,
  type AgentObjective,
  type ObjectiveStatus,
} from "./objectiveLedger";

const base = (over: Partial<AgentObjective> = {}): AgentObjective => ({
  objectiveId: "obj-1",
  userId: "user-1",
  role: "client",
  channel: "linq",
  intent: "schedule.reschedule_visit",
  status: "active",
  steps: [],
  missingInputs: [],
  version: 1,
  createdAt: "2026-07-21T10:00:00.000Z",
  updatedAt: "2026-07-21T10:00:00.000Z",
  ...over,
});

describe("transition matrix (R13/R18)", () => {
  it("terminal states have no exits", () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of ["active", "waiting_user", "completed", "cancelled"] as ObjectiveStatus[]) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it("waiting_user resumes to active but cannot jump straight to completed", () => {
    expect(canTransition("waiting_user", "active")).toBe(true);
    expect(canTransition("waiting_user", "completed")).toBe(false);
  });

  it("applyTransition bumps version, stamps updatedAt, and records terminal reason", () => {
    const next = applyTransition(base(), "cancelled", { reason: "user_cancelled", now: new Date("2026-07-21T11:00:00Z") });
    expect(next.status).toBe("cancelled");
    expect(next.version).toBe(2);
    expect(next.updatedAt).toBe("2026-07-21T11:00:00.000Z");
    expect(next.terminalReason).toBe("user_cancelled");
  });

  it("throws on an illegal transition instead of silently corrupting", () => {
    expect(() => applyTransition(base({ status: "completed" }), "active")).toThrow(/illegal transition/);
  });
});

describe("completion gate (R18/AE6)", () => {
  it("rejects completion with unfinished mandatory steps", () => {
    const obj = base({
      steps: [
        { id: "s1", label: "update visit", status: "done" },
        { id: "s2", label: "notify caregiver", status: "pending" },
      ],
    });
    expect(() => applyTransition(obj, "completed")).toThrow(/unfinished step/);
  });

  it("rejects completion with missing inputs or an unresolved expected reply", () => {
    expect(() => applyTransition(base({ missingInputs: ["newTime"] }), "completed")).toThrow(/missing inputs/);
    expect(() => applyTransition(base({ expectedReply: { kind: "yes_no", field: "confirm" } }), "completed")).toThrow(/reply is still expected/);
  });

  it("allows completion when every step is done or explicitly skipped", () => {
    const obj = base({
      steps: [
        { id: "s1", label: "update visit", status: "done", evidenceRef: "ledger/abc" },
        { id: "s2", label: "optional nicety", status: "skipped" },
      ],
    });
    const next = applyTransition(obj, "completed");
    expect(next.status).toBe("completed");
    expect(next.terminalReason).toBe("completed");
  });
});

describe("foreground selection (R13)", () => {
  it("exactly one foreground: status priority, then recency, then stable id", () => {
    const objs = [
      base({ objectiveId: "b-paused", status: "paused", updatedAt: "2026-07-21T12:00:00Z" }),
      base({ objectiveId: "a-waiting", status: "waiting_user", updatedAt: "2026-07-21T09:00:00Z" }),
      base({ objectiveId: "c-active-old", status: "active", updatedAt: "2026-07-20T09:00:00Z" }),
      base({ objectiveId: "d-active-new", status: "active", updatedAt: "2026-07-21T09:00:00Z" }),
    ];
    expect(selectForegroundObjective(objs)?.objectiveId).toBe("d-active-new");
  });

  it("stable tie-break on identical status and timestamp", () => {
    const objs = [
      base({ objectiveId: "zzz", status: "active" }),
      base({ objectiveId: "aaa", status: "active" }),
    ];
    expect(selectForegroundObjective(objs)?.objectiveId).toBe("aaa");
    expect(selectForegroundObjective([...objs].reverse())?.objectiveId).toBe("aaa");
  });

  it("returns null when only terminal objectives exist", () => {
    expect(selectForegroundObjective([base({ status: "completed" })])).toBeNull();
  });
});

describe("expiry eligibility (retention: transition, never delete)", () => {
  const now = new Date("2026-07-21T12:00:00Z");
  it("nonterminal past expiresAt is eligible; terminal and unexpired are not", () => {
    expect(isExpiryEligible(base({ expiresAt: "2026-07-21T11:00:00Z" }), now)).toBe(true);
    expect(isExpiryEligible(base({ expiresAt: "2026-07-22T11:00:00Z" }), now)).toBe(false);
    expect(isExpiryEligible(base({ status: "completed", expiresAt: "2026-07-21T11:00:00Z" }), now)).toBe(false);
    expect(isExpiryEligible(base(), now)).toBe(false); // no expiry set
  });
});

describe("transitionObjective — optimistic concurrency (R25)", () => {
  const makeDb = (stored: AgentObjective) => {
    const state = { doc: { ...stored } as AgentObjective };
    const ref = {};
    return {
      state,
      db: {
        collection: () => ({ doc: () => ref }),
        runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            get: async () => ({ exists: true, data: () => state.doc }),
            set: (_ref: unknown, doc: AgentObjective) => { state.doc = doc; },
          }),
      } as any,
    };
  };

  it("applies the transition when the caller saw the current version", async () => {
    const { db, state } = makeDb(base());
    const next = await transitionObjective("obj-1", "waiting_user", 1, { db });
    expect(next.version).toBe(2);
    expect(state.doc.status).toBe("waiting_user");
  });

  it("rejects a stale retry (version conflict) without applying anything", async () => {
    const { db, state } = makeDb(base({ version: 3 }));
    await expect(transitionObjective("obj-1", "waiting_user", 1, { db })).rejects.toThrow(/version conflict/);
    expect(state.doc.status).toBe("active");
    expect(state.doc.version).toBe(3);
  });
});
