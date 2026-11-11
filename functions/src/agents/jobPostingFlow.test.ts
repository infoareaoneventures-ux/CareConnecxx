// U2 — anti-invention clause + output guard on jobPostingFlow's two direct
// messages.create paths (parseWithClaude + answerQuestionMidFlow). Mocking
// pattern per caregiverProfileHandler.test.ts (vi.hoisted + firebase-admin /
// linq/client mocks). NOTE the vitest gotcha: beforeEach callbacks use braces —
// never implicitly return a value.
//
// 2026-09-07 (live-caught): parseWithClaude used to carry the shared
// ANTI_INVENTION_CLAUSE too — its "use only what's in the briefing" wording
// confused the model on these briefing-less classification prompts into
// answering with a long meta-response instead of classifying, which the
// output guard correctly (but silently, until this same fix added logging)
// rejected — a literal "occasional" reply reliably failed. parseWithClaude
// now carries CLASSIFICATION_GUARD_CLAUSE instead; only answerQuestionMidFlow
// (real free-form generation) still uses ANTI_INVENTION_CLAUSE.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const updateMock = vi.fn().mockResolvedValue(undefined);
  const docGetMock = vi.fn().mockResolvedValue({ exists: true, data: () => ({ jobPostingData: {} }) });

  const docFn = vi.fn(() => ({ update: updateMock, get: docGetMock }));
  const collectionMock = vi.fn(() => ({ doc: docFn }));

  const sendMessage    = vi.fn().mockResolvedValue({ message_id: "x" });
  const messagesCreate = vi.fn();

  return { updateMock, docGetMock, collectionMock, sendMessage, messagesCreate };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: vi.fn(() => "__DELETE__") },
  }),
}));

vi.mock("../linq/client", () => ({
  sendMessage: (...args: unknown[]) => hoisted.sendMessage(...args),
}));

// buildJobPost drags in the notifications/bookingExecutor chain (module-level
// admin.apps access) — none of it is exercised by these step-level tests.
vi.mock("./buildJobPost", () => ({
  buildAndSaveJobPost: vi.fn(async () => ({ jobId: "job-1", notifiedCount: 0 })),
  jobLiveMessage:       "Your care request is submitted! I'll reach out as soon as applications start coming in.",
}));

// The shared services mapper (caregiverServices.ts) talks to the quick model
// through utils/parseWithClaude — a separate seam from the flow's own Anthropic
// client mock below.
const mapper = vi.hoisted(() => ({ mapperReply: vi.fn(async (..._a: unknown[]) => "{}") }));
vi.mock("../utils/parseWithClaude", () => ({ parseWithClaude: (...a: unknown[]) => mapper.mapperReply(...a) }));

vi.mock("../utils/claudeClient", () => ({
  getSharedClient: () => ({
    messages: { create: (...args: unknown[]) => hoisted.messagesCreate(...args) },
  }),
}));
// 2026-11-09 (Wave 2): the eight scripted flows now call the shared model helper (OpenAI first, Anthropic backup)
// instead of Anthropic directly. These tests keep driving the model through the same queued replies.
vi.mock("./flowModelCall", () => {
  const call = async (system: string, user: string, maxTokens: number) => {
    const r: any = await hoisted.messagesCreate({ system, messages: [{ role: "user", content: user }], max_tokens: maxTokens });
    return String(r?.content?.[0]?.text ?? "").trim();
  };
  return { flowParseCall: call, flowAnswerCall: call };
});

const { sendMessage, messagesCreate } = hoisted;

import { handleJobPostingStep, JP_MIDFLOW_FALLBACK, CLASSIFICATION_GUARD_CLAUSE } from "./jobPostingFlow";
import { ANTI_INVENTION_CLAUSE } from "../utils/caraMessage";

const PHONE = "+15555550100";
const CHAT  = "chat-1";
const SESSION: any = {
  jobPostingStep: "jp_ask_start",
  // job_posting is a DEFAULT_FLIPPED_FLOWS flow (isConvergenceFlipped, on by
  // default) — dispatch resolves the step from jobPostingData, not the literal
  // jobPostingStep string above. jobFrequency pre-filled so it resolves to
  // jp_ask_start (the step these tests actually exercise) — schedule (frequency
  // /start/days/time) comes before who/where in the site's own order.
  jobPostingData: { jobFrequency: "occasional" },
  onboardingData: { seniorName: "Rosie Alvarez" },
};

