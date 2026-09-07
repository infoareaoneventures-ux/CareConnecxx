import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-09-07 parity build: jobPostingFlow.ts gained a "who/where" section
// (jp_ask_recipients → jp_ask_caregivers_needed → jp_ask_location) matching
// the website's Step2WhoWhere.tsx — reading the SAME job_postings/carePlans
// collections the site's own recipient/location picker reads from, so a
// person or address added over SMS shows up on the site's picker too, and
// vice versa. Runs AFTER the schedule questions (frequency/start/days/time),
// matching PostJobFlow.tsx's real step order (Step1Schedule before
// Step2WhoWhere) — these tests cover the new step handlers directly.

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
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async (opts: any) => opts.fallback ?? "msg") }));
vi.mock("../../safety/outputGuard", () => ({
  guardModelOutput: () => ({ ok: true }),
  ANTI_INVENTION_CLAUSE: "ANTI_INVENTION",
}));
vi.mock("../profileBriefing", () => ({ describeSharedProfile: () => "" }));
vi.mock("../buildJobPost", () => ({
  buildAndSaveJobPost: vi.fn(async () => ({ jobId: "job-1", notifiedCount: 0 })),
  jobLiveMessage: vi.fn(() => "live"),
  notifiedOutcomePhrase: vi.fn(() => "notified"),
}));
const messagesCreate = vi.fn();
vi.mock("../../utils/claudeClient", () => ({
  getSharedClient: () => ({ messages: { create: (...a: unknown[]) => messagesCreate(...a) } }),
}));
vi.mock("../../utils/geocode", () => ({
  lookupZipPlace: vi.fn(async (zip: string) => (zip === "95130" ? { city: "San Jose", state: "CA", lat: 37.29, lng: -121.9 } : null)),
}));

import { handleJobPostingStep, startJobPostingFlow } from "../jobPostingFlow";

const PHONE = "+15551234567";
const CHAT  = "chat-1";
const UID   = "client-uid";

// Schedule already answered — the who/where steps run after it, so the U13
// auto-resolver (job_posting is flipped on by default) only lands on a
// who/where step when these are already filled.
const SCHEDULED = { jobFrequency: "occasional", jobStartDate: "ASAP", jobDays: ["Monday"], jobTimeOfDay: ["morning"] };
const ROSIE = { firstName: "Rosie", lastName: "", relationship: "Parent", isSelf: false };

function baseSession(overrides: Record<string, unknown> = {}): any {
  return {
    phone: PHONE, chatId: CHAT, userId: UID, userType: "client",
    onboardingData: { seniorName: "Rosie Alvarez", firstName: "Anahi", relationship: "daughter" },
    jobPostingStep: "jp_ask_recipients",
    jobPostingData: { ...SCHEDULED },
    ...overrides,
  };
}

// Queue canned model replies in call order (isQuestionOrOther is always the
// first call in every handler that has one).
function modelReplies(...texts: string[]) {
  for (const text of texts) messagesCreate.mockResolvedValueOnce({ content: [{ text }] });
}

beforeEach(() => {
  hoisted.reset();
  sendMessage.mockClear();
  messagesCreate.mockReset();
  hoisted.docState.set(`agent_sessions/${PHONE}`, { jobPostingStep: "jp_ask_recipients", jobPostingData: { ...SCHEDULED } });
});

