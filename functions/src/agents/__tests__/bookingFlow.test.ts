import { describe, it, expect, vi, beforeEach } from "vitest";

// bookingFlow.ts (built 2026-09-13) is the scripted, step-by-step booking
// flow that replaced ad hoc request_booking collection inside the general
// qaAgent loop — see the module's own header comment for the live-SMS
// incident that prompted it. These tests exercise the step machine directly,
// the same way jobPostingWhoWhere.test.ts exercises jobPostingFlow.ts.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();

  const resolveSentinels = (cur: Record<string, any>, k: string, v: any) => {
    if (v && typeof v === "object" && (v as any).__delete) { delete cur[k]; return; }
    cur[k] = v;
  };

  const makeDocRef = (collName: string, id: string): any => {
    const path = `${collName}/${id}`;
    return {
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

  // Minimal query support (just enough for findSendBookingEligibleInterviews's
  // .where(...).where(...).get() chains) — filters docState by exact-match
  // "==" conditions only, since that's all these tests need.
  const makeQuery = (collName: string, conditions: Array<[string, string, any]>): any => ({
    where: (field: string, op: string, value: any) => makeQuery(collName, [...conditions, [field, op, value]]),
    get: async () => {
      const prefix = `${collName}/`;
      const docs = [...docState.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .filter(([, data]) => conditions.every(([f, , v]) => (data as any)?.[f] === v))
        .map(([path, data]) => ({ id: path.slice(prefix.length), data: () => data }));
      return { empty: docs.length === 0, docs, size: docs.length };
    },
  });

  const makeCollRef = (collName: string): any => ({
    doc: (id: string) => makeDocRef(collName, id),
    where: (field: string, op: string, value: any) => makeQuery(collName, [[field, op, value]]),
  });

  return {
    docState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => docState.clear(),
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: () => ({ __delete: true }) },
  });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});

const sendMessage = vi.fn(async (..._a: unknown[]) => ({ message_id: "m1" }));
vi.mock("../../linq/client", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
const generateCaraMessageMock = vi.fn(async (opts: any) => opts.fallback ?? "msg");
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: (...a: unknown[]) => (generateCaraMessageMock as any)(...a) }));
vi.mock("../../safety/outputGuard", () => ({
  guardModelOutput: () => ({ ok: true }),
  ANTI_INVENTION_CLAUSE: "ANTI_INVENTION",
}));
vi.mock("../../config/featureFlags", () => ({
  caraOutputGuardEnabled: () => true,
  multiRecipientScopingEnabled: () => true,
}));
const messagesCreate = vi.fn();
vi.mock("../../utils/claudeClient", () => ({
  getSharedClient: () => ({ messages: { create: (...a: unknown[]) => messagesCreate(...a) } }),
}));
const createBookingTask = vi.fn(async (_params: any) => "task-1");
const executeBookings   = vi.fn(async (_taskId: string, _phone: string) => {});
vi.mock("../bookingExecutor", () => ({
  createBookingTask: (params: unknown) => createBookingTask(params),
  executeBookings:   (taskId: string, phone: string) => executeBookings(taskId, phone),
}));

import { startBookingFlow, handleBookingFlowStep, buildBookingRecap } from "../bookingFlow";

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

function seedCaregiver() {
  hoisted.docState.set(`caregivers/${CG_ID}`, { name: "Basra Yousuf" });
}

// Every real booking traces back to a completed interview (site parity,
// 2026-09-14 — the site itself never shows "Send Booking" without one).
// Tests that aren't specifically about interview disambiguation just need
// exactly one eligible interview on file so startBookingFlow auto-links
// past that gate silently, the same as any other single-eligible case.
function seedOneEligibleInterview(id = "iv-default") {
  hoisted.docState.set(`video_interviews/${id}`, {
    clientId: UID, caregiverId: CG_ID, status: "completed",
    scheduledTime: "2026-09-01T09:00:00.000Z",
  });
}

beforeEach(() => {
  hoisted.reset();
  sendMessage.mockClear();
  messagesCreate.mockReset();
  createBookingTask.mockClear();
  createBookingTask.mockResolvedValue("task-1");
  executeBookings.mockClear();
  executeBookings.mockResolvedValue(undefined);
  seedCaregiver();
});

