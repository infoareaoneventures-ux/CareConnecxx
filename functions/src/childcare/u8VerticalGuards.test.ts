// U8 vertical guards on LIVE senior money/swap files (plan 2026-07-22-002,
// R37/R39, AE16).
//
// Two layers (u7VerticalGuards pattern):
//   1. DIRECT unit tests for the SMS handlers whose module graphs are light
//      enough to import (caregiverSwapHandler, clientSwapRequestHandler,
//      caregiverCancelShiftHandler, timesheetHandler, refundHandler,
//      pendingTimesheetNudge): childcare records never enter the senior SMS
//      money/swap flows — web-redirect replies, senior paths byte-identical.
//   2. SOURCE-SCAN characterization for the wiring inside the heavy money
//      modules (shiftHours, stripe, refundProcessor, disputeResolution,
//      appointmentCompletion, caregiverCallout, replacementAgent, mcp/server,
//      billing/createValidatedShiftHours, paymentMethods, index.ts review
//      aggregation, bookingCallables U8 seam wires).

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ── Shared in-memory Firestore mock (u7VerticalGuards pattern) ───────────────
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();

  const valueAt = (doc: any, p: string): unknown =>
    p.split(".").reduce<any>((acc, part) => (acc == null ? undefined : acc[part]), doc);

  const matches = (doc: any, f: { field: string; op: string; value: any }): boolean => {
    const v = valueAt(doc, f.field);
    if (f.op === "==") return v === f.value;
    if (f.op === "in") return Array.isArray(f.value) && f.value.includes(v);
    if (f.op === ">=") return typeof v === "string" && v >= f.value;
    if (f.op === "<=") return typeof v === "string" && v <= f.value;
    return false;
  };

  const makeDocRef = (p: string): any => ({
    id: p.split("/").pop(),
    path: p,
    get: async () => ({ exists: docs.has(p), id: p.split("/").pop(), data: () => docs.get(p), ref: makeDocRef(p) }),
    set: async (data: any, opts?: any) => {
      docs.set(p, opts?.merge ? { ...(docs.get(p) ?? {}), ...data } : { ...data });
    },
    update: async (data: any) => {
      docs.set(p, { ...(docs.get(p) ?? {}), ...data });
    },
    collection: (sub: string) => makeCollRef(`${p}/${sub}`),
  });

  const makeQuery = (collPath: string, filters: any[] = [], lim?: number): any => ({
    where: (field: string, op: string, value: any) => makeQuery(collPath, [...filters, { field, op, value }], lim),
    orderBy: () => makeQuery(collPath, filters, lim),
    limit: (n: number) => makeQuery(collPath, filters, n),
    get: async () => {
      let rows = [...docs.entries()]
        .filter(([p]) => p.startsWith(`${collPath}/`) && p.split("/").length === collPath.split("/").length + 1)
        .map(([p, d]) => ({ id: p.split("/").pop()!, data: () => d, ref: makeDocRef(p), _raw: d }))
        .filter((r) => filters.every((f) => matches(r._raw, f)));
      if (lim !== undefined) rows = rows.slice(0, lim);
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });

  const makeCollRef = (p: string): any => ({
    doc: (id?: string) => makeDocRef(`${p}/${id ?? `auto-${docs.size}`}`),
    add: async (data: any) => {
      const ref = makeDocRef(`${p}/auto-${docs.size}`);
      await ref.set(data);
      return ref;
    },
    where: makeQuery(p).where,
    limit: makeQuery(p).limit,
    get: makeQuery(p).get,
  });

  return {
    docs,
    db: {
      collection: (p: string) => makeCollRef(p),
      runTransaction: async (fn: any) =>
        fn({
          get: (ref: any) => ref.get(),
          set: (ref: any, data: any, opts?: any) => void ref.set(data, opts),
          update: (ref: any, data: any) => { docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data }); },
        }),
    },
    reset: () => docs.clear(),
  };
});

