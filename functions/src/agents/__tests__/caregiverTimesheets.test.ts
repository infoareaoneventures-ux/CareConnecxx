import { describe, it, expect, vi, beforeEach } from "vitest";

// The caregiver Payments page's Timesheets tab, texted (caregiverTimesheets.ts):
// the page's two reads and three chips, its rows and cards, the Report, and the
// two modals (Submit hours worked / Review correction) as flows that run the
// site's own server functions.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  updates: [] as Array<{ path: string; data: any }>,
  sessionWrites: [] as any[],
  sent: [] as string[],
  quick: vi.fn(async () => "NONE"),
  submit: vi.fn(async () => ({ success: true })),
  respond: vi.fn(async () => ({ success: true })),
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => {
      const q = (filters: Array<[string, string, any]>): any => ({
        where: (f: string, op: string, v: any) => q([...filters, [f, op, v]]),
        orderBy: () => q(filters), limit: () => q(filters),
        get: vi.fn(async () => {
          const docs = [...hoisted.docs.entries()].filter(([p, d]) => p.startsWith(`${name}/`) && filters.every(([f, , v]) => d[f] === v))
            .map(([p, d]) => ({ id: p.split("/")[1], data: () => d }));
          return { docs, empty: docs.length === 0 };
        }),
      });
      return {
        where: (f: string, op: string, v: any) => q([[f, op, v]]),
        doc: (id: string) => ({
          get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), id, data: () => hoisted.docs.get(`${name}/${id}`) })),
          update: vi.fn(async (d: any) => { hoisted.updates.push({ path: `${name}/${id}`, data: d }); if (name === "agent_sessions") { hoisted.sessionWrites.push(d); hoisted.docs.set(`${name}/${id}`, { ...(hoisted.docs.get(`${name}/${id}`) ?? {}), ...d }); } }),
          set: vi.fn(async (d: any) => { if (name === "agent_sessions") { hoisted.sessionWrites.push(d); hoisted.docs.set(`${name}/${id}`, { ...(hoisted.docs.get(`${name}/${id}`) ?? {}), ...d }); } }),
        }),
      };
    },
  }), { FieldValue: { delete: () => "__delete__", serverTimestamp: () => "__ts__" }, Timestamp: { fromMillis: (ms: number) => ({ __ms: ms }) } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => (hoisted.quick as any)(...a) }));
vi.mock("../stepHandler", () => ({ isBackOutRequest: vi.fn(async () => false), isQuestionOrOther: vi.fn(async () => false), answerMidFlow: vi.fn(async (_t: string, q: string) => `Answer. ${q}`) }));
vi.mock("../caregiverPastBookings", () => ({ visitDetailText: (s: any) => `VISIT ${s.id}` }));
vi.mock("../../config/appUrl", () => ({ getAppUrl: () => "https://app.test" }));
vi.mock("../../shiftHours", () => ({ submitShiftHoursAs: (...a: any[]) => (hoisted.submit as any)(...a), respondToCorrectionAs: (...a: any[]) => (hoisted.respond as any)(...a) }));

import {
  loadTimesheetsTab, unsubmittedText, pendingText, historyText, reportText, timesheetDetailText, unsubmittedDetailText, approvalNote,
  sendCaregiverTimesheets, resolveTimesheetRef, startSubmitHoursFlow, handleSubmitHoursFlowStep,
  startReviewCorrectionFlow, handleReviewCorrectionFlowStep, handleTimesheetsKeyword,
  EMPTY_UNSUBMITTED, EMPTY_PENDING, EMPTY_HISTORY, EMPTY_REPORT, dur, type TimesheetRow, type SubmitHoursFlowData,
} from "../caregiverTimesheets";

