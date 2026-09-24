import { describe, it, expect, vi, beforeEach } from "vitest";

// interviewFlow.ts (built 2026-09-13) is the scripted, step-by-step
// interview-scheduling flow that replaced ad hoc schedule_interview
// collection inside the general qaAgent loop — see the module's own header
// comment for the live-SMS incident that prompted it (a mid-flow "can you
// link to a job post" question misfired the intent classifier into
// jobPostingFlow.ts entirely, with no way back). These tests exercise the
// step machine directly, the same way bookingFlow.test.ts exercises
// bookingFlow.ts — including the new "back out at any step" capability this
// flow was built with from the start (bookingFlow.ts only got a cancel at
// its final confirm step).

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const queryState = new Map<string, any[]>(); // collection path -> array of {id, data}

  const resolveSentinels = (cur: Record<string, any>, k: string, v: any) => {
    if (v && typeof v === "object" && (v as any).__delete) { delete cur[k]; return; }
    cur[k] = v;
  };

  const makeDocRef = (collName: string, id: string): any => {
    const path = `${collName}/${id}`;
    return {
      id,
      get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
      set: vi.fn(async (data: any, opts?: any) => {
        const base = opts?.merge ? { ...(docState.get(path) ?? {}) } : {};
        for (const [k, v] of Object.entries(data)) resolveSentinels(base, k, v);
        docState.set(path, base);
      }),
      update: vi.fn(async (data: any) => {
        const cur = { ...(docState.get(path) ?? {}) };
        for (const [k, v] of Object.entries(data)) resolveSentinels(cur, k, v);
        docState.set(path, cur);
      }),
    };
  };

  const makeQuery = (collName: string): any => ({
    where:   () => makeQuery(collName),
    orderBy: () => makeQuery(collName),
    limit:   () => makeQuery(collName),
    get: vi.fn(async () => {
      const items = queryState.get(collName) ?? [];
      return { docs: items.map((it) => ({ id: it.id, data: () => it.data })) };
    }),
  });

  const makeCollRef = (collName: string): any => ({
    doc: (id: string) => makeDocRef(collName, id),
    where:   () => makeQuery(collName),
    orderBy: () => makeQuery(collName),
    limit:   () => makeQuery(collName),
  });

  return {
    docState, queryState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); queryState.clear(); },
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: () => ({ __delete: true }) },
    FieldPath: { documentId: () => "__name__" },
  });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});

const sendMessage = vi.fn(async (..._a: unknown[]) => ({ message_id: "m1" }));
vi.mock("../../linq/client", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
const generateCaraMessageMock = vi.fn(async (opts: any) => opts.fallback ?? "msg");
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: (...a: unknown[]) => (generateCaraMessageMock as any)(...a) }));
vi.mock("../../safety/outputGuard", () => ({ guardModelOutput: () => ({ ok: true }) }));
vi.mock("../../config/featureFlags", () => ({ caraOutputGuardEnabled: () => true }));

const messagesCreate = vi.fn();
vi.mock("../../utils/claudeClient", () => ({
  getSharedClient: () => ({ messages: { create: (...a: unknown[]) => messagesCreate(...a) } }),
}));

// isBackOutRequest (stepHandler.ts) routes through utils/parseWithClaude ->
// utils/openaiClient's quickComplete — a DIFFERENT path than this flow's own
// local parseWithClaude (which hits getSharedClient directly). Defaults to
// "NO" so normal step logic runs; individual tests override to "YES".
const quickCompleteMock = vi.fn(async (..._args: any[]) => "NO");
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => quickCompleteMock(...a) }));

const resolveCaregiverForInterviewMock = vi.fn(async (...args: any[]) => ({
  resolvedCaregiverId: args[0], caregiverName: "Basra Yousuf", caregiverPhoto: undefined,
}));
const requestVideoInterviewMock = vi.fn(async (...args: any[]) => {
  const params = args[0];
  return {
    id: "iv-new", clientId: params.clientId, caregiverId: params.caregiverId, clientName: "A Family",
    caregiverName: "Basra Yousuf", scheduledTime: params.scheduledTime, status: "requested" as const,
    createdAt: "2026-09-16T00:00:00.000Z", notes: params.notes ?? "", interviewType: "video",
    jobId: params.jobId, jobTitle: params.jobTitle,
  };
});
// vi.mock factories are hoisted above the whole file, so a plain top-level
// class declaration referenced inside one throws "Cannot access before
// initialization" — define it inside vi.hoisted() instead, same reason
// docState/queryState live there above.
const { VideoInterviewRequestError } = vi.hoisted(() => {
  class VideoInterviewRequestError extends Error {
    code: string;
    candidates?: any[];
    constructor(code: string, message: string, candidates?: any[]) {
      super(message);
      this.code = code;
      this.candidates = candidates;
    }
  }
  return { VideoInterviewRequestError };
});
vi.mock("../videoInterviewRequest", () => ({
  resolveCaregiverForInterview: (...a: any[]) => resolveCaregiverForInterviewMock(...a),
  requestVideoInterview: (...a: any[]) => requestVideoInterviewMock(...a),
  VideoInterviewRequestError,
}));

