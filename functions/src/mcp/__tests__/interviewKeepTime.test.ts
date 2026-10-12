import { describe, it, expect, vi, beforeEach } from "vitest";

// accept_interview_reschedule action:"keep" (caregiver sweep B5, 2026-10-11) —
// the Interviews tab's Keep current time through the tool the model already
// uses for reschedule answers: the ONE shared write (agents/interviewProposal.ts),
// no gate, no text of its own (onVideoInterviewWrite tells the proposer), and
// the same refusals as the site (your own proposal, nothing pending).

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const collState = new Map<string, Array<{ id: string; data: any }>>();
  const updates: Array<{ path: string; data: any }> = [];
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path), ref: makeDocRef(path) })),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      const next = { ...(docState.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) { if ((v as any)?.__delete) delete next[k]; else next[k] = v; }
      docState.set(path, next);
    }),
  });
  const makeCollRef = (path: string): any => ({
    doc: (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`),
    where: (..._a: any[]) => makeCollRef(path),
    limit: (..._a: any[]) => makeCollRef(path),
    get: vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return { empty: items.length === 0, size: items.length, docs: items.map((d) => ({ id: d.id, data: () => d.data })) };
    }),
    add: vi.fn(async () => makeDocRef(`${path}/auto`)),
  });
  return { docState, collState, updates, collectionMock: vi.fn((p: string) => makeCollRef(p)), reset: () => { docState.clear(); collState.clear(); updates.length = 0; } };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }), delete: () => ({ __delete: true }) },
  }),
}));
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../agents/caregiverSearch", () => ({
  presentCaregiverSearch: vi.fn(async () => ({ status: "shown", total: 0, shown: [], offset: 0, hasMore: false })),
  searchCaregivers: vi.fn(async () => ({ total: 0, caregivers: [], hasLocation: false, filters: {} })),
}));
const sendToPhone = vi.fn().mockResolvedValue(undefined);
vi.mock("../../linq/client", () => ({ sendToPhone: (...a: any[]) => sendToPhone(...a) }));
const trySend = vi.fn(async () => ({ sent: true }));
vi.mock("../../utils/toolNotify", () => ({ trySend: (...a: any[]) => trySend(...a) }));
// The gate would block an ACCEPT on a pending row — a keep must never reach it.
const checkCaregiverAccess = vi.fn(async () => ({ ok: false, block: "membership", caregiver: {} }));
vi.mock("../../agents/caregiverAccessGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/caregiverAccessGate")>()),
  checkCaregiverAccess: (...a: any[]) => checkCaregiverAccess(...a),
  textCaregiverGateBlock: vi.fn(async () => {}),
  findCaregiverSession: vi.fn(async () => null),
}));

import { handleToolCall, MCP_TOOLS } from "../server";

const CG = "cg_1";
const FAM = "client_1";
const IV = "iv_1";
const KEPT = { reschedulePendingTime: { __delete: true }, rescheduledBy: { __delete: true }, rescheduledViaAgent: { __delete: true }, updatedAt: { __serverTimestamp: true } };
const base = { caregiverId: CG, clientId: FAM, clientName: "The Nguyen Family", caregiverName: "Alice Mahad", status: "requested", scheduledTime: "2099-10-05T18:00:00.000Z" };

beforeEach(() => { hoisted.reset(); sendToPhone.mockClear(); trySend.mockClear(); checkCaregiverAccess.mockClear(); });

describe("accept_interview_reschedule action:'keep'", () => {
  it("the tool offers action accept | keep", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "accept_interview_reschedule")!;
    expect((tool.input_schema as any).properties.action.enum).toEqual(["accept", "keep"]);
    expect(tool.description).toContain("Keep current time");
  });

  it("caregiver keep on the family's proposal: the shared write, not gated even on a pending row, no text of its own", async () => {
    hoisted.docState.set(`video_interviews/${IV}`, { ...base, reschedulePendingTime: "2099-10-06T19:00:00.000Z", rescheduledBy: "client", rescheduledViaAgent: true });
    const r = await handleToolCall("accept_interview_reschedule", { interviewId: IV, caregiverId: CG, action: "keep" }) as any;
    expect(r).toMatchObject({ success: true, kept: true, interviewId: IV, keptBy: "caregiver", scheduledTime: "2099-10-05T18:00:00.000Z", scheduledTimeLocal: "Monday, October 5 at 11:00 AM", notification: { sent: true, reason: "notification_trigger" } });
    expect(r.note).toContain("The Nguyen Family is being told by the site's own notification");
    expect(hoisted.updates).toEqual([{ path: `video_interviews/${IV}`, data: KEPT }]);
    expect(hoisted.docState.get(`video_interviews/${IV}`)).toEqual({ ...base, updatedAt: { __serverTimestamp: true } }); // status + scheduledTime untouched
    expect(checkCaregiverAccess).not.toHaveBeenCalled();
    expect(trySend).not.toHaveBeenCalled();
    expect(sendToPhone).not.toHaveBeenCalled();
  });

  it("family keep on the caregiver's proposal: the same write, keptBy client, the caregiver named in the note", async () => {
    hoisted.docState.set(`video_interviews/${IV}`, { ...base, status: "accepted", reschedulePendingTime: "2099-10-06T19:00:00.000Z", rescheduledBy: "caregiver" });
    const r = await handleToolCall("accept_interview_reschedule", { interviewId: IV, clientId: FAM, action: "keep" }) as any;
    expect(r).toMatchObject({ success: true, kept: true, keptBy: "client" });
    expect(r.note).toContain("Alice Mahad is being told");
    expect(hoisted.updates[0].data).toEqual(KEPT);
    expect(trySend).not.toHaveBeenCalled();
  });

  it("a bare 'keep it' right after the notice: no interviewId → the noticed interview on the session", async () => {
    hoisted.docState.set(`video_interviews/${IV}`, { ...base, reschedulePendingTime: "2099-10-06T19:00:00.000Z", rescheduledBy: "client" });
    hoisted.docState.set("agent_sessions/+15550001111", { lastNoticedInterviewId: IV });
    const r = await handleToolCall("accept_interview_reschedule", { caregiverId: CG, phone: "+15550001111", action: "keep" }) as any;
    expect(r).toMatchObject({ success: true, kept: true, interviewId: IV });
  });

  it("refuses your own proposal and a row with nothing pending — no write", async () => {
    hoisted.docState.set(`video_interviews/${IV}`, { ...base, reschedulePendingTime: "2099-10-06T19:00:00.000Z", rescheduledBy: "caregiver" });
    expect(await handleToolCall("accept_interview_reschedule", { interviewId: IV, caregiverId: CG, action: "keep" })).toMatchObject({ _toolError: true, code: "INVALID_INPUT" });
    hoisted.docState.set(`video_interviews/${IV}`, base);
    expect(await handleToolCall("accept_interview_reschedule", { interviewId: IV, caregiverId: CG, action: "keep" })).toMatchObject({ _toolError: true, code: "INVALID_INPUT" });
    expect(await handleToolCall("accept_interview_reschedule", { interviewId: IV, caregiverId: "someone_else", action: "keep" })).toMatchObject({ _toolError: true, code: "PERMISSION_DENIED" });
    expect(hoisted.updates).toHaveLength(0);
  });

  it("without action (or action:'accept') it is still Accept new time — the time moves and a pending caregiver row is gated", async () => {
    hoisted.docState.set(`video_interviews/${IV}`, { ...base, reschedulePendingTime: "2099-10-06T19:00:00.000Z", rescheduledBy: "client" });
    const r = await handleToolCall("accept_interview_reschedule", { interviewId: IV, caregiverId: CG }) as any;
    expect(r).toMatchObject({ _toolError: true, code: "MEMBERSHIP_REQUIRED" });
    expect(checkCaregiverAccess).toHaveBeenCalledTimes(1);
    expect(hoisted.updates).toHaveLength(0);
  });
});