// 2:05:09 PM – 5:10:00 PM PDT on Sep 18, 2026 → 3:04:51 → $77.02 at $25/hr.
const IN = "2026-09-18T21:05:09.000Z", OUT = "2026-09-19T00:10:00.000Z";
const shift = (id: string, over: Record<string, unknown> = {}) => hoisted.docs.set(`shifts/${id}`, { caregiverId: "cg1", clientId: "fam1", clientName: "Basra Yousuf", date: "2026-09-18", startTime: "14:00", endTime: "17:00", rate: 25, status: "completed", startedAt: IN, completedAt: OUT, ...over });
const hours = (id: string, over: Record<string, unknown> = {}) => hoisted.docs.set(`shiftHours/${id}`, { caregiverId: "cg1", clientId: "fam1", clientName: "Basra Yousuf", appointmentId: id, shiftId: id, payRate: 25, submittedStartTime: IN, submittedEndTime: OUT, submittedTotalHours: 3.0808, basePay: 77.02, grossPay: 77.02, lineItems: [], submittedAt: "2026-09-19T00:12:00.000Z", status: "pending_client_review", autoApproveAt: "2026-09-20T00:12:00.000Z", ...over });
const session = () => ({ caregiverId: "cg1", ...(hoisted.docs.get("agent_sessions/+1") ?? {}) });

beforeEach(() => {
  hoisted.docs.clear(); hoisted.updates.length = 0; hoisted.sessionWrites.length = 0; hoisted.sent.length = 0;
  hoisted.quick.mockReset(); hoisted.quick.mockResolvedValue("NONE"); hoisted.submit.mockReset(); hoisted.submit.mockResolvedValue({ success: true }); hoisted.respond.mockReset(); hoisted.respond.mockResolvedValue({ success: true });
  hoisted.docs.set("agent_sessions/+1", { caregiverId: "cg1" });
});