describe("startBookingFlow", () => {
  it("asks for the rate when no job post rate is known", async () => {
    seedOneEligibleInterview();
    await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_rate");
    expect(sendMessage.mock.calls.map((c: any[]) => c[1]).join(" | ")).toContain("agreed hourly rate");
  });

  it("always asks the rate explicitly even when a linked job post has one — matching the site's own Required field — but offers it as a suggestion", async () => {
    hoisted.docState.set("video_interviews/iv1", { clientId: UID, caregiverId: CG_ID, applicationId: "app1" });
    hoisted.docState.set("job_applications/app1", { jobId: "job1" });
    hoisted.docState.set("job_posts/job1", { title: "Care", rate: "25" });

    await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID, interviewId: "iv1" });

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowData.hourlyRate).toBeUndefined();
    expect(stored.bookingFlowData.jobPostRate).toBe(25);
    expect(stored.bookingFlowStep).toBe("bk_ask_rate");
    const lastMsg = String(sendMessage.mock.calls.at(-1)![1]);
    expect(lastMsg).toContain("agreed hourly rate");
    expect(lastMsg).toContain("$25/hr");
  });

  // 2026-09-14 (live-caught): a booking sent with no interviewId at all left
  // the family with no way to tell which interview it followed, and the
  // site's other "Send Booking" rows for the same caregiver stayed active —
  // risking an accidental duplicate. Matches the site's own per-row "Send
  // Booking" — see findSendBookingEligibleInterviews.
  describe("interview disambiguation when no interviewId is given", () => {
    it("asks which interview when 2+ are eligible (completed, not declined, not already booked)", async () => {
      hoisted.docState.set("video_interviews/iv1", {
        clientId: UID, caregiverId: CG_ID, status: "completed", applicationId: "app1",
        scheduledTime: "2026-09-13T09:00:00.000Z",
      });
      hoisted.docState.set("video_interviews/iv2", {
        clientId: UID, caregiverId: CG_ID, status: "completed",
        scheduledTime: "2026-09-12T21:10:00.000Z",
      });
      hoisted.docState.set("job_applications/app1", { jobId: "job1" });
      hoisted.docState.set("job_posts/job1", { title: "Senior care in San Jose" });

      await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.bookingFlowStep).toBe("bk_ask_interview");
      expect(stored.bookingFlowData.interviewOptions).toHaveLength(2);
      const lastMsg = String(sendMessage.mock.calls.at(-1)![1]);
      expect(lastMsg).toContain("Which interview is this booking for?");
      expect(lastMsg).toContain("1. Basra Yousuf — Senior care in San Jose");
      expect(lastMsg).toContain("2. Basra Yousuf (");
    });

    // 2026-09-14 (live-caught): rendering scheduledTime with no timeZone
    // option shows whatever zone Cloud Functions happens to run in (UTC) —
    // a real 9:00 AM Pacific interview texted back as "4:00 PM", and a 9:10
    // PM Pacific one both mislabeled AND shifted to the wrong calendar day
    // ("Sep 13, 4:10 AM" instead of "Sep 12, 9:10 PM"). Pins the fix:
    // Pacific time, matching every other interview-time display in the app.
    it("renders each option in Pacific time, not the server's UTC clock", async () => {
      hoisted.docState.set("video_interviews/iv1", {
        clientId: UID, caregiverId: CG_ID, status: "completed",
        scheduledTime: "2026-09-13T16:00:00.000Z", // 9:00 AM Pacific (PDT, UTC-7)
      });
      hoisted.docState.set("video_interviews/iv2", {
        clientId: UID, caregiverId: CG_ID, status: "completed",
        scheduledTime: "2026-09-13T04:10:00.000Z", // 9:10 PM Pacific the PRIOR day
      });

      await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });

      const lastMsg = String(sendMessage.mock.calls.at(-1)![1]);
      expect(lastMsg).toContain("Sep 13, 9:00 AM");
      expect(lastMsg).toContain("Sep 12, 9:10 PM");
      expect(lastMsg).not.toContain("4:00 PM");
      expect(lastMsg).not.toContain("4:10 AM");
    });

    it("picking one by number links its job post and advances to the rate question", async () => {
      hoisted.docState.set("video_interviews/iv1", {
        clientId: UID, caregiverId: CG_ID, status: "completed", applicationId: "app1",
        scheduledTime: "2026-09-13T09:00:00.000Z",
      });
      hoisted.docState.set("video_interviews/iv2", {
        clientId: UID, caregiverId: CG_ID, status: "completed",
        scheduledTime: "2026-09-12T21:10:00.000Z",
      });
      hoisted.docState.set("job_applications/app1", { jobId: "job1" });
      hoisted.docState.set("job_posts/job1", { title: "Senior care in San Jose", rate: "25" });

      await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
      modelReplies("NO", "1");
      await handleBookingFlowStep(PHONE, CHAT, "1", session({ bookingFlowStep: "bk_ask_interview" }));

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.bookingFlowStep).toBe("bk_ask_rate");
      expect(stored.bookingFlowData.interviewId).toBe("iv1");
      expect(stored.bookingFlowData.jobId).toBe("job1");
      expect(stored.bookingFlowData.jobTitle).toBe("Senior care in San Jose");
    });

    // 2026-09-14 (live): a bare "1" to the 2-option picker came back "didn't
    // catch that" — the router model misread it. A bare in-range number is a
    // strict-protocol reply; it must resolve with NO model call at all.
    it("a bare number picks the interview directly, skipping every model call", async () => {
      hoisted.docState.set("video_interviews/iv1", {
        clientId: UID, caregiverId: CG_ID, status: "completed", applicationId: "app1",
        scheduledTime: "2026-09-13T09:00:00.000Z",
      });
      hoisted.docState.set("video_interviews/iv2", {
        clientId: UID, caregiverId: CG_ID, status: "completed",
        scheduledTime: "2026-09-12T21:10:00.000Z",
      });
      hoisted.docState.set("job_applications/app1", { jobId: "job1" });
      hoisted.docState.set("job_posts/job1", { title: "Senior care in San Jose", rate: "25" });

      await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
      messagesCreate.mockClear();
      // No modelReplies queued — any model call here would fail the pick.
      await handleBookingFlowStep(PHONE, CHAT, "1", session({ bookingFlowStep: "bk_ask_interview" }));

      expect(messagesCreate).not.toHaveBeenCalled();
      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.bookingFlowStep).toBe("bk_ask_rate");
      expect(stored.bookingFlowData.interviewId).toBe("iv1");
    });

    it("an out-of-range bare number still falls through to the model path", async () => {
      hoisted.docState.set("video_interviews/iv1", {
        clientId: UID, caregiverId: CG_ID, status: "completed", scheduledTime: "2026-09-13T09:00:00.000Z",
      });
      hoisted.docState.set("video_interviews/iv2", {
        clientId: UID, caregiverId: CG_ID, status: "completed", scheduledTime: "2026-09-12T21:10:00.000Z",
      });
      await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
      messagesCreate.mockClear();
      modelReplies("NO", "NO", "0");
      await handleBookingFlowStep(PHONE, CHAT, "7", session({ bookingFlowStep: "bk_ask_interview" }));

      expect(messagesCreate).toHaveBeenCalled();
      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.bookingFlowStep).toBe("bk_ask_interview");
      expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("didn't quite catch");
    });

    it("auto-links with no ask at all when exactly one interview is eligible", async () => {
      hoisted.docState.set("video_interviews/iv1", {
        clientId: UID, caregiverId: CG_ID, status: "completed", applicationId: "app1",
        scheduledTime: "2026-09-13T09:00:00.000Z",
      });
      hoisted.docState.set("job_applications/app1", { jobId: "job1" });
      hoisted.docState.set("job_posts/job1", { title: "Senior care in San Jose", rate: "25" });

      await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.bookingFlowStep).toBe("bk_ask_rate");
      expect(stored.bookingFlowData.interviewId).toBe("iv1");
      expect(stored.bookingFlowData.jobTitle).toBe("Senior care in San Jose");
    });

    // 2026-09-14 (Hamse-confirmed): the site itself never shows a "Send
    // Booking" button without a completed, non-declined interview behind it
    // — there is no direct/no-interview booking path on the site at all —
    // so Evia must not invent one either. 0 eligible stops the flow instead
    // of proceeding.
    it("blocks and tells the family plainly when no interview is eligible at all, instead of proceeding as a direct booking", async () => {
      hoisted.docState.set("video_interviews/iv1", {
        clientId: UID, caregiverId: CG_ID, status: "completed", fitLevel: "no",
      });

      const result = await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });

      expect(result.started).toBe(false);
      expect(result.reason).toBe("no_eligible_interview");
      expect(hoisted.docState.get(`agent_sessions/${PHONE}`)).toBeUndefined();
      const lastMsg = String(sendMessage.mock.calls.at(-1)![1]);
      expect(lastMsg).toContain("Basra Yousuf");
      expect(lastMsg).toContain("no completed interview");
    });

    it("blocks with a caregiver-agnostic message when no caregiver was named and nothing is eligible for any of them", async () => {
      const result = await startBookingFlow(PHONE, CHAT, session(), {});

      expect(result.started).toBe(false);
      expect(result.reason).toBe("no_eligible_interview");
      const lastMsg = String(sendMessage.mock.calls.at(-1)![1]);
      expect(lastMsg).toContain("don't see any completed interviews");
    });

    it("scopes across every caregiver and shows a mixed list when no caregiverId is given and 2+ are eligible", async () => {
      hoisted.docState.set(`caregivers/cg-2`, { name: "Maria Santos" });
      hoisted.docState.set("video_interviews/iv1", {
        clientId: UID, caregiverId: CG_ID, status: "completed", applicationId: "app1",
        scheduledTime: "2026-09-12T21:10:00.000Z",
      });
      hoisted.docState.set("video_interviews/iv2", {
        clientId: UID, caregiverId: "cg-2", status: "completed",
        scheduledTime: "2026-09-08T15:00:00.000Z",
      });
      hoisted.docState.set("job_applications/app1", { jobId: "job1" });
      hoisted.docState.set("job_posts/job1", { title: "Senior care in San Jose" });

      const result = await startBookingFlow(PHONE, CHAT, session(), {});

      expect(result.started).toBe(true);
      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.bookingFlowStep).toBe("bk_ask_interview");
      expect(stored.bookingFlowData.interviewOptions).toHaveLength(2);
      const lastMsg = String(sendMessage.mock.calls.at(-1)![1]);
      expect(lastMsg).toContain("1. Basra Yousuf — Senior care in San Jose");
      expect(lastMsg).toContain("2. Maria Santos (");

      modelReplies("NO", "2");
      await handleBookingFlowStep(PHONE, CHAT, "2", session({ bookingFlowStep: "bk_ask_interview" }));
      const updated = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(updated.bookingFlowData.caregiverId).toBe("cg-2");
      expect(updated.bookingFlowData.caregiverName).toBe("Maria Santos");
      expect(updated.bookingFlowData.interviewId).toBe("iv2");
      expect(updated.bookingFlowStep).toBe("bk_ask_rate");
    });

    it("auto-links across every caregiver with no ask at all when no caregiverId is given and exactly one is eligible", async () => {
      hoisted.docState.set(`caregivers/cg-2`, { name: "Maria Santos" });
      hoisted.docState.set("video_interviews/iv2", {
        clientId: UID, caregiverId: "cg-2", status: "completed",
        scheduledTime: "2026-09-08T15:00:00.000Z",
      });

      const result = await startBookingFlow(PHONE, CHAT, session(), {});

      expect(result.started).toBe(true);
      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.bookingFlowStep).toBe("bk_ask_rate");
      expect(stored.bookingFlowData.caregiverId).toBe("cg-2");
      expect(stored.bookingFlowData.caregiverName).toBe("Maria Santos");
      expect(stored.bookingFlowData.interviewId).toBe("iv2");
      const lastMsg = String(sendMessage.mock.calls.at(-1)![1]);
      expect(lastMsg).toContain("Maria Santos");
    });

    // 2026-09-14 fix: picking from 2+ used to skip straight to the rate
    // question, bypassing the same upfront recipients-ambiguity check every
    // other entry path into the flow gets.
    it("still asks the recipients-confirm question after picking from 2+ interviews, when the default is genuinely ambiguous", async () => {
      hoisted.docState.set("video_interviews/iv1", {
        clientId: UID, caregiverId: CG_ID, status: "completed",
        scheduledTime: "2026-09-13T09:00:00.000Z",
      });
      hoisted.docState.set("video_interviews/iv2", {
        clientId: UID, caregiverId: CG_ID, status: "completed",
        scheduledTime: "2026-09-12T21:10:00.000Z",
      });
      hoisted.docState.set(`carePlans/${UID}`, {
        recipientPlans: {
          samira_m: { name: "Samira M", careNeeds: ["Meal Preparation"] },
          imran_mohammed: { name: "Imran Mohammed", careNeeds: ["Bathing"] },
        },
      });

      await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
      modelReplies("NO", "1");
      await handleBookingFlowStep(PHONE, CHAT, "1", session({ bookingFlowStep: "bk_ask_interview" }));

      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.bookingFlowStep).toBe("bk_confirm_recipients");
      expect(stored.bookingFlowData.recipientResolved).toBe("defaulted_all");
    });
  });

  it("always asks days explicitly even when the job post already lists them, offering them as a suggestion", async () => {
    hoisted.docState.set("video_interviews/iv1", { clientId: UID, caregiverId: CG_ID, applicationId: "app1" });
    hoisted.docState.set("job_applications/app1", { jobId: "job1" });
    hoisted.docState.set("job_posts/job1", { title: "Care", rate: "25", daysOfWeek: ["Monday", "Wednesday"] });

    await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID, interviewId: "iv1" });
    let stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_rate");

    modelReplies("NO", "25");
    await handleBookingFlowStep(PHONE, CHAT, "25", session({ bookingFlowStep: "bk_ask_rate", bookingFlowData: stored.bookingFlowData }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_days");
    const lastMsg = String(sendMessage.mock.calls.at(-1)![1]);
    expect(lastMsg).toContain("What days of the week would you like");
    expect(lastMsg).toContain("Monday, Wednesday");

    modelReplies("NO", JSON.stringify({ days: ["Monday", "Wednesday"] }));
    await handleBookingFlowStep(PHONE, CHAT, "Monday and Wednesday works", session({ bookingFlowStep: "bk_ask_days", bookingFlowData: stored.bookingFlowData }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_start_date");
    expect(stored.bookingFlowData.days).toEqual(["Monday", "Wednesday"]);
  });

  // 2026-09-13 (live-caught): the site's own job_posts doc only ever records
  // a recipientsCount NUMBER, never which household member a posting/
  // interview was actually for — resolveRecipientAttribution's "defaulted_
  // all" is the best available default, but silently applying it and only
  // surfacing who it picked in the FINAL recap left the family unable to see
  // — let alone correct — an unrelated name swept in until they'd already
  // answered rate/schedule/location. This proactively confirms it upfront.
  it("proactively confirms who the booking covers upfront when the default is genuinely ambiguous (2+ recipients, none named)", async () => {
    seedOneEligibleInterview();
    hoisted.docState.set(`carePlans/${UID}`, {
      recipientPlans: {
        samira_m: { name: "Samira M", careNeeds: ["Meal Preparation"] },
        imran_mohammed: { name: "Imran Mohammed", careNeeds: ["Bathing"] },
      },
    });
    await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_confirm_recipients");
    expect(stored.bookingFlowData.recipientResolved).toBe("defaulted_all");
    const lastMsg = String(sendMessage.mock.calls.at(-1)![1]);
    expect(lastMsg).toContain("this booking is for: Samira M, Imran Mohammed");
  });

  it("skips straight to the rate question when there's only one recipient on file (nothing ambiguous to confirm)", async () => {
    seedOneEligibleInterview();
    hoisted.docState.set(`carePlans/${UID}`, {
      recipientPlans: { samira_m: { name: "Samira M", careNeeds: ["Meal Preparation"] } },
    });
    await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_rate");
  });
});

