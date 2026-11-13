import { describe, it, expect } from 'vitest';
import { zoneFromZip, zipFromAddress, careZoneOf, wallToInstantMs, instantToWall, zoneAbbr, zoneSuffix, tomorrowRangeAcrossZones, dayBeforeReminderDue, formatTimeInZone, formatDateInZone, isValidZone, DEFAULT_CARE_TZ } from './careTime';

describe('zoneFromZip — every U.S. zone', () => {
  it.each([
    ['95130', 'America/Los_Angeles'], ['94110', 'America/Los_Angeles'], ['98101', 'America/Los_Angeles'], ['97201', 'America/Los_Angeles'], ['89101', 'America/Los_Angeles'],
    ['10001', 'America/New_York'], ['02108', 'America/New_York'], ['30301', 'America/New_York'], ['33101', 'America/New_York'], ['20001', 'America/New_York'], ['48201', 'America/New_York'],
    ['60601', 'America/Chicago'], ['77001', 'America/Chicago'], ['75201', 'America/Chicago'], ['55401', 'America/Chicago'], ['63101', 'America/Chicago'], ['70112', 'America/Chicago'],
    ['80202', 'America/Denver'], ['84101', 'America/Denver'], ['87101', 'America/Denver'], ['59601', 'America/Denver'], ['82001', 'America/Denver'],
    ['85001', 'America/Phoenix'], ['85701', 'America/Phoenix'],
    ['99501', 'America/Anchorage'], ['96801', 'Pacific/Honolulu'],
  ])('%s → %s', (zip, tz) => { expect(zoneFromZip(zip)).toBe(tz); });

  it('handles the split states', () => {
    expect(zoneFromZip('79901')).toBe('America/Denver');   // El Paso TX
    expect(zoneFromZip('88001')).toBe('America/Denver');   // Las Cruces NM
    expect(zoneFromZip('32501')).toBe('America/Chicago');  // Pensacola FL
    expect(zoneFromZip('32301')).toBe('America/New_York'); // Tallahassee FL
    expect(zoneFromZip('37201')).toBe('America/Chicago');  // Nashville TN
    expect(zoneFromZip('37902')).toBe('America/New_York'); // Knoxville TN
    expect(zoneFromZip('46201')).toBe('America/New_York'); // Indianapolis IN
    expect(zoneFromZip('46320')).toBe('America/Chicago');  // Hammond IN
    expect(zoneFromZip('42001')).toBe('America/Chicago');  // Paducah KY
    expect(zoneFromZip('83702')).toBe('America/Denver');   // Boise ID
    expect(zoneFromZip('83814')).toBe('America/Los_Angeles'); // Coeur d'Alene ID
    expect(zoneFromZip('57701')).toBe('America/Denver');   // Rapid City SD
  });

  it('ZIP+4, numbers and junk', () => {
    expect(zoneFromZip('60601-1234')).toBe('America/Chicago');
    expect(zoneFromZip(60601)).toBe('America/Chicago');
    expect(zoneFromZip('')).toBeNull();
    expect(zoneFromZip('abc')).toBeNull();
    expect(zoneFromZip(undefined)).toBeNull();
  });
});

describe('careZoneOf', () => {
  it('own stamped zone first, then the ZIP, then Pacific', () => {
    expect(careZoneOf({ timeZone: 'America/Chicago', zipCode: '95130' })).toBe('America/Chicago');
    expect(careZoneOf({ zipCode: '10001' })).toBe('America/New_York');
    expect(careZoneOf({})).toBe(DEFAULT_CARE_TZ);
    expect(careZoneOf({ timeZone: 'Not/AZone', zipCode: '60601' })).toBe('America/Chicago');
    expect(careZoneOf(null)).toBe(DEFAULT_CARE_TZ);
  });
});