describe("jp_ask_recipients", () => {
  it("selecting an existing person from the numbered list advances to caregivers-needed", async () => {
    hoisted.docState.set(`job_postings/${UID}`, {
      careRecipientFirstName: "Rosie", careRecipientLastName: "Alvarez", relationship: "daughter",
      additionalRecipients: [],
    });
    modelReplies("NO", JSON.stringify({ matched: [2], newName: null, newRelationship: null }));

    await handleJobPostingStep(PHONE, CHAT, "Rosie", baseSession());

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingData.careRecipients).toHaveLength(1);
    expect(stored.jobPostingData.careRecipients[0].firstName).toBe("Rosie");
    expect(stored.jobPostingStep).toBe("jp_ask_caregivers_needed");
    expect(String(sendMessage.mock.calls[0][1])).toContain("How many caregivers");
  });

  it("a brand-new name with no stated relationship asks the relationship before advancing", async () => {
    hoisted.docState.set(`job_postings/${UID}`, {});
    modelReplies("NO", JSON.stringify({ matched: [], newName: "David", newRelationship: null }));

    await handleJobPostingStep(PHONE, CHAT, "It's for David", baseSession());

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingStep).toBe("jp_ask_recipient_relationship");
    expect(stored.jobPostingData.pendingNewRecipientFirstName).toBe("David");
    expect(String(sendMessage.mock.calls[0][1])).toContain("relationship to David");
  });

  it("garbage input that matches nothing and names nobody is a re-ask, not a fabricated pick", async () => {
    hoisted.docState.set(`job_postings/${UID}`, {});
    modelReplies("NO", JSON.stringify({ matched: [], newName: null, newRelationship: null }));

    await handleJobPostingStep(PHONE, CHAT, "asdkjh", baseSession());

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingData.careRecipients).toBeUndefined();
    expect(stored.jobPostingStep).toBe("jp_ask_recipients");
    expect(String(sendMessage.mock.calls[0][1])).toContain("Sorry, I didn't quite catch that");
  });
});

describe("jp_ask_recipient_relationship", () => {
  it("a valid relationship chip completes the pending new recipient and advances", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      jobPostingStep: "jp_ask_recipient_relationship",
      jobPostingData: { ...SCHEDULED, careRecipients: [], pendingNewRecipientFirstName: "David", pendingNewRecipientLastName: "" },
    });
    modelReplies("NO", "Parent");

    await handleJobPostingStep(PHONE, CHAT, "he's my dad", baseSession({ jobPostingStep: "jp_ask_recipient_relationship" }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingData.careRecipients).toEqual([
      { firstName: "David", lastName: "", relationship: "Parent", isSelf: false },
    ]);
    expect(stored.jobPostingStep).toBe("jp_ask_caregivers_needed");
  });
});

describe("jp_ask_caregivers_needed", () => {
  it("a valid number 1-4 advances to location with the known list shown", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      jobPostingStep: "jp_ask_caregivers_needed",
      jobPostingData: { ...SCHEDULED, careRecipients: [ROSIE] },
    });
    hoisted.docState.set(`job_postings/${UID}`, { street: "4746 Campbell Ave", city: "San Jose", state: "CA", zipCode: "95130" });
    modelReplies("NO", "2");

    await handleJobPostingStep(PHONE, CHAT, "two please", baseSession({
      jobPostingStep: "jp_ask_caregivers_needed",
      jobPostingData: { ...SCHEDULED, careRecipients: [ROSIE] },
    }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingData.caregiversNeeded).toBe(2);
    expect(stored.jobPostingStep).toBe("jp_ask_location");
    expect(String(sendMessage.mock.calls[0][1])).toContain("Campbell Ave");
  });

  it("an unrecognized answer re-asks instead of defaulting to 1", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      jobPostingStep: "jp_ask_caregivers_needed",
      jobPostingData: { ...SCHEDULED, careRecipients: [ROSIE] },
    });
    modelReplies("NO", "__parse_error__");

    await handleJobPostingStep(PHONE, CHAT, "hmm not sure", baseSession({
      jobPostingStep: "jp_ask_caregivers_needed",
      jobPostingData: { ...SCHEDULED, careRecipients: [ROSIE] },
    }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingData.caregiversNeeded).toBeUndefined();
    expect(String(sendMessage.mock.calls[0][1])).toContain("Sorry, I didn't quite catch that");
  });
});

