import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Full caregiver GATE harness (release-gate coverage for the money/compliance
 * path that the per-step characterization tests don't reach end-to-end).
 *
 * Two things the existing suite leaves uncovered:
 *
 *  1. A continuous multi-step walk where onboardingData ACCUMULATES across turns
 *     (the characterization test re-seeds a fresh session per step, so a field
 *     getting clobbered by a later step would pass there but fail in a real run).
 *
 *  2. The webhook-driven gates — Stripe membership → Checkr background check →
 *     Stripe Connect → caregivers/{uid} finalized to status:"active". These fire
 *     from `advanceOnboardingStep(phone, task, taskData)` (called by stripe.ts /
 *     checkr.ts), NOT from SMS turns, so a "type N messages" walk never reaches
 *     them. Here we inject the webhook tasks directly.
 *
 * Plus a dry-run SAFETY proof: under `runOnboardingDryRun`, the irreversible
 * Stripe/Checkr/Auth calls are intercepted (recorded, real clients untouched).
 *
 * No network: firebase-admin is an in-memory mock, the single-shot LLM is a
 * prompt-router fake, and `stripe` / `axios` are mocked so the gate handlers
 * record their would-be calls instead of hitting Stripe/Checkr.
 */

// ── Shared spies (hoisted so vi.mock factories can close over them) ────────────
const stripeSpies = vi.hoisted(() => ({
  accountsCreate:     vi.fn(async () => ({ id: "acct_live" })),
  accountLinksCreate: vi.fn(async () => ({ url: "https://stripe.local/connect-onboarding" })),
  checkoutCreate:     vi.fn(async () => ({ id: "cs_live", url: "https://stripe.local/checkout" })),
  identityCreate:     vi.fn(async () => ({ id: "vs_live", url: "https://stripe.local/identity" })),
  priceRetrieve:      vi.fn(async () => ({ id: "price_live", unit_amount: 0, recurring: null })),
}));
const axiosPost = vi.hoisted(() =>
  vi.fn(async () => ({ data: { invitation_url: "https://checkr.local/invite", candidate_id: "cand_live", id: "cand_live" } })),
);
// The shared candidate-first Checkr helper (checkrApi.ts) — the bg-check gate
// now goes through this instead of a raw axios invitation POST.
const checkrInvite = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => ({ invitationUrl: "https://checkr.local/invite", candidateId: "cand_live" })),
);
vi.mock("../../checkrApi", () => ({
  createCheckrInvitation: (...a: unknown[]) => checkrInvite(...a),
  checkrPost: vi.fn(),
  CheckrApiError: class CheckrApiError extends Error {},
}));

// ── In-memory Firestore + Auth mock (caregiver characterization pattern, with
//    arrayUnion/serverTimestamp added for the advanceOnboardingStep webhook path) ─
const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  let   autoId   = 0;

  const resolveSentinels = (cur: Record<string, any>, k: string, v: any) => {
    // FieldValue.arrayUnion → append to (or create) a real array so the
    // idempotency `processedWebhookTasks.includes(task)` check works.
    if (v && typeof v === "object" && Array.isArray((v as any).__arrayUnion)) {
      const prev = Array.isArray(cur[k]) ? cur[k] : [];
      cur[k] = [...prev, ...(v as any).__arrayUnion.filter((x: unknown) => !prev.includes(x))];
      return;
    }
    if (v && typeof v === "object" && (v as any).__serverTimestamp) { cur[k] = "<ts>"; return; }
    cur[k] = v;
  };

  const makeDocRef = (path: string): any => ({
    id:   path.split("/").pop(),
    path,
    get:  vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path), ref: makeDocRef(path) })),
    set:  vi.fn(async (data: any, opts?: any) => {
      const base = opts?.merge ? { ...(docState.get(path) ?? {}) } : {};
      for (const [k, v] of Object.entries(data)) resolveSentinels(base, k, v);
      docState.set(path, base);
    }),
    update: vi.fn(async (data: any) => {
      const cur = { ...(docState.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) {
        if (k.includes(".")) {
          const [head, ...rest] = k.split(".");
          cur[head] = { ...(cur[head] ?? {}), [rest.join(".")]: v };
        } else {
          resolveSentinels(cur, k, v);
        }
      }
      docState.set(path, cur);
    }),
    delete: vi.fn(async () => { docState.delete(path); }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc   = (id?: string) => makeDocRef(`${path}/${id ?? `auto_${++autoId}`}`);
    ref.add   = vi.fn(async (data: any) => { const r = makeDocRef(`${path}/auto_${++autoId}`); await r.set(data); return r; });
    ref.where = () => ref;
    ref.limit = () => ref;
    ref.orderBy = () => ref;
    ref.get   = vi.fn(async () => ({ empty: true, size: 0, docs: [] }));
    return ref;
  };

  return {
    docState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    caregiverDoc:   () => { for (const [p, d] of docState) if (p.startsWith("caregivers/")) return { path: p, data: d }; return null; },
    reset: () => { docState.clear(); autoId = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      arrayUnion:      (...v: unknown[]) => ({ __arrayUnion: v }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
      delete:          () => ({ __delete: true }),
    },
  });
  const auth = () => ({
    // Create path: getUserByPhoneNumber throws → createUser yields the uid that
    // becomes caregivers/{uid}.
    getUserByPhoneNumber: vi.fn(async () => { throw new Error("not found"); }),
    createUser:           vi.fn(async () => ({ uid: "cg-uid" })),
  });
  const storage = () => ({ bucket: () => ({ file: () => ({ save: vi.fn(), exists: vi.fn(async () => [false]) }) }) });
  return {
    __esModule: true,
    apps: [], initializeApp: vi.fn(),
    default: { apps: [], initializeApp: vi.fn(), firestore, auth, storage },
    firestore, auth, storage,
  };
});

// ── stripe / axios — record would-be calls, never hit the network ──────────────
vi.mock("stripe", () => ({
  __esModule: true,
  default: class {
    accounts     = { create: stripeSpies.accountsCreate };
    accountLinks = { create: stripeSpies.accountLinksCreate };
    checkout     = { sessions: { create: stripeSpies.checkoutCreate } };
    identity     = { verificationSessions: { create: stripeSpies.identityCreate } };
    prices       = { retrieve: stripeSpies.priceRetrieve };
  },
}));
vi.mock("axios", () => ({ __esModule: true, default: { post: axiosPost }, post: axiosPost }));

// ── Heavy / network-touching transitive deps ───────────────────────────────────
vi.mock("../../memory/memoryFiles", () => ({ initializeMemoryFiles: vi.fn(async () => {}), writeMemoryFile: vi.fn(async () => {}) }));
vi.mock("../../memory/zepClient", () => ({
  pushOnboardingDataToZep: vi.fn(async () => {}),
  addBusinessDataToZep:    vi.fn(async () => {}),
  getZepUserId:            vi.fn(() => "zep-user"),
}));
vi.mock("../../notifications", () => ({ notifyAdminNewClientSignup: vi.fn(async () => {}), notifyAdminNewCaregiverSignup: vi.fn(async () => {}) }));
vi.mock("../buildJobPost", () => ({ buildAndSaveJobPost: vi.fn(async () => {}) }));
vi.mock("../tokenService", () => ({ generateToken: vi.fn(() => "test-token"), verifyToken: vi.fn(() => ({ phone: "+15555550100" })) }));
// Dynamic import() in the stripe_connect finalize branch — stub so it resolves cheaply.

