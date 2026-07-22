// Deterministic care insights over tri-state evidence (plan 2026-07-18-001
// U7, R34-R35, KTD13).
//
// Computes care patterns BEFORE any model sees the data: a pattern exists
// only when explicit recorded negatives span enough distinct days inside the
// window. Missing fields are unknown and can never form or strengthen a
// pattern (R2). Every insight links its source timestamps so a claim is
// reconstructible from evidence (R34). Consumers (proactive candidates,
// digests, trend surfaces) render `statement` verbatim or suppress — the
// model may rephrase warmth, never upgrade severity or invent meaning.

import { parseCareSignal } from "./careEvidence";

export type InsightField = "ateWell" | "tookMeds" | "wasActive";

export type InsightKind =
  | "concern"       // ≥ minNegDays distinct days of explicit negatives in window
  | "stable"        // enough known coverage, negatives below threshold
  | "insufficient"; // not enough recorded evidence to say anything

export interface CareInsight {
  field: InsightField;
  kind: InsightKind;
  windowDays: number;
  /** Distinct calendar days with any KNOWN observation for this field. */
  knownDays: number;
  /** Distinct calendar days with an explicit negative observation. */
  negativeDays: number;
  /** ISO timestamps of the negative source entries (evidence links, R34). */
  negativeSources: string[];
  /** Plain-language, severity-locked statement; empty for insufficient. */
  statement: string;
}

const FIELD_LABEL: Record<InsightField, { neg: string; pos: string }> = {
  ateWell:   { neg: "appetite was recorded low", pos: "appetite" },
  tookMeds:  { neg: "medications were recorded missed", pos: "medications" },
  wasActive: { neg: "activity was recorded low", pos: "activity" },
};

export interface CareInsightOptions {
  windowDays?: number;      // default 7
  minKnownDays?: number;    // default 3 — below this: insufficient (R34)
  minNegativeDays?: number; // default 3 distinct days for a concern (AE11)
  now?: Date;
}

export function deriveCareInsights(
  entries: Array<Record<string, unknown>>,
  opts?: CareInsightOptions,
): CareInsight[] {
  const windowDays = opts?.windowDays ?? 7;
  const minKnownDays = opts?.minKnownDays ?? 3;
  const minNegativeDays = opts?.minNegativeDays ?? 3;
  const now = opts?.now ?? new Date();
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;

  const fields: InsightField[] = ["ateWell", "tookMeds", "wasActive"];
  return fields.map((field) => {
    const knownDays = new Set<string>();
    const negDays = new Set<string>();
    const negativeSources: string[] = [];

    for (const e of entries) {
      const ts = typeof e?.timestamp === "string" ? e.timestamp : "";
      const ms = Date.parse(ts);
      if (!Number.isFinite(ms) || ms < cutoff || ms > now.getTime()) continue;
      const day = ts.slice(0, 10);
      const signal = parseCareSignal((e?.wellness as Record<string, unknown> | undefined)?.[field]);
      if (signal === "unknown") continue; // unknown NEVER contributes (R2)
      knownDays.add(day);
      if (signal === "no") {
        negDays.add(day);
        negativeSources.push(ts);
      }
    }

    if (knownDays.size < minKnownDays) {
      return {
        field, kind: "insufficient" as const, windowDays,
        knownDays: knownDays.size, negativeDays: negDays.size,
        negativeSources, statement: "",
      };
    }
    if (negDays.size >= minNegativeDays) {
      return {
        field, kind: "concern" as const, windowDays,
        knownDays: knownDays.size, negativeDays: negDays.size,
        negativeSources,
        statement: `${FIELD_LABEL[field].neg} on ${negDays.size} of the last ${windowDays} days (${knownDays.size} days had recorded observations).`,
      };
    }
    return {
      field, kind: "stable" as const, windowDays,
      knownDays: knownDays.size, negativeDays: negDays.size,
      negativeSources,
      statement: `${FIELD_LABEL[field].pos} looks steady across ${knownDays.size} recorded days in the last ${windowDays} days.`,
    };
  });
}

/** Only insights strong enough to justify proactive outreach (U8 consumer). */
export function concerningInsights(insights: CareInsight[]): CareInsight[] {
  return insights.filter((i) => i.kind === "concern");
}
