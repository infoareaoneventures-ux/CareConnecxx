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
const APPROVED_DOCS = { driversLicense: { status: "approved" }, insurance: { status: "approved" }, registration: { status: "approved" } };
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
                 { onboardingStatus: "profile_complete", verificationStatus: "approved", backgroundCheckStatus: "clear" }))
      .toEqual(["bgcheck_clear", "now_bookable"]);
    // Approved before the questionnaire finished: bookable only when the profile completes.
    expect(kinds({ onboardingStatus: "in_progress", verificationStatus: "approved" }, { onboardingStatus: "profile_complete", verificationStatus: "approved" })).toEqual(["now_bookable"]);
    expect(kinds({ onboardingStatus: "profile_complete", verificationStatus: "approved" }, { onboardingStatus: "profile_complete", verificationStatus: "approved", bio: "x" })).toEqual([]);
  });

  it("transport: each document decision, all approved, driving record, badge earned / lost", () => {
    expect(caregiverAccountTransitions({ ...TRANSPORT, documents: { driversLicense: { status: "pending" } } }, { ...TRANSPORT, documents: { driversLicense: { status: "approved" } } }))
      .toEqual([{ kind: "transport_doc_approved", ctx: { docLabel: "Driver's License" } }]);
    expect(caregiverAccountTransitions({ ...TRANSPORT, documents: { insurance: { status: "pending" } } }, { ...TRANSPORT, documents: { insurance: { status: "rejected", notes: "blurry" } } }))
      .toEqual([{ kind: "transport_doc_rejected", ctx: { docLabel: "Vehicle Insurance", docNotes: "blurry" } }]);
    // Third document approved, MVR not yet cleared → "all approved, badge turns on when the MVR clears"
    expect(kinds({ ...TRANSPORT, documents: { ...APPROVED_DOCS, registration: { status: "pending" } } }, { ...TRANSPORT, documents: APPROVED_DOCS }))
      .toEqual(["transport_doc_approved", "transport_docs_all_approved"]);
    // MVR clears with documents already approved → driving record line + badge earned
    expect(kinds({ ...TRANSPORT, documents: APPROVED_DOCS, mvrStatus: "pending" }, { ...TRANSPORT, documents: APPROVED_DOCS, mvrStatus: "clear", isApprovedDriver: true }))
      .toEqual(["mvr_clear", "transport_badge_earned"]);
    // Bundled criminal+MVR clear: the background-check line covers it, no separate driving-record line
    expect(kinds({ backgroundCheckStatus: "pending" }, { backgroundCheckStatus: "clear", mvrStatus: "clear", isApprovedDriver: true })).toEqual(["bgcheck_clear"]);
    expect(kinds({ mvrStatus: "pending" }, { mvrStatus: "consider", isApprovedDriver: false })).toEqual(["mvr_review"]);
    // Badge lost: admin revoked the driving record
    expect(caregiverAccountTransitions({ ...TRANSPORT, documents: APPROVED_DOCS, isApprovedDriver: true }, { ...TRANSPORT, documents: APPROVED_DOCS, isApprovedDriver: false }))
      .toEqual([{ kind: "transport_badge_lost", ctx: { reason: "mvr" } }]);
    // Badge lost: a document expired
    expect(caregiverAccountTransitions({ ...TRANSPORT, documents: APPROVED_DOCS, isApprovedDriver: true }, { ...TRANSPORT, documents: { ...APPROVED_DOCS, insurance: { status: "approved", expirationDate: "2020-01-01" } }, isApprovedDriver: true }))
      .toEqual([{ kind: "transport_badge_lost", ctx: { reason: "expired" } }]);
  });

  it("payouts enabled / disabled", () => {
    expect(kinds({}, { payoutsEnabled: true, stripeOnboardingComplete: true })).toEqual(["payouts_enabled"]);
    expect(kinds({ payoutsEnabled: true, stripeOnboardingComplete: true }, { payoutsEnabled: false, stripeOnboardingComplete: false })).toEqual(["payouts_disabled"]);
  });
});

describe("notifyCaregiverAccountEvent — bell + text once, same words", () => {
  it("sends one bell and one text, and nothing on a repeat of the same event", async () => {
    hoisted.docState.set("users/cg1", { phone: "+15551112222" });
    hoisted.docState.set("agent_sessions/+15551112222", { userId: "cg1" });
    const first = await notifyCaregiverAccountEvent("cg1", "payouts_enabled", { eventId: "evt1" });
    expect(first).toEqual({ bell: true, text: true });
    expect(hoisted.bells[0]).toMatchObject({ recipientId: "cg1", transitionType: "payouts_enabled", title: "Payouts set up" });
    expect(hoisted.sent[0].content).toBe(hoisted.bells[0].body);
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

  it("the trigger tells the caregiver each event of a change, keyed on the Firestore event id", async () => {
    hoisted.docState.set("users/cg1", { phone: "+15551112222" });
    const change = { before: { data: () => ({ backgroundCheckStatus: "pending", onboardingStatus: "profile_complete", verificationStatus: "submitted" }) }, after: { data: () => ({ backgroundCheckStatus: "clear", onboardingStatus: "profile_complete", verificationStatus: "approved" }) } };
    await (onCaregiverAccountChange as any)(change, { params: { uid: "cg1" }, eventId: "fs-evt-1" });
    expect(hoisted.bells.map((b) => b.transitionType)).toEqual(["bgcheck_clear", "now_bookable"]);
    expect(hoisted.sent.map((s) => s.content)).toEqual(["Great news — your background check came back clear.", "You're approved — families can now find and book you."]);
    // A retried invocation of the same event sends nothing more.
    await (onCaregiverAccountChange as any)(change, { params: { uid: "cg1" }, eventId: "fs-evt-1" });
    expect(hoisted.sent).toHaveLength(2);
  });
});
