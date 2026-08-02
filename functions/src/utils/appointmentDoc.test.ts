// U7: canonical appointment fields — senior characterization + the additive
// childcare vertical seam (plan 2026-07-22-002, R33/R46).
//
// Senior parity: canonicalApptFields output is pinned byte-for-byte (every
// existing appointment writer spreads it — bookingExecutor, recurringScheduler,
// inboundHelpers, routeIntent, modifyScheduleFlow, mcp/server, shiftGenerator
// callers). Childcare: childcareApptFields carries typed recipient REFERENCES
// + the display label ONLY; assertChildSafeAppointmentDoc rejects every
// child-sensitive field.

import { describe, it, expect } from "vitest";
import {
  canonicalApptFields,
  childcareApptFields,
  isChildcareVerticalDoc,
  assertChildSafeAppointmentDoc,
  normalizeAppointmentDate,
  normalizeAppointmentTime,
  normalizeAppointmentDuration,
  CHILD_SENSITIVE_APPT_FIELDS,
} from "./appointmentDoc";

describe("canonicalApptFields (senior characterization — unchanged by U7)", () => {
  it("mirrors startTime/duration/cost exactly as before", () => {
    expect(canonicalApptFields({ startTime: "09:00", durationHours: 3, hourlyRate: 30 })).toEqual({
      time: "09:00",
      duration: 3,
      paymentStatus: "pending",
      cost: 90,
    });
  });

  it("explicit cost wins over the rate derivation; missing inputs degrade as before", () => {
    expect(canonicalApptFields({ startTime: "10:00", durationHours: 2, hourlyRate: 30, cost: 55 })).toEqual({
      time: "10:00",
      duration: 2,
      paymentStatus: "pending",
      cost: 55,
    });
    expect(canonicalApptFields({ startTime: "10:00" })).toEqual({
      time: "10:00",
      duration: 1,
      paymentStatus: "pending",
    });
  });

  it("emits NO vertical fields — a senior writer spreading it produces a byte-identical doc", () => {
    const fields = canonicalApptFields({ startTime: "09:00", durationHours: 2, hourlyRate: 25 });
    expect(Object.keys(fields).sort()).toEqual(["cost", "duration", "paymentStatus", "time"]);
    expect((fields as Record<string, unknown>).careVertical).toBeUndefined();
    expect((fields as Record<string, unknown>).recipientRef).toBeUndefined();
  });

  it("normalization helpers keep their pre-U7 behavior", () => {
    expect(normalizeAppointmentDate("2026-08-10T09:00:00")).toBe("2026-08-10");
    expect(normalizeAppointmentTime("2:30 PM")).toBe("14:30");
    expect(normalizeAppointmentDuration(undefined, undefined, "09:00", "13:00")).toBe(4);
  });
});

describe("childcareApptFields (additive vertical seam — R33/R46)", () => {
  const VALID = {
    householdId: "hh_1",
    childIds: ["child-a", "child-b"],
    displayLabel: "M. & J.",
    bookingId: "cbook_1",
  };

  it("produces a typed recipient reference + vertical stamp + display label ONLY", () => {
    const fields = childcareApptFields(VALID);
    expect(fields).toEqual({
      careVertical: "child",
      recipientRef: { careVertical: "child", householdId: "hh_1", childIds: ["child-a", "child-b"] },
      recipientLabel: "M. & J.",
      childcareBookingId: "cbook_1",
    });
    // No child-sensitive field can come out of this helper.
    expect(() => assertChildSafeAppointmentDoc(fields as never, "test")).not.toThrow();
  });

  it("fails closed on missing references (a childcare appointment without a recipient ref is invalid — R2)", () => {
    expect(() => childcareApptFields({ ...VALID, householdId: "" })).toThrow();
    expect(() => childcareApptFields({ ...VALID, childIds: [] })).toThrow();
    expect(() => childcareApptFields({ ...VALID, bookingId: "" })).toThrow();
  });

  it("isChildcareVerticalDoc distinguishes childcare docs from senior/legacy docs", () => {
    expect(isChildcareVerticalDoc({ careVertical: "child" })).toBe(true);
    expect(isChildcareVerticalDoc({ careVertical: "senior" })).toBe(false);
    expect(isChildcareVerticalDoc({ seniorName: "Rose" })).toBe(false);
    expect(isChildcareVerticalDoc(null)).toBe(false);
    expect(isChildcareVerticalDoc(undefined)).toBe(false);
  });

  it("assertChildSafeAppointmentDoc rejects EVERY child-sensitive field", () => {
    for (const field of CHILD_SENSITIVE_APPT_FIELDS) {
      const doc = { ...childcareApptFields(VALID), [field]: "x" } as Record<string, unknown>;
      expect(() => assertChildSafeAppointmentDoc(doc, "test"), field).toThrow(field);
    }
  });

  it("a full childcare appointment doc (canonical + childcare fields) is child-safe", () => {
    const doc: Record<string, unknown> = {
      clientId: "family-1",
      caregiverId: "cg-1",
      caregiverName: "Pat Provider",
      date: "2026-08-10",
      startTime: "09:00",
      endTime: "13:00",
      durationHours: 4,
      ...canonicalApptFields({ startTime: "09:00", durationHours: 4, hourlyRate: 28 }),
      ...childcareApptFields(VALID),
      status: "confirmed",
    };
    expect(() => assertChildSafeAppointmentDoc(doc, "test")).not.toThrow();
    expect(doc.seniorName).toBeUndefined();
    expect(doc.billingAuthority).toBeUndefined(); // childcare money is U8
  });
});