describe("the tab — the page's reads and chips", () => {
  it("Unsubmitted = completed shifts with no shiftHours doc; Pending / History by status; corrections counted", async () => {
    shift("s1"); shift("s2"); shift("s3", { status: "scheduled" });
    hours("s2", { status: "correction_proposed" }); hours("h2", { status: "paid", appointmentId: "h2" }); hours("h3", { status: "requires_admin_review", appointmentId: "h3" });
    const tab = await loadTimesheetsTab("cg1");
    expect(tab.submittable.map((s) => s.id)).toEqual(["s1"]);
    expect(tab.pending.map((r) => r.id)).toEqual(["s2"]);
    expect(tab.history.map((r) => r.id).sort()).toEqual(["h2", "h3"]);
    expect(tab.corrections.map((r) => r.id)).toEqual(["s2"]);
  });
  it("Unsubmitted rows read like the card; the empty state is the page's", () => {
    expect(unsubmittedText([]).text).toBe(EMPTY_UNSUBMITTED);
    const r = unsubmittedText([{ id: "s1", clientName: "Basra Yousuf", date: "2026-09-18", startTime: "14:00", endTime: "17:00", rate: 25, startedAt: IN, completedAt: OUT, loggedManually: true }]);
    expect(r.text).toContain("Timesheets · Unsubmitted (1)");
    expect(r.text).toContain("Basra Yousuf · 1 shift");
    expect(r.text).toContain("1. Sep 18 · In 2:05:09 PM · Out 5:10:00 PM · 3:04:51 · Est. pay $77.02 · Card · Logged · Not submitted");
    expect(r.text).toContain("Reply SUBMIT n to submit a visit's hours");
    expect(r.items).toEqual([{ number: 1, kind: "shift", id: "s1" }]);
  });
  it("Pending rows carry the page's status labels; a correction says how to answer", () => {
    expect(pendingText([]).text).toBe(EMPTY_PENDING);
    const rows: TimesheetRow[] = [
      { id: "a", status: "pending_client_review", clientName: "B", submittedStartTime: IN, submittedEndTime: OUT, grossPay: 77.02 },
      { id: "b", status: "correction_proposed", clientName: "B", submittedStartTime: IN, submittedEndTime: OUT, grossPay: 77.02 },
      { id: "c", status: "payment_failed", clientName: "B", submittedStartTime: IN, submittedEndTime: OUT, grossPay: 77.02 },
    ];
    const r = pendingText(rows);
    expect(r.text).toContain("1. Sep 18 · 2:05:09 PM – 5:10:00 PM · 3:04:51 · $77.02 · Pending client review");
    expect(r.text).toContain("2. Sep 18 · 2:05:09 PM – 5:10:00 PM · 3:04:51 · $77.02 · Correction Received — reply REVIEW 2");
    expect(r.text).toContain("· Awaiting Payment");
    expect(r.text).toContain("1 correction needs your answer — reply REVIEW n.");
    expect(r.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
  it("History groups by month with the page's totals, badges Corrected, pages 5 at a time with MORE", () => {
    expect(historyText([]).text).toBe(EMPTY_HISTORY);
    const rows: TimesheetRow[] = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `h${n}`, status: n === 1 ? "paid" : "approved", clientName: "B", submittedStartTime: `2026-09-${String(10 + n).padStart(2, "0")}T21:00:00.000Z`, submittedEndTime: `2026-09-${String(10 + n).padStart(2, "0")}T23:00:00.000Z`, grossPay: 50, resolvedBy: n === 2 ? "caregiver" : "client" }));
    rows.push({ id: "aug", status: "paid", clientName: "B", submittedStartTime: "2026-08-02T21:00:00.000Z", submittedEndTime: "2026-08-02T23:00:00.000Z", grossPay: 40 });
    const p1 = historyText(rows);
    expect(p1.text).toContain("Timesheets · History (7)");
    expect(p1.text).toContain("September 2026 · 6 shifts · $300.00\nB · 5 shifts\n1. Sep 16");
    expect(p1.text).toContain("1. Sep 16 · 2:00:00 PM – 4:00:00 PM · 2:00:00 · $50.00 · Approved"); // newest first
    expect(p1.text).toContain("· Corrected · Approved");
    expect(p1.shown).toBe(5); expect(p1.remaining).toBe(2);
    expect(p1.text).toContain("Reply MORE for 2 older.");
    const p2 = historyText(rows, 5);
    expect(p2.text).toContain("More history:");
    expect(p2.text).toContain("August 2026 · 1 shift · $40.00");
    expect(p2.items.map((i) => i.number)).toEqual([6, 7]);
    expect(p2.text).toContain("6. Sep 11 · 2:00:00 PM – 4:00:00 PM · 2:00:00 · $50.00 · Paid");
  });
  it("Report = the History chip's date filter + Shifts / Total hours / Total earnings; the page's empty line", () => {
    const rows: TimesheetRow[] = [
      { id: "a", status: "paid", submittedStartTime: "2026-09-10T21:00:00.000Z", submittedEndTime: "2026-09-10T23:30:00.000Z", grossPay: 62.5 },
      { id: "b", status: "paid", submittedStartTime: "2026-08-10T21:00:00.000Z", submittedEndTime: "2026-08-10T22:00:00.000Z", grossPay: 25 },
    ];
    expect(reportText(rows)).toContain("Report · All history\nShifts 2\nTotal hours 3:30:00\nTotal earnings $87.50");
    expect(reportText(rows)).toContain("https://app.test/caregiver/payments?tab=timesheets");
    expect(reportText(rows, { from: "2026-09-01", to: "2026-09-30" })).toContain("Shifts 1\nTotal hours 2:30:00\nTotal earnings $62.50");
    expect(reportText(rows, { from: "2026-01-01", to: "2026-01-31" })).toContain(EMPTY_REPORT);
  });
  it("a row's card: rate, clock in/out, charges with base + total, auto-approve, the correction timeline", () => {
    const t = timesheetDetailText({
      id: "a", status: "correction_proposed", clientName: "Basra Yousuf", payRate: 25, submittedStartTime: IN, submittedEndTime: OUT, basePay: 77.02, grossPay: 89.52,
      lineItems: [{ type: "custom", label: "Mileage", note: "20 miles", amount: 12.5 }],
      correctionHistory: [
        { by: "caregiver", action: "submitted", at: "2026-09-19T00:12:00.000Z", startTime: IN, endTime: OUT, hours: 3.0808, basePay: 77.02, grossPay: 89.52 },
        { by: "client", action: "proposed_correction", at: "2026-09-19T03:04:00.000Z", startTime: "2026-09-18T21:30:00.000Z", endTime: "2026-09-19T00:00:00.000Z", hours: 2.5, basePay: 62.5, grossPay: 75, lineItems: [{ type: "custom", label: "Mileage", amount: 12.5 }], note: "She left early" },
      ],
    }, 2);
    expect(t).toContain("Basra Yousuf · Sep 18 · Correction Received");
    expect(t).toContain("Rate $25/hr");
    expect(t).toContain("Clock in / out Sep 18, 2:05:09 PM – Sep 18, 5:10:00 PM");
    expect(t).toContain("Base pay $77.02\nMileage · 20 miles +$12.50\nTotal $89.52");
    expect(t).toContain("History\n• Submitted by caregiver — Sep 18, 5:12 PM · 2:05 PM – 5:10 PM · 3:04:51 · $25/hr · Base $77.02 · Mileage +$12.50 · Total $89.52");
    expect(t).toContain("• Client proposed correction — Sep 18, 8:04 PM · 2:30 PM – 5:00 PM · 2:30:00 · $25/hr · Base $62.50 · Mileage +$12.50 · Total $75.00 · \"She left early\"");
    expect(t.endsWith("Reply REVIEW 2 to accept the correction or send a counter.")).toBe(true);
    const p = timesheetDetailText({ id: "b", status: "pending_client_review", clientName: "B", payRate: 25, submittedStartTime: IN, submittedEndTime: OUT, grossPay: 77.02, autoApproveAt: "2026-09-20T00:12:00.000Z" });
    expect(p).toContain("Gross pay $77.02\nAuto-approves Sep 19, 5:12 PM");
    const q = timesheetDetailText({ id: "c", status: "pending_client_review", clientName: "B", payRate: 25, submittedStartTime: IN, submittedEndTime: OUT, grossPay: 77.02, autoApproveAt: null,
      correctionHistory: [{ by: "caregiver", action: "submitted", at: "2026-09-19T00:12:00.000Z", startTime: IN, endTime: OUT, hours: 3.08 }] });
    expect(q).toContain("Auto-approves No — needs the family's approval");
    expect(q).not.toContain("History"); // the page hides a timeline that only has the submission itself
    // The expanded Unsubmitted card.
    const u = unsubmittedDetailText({ id: "s1", clientName: "Basra Yousuf", date: "2026-09-18", startTime: "14:00", endTime: "17:00", rate: 25, startedAt: IN, completedAt: OUT, careRecipients: [{ name: "H M" }, { name: "A M" }] }, 1);
    expect(u).toBe([
      "Basra Yousuf · Sep 18 · Not submitted",
      "Rate $25/hr",
      "Scheduled Sep 18 · 2:00:00 PM–5:00:00 PM",
      "Clock in Sep 18, 2:05:09 PM",
      "Clock out Sep 18, 5:10:00 PM",
      "Duration 3:04:51",
      "Est. pay $77.02",
      "Recipients H M, A M",
      "",
      "Reply SUBMIT 1 to submit hours, or VIEW 1 for the visit.",
    ].join("\n"));
  });
  it("sends a chip and stores the numbered list; MORE pages History from the stored offset", async () => {
    shift("s1");
    const r = await sendCaregiverTimesheets("+1", "chat", "cg1", "unsubmitted");
    expect(r.badge).toBe(1);
    const list = hoisted.docs.get("agent_sessions/+1").lastTimesheetList;
    expect(list.chip).toBe("unsubmitted"); expect(list.items).toEqual([{ number: 1, kind: "shift", id: "s1" }]);
    expect(resolveTimesheetRef(session(), { number: 1 })).toEqual({ number: 1, kind: "shift", id: "s1" });
    expect(resolveTimesheetRef(session(), { number: 9 })).toBeNull();
  });
});

