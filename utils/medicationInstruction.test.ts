import { describe, it, expect } from 'vitest';
import { isMedicationInstruction, MEDICATION_INSTRUCTION_MESSAGE } from './medicationInstruction';

const BLOCKED = [
  'Give her two of the blue pills at 8',
  'please give him his medication after breakfast',
  "Skip her insulin if she won't eat",
  'stop the water pill on weekends',
  '2 pills with breakfast and 1 at bedtime',
  '10 mg in the morning',
  'Her medication — please give it at 8',
  'double the dose on bad days',
  'Give her 2 Tylenol at 8pm',
  'give him his Lipitor with dinner',
  'Skip the metformin if she is not eating',
  'stop the Lasix on weekends',
  'Please give grandpa an ibuprofen when his knee hurts',
  'double her Xanax on bad days',
  'Give her a melatonin at bedtime',
  'crush the Aricept into applesauce',
];
const ALLOWED = [
  'She takes medication morning and evening',
  'needs medication reminders at 8am and 8pm',
  'She has dementia and gets confused in the evening',
  'Likes her tea at 3 and a walk after lunch',
  'Pharmacy visits on Tuesdays',
  'She takes Lipitor every day',
  'Her medications are on the kitchen counter',
  'Reminder only: her pillbox beeps at 8',
  'Likes tea and a walk, avoids ibuprofen because of her stomach',
  '',
];

describe('isMedicationInstruction (site copy)', () => {
  it.each(BLOCKED)('blocks: %s', (t) => { expect(isMedicationInstruction(t)).toBe(true); });
  it.each(ALLOWED)('allows: %s', (t) => { expect(isMedicationInstruction(t)).toBe(false); });
  it('one line, no steering', () => {
    expect(MEDICATION_INSTRUCTION_MESSAGE).toContain("Medication reminders only");
    expect(MEDICATION_INSTRUCTION_MESSAGE).not.toMatch(/notes|instead/i);
  });
});
