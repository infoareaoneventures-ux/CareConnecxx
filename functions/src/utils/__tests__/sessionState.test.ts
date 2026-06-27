import { describe, it, expect, vi } from "vitest";
import { readFlag, isStateExpired, setFlags, clearFlags, staleConfirmFlags, CONFIRM_FLAG_TTL_MS, HIGH_STAKES_CONFIRM_FLAGS } from "../sessionState";

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

// U2 — high-stakes confirmation freshness. The router clears stale confirm
// flags before acting on a YES/NO so a flag set long ago can't intercept a
// reply meant for a newer question.

const NOW = Date.parse("2026-06-22T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const fresh = iso(NOW - 60 * 1000);                       // 1 min old
const stale = iso(NOW - CONFIRM_FLAG_TTL_MS - 60 * 1000); // just past the TTL

describe("staleConfirmFlags (U2)", () => {
  it("returns nothing when no confirm flags are set", () => {
    expect(staleConfirmFlags({}, NOW)).toEqual([]);
  });

  it("keeps a fresh flag (set within the TTL)", () => {
    const session = { pendingCancelConfirm: { appointmentId: "a1" }, pendingCancelConfirmSetAt: fresh };
    expect(staleConfirmFlags(session, NOW)).toEqual([]);
  });

  it("expires a flag older than the TTL", () => {
    const session = { pendingCancelConfirm: { appointmentId: "a1" }, pendingCancelConfirmSetAt: stale };
    expect(staleConfirmFlags(session, NOW)).toEqual(["pendingCancelConfirm"]);
  });

  it("expires a flag with no age stamp (the never-expires case)", () => {
    const session = { pendingInterviewConfirm: { docId: "d1" } };
    expect(staleConfirmFlags(session, NOW)).toEqual(["pendingInterviewConfirm"]);
  });

  it("resolves only the stale flag when a stale and a fresh flag collide", () => {
    // Stale interview confirm should NOT intercept a YES meant for the fresh
    // recurring confirmation — it must be swept first.
    const session = {
      pendingInterviewConfirm: { docId: "d1" },
      pendingInterviewConfirmSetAt: stale,
      awaitingRecurringConfirmation: true,
      awaitingRecurringConfirmationSetAt: fresh,
    };
    expect(staleConfirmFlags(session, NOW)).toEqual(["pendingInterviewConfirm"]);
  });

  it("expires each high-stakes flag independently when all are stale", () => {
    const session: Record<string, unknown> = {};
    for (const flag of HIGH_STAKES_CONFIRM_FLAGS) {
      session[flag] = true;
      session[`${flag}SetAt`] = stale;
    }
    expect(staleConfirmFlags(session, NOW).sort()).toEqual([...HIGH_STAKES_CONFIRM_FLAGS].sort());
  });

  it("treats the TTL boundary as not-yet-stale", () => {
    // Exactly at the cutoff (setAt === cutoff) is not strictly less-than, so fresh.
    const session = { pendingCancelConfirm: true, pendingCancelConfirmSetAt: iso(NOW - CONFIRM_FLAG_TTL_MS) };
    expect(staleConfirmFlags(session, NOW)).toEqual([]);
  });
});
