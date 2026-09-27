import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * U9 (R13) — gate-link resend cooldown, plus U12 (R17) — the removed
 * caregiver_awaiting_identity step routes to the defensive default.
 *
 * The 2026-07-16 resend wave made every parked awaiting step owe a REAL link
 * on an `other`-classified reply — but with no throttle, every "hm" / "ok but"
 * re-blasted the link card. This suite proves the per-step 10-minute cooldown:
 *
 *  - first `other` → link resent + gateLinkResentAt[step] stamped
 *  - `other` inside the window → DETERMINISTIC copy (never a fresh-send claim)
 *  - bare LINK → one real resend per window (the escape hatch the copy promises)
 *  - `question` / paid-short-circuit / corrupt-state paths untouched (fail-open)
 *
 * Harness: caraGateWalk.test.ts pattern — in-memory firebase-admin, prompt-router
 * LLM fake, recorded sendMessage. No network.
 * VITEST GOTCHA: beforeEach callbacks use braces — a returned mock is invoked
 * as a cleanup hook.
 */

// ── Shared spies (hoisted so vi.mock factories can close over them) ────────────
const stripeSpies = vi.hoisted(() => ({
  accountsCreate:     vi.fn(async () => ({ id: "acct_live" })),
  accountLinksCreate: vi.fn(async () => ({ url: "https:///pay/" })),
  checkoutCreate:     vi.fn(async () => ({ id: "cs_live", url: "https:///pay/" })),
  identityCreate:     vi.fn(async () => ({ id: "vs_live", url: "https://stripe.local/identity" })),
  priceRetrieve:      vi.fn(async () => ({ id: "price_live", unit_amount: 0, recurring: null })),
}));
const axiosPost = vi.hoisted(() =>
  vi.fn(async () => ({ data: { invitation_url: "https://checkr.local/invite", candidate_id: "cand_live", id: "cand_live" } })),
);
const checkrInvite = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => ({ invitationUrl: "https://checkr.local/invite", candidateId: "cand_live" })),
);
vi.mock("../../checkrApi", () => ({
  createCheckrInvitation: (...a: unknown[]) => checkrInvite(...a),
  checkrPost: vi.fn(),
  CheckrApiError: class CheckrApiError extends Error {},
}));

