import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The ONE onboarding reminder (caregiver sweep A8, 2026-10-11): fixed wording
 * naming the step, the step's question re-asked for a reply step, the link
 * re-delivered for a gate step, never to someone who finished on the website,
 * the bell only when the text went, the 2/5/12-day cadence stamped per silence.
 */

// ── In-memory Firestore: agent_sessions (where + doc), caregivers, users ──────
const store = {
  sessions:   new Map<string, any>(),
  caregivers: new Map<string, any>(),
  users:      new Map<string, any>(),
  updates:    [] as Array<{ id: string; data: any }>,
};

vi.mock("firebase-admin", () => {
  const makeSessionDocRef = (id: string) => ({
    id,
    get:    async () => ({ exists: store.sessions.has(id), data: () => store.sessions.get(id) }),
    update: vi.fn(async (data: any) => { store.updates.push({ id, data }); }),
  });
  const collection = (name: string) => {
    if (name === "caregivers") {
      return { doc: (id: string) => ({ get: async () => ({ exists: store.caregivers.has(id), data: () => store.caregivers.get(id) }) }) };
    }
    if (name === "users") {
      return { doc: (id: string) => ({ get: async () => ({ exists: store.users.has(id), data: () => store.users.get(id) }) }) };
    }
    const ref: any = {
      where: () => ref,
      get:   async () => ({ docs: [...store.sessions.entries()].map(([id, data]) => ({ id, data: () => data, ref: makeSessionDocRef(id) })) }),
      doc:   (id: string) => makeSessionDocRef(id),
    };
    return ref;
  };
  const firestore = Object.assign(() => ({ collection }), {
    FieldValue: { increment: (n: number) => ({ __inc: n }), serverTimestamp: () => ({ __ts: true }), delete: () => ({ __del: true }) },
  });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("firebase-functions/v1", () => ({
  pubsub: { schedule: () => ({ onRun: (fn: any) => fn }) },
}));

const sendSpy = vi.fn(async (..._a: unknown[]) => true);
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendSpy(...a) }));
const bellSpy = vi.fn(async (_input: unknown) => true);
vi.mock("../../notifications/userNotification", () => ({ writeUserNotification: (i: unknown) => bellSpy(i) }));

const resendStuckStep = vi.fn(async (..._a: unknown[]) => true);
const sendOnboardingLink = vi.fn(async (..._a: unknown[]) => ({ success: true, linkType: "caregiver_photo" }));
vi.mock("../../agents/onboardingConversation", () => ({
  resendStuckStep:    (...a: unknown[]) => resendStuckStep(...a),
  sendOnboardingLink: (...a: unknown[]) => sendOnboardingLink(...a),
}));

// The website check for caregivers: tests decide where the cursor lands.
const reconcile = vi.fn(async (_phone: string, session: any) => session);
vi.mock("../../agents/caregiverSiteSync", () => ({
  reconcileCaregiverOnboardingWithSite: (...a: [string, any]) => reconcile(...a),
}));

vi.mock("../../linq/webhooks", () => ({
  userHasRealOnboardingProgress: vi.fn(async (_userId: string, userData: Record<string, unknown>) =>
    Boolean(userData.jobPostingCompleted)),
}));

import { sendStaleSessionNudges } from "../staleSessionNudge";
import { caregiverAnnualDisplay, clientMonthlyDisplay } from "../../config/pricing";

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function seedSession(id: string, data: Record<string, unknown>) {
  store.sessions.set(id, { chatId: `chat-${id}`, optedOut: false, createdAt: ago(10), lastInboundAt: ago(3), ...data });
}
const run = () => (sendStaleSessionNudges as any)();
const sentText = (i = 0) => (sendSpy.mock.calls[i][1] as any).content as string;
const stampWrites = (id: string) => store.updates.filter((u) => u.id === id && Object.keys(u.data).some((k) => k.startsWith("gateLinkResentAt.")));
const nudgeStamp = (id: string) => store.updates.find((u) => u.id === id && typeof u.data.nudgeCount === "number")?.data;

