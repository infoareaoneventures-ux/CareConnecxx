// Medication instructions never reach a caregiver through a family's free text.
//
// Founder, 2026-10-04: the job description is readable by every signed-in
// account and the Care Plan / booking notes travel to the booked caregiver, and
// caregivers here REMIND about medication, they never give it. So an instruction
// to give, skip, stop or change a medication or dose — or a dose amount — is
// refused at every save, on the site and over text, with the same one line.
// A stated fact ("she takes medication morning and evening", "needs medication
// reminders at 8") passes: it carries no instruction.
//
// Deterministic on purpose (a safety gate, like the crisis fast-path): fast,
// free, and a false block only costs the family a rephrase. Kept byte-identical
// on both sides by a parity test (functions/src/utils/__tests__/medicationInstruction.test.ts).

export const MEDICATION_WORDS = "med|meds|medication|medications|medicine|medicines|pill|pills|tablet|tablets|capsule|capsules|prescription|prescriptions|dose|doses|dosage|mg|mcg|ml|insulin|injection|injections|inhaler";
export const DIRECTIVE_VERBS = "give|gives|giving|gave|administer|administers|administering|start|starts|stop|stops|skip|skips|double|increase|decrease|change|adjust|crush|inject|hold|withhold";
export const MEDICATION_INSTRUCTION_MESSAGE = "Evia is for non-medical care, so medication instructions can't be saved here. Medication reminders only.";

const MED           = new RegExp(`\\b(${MEDICATION_WORDS})\\b`, "i");
const VERB_THEN_MED = new RegExp(`\\b(${DIRECTIVE_VERBS})\\b[^.!?\\n]{0,50}\\b(${MEDICATION_WORDS})\\b`, "i");
const MED_THEN_VERB = new RegExp(`\\b(${MEDICATION_WORDS})\\b[^.!?\\n]{0,30}\\b(${DIRECTIVE_VERBS})\\b`, "i");
const DOSE_AMOUNT   = /\b\d+(\.\d+)?\s*(mg|mcg|ml|units?|pills?|tablets?|capsules?|doses?)\b/i;

/** True when the text directs someone to give, skip, stop or change a medication, or states a dose amount. */
export function isMedicationInstruction(text: unknown): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  if (DOSE_AMOUNT.test(text)) return true;
  if (!MED.test(text)) return false;
  return VERB_THEN_MED.test(text) || MED_THEN_VERB.test(text);
}
