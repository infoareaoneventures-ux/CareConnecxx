import { describe, it, expect } from 'vitest';
import { isPastJob, jobRateText, JOB_PAYMENT_TEXT } from './jobDisplay';

describe('isPastJob', () => {
  const today = '2026-11-10';
  it('a real date before today is past; today and later are not', () => {
    expect(isPastJob({ date: '2026-09-02' }, today)).toBe(true);
    expect(isPastJob({ startDate: '2026-08-15' }, today)).toBe(true);
    expect(isPastJob({ date: '2026-11-10' }, today)).toBe(false);
    expect(isPastJob({ startDate: '2026-12-01' }, today)).toBe(false);
  });
  it('ASAP / Today / missing dates are kept', () => {
    expect(isPastJob({ date: 'ASAP' }, today)).toBe(false);
    expect(isPastJob({ date: 'Today' }, today)).toBe(false);
    expect(isPastJob({}, today)).toBe(false);
  });
  it('an ongoing job started earlier is still open; a dated one is over after its end date', () => {
    expect(isPastJob({ startDate: '2026-09-01', ongoing: true }, today)).toBe(false);
    expect(isPastJob({ startDate: '2026-09-01', endDate: '2026-12-01' }, today)).toBe(false);
    expect(isPastJob({ startDate: '2026-09-01', endDate: '2026-10-01' }, today)).toBe(true);
  });
});

describe('job text', () => {
  it('rate always has the $ and /hr; flexible and unpriced read "Flexible"', () => {
    expect(jobRateText({ rate: 26 })).toBe('$26/hr');
    expect(jobRateText({ rate: 0, rateFlexible: true })).toBe('Flexible');
    expect(jobRateText(null)).toBe('Flexible');
  });
  it('payment is one plain label, never "via cash"', () => {
    expect(JOB_PAYMENT_TEXT).toBe('Paid by card through Evia');
  });
});