const sentMessages: Array<{ chatId: string; text: any }> = [];
vi.mock("../../linq/client", () => ({
  sendMessage:    vi.fn(async (chatId: string, text: any) => { sentMessages.push({ chatId, text }); }),
  signalThinking: vi.fn(async () => {}),
  createChat:     vi.fn(async () => ({ chat_id: "chat", service: "SMS" })),
}));
// Site parity (2026-09-26): a question / request at a caregiver gate step runs the
// real tool-bearing agent (dispatchGateTurnToQaAgent) instead of a tool-less
// canned answer. Stubbed here; the tests assert on the gate context it is handed.
const runQaAgent = vi.hoisted(() => vi.fn(async (_p: any) => {}));
vi.mock("../qaAgent", () => ({ runQaAgent: (p: any) => runQaAgent(p) }));
const gateContextOf = (): string => String(runQaAgent.mock.calls.at(-1)?.[0]?.session?.__gateContext ?? "");
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async (opts: any) => opts.fallback) }));
vi.mock("../emotionalContext", () => ({
  classifyEmotionalContext: vi.fn(async () => "calm"),
  classifyEmotionalTopic:   vi.fn(() => "general"),
  blendEmotionalContext:    vi.fn(() => ({ value: "calm", persist: null })),
  buildEmotionalContextDirective: vi.fn(() => undefined),
  EMOTIONAL_CONTEXT_TTL_MS: 1,
}));

// ── Single-shot LLM router (caregiver characterization pattern) ────────────────
let questionMode = false;   // isQuestionOrOther → YES when true
let stepAnswer   = "";      // raw value the current step's parse prompt returns
let awaitingKind = "other"; // classifyAwaitingReply verdict at awaiting steps
let wantsLink    = "NO";    // wantsGateLinkResend verdict (identity/stripe/bgcheck resend gate)
let wantsMore    = "NO";    // wantsMoreCaregivers verdict ("show me more caregivers" mid-gate)
let intakeConfirmIntent  = "confirm"; // handleClientConfirmIntake's confirm-vs-edit classification
let intakeCorrectionJson = "{}";      // extractIntakeCorrections' extracted-fields JSON
vi.mock("../../utils/openaiClient", () => ({
  quickComplete: vi.fn(async (prompt: string) => {
    if (prompt.includes("You are extracting onboarding details from one message")) return "{}";
    if (prompt.includes('"switchTo"')) return '{"switchTo":"none"}';
    if (prompt.includes("Detect if they are correcting")) return "null";
    if (prompt.includes("general question or off-topic comment")) return questionMode ? "YES" : "NO";
    if (prompt.includes("Is their message asking to see")) return wantsMore; // wantsMoreCaregivers
    if (prompt.includes("Classify their message")) return wantsLink; // wantsGateLinkResend
    if (prompt.includes("Classify the reply")) return awaitingKind;
    if (prompt.includes("You are Evia, an AI care assistant")) return "Here's a helpful answer.";
    if (prompt.includes("warm human-feeling care coordinator")) return "Here's a helpful answer."; // answerQuestionMidFlow
    if (prompt.includes("confirm or edit")) return intakeConfirmIntent;
    // 2026-09-20: handleClientConfirmIntake classifies confirm / edit / note / question in one call.
    if (prompt.includes("confirm, edit, note, or question")) return questionMode ? "question" : intakeConfirmIntent;
    if (prompt.includes("The family is correcting their care intake")) return intakeCorrectionJson;
    return stepAnswer;
  }),
}));

import { handleOnboardingStep, advanceOnboardingStep, confirmBgcheckConsent, persistClientCareRecords, continueAfterClientCollection, ensureCaregiverDocForOnboarding, mergeOnboardingData, profileMirrorForExisting } from "../onboardingConversation";
import { runOnboardingDryRun } from "../onboardingDryRun";
import { quickComplete } from "../../utils/openaiClient";

const PHONE = "+15555550100";
const CHAT  = "chat-1";
const SESSION_PATH = `agent_sessions/${PHONE}`;

// A fully-collected caregiver profile (everything the linear steps gather), used
// to seed sessions at the gate stages.
const FULL_DATA = {
  name: "Maria Lopez", email: "maria@example.com",
  city: "San Jose", zipCode: "95110",
  yearsExperience: 5, certifications: ["CNA", "CPR"],
  specialties: ["dementia", "mobility"],
  availability: { days: ["Monday", "Tuesday"], hours: "9am-5pm" },
  hourlyRate: 22, jobType: "part_time",
  gender: "female", languages: ["English"], canDrive: true,
  bio: "I treat every client like family.",
  profilePhoto: "https://storage.local/photo.jpg",
  documents: ["https://storage.local/cna.pdf"],
};

function seed(step: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const session: any = {
    chatId: CHAT, service: "SMS", optedOut: false, createdAt: "now",
    userType: "caregiver", onboardingStep: step, onboardingData: data, ...extra,
  };
  hoisted.docState.set(SESSION_PATH, { ...session });
  return session;
}
const stored = () => hoisted.docState.get(SESSION_PATH);

beforeEach(() => {
  hoisted.reset();
  sentMessages.length = 0;
  questionMode = false;
  stepAnswer = "";
  awaitingKind = "other";
  wantsLink = "NO";
  wantsMore = "NO";
  intakeConfirmIntent = "confirm";
  intakeCorrectionJson = "{}";
  stripeSpies.accountsCreate.mockClear();
  stripeSpies.accountLinksCreate.mockClear();
  stripeSpies.checkoutCreate.mockClear();
  stripeSpies.identityCreate.mockClear();
  axiosPost.mockClear();
  checkrInvite.mockClear();
});

// ── 1. Collection is now the agent loop's job (loop-only, 2026-07-08) ──────────
// The former "continuous SMS walk" of the scripted caregiver_ask_* steps was
// removed with those handlers. Conversational-collection accumulation is now
// covered by the loop-path tests (qaAgent.onboarding.test.ts + the webhook
// pre-turn absorber / persistence-net tests in handleInbound.routing.test.ts).
// This suite now starts at the FIRST GATE (caregiver_awaiting_membership onward),
// which the loop hands off to and which still runs on the KEPT gate machinery.

