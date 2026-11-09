import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { containsContactDetails, CONTACT_DETAILS_MESSAGE } from '../contactDetails';

const BLOCKED = [
  'Call me at 408-555-1212',
  'text 4085551212 anytime',
  'My number is (408) 555 1212',
  '+1 408 555 1212 is best',
  '1.408.555.1212',
  'reach me on 555-1234',
  'four zero eight five five five one two one two',
  'email me: maria.lopez@gmail.com',
  'maria at gmail dot com',
  'maria (at) gmail (dot) com',
  'find me at www.mariacare.com',
  'https://facebook.com/maria.lopez',
  'mariacare.com has my details',
  'DM me @maria_cares',
  'message me on WhatsApp',
  'I can be paid through Venmo',
  'cash app is fine',
];
const ALLOWED = [
  'She has dementia and gets confused in the evening',
  'I have 12 years of experience and speak Spanish and English',
  'Pay is $25/hr, 3 days a week, mornings',
  'She lives near the library on a quiet street',
  'Likes tea at 3 and a walk after lunch',
  'Available Mondays and Wednesdays from 9 to 5',
  'Rates between $150-$2000 a month',
  'Born in 1946; needs help with 2 to 3 meals a day',
  'I love gardening, reading and cooking with my family',
  '',
];

describe('containsContactDetails (server copy)', () => {
  it.each(BLOCKED)('blocks: %s', (t) => { expect(containsContactDetails(t)).toBe(true); });
  it.each(ALLOWED)('allows: %s', (t) => { expect(containsContactDetails(t)).toBe(false); });
  it('non-strings never block', () => { expect(containsContactDetails(undefined)).toBe(false); expect(containsContactDetails(42)).toBe(false); });
  it('one plain line', () => { expect(CONTACT_DETAILS_MESSAGE).toMatch(/phone numbers, emails and links/i); });
});

describe('the site copy is the same rule (byte parity)', () => {
  it('the two files are identical', () => {
    const site = fs.readFileSync(path.resolve(__dirname, '../../../../utils/contactDetails.ts'), 'utf8');
    const server = fs.readFileSync(path.resolve(__dirname, '../contactDetails.ts'), 'utf8');
    expect(server).toBe(site);
  });
});
