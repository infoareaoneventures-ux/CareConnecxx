import { describe, expect, it } from "vitest";

import {
  rankClarifications,
  selectClarification,
  type ClarificationCandidate,
} from "./clarificationPolicy";

const c = (field: string, unlocks: number, risk: ClarificationCandidate["riskIfGuessed"], choices?: string[]): ClarificationCandidate => ({
  field,
  unlocksSteps: Array.from({ length: unlocks }, (_, i) => `s${i}`),
  riskIfGuessed: risk,
  choices,
});

describe("clarificationPolicy (U3/R16/KTD7)", () => {
  it("selects the question that unlocks the most steps", () => {
    const picked = selectClarification([c("newTime", 1, "high"), c("whichSenior", 3, "medium")]);
    expect(picked?.field).toBe("whichSenior");
  });

  it("breaks unlock ties by consequence of guessing", () => {
    const picked = selectClarification([c("preferredName", 2, "low"), c("paymentMethod", 2, "high")]);
    expect(picked?.field).toBe("paymentMethod");
  });

  it("prefers a finite two-way ambiguity over a free-text ask at equal progress/risk", () => {
    const picked = selectClarification([
      c("visitNotes", 1, "medium"),
      c("whichVisit", 1, "medium", ["Tue 9am", "Thu 2pm"]),
    ]);
    expect(picked?.field).toBe("whichVisit");
  });

  it("is deterministic regardless of input order (stable field tie-break)", () => {
    const a = [c("beta", 1, "low"), c("alpha", 1, "low")];
    expect(selectClarification(a)?.field).toBe("alpha");
    expect(selectClarification([...a].reverse())?.field).toBe("alpha");
  });

  it("returns null when nothing is unresolved — no invented questions", () => {
    expect(selectClarification([])).toBeNull();
  });

  it("rankClarifications does not mutate its input", () => {
    const input = [c("b", 1, "low"), c("a", 2, "high")];
    const before = JSON.stringify(input);
    rankClarifications(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
