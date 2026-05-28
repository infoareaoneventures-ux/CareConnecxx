import { describe, it, expect } from "vitest";

import { decideRecovery, RECOVERY_THRESHOLD } from "./recoveryDecision";

describe("decideRecovery", () => {
  it("does not fire on the first all-error iteration", () => {
    const out = decideRecovery(
      { consecutiveErrorIterations: 0, alreadyFired: false },
      { toolCalls: 2, toolErrors: 2 },
    );
    expect(out.shouldFire).toBe(false);
    expect(out.consecutiveErrorIterations).toBe(1);
  });

  it("fires on the SECOND consecutive all-error iteration", () => {
    const out = decideRecovery(
      { consecutiveErrorIterations: 1, alreadyFired: false },
      { toolCalls: 2, toolErrors: 2 },
    );
    expect(out.shouldFire).toBe(true);
    expect(out.consecutiveErrorIterations).toBe(2);
  });

  it("does NOT fire when partial success in the second iteration", () => {
    const out = decideRecovery(
      { consecutiveErrorIterations: 1, alreadyFired: false },
      { toolCalls: 3, toolErrors: 2 }, // 1 succeeded
    );
    expect(out.shouldFire).toBe(false);
    expect(out.consecutiveErrorIterations).toBe(0);
  });

  it("does NOT fire twice in the same turn (alreadyFired latch)", () => {
    const out = decideRecovery(
      { consecutiveErrorIterations: 5, alreadyFired: true },
      { toolCalls: 2, toolErrors: 2 },
    );
    expect(out.shouldFire).toBe(false);
    expect(out.consecutiveErrorIterations).toBe(6);
  });

  it("ignores iterations with zero tool calls (counter unchanged)", () => {
    const out = decideRecovery(
      { consecutiveErrorIterations: 1, alreadyFired: false },
      { toolCalls: 0, toolErrors: 0 },
    );
    expect(out.shouldFire).toBe(false);
    expect(out.consecutiveErrorIterations).toBe(1);
  });

  it("resets the counter when a tool succeeds", () => {
    const after1 = decideRecovery(
      { consecutiveErrorIterations: 1, alreadyFired: false },
      { toolCalls: 1, toolErrors: 0 },
    );
    expect(after1.consecutiveErrorIterations).toBe(0);
    const after2 = decideRecovery(
      { consecutiveErrorIterations: after1.consecutiveErrorIterations, alreadyFired: false },
      { toolCalls: 1, toolErrors: 1 },
    );
    expect(after2.shouldFire).toBe(false);
    expect(after2.consecutiveErrorIterations).toBe(1);
  });

  it("RECOVERY_THRESHOLD is 2 (single consecutive error is too jumpy)", () => {
    expect(RECOVERY_THRESHOLD).toBe(2);
  });
});
