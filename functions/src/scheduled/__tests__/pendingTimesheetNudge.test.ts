import { describe, it, expect, vi, beforeEach } from "vitest";

// Reminds families to approve caregiver hours (caregivers aren't paid until they
// do). The pure guards are tested below; the run-level block drives the job
// against an in-memory Firestore for the bell ⇄ text rule (C11, 2026-10-11).

const store = {
  shiftHours: new Map<string, any>(),
  sessions:   new Map<string, any>(),
  caregivers: new Map<string, any>(),
  sessionUpdates: [] as Array<{ id: string; data: any }>,
};

function makeQueryCollection(map: Map<string, any>, updatesSink: Array<{ id: string; data: any }> | null) {
  const query = (filters: Array<[string, any]>): any => ({
    where: (field: string, _op: string, value: any) => query([...filters, [field, value]]),
    limit: (_n: number) => query(filters),
    get: async () => {
      const matches = [...map.entries()].filter(([, data]) => filters.every(([f, v]) => data[f] === v));
      return {
        empty: matches.length === 0,
        docs: matches.map(([id, data]) => ({
          id,
          data: () => data,
          ...(updatesSink ? { ref: { update: vi.fn(async (upd: any) => { updatesSink.push({ id, data: upd }); }) } } : {}),
        })),
      };
    },
  });
  return {
    ...query([]),
    doc: (id: string) => ({ get: async () => ({ exists: map.has(id), data: () => map.get(id) }) }),
  };
}

vi.mock("firebase-admin", () => {
  const collection = (name: string) => {
    if (name === "shiftHours")     return makeQueryCollection(store.shiftHours, null);
    if (name === "agent_sessions") return makeQueryCollection(store.sessions, store.sessionUpdates);
    if (name === "caregivers")     return makeQueryCollection(store.caregivers, null);
    return { where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }), doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }), add: () => {} };
  };
  const firestore = () => ({ collection });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("firebase-functions/v1", () => ({
  pubsub: { schedule: () => ({ onRun: (fn: any) => fn }) },
}));

vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async (opts: any) => opts.fallback),
}));

const order: string[] = [];
const sendSpy = vi.fn(async (..._a: unknown[]) => { order.push("text"); return true; });
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendSpy(...a) }));

const bells: any[] = [];
vi.mock("../../notifications/userNotification", () => ({
  writeUserNotification: vi.fn(async (n: any) => { bells.push(n); order.push("bell"); return true; }),
}));

import { sendPendingTimesheetNudges, shouldNudgePendingTimesheets, toMillis, MIN_AGE_MS, COOLDOWN_MS, WAITING_ON_FAMILY, waitingSinceMs } from "../pendingTimesheetNudge";

describe("counters wait on the family too", () => {
  it("both Needs Review statuses that wait on the family are nudged", () => {
    expect([...WAITING_ON_FAMILY]).toEqual(["pending_client_review", "caregiver_counter_proposed"]);
  });
  it("a counter ages from when the caregiver countered, not from the original submission", () => {
    expect(waitingSinceMs({ status: "pending_client_review", submittedAt: "2026-09-18T05:40:00.000Z" })).toBe(Date.parse("2026-09-18T05:40:00.000Z"));
    expect(waitingSinceMs({ status: "caregiver_counter_proposed", submittedAt: "2026-09-18T05:40:00.000Z", counterProposedAt: "2026-09-19T01:00:00.000Z" })).toBe(Date.parse("2026-09-19T01:00:00.000Z"));
    expect(waitingSinceMs({ status: "caregiver_counter_proposed", submittedAt: "2026-09-18T05:40:00.000Z", updatedAt: "2026-09-19T02:00:00.000Z" })).toBe(Date.parse("2026-09-19T02:00:00.000Z"));
  });
});

// Guards: don't fire before the family's had a day, and never nag more than
// once per COOLDOWN_MS.

const NOW = 1_000_000_000_000;