describe("jp_ask_location", () => {
  it("selecting an existing address reuses its stored pets/smoking and skips straight to care needs", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      jobPostingStep: "jp_ask_location",
      jobPostingData: { ...SCHEDULED, careRecipients: [ROSIE], caregiversNeeded: 1 },
    });
    hoisted.docState.set(`job_postings/${UID}`, {
      street: "4746 Campbell Ave", city: "San Jose", state: "CA", zipCode: "95130",
      petsInHome: true, smokingHousehold: false,
    });
    modelReplies("NO", JSON.stringify({ matchedIndex: 1, newStreet: null, newZip: null }));

    await handleJobPostingStep(PHONE, CHAT, "the campbell one", baseSession({
      jobPostingStep: "jp_ask_location",
      jobPostingData: { ...SCHEDULED, careRecipients: [ROSIE], caregiversNeeded: 1 },
    }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingData.streetAddress).toBe("4746 Campbell Ave");
    expect(stored.jobPostingData.petsInHome).toBe(true);
    expect(stored.jobPostingData.isNewLocation).toBe(false);
    // 2026-09-07 (Hamse's call): jobTitle is silently filled with the site's
    // own default the moment the address/city is known — never asked.
    expect(stored.jobPostingData.jobTitle).toBe("Senior care in San Jose");
    expect(stored.jobPostingStep).toBe("jp_ask_care_needs");
    expect(String(sendMessage.mock.calls[0][1])).toContain("What kind of care");
    expect(String(sendMessage.mock.calls[0][1])).not.toContain("pets"); // no re-ask of pets/smoking
    expect(String(sendMessage.mock.calls[0][1])).not.toContain("title"); // never asked
  });

  it("a brand-new address asks pets/smoking before advancing", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      jobPostingStep: "jp_ask_location",
      jobPostingData: { ...SCHEDULED, careRecipients: [ROSIE], caregiversNeeded: 1 },
    });
    hoisted.docState.set(`job_postings/${UID}`, {});
    modelReplies("NO", JSON.stringify({ matchedIndex: null, newStreet: "88 Oak St", newZip: "95130" }));

    await handleJobPostingStep(PHONE, CHAT, "88 Oak St, 95130", baseSession({
      jobPostingStep: "jp_ask_location",
      jobPostingData: { ...SCHEDULED, careRecipients: [ROSIE], caregiversNeeded: 1 },
    }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingData.streetAddress).toBe("88 Oak St");
    expect(stored.jobPostingData.city).toBe("San Jose");
    expect(stored.jobPostingData.isNewLocation).toBe(true);
    expect(stored.jobPostingData.jobTitle).toBe("Senior care in San Jose");
    expect(stored.jobPostingStep).toBe("jp_ask_location_environment");
    expect(String(sendMessage.mock.calls[0][1])).toContain("pets");
  });
});

describe("jp_ask_location_environment", () => {
  it("pets/smoking answer completes the new location and advances to care needs", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      jobPostingStep: "jp_ask_location_environment",
      jobPostingData: { ...SCHEDULED, careRecipients: [ROSIE], streetAddress: "88 Oak St", isNewLocation: true },
    });
    modelReplies("NO", "NO", "NO");

    await handleJobPostingStep(PHONE, CHAT, "no pets, no smoking", baseSession({ jobPostingStep: "jp_ask_location_environment" }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingData.petsInHome).toBe(false);
    expect(stored.jobPostingData.smokingHousehold).toBe(false);
    expect(stored.jobPostingStep).toBe("jp_ask_care_needs");
    expect(String(sendMessage.mock.calls[0][1])).toContain("What kind of care");
  });
});

describe("startJobPostingFlow", () => {
  it("kicks off at jp_ask_frequency (schedule questions run before who/where)", async () => {
    await startJobPostingFlow(PHONE, CHAT, baseSession());
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingStep).toBe("jp_ask_frequency");
    expect(stored.jobPostingData).toEqual({});
    expect(String(sendMessage.mock.calls[0][1])).toContain("How often");
  });
});
