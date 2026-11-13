import { describe, it, expect } from 'vitest';
import { addressKey, replaceAddressIn } from './addressReplace';

const next = { street: '9 New Rd', city: 'Gilroy', state: 'CA', zipCode: '95020' };

describe('replaceAddressIn', () => {
  it('rewrites only the entries that hold the original address', () => {
    const list = [
      { street: '100 Test Lane', city: 'Santa Clara', state: 'CA', zipCode: '95050', label: 'home' },
      { street: '5 Other St', city: 'Gilroy', state: 'CA', zipCode: '95020' },
    ];
    const r = replaceAddressIn(list, { street: '100 test lane ', zipCode: '95050' }, next);
    expect(r.changed).toBe(true);
    expect(r.list[0]).toMatchObject({ ...next, label: 'home' });
    expect(r.list[1]).toBe(list[1]);
  });

  it('reports no change when the address is not in the list (so nothing is written)', () => {
    const r = replaceAddressIn([{ street: '5 Other St', zipCode: '95020' }], { street: 'x', zipCode: '1' }, next);
    expect(r.changed).toBe(false);
  });

  it('a moved address drops its saved point; a same-address edit keeps it', () => {
    const withPoint = [{ street: '100 Test Lane', zipCode: '95050', lat: 1, lng: 2, geoPrecision: 'rooftop' }];
    const moved = replaceAddressIn(withPoint, { street: '100 Test Lane', zipCode: '95050' }, next);
    expect(moved.list[0]).not.toHaveProperty('lat');
    const same = replaceAddressIn(withPoint, { street: '100 Test Lane', zipCode: '95050' }, { street: '100 Test Lane', city: 'Santa Clara', state: 'CA', zipCode: '95050' });
    expect(same.list[0]).toMatchObject({ lat: 1, lng: 2, geoPrecision: 'rooftop' });
  });

  it('handles a missing list and matches the location step key', () => {
    expect(replaceAddressIn(undefined, { street: 'a', zipCode: '1' }, next)).toEqual({ list: [], changed: false });
    expect(addressKey(' 100 Test Lane ', '95050')).toBe('100 test lane|95050');
  });
});