beforeEach(() => {
  store.sessions.clear(); store.caregivers.clear(); store.users.clear(); store.updates.length = 0;
  sendSpy.mockClear(); sendSpy.mockResolvedValue(true);
  bellSpy.mockClear();
  resendStuckStep.mockClear(); resendStuckStep.mockResolvedValue(true);
  sendOnboardingLink.mockClear();
  reconcile.mockClear(); reconcile.mockImplementation(async (_p, s) => s);
});

describe("cadence — stamped per silence", () => {
  it("first nudge 3 days after the last message: text, bell, nudgeCount 1 against that inbound; a fresh session gets nothing", async () => {
    seedSession("+15550000001", { onboardingStep: "caregiver_ask_rate", userType: "caregiver", caregiverId: "cg1", onboardingData: { name: "Sam Lee" } });
    seedSession("+15550000002", { onboardingStep: "caregiver_ask_rate", userType: "caregiver", lastInboundAt: ago(1) });
    await run();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toBe("+15550000001");
    expect((sendSpy.mock.calls[0][1] as any).canDrop).toBe(false);
    expect(nudgeStamp("+15550000001")).toMatchObject({ nudgeCount: 1, nudgeAnchorAt: store.sessions.get("+15550000001").lastInboundAt });
    expect(bellSpy).toHaveBeenCalledTimes(1);
    expect((bellSpy.mock.calls[0][0] as any)).toMatchObject({ recipientId: "cg1", transitionType: "stale_nudge", type: "onboarding_reminder" });
  });

  it("second only on/after day 5, third on/after day 12, never a fourth, never twice in a day, nothing after 14 idle days", async () => {
    const a = ago(6);
    seedSession("+1second", { onboardingStep: "caregiver_ask_bio", userType: "caregiver", lastInboundAt: a, nudgeAnchorAt: a, nudgeCount: 1, nudgeSentAt: ago(3) });
    const b = ago(4);
    seedSession("+1tooEarly", { onboardingStep: "caregiver_ask_bio", userType: "caregiver", lastInboundAt: b, nudgeAnchorAt: b, nudgeCount: 1, nudgeSentAt: ago(2) });
    const c = ago(13);
    seedSession("+1third", { onboardingStep: "caregiver_ask_bio", userType: "caregiver", lastInboundAt: c, nudgeAnchorAt: c, nudgeCount: 2, nudgeSentAt: ago(8) });
    seedSession("+1fourth", { onboardingStep: "caregiver_ask_bio", userType: "caregiver", lastInboundAt: c, nudgeAnchorAt: c, nudgeCount: 3, nudgeSentAt: ago(1) });
    seedSession("+1sameDay", { onboardingStep: "caregiver_ask_bio", userType: "caregiver", lastInboundAt: a, nudgeAnchorAt: a, nudgeCount: 1, nudgeSentAt: ago(0.3) });
    seedSession("+1abandoned", { onboardingStep: "caregiver_ask_bio", userType: "caregiver", lastInboundAt: ago(20) });
    await run();
    const phones = sendSpy.mock.calls.map((c) => c[0]);
    expect(phones).toEqual(["+1second", "+1third"]);
    expect(nudgeStamp("+1second")).toMatchObject({ nudgeCount: 2, nudgeAnchorAt: a });
    expect(nudgeStamp("+1third")).toMatchObject({ nudgeCount: 3, nudgeAnchorAt: c });
    expect(sentText(1)).toContain("This is my last reminder");
    expect(sentText(0)).not.toContain("last reminder");
  });

  it("a reply after the series restarts it", async () => {
    seedSession("+1replied", { onboardingStep: "caregiver_ask_bio", userType: "caregiver", lastInboundAt: ago(3), nudgeAnchorAt: ago(40), nudgeCount: 3, nudgeSentAt: ago(28) });
    await run();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(nudgeStamp("+1replied")).toMatchObject({ nudgeCount: 1, nudgeAnchorAt: store.sessions.get("+1replied").lastInboundAt });
  });
});

