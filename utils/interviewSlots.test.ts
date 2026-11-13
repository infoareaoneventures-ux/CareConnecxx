import { describe, it, expect } from 'vitest';
import { interviewSlotsFor, ALL_INTERVIEW_SLOTS } from './interviewSlots';

// 2026-11-10 is a Tuesday.
describe('interviewSlotsFor — times from the care provider\'s availability', () => {
  it('no availability set: the full 9:00–6:00 day, unfiltered', () => {
    expect(interviewSlotsFor('2026-11-10', null)).toEqual({ slots: ALL_INTERVIEW_SLOTS, filtered: false, availableThatDay: true });
    expect(interviewSlotsFor('2026-11-10', {})).toMatchObject({ filtered: false });
    expect(interviewSlotsFor('2026-11-10', { monday: [] })).toMatchObject({ filtered: false });
  });
  it('morning-only on Tuesday offers only morning times', () => {
    const r = interviewSlotsFor('2026-11-10', { tuesday: ['morning'] });
    expect(r.filtered).toBe(true);
    expect(r.slots[0]).toBe('09:00');
    expect(r.slots.at(-1)).toBe('11:30');
  });
  it('afternoon-only offers 12:00 to 5:30', () => {
    const r = interviewSlotsFor('2026-11-10', { tuesday: ['afternoon'] });
    expect(r.slots[0]).toBe('12:00');
    expect(r.slots.at(-1)).toBe('17:30');
  });
  it('a day the care provider does not work has no times and says so', () => {
    const r = interviewSlotsFor('2026-11-11', { tuesday: ['morning', 'afternoon'] }); // Wednesday
    expect(r).toEqual({ slots: [], filtered: true, availableThatDay: false });
  });
  it('no date picked yet: the full list', () => {
    expect(interviewSlotsFor('', { tuesday: ['morning'] }).slots).toEqual(ALL_INTERVIEW_SLOTS);
  });
});
