// Regression test for the SMS-native visit-completion → payment rail.
//
// The canonical caregiver UX completes a visit over SMS: caregiver texts DONE,
// Cara asks for notes, and handleCareNotes (routeCaregiver.ts) runs. The bug we
// fixed: that path used to call a dead createVisitPayment (a confirm:false
// PaymentIntent that was never captured), so SMS-completed visits charged $0 and
// took no platform fee. It now funnels into the single shiftHours rail.
//
// This test pins that contract: an SMS-completed visit MUST produce a shiftHours
// doc that the charge engine (shiftHours.ts → processShiftPayment) can actually
// bill — i.e. status pending_client_review with a positive resolvable gross — and
// MUST notify the family to APPROVE. If a refactor reverts to a no-op billing
// path, this fails. Every collaborator is mocked; we assert on Firestore writes.

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  let autoId = 0;

  // Enumerate the immediate child docs of a collection path (one segment after).
  const collDocs = (collPath: string) => {
    const prefix = collPath + "/";
    const out: Array<{ id: string; data: any }> = [];
    for (const [path, data] of docState) {
      if (path.startsWith(prefix)) {
        const rest = path.slice(prefix.length);
        if (!rest.includes("/")) out.push({ id: rest, data });
      }
    }
    return out;
  };

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({
      exists: docState.has(path),
      id:     path.split("/").pop(),
      data:   () => docState.get(path),
    }),
    set: async (data: any, opts?: any) => {
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    },
    update: async (data: any) => {
      docState.set(path, { ...(docState.get(path) ?? {}), ...data });
    },
    // Atomic create: mirrors Firestore's ALREADY_EXISTS (gRPC code 6).
    create: async (data: any) => {
      if (docState.has(path)) {
        const err: any = new Error("already exists");
        err.code = 6;
        throw err;
      }
      docState.set(path, data);
    },
    delete: async () => { docState.delete(path); },
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (collPath: string): any => {
    const filters: Array<{ field: string; op: string; val: any }> = [];
    const ref: any = {};
    ref.doc     = (id?: string) => makeDocRef(`${collPath}/${id ?? `auto-${autoId++}`}`);
    ref.where   = (field: string, op: string, val: any) => { filters.push({ field, op, val }); return ref; };
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit   = (..._a: any[]) => ref;
    ref.add     = async (data: any) => { const id = `auto-${autoId++}`; docState.set(`${collPath}/${id}`, data); return { id }; };
    ref.get     = async () => {
      let items = collDocs(collPath);
      for (const f of filters) {
        // Only equality is modeled; range/`in` filters pass through (good enough
        // for the queries this path makes — care_journal dedup, client lookup).
        if (f.op === "==") items = items.filter((it) => it.data?.[f.field] === f.val);
      }
      return {
        empty: items.length === 0,
        docs:  items.map((it) => ({ id: it.id, data: () => it.data, ref: makeDocRef(`${collPath}/${it.id}`) })),
      };
    };
    return ref;
  };

  const collection = vi.fn((name: string) => makeCollRef(name));

  const runTransaction = async (fn: (t: any) => Promise<void>) => fn({
    get:    (refOrQuery: any) => refOrQuery.get(),
    set:    (ref: any, data: any) => { ref.set(data); },
    update: (ref: any, data: any) => { ref.update(data); },
  });

  const firestoreFn: any = Object.assign(() => ({ collection, runTransaction }), {
    FieldValue: {
      delete:          () => ({ __delete: true }),
      arrayUnion:      (...v: any[]) => ({ __arrayUnion: v }),
      increment:       (n: number) => ({ __increment: n }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
  });

  return {
    docState, collection, firestoreFn,
    reset: () => { docState.clear(); autoId = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default:    { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn },
  apps:       [{}],
  initializeApp: vi.fn(),
  firestore:  hoisted.firestoreFn,
}));

// ── Collaborators ────────────────────────────────────────────────────────────
const sendMessage = vi.fn(async (..._a: any[]) => ({ message_id: "m1" }));
const sendToPhone = vi.fn(async (..._a: any[]) => ({ message_id: "m2" }));
vi.mock("../client", () => ({
  sendMessage: (...a: any[]) => sendMessage(...a),
  sendToPhone: (...a: any[]) => sendToPhone(...a),
  startTyping: vi.fn(async () => {}),
  stopTyping:  vi.fn(async () => {}),
}));

const quickComplete = vi.fn(async (..._a: any[]) => '{"notes":"ate well","mood":"happy","appetite":"good"}');
vi.mock("../../utils/openaiClient", () => ({
  quickComplete: (...a: any[]) => quickComplete(...a),
}));

vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async ({ fallback }: any) => fallback ?? "msg"),
}));
vi.mock("../../utils/dndGuard", () => ({ sendIfNotDND: vi.fn(async () => {}) }));