describe("never to someone who finished on the website", () => {
  it("caregiver: the site check runs first; a cursor it moves to complete gets no text and no stamp", async () => {
    seedSession("+1siteDone", { onboardingStep: "caregiver_ask_bio", userType: "caregiver", caregiverId: "cg-done" });
    reconcile.mockImplementation(async (_p, s) => ({ ...s, onboardingStep: "complete" }));
    await run();
    expect(reconcile).toHaveBeenCalledWith("+1siteDone", expect.objectContaining({ onboardingStep: "caregiver_ask_bio" }));
    expect(sendSpy).not.toHaveBeenCalled();
    expect(nudgeStamp("+1siteDone")).toBeUndefined();
  });

  it("caregiver: a cursor the site moved to the membership gate is nudged AT that gate (link), not the old step", async () => {
    seedSession("+1moved", { onboardingStep: "caregiver_ask_bio", userType: "caregiver", caregiverId: "cg-m", onboardingData: { name: "Ana" } });
    reconcile.mockImplementation(async (_p, s) => ({ ...s, onboardingStep: "caregiver_send_membership" }));
    await run();
    expect(sentText()).toContain("completing your membership payment");
    expect(resendStuckStep).toHaveBeenCalledWith("+1moved");
  });

  it("family: website progress already real → self-heals the session, no text", async () => {
    seedSession("+1fam", { onboardingStep: "client_ask_senior", userType: "client", userId: "client-1", onboardingData: { firstName: "Hamse" } });
    store.users.set("client-1", { jobPostingCompleted: true });
    await run();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(store.updates).toContainEqual({ id: "+1fam", data: { onboardingStep: "complete" } });
  });

  it("family with no real progress (or no users doc) is still nudged", async () => {
    seedSession("+1fam2", { onboardingStep: "client_ask_senior", userType: "client", userId: "client-2", onboardingData: { firstName: "Dana" } });
    store.users.set("client-2", { jobPostingCompleted: false });
    seedSession("+1fam3", { onboardingStep: "client_ask_senior", userType: "client", userId: "client-missing" });
    await run();
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(store.updates.some((u) => u.data.onboardingStep === "complete")).toBe(false);
  });
});