describe('zipFromAddress / careZoneOf with an address line', () => {
  it('takes the last 5-digit ZIP, ignoring street numbers', () => {
    expect(zipFromAddress('12345 Main St, Chicago, IL 60601')).toBe('60601');
    expect(zipFromAddress('1 Rodeo Dr, Beverly Hills, CA 90210-1234')).toBe('90210');
    expect(zipFromAddress('no zip here')).toBeNull();
    expect(zipFromAddress(undefined)).toBeNull();
  });
  it('a visit with only an address line gets its zone from the ZIP', () => {
    expect(careZoneOf({ address: '100 Main St, Austin, TX 78701' })).toBe('America/Chicago');
    expect(careZoneOf({ address: '100 Main St, Boston, MA 02108' })).toBe('America/New_York');
    expect(careZoneOf({ address: '100 Main St' })).toBe(DEFAULT_CARE_TZ);
  });
});

describe('wallToInstantMs / instantToWall', () => {
  it('the same wall clock is a different instant in each zone', () => {
    const eastern = wallToInstantMs('2026-11-10', '09:00', 'America/New_York');
    const pacific = wallToInstantMs('2026-11-10', '09:00', 'America/Los_Angeles');
    expect(pacific - eastern).toBe(3 * 3600_000);
    expect(new Date(eastern).toISOString()).toBe('2026-11-10T14:00:00.000Z');
  });
  it('Arizona has no daylight saving; Chicago does', () => {
    expect(new Date(wallToInstantMs('2026-07-01', '09:00', 'America/Phoenix')).toISOString()).toBe('2026-07-01T16:00:00.000Z');
    expect(new Date(wallToInstantMs('2026-12-01', '09:00', 'America/Phoenix')).toISOString()).toBe('2026-12-01T16:00:00.000Z');
    expect(new Date(wallToInstantMs('2026-07-01', '09:00', 'America/Chicago')).toISOString()).toBe('2026-07-01T14:00:00.000Z');
    expect(new Date(wallToInstantMs('2026-12-01', '09:00', 'America/Chicago')).toISOString()).toBe('2026-12-01T15:00:00.000Z');
  });
  it('Hawaii and Alaska', () => {
    expect(new Date(wallToInstantMs('2026-11-10', '09:00', 'Pacific/Honolulu')).toISOString()).toBe('2026-11-10T19:00:00.000Z');
    expect(new Date(wallToInstantMs('2026-11-10', '09:00', 'America/Anchorage')).toISOString()).toBe('2026-11-10T18:00:00.000Z');
  });
  it('daylight-saving boundaries (US 2026: Mar 8 spring forward, Nov 1 fall back)', () => {
    // Sunday Mar 8 2026: 2:30 AM does not exist in New York; the day is 23 hours long.
    const before = wallToInstantMs('2026-03-08', '01:30', 'America/New_York');
    const after = wallToInstantMs('2026-03-08', '03:30', 'America/New_York');
    expect(after - before).toBe(3600_000);
    // Sunday Nov 1 2026: 1:30 AM happens twice; first occurrence is the daylight one (UTC-4).
    expect(new Date(wallToInstantMs('2026-11-01', '01:30', 'America/New_York')).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    // The day before and after keep their normal offsets.
    expect(new Date(wallToInstantMs('2026-10-31', '12:00', 'America/New_York')).toISOString()).toBe('2026-10-31T16:00:00.000Z');
    expect(new Date(wallToInstantMs('2026-11-02', '12:00', 'America/New_York')).toISOString()).toBe('2026-11-02T17:00:00.000Z');
  });
  it('a visit that crosses midnight ends on the next date', () => {
    const start = wallToInstantMs('2026-11-10', '22:00', 'America/Chicago');
    const end = wallToInstantMs('2026-11-10', '23:59', 'America/Chicago') + 60_000;
    expect(instantToWall(end, 'America/Chicago')).toEqual({ date: '2026-11-11', time: '00:00' });
    expect(end - start).toBe(2 * 3600_000);
  });
  it('round trips', () => {
    for (const tz of ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu']) {
      expect(instantToWall(wallToInstantMs('2026-11-10', '14:30', tz), tz)).toEqual({ date: '2026-11-10', time: '14:30' });
    }
  });
  it('bad input is NaN, never a guess', () => {
    expect(wallToInstantMs('', '09:00')).toBeNaN();
    expect(wallToInstantMs('2026-11-10', '')).toBeNaN();
    expect(wallToInstantMs(undefined, undefined)).toBeNaN();
  });
});

describe('display', () => {
  const t = Date.UTC(2026, 10, 10, 15, 0); // 15:00 UTC
  it('zone short names', () => {
    expect(zoneAbbr('America/Los_Angeles', t)).toBe('PT');
    expect(zoneAbbr('America/Chicago', t)).toBe('CT');
    expect(zoneAbbr('America/New_York', t)).toBe('ET');
    expect(zoneAbbr('America/Denver', t)).toBe('MT');
    expect(zoneAbbr('America/Phoenix', t)).toBe('MST');
    expect(zoneAbbr('America/Anchorage', t)).toBe('AKT');
    expect(zoneAbbr('Pacific/Honolulu', t)).toBe('HT');
  });
  it('a time and a date shown in the care location zone', () => {
    expect(formatTimeInZone(t, 'America/Chicago')).toBe('9:00 AM CT');
    expect(formatTimeInZone(t, 'America/New_York')).toBe('10:00 AM ET');
    expect(formatTimeInZone(t, 'America/Chicago', { withZone: false })).toBe('9:00 AM');
    expect(formatDateInZone(t, 'America/Chicago')).toBe('Tue, Nov 10');
  });
  it('validates zones', () => {
    expect(isValidZone('America/Chicago')).toBe(true);
    expect(isValidZone('Nope/Nope')).toBe(false);
  });
});

describe('zoneSuffix', () => {
  it('names the zone outside Pacific and stays silent for Pacific', () => {
    expect(zoneSuffix({ timeZone: 'America/Chicago' }, Date.UTC(2026, 10, 10, 15))).toBe(' CT');
    expect(zoneSuffix({ address: '1 Main St, Boston, MA 02108' }, Date.UTC(2026, 10, 10, 15))).toBe(' ET');
    expect(zoneSuffix({ address: '4746 Campbell Ave, San Jose, CA 95130' })).toBe('');
    expect(zoneSuffix({})).toBe('');
  });
});

describe('day-before reminders across zones', () => {
  // 2026-11-10 23:00 UTC = 3 PM Pacific, 5 PM Central, 6 PM Eastern
  const now = new Date(Date.UTC(2026, 10, 10, 23, 0));
  it('due once the visit\'s own clock reaches the hour on the day before', () => {
    expect(dayBeforeReminderDue({ date: '2026-11-11', timeZone: 'America/New_York' }, 18, now)).toBe(true);   // 6 PM ET on the 10th
    expect(dayBeforeReminderDue({ date: '2026-11-11', timeZone: 'America/Chicago' }, 18, now)).toBe(false);   // only 5 PM CT
    expect(dayBeforeReminderDue({ date: '2026-11-11', timeZone: 'America/Los_Angeles' }, 19, now)).toBe(false);
    expect(dayBeforeReminderDue({ date: '2026-11-12' }, 0, now)).toBe(false);  // two days out
    expect(dayBeforeReminderDue({ date: '2026-11-10', timeZone: 'America/New_York' }, 0, now)).toBe(false); // today, not tomorrow
  });
  it('a missed run still sends later the same evening', () => {
    const later = new Date(Date.UTC(2026, 10, 11, 3, 0)); // 7 PM Pacific on the 10th
    expect(dayBeforeReminderDue({ date: '2026-11-11' }, 19, later)).toBe(true);
  });
  it('the query range covers tomorrow in every zone', () => {
    expect(tomorrowRangeAcrossZones(new Date(Date.UTC(2026, 10, 10, 23, 0)))).toEqual({ from: '2026-11-11', to: '2026-11-11' });
    // 05:30 UTC on the 11th: Eastern is 12:30 AM on the 11th while Hawaii is still 7:30 PM on the 10th → two dates.
    expect(tomorrowRangeAcrossZones(new Date(Date.UTC(2026, 10, 11, 5, 30)))).toEqual({ from: '2026-11-11', to: '2026-11-12' });
  });
});
