import { describe, it, expect } from 'vitest';
import { safeErrorMessage } from '../utils/safeErrorMessage';

describe('safeErrorMessage — what a person may see when something fails (2026-10-19)', () => {
  const FALLBACK = 'We could not save your post. Please try again.';

  it('replaces the live Firestore message (with the record path) by the fallback', () => {
    const live = new Error('Function DocumentReference.set() called with invalid data. FieldValue.delete() cannot be used with set() unless you pass {merge:true} (found in field draftStep in document job_postings/pdUaK6NyPUXolJTGMDywEoCJW2I3)');
    expect(safeErrorMessage(live, FALLBACK)).toBe(FALLBACK);
  });

  it('replaces permission / storage / internal shapes', () => {
    expect(safeErrorMessage(new Error('Missing or insufficient permissions.'), FALLBACK)).toBe(FALLBACK);
    expect(safeErrorMessage(new Error('Firebase Storage: User does not have permission (storage/unauthorized)'), FALLBACK)).toBe(FALLBACK);
    expect(safeErrorMessage(new Error('INTERNAL'), FALLBACK)).toBe(FALLBACK);
    expect(safeErrorMessage(undefined, FALLBACK)).toBe(FALLBACK);
    expect(safeErrorMessage(new Error(''), FALLBACK)).toBe(FALLBACK);
  });

  it("passes a message written for the person through unchanged", () => {
    expect(safeErrorMessage(new Error("You've already applied to this job."), FALLBACK)).toBe("You've already applied to this job.");
    expect(safeErrorMessage('Please select a date first.', FALLBACK)).toBe('Please select a date first.');
  });
});
