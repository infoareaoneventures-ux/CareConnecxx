// U7 childcare booking state-machine tests (plan 2026-07-22-002, R36-R40).
//
// Pure-policy scenarios: transition graph + actor gates; payment-authorization
// gate on confirm (no bypass — AE14); idempotent transitionKey replay (AE15);
// stale stateVersion fail-closed; truthful status copy (payment authorized
// before acceptance is NEVER described as confirmed); overnight detection;
// overlap/recurrence primitives (the conflict-check core).

import { describe, it, expect } from "vitest";
import {
  applyChildcareBookingTransition,
  buildChildcareBookingDoc,
  describeChildcareBookingStatus,
  expandRecurringDates,
  isOvernightSchedule,
  normalizeChildcareBookingSchedule,
  scheduleConflictsWith,
  timesOverlap,
  BookingPolicyError,
  CHILDCARE_BOOKING_TRANSITIONS,
  CONFLICT_BLOCKING_STATUSES,
  SAFETY_ACCESS_STATUSES,
  type ChildcareBookingDoc,
} from "./bookingPolicy";

const NOW = new Date("2026-08-01T12:00:00.000Z");

function makeBooking(overrides: Partial<ChildcareBookingDoc> = {}): ChildcareBookingDoc {
  const base = buildChildcareBookingDoc({
    bookingId: "cbook_test",
    clientId: "family-1",
    caregiverId: "cg-1",
    caregiverName: "Pat Provider",
    householdId: "hh_family-1",
    childIds: ["child-a"],
    recipientLabel: "M.",
    schedule: normalizeChildcareBookingSchedule({
      dates: [{ date: "2026-08-10", startTime: "09:00", endTime: "13:00" }],
      recurring: null,
    }),
    hourlyRate: 28,
    requestTransitionKey: "request:cbook_test",
    eligibilitySnapshot: {
      context: "booking_request",
      eligibilityVersion: "v-test",
      evidenceVersion: 1,
      at: NOW.toISOString(),
    },
    now: NOW,
  });
  return { ...base, ...overrides };
}

describe("buildChildcareBookingDoc", () => {
  it("creates a requested booking with typed recipient references and payment state 'none'", () => {
    const b = makeBooking();
    expect(b.careVertical).toBe("child");
    expect(b.status).toBe("requested");
    expect(b.stateVersion).toBe(1);
    expect(b.recipientRef).toEqual({
      careVertical: "child",
      householdId: "hh_family-1",
      childIds: ["child-a"],
    });
    expect(b.paymentAuthorization.state).toBe("none");
    expect(b.appliedTransitionKeys).toContain("request:cbook_test");
    expect(b.safetyAccessVersion).toBeNull();
  });
});

