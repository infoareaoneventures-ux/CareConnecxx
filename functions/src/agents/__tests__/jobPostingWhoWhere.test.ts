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
const generateCaraMessageMock = vi.fn(async (opts: any) => opts.fallback ?? "msg");
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: (...a: unknown[]) => (generateCaraMessageMock as any)(...a) }));
vi.mock("../../safety/outputGuard", () => ({
  guardModelOutput: () => ({ ok: true }),
  ANTI_INVENTION_CLAUSE: "ANTI_INVENTION",
}));
const describeSharedProfileMock = vi.fn((..._a: unknown[]) => "");
vi.mock("../profileBriefing", () => ({ describeSharedProfile: (...a: unknown[]) => describeSharedProfileMock(...a) }));
vi.mock("../buildJobPost", () => ({
  buildAndSaveJobPost: vi.fn(async () => ({ jobId: "job-1", notifiedCount: 0 })),
  jobLiveMessage: "live",
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
  describeSharedProfileMock.mockReset().mockReturnValue("");
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

  // The re-ask copy itself advertises this ("a few is fine, e.g. \"1, 2\""),
  // but until now nothing actually exercised selecting more than one person
  // at once end-to-end.
  it("selecting multiple existing people at once ('1, 2') advances with both recipients", async () => {
    hoisted.docState.set(`job_postings/${UID}`, {
      careRecipientFirstName: "Rosie", careRecipientLastName: "Alvarez", relationship: "daughter",
      additionalRecipients: [],
    });
    modelReplies("NO", JSON.stringify({ matched: [1, 2], newName: null, newRelationship: null }));

    await handleJobPostingStep(PHONE, CHAT, "1, 2", baseSession());

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingData.careRecipients).toHaveLength(2);
    expect(stored.jobPostingData.careRecipients[0].isSelf).toBe(true);
    expect(stored.jobPostingData.careRecipients[1].firstName).toBe("Rosie");
    expect(stored.jobPostingStep).toBe("jp_ask_caregivers_needed");
    expect(String(sendMessage.mock.calls[0][1])).toContain("care for you and Rosie");
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

  // 2026-09-08 (live-caught): even "Myself"/"1" — the simplest possible
  // answers — kept failing with the generic re-ask. Traced to the model
  // occasionally wrapping its JSON in a ```json code fence despite being told
  // "Return ONLY a JSON object" — JSON.parse threw, the catch silently
  // swallowed it, and the fallback (matched:[], newName:null) looked
  // identical to "nothing recognized." Locks in that a fenced response still
  // parses correctly.
  it("a JSON response wrapped in a markdown code fence still parses (not silently dropped)", async () => {
    hoisted.docState.set(`job_postings/${UID}`, {});
    modelReplies("NO", "```json\n" + JSON.stringify({ matched: [1], newName: null, newRelationship: null }) + "\n```");

    await handleJobPostingStep(PHONE, CHAT, "Myself", baseSession());

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingData.careRecipients).toHaveLength(1);
    expect(stored.jobPostingStep).toBe("jp_ask_caregivers_needed");
  });

  // 2026-09-08 (live-caught): "someone else" / "it's for another person" kept
  // getting misclassified by isQuestionOrOther as needing clarification
  // instead of being treated as a valid (if incomplete) answer — the family
  // got stuck in a "just to clarify..." loop instead of ever being asked for
  // the missing name. Locks in that these phrasings reach the extraction
  // step and are recognized as "a new person, no name yet."
  it("'someone else' / 'another person' asks specifically for the name instead of a clarifying loop", async () => {
    hoisted.docState.set(`job_postings/${UID}`, {});
    modelReplies("NO", JSON.stringify({ matched: [], newName: null, newRelationship: null, impliesNewPerson: true }));

    await handleJobPostingStep(PHONE, CHAT, "someone else", baseSession());

    expect(sendMessage.mock.calls[0][1]).toBe("Sure — what's their name?");
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

  // 2026-09-07 (live-caught): "it's someone new, my mother" correctly never
  // invents a name — but used to repeat the ENTIRE generic list-and-instructions
  // question, which read as "didn't understand anything." Now it asks
  // specifically for the missing name and remembers the stated relationship.
  it("a relationship stated with no name yet asks specifically for the name, remembering the relationship", async () => {
    hoisted.docState.set(`job_postings/${UID}`, {});
    modelReplies("NO", JSON.stringify({ matched: [], newName: null, newRelationship: "Parent" }));

    await handleJobPostingStep(PHONE, CHAT, "it's someone new, my mother", baseSession());

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingData.pendingNewRecipientRelationship).toBe("Parent");
    expect(stored.jobPostingStep).toBe("jp_ask_recipients"); // unchanged — still collecting the name
    expect(sendMessage.mock.calls[0][1]).toBe("Sure — what's their name?");
  });

  it("a bare name given next completes using the remembered relationship, without re-asking it", async () => {
    hoisted.docState.set(`job_postings/${UID}`, {});
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      jobPostingStep: "jp_ask_recipients",
      jobPostingData: { ...SCHEDULED, pendingNewRecipientRelationship: "Parent" },
    });
    modelReplies("NO", JSON.stringify({ matched: [], newName: "Rosie", newRelationship: null }));

    await handleJobPostingStep(PHONE, CHAT, "Rosie", baseSession({
      jobPostingData: { ...SCHEDULED, pendingNewRecipientRelationship: "Parent" },
    }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingData.careRecipients).toEqual([
      { firstName: "Rosie", lastName: "", relationship: "Parent", isSelf: false },
    ]);
    expect(stored.jobPostingStep).toBe("jp_ask_caregivers_needed"); // no relationship re-ask
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

// 2026-09-07 (live-caught): a mid-flow question asked while posting a job for
// someone NEW used to be answered grounded in the ACCOUNT's original on-file
// senior (onboardingData.seniorName) — completely unrelated to the new
// recipient actually being set up in this same conversation. A user setting
// up care for "David" got a reply about "Rosie Alvarez" (the account's
// original senior) instead.
describe("answerQuestionMidFlow grounding (live-caught: wrong recipient in mid-flow answers)", () => {
  it("grounds in the job's actual in-progress recipient, not the account's unrelated on-file senior", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      jobPostingStep: "jp_ask_caregivers_needed",
      jobPostingData: { ...SCHEDULED, careRecipients: [{ firstName: "David", lastName: "", relationship: "Parent", isSelf: false }] },
    });
    // Call 1: isQuestionOrOther → YES. Call 2: mid-flow free-form answer.
    modelReplies("YES", "Most families just need one caregiver for a job like this.");

    await handleJobPostingStep(PHONE, CHAT, "how many do most people pick?", baseSession({
      jobPostingStep: "jp_ask_caregivers_needed",
      jobPostingData: { ...SCHEDULED, careRecipients: [{ firstName: "David", lastName: "", relationship: "Parent", isSelf: false }] },
    }));

    const answerCallSystem = (messagesCreate.mock.calls[1][0] as { system: string }).system;
    expect(answerCallSystem).toContain("David");
    expect(answerCallSystem).not.toContain("Rosie");
  });

  // 2026-09-08 (live-caught, same conversation): the "for David" line above
  // fixed the first sentence, but describeSharedProfile's own WHO'S WHO
  // framing — built from the ACCOUNT's original onboarding senior — still got
  // appended right after it, flatly contradicting the correct grounding
  // ("...for you." immediately followed by "the recipient is Samira M...
  // never for {accountHolder}"). The model followed the louder, more
  // specific sentence. Locks in that sharedProfile is skipped once a
  // job-specific recipient is known.
  it("does not append describeSharedProfile's stale WHO'S WHO framing once a job-specific recipient is known", async () => {
    describeSharedProfileMock.mockReturnValue(
      "WHO'S WHO: the recipient is Samira M (their parent): all care is for Samira M, never for Anahi."
    );
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      jobPostingStep: "jp_ask_caregivers_needed",
      jobPostingData: { ...SCHEDULED, careRecipients: [{ firstName: "David", lastName: "", relationship: "Parent", isSelf: false }] },
    });
    modelReplies("YES", "Most families just need one caregiver for a job like this.");

    await handleJobPostingStep(PHONE, CHAT, "how many do most people pick?", baseSession({
      jobPostingStep: "jp_ask_caregivers_needed",
      jobPostingData: { ...SCHEDULED, careRecipients: [{ firstName: "David", lastName: "", relationship: "Parent", isSelf: false }] },
    }));

    const answerCallSystem = (messagesCreate.mock.calls[1][0] as { system: string }).system;
    expect(answerCallSystem).not.toContain("Samira M");
  });

  it("still includes describeSharedProfile's grounding when no job-specific recipient is known yet", async () => {
    describeSharedProfileMock.mockReturnValue(
      "WHO'S WHO: the recipient is Samira M (their parent): all care is for Samira M, never for Anahi."
    );
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      jobPostingStep: "jp_ask_recipients",
      jobPostingData: { ...SCHEDULED },
    });
    modelReplies("YES", "Great question!");

    await handleJobPostingStep(PHONE, CHAT, "how does this work?", baseSession());

    const answerCallSystem = (messagesCreate.mock.calls[1][0] as { system: string }).system;
    expect(answerCallSystem).toContain("Samira M");
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

  // Same class as bookingFlow's interview picker (live, 2026-09-14): a bare
  // in-range number is a strict-protocol reply and must never reach the model.
  it("a bare number 1-4 is taken directly with no model call", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      jobPostingStep: "jp_ask_caregivers_needed",
      jobPostingData: { ...SCHEDULED, careRecipients: [ROSIE] },
    });
    hoisted.docState.set(`job_postings/${UID}`, { street: "4746 Campbell Ave", city: "San Jose", state: "CA", zipCode: "95130" });
    // No modelReplies queued.

    await handleJobPostingStep(PHONE, CHAT, "2", baseSession({
      jobPostingStep: "jp_ask_caregivers_needed",
      jobPostingData: { ...SCHEDULED, careRecipients: [ROSIE] },
    }));

    expect(messagesCreate).not.toHaveBeenCalled();
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingData.caregiversNeeded).toBe(2);
    expect(stored.jobPostingStep).toBe("jp_ask_location");
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

  it("a bare number picks a listed address directly with no model call", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      jobPostingStep: "jp_ask_location",
      jobPostingData: { ...SCHEDULED, careRecipients: [ROSIE], caregiversNeeded: 1 },
    });
    hoisted.docState.set(`job_postings/${UID}`, {
      street: "4746 Campbell Ave", city: "San Jose", state: "CA", zipCode: "95130",
      petsInHome: true, smokingHousehold: false,
    });
    // No modelReplies queued.

    await handleJobPostingStep(PHONE, CHAT, "1", baseSession({
      jobPostingStep: "jp_ask_location",
      jobPostingData: { ...SCHEDULED, careRecipients: [ROSIE], caregiversNeeded: 1 },
    }));

    expect(messagesCreate).not.toHaveBeenCalled();
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingData.streetAddress).toBe("4746 Campbell Ave");
    expect(stored.jobPostingData.isNewLocation).toBe(false);
    expect(stored.jobPostingStep).toBe("jp_ask_care_needs");
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