describe("copy — names the step; re-asks the question on a reply step; carries the link on a gate step", () => {
  it("caregiver collection: the first wizard field still missing (session + record together) is asked in the wizard's words, no link", async () => {
    seedSession("+1collect", {
      onboardingStep: "caregiver_ask_location", userType: "caregiver", caregiverId: "cg-c",
      onboardingData: { name: "Sam Lee", street: "1 Main St", zipCode: "95134", city: "San Jose", state: "CA" },
    });
    store.caregivers.set("cg-c", { photo: "https://x/photo.jpg" }); // photo done on the site
    await run();
    const t = sentText();
    expect(t).toMatch(/^Hey Sam! Your caregiver profile stopped at sharing your address\. What kind of work are you looking for — occasional shifts, part-time, or full-time\?$/);
    expect(resendStuckStep).not.toHaveBeenCalled();
    expect(sendOnboardingLink).not.toHaveBeenCalled();
  });

  it("caregiver collection at the photo: the upload link is re-sent (one of the four gates)", async () => {
    seedSession("+1photo", {
      onboardingStep: "caregiver_ask_location", userType: "caregiver", caregiverId: "cg-p",
      onboardingData: { name: "Bo", street: "1 Main St", zipCode: "95134", city: "San Jose", state: "CA" },
    });
    await run();
    expect(sentText()).toContain("stopped at your profile photo");
    expect(sendOnboardingLink).toHaveBeenCalledWith("+1photo", "caregiver_photo");
  });

  it("membership gate: the price fact, then the link through the LINK keyword's path + the shared resend cooldown stamp", async () => {
    seedSession("+1mem", { onboardingStep: "caregiver_awaiting_membership", userType: "caregiver", caregiverId: "cg-mem", onboardingData: { name: "Ana" } });
    await run();
    const t = sentText();
    expect(t).toContain("You stopped at completing your membership payment.");
    expect(t).toContain(caregiverAnnualDisplay());
    expect(t.endsWith("Here's your link again:")).toBe(true);
    expect(resendStuckStep).toHaveBeenCalledWith("+1mem");
    expect(stampWrites("+1mem")).toHaveLength(1);
    expect(typeof stampWrites("+1mem")[0].data["gateLinkResentAt.caregiver_awaiting_membership"]).toBe("string");
    expect((bellSpy.mock.calls[0][0] as any).body).toContain("completing your membership payment");
  });

  it("background-check consent gate: link re-sent, no cooldown stamp (not a cooldown step); after consent the Checkr fact", async () => {
    seedSession("+1consent", { onboardingStep: "caregiver_awaiting_bgcheck_consent", userType: "caregiver", caregiverId: "cg-1" });
    seedSession("+1checkr", { onboardingStep: "caregiver_awaiting_bgcheck", userType: "caregiver", caregiverId: "cg-2" });
    await run();
    expect(resendStuckStep).toHaveBeenCalledWith("+1consent");
    expect(stampWrites("+1consent")).toHaveLength(0);
    const texts = sendSpy.mock.calls.map((c) => (c[1] as any).content as string);
    expect(texts.find((t) => t.includes("authorizing your background check"))).toContain("takes about a minute to authorize");
    expect(texts.find((t) => t.includes("finishing your background check"))).toContain("Checkr emailed you a secure link");
  });

  it("payout gate + family gates carry their links; family collection re-asks the wizard's question", async () => {
    seedSession("+1stripe", { onboardingStep: "caregiver_awaiting_stripe", userType: "caregiver", caregiverId: "cg-s" });
    seedSession("+1pay", { onboardingStep: "client_awaiting_payment", userType: "client", userId: "u-pay", onboardingData: { firstName: "Kim" } });
    seedSession("+1id", { onboardingStep: "client_awaiting_identity", userType: "client", userId: "u-id" });
    seedSession("+1needs", { onboardingStep: "client_ask_needs", userType: "client", userId: "u-n", onboardingData: { firstName: "Lee", careFrequency: "part-time", homeStreet: "1 Main", homeZipCode: "95134", sameAsHomeAddress: true, city: "San Jose", zipCode: "95134" } });
    await run();
    const by = Object.fromEntries(sendSpy.mock.calls.map((c) => [c[0], (c[1] as any).content as string]));
    expect(by["+1stripe"]).toContain("setting up your payout account");
    expect(by["+1pay"]).toContain(clientMonthlyDisplay());
    expect(by["+1id"]).toContain("30-second");
    expect(resendStuckStep.mock.calls.map((c) => c[0]).sort()).toEqual(["+1id", "+1pay", "+1stripe"]);
    expect(by["+1needs"]).toBe("Hey Lee! You stopped at describing the care needs. When would you like care to start, and which days of the week?");
  });

  it("no role yet: re-asks the role question", async () => {
    seedSession("+1role", { onboardingStep: "ask_role", onboardingData: { firstName: "Pat" } });
    await run();
    expect(sentText()).toBe("Hi Pat, still thinking about care? Whenever you're ready, just tell me — are you looking for care for someone, or are you a caregiver yourself?");
  });
});

describe("the bell and the count follow the text", () => {
  it("text not delivered and no link → no bell, no count (the cadence retries tomorrow)", async () => {
    seedSession("+1dropped", { onboardingStep: "caregiver_ask_bio", userType: "caregiver", caregiverId: "cg-d" });
    sendSpy.mockResolvedValue(false);
    await run();
    expect(bellSpy).not.toHaveBeenCalled();
    expect(nudgeStamp("+1dropped")).toBeUndefined();
  });

  it("a session with no account yet gets the text but no bell; opted-out and chat-less sessions are skipped", async () => {
    seedSession("+1noacct", { onboardingStep: "caregiver_ask_bio", userType: "caregiver" });
    seedSession("+1opted", { onboardingStep: "caregiver_ask_bio", userType: "caregiver", optedOut: true });
    seedSession("+1nochat", { onboardingStep: "caregiver_ask_bio", userType: "caregiver", chatId: undefined });
    await run();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(bellSpy).not.toHaveBeenCalled();
    expect(nudgeStamp("+1noacct")).toMatchObject({ nudgeCount: 1 });
  });
});
