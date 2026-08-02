import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  requireOperatorScope: vi.fn(async () => "operator-1"),
}));

vi.mock("firebase-admin", () => {
  const firestore = () => ({
    collection: (collection: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = hoisted.docs.get(`${collection}/${id}`);
          return { exists: Boolean(data), data: () => data };
        },
      }),
    }),
  });
  return { __esModule: true, default: { firestore }, firestore };
});

vi.mock("../admin/requireOperatorScope", () => ({
  OPERATOR_SCOPE_GENERAL: "generalOperator",
  requireOperatorScope: hoisted.requireOperatorScope,
}));

import { bustChildcareFlagsCache } from "../config/featureFlags";
import { appCheckReplayProbe as _appCheckReplayProbe } from "./appCheckProbe";

// The firebase-functions/v1 stub makes onCall(fn) === fn.
/* eslint-disable @typescript-eslint/no-explicit-any */
const appCheckReplayProbe = _appCheckReplayProbe as any;

const CHALLENGE = "challenge_1234567890";

function context(overrides: Record<string, unknown> = {}) {
  return {
    app: { appId: "1:123:web:abc", alreadyConsumed: false },
    auth: {
      uid: "operator-1",
      token: { aud: "careconnex-d4c8b", auth_time: Math.floor(Date.now() / 1000) },
    },
    rawRequest: {
      headers: { origin: "https://careconnex-d4c8b.web.app" },
    },
    ...overrides,
  } as any;
}

beforeEach(() => {
  hoisted.docs.clear();
  hoisted.requireOperatorScope.mockClear();
  process.env.GCLOUD_PROJECT = "careconnex-d4c8b";
  hoisted.docs.set("childcare_flags/global", {
    CHILDCARE_APPCHECK_MODE: "enforce",
    CHILDCARE_APPCHECK_TRANSITION_AT: "2026-07-25T00:00:00.000Z",
    CHILDCARE_APPCHECK_PROVIDER_VERIFIED: true,
    CHILDCARE_APPCHECK_DEBUG_TOKENS_ALLOWED: false,
    CHILDCARE_APPCHECK_VERIFIED_DOMAINS: [
      "careconnex-d4c8b.web.app",
      "careconnex-d4c8b.firebaseapp.com",
    ],
  });
  hoisted.docs.set(`childcare_appcheck_probe_challenges/${CHALLENGE}`, {
    active: true,
    projectId: "careconnex-d4c8b",
    appId: "1:123:web:abc",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  bustChildcareFlagsCache();
});

describe("appCheckReplayProbe", () => {
  it("returns bounded proof for an operator on an approved Hosting origin", async () => {
    const result = await appCheckReplayProbe({ challengeId: CHALLENGE }, context());
    expect(result).toMatchObject({
      success: true,
      policy: "limited-use",
      projectId: "careconnex-d4c8b",
      appId: "1:123:web:abc",
    });
    expect(result.challengeDigest).toMatch(/^[a-f0-9]{24}$/);
    expect(hoisted.requireOperatorScope).toHaveBeenCalledWith(
      expect.anything(),
      "generalOperator",
      { recentAuth: true },
    );
  });

  it("rejects an unapproved origin without revealing challenge state", async () => {
    await expect(
      appCheckReplayProbe(
        { challengeId: CHALLENGE },
        context({ rawRequest: { headers: { origin: "https://evil.example" } } }),
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("rejects stale challenges and client-supplied domain payloads", async () => {
    hoisted.docs.set(`childcare_appcheck_probe_challenges/${CHALLENGE}`, {
      active: true,
      projectId: "careconnex-d4c8b",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    await expect(
      appCheckReplayProbe({ challengeId: CHALLENGE }, context()),
    ).rejects.toMatchObject({ code: "permission-denied" });
    await expect(
      appCheckReplayProbe(
        { challengeId: CHALLENGE, domainPayload: { childId: "child-1" } },
        context(),
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("rejects a consumed limited-use token before the probe body", async () => {
    await expect(
      appCheckReplayProbe(
        { challengeId: CHALLENGE },
        context({ app: { appId: "1:123:web:abc", alreadyConsumed: true } }),
      ),
    ).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "app_check_replay" },
    });
    expect(hoisted.requireOperatorScope).not.toHaveBeenCalled();
  });
});
