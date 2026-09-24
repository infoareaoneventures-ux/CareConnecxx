import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const updates: Array<{ path: string; data: any }> = [];
  const adds: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    get: vi.fn(async () => ({
      exists: docState.has(path),
      data: () => docState.get(path),
    })),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      docState.set(path, { ...(docState.get(path) ?? {}), ...data });
    }),
  });

  const makeCollRef = (path: string): any => ({
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    add: vi.fn(async (data: any) => {
      adds.push({ path, data });
      return { id: `auto-${adds.length}` };
    }),
  });

  return {
    docState,
    updates,
    adds,
    collection: vi.fn((path: string) => makeCollRef(path)),
    reset: () => {
      docState.clear();
      updates.length = 0;
      adds.length = 0;
    },
  };
});

const sendMessage = vi.fn(async (..._args: any[]) => ({ message_id: "m1" }));

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collection }) },
  firestore: () => ({ collection: hoisted.collection }),
}));

vi.mock("../linq/client", () => ({
  sendMessage: (...args: any[]) => sendMessage(...args),
}));

vi.mock("../memory/preferences", () => ({
  getPreferences: vi.fn(async () => ({ dndEnabled: false })),
  isInDND: vi.fn(() => false),
  isActiveHour: vi.fn(() => true),
}));

vi.mock("../safety/supervisor", () => ({ supervise: vi.fn(async (text: string) => text) }));
vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("../observability/consentAudit", () => ({
  buildConsentAuditRecord: vi.fn((_phone, _source, action) => ({ action })),
}));
vi.mock("../utils/outboundLedger", () => ({ claimOutboundSend: vi.fn(async () => true) }));
vi.mock("../utils/openaiClient", () => ({ quickComplete: vi.fn(async () => "SEND") }));
vi.mock("./caregiverSearch", () => ({
  presentCaregiverSearch: vi.fn(async () => ({ status: "shown", total: 0, shown: [], offset: 0, hasMore: false })),
  searchCaregivers: vi.fn(async () => ({ total: 0, caregivers: [], hasLocation: false, filters: {} })),
}));
vi.mock("./intentClassifier", () => ({ classifyIntent: vi.fn(async () => "QUESTION") }));

import { sendViaInteractionAgent } from "./caraAgent";

const PHONE = "+15550001111";

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  hoisted.docState.set(`agent_sessions/${PHONE}`, {
    chatId: "private-chat",
    userId: "client-1",
    optedOut: false,
  });
});

describe("sendViaInteractionAgent source-agent routing", () => {
  it("keeps visit completion/payment approval prompts in the private primary chat", async () => {
    await sendViaInteractionAgent(PHONE, {
      content: "Reply APPROVE to approve Maria's hours.",
      urgency: "immediate",
      sourceAgent: "visit_completion",
      canDrop: false,
      preferredService: "SMS" as any,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "private-chat",
      expect.stringContaining("APPROVE"),
      { preferredService: "SMS" },
    );
  });

  it("passes _noQueue to sendMessage when the caller owns its own retry (noQueueOnFailure)", async () => {
    await sendViaInteractionAgent(PHONE, {
      content: "Basra Yousuf submitted 1h for today ($20).",
      urgency: "standard",
      sourceAgent: "billing_approval_notice",
      canDrop: false,
      preferredService: "SMS" as any,
      noQueueOnFailure: true,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "private-chat",
      expect.stringContaining("Basra Yousuf"),
      { preferredService: "SMS", _noQueue: true },
    );
  });
});
