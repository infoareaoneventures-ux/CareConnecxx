import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  let autoId = 0;

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({
      exists: docState.has(path),
      data: () => docState.get(path),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      const existing = docState.get(path) ?? {};
      const next = { ...existing };
      for (const [key, value] of Object.entries(data)) {
        if ((value as any)?.__delete) {
          delete next[key];
        } else {
          next[key] = value;
        }
      }
      docState.set(path, next);
    }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? `auto-${autoId++}`}`);
    ref.where = (..._a: any[]) => ref;
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => ({
      empty: true,
      docs: [],
    }));
    ref.add = vi.fn(async (data: any) => {
      const id = `auto-${autoId++}`;
      docState.set(`${path}/${id}`, data);
      return { id };
    });
    return ref;
  };

  const collection = vi.fn((name: string) => makeCollRef(name));

  const firestoreFn: any = Object.assign(() => ({ collection }), {
    FieldValue: {
      delete: () => ({ __delete: true }),
      arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
      increment: (n: number) => ({ __increment: n }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
  });

  return {
    docState,
    firestoreFn,
    reset: () => {
      docState.clear();
      autoId = 0;
    },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn },
  apps: [{}],
  initializeApp: vi.fn(),
  firestore: hoisted.firestoreFn,
}));

const sendMessage = vi.fn(async (..._a: any[]) => ({ message_id: "m1" }));
const sendToPhone = vi.fn(async (..._a: any[]) => ({ message_id: "m2" }));
vi.mock("../client", () => ({
  sendMessage: (...a: any[]) => sendMessage(...a),
  sendToPhone: (...a: any[]) => sendToPhone(...a),
  startTyping: vi.fn(async () => {}),
  stopTyping: vi.fn(async () => {}),
}));

const quickComplete = vi.fn(async (..._a: any[]) => "");
vi.mock("../../utils/openaiClient", () => ({
  quickComplete: (...a: any[]) => quickComplete(...a),
}));

vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async ({ fallback }: any) => fallback ?? "msg"),
}));
vi.mock("../../utils/dndGuard", () => ({ sendIfNotDND: vi.fn(async () => {}) }));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async () => {}) }));
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("../../observability/actionLedger", () => ({ logAgentAction: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverCancelShiftHandler", () => ({ handleCaregiverCancelShift: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverProfileHandler", () => ({ handleCaregiverProfileUpdate: vi.fn(async () => {}) }));
vi.mock("../../triggers/jobNotifications", () => ({
  handleJobResponse: vi.fn(async () => {}),
  handleAvailabilityConfirmation: vi.fn(async () => {}),
}));
import { routeCaregiverMessage } from "../routeCaregiver";

const CG_PHONE = "+15551110000";
const CAREGIVER_ID = "cg-1";

function seed(sessionPatch: Record<string, unknown> = {}) {
  hoisted.docState.set(`caregivers/${CAREGIVER_ID}`, { name: "Jane Referrer" });
  hoisted.docState.set(`agent_sessions/${CG_PHONE}`, {
    chatId: "cg-chat",
    phone: CG_PHONE,
    service: "SMS",
    userType: "caregiver",
    caregiverId: CAREGIVER_ID,
    ...sessionPatch,
  });
}

function ctx(text: string) {
  return {
    phone: CG_PHONE,
    chatId: "cg-chat",
    text,
    norm: text.toUpperCase().trim(),
    session: hoisted.docState.get(`agent_sessions/${CG_PHONE}`) as any,
  };
}

function referralDocs() {
  return [...hoisted.docState.entries()]
    .filter(([path]) => path.startsWith("referrals/"))
    .map(([path, data]) => ({ path, data }));
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  // Referral intent + name extraction now route through the LLM (CLAUDE.md
  // compliance — no regex intent parsing). Make the stub prompt-aware.
  quickComplete.mockImplementation(async (sys: string, user: string) => {
    if (/refer, invite, or recommend/i.test(sys)) return "YES";   // intent classify
    if (/question or off-topic/i.test(sys)) return "NO";          // mid-flow question guard
    if (/Extract the referred caregiver's name/i.test(sys)) {     // name extraction
      return /maria lopez/i.test(user) ? "Maria Lopez" : "";
    }
    return "";
  });
  sendToPhone.mockResolvedValue({ message_id: "m2" });
  sendMessage.mockResolvedValue({ message_id: "m1" });
});

describe("caregiver referral through Evia", () => {
  it("creates a non-bookable caregiver referral and texts the referred caregiver", async () => {
    seed();

    const outcome = await routeCaregiverMessage(ctx("refer a caregiver Maria Lopez 555-222-3333"));

    expect(outcome).toBe("handled");
    const [referral] = referralDocs();
    expect(referral.data).toMatchObject({
      referrerUserId: CAREGIVER_ID,
      referrerRole: "caregiver",
      referredRole: "caregiver",
      referredName: "Maria Lopez",
      referredPhone: "+15552223333",
      source: "cara_sms",
      status: "invited",
      bookable: false,
      checkrRequired: true,
      deliveryStatus: "sent",
    });
    expect(referral.data.eligibilityRequired).toMatchObject({
      onboardingStatus: "profile_complete",
      verificationStatus: "approved",
      checkrResult: "clear",
    });
    expect(sendToPhone).toHaveBeenCalledWith(
      "+15552223333",
      expect.stringContaining("/start?role=caregiver&ref="),
      { preferredService: "SMS" },
    );
    expect(sendMessage).toHaveBeenCalledWith("cg-chat", "Sent. I texted Maria Lopez the caregiver application link.");
  });

  it("asks only for the missing phone when the caregiver gives a name first", async () => {
    seed();

    const outcome = await routeCaregiverMessage(ctx("refer a caregiver Maria Lopez"));

    expect(outcome).toBe("handled");
    expect(sendToPhone).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith("cg-chat", "What phone number should I text for Maria Lopez?");
    expect(hoisted.docState.get(`agent_sessions/${CG_PHONE}`).pendingCaregiverReferral).toMatchObject({
      referredName: "Maria Lopez",
    });
  });

  it("finishes a pending referral when the caregiver sends the phone number later", async () => {
    seed({
      pendingCaregiverReferral: {
        referredName: "Maria Lopez",
        startedAt: "2026-06-15T00:00:00.000Z",
      },
      stateExpiresAt: "2099-01-01T00:00:00.000Z",
    });

    const outcome = await routeCaregiverMessage(ctx("555-222-3333"));

    expect(outcome).toBe("handled");
    expect(referralDocs()[0].data).toMatchObject({
      referredName: "Maria Lopez",
      referredPhone: "+15552223333",
      status: "invited",
      bookable: false,
    });
    expect(sendToPhone).toHaveBeenCalledOnce();
    expect(hoisted.docState.get(`agent_sessions/${CG_PHONE}`).pendingCaregiverReferral).toBeUndefined();
  });
});