// ── 2. Gate webhook injection: membership → bgcheck → connect → active doc ──────
describe("caregiver gate webhooks — end-to-end to an active caregiver doc", () => {
  it("drives the money/compliance gates and finalizes caregivers/{uid} as active", async () => {
    seed("caregiver_awaiting_membership", { ...FULL_DATA });

    // Stripe membership paid → Evia sends the /bgcheck FCRA consent link.
    // NOTHING touches Checkr until the caregiver authorizes on that page
    // (webapp parity, 2026-07-08). stripe.ts stamps caregiverSubscriptionId on
    // the session BEFORE calling advanceOnboardingStep — replicate that here so
    // the membership-paid webapp mirror has its source field.
    hoisted.docState.set(SESSION_PATH, { ...stored(), caregiverSubscriptionId: "sub_live123" });
    await advanceOnboardingStep(PHONE, "membership", "");
    expect(checkrInvite).not.toHaveBeenCalled();
    expect(stored().onboardingStep).toBe("caregiver_awaiting_bgcheck_consent");
    const consentMsg = sentMessages.map((m) => JSON.stringify(m.text)).join("\n");
    expect(consentMsg).toContain("/bgcheck?t=");

    // Caregiver authorizes on the consent page → Checkr invitation fires with
    // the LEGAL name from the form + consent recorded on the caregiver doc.
    // Candidate-first contract: the helper gets the session's email — an
    // invitation without a candidate (the pre-2026-07-07 shape) is impossible.
    await confirmBgcheckConsent(PHONE, {
      legalFirstName: "Maria", legalLastName: "Lopez", zipCode: "95110", state: "CA",
    });
    expect(checkrInvite).toHaveBeenCalledTimes(1);
    expect(checkrInvite).toHaveBeenCalledWith(expect.objectContaining({
      firstName: "Maria",
      lastName:  "Lopez",
      email:     "maria@example.com",
      workState: "CA",
    }));
    expect(stored().onboardingStep).toBe("caregiver_awaiting_bgcheck");
    // FCRA paper trail matches the webapp's initiateCheckrCandidate stamp.
    // Consent (operational) stays on the parent doc; identity PII lands in the
    // owner-only private subcollection (2f205a0 migration) — the world-readable
    // parent must NOT carry the legal name.
    const cgAfterConsent = hoisted.caregiverDoc();
    expect(cgAfterConsent).not.toBeNull();
    expect(cgAfterConsent!.data.backgroundCheckData.consentGiven).toBe(true);
    expect(cgAfterConsent!.data.backgroundCheckData.legalFirstName).toBeUndefined();
    const privatePII = hoisted.docState.get(`${cgAfterConsent!.path}/private/background`);
    expect(privatePII?.legalFirstName).toBe("Maria");
    expect(privatePII?.legalLastName).toBe("Lopez");

    // Checkr cleared → Evia sets up the Stripe Connect payout account.
    await advanceOnboardingStep(PHONE, "background_check", "clear");
    expect(stripeSpies.accountsCreate).toHaveBeenCalledTimes(1);
    expect(stripeSpies.accountLinksCreate).toHaveBeenCalledTimes(1);

    // Connect onboarding returned → caregiver doc finalized.
    await advanceOnboardingStep(PHONE, "stripe_connect", "test-token");

    const cg = hoisted.caregiverDoc();
    expect(cg).not.toBeNull();
    expect(cg!.path).toBe("caregivers/cg-uid");          // uid-keyed (web/Evia data contract)
    // Site parity (2026-09-25): `status: 'active'` is the Checkr webhook's to
    // write on a clear report, and onboardingStatus 'profile_complete' lands at
    // complete_collection (the wizard's bio-save moment) — neither is written by
    // the payout finalization any more.
    expect(cg!.data.status).not.toBe("active");
    expect(cg!.data.verificationStatus).toBe("submitted");      // admin verification queue
    expect(cg!.data.name).toBe("Maria Lopez");
    expect(cg!.data.hourlyRate).toBe(22);
    // Webapp membership parity (2026-07-09): the dashboard progress card and
    // useCaregiverGate read membershipPaid from caregivers/{uid} — without it a
    // paid caregiver is stuck at "Activate your membership" forever.
    expect(cg!.data.membershipPaid).toBe(true);
    expect(cg!.data.membershipSubscriptionId).toBe("sub_live123");
    // users/{uid} parity — MCP tools and paywall winback read membershipStatus.
    const userDoc = hoisted.docState.get("users/cg-uid");
    expect(userDoc?.membershipStatus).toBe("active");
    expect(userDoc?.subscriptionActive).toBe(true);
  });

  it("membership webhook mirrors membershipPaid straight onto an existing caregiver doc", async () => {
    // Normal flow order: the gate handoff created caregivers/{uid} BEFORE the
    // membership gate, so the doc exists when payment lands (Imran's case,
    // 2026-07-09 — the mirror was missing and the webapp showed "Activate your
    // membership" despite a live active subscription).
    seed("caregiver_awaiting_membership", { ...FULL_DATA },
      { caregiverId: "cg-uid", userId: "cg-uid", caregiverSubscriptionId: "sub_live123", stripeCustomerId: "cus_live123" });
    hoisted.docState.set("caregivers/cg-uid", { uid: "cg-uid", status: "onboarding" });

    await advanceOnboardingStep(PHONE, "membership", "");

    const cg = hoisted.docState.get("caregivers/cg-uid");
    expect(cg.membershipPaid).toBe(true);
    expect(cg.membershipSubscriptionId).toBe("sub_live123");
    expect(cg.status).toBe("onboarding"); // merge — gating fields untouched
    const u = hoisted.docState.get("users/cg-uid");
    expect(u.membershipStatus).toBe("active");
    expect(u.subscriptionActive).toBe(true);
    expect(u.subscriptionId).toBe("sub_live123");
    expect(u.stripeCustomerId).toBe("cus_live123");
    // Billing portal resolves the Stripe customer from customers/{uid}.
    expect(hoisted.docState.get("customers/cg-uid")?.stripeCustomerId).toBe("cus_live123");
  });
});

// ── 3. Dry-run safety: irreversible gate calls are intercepted ─────────────────
describe("gate dry-run safety — Stripe/Checkr/Auth never fire", () => {
  it("records the Checkr invitation + Auth account instead of executing them", async () => {
    // The Checkr invitation now fires from the /bgcheck consent confirm (webapp
    // parity), not the membership webhook — dry-run wraps the consent submit.
    seed("caregiver_awaiting_bgcheck_consent", { ...FULL_DATA });

    const { recorded } = await runOnboardingDryRun(() =>
      confirmBgcheckConsent(PHONE, {
        legalFirstName: "Maria", legalLastName: "Lopez", zipCode: "95110", state: "CA",
      }),
    );

    const kinds = recorded.map((r) => r.kind);
    expect(kinds).toContain("checkr.invitation.create");
    expect(kinds).toContain("auth.createUser");
    // The real Checkr/Stripe clients were never touched.
    expect(axiosPost).not.toHaveBeenCalled();
    expect(stripeSpies.accountsCreate).not.toHaveBeenCalled();
  });

  it("records the Stripe Connect account creation under dry-run", async () => {
    // A session actually waiting on the check — the step guard (2026-09-27)
    // ignores background_check for any other step.
    seed("caregiver_awaiting_bgcheck", { ...FULL_DATA }, { caregiverId: "cg-uid" });

    const { recorded } = await runOnboardingDryRun(() =>
      advanceOnboardingStep(PHONE, "background_check", "clear"),
    );

    const kinds = recorded.map((r) => r.kind);
    expect(kinds).toContain("stripe.accounts.create");
    expect(kinds).toContain("stripe.accountLinks.create");
    expect(stripeSpies.accountsCreate).not.toHaveBeenCalled();
  });
});

// ── 4. Live status grounding for bg-check questions (founder report 2026-07-09:
// "Can you tell my background status?" got the canned "if you've finished the
// form..." hedge instead of the caregiver's actual Checkr state) ────────────────
describe("bg-check status questions are grounded in live backgroundCheckData", () => {
  // These tests inspect quickComplete's prompt history — start each from zero
  // so a prior test's "LIVE STATUS" prompt can't satisfy the wrong assertion.
  // Braces matter: mockClear() returns the mock, and a function returned from
  // beforeEach is invoked by vitest as a no-arg cleanup hook (which crashed the
  // prompt-matching mock body).
  beforeEach(() => { vi.mocked(quickComplete).mockClear(); runQaAgent.mockClear(); });

  // Site parity (2026-09-26): a status question at the bg-check gate runs the
  // real agent; the live backgroundCheckData fact rides along in its gate context.
  it("injects the LIVE submitted/in-progress state into the agent's gate context", async () => {
    const session = seed("caregiver_awaiting_bgcheck", { ...FULL_DATA }, { caregiverId: "cg-uid" });
    hoisted.docState.set("caregivers/cg-uid", {
      backgroundCheckData: {
        checkrCandidateId: "cand-1",
        submittedAt: "2026-07-08T12:00:00Z",
        invitationStatus: "completed",
      },
    });
    awaitingKind = "question";

    await handleOnboardingStep(PHONE, CHAT, "Can you tell my background status?", session);

    expect(runQaAgent).toHaveBeenCalledTimes(1);
    const ctx = gateContextOf();
    expect(ctx, "gate context should carry the live status fact").toContain("LIVE STATUS RIGHT NOW");
    expect(ctx).toContain("Checkr HAS their finished form");
    expect(ctx).toContain("submitted 2026-07-08");
  });

  it("a check that already CLEARED advances the step (webhook-missed recovery) instead of answering", async () => {
    const session = seed("caregiver_awaiting_bgcheck", { ...FULL_DATA }, { caregiverId: "cg-uid" });
    hoisted.docState.set("caregivers/cg-uid", {
      backgroundCheckData: { status: "clear", checkrCandidateId: "cand-1" },
    });
    awaitingKind = "question";

    await handleOnboardingStep(PHONE, CHAT, "any update on my check?", session);

    expect(runQaAgent).not.toHaveBeenCalled();
    expect(stored()?.onboardingStep).not.toBe("caregiver_awaiting_bgcheck");
  });

  it("fails soft to the static facts when there is no caregiver doc", async () => {
    const session = seed("caregiver_awaiting_bgcheck", { ...FULL_DATA }); // no caregiverId
    awaitingKind = "question";

    await handleOnboardingStep(PHONE, CHAT, "what's my status?", session);

    // No live fact injected, but the static step facts still ground the agent.
    const ctx = gateContextOf();
    expect(ctx).not.toContain("LIVE STATUS RIGHT NOW");
    expect(ctx).toContain("Their background check is with Checkr now");
  });
});