const resolveCommitmentMock = vi.fn(async (..._args: any[]) => {});
vi.mock("../commitmentTracker", () => ({ resolveCommitment: (...a: any[]) => resolveCommitmentMock(...a) }));
vi.mock("../onboardingConversation", () => ({ sendOnboardingLink: vi.fn(async () => ({ success: true })) }));

import { startInterviewFlow, handleInterviewFlowStep, buildInterviewRecap } from "../interviewFlow";

const PHONE = "+15551234567";
const CHAT  = "chat-1";
const UID   = "client-uid";
const CG_ID = "cg-1";

function session(overrides: Record<string, unknown> = {}): any {
  return { phone: PHONE, chatId: CHAT, userId: UID, userType: "client", ...overrides };
}

function modelReplies(...texts: string[]) {
  for (const text of texts) messagesCreate.mockResolvedValueOnce({ content: [{ text }] });
}

function seedOpenJobs(jobs: Array<{ id: string; title?: string; summary?: string; careTypes?: string[] }>) {
  hoisted.queryState.set("job_posts", jobs.map((j) => ({
    id: j.id, data: { title: j.title, summary: j.summary, careTypes: j.careTypes, clientId: UID, status: "open" },
  })));
}

beforeEach(() => {
  hoisted.reset();
  hoisted.docState.set(`users/${UID}`, { identityCheckStatus: "verified", membershipStatus: "active" });
  sendMessage.mockClear();
  messagesCreate.mockReset();
  quickCompleteMock.mockReset();
  quickCompleteMock.mockResolvedValue("NO");
  resolveCaregiverForInterviewMock.mockClear();
  resolveCaregiverForInterviewMock.mockResolvedValue({ resolvedCaregiverId: CG_ID, caregiverName: "Basra Yousuf", caregiverPhoto: undefined });
  requestVideoInterviewMock.mockClear();
  resolveCommitmentMock.mockClear();
});

describe("startInterviewFlow", () => {
  it("is gated like the site's Request Interview button: a lapsed membership gets the plan text and no flow starts", async () => {
    hoisted.docState.set(`users/${UID}`, { identityCheckStatus: "verified" });
    const res = await startInterviewFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
    expect(res).toEqual({ started: false, reason: "gated" });
    expect(sendMessage.mock.calls.map((c: any[]) => (typeof c[1] === "string" ? c[1] : JSON.stringify(c[1]))).join(" ")).toMatch(/Select a plan/);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)?.interviewFlowStep).toBeUndefined();
  });

  it("skips straight to the date question when the client has no open job posts", async () => {
    const res = await startInterviewFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
    expect(res.started).toBe(true);
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.interviewFlowStep).toBe("iv_ask_date");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("What day would you like the interview");
  });

  it("asks a numbered job-post pick when open posts exist, with 'No specific post' as the last option", async () => {
    seedOpenJobs([{ id: "job1", title: "Senior care in San Jose" }, { id: "job2", summary: "Fallback summary" }]);
    await startInterviewFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.interviewFlowStep).toBe("iv_ask_job");
    const msg = String(sendMessage.mock.calls.at(-1)![1]);
    expect(msg).toContain("1) Senior care in San Jose");
    expect(msg).toContain("2) Fallback summary");
    expect(msg).toContain("3) No specific post");
  });

  it("auto-links the job from applicationId and skips iv_ask_job entirely", async () => {
    hoisted.docState.set("job_applications/app1", { jobId: "job1" });
    hoisted.docState.set("job_posts/job1", { title: "Senior care in San Jose" });
    seedOpenJobs([{ id: "job1", title: "Senior care in San Jose" }]); // even with open posts on file
    await startInterviewFlow(PHONE, CHAT, session(), { caregiverId: CG_ID, applicationId: "app1" });
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.interviewFlowStep).toBe("iv_ask_date");
    expect(stored.interviewFlowData.jobId).toBe("job1");
    expect(stored.interviewFlowData.jobTitle).toBe("Senior care in San Jose");
    expect(stored.interviewFlowData.applicationId).toBe("app1");
  });

  it("fails cleanly when the caregiver can't be resolved", async () => {
    resolveCaregiverForInterviewMock.mockRejectedValueOnce(new VideoInterviewRequestError("failed-precondition", "Caregiver is not available for interviews"));
    const res = await startInterviewFlow(PHONE, CHAT, session(), { caregiverId: "bad-id" });
    expect(res.started).toBe(false);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toBeUndefined();
  });
});

