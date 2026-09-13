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
    expect(sendMessage.mock.calls.map((c: any[]) => c[1]).join(" | ")).toContain("What hourly rate");
  });

  it("skips the rate question when a linked job post already has one, and moves to days", async () => {
    hoisted.docState.set("video_interviews/iv1", { clientId: UID, caregiverId: CG_ID, applicationId: "app1" });
    hoisted.docState.set("job_applications/app1", { jobId: "job1" });
    hoisted.docState.set("job_posts/job1", { title: "Care", rate: "25" });

    await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID, interviewId: "iv1" });

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowData.hourlyRate).toBe(25);
    expect(stored.bookingFlowStep).toBe("bk_ask_days");
    expect(sendMessage.mock.calls.map((c: any[]) => c[1]).join(" | ")).toContain("What days would you like");
  });

  it("skips straight to the times question when the linked job post already lists days", async () => {
    hoisted.docState.set("video_interviews/iv1", { clientId: UID, caregiverId: CG_ID, applicationId: "app1" });
    hoisted.docState.set("job_applications/app1", { jobId: "job1" });
    hoisted.docState.set("job_posts/job1", { title: "Care", rate: "25", daysOfWeek: ["Monday", "Wednesday"] });

    await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID, interviewId: "iv1" });

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_times");
    expect(stored.bookingFlowData.scheduleKind).toBe("recurring");
    expect(stored.bookingFlowData.days).toEqual(["Monday", "Wednesday"]);
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
    expect(String(sendMessage.mock.calls[1][1])).toContain("What hourly rate");
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

    modelReplies("NO", "09:00", "17:00");
    await handleBookingFlowStep(PHONE, CHAT, "9am to 5pm", session({ bookingFlowStep: "bk_ask_times", bookingFlowData: stored.bookingFlowData }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_ongoing");

    modelReplies("NO", JSON.stringify({ ongoing: true }));
    await handleBookingFlowStep(PHONE, CHAT, "ongoing", session({ bookingFlowStep: "bk_ask_ongoing", bookingFlowData: stored.bookingFlowData }));
    stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_confirm");
    expect(stored.bookingFlowData.ongoing).toBe(true);
    expect(stored.bookingFlowData.careLocation).toBe("1 Elm St, Springfield, CA, 90000");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("Reply YES to send it");
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
    modelReplies("NO", "09:00", "17:00");
    await handleBookingFlowStep(PHONE, CHAT, "9am to 5pm", session({ bookingFlowStep: "bk_ask_times", bookingFlowData: timesData }));
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_confirm");
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
    expect(stored.bookingFlowStep).toBe("bk_confirm");
  });

  it("an ambiguous address list is asked, and picking by number advances to confirm", async () => {
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
    expect(stored.bookingFlowStep).toBe("bk_confirm");
    expect(stored.bookingFlowData.careLocation).toBe("2 Oak Ave, Springfield, CA, 90000");
  });
});

describe("bk_confirm", () => {
  const CONFIRM_DATA = {
    caregiverId: CG_ID, caregiverName: "Basra Yousuf", hourlyRate: 26,
    scheduleKind: "recurring", days: ["Tuesday", "Thursday"], startTime: "09:00", endTime: "17:00", ongoing: true,
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

  it("an in-message rate correction updates the rate in place and re-shows the recap", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "edit_rate", newRate: 30 }));

    await handleBookingFlowStep(PHONE, CHAT, "actually make it $30/hr", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    expect(createBookingTask).not.toHaveBeenCalled();
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowData.hourlyRate).toBe(30);
    expect(stored.bookingFlowStep).toBe("bk_confirm");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("Rate: $30/hr");
  });

  it("a rate-change request with no stated number re-asks the rate question", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA });
    modelReplies(JSON.stringify({ action: "edit_rate", newRate: null }));

    await handleBookingFlowStep(PHONE, CHAT, "wait, let's change the rate", session({ bookingFlowStep: "bk_confirm", bookingFlowData: CONFIRM_DATA }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_rate");
    expect(String(sendMessage.mock.calls.at(-1)![1])).toContain("What hourly rate");
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
});

describe("buildBookingRecap", () => {
  it("lists every section in the site modal's order", () => {
    const recap = buildBookingRecap({
      caregiverId: CG_ID, caregiverName: "Basra Yousuf", hourlyRate: 26,
      scheduleKind: "recurring", days: ["Tuesday", "Thursday"], startTime: "09:00", endTime: "17:00",
      careLocation: "1 Elm St, Springfield, CA, 90000",
      careRecipients: [{ name: "Samira M", relationship: "parent", age: "22" }, { name: "Imran Mohammed" }],
      topLevelCareNeeds: ["Meal Preparation", "Personal Care"],
      emergencyContact: { name: "Bo", phone: "4086370483", relationship: "Daughter" },
    });
    const order = ["Caregiver:", "Rate:", "Schedule:", "Care recipients:", "Care needs:", "Lifestyle", "Care location:", "Emergency contact:"];
    let lastIndex = -1;
    for (const label of order) {
      const idx = recap.indexOf(label);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
    expect(recap).toContain("Samira M (parent, Age 22)");
    expect(recap).toContain("Reply YES to send it to Basra Yousuf");
  });
});
