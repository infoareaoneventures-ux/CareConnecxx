import { describe, it, expect, vi, afterEach } from 'vitest';
import { shiftDisplayStatus } from './shiftUtils';

afterEach(() => vi.useRealTimers());

describe('shiftDisplayStatus', () => {
  it('a scheduled visit becomes overdue once its window passes', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-20T21:49:00Z')); // 2:49 PM Pacific (the visits carry no zone → Pacific)
    expect(shiftDisplayStatus({ status: 'scheduled', date: '2026-09-20', startTime: '13:30', endTime: '13:45' })).toBe('overdue');
    expect(shiftDisplayStatus({ status: 'scheduled', date: '2026-09-20', startTime: '15:00', endTime: '15:15' })).toBe('scheduled');
  });
  it('a needs_replacement visit ages out the same way instead of offering a replacement forever', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-20T21:49:00Z')); // 2:49 PM Pacific (the visits carry no zone → Pacific)
    expect(shiftDisplayStatus({ status: 'needs_replacement', date: '2026-09-20', startTime: '13:30', endTime: '13:45' })).toBe('overdue');
    expect(shiftDisplayStatus({ status: 'needs_replacement', date: '2026-09-20', startTime: '15:00', endTime: '15:15' })).toBe('needs_replacement');
  });
  it('completed and cancelled pass through untouched', () => {
    expect(shiftDisplayStatus({ status: 'completed', date: '2020-01-01' })).toBe('completed');
    expect(shiftDisplayStatus({ status: 'cancelled', date: '2099-01-01' })).toBe('cancelled');
  });
});

// 2026-11-09 (all U.S. zones): the status is judged AT THE CARE LOCATION, not in the viewer's browser zone.
describe('shiftDisplayStatus — care-location time', () => {
  afterEach(() => { vi.useRealTimers(); });
  const visit = (timeZone: string) => ({ status: 'scheduled', date: '2026-11-10', startTime: '09:00', endTime: '12:00', timeZone });

  it('the same real moment is "overdue" in Chicago but still upcoming in Los Angeles', () => {
    // 12:30 PM Chicago = 18:30 UTC = 10:30 AM Los Angeles
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-10T18:30:00Z'));
    expect(shiftDisplayStatus(visit('America/Chicago'))).toBe('overdue');
    expect(shiftDisplayStatus(visit('America/Los_Angeles'))).toBe('scheduled');
  });

  it('does not depend on the machine zone (run this file with TZ=Asia/Karachi too)', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-10T15:30:00Z')); // 9:30 AM Chicago, mid-visit
    expect(shiftDisplayStatus(visit('America/Chicago'))).toBe('scheduled');
    vi.setSystemTime(new Date('2026-11-10T18:01:00Z')); // 12:01 PM Chicago
    expect(shiftDisplayStatus(visit('America/Chicago'))).toBe('overdue');
  });

  it('a visit with no zone keeps reading as Pacific; one with only an address reads its ZIP', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-10T20:30:00Z')); // 12:30 PM Pacific, 3:30 PM Eastern
    expect(shiftDisplayStatus({ status: 'scheduled', date: '2026-11-10', startTime: '09:00', endTime: '12:00' })).toBe('overdue');
    expect(shiftDisplayStatus({ status: 'scheduled', date: '2026-11-10', startTime: '09:00', endTime: '16:00', address: '1 Main St, Boston, MA 02108' })).toBe('scheduled');
  });

  it('a visit that crosses midnight is not falsely overdue', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-11T04:30:00Z')); // 10:30 PM Chicago on the 10th
    expect(shiftDisplayStatus({ status: 'scheduled', date: '2026-11-10', startTime: '22:00', endTime: '01:00', timeZone: 'America/Chicago' })).toBe('scheduled');
  });
});
