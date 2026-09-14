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

  const makeCollRef = (collName: string): any => ({ doc: (id: string) => makeDocRef(collName, id) });

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
vi.mock("../bookingExecutor", () => ({ createBookingTask: (params: unknown) => createBookingTask(params) }));

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

beforeEach(() => {
  hoisted.reset();
  sendMessage.mockClear();
  messagesCreate.mockReset();
  createBookingTask.mockClear();
  createBookingTask.mockResolvedValue("task-1");
  seedCaregiver();
});

describe("startBookingFlow", () => {
  it("asks for the rate when no job post rate is known", async () => {
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
    expect(lastMsg).toContain("What days would you like");
    expect(lastMsg).toContain("Monday, Wednesday");

    modelReplies("NO", JSON.stringify({ kind: "recurring", days: ["Monday", "Wednesday"] }));
    await handleBookingFlowStep(PHONE, CHAT, "Monday and Wednesday works", session({ bookingFlowStep: "bk_ask_days", bookingFlowData: stored.bookingFlowData }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_times");
    expect(stored.bookingFlowData.scheduleKind).toBe("recurring");
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
    modelReplies("NO", JSON.stringify({ kind: "recurring", days: ["Tuesday", "Thursday"] }));

    await handleBookingFlowStep(PHONE, CHAT, "every Tue and Thu", session({ bookingFlowStep: "bk_ask_days", bookingFlowData: daysData }));
    let stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_times");
    expect(stored.bookingFlowData.days).toEqual(["Tuesday", "Thursday"]);

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
    const daysData = { caregiverId: CG_ID, caregiverName: "Basra Yousuf", hourlyRate: 26, scheduleKind: "recurring", days: ["Tuesday", "Thursday"] };
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
      scheduleKind: "recurring", days: ["Tuesday"], jobPostEndDate: "2026-12-01",
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
    const ongoingData = { caregiverId: CG_ID, caregiverName: "Basra Yousuf", hourlyRate: 26, scheduleKind: "recurring", days: ["Tuesday"], startTime: "09:00", endTime: "17:00" };
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

  it("an ambiguous address list is asked, and picking by number advances to the message ask, then confirm", async () => {
    const ongoingData = { caregiverId: CG_ID, caregiverName: "Basra Yousuf", hourlyRate: 26, scheduleKind: "recurring", days: ["Tuesday"], startTime: "09:00", endTime: "17:00" };
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
    scheduleKind: "recurring", days: ["Tuesday", "Thursday"],
    dayTimes: { Tuesday: { start: "09:00", end: "17:00" }, Thursday: { start: "09:00", end: "17:00" } },
    ongoing: true,
    careLocation: "1 Elm St, Springfield, CA, 90000",
  };

  it("YES commits via createBookingTask directly and clears the flow", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "confirm" }));

    await handleBookingFlowStep(PHONE, CHAT, "yes send it", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    expect(createBookingTask).toHaveBeenCalledTimes(1);
    const call = createBookingTask.mock.calls[0][0];
    expect(call.caregiverId).toBe(CG_ID);
    expect(call.hourlyRate).toBe(26);
    expect(call.schedule.dayShiftTimes).toEqual({
      Tuesday: { start: "09:00", end: "17:00" },
      Thursday: { start: "09:00", end: "17:00" },
    });
    expect(call.schedule.ongoing).toBe(true);
    expect(call.careLocation).toBe(CONFIRM_DATA.careLocation);

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBeUndefined();
    expect(stored.bookingFlowData).toBeUndefined();
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("Sent to Basra Yousuf");
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
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("What days would you like");
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
      scheduleKind: "recurring", days: ["Tuesday", "Thursday"],
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
    expect(recap).toContain("Tuesday 9:00 AM–5:00 PM, Thursday 10:00 AM–2:00 PM");
    expect(recap).toContain("Samira M (parent, Age 22): Meal Preparation, Personal Care");
    expect(recap).toContain("Notes: likes to go shopping");
    expect(recap).toContain("Lifestyle: prefers quiet");
    expect(recap).toContain("Imran Mohammed: Bathing");
    expect(recap).toContain("Notes: None");
    expect(recap).toContain("Care location: 1 Elm St, Springfield, CA, 90000 (Smoking household)");
    expect(recap).toContain("Reply YES to send it to Basra Yousuf");
  });
});
