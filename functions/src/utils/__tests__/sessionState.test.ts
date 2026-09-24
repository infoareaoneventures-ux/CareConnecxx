import { describe, it, expect, vi } from "vitest";
import {
  readFlag, isStateExpired, setFlags, clearFlags, staleConfirmFlags,
  CONFIRM_FLAG_TTL_MS, HIGH_STAKES_CONFIRM_FLAGS,
  hasActiveSmsFlow, GUARDED_SMS_FLAGS, PASSIVE_SMS_FLAGS, STATE_MACHINE_FLAGS,
  JOB_INVITE_TTL_MS, MULTI_STEP_FLOW_TTL_MS,
  PENDING_MATCHES_TTL_MS, INSTANT_PAYOUT_CONFIRM_TTL_MS, CREDENTIAL_FLOW_TTL_MS,
} from "../sessionState";

describe("readFlag (validated session access)", () => {
  it("returns the value when present and no validator is given", () => {
    expect(readFlag({ awaitingLateMinutes: true }, "awaitingLateMinutes")).toBe(true);
  });

  it("returns null for an absent flag (instead of undefined to destructure)", () => {
    expect(readFlag({}, "awaitingCareNotes")).toBeNull();
    expect(readFlag(undefined, "awaitingCareNotes")).toBeNull();
    expect(readFlag(null, "awaitingCareNotes")).toBeNull();
  });

  it("returns null when the value fails the shape guard (the crash this prevents)", () => {
    const hasApptId = (v: unknown) => !!v && typeof v === "object" && typeof (v as any).appointmentId === "string";
    // Malformed flag — present but missing appointmentId. The router used to
    // destructure this into undefined and call db.doc(undefined).
    expect(readFlag({ awaitingCareNotes: {} }, "awaitingCareNotes", hasApptId)).toBeNull();
    expect(readFlag({ awaitingCareNotes: { foo: 1 } }, "awaitingCareNotes", hasApptId)).toBeNull();
  });

  it("returns the typed value when it passes the shape guard", () => {
    const hasApptId = (v: unknown) => !!v && typeof v === "object" && typeof (v as any).appointmentId === "string";
    const ok = { appointmentId: "a1" };
    expect(readFlag({ awaitingCareNotes: ok }, "awaitingCareNotes", hasApptId)).toEqual(ok);
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
    await setFlags("+1", db, { awaitingCareNotes: true, stateExpiresAt: "2026-06-21T13:00:00Z" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ awaitingCareNotes: true, stateExpiresAt: "2026-06-21T13:00:00Z" });
  });

  it("clearFlags deletes only the named subset in one update", async () => {
    const { update, db } = mockDb();
    await clearFlags("+1", db, ["awaitingTaskAck", "stateExpiresAt"]);
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(Object.keys(arg).sort()).toEqual(["awaitingTaskAck", "stateExpiresAt"]);
  });
});

// U2 — high-stakes confirmation freshness. The router clears stale confirm
// flags before acting on a YES/NO so a flag set long ago can't intercept a
// reply meant for a newer question.