describe("Submit hours worked — the modal as a flow", () => {
  it("starts with the modal (clock in/out from the visit, duration, base pay) and asks for additional charges", async () => {
    shift("s1");
    const r = await startSubmitHoursFlow("+1", "chat", session() as never, { caregiverId: "cg1", shiftId: "s1" });
    expect(r.started).toBe(true);
    expect(hoisted.sent[0]).toBe([
      "Submit hours worked — Basra Yousuf · Sep 18",
      "Clock in 2:05:09 PM, Sep 18",
      "Clock out 5:10:00 PM, Sep 18",
      "Duration 3:04:51",
      "Base pay (3:04:51 @ $25/hr) $77.02",
      "",
      `Any additional charges (overtime, mileage, supplies)? Reply one like "Mileage 12.50" (add a note after a dash: "Mileage 12.50 - 20 miles"), or NONE.`,
    ].join("\n"));
    const w = hoisted.sessionWrites[0];
    expect(w.submitHoursFlowStep).toBe("sh_items");
    expect(w.submitHoursFlowData.startIso).toBe(IN); expect(w.submitHoursFlowData.endIso).toBe(OUT);
    expect(w.submitHoursFlowData.rate).toBe(25); expect(w.submitHoursFlowData.items).toEqual([]);
  });
  it("refuses a visit that already has hours (and says where it is), and a visit that isn't completed", async () => {
    shift("s1"); hours("s1", { status: "paid" });
    expect((await startSubmitHoursFlow("+1", "chat", session() as never, { caregiverId: "cg1", shiftId: "s1" })).reason).toBe("already_submitted");
    expect(hoisted.sent[0]).toBe("Hours for that visit were already submitted — it's Paid. Reply PENDING or HISTORY to see it.");
    shift("s2", { status: "in-progress" });
    expect((await startSubmitHoursFlow("+1", "chat", session() as never, { caregiverId: "cg1", shiftId: "s2" })).reason).toBe("not_completed");
  });
  it("NONE → the recap with the page's 24-hour note → SUBMIT runs the site's server function and texts the page's toast", async () => {
    shift("s1");
    await startSubmitHoursFlow("+1", "chat", session() as never, { caregiverId: "cg1", shiftId: "s1" });
    await handleSubmitHoursFlowStep("+1", "chat", "none", session() as never);
    expect(hoisted.sent.at(-1)).toBe([
      "Submit hours worked — Basra Yousuf · Sep 18",
      "Base pay (3:04:51 @ $25/hr) $77.02",
      "",
      "Payment method: Card. Client has 24 hours to approve or propose a correction. After that, hours auto-approve and Stripe processes payment.",
      "",
      "Reply SUBMIT to submit, or CANCEL.",
    ].join("\n"));
    await handleSubmitHoursFlowStep("+1", "chat", "SUBMIT", session() as never);
    expect(hoisted.submit).toHaveBeenCalledWith("cg1", { shiftId: "s1", startTime: IN, endTime: OUT, lineItems: [] });
    expect(hoisted.sent.at(-1)).toBe("Hours submitted — awaiting client approval");
    expect(hoisted.docs.get("agent_sessions/+1").submitHoursFlowStep).toBe("__delete__");
  });
  it("a charge is parsed, confirmed, and listed with base + total and the extra-charges note; validation uses the modal's words", async () => {
    shift("s1");
    await startSubmitHoursFlow("+1", "chat", session() as never, { caregiverId: "cg1", shiftId: "s1" });
    hoisted.quick.mockResolvedValueOnce('{"label": "Mileage", "amount": 12.5, "note": "20 miles"}');
    await handleSubmitHoursFlowStep("+1", "chat", "mileage 12.50 - 20 miles", session() as never);
    expect(hoisted.sent.at(-1)).toBe("Added Mileage · $12.50. Another charge? Reply it, or DONE.");
    hoisted.quick.mockResolvedValueOnce('{"label": "Supplies", "amount": null, "note": null}');
    await handleSubmitHoursFlowStep("+1", "chat", "supplies", session() as never);
    expect(hoisted.sent.at(-1)).toContain("Please enter an amount for each additional charge.");
    hoisted.quick.mockResolvedValueOnce('{"label": null, "amount": 5, "note": null}');
    await handleSubmitHoursFlowStep("+1", "chat", "5 dollars", session() as never);
    expect(hoisted.sent.at(-1)).toContain("Please enter a label for each Custom charge.");
    await handleSubmitHoursFlowStep("+1", "chat", "DONE", session() as never);
    expect(hoisted.sent.at(-1)).toContain("Base pay (3:04:51 @ $25/hr) $77.02\nMileage · 20 miles $12.50\nTotal $89.52");
    expect(hoisted.sent.at(-1)).toContain("Payment method: Card. The client needs to review and approve this manually — there's no automatic approval for submissions with extra charges.");
    await handleSubmitHoursFlowStep("+1", "chat", "yes", session() as never);
    expect(hoisted.submit).toHaveBeenCalledWith("cg1", { shiftId: "s1", startTime: IN, endTime: OUT, lineItems: [{ type: "custom", label: "Mileage", amount: 12.5, note: "20 miles" }] });
  });
  it("the payment note's reasons match the modal: off-schedule hours, totals over $500", () => {
    const base: SubmitHoursFlowData = { shiftId: "s", clientName: "B", date: "2026-09-18", startIso: IN, endIso: OUT, totalHours: 3.08, rate: 25, scheduledStartMs: Date.parse("2026-09-18T21:00:00.000Z"), scheduledEndMs: Date.parse("2026-09-19T00:00:00.000Z"), items: [] };
    expect(approvalNote(base)).toContain("Client has 24 hours to approve");
    expect(approvalNote({ ...base, scheduledEndMs: Date.parse("2026-09-18T23:00:00.000Z") })).toContain("no automatic approval for hours that don't match the scheduled time.");
    expect(approvalNote({ ...base, rate: 200 })).toContain("no automatic approval for totals over $500.");
  });
  it("CANCEL backs out without a write; a server refusal is texted like the page's error toast", async () => {
    shift("s1");
    await startSubmitHoursFlow("+1", "chat", session() as never, { caregiverId: "cg1", shiftId: "s1" });
    await handleSubmitHoursFlowStep("+1", "chat", "cancel", session() as never);
    expect(hoisted.sent.at(-1)).toBe("Okay — nothing was submitted. The visit still shows under Unsubmitted.");
    expect(hoisted.submit).not.toHaveBeenCalled();
    await startSubmitHoursFlow("+1", "chat", session() as never, { caregiverId: "cg1", shiftId: "s1" });
    await handleSubmitHoursFlowStep("+1", "chat", "NONE", session() as never);
    hoisted.submit.mockRejectedValueOnce(new Error("Different hours were already submitted for this shift"));
    await handleSubmitHoursFlowStep("+1", "chat", "SUBMIT", session() as never);
    expect(hoisted.sent.at(-1)).toBe("Different hours were already submitted for this shift");
  });
});

