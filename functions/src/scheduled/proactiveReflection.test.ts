import { describe, it, expect, vi } from "vitest";

// Importing proactiveReflection touches admin.firestore() at module load.
// Stub so the suite can load — the tests below only exercise pure helpers.
vi.mock("firebase-admin", () => {
  const stubFs = () => ({
    collection: () => ({
      doc:   () => ({ get: async () => ({ exists: false, data: () => null }) }),
      where: () => ({
        where:   () => ({
          orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [], empty: true }) }) }),
          limit:   () => ({ get: async () => ({ docs: [], empty: true }) }),
        }),
        orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [], empty: true }) }) }),
        limit:   () => ({ get: async () => ({ docs: [], empty: true }) }),
      }),
      add: async () => ({}),
    }),
  });
  return {
    __esModule: true,
    default:   { firestore: stubFs },
    firestore: stubFs,
  };
});

// firebase-functions also touches stuff at top-level for the schedule() call.
vi.mock("firebase-functions", () => ({
  __esModule: true,
  default:   {},
  pubsub:    { schedule: () => ({ timeZone: () => ({ onRun: (fn: unknown) => fn }) }) },
  https:     { onCall: (fn: unknown) => fn, HttpsError: class {} },
}));

import {
  buildReflectionPrompt,
  parseReflectionOutput,
  hashContext,
  JOURNAL_LOOKBACK_HOURS,
} from "./proactiveReflection";

const emptySnap = () => ({
  journal:    [],
  past:       [],
  upcoming:   [],
  billing:    [],
  billingUnavailable: false,
  seniorName: "Mom",
  clientName: "Alice",
});

describe("buildReflectionPrompt", () => {
  it("includes all four section headers even when sections are empty", () => {
    const p = buildReflectionPrompt(emptySnap());
    expect(p).toMatch(/RECENT CARE JOURNAL/);
    expect(p).toMatch(/COMPLETED VISITS/);
    expect(p).toMatch(/UPCOMING VISITS/);
    expect(p).toMatch(/RECENT BILLING/);
    expect(p).toMatch(/Alice/);
    expect(p).toMatch(/Mom/);
  });

  it("renders canonical billing signals as source/status/date only — no amounts (R8/KTD9)", () => {
    const p = buildReflectionPrompt({
      ...emptySnap(),
      billing: [
        { source: "invoice", status: "pending", date: "2026-05-27" },
        { source: "payment", status: "succeeded", date: "2026-05-26" },
      ],
    });
    expect(p).toMatch(/2026-05-27 invoice pending/);
    expect(p).toMatch(/2026-05-26 payment succeeded/);
    // Never leak amounts or currency into the model prompt.
    expect(p).not.toMatch(/\$/);
  });

  it("distinguishes billing-unavailable from a true-empty billing set", () => {
    const empty = buildReflectionPrompt(emptySnap());
    expect(empty).toMatch(/RECENT BILLING[^\n]*\n\s*\(none\)/);
    const unavailable = buildReflectionPrompt({ ...emptySnap(), billingUnavailable: true });
    expect(unavailable).toMatch(/billing data unavailable/);
  });

  it("renders journal entries with mood/ate/meds + notes", () => {
    const p = buildReflectionPrompt({
      ...emptySnap(),
      journal: [
        {
          timestamp: "2026-05-27T08:00:00Z",
          wellness:  { mood: "low", ateWell: false, tookMeds: true },
          notes:     "barely touched breakfast again",
        },
      ],
    });
    expect(p).toMatch(/2026-05-27 mood low/);
    expect(p).toMatch(/appetite low \(recorded\)/);
    expect(p).toMatch(/meds taken/);
    expect(p).toMatch(/barely touched breakfast/);
  });

  it("renders omitted wellness fields as not recorded — never as negatives (U1/AE1)", () => {
    const p = buildReflectionPrompt({
      ...emptySnap(),
      journal: [{ timestamp: "2026-05-27T08:00:00Z", wellness: { mood: "good" } }],
    });
    expect(p).toMatch(/appetite not recorded/);
    expect(p).toMatch(/med status not recorded/);
    expect(p).not.toMatch(/appetite low/);
    expect(p).not.toMatch(/meds missed/);
  });

  it("claims a journal window that matches the loaded window (U1/AE2)", () => {
    const p = buildReflectionPrompt(emptySnap());
    expect(JOURNAL_LOOKBACK_HOURS).toBe(72);
    expect(p).toMatch(/RECENT CARE JOURNAL \(last 3 days\)/);
    expect(p).toMatch(/COMPLETED VISITS \(last 24h\)/);
    expect(p).not.toMatch(/JOURNAL \(last 24h\)/);
  });

  it("clips journal notes to 120 chars", () => {
    const longNote = "a".repeat(500);
    const p = buildReflectionPrompt({
      ...emptySnap(),
      journal: [{ timestamp: "2026-05-27", wellness: {}, notes: longNote }],
    });
    expect(p).not.toMatch(/a{121}/);
  });

  it("caps journal at 12 entries even if more are present", () => {
    const journal = Array.from({ length: 20 }, (_, i) => ({
      timestamp: `2026-05-${String(i + 1).padStart(2, "0")}`,
      wellness:  {},
      notes:     `entry ${i}`,
    }));
    const p = buildReflectionPrompt({ ...emptySnap(), journal });
    expect(p).toMatch(/entry 0\b/);
    expect(p).toMatch(/entry 11\b/);
    expect(p).not.toMatch(/entry 12\b/);
  });
});