// The exact leaked-incident shape: the model replies to the briefing author.
const META_OUTPUT =
  "Got it, but I need the briefing context to write this message, " +
  "who's the care provider, what shift/client situation are we talking about...";

const modelReplies = (...texts: string[]) => {
  for (const text of texts) {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: "text", text }] });
  }
};

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  messagesCreate.mockReset();
  sendMessage.mockClear();
  hoisted.updateMock.mockClear();
  delete process.env.CARA_OUTPUT_GUARD_ENABLED;
  delete process.env.CONVERGENCE_UNFLIPPED;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("jobPostingFlow — anti-invention clause (U2, R1)", () => {
  it("both direct classification calls carry CLASSIFICATION_GUARD_CLAUSE in their system prompt", async () => {
    // Call 1: isQuestionOrOther classifier ("NO" = a direct answer).
    // Call 2: start-date parse.
    modelReplies("NO", "next Monday");

    await handleJobPostingStep(PHONE, CHAT, "next monday please", SESSION);

    expect(messagesCreate).toHaveBeenCalledTimes(2);
    for (const call of messagesCreate.mock.calls) {
      expect((call[0] as { system: string }).system).toContain(CLASSIFICATION_GUARD_CLAUSE);
    }
    expect(String(sendMessage.mock.calls[0][1])).toContain("starting next Monday");
  });

  it("answerQuestionMidFlow's system prompt carries the shared ANTI_INVENTION_CLAUSE (free-form generation, not classification)", async () => {
    // Call 1: isQuestionOrOther → YES. Call 2: mid-flow answer.
    modelReplies("YES", "Great question — Evia matches you with vetted local care providers.");

    await handleJobPostingStep(PHONE, CHAT, "how does matching work?", SESSION);

    expect((messagesCreate.mock.calls[1][0] as { system: string }).system).toContain(ANTI_INVENTION_CLAUSE);
    // Guard passes → answer delivered unchanged (behavior unchanged when clean).
    expect(sendMessage.mock.calls[0][1]).toBe("Great question — Evia matches you with vetted local care providers.");
  });

  // 2026-09-08 (live-caught): this call sees only the current message, never
  // the conversation transcript — including Evia's own prior outbound texts.
  // A family replying to Evia's own interview-completion nudge ("can you
  // make it complete") got forced into job-posting terms ("are you setting
  // up a job posting?"), and asking directly "what interview do I have" got
  // a confident, false "I haven't mentioned an interview — this is our first
  // message!" Locks in the instruction that stops both: never claim
  // something was/wasn't said before, and redirect rather than guess when
  // the message is about a different topic entirely.
  it("answerQuestionMidFlow's system prompt instructs an honest redirect instead of forcing an out-of-scope question into job-posting terms", async () => {
    modelReplies("YES", "That sounds like something else — let's finish this first, and I'll help with that right after.");

    await handleJobPostingStep(PHONE, CHAT, "can you make it complete", SESSION);

    const answerSystem = (messagesCreate.mock.calls[1][0] as { system: string }).system;
    expect(answerSystem).toContain("NEVER claim something was or wasn't mentioned before");
    expect(answerSystem.toLowerCase()).toContain("let's finish this first");
  });

  // 2026-09-07 (live-caught): the classification prompt used to judge
  // relevance "to the current question" without ever stating what that
  // question WAS — a context-free guess that misclassified short, valid
  // answers like a bare "morning" as off-topic. Locks in that the actual
  // question text now rides along in the prompt.
  it("isQuestionOrOther's prompt includes the actual question being asked, not a context-free guess", async () => {
    modelReplies("NO", "next Monday");

    await handleJobPostingStep(PHONE, CHAT, "next monday please", SESSION);

    const classifySystem = (messagesCreate.mock.calls[0][0] as { system: string }).system;
    expect(classifySystem).toContain("When would you like care to start?");
  });
});

