import { describe, it, expect } from 'vitest';
import { addressWithoutStreet } from './addressPrivacy';

describe('addressWithoutStreet', () => {
  it('drops the street, keeps city, state and ZIP', () => {
    expect(addressWithoutStreet('100 Test Lane, Gilroy, CA, 95020')).toBe('Gilroy, CA, 95020');
    expect(addressWithoutStreet('7500 Monterey St, Gilroy, CA 95020')).toBe('Gilroy, CA 95020');
  });
  it('leaves an address that has no street part alone', () => {
    expect(addressWithoutStreet('Gilroy, CA 95020')).toBe('Gilroy, CA 95020');
    expect(addressWithoutStreet('Gilroy')).toBe('Gilroy');
    expect(addressWithoutStreet('')).toBe('');
    expect(addressWithoutStreet(undefined)).toBe('');
  });
});
