import { describe, it, expect, vi } from "vitest";
import { readFlag, isStateExpired, setFlags, clearFlags } from "../sessionState";

describe("readFlag (validated session access)", () => {
  it("returns the value when present and no validator is given", () => {
    expect(readFlag({ hireMode: true }, "hireMode")).toBe(true);
  });

  it("returns null for an absent flag (instead of undefined to destructure)", () => {
    expect(readFlag({}, "pendingCancelConfirm")).toBeNull();
    expect(readFlag(undefined, "pendingCancelConfirm")).toBeNull();
    expect(readFlag(null, "pendingCancelConfirm")).toBeNull();
  });

  it("returns null when the value fails the shape guard (the crash this prevents)", () => {
    const hasApptId = (v: unknown) => !!v && typeof v === "object" && typeof (v as any).appointmentId === "string";
    // Malformed flag — present but missing appointmentId. The router used to
    // destructure this into undefined and call db.doc(undefined).
    expect(readFlag({ pendingCancelConfirm: {} }, "pendingCancelConfirm", hasApptId)).toBeNull();
    expect(readFlag({ pendingCancelConfirm: { foo: 1 } }, "pendingCancelConfirm", hasApptId)).toBeNull();
  });

  it("returns the typed value when it passes the shape guard", () => {
    const hasApptId = (v: unknown) => !!v && typeof v === "object" && typeof (v as any).appointmentId === "string";
    const ok = { appointmentId: "a1" };
    expect(readFlag({ pendingCancelConfirm: ok }, "pendingCancelConfirm", hasApptId)).toEqual(ok);
  });
});

describe("isStateExpired", () => {
  const now = new Date("2026-06-21T12:00:00Z");

  it("false when no deadline is set", () => {
    expect(isStateExpired({}, now)).toBe(false);
    expect(isStateExpired({ stateExpiresAt: "" }, now)).toBe(false);
  });

  it("true when the ISO deadline is in the past", () => {
    expect(isStateExpired({ stateExpiresAt: "2026-06-21T11:59:59Z" }, now)).toBe(true);
  });

  it("false when the deadline is still in the future", () => {
    expect(isStateExpired({ stateExpiresAt: "2026-06-21T12:00:01Z" }, now)).toBe(false);
  });

  it("false for an unparseable deadline (fail-safe — don't expire on garbage)", () => {
    expect(isStateExpired({ stateExpiresAt: "not-a-date" }, now)).toBe(false);
  });
});

describe("setFlags / clearFlags (batched writes)", () => {
  function mockDb() {
    const update = vi.fn().mockResolvedValue(undefined);
    return { update, db: { collection: () => ({ doc: () => ({ update }) }) } as any };
  }

  it("setFlags writes all given flags in one update", async () => {
    const { update, db } = mockDb();
    await setFlags("+1", db, { hireMode: true, stateExpiresAt: "2026-06-21T13:00:00Z" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ hireMode: true, stateExpiresAt: "2026-06-21T13:00:00Z" });
  });

  it("clearFlags deletes only the named subset in one update", async () => {
    const { update, db } = mockDb();
    await clearFlags("+1", db, ["awaitingPreShiftUpdate", "stateExpiresAt"]);
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(Object.keys(arg).sort()).toEqual(["awaitingPreShiftUpdate", "stateExpiresAt"]);
  });
});
