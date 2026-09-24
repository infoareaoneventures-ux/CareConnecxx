import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-08-30: the Care Requests page audit found Evia had no equivalent for
// the website's "Mark as Completed" button at all, and submit_interview_feedback's
// "no" branch didn't actually decline the interview or write hire_decisions the
// way the website's "Not Selected" button does (PostsPage.tsx's handleDecision).
// These tests lock in the fix.

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  // Collection-level fixtures for a where().limit().get() query — keyed by
  // collection path, id ignored (these tests only ever seed one relevant doc
  // per collection, e.g. one agent_sessions doc for the responding client).
  const collState = new Map<string, Array<{ id: string; data: any }>>();
  const adds:    Array<{ path: string; data: any }> = [];
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path), ref: makeDocRef(path) })),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      const prev = docState.get(path) ?? {};
      docState.set(path, { ...prev, ...data });
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
    add: vi.fn(async (data: any) => { adds.push({ path, data }); return makeDocRef(`${path}/auto`); }),
  });

  return {
    docState, collState, adds, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); adds.length = 0; updates.length = 0; },
  };
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
vi.mock("../../linq/client", () => ({ sendToPhone: vi.fn().mockResolvedValue(undefined) }));

import { handleToolCall } from "../server";
import { sendToPhone } from "../../linq/client";

const CLIENT = "client_1";
const IV_ID = "iv_1";

