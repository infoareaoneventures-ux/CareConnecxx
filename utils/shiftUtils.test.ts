import { describe, it, expect, vi, afterEach } from 'vitest';
import { shiftDisplayStatus } from './shiftUtils';

afterEach(() => vi.useRealTimers());

describe('shiftDisplayStatus', () => {
  it('a scheduled visit becomes overdue once its window passes', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 8, 20, 14, 49));
    expect(shiftDisplayStatus({ status: 'scheduled', date: '2026-09-20', startTime: '13:30', endTime: '13:45' })).toBe('overdue');
    expect(shiftDisplayStatus({ status: 'scheduled', date: '2026-09-20', startTime: '15:00', endTime: '15:15' })).toBe('scheduled');
  });
  it('a needs_replacement visit ages out the same way instead of offering a replacement forever', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 8, 20, 14, 49));
    expect(shiftDisplayStatus({ status: 'needs_replacement', date: '2026-09-20', startTime: '13:30', endTime: '13:45' })).toBe('overdue');
    expect(shiftDisplayStatus({ status: 'needs_replacement', date: '2026-09-20', startTime: '15:00', endTime: '15:15' })).toBe('needs_replacement');
  });
  it('completed and cancelled pass through untouched', () => {
    expect(shiftDisplayStatus({ status: 'completed', date: '2020-01-01' })).toBe('completed');
    expect(shiftDisplayStatus({ status: 'cancelled', date: '2099-01-01' })).toBe('cancelled');
  });
});
