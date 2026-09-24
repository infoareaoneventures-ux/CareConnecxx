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
    FieldValue: { delete: () => ({ __delete: true }), serverTimestamp: () => ({ __serverTimestamp: true }) },
  });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});

const sendMessage = vi.fn(async (..._a: unknown[]) => ({ message_id: "m1" }));
vi.mock("../../linq/client", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
const generateCaraMessageMock = vi.fn(async (opts: any) => opts.fallback ?? "msg");
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: (...a: unknown[]) => (generateCaraMessageMock as any)(...a) }));
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
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
const sendBookingRequest = vi.fn(async (_input: any, _opts: any): Promise<any> => ({ ok: true, bookingRequestId: "br-new" }));
vi.mock("../bookingSend", () => ({ sendBookingRequest: (input: unknown, opts: unknown) => sendBookingRequest(input, opts) }));
vi.mock("../onboardingConversation", () => ({ sendOnboardingLink: vi.fn(async () => ({ success: true })) }));

import { startBookingFlow, startResendBookingFlow, handleBookingFlowStep, buildBookingRecap } from "../bookingFlow";

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
  hoisted.docState.set(`users/${UID}`, { identityCheckStatus: "verified", membershipStatus: "active" });
  sendMessage.mockClear();
  messagesCreate.mockReset();
  sendBookingRequest.mockClear();
  sendBookingRequest.mockResolvedValue({ ok: true, bookingRequestId: "br-new" });
  seedCaregiver();
});

describe("startBookingFlow", () => {
  it("is gated like the site's Send Booking button: a lapsed membership gets the plan text + link and no flow starts", async () => {
    hoisted.docState.set(`users/${UID}`, { identityCheckStatus: "verified", membershipStatus: "canceled" });
    const r = await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
    expect(r).toEqual({ started: false, reason: "gated" });
    expect(sendMessage.mock.calls.map((c: any[]) => (typeof c[1] === "string" ? c[1] : JSON.stringify(c[1]))).join(" ")).toMatch(/Select a plan/);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)?.bookingFlowStep).toBeUndefined();
  });

  it("identity comes first, like the site: an unverified family gets the identity-check text", async () => {
    hoisted.docState.set(`users/${UID}`, { membershipStatus: "active" });
    const r = await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
    expect(r).toEqual({ started: false, reason: "gated" });
    expect(sendMessage.mock.calls.map((c: any[]) => (typeof c[1] === "string" ? c[1] : JSON.stringify(c[1]))).join(" ")).toMatch(/identity check/);
  });

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
  // The site's Re-book (PostsPage.tsx): an accepted booking blocks a new one
  // only while it still has a 'scheduled' shift; once every visit is done
  // the row shows Re-book and the interview is eligible again (2026-09-16).
  describe("Re-book eligibility (site parity)", () => {
    it("an accepted booking with a scheduled shift still blocks the interview", async () => {
      seedOneEligibleInterview("iv-done");
      hoisted.docState.set("booking_requests/br-acc", { clientId: UID, caregiverId: CG_ID, interviewId: "iv-done", status: "accepted" });
      hoisted.docState.set("shifts/sh-1", { clientId: UID, caregiverId: CG_ID, bookingRequestId: "br-acc", status: "scheduled", date: "2099-01-05" });
      const r = await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
      expect(r.started).toBe(false);
      expect(r.reason).toBe("no_eligible_interview");
    });

    it("an accepted booking whose visits are all done frees the interview for a Re-book", async () => {
      seedOneEligibleInterview("iv-done");
      hoisted.docState.set("booking_requests/br-acc", { clientId: UID, caregiverId: CG_ID, interviewId: "iv-done", status: "accepted" });
      hoisted.docState.set("shifts/sh-1", { clientId: UID, caregiverId: CG_ID, bookingRequestId: "br-acc", status: "completed", date: "2026-09-01" });
      const r = await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
      expect(r.started).toBe(true);
      expect(hoisted.docState.get(`agent_sessions/${PHONE}`).bookingFlowStep).toBe("bk_ask_rate");
    });
  });

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