const sendViaInteractionAgent = vi.fn(async (..._a: any[]) => {});
vi.mock("../../agents/caraAgent", () => ({
  sendViaInteractionAgent: (...a: any[]) => sendViaInteractionAgent(...a),
}));

vi.mock("../../agents/caregiverSwapHandler", () => ({
  handleCaregiverSwapRequest: vi.fn(async () => {}),
  handleSwapAcceptance:       vi.fn(async () => {}),
}));
vi.mock("../../agents/caregiverCancelShiftHandler", () => ({ handleCaregiverCancelShift: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverProfileHandler", () => ({ handleCaregiverProfileUpdate: vi.fn(async () => {}) }));
vi.mock("../../triggers/jobNotifications", () => ({
  handleJobResponse:             vi.fn(async () => {}),
  handleAvailabilityConfirmation: vi.fn(async () => {}),
}));
vi.mock("../../agents/interviewAgent", () => ({ handleCaregiverAvailabilityReply: vi.fn(async () => {}) }));

import { routeCaregiverMessage } from "../routeCaregiver";

const CG_PHONE     = "+15551234567";
const CLIENT_PHONE = "+15557770000";
const APPT_ID      = "appt-1";
const CLIENT_ID    = "client-1";
const CAREGIVER_ID = "cg1";
const HOURLY_RATE  = 25;
const DURATION_H   = 3;

// Replicates processShiftPayment's gross-pay resolution (shiftHours.ts) so the
// assertion proves the doc is chargeable by the REAL engine, not just well-formed.
function resolveGrossCents(shift: any): number {
  const grossDollars =
    typeof shift.grossPay === "number"   ? shift.grossPay
    : typeof shift.amountCents === "number" ? shift.amountCents / 100
    : Number(shift.finalTotalHours ?? shift.submittedTotalHours ?? 0) *
      Number(shift.payRate ?? shift.hourlyRate ?? 0);
  const grossCents = Math.round(grossDollars * 100);
  if (!Number.isFinite(grossDollars) || grossCents <= 0) return 0;
  return grossCents;
}

function seed() {
  // Caregiver session, parked awaiting notes after texting DONE.
  hoisted.docState.set(`agent_sessions/${CG_PHONE}`, {
    chatId: "cg-chat", userType: "caregiver", caregiverId: CAREGIVER_ID,
    awaitingCareNotes: true, careNotesApptId: APPT_ID, service: "SMS",
  });
  // Client session — resolved by getClientPhoneByClientId (where userId == clientId).
  hoisted.docState.set(`agent_sessions/${CLIENT_PHONE}`, {
    chatId: "client-chat", userType: "client", userId: CLIENT_ID, phone: CLIENT_PHONE,
  });
  hoisted.docState.set(`appointments/${APPT_ID}`, {
    clientId: CLIENT_ID, seniorId: CLIENT_ID, status: "in-progress",
    durationHours: DURATION_H, date: "2026-06-15", clientName: "Smith Family",
    paymentMethod: "credit",
  });
  hoisted.docState.set(`caregivers/${CAREGIVER_ID}`, { name: "Jane Doe", hourlyRate: HOURLY_RATE });
}

function makeCtx(text: string) {
  return {
    phone:   CG_PHONE,
    chatId:  "cg-chat",
    text,
    norm:    text.toUpperCase().trim(),
    session: hoisted.docState.get(`agent_sessions/${CG_PHONE}`) as any,
  };
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  quickComplete.mockResolvedValue('{"notes":"ate well","mood":"happy","appetite":"good"}');
  sendMessage.mockResolvedValue({ message_id: "m1" });
  seed();
});

describe("handleCareNotes → shiftHours payment rail", () => {
  it("produces a chargeable shiftHours doc for an SMS-completed visit", async () => {
    const outcome = await routeCaregiverMessage(makeCtx("ate well, good mood"));
    expect(outcome).toBe("handled");

    const shift = hoisted.docState.get(`shiftHours/${APPT_ID}`);
    expect(shift).toBeTruthy();

    // The charge engine only bills shifts in this state...
    expect(shift.status).toBe("pending_client_review");
    expect(shift.appointmentId).toBe(APPT_ID);
    expect(shift.caregiverId).toBe(CAREGIVER_ID);
    expect(shift.clientId).toBe(CLIENT_ID);

    // ...and it must resolve to a positive charge via processShiftPayment's own logic.
    expect(resolveGrossCents(shift)).toBe(HOURLY_RATE * DURATION_H * 100); // 7500
    expect(shift.grossPay).toBe(HOURLY_RATE * DURATION_H);                 // 75
    expect(shift.paymentMethod).toBe("credit");
  });

  it("notifies the family to APPROVE and arms the pendingShiftApproval flag", async () => {
    await routeCaregiverMessage(makeCtx("ate well, good mood"));

    // Among Cara's family messages (a shift-end care update also fires), exactly
    // one is the payment-approval prompt to the client phone asking for APPROVE.
    const approvalCalls = sendViaInteractionAgent.mock.calls.filter(
      ([toPhone, payload]: any[]) => toPhone === CLIENT_PHONE && String(payload?.content).includes("APPROVE"),
    );
    expect(approvalCalls).toHaveLength(1);

    // routeClient's approval flow keys off this session flag.
    const clientSession = hoisted.docState.get(`agent_sessions/${CLIENT_PHONE}`);
    expect(clientSession.pendingShiftApproval).toMatchObject({ appointmentId: APPT_ID });
    expect(clientSession.pendingShiftApproval.amount).toBe("75.00");
  });

  it("is idempotent — a re-submission for the same visit neither double-bills nor re-notifies", async () => {
    await routeCaregiverMessage(makeCtx("ate well, good mood"));
    const firstNotifyCount = sendViaInteractionAgent.mock.calls.length;

    // Re-park the session and replay (e.g. duplicate webhook / caregiver re-tap).
    hoisted.docState.set(`agent_sessions/${CG_PHONE}`, {
      chatId: "cg-chat", userType: "caregiver", caregiverId: CAREGIVER_ID,
      awaitingCareNotes: true, careNotesApptId: APPT_ID, service: "SMS",
    });
    const outcome = await routeCaregiverMessage(makeCtx("ate well, good mood"));

    expect(outcome).toBe("handled");
    // Still exactly one shiftHours doc, unchanged amount.
    const shift = hoisted.docState.get(`shiftHours/${APPT_ID}`);
    expect(shift.grossPay).toBe(HOURLY_RATE * DURATION_H);
    // Replay is caught upstream by the care_journal dedup transaction (and the
    // shiftHours create() is atomic as a backstop), so the family is never
    // pinged — and never billed — twice for one visit.
    expect(sendViaInteractionAgent.mock.calls.length).toBe(firstNotifyCount);
  });
});
