// U9 / KTD3 — SHADOW-COMPARISON harness for ONE low-risk candidate: caregiver
// referral. The plan calls for running the coded path and an agent-composed
// equivalent and asserting their END-STATE PROJECTIONS match, so a future
// migration to an agent-composed `referrals` write can be flipped only once the
// projections are provably equal.
//
// HONEST SCOPE: this is a PROJECTION-CONTRACT test, not a live agent shadow.
// Building a real agent-composed referral tool (LLM loop + MCP tool) is heavier
// than U9's safety apparatus needs, and wiring it would risk the production path.
// Instead we:
//   1. run the REAL coded path (handleCaregiverReferral via routeCaregiverMessage)
//      and capture its `referrals` end-state,
//   2. define `projectReferral()` — the normalized, user-visible end-state shape,
//   3. define `expectedAgentComposedProjection()` — the SAME projection an
//      agent-composed path MUST produce (the migration contract),
//   4. assert the coded path's projection equals the contract.
//
// PRODUCTION STILL USES THE CODED PATH. Nothing here is wired into routing. When
// a future unit adds a real `caregiver_referral` tool, step (3) becomes "run the
// tool and project its write" and this test becomes a true shadow comparison —
// the projection helper and contract carry over unchanged.

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  let autoId = 0;

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
    set: async (data: any, opts?: any) => {
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    },
    update: async (data: any) => {
      const next = { ...(docState.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) {
        if ((v as any)?.__delete) delete next[k]; else next[k] = v;
      }
      docState.set(path, next);
    },
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? `auto-${autoId++}`}`);
    ref.where = (..._a: any[]) => ref;
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.get = async () => ({ empty: true, docs: [] });
    ref.add = async (data: any) => { const id = `auto-${autoId++}`; docState.set(`${path}/${id}`, data); return { id }; };
    return ref;
  };

  const collection = vi.fn((name: string) => makeCollRef(name));
  const firestoreFn: any = Object.assign(() => ({ collection }), {
    FieldValue: {
      delete: () => ({ __delete: true }), arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
      increment: (n: number) => ({ __increment: n }), serverTimestamp: () => ({ __serverTimestamp: true }),
    },
  });

  return { docState, firestoreFn, reset: () => { docState.clear(); autoId = 0; } };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn },
  apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn,
}));

const sendMessage = vi.fn(async (..._a: any[]) => ({ message_id: "m1" }));
const sendToPhone = vi.fn(async (..._a: any[]) => ({ message_id: "m2" }));
vi.mock("../client", () => ({
  sendMessage: (...a: any[]) => sendMessage(...a),
  sendToPhone: (...a: any[]) => sendToPhone(...a),
  startTyping: vi.fn(async () => {}), stopTyping: vi.fn(async () => {}),
}));

const quickComplete = vi.fn(async (..._a: any[]) => "");
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => quickComplete(...a) }));
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async ({ fallback }: any) => fallback ?? "msg") }));
vi.mock("../../utils/dndGuard", () => ({ sendIfNotDND: vi.fn(async () => {}) }));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async () => {}) }));
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("../../observability/actionLedger", () => ({ logAgentAction: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverSwapHandler", () => ({
  handleCaregiverSwapRequest: vi.fn(async () => {}), handleSwapAcceptance: vi.fn(async () => {}),
}));
vi.mock("../../agents/caregiverCancelShiftHandler", () => ({ handleCaregiverCancelShift: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverProfileHandler", () => ({ handleCaregiverProfileUpdate: vi.fn(async () => {}) }));
vi.mock("../../triggers/jobNotifications", () => ({
  handleJobResponse: vi.fn(async () => {}), handleAvailabilityConfirmation: vi.fn(async () => {}),
}));
import { routeCaregiverMessage } from "../routeCaregiver";

const CG_PHONE = "+15551110000";
const CAREGIVER_ID = "cg-1";
const REFERRED_NAME = "Maria Lopez";
const REFERRED_PHONE = "+15552223333";

// ── Projection helper — the normalized, comparable end-state. Drops volatile
// fields (timestamps, the random inviteUrl/ref id) so two independent producers
// of a `referrals` doc can be compared for behavioral equivalence. ───────────
function projectReferral(doc: any) {
  return {
    referrerUserId: doc.referrerUserId,
    referrerRole: doc.referrerRole,
    referredRole: doc.referredRole,
    referredName: doc.referredName,
    referredPhone: doc.referredPhone,
    source: doc.source,
    status: doc.status,
    bookable: doc.bookable,
    checkrRequired: doc.checkrRequired,
    deliveryStatus: doc.deliveryStatus,
    eligibilityRequired: doc.eligibilityRequired,
    // user-visible side effect: the referred person was texted an invite.
    invitedPhoneTexted: doc.deliveryStatus === "sent",
  };
}

// ── Migration contract — the projection an AGENT-COMPOSED path MUST produce to
// be flip-safe. Keep this independent of the coded implementation: it encodes
// the launch invariants (non-bookable, Checkr-gated) the agent path must honor.
function expectedAgentComposedProjection() {
  return {
    referrerUserId: CAREGIVER_ID,
    referrerRole: "caregiver",
    referredRole: "caregiver",
    referredName: REFERRED_NAME,
    referredPhone: REFERRED_PHONE,
    source: "cara_sms",
    status: "invited",
    bookable: false,
    checkrRequired: true,
    deliveryStatus: "sent",
    eligibilityRequired: {
      onboardingStatus: "profile_complete",
      verificationStatus: "approved",
      checkrResult: "clear",
    },
    invitedPhoneTexted: true,
  };
}

function seed() {
  hoisted.docState.set(`caregivers/${CAREGIVER_ID}`, { name: "Jane Referrer" });
  hoisted.docState.set(`agent_sessions/${CG_PHONE}`, {
    chatId: "cg-chat", phone: CG_PHONE, service: "SMS", userType: "caregiver", caregiverId: CAREGIVER_ID,
  });
}

function ctx(text: string) {
  return {
    phone: CG_PHONE, chatId: "cg-chat", text,
    norm: text.toUpperCase().trim(),
    session: hoisted.docState.get(`agent_sessions/${CG_PHONE}`) as any,
  };
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  quickComplete.mockImplementation(async (sys: string, user: string) => {
    if (/refer, invite, or recommend/i.test(sys)) return "YES";
    if (/question or off-topic/i.test(sys)) return "NO";
    if (/Extract the referred caregiver's name/i.test(sys)) return /maria lopez/i.test(user) ? REFERRED_NAME : "";
    return "";
  });
  sendToPhone.mockResolvedValue({ message_id: "m2" });
  sendMessage.mockResolvedValue({ message_id: "m1" });
});

describe("shadow comparison (projection contract) — caregiver referral", () => {
  it("coded path's end-state projection equals the agent-composed migration contract", async () => {
    seed();

    // Run the REAL coded path (production path — unchanged).
    const outcome = await routeCaregiverMessage(ctx(`refer ${REFERRED_NAME} ${REFERRED_PHONE}`));
    expect(outcome).toBe("handled");

    const codedDoc = [...hoisted.docState.entries()].find(([p]) => p.startsWith("referrals/"))?.[1];
    expect(codedDoc).toBeTruthy();

    const codedProjection = projectReferral(codedDoc);

    // The migration-safety assertion: the coded path's projected end-state is
    // EXACTLY what an agent-composed path must reproduce to be flip-safe.
    expect(codedProjection).toEqual(expectedAgentComposedProjection());
  });

  it("projectReferral normalizes away volatile fields (timestamps / random ids)", async () => {
    seed();
    await routeCaregiverMessage(ctx(`refer ${REFERRED_NAME} ${REFERRED_PHONE}`));
    const codedDoc = [...hoisted.docState.entries()].find(([p]) => p.startsWith("referrals/"))?.[1];

    // Volatile fields exist on the raw doc but are excluded from the projection,
    // so two producers that differ only in id/timestamp still compare equal.
    expect(codedDoc.createdAt).toBeDefined();
    expect(codedDoc.inviteUrl).toContain("ref=");
    expect(projectReferral(codedDoc)).not.toHaveProperty("createdAt");
    expect(projectReferral(codedDoc)).not.toHaveProperty("inviteUrl");
  });
});