describe("handleInterviewFlowStep — happy path through every step", () => {
  it("job pick -> date -> time -> notes -> confirm recap", async () => {
    seedOpenJobs([{ id: "job1", title: "Senior care in San Jose" }]);
    await startInterviewFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });

    // iv_ask_job: pick option 1 — each step queues an isQuestionOrOther
    // reply ("NO" = this is an answer, not an off-topic question) FIRST,
    // then the actual extraction reply, matching bookingFlow.test.ts's
    // convention (both are separate parseWithClaude calls).
    modelReplies("NO", '{"index": 1}');
    await handleInterviewFlowStep(PHONE, CHAT, "the first one", session({ interviewFlowStep: "iv_ask_job" }));
    let stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.interviewFlowData.jobId).toBe("job1");
    expect(stored.interviewFlowStep).toBe("iv_ask_date");

    // iv_ask_date
    // A date in the future relative to any test run — the flow rejects past dates (this fixture rolled into the past on 2026-09-21).
    modelReplies("NO", '{"date": "2099-09-20"}');
    await handleInterviewFlowStep(PHONE, CHAT, "next Sunday", session({ interviewFlowStep: "iv_ask_date" }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.interviewFlowData.date).toBe("2099-09-20");
    expect(stored.interviewFlowStep).toBe("iv_ask_time");

    // iv_ask_time
    modelReplies("NO", '{"time": "14:00"}');
    await handleInterviewFlowStep(PHONE, CHAT, "2pm", session({ interviewFlowStep: "iv_ask_time" }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.interviewFlowData.time).toBe("14:00");
    expect(stored.interviewFlowStep).toBe("iv_ask_notes");

    // iv_ask_notes: skip
    modelReplies("NO", "SKIP");
    await handleInterviewFlowStep(PHONE, CHAT, "no thanks", session({ interviewFlowStep: "iv_ask_notes" }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.interviewFlowStep).toBe("iv_confirm");
    const recap = String(sendMessage.mock.calls.at(-1)![1]);
    expect(recap).toContain("Caregiver: Basra Yousuf");
    expect(recap).toContain("Related job post: Senior care in San Jose");
    expect(recap).toContain("Date & time: September 20, 2099 at 2:00 PM");
    expect(recap).toContain("Notes: None");
  });

  it("re-asks on an unparseable date rather than silently defaulting", async () => {
    await startInterviewFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
    modelReplies("NO", '{"date": null}');
    await handleInterviewFlowStep(PHONE, CHAT, "sometime", session({ interviewFlowStep: "iv_ask_date" }));
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.interviewFlowStep).toBe("iv_ask_date");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("didn't quite catch that");
  });

  it("takes the given note when the family provides one instead of skipping", async () => {
    await startInterviewFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
    await hoisted.docState.set(`agent_sessions/${PHONE}`, {
      ...hoisted.docState.get(`agent_sessions/${PHONE}`), interviewFlowData: { caregiverId: CG_ID, caregiverName: "Basra Yousuf", date: "2026-09-20", time: "14:00" },
    });
    modelReplies("NO", "NOTE");
    await handleInterviewFlowStep(PHONE, CHAT, "please discuss meal prep experience", session({ interviewFlowStep: "iv_ask_notes" }));
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.interviewFlowData.notes).toBe("please discuss meal prep experience");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain('"please discuss meal prep experience"');
  });
});