vi.mock("firebase-admin", () => {
  const firestore: any = Object.assign(() => hoisted.db, {
    FieldValue: {
      delete: () => ({ __delete: true }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
      arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
    },
  });
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});

const sendMessageMock = vi.hoisted(() => vi.fn(async () => ({ message_id: "m1" })));
vi.mock("../linq/client", () => ({
  sendMessage: sendMessageMock,
  getOrCreateSession: vi.fn(async () => ({ chatId: "chat-x" })),
  sendToPhone: vi.fn(async () => {}),
}));
vi.mock("../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async ({ fallback }: { fallback: string }) => fallback),
}));
vi.mock("../utils/parseWithClaude", () => ({ parseWithClaude: vi.fn(async () => "NO") }));
vi.mock("../utils/openaiClient", () => ({ quickComplete: vi.fn(async () => "NO") }));
vi.mock("./humanReply", () => ({}));
vi.mock("../agents/humanReply", () => ({
  answerHumanMidFlow: vi.fn(async () => "answer"),
  answerHumanQuestionOnly: vi.fn(async () => "answer"),
}));
vi.mock("../agents/shiftOffer", () => ({ createShiftOffer: vi.fn(async () => "offer-1") }));
vi.mock("../utils/caregiverEligibility", () => ({ isCaregiverBookable: vi.fn(() => true) }));
vi.mock("../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async () => true) }));

import { handleCaregiverSwapRequest } from "../agents/caregiverSwapHandler";
import { handleClientSwapRequest } from "../agents/clientSwapRequestHandler";
import { handleCaregiverCancelShift } from "../agents/caregiverCancelShiftHandler";
import { handleTimesheetApproval } from "../agents/timesheetHandler";
import { handleRefundRequest } from "../agents/refundHandler";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const CG = "cg-1";
const FAMILY = "family-1";
const CG_PHONE = "+15550001111";
const FAM_PHONE = "+15550002222";

function seedChildcareAppt(id: string, extra: Record<string, unknown> = {}) {
  hoisted.docs.set(`appointments/${id}`, {
    careVertical: "child",
    childcareBookingId: "cbook_1",
    caregiverId: CG,
    clientId: FAMILY,
    status: "confirmed",
    date: "2099-01-04",
    startTime: "09:00",
    isoDate: "2099-01-04",
    clientName: "Family",
    caregiverName: "Pat",
    ...extra,
  });
}

function seedSeniorAppt(id: string, extra: Record<string, unknown> = {}) {
  hoisted.docs.set(`appointments/${id}`, {
    caregiverId: CG,
    clientId: FAMILY,
    status: "confirmed",
    date: "2099-01-05",
    startTime: "10:00",
    isoDate: "2099-01-05",
    clientName: "The Client",
    caregiverName: "Pat",
    ...extra,
  });
}

beforeEach(() => {
  hoisted.reset();
  sendMessageMock.mockClear();
  hoisted.docs.set(`agent_sessions/${CG_PHONE}`, { userId: CG });
  hoisted.docs.set(`agent_sessions/${FAM_PHONE}`, { userId: FAMILY });
});

// ── 1. Direct unit tests — childcare records skip the senior SMS flows ───────

describe("caregiverSwapHandler (childcare never enters the SMS swap flow)", () => {
  it("only-childcare shifts → web redirect, no swap state, no candidates stored", async () => {
    seedChildcareAppt("ca1");
    await handleCaregiverSwapRequest(CG, "Pat", CG_PHONE, "SWAP", {}, "chat-1");
    expect(sendMessageMock).toHaveBeenCalledWith("chat-1", expect.stringContaining("web"));
    expect(hoisted.docs.get(`agent_sessions/${CG_PHONE}`).swapStep).toBeUndefined();
    expect([...hoisted.docs.keys()].filter((p) => p.startsWith("shift_swap_requests/"))).toHaveLength(0);
  });

  it("mixed shifts → only the SENIOR shift is offered for swap", async () => {
    seedChildcareAppt("ca1");
    seedSeniorAppt("sa1");
    await handleCaregiverSwapRequest(CG, "Pat", CG_PHONE, "SWAP", {}, "chat-1");
    const session = hoisted.docs.get(`agent_sessions/${CG_PHONE}`);
    expect(session.swapStep).toBe("confirm_shift");
    const candidates = JSON.parse(session.swapCandidates);
    expect(candidates.map((c: any) => c.id)).toEqual(["sa1"]);
  });
});

describe("clientSwapRequestHandler (family SMS swap skips childcare)", () => {
  it("only-childcare visits → web redirect, no swap state", async () => {
    seedChildcareAppt("ca1");
    await handleClientSwapRequest(FAMILY, FAM_PHONE, "swap caregiver", {}, "chat-2");
    expect(sendMessageMock).toHaveBeenCalledWith("chat-2", expect.stringContaining("web"));
    expect(hoisted.docs.get(`agent_sessions/${FAM_PHONE}`).clientSwapStep).toBeUndefined();
  });

  it("senior visits keep the pre-U8 selection flow", async () => {
    seedSeniorAppt("sa1");
    await handleClientSwapRequest(FAMILY, FAM_PHONE, "swap caregiver", {}, "chat-2");
    expect(hoisted.docs.get(`agent_sessions/${FAM_PHONE}`).clientSwapStep).toBe("select_appointment");
  });
});

describe("caregiverCancelShiftHandler (SMS cancel skips childcare + belt guard)", () => {
  it("only-childcare shifts → web redirect, no cancel state", async () => {
    seedChildcareAppt("ca1");
    await handleCaregiverCancelShift(CG, "Pat", CG_PHONE, "cancel my shift", {}, "chat-3");
    expect(sendMessageMock).toHaveBeenCalledWith("chat-3", expect.stringContaining("web"));
    // The guard clears the flow state (FieldValue.delete sentinel in the mock).
    expect(typeof hoisted.docs.get(`agent_sessions/${CG_PHONE}`).cancelStep).not.toBe("string");
  });

  it("BELT: a stale/spoofed childcare candidate can never be SMS-cancelled at the final write", async () => {
    seedChildcareAppt("ca1");
    // Simulate a session that somehow carries a childcare shift at the final
    // confirm step (stale state from before the filter existed).
    const session = {
      cancelStep: "confirm_cancel",
      cancelShiftId: "ca1",
      cancelShiftDate: "2099-01-04",
      cancelShiftClientId: FAMILY,
      cancelReason: "sick",
    };
    await handleCaregiverCancelShift(CG, "Pat", CG_PHONE, "YES", session, "chat-3");
    expect(hoisted.docs.get("appointments/ca1").status).toBe("confirmed"); // NOT cancelled
  });
});

describe("timesheetHandler (SMS timesheet approval skips childcare rows)", () => {
  const sender = vi.fn(async () => {});
  beforeEach(() => sender.mockClear());

  it("only-childcare pending rows → in-app redirect, nothing approved", async () => {
    hoisted.docs.set("shiftHours/cappt_1", {
      careVertical: "child", clientId: FAMILY, caregiverId: CG,
      status: "pending_client_review", submittedAt: "2026-08-10T20:00:00.000Z", amountCents: 9800,
    });
    await handleTimesheetApproval(FAMILY, FAM_PHONE, "timesheets", {}, sender);
    expect(String((sender.mock.calls[0] as unknown[])[0])).toContain("app");
    expect(hoisted.docs.get("shiftHours/cappt_1").status).toBe("pending_client_review");
    expect(typeof hoisted.docs.get(`agent_sessions/${FAM_PHONE}`).timesheetStep).not.toBe("string");
  });

  it("senior rows keep the pre-U8 confirm_one flow", async () => {
    hoisted.docs.set("shiftHours/sa1", {
      clientId: FAMILY, caregiverId: CG, status: "pending_client_review",
      submittedAt: "2026-08-10T20:00:00.000Z", amountCents: 12000, date: "2026-08-10",
      durationHours: 4, appointmentId: "sa1",
    });
    hoisted.docs.set(`caregivers/${CG}`, { name: "Pat Provider" });
    await handleTimesheetApproval(FAMILY, FAM_PHONE, "timesheets", {}, sender);
    expect(hoisted.docs.get(`agent_sessions/${FAM_PHONE}`).timesheetStep).toBe("confirm_one");
  });
});

describe("refundHandler (SMS refund flow skips childcare visits)", () => {
  const sender = vi.fn(async () => {});
  beforeEach(() => sender.mockClear());

  it("only-childcare visits → in-app redirect, no refund state", async () => {
    seedChildcareAppt("ca1", { status: "completed" });
    await handleRefundRequest(FAMILY, FAM_PHONE, "refund", {}, sender);
    expect(String((sender.mock.calls[0] as unknown[])[0])).toContain("app");
    expect(typeof hoisted.docs.get(`agent_sessions/${FAM_PHONE}`).refundStep).not.toBe("string");
    expect([...hoisted.docs.keys()].filter((p) => p.startsWith("refundRequests/"))).toHaveLength(0);
  });

  it("senior visits keep the pre-U8 select_visit flow", async () => {
    seedSeniorAppt("sa1", { status: "completed", cost: 112 });
    await handleRefundRequest(FAMILY, FAM_PHONE, "refund", {}, sender);
    expect(hoisted.docs.get(`agent_sessions/${FAM_PHONE}`).refundStep).toBe("select_visit");
  });
});

// ── 2. Source-scan characterization (guards wired BEFORE senior logic) ───────

describe("source characterization: U8 childcare guards sit before senior money logic", () => {
  it("appointmentCompletion routes childcare BEFORE the senior completed write", () => {
    const s = src("functions/src/appointmentCompletion.ts");
    const guard = s.indexOf('a.careVertical === "child"');
    const seniorWrite = s.indexOf('status: "completed"');
    expect(guard).toBeGreaterThan(-1);
    expect(seniorWrite).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(seniorWrite);
    expect(s).toContain("handleOverdueChildcareVisit");
  });

  it("shiftHours: submit/cash/iMessage-approve fail closed on childcare; charge uses policy fee + payer + correlation", () => {
    const s = src("functions/src/shiftHours.ts");
    expect(s).toContain("childcare_hours_are_server_derived");
    expect(s).toContain("Childcare visits settle by card only");
    expect(s).toContain('if (iMsgShift.careVertical === "child") return;');
    expect(s).toContain("childcareFeeCentsForShift");
    expect(s).toContain("payout_hold_active");
    expect(s).toContain("billingUserId");
    expect(s).toContain("childcareBookingId");
    // Senior fee math still present verbatim.
    expect(s).toContain("Math.max(Math.round(grossCents * PLATFORM_FEE_RATE), Math.round(PLATFORM_FEE_MIN * 100))");
  });

  it("billing/createValidatedShiftHours fails closed on childcare appointments for EVERY source", () => {
    const s = src("functions/src/billing/createValidatedShiftHours.ts");
    const guard = s.indexOf('appointment.careVertical === "child"');
    const assignedCheck = s.indexOf("appointment.caregiverId !== input.actorUid");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(assignedCheck);
  });

  it("paymentMethods refuses offline methods on childcare bookings", () => {
    const s = src("functions/src/paymentMethods.ts");
    expect(s).toContain("appt.careVertical === 'child' && paymentMethod !== 'credit'");
  });

  it("refundProcessor: childcare correlation metadata + in-app notice; senior SMS branch intact", () => {
    const s = src("functions/src/triggers/refundProcessor.ts");
    expect(s).toContain('shift.careVertical === "child"');
    expect(s).toContain("childcare_refund_processed");
    expect(s).toContain("sendViaInteractionAgent(clientPhone");
  });

  it("disputeResolution: childcare branch holds the payout and never SMSes", () => {
    const s = src("functions/src/triggers/disputeResolution.ts");
    const guard = s.indexOf('dispute.careVertical === "child"');
    const seniorSms = s.indexOf("Load phones for both parties");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(seniorSms);
    // The hold now runs through the DURABLE payout-hold operation ledger
    // (childcare/payoutHoldWorker) instead of a direct inline hold call, so the
    // hold survives a crash between the dispute write and the payout freeze.
    expect(s).toContain("enqueueChildcarePayoutHold");
  });

  it("stripe.ts: chargeback handler scopes payout holds to childcare rows only", () => {
    const s = src("functions/src/stripe.ts");
    expect(s).toContain("charge.dispute.created");
    expect(s).toContain("handleChildcareChargeDispute");
    expect(s).toContain("!== 'child'");
  });

  it("caregiverCallout: all three active callables refuse childcare appointments", () => {
    const s = src("functions/src/caregiverCallout.ts");
    const guards = s.match(/careVertical === 'child'/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });

  it("replacementAgent fails closed on childcare with an admin alert (no senior pipeline)", () => {
    const s = src("functions/src/agents/replacementAgent.ts");
    const guard = s.indexOf('appt?.careVertical === "child"');
    const seniorPipeline = s.indexOf("scoreReplacements({");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(seniorPipeline);
    expect(s).toContain("childcare_replacement_needed");
  });

  it("mcp submit_review refuses childcare appointments (server-only childcare reviews)", () => {
    const s = src("functions/src/mcp/server.ts");
    const idx = s.indexOf('if (name === "submit_review")');
    const guard = s.indexOf("CHILDCARE_NOT_SUPPORTED", idx);
    const write = s.indexOf('collection("reviews").add', idx);
    expect(guard).toBeGreaterThan(idx);
    expect(guard).toBeLessThan(write);
  });

  it("pendingTimesheetNudge skips childcare rows before grouping", () => {
    const s = src("functions/src/scheduled/pendingTimesheetNudge.ts");
    expect(s).toContain('d.data().careVertical === "child"');
  });

  it("bookingCallables wires the U8 seams: validated hours at checkout, cancellation outcome, child hire outcome", () => {
    const s = src("functions/src/childcare/bookingCallables.ts");
    expect(s).toContain("createChildcareValidatedShiftHoursForToday");
    expect(s).toContain("evaluateAndRecordChildcareCancellation");
    expect(s).toContain('recordCaregiverOutcome');
    expect(s).toContain('"child",');
  });

  it("index.ts review aggregation and triggers/reviewProjection partition the reviews collection by vertical", () => {
    const senior = src("functions/src/index.ts");
    expect(senior).toContain("(after ?? before)?.careVertical === 'child'");
    const child = src("functions/src/triggers/reviewProjection.ts");
    expect(child).toContain('row.careVertical !== "child"');
  });
});