describe("parseReflectionOutput", () => {
  it("parses a noop response", () => {
    expect(parseReflectionOutput('{"action":"noop"}')).toEqual({ action: "noop" });
  });

  it("parses a well-formed draft", () => {
    const raw = JSON.stringify({
      action:   "draft",
      draftText: "Hey — Marco's noted Mom barely touched breakfast 3 mornings in a row. Want me to mention it to Dr. Patel?",
      reason:   "3 consecutive days of low appetite in journal",
      severity: "medium",
    });
    const out = parseReflectionOutput(raw);
    expect(out).toEqual({
      action:    "draft",
      draftText: "Hey — Marco's noted Mom barely touched breakfast 3 mornings in a row. Want me to mention it to Dr. Patel?",
      reason:    "3 consecutive days of low appetite in journal",
      severity:  "medium",
    });
  });

  it("strips markdown code fences gpt-4o-mini sometimes adds", () => {
    const raw = '```json\n{"action":"draft","draftText":"hi","reason":"r","severity":"low"}\n```';
    const out = parseReflectionOutput(raw);
    expect(out?.action).toBe("draft");
    expect(out?.draftText).toBe("hi");
  });

  it("defaults severity to medium when missing/invalid", () => {
    const raw = JSON.stringify({
      action: "draft", draftText: "x", reason: "y", severity: "potato",
    });
    expect(parseReflectionOutput(raw)?.severity).toBe("medium");
  });

  it("returns null on missing required fields", () => {
    expect(parseReflectionOutput('{"action":"draft","reason":"r"}')).toBeNull();
    expect(parseReflectionOutput('{"action":"draft","draftText":""}')).toBeNull();
  });

  it("returns null on overlong draft (SMS-shaped only)", () => {
    const text = "x".repeat(500);
    const raw = JSON.stringify({ action: "draft", draftText: text, reason: "r", severity: "low" });
    expect(parseReflectionOutput(raw)).toBeNull();
  });

  it("returns null on unknown action", () => {
    expect(parseReflectionOutput('{"action":"yolo"}')).toBeNull();
  });

  it("returns null on non-JSON garbage", () => {
    expect(parseReflectionOutput("here is what I think")).toBeNull();
    expect(parseReflectionOutput("")).toBeNull();
  });
});

describe("hashContext", () => {
  it("is stable for the same input", () => {
    const a = hashContext("hello world");
    const b = hashContext("hello world");
    expect(a).toBe(b);
  });

  it("differs for different inputs", () => {
    expect(hashContext("a")).not.toBe(hashContext("b"));
  });

  it("returns a string of hex chars", () => {
    expect(hashContext("anything at all")).toMatch(/^[0-9a-f]+$/);
  });
});
