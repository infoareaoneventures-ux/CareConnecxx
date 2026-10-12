import { describe, it, expect, vi, beforeEach } from "vitest";

// caregivers/{uid} record change → the account events the caregiver hears about,
// each exactly once, in the dashboard progress bar's own terms.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const sent: Array<{ phone: string; content: string }> = [];
  const bells: any[] = [];
  const makeDoc = (path: string): any => ({
    id: path.split("/").pop(),
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    set: vi.fn(async (d: any) => docState.set(path, { ...(docState.get(path) ?? {}), ...d })),
    collection: (sub: string) => makeColl(`${path}/${sub}`),
  });
  const makeColl = (coll: string): any => ({
    doc: (id: string) => makeDoc(`${coll}/${id}`),
    where: () => ({ limit: () => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) }) }),
  });
  return { docState, sent, bells, collectionMock: vi.fn((c: string) => makeColl(c)), reset: () => { docState.clear(); sent.length = 0; bells.length = 0; } };
});
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: hoisted.collectionMock }), { FieldValue: { serverTimestamp: () => ({ __ts: true }) } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("firebase-functions/v1", () => ({ firestore: { document: () => ({ onUpdate: (fn: unknown) => fn }) }, config: () => ({}) }));
// The bell writer: idempotent per (sourcePath|eventId|recipient|transition).
vi.mock("../../notifications/userNotification", () => {
  const seen = new Set<string>();
  return {
    writeUserNotification: vi.fn(async (n: any) => {
      const key = `${n.sourcePath}|${n.eventId}|${n.recipientId}|${n.transitionType}`;
      if (seen.has(key)) return false;
      seen.add(key); hoisted.bells.push(n); return true;
    }),
  };
});
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async (phone: string, m: any) => { hoisted.sent.push({ phone, content: m.content }); return true; }) }));
vi.mock("../../linq/client", () => ({ sendToPhone: vi.fn(async (phone: string, content: string) => { hoisted.sent.push({ phone, content }); return "sent"; }) }));
vi.mock("../../config/appUrl", () => ({ appLink: (p: string) => `https://eviacares.com${p}` }));
vi.mock("../../ai/scoring", () => ({ haversineMiles: () => undefined }));

import { caregiverAccountTransitions, onCaregiverAccountChange } from "../caregiverAccountEvents";
import { notifyCaregiverAccountEvent } from "../../notifications/caregiverAccountEvents";

const kinds = (b: any, a: any) => caregiverAccountTransitions(b, a).map((e) => e.kind);
const TRANSPORT = { services: ["Transportation"] };

beforeEach(() => hoisted.reset());

