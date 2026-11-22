import { describe, it, expect, afterEach } from 'vitest';
import { askConfirm, registerConfirmHost, defaultConfirmLabel } from './confirmDialog';

afterEach(() => registerConfirmHost(null));

describe('askConfirm', () => {
  it('resolves with the answer given by the host', async () => {
    registerConfirmHost((p) => p.resolve(true));
    expect(await askConfirm('Cancel this interview?')).toBe(true);
    registerConfirmHost((p) => p.resolve(false));
    expect(await askConfirm('Cancel this interview?')).toBe(false);
  });
  it('says no when no host is mounted', async () => {
    expect(await askConfirm('Cancel this interview?')).toBe(false);
  });
  it('picks a fitting button label and marks destructive questions', async () => {
    let seen: any;
    registerConfirmHost((p) => { seen = p; p.resolve(true); });
    await askConfirm('Cancel this shift?');
    expect(seen.confirmLabel).toBe('Yes, cancel');
    expect(seen.destructive).toBe(true);
    await askConfirm('Accept this interview? It is added to your calendar.');
    expect(seen.confirmLabel).toBe('Yes');
    expect(seen.destructive).toBe(false);
    expect(defaultConfirmLabel('Delete this invoice?').label).toBe('Delete');
  });
});