// 2026-09-08 (live-caught): a bare "yes" confirming the final post got
// misclassified by isQuestionOrOther as off-topic — the classifier's own
// prompt hardcoded "someone else"/"another person" examples from the
// recipients step, which had nothing to do with a YES/NO confirm and
// distracted the model into answering a generic "let's get started" message
// instead of ever reaching the actual post. The family saw a friendly-
// sounding but wrong reply and the job silently never posted.
describe("jp_confirm_post (live-caught: a bare 'yes' never actually posted the job)", () => {
  const READY_JOB_DATA = {
    ...SCHEDULED, careRecipients: [ROSIE], caregiversNeeded: 1,
    streetAddress: "4746 Campbell Ave", city: "San Jose", state: "CA", zipCode: "95130",
  };

  it("a bare 'yes' posts the job — not misclassified as off-topic", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { jobPostingStep: "jp_confirm_post", jobPostingData: READY_JOB_DATA, userId: UID });
    modelReplies("NO", "YES");

    await handleJobPostingStep(PHONE, CHAT, "yes", baseSession({ jobPostingStep: "jp_confirm_post", jobPostingData: READY_JOB_DATA }));

    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingStep).toBeUndefined();
    expect(stored.jobPostingData).toBeUndefined();
  });

  it("the confirm-step classification prompt carries no leftover wording from an unrelated question", async () => {
    hoisted.docState.set(`agent_sessions/${PHONE}`, { jobPostingStep: "jp_confirm_post", jobPostingData: READY_JOB_DATA, userId: UID });
    modelReplies("NO", "YES");

    // Not a bare "yes"-class word (see TRIVIAL_CONFIRM_WORDS in stepHandler.ts)
    // so this still exercises the real classify call being asserted on below —
    // a canonical bare "yes" now skips it entirely by design.
    await handleJobPostingStep(PHONE, CHAT, "looks good, post it", baseSession({ jobPostingStep: "jp_confirm_post", jobPostingData: READY_JOB_DATA }));

    const classifySystem = (messagesCreate.mock.calls[0][0] as { system: string }).system;
    expect(classifySystem).not.toContain("someone else");
    expect(classifySystem).toContain("Confirming whether to post this job");
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

  // 2026-09-08 (live-caught): the opening message used to pass
  // describeWhoIsWho(onboardingData) as context — the ACCOUNT's original
  // onboarding senior — before the flow has ever asked who THIS job is for
  // (that's jp_ask_recipients, which runs after the schedule questions,
  // matching the site's own wizard order). A family saying "I want to post a
  // new job" got told "We're setting up care for Samira M" before ever being
  // asked, even when posting for someone else entirely. The opening context
  // must stay recipient-neutral.
  it("the opening message never names or assumes a specific care recipient", async () => {
    generateCaraMessageMock.mockClear();
    await startJobPostingFlow(PHONE, CHAT, baseSession());

    const opts = generateCaraMessageMock.mock.calls[0][0] as { context: string };
    expect(opts.context).not.toContain("Rosie");
    expect(opts.context.toLowerCase()).toContain("do not name or assume");
  });
});