// ── 4b. Recall grounding at gate steps (founder report 2026-07-17: Hamse asked
// "what zip code did I share with you?" at caregiver_awaiting_membership and got
// "I don't have your zip showing" even though it was saved on the session — the
// mid-flow answer prompt carried no shared-profile facts) ──────────────────────
describe("gate questions are grounded in what the user already shared", () => {
  beforeEach(() => { vi.mocked(quickComplete).mockClear(); runQaAgent.mockClear(); });

  it("membership gate: the agent turn carries the saved city/zip/rate (site parity: real agent, no link re-blast)", async () => {
    const session = seed("caregiver_awaiting_membership", { ...FULL_DATA }, { membershipCheckoutUrl: "https://pay/membership" });
    awaitingKind = "question";

    await handleOnboardingStep(PHONE, CHAT, "What zip code did I share with you?", session);

    expect(runQaAgent).toHaveBeenCalledTimes(1);
    const ctx = gateContextOf();
    expect(ctx, "gate context should carry the shared-profile briefing").toContain("San Jose (ZIP 95110)");
    expect(ctx).toContain("rate: $22/hr");
    // The checkout link is NOT re-blasted at a question (the website doesn't
    // pop the membership modal when you ask something).
    expect(JSON.stringify(sentMessages)).not.toContain("https://pay/membership");
  });

  it("presents a bare-ZIP city (Hamse data shape) as a ZIP, not a city name", async () => {
    const session = seed("caregiver_awaiting_membership",
      { ...FULL_DATA, city: "95130", zipCode: "95130" });
    awaitingKind = "question";

    await handleOnboardingStep(PHONE, CHAT, "So what was the city I shared with you", session);

    expect(gateContextOf()).toContain("location: ZIP 95130");
  });

  it("an `other` reply at the membership gate ALSO runs the agent — the site blocks actions, not conversation", async () => {
    const session = seed("caregiver_awaiting_membership", { ...FULL_DATA }, { membershipCheckoutUrl: "https://pay/membership" });
    awaitingKind = "other";

    await handleOnboardingStep(PHONE, CHAT, "are there jobs close to my area", session);

    expect(runQaAgent).toHaveBeenCalledTimes(1);
    expect(gateContextOf()).toContain("CAREGIVER MID-SETUP (caregiver_awaiting_membership)");
    expect(JSON.stringify(sentMessages)).not.toContain("https://pay/membership");
  });
});

