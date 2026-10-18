import { describe, it, expect } from 'vitest';
import {
  PRIMARY_SERVICES, CHILD_SERVICES, ALL_SERVICES, CARE_KINDS, RELATIONSHIPS, AGE_RANGES,
  normalizeCareKinds, serviceListsForKinds, kindsOfServices, providerCoversPost, providerMatchesHousehold,
  defaultJobTitle, ageRangeLabel,
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
