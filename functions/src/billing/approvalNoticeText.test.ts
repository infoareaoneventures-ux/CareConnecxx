// The family's "please review" text = the Timesheets card in words.
import { describe, it, expect } from "vitest";
import { buildApprovalNoticeText, fmtDuration } from "./approvalNoticeText";

const base = {
  caregiverName: "Basra Yousuf",
  date: "2026-09-17",
  totalHours: 0.0128,           // 46 seconds, like the live screenshot
  bookedRate: 5,
  lineItems: [],
  grossPayCents: 6,
  basePayCents: 6,
  lineItemsTotalCents: 0,
  submittedStartTime: "2026-09-18T02:05:54.000Z", // 7:05:54 PM Pacific
  submittedEndTime:   "2026-09-18T02:06:40.000Z", // 7:06:40 PM Pacific
  scheduledStartMs: Date.parse("2026-09-18T02:00:00.000Z"),
  scheduledEndMs:   Date.parse("2026-09-18T02:15:00.000Z"),
  requiresExplicitApproval: false,
  outsideScheduledWindow: false,
  autoApproveAt: "2026-09-19T02:06:45.000Z",
};

describe("buildApprovalNoticeText", () => {
  it("says what the card shows: caregiver, date, clock in/out, duration, scheduled window, base pay, charges, total, auto-approve time", () => {
    const t = buildApprovalNoticeText(base);
    expect(t).toContain("Basra Yousuf submitted hours for");
    expect(t).toMatch(/September 17/);
    expect(t).toContain("Clock in 7:05 PM → clock out 7:06 PM (0:00:46)");
    expect(t).toContain("Scheduled 7:00 PM–7:15 PM");
    expect(t).toContain("Base pay: 0:00:46 @ $5/hr = $0.06");
    expect(t).toContain("No additional charges");
    expect(t).toContain("Total: $0.06");
    expect(t).toContain("Service fee (9%, $1 minimum): $1.00"); // the floor applied, so the label says so
    expect(t).toContain("Charged to your card: $1.06");
    expect(t).toMatch(/Auto-approves .*Sep 18.* unless you review it first\./);
    expect(t).toContain("Reply APPROVE to release payment, or tell me the correct clock-in and clock-out");
    expect(t).not.toContain("DISPUTE");
  });

  it("lists each additional charge with its note and explains that charges block auto-approval (the caregiver's modal says the same)", () => {
    const t = buildApprovalNoticeText({
      ...base,
      lineItems: [{ type: "mileage", label: "Mileage", note: "12 mi", amount: 8.4 }, { type: "supplies", label: "Supplies", amount: 3 }],
      grossPayCents: 1146, lineItemsTotalCents: 1140,
      requiresExplicitApproval: true, autoApproveAt: null,
    });
    expect(t).toContain("Additional charges: Mileage $8.40 (12 mi), Supplies $3.00");
    expect(t).toContain("Total: $11.46");
    expect(t).toContain("Service fee (9%): $1.03");
    expect(t).toContain("Charged to your card: $12.49");
    expect(t).toContain("won't auto-approve because of the additional charges");
    expect(t).not.toContain("Auto-approves");
  });

  it("names the other two reasons a timesheet waits for the family: hours outside the scheduled visit, or a total over $500", () => {
    const outside = buildApprovalNoticeText({ ...base, requiresExplicitApproval: true, outsideScheduledWindow: true, autoApproveAt: null });
    expect(outside).toContain("because the hours fall outside the scheduled visit");
    const big = buildApprovalNoticeText({ ...base, totalHours: 30, bookedRate: 20, grossPayCents: 60_000, basePayCents: 60_000, requiresExplicitApproval: true, autoApproveAt: null });
    expect(big).toContain("Total: $600.00");
    expect(big).toContain("because the total is over $500");
  });

  it("degrades honestly when an old outbox record has only the one-liner fields", () => {
    const t = buildApprovalNoticeText({ caregiverName: "Imran", date: "2026-09-10", totalHours: 2, grossPayCents: 4800, bookedRate: 24 });
    expect(t).toContain("Imran submitted hours for");
    expect(t).toContain("2:00:00 worked");
    expect(t).toContain("Base pay: 2:00:00 @ $24/hr = $48.00");
    expect(t).toContain("Total: $48.00");
  });

  it("fmtDuration matches the page's h:mm:ss", () => {
    expect(fmtDuration(1.5)).toBe("1:30:00");
    expect(fmtDuration(0.0128)).toBe("0:00:46");
  });
});