describe("Review correction — the modal as a flow", () => {
  const correction = () => hours("a1", {
    status: "correction_proposed", proposedStartTime: "2026-09-18T21:30:00.000Z", proposedEndTime: "2026-09-19T00:00:00.000Z", proposedTotalHours: 2.5,
    proposedLineItems: [{ type: "custom", label: "Mileage", note: "", amount: 12.5 }], proposedGrossPay: 75, proposalReason: "She left early",
  });
  it("only a Correction Received row opens; it texts what the family proposed and the two buttons", async () => {
    hours("ok", { status: "pending_client_review" });
    expect((await startReviewCorrectionFlow("+1", "chat", session() as never, { caregiverId: "cg1", appointmentId: "ok" })).reason).toBe("not_correction");
    expect(hoisted.sent.at(-1)).toBe("That timesheet is Pending client review — Review & Respond is only for a correction the family sent.");
    correction();
    const r = await startReviewCorrectionFlow("+1", "chat", session() as never, { caregiverId: "cg1", appointmentId: "a1" });
    expect(r.started).toBe(true);
    expect(hoisted.sent.at(-1)).toBe([
      "Review correction — Basra Yousuf",
      "Client proposed: 2:30:00 PM – 5:00:00 PM · 2:30:00",
      "$25/hr · Base $62.50",
      "Mileage +$12.50",
      "Total $75.00",
      "\"She left early\"",
      "",
      "Reply ACCEPT to accept $75.00, or COUNTER to send a counter.",
    ].join("\n"));
  });
  it("ACCEPT runs the site's accept write and texts the page's toast", async () => {
    correction();
    await startReviewCorrectionFlow("+1", "chat", session() as never, { caregiverId: "cg1", appointmentId: "a1" });
    await handleReviewCorrectionFlowStep("+1", "chat", "accept", session() as never);
    expect(hoisted.respond).toHaveBeenCalledWith("cg1", { appointmentId: "a1", action: "accept" });
    expect(hoisted.sent.at(-1)).toBe("Correction accepted");
  });
  it("COUNTER asks start (KEEP), end, the charge amounts, a note, then SEND runs the counter write with the modal's payload", async () => {
    correction();
    await startReviewCorrectionFlow("+1", "chat", session() as never, { caregiverId: "cg1", appointmentId: "a1" });
    await handleReviewCorrectionFlowStep("+1", "chat", "counter", session() as never);
    expect(hoisted.sent.at(-1)).toBe("Counter start — reply a time like 2:05 PM, or KEEP for 2:30 PM.");
    await handleReviewCorrectionFlowStep("+1", "chat", "KEEP", session() as never);
    expect(hoisted.sent.at(-1)).toBe("Counter end — reply a time, or KEEP for 5:00 PM.");
    hoisted.quick.mockResolvedValueOnce("14:00");
    await handleReviewCorrectionFlowStep("+1", "chat", "2pm", session() as never);
    expect(hoisted.sent.at(-1)).toBe("The end has to be after the start (2:30 PM). Counter end — reply a time, or KEEP for 5:00 PM.");
    hoisted.quick.mockResolvedValueOnce("17:10");
    await handleReviewCorrectionFlowStep("+1", "chat", "5:10 pm", session() as never);
    expect(hoisted.sent.at(-1)).toBe('Additional charges: Mileage $12.50. Reply a new amount for any of them, like "Mileage 10", or KEEP.');
    hoisted.quick.mockResolvedValueOnce('{"1": 10}');
    await handleReviewCorrectionFlowStep("+1", "chat", "mileage 10", session() as never);
    expect(hoisted.sent.at(-1)).toBe("Note (optional) — why do you disagree? Reply the note, or SKIP.");
    await handleReviewCorrectionFlowStep("+1", "chat", "I stayed until she was settled", session() as never);
    expect(hoisted.sent.at(-1)).toBe([
      "Your counter — Basra Yousuf",
      "2:30:00 PM – 5:10:00 PM · 2:40:00",
      "$25/hr · Base $66.67",
      "Mileage +$10.00",
      "Your total $76.67",
      "Note: \"I stayed until she was settled\"",
      "",
      "Reply SEND to send the counter, or CANCEL.",
    ].join("\n"));
    await handleReviewCorrectionFlowStep("+1", "chat", "SEND", session() as never);
    expect(hoisted.respond).toHaveBeenCalledWith("cg1", {
      appointmentId: "a1", action: "counter_propose",
      counterStartTime: "2026-09-18T21:30:00.000Z", counterEndTime: "2026-09-19T00:10:00.000Z",
      counterNote: "I stayed until she was settled",
      counterLineItems: [{ type: "custom", label: "Mileage", note: "", amount: 10 }],
    });
    expect(hoisted.sent.at(-1)).toBe("Counter-proposal sent to client");
  });
  it("CANCEL leaves the correction waiting", async () => {
    correction();
    await startReviewCorrectionFlow("+1", "chat", session() as never, { caregiverId: "cg1", appointmentId: "a1" });
    await handleReviewCorrectionFlowStep("+1", "chat", "cancel", session() as never);
    expect(hoisted.sent.at(-1)).toBe("Okay — nothing was sent. The correction is still waiting for your answer under Pending.");
    expect(hoisted.respond).not.toHaveBeenCalled();
  });
});

