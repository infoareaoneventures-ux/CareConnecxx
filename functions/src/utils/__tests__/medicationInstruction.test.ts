import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { isMedicationInstruction, MEDICATION_INSTRUCTION_MESSAGE, MEDICATION_WORDS, DIRECTIVE_VERBS } from "../medicationInstruction";

const BLOCKED = [
  "Give her two of the blue pills at 8",
  "please give him his medication after breakfast",
  "Skip her insulin if she won't eat",
  "stop the water pill on weekends",
  "2 pills with breakfast and 1 at bedtime",
  "10 mg in the morning",
  "Her medication — please give it at 8",
  "double the dose on bad days",
];
const ALLOWED = [
  "She takes medication morning and evening",
  "needs medication reminders at 8am and 8pm",
  "She has dementia and gets confused in the evening",
  "Likes her tea at 3 and a walk after lunch",
  "Pharmacy visits on Tuesdays",
  "",
];

describe("isMedicationInstruction", () => {
  it.each(BLOCKED)("blocks: %s", (t) => { expect(isMedicationInstruction(t)).toBe(true); });
  it.each(ALLOWED)("allows: %s", (t) => { expect(isMedicationInstruction(t)).toBe(false); });
  it("non-strings never block", () => { expect(isMedicationInstruction(undefined)).toBe(false); expect(isMedicationInstruction(42)).toBe(false); });
});

describe("the site copy is the same rule (byte parity)", () => {
  const site = fs.readFileSync(path.resolve(__dirname, "../../../../utils/medicationInstruction.ts"), "utf8");
  const lit = (name: string) => { const m = site.match(new RegExp("export const " + name + " = ([\"'])(.*)\\1;")); if (!m) throw new Error(name + " missing on the site"); return m[2]; };
  it("words, verbs and the one line match", () => {
    expect(lit("MEDICATION_WORDS")).toBe(MEDICATION_WORDS);
    expect(lit("DIRECTIVE_VERBS")).toBe(DIRECTIVE_VERBS);
    expect(lit("MEDICATION_INSTRUCTION_MESSAGE")).toBe(MEDICATION_INSTRUCTION_MESSAGE);
  });
});
