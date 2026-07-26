// U2 / KTD22 (childcare marketplace plan 2026-07-22-002): App Check gate for
// the new childcare callables. Monitor mode (the shipping default until the
// founder registers the console provider) logs and allows; enforce mode fails
// closed; senior callables are untouched (they never call this helper).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  requireAppCheck,
  childcareAppCheckMode,
  CHILDCARE_APPCHECK_MODE_ENV,
} from "./requireAppCheck";

const withApp = { app: { appId: "app-1" }, auth: { uid: "u1" } } as any;
const withoutApp = { auth: { uid: "u1" } } as any;

const originalEnv = process.env[CHILDCARE_APPCHECK_MODE_ENV];

beforeEach(() => {
  delete process.env[CHILDCARE_APPCHECK_MODE_ENV];
  vi.restoreAllMocks();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[CHILDCARE_APPCHECK_MODE_ENV];
  else process.env[CHILDCARE_APPCHECK_MODE_ENV] = originalEnv;
});

describe("childcareAppCheckMode", () => {
  it("defaults to monitor when unset", () => {
    expect(childcareAppCheckMode()).toBe("monitor");
  });

  it("reads off / monitor / enforce (case-insensitive)", () => {
    process.env[CHILDCARE_APPCHECK_MODE_ENV] = "enforce";
    expect(childcareAppCheckMode()).toBe("enforce");
    process.env[CHILDCARE_APPCHECK_MODE_ENV] = "OFF";
    expect(childcareAppCheckMode()).toBe("off");
    process.env[CHILDCARE_APPCHECK_MODE_ENV] = "Monitor";
    expect(childcareAppCheckMode()).toBe("monitor");
  });

  it("unknown values fall back to monitor (with a warning), never silently enforce or disable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[CHILDCARE_APPCHECK_MODE_ENV] = "banana";
    expect(childcareAppCheckMode()).toBe("monitor");
    expect(warn).toHaveBeenCalled();
  });
});

describe("requireAppCheck", () => {
  it("MONITOR mode: missing App Check token is logged but allowed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = requireAppCheck(withoutApp, "createHousehold");
    expect(result).toEqual({ verified: false, mode: "monitor", consumed: false });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("createHousehold"),
      expect.objectContaining({ uidPresent: true }),
    );
  });

  it("MONITOR mode: a verified app passes silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(requireAppCheck(withApp, "createHousehold")).toEqual({
      verified: true,
      mode: "monitor",
      consumed: false,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("ENFORCE mode: missing token fails closed with an enumeration-safe error", () => {
    process.env[CHILDCARE_APPCHECK_MODE_ENV] = "enforce";
    expect(() => requireAppCheck(withoutApp, "grantGuardianAuthority")).toThrowError(
      expect.objectContaining({ code: "failed-precondition" }),
    );
  });

  it("ENFORCE mode: a verified app passes", () => {
    process.env[CHILDCARE_APPCHECK_MODE_ENV] = "enforce";
    expect(requireAppCheck(withApp, "grantGuardianAuthority")).toEqual({
      verified: true,
      mode: "enforce",
      consumed: false,
    });
  });

  it("explicit mode override wins over env (used by callable tests)", () => {
    process.env[CHILDCARE_APPCHECK_MODE_ENV] = "monitor";
    expect(() =>
      requireAppCheck(withoutApp, "revokeGuardianAuthority", { mode: "enforce" }),
    ).toThrowError(expect.objectContaining({ code: "failed-precondition" }));
  });

  it("OFF mode never throws and never logs", () => {
    process.env[CHILDCARE_APPCHECK_MODE_ENV] = "off";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(requireAppCheck(withoutApp, "x").mode).toBe("off");
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects replayed limited-use tokens before the handler runs", () => {
    const replayed = {
      ...withApp,
      app: { ...withApp.app, alreadyConsumed: true },
    };

    expect(() =>
      requireAppCheck(replayed, "grantGuardianAuthority", {
        mode: "enforce",
        rejectConsumed: true,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "failed-precondition",
        details: { code: "app_check_replay" },
      }),
    );
  });

  it("records but allows consumed tokens for standard callables", () => {
    const replayed = {
      ...withApp,
      app: { ...withApp.app, alreadyConsumed: true },
    };

    expect(requireAppCheck(replayed, "getChildProfile", { mode: "enforce" })).toEqual({
      verified: true,
      mode: "enforce",
      consumed: true,
    });
  });
});