describe("back-off — the new capability, checked at EVERY step", () => {
  const steps: Array<{ step: string; seed?: () => void }> = [
    { step: "iv_ask_job", seed: () => seedOpenJobs([{ id: "job1", title: "Senior care" }]) },
    { step: "iv_ask_date" },
    { step: "iv_ask_time" },
    { step: "iv_ask_notes" },
    { step: "iv_confirm" },
  ];

  for (const { step, seed } of steps) {
    it(`clears the flow and confirms nothing was sent when the family backs out at ${step}`, async () => {
      seed?.();
      await startInterviewFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
      quickCompleteMock.mockResolvedValueOnce("YES"); // isBackOutRequest -> true
      await handleInterviewFlowStep(PHONE, CHAT, "never mind, forget it", session({ interviewFlowStep: step }));
      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.interviewFlowStep).toBeUndefined();
      expect(stored.interviewFlowData).toBeUndefined();
      expect(requestVideoInterviewMock).not.toHaveBeenCalled();
      expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("nothing was sent");
    });
  }
});

describe("iv_confirm — edits", () => {
  async function seedAtConfirm(overrides: Record<string, unknown> = {}) {
    await startInterviewFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
    const existing = hoisted.docState.get(`agent_sessions/${PHONE}`);
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      ...existing,
      interviewFlowStep: "iv_confirm",
      interviewFlowData: { caregiverId: CG_ID, caregiverName: "Basra Yousuf", date: "2099-09-20", time: "14:00", ...overrides },
    });
  }

  it("edit_date applies a stated new date in place and re-shows the recap", async () => {
    await seedAtConfirm();
    modelReplies('{"action": "edit_date", "newDate": "2099-09-22", "newTime": null, "newNotes": null, "jobIndex": null}');
    await handleInterviewFlowStep(PHONE, CHAT, "actually make it the 22nd", session({ interviewFlowStep: "iv_confirm" }));
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.interviewFlowData.date).toBe("2099-09-22");
    expect(stored.interviewFlowStep).toBe("iv_confirm");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("September 22, 2099");
  });

  it("edit_notes with no stated text asks the follow-up question instead of the recap", async () => {
    await seedAtConfirm();
    modelReplies('{"action": "edit_notes", "newDate": null, "newTime": null, "newNotes": null, "jobIndex": null}');
    await handleInterviewFlowStep(PHONE, CHAT, "add a note", session({ interviewFlowStep: "iv_confirm" }));
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.interviewFlowStep).toBe("iv_ask_notes");
  });

  it("confirm (YES) calls requestVideoInterview with the collected fields, clears the flow, and confirms it was sent", async () => {
    await seedAtConfirm({ jobId: "job1", jobTitle: "Senior care in San Jose", notes: "discuss meal prep" });
    modelReplies('{"action": "confirm"}');
    await handleInterviewFlowStep(PHONE, CHAT, "yes send it", session({ interviewFlowStep: "iv_confirm" }));
    expect(requestVideoInterviewMock).toHaveBeenCalledWith(expect.objectContaining({
      clientId: UID, caregiverId: CG_ID, jobId: "job1", jobTitle: "Senior care in San Jose", notes: "discuss meal prep",
      source: "interviewFlow", phone: PHONE,
    }));
    expect(resolveCommitmentMock).toHaveBeenCalledWith(PHONE, "interview", "scheduled");
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.interviewFlowStep).toBeUndefined();
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("Sent to Basra Yousuf");
  });

  it("surfaces a friendly message on a daily-limit error without throwing", async () => {
    await seedAtConfirm();
    requestVideoInterviewMock.mockRejectedValueOnce(new VideoInterviewRequestError("resource-exhausted", "Daily interview request limit reached"));
    modelReplies('{"action": "confirm"}');
    await handleInterviewFlowStep(PHONE, CHAT, "yes", session({ interviewFlowStep: "iv_confirm" }));
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("limit");
  });
});

describe("buildInterviewRecap", () => {
  it("lists every section in order, matching the site's Request Interview modal", () => {
    const recap = buildInterviewRecap({
      caregiverId: CG_ID, caregiverName: "Basra Yousuf", jobTitle: "Senior care in San Jose",
      date: "2026-09-20", time: "14:00", notes: "discuss meal prep",
    });
    const order = ["Caregiver:", "Related job post:", "Date & time:", "Notes:"];
    let lastIdx = -1;
    for (const marker of order) {
      const idx = recap.indexOf(marker);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it("shows 'No specific post' when nothing is linked", () => {
    const recap = buildInterviewRecap({ caregiverId: CG_ID, caregiverName: "Basra Yousuf", date: "2026-09-20", time: "14:00" });
    expect(recap).toContain("Related job post: No specific post");
  });
});