describe("bk_confirm_recipients", () => {
  function seedAtConfirmRecipients() {
    // resolveAndMergeRecipients (the "naming who it's actually for" path)
    // re-resolves against carePlans, not just the in-flight flow data — seed
    // both so a name-narrowing reply can actually find a real match.
    hoisted.docState.set(`carePlans/${UID}`, {
      recipientPlans: {
        samira_m: { name: "Samira M", careNeeds: ["Meal Preparation"] },
        imran_mohammed: { name: "Imran Mohammed", careNeeds: ["Bathing"] },
      },
    });
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      bookingFlowStep: "bk_confirm_recipients",
      bookingFlowData: {
        caregiverId: CG_ID, caregiverName: "Basra Yousuf",
        careRecipients: [
          { name: "Samira M", careNeeds: ["Meal Preparation"] },
          { name: "Imran Mohammed", careNeeds: ["Bathing"] },
        ],
        recipientResolved: "defaulted_all",
      },
    });
  }

  it("a plain confirmation advances straight to the rate question, unchanged", async () => {
    seedAtConfirmRecipients();
    modelReplies("NO", '{"confirmed": true, "recipientNames": null}');
    await handleBookingFlowStep(PHONE, CHAT, "yes that's right", session({ bookingFlowStep: "bk_confirm_recipients" }));
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_rate");
    expect(stored.bookingFlowData.careRecipients).toHaveLength(2);
  });

  it("naming who it's actually for narrows the recipients, then advances to rate", async () => {
    seedAtConfirmRecipients();
    modelReplies("NO", '{"confirmed": false, "recipientNames": ["Samira"]}');
    await handleBookingFlowStep(PHONE, CHAT, "just for Samira", session({ bookingFlowStep: "bk_confirm_recipients" }));
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_rate");
    expect(stored.bookingFlowData.careRecipients).toHaveLength(1);
    expect(stored.bookingFlowData.careRecipients[0].name).toBe("Samira M");
    expect(stored.bookingFlowData.recipientResolved).toBe("named");
  });

  it("re-asks on an unclassifiable reply instead of guessing", async () => {
    seedAtConfirmRecipients();
    modelReplies("NO", '{"confirmed": false, "recipientNames": null}');
    await handleBookingFlowStep(PHONE, CHAT, "hmm not sure", session({ bookingFlowStep: "bk_confirm_recipients" }));
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_confirm_recipients");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("didn't quite catch that");
  });
});

