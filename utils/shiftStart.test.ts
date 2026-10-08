import { describe, it, expect } from 'vitest';
import { otherVisitInProgress, finishFirstText, FINISH_FIRST_LABEL } from './shiftStart';

// One visit at a time (2026-10-07): Start Shift is refused while another visit is in progress.
describe('otherVisitInProgress', () => {
  const visits = [
    { id: 'a', status: 'in-progress', clientName: 'Basra Yousuf' },
    { id: 'b', status: 'scheduled', clientName: 'Ali' },
  ];
  it('names the other in-progress visit', () => {
    expect(otherVisitInProgress(visits, 'b')?.id).toBe('a');
  });
  it('the in-progress visit itself is not "another" one (Start on it shows "already started", not this)', () => {
    expect(otherVisitInProgress(visits, 'a')).toBeNull();
  });
  it('nothing in progress → null', () => {
    expect(otherVisitInProgress([{ id: 'b', status: 'scheduled' }], 'c')).toBeNull();
  });
  it('text names the family when known', () => {
    expect(finishFirstText({ clientName: 'Basra Yousuf' })).toBe('Finish your visit with Basra Yousuf first.');
    expect(finishFirstText(null)).toBe('Finish your current visit first.');
    expect(FINISH_FIRST_LABEL).toBe('Finish your current visit first');
  });
});