// ── In-memory Firestore + Auth mock (caraGateWalk pattern; dotted-path update
//    support matters here — the cooldown stamps write `gateLinkResentAt.<step>`) ─
const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  let   autoId   = 0;

  const resolveSentinels = (cur: Record<string, any>, k: string, v: any) => {
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

vi.mock("../../memory/memoryFiles", () => ({ initializeMemoryFiles: vi.fn(async () => {}), writeMemoryFile: vi.fn(async () => {}) }));
vi.mock("../../memory/zepClient", () => ({
  pushOnboardingDataToZep: vi.fn(async () => {}),
  addBusinessDataToZep:    vi.fn(async () => {}),
  getZepUserId:            vi.fn(() => "zep-user"),
}));
vi.mock("../../notifications", () => ({ notifyAdminNewClientSignup: vi.fn(async () => {}), notifyAdminNewCaregiverSignup: vi.fn(async () => {}) }));
vi.mock("../buildJobPost", () => ({ buildAndSaveJobPost: vi.fn(async () => {}) }));
vi.mock("../tokenService", () => ({ generateToken: vi.fn(() => "test-token"), verifyToken: vi.fn(() => ({ phone: "+15555550100" })) }));
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
// Site parity (2026-09-26): a question / `other` at a caregiver gate step runs the
// real tool-bearing agent instead of re-blasting the link — stubbed here.
const runQaAgent = vi.hoisted(() => vi.fn(async (_p: any) => {}));
vi.mock("../qaAgent", () => ({ runQaAgent: (p: any) => runQaAgent(p) }));

// ── Single-shot LLM router (caraGateWalk pattern) ──────────────────────────────
let questionMode   = false;   // isQuestionOrOther → YES when true
let stepAnswer     = "";      // raw value the current step's parse prompt returns
let awaitingKind   = "other"; // classifyAwaitingReply verdict at awaiting steps
let wantsLink      = "NO";    // wantsGateLinkResend verdict
let classifierBoom = false;   // classifyAwaitingReply's LLM call THROWS (defaults to `other`)
vi.mock("../../utils/openaiClient", () => ({
  quickComplete: vi.fn(async (prompt: string) => {
    if (prompt.includes("You are extracting onboarding details from one message")) return "{}";
    if (prompt.includes('"switchTo"')) return '{"switchTo":"none"}';
    if (prompt.includes("Detect if they are correcting")) return "null";
    if (prompt.includes("general question or off-topic comment")) return questionMode ? "YES" : "NO";
    if (prompt.includes("Classify their message")) return wantsLink; // wantsGateLinkResend
    if (prompt.includes("Classify the reply")) {
      if (classifierBoom) throw new Error("model unavailable");
      return awaitingKind;
    }
    if (prompt.includes("You are Evia, an AI care assistant")) return "Here's a helpful answer.";
    return stepAnswer;
  }),
}));

import { handleOnboardingStep } from "../onboardingConversation";
import { GATE_LINK_RESEND_COOLDOWN_MS, stampGateLinkResent } from "../gateLinkCooldown";

const PHONE = "+15555550100";
const CHAT  = "chat-1";
const SESSION_PATH = `agent_sessions/${PHONE}`;

const FULL_DATA = {
  name: "Maria Lopez", email: "maria@example.com",
  city: "San Jose", zipCode: "95110",
  yearsExperience: 5, specialties: ["dementia"],
  hourlyRate: 22, jobType: "part_time",
  profilePhoto: "https://storage.local/photo.jpg",
};

function seed(step: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const session: any = {
    chatId: CHAT, service: "SMS", optedOut: false, createdAt: "now",
    userType: "caregiver", onboardingStep: step, onboardingData: data,
    ...(step === "client_awaiting_payment" ? GATE_EXTRA : {}), ...extra,
  };
  hoisted.docState.set(SESSION_PATH, { ...session });
  return session;
}
const stored = () => hoisted.docState.get(SESSION_PATH);

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const linkParts = (): string[] => sentMessages.flatMap((m) =>
  m.text && typeof m.text === "object" && Array.isArray((m.text as any).parts)
    ? (m.text as any).parts.filter((p: any) => p.type === "link").map((p: any) => String(p.value))
    : []);
const sentText = () => sentMessages
  .map((m) => (typeof m.text === "string" ? m.text : JSON.stringify(m.text)))
  .join("\n");

// The step under test for the resendGateLink-based path.
// 2026-09-25: the photo gate moved into the collection loop; the resendGateLink
// cooldown path is exercised on the family payment wait step instead (its `other`
// branch resends the checkout link through the same resendGateLink).
const PHOTO_STEP = "client_awaiting_payment";
const GATE_EXTRA = { userType: "client", userId: "client-uid" };
// Cooldown state helpers: stamps live as per-step maps on the session doc.
const cooldownState = (resentMinsAgo: number, extra: Record<string, unknown> = {}) => ({
  gateLinkResentAt: { [PHOTO_STEP]: minutesAgo(resentMinsAgo) },
  ...extra,
});

beforeEach(() => {
  hoisted.reset();
  sentMessages.length = 0;
  questionMode   = false;
  stepAnswer     = "";
  awaitingKind   = "other";
  wantsLink      = "NO";
  classifierBoom = false;
  stripeSpies.checkoutCreate.mockClear();
});

describe("U9 — gate-link resend cooldown (resendGateLink path)", () => {
  it("first `other` inbound resends the link AND stamps gateLinkResentAt[step]", async () => {
    const session = seed(PHOTO_STEP, { ...FULL_DATA });
    awaitingKind = "other";

    await handleOnboardingStep(PHONE, CHAT, "can you resend the link", session);

    expect(linkParts().some((u) => u.includes("/pay/"))).toBe(true);
    const stamp = stored()?.gateLinkResentAt?.[PHOTO_STEP];
    expect(typeof stamp).toBe("string");
    expect(isNaN(Date.parse(stamp))).toBe(false);
    // The stamp is fresh (this turn's send opened the window).
    expect(Date.now() - Date.parse(stamp)).toBeLessThan(60_000);
  });

  it("second `other` 2 minutes later: NO link card, deterministic copy (never a fresh-send claim)", async () => {
    const session = seed(PHOTO_STEP, { ...FULL_DATA }, cooldownState(2));
    awaitingKind = "other";

    await handleOnboardingStep(PHONE, CHAT, "hm okay where is it", session);

    expect(linkParts()).toHaveLength(0);
    const out = sentText();
    expect(out).toContain("reply LINK");
    expect(out).toContain("about 2 minutes ago");
    // Truthfulness: no completed-action claim of a send that didn't happen.
    expect(out).not.toContain("just sent");
    expect(out).not.toContain("resent it");
  });

  it('"can you send it again?" during cooldown (classified `other`) gets the same deterministic copy', async () => {
    const session = seed(PHOTO_STEP, { ...FULL_DATA }, cooldownState(3));
    awaitingKind = "other"; // classifyAwaitingReply files resend asks under `other`

    await handleOnboardingStep(PHONE, CHAT, "can you send it again?", session);

    expect(linkParts()).toHaveLength(0);
    expect(sentText()).toContain("reply LINK");
    expect(sentText()).not.toContain("just sent");
  });

  it("bare LINK during cooldown resends once; a second LINK in the same window gets TRUTHFUL spent copy", async () => {
    const session = seed(PHOTO_STEP, { ...FULL_DATA }, cooldownState(2));

    // First LINK — the escape hatch: real resend, bypass consumed.
    await handleOnboardingStep(PHONE, CHAT, "  link ", session);
    expect(linkParts().some((u) => u.includes("/pay/"))).toBe(true);
    const bypassStamp = stored()?.gateLinkBypassUsedAt?.[PHOTO_STEP];
    expect(typeof bypassStamp).toBe("string");

    // Second LINK, same window — no second card, and the copy is TRUTHFUL:
    // it acknowledges the recent resend with a minutes count and points at the
    // window reset. It must NOT re-promise "reply LINK" (the hatch is spent)
    // and must NOT claim a fresh send happened this turn.
    sentMessages.length = 0;
    await handleOnboardingStep(PHONE, CHAT, "LINK", stored());
    expect(linkParts()).toHaveLength(0);
    const out = sentText();
    expect(out).not.toContain("reply LINK");
    expect(out).not.toContain("just sent");
    expect(out).not.toContain("just resent");
    expect(out).toContain("I resent that link about 1 minute ago");
    expect(out).toMatch(/send it again in about \d+ minutes?/);
  });

  it("a window opened by the stale-session NUDGE throttles the next `other` inbound (shared stamp)", async () => {
    // FIX 2 (2026-07-17): the daily nudge cron re-delivers gate links via
    // resendStuckStep and stamps gateLinkResentAt[step] through the shared
    // gateLinkCooldown module — so a nudge followed by an immediate `other`
    // reply must get the deterministic cooldown copy, NOT a second link card
    // within the same minute.
    const session = seed(PHOTO_STEP, { ...FULL_DATA });
    await stampGateLinkResent(PHONE, PHOTO_STEP); // what the nudge writes after its link send
    awaitingKind = "other";

    await handleOnboardingStep(PHONE, CHAT, "hm okay", stored() ?? session);

    expect(linkParts()).toHaveLength(0);
    expect(sentText()).toContain("reply LINK");
    expect(sentText()).toContain("about 1 minute ago");
    expect(sentText()).not.toContain("just sent");
  });

  it("classifier ERROR during cooldown (defaults to `other`): deterministic copy, no crash, no resend", async () => {
    const session = seed(PHOTO_STEP, { ...FULL_DATA }, cooldownState(4));
    classifierBoom = true; // classifyAwaitingReply's LLM call throws → `other`

    await handleOnboardingStep(PHONE, CHAT, "hello anyone there", session);

    expect(linkParts()).toHaveLength(0);
    expect(sentText()).toContain("reply LINK");
  });

  it("an `other` inbound 11+ minutes after the stamp resends again (window expired)", async () => {
    const session = seed(PHOTO_STEP, { ...FULL_DATA }, cooldownState(11));
    awaitingKind = "other";

    await handleOnboardingStep(PHONE, CHAT, "still waiting on that link", session);

    expect(linkParts().some((u) => u.includes("/pay/"))).toBe(true);
    // A fresh window opened: the stamp was rewritten to now-ish.
    const stamp = stored()?.gateLinkResentAt?.[PHOTO_STEP];
    expect(Date.now() - Date.parse(stamp)).toBeLessThan(60_000);
  });

  it("a `question` during cooldown is answered normally — the cooldown never mutes answers", async () => {
    const session = seed(PHOTO_STEP, { ...FULL_DATA }, cooldownState(2));
    awaitingKind = "question";
    wantsLink    = "YES"; // a broken-link report — the question path re-mints the real link

    await handleOnboardingStep(PHONE, CHAT, "the link doesn't open for me", session);

    // Answer went out and the question path's real-link follow stayed intact.
    expect(sentMessages.length).toBeGreaterThan(0);
    expect(linkParts().some((u) => u.includes("/pay/"))).toBe(true);
    // No in-cooldown copy on the question path.
    expect(sentText()).not.toContain("reply LINK and I'll resend it");
  });

  it("corrupt cooldown state fails OPEN — resend proceeds", async () => {
    // Both corruption shapes: a non-map field and an unparseable stamp.
    const s1 = seed(PHOTO_STEP, { ...FULL_DATA }, { gateLinkResentAt: "garbage" });
    awaitingKind = "other";
    await handleOnboardingStep(PHONE, CHAT, "resend it please", s1);
    expect(linkParts().some((u) => u.includes("/pay/"))).toBe(true);

    sentMessages.length = 0;
    const s2 = seed(PHOTO_STEP, { ...FULL_DATA }, { gateLinkResentAt: { [PHOTO_STEP]: "not-a-date" } });
    await handleOnboardingStep(PHONE, CHAT, "resend it please", s2);
    expect(linkParts().some((u) => u.includes("/pay/"))).toBe(true);
  });

  it("expired window sanity: the TTL constant is 10 minutes", () => {
    expect(GATE_LINK_RESEND_COOLDOWN_MS).toBe(10 * 60 * 1000);
  });
});

describe("U9 — membership / MVR checkout resends", () => {
  const MEMBERSHIP_STEP = "caregiver_awaiting_membership";

  // Site parity (2026-09-26): the website never re-opens the membership modal
  // because you typed something — it blocks ACTIONS only. So an `other` reply
  // at the membership gate now runs the real agent (tools + the gate inside the
  // action tools) instead of re-blasting the checkout link; only the LINK
  // keyword, a broken-link report and the stale-session nudge resend it.
  it("`other` at the membership gate runs the agent — the checkout link is NOT re-blasted, no window stamped", async () => {
    const session = seed(MEMBERSHIP_STEP, { ...FULL_DATA }, { membershipCheckoutUrl: "https://pay/membership" });
    awaitingKind = "other";
    runQaAgent.mockClear();

    await handleOnboardingStep(PHONE, CHAT, "hey", session);

    expect(runQaAgent).toHaveBeenCalledTimes(1);
    expect(linkParts()).toHaveLength(0);
    expect(stored()?.gateLinkResentAt?.[MEMBERSHIP_STEP]).toBeUndefined();
  });

  it("a broken-link report at the membership gate resends the checkout link and stamps the window", async () => {
    const session = seed(MEMBERSHIP_STEP, { ...FULL_DATA }, { membershipCheckoutUrl: "https://pay/membership" });
    awaitingKind = "other";
    wantsLink = "YES";
    runQaAgent.mockClear();

    await handleOnboardingStep(PHONE, CHAT, "the link doesn't work, send it again", session);

    expect(runQaAgent).not.toHaveBeenCalled();
    expect(linkParts()).toContain("https://pay/membership");
    expect(typeof stored()?.gateLinkResentAt?.[MEMBERSHIP_STEP]).toBe("string");
  });

  it("already-paid short-circuit beats the cooldown — confirms, never links, never cooldown-copies", async () => {
    const session = seed(MEMBERSHIP_STEP, { ...FULL_DATA }, {
      caregiverSubscriptionId: "sub_live",
      membershipCheckoutUrl:   "https://pay/stale",
      gateLinkResentAt: { [MEMBERSHIP_STEP]: minutesAgo(2) },
    });
    awaitingKind = "other";

    await handleOnboardingStep(PHONE, CHAT, "hey", session);

    expect(sentText()).not.toContain("pay/stale");
    expect(sentText()).not.toContain("reply LINK");
    expect(sentText().toLowerCase()).toContain("came through");
  });

  it("bare LINK during a membership cooldown resends the checkout link (bypass), once per window", async () => {
    const session = seed(MEMBERSHIP_STEP, { ...FULL_DATA }, {
      membershipCheckoutUrl: "https://pay/membership",
      gateLinkResentAt: { [MEMBERSHIP_STEP]: minutesAgo(3) },
    });

    await handleOnboardingStep(PHONE, CHAT, "LINK", session);
    expect(linkParts()).toContain("https://pay/membership");
    expect(typeof stored()?.gateLinkBypassUsedAt?.[MEMBERSHIP_STEP]).toBe("string");

    // Second LINK, same window — truthful spent copy: acknowledges the recent
    // resend + window reset, never re-promises LINK, never claims a fresh send.
    sentMessages.length = 0;
    await handleOnboardingStep(PHONE, CHAT, "link", stored());
    expect(linkParts()).toHaveLength(0);
    const out = sentText();
    expect(out).not.toContain("reply LINK");
    expect(out).not.toContain("just sent");
    expect(out).toContain("I resent that link about 1 minute ago");
    expect(out).toMatch(/send it again in about \d+ minutes?/);
  });

  it("paid membership + LINK: paid confirmation path, NO cooldown/bypass stamp written", async () => {
    // A2: the paid short-circuit sends NO link — the LINK path must not record
    // a send that never happened.
    const session = seed(MEMBERSHIP_STEP, { ...FULL_DATA }, {
      caregiverSubscriptionId: "sub_live",
      membershipCheckoutUrl:   "https://pay/stale",
    });

    await handleOnboardingStep(PHONE, CHAT, "LINK", session);

    expect(linkParts()).toHaveLength(0);
    expect(sentText().toLowerCase()).toContain("came through");
    expect(sentText()).not.toContain("reply LINK");
    expect(stored()?.gateLinkResentAt?.[MEMBERSHIP_STEP]).toBeUndefined();
    expect(stored()?.gateLinkBypassUsedAt?.[MEMBERSHIP_STEP]).toBeUndefined();
  });

  it("paid + second LINK: still the paid path — never 'I sent that link' cooldown copy", async () => {
    // Even with stale pre-payment cooldown state (window open AND bypass
    // spent), the paid short-circuit wins over ANY cooldown copy.
    const session = seed(MEMBERSHIP_STEP, { ...FULL_DATA }, {
      caregiverSubscriptionId: "sub_live",
      membershipCheckoutUrl:   "https://pay/stale",
      gateLinkResentAt:     { [MEMBERSHIP_STEP]: minutesAgo(2) },
      gateLinkBypassUsedAt: { [MEMBERSHIP_STEP]: minutesAgo(1) },
    });

    await handleOnboardingStep(PHONE, CHAT, "LINK", session);
    sentMessages.length = 0;
    await handleOnboardingStep(PHONE, CHAT, "LINK", stored());

    expect(linkParts()).toHaveLength(0);
    const out = sentText();
    expect(out.toLowerCase()).toContain("came through");
    expect(out).not.toContain("I sent that link");
    expect(out).not.toContain("I resent that link");
    expect(out).not.toContain("reply LINK");
    // Stale stamps untouched — no fresh bypass/send was recorded.
    expect(stored()?.gateLinkBypassUsedAt?.[MEMBERSHIP_STEP]).toBe(session.gateLinkBypassUsedAt[MEMBERSHIP_STEP]);
  });

});

describe("U12 — removed caregiver_awaiting_identity step", () => {
  it("a stale prod session parked at the removed step routes to the defensive default without crashing", async () => {
    const session = seed("caregiver_awaiting_identity", { ...FULL_DATA });

    await handleOnboardingStep(PHONE, CHAT, "what's going on with my signup?", session);

    // The absorber default replied (START OVER escape hatch) — no crash, no
    // silent drop, and the cursor was left alone (no state wipe).
    expect(sentMessages.length).toBeGreaterThan(0);
    expect(sentText()).toContain("START OVER");
    expect(stored()?.onboardingStep).toBe("caregiver_awaiting_identity");
    expect(checkrInvite).not.toHaveBeenCalled();
  });
});