describe("keywords — TIMESHEETS · PENDING · HISTORY · REPORT · SUBMIT n · REVIEW n · DETAILS n · VIEW n", () => {
  it("TIMESHEETS / PENDING / HISTORY text the chips; a bare SUBMIT with one unsubmitted visit opens its modal; several ask which", async () => {
    shift("s1");
    expect(await handleTimesheetsKeyword("+1", "chat", "cg1", "timesheets", session())).toBe("handled");
    expect(hoisted.sent.at(-1)).toContain("Timesheets · Unsubmitted (1)");
    expect(await handleTimesheetsKeyword("+1", "chat", "cg1", "PENDING", session())).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe(EMPTY_PENDING);
    expect(await handleTimesheetsKeyword("+1", "chat", "cg1", "history", session())).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe(EMPTY_HISTORY);
    expect(await handleTimesheetsKeyword("+1", "chat", "cg1", "SUBMIT", session())).toBe("handled");
    expect(hoisted.sent.at(-1)).toContain("Submit hours worked — Basra Yousuf · Sep 18");
    shift("s2", { date: "2026-09-19", startedAt: "2026-09-19T21:00:00.000Z", completedAt: "2026-09-20T00:00:00.000Z" });
    await handleTimesheetsKeyword("+1", "chat", "cg1", "submit", session());
    expect(hoisted.sent.at(-1)).toBe("Which one? Reply SUBMIT with the visit's number.");
    expect(await handleTimesheetsKeyword("+1", "chat", "cg1", "SUBMIT 2", session())).toBe("handled");
    expect(hoisted.sent.at(-1)).toContain("Submit hours worked");
    expect(await handleTimesheetsKeyword("+1", "chat", "cg1", "hello", session())).toBe("passthrough");
  });
  it("REVIEW n / DETAILS n / VIEW n resolve from the last list only while it is the latest; REPORT parses a range", async () => {
    hours("a1", { status: "correction_proposed", proposedStartTime: "2026-09-18T21:30:00.000Z", proposedEndTime: "2026-09-19T00:00:00.000Z", proposedTotalHours: 2.5, proposedGrossPay: 62.5, proposedLineItems: [] });
    await handleTimesheetsKeyword("+1", "chat", "cg1", "pending", session());
    expect(await handleTimesheetsKeyword("+1", "chat", "cg1", "DETAILS 1", session())).toBe("handled");
    expect(hoisted.sent.at(-1)).toContain("Basra Yousuf · Sep 18 · Correction Received");
    expect(await handleTimesheetsKeyword("+1", "chat", "cg1", "VIEW 1", session())).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe("Shift not found."); // no shifts doc in this fixture — the "View shift" modal's own line
    expect(await handleTimesheetsKeyword("+1", "chat", "cg1", "REVIEW 1", session())).toBe("handled");
    expect(hoisted.sent.at(-1)).toContain("Review correction — Basra Yousuf");
    // A newer numbered list from another page owns DETAILS n.
    const s = { ...session(), lastCalendarList: { at: "2099-01-01T00:00:00.000Z", items: [] } };
    expect(await handleTimesheetsKeyword("+1", "chat", "cg1", "DETAILS 1", s)).toBe("passthrough");
    hoisted.quick.mockResolvedValueOnce('{"from": "2026-09-01", "to": "2026-09-30"}');
    expect(await handleTimesheetsKeyword("+1", "chat", "cg1", "REPORT Sep 1 to Sep 30", session())).toBe("handled");
    expect(hoisted.sent.at(-1)).toContain("Report · Sep 1 – Sep 30");
    expect(dur(1.5)).toBe("1:30:00");
  });
});