describe("jobPostingFlow — output guard (U2, R2)", () => {
  it("guard-rejected mid-flow answer → JP_MIDFLOW_FALLBACK, raw meta-response never sent", async () => {
    modelReplies("YES", META_OUTPUT);

    await handleJobPostingStep(PHONE, CHAT, "how does matching work?", SESSION);

    expect(sendMessage.mock.calls[0][1]).toBe(JP_MIDFLOW_FALLBACK);
    for (const call of sendMessage.mock.calls) {
      expect(String(call[1])).not.toContain("briefing context");
    }
  });

  it("guard-rejected parse output is a parse failure — raw user text stored, meta never echoed", async () => {
    modelReplies("NO", META_OUTPUT);

    await handleJobPostingStep(PHONE, CHAT, "whenever works for you", SESSION);

    // "__parse_error__" path: the handler stores the user's raw text instead.
    expect(String(sendMessage.mock.calls[0][1])).toContain("starting whenever works for you");
    expect(String(sendMessage.mock.calls[0][1])).not.toContain("briefing context");
  });

  it("kill switch CARA_OUTPUT_GUARD_ENABLED='false' bypasses the guard", async () => {
    process.env.CARA_OUTPUT_GUARD_ENABLED = "false";
    modelReplies("YES", META_OUTPUT);

    await handleJobPostingStep(PHONE, CHAT, "how does matching work?", SESSION);

    expect(sendMessage.mock.calls[0][1]).toBe(META_OUTPUT);
  });

  // 2026-09-07: the actual live-caught bug — jp_ask_frequency's classification
  // call carried ANTI_INVENTION_CLAUSE (briefing-framed), which confused the
  // model into a long meta-response for a literal, unambiguous "occasional"
  // reply, every single time. Locks in the fix (CLASSIFICATION_GUARD_CLAUSE
  // instead) via the same guard-rejection path, on the actual step that broke.
  it("jp_ask_frequency re-asks (not silently defaults or crashes) when the model returns a meta-response instead of classifying", async () => {
    const FREQ_SESSION: any = {
      jobPostingStep: "jp_ask_frequency",
      jobPostingData: {},
      onboardingData: { seniorName: "Rosie Alvarez" },
    };
    modelReplies("NO", META_OUTPUT);

    await handleJobPostingStep(PHONE, CHAT, "occasional", FREQ_SESSION);

    expect(String(sendMessage.mock.calls[0][1])).toContain("Sorry, I'm not sure I followed");
    expect(String(sendMessage.mock.calls[0][1])).not.toContain("briefing context");
    // Failure path never advances the step — no jobPostingStep write at all.
    expect(hoisted.updateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobPostingStep: expect.anything() })
    );
  });

  // 2026-09-08 (live-caught): "regularly" doesn't say anything about days per
  // week, but the classifier only ever offered three forced choices, so it
  // guessed "part_time" and told the family that as settled fact ("Part-time!")
  // — the family never said that. Locks in that a genuinely vague answer
  // (model correctly replies UNCLEAR) re-asks instead of forcing a guess.
  it("jp_ask_frequency re-asks instead of forcing a guess on a vague answer like \"regularly\"", async () => {
    const FREQ_SESSION: any = {
      jobPostingStep: "jp_ask_frequency",
      jobPostingData: {},
      onboardingData: { seniorName: "Rosie Alvarez" },
    };
    modelReplies("NO", "UNCLEAR");

    await handleJobPostingStep(PHONE, CHAT, "regularly", FREQ_SESSION);

    expect(String(sendMessage.mock.calls[0][1])).toContain("Sorry, I'm not sure I followed");
    expect(String(sendMessage.mock.calls[0][1])).not.toContain("Part-time");
    expect(hoisted.updateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobPostingStep: expect.anything() })
    );
  });
});

// 2026-09-08 (live-caught): the model refused outright instead of returning
// __parse_error__ or a real date value — "I need a message with a start date
// to extract. Your message doesn't contain one." — and that whole sentence
// got stored as jobStartDate and echoed in the job summary as "Start: I need
// a message...". guardModelOutput doesn't catch this (it targets a different
// meta-response shape), so the step itself must recognize a refusal isn't a
// date value.
describe("jp_ask_start (live-caught: model refusal stored as the literal start date)", () => {
  it("falls back to the user's raw text instead of storing an extraction-refusal sentence", async () => {
    modelReplies("NO", "I need a message with a start date to extract. Your message doesn't contain one.");

    await handleJobPostingStep(PHONE, CHAT, "whenever works", SESSION);

    expect(hoisted.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ jobPostingData: expect.objectContaining({ jobStartDate: "whenever works" }) })
    );
    expect(String(sendMessage.mock.calls[0][1])).not.toContain("I need a message");
  });
});