// The site's "Resend" row (Care Requests > Interviews): same modal, pre-filled
// from the cancelled/declined request, submit updates the SAME doc (2026-09-16).
describe("resend — startResendBookingFlow / bk_ask_resend / commit", () => {
  const CANCELLED = {
    clientId: UID, clientName: "The Family", caregiverId: CG_ID, caregiverName: "Basra Yousuf", status: "cancelled",
    interviewId: "iv-a", jobId: "job-1", jobTitle: "Senior care in San Jose", address: "4746 Campbell Ave, San Jose, CA 95130",
    rate: 31, paymentMethod: "credit", careNeeds: ["Companionship"], notes: "this is for my family",
    careRecipients: [{ name: "Samira", relationship: "mother", careNeeds: ["Companionship"] }],
    schedule: { days: ["Tue", "Wed"], startDate: "2026-09-15", endDate: null, ongoing: true,
      dayShiftTimes: { Tue: [{ start: "11:00", end: "13:00" }], Wed: [{ start: "11:00", end: "13:00" }] } },
    createdAt: "2026-09-10T09:00:00.000Z", agentTaskId: "task-old",
  };

  it("one resendable request → pre-filled recap at bk_confirm, nothing written yet", async () => {
    hoisted.docState.set("booking_requests/br-cancelled", CANCELLED);
    hoisted.docState.set("video_interviews/iv-a", { clientId: UID, caregiverId: CG_ID, status: "completed", scheduledTime: "2026-09-13T16:00:00.000Z" });
    hoisted.docState.set(`agent_sessions/${PHONE}`, {});
    const r = await startResendBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
    expect(r.started).toBe(true);
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_confirm");
    expect(stored.bookingFlowData).toMatchObject({
      resendBookingRequestId: "br-cancelled", caregiverName: "Basra Yousuf", hourlyRate: 31, ongoing: true,
      days: ["Tuesday", "Wednesday"], dayTimes: { Tuesday: { start: "11:00", end: "13:00" } },
      careLocation: "4746 Campbell Ave, San Jose, CA 95130", message: "this is for my family",
    });
    const sent = String(sendMessage.mock.calls.at(-1)![1]);
    expect(sent).toContain("Let's resend your booking request to Basra Yousuf");
    expect(sent).toContain("Agreed rate: $31/hr");
    expect(sent).toContain("Tuesday 11:00 AM–1:00 PM");
    expect(hoisted.docState.get("booking_requests/br-cancelled").status).toBe("cancelled");
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("a newer pending request for the same caregiver+job hides the Resend, like the site", async () => {
    hoisted.docState.set("booking_requests/br-cancelled", CANCELLED);
    hoisted.docState.set("booking_requests/br-newer", { ...CANCELLED, status: "pending", createdAt: "2026-09-12T09:00:00.000Z", agentTaskId: undefined });
    hoisted.docState.set(`agent_sessions/${PHONE}`, {});
    const r = await startResendBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
    expect(r.started).toBe(false);
    expect(r.reason).toBe("no_resendable");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("don't see a cancelled or declined booking request");
  });

  it("two resendable requests → a numbered pick, and a bare number opens that one's recap", async () => {
    hoisted.docState.set("booking_requests/br-a", { ...CANCELLED, interviewId: "iv-a", jobId: undefined, createdAt: "2026-09-10T09:00:00.000Z" });
    hoisted.docState.set("booking_requests/br-b", { ...CANCELLED, status: "declined", interviewId: "iv-b", jobId: undefined, rate: 22, createdAt: "2026-09-11T09:00:00.000Z" });
    hoisted.docState.set(`agent_sessions/${PHONE}`, {});
    const r = await startResendBookingFlow(PHONE, CHAT, session(), {});
    expect(r.started).toBe(true);
    let stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_resend");
    const list = String(sendMessage.mock.calls.at(-1)![1]);
    expect(list).toContain("Which booking request would you like to resend?");
    expect(list).toContain("1. Basra Yousuf — Senior care in San Jose — Caregiver declined");
    expect(list).toContain("2. Basra Yousuf — Senior care in San Jose — Visit cancelled");

    await handleBookingFlowStep(PHONE, CHAT, "2", session({ bookingFlowStep: "bk_ask_resend" }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_confirm");
    expect(stored.bookingFlowData.resendBookingRequestId).toBe("br-a");
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("YES updates the SAME booking_requests doc back to pending with the site's shape — no new task, no new doc", async () => {
    hoisted.docState.set("booking_requests/br-cancelled", CANCELLED);
    const data = {
      caregiverId: CG_ID, caregiverName: "Basra Yousuf", hourlyRate: 33, interviewId: "iv-a", jobId: "job-1", jobTitle: "Senior care in San Jose",
      days: ["Tuesday", "Wednesday"], dayTimes: { Tuesday: { start: "10:00", end: "15:00" }, Wednesday: { start: "11:00", end: "13:00" } },
      startDate: "2026-09-22", ongoing: true, careLocation: "4746 Campbell Ave, San Jose, CA 95130",
      careRecipients: CANCELLED.careRecipients, topLevelCareNeeds: ["Companionship"], message: "please come in through the side door",
      resendBookingRequestId: "br-cancelled",
    };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: data });
    await handleBookingFlowStep(PHONE, CHAT, "yes", session({ bookingFlowStep: "bk_confirm", bookingFlowData: data }));
    expect(sendBookingRequest).not.toHaveBeenCalled();
    const doc = hoisted.docState.get("booking_requests/br-cancelled");
    expect(doc).toMatchObject({
      status: "pending", isResend: true, rate: 33, notes: "please come in through the side door",
      schedule: { days: ["Tue", "Wed"], startDate: "2026-09-22", endDate: null, ongoing: true,
        dayShiftTimes: { Tue: [{ start: "10:00", end: "15:00" }], Wed: [{ start: "11:00", end: "13:00" }] } },
      updatedAt: { __serverTimestamp: true },
    });
    expect(doc.agentTaskId).toBeUndefined();
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).bookingFlowStep).toBeUndefined();
    const sent = String(sendMessage.mock.calls.at(-1)![1]);
    expect(sent).toContain("Resent — Basra Yousuf has your booking request again");
    expect(sent).toContain("Nothing is booked until they accept");
  });

  it("does not resend if the request went back to pending on the site since the recap", async () => {
    hoisted.docState.set("booking_requests/br-cancelled", { ...CANCELLED, status: "pending" });
    const data = { caregiverId: CG_ID, caregiverName: "Basra Yousuf", hourlyRate: 31, days: ["Tuesday"], dayTimes: { Tuesday: { start: "11:00", end: "13:00" } }, ongoing: true, careLocation: "x", resendBookingRequestId: "br-cancelled" };
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: data });
    await handleBookingFlowStep(PHONE, CHAT, "yes", session({ bookingFlowStep: "bk_confirm", bookingFlowData: data }));
    expect(hoisted.docState.get("booking_requests/br-cancelled").isResend).toBeUndefined();
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("already pending with Basra Yousuf");
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).bookingFlowStep).toBeUndefined();
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

  it("YES sends it the way the site's Send Booking button does — one site-shaped booking_requests write, no agent task, no shift offer", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "confirm" }));

    await handleBookingFlowStep(PHONE, CHAT, "yes send it", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    expect(sendBookingRequest).toHaveBeenCalledTimes(1);
    const [input, opts] = sendBookingRequest.mock.calls[0];
    expect(opts).toEqual({ source: "bookingFlow" });
    expect(input).toMatchObject({
      clientId: UID, caregiverId: CG_ID, caregiverName: "Basra Yousuf",
      rate: 26, address: CONFIRM_DATA.careLocation, notes: null, jobId: null, interviewId: null,
      careNeeds: [], careRecipients: [], lifestylePreferences: [], emergencyContact: null,
      // Array-wrapped per day, keyed by the site's own 3-letter abbreviation
      // (2026-09-14, live-caught twice) — a bare {start,end} object or a
      // full weekday-name key rendered blank schedules on both dashboards.
      schedule: {
        days: ["Tue", "Thu"], startDate: "2026-09-15", endDate: null, ongoing: true,
        dayShiftTimes: { Tue: [{ start: "09:00", end: "17:00" }], Thu: [{ start: "09:00", end: "17:00" }] },
      },
    });

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBeUndefined();
    expect(stored.bookingFlowData).toBeUndefined();

    // Honest wording: the caregiver hasn't accepted — same as the site's own
    // pending state. The caregiver's notification is onBookingRequestWrite's.
    const sent = String(sendMessage.mock.calls.at(-1)![1]);
    expect(sent).toContain("Sent — Basra Yousuf has your booking request");
    expect(sent).toContain("Nothing is booked until they accept");
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
    // reject/resolve empty and sendBookingRequest would never fire.

    await handleBookingFlowStep(PHONE, CHAT, "yes", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(sendBookingRequest).toHaveBeenCalledTimes(1);
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBeUndefined();
  });

  it("the site's duplicate guard (request already pending) is reported honestly — nothing sent, flow cleared", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    sendBookingRequest.mockResolvedValueOnce({ ok: false, reason: "already_pending", bookingRequestId: "br-x" });

    await handleBookingFlowStep(PHONE, CHAT, "yes", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    const sent = String(sendMessage.mock.calls.at(-1)![1]);
    expect(sent).toContain("already have a booking request pending with Basra Yousuf");
    expect(sent).not.toContain("Sent —");
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).bookingFlowStep).toBeUndefined();
  });

  it("a caregiver whose background check is still in review gets nothing sent, and the family is told so", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    sendBookingRequest.mockResolvedValueOnce({ ok: false, reason: "caregiver_not_bookable", daysInReview: 3 });

    await handleBookingFlowStep(PHONE, CHAT, "yes", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    const sent = String(sendMessage.mock.calls.at(-1)![1]);
    expect(sent).toContain("background check is still in progress (3 days in review)");
    expect(sent).toContain("nothing was sent");
  });

  it("a write failure still reaches the family as an honest apology, not a false success", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "confirm" }));
    sendBookingRequest.mockRejectedValueOnce(new Error("booking_requests write failed"));

    await handleBookingFlowStep(PHONE, CHAT, "yes send it", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    expect(String(sendMessage.mock.calls.at(-1)![1])).toMatch(/problem|wrong|sorry/i);
    expect(String(sendMessage.mock.calls.at(-1)![1])).not.toContain("Sent —");
  });

  it("NO cancels without ever sending the booking", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "cancel" }));

    await handleBookingFlowStep(PHONE, CHAT, "actually never mind", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    expect(sendBookingRequest).not.toHaveBeenCalled();
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

    expect(sendBookingRequest).not.toHaveBeenCalled();
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

  // 2026-09-17 (live-caught on a resend): after "change the rate" → "4", the
  // flow marched on to days/times/… instead of showing the updated recap.
  it("after a rate edit from the recap, the new rate lands back on the recap — not the days question", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "edit_rate", newRate: null }));
    await handleBookingFlowStep(PHONE, CHAT, "can we change the rate", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));
    let stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_rate");
    expect(stored.bookingFlowData.editingFromConfirm).toBe(true);

    modelReplies("NO", "4"); // question check, then the rate (the back-out check runs through the unmocked OpenAI path here)
    await handleBookingFlowStep(PHONE, CHAT, "4", session({ bookingFlowStep: "bk_ask_rate" }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_confirm");
    expect(stored.bookingFlowData.hourlyRate).toBe(4);
    expect(stored.bookingFlowData.editingFromConfirm).toBe(false);
    const sent = String(sendMessage.mock.calls.at(-1)![1]);
    expect(sent).toContain("Agreed rate: $4/hr");
    expect(sent).not.toContain("What days of the week");
  });

  it("a normal first pass through the rate question still moves on to the days question", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_ask_rate", bookingFlowData: { caregiverId: CG_ID, caregiverName: "Basra Yousuf" } });
    modelReplies("NO", "26");
    await handleBookingFlowStep(PHONE, CHAT, "26", session({ bookingFlowStep: "bk_ask_rate" }));
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).bookingFlowStep).toBe("bk_ask_days");
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
