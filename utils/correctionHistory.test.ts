import { describe, it, expect } from 'vitest';
import { realCorrection } from './correctionHistory';

describe('realCorrection', () => {
  it('ignores the submitted and plain accepted entries, which are not corrections', () => {
    expect(realCorrection('submitted')).toBe(false);
    expect(realCorrection('accepted')).toBe(false);
  });
  it('counts a proposal or counter, and a history with one still shows (its accepted entry follows it)', () => {
    expect(realCorrection('proposed')).toBe(true);
    expect(realCorrection('countered')).toBe(true);
    expect([{ action: 'submitted' }, { action: 'proposed' }, { action: 'accepted' }].some((e) => realCorrection(e.action))).toBe(true);
    expect([{ action: 'accepted' }].some((e) => realCorrection(e.action))).toBe(false);
  });
});