describe("bk_ask_rate", () => {
  it("re-asks on a failed parse instead of defaulting", async () => {
    const data = { caregiverId: CG_ID, caregiverName: "Basra Yousuf" };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_ask_rate", bookingFlowData: data });
    modelReplies("NO", "not-a-number");

    await handleBookingFlowStep(PHONE, CHAT, "whatever works", session({ bookingFlowStep: "bk_ask_rate", bookingFlowData: data }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_rate");
    expect(String(sendMessage.mock.calls[0][1])).toContain("didn't quite catch");
  });

  it("extracts a real rate and advances to the days question", async () => {
    const data = { caregiverId: CG_ID, caregiverName: "Basra Yousuf" };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_ask_rate", bookingFlowData: data });
    modelReplies("NO", "26");

    await handleBookingFlowStep(PHONE, CHAT, "26 an hour", session({ bookingFlowStep: "bk_ask_rate", bookingFlowData: data }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowData.hourlyRate).toBe(26);
    expect(stored.bookingFlowStep).toBe("bk_ask_days");
  });

  it("answers a genuine mid-flow question, then re-asks the rate question", async () => {
    const data = { caregiverId: CG_ID, caregiverName: "Basra Yousuf" };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_ask_rate", bookingFlowData: data });
    modelReplies("YES", "Basra is a great fit for overnight care.");

    await handleBookingFlowStep(PHONE, CHAT, "is she good with overnight shifts?", session({ bookingFlowStep: "bk_ask_rate", bookingFlowData: data }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_rate");
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(String(sendMessage.mock.calls[1][1])).toContain("agreed hourly rate");
  });
});

describe("bk_ask_days → bk_ask_times → bk_ask_location → bk_confirm", () => {
  it("a recurring answer moves to times, a time answer moves to a single saved location, then confirm", async () => {
    const daysData = { caregiverId: CG_ID, caregiverName: "Basra Yousuf", hourlyRate: 26 };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_ask_days", bookingFlowData: daysData });
    hoisted.docState.set("carePlans/client-uid", {
      locationPool: [{ street: "1 Elm St", city: "Springfield", state: "CA", zipCode: "90000" }],
    });
    modelReplies("NO", JSON.stringify({ days: ["Tuesday", "Thursday"] }));

    await handleBookingFlowStep(PHONE, CHAT, "every Tue and Thu", session({ bookingFlowStep: "bk_ask_days", bookingFlowData: daysData }));
    let stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_start_date");
    expect(stored.bookingFlowData.days).toEqual(["Tuesday", "Thursday"]);

    modelReplies("NO", JSON.stringify({ date: "2026-09-15" }));
    await handleBookingFlowStep(PHONE, CHAT, "this Tuesday", session({ bookingFlowStep: "bk_ask_start_date", bookingFlowData: stored.bookingFlowData }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_times");
    expect(stored.bookingFlowData.startDate).toBe("2026-09-15");

    modelReplies("NO", JSON.stringify({ Tuesday: { start: "09:00", end: "17:00" }, Thursday: { start: "09:00", end: "17:00" } }));
    await handleBookingFlowStep(PHONE, CHAT, "9am to 5pm", session({ bookingFlowStep: "bk_ask_times", bookingFlowData: stored.bookingFlowData }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_ongoing");
    expect(stored.bookingFlowData.dayTimes).toEqual({
      Tuesday: { start: "09:00", end: "17:00" },
      Thursday: { start: "09:00", end: "17:00" },
    });

    modelReplies("NO", JSON.stringify({ ongoing: true }));
    await handleBookingFlowStep(PHONE, CHAT, "ongoing", session({ bookingFlowStep: "bk_ask_ongoing", bookingFlowData: stored.bookingFlowData }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    // Lands on the proactive message-note ask first (matches the site's
    // modal position, right above Send) — not the recap yet.
    expect(stored.bookingFlowStep).toBe("bk_ask_message");
    expect(stored.bookingFlowData.ongoing).toBe(true);
    expect(stored.bookingFlowData.careLocation).toBe("1 Elm St, Springfield, CA, 90000");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("Want to include a note");

    modelReplies("NO", "SKIP");
    await handleBookingFlowStep(PHONE, CHAT, "no thanks", session({ bookingFlowStep: "bk_ask_message", bookingFlowData: stored.bookingFlowData }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_confirm");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("Reply YES to send it");
  });

  it("requires a start/end for EVERY day — a reply missing one day re-asks instead of leaving it blank", async () => {
    const daysData = { caregiverId: CG_ID, caregiverName: "Basra Yousuf", hourlyRate: 26, days: ["Tuesday", "Thursday"] };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_ask_times", bookingFlowData: daysData });
    // Only Tuesday comes back — Thursday is missing entirely.
    modelReplies("NO", JSON.stringify({ Tuesday: { start: "09:00", end: "17:00" } }));

    await handleBookingFlowStep(PHONE, CHAT, "Tuesday 9 to 5", session({ bookingFlowStep: "bk_ask_times", bookingFlowData: daysData }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_times");
    expect(stored.bookingFlowData.dayTimes).toBeUndefined();
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("didn't quite catch");
  });

  it("a job post with a known end date skips the ongoing question entirely", async () => {
    const timesData = {
      caregiverId: CG_ID, caregiverName: "Basra Yousuf", hourlyRate: 26,
      days: ["Tuesday"], startDate: "2026-09-15", jobPostEndDate: "2026-12-01",
    };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_ask_times", bookingFlowData: timesData });
    hoisted.docState.set("carePlans/client-uid", {
      locationPool: [{ street: "1 Elm St", city: "Springfield", state: "CA", zipCode: "90000" }],
    });
    modelReplies("NO", JSON.stringify({ Tuesday: { start: "09:00", end: "17:00" } }));
    await handleBookingFlowStep(PHONE, CHAT, "9am to 5pm", session({ bookingFlowStep: "bk_ask_times", bookingFlowData: timesData }));
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    // Lands on the proactive message-note ask, not the recap yet.
    expect(stored.bookingFlowStep).toBe("bk_ask_message");
    expect(stored.bookingFlowData.ongoing).toBe(false);
    expect(stored.bookingFlowData.scheduleEndDate).toBe("2026-12-01");
  });

  it("a stated end date is captured instead of ongoing", async () => {
    const ongoingData = { caregiverId: CG_ID, caregiverName: "Basra Yousuf", hourlyRate: 26, days: ["Tuesday"], startDate: "2026-09-15", dayTimes: { Tuesday: { start: "09:00", end: "17:00" } } };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_ask_ongoing", bookingFlowData: ongoingData });
    hoisted.docState.set("carePlans/client-uid", {
      locationPool: [{ street: "1 Elm St", city: "Springfield", state: "CA", zipCode: "90000" }],
    });
    modelReplies("NO", JSON.stringify({ ongoing: false, endDate: "2026-12-01" }));
    await handleBookingFlowStep(PHONE, CHAT, "through December 1", session({ bookingFlowStep: "bk_ask_ongoing", bookingFlowData: ongoingData }));
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowData.ongoing).toBe(false);
    expect(stored.bookingFlowData.scheduleEndDate).toBe("2026-12-01");
    expect(stored.bookingFlowStep).toBe("bk_ask_message");
  });

  it("a bare number picks the address directly with no model call", async () => {
    const data = {
      caregiverId: CG_ID, caregiverName: "Basra Yousuf", hourlyRate: 26, days: ["Tuesday"], startDate: "2026-09-15",
      dayTimes: { Tuesday: { start: "09:00", end: "17:00" } }, ongoing: true,
      careLocationOptions: [
        { street: "1 Elm St", city: "Springfield", state: "CA", zipCode: "90000" },
        { street: "2 Oak Ave", city: "Springfield", state: "CA", zipCode: "90000", smokingHousehold: true },
      ],
    };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_ask_location", bookingFlowData: data });
    // No modelReplies queued — a bare in-range number must never reach the model.
    await handleBookingFlowStep(PHONE, CHAT, "2", session({ bookingFlowStep: "bk_ask_location", bookingFlowData: data }));

    expect(messagesCreate).not.toHaveBeenCalled();
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_message");
    expect(stored.bookingFlowData.careLocation).toBe("2 Oak Ave, Springfield, CA, 90000");
  });

  it("an ambiguous address list is asked, and picking by number advances to the message ask, then confirm", async () => {
    const ongoingData = { caregiverId: CG_ID, caregiverName: "Basra Yousuf", hourlyRate: 26, days: ["Tuesday"], startDate: "2026-09-15", dayTimes: { Tuesday: { start: "09:00", end: "17:00" } } };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_ask_ongoing", bookingFlowData: ongoingData });
    hoisted.docState.set("carePlans/client-uid", {
      locationPool: [
        { street: "1 Elm St", city: "Springfield", state: "CA", zipCode: "90000" },
        { street: "2 Oak Ave", city: "Springfield", state: "CA", zipCode: "90000", smokingHousehold: true },
      ],
    });
    modelReplies("NO", JSON.stringify({ ongoing: true }));
    await handleBookingFlowStep(PHONE, CHAT, "ongoing", session({ bookingFlowStep: "bk_ask_ongoing", bookingFlowData: ongoingData }));
    let stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_location");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("smoking household");

    modelReplies("NO", JSON.stringify({ matchedIndex: 2, newAddress: null }));
    await handleBookingFlowStep(PHONE, CHAT, "the smoking one", session({ bookingFlowStep: "bk_ask_location", bookingFlowData: stored.bookingFlowData }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_message");
    expect(stored.bookingFlowData.careLocation).toBe("2 Oak Ave, Springfield, CA, 90000");

    modelReplies("NO", "NOTE");
    await handleBookingFlowStep(PHONE, CHAT, "she has a spare key", session({ bookingFlowStep: "bk_ask_message", bookingFlowData: stored.bookingFlowData }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_confirm");
    expect(stored.bookingFlowData.message).toBe("she has a spare key");
  });
});

describe("bk_confirm", () => {
  const CONFIRM_DATA = {
    caregiverId: CG_ID, caregiverName: "Basra Yousuf", hourlyRate: 26,
    days: ["Tuesday", "Thursday"], startDate: "2026-09-15",
    dayTimes: { Tuesday: { start: "09:00", end: "17:00" }, Thursday: { start: "09:00", end: "17:00" } },
    ongoing: true,
    careLocation: "1 Elm St, Springfield, CA, 90000",
  };

  it("YES commits via createBookingTask, then actually executes it — not just stages it", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "confirm" }));

    await handleBookingFlowStep(PHONE, CHAT, "yes send it", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    expect(createBookingTask).toHaveBeenCalledTimes(1);
    const call = createBookingTask.mock.calls[0][0];
    expect(call.caregiverId).toBe(CG_ID);
    expect(call.hourlyRate).toBe(26);
    // Array-wrapped per day (2026-09-14, live-caught) — matches the site's
    // own shape; a bare {start,end} object silently generated zero real
    // shifts via shiftGenerator.ts's onBookingAccepted trigger.
    // Keys normalized to the site's own 3-letter abbreviation (2026-09-14,
    // live-caught same session) — data.days/dayTimes are kept as full
    // weekday names internally (for a natural-reading SMS recap), but the
    // site's dayShiftTimes convention (and both dashboards' summary-line
    // rendering) keys by "Tue" not "Tuesday" — a full-name key rendered a
    // blank weekly-schedule line on both the caregiver's and client's
    // dashboards for every Evia-originated recurring booking.
    expect(call.schedule.dayShiftTimes).toEqual({
      Tue: [{ start: "09:00", end: "17:00" }],
      Thu: [{ start: "09:00", end: "17:00" }],
    });
    expect(call.schedule.ongoing).toBe(true);
    expect(call.careLocation).toBe(CONFIRM_DATA.careLocation);

    // 2026-09-13 (live-caught): createBookingTask alone only stages an
    // agent_tasks doc — the real booking_requests write, the caregiver's
    // shift offer, and the family's "request sent" confirmation all happen
    // inside executeBookings. Evia was telling the family "Sent to Basra
    // Yousuf" without this ever running, while the site still showed "Send
    // Booking" available and the caregiver was never notified.
    expect(executeBookings).toHaveBeenCalledTimes(1);
    expect(executeBookings).toHaveBeenCalledWith("task-1", PHONE);

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBeUndefined();
    expect(stored.bookingFlowData).toBeUndefined();
  });

  // 2026-09-14 (live-caught, twice in one session): a bare "yes" against this
  // long, multi-section recap got misclassified by isBackOutRequest as a
  // cancel request. This locks in the deterministic fix: an unambiguous
  // affirmative skips isBackOutRequest AND the classify call entirely — no
  // model call in this test at all should be able to misfire it into cancel.
  it("a bare 'yes' commits directly, skipping isBackOutRequest and the classify call entirely", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    // No modelReplies queued at all — if the code tried to call the model
    // for isBackOutRequest or the classify prompt, messagesCreate would
    // reject/resolve empty and createBookingTask would never fire.

    await handleBookingFlowStep(PHONE, CHAT, "yes", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(createBookingTask).toHaveBeenCalledTimes(1);
    expect(executeBookings).toHaveBeenCalledTimes(1);
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBeUndefined();
  });

  it("never sends its own success message — executeBookings owns the family-facing confirmation", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "confirm" }));

    await handleBookingFlowStep(PHONE, CHAT, "yes send it", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    // executeBookings is mocked to a no-op here, so if bookingFlow.ts sent
    // its own "Sent to..." message this call would be the giveaway — a
    // second, redundant confirmation on top of whatever executeBookings
    // itself sends in production.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("an execution failure still reaches the family as an honest apology, not a false success", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "confirm" }));
    executeBookings.mockRejectedValueOnce(new Error("booking_requests write failed"));

    await handleBookingFlowStep(PHONE, CHAT, "yes send it", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    expect(String(sendMessage.mock.calls.at(-1)![1])).toMatch(/problem|wrong|sorry/i);
    expect(String(sendMessage.mock.calls.at(-1)![1])).not.toContain("Sent to");
  });

  it("NO cancels without ever calling createBookingTask", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "cancel" }));

    await handleBookingFlowStep(PHONE, CHAT, "actually never mind", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    expect(createBookingTask).not.toHaveBeenCalled();
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBeUndefined();
  });

  // 2026-09-13 (live-caught, "it's keep repeating"): a genuine mid-flow
  // question at confirm used to re-send the ENTIRE (long) recap every time —
  // now it gets a short reminder instead, so answering a question doesn't
  // feel like the flow reset itself.
  it("a genuine question at confirm gets answered plus a short reminder, not the full recap again", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "other" }), "YES", "Interviews usually run 15-30 minutes.");
    await handleBookingFlowStep(PHONE, CHAT, "how long does the interview usually take", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));
    const sentTexts = sendMessage.mock.calls.map((c: any[]) => String(c[1]));
    expect(sentTexts.at(-1)).toContain("Confirming whether to send this booking request");
    expect(sentTexts.some((t) => t.includes("Here's your booking request:"))).toBe(false);
  });

  it("an in-message rate correction updates the rate in place and re-shows the recap", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "edit_rate", newRate: 30 }));

    await handleBookingFlowStep(PHONE, CHAT, "actually make it $30/hr", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    expect(createBookingTask).not.toHaveBeenCalled();
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowData.hourlyRate).toBe(30);
    expect(stored.bookingFlowStep).toBe("bk_confirm");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("Agreed rate: $30/hr");
  });

  it("a rate-change request with no stated number re-asks the rate question", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "edit_rate", newRate: null }));

    await handleBookingFlowStep(PHONE, CHAT, "wait, let's change the rate", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_rate");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("agreed hourly rate");
  });

  it("an edit_schedule request sends the flow back to the days question", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "edit_schedule" }));

    await handleBookingFlowStep(PHONE, CHAT, "can we change the days", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_days");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("What days of the week would you like");
  });

  it("an edit_location request lists the saved addresses again for a fresh pick", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    hoisted.docState.set("carePlans/client-uid", {
      locationPool: [
        { street: "1 Elm St", city: "Springfield", state: "CA", zipCode: "90000" },
        { street: "2 Oak Ave", city: "Springfield", state: "CA", zipCode: "90000", smokingHousehold: true },
      ],
    });
    modelReplies(JSON.stringify({ action: "edit_location" }));

    await handleBookingFlowStep(PHONE, CHAT, "can we use a different address", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_location");
    expect(stored.bookingFlowData.careLocationOptions).toHaveLength(2);
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("smoking household");
  });

  it("an edit_recipients request with names stated re-attributes in place, matching the site's select/deselect", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    hoisted.docState.set("carePlans/client-uid", {
      recipientPlans: {
        samira_m: { name: "Samira M", careNeeds: ["Meal Preparation"] },
        imran_mohammed: { name: "Imran Mohammed", careNeeds: ["Bathing"] },
      },
    });
    modelReplies(JSON.stringify({ action: "edit_recipients", recipientNames: ["Samira"] }));

    await handleBookingFlowStep(PHONE, CHAT, "just Samira for this one", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_confirm");
    expect(stored.bookingFlowData.careRecipients.map((r: any) => r.name)).toEqual(["Samira M"]);
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("Samira M: Meal Preparation");
  });

  it("an edit_recipients request with no names stated lists the household to pick from", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    hoisted.docState.set("carePlans/client-uid", {
      recipientPlans: { samira_m: { name: "Samira M" }, imran_mohammed: { name: "Imran Mohammed" } },
    });
    modelReplies(JSON.stringify({ action: "edit_recipients", recipientNames: null }));

    await handleBookingFlowStep(PHONE, CHAT, "can we change who this is for", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_recipients");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("Imran Mohammed");
  });

  it("picking recipients by number at bk_ask_recipients applies the selection and returns to confirm", async () => {
    const recipData = { ...CONFIRM_DATA, recipientOptions: [{ key: "samira_m", name: "Samira M" }, { key: "imran_mohammed", name: "Imran Mohammed" }] };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_ask_recipients", bookingFlowData: recipData });
    hoisted.docState.set("carePlans/client-uid", {
      recipientPlans: {
        samira_m: { name: "Samira M", careNeeds: ["Meal Preparation"] },
        imran_mohammed: { name: "Imran Mohammed", careNeeds: ["Bathing"] },
      },
    });
    modelReplies("NO", JSON.stringify([1, 2]));

    await handleBookingFlowStep(PHONE, CHAT, "1 and 2", session({ bookingFlowStep: "bk_ask_recipients", bookingFlowData: recipData }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_confirm");
    expect(stored.bookingFlowData.careRecipients.map((r: any) => r.name)).toEqual(["Samira M", "Imran Mohammed"]);
  });

  it("an edit_message request with text stated applies it in place", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "edit_message", newMessage: "I'll leave the front door unlocked" }));

    await handleBookingFlowStep(PHONE, CHAT, "tell her I'll leave the front door unlocked", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowData.message).toBe("I'll leave the front door unlocked");
    expect(stored.bookingFlowStep).toBe("bk_confirm");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("front door unlocked");
  });

  it("an edit_message request with no text stated asks for the note, then applies the follow-up", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "edit_message", newMessage: null }));

    await handleBookingFlowStep(PHONE, CHAT, "let's add a note", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));
    let stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_message");

    modelReplies("NO", "NOTE");
    await handleBookingFlowStep(PHONE, CHAT, "she has a key already", session({ bookingFlowStep: "bk_ask_message", bookingFlowData: stored.bookingFlowData }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowData.message).toBe("she has a key already");
    expect(stored.bookingFlowStep).toBe("bk_confirm");
  });

  it("an edit_care_needs request adds a need for the named recipient in a multi-recipient booking", async () => {
    const data = {
      ...CONFIRM_DATA,
      careRecipients: [
        { name: "Samira M", careNeeds: ["Meal Preparation"] },
        { name: "Imran Mohammed", careNeeds: ["Bathing"] },
      ],
    };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: data });
    modelReplies(JSON.stringify({
      action: "edit_care_needs", careNeedsRecipient: "Samira", addCareNeeds: ["mobility assistance"], removeCareNeeds: null,
    }));

    await handleBookingFlowStep(PHONE, CHAT, "add mobility assistance for Samira", session({ bookingFlowStep: "bk_confirm", bookingFlowData: data }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    const samira = stored.bookingFlowData.careRecipients.find((r: any) => r.name === "Samira M");
    const imran  = stored.bookingFlowData.careRecipients.find((r: any) => r.name === "Imran Mohammed");
    expect(samira.careNeeds).toEqual(expect.arrayContaining(["Meal Preparation", "Mobility Assistance"]));
    expect(imran.careNeeds).toEqual(["Bathing"]);
    expect(stored.bookingFlowData.topLevelCareNeeds).toEqual(expect.arrayContaining(["Meal Preparation", "Mobility Assistance", "Bathing"]));
    expect(stored.bookingFlowStep).toBe("bk_confirm");
  });

  it("an edit_care_needs request with no recipient named in a multi-recipient booking asks who it's for", async () => {
    const data = {
      ...CONFIRM_DATA,
      careRecipients: [
        { name: "Samira M", careNeeds: ["Meal Preparation"] },
        { name: "Imran Mohammed", careNeeds: ["Bathing"] },
      ],
    };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: data });
    modelReplies(JSON.stringify({ action: "edit_care_needs", careNeedsRecipient: null, addCareNeeds: ["mobility assistance"], removeCareNeeds: null }));

    await handleBookingFlowStep(PHONE, CHAT, "add mobility assistance", session({ bookingFlowStep: "bk_confirm", bookingFlowData: data }));

    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("Whose care needs");
  });

  it("an edit_care_needs request removes a need in a single-recipient booking", async () => {
    // "bathing" normalizes to the canonical "Personal Care" category
    // (careNeedCategories.ts's synonym map) — the fixture stores the
    // canonical name, matching how it's stored everywhere else.
    const data = { ...CONFIRM_DATA, careRecipients: undefined, topLevelCareNeeds: ["Meal Preparation", "Personal Care"] };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: data });
    modelReplies(JSON.stringify({ action: "edit_care_needs", addCareNeeds: null, removeCareNeeds: ["bathing"] }));

    await handleBookingFlowStep(PHONE, CHAT, "remove bathing", session({ bookingFlowStep: "bk_confirm", bookingFlowData: data }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowData.topLevelCareNeeds).toEqual(["Meal Preparation"]);
  });

  it("an edit_lifestyle request structures free text into the recipient's lifestyle object and merges with what's there", async () => {
    const data = {
      ...CONFIRM_DATA,
      careRecipients: [{ name: "Samira M", careNeeds: ["Meal Preparation"], lifestyle: { favoriteActivities: ["gardening"] } }],
    };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: data });
    modelReplies(
      JSON.stringify({ action: "edit_lifestyle", lifestyleRecipient: null, lifestyleText: "she loves painting and prefers a quiet morning" }),
      JSON.stringify({ favoriteActivities: ["painting"], prefersQuiet: true }),
    );

    await handleBookingFlowStep(PHONE, CHAT, "she loves painting and prefers a quiet morning", session({ bookingFlowStep: "bk_confirm", bookingFlowData: data }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    const samira = stored.bookingFlowData.careRecipients[0];
    expect(samira.lifestyle.favoriteActivities).toEqual(expect.arrayContaining(["gardening", "painting"]));
    expect(samira.lifestyle.prefersQuiet).toBe(true);
    expect(stored.bookingFlowStep).toBe("bk_confirm");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("Lifestyle: enjoys gardening, painting; prefers quiet");
  });

  it("an edit_lifestyle request with no recipient named in a multi-recipient booking asks who it's for", async () => {
    const data = {
      ...CONFIRM_DATA,
      careRecipients: [{ name: "Samira M", careNeeds: [] }, { name: "Imran Mohammed", careNeeds: [] }],
    };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: data });
    modelReplies(JSON.stringify({ action: "edit_lifestyle", lifestyleRecipient: null, lifestyleText: "loves painting" }));

    await handleBookingFlowStep(PHONE, CHAT, "she loves painting", session({ bookingFlowStep: "bk_confirm", bookingFlowData: data }));

    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("Whose lifestyle");
  });

  it("an edit_notes request overwrites (not appends to) the named recipient's note", async () => {
    const data = {
      ...CONFIRM_DATA,
      careRecipients: [
        { name: "Samira M", careNeeds: [], notes: "likes to go shopping" },
        { name: "Imran Mohammed", careNeeds: [] },
      ],
    };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: data });
    modelReplies(JSON.stringify({ action: "edit_notes", notesRecipient: "Samira", notesText: "prefers afternoon visits" }));

    await handleBookingFlowStep(PHONE, CHAT, "add a note for Samira: prefers afternoon visits", session({ bookingFlowStep: "bk_confirm", bookingFlowData: data }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    const samira = stored.bookingFlowData.careRecipients.find((r: any) => r.name === "Samira M");
    expect(samira.notes).toBe("prefers afternoon visits");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("Notes: prefers afternoon visits");
  });

  it("an edit_notes request with no recipient named in a multi-recipient booking asks who it's for", async () => {
    const data = {
      ...CONFIRM_DATA,
      careRecipients: [{ name: "Samira M", careNeeds: [] }, { name: "Imran Mohammed", careNeeds: [] }],
    };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: data });
    modelReplies(JSON.stringify({ action: "edit_notes", notesRecipient: null, notesText: "likes tea in the morning" }));

    await handleBookingFlowStep(PHONE, CHAT, "add a note: likes tea in the morning", session({ bookingFlowStep: "bk_confirm", bookingFlowData: data }));

    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("Whose notes");
  });
});

