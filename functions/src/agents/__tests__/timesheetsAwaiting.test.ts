// While the family's Timesheets page has something in Needs Review, a texted
// clock-in/out correction belongs to that timesheet — the fact-change detector
// stands aside (routeIntent + qaAgent both ask this helper).
import { describe, it, expect, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const rows = new Map<string, Array<Record<string, unknown>>>(); // status → docs
  const calls: Array<{ clientId: string; status: string }> = [];
  return { rows, calls };
});
vi.mock("firebase-admin", () => ({
  firestore: () => ({
    collection: () => {
      const filters: Record<string, string> = {};
      const q: any = {
        where: (f: string, _op: string, v: string) => { filters[f] = v; return q; },
        limit: () => q,
        get: async () => {
          hoisted.calls.push({ clientId: filters.clientId, status: filters.status });
          const docs = (hoisted.rows.get(filters.status) ?? []).filter((d) => d.clientId === filters.clientId);
          return { empty: docs.length === 0, docs };
        },
      };
      return q;
    },
  }),
}));
vi.mock("../../utils/scheduledTime", () => ({ businessTodayStr: () => "2026-09-18", formatInterviewTime: () => "" }));

import { hasTimesheetAwaitingClient } from "../timesheetsPage";

describe("hasTimesheetAwaitingClient — the Needs Review tab, as a yes/no", () => {
  it("true for a submission awaiting the family, true for a caregiver counter, false otherwise", async () => {
    hoisted.rows.set("pending_client_review", [{ clientId: "c1" }]);
    hoisted.rows.set("caregiver_counter_proposed", [{ clientId: "c2" }]);
    expect(await hasTimesheetAwaitingClient("c1")).toBe(true);
    expect(await hasTimesheetAwaitingClient("c2")).toBe(true);
    expect(await hasTimesheetAwaitingClient("c3")).toBe(false);
    expect(await hasTimesheetAwaitingClient("")).toBe(false);
    // Only the two waiting-on-family statuses are ever asked for.
    expect(new Set(hoisted.calls.map((c) => c.status))).toEqual(new Set(["pending_client_review", "caregiver_counter_proposed"]));
  });
});
