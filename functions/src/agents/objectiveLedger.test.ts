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

describe("transitionObjective childcare revocation boundary", () => {
  const childObjective = base({
    careVertical: "child",
    recipientRef: { vertical: "child", childId: "c1", householdId: "h1" },
    authorityBinding: { childId: "c1", scope: "view", accessVersion: 4 },
  });

  const makeDb = (authority: Record<string, unknown>) => {
    const state = { objective: { ...childObjective } as AgentObjective };
    const refs = {
      objective: { kind: "objective" },
      authority: { kind: "authority" },
    };
    return {
      state,
      db: {
        collection: (name: string) => ({
          doc: () => name === "agent_objectives" ? refs.objective : refs.authority,
        }),
        runTransaction: async (fn: (tx: any) => Promise<unknown>) =>
          fn({
            get: async (ref: { kind: string }) =>
              ref.kind === "objective"
                ? { exists: true, data: () => state.objective }
                : { exists: true, data: () => authority },
            set: (_ref: unknown, doc: AgentObjective) => { state.objective = doc; },
          }),
      } as any,
    };
  };

  it("allows a transition while the pinned child authority is current", async () => {
    const { db } = makeDb({
      state: "active",
      scopes: ["view"],
      accessVersion: 4,
      expiresAt: null,
    });
    await expect(
      transitionObjective("obj-1", "waiting_user", 1, { db }),
    ).resolves.toMatchObject({ status: "waiting_user", version: 2 });
  });

  it("denies execution after revocation or any authority-version change", async () => {
    const { db, state } = makeDb({
      state: "revoked",
      scopes: ["view"],
      accessVersion: 5,
      expiresAt: null,
    });
    await expect(
      transitionObjective("obj-1", "waiting_user", 1, { db }),
    ).rejects.toThrow(/child authority changed/);
    expect(state.objective.status).toBe("active");
  });
});

// ── Childcare U4 additions (plan 2026-07-22-002): careVertical stamp +
// deterministic-ID idempotent creation (ensureObjective) ─────────────────────
describe("createObjective / ensureObjective — careVertical + deterministic IDs (U4)", () => {
  const makeCreateDb = () => {
    const docs = new Map<string, Record<string, unknown>>();
    let autoCounter = 0;
    const makeRef = (id: string) => ({
      id,
      set: async (doc: Record<string, unknown>) => { docs.set(id, doc); },
      create: async (doc: Record<string, unknown>) => {
        if (docs.has(id)) {
          const err = new Error(`Document already exists: ${id}`) as Error & { code: number };
          err.code = 6;
          throw err;
        }
        docs.set(id, doc);
      },
      get: async () => ({ exists: docs.has(id), data: () => docs.get(id) }),
    });
    return {
      docs,
      db: {
        collection: () => ({
          doc: (id?: string) => makeRef(id ?? `auto-${++autoCounter}`),
        }),
      } as any,
    };
  };

  it("createObjective stamps careVertical when provided and strips it when absent (legacy senior)", async () => {
    const { docs, db } = makeCreateDb();
    const { createObjective } = await import("./objectiveLedger");
    const child = await createObjective(
      { userId: "u1", role: "client", channel: "linq", intent: "childcare.family_enrollment", careVertical: "child" },
      { db },
    );
    expect(child.careVertical).toBe("child");
    expect(docs.get(child.objectiveId)?.careVertical).toBe("child");

    const senior = await createObjective(
      { userId: "u1", role: "client", channel: "linq", intent: "schedule.reschedule_visit" },
      { db },
    );
    expect(senior.careVertical).toBeUndefined();
    expect("careVertical" in (docs.get(senior.objectiveId) ?? {})).toBe(false);
  });

  it("ensureObjective is create-once: the duplicate converges on the winner's record (AE15)", async () => {
    const { db } = makeCreateDb();
    const { ensureObjective } = await import("./objectiveLedger");
    const input = {
      objectiveId: "childcare-family-signup_u1",
      userId: "u1",
      role: "client" as const,
      channel: "linq" as const,
      intent: "childcare.family_enrollment",
      careVertical: "child" as const,
    };
    const first = await ensureObjective(input, { db });
    const second = await ensureObjective({ ...input, description: "different retry text" }, { db });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.objective).toEqual(first.objective);
  });

  it("U10: persists the typed recipient ref (child ids + display label only) and strips it when absent", async () => {
    const { docs, db } = makeCreateDb();
    const { createObjective } = await import("./objectiveLedger");
    const withRef = await createObjective(
      {
        userId: "u1", role: "client", channel: "linq",
        intent: "childcare.booking_change", careVertical: "child",
        recipientRef: { vertical: "child", childId: "c1", householdId: "h1", displayLabel: "Mia" },
        authorityBinding: { childId: "c1", scope: "view", accessVersion: 7 },
      },
      { db },
    );
    expect(docs.get(withRef.objectiveId)?.recipientRef).toEqual({
      vertical: "child", childId: "c1", householdId: "h1", displayLabel: "Mia",
    });
    expect(docs.get(withRef.objectiveId)?.authorityBinding).toEqual({
      childId: "c1", scope: "view", accessVersion: 7,
    });

    const withoutRef = await createObjective(
      { userId: "u1", role: "client", channel: "linq", intent: "schedule.reschedule_visit" },
      { db },
    );
    expect("recipientRef" in (docs.get(withoutRef.objectiveId) ?? {})).toBe(false);
  });

  it("deterministic-ID createObjective throws on a raw duplicate (create semantics, never overwrite)", async () => {
    const { db } = makeCreateDb();
    const { createObjective } = await import("./objectiveLedger");
    const input = {
      objectiveId: "obj-fixed",
      userId: "u1",
      role: "client" as const,
      channel: "web" as const,
      intent: "childcare.family_enrollment",
    };
    await createObjective(input, { db });
    await expect(createObjective(input, { db })).rejects.toThrow(/already exists/i);
  });
});
