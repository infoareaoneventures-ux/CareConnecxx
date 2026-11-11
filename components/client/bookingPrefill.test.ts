import { describe, it, expect } from 'vitest';
import { addressForPost } from './bookingPrefill';

const gilroy = { street: '1 Main St', city: 'Gilroy', state: 'CA', zipCode: '95020' };
const santaClara = { street: '2 Elm St', city: 'Santa Clara', state: 'CA', zipCode: '95050' };

describe('addressForPost — which care location the booking form pre-selects', () => {
  it('the saved address whose ZIP matches the job post', () => {
    expect(addressForPost([santaClara, gilroy], { zipCode: '95020' }, 'x')).toBe('1 Main St, Gilroy, CA, 95020');
  });
  it('the only saved address when the ZIP does not match', () => {
    expect(addressForPost([gilroy], { zipCode: '99999' }, 'x')).toBe('1 Main St, Gilroy, CA, 95020');
  });
  it('two addresses and no match: the account address, else nothing (the family picks)', () => {
    expect(addressForPost([gilroy, santaClara], { zipCode: '99999' }, '3 Oak, San Jose, CA, 95130')).toBe('3 Oak, San Jose, CA, 95130');
    expect(addressForPost([gilroy, santaClara], undefined, '')).toBe('');
    expect(addressForPost([], undefined, '')).toBe('');
  });
  it('a street that is already a full address line is used as is', () => {
    expect(addressForPost([{ street: '9 Pine St, Morgan Hill, CA 95037', zipCode: '95037' }], { zipCode: '95037' }, '')).toBe('9 Pine St, Morgan Hill, CA 95037');
  });
});
