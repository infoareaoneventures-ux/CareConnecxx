import { describe, it, expect } from "vitest";
import { resolveLoopBudget, MAX_TOOL_CALLS_PER_TURN } from "./loopBudget";

describe("resolveLoopBudget (U5)", () => {
  it("gives multi-step real-world flows extra headroom", () => {
    for (const intent of ["BOOK_DOCTOR_APPOINTMENT", "PRESCRIPTION_REFILL", "NEW_PRESCRIPTION", "FIND_NEARBY_PROVIDER"] as const) {
      const b = resolveLoopBudget(intent);
      expect(b.flowClass).toBe("multistep");
      expect(b.maxIterations).toBe(10);
    }
  });

  it("caps cheap read-only lookups low", () => {
    for (const intent of ["MEMORY_QUERY", "VIEW_MY_JOBS", "VIEW_APPLICANTS", "VIEW_JOURNAL", "VIEW_EARNINGS", "VIEW_INVOICE", "VIEW_CARE_PLAN_HISTORY"] as const) {
      const b = resolveLoopBudget(intent);
      expect(b.flowClass).toBe("quick");
      expect(b.maxIterations).toBe(3);
    }
  });

  it("defaults to standard (5) for ordinary intents", () => {
    const b = resolveLoopBudget("CANCEL_REQUEST");
    expect(b.flowClass).toBe("standard");
    expect(b.maxIterations).toBe(5);
  });

  it("defaults to standard for a null/undefined intent (web/agent caller)", () => {
    expect(resolveLoopBudget(null).maxIterations).toBe(5);
    expect(resolveLoopBudget(undefined).flowClass).toBe("standard");
  });

  it("bounds mutation blast radius above any legitimate flow's tool count", () => {
    expect(MAX_TOOL_CALLS_PER_TURN).toBeGreaterThanOrEqual(10);
  });
});
