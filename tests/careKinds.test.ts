import { describe, it, expect } from 'vitest';
import {
  PRIMARY_SERVICES, CHILD_SERVICES, ALL_SERVICES, CARE_KINDS, RELATIONSHIPS, AGE_RANGES,
  normalizeCareKinds, serviceListsForKinds, kindsOfServices, kindsOfPost, kindsOfProvider,
  defaultJobTitle, ageRangeLabel, STAGE_HEADING,
  recipientCareKind, rosterCareKinds,
  recipientStage, childrenMissingStage, stagesOfRecipients,
  OTHER_KIND_QUESTION, OTHER_KIND_OPTIONS,
} from '../components/caregiver/signup/constants';

// Child care (2026-10-18) un-framed (founder, 2026-10-19): no care-type question
// on either door. A family is recipient-driven (the relationship decides the
// list), a care provider services-driven (both lists, tick anything), and
// nothing hides anyone by kind. A MISSING stored field still reads as senior
// care (titles, badges), so nothing on file changes meaning.

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

  it('six relationships; five stages with stage words (ids unchanged), under the one heading', () => {
    expect([...RELATIONSHIPS]).toEqual(['Myself', 'Parent', 'Spouse or Partner', 'Adult child', 'Child', 'Other']);
    expect(AGE_RANGES.map((a) => a.id)).toEqual(['infant', 'toddler', '3-5', '6-12', 'teen']);
    expect(AGE_RANGES.map((a) => a.label)).toEqual(['Infant', 'Toddler', 'Preschooler', 'School-age', 'Teen']);
    expect(ageRangeLabel('3-5')).toBe('Preschooler');
    expect(ageRangeLabel('unknown')).toBe('unknown');
    expect(STAGE_HEADING).toBe('Stage');
    // No age number anywhere in a label (standing rule).
    AGE_RANGES.forEach((a) => expect(a.label).not.toMatch(/\d/));
  });

  it('no care-type question anywhere; Other asks adult or child', () => {
    expect(OTHER_KIND_QUESTION).toBe('Is this person an adult or a child?');
    expect(OTHER_KIND_OPTIONS.map((o) => `${o.value}:${o.label}`)).toEqual(['senior:Adult', 'child:Child']);
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

  it("nothing hides by kind — the view filter reads a post's kinds from its ticked services (stored kinds as the fallback) and a provider's from theirs (Transportation alone, or nothing yet = both)", () => {
    expect(kindsOfPost({ careTypes: ['Supervision'], careKinds: ['senior'] })).toEqual(['child']);
    expect(kindsOfPost({ careTypes: ['Companionship', 'Baby Care'] })).toEqual(['senior', 'child']);
    expect(kindsOfPost({ careTypes: ['Transportation'], careKinds: ['child'] })).toEqual(['child']);
    expect(kindsOfPost({ careKinds: ['child'] })).toEqual(['child']);
    expect(kindsOfPost(undefined)).toEqual(['senior']); // a legacy post reads as senior care
    expect(kindsOfProvider({ services: ['Companionship', 'Baby Care'] })).toEqual(['senior', 'child']);
    expect(kindsOfProvider({ skills: ['Supervision'] })).toEqual(['child']);
    expect(kindsOfProvider({ services: ['Companionship'], skills: ['Supervision'] })).toEqual(['senior']); // services first, skills as the fallback
    expect(kindsOfProvider({ services: ['Transportation'] })).toEqual(['senior', 'child']);
    expect(kindsOfProvider({})).toEqual(['senior', 'child']);
  });

  it('the default title keeps its pattern and swaps one word by kind', () => {
    expect(defaultJobTitle('San Jose')).toBe('Senior care in San Jose');
    expect(defaultJobTitle('San Jose', ['child'])).toBe('Child care in San Jose');
    expect(defaultJobTitle('San Jose', ['senior', 'child'])).toBe('Senior and child care in San Jose');
    expect(defaultJobTitle(null, ['child'])).toBe('Child care needed');
  });
});

// The RELATIONSHIP decides each recipient's list — no household care-type setting,
// no per-step control anywhere (founder, 2026-10-19).
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
    // A grown son or daughter is on the senior side; only a minor Child is on the child side.
    expect(recipientCareKind('Adult child')).toBe('senior');
    expect(recipientCareKind('adult child')).toBe('senior');
  });

  it('a roster implies its kinds: a child on file → child, anyone else → senior', () => {
    expect(rosterCareKinds([])).toEqual([]);
    expect(rosterCareKinds([{ relationship: 'Parent' }])).toEqual(['senior']);
    expect(rosterCareKinds([{ relationship: 'Child' }])).toEqual(['child']);
    expect(rosterCareKinds([{ relationship: 'Myself' }, { relationship: 'Parent' }, { relationship: 'Child' }])).toEqual(['senior', 'child']);
    expect(rosterCareKinds([{ relationship: 'Other', careKind: 'child' }])).toEqual(['child']);
  });

  // One stage per child, set ON THE CHILD (founder, 2026-10-18 late).
  it('a recipient\'s stage: the single field first, an older list\'s first element as the fallback', () => {
    expect(recipientStage(undefined)).toBeUndefined();
    expect(recipientStage({})).toBeUndefined();
    expect(recipientStage({ ageRange: 'toddler' })).toBe('toddler');
    expect(recipientStage({ ageRanges: ['6-12', 'teen'] })).toBe('6-12');
    expect(recipientStage({ ageRange: 'infant', ageRanges: ['teen'] })).toBe('infant');
    expect(recipientStage({ ageRange: '', ageRanges: [] })).toBeUndefined();
  });

  it('Step 3 asks a stage only for a picked child who has none; seniors never (no household gate)', () => {
    const roster = [
      { firstName: 'H', relationship: 'Parent' },
      { firstName: 'S', relationship: 'Child' },
      { firstName: 'A', relationship: 'Child', ageRange: 'toddler' },
      { firstName: 'O', relationship: 'Other', careKind: 'child' },
      { firstName: 'G', relationship: 'Adult child' },
    ];
    expect(childrenMissingStage(roster).map((r) => r.firstName)).toEqual(['S', 'O']);
    expect(childrenMissingStage([{ relationship: 'Parent' }, { relationship: 'Adult child' }])).toEqual([]);
    // An older list counts as a stage.
    expect(childrenMissingStage([{ relationship: 'Child', ageRanges: ['teen'] }])).toEqual([]);
  });

  it('a post\'s ageRanges = the picked children\'s stages, deduped, in stage order', () => {
    const roster = [
      { relationship: 'Parent', ageRange: 'teen' }, // a senior's stray value never counts
      { relationship: 'Child', ageRange: 'teen' },
      { relationship: 'Child', ageRange: 'infant' },
      { relationship: 'Other', careKind: 'child', ageRange: 'teen' },
      { relationship: 'Child' },
    ];
    expect(stagesOfRecipients(roster)).toEqual(['infant', 'teen']);
    expect(stagesOfRecipients([{ relationship: 'Parent', ageRange: 'teen' }])).toEqual([]);
    expect(stagesOfRecipients([])).toEqual([]);
  });
});
