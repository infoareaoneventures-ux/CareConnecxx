import { describe, expect, it } from "vitest";

import {
  parseCareSignal,
  parseWellness,
  describeWellness,
  rollupCareSignals,
  describeSignalRate,
  selectNextAppointment,
  MIN_KNOWN_FOR_RATE,
} from "./careEvidence";

describe("parseCareSignal (R2 — unknown is never negative)", () => {
  it("maps explicit booleans", () => {
    expect(parseCareSignal(true)).toBe("yes");
    expect(parseCareSignal(false)).toBe("no");
  });

  it("maps unambiguous string forms", () => {
    expect(parseCareSignal("true")).toBe("yes");
    expect(parseCareSignal(" YES ")).toBe("yes");
    expect(parseCareSignal("false")).toBe("no");
    expect(parseCareSignal("No")).toBe("no");
  });

  it("maps missing and malformed values to unknown, not no", () => {
    expect(parseCareSignal(undefined)).toBe("unknown");
    expect(parseCareSignal(null)).toBe("unknown");
    expect(parseCareSignal("")).toBe("unknown");
    expect(parseCareSignal("maybe")).toBe("unknown");
    expect(parseCareSignal(0)).toBe("unknown");
    expect(parseCareSignal(1)).toBe("unknown");
    expect(parseCareSignal({})).toBe("unknown");
  });
});

describe("parseWellness / describeWellness (AE1)", () => {
  it("renders explicit negatives as recorded observations", () => {
    const line = describeWellness(parseWellness({
      wellness: { mood: "good", ateWell: false, tookMeds: false },
    }));
    expect(line).toContain("appetite low (recorded)");
    expect(line).toContain("meds missed (recorded)");
    expect(line).toContain("mood good");
  });

  it("renders omitted fields as not recorded — never as concerns or misses", () => {
    const line = describeWellness(parseWellness({ wellness: { mood: "ok" } }));
    expect(line).toContain("appetite not recorded");
    expect(line).toContain("med status not recorded");
    expect(line).not.toMatch(/appetite low|appetite concerns/);
    expect(line).not.toMatch(/meds missed|medications missed/);
  });

  it("handles a missing wellness map entirely", () => {
    const line = describeWellness(parseWellness({}));
    expect(line).toBe("mood not recorded, appetite not recorded, med status not recorded");
  });
});

describe("rollupCareSignals + describeSignalRate (known denominators, R34)", () => {
  const entry = (tookMeds: unknown) => ({ wellness: { tookMeds } });

  it("counts yes/no/unknown separately", () => {
    const r = rollupCareSignals(
      [entry(true), entry(false), entry(undefined), entry("true"), entry("garbage")],
      "tookMeds",
    );
    expect(r).toEqual({ total: 5, yes: 2, no: 1, unknown: 2 });
  });

  it("computes the rate over known observations only, with coverage", () => {
    const r = rollupCareSignals(
      [entry(true), entry(true), entry(false), entry(undefined), entry(undefined)],
      "tookMeds",
    );
    // 2 of 3 known = 67%, NOT 2 of 5 = 40%
    expect(describeSignalRate(r)).toBe(
      "67% of the 3 visits where it was recorded (2 of 5 entries did not record this)",
    );
  });

  it("returns null below the minimum-evidence threshold instead of a fake rate", () => {
    const r = rollupCareSignals([entry(true), entry(undefined), entry(undefined)], "tookMeds");
    expect(r.yes + r.no).toBeLessThan(MIN_KNOWN_FOR_RATE);
    expect(describeSignalRate(r)).toBeNull();
  });

  it("returns null when every entry is unknown (zero known denominator)", () => {
    const r = rollupCareSignals([entry(undefined), entry(null), entry("")], "tookMeds");
    expect(describeSignalRate(r)).toBeNull();
  });

  it("omits the coverage clause when every entry recorded the field", () => {
    const r = rollupCareSignals([entry(true), entry(true), entry(false)], "tookMeds");
    expect(describeSignalRate(r)).toBe("67% of the 3 visits where it was recorded");
  });
});

describe("selectNextAppointment (AE3 — future-safe)", () => {
  // 2026-07-21T19:00:00Z = 2026-07-21 12:00 PT (business tz). Fixed clock.
  const now = new Date("2026-07-21T19:00:00Z");
  const appt = (date: string, startTime: string | undefined, status = "confirmed", id = `${date}T${startTime ?? "?"}`) =>
    ({ id, date, startTime, status } as Record<string, unknown>);

  it("never selects a prior-day appointment regardless of input order", () => {
    const picked = selectNextAppointment(
      [appt("2026-07-25", "09:00"), appt("2026-07-20", "09:00"), appt("2026-07-19", "10:00")],
      { now },
    );
    expect(picked?.date).toBe("2026-07-25");
  });

  it("excludes a same-day visit whose start already passed, keeps the later one", () => {
    const picked = selectNextAppointment(
      [appt("2026-07-21", "9:00 AM"), appt("2026-07-21", "4:00 PM")],
      { now },
    );
    expect(picked?.startTime).toBe("4:00 PM");
  });

  it("returns null when only past-start candidates exist (query failure ≠ no appointment is the caller's contract)", () => {
    expect(selectNextAppointment([appt("2026-07-21", "08:00"), appt("2026-07-10", "08:00")], { now }))
      .toBeNull();
  });

  it("picks the EARLIEST future start, not the farthest (desc-input regression)", () => {
    const picked = selectNextAppointment(
      [appt("2026-07-30", "09:00"), appt("2026-07-23", "09:00"), appt("2026-07-28", "09:00")],
      { now },
    );
    expect(picked?.date).toBe("2026-07-23");
  });

  it("ignores non-active statuses", () => {
    const picked = selectNextAppointment(
      [appt("2026-07-23", "09:00", "cancelled"), appt("2026-07-24", "09:00", "completed")],
      { now },
    );
    expect(picked).toBeNull();
  });

  it("keeps a future-date appointment whose time field is unparseable", () => {
    const picked = selectNextAppointment([appt("2026-07-24", undefined)], { now });
    expect(picked?.date).toBe("2026-07-24");
  });

  it("keeps a same-day appointment with unparseable time (cannot prove it passed)", () => {
    const picked = selectNextAppointment([appt("2026-07-21", "afternoonish")], { now });
    expect(picked?.date).toBe("2026-07-21");
  });

  it("falls back to isoDate when date is absent", () => {
    const picked = selectNextAppointment(
      [{ isoDate: "2026-07-24T16:00:00.000Z", status: "confirmed" }],
      { now },
    );
    expect(picked?.isoDate).toBe("2026-07-24T16:00:00.000Z");
  });

  it("timezone boundary: UTC is already tomorrow but the business day still has a visit", () => {
    // 2026-07-22T04:30:00Z = 2026-07-21 21:30 PT — a 10 PM PT visit today is still upcoming.
    const eveningNow = new Date("2026-07-22T04:30:00Z");
    const picked = selectNextAppointment([appt("2026-07-21", "10:00 PM")], { now: eveningNow });
    expect(picked?.date).toBe("2026-07-21");
  });

  it("returns null on empty input", () => {
    expect(selectNextAppointment([], { now })).toBeNull();
  });
});
