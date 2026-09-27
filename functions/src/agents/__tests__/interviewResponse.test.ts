import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-09-06: respondToInterviewRequest is the shared function behind BOTH
// Evia's respond_to_interview_request MCP tool (server.ts) and the website's
// new interview_action_requests trigger queue (interviewActionQueue.ts) — see
// the comment at the top of interviewResponse.ts. The MCP tool's own path is
// already covered end-to-end in mcp/__tests__/interviewOutcomes.test.ts; these
// tests exercise the shared function directly, including the counter-proposal
// path the website adds (declining with a proposed alternate time), which the
// MCP suite doesn't cover.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const collState = new Map<string, Array<{ id: string; data: any }>>();
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      const prev = docState.get(path) ?? {};
      docState.set(path, { ...prev, ...data });
    }),
    set: vi.fn(async (data: any) => {
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
  });

  return {
    docState, collState, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: () => ({ __delete: true }), serverTimestamp: () => ({ __serverTimestamp: true }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});

vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../linq/client", () => ({ sendToPhone: vi.fn().mockResolvedValue(undefined) }));

import { respondToInterviewRequest, InterviewResponseError } from "../interviewResponse";
import { sendToPhone } from "../../linq/client";
import { logAudit } from "../../observability/auditLog";

const CLIENT = "client_1";
const CAREGIVER = "cg1";
const IV_ID = "iv_1";

beforeEach(() => {
  hoisted.reset();
  vi.mocked(sendToPhone).mockClear();
  vi.mocked(logAudit).mockClear();
  hoisted.docState.set(`video_interviews/${IV_ID}`, {
    clientId: CLIENT, caregiverId: CAREGIVER, status: "requested", scheduledTime: new Date().toISOString(),
  });
  hoisted.docState.set(`caregivers/${CAREGIVER}`, { name: "Alice" });
  hoisted.collState.set("agent_sessions", [{ id: "+15551234567", data: { userId: CLIENT } }]);
});

describe("respondToInterviewRequest", () => {
  it("throws not-found for a missing interview", async () => {
    await expect(
      respondToInterviewRequest({ caregiverId: CAREGIVER, interviewId: "nope", decision: "accept", source: "web" }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("throws permission-denied when the interview belongs to a different caregiver", async () => {
    await expect(
      respondToInterviewRequest({ caregiverId: "someone_else", interviewId: IV_ID, decision: "accept", source: "web" }),
    ).rejects.toBeInstanceOf(InterviewResponseError);
    await expect(
      respondToInterviewRequest({ caregiverId: "someone_else", interviewId: IV_ID, decision: "accept", source: "web" }),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("accept writes status 'accepted' and sends NO text of its own (the Meet-link message from interviewLinkTrigger is the family's one text)", async () => {
    const r = await respondToInterviewRequest({ caregiverId: CAREGIVER, interviewId: IV_ID, decision: "accept", source: "web" });
    expect(r.status).toBe("accepted");
    const update = hoisted.updates.find(u => u.path === `video_interviews/${IV_ID}`);
    expect(update?.data.status).toBe("accepted");
    expect(sendToPhone).not.toHaveBeenCalled();
  });

  // 2026-09-27: the Interviews tab's Decline write, field for field — status +
  // updatedAt, proposal fields cleared; the family's bell + text come from
  // onVideoInterviewWrite (no own text, no respondedViaAgent flag).
  it("decline writes the site's exact patch and sends nothing itself", async () => {
    hoisted.docState.set(`video_interviews/${IV_ID}`, { ...hoisted.docState.get(`video_interviews/${IV_ID}`), reschedulePendingTime: "2026-10-01T21:00:00.000Z", rescheduledBy: "client" });
    const r = await respondToInterviewRequest({ caregiverId: CAREGIVER, interviewId: IV_ID, decision: "decline", source: "web" });
    expect(r.status).toBe("declined");
    const update = hoisted.updates.find(u => u.path === `video_interviews/${IV_ID}`);
    expect(update?.data.status).toBe("declined");
    expect(update?.data.updatedAt).toBeDefined();
    expect(update?.data.reschedulePendingTime).toEqual({ __delete: true });
    expect(update?.data.rescheduledBy).toEqual({ __delete: true });
    expect(update?.data.respondedViaAgent).toBeUndefined();
    expect(update?.data.proposedTime).toBeUndefined();
    expect(sendToPhone).not.toHaveBeenCalled();
  });

  it("only a PENDING request can be accepted or declined — an accepted one says to cancel / reschedule, a terminal one refuses", async () => {
    hoisted.docState.set(`video_interviews/${IV_ID}`, { ...hoisted.docState.get(`video_interviews/${IV_ID}`), status: "accepted" });
    await expect(respondToInterviewRequest({ caregiverId: CAREGIVER, interviewId: IV_ID, decision: "decline", source: "web" }))
      .rejects.toMatchObject({ code: "invalid-argument", message: expect.stringContaining("cancel") });
    hoisted.docState.set(`video_interviews/${IV_ID}`, { ...hoisted.docState.get(`video_interviews/${IV_ID}`), status: "completed" });
    await expect(respondToInterviewRequest({ caregiverId: CAREGIVER, interviewId: IV_ID, decision: "accept", source: "web" }))
      .rejects.toMatchObject({ code: "invalid-argument" });
    expect(hoisted.updates.find(u => u.path === `video_interviews/${IV_ID}`)).toBeUndefined();
  });

  it("accept while the family's new time is pending points to Accept new time instead", async () => {
    hoisted.docState.set(`video_interviews/${IV_ID}`, { ...hoisted.docState.get(`video_interviews/${IV_ID}`), reschedulePendingTime: "2026-10-01T21:00:00.000Z", rescheduledBy: "client" });
    await expect(respondToInterviewRequest({ caregiverId: CAREGIVER, interviewId: IV_ID, decision: "accept", source: "web" }))
      .rejects.toMatchObject({ code: "invalid-argument", message: expect.stringContaining("accept_interview_reschedule") });
  });

  it("logs the audit event with the given source", async () => {
    await respondToInterviewRequest({ caregiverId: CAREGIVER, interviewId: IV_ID, decision: "accept", source: "web" });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "interview_responded",
      userId: CAREGIVER,
      data: expect.objectContaining({ source: "web", interviewId: IV_ID, decision: "accept" }),
    }));
  });

  it("accept writes the site's exact patch: status + updatedAt only", async () => {
    await respondToInterviewRequest({ caregiverId: CAREGIVER, interviewId: IV_ID, decision: "accept", source: "web" });
    const update = hoisted.updates.find(u => u.path === `video_interviews/${IV_ID}`);
    expect(Object.keys(update?.data ?? {}).sort()).toEqual(["status", "updatedAt"]);
  });
});