describe("shouldNudgePendingTimesheets", () => {
  it("does not fire with no pending timesheets", () => {
    expect(shouldNudgePendingTimesheets({ count: 0, oldestSubmittedMs: NOW - MIN_AGE_MS - 1, lastNudgedMs: null, nowMs: NOW })).toBe(false);
  });

  it("waits out the freshness window before the first reminder", () => {
    expect(shouldNudgePendingTimesheets({ count: 1, oldestSubmittedMs: NOW - (MIN_AGE_MS - 1), lastNudgedMs: null, nowMs: NOW })).toBe(false);
  });

  it("fires once the oldest timesheet is past the freshness window", () => {
    expect(shouldNudgePendingTimesheets({ count: 1, oldestSubmittedMs: NOW - (MIN_AGE_MS + 1), lastNudgedMs: null, nowMs: NOW })).toBe(true);
  });

  it("respects the cooldown", () => {
    expect(shouldNudgePendingTimesheets({ count: 2, oldestSubmittedMs: NOW - (MIN_AGE_MS + 1), lastNudgedMs: NOW - (COOLDOWN_MS - 1), nowMs: NOW })).toBe(false);
  });

  it("fires again after the cooldown elapses", () => {
    expect(shouldNudgePendingTimesheets({ count: 2, oldestSubmittedMs: NOW - (MIN_AGE_MS + 1), lastNudgedMs: NOW - (COOLDOWN_MS + 1), nowMs: NOW })).toBe(true);
  });
});

describe("toMillis", () => {
  it("parses ISO strings", () => {
    expect(toMillis("2026-06-23T00:00:00.000Z")).toBe(Date.parse("2026-06-23T00:00:00.000Z"));
  });
  it("passes through epoch ms numbers", () => {
    expect(toMillis(1234567890)).toBe(1234567890);
  });
  it("reads Firestore Timestamp via toMillis() and seconds", () => {
    expect(toMillis({ toMillis: () => 5000 })).toBe(5000);
    expect(toMillis({ seconds: 5 })).toBe(5000);
    expect(toMillis({ _seconds: 7 })).toBe(7000);
  });
  it("returns null for missing or unparseable values", () => {
    expect(toMillis(null)).toBeNull();
    expect(toMillis(undefined)).toBeNull();
    expect(toMillis("not a date")).toBeNull();
    expect(toMillis({})).toBeNull();
  });
});

// Bell ⇄ text in lockstep (C11, 2026-10-11): the text goes first; the family's
// website bell (Payments page words) is written only when it actually went.
describe("sendPendingTimesheetNudges — bell ⇄ text", () => {
  beforeEach(() => {
    store.shiftHours.clear();
    store.sessions.clear();
    store.caregivers.clear();
    store.sessionUpdates.length = 0;
    bells.length = 0;
    order.length = 0;
    sendSpy.mockReset();
    sendSpy.mockImplementation(async () => { order.push("text"); return true; });
    store.caregivers.set("cg-1", { name: "Basra Yousuf" });
    store.sessions.set("+15550000001", { userId: "client-1", optedOut: false, onboardingStep: "complete", phone: "+15550000001" });
    store.shiftHours.set("sh-1", {
      status: "pending_client_review", clientId: "client-1", caregiverId: "cg-1",
      submittedAt: new Date(Date.now() - MIN_AGE_MS - 60_000).toISOString(), date: "Monday, October 5", amountCents: 10000,
    });
  });

  it("text dropped → no bell", async () => {
    sendSpy.mockResolvedValueOnce(false);

    await (sendPendingTimesheetNudges as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(bells).toHaveLength(0);
    // A dropped text leaves NO cooldown stamp — the next run retries (2026-10-11).
    expect(store.sessionUpdates).toHaveLength(0);
  });

  it("text sent → the bell follows it, in the Payments page's words, keyed per family per day", async () => {
    await (sendPendingTimesheetNudges as any)();

    expect(order).toEqual(["text", "bell"]);
    expect(bells).toEqual([expect.objectContaining({
      sourcePath: "shiftHours/sh-1", eventId: expect.stringMatching(/^pending-timesheet-nudge-\d{4}-\d{2}-\d{2}$/), recipientId: "client-1",
      transitionType: "pending_timesheet_nudge", type: "shift_hours_pending_reminder", title: "Hours waiting for your approval",
      body: "Basra's hours from Monday, October 5 ($100.00 to Basra, $109.00 charged) are waiting for your approval — approving pays them.",
      data: { shiftHoursId: "sh-1" },
    })]);
  });

  it("a family who texted STOP is skipped entirely — no text, no bell (the page itself is their reminder)", async () => {
    store.sessions.set("+15550000001", { userId: "client-1", optedOut: true, onboardingStep: "complete", phone: "+15550000001" });

    await (sendPendingTimesheetNudges as any)();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(bells).toHaveLength(0);
  });
});
