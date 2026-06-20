import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

// Weekly experiment scorecard. Cara's prompt experiments (experimentRegistry.ts)
// emit per-turn outcomes, but graduation was a manual log-slice + code edit, so
// the improvement loop silently stalled. This job aggregates the bounded
// per-variant turn mirror (cara_turn_metrics) into a per-experiment scorecard so
// "is this variant winning?" is answered automatically each week.

const db = admin.firestore();

export interface TurnRecord {
  experiments: Record<string, string>; // experimentKey → variant
  errored?:    boolean;
  replyEmpty?: boolean;
  durationMs?: number;
}

export interface VariantStats {
  variant:        string;
  turns:          number;
  errorRate:      number;
  emptyRate:      number;
  avgDurationMs:  number;
}

export interface ExperimentScorecard {
  experimentKey:   string;
  variants:        VariantStats[];
  readyToGraduate: string | null; // a treatment variant clearing the gate, or null
}

// A treatment variant needs at least this many turns before we trust its rates.
export const MIN_SAMPLE = 30;

export function buildExperimentScorecard(records: TurnRecord[]): ExperimentScorecard[] {
  // experimentKey → variant → accumulator
  const acc = new Map<string, Map<string, { turns: number; errors: number; empties: number; durSum: number }>>();
  for (const r of records) {
    for (const [key, variant] of Object.entries(r.experiments ?? {})) {
      if (!acc.has(key)) acc.set(key, new Map());
      const byVariant = acc.get(key)!;
      const cur = byVariant.get(variant) ?? { turns: 0, errors: 0, empties: 0, durSum: 0 };
      cur.turns   += 1;
      cur.errors  += r.errored ? 1 : 0;
      cur.empties += r.replyEmpty ? 1 : 0;
      cur.durSum  += typeof r.durationMs === "number" ? r.durationMs : 0;
      byVariant.set(variant, cur);
    }
  }

  const out: ExperimentScorecard[] = [];
  for (const [experimentKey, byVariant] of acc) {
    const variants: VariantStats[] = [...byVariant.entries()].map(([variant, s]) => ({
      variant,
      turns:         s.turns,
      errorRate:     s.turns ? s.errors / s.turns : 0,
      emptyRate:     s.turns ? s.empties / s.turns : 0,
      avgDurationMs: s.turns ? Math.round(s.durSum / s.turns) : 0,
    })).sort((a, b) => b.turns - a.turns);

    // Graduation gate: a non-control variant graduates only when a control
    // baseline EXISTS and the treatment has enough sample AND its error and
    // empty rates are no worse than control's. Without a control there is no
    // evidence the treatment is better, so it must not graduate.
    const control = variants.find((v) => v.variant === "control");
    const ready = variants.find((v) =>
      v.variant !== "control" &&
      v.turns >= MIN_SAMPLE &&
      !!control && v.errorRate <= control.errorRate && v.emptyRate <= control.emptyRate,
    );
    out.push({ experimentKey, variants, readyToGraduate: ready?.variant ?? null });
  }
  return out;
}

// Weekly, Monday 9am PT (16:00 UTC).
export const experimentScorecardWeekly = functions.pubsub
  .schedule("0 16 * * 1")
  .onRun(async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const snap = await db.collection("cara_turn_metrics").where("at", ">=", sevenDaysAgo).get();
    const records: TurnRecord[] = snap.docs.map((d) => d.data() as TurnRecord);

    const scorecard = buildExperimentScorecard(records);
    const weekKey = new Date().toISOString().slice(0, 10);
    await db.collection("experiment_scorecards").doc(weekKey).set({
      generatedAt: new Date().toISOString(),
      sampleTurns: records.length,
      scorecard,
    }).catch((err) => console.error("[experimentScorecard] write failed:", err));

    console.info("cara.experiment_scorecard", { weekKey, sampleTurns: records.length, scorecard });
    for (const s of scorecard) {
      if (s.readyToGraduate) {
        console.info("cara.experiment_ready", { experimentKey: s.experimentKey, variant: s.readyToGraduate });
      }
    }
  });