describe("buildBookingRecap", () => {
  it("lists every section in the site modal's order, with each recipient's own care needs and lifestyle", () => {
    const recap = buildBookingRecap({
      caregiverId: CG_ID, caregiverName: "Basra Yousuf", hourlyRate: 26,
      days: ["Tuesday", "Thursday"], startDate: "2026-09-15",
      dayTimes: { Tuesday: { start: "09:00", end: "17:00" }, Thursday: { start: "10:00", end: "14:00" } },
      ongoing: true,
      careLocation: "1 Elm St, Springfield, CA, 90000",
      lifestylePreferences: ["Smoking household"],
      careRecipients: [
        { name: "Samira M", relationship: "parent", age: "22", careNeeds: ["Meal Preparation", "Personal Care"], notes: "likes to go shopping", lifestyle: { prefersQuiet: true } },
        { name: "Imran Mohammed", careNeeds: ["Bathing"] },
      ],
      emergencyContact: { name: "Bo", phone: "4086370483", relationship: "Daughter" },
    });
    const order = ["Caregiver:", "Agreed rate:", "Schedule:", "Care recipients:", "Care location:", "Emergency contact:", "Message to"];
    let lastIndex = -1;
    for (const label of order) {
      const idx = recap.indexOf(label);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
    expect(recap).toContain("Tuesday 9:00 AM–5:00 PM, Thursday 10:00 AM–2:00 PM, starting September 15, 2026");
    expect(recap).toContain("Samira M (parent, Age 22): Meal Preparation, Personal Care");
    expect(recap).toContain("Notes: likes to go shopping");
    expect(recap).toContain("Lifestyle: prefers quiet");
    expect(recap).toContain("Imran Mohammed: Bathing");
    // 2026-09-13 (live-caught): "Notes: None" read as if that literal
    // placeholder gets forwarded to the caregiver — it never does, so the
    // line is now omitted entirely for a recipient with no note, instead of
    // asserting an absence nobody needs stated.
    expect(recap).not.toContain("Notes: None");
    expect(recap).toContain("Care location: 1 Elm St, Springfield, CA, 90000 (Smoking household)");
    expect(recap).toContain("Reply YES to send it to Basra Yousuf");
  });
});
