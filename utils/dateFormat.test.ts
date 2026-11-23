import { describe, it, expect } from 'vitest';
import { formatDay } from './dateFormat';

describe('formatDay', () => {
  it('shows a plain date as that calendar day', () => {
    expect(formatDay('2026-11-23')).toBe('Nov 23, 2026');
    expect(formatDay('2026-12-05', { withYear: false })).toBe('Dec 5');
  });
  it('accepts a Date', () => {
    expect(formatDay(new Date(2026, 10, 23, 9))).toBe('Nov 23, 2026');
  });
  it('leaves labels and unreadable values alone, and blanks empties', () => {
    expect(formatDay('Tomorrow')).toBe('Tomorrow');
    expect(formatDay('sometime soon')).toBe('sometime soon');
    expect(formatDay(undefined)).toBe('');
    expect(formatDay('')).toBe('');
  });
});
