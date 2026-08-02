// Incident-classifier coverage (2026-07-25 hardening pass).
//
// Two halves, and the SECOND matters as much as the first: a classifier that
// pages an operator on "I'm missing her school forms" gets muted, and a muted
// classifier is worse than a narrow one. So every widened pattern is paired with
// the routine phrasings it must stay silent on.

import { describe, it, expect } from "vitest";
import { classifyChildcareIncidentSignal } from "./incidentSignal";

const cat = (t: string) => classifyChildcareIncidentSignal(t).category;
const fires = (t: string) => classifyChildcareIncidentSignal(t).incident;

describe("medical / life-safety escalates as danger (noun-free)", () => {
  const cases: Array<[string, string]> = [
    ["I had to call 911", "911"],
    ["the ambulance is here", "ambulance"],
    ["she's unresponsive", "unresponsive"],
    ["he stopped breathing", "not breathing"],
    ["I think she's having a seizure", "seizure"],
    ["allergic reaction, where's the epipen", "anaphylaxis"],
    ["he was face down in the pool", "drowning"],
    ["she swallowed a battery", "poisoning"],
    ["the sitter left him in the car", "locked in car"],
    ["she hit her head hard", "head injury"],
  ];
  for (const [text, label] of cases) {
    it(`"${text}" → danger (${label})`, () => {
      expect(cat(text)).toBe("danger");
    });
  }
});

describe("pronoun-only reports escalate (the old false-negative class)", () => {
  it("'she fell down the stairs' → injury", () => expect(cat("she fell down the stairs")).toBe("injury"));
  it("'he is bleeding' → injury", () => expect(cat("he is bleeding")).toBe("injury"));
  it("'I can't find her' → missing_child", () => expect(cat("I can't find her")).toBe("missing_child"));
  it("'she ran away' → missing_child", () => expect(cat("she ran away")).toBe("missing_child"));
  it("'they wandered off at the park' → missing_child", () => expect(cat("they wandered off at the park")).toBe("missing_child"));
  it("'I don't know where he is' → missing_child", () => expect(cat("I don't know where he is")).toBe("missing_child"));
});

describe("MUST STAY SILENT on routine childcare messages", () => {
  const quiet = [
    "I'm missing her school forms, can you resend them",
    "she took off her shoes before nap",
    "they got out of the car and went inside",
    "he fell asleep around 8",
    "can you update my emergency contact details",
    "what days is she available next week",
    "her rate is $28 an hour right",
    "the kids had a great day with her",
    "I need a sitter for Tuesday",
    "she found her jacket",
  ];
  for (const text of quiet) {
    it(`silent: "${text}"`, () => {
      expect(fires(text)).toBe(false);
    });
  }
});

describe("severity ordering", () => {
  it("an ambulance report outranks a plain injury classification", () => {
    expect(cat("she fell down the stairs and the ambulance is coming")).toBe("danger");
  });
  it("empty and whitespace never fire", () => {
    expect(fires("")).toBe(false);
    expect(fires("   ")).toBe(false);
  });
});