describe("complete_interview", () => {
  beforeEach(() => hoisted.reset());

  it("marks a confirmed interview completed and clears any leftover reschedule proposal, like the site", async () => {
    hoisted.docState.set(`video_interviews/${IV_ID}`, { clientId: CLIENT, caregiverId: "cg1", status: "confirmed", reschedulePendingTime: "2026-09-20T16:00:00.000Z", rescheduledBy: "caregiver" });
    const r = await handleToolCall("complete_interview", { interviewId: IV_ID, clientId: CLIENT }) as any;
    expect(r.success).toBe(true);
    const update = hoisted.updates.find(u => u.path === `video_interviews/${IV_ID}`);
    expect(update?.data.status).toBe("completed");
    expect(update?.data.completedAt).toBeTruthy();
    expect(update?.data.reschedulePendingTime).toEqual({ __delete: true });
    expect(update?.data.rescheduledBy).toEqual({ __delete: true });
  });

  it("is a no-op if already completed", async () => {
    hoisted.docState.set(`video_interviews/${IV_ID}`, { clientId: CLIENT, caregiverId: "cg1", status: "completed" });
    const r = await handleToolCall("complete_interview", { interviewId: IV_ID, clientId: CLIENT }) as any;
    expect(r.success).toBe(true);
    expect(r.alreadyCompleted).toBe(true);
    expect(hoisted.updates.find(u => u.path === `video_interviews/${IV_ID}`)).toBeUndefined();
  });

  it("refuses to complete an interview that hasn't been confirmed yet", async () => {
    hoisted.docState.set(`video_interviews/${IV_ID}`, { clientId: CLIENT, caregiverId: "cg1", status: "requested" });
    const r = await handleToolCall("complete_interview", { interviewId: IV_ID, clientId: CLIENT }) as any;
    expect(r._toolError).toBe(true);
  });

  it("refuses when the interview belongs to a different client", async () => {
    hoisted.docState.set(`video_interviews/${IV_ID}`, { clientId: "other_client", caregiverId: "cg1", status: "confirmed" });
    const r = await handleToolCall("complete_interview", { interviewId: IV_ID, clientId: CLIENT }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
  });
});

describe("submit_interview_feedback", () => {
  beforeEach(() => hoisted.reset());

  it("'no' declines the interview and writes hire_decisions (matches the website's Not Selected)", async () => {
    hoisted.docState.set(`video_interviews/${IV_ID}`, {
      clientId: CLIENT, caregiverId: "cg1", clientName: "A Family", caregiverName: "Alice", status: "accepted",
    });
    const r = await handleToolCall("submit_interview_feedback", { interviewId: IV_ID, clientId: CLIENT, fitLevel: "no" }) as any;
    expect(r.success).toBe(true);
    const update = hoisted.updates.find(u => u.path === `video_interviews/${IV_ID}`);
    expect(update?.data.status).toBe("declined");
    expect(update?.data.declinedBy).toBe("client");
    const decision = hoisted.adds.find(a => a.path === "hire_decisions");
    expect(decision?.data).toMatchObject({ clientId: CLIENT, caregiverId: "cg1", decision: "decline" });
  });

  it("also marks the interview completed as part of any decision (one conversational turn instead of two site clicks)", async () => {
    hoisted.docState.set(`video_interviews/${IV_ID}`, {
      clientId: CLIENT, caregiverId: "cg1", clientName: "A Family", caregiverName: "Alice", status: "accepted",
    });
    await handleToolCall("submit_interview_feedback", { interviewId: IV_ID, clientId: CLIENT, fitLevel: "maybe" });
    const update = hoisted.updates.find(u => u.path === `video_interviews/${IV_ID}`);
    expect(update?.data.status).toBe("completed");
    expect(update?.data.completedAt).toBeTruthy();
  });

  // 2026-09-13: "strong" no longer creates a hire_requests doc (that
  // collection was removed entirely — it never led to a real booking, and
  // its dormant Firestore trigger would have bypassed booking_requests/
  // the booking flow if ever activated). Only hire_decisions (a record, not
  // a booking) is written; the actual booking is start_booking_flow, matching
  // the site's single pipeline. The caregiver is also NOT messaged at this
  // stage (confirmed against the site: its own "strong fit" step has no
  // caregiver-facing side effect at all — the caregiver only hears
  // something once the real booking_requests doc is written).
  it("'strong' creates a hire_decisions record, no hire_requests doc, and messages nobody", async () => {
    hoisted.docState.set(`video_interviews/${IV_ID}`, {
      clientId: CLIENT, caregiverId: "cg1", clientName: "A Family", caregiverName: "Alice", status: "accepted",
    });
    const r = await handleToolCall("submit_interview_feedback", { interviewId: IV_ID, clientId: CLIENT, fitLevel: "strong" }) as any;
    expect(r.success).toBe(true);
    expect(hoisted.adds.find(a => a.path === "hire_requests")).toBeUndefined();
    const decision = hoisted.adds.find(a => a.path === "hire_decisions");
    expect(decision?.data).toMatchObject({ decision: "hire" });
    expect(sendToPhone).not.toHaveBeenCalled();
  });

  it("does not overwrite an already-completed interview's completedAt", async () => {
    hoisted.docState.set(`video_interviews/${IV_ID}`, {
      clientId: CLIENT, caregiverId: "cg1", clientName: "A Family", caregiverName: "Alice",
      status: "completed", completedAt: "2026-08-01T00:00:00.000Z",
    });
    await handleToolCall("submit_interview_feedback", { interviewId: IV_ID, clientId: CLIENT, fitLevel: "no" });
    const update = hoisted.updates.find(u => u.path === `video_interviews/${IV_ID}`);
    expect(update?.data.completedAt).toBeUndefined();
  });

  // 2026-09-13: "maybe" used to permanently lock the interview out of ever
  // recording a real decision — feedbackSubmitted:true was stamped for ALL
  // three fitLevels alike, and this tool's own guard blocked any further call
  // once that flag was set, with no exception for a non-terminal "maybe".
  // interviewFeedbackNudge.ts already keeps re-asking after "maybe" (its own
  // terminal check is fitLevel === "strong" || "no"); this tool's guard now
  // matches that same terminal check so the eventual real answer isn't
  // rejected as "already submitted."
  it("lets a later 'strong' decision overwrite a prior 'maybe' (maybe is not terminal)", async () => {
    hoisted.docState.set(`video_interviews/${IV_ID}`, {
      clientId: CLIENT, caregiverId: "cg1", clientName: "A Family", caregiverName: "Alice",
      status: "completed", fitLevel: "maybe", feedbackSubmitted: true,
    });
    const r = await handleToolCall("submit_interview_feedback", { interviewId: IV_ID, clientId: CLIENT, fitLevel: "strong" }) as any;
    expect(r.success).toBe(true);
    const update = hoisted.updates.find(u => u.path === `video_interviews/${IV_ID}`);
    expect(update?.data.fitLevel).toBe("strong");
    const decision = hoisted.adds.find(a => a.path === "hire_decisions");
    expect(decision?.data).toMatchObject({ decision: "hire" });
  });

  it("still refuses a second decision once the prior one was terminal ('no')", async () => {
    hoisted.docState.set(`video_interviews/${IV_ID}`, {
      clientId: CLIENT, caregiverId: "cg1", clientName: "A Family", caregiverName: "Alice",
      status: "declined", fitLevel: "no", feedbackSubmitted: true,
    });
    const r = await handleToolCall("submit_interview_feedback", { interviewId: IV_ID, clientId: CLIENT, fitLevel: "strong" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
  });
});

describe("respond_to_interview_request", () => {
  beforeEach(() => {
    hoisted.reset();
    vi.mocked(sendToPhone).mockClear();
    hoisted.docState.set(`video_interviews/${IV_ID}`, {
      clientId: CLIENT, caregiverId: "cg1", clientName: "A Family", caregiverName: "Alice", status: "requested",
    });
    hoisted.docState.set("caregivers/cg1", { name: "Alice" });
    // agent_sessions are phone-keyed — the handler reads clientSess.docs[0].id as the phone.
    hoisted.collState.set("agent_sessions", [{ id: "+15551234567", data: { userId: CLIENT } }]);
  });

  // 2026-09-06 fix: this used to write "confirmed", not "accepted" — the
  // website's own accept action (videoService.ts's acceptInterview) writes
  // "accepted", and onVideoInterviewWrite's client in-app-notification
  // branch only checks for that exact string, so a caregiver accepting via
  // Evia silently never produced the dashboard notification a website-side
  // accept would have (the SMS text below still went out either way, which
  // is why this went unnoticed).
  it("accept writes status 'accepted' (matches the website's own accept action, not 'confirmed')", async () => {
    const r = await handleToolCall("respond_to_interview_request", {
      caregiverId: "cg1", interviewId: IV_ID, decision: "accept",
    }) as any;
    expect(r.success).toBe(true);
    const update = hoisted.updates.find(u => u.path === `video_interviews/${IV_ID}`);
    expect(update?.data.status).toBe("accepted");
  });

  it("accept sends no text of its own — the Meet-link message (interviewLinkTrigger) is the family's one text", async () => {
    await handleToolCall("respond_to_interview_request", {
      caregiverId: "cg1", interviewId: IV_ID, decision: "accept",
    });
    expect(sendToPhone).not.toHaveBeenCalledWith("+15551234567", expect.anything());
  });

  it("decline writes status 'declined' and notifies the client", async () => {
    const r = await handleToolCall("respond_to_interview_request", {
      caregiverId: "cg1", interviewId: IV_ID, decision: "decline",
    }) as any;
    expect(r.success).toBe(true);
    const update = hoisted.updates.find(u => u.path === `video_interviews/${IV_ID}`);
    expect(update?.data.status).toBe("declined");
    expect(sendToPhone).toHaveBeenCalledWith("+15551234567", expect.stringContaining("isn't available"));
  });

  // 2026-09-06 fix: onVideoInterviewWrite's decline branch (notificationTriggers.ts)
  // checks this flag to skip its own text — this tool already sent one above —
  // so a decline routed through Evia doesn't double-text the client.
  it("stamps respondedViaAgent so the Firestore trigger doesn't send a duplicate decline text", async () => {
    await handleToolCall("respond_to_interview_request", {
      caregiverId: "cg1", interviewId: IV_ID, decision: "decline",
    });
    const update = hoisted.updates.find(u => u.path === `video_interviews/${IV_ID}`);
    expect(update?.data.respondedViaAgent).toBe(true);
  });

  it("refuses when the interview doesn't belong to this caregiver", async () => {
    const r = await handleToolCall("respond_to_interview_request", {
      caregiverId: "someone_else", interviewId: IV_ID, decision: "accept",
    }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
  });
});
