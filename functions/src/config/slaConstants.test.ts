import { describe, it, expect, vi } from "vitest";
import {
  TIMESHEET_AUTO_APPROVE_MS,
  TIMESHEET_AUTO_APPROVE_HOURS,
  SHIFT_OFFER_TTL_MS,
  SHIFT_OFFER_TTL_HOURS,
  autoApproveAtIso,
} from "./slaConstants";

// U14: these constants centralize values previously inlined across several
// writers + quoted in user copy. The contract is that the VALUES are unchanged
// (24h SLA, 2h TTL) — this test pins them so an accidental edit is caught, and
// proves the copy-facing `*_HOURS` derive from the same numbers.
describe("slaConstants (U14)", () => {
  it("keeps the timesheet auto-approve SLA at 24h", () => {
    expect(TIMESHEET_AUTO_APPROVE_HOURS).toBe(24);
    expect(TIMESHEET_AUTO_APPROVE_MS).toBe(24 * 60 * 60 * 1000);
    // The "auto-approves in {N}h" copy must derive from the same constant.
    expect(TIMESHEET_AUTO_APPROVE_MS).toBe(TIMESHEET_AUTO_APPROVE_HOURS * 60 * 60 * 1000);
  });

  it("keeps the shift-offer TTL at 2h", () => {
    expect(SHIFT_OFFER_TTL_HOURS).toBe(2);
    expect(SHIFT_OFFER_TTL_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("computes autoApproveAt as now + 24h", () => {
    const base = Date.parse("2026-06-24T00:00:00.000Z");
    expect(autoApproveAtIso(base)).toBe("2026-06-25T00:00:00.000Z");
  });

  it("defaults autoApproveAtIso to measuring from now", () => {
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T12:00:00.000Z"));
    expect(autoApproveAtIso()).toBe("2026-01-02T12:00:00.000Z");
    spy.mockRestore();
  });
});
