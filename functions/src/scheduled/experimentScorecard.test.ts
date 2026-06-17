import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => ({ __esModule: true, default: { firestore: () => ({ collection: () => ({}) }) }, firestore: () => ({ collection: () => ({}) }) }));

import { buildExperimentScorecard, MIN_SAMPLE, type TurnRecord } from "./experimentScorecard";

function rec(variant: string, opts: { errored?: boolean; empty?: boolean; dur?: number } = {}): TurnRecord {
  return { experiments: { voice_anti_exemplars: variant }, errored: opts.errored, replyEmpty: opts.empty, durationMs: opts.dur ?? 1000 };
}

describe("buildExperimentScorecard", () => {
  it("aggregates per-variant turn counts and rates", () => {
    const records = [
      rec("control", { errored: true }),
      rec("control"),
      rec("treatment"),
      rec("treatment", { empty: true }),
    ];
    const [card] = buildExperimentScorecard(records);
    expect(card.experimentKey).toBe("voice_anti_exemplars");
    const control = card.variants.find((v) => v.variant === "control")!;
    const treatment = card.variants.find((v) => v.variant === "treatment")!;
    expect(control.turns).toBe(2);
    expect(control.errorRate).toBe(0.5);
    expect(treatment.emptyRate).toBe(0.5);
  });

  it("does not graduate a treatment below the minimum sample", () => {
    const records = [rec("control"), rec("treatment")];
    expect(buildExperimentScorecard(records)[0].readyToGraduate).toBeNull();
  });

  it("graduates a high-sample treatment that beats control on error+empty rates", () => {
    const records: TurnRecord[] = [];
    for (let i = 0; i < MIN_SAMPLE; i++) records.push(rec("control", { errored: i % 5 === 0 }));
    for (let i = 0; i < MIN_SAMPLE; i++) records.push(rec("treatment")); // clean
    expect(buildExperimentScorecard(records)[0].readyToGraduate).toBe("treatment");
  });

  it("does not graduate a treatment that is worse than control", () => {
    const records: TurnRecord[] = [];
    for (let i = 0; i < MIN_SAMPLE; i++) records.push(rec("control"));                 // clean
    for (let i = 0; i < MIN_SAMPLE; i++) records.push(rec("treatment", { errored: true })); // all errored
    expect(buildExperimentScorecard(records)[0].readyToGraduate).toBeNull();
  });

  it("returns nothing for turns with no experiments", () => {
    expect(buildExperimentScorecard([{ experiments: {} }])).toEqual([]);
  });
});