describe("transition graph (request/accept order — R36)", () => {
  it("provider accepts a requested booking", () => {
    const { next, changed } = applyChildcareBookingTransition(makeBooking(), {
      event: "accept",
      actor: "provider",
      byUid: "cg-1",
      transitionKey: "accept:cbook_test",
      now: NOW,
    });
    expect(changed).toBe(true);
    expect(next.status).toBe("accepted");
    expect(next.stateVersion).toBe(2);
  });

  it("family cannot trigger accept (actor gate)", () => {
    expect(() =>
      applyChildcareBookingTransition(makeBooking(), {
        event: "accept",
        actor: "family",
        byUid: "family-1",
        transitionKey: "k1",
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "actor_not_allowed" }));
  });

  it("confirm before acceptance is an invalid transition — request/accept order enforced", () => {
    const b = makeBooking({
      paymentAuthorization: { state: "authorized", correlationId: "pi_1", updatedAt: NOW.toISOString() },
    });
    expect(() =>
      applyChildcareBookingTransition(b, {
        event: "confirm",
        actor: "system",
        byUid: "system",
        transitionKey: "k2",
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
  });

  it("confirm without payment authorization fails closed (R36/AE14)", () => {
    const accepted = applyChildcareBookingTransition(makeBooking(), {
      event: "accept",
      actor: "provider",
      byUid: "cg-1",
      transitionKey: "accept:1",
      now: NOW,
    }).next;
    expect(() =>
      applyChildcareBookingTransition(accepted, {
        event: "confirm",
        actor: "system",
        byUid: "system",
        transitionKey: "confirm:1",
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "payment_not_authorized" }));
  });

  it("accepted + authorized confirms exactly once; replay converges (AE15)", () => {
    let b = applyChildcareBookingTransition(makeBooking(), {
      event: "accept",
      actor: "provider",
      byUid: "cg-1",
      transitionKey: "accept:1",
      now: NOW,
    }).next;
    b = {
      ...b,
      paymentAuthorization: { state: "authorized", correlationId: "pi_1", updatedAt: NOW.toISOString() },
    };
    const first = applyChildcareBookingTransition(b, {
      event: "confirm",
      actor: "system",
      byUid: "system",
      transitionKey: "confirm:pi_1",
      now: NOW,
    });
    expect(first.changed).toBe(true);
    expect(first.next.status).toBe("confirmed");
    const replay = applyChildcareBookingTransition(first.next, {
      event: "confirm",
      actor: "system",
      byUid: "system",
      transitionKey: "confirm:pi_1",
      now: NOW,
    });
    expect(replay.changed).toBe(false);
    expect(replay.next.status).toBe("confirmed");
    expect(replay.next.stateVersion).toBe(first.next.stateVersion);
  });

  it("check-in requires confirmed; check-out completes; interim visit returns to confirmed", () => {
    let b = makeBooking({ status: "confirmed", stateVersion: 3 });
    expect(() =>
      applyChildcareBookingTransition(makeBooking(), {
        event: "check_in", actor: "provider", byUid: "cg-1", transitionKey: "ci1", now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));

    b = applyChildcareBookingTransition(b, {
      event: "check_in", actor: "provider", byUid: "cg-1", transitionKey: "ci2", now: NOW,
    }).next;
    expect(b.status).toBe("in_progress");

    const interim = applyChildcareBookingTransition(b, {
      event: "check_out_visit", actor: "provider", byUid: "cg-1", transitionKey: "cov1", now: NOW,
    }).next;
    expect(interim.status).toBe("confirmed");

    const final = applyChildcareBookingTransition(b, {
      event: "check_out", actor: "provider", byUid: "cg-1", transitionKey: "co1", now: NOW,
    }).next;
    expect(final.status).toBe("completed");
    expect(final.completedAt).toBe(NOW.toISOString());
  });

  it("cancel works for family and provider from requested/accepted/confirmed, not from completed", () => {
    for (const status of ["requested", "accepted", "confirmed"] as const) {
      const { next } = applyChildcareBookingTransition(makeBooking({ status }), {
        event: "cancel", actor: "family", byUid: "family-1", transitionKey: `c-${status}`, now: NOW,
      });
      expect(next.status).toBe("canceled");
      expect(next.canceledByUid).toBe("family-1");
    }
    expect(() =>
      applyChildcareBookingTransition(makeBooking({ status: "completed" }), {
        event: "cancel", actor: "provider", byUid: "cg-1", transitionKey: "c-x", now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
  });

  it("decline only from requested, by the provider", () => {
    const { next } = applyChildcareBookingTransition(makeBooking(), {
      event: "decline", actor: "provider", byUid: "cg-1", transitionKey: "d1", now: NOW,
    });
    expect(next.status).toBe("declined");
    expect(() =>
      applyChildcareBookingTransition(makeBooking({ status: "confirmed" }), {
        event: "decline", actor: "provider", byUid: "cg-1", transitionKey: "d2", now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
  });

  it("stale stateVersion fails closed (stale booking link)", () => {
    expect(() =>
      applyChildcareBookingTransition(makeBooking({ stateVersion: 4 }), {
        event: "accept",
        actor: "provider",
        byUid: "cg-1",
        transitionKey: "a1",
        now: NOW,
        expectedStateVersion: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: "stale_state_version" }));
  });

  it("duplicate transitionKey is an idempotent no-op even across different events", () => {
    const b = makeBooking();
    const { next, changed } = applyChildcareBookingTransition(b, {
      event: "accept", actor: "provider", byUid: "cg-1", transitionKey: "request:cbook_test", now: NOW,
    });
    // request:cbook_test was already applied at creation — replay converges.
    expect(changed).toBe(false);
    expect(next.status).toBe("requested");
  });

  it("every transition declares actors and gates (table completeness)", () => {
    for (const [event, spec] of Object.entries(CHILDCARE_BOOKING_TRANSITIONS)) {
      expect(spec.actors.length, event).toBeGreaterThan(0);
      expect(spec.from.length, event).toBeGreaterThan(0);
      expect(spec.gates.length, event).toBeGreaterThan(0);
    }
    // confirm is SYSTEM-only and payment-gated — the R36 spine.
    expect(CHILDCARE_BOOKING_TRANSITIONS.confirm.actors).toEqual(["system"]);
    expect(CHILDCARE_BOOKING_TRANSITIONS.confirm.gates).toContain("payment_authorized");
    // cancel documents the AE6 revoke-first gate.
    expect(CHILDCARE_BOOKING_TRANSITIONS.cancel.gates).toContain("revoke_safety_first");
  });
});

describe("truthful status copy (AE14)", () => {
  it("payment authorization before acceptance stays pending — never described as confirmed", () => {
    const requested = describeChildcareBookingStatus("requested", "authorized");
    expect(requested.toLowerCase()).toContain("pending");
    expect(requested).not.toMatch(/booking confirmed|care is confirmed/i);
    expect(requested.toLowerCase()).toContain("not confirmed");

    const accepted = describeChildcareBookingStatus("accepted", "authorized");
    expect(accepted.toLowerCase()).toContain("not confirmed");
  });

  it("only the confirmed status says confirmed", () => {
    expect(describeChildcareBookingStatus("confirmed")).toBe("Booking confirmed.");
    for (const status of ["requested", "accepted", "declined", "canceled"] as const) {
      expect(describeChildcareBookingStatus(status, "authorized")).not.toBe("Booking confirmed.");
    }
  });
});

describe("schedule normalization + overnight detection (deferred category — R37)", () => {
  it("rejects malformed dates/times and empty schedules", () => {
    expect(() => normalizeChildcareBookingSchedule({ dates: [{ date: "bad", startTime: "09:00", endTime: "10:00" }] }))
      .toThrowError(BookingPolicyError);
    expect(() => normalizeChildcareBookingSchedule({ dates: [], recurring: null }))
      .toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() => normalizeChildcareBookingSchedule({ recurring: { days: ["funday"], startTime: "09:00", endTime: "10:00" } }))
      .toThrowError(BookingPolicyError);
  });

  it("flags midnight-crossing windows as overnight (concrete dates AND recurring)", () => {
    expect(
      isOvernightSchedule(normalizeChildcareBookingSchedule({
        dates: [{ date: "2026-08-10", startTime: "20:00", endTime: "06:00" }],
      })),
    ).toBe(true);
    expect(
      isOvernightSchedule(normalizeChildcareBookingSchedule({
        recurring: { days: ["friday"], startTime: "22:00", endTime: "06:00" },
      })),
    ).toBe(true);
    expect(
      isOvernightSchedule(normalizeChildcareBookingSchedule({
        dates: [{ date: "2026-08-10", startTime: "09:00", endTime: "17:00" }],
      })),
    ).toBe(false);
  });
});

describe("overlap + recurrence primitives (conflict-check core)", () => {
  it("timesOverlap detects partial and containment overlaps, not adjacency", () => {
    expect(timesOverlap("09:00", "13:00", "12:00", "14:00")).toBe(true);
    expect(timesOverlap("09:00", "13:00", "10:00", "11:00")).toBe(true);
    expect(timesOverlap("09:00", "13:00", "13:00", "14:00")).toBe(false);
    expect(timesOverlap("09:00", "13:00", "07:00", "09:00")).toBe(false);
  });

  it("scheduleConflictsWith matches explicit dates and recurring day rules", () => {
    const schedule = normalizeChildcareBookingSchedule({
      dates: [{ date: "2026-08-10", startTime: "09:00", endTime: "13:00" }],
      recurring: { days: ["wednesday"], startTime: "14:00", endTime: "18:00" },
    });
    expect(scheduleConflictsWith(schedule, { date: "2026-08-10", startTime: "12:00", endTime: "14:00" })).toBe(true);
    // 2026-08-12 is a Wednesday.
    expect(scheduleConflictsWith(schedule, { date: "2026-08-12", startTime: "15:00", endTime: "16:00" })).toBe(true);
    // Thursday, no overlap.
    expect(scheduleConflictsWith(schedule, { date: "2026-08-13", startTime: "15:00", endTime: "16:00" })).toBe(false);
  });

  it("expandRecurringDates walks the window inclusively", () => {
    const dates = expandRecurringDates(
      { days: ["monday", "wednesday"], startTime: "09:00", endTime: "12:00" },
      "2026-08-03", // a Monday
      "2026-08-14",
    );
    expect(dates.map((d) => d.date)).toEqual([
      "2026-08-03", "2026-08-05", "2026-08-10", "2026-08-12",
    ]);
    expect(dates[0]).toMatchObject({ startTime: "09:00", endTime: "12:00" });
  });
});

describe("status vocabularies (structural senior isolation)", () => {
  it("the entry state is 'requested' — never senior 'pending'", () => {
    expect(makeBooking().status).toBe("requested");
    expect(CONFLICT_BLOCKING_STATUSES).not.toContain("pending" as never);
  });

  it("safety access statuses are exactly accepted/confirmed/in_progress (time-bounded — R38)", () => {
    expect([...SAFETY_ACCESS_STATUSES].sort()).toEqual(["accepted", "confirmed", "in_progress"]);
  });
});