describe("caregiverAccountTransitions — one event per progress-bar change", () => {
  it("membership: paid / revoked / cancelled", () => {
    expect(kinds({}, { membershipPaid: true, membershipStatus: "active" })).toEqual(["membership_paid"]);
    expect(kinds({ membershipPaid: true }, { membershipPaid: false, membershipStatus: "inactive" })).toEqual(["membership_revoked"]);
    expect(kinds({ membershipStatus: "active", membershipPaid: true }, { membershipStatus: "canceled", membershipPaid: true })).toEqual(["membership_cancelled"]);
    expect(kinds({ membershipPaid: true }, { membershipPaid: true, membershipStatus: "active" })).toEqual([]); // no change
  });

  it("background check: consent link, clear, review, on hold, not approved, link expired, revoked", () => {
    expect(caregiverAccountTransitions(
      { backgroundCheckData: { invitationStatus: "awaiting_consent" } },
      { backgroundCheckData: { invitationStatus: "sent", consentGiven: true, invitationUrl: "https://checkr/x", consentReason: "initial" } },
    )).toEqual([{ kind: "bgcheck_consent_received", ctx: { url: "https://checkr/x", renewal: false } }]);
    expect(kinds({ backgroundCheckStatus: "pending" }, { backgroundCheckStatus: "clear", verificationStatus: "approved" })).toEqual(["bgcheck_clear"]);
    expect(kinds({ backgroundCheckData: { status: "pending" } }, { backgroundCheckData: { status: "consider" } })).toEqual(["bgcheck_review"]);
    expect(kinds({ backgroundCheckData: { status: "pending" } }, { backgroundCheckData: { status: "suspended" } })).toEqual(["bgcheck_on_hold"]);
    expect(kinds({ verificationStatus: "approved" }, { verificationStatus: "rejected", backgroundCheckData: { status: "consider" } })).toEqual(["bgcheck_not_approved"]);
    expect(kinds({ backgroundCheckData: { invitationStatus: "sent" } }, { backgroundCheckData: { invitationStatus: "expired" } })).toEqual(["bgcheck_link_expired"]);
    expect(kinds({ backgroundCheckStatus: "clear" }, { backgroundCheckStatus: "pending", verified: false })).toEqual(["bgcheck_revoked"]);
    // A yearly renewal resets the same fields but is announced by its invoice, not here.
    expect(kinds({ backgroundCheckStatus: "clear" }, { backgroundCheckStatus: "pending", backgroundCheckData: { consentRequired: true, consentReason: "renewal" } })).toEqual([]);
  });

  it("bookable fires once, when the profile is complete AND approved — whatever wrote it", () => {
    expect(kinds({ onboardingStatus: "profile_complete", verificationStatus: "submitted", backgroundCheckStatus: "pending" },
                 { onboardingStatus: "profile_complete", verificationStatus: "approved", membershipStatus: "active", backgroundCheckStatus: "clear" }))
      .toEqual(["bgcheck_clear", "now_bookable"]);
    // Approved before the questionnaire finished: bookable only when the profile completes.
    expect(kinds({ onboardingStatus: "in_progress", verificationStatus: "approved", membershipStatus: "active" }, { onboardingStatus: "profile_complete", verificationStatus: "approved", membershipStatus: "active" })).toEqual(["now_bookable"]);
    expect(kinds({ onboardingStatus: "profile_complete", verificationStatus: "approved", membershipStatus: "active" }, { onboardingStatus: "profile_complete", verificationStatus: "approved", membershipStatus: "active", bio: "x" })).toEqual([]);
    // 2026-10-06: a lapsed membership makes them not bookable; reactivating fires bookable again.
    expect(kinds({ onboardingStatus: "profile_complete", verificationStatus: "approved", membershipStatus: "canceled" }, { onboardingStatus: "profile_complete", verificationStatus: "approved", membershipStatus: "active" })).toContain("now_bookable");
  });

  it("transport (MVR only, 2026-10-06): driving record decisions, badge earned / lost", () => {
    // MVR clears for a caregiver offering Transportation → driving record line + badge earned
    expect(kinds({ ...TRANSPORT, mvrStatus: "pending" }, { ...TRANSPORT, mvrStatus: "clear", isApprovedDriver: true }))
      .toEqual(["mvr_clear", "transport_badge_earned"]);
    // Bundled criminal+MVR clear: the background-check line covers it, no separate driving-record line
    expect(kinds({ backgroundCheckStatus: "pending" }, { backgroundCheckStatus: "clear", mvrStatus: "clear", isApprovedDriver: true })).toEqual(["bgcheck_clear"]);
    expect(kinds({ mvrStatus: "pending" }, { mvrStatus: "consider", isApprovedDriver: false })).toEqual(["mvr_review"]);
    // Later MVR, consent-first (2026-10-06): parking on consent tells her once.
    expect(kinds({ ...TRANSPORT }, { ...TRANSPORT, mvrStatus: "awaiting_consent" })).toEqual(["mvr_consent_requested"]);
    expect(kinds({ mvrStatus: "consider", isApprovedDriver: false }, { mvrStatus: "not_approved", isApprovedDriver: false })).toContain("mvr_not_approved");
    // Badge earned when she adds Transportation with the record already clear
    expect(kinds({ isApprovedDriver: true }, { ...TRANSPORT, isApprovedDriver: true })).toEqual(["transport_badge_earned"]);
    // Badge lost: admin revoked the driving record
    expect(caregiverAccountTransitions({ ...TRANSPORT, isApprovedDriver: true }, { ...TRANSPORT, isApprovedDriver: false }))
      .toEqual([{ kind: "transport_badge_lost", ctx: { reason: "mvr" } }]);
    // Badge lost: she removed the service
    expect(caregiverAccountTransitions({ ...TRANSPORT, isApprovedDriver: true }, { services: ["Companionship"], isApprovedDriver: true }))
      .toEqual([{ kind: "transport_badge_lost", ctx: { reason: "services" } }]);
    // Documents no longer exist: a legacy documents map changing is not an event
    expect(kinds({ ...TRANSPORT, isApprovedDriver: true, documents: { insurance: { status: "pending" } } }, { ...TRANSPORT, isApprovedDriver: true, documents: { insurance: { status: "approved" } } })).toEqual([]);
  });

  it("account paused / reactivated (B7, 2026-10-11): the pausedUntil transition, as every reader compares it", () => {
    const now = "2026-10-11T12:00:00.000Z";
    const at = (b: any, a: any) => caregiverAccountTransitions(b, a, now);
    // unset → a future date = paused until that date; → the sentinel = paused until she reactivates
    expect(at({}, { pausedUntil: "2026-11-01", pausedAt: now })).toEqual([{ kind: "account_paused", ctx: { date: "2026-11-01" } }]);
    expect(at({}, { pausedUntil: "2099-12-31", pausedAt: now })).toEqual([{ kind: "account_paused", ctx: { indefinite: true } }]);
    // a new end date while paused → told again with the new date
    expect(at({ pausedUntil: "2026-11-01" }, { pausedUntil: "2026-12-01" })).toEqual([{ kind: "account_paused", ctx: { date: "2026-12-01" } }]);
    // set → unset (reactivateCaregiver deletes the field) = reactivated
    expect(at({ pausedUntil: "2026-11-01", pausedAt: now }, { reactivatedAt: now })).toEqual([{ kind: "account_reactivated" }]);
    expect(at({ pausedUntil: "2099-12-31" }, {})).toEqual([{ kind: "account_reactivated" }]);
    // unrelated writes while paused: nothing
    expect(at({ pausedUntil: "2026-11-01", bio: "a" }, { pausedUntil: "2026-11-01", bio: "b" })).toEqual([]);
    // a dated pause expires by comparison — nothing clears pausedUntil on the date, so an unrelated
    // write with the past date still on the record is not a transition (she was already active)
    expect(at({ pausedUntil: "2026-09-01", bio: "a" }, { pausedUntil: "2026-09-01", bio: "b" })).toEqual([]);
    // reactivating an already-expired pause: she was active; nothing to announce
    expect(at({ pausedUntil: "2026-09-01" }, { reactivatedAt: now })).toEqual([]);
    // pausing again after an expired dated pause = paused (not "told again")
    expect(at({ pausedUntil: "2026-09-01" }, { pausedUntil: "2026-11-15" })).toEqual([{ kind: "account_paused", ctx: { date: "2026-11-15" } }]);
  });

  it("lifting a pause says 'active again', not a second 'you're all set' (bookable is suppressed on reactivation)", () => {
    const bookable = { onboardingStatus: "profile_complete", verificationStatus: "approved", membershipStatus: "active", backgroundCheckStatus: "clear", verified: true };
    expect(kinds({ ...bookable, pausedUntil: "2099-12-31" }, { ...bookable })).toEqual(["account_reactivated"]);
    expect(kinds({ ...bookable }, { ...bookable, pausedUntil: "2099-12-31" })).toEqual(["account_paused"]);
  });

  it("payouts enabled / disabled", () => {
    expect(kinds({}, { payoutsEnabled: true, stripeOnboardingComplete: true })).toEqual(["payouts_enabled"]);
    expect(kinds({ payoutsEnabled: true, stripeOnboardingComplete: true }, { payoutsEnabled: false, stripeOnboardingComplete: false })).toEqual(["payouts_disabled"]);
  });
});

