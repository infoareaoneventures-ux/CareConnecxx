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
} from "./proactiveReflection";

const emptySnap = () => ({
  journal:    [],
  past:       [],
  upcoming:   [],
  billing:    [],
  seniorName: "Mom",
  clientName: "Alice",
});

describe("buildReflectionPrompt", () => {
  it("includes all four section headers even when sections are empty", () => {
    const p = buildReflectionPrompt(emptySnap());
    expect(p).toMatch(/RECENT CARE JOURNAL/);
    expect(p).toMatch(/COMPLETED VISITS/);
    expect(p).toMatch(/UPCOMING VISITS/);
    expect(p).toMatch(/RECENT BILLING EVENTS/);
    expect(p).toMatch(/Alice/);
    expect(p).toMatch(/Mom/);
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
    expect(p).toMatch(/2026-05-27 mood=low/);
    expect(p).toMatch(/appetite low/);
    expect(p).toMatch(/meds taken/);
    expect(p).toMatch(/barely touched breakfast/);
  });

  it("clips journal notes to 120 chars", () => {
    const longNote = "a".repeat(500);
    const p = buildReflectionPrompt({
      ...emptySnap(),
      journal: [{ timestamp: "2026-05-27", wellness: {}, notes: longNote }],
    });
    expect(p).not.toMatch(/a{121}/);
  });

  it("caps journal at 8 entries even if more are present", () => {
    const journal = Array.from({ length: 20 }, (_, i) => ({
      timestamp: `2026-05-${String(i + 1).padStart(2, "0")}`,
      wellness:  {},
      notes:     `entry ${i}`,
    }));
    const p = buildReflectionPrompt({ ...emptySnap(), journal });
    expect(p).toMatch(/entry 0/);
    expect(p).toMatch(/entry 7/);
    expect(p).not.toMatch(/entry 8/);
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