// 2026-09-08 (live-caught): a brand-new address's zip code was captured and
// stored correctly (city/state resolve from it) but never shown anywhere in
// the job summary — unlike the site's own review screen, which always
// includes it in "street, city, state zip" order — leaving the family unable
// to tell from the summary whether the zip they typed actually landed.
describe("buildJobSummary (live-caught: captured zip code never shown)", () => {
  it("includes the zip code in the location line of the confirm summary", async () => {
    hoisted.docGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        jobPostingData: {
          jobFrequency: "occasional",
          streetAddress: "1 Campbell Ave", city: "San Jose", state: "CA", zipCode: "95130",
        },
      }),
    });
    modelReplies("NO", "MAYBE");

    await handleJobPostingStep(PHONE, CHAT, "not sure", {
      ...SESSION,
      jobPostingStep: "jp_confirm_post",
      jobPostingData: { jobFrequency: "occasional" },
    });

    expect(String(sendMessage.mock.calls[0][1])).toContain("1 Campbell Ave, San Jose, CA 95130");
  });
});

// 2026-09-09 (Hamse's call): jobCareLevel is derived, never asked (see the
// JP_STEP_ORDER comment above) — showing "Care level: Moderate" in the
// confirm summary presented a silent guess as if the family had confirmed
// it. Dropped from the summary entirely; the underlying field is still
// derived and stored for matching/the site's own review step, just not
// surfaced here.
describe("buildJobSummary (2026-09-09: care level dropped from the summary)", () => {
  it("never shows a Care level line in the confirm summary", async () => {
    hoisted.docGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        jobPostingData: {
          jobFrequency: "occasional",
          jobCareNeeds: ["bathing", "medication reminders"],
          jobCareLevel: "full",
        },
      }),
    });
    modelReplies("NO", "MAYBE");

    await handleJobPostingStep(PHONE, CHAT, "not sure", {
      ...SESSION,
      jobPostingStep: "jp_confirm_post",
      jobPostingData: { jobFrequency: "occasional" },
    });

    expect(String(sendMessage.mock.calls[0][1])).not.toContain("Care level");
  });
});

// 2026-09-11 (live-caught): the LLM extraction is asked for standard category
// names but sometimes returns the finer-grained symptom/task instead
// ("bathing" rather than "Personal Care") — CarePlan.tsx then shows it as a
// flat item with no parent category, and caregiver skill-matching (tagged at
// category granularity) never finds a match. handleJpAskCareNeeds now runs
// the raw extraction through normalizeCareNeeds before storing it.
describe("handleJpAskDescription — medication instructions never reach the post (2026-10-04)", () => {
  beforeEach(() => { process.env.CONVERGENCE_UNFLIPPED = "job_posting"; });
  afterEach(() => { delete process.env.CONVERGENCE_UNFLIPPED; });

  it("refuses with the one line and asks again; nothing merged", async () => {
    mapper.mapperReply.mockResolvedValueOnce("NO"); // back-out check
    modelReplies("NO");                               // isQuestionOrOther
    await handleJobPostingStep(PHONE, CHAT, "She is lovely. Give her two pills at 8 and skip the water pill on weekends.", {
      ...SESSION,
      jobPostingStep: "jp_ask_description",
      jobPostingData: { jobFrequency: "occasional", jobCareNeeds: ["Companionship"], jobHourlyRate: 25 },
    });
    const merged = hoisted.updateMock.mock.calls.find(([arg]) => arg?.jobPostingData?.jobDescription);
    expect(merged).toBeUndefined();
    const sent = String(sendMessage.mock.calls.at(-1)?.[1]);
    expect(sent).toContain("medication instructions can't be saved here");
    expect(sent).toContain("What else should care providers know about this job?"); // the site's Details heading, verbatim (2026-10-17)
    expect(sent).toContain("Care providers browsing jobs can read this. Leave out medical details, addresses, phone numbers, email addresses, and anything private.");
  });
});