// ── 5. Live status grounding for EVERY gate/awaiting step (spec 2026-07-09-002:
// the bg-check fix generalized — a status question at any gate step is grounded
// in the user's real Firestore state via LIVE_GATE_FACT_BUILDERS) ──────────────
describe("gate status questions are grounded in live state (all builders)", () => {
  // See the gotcha above: mockClear() returns the mock, so use braces here or
  // vitest invokes the returned mock as a cleanup hook.
  beforeEach(() => { vi.mocked(quickComplete).mockClear(); runQaAgent.mockClear(); });

  it("membership: a payment that already WENT THROUGH is confirmed deterministically — before any reply classification, no agent turn", async () => {
    const session = seed("caregiver_awaiting_membership", { ...FULL_DATA }, { caregiverSubscriptionId: "sub_live" });
    awaitingKind = "question";
    await handleOnboardingStep(PHONE, CHAT, "did my membership payment go through?", session);
    expect(JSON.stringify(sentMessages).toLowerCase()).toContain("came through");
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("membership: fresh-read wins — stale in-hand session (no sub id) but the fresh doc shows paid", async () => {
    // The webhook stamped caregiverSubscriptionId AFTER this turn's session was
    // loaded; the handler's fresh read must see it (the race the fix targets).
    seed("caregiver_awaiting_membership", { ...FULL_DATA }, { caregiverSubscriptionId: "sub_fresh" });
    const stale: any = {
      chatId: CHAT, service: "SMS", optedOut: false, createdAt: "now",
      userType: "caregiver", onboardingStep: "caregiver_awaiting_membership", onboardingData: { ...FULL_DATA },
    };
    awaitingKind = "question";
    await handleOnboardingStep(PHONE, CHAT, "any word on my payment?", stale);
    expect(JSON.stringify(sentMessages).toLowerCase()).toContain("came through");
    expect(runQaAgent).not.toHaveBeenCalled();
  });

  it("payouts: the agent turn is told payouts are LIVE when the caregiver doc is onboarding-complete", async () => {
    const session = seed("caregiver_awaiting_stripe", { ...FULL_DATA }, { caregiverId: "cg-uid" });
    hoisted.docState.set("caregivers/cg-uid", { stripeAccountId: "acct_1", stripeOnboardingComplete: true, payoutsEnabled: true });
    awaitingKind = "question";
    await handleOnboardingStep(PHONE, CHAT, "am I set up to get paid?", session);
    expect(runQaAgent).toHaveBeenCalledTimes(1);
    expect(gateContextOf()).toContain("payouts are LIVE");
  });

  it("payouts: fails soft to the static facts when there is no caregiver doc", async () => {
    const session = seed("caregiver_awaiting_stripe", { ...FULL_DATA }); // no caregiverId
    awaitingKind = "question";
    await handleOnboardingStep(PHONE, CHAT, "how do payouts work?", session);
    const ctx = gateContextOf();
    expect(ctx).not.toContain("LIVE STATUS RIGHT NOW");
    expect(ctx, "static payout facts still ground the agent").toContain("payout link sets up their Stripe account");
  });

  it("bgcheck consent: fresh read reveals consent already authorized (composite falls to the consent builder)", async () => {
    // The composite runs the bg-check builder first; it reads the IN-HAND
    // session's caregiverId, which is stale (empty) here. The consent builder
    // then does a FRESH session read, finds the caregiverId a racing consent
    // submit just stamped, and reports the authorization is already in.
    seed("caregiver_awaiting_bgcheck_consent", { ...FULL_DATA }, { caregiverId: "cg-uid" });
    hoisted.docState.set("caregivers/cg-uid", { backgroundCheckData: { consentGiven: true } });
    const stale: any = {
      chatId: CHAT, service: "SMS", optedOut: false, createdAt: "now",
      userType: "caregiver", onboardingStep: "caregiver_awaiting_bgcheck_consent", onboardingData: { ...FULL_DATA },
    };
    awaitingKind = "question";
    await handleOnboardingStep(PHONE, CHAT, "do I still need to authorize the check?", stale);
    expect(gateContextOf()).toContain("ALREADY reviewed");
  });

  it("client payment: auto-advances (webhook-missed recovery) instead of answering WENT THROUGH and stopping", async () => {
    // 2026-09-06 live bug: a client asking "isn't that approved already?" while
    // genuinely already paid (webhook missed) got told "yes, went through" and
    // then the payment link AGAIN — contradicting itself and leaving them stuck
    // re-asking forever. The live fact is now checked before ANY reply
    // classification, so it drives the same advance path the real Stripe
    // webhook uses instead of just answering and stopping.
    const session = seed("client_awaiting_payment", {}, { userType: "client", stripeSubscriptionId: "sub_client" });
    awaitingKind = "question";
    await handleOnboardingStep(PHONE, CHAT, "did my payment go through?", session);
    expect(stored()?.processedWebhookTasks).toContain("payment");
    expect(stored()?.onboardingStep).not.toBe("client_awaiting_payment");
  });

  it("client payment: a pushback classified as `other` ALSO auto-advances instead of resending the link", async () => {
    // The actual shape of the 2026-09-06 live bug: "what do you mean I did
    // that already" classified as `other`, not `question` — the old code's
    // fix only covered the question branch, so this reply still hit the
    // unconditional resend below it. Checking the live fact before
    // classification at all closes it regardless of which bucket the reply
    // lands in.
    const session = seed("client_awaiting_payment", {}, { userType: "client", stripeSubscriptionId: "sub_client" });
    awaitingKind = "other";
    await handleOnboardingStep(PHONE, CHAT, "what do you mean I did that already", session);
    expect(stripeSpies.checkoutCreate).not.toHaveBeenCalled();
    expect(stored()?.processedWebhookTasks).toContain("payment");
    expect(stored()?.onboardingStep).not.toBe("client_awaiting_payment");
  });

  it("client identity: auto-advances (webhook-missed recovery) instead of answering VERIFIED and stopping", async () => {
    const session = seed("client_awaiting_identity", { needsIdentityVerification: false }, { userType: "client" });
    awaitingKind = "question";
    await handleOnboardingStep(PHONE, CHAT, "is my identity check done?", session);
    expect(stored()?.processedWebhookTasks).toContain("identity");
    expect(stored()?.onboardingStep).not.toBe("client_awaiting_identity");
  });

  it("client identity: a pushback classified as `other` ALSO auto-advances instead of resending the link", async () => {
    const session = seed("client_awaiting_identity", { needsIdentityVerification: false }, { userType: "client" });
    awaitingKind = "other";
    await handleOnboardingStep(PHONE, CHAT, "what do you mean I already did that", session);
    expect(stripeSpies.identityCreate).not.toHaveBeenCalled();
    expect(stored()?.processedWebhookTasks).toContain("identity");
    expect(stored()?.onboardingStep).not.toBe("client_awaiting_identity");
  });

  it("client payment: \"do you have more caregivers available\" ALSO auto-advances instead of nagging to finish membership that's already done", async () => {
    // 2026-09-06 live bug: the "show me more caregivers" branch was checked
    // BEFORE the live gate-status fact, so it unconditionally reminded the
    // family to finish membership even when it was already done (confirmed
    // live on the family's own website dashboard). The live fact must win
    // over every other branch, including this one.
    const session = seed("client_awaiting_payment", {}, { userType: "client", stripeSubscriptionId: "sub_client" });
    wantsMore = "YES";
    await handleOnboardingStep(PHONE, CHAT, "do you have more caregivers available", session);
    expect(stripeSpies.checkoutCreate).not.toHaveBeenCalled();
    expect(stored()?.processedWebhookTasks).toContain("payment");
    expect(stored()?.onboardingStep).not.toBe("client_awaiting_payment");
  });

  it("client identity: a \"show me more caregivers\" ask ALSO auto-advances instead of nagging to finish identity that's already done", async () => {
    const session = seed("client_awaiting_identity", { needsIdentityVerification: false }, { userType: "client" });
    wantsMore = "YES";
    await handleOnboardingStep(PHONE, CHAT, "any more caregivers nearby", session);
    expect(stripeSpies.identityCreate).not.toHaveBeenCalled();
    expect(stored()?.processedWebhookTasks).toContain("identity");
    expect(stored()?.onboardingStep).not.toBe("client_awaiting_identity");
  });
});

// ── 6. Pattern-B resend helpers never re-blast a paid checkout link ────────────
describe("resend helpers confirm instead of re-sending a link when payment landed", () => {
  beforeEach(() => { vi.mocked(quickComplete).mockClear(); });

  const sentText = () => sentMessages.map((m) => JSON.stringify(m.text)).join("\n");

  it("membership resend: a paid session gets a confirmation, not the checkout link again", async () => {
    const session = seed("caregiver_awaiting_membership", { ...FULL_DATA },
      { caregiverSubscriptionId: "sub_live", membershipCheckoutUrl: "https://pay/stale" });
    awaitingKind = "other"; // a plain nudge-worthy reply, not a question/ack
    await handleOnboardingStep(PHONE, CHAT, "hey", session);
    expect(sentText(), "must not re-send the stale checkout link").not.toContain("pay/stale");
    expect(sentText().toLowerCase()).toContain("came through");
  });

});

// ── 5. CLIENT care records — persisted at intake-confirm, not only at payment
//    (client-side parity wave, 2026-07-10). A family who confirms intake but
//    stalls at the paywall must still leave the wizard's records
//    (job_postings/carePlans/senior_profiles) for the webapp; the payment
//    webhook re-runs the same merge-writes and additionally mirrors the Stripe
//    customer id. Wizard parity (2026-09-23): Evia writes EXACTLY what
//    createJobPosting writes — no clientIntakes, no household senior_profiles
//    docs, no users.seniorIds, no careLevel, no conditions/diagnoses.
describe("client care records + payment mirror", () => {
  const CLIENT_UID  = "client-uid";
  const CLIENT_DATA = {
    firstName: "Hamse", seniorName: "Margaret", relationship: "mother",
    age: 82, careNeeds: ["companionship"],
    city: "San Jose", zipCode: "95110", state: "CA",
    daysPerWeek: 3, timeOfDay: "morning", hoursPerDay: 4,
    startDate: "ASAP", rate: 26,
    emergencyContactName: "Jane Doe", emergencyContactPhone: "4085551234", emergencyContactRelationship: "granddaughter",
    additionalRecipients: [{ name: "Frank", relationship: "father", age: 85 }],
  };

  it("persistClientCareRecords writes the wizard's records only: carePlans (plans + wizard emergency contact), senior_profiles (wizard shape), job_postings — no clientIntakes/seniorIds/household docs/careLevel/conditions", async () => {
    await persistClientCareRecords(CLIENT_UID, PHONE, CLIENT_DATA);

    const plan = hoisted.docState.get(`carePlans/${CLIENT_UID}`);
    expect(plan?.clientId).toBe(CLIENT_UID);
    expect(Object.keys(plan?.recipientPlans ?? {})).toHaveLength(2); // Margaret + Frank
    for (const rp of Object.values(plan?.recipientPlans ?? {}) as any[]) {
      expect(rp).not.toHaveProperty("conditions");
      expect(rp.careNeeds).toEqual(["Companionship"]);
    }
    // Same review marker the website's "Looks good" button sets — stamped here
    // because persistClientCareRecords now only runs after the family has
    // explicitly confirmed their intake summary (client_confirm_intake), not
    // the instant collection completes.
    expect(plan?.carePlanReviewedAt).toBeTruthy();
    // Emergency contact: createJobPosting's exact entry (id 'wizard', formatted phone).
    expect(plan?.emergencyContacts).toEqual([
      { id: "wizard", name: "Jane Doe", relation: "granddaughter", phone: "(408) 555-1234", isPrimary: true },
    ]);
    // No street collected → createJobPosting's locationPoolUpdate returns early; so does Evia.
    expect(plan).not.toHaveProperty("locationPool");

    const senior = hoisted.docState.get(`senior_profiles/${CLIENT_UID}`);
    expect(senior?.name).toBe("Margaret");
    expect(senior?.firstName).toBe("Margaret");
    expect(senior?.adultsCount).toBe(2);
    expect(senior?.location).toBe("San Jose, CA");
    expect(senior?.zipCode).toBe("95110");
    expect(senior?.clientId).toBe(CLIENT_UID);
    expect(senior?.needs).toEqual(["Companionship"]); // site taxonomy category (careNeedsTaxonomy.ts)
    expect(senior).not.toHaveProperty("diagnoses");
    expect(senior).not.toHaveProperty("genderPreference");

    // The wizard writes no clientIntakes doc, no household senior_profiles docs
    // and no users.seniorIds — neither does Evia.
    expect([...hoisted.docState.keys()].filter((p) => p.startsWith("clientIntakes/"))).toHaveLength(0);
    expect([...hoisted.docState.keys()].filter((p) => p.startsWith("senior_profiles/"))).toEqual([`senior_profiles/${CLIENT_UID}`]);
    expect(hoisted.docState.get(`users/${CLIENT_UID}`)).not.toHaveProperty("seniorIds");
    expect(hoisted.docState.get(`users/${CLIENT_UID}`)?.jobPostingCompleted).toBe(true);

    const jp = hoisted.docState.get(`job_postings/${CLIENT_UID}`);
    expect(jp).not.toHaveProperty("careLevel");
    expect(jp?.rate).toBe(26);
    expect(jp?.rateFlexible).toBe(false);
    expect(jp?.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/); // "ASAP" → ISO today
    expect(jp?.emergencyPhone).toBe("(408) 555-1234");
    // createJobPosting's final write clears the wizard's per-step draft cursor.
    expect(jp?.draftStep).toEqual({ __delete: true });
    expect(jp?.draftUpdatedAt).toEqual({ __delete: true });
  });

  it("persistClientCareRecords upserts ONE locationPool entry (street+zip match) with lat/lng and no `primary` marker", async () => {
    hoisted.docState.set(`carePlans/${CLIENT_UID}`, {
      locationPool: [
        { street: "9 Elm St", city: "Campbell", state: "CA", zipCode: "95008", petsInHome: false, smokingHousehold: false },
        { street: "123 main st", city: "San Jose", state: "CA", zipCode: "95110", petsInHome: false, smokingHousehold: false },
      ],
    });
    const withStreet = { ...CLIENT_DATA, street: "123 Main St", petsInHome: true, lat: 37.33, lng: -121.89 };
    await persistClientCareRecords(CLIENT_UID, PHONE, withStreet);

    const pool = hoisted.docState.get(`carePlans/${CLIENT_UID}`)?.locationPool ?? [];
    expect(pool).toHaveLength(2); // matched the existing San Jose entry — nothing replaced, nothing duplicated
    expect(pool[0].street).toBe("9 Elm St");
    expect(pool[1]).toMatchObject({ street: "123 main st", zipCode: "95110", petsInHome: true, smokingHousehold: false, lat: 37.33, lng: -121.89 });
    expect(pool[1]).not.toHaveProperty("primary");
    // job_postings carries the same geocode, like createJobPosting.
    const jp = hoisted.docState.get(`job_postings/${CLIENT_UID}`);
    expect(jp?.lat).toBe(37.33);
    expect(jp?.lng).toBe(-121.89);
  });

  // 2026-09-15: the recipient roster on job_postings/{uid} is only ever ADDED
  // to — a re-run of intake finalization must never replace recipients the
  // family added on the Care Plan page, and an existing primary stays primary.
  it("persistClientCareRecords keeps an existing roster: primary sticky, site-added recipients preserved, SMS people folded in", async () => {
    hoisted.docState.set(`job_postings/${CLIENT_UID}`, {
      careRecipientFirstName: "Samira", careRecipientLastName: "M", relationship: "parent", careRecipientAge: "22",
      additionalRecipients: [{ firstName: "Imran", lastName: "Mohammed", relationship: "brother", age: "" }],
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    await persistClientCareRecords(CLIENT_UID, PHONE, CLIENT_DATA);

    const jp = hoisted.docState.get(`job_postings/${CLIENT_UID}`);
    expect(jp?.careRecipientFirstName).toBe("Samira");
    const names = (jp?.additionalRecipients ?? []).map((r: any) => r.firstName);
    expect(names).toContain("Imran");
    expect(names).toContain("Margaret"); // the SMS primary, folded in — not displacing Samira
    expect(names).toContain("Frank");
    expect(new Set(names).size).toBe(names.length); // no duplicates
    expect(jp?.adultsCount).toBe(1 + names.length);
  });

  it("writes nothing at all when no uid resolved (no anonymous intake, no records)", async () => {
    await persistClientCareRecords(undefined, PHONE, CLIENT_DATA);
    expect([...hoisted.docState.keys()].filter((p) => p.startsWith("clientIntakes/"))).toHaveLength(0);
    expect([...hoisted.docState.keys()].filter((p) => p.startsWith("job_postings/") || p.startsWith("carePlans/"))).toHaveLength(0);
  });

  it("payment webhook mirrors stripeCustomerId onto users/{uid} AND customers/{uid} (billing portal parity)", async () => {
    seed("client_awaiting_payment", { ...CLIENT_DATA },
      { userType: "client", userId: CLIENT_UID, stripeCustomerId: "cus_test123" });

    await advanceOnboardingStep(PHONE, "payment", "sub_test123");

    const user = hoisted.docState.get(`users/${CLIENT_UID}`);
    expect(user?.subscriptionActive).toBe(true);
    expect(user?.membershipStatus).toBe("active");
    // The site's Stripe webhook field name (stripe.ts `subscriptionId`), not an
    // Evia-only alias; and no Evia-only onboardingProgress blob.
    expect(user?.subscriptionId).toBe("sub_test123");
    expect(user).not.toHaveProperty("stripeSubscriptionId");
    expect(user).not.toHaveProperty("onboardingProgress");
    expect(user?.stripeCustomerId).toBe("cus_test123");
    // customers/{uid} is where the client Payments page + the shared billing
    // portal callable resolve the Stripe customer — SMS-paid clients used to
    // have no doc here at all.
    expect(hoisted.docState.get(`customers/${CLIENT_UID}`)?.stripeCustomerId).toBe("cus_test123");
    // Care records re-persisted with the final data (no clientIntakes — wizard parity).
    expect(hoisted.docState.get(`job_postings/${CLIENT_UID}`)?.careRecipientFirstName).toBe("Margaret");
    expect(hoisted.docState.get(`carePlans/${CLIENT_UID}`)?.clientId).toBe(CLIENT_UID);
    expect(hoisted.docState.get(`clientIntakes/${CLIENT_UID}`)).toBeUndefined();
  });

  // 2026-08-22: the site's Care Plan confirmation ("Looks good") happens
  // before Identity/Membership — the SMS side used to jump straight from
  // collection to showing caregivers with no equivalent confirmation moment
  // at all. continueAfterClientCollection now routes into the existing
  // (previously-unwired) client_confirm_intake step instead of calling
  // handleClientShowCaregivers directly.
  it("continueAfterClientCollection sends the intake summary and parks at client_confirm_intake, without showing caregivers yet", async () => {
    seed("client_ask_needs", { ...CLIENT_DATA, rate: 26 }, { userType: "client", userId: CLIENT_UID });
    await continueAfterClientCollection(PHONE, CHAT);

    expect(stored().onboardingStep).toBe("client_confirm_intake");
    const last = sentMessages.map((m) => JSON.stringify(m.text)).join("\n");
    expect(last).toMatch(/did i get that right|say yes/i);
    // Caregivers/care-records only happen after explicit confirmation — this
    // call alone must not have persisted anything to carePlans yet.
    expect(hoisted.docState.has(`carePlans/${CLIENT_UID}`)).toBe(false);
  });

  it("client_confirm_intake: a correction updates the field, re-sends the summary, and does not show caregivers yet", async () => {
    const session = seed("client_confirm_intake", { ...CLIENT_DATA, rate: 20 },
      { userType: "client", userId: CLIENT_UID });
    intakeConfirmIntent = "edit";
    intakeCorrectionJson = '{"rate":30}';

    await handleOnboardingStep(PHONE, CHAT, "actually make it $30/hr", session);

    expect(stored().onboardingData.rate).toBe(30);
    expect(stored().onboardingStep).toBe("client_confirm_intake"); // still parked, re-asking
    const text = sentMessages.map((m) => JSON.stringify(m.text)).join("\n");
    expect(text).toMatch(/updated/i);
    expect(text).toMatch(/did i get that right|say yes/i); // summary re-sent
    expect(hoisted.docState.has(`carePlans/${CLIENT_UID}`)).toBe(false);
  });

  it("client_confirm_intake: a relationship correction is canonicalized the same way save_onboarding_field would", async () => {
    const session = seed("client_confirm_intake", { ...CLIENT_DATA },
      { userType: "client", userId: CLIENT_UID });
    intakeConfirmIntent = "edit";
    intakeCorrectionJson = '{"relationship":"daughter"}';

    await handleOnboardingStep(PHONE, CHAT, "I'm her daughter, not her spouse", session);

    expect(stored().onboardingData.relationship).toBe("parent");
  });

  it("client_confirm_intake: a mid-flow question is answered, not swallowed by the generic edit fallback", async () => {
    const session = seed("client_confirm_intake", { ...CLIENT_DATA },
      { userType: "client", userId: CLIENT_UID });
    questionMode = true;

    await handleOnboardingStep(PHONE, CHAT, "what is the address I gave you", session);

    const text = sentMessages.map((m) => JSON.stringify(m.text)).join("\n");
    expect(text).toMatch(/helpful answer/i); // the mocked answerQuestionMidFlow response
    expect(text).toMatch(/does that all look right|say yes/i); // re-asked, not a canned "tell me what to change"
    expect(text).not.toMatch(/tell me what to change/i);
    expect(stored().onboardingStep).toBe("client_confirm_intake");
    expect(hoisted.docState.has(`carePlans/${CLIENT_UID}`)).toBe(false);
  });

  it("client_confirm_intake: confirming proceeds to persist care records and show caregivers", async () => {
    const session = seed("client_confirm_intake", { ...CLIENT_DATA, rate: 26 },
      { userType: "client", userId: CLIENT_UID });
    intakeConfirmIntent = "confirm";

    await handleOnboardingStep(PHONE, CHAT, "yes that's right", session);

    expect(hoisted.docState.get(`carePlans/${CLIENT_UID}`)?.clientId).toBe(CLIENT_UID);
    expect(hoisted.docState.get(`carePlans/${CLIENT_UID}`)?.carePlanReviewedAt).toBeTruthy();
  });
});

// ── 6. CLIENT gate absorb (2026-07-15): a family member who volunteers a care
//    detail while parked at the identity/payment gate gets it SAVED and
//    specifically acknowledged — parity with the caregiver gate fix. ─────────
describe("client gate absorb — volunteered details at awaiting steps", () => {
  beforeEach(() => {
    hoisted.docState.clear();
    sentMessages.length = 0;
    questionMode = false;
    awaitingKind = "other";
    stepAnswer   = "";
  });

  it("saves a volunteered care need at client_awaiting_payment and reminds about the gate", async () => {
    const session = seed("client_awaiting_payment",
      { seniorName: "Rosy", careNeeds: ["companionship"] }, { userType: "client" });
    stepAnswer = '{"careNeeds":["bathing"]}'; // update-mode extraction result

    await handleOnboardingStep(PHONE, CHAT, "mom also needs help with bathing", session);

    // The volunteered task lands as the Care Plan CATEGORY (+ sub-task), never
    // the raw word — same canonicalizer as collection (2026-09-26).
    expect(stored().onboardingData.careNeeds).toEqual(["companionship", "Personal Care"]);
    expect(stored().onboardingData.careNeedDetails).toEqual({ "Personal Care": ["Bathing"] });
    const last = String(JSON.stringify(sentMessages.at(-1)?.text));
    expect(last).toMatch(/care plan|added/i);       // specific ack
    expect(last).toMatch(/membership|ready|link/i); // gate reminder still present
  });

  it("falls through to the normal payment nudge when nothing new is volunteered", async () => {
    const session = seed("client_awaiting_payment",
      { seniorName: "Rosy", careNeeds: ["companionship"] }, { userType: "client" });
    stepAnswer = "{}";

    await handleOnboardingStep(PHONE, CHAT, "hello there just checking in", session);

    expect(stored().onboardingData.careNeeds).toEqual(["companionship"]);
    expect(JSON.stringify(sentMessages.at(-1)?.text)).toMatch(/payment|link/i);
  });

  it("does not double-add a case-insensitive duplicate detail", async () => {
    const session = seed("client_awaiting_identity",
      { seniorName: "Rosy", careNeeds: ["Personal Care"] }, { userType: "client" });
    stepAnswer = '{"careNeeds":["bathing"]}';

    await handleOnboardingStep(PHONE, CHAT, "she needs help with bathing please", session);

    // "bathing" canonicalizes to the category already on file — no duplicate.
    expect(stored().onboardingData.careNeeds).toEqual(["Personal Care"]);
  });
});

// ── 7. Gate-step link RESEND (2026-07-16): every parked step owes a real link
//    on request. Prose-only replies at these steps were the "just resent it"
//    false-claim bug (Hamse, 2026-07-15) — the model kept promising a link no
//    code path could send. Resent links must go out as link PARTS (rich preview
//    cards via the isCardSafeUrl chokepoint), never model-composed URLs. ──────
describe("gate-step link resend — the link actually goes out, as a link part", () => {
  const linkParts = (): string[] => sentMessages.flatMap((m) =>
    m.text && typeof m.text === "object" && Array.isArray((m.text as any).parts)
      ? (m.text as any).parts.filter((p: any) => p.type === "link").map((p: any) => String(p.value))
      : []);

  it("client payment: a status question does NOT re-mint a link; a 'never got it' report DOES", async () => {
    const s1 = seed("client_awaiting_payment", {}, { userType: "client" });
    awaitingKind = "question";
    wantsLink = "NO";
    await handleOnboardingStep(PHONE, CHAT, "how long does this usually take?", s1);
    expect(stripeSpies.checkoutCreate).not.toHaveBeenCalled();
    expect(linkParts()).toHaveLength(0);

    sentMessages.length = 0;
    const s2 = seed("client_awaiting_payment", {}, { userType: "client" });
    wantsLink = "YES";
    await handleOnboardingStep(PHONE, CHAT, "I never got the link", s2);
    expect(stripeSpies.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(linkParts().length).toBeGreaterThan(0);
  });

  it("client identity: a status question does NOT re-mint a link; a broken-link report DOES", async () => {
    const s1 = seed("client_awaiting_identity", {}, { userType: "client" });
    awaitingKind = "question";
    wantsLink = "NO";
    await handleOnboardingStep(PHONE, CHAT, "how long does verification take?", s1);
    expect(stripeSpies.identityCreate).not.toHaveBeenCalled();
    expect(linkParts()).toHaveLength(0);

    sentMessages.length = 0;
    const s2 = seed("client_awaiting_identity", {}, { userType: "client" });
    wantsLink = "YES";
    await handleOnboardingStep(PHONE, CHAT, "that link doesn't work", s2);
    expect(stripeSpies.identityCreate).toHaveBeenCalledTimes(1);
    expect(linkParts().length).toBeGreaterThan(0);
  });

  it("stripe connect: a payout-link ask re-mints the account link", async () => {
    const session = seed("caregiver_awaiting_stripe", { ...FULL_DATA });
    awaitingKind = "other";
    wantsLink = "YES";
    await handleOnboardingStep(PHONE, CHAT, "can you send me the payout link again", session);
    expect(stripeSpies.accountLinksCreate).toHaveBeenCalledTimes(1);
    expect(linkParts()).toContain("https://stripe.local/connect-onboarding");
  });

  it("bgcheck wait: 'text me the link' honors the step's own promise — the stored Checkr invitation goes out", async () => {
    const session = seed("caregiver_awaiting_bgcheck", { ...FULL_DATA }, { bgcheckInviteUrl: "https://checkr.local/invite" });
    awaitingKind = "other";
    wantsLink = "YES";
    await handleOnboardingStep(PHONE, CHAT, "can you text me that link", session);
    expect(linkParts()).toContain("https://checkr.local/invite");
  });

  it("moved-on guard: no resend when the fresh session shows the step already advanced", async () => {
    const stale: any = {
      chatId: CHAT, service: "SMS", optedOut: false, createdAt: "now",
      userType: "caregiver", onboardingStep: "caregiver_awaiting_photo", onboardingData: { ...FULL_DATA },
    };
    seed("caregiver_send_documents", { ...FULL_DATA }); // fresh doc: already past the photo gate
    awaitingKind = "other";
    await handleOnboardingStep(PHONE, CHAT, "resend the link", stale);
    expect(linkParts()).toHaveLength(0);
  });
});

// ── A finished questionnaire stays finished (2026-09-26) ──────────────────────
// App.tsx CaregiverRoute re-opens the setup wizard whenever caregivers/{uid}
// .onboardingStatus !== 'profile_complete', resuming at `wizardStep`. Live bug:
// after an admin revoke the founder saw the wizard again at "Your availability"
// — every re-link of the record (ensureCaregiverDocForOnboarding) rewrote
// onboardingStatus 'in_progress', and every later mirror re-stamped wizardStep
// from the text draft. Both writers must leave a finished record finished.
describe("finished-profile guard — Evia's record writers never re-open the site wizard", () => {
  const FINISHED = {
    status: "onboarding", onboardingStatus: "profile_complete", wizardStep: "done",
    name: "Old Name", hourlyRate: 20,
  };
  // An OLD record: availability saved before the two-part (days + parts of the
  // day) rule, so wizardStepForDraft would now say "availability".
  const OLD_DRAFT = { ...FULL_DATA, street: "1 Main St", state: "CA", hourlyRate: 24, availability: { days: ["Monday"], hours: "" } };

  it("profileMirrorForExisting keeps a grid the site holds unless the availability answer changed (goal 5)", () => {
    const answer = { days: ["Monday"], hours: "mornings" };
    const siteGrid = { monday: [{ start: "06:00", end: "12:00" }], friday: [{ start: "12:00", end: "18:00" }] };
    const mirror = { availability: answer, weeklyAvailability: { monday: [{ start: "06:00", end: "12:00" }] } };
    // same answer as before, the site added Friday afternoons → the mirror must not touch the grid
    expect(profileMirrorForExisting(mirror, { availability: answer, weeklyAvailability: siteGrid })).toEqual({ availability: answer });
    // the caregiver changed her answer → the re-derived grid flows
    expect(profileMirrorForExisting(mirror, { availability: { days: ["Tuesday"], hours: "mornings" }, weeklyAvailability: siteGrid })).toEqual(mirror);
    // no grid on the record yet → first write flows
    expect(profileMirrorForExisting(mirror, { availability: answer })).toEqual(mirror);
  });

  it("profileMirrorForExisting drops wizardStep only for a profile_complete record", () => {
    expect(profileMirrorForExisting({ bio: "x", wizardStep: "availability" }, FINISHED))
      .toEqual({ bio: "x" });
    expect(profileMirrorForExisting({ bio: "x", wizardStep: "availability" }, { onboardingStatus: "in_progress" }))
      .toEqual({ bio: "x", wizardStep: "availability" });
    expect(profileMirrorForExisting({ bio: "x", wizardStep: "availability" }, {}))
      .toEqual({ bio: "x", wizardStep: "availability" });
  });

  it("ensureCaregiverDocForOnboarding re-linking a finished record keeps onboardingStatus/wizardStep/status and still mirrors the field values", async () => {
    hoisted.docState.set("caregivers/cg-uid", { ...FINISHED });
    seed("caregiver_awaiting_membership", OLD_DRAFT); // no caregiverId on the session → re-link path
    const uid = await ensureCaregiverDocForOnboarding(PHONE);
    expect(uid).toBe("cg-uid");
    const cg = hoisted.docState.get("caregivers/cg-uid");
    expect(cg.onboardingStatus).toBe("profile_complete");
    expect(cg.wizardStep).toBe("done");
    expect(cg.status).toBe("onboarding");
    expect(cg.hourlyRate).toBe(24);          // values still flow
    expect(cg.name).toBe("Maria Lopez");
    expect(stored().caregiverId).toBe("cg-uid");
  });

  it("ensureCaregiverDocForOnboarding seeds status/onboardingStatus/wizardStep only on a brand-new record", async () => {
    seed("caregiver_awaiting_membership", OLD_DRAFT);
    await ensureCaregiverDocForOnboarding(PHONE);
    const cg = hoisted.docState.get("caregivers/cg-uid");
    expect(cg.status).toBe("onboarding");
    expect(cg.onboardingStatus).toBe("in_progress");
    expect(cg.wizardStep).toBe("availability");
    expect(cg.createdAt).toBeTruthy();
  });

  it("ensureCaregiverDocForOnboarding never demotes an active record's status either", async () => {
    hoisted.docState.set("caregivers/cg-uid", { ...FINISHED, status: "active" });
    seed("caregiver_awaiting_stripe", OLD_DRAFT);
    await ensureCaregiverDocForOnboarding(PHONE);
    expect(hoisted.docState.get("caregivers/cg-uid").status).toBe("active");
  });

  it("mergeOnboardingData mirrors the value but not the wizard cursor once the record is profile_complete", async () => {
    hoisted.docState.set("caregivers/cg-uid", { ...FINISHED });
    seed("caregiver_awaiting_membership", OLD_DRAFT, { caregiverId: "cg-uid" });
    await mergeOnboardingData(PHONE, { bio: "Updated over text." });
    const cg = hoisted.docState.get("caregivers/cg-uid");
    expect(cg.bio).toBe("Updated over text.");
    expect(cg.wizardStep).toBe("done");
    expect(cg.onboardingStatus).toBe("profile_complete");
  });

  it("mergeOnboardingData still moves the wizard cursor while the questionnaire is in progress", async () => {
    hoisted.docState.set("caregivers/cg-uid", { status: "onboarding", onboardingStatus: "in_progress", wizardStep: "location" });
    seed("caregiver_collecting", OLD_DRAFT, { caregiverId: "cg-uid" });
    await mergeOnboardingData(PHONE, { bio: "Hi." });
    expect(hoisted.docState.get("caregivers/cg-uid").wizardStep).toBe("availability");
  });
});

// ── Care Plan tab key — recipient WITH a last name (2026-09-26) ──────────────
// The Care Plan page tabs are keyed getKey(careRecipientFirstName,
// careRecipientLastName) from the job_postings roster ("h_m" for "H M"). The
// signup writer keyed by first name only ("h_noname"), so the page never found
// Evia's plan (with the family's notes) and auto-seeded an empty one instead:
// "NOTES — No notes added yet" on a family that had given Evia a note.
describe("persistClientCareRecords — plan key matches the site's roster key", () => {
  it("keys the primary AND additional recipients first_last, carries the note, and matches the roster's split", async () => {
    const data = {
      firstName: "Hamse", seniorName: "H M", relationship: "father", age: 80,
      careNeeds: ["Dementia / Memory Care"], city: "San Jose", zipCode: "95134", state: "CA",
      daysPerWeek: 2, hoursPerDay: 4, startDate: "ASAP", rate: 28,
      jobDescription: "He gets anxious in the evenings; a calm voice helps.",
      additionalRecipients: [{ name: "Mary Ann Smith", relationship: "mother", age: 78 }],
    };
    await persistClientCareRecords("client-uid", PHONE, data);
    const plan = hoisted.docState.get("carePlans/client-uid");
    expect(Object.keys(plan.recipientPlans).sort()).toEqual(["h_m", "mary_ann_smith"]);
    expect(plan.recipientPlans.h_m.notes).toBe("He gets anxious in the evenings; a calm voice helps.");
    expect(plan.recipientPlans.h_m.age).toBe(80);
    // The roster the page keys from — same split, same names.
    const jp = hoisted.docState.get("job_postings/client-uid");
    expect(jp.careRecipientFirstName).toBe("H");
    expect(jp.careRecipientLastName).toBe("M");
    expect(jp.additionalRecipients).toEqual([expect.objectContaining({ firstName: "Mary", lastName: "Ann Smith" })]);
  });

  it("a recipient without a last name still keys first_noname (unchanged)", async () => {
    await persistClientCareRecords("client-uid", PHONE, {
      firstName: "Hamse", seniorName: "Margaret", relationship: "mother", careNeeds: ["Companionship"],
      city: "San Jose", zipCode: "95110", state: "CA", rate: 26,
    });
    expect(Object.keys(hoisted.docState.get("carePlans/client-uid").recipientPlans)).toEqual(["margaret_noname"]);
  });
});
