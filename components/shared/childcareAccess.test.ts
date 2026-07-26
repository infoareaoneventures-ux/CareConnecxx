import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const handlers = new Map<string, () => Promise<unknown>>();
  const calls: string[] = [];
  return { handlers, calls };
});

vi.mock('../../lib/firebase', () => ({
  functions: {},
}));

vi.mock('../../lib/childcareCallable', () => ({
  childcareCallable: (name: string) => async () => {
    hoisted.calls.push(name);
    const handler = hoisted.handlers.get(name);
    if (!handler) throw new Error(`no handler for ${name}`);
    return { data: await handler() };
  },
}));

import {
  fetchCaregiverChildcareAccess,
  fetchFamilyChildcareAccess,
  resetChildcareAccessCache,
} from './childcareAccess';

beforeEach(() => {
  hoisted.handlers.clear();
  hoisted.calls.length = 0;
  resetChildcareAccessCache();
});

describe('UID-bound childcare access cache', () => {
  it('never reuses family data across principals', async () => {
    let activeUid = 'account-a';
    hoisted.handlers.set('getMyHouseholdState', async () => ({
      households: [{ householdId: `household-${activeUid}`, isPrimary: true }],
      authorities: [],
    }));
    hoisted.handlers.set('listMyChildren', async () => ({
      children: [{ childId: `child-${activeUid}`, displayLabel: activeUid }],
    }));

    const accountA = await fetchFamilyChildcareAccess('account-a');
    activeUid = 'account-b';
    const accountB = await fetchFamilyChildcareAccess('account-b');

    expect(accountA.children[0]?.childId).toBe('child-account-a');
    expect(accountB.children[0]?.childId).toBe('child-account-b');
    expect(hoisted.calls.filter((name) => name === 'listMyChildren')).toHaveLength(2);
  });

  it('separates family and caregiver roles for the same UID', async () => {
    hoisted.handlers.set('getMyHouseholdState', async () => ({ households: [], authorities: [] }));
    hoisted.handlers.set('listMyChildren', async () => ({ children: [] }));
    hoisted.handlers.set('getMyChildcareProviderState', async () => ({ eligibility: { eligible: true } }));

    const [family, caregiver] = await Promise.all([
      fetchFamilyChildcareAccess('same-account'),
      fetchCaregiverChildcareAccess('same-account'),
    ]);

    expect(family.status).toBe('available');
    expect(caregiver.status).toBe('available');
    expect(caregiver.provider).toMatchObject({ eligibility: { eligible: true } });
  });

  it('evicts an unavailable result so a retry can recover', async () => {
    let attempts = 0;
    hoisted.handlers.set('getMyHouseholdState', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary');
      return { households: [], authorities: [] };
    });
    hoisted.handlers.set('listMyChildren', async () => ({ children: [] }));

    expect((await fetchFamilyChildcareAccess('retry-user')).status).toBe('unavailable');
    expect((await fetchFamilyChildcareAccess('retry-user')).status).toBe('available');
  });

  it('token-transition reset invalidates settled entries', async () => {
    let version = 1;
    hoisted.handlers.set('getMyChildcareProviderState', async () => ({ version }));

    expect((await fetchCaregiverChildcareAccess('caregiver')).provider).toMatchObject({ version: 1 });
    version = 2;
    resetChildcareAccessCache();
    expect((await fetchCaregiverChildcareAccess('caregiver')).provider).toMatchObject({ version: 2 });
  });
});
