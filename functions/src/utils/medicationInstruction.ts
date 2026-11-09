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
// Medicine NAMES count as medication words (2026-11-09, Wave 1): "Give her 2 Tylenol at 8pm" used to
// pass because only the general words (pill, dose, medication…) were listed. The list is the common
// drugs for older adults, brand and generic; it is not exhaustive, so a name missing here still passes —
// extend it when one is found. Deterministic on purpose (a safety gate, like the crisis fast-path): fast,
// free, and a false block only costs the family a rephrase. Kept byte-identical
// on both sides by a parity test (functions/src/utils/__tests__/medicationInstruction.test.ts).

export const MEDICATION_WORDS = "med|meds|medication|medications|medicine|medicines|pill|pills|tablet|tablets|capsule|capsules|prescription|prescriptions|dose|doses|dosage|mg|mcg|ml|insulin|injection|injections|inhaler|tylenol|acetaminophen|paracetamol|ibuprofen|advil|motrin|aspirin|aleve|naproxen|metformin|lisinopril|atorvastatin|lipitor|simvastatin|rosuvastatin|crestor|amlodipine|metoprolol|carvedilol|losartan|hydrochlorothiazide|lasix|furosemide|digoxin|warfarin|coumadin|eliquis|xarelto|plavix|omeprazole|pantoprazole|prilosec|nexium|famotidine|pepcid|levothyroxine|synthroid|gabapentin|neurontin|sertraline|zoloft|fluoxetine|prozac|citalopram|escitalopram|lexapro|trazodone|melatonin|benadryl|diphenhydramine|zyrtec|claritin|xanax|alprazolam|ativan|lorazepam|valium|diazepam|klonopin|clonazepam|oxycodone|hydrocodone|morphine|tramadol|percocet|vicodin|prednisone|donepezil|aricept|memantine|namenda|seroquel|quetiapine|risperdal|risperidone|haloperidol|haldol|lantus|humalog|novologglycerin|tamsulosin|flomax|amoxicillin|azithromycin|cipro|antibiotic|antibiotics|painkiller|painkillers|blood thinner|blood thinners|eye drops|ear drops";
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
