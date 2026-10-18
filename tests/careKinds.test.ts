import { describe, it, expect } from 'vitest';
import {
  PRIMARY_SERVICES, CHILD_SERVICES, ALL_SERVICES, CARE_KINDS, RELATIONSHIPS, AGE_RANGES,
  normalizeCareKinds, serviceListsForKinds, kindsOfServices, providerCoversPost, providerMatchesHousehold,
  defaultJobTitle, ageRangeLabel,
  recipientCareKind, relationshipsForKinds, rosterCareKinds, careTypeChangeBlockedBy,
} from '../components/caregiver/signup/constants';

// Child care (2026-10-18): the one new fact — who the care is for — and the
// helpers every screen reads it through. A MISSING field means senior care
// everywhere, so nothing on file changes meaning.

describe('care kinds contract', () => {
  it('two kinds; the child eight by name, nothing underneath, no age in a name; Transportation shared', () => {
    expect([...CARE_KINDS]).toEqual(['senior', 'child']);
    expect([...CHILD_SERVICES]).toEqual([
      'Supervision', 'Baby Care', 'Bathing & Dressing', 'Meals & Snacks',
      'Activities & Play', 'School & Homework', 'Transportation', 'Tidying & Laundry',
    ]);
    expect(CHILD_SERVICES).toHaveLength(8);
    expect(PRIMARY_SERVICES).toHaveLength(8);
    // The only label both lists share — ticked once, counted for both, same driving-record rule.
    expect(CHILD_SERVICES.filter((s) => (PRIMARY_SERVICES as readonly string[]).includes(s))).toEqual(['Transportation']);
    expect(ALL_SERVICES).toHaveLength(15);
  });

  it('five relationships; five age ranges with labels', () => {
    expect([...RELATIONSHIPS]).toEqual(['Myself', 'Parent', 'Spouse or Partner', 'Child', 'Other']);
    expect(AGE_RANGES.map((a) => a.label)).toEqual(['Infant', 'Toddler', 'Ages 3–5', 'Ages 6–12', 'Teen']);
    expect(ageRangeLabel('3-5')).toBe('Ages 3–5');
    expect(ageRangeLabel('unknown')).toBe('unknown');
  });

  it('a missing, empty or junk careKinds means senior care', () => {
    expect(normalizeCareKinds(undefined)).toEqual(['senior']);
    expect(normalizeCareKinds([])).toEqual(['senior']);
    expect(normalizeCareKinds(['dog'])).toEqual(['senior']);
    expect(normalizeCareKinds(['child'])).toEqual(['child']);
    expect(normalizeCareKinds(['child', 'senior'])).toEqual(['senior', 'child']);
  });

  it('a senior-only answer shows exactly the senior list; child the child list; both shows both, senior first', () => {
    expect(serviceListsForKinds(undefined).map((l) => l.kind)).toEqual(['senior']);
    expect(serviceListsForKinds(['senior'])[0].services).toEqual(PRIMARY_SERVICES);
    expect(serviceListsForKinds(['child'])[0].services).toEqual(CHILD_SERVICES);
    expect(serviceListsForKinds(['child', 'senior']).map((l) => l.kind)).toEqual(['senior', 'child']);
  });

  it("a post's kinds come from its ticked services; Transportation alone defers to the household's answer", () => {
    expect(kindsOfServices(['Companionship'])).toEqual(['senior']);
    expect(kindsOfServices(['Supervision', 'Transportation'])).toEqual(['child']);
    expect(kindsOfServices(['Companionship', 'Baby Care'])).toEqual(['senior', 'child']);
    expect(kindsOfServices(['Transportation'])).toEqual(['senior']);
    expect(kindsOfServices(['Transportation'], ['child'])).toEqual(['child']);
    expect(kindsOfServices([])).toEqual(['senior']);
  });

  it('a care provider sees a post only when they offer every kind it needs', () => {
    expect(providerCoversPost(undefined, undefined)).toBe(true);        // legacy both sides = senior
    expect(providerCoversPost(['senior'], ['child'])).toBe(false);
    expect(providerCoversPost(['child'], ['senior'])).toBe(false);
    expect(providerCoversPost(['senior', 'child'], ['child'])).toBe(true);
    expect(providerCoversPost(['child'], ['senior', 'child'])).toBe(false);
  });

  it('a family sees a care provider who offers any kind the household needs', () => {
    expect(providerMatchesHousehold(undefined, undefined)).toBe(true);
    expect(providerMatchesHousehold(['child'], ['senior'])).toBe(false);
    expect(providerMatchesHousehold(['child'], ['senior', 'child'])).toBe(true);
    expect(providerMatchesHousehold(['senior', 'child'], ['child'])).toBe(true);
  });

  it('the default title keeps its pattern and swaps one word by kind', () => {
    expect(defaultJobTitle('San Jose')).toBe('Senior care in San Jose');
    expect(defaultJobTitle('San Jose', ['child'])).toBe('Child care in San Jose');
    expect(defaultJobTitle('San Jose', ['senior', 'child'])).toBe('Senior and child care in San Jose');
    expect(defaultJobTitle(null, ['child'])).toBe('Child care needed');
  });
});

