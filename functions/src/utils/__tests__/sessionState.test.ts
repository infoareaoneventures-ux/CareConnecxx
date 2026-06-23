import { describe, it, expect } from "vitest";
import {
  staleConfirmFlags,
  CONFIRM_FLAG_TTL_MS,
  HIGH_STAKES_CONFIRM_FLAGS,
} from "../sessionState";

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