const NOW = Date.parse("2026-06-22T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const stale = iso(NOW - CONFIRM_FLAG_TTL_MS - 60 * 1000); // just past the TTL

describe("staleConfirmFlags (U2)", () => {
  it("returns nothing when no confirm flags are set", () => {
    expect(staleConfirmFlags({}, NOW)).toEqual([]);
  });

  it("expires each high-stakes flag independently when all are stale", () => {
    const session: Record<string, unknown> = {};
    for (const flag of HIGH_STAKES_CONFIRM_FLAGS) {
      session[flag] = true;
      session[`${flag}SetAt`] = stale;
    }
    expect(staleConfirmFlags(session, NOW).sort()).toEqual([...HIGH_STAKES_CONFIRM_FLAGS].sort());
  });

});

// U2 — web-turn guard against fresh in-flight SMS flows (deny-by-default,
// staleness-composed). Pure predicate, unit-tested in isolation here; the
// webChat integration test mocks it.
describe("hasActiveSmsFlow (U2 web guard)", () => {
  it("no flags → not active", () => {
    expect(hasActiveSmsFlow({}, NOW)).toBe(false);
    expect(hasActiveSmsFlow(null, NOW)).toBe(false);
    expect(hasActiveSmsFlow(undefined, NOW)).toBe(false);
  });

  it("pendingInstantPayoutConfirm (value-stamped): 5-min-old ISO value defers, 15-min-old does not (10-min SMS parity)", () => {
    expect(hasActiveSmsFlow({ pendingInstantPayoutConfirm: iso(NOW - 5 * 60 * 1000) }, NOW)).toBe(true);
    expect(hasActiveSmsFlow({ pendingInstantPayoutConfirm: iso(NOW - 15 * 60 * 1000) }, NOW)).toBe(false);
    expect(hasActiveSmsFlow(
      { pendingInstantPayoutConfirm: iso(NOW - INSTANT_PAYOUT_CONFIRM_TTL_MS - 1000) }, NOW,
    )).toBe(false);
  });

  it("pendingInstantPayoutConfirm with an unparseable value is stale (never wedges the web surface)", () => {
    expect(hasActiveSmsFlow({ pendingInstantPayoutConfirm: "yes please" }, NOW)).toBe(false);
    expect(hasActiveSmsFlow({ pendingInstantPayoutConfirm: true }, NOW)).toBe(false);
  });

  it("pendingShiftApproval (stamped on pendingShiftApprovalSetAt): fresh defers, past 24h or missing stamp does not", () => {
    const freshStamp = iso(NOW - 60 * 60 * 1000);
    const staleStamp = iso(NOW - MULTI_STEP_FLOW_TTL_MS - 60 * 1000);
    expect(hasActiveSmsFlow(
      { pendingShiftApproval: { appointmentId: "a1" }, pendingShiftApprovalSetAt: freshStamp }, NOW,
    )).toBe(true);
    expect(hasActiveSmsFlow(
      { pendingShiftApproval: { appointmentId: "a1" }, pendingShiftApprovalSetAt: staleStamp }, NOW,
    )).toBe(false);
    expect(hasActiveSmsFlow({ pendingShiftApproval: { appointmentId: "a1" } }, NOW)).toBe(false);
  });

  it("pendingMatches (stamped, 2h routeIntent parity): fresh defers, >2h or missing stamp does not — a web matching turn must not wedge later web turns", () => {
    const matches = [{ caregiverId: "cg-1" }];
    expect(hasActiveSmsFlow(
      { pendingMatches: matches, pendingMatchesSetAt: iso(NOW - 30 * 60 * 1000) }, NOW,
    )).toBe(true);
    expect(hasActiveSmsFlow(
      { pendingMatches: matches, pendingMatchesSetAt: iso(NOW - PENDING_MATCHES_TTL_MS - 60 * 1000) }, NOW,
    )).toBe(false);
    expect(hasActiveSmsFlow({ pendingMatches: matches }, NOW)).toBe(false);
  });

  it("collectingCredential uses the 30-min CREDENTIAL_FLOW_TTL_MS (SMS router parity), not the 24h step TTL", () => {
    expect(hasActiveSmsFlow(
      { collectingCredential: true, collectingCredentialSetAt: iso(NOW - 10 * 60 * 1000) }, NOW,
    )).toBe(true);
    // 45 min old: stale under the 30-min credential TTL (used to defer under 24h).
    expect(hasActiveSmsFlow(
      { collectingCredential: true, collectingCredentialSetAt: iso(NOW - 45 * 60 * 1000) }, NOW,
    )).toBe(false);
    expect(CREDENTIAL_FLOW_TTL_MS).toBe(30 * 60 * 1000);
  });

  it("invite flag: fresh (within 48h) defers, past-TTL does not", () => {
    const freshInvite = iso(NOW - 60 * 1000);
    const staleInvite = iso(NOW - JOB_INVITE_TTL_MS - 60 * 1000);
    expect(hasActiveSmsFlow({ awaitingJobResponse: true, pendingJobSentAt: freshInvite }, NOW)).toBe(true);
    expect(hasActiveSmsFlow({ awaitingJobResponse: true, pendingJobSentAt: staleInvite }, NOW)).toBe(false);
  });

  it("generic stamp-less flow: future stateExpiresAt defers, past does not, absent defers (deny-by-default)", () => {
    expect(hasActiveSmsFlow({ awaitingCareNotes: true, stateExpiresAt: iso(NOW + 60 * 1000) }, NOW)).toBe(true);
    expect(hasActiveSmsFlow({ awaitingCareNotes: true, stateExpiresAt: iso(NOW - 60 * 1000) }, NOW)).toBe(false);
    expect(hasActiveSmsFlow({ awaitingCareNotes: true }, NOW)).toBe(true);
  });

  it("passive ack flags never defer a web turn", () => {
    expect(hasActiveSmsFlow({ pendingBgCheckAck: true }, NOW)).toBe(false);
    expect(hasActiveSmsFlow({ pendingPayoutNotificationAck: true }, NOW)).toBe(false);
    expect(hasActiveSmsFlow({ awaitingTaskAck: true }, NOW)).toBe(false);
    expect(hasActiveSmsFlow({ pendingShiftConfirmation: true }, NOW)).toBe(false);
  });
});

// Drift guard: every STATE_MACHINE_FLAGS entry MUST be classified as either
// guarded or explicitly passive. A newly-added flag that is neither fails here,
// forcing a deliberate categorization instead of silently falling open on the
// split-brain surface.
describe("web-guard flag classification is exhaustive (drift test)", () => {
  const guarded = new Set(GUARDED_SMS_FLAGS.map(([f]) => f));

  it("guarded and passive sets are disjoint", () => {
    const overlap = [...guarded].filter((f) => PASSIVE_SMS_FLAGS.has(f));
    expect(overlap).toEqual([]);
  });

  it("guarded ∪ passive covers every STATE_MACHINE_FLAGS entry (no uncategorized flag)", () => {
    const uncategorized = STATE_MACHINE_FLAGS.filter(
      (f) => !guarded.has(f) && !PASSIVE_SMS_FLAGS.has(f),
    );
    expect(uncategorized).toEqual([]);
  });

  it("classification introduces no flag outside STATE_MACHINE_FLAGS", () => {
    const known = new Set<string>(STATE_MACHINE_FLAGS);
    const strays = [...guarded, ...PASSIVE_SMS_FLAGS].filter((f) => !known.has(f));
    expect(strays).toEqual([]);
  });
});
