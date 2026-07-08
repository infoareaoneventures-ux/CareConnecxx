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
  vi.fn(async () => ({ invitationUrl: "https://checkr.local/invite", candidateId: "cand_live" })),
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
vi.mock("../../triggers/caregiverJobMatch", () => ({ notifyNewCaregiverOfJobs: vi.fn(async () => {}) }));

const sentMessages: Array<{ chatId: string; text: any }> = [];
vi.mock("../../linq/client", () => ({
  sendMessage:    vi.fn(async (chatId: string, text: any) => { sentMessages.push({ chatId, text }); }),
  signalThinking: vi.fn(async () => {}),
  createChat:     vi.fn(async () => ({ chat_id: "chat", service: "SMS" })),
}));
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
vi.mock("../../utils/openaiClient", () => ({
  quickComplete: vi.fn(async (prompt: string) => {
    if (prompt.includes("You are extracting onboarding details from one message")) return "{}";
    if (prompt.includes('"switchTo"')) return '{"switchTo":"none"}';
    if (prompt.includes("Detect if they are correcting")) return "null";
    if (prompt.includes("general question or off-topic comment")) return questionMode ? "YES" : "NO";
    if (prompt.includes("You are Evia, an AI care assistant")) return "Here's a helpful answer.";
    return stepAnswer;
  }),
}));

import { handleOnboardingStep, advanceOnboardingStep } from "../onboardingConversation";
import { runOnboardingDryRun } from "../onboardingDryRun";

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
  stripeSpies.accountsCreate.mockClear();
  stripeSpies.accountLinksCreate.mockClear();
  axiosPost.mockClear();
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

    // Stripe membership paid → Evia fires the Checkr invitation + pre-creates the doc.
    await advanceOnboardingStep(PHONE, "membership", "sub_live123");
    expect(checkrInvite).toHaveBeenCalledTimes(1);
    // Candidate-first contract: the helper gets the session's email — an
    // invitation without a candidate (the pre-2026-07-07 shape) is impossible.
    expect(checkrInvite).toHaveBeenCalledWith(expect.objectContaining({
      firstName: "Maria",
      email:     "maria@example.com",
      workState: "CA",
    }));

    // Checkr cleared → Evia sets up the Stripe Connect payout account.
    await advanceOnboardingStep(PHONE, "background_check", "clear");
    expect(stripeSpies.accountsCreate).toHaveBeenCalledTimes(1);
    expect(stripeSpies.accountLinksCreate).toHaveBeenCalledTimes(1);

    // Connect onboarding returned → caregiver doc finalized.
    await advanceOnboardingStep(PHONE, "stripe_connect", "test-token");

    const cg = hoisted.caregiverDoc();
    expect(cg).not.toBeNull();
    expect(cg!.path).toBe("caregivers/cg-uid");          // uid-keyed (web/Evia data contract)
    expect(cg!.data.status).toBe("active");
    expect(cg!.data.onboardingStatus).toBe("profile_complete"); // FindCaregivers visibility gate
    expect(cg!.data.verificationStatus).toBe("submitted");      // admin verification queue
    expect(cg!.data.name).toBe("Maria Lopez");
    expect(cg!.data.hourlyRate).toBe(22);
  });
});

// ── 3. Dry-run safety: irreversible gate calls are intercepted ─────────────────
describe("gate dry-run safety — Stripe/Checkr/Auth never fire", () => {
  it("records the Checkr invitation + Auth account instead of executing them", async () => {
    seed("caregiver_awaiting_membership", { ...FULL_DATA });

    const { recorded } = await runOnboardingDryRun(() =>
      advanceOnboardingStep(PHONE, "membership", "sub_live123"),
    );

    const kinds = recorded.map((r) => r.kind);
    expect(kinds).toContain("checkr.invitation.create");
    expect(kinds).toContain("auth.createUser");
    // The real Checkr/Stripe clients were never touched.
    expect(axiosPost).not.toHaveBeenCalled();
    expect(stripeSpies.accountsCreate).not.toHaveBeenCalled();
  });

  it("records the Stripe Connect account creation under dry-run", async () => {
    seed("caregiver_send_stripe_connect", { ...FULL_DATA }, { caregiverId: "cg-uid" });

    const { recorded } = await runOnboardingDryRun(() =>
      advanceOnboardingStep(PHONE, "background_check", "clear"),
    );

    const kinds = recorded.map((r) => r.kind);
    expect(kinds).toContain("stripe.accounts.create");
    expect(kinds).toContain("stripe.accountLinks.create");
    expect(stripeSpies.accountsCreate).not.toHaveBeenCalled();
  });
});
