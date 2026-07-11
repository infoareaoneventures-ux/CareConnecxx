import { describe, it, expect } from "vitest";
import {
  decideArrivalCapture,
  ARRIVAL_PING_AFTER_MIN,
  NO_SHOW_AFTER_PING_MIN,
} from "../noShowPolicy";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

describe("decideArrivalCapture", () => {
  it("waits inside the arrival grace window", () => {
    const d = decideArrivalCapture({
      startMs: NOW - (ARRIVAL_PING_AFTER_MIN - 2) * MIN,
      arrived: false,
      arrivalPingSentAtMs: null,
      lastInboundAtMs: null,
      canPing: true,
      nowMs: NOW,
    });
    expect(d).toEqual({ action: "wait" });
  });

  it("sends the capture ping once past the grace window with no arrival", () => {
    const d = decideArrivalCapture({
      startMs: NOW - (ARRIVAL_PING_AFTER_MIN + 1) * MIN,
      arrived: false,
      arrivalPingSentAtMs: null,
      lastInboundAtMs: null,
      canPing: true,
      nowMs: NOW,
    });
    expect(d).toEqual({ action: "ping" });
  });

  it("never touches a visit where the caregiver has checked in", () => {
    const d = decideArrivalCapture({
      startMs: NOW - 60 * MIN,
      arrived: true,
      arrivalPingSentAtMs: NOW - 40 * MIN,
      lastInboundAtMs: null,
      canPing: true,
      nowMs: NOW,
    });
    expect(d).toEqual({ action: "skip", reason: "arrived" });
  });

  it("keeps waiting while the ping is still within its grace window", () => {
    const d = decideArrivalCapture({
      startMs: NOW - 25 * MIN,
      arrived: false,
      arrivalPingSentAtMs: NOW - (NO_SHOW_AFTER_PING_MIN - 2) * MIN,
      lastInboundAtMs: null,
      canPing: true,
      nowMs: NOW,
    });
    expect(d).toEqual({ action: "wait" });
  });

  it("escalates to replacement only after the ping goes unanswered long enough", () => {
    const d = decideArrivalCapture({
      startMs: NOW - 40 * MIN,
      arrived: false,
      arrivalPingSentAtMs: NOW - (NO_SHOW_AFTER_PING_MIN + 1) * MIN,
      lastInboundAtMs: null,
      canPing: true,
      nowMs: NOW,
    });
    expect(d).toEqual({ action: "replace" });
  });

  it("holds off replacement if the caregiver replied after the ping (engaged, not a no-show)", () => {
    const pingAt = NOW - (NO_SHOW_AFTER_PING_MIN + 5) * MIN;
    const d = decideArrivalCapture({
      startMs: NOW - 45 * MIN,
      arrived: false,
      arrivalPingSentAtMs: pingAt,
      lastInboundAtMs: pingAt + 2 * MIN, // texted back after the ping
      canPing: true,
      nowMs: NOW,
    });
    expect(d).toEqual({ action: "wait" });
  });

  // Unreachable caregiver (no phone on file): the ping step is impossible, but a
  // true no-show must still escalate — never stay stuck at "ping" forever.
  it("without a pingable phone, waits until the combined ping+wait budget elapses", () => {
    const d = decideArrivalCapture({
      startMs: NOW - (ARRIVAL_PING_AFTER_MIN + NO_SHOW_AFTER_PING_MIN - 2) * MIN,
      arrived: false,
      arrivalPingSentAtMs: null,
      lastInboundAtMs: null,
      canPing: false,
      nowMs: NOW,
    });
    expect(d).toEqual({ action: "wait" });
  });

  it("without a pingable phone, replaces once the combined budget has elapsed", () => {
    const d = decideArrivalCapture({
      startMs: NOW - (ARRIVAL_PING_AFTER_MIN + NO_SHOW_AFTER_PING_MIN + 1) * MIN,
      arrived: false,
      arrivalPingSentAtMs: null,
      lastInboundAtMs: null,
      canPing: false,
      nowMs: NOW,
    });
    expect(d).toEqual({ action: "replace" });
  });
});