describe("notifyCaregiverAccountEvent — bell + text once", () => {
  it("sends one bell and one text, and nothing on a repeat of the same event", async () => {
    hoisted.docState.set("users/cg1", { phone: "+15551112222" });
    hoisted.docState.set("agent_sessions/+15551112222", { userId: "cg1" });
    const first = await notifyCaregiverAccountEvent("cg1", "payouts_enabled", { eventId: "evt1" });
    expect(first).toEqual({ bell: true, text: true });
    expect(hoisted.bells[0]).toMatchObject({ recipientId: "cg1", transitionType: "payouts_enabled", title: "Payouts set up" });
    // The bell links to the Payments page; the text finishes by text (2026-10-03) — same event, channel-appropriate words.
    expect(hoisted.bells[0].body).toContain("/care-provider/payments");
    expect(hoisted.sent[0].content).toBe("Your payout account is set up — earnings land in your bank automatically after each paid visit. Reply PAYOUTS anytime to see your balance.");
    const again = await notifyCaregiverAccountEvent("cg1", "payouts_enabled", { eventId: "evt1" });
    expect(again).toEqual({ bell: false, text: false });
    expect(hoisted.sent).toHaveLength(1);
    expect(hoisted.bells).toHaveLength(1);
  });

  it("no Evia session → texts the phone on file directly; opted out → bell only", async () => {
    hoisted.docState.set("users/cg2", { phone: "+15553334444" });
    expect(await notifyCaregiverAccountEvent("cg2", "bgcheck_clear", { eventId: "e" })).toEqual({ bell: true, text: true });
    hoisted.docState.set("users/cg3", { phone: "+15555556666" });
    hoisted.docState.set("agent_sessions/+15555556666", { userId: "cg3", optedOut: true });
    expect(await notifyCaregiverAccountEvent("cg3", "bgcheck_clear", { eventId: "e" })).toEqual({ bell: true, text: false });
  });

  it("pause from the SITE (queue action, no session stamp): bell typed account_paused + the text; from an Evia door (stamped within the window): bell only — it texted its own line", async () => {
    hoisted.docState.set("users/cg1", { phone: "+15551112222" });
    hoisted.docState.set("agent_sessions/+15551112222", { userId: "cg1" });
    const pauseChange = { before: { data: () => ({ name: "A" }) }, after: { data: () => ({ name: "A", pausedUntil: "2026-11-01", pausedAt: "x" }) } };
    await (onCaregiverAccountChange as any)(pauseChange, { params: { uid: "cg1" }, eventId: "fs-pause-1" });
    expect(hoisted.bells.map((b) => [b.type, b.transitionType])).toEqual([["account_paused", "account_paused"]]);
    expect(hoisted.bells[0].body).toContain("https://eviacares.com/care-provider/settings");
    expect(hoisted.sent.map((s) => s.content)).toEqual(["Your account is paused until 2026-11-01. You won't show up for new matches; existing visits, bookings and interviews are unchanged. Reactivate sooner anytime — reply REACTIVATE."]);
    // A retried invocation of the same event sends nothing more.
    await (onCaregiverAccountChange as any)(pauseChange, { params: { uid: "cg1" }, eventId: "fs-pause-1" });
    expect(hoisted.sent).toHaveLength(1);

    // Evia's REACTIVATE keyword: pauseAccount.ts stamped the session just before the write.
    hoisted.docState.set("agent_sessions/+15551112222", { userId: "cg1", accountNoticeTexted: { kind: "account_reactivated", at: new Date().toISOString() } });
    const reactivateChange = { before: { data: () => ({ name: "A", pausedUntil: "2026-11-01" }) }, after: { data: () => ({ name: "A", reactivatedAt: "y" }) } };
    await (onCaregiverAccountChange as any)(reactivateChange, { params: { uid: "cg1" }, eventId: "fs-react-1" });
    expect(hoisted.bells.map((b) => b.type)).toEqual(["account_paused", "account_reactivated"]);
    expect(hoisted.sent).toHaveLength(1); // no second text: the door's "You're active again…" line already went

    // The same reactivation from the site (no stamp) → text too.
    hoisted.docState.set("agent_sessions/+15551112222", { userId: "cg1" });
    await (onCaregiverAccountChange as any)(reactivateChange, { params: { uid: "cg1" }, eventId: "fs-react-2" });
    expect(hoisted.sent.at(-1)?.content).toBe("You're active again — you'll show up for new matches.");
  });

  it("the trigger tells the care provider each event of a change, keyed on the Firestore event id", async () => {
    hoisted.docState.set("users/cg1", { phone: "+15551112222" });
    const change = { before: { data: () => ({ backgroundCheckStatus: "pending", onboardingStatus: "profile_complete", verificationStatus: "submitted" }) }, after: { data: () => ({ backgroundCheckStatus: "clear", onboardingStatus: "profile_complete", verificationStatus: "approved", membershipStatus: "active" }) } };
    await (onCaregiverAccountChange as any)(change, { params: { uid: "cg1" }, eventId: "fs-evt-1" });
    expect(hoisted.bells.map((b) => b.transitionType)).toEqual(["bgcheck_clear", "now_bookable"]);
    expect(hoisted.sent.map((s) => s.content)).toEqual(["Great news — your background check came back clear.", "You're all set — families can now find and book you."]);
    // A retried invocation of the same event sends nothing more.
    await (onCaregiverAccountChange as any)(change, { params: { uid: "cg1" }, eventId: "fs-evt-1" });
    expect(hoisted.sent).toHaveLength(2);
  });
});