// The follow-up (founder, 2026-10-18 evening): the household picks its care type ONCE
// (signup / Account Settings) and the RELATIONSHIP decides each recipient's list —
// no per-step control anywhere else.
describe('who decides a recipient\'s kind', () => {
  it('Child → child; Myself / Parent / Spouse or Partner and the older stored values → senior; Other → its stored careKind', () => {
    expect(recipientCareKind('Child')).toBe('child');
    expect(recipientCareKind('child')).toBe('child');          // the first-login wizard stores lowercase values
    expect(recipientCareKind('Parent')).toBe('senior');
    expect(recipientCareKind('Myself')).toBe('senior');
    expect(recipientCareKind('Spouse or Partner')).toBe('senior');
    expect(recipientCareKind('Grandparent')).toBe('senior');  // older stored value
    expect(recipientCareKind('Other')).toBe('senior');
    expect(recipientCareKind('Other', 'child')).toBe('child');
    expect(recipientCareKind('Parent', 'child')).toBe('senior'); // careKind only counts for Other
    expect(recipientCareKind(undefined)).toBe('senior');
  });

  it('the relationships a household can offer follow its care type; Other always', () => {
    expect(relationshipsForKinds(['senior'])).toEqual(['Myself', 'Parent', 'Spouse or Partner', 'Other']);
    expect(relationshipsForKinds(['child'])).toEqual(['Child', 'Other']);
    expect(relationshipsForKinds(['senior', 'child'])).toEqual(['Myself', 'Parent', 'Spouse or Partner', 'Child', 'Other']);
    expect(relationshipsForKinds(undefined)).toEqual(['Myself', 'Parent', 'Spouse or Partner', 'Other']); // missing = senior
    expect(relationshipsForKinds(['senior', 'child'], { includeMyself: false })).toEqual(['Parent', 'Spouse or Partner', 'Child', 'Other']);
  });

  it('a roster implies its kinds: a child on file → child, anyone else → senior', () => {
    expect(rosterCareKinds([])).toEqual([]);
    expect(rosterCareKinds([{ relationship: 'Parent' }])).toEqual(['senior']);
    expect(rosterCareKinds([{ relationship: 'Child' }])).toEqual(['child']);
    expect(rosterCareKinds([{ relationship: 'Myself' }, { relationship: 'Parent' }, { relationship: 'Child' }])).toEqual(['senior', 'child']);
    expect(rosterCareKinds([{ relationship: 'Other', careKind: 'child' }])).toEqual(['child']);
  });

  it('the roster rule: a care-type change that leaves someone uncovered names the first such person', () => {
    const roster = [{ name: 'Basra Yousuf', relationship: 'Myself' }, { name: 'H M', relationship: 'Parent' }, { name: 'S Mahad', relationship: 'Child' }];
    expect(careTypeChangeBlockedBy(['senior', 'child'], roster)).toBeNull();
    expect(careTypeChangeBlockedBy(['child'], roster)?.name).toBe('Basra Yousuf');
    expect(careTypeChangeBlockedBy(['senior'], roster)?.name).toBe('S Mahad');
    expect(careTypeChangeBlockedBy(['child'], [{ name: 'S Mahad', relationship: 'Child' }])).toBeNull();
    expect(careTypeChangeBlockedBy(['senior'], [])).toBeNull();
  });
});
