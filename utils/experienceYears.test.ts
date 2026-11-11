import { describe, it, expect } from 'vitest';
import { experienceYears } from './experience';

describe('experienceYears — the stored bucket read as a number for filtering', () => {
  it.each([
    ['< 1 year', 0], ['Less than a year', 0], ['1-2 years', 1], ['3-5 years', 3], ['5-10 years', 5], ['10+ years', 10], ['5+ years', 5],
    [8, 8], ['8', 8], [0, 0], ['', 0], [undefined, 0], [null, 0], ['n/a', 0],
  ])('%s → %s', (input, years) => { expect(experienceYears(input)).toBe(years); });

  it('a "3-5 years" care provider does not pass a 5+ filter, but a "5-10 years" one does', () => {
    expect(experienceYears('3-5 years') < 5).toBe(true);
    expect(experienceYears('5-10 years') < 5).toBe(false);
    expect(experienceYears('10+ years') >= 10).toBe(true);
  });
});