describe("handleJpAskDescription — phone numbers, emails and links never reach the post (Wave 1, 2026-11-09)", () => {
  beforeEach(() => { process.env.CONVERGENCE_UNFLIPPED = "job_posting"; });
  afterEach(() => { delete process.env.CONVERGENCE_UNFLIPPED; });

  it("refuses with the one line and asks again; nothing merged", async () => {
    mapper.mapperReply.mockResolvedValueOnce("NO"); // back-out check
    modelReplies("NO");                               // isQuestionOrOther
    await handleJobPostingStep(PHONE, CHAT, "She is lovely and loves tea. Text me on 408-555-1212 or email jo@gmail.com.", {
      ...SESSION,
      jobPostingStep: "jp_ask_description",
      jobPostingData: { jobFrequency: "occasional", jobCareNeeds: ["Companionship"], jobHourlyRate: 25 },
    });
    const merged = hoisted.updateMock.mock.calls.find(([arg]) => arg?.jobPostingData?.jobDescription);
    expect(merged).toBeUndefined();
    const sent = String(sendMessage.mock.calls.at(-1)?.[1]);
    expect(sent).toContain("Phone numbers, emails and links can't go in here");
    expect(sent).toContain("What else should care providers know about this job?");
  });
});

describe("handleJpAskCareNeeds — normalizes fine-grained terms into canonical categories (2026-09-11)", () => {
  // job_posting is a DEFAULT_FLIPPED_FLOWS flow (dispatch resolves the step
  // from field-completion, not the literal jobPostingStep string) — force the
  // literal-step dispatcher so these tests exercise handleJpAskCareNeeds
  // directly without needing every earlier field pre-filled.
  beforeEach(() => { process.env.CONVERGENCE_UNFLIPPED = "job_posting"; });
  afterEach(() => { delete process.env.CONVERGENCE_UNFLIPPED; });

  it("stores the canonical category, not the fine-grained term the model returned", async () => {
    // The answer is read FIRST (2026-10-21): the shared services mapper is the one call on this turn.
    mapper.mapperReply.mockResolvedValueOnce(JSON.stringify({ services: ["Personal Care", "Medication Reminders"], medical: [], unmapped: [] }));

    await handleJobPostingStep(PHONE, CHAT, "she needs help bathing and remembering her meds", {
      ...SESSION,
      jobPostingStep: "jp_ask_care_needs",
      jobPostingData: { jobFrequency: "occasional" },
    });

    const call = hoisted.updateMock.mock.calls.find(([arg]) => arg?.jobPostingData?.jobCareNeeds);
    expect(call?.[0].jobPostingData.jobCareNeeds).toEqual(["Medication Reminders", "Personal Care"]); // the menu's order
  });

  // 2026-10-04: the sub-task chips left the family screens — nothing is stored
  // underneath a category, and the read-back uses the shown names.
  it("stores the category only (no jobCareNeedDetails) and reads the shown names back", async () => {
    mapper.mapperReply.mockResolvedValueOnce(JSON.stringify({ services: ["Personal Care", "Medication Reminders"], medical: [], unmapped: [] }));

    await handleJobPostingStep(PHONE, CHAT, "she needs help bathing and remembering her meds", {
      ...SESSION,
      jobPostingStep: "jp_ask_care_needs",
      jobPostingData: { jobFrequency: "occasional" },
    });

    const call = hoisted.updateMock.mock.calls.find(([arg]) => arg?.jobPostingData?.jobCareNeeds);
    expect(call?.[0].jobPostingData.jobCareNeedDetails).toBeUndefined();
    const sent = hoisted.sendMessage.mock.calls.map((c) => String(c[1])).join("\n");
    expect(sent).toContain("Medication Reminders Only, Personal Care — noted!");
  });

  it("re-asks instead of storing an empty result when nothing normalizes", async () => {
    mapper.mapperReply.mockResolvedValueOnce(JSON.stringify({ services: [], medical: [], unmapped: ["not sure what she needs"] }));

    await handleJobPostingStep(PHONE, CHAT, "not sure what she needs", {
      ...SESSION,
      jobPostingStep: "jp_ask_care_needs",
      jobPostingData: { jobFrequency: "occasional" },
    });

    const call = hoisted.updateMock.mock.calls.find(([arg]) => arg?.jobPostingData?.jobCareNeeds);
    expect(call).toBeUndefined();
    expect(String(sendMessage.mock.calls[0][1])).toMatch(/isn't one of the types of care on the list/);
    expect(String(sendMessage.mock.calls[0][1])).toMatch(/what type of care/i);
    expect(String(sendMessage.mock.calls[0][1])).toContain("Mobility Assistance\nDementia / Memory Care\nMedication Reminders Only");
  });
});

describe("handleJpAskCareNeeds — child care (2026-10-18, un-framed 2026-10-19): the list follows who is on the post (no household setting), the chips only for a child", () => {
  beforeEach(() => { process.env.CONVERGENCE_UNFLIPPED = "job_posting"; });
  afterEach(() => { delete process.env.CONVERGENCE_UNFLIPPED; });

  it("child-list services make a child post: careKinds + a child title, then the child's stage in the same step (ONE stage per child, set on the child)", async () => {
    // A Both household posting for a child recipient — the relationship on the post decides the list (2026-10-18 evening).
    const CHILD_POST = { jobFrequency: "occasional", careRecipients: [{ firstName: "S", lastName: "Mahad", relationship: "Child", isSelf: false }] };
    hoisted.docGetMock.mockResolvedValue({ exists: true, data: () => ({ careKinds: ["senior", "child"], jobPostingData: CHILD_POST }) });
    mapper.mapperReply.mockResolvedValueOnce(JSON.stringify({ services: ["Supervision", "School & Homework"], medical: [], unmapped: [] })); // the answer is read first
    await handleJobPostingStep(PHONE, CHAT, "someone to watch my toddler and help with school pickup", {
      ...SESSION, userId: "fam1", jobPostingStep: "jp_ask_care_needs", jobPostingData: CHILD_POST,
    });
    const needs = hoisted.updateMock.mock.calls.find(([arg]) => arg?.jobPostingData?.jobCareNeeds)?.[0].jobPostingData;
    expect(needs.jobCareNeeds).toEqual(["Supervision", "School & Homework"]);
    expect(needs.jobCareKinds).toEqual(["child"]);
    expect(needs.jobTitle).toBe("Child care needed"); // no city on this draft — the kind still names the title
    expect(hoisted.updateMock.mock.calls.some(([arg]) => arg?.jobPostingData?.awaitingStageFor === "S")).toBe(true);
    const sent = String(sendMessage.mock.calls.at(-1)?.[1]);
    expect(sent).toContain("Supervision, School & Homework — noted! Which stage — Infant, Toddler, Preschooler, School-age, or Teen?"); // one child → no name
    expect(sent).not.toMatch(/age range|Ages \d/i);
    expect(hoisted.updateMock.mock.calls.some(([arg]) => arg?.jobPostingStep === "jp_ask_rate")).toBe(false); // rate waits for the stage
    hoisted.docGetMock.mockResolvedValue({ exists: true, data: () => ({ jobPostingData: {} }) });
  });

  it("a child who already has a stage is never asked again — straight to the rate", async () => {
    const STAGED = { jobFrequency: "occasional", careRecipients: [{ firstName: "S", lastName: "Mahad", relationship: "Child", isSelf: false, ageRange: "toddler" }] };
    hoisted.docGetMock.mockResolvedValue({ exists: true, data: () => ({ careKinds: ["senior", "child"], jobPostingData: STAGED }) });
    mapper.mapperReply.mockResolvedValueOnce(JSON.stringify({ services: ["Supervision"], medical: [], unmapped: [] }));
    await handleJobPostingStep(PHONE, CHAT, "watch him after school", { ...SESSION, userId: "fam1", jobPostingStep: "jp_ask_care_needs", jobPostingData: STAGED });
    expect(hoisted.updateMock.mock.calls.some(([arg]) => typeof arg?.jobPostingData?.awaitingStageFor === "string" && arg.jobPostingData.awaitingStageFor !== "__DELETE__")).toBe(false);
    expect(hoisted.updateMock.mock.calls.some(([arg]) => arg?.jobPostingStep === "jp_ask_rate")).toBe(true);
    expect(String(sendMessage.mock.calls.at(-1)?.[1])).toContain("Supervision — noted! What hourly rate");
    hoisted.docGetMock.mockResolvedValue({ exists: true, data: () => ({ jobPostingData: {} }) });
  });

  it("the stage answer lands on THAT child (one name, never a number, never a list) and the flow moves on to the rate", async () => {
    modelReplies("Toddler"); // the one-stage parse is the first read
    const ONE = { jobFrequency: "occasional", jobCareNeeds: ["Supervision"], jobCareKinds: ["child"], careRecipients: [{ firstName: "S", lastName: "Mahad", relationship: "Child", isSelf: false }], awaitingStageFor: "S" };
    // getJobData is read more than once on a turn — pin the parked state for the whole turn, then restore the default.
    hoisted.docGetMock.mockResolvedValue({ exists: true, data: () => ({ careKinds: ["senior", "child"], jobPostingData: ONE }) });
    await handleJobPostingStep(PHONE, CHAT, "she's a toddler", { ...SESSION, userId: "fam1", jobPostingStep: "jp_ask_care_needs", jobPostingData: ONE });
    const saved = hoisted.updateMock.mock.calls.find(([arg]) => Array.isArray(arg?.jobPostingData?.careRecipients))?.[0].jobPostingData;
    expect(saved.careRecipients).toEqual([{ firstName: "S", lastName: "Mahad", relationship: "Child", isSelf: false, ageRange: "toddler" }]);
    expect(hoisted.updateMock.mock.calls.some(([arg]) => arg?.jobPostingData?.ageRanges)).toBe(false); // never on the post
    expect(hoisted.updateMock.mock.calls.some(([arg]) => arg?.jobPostingData?.awaitingStageFor === "__DELETE__")).toBe(true);
    expect(hoisted.updateMock.mock.calls.some(([arg]) => arg?.jobPostingStep === "jp_ask_rate")).toBe(true);
    expect(String(sendMessage.mock.calls.at(-1)?.[1])).toContain("S · Toddler — noted! What hourly rate");
    hoisted.docGetMock.mockResolvedValue({ exists: true, data: () => ({ jobPostingData: {} }) });
  });

  it("two children on the post: each is asked by name, one at a time — the second question follows the first answer", async () => {
    modelReplies("Teen");
    const TWO = { jobFrequency: "occasional", jobCareNeeds: ["Supervision"], jobCareKinds: ["child"], careRecipients: [{ firstName: "S", lastName: "Mahad", relationship: "Child", isSelf: false }, { firstName: "Ali", lastName: "Mahad", relationship: "Child", isSelf: false }], awaitingStageFor: "S" };
    hoisted.docGetMock.mockResolvedValue({ exists: true, data: () => ({ careKinds: ["senior", "child"], jobPostingData: TWO }) });
    await handleJobPostingStep(PHONE, CHAT, "teenager", { ...SESSION, userId: "fam1", jobPostingStep: "jp_ask_care_needs", jobPostingData: TWO });
    const saved = hoisted.updateMock.mock.calls.find(([arg]) => Array.isArray(arg?.jobPostingData?.careRecipients))?.[0].jobPostingData;
    expect(saved.careRecipients[0].ageRange).toBe("teen");
    expect(saved.careRecipients[1].ageRange).toBeUndefined();
    expect(hoisted.updateMock.mock.calls.some(([arg]) => arg?.jobPostingData?.awaitingStageFor === "Ali")).toBe(true);
    expect(hoisted.updateMock.mock.calls.some(([arg]) => arg?.jobPostingStep === "jp_ask_rate")).toBe(false);
    expect(String(sendMessage.mock.calls.at(-1)?.[1])).toBe("S · Teen — noted! Which stage is Ali at — Infant, Toddler, Preschooler, School-age, or Teen?");
    hoisted.docGetMock.mockResolvedValue({ exists: true, data: () => ({ jobPostingData: {} }) });
  });

  it("a child service for a post with no child on it is left off and said so (no pointer to any setting) — nothing saved, the senior list re-asked", async () => {
    mapper.mapperReply.mockResolvedValueOnce(JSON.stringify({ services: ["Supervision"], medical: [], unmapped: [] }));
    await handleJobPostingStep(PHONE, CHAT, "someone to watch my son after school", {
      ...SESSION, jobPostingStep: "jp_ask_care_needs", jobPostingData: { jobFrequency: "occasional" },
    });
    expect(hoisted.updateMock.mock.calls.some(([arg]) => arg?.jobPostingData?.jobCareNeeds || arg?.jobPostingData?.jobCareKinds || arg?.careKinds)).toBe(false);
    const sent = String(sendMessage.mock.calls.at(-1)?.[1]);
    expect(sent).toContain("\"Supervision\" isn't on");
    expect(sent).toContain("so I've left it off.");
    expect(sent).not.toContain("Account Settings");
    expect(sent).toContain("Mobility Assistance\nDementia / Memory Care"); // re-asks with the senior list
    expect(sent).not.toContain("Supervision\nBaby Care");
  });

  it("the list follows the recipients on the post: a child recipient gets the child list, a parent the senior list — no household record is read", async () => {
    hoisted.docGetMock.mockResolvedValue({ exists: true, data: () => ({ careKinds: ["senior", "child"], jobPostingData: { jobFrequency: "occasional", careRecipients: [{ firstName: "S", lastName: "Mahad", relationship: "Child", isSelf: false }] } }) });
    mapper.mapperReply.mockResolvedValueOnce(JSON.stringify({ services: [], medical: [], unmapped: [] })) // nothing named → then back-out / question, then the menu again
      .mockResolvedValueOnce("NO"); // back-out check
    modelReplies("NO"); // isQuestionOrOther
    await handleJobPostingStep(PHONE, CHAT, "hmm", {
      ...SESSION, userId: "fam1", jobPostingStep: "jp_ask_care_needs", jobPostingData: { jobFrequency: "occasional", careRecipients: [{ firstName: "S", lastName: "Mahad", relationship: "Child", isSelf: false }] },
    });
    const menu = String(sendMessage.mock.calls.at(-1)?.[1]);
    expect(menu).toContain("Supervision\nBaby Care\nBathing & Dressing");
    expect(menu).not.toContain("Dementia");
    hoisted.docGetMock.mockResolvedValue({ exists: true, data: () => ({ jobPostingData: {} }) });
  });

  it("a new person who is \"Other\" is ALWAYS asked once whether they are an adult or a child; the answer rides on the recipient", async () => {
    hoisted.docGetMock.mockResolvedValue({ exists: true, data: () => ({ careKinds: ["senior", "child"], jobPostingData: { jobFrequency: "occasional", careRecipients: [], pendingNewRecipientFirstName: "Lee", pendingNewRecipientLastName: "", pendingNewRecipientRelationship: "Other", awaitingRecipientKind: true } }) });
    modelReplies("NO", "CHILD"); // isQuestionOrOther, then the two-way read (the model, never a keyword match)
    mapper.mapperReply.mockResolvedValueOnce("NO"); // back-out check
    await handleJobPostingStep(PHONE, CHAT, "a child", {
      ...SESSION, userId: "fam1", jobPostingStep: "jp_ask_recipient_relationship", jobPostingData: { jobFrequency: "occasional", careRecipients: [], pendingNewRecipientFirstName: "Lee", pendingNewRecipientRelationship: "Other", awaitingRecipientKind: true },
    });
    const saved = hoisted.updateMock.mock.calls.find(([arg]) => Array.isArray(arg?.jobPostingData?.careRecipients) && arg.jobPostingData.careRecipients.length)?.[0].jobPostingData;
    expect(saved.careRecipients).toEqual([{ firstName: "Lee", lastName: "", relationship: "Other", isSelf: false, careKind: "child" }]);
    expect(String(sendMessage.mock.calls.at(-1)?.[1])).toContain("care for Lee");
    hoisted.docGetMock.mockResolvedValue({ exists: true, data: () => ({ jobPostingData: {} }) });
  });

  it("nobody on the post yet → exactly today's menu — the senior eight, no chips, no new question", async () => {
    mapper.mapperReply.mockResolvedValueOnce(JSON.stringify({ services: ["Companionship"], medical: [], unmapped: [] }));
    await handleJobPostingStep(PHONE, CHAT, "company during the day", {
      ...SESSION, jobPostingStep: "jp_ask_care_needs", jobPostingData: { jobFrequency: "occasional" },
    });
    const needs = hoisted.updateMock.mock.calls.find(([arg]) => arg?.jobPostingData?.jobCareNeeds)?.[0].jobPostingData;
    expect(needs.jobCareKinds).toEqual(["senior"]);
    expect(needs.jobTitle).toBe("Senior care needed");
    expect(hoisted.updateMock.mock.calls.some(([arg]) => typeof arg?.jobPostingData?.awaitingStageFor === "string" && arg.jobPostingData.awaitingStageFor !== "__DELETE__")).toBe(false);
    expect(String(sendMessage.mock.calls.at(-1)?.[1])).toContain("Companionship — noted! What hourly rate");
  });
});
