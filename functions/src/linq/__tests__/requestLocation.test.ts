import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (mirror client.protocol.test.ts) ────────────────────────────────────

const hoisted = vi.hoisted(() => {
  const postMock = vi.fn();
  return { postMock };
});

vi.mock("axios", () => ({
  __esModule: true,
  default: {
    post:   (...a: unknown[]) => hoisted.postMock(...a),
    get:    vi.fn(async () => ({ data: {}, headers: {} })),
    delete: vi.fn(async () => ({ data: {}, headers: {} })),
  },
}));

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: vi.fn() }) },
  firestore: () => ({ collection: vi.fn() }),
}));

vi.mock("uuid", () => ({ v4: () => "uuid-test" }));
vi.mock("../../safety/supervisor", () => ({ supervise: vi.fn(async (m: string) => m) }));
vi.mock("../../observability/auditLog", () => ({ logMessageSent: vi.fn(async () => {}) }));

import { requestLocation } from "../client";

function locationRequestCalls(): any[] {
  return hoisted.postMock.mock.calls.filter(
    ([url]) => typeof url === "string" && /\/chats\/.+\/location\/request$/.test(url)
  );
}

describe("requestLocation", () => {
  beforeEach(() => hoisted.postMock.mockReset());

  it("returns { requested: true } and hits /location/request on 2xx", async () => {
    hoisted.postMock.mockResolvedValueOnce({ data: { success: true }, headers: {} });
    const r = await requestLocation("chat_123");
    expect(r).toEqual({ requested: true });
    const calls = locationRequestCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatch(/\/chats\/chat_123\/location\/request$/);
    // auth header present
    expect((calls[0][2] as any)?.headers?.Authorization).toMatch(/^Bearer /);
  });

  it("returns { requested: false, status: 409 } on a 409 without throwing", async () => {
    hoisted.postMock.mockRejectedValueOnce({ response: { status: 409, data: {} } });
    const r = await requestLocation("chat_sms");
    expect(r.requested).toBe(false);
    expect(r.status).toBe(409);
  });

  it("does not retry on failure (single POST attempt)", async () => {
    hoisted.postMock.mockRejectedValueOnce({ response: { status: 500, data: {} } });
    const r = await requestLocation("chat_5xx");
    expect(r.requested).toBe(false);
    expect(locationRequestCalls()).toHaveLength(1);
  });

  it("returns { requested: false } for an empty chatId without a network call", async () => {
    const r = await requestLocation("");
    expect(r).toEqual({ requested: false });
    expect(hoisted.postMock).not.toHaveBeenCalled();
  });
});
